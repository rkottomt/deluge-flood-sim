/// <reference types="node" />
/**
 * Web Mercator math and grid ↔ geographic conversions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundsToMercator,
  cellSizeFor,
  centerOf,
  groundDistance,
  isLikelyUS,
  lonLatToMercator,
  makeGeoToGrid,
  mercatorToLonLat,
  mercatorToTile,
  roundTo16,
  squareDomain,
} from '../../src/data/geo';
import { geoToGrid, gridToGeo } from '../../src/data/index';

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} expected ${b}, got ${a} (tol ${tol})`);

test('lon/lat ↔ mercator round trip', () => {
  for (const [lon, lat] of [
    [0, 0],
    [-80.0125, 40.4417],
    [-157.8, 21.3],
    [179.9, -60],
    [-150, 64.8],
  ]) {
    const m = lonLatToMercator(lon, lat);
    const g = mercatorToLonLat(m.x, m.y);
    close(g.lon, lon, 1e-9, 'lon');
    close(g.lat, lat, 1e-9, 'lat');
  }
  // Known value: the equator/prime meridian is the origin; 180° is half the world circumference.
  close(lonLatToMercator(180, 0).x, Math.PI * 6378137, 1e-6);
});

test('squareDomain is sizeMeters on the ground and centered', () => {
  for (const c of [
    { lat: 40.4417, lon: -80.0125 },
    { lat: 29.95, lon: -90.07 },
    { lat: 61.2, lon: -149.9 },
  ]) {
    const size = 8000;
    const { bounds, merc } = squareDomain(c, size);
    const ctr = centerOf(bounds);
    close(ctr.lat, c.lat, 1e-9);
    close(ctr.lon, c.lon, 1e-9);
    // Mercator extent is square.
    close(merc.xmax - merc.xmin, merc.ymax - merc.ymin, 1e-6);
    // Ground widths measured along the center parallel/meridian ≈ size (mercator scale varies < 0.2 % over 8 km).
    const ew = groundDistance(bounds.west, c.lat, bounds.east, c.lat);
    const ns = groundDistance(c.lon, bounds.south, c.lon, bounds.north);
    close(ew / size, 1, 2e-3, 'east-west ground width');
    close(ns / size, 1, 3e-3, 'north-south ground height');
    close(cellSizeFor(bounds, 1024), size / 1024, 1e-6, 'cellSize');
  }
});

test('geoToGrid / gridToGeo: edges, centers and round trips', () => {
  const { bounds } = squareDomain({ lat: 40.4417, lon: -80.0125 }, 8000);
  const t = { nx: 1024, ny: 768, bounds };
  // Outer edges map to the domain boundary; north is gy = 0.
  const nw = geoToGrid(t, bounds.west, bounds.north);
  const se = geoToGrid(t, bounds.east, bounds.south);
  close(nw.gx, 0, 1e-6);
  close(nw.gy, 0, 1e-6);
  close(se.gx, 1024, 1e-6);
  close(se.gy, 768, 1e-6);
  // A point north of another has a smaller gy.
  assert.ok(geoToGrid(t, -80, 40.45).gy < geoToGrid(t, -80, 40.43).gy);
  // Round trips at random points.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const fast = makeGeoToGrid(t);
  for (let k = 0; k < 200; k++) {
    const gx = rnd() * 1024;
    const gy = rnd() * 768;
    const g = gridToGeo(t, gx, gy);
    const back = geoToGrid(t, g.lon, g.lat);
    close(back.gx, gx, 1e-6);
    close(back.gy, gy, 1e-6);
    const [fx, fy] = fast(g.lon, g.lat);
    close(fx, gx, 1e-6);
    close(fy, gy, 1e-6);
  }
  // Grid is linear in mercator: the mercator-center of the bounds is the grid center.
  const m = boundsToMercator(bounds);
  const c = mercatorToLonLat((m.xmin + m.xmax) / 2, (m.ymin + m.ymax) / 2);
  const cg = geoToGrid(t, c.lon, c.lat);
  close(cg.gx, 512, 1e-6);
  close(cg.gy, 384, 1e-6);
});

test('helpers: roundTo16, tiles, US coverage', () => {
  assert.equal(roundTo16(1000), 1008);
  assert.equal(roundTo16(1024), 1024);
  assert.equal(roundTo16(3), 16);
  const t = mercatorToTile(0, 0, 3);
  close(t.tx, 4, 1e-9);
  close(t.ty, 4, 1e-9);
  assert.ok(isLikelyUS(40.44, -80.0));
  assert.ok(isLikelyUS(29.95, -90.07));
  assert.ok(isLikelyUS(21.3, -157.8));
  assert.ok(!isLikelyUS(51.5, -0.12));
});
