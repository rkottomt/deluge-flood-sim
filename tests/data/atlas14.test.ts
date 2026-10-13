/// <reference types="node" />
/**
 * NOAA Atlas 14 rain return periods (src/data/atlas14.ts): the PFDS point-answer parser on real captured responses
 * (tests/fixtures/atlas14/pfds-*.txt, fetched from hdsc.nws.noaa.gov in October 2026) and on malformed / hostile
 * variants; the baked same-origin grid (public/atlas14/pf60m-pds.bin) against those PFDS answers; and the grid
 * decoder on truncated, oversized, lying and gzip-bomb inputs. No network: fetch is faked where it is needed.
 *
 * Run: node --import tsx --test tests/data/atlas14.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';
import {
  ATLAS14_ARIS,
  ATLAS14_LIMITS,
  ATLAS14_MAX_DOWNLOAD,
  decodeAtlas14Grid,
  encodeAtlas14Grid,
  gunzipCapped,
  loadAtlas14Grid,
  lookupAtlas14,
  parsePfdsResponse,
  pfdsOneHour,
  PFDS_MAX_BYTES,
  resetAtlas14Cache,
  type Atlas14Grid,
} from '../../src/data/atlas14';
import { HttpError, MB } from '../../src/data/net';

const fixture = (name: string) => readFileSync(new URL(`../fixtures/atlas14/pfds-${name}.txt`, import.meta.url), 'utf8');
const shipped = () => readFileSync(new URL('../../public/atlas14/pf60m-pds.bin', import.meta.url));

/** The points the fixtures were captured at (scripts/bake-atlas14.ts VERIFY_POINTS). */
const POINTS: Record<string, [number, number]> = {
  houston: [29.7604, -95.3698],
  asheville: [35.5951, -82.5515],
  denver: [39.7392, -104.9903],
  phoenix: [33.4484, -112.074],
  losangeles: [34.0522, -118.2437],
  missoula: [46.8721, -113.994],
  miami: [25.7617, -80.1918],
  boston: [42.3601, -71.0589],
  honolulu: [21.3069, -157.8583],
  sanjuan: [18.4655, -66.1057],
  anchorage: [61.2181, -149.9003],
};

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

// ─── PFDS point answers ─────────────────────────────────────────────────────────────────────────────────────────────

test('PFDS: the real Houston answer parses to the published 1-hour intensities', () => {
  const r = parsePfdsResponse(fixture('houston'), { lat: 29.7604, lon: -95.3698 });
  assert.ok(r.covered);
  if (!r.covered) return;
  assert.equal(r.region, 'Texas');
  assert.equal(r.volume, 11);
  assert.equal(r.version, 2);
  assert.equal(r.quantiles.length, 19);
  assert.ok(r.quantiles.every((row) => row.length === 10));
  // 60-min row, 2/10/25/100/500-yr, mm/h — as printed in the response.
  assert.deepEqual(pfdsOneHour(r), [57, 82, 98, 123, 162]);
  // Confidence bounds bracket the estimate.
  for (let d = 0; d < 19; d++) for (let a = 0; a < 10; a++) assert.ok(r.lower[d][a] <= r.quantiles[d][a] && r.quantiles[d][a] <= r.upper[d][a]);
});

test('PFDS: every captured answer parses, and intensities rise with return period', () => {
  for (const [name, [lat, lon]] of Object.entries(POINTS)) {
    const r = parsePfdsResponse(fixture(name), { lat, lon });
    assert.ok(r.covered, name);
    if (!r.covered) continue;
    const v = pfdsOneHour(r);
    for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1], `${name}: ${v.join('/')}`);
    assert.ok(r.region.length > 0 && r.region.length <= 60);
  }
});

test('PFDS: "not within a project area" (Seattle, London) is covered: false, not an error', () => {
  assert.deepEqual(parsePfdsResponse(fixture('seattle'), { lat: 47.6062, lon: -122.3321 }), { covered: false });
  assert.deepEqual(parsePfdsResponse(fixture('london'), { lat: 51.5, lon: -0.12 }), { covered: false });
});

