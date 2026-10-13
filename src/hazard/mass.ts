/**
 * Mass movements in the chain (research spec §C): does an avalanche reach the lake or river (C.1), the wave it makes
 * in a lake and whether that wave overtops the dam (C.2), what it does in a river — dam it briefly or turn into a
 * debris flow (C.3) — and the debris-flow empirics and bulking used along the route (C.4, C.5).
 *
 * Everything here is an empirical relation with a wide scatter. The functions return the intermediate numbers (H/L,
 * the impulse product P, the dam height …) so the UI can show WHY the chain went the way it did, not just the answer.
 */
import type { GlacialLake, ImpulseGeometry, MassMovement } from './types';
import {
  AVALANCHE_SPEED,
  DEBRIS_FLOW_STOP_RATIO,
  DIRECT_FLOW_CV,
  FREEBOARD_DEFAULT,
  FRICTION_ANGLE,
  G,
  HEIM_RATIO_ICE_RICH,
  ICE_MELT_FRACTION,
  ICE_RICH_FRACTION,
  IMPACT_ANGLE,
  IMPACT_VELOCITY_MAX,
  IMPULSE_A_BREAK,
  IMPULSE_SPREAD_DEG,
  NTD_A,
  NTD_B,
  OVERTOPPING_COEFF,
  OVERTOPPING_PULSE,
  PACKING_CONCENTRATION,
  RHO_ICE,
  RHO_ROCK_BULK,
  RHO_SEDIMENT,
  RHO_WATER,
  SLIDE_THICKNESS_FACTOR,
  SLIDE_WIDTH_FACTOR,
} from './defaults';
import { gammaHydrograph, type Hydrograph } from './breach';
import { Series } from './series';

const DEG = Math.PI / 180;

// ────────────────────────────────────────────────────────────────────────────────────────────
// §C.1 Runout
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Scheidegger 1973 rock avalanches: log₁₀(H/L) = −0.15666·log₁₀V + 0.62419 (V m³). 0.29 at 27 Mm³. [M] */
export function scheideggerRatio(volume: number): number {
  return Math.pow(10, -0.15666 * Math.log10(Math.max(volume, 1)) + 0.62419);
}

/**
 * The H/L a mass of this size and ice content can reach (lower = travels further). Rock: Scheidegger. Ice-rich masses
 * are far more mobile — Chamoli 2021 (≈ 20 % ice) ran out at H/L = 0.16 against Scheidegger's 0.29 — so the ratio
 * blends linearly from Scheidegger at 0 % ice to 0.16 at ≥ 20 % ice. [H, anchored on Shugar et al. 2021]
 */
export function mobilityRatio(mass: MassMovement): number {
  const rock = scheideggerRatio(mass.volume);
  const w = Math.min(1, Math.max(0, mass.iceFraction / ICE_RICH_FRACTION));
  return Math.min(rock, rock + (HEIM_RATIO_ICE_RICH - rock) * w);
}

export interface Runout {
  /** H/L of the path to the target (fall height / path length). */
  pathRatio: number;
  /** H/L the mass can reach (mobilityRatio). */
  mobility: number;
  /** True when the path is steep enough for the mass to get there: pathRatio ≥ mobility. */
  reaches: boolean;
  /** Horizontal distance the mass could travel for this fall height, m. */
  maxRunout: number;
}

/** Does the avalanche reach the lake / river at the end of its path (spec §C.1: a yes/no; the rest is hydraulics)? */
export function runout(mass: MassMovement): Runout {
  const mobility = mobilityRatio(mass);
  const pathRatio = mass.pathLength > 0 ? mass.fallHeight / mass.pathLength : Infinity;
  return { pathRatio, mobility, reaches: pathRatio >= mobility, maxRunout: mass.fallHeight / mobility };
}

