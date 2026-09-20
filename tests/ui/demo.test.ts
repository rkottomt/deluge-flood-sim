import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StageControl } from '../../src/contracts';
import { suggestedWallHeight, wallPreviewText, wallVerdict, checkWall, WALL_MAX, type WallStatus } from '../../src/ui/wallCheck';
import { formatStage, hasGauge, raiseStepText, stageSub, weatherBadge } from '../../src/ui/stageText';
import { RainGauge, speedShortfall } from '../../src/ui/stats';
import { nextViewMode, VIEW_CYCLE } from '../../src/ui/keyboard';
import { closeUpPose, dramaticStage } from '../../src/ui/welcome';

const PGH: StageControl = {
  label: 'Point',
  gaugeDatum: 211.409,
  normalLevel: 216.3,
  floodStageFt: 22,
  marks: [
    { label: '2004 Ivan', ft: 31 },
    { label: '1936 record', ft: 46 },
  ],
  maxOffset: 12,
};
/** Live areas: the detected surface is both datum and normal level, no flood stage, no marks. */
const LIVE: StageControl = { label: 'Water level (detected surface 1.5 m)', gaugeDatum: 1.5, normalLevel: 1.5, maxOffset: 10 };

test('wall verdict describes the walls already built; the cursor check is worded as a preview', () => {
  assert.equal(wallVerdict(null, 2), null);
  const base: WallStatus = { cells: 200, overtopped: 0, belowLevel: 0, neededHeight: 0, settled: true, stageFt: 46 };
  assert.equal(wallVerdict(base, 2)!.state, 'ok');
  assert.equal(wallVerdict({ ...base, settled: false }, 2)!.state, 'wait');
  // Overtopped (after settling) wins over the stage comparison, with a fix when a taller wall helps.
  const over = wallVerdict({ ...base, overtopped: 34, belowLevel: 38, neededHeight: 3.3 }, 2)!;
  assert.equal(over.state, 'low');
  assert.match(over.text, /overtopped: about 17%/);
  assert.equal(over.fix, 3.5);
  // Water on a brand-new wall doesn't count, but a wall below the river does.
  const low = wallVerdict({ ...base, settled: false, overtopped: 0, belowLevel: 38, neededHeight: 3.3 }, 2)!;
  assert.equal(low.state, 'low');
  assert.match(low.text, /19% of it is below the river at 46 ft/);
  // No fix suggested when the chosen height is already enough, and never above the tool's maximum.
  assert.equal(suggestedWallHeight({ belowLevel: 38, neededHeight: 3.3 }, 4), null);
  assert.equal(suggestedWallHeight({ belowLevel: 38, neededHeight: 14 }, 2), WALL_MAX);
  assert.equal(suggestedWallHeight({ belowLevel: 0, neededHeight: 0 }, 2), null);

  const hold = checkWall({ ground: 232.3, barrier: 0, depth: 0, wallHeight: 2, stageLevel: 225.4 })!;
  assert.equal(wallPreviewText(hold, 2, 225.4), 'A 2.0 m wall here would stand 8.9 m above the river (225.4 m)');
  const under = checkWall({ ground: 221.8, barrier: 0, depth: 0, wallHeight: 2, stageLevel: 225.4 })!;
  assert.match(wallPreviewText(under, 2, 225.4), /^A 2\.0 m wall here would be 1\.6 m under the river/);
  assert.match(wallPreviewText(null, 2, 225.4), /hover the map/);
});

test('stage wording: gauge feet for presets, a rise above the detected surface for live areas', () => {
  assert.equal(hasGauge(PGH), true);
  assert.equal(hasGauge(LIVE), false);
  const pgh = raiseStepText(PGH, dramaticStage(PGH));
  assert.equal(pgh.label, 'Raise to 1936 record');
  assert.match(pgh.tip, /46\.0 ft at the gauge/);
  assert.doesNotMatch(pgh.tip, /300×/);
  // Without a gauge the raise step aims for a moderate +3 m (the top of the range drowns most of a flat city).
  const live = raiseStepText(LIVE, dramaticStage(LIVE));
  assert.equal(live.label, 'Raise water +3 m');
  assert.doesNotMatch(live.tip, /crest|gauge/);
  assert.match(live.tip, /10 ft/);
  const topFt = LIVE.maxOffset / 0.3048;
  assert.equal(formatStage(LIVE, topFt), '+10\u00a0m');
  assert.equal(formatStage(LIVE, 0), '+0\u00a0m');
  assert.equal(stageSub(LIVE, topFt), '33\u00a0ft');
  assert.equal(stageSub(PGH, 46), '');
  assert.match(formatStage(PGH, 46), /^46\.0\sft$/);
});

