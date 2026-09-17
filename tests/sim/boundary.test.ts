/**
 * Open boundaries: rain on a tilted plane must reach a steady state where the accounted outflow balances the
 * rain input; a river sloping to the edge must leave at its normal depth (no backwater); open boundaries only ever
 * let water OUT, and 'wall' boundaries let nothing out; an inflow beside an open edge is not drained back out of
 * it; stage discs (Dirichlet water levels at the edges) hold no momentum and never push water above their level.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { WaterSource } from '../../src/contracts';
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

test('a river sloping to an open edge leaves at its normal depth: no backwater near the outlet (±10 %)', async () => {
  // Straight 56 m wide channel along +y, bed slope 0.003, n = 0.035, Q = 500 m³/s → normal depth 2.84 m. The
  // outflow rule used to need the edge cell to pond until h^{5/3}·√S/n matched the arriving discharge with S at
  // its 1e-4 floor (a backed-up surface is flat): the last ~300 cells ran up to 2.5× normal depth.
  const nx = 32;
  const ny = 384;
  const dx = 7;
  const slope = 0.003;
  const manningN = 0.035;
  const Q = 500;
  const w = 8;
  const normalDepth = Math.pow(((Q / (w * dx)) * manningN) / Math.sqrt(slope), 0.6);
  const elevation = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const inChannel = i >= nx / 2 - w / 2 && i < nx / 2 + w / 2 && j >= 4;
      const bed = 100 - slope * j * dx;
      elevation[j * nx + i] = inChannel ? bed : bed + 30;
    }
  }
  // Starts dry: the flood wave reaching the edge is what used to trigger the backwater (a channel started at normal
  // depth never leaves it, whatever the outflow rule).
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'open', manningN } });
  solver.setSources([{ id: 'q', type: 'inflow', gx: nx / 2, gy: 8, radius: 3, discharge: Q }]);
  let prev = await solver.readbackNow();
  let outRate = 0;
  while (solver.time < 3600) {
    solver.runSubsteps(100);
    const cur = await solver.readbackNow();
    if (cur.simTime > 3000 && prev.simTime <= 3000) prev = cur;
    outRate = cur.simTime > 3000 && cur !== prev ? (cur.stats.volumeOut - prev.stats.volumeOut) / (cur.simTime - prev.simTime) : 0;
  }
  const st = await solver.debugReadState();
  const at = (j: number) => st.h[j * nx + nx / 2];
  const rows = [ny / 2, ny - 64, ny - 32, ny - 8, ny - 2];
  console.log(
    `  outlet: normal depth ${normalDepth.toFixed(2)} m; depth / normal at ${rows.map((j) => `j${j}: ${(at(j) / normalDepth).toFixed(3)}`).join(', ')}; ` +
      `outflow ${outRate.toFixed(0)} m³/s`,
  );
  assert.ok(Math.abs(outRate / Q - 1) < 0.03, `not steady: outflow ${outRate} m³/s`);
  for (const j of rows) assert.ok(Math.abs(at(j) / normalDepth - 1) < 0.1, `j=${j}: depth ${at(j)} vs normal ${normalDepth}`);
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

test('an inflow beside an open edge delivers its whole discharge: none of it drains back out of that edge', async () => {
  // A 60 m wide channel starts at the open north edge and runs 500 m (bed slope 0.004) into an enclosed basin that
  // does not touch any edge, so every m³ that leaves the domain is inflow leaking straight back out. The inflow sits
  // on the channel 6 cells inside the edge, as the baked presets place river inflows. Without the edge mask 14 % of
  // the discharge left through the north edge.
  const nx = 96;
  const ny = 160;
  const dx = 5;
  const elevation = new Float32Array(nx * ny).fill(20);
  for (let j = 0; j < 100; j++) for (let i = 42; i < 54; i++) elevation[j * nx + i] = 10 - 0.004 * dx * j;
  for (let j = 100; j < 150; j++) for (let i = 10; i < 86; i++) elevation[j * nx + i] = 0;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'open', manningN: 0.035 } });
  const Q = 20;
  solver.setSources([{ id: 'river', type: 'inflow', gx: 48, gy: 6.5, radius: 4, discharge: Q }]);
  while (solver.time < 900) {
    solver.runSubsteps(40);
    await solver.readbackNow();
  }
  const snap = await solver.readbackNow();
  const leak = snap.stats.volumeOut / snap.stats.volumeIn;
  console.log(`  inflow ${snap.stats.volumeIn.toFixed(0)} m³, out through the edge ${snap.stats.volumeOut.toFixed(1)} m³ (${(leak * 100).toFixed(2)} %), massError ${snap.stats.massError.toExponential(1)}`);
  assert.ok(Math.abs(snap.stats.volumeIn / (Q * snap.simTime) - 1) < 0.01, 'inflow accounting');
  assert.ok(leak < 0.005, `${(leak * 100).toFixed(2)} % of the inflow left through the edge beside the source`);
  assert.ok(snap.stats.massError < 1e-4);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('stage discs are reservoirs at rest: no momentum inside a disc, and no water above the stage level', async () => {
  // Deep channel with a shallow floodplain, a large stage disc over each of the west and east edges (centres outside
  // the domain, like Pittsburgh's Ohio boundary) at the same level, and open north/south edges that drain the
  // floodplain: a steady flow out of both discs. A disc resets its depth every substep; it must also forget its
  // discharge, or momentum coasts across the flat disc and re-emerges at the rim as a jet with no slope behind it.
  const nx = 256;
  const ny = 128;
  const dx = 8;
  const level = 108;
  const elevation = new Float32Array(nx * ny);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      elevation[k] = j >= 54 && j < 74 ? 100 : 103 + 0.002 * Math.abs(j - 64);
      depth[k] = level - elevation[k];
    }
  }
  const discs: Array<WaterSource & { type: 'stage' }> = [
    { id: 'west', type: 'stage', gx: -100, gy: 64, radius: 130, level },
    { id: 'east', type: 'stage', gx: nx + 100, gy: 64, radius: 130, level },
  ];
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'open', manningN: 0.03 } });
  solver.setSources(discs);
  while (solver.time < 1500) {
    solver.runSubsteps(40);
    await solver.readbackNow();
  }
  const snap = await solver.readbackNow();
  const st = await solver.debugReadState();
  const inside = (i: number, j: number) => discs.some((d) => Math.hypot(i + 0.5 - d.gx, j + 0.5 - d.gy) <= d.radius - 0.5);
  let interior = 0;
  let interiorQ = 0;
  let rimQ = 0;
  let above = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (st.h[k] > 0.01 && elevation[k] + st.h[k] > level + 1e-3) above++;
      if (!inside(i, j)) continue;
      for (const [di, dj, q] of [[1, 0, st.qx[k]], [0, 1, st.qy[k]]] as const) {
        if (i + di >= nx || j + dj >= ny) continue;
        if (inside(i + di, j + dj)) {
          interior++;
          interiorQ = Math.max(interiorQ, Math.abs(q));
        } else {
          rimQ = Math.max(rimQ, Math.abs(q));
        }
      }
    }
  }
  console.log(
    `  ${interior} faces inside the discs: max |q| ${interiorQ.toExponential(2)} m²/s; rim max |q| ${rimQ.toFixed(2)} m²/s; ` +
      `cells above the stage ${above}; max speed ${snap.stats.maxSpeed.toFixed(2)} m/s, massError ${snap.stats.massError.toExponential(1)}`,
  );
  assert.ok(interior > 1000, 'the discs cover many interior faces');
  assert.ok(rimQ > 0.5, 'water flows out of the discs through their rims (the test is not vacuous)');
  assert.equal(interiorQ, 0, 'faces inside a stage disc carry no discharge');
  assert.equal(above, 0, 'no water surface above the stage level');
  assert.ok(snap.stats.massError < 1e-4);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});
