/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/routing/index';
import type { RoadEdge, RoadNetwork } from '../../src/contracts';
import { formatDistance, formatDuration, normalizeStreetName } from '../../src/routing/format';
import { floodRect, makeCity, shelterAt } from './city';

const NX = 256;

/** One straight north–south road, x = 20.5, from gy = 40.5 to gy = 200.5, as a single edge. */
function straightRoad(): RoadNetwork {
  const pts = new Float32Array([20.5, 40.5, 20.5, 120.5, 20.5, 200.5]);
  return { nodes: new Float32Array([20.5, 40.5, 20.5, 200.5]), edges: [{ a: 0, b: 1, length: 160 * 8, cls: 'major', pts }] };
}

function rows(d: Float32Array, j0: number, j1: number, value: number): void {
  for (let j = j0; j < j1; j++) d.fill(value, j * NX, (j + 1) * NX);
}

describe('bridges over standing water', () => {
  test('long river span: approaches within half the span (≤ 150 m) are elevated, landings beyond are not', () => {
    const router = createRouter();
    router.setNetwork(straightRoad(), 8, { nx: NX, ny: NX });
    const base = new Float32Array(NX * NX);
    rows(base, 100, 140, 5); // 320 m wide river → 150 m (18 cells) approach allowance on each side
    router.setBaselineWater(base, NX, NX);

    const within = base.slice();
    rows(within, 142, 156, 1.5); // riverside flats under the viaduct
    assert.equal(router.updateFlood(within, NX, NX)![0], 0, 'flooding under the elevated approach keeps the bridge open');

    const beyond = within.slice();
    rows(beyond, 165, 170, 0.6); // the landing
    assert.equal(router.updateFlood(beyond, NX, NX)![0], 2, 'flooded landing closes the bridge');
  });

  test('short creek crossing gets almost no allowance', () => {
    const router = createRouter();
    router.setNetwork(straightRoad(), 8, { nx: NX, ny: NX });
    const base = new Float32Array(NX * NX);
    rows(base, 100, 102, 1); // 16 m creek → 1 cell allowance
    router.setBaselineWater(base, NX, NX);
    const d = base.slice();
    rows(d, 104, 106, 0.4);
    assert.equal(router.updateFlood(d, NX, NX)![0], 2, 'road floods 16 m from the creek');
  });

  test('baseline can be replaced and cleared; a new network starts without one', () => {
    const router = createRouter();
    router.setNetwork(straightRoad(), 8);
    const base = new Float32Array(NX * NX);
    rows(base, 100, 140, 5);
    assert.equal(router.updateFlood(base, NX, NX)![0], 2, 'no baseline → the river floods the road');
    router.setBaselineWater(base, NX, NX);
    assert.equal(router.updateFlood(base, NX, NX)![0], 0, 'river declared as standing water → bridge');
    const d = base.slice();
    rows(d, 60, 62, 0.35);
    assert.equal(router.updateFlood(d, NX, NX)![0], 2, 'flood away from the river still counts');
    router.setBaselineWater(null, NX, NX);
    assert.equal(router.updateFlood(base, NX, NX)![0], 2, 'cleared baseline');
    router.setBaselineWater(base, NX, NX);
    router.setNetwork(straightRoad(), 8);
    assert.equal(router.updateFlood(base, NX, NX)![0], 2, 'setNetwork resets the baseline');
  });
});

