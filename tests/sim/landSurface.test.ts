/**
 * Land-surface layers (FloodSolver.setLandSurface, ARCHITECTURE.md §3.11): building obstacles ("building block"), the
 * land-cover roughness map and storm drains.
 *
 *  • off, null and neutral layers (a uniform map at the default n, zero obstacles, zero drains) are the plain solver bit
 *    for bit; an obstacle is bit for bit a wall barrier of the same height (both are bed);
 *  • the GPU agrees with the Float64 CPU reference with a non-uniform roughness map, drains and obstacles;
 *  • drains remove exactly their capacity from standing water, booked as outflow; mass stays exact;
 *  • a lake at rest stays at rest among buildings and on a roughness map; switching obstacles on under standing water
 *    conserves mass; cells wet in the initial water are never blocked;
 *  • a channel with a row of buildings: no water in or through a footprint, the flow goes round, afflux upstream.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuReferenceSolver, type SchemeStepParams } from '../../src/sim/cpuReference';
import { MMHR_TO_MS } from '../../src/sim/constants';
import { packForcing } from '../../src/sim/forcing';
import type { GpuFloodSolver } from '../../src/sim';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { lakeAtRest, rng, roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

async function readState(solver: GpuFloodSolver): Promise<Float32Array[]> {
  const s = await solver.debugReadState();
  return [s.h, s.qx, s.qy, s.z];
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

/** Random 2×2-cell "buildings" on dry land (the footprint pattern of a city block on a 7.8 m grid), seeded. */
function scatterBuildings(nx: number, ny: number, seed: number, count: number, height = 12): Float32Array {
  const r = rng(seed);
  const o = new Float32Array(nx * ny);
  for (let k = 0; k < count; k++) {
    const i = 2 + Math.floor(r() * (nx - 5));
    const j = 2 + Math.floor(r() * (ny - 5));
    const w = 1 + Math.floor(r() * 3);
    const h = 1 + Math.floor(r() * 3);
    for (let jj = j; jj < Math.min(ny, j + h); jj++) for (let ii = i; ii < Math.min(nx, i + w); ii++) o[jj * nx + ii] = height;
  }
  return o;
}

// ── Neutral layers are the plain solver ─────────────────────────────────────────────────────────────────────────────

test('neutral layers are the plain solver bit for bit (uniform map at the default n, zero obstacles and drains, nulls)', async () => {
  const nx = 64;
  const ny = 48;
  const N = nx * ny;
  const elevation = roughTerrain(nx, ny, 7, 14, 120);
  const depth = new Float32Array(N);
  for (let j = 8; j < 30; j++) for (let i = 6; i < 26; i++) depth[j * nx + i] = 5;
  const run = async (prep: (s: GpuFloodSolver) => void, manningN = 0.03) => {
    const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, depth, params: { boundary: 'open', manningN, rainRate: 60, infiltrationRate: 5 } });
    solver.setSources([
      { id: 'a', type: 'inflow', gx: 50.2, gy: 10.7, radius: 2, discharge: 40 },
      { id: 's', type: 'stage', gx: 0, gy: 40, radius: 6, level: elevation[40 * nx + 2] + 2 },
    ]);
    prep(solver);
    solver.runSubsteps(400, Math.fround(0.2));
    const out = await readState(solver);
    solver.destroy();
    return out;
  };
  const plain = await run(() => {});
  const uniform = await run((s) => s.setLandSurface({ roughness: new Float32Array(N).fill(0.035) }));
  const zeros = await run((s) => s.setLandSurface({ obstacles: new Float32Array(N), drainCapacity: new Float32Array(N) }));
  const nulls = await run((s) => s.setLandSurface({ obstacles: null, roughness: null, drainCapacity: null }));
  const offAgain = await run((s) => {
    s.setLandSurface({ obstacles: scatterBuildings(nx, ny, 1, 20), roughness: new Float32Array(N).fill(0.1), drainCapacity: new Float32Array(N).fill(50) });
    s.setLandSurface({ obstacles: null, roughness: null, drainCapacity: null });
  });
  // The open-boundary normal flow uses the global n (shaders/common.ts bflux), so compare the scaling in a closed box
  // without the stage disc.
  const closed = async (prep: (s: GpuFloodSolver) => void, manningN: number) => {
    const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, depth, params: { boundary: 'wall', manningN, rainRate: 60 } });
    solver.setSources([{ id: 'a', type: 'inflow', gx: 50.2, gy: 10.7, radius: 2, discharge: 40 }]);
    prep(solver);
    solver.runSubsteps(400, Math.fround(0.2));
    const out = await readState(solver);
    solver.destroy();
    return out;
  };
  const rough = await closed((s) => s.setLandSurface({ roughness: new Float32Array(N).fill(0.06) }), 0.03);
  const plainN = await closed(() => {}, 0.03 * (0.06 / 0.035));
  assert.ok(bitwiseEqual(plain, uniform), 'a uniform map at the default n changed the result');
  assert.ok(bitwiseEqual(plain, zeros), 'zero obstacles / zero drains changed the result');
  assert.ok(bitwiseEqual(plain, nulls), 'null layers changed the result');
  assert.ok(bitwiseEqual(plain, offAgain), 'switching every layer off again did not restore the plain solver');
  // A uniform map at n scales the global n: 0.03 × 0.06/0.035 everywhere (equal up to the Float32 rounding of n²).
  let maxDh = 0;
  for (let c = 0; c < N; c++) maxDh = Math.max(maxDh, Math.abs(rough[0][c] - plainN[0][c]));
  assert.ok(maxDh < 1e-4, `uniform map at 0.06 vs global n scaled the same: max |Δh| ${maxDh}`);
  assert.ok(!bitwiseEqual(plain, rough), 'a rougher map must change the result');
  assert.deepEqual(gpuErrors(), []);
});

