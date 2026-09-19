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

/** Byte size of the Buildings uniform (must match `Bld` below and writeBuildingUniforms in index.ts). */
export const BUILDING_UNIFORM_SIZE = 64;

/** Above this roof height (m) the aerial photo is no longer trusted for the roof (relief displacement). */
export const IMAGERY_ROOF_FADE = 34;

/**
 * Ambient multiplier for buildings over the terrain's. A wall sees the street and the facades opposite it as well
 * as the sky, and both of those are lit; without the extra fill every north face renders as a silhouette.
 */
export const BUILDING_AMBIENT = 1.45;
/** Fraction of the sun's beam that reaches a wall having bounced off the ground and the buildings around it. */
export const URBAN_BOUNCE = 0.18;
/** Extinction of flood water, per metre of path. Muddy river water, not a swimming pool. */
export const MUD_EXTINCTION = 0.62;
/** Depth (m) past which a submerged surface is dropped outright and the water pass owns the pixel. */
export const SUBMERGED_CUT = 2.2;

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

const BUILDING_AMBIENT: f32 = ${BUILDING_AMBIENT.toFixed(3)};
const URBAN_BOUNCE: f32 = ${URBAN_BOUNCE.toFixed(3)};
const MUD_EXTINCTION: f32 = ${MUD_EXTINCTION.toFixed(3)};
const SUBMERGED_CUT: f32 = ${SUBMERGED_CUT.toFixed(3)};
/** What is left when the flood is deep enough to swallow a wall whole. */
const DEEP_FLOOD: vec3f = vec3f(0.013, 0.017, 0.014);

struct VIn {
  @location(0) p: vec3f,    // grid x, elevation (m, no exaggeration), grid y
  @location(1) pack: u32,   // see PACK in src/render/buildings.ts
  @location(2) h: f32,      // roof height above the building's floor (m)
}

struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) grid: vec2f,
  // Flat by construction: every vertex of a wall quad carries the same outward normal, every roof vertex is up.
  @location(2) @interpolate(flat) nrm: vec3f,
  @location(3) haze: vec4f,
  // x: elevation (m), y: floor elevation, z: roof elevation (after the LOD collapse), w: true roof height (m)
  @location(4) geom: vec4f,
  @location(5) @interpolate(flat) bits: u32,
}

/** Per-vertex aerial perspective (copied from the CDLOD block rather than pulling the whole machinery in). */
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
  // The cut the CPU applies per chunk (selectBuildings) is the same expression evaluated at the chunk's NEAREST
  // corner, so by the time a building's index range is dropped it has already been fully collapsed here. The
  // floor is metres below the ground, so a collapsed building is under the terrain, not a decal on it.
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
  o.geom = vec4f(elev, floorY, floorY + in.h * fade, in.h);
  o.bits = in.pack >> 16u;
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
 * concrete for the decks, and a cool curtain wall for the towers.
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
  // Above ~26 m the palette becomes a tower's. Downtown Pittsburgh is not one material: limestone and pale
  // concrete (Gulf Tower, Koppers), the rust-brown Cor-Ten of the U.S. Steel Tower, and dark glass curtain wall
  // (PPG Place, Fifth Avenue Place). The seed picks between the three, so the skyline reads as a skyline and not
  // as one building repeated.
  let tall = smoothstep(26.0, 85.0, h);
  var tower = vec3f(0.300, 0.285, 0.255);   // limestone / pale precast
  var towerGloss = 0.16;
  if (seed > 0.62) {
    tower = mix(vec3f(0.085, 0.105, 0.125), vec3f(0.120, 0.135, 0.140), fract(seed * 7.0));  // dark curtain wall
    towerGloss = 0.62;
  } else if (seed > 0.30) {
    tower = mix(vec3f(0.155, 0.095, 0.062), vec3f(0.215, 0.160, 0.115), fract(seed * 11.0)); // bronze / Cor-Ten
    towerGloss = 0.34;
  }
  var o: Facade;
  o.albedo = mix(base, tower, tall * 0.88) * (0.88 + 0.24 * fract(seed * 3.0));
  o.gloss = mix(gloss, towerGloss, tall);
  return o;
}

/**
 * Procedural flat roof, for buildings the photo cannot place: dark tar and gravel through pale reflective
 * membrane, with a patch of mechanical plant. A city roofscape is genuinely darker than its streets — but not
 * black, which is what a literal tar albedo renders as once the tonemapper has had it.
 */
fn roofFor(seed: f32, worldXZ: vec2f, detail: f32) -> vec3f {
  let membrane = mix(vec3f(0.085, 0.083, 0.078), vec3f(0.240, 0.238, 0.228), seed * seed);
  let gravel = vnoise(worldXZ * 0.55) * 0.5 + vnoise(worldXZ * 1.9) * 0.5;
  let c = membrane * (0.85 + 0.35 * gravel * detail);
  let plant = smoothstep(0.60, 0.78, vnoise(worldXZ * 0.08 + seed * 13.0));
  return mix(c, vec3f(0.26, 0.265, 0.27), plant * 0.6 * detail);
}

