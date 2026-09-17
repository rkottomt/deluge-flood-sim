import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as f from '../../src/ui/format';
import * as sc from '../../src/ui/scales';
import * as geo from '../../src/data/geo';
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

/** Haversine distance in meters (independent check of the mercator math the picker relies on). */
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const D = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * D) / 2) ** 2 + Math.cos(lat1 * D) * Math.cos(lat2 * D) * Math.sin(((lon2 - lon1) * D) / 2) ** 2;
  return 2 * 6378137 * Math.asin(Math.min(1, Math.sqrt(a)));
}

test('picker footprint (data squareDomain) is square on the ground and on the map', () => {
  for (const lat of [25.76, 40.44, 61.2]) {
    const b = geo.squareDomain({ lat, lon: -80 }, 8000).bounds;
    const ew = haversine(lat, b.west, lat, b.east);
    const ns = haversine(b.south, -80, b.north, -80);
    assert.ok(Math.abs(ew - 8000) < 80, `ew ${ew} at ${lat}`);
    assert.ok(Math.abs(ns - 8000) < 80, `ns ${ns} at ${lat}`);
    // …and square in mercator (what the map shows).
    const sw = geo.lonLatToMercator(b.west, b.south);
    const ne = geo.lonLatToMercator(b.east, b.north);
    assert.ok(Math.abs(ne.x - sw.x - (ne.y - sw.y)) < 1e-6 * (ne.x - sw.x));
  }
});

test('probe lat/lon (data gridToGeo) maps corners and center; one US coverage check', () => {
  const t = { nx: 1024, ny: 1024, bounds: { west: -80.06, east: -79.96, north: 40.48, south: 40.40 } };
  const nw = geo.gridToGeo(t, 0, 0);
  assert.ok(Math.abs(nw.lat - 40.48) < 1e-9 && Math.abs(nw.lon + 80.06) < 1e-9);
  const se = geo.gridToGeo(t, 1024, 1024);
  assert.ok(Math.abs(se.lat - 40.40) < 1e-9 && Math.abs(se.lon + 79.96) < 1e-9);
  const c = geo.gridToGeo(t, 512, 512);
  assert.ok(c.lat > 40.44 && c.lat < 40.4401, `mercator center lat ${c.lat}`);
  assert.equal(geo.isLikelyUS(40.44, -80), true);
  assert.equal(geo.isLikelyUS(48.85, 2.35), false);
});

test('runaway values stay compact (stability demo)', () => {
  assert.equal(f.formatSpeed(488.23), `488${T}m/s`);
  assert.equal(f.formatSpeed(3.4e6), `3.4e6${T}m/s`);
  assert.equal(f.formatMeters(2.5e7), `2.5e7${T}m`);
  assert.equal(f.formatMeters(61.04), `61.0${T}m`);
});

test('tick labels: centered when roomy, re-anchored or staggered when crowded', async () => {
  const { layoutTickLabels } = await import('../../src/ui/tickLayout');
  const spans = (W: number, labels: Array<{ t: number; width: number }>) =>
    layoutTickLabels(W, labels).map((p, i) => ({ row: p.row, l: labels[i].t * W + p.dx, r: labels[i].t * W + p.dx + labels[i].width }));
  const noOverlap = (s: Array<{ row: number; l: number; r: number }>) => {
    for (let i = 0; i < s.length; i++)
      for (let j = i + 1; j < s.length; j++)
        if (s[i].row === s[j].row) assert.ok(s[i].r <= s[j].l || s[j].r <= s[i].l, `labels ${i} and ${j} overlap`);
  };
  // Roomy: every label centered on its tick, single row.
  const roomy = layoutTickLabels(300, [{ t: 0.2, width: 30 }, { t: 0.5, width: 30 }, { t: 0.8, width: 30 }]);
  assert.deepEqual(roomy.map((p) => p.row), [0, 0, 0]);
  assert.ok(roomy.every((p) => Math.abs(p.dx + 15) < 1e-9));
  // Rain slider (Light/Heavy/Extreme/Harvey): the close Extreme–Harvey pair is re-anchored on one row.
  const rain = [
    { t: 0.278, width: 28 },
    { t: 0.487, width: 32 },
    { t: 0.73, width: 45 },
    { t: 0.834, width: 38 },
  ];
  const r = spans(280, rain);
  noOverlap(r);
  assert.deepEqual(r.map((x) => x.row), [0, 0, 0, 0]);
  // Hopelessly crowded: falls back to a second row, still without same-row overlaps.
  const crowded = spans(200, [{ t: 0.5, width: 60 }, { t: 0.52, width: 60 }, { t: 0.54, width: 60 }]);
  noOverlap(crowded.slice(0, 2));
  assert.equal(crowded[1].row, 1);
  // Labels stay within the strip (±8 px inset margin).
  for (const x of spans(200, [{ t: 0, width: 50 }, { t: 1, width: 50 }])) assert.ok(x.l >= -8 && x.r <= 208);
});

test('evacuation card text drops what the card already shows', async () => {
  const { routeDetail, blockedAdvice } = await import('../../src/ui/routeText');
  assert.equal(
    routeDetail('Via I-279 → Penn Lincoln Pkwy to Mount Washington — Grandview Ave — 2.9 km, 3 min', 'Mount Washington — Grandview Ave'),
    'Via I-279 → Penn Lincoln Pkwy',
  );
  assert.equal(
    routeDetail('Route to Cathedral of Learning — 850 m, < 1 min (120 m through shallow water — drive slowly)', 'Cathedral of Learning'),
    '120 m through shallow water — drive slowly',
  );
  assert.equal(routeDetail('Via Liberty Ave to Pitt — 3.4 km, 1 h 05 min', 'Pitt'), 'Via Liberty Ave');
  assert.equal(routeDetail('Via Forbes Ave and Boulevard of the Allies — avoid Smithfield St (flooded).', 'X'), 'Via Forbes Ave and Boulevard of the Allies — avoid Smithfield St (flooded).');
  assert.equal(routeDetail('', 'X'), '');
  assert.equal(blockedAdvice('No safe route — every shelter is flooded. Shelter in place on higher floors.'), 'Every shelter is flooded. Shelter in place on higher floors.');
  assert.match(blockedAdvice(undefined), /Shelter in place/);
});

test('astronomical values from a blown-up solver stay short', () => {
  assert.equal(f.formatVolume(-1.285139299216e18), `−1.3e18${T}m³`);
  assert.equal(f.formatPools(-5.14e20), '−2.1e17 Olympic pools');
  assert.equal(f.formatKm2(3e24), `3.0e18${T}km²`);
  assert.ok(f.formatAcres(3e24).length < 16);
});
