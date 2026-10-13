/**
 * Screening and merging of USGS STN high-water marks (src/validation/hwm.ts), on real records from the Harvey and Ian
 * events (tests/fixtures/validation/stn-hwms.json, trimmed to the fields we read) plus two records marked SYNTHETIC
 * for datum paths the events in our domains never exercise.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeBySite, parseQuality, parseStnHwms, type StnHwmRecord } from '../../src/validation/hwm';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/validation/stn-hwms.json');
const records = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as StnHwmRecord[];
// The Houston preset's domain (public/presets/houston/meta.json bounds).
const houston = (lon: number, lat: number) => lon >= -95.42689 && lon <= -95.34411 && lat >= 29.72656 && lat <= 29.79843;

test('quality names map to grades', () => {
  assert.equal(parseQuality('Excellent: +/- 0.05 ft'), 'excellent');
  assert.equal(parseQuality('Fair: +/- 0.20 ft'), 'fair');
  assert.equal(parseQuality('VP: > 0.40 ft'), 'very poor');
  assert.equal(parseQuality(undefined), 'unknown');
});

test('marks outside the domain are neither accepted nor listed as rejected', () => {
  const { marks, rejected } = parseStnHwms(records, houston);
  const ids = new Set([...marks.map((m) => m.id), ...rejected.map((r) => r.id)]);
  assert.ok(!ids.has(43756), 'Fort Myers mark leaked into Houston');
  assert.ok(!ids.has(20748), 'a mark 50 km away leaked in');
});

test('accepted: surveyed peak-marking types of Fair quality or better, in NAVD88, converted to metres', () => {
  const { marks } = parseStnHwms(records, houston);
  assert.deepEqual(marks.map((m) => m.id).sort((a, b) => a - b), [23813, 23814, 34940, 34942]);
  const m = marks.find((x) => x.id === 23813)!;
  assert.equal(m.datum, 'NAVD88');
  assert.ok(Math.abs(m.elevation - 36.82 * 0.3048) < 1e-9);
  assert.equal(m.quality, 'excellent');
  assert.equal(m.environment, 'riverine');
  assert.ok(m.heightAboveGround !== null && Math.abs(m.heightAboveGround - 7.6 * 0.3048) < 1e-9);
});

test('rejected, each with its reason: Other, Poor, Very Poor, tape-downs, unsurveyed, unconvertible datum', () => {
  const { rejected } = parseStnHwms(records, houston);
  const why = Object.fromEntries(rejected.map((r) => [r.id, r.reason]));
  assert.match(why[32921], /does not mark a peak/);
  assert.match(why[25204], /quality poor/);
  assert.match(why[33426], /quality very poor/);
  assert.match(why[33487], /tape-down/);
  assert.match(why[900002], /not surveyed/);
  assert.match(why[900001], /NGVD29 cannot be converted/);
});

test('an NGVD29 mark is accepted when the site offset is known', () => {
  const { marks } = parseStnHwms(records, houston, { navd88MinusNgvd29: -0.1 });
  const m = marks.find((x) => x.id === 900001)!;
  assert.ok(Math.abs(m.elevation - (40 * 0.3048 - 0.1)) < 1e-9);
});

test('marks at one site merge into one point: median elevation, spread, best quality', () => {
  const { marks } = parseStnHwms(records, houston);
  const sites = mergeBySite(marks);
  assert.equal(sites.length, 2);
  const fannin = sites.find((s) => s.site === 'TXHAR22410')!;
  assert.equal(fannin.marks, 2);
  assert.ok(Math.abs(fannin.elevation - ((36.82 + 36.32) / 2) * 0.3048) < 1e-9);
  assert.ok(Math.abs(fannin.spread - 0.5 * 0.3048) < 1e-9);
  assert.equal(fannin.quality, 'excellent');
  assert.deepEqual(fannin.ids.sort(), [23813, 23814]);
});
