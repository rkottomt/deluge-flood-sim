/**
 * GPU test of the render prep compute passes (Dawn): per-vertex bed/water surface, shoreline plane extension,
 * no visible water behind a wall, the wet pyramid used to cull dry water geometry, and the arrival / hazard-class
 * fields read from the solver's hazard accumulators.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice } from '../helpers/gpu';

// Lets queued GPU work finish; the process then exits on its own with the right exit code. The helper keeps the Dawn
// instance referenced for the life of the process.
after(finishGpuTests);

const N = 64;

/** Read a texture (r32float, rg32float, rgba32float, rgba16float or rgba8unorm) back as float32 channels. */
async function readTexture(device: GPUDevice, tex: GPUTexture, w: number, h: number, mip = 0): Promise<Float32Array> {
  const half = tex.format === 'rgba16float';
  const unorm8 = tex.format === 'rgba8unorm';
  const channels = tex.format === 'r32float' ? 1 : tex.format === 'rg32float' ? 2 : 4;
  const bpc = unorm8 ? 1 : half ? 2 : 4;
  const bpp = channels * bpc;
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
      const o = j * bytesPerRow + i * bpc;
      out[j * w * channels + i] = unorm8 ? bytes.getUint8(o) / 255 : half ? halfToFloat(bytes.getUint16(o, true)) : bytes.getFloat32(o, true);
    }
  }
  buf.unmap();
  buf.destroy();
  return out;
}

/** Stand-in for FloodSolver.hazardBuffer (the renderer's dummy): the prep's hazard field is off in these tests. */
function noHazard(device: GPUDevice): GPUBuffer {
  return device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE });
}

