/**
 * Unit tests for the app's power/performance controllers (no GPU, no DOM):
 *   SubstepGovernor / WorkBudget (frame-time + GPU-latency AIMD work budget) · RenderPacer (idle render pacing) ·
 *   SimSync override layers.
 * Run: node --import tsx --test tests/app/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CameraPose, FloodSolver, SimParams, StepInfo } from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { ErrorReporter } from '../../src/app/errors';
import { FrameCeiling } from '../../src/app/frameCeiling';
import { SubstepGovernor, WorkBudget } from '../../src/app/governor';
import { AdaptiveQuality } from '../../src/render/quality';
import { RenderPacer } from '../../src/app/pacer';
import { SimSync } from '../../src/app/simSync';
import { StageLevels } from '../../src/app/stage';
import { createStore } from '../../src/app/store';

/** A toy GPU: frame time = base render cost + per-substep cost (vsync-quantized), the sim wants `demand` substeps. */
function simulate(
  gov: { cap: number; observe(frameMs: number, info: StepInfo, now: number, maxCap: number): boolean },
  frames: number,
  opts: { baseMs: number; perSubstepMs: number; demand: number; t0?: number; hitchEvery?: number; smooth?: boolean },
) {
  let now = opts.t0 ?? 0;
  const history: number[] = [];
  const intervals: number[] = [];
  for (let f = 0; f < frames; f++) {
    const n = Math.min(gov.cap, opts.demand);
    const info: StepInfo = { simSecondsAdvanced: n * 0.2, substeps: n, dt: 0.2, throttled: opts.demand > gov.cap };
    let work = opts.baseMs + n * opts.perSubstepMs;
    if (opts.hitchEvery && f % opts.hitchEvery === 0) work += 30; // e.g. a readback / GC pause
    // Strict vsync quantization, or (smooth) the average pacing a compositor achieves by mixing 1- and 2-vsync frames.
    const frameMs = opts.smooth ? Math.max(16.667, work) : Math.ceil(work / 16.667 - 1e-9) * 16.667;
    now += frameMs;
    gov.observe(frameMs, info, now, 120);
    history.push(gov.cap);
    intervals.push(frameMs);
  }
  return { now, history, intervals };
}

const interactive = () => new SubstepGovernor({ targetMs: 20, latencyMs: 1000, band: 0.1, minCap: 1, initialCap: 4, windowMs: 300, windowFrames: 10, warmupFrames: 8 });

test('governor: grows the cap while frames are fast and the cap limits the sim', () => {
  const gov = interactive();
  const { history } = simulate(gov, 600, { baseMs: 6, perSubstepMs: 0.5, demand: 12 });
  assert.equal(gov.cap, 12, `cap ${gov.cap}`);
  assert.ok(history.every((c) => c <= 12));
});

test('governor: isolated hitches do not cost throughput', () => {
  const gov = interactive();
  simulate(gov, 1200, { baseMs: 6, perSubstepMs: 0.5, demand: 12, hitchEvery: 20 });
  assert.equal(gov.cap, 12, `cap ${gov.cap}`);
});

test('governor: does not grow when something else throttles the solver', () => {
  const gov = interactive();
  let now = 0;
  for (let f = 0; f < 600; f++) {
    now += 16.667;
    // Solver reports throttled but ran fewer substeps than our cap (its own budget binds).
    gov.observe(16.667, { simSecondsAdvanced: 0.2, substeps: 1, dt: 0.2, throttled: true }, now, 120);
  }
  assert.equal(gov.cap, 4);
});

