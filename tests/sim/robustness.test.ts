/**
 * Robustness: positivity and finiteness under abuse, the naive-mode stability demo, and NaN recovery.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver, stepAndSnapshot } from '../helpers/gpu';
import { lakeAtRest, roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

async function scanState(solver: Awaited<ReturnType<typeof makeSolver>>) {
  const st = await solver.debugReadState();
  let minH = Infinity;
  let nonFinite = 0;
  for (let c = 0; c < st.h.length; c++) {
    const h = st.h[c];
    if (!Number.isFinite(h) || !Number.isFinite(st.qx[c]) || !Number.isFinite(st.qy[c])) nonFinite++;
    else if (h < minH) minH = h;
  }
  return { minH, nonFinite };
}

test('robust mode: extreme rain (500 mm/hr) on steep random terrain for 3000 steps — no NaN, no negative depth', async () => {
  const nx = 128;
  const ny = 128;
  const dx = 4;
  // ~150 m of relief over 512 m with white noise: local slopes well above 1.
  const elevation = roughTerrain(nx, ny, 77, 150, 400);
  let maxSlope = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx - 1; i++) maxSlope = Math.max(maxSlope, Math.abs(elevation[j * nx + i + 1] - elevation[j * nx + i]) / dx);
  for (const boundary of ['open', 'wall'] as const) {
    for (const manningN of [0.035, 0.01]) {
      const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary, rainRate: 500, manningN, cfl: 0.9 } });
      let worstMin = Infinity;
      let nonFinite = 0;
      let maxSpeed = 0;
      let worstMassErr = 0;
      let snap = await solver.readbackNow();
      for (let k = 0; k < 6; k++) {
        snap = await stepAndSnapshot(solver, 500, { chunk: 50 });
        const s = await scanState(solver);
        worstMin = Math.min(worstMin, s.minH);
        nonFinite += s.nonFinite + solver.readbackDiagnostics.nonFiniteCells;
        maxSpeed = Math.max(maxSpeed, snap.stats.maxSpeed);
        worstMassErr = Math.max(worstMassErr, snap.stats.massError);
      }
      console.log(
        `  ${boundary} n=${manningN}: max slope ${maxSlope.toFixed(1)}, t=${snap.simTime.toFixed(0)} s, min h=${worstMin.toExponential(2)}, ` +
          `max depth ${snap.stats.maxDepth.toFixed(2)} m, max speed ${maxSpeed.toFixed(2)} m/s, massError ${worstMassErr.toExponential(2)}`,
      );
      assert.equal(nonFinite, 0, 'non-finite values');
      assert.ok(worstMin >= 0, `negative depth ${worstMin}`);
      assert.ok(maxSpeed <= solver.options.uMax + 1e-3, `speed ${maxSpeed}`);
      assert.ok(worstMassErr < 1e-3, `massError ${worstMassErr}`);
      solver.destroy();
    }
  }
  assert.deepEqual(gpuErrors(), []);
});

test('robust mode survives a stale CFL estimate: huge dt on a sudden deep dam break stays finite and positive', async () => {
  const nx = 64;
  const ny = 64;
  const dx = 2;
  const elevation = roughTerrain(nx, ny, 8, 10, 50);
  const depth = new Float32Array(nx * ny);
  for (let j = 10; j < 54; j++) for (let i = 10; i < 30; i++) depth[j * nx + i] = 30;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'open', manningN: 0.02 } });
  // dt = 0.5 s is ~4× the CFL limit for 30 m of water on 2 m cells.
  solver.runSubsteps(2000, 0.5);
  const s = await scanState(solver);
  const snap = await solver.readbackNow();
  console.log(`  stale-CFL abuse: min h=${s.minH}, non-finite=${s.nonFinite}, max speed ${snap.stats.maxSpeed.toFixed(2)}, massError ${snap.stats.massError.toExponential(2)}`);
  assert.equal(s.nonFinite, 0);
  assert.ok(s.minH >= 0);
  assert.ok(snap.stats.massError < 1e-3);
  solver.destroy();
});

test("stability demo: 'naive' mode with cfl 1.8 blows up on rough terrain while 'robust' does not", async () => {
  const nx = 96;
  const ny = 96;
  const dx = 8;
  const elevation = roughTerrain(nx, ny, 21, 30, 180);
  const depth = lakeAtRest(elevation, 181.5);
  // Perturb: a raised mound of water so there is motion to amplify.
  for (let j = 30; j < 50; j++) for (let i = 30; i < 50; i++) depth[j * nx + i] += 3;
  const results: Record<string, { speed: number; nonFinite: number; t: number }> = {};
  for (const mode of ['naive', 'robust'] as const) {
    const solver = await makeSolver({
      nx,
      ny,
      cellSize: dx,
      elevation,
      depth,
      params: { stabilityMode: mode, cfl: 1.8, rainRate: 50, boundary: 'open' },
    });
    let speed = 0;
    let nonFinite = 0;
    let snap = await solver.readbackNow();
    for (let k = 0; k < 20; k++) {
      snap = await stepAndSnapshot(solver, 25, { chunk: 25 });
      nonFinite = Math.max(nonFinite, solver.readbackDiagnostics.nonFiniteCells);
      const sp = snap.stats.maxSpeed;
      speed = Number.isFinite(sp) ? Math.max(speed, sp) : Infinity;
    }
    results[mode] = { speed, nonFinite, t: snap.simTime };
    solver.destroy();
  }
  console.log(`  naive: max speed ${results.naive.speed}, non-finite cells ${results.naive.nonFinite}, t=${results.naive.t.toFixed(0)} s`);
  console.log(`  robust: max speed ${results.robust.speed.toFixed(2)}, non-finite cells ${results.robust.nonFinite}, t=${results.robust.t.toFixed(0)} s`);
  assert.ok(results.naive.speed > 100 || results.naive.nonFinite > 0, 'naive mode should go unstable');
  assert.equal(results.robust.nonFinite, 0);
  assert.ok(results.robust.speed < 20, `robust speed ${results.robust.speed}`);
  assert.deepEqual(gpuErrors(), [], 'NaNs must not cause WebGPU validation errors');
});

test('reset() fully recovers from a NaN blow-up', async () => {
  const nx = 64;
  const ny = 64;
  const dx = 5;
  const elevation = roughTerrain(nx, ny, 4, 25, 100);
  const depth = lakeAtRest(elevation, 101);
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { stabilityMode: 'naive', cfl: 3, rainRate: 100 } });
  const v0 = (await solver.readbackNow()).stats.volume;
  // Drive it into NaN/Inf territory.
  for (let k = 0; k < 40 && solver.readbackDiagnostics.nonFiniteCells === 0; k++) await stepAndSnapshot(solver, 50, { chunk: 50 });
  assert.ok(solver.readbackDiagnostics.nonFiniteCells > 0, 'expected the naive run to produce non-finite values');

  solver.params = { ...solver.params, stabilityMode: 'robust', cfl: 0.7 };
  solver.reset();
  const snap0 = await solver.readbackNow();
  assert.equal(solver.readbackDiagnostics.nonFiniteCells, 0);
  assert.equal(snap0.simTime, 0);
  assert.ok(Math.abs(snap0.stats.volume - v0) / v0 < 1e-12, 'volume restored exactly');
  assert.equal(snap0.stats.volumeIn, 0);
  const exported = await solver.readTexture(solver.stateTexture, 4);
  for (let c = 0; c < nx * ny; c++) {
    assert.ok(Number.isFinite(exported[4 * c + 3]) && Math.abs(exported[4 * c + 3] - depth[c]) < 1e-6, 'max depth reset');
  }
  const snap = await stepAndSnapshot(solver, 500);
  const s = await scanState(solver);
  assert.equal(s.nonFinite, 0);
  assert.ok(s.minH >= 0);
  assert.ok(snap.stats.massError < 1e-3, `massError after reset ${snap.stats.massError}`);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});
