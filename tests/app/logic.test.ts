/**
 * Unit tests for the app module's pure logic (no GPU, no DOM):
 *   store re-entrancy · stage levels · store→solver sync · URL parsing · overlay change detection ·
 *   runFor scheduling · evacuation routing throttle.
 * Run: node --import tsx --test tests/app/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  AppState,
  BrushOp,
  EvacuationRouter,
  FloodSolver,
  RouteResult,
  SimParams,
  SimSnapshot,
  StormCell,
  WaterSource,
} from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { ErrorReporter } from '../../src/app/errors';
import { EvacController } from '../../src/app/evac';
import { NO_TRANSIENT, OverlayComposer } from '../../src/app/overlays';
import { RunForScheduler } from '../../src/app/runFor';
import { SimSync } from '../../src/app/simSync';
import { StageLevels, stageOffsetForFeet, feetForStageOffset } from '../../src/app/stage';
import { STAGE_RATE_MAX, StageRamp } from '../../src/app/stageRamp';
import { createStore } from '../../src/app/store';
import { parseStartupRequest } from '../../src/app/url';

const stage = (id: string, level: number): WaterSource => ({ id, type: 'stage', gx: 1, gy: 1, radius: 2, level });
const inflow = (id: string, discharge: number): WaterSource => ({ id, type: 'inflow', gx: 1, gy: 1, radius: 2, discharge });

// ─── store ───────────────────────────────────────────────────────────────────────────────────
test('store: notifies only on change, and re-entrant sets are delivered in order', () => {
  const store = createStore(createInitialState());
  const seenA: Array<[number, number]> = [];
  const seenB: Array<[number, number]> = [];
  store.subscribe((s, prev) => {
    seenA.push([prev.stageOffset, s.stageOffset]);
    if (s.stageOffset === 1) store.set({ stageOffset: 2 }); // re-entrant
  });
  store.subscribe((s, prev) => {
    seenB.push([prev.stageOffset, s.stageOffset]);
  });
  store.set({ stageOffset: 0 }); // unchanged → no notification
  assert.equal(seenA.length, 0);
  store.set({ stageOffset: 1 });
  assert.deepEqual(seenA, [
    [0, 1],
    [1, 2],
  ]);
  // The second subscriber never sees a stale state after a newer one.
  assert.deepEqual(seenB, [
    [0, 1],
    [1, 2],
  ]);
  assert.equal(store.get().stageOffset, 2);
});

test('store: a throwing subscriber does not block others', () => {
  const store = createStore(createInitialState());
  let called = false;
  const origError = console.error;
  console.error = () => {};
  try {
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(() => {
      called = true;
    });
    store.set({ paused: true });
  } finally {
    console.error = origError;
  }
  assert.ok(called);
});

// ─── stage levels ────────────────────────────────────────────────────────────────────────────
test('stage levels: offset applies to bases without accumulating', () => {
  const levels = new StageLevels();
  const base = [stage('a', 216.4), inflow('q', 500), stage('b', 216.0)];
  levels.resetFrom(base);
  const up = levels.apply(base, 9);
  assert.equal((up[0] as { level: number }).level, 225.4);
  assert.equal(up[1], base[1], 'non-stage sources are untouched (same object)');
  const upAgain = levels.apply(up, 9);
  assert.equal(upAgain, up, 'no change → same array');
  const down = levels.apply(up, 2);
  assert.ok(Math.abs((down[2] as { level: number }).level - 218.0) < 1e-9);
});

test('stage levels: offsetScale lets upstream boundaries rise faster than the downstream one (confluence head)', () => {
  const levels = new StageLevels();
  const up: WaterSource = { id: 'up', type: 'stage', gx: 1, gy: 1, radius: 2, level: 216.375, offsetScale: 1.01369 };
  const down: WaterSource = { id: 'down', type: 'stage', gx: 1, gy: 1, radius: 2, level: 216.225, offsetScale: 0.98631 };
  levels.resetFrom([up, down]);
  const at = (o: number) => levels.apply([up, down], o).map((s) => (s as { level: number }).level);
  const [u0, d0] = at(0);
  const [u46, d46] = at(9.13);
  assert.ok(Math.abs(u0 - d0 - 0.15) < 1e-9, 'head at normal pool');
  assert.ok(Math.abs(u46 - d46 - 0.4) < 1e-3, `head at the 1936 crest: ${u46 - d46}`);
  assert.ok(Math.abs((u46 + d46) / 2 - (216.3 + 9.13)) < 1e-9, 'the mean level (the gauge at the confluence) follows the slider exactly');
  // Recording at a raised offset recovers the same bases (no drift through UI edits).
  const raised = levels.apply([up, down], 9.13);
  levels.record(raised, 9.13);
  assert.deepEqual(at(0), [u0, d0]);
});

test('stage ramp: the applied stage follows the slider at a bounded rate, arrives exactly, never overshoots', () => {
  const ramp = new StageRamp();
  assert.equal(ramp.advance(10), false, 'at rest');
  ramp.setTarget(9.13);
  assert.equal(ramp.advance(0), false, 'paused: no simulated time, no change');
  let t = 0;
  let prev = 0;
  let maxRate = 0;
  while (ramp.moving && t < 1000) {
    ramp.advance(0.25);
    t += 0.25;
    maxRate = Math.max(maxRate, (ramp.applied - prev) / 0.25);
    assert.ok(ramp.applied >= prev - 1e-12 && ramp.applied <= 9.13 + 1e-12, `monotone, bounded at t=${t}`);
    prev = ramp.applied;
  }
  assert.equal(ramp.applied, 9.13);
  assert.ok(t > 180 && t < 260, `46 ft crest arrives in ${t} sim-s`);
  assert.ok(maxRate <= STAGE_RATE_MAX + 1e-9, `rate ${maxRate}`);
  // Big automation frames give the same arrival (within a chunk) and still land exactly.
  const fast = new StageRamp();
  fast.setTarget(9.13);
  let tf = 0;
  while (fast.moving && tf < 1000) {
    fast.advance(17);
    tf += 17;
  }
  assert.equal(fast.applied, 9.13);
  assert.ok(Math.abs(tf - t) <= 17, `chunked arrival ${tf} vs ${t}`);
  // Lowered mid-rise: it brakes (a little past the reversal point) and settles on the new target.
  const rev = new StageRamp();
  rev.setTarget(9);
  for (let k = 0; k < 100; k++) rev.advance(1);
  const at = rev.applied;
  rev.setTarget(2);
  let peak = at;
  for (let k = 0; k < 400 && rev.moving; k++) {
    rev.advance(1);
    peak = Math.max(peak, rev.applied);
    assert.ok(rev.applied >= 2 - 1e-12, 'no undershoot');
  }
  assert.equal(rev.applied, 2);
  assert.ok(peak - at < 0.5, `keeps rising only ${(peak - at).toFixed(2)} m after the slider was lowered`);
  // Water reset replays the rise; a jump applies at once.
  rev.restartFrom(0);
  assert.ok(rev.moving);
  assert.equal(rev.target, 2);
  assert.equal(rev.applied, 0);
  rev.jump(5);
  assert.ok(!rev.moving && rev.applied === 5);
});

test('sim sync: the solver gets stage levels at the APPLIED (ramped) offset; the store keeps the slider target', () => {
  let applied = 0;
  const { store, levels, solver, sync } = makeSync(() => applied);
  const sources = [stage('ohio', 216.4), inflow('creek', 50)];
  levels.resetFrom(sources);
  store.set({ sources, stageOffset: 0 });
  store.set({ stageOffset: 9 });
  assert.ok(Math.abs((store.get().sources[0] as { level: number }).level - 225.4) < 1e-9, 'store: target level');
  assert.ok(Math.abs((solver.sources[0] as { level: number }).level - 216.4) < 1e-9, 'solver: still at the applied stage');
  applied = 4.5;
  sync.pushSources();
  assert.ok(Math.abs((solver.sources[0] as { level: number }).level - 220.9) < 1e-9, 'solver follows the ramp');
  assert.equal((solver.sources[1] as { discharge: number }).discharge, 50);
});

test('stage levels: gauge feet ↔ offset round trip', () => {
  const ctrl = { label: 'x', gaugeDatum: 211.5, normalLevel: 216.4, maxOffset: 14 };
  const off = stageOffsetForFeet(ctrl, 46);
  assert.ok(Math.abs(off - (46 * 0.3048 + 211.5 - 216.4)) < 1e-9);
  assert.ok(Math.abs(feetForStageOffset(ctrl, off) - 46) < 1e-9);
});

// ─── store → solver sync ─────────────────────────────────────────────────────────────────────
class FakeSolver {
  params: SimParams | null = null;
  sources: WaterSource[] = [];
  storms: StormCell[] = [];
  setSources(s: WaterSource[]) {
    this.sources = s;
  }
  setStorms(s: StormCell[]) {
    this.storms = s;
  }
  applyBrush(_op: BrushOp) {}
}

/** `applied` = the stage ramp's offset (undefined: the ramp has arrived, i.e. the slider target). */
function makeSync(applied?: () => number) {
  const store = createStore(createInitialState());
  const levels = new StageLevels();
  const solver = new FakeSolver();
  let routeCalls = 0;
  const sync = new SimSync({
    store,
    stage: levels,
    errors: new ErrorReporter(),
    getSolver: () => solver as unknown as FloodSolver,
    getAppliedStageOffset: () => (applied ? applied() : store.get().stageOffset),
    onRouteInputsChanged: () => routeCalls++,
  });
  sync.install();
  return { store, levels, solver, sync, routeCalls: () => routeCalls };
}

