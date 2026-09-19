/**
 * The grid-convergence harness's own arithmetic (scripts/reference-run.ts), on inputs whose answers can be worked
 * out by hand. No GPU: these are the pure functions that turn two runs into the numbers ARCHITECTURE.md §9 quotes,
 * and a silent bug in any of them (an off-by-one in the refinement, a mask compared against the wrong grid, an
 * arrival time that reports the sampling interval instead of the crossing) would make the published agreement
 * figures wrong in a way the runs themselves could never reveal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arrivalTime,
  blockMean,
  discCells,
  fieldError,
  gpuBytesEstimate,
  iou,
  maskAnd,
  maskAtLeast,
  maskCount,
  maskOr,
  pctDiff,
  refineField,
  refineMask,
} from '../../scripts/reference-run';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);

test('refineField nearest replicates every coarse cell into its r² fine cells', () => {
  const src = Float32Array.from([1, 2, 3, 4]); // 2×2
  const out = refineField(src, 2, 2, 'nearest');
  assert.equal(out.length, 16);
  assert.deepEqual([...out], [1, 1, 2, 2, 1, 1, 2, 2, 3, 3, 4, 4, 3, 3, 4, 4]);
});

test('refineField nearest preserves block means exactly, so the initial volume is unchanged', () => {
  const n0 = 8;
  const src = new Float32Array(n0 * n0);
  for (let k = 0; k < src.length; k++) src[k] = Math.sin(k * 0.7) * 10;
  for (const r of [2, 4]) {
    const fine = refineField(src, n0, r, 'nearest');
    const back = blockMean(fine, n0 * r, r);
    assert.deepEqual([...back], [...src]);
  }
});

test('refineField bilinear reproduces a linear field exactly (no shift, no edge bias)', () => {
  // f = 3·gx + 7·gy sampled at coarse cell centres; the bilinear interpolant of those samples is f itself, so the
  // fine grid must see f at ITS cell centres. A half-cell offset error would show up as a constant bias.
  const n0 = 8;
  const r = 4;
  const at = (gx: number, gy: number) => 3 * gx + 7 * gy;
  const src = new Float32Array(n0 * n0);
  for (let j = 0; j < n0; j++) for (let i = 0; i < n0; i++) src[j * n0 + i] = at(i + 0.5, j + 0.5);
  const fine = refineField(src, n0, r, 'bilinear');
  const n = n0 * r;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Only the interior: bilinear clamps outside the coarse centres, so the outer half coarse-cell is flat.
      const gx = (i + 0.5) / r;
      const gy = (j + 0.5) / r;
      if (gx < 0.5 || gy < 0.5 || gx > n0 - 0.5 || gy > n0 - 0.5) continue;
      close(fine[j * n + i], at(gx, gy), 2e-4);
    }
  }
});

test('refineField bilinear clamps at the border instead of extrapolating', () => {
  const src = Float32Array.from([0, 10, 20, 30]); // 2×2, steep
  const out = refineField(src, 2, 2, 'bilinear');
  // Corner fine cells sit outside the coarse cell centres: they take the corner value, never an extrapolation.
  assert.equal(out[0], 0);
  assert.equal(out[3], 10);
  assert.equal(out[12], 20);
  assert.equal(out[15], 30);
  for (const v of out) assert.ok(v >= 0 && v <= 30, `${v} outside [0, 30]`);
});

test('refineField r = 1 copies rather than aliasing the caller’s array', () => {
  const src = Float32Array.from([1, 2, 3, 4]);
  const out = refineField(src, 2, 1, 'bilinear');
  out[0] = 99;
  assert.equal(src[0], 1);
});

test('refineMask replicates and refineField(nearest) agree on where water is', () => {
  const m = Uint8Array.from([1, 0, 0, 1]);
  assert.deepEqual([...refineMask(m, 2, 2)], [1, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 1]);
});

test('blockMean averages r² cells and halves the grid', () => {
  const src = Float32Array.from([1, 3, 0, 0, 5, 7, 0, 0, 0, 0, 2, 2, 0, 0, 2, 2]); // 4×4
  const out = blockMean(src, 4, 2);
  assert.equal(out.length, 4);
  assert.deepEqual([...out], [4, 0, 0, 2]);
});

test('maskAtLeast is inclusive at the threshold and rejects NaN', () => {
  const f = Float32Array.from([0.14, 0.15, 0.16, NaN]);
  assert.deepEqual([...maskAtLeast(f, 0.15)], [0, 1, 1, 0]);
});

test('mask and / or / count', () => {
  const a = Uint8Array.from([1, 1, 0, 0]);
  const b = Uint8Array.from([1, 0, 1, 0]);
  assert.deepEqual([...maskAnd(a, b)], [1, 0, 0, 0]);
  assert.deepEqual([...maskOr(a, b)], [1, 1, 1, 0]);
  assert.equal(maskCount(a), 2);
});

test('iou counts intersection, union and each side’s exclusive cells', () => {
  const a = Uint8Array.from([1, 1, 1, 0, 0]);
  const b = Uint8Array.from([0, 1, 1, 1, 0]);
  const o = iou(a, b);
  assert.equal(o.inter, 2);
  assert.equal(o.onlyA, 1);
  assert.equal(o.onlyB, 1);
  assert.equal(o.union, 4);
  close(o.iou, 0.5);
});

test('iou of two empty masks is 1, not 0/0', () => {
  const e = new Uint8Array(9);
  assert.equal(iou(e, e).iou, 1);
});

test('fieldError computes RMSE, mean |Δ| and max |Δ| over the mask only', () => {
  const a = Float32Array.from([0, 3, 100]);
  const b = Float32Array.from([0, 0, 0]);
  const all = fieldError(a, b, null);
  close(all.l1, (0 + 3 + 100) / 3);
  close(all.rmse, Math.sqrt((0 + 9 + 10000) / 3));
  close(all.maxAbs, 100);
  assert.equal(all.cells, 3);
  const masked = fieldError(a, b, Uint8Array.from([1, 1, 0]));
  close(masked.l1, 1.5);
  close(masked.rmse, Math.sqrt(4.5));
  close(masked.maxAbs, 3);
  assert.equal(masked.cells, 2);
});

test('fieldError reports non-finite cells instead of poisoning the totals', () => {
  const a = Float32Array.from([1, NaN, 3]);
  const b = Float32Array.from([1, 1, 1]);
  const e = fieldError(a, b, null);
  assert.equal(e.nonFinite, 1);
  assert.equal(e.cells, 2);
  close(e.maxAbs, 2);
});

test('fieldError on an empty mask reports zero cells (so a report cannot quote RMSE 0 as agreement)', () => {
  const e = fieldError(Float32Array.from([5]), Float32Array.from([0]), new Uint8Array(1));
  assert.equal(e.cells, 0);
  assert.equal(e.rmse, 0);
});

test('discCells picks the cells whose centres are inside the radius, and clips to the grid', () => {
  // Radius 1.0 cells around the centre of cell (2,2) in a 5×5 grid: itself and its 4 edge neighbours.
  const cells = discCells(5, 5, 2.5, 2.5, 1);
  assert.deepEqual([...cells].sort((x, y) => x - y), [7, 11, 12, 13, 17]);
  // A probe on the corner keeps only the in-grid part.
  const corner = discCells(5, 5, 0.5, 0.5, 1);
  assert.deepEqual([...corner].sort((x, y) => x - y), [0, 1, 5]);
});

test('discCells covers the same ground area on a refined grid', () => {
  // 25 m radius on 7.8125 m cells vs 1.953 m cells: the fine disc must hold ~16× the cells of the coarse one.
  const coarse = discCells(1024, 1024, 300.5, 500.5, 25 / 7.8125).length;
  const fine = discCells(4096, 4096, 1202, 2002, 25 / 1.953125).length;
  const ratio = fine / coarse;
  assert.ok(ratio > 14 && ratio < 18, `disc cell ratio ${ratio.toFixed(2)} should be ≈ 16`);
});

test('discCells falls back to the containing cell when no centre is inside the radius', () => {
  const cells = discCells(8, 8, 3.1, 4.9, 0.05);
  assert.deepEqual([...cells], [4 * 8 + 3]);
});

test('arrivalTime interpolates the crossing between samples', () => {
  const t = [0, 5, 10, 15];
  // Crosses 0.15 between t = 5 (0.1) and t = 10 (0.2): halfway, 7.5 s.
  close(arrivalTime(t, [0, 0.1, 0.2, 0.3], 0.15)!, 7.5);
  // Already above at the first sample.
  assert.equal(arrivalTime(t, [0.4, 0.5, 0.6, 0.7], 0.15), 0);
  // Never reached.
  assert.equal(arrivalTime(t, [0, 0.01, 0.02, 0.03], 0.15), null);
});

test('arrivalTime takes the FIRST crossing, not the peak', () => {
  const t = [0, 10, 20, 30, 40];
  close(arrivalTime(t, [0, 0.2, 0.05, 0.02, 3], 0.15)!, 7.5);
});

test('pctDiff is signed against the reference and null at a zero reference', () => {
  close(pctDiff(1.1, 1)!, 10);
  close(pctDiff(0.9, 1)!, -10);
  assert.equal(pctDiff(1, 0), null);
});

test('gpuBytesEstimate scales with the cell count and drops the reset cache above 2²⁰ cells', () => {
  const small = gpuBytesEstimate(1024, { raise: true });
  const big = gpuBytesEstimate(4096, { raise: true });
  // 16× the cells but the 1024² grid also carries the 16 B/cell reset texture, so the ratio is a little under 16.
  const ratio = big / small;
  assert.ok(ratio > 13 && ratio < 16, `ratio ${ratio.toFixed(2)}`);
  // A 4096² run needs ~2 GB: the number the report quotes has to be in that range, not off by 1000×.
  assert.ok(big > 1.5e9 && big < 2.5e9, `${(big / 1e9).toFixed(2)} GB`);
  assert.ok(gpuBytesEstimate(4096, { raise: true }) > gpuBytesEstimate(4096, { raise: false }));
});
