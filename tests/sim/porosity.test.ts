/**
 * Building porosity and downspouts (LandSurface.porosity; src/data/porosity.ts, shaders/common.ts POROSITY_WGSL;
 * ARCHITECTURE.md §3.11):
 *
 *  • neutral porosity (every cell and face open, no roofs) is the plain solver bit for bit, with and without drains;
 *  • the GPU agrees with the Float64 CPU reference with porosity, blocks, a roughness map, rain, and drains or
 *    downspouts; the mass ledger stays exact (the state holds volume per unit area);
 *  • downspouts: with no drains every drop of roof rain lands on the ground; with drains the roof rain is piped away up
 *    to the capacity and never enters the surface water;
 *  • standing water among porous cells settles to one level of the OPEN part (depth V/φ), and switching porosity on
 *    under it conserves the volume;
 *  • a channel past a row of houses with 2 m side yards: the yards carry the flow, where blocking every cell whose
 *    centre is under a roof (the old treatment) dams the channel.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { CpuReferenceSolver, type SchemeStepParams } from '../../src/sim/cpuReference';
import { MMHR_TO_MS } from '../../src/sim/constants';
import { packForcing } from '../../src/sim/forcing';
import { buildingLayers } from '../../src/data/porosity';
import { obstacleHeights } from '../../src/data/landcover';
import { rasterizeBuildingHeights } from '../../src/data/buildings';
import type { LandSurfacePorosity } from '../../src/contracts';
import type { GpuFloodSolver } from '../../src/sim';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';
import { rng, roughTerrain } from '../helpers/terrain';
import { rectBuildings } from '../helpers/footprints';

after(finishGpuTests);

function bitwiseEqual(a: Float32Array[], b: Float32Array[]): boolean {
  for (let k = 0; k < a.length; k++) {
    const x = new Uint32Array(a[k].buffer, a[k].byteOffset, a[k].length);
    const y = new Uint32Array(b[k].buffer, b[k].byteOffset, b[k].length);
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  }
  return true;
}

async function readState(solver: GpuFloodSolver): Promise<Float32Array[]> {
  const s = await solver.debugReadState();
  return [s.h, s.qx, s.qy, s.z];
}

function neutralPorosity(N: number): LandSurfacePorosity {
  return {
    cell: new Float32Array(N).fill(1),
    faceE: new Float32Array(N).fill(1),
    faceS: new Float32Array(N).fill(1),
    roof: new Float32Array(N),
    spout: new Float32Array(N),
  };
}

/** Random houses (rectangles of 0.6–3 cells, many sharing cells) on dry land away from the edges, seeded. */
function scatterHouses(nx: number, ny: number, seed: number, count: number) {
  const r = rng(seed);
  const list: Array<[number, number, number, number, number]> = [];
  for (let k = 0; k < count; k++) {
    const x = 4 + r() * (nx - 12);
    const y = 4 + r() * (ny - 12);
    list.push([x, y, x + 0.6 + 2.4 * r(), y + 0.6 + 2.4 * r(), 4 + 10 * r()]);
  }
  return rectBuildings(list);
}

test('neutral porosity is the plain solver bit for bit (with and without drains)', async () => {
  const nx = 64;
  const ny = 48;
  const N = nx * ny;
  const elevation = roughTerrain(nx, ny, 7, 14, 120);
  const depth = new Float32Array(N);
  for (let j = 8; j < 30; j++) for (let i = 6; i < 26; i++) depth[j * nx + i] = 5;
  const drains = Float32Array.from({ length: N }, (_, c) => (c % 3 ? 30 : 0));
  const run = async (prep: (s: GpuFloodSolver) => void) => {
    const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, depth, params: { boundary: 'open', manningN: 0.03, rainRate: 60, infiltrationRate: 5 } });
    solver.setSources([
      { id: 'a', type: 'inflow', gx: 50.2, gy: 10.7, radius: 2, discharge: 40 },
      { id: 's', type: 'stage', gx: 0, gy: 40, radius: 6, level: elevation[40 * nx + 2] + 2 },
    ]);
    prep(solver);
    solver.runSubsteps(400, Math.fround(0.2));
    const out = await readState(solver);
    const snap = await solver.readbackNow();
    solver.destroy();
    return { out, volume: snap.stats.volume, depth: snap.depth.slice() };
  };
  const plain = await run(() => {});
  const neutral = await run((s) => s.setLandSurface({ porosity: neutralPorosity(N) }));
  const offAgain = await run((s) => {
    s.setLandSurface({ porosity: buildingLayers(scatterHouses(nx, ny, 3, 40), nx, ny).porosity });
    s.setLandSurface({ porosity: null });
  });
  const drained = await run((s) => s.setLandSurface({ drainCapacity: drains }));
  const drainedNeutral = await run((s) => s.setLandSurface({ drainCapacity: drains, porosity: neutralPorosity(N) }));
  assert.ok(bitwiseEqual(plain.out, neutral.out), 'neutral porosity changed the result');
  assert.ok(bitwiseEqual(plain.out, offAgain.out), 'porosity off again did not restore the plain solver');
  assert.ok(bitwiseEqual(drained.out, drainedNeutral.out), 'neutral porosity changed the drained result');
  assert.equal(neutral.volume, plain.volume);
  assert.ok(bitwiseEqual([plain.depth], [neutral.depth]), 'the exported depth');
  assert.deepEqual(gpuErrors(), []);
});

