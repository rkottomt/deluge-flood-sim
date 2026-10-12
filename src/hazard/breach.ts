/**
 * Breach / outburst hydrographs Q(t) (research spec §B).
 *
 * Three ways to get a hydrograph out of a lake, in order of preference:
 *   1. `weirErosionBreach` (§B.3, the default): a physically framed ODE — weir flow through a breach that cuts down at a
 *      constant rate k. It reproduces both of Walder & O'Connor's (1997) regimes without their asymptote constants:
 *      a large lake with fast erosion peaks when the breach reaches full depth (peak set by geometry), a small lake
 *      with slow erosion empties while the breach is still cutting (peak set by k).
 *   2. `gammaHydrograph` (§B.4): a smooth single-peaked curve with an EXACT volume, for when a reconstruction gives
 *      only Qp and V.
 *   3. `PEAK_RELATIONS` (§B.1): the published regressions of Qp on V (and H). They spread ×9 for one lake (Thame
 *      182–1,648 m³/s, observed 912) — useful as a band and as a cross-check, not as an answer.
 */
import type { BreachParams } from './types';
import {
  BREACH_DT,
  BREACH_MIN_WIDTH,
  BREACH_SIDE_SLOPE,
  BREACH_START_HEAD,
  BREACH_T_MAX,
  BREACH_V_END,
  BREACH_WIDTH_RATIO,
  EROSION_RATE,
  GAMMA_SHAPE,
  LAKE_HYPSOMETRY,
  WEIR_C_RECT,
  WEIR_C_SIDE,
} from './defaults';
import { Series } from './series';

// ────────────────────────────────────────────────────────────────────────────────────────────
// §B.1 Empirical peak-discharge relations
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface PeakRelation {
  id: string;
  label: string;
  cite: string;
  /** What the lake/dam type the relation was fitted on. */
  basis: string;
  /** V: verified to the m³/s against Khadka et al. 2026 Table S2 (Thame lower lake); V/S/M as in the spec. */
  tag: 'V' | 'S' | 'M';
  /** Whether the relation uses the head / breach depth (otherwise only V). */
  usesHead: boolean;
  /** Peak discharge, m³/s, from released volume V (m³) and head / breach depth H (m). Units converted here. */
  qp(V: number, H: number): number;
}

const MM3 = 1e6;

/**
 * Spec Table B.1. Every relation takes SI (V in m³) — those published in Mm³ convert inside. Reproduced numbers for
 * Thame lower lake (V = 3.6×10⁵ m³, Bd = 12 m), Khadka et al. 2026 Table S2: Evans 634, Popov 457, Costa 1,648,
 * Costa (VH) 601, Froehlich 1995 576, Froehlich 2025 648, Costa & Schuster 396 (tests/hazard/breach.test.ts).
 */
