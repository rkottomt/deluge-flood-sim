/**
 * Dam-breach scenarios for an NID dam: the published breach relations side by side (src/dams/breachRelations.ts), a
 * low / central / high band across them, and the breach outflow hydrograph the map receives.
 *
 * WHAT A "SCENARIO" IS (FEMA P-946, Federal Guidelines for Inundation Mapping of Flood Risks Associated with Dam
 * Incidents and Failures, 2013, §3):
 *   sunny     "Sunny-day" failure: the reservoir at its normal pool, no flood coming down the river, failure by
 *             internal erosion (piping).
 *   flood     Flood-induced failure: the reservoir at its maximum (NID storage, i.e. the top of the dam), overtopping.
 *             The river's own flood passes the dam at the same time: the NID's maximum spillway discharge is added as
 *             a base flow under the breach wave for as long as the breach runs (then ramps off over an hour) — a stated
 *             assumption, since the NID gives a spillway CAPACITY, not the inflow flood that caused the failure.
 *
 * THE BAND. Eight published relations (three breach-parameter relations routed through the reservoir, five peak
 * regressions) give eight peaks for the same dam; low and high are the extremes, central is the relation that best
 * reproduces 21 documented failures with measured peaks (src/dams/historicalFailures.ts, Wahl 1998 Table A1):
 * Froehlich 1995's peak regression — RMS log error 0.15 (a factor of 1.4), all 21 within a factor of two, a mean
 * under-prediction of 16 %. On Teton 1976 (65,120 m³/s observed) the band is 22,000–107,000 m³/s and the central case
 * 43,000: the central case is not tuned to Teton, and on Teton it is low by a third.
 *
 * FOUR HYDROGRAPHS (BreachMethod):
 *   central     (default) a gamma-shaped hydrograph (src/hazard/breach.ts gammaHydrograph, exact volume) whose peak is
 *               the central relation's;
 *   low, high   the same shape with the band's lowest and highest peak — run them to see the spread on the map;
 *   parametric  Froehlich 2008's breach width and formation time, the breach growing linearly from the crest to the
 *               streambed (HEC-RAS's parametric breach) with the broad-crested trapezoidal weir of
 *               src/hazard/breach.ts, the reservoir draining by level-pool routing with V(s) = V₀·(s/h_w)^p. The
 *               exponent p comes from the NID itself: at the surface dV/ds = A, so p = A·h/V (surface area, depth and
 *               volume at normal pool), clamped to [1, 4]; 2.5 (a valley reservoir between a wedge and a cone) when the
 *               NID gives no area. Until this band existed this was the default; on the historical table it
 *               over-predicts by 20 % on average (RMS log error 0.20) and Teton by 64 %.
 *
 * DRY DAMS. A normal storage of 0 in the NID (isDryDam: flood-control detention dams, tailings and debris basins) means
 * no permanent pool: nothing to release on a sunny day, so there is no sunny-day failure — asking for one gives the
 * flood-induced failure (the only way such a dam fails with water behind it) and says so. That is not the
 * unreported case (null), which keeps the NORMAL_STORAGE_FALLBACK guess.
 *
 * HONEST LIMITS (shown with every run): the reservoir is the NID's storage and area, not a bathymetric survey; there are
 * no spillways, gates or outlet works in the model; the relations were fitted mostly to embankment (earth / rockfill)
 * dams — for concrete and masonry dams they are indicative only; and the NID height is used as the breach height.
 */
import { gammaHydrograph, weirErosionBreach } from '../hazard/breach';
import type { HydrographPoint } from '../contracts';
import {
  CENTRAL_RELATION,
  froehlich2008Geometry,
  peakBand,
  relationById,
  type DamCase,
  type PeakBand,
  type XuZhangDamType,
} from './breachRelations';
import { ACRE_FT_M3, ACRE_M2, CFS_M3S, EMBANKMENT_TYPES, isDryDam, type NidDam } from './nidIndex';

export { froehlich2016Peak, macDonald1984Peak } from './breachRelations';

export const G = 9.81;
export type BreachMode = 'sunny' | 'flood';
export type BreachMethod = 'central' | 'low' | 'high' | 'parametric';
export const DEFAULT_BREACH_METHOD: BreachMethod = 'central';
export const BREACH_METHOD_IDS: readonly BreachMethod[] = ['central', 'low', 'high', 'parametric'];
export const BREACH_METHODS: Readonly<Record<BreachMethod, string>> = {
  central: `Central case: ${relationById(CENTRAL_RELATION).label} (best on 21 historical failures)`,
  low: 'Low case: the lowest of the published relations',
  high: 'High case: the highest of the published relations',
  parametric: 'Froehlich 2008 breach + weir outflow (physically based)',
};

