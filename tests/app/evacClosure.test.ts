/**
 * The "last safe route" moment: EvacController watches the evacuation route across simulated time and, when a start
 * that had a way out loses its last one, publishes when that happened and what the route was (RouteResult.closure).
 * The router cannot do this — it is handed one flood field at a time — and on a flat coast, where the water arrives
 * everywhere at once and there is no detour to re-plan onto, that moment is the only honest thing left to say.
 * Run: node --import tsx --test tests/app/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvacuationRouter, RouteResult, SimSnapshot } from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { ErrorReporter } from '../../src/app/errors';
import { EvacController } from '../../src/app/evac';
import { createStore } from '../../src/app/store';

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
    courant: 0.2,
  },
});

/** A router whose answer the test sets: 'ok' with a length/shelter, or 'blocked' with a reason. */
function fakeRouter() {
  const state = {
    answer: 'ok' as 'ok' | 'blocked' | 'none',
    lengthMeters: 3800,
    etaSeconds: 480,
    shelterName: 'Veronica S. Shoemaker Boulevard',
  };
  const router: EvacuationRouter = {
    setNetwork() {},
    updateFlood() {
      return new Uint8Array(4);
    },
    route(start): RouteResult {
      if (!start || state.answer === 'none') {
        return { state: 'none', polyline: null, lengthMeters: 0, etaSeconds: 0, shelter: null, message: 'no start' };
      }
      if (state.answer === 'blocked') {
        return {
          state: 'blocked',
          polyline: null,
          lengthMeters: 0,
          etaSeconds: 0,
          shelter: null,
          message: 'No safe route — all roads to shelters are flooded.',
          reason: 'cut-off',
          diagnosis: { startDepth: 0, shelters: 4, dryShelters: 4, startRoads: 6, startRoadsUsable: 6, cutRoute: null },
        };
      }
      return {
        state: 'ok',
        polyline: new Float32Array([0, 0, 1, 1]),
        lengthMeters: state.lengthMeters,
        etaSeconds: state.etaSeconds,
        shelter: { name: state.shelterName, gx: 9, gy: 9 },
        message: `Via Palmetto Ave to ${state.shelterName}`,
      };
    },
  };
  return { router, state };
}

test('evac: the moment the last route closes is published with the route that was cut', () => {
  const store = createStore(createInitialState());
  const { router, state } = fakeRouter();
  const evac = new EvacController(router, store, new ErrorReporter());
  const start = { gx: 3, gy: 3 };
  store.set({ evacStart: start });

  // A route exists at T+30 and re-plans at T+120; neither is a closure.
  evac.onSnapshot(snap(30), 1000);
  assert.equal(store.get().route?.state, 'ok');
  assert.equal(store.get().route?.closure ?? null, null, 'a route that exists carries no closure');
  state.lengthMeters = 4500;
  state.shelterName = 'Canal Street — east Fort Myers';
  evac.onSnapshot(snap(120), 2000);
  assert.equal(store.get().route?.lengthMeters, 4500);
  assert.equal(store.get().route?.closure ?? null, null);

  // At T+300 the last road goes: the closure names the moment, how long the start had a way out, and the route lost.
  state.answer = 'blocked';
  evac.onSnapshot(snap(300), 3000);
  const blocked = store.get().route!;
  assert.equal(blocked.state, 'blocked');
  assert.deepEqual(blocked.closure, {
    simTime: 300,
    openSeconds: 270,
    lengthMeters: 4500,
    etaSeconds: 480,
    shelterName: 'Canal Street — east Fort Myers',
  });

  // It keeps saying the same thing as the water goes on rising — the moment does not drift.
  evac.onSnapshot(snap(600), 4000);
  assert.equal(store.get().route?.closure?.simTime, 300);
  assert.equal(store.get().route?.closure?.lengthMeters, 4500);

  // A route that comes back (a levee, or the water falling) clears it; losing it again dates the new closure.
  state.answer = 'ok';
  evac.onSnapshot(snap(900), 5000);
  assert.equal(store.get().route?.state, 'ok');
  assert.equal(store.get().route?.closure ?? null, null);
  state.answer = 'blocked';
  evac.onSnapshot(snap(1200), 6000);
  assert.equal(store.get().route?.closure?.simTime, 1200);
  assert.equal(store.get().route?.closure?.openSeconds, 300, 'timed from the route that came back, not the first one');
});