test('sim sync: stage offset rewrites stage levels from the scenario bases and reaches the solver', () => {
  const { store, levels, solver } = makeSync();
  const sources = [stage('ohio', 216.4), inflow('creek', 50)];
  levels.resetFrom(sources);
  store.set({ sources, stageOffset: 0 });
  assert.equal(solver.sources, sources);

  store.set({ stageOffset: 9.12 });
  const lv = (solver.sources[0] as { level: number }).level;
  assert.ok(Math.abs(lv - 225.52) < 1e-9, `level ${lv}`);
  assert.equal(store.get().sources, solver.sources, 'store and solver agree');

  // Dragging the slider back and forth never drifts.
  for (const o of [3, 12, -1, 9.12]) store.set({ stageOffset: o });
  assert.ok(Math.abs((solver.sources[0] as { level: number }).level - 225.52) < 1e-9);
});

test('sim sync: sources added by the UI keep the invariant level = base + offset', () => {
  const { store, levels, solver } = makeSync();
  levels.resetFrom([stage('a', 200)]);
  store.set({ sources: [stage('a', 200)] });
  store.set({ stageOffset: 5 });
  // UI adds a new stage source at the CURRENT level (205 when offset is 5) and an inflow.
  store.set({ sources: [...store.get().sources, stage('new', 305), inflow('i', 10)] });
  store.set({ stageOffset: 0 });
  const byId = Object.fromEntries(solver.sources.map((s) => [s.id, s]));
  assert.equal((byId.a as { level: number }).level, 200);
  assert.equal((byId.new as { level: number }).level, 300);
  assert.equal(solver.sources.length, 3);
});

