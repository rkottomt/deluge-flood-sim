/**
 * Departure curves (departure.ts), the bottleneck queue (bottleneck.ts) and the router's per-class route lengths that
 * feed it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter } from '../../src/routing/index';
import { CLASS_CODE } from '../../src/routing/constants';
import {
  DEFAULT_DEPARTURE_CURVE,
  DEPARTURE_CURVES,
  departedShare,
  departureBand,
  departureCurve,
  departureQuantileS,
  type DepartureCurve,
} from '../../src/routing/departure';
import {
  bottleneckQueue,
  CLASS_LANES,
  defaultPersonsPerVehicle,
  departedBy,
  HCM_BASE_SATURATION_FLOW,
  LANE_FLOW_VPH,
  routeBottleneck,
  SIGNAL_GREEN_SHARE,
  throughBy,
  twscCapacity,
  vehiclesFor,
} from '../../src/routing/bottleneck';
import { formatTPlus } from '../../src/routing/pedestrianEvac';
import { CELL_SIZE, makeCity, shelterAt } from './city';

test('alert times before the run starts read T−', () => {
  assert.equal(formatTPlus(-600), 'T−10 min');
  assert.equal(formatTPlus(-7200), 'T−2 h 00 min');
  assert.equal(formatTPlus(0), 'T+0 min');
  assert.equal(formatTPlus(-10), 'T+0 min');
  assert.equal(formatTPlus(5400), 'T+1 h 30 min');
});

const close = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);

/** Everyone leaves within a second of the warning: a step departure. */
const INSTANT: DepartureCurve = { id: 'custom', label: 'instant', a: 1, bMin: 1 / 60, maxShare: 1, source: 'test' };

// ─── Departure curves ────────────────────────────────────────────────────────────────────────────────────────────

test('departure curve: Sorensen & Mileti form m·(1 − exp(−t²/(a·b²))), published coefficients', () => {
  const c = DEPARTURE_CURVES['poor-likely'];
  assert.equal(DEFAULT_DEPARTURE_CURVE, 'poor-likely');
  assert.deepEqual([c.a, c.bMin, c.maxShare], [1.79, 111.8, 0.743]);
  assert.deepEqual([DEPARTURE_CURVES['good-likely'].a, DEPARTURE_CURVES['good-likely'].bMin, DEPARTURE_CURVES['good-likely'].maxShare], [1.37, 64.0, 0.888]);
  assert.equal(DEPARTURE_CURVES['poor-unlikely'].maxShare, 0.57);
  for (const k of Object.values(DEPARTURE_CURVES)) assert.match(k.source, /Sorensen & Mileti 2015b/);
  // Nobody before the warning; at t = b the bracket is 1 − e^(−1/a); the cap is the 8-hour maximum share.
  assert.equal(departedShare(c, 0), 0);
  assert.equal(departedShare(c, -600), 0);
  close(departedShare(c, 111.8 * 60), 0.743 * (1 - Math.exp(-1 / 1.79)), 1e-12);
  close(departedShare(c, 1e7), 0.743, 1e-12);
  // Worked numbers: 11 % gone after an hour, 35 % after two (of all occupants).
  close(departedShare(c, 3600), 0.11, 0.005, '1 h');
  close(departedShare(c, 7200), 0.353, 0.005, '2 h');
  // Monotone.
  let prev = 0;
  for (let s = 0; s <= 6 * 3600; s += 300) {
    const v = departedShare(c, s);
    assert.ok(v >= prev);
    prev = v;
  }
});

test('departure quantiles invert the curve among leavers; the band is p10 < p50 < p90', () => {
  for (const c of Object.values(DEPARTURE_CURVES)) {
    for (const p of [0.1, 0.5, 0.9, 0.99]) close(departedShare(c, departureQuantileS(c, p)) / c.maxShare, p, 1e-9, `${c.id} p${p}`);
    const b = departureBand(c);
    assert.ok(b.p10 < b.p50 && b.p50 < b.p90);
  }
  const b = departureBand(DEPARTURE_CURVES['poor-likely']);
  close(b.p10 / 60, 48.6, 0.2, 'p10 min');
  close(b.p90 / 60, 226.9, 0.3, 'p90 min');
  // The "median" b is the bracket's median for a = 1/ln 2 only; for the published a it stays within ±25 %.
  for (const c of Object.values(DEPARTURE_CURVES)) {
    const ratio = departureQuantileS(c, 0.5) / 60 / c.bMin;
    assert.ok(ratio > 0.75 && ratio < 1.25, `${c.id} median/b ${ratio}`);
  }
  assert.equal(departureQuantileS(DEPARTURE_CURVES.fast, 0), 0);
  assert.equal(departureQuantileS(DEPARTURE_CURVES.fast, 1), Infinity);
});

