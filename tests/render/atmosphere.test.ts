/** Storm atmosphere (src/render/atmosphere.ts): overcast and haze stay readable at every camera height. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ABOVE_DECK_SHARE, hazeBoost, HAZE_OVERCAST_MAX, OVERCAST_MAX, overcastFor, rainOvercast, STORM_OVERCAST_MAX } from '../../src/render/atmosphere';

test('a storm cell greys the sky at most STORM_OVERCAST_MAX, fading across its deck to a tint from above', () => {
  const deck = { base: 300, top: 1050 }; // Ellicott City's cell: deck centre ~680 m, ±373 m
  const heights = [50, 200, 300, 450, 680, 900, 1050, 1800, 5000];
  const values = heights.map((y) => overcastFor(0, 110, y, deck));
  for (const v of values) assert.ok(v <= STORM_OVERCAST_MAX + 1e-9, `overcast ${v}`);
  assert.ok(Math.abs(values[0] - STORM_OVERCAST_MAX) < 1e-9, 'full storm overcast under the deck');
  assert.ok(Math.abs(values[values.length - 1] - STORM_OVERCAST_MAX * ABOVE_DECK_SHARE) < 1e-9, 'a tint from above');
  for (let k = 1; k < values.length; k++) assert.ok(values[k] <= values[k - 1] + 1e-12, 'never darker as the camera rises');
  // Inside the deck it is in between, not a jump at its middle.
  const mid = overcastFor(0, 110, 680, deck);
  assert.ok(mid > STORM_OVERCAST_MAX * ABOVE_DECK_SHARE + 0.05 && mid < STORM_OVERCAST_MAX - 0.05, `mid-deck ${mid}`);
  // Light storm rain greys less; no rain, no overcast.
  assert.ok(overcastFor(0, 5, 100, deck) < overcastFor(0, 60, 100, deck));
  assert.equal(overcastFor(0, 0, 100, deck), 0);
});

test('global rain keeps its storm sky; combined rain never passes OVERCAST_MAX; haze thickening is capped', () => {
  assert.ok(Math.abs(overcastFor(100, 0, 500, null) - OVERCAST_MAX) < 1e-9);
  assert.ok(overcastFor(100, 110, 100, { base: 300, top: 1000 }) <= OVERCAST_MAX + 1e-9);
  assert.ok(rainOvercast(0.2) === 0);
  assert.equal(hazeBoost(0), 1);
  assert.equal(hazeBoost(OVERCAST_MAX), hazeBoost(HAZE_OVERCAST_MAX));
  assert.ok(hazeBoost(HAZE_OVERCAST_MAX) <= 1.75);
});

// ── Sun and sky (analytic model) ────────────────────────────────────────────────────────────────

import {
  airMass,
  DEFAULT_SUN_AZIMUTH,
  DEFAULT_SUN_ELEVATION,
  imageryRelightFactor,
  LIGHTING_PRESETS,
  lightingPreset,
  skyColors,
  sunDirection,
  sunLowness,
  sunTransmittance,
} from '../../src/render/atmosphere';

test('air mass is 1 overhead and grows the way Kasten–Young says it does', () => {
  assert.ok(Math.abs(airMass(90) - 1) < 1e-3);
  assert.ok(Math.abs(airMass(30) - 2) < 0.03, `30° → ${airMass(30)}`);
  assert.ok(airMass(5) > 10 && airMass(5) < 11, `5° → ${airMass(5)}`);
  assert.ok(airMass(0) > 30, `horizon → ${airMass(0)}`);
  for (let el = 1; el < 90; el++) assert.ok(airMass(el) <= airMass(el - 1), 'monotone');
});

test('the beam reddens as it drops: blue is scattered out first, red last', () => {
  const noon = sunTransmittance(90);
  const low = sunTransmittance(8);
  assert.ok(Math.abs(noon[0] - 1) < 1e-6 && noon[0] >= noon[1] && noon[1] >= noon[2], 'normalised, red-first');
  assert.ok(low[1] < noon[1] && low[2] < noon[2], 'green and blue are stripped as the path lengthens');
  assert.ok(low[2] < 0.3, `a low sun should be strongly orange, blue ${low[2]}`);
  assert.ok(low[2] < low[1] && low[1] < low[0], 'the ordering never inverts');
});

test('the default sun is exactly the shipped one, so daylight does not shift', () => {
  const d = sunDirection(DEFAULT_SUN_AZIMUTH, DEFAULT_SUN_ELEVATION);
  const az = (DEFAULT_SUN_AZIMUTH * Math.PI) / 180;
  const el = (DEFAULT_SUN_ELEVATION * Math.PI) / 180;
  assert.ok(Math.abs(d[0] - Math.cos(el) * Math.sin(az)) < 1e-12);
  assert.ok(Math.abs(d[1] - Math.sin(el)) < 1e-12);
  assert.ok(Math.abs(d[2] + Math.cos(el) * Math.cos(az)) < 1e-12);
  assert.ok(Math.abs(Math.hypot(d[0], d[1], d[2]) - 1) < 1e-12, 'unit length');

  const sky = skyColors(DEFAULT_SUN_ELEVATION);
  // The values the renderer shipped with, before any of this existed.
  assert.deepEqual(
    sky.zenith.map((v) => +v.toFixed(4)),
    [0.15, 0.33, 0.78],
  );
  assert.deepEqual(
    sky.horizon.map((v) => +v.toFixed(4)),
    [0.66, 0.78, 0.94],
  );
  assert.deepEqual(
    sky.sun.map((v) => +v.toFixed(3)),
    [3.1, 2.883, 2.48],
  );
  assert.deepEqual(sky.sunTint, sky.horizon, 'no warm band with the sun high');
  assert.equal(sunLowness(DEFAULT_SUN_ELEVATION), 0);
  assert.equal(imageryRelightFactor(DEFAULT_SUN_ELEVATION), 1);
});

test('a low sun warms the horizon around it, deepens the zenith and never goes negative', () => {
  const low = skyColors(8);
  const noon = skyColors(DEFAULT_SUN_ELEVATION);
  assert.ok(low.sunTint[0] > low.horizon[0] * 1.5, 'the band around the sun is much redder than the sky away from it');
  assert.ok(low.sunTint[0] > low.sunTint[2] * 2.5, 'and it is warm, not merely bright');
  assert.ok(low.zenith[2] < noon.zenith[2], 'the zenith deepens');
  assert.ok(low.sun[0] / low.sun[2] > noon.sun[0] / noon.sun[2] * 2, 'the beam reddens');
  for (const c of [low.zenith, low.horizon, low.sunTint, low.sun]) {
    for (const v of c) assert.ok(Number.isFinite(v) && v >= 0, `channel ${v}`);
  }
  // Below the horizon everything fades out instead of flipping sign.
  const night = skyColors(-4);
  for (const v of night.sun) assert.ok(v >= 0 && v < 0.2, `beam after sunset ${v}`);
  assert.ok(sunLowness(8) > 0.8 && sunLowness(8) <= 1);
});

test('imagery is relit relative to the sun the photograph was taken under', () => {
  // Flat ground keeps (most of) its reference illumination whatever the sun does — that is the whole point.
  for (const el of [5, 8, 12, 20, 30, 40]) {
    const k = imageryRelightFactor(el);
    const flat = Math.max(Math.sin((el * Math.PI) / 180), 0.2);
    const reference = Math.sin((DEFAULT_SUN_ELEVATION * Math.PI) / 180);
    const kept = (flat * k) / reference;
    assert.ok(kept > 0.75 && kept <= 1.0001, `at ${el}° flat ground keeps ${(kept * 100).toFixed(0)}% of its light`);
  }
  assert.ok(imageryRelightFactor(75) < 1, 'a higher sun than the reference is normalised down, not up');
  assert.ok(Number.isFinite(imageryRelightFactor(0)) && Number.isFinite(imageryRelightFactor(-5)));
});

test('every lighting preset is a usable, clamped set of settings', () => {
  for (const [name, p] of Object.entries(LIGHTING_PRESETS)) {
    assert.ok(p.elevationDeg > 0 && p.elevationDeg < 90, `${name} elevation`);
    assert.ok(p.azimuthDeg >= 0 && p.azimuthDeg < 360, `${name} azimuth`);
    for (const k of ['shadowStrength', 'aoStrength', 'reliefStrength'] as const) {
      assert.ok(p[k] >= 0 && p[k] <= 1, `${name}.${k} = ${p[k]}`);
    }
  }
  assert.deepEqual(lightingPreset('daylight'), LIGHTING_PRESETS.daylight);
  assert.deepEqual(lightingPreset('no such preset'), LIGHTING_PRESETS.daylight, 'unknown names fall back to daylight');
  assert.deepEqual(lightingPreset(undefined), LIGHTING_PRESETS.daylight);
  // A copy, so a caller cannot mutate the shared preset table.
  const a = lightingPreset('goldenHour');
  a.elevationDeg = 99;
  assert.notEqual(LIGHTING_PRESETS.goldenHour.elevationDeg, 99);
});
