/**
 * The published breach relations (src/dams/breachRelations.ts) and their score on documented failures
 * (src/dams/historicalFailures.ts, Wahl 1998 Table A1).
 *
 * The score table this test prints (node --test shows it) is the one in README "Dam breaches". The central case of the
 * band is the relation with the smallest RMS log error here, and this test keeps it so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARRIVAL_EXPONENT,
  CENTRAL_RELATION,
  froehlich1995Geometry,
  froehlich1995Peak,
  froehlich2008Geometry,
  peakBand,
  pierce2010Peak,
  RELATIONS,
  scaledArrival,
  vonThunCb,
  vonThunGeometry,
  xuZhang2009Peak,
} from '../../src/dams/breachRelations';
import { HISTORICAL_FAILURES, historicalCase, scoreRelations } from '../../src/dams/historicalFailures';

const TETON = HISTORICAL_FAILURES.find((f) => f.wahl === 102)!;

test('Froehlich 1995 peak reproduces the predictions Wahl 1998 Table 4 lists for it', () => {
  // Wahl 1998 Table 4, "Predicted Peak Flow" by Froehlich's equation, with V_w and h_w from Table A1.
  for (const [V, hw, wahl] of [
    [798_000, 6.71, 354], // Lawn Lake
    [484_000, 14.02, 762], // Buffalo Creek
    [37e6, 47.85, 12_600], // Swift
    [7_400, 5.79, 74.2], // Otto Run
  ] as const) {
    const q = froehlich1995Peak(V, hw);
    assert.ok(Math.abs(q / wahl - 1) < 0.01, `${V} m³, ${hw} m: ${q} vs Wahl ${wahl}`);
  }
});

test('breach-parameter relations: Froehlich 2008 and 1995, Von Thun & Gillette, on Teton', () => {
  const c = historicalCase(TETON);
  const f08 = froehlich2008Geometry(c);
  assert.ok(Math.abs(f08.avgWidthM - 168) < 2 && Math.abs(f08.formationTimeS / 3600 - 1.135) < 0.01, JSON.stringify(f08));
  // Froehlich 1995: B̄ = 0.1803·V^0.32·h_b^0.19 = 237 m; t_f = 0.00254·V^0.53·h_b^−0.9 = 1.73 h (Teton observed: 151 m, 1.25 h).
  const f95 = froehlich1995Geometry(c);
  assert.ok(Math.abs(f95.avgWidthM - 0.1803 * Math.pow(3.1e8, 0.32) * Math.pow(86.9, 0.19)) < 1e-9);
  assert.ok(f95.avgWidthM > 200 && f95.avgWidthM < 260, `${f95.avgWidthM}`);
  assert.ok(Math.abs(f95.formationTimeS / 3600 - 0.00254 * Math.pow(3.1e8, 0.53) * Math.pow(86.9, -0.9)) < 1e-9);
  assert.equal(f95.sideSlope, 0.9);
  assert.equal(froehlich1995Geometry({ ...c, overtopping: true }).sideSlope, 1.4);
  // Von Thun & Gillette: B̄ = 2.5·77.4 + 54.9 = 248.4 m; zoned earthfill resists erosion: t_f = 0.020·77.4 + 0.25 h.
  const vt = vonThunGeometry(c);
  assert.ok(Math.abs(vt.avgWidthM - 248.4) < 1e-9);
  assert.ok(Math.abs(vt.formationTimeS - 3600 * (0.02 * 77.4 + 0.25)) < 1e-6);
  assert.ok(Math.abs(vonThunGeometry({ ...c, easilyErodible: true }).formationTimeS - 3600 * 0.015 * 77.4) < 1e-6);
  // C_b steps by reservoir size (Wahl 1998 p. 15).
  assert.deepEqual([1e6, 2e6, 1e7, 2e7].map(vonThunCb), [6.1, 18.3, 42.7, 54.9]);
});

test('Xu & Zhang 2009 and Pierce et al. 2010 peaks; Xu & Zhang stands aside for concrete-faced rockfill', () => {
  const c = historicalCase(TETON);
  // Q_p = √(g·V^(5/3))·0.175·(h_d/15)^0.199·(V^(1/3)/h_w)^−1.274·e^(−0.649 − 1.039 − 0.375)  (homogeneous/zoned, piping, medium).
  const xz = 0.175 * Math.sqrt(9.81 * Math.pow(3.1e8, 5 / 3)) * Math.pow(92.96 / 15, 0.199) * Math.pow(Math.cbrt(3.1e8) / 77.4, -1.274) * Math.exp(-0.649 - 1.039 - 0.375);
  assert.ok(Math.abs(xuZhang2009Peak(c)! / xz - 1) < 1e-12);
  assert.ok(xuZhang2009Peak({ ...c, overtopping: true })! > xuZhang2009Peak(c)!);
  assert.ok(xuZhang2009Peak({ ...c, erodibility: 'high' })! > xuZhang2009Peak(c)! && xuZhang2009Peak(c)! > xuZhang2009Peak({ ...c, erodibility: 'low' })!);
  const swift = HISTORICAL_FAILURES.find((f) => f.wahl === 101)!;
  assert.equal(historicalCase(swift).xzType, null);
  assert.equal(xuZhang2009Peak(historicalCase(swift)), null);
  assert.ok(Math.abs(pierce2010Peak(3.1e8, 77.4) - 0.0176 * Math.pow(3.1e8 * 77.4, 0.606)) < 1e-9);
});

test('the historical table: 21 documented failures, every one with a sourced, measured or reconstructed peak', () => {
  assert.equal(HISTORICAL_FAILURES.length, 21);
  const ids = new Set(HISTORICAL_FAILURES.map((f) => f.wahl));
  assert.equal(ids.size, 21);
  for (const f of HISTORICAL_FAILURES) {
    assert.ok(f.volumeM3 > 0 && f.headM > 0 && f.breachHeightM > 0 && f.peak > 0, f.name);
    assert.ok(!/unknown$/i.test(f.peakMethod) && f.peakMethod.length > 5, `${f.name}: ${f.peakMethod}`);
  }
  // The ones the task names: Teton, Lawn Lake, Kelly Barnes, Buffalo Creek, Baldwin Hills.
  for (const n of ['Teton', 'Lawn Lake', 'Kelly Barnes', 'Buffalo Creek', 'Baldwin Hills']) assert.ok(HISTORICAL_FAILURES.some((f) => f.name.startsWith(n)), n);
  assert.equal(TETON.peak, 65_120);
});

test('scored on the failures, Froehlich 1995 is the best relation, so it is the central case', () => {
  const scores = scoreRelations(RELATIONS);
  const rows = scores.map((s) => `${s.id.padEnd(15)} n ${String(s.n).padStart(2)}  bias ${(s.meanLog >= 0 ? '+' : '') + s.meanLog.toFixed(2)}  rms ${s.rmsLog.toFixed(2)}  ×2 ${Math.round(100 * s.withinFactor2)
    .toString()
    .padStart(3)} %  Teton ${s.teton?.toFixed(2)}`);
  console.log(`Breach relations vs ${HISTORICAL_FAILURES.length} historical failures (log10 errors):\n${rows.join('\n')}`);
  const best = [...scores].sort((a, b) => a.rmsLog - b.rmsLog)[0];
  assert.equal(best.id, CENTRAL_RELATION);
  const f95 = scores.find((s) => s.id === 'froehlich1995')!;
  assert.equal(f95.n, 21);
  assert.equal(f95.withinFactor2, 1);
  assert.ok(f95.rmsLog < 0.16 && Math.abs(f95.meanLog) < 0.1, JSON.stringify(f95));
  // Every relation applies to at least 20 of the 21 (Xu & Zhang skips concrete-faced Swift), and none is wild on average.
  for (const s of scores) {
    assert.ok(s.n >= 20, s.id);
    assert.ok(s.rmsLog < 0.4 && Math.abs(s.meanLog) < 0.3, JSON.stringify(s));
  }
  // The routed Froehlich 2008 breach (the map's earlier default) over-predicts on average and Teton by ~64 %.
  const f08 = scores.find((s) => s.id === 'froehlich2008')!;
  assert.ok(f08.meanLog > 0 && f08.rmsLog > f95.rmsLog && f08.teton! > 1.5 && f08.teton! < 1.8, JSON.stringify(f08));
});

test('the band: low ≤ central ≤ high; it brackets 17 of the 21 observed peaks, and says which it misses', () => {
  const outside: string[] = [];
  for (const f of HISTORICAL_FAILURES) {
    const b = peakBand(historicalCase(f));
    assert.ok(b.low.peak <= b.central.peak && b.central.peak <= b.high.peak, f.name);
    assert.equal(b.central.id, CENTRAL_RELATION);
    if (!(b.low.peak <= f.peak && f.peak <= b.high.peak)) outside.push(f.name.split(',')[0]);
  }
  // Every relation under-predicts three small, deep reservoirs (Baldwin Hills just, by 9 %; Buffalo Creek, a coal-waste
  // dam, and Laurel Run by 14–60 %) and over-predicts Lower Latham (by 4 %). The band is the relations' disagreement,
  // not a confidence interval.
  assert.deepEqual(outside, ['Baldwin Hills', 'Buffalo Creek', 'Laurel Run', 'Lower Latham']);
});

test('arrival times scale as peak^−0.4 (kinematic wave, wide Manning channel), and stay put for the same peak', () => {
  assert.equal(ARRIVAL_EXPONENT, 0.4);
  assert.equal(scaledArrival(600, 1000, 1000), 600);
  assert.ok(Math.abs(scaledArrival(600, 1000, 2000) - 600 * Math.pow(0.5, 0.4)) < 1e-9);
  assert.ok(scaledArrival(600, 1000, 500) > 600);
  assert.equal(scaledArrival(600, 0, 500), 600);
});