test('evac: a start that never had a route gets no closure, and moving the pin forgets the previous one', () => {
  const store = createStore(createInitialState());
  const { router, state } = fakeRouter();
  const evac = new EvacController(router, store, new ErrorReporter());

  // Blocked from the first plan: there is no "last route", so nothing is claimed about warning time.
  state.answer = 'blocked';
  store.set({ evacStart: { gx: 3, gy: 3 } });
  evac.onSnapshot(snap(60), 1000);
  assert.equal(store.get().route?.state, 'blocked');
  assert.equal(store.get().route?.closure ?? null, null);

  // A start that has a route, then loses it.
  state.answer = 'ok';
  store.set({ evacStart: { gx: 4, gy: 4 } });
  evac.onSnapshot(snap(120), 2000);
  state.answer = 'blocked';
  evac.onSnapshot(snap(180), 3000);
  assert.equal(store.get().route?.closure?.simTime, 180);

  // Dropping the pin somewhere new is a new plan, not the old one's ending.
  store.set({ evacStart: { gx: 5, gy: 5 } });
  evac.recomputeRoute();
  assert.equal(store.get().route?.state, 'blocked');
  assert.equal(store.get().route?.closure ?? null, null, 'the previous start’s closure is not reused');

  // Editing the shelter list is also a new plan.
  state.answer = 'ok';
  evac.onSnapshot(snap(240), 4000);
  state.answer = 'blocked';
  evac.onSnapshot(snap(300), 5000);
  assert.equal(store.get().route?.closure?.simTime, 300);
  store.set({ shelters: [{ name: 'New shelter', gx: 1, gy: 1 }] });
  evac.recomputeRoute();
  assert.equal(store.get().route?.closure ?? null, null);

  // Clearing the start clears the route.
  store.set({ evacStart: null });
  evac.recomputeRoute();
  assert.equal(store.get().route, null);
});

test('evac: resetting the water re-anchors how long the route was open instead of reporting a negative', () => {
  const store = createStore(createInitialState());
  const { router, state } = fakeRouter();
  const evac = new EvacController(router, store, new ErrorReporter());
  store.set({ evacStart: { gx: 3, gy: 3 } });
  evac.onSnapshot(snap(900), 1000); // a route, late in a long run
  // Reset Water: the sim clock goes back to zero with the same start point in place.
  evac.onSnapshot(snap(5), 2000);
  state.answer = 'blocked';
  evac.onSnapshot(snap(65), 3000);
  const c = store.get().route!.closure!;
  assert.equal(c.simTime, 65);
  assert.ok(c.openSeconds >= 0 && c.openSeconds <= 65, `openSeconds ${c.openSeconds} stays inside the new run`);
});

test('evac: a blocked card keeps up with the water without rebuilding itself at every readback', () => {
  const store = createStore(createInitialState());
  let cutLength = 6200;
  let floodedMeters = 1300;
  const router: EvacuationRouter = {
    setNetwork() {},
    updateFlood: () => new Uint8Array(4),
    route: (): RouteResult => ({
      state: 'blocked',
      polyline: null,
      lengthMeters: 0,
      etaSeconds: 0,
      shelter: null,
      message: 'No safe route — all roads to shelters are flooded.',
      reason: 'cut-off',
      diagnosis: {
        startDepth: 0,
        shelters: 4,
        dryShelters: 4,
        startRoads: 6,
        startRoadsUsable: 6,
        cutRoute: { lengthMeters: cutLength, etaSeconds: 440, shelterName: 'Canal Street', floodedMeters },
      },
    }),
  };
  const evac = new EvacController(router, store, new ErrorReporter());
  let updates = 0;
  store.subscribe((s, prev) => {
    if (s.route !== prev.route) updates++;
  });
  store.set({ evacStart: { gx: 3, gy: 3 } });
  evac.onSnapshot(snap(10), 1000);
  assert.equal(updates, 1);

  // The sentence never changes while blocked, so only the numbers can drive an update — and only in 100 m steps.
  floodedMeters = 1320;
  evac.onSnapshot(snap(20), 2000);
  assert.equal(updates, 1, '20 m more flooded road is not a new card');
  floodedMeters = 1700;
  evac.onSnapshot(snap(30), 3000);
  assert.equal(updates, 2, 'a 400 m change is');
  assert.equal(store.get().route?.diagnosis?.cutRoute?.floodedMeters, 1700);
});
