import { makeSolver, stepAndSnapshot } from '../helpers/gpu.ts';
import { lakeAtRest, roughTerrain } from '../helpers/terrain.ts';
const nx = 96, ny = 96, dx = 8;
const elevation = roughTerrain(nx, ny, 21, 30, 180);
const depth = lakeAtRest(elevation, 181.5);
for (let j = 30; j < 50; j++) for (let i = 30; i < 50; i++) depth[j * nx + i] += 3;
const cfl = Number(process.argv[2] ?? 1.8); const rain = Number(process.argv[3] ?? 50);
const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { stabilityMode: 'robust', cfl, rainRate: rain, boundary: 'open' } });
for (let k = 0; k < 20; k++) {
  const snap = await stepAndSnapshot(solver, 25, { chunk: 25 });
  const ex = await solver.readTexture(solver.stateTexture, 4);
  const st = await solver.debugReadState();
  let best = 0, bc = 0;
  for (let c = 0; c < nx*ny; c++) { if (ex[4*c] > 0.01) { const sp = Math.hypot(ex[4*c+1], ex[4*c+2]); if (sp > best) { best = sp; bc = c; } } }
  const i = bc % nx, j = Math.floor(bc/nx);
  if (k % 4 === 3 || best > 10) {
    console.log(`t=${snap.simTime.toFixed(1)} dt=${solver.computeDt().toFixed(3)} maxSpeed=${best.toFixed(2)} at (${i},${j}) h=${ex[4*bc].toFixed(4)} u=${ex[4*bc+1].toFixed(2)} v=${ex[4*bc+2].toFixed(2)}`);
    for (let jj = j-1; jj <= j+1; jj++) { const row = []; for (let ii = i-1; ii <= i+1; ii++) { const c = jj*nx+ii; row.push(`h=${st.h[c].toFixed(3)} z=${st.z[c].toFixed(2)} qx=${st.qx[c].toFixed(3)} qy=${st.qy[c].toFixed(3)}`); } console.log('   ', row.join(' | ')); }
  }
}
process.exit(0);
