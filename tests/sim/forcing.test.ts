/**
 * Forcing packing: cached footprints (the solver re-packs on every stage step) match the direct evaluation, and a
 * timed inflow (WaterSource.stopAfter) delivers exactly Q·stopAfter however the run is chunked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WaterSource } from '../../src/contracts';
import { footprintRadius, footprintWeight, inflowFactor, packForcing, sourceFootprint } from '../../src/sim/forcing';

test('source footprints: exactly the cells with weight > 0, in row-major order, clipped to the grid', () => {
  const nx = 80;
  const ny = 60;
  for (const [gx, gy, r] of [
    [40.3, 30.7, 6.2],
    [-12, 20, 25], // mostly outside (a river boundary disc)
    [79.5, 59.5, 0.2], // tiny, at the corner
  ]) {
    const fp = sourceFootprint(gx, gy, r, nx, ny);
    const R = footprintRadius(r);
    const cells: number[] = [];
    const weights: number[] = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const w = footprintWeight(Math.hypot(i + 0.5 - gx, j + 0.5 - gy), R);
        if (w > 0) {
          cells.push(j * nx + i);
          weights.push(w);
        }
      }
    assert.deepEqual([...fp.cells], cells);
    assert.deepEqual([...fp.weights], weights);
  }
});

test('packForcing with a footprint cache packs the same bytes and bounds as without', () => {
  const nx = 64;
  const ny = 48;
  const bed = new Float32Array(nx * ny).map((_, c) => 100 + ((c * 37) % 17) * 0.25);
  const sources: WaterSource[] = [
    { id: 'a', type: 'stage', gx: -20, gy: 24, radius: 30, level: 104 },
    { id: 'b', type: 'inflow', gx: 30, gy: 10, radius: 3, discharge: 120 },
    { id: 'c', type: 'stage', gx: 63.5, gy: 47, radius: 5, level: 103.2 },
  ];
  const storms = [{ id: 's', gx: 20, gy: 20, radius: 15, intensity: 80 }];
  const direct = packForcing(sources, storms, nx, ny, 4, 100, (c) => bed[c]);
  const cache = new Map<string, ReturnType<typeof sourceFootprint>>();
  let built = 0;
  const cached = (s: WaterSource) => {
    const k = `${s.gx}|${s.gy}|${s.radius}`;
    if (!cache.has(k)) {
      built++;
      cache.set(k, sourceFootprint(s.gx, s.gy, s.radius, nx, ny));
    }
    return cache.get(k)!;
  };
  for (let round = 0; round < 3; round++) {
    const p = packForcing(sources, storms, nx, ny, 4, 100, (c) => bed[c], cached);
    assert.deepEqual([...p.data], [...direct.data]);
    assert.equal(p.stageDepthMax, direct.stageDepthMax);
    assert.equal(p.inflowTotal, direct.inflowTotal);
    assert.equal(p.nSources, direct.nSources);
  }
  assert.equal(built, 3, 'each footprint is computed once');
});

test('inflowFactor: 1 before the stop, 0 after it, and the straddling window gets its own fraction', () => {
  // No stop at all — every preset but Nepal.
  assert.equal(inflowFactor(undefined, 0, 10), 1);
  assert.equal(inflowFactor(undefined, 1e6, 1e6 + 10), 1);
  assert.equal(inflowFactor(Infinity, 1e6, 1e6 + 10), 1);
  // Whole windows, before and after.
  assert.equal(inflowFactor(1800, 0, 60), 1);
  assert.equal(inflowFactor(1800, 1740, 1800), 1);
  assert.equal(inflowFactor(1800, 1800, 1860), 0);
  assert.equal(inflowFactor(1800, 3600, 3660), 0);
  // The window that straddles the stop delivers the fraction of itself that lies before it.
  assert.equal(inflowFactor(1800, 1790, 1810), 0.5);
  assert.equal(inflowFactor(1800, 1799, 1803), 0.25);
  // Paused (zero-length window): the instant itself decides.
  assert.equal(inflowFactor(1800, 1799.9, 1799.9), 1);
  assert.equal(inflowFactor(1800, 1800, 1800), 0);
  // A stop at 0 delivers nothing at all.
  assert.equal(inflowFactor(0, 0, 60), 0);
});

test('a timed inflow integrates to exactly Q·stopAfter, whatever the frame size', () => {
  const nx = 32;
  const ny = 32;
  const cellSize = 5;
  const bed = new Float32Array(nx * ny).fill(100);
  const Q = 11100;
  const stopAfter = 1800;
  const src: WaterSource[] = [{ id: 'surge', type: 'inflow', gx: 16.5, gy: 4.5, radius: 4, discharge: Q, stopAfter }];
  /*
   * The solver re-packs the forcing for each frame's own window, so what a run delivers is Σ Q·gate(window)·span.
   * A frame is 256 substeps at most and dt is whatever CFL allows, so the frame that straddles the stop is what makes
   * this exact: with a hard on/off switch these totals would be out by up to one frame of discharge (at 60 s frames,
   * 666,000 m³ — 3 % of the event).
   */
  for (const span of [0.05, 1, 7, 60, 173, 900, 2400]) {
    let delivered = 0;
    for (let t = 0; t < 4 * stopAfter; t += span) {
      const f = packForcing(src, [], nx, ny, cellSize, 100, (c) => bed[c], undefined, { from: t, to: t + span });
      delivered += f.inflowTotal * span;
    }
    assert.ok(
      Math.abs(delivered - Q * stopAfter) < 1e-6 * Q * stopAfter,
      `frames of ${span} s delivered ${delivered.toFixed(1)} m³, want ${Q * stopAfter}`,
    );
  }
  // And with no window at all (the packing done at t = 0 before any frame is encoded) the inflow is fully on.
  assert.equal(packForcing(src, [], nx, ny, cellSize, 100, (c) => bed[c]).inflowTotal, Q);
});

test('an untimed inflow never stops, and a stopAfter on one source leaves the others alone', () => {
  const nx = 24;
  const ny = 24;
  const bed = new Float32Array(nx * ny).fill(0);
  const sources: WaterSource[] = [
    { id: 'timed', type: 'inflow', gx: 6.5, gy: 6.5, radius: 2, discharge: 100, stopAfter: 50 },
    { id: 'forever', type: 'inflow', gx: 18.5, gy: 18.5, radius: 2, discharge: 7, label: 'baseflow' },
  ];
  const at = (from: number, to: number) => packForcing(sources, [], nx, ny, 4, 0, (c) => bed[c], undefined, { from, to }).inflowTotal;
  assert.equal(at(0, 10), 107);
  assert.equal(at(100, 110), 7, 'the untimed source still delivers after the timed one has stopped');
});
