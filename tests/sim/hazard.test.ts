/**
 * Hazard accumulators (FloodSolver.readHazardFields, contracts.ts HazardFields; shaders/exportState.ts).
 *
 * The dam break of tests/sim/dambreak.test.ts (flat frictionless bed, 1 m of water behind a dam at x0 = 160 m) is run
 * with an export every few substeps, and every export is replayed on the CPU through the Float64 mirror of the
 * shader's update (src/sim/hazard.ts) from the exported state itself — so the GPU fields are checked cell by cell
 * against a brute-force computation, and the physics against Ritter:
 *   a point x downstream of the dam first reaches depth A (ARRIVAL_DEPTH) when ξ = (x − x0)/t = 2c0 − 3√(g·A),
 *   so its arrival time is (x − x0) / (2c0 − 3√(g·A)). Required: the depth-A front's speed (the slope of firstWet over
 *   20–80 m) within 5 % of Ritter's, every arrival within 2.5 s of it (the smeared tip of any first-order scheme runs a
 *   few metres ahead, so arrivals come a near-constant ~1.6 s early), and the front at T within ±15 % (as for the
 *   5 %-depth front in dambreak.test.ts). Typical on this machine: speed 0.5 % off, arrivals 1.7 s early at most.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { lakeAtRest, roughTerrain } from '../helpers/terrain';
import { ARRIVAL_DEPTH } from '../../src/sim/constants';
import { HAZARD_PER_CELL, HZ, hazardUpdate, newHazardAccumulator } from '../../src/sim/hazard';
import type { GpuFloodSolver } from '../../src/sim';

after(finishGpuTests);

const g = 9.81;
const nx = 512;
const ny = 16;
const x0 = 160;
const h0 = 1;

async function damBreak() {
  const elevation = new Float32Array(nx * ny).fill(100);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < x0; i++) depth[j * nx + i] = h0;
  return makeSolver({ nx, ny, cellSize: 1, elevation, depth, params: { boundary: 'wall', manningN: 0, cfl: 0.7 } });
}

/** CPU replay of every export: the exported state is read after each one and fed to the Float64 mirror. */
class Replay {
  acc: Float64Array;
  prevH: Float32Array;
  prevTime = 0;
  state: Float32Array = new Float32Array(0);
  constructor(readonly solver: GpuFloodSolver) {
    this.acc = newHazardAccumulator(solver.nx * solver.ny);
    this.prevH = new Float32Array(solver.nx * solver.ny);
  }
  /** Export now (reading stateTexture does when the state moved on) and apply it. */
  async exportAndApply(reset = false): Promise<void> {
    const s = this.solver;
    const st = await s.readTexture(s.stateTexture, 4);
    const t = s.time;
    const span = reset ? 0 : t - this.prevTime;
    for (let c = 0; c < s.nx * s.ny; c++) {
      const h = st[4 * c];
      const sp = Math.hypot(st[4 * c + 1], st[4 * c + 2]);
      hazardUpdate(this.acc, c, h, this.prevH[c], sp, t, span, reset);
      this.prevH[c] = h;
    }
    this.prevTime = t;
    this.state = st;
  }
}

/** March to T with the CFL dt, exporting every `chunk` substeps (as a renderer reading stateTexture would). */
async function march(solver: GpuFloodSolver, replay: Replay, T: number, chunk = 8) {
  while (solver.time < T - 1e-9) {
    const dt = Math.min(solver.computeDt(), T - solver.time);
    const n = Math.max(1, Math.min(chunk, Math.floor((T - solver.time) / dt)));
    solver.runSubsteps(n, Math.min(dt, (T - solver.time) / n));
    await replay.exportAndApply();
    await solver.readbackNow(); // CFL maxima (the state is already exported: this exports nothing)
  }
}

