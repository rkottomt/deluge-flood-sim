/**
 * Lake volume from area (src/hazard/volume.ts): every relation reproduces the research spec's Table A.2 to the 0.1 Mm³
 * it prints, the default estimate is the geometric mean of its three members with a ×/÷2 band, and the drainable
 * volume follows the hypsometry it is derived from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drainableVolume, VA_RELATIONS, volumeFromArea, volumeFromBathymetry } from '../../src/hazard/volume';

const Mm3 = 1e6;
const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('V–A relations reproduce spec Table A.2 (Tsho Rolpa, Purepu, Lejiacocha), Mm³', () => {
  // [area m², Huggel02, C&Q #6, Sakai12, C&Q supraglacial, O'Connor01] as printed in the spec (0.1 Mm³, O'Connor 1 Mm³).
  const rows: Array<[string, number, number, number, number, number, number]> = [
    ['Tsho Rolpa', 1.537e6, 63.4, 74.4, 83.5, 13.9, 403],
    ['Purepu', 0.68e6, 19.9, 23.1, 24.0, 5.05, 80],
    ['Lejiacocha', 0.184e6, 3.11, 3.54, 3.24, 1.0, 6.3],
  ];
  for (const [name, A, hug, cq, sak, sup, oc] of rows) {
    close(VA_RELATIONS.huggel2002.volume(A) / Mm3, hug, 0.051, `${name} Huggel`);
    close(VA_RELATIONS.cookQuincey2015.volume(A) / Mm3, cq, 0.051, `${name} C&Q #6`);
    close(VA_RELATIONS.sakai2012.volume(A) / Mm3, sak, 0.051, `${name} Sakai`);
    close(VA_RELATIONS.cookQuincey2015Supraglacial.volume(A) / Mm3, sup, 0.051, `${name} supraglacial`);
    close(VA_RELATIONS.oconnor2001.volume(A) / Mm3, oc, 0.51, `${name} O'Connor`);
  }
});

test('the default estimate is the geometric mean of Huggel, C&Q #6 and Sakai with a ×/÷2 band', () => {
  const A = 1.537e6;
  const e = volumeFromArea(A, 'moraine');
  const gm = Math.cbrt(VA_RELATIONS.huggel2002.volume(A) * VA_RELATIONS.cookQuincey2015.volume(A) * VA_RELATIONS.sakai2012.volume(A));
  close(e.median, gm, 1e-6 * gm, 'geometric mean');
  close(e.lo, gm / 2, 1e-6 * gm, 'lo');
  close(e.hi, gm * 2, 1e-6 * gm, 'hi');
  assert.equal(e.method, 'empirical');
  // Tsho Rolpa's surveyed 85.94 Mm³ lies inside the band (the median is −15 %).
  assert.ok(e.lo < 85.94e6 && 85.94e6 < e.hi);
  // Supraglacial: C&Q's growing-lake relation, ×/÷2.5; Purepu's measured 9.09 Mm³ inside it (median −44 %).
  const p = volumeFromArea(0.68e6, 'supraglacial');
  close(p.median / Mm3, 5.05, 0.01, 'Purepu supraglacial');
  assert.ok(p.lo < 9.09e6 && 9.09e6 < p.hi);
  // A bathymetry has ±10 %.
  const b = volumeFromBathymetry(85.94e6);
  close(b.hi / b.median, 1.1, 1e-12, 'bathymetry band');
  assert.equal(volumeFromArea(0).median, 0);
});

test('drainable volume: all of it once the breach reaches the deepest point, the right slice above it otherwise', () => {
  // Thame lower lake: D = p·V/A = 1.5·0.36e6/0.048e6 = 11.25 m < 12 m breach → drains completely (as observed).
  assert.equal(drainableVolume(0.36e6, 0.048e6, 12, 1.5), 0.36e6);
  // Half the depth of a vertical-walled lake (p = 1) drains half of it; p = 2 drains 3/4.
  close(drainableVolume(1e6, 1e5, 5, 1), 0.5e6, 1e-6, 'p = 1');
  close(drainableVolume(1e6, 2e5, 5, 2), 0.75e6, 1e-6, 'p = 2');
  assert.equal(drainableVolume(1e6, 1e5, 0, 1.5), 0);
});
