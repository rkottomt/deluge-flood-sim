import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkWall, scanWalls, stageSurface, WALL_FREEBOARD } from '../../src/ui/wallCheck';
import { SpeedEstimator, displaySpeed, isDiverged } from '../../src/ui/stats';
import { suggestEvacStarts } from '../../src/ui/evacSuggest';
import { rainCategory, rainSubLabel, RAIN_TICKS, RAIN_MAX } from '../../src/ui/scales';
import { looksLikeNetworkError } from '../../src/ui/connectivity';
import { UIBridge } from '../../src/ui/bridge';
import type { RoadNetwork, SimStats, StageControl } from '../../src/contracts';

const PGH: StageControl = { label: 'Point', gaugeDatum: 211.409, normalLevel: 216.3, floodStageFt: 25, marks: [{ label: '1936 record', ft: 46 }], maxOffset: 12 };
const offset1936 = 46 * 0.3048 + PGH.gaugeDatum - PGH.normalLevel;

test('wall check: the default 2 m wall on the Mon wharf is overtopped at the 1936 crest', () => {
  const level = stageSurface(PGH, offset1936)!;
  assert.ok(Math.abs(level - 225.43) < 0.01);
  const c = checkWall({ ground: 221.8, barrier: 0, depth: 0, wallHeight: 2, stageLevel: level })!;
  assert.equal(c.ok, false);
  assert.equal(c.source, 'river');
  assert.ok(Math.abs(c.margin - (223.8 - level)) < 1e-6);
  assert.equal(c.suggested, Math.round((level + WALL_FREEBOARD - 221.8) * 10) / 10); // 4.1 m
  assert.equal(c.tooLow, false);
  // The suggested height holds.
  assert.equal(checkWall({ ground: 221.8, barrier: 0, depth: 0, wallHeight: c.suggested, stageLevel: level })!.ok, true);
  // At normal pool the same wall is fine.
  assert.equal(checkWall({ ground: 221.8, barrier: 0, depth: 0, wallHeight: 2, stageLevel: stageSurface(PGH, 0) })!.ok, true);
  // In the river channel no buildable wall is enough.
  assert.equal(checkWall({ ground: 212, barrier: 0, depth: 4, wallHeight: 10, stageLevel: level })!.tooLow, true);
  // No stage and dry ground: nothing to compare with.
  assert.equal(checkWall({ ground: 300, barrier: 0, depth: 0, wallHeight: 2, stageLevel: null }), null);
  // Standing water higher than the stage wins.
  const w = checkWall({ ground: 230, barrier: 0, depth: 1.2, wallHeight: 1, stageLevel: level })!;
  assert.equal(w.source, 'water');
  assert.equal(w.ok, false);
});

test('wall scan counts overtopped cells and a percentile height (not one deep outlier)', () => {
  const n = 100;
  const ground = new Float32Array(n).fill(300);
  const barrier = new Float32Array(n);
  const depth = new Float32Array(n);
  for (let k = 0; k < 20; k++) {
    ground[k] = 222;
    barrier[k] = 2;
  }
  ground[19] = 214.7; // one cell dips into the channel
  for (let k = 0; k < 8; k++) depth[k] = 0.5;
  const s = scanWalls(ground, barrier, depth, 225.43);
  assert.equal(s.cells, 20);
  assert.equal(s.overtopped, 8);
  assert.equal(s.belowLevel, 20);
  assert.ok(s.neededHeight >= 225.43 + WALL_FREEBOARD - 222 && s.neededHeight < 4.5, `needed ${s.neededHeight}`);
  const s2 = scanWalls(ground, barrier, null, null);
  assert.equal(s2.overtopped, 0);
  assert.equal(s2.belowLevel, 0);
  barrier[5] = 0;
  assert.notEqual(scanWalls(ground, barrier, null, null).signature, s2.signature, 'erasing a wall changes the signature');
});

