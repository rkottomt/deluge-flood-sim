/**
 * Benefit–cost analysis of a mitigation design, FEMA-BCA style (pure, no DOM; tests/loss/bca.test.ts).
 *
 *   benefit   ΔEAL = EAL(before) − EAL(after), both integrated over the SAME return-period ladder by eal.ts (trapezoid
 *             over annual exceedance probability, with the tail term L_N / T_N unless asked otherwise)
 *   PV        PV(benefits) = ΔEAL · UPV(r, n);  PV(costs) = construction + O&M · UPV(r, n);  UPV = (1 − (1+r)^−n) / r
 *   outputs   BCR = PV(benefits) / PV(costs), net benefit = PV(benefits) − PV(costs), and the break-even construction
 *             cost = PV(benefits) − PV(O&M): the most the project can cost and still reach BCR 1
 *
 * A BCR from one run is never certain. analyzeBca recomputes it at the corners of every uncertainty it is given — the
 * damage curves at −1σ and +1σ (before AND after at the same σ: the curve error is shared by both), the construction
 * cost band, the hazard-input ensemble's p10 / p90 loss as a ratio to its p50, and the EAL with and without the tail —
 * and reports the range and which uncertainties it includes. What it never includes is listed in BCA_NOT_INCLUDED.
 *
 * ─── Defaults and their sources ───────────────────────────────────────────────────────────────────────────────────
 * Discount rate 7 % real: OMB Circular A-94 (1992). OMB revoked the November 2023 A-94 update (3.1 %) on 8 April 2025
 * and reinstated the 1992 circular; FEMA's BCA Toolkit made 7 % its default again in its 4 June 2025 release, and Hazard
 * Mitigation Assistance projects not awarded by 8 April 2025 must use it. 3.1 % stays selectable in the Toolkit (with a
 * warning) for reviewing BCAs done under the revoked rate. (fema.gov "Benefit-Cost Analysis" discount-rate notice and
 * the BCA policy aid on the discount rate, 2025; ASFPM "FEMA Rolls Back BCA Rates", 2025.)
 *
 * Project useful life: FEMA BCA Reference Guide (June 2009), Appendix D "Project Useful Life Summary" — the standard
 * values the Toolkit's help still lists; a value inside the "acceptable limits" needs documentation, outside them FEMA
 * will not accept it.
 */
import { DISCOUNT_RATE_FEMA, DISCOUNT_RATE_LOW, eal, upv, type MitigationType } from './eal';

/** The FEMA BCA Toolkit's default discount rate (7 %, OMB A-94 1992; see the header). */
export const BCA_DEFAULT_RATE = DISCOUNT_RATE_FEMA;
/** The revoked 2023 A-94 rate, still selectable in the Toolkit for older BCAs. */
export const BCA_ALT_RATE = DISCOUNT_RATE_LOW;

/** Bounds every BCA input is held to (the panel clamps, the project reader refuses). */
export const BCA_LIMITS = {
  /** Real discount rate, as a fraction. */
  rate: [0, 0.2] as const,
  /** Project useful life, whole years. */
  years: [1, 200] as const,
  /** Analysis (dollar) year. */
  analysisYear: [1990, 2200] as const,
  /** Money, USD. */
  money: [0, 1e13] as const,
};

export type UsefulLifeKind = MitigationType | 'elevationResidential' | 'elevationNonResidential' | 'dryFloodproofing' | 'acquisition';

export interface UsefulLifeEntry {
  /** FEMA's standard value, years. */
  years: number;
  /** FEMA's acceptable limits (documentation required inside them, not accepted outside). */
  range: readonly [number, number];
  /** The row of FEMA's table it comes from. */
  row: string;
}

/** FEMA BCA Reference Guide (2009) Appendix D, the rows Deluge's mitigation options map to. */
export const USEFUL_LIFE: Readonly<Record<UsefulLifeKind, UsefulLifeEntry>> = {
  floodwall: { years: 50, range: [35, 50], row: 'Concrete infrastructure, flood walls, roads, bridges, major drainage system' },
  earthen: { years: 50, range: [35, 100], row: 'Major infrastructure (minor localized flood reduction projects)' },
  gabion: { years: 50, range: [35, 100], row: 'Major infrastructure (minor localized flood reduction projects)' },
  elevationResidential: { years: 30, range: [30, 50], row: 'Elevation — residential building' },
  elevationNonResidential: { years: 25, range: [25, 50], row: 'Elevation — non-residential building' },
  dryFloodproofing: { years: 25, range: [25, 50], row: 'Non-residential building retrofit' },
  acquisition: { years: 100, range: [100, 100], row: 'Acquisition / relocation — all structures' },
};

