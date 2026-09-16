/**
 * GPU test of the render prep compute passes (Dawn): per-vertex bed/water surface, shoreline plane extension,
 * no visible water behind a wall, and the wet pyramid used to cull dry water geometry.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { create, globals } from 'webgpu';
import { createDelugeDevice } from '../../src/gpu';

Object.assign(globalThis, globals);

after(() => {
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
});

const N = 64;

/** Read a float texture (r32float, rgba32float or rgba16float) back as float32 channels. */
async function readTexture(device: GPUDevice, tex: GPUTexture, w: number, h: number, mip = 0): Promise<Float32Array> {
  const half = tex.format === 'rgba16float';
  const channels = tex.format === 'r32float' ? 1 : 4;
  const bpp = channels * (half ? 2 : 4);
  const bytesPerRow = Math.ceil((w * bpp) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, mipLevel: mip }, { buffer: buf, bytesPerRow }, { width: w, height: h });
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const bytes = new DataView(buf.getMappedRange());
  const out = new Float32Array(w * h * channels);
  const halfToFloat = (x: number) => {
    const sgn = x & 0x8000 ? -1 : 1;
    const e = (x >> 10) & 0x1f;
    const f = x & 0x3ff;
    if (e === 0) return sgn * 2 ** -14 * (f / 1024);
    if (e === 31) return f ? NaN : sgn * Infinity;
    return sgn * 2 ** (e - 15) * (1 + f / 1024);
  };
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w * channels; i++) {
      const o = j * bytesPerRow + i * (half ? 2 : 4);
      out[j * w * channels + i] = half ? halfToFloat(bytes.getUint16(o, true)) : bytes.getFloat32(o, true);
    }
  }
  buf.unmap();
  buf.destroy();
  return out;
}