test('an obstacle is bit for bit the same height raised into the terrain (both are bed); roofs only shed rain', async () => {
  const nx = 48;
  const ny = 32;
  const N = nx * ny;
  const elevation = roughTerrain(nx, ny, 5, 6, 80);
  const depth = new Float32Array(N);
  const lake = lakeAtRest(elevation, 80.6);
  for (let c = 0; c < N; c++) depth[c] = c % nx < 14 ? lake[c] : 0;
  const obstacles = scatterBuildings(nx, ny, 9, 18, 15);
  for (let c = 0; c < N; c++) {
    const i = c % nx;
    const j = Math.floor(c / nx);
    // Keep the lake and the inflow's footprint open.
    if (depth[c] > 0 || Math.hypot(i + 0.5 - 30.3, j + 0.5 - 12.2) < 4) obstacles[c] = 0;
  }
  const raised = Float32Array.from(elevation, (z, c) => z + obstacles[c]);
  const run = async (terrain: Float32Array, prep: (s: GpuFloodSolver) => void) => {
    const solver = await makeSolver({ nx, ny, cellSize: 6, elevation: terrain, depth, params: { boundary: 'wall', manningN: 0.035, rainRate: 80 } });
    solver.setSources([{ id: 'a', type: 'inflow', gx: 30.3, gy: 12.2, radius: 2, discharge: 15 }]);
    prep(solver);
    solver.runSubsteps(400, Math.fround(0.15));
    const out = await readState(solver);
    solver.destroy();
    return out;
  };
  const asObstacle = await run(elevation, (s) => s.setLandSurface({ obstacles }));
  const asTerrain = await run(raised, () => {});
  assert.ok(bitwiseEqual(asObstacle, asTerrain), 'identical beds must give identical results');
  // Water never floods a blocked cell: the rain falling on a roof runs off it as a film.
  let maxRoof = 0;
  for (let c = 0; c < N; c++) if (obstacles[c] > 0) maxRoof = Math.max(maxRoof, asObstacle[0][c]);
  console.log(`  deepest water on a roof after 60 s of 80 mm/hr: ${(maxRoof * 1000).toFixed(2)} mm`);
  assert.ok(maxRoof < 0.005, `deepest water on a roof ${maxRoof} m`);
  assert.deepEqual(gpuErrors(), []);
});

// ── GPU vs CPU reference ─────────────────────────────────────────────────────────────────────────────────────────────

