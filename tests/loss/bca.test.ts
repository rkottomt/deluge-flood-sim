/**
 * Benefit–cost analysis of a design (src/loss/bca.ts): discounting against a year-by-year sum, the avoided EAL against
 * eal.ts, the range over its uncertainties, the edge cases (no cost, a design that makes things worse, no return
 * period) and the FEMA BCA Toolkit rows.
 * Run: node --import tsx --test tests/loss/bca.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeBca,
  avoidedEal,
  bca,
  BCA_ALT_RATE,
  BCA_DEFAULT_RATE,
  BCA_LIMITS,
  bcrRangeText,
  bcrText,
  damageFrequencyRows,
  defaultUsefulLife,
  ensembleSpread,
  USEFUL_LIFE,
  usefulLifeOutsideLimits,
  verdictOf,
  type LadderLossBand,
} from '../../src/loss/bca';
import { eal, upv } from '../../src/loss/eal';

const close = (a: number, b: number, tol = 1e-9, msg = '') => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg} ${a} vs ${b}`);

/** Present value the slow way: Σ x / (1 + r)^t, t = 1 … n. */
const pvSum = (x: number, r: number, n: number) => {
  let s = 0;
  for (let t = 1; t <= n; t++) s += x / Math.pow(1 + r, t);
  return s;
};

test('defaults: the FEMA BCA Toolkit rate is 7 % (3.1 % alongside), useful lives from FEMA’s Appendix D', () => {
  assert.equal(BCA_DEFAULT_RATE, 0.07);
  assert.equal(BCA_ALT_RATE, 0.031);
  assert.equal(USEFUL_LIFE.floodwall.years, 50);
  assert.deepEqual(USEFUL_LIFE.floodwall.range, [35, 50]);
  assert.equal(USEFUL_LIFE.earthen.years, 50);
  assert.equal(USEFUL_LIFE.elevationResidential.years, 30);
  assert.equal(USEFUL_LIFE.elevationNonResidential.years, 25);
  assert.equal(USEFUL_LIFE.dryFloodproofing.years, 25);
  assert.equal(USEFUL_LIFE.acquisition.years, 100);
  assert.equal(defaultUsefulLife('gabion'), 50);
  assert.equal(defaultUsefulLife('nonsense' as never), 50, 'an unknown kind falls back to the flood-wall row');
  assert.ok(!usefulLifeOutsideLimits('floodwall', 50));
  assert.ok(usefulLifeOutsideLimits('floodwall', 75), 'flood walls stop at 50 yr in FEMA’s table');
  assert.ok(!usefulLifeOutsideLimits('earthen', 75));
  assert.ok(usefulLifeOutsideLimits('elevationResidential', 20));
  for (const k of Object.keys(USEFUL_LIFE) as Array<keyof typeof USEFUL_LIFE>) {
    const u = USEFUL_LIFE[k];
    assert.ok(u.years >= u.range[0] && u.years <= u.range[1] && u.years >= BCA_LIMITS.years[0] && u.years <= BCA_LIMITS.years[1], k);
  }
});

test('discounting: PV of benefits and O&M equals the year-by-year sum', () => {
  for (const [r, n] of [
    [0.07, 50],
    [0.031, 30],
    [0.07, 1],
    [0.15, 100],
  ] as const) {
    const x = bca(123_456, { capex: 1e6, omPerYear: 20_000, years: n, rate: r });
    close(x.factor, upv(r, n));
    close(x.pvBenefits, pvSum(123_456, r, n), 1e-9, `benefits r=${r} n=${n}`);
    close(x.pvOm, pvSum(20_000, r, n), 1e-9, `O&M r=${r} n=${n}`);
    close(x.pvCosts, 1e6 + pvSum(20_000, r, n));
    close(x.bcr, x.pvBenefits / x.pvCosts);
    close(x.netBenefit, x.pvBenefits - x.pvCosts);
  }
  // 7 % over 50 years: the factor is 13.80; $1 M a year is worth $13.8 M today.
  close(upv(0.07, 50), 13.8007, 1e-5);
  // A zero rate is plain multiplication.
  const z = bca(1000, { capex: 0, omPerYear: 0, years: 40, rate: 0 });
  assert.equal(z.pvBenefits, 40_000);
});