test('sim sync: params push on identity change and overrides do not leak into the store', () => {
  const { store, solver, sync } = makeSync();
  store.set({ sim: { ...store.get().sim, rainRate: 100 } });
  assert.equal(solver.params?.rainRate, 100);
  sync.setOverrides({ timeScale: 3600 });
  assert.equal(solver.params?.timeScale, 3600);
  assert.equal(store.get().sim.timeScale, 60);
  store.set({ sim: { ...store.get().sim, manningN: 0.05 } });
  assert.equal(solver.params?.timeScale, 3600, 'override survives user param edits');
  sync.setOverrides({});
  assert.equal(solver.params?.timeScale, 60);
  assert.equal(solver.params?.manningN, 0.05);
});

test('sim sync: evac start / shelters changes trigger re-routing', () => {
  const { store, routeCalls } = makeSync();
  store.set({ evacStart: { gx: 1, gy: 2 } });
  store.set({ shelters: [{ name: 's', gx: 3, gy: 4 }] });
  store.set({ paused: true });
  assert.equal(routeCalls(), 2);
});

// ─── URL parsing ─────────────────────────────────────────────────────────────────────────────
test('url: preset default, preset param, live param', () => {
  assert.deepEqual(parseStartupRequest('').request, { kind: 'preset', id: 'pittsburgh' });
  assert.deepEqual(parseStartupRequest('?preset=johnstown').request, { kind: 'preset', id: 'johnstown' });
  const live = parseStartupRequest('?live=40.44,-80.00,5&res=512').request;
  assert.equal(live.kind, 'live');
  if (live.kind === 'live') {
    assert.deepEqual(live.req.center, { lat: 40.44, lon: -80 });
    assert.equal(live.req.sizeMeters, 5000);
    assert.equal(live.req.resolution, 512);
  }
  const clamped = parseStartupRequest('?live=40.44,-80.00,500').request;
  assert.equal(clamped.kind === 'live' && clamped.req.sizeMeters, 20000);
  const bad = parseStartupRequest('?live=abc&preset=ellicott');
  assert.deepEqual(bad.request, { kind: 'preset', id: 'ellicott' });
  assert.equal(bad.warnings.length, 1);
});

