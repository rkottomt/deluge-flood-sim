/**
 * Compiles every renderer shader and builds every pipeline on a real GPU (Dawn), failing on any WGSL
 * or validation error.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { create, globals } from 'webgpu';
import { createDelugeDevice } from '../../src/gpu';

Object.assign(globalThis, globals);

after(() => {
  setTimeout(() => process.exit(process.exitCode ?? 0), 200);
});

test('all renderer pipelines compile and validate', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const gpu = create([]) as unknown as GPU;
  const { device } = await createDelugeDevice(gpu);
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  device.pushErrorScope('validation');
  const p = await createPipelines(device, 'bgra8unorm');
  const err = await device.popErrorScope();
  assert.equal(err?.message ?? null, null);
  assert.ok(p.terrain && p.water && p.ribbons && p.markersBlend && p.prepCells && p.prepVerts && p.tonemap);
  assert.deepEqual(errors, []);
});
