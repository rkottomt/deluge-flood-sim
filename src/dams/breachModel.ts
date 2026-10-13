/**
 * Dam-breach scenarios for an NID dam: Froehlich (2008) breach parameters, a breach outflow hydrograph from the
 * weir-flow + linear-growth ODE the glacier chain already uses (src/hazard/breach.ts weirErosionBreach), and the
 * published peak-discharge regressions as a cross-check band.
 *
 * WHAT A "SCENARIO" IS (FEMA P-946, Federal Guidelines for Inundation Mapping of Flood Risks Associated with Dam
 * Incidents and Failures, 2013, §3):
 *   sunny     "Sunny-day" failure: the reservoir at its normal pool, no flood coming down the river, failure by
 *             internal erosion (piping). Froehlich 2008 failure-mode factor K₀ = 1.0, breach side slope 0.7 (H:V).
 *   flood     Flood-induced failure: the reservoir at its maximum (NID storage, i.e. the top of the dam), overtopping.
 *             K₀ = 1.3, side slope 1.0. The river's own flood passes the dam at the same
 *             time: the NID's maximum spillway discharge is added as a base flow under the breach wave for as long as
 *             the breach runs (then ramps off over an hour) — a stated assumption, since the NID gives a spillway
 *             CAPACITY, not the inflow flood that caused the failure.
 *
 * FROEHLICH 2008 (J. Water Resour. Plann. Manage. 134(3):217, doi:10.1061/(ASCE)0733-9496(2008)134:3(217)), SI units:
 *   average breach width  B̄ = 0.27 · K₀ · V_w^0.32 · h_b^0.04        (V_w m³ released, h_b breach height m)
 *   formation time        t_f = 63.2 · √(V_w / (g · h_b²))   s
 *   K₀ = 1.3 overtopping, 1.0 otherwise; side slope z = 1.0 overtopping, 0.7 otherwise.
 * Teton 1976 (piping; V_w 3.10×10⁸ m³, h_b 86.9 m): B̄ 168 m vs 151 m observed, t_f 1.14 h vs 1.25 h (Wahl 1998,
 * USBR DSO-98-004) — tests/dams/breachModel.test.ts.
 *
 * THE HYDROGRAPH. The breach grows linearly from the crest to the streambed over t_f, its bottom width reaching
 * B̄ − z·h_b, as HEC-RAS's parametric breach does; outflow is the broad-crested trapezoidal weir of src/hazard/breach.ts;
 * the reservoir drains by level-pool routing with storage V(s) = V₀·(s/h_w)^p. The exponent p comes from the NID
 * itself: at the surface dV/ds = A, so p = A·h/V (surface area, depth and volume at normal pool), clamped to [1, 4];
 * 2.5 (a valley reservoir between a wedge and a cone) when the NID gives no area. Piping is modelled as the same
 * growing weir, not as an orifice that later collapses — it reaches the same full breach, slightly earlier.
 *
 * PEAK RELATIONS, the band shown next to the modelled peak (V_w m³, h_w head above the breach bottom m):
 *   MacDonald & Langridge-Monopolis 1984 (J. Hydraul. Div. — earthfill): Q_p = 1.154 · (V_w · h_w)^0.412
 *   Froehlich 1995 (src/hazard/breach.ts):                                Q_p = 0.607 · V_w^0.295 · h_w^1.24
 *   Froehlich 2016 (J. Hydraul. Eng. 142(4), doi:10.1061/(ASCE)HY.1943-7900.0001080):
 *     Q_p = 0.0175 · k_M · k_H · √(g · V_w · h_w · h_b² / B̄),  k_M = 1.85 overtopping else 1, k_H = (h_b/6.1)^⅛ above 6.1 m
 * Teton's observed peak, ~65,000 m³/s (Wahl 1998: 65,120), is the anchor test.
 *
 * TWO HYDROGRAPH METHODS (BreachMethod). 'parametric' (default) is the breach ODE above. On Teton it peaks at
 * ~107,000 m³/s with p = 2.5 (~98,000 at p = 2): +50–65 % — a parametric breach with Fread's weir coefficients and no
 * tailwater is conservative, which is the side an inundation map for emergency planning should err on. 'regression'
 * is a gamma-shaped hydrograph (src/hazard/breach.ts gammaHydrograph, exact volume) whose peak is Froehlich 2016's —
 * 79,000 m³/s on Teton (+22 %), the relation fitted to the largest set of documented embankment failures. Both are
 * offered; the spread between them is part of the answer.
 *
 * HONEST LIMITS (shown with every run): the reservoir is the NID's storage and area, not a bathymetric survey; there are
 * no spillways, gates or outlet works in the model; the relations were fitted mostly to embankment (earth / rockfill)
 * dams — for concrete and masonry dams they are indicative only; and the NID height is used as the breach height.
 */
