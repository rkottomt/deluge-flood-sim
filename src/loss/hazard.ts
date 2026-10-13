/**
 * Hazard classes and the fast-water structural rule, from a cell's (or a building's) maximum depth d (m), maximum
 * speed v (m/s) and maximum depth × speed dv (m²/s).
 *
 *  • AIDR H1–H6: Australian Institute for Disaster Resilience, Guideline 7-3 (2017) / Australian Rainfall and Runoff
 *    2019 Book 6 Ch 7, after Smith, Davey & Cox (2014). Lowest class whose three limits all hold.
 *  • FD2321 hazard rating: DEFRA / Environment Agency, *Flood Risks to People* (FD2321/TR2, 2006):
 *    HR = d × (v + 0.5) + DF. The debris-factor table and class labels are the standard ones but were not re-read
 *    from the report for this feature [M].
 *  • Structural damage from fast water: Clausen & Clark (1990) thresholds as widely cited (RESCDAM; TU Delft summaries
 *    of Clausen 1989): partial damage at dv ≥ 3 m²/s, collapse at dv ≥ 7 m²/s, both only with v ≥ 2 m/s, for
 *    masonry / concrete. The primary paper was not retrieved [M]. Light construction (timber, mud, informal) uses half
 *    the thresholds, and debris-laden flow (glacial-lake outbursts, debris flows) multiplies dv by 1.5 and treats
 *    dv ≥ 3 as collapse for anything but reinforced concrete — both are labelled heuristics [I].
 *
 * The maxima come from different moments of the flood (the deepest water need not be the fastest), so dv is taken from
 * its own accumulator, not as max d × max v.
 *
 * Applied to a building, the structural rule reads a footprint STATISTIC, not the worst cell (impact.ts sampleCells:
 * the STRUCTURAL_QUANTILE of the per-cell maxima), and collapse is not a step: the damage ramps from the depth curve's
 * value to total loss across a band of dv around the collapse threshold (collapseShare; 5–9 m²/s for the 7 m²/s
 * criterion). Both are labelled heuristics [I] — the cited criterion is a line, but the speeds it is fed are a 2-D
 * model's open-ground speeds on a bare-earth grid, sampled at moments: Site check's North Shore demo parcel at the 1936
 * crest read a worst-cell dv of 6.6 in one sweep and 8.2 in the next, and its damage flipped between 15 % and 100 %.
 * (Most of that spread was the sampling, since fixed: SolverOptions.hazardSampleSeconds and runFor's RAMP_FRAME_S.)
 * The cited threshold sits at the centre of the band, where structuralState says 'collapse', so the counts of
 * destroyed buildings follow the cited line; only the loss is smoothed.
 */
import type { Construction, StructuralState } from './value';

export type AidrClass = 1 | 2 | 3 | 4 | 5 | 6;

/** AIDR 2017 limits: [max depth m, max speed m/s, max d·v m²/s] for H1 … H5; H6 is everything beyond. */
export const AIDR_LIMITS: ReadonlyArray<readonly [number, number, number]> = [
  [0.3, 2.0, 0.3],
  [0.5, 2.0, 0.6],
  [1.2, 2.0, 0.6],
  [2.0, 2.0, 1.0],
  [4.0, 4.0, 4.0],
];

export const AIDR_DESCRIPTIONS: Readonly<Record<AidrClass, string>> = {
  1: 'Generally safe for vehicles, people and buildings',
  2: 'Unsafe for small vehicles',
  3: 'Unsafe for vehicles, children and the elderly',
  4: 'Unsafe for vehicles and people',
  5: 'Unsafe for vehicles and people; all buildings vulnerable to structural damage, some less robust ones fail',
  6: 'Unsafe for vehicles and people; all building types vulnerable to failure',
};

/**
 * AIDR class. With `dv` omitted it is d × v. A NaN speed (velocity unknown) is classified on depth alone with v = 0,
 * which can only understate the class — callers say so.
 */
export function aidrClass(d: number, v: number, dv: number = d * v): AidrClass {
  const vv = Number.isFinite(v) ? v : 0;
  const dvv = Number.isFinite(dv) ? dv : 0;
  for (let i = 0; i < AIDR_LIMITS.length; i++) {
    const [dm, vm, dvm] = AIDR_LIMITS[i];
    if (d <= dm && vv <= vm && dvv <= dvm) return (i + 1) as AidrClass;
  }
  return 6;
}

export type LandUse = 'pasture' | 'woodland' | 'urban';

/** FD2321 debris factor (standard table [M]). */
export function debrisFactor(d: number, v: number, land: LandUse = 'urban'): number {
  if (d > 0.75 || v > 2) return land === 'pasture' ? 0.5 : 1;
  if (d > 0.25) return land === 'pasture' ? 0 : land === 'woodland' ? 0.5 : 1;
  return 0;
}

/** FD2321 hazard rating HR = d (v + 0.5) + DF. */
export function fd2321HR(d: number, v: number, land: LandUse = 'urban'): number {
  if (!(d > 0)) return 0;
  const vv = Number.isFinite(v) ? v : 0;
  return d * (vv + 0.5) + debrisFactor(d, vv, land);
}

export type HrClass = 'low' | 'moderate' | 'significant' | 'extreme';

