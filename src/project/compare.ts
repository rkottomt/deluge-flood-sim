/**
 * Design comparison arithmetic (pure, no DOM): 2–3 mitigation designs, each a named set of walls / levees / terrain
 * edits, run against the same event ladder as the baseline (no edits), then per design:
 *
 *   loss per level, EAL (trapezoid over exceedance probability, src/loss/eal.ts; with and without the tail term),
 *   ΔEAL = EAL(baseline) − EAL(design), cost (unit costs × wall length × height^1.3 by type, or the user's figure),
 *   NPV and BCR over the design's useful life at 7 % and 3.1 %, the benefit–cost analysis at the chosen discount rate
 *   with its range (src/loss/bca.ts analyzeBca), buildings protected (reached in the baseline, not with
 *   the design), and "who gets wetter" — buildings newly reached or deeper, and land newly flooded or deeper than in the
 *   baseline at the same level: the risk a design TRANSFERS, booked on its own line rather than netted off.
 *
 * Every number is per event level as run; the summary counts are the most over the ladder's levels (the level that
 * shows the most), so a design that is fine at the 100-yr level but pushes water onto a neighbour at the 1936 crest
 * still shows that neighbour.
 */
import { REACHED_DEPTH } from '../loss/impact';
import { bcr, DISCOUNT_RATE_FEMA, DISCOUNT_RATE_LOW, eal, mitigationCost, type MitigationType } from '../loss/eal';
import { analyzeBca, BCA_DEFAULT_RATE, BCA_LIMITS, defaultUsefulLife, type BcaAnalysis, type EnsembleSpread } from '../loss/bca';
import type { ComparisonSummary, DesignCost, LadderKind, ProjectEdit } from './format';
import { wallSegments } from './edits';

/** A building is "deeper" with a design when its max depth rises by more than this, m. */
export const DEEPER_M = 0.1;
/** Land counts as newly flooded / wetter past these, m (the impact model's "reached" depth, and the same 10 cm). */
export const WET_M = REACHED_DEPTH;
export const WETTER_M = DEEPER_M;

export interface CompareLevel {
  id: string;
  label: string;
  returnPeriod: number | null;
  rpFrom: 'source' | 'user' | null;
}

/** One run's result at one level (baseline or a design). */
export interface LevelRun {
  loss: number;
  lossLo: number;
  lossHi: number;
  reached: number;
  /** Per building index: loss and max depth (buildings with any water). */
  buildings: Map<number, { loss: number; depth: number }>;
  /** Land cells versus the baseline's run of the same level (null for the baseline itself). */
  area: AreaDelta | null;
}

export interface AreaDelta {
  /** Land dry (< WET_M) in the baseline, wet with the design. */
  newlyFloodedM2: number;
  /** Land wet in both, deeper by more than WETTER_M with the design. */
  deeperM2: number;
  /** Land wet in the baseline, dry with the design. */
  protectedM2: number;
}

export interface BuildingDelta {
  /** Reached in the baseline, not with the design. */
  protectedCount: number;
  /** Reached with the design, not in the baseline (and their loss with it). */
  newlyReached: number;
  newlyReachedLoss: number;
  /** Reached with the design and deeper by more than DEEPER_M than in the baseline (newly reached included). */
  deeper: number;
  /** Loss went up with the design, and by how much in all. */
  worse: number;
  worseLoss: number;
}

export function buildingDelta(base: Map<number, { loss: number; depth: number }>, cur: Map<number, { loss: number; depth: number }>): BuildingDelta {
  let protectedCount = 0;
  let newlyReached = 0;
  let newlyReachedLoss = 0;
  let deeper = 0;
  let worse = 0;
  let worseLoss = 0;
  for (const [k, x] of base) {
    const y = cur.get(k);
    if (x.depth >= REACHED_DEPTH && !(y && y.depth >= REACHED_DEPTH)) protectedCount++;
  }
  for (const [k, y] of cur) {
    const x = base.get(k);
    const d0 = x ? x.depth : 0;
    if (y.depth >= REACHED_DEPTH && d0 < REACHED_DEPTH) {
      newlyReached++;
      if (Number.isFinite(y.loss)) newlyReachedLoss += y.loss;
    }
    if (y.depth >= REACHED_DEPTH && y.depth > d0 + DEEPER_M) deeper++;
    const before = x && Number.isFinite(x.loss) ? x.loss : 0;
    if (Number.isFinite(y.loss) && y.loss > before + 1) {
      worse++;
      worseLoss += y.loss - before;
    }
  }
  return { protectedCount, newlyReached, newlyReachedLoss, deeper, worse, worseLoss };
}

/**
 * Land made wetter or drier by a design at one level, from the two runs' max-depth fields. `water` marks cells under
 * standing water at the start (rivers, lakes): not land, not counted.
 */
