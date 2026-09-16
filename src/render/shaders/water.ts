/** Water surface shaders: photoreal floodwater and hazard colormaps. */
import { COMMON_WGSL, FRAME_WGSL, LOD_WGSL } from './common';

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
${COMMON_WGSL}
${LOD_WGSL}

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
  var surface = mix(v.a.g, v.b.g, v.m);
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
fn rippleSample(p: vec2f) -> vec4f {
  let s = textureSample(rippleTex, repSamp, p);
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

  let mode = i32(F.waterMode + 0.5);
  let flow = s.gb;
  let speed = misc.b;

  // ── Flow-advected ripple detail: two-phase flow map ─────────────────────────────────────
  let period = 2.4;
  let ph0 = fract(F.time / period);
  let ph1 = fract(F.time / period + 0.5);
  let blend = abs(ph0 - 0.5) * 2.0;
  let scaleA = 1.0 / 11.0;
  let scaleB = 1.0 / 3.7;
  let pa = in.world.xz * scaleA;
  let pb = in.world.xz * scaleB;
  let flowA = flow * scaleA * period * 0.9;
  let flowB = flow * scaleB * period * 0.9;
  let wind = vec2f(0.21, 0.13) * F.time;
  let a0 = rippleSample(pa - flowA * ph0 + wind * scaleA * 3.0);
  let a1 = rippleSample(pa - flowA * ph1 + vec2f(0.37, 0.61) + wind * scaleA * 3.0);
  let b0 = rippleSample(pb - flowB * ph0 - wind * scaleB * 2.0);
  let b1 = rippleSample(pb - flowB * ph1 + vec2f(0.53, 0.19) - wind * scaleB * 2.0);
  let rA = mix(a0, a1, blend);
  let rB = mix(b0, b1, blend);
  let rainSlope = rainRipple(in.world.xz / 1.6);

  let V0 = F.camPos - in.world;
  let dist = length(V0);
  let V = V0 / max(dist, 1e-3);
  let thickFw = fwidth(in.thick);
  let valueDepth = select(s.r, misc.g, mode == 2);
  let hazardValue = select(valueDepth, speed, mode == 3);
  let hazardFw = fwidth(hazardValue);
  let pixelFoot = dist * F.elev.w;

  if (in.thick <= 0.0) {
    discard;
  }

  // Soft shoreline: fade over a few cm, widened by the pixel footprint to stay anti-aliased.
  let shore = smoothstep(0.0, max(0.035, thickFw * 1.5), in.thick);

  let macroSlope = nrm.ba * F.exag;
  let chop = 0.06 + 0.32 * smoothstep(0.15, 2.5, speed);
  let rainAmt = smoothstep(0.5, 25.0, F.rainRate) * (1.0 - smoothstep(0.02, 0.12, pixelFoot));
  let detailFade = 1.0 - smoothstep(0.5, 6.0, pixelFoot);
  var slopes = macroSlope + (rA.xy * chop + rB.xy * chop * 0.55) * mix(0.35, 1.0, detailFade) + rainSlope * 0.35 * rainAmt;
  if (in.skirt > 0.5) {
    slopes = vec2f(0.0);
  }
  let n = normalize(vec3f(-slopes.x, 1.0, -slopes.y));

  let sunVis = 1.0 - F.opts.w * 0.8;
  let lightIn = F.sunColor * max(F.sunDir.y, 0.0) * 0.75 * sunVis + skyAmbient(vec3f(0.0, 1.0, 0.0)) * 0.9;
  let nv = max(dot(n, V), 0.0);
  let fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  var R = reflect(-V, n);
  R.y = max(R.y, 0.02);
  let H = normalize(F.sunDir + V);
  let nh = max(dot(n, H), 0.0);
  let spec = F.sunColor * sunVis * (pow(nh, 900.0) * 55.0 + pow(nh, 90.0) * 0.9) * smoothstep(0.0, 0.08, F.sunDir.y);

  var rgb = vec3f(0.0);
  var alpha = 0.0;

  if (mode == 0) {
    // ── Photoreal muddy floodwater ──────────────────────────────────────────────────────
    let path = in.thick / max(nv, 0.25);
    let sigma = vec3f(1.1, 1.35, 1.9);
    let T = exp(-sigma * path);
    let tAvg = dot(T, vec3f(0.3333));
    let scatterAlbedo = vec3f(0.30, 0.25, 0.16);
    // Deep channels read slightly greener/darker than sheet flow over streets.
    let deep = smoothstep(1.0, 6.0, in.thick);
    let body = mix(scatterAlbedo, vec3f(0.17, 0.18, 0.12), deep) * lightIn * 0.55;
    let sky = skyRadiance(R) * 0.9;
    rgb = body * (1.0 - tAvg) * (1.0 - fres) + sky * fres + spec;
    alpha = (1.0 - tAvg) * (1.0 - fres) + fres;

    // Foam / whitewater: Froude & speed (per cell) + moving shoreline fronts.
    let foamNoise = mix(rA.z, rB.z, 0.45) * 0.75 + rB.w * 0.35;
    let shoreFoam = (1.0 - smoothstep(0.0, 0.22, in.thick)) * smoothstep(0.25, 1.2, speed) * 0.85;
    let foamAmt = clamp(s.a + shoreFoam, 0.0, 1.0) * select(1.0, 0.0, in.skirt > 0.5);
    let foamMask = smoothstep(1.0 - foamAmt, 1.0 - foamAmt + 0.3, foamNoise) * foamAmt;
    let foamCol = vec3f(0.78, 0.76, 0.70) * (lightIn * 0.9 + F.sunColor * max(dot(n, F.sunDir), 0.0) * 0.25 * sunVis);
    rgb = mix(rgb, foamCol, foamMask * 0.9);
    alpha = mix(alpha, 1.0, foamMask * 0.9);
  } else {
    // ── Hazard colormap: flat bands, gently lit, semi-opaque ────────────────────────────
    var band = hazardColor(hazardValue, hazardFw);
    let mn = normalize(vec3f(-macroSlope.x, 1.0, -macroSlope.y));
    let lit = 0.78 + 0.28 * max(dot(mn, F.sunDir), 0.0);
    rgb = band * lit * (0.9 + 0.6 * luminance(F.skyHorizon));
    if (mode == 3) {
      // Animated flow streaks so direction is readable.
      let dir = flow / max(length(flow), 1e-3);
      let along = dot(in.world.xz, dir);
      let across = dot(in.world.xz, vec2f(-dir.y, dir.x));
      let lane = floor(across / 14.0);
      let phase = fract((along - F.time * min(speed, 6.0) * 12.0) / 90.0 + hash11(lane));
      let streak = smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.08, 0.5, phase))
                 * (1.0 - smoothstep(0.1, 0.45, abs(fract(across / 14.0) - 0.5)))
                 * smoothstep(0.15, 0.8, speed) * detailFade;
      rgb = mix(rgb, vec3f(1.0), streak * 0.35);
    }
    rgb += spec * 0.15 + skyRadiance(R) * fres * 0.25;
    alpha = 0.8;
  }

  alpha = clamp(alpha, 0.0, 1.0) * shore;
  // Premultiplied output + aerial perspective.
  rgb = rgb * shore;
  rgb = mix(rgb, in.haze.rgb * alpha, in.haze.a);
  return vec4f(rgb, alpha);
}
`;
