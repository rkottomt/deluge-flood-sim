/**
 * Well-balancing: a lake at rest over rough terrain (with islands poking through the surface) must stay at
 * rest. Schemes that compute the pressure gradient and the bed slope separately generate spurious currents
 * here; ours forms S = ((z_R − z_L) + (h_R − h_L))/dx and hf = max(η) − max(z) so they cancel exactly.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { lakeAtRest, roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

test('lake at rest on rough terrain stays at rest (max |u| < 1e-3 m/s after 2000 steps)', async () => {
  const nx = 96;
  const ny = 96;
  const elevation = roughTerrain(nx, ny, 3, 24, 250);
  // A level that is not exactly representable, so η = z + h carries Float32 rounding (a harder test).
  const level = 252.37;
  const depth = lakeAtRest(elevation, level);
  let wet = 0;
  for (const h of depth) if (h > 0) wet++;
  const wetFrac = wet / depth.length;
  assert.ok(wetFrac > 0.3 && wetFrac < 0.8, `terrain should be partly submerged (wet fraction ${wetFrac})`);

  const solver = await makeSolver({
    nx,
    ny,
    cellSize: 10,
    elevation,
    depth,
    params: { boundary: 'wall', manningN: 0.035 },
  });
  const dt = solver.computeDt();
  for (let k = 0; k < 20; k++) solver.runSubsteps(100, dt);
  const snap = await solver.readbackNow();
  const exported = await solver.readTexture(solver.stateTexture, 4);
  const state = await solver.debugReadState();

  let maxU = 0;
  let maxDh = 0;
  let maxQ = 0;
  for (let c = 0; c < nx * ny; c++) {
    maxU = Math.max(maxU, Math.hypot(exported[4 * c + 1], exported[4 * c + 2]));
    maxDh = Math.max(maxDh, Math.abs(state.h[c] - depth[c]));
    maxQ = Math.max(maxQ, Math.abs(state.qx[c]), Math.abs(state.qy[c]));
  }
  console.log(`  lake at rest: dt=${dt.toFixed(3)} s, max|u|=${maxU.toExponential(2)} m/s, max|q|=${maxQ.toExponential(2)}, max|Δh|=${maxDh.toExponential(2)} m`);
  assert.ok(snap.simTime > 900, `simTime ${snap.simTime}`);
  assert.ok(maxU < 1e-3, `max |u| = ${maxU}`);
  assert.ok(maxDh < 1e-3, `max |Δh| = ${maxDh}`);
  assert.ok(snap.stats.massError < 1e-5, `massError ${snap.stats.massError}`);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('lake at rest also holds without advection and in naive mode at a stable Courant number', async () => {
  const nx = 48;
  const ny = 48;
  const elevation = roughTerrain(nx, ny, 11, 30, 1200); // high-altitude terrain: exercises the datum shift
  const depth = lakeAtRest(elevation, 1201.13);
  for (const [label, params, options] of [
    ['no advection', { boundary: 'wall' as const }, { advection: false }],
    ['naive cfl 0.5', { boundary: 'wall' as const, stabilityMode: 'naive' as const, cfl: 0.5 }, {}],
  ] as const) {
    const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, depth, params, options });
    solver.runSubsteps(1000, solver.computeDt());
    const exported = await solver.readTexture(solver.stateTexture, 4);
    let maxU = 0;
    for (let c = 0; c < nx * ny; c++) maxU = Math.max(maxU, Math.hypot(exported[4 * c + 1], exported[4 * c + 2]));
    assert.ok(maxU < 1e-3, `${label}: max |u| = ${maxU}`);
    solver.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});