test('GPU matches the Float64 CPU reference with a roughness map, drains and obstacles', async () => {
  const nx = 48;
  const ny = 32;
  const N = nx * ny;
  const dx = 6;
  const elevation = roughTerrain(nx, ny, 99, 12, 140);
  const depth = new Float32Array(N);
  for (let j = 8; j < 22; j++) for (let i = 6; i < 20; i++) depth[j * nx + i] = 4;
  const r = rng(4);
  const roughN = Float32Array.from({ length: N }, () => 0.02 + 0.13 * r());
  const drainMmHr = Float32Array.from({ length: N }, (_, c) => ((c * 7) % 5 === 0 ? 0 : 20 + 40 * r()));
  const obstacles = scatterBuildings(nx, ny, 3, 25, 10);
  for (let c = 0; c < N; c++) if (depth[c] > 0) obstacles[c] = 0;
  const params = { boundary: 'open' as const, manningN: 0.04, rainRate: 30, drainageScale: 1.5 };
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params });
  const sources = [{ id: 'a', type: 'inflow' as const, gx: 35.2, gy: 9.7, radius: 2.5, discharge: 30 }];
  solver.setSources(sources);
  solver.setLandSurface({ roughness: roughN, drainCapacity: drainMmHr, obstacles });
  const z0 = solver.z0;
  const zRel = new Float64Array(N);
  for (let k = 0; k < N; k++) zRel[k] = Math.fround(Math.fround(elevation[k]) + obstacles[k]) - z0;
  const o = solver.options;
  const dt = Math.fround(0.25);
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
    forcing: packForcing(sources, [], nx, ny, dx, z0, (k) => elevation[k] + obstacles[k]),
    // What the GPU holds: Float32 factors n/0.035 and capacities in m/s, times the Float32 scale.
    roughness: Float32Array.from(roughN, (n) => n / 0.035),
    drain: Float64Array.from(drainMmHr, (v) => Math.fround(Math.fround(v * MMHR_TO_MS) * Math.fround(1.5))),
  };
  const steps = 300;
  const diff = (g: { h: Float32Array }, cpu: CpuReferenceSolver) => {
    let m = 0;
    for (let k = 0; k < N; k++) m = Math.max(m, Math.abs(g.h[k] - cpu.h[k]));
    return m;
  };
  // Free-running.
  const free = new CpuReferenceSolver(nx, ny, zRel, depth);
  for (let k = 0; k < steps; k++) free.step(sp);
  solver.runSubsteps(steps, dt);
  const g = await solver.debugReadState();
  const freeDh = diff(g, free);
  const snap = await solver.readbackNow();
  const volRel = Math.abs(snap.stats.volume - free.volume(dx)) / free.volume(dx);
  const outRel = Math.abs(snap.stats.volumeOut - free.volumeOut) / free.volumeOut;
  // Per step from the GPU state.
  solver.reset();
  const step = new CpuReferenceSolver(nx, ny, zRel, depth);
  let stepDh = 0;
  for (let k = 0; k < 120; k++) {
    step.step(sp);
    solver.runSubsteps(1, dt);
    const s = await solver.debugReadState();
    stepDh = Math.max(stepDh, diff(s, step));
    step.h = Float64Array.from(s.h);
    step.qx = Float64Array.from(s.qx);
    step.qy = Float64Array.from(s.qy);
  }
  console.log(
    `  roughness map + drains + obstacles: free-running ${steps} steps max|Δh| ${freeDh.toExponential(2)} m (ΔV ${volRel.toExponential(1)}, ` +
      `Δ volumeOut ${outRel.toExponential(1)}); per step ${stepDh.toExponential(2)} m`,
  );
  assert.ok(freeDh < 2e-3, `free-running max |Δh| ${freeDh}`);
  assert.ok(stepDh < 1e-4, `per-step max |Δh| ${stepDh}`);
  assert.ok(volRel < 1e-4, `volume ${volRel}`);
  assert.ok(outRel < 1e-3, `volumeOut ${outRel}`);
  assert.ok(snap.stats.massError < 1e-5, `massError ${snap.stats.massError}`);
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

// ── Drains ───────────────────────────────────────────────────────────────────────────────────────────────────────────

