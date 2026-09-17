/**
 * One-click demo levee, the Try-it status line and the storm fallback for areas with nothing to flood them.
 * Run: node --import tsx --test tests/ui/levee.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AppState, DemoLevee, StageControl } from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { leveeLength, planLevee, raiseAlong } from '../../src/ui/levee';
import { keptStatus } from '../../src/ui/wallCheck';
import { hasNoForcing, playStorm, PLAY_STORM_ID, riverStatus, stormLabel } from '../../src/ui/welcome';

const PGH: StageControl = {
  label: 'Point',
  gaugeDatum: 211.409,
  normalLevel: 216.3,
  floodStageFt: 22,
  marks: [{ label: '1936 record', ft: 46 }],
  maxOffset: 12,
};

test('planLevee: pieces follow the line and every piece reaches the crest over the lowest ground under it', () => {
  const nx = 64;
  const ny = 32;
  const ground = new Float32Array(nx * ny).fill(220);
  // A dip to 217 m around column 30 (a low spot the wall must still clear).
  for (let j = 0; j < ny; j++) for (let i = 28; i <= 32; i++) ground[j * nx + i] = 217;
  const levee: DemoLevee = { name: 'test', crest: 223, points: [{ gx: 4, gy: 16 }, { gx: 60, gy: 16 }] };
  const pieces = planLevee(levee, ground, nx, ny, 2);
  assert.ok(pieces.length >= 11, `${pieces.length} pieces`);
  assert.deepEqual([pieces[0].ax, pieces[0].ay], [4, 16]);
  assert.deepEqual([pieces.at(-1)!.bx, pieces.at(-1)!.by], [60, 16]);
  for (const p of pieces) {
    const mid = Math.floor((p.ax + p.bx) / 2);
    const nearDip = Math.max(p.ax, p.bx) >= 28 - 3 && Math.min(p.ax, p.bx) <= 32 + 3;
    assert.equal(p.height, nearDip ? 6 : 3, `piece at ${mid}`);
  }
  assert.equal(leveeLength(levee, 7.8125), 56 * 7.8125);
  // Wall heights stay in the tool's range.
  const deep = planLevee({ ...levee, crest: 240 }, ground, nx, ny, 2);
  assert.ok(deep.every((p) => p.height === 10));
});

test('raiseAlong without animation frames builds everything at once, and honours cancellation', async () => {
  const segs = [1, 2, 3].map((k) => ({ ax: k, ay: 0, bx: k + 1, by: 0, height: 2 }));
  const built: number[] = [];
  assert.equal(await raiseAlong(segs, (b) => built.push(b.length), 1, () => false), true);
  assert.deepEqual(built, [3]);
  assert.equal(await raiseAlong(segs, () => assert.fail('built while cancelled'), 1, () => true), false);
});

test('status line: the river on its way, and the land walls keep dry', () => {
  const s = { scenario: { stage: PGH } as AppState['scenario'], stageOffset: 9.13, stageOffsetApplied: 2, paused: false };
  const up = riverStatus(s)!;
  assert.equal(up.dir, 'up');
  assert.match(up.text, /^River rising 22\.6\sft → 46\.0\sft$/);
  assert.equal(riverStatus({ ...s, stageOffsetApplied: 9.13 }), null);
  assert.match(riverStatus({ ...s, stageOffset: 0, paused: true })!.text, /^River falling .* \(paused\)$/);
  assert.equal(riverStatus({ ...s, scenario: null }), null);

  assert.equal(keptStatus(null), null);
  assert.equal(keptStatus({ wallCells: 100, areaM2: 1000, roadMeters: 0, roadEdges: 0, level: 225 }), null, 'a ditch is not news');
  const kept = keptStatus({ wallCells: 1800, areaM2: 561_000, roadMeters: 10_900, roadEdges: 122, level: 225.7 })!;
  assert.equal(kept.text, 'Walls keep 139 acres dry · 11 km of streets');
  assert.match(kept.tip, /0\.56 km² .* 225\.7 m/);
  assert.equal(keptStatus({ wallCells: 50, areaM2: 20_000, roadMeters: 0, roadEdges: 0, level: null })!.text, 'Walls keep 4.9 acres dry');
});

test('Play the flood on an area with nothing to flood it drops a storm over the view', () => {
  const s = createInitialState();
  assert.equal(hasNoForcing(s), true);
  assert.equal(hasNoForcing({ ...s, sim: { ...s.sim, rainRate: 5 } }), false);
  assert.equal(hasNoForcing({ ...s, storms: [{ id: 'a', gx: 1, gy: 1, radius: 1, intensity: 1 }] }), false);
  assert.equal(hasNoForcing({ ...s, scenario: { stage: PGH } as AppState['scenario'] }), false);

  assert.equal(stormLabel('Asheville NC'), 'Storm over Asheville NC');
  assert.equal(stormLabel('Boulder, Colorado'), 'Storm over Boulder');
  assert.equal(stormLabel('Pittsburgh — Three Rivers'), 'Storm over Pittsburgh');
  assert.equal(stormLabel('A very long place name that does not fit'), 'Drop a storm');

  const grid = { nx: 1024, ny: 1024 };
  const centred = playStorm(grid, { gx: 400, gy: 600 });
  assert.equal(centred.id, PLAY_STORM_ID);
  assert.deepEqual([centred.gx, centred.gy, centred.radius], [400, 600, 358]);
  const edge = playStorm(grid, { gx: -50, gy: 2000 });
  assert.ok(edge.gx > 100 && edge.gy < 924, 'kept inside the map');
  assert.deepEqual([playStorm(grid, null).gx, playStorm(grid, null).gy], [512, 512]);
});