import { gammaHydrograph, PEAK_RELATIONS, weirErosionBreach } from '../hazard/breach';
import type { HydrographPoint } from '../contracts';
import { ACRE_FT_M3, ACRE_M2, CFS_M3S, EMBANKMENT_TYPES, type NidDam } from './nidIndex';

export const G = 9.81;
export type BreachMode = 'sunny' | 'flood';
export type BreachMethod = 'parametric' | 'regression';
export const BREACH_METHODS: Readonly<Record<BreachMethod, string>> = {
  parametric: 'Froehlich 2008 breach + weir outflow (physically based)',
  regression: 'Froehlich 2016 peak, gamma-shaped hydrograph',
};

export const BREACH_MODES: Readonly<Record<BreachMode, { label: string; short: string; k0: number; sideSlope: number; overtopping: boolean }>> = {
  sunny: { label: 'Sunny-day failure (piping at normal pool)', short: 'Sunny-day', k0: 1.0, sideSlope: 0.7, overtopping: false },
  flood: { label: 'Flood-induced failure (overtopping at maximum pool)', short: 'Flood-induced', k0: 1.3, sideSlope: 1.0, overtopping: true },
};

/** Hypsometric exponent when the NID gives no surface area [M]. */
export const DEFAULT_HYPSOMETRY = 2.5;
/** When the NID gives no normal storage, a sunny-day failure releases this share of the maximum storage [M]. */
export const NORMAL_STORAGE_FALLBACK = 0.5;
/** Points in the hydrograph handed to the 2-D solver (resampled; volume kept exact). */
export const HYDROGRAPH_POINTS = 480;
/** The breach ODE runs at most this long (a large reservoir drains for many hours), s. */
export const BREACH_RUN_MAX_S = 48 * 3600;
/** The flood-induced base flow ramps off over this long once the breach has drained, s. */
export const BASE_FLOW_RAMP_S = 3600;

/** Froehlich 2008 average breach width, m. */
export function froehlich2008Width(volumeM3: number, breachHeightM: number, overtopping: boolean): number {
  return 0.27 * (overtopping ? 1.3 : 1.0) * Math.pow(volumeM3, 0.32) * Math.pow(breachHeightM, 0.04);
}

/** Froehlich 2008 breach formation time, s. */
export function froehlich2008Time(volumeM3: number, breachHeightM: number): number {
  return 63.2 * Math.sqrt(volumeM3 / (G * breachHeightM * breachHeightM));
}

/** MacDonald & Langridge-Monopolis 1984 peak outflow, m³/s (earthfill dams). */
export function macDonald1984Peak(volumeM3: number, headM: number): number {
  return 1.154 * Math.pow(volumeM3 * headM, 0.412);
}

/** Froehlich 2016 peak outflow, m³/s. */
export function froehlich2016Peak(volumeM3: number, headM: number, breachHeightM: number, avgWidthM: number, overtopping: boolean): number {
  const kM = overtopping ? 1.85 : 1;
  const kH = breachHeightM > 6.1 ? Math.pow(breachHeightM / 6.1, 1 / 8) : 1;
  return 0.0175 * kM * kH * Math.sqrt((G * volumeM3 * headM * breachHeightM * breachHeightM) / Math.max(1, avgWidthM));
}