test('drains remove exactly their capacity from standing water and book it as outflow', async () => {
  const nx = 32;
  const ny = 32;
  const N = nx * ny;
  const dx = 5;
  const elevation = new Float32Array(N).fill(50);
  const depth = new Float32Array(N).fill(1);
  const drain = new Float32Array(N);
  // Half the basin drains at 36 mm/hr = 1e-5 m/s, the other half at 0.
  for (let c = 0; c < N; c++) if (c % nx < nx / 2) drain[c] = 36;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.035, drainageScale: 2 } });
  solver.setLandSurface({ drainCapacity: drain });
  const T = 600;
  const n = 1200;
  solver.runSubsteps(n, T / n);
  const snap = await solver.readbackNow();
  const expectOut = (N / 2) * dx * dx * 36 * MMHR_TO_MS * 2 * T;
  const rel = Math.abs(snap.stats.volumeOut - expectOut) / expectOut;
  console.log(`  drains: out ${snap.stats.volumeOut.toFixed(3)} m³ vs capacity × time ${expectOut.toFixed(3)} m³ (rel ${rel.toExponential(1)}), massError ${snap.stats.massError.toExponential(1)}`);
  // Each substep removes 1e-5 m from ~1 m of water, snapped to the depth's Float32 grid (6e-8 m just below 1 m): the
  // removal can differ from the nominal capacity by up to ~0.6 % (the same holds for infiltration). What is removed
  // is booked exactly — massError is the exactness check.
  assert.ok(rel < 1e-2, `drained ${snap.stats.volumeOut} vs ${expectOut}`);
  assert.ok(snap.stats.massError < 1e-6, `massError ${snap.stats.massError}`);
  // Drains never take more than is there: a thin film on a drained cell empties to exactly 0, never below.
  const thin = await makeSolver({ nx, ny, cellSize: dx, elevation, depth: new Float32Array(N).fill(0.001), params: { boundary: 'wall', drainageScale: 100 } });
  thin.setLandSurface({ drainCapacity: drain });
  thin.runSubsteps(200, 1);
  const s = await thin.debugReadState();
  let minH = Infinity;
  for (const h of s.h) minH = Math.min(minH, h);
  const ts = await thin.readbackNow();
  assert.ok(minH >= 0, `min depth ${minH}`);
  assert.ok(ts.stats.massError < 1e-6, `massError ${ts.stats.massError}`);
  solver.destroy();
  thin.destroy();
  assert.deepEqual(gpuErrors(), []);
});

// ── Lake at rest ────────────────────────────────────────────────────────────────────────────────────────────────────

