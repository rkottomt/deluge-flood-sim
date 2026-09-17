/// <reference types="node" />
/**
 * Performance targets (DESIGN.md §6): 50k edges — setNetwork < 150 ms, updateFlood on a 1024² depth grid
 * < 5 ms, route < 10 ms. Real wall-clock timings are printed so regressions are visible in the test log; the
 * assertions use main-thread CPU time, best of several interleaved passes per workload item and rescaled by the
 * machine's current slowdown (see timing.ts), so they hold when the tests share the machine with GPU tests and
 * other processes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/routing/index';
import type { RoadEdge, RoadNetwork } from '../../src/contracts';
import { makeCity, shelterAt } from './city';
import { bestOfPasses, quantile, summarize, timeCall } from './timing';

const N = 1024;

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
  const cold = timeCall(() => router.setNetwork(city.net, city.cellSize));
  const BUILD_PASSES = 5;
  const builds = bestOfPasses([0], BUILD_PASSES, () => router.setNetwork(city.net, city.cellSize));
  const info = router.getGraphInfo()!;

  const fields = [floodField(0), floodField(1.3), floodField(2.1)];
  const indexBuild = timeCall(() => router.updateFlood(fields[0], N, N)); // first call builds the sample index
  for (let k = 0; k < 10; k++) router.updateFlood(fields[k % 3], N, N);
  const UPDATE_PASSES = 20;
  const updates = bestOfPasses(fields, UPDATE_PASSES, (f) => router.updateFlood(f, N, N));
  router.updateFlood(fields[0], N, N);
  const status = router.getRoadStatus()!;
  const counts = [0, 0, 0];
  for (const s of status) counts[s]++;

  // Routes between random points with 3 shelters, over the flooded network.
  let seed = 3;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const pt = () => ({ gx: 20 + rand() * (city.nx - 40), gy: 20 + rand() * (city.ny - 40) });
  for (let k = 0; k < 20; k++) router.route(pt(), [shelterAt('A', 100, 100)]);
  const queries = Array.from({ length: 200 }, () => ({
    start: pt(),
    shelters: [shelterAt('A', ...xy(pt())), shelterAt('B', ...xy(pt())), shelterAt('C', ...xy(pt()))],
  }));
  const states = { ok: 0, blocked: 0, none: 0 };
  for (const q of queries) states[router.route(q.start, q.shelters).state]++;
  const ROUTE_PASSES = 3;
  const routes = bestOfPasses(queries, ROUTE_PASSES, (q) => router.route(q.start, q.shelters));

  // Dry network, start and shelter in opposite corners: the search has to settle most of the graph.
  router.updateFlood(new Float32Array(N * N), N, N);
  const [lo, hiX, hiY] = [30, city.nx - 30, city.ny - 30];
  const corners = [
    [lo, lo, hiX, hiY],
    [hiX, lo, lo, hiY],
    [lo, hiY, hiX, lo],
    [hiX, hiY, lo, lo],
  ].map(([sx, sy, tx, ty]) => ({ start: { gx: sx, gy: sy }, shelters: [shelterAt('far', tx, ty)] }));
  const LONG_PASSES = 8;
  const longest = bestOfPasses(corners, LONG_PASSES, (q) => router.route(q.start, q.shelters));

  console.log(
    `[routing perf] grid city: ${edges} edges, ${info.nodes} nodes, ${info.samples} cell samples\n` +
      `  setNetwork   cold ${cold.wall.toFixed(1)} ms (cpu ${cold.cpu.toFixed(1)}), warm ${summarize(builds, BUILD_PASSES)}\n` +
      `  updateFlood  first (index build) ${indexBuild.wall.toFixed(1)} ms, ${summarize(updates, UPDATE_PASSES)}` +
      `  (status dry/wet/flooded = ${counts.join('/')})\n` +
      `  route        ${summarize(routes, ROUTE_PASSES)}  (ok ${states.ok}, blocked ${states.blocked}, none ${states.none})\n` +
      `  route        corner-to-corner on dry network: ${summarize(longest, LONG_PASSES)}`,
  );

  assert.ok(counts[0] > 0 && counts[1] > 0 && counts[2] > 0, 'test field produces all three statuses');
  assert.ok(states.ok > 20 && states.blocked > 5, 'mix of ok and blocked routes');
  // Normalized CPU times (timing.ts): what the call costs on the demo machine's performance core.
  const build = builds.norm[0];
  assert.ok(build < 150, `setNetwork ${build.toFixed(1)} ms < 150 ms`);
  // The cold, JIT-unwarmed first call is only sanity-bounded (single sample: CPU time, no normalization).
  assert.ok(cold.cpu < 400, `cold setNetwork ${cold.cpu.toFixed(1)} ms cpu < 400 ms`);
  const update = Math.max(...updates.norm);
  assert.ok(update < 5, `updateFlood ${update.toFixed(2)} ms < 5 ms (slowest of the 3 fields)`);
  const routeP95 = quantile(routes.norm, 0.95);
  assert.ok(routeP95 < 10, `route p95 ${routeP95.toFixed(2)} ms < 10 ms`);
  const corner = Math.max(...longest.norm);
  assert.ok(corner < 10, `corner-to-corner route ${corner.toFixed(2)} ms < 10 ms`);
});

test('performance at 50k long edges (≈2M cell samples stress case)', () => {
  const net = longEdgeNetwork(50_000);
  const router = createRouter();
  const build = timeCall(() => router.setNetwork(net, 8));
  const info = router.getGraphInfo()!;
  const fields = [floodField(0), floodField(1.3)];
  router.updateFlood(fields[0], N, N);
  for (let k = 0; k < 10; k++) router.updateFlood(fields[k % 2], N, N);
  const PASSES = 20;
  const updates = bestOfPasses(fields, PASSES, (f) => router.updateFlood(f, N, N));
  console.log(
    `[routing perf] long edges: ${info.edges} edges, ${info.samples} cell samples — setNetwork ${build.wall.toFixed(1)} ms ` +
      `(cpu ${build.cpu.toFixed(1)}), updateFlood ${summarize(updates, PASSES)}`,
  );
  assert.ok(build.cpu < 400, `setNetwork (stress) ${build.cpu.toFixed(1)} ms cpu`);
  // Stress case well beyond the spec workload (4–5× the samples, ≈6 ms on a full-speed M4 performance core): an
  // order-of-magnitude guard with a generous bound, since slowdowns beyond timing.ts's cap are not compensated.
  const update = Math.max(...updates.norm);
  assert.ok(update < 20, `updateFlood (stress) ${update.toFixed(2)} ms`);
});

function xy(p: { gx: number; gy: number }): [number, number] {
  return [p.gx, p.gy];
}
