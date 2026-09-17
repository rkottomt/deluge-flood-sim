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
import { ELEVATION_UNREACHABLE_MESSAGE } from './net';
import { coordinateName, isCoordinateName, reverseGeocodeName } from './placeName';
import { fetchRoadNetwork } from './roads';

export { buildLiveScenario, pickHighShelters } from './liveTerrain';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * The elevation must arrive within this long, or the load fails with ELEVATION_UNREACHABLE_MESSAGE. A backstop: the
 * fetchers already fail a stalled download after 20 s without data, but retries and fallbacks add up.
 */
export const LIVE_DEM_DEADLINE_MS = 90_000;
/**
 * Once the elevation is ready, imagery, roads and the place name get this long to finish; the area then loads without
 * whatever is missing (TerrainData.imagery / roads null) instead of waiting on a slow service. Esri renders a 2048²
 * export before sending a byte, which measured 5–12 s on a good connection and occasionally over 15 s, so the grace
 * leaves room for that (the load stays cancellable meanwhile).
 */
export const LIVE_EXTRAS_GRACE_MS = 25_000;

/**
 * Load a live area. `signal` cancels everything (downloads and conditioning); the returned promise then rejects with
 * the abort reason. Imagery, roads and the reverse-geocoded name are best-effort (see LIVE_EXTRAS_GRACE_MS).
 */
export async function loadLiveArea(req: LiveAreaRequest, onProgress?: ProgressFn, signal?: AbortSignal): Promise<TerrainData> {
  signal?.throwIfAborted();
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

  // One controller for the whole load (the caller's signal and the elevation deadline), and a child for the optional
  // downloads so the grace period can drop them without touching the rest.
  const ctrl = new AbortController();
  const extras = new AbortController();
  const onCallerAbort = () => ctrl.abort(signal?.reason);
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const onLoadAbort = () => extras.abort(ctrl.signal.reason);
  ctrl.signal.addEventListener('abort', onLoadAbort, { once: true });
  const timers: ReturnType<typeof setTimeout>[] = [];

  // Progress: while the elevation (the critical path) is pending, the message is about it; the optional downloads
  // only add to the bar. Afterwards the message names whatever is still outstanding.
  const progress = { dem: 0, img: 0, roads: 0 };
  const pending = { img: true, roads: true };
  const got = { img: false, roads: false };
  let demMsg = 'Requesting elevation (USGS 3DEP)…';
  let demDone = false;
  const report = () => {
    const f = 0.02 + 0.5 * progress.dem + 0.2 * progress.img + 0.18 * progress.roads;
    let msg = demMsg;
    if (demDone) {
      const waiting = [pending.img ? 'aerial imagery' : '', pending.roads ? 'roads' : ''].filter(Boolean);
      msg = waiting.length ? `Elevation ready — waiting for ${waiting.join(' and ')}…` : 'Carving rivers and building scenario…';
    } else {
      const extra = [got.img ? 'imagery ✓' : '', got.roads ? 'roads ✓' : ''].filter(Boolean);
      if (extra.length) msg = `${demMsg} (${extra.join(', ')})`;
    }
    if (!ctrl.signal.aborted) onProgress?.(msg, Math.min(0.9, f));
  };
  report();

  try {
    const demP = fetchDEM(
      merc,
      n,
      n,
      cellSize,
      (m, f) => {
        progress.dem = f * 0.95;
        demMsg = m;
        report();
      },
      ctrl.signal,
    );
    const imgP = fetchImagery(merc, 2048, (_m, f) => {
      progress.img = f;
      report();
    }, extras.signal)
      .catch(() => null)
      .then((img) => {
        pending.img = false;
        got.img = !!img;
        report();
        return img;
      });
    const roadsP = fetchRoadNetwork({ nx: n, ny: n, cellSize, bounds }, (_m, f) => {
      progress.roads = f;
      report();
    }, extras.signal)
      .catch((e) => {
        if (!extras.signal.aborted) console.warn('[data] roads unavailable:', e);
        return null;
      })
      .then((rd) => {
        pending.roads = false;
        got.roads = !!rd;
        report();
        return rd;
      });
    const wantName = isCoordinateName(req.name);
    const nameP = wantName ? reverseGeocodeName(lat, lon, extras.signal) : Promise.resolve(req.name!.trim());

    const dem = await new Promise<Awaited<typeof demP>>((resolve, reject) => {
      timers.push(
        setTimeout(() => {
          ctrl.abort(new Error(ELEVATION_UNREACHABLE_MESSAGE));
          reject(new Error(ELEVATION_UNREACHABLE_MESSAGE));
        }, LIVE_DEM_DEADLINE_MS),
      );
      demP.then(resolve, reject);
    });
    ctrl.signal.throwIfAborted();
    progress.dem = 1;
    demDone = true;
    demMsg = dem.source === 'usgs3dep' ? 'Elevation decoded (USGS 3DEP)' : 'Elevation decoded (Terrarium)';
    report();
    await tick();
    // Water detection starts now (in a worker when possible) while imagery and roads finish downloading.
    const conditioner = startLiveConditioning(dem.elevation, n, cellSize);
    let conditioned: LiveTerrainResult;
    let imagery: ImageBitmap | null;
    let roads: Awaited<typeof roadsP>;
    let name: string;
    try {
      const all = Promise.all([imgP, roadsP, nameP]);
      const graceOver = new Promise<'late'>((resolve) => timers.push(setTimeout(() => resolve('late'), LIVE_EXTRAS_GRACE_MS)));
      if ((await Promise.race([all, graceOver])) === 'late') {
        const late = [pending.img ? 'imagery' : '', pending.roads ? 'roads' : ''].filter(Boolean).join(' and ');
        if (late) console.warn(`[data] ${late} did not arrive within ${LIVE_EXTRAS_GRACE_MS / 1000} s of the elevation; loading without`);
        extras.abort(new Error('optional downloads took too long'));
      }
      const [img, rd, nm] = await all;
      ctrl.signal.throwIfAborted();
      [imagery, roads] = [img, rd];
      name = nm || (req.name?.trim() && !wantName ? req.name.trim() : coordinateName(lat, lon));
      onProgress?.('Carving rivers and building scenario…', 0.93);
      await tick();
      conditioned = await abortable(conditioner.finish(roads?.network ?? null, name, dem.source), ctrl.signal);
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
  } finally {
    for (const t of timers) clearTimeout(t);
    signal?.removeEventListener('abort', onCallerAbort);
    // Anything still downloading belongs to a finished (or failed) load.
    if (!extras.signal.aborted) extras.abort(new Error('live load finished'));
  }
}

/** Reject with the signal's reason as soon as it aborts (the promise itself keeps running and is ignored). */
function abortable<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
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