test('a lake at rest stays at rest among buildings and on a roughness map; cells wet at reset are never blocked', async () => {
  const nx = 96;
  const ny = 96;
  const N = nx * ny;
  const elevation = roughTerrain(nx, ny, 3, 24, 250);
  const depth = lakeAtRest(elevation, 252.37);
  // Buildings everywhere, including under the lake: those must stay open.
  const obstacles = scatterBuildings(nx, ny, 17, 400, 9);
  const r = rng(8);
  const roughN = Float32Array.from({ length: N }, () => 0.02 + 0.2 * r());
  const solver = await makeSolver({ nx, ny, cellSize: 10, elevation, depth, params: { boundary: 'wall', manningN: 0.035 } });
  solver.setLandSurface({ obstacles, roughness: roughN });
  const st = solver.landSurfaceState;
  let wetBlocked = 0;
  let dryBlocked = 0;
  for (let c = 0; c < N; c++) {
    if (!(obstacles[c] > 0)) continue;
    if (depth[c] >= 0.01) wetBlocked++;
    else dryBlocked++;
  }
  assert.equal(st.obstacles, dryBlocked, 'only dry cells are blocked');
  assert.ok(wetBlocked > 50 && dryBlocked > 50, `test needs buildings both in and out of the lake (${wetBlocked}, ${dryBlocked})`);
  const dt = solver.computeDt();
  for (let k = 0; k < 20; k++) solver.runSubsteps(100, dt);
  const snap = await solver.readbackNow();
  const exported = await solver.readTexture(solver.stateTexture, 4);
  let maxU = 0;
  for (let c = 0; c < N; c++) maxU = Math.max(maxU, Math.hypot(exported[4 * c + 1], exported[4 * c + 2]));
  console.log(`  lake at rest with ${dryBlocked} blocked cells and a roughness map: max|u| ${maxU.toExponential(2)} m/s, massError ${snap.stats.massError.toExponential(1)}`);
  assert.ok(maxU < 1e-3, `max |u| ${maxU}`);
  assert.ok(snap.stats.massError < 1e-5, `massError ${snap.stats.massError}`);
  const fields = await solver.readHazardFields();
  assert.ok(fields.blocked, 'HazardFields.blocked is present with obstacles on');
  let nb = 0;
  for (const b of fields.blocked!) nb += b;
  assert.equal(nb, dryBlocked);
  solver.setLandSurface({ obstacles: null });
  const f2 = await solver.readHazardFields();
  assert.equal(f2.blocked, undefined, 'no blocked mask once obstacles are off');
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('switching obstacles on under standing water lifts it onto the roofs and conserves mass', async () => {
  const nx = 48;
  const ny = 48;
  const N = nx * ny;
  const elevation = new Float32Array(N).fill(10);
  const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, params: { boundary: 'wall', manningN: 0.035 } });
  // Pour water over a block, then raise buildings into it.
  solver.applyBrush({ kind: 'water', gx: 24, gy: 24, radius: 14, amount: 1.5 });
  solver.runSubsteps(200, 0.2);
  const before = await solver.readbackNow();
  const obstacles = scatterBuildings(nx, ny, 21, 30, 6);
  solver.setLandSurface({ obstacles });
  solver.runSubsteps(600, 0.2);
  const after1 = await solver.readbackNow();
  console.log(`  rebed under water: volume ${before.stats.volume.toFixed(4)} → ${after1.stats.volume.toFixed(4)} m³, massError ${after1.stats.massError.toExponential(1)}`);
  assert.ok(Math.abs(after1.stats.volume - before.stats.volume) / before.stats.volume < 1e-5, 'volume changed');
  assert.ok(after1.stats.massError < 1e-5, `massError ${after1.stats.massError}`);
  const s = await solver.debugReadState();
  let roof = 0;
  for (let c = 0; c < N; c++) if (obstacles[c] > 0) roof = Math.max(roof, s.h[c]);
  assert.ok(roof < 0.01, `water left on a roof after the spill: ${roof} m`);
  // The renderer's bed (bedTexture) leaves the buildings out.
  const bed = await solver.readTexture(solver.bedTexture, 1);
  for (let c = 0; c < N; c++) assert.equal(bed[c], 10);
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

// ── Channel with obstacles ───────────────────────────────────────────────────────────────────────────────────────────

test('a channel past a row of buildings: no flow through the footprints, flow goes round, afflux upstream', async () => {
  const nx = 160;
  const ny = 32;
  const N = nx * ny;
  const dx = 7.8125;
  const slope = 0.002;
  const elevation = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elevation[j * nx + i] = j < 4 || j >= ny - 4 ? 50 : 20 - slope * i * dx;
  const Q = 60;
  const run = async (obstacles: Float32Array | null) => {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'open', manningN: 0.03 } });
    solver.setSources([{ id: 'q', type: 'inflow', gx: 6, gy: ny / 2, radius: 3, discharge: Q }]);
    if (obstacles) solver.setLandSurface({ obstacles });
    while (solver.time < 2400) {
      solver.runSubsteps(200);
      await solver.readbackNow();
    }
    const s = await solver.debugReadState();
    const snap = await solver.readbackNow();
    solver.destroy();
    return { s, snap };
  };
  // Three 2×2-cell buildings across the channel at i = 80–81, leaving 1–2 cell streets between them.
  const obstacles = new Float32Array(N);
  for (const j0 of [6, 13, 21]) for (let j = j0; j < j0 + 3; j++) for (let i = 80; i < 82; i++) obstacles[j * nx + i] = 10;
  const open = await run(null);
  const city = await run(obstacles);
  const meanDepth = (h: Float32Array, i0: number, i1: number) => {
    let s = 0;
    let n = 0;
    for (let j = 4; j < ny - 4; j++) for (let i = i0; i < i1; i++) if (!(obstacles[j * nx + i] > 0)) { s += h[j * nx + i]; n++; }
    return s / n;
  };
  const upOpen = meanDepth(open.s.h, 60, 76);
  const upCity = meanDepth(city.s.h, 60, 76);
  const downOpen = meanDepth(city.s.h, 100, 120);
  // Discharge through the building row (the x-faces between i = 79 and 80 carry it all; faces into a block carry 0).
  let qRow = 0;
  let qInto = 0;
  for (let j = 0; j < ny; j++) {
    qRow += city.s.qx[j * nx + 90] * dx;
    if (obstacles[j * nx + 80] > 0) qInto = Math.max(qInto, Math.abs(city.s.qx[j * nx + 79]));
  }
  let roof = 0;
  for (let c = 0; c < N; c++) if (obstacles[c] > 0) roof = Math.max(roof, city.s.h[c]);
  console.log(
    `  channel Q ${Q} m³/s: upstream depth ${upOpen.toFixed(3)} m open → ${upCity.toFixed(3)} m with buildings (afflux ${(upCity - upOpen).toFixed(3)} m), ` +
      `downstream ${downOpen.toFixed(3)} m, Q past the row ${qRow.toFixed(1)} m³/s, max |q| into a footprint ${qInto.toExponential(1)}, ` +
      `massError ${city.snap.stats.massError.toExponential(1)}`,
  );
  assert.equal(roof, 0, 'water inside a footprint');
  assert.equal(qInto, 0, 'flux into a footprint');
  assert.ok(upCity > upOpen + 0.02, `buildings must raise the water upstream (${upOpen} → ${upCity})`);
  assert.ok(Math.abs(qRow - Q) / Q < 0.05, `the full discharge passes between the buildings (${qRow})`);
  assert.ok(city.snap.stats.massError < 1e-5, `massError ${city.snap.stats.massError}`);
  assert.deepEqual(gpuErrors(), []);
});
