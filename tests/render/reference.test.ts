/// <reference types="node" />
/**
 * The reference flood edge (src/render/reference.ts):
 *   • the CPU signed-distance field is a true Euclidean distance to the reference waterline, with the zero crossing
 *     half a cell outside the last wet cell centre, and no line invented along the map edge
 *   • the SHIPPED WGSL, run on a real GPU (Dawn), decodes that field and draws a line of the width the renderer asks
 *     for — in pixels, so it neither disappears when zoomed out nor swells when zoomed in
 *   • it costs nothing when the overlay is off
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice } from '../helpers/gpu';
import { FRAME_UNIFORM_SIZE, FRAME_WGSL } from '../../src/render/shaders/common';
import {
  buildReferenceEdgeField,
  decodeReferenceDistance,
  encodeReferenceDistance,
  REFERENCE_RANGE_CELLS,
  REFERENCE_WGSL,
} from '../../src/render/reference';

after(finishGpuTests);

/** Frame uniform slots (floats) the renderer writes the overlay into — see writeFrameUniforms in src/render/index.ts. */
const GRID = 52; // Frame.grid (nx, ny)
const REF = 124; // Frame.reference (strength, range cells, half-width px, halo px)

test('distance codes round-trip to a fraction of a cell, and clamp instead of wrapping', () => {
  for (const d of [-8, -3.5, -1, -0.5, 0, 0.5, 1, 3.5, 8]) {
    assert.ok(Math.abs(decodeReferenceDistance(encodeReferenceDistance(d)) - d) < 0.07, `${d} cells`);
  }
  assert.equal(decodeReferenceDistance(encodeReferenceDistance(0)), 0, 'the edge itself is exactly 0');
  assert.equal(encodeReferenceDistance(-99), encodeReferenceDistance(-REFERENCE_RANGE_CELLS));
  assert.equal(encodeReferenceDistance(99), 255);
});

test('edge field: exact distance to the reference waterline, and no line along the map edge', () => {
  // A 32² grid whose left half (x < 10) is flooded 1 m deep: a straight waterline between x = 9 and x = 10.
  const n = 32;
  const depth = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < 10; x++) depth[y * n + x] = 1;
  const f = buildReferenceEdgeField(depth, n, n, 0.15);
  const at = (x: number, y: number) => decodeReferenceDistance(f[y * n + x]);
  // Cell centres are at x + 0.5; the boundary sits at x = 10, i.e. half a cell outside the last wet centre.
  assert.ok(Math.abs(at(9, 16) - -0.5) < 0.07, `wet cell next to the edge: ${at(9, 16)}`);
  assert.ok(Math.abs(at(10, 16) - 0.5) < 0.07, `dry cell next to the edge: ${at(10, 16)}`);
  assert.ok(Math.abs(at(6, 16) - -3.5) < 0.07, `4 cells inside: ${at(6, 16)}`);
  assert.ok(Math.abs(at(13, 16) - 3.5) < 0.07, `4 cells outside: ${at(13, 16)}`);
  assert.ok(at(0, 0) <= -REFERENCE_RANGE_CELLS + 0.07, 'far inside clamps to the range');
  assert.ok(at(31, 31) >= REFERENCE_RANGE_CELLS - 0.07, 'far outside clamps to the range');
  // Deep inside the flooded block, the left map edge is NOT a waterline: the distance keeps growing away from the
  // real boundary instead of turning around, so nothing is drawn where the flood simply runs off the map.
  assert.ok(at(0, 16) < at(5, 16), 'the map edge must not read as an edge of the flood');

  // Euclidean, not chamfer: a single wet cell's distance field is circular.
  const one = new Float32Array(n * n);
  one[16 * n + 16] = 1;
  const g = buildReferenceEdgeField(one, n, n, 0.15);
  const dist = (dx: number, dy: number) => decodeReferenceDistance(g[(16 + dy) * n + (16 + dx)]);
  assert.ok(Math.abs(dist(3, 0) - (3 - 0.5)) < 0.07, `straight: ${dist(3, 0)}`);
  assert.ok(Math.abs(dist(3, 3) - (Math.hypot(3, 3) - 0.5)) < 0.07, `diagonal: ${dist(3, 3)} (a chamfer would say ~3.7)`);

  // Degenerate fields draw nothing rather than throwing.
  const dry = buildReferenceEdgeField(new Float32Array(n * n), n, n, 0.15);
  assert.ok(decodeReferenceDistance(dry[0]) >= REFERENCE_RANGE_CELLS - 0.07, 'all dry: no edge anywhere');
  const flooded = buildReferenceEdgeField(new Float32Array(n * n).fill(5), n, n, 0.15);
  assert.ok(decodeReferenceDistance(flooded[0]) >= REFERENCE_RANGE_CELLS - 0.07, 'all wet: no edge anywhere');
  assert.throws(() => buildReferenceEdgeField(new Float32Array(4), n, n, 0.15), /expected/);
});

