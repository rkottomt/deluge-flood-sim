/**
 * The FloodSolver contract beyond numerics: statistics semantics (checked against a brute-force CPU computation
 * over the full exported state), step() time accounting, substep caps, the adaptive GPU budget, sources/storm
 * edge cases and destroy().
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver, stepAndSnapshot } from '../helpers/gpu';
import { lakeAtRest, roughTerrain } from '../helpers/terrain';
import { GpuWorkBudget } from '../../src/sim/budget';

after(finishGpuTests);

test('SimStats from the GPU reduction pass match a brute-force CPU computation over the exported state', async () => {
  const nx = 128;
  const ny = 96;
  const dx = 5;
  const elevation = roughTerrain(nx, ny, 31, 20, 90);
  const initial = lakeAtRest(elevation, 88); // a lake at reset: its cells are NOT "newly flooded"
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth: initial, params: { boundary: 'open', rainRate: 80 } });
  solver.setSources([{ id: 'in', type: 'inflow', gx: 100, gy: 20, radius: 3, discharge: 60 }]);
  await stepAndSnapshot(solver, 600);
  const snap = await solver.readbackNow();
  const ex = await solver.readTexture(solver.stateTexture, 4);

  let vol = 0;
  let maxH = 0;
  let wet = 0;
  let flooded = 0;
  let maxSp = 0;
  let depthMismatch = 0;
  for (let c = 0; c < nx * ny; c++) {
    const h = ex[4 * c];
    if (snap.depth[c] !== h) depthMismatch++;
    vol += h;
    maxH = Math.max(maxH, h);
    if (h > 0.01) {
      wet++;
      maxSp = Math.max(maxSp, Math.hypot(ex[4 * c + 1], ex[4 * c + 2]));
      if (h > 0.3 && initial[c] < 0.01) flooded++;
    }
  }
  const A = dx * dx;
  const s = snap.stats;
  console.log(
    `  stats: V=${s.volume.toFixed(1)} (cpu ${(vol * A).toFixed(1)}), wet=${s.wetArea} (cpu ${wet * A}), flooded=${s.floodedArea} (cpu ${flooded * A}), ` +
      `maxDepth=${s.maxDepth.toFixed(4)}, maxSpeed=${s.maxSpeed.toFixed(4)} (cpu ${maxSp.toFixed(4)}), processMs=${solver.readbackDiagnostics.processMs.toFixed(2)}`,
  );
  assert.equal(depthMismatch, 0, 'snapshot depth must equal exported h exactly');
  assert.ok(Math.abs(s.volume - vol * A) / (vol * A) < 1e-6, 'volume');
  assert.equal(s.wetArea, wet * A);
  assert.equal(s.floodedArea, flooded * A);
  assert.ok(flooded > 0 && flooded < wet, 'test should exercise both newly flooded and initially wet cells');
  assert.equal(s.maxDepth, maxH);
  assert.ok(Math.abs(s.maxSpeed - maxSp) < 1e-5 * Math.max(1, maxSp), 'maxSpeed');
  assert.ok(s.courant > 0 && s.courant < 1, `courant ${s.courant}`);
  assert.equal(snap.nx, nx);
  assert.equal(snap.ny, ny);
  assert.equal(solver.readbackDiagnostics.nonFiniteCells, 0);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('step(): CFL-sized substeps, sub-substep time carried between frames, maxSubstepsPerFrame, throttling', async () => {
  const nx = 64;
  const ny = 64;
  const elevation = roughTerrain(nx, ny, 5, 10, 50);
  const solver = await makeSolver({
    nx,
    ny,
    cellSize: 10,
    elevation,
    depth: lakeAtRest(elevation, 50),
    params: { timeScale: 10, maxSubstepsPerFrame: 1000, boundary: 'wall' },
  });
  solver.gpuBudgetMs = 1e6; // isolate the user cap from the GPU budget here
  const dtCfl = solver.computeDt();
  assert.ok(dtCfl > 0.3, `dt ${dtCfl}`);

  // timeScale 10 at 60 fps requests 1/6 s per frame, less than one substep: time accumulates, and every
  // substep that runs uses the full CFL dt (never a tiny one).
  let advanced = 0;
  let substeps = 0;
  const frames = 120;
  for (let f = 0; f < frames; f++) {
    const info = solver.step(1 / 60);
    await solver.flush(); // like a real frame: the GPU finishes before the next one (else the backlog guard skips)
    assert.equal(info.throttled, false);
    assert.ok(info.substeps <= 1);
    if (info.substeps) assert.equal(info.dt, dtCfl);
    advanced += info.simSecondsAdvanced;
    substeps += info.substeps;
  }
  const requested = (frames * 10) / 60;
  console.log(`  ${frames} frames at ×10: ${substeps} substeps (dt ${dtCfl.toFixed(3)} s) advanced ${advanced.toFixed(3)} of ${requested.toFixed(3)} s`);
  assert.ok(requested - advanced >= -1e-9 && requested - advanced < dtCfl, 'carried remainder is less than one substep');
  assert.equal(substeps, Math.floor(requested / dtCfl + 1e-9));
  assert.ok(Math.abs(solver.time - advanced) < 1e-9);

  // Large timeScale: capped by maxSubstepsPerFrame, throttled, backlog dropped (no burst on the next frame).
  solver.params = { ...solver.params, timeScale: 3600, maxSubstepsPerFrame: 7 };
  let info = solver.step(0.1);
  await solver.flush();
  assert.equal(info.substeps, 7);
  assert.equal(info.throttled, true);
  assert.ok(Math.abs(info.simSecondsAdvanced - 7 * info.dt) < 1e-9);
  solver.params = { ...solver.params, timeScale: 1 };
  info = solver.step(1 / 60);
  assert.ok(info.substeps <= 1, `backlog must not burst: ${info.substeps}`);

  // No work for zero / invalid time.
  for (const r of [0, -1, NaN, Infinity]) {
    const t0 = solver.time;
    assert.equal(solver.step(r).substeps, 0, `realSeconds ${r}`);
    assert.equal(solver.time, t0);
  }
  solver.params = { ...solver.params, timeScale: 0 };
  assert.equal(solver.step(0.016).substeps, 0);

  // reset() forgets carried time.
  solver.params = { ...solver.params, timeScale: dtCfl * 60 * 0.9 };
  solver.step(1 / 60);
  await solver.flush();
  solver.reset();
  await solver.flush();
  assert.equal(solver.step(1 / 60).substeps, 0, 'carried time must not survive reset');

  const snap = await solver.readbackNow();
  assert.ok(Math.abs(snap.simTime - solver.time) < 1e-9, 'snapshot time matches submitted work');
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('adaptive GPU budget: measures ms/substep from real frames and caps substeps to fit the budget', async () => {
  const n = 512;
  const elevation = roughTerrain(n, n, 8, 15, 100);
  const solver = await makeSolver({
    nx: n,
    ny: n,
    cellSize: 8,
    elevation,
    depth: lakeAtRest(elevation, 100),
    params: { timeScale: 3600, maxSubstepsPerFrame: 500, rainRate: 20 },
  });
  assert.equal(solver.gpuBudgetMs, 8);
  // Drive "frames" like the app: step, then let the GPU finish (a render would happen here).
  for (let f = 0; f < 40; f++) {
    solver.step(1 / 60);
    await solver.flush();
  }
  const ms = solver.gpuMsPerSubstep;
  const info = solver.step(1 / 60);
  await solver.flush();
  console.log(
    `  512²: measured ${ms.toFixed(3)} ms/substep via ${solver.gpuBudgetUsesTimestamps ? 'timestamp queries' : 'queue latency'} → ` +
      `${info.substeps} substeps within 8 ms (throttled=${info.throttled})`,
  );
  assert.ok(ms > 0.01 && ms < 20, `implausible ms/substep ${ms}`);
  assert.equal(info.throttled, true);
  assert.ok(info.substeps >= 1 && info.substeps * ms <= 8 + ms, `substeps ${info.substeps} × ${ms} ms exceeds budget`);
  // A tiny budget still makes progress (≥ 1 substep per frame).
  solver.gpuBudgetMs = 0.001;
  assert.equal(solver.step(1 / 60).substeps, 1);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('gpuBudgetMs = Infinity switches the GPU budget off: no measurements, substeps capped by maxSubstepsPerFrame only', async () => {
  const n = 256;
  const elevation = roughTerrain(n, n, 8, 15, 100);
  const solver = await makeSolver({
    nx: n,
    ny: n,
    cellSize: 8,
    elevation,
    depth: lakeAtRest(elevation, 100),
    params: { timeScale: 3600, maxSubstepsPerFrame: 40, rainRate: 20 },
    options: { gpuBudgetMs: Infinity },
  });
  const initialEstimate = solver.gpuMsPerSubstep;
  for (let f = 0; f < 30; f++) {
    const info = solver.step(1 / 60);
    await solver.flush();
    assert.equal(info.substeps, 40, `frame ${f}: substeps ${info.substeps}`);
  }
  assert.equal(solver.gpuMsPerSubstep, initialEstimate, 'no GPU timing samples may be taken while the budget is off');
  solver.gpuBudgetMs = 8; // back on: measured again
  for (let f = 0; f < 20; f++) {
    solver.step(1 / 60);
    await solver.flush();
  }
  if (solver.gpuBudgetUsesTimestamps) assert.notEqual(solver.gpuMsPerSubstep, initialEstimate);
  solver.gpuBudgetMs = Infinity;
  assert.equal(solver.gpuBudgetMs, Infinity);
  solver.gpuBudgetMs = NaN; // ignored
  solver.gpuBudgetMs = 0; // ignored
  assert.equal(solver.gpuBudgetMs, Infinity);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('GpuWorkBudget estimator: fast convergence, spike-resistant, follows sustained slowdowns', async () => {
  const budget = new GpuWorkBudget({ features: new Set(), queue: {} } as unknown as GPUDevice, 8, 2);
  for (let k = 0; k < 5; k++) budget.addSample(0.5);
  assert.ok(Math.abs(budget.msPerSubstep - 0.5) < 0.1, `converged to ${budget.msPerSubstep}`);
  assert.equal(budget.cap(), Math.floor(8 / budget.msPerSubstep - 0.5));
  budget.addSample(50); // one hitch
  assert.ok(budget.msPerSubstep < 0.8, `single spike moved estimate to ${budget.msPerSubstep}`);
  for (let k = 0; k < 30; k++) budget.addSample(1.5); // thermal throttling: sustained 3× slower
  assert.ok(Math.abs(budget.msPerSubstep - 1.5) < 0.1, `tracks slowdown: ${budget.msPerSubstep}`);
  const off = new GpuWorkBudget({ features: new Set(), queue: {} } as unknown as GPUDevice, Infinity, 2);
  assert.equal(off.cap(), Infinity);
  budget.addSample(NaN);
  budget.addSample(-1);
  assert.ok(Number.isFinite(budget.msPerSubstep));
});

test('sources and storms: more than the supported number, zero radius, off-domain and NaN inputs are handled', async () => {
  const nx = 64;
  const ny = 64;
  const solver = await makeSolver({ nx, ny, cellSize: 5, elevation: roughTerrain(nx, ny, 1, 5, 20), params: { boundary: 'wall' } });
  const warn = console.warn;
  let warned = 0;
  console.warn = () => warned++;
  try {
    const many = Array.from({ length: 20 }, (_, k) => ({ id: `s${k}`, type: 'inflow' as const, gx: 3 * k + 2, gy: 30, radius: 0, discharge: 1 }));
    solver.setSources([...many, { id: 'off', type: 'inflow', gx: -100, gy: -100, radius: 2, discharge: 1e6 }]);
    solver.setStorms(Array.from({ length: 12 }, (_, k) => ({ id: `t${k}`, gx: 10 + k, gy: 10, radius: 5, intensity: 100 })));
    const snap = await stepAndSnapshot(solver, 200, { dt: 0.5 });
    // 16 sources × 1 m³/s × 100 s; storms add some rain on top.
    const inflow = 16 * snap.simTime;
    console.log(`  16 of 21 sources kept: V=${snap.stats.volume.toFixed(1)} m³ (inflow alone ${inflow.toFixed(1)} m³), warnings=${warned}`);
    assert.ok(snap.stats.volume >= inflow * 0.999, 'sources beyond 16 dropped, the first 16 all active');
    assert.ok(snap.stats.volume < inflow * 1.5);
    assert.ok(warned >= 1, 'dropping sources should warn once');
    solver.setSources([{ id: 'bad', type: 'inflow', gx: 30, gy: 30, radius: 2, discharge: NaN }]);
    solver.setStorms([]);
    const s2 = await stepAndSnapshot(solver, 50, { dt: 0.5 });
    assert.ok(Number.isFinite(s2.stats.volume) && s2.stats.massError < 1e-4);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
  // After destroy every entry point is inert (no throws, no GPU errors).
  solver.step(1);
  solver.applyBrush({ kind: 'water', gx: 1, gy: 1, radius: 2, amount: 1 });
  solver.reset();
  solver.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(gpuErrors(), []);
});
