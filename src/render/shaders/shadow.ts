/**
 * Sun-visibility and sky-visibility raster over the DEM ("the shadow map").
 *
 * Terrain shadows are solved where the terrain lives — in the height field — instead of by rasterising the mesh
 * from the sun. For each cell the sun ray is marched across the grid and the largest horizon tangent it clears is
 * kept; for sky visibility the same march is repeated in a ring of azimuths and the open sky above each horizon is
 * integrated. Two numbers per cell, packed into one rgba8unorm texture that the terrain, skirt and water passes
 * read with a single filtered tap.
 *
 * Why not a depth map from the sun. It would have to re-rasterise ~1 M terrain triangles every frame, and its
 * classic failure modes — acne, peter-panning, shimmer as the light frustum slides with the camera — all come from
 * sampling a rasterised surface at a different frequency than the one it is shaded at. Here occluder and receiver
 * are the same height field at the same resolution, so:
 *   · no depth bias exists to be wrong — the march starts a cell out, so a cell can never shadow itself;
 *   · nothing is attached to the camera, so nothing shimmers when it moves: the raster is a property of the
 *     terrain and the sun, bit-identical between frames until one of them changes;
 *   · shadows stay on the ground that casts them — there is no near plane to push them off their caster;
 *   · the per-frame cost is one texture tap instead of a second geometry pass.
 * Walls and levees are in the march (the barrier field is part of the height), so a levee the user just drew casts
 * its own shadow, and only the edited neighbourhood is recomputed (see shadows.ts).
 *
 * The penumbra is geometry rather than a filter kernel: the sun subtends about half a degree, so the horizon
 * tangent is compared against the sun's with a soft width that grows with the blocker's distance. A ridge a
 * kilometre off gets a soft shadow edge and a floodwall a crisp one — contact hardening, for one smoothstep.
 */

/** Tangent of the sun's angular radius (0.265°): the width of a shadow penumbra cast from one metre away. */
export const SUN_ANGULAR_RADIUS_TAN = 0.00463;

export const SUN_VIS_WGSL = /* wgsl */ `
struct SunParams {
  grid: vec2i,        // nx, ny
  rect0: vec2i,       // origin of the region being (re)built
  rectSize: vec2i,    // its size in cells
  steps: i32,         // sun-ray march steps
  aoDirs: i32,        // sky-visibility azimuths (0 disables it: the term stays 1)
  sunXZ: vec2f,       // unit horizontal direction TOWARD the sun, in grid axes
  tanSun: f32,        // tan(solar elevation)
  cellSize: f32,      // metres per cell
  growth: f32,        // geometric step growth along the sun ray
  penumbra: f32,      // tangent of the sun's angular radius
  aoSteps: f32,       // steps per sky-visibility azimuth
  aoRadius: f32,      // how far sky visibility looks, in cells
}

@group(0) @binding(0) var<uniform> S: SunParams;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var outTex: texture_storage_2d<rgba8unorm, write>;

/** Occluder height: ground + walls + whatever is BUILT on the cell (see packHeight). */
fn heightAt(p: vec2i) -> f32 {
  return textureLoad(heightTex, clamp(p, vec2i(0), S.grid - 1), 0).r;
}

/** Receiver height for the street: the same field with the buildings taken back off. */
fn groundAt(p: vec2i) -> f32 {
  return textureLoad(heightTex, clamp(p, vec2i(0), S.grid - 1), 0).g;
}

/** Outside the grid there is nothing left to cast a shadow, so a ray that leaves it is done. */
fn outside(p: vec2i) -> bool {
  return p.x < 0 || p.y < 0 || p.x >= S.grid.x || p.y >= S.grid.y;
}

@compute @workgroup_size(8, 8)
fn sunVis(@builtin(global_invocation_id) gid: vec3u) {
  let local = vec2i(gid.xy);
  if (local.x >= S.rectSize.x || local.y >= S.rectSize.y) { return; }
  let cell = S.rect0 + local;
  if (outside(cell)) { return; }
  // Two receivers per cell, marched together along the same ray: the street (bare ground, what the terrain and the
  // water read) and the roof of whatever stands on it (what the building pass reads). Where nothing is built the
  // two heights are equal and the second answer costs a subtraction — the taps are shared either way.
  let z = groundAt(cell);
  let zRoof = heightAt(cell);
  let hasRoof = zRoof > z + 0.25;
  let base = vec2f(cell) + 0.5;

  // ── Sun visibility ──────────────────────────────────────────────────────────────────────
  // March toward the sun with geometrically growing steps: a metre of detail matters next to the receiver and not
  // three kilometres away, so ~48 steps reach far enough for a 9° sun over 200 m of relief.
  var maxTan = -1e9;
  var blockCells = 1.0;
  var maxTanR = -1e9;
  var blockCellsR = 1.0;
  var s = 0.0;
  var step = 1.0;
  for (var k = 0; k < S.steps; k++) {
    s += step;
    step *= S.growth;
    let p = vec2i(floor(base + S.sunXZ * s));
    if (outside(p)) { break; }
    let hp = heightAt(p);
    let run = s * S.cellSize;
    let t = (hp - z) / run;
    if (t > maxTan) {
      maxTan = t;
      blockCells = s;
    }
    let tr = (hp - zRoof) / run;
    if (tr > maxTanR) {
      maxTanR = tr;
      blockCellsR = s;
    }
    // Already so deep in shadow that no further blocker can change either answer.
    if (maxTan > S.tanSun + 0.75 && maxTanR > S.tanSun + 0.75) { break; }
  }
  // Contact hardening: the sun's angular radius projects to a wider tangent window the further off the blocker.
  let width = S.penumbra * (1.0 + blockCells * 0.9);
  let sun = smoothstep(-width, width, S.tanSun - maxTan);
  let widthR = S.penumbra * (1.0 + blockCellsR * 0.9);
  let sunRoof = select(sun, smoothstep(-widthR, widthR, S.tanSun - maxTanR), hasRoof);

  // ── Sky visibility ──────────────────────────────────────────────────────────────────────
  // The fraction of a uniform sky dome a horizontal patch can see, from the horizon elevation found in a ring of
  // azimuths: the cosine-weighted wedge above a horizon of tangent t integrates to 1/(1 + t²). Ridges stay open,
  // hollows and the insides of river valleys close in — the cue that says "landscape", not "photo on a plane".
  // With buildings in the field this is also what darkens the streets between them into urban canyons.
  var sky = 1.0;
  var skyRoof = 1.0;
  if (S.aoDirs > 0) {
    var acc = 0.0;
    var accR = 0.0;
    let aoStepCount = i32(S.aoSteps);
    let dr = S.aoRadius / max(S.aoSteps, 1.0);
    for (var d = 0; d < S.aoDirs; d++) {
      let a = (f32(d) + 0.5) * 6.28318530718 / f32(S.aoDirs);
      let dir = vec2f(cos(a), sin(a));
      var hTan = 0.0;
      var hTanR = 0.0;
      var r = 0.0;
      for (var k = 0; k < aoStepCount; k++) {
        r += dr * (1.0 + f32(k) * 0.45);
        let p = vec2i(floor(base + dir * r));
        if (outside(p)) { break; }
        let hp = heightAt(p);
        let run = r * S.cellSize;
        hTan = max(hTan, (hp - z) / run);
        hTanR = max(hTanR, (hp - zRoof) / run);
      }
      acc += 1.0 / (1.0 + hTan * hTan);
      accR += 1.0 / (1.0 + hTanR * hTanR);
    }
    sky = acc / f32(S.aoDirs);
    skyRoof = select(sky, accR / f32(S.aoDirs), hasRoof);
  }

  textureStore(outTex, cell, vec4f(sun, sky, sunRoof, skyRoof));
}
`;