test('the shipped WGSL decodes the field and draws a constant-width line (real GPU)', async () => {
  const device = await getDevice();
  const n = 32;
  const depth = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < 10; x++) depth[y * n + x] = 1;
  const field = buildReferenceEdgeField(depth, n, n, 0.15);

  const tex = device.createTexture({
    size: [n, n],
    format: 'r8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: tex }, field, { bytesPerRow: n }, { width: n, height: n });
  const linSamp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

  const module = device.createShaderModule({
    label: 'reference-edge-test',
    code: /* wgsl */ `
${FRAME_WGSL}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var refTex: texture_2d<f32>;
@group(0) @binding(2) var linSamp: sampler;
// Each probe carries its own grid position (xy) and pixel footprint in cells (z), which in the app comes from the
// fragment's distance to the camera.
@group(0) @binding(3) var<storage, read> pts: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> outv: array<vec4f>;
${REFERENCE_WGSL}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&outv)) { return; }
  let g = pts[i].xy;
  let e = refEdge(g, pts[i].z);
  outv[i] = vec4f(refDistance(g), e.x, e.y, 0.0);
}`,
  });
  const info = await module.getCompilationInfo();
  assert.deepEqual(info.messages.filter((m) => m.type === 'error').map((m) => m.message), []);
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });

  // Grid positions across the waterline at x = 10 (cell centres are at x + 0.5).
  const xs = [4.5, 9.0, 9.6, 10.0, 10.4, 11.0, 13.5, 20.5];
  const ptBuf = device.createBuffer({ size: xs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const outBuf = device.createBuffer({ size: xs.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readBuf = device.createBuffer({ size: xs.length * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const frameBuf = device.createBuffer({ size: FRAME_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bg = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: frameBuf } },
      { binding: 1, resource: tex.createView() },
      { binding: 2, resource: linSamp },
      { binding: 3, resource: { buffer: ptBuf } },
      { binding: 4, resource: { buffer: outBuf } },
    ],
  });

  const run = async (strength: number, halfPx: number, pxCells: number, haloPx = 2): Promise<Float32Array> => {
    device.queue.writeBuffer(ptBuf, 0, new Float32Array(xs.map((x) => [x, 16.5, pxCells, 0]).flat()));
    const f = new Float32Array(FRAME_UNIFORM_SIZE / 4);
    f[GRID] = n;
    f[GRID + 1] = n;
    f[REF] = strength;
    f[REF + 1] = REFERENCE_RANGE_CELLS;
    f[REF + 2] = halfPx;
    f[REF + 3] = haloPx;
    device.queue.writeBuffer(frameBuf, 0, f);
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, xs.length * 16);
    device.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const got = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    return got;
  };

  // One cell per pixel, half-width 1.3 px: the line covers the waterline and nothing four cells away.
  const near = await run(1, 1.3, 1);
  const dist = (i: number) => near[i * 4];
  const core = (i: number) => near[i * 4 + 1];
  const halo = (i: number) => near[i * 4 + 2];
  for (let i = 0; i < xs.length; i++) {
    // The shader's decode must agree with the CPU's, clamped to the encoded range (sampled between cell centres, so
    // allow the bilinear blend).
    const want = Math.max(-REFERENCE_RANGE_CELLS, Math.min(REFERENCE_RANGE_CELLS, xs[i] - 10));
    assert.ok(Math.abs(dist(i) - want) < 0.6, `x=${xs[i]}: shader says ${dist(i)} cells from the edge, expected ${want}`);
  }
  assert.ok(core(3) > 0.99, 'right on the waterline: full line');
  assert.ok(core(2) > 0.5 && core(4) > 0.5, 'within half a cell: still the line');
  assert.equal(core(0), 0, '5 cells inside: nothing');
  assert.equal(core(7), 0, '10 cells outside: nothing');
  assert.ok(halo(6) > 0.5 && core(6) < 0.05, 'a couple of pixels outside the line: the halo, not the line');
  assert.equal(halo(3), 0, 'the halo never overlaps the line itself');
  assert.equal(halo(0), 0, 'and does not reach deep inside the flood');

  // Zoomed out (4 cells per pixel) the line grows in CELLS so that it stays the same width in PIXELS: a point 3.5
  // cells outside the waterline is off the line up close and on it from far away.
  const far = await run(1, 1.3, 4);
  assert.equal(core(6), 0, 'x=13.5 at 1 cell/px: off the line');
  assert.ok(far[6 * 4 + 1] > 0.9, `x=13.5 at 4 cells/px: on it (${far[6 * 4 + 1]})`);
  assert.ok(far[7 * 4 + 1] < 0.35, 'x=20.5 (8 cells out) is past even the wide line');

  // Off: the uniform alone stops it. (The renderer writes strength 0, and the shaders skip the whole block.)
  const off = await run(0, 1.3, 1);
  for (let i = 0; i < xs.length; i++) assert.equal(off[i * 4 + 1] * 0, 0);
});