@fragment
fn fsBuilding(in: VOut) -> @location(0) vec4f {
  let uv = clamp(in.grid / F.grid, vec2f(0.0), vec2f(1.0));
  let elevM = in.geom.x;
  let floorY = in.geom.y;
  let roofY = in.geom.z;
  let bh = in.geom.w;
  let isRoof = (in.bits & 1u) != 0u;
  let kind = (in.bits >> 4u) & 0xfu;
  let seed = f32((in.bits >> 8u) & 0xffu) / 255.0;
  let n = normalize(in.nrm);

  // The photograph, sampled with derivatives while control flow is still uniform.
  let img = textureSample(imageryTex, imgSamp, uv).rgb;
  let viewVec = F.camPos - in.world;
  let dist = length(viewVec);
  let view = viewVec / max(dist, 1e-3);
  let pxM = max(dist * F.elev.w, 1e-4);
  // Two detail fades, because the two features have different periods and therefore alias at different distances:
  // floor bands repeat every ~4 m, mullions every ~1.5 m. Both are gone well before they reach a pixel.
  let bandFade = (1.0 - smoothstep(0.22, 0.80, pxM)) * B.style.x;
  let mullFade = (1.0 - smoothstep(0.09, 0.32, pxM)) * B.style.x;
  let detail = max(bandFade, mullFade);

  // ── Albedo ─────────────────────────────────────────────────────────────────────────────────
  let fac = facadeFor(kind, seed, bh);
  var albedo = fac.albedo;
  var gloss = fac.gloss;
  /** How much of this surface's albedo came straight out of the aerial photograph (roofs only). */
  var photoTrust = 0.0;
  if (isRoof) {
    let proc = roofFor(seed, in.world.xz, detail);
    // A near-nadir aerial photo of a flat roof IS that roof, already lit by the sun it was taken under — which is
    // exactly what the terrain shader assumes about the draped ground. So a trusted roof takes the photograph as
    // its albedo, and with it the terrain's flat-ground lighting convention and the terrain's plain sky ambient
    // (both applied under "Lighting" below). A warehouse roof then renders to the colour the photograph had at that
    // pixel, and the city rises out of the picture instead of replacing it with slabs: measured near-nadir over
    // the Strip District at the 1936 crest, roofs were coming out at 0.6x the brightness of the ground around
    // them, so every building read as a hole punched in the flood.
    //
    // The evening below — pulling luminance toward a mid tone so the renderer's light is not applied on top of
    // the morning the picture was taken — is what the UNTRUSTED side needs: the procedural membrane on a tower
    // whose roof the photo puts tens of metres from its footprint. So it stays, on that side of the mix only.
    let lum = max(luminance(img), 1e-3);
    let evened = img * clamp(0.175 / lum, 0.55, 2.2);
    let trust = B.style.y * B.misc.x * (1.0 - smoothstep(B.misc.y * 0.6, B.misc.y, bh));
    albedo = mix(mix(proc, evened, 0.3), img, trust);
    photoTrust = trust;
    gloss = 0.05;
  } else {
    // ── Facade detail: floor bands and mullions, in real metres, fading out before they can alias ──
    if (detail > 0.01) {
      let tangent = vec2f(n.z, -n.x);
      let along = dot(in.world.xz, tangent);
      // Storey height varies a little per building (3.4–4.3 m): identical banding on every tower is the single
      // most model-like thing a city of boxes can do.
      let storey = 3.4 + 0.9 * fract(seed * 5.0);
      let band = abs(fract(elevM / storey) - 0.5) * 2.0;
      let mull = abs(fract(along / (1.35 + 0.5 * fract(seed * 13.0))) - 0.5) * 2.0;
      // The glazing is darker than the spandrel between floors, and the mullions and floor edges catch the light.
      // A split rather than a sine — the line where the two meet is what the eye reads as a storey — and kept
      // deliberately quiet: at this scale the job is to break the flatness, not to draw windows.
      let glass = (1.0 - smoothstep(0.28, 0.46, band)) * bandFade;
      let frame = smoothstep(0.80, 0.97, mull) * mullFade + smoothstep(0.80, 0.96, band) * bandFade;
      let tint = mix(vec3f(0.115, 0.115, 0.120), vec3f(0.070, 0.085, 0.100), smoothstep(12.0, 55.0, bh));
      albedo = mix(albedo, tint, glass * (0.10 + 0.16 * smoothstep(10.0, 45.0, bh)));
      albedo *= 1.0 + clamp(frame, 0.0, 1.0) * 0.05;
      gloss = mix(gloss, min(1.0, gloss + 0.3), glass);
    }
    // Pale cornice along the top of the wall: it is what separates one roofline from the one behind it, and it
    // never gets thinner than a pixel.
    let cap = 1.0 - smoothstep(0.0, max(0.5, pxM * 1.6), roofY - elevM);
    albedo *= 1.0 + cap * 0.22;
  }

  // ── Where the building stands, and where the water stands against it ───────────────────────
  let v = vtxBilinear(in.grid);
  let groundY = v.r;
  let surfY = v.g;
  let hasWater = v.a > 0.5;
  let aboveGround = elevM - groundY;
  // Ambient occlusion in the last few metres above the street: the dark line every building has at its foot. Its
  // reach is a fraction of the building, not a fixed 6 m — on a 7 m rowhouse a fixed reach is the whole wall.
  let aoReach = clamp(bh * 0.45, 1.2, 6.0);
  let baseAO = mix(1.0 - 0.34 * B.style.w, 1.0, smoothstep(0.0, aoReach, aboveGround));

  var foam = 0.0;
  var submerged = 0.0;
  if (hasWater) {
    let dw = elevM - surfY;
    // Wet, dark masonry for a metre and a half above the line.
    let wetBand = (1.0 - smoothstep(0.0, max(1.7, pxM * 3.0), dw)) * step(0.0, dw);
    albedo *= mix(1.0, 0.46, wetBand * B.water.x);
    submerged = max(-dw, 0.0);
    // Foam at the contact line: a band that breathes along the wall rather than a painted stripe.
    let tangent = vec2f(n.z, -n.x);
    let along = dot(in.world.xz, tangent);
    let churn = vnoise(vec2f(along * 0.55, F.time * 0.55)) * 0.6 + vnoise(vec2f(along * 1.9 + 4.0, F.time * 0.9)) * 0.4;
    // Screen-space floor on the band, the same trick the levee profile uses: at 300 m a 30 cm line of foam is a
    // fifth of a pixel and simply is not there, and the buildings go back to standing on the water like cut-outs.
    let width = max(0.18 + 0.34 * churn, pxM * 1.6);
    foam = (1.0 - smoothstep(0.0, width, abs(dw - width * 0.25))) * B.water.y * select(1.0, 0.4, isRoof);
    // The high-water mark: a thin stain where the flood has been, once it has dropped away from it.
    let maxD = textureSampleLevel(miscTex, linSamp, uv, 0.0).g;
    let dm = elevM - (groundY + maxD);
    let stain = (1.0 - smoothstep(0.0, 0.55 + pxM, abs(dm))) * step(0.35, maxD - max(surfY - groundY, 0.0));
    albedo *= mix(1.0, 0.55, stain * B.water.z);
  }
  albedo *= baseAO;

  // Hazard modes: the legend owns the colour, so the city goes to one flat mid grey and stays out of its way —
  // not a desaturated version of itself, which would leave a dark brick rowhouse reading as a black hole next to
  // the depth ramp.
  albedo = mix(albedo, vec3f(0.30, 0.305, 0.31), B.lod.w * 0.92);
  gloss *= 1.0 - B.lod.w * 0.7;

  // ── Lighting ───────────────────────────────────────────────────────────────────────────────
  // The sun-shading raster answers "how much sun and sky reaches the top of this cell", and buildings are part of
  // the height field it is solved over — so at a footprint the answer is the ROOF's, and one cell away it is the
  // STREET's. A wall wants both: the street's at its foot, where the sun genuinely reaches it, and the roof's at
  // its top. Two taps and an interpolation up the facade.
  var vis = vec2f(1.0, 1.0);
  if (F.light.w > 0.5) {
    let hereVis = textureSampleLevel(sunTex, linSamp, uv, 0.0);
    if (isRoof) {
      vis = hereVis.rg;
    } else {
      let outUV = clamp(uv + n.xz * (1.4 / F.grid), vec2f(0.0), vec2f(1.0));
      let below = textureSampleLevel(sunTex, linSamp, outUV, 0.0);
      let t = clamp((elevM - floorY) / max(roofY - floorY, 1.0), 0.0, 1.0);
      let up = mix(below.rg, hereVis.rg, pow(t, 0.55));
      // The raster has one value per DEM cell, which is 7.8 m in Pittsburgh — wider than the gap between two
      // rowhouses. A block of them fuses into one solid mass in the height field, and every facade inside it then
      // comes out in shadow, including the ones the sun plainly reaches. So the cast term is faded in with the
      // building's size in cells, on the SAME threshold that decides which buildings reach the raster at all
      // (SHADOW_MIN_CELLS in buildings.ts): a tower is resolved and takes the raster in full, a rowhouse is not
      // and is carried by its own N·L instead, which is the one thing still exactly right at any resolution.
      let resolved = smoothstep(1.0, 2.4, bh / max(F.cellSize, 0.1));
      vis = mix(mix(vec2f(1.0, 1.0), hereVis.rg, 0.45), up, resolved);
    }
  }
  let sunVis = mix(1.0, vis.x, F.light.x);
  let occ = mix(1.0, vis.y, F.light.y);

  let L = F.sunDir;
  let ndlRaw = max(dot(n, L), 0.0);
  // ONE lighting convention for everything drawn from the photograph. The terrain does not take the sun's real
  // N·L on draped imagery — the photo already holds its own shading, so the hillshade only departs from flat
  // ground by F.light.z (see shaders/terrain.ts). A roof taken from that same photograph has to be lit the same
  // way, or the building and the ground it stands on disagree about what the picture means. Facades are NOT in
  // the photograph and keep the real N·L.
  let flatNdl = max(L.y, 0.2);
  let ndl = mix(ndlRaw, mix(flatNdl, ndlRaw, F.light.z), photoTrust);
  let sunK = F.sunColor * (1.0 - F.opts.w * 0.75);
  // A vertical wall is lit by much more than the sun and the sky above it. Half its hemisphere is the street and
  // the facades across it, both of them lit by the same sun, and in a city that bounce is the difference between
  // a shaded wall and a black one. A ROOF sees none of that — it sees the sky, exactly like the ground beside it
  // — so the urban fill fades out with the surface's own tilt, which is what keeps roofs in step with the
  // photograph while still saving the facades from rendering as silhouettes.
  let urban = mix(BUILDING_AMBIENT, 1.0, max(n.y, 0.0));
  let ambK = (0.85 + 0.3 * F.shade.z) * urban;
  let bounce = URBAN_BOUNCE * max(L.y, 0.05) * F.shade.w * (1.0 - max(n.y, 0.0));
  // F.shade.w is the same relative relighting the photographic terrain uses: the whole scene is held at the
  // illumination the imagery was taken under, so buildings and ground never disagree about how bright noon is.
  var color = albedo * (sunK * (ndl * sunVis * F.shade.w + bounce * occ) + skyAmbient(n) * ambK * occ);

  // Sun glint off glazing, and the sky in the glass on the towers.
  if (gloss > 0.02) {
    let hv = normalize(L + view);
    let spec = pow(max(dot(n, hv), 0.0), mix(24.0, 160.0, gloss)) * gloss;
    color += sunK * spec * sunVis * 0.55 * (1.0 - B.lod.w);
    let r = reflect(-view, n);
    // Deliberately softer than a physical Fresnel: at the grazing angles a distant skyline is seen at, the real
    // curve goes to 1 and turns every tower into a white card.
    let fres = 0.03 + 0.30 * pow(1.0 - max(dot(n, view), 0.0), 4.0);
    // Glass is a dark albedo that reads bright because it is a mirror. The cheap version — the ambient dome in the
    // reflected direction — costs nothing and is most of the effect; the cinematic tier puts the real sky and its
    // clouds in it instead. Kept under the diffuse term on purpose: once the sheen outweighs the shading, every
    // face of every tower is the same pale blue and the skyline goes flat.
    color += skyAmbient(r) * fres * gloss * 0.7 * occ * (1.0 - B.lod.w * 0.6);
    if (B.style.z > 0.01 && gloss > 0.25) {
      color += (skyReflection(r) - skyAmbient(r)) * fres * gloss * B.style.z * occ;
    }
  }
  color += vec3f(0.95, 0.96, 1.0) * foam * (0.35 + 0.65 * max(L.y, 0.15)) * (1.0 - F.opts.w * 0.5);

  // ── Below the surface ──────────────────────────────────────────────────────────────────────
  // Light reaching a submerged wall has crossed the flood twice, and a flood is not clear water: a metre of it
  // halves what comes back, three metres leave almost nothing. Without this the roof of a warehouse under eight
  // metres of river is a bright grey slab showing through the surface, which is what a flooded city emphatically
  // does not look like — and it is also what was fighting the water mesh for the same pixels.
  if (submerged > 0.0) {
    // Past a couple of metres nothing comes back at all, and the pixel belongs to the water pass: handing it over
    // outright is both truer and cheaper than blending a near-black wall under a nearly opaque surface, which is
    // what made buildings look like they were standing on dark plinths.
    if (B.water.w > 0.5 && submerged > SUBMERGED_CUT) { discard; }
    let atten = exp(-submerged * MUD_EXTINCTION * max(B.water.w, 0.001));
    color = mix(DEEP_FLOOD, color, atten);
  }

  color = mix(color, in.haze.rgb, in.haze.a);
  return vec4f(color, 1.0);
}
`;
