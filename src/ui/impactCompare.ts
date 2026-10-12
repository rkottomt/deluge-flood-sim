/**
 * Before/after a mitigation, from two runs of the same scenario (pure, no DOM).
 *
 * The user sets a BASELINE (a run without the new wall), builds the wall, replays the flood and recomputes. The
 * difference is the avoided loss of this one event. Buildings that end up WETTER with the wall — water the wall
 * pushed elsewhere — are counted on their own line rather than quietly netted off: that is the "transferred risk" a
 * council will ask about.
 *
 * The comparison is only as fair as the runs: it warns when the two differ in place, forcing, or how far the flood got.
 */
import {
  bcr,
  breakEvenReturnPeriod,
  DISCOUNT_RATE_FEMA,
  DISCOUNT_RATE_LOW,
  mitigationCost,
  REACHED_DEPTH,
  USEFUL_LIFE_WALL_YEARS,
  type CostCountry,
  type ImpactSummary,
  type MitigationType,
} from '../loss';

/** What a run was a run OF. */
export interface RunSignature {
  terrainName: string;
  presetId: string | null;
  simTime: number;
  /** River stage offset applied, m. */
  stageOffset: number;
  rainRate: number;
  /** Sources and storms, as a short canonical string. */
  forcing: string;
  wallCells: number;
}

export interface RunSnapshot {
  sig: RunSignature;
  summary: ImpactSummary;
  /** Per building index: loss and max depth (only buildings with any water). */
  buildings: Map<number, { loss: number; depth: number }>;
}

export interface Comparison {
  baseline: RunSignature;
  avoided: number;
  avoidedLo: number;
  avoidedHi: number;
  /** Reached in the baseline, not with the wall. */
  noLongerReached: number;
  /** Reached with the wall, not in the baseline (transferred risk), and their loss now. */
  newlyReached: number;
  newlyReachedLoss: number;
  /** Buildings whose loss went UP with the wall, and by how much in total. */
  worse: number;
  worseLoss: number;
  warnings: string[];
}

/** Times this far apart (s, or this fraction of the later one) make the runs not comparable. */
const TIME_TOLERANCE_S = 60;
const TIME_TOLERANCE_FRAC = 0.1;

export function compareRuns(base: RunSnapshot, cur: RunSnapshot): Comparison {
  const warnings: string[] = [];
  const a = base.sig;
  const b = cur.sig;
  if (a.terrainName !== b.terrainName) warnings.push('The baseline was run on a different map; the comparison is meaningless.');
  const dt = Math.abs(a.simTime - b.simTime);
  if (dt > Math.max(TIME_TOLERANCE_S, TIME_TOLERANCE_FRAC * Math.max(a.simTime, b.simTime))) {
    warnings.push(`The runs stopped at different times (T+${Math.round(a.simTime / 60)} min vs T+${Math.round(b.simTime / 60)} min): part of the difference is just the flood's progress.`);
  }
  if (Math.abs(a.stageOffset - b.stageOffset) > 0.05) warnings.push('The river stage differs between the runs.');
  if (Math.abs(a.rainRate - b.rainRate) > 0.01) warnings.push('The rain rate differs between the runs.');
  if (a.forcing !== b.forcing) warnings.push('Water sources or storms differ between the runs.');
  if (b.wallCells <= a.wallCells) warnings.push('No walls were added since the baseline.');

  let noLonger = 0;
  let newly = 0;
  let newlyLoss = 0;
  let worse = 0;
  let worseLoss = 0;
  for (const [k, x] of base.buildings) {
    const y = cur.buildings.get(k);
    if (x.depth >= REACHED_DEPTH && !(y && y.depth >= REACHED_DEPTH)) noLonger++;
  }
  for (const [k, y] of cur.buildings) {
    const x = base.buildings.get(k);
    if (y.depth >= REACHED_DEPTH && !(x && x.depth >= REACHED_DEPTH)) {
      newly++;
      if (Number.isFinite(y.loss)) newlyLoss += y.loss;
    }
    const before = x && Number.isFinite(x.loss) ? x.loss : 0;
    if (Number.isFinite(y.loss) && y.loss > before + 1) {
      worse++;
      worseLoss += y.loss - before;
    }
  }
  const s0 = base.summary;
  const s1 = cur.summary;
  // The curve σ shifts both runs the same way, so the band of the difference pairs low with low and high with high.
  const lo = s0.lossLo - s1.lossLo;
  const hi = s0.lossHi - s1.lossHi;
  return {
    baseline: a,
    avoided: s0.loss - s1.loss,
    avoidedLo: Math.min(lo, hi),
    avoidedHi: Math.max(lo, hi),
    noLongerReached: noLonger,
    newlyReached: newly,
    newlyReachedLoss: newlyLoss,
    worse,
    worseLoss,
    warnings,
  };
}

export interface BcrView {
  cost: { mid: number; low: number; high: number; perMetre: number };
  years: number;
  /** With a return period: BCR at 7 % and 3.1 %, central and the range over cost ±50 % and the avoided-loss band. */
  bcr7: number;
  bcr7Range: [number, number];
  bcr3: number;
  bcr3Range: [number, number];
  /** Return period at which the BCR at 7 % is 1 (central values). */
  breakEvenT: number;
}

export function bcrView(c: Comparison, opts: { type: MitigationType; lengthM: number; heightM: number; country: CostCountry | null; returnPeriod: number | null }): BcrView {
  const cost = mitigationCost(opts.type, opts.lengthM, opts.heightM, opts.country);
  const years = USEFUL_LIFE_WALL_YEARS;
  const T = opts.returnPeriod && opts.returnPeriod > 0 ? opts.returnPeriod : NaN;
  const ratio = (avoided: number, capex: number, rate: number) => (Number.isFinite(T) && capex > 0 ? bcr({ deltaEal: avoided / T, capex, rate, years }).bcr : NaN);
  const range = (rate: number): [number, number] => {
    const lo = ratio(Math.max(0, Math.min(c.avoidedLo, c.avoided)), cost.high, rate);
    const hi = ratio(Math.max(c.avoidedHi, c.avoided), cost.low, rate);
    return [lo, hi];
  };
  return {
    cost,
    years,
    bcr7: ratio(c.avoided, cost.mid, DISCOUNT_RATE_FEMA),
    bcr7Range: range(DISCOUNT_RATE_FEMA),
    bcr3: ratio(c.avoided, cost.mid, DISCOUNT_RATE_LOW),
    bcr3Range: range(DISCOUNT_RATE_LOW),
    breakEvenT: breakEvenReturnPeriod(c.avoided, cost.mid, 0, DISCOUNT_RATE_FEMA, years),
  };
}
