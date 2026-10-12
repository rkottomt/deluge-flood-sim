/**
 * Debris-flow rheology in the momentum pass (FloodSolver.setRheology; shaders/momentum.ts RHEOLOGY, src/sim/rheology.ts)
 * and the per-scenario speed cap.
 *
 *  • water stays the Manning code path bit for bit (and setRheology(water) after a debris law restores it exactly);
 *  • the GPU agrees with the Float64 CPU reference for every law;
 *  • analytic checks: Voellmy with μ = 0, ξ = h^{1/3}/n² is Manning (normal depth in a channel); a Bingham slab on an
 *    incline stays put below its yield criterion and flows at the analytic sheet-flow speed above it; a yield-stress
 *    dam break comes to rest as the analytic plastic plug, surface slope τ_y/(ρ·g·h);
 *  • extreme parameters stay finite and non-negative; mass accounting is unchanged; uMax 25 lets a front pass 15 m/s.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuReferenceSolver, type SchemeStepParams } from '../../src/sim/cpuReference';
import { GRAVITY } from '../../src/sim/constants';
import { rheologyCoefficients } from '../../src/sim/rheology';
import { packForcing } from '../../src/sim/forcing';
import type { Rheology } from '../../src/hazard/types';
import type { GpuFloodSolver } from '../../src/sim';
import { finishGpuTests, gpuErrors, makeSolver, stepAndSnapshot } from '../helpers/gpu';
import { roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

const GLENWOOD_1 = { name: 'Glenwood 1', a2: 0.0345, b2: 20.1, a1: 0.00283, b1: 23.0 };
const ASPEN_PIT_1 = { name: 'Aspen Pit 1', a2: 0.181, b2: 25.7, a1: 0.036, b1: 22.1 };

const LAWS: Array<{ label: string; r: Rheology; uMax?: number }> = [
  { label: 'Voellmy debris flood (μ 0.05, ξ 500)', r: { kind: 'voellmy', mu: 0.05, xi: 500 }, uMax: 25 },
  { label: 'Voellmy stiff (μ 0.25, ξ 200)', r: { kind: 'voellmy', mu: 0.25, xi: 200 } },
  { label: 'quadratic Glenwood 1, Cv 0.45', r: { kind: 'quadratic', cv: 0.45, material: GLENWOOD_1 } },
  { label: 'quadratic Aspen Pit 1, Cv 0.4, K 24', r: { kind: 'quadratic', cv: 0.4, material: ASPEN_PIT_1, K: 24 } },
  { label: 'Bingham τ_y 400 Pa, μ_B 30 Pa·s', r: { kind: 'bingham', tauY: 400, muB: 30, rho: 1900 } },
];

async function readHash(solver: GpuFloodSolver): Promise<Float32Array[]> {
  const s = await solver.debugReadState();
  return [s.h, s.qx, s.qy];
}

function bitwiseEqual(a: Float32Array[], b: Float32Array[]): boolean {
  for (let k = 0; k < a.length; k++) {
    const x = new Uint32Array(a[k].buffer, a[k].byteOffset, a[k].length);
    const y = new Uint32Array(b[k].buffer, b[k].byteOffset, b[k].length);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

test('water is the Manning code path bit for bit: setRheology(water) after a debris law restores it exactly', async () => {
  const nx = 64;
  const ny = 48;
  const elevation = roughTerrain(nx, ny, 7, 14, 120);
  const depth = new Float32Array(nx * ny);
  for (let j = 8; j < 30; j++) for (let i = 6; i < 26; i++) depth[j * nx + i] = 5;
  const run = async (prep: (s: GpuFloodSolver) => void) => {
    const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, depth, params: { boundary: 'open', manningN: 0.03, rainRate: 60 } });
    solver.setSources([{ id: 'a', type: 'inflow', gx: 50.2, gy: 10.7, radius: 2, discharge: 40 }]);
    prep(solver);
    solver.runSubsteps(400, Math.fround(0.2));
    const out = await readHash(solver);
    solver.destroy();
    return out;
  };
  const fresh = await run(() => {});
  const explicit = await run((s) => s.setRheology({ kind: 'water' }));
  const restored = await run((s) => {
    s.setRheology({ kind: 'bingham', tauY: 500, muB: 20, rho: 2000 }, { uMax: 25 });
    s.setRheology({ kind: 'water' });
  });
  const debris = await run((s) => s.setRheology({ kind: 'voellmy', mu: 0.1, xi: 300 }));
  assert.ok(bitwiseEqual(fresh, explicit), 'setRheology(water) changed the water result');
  assert.ok(bitwiseEqual(fresh, restored), 'water after a debris law is not the water result');
  assert.ok(!bitwiseEqual(fresh, debris), 'a debris law must change the result');
  assert.deepEqual(gpuErrors(), []);
});

test('setRheology: uMax defaults to options.uMax, is clamped, and reset() keeps the rheology', async () => {
  const nx = 16;
  const ny = 16;
  const solver = await makeSolver({ nx, ny, cellSize: 5, elevation: new Float32Array(nx * ny) });
  assert.equal(solver.speedCap, solver.options.uMax);
  solver.setRheology({ kind: 'voellmy', mu: 0.05, xi: 500 }, { uMax: 25 });
  assert.equal(solver.speedCap, 25);
  solver.reset();
  assert.equal(solver.speedCap, 25);
  assert.equal(solver.rheology.kind, 'voellmy');
  solver.setRheology({ kind: 'water' }, { uMax: NaN });
  assert.equal(solver.speedCap, solver.options.uMax);
  solver.setRheology({ kind: 'water' }, { uMax: 1e9 });
  assert.equal(solver.speedCap, 100);
  solver.setRheology({ kind: 'water' });
  assert.equal(solver.speedCap, 15);
  solver.destroy();
});

// ── GPU vs CPU reference ─────────────────────────────────────────────────────────────────────────────────────────

async function compareWithCpu(r: Rheology, uMax: number | undefined, resync: boolean) {
  const nx = 48;
  const ny = 32;
  const dx = 6;
  const elevation = roughTerrain(nx, ny, 99, 12, 140);
  const depth = new Float32Array(nx * ny);
  for (let j = 8; j < 22; j++) for (let i = 6; i < 20; i++) depth[j * nx + i] = 4;
  const params = { boundary: 'open' as const, manningN: 0.04, rainRate: 30 };
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params });
  const sources = [{ id: 'a', type: 'inflow' as const, gx: 35.2, gy: 9.7, radius: 2.5, discharge: 30 }];
  solver.setSources(sources);
  solver.setRheology(r, { uMax });
  const z0 = solver.z0;
  const zRel = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) zRel[k] = Math.fround(elevation[k] - z0);
  const cpu = new CpuReferenceSolver(nx, ny, zRel, depth);
  const o = solver.options;
  const dt = Math.fround(0.25);
  const rc = rheologyCoefficients(r, params.manningN);
  // The GPU reads Float32 coefficients.
  const rc32 = { ...rc, tauRho: Math.fround(rc.tauRho), mu: Math.fround(rc.mu), visc: Math.fround(rc.visc), n2: Math.fround(rc.n2), gXi: Math.fround(rc.gXi) };
  const sp: SchemeStepParams = {
    dt,
    dx,
    manningN: params.manningN,
    theta: o.theta,
    smoothingDepthRatio: o.smoothingDepthRatio,
    courantGuard: o.robustCflMax,
    hMin: o.hMin,
    uMax: solver.speedCap,
    froudeMax: o.froudeMax,
    advection: o.advection,
    wallAdvection: o.wallAdvection,
    rain: Math.fround(params.rainRate / 3.6e6),
    infiltration: 0,
    open: true,
    robust: true,
    boundaryMinSlope: o.boundaryMinSlope,
    boundaryFroudeMax: o.boundaryFroudeMax,
    stageAlpha: 1,
    forcing: packForcing(sources, [], nx, ny, dx, z0, (k) => elevation[k]),
    rheology: rc32,
  };
  let maxDh = 0;
  let maxH = 0;
  const steps = 300;
  const diff = (g: { h: Float32Array }) => {
    for (let k = 0; k < nx * ny; k++) {
      maxDh = Math.max(maxDh, Math.abs(g.h[k] - cpu.h[k]));
      maxH = Math.max(maxH, cpu.h[k]);
    }
  };
  if (resync) {
    for (let k = 0; k < steps; k++) {
      cpu.step(sp);
      solver.runSubsteps(1, dt);
      const g = await solver.debugReadState();
      diff(g);
      cpu.h = Float64Array.from(g.h);
      cpu.qx = Float64Array.from(g.qx);
      cpu.qy = Float64Array.from(g.qy);
    }
  } else {
    for (let k = 0; k < steps; k++) cpu.step(sp);
    solver.runSubsteps(steps, dt);
    diff(await solver.debugReadState());
  }
  const snap = await solver.readbackNow();
  const volRel = Math.abs(snap.stats.volume - cpu.volume(dx)) / cpu.volume(dx);
  solver.destroy();
  return { maxDh, maxH, volRel };
}

for (const law of LAWS) {
  test(`GPU matches the Float64 CPU reference: ${law.label}`, async () => {
    const free = await compareWithCpu(law.r, law.uMax, false);
    const step = await compareWithCpu(law.r, law.uMax, true);
    console.log(
      `  ${law.label}: free-running 300 steps max|Δh| ${free.maxDh.toExponential(2)} m (max h ${free.maxH.toFixed(2)} m, ΔV ${free.volRel.toExponential(1)}); ` +
        `per step ${step.maxDh.toExponential(2)} m`,
    );
    assert.ok(free.maxDh < 2e-3, `free-running max |Δh| ${free.maxDh}`);
    assert.ok(step.maxDh < 1e-4, `per-step max |Δh| ${step.maxDh}`);
    assert.ok(free.volRel < 1e-4, `volume ${free.volRel}`);
    assert.deepEqual(gpuErrors(), []);
  });
}

// ── (a) Voellmy μ = 0, ξ = h^{1/3}/n² is Manning ─────────────────────────────────────────────────────────────────────

/** Reach-averaged depth of uniform flow in a straight walled channel along x (the 0° case of tests/sim/channel.test.ts). */
async function channelDepth(rheology: Rheology | null): Promise<{ depth: number; discharge: number }> {
  const nx = 256;
  const ny = 32;
  const dx = 7;
  const slope = 0.003;
  const width = 56; // 8 cells
  const j0 = 12;
  const elevation = new Float32Array(nx * ny).fill(200);
  const depth = new Float32Array(nx * ny);
  const pit = nx - 40;
  for (let j = j0; j < j0 + width / dx; j++) {
    for (let i = 2; i < nx - 2; i++) {
      elevation[j * nx + i] = i >= pit ? -100 : 100 - slope * i * dx;
      if (i < pit) depth[j * nx + i] = CH_NORMAL;
    }
  }
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: CH_N } });
  solver.setSources([{ id: 'q', type: 'inflow', gx: 8, gy: j0 + width / dx / 2, radius: 3, discharge: CH_Q }]);
  if (rheology) solver.setRheology(rheology);
  while (solver.time < 1800) {
    solver.runSubsteps(100);
    await solver.readbackNow();
  }
  const st = await solver.debugReadState();
  let sum = 0;
  let n = 0;
  for (let j = j0 + 2; j < j0 + width / dx - 2; j++) {
    for (let i = 40; i < pit - 30; i++) {
      sum += st.h[j * nx + i];
      n++;
    }
  }
  let q = 0;
  const im = Math.round((40 + pit - 30) / 2);
  for (let j = 0; j < ny; j++) q += st.qx[j * nx + im] * dx;
  solver.destroy();
  return { depth: sum / n, discharge: q };
}
const CH_N = 0.035;
const CH_Q = 500;
const CH_NORMAL = Math.pow(((CH_Q / 56) * CH_N) / Math.sqrt(0.003), 0.6);

