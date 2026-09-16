import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../../src/ui/format';
import * as sc from '../../src/ui/scales';
import * as geo from '../../src/ui/geo';
import type { StageControl } from '../../src/contracts';

const T = '\u00a0';

test('clock formatting', () => {
  assert.equal(f.formatClock(0), 'T+00:00:00');
  assert.equal(f.formatClock(2 * 3600 + 13 * 60 + 40.9), 'T+02:13:40');
  assert.equal(f.formatClock(NaN), 'T+00:00:00');
  assert.match(f.formatClock(100 * 3600 + 5), /^T\+4d.04:00:05$/);
});

test('SI and unit formatting', () => {
  assert.equal(f.formatVolume(950), `950${T}m³`);
  assert.equal(f.formatVolume(12300), `12.3k${T}m³`);
  assert.equal(f.formatVolume(3.42e6), `3.42M${T}m³`);
  assert.equal(f.formatVolume(NaN), 'NaN');
  assert.equal(f.formatVolume(null), '—');
  assert.equal(f.formatPools(2500 * 1368), '1,368 Olympic pools');
  assert.equal(f.formatPools(2500), '1.0 Olympic pool');
  assert.equal(f.formatKm2(1.2345e6), `1.23${T}km²`);
  assert.equal(f.formatAcres(1e6), '247 acres');
  assert.equal(f.formatPercent(3e-5), `0.003${T}%`);
  assert.equal(f.formatPercent(0), `0.000${T}%`);
  assert.equal(f.formatPercent(Infinity), '∞');
  assert.equal(f.formatDt(0.84), `0.84${T}s`);
  assert.equal(f.formatDt(0.042), `42${T}ms`);
  assert.equal(f.formatDistance(3400), `3.4${T}km`);
  assert.equal(f.formatDistance(853), `850${T}m`);
  assert.equal(f.formatDuration(360), `6${T}min`);
  assert.equal(f.formatDuration(4320), `1${T}h 12${T}min`);
  assert.equal(f.formatLatLon(40.4417, -80.0125), '40.4417°\u00a0N, 80.0125°\u00a0W');
  assert.equal(f.formatDischarge(15000), `15.0${T}k${T}m³/s`);
  assert.equal(f.fmtNum(-1234.5, 1), '−1,234.5');
  assert.equal(f.formatSpeedup(212.4), '212×');
});

test('log scales are invertible', () => {
  for (const v of [10, 37, 250, 1000, 20000]) {
    const t = sc.logToT(v, sc.DISCHARGE_MIN, sc.DISCHARGE_MAX);
    assert.ok(Math.abs(sc.tToLog(t, sc.DISCHARGE_MIN, sc.DISCHARGE_MAX) - v) / v < 1e-9);
  }
  assert.equal(sc.tToRain(0), 0);
  assert.equal(sc.rainToT(0), 0);
  assert.equal(sc.tToRain(1), 300);
  for (const v of [0.5, 2.5, 10, 50, 100, 300]) {
    const back = sc.tToRain(sc.rainToT(v));
    assert.ok(Math.abs(back - v) / v < 0.03, `rain ${v} → ${back}`);
  }
  assert.equal(sc.niceRound(137.28), 135);
  assert.equal(sc.niceRound(1.234), 1.25);
});

test('stage feet conversions', () => {
  const ctrl: StageControl = { label: 'Point', gaugeDatum: 211.6, normalLevel: 216.4, maxOffset: 10, floodStageFt: 25, marks: [{ label: '1936 crest', ft: 46 }] };
  const ft0 = sc.stageFt(ctrl, 0);
  assert.ok(Math.abs(ft0 - 4.8 / 0.3048) < 1e-9);
  assert.ok(Math.abs(sc.offsetForFt(ctrl, 46) - (46 * 0.3048 + 211.6 - 216.4)) < 1e-9);
  assert.ok(Math.abs(sc.stageFt(ctrl, sc.offsetForFt(ctrl, 33.3)) - 33.3) < 1e-9);
  assert.equal(sc.stageStatus(ctrl, 47).severity, 'danger');
  assert.equal(sc.stageStatus(ctrl, 30).severity, 'warn');
  assert.equal(sc.stageStatus(ctrl, 20).severity, 'calm');
});

test('square footprint is square on the ground', () => {
  for (const lat of [25.76, 40.44, 61.2]) {
    const b = geo.squareFootprint(lat, -80, 8000);
    const ew = geo.haversine(lat, b.west, lat, b.east);
    const ns = geo.haversine(b.south, -80, b.north, -80);
    assert.ok(Math.abs(ew - 8000) < 80, `ew ${ew} at ${lat}`);
    assert.ok(Math.abs(ns - 8000) < 80, `ns ${ns} at ${lat}`);
    // …and square in mercator (what the map shows).
    const dx = geo.lonToMercX(b.east) - geo.lonToMercX(b.west);
    const dy = geo.latToMercY(b.north) - geo.latToMercY(b.south);
    assert.ok(Math.abs(dx - dy) < 1e-6 * dx);
  }
});

test('gridToGeoLocal maps corners and center', () => {
  const t = { nx: 1024, ny: 1024, bounds: { west: -80.06, east: -79.96, north: 40.48, south: 40.40 } };
  const nw = geo.gridToGeoLocal(t, 0, 0);
  assert.ok(Math.abs(nw.lat - 40.48) < 1e-9 && Math.abs(nw.lon + 80.06) < 1e-9);
  const se = geo.gridToGeoLocal(t, 1024, 1024);
  assert.ok(Math.abs(se.lat - 40.40) < 1e-9 && Math.abs(se.lon + 79.96) < 1e-9);
  const c = geo.gridToGeoLocal(t, 512, 512);
  assert.ok(c.lat > 40.44 && c.lat < 40.4401, `mercator center lat ${c.lat}`);
  assert.equal(geo.isLikelyUSCoverage(40.44, -80), true);
  assert.equal(geo.isLikelyUSCoverage(48.85, 2.35), false);
});
