/**
 * Shared WGSL: the per-frame uniform block and lighting / atmosphere helpers used by every pass.
 * Everything is linear-light HDR; the post pass applies exposure, ACES and the output transfer.
 */

/** Byte size of the Frame uniform (must match FRAME_WGSL and writeFrameUniforms in index.ts). */
export const FRAME_UNIFORM_SIZE = 512;

export const FRAME_WGSL = /* wgsl */ `
struct Frame {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  camPos: vec3f,
  time: f32,
  sunDir: vec3f,
  exag: f32,
  sunColor: vec3f,
  cellSize: f32,
  skyZenith: vec3f,
  rainRate: f32,
  skyHorizon: vec3f,
  hazeDensity: f32,
  grid: vec2f,        // nx, ny
  mesh: vec2f,        // vertices per row / column
  viewport: vec2f,    // physical pixels
  stride: f32,
  waterMode: f32,     // 0 realistic, 1 depth, 2 maxDepth, 3 velocity
  elev: vec4f,        // minElev, maxElev, skirt base elevation, pixelScale (world size of 1px at distance 1)
  opts: vec4f,        // imagery on, contours on, contour interval (m), overcast 0..1
  camFwd: vec3f,
  near: f32,
  bandCount: f32,
  domainSize: f32,
  flowVis: f32,       // on-screen exaggeration of flow advection (scales with camera distance)
  rainBox: f32,       // rain particle box size (m)
  wall: vec4f,        // x: any walls (wallTex valid), y: wall field range (cells), z: wall crest elevation origin (m), w: normal-water mask valid
  bands: array<vec4f, 8>, // rgb (HDR input that tone-maps to the legend colour) + upper threshold in .a
  protect: vec4f,     // x: protected-land glow 0..1 (protectTex valid when > 0), y: 1 = roofTex is a real building-height raster, zw: unused
  sunTint: vec3f,     // horizon radiance around the sun's azimuth (the warm band of a low sun)
  skyWarmth: f32,     // 0 with the sun high, 1 with it on the horizon: how far that band is pushed
  light: vec4f,       // shadow strength, sky-occlusion strength, relief strength, 1 = sun raster is built
  shade: vec4f,       // PCF radius (cells), detail-normal strength, ground-bounce strength, imagery relight
}
`;

export const COMMON_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265;

fn gridToWorld(g: vec2f, elevation: f32) -> vec3f {
  return vec3f((g.x - F.grid.x * 0.5) * F.cellSize, elevation * F.exag, (g.y - F.grid.y * 0.5) * F.cellSize);
}

fn worldToGrid(p: vec3f) -> vec2f {
  return vec2f(p.x / F.cellSize + F.grid.x * 0.5, p.z / F.cellSize + F.grid.y * 0.5);
}

