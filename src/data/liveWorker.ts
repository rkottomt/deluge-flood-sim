/**
 * Web Worker for live-area terrain conditioning (see liveTerrain.ts), so detecting and burning water bodies and
 * building the scenario (seconds at 2048²) don't freeze the page while a live area loads.
 *
 * Protocol (one job per worker):
 *   → { type: 'detect', elevation, n, cellSize }             start water detection as soon as the DEM is decoded
 *   → { type: 'finish', roads, name, demSource }             queued behind 'detect'; roads may still be downloading
 *                                                            when detection starts
 *   ← { type: 'done', elevation, scenario, stats }           elevation's buffer is transferred
 *   ← { type: 'error', message }
 */
import type { RoadNetwork, ScenarioPreset } from '../contracts';
import type { WaterBody } from './hydro';
import { detectLiveWater, finishLiveTerrain } from './liveTerrain';

export type LiveWorkerRequest =
  | { type: 'detect'; elevation: Float32Array; n: number; cellSize: number }
  | { type: 'finish'; roads: RoadNetwork | null; name: string; demSource: string };

export type LiveWorkerResponse =
  | { type: 'done'; elevation: Float32Array; scenario: ScenarioPreset; stats: { bodies: number; openedBands: number; openedCells: number } }
  | { type: 'error'; message: string };

const scope = self as unknown as { onmessage: ((e: MessageEvent<LiveWorkerRequest>) => void) | null; postMessage(m: LiveWorkerResponse, transfer?: Transferable[]): void };

let job: { elevation: Float32Array; n: number; cellSize: number; bodies: WaterBody[] } | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'detect') {
      job = { elevation: m.elevation, n: m.n, cellSize: m.cellSize, bodies: detectLiveWater(m.elevation, m.n, m.cellSize) };
    } else if (m.type === 'finish') {
      if (!job) throw new Error('finish before detect');
      const r = finishLiveTerrain(job.elevation, job.n, job.cellSize, job.bodies, m.roads, m.name, m.demSource);
      job = null;
      scope.postMessage({ type: 'done', elevation: r.elevation, scenario: r.scenario, stats: r.stats }, [r.elevation.buffer]);
    }
  } catch (err) {
    job = null;
    scope.postMessage({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
  }
};
