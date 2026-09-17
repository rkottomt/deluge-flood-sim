/**
 * Uniform flow in straight walled channels at 0/30/45/60° to the grid must run at Manning's normal depth.
 *
 * A 56 m wide channel (8 cells) with bed slope S = 0.003 and n = 0.035 carrying Q = 500 m³/s has normal depth
 * h = (q·n/√S)^{3/5} = 2.84 m. The inflow source sits at the upstream end; the channel drains into a deep pit, so
 * no open boundary is involved. A channel that is not aligned with the grid is a staircase: the water has to turn
 * 90° at every stair step of its banks. Before the smoothing limiter and the wall-advection treatment
 * (shaders/momentum.ts) that turning was damped like a strong viscosity against the walls, and 30–60° channels ran
 * 3.5–5× too deep (overtopping the real channels of the Johnstown preset within minutes at the 1936 discharge).
 *
 * Required: reach-averaged depth within 15 % of normal depth, discharge through a cross-section within 3 % of Q
 * (steady state reached). Typical on the M4: 0° 1.00, 30° 1.07, 45° 1.05, 60° 1.07 (30° and 60° are mirror
 * images: equal results also check the x/y symmetry of the scheme).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, gpuErrors, makeSolver } from '../helpers/gpu';

after(finishGpuTests);

const nx = 256;
const ny = 256;
const dx = 7;
const slope = 0.003;
const manningN = 0.035;
const Q = 500;
const width = 56;
const normalDepth = Math.pow(((Q / width) * manningN) / Math.sqrt(slope), 0.6);

async function channel(angleDeg: number) {
  const a = (angleDeg * Math.PI) / 180;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const x0 = 20;
  const y0 = 20;
  // Along-channel coordinate s and cross-channel coordinate d of a cell centre, in cells.
  const sOf = (i: number, j: number) => (i + 0.5 - x0) * ca + (j + 0.5 - y0) * sa;
  const dOf = (i: number, j: number) => -(i + 0.5 - x0) * sa + (j + 0.5 - y0) * ca;
  // Length inside the domain (from the start to the first edge along the axis, minus a margin).
  const len = Math.min(ca > 1e-6 ? (nx - 12 - x0) / ca : Infinity, sa > 1e-6 ? (ny - 12 - y0) / sa : Infinity);
  const pitStart = len - 40;
  const elevation = new Float32Array(nx * ny);
  const depth = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const s = sOf(i, j);
      const d = dOf(i, j);
      const c = j * nx + i;
      elevation[c] = 200;
      if (Math.abs(d) * dx < width / 2 && s > -2 && s < len) {
        elevation[c] = s >= pitStart ? -100 : 100 - slope * s * dx;
        // Start at normal depth (still water): only the velocity field has to develop.
        if (s < pitStart) depth[c] = normalDepth;
      }
    }
  }
  const solver = await makeSolver({ nx, ny, cellSize: dx, elevation, depth, params: { boundary: 'wall', manningN } });
  solver.setSources([{ id: 'q', type: 'inflow', gx: x0 + 6 * ca, gy: y0 + 6 * sa, radius: 3, discharge: Q }]);
  while (solver.time < 1800) {
    solver.runSubsteps(100);
    await solver.readbackNow();
  }
  const st = await solver.debugReadState();
  // Reach average over the middle of the channel, centre band |d| < 1.5 cells.
  const s1 = 30;
  const s2 = pitStart - 30;
  let sum = 0;
  let n = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const s = sOf(i, j);
      if (s >= s1 && s <= s2 && Math.abs(dOf(i, j)) < 1.5) {
        sum += st.h[j * nx + i];
        n++;
      }
    }
  }
  // Discharge through the cross-section at the middle of the reach (faces whose cell centres straddle s = sm).
  const sm = 0.5 * (s1 + s2);
  let q = 0;
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const c = j * nx + i;
      const s = sOf(i, j);
      if (s < sm && sOf(i + 1, j) >= sm) q += st.qx[c] * dx;
      if (s >= sm && sOf(i + 1, j) < sm) q -= st.qx[c] * dx;
      if (s < sm && sOf(i, j + 1) >= sm) q += st.qy[c] * dx;
      if (s >= sm && sOf(i, j + 1) < sm) q -= st.qy[c] * dx;
    }
  }
  solver.destroy();
  return { ratio: sum / n / normalDepth, discharge: q, reach: [s1, s2] };
}

test('uniform flow in walled channels at 0/30/45/60° to the grid runs at Manning normal depth (±15 %)', async () => {
  const results: string[] = [];
  const ratios: Record<number, number> = {};
  for (const angle of [0, 30, 45, 60]) {
    const r = await channel(angle);
    ratios[angle] = r.ratio;
    results.push(`${angle}°: ${r.ratio.toFixed(3)} (Q ${r.discharge.toFixed(0)})`);
    assert.ok(Math.abs(r.discharge / Q - 1) < 0.03, `${angle}°: not steady, discharge ${r.discharge}`);
    assert.ok(Math.abs(r.ratio - 1) < 0.15, `${angle}°: depth / normal depth = ${r.ratio}`);
  }
  console.log(`  normal depth ${normalDepth.toFixed(2)} m; depth / normal depth by angle: ${results.join(', ')}`);
  assert.ok(Math.abs(ratios[30] - ratios[60]) < 0.01, 'x/y symmetry: 30° and 60° are mirror images');
  assert.deepEqual(gpuErrors(), []);
});
