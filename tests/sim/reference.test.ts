/**
 * GPU (Float32, parallel) vs CPU reference (Float64, serial) agreement on the same inputs.
 * The two are independent transcriptions of the scheme; agreement to ~1e-3 m after hundreds of steps of
 * violent flow means the WGSL does what the documented algorithm says.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuReferenceSolver, type SchemeStepParams } from '../../src/sim/cpuReference';
import { GRAVITY } from '../../src/sim/constants';
import { packForcing } from '../../src/sim/forcing';
import type { SimParams, StormCell, WaterSource } from '../../src/contracts';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

interface Case {
  label: string;
  params: Partial<SimParams>;
  sources?: WaterSource[];
  storms?: StormCell[];
  steps: number;
  tol: number;
  /** Fixed timestep, s (default 0.25). */
  dt?: number;
  /**
   * Re-start the CPU from the GPU state before every step and compare single steps. For chaotic flows, where
   * Float32 vs Float64 rounding (~1e-7 m per step) grows exponentially and a free-running comparison would test
   * the chaos rather than the transcription.
   */
  resync?: boolean;
  /** Extra uniform depth everywhere (m). */
  fill?: number;
  options?: Record<string, unknown>;
}

async function compare(c: Case) {
  const nx = 48;
  const ny = 32;
  const dx = 6;
  const elevation = roughTerrain(nx, ny, 99, 12, 140);
  const depth = new Float32Array(nx * ny);
  for (let j = 8; j < 22; j++) for (let i = 6; i < 20; i++) depth[j * nx + i] = 4;
  if (c.fill) for (let k = 0; k < nx * ny; k++) depth[k] += c.fill;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: c.params, options: c.options });
  solver.setSources(c.sources ?? []);
  solver.setStorms(c.storms ?? []);

  const z0 = solver.z0;
  const zRel = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) zRel[k] = Math.fround(elevation[k] - z0);
  const cpu = new CpuReferenceSolver(nx, ny, zRel, depth);
  const p = solver.params;
  const o = solver.options;
  const robust = p.stabilityMode !== 'naive';
  const dt = Math.fround(c.dt ?? 0.25);
  const sp: SchemeStepParams = {
    dt,
    dx,
    manningN: p.manningN,
    theta: robust ? o.theta : 1,
    smoothingDepthRatio: o.smoothingDepthRatio,
    courantGuard: o.robustCflMax,
    hMin: o.hMin,
    uMax: o.uMax,
    froudeMax: o.froudeMax,
    advection: o.advection,
    wallAdvection: o.wallAdvection,
    rain: Math.fround(p.rainRate / 3.6e6),
    infiltration: Math.fround(p.infiltrationRate / 3.6e6),
    open: p.boundary === 'open',
    robust,
    boundaryMinSlope: o.boundaryMinSlope,
    boundaryFroudeMax: o.boundaryFroudeMax,
    // Same rule as the GPU uniform (Solver.writeSimUniform): τ = 0 sets the level directly.
    stageAlpha: o.stageRelaxSeconds > 0 ? Math.fround(1 - Math.exp(-dt / o.stageRelaxSeconds)) : 1,
    forcing: packForcing(c.sources ?? [], c.storms ?? [], nx, ny, dx, z0, (k) => elevation[k]),
  };
  const v0 = cpu.volume(dx);
  let maxDh = 0;
  let maxDq = 0;
  let maxH = 0;
  const diff = (gpu: { h: Float32Array; qx: Float32Array; qy: Float32Array }) => {
    for (let k = 0; k < nx * ny; k++) {
      maxDh = Math.max(maxDh, Math.abs(gpu.h[k] - cpu.h[k]));
      maxDq = Math.max(maxDq, Math.abs(gpu.qx[k] - cpu.qx[k]), Math.abs(gpu.qy[k] - cpu.qy[k]));
      maxH = Math.max(maxH, cpu.h[k]);
    }
  };
  if (c.resync) {
    for (let k = 0; k < c.steps; k++) {
      cpu.step(sp);
      solver.runSubsteps(1, dt);
      const gpu = await solver.debugReadState();
      diff(gpu);
      cpu.h = Float64Array.from(gpu.h);
      cpu.qx = Float64Array.from(gpu.qx);
      cpu.qy = Float64Array.from(gpu.qy);
    }
  } else {
    for (let k = 0; k < c.steps; k++) cpu.step(sp);
    solver.runSubsteps(c.steps, dt);
    diff(await solver.debugReadState());
  }
  const snap = await solver.readbackNow();
  const cpuV = cpu.volume(dx);
  const volRel = Math.abs(snap.stats.volume - cpuV) / Math.max(cpuV, 1);
  const inRel = Math.abs(snap.stats.volumeIn - cpu.volumeIn) / Math.max(cpu.volumeIn, 1);
  const outRel = Math.abs(snap.stats.volumeOut - cpu.volumeOut) / Math.max(cpu.volumeOut, 1);
  console.log(
    `  ${c.label}: ${c.steps} steps, max h ${maxH.toFixed(2)} m, max|Δh| ${maxDh.toExponential(2)} m, max|Δq| ${maxDq.toExponential(2)} m²/s, ` +
      `ΔV ${volRel.toExponential(1)}, Δin ${inRel.toExponential(1)}, Δout ${outRel.toExponential(1)} (V0 ${v0.toFixed(0)} m³, c ${Math.sqrt(GRAVITY * maxH).toFixed(1)} m/s)`,
  );
  solver.destroy();
  return { maxDh, maxDq, volRel, inRel, outRel };
}

