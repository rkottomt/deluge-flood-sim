/**
 * Occupancy, storeys, values (src/loss/value.ts) and hazard classes / structural rule / downtime (src/loss/hazard.ts).
 * Run: node --import tsx --test tests/loss/value.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { levelsToMeters } from '../../src/data/buildings';
import { curveFor } from '../../src/loss/curves';
import {
  aidrClass,
  cleanupDays,
  downtimeDays,
  fd2321HR,
  hrClass,
  structuralState,
} from '../../src/loss/hazard';
import {
  assetValue,
  floorsFromHeight,
  OCCUPANCIES,
  OCCUPANCY_PROFILES,
  occupancyForKind,
  storeyDamage,
  UNIT_COST_USD_M2,
} from '../../src/loss/value';

test('floors invert the heights the footprints were built from', () => {
  for (const levels of [1, 2, 3, 4, 6, 12, 30, 64]) {
    const h = levelsToMeters(String(levels))!;
    assert.equal(floorsFromHeight(h), levels, `${levels} levels → ${h} m`);
  }
  assert.equal(floorsFromHeight(0), 1);
  assert.equal(floorsFromHeight(NaN), 1);
  assert.equal(floorsFromHeight(2), 1);
});

test('OSM kinds map to occupancies; building=yes falls to the size heuristic', () => {
  assert.deepEqual(occupancyForKind('house', 120, 2), { occ: 'res', confidence: 'tagged' });
  assert.equal(occupancyForKind('apartments', 900, 6).occ, 'apt');
  assert.equal(occupancyForKind('office', 900, 6).occ, 'office');
  assert.equal(occupancyForKind('commercial', 900, 2).occ, 'office');
  assert.equal(occupancyForKind('church', 900, 2).occ, 'religious');
  assert.equal(occupancyForKind('shed', 40, 1).occ, 'minor');
  assert.deepEqual(occupancyForKind('other', 100, 1), { occ: 'res', confidence: 'heuristic' });
  assert.equal(occupancyForKind('other', 2000, 1).occ, 'retail');
  assert.equal(occupancyForKind('other', 20000, 1).occ, 'warehouse');
  assert.equal(occupancyForKind('other', 20000, 5).occ, 'retail');
});

test('every occupancy has a complete profile', () => {
  for (const o of OCCUPANCIES) {
    const p = OCCUPANCY_PROFILES[o];
    assert.ok(p.rebuildDays > 0 && p.contentFactor >= 0 && p.recapture >= 0 && p.recapture <= 1, o);
  }
});

test('values: GFA × unit cost × factors; given values win; no table → unknown, not zero', () => {
  const v = assetValue({ occ: 'res', gfaM2: 200, country: 'US' });
  assert.equal(v.structure, 200 * UNIT_COST_USD_M2.US.residential);
  assert.equal(v.contents, v.structure * 0.5);
  assert.equal(v.source, 'unit-cost');
  const w = assetValue({ occ: 'warehouse', gfaM2: 1000, country: 'NP' });
  assert.equal(w.contents, w.structure * 1.5);
  assert.equal(assetValue({ occ: 'minor', gfaM2: 100, country: 'US' }).structure, 100 * 2000 * 0.2);
  assert.equal(assetValue({ occ: 'res', gfaM2: 100, country: 'NP', construction: 'mud' }).structure, 100 * 270 * 0.2);
  const g = assetValue({ occ: 'office', gfaM2: 100, country: 'US', structureGiven: 5e6, contentsGiven: 1e6 });
  assert.deepEqual([g.structure, g.contents, g.source], [5e6, 1e6, 'given']);
  const none = assetValue({ occ: 'res', gfaM2: 100, country: null });
  assert.ok(Number.isNaN(none.structure) && none.source === 'none');
  assert.ok(Number.isNaN(assetValue({ occ: 'datacenter', gfaM2: 100, country: 'US' }).structure));
});

test('per-storey damage: a tower with a metre of water loses its ground floor, not half its value', () => {
  const curve = curveFor('commercial', 'northAmerica');
  const one = storeyDamage({ depth: 1, floors: 1, storeyHeight: 3.2, curve, structureValue: 1e6, contentsValue: 1e6, undamageable: 0.4, state: 'none' });
  close(one.fraction, 0.3742);
  close(one.structure, 0.3742 * 0.6e6);
  close(one.contents, 0.3742 * 1e6);
  const tower = storeyDamage({ depth: 1, floors: 30, storeyHeight: 3.95, curve, structureValue: 30e6, contentsValue: 30e6, undamageable: 0.4, state: 'none' });
  close(tower.fraction, 0.3742 / 30);
  assert.equal(tower.wetStoreys, 1);
  // 5 m of water floods the second storey too, by 5 − 3.2 = 1.8 m.
  const two = storeyDamage({ depth: 5, floors: 2, storeyHeight: 3.2, curve, structureValue: 2e6, contentsValue: 0, undamageable: 0, state: 'none' });
  close(two.structure, 0.908e6 + (0.4663 + 0.6 * (0.5521 - 0.4663)) * 1e6);
  // ±1σ band brackets the central loss.
  assert.ok(one.lossLo < one.structure + one.contents && one.lossHi > one.structure + one.contents);
  // Velocity rules.
  const partial = storeyDamage({ depth: 0.3, floors: 1, storeyHeight: 3.2, curve, structureValue: 1e6, contentsValue: 0, undamageable: 0, state: 'partial' });
  close(partial.fraction, 0.5);
  const gone = storeyDamage({ depth: 0.3, floors: 3, storeyHeight: 3.2, curve, structureValue: 1e6, contentsValue: 1e6, undamageable: 0.4, state: 'collapse' });
  close(gone.structure + gone.contents, 1.6e6);
  assert.equal(gone.lossLo, gone.lossHi);
  const dry = storeyDamage({ depth: 0, floors: 1, storeyHeight: 3.2, curve, structureValue: 1e6, contentsValue: 1e6, undamageable: 0.4, state: 'none' });
  assert.equal(dry.structure + dry.contents + dry.lossHi, 0);
});

function close(a: number, b: number, tol = 1e-9) {
  assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);
}

test('AIDR classes: lowest class whose three limits hold', () => {
  assert.equal(aidrClass(0.2, 0.5), 1);
  assert.equal(aidrClass(0.3, 1.0), 1);
  assert.equal(aidrClass(0.31, 1.0), 2);
  assert.equal(aidrClass(0.2, 1.9), 2); // dv 0.38 > 0.3
  assert.equal(aidrClass(1.0, 0.5), 3);
  assert.equal(aidrClass(1.0, 0.9), 4); // dv 0.9
  assert.equal(aidrClass(1.5, 0.5), 4);
  assert.equal(aidrClass(1.0, 2.5), 5);
  assert.equal(aidrClass(3.9, 1.0), 5);
  assert.equal(aidrClass(4.1, 0.1), 6);
  assert.equal(aidrClass(2, 2.5), 6); // dv 5
  assert.equal(aidrClass(1.0, NaN), 3); // speed unknown: depth only
  // Monotone in depth and in speed.
  let prev = 1;
  for (let d = 0; d < 6; d += 0.05) {
    const c = aidrClass(d, 1);
    assert.ok(c >= prev);
    prev = c;
  }
});

test('FD2321 hazard rating and classes', () => {
  assert.equal(fd2321HR(0.2, 0.5), 0.2);
  assert.equal(fd2321HR(0.5, 1), 0.5 * 1.5 + 1);
  assert.equal(fd2321HR(0.5, 1, 'pasture'), 0.75);
  assert.equal(fd2321HR(0.5, 1, 'woodland'), 0.5 * 1.5 + 0.5);
  assert.equal(fd2321HR(0.1, 3), 0.1 * 3.5 + 1);
  assert.equal(fd2321HR(0, 3), 0);
  assert.equal(hrClass(0.5), 'low');
  assert.equal(hrClass(1.0), 'moderate');
  assert.equal(hrClass(1.5), 'significant');
  assert.equal(hrClass(2.5), 'extreme');
});

test('fast water: Clausen & Clark thresholds, light construction and debris heuristics', () => {
  assert.equal(structuralState(1.5, 9), 'none'); // slow, however deep
  assert.equal(structuralState(2.5, 2.9), 'none');
  assert.equal(structuralState(2.5, 3), 'partial');
  assert.equal(structuralState(3, 7), 'collapse');
  assert.equal(structuralState(2.5, 3.5, { construction: 'timber' }), 'collapse'); // 7 × 0.5
  assert.equal(structuralState(2.5, 1.5, { construction: 'timber' }), 'partial'); // 3 × 0.5
  assert.equal(structuralState(2.5, 2.1, { debrisFlow: true }), 'collapse'); // 3.15 ≥ 3
  assert.equal(structuralState(2.5, 2.1, { debrisFlow: true, construction: 'concrete' }), 'partial');
  assert.equal(structuralState(NaN, NaN), 'unknown');
});

test('downtime heuristic', () => {
  assert.equal(cleanupDays(0.01), 0);
  assert.equal(cleanupDays(0.2), 7);
  assert.equal(cleanupDays(0.5), 21);
  assert.equal(cleanupDays(1.5), 45);
  assert.equal(cleanupDays(3), 90);
  assert.equal(downtimeDays({ depth: 0.5, damage: 0.5, rebuildDays: 240 }), 21 + 120);
  assert.equal(downtimeDays({ depth: 0, damage: 0, rebuildDays: 240, accessDays: 3 }), 3);
});
