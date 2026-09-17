/// <reference types="node" />
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, type DelugeRouteResult } from '../../src/routing/index';
import { SPEED_BY_CLASS, WET_SPEED_FACTOR } from '../../src/routing/constants';
import { formatDistance, formatDuration } from '../../src/routing/format';
import type { RouteResult, Shelter } from '../../src/contracts';
import { CELL_SIZE, floodRect, makeCity, shelterAt, type City } from './city';

// ─── helpers ────────────────────────────────────────────────────────────────────────────────────

/** x coordinates where the polyline crosses the horizontal line gy = y. */
function crossingsAtY(poly: Float32Array, y: number): number[] {
  const xs: number[] = [];
  for (let p = 0; p + 3 < poly.length; p += 2) {
    const y0 = poly[p + 1], y1 = poly[p + 3];
    if ((y0 - y) * (y1 - y) <= 0 && y0 !== y1) {
      const t = (y - y0) / (y1 - y0);
      xs.push(poly[p] + t * (poly[p + 2] - poly[p]));
    }
  }
  return xs;
}

/** Brute-force distance from a point to the road network (grid cells). */
function distToNetwork(city: City, x: number, y: number): number {
  let best = Infinity;
  for (const e of city.net.edges) {
    for (let q = 0; q + 3 < e.pts.length; q += 2) {
      const ax = e.pts[q], ay = e.pts[q + 1], bx = e.pts[q + 2], by = e.pts[q + 3];
      const vx = bx - ax, vy = by - ay;
      const l2 = vx * vx + vy * vy;
      let u = l2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / l2 : 0;
      u = Math.max(0, Math.min(1, u));
      best = Math.min(best, Math.hypot(ax + u * vx - x, ay + u * vy - y));
    }
  }
  return best;
}

function polyLengthCells(poly: Float32Array): number {
  let L = 0;
  for (let p = 0; p + 3 < poly.length; p += 2) L += Math.hypot(poly[p + 2] - poly[p], poly[p + 3] - poly[p + 1]);
  return L;
}

/**
 * Structural validity of an 'ok' route: starts at the start point, ends at the shelter, every vertex and
 * every segment midpoint except the off-road connectors lies on a road, no duplicate joints, and the
 * polyline length matches lengthMeters.
 */
function assertRouteGeometry(city: City, r: RouteResult, start: { gx: number; gy: number }, shelter: Shelter): void {
  assert.equal(r.state, 'ok', r.message);
  const poly = r.polyline!;
  assert.ok(poly && poly.length >= 4 && poly.length % 2 === 0, 'polyline has at least two points');
  const n = poly.length / 2;
  assert.ok(Math.hypot(poly[0] - start.gx, poly[1] - start.gy) < 1e-3, 'polyline starts at the start point');
  assert.ok(Math.hypot(poly[2 * n - 2] - shelter.gx, poly[2 * n - 1] - shelter.gy) < 1e-3, 'polyline ends at the shelter');
  for (let k = 1; k < n - 1; k++) {
    const x = poly[2 * k], y = poly[2 * k + 1];
    assert.ok(distToNetwork(city, x, y) < 2e-3, `vertex ${k} (${x}, ${y}) lies on a road`);
    assert.ok(Math.hypot(poly[2 * k + 2] - x, poly[2 * k + 3] - y) > 1e-5, `no duplicate joint at ${k}`);
  }
  // Interior segments follow roads (their midpoints are on the network); first/last are connectors.
  for (let k = 1; k < n - 2; k++) {
    const mx = (poly[2 * k] + poly[2 * k + 2]) / 2, my = (poly[2 * k + 1] + poly[2 * k + 3]) / 2;
    assert.ok(distToNetwork(city, mx, my) < 2e-3, `segment ${k} follows a road`);
    // Consecutive vertices along one road can be at most one polyline segment apart.
    assert.ok(Math.hypot(poly[2 * k + 2] - poly[2 * k], poly[2 * k + 3] - poly[2 * k + 1]) <= city.block + 1e-3);
  }
  const lenM = polyLengthCells(poly) * CELL_SIZE;
  assert.ok(Math.abs(lenM - r.lengthMeters) / r.lengthMeters < 0.005, `length ${r.lengthMeters} ≈ polyline ${lenM}`);
  assert.ok(r.etaSeconds > 0 && Number.isFinite(r.etaSeconds));
}

/**
 * The structured fields agree with the state and with the message sentence built from them, so a UI can
 * use either (see DelugeRouteResult).
 */
