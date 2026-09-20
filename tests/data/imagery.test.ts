/// <reference types="node" />
/**
 * Aerial imagery: the export URLs, and the geometry of the close-up detail inset (src/data/imagery.ts) — a second,
 * finer photo over part of a preset's grid. The inset is only useful if it lands on EXACTLY the same ground as the
 * base photo, so most of this file is registration: whole cells, square, inside the grid, and a mercator sub-bbox
 * that agrees with the grid↔geo conversion the rest of the app uses.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detailMercatorBBox,
  detailMetersPerTexel,
  detailRect,
  DETAIL_SIZE,
  DETAIL_TARGET_MPT,
  isValidDetailRect,
  naipImageryUrl,
  NAIP_MAX_EXPORT,
} from '../../src/data/imagery';
import { boundsToMercator, geoToGrid, gridToGeo, lonLatToMercator, squareDomain } from '../../src/data/geo';

const N = 1024;
const CELL = 7.8125; // 8 km over 1024 cells, the pittsburgh preset

test('detailRect: whole cells, square, inside the grid', () => {
  const r = detailRect(N, N, CELL, { gx: 512, gy: 512 }, 3000)!;
  assert.ok(r, 'a 3 km square fits in an 8 km domain');
  for (const v of [r.x0, r.y0, r.x1, r.y1]) assert.ok(Number.isInteger(v), `${v} is a whole cell`);
  assert.equal(r.x1 - r.x0, r.y1 - r.y0, 'square');
  assert.equal(r.x1 - r.x0, Math.round(3000 / CELL));
  assert.ok(isValidDetailRect(r, N, N));
});

test('detailRect: a square near the edge is shifted inside, never clipped', () => {
  const r = detailRect(N, N, CELL, { gx: 20, gy: N - 10 }, 3000)!;
  assert.equal(r.x0, 0);
  assert.equal(r.y1, N);
  assert.equal(r.x1 - r.x0, r.y1 - r.y0, 'still square');
  assert.ok(isValidDetailRect(r, N, N));
});

test('detailRect: no inset when the square would cover the domain', () => {
  assert.equal(detailRect(N, N, CELL, { gx: 512, gy: 512 }, 8000), null);
  assert.equal(detailRect(N, N, CELL, { gx: 512, gy: 512 }, 0), null);
  assert.equal(detailRect(N, N, 0, { gx: 512, gy: 512 }, 3000), null);
});

test('isValidDetailRect rejects fractional, inverted and out-of-grid rectangles', () => {
  assert.equal(isValidDetailRect(null, N, N), false);
  assert.equal(isValidDetailRect({ x0: 0.5, y0: 0, x1: 10, y1: 10 }, N, N), false);
  assert.equal(isValidDetailRect({ x0: 10, y0: 0, x1: 10, y1: 10 }, N, N), false, 'empty');
  assert.equal(isValidDetailRect({ x0: 10, y0: 10, x1: 5, y1: 20 }, N, N), false, 'inverted');
  assert.equal(isValidDetailRect({ x0: 0, y0: 0, x1: N + 1, y1: 10 }, N, N), false, 'off the grid');
  assert.equal(isValidDetailRect({ x0: 0, y0: 0, x1: N, y1: N }, N, N), true);
});

test('detailMercatorBBox lands on exactly the cells the rectangle names', () => {
  const { bounds, merc } = squareDomain({ lat: 40.444, lon: -79.99 }, 8000);
  const rect = detailRect(N, N, CELL, geoToGrid({ nx: N, ny: N, bounds }, -80.005, 40.442), 3000)!;
  const sub = detailMercatorBBox(merc, N, N, rect);
  // The two corners of the rectangle, converted through the app's own grid → geo path, must be the sub-bbox corners.
  const nw = gridToGeo({ nx: N, ny: N, bounds }, rect.x0, rect.y0);
  const se = gridToGeo({ nx: N, ny: N, bounds }, rect.x1, rect.y1);
  const mnw = lonLatToMercator(nw.lon, nw.lat);
  const mse = lonLatToMercator(se.lon, se.lat);
  for (const [a, b] of [[sub.xmin, mnw.x], [sub.ymax, mnw.y], [sub.xmax, mse.x], [sub.ymin, mse.y]]) {
    assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b} (mercator metres)`);
  }
  assert.ok(sub.xmin >= merc.xmin && sub.xmax <= merc.xmax && sub.ymin >= merc.ymin && sub.ymax <= merc.ymax, 'inside the domain');
  // Grid rows run north → south; mercator y runs the other way.
  assert.ok(sub.ymax < merc.ymax && sub.ymin > merc.ymin);
});

test('detailMercatorBBox survives a bounds → mercator round trip (the bake reads meta.json, not the def)', () => {
  const { bounds, merc } = squareDomain({ lat: 40.444, lon: -79.99 }, 8000);
  const rect = { x0: 157, y0: 348, x1: 541, y1: 732 };
  const a = detailMercatorBBox(merc, N, N, rect);
  const b = detailMercatorBBox(boundsToMercator(bounds), N, N, rect);
  for (const k of ['xmin', 'xmax', 'ymin', 'ymax'] as const) assert.ok(Math.abs(a[k] - b[k]) < 1e-6, k);
});

test('a 4096² inset over 3 km resolves ~2.7x finer than a 4096² photo over 8 km', () => {
  const rect = detailRect(N, N, CELL, { gx: 400, gy: 540 }, 3000)!;
  const mpt = detailMetersPerTexel(rect, CELL, DETAIL_SIZE);
  const base = (N * CELL) / DETAIL_SIZE;
  assert.ok(Math.abs(mpt - 0.732) < 0.005, `${mpt} m/texel`);
  assert.ok(base / mpt > 2.5, `${(base / mpt).toFixed(2)}x finer`);
  // Finer than NAIP itself resolves would only cost bytes (artifacts/detail-imagery: detail stops below ~1 m).
  assert.ok(mpt >= DETAIL_TARGET_MPT * 0.8, `${mpt} m/texel is not wastefully fine`);
});

test('a detail quadrant stays inside the NAIP export limit', () => {
  assert.ok(DETAIL_SIZE / 2 <= NAIP_MAX_EXPORT, 'the bake stitches 2x2 quadrants');
  const { merc } = squareDomain({ lat: 40.444, lon: -79.99 }, 8000);
  const sub = detailMercatorBBox(merc, N, N, { x0: 157, y0: 348, x1: 541, y1: 732 });
  const url = naipImageryUrl(sub, DETAIL_SIZE / 2, DETAIL_SIZE / 2);
  assert.match(url, /imagery\.nationalmap\.gov/);
  assert.match(url, /size=2048,2048/);
  assert.match(url, /bboxSR=3857&imageSR=3857/);
});
