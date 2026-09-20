/**
 * The sun-shading raster (src/render/shadows.ts): does a ridge actually shadow the ground behind it, does a valley
 * see less sky than a ridge top, and does building the whole thing stay inside its load-time budget?
 *
 * The GPU cases build the raster over a synthetic terrain whose answer is known by hand, read it back and check
 * the numbers — the same property a screenshot shows, stated so that it can fail.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice } from '../helpers/gpu';
import {
  expandForShadow,
  shadowReachCells,
  SHADOW_BUILD_BUDGET_MS,
  SHADOW_QUALITY,
  SunShading,
  createShadowPipelines,
  type CellRect,
} from '../../src/render/shadows';

after(finishGpuTests);

// ── geometry of the incremental rebuild ─────────────────────────────────────────────────────────

test('an edit only invalidates the ground its shadow can land on', () => {
  const rect: CellRect = { x0: 100, y0: 100, x1: 110, y1: 110 };
  // Sun due east (+x): shadows fall toward −x, so the region grows to the left and not to the right.
  const out = expandForShadow(rect, [1, 0], 50, 4, 1024, 1024);
  assert.equal(out.x0, 100 - 50 - 4);
  assert.equal(out.x1, 110 + 4, 'nothing upsun of the edit changes');
  assert.equal(out.y0, 96);
  assert.equal(out.y1, 114);
  // …and the other way round when the sun moves.
  const west = expandForShadow(rect, [-1, 0], 50, 4, 1024, 1024);
  assert.equal(west.x1, 110 + 50 + 4);
  assert.equal(west.x0, 96);
  // Always inside the grid.
  const clamped = expandForShadow({ x0: 2, y0: 2, x1: 6, y1: 6 }, [1, 1], 400, 8, 64, 64);
  assert.ok(clamped.x0 >= 0 && clamped.y0 >= 0 && clamped.x1 <= 64 && clamped.y1 <= 64);
});

test('shadow reach grows as the sun drops and is capped', () => {
  // 40 m of relief, 8 m cells. A 45° sun throws it 40 m ≈ 5 cells; a 10° sun throws it ~227 m ≈ 28.
  const high = shadowReachCells(40, Math.sin(Math.PI / 4), Math.cos(Math.PI / 4), 8, 1000);
  const low = shadowReachCells(40, Math.sin(0.1745), Math.cos(0.1745), 8, 1000);
  assert.ok(high >= 6 && high <= 9, `45° reach ${high}`);
  assert.ok(low > high * 3, `10° reach ${low} should be much longer than ${high}`);
  assert.equal(shadowReachCells(40, 0.0001, 1, 8, 120), 120, 'capped');
  assert.equal(shadowReachCells(0, 0.5, 0.86, 8, 500), 2, 'nothing to cast, nothing to redo');
});

// ── the raster itself ───────────────────────────────────────────────────────────────────────────

/** r32float texture holding `data`, usable as the shading pass's bed or barrier input. */
function heightTexture(device: GPUDevice, nx: number, ny: number, data: Float32Array): GPUTexture {
  const t = device.createTexture({
    size: [nx, ny],
    format: 'r32float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: t }, data, { bytesPerRow: nx * 4 }, { width: nx, height: ny });
  return t;
}

/** Build the raster for a height field and return (sun, sky) per cell as 0…1 floats. */
async function rasterFor(
  nx: number,
  ny: number,
  cellSize: number,
  ground: Float32Array,
  sunDir: [number, number, number],
  quality = SHADOW_QUALITY.standard,
  barrierField?: Float32Array,
): Promise<{ sun: Float32Array; sky: Float32Array; ms: number }> {
  const device = await getDevice();
  const P = await createShadowPipelines(device, async (code, label) => device.createShaderModule({ code, label }));
  const shading = new SunShading(device, P, nx, ny, cellSize);
  const bed = heightTexture(device, nx, ny, ground);
  const barrier = heightTexture(device, nx, ny, barrierField ?? new Float32Array(nx * ny));

  const bytesPerRow = Math.ceil((nx * 4) / 256) * 256;
  const read = device.createBuffer({ size: bytesPerRow * ny, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

  const enc = device.createCommandEncoder();
  shading.build(enc, bed, barrier, { dir: sunDir }, quality);
  enc.copyTextureToBuffer({ texture: shading.texture }, { buffer: read, bytesPerRow }, { width: nx, height: ny });
  const t0 = performance.now();
  device.queue.submit([enc.finish()]);
  await device.queue.onSubmittedWorkDone();
  const ms = performance.now() - t0;

  await read.mapAsync(GPUMapMode.READ);
  const bytes = new Uint8Array(read.getMappedRange().slice(0));
  read.unmap();
  const sun = new Float32Array(nx * ny);
  const sky = new Float32Array(nx * ny);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const o = y * bytesPerRow + x * 4;
      sun[y * nx + x] = bytes[o] / 255;
      sky[y * nx + x] = bytes[o + 1] / 255;
    }
  }
  read.destroy();
  bed.destroy();
  barrier.destroy();
  shading.destroy();
  return { sun, sky, ms };
}

test('a ridge shadows the ground behind it and nothing in front of it', async () => {
  const n = 128;
  const cell = 10;
  // A 120 m wall of ground across the middle (columns 62…65), flat either side.
  const ground = new Float32Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 62; x <= 65; x++) ground[y * n + x] = 120;
  // Sun due east (+x) at 30°: the ridge is 120 m tall, so its shadow runs ~208 m ≈ 21 cells in the −x direction.
  const el = Math.PI / 6;
  const { sun } = await rasterFor(n, n, cell, ground, [Math.cos(el), Math.sin(el), 0]);
  const at = (x: number, y: number) => sun[y * n + x];

  assert.ok(at(55, 64) < 0.05, `5 cells downsun of the ridge should be dark, got ${at(55, 64)}`);
  assert.ok(at(48, 64) < 0.2, `14 cells downsun should still be shadowed, got ${at(48, 64)}`);
  assert.ok(at(38, 64) > 0.9, `past the shadow's end it is lit again, got ${at(38, 64)}`);
  assert.ok(at(72, 64) > 0.95, `upsun of the ridge is fully lit, got ${at(72, 64)}`);
  assert.ok(at(64, 64) > 0.95, `the ridge crest itself is lit, got ${at(64, 64)}`);

  // The edge is soft, not a step: somewhere along the shadow there is a partly-lit band (the penumbra).
  let soft = 0;
  for (let x = 40; x < 62; x++) if (at(x, 64) > 0.08 && at(x, 64) < 0.92) soft++;
  assert.ok(soft >= 2, `expected a penumbra of at least 2 cells, found ${soft}`);
});

test('flat ground is fully lit and sees the whole sky; a valley sees less of it', async () => {
  const n = 96;
  const flat = new Float32Array(n * n).fill(50);
  const el = Math.PI / 4;
  const { sun, sky } = await rasterFor(n, n, 10, flat, [Math.cos(el), Math.sin(el), 0]);
  // Interior only: cells within a march of the edge see the clamped border, which is the same height anyway.
  for (let y = 8; y < n - 8; y++) {
    for (let x = 8; x < n - 8; x++) {
      assert.ok(sun[y * n + x] > 0.97, `flat ground in shadow at ${x},${y}: ${sun[y * n + x]}`);
      assert.ok(sky[y * n + x] > 0.97, `flat ground occluded at ${x},${y}: ${sky[y * n + x]}`);
    }
  }

  // A 100 m-deep V running down the middle: its floor is walled in, the plateau beside it is not.
  const valley = new Float32Array(n * n).fill(100);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.abs(x - n / 2);
      if (d < 12) valley[y * n + x] = 100 - (12 - d) * 8;
    }
  }
  const dug = await rasterFor(n, n, 10, valley, [Math.cos(el), Math.sin(el), 0]);
  const floor = dug.sky[48 * n + 48];
  const plateau = dug.sky[48 * n + 80];
  assert.ok(plateau > 0.95, `open plateau should see the sky, got ${plateau}`);
  assert.ok(floor < 0.8, `valley floor should be occluded, got ${floor}`);
  assert.ok(floor < plateau - 0.15, 'the valley must be measurably darker than the ground above it');
});

