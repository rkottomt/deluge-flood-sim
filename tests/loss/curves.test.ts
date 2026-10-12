/**
 * JRC depth–damage curves (src/loss/curves.ts) reproduce the spreadsheet, interpolate linearly and never fall.
 * Run: node --import tsx --test tests/loss/curves.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  curveFor,
  damageFraction,
  damageSigma,
  DEFAULT_CURVE_SIGMA,
  interpTable,
  JRC_CURVES,
  JRC_DEPTHS,
  usaceDamageUnverified,
  USE_US_DETAIL_CURVES,
  type Continent,
  type CurveClass,
} from '../../src/loss/curves';
import { regionAt, regionForBounds } from '../../src/loss/region';

/** Rows of the research spec's §C.1 tables, copied by hand from the document (a second transcription to diff). */
const SPEC: Array<[CurveClass, Continent, number[]]> = [
  ['residential', 'europe', [0, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.95, 1]],
  ['residential', 'northAmerica', [0.2018, 0.4433, 0.5828, 0.6825, 0.784, 0.8543, 0.9237, 0.9585, 1]],
  ['residential', 'asia', [0, 0.3266, 0.4941, 0.6166, 0.7207, 0.8695, 0.9315, 0.9836, 1]],
  ['commercial', 'northAmerica', [0.0184, 0.2393, 0.3742, 0.4663, 0.5521, 0.6871, 0.8221, 0.908, 1]],
  ['commercial', 'asia', [0, 0.3768, 0.5377, 0.6593, 0.7628, 0.8833, 0.9419, 0.9808, 1]],
  ['commercial', 'global', [0, 0.3233, 0.5065, 0.6346, 0.7443, 0.8641, 0.9328, 0.9777, 1]],
  ['industrial', 'northAmerica', [0.0257, 0.3229, 0.5114, 0.6371, 0.74, 0.86, 0.9371, 0.98, 1]],
  ['industrial', 'asia', [0, 0.2832, 0.4816, 0.6292, 0.7172, 0.8567, 0.9086, 0.9553, 1]],
  ['industrial', 'africa', [0, 0.0627, 0.2472, 0.4033, 0.4945, 0.6847, 0.9186, 1, 1]],
  ['transport', 'global', [0, 0.254, 0.4297, 0.6772, 0.8403, 1, 1, 1, 1]],
  ['roads', 'asia', [0, 0.2144, 0.3728, 0.6039, 0.7097, 0.8084, 0.8872, 0.9688, 1]],
  ['agriculture', 'northAmerica', [0.0186, 0.2678, 0.4737, 0.5506, 0.6022, 0.7601, 0.8741, 0.9541, 1]],
];

test('the tabulated values are reproduced at every tabulated depth (> 0)', () => {
  for (const [cls, cont, row] of SPEC) {
    const c = curveFor(cls, cont);
    assert.equal(c.continent, cont);
    assert.equal(c.fallback, false);
    JRC_DEPTHS.forEach((d, i) => {
      if (d === 0) return; // dry is 0 by definition (below)
      assert.ok(Math.abs(damageFraction(c, d) - row[i]) < 1e-12, `${cls}/${cont} at ${d} m`);
    });
  }
});

test('every curve has 9 values in [0, 1], ends at 1 and never decreases', () => {
  for (const [cls, table] of Object.entries(JRC_CURVES)) {
    for (const [cont, v] of Object.entries(table)) {
      assert.equal(v!.length, JRC_DEPTHS.length, `${cls}/${cont}`);
      assert.equal(v![v!.length - 1], 1, `${cls}/${cont} ends at 1`);
      for (let i = 0; i < v!.length; i++) {
        assert.ok(v![i] >= 0 && v![i] <= 1);
        if (i) assert.ok(v![i] >= v![i - 1], `${cls}/${cont} monotone at ${JRC_DEPTHS[i]} m`);
      }
      // …and so does the interpolant, sampled finely.
      const c = curveFor(cls as CurveClass, cont as Continent);
      let prev = 0;
      for (let d = 0.01; d <= 7; d += 0.01) {
        const f = damageFraction(c, d);
        assert.ok(f >= prev - 1e-12, `${cls}/${cont} interpolant falls at ${d.toFixed(2)} m`);
        prev = f;
      }
    }
  }
});

