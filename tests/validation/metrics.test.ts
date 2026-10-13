/**
 * The validation metrics (src/validation/metrics.ts) on inputs whose answers can be worked out by hand: a wrong CSI or
 * a bias with the sign flipped would make every number in docs/VALIDATION.md wrong without any run showing it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectedTo,
  contingency,
  dilate,
  extentScores,
  labelComponents,
  percentile,
  pointScores,
  scoreContingency,
} from '../../src/validation/metrics';

const close = (a: number | null, b: number, eps = 1e-12) => {
  assert.ok(a !== null, `expected ${b}, got null`);
  assert.ok(Math.abs((a as number) - b) <= eps, `expected ${b}, got ${a}`);
};

test('contingency counts hits, misses, false alarms and correct negatives cell by cell', () => {
  const model = [1, 1, 0, 0, 1, 0];
  const obs = [1, 0, 1, 0, 1, 1];
  assert.deepEqual(contingency(model, obs, null), { hits: 2, misses: 2, falseAlarms: 1, correctNegatives: 1 });
});

test('contingency honours the comparison mask', () => {
  const model = [1, 1, 0, 0];
  const obs = [1, 0, 1, 0];
  // Leave out the false alarm and the miss.
  assert.deepEqual(contingency(model, obs, [1, 0, 0, 1]), { hits: 1, misses: 0, falseAlarms: 0, correctNegatives: 1 });
});

test('contingency rejects maps of different sizes', () => {
  assert.throws(() => contingency([1, 0], [1], null), /length mismatch/);
  assert.throws(() => contingency([1, 0], [1, 0], [1]), /length mismatch/);
});

test('CSI = hits / (hits + misses + false alarms); hit rate, false-alarm ratio and frequency bias', () => {
  const s = scoreContingency({ hits: 60, misses: 20, falseAlarms: 20, correctNegatives: 900 });
  close(s.csi, 0.6);
  close(s.hitRate, 0.75);
  close(s.falseAlarmRatio, 0.25);
  close(s.frequencyBias, 1);
  assert.equal(s.cells, 1000);
});

test('CSI ignores correct negatives (a mostly-dry domain cannot inflate it)', () => {
  const a = scoreContingency({ hits: 10, misses: 5, falseAlarms: 5, correctNegatives: 0 });
  const b = scoreContingency({ hits: 10, misses: 5, falseAlarms: 5, correctNegatives: 1e6 });
  assert.equal(a.csi, b.csi);
  close(a.csi, 0.5);
});

test('scores are null, not 0 or NaN, when nothing is wet in either map', () => {
  const s = extentScores([0, 0, 0], [0, 0, 0], null);
  assert.equal(s.csi, null);
  assert.equal(s.hitRate, null);
  assert.equal(s.falseAlarmRatio, null);
  assert.equal(s.frequencyBias, null);
});

test('a perfect map scores CSI 1, a disjoint one CSI 0', () => {
  close(extentScores([1, 1, 0], [1, 1, 0], null).csi, 1);
  close(extentScores([1, 0, 0], [0, 1, 0], null).csi, 0);
  const over = extentScores([1, 1, 1, 1], [1, 1, 0, 0], null);
  close(over.frequencyBias, 2);
  close(over.hitRate, 1);
  close(over.falseAlarmRatio, 0.5);
});

test('pointScores: bias, RMSE, MAE, median and the ±0.3 m / ±1 m shares', () => {
  const s = pointScores([0.1, -0.2, 0.3, -1.5, 0.5]);
  assert.equal(s.n, 5);
  close(s.bias, (0.1 - 0.2 + 0.3 - 1.5 + 0.5) / 5, 1e-12);
  close(s.rmse, Math.sqrt((0.01 + 0.04 + 0.09 + 2.25 + 0.25) / 5), 1e-12);
  close(s.mae, (0.1 + 0.2 + 0.3 + 1.5 + 0.5) / 5, 1e-12);
  close(s.median, 0.1);
  close(s.within03, 3 / 5); // 0.3 exactly counts as within
  close(s.within1, 4 / 5);
  close(s.maxAbs, 1.5);
});

test('pointScores: positive bias means the model is too high; non-finite residuals are skipped', () => {
  const s = pointScores([1, 1, NaN, Infinity]);
  assert.equal(s.n, 2);
  close(s.bias, 1);
  assert.equal(pointScores([]).bias, null);
});

test('percentile interpolates linearly and clamps p', () => {
  close(percentile([3, 1, 2, 4], 0.5), 2.5);
  close(percentile([10, 20], 0.25), 12.5);
  close(percentile([5, 1], -1), 1);
  close(percentile([5, 1], 2), 5);
  assert.equal(percentile([], 0.5), null);
});

test('labelComponents finds 4-connected regions (diagonals do not join)', () => {
  // 1 1 0
  // 0 0 1
  // 1 0 1
  const { labels, count } = labelComponents([1, 1, 0, 0, 0, 1, 1, 0, 1], 3, 3);
  assert.equal(count, 3);
  assert.equal(labels[0], labels[1]);
  assert.equal(labels[5], labels[8]);
  assert.notEqual(labels[0], labels[5]);
  assert.notEqual(labels[6], labels[0]);
  assert.equal(labels[2], 0);
});

test('connectedTo keeps only the zones that touch the seed (through the seed itself)', () => {
  // zone: two blobs; seed: a river column touching only the left blob.
  // z z . . .        s . . . .
  // . . . z z   seed . . . . .
  const nx = 5;
  const zone = [1, 1, 0, 0, 0, 0, 0, 0, 1, 1];
  const seed = [0, 0, 0, 0, 0, 1, 0, 0, 0, 0];
  // The seed at (0,1) touches zone cell (0,0).
  assert.deepEqual([...connectedTo(zone, seed, nx, 2)], [1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
  // A zone joined to the seed only via another seed cell still counts.
  const seed2 = [0, 0, 0, 0, 0, 1, 1, 1, 1, 0];
  assert.deepEqual([...connectedTo(zone, seed2, nx, 2)], [1, 1, 0, 0, 0, 0, 0, 0, 1, 1]);
});

test('dilate grows a mask by r cells in each direction (square element)', () => {
  const m = new Uint8Array(25);
  m[12] = 1;
  const d = dilate(m, 5, 5, 1);
  assert.equal(d.reduce((s, v) => s + v, 0), 9);
  assert.equal(dilate(m, 5, 5, 0).reduce((s, v) => s + v, 0), 1);
  assert.equal(dilate(m, 5, 5, 5).reduce((s, v) => s + v, 0), 25);
});