test('governor: backs off under load and settles within the frame budget without sawtoothing', () => {
  const gov = interactive();
  // 10 ms render + 1.2 ms/substep, sim wants 60 substeps: only 5 fit in a 16.7 ms frame.
  const { history, intervals } = simulate(gov, 3600, { baseMs: 10, perSubstepMs: 1.2, demand: 60 });
  const tail = history.slice(-1800);
  assert.ok(Math.max(...tail) <= 6, `settled cap ${Math.max(...tail)} exceeds the frame budget`);
  assert.ok(Math.min(...tail) >= 3, `cap collapsed to ${Math.min(...tail)}`);
  let drops = 0;
  for (let k = 1; k < tail.length; k++) if (tail[k] < tail[k - 1]) drops++;
  assert.ok(drops <= 5, `${drops} decreases in 30 s`);
  const slow = intervals.slice(-1800).filter((ms) => ms > 17).length;
  assert.ok(slow / 1800 < 0.05, `${((slow / 1800) * 100).toFixed(1)} % dropped frames once settled`);
});

test('governor: thermal slowdown lowers the cap; never exceeds the user cap', () => {
  const gov = interactive();
  const cool = simulate(gov, 1200, { baseMs: 5, perSubstepMs: 0.8, demand: 40 });
  const coolCap = gov.cap;
  simulate(gov, 1200, { baseMs: 8, perSubstepMs: 2.4, demand: 40, t0: cool.now }); // GPU at 1/3 speed
  assert.ok(gov.cap < coolCap, `hot cap ${gov.cap} should be < cool cap ${coolCap}`);
  assert.ok(gov.cap >= 1);

  const capped = interactive();
  let now = 0;
  for (let f = 0; f < 2000; f++) {
    now += 16.667;
    capped.observe(16.667, { simSecondsAdvanced: 1, substeps: capped.cap, dt: 0.1, throttled: true }, now, 9);
  }
  assert.equal(capped.cap, 9);
  capped.observe(16.667, { simSecondsAdvanced: 1, substeps: 9, dt: 0.1, throttled: true }, now + 17, 4);
  assert.equal(capped.cap, 4);
});

/**
 * A GPU with a real queue: each vsync (16.7 ms) it drains 16.7 ms of work; requestAnimationFrame only fires while
 * fewer than 3 frames are queued (like Chrome). A frame's latency is the queued work ahead of it plus its own.
 */
function simulateQueue(budget: WorkBudget, frames: number, opts: { baseMs: number; perSubstepMs: number; demand: number }) {
  const VSYNC = 16.667;
  let backlog = 0;
  let now = 0;
  const latencies: number[] = [];
  for (let f = 0; f < frames; f++) {
    let frameMs = VSYNC;
    now += VSYNC;
    backlog = Math.max(0, backlog - VSYNC);
    while (backlog > 2 * VSYNC) {
      now += VSYNC;
      frameMs += VSYNC;
      backlog = Math.max(0, backlog - VSYNC);
    }
    const n = Math.min(budget.cap, opts.demand);
    const work = opts.baseMs + n * opts.perSubstepMs;
    const latency = backlog + work;
    backlog += work;
    budget.observe(frameMs, { simSecondsAdvanced: n * 0.2, substeps: n, dt: 0.2, throttled: opts.demand > n }, now, 120);
    budget.noteLatency(latency);
    latencies.push(latency);
  }
  return latencies;
}

test('work budget: GPU latency keeps the queue drained while rAF still looks like 60 fps', () => {
  const budget = new WorkBudget();
  // 10 ms render + 1.5 ms/substep: 4 substeps fit a vsync; 5+ silently queue up (latency grows, rAF stays ~60).
  const load = { baseMs: 10, perSubstepMs: 1.5, demand: 60 };
  budget.setMode('interactive');
  const lat = simulateQueue(budget, 3600, load).slice(-1200);
  const sorted = [...lat].sort((a, b) => a - b);
  const p50 = sorted[sorted.length >> 1];
  assert.ok(p50 <= 28 * 1.1, `interactive median latency ${p50.toFixed(1)} ms`);
  const interactiveCap = budget.cap;
  assert.ok(interactiveCap >= 3 && interactiveCap <= 5, `interactive cap ${interactiveCap}`);

  budget.setMode('watching');
  simulateQueue(budget, 3600, load);
  const watchingCap = budget.cap;
  budget.setMode('automation');
  simulateQueue(budget, 3600, load);
  const automationCap = budget.cap;
  assert.ok(interactiveCap <= watchingCap && watchingCap <= automationCap, `${interactiveCap} ≤ ${watchingCap} ≤ ${automationCap}`);

  // Switching back applies the learned interactive cap immediately (no re-convergence stutter).
  budget.setMode('interactive');
  assert.equal(budget.cap, interactiveCap);
  assert.equal(budget.capFor('watching'), watchingCap);
});