export interface BreachInput {
  /** Released volume, m³ (the pool above the breach bottom). */
  volumeM3: number;
  /** Head above the breach bottom at failure, m. */
  headM: number;
  /** Breach height (crest to breach bottom), m. */
  breachHeightM: number;
  overtopping: boolean;
  /** Hypsometric exponent p of V(s) = V₀ (s/h)^p. */
  hypsometry?: number;
  /** Cap on the average breach width (the dam's length), m. */
  maxWidthM?: number | null;
  /** Base flow under the wave (flood-induced: the spillway's design discharge), m³/s. */
  baseFlow?: number;
  /** Default 'parametric'. */
  method?: BreachMethod;
}

export interface BreachResult {
  input: Required<Omit<BreachInput, 'maxWidthM'>> & { maxWidthM: number | null };
  method: BreachMethod;
  /** Froehlich 2008. */
  avgWidthM: number;
  bottomWidthM: number;
  sideSlope: number;
  formationTimeS: number;
  /** The modelled breach outflow (no base flow): peak and when. */
  peak: number;
  tPeak: number;
  /** Volume through the breach, m³ (= the series' integral). */
  breachVolume: number;
  /** What the 2-D solver receives (breach + base flow), resampled, exact volume. Starts at t = 0. */
  hydrograph: HydrographPoint[];
  /** ∫ of `hydrograph`, m³. */
  deliveredVolume: number;
  /** The published regressions' answers, m³/s. */
  relations: Array<{ id: string; label: string; cite: string; peak: number }>;
}

/** The breach outflow hydrograph and its parameters. */
export function damBreach(input: BreachInput): BreachResult {
  const V = input.volumeM3;
  const hw = input.headM;
  const hb = Math.max(input.breachHeightM, hw);
  const over = input.overtopping;
  const z = over ? 1.0 : 0.7;
  const p = Math.min(4, Math.max(1, input.hypsometry ?? DEFAULT_HYPSOMETRY));
  let avg = froehlich2008Width(V, hb, over);
  if (input.maxWidthM && input.maxWidthM > 0) avg = Math.min(avg, input.maxWidthM);
  const bottom = Math.max(1, avg - z * hb);
  const tf = froehlich2008Time(V, hb);
  const base = Math.max(0, input.baseFlow ?? 0);
  const method: BreachMethod = input.method === 'regression' ? 'regression' : 'parametric';
  const q16 = froehlich2016Peak(V, hw, hb, avg, over);
  const h = method === 'regression' ? gammaHydrograph(q16, V) : weirErosionBreach({
    volume: V,
    depth: hw,
    erosionRate: (3600 * hw) / tf,
    widthRatio: bottom / hw,
    sideSlope: z,
    hypsometry: p,
    startHead: Math.min(0.5, 0.1 * hw),
    minWidth: 1,
    dt: Math.max(1, Math.min(10, tf / 600)),
    tMax: BREACH_RUN_MAX_S,
  });
  const hydrograph = resample(h.series.t, h.series.q, base);
  let delivered = 0;
  for (let i = 1; i < hydrograph.length; i++) delivered += 0.5 * (hydrograph[i].q + hydrograph[i - 1].q) * (hydrograph[i].t - hydrograph[i - 1].t);
  const relations = [
    { id: 'macdonald1984', label: 'MacDonald & Langridge-Monopolis 1984', cite: 'MacDonald & Langridge-Monopolis 1984, J. Hydraul. Eng. 110(5):567', peak: macDonald1984Peak(V, hw) },
    { id: 'froehlich1995', label: PEAK_RELATIONS.froehlich1995.label, cite: PEAK_RELATIONS.froehlich1995.cite, peak: PEAK_RELATIONS.froehlich1995.qp(V, hw) },
    { id: 'froehlich2016', label: 'Froehlich 2016', cite: 'Froehlich 2016, J. Hydraul. Eng. 142(4):04015059', peak: q16 },
  ];
  return {
    input: { volumeM3: V, headM: hw, breachHeightM: hb, overtopping: over, hypsometry: p, baseFlow: base, maxWidthM: input.maxWidthM ?? null, method },
    method,
    avgWidthM: avg,
    bottomWidthM: bottom,
    sideSlope: z,
    formationTimeS: tf,
    peak: h.peak,
    tPeak: h.tPeak,
    breachVolume: h.volume,
    hydrograph,
    deliveredVolume: delivered,
    relations,
  };
}

