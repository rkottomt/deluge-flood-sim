/**
 * Live-area terrain conditioning and scenario synthesis — pure computation with no network or DOM access, so it runs
 * in a Web Worker (liveWorker.ts) or, where workers are unavailable (Node tests), on the calling thread.
 *
 *   detectLiveWater   — water bodies in the hydro-flattened DEM (can start while roads are still downloading)
 *   finishLiveTerrain — open ridges across the water (roads mark causeways/bridges to keep), burn the bodies,
 *                       and build the generic scenario (stage sources, shelters, camera)
 */
import type { RoadNetwork, ScenarioPreset, Shelter, WaterSource } from '../contracts';
import { burnWaterBodies, detectWaterBodies, distanceTransform, edgeRuns, edgeStageDiscAvoiding, growEdgeRun, openWaterGaps, type WaterBody } from './hydro';
import { roadMask } from './roads';

export function detectLiveWater(elev: Float32Array, n: number, cellSize: number): WaterBody[] {
  return detectWaterBodies(elev, n, n, cellSize);
}

export interface LiveTerrainResult {
  /** Conditioned elevation (new array). */
  elevation: Float32Array;
  scenario: ScenarioPreset;
  /** Diagnostics. */
  stats: { bodies: number; openedBands: number; openedCells: number };
}

/**
 * Second phase of live conditioning. Ridges across detected water are only opened when road data is available: a band
 * carrying a mapped road may be a real causeway, and without roads the DEM alone cannot tell (see openWaterGaps).
 */
export function finishLiveTerrain(
  elev: Float32Array,
  n: number,
  cellSize: number,
  bodies: WaterBody[],
  roads: RoadNetwork | null,
  name: string,
  demSource: string,
): LiveTerrainResult {
  const gaps = roads ? openWaterGaps(elev, n, n, cellSize, bodies, { roads: roadMask(roads, n, n, 1) }) : { cells: 0, bands: 0 };
  const burned = burnWaterBodies(elev, n, n, bodies, 3, 2);
  const scenario = buildLiveScenario(burned.elevation, n, n, cellSize, bodies, burned.fills, roads, name, demSource);
  return { elevation: burned.elevation, scenario, stats: { bodies: bodies.length, openedBands: gaps.bands, openedCells: gaps.cells } };
}