test('GPU matches the Float64 CPU reference with porosity, blocks, a roughness map, rain and drains or downspouts', async () => {
  const nx = 48;
  const ny = 32;
  const N = nx * ny;
  const dx = 6;
  const elevation = roughTerrain(nx, ny, 99, 12, 140);
  const depth = new Float32Array(N);
  for (let j = 8; j < 22; j++) for (let i = 6; i < 20; i++) depth[j * nx + i] = 4;
  const b = buildingLayers(scatterHouses(nx, ny, 5, 70), nx, ny, { ground: elevation, initialWater: depth });
  const por = b.porosity!;
  const obstacles = b.obstacles ?? new Float32Array(N);
  assert.ok(b.porousCells > 60 && b.blockedCells > 5, `test needs porous cells and blocks (${b.porousCells}, ${b.blockedCells})`);
  const r = rng(4);
  const roughN = Float32Array.from({ length: N }, () => 0.02 + 0.1 * r());
  const drainMmHr = Float32Array.from({ length: N }, (_, c) => ((c * 7) % 5 === 0 ? 0 : 20 + 40 * r()));
  for (const withDrains of [true, false]) {
    const params = { boundary: 'open' as const, manningN: 0.04, rainRate: 70, drainageScale: 1.5, infiltrationRate: 4 };
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params });
    const sources = [{ id: 'a', type: 'inflow' as const, gx: 35.2, gy: 9.7, radius: 2.5, discharge: 30 }];
    solver.setSources(sources);
    solver.setLandSurface({ roughness: roughN, drainCapacity: withDrains ? drainMmHr : null, obstacles: b.obstacles, porosity: por });
    assert.equal(solver.landSurfaceState.porous, b.porousCells);
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
      infiltration: Math.fround(params.infiltrationRate / 3.6e6),
      open: true,
      robust: true,
      boundaryMinSlope: o.boundaryMinSlope,
      boundaryFroudeMax: o.boundaryFroudeMax,
      stageAlpha: 1,
      forcing: packForcing(sources, [], nx, ny, dx, z0, (k) => elevation[k] + obstacles[k]),
      roughness: Float32Array.from(roughN, (n) => n / 0.035),
      drain: withDrains ? Float64Array.from(drainMmHr, (v) => Math.fround(Math.fround(v * MMHR_TO_MS) * Math.fround(1.5))) : null,
      porosity: por,
    };
    const steps = 300;
    const cpu = new CpuReferenceSolver(nx, ny, zRel, depth);
    for (let k = 0; k < steps; k++) cpu.step(sp);
    solver.runSubsteps(steps, dt);
    const g = await solver.debugReadState();
    let dh = 0;
    for (let k = 0; k < N; k++) dh = Math.max(dh, Math.abs(g.h[k] - cpu.h[k]));
    const snap = await solver.readbackNow();
    const volRel = Math.abs(snap.stats.volume - cpu.volume(dx)) / cpu.volume(dx);
    const inRel = Math.abs(snap.stats.volumeIn - cpu.volumeIn) / cpu.volumeIn;
    // Exported depth is V/φ.
    let depthErr = 0;
    for (let k = 0; k < N; k++) depthErr = Math.max(depthErr, Math.abs(snap.depth[k] - g.h[k] / por.cell[k]) / Math.max(1e-3, snap.depth[k]));
    console.log(
      `  porosity + blocks + roughness + ${withDrains ? 'drains' : 'downspouts'}: ${steps} steps max|ΔV| ${dh.toExponential(2)} m, ` +
        `ΔV ${volRel.toExponential(1)}, Δ volumeIn ${inRel.toExponential(1)}, massError ${snap.stats.massError.toExponential(1)}`,
    );
    assert.ok(dh < 2e-3, `free-running max |ΔV| ${dh}`);
    assert.ok(volRel < 1e-4, `volume ${volRel}`);
    assert.ok(inRel < 1e-4, `volumeIn ${inRel}`);
    assert.ok(depthErr < 1e-5, `exported depth vs V/φ ${depthErr}`);
    assert.ok(snap.stats.massError < 1e-6, `massError ${snap.stats.massError}`);
    solver.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});

