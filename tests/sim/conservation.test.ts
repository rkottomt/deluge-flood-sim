/**
 * Mass conservation and mass accounting.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver, stepAndSnapshot } from '../helpers/gpu';
import { roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

test('closed (wall) domain conserves mass: random terrain + water blob, relative error < 1e-4', async () => {
  const nx = 128;
  const ny = 96;
  const dx = 8;
  const elevation = roughTerrain(nx, ny, 42, 40, 300);
  const depth = new Float32Array(nx * ny);
  // A tall column of water released over rough terrain: violent wetting/drying.
  for (let j = 20; j < 60; j++) for (let i = 30; i < 70; i++) depth[j * nx + i] = 12;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.03 } });
  const v0 = (await solver.readbackNow()).stats.volume;
  const snap = await stepAndSnapshot(solver, 4000, { chunk: 100 });
  const relErr = Math.abs(snap.stats.volume - v0) / v0;
  console.log(
    `  closed domain: t=${snap.simTime.toFixed(0)} s, wet area ${(snap.stats.wetArea / 1e6).toFixed(3)} km², ` +
      `|ΔV|/V0 = ${relErr.toExponential(2)}, limiter residue in=${snap.stats.volumeIn.toExponential(2)} m³, massError=${snap.stats.massError.toExponential(2)}`,
  );
  assert.ok(snap.stats.wetArea > 1.5 * 40 * 40 * dx * dx, 'water should have spread well beyond the initial column');
  assert.ok(relErr < 1e-4, `relative volume error ${relErr}`);
  assert.equal(snap.stats.volumeOut, 0);
  const st = await solver.debugReadState();
  let minH = Infinity;
  for (const h of st.h) minH = Math.min(minH, h);
  assert.ok(minH >= 0, `negative depth ${minH}`);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('inflow source injects exactly Q·t (error < 0.5%), also when the footprint is clipped by the edge', async () => {
  const nx = 64;
  const ny = 64;
  const dx = 5;
  const elevation = roughTerrain(nx, ny, 5, 6, 80);
  for (const [label, gx, gy, radius] of [
    ['interior', 32.3, 30.7, 3],
    ['edge-clipped', 0.8, 40.2, 4],
    ['tiny radius', 20.5, 20.5, 0.2],
  ] as const) {
    const Q = 12.5; // m³/s
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'wall' } });
    solver.setSources([{ id: 's', type: 'inflow', gx, gy, radius, discharge: Q }]);
    const snap = await stepAndSnapshot(solver, 1500, { dt: 0.2 });
    const expected = Q * snap.simTime;
    const rel = Math.abs(snap.stats.volume - expected) / expected;
    const accRel = Math.abs(snap.stats.volumeIn - expected) / expected;
    console.log(`  inflow ${label}: V=${snap.stats.volume.toFixed(1)} m³ vs Q·t=${expected.toFixed(1)} m³ (err ${(rel * 100).toFixed(4)}%, accounted ${(accRel * 100).toFixed(4)}%)`);
    assert.ok(rel < 0.005, `${label}: volume error ${rel}`);
    assert.ok(accRel < 0.005, `${label}: accounted inflow error ${accRel}`);
    solver.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});

test('SimStats.massError < 1e-3 in an open domain with rain, storm, inflow, stage and infiltration', async () => {
  const nx = 128;
  const ny = 128;
  const dx = 10;
  const elevation = roughTerrain(nx, ny, 9, 60, 200);
  const solver = await makeSolver({
    nx,
    ny,
    cellSize: dx,
    elevation,
    params: { boundary: 'open', rainRate: 40, infiltrationRate: 8, manningN: 0.04, cfl: 0.7 },
  });
  // Stage source near a low point (drains or fills to a level), an inflow and a storm cell.
  let lowest = 0;
  for (let c = 0; c < nx * ny; c++) if (elevation[c] < elevation[lowest]) lowest = c;
  const lx = (lowest % nx) + 0.5;
  const ly = Math.floor(lowest / nx) + 0.5;
  solver.setSources([
    { id: 'stage', type: 'stage', gx: lx, gy: ly, radius: 5, level: elevation[lowest] + 4 },
    { id: 'in', type: 'inflow', gx: 90, gy: 30, radius: 3, discharge: 40 },
  ]);
  solver.setStorms([{ id: 'storm', gx: 40, gy: 80, radius: 25, intensity: 150 }]);

  let worst = 0;
  let snap = await solver.readbackNow();
  for (let k = 0; k < 30; k++) {
    snap = await stepAndSnapshot(solver, 100, { chunk: 100 });
    worst = Math.max(worst, snap.stats.massError);
  }
  const s = snap.stats;
  console.log(
    `  open domain: t=${s.simTime.toFixed(0)} s  V=${s.volume.toExponential(3)}  in=${s.volumeIn.toExponential(3)}  out=${s.volumeOut.toExponential(3)}  ` +
      `worst massError=${worst.toExponential(2)}  wet=${(s.wetArea / 1e6).toFixed(3)} km²  courant=${s.courant.toFixed(2)}`,
  );
  assert.ok(s.volumeIn > 0 && s.volumeOut > 0, 'expected flow in and out');
  assert.ok(worst < 1e-3, `massError ${worst}`);
  assert.ok(s.courant > 0 && s.courant <= 1.0, `courant ${s.courant}`);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('SimStats.massError is normalized by the most water held, not by the ever-growing inflow volume', async () => {
  // A stage source on an open edge exchanges water with the boundary while storage stays constant (Pittsburgh's
  // river discs do ~10,000 m³/s). Normalizing by initial + inflow volume made the percentage shrink without bound.
  const nx = 64;
  const ny = 32;
  const dx = 10;
  const elevation = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elevation[j * nx + i] = 100 - 0.002 * i * dx;
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'open', manningN: 0.03 } });
  solver.setSources([{ id: 'stage', type: 'stage', gx: 0, gy: ny / 2, radius: 8, level: 103 }]);
  let peak = 0;
  let snap = await solver.readbackNow();
  for (let k = 0; k < 40; k++) {
    snap = await stepAndSnapshot(solver, 100, { chunk: 100 });
    peak = Math.max(peak, snap.stats.volume);
    const s = snap.stats;
    const expected = Math.abs(s.volume - (s.volumeIn - s.volumeOut)) / Math.max(1, peak);
    assert.ok(Math.abs(s.massError - expected) <= 1e-9 * Math.max(expected, 1e-9), `massError ${s.massError} vs ${expected}`);
  }
  const s = snap.stats;
  console.log(
    `  churn: in=${s.volumeIn.toExponential(2)} m³ vs peak storage ${peak.toExponential(2)} m³, massError ${s.massError.toExponential(2)}`,
  );
  assert.ok(s.volumeIn > 5 * peak, 'test should push far more water through than it stores');
  assert.ok(s.massError < 1e-3);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});