// ─── overlays ────────────────────────────────────────────────────────────────────────────────
test('overlays: only report changes, including in-place mutation of tool transients', () => {
  const composer = new OverlayComposer();
  const state: AppState = createInitialState();
  assert.ok(composer.compose(state, null, 0, NO_TRANSIENT), 'first compose always emits');
  assert.equal(composer.compose(state, null, 0, NO_TRANSIENT), null);
  assert.ok(composer.compose(state, null, 1, NO_TRANSIENT), 'road status version bump emits');

  const cursor = { gx: 1, gy: 1, radius: 3, color: [1, 1, 1] as [number, number, number] };
  const transient = { wallPreview: null, cursor };
  assert.ok(composer.compose(state, null, 1, transient));
  assert.equal(composer.compose(state, null, 1, transient), null);
  cursor.gx = 2; // mutated in place by a tool controller
  assert.ok(composer.compose(state, null, 1, transient));

  const pts = new Float32Array([0, 0, 1, 1]);
  const wall = { wallPreview: { pts, height: 2, radius: 1 }, cursor };
  assert.ok(composer.compose(state, null, 1, wall));
  assert.equal(composer.compose(state, null, 1, wall), null);
  pts[2] = 5;
  assert.ok(composer.compose(state, null, 1, wall));

  const route: RouteResult = { state: 'blocked', polyline: null, lengthMeters: 0, etaSeconds: 0, shelter: null, message: 'x' };
  const next = composer.compose({ ...state, route }, null, 1, wall);
  assert.equal(next?.routeState, 'blocked');
  assert.equal(next?.route, null);
  // A blocked result that carries the cut route passes it on (drawn red); 'none' never shows a route.
  const cut = Float32Array.of(1, 2, 3, 4);
  assert.equal(composer.compose({ ...state, route: { ...route, polyline: cut } }, null, 1, wall)?.route, cut);
  assert.equal(composer.compose({ ...state, route: { ...route, state: 'none', polyline: cut } }, null, 1, wall)?.route, null);
});