test('downspouts: roof rain all lands on the ground with no drains, and is piped away up to capacity with them', async () => {
  const nx = 48;
  const ny = 48;
  const N = nx * ny;
  const dx = 5;
  const elevation = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elevation[j * nx + i] = 30 + 0.01 * i;
  const set = rectBuildings([
    [10, 10, 18, 16, 9], // a 48-cell block
    [24.3, 24.3, 25.9, 26.1, 6], // houses straddling cells
    [30.5, 10.2, 32.5, 12.7, 6],
    [12.2, 30.6, 13.8, 33.4, 6],
  ]);
  const b = buildingLayers(set, nx, ny, { ground: elevation });
  const por = b.porosity!;
  let roofArea = 0;
  for (let c = 0; c < N; c++) roofArea += por.roof[c];
  const rainMmHr = 50;
  const T = 900;
  const run = async (drains: Float32Array | null) => {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'wall', manningN: 0.035, rainRate: rainMmHr } });
    solver.setLandSurface({ obstacles: b.obstacles, porosity: por, drainCapacity: drains });
    solver.runSubsteps(1800, T / 1800);
    const snap = await solver.readbackNow();
    const s = await solver.debugReadState();
    solver.destroy();
    return { snap, s };
  };
  const all = rainMmHr * MMHR_TO_MS * T * N * dx * dx;
  const roofRain = rainMmHr * MMHR_TO_MS * T * roofArea * dx * dx;
  // No drains: everything that fell is in the domain; nothing stands on a roof.
  const none = await run(null);
  const relNone = Math.abs(none.snap.stats.volumeIn - all) / all;
  let roofWater = 0;
  for (let c = 0; c < N; c++) if (b.obstacles && b.obstacles[c] > 0) roofWater = Math.max(roofWater, none.s.h[c]);
  // Drains that can take the roof rain (60 mm/hr on the roofs only): the roof rain never enters; the ground keeps its own.
  const cap = Float32Array.from(por.roof, (a) => (a > 0 ? 60 : 0));
  const piped = await run(cap);
  const relPiped = Math.abs(piped.snap.stats.volumeIn - (all - roofRain)) / (all - roofRain);
  // Drains of 20 mm/hr under the roofs: a cell pipes min(50 × roof share, 20) mm/hr away, the excess spills onto the
  // ground.
  const small = await run(Float32Array.from(por.roof, (a) => (a > 0 ? 20 : 0)));
  let pipedArea = 0;
  for (let c = 0; c < N; c++) pipedArea += Math.min(rainMmHr * por.roof[c], por.roof[c] > 0 ? 20 : 0) / rainMmHr;
  const expectSmall = all - rainMmHr * MMHR_TO_MS * T * dx * dx * pipedArea;
  const relSmall = Math.abs(small.snap.stats.volumeIn - expectSmall) / expectSmall;
  console.log(
    `  downspouts: roof area ${roofArea.toFixed(1)} cells; no drains in ${none.snap.stats.volumeIn.toFixed(1)} of ${all.toFixed(1)} m³ (rel ${relNone.toExponential(1)}), ` +
      `deepest roof film ${(roofWater * 1000).toFixed(2)} mm; drains ≥ roof rain: in ${piped.snap.stats.volumeIn.toFixed(1)} m³ (rel ${relPiped.toExponential(1)}); ` +
      `drains 20/50: rel ${relSmall.toExponential(1)}`,
  );
  assert.ok(relNone < 1e-4, `no drains: rain in ${relNone}`);
  assert.equal(roofWater, 0, 'no water lands on a roof when there are no drains');
  assert.ok(relPiped < 1e-4, `roof rain piped: ${relPiped}`);
  assert.ok(relSmall < 1e-4, `roof rain above capacity spills: ${relSmall}`);
  for (const r of [none, piped, small]) assert.ok(r.snap.stats.massError < 1e-6, `massError ${r.snap.stats.massError}`);
  assert.deepEqual(gpuErrors(), []);
});

