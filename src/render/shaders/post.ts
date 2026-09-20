/** Sky, the post chain (bloom, depth of field, tonemap + grade), rain streaks and mip generation shaders. */
import { COMMON_WGSL, FRAME_WGSL } from './common';
import {
  ACES_IN,
  ACES_OUT,
  BLOOM_KNEE,
  BLOOM_MIX,
  BLOOM_THRESHOLD,
  CROSSTALK,
  CROSSTALK_HI,
  CROSSTALK_LO,
  GRADE_CONTRAST,
  GRADE_GAIN,
  GRADE_GAMMA,
  GRADE_PIVOT,
  POST_SATURATION,
  VIGNETTE_INNER,
  VIGNETTE_OUTER,
} from '../tonemap';

const wgslF = (x: number) => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const mat3 = (m: readonly number[]) =>
  `mat3x3f(vec3f(${m.slice(0, 3).map(wgslF).join(', ')}), vec3f(${m.slice(3, 6).map(wgslF).join(', ')}), vec3f(${m.slice(6, 9).map(wgslF).join(', ')}))`;

const FULLSCREEN_VS = /* wgsl */ `
struct FsOut {
  @builtin(position) pos: vec4f,
  @location(0) ndc: vec2f,
}
@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> FsOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u)) * 2.0 - 1.0;
  var o: FsOut;
  o.pos = vec4f(p, 0.0, 1.0);
  o.ndc = p;
  return o;
}
`;

export const SKY_WGSL = /* wgsl */ `
${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
${COMMON_WGSL}
${FULLSCREEN_VS}
@fragment
fn fsSky(in: FsOut) -> @location(0) vec4f {
  let p = F.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let dir = normalize(p.xyz / p.w - F.camPos);
  let col = cloudLayer(dir, skyRadiance(dir)) + sunDisk(dir);
  return vec4f(col, 1.0);
}
`;


const vec3 = (v: readonly number[]) => `vec3f(${v.map(wgslF).join(', ')})`;

/**
 * Depth-of-field sampling disc: a fixed 22-tap golden-angle (Vogel) spiral over the unit disc, baked into the
 * shader as constants. Fixed on purpose — a rotated or noise-jittered kernel is the usual way to hide a low tap
 * count, and it would make every frame differ from the last, which the visual suite's flicker detector reads as a
 * rendering glitch (scripts/visual.mjs). A Vogel spiral needs no jitter: its taps are already near-uniform.
 */
export const DOF_TAPS = 22;
const dofDisc = () => {
  const out: string[] = [];
  for (let i = 0; i < DOF_TAPS; i++) {
    const fi = i + 0.5;
    const a = fi * 2.39996322972865332;
    const r = Math.sqrt(fi / DOF_TAPS);
    out.push(`vec2f(${(Math.cos(a) * r).toFixed(5)}, ${(Math.sin(a) * r).toFixed(5)})`);
  }
  return `array<vec2f, ${DOF_TAPS}>(${out.join(', ')})`;
};

/** Sharp band around the focus distance, as a fraction of it, before the circle of confusion starts to open. */
export const DOF_DEADBAND = 0.1;

/**
 * Lens radius (0 centre, 1 corner) at which chromatic aberration starts. Deliberately far out: the point of the
 * effect is that the corners of the frame feel like glass, and anything a judge has to READ lives well inside it.
 */
export const CA_ONSET = 0.86;

