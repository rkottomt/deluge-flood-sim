/** Adaptive quality controller: steps down under sustained slow frames, up cautiously, and settles. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveQuality, AUTO_LADDER, QUALITY_PRESETS, STARVED_MAX_LEVEL, targetSize } from '../../src/render/quality';

/** Drive the controller with a frame-time function of the current level for `seconds`. */
function run(q: AdaptiveQuality, seconds: number, frameMs: (level: number) => number, start = 0, gpuMs = 3): number {
  let t = start;
  const end = start + seconds * 1000;
  while (t < end) {
    const dt = frameMs(q.level);
    t += dt;
    q.sample(dt, t, gpuMs);
  }
  return t;
}

test('steps down within a second of sustained slow frames and stops when fast enough', () => {
  const q = new AdaptiveQuality();
  const start = q.level;
  // 30 fps at levels < 3, 60 fps from level 3.
  const t = run(q, 1.2, (l) => (l < 3 ? 33 : 16.7));
  assert.ok(q.level > start, 'should have stepped down');
  run(q, 10, (l) => (l < 3 ? 33 : 16.7), t);
  assert.equal(q.level, 3);
});

test('steps back up when there is headroom, but not when the renderer GPU time is high', () => {
  const q = new AdaptiveQuality();
  q.level = 4;
  run(q, 6, () => 16.7, 0, 9);
  assert.equal(q.level, 4, 'busy GPU blocks up-steps');
  run(q, 60, () => 16.7, 10_000, 3);
  assert.equal(q.level, 0, 'fast frames with a cheap renderer reach the best level');
});

test('does not oscillate: the hold after an undone up-step grows', () => {
  const q = new AdaptiveQuality();
  // Level 1 is too slow, level 2 is fine.
  let t = 0;
  let changes = 0;
  let slowTime = 0;
  let last = q.level;
  const end = 180_000;
  while (t < end) {
    const dt = q.level <= 1 ? 26 : 16.7;
    t += dt;
    if (q.level <= 1) slowTime += dt;
    q.sample(dt, t, 3);
    if (q.level !== last) {
      changes++;
      last = q.level;
    }
  }
  assert.ok(slowTime / end < 0.1, `spent ${((100 * slowTime) / end).toFixed(1)} % of the time at a too-slow level`);
  assert.ok(changes <= 14, `too many level changes: ${changes}`);
});

test('ladder is ordered from best to cheapest and presets are sane', () => {
  for (let i = 1; i < AUTO_LADDER.length; i++) {
    const a = AUTO_LADDER[i - 1];
    const b = AUTO_LADDER[i];
    assert.ok(b.maxDpr * b.maxDpr * b.maxPixels <= a.maxDpr * a.maxDpr * a.maxPixels);
    assert.ok(b.lodQuadPixels >= a.lodQuadPixels);
    assert.ok(b.prepInterval >= a.prepInterval);
  }
  for (const p of Object.values(QUALITY_PRESETS)) assert.ok(p.maxDpr <= 2 && p.maxPixels > 0);
  // DPR is capped at 2 and the pixel budget keeps the aspect ratio.
  const [w, h] = targetSize(1440, 900, 3, 2, 2560 * 1600, 8192);
  assert.ok(w * h <= 2560 * 1600 && Math.abs(w / h - 1.6) < 0.01);
  assert.deepEqual(targetSize(800, 600, 1, 2, 4e6, 8192), [800, 600]);
});

test('sim pressure: a GPU-limited sim holds the level; a starved one steps down slowly, not below 1 px per CSS px', () => {
  const q = new AdaptiveQuality();
  const start = q.level;
  q.simPressure = 1;
  let t = run(q, 30, () => 16.7, 0, 3);
  assert.equal(q.level, start, 'fast frames must not raise quality beyond the default while the sim is GPU-limited');
  q.simPressure = 2;
  t = run(q, 2, () => 16.7, t, 3);
  assert.equal(q.level, start, 'no step before the starvation has lasted a few seconds');
  t = run(q, 60, () => 16.7, t, 3);
  assert.equal(q.level, STARVED_MAX_LEVEL, `starvation steps down to level ${STARVED_MAX_LEVEL} and no further`);
  // Still GPU-limited but no longer starved (the throttling passed): back to the default level after a while, no higher.
  q.simPressure = 1;
  t = run(q, 10, () => 16.7, t, 3);
  assert.equal(q.level, STARVED_MAX_LEVEL, 'no recovery right after starving');
  t = run(q, 90, () => 16.7, t, 3);
  assert.equal(q.level, start, 'recovers to the default level');
  q.simPressure = 0;
  t = run(q, 60, () => 16.7, t, 3);
  assert.ok(q.level < start, 'and beyond it once the sim keeps up');
  // The flood starts again: the level claimed while the sim kept up is handed back.
  q.simPressure = 1;
  run(q, 5, () => 16.7, t, 3);
  assert.equal(q.level, start, 'a GPU-limited sim takes back the better-than-default level');
});
