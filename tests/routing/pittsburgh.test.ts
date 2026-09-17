/// <reference types="node" />
/**
 * Real-data regression on the preset the demo ships (public/presets/pittsburgh: USGS 3DEP DEM with burned
 * river channels, Census TIGER roads, the scenario's shelters and Point-gauge marks). The rivers are raised
 * to each gauge mark as a bathtub (see pittsburghPreset.ts), the way the stage slider raises them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRouter } from '../../src/routing/index';
import type { PresetMeta } from '../../src/data/presets';
import type { CompactRoads } from '../../src/data/roads';
import { mark, PLACES, pittsburghWorld } from './pittsburghPreset';
import { bestOfPasses, quantile, summarize } from './timing';

const DIR = path.resolve(import.meta.dirname, '../../public/presets/pittsburgh');

function load() {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8')) as PresetMeta;
  const buf = fs.readFileSync(path.join(DIR, meta.files.elevation));
  const roads = JSON.parse(fs.readFileSync(path.join(DIR, meta.files.roads!), 'utf8')) as CompactRoads;
  return pittsburghWorld(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, roads);
}

test('Pittsburgh preset: bridges open at pool, reroute as the rivers rise to historic crests, flooded starts blocked', () => {
  const w = load();
  const { nx, ny, shelters } = w;
  const router = createRouter();
  router.setNetwork(w.roads, w.cellSize, { nx, ny });
  router.setBaselineWater(w.initialWater, nx, ny); // exactly what the app does at load
  const downtown = w.at(PLACES.downtown.lon, PLACES.downtown.lat);
  const northShore = w.at(PLACES.northShore.lon, PLACES.northShore.lat);
  const flooded = (st: ArrayLike<number>) => Array.prototype.filter.call(st, (s: number) => s === 2).length;

  // Normal pool: the rivers are full but every road — the bridges over them included — is dry.
  let st = router.updateFlood(w.bathtub(w.pool), nx, ny)!;
  assert.equal(Array.prototype.filter.call(st, (s: number) => s !== 0).length, 0, 'every road (incl. river bridges) is dry at normal pool');
  const pool = router.route(downtown, shelters);
  assert.equal(pool.state, 'ok', pool.message);
  assert.match(pool.shelter!.name, /Mount Washington/, 'nearest shelter is across the Monongahela');
  assert.ok(pool.via.includes('Penn Lincoln Pkwy'), `over the Fort Pitt Bridge (I-376): ${pool.message}`);
  assert.equal(pool.wetMeters, 0);
  assert.ok(pool.etaSeconds > 60 && pool.etaSeconds < 600, `ETA ${pool.etaSeconds} s`);

  // Raising the rivers only ever floods more roads.
  let last = 0;
  for (const m of w.marks) {
    const n = flooded(router.updateFlood(w.bathtub(m.level), nx, ny)!);
    assert.ok(n >= last, `${m.label} (${m.ft} ft) floods at least as many roads as the mark below (${n} < ${last})`);
    last = n;
  }
  const floodStage = mark(w, 'flood stage');
  assert.ok(flooded(router.updateFlood(w.bathtub(floodStage.level), nx, ny)!) > 0, 'flood stage puts riverside roads under');

  // 1972 Agnes crest (35.8 ft): the Point floods; downtown reroutes away from the Fort Pitt Bridge and the North
  // Shore flood plain is under water.
  const agnes = mark(w, 'Agnes');
  st = router.updateFlood(w.bathtub(agnes.level), nx, ny)!;
  const agnesFlooded = flooded(st);
  assert.ok(agnesFlooded > 200 && agnesFlooded < 3000, `${agnes.label} floods riverside roads (${agnesFlooded})`);
  const rerouted = router.route(downtown, shelters);
  assert.equal(rerouted.state, 'ok', rerouted.message);
  assert.doesNotMatch(rerouted.shelter!.name, /Mount Washington/, `reroutes away from the flooded Point: ${rerouted.message}`);
  const shore = router.route(northShore, shelters);
  assert.equal(shore.state, 'blocked', shore.message);
  assert.equal(shore.reason, 'start-flooded');
  assert.match(shore.message, /^Start point is under \d+\.\d m of water/);

  // 1936 record (46 ft): most of the Golden Triangle is under water, downtown included.
  const record = mark(w, '1936');
  st = router.updateFlood(w.bathtub(record.level), nx, ny)!;
  assert.ok(flooded(st) > agnesFlooded, '1936 floods more roads than Agnes');
  const cell = Math.floor(downtown.gy) * nx + Math.floor(downtown.gx);
  const expectedDepth = record.level - w.elevation[cell];
  const sunk = router.route(downtown, shelters);
  assert.equal(sunk.state, 'blocked', sunk.message);
  assert.equal(sunk.reason, 'start-flooded');
  assert.ok(sunk.message.startsWith(`Start point is under ${expectedDepth.toFixed(1)} m of water`), sunk.message);

  // Point-on-network test via a 16-cell bucket grid over all road segments.
  const net = w.roads;
  const B = 16;
  const buckets = new Map<number, number[]>();
  const segs: number[] = [];
  for (const e of net.edges) {
    for (let q = 0; q + 3 < e.pts.length; q += 2) {
      const id = segs.length / 4;
      segs.push(e.pts[q], e.pts[q + 1], e.pts[q + 2], e.pts[q + 3]);
      const c0 = Math.floor(Math.min(e.pts[q], e.pts[q + 2]) / B), c1 = Math.floor(Math.max(e.pts[q], e.pts[q + 2]) / B);
      const r0 = Math.floor(Math.min(e.pts[q + 1], e.pts[q + 3]) / B), r1 = Math.floor(Math.max(e.pts[q + 1], e.pts[q + 3]) / B);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const key = r * 100_000 + c;
        let list = buckets.get(key);
        if (!list) buckets.set(key, (list = []));
        list.push(id);
      }
    }
  }
  const onRoad = (x: number, y: number) => {
    for (const id of buckets.get(Math.floor(y / B) * 100_000 + Math.floor(x / B)) ?? []) {
      const ax = segs[4 * id], ay = segs[4 * id + 1], vx = segs[4 * id + 2] - ax, vy = segs[4 * id + 3] - ay;
      const l2 = vx * vx + vy * vy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * vx + (y - ay) * vy) / l2)) : 0;
      if (Math.hypot(ax + u * vx - x, ay + u * vy - y) < 0.02) return true;
    }
    return false;
  };

  // Robustness sweep between Agnes and 1936: random starts never throw and always give finite, connected output.
  router.updateFlood(w.bathtub(w.pool + 8), nx, ny);
  let seed = 5;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const starts = Array.from({ length: 300 }, () => ({ gx: rand() * nx, gy: rand() * ny }));
  const states = { ok: 0, blocked: 0, none: 0 };
  for (const start of starts) {
    const res = router.route(start, shelters);
    states[res.state]++;
    if (res.polyline) {
      const pl = res.polyline;
      const n = pl.length / 2;
      assert.ok(pl.every(Number.isFinite));
      // Everything except the two off-road connector legs follows the road network.
      for (let v = 1; v < n - 1; v++) {
        assert.ok(onRoad(pl[2 * v], pl[2 * v + 1]), `vertex ${v} on a road`);
        if (v < n - 2) assert.ok(onRoad((pl[2 * v] + pl[2 * v + 2]) / 2, (pl[2 * v + 1] + pl[2 * v + 3]) / 2), `segment ${v} on a road`);
      }
    }
    if (res.state === 'ok') assert.ok(res.lengthMeters > 0 && res.etaSeconds > 0 && res.shelter);
  }
  const PASSES = 2;
  const times = bestOfPasses(starts, PASSES, (start) => router.route(start, shelters));
  console.log(
    `[routing pgh] preset: ${net.edges.length} edges; normal pool: ${pool.message}\n` +
      `  ${agnes.label} (${agnes.ft} ft, +${(agnes.level - w.pool).toFixed(1)} m): ${agnesFlooded} roads flooded; ${rerouted.message}\n` +
      `  300 random routes at +8 m: ok ${states.ok}, blocked ${states.blocked}, none ${states.none}; ${summarize(times, PASSES)}`,
  );
  assert.ok(states.ok > 100, 'most random starts find a route');
  const p95 = quantile(times.norm, 0.95);
  assert.ok(p95 < 10, `route p95 ${p95.toFixed(2)} ms < 10 ms`);
});
