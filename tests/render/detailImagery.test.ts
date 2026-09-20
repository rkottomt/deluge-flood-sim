/// <reference types="node" />
/**
 * The close-up imagery inset in the renderer:
 *   • what a full-mip RGBA8 photo costs on the GPU — the number the inset is justified by
 *   • the shipped WGSL feather (src/render/shaders/terrain.ts), run on a real GPU (Dawn): 0 outside the inset's
 *     rectangle, 1 well inside, a smooth ramp across the feather, and nothing at all when no inset is bound.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice } from '../helpers/gpu';
import { imageryTextureBytes, mipCount } from '../../src/render/textures';
import { FRAME_UNIFORM_SIZE, FRAME_WGSL } from '../../src/render/shaders/common';
import { DETAIL_IMAGERY_WGSL } from '../../src/render/shaders/terrain';

after(finishGpuTests);

const MB = 1 / 1e6;
/** Frame uniform slots (floats) the renderer writes the inset into — see writeFrameUniforms in src/render/index.ts. */
const RECT0 = 116;
const STRENGTH = 120;
const FEATHER = 121;

test('imagery texture cost: 4096² is affordable next to the solver, 8192² is not', () => {
  assert.equal(mipCount(4096, 4096), 13);
  // 67.1 MB of level 0 plus a 1/3 mip tail.
  assert.ok(Math.abs(imageryTextureBytes(4096, 4096) * MB - 89.5) < 0.1, `${imageryTextureBytes(4096, 4096) * MB} MB`);
  assert.ok(Math.abs(imageryTextureBytes(8192, 8192) * MB - 358) < 1, `${imageryTextureBytes(8192, 8192) * MB} MB`);
  // Base photo + inset must stay well under what one 8192² base would have cost.
  const pair = imageryTextureBytes(4096, 4096) * 2;
  assert.ok(pair < imageryTextureBytes(8192, 8192) * 0.55, `${pair * MB} MB for both photos`);
  assert.equal(imageryTextureBytes(1, 1), 4, 'the 1x1 placeholder costs nothing');
});

test('detailWeight: feathered inside the rectangle, zero outside, off when no inset is bound', async () => {
  const device = await getDevice();
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);

  const module = device.createShaderModule({
    label: 'detail-weight-test',
    code: /* wgsl */ `
${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> pts: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> outw: array<f32>;
${DETAIL_IMAGERY_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&outw)) { return; }
  outw[i] = detailWeight(pts[i]);
}`,
  });
  const info = await module.getCompilationInfo();
  assert.deepEqual(info.messages.filter((m) => m.type === 'error').map((m) => m.message), []);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  // The rectangle baked for pittsburgh, with the renderer's 8-cell feather.
  const rect = { x0: 157, y0: 348, x1: 541, y1: 732 };
  const feather = 8;
  const pts = [
    [349, 540], // middle of the inset
    [100, 540], // outside, west
    [600, 540], // outside, east
    [349, 200], // outside, north
    [157, 540], // exactly on the west edge
    [161, 540], // half a feather inside
    [165, 540], // a full feather inside
    [160, 351], // near a corner: the nearest edge is 3 cells away
  ];
  const expected = [1, 0, 0, 0, 0, 0.5, 1, 0.31640625]; // smoothstep(0, 8, d)

  const ptBuf = device.createBuffer({ size: pts.length * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ptBuf, 0, new Float32Array(pts.flat()));
  const outBuf = device.createBuffer({ size: pts.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: pts.length * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const frameBuf = device.createBuffer({ size: FRAME_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameBuf } },
      { binding: 1, resource: { buffer: ptBuf } },
      { binding: 2, resource: { buffer: outBuf } },
    ],
  });

  const run = async (strength: number): Promise<Float32Array> => {
    const f = new Float32Array(FRAME_UNIFORM_SIZE / 4);
    f[RECT0] = rect.x0;
    f[RECT0 + 1] = rect.y0;
    f[RECT0 + 2] = rect.x1;
    f[RECT0 + 3] = rect.y1;
    f[STRENGTH] = strength;
    f[FEATHER] = feather;
    device.queue.writeBuffer(frameBuf, 0, f);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, pts.length * 4);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const got = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return got;
  };

  const on = await run(1);
  for (let i = 0; i < pts.length; i++) {
    assert.ok(Math.abs(on[i] - expected[i]) < 1e-4, `point ${pts[i]}: ${on[i]} vs ${expected[i]}`);
  }
  const off = await run(0);
  assert.deepEqual([...off], new Array(pts.length).fill(0), 'no inset bound → the base photo everywhere');
  assert.deepEqual(errors, []);
});
