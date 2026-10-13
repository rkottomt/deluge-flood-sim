/**
 * Exact stops for headless runs (FloodSolver.step's maxSimSeconds, src/app/runFor.ts, src/ui/headless.ts) and the
 * in-frame hazard samples (SolverOptions.hazardSampleSeconds), on the real GPU solver.
 *
 * Headless runs (Site check sweeps, ensembles, today-vs-2050 comparisons) used to stop wherever the solver happened to
 * be when a readback caught up: 600 s asked ended at 614–706 s, and two runs of one level differed by more than the
 * climate change being compared. Here the app's frame loop is replayed — RunForScheduler deciding each frame's cap,
 * solver.step(realDt, cap), requestReadback once the target is reached — and the run must end on 600 s to float
 * rounding (the requirement is "within one substep") for every chunk size, with the mass ledger intact.
 *
 * Determinism: with readbacks only where the runs force them, the stepping is a function of the state alone, and two
 * identical runs are bit-identical. With the app's wall-clock readback cadence (300 ms) the CFL timestep follows
 * whichever readback has arrived, so repeats differ in the last digits: the residual is measured and bounded.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver, maxAbsDiff } from '../helpers/gpu';
import { roughTerrain } from '../helpers/terrain';
import { RunForScheduler } from '../../src/app/runFor';
import type { GpuFloodSolver, SolverOptions } from '../../src/sim';
import type { SimSnapshot } from '../../src/contracts';

after(finishGpuTests);

const nx = 128;
const ny = 96;
const CELL = 10;
const DURATION = 600;

/** A rough valley with an inflow pouring into it: fronts, wetting and drying, a mass ledger with inflow. */
async function scene(options: Partial<SolverOptions> = {}): Promise<GpuFloodSolver> {
  const elevation = roughTerrain(nx, ny, 7, 12, 200);
  const solver = await makeSolver({
    nx,
    ny,
    cellSize: CELL,
    elevation,
    params: { timeScale: 3600, maxSubstepsPerFrame: 24, boundary: 'open' },
    options: { gpuBudgetMs: Infinity, ...options },
  });
  solver.setSources([{ id: 'q', type: 'inflow', gx: 20, gy: 48, radius: 3, discharge: 400 }]);
  solver.reset();
  return solver;
}

const frame = () => new Promise<void>((r) => setTimeout(r, 1));

/**
 * The app's driver for a paused flood under runFor (src/app/driver.ts), chunk by chunk as src/ui/headless.ts asks:
 * each frame steps 1/60 s of wall time at 3600×, capped at the scheduler's limit; once the target is reached it stops
 * stepping and asks for a readback, which completes the run.
 */
async function runHeadless(solver: GpuFloodSolver, duration: number, chunk: number): Promise<{ clock: number; snap: SimSnapshot; maxAdvance: number }> {
  // The reset's readback first (as the app's first chunk waits for its scene), so it cannot land mid-run.
  await solver.flush();
  const runner = new RunForScheduler();
  let clock = 0;
  let maxAdvance = 0;
  while (clock < duration - 1e-3) {
    let done = false;
    const p = runner.start(Math.min(chunk, duration - clock), performance.now()).then(() => (done = true));
    while (!done) {
      const now = performance.now();
      const limit = runner.stepLimit();
      let adv = 0;
      if (limit > 0) {
        const info = solver.step(1 / 60, limit);
        adv = info.simSecondsAdvanced;
        assert.ok(adv <= limit + 1e-9, `a frame ran past its cap: ${adv} > ${limit}`);
        clock += adv;
        maxAdvance = Math.max(maxAdvance, adv);
        runner.onStep(adv, clock, now, solver.getSnapshot(), true);
      } else {
        runner.onStep(0, clock, now, solver.getSnapshot(), true);
        solver.requestReadback();
      }
      await solver.flush();
      await frame();
      runner.onFrame(solver.getSnapshot(), adv, performance.now());
      await Promise.resolve();
    }
    await p;
  }
  return { clock, snap: solver.getSnapshot()!, maxAdvance };
}

/** 99th percentile of |a − b| over the cells where either is moving (d·v > 0.01 m²/s). */
function p99AbsDiff(a: Float32Array, b: Float32Array): number {
  const d: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] > 0.01 || b[i] > 0.01) d.push(Math.abs(a[i] - b[i]));
  if (!d.length) return 0;
  d.sort((x, y) => x - y);
  return d[Math.min(d.length - 1, Math.floor(0.99 * d.length))];
}