const cases: Case[] = [
  { label: 'wall, friction', params: { boundary: 'wall', manningN: 0.03 }, steps: 400, tol: 2e-3 },
  // Frictionless sloshing over rough terrain is chaotic: Float32 rounding (step 1 differs by ~3e-7 m) grows
  // exponentially through wet/dry edges and upwind switches, so a free-running comparison drifts apart within
  // ~100 steps whatever the transcription. Compare single steps from the GPU state instead (much tighter tolerance).
  { label: 'wall, frictionless (per step)', params: { boundary: 'wall', manningN: 0 }, steps: 400, tol: 1e-4, resync: true },
  { label: 'open, no advection', params: { boundary: 'open', manningN: 0.02 }, steps: 400, tol: 2e-3, options: { advection: false } },
  {
    label: 'open + rain + infiltration + storm + inflow + stage',
    params: { boundary: 'open', manningN: 0.04, rainRate: 120, infiltrationRate: 20 },
    sources: [
      { id: 'a', type: 'inflow', gx: 35.2, gy: 9.7, radius: 2.5, discharge: 30 },
      { id: 'b', type: 'stage', gx: 40.5, gy: 26.5, radius: 3, level: 150 },
      { id: 'c', type: 'inflow', gx: 0.3, gy: 31.9, radius: 1, discharge: 5 },
    ],
    storms: [{ id: 's', gx: 24, gy: 16, radius: 12, intensity: 400 }],
    steps: 400,
    tol: 2e-3,
  },
  // Naive (explicit friction, no limiter, θ = 1) is only stable without thin films, without the stiff explicit
  // open-boundary outflow and well inside the 2-D Courant limit: fully wet, deep, walled domain, Cr ≈ 0.18.
  // (At dt = 0.25 s this case is at Cr ≈ 0.9 with no smoothing and blows up within ~20 steps — as it should.)
  { label: 'naive mode, deep water', params: { boundary: 'wall', manningN: 0.03, stabilityMode: 'naive' }, fill: 20, steps: 400, dt: 0.05, tol: 2e-3 },
];

for (const c of cases) {
  test(`GPU matches the Float64 CPU reference: ${c.label}`, async () => {
    const r = await compare(c);
    assert.ok(r.maxDh < c.tol, `max |Δh| ${r.maxDh}`);
    assert.ok(r.volRel < 1e-4, `volume ${r.volRel}`);
    assert.ok(r.inRel < 1e-3, `volumeIn ${r.inRel}`);
    assert.ok(r.outRel < 1e-3, `volumeOut ${r.outRel}`);
    assert.deepEqual(gpuErrors(), []);
  });
}