test('break-even construction cost is where BCR reaches exactly 1', () => {
  const inp = { omPerYear: 15_000, years: 50, rate: 0.07 };
  const x = bca(400_000, { ...inp, capex: 1 });
  close(x.breakEvenCapex, x.pvBenefits - x.pvOm);
  const at = bca(400_000, { ...inp, capex: x.breakEvenCapex });
  close(at.bcr, 1, 1e-12);
  close(at.netBenefit, 0, 1e-6);
  // O&M worth more than the benefit: no construction cost breaks even.
  const no = bca(10_000, { omPerYear: 50_000, years: 50, rate: 0.07, capex: 0 });
  assert.ok(no.breakEvenCapex < 0);
  assert.ok(no.bcr < 1);
});

test('zero cost: a benefit gives an infinite BCR, shown as ∞; nothing at all gives —', () => {
  const free = bca(5_000, { capex: 0, omPerYear: 0, years: 50, rate: 0.07 });
  assert.equal(free.bcr, Infinity);
  assert.equal(bcrText(free.bcr), '∞');
  assert.ok(free.netBenefit > 0);
  const nothing = bca(0, { capex: 0, omPerYear: 0, years: 50, rate: 0.07 });
  assert.ok(Number.isNaN(nothing.bcr));
  assert.equal(bcrText(nothing.bcr), '—');
  const worseFree = bca(-5_000, { capex: 0, omPerYear: 0, years: 50, rate: 0.07 });
  assert.equal(worseFree.bcr, -Infinity);
  assert.equal(bcrText(worseFree.bcr), '−∞');
  // Negative costs are not a thing: clamped to zero.
  assert.equal(bca(1, { capex: -5, omPerYear: -5, years: 10, rate: 0.07 }).pvCosts, 0);
});

test('bcrText: two decimals below 10, one above, a real minus sign, no "−0.00"', () => {
  assert.equal(bcrText(0.8234), '0.82');
  assert.equal(bcrText(12.345), '12.3');
  assert.equal(bcrText(-0.5), '−0.50');
  assert.equal(bcrText(-0.001), '0.00');
  assert.equal(bcrRangeText(0.41, 1.3), '0.41 – 1.30');
  assert.equal(bcrRangeText(0.821, 0.824), '0.82');
});

test('avoided EAL is eal.ts before minus after over the same ladder, with and without the tail', () => {
  const ladder = [
    { T: 10, before: 1e6, after: 0 },
    { T: 100, before: 10e6, after: 2e6 },
    { T: 500, before: 60e6, after: 40e6 },
    { T: null, before: 99e6, after: 0 }, // no return period: not in the integral
  ];
  for (const tail of [true, false]) {
    const a = avoidedEal(ladder, tail)!;
    const b = eal(ladder.filter((l) => l.T).map((l) => ({ T: l.T!, loss: l.before })), tail);
    const c = eal(ladder.filter((l) => l.T).map((l) => ({ T: l.T!, loss: l.after })), tail);
    close(a.before, b);
    close(a.after, c);
    close(a.avoided, b - c);
    assert.equal(a.levels, 3);
  }
  // By hand, with the tail: ½(1+10)(0.1−0.01) + ½(10+60)(0.01−0.002) + 60/500 = 0.495 + 0.28 + 0.12 = 0.895 ($M)
  close(avoidedEal(ladder)!.before, 0.895e6);
  // A level with a loss on one side only drops out of BOTH integrals, so they span the same probabilities.
  const gap = avoidedEal([
    { T: 10, before: 1e6, after: NaN },
    { T: 100, before: 10e6, after: 2e6 },
  ])!;
  assert.equal(gap.levels, 1);
  close(gap.before, 10e6 / 100);
  close(gap.after, 2e6 / 100);
  assert.equal(avoidedEal([{ T: null, before: 1, after: 0 }]), null);
  assert.equal(avoidedEal([]), null);
});

