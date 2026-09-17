/**
 * The protected-land analysis in a Web Worker (src/app/protectionWorker.ts). Per run the page copies the depth field
 * (4 MB at 1024², well under a millisecond); ground and barrier are copied only after a terrain edit, road midpoints
 * once per network. Kept apart from protection.ts so the worker bundle does not include its own constructor.
 */
import type { RoadNetwork } from '../contracts';
import { roadMidpoints, type ProtectionBackend, type ProtectionInput, type ProtectionResult } from './protection';
import type { ProtectionWorkerRequest, ProtectionWorkerResponse } from './protectionWorker';

export function createProtectionWorker(): ProtectionBackend | null {
  if (typeof Worker !== 'function') return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./protectionWorker.ts', import.meta.url), { type: 'module', name: 'deluge-protection' });
  } catch (e) {
    console.warn('[deluge] protected-land worker unavailable, analysing on the main thread:', e);
    return null;
  }
  type Waiter = { resolve(v: { result: ProtectionResult; ms: number }): void; reject(e: Error): void };
  const waiting = new Map<number, Waiter>();
  let nextId = 1;
  let broken: Error | null = null;
  /** What the worker holds: the terrain arrays (by identity + version) and the road network it was sent. */
  let sentTerrain: { barrier: Float32Array; ground: Float32Array; version: number | undefined } | null = null;
  let sentRoads: RoadNetwork | null | undefined;

  const fail = (e: Error) => {
    broken = e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    worker.terminate();
  };
  worker.onmessage = (e: MessageEvent<ProtectionWorkerResponse>) => {
    const m = e.data;
    const w = waiting.get(m.id);
    if (!w) return;
    waiting.delete(m.id);
    if (m.type === 'error') {
      // The worker may have lost its terrain: resend it with the next run.
      sentTerrain = null;
      sentRoads = undefined;
      w.reject(new Error(m.message));
    } else {
      w.resolve({ result: { ...m.result, mask: m.mask }, ms: m.ms });
    }
  };
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    fail(new Error(e.message || 'protected-land worker failed'));
  };
  worker.onmessageerror = () => fail(new Error('protected-land worker message could not be deserialized'));

  return {
    analyze(input: ProtectionInput) {
      if (broken) return Promise.reject(broken);
      const id = nextId++;
      const msg: ProtectionWorkerRequest = { type: 'run', id, nx: input.nx, ny: input.ny, cellSize: input.cellSize, depth: input.depth.slice() };
      const transfer: Transferable[] = [msg.depth.buffer];
      const version = input.terrainVersion;
      if (
        !sentTerrain ||
        version === undefined ||
        sentTerrain.barrier !== input.barrier ||
        sentTerrain.ground !== input.ground ||
        sentTerrain.version !== version
      ) {
        msg.ground = input.ground.slice();
        msg.barrier = input.barrier.slice();
        msg.version = version;
        transfer.push(msg.ground.buffer, msg.barrier.buffer);
        sentTerrain = { barrier: input.barrier, ground: input.ground, version };
      }
      const roads = input.roads ?? null;
      if (roads !== sentRoads) {
        msg.roads = roads ? roadMidpoints(roads).slice() : new Float32Array(0);
        transfer.push(msg.roads.buffer);
        sentRoads = roads;
      }
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        try {
          worker.postMessage(msg, transfer);
        } catch (e) {
          waiting.delete(id);
          sentTerrain = null;
          sentRoads = undefined;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    },
  };
}
