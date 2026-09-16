import { CpuReferenceSolver, type SchemeStepParams } from '../../src/sim/cpuReference.ts';
import { packForcing } from '../../src/sim/forcing.ts';
import { makeSolver } from '../helpers/gpu.ts';
import { roughTerrain } from '../helpers/terrain.ts';
const nx = 48, ny = 32, dx = 6;
const elevation = roughTerrain(nx, ny, 99, 12, 140);
const depth = new Float32Array(nx * ny);
for (let j = 8; j < 22; j++) for (let i = 6; i < 20; i++) depth[j * nx + i] = 4;
const manningN = Number(process.argv[2] ?? 0);
const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN } });
const z0 = solver.z0;
const zRel = new Float64Array(nx*ny); for (let k=0;k<nx*ny;k++) zRel[k] = Math.fround(elevation[k]-z0);
const cpu = new CpuReferenceSolver(nx, ny, zRel, depth);
const o = solver.options; const dt = Math.fround(0.25);
const sp: SchemeStepParams = { dt, dx, manningN, theta: o.theta, hMin: o.hMin, uMax: o.uMax, froudeMax: o.froudeMax, advection: o.advection, rain: 0, infiltration: 0, open: false, robust: true, boundaryMinSlope: o.boundaryMinSlope, stageAlpha: 0, forcing: packForcing([], [], nx, ny, dx, z0, (k)=>elevation[k]) };
let done = 0;
for (const target of [1, 2, 5, 10, 20, 50, 100, 200, 300]) {
  while (done < target) { cpu.step(sp); solver.runSubsteps(1, dt); done++; }
  const g = await solver.debugReadState();
  let m = 0, mc = 0; for (let k=0;k<nx*ny;k++){ const d = Math.abs(g.h[k]-cpu.h[k]); if (d > m) { m = d; mc = k; } }
  console.log(`step ${done}: max|dh| ${m.toExponential(2)} at (${mc%nx},${Math.floor(mc/nx)}) h=${cpu.h[mc].toFixed(4)}`);
}
process.exit(0);