/** Generic scenario for a live area. */
export function buildLiveScenario(
  elev: Float32Array,
  nx: number,
  ny: number,
  cellSize: number,
  bodies: WaterBody[],
  fills: ScenarioPreset['initialFill'],
  roads: RoadNetwork | null,
  name: string,
  demSource: string,
): ScenarioPreset {
  // Median ground elevation (sampled) for the camera target.
  const sample: number[] = [];
  for (let k = 0; k < elev.length; k += 97) sample.push(elev[k]);
  sample.sort((a, b) => a - b);
  const median = sample[sample.length >> 1] ?? 0;

  // Stage control: a stage source wherever a sizeable water body (a river flowing through, or a lake cut by the
  // edge) crosses the domain boundary, each at its local surface level — a sloping river keeps its slope and the
  // slider raises every water surface that enters or leaves the domain.
  const sources: WaterSource[] = [];
  let stage: ScenarioPreset['stage'] = null;
  const edgeBodies = bodies.filter((b) => b.touchesEdge && b.cells * cellSize * cellSize > 50000);
  const candidates = edgeBodies.flatMap((b) => edgeSourcePoints(b, nx, ny, elev, LIVE_STAGE_MAX_OFFSET).map((p) => ({ ...p, body: b })));
  candidates.sort((a, b) => b.radius - a.radius);
  const MAX_STAGE_SOURCES = 8;
  for (const c of candidates) {
    if (sources.length >= MAX_STAGE_SOURCES) break;
    // Skip near-duplicates (a wide river crossing a corner shows up on two edges as overlapping discs).
    if (sources.some((s) => Math.hypot(s.gx - c.gx, s.gy - c.gy) < 0.8 * (s.radius + c.radius))) continue;
    sources.push({
      id: `stage-${sources.length + 1}`,
      type: 'stage',
      gx: c.gx,
      gy: c.gy,
      radius: c.radius,
      level: Math.round(c.level * 100) / 100,
      label: 'Water level at the domain edge',
    });
  }
  const mainBody = edgeBodies[0] ?? null;
  if (sources.length && mainBody) {
    stage = {
      label: `Water level (detected surface ${mainBody.level.toFixed(1)} m)`,
      gaugeDatum: Math.round(mainBody.level * 100) / 100,
      normalLevel: Math.round(mainBody.level * 100) / 100,
      maxOffset: LIVE_STAGE_MAX_OFFSET,
    };
  }

  // Shelters: dry intersections above the flood ceiling (the raised water level, or low ground + 12 m).
  const waterLevel = mainBody?.level ?? bodies[0]?.level ?? sample[Math.floor(sample.length * 0.05)] ?? median;
  const floodCeiling = waterLevel + (stage ? stage.maxOffset : 12);
  const shelters = pickHighShelters(elev, nx, ny, cellSize, roads, bodies, floodCeiling, 4);
  const lowRefuges = shelters.filter((sh) => sh.name.startsWith(HIGHEST_GROUND_PREFIX)).length;

  const sizeKm = (nx * cellSize) / 1000;
  const fmt1 = (v: number) => (Math.round(v * 10) / 10).toString();
  const description =
    `${name}: ${sizeKm.toFixed(1)} km × ${sizeKm.toFixed(1)} km of live ${demSource === 'usgs3dep' ? 'USGS 3DEP' : 'Terrarium'} ` +
    `elevation at ${cellSize.toFixed(1)} m per cell` +
    (bodies.length ? `, with ${bodies.length} water surface${bodies.length === 1 ? '' : 's'} detected and pre-filled` : '') +
    '. ' +
    // There is no river gauge for an arbitrary area: say what the slider measures (and that nothing drives it if no
    // water crosses the edge), so "33 ft" is not read as a gauge reading and "Play the flood" is not expected to flood.
    (stage
      ? `The water-level control raises the water up to ${fmt1(stage.maxOffset)} m (${Math.round(stage.maxOffset / 0.3048)} ft) ` +
        'above the surface detected at load; it is not a river gauge reading. '
      : bodies.some((b) => b.touchesEdge)
        ? 'No water body large enough to raise crosses the edge of the area, so there is no water-level control. '
        : 'No river or lake surface was detected in the elevation data (narrow or tree-lined channels can be missed), ' +
          'so nothing floods on its own and there is no water-level control. ') +
    'Add rain or a storm cell, drop inflow sources on streams' +
    (stage ? ', raise the water level' : '') +
    ', and set an evacuation start point to see which roads stay dry.' +
    (lowRefuges
      ? lowRefuges === shelters.length
        ? ` No intersection here stands ${stage ? 'clear of the highest water level the control reaches' : bodies.length ? 'well above the water' : 'well above the lowest ground'}, so the ` +
          'evacuation targets are only the highest ground nearby: in a big flood, shelter in place.'
        : ` Only ${shelters.length - lowRefuges} of the ${shelters.length} evacuation targets stand clear of the highest water; ` +
          'the others are only the highest ground nearby.'
      : '');

  return {
    description,
    sources,
    storms: [],
    shelters,
    rainRate: 0,
    stage,
    initialFill: fills,
    camera: {
      target: { gx: nx / 2, gy: ny / 2, elevation: median },
      distance: nx * cellSize * 0.95,
      yaw: 0.35,
      pitch: 0.7,
    },
  };
}

/** Stage slider range for live areas, m above the detected surface. */
const LIVE_STAGE_MAX_OFFSET = 10;

/**
 * Stage-source footprints for every place the water body crosses the domain edge: one disc per run of the body's
 * edge cells, covering the whole run (see edgeStageDisc), at the body's surface level in the middle of the run.
 */
function edgeSourcePoints(
  b: WaterBody,
  nx: number,
  ny: number,
  elev: Float32Array,
  maxOffset: number,
): Array<{ gx: number; gy: number; radius: number; level: number }> {
  const mask = new Uint8Array(nx * ny);
  const levelAt = new Float32Array(nx * ny);
  b.indices.forEach((k, q) => {
    mask[k] = 1;
    levelAt[k] = b.levels[q];
  });
  const out: Array<{ gx: number; gy: number; radius: number; level: number }> = [];
  for (const edge of ['north', 'south', 'west', 'east'] as const) {
    for (const [t0, t1] of edgeRuns(edge, nx, ny, (k) => mask[k] === 1)) {
      if (t1 - t0 + 1 < 4) continue;
      const mid = (t0 + t1) >> 1;
      const k = edge === 'north' ? mid : edge === 'south' ? (ny - 1) * nx + mid : edge === 'west' ? mid * nx : mid * nx + nx - 1;
      // Cover the crossing as wide as it gets at the top of the slider (see growEdgeRun).
      const level = levelAt[k];
      const ceiling = level + maxOffset;
      const grown = growEdgeRun(edge, t0, t1, nx, ny, (q) => mask[q] === 1 || (elev[q] < ceiling && elev[q] >= level));
      const { run: _run, ...disc } = edgeStageDiscAvoiding(edge, [t0, t1], grown, nx, ny, (q) => mask[q] !== 1 && elev[q] < level);
      out.push({ ...disc, level });
    }
  }
  return out;
}