/**
 * Resample a dense breach series to ~HYDROGRAPH_POINTS points, keeping its volume EXACT: values at uniform times, then
 * every point scaled by (true volume / trapezoid of the samples) — the same rule as the chain's toWaterSource. A base
 * flow is added under it for the breach's whole run and ramped off over BASE_FLOW_RAMP_S after it.
 */
export function resample(t: ArrayLike<number>, q: ArrayLike<number>, baseFlow = 0): HydrographPoint[] {
  const n = t.length;
  const tEnd = t[n - 1];
  let truth = 0;
  for (let i = 1; i < n; i++) truth += 0.5 * (q[i] + q[i - 1]) * (t[i] - t[i - 1]);
  const steps = Math.max(8, Math.min(HYDROGRAPH_POINTS, Math.ceil(tEnd / 5)));
  const dt = tEnd / steps;
  const out: HydrographPoint[] = [];
  let j = 0;
  for (let k = 0; k <= steps; k++) {
    const tk = k === steps ? tEnd : k * dt;
    while (j < n - 2 && t[j + 1] < tk) j++;
    const a = t[j];
    const b = t[j + 1];
    const qk = b > a ? q[j] + ((q[j + 1] - q[j]) * Math.min(1, Math.max(0, (tk - a) / (b - a)))) : q[j];
    out.push({ t: tk, q: Math.max(0, qk) });
  }
  out[0].q = 0;
  out[out.length - 1].q = 0;
  // Exact breach volume, keeping the peak sample's place: the scale factor is within a few 1e-3 of 1.
  let trap = 0;
  for (let i = 1; i < out.length; i++) trap += 0.5 * (out[i].q + out[i - 1].q) * (out[i].t - out[i - 1].t);
  const f = trap > 0 ? truth / trap : 0;
  for (const p of out) p.q = p.q * f + baseFlow;
  if (baseFlow > 0) {
    out[0].q = baseFlow;
    out.push({ t: tEnd + BASE_FLOW_RAMP_S, q: 0 });
  }
  return out;
}

// ─── An NID dam's scenario ────────────────────────────────────────────────────────────────────────────────────────────

export interface DamScenario {
  dam: NidDam;
  mode: BreachMode;
  method: BreachMethod;
  result: BreachResult;
  /** Reservoir level at failure above the streambed, m. */
  headM: number;
  volumeM3: number;
  /** Plain-language assumptions this scenario had to make for this dam (each a sentence). */
  assumptions: string[];
  /** Caveats that travel with every dam-breach result. */
  caveats: string[];
}

export const DAM_BREACH_CAVEATS: readonly string[] = [
  'The reservoir is the National Inventory of Dams’ storage and surface area, not a bathymetric survey: its shape is a power law fitted to those two numbers.',
  'The breach is the Froehlich (2008) regression’s average width and formation time (one of the breach-parameter regressions FEMA P-946 points to) — not a site-specific breach study. Published peak relations for the same dam spread by a factor of two or more (shown).',
  'No hydraulic structures: spillways, gates, outlet works and downstream dams and bridges are not modelled; terrain is bare-earth USGS 3DEP with river channels burned to a nominal depth.',
  'The breach outflow enters the map as a discharge just downstream of the dam (the lowest ground near it), not as a reservoir draining through a gap in a wall: the 3DEP surface over the reservoir is the water, not the lake bed.',
  'Screening for emergency planning, not an inundation map for an Emergency Action Plan: those need a licensed engineer’s breach study and model.',
];