test('(a) Voellmy with μ = 0 and ξ = h^{1/3}/n² reproduces Manning normal depth in a channel (±2 %)', async () => {
  const xi = Math.cbrt(CH_NORMAL) / (CH_N * CH_N);
  const manning = await channelDepth(null);
  const voellmy = await channelDepth({ kind: 'voellmy', mu: 0, xi });
  console.log(
    `  normal depth ${CH_NORMAL.toFixed(3)} m (ξ ${xi.toFixed(0)} m/s²): Manning ${manning.depth.toFixed(3)} m (Q ${manning.discharge.toFixed(0)}), ` +
      `Voellmy ${voellmy.depth.toFixed(3)} m (Q ${voellmy.discharge.toFixed(0)}); Voellmy / Manning ${(voellmy.depth / manning.depth).toFixed(4)}, ` +
      `Voellmy / normal ${(voellmy.depth / CH_NORMAL).toFixed(4)}`,
  );
  assert.ok(Math.abs(voellmy.discharge / CH_Q - 1) < 0.03, `not steady: Q ${voellmy.discharge}`);
  assert.ok(Math.abs(voellmy.depth / manning.depth - 1) < 0.02, `Voellmy / Manning ${voellmy.depth / manning.depth}`);
  assert.ok(Math.abs(voellmy.depth / CH_NORMAL - 1) < 0.02, `Voellmy / normal depth ${voellmy.depth / CH_NORMAL}`);
  assert.deepEqual(gpuErrors(), []);
});