export const USEFUL_LIFE_SOURCE = 'FEMA BCA Reference Guide (June 2009), Appendix D, Project Useful Life Summary';
export const DISCOUNT_RATE_SOURCE = 'OMB Circular A-94 (1992), reinstated 8 April 2025; FEMA BCA Toolkit default since 4 June 2025';

/** What a BCR range from a screening model never includes; shown with every result. */
export const BCA_NOT_INCLUDED = [
  'the return periods themselves (a published or typed number is taken as exact)',
  'what the model leaves out (bare-earth terrain, no drains or bridges), the same in every run',
  'the discount rate and useful life (inputs: change them to test them)',
] as const;

/** FEMA's standard useful life for the kind (a kind not in the table: the flood-wall value). */
export function defaultUsefulLife(kind: UsefulLifeKind): number {
  return (Object.prototype.hasOwnProperty.call(USEFUL_LIFE, kind) ? USEFUL_LIFE[kind] : USEFUL_LIFE.floodwall).years;
}

/** A useful life outside FEMA's acceptable limits for the kind: say so next to it. */
export function usefulLifeOutsideLimits(kind: UsefulLifeKind, years: number): boolean {
  const r = USEFUL_LIFE[kind].range;
  return years < r[0] || years > r[1];
}

// ─── Benefit ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LadderLoss {
  /** Return period, years; null or ≤ 0 = the level does not enter the EAL. */
  T: number | null;
  before: number;
  after: number;
}

export interface AvoidedEal {
  before: number;
  after: number;
  /** before − after: negative when the design makes losses worse. */
  avoided: number;
  /** Levels that entered the integral. */
  levels: number;
}

/**
 * EAL before and after over the same ladder (eal.ts), and the avoided EAL. Only levels with a return period and a
 * finite loss on BOTH sides enter, so the two integrals always span the same probabilities. Null without one.
 */
export function avoidedEal(levels: readonly LadderLoss[], tail = true): AvoidedEal | null {
  const ok = levels.filter((l) => l.T != null && l.T > 0 && Number.isFinite(l.before) && Number.isFinite(l.after));
  if (!ok.length) return null;
  const before = eal(ok.map((l) => ({ T: l.T as number, loss: l.before })), tail);
  const after = eal(ok.map((l) => ({ T: l.T as number, loss: l.after })), tail);
  return { before, after, avoided: before - after, levels: ok.length };
}

// ─── Present value ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BcaInputs {
  /** Construction (capital) cost, USD. */
  capex: number;
  /** Annual operation & maintenance, USD/yr. */
  omPerYear: number;
  /** Project useful life, years. */
  years: number;
  /** Real discount rate, fraction (0.07). */
  rate: number;
}

export interface BcaResult {
  deltaEal: number;
  /** Uniform present-value factor UPV(rate, years). */
  factor: number;
  pvBenefits: number;
  pvOm: number;
  pvCosts: number;
  /** +∞ when there is a benefit and no cost at all; NaN when there is neither. */
  bcr: number;
  netBenefit: number;
  /** Most the construction can cost for BCR ≥ 1 (PV benefits − PV O&M); ≤ 0: no construction cost breaks even. */
  breakEvenCapex: number;
}

export function bca(deltaEal: number, i: BcaInputs): BcaResult {
  const factor = upv(i.rate, i.years);
  const pvBenefits = deltaEal * factor;
  const pvOm = Math.max(0, i.omPerYear) * factor;
  const pvCosts = Math.max(0, i.capex) + pvOm;
  const bcr = pvCosts > 0 ? pvBenefits / pvCosts : pvBenefits > 0 ? Infinity : pvBenefits < 0 ? -Infinity : NaN;
  return { deltaEal, factor, pvBenefits, pvOm, pvCosts, bcr, netBenefit: pvBenefits - pvCosts, breakEvenCapex: pvBenefits - pvOm };
}

/** BCR as text: "∞" for a benefit at no cost, "—" for nothing to divide, two decimals below 10. */
export function bcrText(v: number): string {
  if (Number.isNaN(v)) return '—';
  if (v === Infinity) return '∞';
  if (v === -Infinity) return '−∞';
  const d = Math.abs(v) < 10 ? 2 : 1;
  const s = (Math.round(Math.abs(v) * 10 ** d) / 10 ** d).toFixed(d);
  return v < 0 && Number(s) !== 0 ? `−${s}` : s;
}

/** "0.41 – 1.30", or one value when the ends agree to the digits shown. */
export function bcrRangeText(lo: number, hi: number): string {
  const a = bcrText(lo);
  const b = bcrText(hi);
  return a === b ? a : `${a} – ${b}`;
}

// ─── Uncertainty ───────────────────────────────────────────────────────────────────────────────────────────────────