export const PEAK_RELATIONS: Readonly<Record<string, PeakRelation>> = {
  evans1986: {
    id: 'evans1986',
    label: 'Evans 1986',
    cite: 'Evans 1986, Can. Geotech. J. 23:385',
    basis: 'moraine / landslide dams',
    tag: 'V',
    usesHead: false,
    qp: (V) => 0.72 * Math.pow(V, 0.53),
  },
  popov1991: {
    id: 'popov1991',
    label: 'Popov 1991',
    cite: 'Popov 1991 (N. Tien Shan moraine lakes)',
    basis: 'moraine-dammed lakes',
    tag: 'V',
    usesHead: false,
    qp: (V) => 0.0048 * Math.pow(V, 0.896),
  },
  costa1985: {
    id: 'costa1985',
    label: 'Costa 1985 (V)',
    cite: 'Costa 1985, USGS OFR 85-560',
    basis: 'natural dams',
    tag: 'V',
    usesHead: false,
    qp: (V) => 1.122 * Math.pow(V, 0.57),
  },
  costa1985VH: {
    id: 'costa1985VH',
    label: 'Costa 1985 (V·H)',
    cite: 'Costa 1985, USGS OFR 85-560',
    basis: 'constructed dams',
    tag: 'V',
    usesHead: true,
    qp: (V, H) => 0.981 * Math.pow(V * H, 0.42),
  },
  froehlich1995: {
    id: 'froehlich1995',
    label: 'Froehlich 1995',
    cite: 'Froehlich 1995, J. Water Resour. Plann. Manage. 121:90',
    basis: 'embankment dams',
    tag: 'V',
    usesHead: true,
    qp: (V, H) => 0.607 * Math.pow(V, 0.295) * Math.pow(H, 1.24),
  },
  froehlich2025: {
    id: 'froehlich2025',
    label: 'Froehlich 2025 (moraine-dammed glacial lakes)',
    cite: 'Froehlich 2025, Nat. Hazards Rev. 26:04025047, doi:10.1061/NHREFO.NHENG-2492',
    basis: 'moraine-dammed glacial lakes',
    tag: 'V',
    usesHead: true,
    qp: (V, H) => 142 * Math.pow(H, 0.766) * Math.pow(V / MM3, 0.378),
  },
  costaSchuster1988: {
    id: 'costaSchuster1988',
    label: 'Costa & Schuster 1988 (attribution uncertain)',
    cite: 'as listed in Khadka et al. 2026 Table S2 — likely Costa & Schuster 1988, GSA Bull. 100:1054',
    basis: 'natural dams',
    tag: 'S',
    usesHead: true,
    // Value reproduced (396 m³/s for Thame), attribution not: the table's column alignment is ambiguous.
    qp: (V, H) => 136 * Math.pow((H * V) / MM3, 0.73),
  },
  rickenmannGlacial: {
    id: 'rickenmannGlacial',
    label: 'Rickenmann 1999 — glacial dam failures',
    cite: 'Rickenmann 1999, Nat. Hazards 19:47, Table II',
    basis: 'glacial dam failures (compilation)',
    tag: 'V',
    usesHead: false,
    qp: (V) => 0.0163 * Math.pow(V, 0.64),
  },
  rickenmannLandslide: {
    id: 'rickenmannLandslide',
    label: 'Rickenmann 1999 — landslide dam failures',
    cite: 'Rickenmann 1999, Table II',
    basis: 'landslide dam failures',
    tag: 'V',
    usesHead: false,
    qp: (V) => 0.293 * Math.pow(V, 0.56),
  },
  clagueMathews1973: {
    id: 'clagueMathews1973',
    label: 'Clague & Mathews 1973 (jökulhlaup)',
    cite: 'Clague & Mathews 1973, J. Glaciol. 12:501',
    basis: 'ice-dammed lakes, tunnel drainage',
    tag: 'M',
    usesHead: false,
    qp: (V) => 75 * Math.pow(V / MM3, 0.67),
  },
  walderCosta1996: {
    id: 'walderCosta1996',
    label: 'Walder & Costa 1996 (ice-dammed, tunnel drainage)',
    cite: 'Walder & Costa 1996',
    basis: 'ice-dammed lakes, tunnel drainage',
    tag: 'M',
    usesHead: false,
    qp: (V) => 46 * Math.pow(V / MM3, 0.66),
  },
  huggel2002: {
    id: 'huggel2002',
    label: 'Huggel et al. 2002 worst case (2V/1000 s)',
    cite: 'Huggel et al. 2002 after Haeberli 1983',
    basis: 'moraine lakes, worst case',
    tag: 'M',
    usesHead: false,
    qp: (V) => (2 * V) / 1000,
  },
};

/** Breach formation time, s: Froehlich 1995b (published in hours, V m³). Thame lower: 0.239 h = 860 s. [V*] */
export function breachTimeFroehlich1995(V: number, Bd: number): number {
  return 3600 * 0.00254 * Math.pow(V, 0.53) * Math.pow(Bd, -0.9);
}
/** Breach formation time, s: Froehlich 2025 (V in Mm³). Thame lower: 1,112 s. [V*] */
export function breachTimeFroehlich2025(V: number, Bd: number): number {
  return (Math.pow(V / MM3, 0.622) / (71 * Math.pow(Bd, 0.766))) * 1e6;
}