test('prep: water surface, shoreline extension, walls and wet pyramid', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const gpu = create([]) as unknown as GPU;
  const { device } = await createDelugeDevice(gpu);
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  const P = await createPipelines(device, 'bgra8unorm');

  // Scene: river (η = 101, h = 1 over bed 100) for i < 20; a 1-cell wall (ground 100 + 3 m) at i = 20; dry low
  // ground (99, below the river level) behind it for i > 20; a dry bank (bed 102) for rows j ≥ 48; dry uplands for
  // i ≥ 40 (bed 110).
  const ground = new Float32Array(N * N);
  const barrier = new Float32Array(N * N);
  const state = new Float32Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      let g = 100;
      if (i > 20) g = 99;
      if (i >= 40) g = 110;
      if (j >= 48 && i < 20) g = 102;
      ground[c] = g;
      if (i === 20) barrier[c] = 3;
      if (i < 20 && j < 48) {
        state[c * 4] = 1; // h
        state[c * 4 + 1] = 0.5; // u
        state[c * 4 + 3] = 1.2; // max depth
      }
    }
  }
  const bed = ground.map((g, c) => g + barrier[c]);
  const tex = (format: GPUTextureFormat, data: Float32Array, bpp: number) => {
    const t = device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data as Float32Array<ArrayBuffer>, { bytesPerRow: N * bpp }, [N, N]);
    return t;
  };
  const bedTex = tex('r32float', bed, 4);
  const barrierTex = tex('r32float', barrier, 4);
  const stateTex = tex('rgba32float', state, 16);
  const out = (format: GPUTextureFormat, w: number, h: number, mips = 1) =>
    device.createTexture({ size: [w, h], format, mipLevelCount: mips, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  const V = N + 1;
  const vtx = out('rgba32float', V, V);
  const surf = out('rgba16float', N, N);
  const norm = out('rgba16float', N, N);
  const misc = out('rgba16float', N, N);
  const wetMips = Math.log2(N) + 1;
  const wet = out('r32float', N, N, wetMips);

  const params = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const pb = new ArrayBuffer(48);
  const pi = new Int32Array(pb);
  const pf = new Float32Array(pb);
  pi[0] = N;
  pi[1] = N;
  pi[2] = V;
  pi[3] = V;
  pi[4] = 1;
  pi[5] = 0;
  pf[6] = 0.01;
  pf[7] = 8;
  pf[8] = 0.05;
  device.queue.writeBuffer(params, 0, pb);
  const common = [
    { binding: 0, resource: { buffer: params } },
    { binding: 1, resource: bedTex.createView() },
    { binding: 2, resource: barrierTex.createView() },
    { binding: 3, resource: stateTex.createView() },
  ];
  const enc = device.createCommandEncoder();
  const cp = enc.beginComputePass();
  cp.setPipeline(P.prepCells);
  cp.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepCells.getBindGroupLayout(0),
      entries: [...common, { binding: 4, resource: surf.createView() }, { binding: 5, resource: norm.createView() }, { binding: 6, resource: misc.createView() }],
    }),
  );
  cp.dispatchWorkgroups(N / 16, N / 16);
  cp.setPipeline(P.prepVerts);
  cp.setBindGroup(0, device.createBindGroup({ layout: P.prepVerts.getBindGroupLayout(0), entries: [...common, { binding: 4, resource: vtx.createView() }] }));
  cp.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
  cp.setPipeline(P.wetBase);
  cp.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.wetBase.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: vtx.createView() },
        { binding: 1, resource: wet.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
      ],
    }),
  );
  cp.dispatchWorkgroups(N / 16, N / 16);
  cp.setPipeline(P.wetDown);
  for (let lv = 1; lv < wetMips; lv++) {
    cp.setBindGroup(
      0,
      device.createBindGroup({
        layout: P.wetDown.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: wet.createView({ baseMipLevel: lv - 1, mipLevelCount: 1 }) },
          { binding: 1, resource: wet.createView({ baseMipLevel: lv, mipLevelCount: 1 }) },
        ],
      }),
    );
    cp.dispatchWorkgroups(Math.ceil((N >> lv) / 8), Math.ceil((N >> lv) / 8));
  }
  cp.end();
  device.queue.submit([enc.finish()]);

  const v = await readTexture(device, vtx, V, V);
  const at = (k: number, l: number) => {
    const o = (l * V + k) * 4;
    return { bed: v[o], surface: v[o + 1], depth: v[o + 2], wet: v[o + 3] };
  };
  const close = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) < eps;

  // Open river: flat surface at η = 101 over bed 100.
  const r = at(10, 20);
  assert.ok(close(r.bed, 100) && close(r.surface, 101) && r.wet === 1, JSON.stringify(r));

  // Dry bank vertex one row past the wet ones: the water plane is extended under it (flat, below the bank).
  const bank = at(10, 49);
  assert.equal(bank.wet, 0);
  assert.ok(close(bank.surface, 101), `bank surface ${bank.surface}`);
  assert.ok(bank.surface < bank.bed, 'extended plane stays below the bank');

  // Wall crest vertex keeps the full barrier height; the plane is extended under it but never above its bed.
  const crest = at(21, 20);
  assert.ok(close(crest.bed, 0.25 * (100 + 99 + 100 + 99) + 3), `crest bed ${crest.bed}`);
  assert.ok(crest.surface <= crest.bed - 0.049);
  // Behind the wall: low ground (99) below the river level must stay dry: surface ≤ bed − collapse.
  for (const k of [22, 23, 30]) {
    const b = at(k, 20);
    assert.ok(b.surface <= b.bed - 0.049, `water leaks behind the wall at k=${k}: ${JSON.stringify(b)}`);
    assert.equal(b.wet, 0);
  }
  // Water triangles between the crest and the protected side are entirely below the terrain (no visible sheet).
  const behind = at(22, 20);
  for (let t = 0; t <= 1; t += 0.1) {
    const surf = crest.surface + (behind.surface - crest.surface) * t;
    const bedT = crest.bed + (behind.bed - crest.bed) * t;
    assert.ok(surf < bedT, `visible water on the protected side at t=${t.toFixed(1)}`);
  }

  // Wet pyramid: mip 0 flags quads touching water (dilated by one cell), coarser mips are conservative maxima.
  const w0 = await readTexture(device, wet, N, N, 0);
  assert.equal(w0[20 * N + 10], 1);
  assert.equal(w0[20 * N + 19], 1, 'quad touching the wall-side water');
  assert.equal(w0[20 * N + 30], 0, 'protected land is dry');
  assert.equal(w0[60 * N + 10], 0, 'upper bank is dry');
  const w3 = await readTexture(device, wet, N >> 3, N >> 3, 3);
  assert.equal(w3[(20 >> 3) * (N >> 3) + (10 >> 3)], 1);
  assert.equal(w3[(20 >> 3) * (N >> 3) + (45 >> 3)], 0);
  const wTop = await readTexture(device, wet, 1, 1, wetMips - 1);
  assert.equal(wTop[0], 1);

  // Surface texture: depth and velocity pass through; the dry side has no foam.
  const s = await readTexture(device, surf, N, N);
  assert.ok(close(s[(20 * N + 10) * 4], 1, 1e-2) && close(s[(20 * N + 10) * 4 + 1], 0.5, 1e-2));
  assert.equal(s[(20 * N + 30) * 4 + 3], 0);

  assert.deepEqual(errors, []);
});
