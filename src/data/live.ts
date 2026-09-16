/**
 * Live areas: load any US location on demand (USGS 3DEP DEM + Esri imagery + TIGERweb roads), auto-detect and
 * burn water bodies, and synthesize a generic scenario (shelters on high ground near roads; a stage control
 * on the largest water body that leaves the domain, so "raise the river" works anywhere).
 */
import type { LiveAreaRequest, ProgressFn, RoadNetwork, ScenarioPreset, Shelter, TerrainData, WaterSource } from '../contracts';
import { fetchDEM } from './dem';
import { isLikelyUS, squareDomain } from './geo';
import { burnWaterBodies, detectWaterBodies, distanceTransform, type WaterBody } from './hydro';
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

  // Stage control on the largest water body that touches the domain edge (a river flowing through).
  const sources: WaterSource[] = [];
  let stage: ScenarioPreset['stage'] = null;
  const river = bodies.find((b) => b.cells * cellSize * cellSize > 50000 && b.touchesEdge);
  if (river) {
    // One stage source wherever the river crosses the domain edge, each at its local surface level, so a
    // sloping river keeps its slope and the slider raises the whole water surface.
    const pts = edgeSourcePoints(river, nx, ny);
    pts.slice(0, 6).forEach((p, idx) => {
      sources.push({ id: `stage-${idx + 1}`, type: 'stage', gx: p.gx, gy: p.gy, radius: p.radius, level: Math.round(p.level * 100) / 100, label: 'River stage' });
    });
    if (sources.length) {
      stage = {
        label: 'River level (detected water surface)',
        gaugeDatum: river.level,
        normalLevel: river.level,
        maxOffset: 10,
      };
    }
  }

  const floodCeiling = (river?.level ?? sample[Math.floor(sample.length * 0.1)] ?? median) + 12;
  const shelters = pickHighShelters(elev, nx, ny, roads, floodCeiling, 3);

  const sizeKm = (nx * cellSize) / 1000;
  const description =
    `${name}: ${sizeKm.toFixed(1)} km × ${sizeKm.toFixed(1)} km of live ${demSource === 'usgs3dep' ? 'USGS 3DEP' : 'Terrarium'} ` +
    `elevation at ${cellSize.toFixed(1)} m per cell` +
    (bodies.length ? `, with ${bodies.length} water bod${bodies.length === 1 ? 'y' : 'ies'} detected and pre-filled` : '') +
    '. Add rain or a storm cell, drop inflow sources on streams' +
    (stage ? ', raise the river level' : '') +
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

/** Points on the water body just inside each place it crosses the domain edge. */
function edgeSourcePoints(b: WaterBody, nx: number, ny: number): Array<{ gx: number; gy: number; radius: number; level: number }> {
  const mask = new Uint8Array(nx * ny);
  const levelAt = new Float32Array(nx * ny);
  b.indices.forEach((k, q) => {
    mask[k] = 1;
    levelAt[k] = b.levels[q];
  });
  const dist = distanceTransform(nx, ny, (k) => mask[k] === 0);
  const out: Array<{ gx: number; gy: number; radius: number; level: number }> = [];
  const edges = [
    { len: nx, cell: (t: number, d: number) => d * nx + t },
    { len: nx, cell: (t: number, d: number) => (ny - 1 - d) * nx + t },
    { len: ny, cell: (t: number, d: number) => t * nx + d },
    { len: ny, cell: (t: number, d: number) => t * nx + (nx - 1 - d) },
  ];
  for (const e of edges) {
    let t = 0;
    while (t < e.len) {
      if (!mask[e.cell(t, 0)]) {
        t++;
        continue;
      }
      let t1 = t;
      while (t1 + 1 < e.len && mask[e.cell(t1 + 1, 0)]) t1++;
      const width = t1 - t + 1;
      if (width >= 4) {
        let best = -1;
        let bestScore = -Infinity;
        let bestR = 0;
        for (let d = 1; d <= Math.min(40, Math.max(8, width)); d++) {
          for (let s = Math.max(0, t - width); s <= Math.min(e.len - 1, t1 + width); s++) {
            const k = e.cell(s, d);
            if (!mask[k]) continue;
            const r = Math.min(12, dist[k] * 0.85, d - 0.5);
            const score = r - 0.05 * d;
            if (score > bestScore) {
              bestScore = score;
              best = k;
              bestR = r;
            }
          }
        }
        if (best >= 0 && bestR >= 1) {
          out.push({ gx: (best % nx) + 0.5, gy: ((best / nx) | 0) + 0.5, radius: Math.round(bestR * 10) / 10, level: levelAt[best] });
        }
      }
      t = t1 + 1;
    }
  }
  return out;
}

/**
 * Pick up to `count` shelters: road nodes (or grid cells when there are no roads) well above `ceiling`,
 * preferring high ground, spread apart by farthest-point sampling.
 */
export function pickHighShelters(
  elev: Float32Array,
  nx: number,
  ny: number,
  roads: RoadNetwork | null,
  ceiling: number,
  count: number,
): Shelter[] {
  const cand: Array<{ gx: number; gy: number; z: number }> = [];
  const margin = Math.max(8, nx * 0.04);
  const push = (gx: number, gy: number) => {
    if (gx < margin || gy < margin || gx > nx - margin || gy > ny - margin) return;
    const z = elev[Math.min(ny - 1, Math.floor(gy)) * nx + Math.min(nx - 1, Math.floor(gx))];
    cand.push({ gx, gy, z });
  };
  if (roads && roads.nodes.length >= 2) {
    for (let k = 0; k < roads.nodes.length / 2; k++) push(roads.nodes[k * 2], roads.nodes[k * 2 + 1]);
  } else {
    const step = Math.max(4, Math.floor(nx / 64));
    for (let j = step / 2; j < ny; j += step) for (let i = step / 2; i < nx; i += step) push(i + 0.5, j + 0.5);
  }
  if (!cand.length) return [];
  cand.sort((a, b) => b.z - a.z);
  // Keep the top quartile (by elevation) that is above the flood ceiling.
  let pool = cand.slice(0, Math.max(count, Math.ceil(cand.length * 0.25))).filter((c) => c.z > ceiling);
  if (pool.length === 0) pool = cand.slice(0, Math.max(count, 16));
  const chosen = [pool[0]];
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
    if (bestD <= 0) break;
    chosen.push(best);
  }
  return chosen.map((c, idx) => ({ name: `High ground ${String.fromCharCode(65 + idx)} (${Math.round(c.z)} m)`, gx: c.gx, gy: c.gy }));
}
