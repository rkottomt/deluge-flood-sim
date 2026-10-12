/**
 * Debris-flow rheology → the per-scenario coefficients the momentum pass uses (shaders/momentum.ts rheoMomentum,
 * cpuReference.ts momentum). One place, shared by the GPU solver and the Float64 reference, so the two cannot drift.
 *
 * Every law is written as a resistance per unit width on the face discharge q (m²/s), split by how it is integrated:
 *
 *   ∂q/∂t = … − g·hf·∂η/∂x − [ yield + Coulomb ]·sgn(q) − [ ν/hf² + (g·n²/hf^{7/3} + (g/ξ)/hf²)·|q| ]·q
 *            (rate-independent: stop-or-reduce)         (rate-dependent: semi-implicit denominator)
 *
 *   yield    tauRho = τ_y/ρ                    (m²/s²)   Bingham, O'Brien–Julien
 *   Coulomb  mu·g·hf·cosθ                      (m²/s²)   Voellmy (θ from the face's bed slope)
 *   viscous  visc = ν (m²/s): 3·μ_B/ρ (Bingham sheet flow), K·η/(8·ρ_m) (O'Brien–Julien)
 *   turbulent n2 = n_td² (s²/m^{2/3}, O'Brien–Julien dispersive Manning), gXi = g/ξ (m/s², Voellmy)
 *
 * Research spec: docs/research/glacier-hazard-chain.md §D.1–D.2. Units SI.
 */
import type { Rheology } from '../hazard/types';
import { dispersiveManningFactor, mixtureDensity } from '../hazard/mass';
import { GRAVITY } from './constants';

/** Coefficients of one rheology. kind 0 = water: Manning only, the unchanged code path. */
export interface RheologyCoefficients {
  /** 0 water, 1 Voellmy, 2 O'Brien–Julien quadratic, 3 Bingham (the shader's sim.rheoKind). */
  kind: 0 | 1 | 2 | 3;
  /** Yield stress / density τ_y/ρ, m²/s². */
  tauRho: number;
  /** Coulomb coefficient μ (–). */
  mu: number;
  /** Kinematic laminar viscosity ν of the viscous term ν·q/hf², m²/s. */
  visc: number;
  /** Squared turbulent Manning n of the rheology (replaces SimParams.manningN² on its faces), s²/m^{2/3}. */
  n2: number;
  /** g/ξ of the Voellmy turbulent term (g/ξ)·q·|q|/hf², dimensionless (ξ in m/s²). */
  gXi: number;
}

export const WATER_COEFFICIENTS: RheologyCoefficients = { kind: 0, tauRho: 0, mu: 0, visc: 0, n2: 0, gXi: 0 };

/**
 * Depth floor of the viscous term ν·q/max(hf, RHEO_VISC_DEPTH)², m (spec §D.2 "hRheo"). On the thin films of a wetting
 * front the laminar term grows as 1/h² and would freeze every film the solver's wet/dry front is made of — 1 mm of
 * water is not a 1 mm mud layer. Yield and Coulomb terms apply at every depth: a thin deposit at rest is physical.
 */
export const RHEO_VISC_DEPTH = 0.05;

/** Bound on every coefficient, so no product in the shader overflows Float32 (≈ 3.4e38) whatever a scenario says. */
const COEFF_MAX = 1e6;

const clean = (v: number, max = COEFF_MAX): number => (Number.isFinite(v) && v > 0 ? Math.min(v, max) : 0);

/**
 * The coefficients of `r` on a map whose clear-water Manning n is `manningN` (the quadratic law's dispersive n_td scales
 * it). Non-finite or negative parameters count as 0 (no such term); anything unknown is water.
 */
export function rheologyCoefficients(r: Rheology | null | undefined, manningN: number): RheologyCoefficients {
  if (!r) return WATER_COEFFICIENTS;
  switch (r.kind) {
    case 'voellmy': {
      const xi = clean(r.xi);
      return { kind: 1, tauRho: 0, mu: clean(r.mu, 10), visc: 0, n2: 0, gXi: xi > 0 ? clean(GRAVITY / xi) : 0 };
    }
    case 'quadratic': {
      // O'Brien & Julien 1988: τ_y = a2·e^{b2·Cv} dyn/cm² (= 0.1 Pa), η = a1·e^{b1·Cv} poise (= 0.1 Pa·s).
      const cv = Math.min(0.9, clean(r.cv, 1));
      const m = r.material;
      const tauY = 0.1 * clean(m?.a2) * Math.exp(Math.min(50, clean(m?.b2) * cv));
      const eta = 0.1 * clean(m?.a1) * Math.exp(Math.min(50, clean(m?.b1) * cv));
      const rho = mixtureDensity(cv);
      const K = r.K === undefined ? 2285 : clean(r.K);
      const n = clean(manningN, 10) * dispersiveManningFactor(cv);
      return { kind: 2, tauRho: clean(tauY / rho), mu: 0, visc: clean((K * eta) / (8 * rho)), n2: clean(n * n), gXi: 0 };
    }
    case 'bingham': {
      const rho = clean(r.rho) > 0 ? Math.max(100, clean(r.rho)) : 1000;
      return { kind: 3, tauRho: clean(clean(r.tauY) / rho), mu: 0, visc: clean((3 * clean(r.muB)) / rho), n2: 0, gXi: 0 };
    }
    default:
      return WATER_COEFFICIENTS;
  }
}