/** One ladder level with its damage-curve ±1σ losses, before and after. */
export interface LadderLossBand {
  T: number | null;
  before: number;
  beforeLo: number;
  beforeHi: number;
  after: number;
  afterLo: number;
  afterHi: number;
}

/** The ensemble's loss spread as ratios to its p50 (src/loss/ensemble.ts summary), and what it came from. */
export interface EnsembleSpread {
  p10: number;
  p90: number;
  members: number;
}

/** p10 / p50 and p90 / p50 of an ensemble's loss band; null when its p50 is not a positive number. */
export function ensembleSpread(loss: readonly [number, number, number], members: number): EnsembleSpread | null {
  const [a, m, b] = loss;
  if (!(m > 0) || !Number.isFinite(m) || !Number.isFinite(a) || !Number.isFinite(b) || members < 2) return null;
  return { p10: Math.max(0, a / m), p90: Math.max(0, b / m), members };
}

export interface BcaUncertaintyInput {
  levels: readonly LadderLossBand[];
  /** Construction cost, mid and its band (equal when the user typed a figure). */
  capex: number;
  capexLo: number;
  capexHi: number;
  omPerYear: number;
  years: number;
  rate: number;
  ensemble: EnsembleSpread | null;
}

export type BcaUncertainty = 'curve' | 'cost' | 'ensemble' | 'tail';

export const BCA_UNCERTAINTY_LABELS: Readonly<Record<BcaUncertainty, string>> = {
  curve: 'damage curves ±1σ (before and after together)',
  cost: 'construction cost band',
  ensemble: 'hazard inputs: the ensemble’s loss p10–p90',
  tail: 'EAL with / without the tail beyond the rarest level',
};

export type BcaVerdict = 'pays' | 'uncertain' | 'doesNotPay' | 'worse' | 'none';

export interface BcaAnalysis {
  eal: AvoidedEal;
  /** EAL without the tail term (the other end of the tail uncertainty). */
  ealNoTail: AvoidedEal;
  central: BcaResult;
  /** Damage curves at −1σ / +1σ (null when the curve band is not a number). */
  curve: { lo: BcaResult; hi: BcaResult } | null;
  /** Construction cost at the low / high end of its band (null without a band). */
  cost: { lo: BcaResult; hi: BcaResult } | null;
  /** The ensemble's p10 / p50 / p90 applied to the avoided EAL as a ratio (null when it has not run). */
  ensemble: { p10: BcaResult; p50: BcaResult; p90: BcaResult; members: number } | null;
  /** Lowest and highest over every corner of the uncertainties included. */
  range: { bcr: [number, number]; netBenefit: [number, number]; deltaEal: [number, number]; breakEvenCapex: [number, number] };
  included: BcaUncertainty[];
  verdict: BcaVerdict;
}

const minMax = (xs: number[]): [number, number] => {
  const f = xs.filter((x) => !Number.isNaN(x));
  return f.length ? [Math.min(...f), Math.max(...f)] : [NaN, NaN];
};

/**
 * The BCA with its range. Null when no level has a return period (no EAL, so no benefit to discount).
 *
 * Corners: avoided EAL ∈ {curve −1σ, central, curve +1σ} × {tail, no tail} × {ensemble p10, 1, p90}, construction cost
 * ∈ {low, mid, high}. BCR, net benefit and break-even cost are monotonic in each, so the corners bound them.
 */
