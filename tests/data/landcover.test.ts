/**
 * Land cover (src/data/landcover.ts, scripts/bake-landcover.ts): the baked rasters, the class tables and the
 * land-surface layers the solver gets from them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conusAlbers } from '../../scripts/bake-landcover';
import { computeInitialWater } from '../../src/data/initialWater';
import {
  classAt,
  decodeLandCover,
  landSurfaceFromCover,
  MIN_OBSTACLE_HEIGHT,
  N_CHANNEL,
  NLCD_CLASSES,
  obstacleHeights,
  validateLandCoverMeta,
  WORLDCOVER_CLASSES,
  type LandCover,
} from '../../src/data/landcover';
import { type PresetMeta, PRESETS, validatePresetMeta } from '../../src/data/presets';
import type { BuildingSet } from '../../src/contracts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/presets');
const BAKED = PRESETS.map((p) => p.id).filter((id) => id !== 'sandbox');
const US = new Set(['pittsburgh', 'johnstown', 'ellicott', 'asheville', 'nashville', 'houston', 'boulder', 'ftmyers']);

function load(id: string): { meta: PresetMeta; lc: LandCover } {
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, id, 'meta.json'), 'utf8')) as PresetMeta;
  const buf = fs.readFileSync(path.join(ROOT, id, meta.files.landcover!));
  return { meta, lc: decodeLandCover(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), meta.landcover!) };
}

test('every baked preset ships land cover: valid block, right size, known classes, credited', () => {
  for (const id of BAKED) {
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, id, 'meta.json'), 'utf8')) as PresetMeta;
    assert.equal(meta.files.landcover, 'landcover.u8', `${id}: files.landcover`);
    assert.deepEqual(validateLandCoverMeta(meta.landcover), [], id);
    assert.deepEqual(validatePresetMeta(meta), [], id);
    const { lc } = load(id);
    assert.equal(lc.scheme, US.has(id) ? 'nlcd' : 'worldcover', `${id}: scheme`);
    assert.equal(lc.width, US.has(id) ? 256 : 512, `${id}: width`);
    const known = new Set((lc.scheme === 'nlcd' ? NLCD_CLASSES : WORLDCOVER_CLASSES).map((k) => k.code));
    let unknown = 0;
    for (const v of lc.classes) if (!known.has(v)) unknown++;
    assert.equal(unknown, 0, `${id}: ${unknown} pixels with a class outside the table`);
    assert.ok(meta.attribution.includes(lc.scheme === 'nlcd' ? 'NLCD 2021' : 'ESA WorldCover'), `${id}: land-cover credit`);
    // Drains only where there is US design rainfall (NOAA Atlas 14 2-yr 60-min: 20–60 mm/hr across these cities).
    if (US.has(id)) assert.ok(lc.designRainMmHr >= 15 && lc.designRainMmHr <= 80, `${id}: design rain ${lc.designRainMmHr}`);
    else assert.equal(lc.designRainMmHr, 0, `${id}: no drains outside the US`);
  }
});

test('land cover is registered on the grid: the big rivers land on the water class', () => {
  // The share of initial-water cells (the burned river channels) classed as open water. Wide rivers sit on NLCD water;
  // narrow creeks and Houston's bayou trench (30 m pixels) do not, so only the big-river presets are checked.
  const expect: Record<string, number> = { pittsburgh: 0.75, nashville: 0.7, ftmyers: 0.9 };
  for (const [id, min] of Object.entries(expect)) {
    const { meta, lc } = load(id);
    const elevation = new Float32Array(new Uint8Array(fs.readFileSync(path.join(ROOT, id, meta.files.elevation))).slice().buffer);
    const water = computeInitialWater({ nx: meta.nx, ny: meta.ny, elevation }, meta.scenario);
    let wet = 0;
    let onWater = 0;
    for (let j = 0; j < meta.ny; j++) {
      for (let i = 0; i < meta.nx; i++) {
        if (!(water[j * meta.nx + i] >= 0.01)) continue;
        wet++;
        if (classAt(lc, meta.nx, meta.ny, i, j) === 11) onWater++;
      }
    }
    // A misregistered raster (a flipped axis, the wrong projection) puts the rivers on land: this is the registration check.
    assert.ok(onWater / wet >= min, `${id}: ${((onWater / wet) * 100).toFixed(1)} % of the river on NLCD water`);
  }
  // Houston downtown is developed land almost wall to wall.
  const { lc } = load('houston');
  let dev = 0;
  for (const v of lc.classes) if (v >= 21 && v <= 24) dev++;
  assert.ok(dev / lc.classes.length > 0.9, `Houston developed share ${dev / lc.classes.length}`);
});

test('class tables: n inside the HEC-RAS ranges, street n only lower for developed classes, drains only on developed land', () => {
  for (const k of [...NLCD_CLASSES, ...WORLDCOVER_CLASSES]) {
    assert.ok(k.n >= 0.02 && k.n <= 0.2, `${k.name} n ${k.n}`);
    assert.ok(k.nStreet <= k.n, `${k.name}: street n above the bare-earth n`);
    const developed = /Developed|Built-up/.test(k.name);
    if (!developed) {
      assert.equal(k.nStreet, k.n, `${k.name}: only developed land changes with explicit buildings`);
      assert.equal(k.drainC, 0, `${k.name}: drains on undeveloped land`);
    } else {
      assert.ok(k.drainC > 0 && k.drainC < 1, `${k.name}: runoff coefficient`);
    }
  }
  const water = NLCD_CLASSES.find((k) => k.code === 11)!;
  assert.equal(water.n, N_CHANNEL, 'open water keeps the uniform river n');
});

test('landSurfaceFromCover: nearest-neighbour upsampling, channels at the river n, street n with buildings, C × design rain', () => {
  const lc: LandCover = {
    scheme: 'nlcd',
    year: 2021,
    width: 2,
    height: 2,
    designRainMmHr: 40,
    designRainSource: 'test',
    classes: Uint8Array.from([24, 41, 11, 22]),
    attribution: '',
  };
  const nx = 4;
  const ny = 4;
  const water = new Float32Array(nx * ny);
  water[0] = 0.5; // a burned channel cell in the high-intensity quadrant
  const bare = landSurfaceFromCover(lc, nx, ny, { buildingsResolved: false, initialWater: water });
  const streets = landSurfaceFromCover(lc, nx, ny, { buildingsResolved: true, initialWater: water });
  const at = (a: Float32Array, i: number, j: number) => a[j * nx + i];
  assert.equal(at(bare.roughness, 0, 0), Math.fround(N_CHANNEL), 'wet cell takes the channel n');
  assert.equal(at(bare.roughness, 1, 1), Math.fround(0.13), 'high intensity, buildings as roughness');
  assert.equal(at(streets.roughness, 1, 1), Math.fround(0.02), 'high intensity, open ground between buildings');
  assert.equal(at(bare.roughness, 3, 0), Math.fround(0.12), 'deciduous forest');
  assert.equal(at(bare.roughness, 0, 3), Math.fround(N_CHANNEL), 'open water');
  assert.equal(at(bare.drainCapacity, 1, 0), Math.fround(0.85 * 40), 'drain = C × design rain');
  assert.equal(at(bare.drainCapacity, 0, 0), 0, 'no drains in the channel');
  assert.equal(at(bare.drainCapacity, 3, 3), Math.fround(0.45 * 40), 'low intensity');
  assert.equal(at(bare.drainCapacity, 3, 0), 0, 'no drains in the forest');
  assert.equal(bare.drainedCells, 3 + 4);
  const none = landSurfaceFromCover({ ...lc, designRainMmHr: 0 }, nx, ny, { buildingsResolved: false });
  assert.equal(none.drainedCells, 0, 'no design rain, no drains');
});

test('obstacleHeights: footprint cells at their roof height, never below the minimum; none without a raster', () => {
  const nx = 4;
  const ny = 2;
  const raster = Float32Array.from([0, 12, 1, 0, 0, 0, 0, 40]);
  const set = { heightRaster: raster } as unknown as BuildingSet;
  const o = obstacleHeights(set, nx, ny)!;
  assert.deepEqual(Array.from(o), [0, 12, MIN_OBSTACLE_HEIGHT, 0, 0, 0, 0, 40]);
  assert.equal(obstacleHeights({ heightRaster: new Float32Array(nx * ny) } as unknown as BuildingSet, nx, ny), null);
  assert.equal(obstacleHeights(null, nx, ny), null);
  assert.equal(obstacleHeights({ heightRaster: new Float32Array(3) } as unknown as BuildingSet, nx, ny), null);
});

test('obstacleHeights with the ground: one flat roof per group of touching footprints, no bowls between roofs', () => {
  // Row 0: a 12 m tower, a 3 m annex and a 20 m tower touching (one group, ground rising 0–2 m); row 1: a lone shed.
  const nx = 4;
  const ny = 2;
  const raster = Float32Array.from([12, 3, 20, 0, 0, 0, 0, 2]);
  const ground = Float32Array.from([0, 1, 2, 0, 5, 5, 5, 5]);
  const o = obstacleHeights({ heightRaster: raster } as unknown as BuildingSet, nx, ny, null, ground)!;
  const roof = [0, 1, 2].map((c) => ground[c] + o[c]);
  assert.deepEqual(roof, [22, 22, 22], 'the group sits under the tallest roof');
  assert.equal(o[3], 0);
  assert.equal(o[7], MIN_OBSTACLE_HEIGHT, 'a lone low building keeps its own (minimum) height');
});

test('decodeLandCover rejects a size mismatch and an unknown scheme', () => {
  const meta = { scheme: 'nlcd' as const, year: 2021, width: 16, height: 16, designRainMmHr: 30, designRainSource: '' };
  assert.throws(() => decodeLandCover(new ArrayBuffer(10), meta), /bytes/);
  assert.throws(() => decodeLandCover(new ArrayBuffer(256), { ...meta, scheme: 'corine' as never }), /scheme/);
  assert.equal(decodeLandCover(new ArrayBuffer(256), meta).classes.length, 256);
});

test('Conus Albers (EPSG:5070): origin at 23 N 96 W, symmetric about the central meridian, NLCD-scale coordinates', () => {
  const o = conusAlbers(-96, 23);
  assert.ok(Math.abs(o.x) < 1e-6 && Math.abs(o.y) < 1e-6, `origin ${o.x}, ${o.y}`);
  const a = conusAlbers(-90, 35);
  const b = conusAlbers(-102, 35);
  assert.ok(Math.abs(a.x + b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6, 'symmetric');
  // Downtown Pittsburgh: the WCS subset the bake fetched spans x 1,335,405–1,344,765 m, y 2,045,145–2,054,565 m.
  const p = conusAlbers(-79.99, 40.444);
  assert.ok(p.x > 1335405 && p.x < 1344765 && p.y > 2045145 && p.y < 2054565, `Pittsburgh ${p.x}, ${p.y}`);
});
