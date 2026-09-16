/** Overlay shaders: terrain-draped ribbons (roads, route, cursor ring) and 3D markers. */
import { COMMON_WGSL, FRAME_WGSL, VTX_SAMPLE_WGSL } from './common';

/** Byte size of the overlay uniform block. */
export const OVERLAY_UNIFORM_SIZE = 48;

const OVERLAY_HEADER = /* wgsl */ `
${FRAME_WGSL}
struct Overlay {
  cursorColor: vec4f,
  routeColor: vec4f,   // rgb, a = pulse amount (blocked)
  routeDash: f32,      // dash spacing in meters
  routeState: f32,     // 0 none, 1 ok, 2 blocked
  roadAlpha: f32,
  hasStatus: f32,
}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var vtxTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> O: Overlay;
@group(0) @binding(3) var<storage, read> roadStatus: array<u32>;
${COMMON_WGSL}
${VTX_SAMPLE_WGSL}
`;

export const RIBBON_WGSL = /* wgsl */ `
${OVERLAY_HEADER}

struct RIn {
  @location(0) center: vec2f,
  @location(1) tangent: vec2f,
  @location(2) attr: vec4f,     // side, along (m), half width (m), kind + 8·id
}

struct ROut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) side: f32,
  @location(2) along: f32,
  @location(3) @interpolate(flat) kind: u32,
  @location(4) @interpolate(flat) color: vec4f,
  @location(5) coreFrac: f32,
}

@vertex
fn vsRibbon(v: RIn) -> ROut {
  let packed = u32(v.attr.w + 0.5);
  let kind = packed % 8u;
  let id = packed / 8u;
  let s = vtxBilinear(v.center);
  // Drape on whichever is higher: the terrain or the water surface.
  let top = select(s.r, max(s.r, s.g), s.a > 0.5);
  var lift = 0.35;
  var minHalfPx = 0.9;
  var color = vec4f(1.0);
  var coreFrac = 1.0;
  var halfW = v.attr.z;
  if (kind == 0u) {
    var st = 0u;
    if (O.hasStatus > 0.5) { st = roadStatus[id]; }
    if (st == 0u) { color = vec4f(0.72, 0.70, 0.66, O.roadAlpha); }
    else if (st == 1u) { color = vec4f(1.0, 0.52, 0.04, 0.95); minHalfPx = 1.3; }
    else { color = vec4f(1.0, 0.06, 0.05, 0.85); minHalfPx = 1.6; }
  } else if (kind == 1u) {
    lift = 1.2;
    minHalfPx = 7.0;
    color = O.routeColor;
    coreFrac = 0.3;
  } else {
    lift = 0.6;
    minHalfPx = 1.6;
    color = O.cursorColor;
  }
  let centerW = gridToWorld(v.center, top) + vec3f(0.0, lift, 0.0);
  let dist = length(centerW - F.camPos);
  halfW = max(halfW, dist * F.elev.w * minHalfPx);
  let t = normalize(vec2f(v.tangent.x, v.tangent.y) + vec2f(1e-9, 0.0));
  let miter = length(v.tangent);
  let perp = vec2f(-t.y, t.x);
  let offGrid = perp * v.attr.x * halfW * miter / F.cellSize;
  let g = v.center + offGrid;
  let s2 = vtxBilinear(g);
  let top2 = select(s2.r, max(s2.r, s2.g), s2.a > 0.5);
  let w = gridToWorld(g, max(top, top2)) + vec3f(0.0, lift, 0.0);
  var o: ROut;
  o.pos = pullForward(F.viewProj * vec4f(w, 1.0), select(1.2e-3, 2.0e-3, kind == 1u));
  o.world = w;
  o.side = v.attr.x;
  o.along = v.attr.y;
  o.kind = kind;
  o.color = color;
  o.coreFrac = coreFrac;
  return o;
}

@fragment
fn fsRibbon(in: ROut) -> @location(0) vec4f {
  let a = abs(in.side);
  let aw = fwidth(in.side);
  let haze = hazeAmount(in.world);
  if (in.kind == 0u) {
    // Road: bright core with a dark casing for contrast over imagery.
    let body = 1.0 - smoothstep(1.0 - aw * 1.5, 1.0, a);
    let casing = smoothstep(0.55 - aw, 0.7 + aw, a);
    let rgb = mix(in.color.rgb * 1.1, in.color.rgb * 0.18, casing * 0.75);
    let alpha = in.color.a * body * (1.0 - haze * 0.7);
    return vec4f(rgb * alpha, alpha);
  }
  if (in.kind == 1u) {
    // Evacuation route: glowing ribbon with animated chevron dashes (additive).
    let core = 1.0 - smoothstep(in.coreFrac - aw, in.coreFrac + aw, a);
    let glow = exp(-a * a * 5.0) * 0.55;
    let blocked = O.routeState > 1.5;
    let dash = O.routeDash;
    var phase = fract(in.along / dash - F.time * select(0.9, 0.0, blocked));
    // Chevrons: offset the phase by |side| so dashes point along the direction of travel.
    phase = fract(phase + a * 0.35 * select(1.0, 0.0, blocked));
    let on = select(smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.5, 0.58, phase)),
                    step(phase, 0.55), blocked);
    let pulse = select(1.0, 0.55 + 0.45 * sin(F.time * 6.0), blocked);
    let coreCol = mix(in.color.rgb * 0.55, vec3f(1.0) * 3.0 + in.color.rgb * 2.0, on);
    let rgb = (coreCol * core + in.color.rgb * glow * (1.0 - core)) * pulse * (1.0 - haze * 0.5);
    let alpha = core * 0.85;
    return vec4f(rgb, alpha);
  }
  // Cursor ring.
  let ring = 1.0 - smoothstep(1.0 - aw * 1.5, 1.0, a);
  let pulse = 0.8 + 0.2 * sin(F.time * 5.0);
  let alpha = in.color.a * ring * pulse;
  return vec4f(in.color.rgb * 2.2 * alpha, alpha);
}
`;

