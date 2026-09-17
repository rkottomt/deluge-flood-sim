/**
 * Live areas: load any US location on demand (USGS 3DEP DEM + Esri imagery + TIGERweb roads), auto-detect and
 * burn water bodies, and synthesize a generic scenario (shelters on high ground near roads; a stage control
 * on the largest water body that leaves the domain, so "raise the river" works anywhere).
 *
 * The CPU-heavy conditioning (liveTerrain.ts) runs in a Web Worker when available: water detection starts as soon as
 * the DEM is decoded, in parallel with the imagery and road downloads, and the page stays responsive.
 */
import type { LiveAreaRequest, ProgressFn, RoadNetwork, TerrainData } from '../contracts';
import { fetchDEM } from './dem';
import { isLikelyUS, squareDomain } from './geo';
import { fetchImagery, IMAGERY_ATTRIBUTION } from './imagery';
import { detectLiveWater, finishLiveTerrain, type LiveTerrainResult } from './liveTerrain';
import type { LiveWorkerRequest, LiveWorkerResponse } from './liveWorker';
import { fetchRoadNetwork } from './roads';

export { buildLiveScenario, pickHighShelters } from './liveTerrain';

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
  report(dem.source === 'usgs3dep' ? 'Elevation decoded (USGS 3DEP) — detecting rivers and lakes…' : 'Elevation decoded (Terrarium) — detecting rivers and lakes…');
  await tick();
  // Water detection starts now (in a worker when possible) while imagery and roads finish downloading.
  const conditioner = startLiveConditioning(dem.elevation, n, cellSize);

  const name = req.name?.trim() || `${lat.toFixed(4)}°, ${lon.toFixed(4)}°`;
  let conditioned: LiveTerrainResult;
  let imagery: ImageBitmap | null;
  let roads: Awaited<typeof roadsP>;
  try {
    [imagery, roads] = await Promise.all([imgP, roadsP]);
    onProgress?.('Carving rivers and building scenario…', 0.93);
    await tick();
    conditioned = await conditioner.finish(roads?.network ?? null, name, dem.source);
  } finally {
    conditioner.dispose();
  }
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
    elevation: conditioned.elevation,
    bounds,
    imagery,
    roads: roads?.network ?? null,
    attribution,
    scenario: conditioned.scenario,
  };
}

interface LiveConditioner {
  /** Wait for detection, then open ridges, burn and build the scenario. */
  finish(roads: RoadNetwork | null, name: string, demSource: string): Promise<LiveTerrainResult>;
  dispose(): void;
}

/**
 * Start conditioning `elevation` (not modified). Uses a Web Worker where available; if the worker cannot start or
 * fails, the same computation runs on this thread (yielding between phases so progress can paint).
 */
function startLiveConditioning(elevation: Float32Array, n: number, cellSize: number): LiveConditioner {
  const local = (): LiveConditioner => {
    let bodies: ReturnType<typeof detectLiveWater> | null = null;
    const detect = () => (bodies ??= detectLiveWater(elevation, n, cellSize));
    return {
      async finish(roads, name, demSource) {
        await tick();
        const b = detect();
        await tick();
        return finishLiveTerrain(elevation, n, cellSize, b, roads, name, demSource);
      },
      dispose() {},
    };
  };
  let worker: Worker | null = null;
  try {
    if (typeof Worker === 'function') worker = new Worker(new URL('./liveWorker.ts', import.meta.url), { type: 'module', name: 'deluge-live-terrain' });
  } catch (e) {
    console.warn('[data] live-terrain worker unavailable, conditioning on the main thread:', e);
  }
  if (!worker) return local();

  const w = worker;
  let failed: string | null = null;
  let settle: ((r: LiveWorkerResponse | { type: 'error'; message: string }) => void) | null = null;
  let pending: LiveWorkerResponse | { type: 'error'; message: string } | null = null;
  const deliver = (r: LiveWorkerResponse | { type: 'error'; message: string }) => {
    if (settle) settle(r);
    else pending = r;
  };
  w.onmessage = (e: MessageEvent<LiveWorkerResponse>) => deliver(e.data);
  w.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    failed = e.message || 'worker failed to start';
    deliver({ type: 'error', message: failed });
  };
  w.onmessageerror = () => deliver({ type: 'error', message: 'worker message could not be deserialized' });
  // Send a copy: the original stays here for the main-thread fallback.
  const copy = elevation.slice();
  w.postMessage({ type: 'detect', elevation: copy, n, cellSize } satisfies LiveWorkerRequest, [copy.buffer]);

  return {
    async finish(roads, name, demSource) {
      if (!failed) {
        w.postMessage({ type: 'finish', roads, name, demSource } satisfies LiveWorkerRequest);
        const r = await new Promise<LiveWorkerResponse | { type: 'error'; message: string }>((resolve) => {
          if (pending) resolve(pending);
          else settle = resolve;
        });
        if (r.type === 'done') return { elevation: r.elevation, scenario: r.scenario, stats: r.stats };
        console.warn('[data] live-terrain worker failed, conditioning on the main thread:', r.message);
      }
      return local().finish(roads, name, demSource);
    },
    dispose() {
      w.terminate();
    },
  };
}