function assertStructured(r: DelugeRouteResult): void {
  if (r.state === 'ok') {
    assert.equal(r.reason, null);
    assert.equal(r.advice, '');
    assert.ok(r.via.length <= 2 && r.via.every((n) => n.length > 0), `via ${JSON.stringify(r.via)}`);
    assert.ok(r.wetMeters === 0 || (r.wetMeters >= 1 && r.wetMeters <= r.lengthMeters + 1e-6), `wetMeters ${r.wetMeters}`);
    let expected = `${r.via.length ? `Via ${r.via.join(' → ')} to` : 'Route to'} ${r.shelter!.name} — ${formatDistance(r.lengthMeters)}, ${formatDuration(r.etaSeconds)}`;
    if (r.wetMeters > 0) expected += ` (${formatDistance(r.wetMeters)} through shallow water — drive slowly)`;
    assert.equal(r.message, expected);
    return;
  }
  assert.ok(r.reason, `${r.state} result has a reason`);
  assert.deepEqual(r.via, []);
  assert.equal(r.wetMeters, 0);
  assert.ok(r.advice.length > 0 && r.advice[0] === r.advice[0].toUpperCase(), `advice "${r.advice}"`);
  if (r.state === 'none') {
    assert.equal(r.advice, r.message);
    assert.ok(['no-roads', 'no-start', 'no-shelters', 'start-off-network', 'shelters-off-network', 'start-in-water-body'].includes(r.reason!));
  } else {
    assert.ok(['start-flooded', 'start-roads-flooded', 'shelters-flooded', 'cut-off'].includes(r.reason!), r.reason!);
    const lead = `No safe route — ${r.advice[0].toLowerCase()}${r.advice.slice(1)}`;
    assert.equal(r.message, r.reason === 'start-flooded' ? r.advice : lead);
  }
}

function setup() {
  const city = makeCity();
  const router = createRouter();
  router.setNetwork(city.net, city.cellSize);
  const base = city.baseline();
  router.setBaselineWater(base, city.nx, city.ny);
  const status = router.updateFlood(base, city.nx, city.ny);
  // North of the river, one block east of bridge A's column.
  const sp = city.pos(city.bridgeACol + 1, 6);
  const start = { gx: sp.gx + 4, gy: sp.gy + 7 };
  const hp = city.pos(city.bridgeACol, 16);
  const shelter = shelterAt('Hilltop School', hp.gx + 6, hp.gy + 5);
  return { city, router, base, status, start, shelter };
}

const riverMidY = (city: City) => (city.riverY0 + city.riverY1) / 2;
const bridgeX = (city: City, col: number) => city.pos(col, 0).gx;

// ─── tests ──────────────────────────────────────────────────────────────────────────────────────

