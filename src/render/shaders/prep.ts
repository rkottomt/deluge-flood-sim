/**
 * Per-frame GPU preprocessing of the solver textures into render-friendly derived textures:
 *
 *  cells  (nx×ny)  → surfTex rgba16float: h, u, v, foam source          (filterable)
 *                    normTex rgba16float: ∂bed/∂x, ∂bed/∂z, ∂η/∂x, ∂η/∂z (filterable, wet-only η differences)
 *                    miscTex rgba16float: barrier, max depth, speed, collected whitewater (filterable)
 *                    cellTex rg32float:   displayed depth d, water surface bed + d (full precision, for verts)
 *  vtxBed (vx×vy)  → vtxBedTex r32float: vertex bed (mean ground of its 4 cells + max barrier); only rebuilt when
 *                    the terrain changes (walls, digging), not every frame
 *  verts  (vx×vy)  → vtxTex  rgba32float: bed, water surface, mean depth, wet flag (any of its 4 cells wet), from
 *                    cellTex + vtxBedTex: 4–16 texel loads per vertex instead of 12–36
 *  wet    pyramid  → wetTex  r32float mips: per base quad "water may be visible here", max-downsampled
 *
 * The vertex texture lets both the terrain and water vertex shaders use a single textureLoad per base-grid
 * vertex; the wet pyramid lets the water pass cull dry LOD nodes and sink far-from-water vertices.
 */

export const PREP_WGSL = /* wgsl */ `
struct Prep {
  nx: i32,
  ny: i32,
  vx: i32,
  vy: i32,
  stride: i32,
  useMax: i32,     // 1 → the displayed water field is max depth (maxDepth view mode)
  hWet: f32,       // depth that counts as wet (m)
  cellSize: f32,
  collapse: f32,   // how far dry vertices sink below the bed (m)
  wetHint: f32,    // 1 → the previous frame's wet pyramid is valid for this field (lets dry areas skip work)
  pad1: f32,
  pad2: f32,
}

@group(0) @binding(0) var<uniform> P: Prep;
@group(0) @binding(1) var bedTex: texture_2d<f32>;
@group(0) @binding(2) var barrierTex: texture_2d<f32>;
@group(0) @binding(3) var stateTex: texture_2d<f32>;

fn cl(p: vec2i) -> vec2i {
  return clamp(p, vec2i(0), vec2i(P.nx - 1, P.ny - 1));
}
fn bed(p: vec2i) -> f32 {
  return textureLoad(bedTex, cl(p), 0).r;
}
/**
 * Numerically blown-up cell (the naive stability-demo scheme): non-finite values, or values no flood can reach
 * (robust mode caps speeds at 15 m/s and never produces negative depth). NaN fails every comparison, so the tests
 * are written as "not within range".
 */
fn blownState(s: vec4f) -> bool {
  return !(s.r > -0.25 && s.r < 1000.0) || !(abs(s.g) < 150.0) || !(abs(s.b) < 150.0) || !(s.a < 1e4);
}
/** Sentinel written to the foam channel of blown-up cells (real foam is ≤ 1.5); the water shader paints it. */
const BLOWN_FOAM: f32 = 8.0;
fn cellHash(p: vec2i) -> f32 {
  var q = fract(vec2f(p) * vec2f(0.1031, 0.1030));
  q += dot(q, q.yx + 33.33);
  return fract((q.x + q.y) * q.x);
}
fn state(p: vec2i) -> vec4f {
  let c = cl(p);
  let s = textureLoad(stateTex, c, 0);
  if (blownState(s)) {
    // Show the blow-up as what it is — a jagged field of spikes — instead of silently hiding the cell.
    let spike = 1.0 + 9.0 * cellHash(c);
    return vec4f(spike, 0.0, 0.0, spike);
  }
  return s;
}
fn depthOf(s: vec4f) -> f32 {
  return select(max(s.r, 0.0), max(s.a, 0.0), P.useMax == 1);
}
`;

