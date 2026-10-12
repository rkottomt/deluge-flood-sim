/**
 * Web Worker for the glacier hazard chain (src/hazard/chain.ts), so a 27-member ensemble — seconds of CPU — never
 * stalls the page. Driven by src/hazard/workerClient.ts.
 *
 * Protocol (every request is answered once; progress messages may precede the answer):
 *   → { type: 'run', id, spec, file, overrides? }                one deterministic run (+ its front profile)
 *   → { type: 'ensemble', id, spec, file, overrides?, memberDx? } the §I.5 ensemble
 *   ← { type: 'progress', id, done, total }                       ensemble only
 *   ← { type: 'result', id, ms, result }  |  { type: 'ensemble', id, ms, ensemble }
 *   ← { type: 'error', id, message }
 *
 * The ChainFile is structured-cloned on every request (≤ 100 KB by the bake's budget); the worker keeps the last one
 * it saw by `name` + node count so its prepared network (src/hazard/routing.ts, cached per file object) is reused
 * across slider changes.
 */
import type { ChainFile, HazardChainSpec } from './types';
import { runEnsemble, type ChainOverrides, type ChainRunResult, type EnsembleResult } from './chain';
import { runChainWithProfile } from './frontProfile';

export type HazardWorkerRequest =
  | { type: 'run'; id: number; spec: HazardChainSpec; file: ChainFile; overrides?: ChainOverrides }
  | { type: 'ensemble'; id: number; spec: HazardChainSpec; file: ChainFile; overrides?: ChainOverrides; memberDx?: number };

export type HazardWorkerResponse =
  | { type: 'progress'; id: number; done: number; total: number }
  | { type: 'result'; id: number; ms: number; result: ChainRunResult }
  | { type: 'ensemble'; id: number; ms: number; ensemble: EnsembleResult }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<HazardWorkerRequest>) => void) | null;
  postMessage(m: HazardWorkerResponse): void;
};

let lastFile: ChainFile | null = null;

/** Reuse the previous file object when the same file arrives again, so its prepared network stays cached. */
function sameFile(f: ChainFile): ChainFile {
  if (lastFile && lastFile.name === f.name && lastFile.s.length === f.s.length && lastFile.s[lastFile.s.length - 1] === f.s[f.s.length - 1]) return lastFile;
  lastFile = f;
  return f;
}

scope.onmessage = (e) => {
  const m = e.data;
  const t0 = performance.now();
  try {
    const file = sameFile(m.file);
    if (m.type === 'run') {
      // With the front-arrival profile for the early-warning designer (src/hazard/frontProfile.ts; same stations).
      const result = runChainWithProfile(m.spec, file, m.overrides);
      scope.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, result });
    } else {
      const ensemble = runEnsemble(m.spec, file, m.overrides, {
        memberDx: m.memberDx,
        onProgress: (done, total) => scope.postMessage({ type: 'progress', id: m.id, done, total }),
      });
      scope.postMessage({ type: 'ensemble', id: m.id, ms: performance.now() - t0, ensemble });
    }
  } catch (err) {
    scope.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
