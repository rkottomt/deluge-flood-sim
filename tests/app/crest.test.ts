/**
 * Unit tests for the river crest fill (src/app/crest.ts) and the device-lost auto-reload guard (no GPU, no DOM).
 * Run: node --import tsx --test tests/app/*.test.ts
 */
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { FloodSolver, SimSnapshot, WaterSource } from '../../src/contracts';
import { channelBaseSurface, CrestFill, raisedInitialDepth } from '../../src/app/crest';
import { createInitialState } from '../../src/app/defaults';
import { ErrorReporter } from '../../src/app/errors';
import { createStore } from '../../src/app/store';
import { AUTO_RELOAD_GUARD_MS, AUTO_RELOAD_MAX, AUTO_RELOAD_WINDOW_MS, claimAutoReload } from '../../src/app/unsupported';

/*
 * 8×4 test valley (cell size 10 m). Row-major, j = 0 is the top row.
 *   river: row 1, columns 0–6 (depth 2, bed 100) — the stage source sits on its left end;
 *   pond:  (7, 3) (depth 1, bed 101), not connected to the river;
 *   every other cell is dry land (bed 103).
 */
const NX = 8;
const NY = 4;
const idx = (i: number, j: number) => j * NX + i;
function valley() {
  const ground = new Float32Array(NX * NY).fill(103);
  const initial = new Float32Array(NX * NY);
  for (let i = 0; i <= 6; i++) {
    ground[idx(i, 1)] = 100;
    initial[idx(i, 1)] = 2;
  }
  ground[idx(7, 3)] = 101;
  initial[idx(7, 3)] = 1;
  return { ground, initial };
}
const stageSource: WaterSource = { id: 'river', type: 'stage', gx: 0.5, gy: 1.5, radius: 0.75, level: 102 };

class FakeSolver {
  readonly nx = NX;
  readonly ny = NY;
  readonly cellSize = 10;
  readonly barrier = new Float32Array(NX * NY);
  snapshot: SimSnapshot | null = null;
  initialWaterCalls: Float32Array[] = [];
  resets: Array<{ resetTerrain?: boolean } | undefined> = [];
  constructor(readonly ground: Float32Array) {}
  getGroundCPU() {
    return this.ground;
  }
  getBarrierCPU() {
    return this.barrier;
  }
  getSnapshot() {
    return this.snapshot;
  }
  setInitialWater(depth: Float32Array) {
    this.initialWaterCalls.push(Float32Array.from(depth));
    this.snapshot = null; // a reset drops the readback
  }
  reset(opts?: { resetTerrain?: boolean }) {
    this.resets.push(opts);
  }
  setStats(floodedArea: number, volume: number) {
    this.snapshot = { simTime: 60, nx: NX, ny: NY, depth: new Float32Array(NX * NY), stats: { simTime: 60, maxDepth: 2, maxSpeed: 0, volume, wetArea: 0, floodedArea, volumeIn: 0, volumeOut: 0, massError: 0, courant: 0 } };
  }
}

class InPlaceSolver extends FakeSolver {
  /** Target surfaces (base + offset) of every raise. */
  raises: Float32Array[] = [];
  bases = new Set<Float32Array>();
  raiseWaterSurface(base: Float32Array, offset = 0) {
    this.bases.add(base);
    this.raises.push(base.map((v) => v + offset));
  }
}

function setup(solver: FakeSolver, initial: Float32Array) {
  const store = createStore(createInitialState());
  store.set({ loading: null, sources: [stageSource] });
  let waterResets = 0;
  const crest = new CrestFill({
    store,
    errors: new ErrorReporter(),
    getScene: () => ({ solver: solver as unknown as FloodSolver, initialWater: initial }),
    getStageOffset: () => store.get().stageOffset,
    onWaterReset: () => waterResets++,
  });
  const setOffset = (o: number, now: number) => {
    store.set({ stageOffset: o });
    crest.onStageOffset(o, now);
  };
  return { store, crest, setOffset, waterResets: () => waterResets };
}

/** Volume of the scenario's initial fill in the fake valley (m³). */
const initialVolume = (initial: Float32Array) => initial.reduce((a, b) => a + b, 0) * 100;