test('prep: water surface, shoreline extension, walls and wet pyramid', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const device = await getDevice();
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
  const cells = out('rg32float', N, N);
  const vtxBed = out('r32float', V, V);
  const wetMips = Math.log2(N) + 1;
  const wet = out('r32float', N, N, wetMips);

  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const pb = new ArrayBuffer(64);
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
      entries: [
        ...common,
        { binding: 4, resource: surf.createView() },
        { binding: 5, resource: norm.createView() },
        { binding: 6, resource: misc.createView() },
        { binding: 7, resource: cells.createView() },
        { binding: 8, resource: { buffer: noHazard(device) } },
        { binding: 9, resource: { buffer: noHazard(device) } },
        { binding: 10, resource: bedTex.createView() },
      ],
    }),
  );
  cp.dispatchWorkgroups(N / 16, N / 16);
  cp.setPipeline(P.prepVtxBed);
  cp.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepVtxBed.getBindGroupLayout(0),
      entries: [common[0], common[1], common[2], { binding: 4, resource: vtxBed.createView() }],
    }),
  );
  cp.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
  cp.setPipeline(P.prepVerts);
  cp.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepVerts.getBindGroupLayout(0),
      entries: [
        common[0],
        { binding: 4, resource: vtx.createView() },
        { binding: 5, resource: wet.createView() },
        { binding: 6, resource: cells.createView() },
        { binding: 7, resource: vtxBed.createView() },
        { binding: 8, resource: bedTex.createView() },
      ],
    }),
  );
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

  // ── Derived cell fields: the water-look channels ───────────────────────────────────────────────────────
  // misc = (barrier, max depth, speed, collected whitewater). The last one is what the water shader puts foam on:
  // it must be zero in open, uniform flow and clearly positive where the water is up against something.
  const m = await readTexture(device, misc, N, N);
  const mAt = (i: number, j: number) => {
    const o = (j * N + i) * 4;
    return { barrier: m[o], maxDepth: m[o + 1], speed: m[o + 2], collect: m[o + 3] };
  };
  const nrm = await readTexture(device, norm, N, N);
  const nAt = (i: number, j: number) => {
    const o = (j * N + i) * 4;
    return { bedX: nrm[o], bedZ: nrm[o + 1], etaX: nrm[o + 2], etaZ: nrm[o + 3] };
  };

  // Open river, uniform flow, flat surface: nothing to foam on, and no water-surface slope.
  const open = mAt(10, 20);
  assert.ok(close(open.speed, 0.5, 1e-2), `river speed ${open.speed}`);
  assert.ok(close(open.maxDepth, 1.2, 1e-2), `river max depth ${open.maxDepth}`);
  assert.equal(open.barrier, 0);
  assert.ok(open.collect < 0.02, `open river should not foam: ${open.collect}`);
  const openN = nAt(10, 20);
  assert.ok(close(openN.etaX, 0, 1e-3) && close(openN.etaZ, 0, 1e-3), `flat river has no surface slope: ${JSON.stringify(openN)}`);
  assert.ok(close(openN.bedX, 0, 1e-3), `flat river bed slope ${openN.bedX}`);

  // Against the wall (the cell whose +x neighbour is the 3 m barrier): water piling against something it cannot
  // cross, with a dry cell beside it — the levee case the shader draws foam along.
  const atWall = mAt(19, 20);
  assert.ok(atWall.collect > 0.3, `no whitewater against the wall: ${atWall.collect}`);
  // The bed slope still sees the wall (one-sided difference across a 3 m barrier over 2 cells of 8 m).
  assert.ok(nAt(19, 20).bedX > 0.1, `wall bed slope ${nAt(19, 20).bedX}`);

  // The shoreline row against the dry bank (j = 48) collects whitewater too; two rows in, it does not.
  assert.ok(mAt(10, 47).collect > 0.2, `no whitewater at the shoreline: ${mAt(10, 47).collect}`);
  assert.ok(mAt(10, 45).collect < 0.02, `whitewater two rows offshore: ${mAt(10, 45).collect}`);
  // Dry ground never foams.
  assert.equal(mAt(30, 20).collect, 0);
  // The domain edge is a cut face, not a shoreline: the water there must not be outlined in foam.
  assert.ok(mAt(0, 20).collect < 0.02, `domain edge foams: ${mAt(0, 20).collect}`);

  // The max-depth view is a static map of where the water reached; live foam on it would be a lie.
  pi[5] = 1;
  device.queue.writeBuffer(params, 0, pb);
  const miscMax = out('rgba16float', N, N);
  const encM = device.createCommandEncoder();
  const cpM = encM.beginComputePass();
  cpM.setPipeline(P.prepCells);
  cpM.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepCells.getBindGroupLayout(0),
      entries: [
        ...common,
        { binding: 4, resource: out('rgba16float', N, N).createView() },
        { binding: 5, resource: out('rgba16float', N, N).createView() },
        { binding: 6, resource: miscMax.createView() },
        { binding: 7, resource: out('rg32float', N, N).createView() },
        { binding: 8, resource: { buffer: noHazard(device) } },
        { binding: 9, resource: { buffer: noHazard(device) } },
        { binding: 10, resource: bedTex.createView() },
      ],
    }),
  );
  cpM.dispatchWorkgroups(N / 16, N / 16);
  cpM.end();
  device.queue.submit([encM.finish()]);
  const mm = await readTexture(device, miscMax, N, N);
  for (const [i, j] of [[19, 20], [10, 47], [10, 20]] as const) {
    assert.equal(mm[(j * N + i) * 4 + 3], 0, `max-depth view foams at ${i},${j}`);
  }
  pi[5] = 0;
  device.queue.writeBuffer(params, 0, pb);

  // Second prep using the pyramid as a hint (the renderer's steady state) must give identical vertices.
  pf[9] = 1;
  device.queue.writeBuffer(params, 0, pb);
  const vtx2 = out('rgba32float', V, V);
  const enc2 = device.createCommandEncoder();
  const cp2 = enc2.beginComputePass();
  cp2.setPipeline(P.prepVerts);
  cp2.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepVerts.getBindGroupLayout(0),
      entries: [
        common[0],
        { binding: 4, resource: vtx2.createView() },
        { binding: 5, resource: wet.createView() },
        { binding: 6, resource: cells.createView() },
        { binding: 7, resource: vtxBed.createView() },
        { binding: 8, resource: bedTex.createView() },
      ],
    }),
  );
  cp2.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
  cp2.end();
  device.queue.submit([enc2.finish()]);
  const v2 = await readTexture(device, vtx2, V, V);
  for (let i = 0; i < v.length; i++) assert.equal(v2[i], v[i], `hinted prep differs at ${i}`);

  // Surface texture: depth and velocity pass through; the dry side has no foam.
  const s = await readTexture(device, surf, N, N);
  assert.ok(close(s[(20 * N + 10) * 4], 1, 1e-2) && close(s[(20 * N + 10) * 4 + 1], 0.5, 1e-2));
  assert.equal(s[(20 * N + 30) * 4 + 3], 0);

  // Normally-wet mask (captured once per scene): r = wet test (h ≥ 1 cm), g = 5×5 average for a soft old bank.
  const normal = device.createTexture({ size: [N, N], format: 'rgba8unorm', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const enc3 = device.createCommandEncoder();
  const cp3 = enc3.beginComputePass();
  cp3.setPipeline(P.normalWater);
  cp3.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.normalWater.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: stateTex.createView() },
        { binding: 1, resource: normal.createView() },
      ],
    }),
  );
  cp3.dispatchWorkgroups(N / 16, N / 16);
  cp3.end();
  device.queue.submit([enc3.finish()]);
  const nm = await readTexture(device, normal, N, N);
  assert.equal(nm[(20 * N + 10) * 4], 1, 'river is normally wet');
  assert.equal(nm[(20 * N + 30) * 4], 0, 'protected land is not');
  assert.equal(nm[(20 * N + 10) * 4 + 1], 1, 'soft mask is 1 deep in the river');
  assert.ok(Math.abs(nm[(20 * N + 19) * 4 + 1] - 15 / 25) < 0.01, `soft mask at the bank ${nm[(20 * N + 19) * 4 + 1]}`);
  assert.equal(nm[(20 * N + 22) * 4 + 1], 0, 'soft mask is 0 three cells past the bank');

  assert.deepEqual(errors, []);
});