export function analyzeBca(i: BcaUncertaintyInput): BcaAnalysis | null {
  const inputs = (capex: number): BcaInputs => ({ capex, omPerYear: i.omPerYear, years: i.years, rate: i.rate });
  const ladder = (pick: 'mid' | 'lo' | 'hi'): LadderLoss[] =>
    i.levels.map((l) => ({ T: l.T, before: pick === 'mid' ? l.before : pick === 'lo' ? l.beforeLo : l.beforeHi, after: pick === 'mid' ? l.after : pick === 'lo' ? l.afterLo : l.afterHi }));
  const mid = avoidedEal(ladder('mid'), true);
  const midNoTail = avoidedEal(ladder('mid'), false);
  if (!mid || !midNoTail) return null;
  const central = bca(mid.avoided, inputs(i.capex));
  const included: BcaUncertainty[] = [];

  const lo = avoidedEal(ladder('lo'), true);
  const hi = avoidedEal(ladder('hi'), true);
  const differs = (x: number) => Math.abs(x - mid.avoided) > 1e-9 * Math.max(1, Math.abs(mid.avoided));
  const curveOk = !!lo && !!hi && lo.levels === mid.levels && hi.levels === mid.levels && (differs(lo.avoided) || differs(hi.avoided));
  const curve = curveOk ? { lo: bca(lo!.avoided, inputs(i.capex)), hi: bca(hi!.avoided, inputs(i.capex)) } : null;
  if (curve) included.push('curve');

  const hasCostBand = Number.isFinite(i.capexLo) && Number.isFinite(i.capexHi) && (i.capexLo !== i.capex || i.capexHi !== i.capex);
  const cost = hasCostBand ? { lo: bca(mid.avoided, inputs(i.capexLo)), hi: bca(mid.avoided, inputs(i.capexHi)) } : null;
  if (cost) included.push('cost');

  const ens = i.ensemble;
  const ensemble = ens ? { p10: bca(mid.avoided * ens.p10, inputs(i.capex)), p50: central, p90: bca(mid.avoided * ens.p90, inputs(i.capex)), members: ens.members } : null;
  if (ensemble) included.push('ensemble');

  // With and without the tail is a real choice only with two levels or more: on one level the integral without the
  // tail is zero by construction (no width to integrate over), which bounds nothing.
  const tailDiffers = mid.levels >= 2 && Math.abs(midNoTail.avoided - mid.avoided) > 1e-9 * Math.max(1, Math.abs(mid.avoided));
  if (tailDiffers) included.push('tail');

  // Corners.
  const deltas: number[] = [];
  const sets: Array<{ tail: boolean; curve: 'mid' | 'lo' | 'hi' }> = [];
  for (const tail of tailDiffers ? [true, false] : [true]) for (const c of curve ? (['mid', 'lo', 'hi'] as const) : (['mid'] as const)) sets.push({ tail, curve: c });
  for (const s of sets) {
    const a = avoidedEal(ladder(s.curve), s.tail);
    if (!a) continue;
    for (const k of ens ? [1, ens.p10, ens.p90] : [1]) deltas.push(a.avoided * k);
  }
  const capexes = cost ? [i.capex, i.capexLo, i.capexHi] : [i.capex];
  const corners = deltas.flatMap((d) => capexes.map((c) => bca(d, inputs(c))));
  const range = {
    bcr: minMax(corners.map((r) => r.bcr)),
    netBenefit: minMax(corners.map((r) => r.netBenefit)),
    deltaEal: minMax(deltas),
    breakEvenCapex: minMax(corners.map((r) => r.breakEvenCapex)),
  };
  return { eal: mid, ealNoTail: midNoTail, central, curve, cost, ensemble, range, included, verdict: verdictOf(range.bcr, range.deltaEal) };
}

/** Pays only when the whole range clears 1; "worse" when the design adds loss even at its best. */
export function verdictOf(bcrRange: readonly [number, number], deltaRange: readonly [number, number]): BcaVerdict {
  const [lo, hi] = bcrRange;
  if (Number.isNaN(lo) || Number.isNaN(hi)) return 'none';
  if (deltaRange[1] < 0) return 'worse';
  if (lo >= 1) return 'pays';
  if (hi < 1) return 'doesNotPay';
  return 'uncertain';
}

export const BCA_VERDICT_TEXT: Readonly<Record<BcaVerdict, string>> = {
  pays: 'Pays across the whole range (BCR ≥ 1 at every corner)',
  uncertain: 'Uncertain: the range straddles BCR 1',
  doesNotPay: 'Does not pay anywhere in the range (BCR < 1)',
  worse: 'Makes expected losses worse',
  none: 'No benefit or cost to compare',
};

// ─── FEMA BCA Toolkit transcription ────────────────────────────────────────────────────────────────────────────────

export interface DamageFrequencyRow {
  /** Recurrence interval, years. */
  T: number;
  label: string;
  before: number;
  after: number;
  /** Where the return period came from. */
  rpFrom: 'source' | 'user' | null;
}

/**
 * The rows an engineer types into the Toolkit's Damage-Frequency Assessment (expected damages before and after
 * mitigation per recurrence interval): the levels with a return period and a finite loss on both sides, by recurrence
 * interval, rarest last. Levels sharing a return period keep the larger damages (the Toolkit takes one row per interval).
 */
export function damageFrequencyRows(levels: ReadonlyArray<{ label: string; returnPeriod: number | null; rpFrom: 'source' | 'user' | null }>, before: readonly number[], after: readonly number[]): DamageFrequencyRow[] {
  const byT = new Map<number, DamageFrequencyRow>();
  levels.forEach((l, k) => {
    const T = l.returnPeriod;
    const b = before[k];
    const a = after[k];
    if (T == null || !(T > 0) || !Number.isFinite(b) || !Number.isFinite(a)) return;
    const prev = byT.get(T);
    if (!prev || b > prev.before) byT.set(T, { T, label: l.label, before: Math.max(0, b), after: Math.max(0, a), rpFrom: l.rpFrom });
  });
  return [...byT.values()].sort((x, y) => x.T - y.T);
}