test('a full 1024² build fits in the load-time budget', async () => {
  const n = 1024;
  // Rolling terrain with ~200 m of relief, like a real DEM: enough blockers that no ray exits early.
  const ground = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      ground[y * n + x] = 200 + 90 * Math.sin(x * 0.02) * Math.cos(y * 0.017) + 40 * Math.sin((x + y) * 0.06);
    }
  }
  // The worst case the app can ask for: the cinematic tier at a low sun, whose rays march furthest.
  const el = (9 * Math.PI) / 180;
  const { ms, sun } = await rasterFor(n, n, 7.8, ground, [Math.cos(el), Math.sin(el), 0], SHADOW_QUALITY.cinematic);
  console.log(`[shadows] full 1024² cinematic build: ${ms.toFixed(1)} ms`);
  assert.ok(ms < SHADOW_BUILD_BUDGET_MS, `full build took ${ms.toFixed(1)} ms, budget ${SHADOW_BUILD_BUDGET_MS} ms`);
  // Sanity: rolling terrain at a 9° sun is neither all lit nor all dark.
  let lit = 0;
  for (let i = 0; i < sun.length; i += 37) if (sun[i] > 0.5) lit++;
  const frac = lit / Math.ceil(sun.length / 37);
  assert.ok(frac > 0.15 && frac < 0.95, `expected a mix of light and shade, ${(frac * 100).toFixed(0)}% lit`);
});

test('a levee the user drew casts its own shadow, and only downsun of itself', async () => {
  const n = 96;
  const cell = 7.8;
  const flat = new Float32Array(n * n).fill(20);
  // A 9 m floodwall one cell wide across the middle — what the demo's one-click levee actually builds.
  const barrier = new Float32Array(n * n);
  for (let y = 0; y < n; y++) barrier[y * n + 48] = 9;
  // A 20° sun from +x: 9 m of wall throws ~25 m ≈ 3 cells of shadow toward −x.
  const el = (20 * Math.PI) / 180;
  const dir: [number, number, number] = [Math.cos(el), Math.sin(el), 0];
  const withWall = await rasterFor(n, n, cell, flat, dir, SHADOW_QUALITY.standard, barrier);
  const bare = await rasterFor(n, n, cell, flat, dir);
  const at = (r: { sun: Float32Array }, x: number, y: number) => r.sun[y * n + x];

  assert.ok(at(bare, 47, 48) > 0.97, 'without the wall that ground is lit');
  assert.ok(at(withWall, 47, 48) < 0.35, `the cell behind the wall is shadowed, got ${at(withWall, 47, 48)}`);
  assert.ok(at(withWall, 49, 48) > 0.95, `the sunward side stays lit, got ${at(withWall, 49, 48)}`);
  assert.ok(at(withWall, 40, 48) > 0.95, `the shadow ends where the geometry says it does, got ${at(withWall, 40, 48)}`);
  // Nothing anywhere upsun changed at all.
  for (let x = 50; x < n - 10; x++) {
    assert.ok(Math.abs(at(withWall, x, 48) - at(bare, x, 48)) < 0.02, `wall changed the light at x=${x}`);
  }
});
