/**
 * Shared WGSL: the per-frame uniform block and lighting / atmosphere helpers used by every pass.
 * Everything is linear-light HDR; the post pass applies exposure, ACES and the output transfer.
 */

/** Byte size of the Frame uniform (must match FRAME_WGSL and writeFrameUniforms in index.ts). */
export const FRAME_UNIFORM_SIZE = 432;

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
  bands: array<vec4f, 8>, // rgb (linear) + upper threshold in .a
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

/** Sky radiance along a direction, without the sun disk. */
fn skyRadiance(dirIn: vec3f) -> vec3f {
  let dir = normalize(dirIn);
  let overcast = F.opts.w;
  let y = dir.y;
  let up = clamp(y, 0.0, 1.0);
  var col = mix(F.skyHorizon, F.skyZenith, pow(up, 0.45));
  // Brighter, whiter band right at the horizon (aerosols).
  col = mix(col, F.skyHorizon * 1.12 + vec3f(0.04), exp(-abs(y) * 14.0) * 0.6);
  // Below the horizon: a studio-like backdrop, hazy near the horizon and deepening downward, so the diorama floats
  // in atmosphere without a hard edge.
  let below = smoothstep(0.0, -0.08, y);
  let backdrop = mix(F.skyHorizon * vec3f(0.84, 0.88, 0.93), F.skyZenith * 0.28 + vec3f(0.035, 0.04, 0.048), smoothstep(-0.02, -0.75, y));
  col = mix(col, backdrop, below);
  // Sun glow (Mie-like forward scattering).
  let mu = max(dot(dir, F.sunDir), 0.0);
  let glow = pow(mu, 8.0) * 0.22 + pow(mu, 64.0) * 0.5;
  col += F.sunColor * glow * (1.0 - overcast * 0.85);
  // Overcast storm sky: desaturate + darken.
  let grey = vec3f(luminance(col));
  col = mix(col, grey * vec3f(0.62, 0.66, 0.72), overcast * 0.9);
  return col;
}

/** Soft high cloud layer (upper hemisphere only). */
fn cloudLayer(dir: vec3f, col: vec3f) -> vec3f {
  if (dir.y <= 0.0) { return col; }
  let cp = dir.xz / (dir.y + 0.15) * 1.3 + vec2f(F.time * 0.003, F.time * 0.001);
  let c = vnoise(cp) * 0.55 + vnoise(cp * 2.3 + 7.1) * 0.3 + vnoise(cp * 5.3 + 3.7) * 0.15;
  let cover = mix(0.56, 0.3, F.opts.w);
  let cloud = smoothstep(cover, cover + 0.3, c) * smoothstep(0.0, 0.2, dir.y);
  let lum = luminance(F.skyHorizon);
  let cloudCol = mix(vec3f(1.0, 0.98, 0.95) * lum * 1.45, vec3f(0.42, 0.44, 0.48) * lum, F.opts.w);
  return mix(col, cloudCol, cloud * 0.7);
}

/** What calm water reflects: sky + clouds (no sun disk; the specular lobe handles the sun). */
fn skyReflection(dir: vec3f) -> vec3f {
  return cloudLayer(dir, skyRadiance(dir));
}

fn sunDisk(dir: vec3f) -> vec3f {
  let mu = dot(normalize(dir), F.sunDir);
  let disk = smoothstep(0.99985, 0.99993, mu);
  return F.sunColor * disk * 60.0 * (1.0 - F.opts.w);
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

/** Ambient sky light for a surface normal (hemisphere approximation). */
fn skyAmbient(n: vec3f) -> vec3f {
  let t = n.y * 0.5 + 0.5;
  let ground = vec3f(0.30, 0.27, 0.22) * luminance(F.skyHorizon);
  return mix(ground, mix(F.skyHorizon, F.skyZenith, 0.55), t);
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