const band = (T: number | null, before: number, after: number, k = 0.3): LadderLossBand => ({ T, before, beforeLo: before * (1 - k), beforeHi: before * (1 + k), after, afterLo: after * (1 - k), afterHi: after * (1 + k) });

test('analyzeBca: central BCR, the damage-curve ±1σ, the cost band, and the range over every corner', () => {
  const levels = [band(100, 10e6, 0), band(500, 100e6, 30e6)];
  const base = { levels, capex: 6e6, capexLo: 3e6, capexHi: 9e6, omPerYear: 0, years: 50, rate: 0.07, ensemble: null };
  const a = analyzeBca(base)!;
  const dE = 0.5 * (10e6 + 70e6) * (0.01 - 0.002) + 70e6 / 500; // avoided, with the tail
  close(a.eal.avoided, dE);
  close(a.central.bcr, (dE * upv(0.07, 50)) / 6e6);
  // Curve ±30 % on both sides scales the avoided loss by 0.7 / 1.3.
  close(a.curve!.lo.bcr, a.central.bcr * 0.7);
  close(a.curve!.hi.bcr, a.central.bcr * 1.3);
  close(a.cost!.lo.bcr, a.central.bcr * 2);
  close(a.cost!.hi.bcr, a.central.bcr * (2 / 3));
  // Lowest corner: curve −1σ, no tail, the high cost; highest: +1σ, tail, the low cost.
  const dNoTail = 0.5 * (10e6 + 70e6) * 0.008;
  close(a.range.bcr[0], (0.7 * dNoTail * upv(0.07, 50)) / 9e6);
  close(a.range.bcr[1], (1.3 * dE * upv(0.07, 50)) / 3e6);
  close(a.range.deltaEal[0], 0.7 * dNoTail);
  close(a.range.deltaEal[1], 1.3 * dE);
  assert.deepEqual(a.included, ['curve', 'cost', 'tail']);
  assert.ok(a.range.bcr[0] <= a.central.bcr && a.central.bcr <= a.range.bcr[1]);
  assert.ok(a.range.netBenefit[0] <= a.central.netBenefit && a.central.netBenefit <= a.range.netBenefit[1]);
  assert.equal(a.ensemble, null);
  assert.equal(a.verdict, 'uncertain');
});

test('analyzeBca: the ensemble’s p10 / p90 loss ratios scale the avoided EAL, and are labelled as included', () => {
  const sp = ensembleSpread([6e6, 10e6, 18e6], 12)!;
  close(sp.p10, 0.6);
  close(sp.p90, 1.8);
  const a = analyzeBca({ levels: [band(100, 10e6, 2e6, 0)], capex: 5e6, capexLo: 5e6, capexHi: 5e6, omPerYear: 0, years: 50, rate: 0.07, ensemble: sp })!;
  close(a.ensemble!.p10.bcr, a.central.bcr * 0.6);
  close(a.ensemble!.p90.bcr, a.central.bcr * 1.8);
  assert.equal(a.ensemble!.p50, a.central);
  assert.equal(a.ensemble!.members, 12);
  // A zero curve band and a typed cost (no band): neither is claimed as included.
  assert.ok(a.included.includes('ensemble'));
  assert.ok(!a.included.includes('cost'));
  assert.ok(!a.included.includes('curve'));
  assert.equal(a.curve, null);
  // One level: without the tail the integral is zero by construction, so it is not a bound (no 0.00 floor).
  assert.ok(!a.included.includes('tail'));
  close(a.range.bcr[0], a.central.bcr * 0.6);
  close(a.range.bcr[1], a.central.bcr * 1.8);
  // No usable ensemble: a p50 of zero, or not a number.
  assert.equal(ensembleSpread([0, 0, 5], 12), null);
  assert.equal(ensembleSpread([NaN, NaN, NaN], 12), null);
  assert.equal(ensembleSpread([1, 2, 3], 1), null);
});

