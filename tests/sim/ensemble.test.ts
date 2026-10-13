/**
 * Flood-probability ensembles on the GPU (src/sim/ensemble.ts) and the members' DEM perturbation
 * (GpuFloodSolver.setBedPerturbation, src/sim/demNoise.ts).
 *
 *  • An ensemble of IDENTICAL members gives probability exactly 0 or 1 in every cell, and the GPU tally equals the CPU
 *    mirror (src/loss/ensemble.ts ensembleCellUpdate) fed with each member's exported max depth.
 *  • A known perturbation — the inflow into a V-shaped valley on a slope at ×0.5 / ×1 / ×2 — floods a wider strip the
 *    more water there is, so the strip's edges carry intermediate probabilities (1/3, 2/3) and its core 1.
 *  • A bed perturbation that is zero under the initial water leaves a lake at rest at rest and the mass ledger exact,
 *    is removed exactly, and is dropped by a terrain reset.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice, gpuErrors, makeSolver, stepAndSnapshot } from '../helpers/gpu';
import { lakeAtRest } from '../helpers/terrain';
import { EnsembleAccumulator } from '../../src/sim/ensemble';
import { demPerturbation } from '../../src/sim/demNoise';
import { ENSEMBLE_PER_CELL, ensembleCellUpdate } from '../../src/loss/ensemble';
import type { GpuFloodSolver } from '../../src/sim';

after(finishGpuTests);

const nx = 64;
const ny = 96;
const dx = 2;

/** A valley running south (+j) at 1 %, with 3 % side slopes, so more inflow wets a wider strip. */
function valley(): Float32Array {
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = 100 + 0.01 * dx * (ny - 1 - j) + 0.03 * dx * Math.abs(i + 0.5 - nx / 2);
  return z;
}

async function runMember(solver: GpuFloodSolver, q: number): Promise<Float32Array> {
  solver.setSources([{ id: 'in', type: 'inflow', gx: nx / 2, gy: 4, radius: 2, discharge: q }]);
  solver.reset();
  // Fixed dt: identical members are then bit-for-bit identical runs.
  await stepAndSnapshot(solver, 1500, { dt: 0.05, chunk: 250 });
  return solver.readTexture(solver.stateTexture, 4);
}

