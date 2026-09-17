/** Forcing packing with cached footprints (the solver re-packs on every stage step) matches the direct evaluation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WaterSource } from '../../src/contracts';
import { footprintRadius, footprintWeight, packForcing, sourceFootprint } from '../../src/sim/forcing';

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