test('a design that makes things worse: negative avoided EAL, negative BCR, verdict "worse"', () => {
  const a = analyzeBca({ levels: [band(100, 1e6, 3e6), band(500, 5e6, 9e6)], capex: 2e6, capexLo: 1e6, capexHi: 3e6, omPerYear: 10_000, years: 50, rate: 0.07, ensemble: null })!;
  assert.ok(a.eal.avoided < 0);
  assert.ok(a.central.bcr < 0);
  assert.ok(a.central.netBenefit < -2e6);
  assert.ok(a.central.breakEvenCapex < 0);
  assert.ok(a.range.bcr[1] < 0);
  assert.equal(a.verdict, 'worse');
});

test('zero cost in analyzeBca: an infinite BCR is the range’s top, and the verdict still holds', () => {
  const a = analyzeBca({ levels: [band(100, 1e6, 0, 0)], capex: 0, capexLo: 0, capexHi: 0, omPerYear: 0, years: 50, rate: 0.07, ensemble: null })!;
  assert.equal(a.central.bcr, Infinity);
  assert.equal(a.range.bcr[1], Infinity);
  assert.equal(a.verdict, 'pays');
  assert.equal(bcrRangeText(a.range.bcr[0], a.range.bcr[1]), '∞');
});

test('no return period: no analysis (nothing invented)', () => {
  assert.equal(analyzeBca({ levels: [band(null, 5e6, 1e6)], capex: 1e6, capexLo: 1e6, capexHi: 1e6, omPerYear: 0, years: 50, rate: 0.07, ensemble: null }), null);
});

test('a curve range that is not a number falls back to no curve band, not to a NaN range', () => {
  const l: LadderLossBand = { T: 100, before: 5e6, beforeLo: NaN, beforeHi: NaN, after: 1e6, afterLo: NaN, afterHi: NaN };
  const a = analyzeBca({ levels: [l], capex: 1e6, capexLo: 1e6, capexHi: 1e6, omPerYear: 0, years: 50, rate: 0.07, ensemble: null })!;
  assert.equal(a.curve, null);
  assert.ok(!a.included.includes('curve'));
  assert.ok(Number.isFinite(a.range.bcr[0]) && Number.isFinite(a.range.bcr[1]));
});

test('verdicts: pays only when the whole range clears 1', () => {
  assert.equal(verdictOf([1.1, 2], [1, 2]), 'pays');
  assert.equal(verdictOf([1, 1], [1, 1]), 'pays');
  assert.equal(verdictOf([0.9, 1.4], [1, 2]), 'uncertain');
  assert.equal(verdictOf([0.1, 0.9], [1, 2]), 'doesNotPay');
  assert.equal(verdictOf([-2, -1], [-5, -1]), 'worse');
  assert.equal(verdictOf([NaN, NaN], [0, 0]), 'none');
});

test('FEMA BCA Toolkit rows: damages before / after per recurrence interval, sorted, levels without one left out', () => {
  const levels = [
    { label: '1936 crest', returnPeriod: 500, rpFrom: 'user' as const },
    { label: 'NWS minor', returnPeriod: null, rpFrom: null },
    { label: 'FEMA 1 %', returnPeriod: 100, rpFrom: 'source' as const },
    { label: 'Another 1 %', returnPeriod: 100, rpFrom: 'source' as const },
    { label: 'No buildings', returnPeriod: 50, rpFrom: 'source' as const },
  ];
  const rows = damageFrequencyRows(levels, [12e9, 1, 7.9e8, 9e8, NaN], [10e9, 0, 7.4e8, 8e8, NaN]);
  assert.deepEqual(
    rows.map((r) => [r.T, r.label, r.before, r.after, r.rpFrom]),
    [
      [100, 'Another 1 %', 9e8, 8e8, 'source'],
      [500, '1936 crest', 12e9, 10e9, 'user'],
    ],
  );
});
