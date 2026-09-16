/**
 * Live areas: load any US location on demand (USGS 3DEP DEM + Esri imagery + TIGERweb roads), auto-detect and
 * burn water bodies, and synthesize a generic scenario (shelters on high ground near roads; a stage control
 * on the largest water body that leaves the domain, so "raise the river" works anywhere).
 */
import type { LiveAreaRequest, ProgressFn, RoadNetwork, ScenarioPreset, Shelter, TerrainData, WaterSource } from '../contracts';
import { fetchDEM } from './dem';
import { isLikelyUS, squareDomain } from './geo';
import { burnWaterBodies, detectWaterBodies, distanceTransform, edgeRuns, edgeStageDisc, type WaterBody } from './hydro';
import { fetchImagery, IMAGERY_ATTRIBUTION } from './imagery';
import { fetchRoadNetwork } from './roads';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function loadLiveArea(req: LiveAreaRequest, onProgress?: ProgressFn): Promise<TerrainData> {
  const { lat, lon } = req.center;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('Invalid location');
  const sizeMeters = Math.min(20000, Math.max(1000, req.sizeMeters));
  const n = req.resolution;
  if (![512, 1024, 2048].includes(n)) throw new Error(`Unsupported resolution ${n}`);
  if (!isLikelyUS(lat, lon)) {
    console.warn('[data] location may be outside USGS 3DEP coverage; Terrarium fallback will be used if needed');
  }
  const { bounds, merc } = squareDomain({ lat, lon }, sizeMeters);
  const cellSize = sizeMeters / n;

  const progress = { dem: 0, img: 0, roads: 0 };
  let lastMsg = 'Starting…';
  const report = (msg?: string) => {
    if (msg) lastMsg = msg;
    const f = 0.02 + 0.5 * progress.dem + 0.2 * progress.img + 0.18 * progress.roads;
    onProgress?.(lastMsg, Math.min(0.9, f));
  };
  report('Requesting elevation, imagery and roads…');

  const demP = fetchDEM(merc, n, n, cellSize, (m, f) => {
    progress.dem = f * 0.95;
    report(m);
  });
  const imgP = fetchImagery(merc, 2048, (m, f) => {
    progress.img = f;
    report(m);
  });
  const roadsP = fetchRoadNetwork({ nx: n, ny: n, cellSize, bounds }, (m, f) => {
    progress.roads = f;
    report(m);
  }).catch((e) => {
    console.warn('[data] roads unavailable:', e);
    return null;
  });

  const dem = await demP;
  progress.dem = 1;
  report(dem.source === 'usgs3dep' ? 'Elevation decoded (USGS 3DEP)' : 'Elevation decoded (Terrarium fallback)');
  await tick();

  onProgress?.('Detecting rivers and lakes…', 0.9);
  await tick();
  const bodies = detectWaterBodies(dem.elevation, n, n, cellSize);
  const burned = burnWaterBodies(dem.elevation, n, n, bodies, 3, 2);

  const [imagery, roads] = await Promise.all([imgP, roadsP]);
  onProgress?.('Building scenario…', 0.97);
  await tick();

  const name = req.name?.trim() || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  const scenario = buildLiveScenario(burned.elevation, n, n, cellSize, bodies, burned.fills, roads?.network ?? null, name, dem.source);
  const attribution = [
    dem.source === 'usgs3dep' ? 'Elevation: USGS 3DEP' : 'Elevation: Mapzen Terrarium (AWS Open Data)',
    imagery ? IMAGERY_ATTRIBUTION : null,
    roads?.attribution ?? null,
  ]
    .filter(Boolean)
    .join(' · ');
  onProgress?.('Ready', 1);
  return {
    name,
    nx: n,
    ny: n,
    cellSize,
    elevation: burned.elevation,
    bounds,
    imagery,
    roads: roads?.network ?? null,
    attribution,
    scenario,
  };
}

/** Generic scenario for a live area. Exported for tests. */
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
  const candidates = edgeBodies.flatMap((b) => edgeSourcePoints(b, nx, ny).map((p) => ({ ...p, body: b })));
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
      maxOffset: 10,
    };
  }

  // Shelters: dry intersections above the flood ceiling (the raised water level, or low ground + 12 m).
  const waterLevel = mainBody?.level ?? bodies[0]?.level ?? sample[Math.floor(sample.length * 0.05)] ?? median;
  const floodCeiling = waterLevel + (stage ? stage.maxOffset : 12);
  const shelters = pickHighShelters(elev, nx, ny, cellSize, roads, bodies, floodCeiling, 4);

  const sizeKm = (nx * cellSize) / 1000;
  const description =
    `${name}: ${sizeKm.toFixed(1)} km × ${sizeKm.toFixed(1)} km of live ${demSource === 'usgs3dep' ? 'USGS 3DEP' : 'Terrarium'} ` +
    `elevation at ${cellSize.toFixed(1)} m per cell` +
    (bodies.length ? `, with ${bodies.length} water surface${bodies.length === 1 ? '' : 's'} detected and pre-filled` : '') +
    '. Add rain or a storm cell, drop inflow sources on streams' +
    (stage ? ', raise the water level' : '') +
    ', and set an evacuation start point to see which roads stay dry.';

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

/**
 * Stage-source footprints for every place the water body crosses the domain edge: one disc per run of the body's
 * edge cells, covering the whole run (see edgeStageDisc), at the body's surface level in the middle of the run.
 */
function edgeSourcePoints(b: WaterBody, nx: number, ny: number): Array<{ gx: number; gy: number; radius: number; level: number }> {
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
      out.push({ ...edgeStageDisc(edge, t0, t1, nx, ny), level: levelAt[k] });
    }
  }
  return out;
}

/**
 * Pick up to `count` shelters for a live area: road intersections (degree ≥ 3, so they're in town and reachable)
 * at least 3 m above `ceiling` and ≥ 150 m from detected water, spread out by farthest-point sampling that
 * starts near the domain center. Where no ground clears the ceiling (e.g. New Orleans) the highest intersections
 * away from water are used. Names come from the street at the intersection.
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
  return chosen.map((c, idx) => ({
    name: `${c.name ? `Shelter — ${c.name}` : `High ground ${String.fromCharCode(65 + idx)}`} (${Math.round(c.z)} m)`,
    gx: Math.round(c.gx * 100) / 100,
    gy: Math.round(c.gy * 100) / 100,
  }));
}