/** FD2321 classes: < 0.75 low, 0.75–1.25 moderate, 1.25–2.0 significant, > 2.0 extreme. */
export function hrClass(hr: number): HrClass {
  if (hr < 0.75) return 'low';
  if (hr <= 1.25) return 'moderate';
  if (hr <= 2.0) return 'significant';
  return 'extreme';
}

export const HR_DESCRIPTIONS: Readonly<Record<HrClass, string>> = {
  low: 'Caution — shallow flowing water or deep standing water',
  moderate: 'Danger for some — children, the elderly and the infirm',
  significant: 'Danger for most — includes the general public',
  extreme: 'Danger for all — includes the emergency services',
};

/** Clausen & Clark (1990) as cited [M]: dv thresholds (m²/s) and the speed that must also be reached (m/s). */
export const DV_PARTIAL = 3;
export const DV_COLLAPSE = 7;
export const V_STRUCTURAL = 2;
/** Light construction uses this fraction of the thresholds [I]. */
export const LIGHT_CONSTRUCTION_FACTOR = 0.5;
/** Debris-laden flow: effective dv multiplier, and the collapse threshold for anything but reinforced concrete [I]. */
export const DEBRIS_DV_FACTOR = 1.5;
export const DEBRIS_DV_COLLAPSE = 3;

/**
 * Structural state from fast water. 'unknown' when the speed is not known (the snapshot fallback records depth only):
 * the depth curve alone then applies, which cannot show a collapse.
 */
export function structuralState(
  v: number,
  dv: number,
  opts: { construction?: Construction | null; debrisFlow?: boolean } = {},
): StructuralState {
  if (!Number.isFinite(v) || !Number.isFinite(dv)) return 'unknown';
  if (v < V_STRUCTURAL) return 'none';
  const t = structuralThresholds(dv, opts);
  if (t.eff >= t.collapseAt) return 'collapse';
  if (t.eff >= t.partialAt) return 'partial';
  return 'none';
}

/** Effective dv and the partial / collapse thresholds for a construction and flow type (see the header). */
function structuralThresholds(dv: number, opts: { construction?: Construction | null; debrisFlow?: boolean }): { eff: number; partialAt: number; collapseAt: number } {
  const c = opts.construction ?? null;
  const light = c === 'timber' || c === 'mud' || c === 'informal';
  const k = light ? LIGHT_CONSTRUCTION_FACTOR : 1;
  let eff = dv;
  let collapseAt = DV_COLLAPSE * k;
  if (opts.debrisFlow) {
    eff = dv * DEBRIS_DV_FACTOR;
    if (c !== 'concrete') collapseAt = Math.min(collapseAt, DEBRIS_DV_COLLAPSE);
  }
  return { eff, partialAt: DV_PARTIAL * k, collapseAt };
}

/**
 * Half-width of the collapse band as a fraction of the collapse threshold [I]: 2/7 puts the 7 m²/s criterion's band
 * at 5–9 m²/s (light construction 2.5–4.5, debris flow 2.1–3.9 of effective dv).
 */
export const COLLAPSE_BAND = 2 / 7;

/**
 * Share of total loss from fast water, 0–1 [I]: 0 below the collapse band, 1 above it, linear across it, and 0.5 at
 * the cited threshold (structuralState says 'collapse' from there). Applies only where the speed criterion holds
 * (v ≥ V_STRUCTURAL); 0 when the speed is unknown. A building's damage is (1 − share) × its depth-curve damage +
 * share × total loss (value.ts storeyDamage), so a dv that wavers around the threshold moves the loss in proportion
 * instead of flipping it between the curve and a write-off.
 */
export function collapseShare(v: number, dv: number, opts: { construction?: Construction | null; debrisFlow?: boolean } = {}): number {
  if (!Number.isFinite(v) || !Number.isFinite(dv) || v < V_STRUCTURAL) return 0;
  const t = structuralThresholds(dv, opts);
  // Centred form: exactly ½ at the threshold, so the share and structuralState agree on which side of it dv is.
  return Math.min(1, Math.max(0, 0.5 + (t.eff - t.collapseAt) / (2 * COLLAPSE_BAND * t.collapseAt)));
}

// ─── Downtime (business interruption) — a transparent heuristic, spec §C.5 [I] ─────────────────────────────────────

/** Clean-up days by water depth above the floor, m (spec §C.5 [I]). */
export function cleanupDays(d: number): number {
  if (!(d >= 0.05)) return 0;
  if (d < 0.3) return 7;
  if (d < 1.0) return 21;
  if (d < 2.0) return 45;
  return 90;
}

/** Days of debris clearing after the access road drains (spec §C.5 [I]). */
export const ACCESS_CLEARING_DAYS = 2;

/**
 * downtime = max(access days, site days); site = clean-up(d) + damage × rebuild days + utility days. Hazus-spirited
 * HEURISTIC (the Hazus restoration tables were not retrievable): it is shown as such and every input is printed.
 */
export function downtimeDays(opts: { depth: number; damage: number; rebuildDays: number; utilityDays?: number; accessDays?: number }): number {
  const site = cleanupDays(opts.depth) + Math.max(0, Math.min(1, opts.damage)) * opts.rebuildDays + (opts.utilityDays ?? 0);
  return Math.max(opts.accessDays ?? 0, site > 0 ? site : 0);
}