test('standing water among porous cells settles to one level, and switching porosity on under it keeps its volume', async () => {
  const nx = 48;
  const ny = 48;
  const N = nx * ny;
  const elevation = new Float32Array(N).fill(10);
  const b = buildingLayers(scatterHouses(nx, ny, 11, 60), nx, ny);
  const por = b.porosity!;
  const solver = await makeSolver({ nx, ny, cellSize: 5, elevation, params: { boundary: 'wall', manningN: 0.08 } });
  solver.applyBrush({ kind: 'water', gx: 24, gy: 24, radius: 40, amount: 0.6 });
  solver.runSubsteps(200, 0.2);
  const before = await solver.readbackNow();
  const meanV = before.stats.volume / (N * 25);
  solver.setLandSurface({ porosity: por, obstacles: b.obstacles });
  // The depth jumps to V/φ at once; then the water evens out to one level of the open parts.
  for (let k = 0; k < 120; k++) solver.runSubsteps(200, 0.2);
  const after1 = await solver.readbackNow();
  const exported = await solver.readTexture(solver.stateTexture, 4);
  let lo = Infinity;
  let hi = -Infinity;
  let maxU = 0;
  for (let c = 0; c < N; c++) {
    if (b.obstacles && b.obstacles[c] > 0) continue;
    lo = Math.min(lo, exported[4 * c]);
    hi = Math.max(hi, exported[4 * c]);
    maxU = Math.max(maxU, Math.hypot(exported[4 * c + 1], exported[4 * c + 2]));
  }
  console.log(
    `  porosity on under 0.6 m: volume ${before.stats.volume.toFixed(3)} → ${after1.stats.volume.toFixed(3)} m³, depth of the open parts ` +
      `${lo.toFixed(4)}–${hi.toFixed(4)} m, max|u| ${maxU.toExponential(1)} m/s, massError ${after1.stats.massError.toExponential(1)}`,
  );
  assert.ok(Math.abs(after1.stats.volume - before.stats.volume) / before.stats.volume < 1e-5, 'volume changed');
  assert.ok(hi - lo < 2e-3, `level spread ${hi - lo} m`);
  assert.ok(lo > meanV, `the buildings displace water: the open parts stand deeper (${lo}) than the volume per area (${meanV})`);
  assert.ok(maxU < 5e-3, `max |u| ${maxU}`);
  assert.ok(after1.stats.massError < 1e-5, `massError ${after1.stats.massError}`);
  solver.destroy();
  assert.deepEqual(gpuErrors(), []);
});

test('a channel past a row of houses with 2 m side yards: the yards carry the flow; centre blocking dams it', async () => {
  const nx = 160;
  const ny = 32;
  const N = nx * ny;
  const dx = 7.8125;
  const slope = 0.002;
  const elevation = new Float32Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elevation[j * nx + i] = j < 4 || j >= ny - 4 ? 50 : 20 - slope * i * dx;
  const Q = 40;
  // Houses across the whole channel (y 4–28), 2.7 cells (21 m) wide, 0.3-cell (2.3 m) yards between them: every cell
  // centre on the row is under a roof.
  const list: Array<[number, number, number, number, number]> = [];
  for (let y = 4; y < 28; y += 3) list.push([80, y, 82, y + 2.7, 8]);
  const set = rectBuildings(list);
  const layers = buildingLayers(set, nx, ny, { ground: elevation });
  const centre = obstacleHeights(null, nx, ny, rasterizeBuildingHeights(set, nx, ny), elevation)!;
  const run = async (prep: (s: GpuFloodSolver) => void) => {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'open', manningN: 0.03 } });
    solver.setSources([{ id: 'q', type: 'inflow', gx: 6, gy: ny / 2, radius: 3, discharge: Q }]);
    prep(solver);
    while (solver.time < 7200) {
      solver.runSubsteps(200);
      await solver.readbackNow();
    }
    const s = await solver.debugReadState();
    const snap = await solver.readbackNow();
    solver.destroy();
    return { s, snap };
  };
  const porous = await run((s) => s.setLandSurface({ obstacles: layers.obstacles, porosity: layers.porosity }));
  const blocked = await run((s) => s.setLandSurface({ obstacles: centre }));
  const qPast = (qx: Float32Array) => {
    let q = 0;
    for (let j = 0; j < ny; j++) q += qx[j * nx + 100] * dx;
    return q;
  };
  const up = (h: Float32Array) => {
    let s = 0;
    for (let j = 4; j < ny - 4; j++) for (let i = 60; i < 76; i++) s += h[j * nx + i];
    return s / ((ny - 8) * 16);
  };
  const qp = qPast(porous.s.qx);
  const qb = qPast(blocked.s.qx);
  console.log(
    `  channel ${Q} m³/s past houses with 2.3 m yards: porosity passes ${qp.toFixed(1)} m³/s (upstream ${up(porous.s.h).toFixed(2)} m, ` +
      `${layers.porousCells} porous cells, ${layers.blockedCells} blocks); centre blocking passes ${qb.toFixed(1)} m³/s ` +
      `(upstream ${up(blocked.s.h).toFixed(2)} m); massError ${porous.snap.stats.massError.toExponential(1)}`,
  );
  assert.ok(Math.abs(qp - Q) / Q < 0.05, `the yards carry the discharge (${qp})`);
  assert.ok(qb < 0.05 * Q, `centre blocking dams the channel (${qb})`);
  assert.ok(up(porous.s.h) < up(blocked.s.h), 'less afflux through the yards than behind a dam');
  assert.ok(porous.snap.stats.massError < 1e-5, `massError ${porous.snap.stats.massError}`);
  assert.deepEqual(gpuErrors(), []);
});