test('PFDS: hostile and malformed answers are refused', () => {
  const good = fixture('houston');
  const at = { lat: 29.7604, lon: -95.3698 };
  const cases: Array<[string, string | Uint8Array]> = [
    ['empty', ''],
    ['HTML error page', '<!DOCTYPE HTML><html><head><title>500 Internal Server Error</title></head></html>'],
    ['oversized', good + ' '.repeat(PFDS_MAX_BYTES)],
    ['a different place', good.replace("lat = '29.7604';", "lat = '40.0000';")],
    ['a different series', good.replace("ser = 'pds';", "ser = 'ams';")],
    ['different units', good.replace("unit = 'metric';", "unit = 'english';")],
    ['depth, not intensity', good.replace("datatype = 'intensity';", "datatype = 'depth';")],
    ['unknown result', good.replace("result = 'values';", "result = 'maybe';")],
    ['script in a value', good.replace("['48', '57',", "['<script>alert(1)</script>', '57',")],
    ['exponent', good.replace("['48', '57',", "['4.8e1', '57',")],
    ['negative', good.replace("['48', '57',", "['-48', '57',")],
    ['NaN', good.replace("['48', '57',", "['NaN', '57',")],
    ['unquoted', good.replace("['48', '57',", "[48, '57',")],
    ['a row too short', good.replace("['48', '57', ", "['57', ")],
    ['a row missing', good.replace(/\['152', [^\]]*\], /, '')],
    ['no quantiles', good.replace(/^quantiles = .*$/m, '')],
    ['eval-able code', good.replace(/^quantiles = .*$/m, "quantiles = __import__('os').system('x');")],
    ['control characters', good.replace("region = 'Texas';", "region = 'Te\u0007xas';")],
    ['bad UTF-8', new Uint8Array([...new TextEncoder().encode(good.slice(0, 100)), 0xff, 0xfe, 0xfd])],
    ['bad volume', good.replace("volume = '11';", "volume = '999';")],
  ];
  for (const [label, body] of cases) {
    assert.throws(() => parsePfdsResponse(body, at), /PFDS/, label);
  }
  // A crafted region name is cut down to plain characters, never markup.
  const r = parsePfdsResponse(good.replace("region = 'Texas';", "region = 'Texas<img src=x onerror=1>';"), at);
  assert.ok(r.covered && !/[<>=]/.test(r.region), r.covered ? r.region : '');
});

// ─── The baked grid ─────────────────────────────────────────────────────────────────────────────────────────────────

let gridCache: Atlas14Grid | null = null;
const grid = () => (gridCache ??= decodeAtlas14Grid(zlib.gunzipSync(shipped())));

test('grid: the shipped file is gzip, under 1 MB, and decodes with the expected return periods and tiles', () => {
  const gz = shipped();
  assert.equal(gz[0], 0x1f);
  assert.equal(gz[1], 0x8b);
  assert.ok(gz.byteLength < MB && gz.byteLength <= ATLAS14_MAX_DOWNLOAD, `${gz.byteLength} bytes`);
  const g = grid();
  assert.deepEqual(g.aris, [...ATLAS14_ARIS]);
  assert.equal(g.tiles.length, 4, 'CONUS, Alaska, Hawaii, Puerto Rico');
});

test('grid: matches the PFDS point answers within 5 % at every captured point', () => {
  for (const [name, [lat, lon]] of Object.entries(POINTS)) {
    const r = parsePfdsResponse(fixture(name), { lat, lon });
    assert.ok(r.covered);
    if (!r.covered) continue;
    const want = pfdsOneHour(r);
    const got = lookupAtlas14(grid(), lat, lon);
    assert.ok(got, `${name}: no grid value`);
    got!.levels.forEach((l, i) => {
      // PFDS prints whole mm/h, so allow its rounding on top of 5 %.
      assert.ok(Math.abs(l.mmPerHour - want[i]) <= 0.05 * want[i] + 0.5, `${name} ${l.ari}-yr: grid ${l.mmPerHour.toFixed(1)} vs PFDS ${want[i]}`);
    });
  }
});

test('grid: no value outside Atlas 14 — western Washington, the ocean, abroad, bad input', () => {
  for (const [lat, lon] of [
    [47.6062, -122.3321], // Seattle (NOAA Atlas 2 still)
    [45.5152, -122.6784], // Portland OR
    [35, -60], // Atlantic
    [51.5, -0.12], // London
    [27.7, 85.3], // Kathmandu
    [NaN, -95],
    [29.76, Infinity],
    [95, -95],
  ]) {
    assert.equal(lookupAtlas14(grid(), lat, lon), null, `${lat}, ${lon}`);
  }
});

/** A small valid grid for the hostile variants. */
function tinyGrid(): Atlas14Grid {
  const n = 4;
  return {
    aris: [2, 10, 100],
    tiles: [{ south: 29, west: -96, step: 0.5, nlat: 2, nlon: 2, values: [new Float32Array(n).fill(50), new Float32Array(n).fill(80), new Float32Array(n).fill(120)] }],
  };
}

test('grid: round-trips, and interpolates between cell centres', () => {
  const g = tinyGrid();
  g.tiles[0].values[0].set([40, 60, 40, 60]); // west column 40, east column 60
  const d = decodeAtlas14Grid(encodeAtlas14Grid(g));
  assert.deepEqual(d.aris, [2, 10, 100]);
  const mid = lookupAtlas14(d, 29.5, -95.5); // halfway between the column centres
  assert.ok(mid && Math.abs(mid.levels[0].mmPerHour - 50) < 0.01, JSON.stringify(mid));
  assert.equal(lookupAtlas14(d, 31, -95.5), null, 'outside the tile');
});

