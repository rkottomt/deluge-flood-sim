/**
 * Post chain CPU mirror: hazard colours are solved so the tone-mapped result is the legend colour, without
 * blooming, and every legend colour is one the tone mapper can actually reproduce.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOOM_THRESHOLD, HAZARD_MAX_PEAK, hazardInput, linearToSrgb, postProcess, type RGB } from '../../src/render/tonemap';
import { cssToLinear, DEPTH_BANDS, MAX_DEPTH_BANDS, NORMAL_WATER_LEGEND, VELOCITY_BANDS } from '../../src/render/legend';
import { TONEMAP_WGSL } from '../../src/render/shaders/post';

const srgbErr = (a: RGB, b: RGB) => Math.max(...[0, 1, 2].map((k) => Math.abs(linearToSrgb(a[k]) - linearToSrgb(b[k])) * 255));

test('every hazard legend colour tone-maps back to itself under the bloom threshold', () => {
  assert.ok(HAZARD_MAX_PEAK < BLOOM_THRESHOLD);
  // The slowest speed band is drawn as plain water, not in its swatch colour.
  const bands = [...DEPTH_BANDS, ...MAX_DEPTH_BANDS, ...VELOCITY_BANDS.slice(1)];
  for (const exposure of [0.7, 0.8, 0.945]) {
    for (const b of bands) {
      const target = cssToLinear(b.color);
      const x = hazardInput(target, exposure);
      assert.ok(Math.max(...x) <= HAZARD_MAX_PEAK + 1e-9 && Math.min(...x) >= 0, `${b.color}: HDR ${x}`);
      const err = srgbErr(target, postProcess(x, exposure));
      assert.ok(err < 1.5, `${b.color} at exposure ${exposure}: off by ${err.toFixed(2)}/255`);
    }
  }
  assert.match(NORMAL_WATER_LEGEND.color, /^#[0-9a-f]{6}$/);
});

test('post mirror matches the WGSL constants and is monotone', () => {
  assert.match(TONEMAP_WGSL, /mat3x3f\(vec3f\(0\.59719, 0\.076, 0\.0284\)/);
  assert.match(TONEMAP_WGSL, /1\.1\), vec3f\(0\.0\), vec3f\(1\.0\)\)/);
  let prev = -1;
  for (let v = 0; v < 8; v += 0.05) {
    const y = postProcess([v, v, v])[0];
    assert.ok(y >= prev - 1e-12);
    prev = y;
  }
  assert.ok(postProcess([0, 0, 0])[0] < 0.01 && postProcess([20, 20, 20])[0] > 0.9);
});
