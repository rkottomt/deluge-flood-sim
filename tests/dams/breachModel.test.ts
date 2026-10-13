/**
 * Dam-breach scenarios (src/dams/breachModel.ts) against published cases.
 *
 * Teton Dam, Idaho, 5 June 1976 — piping failure of a 93 m zoned earthfill dam on its first filling. Wahl 1998 (USBR
 * DSO-98-004, the standard breach database) and Froehlich 2008 list: released volume V_w = 3.10×10⁸ m³, head above the
 * breach bottom h_w = 77.4 m, breach height h_b = 86.9 m, average breach width 150.9 m, formation time ~1.25 h, peak
 * outflow 65,120 m³/s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  damBreach,
  damScenario,
  DEFAULT_HYPSOMETRY,
  froehlich2008Time,
  froehlich2008Width,
  froehlich2016Peak,
  hypsometryFor,
  macDonald1984Peak,
} from '../../src/dams/breachModel';
import type { NidDam } from '../../src/dams/nidIndex';
import { hydrographVolume } from '../../src/sim/forcing';

const TETON = { V: 3.1e8, hw: 77.4, hb: 86.9, width: 150.9, tfH: 1.25, peak: 65120 };

test('Froehlich 2008 breach parameters for Teton 1976 land near the observed breach', () => {
  const B = froehlich2008Width(TETON.V, TETON.hb, false);
  const tf = froehlich2008Time(TETON.V, TETON.hb) / 3600;
  // B̄ = 0.27·1.0·V^0.32·h_b^0.04 = 168 m; t_f = 63.2·√(V/(g·h_b²)) = 1.14 h.
  assert.ok(Math.abs(B - 168) < 2, `width ${B}`);
  assert.ok(Math.abs(tf - 1.135) < 0.01, `time ${tf} h`);
  assert.ok(Math.abs(B / TETON.width - 1) < 0.15, `width within 15 % of the observed 151 m: ${B}`);
  assert.ok(Math.abs(tf / TETON.tfH - 1) < 0.15, `time within 15 % of the observed 1.25 h: ${tf}`);
  // Overtopping widens the breach by K₀ = 1.3.
  assert.ok(Math.abs(froehlich2008Width(TETON.V, TETON.hb, true) / B - 1.3) < 1e-9);
});

test('Teton: the published peak relations bracket the observed 65,000 m³/s; the two hydrograph methods bound it from above', () => {
  const mac = macDonald1984Peak(TETON.V, TETON.hw);
  const f16 = froehlich2016Peak(TETON.V, TETON.hw, TETON.hb, froehlich2008Width(TETON.V, TETON.hb, false), false);
  assert.ok(mac < TETON.peak && TETON.peak < f16, `MacDonald ${mac} < 65,120 < Froehlich 2016 ${f16}`);
  const para = damBreach({ volumeM3: TETON.V, headM: TETON.hw, breachHeightM: TETON.hb, overtopping: false, hypsometry: 2 });
  const reg = damBreach({ volumeM3: TETON.V, headM: TETON.hw, breachHeightM: TETON.hb, overtopping: false, method: 'regression' });
  // Froehlich 2016 in a gamma shape: +22 %. The parametric breach (Fread's weir, no tailwater): +51 % at p = 2 —
  // conservative, as stated in the module and the README. Both within the factor-of-two scatter of the relations.
  assert.ok(Math.abs(reg.peak / TETON.peak - 1.22) < 0.03, `regression peak ${reg.peak}`);
  assert.ok(para.peak / TETON.peak > 1.3 && para.peak / TETON.peak < 1.7, `parametric peak ${para.peak}`);
  // The parametric peak comes as the breach completes, near the formation time.
  assert.ok(Math.abs(para.tPeak - para.formationTimeS) < 0.1 * para.formationTimeS, `peak at ${para.tPeak} s vs t_f ${para.formationTimeS} s`);
  for (const r of [para, reg]) {
    assert.ok(r.peak > mac && r.peak < 2 * TETON.peak);
    assert.equal(r.relations.length, 3);
  }
});

test('the hydrograph handed to the solver delivers exactly the released volume (no base flow)', () => {
  for (const method of ['parametric', 'regression'] as const) {
    const r = damBreach({ volumeM3: 8.2e7, headM: 17, breachHeightM: 17.4, overtopping: true, hypsometry: 2.2, method });
    const pts = r.hydrograph;
    assert.ok(pts.length > 100 && pts.length < 600, `${pts.length} points`);
    assert.equal(pts[0].t, 0);
    assert.equal(pts[pts.length - 1].q, 0);
    const v = hydrographVolume(pts, 0, pts[pts.length - 1].t + 1);
    assert.ok(Math.abs(v / r.breachVolume - 1) < 1e-9, `${method}: forcing integral ${v} vs ${r.breachVolume}`);
    assert.ok(Math.abs(r.breachVolume / 8.2e7 - 1) < 2e-3, `${method}: breach volume ${r.breachVolume}`);
    assert.ok(Math.abs(r.deliveredVolume / v - 1) < 1e-12);
  }
});

test('a flood-induced breach rides on the river flood and ramps off it; the delivered volume says so', () => {
  const r = damBreach({ volumeM3: 5e7, headM: 20, breachHeightM: 22, overtopping: true, baseFlow: 500 });
  const pts = r.hydrograph;
  assert.equal(pts[0].q, 500);
  assert.equal(pts[pts.length - 1].q, 0);
  const tEnd = pts[pts.length - 2].t;
  assert.ok(Math.abs(r.deliveredVolume - (r.breachVolume + 500 * tEnd + 0.5 * 500 * 3600)) < 1e-6 * r.deliveredVolume, `${r.deliveredVolume}`);
});

function dam(over: Partial<NidDam> = {}): NidDam {
  return {
    id: 'MI00549',
    name: 'Edenville Dam',
    state: 'MI',
    lat: 43.8167,
    lon: -84.3883,
    heightM: 17.4,
    hydraulicHeightM: 17.4,
    storageAcFt: 66200,
    normalStorageAcFt: 36000,
    surfaceAreaAc: 2600,
    maxDischargeCfs: 21070,
    lengthFt: 6200,
    year: 1924,
    hazard: 'High',
    owner: 'Private',
    damType: 'Earth',
    ...over,
  };
}

test('an NID dam: sunny-day releases the normal pool, flood-induced the maximum, on top of the spillway flood', () => {
  const d = dam();
  const sunny = damScenario(d, 'sunny');
  const flood = damScenario(d, 'flood');
  assert.ok(Math.abs(sunny.volumeM3 - 36000 * 1233.48183754752) < 1);
  assert.ok(Math.abs(flood.volumeM3 - 66200 * 1233.48183754752) < 1);
  assert.ok(sunny.headM < flood.headM && flood.headM === 17.4, `heads ${sunny.headM} / ${flood.headM}`);
  assert.ok(flood.result.peak > sunny.result.peak, `${flood.result.peak} > ${sunny.result.peak}`);
  assert.ok(Math.abs(flood.result.input.baseFlow - 21070 * 0.028316846592) < 1e-6);
  assert.equal(sunny.result.input.baseFlow, 0);
  assert.equal(sunny.assumptions.length, 0, sunny.assumptions.join(' | '));
  assert.ok(flood.assumptions.some((a) => /spillway discharge/.test(a)));
  // The width never exceeds the dam itself.
  assert.ok(flood.result.avgWidthM <= 6200 * 0.3048);
});

test('an NID dam with fields missing says what it assumed', () => {
  const d = dam({ hydraulicHeightM: null, normalStorageAcFt: null, surfaceAreaAc: null, maxDischargeCfs: null, damType: 'Gravity' });
  const s = damScenario(d, 'sunny');
  assert.equal(s.result.input.hypsometry, DEFAULT_HYPSOMETRY);
  const text = s.assumptions.join(' ');
  assert.match(text, /No hydraulic height/);
  assert.match(text, /No surface area/);
  assert.match(text, /No normal storage/);
  assert.match(text, /gravity dam/);
  assert.ok(Math.abs(s.volumeM3 - 0.5 * 66200 * 1233.48183754752) < 1);
  assert.ok(damScenario(d, 'flood').assumptions.some((a) => /No maximum discharge/.test(a)));
});

test('a dry dam (NID normal storage 0) has no sunny-day failure: it holds no pool on a sunny day', () => {
  const d = dam({ normalStorageAcFt: 0, name: 'Red Rock Detention Dam' });
  const s = damScenario(d, 'sunny');
  // Not the 50 %-of-maximum fallback for an unreported normal storage, and not the "No normal storage" note.
  assert.equal(s.mode, 'flood');
  assert.ok(Math.abs(s.volumeM3 - 66200 * 1233.48183754752) < 1);
  assert.ok(!s.assumptions.some((a) => /No normal storage/.test(a)), s.assumptions.join(' | '));
  assert.ok(s.assumptions.some((a) => /dry dam/i.test(a) && /no sunny-day/i.test(a)), s.assumptions.join(' | '));
  // Flood-induced is unchanged, and the reservoir shape is read at the only pool it has (maximum).
  const f = damScenario(d, 'flood');
  assert.equal(f.mode, 'flood');
  assert.ok(Math.abs(f.volumeM3 - s.volumeM3) < 1e-6);
  assert.ok(hypsometryFor(d, 17.4).fromNid);
});

test('a dam bigger than any documented failure says its numbers are an extrapolation', () => {
  const big = dam({ id: 'CA00035', name: 'Oroville Dam', heightM: 234.7, hydraulicHeightM: 228, storageAcFt: 3_540_000, normalStorageAcFt: 3_540_000, surfaceAreaAc: 15_800 });
  assert.ok(damScenario(big, 'sunny').assumptions.some((a) => /extrapolation/.test(a)));
  assert.ok(!damScenario(dam(), 'flood').assumptions.some((a) => /extrapolation/.test(a)));
});

test('reservoir shape from the NID: p = A·h/V at normal pool, clamped to [1, 4]', () => {
  const { p, fromNid } = hypsometryFor(dam(), 17.4);
  assert.ok(fromNid);
  assert.ok(p >= 1 && p <= 4, `p = ${p}`);
  // Fixed point: p reproduces itself.
  const Vn = 36000 * 1233.48183754752;
  const hn = 17.4 * Math.pow(Vn / (66200 * 1233.48183754752), 1 / p);
  assert.ok(Math.abs(Math.min(4, Math.max(1, (2600 * 4046.8564224 * hn) / Vn)) - p) < 1e-6);
});