test('interpolation is linear between depths, 0 when dry, flat beyond 6 m', () => {
  const na = curveFor('industrial', 'northAmerica');
  // The spec's Houston warehouse example (§E.4): 0.15 m → 0.115, 0.4 m → 0.263, 0.8 m → 0.436, 1.5 m → 0.637.
  assert.ok(Math.abs(damageFraction(na, 0.15) - 0.11486) < 1e-4);
  assert.ok(Math.abs(damageFraction(na, 0.4) - 0.26346) < 1e-4);
  assert.ok(Math.abs(damageFraction(na, 0.8) - 0.4360) < 1e-4);
  assert.equal(damageFraction(na, 1.5), 0.6371);
  // North-American residential is non-zero at 0 m in the table, but a dry building loses nothing.
  const res = curveFor('residential', 'northAmerica');
  assert.equal(damageFraction(res, 0), 0);
  assert.equal(damageFraction(res, -1), 0);
  assert.equal(damageFraction(res, NaN), 0);
  assert.ok(damageFraction(res, 1e-6) > 0.2);
  assert.equal(damageFraction(res, 12), 1);
  assert.equal(interpTable([0, 1], 0.25, [0, 1]), 0.25);
});

test('missing continents fall back to GLOBAL, then EUROPE', () => {
  const c = curveFor('commercial', 'africa');
  assert.equal(c.continent, 'global');
  assert.ok(c.fallback);
  const r = curveFor('residential', 'global');
  assert.equal(r.continent, 'europe');
  const roads = curveFor('roads', 'northAmerica');
  assert.equal(roads.continent, 'global');
});

test('sigma: the extracted Asia residential spread, else the documented placeholder', () => {
  const asia = curveFor('residential', 'asia');
  assert.equal(damageSigma(asia, 0.5), 0.25);
  assert.equal(damageSigma(asia, 6), 0);
  assert.equal(damageSigma(asia, 0), 0);
  assert.equal(damageSigma(curveFor('residential', 'northAmerica'), 2), 0.15);
  assert.equal(damageSigma(curveFor('industrial', 'northAmerica'), 1), DEFAULT_CURVE_SIGMA);
});

test('the unverified USACE curves stay off unless explicitly allowed', () => {
  assert.equal(USE_US_DETAIL_CURVES, false);
  assert.throws(() => usaceDamageUnverified('oneStoryNoBasementStructure', 2, false));
  assert.ok(Math.abs(usaceDamageUnverified('oneStoryNoBasementStructure', 2, true) - 0.321) < 1e-9);
  assert.ok(Math.abs(usaceDamageUnverified('oneStoryNoBasementStructure', 2.5, true) - 0.361) < 1e-9);
  assert.equal(usaceDamageUnverified('oneStoryNoBasementStructure', -3, true), 0);
});

test('regions: US presets get US costs and North-American curves; Nepal gets Nepal costs and Asian curves', () => {
  const pgh = regionForBounds({ west: -80.05, south: 40.41, east: -79.96, north: 40.48 });
  assert.equal(pgh.costCountry, 'US');
  assert.equal(pgh.continent, 'northAmerica');
  const nepal = regionForBounds({ west: 85.1453, south: 27.954, east: 85.2267, north: 28.0259 });
  assert.equal(nepal.costCountry, 'NP');
  assert.equal(nepal.continent, 'asia');
  assert.equal(regionAt(77.2, 28.6).costCountry, 'IN'); // Delhi
  assert.equal(regionAt(-157.85, 21.3).costCountry, 'US'); // Honolulu
  const paris = regionAt(2.35, 48.85);
  assert.equal(paris.costCountry, null);
  assert.equal(paris.continent, 'europe');
});