export function areaDelta(base: Float32Array, cur: Float32Array, water: Uint8Array | null, cellSize: number): AreaDelta {
  const n = Math.min(base.length, cur.length);
  let newly = 0;
  let deeper = 0;
  let prot = 0;
  for (let c = 0; c < n; c++) {
    if (water && water[c]) continue;
    const a = base[c];
    const b = cur[c];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const wa = a >= WET_M;
    const wb = b >= WET_M;
    if (!wa && wb) newly++;
    else if (wa && wb && b > a + WETTER_M) deeper++;
    else if (wa && !wb) prot++;
  }
  const a2 = cellSize * cellSize;
  return { newlyFloodedM2: newly * a2, deeperM2: deeper * a2, protectedM2: prot * a2 };
}

/**
 * A small map of the change in max depth (design − baseline) for drawing: the grid in blocks of `stride` cells, each
 * block keeping the change of largest magnitude among its land cells (so one deeper street survives the shrink).
 */
export function depthChangeThumb(base: Float32Array, cur: Float32Array, water: Uint8Array | null, nx: number, ny: number, maxSide = 256): { w: number; h: number; stride: number; data: Float32Array } {
  const stride = Math.max(1, Math.ceil(Math.max(nx, ny) / maxSide));
  const w = Math.ceil(nx / stride);
  const h = Math.ceil(ny / stride);
  const data = new Float32Array(w * h);
  for (let j = 0; j < ny; j++) {
    const bj = Math.floor(j / stride);
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (water && water[c]) continue;
      const a = base[c];
      const b = cur[c];
      if (!Number.isFinite(a) || !Number.isFinite(b) || (a < WET_M && b < WET_M)) continue;
      const d = b - a;
      const k = bj * w + Math.floor(i / stride);
      if (Math.abs(d) > Math.abs(data[k])) data[k] = d;
    }
  }
  return { w, h, stride, data };
}

// ─── Cost ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export interface ResolvedCost {
  type: MitigationType;
  capex: number;
  low: number;
  high: number;
  om: number;
  lengthM: number;
  meanHeightM: number;
  /** override: the user's total · dims: the user's length × height · segments: the drawn polylines · raster: the barrier raster */
  basis: 'override' | 'dims' | 'segments' | 'raster' | 'none';
  /** The design also digs or raises ground, which is not costed. */
  terrainNotCosted: boolean;
  /** Project useful life, years (absent: FEMA's standard value for the type) and where it came from. */
  years?: number;
  yearsFrom?: 'user' | 'fema';
}

/** A design's useful life: the user's, else FEMA's standard value for its type (src/loss/bca.ts USEFUL_LIFE). */
export function usefulLifeOf(cost: Pick<ResolvedCost, 'type' | 'years'>): number {
  const y = cost.years;
  return y != null && Number.isFinite(y) && y >= BCA_LIMITS.years[0] ? Math.min(BCA_LIMITS.years[1], Math.round(y)) : defaultUsefulLife(cost.type);
}

export function resolveCost(cost: DesignCost, edits: readonly ProjectEdit[], cellSize: number, country: 'US' | 'IN' | 'NP' | null, raster?: { lengthM: number; meanHeightM: number } | null): ResolvedCost {
  const life = cost.usefulLifeYears != null ? { years: cost.usefulLifeYears, yearsFrom: 'user' as const } : { years: defaultUsefulLife(cost.type), yearsFrom: 'fema' as const };
  return { ...resolveCapex(cost, edits, cellSize, country, raster), ...life };
}

function resolveCapex(cost: DesignCost, edits: readonly ProjectEdit[], cellSize: number, country: 'US' | 'IN' | 'NP' | null, raster?: { lengthM: number; meanHeightM: number } | null): ResolvedCost {
  const om = cost.omUsdPerYear ?? 0;
  const seg = wallSegments(edits);
  const terrainNotCosted = seg.terrain;
  if (cost.capexUsd != null) {
    const len = seg.segments.reduce((s, x) => s + x.lengthCells * cellSize, 0);
    return { type: cost.type, capex: cost.capexUsd, low: cost.capexUsd, high: cost.capexUsd, om, lengthM: cost.lengthM ?? len, meanHeightM: cost.heightM ?? 0, basis: 'override', terrainNotCosted };
  }
  if (cost.lengthM != null && cost.heightM != null) {
    const c = mitigationCost(cost.type, cost.lengthM, cost.heightM, country);
    return { type: cost.type, capex: c.mid, low: c.low, high: c.high, om, lengthM: cost.lengthM, meanHeightM: cost.heightM, basis: 'dims', terrainNotCosted };
  }
  if (seg.erased && raster) {
    const c = mitigationCost(cost.type, raster.lengthM, raster.meanHeightM, country);
    return { type: cost.type, capex: c.mid, low: c.low, high: c.high, om, lengthM: raster.lengthM, meanHeightM: raster.meanHeightM, basis: 'raster', terrainNotCosted };
  }
  let mid = 0;
  let len = 0;
  let hl = 0;
  for (const s of seg.segments) {
    const L = s.lengthCells * cellSize;
    mid += mitigationCost(cost.type, L, s.height, country).mid;
    len += L;
    hl += L * s.height;
  }
  const c = mitigationCost(cost.type, 1, 1, country); // for the band fraction
  const band = c.mid > 0 ? c.high / c.mid - 1 : 0.5;
  return {
    type: cost.type,
    capex: mid,
    low: mid * (1 - band),
    high: mid * (1 + band),
    om,
    lengthM: len,
    meanHeightM: len > 0 ? hl / len : 0,
    basis: seg.segments.length ? 'segments' : 'none',
    terrainNotCosted,
  };
}