// ── (b) Bingham slab on an incline ───────────────────────────────────────────────────────────────────────────────

const SLAB = { nx: 256, ny: 16, dx: 5, S: 0.1, h: 1, rho: 2000, muB: 200, i0: 40, i1: 160 };

async function slab(tauY: number, seconds: number) {
  const { nx, ny, dx, S, h, i0, i1 } = SLAB;
  const elevation = new Float32Array(nx * ny);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      elevation[j * nx + i] = 200 - S * i * dx;
      if (i >= i0 && i < i1) depth[j * nx + i] = h;
    }
  }
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall' } });
  solver.setRheology({ kind: 'bingham', tauY, muB: SLAB.muB, rho: SLAB.rho });
  const dt = Math.fround(0.1);
  solver.runSubsteps(Math.round(seconds / dt), dt);
  const st = await solver.debugReadState();
  // Interior: the middle of the slab, well away from its slumping ends.
  const im = Math.round((i0 + i1) / 2);
  let qMid = 0;
  let hMid = 0;
  for (let j = 2; j < ny - 2; j++) {
    qMid += st.qx[j * nx + im] / (ny - 4);
    hMid += st.h[j * nx + im] / (ny - 4);
  }
  let xMass = 0;
  let mass = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      xMass += st.h[j * nx + i] * (i + 0.5);
      mass += st.h[j * nx + i];
    }
  }
  solver.destroy();
  return { uMid: qMid / Math.max(hMid, 1e-9), hMid, centre: xMass / mass };
}

