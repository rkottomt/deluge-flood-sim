/**
 * Polygon rasterisation, the run-length encoding of the committed FEMA rasters, and the like-for-like rules of
 * src/validation/score.ts, on small synthetic grids whose answers are known.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillGeoJsonGeometry, fillPolygon, lineCells, rleDecode, rleEncode } from '../../src/validation/raster';
import { EXTENT_CELL, FLOOD_M, nearestWetWse, scoreBfeProfile, scoreEms, scoreFema, scorePoints, type ModelFields } from '../../src/validation/score';
import type { EmsDamage, FemaZonesFile } from '../../src/validation/types';
import { FEMA_CLASSES } from '../../src/validation/types';

test('fillPolygon fills the cells whose centres are inside (even–odd, holes cut out)', () => {
  const out = new Uint8Array(100);
  // Outer square [1,9]², hole [4,6]².
  const n = fillPolygon(out, 10, 10, [[1, 1, 9, 1, 9, 9, 1, 9], [4, 4, 6, 4, 6, 6, 4, 6]], 7);
  assert.equal(n, 64 - 4);
  assert.equal(out[1 * 10 + 1], 7);
  assert.equal(out[4 * 10 + 4], 0, 'hole');
  assert.equal(out[0], 0);
  assert.equal(out[9 * 10 + 9], 0);
});

test('fillPolygon: a half-cell sliver fills nothing, a cell-centred square fills exactly its cells', () => {
  const out = new Uint8Array(16);
  assert.equal(fillPolygon(out, 4, 4, [[0, 0, 0.4, 0, 0.4, 4, 0, 4]], 1), 0);
  assert.equal(fillPolygon(out, 4, 4, [[1, 1, 3, 1, 3, 3, 1, 3]], 1), 4);
});

test('fillGeoJsonGeometry maps lon/lat through the grid’s Web-Mercator registration', () => {
  const grid = { nx: 10, ny: 10, bounds: { west: 0, south: 0, east: 0.01, north: 0.01 } };
  const out = new Uint8Array(100);
  // The western half of the domain, as a GeoJSON polygon.
  const n = fillGeoJsonGeometry(out, grid, { type: 'Polygon', coordinates: [[[0, 0], [0.005, 0], [0.005, 0.01], [0, 0.01], [0, 0]]] }, 1);
  assert.equal(n, 50);
  assert.equal(out[0], 1);
  assert.equal(out[9], 0);
  assert.equal(fillGeoJsonGeometry(out, grid, { type: 'Point', coordinates: [0, 0] }, 1), 0);
});

test('rleEncode / rleDecode round-trip, and decode refuses runs of the wrong length', () => {
  const a = new Uint8Array([0, 0, 1, 1, 1, 0, 4, 4, 2]);
  const runs = rleEncode(a);
  assert.deepEqual(runs, [0, 2, 1, 3, 0, 1, 4, 2, 2, 1]);
  assert.deepEqual([...rleDecode(runs, a.length)], [...a]);
  assert.throws(() => rleDecode(runs, a.length + 1), /cover/);
  assert.throws(() => rleDecode(runs, a.length - 1), /overflow/);
});

test('lineCells samples every cell a segment crosses, once', () => {
  assert.deepEqual(lineCells(4, 4, [0.5, 0.5, 3.5, 0.5]), [0, 1, 2, 3]);
  assert.deepEqual(lineCells(4, 4, [0.5, 0.5, 0.5, 2.5]), [0, 4, 8]);
  assert.deepEqual(lineCells(4, 4, [-5, -5, -1, -1]), []);
});

/** A 10×10 grid: ground 10 m, a river (initial water) along column 0, a pool on cells (5..6, 5). */
function fields(): ModelFields {
  const nx = 10;
  const ny = 10;
  const ground = new Float32Array(100).fill(10);
  const maxDepth = new Float32Array(100);
  const initialWater = new Float32Array(100);
  for (let j = 0; j < ny; j++) {
    initialWater[j * nx] = 2;
    maxDepth[j * nx] = 2.5;
  }
  maxDepth[5 * nx + 5] = 1;
  maxDepth[5 * nx + 6] = 0.5;
  return { nx, ny, cellSize: 5, ground, maxDepth, initialWater };
}

test('nearestWetWse reads the nearest wetted cell within the radius, not a deeper one further away', () => {
  const f = fields();
  const w = nearestWetWse(f, 6.5, 5.5, 10);
  assert.ok(w);
  assert.equal(w.wse, 10.5); // the cell itself: ground 10 + 0.5
  assert.equal(w.distanceM, 0);
  const w2 = nearestWetWse(f, 7.5, 5.5, 6);
  assert.equal(w2?.wse, 10.5);
  assert.equal(w2?.distanceM, 5);
  assert.equal(nearestWetWse(f, 9.5, 9.5, 10), null);
});

test('scorePoints: residual = model − observed; a dry point is counted, not dropped, and scored at the ground', () => {
  const f = fields();
  const r = scorePoints(
    f,
    [
      { id: 'a', name: 'pool', gx: 5.5, gy: 5.5, elevation: 10.8 },
      { id: 'b', name: 'dry hill', gx: 9.5, gy: 9.5, elevation: 10.4 },
    ],
    5,
  );
  assert.equal(r.rows[0].residual !== null && Math.abs(r.rows[0].residual - 0.2) < 1e-6, true);
  assert.equal(r.rows[1].modelled, null);
  assert.equal(r.dry, 1);
  assert.equal(r.wet.n, 1);
  assert.equal(r.all.n, 2);
  // Dry point: ground 10 − observed 10.4 = −0.4.
  assert.ok(Math.abs((r.all.bias as number) - (0.2 - 0.4) / 2) < 1e-6);
});