// ─── The comparison ────────────────────────────────────────────────────────────────────────────────────────────────
export interface DesignInput {
  id: string;
  name: string;
  cost: ResolvedCost;
  levels: LevelRun[];
}

export interface DesignResult {
  id: string;
  name: string;
  loss: number[];
  /** The damage-curve ±1σ losses per level (the Impact model's range). */
  lossLo: number[];
  lossHi: number[];
  /** EAL with the tail term (the headline) and without it. */
  eal: number | null;
  ealNoTail: number | null;
  deltaEal: number | null;
  cost: ResolvedCost;
  /** Useful life the NPVs and the benefit–cost analysis use, years. */
  years: number;
  npv7: number | null;
  npv3: number | null;
  bcr7: number | null;
  bcr3: number | null;
  /** The benefit–cost analysis at the comparison's discount rate, with its range (null without a return period). */
  bca: BcaAnalysis | null;
  perLevel: Array<BuildingDelta & AreaDelta & { avoided: number }>;
  /** Most over the levels. */
  protectedBuildings: number;
  newlyReached: number;
  deeperBuildings: number;
  worseBuildings: number;
  wetterAreaM2: number;
  protectedAreaM2: number;
}

export interface ComparisonResult {
  levels: CompareLevel[];
  baseline: { loss: number[]; lossLo: number[]; lossHi: number[]; eal: number | null; ealNoTail: number | null };
  designs: DesignResult[];
  /** Levels that carry a return period (EAL needs at least one). */
  withRp: number;
  /** The discount rate of the benefit–cost analysis. */
  rate: number;
  /** The hazard-input ensemble's loss spread folded into the BCA range (null: it has not run on this scene). */
  ensemble: EnsembleSpread | null;
}

export interface CompareOptions {
  /** Discount rate of the benefit–cost analysis (default: the FEMA BCA Toolkit's 7 %). */
  rate?: number;
  ensemble?: EnsembleSpread | null;
}

function ealOf(levels: readonly CompareLevel[], losses: readonly number[], tail: boolean): number | null {
  const pts = levels.map((l, i) => ({ T: l.returnPeriod ?? NaN, loss: losses[i] })).filter((p) => p.T > 0 && Number.isFinite(p.loss));
  return pts.length ? eal(pts, tail) : null;
}

/** A level's curve range, falling back to its central loss when the range is not a number. */
const lo = (r: LevelRun | undefined) => (r && Number.isFinite(r.lossLo) ? r.lossLo : (r?.loss ?? NaN));
const hi = (r: LevelRun | undefined) => (r && Number.isFinite(r.lossHi) ? r.lossHi : (r?.loss ?? NaN));

