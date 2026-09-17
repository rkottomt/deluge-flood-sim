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