fn hash12(p: vec2f) -> f32 {
  var p3 = fract(vec3f(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

fn hash11(x: f32) -> f32 {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}

fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hash12(i);
  let b = hash12(i + vec2f(1.0, 0.0));
  let c = hash12(i + vec2f(0.0, 1.0));
  let d = hash12(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

/**
 * The horizon is not one colour. With the sun high it very nearly is, and this returns F.skyHorizon; as the sun
 * drops, the air along the line of sight toward it is lit end-on and turns amber (F.sunTint, which carries the
 * same Rayleigh + aerosol extinction as the sun's own beam — see skyColors in atmosphere.ts), while the horizon
 * behind the viewer keeps the cool blue-grey of the earth's rising shadow. The band tightens around the sun's
 * azimuth and falls away with altitude, which is what makes a low sun read as a direction rather than a filter.
 */
fn horizonColor(dir: vec3f) -> vec3f {
  if (F.skyWarmth < 0.002) { return F.skyHorizon; }
  let a = normalize(vec2f(dir.x, dir.z) + vec2f(1e-5, 0.0));
  let b = normalize(vec2f(F.sunDir.x, F.sunDir.z) + vec2f(1e-5, 0.0));
  let toward = max(dot(a, b), 0.0);
  // A wide arc, not a spotlight: at sunset the warm half of the sky is genuinely half the sky, and the far horizon
  // keeps a little of it too (0.18) because the air in between is lit from behind.
  let band = (0.18 + 0.82 * pow(toward, 1.4)) * exp(-abs(dir.y) * 2.1);
  return mix(F.skyHorizon, F.sunTint, band * F.skyWarmth);
}

/** Sky radiance along a direction, without the sun disk. */
fn skyRadiance(dirIn: vec3f) -> vec3f {
  let dir = normalize(dirIn);
  let overcast = F.opts.w;
  let y = dir.y;
  let up = clamp(y, 0.0, 1.0);
  let horizon = horizonColor(dir);
  var col = mix(horizon, F.skyZenith, pow(up, 0.45));
  // Brighter, whiter band right at the horizon (aerosols).
  col = mix(col, horizon * 1.12 + vec3f(0.04), exp(-abs(y) * 14.0) * 0.6);
  // Below the horizon: a studio-like backdrop, hazy near the horizon and deepening downward, so the diorama floats
  // in atmosphere without a hard edge.
  let below = smoothstep(0.0, -0.08, y);
  let backdrop = mix(horizon * vec3f(0.84, 0.88, 0.93), F.skyZenith * 0.28 + vec3f(0.035, 0.04, 0.048), smoothstep(-0.02, -0.75, y));
  col = mix(col, backdrop, below);
  // Sun glow (Mie-like forward scattering). A low sun looks at us through more air, so its aureole is wider.
  let mu = max(dot(dir, F.sunDir), 0.0);
  let spread = mix(8.0, 3.0, F.skyWarmth);
  let glow = pow(mu, spread) * (0.22 + 0.5 * F.skyWarmth) + pow(mu, 64.0) * 0.5;
  col += F.sunColor * glow * (1.0 - overcast * 0.85);
  // Overcast storm sky: desaturate + darken.
  let grey = vec3f(luminance(col));
  col = mix(col, grey * vec3f(0.62, 0.66, 0.72), overcast * 0.9);
  return col;
}

/**
 * Two cloud decks on the sky dome, projected onto a flat layer (dir.xz / dir.y), so they converge toward the
 * horizon the way a real cloud deck does.
 *
 * The part that sells them is not the noise, it is that they are *shaded*: the density field's own gradient stands
 * in for a surface normal, so a deck lit from one side shows bright flanks toward the sun and grey ones away from
 * it — and because the gradient is measured along the sun's horizontal direction, the light on the clouds swings
 * round with the light on the ground. The thin cirrus above moves at a different rate, which gives the sky depth
 * without another octave of noise.
 */
fn cloudDensity(p: vec2f) -> f32 {
  return vnoise(p) * 0.55 + vnoise(p * 2.3 + 7.1) * 0.3 + vnoise(p * 5.3 + 3.7) * 0.15;
}

fn cloudLayer(dir: vec3f, col: vec3f) -> vec3f {
  if (dir.y <= 0.0) { return col; }
  let sunH = normalize(vec2f(F.sunDir.x, F.sunDir.z) + vec2f(1e-5, 0.0));
  let lum = luminance(F.skyHorizon);
  let lit = mix(vec3f(1.0, 0.98, 0.95), normalize(F.sunColor + vec3f(1e-4)) * 1.7, F.skyWarmth * 0.85);
  var out = col;

  // ── Cumulus deck ──
  let cp = dir.xz / (dir.y + 0.15) * 1.3 + vec2f(F.time * 0.003, F.time * 0.001);
  let c = cloudDensity(cp);
  let cover = mix(0.54, 0.3, F.opts.w);
  let cloud = smoothstep(cover, cover + 0.26, c) * smoothstep(0.0, 0.2, dir.y);
  // Slope of the density field toward the sun: positive on the flank turned into the light.
  let g = (cloudDensity(cp + sunH * 0.22) - cloudDensity(cp - sunH * 0.22)) * 2.4;
  let shade = clamp(0.5 + g, 0.12, 1.35);
  let base = mix(vec3f(0.40, 0.43, 0.49), vec3f(0.30, 0.31, 0.36), F.skyWarmth);
  let body = mix(base * lum * 1.15, lit * lum * 1.7, clamp(shade, 0.0, 1.0));
  let cloudCol = mix(body, vec3f(0.42, 0.44, 0.48) * lum, F.opts.w);
  out = mix(out, cloudCol, cloud * 0.74);

  // ── Cirrus, higher and thinner, drifting the other way ──
  if (F.opts.w < 0.55) {
    let fp = dir.xz / (dir.y + 0.06) * 0.42 + vec2f(F.time * -0.0016, F.time * 0.0009);
    let f = vnoise(fp * vec2f(0.6, 2.6)) * 0.6 + vnoise(fp * vec2f(1.7, 6.0) + 19.0) * 0.4;
    let veil = smoothstep(0.58, 0.86, f) * smoothstep(0.02, 0.3, dir.y) * (1.0 - F.opts.w / 0.55);
    out = mix(out, lit * lum * 1.9, veil * 0.3);
  }
  return out;
}

/** What calm water reflects: sky + clouds (no sun disk; the specular lobe handles the sun). */
fn skyReflection(dir: vec3f) -> vec3f {
  return cloudLayer(dir, skyRadiance(dir));
}

fn sunDisk(dir: vec3f) -> vec3f {
  let mu = dot(normalize(dir), F.sunDir);
  // Refraction flattens and swells a setting sun; the edge also softens as the air in front of it thickens.
  let soft = mix(0.00008, 0.0009, F.skyWarmth);
  let disk = smoothstep(0.99993 - soft, 0.99993, mu);
  return F.sunColor * disk * mix(60.0, 26.0, F.skyWarmth) * (1.0 - F.opts.w);
}

/**
 * Aerial perspective with an exponential atmosphere: haze density falls off as exp(−h/H) above the lowest terrain,
 * integrated analytically along the view ray. Looking straight down through thin air stays crisp, while long
 * low-angle views across valleys pick up realistic haze.
 */
fn hazeAmount(worldPos: vec3f) -> f32 {
  let dist = length(worldPos - F.camPos);
  let H = max(F.domainSize * 0.16, 250.0);
  let y0 = F.elev.x * F.exag;
  let hc = max(F.camPos.y - y0, 0.0) / H;
  let hp = max(worldPos.y - y0, 0.0) / H;
  let dh = hc - hp;
  var rho = exp(-hp);
  if (abs(dh) > 1e-3) {
    rho = (exp(-hp) - exp(-hc)) / dh;
  }
  return clamp(1.0 - exp(-dist * rho * F.hazeDensity), 0.0, 1.0);
}

/**
 * Ambient light for a surface normal: the cool sky dome above, the warm bounce off the surrounding ground below.
 * Keeping the two apart is most of what separates "lit" from "brightened" — an upward face picks up zenith blue
 * while a slope facing down-valley picks up the sun's colour off the land, so the two sides of a ridge differ in
 * hue and not only in brightness.
 */
fn skyAmbient(n: vec3f) -> vec3f {
  let t = n.y * 0.5 + 0.5;
  let bounce = mix(vec3f(0.30, 0.27, 0.22), normalize(F.sunColor + vec3f(1e-4)) * 0.44, F.shade.z);
  let ground = bounce * luminance(F.skyHorizon);
  // With the sun low, most of the dome's light comes from the warm band near the horizon, not from the zenith, so
  // the shadows it fills read as cool-but-not-blue rather than as a separate blue light source.
  let dome = mix(mix(F.skyHorizon, F.skyZenith, 0.55), F.sunTint * 0.5, F.shade.z * 0.45);
  return mix(ground, dome, t);
}

/** Pull a clip-space position slightly toward the camera along the view ray (no screen-space shift). */
fn pullForward(clip: vec4f, fraction: f32) -> vec4f {
  // Reversed-Z: depth = near / distance. Scaling distance by (1 - f) ≈ scaling depth by 1 / (1 - f).
  return vec4f(clip.xy, clip.z / (1.0 - fraction), clip.w);
}
`;

/**
 * CDLOD patch vertex (see lod.ts). Each node instance draws a PATCH×PATCH grid; vertex (k, l) sits at
 * origin + (k, l)·q cells and morphs toward the parent grid (odd indices slide onto even ones) as the camera
 * distance goes from morphStart to morphEnd. Heights are blended between the two base-grid samples, so at
 * m = 1 the patch is exactly the parent-level mesh and neighbouring levels meet without cracks.
 */
export const LOD_WGSL = /* wgsl */ `
const PATCH: u32 = 32u;

struct NodeIn {
  @location(0) node: vec4f,    // origin gx, origin gy, quad size (cells), level
  @location(1) morph: vec4f,   // morphStart, morphEnd (world m), 0, 0
}

struct LodVertex {
  g: vec2f,          // morphed grid position
  g0: vec2f,         // unmorphed grid position (clamped to the domain)
  gp: vec2f,         // parent-grid position the vertex morphs toward
  a: vec4f,          // base-grid texel at g0
  b: vec4f,          // base-grid texel at the parent-grid position
  m: f32,            // morph factor
}

fn vtxAtGrid(g: vec2f) -> vec4f {
  let m = vec2i(F.mesh);
  let t = clamp(vec2i(round(g / F.stride)), vec2i(0), m - 1);
  return textureLoad(vtxTex, t, 0);
}

fn lodVertex(vi: u32, n: NodeIn) -> LodVertex {
  let side = PATCH + 1u;
  let kl = vec2f(f32(vi % side), f32(vi / side));
  let q = n.node.z;
  let g0 = min(n.node.xy + kl * q, F.grid);
  let odd = fract(kl * 0.5) * 2.0;
  let gp = min(n.node.xy + (kl - odd) * q, F.grid);
  var o: LodVertex;
  o.g0 = g0;
  o.gp = gp;
  o.a = vtxAtGrid(g0);
  o.b = vtxAtGrid(gp);
  let w0 = gridToWorld(g0, o.a.r);
  let d = distance(w0, F.camPos);
  o.m = clamp((d - n.morph.x) / max(n.morph.y - n.morph.x, 1e-3), 0.0, 1.0);
  o.g = mix(g0, gp, o.m);
  return o;
}

/** Per-vertex aerial perspective (haze varies slowly across the screen, so interpolation is exact enough). */
fn vertexHaze(world: vec3f) -> vec4f {
  let v = world - F.camPos;
  let dir = v / max(length(v), 1e-3);
  let col = skyRadiance(vec3f(dir.x, max(dir.y, 0.0) * 0.35 + 0.02, dir.z));
  return vec4f(col, hazeAmount(world));
}
`;

/** Manual bilinear sampling of the per-vertex texture (r = bed, g = water surface, a = wet flag). */
export const VTX_SAMPLE_WGSL = /* wgsl */ `
fn vtxLoad(k: i32, l: i32) -> vec4f {
  let m = vec2i(F.mesh);
  return textureLoad(vtxTex, vec2i(clamp(k, 0, m.x - 1), clamp(l, 0, m.y - 1)), 0);
}

/** Bilinear over mesh vertices at grid coords. Returns (bed, surface, hAvg, wet). */
fn vtxBilinear(g: vec2f) -> vec4f {
  let f = clamp(g / F.stride, vec2f(0.0), F.mesh - 1.0);
  let k = min(floor(f), F.mesh - 2.0);
  let t = f - k;
  let ki = vec2i(k);
  let a = vtxLoad(ki.x, ki.y);
  let b = vtxLoad(ki.x + 1, ki.y);
  let c = vtxLoad(ki.x, ki.y + 1);
  let d = vtxLoad(ki.x + 1, ki.y + 1);
  // Same triangle split as the mesh so draped geometry hugs the rendered surface.
  if (t.x + t.y <= 1.0) {
    return a + (b - a) * t.x + (c - a) * t.y;
  }
  return d + (c - d) * (1.0 - t.x) + (b - d) * (1.0 - t.y);
}
`;

/**
 * Walls from the wall distance field (see wallField.ts). Needs wallTex and linSamp bindings. Walls are drawn
 * with a screen-space minimum width: crest, sloping faces and a dark casing never get thinner than a few pixels.
 */
export const WALL_WGSL = /* wgsl */ `
const WALL_MIN_H: f32 = 0.04;

struct WallHit {
  d: f32,       // distance (m) from the nearest wall cell centre
  h: f32,       // that wall's height (m)
  crest: f32,   // its crest elevation (m)
}

/** Cheap pre-test (one tap): is any wall within the field's range of this point? */
fn wallNear(uv: vec2f) -> bool {
  return F.wall.x > 0.5 && textureSampleLevel(wallTex, linSamp, uv, 0.0).r > 0.0;
}

fn wallAt(uv: vec2f) -> WallHit {
  // Four bilinear taps half a cell apart (a 2×2-cell tent): the field measures distance to wall CELL centres, whose
  // contours are stair-stepped along diagonal walls; the small blur rounds them into a smooth outline.
  let e = 0.5 / F.grid;
  let w = 0.25 * (textureSampleLevel(wallTex, linSamp, uv + vec2f(e.x, e.y), 0.0) + textureSampleLevel(wallTex, linSamp, uv + vec2f(-e.x, e.y), 0.0)
                + textureSampleLevel(wallTex, linSamp, uv + vec2f(e.x, -e.y), 0.0) + textureSampleLevel(wallTex, linSamp, uv - e, 0.0));
  var o: WallHit;
  // The blur lifts the distance on the centre line by ~0.35 cells; take that back so the crest keeps its width.
  o.d = max((1.0 - w.r) * F.wall.y - 0.35, 0.0) * F.cellSize;
  o.h = w.g;
  o.crest = w.b + F.wall.z;
  return o;
}

/** Profile edges (m from the wall centre line) at a fragment whose CSS pixel covers pxM metres. */
struct WallProfile {
  crest: f32,    // end of the flat crest
  face: f32,     // end of the sloping faces
  casing: f32,   // end of the dark outline
}

fn wallProfile(pxM: f32) -> WallProfile {
  var o: WallProfile;
  o.crest = max(0.5 * F.cellSize, 1.25 * pxM);
  o.face = o.crest + max(0.8 * F.stride * F.cellSize, 1.0 * pxM);
  o.casing = o.face + max(0.18 * F.cellSize, 0.85 * pxM);
  return o;
}
`;

/**
 * Reading the sun-shading raster (src/render/shadows.ts). Needs a `sunTex` binding and `linSamp`.
 *
 * The raster already carries a real penumbra — its width comes from the sun's angular size and the distance of the
 * blocker — so nothing here is trying to invent softness. The taps exist for two other reasons: to hide the DEM's
 * own cell grid when the camera is close enough to see it, and to stop far terrain from sparkling, where one
 * screen pixel covers many cells and a single bilinear tap would alias. Both are handled by one radius that
 * follows the fragment's footprint.
 */
export const SUN_SHADING_WGSL = /* wgsl */ `
fn sunShadingRaw(uv: vec2f) -> vec2f {
  return textureSampleLevel(sunTex, linSamp, clamp(uv, vec2f(0.0), vec2f(1.0)), 0.0).rg;
}

/** (sun visibility, open-sky fraction) at grid uv. pxCells = grid cells covered by one screen pixel here. */
fn sunShading(uv: vec2f, pxCells: f32) -> vec2f {
  if (F.light.w < 0.5) { return vec2f(1.0, 1.0); }
  let r = max(F.shade.x, min(pxCells * 0.6, 4.0));
  if (r <= 0.02) { return sunShadingRaw(uv); }
  // Rotated cross: isotropic at a quarter of a box filter's taps.
  let e = r * 0.7 / F.grid;
  let a = sunShadingRaw(uv + vec2f(e.x, e.y));
  let b = sunShadingRaw(uv + vec2f(-e.x, e.y));
  let c = sunShadingRaw(uv + vec2f(e.x, -e.y));
  let d = sunShadingRaw(uv - vec2f(e.x, e.y));
  return (a + b + c + d) * 0.25;
}
`;

/**
 * High-frequency ground relief for terrain that has no photograph over it (the hypsometric tint). One octave of
 * value noise in world metres, as a slope (∂h/∂x, ∂h/∂z) for the caller to bend the shading normal with; the
 * second octave is only worth its registers in the cinematic tier. Where imagery *is* available the terrain
 * shader uses the photo's own luminance gradient instead, which is both cheaper and real.
 */
export const DETAIL_NORMAL_WGSL = /* wgsl */ `
fn detailSlope(worldXZ: vec2f, fine: bool) -> vec2f {
  // Forward differences, not central: half the taps for the same slope, and the half-texel phase shift is
  // meaningless in noise.
  let e = 0.6;
  let p = worldXZ * 0.14;   // ≈ 7 m features
  let c = vnoise(p);
  var g = vec2f(vnoise(p + vec2f(e, 0.0)) - c, vnoise(p + vec2f(0.0, e)) - c);
  if (fine) {
    let q = worldXZ * 0.52; // ≈ 2 m features
    let c2 = vnoise(q);
    g += vec2f(vnoise(q + vec2f(e, 0.0)) - c2, vnoise(q + vec2f(0.0, e)) - c2) * 0.45;
  }
  return g * 2.4;
}
`;