describe('flood status', () => {
  test('bridges over standing river water stay dry; roads classify by depth thresholds', () => {
    const { city, router, status } = setup();
    assert.ok(status);
    assert.equal(status!.length, city.net.edges.length);
    assert.equal(status![city.bridgeEdge(city.bridgeACol)], 0, 'bridge A dry at normal river level');
    assert.equal(status![city.bridgeEdge(city.bridgeBCol)], 0, 'bridge B dry at normal river level');
    assert.ok(status!.every((s) => s === 0), 'whole network dry with only the river present');

    // A horizontal street segment (row 3, between columns 7 and 8), probe the thresholds.
    const e = city.net.edges.findIndex(
      (ed) => new Set([ed.a, ed.b]).has(city.node(7, 3)) && new Set([ed.a, ed.b]).has(city.node(8, 3)),
    );
    const p = city.pos(7, 3);
    const cell = Math.floor(p.gy) * city.nx + Math.floor(p.gx) + 10;
    for (const [depth, expected] of [
      [0.049, 0],
      [0.05, 1],
      [0.29, 1],
      [0.3, 2],
      [3, 2],
    ] as const) {
      const d = city.baseline();
      d[cell] = depth;
      const st = router.updateFlood(d, city.nx, city.ny)!;
      assert.equal(st[e], expected, `depth ${depth} → status ${expected}`);
      assert.ok(Math.abs(router.getEdgeDepths()![e] - depth) < 1e-6, 'per-edge depth is the max sample depth');
      const others = st.reduce((n, s, k) => n + (k !== e && s !== 0 ? 1 : 0), 0);
      // The probed cell is interior to the block edge, so no other edge may see it.
      assert.equal(others, 0, 'only the edge over that cell changes');
    }
  });

  test('status array identity changes only when the content changes', () => {
    const { city, router, base, status } = setup();
    const again = router.updateFlood(base, city.nx, city.ny);
    assert.equal(again, status, 'unchanged flood → same array');
    const d = city.baseline();
    floodRect(d, city.nx, 0, 0, 60, 60, 1);
    const changed = router.updateFlood(d, city.nx, city.ny);
    assert.notEqual(changed, status, 'changed flood → new array identity');
    assert.ok(changed!.some((s) => s === 2));
    assert.ok(status!.every((s) => s === 0), 'previously returned array is not mutated by the change');
  });

  test('handles depth grids of a different size: same aspect → rescaled, otherwise null', () => {
    const { city, router, start, shelter } = setup();
    // Half-resolution depth grid flooding bridge A's approaches → same effect as full resolution.
    const hx = city.nx / 2, hy = city.ny / 2;
    const half = new Float32Array(hx * hy);
    for (let j = city.riverY0 >> 1; j < (city.riverY1 + 1) >> 1; j++) half.fill(4, j * hx, (j + 1) * hx);
    const bx = bridgeX(city, city.bridgeACol);
    floodRect(half, hx, (bx - 12) >> 1, (city.riverY0 - 12) >> 1, (bx + 12) >> 1, (city.riverY1 + 12) >> 1, 1);
    const st = router.updateFlood(half, hx, hy);
    assert.ok(st, 'rescaled grid accepted');
    assert.equal(st![city.bridgeEdge(city.bridgeACol)], 2, 'bridge A approaches flooded at half resolution');
    assert.equal(st![city.bridgeEdge(city.bridgeBCol)], 0);
    const r = router.route(start, [shelter]);
    assert.equal(r.state, 'ok');

    const prev = router.getRoadStatus();
    assert.equal(router.updateFlood(new Float32Array(city.nx * 32), city.nx, 32), null, 'different aspect → null');
    assert.equal(router.updateFlood(new Float32Array(10), city.nx, city.ny), null, 'short depth array → null');
    assert.equal(router.getRoadStatus(), prev, 'rejected updates keep the previous status');
  });

  test('without a baseline roads are judged purely by depth (bridges over water read as flooded)', () => {
    const { city, router, base, start, shelter } = setup();
    router.setBaselineWater(null, city.nx, city.ny);
    let st = router.updateFlood(base, city.nx, city.ny)!;
    assert.equal(st[city.bridgeEdge(city.bridgeACol)], 2);
    assert.equal(st[city.bridgeEdge(city.bridgeBCol)], 2);
    assert.equal(router.route(start, [shelter]).state, 'blocked');

    // Same for a fresh network that never got a baseline: the first flood field is NOT taken as one.
    router.setNetwork(city.net, city.cellSize);
    const d = city.baseline();
    floodRect(d, city.nx, 0, 0, 60, 60, 1);
    st = router.updateFlood(d, city.nx, city.ny)!;
    assert.equal(st[city.bridgeEdge(city.bridgeACol)], 2);
    // 8 street edges touch the flooded 60×60-cell corner, plus the 2 bridges over the river.
    assert.equal(st.filter((v) => v === 2).length, 10, 'flooded streets in the first field are flooded');
  });

  test('explicit baseline + first updateFlood already flooded keeps flood detection', () => {
    const city = makeCity();
    const router = createRouter();
    router.setNetwork(city.net, city.cellSize);
    router.setBaselineWater(city.baseline(), city.nx, city.ny);
    const d = city.baseline();
    const bx = bridgeX(city, city.bridgeACol);
    floodRect(d, city.nx, bx - 12, city.riverY0 - 12, bx + 12, city.riverY1 + 12, 1);
    const st = router.updateFlood(d, city.nx, city.ny)!;
    assert.equal(st[city.bridgeEdge(city.bridgeACol)], 2);
    assert.equal(st[city.bridgeEdge(city.bridgeBCol)], 0);
  });
});