export function compareDesigns(levels: readonly CompareLevel[], baseline: readonly LevelRun[], designs: readonly DesignInput[], opts: CompareOptions = {}): ComparisonResult {
  const rate = opts.rate != null && Number.isFinite(opts.rate) ? Math.min(BCA_LIMITS.rate[1], Math.max(BCA_LIMITS.rate[0], opts.rate)) : BCA_DEFAULT_RATE;
  const ensemble = opts.ensemble ?? null;
  const bLoss = baseline.map((r) => r.loss);
  const bEal = ealOf(levels, bLoss, true);
  const withRp = levels.filter((l) => l.returnPeriod != null && l.returnPeriod > 0).length;
  const out: DesignResult[] = designs.map((d) => {
    const years = usefulLifeOf(d.cost);
    const loss = d.levels.map((r) => r.loss);
    const e = ealOf(levels, loss, true);
    const delta = bEal != null && e != null ? bEal - e : null;
    const money = (r: number) => (delta != null && d.cost.capex + d.cost.om > 0 ? bcr({ deltaEal: delta, capex: d.cost.capex, om: d.cost.om, rate: r, years }) : null);
    const r7 = money(DISCOUNT_RATE_FEMA);
    const r3 = money(DISCOUNT_RATE_LOW);
    const perLevel = d.levels.map((r, i) => ({
      ...buildingDelta(baseline[i]?.buildings ?? new Map(), r.buildings),
      ...(r.area ?? { newlyFloodedM2: 0, deeperM2: 0, protectedM2: 0 }),
      avoided: (baseline[i]?.loss ?? 0) - r.loss,
    }));
    const most = (f: (x: (typeof perLevel)[number]) => number) => perLevel.reduce((m, x) => Math.max(m, f(x)), 0);
    const analysis = analyzeBca({
      levels: levels.map((l, i) => ({
        T: l.returnPeriod,
        before: baseline[i]?.loss ?? NaN,
        beforeLo: lo(baseline[i]),
        beforeHi: hi(baseline[i]),
        after: d.levels[i]?.loss ?? NaN,
        afterLo: lo(d.levels[i]),
        afterHi: hi(d.levels[i]),
      })),
      capex: d.cost.capex,
      capexLo: d.cost.low,
      capexHi: d.cost.high,
      omPerYear: d.cost.om,
      years,
      rate,
      ensemble,
    });
    return {
      id: d.id,
      name: d.name,
      loss,
      lossLo: d.levels.map(lo),
      lossHi: d.levels.map(hi),
      eal: e,
      ealNoTail: ealOf(levels, loss, false),
      deltaEal: delta,
      cost: d.cost,
      years,
      npv7: r7 ? r7.npv : null,
      npv3: r3 ? r3.npv : null,
      bcr7: r7 && Number.isFinite(r7.bcr) ? r7.bcr : null,
      bcr3: r3 && Number.isFinite(r3.bcr) ? r3.bcr : null,
      bca: analysis,
      perLevel,
      protectedBuildings: most((x) => x.protectedCount),
      newlyReached: most((x) => x.newlyReached),
      deeperBuildings: most((x) => x.deeper),
      worseBuildings: most((x) => x.worse),
      wetterAreaM2: most((x) => x.newlyFloodedM2 + x.deeperM2),
      protectedAreaM2: most((x) => x.protectedM2),
    };
  });
  return {
    levels: levels.slice(),
    baseline: { loss: bLoss, lossLo: baseline.map(lo), lossHi: baseline.map(hi), eal: bEal, ealNoTail: ealOf(levels, bLoss, false) },
    designs: out,
    withRp,
    rate,
    ensemble,
  };
}

/** The numbers a project keeps (format.ts ComparisonSummary). */
export function comparisonSummary(c: ComparisonResult, ladder: LadderKind | 'current', durationS: number, at = new Date()): ComparisonSummary {
  const fin = (v: number | null | undefined) => (v != null && Number.isFinite(v) ? v : null);
  // A loss that is not a number (no buildings in the scene: NaN) is kept as an explicit null, not JSON's silent one.
  const lossOf = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : null);
  // Inside the reader's ranges (validate.ts), so a saved comparison always opens: beyond them, "no value".
  const within = (v: number | null | undefined, lim: number) => {
    const x = fin(v);
    return x != null && Math.abs(x) <= lim ? x : null;
  };
  const ratioOf = (v: number | null | undefined) => within(v, 1e6);
  const moneyOf = (v: number | null | undefined) => within(v, 1e13);
  return {
    generatedAt: at.toISOString(),
    ladder,
    durationS,
    levels: c.levels.map((l) => ({ id: l.id, label: l.label, returnPeriod: l.returnPeriod, rpFrom: l.rpFrom })),
    baseline: { loss: c.baseline.loss.map(lossOf), eal: fin(c.baseline.eal) },
    designs: c.designs.map((d) => ({
      id: d.id,
      name: d.name,
      loss: d.loss.map(lossOf),
      eal: fin(d.eal),
      deltaEal: fin(d.deltaEal),
      costUsd: Math.max(0, d.cost.capex),
      npv7: fin(d.npv7),
      npv3: fin(d.npv3),
      bcr7: fin(d.bcr7),
      bcr3: fin(d.bcr3),
      protectedBuildings: d.protectedBuildings,
      newlyReached: d.newlyReached,
      deeperBuildings: d.deeperBuildings,
      wetterAreaM2: d.wetterAreaM2,
      // An infinite BCR (a benefit at no cost) is kept as null, like every other non-number.
      years: d.years,
      bcr: ratioOf(d.bca?.central.bcr),
      bcrLow: ratioOf(d.bca?.range.bcr[0]),
      bcrHigh: ratioOf(d.bca?.range.bcr[1]),
      netBenefit: moneyOf(d.bca?.central.netBenefit),
      breakEvenCost: moneyOf(d.bca?.central.breakEvenCapex),
    })),
    discountRate: c.rate,
  };
}