test('grid: structurally hostile files are refused', () => {
  const ok = encodeAtlas14Grid(tinyGrid());
  const mutate = (fn: (b: Uint8Array, dv: DataView) => void) => {
    const b = ok.slice();
    fn(b, new DataView(b.buffer));
    return b;
  };
  const cases: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array(0)],
    ['bad magic', mutate((b) => (b[0] = 0x58))],
    ['truncated', ok.slice(0, ok.length - 1)],
    ['trailing bytes', new Uint8Array([...ok, 0])],
    ['zero return periods', mutate((_b, dv) => dv.setUint16(8, 0, true))],
    ['too many return periods', mutate((_b, dv) => dv.setUint16(8, 999, true))],
    ['too many tiles', mutate((_b, dv) => dv.setUint16(10, 999, true))],
    ['return periods out of order', mutate((_b, dv) => dv.setUint16(14, 1, true))],
    ['a tile off the globe', mutate((_b, dv) => dv.setInt32(18, 2_000_000_000, true))],
    ['a giant tile', mutate((_b, dv) => dv.setUint16(30, 65535, true))],
    ['zero step', mutate((_b, dv) => dv.setInt32(26, 0, true))],
    ['over the size cap', new Uint8Array(ATLAS14_LIMITS.maxBytes + 1)],
  ];
  for (const [label, bytes] of cases) assert.throws(() => decodeAtlas14Grid(bytes), /Atlas 14 grid/, label);
});

test('grid: out-of-range or decreasing cells are dropped, never trusted', () => {
  const g = tinyGrid();
  g.tiles[0].values[2][0] = 30; // 100-yr below 10-yr
  g.tiles[0].values[1][1] = 900; // impossible intensity (and above 100-yr)
  const d = decodeAtlas14Grid(encodeAtlas14Grid(g));
  const v = d.tiles[0].values;
  assert.ok(Number.isNaN(v[0][0]) && Number.isNaN(v[1][0]) && Number.isNaN(v[2][0]), 'cell 0 dropped whole');
  assert.ok(Number.isNaN(v[1][1]) && Number.isNaN(v[0][1]), 'cell 1 dropped whole');
  assert.equal(v[0][2], 50);
});

test('grid: a gzip bomb stops at the inflate cap; plain bytes pass through', async () => {
  // 64 MB of zeroes compresses to ~64 kB.
  const bomb = zlib.gzipSync(Buffer.alloc(64 * MB), { level: 9 });
  assert.ok(bomb.byteLength < MB);
  await assert.rejects(() => gunzipCapped(new Uint8Array(bomb)), /inflates past its size limit/);
  await assert.rejects(() => gunzipCapped(new Uint8Array([0x1f, 0x8b, 8, 0, 1, 2, 3])), /corrupt compressed data/);
  const plain = encodeAtlas14Grid(tinyGrid());
  assert.equal(await gunzipCapped(plain), plain);
});

test('grid download: an endless or oversized answer is cut off and not retried; a good one loads once', async () => {
  resetAtlas14Cache();
  let attempts = 0;
  const endless = (() => {
    attempts++;
    const body = new ReadableStream<Uint8Array>({ pull: (c) => c.enqueue(new Uint8Array(256 * 1024)) });
    return Promise.resolve(new Response(body));
  }) as typeof fetch;
  const err = await withFetch(endless, () => loadAtlas14Grid('https://example.test/a.bin').then(() => null, (e: Error) => e));
  assert.ok(err instanceof HttpError && err.status === 413, `${err}`);
  assert.equal(attempts, 1);
  // A bomb on the wire: small download, refused while inflating.
  resetAtlas14Cache();
  const bomb = zlib.gzipSync(Buffer.alloc(32 * MB));
  const e2 = await withFetch((() => Promise.resolve(new Response(bomb))) as typeof fetch, () => loadAtlas14Grid('https://example.test/b.bin').then(() => null, (e: Error) => e));
  assert.match(String(e2), /inflates past its size limit/);
  // The real file, served from "our origin".
  resetAtlas14Cache();
  let calls = 0;
  const real = (() => {
    calls++;
    return Promise.resolve(new Response(shipped()));
  }) as typeof fetch;
  const g = await withFetch(real, () => loadAtlas14Grid('https://example.test/c.bin'));
  const again = await withFetch(real, () => loadAtlas14Grid('https://example.test/c.bin'));
  assert.equal(g, again);
  assert.equal(calls, 1, 'downloaded once per page');
  resetAtlas14Cache();
});