test('weather badge: a raised river is not "Dry"', () => {
  const offset1936 = 46 * 0.3048 + PGH.gaugeDatum - PGH.normalLevel;
  assert.deepEqual(weatherBadge({ rainRate: 0, stormPeak: 0, stage: PGH, stageOffsetApplied: 0 }), { text: 'Dry', severity: 'calm' });
  assert.deepEqual(weatherBadge({ rainRate: 0, stormPeak: 0, stage: PGH, stageOffsetApplied: offset1936 }), { text: 'River 46\u00a0ft', severity: 'danger' });
  const both = weatherBadge({ rainRate: 100, stormPeak: 0, stage: PGH, stageOffsetApplied: 2 });
  assert.match(both.text, /^River 23\sft \+ rain$/);
  assert.equal(both.severity, 'danger');
  assert.match(weatherBadge({ rainRate: 5, stormPeak: 60, stage: null, stageOffsetApplied: 0 }).text, /^Storm 60/);
  assert.equal(weatherBadge({ rainRate: 0, stormPeak: 0, stage: LIVE, stageOffsetApplied: 3 }).text, 'Water +3.0\u00a0m');
  assert.equal(weatherBadge({ rainRate: 0, stormPeak: 0, stage: LIVE, stageOffsetApplied: 3 }).severity, 'info');
});

test('fast-forward beyond the GPU is shown as its maximum; only a real shortfall warns', () => {
  assert.equal(speedShortfall(false, 40, 300), 'none');
  assert.equal(speedShortfall(true, null, 300), 'none');
  assert.equal(speedShortfall(true, 290, 300), 'none');
  assert.equal(speedShortfall(true, 70, 300), 'max');
  assert.equal(speedShortfall(true, 45, 1200), 'max');
  assert.equal(speedShortfall(true, 14, 300), 'short');
  assert.equal(speedShortfall(true, 45, 60), 'max');
  assert.equal(speedShortfall(true, 12, 60), 'short');
  assert.equal(speedShortfall(true, 2, 10), 'short');
});

test('rain gauge integrates rain over simulated time and restarts with the water', () => {
  const g = new RainGauge();
  g.push(0, 100);
  g.push(1800, 100);
  assert.ok(Math.abs(g.mm - 50) < 1e-9);
  g.push(3600, 0); // rain turned off: the interval is counted at the rate now in effect
  assert.ok(Math.abs(g.mm - 50) < 1e-9);
  g.push(10, 100); // water reset
  assert.equal(g.mm, 0);
  g.push(Number.NaN, 100);
  g.push(46, 100);
  assert.ok(Math.abs(g.mm - 1) < 1e-9);
});

test('V cycles the water views both ways; Play the flood zooms in on the scenario framing', () => {
  let m = VIEW_CYCLE[0];
  const seen = [m];
  for (let k = 0; k < VIEW_CYCLE.length; k++) seen.push((m = nextViewMode(m)));
  assert.deepEqual(seen, ['realistic', 'depth', 'maxDepth', 'velocity', 'realistic']);
  assert.equal(nextViewMode('realistic', true), 'velocity');
  const pose = { target: { gx: 573.8, gy: 550.8, elevation: 75.9 }, distance: 1900, yaw: 1.571, pitch: 0.5 };
  const close = closeUpPose(pose);
  assert.equal(close.distance, 1500, 'not below the close-up floor');
  assert.equal(closeUpPose({ ...pose, distance: 4000 }).distance, 2000, 'a wide framing halves');
  assert.equal(closeUpPose({ ...pose, distance: 1100 }).distance, 1100, 'a framing that is already close stays (under a storm cloud deck the view greys out)');
  assert.deepEqual(close.target, pose.target);
  assert.notEqual(close.target, pose.target, 'a copy, not the scenario object');
  assert.ok(close.pitch > pose.pitch && close.pitch <= 1.2);
});
