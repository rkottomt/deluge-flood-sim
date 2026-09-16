/// <reference types="node" />
/**
 * computeInitialWater: h = level − bed on cells 4-connected to a seed through bed < level; never leaks into
 * disconnected low areas (including diagonal-only connections); per-seed levels for sloping rivers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeInitialWater } from '../../src/data/initialWater';
import type { TerrainData } from '../../src/contracts';

const N = 64;

function terrain(fn: (i: number, j: number) => number): Pick<TerrainData, 'nx' | 'ny' | 'elevation'> {
  const elevation = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) elevation[j * N + i] = fn(i, j);
  return { nx: N, ny: N, elevation };
}

/** Two basins (bottoms at 10 m and 8 m) separated by a ridge at 15 m, in a bowl rimmed at 30 m. */
const twoBasins = terrain((i, j) => {
  if (i === 0 || j === 0 || i === N - 1 || j === N - 1) return 30;
  if (i === 32) return 15;
  const bottom = i < 32 ? 10 : 8;
  return bottom + 0.05 * Math.hypot(i - (i < 32 ? 16 : 48), j - 32);
});

test('fills only the seeded basin; the lower disconnected basin stays dry', () => {
  const h = computeInitialWater(twoBasins, { initialFill: [{ seeds: [{ gx: 16.5, gy: 32.5 }], level: 12 }] });
  let east = 0;
  let west = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (i > 32) east += h[k];
      if (i < 32 && h[k] > 0) {
        west++;
        assert.ok(Math.abs(h[k] - (12 - twoBasins.elevation[k])) < 1e-5, 'h = level − bed');
      }
    }
  }
  assert.equal(east, 0, 'no leak into the lower basin behind the ridge');
  assert.ok(west > 900);
  assert.equal(h[32 * N + 32], 0, 'ridge dry');
  assert.equal(h[0], 0, 'rim dry');
});

test('above the ridge both basins connect', () => {
  const h = computeInitialWater(twoBasins, { initialFill: [{ seeds: [{ gx: 16.5, gy: 32.5 }], level: 16 }] });
  assert.ok(Math.abs(h[32 * N + 48] - (16 - twoBasins.elevation[32 * N + 48])) < 1e-5);
  assert.ok(Math.abs(h[32 * N + 32] - 1) < 1e-5);
});

test('diagonal-only contact does not connect (matches the solver face fluxes)', () => {
  const t = terrain((i, j) => ((i < 32 && j < 32) || (i >= 32 && j >= 32) ? 5 : 20));
  const h = computeInitialWater(t, { initialFill: [{ seeds: [{ gx: 10, gy: 10 }], level: 8 }] });
  assert.ok(h[10 * N + 10] > 2.9);
  assert.equal(h[50 * N + 50], 0);
});

test('no scenario / seeds outside or on dry land produce no water; a seed a hair onto the bank snaps in', () => {
  assert.equal(computeInitialWater(twoBasins, null).reduce((a, b) => a + b, 0), 0);
  const outside = computeInitialWater(twoBasins, { initialFill: [{ seeds: [{ gx: -5, gy: 10 }], level: 12 }] });
  assert.equal(outside.reduce((a, b) => a + b, 0), 0);
  // Channel 4 cells wide at 2 m on a plain at 6 m; seed on the plain 2 cells from the channel.
  const ch = terrain((i) => (i >= 30 && i < 34 ? 2 : 6));
  const h = computeInitialWater(ch, { initialFill: [{ seeds: [{ gx: 28.5, gy: 20.5 }], level: 4 }] });
  assert.ok(Math.abs(h[20 * N + 31] - 2) < 1e-6, 'snapped into the channel');
  assert.equal(h[20 * N + 28], 0);
  const far = computeInitialWater(ch, { initialFill: [{ seeds: [{ gx: 10.5, gy: 20.5 }], level: 4 }] });
  assert.equal(far.reduce((a, b) => a + b, 0), 0, 'seed far from any water does nothing');
});

test('per-seed levels: a sloping channel fills without spilling onto its banks', () => {
  // Channel along j = 30..33 whose surface drops 0.25 m per cell west → east; banks 0.8 m above the surface.
  const surface = (i: number) => 40 - 0.25 * i;
  const t = terrain((i, j) => (j >= 30 && j < 34 ? surface(i) - 1.5 : surface(i) + 0.8));
  const seeds = [];
  for (let i = 1; i < N; i += 4) seeds.push({ gx: i + 0.5, gy: 31.5, level: surface(i) });
  const h = computeInitialWater(t, { initialFill: [{ seeds, level: surface(N) }] });
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const k = j * N + i;
      if (j >= 30 && j < 34) assert.ok(h[k] > 0.4 && h[k] < 2.5, `channel cell ${i},${j} depth ${h[k]}`);
      else assert.equal(h[k], 0, `bank cell ${i},${j} flooded`);
    }
  }
  // A single fill with the upstream level would flood the downstream banks — the reason per-seed levels exist.
  const lake = computeInitialWater(t, { initialFill: [{ seeds: [{ gx: 1.5, gy: 31.5 }], level: surface(1) }] });
  assert.ok(lake[10 * N + 60] > 0, 'sanity: a flat level does spill');
});

test('overlapping fills take the maximum depth', () => {
  const h = computeInitialWater(twoBasins, {
    initialFill: [
      { seeds: [{ gx: 16.5, gy: 32.5 }], level: 11 },
      { seeds: [{ gx: 16.5, gy: 32.5 }], level: 12 },
    ],
  });
  const k = 32 * N + 16;
  assert.ok(Math.abs(h[k] - (12 - twoBasins.elevation[k])) < 1e-5);
});
