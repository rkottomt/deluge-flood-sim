/**
 * Per-frame GPU preprocessing of the solver textures into render-friendly derived textures:
 *
 *  cells  (nx×ny)  → surfTex rgba16float: h, u, v, foam source          (filterable)
 *                    normTex rgba16float: ∂bed/∂x, ∂bed/∂z, ∂η/∂x, ∂η/∂z (filterable, wet-only η differences)
 *                    miscTex rgba16float: barrier, max depth, 0, 0        (filterable)
 *  verts  (vx×vy)  → vtxTex  rgba32float: bed, water surface, mean depth, wet-neighbourhood flag
 *
 * The vertex texture lets both the terrain and water vertex shaders use a single textureLoad per vertex,
 * and the wet-neighbourhood flag lets the water mesh cull whole dry regions by emitting degenerate
 * triangles (a vertex is only flagged dry when every triangle touching it is dry).
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
  pad0: f32,
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
fn state(p: vec2i) -> vec4f {
  let s = textureLoad(stateTex, cl(p), 0);
  // NaN/inf guard (the naive stability-demo mode can blow up): treat as dry, no flow.
  if (!(abs(s.r) < 1e6) || !(abs(s.g) < 1e6) || !(abs(s.b) < 1e6)) {
    return vec4f(0.0);
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

fn etaSlope(c: vec2i, axis: vec2i, hc: f32, ec: f32) -> f32 {
  let pr = c + axis;
  let pl = c - axis;
  let inR = all(pr == cl(pr));
  let inL = all(pl == cl(pl));
  let sr = state(pr);
  let sl = state(pl);
  let dr = depthOf(sr);
  let dl = depthOf(sl);
  let wr = inR && dr > P.hWet;
  let wl = inL && dl > P.hWet;
  let er = bed(pr) + dr;
  let el = bed(pl) + dl;
  let dx = P.cellSize;
  if (wr && wl) { return (er - el) / (2.0 * dx); }
  if (wr) { return (er - ec) / dx; }
  if (wl) { return (ec - el) / dx; }
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

  // Bed slope (central differences, one-sided at the domain edge).
  let xr = cl(c + vec2i(1, 0));
  let xl = cl(c - vec2i(1, 0));
  let yd = cl(c + vec2i(0, 1));
  let yu = cl(c - vec2i(0, 1));
  let sbx = (bed(xr) - bed(xl)) / (max(f32(xr.x - xl.x), 1.0) * dx);
  let sbz = (bed(yd) - bed(yu)) / (max(f32(yd.y - yu.y), 1.0) * dx);

  var sex = 0.0;
  var sez = 0.0;
  var foam = 0.0;
  let speed = length(s.gb);
  if (h > P.hWet) {
    let e = b + h;
    sex = clamp(etaSlope(c, vec2i(1, 0), h, e), -3.0, 3.0);
    sez = clamp(etaSlope(c, vec2i(0, 1), h, e), -3.0, 3.0);
    let froude = speed / sqrt(9.81 * max(h, 0.05));
    let rapids = smoothstep(0.02, 0.25, length(vec2f(sex, sez)));
    foam = smoothstep(0.55, 1.5, froude) * smoothstep(0.02, 0.25, h)
         + smoothstep(1.8, 5.0, speed) * 0.55
         + rapids * smoothstep(0.3, 1.5, speed) * 0.6;
  }
  let vel = select(s.gb, vec2f(0.0), P.useMax == 1 && s.r <= P.hWet);
  textureStore(surfOut, c, vec4f(h, vel, clamp(foam, 0.0, 1.5)));
  textureStore(normOut, c, vec4f(clamp(sbx, -60.0, 60.0), clamp(sbz, -60.0, 60.0), sex, sez));
  let barrier = textureLoad(barrierTex, c, 0).r;
  textureStore(miscOut, c, vec4f(max(barrier, 0.0), max(s.a, 0.0), speed, 0.0));
}
`;

export const PREP_VERTS_WGSL = /* wgsl */ `
@group(0) @binding(4) var vtxOut: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(16, 16)
fn verts(@builtin(global_invocation_id) gid: vec3u) {
  let kl = vec2i(gid.xy);
  if (kl.x >= P.vx || kl.y >= P.vy) { return; }
  let s = P.stride;
  let base = kl * s;

  var groundSum = 0.0;
  var barrierMax = 0.0;
  var depthSum = 0.0;
  var depthMax = 0.0;
  var etaWet = 0.0;
  var wetCount = 0.0;
  for (var oy = -1; oy <= 0; oy++) {
    for (var ox = -1; ox <= 0; ox++) {
      let p = cl(base + vec2i(ox, oy));
      let z = bed(p);
      let br = max(textureLoad(barrierTex, p, 0).r, 0.0);
      groundSum += z - br;
      barrierMax = max(barrierMax, br);
      let d = depthOf(state(p));
      depthSum += d;
      depthMax = max(depthMax, d);
      if (d > P.hWet) {
        etaWet += z + d;
        wetCount += 1.0;
      }
    }
  }
  let bedV = groundSum * 0.25 + barrierMax;
  var surface = bedV - P.collapse;
  if (wetCount > 0.0) {
    surface = min(etaWet / wetCount, bedV + depthMax);
  }

  // Wet-neighbourhood flag: any wet cell touching this vertex or any adjacent vertex.
  var flag = select(0.0, 1.0, wetCount > 0.0);
  if (flag == 0.0) {
    for (var oy = -s - 1; oy <= s && flag == 0.0; oy++) {
      for (var ox = -s - 1; ox <= s; ox++) {
        if (depthOf(state(cl(base + vec2i(ox, oy)))) > P.hWet) {
          flag = 1.0;
          break;
        }
      }
    }
  }
  textureStore(vtxOut, kl, vec4f(bedV, surface, depthSum * 0.25, flag));
}
`;
