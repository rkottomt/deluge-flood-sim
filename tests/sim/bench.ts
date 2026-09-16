/**
 * Solver throughput benchmark (Node + Dawn → Metal on the dev Mac).
 *
 *   node --import tsx tests/sim/bench.ts            # 512², 1024², 2048² synthetic + Pittsburgh preset if baked
 *   node --import tsx tests/sim/bench.ts 1024       # one size
 *
 * Reports substeps/second of the full per-substep pipeline (momentum + continuity passes), the cost of the
 * per-frame export pass, the readback (map + CPU stats) cost, and what that means against DESIGN §3.4:
 * 1024² ≥ 4 substeps/frame at 30 fps (120 substeps/s + render), 512² ≥ 16 substeps/frame at 60 fps (960/s).
 * Timing is wall-clock from submit to queue.onSubmittedWorkDone over large batches, so driver scheduling is
 * included (conservative).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getGpu } from '../helpers/gpu';
import { createSolver, type GpuFloodSolver } from '../../src/sim';
import type { SimParams } from '../../src/contracts';

const now = () => performance.now();

/** A river valley with side hills and noise, partly filled: a realistic wet/dry mix. */
function valley(n: number, cellSize: number) {
  const elevation = new Float32Array(n * n);
  const depth = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i / n;
      const y = j / n;
      const river = 0.5 + 0.12 * Math.sin(y * 6.0);
      const d = Math.abs(x - river);
      const z =
        200 - 25 * y + 120 * d * d * 4 + 6 * Math.sin(x * 40) * Math.cos(y * 33) + 2 * Math.sin((x + y) * 170);
      elevation[j * n + i] = z;
      const channel = 200 - 25 * y + 3; // water surface ~3 m above the valley floor along the river
      depth[j * n + i] = d < 0.08 ? Math.max(0, channel - z) : 0;
    }
  }
  return { nx: n, ny: n, cellSize, elevation, depth };
}

async function waitDone(device: GPUDevice) {
  await device.queue.onSubmittedWorkDone();
}

async function measure(label: string, solver: GpuFloodSolver, device: GPUDevice) {
  const dt = solver.computeDt();
  // Warm up (pipeline specialization, memory residency, flow development).
  solver.runSubsteps(60, dt);
  await solver.readbackNow();
  await waitDone(device);

  // Substep throughput: time a batch that lasts ≥ 1.5 s.
  let batch = 20;
  let substepsPerSec = 0;
  for (;;) {
    const t0 = now();
    solver.runSubsteps(batch, dt);
    await waitDone(device);
    const ms = now() - t0;
    if (ms > 1500 || batch >= 20000) {
      substepsPerSec = (batch * 1000) / ms;
      break;
    }
    batch = Math.ceil(batch * Math.max(2, 1600 / Math.max(ms, 1)));
  }

  // Export pass alone (a frame with one substep minus a substep).
  const frames = 60;
  const t1 = now();
  for (let k = 0; k < frames; k++) solver.runSubsteps(1, dt);
  await waitDone(device);
  const perFrame1 = (now() - t1) / frames;
  const exportMs = Math.max(0, perFrame1 - 1000 / substepsPerSec);

  // Readback: encode + map + CPU stats.
  const reads = 8;
  const t2 = now();
  for (let k = 0; k < reads; k++) await solver.readbackNow();
  const readbackMs = (now() - t2) / reads;
  const cpuMs = solver.readbackDiagnostics.processMs;

  const msPerSubstep = 1000 / substepsPerSec;
  const at30 = Math.floor((33.3 - 8) / msPerSubstep); // leave ~8 ms of the frame for rendering
  const at60 = Math.floor((16.7 - 6) / msPerSubstep);
  console.log(
    `${label.padEnd(26)} ${substepsPerSec.toFixed(0).padStart(6)} substeps/s  (${msPerSubstep.toFixed(2)} ms each, dt ${dt.toFixed(3)} s)  ` +
      `export ${exportMs.toFixed(2)} ms  readback ${readbackMs.toFixed(1)} ms (CPU ${cpuMs.toFixed(1)} ms)  ` +
      `≈ ${at30} substeps/frame @30fps, ${at60} @60fps`,
  );
  return substepsPerSec;
}

async function main() {
  const { device, description } = await getGpu();
  console.log(`GPU: ${description}`);
  const arg = process.argv[2];
  const sizes = arg ? [Number(arg)] : [512, 1024, 2048];
  const params: Partial<SimParams> = { rainRate: 50, manningN: 0.035, boundary: 'open' };

  for (const n of sizes) {
    const v = valley(n, 8192 / n);
    const solver = await createSolver(device, v, params);
    solver.setInitialWater(v.depth);
    solver.setSources([{ id: 'in', type: 'inflow', gx: n / 2, gy: 4, radius: 6, discharge: 400 }]);
    await measure(`valley ${n}²`, solver, device);
    solver.destroy();
  }

  // Real terrain: the baked Pittsburgh preset (flat rivers pre-filled by stage level), if available.
  const dir = path.resolve(import.meta.dirname, '../../public/presets/pittsburgh');
  if (!arg && fs.existsSync(path.join(dir, 'elevation.f32'))) {
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const buf = fs.readFileSync(path.join(dir, 'elevation.f32'));
    const elevation = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const level: number = meta.scenario?.stage?.normalLevel ?? 216.3;
    const depth = new Float32Array(elevation.length);
    for (let k = 0; k < depth.length; k++) depth[k] = Math.max(0, level - elevation[k]); // bathtub fill (bench only)
    const solver = await createSolver(device, { nx: meta.nx, ny: meta.ny, cellSize: meta.cellSize, elevation }, { ...params, rainRate: 20 });
    solver.setInitialWater(depth);
    solver.setSources(meta.scenario?.sources ?? []);
    await measure(`pittsburgh ${meta.nx}² (bathtub)`, solver, device);
    solver.destroy();
  }
  process.exit(0);
}

void main();