test('runFor stops on the requested simulated time for every chunk size; the mass ledger stays exact', async () => {
  const solver = await scene();
  for (const chunk of [600, 300, 120, 45, 7]) {
    solver.reset();
    const { clock, snap, maxAdvance } = await runHeadless(solver, DURATION, chunk);
    const dt = solver.computeDt();
    console.log(
      `  chunk ${chunk} s: clock ${clock.toFixed(9)} s, solver ${solver.time.toFixed(9)} s, snapshot ${snap.simTime.toFixed(9)} s ` +
        `(dt ${dt.toFixed(3)} s, frames up to ${maxAdvance.toFixed(1)} s), mass error ${snap.stats.massError.toExponential(2)}`,
    );
    // The requirement is "within one substep"; the cap makes it float rounding.
    assert.ok(Math.abs(solver.time - DURATION) < Math.min(dt, 1e-6), `solver time ${solver.time}`);
    assert.ok(Math.abs(clock - DURATION) < 1e-6, `driver clock ${clock}`);
    assert.ok(Math.abs(snap.simTime - DURATION) < 1e-6, `the completing readback is of ${snap.simTime} s`);
    assert.ok(maxAdvance > 10 * dt, 'frames ran many substeps: the cap, not small frames, made the stop exact');
    // Inflow booked for exactly the run: 400 m³/s × 600 s; mass error at the solver's usual Float32 level.
    assert.ok(Math.abs(snap.stats.volumeIn - 400 * DURATION) < 1e-3 * 400 * DURATION, `volumeIn ${snap.stats.volumeIn}`);
    assert.ok(Math.abs(snap.stats.massError) < 1e-4, `massError ${snap.stats.massError}`);
  }
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('a capped frame lands exactly (a short last substep), carries nothing past the cap, and a later frame starts clean', async () => {
  const solver = await scene();
  solver.gpuBudgetMs = 1e6;
  const dt = solver.computeDt();
  const cap = 2.5 * dt;
  const info = solver.step(1 / 60, cap);
  await solver.flush();
  assert.equal(info.substeps, 3, 'two CFL substeps and one of half a dt');
  assert.ok(Math.abs(info.simSecondsAdvanced - cap) < 1e-12, `${info.simSecondsAdvanced} vs ${cap}`);
  assert.ok(Math.abs(solver.time - cap) < 1e-12);
  // A cap of 0 runs nothing; an uncapped frame afterwards runs whole substeps of the CFL dt again (nothing carried).
  assert.equal(solver.step(1 / 60, 0).substeps, 0);
  const t0 = solver.time;
  const next = solver.step(1 / 60);
  await solver.flush();
  assert.ok(next.substeps > 0 && Math.abs(next.simSecondsAdvanced - next.substeps * next.dt) < 1e-9);
  assert.ok(Math.abs(solver.time - t0 - next.simSecondsAdvanced) < 1e-9);
  // Remainders under MIN_TAIL_STEP_S are dropped, not run as a microscopic step.
  solver.reset();
  const exact = solver.step(1 / 60, 2 * dt + 1e-9);
  await solver.flush();
  assert.equal(exact.substeps, 2);
  solver.destroy();
});

test('identical runs are identical: bit for bit with forced readbacks only, within a tight bound at the app cadence', async () => {
  // Readbacks only where the runs force them (chunk ends): the CFL timestep is a function of the state alone.
  const quiet = await scene({ readbackIntervalMs: 1e9 });
  const fields = async (s: GpuFloodSolver) => {
    const f = await s.readHazardFields();
    return { depth: (await s.readbackNow()).depth.slice(), maxDepth: f.maxDepth.slice(), maxDV: f.maxDV.slice(), firstWet: f.firstWet.slice() };
  };
  const runs = [];
  for (let k = 0; k < 2; k++) {
    quiet.reset();
    await runHeadless(quiet, DURATION, 300);
    runs.push(await fields(quiet));
  }
  for (const key of ['depth', 'maxDepth', 'maxDV', 'firstWet'] as const) {
    assert.equal(maxAbsDiff(runs[0][key], runs[1][key]), 0, `${key} differs between identical runs`);
  }
  quiet.destroy();

  // The app's cadence: readbacks every 300 ms of wall time steer the CFL estimate, so the timestep sequence (not the
  // simulated time) differs between repeats. Measured here: max depth within a few mm, d·v within a few %.
  const app = await scene();
  const reps = [];
  for (let k = 0; k < 3; k++) {
    app.reset();
    await runHeadless(app, DURATION, 300);
    reps.push(await fields(app));
  }
  let dDepth = 0;
  let dDV = 0;
  let dDV99 = 0;
  let peakDV = 0;
  for (let k = 1; k < reps.length; k++) {
    dDepth = Math.max(dDepth, maxAbsDiff(reps[0].maxDepth, reps[k].maxDepth));
    dDV = Math.max(dDV, maxAbsDiff(reps[0].maxDV, reps[k].maxDV));
    dDV99 = Math.max(dDV99, p99AbsDiff(reps[0].maxDV, reps[k].maxDV));
  }
  for (const v of reps[0].maxDV) peakDV = Math.max(peakDV, v);
  console.log(
    `  repeats at the 300 ms cadence: max depth differs by ≤ ${dDepth.toExponential(2)} m, d·v by ≤ ${dDV.toFixed(3)} m²/s ` +
      `(99th percentile over moving cells ${dDV99.toFixed(3)}; peak ${peakDV.toFixed(2)})`,
  );
  assert.ok(dDepth < 0.05, `max depth differs by ${dDepth} m between repeats`);
  // d·v is asserted on its 99th percentile, not the single worst cell: the timestep sequence follows wall-clock
  // readbacks, and on a contended GPU one jet cell's peak moved 2.7 m²/s (16 % of the peak) in 1 run of 3 while the
  // usual worst cell moves ~0.35. Losses read the footprint's 90th percentile (src/loss/hazard.ts), never one cell.
  assert.ok(dDV99 < 0.05 * peakDV, `d·v (99th percentile) differs by ${dDV99} m²/s between repeats (peak ${peakDV})`);
  assert.ok(dDV < 0.25 * peakDV, `d·v differs by ${dDV} m²/s in its worst cell (peak ${peakDV})`);
  app.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('in-frame hazard samples are the exports a frame-by-frame run would have made at the same substeps', async () => {
  // Fixed dt (dtMin = dtMax) so both runs take the same substeps; samples every 4 substeps.
  const dt = 0.5;
  const opts = { dtMin: dt, dtMax: dt, hazardSampleSeconds: 4 * dt, readbackIntervalMs: 1e9 };
  const a = await scene(opts);
  const b = await scene(opts);
  a.gpuBudgetMs = 1e6;
  // a: one step() frame of 24 substeps → samples after 4, 8, …, 20, and the frame's own export at 24.
  a.params = { ...a.params, timeScale: 24 * dt * 60 };
  const info = a.step(1 / 60);
  assert.equal(info.substeps, 24);
  // b: the same substeps, exported every 4 by hand (reading stateTexture exports).
  for (let k = 0; k < 6; k++) {
    b.runSubsteps(4, dt);
    void b.stateTexture;
  }
  void a.stateTexture;
  const fa = await a.readHazardFields();
  const fb = await b.readHazardFields();
  for (const key of ['maxDepth', 'maxSpeed', 'maxDV', 'firstWet', 'wetSeconds'] as const) {
    assert.equal(maxAbsDiff(fa[key], fb[key]), 0, `${key}: in-frame samples differ from per-export ones`);
  }
  // Without the samples, the frame's single export misses the peaks the samples caught.
  const c = await scene({ ...opts, hazardSampleSeconds: 0 });
  c.gpuBudgetMs = 1e6;
  c.params = { ...c.params, timeScale: 24 * dt * 60 };
  c.step(1 / 60);
  void c.stateTexture;
  const fc = await c.readHazardFields();
  let sumA = 0;
  let sumC = 0;
  for (let i = 0; i < fa.maxDV.length; i++) {
    sumA += fa.maxDV[i];
    sumC += fc.maxDV[i];
  }
  assert.ok(sumA >= sumC, `sampled maxima (${sumA}) can only be ≥ the end-of-frame ones (${sumC})`);
  for (const s of [a, b, c]) s.destroy();
  assert.deepEqual(gpuErrors(), []);
});