/**
 * Ground, walls and buildings flattened into one texture so the marches above cost one tap per step instead of
 * three. Two channels, because the sun raster answers two questions per cell:
 *   r — the OCCLUDER height: bed + barrier + roof height above the ground (0 where nothing is built);
 *   g — the RECEIVER height of the street: bed + barrier, with the buildings taken back off, which is what the
 *       terrain and the water are shaded at even where a footprint covers them.
 * Rebuilt over the edited rectangle whenever the solver's terrain version moves. The building layer is static, so
 * `bldTex` is uploaded once when the scene loads (`hasBuildings` is 0 while the city is hidden).
 */
export const SUN_HEIGHT_WGSL = /* wgsl */ `
struct HeightParams {
  grid: vec2i,
  rect0: vec2i,
  rectSize: vec2i,
  hasBuildings: i32,
  pad: i32,
}
@group(0) @binding(0) var<uniform> H: HeightParams;
@group(0) @binding(1) var bedTex: texture_2d<f32>;
@group(0) @binding(2) var barrierTex: texture_2d<f32>;
@group(0) @binding(3) var heightOut: texture_storage_2d<rg32float, write>;
@group(0) @binding(4) var bldTex: texture_2d<f32>;

@compute @workgroup_size(8, 8)
fn packHeight(@builtin(global_invocation_id) gid: vec3u) {
  let local = vec2i(gid.xy);
  if (local.x >= H.rectSize.x || local.y >= H.rectSize.y) { return; }
  let c = H.rect0 + local;
  if (c.x < 0 || c.y < 0 || c.x >= H.grid.x || c.y >= H.grid.y) { return; }
  let bed = textureLoad(bedTex, c, 0).r;
  let barrier = textureLoad(barrierTex, c, 0).r;
  // A blown-up solver can write non-finite bed values; a NaN here would poison the whole shadow raster.
  let h = bed + barrier;
  let ground = select(0.0, h, h > -1e5 && h < 1e5);
  var roof = 0.0;
  if (H.hasBuildings != 0) {
    let b = textureLoad(bldTex, c, 0).r;
    roof = select(0.0, b, b > 0.0 && b < 1e4);
  }
  textureStore(heightOut, c, vec4f(ground + roof, ground, 0.0, 1.0));
}
`;