export const TONEMAP_WGSL = /* wgsl */ `
struct Post {
  exposure: f32,
  srgbOut: f32,     // 1 → apply the sRGB OETF in-shader (non-sRGB canvas format)
  vignette: f32,    // strength at the corner (0 = off)
  bloom: f32,       // bloom strength (0 when the bloom passes are skipped)
  ca: f32,          // chromatic aberration, pixels of channel separation at the corner (0 = off)
  dofRadius: f32,   // max circle of confusion, render pixels (0 = depth of field off)
  focusZ: f32,      // view-space distance the lens is focused on (m) — the camera's orbit target
  dofSpread: f32,   // relative distance over which the CoC opens from the deadband to dofRadius
  aspect: f32,      // viewport width / height, so the vignette is a lens circle and not a stretched ellipse
  near: f32,        // reversed-Z infinite projection: viewDistance = near / ndcDepth
  pad0: f32,
  pad1: f32,
}
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var linSamp: sampler;
@group(0) @binding(4) var depthTex: texture_depth_multisampled_2d;
${FULLSCREEN_VS}

// ── tone curve ────────────────────────────────────────────────────────────────────────────────
// ACES filmic (Stephen Hill fit, with input/output matrices).
fn rrtOdt(v: vec3f) -> vec3f {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
// Matrices, grade and the saturation restore come from tonemap.ts, whose CPU mirror (postProcess) solves hazard
// colours against this exact chain. Change a number there, not here.
fn aces(c: vec3f) -> vec3f {
  let inM = ${mat3(ACES_IN)};
  let outM = ${mat3(ACES_OUT)};
  return clamp(outM * rrtOdt(inM * c), vec3f(0.0), vec3f(1.0));
}
/**
 * Highlight crosstalk + log-pivot contrast, on exposure-scaled scene light (the CPU mirror is tonemap.ts grade).
 * Crosstalk starts at the bloom threshold, which at normal exposures is above anything a hazard colour reaches;
 * where a bright overcast does push one into it, hazardInput solves at that same exposure and cancels it out.
 */
fn grade(x: vec3f) -> vec3f {
  let peak = max(x.r, max(x.g, x.b));
  let k = ${wgslF(CROSSTALK)} * smoothstep(${wgslF(CROSSTALK_LO)}, ${wgslF(CROSSTALK_HI)}, peak);
  let v = mix(x, vec3f(peak), k);
  let pivot = ${wgslF(GRADE_PIVOT)};
  return pivot * pow(max(v, vec3f(1e-6)) / pivot, vec3f(${wgslF(GRADE_CONTRAST)}));
}
fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
// Interleaved gradient noise: a per-pixel function of position only, so a paused frame renders identically every
// time (the visual suite compares repeat captures of a frozen scene).
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

// ── depth of field ────────────────────────────────────────────────────────────────────────────
// Depth comes from the main pass's multisampled depth buffer, sample 0 — no extra pass and no G-buffer. It is only
// stored (and bound) while depth of field is on; otherwise the attachment stays discard-on-store.
fn viewDist(px: vec2i) -> f32 {
  let d = textureLoad(depthTex, px, 0);
  return select(1e9, P.near / d, d > 1e-9);
}
/**
 * Circle of confusion, in render pixels. A real lens at these distances (kilometres) has essentially infinite
 * depth of field, so this is deliberately NOT a thin-lens model: the CoC opens with distance measured RELATIVE to
 * the focus distance, which is the tilt-shift/miniature look — and the scene really is a diorama of a river basin.
 * Being scale-relative also means one setting works from a 700 m close-up to a 9 km establishing shot.
 */
fn cocPx(z: f32) -> f32 {
  let rel = abs(z - P.focusZ) / max(P.focusZ, 1e-3);
  let t = clamp((rel - ${wgslF(DOF_DEADBAND)}) / max(P.dofSpread, 1e-3), 0.0, 1.0);
  return P.dofRadius * t * t * (3.0 - 2.0 * t);
}

/** Scene colour at a pixel: a plain fetch, or a depth-weighted disc gather when depth of field is on. */
fn scene(px: vec2i, size: vec2i) -> vec3f {
  let centre = textureLoad(hdrTex, clamp(px, vec2i(0), size - 1), 0).rgb;
  if (P.dofRadius <= 0.0) { return centre; }
  let r0 = cocPx(viewDist(clamp(px, vec2i(0), size - 1)));
  if (r0 < 0.75) { return centre; }
  let disc = ${dofDisc()};
  var acc = centre;
  var wsum = 1.0;
  for (var i = 0; i < ${DOF_TAPS}; i++) {
    let o = disc[i] * r0;
    let sp = clamp(px + vec2i(round(o)), vec2i(0), size - 1);
    // A sample only reaches this pixel if its OWN circle of confusion is at least as wide as the gap. That is what
    // stops a sharp foreground from smearing over the blurred hills behind it (while a blurred foreground still
    // correctly spills over a sharp background).
    let w = clamp((cocPx(viewDist(sp)) - length(o)) * 0.5 + 1.0, 0.0, 1.0);
    acc += textureLoad(hdrTex, sp, 0).rgb * w;
    wsum += w;
  }
  return acc / wsum;
}

@fragment
fn fsTonemap(in: FsOut) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(hdrTex));
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  let px = vec2i(uv * vec2f(size));

  // Lens radius: 0 at the centre, 1 at a corner, measured on a circle in sensor space (so on a 16:10 frame the
  // short edges stay clean and the corners do the work — what a real lens does).
  let d = (uv - 0.5) * vec2f(P.aspect, 1.0);
  let r = length(d) / (0.5 * sqrt(P.aspect * P.aspect + 1.0));

  var hdr = scene(px, size);
  // Chromatic aberration, confined to the outer edge of the frame: the red and blue channels are resolved a
  // fraction of a pixel further out / further in along the lens radius. It never reaches the readable centre.
  if (P.ca > 0.0) {
    let caPx = P.ca * smoothstep(${wgslF(CA_ONSET)}, 1.0, r);
    if (caPx >= 0.5) {
      let dir = normalize(select(vec2f(1.0, 0.0), uv - 0.5, length(uv - 0.5) > 1e-6));
      let o = vec2i(round(dir * caPx));
      hdr.r = scene(px + o, size).r;
      hdr.b = scene(px - o, size).b;
    }
  }
  hdr += textureSampleLevel(bloomTex, linSamp, uv, 0.0).rgb * ${wgslF(BLOOM_MIX)} * P.bloom;
  // Guard against NaN/inf from any pass.
  if (!(dot(hdr, vec3f(1.0)) < 1e7)) { hdr = vec3f(0.0); }

  var c = aces(grade(max(hdr, vec3f(0.0)) * P.exposure));
  // ACES desaturates midtones; restore a touch of colour.
  c = clamp(mix(vec3f(dot(c, vec3f(0.2126, 0.7152, 0.0722))), c, ${wgslF(POST_SATURATION)}), vec3f(0.0), vec3f(1.0));
  // Split tone: cool shadows, warm highlights, at a few parts in 255. The ground is real aerial photography.
  c = clamp(pow(c, ${vec3(GRADE_GAMMA)}) * ${vec3(GRADE_GAIN)}, vec3f(0.0), vec3f(1.0));

  c *= 1.0 - P.vignette * smoothstep(${wgslF(VIGNETTE_INNER)}, ${wgslF(VIGNETTE_OUTER)}, r);
  if (P.srgbOut > 0.5) { c = toSrgb(c); }
  // Dither to kill 8-bit banding in the sky gradient.
  c += (ign(in.pos.xy) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;

/**
 * Bloom, as a mip chain rather than one blur at a fixed radius.
 *
 * mode 0  bright pass + downsample of the HDR frame into mip 0 (quarter resolution)
 * mode 1  plain downsample, mip k-1 → mip k
 * mode 2  tent upsample, mip k+1 → mip k, ADDITIVELY (pipeline `bloomUp`)
 *
 * Why a chain: a single small-radius blur cannot produce a wide, soft glow, and widening its taps makes it ring.
 * Summing octaves gives a falloff that is wide AND smooth for about the same cost, because every level after the
 * first is a quarter of the pixels of the one before it.
 *
 * Why the knee: the bright pass SUBTRACTS the threshold (with a C1 quadratic ramp over BLOOM_KNEE above it)
 * instead of masking. A mask lets every surface just over the line contribute its full colour, and that step is
 * exactly what blurs into a halo ring around bright areas. Subtracting means the contribution grows from zero, so
 * there is no edge to smear. It is also strictly zero at or below the threshold, which is the contract hazard
 * colours rely on (HAZARD_MAX_PEAK < BLOOM_THRESHOLD, tests/render/tonemap.test.ts).
 */
export const BLOOM_WGSL = /* wgsl */ `
struct Blur {
  threshold: f32,
  knee: f32,
  mode: f32,
  radius: f32,  // upsample tent radius, in source texels
}
@group(0) @binding(0) var<uniform> B: Blur;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var linSamp: sampler;
${FULLSCREEN_VS}