describe('evacuation routes', () => {
  test('dry route crosses the nearest bridge and is geometrically continuous', () => {
    const { city, router, start, shelter } = setup();
    const r = router.route(start, [shelter]);
    assertRouteGeometry(city, r, start, shelter);
    const xs = crossingsAtY(r.polyline!, riverMidY(city));
    assert.equal(xs.length, 1, 'crosses the river once');
    assert.ok(Math.abs(xs[0] - bridgeX(city, city.bridgeACol)) < 1, 'over bridge A');
    assert.equal(r.shelter, shelter);
    assert.match(r.message, /^Via .+ to Hilltop School — \d/);
    assert.ok(r.via.some((n) => n.startsWith('Smithfield')), `names the main street used: ${JSON.stringify(r.via)}`);
    assert.equal(r.wetMeters, 0);
    assertStructured(r);
    // Sanity: ETA consistent with local-street speeds (connectors walk at 1.4 m/s).
    assert.ok(r.etaSeconds > r.lengthMeters / SPEED_BY_CLASS.highway && r.etaSeconds < r.lengthMeters / 1.4);
  });

  test('flooding bridge A reroutes over bridge B; flooding both is blocked', () => {
    const { city, router, start, shelter } = setup();
    const dry = router.route(start, [shelter]);

    const d = city.baseline();
    const ax = bridgeX(city, city.bridgeACol);
    floodRect(d, city.nx, ax - 12, city.riverY0 - 12, ax + 12, city.riverY1 + 12, 1.2);
    const st = router.updateFlood(d, city.nx, city.ny)!;
    assert.equal(st[city.bridgeEdge(city.bridgeACol)], 2, 'bridge A is cut');
    const r = router.route(start, [shelter]);
    assertRouteGeometry(city, r, start, shelter);
    const xs = crossingsAtY(r.polyline!, riverMidY(city));
    assert.equal(xs.length, 1);
    assert.ok(Math.abs(xs[0] - bridgeX(city, city.bridgeBCol)) < 1, 'reroutes over bridge B');
    assert.ok(r.lengthMeters > dry.lengthMeters + 1500 && r.etaSeconds > dry.etaSeconds, 'detour is longer');
    assert.ok(r.via.length > 0, 'names the detour streets');
    assertStructured(r);

    const bx = bridgeX(city, city.bridgeBCol);
    floodRect(d, city.nx, bx - 12, city.riverY0 - 12, bx + 12, city.riverY1 + 12, 0.6);
    router.updateFlood(d, city.nx, city.ny);
    const b = router.route(start, [shelter]);
    assert.equal(b.state, 'blocked');
    assert.equal(b.message, 'No safe route — all roads to shelters are flooded. Shelter in place on higher floors.');
    assert.equal(b.reason, 'cut-off');
    assert.equal(b.advice, 'All roads to shelters are flooded. Shelter in place on higher floors.');
    assertStructured(b);
    assert.equal(b.shelter, null);
    assert.ok(b.polyline && b.polyline.length >= 4, 'blocked result carries the cut route for red rendering');

    // Recedes → routes again.
    router.updateFlood(city.baseline(), city.nx, city.ny);
    assert.equal(router.route(start, [shelter]).state, 'ok');
  });

  test('picks the nearest reachable of several shelters; flooded shelters are skipped', () => {
    const { city, router, start } = setup();
    const north = city.pos(city.bridgeACol + 6, 4);
    const south = city.pos(city.bridgeACol, 16);
    const near = shelterAt('North Library', north.gx + 3, north.gy + 3);
    const far = shelterAt('Hilltop School', south.gx + 3, south.gy + 3);
    let r = router.route(start, [far, near]);
    assert.equal(r.state, 'ok');
    assert.equal(r.shelter, near);
    assert.match(r.message, /to North Library/);

    const d = city.baseline();
    floodRect(d, city.nx, Math.floor(near.gx) - 4, Math.floor(near.gy) - 4, Math.floor(near.gx) + 5, Math.floor(near.gy) + 5, 0.5);
    router.updateFlood(d, city.nx, city.ny);
    r = router.route(start, [far, near]);
    assert.equal(r.state, 'ok');
    assert.equal(r.shelter, far, 'shelter standing in 0.5 m of water is not a destination');

    r = router.route(start, [near]);
    assert.equal(r.state, 'blocked');
    assert.match(r.message, /every shelter is flooded/);
    assert.equal(r.reason, 'shelters-flooded');
    assertStructured(r);
  });

  test('wet roads slow the ETA (×1/0.3) but stay passable', () => {
    const { city, router, start, shelter } = setup();
    const dry = router.route(start, [shelter]);
    const d = new Float32Array(city.nx * city.ny).fill(0.1);
    for (let j = city.riverY0; j < city.riverY1; j++) d.fill(4, j * city.nx, (j + 1) * city.nx);
    const st = router.updateFlood(d, city.nx, city.ny)!;
    assert.ok(st.every((s) => s === 1), 'all roads wet');
    const wet = router.route(start, [shelter]);
    assertRouteGeometry(city, wet, start, shelter);
    // Same corridor (the final walking connector may shift slightly: walking isn't slowed by the wet factor).
    assert.ok(Math.abs(wet.lengthMeters - dry.lengthMeters) < 0.05 * dry.lengthMeters, 'same corridor');
    const ratio = wet.etaSeconds / dry.etaSeconds;
    assert.ok(ratio > 2.5 && ratio <= 1 / WET_SPEED_FACTOR + 1e-9, `ETA ratio ${ratio.toFixed(2)}`);
    assert.match(wet.message, /through shallow water/);
    // Everything but the two short walking connectors is on (wet) road.
    assert.ok(wet.wetMeters > 0.9 * wet.lengthMeters && wet.wetMeters < wet.lengthMeters, `wetMeters ${wet.wetMeters} of ${wet.lengthMeters}`);
    assertStructured(wet);
    assert.equal(dry.wetMeters, 0);
  });

  test('start in floodwater is reported with its depth', () => {
    const { city, router, start, shelter } = setup();
    const d = city.baseline();
    floodRect(d, city.nx, Math.floor(start.gx) - 3, Math.floor(start.gy) - 3, Math.floor(start.gx) + 4, Math.floor(start.gy) + 4, 0.8);
    router.updateFlood(d, city.nx, city.ny);
    const r = router.route(start, [shelter]);
    assert.equal(r.state, 'blocked');
    assert.match(r.message, /^Start point is under 0\.8 m of water/);
    assert.match(r.message, /higher floors/);
    assert.equal(r.reason, 'start-flooded');
    assertStructured(r);
  });

  test('start placed in the river (standing water) asks for a point on land', () => {
    const { city, router, shelter } = setup();
    const r = router.route({ gx: 200.5, gy: (city.riverY0 + city.riverY1) / 2 }, [shelter]);
    assert.equal(r.state, 'none');
    assert.match(r.message, /^Start point is under 4\.0 m of water \(river or lake\) — click on land/);
    assert.equal(r.reason, 'start-in-water-body');
    assertStructured(r);
  });

  test('start whose surrounding roads are all flooded is blocked', () => {
    const { city, router, start, shelter } = setup();
    const d = city.baseline();
    // Flood a 5×5-block square around the start but leave a dry island around the start cell itself.
    const x0 = Math.floor(start.gx) - 60, y0 = Math.floor(start.gy) - 60;
    floodRect(d, city.nx, x0, y0, x0 + 120, y0 + 120, 0.5);
    for (let j = Math.floor(start.gy) - 2; j <= Math.floor(start.gy) + 2; j++) {
      for (let i = Math.floor(start.gx) - 2; i <= Math.floor(start.gx) + 2; i++) d[j * city.nx + i] = 0;
    }
    router.updateFlood(d, city.nx, city.ny);
    const r = router.route(start, [shelter]);
    assert.equal(r.state, 'blocked');
    assert.match(r.message, /^No safe route/);
    assertStructured(r);
  });

  test("'none' results explain how to use the tool", () => {
    const { city, router, start, shelter } = setup();
    const a = router.route(null, [shelter]);
    assert.equal(a.state, 'none');
    assert.match(a.message, /Evac tool/);
    assert.equal(a.reason, 'no-start');
    assertStructured(a);
    assert.equal(a.polyline, null);
    const b = router.route(start, []);
    assert.equal(b.state, 'none');
    assert.match(b.message, /Shelter tool/);
    assert.equal(b.reason, 'no-shelters');
    assertStructured(b);

    const empty = createRouter();
    assert.equal(empty.updateFlood(city.baseline(), city.nx, city.ny), null);
    assert.equal(empty.route(start, [shelter]).state, 'none');
    empty.setNetwork({ nodes: new Float32Array(0), edges: [] }, 8);
    const c = empty.route(start, [shelter]);
    assert.equal(c.state, 'none');
    assert.match(c.message, /No road data/);
    assert.equal(c.reason, 'no-roads');
    assertStructured(c);
    empty.setNetwork(null, 8);
    assert.equal(empty.updateFlood(city.baseline(), city.nx, city.ny), null);

    // Start far from every road (> 300 m).
    const sparse = makeCity({ blocks: 2, block: 24 });
    const r2 = createRouter();
    r2.setNetwork(sparse.net, 8);
    const out = r2.route({ gx: 500, gy: 500 }, [shelterAt('X', 20, 20)]);
    assert.equal(out.state, 'none');
    assert.match(out.message, /No road within 300 m/);
    assert.equal(out.reason, 'start-off-network');
    assertStructured(out);
  });

  test('start and shelter on the same street segment', () => {
    const { city, router } = setup();
    const p = city.pos(12, 3);
    const start = { gx: p.gx + 3, gy: p.gy + 1.5 };
    const shelter = shelterAt('Corner Church', p.gx + 20, p.gy - 1.5);
    const r = router.route(start, [shelter]);
    assertRouteGeometry(city, r, start, shelter);
    assert.ok(r.lengthMeters < 30 * CELL_SIZE, `short direct route (${r.lengthMeters} m)`);
  });

  test('routes work before any updateFlood (all roads dry)', () => {
    const city = makeCity();
    const router = createRouter();
    router.setNetwork(city.net, city.cellSize);
    const sp = city.pos(3, 2);
    const hp = city.pos(17, 18);
    const start = { gx: sp.gx + 2, gy: sp.gy + 2 };
    const shelter = shelterAt('Far', hp.gx - 2, hp.gy - 2);
    assertRouteGeometry(city, router.route(start, [shelter]), start, shelter);
  });

  test('optimality: ETA matches a reference Dijkstra under random floods', () => {
    const city = makeCity({ seed: 99 });
    const router = createRouter();
    router.setNetwork(city.net, city.cellSize);
    let rng = 42;
    const rand = () => ((rng = (rng * 1664525 + 1013904223) >>> 0) / 4294967296);
    const nNodes = city.net.nodes.length / 2;
    let compared = 0;
    let exact = 0;
    for (let trial = 0; trial < 40; trial++) {
      const d = city.baseline();
      for (let blob = 0; blob < 6; blob++) {
        const cx = Math.floor(rand() * city.nx), cy = Math.floor(rand() * city.ny);
        floodRect(d, city.nx, cx - 20, cy - 20, cx + 20, cy + 20, rand() < 0.5 ? 0.12 : 0.9);
      }
      const status = router.updateFlood(d, city.nx, city.ny)!;
      // Reference: plain O(V²) Dijkstra over node indices with identical edge costs.
      const cost = city.net.edges.map((e, k) => {
        const base = e.length / SPEED_BY_CLASS[e.cls];
        return status[k] === 2 ? Infinity : status[k] === 1 ? base / WET_SPEED_FACTOR : base;
      });
      const s = Math.floor(rand() * nNodes);
      const t = Math.floor(rand() * nNodes);
      const dist = new Float64Array(nNodes).fill(Infinity);
      const done = new Uint8Array(nNodes);
      dist[s] = 0;
      for (;;) {
        let u = -1;
        for (let k = 0; k < nNodes; k++) if (!done[k] && dist[k] < Infinity && (u < 0 || dist[k] < dist[u])) u = k;
        if (u < 0) break;
        done[u] = 1;
        city.net.edges.forEach((e, k) => {
          if (e.a !== u && e.b !== u) return;
          const v = e.a === u ? e.b : e.a;
          if (dist[u] + cost[k] < dist[v]) dist[v] = dist[u] + cost[k];
        });
      }
      const start = { gx: city.net.nodes[2 * s], gy: city.net.nodes[2 * s + 1] };
      const shelter = shelterAt('T', city.net.nodes[2 * t], city.net.nodes[2 * t + 1]);
      const r = router.route(start, [shelter]);
      assertStructured(r);
      const startDepth = d[Math.floor(start.gy) * city.nx + Math.floor(start.gx)];
      if (startDepth >= 0.3 || d[Math.floor(shelter.gy) * city.nx + Math.floor(shelter.gx)] >= 0.3) continue;
      if (dist[t] === Infinity) {
        // The router may still find a route by walking a short connector to a parallel street; it must
        // never be *worse* than impossible, and a reported route must be valid.
        if (r.state === 'ok') assertRouteGeometry(city, r, start, shelter);
        continue;
      }
      compared++;
      assert.equal(r.state, 'ok', `trial ${trial}: reference reachable → ${r.message}`);
      assert.ok(r.etaSeconds <= dist[t] + 1e-6, `trial ${trial}: router ${r.etaSeconds} ≤ reference ${dist[t]}`);
      if (Math.abs(r.etaSeconds - dist[t]) < 1e-6) exact++;
      assertRouteGeometry(city, r, start, shelter);
    }
    assert.ok(compared >= 15, `enough comparable trials (${compared})`);
    assert.ok(exact >= compared * 0.8, `router equals reference in most trials (${exact}/${compared})`);
  });
});