describe('robustness', () => {
  test('malformed networks: bad node indices, self loops, missing / reversed / single-point polylines', () => {
    const nodes = new Float32Array([10.5, 10.5, 60.5, 10.5, 60.5, 60.5, 10.5, 60.5]);
    const edges: RoadEdge[] = [
      // reversed pts relative to a → b (tolerated)
      { a: 0, b: 1, length: 400, cls: 'local', name: 'North  St', pts: new Float32Array([60.5, 10.5, 35, 10.2, 10.5, 10.5]) },
      { a: 1, b: 2, length: 400, cls: 'local', name: 'East St', pts: new Float32Array(0) }, // no geometry → chord
      { a: 2, b: 3, length: NaN, cls: 'major', name: 'South St', pts: new Float32Array([60.5, 60.5]) }, // 1 point, bad length
      { a: 3, b: 3, length: 50, cls: 'local', pts: new Float32Array([10.5, 60.5, 5, 65, 10.5, 60.5]) }, // self loop
      { a: 0, b: 99, length: 100, cls: 'local', pts: new Float32Array([10.5, 10.5, 0, 0]) }, // invalid node
      { a: 3, b: 0, length: 400, cls: 'bogus' as never, pts: new Float32Array([10.5, 60.5, NaN, 30, 10.5, 10.5]) },
    ];
    const router = createRouter();
    router.setNetwork({ nodes, edges }, 8);
    const depth = new Float32Array(NX * NX);
    const st = router.updateFlood(depth, NX, NX)!;
    assert.equal(st.length, edges.length);

    const r = router.route({ gx: 12, gy: 12 }, [shelterAt('Opposite corner', 58, 58)]);
    assert.equal(r.state, 'ok', r.message);
    assert.ok(r.polyline && r.polyline.every(Number.isFinite), 'finite polyline');
    assert.ok(r.lengthMeters > 0 && Number.isFinite(r.etaSeconds));
    assert.doesNotMatch(r.message, / {2}/, 'names are whitespace-normalized');
  });

  test('NaN depths are ignored, +Infinity floods, detached arrays are rejected', () => {
    const city = makeCity({ blocks: 4, block: 24, river: false });
    const router = createRouter();
    router.setNetwork(city.net, 8);
    const d = new Float32Array(city.nx * city.ny).fill(NaN);
    const st = router.updateFlood(d, city.nx, city.ny)!;
    assert.ok(st.every((s) => s === 0), 'NaN field → no false floods');
    const p = city.pos(1, 1);
    d[Math.floor(p.gy) * city.nx + Math.floor(p.gx) + 5] = Infinity;
    assert.ok(router.updateFlood(d, city.nx, city.ny)!.some((s) => s === 2), 'Infinity floods');
    const r = router.route({ gx: p.gx + 2, gy: p.gy + 2 }, [shelterAt('S', city.pos(3, 3).gx, city.pos(3, 3).gy)]);
    assert.ok(r.state === 'ok' || r.state === 'blocked');

    const buf = new ArrayBuffer(city.nx * city.ny * 4);
    const view = new Float32Array(buf);
    router.updateFlood(view, city.nx, city.ny);
    structuredClone(buf, { transfer: [buf] }); // detach: view.length becomes 0
    assert.equal(view.length, 0);
    assert.doesNotThrow(() => router.route({ gx: p.gx + 2, gy: p.gy + 2 }, [shelterAt('S', 80, 80)]));
    assert.equal(router.updateFlood(view, city.nx, city.ny), null);
  });

  test('start and shelters outside the grid, invalid shelters, repeated network swaps', () => {
    const city = makeCity({ blocks: 6, block: 24, river: false });
    const router = createRouter();
    for (let k = 0; k < 3; k++) {
      router.setNetwork(k === 1 ? null : city.net, 8);
      router.updateFlood(new Float32Array(city.nx * city.ny), city.nx, city.ny);
    }
    const r = router.route({ gx: -10, gy: 10 }, [
      { name: 'bad', gx: NaN, gy: 3 },
      shelterAt('Edge', city.pos(6, 6).gx + 12, city.pos(6, 6).gy + 12),
    ]);
    assert.equal(r.state, 'ok', r.message);
    assert.equal(r.shelter?.name, 'Edge');
    assert.equal(router.route({ gx: -500, gy: -500 }, [shelterAt('Edge', 50, 50)]).state, 'none');
  });

  test('every road near the start flooded → blocked with explanation', () => {
    const city = makeCity({ blocks: 10, block: 24, river: false });
    const router = createRouter();
    router.setNetwork(city.net, 8);
    const d = new Float32Array(city.nx * city.ny);
    const p = city.pos(5, 5);
    floodRect(d, city.nx, p.gx - 40, p.gy - 40, p.gx + 40, p.gy + 40, 0.5);
    // dry pocket around the start inside the block, but every nearby street flooded
    const sx = p.gx + 12, sy = p.gy + 12;
    for (let j = Math.floor(sy) - 3; j <= Math.floor(sy) + 3; j++) for (let i = Math.floor(sx) - 3; i <= Math.floor(sx) + 3; i++) d[j * city.nx + i] = 0;
    const st = router.updateFlood(d, city.nx, city.ny)!;
    assert.ok(st.filter((v) => v === 2).length >= 12, 'streets around the start are flooded');
    const r = router.route({ gx: sx, gy: sy }, [shelterAt('Far', city.pos(0, 0).gx, city.pos(0, 0).gy)]);
    assert.equal(r.state, 'blocked');
    assert.match(r.message, /every road near the start is flooded/);
    assert.equal(r.reason, 'start-roads-flooded');
    assert.equal(r.advice, 'Every road near the start is flooded. Shelter in place on higher floors.');
    assert.ok(r.polyline, 'cut route still provided for rendering');
  });
});

describe('formatting', () => {
  test('distance, duration and street names', () => {
    assert.equal(formatDistance(3400), '3.4 km');
    assert.equal(formatDistance(850), '850 m');
    assert.equal(formatDistance(3), '10 m');
    assert.equal(formatDistance(996), '1.0 km', 'rounding up to a kilometre switches unit');
    assert.equal(formatDistance(12_300), '12.3 km');
    assert.equal(formatDistance(123_400), '123 km');
    assert.equal(formatDistance(NaN), '—');
    assert.equal(formatDuration(20), '20 s');
    assert.equal(formatDuration(59.7), '1 min', 'rounding up to a minute switches unit');
    assert.equal(formatDuration(6 * 60 + 10), '6 min');
    assert.equal(formatDuration(65 * 60), '1 h 5 min');
    assert.equal(formatDuration(120 * 60), '2 h');
    assert.equal(formatDuration(-1), '—');
    assert.equal(normalizeStreetName('  I- 376 '), 'I-376');
    assert.equal(normalizeStreetName('Fort  Pitt Blvd'), 'Fort Pitt Blvd');
  });

  test('the status sentence uses the same numbers as the evacuation card', async () => {
    const ui = await import('../../src/ui/format');
    const plain = (s: string) => s.replace(/[\u00a0\u2009\u202f]/g, ' ').replace(/(\d),(\d)/g, '$1$2');
    for (const m of [10, 42, 850, 994, 1000, 3456, 12_345, 99_000, 250_000]) {
      assert.equal(formatDistance(m), plain(ui.formatDistance(m)), `${m} m`);
    }
    for (const s of [0, 1, 45, 59, 60, 61, 89, 91, 360, 3599, 3600, 3900, 7200, 36_000]) {
      assert.equal(formatDuration(s), plain(ui.formatDuration(s)), `${s} s`);
    }
  });
});