test('departure curve overrides: clamped, labelled as the user’s, preset untouched', () => {
  assert.equal(departureCurve('good-likely'), DEPARTURE_CURVES['good-likely']);
  const c = departureCurve('poor-likely', { bMin: 30, maxShare: 1.5, a: null });
  assert.equal(c.id, 'custom');
  assert.equal(c.bMin, 30);
  assert.equal(c.maxShare, 1);
  assert.equal(c.a, 1.79);
  assert.match(c.source, /your input/);
  assert.equal(departureCurve('poor-likely', { a: 0 }).a, 0.2);
  assert.equal(departureCurve('poor-likely', { bMin: Number.NaN }).bMin, 111.8);
  assert.equal(departureCurve('nope' as never).id, 'poor-likely');
});

// ─── Capacity ────────────────────────────────────────────────────────────────────────────────────────────────────

test('lane capacities: HCM saturation flow × green, TWSC right turn, Floyd highway flows', () => {
  assert.equal(LANE_FLOW_VPH[CLASS_CODE.major], HCM_BASE_SATURATION_FLOW * SIGNAL_GREEN_SHARE);
  assert.equal(LANE_FLOW_VPH[CLASS_CODE.minor], 950);
  assert.equal(LANE_FLOW_VPH[CLASS_CODE.highway], 1600);
  // HCM two-way stop control: right turn from a stop sign into 600 veh/h ≈ 505 veh/h → the local rate of 500.
  close(twscCapacity(600), 505, 1);
  assert.equal(LANE_FLOW_VPH[CLASS_CODE.local], 500);
  assert.ok(twscCapacity(1200) < twscCapacity(300), 'busier major road, less room to merge');
  assert.deepEqual([...CLASS_LANES], [2, 2, 1, 1]);
});

test('route bottleneck: the site exit or the weakest road class on the route', () => {
  // A route on major roads only: the 1-lane exit (500/h) is the bottleneck.
  const onMajor = routeBottleneck([0, 1500, 0, 0], 1);
  assert.equal(onMajor.where, 'exit');
  assert.equal(onMajor.capacityVph, 500);
  // Two exit lanes (1,000/h) on a route that uses a local street (500/h): the street.
  const viaLocal = routeBottleneck([0, 1500, 0, 300], 2);
  assert.equal(viaLocal.where, 'road');
  assert.equal(viaLocal.cls, CLASS_CODE.local);
  assert.equal(viaLocal.capacityVph, 500);
  // Four exit lanes onto a minor road: the minor road's single signalised lane (950/h).
  assert.equal(routeBottleneck([2000, 0, 400, 0], 4).capacityVph, 950);
  // A snapping sliver of local street does not count.
  assert.equal(routeBottleneck([0, 1500, 0, 5], 4).capacityVph, 1900);
  assert.equal(routeBottleneck([0, 1500, 0, 5], 4).cls, CLASS_CODE.major);
  // Unknown route: the exit alone.
  assert.equal(routeBottleneck(null, 2).capacityVph, 1000);
  assert.equal(routeBottleneck(undefined, 0).lanes, 1, 'at least one lane');
});

test('cars from occupants by use: homes 2.0, workplaces 1.18 per car', () => {
  assert.equal(defaultPersonsPerVehicle('res').value, 2.0);
  assert.equal(defaultPersonsPerVehicle('apt').value, 2.0);
  assert.equal(defaultPersonsPerVehicle('office').value, 1.18);
  assert.match(defaultPersonsPerVehicle('res').basis, /1\.23/);
  assert.equal(vehiclesFor(590, 1.18), 500);
  assert.equal(vehiclesFor(1, 2), 1);
  assert.equal(vehiclesFor(0, 2), 0);
  assert.equal(vehiclesFor(10, 0), 10, 'never more than one person per car below 1');
});

