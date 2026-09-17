/**
 * Compiles every renderer shader and builds every pipeline on a real GPU (Dawn), failing on any WGSL
 * or validation error.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { finishGpuTests, getDevice } from '../helpers/gpu';

// Lets queued GPU work finish; the process then exits on its own with the right exit code. The helper keeps the Dawn
// instance referenced for the life of the process.
after(finishGpuTests);

test('all renderer pipelines compile and validate', async () => {
  const { createPipelines } = await import('../../src/render/pipelines');
  const device = await getDevice();
  const errors: string[] = [];
  device.onuncapturederror = (e) => errors.push(e.error.message);
  device.pushErrorScope('validation');
  const p = await createPipelines(device, 'bgra8unorm');
  const err = await device.popErrorScope();
  assert.equal(err?.message ?? null, null);
  assert.ok(p.terrain && p.water && p.ribbons && p.markersBlend && p.prepCells && p.prepVerts && p.tonemap);
  assert.deepEqual(errors, []);
});
