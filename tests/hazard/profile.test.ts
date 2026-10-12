/**
 * The bake's profile operations (scripts/chain-profile.ts): a smooth monotone thalweg instead of the isotonic
 * staircase, and a minimum channel floor instead of DEM slots. The baked chain.json files are checked for the same
 * properties in tests/data/presets.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLOOR_DEPTH, flatFaces, isotonicNonIncreasing, MIN_FLOOR_WIDTH, monotoneSmooth, withFloor } from '../../scripts/chain-profile';
import type { ChainSection } from '../../src/hazard/types';

/** A noisy falling bed: 2 % slope, ±8 m of deterministic DSM-like noise with occasional 30 m sills. */
function noisyBed(n = 400, dx = 100): { s: number[]; z: number[]; w: number[] } {
  const s = Array.from({ length: n }, (_, i) => i * dx);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const z = s.map((x, i) => 2000 - 0.02 * x + 8 * rnd() + (i % 37 === 0 ? 30 : 0));
  return { s, z, w: s.map(() => dx) };
}

test('isotonic fit alone is a staircase; the smoothed fit is monotone with no flat face', () => {
  const { s, z, w } = noisyBed();
  const stair = isotonicNonIncreasing(z, w);
  const smooth = monotoneSmooth(s, z, w);
  assert.ok(flatFaces(stair) > 50, `the plain fit has ${flatFaces(stair)} flat faces`);
  assert.equal(flatFaces(smooth), 0);
  for (let i = 1; i < smooth.length; i++) assert.ok(smooth[i] <= smooth[i - 1], `rises at ${i}`);
  // It still follows the data: the mean slope survives and the residual is the noise, not a bias.
  const slope = (smooth[20] - smooth[smooth.length - 21]) / (s[s.length - 21] - s[20]);
  assert.ok(Math.abs(slope - 0.02) < 0.002, `mean slope ${slope}`);
  let ss = 0;
  for (let i = 0; i < z.length; i++) ss += (smooth[i] - z[i]) ** 2;
  assert.ok(Math.sqrt(ss / z.length) < 12, `RMS ${Math.sqrt(ss / z.length).toFixed(1)} m`);
  // The steepest step is a few metres per node, not the staircase's tens.
  let maxStair = 0;
  let maxSmooth = 0;
  for (let i = 1; i < z.length; i++) {
    maxStair = Math.max(maxStair, stair[i - 1] - stair[i]);
    maxSmooth = Math.max(maxSmooth, smooth[i - 1] - smooth[i]);
  }
  assert.ok(maxSmooth < maxStair / 2, `steepest smoothed drop ${maxSmooth.toFixed(1)} m vs the staircase's ${maxStair.toFixed(1)} m`);
});

test('the smoothed fit leaves an already monotone straight bed alone', () => {
  const s = Array.from({ length: 100 }, (_, i) => i * 100);
  const z = s.map((x) => 1000 - 0.05 * x);
  const out = monotoneSmooth(s, z, s.map(() => 100));
  for (let i = 3; i < 97; i++) assert.ok(Math.abs(out[i] - z[i]) < 1e-9, `node ${i}: ${out[i]} vs ${z[i]}`);
});

test('withFloor: a slot is widened to the floor width by a flat strip; a wide section is untouched', () => {
  // A V: width 2·h·3 (side slope 3:1), so 6 m at 1 m and a 3 m slot at 0.5 m.
  const stage = [0, 0.5, 1, 2, 5, 10].map((d) => 100 + d);
  const v: ChainSection = { stage, area: stage.map((z) => 3 * (z - 100) ** 2), width: stage.map((z) => 6 * (z - 100)), perimeter: stage.map((z) => 2 * (z - 100) * Math.sqrt(10)) };
  const { section, added } = withFloor(v, 100);
  assert.equal(added, MIN_FLOOR_WIDTH - 6 * FLOOR_DEPTH);
  for (let k = 1; k < stage.length; k++) {
    const d = stage[k] - 100;
    assert.ok(Math.abs(section.width[k] - (6 * d + added)) < 0.06, `width at ${d} m`);
    assert.ok(Math.abs(section.area[k] - (3 * d * d + added * d)) <= 0.5, `area at ${d} m`);
    assert.ok(Math.abs(section.perimeter[k] - (2 * d * Math.sqrt(10) + added)) < 0.06, `perimeter at ${d} m`);
  }
  assert.equal(section.area[0], 0, 'still dry at the bed');
  const wide: ChainSection = { stage, area: stage.map((z) => 40 * (z - 100)), width: stage.map(() => 40), perimeter: stage.map((z) => 40 + 2 * (z - 100)) };
  assert.equal(withFloor(wide, 100).added, 0);
  assert.equal(withFloor(wide, 100).section, wide);
});