// ─── runFor ──────────────────────────────────────────────────────────────────────────────────
const snap = (simTime: number): SimSnapshot => ({
  simTime,
  nx: 16,
  ny: 16,
  depth: new Float32Array(256),
  stats: {
    simTime,
    maxDepth: 0,
    maxSpeed: 0,
    volume: 0,
    wetArea: 0,
    floodedArea: 0,
    volumeIn: 0,
    volumeOut: 0,
    massError: 0,
    courant: 0,
  },
});

test('runFor: resolves after the sim time is stepped AND a readback includes it', async () => {
  const sched = new RunForScheduler();
  let done = false;
  const p = sched.start(100, 0).then(() => {
    done = true;
  });
  let clock = 0;
  let now = 0;
  let latest = snap(0);
  for (let f = 0; f < 5; f++) {
    clock += 30;
    now += 16;
    sched.onStep(30, clock, now, latest);
    sched.onFrame(latest, 30, now);
  }
  await Promise.resolve();
  assert.equal(sched.active, true, 'target (120 ≥ 100) reached but readback is stale');
  latest = snap(150);
  sched.onFrame(latest, 0, now + 16);
  await p;
  assert.ok(done);
  assert.equal(sched.active, false);
});

test('runFor: falls back after a grace period when readbacks carry NaN time; times out when stuck', async () => {
  const sched = new RunForScheduler();
  const p = sched.start(10, 0);
  const stale = snap(NaN);
  sched.onStep(20, 20, 10, stale);
  sched.onFrame(stale, 20, 10);
  sched.onFrame(stale, 0, 500);
  assert.equal(sched.active, true, 'same NaN snapshot is not "newer"');
  sched.onFrame(stale, 0, 5000); // > 3 s grace
  await p;

  // A different readback (even with NaN time) completes the run immediately.
  const q = sched.start(10, 0);
  sched.onStep(20, 20, 10, stale);
  sched.onFrame(snap(NaN), 20, 26);
  await q;

  const stuck = sched.start(10, 0);
  sched.onFrame(null, 0, 1e9);
  await assert.rejects(stuck, /timed out/);
  await assert.rejects(sched.start(Number.NaN, 0), /invalid/);
});

// ─── evac ────────────────────────────────────────────────────────────────────────────────────
test('evac: updateFlood is throttled, route recomputed on inputs, store updated only on change', () => {
  const store = createStore(createInitialState());
  let floods = 0;
  let routes = 0;
  let routeLength = 1000;
  const router: EvacuationRouter = {
    setNetwork() {},
    updateFlood() {
      floods++;
      return new Uint8Array(4);
    },
    route(start) {
      routes++;
      return {
        state: start ? 'ok' : 'none',
        polyline: new Float32Array([0, 0, 1, 1]),
        lengthMeters: routeLength,
        etaSeconds: 60,
        shelter: null,
        message: 'via Main St',
      };
    },
  };
  const evac = new EvacController(router, store, new ErrorReporter());
  let routeNotifications = 0;
  store.subscribe((s, prev) => {
    if (s.route !== prev.route) routeNotifications++;
  });

  evac.onSnapshot(snap(1), 1000);
  evac.onSnapshot(snap(2), 1100); // throttled (< 250 ms)
  assert.equal(floods, 1);
  assert.equal(routes, 0, 'no evac start → router.route not called');
  evac.tick(1300); // pending snapshot processed now
  assert.equal(floods, 2);

  store.set({ evacStart: { gx: 3, gy: 3 } });
  evac.recomputeRoute();
  assert.equal(store.get().route?.state, 'ok');
  assert.equal(routeNotifications, 1);
  evac.recomputeRoute(); // identical result → no store churn
  assert.equal(routeNotifications, 1);
  routeLength = 2000;
  evac.recomputeRoute();
  assert.equal(routeNotifications, 2);

  store.set({ evacStart: null });
  evac.recomputeRoute();
  assert.equal(store.get().route, null);
});
