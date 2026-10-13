/**
 * The hazard chain in a Web Worker (src/hazard/worker.ts), with a main-thread fallback where workers are unavailable
 * (the chain is pure: the fallback gives the same numbers, only slower to the page). Kept apart from worker.ts so the
 * worker bundle does not include its own constructor; the worker is same-origin ('self' under the CSP's worker-src),
 * built by Vite from `new Worker(new URL(...), { type: 'module' })` like src/app/protectionWorkerClient.ts.
 *
 * Requests are answered in order; a newer `run` does not cancel an older one — callers that drive the chain from a
 * slider should drop stale answers by id (the promise resolves with the id).
 */
import type { ChainFile, HazardChainSpec } from './types';
import type { ChainOverrides, ChainRunResult, EnsembleResult } from './chain';
import type { HazardWorkerRequest, HazardWorkerResponse } from './worker';

export interface HazardChainBackend {
  run(spec: HazardChainSpec, file: ChainFile, overrides?: ChainOverrides): Promise<{ id: number; ms: number; result: ChainRunResult }>;
  ensemble(
    spec: HazardChainSpec,
    file: ChainFile,
    overrides?: ChainOverrides,
    opts?: { memberDx?: number; onProgress?: (done: number, total: number) => void },
  ): Promise<{ id: number; ms: number; ensemble: EnsembleResult }>;
  /** True when the work runs off the main thread. */
  readonly offThread: boolean;
  /**
   * True once the backend can answer nothing more (its worker crashed or could not deserialize a message): every
   * further request would be refused. The owner disposes it and makes a new one (src/app/hazardChain.ts).
   */
  readonly broken?: boolean;
  dispose(): void;
}

/** Main-thread fallback: the same functions, loaded on first use. */
function inlineBackend(): HazardChainBackend {
  let nextId = 1;
  return {
    offThread: false,
    async run(spec, file, overrides) {
      const { runChainWithProfile } = await import('./frontProfile');
      const t0 = performance.now();
      const result = runChainWithProfile(spec, file, overrides);
      return { id: nextId++, ms: performance.now() - t0, result };
    },
    async ensemble(spec, file, overrides, opts) {
      const { runEnsemble } = await import('./chain');
      const t0 = performance.now();
      const ensemble = runEnsemble(spec, file, overrides, opts);
      return { id: nextId++, ms: performance.now() - t0, ensemble };
    },
    dispose() {},
  };
}

export function createHazardWorker(): HazardChainBackend {
  if (typeof Worker !== 'function') return inlineBackend();
  let worker: Worker;
  try {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'deluge-hazard-chain' });
  } catch (e) {
    console.warn('[deluge] hazard-chain worker unavailable, running on the main thread:', e);
    return inlineBackend();
  }
  type Waiter = { resolve(m: HazardWorkerResponse): void; reject(e: Error): void; onProgress?: (done: number, total: number) => void };
  const waiting = new Map<number, Waiter>();
  let nextId = 1;
  let broken: Error | null = null;
  const fail = (e: Error) => {
    broken = e;
    for (const w of waiting.values()) w.reject(e);
    waiting.clear();
    worker.terminate();
  };
  worker.onmessage = (e: MessageEvent<HazardWorkerResponse>) => {
    const m = e.data;
    const w = waiting.get(m.id);
    if (!w) return;
    if (m.type === 'progress') {
      w.onProgress?.(m.done, m.total);
      return;
    }
    waiting.delete(m.id);
    if (m.type === 'error') w.reject(new Error(m.message));
    else w.resolve(m);
  };
  worker.onerror = (e: ErrorEvent) => {
    e.preventDefault();
    fail(new Error(e.message || 'hazard-chain worker failed'));
  };
  worker.onmessageerror = () => fail(new Error('hazard-chain worker message could not be deserialized'));

  const send = (msg: HazardWorkerRequest, onProgress?: Waiter['onProgress']): Promise<HazardWorkerResponse> => {
    if (broken) return Promise.reject(broken);
    return new Promise((resolve, reject) => {
      waiting.set(msg.id, { resolve, reject, onProgress });
      try {
        worker.postMessage(msg);
      } catch (err) {
        waiting.delete(msg.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  };

  return {
    offThread: true,
    get broken() {
      return broken !== null;
    },
    async run(spec, file, overrides) {
      const id = nextId++;
      const m = await send({ type: 'run', id, spec, file, overrides });
      if (m.type !== 'result') throw new Error(`hazard-chain worker answered ${m.type} to a run`);
      return { id, ms: m.ms, result: m.result };
    },
    async ensemble(spec, file, overrides, opts) {
      const id = nextId++;
      const m = await send({ type: 'ensemble', id, spec, file, overrides, memberDx: opts?.memberDx }, opts?.onProgress);
      if (m.type !== 'ensemble') throw new Error(`hazard-chain worker answered ${m.type} to an ensemble`);
      return { id, ms: m.ms, ensemble: m.ensemble };
    },
    dispose() {
      fail(new Error('hazard-chain worker disposed'));
    },
  };
}