test('(b) a Bingham slab on an incline stays put when ρ·g·h·sinθ < τ_y and flows at the sheet-flow speed when above', async () => {
  const { S, h, rho, muB, i0, i1 } = SLAB;
  const drive = rho * GRAVITY * h * S; // Pa; the solver's driving stress uses the surface slope tanθ ≈ sinθ (θ = 5.7°)
  const centre0 = (i0 + i1) / 2;
  const stiff = await slab(drive / 0.8, 60);
  const soft = await slab(drive / 1.25, 20);
  // Analytic interior speed of the sheet law: g·h·S = τ_y/ρ + (3·μ_B/ρ)·u/h.
  const uSheet = ((GRAVITY * h * S - drive / 1.25 / rho) * h * rho) / (3 * muB);
  console.log(
    `  driving stress ${drive.toFixed(0)} Pa: τ_y = 1.25× → interior u ${stiff.uMid.toExponential(2)} m/s, h ${stiff.hMid.toFixed(3)} m, ` +
      `centre moved ${(stiff.centre - centre0).toFixed(2)} cells; τ_y = 0.8× → interior u ${soft.uMid.toFixed(3)} m/s ` +
      `(sheet law ${uSheet.toFixed(3)} m/s), centre moved ${(soft.centre - centre0).toFixed(1)} cells`,
  );
  assert.equal(stiff.uMid, 0, 'interior of a slab below its yield criterion must be exactly at rest');
  assert.ok(Math.abs(stiff.hMid - h) < 1e-4, `interior depth changed: ${stiff.hMid}`);
  assert.ok(Math.abs(stiff.centre - centre0) < 1, `slab below yield slid ${stiff.centre - centre0} cells`);
  assert.ok(Math.abs(soft.uMid / uSheet - 1) < 0.05, `interior speed ${soft.uMid} vs sheet law ${uSheet}`);
  // It slides as a body: the centre of mass moves at least half the sheet-law distance in 20 s (the ends slump and lag).
  assert.ok(((soft.centre - centre0) * SLAB.dx) / (uSheet * 20) > 0.5, `slab above yield moved only ${soft.centre - centre0} cells`);
  assert.deepEqual(gpuErrors(), []);
});

