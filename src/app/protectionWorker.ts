/**
 * Web Worker for the protected-land analysis (src/app/protection.ts), so its flood fills never stall the page's main
 * thread while the levee demo runs. Driven by src/app/protectionWorkerClient.ts.
 *
 * Protocol (every request is answered once, in order):
 *   → { type: 'run', id, nx, ny, cellSize, depth, ground?, barrier?, version?, roads? }
 *        depth is this run's water; ground + barrier (with the solver's terrain version) are sent only when the
 *        terrain changed, roads (packed midpoints, see roadMidpoints; empty = none) only when the network changed.
 *   ← { type: 'result', id, ms, result, mask }      result without its mask; mask (nx·ny) is a transferred copy or null
 *   ← { type: 'error', id, message }
 */
import { ProtectionAnalyzer, type ProtectionResult } from './protection';

export interface ProtectionWorkerRequest {
  type: 'run';
  id: number;
  nx: number;
  ny: number;
  cellSize: number;
  depth: Float32Array;
  ground?: Float32Array;
  barrier?: Float32Array;
  version?: number;
  roads?: Float32Array;
}

export type ProtectionWorkerResponse =
  | { type: 'result'; id: number; ms: number; result: Omit<ProtectionResult, 'mask'>; mask: Uint8Array | null }
  | { type: 'error'; id: number; message: string };

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<ProtectionWorkerRequest>) => void) | null;
  postMessage(m: ProtectionWorkerResponse, transfer?: Transferable[]): void;
};

const analyzer = new ProtectionAnalyzer();
let terrain: { ground: Float32Array; barrier: Float32Array; version?: number } | null = null;
let roads: Float32Array | null = null;

scope.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.ground && m.barrier) terrain = { ground: m.ground, barrier: m.barrier, version: m.version };
    if (m.roads) roads = m.roads.length ? m.roads : null;
    const n = m.nx * m.ny;
    if (!terrain || terrain.ground.length !== n || terrain.barrier.length !== n) throw new Error('no terrain for this grid');
    const t0 = performance.now();
    const r = analyzer.analyze({
      nx: m.nx,
      ny: m.ny,
      cellSize: m.cellSize,
      ground: terrain.ground,
      barrier: terrain.barrier,
      depth: m.depth,
      roadMids: roads,
      terrainVersion: terrain.version,
    });
    // The analyzer reuses its mask between runs: hand over a copy.
    const mask = r.mask ? r.mask.slice() : null;
    const { mask: _owned, ...result } = r;
    void _owned;
    scope.postMessage({ type: 'result', id: m.id, ms: performance.now() - t0, result, mask }, mask ? [mask.buffer] : []);
  } catch (err) {
    scope.postMessage({ type: 'error', id: m.id, message: err instanceof Error ? err.message : String(err) });
  }
};
