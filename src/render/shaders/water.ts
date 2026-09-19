/** Water surface shaders: photoreal floodwater and hazard colormaps. */
import { COMMON_WGSL, FRAME_WGSL, LOD_WGSL, SUN_SHADING_WGSL, VTX_SAMPLE_WGSL, WALL_WGSL } from './common';

export const WATER_WGSL = /* wgsl */ `
${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var vtxTex: texture_2d<f32>;
@group(0) @binding(2) var normTex: texture_2d<f32>;
@group(0) @binding(3) var miscTex: texture_2d<f32>;
@group(0) @binding(4) var surfTex: texture_2d<f32>;
@group(0) @binding(5) var rippleTex: texture_2d<f32>;
@group(0) @binding(6) var linSamp: sampler;
@group(0) @binding(7) var repSamp: sampler;
@group(0) @binding(8) var wetTex: texture_2d<f32>;
@group(0) @binding(9) var wallTex: texture_2d<f32>;
@group(0) @binding(10) var normalWetTex: texture_2d<f32>;
@group(0) @binding(12) var sunTex: texture_2d<f32>;
@group(0) @binding(13) var imageryTex: texture_2d<f32>;
@group(0) @binding(14) var roofTex: texture_2d<f32>;   // r32float, point-fetched: roof height above ground per cell
${COMMON_WGSL}
${LOD_WGSL}
${VTX_SAMPLE_WGSL}
${WALL_WGSL}
${SUN_SHADING_WGSL}

/**
 * The renderer's Cinematic tier (quality.ts). Only the 'cinematic' preset ever sets the detail-normal strength
 * to 1 — the adaptive ladder tops out at 0.75 — so this is the same tier switch the terrain shader already reads
 * for its fine detail octave, and it needs no room in the (full) frame uniform. Everything behind it is an effect
 * the default tier cannot afford at 60 fps under a full Pittsburgh flood; the adaptive controller keeps working
 * exactly as before, because nothing here ever raises a level.
 */
fn cinematicTier() -> bool {
  return F.shade.y > 0.9;
}

/**
 * ── Reflections of the world, not of the screen ────────────────────────────────────────────────
 *
 * The obvious implementation is a screen-space march, and here it is the wrong one. The whole scene is drawn in
 * ONE 4x MSAA pass, so at the moment the water is shaded there is no resolved colour buffer to read and no
 * sampleable depth to march through; adding them means splitting the pass, resolving colour and writing depth to
 * a second target, every frame, for every pixel. And a grazing river reflection mostly wants geometry that is not
 * on screen at all — the hillside behind the camera, the far bank past the frame edge — which is exactly where a
 * screen-space march runs out of data and has to be faded away.
 *
 * So the ray is marched against the height field itself: one texel fetch per step of the same per-vertex texture
 * the meshes are built from, geometric step growth (fine near the surface, where banks, levees and the near shore
 * are, coarse far away), then a few bisections to land on the hit. It reflects what is behind the camera and
 * beyond the frame edge, it costs no extra pass or render target, and where the ray leaves the terrain the caller
 * simply keeps the sky reflection it already had — the fallback is the thing it was going to draw anyway.
 *
 * Only the terrain (bed, including any barrier built into it) occludes. Water is not a reflector of water, and
 * leaving the flood plane out of the march is what stops a near-horizontal ray from hitting that plane a few
 * metres downstream and mirroring the river back onto itself.
 */
struct ReflHit {
  hit: f32,
  uv: vec2f,
  pos: vec3f,
  /** Height of the thing that was hit above the ground under it (m): 0 on bare terrain, the roof on a building. */
  built: f32,
}

/**
 * What the ray can hit: the bed (ground plus any barrier built into it) and, where the scene has a city, the roof
 * standing on that cell. The roof raster is the same one the sun-shading pass marches for building shadows, so
 * the skyline the flood reflects is the skyline that casts the shadows — one field, no second opinion.
 */
fn occluderAt(g: vec2f) -> vec2f {
  let bed = vtxAtGrid(g).r;
  var roof = 0.0;
  if (F.protect.y > 0.5) {
    roof = textureLoad(roofTex, clamp(vec2i(g), vec2i(0), vec2i(F.grid) - vec2i(1)), 0).r;
  }
  return vec2f((bed + roof) * F.exag, roof);
}

fn marchReflection(p0: vec3f, dir: vec3f, step0: f32, steps: i32, refines: i32) -> ReflHit {
  var o: ReflHit;
  o.hit = 0.0;
  o.uv = vec2f(0.0);
  o.pos = p0;
  o.built = 0.0;
  var step = step0;
  var t = step0;
  var tPrev = 0.0;
  for (var i = 0; i < steps; i++) {
    let w = p0 + dir * t;
    let g = worldToGrid(w);
    // Off the diorama: there is nothing out there to reflect but sky.
    if (any(g < vec2f(0.0)) || any(g > F.grid)) { return o; }
    if (w.y < occluderAt(g).x) {
      var lo = tPrev;
      var hi = t;
      for (var k = 0; k < refines; k++) {
        let mid = (lo + hi) * 0.5;
        let wm = p0 + dir * mid;
        if (wm.y < occluderAt(worldToGrid(wm)).x) { hi = mid; } else { lo = mid; }
      }
      let wh = p0 + dir * hi;
      o.hit = 1.0;
      o.uv = clamp(worldToGrid(wh) / F.grid, vec2f(0.0), vec2f(1.0));
      o.pos = wh;
      o.built = occluderAt(worldToGrid(wh)).y;
      return o;
    }
    tPrev = t;
    step *= 1.5;
    t += step;
  }
  return o;
}

/**
 * Colour of what the ray hit, lit the way the pass that draws it lights it — same albedo, same cast-shadow raster,
 * same relighting of the photograph — so a reflected hillside is the colour of the hillside, not a guess at it.
 *
 * The built argument is how far the hit stands above the ground: 0 on bare terrain, the roof height on a building. Anything
 * standing up is reflected as a FACADE, not as the roof the photograph shows — a vertical wall facing back along
 * the ray, in the flat grey-blue of the extruded city, because that is the face the water can actually see.
 */
fn reflectedColorAt(uv: vec2f, lod: f32, built: f32, dir: vec3f) -> vec3f {
  var albedo = vec3f(0.17, 0.175, 0.15);
  if (F.opts.x > 0.5) {
    albedo = textureSampleLevel(imageryTex, linSamp, uv, lod).rgb;
  }
  let nrm = textureSampleLevel(normTex, linSamp, uv, 0.0);
  var n = normalize(vec3f(-nrm.r * F.exag, 1.0, -nrm.g * F.exag));
  let facade = smoothstep(2.0, 9.0, built);
  if (facade > 0.0) {
    albedo = mix(albedo, vec3f(0.30, 0.315, 0.335), facade * 0.8);
    n = normalize(mix(n, normalize(vec3f(-dir.x, 0.22, -dir.z)), facade));
  }
  var vis = vec2f(1.0);
  if (F.light.w > 0.5) {
    vis = sunShadingRaw(uv);
  }
  var ndl = max(dot(n, F.sunDir), 0.0);
  var sunLit = vis.x;
  if (F.opts.x > 0.5) {
    // A facade is not in the aerial photograph at all, so it takes real lighting; the ground keeps the terrain
    // pass's relighting contract (the photo already carries its own shading).
    ndl = mix(mix(max(F.sunDir.y, 0.2), ndl, F.light.z) * F.shade.w, ndl, facade);
    sunLit = mix(mix(1.0, vis.x, F.light.x), vis.x, facade);
  }
  let occ = mix(1.0, vis.y, F.light.y);
  return albedo * (F.sunColor * (1.0 - F.opts.w * 0.75) * ndl * sunLit + skyAmbient(n) * (0.85 + 0.3 * F.shade.z) * occ);
}

/**
 * Anisotropic chop. Real river chop is not isotropic noise: the current stretches the pattern out along itself and
 * leaves crests running across it. Damping the along-flow component of the ripple SLOPE does both — the surface
 * varies fast across the flow and slowly along it — and unlike stretching the texture coordinates it cannot swim
 * or alias, because the sample point (and so the mip the hardware picks) never moves.
 */
fn crossFlow(slope: vec2f, dir: vec2f, alongDamp: f32) -> vec2f {
  return slope - dir * (dot(slope, dir) * (1.0 - alongDamp));
}

struct WOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) grid: vec2f,
  @location(2) thick: f32,     // water surface − rendered bed at this point (m, unexaggerated)
  @location(3) skirt: f32,     // 1 on the domain-edge cross-section
  @location(4) haze: vec4f,    // rgb haze color, a = haze amount
}

const PATCH_LOG2: i32 = 5;

fn wetAt(mip: i32, t: vec2i) -> f32 {
  let lv = clamp(mip, 0, i32(textureNumLevels(wetTex)) - 1);
  let size = vec2i(textureDimensions(wetTex, lv));
  // Texel spans grow with the mip; convert from the requested mip's texel grid when clamped.
  let tt = t >> vec2u(u32(max(mip - lv, 0)));
  return textureLoad(wetTex, clamp(tt, vec2i(0), size - 1), lv).r;
}

/** How far the prep pass sinks dry vertices below the bed (m); must match pf[8] in index.ts. */
const DRY_COLLAPSE: f32 = 0.05;

/**
 * Water surface of one LOD vertex sample \`t\` (vtxTex texel at grid position g) for a mesh whose vertices are
 * q cells apart. The prep pass already extends the water plane under dry vertices within about one base cell of
 * water; on a coarse LOD level a dry vertex several cells up the bank misses that, so its water triangles slope
 * from the river surface up to the bank and cut the terrain in a saw-tooth. Here a dry vertex instead takes the
 * mean surface of its wet neighbours in THIS mesh (the six vertices it shares triangles with), clamped below its
 * own bed: every water triangle touching it is then flat and meets the terrain along the terrain's own contour.
 * Low dry ground (bed below the neighbours' water, e.g. behind a levee) stays collapsed by the clamp.
 */
fn lodSurface(g: vec2f, t: vec4f, q: f32) -> f32 {
  if (t.a > 0.5) { return t.g; }
  var sum = 0.0;
  var cnt = 0.0;
  let offs = array<vec2f, 6>(vec2f(1.0, 0.0), vec2f(-1.0, 0.0), vec2f(0.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0));
  for (var i = 0; i < 6; i++) {
    let gn = g + offs[i] * q;
    if (any(gn < vec2f(0.0)) || any(gn > F.grid)) { continue; }
    let tn = vtxAtGrid(gn);
    if (tn.a > 0.5) {
      sum += tn.g;
      cnt += 1.0;
    }
  }
  if (cnt < 0.5) { return t.g; }
  // Never raise a vertex the prep pass already placed higher (its own local extension is the more accurate one).
  return max(t.g, min(sum / cnt, t.r - DRY_COLLAPSE));
}

@vertex
fn vsWater(@builtin(vertex_index) vi: u32, n: NodeIn) -> WOut {
  var o: WOut;
  let level = i32(n.node.w + 0.5);
  let nodeCells = n.node.z * f32(PATCH);
  // Whole node dry (no water within one cell of it): collapse every vertex → zero-area triangles.
  if (wetAt(level + PATCH_LOG2, vec2i(floor(n.node.xy / nodeCells + 0.5))) < 0.5) {
    o.pos = vec4f(2.0, 2.0, -1.0, 1.0);
    o.thick = -1.0;
    return o;
  }
  let v = lodVertex(vi, n);
  let bed = mix(v.a.r, v.b.r, v.m);
  // Sample a lives on this node's mesh (spacing q), sample b on the parent mesh it morphs toward (spacing 2q).
  let surfA = lodSurface(v.g0, v.a, n.node.z);
  let surfB = select(lodSurface(v.gp, v.b, 2.0 * n.node.z), surfA, v.m <= 0.0);
  var surface = mix(surfA, surfB, v.m);
  // No water within two quads of this vertex (covers its morph range): sink it far below the terrain. No visible
  // water triangle can touch it, and its dry triangles are then rejected by the depth test instead of shaded.
  let f = vec2i(floor(v.g0 / (2.0 * n.node.z)));
  let mip = level + 1;
  let near = max(max(wetAt(mip, f - vec2i(1, 1)), wetAt(mip, f - vec2i(0, 1))), max(wetAt(mip, f - vec2i(1, 0)), wetAt(mip, f)));
  if (near < 0.5) {
    surface = bed - 60.0;
  }
  let w = gridToWorld(v.g, surface);
  o.pos = pullForward(F.viewProj * vec4f(w, 1.0), 2.5e-5);
  o.world = w;
  o.grid = v.g;
  o.thick = surface - bed;
  o.skirt = 0.0;
  o.haze = vertexHaze(w);
  return o;
}

/** Water cross-section on the diorama edge (same index encoding as the terrain skirt). */
@vertex
fn vsWaterSkirt(@builtin(vertex_index) vi: u32) -> WOut {
  let maxV = u32(max(F.mesh.x, F.mesh.y));
  let side = vi / (2u * maxV);
  let k = i32((vi % (2u * maxV)) / 2u);
  let isTop = (vi % 2u) == 1u;
  let m = vec2i(F.mesh);
  var kl = vec2i(0);
  var push = vec2f(0.0);
  switch (side) {
    case 0u: { kl = vec2i(k, 0); push = vec2f(0.0, -1.0); }
    case 1u: { kl = vec2i(k, m.y - 1); push = vec2f(0.0, 1.0); }
    case 2u: { kl = vec2i(0, k); push = vec2f(-1.0, 0.0); }
    default: { kl = vec2i(m.x - 1, k); push = vec2f(1.0, 0.0); }
  }
  let t = textureLoad(vtxTex, kl, 0);
  let wet = t.a > 0.5 && t.g > t.r;
  let top = select(t.r, t.g, wet);
  let elev = select(t.r, top, isTop);
  let g = min(vec2f(kl) * F.stride, F.grid);
  var w = gridToWorld(g, elev);
  w += vec3f(push.x, 0.0, push.y) * 0.05;
  var o: WOut;
  o.pos = pullForward(F.viewProj * vec4f(w, 1.0), 2.5e-5);
  o.world = w;
  o.grid = g;
  o.thick = select(-1.0, top - elev + 0.001, wet);
  o.skirt = 1.0;
  o.haze = vertexHaze(w);
  return o;
}

/** Ripple slopes (∂h/∂x, ∂h/∂z) and foam noise from the tileable ripple texture. */
/** Ripple texel at p with the screen-space gradients of p (the same filtering textureSample would choose). */
fn rippleSample(p: vec2f, gx: vec2f, gy: vec2f) -> vec4f {
  let s = textureSampleGrad(rippleTex, repSamp, p, gx, gy);
  return vec4f(s.rg * 2.0 - 1.0, s.b, s.a);
}

fn rainRipple(p: vec2f) -> vec2f {
  let cell = floor(p);
  let f = fract(p) - 0.5;
  let rnd = hash12(cell);
  let t = fract(F.time * 0.85 + rnd);
  let off = vec2f(hash12(cell + 3.1), hash12(cell + 7.7)) - 0.5;
  let d = f - off * 0.5;
  let r = length(d);
  let R = t * 0.45;
  let ring = sin((r - R) * 45.0) * exp(-abs(r - R) * 22.0) * (1.0 - t);
  return d / max(r, 1e-3) * ring;
}

fn hazardColor(value: f32, fw: f32) -> vec3f {
  let count = i32(F.bandCount);
  var c = F.bands[0].rgb;
  let w = max(fw * 0.75, 1e-4);
  for (var i = 1; i < count; i++) {
    let thr = F.bands[i - 1].a;
    c = mix(c, F.bands[i].rgb, smoothstep(thr - w, thr + w, value));
  }
  return c;
}

@fragment
fn fsWater(in: WOut) -> @location(0) vec4f {
  let uv = in.grid / F.grid;
  let s = textureSampleLevel(surfTex, linSamp, uv, 0.0);
  let nrm = textureSampleLevel(normTex, linSamp, uv, 0.0);
  let misc = textureSampleLevel(miscTex, linSamp, uv, 0.0);
  // 1 where this is the normal river / lake (wet before any flood), 0 on land the flood has reached (the softened
  // channel ramps over a couple of cells along the old bank; the exact mask keeps creeks narrower than the ramp).
  let nw = textureSampleLevel(normalWetTex, linSamp, uv, 0.0);
  let normalWet = select(0.0, max(nw.r, nw.g), F.wall.w > 0.5);
  let floodLand = 1.0 - normalWet;

  let mode = i32(F.waterMode + 0.5);
  let flow = s.gb;
  let speed = length(flow);

  let V0 = F.camPos - in.world;
  let dist = length(V0);
  let V = V0 / max(dist, 1e-3);
  // Water thickness from the BASE-resolution vertex field (same triangulation as the finest mesh), not the coarse
  // LOD triangle: on a coarse level a narrow island or bank falls between vertices, the coarse terrain dips under
  // the (flat, extended) water plane and water would show over land. Deciding wet/dry per fragment from the fine
  // field keeps the shoreline identical at every LOD level; the coarse geometry only has to be above the terrain.
  let fineV = vtxBilinear(in.grid);
  let thick = select(fineV.g - fineV.r, in.thick, in.skirt > 0.5);
  // Derivatives in uniform control flow (before any discard).
  let thickFw = fwidth(thick);
  let thickGrad = vec2f(dpdx(thick), dpdy(thick));
  let uvDx = dpdx(uv);
  let uvDy = dpdy(uv);
  let valueDepth = select(s.r, misc.g, mode == 2);
  let hazardValue = select(valueDepth, misc.b, mode == 3);
  let hazardFw = fwidth(hazardValue);
  let pixelFoot = dist * F.elev.w;

  // ── Flow-advected detail: two-phase flow map (Vlachos 2010) ─────────────────────────────
  // Texture coordinates are pushed downstream by u·k·t and reset every period; two phases half a period apart
  // are cross-faded so the reset is never visible. k exaggerates the (slow, physical) flow so motion reads on screen.
  let period = 3.0;
  let ph0 = fract(F.time / period);
  let ph1 = fract(F.time / period + 0.5);
  let blend = abs(ph0 - 0.5) * 2.0;
  let adv = flow * F.flowVis * period;
  let pA = in.world.xz / 13.0;
  let pB = in.world.xz / 4.1;
  let pM = in.world.xz / 70.0;
  // Screen-space gradients of the world position and of the advection offset (uniform control flow): every ripple
  // coordinate below is a linear combination of the two plus per-frame constants, so its gradient is too. The texture
  // lookups themselves (textureSampleGrad, same filtering as textureSample) come after the early exits, so dry and
  // blown-up fragments skip them.
  let wDx = dpdx(in.world.xz);
  let wDy = dpdy(in.world.xz);
  let advDx = dpdx(adv);
  let advDy = dpdy(adv);
  if (thick <= 0.0 || in.thick <= -30.0) {
    discard;
  }
  // A wall whose crest is above this water: its crest, faces and casing are drawn by the terrain pass with a
  // screen-space minimum width, so the water must not paint over them where they overhang the channel.
  if (in.skirt < 0.5 && wallNear(uv)) {
    let wh = wallAt(uv);
    if (wh.h > WALL_MIN_H && wh.d < wallProfile(max(pixelFoot, 1e-3)).casing && wh.crest > in.world.y / F.exag + 0.02) {
      discard;
    }
  }

  // Soft shoreline: fade over a few cm, widened by the pixel footprint to stay anti-aliased at any distance.
  let shore = smoothstep(0.0, max(0.03, thickFw * 1.5), thick);

  // Numerical blow-up (stability demo): the prep pass marks non-finite cells with foam = 8 and raises them into a field
  // of spikes. Paint them as hot, flickering magenta "garbage" (HDR, so it blooms) — visible from any distance, in every
  // view mode. Fully blown fragments skip the water shading below: the spikes multiply overdraw, and shading them all
  // pushed "Break it" frames past 40 ms. (Cells on the edge of the blow-up blend at the end of the shader.)
  let blown = smoothstep(2.0, 6.0, s.a);
  if (blown >= 0.999) {
    let cellId = floor(in.grid);
    let flicker = step(0.5, fract(F.time * 7.0 + hash12(cellId) * 3.0));
    let glitch = mix(vec3f(2.8, 0.15, 1.4), vec3f(3.2, 1.6, 0.2), flicker * hash12(cellId + vec2f(7.0, 3.0)));
    return vec4f(mix(glitch * shore, in.haze.rgb * shore, in.haze.a), shore);
  }

  let gA0 = (wDx - advDx * ph0) / 13.0;
  let hA0 = (wDy - advDy * ph0) / 13.0;
  let gA1 = (wDx - advDx * ph1) / 13.0;
  let hA1 = (wDy - advDy * ph1) / 13.0;
  let a0 = rippleSample(pA - adv * ph0 / 13.0, gA0, hA0);
  let a1 = rippleSample(pA - adv * ph1 / 13.0 + vec2f(0.37, 0.61), gA1, hA1);
  let b0 = rippleSample(pB - adv * ph0 / 4.1 + vec2f(0.21, 0.13) * F.time * 0.12, gA0 * (13.0 / 4.1), hA0 * (13.0 / 4.1));
  let b1 = rippleSample(pB - adv * ph1 / 4.1 + vec2f(0.53, 0.19) + vec2f(0.21, 0.13) * F.time * 0.12, gA1 * (13.0 / 4.1), hA1 * (13.0 / 4.1));
  let m0 = rippleSample(pM - adv * ph0 / 70.0, gA0 * (13.0 / 70.0), hA0 * (13.0 / 70.0));
  let m1 = rippleSample(pM - adv * ph1 / 70.0 + vec2f(0.71, 0.29), gA1 * (13.0 / 70.0), hA1 * (13.0 / 70.0));
  let rA = mix(a0, a1, blend);
  let rB = mix(b0, b1, blend);
  let rM = mix(m0, m1, blend);
  let slickFar = textureSampleGrad(rippleTex, repSamp, in.world.xz / 233.0 + vec2f(0.31, 0.77), wDx / 233.0, wDy / 233.0).a;

  // ── Normal: macro η slope + advected ripples (roughness grows with distance instead of aliasing) ─────
  // The chop answers to the solver: its height scales with the local speed, and its crests are pulled across the
  // current (see crossFlow), so ponded floodwater over a car park is nearly glassy while the river cores are
  // visibly rough and the direction of the flow is readable from the surface alone.
  let macroSlope = nrm.ba * F.exag;
  let turbulence = smoothstep(0.2, 3.0, speed);
  let chop = 0.11 + 0.5 * turbulence;
  let detailFade = 1.0 - smoothstep(0.6, 5.0, pixelFoot);
  let fineFade = 1.0 - smoothstep(0.15, 1.5, pixelFoot);
  let rainAmt = smoothstep(0.5, 25.0, F.rainRate) * (1.0 - smoothstep(0.03, 0.15, pixelFoot));
  let rainSlope = rainRipple(in.world.xz / 1.6);
  let fdir = select(vec2f(1.0, 0.0), flow / max(speed, 1e-4), speed > 1e-3);
  let alongDamp = mix(1.0, 0.3, smoothstep(0.25, 2.2, speed));
  let chopA = crossFlow(rA.xy, fdir, alongDamp) * chop * mix(0.25, 1.0, detailFade);
  let chopB = crossFlow(rB.xy, fdir, alongDamp) * chop * 0.6 * fineFade;
  // A long swell running across the current, and only in genuinely fast water: from a kilometre up it is what
  // separates a moving river from a textured plane.
  let swell = crossFlow(rM.xy, fdir, mix(1.0, 0.15, smoothstep(0.5, 3.0, speed))) * (0.035 + 0.13 * turbulence);
  var slopes = macroSlope + chopA + chopB + swell + rainSlope * 0.4 * rainAmt;
  if (in.skirt > 0.5) {
    slopes = vec2f(0.0);
  }
  let n = normalize(vec3f(-slopes.x, 1.0, -slopes.y));

  // ── Light reaching the surface ─────────────────────────────────────────────────────────────────────────
  // Sun gated by the cast-shadow raster and sky gated by how much of the dome this spot can see (src/render/
  // shadows.ts): floodwater under a hill now goes as cool and dark as the ground beside it, instead of being the
  // one surface in the scene that the sun could not miss.
  let pxCells = max(pixelFoot / F.cellSize, 1e-4);
  // The terrain takes four taps of the raster to keep the DEM's own cell grid from showing through its relief.
  // Water has no sub-cell relief to hide — it is flat — so one bilinear tap is indistinguishable while a pixel
  // still covers about a cell, and the four-tap filter is only worth its bandwidth further out, where a single
  // tap would sparkle. Water covers much of this scene, so that is three taps saved over most of the frame.
  // (An if, not select: WGSL's select evaluates both arms, which would take all five taps.)
  var vis = vec2f(1.0);
  if (F.light.w > 0.5) {
    if (pxCells > 1.2) {
      vis = sunShading(uv, pxCells);
    } else {
      vis = sunShadingRaw(uv);
    }
  }
  // Water is not relit from a photograph the way the draped terrain is — the renderer draws it outright — so it
  // takes the cast shadow at full strength, scaled only by the lighting preset's own knob.
  //
  // But the raster answers for the GROUND, and a flood stands above the ground. A blocker that hides the bed from
  // the sky — the kerb, the building across the street, the far bank — hides less and less of the sky from the
  // surface as the water deepens, and the same goes (more weakly) for the sun. Without this correction, flooded
  // streets downtown inherit the buildings' own ambient occlusion and the flood turns dark grey exactly where it
  // has to be read at a glance.
  let lift = smoothstep(0.3, 8.0, thick);
  let shadowVis = mix(mix(1.0, vis.x, F.light.x), 1.0, lift * 0.35);
  let skyOcc = mix(mix(1.0, vis.y, F.light.y), 1.0, lift * 0.8);
  let sunVis = (1.0 - F.opts.w * 0.85) * shadowVis;
  let lightIn = F.sunColor * max(F.sunDir.y, 0.0) * sunVis + skyAmbient(n) * skyOcc;
  let nv = max(dot(n, V), 0.0);
  let fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  var R = reflect(-V, n);
  R.y = abs(R.y) + 0.01;
  let H = normalize(F.sunDir + V);
  let nh = max(dot(n, H), 0.0);
  // Glossiness drops with distance (unresolved ripples widen the lobe) so far water gets a broad sheen.
  let gloss = mix(60.0, 900.0, detailFade);
  let spec = F.sunColor * sunVis * pow(nh, gloss) * (gloss + 8.0) / 25.0 * fres * smoothstep(0.0, 0.08, F.sunDir.y);

  // ── What the surface reflects: the sky, and the world wherever a ray can find it ────────────────────────
  let imgDims = vec2f(textureDimensions(imageryTex, 0));
  let mPerTexel = F.grid.x * F.cellSize / max(imgDims.x, 1.0);
  var sky = skyReflection(R);
  let cine = cinematicTier();
  // Below a few per cent the reflection is invisible under the body colour — and a near-vertical view of a river
  // is exactly that case — so the march is paid for only where it can be seen: at grazing angles, and not on
  // water so far away that the whole reflection is a couple of pixels. The Cinematic tier lowers the angle it
  // starts at and nearly doubles the steps, which is what buys the long, sharp reflections in a hero still.
  let reflGate = select(0.075, 0.03, cine);
  let reflRange = select(8.0, 40.0, cine);
  if (fres > reflGate && in.skirt < 0.5 && pixelFoot < reflRange) {
    let h = marchReflection(in.world, R, max(0.9 * F.cellSize, 1.5 * pixelFoot), select(10, 20, cine), select(3, 6, cine));
    if (h.hit > 0.5) {
      // Rough water scatters what it reflects, so a choppy river reflects a blurred hillside: widen the mip
      // footprint with the chop rather than taking more taps.
      let blur = 1.0 + 9.0 * chop;
      let lod = clamp(log2(max(distance(h.pos, F.camPos) * F.elev.w * blur / max(mPerTexel, 0.01), 1.0)), 0.0, 12.0);
      // A reflected hill is behind the same air as the hill itself.
      let col = mix(reflectedColorAt(h.uv, lod, h.built, R), in.haze.rgb, hazeAmount(h.pos));
      sky = mix(sky, col, smoothstep(reflGate, reflGate + 0.06, fres));
    }
  }

  // ── Photoreal floodwater (also the base under the hazard colours) ─────────────────────────────────────
  // Rivers: turbid water with a short absorption length; deep channels read darker and greener.
  // Floodwater on land: sediment-laden, a lighter khaki-brown sheet that stands apart from roofs, asphalt and
  // trees, with a pale wet line along its advancing edge.
  let path = thick / max(nv, 0.2);
  // River water vs floodwater colour and clarity blend over the soft ramp (5×5 box average, 0.5 on the old bank):
  // the exact per-cell mask would draw the seam between them as a staircase of 8 m cells. Full river colour from the
  // bank line inward, fading out over ~2 cells of flooded land, the edge jittered by the advected slick noise so it
  // reads as a turbid mixing line drifting with the current. Creeks narrower than the ramp keep the exact mask. The
  // exact mask still decides the hazard colours, the rain film and the wet edge below.
  let seamJitter = ((rM.w - 0.5) * 0.7 + (slickFar - 0.5)) * 0.14;
  let riverMix = select(0.0, max(smoothstep(0.0, 0.5, nw.g + seamJitter), nw.r * (1.0 - smoothstep(0.3, 0.5, nw.g))), F.wall.w > 0.5);
  let floodMix = 1.0 - riverMix;
  // Turbidity by what one pixel covers. Close up, a few centimetres of floodwater over a street has to read as
  // WATER — kerb lines and lane markings visible through it — while from the demo's 4 km hero camera the same
  // flood has to stay an unmistakable opaque sheet against roofs and trees. A pixel up there really does average
  // several metres of chop, slick and suspended silt, so letting the extinction grow with the footprint is both
  // what the picture would do and what the judges need to read the flood at a glance.
  let farSilt = smoothstep(0.8, 4.0, pixelFoot);
  let kFlood = mix(vec3f(2.7, 3.2, 4.3), vec3f(9.0, 9.5, 10.5), farSilt);
  let kRiver = mix(vec3f(1.45, 1.75, 2.45), vec3f(2.0, 2.4, 3.1), farSilt);
  let T = exp(-mix(kRiver, kFlood, floodMix) * path);
  let tAvg = dot(T, vec3f(0.3333));
  let deep = smoothstep(0.8, 6.0, thick);
  // Advected slicks / sediment plumes: low-frequency brightness variation that makes the current visible from afar.
  // Two incommensurate scales so the tiling never lines up.
  let slick = ((rM.w - 0.5) * 0.7 + (slickFar - 0.5) * 0.9 + (rA.w - 0.5) * 0.3 * detailFade) * 0.82;
  let riverSed = mix(vec3f(0.115, 0.088, 0.054), vec3f(0.046, 0.053, 0.038), deep);
  // Slightly lighter and cooler than the imagery's khaki roofs and bare ground, so flood extent reads from far away.
  let floodSed = mix(vec3f(0.205, 0.178, 0.128), vec3f(0.140, 0.128, 0.098), smoothstep(0.5, 5.0, thick));
  let sediment = mix(riverSed, floodSed, floodMix) * (1.0 + slick * mix(0.6, 1.0, turbulence));
  let body = sediment * lightIn;
  // Thin rain sheet-flow (a few cm over grass or pavement) is not visible from the air: fade it in with depth.
  let film = mix(1.0, smoothstep(0.012, 0.06, thick), floodLand);
  var rgb = (body * (1.0 - tAvg) * (1.0 - fres) + sky * fres + spec) * film;
  var alpha = ((1.0 - tAvg) * (1.0 - fres) + fres) * film;

  // ── The ground seen through shallow water: refraction, and caustics on the bed ─────────────────────────
  // The terrain is already on screen behind this fragment and the alpha blend lets it through, so refraction
  // needs no copy of the frame: sample the photograph where the bent ray really comes from, subtract where it
  // appears to come from, and add the difference, weighted by how much light gets through. Two taps, and only
  // close up — past a metre or so per pixel there is no detail left to bend.
  if (tAvg > 0.02 && pixelFoot < 1.6 && in.skirt < 0.5) {
    let fade = 1.0 - smoothstep(0.9, 1.6, pixelFoot);
    let lod = clamp(log2(max(pixelFoot / max(mPerTexel, 0.01), 1.0)), 0.0, 12.0);
    // Snell at a nearly flat surface: the bed appears displaced by about depth × slope × (1 − 1/1.33).
    let duv = clamp(slopes * thick * 0.25, vec2f(-8.0), vec2f(8.0)) / (F.grid * F.cellSize);
    let bent = textureSampleLevel(imageryTex, linSamp, clamp(uv + duv, vec2f(0.0), vec2f(1.0)), lod).rgb;
    let flat = textureSampleLevel(imageryTex, linSamp, uv, lod).rgb;
    rgb += (bent - flat) * lightIn * 0.55 * tAvg * fade * (1.0 - fres);
    if (cine) {
      // Caustics: the surface focuses sunlight onto the bed. Two ridged bands of the advected ripple noise,
      // multiplied, give the wandering web — no extra texture and no extra tap.
      let r1 = 1.0 - abs(rA.z * 2.0 - 1.0);
      let r2 = 1.0 - abs(rB.z * 2.0 - 1.0);
      let caust = pow(clamp(r1 * r2 * 1.9, 0.0, 1.0), 3.0);
      let shallow = smoothstep(0.02, 0.10, thick) * (1.0 - smoothstep(0.2, 1.4, thick));
      rgb += F.sunColor * sunVis * caust * shallow * tAvg * fade * 0.55;
    }
  }

  // Foam / whitewater. Three sources, all of them the solver's: per-cell foam from the Froude number and the
  // surface slope (prep), the prep pass's collected-whitewater term (misc.a — the advancing front, water piling
  // against a levee or any other barrier, and converging flow), and the moving shoreline under this fragment.
  let foamNoise = rA.z * 0.55 + rB.z * 0.3 * fineFade + rM.z * 0.35;
  let shoreFoam = (1.0 - smoothstep(0.0, 0.18, thick)) * (0.25 + 0.75 * smoothstep(0.2, 1.2, speed)) * 0.7;
  let foamAmt = clamp(s.a * 0.8 + shoreFoam + misc.a * 0.8, 0.0, 0.92) * select(1.0, 0.0, in.skirt > 0.5);
  let foamMask = smoothstep(1.1 - foamAmt, 1.3 - foamAmt * 0.7, foamNoise) * foamAmt;
  let foamCol = vec3f(0.62, 0.59, 0.53) * (skyAmbient(n) * skyOcc + F.sunColor * max(dot(n, F.sunDir), 0.0) * sunVis);
  rgb = mix(rgb, foamCol, foamMask * 0.75);
  alpha = mix(alpha, 1.0, foamMask * 0.75);

  // Wet edge of the flood: a crisp pale line ~1.5–3 px inside the waterline on land that was dry before, so the
  // flood front reads at any distance. Only where the water a few pixels inland is a real flood (≥ 5 cm), not
  // rain sheet-flow; only where the land a dozen pixels outward is still dry, so the specks of roofs and yards
  // poking out of a flooded neighbourhood do not each get an outline; never along the normal river banks.
  let gl = length(thickGrad);
  let pxFromShore = thick / max(gl, 1e-6);
  if (pxFromShore < 3.6 && floodLand > 0.5 && in.skirt < 0.5) {
    let inward = select(vec2f(0.0), thickGrad / gl, gl > 1e-6);
    let stepPx = uvDx * inward.x + uvDy * inward.y;
    let hInside = textureSampleLevel(surfTex, linSamp, uv + stepPx * 5.0, 0.0).r;
    let hOutside = textureSampleLevel(surfTex, linSamp, uv - stepPx * 12.0, 0.0).r;
    let edge = smoothstep(0.6, 1.4, pxFromShore) * (1.0 - smoothstep(2.4, 3.6, pxFromShore))
             * smoothstep(0.03, 0.08, hInside) * (1.0 - smoothstep(0.005, 0.03, hOutside)) * smoothstep(0.5, 0.9, floodLand);
    let edgeCol = vec3f(0.80, 0.77, 0.68) * lightIn * 0.62;
    // Stronger from far away (beyond ~2 km), where the line is what outlines the flood against the city.
    let edgeK = mix(0.75, 0.92, smoothstep(1500.0, 3500.0, distance(in.world, F.camPos)));
    rgb = mix(rgb, edgeCol, edge * edgeK);
    alpha = mix(alpha, 1.0, edge * edgeK);
  }

  if (mode != 0) {
    // ── Hazard colormap: discrete bands (anti-aliased edges), gently lit, over the photoreal water ──────
    // Band colours arrive as HDR inputs solved on the CPU so they tone-map to exactly the legend colours.
    // Depth / max depth colour only land that was dry before the flood; the normal river stays plain water. The
    // colours fade in between 2 and 10 cm so thin rain sheet-flow does not blanket hillsides. Speed colours all
    // moving water, but the slowest band (ponding) is left as plain water so the fast cores stand out.
    let hDepth = select(s.r, misc.g, mode == 2);
    var weight = smoothstep(0.02, 0.10, hDepth);
    if (mode == 3) {
      let t0 = F.bands[0].a;
      let w0 = max(hazardFw * 0.75, 1e-4);
      weight *= smoothstep(t0 - w0, t0 + w0, misc.b);
    } else {
      weight *= smoothstep(0.35, 0.65, floodLand);
    }
    let band = hazardColor(hazardValue, hazardFw);
    let mn = normalize(vec3f(-macroSlope.x, 1.0, -macroSlope.y));
    // Relative to flat water (the lighting the band colours were solved for).
    let lit = (0.9 + 0.35 * max(dot(mn, F.sunDir), 0.0)) / (0.9 + 0.35 * max(F.sunDir.y, 0.0));
    var hz = band * lit;
    if (mode == 3) {
      // Flow-advected speckles (same two-phase flow map as the realistic mode): their motion shows direction.
      let speck = smoothstep(0.5, 0.8, mix(rA.z, rM.z, smoothstep(0.5, 3.0, pixelFoot))) * smoothstep(0.1, 0.6, speed);
      hz = mix(hz, vec3f(1.6), speck * 0.3);
    }
    hz += spec * 0.15;
    let ha = 0.97;
    rgb = mix(rgb, hz * ha, weight);
    alpha = mix(alpha, ha, weight);
    // In the depth maps the normal river is muted so the flood colours carry the picture.
    if (mode != 3) {
      let muted = (1.0 - weight) * normalWet;
      let grey = vec3f(luminance(rgb));
      rgb = mix(rgb, grey * vec3f(0.92, 0.97, 1.05), muted * 0.55);
    }
  }

  // Edge of the blow-up (see above).
  if (blown > 0.0) {
    let cellId = floor(in.grid);
    let flicker = step(0.5, fract(F.time * 7.0 + hash12(cellId) * 3.0));
    let glitch = mix(vec3f(2.8, 0.15, 1.4), vec3f(3.2, 1.6, 0.2), flicker * hash12(cellId + vec2f(7.0, 3.0)));
    rgb = mix(rgb, glitch, blown);
    alpha = mix(alpha, 1.0, blown);
  }

  alpha = clamp(alpha, 0.0, 1.0) * shore;
  // Premultiplied output + aerial perspective.
  rgb = rgb * shore;
  rgb = mix(rgb, in.haze.rgb * alpha, in.haze.a);
  return vec4f(rgb, alpha);
}
`;