export const PREP_CELLS_WGSL = /* wgsl */ `
@group(0) @binding(4) var surfOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(5) var normOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(6) var miscOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var cellOut: texture_storage_2d<rg32float, write>;

/**
 * One 4-neighbour of a cell, loaded once. The bed slope, the water-surface slope and the whitewater term below
 * all want the same four neighbours; fetching them once takes the pass from twelve texel loads per cell to eight,
 * which is what pays for the new term.
 */
struct Nb {
  inside: bool,
  d: f32,        // displayed depth (m)
  vel: vec2f,    // depth-averaged velocity (m/s)
  bedY: f32,     // bed elevation, barriers included (m)
  eta: f32,      // water surface (m)
  wet: bool,
}

fn neighbour(p: vec2i) -> Nb {
  var o: Nb;
  o.inside = all(p == cl(p));
  let s = state(p);
  o.d = depthOf(s);
  o.vel = s.gb;
  o.bedY = bed(p);
  o.eta = o.bedY + o.d;
  o.wet = o.inside && o.d > P.hWet;
  return o;
}

/** Central water-surface slope along one axis (one-sided where only one side is wet, 0 where neither is). */
fn etaSlopeNb(a: Nb, b: Nb, ec: f32) -> f32 {
  let dx = P.cellSize;
  if (a.wet && b.wet) { return (a.eta - b.eta) / (2.0 * dx); }
  if (a.wet) { return (a.eta - ec) / dx; }
  if (b.wet) { return (ec - b.eta) / dx; }
  return 0.0;
}

@compute @workgroup_size(16, 16)
fn cells(@builtin(global_invocation_id) gid: vec3u) {
  let c = vec2i(gid.xy);
  if (c.x >= P.nx || c.y >= P.ny) { return; }
  let s = state(c);
  let h = depthOf(s);
  let b = bed(c);
  let dx = P.cellSize;

  let nR = neighbour(c + vec2i(1, 0));
  let nL = neighbour(c - vec2i(1, 0));
  let nD = neighbour(c + vec2i(0, 1));
  let nU = neighbour(c - vec2i(0, 1));

  // Bed slope (central differences, one-sided at the domain edge).
  let xr = cl(c + vec2i(1, 0));
  let xl = cl(c - vec2i(1, 0));
  let yd = cl(c + vec2i(0, 1));
  let yu = cl(c - vec2i(0, 1));
  let sbx = (nR.bedY - nL.bedY) / (max(f32(xr.x - xl.x), 1.0) * dx);
  let sbz = (nD.bedY - nU.bedY) / (max(f32(yd.y - yu.y), 1.0) * dx);

  var sex = 0.0;
  var sez = 0.0;
  var foam = 0.0;
  var collect = 0.0;
  let speed = length(s.gb);
  if (h > P.hWet) {
    let e = b + h;
    sex = clamp(etaSlopeNb(nR, nL, e), -3.0, 3.0);
    sez = clamp(etaSlopeNb(nD, nU, e), -3.0, 3.0);
    let froude = speed / sqrt(9.81 * max(h, 0.05));
    let rapids = smoothstep(0.02, 0.25, length(vec2f(sex, sez)));
    foam = smoothstep(0.55, 1.5, froude) * smoothstep(0.02, 0.25, h)
         + smoothstep(1.8, 5.0, speed) * 0.55
         + rapids * smoothstep(0.3, 1.5, speed) * 0.6;

    // ── Where whitewater collects ────────────────────────────────────────────────────────────────────
    // Read only by the water shader (miscOut.a); nothing here feeds back into the solver. Three things the
    // solved field already knows and a real surface would show:
    //   · the advancing front — a wet cell with a dry neighbour, weighted by how fast it is moving into it;
    //   · water piling against something it cannot cross — a neighbouring bed or barrier crest standing above
    //     this cell's own water surface (a levee, a building pad, a bank), with flow still pushing at it;
    //   · converging flow (−∇·u), which is where a real surface heaps up and aerates.
    // The domain edge is deliberately not a front: the diorama's cut face is not a shoreline, and treating it as
    // one drew a white outline around the whole map.
    let dry = select(0.0, 1.0, nR.inside && !nR.wet) + select(0.0, 1.0, nL.inside && !nL.wet)
            + select(0.0, 1.0, nD.inside && !nD.wet) + select(0.0, 1.0, nU.inside && !nU.wet);
    let front = min(dry, 2.0) * 0.5 * smoothstep(0.08, 0.8, speed);
    let block = max(max(nR.bedY, nL.bedY), max(nD.bedY, nU.bedY)) - e;
    let against = smoothstep(0.0, 0.5, block) * smoothstep(0.15, 1.2, speed);
    let div = (nR.vel.x - nL.vel.x + nD.vel.y - nU.vel.y) / (2.0 * dx);
    let conv = smoothstep(0.004, 0.06, -div) * smoothstep(0.1, 1.0, speed);
    // The max-depth view is a static map of where the water reached; live foam on it would be a lie about a
    // field that is not moving, so it is left off there.
    let live = select(1.0, 0.0, P.useMax == 1);
    collect = clamp(front * 0.85 + against * 0.9 + conv * 0.55, 0.0, 1.0) * smoothstep(0.02, 0.12, h) * live;
  }
  let vel = select(s.gb, vec2f(0.0), P.useMax == 1 && s.r <= P.hWet);
  let foamOut = select(clamp(foam, 0.0, 1.5), BLOWN_FOAM, blownState(textureLoad(stateTex, c, 0)));
  textureStore(surfOut, c, vec4f(h, vel, foamOut));
  textureStore(normOut, c, vec4f(clamp(sbx, -60.0, 60.0), clamp(sbz, -60.0, 60.0), sex, sez));
  let barrier = textureLoad(barrierTex, c, 0).r;
  textureStore(miscOut, c, vec4f(max(barrier, 0.0), max(s.a, 0.0), speed, collect));
  textureStore(cellOut, c, vec4f(h, b + h, 0.0, 0.0));
}
`;