/** p = A·h/V at normal pool, with h itself from p (a fixed point; converges in a few steps). */
export function hypsometryFor(dam: NidDam, hwMax: number): { p: number; fromNid: boolean } {
  const A = dam.surfaceAreaAc ? dam.surfaceAreaAc * ACRE_M2 : null;
  if (!A || !(hwMax > 0)) return { p: DEFAULT_HYPSOMETRY, fromNid: false };
  const Vmax = dam.storageAcFt * ACRE_FT_M3;
  const Vn = (dam.normalStorageAcFt && dam.normalStorageAcFt <= dam.storageAcFt ? dam.normalStorageAcFt : dam.storageAcFt) * ACRE_FT_M3;
  let p = DEFAULT_HYPSOMETRY;
  for (let i = 0; i < 30; i++) {
    const hn = hwMax * Math.pow(Vn / Vmax, 1 / p);
    p = Math.min(4, Math.max(1, (A * hn) / Vn));
  }
  return { p, fromNid: true };
}

/** Build a breach scenario for an NID dam. */
export function damScenario(dam: NidDam, mode: BreachMode, method: BreachMethod = 'parametric'): DamScenario {
  const m = BREACH_MODES[mode];
  const assumptions: string[] = [];
  const hwMax = Math.min(dam.heightM, dam.hydraulicHeightM ?? dam.heightM);
  if (dam.hydraulicHeightM === null) assumptions.push(`No hydraulic height in the NID: the reservoir at its maximum is taken to stand at the full NID height (${dam.heightM.toFixed(1)} m).`);
  const hyp = hypsometryFor(dam, hwMax);
  if (!hyp.fromNid) assumptions.push(`No surface area in the NID: reservoir shape exponent ${DEFAULT_HYPSOMETRY} (a typical valley reservoir).`);
  const Vmax = dam.storageAcFt * ACRE_FT_M3;
  let V = Vmax;
  let hw = hwMax;
  if (mode === 'sunny') {
    const normal = dam.normalStorageAcFt && dam.normalStorageAcFt <= dam.storageAcFt ? dam.normalStorageAcFt : null;
    if (normal === null) assumptions.push(`No normal storage in the NID: a sunny-day failure releases ${Math.round(NORMAL_STORAGE_FALLBACK * 100)} % of the maximum storage.`);
    V = (normal ?? NORMAL_STORAGE_FALLBACK * dam.storageAcFt) * ACRE_FT_M3;
    hw = hwMax * Math.pow(V / Vmax, 1 / hyp.p);
  }
  let base = 0;
  if (mode === 'flood') {
    if (dam.maxDischargeCfs) {
      base = dam.maxDischargeCfs * CFS_M3S;
      assumptions.push(`The river’s flood passing the dam is taken as the NID maximum spillway discharge, ${Math.round(base).toLocaleString('en-US')} m³/s, under the breach wave.`);
    } else assumptions.push('No maximum discharge in the NID: the breach wave runs on a dry river (no flood base flow).');
  }
  if (!EMBANKMENT_TYPES.has(dam.damType)) assumptions.push(`A ${dam.damType.toLowerCase()} dam: the breach relations were fitted mostly to earth and rockfill embankments, so these numbers are indicative only.`);
  const result = damBreach({
    volumeM3: V,
    headM: Math.max(0.5, hw),
    breachHeightM: dam.heightM,
    overtopping: m.overtopping,
    hypsometry: hyp.p,
    maxWidthM: dam.lengthFt ? dam.lengthFt * 0.3048 : null,
    baseFlow: base,
    method,
  });
  return { dam, mode, method, result, headM: Math.max(0.5, hw), volumeM3: V, assumptions, caveats: [...DAM_BREACH_CAVEATS] };
}
