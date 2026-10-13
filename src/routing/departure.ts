/**
 * When people actually leave after a warning: a DEPARTURE-TIME (mobilisation) curve, instead of everyone leaving the
 * moment the alert goes out.
 *
 * Between a warning and a departure lie the decision to act and the preparation to leave (Lindell & Perry's
 * protective action decision model; Sorensen & Mileti's "protective action initiation" time). For floods from dam
 * breaches, controlled releases and levee breaches, Sorensen & Mileti (2015b) synthesised the published evacuation
 * cases into cumulative mobilisation curves for USACE's LifeSim:
 *
 *     P(t) = m · (1 − exp(−t² / (a · b²)))          t = minutes since the warning was received
 *
 *   a   mobilisation speed coefficient (smaller = faster; 1.0–2.2 in the published curves)
 *   b   time scale, min — the curves' "median time to initiate protective action" (the exact median of the bracket
 *       is b·√(a·ln 2): within ±25 % of b for a in 1.0–2.2)
 *   m   the maximum share that takes protective action at all within the horizon (8 h here); the rest stay
 *
 * — a Rayleigh distribution in t (a Weibull of shape 2) with scale b·√(a/2), capped at m. The coefficients below are
 * the most-likely and bounding curves by population PREPAREDNESS (good / poor) and threat PERCEPTION (likely /
 * unlikely), as tabulated from Sorensen & Mileti (2015b) in Silva, Eleutério, Apel & Kreibich (2025), Supplement
 * Table S2 and Eq. S2 [S: secondary, the original USACE report was not available]. The 8-hour maximum shares are the
 * same table's.
 *
 * What it is NOT: it starts at the moment the warning REACHES people. Getting the warning out (the warning-diffusion
 * curve of the same reports) adds its own delay — enter a later alert time for that. And it is a population average:
 * one building's occupants (an office during the day, a care home at night) can be much faster or slower.
 *
 * Pure: no DOM.
 */

export type DepartureCurveId = 'good-likely' | 'poor-likely' | 'poor-unlikely' | 'fast';

export interface DepartureCurve {
  id: DepartureCurveId | 'custom';
  label: string;
  /** Mobilisation speed coefficient (dimensionless). */
  a: number;
  /** Time scale, minutes after the warning. */
  bMin: number;
  /** Share that leaves at all (0–1). */
  maxShare: number;
  source: string;
}

const SRC = 'Sorensen & Mileti 2015b (USACE RMC), via Silva et al. 2025 NHESS 25:1501, Suppl. Table S2';

/** The published curves offered in the UI. The default is 'poor-likely' (DEFAULT_DEPARTURE_CURVE). */
export const DEPARTURE_CURVES: Readonly<Record<DepartureCurveId, DepartureCurve>> = {
  'good-likely': { id: 'good-likely', label: 'Prepared, threat seen as likely', a: 1.37, bMin: 64.0, maxShare: 0.888, source: `${SRC}: preparedness good, perception likely — most likely curve; 88.8 % act within 8 h` },
  'poor-likely': { id: 'poor-likely', label: 'Unprepared, threat seen as likely', a: 1.79, bMin: 111.8, maxShare: 0.743, source: `${SRC}: preparedness poor, perception likely — most likely curve; 74.3 % act within 8 h` },
  'poor-unlikely': { id: 'poor-unlikely', label: 'Unprepared, threat seen as unlikely', a: 1.79, bMin: 111.8, maxShare: 0.57, source: `${SRC}: preparedness poor, perception unlikely — most likely curve; 57.0 % act within 8 h` },
  fast: { id: 'fast', label: 'Fastest published (drilled, threat obvious)', a: 1.0, bMin: 25.0, maxShare: 1, source: `${SRC}: preparedness good, perception likely — upper (fastest) bound; 100 % act within 8 h` },
};

export const DEFAULT_DEPARTURE_CURVE: DepartureCurveId = 'poor-likely';

/** Limits on a user-entered curve. */
export const DEPARTURE_LIMITS = { aMin: 0.2, aMax: 5, bMinMin: 1, bMinMax: 1440 } as const;

/** A curve with user overrides (null = the preset's), clamped to sane ranges. */
export function departureCurve(id: DepartureCurveId, over: { a?: number | null; bMin?: number | null; maxShare?: number | null } = {}): DepartureCurve {
  const base = DEPARTURE_CURVES[id] ?? DEPARTURE_CURVES[DEFAULT_DEPARTURE_CURVE];
  const clamp = (v: number | null | undefined, lo: number, hi: number, d: number) => (v == null || !Number.isFinite(v) ? d : Math.min(hi, Math.max(lo, v)));
  const a = clamp(over.a, DEPARTURE_LIMITS.aMin, DEPARTURE_LIMITS.aMax, base.a);
  const bMin = clamp(over.bMin, DEPARTURE_LIMITS.bMinMin, DEPARTURE_LIMITS.bMinMax, base.bMin);
  const maxShare = clamp(over.maxShare, 0, 1, base.maxShare);
  const changed = a !== base.a || bMin !== base.bMin || maxShare !== base.maxShare;
  return changed ? { id: 'custom', label: `${base.label}, edited`, a, bMin, maxShare, source: 'your input (edited from the published curve)' } : base;
}

/** Share of ALL occupants who have left by `s` seconds after the warning (0 before it). */
export function departedShare(c: DepartureCurve, s: number): number {
  if (!(s > 0)) return 0;
  const t = s / 60;
  return c.maxShare * (1 - Math.exp(-(t * t) / (c.a * c.bMin * c.bMin)));
}

/**
 * Seconds after the warning by which a share `p` of those who LEAVE has left (p in [0, 1)) — the departure-curve
 * percentile, renormalised by maxShare. +∞ for p ≥ 1.
 */
export function departureQuantileS(c: DepartureCurve, p: number): number {
  if (!(p > 0)) return 0;
  if (p >= 1) return Infinity;
  return 60 * c.bMin * Math.sqrt(-c.a * Math.log(1 - p));
}

/** "p10–p90" of the departure curve among those who leave, seconds after the warning. */
export function departureBand(c: DepartureCurve): { p10: number; p50: number; p90: number } {
  return { p10: departureQuantileS(c, 0.1), p50: departureQuantileS(c, 0.5), p90: departureQuantileS(c, 0.9) };
}