// ── (c) yield-stress dam break → analytic plug ───────────────────────────────────────────────────────────────────

/**
 * A 2 m deep, 40 m long block of Bingham material against a wall on a flat bed, released (1-D, dx = 1 m). Returns the
 * deposit once the flow is at rest (maxSpeed < `restSpeed`), with the slope ratio g·hf·|∂η/∂x| / (τ_y/ρ) of every face
 * in the deposit's body: at rest it cannot exceed 1 (the face would move), and the analytic plug has exactly 1.
 */
async function yieldDamBreak(muB: number, restSpeed: number) {
  const nx = 256;
  const ny = 16;
  const dx = 1;
  const elevation = new Float32Array(nx * ny).fill(10);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < PLUG.L; i++) depth[j * nx + i] = PLUG.h0;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall' } });
  solver.setRheology({ kind: 'bingham', tauY: PLUG.tauY, muB, rho: PLUG.rho });
  let rest = -1;
  for (let k = 0; k < 80 && rest < 0; k++) {
    const snap = await stepAndSnapshot(solver, 200);
    if (snap.stats.maxSpeed <= restSpeed) rest = snap.simTime;
  }
  const st = await solver.debugReadState();
  solver.destroy();
  const j = ny >> 1;
  const hRow = Array.from({ length: nx }, (_, i) => st.h[j * nx + i]);
  let front = 0;
  while (front < nx && hRow[front] > 1e-3) front++;
  const ratios: number[] = [];
  for (let i = 3; i < front - 4; i++) {
    // The face depth the momentum pass uses on a flat bed: the deeper side.
    const hf = Math.max(hRow[i], hRow[i + 1]);
    ratios.push((GRAVITY * hf * ((hRow[i] - hRow[i + 1]) / dx)) / (PLUG.tauY / PLUG.rho));
  }
  return { rest, front, hWall: hRow[0], mean: ratios.reduce((a, b) => a + b, 0) / ratios.length, max: Math.max(...ratios), n: ratios.length };
}
const PLUG = { tauY: 200, rho: 2000, h0: 2, L: 40 };

