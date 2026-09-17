/**
 * Brush edits: walls block flow, CPU mirrors match GPU textures, water edits are mass-accounted.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver, maxAbsDiff, stepAndSnapshot } from '../helpers/gpu';
import { roughTerrain } from '../helpers/terrain';

after(finishGpuTests);

function sideVolumes(depth: Float32Array, nx: number, ny: number, splitLo: number, splitHi: number) {
  let west = 0;
  let east = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (i < splitLo) west += depth[j * nx + i];
      else if (i >= splitHi) east += depth[j * nx + i];
    }
  return { west, east };
}

test('a wall brush blocks flow: water stays on its side (and flows across without the wall)', async () => {
  const nx = 96;
  const ny = 64;
  const dx = 4;
  const elevation = new Float32Array(nx * ny);
  // Gentle slope toward the east so water actively pushes against the wall.
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) elevation[j * nx + i] = 50 - 0.02 * i * dx;
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < 40; i++) depth[j * nx + i] = 2;

  for (const withWall of [true, false]) {
    const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.03 } });
    if (withWall) {
      // A slightly wiggly, diagonal-ish polyline wall across the whole domain (thin: radius 0.75 cells).
      const pts = [
        [46.2, -2],
        [47.9, 20.3],
        [44.1, 41.7],
        [46.6, 66],
      ];
      for (let k = 0; k < pts.length - 1; k++) {
        // 8 m: taller than the ~3.6 m pond (plus sloshing) that piles up against it, so only leaks would pass.
        solver.applyBrush({ kind: 'wall', ax: pts[k][0], ay: pts[k][1], bx: pts[k + 1][0], by: pts[k + 1][1], radius: 0.75, height: 8 });
      }
    }
    const snap = await stepAndSnapshot(solver, 3000, { chunk: 100 });
    const { west, east } = sideVolumes(snap.depth, nx, ny, 42, 52);
    const total = west + east;
    console.log(`  wall=${withWall}: t=${snap.simTime.toFixed(0)} s, east-side share of water = ${(east / total).toExponential(2)}`);
    if (withWall) assert.ok(east / total < 1e-6, `water leaked through the wall: ${east / total}`);
    else assert.ok(east / total > 0.2, `without a wall water should cross: ${east / total}`);
    solver.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});

test('brush CPU mirrors (ground, barrier) match the GPU textures; bed = ground + barrier', async () => {
  const nx = 64;
  const ny = 48;
  const elevation = roughTerrain(nx, ny, 12, 20, 2500.25);
  const solver = await makeSolver({ nx, ny, cellSize: 3, elevation, params: { boundary: 'wall' } });
  solver.applyBrush({ kind: 'wall', ax: 3.2, ay: 5.5, bx: 50.7, by: 40.1, radius: 1.6, height: 3.5 });
  solver.applyBrush({ kind: 'wall', ax: 10, ay: 40, bx: 60, by: 8, radius: 0.4, height: 7.25 });
  solver.applyBrush({ kind: 'eraseWall', ax: 20, ay: 20, bx: 30, by: 25, radius: 2.5 });
  solver.applyBrush({ kind: 'terrain', gx: 33.3, gy: 12.1, radius: 9, delta: -4.5 });
  solver.applyBrush({ kind: 'terrain', gx: 0.5, gy: 47.5, radius: 6, delta: 2 }); // clipped at the corner
  solver.applyBrush({ kind: 'wall', ax: -10, ay: -10, bx: -5, by: -5, radius: 1, height: 3 }); // fully outside: no-op
  solver.applyBrush({ kind: 'wall', ax: NaN, ay: 0, bx: 1, by: 1, radius: 1, height: 3 }); // invalid: ignored

  const gpuGround = await solver.readTexture(solver.groundTexture, 1);
  const gpuBarrier = await solver.readTexture(solver.barrierTexture, 1);
  const gpuBed = await solver.readTexture(solver.bedTexture, 1);
  const state = await solver.debugReadState();
  const cpuGround = solver.getGroundCPU();
  const cpuBarrier = solver.getBarrierCPU();
  let maxBarrier = 0;
  let minGroundDelta = 0;
  let bedErr = 0;
  let zErr = 0;
  for (let c = 0; c < nx * ny; c++) {
    maxBarrier = Math.max(maxBarrier, cpuBarrier[c]);
    minGroundDelta = Math.min(minGroundDelta, cpuGround[c] - elevation[c]);
    bedErr = Math.max(bedErr, Math.abs(gpuBed[c] - (cpuGround[c] + cpuBarrier[c])));
    zErr = Math.max(zErr, Math.abs(state.z[c] + solver.z0 - (cpuGround[c] + cpuBarrier[c])));
  }
  const dg = maxAbsDiff(gpuGround, cpuGround);
  const db = maxAbsDiff(gpuBarrier, cpuBarrier);
  console.log(`  mirrors: |Δground|=${dg.toExponential(2)} |Δbarrier|=${db.toExponential(2)} |Δbed|=${bedErr.toExponential(2)} |Δz_state|=${zErr.toExponential(2)}`);
  assert.ok(maxBarrier > 7 && maxBarrier <= 7.25 + 1e-4, `barrier max ${maxBarrier}`);
  assert.ok(minGroundDelta < -4.4, `dig depth ${minGroundDelta}`);
  assert.ok(dg < 1e-3, `ground mismatch ${dg}`); // 2500 m terrain: float32 ulp is 2.4e-4
  assert.ok(db < 1e-4, `barrier mismatch ${db}`);
  assert.ok(bedErr < 1e-3, `bed mismatch ${bedErr}`);
  assert.ok(zErr < 1e-3, `state z mismatch ${zErr}`);

  // Erased segment really removed the wall; reset({ resetTerrain }) restores everything.
  solver.reset({ resetTerrain: true });
  const g2 = await solver.readTexture(solver.groundTexture, 1);
  const b2 = await solver.readTexture(solver.barrierTexture, 1);
  assert.equal(maxAbsDiff(g2, elevation), 0);
  assert.equal(maxAbsDiff(b2, new Float32Array(nx * ny)), 0);
  assert.equal(maxAbsDiff(solver.getBarrierCPU(), new Float32Array(nx * ny)), 0);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('water brush adds/removes water with exact accounting and never goes negative', async () => {
  const nx = 48;
  const ny = 48;
  const dx = 5;
  const elevation = roughTerrain(nx, ny, 2, 5, 10);
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, params: { boundary: 'wall' } });
  solver.applyBrush({ kind: 'water', gx: 24, gy: 24, radius: 6, amount: 2 });
  const s1 = await solver.readbackNow();
  assert.ok(s1.stats.volume > 0);
  assert.ok(Math.abs(s1.stats.volumeIn - s1.stats.volume) / s1.stats.volume < 1e-6, 'brush water accounted as input');
  // Exported state reflects the edit immediately (even without a step).
  const ex = await solver.readTexture(solver.stateTexture, 4);
  assert.ok(Math.abs(ex[4 * (24 * nx + 24)] - 2) < 0.2);
  assert.ok(ex[4 * (24 * nx + 24) + 3] >= ex[4 * (24 * nx + 24)], 'max depth tracks brush water');
  await stepAndSnapshot(solver, 200);
  solver.applyBrush({ kind: 'water', gx: 24, gy: 24, radius: 30, amount: -50 });
  const s2 = await stepAndSnapshot(solver, 10);
  const st = await solver.debugReadState();
  let minH = Infinity;
  for (const h of st.h) minH = Math.min(minH, h);
  console.log(`  water brush: in=${s2.stats.volumeIn.toFixed(2)} out=${s2.stats.volumeOut.toFixed(2)} V=${s2.stats.volume.toFixed(3)} massError=${s2.stats.massError.toExponential(2)}`);
  assert.ok(minH >= 0);
  assert.ok(s2.stats.volumeOut > 0);
  assert.ok(s2.stats.massError < 1e-5, `massError ${s2.stats.massError}`);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('raiseWaterSurface lifts water in place: h = max(h, base + offset − bed), NaN cells untouched, mass accounted', async () => {
  const nx = 64;
  const ny = 48;
  const dx = 5;
  const elevation = roughTerrain(nx, ny, 7, 6, 230.5);
  const depth = new Float32Array(nx * ny);
  for (let j = 10; j < 30; j++) for (let i = 8; i < 40; i++) depth[j * nx + i] = Math.max(0, 233 - elevation[j * nx + i]);
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.03 } });
  const snap0 = await stepAndSnapshot(solver, 40);
  const before = await solver.debugReadState();
  // Channel = the left half of the pond; everything else NaN (left alone).
  const base = new Float32Array(nx * ny).fill(NaN);
  for (let j = 10; j < 30; j++) for (let i = 8; i < 24; i++) base[j * nx + i] = 233;
  const bed = (c: number) => solver.getGroundCPU()[c] + solver.getBarrierCPU()[c];
  const expectAfter = (offset: number, h: Float32Array) => {
    let err = 0;
    let added = 0;
    for (let c = 0; c < nx * ny; c++) {
      const want = Number.isNaN(base[c]) ? h[c] : Math.max(h[c], base[c] + offset - bed(c));
      added += want - h[c];
      err = Math.max(err, Math.abs(want - after.h[c]));
    }
    return { err, added: added * dx * dx };
  };
  // While "paused": no substeps between the raise and the read.
  solver.raiseWaterSurface(base, 1.5);
  let after = await solver.debugReadState();
  const first = expectAfter(1.5, before.h);
  assert.ok(first.err < 1e-4, `depth after the raise: max error ${first.err}`);
  assert.ok(first.added > 1000, 'the raise adds water');
  assert.ok(maxAbsDiff(after.qx, before.qx) === 0 && maxAbsDiff(after.qy, before.qy) === 0, 'discharge is kept');
  // Same array, higher offset (the cached upload), then a lower offset (a no-op: never lowers water).
  const mid = after;
  solver.raiseWaterSurface(base, 2.25);
  after = await solver.debugReadState();
  const second = expectAfter(2.25, mid.h);
  assert.ok(second.err < 1e-4, `second raise: max error ${second.err}`);
  const high = after;
  solver.raiseWaterSurface(base, 0.5);
  after = await solver.debugReadState();
  assert.equal(maxAbsDiff(after.h, high.h), 0, 'a lower level never removes water');
  // The renderer's texture follows without a step, and the ledger balances.
  const exported = await solver.readTexture(solver.stateTexture, 4);
  let expErr = 0;
  for (let c = 0; c < nx * ny; c++) expErr = Math.max(expErr, Math.abs(exported[4 * c] - after.h[c]));
  assert.ok(expErr < 1e-5, `stateTexture shows the raised water (max error ${expErr})`);
  const snap = await stepAndSnapshot(solver, 200);
  const addedIn = snap.stats.volumeIn - snap0.stats.volumeIn;
  console.log(`  raised ${(first.added + second.added).toFixed(0)} m³, booked inflow ${addedIn.toFixed(0)} m³, massError ${snap.stats.massError.toExponential(2)}`);
  assert.ok(Math.abs(addedIn - (first.added + second.added)) / addedIn < 1e-3, 'the added water is booked as inflow');
  assert.ok(snap.stats.massError < 1e-5, `massError ${snap.stats.massError}`);
  assert.ok(solver.computeDt() > 0);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});

test('reset restores the initial water on the current bed: walls raised after the last reset are in the restored state', async () => {
  const nx = 64;
  const ny = 48;
  const dx = 5;
  const elevation = roughTerrain(nx, ny, 11, 4, 120);
  const depth = new Float32Array(nx * ny);
  for (let j = 5; j < 40; j++) for (let i = 4; i < 30; i++) depth[j * nx + i] = Math.max(0, 123 - elevation[j * nx + i]);
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN: 0.03 } });
  const expectReset = async (label: string) => {
    const s = await solver.debugReadState();
    let hErr = 0;
    let zErr = 0;
    let q = 0;
    const ground = solver.getGroundCPU();
    const barrier = solver.getBarrierCPU();
    for (let c = 0; c < nx * ny; c++) {
      hErr = Math.max(hErr, Math.abs(s.h[c] - depth[c]));
      zErr = Math.max(zErr, Math.abs(s.z[c] - (Math.fround(ground[c] + barrier[c]) - solver.z0)));
      q = Math.max(q, Math.abs(s.qx[c]), Math.abs(s.qy[c]));
    }
    assert.ok(hErr < 1e-5, `${label}: depth restored (max error ${hErr})`);
    assert.ok(zErr < 1e-4, `${label}: bed channel = ground + barrier (max error ${zErr})`);
    assert.equal(q, 0, `${label}: discharge cleared`);
  };
  await stepAndSnapshot(solver, 300);
  solver.reset();
  await expectReset('plain reset');
  // Walls and a dug channel after that reset, then more flow, then reset again (the cached initial state is patched).
  solver.applyBrush({ kind: 'wall', ax: 10, ay: 10, bx: 40, by: 30, radius: 1.2, height: 3 });
  solver.applyBrush({ kind: 'terrain', gx: 20, gy: 20, radius: 4, delta: -1.5 });
  const bounds = solver.wallBounds;
  assert.ok(bounds && bounds.x0 <= 10 && bounds.y0 <= 10 && bounds.x1 >= 41 && bounds.y1 >= 31, `wall bounds ${JSON.stringify(bounds)}`);
  await stepAndSnapshot(solver, 300);
  solver.reset();
  await expectReset('after walls and digging');
  // Terrain reset clears the walls and the bounds.
  solver.reset({ resetTerrain: true });
  await expectReset('terrain reset');
  assert.equal(solver.wallBounds, null);
  assert.deepEqual(gpuErrors(), []);
  solver.destroy();
});
