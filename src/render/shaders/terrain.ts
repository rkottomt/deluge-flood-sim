/** Terrain surface + diorama skirt shaders. */
import { COMMON_WGSL, FRAME_WGSL, LOD_WGSL } from './common';

export const TERRAIN_WGSL = /* wgsl */ `
${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var vtxTex: texture_2d<f32>;
@group(0) @binding(2) var normTex: texture_2d<f32>;
@group(0) @binding(3) var miscTex: texture_2d<f32>;
@group(0) @binding(4) var surfTex: texture_2d<f32>;
@group(0) @binding(5) var imageryTex: texture_2d<f32>;
@group(0) @binding(6) var linSamp: sampler;
@group(0) @binding(7) var imgSamp: sampler;
@group(0) @binding(8) var wetTex: texture_2d<f32>;
${COMMON_WGSL}
${LOD_WGSL}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) grid: vec2f,
  @location(2) elev: f32,
  @location(3) side: vec4f, // skirt: xyz outward normal, w = surface elevation at the top of the skirt
  @location(4) haze: vec4f, // rgb haze color, a = haze amount
}

@vertex
fn vsTerrain(@builtin(vertex_index) vi: u32, n: NodeIn) -> VOut {
  let v = lodVertex(vi, n);
  let elev = mix(v.a.r, v.b.r, v.m);
  let w = gridToWorld(v.g, elev);
  var o: VOut;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.grid = v.g;
  o.elev = elev;
  o.side = vec4f(0.0);
  o.haze = vertexHaze(w);
  return o;
}

/** Skirt vertices: index = side * 2 * maxV + k * 2 + isTop. */
@vertex
fn vsSkirt(@builtin(vertex_index) vi: u32) -> VOut {
  let maxV = u32(max(F.mesh.x, F.mesh.y));
  let side = vi / (2u * maxV);
  let k = i32((vi % (2u * maxV)) / 2u);
  let isTop = (vi % 2u) == 1u;
  let m = vec2i(F.mesh);
  var kl = vec2i(0);
  var nrm = vec3f(0.0);
  switch (side) {
    case 0u: { kl = vec2i(k, 0); nrm = vec3f(0.0, 0.0, -1.0); }
    case 1u: { kl = vec2i(k, m.y - 1); nrm = vec3f(0.0, 0.0, 1.0); }
    case 2u: { kl = vec2i(0, k); nrm = vec3f(-1.0, 0.0, 0.0); }
    default: { kl = vec2i(m.x - 1, k); nrm = vec3f(1.0, 0.0, 0.0); }
  }
  let t = textureLoad(vtxTex, kl, 0);
  let g = min(vec2f(kl) * F.stride, F.grid);
  let elev = select(F.elev.z, t.r, isTop);
  let w = gridToWorld(g, elev);
  var o: VOut;
  o.pos = F.viewProj * vec4f(w, 1.0);
  o.world = w;
  o.grid = g;
  o.elev = elev;
  o.side = vec4f(nrm, t.r);
  o.haze = vertexHaze(w);
  return o;
}

/** Classic hypsometric tint (linear colors): valley greens → yellow-tan → browns → pale uplands. */
fn hypsometric(elev: f32, slope: f32) -> vec3f {
  let range = max(F.elev.y - F.elev.x, 1.0);
  let t = clamp((elev - F.elev.x) / range, 0.0, 1.0);
  let c0 = vec3f(0.085, 0.20, 0.090);
  let c1 = vec3f(0.24, 0.34, 0.12);
  let c2 = vec3f(0.52, 0.47, 0.22);
  let c3 = vec3f(0.40, 0.27, 0.14);
  let c4 = vec3f(0.55, 0.50, 0.45);
  var c = mix(c0, c1, smoothstep(0.0, 0.35, t));
  c = mix(c, c2, smoothstep(0.35, 0.65, t));
  c = mix(c, c3, smoothstep(0.65, 0.9, t));
  c = mix(c, c4, smoothstep(0.9, 1.05, t));
  let rock = vec3f(0.30, 0.27, 0.24);
  return mix(c, rock, smoothstep(0.5, 1.2, slope) * 0.7);
}

struct Shade {
  albedo: vec3f,
  n: vec3f,
}

@fragment
fn fsTerrain(in: VOut) -> @location(0) vec4f {
  let uv = in.grid / F.grid;
  let nrm = textureSampleLevel(normTex, linSamp, uv, 0.0);
  let misc = textureSampleLevel(miscTex, linSamp, uv, 0.0);
  let img = textureSample(imageryTex, imgSamp, uv).rgb;
  // Derivatives must be taken in uniform control flow.
  let contourCoord = in.elev / max(F.opts.z, 0.01);
  let contourFw = fwidth(contourCoord);
  let wallCoordFw = fwidth(in.elev);

  let slopeVec = nrm.rg * F.exag;
  var n = normalize(vec3f(-slopeVec.x, 1.0, -slopeVec.y));
  let slope = length(nrm.rg);

  let useImagery = F.opts.x > 0.5;
  var albedo = select(hypsometric(in.elev, slope), img, useImagery);

  // Ground that has been flooded (max depth > 0) stays darker: wet soil / flood trace.
  let wet = smoothstep(0.01, 0.12, misc.g);
  albedo *= mix(1.0, 0.58, wet);

  // ── Walls: sandbags (≤ 2.5 m) or concrete floodwall ──────────────────────────────────────
  // Walls are at most a couple of cells wide, so they are rendered as a distinct material with exaggerated face
  // lighting, a contact shadow at the foot and a bright crest, which keeps them legible from far away.
  let barrier = misc.r;
  let wallAmt = smoothstep(0.05, 0.3, barrier);
  let foot = smoothstep(0.0, 0.04, barrier) * (1.0 - wallAmt);
  var rim = 0.0;
  var nLight = n;
  if (wallAmt > 0.001) {
    let concrete = smoothstep(2.3, 2.8, barrier);
    // Sandbag courses every ~0.3 m of height, staggered bags ~0.7 m long.
    let rowF = in.elev / 0.3;
    let row = floor(rowF);
    let along = (in.world.x + in.world.z) / 0.7 + row * 0.5;
    let rowEdge = abs(fract(rowF) - 0.5) * 2.0;
    let bagEdge = abs(fract(along) - 0.5) * 2.0;
    let detailFade = 1.0 - smoothstep(0.08, 0.3, wallCoordFw);
    let bag = mix(1.0, (0.72 + 0.28 * (1.0 - pow(rowEdge, 6.0))) * (0.8 + 0.2 * (1.0 - pow(bagEdge, 8.0))), detailFade);
    let jitter = 0.9 + 0.2 * hash12(vec2f(row, floor(along)));
    let sandbag = vec3f(0.56, 0.44, 0.26) * bag * mix(1.0, jitter, detailFade);
    // Concrete: light grey with panel joints every 5 m.
    let joint = 1.0 - (1.0 - smoothstep(0.0, 0.04, abs(fract((in.world.x - in.world.z) / 5.0) - 0.5) * 2.0)) * 0.35 * detailFade;
    let concreteCol = vec3f(0.66, 0.66, 0.63) * joint;
    let wallCol = mix(sandbag, concreteCol, concrete);
    albedo = mix(albedo, wallCol, wallAmt);
    nLight = normalize(vec3f(-slopeVec.x * (1.0 + 2.5 * wallAmt), 1.0, -slopeVec.y * (1.0 + 2.5 * wallAmt)));
    // Crest highlight where the flat top meets the faces.
    let topness = smoothstep(0.55, 0.85, nLight.y) * (1.0 - smoothstep(0.93, 0.995, nLight.y));
    rim = wallAmt * (topness + smoothstep(0.97, 1.0, nLight.y) * 0.5);
  }
  albedo *= 1.0 - 0.4 * foot;

  // ── Lighting ───────────────────────────────────────────────────────────────────────────
  let L = F.sunDir;
  var ndl = max(dot(nLight, L), 0.0);
  if (useImagery) {
    // Aerial photos already contain shading: apply a softened hillshade relative to flat ground (walls are not in
    // the photo, so they get full lighting).
    let flatNdl = max(L.y, 0.2);
    ndl = mix(mix(flatNdl, ndl, 0.62), ndl, wallAmt);
  }
  let sunK = F.sunColor * (1.0 - F.opts.w * 0.75);
  var color = albedo * (sunK * ndl + skyAmbient(nLight) * 0.85);
  color += vec3f(1.0, 0.95, 0.85) * rim * 0.4 * (0.4 + ndl);

  // ── Contours ───────────────────────────────────────────────────────────────────────────
  if (F.opts.y > 0.5 || !useImagery) {
    let d = abs(fract(contourCoord - 0.5) - 0.5) / max(contourFw, 1e-5);
    let line = 1.0 - smoothstep(0.35, 1.25, d);
    let majorCoord = contourCoord / 5.0;
    let dm = abs(fract(majorCoord - 0.5) - 0.5) / max(contourFw / 5.0, 1e-5);
    let major = 1.0 - smoothstep(0.6, 1.8, dm);
    let fade = 1.0 - smoothstep(0.25, 0.7, contourFw);
    let strength = select(0.32, 0.5, F.opts.y > 0.5);
    let ink = select(vec3f(0.02, 0.02, 0.015), vec3f(1.0, 0.97, 0.9) * 0.9, false);
    color = mix(color, ink, clamp(max(line * fade * strength, major * strength * 1.3 * (1.0 - smoothstep(0.1, 0.35, contourFw / 5.0))), 0.0, 0.85));
  }

  color = mix(color, in.haze.rgb, in.haze.a);
  return vec4f(color, 1.0);
}

@fragment
fn fsSkirt(in: VOut) -> @location(0) vec4f {
  let n = in.side.xyz;
  let depthBelow = (in.side.w - in.elev);
  let range = max(in.side.w - F.elev.z, 1.0);
  let t = clamp(depthBelow / range, 0.0, 1.0);
  // Layered soil / bedrock cross-section.
  let strata = vnoise(vec2f((in.world.x + in.world.z) * 0.002, in.elev * 0.08)) * 0.5
             + vnoise(vec2f((in.world.x - in.world.z) * 0.01, in.elev * 0.35)) * 0.5;
  var albedo = mix(vec3f(0.20, 0.14, 0.09), vec3f(0.11, 0.095, 0.085), smoothstep(0.02, 0.35, t));
  albedo *= 0.8 + 0.35 * strata;
  // Thin topsoil band.
  albedo = mix(vec3f(0.12, 0.13, 0.06), albedo, smoothstep(0.0, 1.5 * F.exag, depthBelow * F.exag));
  let ndl = max(dot(n, F.sunDir), 0.0);
  var color = albedo * (F.sunColor * ndl * 0.8 + skyAmbient(n) * 0.7);
  color *= mix(1.0, 0.45, t);
  color = mix(color, in.haze.rgb, in.haze.a);
  return vec4f(color, 1.0);
}
`;