test('crest: channel = initial wet cells connected to a stage source; base surface = bed + depth', () => {
  const { ground, initial } = valley();
  const base = channelBaseSurface(initial, (c) => ground[c], NX, NY, [stageSource]);
  assert.ok(base);
  for (let i = 0; i <= 6; i++) assert.equal(base[idx(i, 1)], 102, `river cell ${i}`);
  assert.ok(Number.isNaN(base[idx(7, 3)]), 'the unconnected pond is not channel');
  assert.ok(Number.isNaN(base[idx(3, 0)]), 'dry land is not channel');
  assert.equal(channelBaseSurface(initial, (c) => ground[c], NX, NY, []), null, 'no stage source → no channel');

  const raised = raisedInitialDepth(initial, base, (c) => ground[c], 1.5);
  assert.equal(raised[idx(3, 1)], 3.5, 'river raised by the offset');
  assert.equal(raised[idx(7, 3)], 1, 'pond untouched');
  assert.equal(raised[idx(3, 0)], 0, 'banks stay dry (overbank flow does the flooding)');
});

test('crest: a raise before anything happened restarts the water with the channel at the new stage', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ground, initial } = valley();
    const solver = new FakeSolver(ground);
    const { crest, setOffset, waterResets } = setup(solver, initial);
    solver.setStats(0, initialVolume(initial));

    setOffset(3, 1000); // one-click jump to the crest
    assert.equal(solver.initialWaterCalls.length, 1);
    assert.equal(solver.initialWaterCalls[0][idx(2, 1)], 5);
    assert.equal(solver.initialWaterCalls[0][idx(7, 3)], 1);
    assert.equal(waterResets(), 1);
    mock.timers.tick(400);
    assert.equal(solver.initialWaterCalls.length, 1, 'no second restart for a single jump');

    // R at the crest: the scenario start at the current stage (already installed → a plain reset).
    crest.resetWater();
    assert.equal(solver.initialWaterCalls.length, 1);
    assert.equal(solver.resets.length, 1);

    // Back to normal pool, then R: the original fill comes back.
    setOffset(0, 5000);
    crest.resetWater();
    assert.equal(solver.initialWaterCalls.length, 2);
    assert.deepEqual([...solver.initialWaterCalls[1]], [...initial]);
  } finally {
    mock.timers.reset();
  }
});

test('crest: a slider drag restarts once at its start and once at its final level', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ground, initial } = valley();
    const solver = new FakeSolver(ground);
    const { setOffset } = setup(solver, initial);
    solver.setStats(0, initialVolume(initial));
    setOffset(0.5, 1000);
    // During the drag the (restarted) water starts changing: the gesture's pristine verdict still holds.
    solver.setStats(90_000, initialVolume(initial) * 1.5);
    for (let k = 1; k <= 8; k++) {
      setOffset(0.5 + k * 0.25, 1000 + k * 50);
      mock.timers.tick(50);
    }
    assert.equal(solver.initialWaterCalls.length, 1, 'no restart per drag event');
    mock.timers.tick(300);
    assert.equal(solver.initialWaterCalls.length, 2, 'final restart after the drag settles');
    assert.equal(solver.initialWaterCalls[1][idx(4, 1)], 4.5);
  } finally {
    mock.timers.reset();
  }
});

test('crest: once the flood is under way a raise never restarts the water (the boundaries carry it)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ground, initial } = valley();
    const solver = new FakeSolver(ground);
    const { setOffset, waterResets } = setup(solver, initial);
    solver.setStats(250_000, initialVolume(initial) * 3); // flooded land
    setOffset(3, 1000);
    mock.timers.tick(1000);
    solver.setStats(0, initialVolume(initial) * 1.2); // rain: +20 % volume, no flooded land yet
    setOffset(4, 5000);
    mock.timers.tick(1000);
    assert.equal(solver.initialWaterCalls.length, 0);
    assert.equal(waterResets(), 0);
  } finally {
    mock.timers.reset();
  }
});

