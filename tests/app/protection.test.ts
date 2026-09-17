/**
 * "What did my wall save?" — the hydrostatic protected-land counterfactual (src/app/protection.ts).
 * Run: node --import tsx --test tests/app/protection.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoadNetwork } from '../../src/contracts';
import { ProtectionAnalyzer, ProtectionController, type ProtectionInput } from '../../src/app/protection';

/**
 * 64×40 valley: a river (rows 30–39, bed 0, surface 3 m) along the south, a flat floodplain (rows 12–29, ground 1 m)
 * and a hill (rows 0–11, ground 10 m) along the north. Cell size 10 m (large water = ≥ 500 cells: the river has 640).
 */
function valley(): ProtectionInput & { set(i: number, j: number, f: 'ground' | 'barrier' | 'depth', v: number): void } {
  const nx = 64;
  const ny = 40;
  const ground = new Float32Array(nx * ny);
  const barrier = new Float32Array(nx * ny);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (j < 12) ground[k] = 10;
      else if (j < 30) ground[k] = 1;
      else {
        ground[k] = 0;
        depth[k] = 3;
      }
    }
  }
  const fields = { ground, barrier, depth };
  return { nx, ny, cellSize: 10, ground, barrier, depth, set: (i, j, f, v) => void (fields[f][j * nx + i] = v) };
}

/** A wall `height` m tall along row `row`, columns i0..i1 inclusive. */
function wallRow(v: ReturnType<typeof valley>, row: number, i0: number, i1: number, height: number) {
  for (let i = i0; i <= i1; i++) v.set(i, row, 'barrier', height);
}

test('protection: no walls → nothing protected, no work', () => {
  const r = new ProtectionAnalyzer().analyze(valley());
  assert.equal(r.wallCells, 0);
  assert.equal(r.cells, 0);
  assert.equal(r.mask, null);
});

test('protection: a levee across the whole floodplain keeps the land behind it dry', () => {
  const v = valley();
  wallRow(v, 28, 0, 63, 4); // top 5 m > surface 3 m, from edge to edge
  const r = new ProtectionAnalyzer().analyze(v);
  // Behind the wall: rows 12–27 (16 rows × 64 columns), flood depth 3 − 1 = 2 m ≥ 0.3.
  assert.equal(r.cells, 16 * 64);
  assert.equal(r.areaM2, 16 * 64 * 100);
  assert.ok(r.level !== null && Math.abs(r.level - 3) < 1e-6);
  assert.ok(r.mask);
  assert.equal(r.mask![20 * 64 + 10], 255);
  assert.equal(r.mask![29 * 64 + 10], 0, 'the strip between river and wall is not protected');
  assert.deepEqual(r.bounds, { x0: 0, y0: 12, x1: 64, y1: 28 });
});

test('protection: a gap, a wall lower than the water, or open ends protect nothing', () => {
  const gap = valley();
  wallRow(gap, 28, 0, 63, 4);
  gap.set(40, 28, 'barrier', 0);
  assert.equal(new ProtectionAnalyzer().analyze(gap).cells, 0, 'gap');

  const low = valley();
  wallRow(low, 28, 0, 63, 1.5); // top 2.5 m < surface 3 m
  assert.equal(new ProtectionAnalyzer().analyze(low).cells, 0, 'overtopped');

  const short = valley();
  wallRow(short, 28, 10, 50, 4);
  assert.equal(new ProtectionAnalyzer().analyze(short).cells, 0, 'open ends');
});

test('protection: a wall tied into high ground at both ends protects the basin it closes', () => {
  const v = valley();
  // Basin: columns 20–40 of the floodplain enclosed by a U of walls open to the hill.
  wallRow(v, 28, 20, 40, 4);
  for (let j = 12; j <= 28; j++) {
    v.set(20, j, 'barrier', 4);
    v.set(40, j, 'barrier', 4);
  }
  const r = new ProtectionAnalyzer().analyze(v);
  assert.equal(r.cells, 16 * 19); // rows 12–27, columns 21–39
});

test('protection: land already flooded behind the wall, puddles and shallow land do not count', () => {
  const v = valley();
  wallRow(v, 28, 0, 63, 4);
  // Flooded right now (0.5 m of water): not protected. Land higher than the water less 0.3 m: not protected.
  v.set(5, 20, 'depth', 0.5);
  v.set(6, 20, 'ground', 2.8);
  const r = new ProtectionAnalyzer().analyze(v);
  assert.equal(r.cells, 16 * 64 - 2);

  // Only a pond (small body of water) against a wall: no seed, nothing held back.
  const p = valley();
  for (let j = 30; j < 40; j++) for (let i = 0; i < 64; i++) p.set(i, j, 'depth', 0);
  wallRow(p, 20, 0, 63, 4);
  for (let i = 0; i < 4; i++) p.set(i, 21, 'depth', 2); // 4-cell pond at 3 m against the wall
  assert.equal(new ProtectionAnalyzer().analyze(p).cells, 0);
});

test('protection: counts roads whose midpoint lies on protected land', () => {
  const v = valley();
  wallRow(v, 28, 0, 63, 4);
  const road = (pts: number[], length: number) => ({ a: 0, b: 1, length, cls: 'local' as const, pts: new Float32Array(pts) });
  const roads: RoadNetwork = {
    nodes: new Float32Array([0, 0, 1, 1]),
    edges: [road([5, 20, 15, 20, 25, 20], 200), road([5, 33, 25, 33], 200), road([30.5, 15.5, 30.5, 25.5], 100)],
  };
  const r = new ProtectionAnalyzer().analyze({ ...v, roads });
  assert.equal(r.roadEdges, 2);
  assert.equal(r.roadMeters, 300);
});

test('protection: reuses its buffers across runs and grid sizes', () => {
  const a = new ProtectionAnalyzer();
  const v = valley();
  wallRow(v, 28, 0, 63, 4);
  const first = a.analyze(v).cells;
  v.set(10, 28, 'barrier', 0);
  assert.equal(a.analyze(v).cells, 0);
  v.set(10, 28, 'barrier', 4);
  assert.equal(a.analyze(v).cells, first);
});

test('protection controller: runs at most once per interval, publishes null without walls, confirms a collapse', () => {
  const published: Array<number | null> = [];
  const c = new ProtectionController({ publish: (r) => published.push(r ? r.cells : null) }, 1000);
  const v = valley();
  wallRow(v, 28, 0, 63, 4);
  c.onSnapshot();
  c.tick(0, () => v);
  c.onSnapshot();
  c.tick(500, () => v); // too soon
  assert.deepEqual(published, [16 * 64]);
  // A gap opens (e.g. a surge caught mid-readback): held once, published when the next run confirms it.
  c.onSnapshot();
  c.tick(1000, () => ({ ...v, barrier: withGap(v.barrier) }));
  assert.deepEqual(published, [16 * 64], 'collapse held for confirmation');
  c.tick(1500, () => ({ ...v, barrier: withGap(v.barrier) }));
  assert.deepEqual(published, [16 * 64, 0]);
  // Walls erased: null.
  c.onSnapshot();
  c.tick(2600, () => ({ ...v, barrier: new Float32Array(v.barrier.length) }));
  assert.deepEqual(published, [16 * 64, 0, null]);
});

/** Same number of wall cells, but one moved off the line: a gap at column 10 and a stray cell inland. */
function withGap(barrier: Float32Array): Float32Array {
  const b = barrier.slice();
  b[28 * 64 + 10] = 0;
  b[15 * 64 + 40] = 4;
  return b;
}