export const BREACH_MODES: Readonly<Record<BreachMode, { label: string; short: string; k0: number; sideSlope: number; overtopping: boolean }>> = {
  sunny: { label: 'Sunny-day failure (piping at normal pool)', short: 'Sunny-day', k0: 1.0, sideSlope: 0.7, overtopping: false },
  flood: { label: 'Flood-induced failure (overtopping at maximum pool)', short: 'Flood-induced', k0: 1.3, sideSlope: 1.0, overtopping: true },
};

/** The largest documented failure in the breach databases the relations were fitted to (Teton 1976; Wahl 1998). */
export const FITTED_RANGE = { volumeM3: 310e6, headM: 77.4 } as const;
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
  return froehlich2008Geometry({ volumeM3, breachHeightM, overtopping }).avgWidthM;
}

/** Froehlich 2008 breach formation time, s. */
export function froehlich2008Time(volumeM3: number, breachHeightM: number): number {
  return froehlich2008Geometry({ volumeM3, breachHeightM, overtopping: false }).formationTimeS;
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
  /** Default 'central'. */
  method?: BreachMethod;
  /** Dam height (Xu & Zhang), m; default the breach height. */
  damHeightM?: number;
  /** Reservoir storage (Von Thun & Gillette's C_b), m³; default the released volume. */
  storageM3?: number;
  /** Xu & Zhang dam class (null: not applicable); default 'homogeneous'. */
  xzType?: XuZhangDamType | null;
  /** Von Thun & Gillette's formation time: easily erodible (default) or erosion resistant. */
  easilyErodible?: boolean;
}

export interface BreachResult {
  input: Required<Omit<BreachInput, 'maxWidthM' | 'damHeightM' | 'storageM3' | 'xzType' | 'easilyErodible'>> & { maxWidthM: number | null };
  method: BreachMethod;
  /** Froehlich 2008. */
  avgWidthM: number;
  bottomWidthM: number;
  sideSlope: number;
  formationTimeS: number;
  /** The breach outflow of the chosen method (no base flow): peak and when. */
  peak: number;
  tPeak: number;
  /** Volume through the breach, m³ (= the series' integral). */
  breachVolume: number;
  /** What the 2-D solver receives (breach + base flow), resampled, exact volume. Starts at t = 0. */
  hydrograph: HydrographPoint[];
  /** ∫ of `hydrograph`, m³. */
  deliveredVolume: number;
  /** Every applicable relation's peak, m³/s. */
  relations: PeakBand['values'];
  /** Low / central / high across the relations. */
  band: PeakBand;
}

/** The breach outflow hydrograph and its parameters. */
export function damBreach(input: BreachInput): BreachResult {
  const V = input.volumeM3;
  const hw = input.headM;
  const hb = Math.max(input.breachHeightM, hw);
  const over = input.overtopping;
  const p = Math.min(4, Math.max(1, input.hypsometry ?? DEFAULT_HYPSOMETRY));
  const geo = froehlich2008Geometry({ volumeM3: V, breachHeightM: hb, overtopping: over });
  const z = geo.sideSlope;
  let avg = geo.avgWidthM;
  if (input.maxWidthM && input.maxWidthM > 0) avg = Math.min(avg, input.maxWidthM);
  const bottom = Math.max(1, avg - z * hb);
  const tf = geo.formationTimeS;
  const base = Math.max(0, input.baseFlow ?? 0);
  const method: BreachMethod = input.method && BREACH_METHOD_IDS.includes(input.method) ? input.method : DEFAULT_BREACH_METHOD;
  const c: DamCase = {
    volumeM3: V,
    headM: hw,
    breachHeightM: hb,
    damHeightM: input.damHeightM ?? hb,
    storageM3: input.storageM3 ?? V,
    overtopping: over,
    xzType: input.xzType === undefined ? 'homogeneous' : input.xzType,
    erodibility: 'medium',
    easilyErodible: input.easilyErodible ?? true,
    hypsometry: p,
    maxWidthM: input.maxWidthM ?? null,
  };
  const band = peakBand(c);
  const h =
    method === 'parametric'
      ? weirErosionBreach({
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
        })
      : gammaHydrograph(band[method].peak, V);
  const hydrograph = resample(h.series.t, h.series.q, base);
  let delivered = 0;
  for (let i = 1; i < hydrograph.length; i++) delivered += 0.5 * (hydrograph[i].q + hydrograph[i - 1].q) * (hydrograph[i].t - hydrograph[i - 1].t);
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
    relations: band.values,
    band,
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
  'The breach is not a site-specific breach study: eight published relations (fitted to past failures, mostly earth dams) give eight peaks for this dam, and the low–high band is shown. The central case is the relation that best reproduced 21 documented failures (Froehlich 1995; all within a factor of two, in-sample) — it was low by a third on Teton 1976, so a planner should look at the high case too.',
  'No hydraulic structures: spillways, gates, outlet works and downstream dams and bridges are not modelled; terrain is bare-earth USGS 3DEP with river channels burned to a nominal depth.',
  'The breach outflow enters the map as a discharge just downstream of the dam (the lowest ground near it), not as a reservoir draining through a gap in a wall: the 3DEP surface over the reservoir is the water, not the lake bed.',
  'Screening for emergency planning, not an inundation map for an Emergency Action Plan: those need a licensed engineer’s breach study and model.',
];