/** Every relation's peak for one lake, with the geometric-mean and the min–max spread — the band to put on screen. */
export function peakBand(V: number, H: number): { values: Record<string, number>; min: number; max: number; geomean: number } {
  const values: Record<string, number> = {};
  let lo = Infinity;
  let hi = -Infinity;
  let logSum = 0;
  let n = 0;
  for (const r of Object.values(PEAK_RELATIONS)) {
    const q = r.qp(V, H);
    values[r.id] = q;
    lo = Math.min(lo, q);
    hi = Math.max(hi, q);
    logSum += Math.log(q);
    n++;
  }
  return { values, min: lo, max: hi, geomean: Math.exp(logSum / n) };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// §B.3 Weir flow + linear down-cutting
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface WeirBreachInput {
  /** Volume that can drain above the final breach base, m³ (src/hazard/volume.ts drainableVolume). */
  volume: number;
  /** d: final breach depth below the initial lake level, m. */
  depth: number;
  /** k, m/h (default 30). 0 = no erosion: overtopping only (bedrock dams). */
  erosionRate?: number;
  /** r = bottom width / breach depth (default 2). */
  widthRatio?: number;
  /** Side slope m (H:V) (default 1). */
  sideSlope?: number;
  /** p in V(s) = V₀ (s/d)^p (default 1.5). */
  hypsometry?: number;
  /** Head over the breach bottom at t = 0, m (default 0.5: the overtopping that starts the run). A displacement wave
   * that has already scoured the crest starts deeper (spec §C.2: z_b0 = d − (H − f)). */
  startHead?: number;
  /** Minimum bottom width, m (default 1). */
  minWidth?: number;
  /** Inflow to the lake, m³/s (e.g. river baseflow into an avalanche-dammed lake). Default 0. */
  inflow?: number;
  /** Step, s (default 1) and stop time, s (default 12 h). */
  dt?: number;
  tMax?: number;
}

export interface Hydrograph {
  /** The outflow Q(t), m³/s, t in s since the breach run started; starts and ends at 0. */
  series: Series;
  /** Volume released, m³ — exactly the series' integral. */
  volume: number;
  peak: number;
  tPeak: number;
  /** Fraction of the drainable volume that drained (1 − V_end/V₀). */
  drained?: number;
}

/**
 * Weir-flow + linear down-cutting breach ODE (spec §B.3), integrated with the explicit midpoint rule (RK2) at dt = 1 s
 * exactly as the spec's reproduction (scratchpad breach.mjs) does, so the spec's table B.3 is reproducible to the m³/s.
 *
 *   s = d·(V/V₀)^(1/p)                       lake level above the final breach base
 *   z_b(t) = max(0, z_b0 − k·t)               breach bottom, z_b0 = d − startHead
 *   b(t) = max(b₀, r·(d − z_b))               bottom width grows with breach depth
 *   H = max(0, s − z_b)
 *   Q = 1.7·b·H^1.5 + 1.35·m·H^2.5            broad-crested trapezoidal weir (SI; Fread's BREACH coefficients) [M]
 *   dV/dt = Q_in − Q
 *
 * Each step's midpoint Q is the step's mean outflow; the returned series puts that value at the step's middle, and the
 * series is then rescaled by the (≈ 1 ± 1e-4) ratio of the exact drained volume to its own trapezoid integral, so the
 * volume delivered downstream is exactly what left the lake.
 */
export function weirErosionBreach(input: WeirBreachInput): Hydrograph {
  const V0 = input.volume;
  const d = input.depth;
  if (!(V0 > 0) || !(d > 0)) return emptyHydrograph();
  const p = input.hypsometry ?? LAKE_HYPSOMETRY;
  const k = Math.max(0, input.erosionRate ?? EROSION_RATE) / 3600;
  const r = input.widthRatio ?? BREACH_WIDTH_RATIO;
  const m = input.sideSlope ?? BREACH_SIDE_SLOPE;
  const b0 = input.minWidth ?? BREACH_MIN_WIDTH;
  const zb0 = Math.max(0, d - Math.min(d, input.startHead ?? BREACH_START_HEAD));
  const qIn = Math.max(0, input.inflow ?? 0);
  const dt = input.dt ?? BREACH_DT;
  const tMax = input.tMax ?? BREACH_T_MAX;

  const sof = (V: number) => d * Math.pow(Math.max(V, 0) / V0, 1 / p);
  const Q = (s: number, t: number) => {
    const zb = Math.max(0, zb0 - k * t);
    const b = Math.max(b0, r * (d - zb));
    const H = Math.max(0, s - zb);
    return WEIR_C_RECT * b * Math.pow(H, 1.5) + WEIR_C_SIDE * m * Math.pow(H, 2.5);
  };

  const ts: number[] = [0];
  const qs: number[] = [0];
  let V = V0;
  let s = d;
  let t = 0;
  let out = 0;
  // With an inflow the lake may never empty; it stops at tMax (or when the outflow has settled to the inflow).
  while (t < tMax && V > BREACH_V_END * V0) {
    const q1 = Q(s, t);
    const V1 = V + (qIn - q1) * (dt / 2);
    const q2 = Math.min(Q(sof(V1), t + dt / 2), V / dt + qIn); // never draws more than the lake holds
    V += (qIn - q2) * dt;
    s = sof(V);
    out += q2 * dt;
    ts.push(t + dt / 2);
    qs.push(q2);
    t += dt;
    if (qIn > 0 && k * t > zb0 && Math.abs(q2 - qIn) < 1e-3 * qIn) break;
  }
  ts.push(t + dt / 2);
  qs.push(0);
  return finish(ts, qs, out, 1 - V / V0);
}

function emptyHydrograph(): Hydrograph {
  return { series: new Series([0, 1], [0, 0]), volume: 0, peak: 0, tPeak: 0, drained: 0 };
}

/** Rescale sampled points to an exact volume and summarise. */
function finish(ts: number[], qs: number[], volume: number, drained?: number): Hydrograph {
  let trap = 0;
  for (let i = 1; i < ts.length; i++) trap += 0.5 * (qs[i] + qs[i - 1]) * (ts[i] - ts[i - 1]);
  const f = trap > 0 ? volume / trap : 0;
  let peak = 0;
  let tPeak = 0;
  for (let i = 0; i < qs.length; i++) {
    qs[i] *= f;
    if (qs[i] > peak) {
      peak = qs[i];
      tPeak = ts[i];
    }
  }
  return { series: new Series(ts, qs), volume, peak, tPeak, drained };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// §B.4 Gamma-shaped parametric hydrograph
// ────────────────────────────────────────────────────────────────────────────────────────────

/** ln Γ(x), x > 0 (Lanczos, g = 7, n = 9; ~15 digits). */
export function lnGamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lnGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** ∫Q dt / (Qp·tp) of the gamma shape: e^a·Γ(a+1)/a^(a+1) (a = 3: 1.488, a = 2: 1.847, a = 4: 1.280). */
export function gammaVolumeFactor(a: number): number {
  return Math.exp(a + lnGamma(a + 1) - (a + 1) * Math.log(a));
}

/**
 * Q(t) = Qp·(t/tp)^a·exp(a·(1 − t/tp)) with tp chosen so the volume is exactly V (spec §B.4): tp = V/(c(a)·Qp).
 * Sampled every `dt` seconds (default tp/60) until Q < 10⁻⁴·Qp, then rescaled so the trapezoid integral of the
 * samples — what the 2-D forcing integrates — is V to rounding.
 */
export function gammaHydrograph(qPeak: number, volume: number, opts: { shape?: number; dt?: number } = {}): Hydrograph {
  if (!(qPeak > 0) || !(volume > 0)) return emptyHydrograph();
  const a = opts.shape ?? GAMMA_SHAPE;
  const tp = volume / (gammaVolumeFactor(a) * qPeak);
  const dt = opts.dt ?? tp / 60;
  const ts: number[] = [];
  const qs: number[] = [];
  for (let i = 0; ; i++) {
    const t = i * dt;
    const x = t / tp;
    const q = i === 0 ? 0 : qPeak * Math.pow(x, a) * Math.exp(a * (1 - x));
    ts.push(t);
    qs.push(q);
    if (x > 1 && q < 1e-4 * qPeak) break;
  }
  qs[qs.length - 1] = 0;
  const h = finish(ts, qs, volume);
  // The rescale moves the sampled peak by < 0.1 %; the peak time is the analytic one.
  return { ...h, tPeak: tp };
}

/**
 * Hydrograph of a lake breach per BreachParams: the weir-erosion ODE by default, or a gamma curve whose peak comes from
 * the named empirical relation (model 'gamma' / 'empirical'; default relation Froehlich 2025, the only one fitted to
 * moraine-dammed glacial lakes). `volume` is the drainable volume, m³.
 */
export function breachHydrograph(volume: number, b: BreachParams, extra: Partial<WeirBreachInput> = {}): Hydrograph {
  if (b.model === 'weirErosion') {
    return weirErosionBreach({
      volume,
      depth: b.finalDepth,
      erosionRate: b.erosionRate,
      widthRatio: b.widthRatio,
      sideSlope: b.sideSlope,
      hypsometry: b.hypsometry,
      ...extra,
    });
  }
  const rel = PEAK_RELATIONS[b.empiricalEq ?? 'froehlich2025'] ?? PEAK_RELATIONS.froehlich2025;
  return gammaHydrograph(rel.qp(volume, b.finalDepth), volume);
}