fn tap(uv: vec2f, o: vec2f, texel: vec2f) -> vec3f {
  return textureSampleLevel(srcTex, linSamp, uv + o * texel, 0.0).rgb;
}
fn karis(c: vec3f) -> f32 {
  // Weight a group by the inverse of its brightness, so one runaway pixel cannot dominate an octave and pump a
  // flickering halo. Deterministic (no temporal term), so a frozen frame still renders identically.
  return 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722)));
}

@fragment
fn fsBloom(in: FsOut) -> @location(0) vec4f {
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  let texel = 1.0 / vec2f(textureDimensions(srcTex));
  if (B.mode > 1.5) {
    // 3x3 tent upsample (1 2 1 / 2 4 2 / 1 2 1) / 16.
    let e = B.radius;
    var c = tap(uv, vec2f(0.0, 0.0), texel) * 4.0;
    c += (tap(uv, vec2f(-e, 0.0), texel) + tap(uv, vec2f(e, 0.0), texel) + tap(uv, vec2f(0.0, -e), texel) + tap(uv, vec2f(0.0, e), texel)) * 2.0;
    c += tap(uv, vec2f(-e, -e), texel) + tap(uv, vec2f(e, -e), texel) + tap(uv, vec2f(-e, e), texel) + tap(uv, vec2f(e, e), texel);
    return vec4f(c / 16.0, 1.0);
  }
  // 13-tap downsample (Jimenez / Call of Duty): a proper low-pass, so the chain does not alias bright detail into
  // a crawling glow.
  let a = tap(uv, vec2f(-2.0, 2.0), texel);
  let b = tap(uv, vec2f(0.0, 2.0), texel);
  let c0 = tap(uv, vec2f(2.0, 2.0), texel);
  let dd = tap(uv, vec2f(-2.0, 0.0), texel);
  let e0 = tap(uv, vec2f(0.0, 0.0), texel);
  let f = tap(uv, vec2f(2.0, 0.0), texel);
  let g = tap(uv, vec2f(-2.0, -2.0), texel);
  let h = tap(uv, vec2f(0.0, -2.0), texel);
  let i = tap(uv, vec2f(2.0, -2.0), texel);
  let j = tap(uv, vec2f(-1.0, 1.0), texel);
  let k = tap(uv, vec2f(1.0, 1.0), texel);
  let l = tap(uv, vec2f(-1.0, -1.0), texel);
  let m = tap(uv, vec2f(1.0, -1.0), texel);
  let g0 = (a + b + dd + e0) * 0.25;
  let g1 = (b + c0 + e0 + f) * 0.25;
  let g2 = (dd + e0 + g + h) * 0.25;
  let g3 = (e0 + f + h + i) * 0.25;
  let g4 = (j + k + l + m) * 0.25;
  var c: vec3f;
  if (B.mode < 0.5) {
    let w0 = karis(g0) * 0.125;
    let w1 = karis(g1) * 0.125;
    let w2 = karis(g2) * 0.125;
    let w3 = karis(g3) * 0.125;
    let w4 = karis(g4) * 0.5;
    c = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
    if (!(dot(c, vec3f(1.0)) < 1e6)) { c = vec3f(0.0); }
    // Soft-knee bright pass: zero at or below the threshold, C1 there, linear well above it.
    let lum = max(max(c.r, c.g), c.b);
    let x = lum - B.threshold;
    let soft = select(max(x - 0.5 * B.knee, 0.0), x * x / (2.0 * B.knee), x < B.knee);
    let contrib = select(0.0, soft, x > 0.0);
    return vec4f(min(c * (contrib / max(lum, 1e-4)), vec3f(40.0)), 1.0);
  }
  c = (g0 + g1 + g2 + g3) * 0.125 + g4 * 0.5;
  return vec4f(c, 1.0);
}
`;

/** Bright-pass parameters shared by the CPU side (index.ts writes them into the mode-0 uniform). */
export const BLOOM_PARAMS = { threshold: BLOOM_THRESHOLD, knee: BLOOM_KNEE } as const;
/** Mip levels in the bloom chain, starting at quarter resolution. */
export const BLOOM_MIPS = 5;
/** Tent radius of the upsample, in source texels. */
export const BLOOM_UPSAMPLE_RADIUS = 1.0;

export const MIPGEN_WGSL = /* wgsl */ `
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var linSamp: sampler;
${FULLSCREEN_VS}
@fragment
fn fsMip(in: FsOut) -> @location(0) vec4f {
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  return textureSampleLevel(srcTex, linSamp, uv, 0.0);
}
`;

/**
 * Rain streaks: instanced camera-local particles. Each instance is a thin quad from p to p − velocity·len,
 * expanded perpendicular in screen space. Positions wrap inside a box that follows the camera.
 */
export const RAIN_WGSL = /* wgsl */ `
${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
${COMMON_WGSL}

struct ROut {
  @builtin(position) pos: vec4f,
  @location(0) fade: f32,
  @location(1) across: f32,
}

@vertex
fn vsRain(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ROut {
  let box = F.rainBox;
  let fi = f32(ii);
  let seed = vec3f(hash11(fi * 1.37), hash11(fi * 2.71 + 5.0), hash11(fi * 0.73 + 11.0));
  // Real drops fall at ~9 m/s; scale the animation with the box so streaks move at a similar on-screen speed
  // whether the camera is 50 m or 10 km away.
  let k = box / 34.0;
  let fallSpeed = (8.0 + 3.0 * hash11(fi * 4.1)) * k;
  let wind = vec3f(1.6, 0.0, 0.9) * k;
  let vel = vec3f(wind.x, -fallSpeed, wind.z);
  // Position inside a camera-centred box, animated and wrapped.
  let rel = fract(seed + vel * F.time / box - F.camPos / box) - 0.5;
  let p = F.camPos + rel * box;
  let p0 = F.viewProj * vec4f(p, 1.0);
  let p1 = F.viewProj * vec4f(p - vel * 0.022, 1.0);
  var o: ROut;
  if (p0.w < box * 0.02 || p1.w < box * 0.02) {
    o.pos = vec4f(2.0, 2.0, -1.0, 1.0);
    return o;
  }
  let s0 = p0.xy / p0.w;
  let s1 = p1.xy / p1.w;
  let aspect = F.viewport.x / F.viewport.y;
  let d = (s1 - s0) * vec2f(aspect, 1.0);
  let dl = max(length(d), 1e-5);
  let perp = vec2f(-d.y, d.x) / dl / vec2f(aspect, 1.0);
  let widthPx = clamp(box * 0.12 / p0.w * F.viewport.y * 0.02, 0.7, 2.2);
  let halfW = widthPx / F.viewport.y;
  let corner = vi % 4u;
  let isEnd = corner >= 2u;
  let sideSign = select(-1.0, 1.0, corner == 1u || corner == 3u);
  let base = select(p0, p1, isEnd);
  let sPos = select(s0, s1, isEnd) + perp * halfW * sideSign;
  o.pos = vec4f(sPos * base.w, base.z, base.w);
  let distFade = 1.0 - smoothstep(box * 0.25, box * 0.5, length(rel * box));
  o.fade = distFade * select(0.2, 1.0, isEnd);
  o.across = sideSign;
  return o;
}

@fragment
fn fsRain(in: ROut) -> @location(0) vec4f {
  let edge = 1.0 - abs(in.across);
  let a = in.fade * (0.25 + 0.75 * edge) * 0.3 * (0.6 + 0.4 * smoothstep(5.0, 60.0, F.rainRate));
  let col = mix(F.skyHorizon, vec3f(0.9, 0.93, 1.0), 0.5) * 1.2;
  return vec4f(col * a, a * 0.6);
}
`;
