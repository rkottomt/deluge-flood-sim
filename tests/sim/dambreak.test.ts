/**
 * 1D dam break on a flat, frictionless, dry bed vs the Ritter (1892) analytic solution.
 *
 * Ritter: water of depth h0 behind a dam at x0 released at t = 0. With c0 = √(g·h0) and ξ = (x − x0)/t:
 *   h = h0                    for ξ ≤ −c0
 *   h = (2c0 − ξ)² / (9g)     for −c0 < ξ < 2c0
 *   h = 0                     for ξ ≥ 2c0          → the wet front travels at 2c0.
 *
 * TOLERANCE (documented): the analytic front is a zero-depth tip moving at 2c0. Any first-order scheme with
 * a wetting threshold smears that tip, so "front position" is measured where the numerical depth falls below
 * 5 % of h0 and compared with the Ritter position of that same depth, x5 = x0 + t·(2c0 − 3√(0.05·g·h0)).
 * Required: advance within ±15 % of the Ritter advance. We also require the whole profile to be close
 * (relative L1 error < 5 %), the depth at the dam site to be ≈ 4/9·h0 (±10 %), and the 20 %-depth point
 * within ±20 %. Typical result on the M4: 5 % front 0.96, L1 ≈ 2.4 %, h(x0) = 0.433.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';

after(finishGpuTests);

const g = 9.81;

async function runDamBreak(options: Record<string, unknown>, T: number) {
  const nx = 512;
  const ny = 16;
  const dx = 1;
  const h0 = 1;
  const x0 = 160; // dam position (m) = cell edge 160
  const elevation = new Float32Array(nx * ny).fill(100);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < x0; i++) depth[j * nx + i] = h0;
  const solver = await makeSolver({
    nx,
    ny,
    cellSize: dx,
    elevation,
    depth,
    params: { boundary: 'wall', manningN: 0, cfl: 0.7 },
    options,
  });
  // March with the solver's own CFL-adaptive dt, refreshing the lagged maxima from readbacks as the app does.
  while (solver.time < T - 1e-9) {
    const dt = Math.min(solver.computeDt(), T - solver.time);
    const n = Math.max(1, Math.min(20, Math.floor((T - solver.time) / dt)));
    solver.runSubsteps(n, Math.min(dt, (T - solver.time) / n));
    await solver.readbackNow();
  }
  const snap = await solver.readbackNow();
  const t = snap.simTime;
  const c0 = Math.sqrt(g * h0);
  const j = ny >> 1;
  const h = (i: number) => snap.depth[j * nx + i];
  const frontAt = (thr: number) => {
    let f = 0;
    for (let i = 0; i < nx; i++) if (h(i) > thr) f = (i + 1) * dx;
    return f;
  };
  const ritterX = (thr: number) => x0 + t * (2 * c0 - 3 * Math.sqrt(g * thr));
  const ritterH = (x: number) => {
    const xi = (x - x0) / t;
    if (xi <= -c0) return h0;
    if (xi >= 2 * c0) return 0;
    return (2 * c0 - xi) ** 2 / (9 * g);
  };
  let err = 0;
  let tot = 0;
  for (let i = 0; i < nx; i++) {
    const ha = ritterH((i + 0.5) * dx);
    err += Math.abs(h(i) - ha);
    tot += ha;
  }
  const ratio = (thr: number) => (frontAt(thr) - x0) / (ritterX(thr) - x0);
  // Transverse uniformity: the 16-row channel must behave one-dimensionally.
  let asym = 0;
  for (let jj = 0; jj < ny; jj++) for (let i = 0; i < nx; i++) asym = Math.max(asym, Math.abs(snap.depth[jj * nx + i] - h(i)));
  solver.destroy();
  return { t, ratio5: ratio(0.05 * h0), ratio1: ratio(0.01 * h0), ratio20: ratio(0.2 * h0), l1: err / tot, hDam: h(x0), asym, c0 };
}

test('dam break matches the Ritter solution (front at 5% depth within 15%, profile L1 < 5%)', async () => {
  const r = await runDamBreak({}, 20);
  console.log(
    `  Ritter @t=${r.t.toFixed(1)}s: front ratio 1%:${r.ratio1.toFixed(3)} 5%:${r.ratio5.toFixed(3)} 20%:${r.ratio20.toFixed(3)}` +
      `  L1=${(r.l1 * 100).toFixed(2)}%  h(x0)=${r.hDam.toFixed(4)} (Ritter 0.4444)  transverse max dev=${r.asym.toExponential(1)}`,
  );
  assert.ok(Math.abs(r.ratio5 - 1) < 0.15, `front (5% depth) advance ratio ${r.ratio5}`);
  // Secondary check on the thicker part of the rarefaction (first-order diffusion pushes it slightly ahead).
  assert.ok(Math.abs(r.ratio20 - 1) < 0.2, `front (20% depth) advance ratio ${r.ratio20}`);
  assert.ok(r.l1 < 0.05, `profile L1 error ${r.l1}`);
  assert.ok(Math.abs(r.hDam / (4 / 9) - 1) < 0.1, `depth at dam ${r.hDam}`);
  assert.ok(r.asym < 1e-3, `channel not 1D: ${r.asym}`);
  assert.deepEqual(gpuErrors(), []);
});

test('without advection (pure local-inertial) the front is too slow — why the advection term exists', async () => {
  const r = await runDamBreak({ advection: false }, 20);
  console.log(`  no advection: front ratio 5%:${r.ratio5.toFixed(3)}  L1=${(r.l1 * 100).toFixed(2)}%`);
  assert.ok(r.ratio5 < 0.8, `expected a clearly slower front without advection, got ${r.ratio5}`);
});