/**
 * Non-finite defence: the solver's 'naive' reference mode (and any future numerical accident) can leave NaN, ±Inf or
 * absurd values in the state texture. The prep pass must never hand those to the geometry — it substitutes a finite
 * spike so the frame stays drawable — and must mark the cell with the foam-channel sentinel the water shader paints
 * as magenta speckle, so a blow-up looks like broken numbers instead of a plausible flood.
 */
test('prep: blown-up cells never reach the geometry and are flagged for the glitch colour', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const device = await getDevice();
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  const P = await createPipelines(device, 'bgra8unorm');

  // Flat bed at 100 m under a wet sheet (h = 1, u = 0.5): ordinary water, no foam worth mentioning.
  const ground = new Float32Array(N * N).fill(100);
  const barrier = new Float32Array(N * N);
  const state = new Float32Array(N * N * 4);
  for (let c = 0; c < N * N; c++) {
    state[c * 4] = 1; // h
    state[c * 4 + 1] = 0.5; // u
    state[c * 4 + 3] = 1.2; // max depth
  }
  // Every way the state can stop being physical, one cell each.
  const blown: Array<[string, number, number[]]> = [
    ['NaN depth', 10 * N + 10, [NaN, 0.5, 0, 1.2]],
    ['+Inf depth', 10 * N + 12, [Infinity, 0.5, 0, 1.2]],
    ['NaN velocity', 10 * N + 14, [1, NaN, 0, 1.2]],
    ['runaway depth', 10 * N + 16, [5000, 0.5, 0, 1.2]],
    ['runaway speed', 10 * N + 18, [1, 500, -300, 1.2]],
    ['negative depth', 10 * N + 20, [-5, 0.5, 0, 1.2]],
  ];
  for (const [, c, v] of blown) state.set(v, c * 4);

  const tex = (format: GPUTextureFormat, data: Float32Array, bpp: number) => {
    const t = device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data as Float32Array<ArrayBuffer>, { bytesPerRow: N * bpp }, [N, N]);
    return t;
  };
  const bedTex = tex('r32float', ground, 4);
  const barrierTex = tex('r32float', barrier, 4);
  const stateTex = tex('rgba32float', state, 16);
  const out = (format: GPUTextureFormat, w: number, h: number) =>
    device.createTexture({ size: [w, h], format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  const V = N + 1;
  const vtx = out('rgba32float', V, V);
  const surf = out('rgba16float', N, N);
  const norm = out('rgba16float', N, N);
  const misc = out('rgba16float', N, N);
  const cells = out('rg32float', N, N);
  const vtxBed = out('r32float', V, V);
  const wet = out('r32float', N, N);

  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const pb = new ArrayBuffer(64);
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
      entries: [
        ...common,
        { binding: 4, resource: surf.createView() },
        { binding: 5, resource: norm.createView() },
        { binding: 6, resource: misc.createView() },
        { binding: 7, resource: cells.createView() },
        { binding: 8, resource: { buffer: noHazard(device) } },
        { binding: 9, resource: { buffer: noHazard(device) } },
        { binding: 10, resource: bedTex.createView() },
      ],
    }),
  );
  cp.dispatchWorkgroups(N / 16, N / 16);
  cp.setPipeline(P.prepVtxBed);
  cp.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepVtxBed.getBindGroupLayout(0),
      entries: [common[0], common[1], common[2], { binding: 4, resource: vtxBed.createView() }],
    }),
  );
  cp.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
  cp.setPipeline(P.prepVerts);
  cp.setBindGroup(
    0,
    device.createBindGroup({
      layout: P.prepVerts.getBindGroupLayout(0),
      entries: [
        common[0],
        { binding: 4, resource: vtx.createView() },
        { binding: 5, resource: wet.createView() },
        { binding: 6, resource: cells.createView() },
        { binding: 7, resource: vtxBed.createView() },
        { binding: 8, resource: bedTex.createView() },
      ],
    }),
  );
  cp.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
  cp.end();
  device.queue.submit([enc.finish()]);

  // The glitch sentinel (foam = 8, far above the 1.5 real foam ever reaches) marks exactly the blown cells.
  const s = await readTexture(device, surf, N, N);
  for (const [what, c] of blown) assert.equal(s[c * 4 + 3], 8, `${what}: expected the glitch sentinel in the foam channel`);
  const calm = 10 * N + 40;
  assert.ok(s[calm * 4 + 3] <= 1.5, `ordinary water must not be flagged (foam ${s[calm * 4 + 3]})`);

  // Nothing non-finite reaches the geometry: the vertex field stays drawable everywhere.
  const v = await readTexture(device, vtx, V, V);
  const bad = [...v].findIndex((x) => !Number.isFinite(x));
  assert.equal(bad, -1, `vertex texture holds a non-finite value at index ${bad}`);
  // The depth of a blown cell is replaced by a bounded spike (1–10 m), not by its Inf/NaN/5000 m state.
  const spike = await readTexture(device, cells, N, N);
  for (const [what, c] of blown) {
    const d = spike[c * 2];
    assert.ok(Number.isFinite(d) && d >= 1 && d <= 10, `${what}: displayed depth ${d} is not a bounded spike`);
  }

  assert.deepEqual(errors, []);
});