test('work budget: frame time alone would not have caught the backlog', () => {
  // Same load, latency target disabled: the cap climbs far past what the GPU can drain.
  const blind = new SubstepGovernor({ targetMs: 18.5, latencyMs: 1e9, band: 0.05, minCap: 1, initialCap: 2, windowMs: 300, windowFrames: 10, warmupFrames: 8 });
  const wrapper = new WorkBudget();
  (wrapper as unknown as { governors: Record<string, SubstepGovernor> }).governors.watching = blind;
  const lat = simulateQueue(wrapper, 3600, { baseMs: 10, perSubstepMs: 1.5, demand: 60 }).slice(-600);
  const mean = lat.reduce((a, b) => a + b, 0) / lat.length;
  assert.ok(mean > 40, `without the latency signal the queue backs up (mean latency ${mean.toFixed(1)} ms)`);
});

const pose = (yaw: number): CameraPose => ({ target: { gx: 1, gy: 2, elevation: 3 }, distance: 100, yaw, pitch: 0.5 });

test('pacer: busy frames always render; idle frames drop to a heartbeat with a frozen clock', () => {
  const pacer = new RenderPacer();
  let now = 0;
  const p = pose(0);
  let renders = 0;
  // 1 s busy at 60 fps
  for (let f = 0; f < 60; f++) {
    now += 16.667;
    const d = pacer.decide(now, true, false, p);
    assert.ok(d.render && d.active);
    pacer.rendered(now, 1 / 60, d.active, p);
  }
  assert.ok(Math.abs(pacer.animTime - 1) < 1e-6);
  // 10 s idle (paused, no input): after the hold period only ~4 Hz
  const frozenAt = { time: 0 };
  for (let f = 0; f < 600; f++) {
    now += 16.667;
    const d = pacer.decide(now, false, false, p);
    if (d.render) {
      renders++;
      pacer.rendered(now, 1 / 60, d.active, p);
    }
    if (f === 120) frozenAt.time = pacer.animTime;
  }
  assert.ok(renders < 72 + 45, `${renders} renders in 10 s idle`);
  assert.equal(pacer.animTime, frozenAt.time, 'animation clock frozen while idle');

  // Input → full rate again
  pacer.poke(now);
  now += 16.667;
  const d = pacer.decide(now, false, false, p);
  assert.ok(d.render && d.active);
});

test('pacer: camera motion (external or damping inside render) keeps full rate; hidden renders nothing', () => {
  const pacer = new RenderPacer();
  let now = 0;
  let p = pose(0);
  pacer.decide(now, false, false, p);
  pacer.rendered(now, 0, false, p);
  now += 5000; // long idle
  let d = pacer.decide(now, false, false, p);
  assert.equal(d.active, false);
  // Camera eased by the renderer during render → still active next frame.
  p = pose(0.1);
  pacer.rendered(now, 1 / 60, d.active, p);
  now += 16.667;
  d = pacer.decide(now, false, false, p);
  assert.ok(d.active && d.render);
  assert.deepEqual(pacer.decide(now + 1, true, true, p), { render: false, active: false });
});