export const PREP_VERTS_WGSL = /* wgsl */ `
@group(0) @binding(4) var vtxOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var wetPrev: texture_2d<f32>;
@group(0) @binding(6) var cellTex: texture_2d<f32>;
@group(0) @binding(7) var vtxBedTex: texture_2d<f32>;

/** Was there water within ~4 base quads of this vertex last frame? (conservative; 1 when no hint is available) */
fn nearWaterLastFrame(kl: vec2i) -> bool {
  if (P.wetHint < 0.5) { return true; }
  let lv = min(2, i32(textureNumLevels(wetPrev)) - 1);
  let size = vec2i(textureDimensions(wetPrev, lv));
  let t = kl >> vec2u(u32(lv));
  var w = 0.0;
  for (var oy = -1; oy <= 0; oy++) {
    for (var ox = -1; ox <= 0; ox++) {
      w = max(w, textureLoad(wetPrev, clamp(t + vec2i(ox, oy), vec2i(0), size - 1), lv).r);
    }
  }
  return w > 0.5;
}

/** (displayed depth, water surface elevation) of a cell, from the cells pass. */
fn cellAt(p: vec2i) -> vec2f {
  return textureLoad(cellTex, cl(p), 0).rg;
}

@compute @workgroup_size(16, 16)
fn verts(@builtin(global_invocation_id) gid: vec3u) {
  let kl = vec2i(gid.xy);
  if (kl.x >= P.vx || kl.y >= P.vy) { return; }
  let base = kl * P.stride;

  // A vertex sits on the corner shared by the 4 surrounding cells.
  var depthSum = 0.0;
  var depthMax = 0.0;
  var etaWet = 0.0;
  var wetCount = 0.0;
  for (var oy = -1; oy <= 0; oy++) {
    for (var ox = -1; ox <= 0; ox++) {
      let cd = cellAt(base + vec2i(ox, oy));
      let d = cd.r;
      depthSum += d;
      depthMax = max(depthMax, d);
      if (d > P.hWet) {
        etaWet += cd.g;
        wetCount += 1.0;
      }
    }
  }
  // Ground averaged (smooth terrain), barriers maxed so one-cell walls keep their full height: see PREP_VTXBED_WGSL.
  let bedV = textureLoad(vtxBedTex, kl, 0).r;
  var surface = bedV - P.collapse;
  if (wetCount > 0.0) {
    surface = min(etaWet / wetCount, bedV + depthMax);
  } else if (nearWaterLastFrame(kl)) {
    // Dry vertex next to water: extend the neighbouring water plane underneath it instead of snapping the surface
    // to the bed. The flat plane then meets the terrain mesh exactly along the terrain's contour at the water level,
    // so shorelines follow the land instead of zig-zagging along triangle diagonals. Clamping below the bed means
    // low ground behind a wall or levee is never covered by this extension.
    var etaN = 0.0;
    var nN = 0.0;
    let r = P.stride;
    for (var oy = -r - 1; oy <= r; oy++) {
      for (var ox = -r - 1; ox <= r; ox++) {
        if (oy >= -1 && oy <= 0 && ox >= -1 && ox <= 0) { continue; }
        let cd = cellAt(base + vec2i(ox, oy));
        if (cd.r > P.hWet) {
          etaN += cd.g;
          nN += 1.0;
        }
      }
    }
    if (nN > 0.0) {
      surface = min(etaN / nN, bedV - P.collapse);
    }
  }
  textureStore(vtxOut, kl, vec4f(bedV, surface, depthSum * 0.25, select(0.0, 1.0, wetCount > 0.0)));
}
`;

