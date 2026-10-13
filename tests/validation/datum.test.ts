/**
 * Units and vertical datums (src/validation/datum.ts). A 0.3 m datum slip is the size of the errors the validation
 * measures, so every conversion path is pinned, and an unconvertible datum must be refused rather than guessed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT, numberField, US_SURVEY_FT, parseDatum, parseUnit, toMetres, toNavd88Metres } from '../../src/validation/datum';

const close = (a: number | null, b: number, eps = 1e-9) => {
  assert.ok(a !== null && Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);
};

test('feet → metres: international and U.S. survey feet', () => {
  assert.equal(FT, 0.3048);
  close(toMetres(10, 'ft'), 3.048);
  close(toMetres(10, 'usft'), (10 * 1200) / 3937);
  // The survey foot is 2 ppm longer: 0.6 mm over 1,000 ft.
  close(toMetres(1000, 'usft') - toMetres(1000, 'ft'), 1000 * (US_SURVEY_FT - FT));
  assert.ok(toMetres(1000, 'usft') - toMetres(1000, 'ft') < 0.001);
  assert.equal(toMetres(7, 'm'), 7);
});

test('an STN mark: NAVD88 feet → NAVD88 metres', () => {
  // Ian, Edison Bridge (FLLEE20980): 7.52 ft NAVD88.
  close(toNavd88Metres(7.52, 'ft', 'NAVD88'), 2.292096);
});

test('a USGS gauge reading: stage + gauge datum (both ft NAVD88)', () => {
  // French Broad River at Asheville, Helene peak: 24.82 ft on a 1949.93 ft NAVD88 datum.
  close(toNavd88Metres(24.82, 'ft', 'GAUGE', { gaugeDatumNavd88: 1949.93 * FT }), (24.82 + 1949.93) * FT);
});

test('NGVD29 converts only with a site offset (NAVD88 − NGVD29), and refuses without one', () => {
  assert.equal(toNavd88Metres(100, 'ft', 'NGVD29'), null);
  // Pittsburgh: NAVD88 is about 0.2 m below NGVD29 numerically.
  close(toNavd88Metres(100, 'ft', 'NGVD29', { navd88MinusNgvd29: -0.2 }), 30.48 - 0.2);
});

test('gauge readings without a gauge datum, unknown datums and non-finite values are refused', () => {
  assert.equal(toNavd88Metres(10, 'ft', 'GAUGE'), null);
  assert.equal(toNavd88Metres(10, 'ft', 'UNKNOWN'), null);
  assert.equal(toNavd88Metres(10, 'ft', 'EGM2008'), null);
  assert.equal(toNavd88Metres(NaN, 'ft', 'NAVD88'), null);
});

test('datum and unit spellings from STN, NFHL and NWIS', () => {
  assert.equal(parseDatum('NAVD88'), 'NAVD88');
  assert.equal(parseDatum('NAVD 88'), 'NAVD88');
  assert.equal(parseDatum('navd_88'), 'NAVD88');
  assert.equal(parseDatum('NGVD29'), 'NGVD29');
  assert.equal(parseDatum('NGVD 1929'), 'NGVD29');
  assert.equal(parseDatum('Local gage datum'), 'GAUGE');
  assert.equal(parseDatum('MSL'), 'UNKNOWN');
  assert.equal(parseDatum(undefined), 'UNKNOWN');
  assert.equal(parseUnit('Feet'), 'ft');
  assert.equal(parseUnit('US Survey Feet'), 'usft');
  assert.equal(parseUnit('Meters'), 'm');
  assert.equal(parseUnit(''), null);
});

test('downloaded numeric fields: a blank is missing, not zero (a gauge datum of 0 ft would pass every check)', () => {
  assert.ok(Number.isNaN(numberField('')));
  assert.ok(Number.isNaN(numberField('   ')));
  assert.ok(Number.isNaN(numberField(null)));
  assert.ok(Number.isNaN(numberField(undefined)));
  assert.ok(Number.isNaN(numberField('n/a')));
  assert.equal(numberField('0'), 0);
  assert.equal(numberField(' 712.4 '), 712.4);
  assert.equal(numberField(-79.99), -79.99);
});