test('prep: arrival and hazard views map the solver hazard accumulators into misc.b / misc.a', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const { aidrHazardClass } = await import('../../src/render/legend');
  const device = await getDevice();
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  const P = await createPipelines(device, 'bgra8unorm');

  // Flat bed; every cell wet (h = 0.5, u = 0.3) with a max depth growing eastward. Accumulators: max speed growing
  // southward, max d·v = 0.8·d·v, arrival (i·60 + j) s, except a scatter of cells the water never reached.
  const bed = new Float32Array(N * N).fill(100);
  const state = new Float32Array(N * N * 4);
  const hz = new Float32Array(N * N * 4);
  const neverWet = (i: number, j: number) => (i + 3 * j) % 7 === 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const d = (i / N) * 5;
      const v = (j / N) * 5;
      state.set([0.5, 0.3, 0, d], c * 4);
      hz.set([v, 0.8 * d * v, neverWet(i, j) ? -1 : i * 60 + j, 10], c * 4);
    }
  }
  const tex = (format: GPUTextureFormat, data: Float32Array, bpp: number) => {
    const t = device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data as Float32Array<ArrayBuffer>, { bytesPerRow: N * bpp }, [N, N]);
    return t;
  };
  const bedTex = tex('r32float', bed, 4);
  const barrierTex = tex('r32float', new Float32Array(N * N), 4);
  const stateTex = tex('rgba32float', state, 16);
  const hazardBuf = device.createBuffer({ size: hz.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(hazardBuf, 0, hz);
  const out = (format: GPUTextureFormat) =>
    device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC });
  const surf = out('rgba16float');
  const norm = out('rgba16float');
  const misc = out('rgba16float');
  const cells = out('rg32float');
  const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

  // An ensemble of 10 members: cell c went over 0.15 m in (c mod 11) of them (capped at 10), over 0.5 m in half as many;
  // the envelope (w) is 2 m everywhere, so the probability view draws every cell at 2 m whatever the solver's max depth.
  const MEMBERS = 10;
  const ens = new Float32Array(N * N * 4);
  for (let c = 0; c < N * N; c++) {
    const k = Math.min(MEMBERS, c % 11);
    ens.set([k, Math.floor(k / 2), k * 0.3, 2], c * 4);
  }
  const ensBuf = device.createBuffer({ size: ens.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(ensBuf, 0, ens);

  const run = async (field: number, hasHazard: boolean, ensemble: { slot: 0 | 1 } | null = null) => {
    const pb = new ArrayBuffer(64);
    const pi = new Int32Array(pb);
    const pf = new Float32Array(pb);
    pi.set([N, N, N + 1, N + 1, 1, field === 0 ? 0 : 1]);
    pf[6] = 0.01;
    pf[7] = 8;
    pf[8] = 0.05;
    pi[10] = field;
    pi[11] = hasHazard ? 1 : 0;
    pf[12] = MEMBERS;
    pi[13] = ensemble?.slot ?? 0;
    pi[14] = ensemble ? 1 : 0;
    device.queue.writeBuffer(params, 0, pb);
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(P.prepCells);
    cp.setBindGroup(
      0,
      device.createBindGroup({
        layout: P.prepCells.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: bedTex.createView() },
          { binding: 2, resource: barrierTex.createView() },
          { binding: 3, resource: stateTex.createView() },
          { binding: 4, resource: surf.createView() },
          { binding: 5, resource: norm.createView() },
          { binding: 6, resource: misc.createView() },
          { binding: 7, resource: cells.createView() },
          { binding: 8, resource: { buffer: hasHazard ? hazardBuf : noHazard(device) } },
          { binding: 9, resource: { buffer: ensemble ? ensBuf : noHazard(device) } },
          { binding: 10, resource: bedTex.createView() },
        ],
      }),
    );
    cp.dispatchWorkgroups(N / 16, N / 16);
    cp.end();
    device.queue.submit([enc.finish()]);
    return readTexture(device, misc, N, N);
  };

  // Arrival: minutes premultiplied by coverage (b), coverage (a); nothing where the water never arrived.
  const arr = await run(1, true);
  const classes = new Set<number>();
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const [b, a] = [arr[c * 4 + 2], arr[c * 4 + 3]];
      if (neverWet(i, j)) {
        assert.deepEqual([b, a], [0, 0], `never-wet cell (${i}, ${j})`);
      } else {
        assert.equal(a, 1);
        const want = (i * 60 + j) / 60;
        assert.ok(Math.abs(b - want) <= 2e-3 * want + 1e-3, `arrival (${i}, ${j}): ${b} min, want ${want}`);
      }
    }
  }
  // Hazard class: AIDR from (max depth, max speed, max d·v), exactly the CPU classifier's answer, full coverage.
  const cls = await run(2, true);
  for (let c = 0; c < N * N; c++) {
    const want = aidrHazardClass(state[c * 4 + 3], hz[c * 4], hz[c * 4 + 1]);
    // Cells sitting on a threshold may land either side of it in Float32: only compare cells clear of every limit.
    const d = state[c * 4 + 3];
    const v = hz[c * 4];
    const dv = hz[c * 4 + 1];
    const onEdge = [0.3, 0.5, 1.2, 2, 4].some((t) => Math.abs(d - t) < 1e-4) || [2, 4].some((t) => Math.abs(v - t) < 1e-4) || [0.3, 0.6, 1, 4].some((t) => Math.abs(dv - t) < 1e-4);
    if (!onEdge) assert.equal(cls[c * 4 + 2], want, `cell ${c}: class ${cls[c * 4 + 2]}, want ${want}`);
    assert.equal(cls[c * 4 + 3], 1);
    classes.add(cls[c * 4 + 2]);
  }
  assert.deepEqual([...classes].sort(), [1, 2, 3, 4, 5, 6], 'the scene spans every class');
  // Without the solver's accumulators the arrival view shows nothing, and the default view still carries speed.
  const none = await run(1, false);
  assert.ok(none.every((x, k) => k % 4 < 2 || x === 0), 'arrival without a hazard buffer');
  const plain = await run(0, true);
  assert.ok(Math.abs(plain[2] - 0.3) < 1e-3, `speed ${plain[2]}`);
  // Ensemble probability (field 3): % of members over the threshold in misc.b, full coverage, drawn on the envelope
  // (misc.g = 2 m, not the solver's own max depth).
  for (const slot of [0, 1] as const) {
    const pr = await run(3, true, { slot });
    for (let c = 0; c < N * N; c++) {
      const k = Math.min(MEMBERS, c % 11);
      const want = (100 * (slot === 0 ? k : Math.floor(k / 2))) / MEMBERS;
      assert.ok(Math.abs(pr[c * 4 + 2] - want) < 0.05, `slot ${slot} cell ${c}: ${pr[c * 4 + 2]} %, want ${want}`);
      assert.equal(pr[c * 4 + 3], 1);
      assert.equal(pr[c * 4 + 1], 2, 'drawn on the ensemble envelope');
    }
  }
  // Without an ensemble nothing is coloured, and the surface stays the solver's own max depth.
  const noEns = await run(3, true, null);
  for (let c = 0; c < N * N; c++) {
    assert.equal(noEns[c * 4 + 3], 0);
    assert.ok(Math.abs(noEns[c * 4 + 1] - state[c * 4 + 3]) < 2e-3 * Math.max(1, state[c * 4 + 3]));
  }
  assert.deepEqual(errors, []);
});

