import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StepAverager } from '../../src/app/driver';

test('HUD substeps: a recent average, so a skipped frame at 300× does not read "0 sub"', () => {
  const avg = new StepAverager(10);
  assert.equal(avg.value(), null);
  // 9 frames of 4 substeps and one frame skipped while the GPU queue drained.
  for (let k = 0; k < 9; k++) avg.push({ substeps: 4, simSecondsAdvanced: 4 * 1.2, dt: 1.2, throttled: true });
  avg.push({ substeps: 0, simSecondsAdvanced: 0, dt: 1.1, throttled: true });
  const v = avg.value()!;
  assert.ok(Math.abs(v.substeps - 3.6) < 1e-9, `substeps ${v.substeps}`);
  assert.ok(Math.abs(v.simSecondsAdvanced - 4.32) < 1e-9);
  assert.equal(v.dt, 1.1, 'latest dt');
  assert.equal(v.throttled, true);
  // The window slides: after 10 more unthrottled frames of 2 substeps only those count.
  for (let k = 0; k < 10; k++) avg.push({ substeps: 2, simSecondsAdvanced: 2, dt: 1, throttled: false });
  assert.equal(avg.value()!.substeps, 2);
  assert.equal(avg.value()!.throttled, false);
  avg.reset();
  assert.equal(avg.value(), null);
});
