/**
 * Building footprints → blocks, porosities and roof routing (src/data/porosity.ts; ARCHITECTURE.md §3.11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingLayers, EDGE_BAND, footprintSubgrid, PHI_BLOCK, POROSITY_SUBSAMPLES } from '../../src/data/porosity';
import { MIN_OBSTACLE_HEIGHT } from '../../src/data/landcover';
import { rectBuildings as rects } from '../helpers/footprints';

const nx = 32;
const ny = 32;
const at = (a: Float32Array, i: number, j: number) => a[j * nx + i];

test('footprintSubgrid: sub-cells by centre, one byte per cell per sub-row, tallest roof per cell', () => {
  const S = POROSITY_SUBSAMPLES;
  // Covers x 10.0–10.5 (sub-columns 0–3 of cell 10), y 5.0–6.0 (all 8 sub-rows of row 5).
  const { bits, roof } = footprintSubgrid(rects([[10, 5, 10.5, 6, 9]]), nx, ny);
  for (let k = 0; k < S; k++) assert.equal(bits[(5 * S + k) * nx + 10], 0b00001111, `sub-row ${k}`);
  assert.equal(bits[(4 * S + 7) * nx + 10], 0, 'row above untouched');
  assert.equal(at(roof, 10, 5), 9);
  assert.equal(at(roof, 11, 5), 0);
});

test('a cell half under a house stays open: φ, roof share, and its own downspout', () => {
  const L = buildingLayers(rects([[10, 10, 10.5, 11, 8]]), nx, ny)!;
  const p = L.porosity!;
  assert.equal(L.obstacles, null, 'nothing is blocked');
  assert.equal(L.blockedCells, 0);
  assert.equal(L.porousCells, 1);
  assert.equal(at(p.cell, 10, 10), 0.5);
  assert.equal(at(p.roof, 10, 10), 0.5);
  assert.equal(at(p.spout, 10, 10), 0.5, 'the roof sheds into the cell’s own open half');
  // West face (cell 9's east face) runs along the house wall: closed. East face: open, capped at φ = 0.5.
  assert.equal(at(p.faceE, 9, 10), 0);
  assert.equal(at(p.faceE, 10, 10), 0.5);
  // North/south faces: half their length is wall.
  assert.equal(at(p.faceS, 10, 10), 0.5);
  assert.equal(at(p.faceS, 10, 9), 0.5);
  // Everything else untouched.
  assert.equal(at(p.cell, 11, 10), 1);
  assert.equal(at(p.faceE, 11, 10), 1);
});

test('a 2 m side yard between two houses stays a path; cell-centre blocking closed it', () => {
  // Two houses on a 7.8 m grid: x 10.0–12.6 and 12.9–15.5 (a 0.3-cell, 2.3 m gap inside column 12), y 10–13.
  const set = rects([
    [10, 10, 12.6, 13, 7],
    [12.9, 10, 15.5, 13, 7],
  ]);
  const L = buildingLayers(set, nx, ny)!;
  const p = L.porosity!;
  // Column 12 is 5 + 1 of 8 sub-columns covered: porous, not blocked (the cell-centre rule blocked it: its centre is in a house).
  for (let j = 10; j < 13; j++) {
    assert.ok(Math.abs(at(p.cell, 12, j) - 0.25) < 1e-6, `φ(12, ${j}) = ${at(p.cell, 12, j)}`);
    assert.equal(at(p.roof, 12, j), 0.75);
  }
  // Water can run along the yard, north–south, through the faces of column 12 (2 of 8 sub-columns open).
  for (let j = 9; j < 13; j++) assert.equal(at(p.faceS, 12, j), 0.25, `ψS(12, ${j})`);
  // …but not east–west through the houses: the cells either side are blocks (their wall is the raised bed, so the face
  // keeps the yard's φ).
  for (let j = 10; j < 13; j++) {
    assert.ok(at(L.obstacles!, 11, j) > 0 && at(L.obstacles!, 13, j) > 0, 'house cells either side are blocks');
    assert.equal(at(p.faceE, 11, j), 0.25);
    assert.equal(at(p.faceE, 12, j), 0.25);
  }
  // Fully covered cells are blocks at their roof height.
  assert.ok(L.obstacles);
  assert.equal(at(L.obstacles!, 10, 11), 7);
  assert.equal(at(L.obstacles!, 12, 11), 0, 'the yard column is not blocked');
  assert.ok(L.blockedCells >= 12);
});

test('blocks: ≥ 90 % covered, at the roof height (never below the minimum), φ = 1, faces left to the raised bed', () => {
  const L = buildingLayers(rects([[4, 4, 8, 8, 1]]), nx, ny, { ground: new Float32Array(nx * ny).fill(100) })!;
  const p = L.porosity!;
  assert.equal(L.blockedCells, 16);
  for (let j = 4; j < 8; j++) {
    for (let i = 4; i < 8; i++) {
      assert.equal(at(L.obstacles!, i, j), MIN_OBSTACLE_HEIGHT);
      assert.equal(at(p.cell, i, j), 1);
      assert.equal(at(p.roof, i, j), 1);
    }
  }
  assert.equal(at(p.faceE, 3, 5), 1, 'a block wall is the bed, not a porosity');
  assert.ok(PHI_BLOCK > 0 && PHI_BLOCK < 0.5);
});

test('downspouts: every block’s roof lands on an open cell next to the building (lowest first), nothing is lost', () => {
  const ground = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) ground[j * nx + i] = 50 - 0.1 * i; // falls to the east
  const set = rects([
    [4, 4, 8, 8, 6], // 16-cell block
    [20, 20, 20.5, 21, 6], // half-cell house
    [14, 4, 15, 5, 6], // one-cell block
  ]);
  const L = buildingLayers(set, nx, ny, { ground })!;
  const p = L.porosity!;
  let roof = 0;
  let spout = 0;
  for (let c = 0; c < nx * ny; c++) {
    roof += p.roof[c];
    spout += p.spout[c];
    if (L.obstacles && L.obstacles[c] > 0) assert.equal(p.spout[c], 0, 'no downspout discharges onto a roof');
  }
  assert.ok(Math.abs(roof - spout) < 1e-9, `roof area ${roof} vs spout ${spout}`);
  // The one-cell block sheds onto its lowest neighbour: east.
  assert.equal(at(p.spout, 15, 4), 1);
  // The big block's roof goes to the cells around it.
  let ring = 0;
  for (let j = 3; j <= 8; j++) for (let i = 3; i <= 8; i++) if (!(at(L.obstacles!, i, j) > 0)) ring += at(p.spout, i, j);
  assert.equal(ring, 16);
});

test('never porous or blocked under the initial water; porous cells stay out of the edge band', () => {
  const water = new Float32Array(nx * ny);
  for (let i = 0; i < nx; i++) water[16 * nx + i] = 2;
  const set = rects([
    [6, 15.5, 9, 17, 9], // over the river row 16
    [1, 10, 1.5, 11, 9], // half-cell house in the edge band
    [0, 20, 2, 22, 9], // a block in the edge band
  ]);
  const L = buildingLayers(set, nx, ny, { initialWater: water })!;
  const p = L.porosity!;
  for (let i = 6; i < 9; i++) {
    assert.equal(at(p.cell, i, 16), 1);
    assert.equal(at(p.roof, i, 16), 0);
    assert.equal(L.obstacles ? at(L.obstacles, i, 16) : 0, 0);
  }
  assert.ok(1 < EDGE_BAND);
  assert.equal(at(p.cell, 1, 10), 1, 'no porosity in the edge band');
  assert.equal(at(p.roof, 1, 10), 0);
  assert.ok(at(L.obstacles!, 0, 20) > 0, 'blocks are allowed in the band, as before');
});

test('no footprints, no layers', () => {
  const none = buildingLayers(null, nx, ny);
  assert.equal(none.porosity, null);
  assert.equal(none.obstacles, null);
  const tiny = buildingLayers(rects([[10.01, 10.01, 10.05, 10.05, 5]]), nx, ny);
  assert.equal(tiny.porosity, null, 'a footprint smaller than a sub-cell covers nothing');
});
