/**
 * The headless batch runner shared by Site check's sweep and the ensemble (src/ui/headless.ts): every case runs its
 * full simulated time, Cancel stops between chunks, a failure stops the batch — and in every case the user's
 * scenario (forcing, stage, Manning n, play state) comes back, the render hold is released, the water is reset, and a
 * second batch cannot start while one runs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/app/store';
import type { AppActions, TerrainData } from '../../src/contracts';
import type { SimControl } from '../../src/ui/bridge';
import { headlessBusy, runHeadless } from '../../src/ui/headless';
import { baseState } from './helpers';

function rig() {
  const store = createStore(
    baseState({
      paused: false,
      stageOffset: 1.5,
      sources: [{ id: 'a', type: 'inflow', gx: 1, gy: 1, radius: 1, discharge: 10 }],
      sim: { ...baseState().sim, rainRate: 5, manningN: 0.035 },
    }),
  );
  let clock = 0;
  let resets = 0;
  const calls: number[] = [];
  const hold: boolean[] = [];
  const sim: SimControl = {
    runFor: async (s) => {
      clock += s; // runFor stops on its target, like the real one (src/app/runFor.ts)
      calls.push(s);
    },
    simClock: () => clock,
    setRenderHold: (on) => hold.push(on),
  };
  const actions = { resetWater: () => ((clock = 0), resets++) } as unknown as AppActions;
  const terrain = {} as TerrainData;
  return { store, sim, actions, terrain, hold, calls, resets: () => resets };
}

const scenario = (s: ReturnType<typeof createStore>) => {
  const v = s.get();
  return JSON.stringify([v.stageOffset, v.sources, v.storms, v.sim.rainRate, v.sim.manningN, v.paused]);
};

test('runs every case its full time, then restores the scenario', async () => {
  const r = rig();
  const before = scenario(r.store);
  const collected: Array<{ i: number; t: number; n: number }> = [];
  let cleaned = 0;
  const out = await runHeadless({
    ...r,
    getTerrain: () => r.terrain,
    cases: [0.5, 2].map((k) => ({ k, apply: () => r.store.set({ stageOffset: k, sim: { ...r.store.get().sim, manningN: 0.05 } }) })),
    durationS: 900,
    chunkS: 300,
    cancelled: () => false,
    collect: async (i, c) => {
      collected.push({ i, t: r.sim.simClock(), n: r.store.get().sim.manningN });
      assert.equal(r.store.get().stageOffset, c.k, 'the case’s forcing is in force while it runs');
      assert.equal(r.store.get().paused, true);
    },
    cleanup: () => cleaned++,
  });
  assert.deepEqual([out.done, out.cancelled, out.error], [2, false, null]);
  assert.ok(collected.every((c) => c.t === 900 && c.n === 0.05), JSON.stringify(collected));
  assert.deepEqual(r.calls, [300, 300, 300, 300, 300, 300], 'each case: three chunks, no extra one');
  assert.equal(cleaned, 1);
  assert.equal(scenario(r.store), before, 'scenario restored');
  assert.deepEqual(r.hold, [true, false]);
  assert.equal(r.resets(), 3, 'one reset per case and one to restore');
  assert.equal(headlessBusy(r.store), false);
});

test('cancel and failure both stop early and still restore; a second batch is refused while one runs', async () => {
  const r = rig();
  const before = scenario(r.store);
  let stop = false;
  const p = runHeadless({
    ...r,
    getTerrain: () => r.terrain,
    cases: [1, 2, 3].map((k) => ({ apply: () => r.store.set({ stageOffset: k }) })),
    durationS: 900,
    chunkS: 300,
    cancelled: () => stop,
    afterChunk: (i) => {
      if (i === 1) stop = true;
    },
    collect: async () => {},
  });
  assert.equal(headlessBusy(r.store), true);
  const refused = await runHeadless({ ...r, getTerrain: () => r.terrain, cases: [{ apply: () => {} }], durationS: 60, chunkS: 60, cancelled: () => false, collect: async () => {} });
  assert.match(refused.error ?? '', /in progress/);
  const out = await p;
  assert.deepEqual([out.done, out.cancelled], [1, true]);
  assert.equal(scenario(r.store), before);

  const r2 = rig();
  const out2 = await runHeadless({
    ...r2,
    getTerrain: () => r2.terrain,
    cases: [{ apply: () => r2.store.set({ sources: [] }) }],
    durationS: 600,
    chunkS: 300,
    cancelled: () => false,
    collect: async () => {
      throw new Error('no flood readback');
    },
  });
  assert.equal(out2.error, 'no flood readback');
  assert.equal(r2.store.get().sources.length, 1, 'sources restored after a failure');
  assert.deepEqual(r2.hold, [true, false]);
});
