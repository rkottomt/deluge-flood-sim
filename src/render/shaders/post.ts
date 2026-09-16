/** Sky, tonemapping, rain streaks and mip generation shaders. */
import { COMMON_WGSL, FRAME_WGSL } from './common';

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
  var col = skyRadiance(dir) + sunDisk(dir);
  // Soft high-altitude cloud bands.
  if (dir.y > 0.0) {
    let cp = dir.xz / (dir.y + 0.12) * 1.6 + vec2f(F.time * 0.004, 0.0);
    let c = vnoise(cp) * 0.6 + vnoise(cp * 2.3) * 0.3 + vnoise(cp * 5.1) * 0.1;
    let cloud = smoothstep(0.52, 0.85, c) * smoothstep(0.0, 0.25, dir.y) * (0.55 + 0.45 * F.opts.w);
    let cloudCol = mix(vec3f(1.0, 0.98, 0.95) * luminance(F.skyHorizon) * 1.35, vec3f(0.35, 0.37, 0.40) * luminance(F.skyHorizon), F.opts.w);
    col = mix(col, cloudCol, cloud * 0.55);
  }
  return vec4f(col, 1.0);
}
`;

export const TONEMAP_WGSL = /* wgsl */ `
struct Post {
  exposure: f32,
  srgbOut: f32,     // 1 → apply the sRGB OETF in-shader (non-sRGB canvas format)
  vignette: f32,
  bloom: f32,       // bloom strength (0 when the bloom passes are skipped)
}
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var hdrTex: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var linSamp: sampler;
${FULLSCREEN_VS}

// ACES filmic (Stephen Hill fit, with input/output matrices).
fn rrtOdt(v: vec3f) -> vec3f {
  let a = v * (v + 0.0245786) - 0.000090537;
  let b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
fn aces(c: vec3f) -> vec3f {
  let inM = mat3x3f(
    vec3f(0.59719, 0.07600, 0.02840),
    vec3f(0.35458, 0.90834, 0.13383),
    vec3f(0.04823, 0.01566, 0.83777));
  let outM = mat3x3f(
    vec3f(1.60475, -0.10208, -0.00327),
    vec3f(-0.53108, 1.10813, -0.07276),
    vec3f(-0.07367, -0.00605, 1.07602));
  return clamp(outM * rrtOdt(inM * c), vec3f(0.0), vec3f(1.0));
}
fn toSrgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

@fragment
fn fsTonemap(in: FsOut) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(hdrTex));
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  let px = vec2i(uv * size);
  var hdr = textureLoad(hdrTex, clamp(px, vec2i(0), vec2i(size) - 1), 0).rgb;
  hdr += textureSampleLevel(bloomTex, linSamp, uv, 0.0).rgb * 0.06 * P.bloom;
  // Guard against NaN/inf from any pass.
  if (!(dot(hdr, vec3f(1.0)) < 1e7)) { hdr = vec3f(0.0); }
  var c = aces(max(hdr, vec3f(0.0)) * P.exposure);
  let d = uv - 0.5;
  c *= 1.0 - P.vignette * dot(d, d) * 1.2;
  if (P.srgbOut > 0.5) { c = toSrgb(c); }
  // Dither to kill 8-bit banding in the sky gradient.
  c += (ign(in.pos.xy) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;

/** Bloom: bright-pass downsample + separable blur at reduced resolution. */
export const BLOOM_WGSL = /* wgsl */ `
struct Blur {
  dir: vec2f,
  threshold: f32,
  mode: f32, // 0 = bright-pass downsample, 1 = blur
}
@group(0) @binding(0) var<uniform> B: Blur;
@group(0) @binding(1) var srcTex: texture_2d<f32>;
@group(0) @binding(2) var linSamp: sampler;
${FULLSCREEN_VS}

@fragment
fn fsBloom(in: FsOut) -> @location(0) vec4f {
  let uv = vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5);
  if (B.mode < 0.5) {
    let texel = 1.0 / vec2f(textureDimensions(srcTex));
    var c = vec3f(0.0);
    for (var y = -1; y <= 1; y += 2) {
      for (var x = -1; x <= 1; x += 2) {
        c += textureSampleLevel(srcTex, linSamp, uv + vec2f(f32(x), f32(y)) * texel, 0.0).rgb;
      }
    }
    c *= 0.25;
    if (!(dot(c, vec3f(1.0)) < 1e6)) { c = vec3f(0.0); }
    let l = max(max(c.r, c.g), c.b);
    let k = smoothstep(B.threshold, B.threshold * 2.5, l);
    return vec4f(min(c * k, vec3f(40.0)), 1.0);
  }
  let texel = B.dir / vec2f(textureDimensions(srcTex));
  let w = array<f32, 5>(0.2270270, 0.1945946, 0.1216216, 0.0540540, 0.0162162);
  var c = textureSampleLevel(srcTex, linSamp, uv, 0.0).rgb * w[0];
  for (var i = 1; i < 5; i++) {
    let o = texel * f32(i) * 1.5;
    c += textureSampleLevel(srcTex, linSamp, uv + o, 0.0).rgb * w[i];
    c += textureSampleLevel(srcTex, linSamp, uv - o, 0.0).rgb * w[i];
  }
  return vec4f(c, 1.0);
}
`;

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
  let box = 34.0;
  let fi = f32(ii);
  let seed = vec3f(hash11(fi * 1.37), hash11(fi * 2.71 + 5.0), hash11(fi * 0.73 + 11.0));
  let fallSpeed = 8.0 + 3.0 * hash11(fi * 4.1);
  let wind = vec3f(1.6, 0.0, 0.9);
  let vel = vec3f(wind.x, -fallSpeed, wind.z);
  // Position inside a camera-centred box, animated and wrapped.
  let rel = fract(seed + vel * F.time / box - F.camPos / box) - 0.5;
  let p = F.camPos + rel * box;
  let len = 0.05 * fallSpeed;
  let p0 = F.viewProj * vec4f(p, 1.0);
  let p1 = F.viewProj * vec4f(p - vel * len * 0.1, 1.0);
  var o: ROut;
  if (p0.w < 0.3 || p1.w < 0.3) {
    o.pos = vec4f(2.0, 2.0, -1.0, 1.0);
    return o;
  }
  let s0 = p0.xy / p0.w;
  let s1 = p1.xy / p1.w;
  let aspect = F.viewport.x / F.viewport.y;
  var d = (s1 - s0) * vec2f(aspect, 1.0);
  let dl = max(length(d), 1e-5);
  let perp = vec2f(-d.y, d.x) / dl / vec2f(aspect, 1.0);
  let widthPx = clamp(2.2 / p0.w * 6.0, 0.7, 2.0);
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
  let a = in.fade * (0.25 + 0.75 * edge) * 0.22;
  let col = mix(F.skyHorizon, vec3f(0.9, 0.93, 1.0), 0.5) * 1.2;
  return vec4f(col * a, a * 0.6);
}
`;