test('sim sync: override layers — timeScale replaces, substep caps only lower the user cap', () => {
  const store = createStore(createInitialState());
  const solver = { params: null as SimParams | null, setSources() {}, setStorms() {} };
  const sync = new SimSync({
    store,
    stage: new StageLevels(),
    errors: new ErrorReporter(),
    getSolver: () => solver as unknown as FloodSolver,
    onRouteInputsChanged: () => {},
  });
  sync.install();
  sync.setOverride('governor', { maxSubstepsPerFrame: 8 });
  assert.equal(solver.params?.maxSubstepsPerFrame, 8);
  sync.setOverride('runFor', { timeScale: 3600 });
  assert.equal(solver.params?.timeScale, 3600);
  assert.equal(solver.params?.maxSubstepsPerFrame, 8);
  store.set({ sim: { ...store.get().sim, maxSubstepsPerFrame: 4 } });
  assert.equal(solver.params?.maxSubstepsPerFrame, 4, 'user cap below governor cap wins');
  sync.setOverride('governor', { maxSubstepsPerFrame: 300 });
  assert.equal(solver.params?.maxSubstepsPerFrame, 4, 'a layer can never raise the user cap');
  sync.setOverride('runFor', null);
  assert.equal(solver.params?.timeScale, 60);
  assert.equal(store.get().sim.timeScale, 60, 'overrides never leak into the store');
});

test('frame ceiling: a 30 fps browser cap with light work is learned; our own overload is not; lifting clears it', () => {
  const c = new FrameCeiling();
  // Energy Saver: every rAF 33.3 ms apart, frame work ~6 ms.
  for (let f = 0; f < 90; f++) c.sample(33.3 + (f % 3) * 0.05, 6);
  assert.ok(Math.abs(c.floorMs - 33.3) < 0.2, `floor ${c.floorMs}`);
  // Work grows to use the headroom (hysteresis: the ceiling stays).
  for (let f = 0; f < 90; f++) c.sample(33.3, 24);
  assert.ok(c.floorMs > 33);
  // Charger plugged in: 60 Hz frames again.
  for (let f = 0; f < 45; f++) c.sample(16.7, 10);
  assert.equal(c.floorMs, 0);
  // 60 Hz display where OUR work makes every frame miss vsync: not an external ceiling.
  const d = new FrameCeiling();
  for (let f = 0; f < 180; f++) d.sample(33.3, 22);
  assert.equal(d.floorMs, 0);
  // A mix of 1- and 2-vsync frames is never uniformly slow.
  for (let f = 0; f < 180; f++) d.sample(f % 2 ? 16.7 : 33.3, 3);
  assert.equal(d.floorMs, 0);
});

test('work budget + adaptive quality: a 30 fps browser cap neither starves the sim nor drops resolution', () => {
  const budget = new WorkBudget();
  // Toy GPU under a 30 Hz rAF cap: frames stay 33.3 ms until work exceeds the slot.
  const run = (frames: number, t0: number) => {
    let now = t0;
    for (let f = 0; f < frames; f++) {
      const n = Math.min(budget.cap, 40);
      const work = 7 + n * 1.7;
      const frameMs = Math.ceil(work / 33.333 - 1e-9) * 33.333;
      now += frameMs;
      budget.observe(frameMs, { simSecondsAdvanced: n * 0.12, substeps: n, dt: 0.12, throttled: n < 40 }, now, 120);
    }
    return now;
  };
  const without = run(600, 0);
  assert.equal(budget.cap, 1, 'without the ceiling the governor reads 33 ms frames as overload');
  budget.setFrameFloor(33.3);
  run(1500, without);
  assert.ok(budget.cap >= 10 && 7 + budget.cap * 1.7 <= 33.4, `cap ${budget.cap} uses the 30 Hz slot without missing it`);

  const q = new AdaptiveQuality();
  const start = q.level;
  let now = 0;
  for (let f = 0; f < 300; f++) q.sample(33.3, (now += 33.3), 4);
  assert.ok(q.level > start, 'without a floor, 30 fps steps quality down');
  const r = new AdaptiveQuality();
  r.floorMs = 33.3;
  now = 0;
  for (let f = 0; f < 600; f++) r.sample(33.3, (now += 33.3), 4);
  assert.ok(r.level <= start, `with the floor quality holds or improves (level ${r.level})`);
  for (let f = 0; f < 120; f++) r.sample(70, (now += 70), 4);
  assert.ok(r.level > 0, 'frames well beyond the ceiling still step down');
});
