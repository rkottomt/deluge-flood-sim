/**
 * Timestep stability of the robust scheme in DEEP water (rivers, reservoirs), where friction is weak and the
 * stability limit of the explicit gravity-wave update is what matters.
 *
 * Von Neumann analysis of our staggered forward–backward scheme with de Almeida θ-smoothing (see
 * GpuFloodSolver.computeDt): the 2-D checkerboard mode is stable only for C₁ = √(gh)·dt/dx ≤ √(θ/2), i.e.
 * the 2-D Courant number Cr = √2·C₁ ≤ √θ (≈ 0.894 for θ = 0.8). A solver that picks dt from the 1-D formula
 * dt = 0.7·dx/√(gh) sits on that limit: a disturbed deep basin then never calms down — it develops
 * grid-scale sloshing that only the velocity cap keeps bounded. These tests pin both sides of that line, and
 * check the local Courant guard (shaders/momentum.ts) that protects robust mode when dt is too large anyway
 * (stale readback).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { roughTerrain } from '../helpers/terrain';
import type { GpuFloodSolver } from '../../src/sim';

after(finishGpuTests);

const g = 9.81;
const nx = 96;
const ny = 96;
const dx = 6;

function basin(kind: 'flat' | 'rough') {
  const elevation = kind === 'flat' ? new Float32Array(nx * ny).fill(140) : roughTerrain(nx, ny, 99, 12, 140);
  let zmax = -Infinity;
  for (const z of elevation) zmax = Math.max(zmax, z);
  const depth = new Float32Array(nx * ny);
  // Everything submerged (≥ 8 m), plus a 3 m mound of water released at t = 0.
  for (let k = 0; k < nx * ny; k++) depth[k] = zmax + 8 - elevation[k];
  for (let j = 20; j < 40; j++) for (let i = 20; i < 40; i++) depth[j * nx + i] += 3;
  let hMax = 0;
  for (const h of depth) hMax = Math.max(hMax, h);
  return { elevation, depth, hMax };
}

/**
 * Mean |η − average of its 4 neighbours| over the interior, on the water SURFACE η = z + h (depth itself
 * follows the rough bed): large for checkerboard noise, ~0 for smooth long waves.
 */
function checkerboard(depth: ArrayLike<number>, bed: ArrayLike<number>): number {
  const eta = (c: number) => depth[c] + bed[c];
  let s = 0;
  let n = 0;
  for (let j = 1; j < ny - 1; j++)
    for (let i = 1; i < nx - 1; i++) {
      const c = j * nx + i;
      s += Math.abs(eta(c) - 0.25 * (eta(c - 1) + eta(c + 1) + eta(c - nx) + eta(c + nx)));
      n++;
    }
  return s / n;
}

/** Advance `seconds` of sim time the way the app does: solver-chosen dt, lagged readbacks between chunks. */
async function runLikeApp(solver: GpuFloodSolver, seconds: number) {
  let worstCourant = 0;
  while (solver.time < seconds) {
    solver.runSubsteps(20);
    const snap = await solver.readbackNow();
    worstCourant = Math.max(worstCourant, snap.stats.courant);
  }
  return { snap: await solver.readbackNow(), worstCourant };
}

for (const kind of ['flat', 'rough'] as const) {
  test(`robust mode at its maximum Courant number calms a disturbed deep basin (${kind} bed)`, async () => {
    const { elevation, depth } = basin(kind);
    // cfl 1.0 requested → clamped to robustCflMax.
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.03, cfl: 1.0 } });
    const { snap, worstCourant } = await runLikeApp(solver, 600);
    const cb = checkerboard(snap.depth, elevation);
    console.log(
      `  ${kind}: t=${snap.simTime.toFixed(0)} s, dt=${solver.computeDt().toFixed(3)} s, max speed ${snap.stats.maxSpeed.toFixed(3)} m/s, ` +
        `worst Courant ${worstCourant.toFixed(3)}, checkerboard ${cb.toExponential(2)} m, massError ${snap.stats.massError.toExponential(1)}`,
    );
    assert.ok(worstCourant <= solver.options.robustCflMax + 1e-6, `Courant ${worstCourant}`);
    assert.ok(worstCourant > 0.5, `Courant suspiciously low (${worstCourant}): dt is not using the budget`);
    assert.ok(snap.stats.maxSpeed < 1, `basin did not calm down: max speed ${snap.stats.maxSpeed}`);
    assert.ok(cb < 5e-3, `checkerboard noise ${cb}`);
    assert.ok(snap.stats.massError < 1e-5);
    assert.deepEqual(gpuErrors(), []);
    solver.destroy();
  });
}