test('wall scan with the grid width judges only crest cells, not the sloping rim beside the water', () => {
  // 10×5 grid: a 3-row wall (rows 1–3) whose outer rows taper (0.8 m) around a 4 m crest (row 2); water on row 1.
  const nx = 10;
  const ground = new Float32Array(50).fill(220);
  const barrier = new Float32Array(50);
  const depth = new Float32Array(50);
  for (let i = 0; i < nx; i++) {
    barrier[1 * nx + i] = 0.8;
    barrier[2 * nx + i] = 4;
    barrier[3 * nx + i] = 0.8;
    depth[0 * nx + i] = 5;
    depth[1 * nx + i] = 4.2; // water over the rim only
  }
  const rim = scanWalls(ground, barrier, depth, 223, nx);
  assert.equal(rim.cells, nx);
  assert.equal(rim.overtopped, 0);
  assert.equal(rim.belowLevel, 0);
  for (let i = 0; i < nx; i++) depth[2 * nx + i] = 0.2; // now over the crest too
  assert.equal(scanWalls(ground, barrier, depth, 225, nx).overtopped, nx);
  assert.equal(scanWalls(ground, barrier, depth, 225, nx).belowLevel, nx);
});

test('achieved speed is simulated time over wall time, robust to readback jitter', () => {
  const est = new SpeedEstimator(3000, 900, 1500);
  assert.equal(est.value(), null);
  // 300×, readbacks every ~300 ms with ±60 ms arrival jitter.
  let t = 0;
  let sim = 0;
  for (let k = 0; k < 20; k++) {
    const dt = 300 + (k % 2 ? 60 : -60);
    t += dt;
    sim += 0.3 * 300; // the sim advanced exactly 90 s per 300 ms
    est.push(t, sim);
  }
  const v = est.value()!;
  assert.ok(Math.abs(v - 300) / 300 < 0.05, `estimate ${v}`);
  assert.equal(displaySpeed(v, 300), 300);
  // A throttled run is reported as measured.
  assert.equal(displaySpeed(170, 300), 170);
  // Water reset (clock goes back) restarts the window.
  est.push(t + 300, 5);
  assert.equal(est.value(), null);
  // A long gap (paused) restarts it too.
  est.push(t + 600, 95);
  est.push(t + 5000, 200);
  assert.equal(est.value(), null);
});

test('divergence is detected from impossible statistics, not from big floods', () => {
  const ok: SimStats = { simTime: 10, maxDepth: 30, maxSpeed: 6, volume: 5e8, wetArea: 1e7, floodedArea: 5e6, volumeIn: 1e7, volumeOut: 1e6, massError: 2e-6, courant: 0.7 };
  assert.equal(isDiverged(ok), false);
  assert.equal(isDiverged(null), false);
  assert.equal(isDiverged({ ...ok, volume: -3.2e39 }), true);
  assert.equal(isDiverged({ ...ok, maxDepth: Infinity }), true);
  assert.equal(isDiverged({ ...ok, maxDepth: 8.3e3 }), false);
  assert.equal(isDiverged({ ...ok, maxDepth: 2e4 }), true);
  assert.equal(isDiverged({ ...ok, massError: NaN }), true);
});

test('evacuation suggestion: dry street below the flood level, near the focus, away from shelters', () => {
  const nx = 64, ny = 64;
  const ground = new Float32Array(nx * ny).fill(250); // hills
  for (let j = 0; j < ny; j++) for (let i = 0; i < 24; i++) ground[j * nx + i] = 220; // low district (west)
  const depth = new Float32Array(nx * ny);
  const pts: number[] = [];
  const add = (gx: number, gy: number) => (pts.push(gx, gy), pts.length / 2 - 1);
  const lowA = add(12.5, 30.5); // low street, 10 cells from the focus
  const lowB = add(20.5, 12.5); // low street, farther
  const hill = add(33.5, 30.5); // high street, nearest the focus
  const nearShelter = add(15.5, 40.5); // low, but next to the shelter
  const hw = add(18.5, 31.5); // highway-only node
  const other = add(40.5, 50.5);
  const roads: RoadNetwork = {
    nodes: new Float32Array(pts),
    edges: [
      { a: lowA, b: lowB, length: 100, cls: 'local', pts: new Float32Array(0) },
      { a: hill, b: other, length: 100, cls: 'minor', pts: new Float32Array(0) },
      { a: nearShelter, b: other, length: 100, cls: 'local', pts: new Float32Array(0) },
      { a: hw, b: other, length: 100, cls: 'highway', pts: new Float32Array(0) },
    ],
  };
  const out = suggestEvacStarts({
    nx, ny, ground, depth, roads,
    shelters: [{ name: 'S', gx: 15, gy: 42 }],
    focus: { gx: 22, gy: 30 },
    floodLevel: 225,
    currentLevel: 216,
  });
  assert.deepEqual(out[0], { gx: 12.5, gy: 30.5 });
  assert.ok(!out.some((p) => p.gx === 18.5), 'highway-only nodes are not homes');
  assert.ok(!out.some((p) => p.gx === 15.5), 'not next to a shelter');
  // Once that street is under water it is no longer a candidate.
  depth[30 * nx + 12] = 0.4;
  assert.notDeepEqual(suggestEvacStarts({ nx, ny, ground, depth, roads, shelters: [], focus: { gx: 22, gy: 30 }, floodLevel: 225, currentLevel: 216 })[0], { gx: 12.5, gy: 30.5 });
});