/**
 * p = A·h/V at normal pool, with h itself from p (a fixed point; converges in a few steps). A dry dam has no normal
 * pool, so its surface area can only describe the pool it does hold — the maximum one (and likewise when the normal
 * storage is not reported).
 */
export function hypsometryFor(dam: NidDam, hwMax: number): { p: number; fromNid: boolean } {
  const A = dam.surfaceAreaAc ? dam.surfaceAreaAc * ACRE_M2 : null;
  if (!A || !(hwMax > 0)) return { p: DEFAULT_HYPSOMETRY, fromNid: false };
  const Vmax = dam.storageAcFt * ACRE_FT_M3;
  const normal = dam.normalStorageAcFt;
  const Vn = (normal !== null && normal > 0 && normal <= dam.storageAcFt ? normal : dam.storageAcFt) * ACRE_FT_M3;
  let p = DEFAULT_HYPSOMETRY;
  for (let i = 0; i < 30; i++) {
    const hn = hwMax * Math.pow(Vn / Vmax, 1 / p);
    p = Math.min(4, Math.max(1, (A * hn) / Vn));
  }
  return { p, fromNid: true };
}

/** Whether the NID lets a sunny-day failure be built for this dam (not for a dry dam: see DRY DAMS above). */
export function sunnyDayPossible(dam: NidDam): boolean {
  return !isDryDam(dam);
}

/** Why a dry dam has no sunny-day failure (shown in the dam view and in the scenario's assumptions). */
export const DRY_DAM_NOTE = 'A dry dam: the NID gives its normal storage as 0 (a flood-control detention dam, or a tailings or debris basin) — it holds no pool on a sunny day, so there is no sunny-day failure. The flood-induced failure is shown.';

/** Build a breach scenario for an NID dam. A sunny-day request for a dry dam gives the flood-induced failure. */
export function damScenario(dam: NidDam, asked: BreachMode, method: BreachMethod = DEFAULT_BREACH_METHOD): DamScenario {
  const assumptions: string[] = [];
  const mode: BreachMode = asked === 'sunny' && !sunnyDayPossible(dam) ? 'flood' : asked;
  if (mode !== asked) assumptions.push(DRY_DAM_NOTE);
  const m = BREACH_MODES[mode];
  const hwMax = Math.min(dam.heightM, dam.hydraulicHeightM ?? dam.heightM);
  if (dam.hydraulicHeightM === null) assumptions.push(`No hydraulic height in the NID: the reservoir at its maximum is taken to stand at the full NID height (${dam.heightM.toFixed(1)} m).`);
  const hyp = hypsometryFor(dam, hwMax);
  if (!hyp.fromNid) assumptions.push(`No surface area in the NID: reservoir shape exponent ${DEFAULT_HYPSOMETRY} (a typical valley reservoir).`);
  const Vmax = dam.storageAcFt * ACRE_FT_M3;
  let V = Vmax;
  let hw = hwMax;
  if (mode === 'sunny') {
    const normal = dam.normalStorageAcFt !== null && dam.normalStorageAcFt > 0 && dam.normalStorageAcFt <= dam.storageAcFt ? dam.normalStorageAcFt : null;
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
  if (V > FITTED_RANGE.volumeM3 || hw > FITTED_RANGE.headM) {
    assumptions.push(`Larger than any failure the breach relations were fitted to (the largest is Teton 1976: ${FITTED_RANGE.volumeM3 / 1e6} million m³ behind ${FITTED_RANGE.headM} m of head): every number here is an extrapolation, and the relations disagree by an order of magnitude.`);
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
    damHeightM: dam.heightM,
    storageM3: Vmax,
    // Earth: homogeneous or zoned, easily eroded; rockfill: usually cored, erosion resistant (Xu & Zhang's core-wall
    // class, Von Thun & Gillette's resistant time); concrete and masonry: indicative only (flagged above).
    xzType: dam.damType === 'Rockfill' ? 'core-wall' : 'homogeneous',
    easilyErodible: dam.damType === 'Earth',
  });
  return { dam, mode, method, result, headM: Math.max(0.5, hw), volumeM3: V, assumptions, caveats: [...DAM_BREACH_CAVEATS] };
}