test('(c) a yield-stress dam break comes to rest as the plastic plug, surface slope ≈ τ_y/(ρ·g·h)', async () => {
  // Analytic plug on a flat bed against a wall (x from the wall): h·dh/dx = −k, k = τ_y/(ρ·g) → h(x)² = 2·k·(x_f − x),
  // x_f from the volume (2/3)·√(2k)·x_f^{3/2} = h0·L.
  const k = PLUG.tauY / (PLUG.rho * GRAVITY);
  const xf = Math.pow((1.5 * PLUG.h0 * PLUG.L) / Math.sqrt(2 * k), 2 / 3);
  const hWall = Math.sqrt(2 * k * xf);
  // Creeping slump (μ_B 200 Pa·s: viscous, inertia negligible) — the regime the static plug describes. It approaches
  // rest exponentially, so "at rest" is max speed < 1 mm/s.
  const creep = await yieldDamBreak(200, 1e-3);
  // Inertial slump (μ_B 20 Pa·s): it overshoots the plug and stops EXACTLY (max speed 0), thinner than the plug.
  const inertial = await yieldDamBreak(20, 0);
  const line = (r: typeof creep) =>
    `at rest at t = ${r.rest.toFixed(0)} s, front ${r.front} m, depth at wall ${r.hWall.toFixed(3)} m, ` +
    `slope / (τ_y/(ρ·g·h)) mean ${r.mean.toFixed(3)} max ${r.max.toFixed(3)} over ${r.n} faces`;
  console.log(`  analytic plug: front ${xf.toFixed(1)} m, depth at wall ${hWall.toFixed(3)} m, slope ratio 1`);
  console.log(`  creeping (μ_B 200 Pa·s): ${line(creep)}`);
  console.log(`  inertial (μ_B 20 Pa·s):  ${line(inertial)}`);
  assert.ok(creep.rest > 0, 'the creeping slump never came to rest');
  assert.ok(Math.abs(creep.mean - 1) < 0.02, `creeping deposit slope ratio ${creep.mean}`);
  assert.ok(creep.max < 1.02, `creeping deposit max slope ratio ${creep.max}`);
  assert.ok(Math.abs(creep.front / xf - 1) < 0.03, `front ${creep.front} m vs analytic ${xf} m`);
  assert.ok(Math.abs(creep.hWall / hWall - 1) < 0.02, `depth at wall ${creep.hWall} m vs analytic ${hWall} m`);
  assert.ok(inertial.rest > 0, 'the inertial slump never came to exact rest');
  // Exactly at rest, no face can exceed its yield criterion (it would move), up to Float32 rounding.
  assert.ok(inertial.max <= 1.001, `a face at rest beyond its yield criterion: ${inertial.max}`);
  assert.ok(inertial.front > creep.front, 'the inertial slump runs out further than the plug');
  assert.deepEqual(gpuErrors(), []);
});

// ── (d) extreme parameters ───────────────────────────────────────────────────────────────────────────────────────

test('(d) extreme rheology parameters: no NaN, no negative depth', async () => {
  const nx = 64;
  const ny = 64;
  const dx = 4;
  const elevation = roughTerrain(nx, ny, 5, 40, 300);
  const depth = new Float32Array(nx * ny);
  for (let j = 10; j < 40; j++) for (let i = 10; i < 40; i++) depth[j * nx + i] = 15;
  const extremes: Array<[string, Rheology, number?]> = [
    ['Voellmy frictionless', { kind: 'voellmy', mu: 0, xi: 1e12 }, 100],
    ['Voellmy ξ → 0, μ 10', { kind: 'voellmy', mu: 10, xi: 1e-9 }],
    ['Voellmy NaN / negative', { kind: 'voellmy', mu: NaN, xi: -5 }],
    ['Bingham τ_y 1e12, μ_B 1e12', { kind: 'bingham', tauY: 1e12, muB: 1e12, rho: 1 }],
    ['Bingham weightless, inviscid', { kind: 'bingham', tauY: 0, muB: 0, rho: Infinity }],
    ['quadratic Cv 0.9 stiff, K huge', { kind: 'quadratic', cv: 0.9, material: ASPEN_PIT_1, K: 1e9 }],
    ['quadratic Cv 0, K 0', { kind: 'quadratic', cv: 0, material: GLENWOOD_1, K: 0 }],
    ['unknown kind', { kind: 'lava' } as unknown as Rheology],
  ];
  for (const [label, r, uMax] of extremes) {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'open', manningN: 0.03, rainRate: 200 } });
    solver.setRheology(r, { uMax });
    const snap = await stepAndSnapshot(solver, 600, { chunk: 50 });
    const st = await solver.debugReadState();
    let minH = Infinity;
    let finite = true;
    for (let k = 0; k < nx * ny; k++) {
      minH = Math.min(minH, st.h[k]);
      if (!Number.isFinite(st.h[k]) || !Number.isFinite(st.qx[k]) || !Number.isFinite(st.qy[k])) finite = false;
    }
    console.log(`  ${label}: max speed ${snap.stats.maxSpeed.toFixed(2)} m/s, min h ${minH}, massError ${snap.stats.massError.toExponential(1)}`);
    assert.ok(finite, `${label}: non-finite state`);
    assert.ok(minH >= 0, `${label}: negative depth ${minH}`);
    assert.ok(snap.stats.maxSpeed <= solver.speedCap + 1e-3, `${label}: speed ${snap.stats.maxSpeed}`);
    assert.ok(snap.stats.massError < 1e-4, `${label}: massError ${snap.stats.massError}`);
    solver.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});