test('prep: a footprint the solver blocks (buildings as obstacles) shows no roof film, an overtopped one its water at roof level, the street around it all of it', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const device = await getDevice();
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  const P = await createPipelines(device, 'bgra8unorm');
  // Flat street at 100 m under 0.4 m of water; a 4×4-cell building at (20…23, 20…23) holding a 3 cm roof film, and a
  // 2×2-cell shed at (40…41, 40…41) the flood has overtopped (0.6 m over its roof).
  const bed = new Float32Array(N * N).fill(100);
  const obstacle = new Float32Array(N * N);
  const state = new Float32Array(N * N * 4);
  for (let c = 0; c < N * N; c++) {
    const i = c % N;
    const j = Math.floor(c / N);
    const inside = i >= 20 && i < 24 && j >= 20 && j < 24;
    const shed = i >= 40 && i < 42 && j >= 40 && j < 42;
    if (inside) obstacle[c] = 12;
    if (shed) obstacle[c] = 3;
    state[c * 4] = inside ? 0.03 : shed ? 0.6 : 0.4;
    state[c * 4 + 3] = inside ? 0.03 : shed ? 0.7 : 0.5;
  }
  const tex = (format: GPUTextureFormat, data: Float32Array, bpp: number) => {
    const t = device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: t }, data as Float32Array<ArrayBuffer>, { bytesPerRow: N * bpp }, [N, N]);
    return t;
  };
  const bedTex = tex('r32float', bed, 4);
  const obstTex = tex('r32float', obstacle, 4);
  const stateTex = tex('rgba32float', state, 16);
  const out = (format: GPUTextureFormat) =>
    device.createTexture({ size: [N, N], format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
  const run = async (hasObst: number) => {
    const params = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pb = new ArrayBuffer(64);
    const pi = new Int32Array(pb);
    const pf = new Float32Array(pb);
    pi[0] = N;
    pi[1] = N;
    pi[2] = N + 1;
    pi[3] = N + 1;
    pi[4] = 1;
    pf[6] = 0.01;
    pf[7] = 8;
    pf[8] = 0.05;
    pi[15] = hasObst;
    device.queue.writeBuffer(params, 0, pb);
    const cells = out('rg32float');
    const surf = out('rgba16float');
    const misc = out('rgba16float');
    const V = N + 1;
    const vtxOf = (format: GPUTextureFormat) => device.createTexture({ size: [V, V], format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const vtxBed = vtxOf('r32float');
    const vtx = vtxOf('rgba32float');
    const wet = vtxOf('r32float');
    const zero = tex('r32float', new Float32Array(N * N), 4);
    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(P.prepCells);
    cp.setBindGroup(
      0,
      device.createBindGroup({
        layout: P.prepCells.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 1, resource: bedTex.createView() },
          { binding: 2, resource: zero.createView() },
          { binding: 3, resource: stateTex.createView() },
          { binding: 4, resource: surf.createView() },
          { binding: 5, resource: out('rgba16float').createView() },
          { binding: 6, resource: misc.createView() },
          { binding: 7, resource: cells.createView() },
          { binding: 8, resource: { buffer: noHazard(device) } },
          { binding: 9, resource: { buffer: noHazard(device) } },
          { binding: 10, resource: (hasObst ? obstTex : bedTex).createView() },
        ],
      }),
    );
    cp.dispatchWorkgroups(N / 16, N / 16);
    cp.setPipeline(P.prepVtxBed);
    cp.setBindGroup(
      0,
      device.createBindGroup({
        layout: P.prepVtxBed.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: bedTex.createView() }, { binding: 2, resource: zero.createView() }, { binding: 4, resource: vtxBed.createView() }],
      }),
    );
    cp.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
    cp.setPipeline(P.prepVerts);
    cp.setBindGroup(
      0,
      device.createBindGroup({
        layout: P.prepVerts.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: params } },
          { binding: 4, resource: vtx.createView() },
          { binding: 5, resource: wet.createView() },
          { binding: 6, resource: cells.createView() },
          { binding: 7, resource: vtxBed.createView() },
          { binding: 8, resource: (hasObst ? obstTex : bedTex).createView() },
        ],
      }),
    );
    cp.dispatchWorkgroups(Math.ceil(V / 16), Math.ceil(V / 16));
    cp.end();
    device.queue.submit([enc.finish()]);
    const c2 = await readTexture(device, surf, N, N);
    const m4 = await readTexture(device, misc, N, N);
    const ce = await readTexture(device, cells, N, N);
    const vt = await readTexture(device, vtx, V, V);
    return {
      depth: (i: number, j: number) => c2[(j * N + i) * 4],
      maxDepth: (i: number, j: number) => m4[(j * N + i) * 4 + 1],
      eta: (i: number, j: number) => ce[(j * N + i) * 2 + 1],
      vsurf: (k: number, l: number) => vt[(l * V + k) * 4 + 1],
    };
  };
  const off = await run(0);
  const on = await run(1);
  assert.ok(Math.abs(off.depth(21, 21) - 0.03) < 1e-4, `without obstacles the footprint shows its film: ${off.depth(21, 21)}`);
  assert.equal(on.depth(21, 21), 0, 'a blocked footprint shows no water');
  assert.equal(on.maxDepth(21, 21), 0, 'nor any max depth');
  assert.ok(Math.abs(on.depth(40, 40) - 0.6) < 1e-3, 'an overtopped roof shows the water over it');
  assert.ok(Math.abs(on.maxDepth(40, 40) - 0.7) < 2e-3);
  // The water over an overtopped roof stands on the roof (the solver's bed is ground + obstacle), not at street
  // level: a hole in the water sheet otherwise.
  assert.ok(Math.abs(on.eta(40, 40) - 103.6) < 1e-3, `surface over the overtopped shed: ${on.eta(40, 40)} (want 103.6)`);
  assert.ok(Math.abs(on.vsurf(41, 41) - 103.6) < 1e-3, `vertex over the shed: ${on.vsurf(41, 41)} (want 103.6)`);
  assert.ok(Math.abs(on.eta(19, 21) - 100.4) < 1e-3, 'the street surface is unchanged');
  assert.ok(Math.abs(off.eta(40, 40) - 100.6) < 1e-3, 'without obstacles the bed is the ground');
  assert.ok(Math.abs(on.depth(19, 21) - 0.4) < 1e-3, 'the street against the wall keeps its water');
  assert.ok(Math.abs(on.maxDepth(19, 21) - 0.5) < 2e-3);
  assert.deepEqual(errors, []);
});