test('scoreFema: rivers at t = 0, FEMA open water and excluded cells are left out; unconnected 1 % zones are separated', () => {
  const f = fields();
  const nx = 10;
  const cls = new Uint8Array(100).fill(3);
  // FEMA 1 % zone: columns 1–2 (connected to the river in column 0), and cell (8, 8) on its own.
  for (let j = 0; j < 10; j++) {
    cls[j * nx + 1] = 1;
    cls[j * nx + 2] = 1;
  }
  cls[8 * nx + 8] = 1;
  cls[9 * nx + 9] = 4; // open water
  // Model floods column 1 and the pool.
  for (let j = 0; j < 10; j++) f.maxDepth[j * nx + 1] = 0.5;
  const zones: FemaZonesFile = { version: 1, preset: 't', nx: 10, ny: 10, classes: FEMA_CLASSES, counts: {}, dfirm: [], polygons: 0, rle: rleEncode(cls) };
  const r = scoreFema(f, zones);
  // Connected: hits = column 1 (10), misses = column 2 (10), false alarms = pool cells (2) — (5,5) ≥ 0.15 and (6,5) ≥ 0.15.
  assert.equal(r.connected.hits, 10);
  assert.equal(r.connected.misses, 10);
  assert.equal(r.connected.falseAlarms, 2);
  assert.ok(Math.abs((r.connected.csi as number) - 10 / 22) < 1e-12);
  // All zones: the lone cell (8, 8) is now a miss too.
  assert.equal(r.all.misses, 11);
  // Land only: 100 − 10 river − 1 open water = 89 compared in "all".
  assert.equal(r.all.cells, 89);
  assert.equal(r.cells[0], EXTENT_CELL.permanentWater);
  assert.equal(r.cells[8 * nx + 8], EXTENT_CELL.otherFlood);
  assert.equal(r.cells[5 * nx + 5], EXTENT_CELL.falseAlarm);
  assert.equal(r.cells[1], EXTENT_CELL.hit);
  assert.equal(r.cells[2], EXTENT_CELL.miss);
  // An excluded (stage-disc) cell leaves the comparison.
  const ex = new Uint8Array(100);
  ex[1] = 1;
  assert.equal(scoreFema({ ...f, exclude: ex }, zones).connected.hits, 9);
  assert.ok(FLOOD_M === 0.15);
});

test('scoreBfeProfile reads only the lines that cross a forced river, as the median WSE of their wetted cells', () => {
  const f = fields();
  // Line across row 3 from the river to the east edge: wetted cells = river cell only (WSE 12.5).
  // Line across row 5: river (12.5), pool (11), pool (10.5) → median 11.
  // Line that never touches the river: ignored.
  const r = scoreBfeProfile(f, [
    { elev: 12, pts: [0.5, 3.5, 9.5, 3.5] },
    { elev: 11.2, pts: [0.5, 5.5, 9.5, 5.5] },
    { elev: 99, pts: [5.5, 8.5, 9.5, 8.5] },
  ]);
  assert.equal(r.rows.length, 2);
  assert.ok(Math.abs(r.rows[0].residual - 0.5) < 1e-6);
  assert.ok(Math.abs(r.rows[1].modelled - 11) < 1e-6);
  assert.equal(r.scores.n, 2);
});

test('scoreEms: damaged buildings reached, near-misses, and road cells against undamaged ones, inside the analysed area', () => {
  const f = fields();
  const analysed = new Uint8Array(100).fill(1);
  analysed[99] = 0;
  const ems: EmsDamage = {
    activation: 'T',
    aoi: 1,
    product: 'GRA',
    images: [],
    observedEvent: [],
    analysedRle: rleEncode(analysed),
    buildings: [
      { gx: 5.5, gy: 5.5, grade: 'Destroyed' }, // in the pool
      { gx: 8.5, gy: 5.5, grade: 'Destroyed' }, // two cells (10 m) from the pool
      { gx: 5.5, gy: 0.5, grade: 'Damaged' }, // far from any water
      { gx: 9.5, gy: 9.5, grade: 'Destroyed' }, // outside the analysed area
      { gx: 2.5, gy: 2.5, grade: 'Possibly damaged' },
    ],
    roads: [
      { pts: [0.5, 7.5, 1.5, 7.5], grade: 'Destroyed', type: '' }, // river cell + dry cell
      { pts: [3.5, 8.5, 4.5, 8.5], grade: 'No visible damage', type: '' },
    ],
  };
  const r = scoreEms(f, ems);
  assert.equal(r.buildings['Destroyed'].n, 2);
  assert.equal(r.buildings['Destroyed'].flooded, 1);
  assert.ok(Math.abs((r.buildingHitRate as number) - 1 / 3) < 1e-12);
  // Within 30 m (6 cells at 5 m): the second building is a near-miss; the third is 25 m from the pool … also near.
  assert.ok((r.buildingHitRateNear as number) >= 2 / 3 - 1e-12);
  assert.equal(r.roads.hits, 1);
  assert.equal(r.roads.misses, 1);
  assert.equal(r.roads.falseAlarms, 0);
  assert.equal(r.roads.correctNegatives, 2);
  assert.equal(r.analysedCells, 99);
});