/** Rickenmann 1999 debris-flow total travel distance, m: L = 1.9·M^0.16·H_e^0.83 (M m³, H_e elevation drop m). [V] */
export function debrisFlowTravel(volume: number, drop: number): number {
  return 1.9 * Math.pow(volume, 0.16) * Math.pow(drop, 0.83);
}

/** GLOF-induced debris flows stop where the mean slope from the source falls to 11° (Huggel et al. 2003). [V] */
export function debrisFlowStops(drop: number, distance: number): boolean {
  return distance > 0 && drop / distance < DEBRIS_FLOW_STOP_RATIO;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// §C.2 Impulse wave in a lake (Heller & Hager 2010)
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Impact velocity from the energy line, m/s: v = √(2g(H − μ·L)) with μ the mass's mobility ratio, capped at 60 m/s.
 * A mass that only just reaches arrives slowly; one with a lot of drop to spare arrives fast. [H]
 */
export function impactVelocity(mass: MassMovement): number {
  const mu = mobilityRatio(mass);
  const head = mass.fallHeight - mu * mass.pathLength;
  return Math.min(IMPACT_VELOCITY_MAX, Math.sqrt(2 * G * Math.max(0, head)));
}

/** Bulk density of the slide (ice + rock deposit), kg/m³. */
export function slideDensity(mass: MassMovement): number {
  const f = Math.min(1, Math.max(0, mass.iceFraction));
  return f * RHO_ICE + (1 - f) * RHO_ROCK_BULK;
}

export interface ImpulseWave {
  /** Slide Froude number, relative thickness, relative mass, impact angle (rad) and the impulse product P. */
  F: number;
  S: number;
  M: number;
  alpha: number;
  P: number;
  /** Still-water depth used, m, and distance from impact to the dam, m. */
  depth: number;
  distance: number;
  /** Impact velocity, m/s. */
  vs: number;
  /** Max near-field crest amplitude and wave height in a laterally confined (2-D) reservoir, m, and its distance from
   * the impact, m (eqs. 3.13, 3.14, 3.16). */
  aMax: number;
  hMax: number;
  xM: number;
  /** Wave height and crest amplitude arriving at the dam, m (the lower of the 2-D decay and the spreading estimate). */
  heightAtDam: number;
  amplitudeAtDam: number;
  /** What the dam sees if the lake were a flume (eq. 3.19, a = 0.8 H): the old answer, kept for comparison. */
  heightAtDam2D: number;
  /** Wave period at the dam, s (eq. 3.20), and the wave type that picks the spreading pre-factors (Table 4-1). */
  period: number;
  waveType: 'Stokes' | 'cnoidal' | 'solitary';
  /** Spreading geometry used: side angle β and propagation angle γ′ from the slide axis to the dam, rad. */
  spread: number;
  angle: number;
  /** Parameters outside the laboratory ranges the equations were fitted on (manual Table 3-2), and caps applied. */
  warnings: string[];
}

/**
 * Where the dam lies relative to the slide (types.ts ImpulseGeometry): depth in the impact zone (default the lake's
 * mean depth V/A), distance to the dam (default √A), angle γ′ between the slide's direction of travel and the line to
 * the dam (default 0°), water-body side angle β (0° a flume, default 90° open water).
 */
export type WaveGeometry = ImpulseGeometry;

/**
 * Wave-type classification and the Ruffini et al. (2019) pre-factors κ for wave height and crest amplitude, from
 * Evers et al. 2019 manual Table 4-1 [V for κ; the class bounds T < (4/5)F^(−7/5) Stokes, ≤ 11·F^(−5/2) cnoidal, else
 * solitary, as read from the same table]. T = S^(1/3)·M·cos[(6/7)α] is the wave type product.
 */
function waveTypeOf(F: number, S: number, M: number, alpha: number): { type: ImpulseWave['waveType']; kH: number; kA: number } {
  const T = Math.cbrt(S) * M * Math.cos((6 / 7) * alpha);
  if (T < 0.8 * Math.pow(F, -1.4)) return { type: 'Stokes', kH: 1.1, kA: 1.01 };
  if (T <= 11 * Math.pow(F, -2.5)) return { type: 'cnoidal', kH: 1.03, kA: 0.85 };
  return { type: 'solitary', kH: 1.2, kA: 0.84 };
}

/**
 * Impulse wave in a lake from a mass movement (spec §C.2), from the VAW / Swiss Federal Office of Energy impulse-wave
 * manual: Evers, Heller, Fuchs, Hager & Boes, "Landslide-generated Impulse Waves in Reservoirs — Basics and
 * Computation", 2nd ed. v2.1 (SFOE, June 2023), which collects Heller & Hager 2010 (J. Waterway Port Coastal Ocean
 * Eng. 136(3):145–155) and Ruffini et al. 2019. Every coefficient below was checked against that text in Oct 2026 [V]:
 *
 *   F = v_s/√(gh)   S = s/h   M = ρ_s·V_s/(ρ_w·b·h²)   P = F·S^½·M^¼·{cos[(6/7)α]}^½          (3.12)
 *   H_M = (5/9)·P^(4/5)·h        x_M = (11/2)·P^½·h        a = (4/5)·H                       (3.13, 3.14, 3.16)
 *   H(x) = (3/4)·(P·X^(−1/3))^(4/5)·h  for X = x/h > X_M      T(x) = 9·P^¼·X^(5/16)·√(h/g)    (3.19, 3.20)
 *
 * Those are the "extreme case (a)": a wave running down a laterally CONFINED channel (a flume). A lake is not one:
 * the manual (§4.2.1) reports 3-D waves 2.7–8.4× smaller than 2-D at the same distance, and gives Ruffini et al.'s
 * energy argument for geometries in between, which this function applies from the end of the generation zone
 * (r′ = distance − x_M):
 *
 *   H(r′, γ′, β) = κ_H · H_M · (b/l_w)^½ · cos²(2γ′/3),   l_w = b + 2·r′·β   (wave front length)   (4.2, 4.3)
 *   a(r′, γ′, β) = κ_A · a_M · (b/l_w)^½ · cos²(2γ′/3)                                          (4.4)
 *
 * with β the water body's side angle (90° = open water) and γ′ the angle from the slide axis to the dam. The answer is
 * the lower of that and the flume decay (3.19) — spreading can only lower a wave. The dam sees the CREST AMPLITUDE a
 * (the manual's overtopping criterion is a > f, eq. 3.38), not the height H, which includes the trough: the first
 * version compared H with the freeboard. Finally a ≤ 0.78·h, the largest crest amplitude of a non-breaking solitary
 * wave (manual §3.3.3): a taller crest breaks and spends its energy before the dam [V for 0.78; its use as a cap is H].
 *
 * Calibration [C]: South Lhonak 2023 (14.7 Mm³ into a 1.67 km², ~61 m mean-depth lake; ~20 m wave observed): the
 * flume equations give H = 46 m at the outlet; open-water spreading with the lateral-moraine geometry of chain-defs.ts
 * (γ′ ≈ 77°) gives ≈ 15 m. The equations' laboratory ranges are reported as `warnings` (South Lhonak's M ≈ 14 is
 * above the tested 10).
 */
export function impulseWave(mass: MassMovement, lake: GlacialLake, geo: WaveGeometry = {}): ImpulseWave {
  const h = Math.max(1, geo.depth ?? (lake.area > 0 ? lake.volume.median / lake.area : 10));
  const x = Math.max(h, geo.distance ?? Math.sqrt(Math.max(lake.area, 0)));
  const L13 = Math.cbrt(mass.volume);
  const s = mass.thickness ?? SLIDE_THICKNESS_FACTOR * L13;
  const b = mass.width ?? SLIDE_WIDTH_FACTOR * L13;
  const alpha = (mass.impactAngleDeg ?? IMPACT_ANGLE) * DEG;
  const vs = impactVelocity(mass);
  const F = vs / Math.sqrt(G * h);
  const S = s / h;
  const M = (slideDensity(mass) * mass.volume) / (RHO_WATER * b * h * h);
  const P = F * Math.sqrt(S) * Math.pow(M, 0.25) * Math.sqrt(Math.max(0, Math.cos((6 / 7) * alpha)));
  const P45 = Math.pow(P, 0.8);
  const hMax = h * (5 / 9) * P45;
  const aMax = h * (4 / 9) * P45;
  const xM = 5.5 * Math.sqrt(P) * h;
  const X = x / h;
  const warnings: string[] = [];
  // Flume decay (3.19), valid beyond x_M; nearer than that the wave is still the near-field maximum.
  const h2D = x > xM ? Math.min(hMax, h * 0.75 * Math.pow(P * Math.pow(X, -1 / 3), 0.8)) : hMax;
  // Spreading (Ruffini et al. 2019 via the manual §4.2.1).
  const spread = (geo.spreadDeg ?? IMPULSE_SPREAD_DEG) * DEG;
  const angle = Math.min(90, Math.abs(geo.angleDeg ?? 0)) * DEG;
  const wt = waveTypeOf(F, S, M, alpha);
  const rp = Math.max(0, x - xM);
  const lw = b + 2 * rp * spread;
  const lateral = Math.pow(Math.cos((2 * angle) / 3), 2);
  const shrink = Math.sqrt(b / lw) * lateral;
  let heightAtDam = Math.min(h2D, wt.kH * hMax * shrink);
  let amplitudeAtDam = Math.min(0.8 * h2D, wt.kA * aMax * shrink);
  if (amplitudeAtDam > IMPULSE_A_BREAK * h) {
    warnings.push(`crest amplitude capped at ${IMPULSE_A_BREAK}·h (breaking limit of a solitary wave)`);
    const f = (IMPULSE_A_BREAK * h) / amplitudeAtDam;
    amplitudeAtDam *= f;
    heightAtDam *= f;
  }
  const range = (name: string, v: number, lo: number, hi: number) => {
    if (v < lo || v > hi) warnings.push(`${name} = ${v.toFixed(2)} outside the tested ${lo}–${hi}`);
  };
  range('F', F, 0.86, 6.83);
  range('S', S, 0.09, 1.64);
  range('M', M, 0.11, 10.02);
  range('P', P, 0.17, 8.13);
  if (alpha < 30 * DEG - 1e-9) warnings.push('impact angle below the tested 30°');
  const period = 9 * Math.pow(P, 0.25) * Math.pow(Math.max(X, xM / h), 5 / 16) * Math.sqrt(h / G);
  return {
    F,
    S,
    M,
    alpha,
    P,
    depth: h,
    distance: x,
    vs,
    aMax,
    hMax,
    xM,
    heightAtDam,
    amplitudeAtDam,
    heightAtDam2D: h2D,
    period,
    waveType: wt.type,
    spread,
    angle,
    warnings,
  };
}

export interface Overtopping {
  overtops: boolean;
  /** Wave height above the freeboard, m (0 when the lake survives). */
  excess: number;
  /** Overtopping volume V_ot = (H − f)·A·c_ot, m³ (c_ot = 0.3, heuristic). */
  volume: number;
  /** The pulse over the dam: V_ot over 60 s, as a hydrograph. */
  pulse: Hydrograph;
}

/**
 * Does the wave clear the dam (spec §C.2)? Crest amplitude a ≤ f: no — the lake survived, a valid outcome to show.
 * a > f (the manual's criterion, eq. 3.38's a_w = a − f): an overtopping pulse (V_ot = (a − f)·A·0.3 [H], released
 * over 60 s) and a breach that starts with the crest already scoured by (a − f) and cuts at the triggered rate
 * (chain.ts).
 */
export function overtopping(wave: ImpulseWave, lake: GlacialLake): Overtopping {
  const f = lake.freeboard ?? FREEBOARD_DEFAULT;
  const excess = Math.max(0, wave.amplitudeAtDam - f);
  if (!(excess > 0)) {
    return { overtops: false, excess: 0, volume: 0, pulse: { series: new Series([0, 1], [0, 0]), volume: 0, peak: 0, tPeak: 0 } };
  }
  const volume = Math.min(lake.volume.median, excess * lake.area * OVERTOPPING_COEFF);
  const T = OVERTOPPING_PULSE;
  // A triangle with a 10 s rise: volume = ½·T·Qp.
  const qp = (2 * volume) / T;
  const series = new Series([0, 10, T], [0, qp, 0]);
  return { overtops: true, excess, volume, pulse: { series, volume, peak: qp, tPeak: 10 } };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// §C.3 / §C.4 Mass into a river; debris-flow peak and velocity
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Debris-flow peak discharge relations (Rickenmann 1999, Table / text [V]); M = total debris-flow volume, m³. */
export const DEBRIS_PEAK_RELATIONS = {
  /** Granular alpine debris flows — upper-envelope character. Fitted on M ≲ 10⁶ m³. */
  rickenmannGranular: (M: number) => 0.1 * Math.pow(M, 5 / 6),
  /** Granular, Japan (Mizuyama et al. 1992). */
  mizuyamaGranular: (M: number) => 0.135 * Math.pow(M, 0.78),
  /** Muddy, Japan (Jitousono et al. 1996). */
  jitousonoMuddy: (M: number) => 0.0188 * Math.pow(M, 0.79),
} as const;
export type DebrisPeakRelation = keyof typeof DEBRIS_PEAK_RELATIONS;

/**
 * Default relation for an ice-rock avalanche turning into a debris flow: the MUDDY one. Calibration [C]: Chamoli 2021,
 * M = 26.9 Mm³ detached → 0.0188·M^0.79 ≈ 13,900 m³/s, inside Shugar et al.'s 8,200–14,200 m³/s at Raini; the
 * granular envelope 0.1·M^(5/6) gives ~156,000 m³/s there — it was fitted on flows under ~10⁶ m³ and its exponent
 * runs away at 10⁷–10⁸ m³.
 */
export const DIRECT_FLOW_PEAK: DebrisPeakRelation = 'jitousonoMuddy';

/** Rickenmann 1999 mean debris-flow velocity, m/s: V = 2.1·Q^0.33·S^0.33. [V] */
export function debrisFlowVelocity(q: number, slope: number): number {
  return 2.1 * Math.pow(Math.max(q, 0), 0.33) * Math.pow(Math.max(slope, 0), 0.33);
}

/** Manning–Strickler velocity with debris-flow roughness (n ≈ 0.1; 0.067 clear-water torrents), m/s. [V] */
export function manningVelocity(depth: number, slope: number, n = 0.1): number {
  return (Math.pow(Math.max(depth, 0), 2 / 3) * Math.sqrt(Math.max(slope, 0))) / n;
}

export interface DirectFlow extends Hydrograph {
  /** Water (melted ice) volume, m³, sediment concentration of the flow, and its mixture volume, m³. */
  water: number;
  cv: number;
  mixture: number;
}

/**
 * The avalanche itself becomes the flood (spec §C.3 branch 2, Chamoli 2021): water = the ice that melts on the way
 * (frictional heating melted "almost all" of Chamoli's 5–6 Mm³ of ice, Shugar 2021 [V]); the flow leaves the impact
 * as a mixture at concentration Cv, so its volume is water/(1 − Cv); peak from the debris-flow relation on the whole
 * detached volume; shape the a = 3 gamma curve with that exact mixture volume (§B.4).
 *
 * Chamoli check [C]: 26.9 Mm³, 20 % ice → 4.9 Mm³ water, 8.2 Mm³ of mixture at Cv 0.4, Qp ≈ 13,900 m³/s, tp ≈ 6.6 min,
 * most of it through in 15–20 min — Shugar's "10–20 min" at Raini.
 */
export function directFlow(
  mass: MassMovement,
  opts: { cv?: number; relation?: DebrisPeakRelation; meltFraction?: number; shape?: DirectFlowShape } = {},
): DirectFlow {
  const cv = Math.min(0.6, Math.max(0, opts.cv ?? DIRECT_FLOW_CV));
  const water = mass.volume * Math.min(1, Math.max(0, mass.iceFraction)) * (opts.meltFraction ?? ICE_MELT_FRACTION) * (RHO_ICE / RHO_WATER);
  const mixture = water / (1 - cv);
  const qp = DEBRIS_PEAK_RELATIONS[opts.relation ?? DIRECT_FLOW_PEAK](mass.volume);
  const h = (opts.shape ?? 'gamma') === 'surge' ? surgeHydrograph(qp, mixture, surgeRiseTime(mass)) : gammaHydrograph(qp, mixture);
  return { ...h, water, cv, mixture };
}

/**
 * Shape of the direct-flow hydrograph where the mass enters the river:
 *   'gamma' (the default, and the first calibration's): the §B.4 gamma curve, a = 3 — a breach's shape, whose peak
 *           comes tp = V/(1.488·Qp) after the start (6.6 min for Chamoli, 11 min for Nepal 2026): the water "waits" for
 *           a lake that is not there;
 *   'surge': a debris-flow SURGE — the peak arrives with the mass, then a linear recession (surgeHydrograph).
 */
export type DirectFlowShape = 'gamma' | 'surge';

/**
 * Rise time of a direct-flow surge, s: the time the avalanche body takes to pass into the river, its length over its
 * speed, ℓ / v. ℓ = V / (b·s) with the slide width b = 2·V^(1/3) and thickness s = 0.25·V^(1/3) this module already
 * assumes for slides with no measured geometry (SLIDE_WIDTH_FACTOR, SLIDE_THICKNESS_FACTOR) — ℓ = 2·V^(1/3); for
 * Chamoli ≈ 600 m, the length Shugar et al.'s slab (26.9 Mm³, ~550 m wide, ~80 m thick) implies (≈ 610 m) [C]. v is
 * the mass's travel speed (MassMovement.travelSpeed, default AVALANCHE_SPEED). Tens of seconds: at the routing's scale
 * the surge front is a step. [H]
 */
export function surgeRiseTime(mass: MassMovement): number {
  const L13 = Math.cbrt(Math.max(mass.volume, 0));
  const b = mass.width ?? SLIDE_WIDTH_FACTOR * L13;
  const s = mass.thickness ?? SLIDE_THICKNESS_FACTOR * L13;
  const len = b > 0 && s > 0 ? mass.volume / (b * s) : 0;
  const v = mass.travelSpeed ?? AVALANCHE_SPEED;
  return v > 0 ? len / v : 0;
}

/**
 * A debris-flow surge (spec §C.3 branch 2): linear rise to Qp over `rise` seconds, then a linear recession to zero at
 * T = 2V/Qp, so the volume is exactly V (a triangle; needs T > rise, else the rise is shortened to T/2).
 *
 * Why this shape for an avalanche that becomes the flood. A debris flow's discharge is highest at its FRONT — the
 * coarse, deep surge head — and decays behind it (Iverson 1997, Rev. Geophys. 35:245–296, the surge-front structure of
 * debris flows [M]; Rickenmann 1999 §2, the bouldery front [M]); a mass that hits the river at tens of m/s is already
 * moving and does not need a breach to grow before it flows. The gamma curve used before put Chamoli's peak 6.6 min and
 * Nepal's 11 min after the mass reached the river, and the 5 %-of-peak front waited for its slow rising limb. Same peak
 * relation and same volume as the gamma: only the timing within the surge changes. Duration check [C]: Chamoli,
 * T = 2 × 6.2 Mm³ / 13,900 m³/s ≈ 15 min against Shugar et al.'s "10–20 min" at Raini [V].
 */
export function surgeHydrograph(qPeak: number, volume: number, rise: number): Hydrograph {
  if (!(qPeak > 0) || !(volume > 0)) return { series: new Series([0, 1], [0, 0]), volume: 0, peak: 0, tPeak: 0 };
  const T = (2 * volume) / qPeak;
  const tr = Math.min(Math.max(rise, 1), 0.5 * T);
  const series = new Series([0, tr, T], [0, qPeak, 0]);
  return { series, volume: series.total, peak: qPeak, tPeak: tr };
}

/**
 * Height of the dam an avalanche deposit makes in a valley, m (spec §C.3 branch 1): solve V_d = A(H)·L_d for H, where
 * A(H) is the valley cross-section area below height H above the thalweg (from the ChainFile section at the impact)
 * and L_d the deposit length. `areaAt` must be non-decreasing; the answer is capped at `hMax`.
 */
export function damHeight(depositVolume: number, damLength: number, areaAt: (h: number) => number, hMax = 500): number {
  const target = depositVolume / Math.max(1, damLength);
  if (!(target > 0)) return 0;
  if (areaAt(hMax) <= target) return hMax;
  let lo = 0;
  let hi = hMax;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (areaAt(mid) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// §C.5 Bulking
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Bulked discharge (or volume) of water carrying sediment at volumetric concentration Cv: Q_w/(1 − Cv). */
export function bulked(qWater: number, cv: number): number {
  return qWater / (1 - Math.min(0.95, Math.max(0, cv)));
}

/** Mixture density ρ_w(1 − Cv) + ρ_s·Cv, kg/m³. */
export function mixtureDensity(cv: number): number {
  return RHO_WATER * (1 - cv) + RHO_SEDIMENT * cv;
}

/** Flow type by Cv (FLO-2D / O'Brien convention [M]). */
export function flowType(cv: number): 'water flood' | 'mud flood' | 'mudflow' | 'landslide' {
  if (cv < 0.2) return 'water flood';
  if (cv < 0.45) return 'mud flood';
  if (cv <= 0.55) return 'mudflow';
  return 'landslide';
}

/** The largest Cv a flow can carry: 0.9·C* (C* = 0.65 packing). */
export const CV_MAX = 0.9 * PACKING_CONCENTRATION;

/**
 * Takahashi 1978 equilibrium concentration on a bed of slope θ (rad):
 *   C∞ = ρ_w·tanθ / ((ρ_s − ρ_w)(tanφ − tanθ)),  φ = 35°, capped at 0.9·C*.
 * ≈ 0.20 at 10°, 0.38 at 15°, at the cap from ~19° up, ≈ 0.05 at 3°. [M for the formula, C for the numbers]
 */
export function takahashiCv(theta: number): number {
  const t = Math.tan(Math.max(0, theta));
  const tp = Math.tan(FRICTION_ANGLE * DEG);
  if (t >= tp) return CV_MAX;
  return Math.min(CV_MAX, (RHO_WATER * t) / ((RHO_SEDIMENT - RHO_WATER) * (tp - t)));
}

/**
 * Manning n multiplier for a sediment-laden flow, normalised to 1 for clear water:
 * (1 + 0.0538·e^{6.0896·Cv}) / 1.0538 (Lin, Wang & Huang 2005 eq. 7 [V]; their n_td carries the +5.4 % even at Cv = 0,
 * which would silently roughen every clear-water run — the bake's n is already a clear-water n).
 */
export function dispersiveManningFactor(cv: number): number {
  if (!(cv > 0)) return 1;
  return (1 + NTD_A * Math.exp(NTD_B * Math.min(cv, CV_MAX))) / (1 + NTD_A);
}