// ── (e) mass accounting ──────────────────────────────────────────────────────────────────────────────────────────

test('(e) mass accounting is unchanged under every rheology: closed domain exact, open domain massError < 1e-5', async () => {
  const nx = 96;
  const ny = 96;
  const dx = 8;
  const elevation = roughTerrain(nx, ny, 42, 40, 300);
  const depth = new Float32Array(nx * ny);
  for (let j = 20; j < 60; j++) for (let i = 30; i < 70; i++) depth[j * nx + i] = 12;
  for (const law of LAWS) {
    for (const boundary of ['wall', 'open'] as const) {
      const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary, manningN: 0.03, rainRate: boundary === 'open' ? 40 : 0 } });
      if (boundary === 'open') solver.setSources([{ id: 'in', type: 'inflow', gx: 80, gy: 20, radius: 3, discharge: 50 }]);
      solver.setRheology(law.r, { uMax: law.uMax });
      const v0 = (await solver.readbackNow()).stats.volume;
      let worst = 0;
      let snap = await solver.readbackNow();
      for (let k = 0; k < 10; k++) {
        snap = await stepAndSnapshot(solver, 200, { chunk: 100 });
        worst = Math.max(worst, snap.stats.massError);
      }
      if (boundary === 'wall') {
        const rel = Math.abs(snap.stats.volume - v0) / v0;
        assert.ok(rel < 1e-4, `${law.label}: closed-domain volume error ${rel}`);
        assert.equal(snap.stats.volumeOut, 0);
      }
      assert.ok(worst < 1e-5, `${law.label} (${boundary}): massError ${worst}`);
      solver.destroy();
    }
  }
  assert.deepEqual(gpuErrors(), []);
});

// ── (f) per-scenario speed cap ───────────────────────────────────────────────────────────────────────────────────

test('(f) uMax 25 lets a steep dam-break front pass 15 m/s; the default cap holds it at 15', async () => {
  const nx = 256;
  const ny = 16;
  const dx = 5;
  const elevation = new Float32Array(nx * ny);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      elevation[j * nx + i] = 400 - 0.25 * i * dx;
      if (i < 30) depth[j * nx + i] = 12;
    }
  }
  const run = async (r: Rheology, uMax?: number) => {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'open', manningN: 0.01 } });
    solver.setRheology(r, { uMax });
    let peak = 0;
    for (let k = 0; k < 20; k++) {
      const snap = await stepAndSnapshot(solver, 40, { chunk: 20 });
      peak = Math.max(peak, snap.stats.maxSpeed);
    }
    const cap = solver.speedCap;
    solver.destroy();
    return { peak, cap };
  };
  const water15 = await run({ kind: 'water' });
  const water25 = await run({ kind: 'water' }, 25);
  const debris25 = await run({ kind: 'voellmy', mu: 0.05, xi: 500 }, 25);
  console.log(
    `  peak speed: water, default cap ${water15.peak.toFixed(2)} m/s; water, uMax 25 ${water25.peak.toFixed(2)} m/s; ` +
      `Voellmy debris flood, uMax 25 ${debris25.peak.toFixed(2)} m/s`,
  );
  assert.ok(water15.peak <= 15 + 1e-3, `default cap exceeded: ${water15.peak}`);
  assert.ok(water25.peak > 15.5 && water25.peak <= 25 + 1e-3, `uMax 25: ${water25.peak}`);
  assert.ok(debris25.peak > 15.5 && debris25.peak <= 25 + 1e-3, `debris uMax 25: ${debris25.peak}`);
  assert.deepEqual(gpuErrors(), []);
});