/** Per-vertex bed (terrain only: rebuilt when walls or the ground change, not per frame). */
export const PREP_VTXBED_WGSL = /* wgsl */ `
@group(0) @binding(4) var vtxBedOut: texture_storage_2d<r32float, write>;

@compute @workgroup_size(16, 16)
fn vtxBed(@builtin(global_invocation_id) gid: vec3u) {
  let kl = vec2i(gid.xy);
  if (kl.x >= P.vx || kl.y >= P.vy) { return; }
  let base = kl * P.stride;
  var groundSum = 0.0;
  var barrierMax = 0.0;
  for (var oy = -1; oy <= 0; oy++) {
    for (var ox = -1; ox <= 0; ox++) {
      let p = cl(base + vec2i(ox, oy));
      let br = max(textureLoad(barrierTex, p, 0).r, 0.0);
      groundSum += bed(p) - br;
      barrierMax = max(barrierMax, br);
    }
  }
  // Ground is averaged (smooth terrain), barriers take the max so one-cell walls keep their full height.
  textureStore(vtxBedOut, kl, vec4f(groundSum * 0.25 + barrierMax, 0.0, 0.0, 0.0));
}
`;

/**
 * Wet pyramid (r32float with mips): mip 0 texel (k, l) = 1 if any corner of base quad (k, l) touches a wet cell
 * (i.e. the quad's water triangles can be visible, dilated by one cell); mip j+1 = max over 2×2 of mip j.
 * The water vertex shader uses it to collapse whole dry LOD nodes and to sink vertices far from any water.
 */
export const WET_BASE_WGSL = /* wgsl */ `
@group(0) @binding(0) var vtxTex: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(16, 16)
fn wetBase(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(textureDimensions(dst));
  let p = vec2i(gid.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let m = vec2i(textureDimensions(vtxTex));
  var w = 0.0;
  if (p.x < m.x - 1 && p.y < m.y - 1) {
    w = max(max(textureLoad(vtxTex, p, 0).a, textureLoad(vtxTex, p + vec2i(1, 0), 0).a),
            max(textureLoad(vtxTex, p + vec2i(0, 1), 0).a, textureLoad(vtxTex, p + vec2i(1, 1), 0).a));
  }
  textureStore(dst, p, vec4f(w, 0.0, 0.0, 0.0));
}
`;

export const WET_DOWN_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8)
fn wetDown(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(textureDimensions(dst));
  let p = vec2i(gid.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let s = vec2i(textureDimensions(src)) - 1;
  let q = p * 2;
  let w = max(max(textureLoad(src, min(q, s), 0).r, textureLoad(src, min(q + vec2i(1, 0), s), 0).r),
              max(textureLoad(src, min(q + vec2i(0, 1), s), 0).r, textureLoad(src, min(q + vec2i(1, 1), s), 0).r));
  textureStore(dst, p, vec4f(w, 0.0, 0.0, 0.0));
}
`;

/**
 * "Normally wet" mask (r exact, g softened), captured once per scene right after the initial fill (FloodRenderer.setScene is called right
 * after solver.setInitialWater, whose reset writes h = initial depth): 1 where the cell holds water before any
 * flood (rivers, lakes). Same test as the solver's dry-at-reset mask (h < 0.01 m = dry) behind SimStats.floodedArea,
 * so the hazard maps colour exactly the land the HUD counts as flooded.
 */
export const NORMAL_WATER_WGSL = /* wgsl */ `
@group(0) @binding(0) var stateTex: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<rgba8unorm, write>;

@compute @workgroup_size(16, 16)
fn normalWater(@builtin(global_invocation_id) gid: vec3u) {
  let size = vec2i(textureDimensions(dst));
  let p = vec2i(gid.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  // r: the wet test itself; g: a 5×5 box average of it, a soft ramp over a couple of cells along the old bank that
  // the water shader samples once (a hard per-cell edge would stair-step across the flood).
  var sum = 0.0;
  for (var oy = -2; oy <= 2; oy++) {
    for (var ox = -2; ox <= 2; ox++) {
      let q = clamp(p + vec2i(ox, oy), vec2i(0), size - 1);
      let h = textureLoad(stateTex, q, 0).r;
      sum += select(0.0, 1.0, h >= 0.01 && h < 1000.0);
    }
  }
  let hc = textureLoad(stateTex, p, 0).r;
  textureStore(dst, p, vec4f(select(0.0, 1.0, hc >= 0.01 && hc < 1000.0), sum / 25.0, 0.0, 1.0));
}
`;
