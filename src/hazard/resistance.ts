/**
 * Flow resistance laws for the 1-D routing (src/hazard/routing.ts).
 *
 * The router's friction is written as Manning's — a semi-implicit g·n²·|Q|·Q/(A·R^{4/3}) — so every law here is
 * expressed as the Manning n it is EQUIVALENT to at a hydraulic radius R. For a law that gives the velocity ratio
 * U/u* = √(8/f) (u* = √(g·R·S)), U = (U/u*)·√(g·R·S) = R^{2/3}·S^{1/2}/n_eq gives
 *
 *   n_eq(R) = R^{1/6} / (√g · U/u*)          (and the friction coefficient Cf = (u* ÷ U)² = g·n_eq²/R^{1/3})
 *
 * so the semi-implicit denominator 1 + dt·g·n_eq²·|Q|/(A·R^{4/3}) = 1 + dt·Cf·|Q|/(A·R) is exactly the Cf form; a
 * depth-dependent n only changes a positive coefficient there, so the update stays unconditionally dissipative and
 * the positivity limiter and the mass balance are untouched.
 *
 * FERGUSON (2007) VARIABLE-POWER EQUATION ("VPE"; Water Resources Research 43, W05427, doi:10.1029/2006WR005422):
 *
 *   U/u* = a1·a2·(R/D84) / √(a1² + a2²·(R/D84)^{5/3}),        a1 = 6.5, a2 = 2.5
 *
 * fitted to 376 field measurements in gravel- and boulder-bed streams with D84 the roughness scale. Its two limbs:
 *   deep flow (R/D84 ≫ 1):    U/u* → a1·(R/D84)^{1/6}  — the Manning–Strickler law, n → D84^{1/6}/(a1·√g)
 *                              (≈ 0.044 for D84 = 0.5 m, 0.049 for 1 m);
 *   shallow flow (R/D84 ≲ 1): U/u* → a2·(R/D84)        — the roughness-layer law: resistance climbs steeply as
 *                              boulders protrude through the flow.
 * Coefficients: Ferguson 2007's compromise for both absolute and relative error; Ferguson & Recking (2025, WRR,
 * doi:10.1029/2024WR038852) restate them (calibrated on R/D84, not d/D84); Rickenmann & Recking (2011, WRR 47,
 * W07538, doi:10.1029/2010WR009793) found the VPE the least biased of the published laws on ~2,900 measurements.
 * Others have refitted 6.1 / 2.4 (e.g. ESurf 9:379, 2021): the difference is a few per cent of velocity.
 *
 * What the VPE does NOT give: a flood-stage resistance much below a bouldery river's n ≈ 0.04–0.05. Its deep limb IS
 * Manning–Strickler; it differs from a constant n mainly by RAISING resistance at shallow flow (baseflow, the thin
 * leading edge of a front) and lowering it modestly at high submergence (∝ (R/D84)^{−1/6}).
 */
import { G, VPE_A1, VPE_A2 } from './defaults';
import type { ResistanceLaw } from './types';

export type { ResistanceLaw };
export { VPE_A1, VPE_A2 };

/** Ferguson (2007) VPE: U/u* = √(8/f) at relative submergence x = R/D84. */
export function fergusonVpe(x: number, a1 = VPE_A1, a2 = VPE_A2): number {
  if (!(x > 0)) return 0;
  return (a1 * a2 * x) / Math.sqrt(a1 * a1 + a2 * a2 * Math.pow(x, 5 / 3));
}

/** Manning n equivalent to the VPE at hydraulic radius R (m) over a bed of D84 (m): R^{1/6}/(√g·U/u*). */
export function vpeManningN(R: number, d84: number, a1 = VPE_A1, a2 = VPE_A2): number {
  const r = R > 1e-6 ? R : 1e-6;
  return Math.pow(r, 1 / 6) / (Math.sqrt(G) * fergusonVpe(r / d84, a1, a2));
}

/** Darcy–Weisbach-style friction coefficient Cf = (u* ÷ U)² of the VPE. */
export function vpeCf(R: number, d84: number, a1 = VPE_A1, a2 = VPE_A2): number {
  const v = fergusonVpe(R / d84, a1, a2);
  return v > 0 ? 1 / (v * v) : Infinity;
}

/** D84 at chainage s for a law's d84 (constant or reaches). */
export function d84At(d84: number | ReadonlyArray<{ s: number; d84: number }>, s: number): number {
  if (typeof d84 === 'number') return d84;
  if (d84.length === 0) throw new Error('ferguson2007: empty d84 reach list');
  let v = d84[0].d84;
  for (const r of d84) if (s >= r.s) v = r.d84;
  return v;
}
