/// <reference types="node" />
/**
 * Performance targets (DESIGN.md §6): 50k edges — setNetwork < 150 ms, updateFlood on a 1024² depth grid
 * < 5 ms, route < 10 ms. Timings are printed so regressions are visible in the test log.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/routing/index';
import type { RoadEdge, RoadNetwork } from '../../src/contracts';
import { makeCity, shelterAt } from './city';

const N = 1024;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

function time(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

/** Smooth, partially flooded depth field with dry, wet and flooded roads and a river band. */
function floodField(phase: number): Float32Array {
  const d = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const row = j * N;
    const river = Math.abs(j - N / 2) < 8 ? 5 : 0;
    for (let i = 0; i < N; i++) {
      const w = 0.45 * Math.sin(i * 0.013 + phase) * Math.cos(j * 0.011 - phase * 0.7) - 0.1;
      d[row + i] = Math.max(river, w);
    }
  }
  return d;
}

/**
 * A long-edge network: 50k random polylines of ~40 cells with 6 points each (≈ 2M cell samples) — far more
 * cells per edge than TIGER data merged into degree-2 chains typically has, as a stress case.
 */
function longEdgeNetwork(edges: number): RoadNetwork {
  let s = 7;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const nodes = new Float32Array(edges * 4);
  const list: RoadEdge[] = [];
  for (let e = 0; e < edges; e++) {
    const pts = new Float32Array(12);
    let x = rand() * (N - 80) + 40, y = rand() * (N - 80) + 40;
    let len = 0;
    for (let q = 0; q < 6; q++) {
      if (q > 0) {
        const nx = x + (rand() - 0.5) * 16, ny = y + (rand() - 0.5) * 16;
        len += Math.hypot(nx - x, ny - y);
        x = nx;
        y = ny;
      }
      pts[2 * q] = x;
      pts[2 * q + 1] = y;
    }
    nodes.set([pts[0], pts[1], pts[10], pts[11]], e * 4);
    list.push({ a: 2 * e, b: 2 * e + 1, length: len * 8, cls: 'local', pts });
  }
  return { nodes, edges: list };
}

test('performance at 50k edges (grid city)', () => {
  // 158 × 158 blocks of 6 cells ≈ 50k edges with 4-point polylines covering a ~1000² grid.
  const city = makeCity({ blocks: 158, block: 6, interior: 2 });
  const edges = city.net.edges.length;
  assert.ok(edges >= 50_000, `network has ${edges} edges`);

  const router = createRouter();
  const buildCold = time(() => router.setNetwork(city.net, city.cellSize));
  const builds: number[] = [];
  for (let k = 0; k < 5; k++) builds.push(time(() => router.setNetwork(city.net, city.cellSize)));
  const info = router.getGraphInfo()!;

  const fields = [floodField(0), floodField(1.3), floodField(2.1)];
  const indexBuild = time(() => router.updateFlood(fields[0], N, N)); // first call builds the sample index
  for (let k = 0; k < 10; k++) router.updateFlood(fields[k % 3], N, N);
  const updates: number[] = [];
  for (let k = 0; k < 60; k++) updates.push(time(() => router.updateFlood(fields[k % 3], N, N)));
  const status = router.getRoadStatus()!;
  const counts = [0, 0, 0];
  for (const s of status) counts[s]++;

  // Routes between random points with 3 shelters, over the flooded network.
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pt = () => ({ gx: 20 + rand() * (city.nx - 40), gy: 20 + rand() * (city.ny - 40) });
  const routes: number[] = [];
  const states = { ok: 0, blocked: 0, none: 0 };
  for (let k = 0; k < 20; k++) router.route(pt(), [shelterAt('A', 100, 100)]);
  for (let k = 0; k < 200; k++) {
    const start = pt();
    const shelters = [shelterAt('A', ...xy(pt())), shelterAt('B', ...xy(pt())), shelterAt('C', ...xy(pt()))];
    const t0 = performance.now();
    const r = router.route(start, shelters);
    routes.push(performance.now() - t0);
    states[r.state]++;
  }
  // Dry network, far-apart start and shelter: the search has to settle most of the graph.
  router.updateFlood(new Float32Array(N * N), N, N);
  const longest: number[] = [];
  for (let k = 0; k < 30; k++) {
    longest.push(time(() => router.route({ gx: 30, gy: 30 }, [shelterAt('far', city.nx - 30, city.ny - 30)])));
  }

  const p95 = [...routes].sort((a, b) => a - b)[Math.floor(routes.length * 0.95)];
  console.log(
    `[routing perf] grid city: ${edges} edges, ${info.nodes} nodes, ${info.samples} cell samples\n` +
      `  setNetwork   cold ${buildCold.toFixed(1)} ms, warm median ${median(builds).toFixed(1)} ms\n` +
      `  updateFlood  first (index build) ${indexBuild.toFixed(1)} ms, median ${median(updates).toFixed(2)} ms, max ${Math.max(...updates).toFixed(2)} ms` +
      `  (status dry/wet/flooded = ${counts.join('/')})\n` +
      `  route        median ${median(routes).toFixed(2)} ms, p95 ${p95.toFixed(2)} ms, max ${Math.max(...routes).toFixed(2)} ms` +
      `  (ok ${states.ok}, blocked ${states.blocked}, none ${states.none})\n` +
      `  route        corner-to-corner on dry network: median ${median(longest).toFixed(2)} ms`,
  );

  assert.ok(counts[0] > 0 && counts[1] > 0 && counts[2] > 0, 'test field produces all three statuses');
  assert.ok(states.ok > 20 && states.blocked > 5, 'mix of ok and blocked routes');
  // Best-of-N filters out scheduler noise (tests run in parallel, other processes share the CPU); the cold,
  // JIT-unwarmed first call is printed above and only sanity-bounded.
  const buildBest = Math.min(buildCold, ...builds);
  assert.ok(buildBest < 150, `setNetwork ${buildBest.toFixed(1)} ms < 150 ms`);
  assert.ok(buildCold < 400, `cold setNetwork ${buildCold.toFixed(1)} ms`);
  assert.ok(median(updates) < 5, `updateFlood ${median(updates).toFixed(2)} ms < 5 ms`);
  assert.ok(p95 < 10, `route p95 ${p95.toFixed(2)} ms < 10 ms`);
  assert.ok(median(longest) < 10, `corner-to-corner route ${median(longest).toFixed(2)} ms < 10 ms`);
});

test('performance at 50k long edges (≈2M cell samples stress case)', () => {
  const net = longEdgeNetwork(50_000);
  const router = createRouter();
  const build = time(() => router.setNetwork(net, 8));
  const info = router.getGraphInfo()!;
  const fields = [floodField(0), floodField(1.3)];
  router.updateFlood(fields[0], N, N);
  for (let k = 0; k < 10; k++) router.updateFlood(fields[k % 2], N, N);
  const updates: number[] = [];
  for (let k = 0; k < 40; k++) updates.push(time(() => router.updateFlood(fields[k % 2], N, N)));
  console.log(
    `[routing perf] long edges: ${info.edges} edges, ${info.samples} cell samples — setNetwork ${build.toFixed(1)} ms, ` +
      `updateFlood median ${median(updates).toFixed(2)} ms`,
  );
  assert.ok(build < 400, `setNetwork (stress) ${build.toFixed(1)} ms`);
  // Stress case well beyond the spec workload (4–5× the samples); generous bound so machine load can't flake it.
  assert.ok(median(updates) < 15, `updateFlood (stress) ${median(updates).toFixed(2)} ms`);
});

function xy(p: { gx: number; gy: number }): [number, number] {
  return [p.gx, p.gy];
}