export const MARKER_WGSL = /* wgsl */ `
${OVERLAY_HEADER}

struct MIn {
  @location(0) local: vec3f,
  @location(1) normal: vec3f,
  @location(2) anchor: vec4f,   // gx, gy, absolute elevation (m), anchor mode (0 ground, 1 absolute, 2 water surface)
  @location(3) params: vec4f,   // scale mode (0 marker, 1 meters, 2 meters with exaggerated y), kind, marker size (m), phase
  @location(4) color: vec4f,
}

struct MOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) kind: u32,
  @location(4) @interpolate(flat) color: vec4f,
  @location(5) @interpolate(flat) phase: f32,
  @location(6) @interpolate(flat) size: f32,
}

@vertex
fn vsMarker(v: MIn) -> MOut {
  let mode = u32(v.anchor.w + 0.5);
  let s = vtxBilinear(v.anchor.xy);
  var elev = s.r;
  if (mode == 1u) { elev = v.anchor.z; }
  else if (mode == 2u && s.a > 0.5) { elev = max(s.r, s.g); }
  let base = gridToWorld(v.anchor.xy, elev);
  let scaleMode = u32(v.params.x + 0.5);
  var w = base;
  var n = v.normal;
  if (scaleMode == 0u) {
    let dist = length(base - F.camPos);
    let sc = max(v.params.z, dist * F.elev.w * 34.0);
    w = base + v.local * sc;
  } else if (scaleMode == 1u) {
    w = base + v.local;
  } else {
    w = base + vec3f(v.local.x, v.local.y * F.exag, v.local.z);
  }
  var o: MOut;
  o.pos = pullForward(F.viewProj * vec4f(w, 1.0), 2e-4);
  o.world = w;
  o.normal = n;
  o.local = v.local;
  o.kind = u32(v.params.y + 0.5);
  o.color = v.color;
  o.phase = v.params.w;
  o.size = v.params.z;
  return o;
}

@fragment
fn fsMarker(in: MOut, @builtin(front_facing) front: bool) -> @location(0) vec4f {
  let V = normalize(F.camPos - in.world);
  var n = normalize(in.normal);
  let haze = hazeAmount(in.world) * 0.6;
  switch (in.kind) {
    case 0u: {
      // Lit solid (pins, poles, houses).
      let ndl = max(dot(n, F.sunDir), 0.0);
      let rim = pow(1.0 - max(dot(n, V), 0.0), 3.0);
      var rgb = in.color.rgb * (F.sunColor * ndl * 0.8 + skyAmbient(n) * 1.1) + in.color.rgb * rim * 0.6;
      let H = normalize(F.sunDir + V);
      rgb += F.sunColor * pow(max(dot(n, H), 0.0), 60.0) * 0.5;
      // Emissive boost so markers pop over imagery.
      rgb += in.color.rgb * 0.25;
      rgb = mix(rgb, skyRadiance(-V), haze);
      return vec4f(rgb, 1.0);
    }
    case 1u: {
      // Light beam (additive): brightest at the core of the cylinder silhouette, fades with height.
      let facing = abs(dot(n, V));
      let h = clamp(in.local.y / 3.5, 0.0, 1.0);
      let fade = (1.0 - h) * (1.0 - h);
      let pulse = 0.75 + 0.25 * sin(F.time * 3.0 + in.phase);
      let rgb = in.color.rgb * pow(facing, 1.5) * fade * pulse * in.color.a;
      return vec4f(rgb, 0.0);
    }
    case 2u: {
      // Storm rain column: animated falling streaks on a translucent curtain.
      let ang = atan2(in.local.z, in.local.x);
      let col = floor(ang * 40.0 / PI);
      let speed = 0.9 + hash11(col) * 0.6;
      let v = fract(in.world.y / (F.domainSize * 0.02) + F.time * speed + hash11(col + 3.0));
      let streak = smoothstep(0.0, 0.1, v) * (1.0 - smoothstep(0.25, 0.6, v));
      let facing = abs(dot(n, V));
      let edge = pow(1.0 - facing, 1.5) * 0.7 + 0.3;
      let hFade = smoothstep(0.0, 0.08, in.phase) ;
      let a = in.color.a * (0.35 + 0.65 * streak) * edge;
      let rgb = in.color.rgb * (0.6 + 0.4 * streak) * mix(vec3f(1.0), skyAmbient(n), 0.5);
      return vec4f(rgb * a, a);
    }
    case 3u: {
      // Storm cloud: soft-edged, noisy, lit from above (params.z carries the cloud radius in meters).
      let rr = length(in.local.xz) / max(in.size, 1.0);
      let t = F.time * 0.02;
      let nz = vnoise(in.local.xz / max(in.size, 1.0) * 3.0 + vec2f(t, -t * 0.7)) * 0.6
             + vnoise(in.local.xz / max(in.size, 1.0) * 9.0 - vec2f(t * 1.7, t)) * 0.4;
      let edge = 1.0 - smoothstep(0.45, 1.0, rr + (nz - 0.5) * 0.35);
      let a = in.color.a * edge * (0.65 + 0.35 * nz);
      let top = max(n.y, 0.0);
      let lum = luminance(F.skyHorizon);
      let rgb = in.color.rgb * lum * (0.55 + 0.9 * top + 0.35 * nz) + F.sunColor * top * 0.04 * (1.0 - F.opts.w);
      return vec4f(rgb * a, a);
    }
    case 4u: {
      // Wall preview ghost: translucent hazard stripes with bright edges.
      let stripes = step(0.5, fract((in.world.x + in.world.z + in.world.y * 2.0) / 3.0 - F.time * 0.6));
      let facing = abs(dot(n, V));
      let edge = pow(1.0 - facing, 2.0);
      let a = in.color.a * (0.35 + 0.25 * stripes + 0.4 * edge);
      let rgb = in.color.rgb * (1.2 + 0.8 * stripes + edge * 1.5);
      return vec4f(rgb * a, a);
    }
    default: {
      // Expanding pulse ring on a flat disc (local radius 0..1).
      let r = length(in.local.xz);
      let t = fract(F.time * 0.6 + in.phase);
      let ring = exp(-pow((r - t) * 12.0, 2.0)) * (1.0 - t);
      let a = ring * in.color.a;
      return vec4f(in.color.rgb * a * 2.5, 0.0);
    }
  }
}
`;