/** Name prefix of a live-area evacuation target that does NOT clear the flood ceiling (see pickHighShelters). */
export const HIGHEST_GROUND_PREFIX = 'Highest ground';

/**
 * Pick up to `count` shelters for a live area: road intersections (degree ≥ 3, so they're in town and reachable)
 * at least 3 m above `ceiling` and ≥ 150 m from detected water, spread out by farthest-point sampling that
 * starts near the domain center. Where too little ground clears the ceiling (e.g. New Orleans) the highest
 * intersections away from water are used, and those are named "Highest ground — <street> (<z> m)" rather than
 * "Shelter — <street> (<z> m)": they are the best refuge nearby, not a place that stays dry at the top of the range.
 */
export function pickHighShelters(
  elev: Float32Array,
  nx: number,
  ny: number,
  cellSize: number,
  roads: RoadNetwork | null,
  bodies: WaterBody[],
  ceiling: number,
  count: number,
): Shelter[] {
  const margin = Math.max(8, nx * 0.04);
  const inside = (gx: number, gy: number) => gx >= margin && gy >= margin && gx <= nx - margin && gy <= ny - margin;
  const zAt = (gx: number, gy: number) => elev[Math.min(ny - 1, Math.floor(gy)) * nx + Math.min(nx - 1, Math.floor(gx))];
  const waterMask = new Uint8Array(nx * ny);
  for (const b of bodies) for (const k of b.indices) waterMask[k] = 1;
  const waterDist = bodies.length ? distanceTransform(nx, ny, (k) => waterMask[k] === 1) : null;
  const farFromWater = (gx: number, gy: number) =>
    !waterDist || waterDist[Math.min(ny - 1, Math.floor(gy)) * nx + Math.min(nx - 1, Math.floor(gx))] * cellSize >= 150;

  type Cand = { gx: number; gy: number; z: number; name?: string };
  const cand: Cand[] = [];
  if (roads && roads.edges.length) {
    const degree = new Uint16Array(roads.nodes.length / 2);
    const nameOf: Array<string | undefined> = [];
    for (const e of roads.edges) {
      degree[e.a]++;
      degree[e.b]++;
      if (e.name) {
        nameOf[e.a] ??= e.name;
        nameOf[e.b] ??= e.name;
      }
    }
    for (let k = 0; k < degree.length; k++) {
      const gx = roads.nodes[k * 2];
      const gy = roads.nodes[k * 2 + 1];
      if (degree[k] >= 3 && inside(gx, gy) && farFromWater(gx, gy)) cand.push({ gx, gy, z: zAt(gx, gy), name: nameOf[k] });
    }
  }
  if (!cand.length) {
    const step = Math.max(4, Math.floor(nx / 64));
    for (let j = step / 2; j < ny; j += step) {
      for (let i = step / 2; i < nx; i += step) if (inside(i + 0.5, j + 0.5) && farFromWater(i + 0.5, j + 0.5)) cand.push({ gx: i + 0.5, gy: j + 0.5, z: zAt(i + 0.5, j + 0.5) });
    }
  }
  if (!cand.length) return [];
  let pool = cand.filter((c) => c.z >= ceiling + 3);
  if (pool.length < count) {
    // Nothing (or too little) clears the flood ceiling: fall back to the highest tenth of the candidates.
    const sorted = cand.slice().sort((a, b) => b.z - a.z);
    pool = sorted.slice(0, Math.max(count, Math.ceil(sorted.length * 0.1)));
  }
  // Farthest-point sampling seeded with the pool candidate nearest the domain center.
  let first = pool[0];
  for (const c of pool) if (Math.hypot(c.gx - nx / 2, c.gy - ny / 2) < Math.hypot(first.gx - nx / 2, first.gy - ny / 2)) first = c;
  const chosen = [first];
  while (chosen.length < count && chosen.length < pool.length) {
    let best = pool[0];
    let bestD = -1;
    for (const c of pool) {
      let d = Infinity;
      for (const s of chosen) d = Math.min(d, Math.hypot(c.gx - s.gx, c.gy - s.gy));
      if (d > bestD) {
        bestD = d;
        best = c;
      }
    }
    if (bestD * cellSize < 200) break;
    chosen.push(best);
  }
  return chosen.map((c, idx) => {
    const clear = c.z >= ceiling + 3;
    const label = c.name
      ? `${clear ? 'Shelter' : HIGHEST_GROUND_PREFIX} — ${c.name}`
      : `${clear ? 'High ground' : HIGHEST_GROUND_PREFIX} ${String.fromCharCode(65 + idx)}`;
    return {
      name: `${label} (${Math.round(c.z)} m)`,
      gx: Math.round(c.gx * 100) / 100,
      gy: Math.round(c.gy * 100) / 100,
    };
  });
}
