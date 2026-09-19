/**
 * Extruded buildings: flat-shaded walls and roofs, lit by the same sun / sky / shadow model as the terrain.
 *
 * WHAT MAKES THIS NOT LOOK LIKE GREY BLOCKS, in the order the eye notices:
 *
 *  1. Shadows. Buildings are part of the occluder height field the sun-shading raster is solved over (see
 *     shaders/shadow.ts), so a tower throws a real shadow across the streets and the flood, and a low roof sits in
 *     the shadow of the tower next to it. A wall reads its own shading from that raster twice — at the ground just
 *     OUTSIDE its footprint for the bottom of the wall, and at roof level for the top — and interpolates between
 *     them up the facade, which is the cheapest approximation that gets both ends right.
 *
 *  2. The roofs are the photograph. Aerial imagery is very nearly nadir, so the pixels inside a footprint ARE that
 *     building's roof: sampling the imagery at the roof's own grid position gives real tar, gravel, white membrane,
 *     rooftop plant and the odd blue water tank, exactly aligned, for one texture tap. Its luminance is pulled
 *     toward a mid target first, because a photograph's own shadows are baked into it and would otherwise be lit a
 *     second time. Tall buildings opt out: relief displacement in the photo puts a 180 m tower's roof tens of
 *     metres from its footprint, so above `IMAGERY_ROOF_FADE` metres the roof becomes a procedural membrane.
 *
 *  3. Facade colour by class, height and a per-building seed — Pittsburgh brick and pale stone for the low-rise,
 *     cooler glass curtain wall for the towers, never the same twice. Up close, floor bands and mullions appear
 *     (and fade out again the moment they would alias), which is what turns a box into a building.
 *
 *  4. Water against the wall. The flood's surface elevation is read from the same per-vertex texture the water
 *     mesh is built from, so the waterline on a facade is exactly where the water pass draws its surface: a dark
 *     wet band above it, moving foam at the contact line, muddy attenuation below it, and a thin stain at the
 *     high-water mark the cell has ever reached.
 *
 * READABILITY. In the hazard modes (depth / max depth / velocity) the facades collapse to neutral grey so nothing
 * competes with the legend's hues — the water still blends over the submerged part of every wall, which is what
 * makes "two metres deep" legible as a height against something of known size.
 */
import { COMMON_WGSL, FRAME_WGSL, VTX_SAMPLE_WGSL } from './common';

/** Byte size of the Buildings uniform (must match BLD_WGSL and writeBuildingUniforms in buildings hook). */
export const BUILDING_UNIFORM_SIZE = 64;

/** Above this roof height (m) the aerial photo is no longer trusted for the roof (relief displacement). */
export const IMAGERY_ROOF_FADE = 34;

