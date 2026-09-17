/** Overlay shaders: terrain-draped ribbons (roads, route, cursor ring) and 3D markers. */
import { COMMON_WGSL, FRAME_WGSL, VTX_SAMPLE_WGSL } from './common';

/** Byte size of the overlay uniform block. */
export const OVERLAY_UNIFORM_SIZE = 64;

const OVERLAY_HEADER = /* wgsl */ `
${FRAME_WGSL}
struct Overlay {
  cursorColor: vec4f,
  routeColor: vec4f,   // rgb, a = pulse amount (blocked)
  routeDash: f32,      // dash spacing in meters
  routeState: f32,     // 0 none, 1 ok, 2 blocked
  roadAlpha: f32,
  hasStatus: f32,
  waterMode: f32,      // 0 realistic, 1 depth, 2 max depth, 3 speed
  evacActive: f32,     // 1 while an evacuation start is set: cut roads matter, draw them more prominently
  pad0: f32,
  pad1: f32,
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
  let t = normalize(vec2f(v.tangent.x, v.tangent.y) + vec2f(1e-9, 0.0));
  let miter = length(v.tangent);
  let perp = vec2f(-t.y, t.x);
  if (kind == 0u) {
    var st = 0u;
    if (O.hasStatus > 0.5) { st = roadStatus[id]; }
    // Importance from the class width (local 3.5 m … highway 11 m): minor roads thin out with distance so the
    // overview stays readable.
    let importance = smoothstep(3.0, 11.0, v.attr.z);
    let toCenter = gridToWorld(v.center, s.r) - F.camPos;
    let d0 = length(toCenter);
    // Without imagery the ribbons are the only sign of the town, so they stay visible over the whole domain.
    let far = mix(vec2f(1.0, 2.6), vec2f(0.35, 1.1), F.opts.x) * F.domainSize;
    let fade = mix(1.0 - smoothstep(far.x, far.y, d0), 1.0, importance);
    if (st == 0u) { color = vec4f(0.93, 0.92, 0.88, O.roadAlpha * fade); minHalfPx = mix(0.7, 1.1, importance); }
    // Wet (passable, slow): orange, clear of both the golden sandbag walls the user builds and the red flooded lines.
    else if (st == 1u) { color = vec4f(1.2, 0.31, 0.03, 0.9 * mix(fade, 1.0, 0.5)); minHalfPx = 1.2; }
    else {
      // Flooded (impassable) roads lie under the flood itself, which already says "flooded": draw them as thin
      // dashed centre lines that do not hide the water, minor streets fading with distance. A real-width ribbon
      // (a highway is 22 m wide) turns into rows of translucent tiles up close, so the line is capped at a couple of
      // pixels and at a third of the road's width, and it fades further as the camera comes close, where the water
      // over the street is plain to see. While an evacuation is being planned they are what blocks the route, so
      // they come up a notch and stay at full strength. In the hazard maps they turn a neutral dark grey so they
      // never read as one of the red speed bands.
      let emph = O.evacActive;
      let hazardMap = O.waterMode > 0.5;
      // HDR red: a thin line needs a brighter colour than a wide ribbon to read (the tone mapper maps 1.0 to mid-grey).
      let rgb = select(vec3f(2.4, 0.30, 0.22), vec3f(0.10, 0.10, 0.12), hazardMap);
      // Strongest at mid range; from the overview a whole flooded district of them would net the flood in red. Up close
      // (a few hundred metres) the water over the street says "flooded" by itself, and the lines ran as busy red bands
      // along every highway lane and bridge beside the evacuation route: there they get thinner on screen and, where
      // the street is well under water, fainter — evacuation or not, so the route stays the brightest line in view.
      let close = 1.0 - smoothstep(300.0, 1600.0, d0);
      let midUp = smoothstep(350.0, 1500.0, d0);
      let near = mix(mix(0.45, 1.0, midUp), mix(0.6, 1.0, midUp), emph);
      let farOff = smoothstep(1500.0, 7000.0, d0);
      let submerged = select(0.0, smoothstep(0.15, 1.2, s.g - s.r), s.a > 0.5);
      let a = mix(0.72, 0.92, emph) * mix(fade * mix(0.6, 1.0, importance), 1.0, emph * importance) * near
            * (1.0 - farOff * mix(0.5, 0.3, emph)) * (1.0 - 0.35 * submerged * close);
      color = vec4f(rgb, a);
      // Pixel limits measured across the line on screen: a street seen at a grazing angle across the view is
      // foreshortened by the sine of the view elevation, and a fixed ground width would thin it to nothing.
      let across = dot(vec3f(perp.x, 0.0, perp.y), toCenter / max(d0, 1e-3));
      let pxM = d0 * F.elev.w / max(sqrt(max(1.0 - across * across, 0.0)), 0.3);
      minHalfPx = 0.0;
      let evacScale = mix(1.0, 1.25, emph * (1.0 - close));
      let calm = mix(1.0, 0.7, close);
      let minPx = mix(mix(1.05, 1.3, importance), mix(0.6, 0.95, importance), farOff) * evacScale * calm;
      halfW = clamp(0.3 * v.attr.z, minPx * pxM, max(1.6 * evacScale * calm, minPx) * pxM);
      coreFrac = 0.0; // flag for the fragment shader: dashed
    }
  } else if (kind == 1u) {
    lift = 1.2;
    minHalfPx = 9.0;
    color = O.routeColor;
    coreFrac = 0.28;
  } else {
    lift = 0.6;
    minHalfPx = 1.6;
    color = O.cursorColor;
  }
  let centerW = gridToWorld(v.center, top) + vec3f(0.0, lift, 0.0);
  let dist = length(centerW - F.camPos);
  halfW = max(halfW, dist * F.elev.w * minHalfPx);
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

/** Anti-aliased dash (on for 62 % of each unit period) at dash coordinate x with screen-space width fw. */
fn dashPattern(x: f32, fw: f32) -> f32 {
  let f = fract(x);
  return smoothstep(0.0, fw, f) * (1.0 - smoothstep(0.62, 0.62 + fw, f));
}

@fragment
fn fsRibbon(in: ROut) -> @location(0) vec4f {
  let a = abs(in.side);
  let aw = fwidth(in.side);
  let haze = hazeAmount(in.world);
  // Dashes for flooded roads: ~12 px period on screen, snapped to power-of-two lengths on the ground and cross-faded
  // between neighbouring octaves, so the dashes stay put on the road while the camera orbits or zooms instead of
  // crawling along it. Derivatives in uniform control flow.
  let dashLog = log2(max(distance(in.world, F.camPos) * F.elev.w * 12.0, 1e-3));
  let dashOct = floor(dashLog);
  let dashMix = dashLog - dashOct;
  let dashLen = pow(2.0, dashOct);
  let dashFw = max(fwidth(in.along) / dashLen, 1e-4);
  if (in.kind == 0u) {
    if (in.coreFrac < 0.5) {
      // Flooded road: dashes ~7–15 px long every ~12–24 px, no casing. The line is only 2–4 px wide, so its
      // anti-aliased edge sits mostly outside the core (a centred ramp would halve its coverage).
      let body = 1.0 - smoothstep(1.0 - aw * 0.8, 1.0 + aw * 0.3, a);
      let dash = mix(dashPattern(in.along / dashLen, dashFw), dashPattern(in.along / (2.0 * dashLen), dashFw * 0.5), dashMix);
      let alpha = in.color.a * body * mix(dash, 0.6, smoothstep(0.3, 0.6, dashFw)) * (1.0 - haze * 0.7);
      return vec4f(in.color.rgb * alpha, alpha);
    }
    // Road: bright core with a dark casing for contrast over imagery (the casing fades when the ribbon is only a
    // couple of pixels wide, where it would just darken the line).
    let body = 1.0 - smoothstep(1.0 - aw * 1.5, 1.0, a);
    let casing = smoothstep(0.55 - aw, 0.7 + aw, a) * (1.0 - smoothstep(0.35, 0.8, aw));
    let rgb = mix(in.color.rgb * 1.15, in.color.rgb * 0.12, casing * 0.8);
    let alpha = in.color.a * body * (1.0 - haze * 0.7);
    return vec4f(rgb * alpha, alpha);
  }
  if (in.kind == 1u) {
    // Evacuation route: bright HDR core (feeds bloom) with animated chevrons marching toward the shelter, inside a
    // soft additive halo. Blocked routes turn red and pulse instead of marching.
    let blocked = O.routeState > 1.5;
    let core = 1.0 - smoothstep(in.coreFrac - aw, in.coreFrac + aw, a);
    let halo = exp(-a * a * 3.0) * (1.0 - core);
    let dash = O.routeDash;
    let chevron = fract(in.along / dash - a * 0.45 - F.time * 1.1);
    let on = select(smoothstep(0.0, 0.1, chevron) * (1.0 - smoothstep(0.45, 0.55, chevron)), 1.0, blocked);
    let pulse = select(1.0, 0.45 + 0.55 * (0.5 + 0.5 * sin(F.time * 5.5)), blocked);
    let coreCol = mix(in.color.rgb * 1.2, vec3f(2.2) + in.color.rgb * 3.0, on);
    let rgb = (coreCol * core + in.color.rgb * halo * 1.6) * pulse * (1.0 - haze * 0.5);
    let alpha = min(1.0, core * 0.9 + halo * 0.25);
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
  // Derivatives must be taken in uniform control flow.
  let ringU = atan2(in.local.z, in.local.x) * length(in.local.xz) / 9.0;
  let ringFw = fwidth(ringU);
  let ghostCoord = (in.world.x + in.world.z) / 5.0 + in.world.y / 2.5 - F.time * 0.5;
  let ghostFw = fwidth(ghostCoord);
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
      // Storm rain shaft: soft falling streaks that average out to a translucent veil when they get sub-pixel. The
      // veil is densest through the middle of the shaft and thins toward its silhouette (optical depth through a
      // cylinder), fades into the cloud base above and thins near the ground, so it reads as rain, not a glass tube.
      let colId = floor(ringU);
      let fu = fract(ringU);
      let speed = 0.8 + hash11(colId) * 0.7;
      let v = fract(in.world.y / 140.0 + F.time * speed + hash11(colId + 3.0));
      let fall = smoothstep(0.0, 0.12, v) * (1.0 - smoothstep(0.3, 0.85, v));
      let across = smoothstep(0.0, 0.4, fu) * (1.0 - smoothstep(0.6, 1.0, fu));
      let detail = 1.0 - smoothstep(0.25, 0.8, ringFw);
      let streak = mix(0.35, fall * across, detail);
      let facing = abs(dot(n, V));
      let chord = mix(0.12, 1.0, pow(facing, 0.8));
      // params.z carries the cloud-base elevation (m); the shaft starts a little below the lowest terrain.
      let bottom = F.elev.x - 5.0;
      let hFrac = clamp((in.world.y / F.exag - bottom) / max(in.size - bottom, 1.0), 0.0, 1.0);
      let vertical = smoothstep(0.0, 0.25, hFrac) * 0.55 + 0.45 * (1.0 - smoothstep(0.55, 1.0, hFrac));
      let wisps = 0.7 + 0.6 * vnoise(vec2f(atan2(in.local.z, in.local.x) * 3.0, in.world.y / 400.0 - F.time * 0.05));
      // Camera inside the curtain: every wall fragment lies between the eye and the flooded ground the user came
      // to look at, so the curtain thins to a light veil (it still marks the storm from outside).
      let axis = in.world - in.local;
      let camR = length((F.camPos - axis).xz) / max(length(in.local.xz), 1.0);
      let inside = 1.0 - smoothstep(0.85, 1.15, camR);
      let a = in.color.a * (0.45 + 0.8 * streak) * chord * vertical * wisps * mix(1.0, 0.3, inside);
      let rgb = in.color.rgb * (0.75 + 0.5 * streak) * (skyAmbient(vec3f(0.0, 1.0, 0.0)) * 0.9 + 0.1);
      return vec4f(rgb * a, a);
    }
    case 3u: {
      // Storm cloud: soft-edged, noisy, lit from above (params.z carries the cloud radius in meters).
      let rr = length(in.local.xz) / max(in.size, 1.0);
      let t = F.time * 0.02;
      let nz = vnoise(in.local.xz / max(in.size, 1.0) * 3.0 + vec2f(t, -t * 0.7)) * 0.6
             + vnoise(in.local.xz / max(in.size, 1.0) * 9.0 - vec2f(t * 1.7, t)) * 0.4;
      let edge = 1.0 - smoothstep(0.45, 1.0, rr + (nz - 0.5) * 0.35);
      // The deck is a marker, not a ceiling: seen from above (camera over the deck and within/near its footprint,
      // or looking steeply down on it) it all but disappears so the storm's flooding underneath stays readable.
      // From the side / below it keeps its full body.
      let center = in.world - in.local;
      let rel = F.camPos - center;
      let above = smoothstep(0.0, 0.08, rel.y / max(in.size, 1.0));
      let over = 1.0 - smoothstep(0.9, 1.8, length(rel.xz) / max(in.size, 1.0));
      let steep = smoothstep(0.3, 0.85, V.y);
      let seeThrough = above * max(over, steep);
      // Camera inside the deck (zooming in under a storm passes through it): every fragment of its body lies between
      // the eye and the ground and the view turned uniformly grey, so the deck fades out around the camera. The body is
      // an ellipsoid of radius size and half-thickness max(0.18·R, 40) with R = size / 1.3 (cloudDeckHalfThickness).
      let halfThick = max(in.size / 1.3 * 0.18, 40.0);
      let inDeck = 1.0 - smoothstep(0.9, 1.4, length(vec2f(length(rel.xz) / max(in.size, 1.0), rel.y / halfThick)));
      let a = in.color.a * edge * (0.65 + 0.35 * nz) * mix(1.0, 0.03, max(seeThrough, inDeck));
      let top = max(n.y, 0.0);
      let lum = luminance(F.skyHorizon);
      let rgb = in.color.rgb * lum * (0.55 + 0.9 * top + 0.35 * nz) + F.sunColor * top * 0.04 * (1.0 - F.opts.w);
      return vec4f(rgb * a, a);
    }
    case 4u: {
      // Wall preview ghost: translucent amber with moving hazard stripes (anti-aliased, fading when too fine) and
      // a bright crest line at the planned height (params.z carries the height in meters).
      let sw = max(ghostFw, 1e-4);
      let tri = abs(fract(ghostCoord) - 0.5) * 2.0;
      let stripes = mix(0.5, smoothstep(0.5 - sw, 0.5 + sw, tri), 1.0 - smoothstep(0.2, 0.6, sw));
      let facing = abs(dot(n, V));
      let edge = pow(1.0 - facing, 2.0);
      let crest = smoothstep(0.85, 1.0, in.local.y / max(in.size, 0.01)) + select(0.0, 0.6, n.y > 0.9);
      let a = in.color.a * (0.3 + 0.25 * stripes + 0.35 * edge + 0.3 * crest);
      let rgb = in.color.rgb * (1.1 + 0.9 * stripes + edge * 1.2 + crest * 2.5);
      return vec4f(rgb * a, min(a, 1.0));
    }
    case 6u: {
      // Stage gauge staff: red/white survey stripes (10 bands along the staff) with a tiny bit of lighting.
      let band = step(0.5, fract(in.local.y * 10.0));
      let ndl = max(dot(n, F.sunDir), 0.0);
      let base = mix(vec3f(0.9, 0.9, 0.88), vec3f(0.8, 0.07, 0.05), band);
      var rgb = base * (F.sunColor * ndl * 0.6 + skyAmbient(n) * 1.1) + base * 0.3;
      rgb = mix(rgb, skyRadiance(-V), haze);
      return vec4f(rgb, 1.0);
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
