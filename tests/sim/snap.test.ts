/**
 * The exact-bookkeeping WGSL helpers (SNAP_WGSL in src/sim/shaders/common.ts), run on the real GPU.
 *
 * snapE / snapInc are what make the continuity pass's mass ledger exact: a + snapInc(a, d) must be exactly
 * representable, and the snapped value must be what a strict IEEE round-half-to-even onto the ULP grid gives, for deep
 * water, thin films and tiny values alike. An earlier version built the grid with ldexp down to 2^-149: Apple GPUs flush
 * subnormals to zero, so d ≈ 1e-35 divided by 0 gave NaN, which leaked into the accounting buffer.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice, gpuErrors } from '../helpers/gpu';
import { SNAP_WGSL } from '../../src/sim/shaders/common';
import { rng } from '../helpers/terrain';

after(finishGpuTests);

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** Biased Float32 exponent of |x|. */
function biasedExp(x: number): number {
  f32[0] = Math.abs(x);
  return (u32[0] >>> 23) & 0xff;
}
function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}
/** Float64 reference of snapInc (inputs are Float32 values). */
function snapIncRef(a: number, d: number): number {
  const e = Math.max(biasedExp(Math.max(Math.abs(a), Math.abs(d))), 24);
  const ulp = 2 ** (e - 150);
  return roundHalfEven(d / ulp) * ulp;
}

async function runSnap(pairs: [number, number][]): Promise<Float32Array> {
  const device = await getDevice();
  const code = /* wgsl */ `
${SNAP_WGSL}
@group(0) @binding(0) var<storage, read_write> b: array<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x * 4u;
  if (k + 3u >= arrayLength(&b)) { return; }
  let a = b[k];
  let d = b[k + 1u];
  let q = snapInc(a, d);
  b[k + 2u] = q;
  b[k + 3u] = a + q;
}`;
  const data = new Float32Array(pairs.length * 4);
  pairs.forEach(([a, d], i) => {
    data[4 * i] = a;
    data[4 * i + 1] = d;
  });
  const buf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(buf, 0, data);
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
  const read = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(Math.ceil(pairs.length / 64));
  pass.end();
  enc.copyBufferToBuffer(buf, 0, read, 0, data.byteLength);
  device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const out = new Float32Array(read.getMappedRange().slice(0));
  read.unmap();
  buf.destroy();
  read.destroy();
  return out;
}

test('snapInc on the GPU: strict round-to-grid, a + snapInc(a, d) exact, no NaN for tiny or subnormal values', async () => {
  const rand = rng(11);
  const pairs: [number, number][] = [
    [20, 7e-7],
    [20, 1.9e-6],
    [22.5, -3.3e-6],
    [0, 1e-35],
    [0, 2e-38],
    [0, -3e-39],
    [1e-40, 1e-41],
    [0, 1e-40],
    [5, 3e-45],
    [1e-30, 1e-31],
    [0, 0],
    [0, 0.4],
    [1e-4, 1e-2],
  ];
  // Deep and shallow water with increments from 1e-9 m to half the depth, both signs.
  for (let k = 0; k < 4000; k++) {
    const a = Math.fround(10 ** (rand() * 7 - 5)); // 1e-5 … 100 m
    const d = Math.fround((rand() < 0.5 ? -1 : 1) * a * 10 ** (-rand() * 9) * 0.5);
    pairs.push([a, d]);
  }
  const out = await runSnap(pairs);
  let mismatches = 0;
  let inexact = 0;
  for (let i = 0; i < pairs.length; i++) {
    const a = out[4 * i];
    const d = out[4 * i + 1];
    const q = out[4 * i + 2];
    const sum = out[4 * i + 3];
    assert.ok(Number.isFinite(q) && Number.isFinite(sum), `non-finite for a=${a} d=${d}: q=${q}`);
    // Subnormal inputs may be flushed to zero by the GPU; then q = 0 is the only acceptable answer.
    const tiny = Math.abs(d) < 2 ** -126;
    if (tiny) {
      assert.ok(q === 0 || q === snapIncRef(a, d), `a=${a} d=${d}: q=${q}`);
      continue;
    }
    if (q !== snapIncRef(a, d)) mismatches++;
    // |a| ≥ |d| and no carry into the next power of two: the Float32 sum is the exact real sum.
    if (Math.abs(a) >= Math.abs(d) && biasedExp(a + q) === biasedExp(a) && sum !== a + q) inexact++;
  }
  console.log(`  ${pairs.length} pairs: ${mismatches} differ from the Float64 reference, ${inexact} inexact sums`);
  assert.equal(mismatches, 0);
  assert.equal(inexact, 0);
  assert.deepEqual(gpuErrors(), []);
});

test('snapInc keeps non-finite values non-finite (naive mode must still visibly blow up)', async () => {
  const out = await runSnap([
    [1, Infinity],
    [Infinity, 1],
    [1, -Infinity],
  ]);
  assert.equal(out[2], Infinity);
  assert.ok(!Number.isFinite(out[4 + 3]));
  assert.equal(out[8 + 2], -Infinity);
});