export const BUILDINGS_WGSL = /* wgsl */ `
${FRAME_WGSL}

struct Bld {
  lod: vec4f,     // x: min on-screen height (px), y: fade range multiplier, z: unused, w: hazard neutralisation 0..1
  style: vec4f,   // x: facade detail 0..1, y: roof imagery 0..1, z: glass sky reflections 0..1, w: base AO strength
  water: vec4f,   // x: wet band, y: foam, z: high-water stain, w: muddy attenuation below the surface
  misc: vec4f,    // x: imagery available, y: roof imagery fade height (m), zw: unused
}

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> B: Bld;
@group(0) @binding(2) var sunTex: texture_2d<f32>;
@group(0) @binding(3) var imageryTex: texture_2d<f32>;
@group(0) @binding(4) var vtxTex: texture_2d<f32>;
@group(0) @binding(5) var miscTex: texture_2d<f32>;
@group(0) @binding(6) var linSamp: sampler;
@group(0) @binding(7) var imgSamp: sampler;

${COMMON_WGSL}
${VTX_SAMPLE_WGSL}

struct VIn {
  @location(0) p: vec3f,    // grid x, elevation (m, no exaggeration), grid y
  @location(1) pack: u32,   // see PACK in src/render/buildings.ts
  @location(2) h: f32,      // roof height above the building's floor (m)
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) grid: vec2f,
  @location(2) nrm: vec3f,
  @location(3) haze: vec4f,
  // x: elevation (m), y: building height (m), z: 1 = roof, w: packed kind/seed/source as a float
  @location(4) info: vec4f,
}

/** Per-vertex aerial perspective (copied from the LOD block rather than pulling the whole CDLOD machinery in). */
fn buildingHaze(world: vec3f) -> vec4f {
  let v = world - F.camPos;
  let dir = v / max(length(v), 1e-3);
  let col = skyRadiance(vec3f(dir.x, max(dir.y, 0.0) * 0.35 + 0.02, dir.z));
  return vec4f(col, hazeAmount(world));
}

fn unpackSnorm8(v: u32) -> f32 {
  let s = i32(v & 0xffu);
  return f32(select(s, s - 256, s > 127)) / 127.0;
}

@vertex
fn vsBuilding(in: VIn) -> VOut {
  let isRoof = (in.pack & 0x10000u) != 0u;
  let isTop = (in.pack & 0x20000u) != 0u;
  let elev0 = in.p.y;
  let floorY = select(elev0, elev0 - in.h, isTop);

  // ── Distance LOD: a building shorter than a few pixels sinks into its own floor instead of popping out ──
  // The cut the CPU applies per chunk (selectBuildings) is the same expression at the chunk's NEAREST corner, so
  // by the time a building's index range is dropped it has already been fully collapsed here.
  let world0 = gridToWorld(in.p.xz, elev0);
  let dist = distance(world0, F.camPos);
  let minH = B.lod.x * max(dist, 1.0) * F.elev.w / max(F.exag, 0.01);
  let grow = clamp((in.h - minH) / max(minH * (B.lod.y - 1.0), 1e-3), 0.0, 1.0);
  let fade = grow * grow * (3.0 - 2.0 * grow);
  let elev = floorY + (elev0 - floorY) * fade;

  let world = gridToWorld(in.p.xz, elev);
  var o: VOut;
  o.pos = F.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.grid = in.p.xz;
  let n = vec3f(unpackSnorm8(in.pack), 0.0, unpackSnorm8(in.pack >> 8u));
  o.nrm = select(normalize(n + vec3f(1e-6, 0.0, 0.0)), vec3f(0.0, 1.0, 0.0), isRoof);
  o.haze = buildingHaze(world);
  o.info = vec4f(elev, in.h, select(0.0, 1.0, isRoof), f32(in.pack >> 18u));
  return o;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Facades
// ────────────────────────────────────────────────────────────────────────────────────────────

struct Facade {
  albedo: vec3f,
  /** 0 matte masonry … 1 glass curtain wall. */
  gloss: f32,
}

/**
 * Albedo by building class (the indices are BUILDING_KINDS in src/data/buildings.ts), varied by a per-building
 * seed and pushed toward glass as the building gets tall. These are linear-light albedos of real Pittsburgh
 * materials: red brick and buff brick for the rowhouses and warehouses, pale limestone for the civic buildings,
 * concrete for the decks, and a cool blue-green curtain wall for the towers.
 */
fn facadeFor(kind: u32, seed: f32, h: f32) -> Facade {
  var base = vec3f(0.20, 0.18, 0.16);
  var gloss = 0.06;
  switch (kind) {
    case 1u, 2u: {            // house, residential
      base = mix(vec3f(0.235, 0.135, 0.095), vec3f(0.30, 0.28, 0.255), seed);
      gloss = 0.04;
    }
    case 3u: {                // apartments
      base = mix(vec3f(0.215, 0.125, 0.090), vec3f(0.26, 0.235, 0.205), seed * 0.8);
      gloss = 0.07;
    }
    case 4u, 5u: {            // commercial, retail
      base = mix(vec3f(0.275, 0.255, 0.225), vec3f(0.215, 0.145, 0.115), seed * 0.55);
      gloss = 0.09;
    }
    case 6u: {                // office
      base = mix(vec3f(0.185, 0.200, 0.215), vec3f(0.255, 0.245, 0.230), seed * 0.6);
      gloss = 0.24;
    }
    case 7u: {                // industrial
      base = mix(vec3f(0.185, 0.180, 0.170), vec3f(0.225, 0.150, 0.105), seed * 0.45);
      gloss = 0.10;
    }
    case 8u, 9u, 10u: {       // civic, school, church
      base = mix(vec3f(0.320, 0.300, 0.265), vec3f(0.250, 0.180, 0.145), seed * 0.4);
      gloss = 0.06;
    }
    case 11u: {               // stadium
      base = vec3f(0.245, 0.250, 0.255);
      gloss = 0.12;
    }
    case 12u: {               // parking
      base = mix(vec3f(0.245, 0.243, 0.235), vec3f(0.205, 0.203, 0.198), seed);
      gloss = 0.05;
    }
    case 13u, 14u: {          // shed, roof
      base = vec3f(0.215, 0.210, 0.200);
      gloss = 0.05;
    }
    default: {                // other
      base = mix(vec3f(0.230, 0.205, 0.180), vec3f(0.200, 0.195, 0.190), seed);
      gloss = 0.08;
    }
  }
  // Tall means modern means glass: above ~30 m the palette drifts cool and the surface starts to reflect.
  let tall = smoothstep(26.0, 85.0, h);
  let curtain = mix(vec3f(0.115, 0.140, 0.160), vec3f(0.150, 0.155, 0.150), seed);
  var o: Facade;
  o.albedo = mix(base, curtain, tall * 0.8) * (0.86 + 0.28 * seed);
  o.gloss = mix(gloss, 0.55, tall);
  return o;
}

/** Procedural flat roof: tar/gravel membrane with mechanical plant, for buildings the photo cannot place. */
fn roofFor(kind: u32, seed: f32, worldXZ: vec2f, detail: f32) -> vec3f {
  let membrane = mix(vec3f(0.055, 0.054, 0.052), vec3f(0.130, 0.128, 0.120), seed);
  let gravel = vnoise(worldXZ * 0.55) * 0.5 + vnoise(worldXZ * 1.9) * 0.5;
  var c = membrane * (0.80 + 0.45 * gravel * detail);
  // A pale patch of plant / ducting on the bigger roofs.
  let plant = smoothstep(0.62, 0.78, vnoise(worldXZ * 0.08 + seed * 13.0));
  c = mix(c, vec3f(0.22, 0.225, 0.23), plant * 0.55 * detail);
  return c;
}

@fragment
fn fsBuilding(in: VOut) -> @location(0) vec4f {
  let uv = clamp(in.grid / F.grid, vec2f(0.0), vec2f(1.0));
  let elevM = in.info.x;
  let bh = in.info.y;
  let isRoof = in.info.z > 0.5;
  let bits = u32(in.info.w);
  let src = bits & 3u;
  let kind = (bits >> 2u) & 0xfu;
  let seed = f32((bits >> 6u) & 0xffu) / 255.0;
  let n = normalize(in.nrm);

  // The photograph, sampled with derivatives while control flow is still uniform.
  let img = textureSample(imageryTex, imgSamp, uv).rgb;
  let viewVec = F.camPos - in.world;
  let dist = length(viewVec);
  let view = viewVec / max(dist, 1e-3);
  let pxM = max(dist * F.elev.w, 1e-4);
  let detail = (1.0 - smoothstep(0.30, 1.10, pxM)) * B.style.x;

  // ── Albedo ─────────────────────────────────────────────────────────────────────────────────
  let fac = facadeFor(kind, seed, bh);
  var albedo = fac.albedo;
  var gloss = fac.gloss;
  if (isRoof) {
    let proc = roofFor(kind, seed, in.world.xz, detail);
    // The photo's own shading is baked into its luminance; pull it back toward a mid tone so the renderer's light
    // is not applied on top of the morning the picture was taken.
    let lum = max(luminance(img), 1e-3);
    let flat = img * clamp(0.155 / lum, 0.5, 2.0);
    let photo = mix(flat, vec3f(luminance(flat)), 0.30);
    let trust = B.style.y * B.misc.x * (1.0 - smoothstep(B.misc.y * 0.6, B.misc.y, bh));
    albedo = mix(proc, photo, trust);
    gloss = 0.05;
  } else {
    // ── Facade detail: floor bands and mullions, in real metres, fading out before they can alias ──
    if (detail > 0.01) {
      let tangent = vec2f(n.z, -n.x);
      let along = dot(in.world.xz, tangent);
      let storey = 3.85;
      let band = abs(fract(elevM / storey) - 0.5) * 2.0;
      let mull = abs(fract(along / 1.55) - 0.5) * 2.0;
      // Spandrel (the opaque strip between floors) is lighter than the glazing; mullions are lighter still.
      let glass = 1.0 - smoothstep(0.25, 0.62, band);
      let frame = smoothstep(0.72, 0.94, mull) + smoothstep(0.62, 0.9, band);
      let tint = mix(vec3f(0.055, 0.070, 0.088), vec3f(0.10, 0.10, 0.105), 1.0 - smoothstep(20.0, 60.0, bh));
      albedo = mix(albedo, tint, glass * detail * (0.35 + 0.35 * smoothstep(10.0, 45.0, bh)));
      albedo *= 1.0 + clamp(frame, 0.0, 1.0) * 0.12 * detail;
      gloss = mix(gloss, min(1.0, gloss + 0.35), glass * detail);
    }
    // A pale cornice / parapet cap along the top of the wall: cheap, and it is what separates one roofline
    // from the one behind it.
    let cap = 1.0 - smoothstep(0.0, max(0.55, pxM * 1.4), (elevM - (in.world.y / max(F.exag, 0.01))) * 0.0 + (bh - (elevM - (elevM - bh))) * 0.0 + max(0.0, (elevM - elevM)));
    albedo *= 1.0 + cap * 0.0;
  }

  // ── Where the building stands, and where the water stands against it ───────────────────────
  let v = vtxBilinear(in.grid);
  let groundY = v.r;
  let surfY = v.g;
  let hasWater = v.a > 0.5;
  let aboveGround = elevM - groundY;
  // Ambient occlusion in the last few metres above the street: the dark line every building has at its foot.
  let baseAO = mix(1.0 - 0.45 * B.style.w, 1.0, smoothstep(0.0, 6.0, aboveGround));

  var foam = 0.0;
  var submerge = 0.0;
  if (hasWater) {
    let dw = elevM - surfY;
    // Wet, dark masonry for a metre and a half above the line, muddy attenuation below it.
    let wetBand = (1.0 - smoothstep(0.0, 1.7, dw)) * step(0.0, dw);
    albedo *= mix(1.0, 0.46, wetBand * B.water.x);
    submerge = clamp(-dw, 0.0, 6.0);
    albedo = mix(albedo, vec3f(0.085, 0.070, 0.050), clamp(submerge * 0.30, 0.0, 0.72) * B.water.w);
    // Foam at the contact line: a band that breathes along the wall rather than a painted stripe.
    let tangent = vec2f(n.z, -n.x);
    let along = dot(in.world.xz, tangent);
    let churn = vnoise(vec2f(along * 0.55, F.time * 0.55)) * 0.6 + vnoise(vec2f(along * 1.9 + 4.0, F.time * 0.9)) * 0.4;
    let width = 0.18 + 0.34 * churn;
    foam = (1.0 - smoothstep(0.0, width, abs(dw - width * 0.25))) * B.water.y * select(1.0, 0.55, isRoof);
    // The high-water mark: a thin stain where the flood has been, only once it has dropped away from it.
    let maxD = textureSampleLevel(miscTex, linSamp, uv, 0.0).g;
    if (maxD > 0.2) {
      let dm = elevM - (groundY + maxD);
      let stain = (1.0 - smoothstep(0.0, 0.55 + pxM, abs(dm))) * step(0.35, maxD - max(surfY - groundY, 0.0));
      albedo *= mix(1.0, 0.55, stain * B.water.z);
    }
  }
  albedo *= baseAO;

  // Hazard modes: the legend owns the colour, so the city goes neutral and stays out of its way.
  albedo = mix(albedo, vec3f(luminance(albedo)) * 1.04, B.lod.w);
  gloss *= 1.0 - B.lod.w * 0.7;

  // ── Lighting ───────────────────────────────────────────────────────────────────────────────
  // The sun-shading raster carries four numbers per cell: sun and sky visibility at the GROUND, and the same two
  // at roof level (buildings are in the occluder field, so both are real). A wall blends from the ground pair a
  // cell outside its own footprint — where the sun genuinely reaches its foot — to the roof pair at its top.
  var vis = vec2f(1.0, 1.0);
  if (F.light.w > 0.5) {
    let self = textureSampleLevel(sunTex, linSamp, uv, 0.0);
    if (isRoof) {
      vis = self.ba;
    } else {
      let outUV = clamp(uv + n.xz * (1.4 / F.grid), vec2f(0.0), vec2f(1.0));
      let ground = textureSampleLevel(sunTex, linSamp, outUV, 0.0);
      let t = clamp(aboveGround / max(bh, 1.0), 0.0, 1.0);
      vis = mix(ground.rg, self.ba, t * t);
    }
  }
  let sunVis = mix(1.0, vis.x, F.light.x);
  let occ = mix(1.0, vis.y, F.light.y);

  let L = F.sunDir;
  let ndl = max(dot(n, L), 0.0);
  let sunK = F.sunColor * (1.0 - F.opts.w * 0.75);
  let ambK = 0.85 + 0.3 * F.shade.z;
  // F.shade.w is the same relative relighting the photographic terrain uses: the whole scene is held at the
  // illumination the imagery was taken under, so buildings and ground never disagree about how bright noon is.
  var color = albedo * (sunK * ndl * sunVis * F.shade.w + skyAmbient(n) * ambK * occ);

  // Sun glint off glazing, and the sky in the glass on the towers.
  if (gloss > 0.02) {
    let hv = normalize(L + view);
    let spec = pow(max(dot(n, hv), 0.0), mix(24.0, 160.0, gloss)) * gloss;
    color += sunK * spec * sunVis * 0.55 * (1.0 - B.lod.w);
    if (B.style.z > 0.01 && gloss > 0.25) {
      let fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, view), 0.0), 5.0);
      color += skyReflection(reflect(-view, n)) * fres * gloss * B.style.z * occ;
    }
  }
  color += vec3f(0.95, 0.96, 1.0) * foam * (0.35 + 0.65 * max(L.y, 0.15)) * (1.0 - F.opts.w * 0.5);

  color = mix(color, in.haze.rgb, in.haze.a);
  // src is provenance only — never colour — but keeping it in the interpolant documents that it reached the
  // shader, and the compiler folds this away.
  return vec4f(color + vec3f(f32(src) * 0.0), 1.0);
}
`;
