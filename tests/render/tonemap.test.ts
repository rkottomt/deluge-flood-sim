/**
 * Post chain CPU mirror: hazard colours are solved so the tone-mapped result is the legend colour, without
 * blooming, and every legend colour is one the tone mapper can actually reproduce.
 *
 * These are the gate on re-grading. src/render/tonemap.ts is the single source of truth for the chain's constants
 * and shaders/post.ts builds the WGSL from them, so the risk of a grade change is not that the two drift — it is
 * that a more contrasty curve quietly moves a legend colour out of the reachable gamut, and the swatch in the UI
 * stops matching the water on screen. That is what the first test measures, in units of /255 at every exposure
 * the renderer can ask for.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACES_IN,
  ACES_OUT,
  BASE_EXPOSURE,
  BLOOM_KNEE,
  BLOOM_THRESHOLD,
  bloomContribution,
  BLOOM_MIX,
  CROSSTALK_LO,
  GRADE_CONTRAST,
  GRADE_GAIN,
  GRADE_GAMMA,
  GRADE_PIVOT,
  grade,
  HAZARD_MAX_PEAK,
  hazardInput,
  linearToSrgb,
  POST_SATURATION,
  postProcess,
  VIGNETTE_INNER,
  VIGNETTE_OUTER,
  type RGB,
} from '../../src/render/tonemap';
import { cssToLinear, DEPTH_BANDS, MAX_DEPTH_BANDS, NORMAL_WATER_LEGEND, VELOCITY_BANDS } from '../../src/render/legend';
import { BLOOM_PARAMS, TONEMAP_WGSL } from '../../src/render/shaders/post';

const srgbErr = (a: RGB, b: RGB) => Math.max(...[0, 1, 2].map((k) => Math.abs(linearToSrgb(a[k]) - linearToSrgb(b[k])) * 255));
/** Every exposure the renderer can produce: BASE_EXPOSURE times the overcast and low-sun adaptations. */
const EXPOSURES = [0.7, 0.8, 0.875, 0.945, 1.0, 1.23];