test('dam break: arrival time follows Ritter, matches a CPU replay of every export, wet time and maxima are consistent', async () => {
  const solver = await damBreak();
  const replay = new Replay(solver);
  await replay.exportAndApply(true); // the reset's export
  const T = 30;
  await march(solver, replay, T);
  const hz = await solver.readHazardFields();
  const { firstWet, wetSeconds, maxSpeed, maxDV, maxDepth } = hz;
  assert.equal(hz.nx, nx);
  assert.equal(hz.ny, ny);
  assert.ok(Math.abs(hz.simTime - solver.time) < 1e-9, `simTime ${hz.simTime} vs ${solver.time}`);

  // 1. Cell by cell against the brute-force replay (Float32 GPU arithmetic vs Float64).
  let worst = { firstWet: 0, wet: 0, speed: 0, dv: 0, depth: 0 };
  for (let c = 0; c < nx * ny; c++) {
    const o = c * HAZARD_PER_CELL;
    worst = {
      firstWet: Math.max(worst.firstWet, Math.abs(firstWet[c] - replay.acc[o + HZ.firstWet])),
      wet: Math.max(worst.wet, Math.abs(wetSeconds[c] - replay.acc[o + HZ.wetSeconds])),
      speed: Math.max(worst.speed, Math.abs(maxSpeed[c] - replay.acc[o + HZ.maxSpeed])),
      dv: Math.max(worst.dv, Math.abs(maxDV[c] - replay.acc[o + HZ.maxDV])),
      depth: Math.max(worst.depth, Math.abs(maxDepth[c] - replay.state[4 * c + 3])),
    };
  }
  console.log(`  GPU vs CPU replay, max |Δ|: firstWet ${worst.firstWet.toExponential(1)} s, wetSeconds ${worst.wet.toExponential(1)} s, maxSpeed ${worst.speed.toExponential(1)}, maxDV ${worst.dv.toExponential(1)}`);
  assert.ok(worst.firstWet < 2e-3, `firstWet differs from the replay by ${worst.firstWet} s`);
  assert.ok(worst.wet < 5e-3, `wetSeconds differs from the replay by ${worst.wet} s`);
  assert.ok(worst.speed < 1e-4 && worst.dv < 1e-4, `maxima differ from the replay: ${worst.speed}, ${worst.dv}`);
  assert.equal(worst.depth, 0, 'maxDepth must be stateTexture.a');

  // 2. Physics: the arrival front against Ritter, along the centre row.
  const j = ny >> 1;
  const c0 = Math.sqrt(g * h0);
  const xiA = 2 * c0 - 3 * Math.sqrt(g * ARRIVAL_DEPTH);
  let prev = -Infinity;
  let reached = 0;
  let worstLag = 0;
  // Least-squares slope of firstWet against x over 20–80 m: the speed the depth-A front travels at.
  let sx = 0, st2 = 0, sxx = 0, sxt = 0, m = 0;
  for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    const fw = firstWet[c];
    if (i < x0) {
      assert.equal(fw, 0, `cell ${i} was wet at reset: firstWet ${fw}`);
      continue;
    }
    if (fw < 0) {
      // Never wet: nothing recorded, and everything beyond the front stays never-wet.
      assert.equal(fw, -1);
      assert.equal(wetSeconds[c], 0);
      assert.equal(maxSpeed[c], 0);
      prev = Infinity;
      continue;
    }
    assert.ok(fw >= prev - 1e-6, `firstWet not monotone in distance at x = ${i}: ${fw} after ${prev}`);
    prev = fw;
    reached = i;
    const x = i + 0.5 - x0;
    worstLag = Math.max(worstLag, Math.abs(fw - x / xiA));
    if (x >= 20 && x <= 80) {
      sx += x;
      st2 += fw;
      sxx += x * x;
      sxt += x * fw;
      m++;
    }
  }
  const slope = (m * sxt - sx * st2) / (m * sxx - sx * sx);
  const ritterFront = x0 + T * xiA;
  console.log(
    `  arrival (h > ${ARRIVAL_DEPTH} m): front at ${reached + 1} m (Ritter ${ritterFront.toFixed(1)} m), ` +
      `front speed ${(1 / slope).toFixed(3)} m/s (Ritter ${xiA.toFixed(3)}), worst |firstWet − Ritter| ${worstLag.toFixed(2)} s`,
  );
  // The scheme's smeared tip runs a few metres ahead of Ritter's (dambreak.test.ts), so a point gets wet a roughly
  // constant ~1.6 s early: the arrival front's SPEED is the sharp test, the offset only has to stay that small.
  assert.ok(Math.abs(slope * xiA - 1) < 0.05, `arrival front speed ${1 / slope} vs Ritter ${xiA}`);
  assert.ok(worstLag < 2.5, `arrival time off Ritter by ${worstLag} s`);
  assert.ok(Math.abs((reached + 1 - x0) / (ritterFront - x0) - 1) < 0.15, `front at ${reached + 1}`);
  assert.ok(firstWet[j * nx + nx - 1] === -1, 'the far end of the channel is never reached');

  // 3. Wet duration: every cell still wet has been wet since it first got wet (a dam break only fills).
  // 4. maxDV ≥ the current h·|u| everywhere, maxSpeed ≥ the current speed wherever it is wet.
  const st = replay.state;
  let worstWet = 0;
  for (let c = 0; c < nx * ny; c++) {
    const h = st[4 * c];
    const sp = Math.hypot(st[4 * c + 1], st[4 * c + 2]);
    if (h > ARRIVAL_DEPTH) {
      worstWet = Math.max(worstWet, Math.abs(wetSeconds[c] - (hz.simTime - firstWet[c])));
      // (Absolute slack: u ~ 1e-20 in the reservoir squares to zero in Float32 on the GPU.)
      assert.ok(maxSpeed[c] >= sp * (1 - 1e-6) - 1e-9, `maxSpeed ${maxSpeed[c]} < speed ${sp} at ${c}`);
    }
    assert.ok(maxDV[c] >= h * sp * (1 - 1e-6) - 1e-9, `maxDV ${maxDV[c]} < h|u| ${h * sp} at ${c}`);
  }
  console.log(`  wetSeconds vs simTime − firstWet: max |Δ| ${worstWet.toExponential(1)} s`);
  assert.ok(worstWet < 0.01, `wetSeconds ≠ simTime − firstWet by ${worstWet} s`);

  // The snapshot machinery is undisturbed: an exact mass balance across the hazard readback.
  const snap = await solver.readbackNow();
  assert.ok(snap.stats.massError < 1e-5, `massError ${snap.stats.massError}`);
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('export resolution: arrival is interpolated between exports, to a fraction of the export interval', async () => {
  const T = 20;
  const run = async (chunk: number) => {
    const solver = await damBreak();
    const replay = new Replay(solver);
    let exports = 0;
    const apply = replay.exportAndApply.bind(replay);
    replay.exportAndApply = (reset?: boolean) => (exports++, apply(reset));
    await march(solver, replay, T, chunk);
    const hz = await solver.readHazardFields();
    solver.destroy();
    return { hz, interval: T / exports };
  };
  const fine = (await run(1)).hz;
  const { hz: coarse, interval } = await run(32);
  let worst = 0;
  let sum = 0;
  let n = 0;
  const j = ny >> 1;
  for (let i = x0; i < nx; i++) {
    const c = j * nx + i;
    if (fine.firstWet[c] < 0 || coarse.firstWet[c] < 0) {
      // Only the last cells of the front may differ in whether they were reached at all.
      if (fine.firstWet[c] !== coarse.firstWet[c]) assert.ok(Math.max(fine.firstWet[c], coarse.firstWet[c]) > T - interval, `cell ${i}`);
      continue;
    }
    const d = Math.abs(fine.firstWet[c] - coarse.firstWet[c]);
    worst = Math.max(worst, d);
    sum += d;
    n++;
    // A cell is never wet longer than it has been since it first got wet (shorter where the front's tip flickered
    // dry for a moment, which per-substep exports resolve).
    for (const hz of [fine, coarse]) assert.ok(hz.wetSeconds[c] <= hz.simTime - hz.firstWet[c] + 1e-3, `cell ${i}`);
  }
  console.log(
    `  exports every substep vs every 32 (${interval.toFixed(2)} s apart): |Δ firstWet| mean ${(sum / n).toFixed(2)} s, max ${worst.toFixed(2)} s`,
  );
  // An interpolated crossing always lies inside the interval it was detected in, so it is never off by more than one
  // interval; stamping it at the export instead would be off by half an interval on average (here ~0.27).
  assert.ok(worst <= interval + 1e-3, `arrival moved by ${worst} s with exports ${interval} s apart`);
  assert.ok(sum / n < 0.35 * interval, `mean arrival error ${sum / n} s with exports ${interval} s apart`);
});

test('reset clears the accumulators: wet at reset → 0, dry → −1, nothing recorded', async () => {
  const solver = await damBreak();
  solver.runSubsteps(200);
  void solver.stateTexture;
  const before = await solver.readHazardFields();
  assert.ok(before.simTime > 0);
  assert.ok(before.firstWet.some((v) => v > 0) && before.wetSeconds.some((v) => v > 0));
  solver.reset();
  const hz = await solver.readHazardFields();
  assert.equal(hz.simTime, 0);
  for (let c = 0; c < nx * ny; c++) {
    const wetAtReset = c % nx < x0;
    assert.equal(hz.firstWet[c], wetAtReset ? 0 : -1, `cell ${c}`);
    assert.equal(hz.wetSeconds[c], 0);
    assert.equal(hz.maxSpeed[c], 0);
    assert.equal(hz.maxDV[c], 0);
    assert.equal(hz.maxDepth[c], wetAtReset ? h0 : 0);
  }
  // And it accumulates again from there.
  solver.runSubsteps(40);
  void solver.stateTexture;
  const again = await solver.readHazardFields();
  const t = again.simTime;
  assert.ok(t > 0);
  assert.ok(Math.abs(again.wetSeconds[0] - t) < 1e-4 * t, `reservoir wet ${again.wetSeconds[0]} of ${t} s`);
  solver.destroy();
});

test('brush edits: a water brush on dry land arrives at the time of the edit; walls change no times', async () => {
  const solver = await damBreak();
  solver.runSubsteps(60);
  void solver.stateTexture;
  const t = solver.time;
  const a = await solver.readHazardFields();
  // A wall on the dry part far downstream, then water poured in a dry patch.
  solver.applyBrush({ kind: 'wall', ax: 420, ay: 2, bx: 420, by: 14, radius: 1, height: 2 });
  const b = await solver.readHazardFields();
  for (let c = 0; c < nx * ny; c++) {
    assert.equal(b.firstWet[c], a.firstWet[c]);
    assert.equal(b.wetSeconds[c], a.wetSeconds[c]);
    assert.ok(b.maxSpeed[c] >= a.maxSpeed[c] && b.maxDV[c] >= a.maxDV[c]);
  }
  solver.applyBrush({ kind: 'water', gx: 470, gy: 8, radius: 4, amount: 1 });
  const w = await solver.readHazardFields();
  const c = 8 * nx + 470;
  assert.ok(Math.abs(w.firstWet[c] - t) < 1e-3, `poured water arrived at ${w.firstWet[c]}, edit at ${t}`);
  assert.equal(w.wetSeconds[c], 0);
  // A step later the poured water has been wet for exactly that step.
  solver.runSubsteps(1, 0.05);
  void solver.stateTexture;
  const s = await solver.readHazardFields();
  assert.ok(Math.abs(s.wetSeconds[c] - 0.05) < 1e-4, `wet ${s.wetSeconds[c]}`);
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('readHazardFields: concurrent calls agree, a call racing destroy() rejects cleanly, and so does one after it', async () => {
  const solver = await damBreak();
  solver.runSubsteps(100);
  const [a, b, c] = await Promise.all([solver.readHazardFields(), solver.readHazardFields(), solver.readHazardFields()]);
  assert.ok(a.simTime > 0 && a.simTime === b.simTime && b.simTime === c.simTime);
  assert.deepEqual(a.firstWet, b.firstWet);
  assert.deepEqual(b.wetSeconds, c.wetSeconds);
  // Interleaved with the snapshot readbacks.
  const [snap, d] = await Promise.all([solver.readbackNow(), solver.readHazardFields()]);
  assert.ok(snap.simTime > 0);
  assert.deepEqual(d.maxDV, a.maxDV);
  const racing = solver.readHazardFields();
  solver.destroy();
  await assert.rejects(racing, /destroyed/);
  await assert.rejects(solver.readHazardFields(), /destroyed/);
  assert.deepEqual(gpuErrors(), []);
});

test('a naive-mode blow-up never stores a non-finite hazard value', async () => {
  const n = 64;
  const elevation = roughTerrain(n, n, 4, 25, 100);
  const depth = lakeAtRest(elevation, 101);
  const solver = await makeSolver({ nx: n, ny: n, cellSize: 5, elevation, depth, params: { stabilityMode: 'naive', cfl: 3, rainRate: 100 } });
  for (let k = 0; k < 40 && solver.readbackDiagnostics.nonFiniteCells === 0; k++) {
    solver.runSubsteps(25);
    void solver.stateTexture;
    await solver.readbackNow();
  }
  assert.ok(solver.readbackDiagnostics.nonFiniteCells > 0, 'expected the naive run to blow up');
  const hz = await solver.readHazardFields();
  for (const [name, arr] of Object.entries({ maxSpeed: hz.maxSpeed, maxDV: hz.maxDV, firstWet: hz.firstWet, wetSeconds: hz.wetSeconds })) {
    const bad = arr.findIndex((v) => !Number.isFinite(v));
    assert.equal(bad, -1, `${name}[${bad}] = ${arr[bad]}`);
  }
  assert.ok(hz.firstWet.every((v) => v === -1 || (v >= 0 && v <= hz.simTime + 1e-3)));
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});
