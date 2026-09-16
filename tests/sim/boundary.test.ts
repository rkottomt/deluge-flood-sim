/**
 * Open boundaries: rain on a tilted plane must reach a steady state where the accounted outflow balances the
 * rain input. Also: open boundaries only ever let water OUT, and 'wall' boundaries let nothing out.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { tiltedPlane } from '../helpers/terrain';

after(finishGpuTests);

test('open boundary: rain on a tilted plane reaches steady state with outflow ≈ rain input (< 5%)', async () => {
  const nx = 64;
  const ny = 48;
  const dx = 10;
  const slope = 0.01;
  const rain = 60; // mm/hr
  const solver = await makeSolver({
    nx,
    ny,
    cellSize: dx,
    elevation: tiltedPlane(nx, ny, dx, slope),
    params: { boundary: 'open', rainRate: rain, manningN: 0.035 },
  });
  const rainInput = (rain / 3.6e6) * nx * ny * dx * dx; // m³/s
  // Kinematic-wave time to equilibrium for a 640 m plane is ~1600 s; run ~3 h and measure the last window.
  let prev = await solver.readbackNow();
  let ratio = 0;
  let volChange = 0;
  const windows: string[] = [];
  for (let w = 0; w < 12; w++) {
    const target = prev.simTime + 900;
    while (solver.time < target) {
      solver.runSubsteps(40);
      await solver.readbackNow();
    }
    const cur = await solver.readbackNow();
    const dt = cur.simTime - prev.simTime;
    const outRate = (cur.stats.volumeOut - prev.stats.volumeOut) / dt;
    const inRate = (cur.stats.volumeIn - prev.stats.volumeIn) / dt;
    ratio = outRate / rainInput;
    volChange = (cur.stats.volume - prev.stats.volume) / dt / rainInput;
    windows.push(`${(cur.simTime / 60).toFixed(0)}min:${ratio.toFixed(3)}`);
    assert.ok(Math.abs(inRate / rainInput - 1) < 1e-3, `rain accounting ${inRate} vs ${rainInput}`);
    prev = cur;
  }
  console.log(`  outflow/rain by window: ${windows.join(' ')}  (dV/dt / rain = ${volChange.toExponential(2)}, massError ${prev.stats.massError.toExponential(2)})`);
  assert.ok(Math.abs(ratio - 1) < 0.05, `steady-state outflow/rain = ${ratio}`);
  assert.ok(Math.abs(volChange) < 0.05, 'storage should be steady');
  assert.ok(prev.stats.massError < 1e-3);
  // Depth increases downslope (east) at steady state, like the kinematic-wave solution.
  const row = ny >> 1;
  assert.ok(prev.depth[row * nx + nx - 2] > prev.depth[row * nx + 8] * 1.5, 'deeper toward the outlet');
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test("'wall' boundary lets nothing out; 'open' never lets water in", async () => {
  const nx = 32;
  const ny = 32;
  const dx = 5;
  const elevation = tiltedPlane(nx, ny, dx, 0.05);
  const depth = new Float32Array(nx * ny).fill(0.5);
  for (const boundary of ['wall', 'open'] as const) {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary } });
    solver.runSubsteps(600);
    const snap = await solver.readbackNow();
    const v0 = 0.5 * nx * ny * dx * dx;
    if (boundary === 'wall') {
      assert.equal(snap.stats.volumeOut, 0);
      assert.ok(Math.abs(snap.stats.volume - v0) / v0 < 1e-5);
    } else {
      assert.ok(snap.stats.volumeOut > 0);
      assert.ok(snap.stats.volume < v0, 'open boundary can only remove water');
      assert.ok(snap.stats.massError < 1e-4);
    }
    solver.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});