test('identical members: probability is 0 or 1 everywhere, and the GPU tally matches the CPU mirror', async () => {
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation: valley(), params: { manningN: 0.03, boundary: 'open' } });
  const acc = new EnsembleAccumulator(await getDevice(), nx, ny);
  const cpu = new Float64Array(nx * ny * ENSEMBLE_PER_CELL);
  acc.clear();
  for (let m = 0; m < 3; m++) {
    const st = await runMember(solver, 2);
    acc.accumulate(solver.stateTexture);
    for (let c = 0; c < nx * ny; c++) ensembleCellUpdate(cpu, c, st[4 * c + 3]);
  }
  assert.equal(acc.members, 3);
  const g = await acc.read();
  let wet = 0;
  for (let c = 0; c < nx * ny; c++) {
    const k = c * 4;
    assert.ok(g[k] === 0 || g[k] === 3, `cell ${c}: ${g[k]} of 3 members over 0.15 m`);
    assert.ok(g[k + 1] === 0 || g[k + 1] === 3, `cell ${c}: ${g[k + 1]} of 3 over 0.5 m`);
    for (let s = 0; s < 4; s++) assert.ok(Math.abs(g[k + s] - cpu[k + s]) <= 1e-5 * Math.max(1, Math.abs(cpu[k + s])), `cell ${c} slot ${s}: GPU ${g[k + s]} vs CPU ${cpu[k + s]}`);
    if (g[k] === 3) wet++;
  }
  assert.ok(wet > 100, `the run floods something (${wet} cells)`);
  // clear() starts over.
  acc.clear();
  assert.equal(acc.members, 0);
  assert.ok((await acc.read()).every((v) => v === 0));
  acc.destroy();
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('a known perturbation (inflow ×0.5 / ×1 / ×2) gives intermediate probabilities at the edges of the flood', async () => {
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation: valley(), params: { manningN: 0.03, boundary: 'open' } });
  const acc = new EnsembleAccumulator(await getDevice(), nx, ny);
  acc.clear();
  const widths: number[] = [];
  for (const q of [1, 2, 4]) {
    const st = await runMember(solver, q);
    acc.accumulate(solver.stateTexture);
    // Width of the > 0.15 m strip across row 20.
    let w = 0;
    for (let i = 0; i < nx; i++) if (st[4 * (20 * nx + i) + 3] > 0.15) w++;
    widths.push(w);
  }
  assert.ok(widths[0] < widths[1] && widths[1] < widths[2], `strip widths ${widths}`);
  const g = await acc.read();
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < nx; i++) counts[g[4 * (20 * nx + i)]]++;
  // Across the valley: dry outside the widest strip, then 1/3 and 2/3 on the margins, 1 in the core.
  assert.ok(counts[1] >= 1 && counts[2] >= 1 && counts[3] >= 1, `cells with 0/1/2/3 of 3 members across row 20: ${counts}`);
  for (let i = 0; i < nx; i++) {
    const k = 4 * (20 * nx + i);
    assert.ok(g[k + 1] <= g[k], 'deeper than 0.5 m is rarer than deeper than 0.15 m');
    assert.ok(g[k + 3] * 3 + 1e-4 >= g[k + 2], 'the envelope is at least the mean');
  }
  acc.destroy();
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('bed perturbation: zero under the initial water keeps a lake at rest at rest; removed exactly; dropped by a terrain reset', async () => {
  const N = 64;
  const bed = new Float32Array(N * N);
  // A bowl: a lake in the middle, dry slopes around it.
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) bed[j * N + i] = 100 + 0.004 * ((i - N / 2) ** 2 + (j - N / 2) ** 2);
  const depth = lakeAtRest(bed, 102);
  const solver = await makeSolver({ nx: N, ny: N, cellSize: 4, elevation: bed, depth, params: { manningN: 0.03, boundary: 'wall' } });
  const ground0 = solver.getGroundCPU().slice();
  const delta = demPerturbation({ nx: N, ny: N, cellSize: 4, sigma: 0.3, corrLenM: 20, seed: 9, initialDepth: depth, elevation: bed });
  let touchedWet = 0;
  for (let c = 0; c < N * N; c++) if (depth[c] >= 0.01 && delta[c] !== 0) touchedWet++;
  assert.equal(touchedWet, 0, 'no perturbation under the initial water');
  solver.setBedPerturbation(delta);
  const g1 = solver.getGroundCPU();
  for (let c = 0; c < N * N; c++) assert.ok(Math.abs(g1[c] - (ground0[c] + delta[c])) < 1e-4);
  solver.reset();
  const snap = await stepAndSnapshot(solver, 800);
  assert.ok(snap.stats.maxSpeed < 1e-3, `the lake stays at rest: max speed ${snap.stats.maxSpeed}`);
  assert.ok(snap.stats.massError < 1e-6, `mass error ${snap.stats.massError}`);
  // Replacing it subtracts the old one first; null removes it exactly (the user's ground comes back bit for bit).
  solver.setBedPerturbation(demPerturbation({ nx: N, ny: N, cellSize: 4, sigma: 0.3, corrLenM: 20, seed: 10, initialDepth: depth, elevation: bed }));
  solver.setBedPerturbation(null);
  assert.ok(solver.getGroundCPU().every((v, c) => Math.abs(v - ground0[c]) < 1e-4), 'ground restored');
  assert.equal(solver.bedPerturbation, null);
  solver.setBedPerturbation(delta);
  solver.reset({ resetTerrain: true });
  assert.equal(solver.bedPerturbation, null, 'a terrain reset drops it');
  assert.ok(solver.getGroundCPU().every((v, c) => v === ground0[c]));
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});
