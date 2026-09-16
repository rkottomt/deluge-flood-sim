/// <reference types="node" />
/**
 * Real-data regression: Pittsburgh TIGER roads + USGS 3DEP DEM with a bathtub river flood.
 * Needs the baked fixture (node --import tsx tests/routing/tools/bakePittsburgh.ts); skipped when absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRouter } from '../../src/routing/index';
import type { RoadNetwork, Shelter } from '../../src/contracts';

const DIR = path.resolve(import.meta.dirname, '../../artifacts/routing-pgh');
const available = fs.existsSync(path.join(DIR, 'meta.json'));

function load() {
  const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
  const roads = JSON.parse(fs.readFileSync(path.join(DIR, 'roads.json'), 'utf8'));
  const buf = fs.readFileSync(path.join(DIR, 'elev.f32'));
  const elev = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const net: RoadNetwork = {
    nodes: Float32Array.from(roads.nodes),
    edges: roads.edges.map((e: { pts: number[] }) => ({ ...e, pts: Float32Array.from(e.pts) })),
  };
  const nx: number = meta.nx, ny: number = meta.ny;
  /** Water connected to the river at the Point, filled to `level` m (4-neighbour flood fill). */
  const bathtub = (level: number) => {
    const d = new Float32Array(nx * ny);
    const queue = new Int32Array(nx * ny);
    const seen = new Uint8Array(nx * ny);
    let head = 0, tail = 0;
    const s0 = meta.seed.j * nx + meta.seed.i;
    queue[tail++] = s0;
    seen[s0] = 1;
    while (head < tail) {
      const k = queue[head++];
      if (elev[k] >= level) continue;
      d[k] = level - elev[k];
      const i = k % nx;
      for (const n of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
        if (n >= 0 && n < nx * ny && !seen[n]) {
          seen[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    return d;
  };
  return { meta, net, nx, ny, bathtub, pool: meta.poolLevel + 0.8, shelters: meta.shelters as Shelter[] };
}

test('Pittsburgh: bridges open at pool level, reroute as the rivers rise, flooded start blocked', { skip: !available && 'fixture not baked' }, () => {
  const { meta, net, nx, ny, bathtub, pool, shelters } = load();
  const router = createRouter();
  router.setNetwork(net, meta.cellSize, { nx, ny });
  router.setBaselineWater(bathtub(pool), nx, ny);

  const downtown = { gx: 330, gy: 565 };
  const northShore = { gx: 287.5, gy: 478 };

  let st = router.updateFlood(bathtub(pool), nx, ny)!;
  assert.equal(st.filter((s) => s !== 0).length, 0, 'every road (incl. river bridges) is dry at normal pool');
  let r = router.route(downtown, shelters);
  assert.equal(r.state, 'ok', r.message);
  assert.match(r.message, /Mount Washington/, 'nearest shelter across the Fort Pitt Bridge');
  assert.ok(r.etaSeconds < 600);

  st = router.updateFlood(bathtub(pool + 6), nx, ny)!;
  const flooded = st.filter((s) => s === 2).length;
  assert.ok(flooded > 300 && flooded < 3000, `+6 m floods riverside roads (${flooded})`);
  r = router.route(downtown, shelters);
  assert.equal(r.state, 'ok', r.message);
  assert.match(r.message, /Cathedral of Learning/, 'reroutes away from the flooded Point');

  router.updateFlood(bathtub(pool + 9), nx, ny);
  r = router.route(northShore, shelters);
  assert.equal(r.state, 'blocked');
  assert.match(r.message, /^Start point is under \d+\.\d m of water/);

  // Point-on-network test via a 16-cell bucket grid over all road segments.
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

  // Robustness sweep: random starts at +8 m never throw and always give finite, connected output.
  router.updateFlood(bathtub(pool + 8), nx, ny);
  let seed = 5;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const states = { ok: 0, blocked: 0, none: 0 };
  const times: number[] = [];
  for (let k = 0; k < 300; k++) {
    const start = { gx: rand() * nx, gy: rand() * ny };
    const t0 = performance.now();
    const res = router.route(start, shelters);
    times.push(performance.now() - t0);
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
  times.sort((a, b) => a - b);
  console.log(
    `[routing pgh] ${net.edges.length} edges; 300 random routes at +8 m: ok ${states.ok}, blocked ${states.blocked}, none ${states.none}; ` +
      `median ${times[150].toFixed(2)} ms, p95 ${times[285].toFixed(2)} ms`,
  );
  assert.ok(states.ok > 100, 'most random starts find a route');
  assert.ok(times[285] < 10);
});