test('crest: with an in-place solver op every raise lifts the channel, and R re-applies the applied stage', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { ground, initial } = valley();
    const solver = new InPlaceSolver(ground);
    const { store, crest, setOffset } = setup(solver, initial);
    solver.setStats(250_000, initialVolume(initial) * 3); // mid-flood is fine in place
    setOffset(1, 1000);
    assert.equal(solver.raises.length, 1);
    assert.equal(solver.raises[0][idx(5, 1)], 103);
    assert.ok(Number.isNaN(solver.raises[0][idx(7, 3)]) && Number.isNaN(solver.raises[0][idx(0, 0)]));
    setOffset(2, 1030); // the stage ramp paces raises (a few cm per step): every call lifts at once
    assert.equal(solver.raises.length, 2);
    assert.equal(solver.raises[1][idx(5, 1)], 104);
    assert.equal(solver.bases.size, 1, 'one base array for the scene: uploaded once, then only the offset changes');
    mock.timers.tick(1000);
    assert.equal(solver.raises.length, 2, 'no trailing raise');
    setOffset(1.5, 2000); // lowering: nothing to do in place
    assert.equal(solver.raises.length, 2);
    assert.equal(solver.initialWaterCalls.length, 0, 'in place never restarts');

    crest.resetWater({ resetTerrain: true });
    assert.deepEqual(solver.resets, [{ resetTerrain: true }]);
    assert.equal(solver.raises.length, 3);
    assert.equal(solver.raises[2][idx(5, 1)], 102 + store.get().stageOffset);
  } finally {
    mock.timers.reset();
  }
});

test('crest: a non-robust solver and loading states are left alone', () => {
  const { ground, initial } = valley();
  const solver = new FakeSolver(ground);
  const { store, setOffset } = setup(solver, initial);
  solver.setStats(0, initialVolume(initial));
  store.set({ sim: { ...store.get().sim, stabilityMode: 'naive' } });
  setOffset(3, 1000);
  store.set({ sim: { ...store.get().sim, stabilityMode: 'robust' }, loading: { message: 'x', progress: 0 } });
  setOffset(4, 5000);
  assert.equal(solver.initialWaterCalls.length, 0);
});

test('device lost: the page reloads itself at most once per guard window', () => {
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(claimAutoReload(storage, 1_000_000), 'reload');
  assert.equal(claimAutoReload(storage, 1_000_000 + 5_000), 'manual', 'lost again right after the reload → wait for the user');
  assert.equal(claimAutoReload(null, 0), 'manual', 'no storage → no auto reload (a loop could not be detected)');
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => {} };
  assert.equal(claimAutoReload(throwing, 0), 'manual');
  // Older builds stored a single timestamp.
  const old = new Map<string, string>([['deluge:gpu-lost-reload-at', '1000000']]);
  const oldStorage = { getItem: (k: string) => old.get(k) ?? null, setItem: (k: string, v: string) => void old.set(k, v) };
  assert.equal(claimAutoReload(oldStorage, 1_030_000), 'manual', 'a legacy timestamp still guards');
});

test('device lost: losses more than a minute apart cannot loop (at most 2 automatic reloads per 10 minutes)', () => {
  const t0 = 5_000_000;
  const step = AUTO_RELOAD_GUARD_MS + 1_000; // each loss 61 s after the previous reload (the t10 loop)
  const run = (lighterAvailable: boolean) => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    return [0, 1, 2, 3].map((k) => claimAutoReload(storage, t0 + k * step, lighterAvailable));
  };
  // The scene on screen is already the offline default (or as light as it): reloading it again repeats the loss.
  assert.deepEqual(run(false), ['reload', 'manual', 'manual', 'manual']);
  // A live area / large grid: the second automatic reload switches to the offline default preset, then the user decides.
  assert.deepEqual(run(true), ['reload', 'lighter', 'manual', 'manual']);
  // The window slides: a loss long after the last automatic reloads is a new, one-off event again.
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
  assert.equal(claimAutoReload(storage, t0, true), 'reload');
  assert.equal(claimAutoReload(storage, t0 + step, true), 'lighter');
  assert.equal(claimAutoReload(storage, t0 + 2 * step, true), 'manual');
  assert.equal(claimAutoReload(storage, t0 + step + AUTO_RELOAD_WINDOW_MS, true), 'reload');
  assert.equal(AUTO_RELOAD_MAX, 2);
});