test('a too-large dt (the 1-D formula: Cr = 0.7·√2 ≈ 0.99 > √θ) sloshes forever without the local Courant guard; the guard calms it', async () => {
  const { elevation, depth, hMax } = basin('flat');
  const dt = Math.fround((0.7 * dx) / Math.sqrt(g * hMax));
  const results: Record<string, { speed: number; cb: number }> = {};
  // robustCflMax is also the guard threshold; with a fixed dt, 100 simply switches the guard off.
  for (const [label, options] of [
    ['no guard', { robustCflMax: 100 }],
    ['guard', {}],
  ] as const) {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.03 }, options });
    solver.runSubsteps(Math.round(600 / dt), dt);
    const snap = await solver.readbackNow();
    results[label] = { speed: snap.stats.maxSpeed, cb: checkerboard(snap.depth, elevation) };
    console.log(
      `  ${label}: dt=${dt.toFixed(3)} s (Courant ${snap.stats.courant.toFixed(2)}): max speed ${snap.stats.maxSpeed.toFixed(2)} m/s, ` +
        `checkerboard ${results[label].cb.toExponential(2)} m, massError ${snap.stats.massError.toExponential(1)}`,
    );
    // Either way robust mode never produces garbage: bounded, finite, mass conserved.
    assert.ok(snap.stats.maxSpeed <= solver.options.uMax + 1e-3);
    assert.equal(solver.readbackDiagnostics.nonFiniteCells, 0);
    assert.ok(snap.stats.massError < 1e-5);
    solver.destroy();
  }
  assert.ok(results['no guard'].speed > 3, `expected sustained grid-scale sloshing, max speed ${results['no guard'].speed}`);
  assert.ok(results.guard.speed < 1, `guard should calm the basin, max speed ${results.guard.speed}`);
  assert.ok(results.guard.cb < 5e-3, `guard: checkerboard ${results.guard.cb}`);
  assert.deepEqual(gpuErrors(), []);
});

test('the first readbacks after switching on a big inflow or raising a stage level stay within the Courant limit', async () => {
  // The CFL timestep comes from the latest readback. After a reset (or a source change) that still shows calm water,
  // so the first window used to run at a dt sized for still water while the inflow jet / released water was already
  // moving at 5–15 m/s: the HUD read Courant 1.3–1.4 on loading Johnstown or raising Pittsburgh to the 1936 crest.
  const nx = 128;
  const ny = 128;
  const dx = 7;
  // A valley sloping to the south with a 6 m deep river channel, open boundaries.
  const elevation = new Float32Array(nx * ny);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const across = Math.abs(i + 0.5 - nx / 2) * dx;
      elevation[c] = 100 - 0.002 * j * dx + (across < 28 ? -6 : 0.05 * across);
      if (across < 28) depth[c] = 6;
    }
  }
  const run = async (label: string, configure: (s: Awaited<ReturnType<typeof makeSolver>>) => void) => {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'open', manningN: 0.035, timeScale: 60, maxSubstepsPerFrame: 64 } });
    const calmDt = solver.computeDt();
    configure(solver);
    const loadDt = solver.computeDt();
    const courants: number[] = [];
    let last = -1;
    for (let f = 0; f < 400 && courants.length < 4; f++) {
      solver.step(1 / 60);
      await solver.flush();
      const snap = solver.getSnapshot();
      if (snap && snap.simTime > 0 && snap.simTime !== last) {
        last = snap.simTime;
        courants.push(snap.stats.courant);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const settledDt = solver.computeDt();
    console.log(
      `  ${label}: dt calm ${calmDt.toFixed(3)} s → at load ${loadDt.toFixed(3)} s → after readbacks ${settledDt.toFixed(3)} s; ` +
        `Courant of the first readbacks ${courants.map((c) => c.toFixed(2)).join(', ')}`,
    );
    assert.ok(courants.length >= 2, 'readbacks should arrive');
    for (const c of courants) assert.ok(c <= solver.options.robustCflMax + 1e-6, `${label}: Courant ${c}`);
    assert.ok(loadDt < calmDt, `${label}: the load dt should anticipate the flow`);
    assert.ok(settledDt > loadDt, `${label}: the anticipation should be dropped once readbacks show the flow`);
    assert.deepEqual(gpuErrors(), []);
    solver.destroy();
  };
  await run('inflow 1,500 m³/s', (s) => s.setSources([{ id: 'q', type: 'inflow', gx: nx / 2, gy: 10, radius: 4, discharge: 1500 }]));
  await run('stage raised 8 m', (s) => s.setSources([{ id: 'st', type: 'stage', gx: nx / 2, gy: 0, radius: 12, level: 108 }]));
});