test('every hazard legend colour tone-maps back to itself under the bloom threshold', () => {
  assert.ok(HAZARD_MAX_PEAK < BLOOM_THRESHOLD);
  // The slowest speed band is drawn as plain water, not in its swatch colour.
  const bands = [...DEPTH_BANDS, ...MAX_DEPTH_BANDS, ...VELOCITY_BANDS.slice(1)];
  for (const exposure of EXPOSURES) {
    for (const b of bands) {
      const target = cssToLinear(b.color);
      const x = hazardInput(target, exposure);
      assert.ok(Math.max(...x) <= HAZARD_MAX_PEAK + 1e-9 && Math.min(...x) >= 0, `${b.color}: HDR ${x}`);
      const err = srgbErr(target, postProcess(x, exposure));
      assert.ok(err < 1.5, `${b.color} at exposure ${exposure}: off by ${err.toFixed(2)}/255`);
      // …and the colour it is solved to must not glow: that is what keeps a hazard map readable as data.
      assert.equal(bloomContribution(Math.max(...x)), 0, `${b.color} would bloom`);
    }
  }
  assert.match(NORMAL_WATER_LEGEND.color, /^#[0-9a-f]{6}$/);
});

test('the WGSL tone mapper is generated from these constants, not a copy of them', () => {
  // Matrices.
  assert.ok(TONEMAP_WGSL.includes(`vec3f(${ACES_IN[0]}, ${ACES_IN[1]}, ${ACES_IN[2]})`), 'ACES input matrix');
  assert.ok(TONEMAP_WGSL.includes(`vec3f(${ACES_OUT[0]}, ${ACES_OUT[1]}, ${ACES_OUT[2]})`), 'ACES output matrix');
  // Grade: crosstalk onset, contrast, pivot, saturation restore and the split tone all reach the shader.
  for (const n of [CROSSTALK_LO, GRADE_CONTRAST, GRADE_PIVOT, POST_SATURATION, BLOOM_MIX, VIGNETTE_INNER, VIGNETTE_OUTER]) {
    assert.ok(TONEMAP_WGSL.includes(String(n)), `constant ${n} missing from the WGSL`);
  }
  // The WGSL writes whole numbers as "1.0", so compare through the same formatting the generator uses.
  const wgslVec3 = (v: readonly number[]) => `vec3f(${v.map((x) => (Number.isInteger(x) ? `${x}.0` : `${x}`)).join(', ')})`;
  assert.ok(TONEMAP_WGSL.includes(wgslVec3(GRADE_GAMMA)), 'split-tone gamma');
  assert.ok(TONEMAP_WGSL.includes(wgslVec3(GRADE_GAIN)), 'split-tone gain');
  // Crosstalk must start at the bloom threshold, or hazard colours would be pulled toward white by it.
  assert.equal(CROSSTALK_LO, BLOOM_THRESHOLD);
  // The bright pass reads its threshold and knee from a uniform the renderer fills from these same numbers.
  assert.deepEqual({ ...BLOOM_PARAMS }, { threshold: BLOOM_THRESHOLD, knee: BLOOM_KNEE });
});

test('the post chain is monotone in brightness and spans black to white', () => {
  for (const exposure of EXPOSURES) {
    let prev = -1;
    for (let v = 0; v < 12; v += 0.02) {
      const y = postProcess([v, v, v], exposure)[0];
      assert.ok(y >= prev - 1e-12, `not monotone at ${v} (exposure ${exposure})`);
      prev = y;
    }
    assert.ok(postProcess([0, 0, 0], exposure)[0] < 0.01, 'black stays black');
    assert.ok(postProcess([20, 20, 20], exposure)[0] > 0.9, 'a bright highlight reaches white');
  }
});

test('the grade adds contrast without touching hazard colours or inverting anything', () => {
  // The pivot is the fixed point of the contrast law.
  const p = grade([GRADE_PIVOT, GRADE_PIVOT, GRADE_PIVOT]);
  assert.ok(Math.abs(p[0] - GRADE_PIVOT) < 1e-9);
  // Contrast: below the pivot the grade darkens, above it, it brightens. That is the whole point of it.
  assert.ok(grade([0.05, 0.05, 0.05])[0] < 0.05);
  assert.ok(grade([0.6, 0.6, 0.6])[0] > 0.6);
  assert.ok(GRADE_CONTRAST > 1);
  // Crosstalk leaves everything a hazard colour can reach completely alone: below CROSSTALK_LO, a saturated
  // colour keeps its channel ratios exactly.
  const sat: RGB = [0.1, 0.9, 2.0];
  const g = grade(sat);
  const pure = sat.map((v) => GRADE_PIVOT * Math.pow(v / GRADE_PIVOT, GRADE_CONTRAST));
  for (let k = 0; k < 3; k++) assert.ok(Math.abs(g[k] - pure[k]) < 1e-9, `crosstalk leaked at ${sat[k]}`);
  // …and above it, a blown colour is pulled toward its own peak rather than clipping to a primary: the weak
  // channel of a hot colour ends up brighter than the pure contrast law alone would leave it.
  const hot: RGB = [0.2, 4, 12];
  const withCrosstalk = grade(hot);
  const withoutCrosstalk = hot.map((v) => GRADE_PIVOT * Math.pow(v / GRADE_PIVOT, GRADE_CONTRAST));
  assert.ok(withCrosstalk[0] > withoutCrosstalk[0] * 2, 'crosstalk should lift the weak channel of a blown colour');
  assert.ok(withCrosstalk[2] <= withoutCrosstalk[2] + 1e-9, 'and never push the peak channel higher');
});

test('the bloom bright pass is silent at the threshold and has no step for a blur to smear', () => {
  assert.equal(bloomContribution(BLOOM_THRESHOLD), 0);
  assert.equal(bloomContribution(HAZARD_MAX_PEAK), 0);
  assert.equal(bloomContribution(0), 0);
  // C1 at the threshold: the value and the slope both start at zero, so nothing "switches on".
  const h = 1e-4;
  const slope = (bloomContribution(BLOOM_THRESHOLD + h) - bloomContribution(BLOOM_THRESHOLD)) / h;
  assert.ok(slope < 1e-3, `bright pass turns on with slope ${slope}`);
  // Continuous where the knee hands over to the linear part, and asymptotically a plain threshold subtraction.
  const at = bloomContribution(BLOOM_THRESHOLD + BLOOM_KNEE);
  assert.ok(Math.abs(at - BLOOM_KNEE / 2) < 1e-12);
  assert.ok(Math.abs(bloomContribution(BLOOM_THRESHOLD + 10) - (10 - BLOOM_KNEE / 2)) < 1e-12);
  // Monotone, so a brighter pixel never glows less.
  let prev = -1;
  for (let v = 0; v < 20; v += 0.01) {
    const c = bloomContribution(v);
    assert.ok(c >= prev - 1e-12);
    prev = c;
  }
});

test('the default exposure is the one the legend is solved against', () => {
  assert.ok(EXPOSURES.includes(BASE_EXPOSURE));
});