test('rain readout stays short enough for the slider head at every rate', () => {
  for (const v of [0.5, 2.5, 7, 25, 60, 100, 150, 300]) {
    const label = rainSubLabel(v);
    assert.ok(label.length <= 26, `"${label}" (${label.length})`);
  }
  assert.equal(rainSubLabel(0), 'No rain');
  assert.match(rainSubLabel(100), /^Harvey-class · 3\.9 in\/hr$/);
  assert.equal(rainCategory(300).label, 'Record-class');
  assert.equal(RAIN_TICKS[RAIN_TICKS.length - 1].value, RAIN_MAX);
});

test('network failures are recognised as such', () => {
  for (const m of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'net::ERR_INTERNET_DISCONNECTED', 'The operation was aborted.', 'Request timed out'])
    assert.equal(looksLikeNetworkError(m), true, m);
  assert.equal(looksLikeNetworkError('No elevation data available for this area'), false);
});

test('bridge delivers notices posted before the UI subscribed, and dedupes hover', () => {
  const b = new UIBridge();
  b.notify({ kind: 'info', title: 'early', message: '' });
  const got: string[] = [];
  b.onNotice((n) => got.push(n.title));
  b.notify({ kind: 'warn', title: 'late', message: '' });
  assert.deepEqual(got, ['early', 'late']);
  let hovers = 0;
  b.hoverChanged.on(() => hovers++);
  b.setHover({ gx: 1, gy: 2, ground: 3, barrier: 0, depth: 0 });
  b.setHover({ gx: 1, gy: 2, ground: 3, barrier: 0, depth: 0 });
  b.setHover(null);
  assert.equal(hovers, 2);
});

test('wall scan inside known wall bounds gives the same answer as the full scan, and null bounds mean no walls', () => {
  const nx = 64;
  const ny = 48;
  const n = nx * ny;
  const ground = new Float32Array(n);
  const barrier = new Float32Array(n);
  const depth = new Float32Array(n);
  for (let c = 0; c < n; c++) ground[c] = 220 + ((c * 7919) % 13) * 0.3;
  // A diagonal levee with tapered sides, partly under water.
  for (let k = 0; k < 30; k++) {
    const i = 10 + k;
    const j = 12 + (k >> 1);
    barrier[j * nx + i] = 3.5;
    barrier[(j - 1) * nx + i] = Math.max(barrier[(j - 1) * nx + i], 0.9);
    barrier[(j + 1) * nx + i] = Math.max(barrier[(j + 1) * nx + i], 0.9);
    if (k % 3 === 0) depth[j * nx + i] = 0.4;
  }
  const full = scanWalls(ground, barrier, depth, 222.5, nx);
  assert.ok(full.cells > 0);
  const bounded = scanWalls(ground, barrier, depth, 222.5, nx, { x0: 9, y0: 10, x1: 41, y1: 29 });
  assert.deepEqual(bounded, full);
  // Bounds reaching past the grid are clipped.
  assert.deepEqual(scanWalls(ground, barrier, depth, 222.5, nx, { x0: -5, y0: -5, x1: 500, y1: 500 }), full);
  const none = scanWalls(ground, barrier, depth, 222.5, nx, null);
  assert.equal(none.cells, 0);
  assert.equal(none.belowLevel, 0);
});