// ─── The queue ───────────────────────────────────────────────────────────────────────────────────────────────────

test('queue: 500 cars through one 500/h exit take an hour when they all leave at once', () => {
  const q = bottleneckQueue(500, 500, INSTANT);
  close(q.queueOnlyS, 3600, 1e-9);
  close(q.clearanceS, 3600, 15);
  close(q.maxQueue, 500, 2);
  // Half of them are through after half an hour.
  close(throughBy(500, 500, INSTANT, 1800), 250, 1);
  close(throughBy(500, 500, INSTANT, 7200), 500, 1e-9);
});

test('queue: a slow trickle never queues, and clearance is the departure curve’s', () => {
  const c = DEPARTURE_CURVES['poor-likely'];
  const q = bottleneckQueue(20, 1600, c);
  // 20 cars over hours: through as soon as they leave.
  const p99 = departureQuantileS(c, 0.99);
  close(q.clearanceS, p99, 20);
  assert.ok(q.maxQueue < 1);
  close(q.leaving, 20 * 0.743, 1e-9);
  for (const s of [1800, 3600, 7200]) close(throughBy(20, 1600, c, s), departedBy(20, c, s), 0.05);
});

test('queue: clearance is never below the queue alone nor below the last departure; throughBy ≤ departed', () => {
  for (const c of Object.values(DEPARTURE_CURVES)) {
    for (const [V, cap] of [
      [50, 500],
      [500, 500],
      [2000, 950],
      [5000, 3200],
    ]) {
      const q = bottleneckQueue(V, cap, c);
      assert.ok(q.clearanceS >= q.queueOnlyS - 15, `${c.id} ${V}/${cap}: ${q.clearanceS} < ${q.queueOnlyS}`);
      assert.ok(q.clearanceS >= departureQuantileS(c, 0.99) - 15);
      let prev = 0;
      for (let s = 0; s <= q.clearanceS + 600; s += 900) {
        const d = throughBy(V, cap, c, s);
        assert.ok(d <= departedBy(V, c, s) + 1e-6, 'nobody through before leaving');
        assert.ok(d <= (cap / 3600) * s + 1e-6, 'never faster than the bottleneck');
        assert.ok(d >= prev - 1e-6, 'monotone');
        prev = d;
      }
      close(throughBy(V, cap, c, q.clearanceS + 60), q.leaving, 0.02 * q.leaving + 1);
    }
  }
});

test('queue: no capacity or no cars', () => {
  assert.equal(bottleneckQueue(100, 0, INSTANT).clearanceS, Infinity);
  assert.equal(bottleneckQueue(0, 500, INSTANT).clearanceS, 0);
  assert.equal(throughBy(100, 0, INSTANT, 3600), 0);
});

// ─── The router's per-class lengths ──────────────────────────────────────────────────────────────────────────────

test('router: an ok route reports its metres per road class, summing to the on-road length', () => {
  const city = makeCity();
  const r = createRouter();
  r.setNetwork(city.net, CELL_SIZE);
  r.setBaselineWater(city.baseline(), city.nx, city.ny);
  r.updateFlood(city.baseline(), city.nx, city.ny);
  const start = city.pos(2, 2);
  const res = r.route({ gx: start.gx + 3, gy: start.gy }, [shelterAt('S', city.pos(14, 16).gx, city.pos(14, 16).gy)]);
  assert.equal(res.state, 'ok', res.message);
  const cm = res.classMeters!;
  assert.equal(cm.length, 4);
  const sum = cm.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0 && sum <= res.lengthMeters + 1e-6, `${sum} vs ${res.lengthMeters}`);
  assert.ok(res.lengthMeters - sum < 2 * 300, 'only the connectors are off-road');
  assert.ok(cm.every((m) => m >= 0));
  // A blocked route reports none.
  const flooded = city.baseline();
  flooded.fill(2);
  r.updateFlood(flooded, city.nx, city.ny);
  assert.equal(r.route(start, [shelterAt('S', 300, 300)]).classMeters, undefined);
});
