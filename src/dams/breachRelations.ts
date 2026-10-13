/**
 * Published embankment-dam breach relations, side by side, so a dam-breach scenario can show how far they disagree
 * instead of quoting one. Pure: no DOM, no network.
 *
 * Two families (Wahl 1998, USBR DSO-98-004, Tables 1–2; Wahl 2004, J. Hydraul. Eng. 130(5):389, Table 1):
 *
 *   PEAK REGRESSIONS give the peak outflow Q_p directly from the reservoir and the dam.
 *   BREACH-PARAMETER relations give the breach's average width B̄, side slope z and formation time t_f; the peak then
 *   comes from routing the reservoir through that growing breach (the weir ODE of src/hazard/breach.ts, as
 *   src/dams/breachModel.ts does), so the reservoir's shape matters.
 *
 * Symbols, SI throughout (m, m³, m³/s, h where stated):
 *   V_w  volume above the breach invert (released), m³     h_w  depth of water above the breach invert at failure, m
 *   h_b  breach height, m                                  h_d  dam height, m                    S  reservoir storage, m³
 *
 * Every formula and its units was checked against the sources named on it. Wahl 1998 and Wahl 2004 are the U.S.
 * Bureau of Reclamation's compilations (both list the formulas with the metric coefficients used here); Xu & Zhang's
 * coefficients come from Zhong, Shan & Liu 2020 (IntechOpen, doi:10.5772/intechopen.92893, Table 1, which reprints
 * them) and the dimensionless form from Silva-Cancino et al. 2024 (Water Sci. Eng., doi:10.1016/j.wse.2024.05.001,
 * Eq. 10).
 *
 * LEFT OUT, on purpose:
 *   - Walder & O'Connor 1997 (USGS / Water Resour. Res. 33(10):2337): needs a mean vertical erosion rate of the breach
 *     and a large-/small-reservoir classification (Wahl 2004 could apply it to only 22 of 108 cases); the NID gives
 *     neither, and the closed form that circulates for it could not be traced to the paper.
 *   - Envelope equations (USBR 1982 Q_p = 19.1 h_w^1.85, MacDonald & Langridge-Monopolis's envelope, Costa's
 *     envelopes): upper bounds by design, over-predicting by ⅔–¾ of an order of magnitude on average (Wahl 2004). A band
 *     made of them would only be a wider band.
 *   - Xu & Zhang 2009's breach width and time: the reprinted coefficient tables lose minus signs (an erodibility
 *     coefficient that makes LOW-erodibility breaches wider than high ones), so they are not used; their peak relation,
 *     whose reprinted signs are consistent, is — except for concrete-faced rockfill, whose sign is the ambiguous one.
 */
import { weirErosionBreach } from '../hazard/breach';

export const G = 9.81;

/** Xu & Zhang 2009 dam-type classes (concrete-faced rockfill is not used: see above). */
export type XuZhangDamType = 'homogeneous' | 'core-wall';
export type Erodibility = 'high' | 'medium' | 'low';

/** One dam at failure, as the relations need it. */
export interface DamCase {
  /** V_w, m³. */
  volumeM3: number;
  /** h_w, m. */
  headM: number;
  /** h_b, m (≥ h_w is assumed by the breach relations; callers clamp). */
  breachHeightM: number;
  /** h_d, m (Xu & Zhang); defaults to h_b. */
  damHeightM?: number;
  /** S, m³ (Von Thun & Gillette's C_b); defaults to V_w. */
  storageM3?: number;
  overtopping: boolean;
  /** Xu & Zhang class; null = not applicable (their relation is skipped). Default 'homogeneous'. */
  xzType?: XuZhangDamType | null;
  /** Xu & Zhang erodibility; default 'medium' (the NID says nothing about it). */
  erodibility?: Erodibility;
  /** Von Thun & Gillette time: homogeneous earthfill erodes easily (true), cored / rockfill / zoned dams resist (false). */
  easilyErodible?: boolean;
  /** p of the reservoir's storage curve V(s) = V_w (s/h_w)^p, for the breach-parameter relations. Default 2.5. */
  hypsometry?: number;
  /** Cap on the average breach width (the dam's crest length), m. */
  maxWidthM?: number | null;
}

/** A breach: average width, side slope (H:V) and formation time. */
export interface BreachGeometry {
  avgWidthM: number;
  sideSlope: number;
  formationTimeS: number;
}

export interface Relation {
  id: RelationId;
  label: string;
  /** Short citation shown with the number. */
  cite: string;
  kind: 'regression' | 'breach';
  /** Peak outflow, m³/s, or null when the relation does not apply to this dam. */
  peak(c: DamCase): number | null;
  /** Breach-parameter relations only. */
  geometry?(c: DamCase): BreachGeometry;
}

export type RelationId = 'froehlich2008' | 'froehlich1995b' | 'vonThun1990' | 'macdonald1984' | 'froehlich1995' | 'froehlich2016' | 'xuZhang2009' | 'pierce2010';

// ─── Breach-parameter relations ───────────────────────────────────────────────────────────────────────────────────────

/**
 * Froehlich 2008, J. Water Resour. Plann. Manage. 134(3):217, doi:10.1061/(ASCE)0733-9496(2008)134:3(217):
 *   B̄ = 0.27·K₀·V_w^0.32·h_b^0.04,  t_f = 63.2·√(V_w/(g·h_b²)) s,  K₀ = 1.3 overtopping else 1.0,  z = 1.0 / 0.7.
 */
export function froehlich2008Geometry(c: Pick<DamCase, 'volumeM3' | 'breachHeightM' | 'overtopping'>): BreachGeometry {
  const V = c.volumeM3;
  const hb = c.breachHeightM;
  return {
    avgWidthM: 0.27 * (c.overtopping ? 1.3 : 1.0) * Math.pow(V, 0.32) * Math.pow(hb, 0.04),
    sideSlope: c.overtopping ? 1.0 : 0.7,
    formationTimeS: 63.2 * Math.sqrt(V / (G * hb * hb)),
  };
}

/**
 * Froehlich 1995, "Embankment dam breach parameters revisited", Proc. 1st Int. Conf. Water Resources Eng., ASCE,
 * 887–891 (Wahl 1998 Table 2 "Froehlich 1995b"; Wahl 2004 Table 1 "Froehlich 1995a"):
 *   B̄ = 0.1803·K₀·V_w^0.32·h_b^0.19,  t_f = 0.00254·V_w^0.53·h_b^−0.9 h,  K₀ = 1.4 overtopping else 1.0,
 *   z = 1.4 overtopping else 0.9 (Wahl 1998 p. 14).
 */
export function froehlich1995Geometry(c: Pick<DamCase, 'volumeM3' | 'breachHeightM' | 'overtopping'>): BreachGeometry {
  const V = c.volumeM3;
  const hb = c.breachHeightM;
  return {
    avgWidthM: 0.1803 * (c.overtopping ? 1.4 : 1.0) * Math.pow(V, 0.32) * Math.pow(hb, 0.19),
    sideSlope: c.overtopping ? 1.4 : 0.9,
    formationTimeS: 3600 * 0.00254 * Math.pow(V, 0.53) * Math.pow(hb, -0.9),
  };
}

/** Von Thun & Gillette's C_b, m, by reservoir size (Wahl 1998 p. 15: < 1.23·10⁶, –6.17·10⁶, –1.23·10⁷, larger). */
export function vonThunCb(storageM3: number): number {
  if (storageM3 < 1.23e6) return 6.1;
  if (storageM3 < 6.17e6) return 18.3;
  if (storageM3 < 1.23e7) return 42.7;
  return 54.9;
}

/**
 * Von Thun & Gillette 1990, "Guidance on breach parameters" (USBR, unpublished; as given in Wahl 1998 Eqs. 1–3 and
 * Wahl 2004 Table 1):
 *   B̄ = 2.5·h_w + C_b;  t_f = 0.015·h_w h (highly erodible) or 0.020·h_w + 0.25 h (erosion resistant);  z = 1 (1:1).
 */
export function vonThunGeometry(c: Pick<DamCase, 'headM' | 'storageM3' | 'volumeM3' | 'easilyErodible'>): BreachGeometry {
  const hw = c.headM;
  const tfH = c.easilyErodible === false ? 0.02 * hw + 0.25 : 0.015 * hw;
  return { avgWidthM: 2.5 * hw + vonThunCb(c.storageM3 ?? c.volumeM3), sideSlope: 1.0, formationTimeS: 3600 * tfH };
}

/**
 * The peak from routing the reservoir through a breach growing linearly from the crest to its full size over t_f
 * (the weir ODE, src/hazard/breach.ts weirErosionBreach), as src/dams/breachModel.ts does for the map.
 */
export function routedPeak(c: DamCase, g: BreachGeometry): { peak: number; tPeak: number } {
  const hw = c.headM;
  const hb = Math.max(c.breachHeightM, hw);
  let avg = g.avgWidthM;
  if (c.maxWidthM && c.maxWidthM > 0) avg = Math.min(avg, c.maxWidthM);
  const bottom = Math.max(1, avg - g.sideSlope * hb);
  const tf = Math.max(60, g.formationTimeS);
  const h = weirErosionBreach({
    volume: c.volumeM3,
    depth: hw,
    erosionRate: (3600 * hw) / tf,
    widthRatio: bottom / hw,
    sideSlope: g.sideSlope,
    hypsometry: Math.min(4, Math.max(1, c.hypsometry ?? 2.5)),
    startHead: Math.min(0.5, 0.1 * hw),
    minWidth: 1,
    dt: Math.max(1, Math.min(10, tf / 600)),
    tMax: 48 * 3600,
  });
  return { peak: h.peak, tPeak: h.tPeak };
}

// ─── Peak regressions ─────────────────────────────────────────────────────────────────────────────────────────────────

/** MacDonald & Langridge-Monopolis 1984, J. Hydraul. Eng. 110(5):567 (earthfill, best fit): Q_p = 1.154·(V_w·h_w)^0.412. */
export function macDonald1984Peak(volumeM3: number, headM: number): number {
  return 1.154 * Math.pow(volumeM3 * headM, 0.412);
}

/** Froehlich 1995, "Peak outflow from breached embankment dam", J. Water Resour. Plann. Manage. 121(1):90: Q_p = 0.607·V_w^0.295·h_w^1.24. */
export function froehlich1995Peak(volumeM3: number, headM: number): number {
  return 0.607 * Math.pow(volumeM3, 0.295) * Math.pow(headM, 1.24);
}

/**
 * Froehlich 2016, "Predicting peak discharge from gradually breached embankment dam", J. Hydrol. Eng. 21(11):04016041,
 * doi:10.1061/(ASCE)HE.1943-5584.0001424 (41 measured failures):
 *   Q_p = 0.0175·k_M·k_H·√(g·V_w·h_w·h_b²/B̄),  k_M = 1.85 overtopping else 1,  k_H = (h_b/6.1)^⅛ above 6.1 m, else 1.
 * B̄ is the average breach width (here Froehlich 2008's).
 */
export function froehlich2016Peak(volumeM3: number, headM: number, breachHeightM: number, avgWidthM: number, overtopping: boolean): number {
  const kM = overtopping ? 1.85 : 1;
  const kH = breachHeightM > 6.1 ? Math.pow(breachHeightM / 6.1, 1 / 8) : 1;
  return 0.0175 * kM * kH * Math.sqrt((G * volumeM3 * headM * breachHeightM * breachHeightM) / Math.max(1, avgWidthM));
}

const XZ_HR = 15;
const XZ_TYPE: Record<XuZhangDamType, number> = { 'core-wall': -0.503, homogeneous: -0.649 };
const XZ_MODE = { overtopping: -0.705, seepage: -1.039 };
const XZ_ERODE: Record<Erodibility, number> = { high: -0.007, medium: -0.375, low: -1.362 };

/**
 * Xu & Zhang 2009, "Breaching parameters for earth and rockfill dams", J. Geotech. Geoenviron. Eng. 135(12):1957,
 * doi:10.1061/(ASCE)GT.1943-5606.0000162 (182 failures):
 *   Q_p / √(g·V_w^(5/3)) = 0.175·(h_d/h_r)^0.199·(V_w^(1/3)/h_w)^−1.274·e^(B₄),  h_r = 15 m,
 *   B₄ = b₃ + b₄ + b₅: dam type (core wall −0.503, homogeneous / zoned −0.649), failure mode (overtopping −0.705,
 *   seepage / piping −1.039), erodibility (high −0.007, medium −0.375, low −1.362).
 */
export function xuZhang2009Peak(c: Pick<DamCase, 'volumeM3' | 'headM' | 'breachHeightM' | 'damHeightM' | 'overtopping' | 'xzType' | 'erodibility'>): number | null {
  const type = c.xzType === undefined ? 'homogeneous' : c.xzType;
  if (type === null) return null;
  const V = c.volumeM3;
  const hd = c.damHeightM ?? c.breachHeightM;
  const B4 = XZ_TYPE[type] + (c.overtopping ? XZ_MODE.overtopping : XZ_MODE.seepage) + XZ_ERODE[c.erodibility ?? 'medium'];
  return Math.sqrt(G * Math.pow(V, 5 / 3)) * 0.175 * Math.pow(hd / XZ_HR, 0.199) * Math.pow(Math.cbrt(V) / c.headM, -1.274) * Math.exp(B4);
}

/**
 * Pierce, Thornton & Abt 2010, "Predicting peak outflow from breached embankment dams", J. Hydrol. Eng. 15(5):338,
 * doi:10.1061/(ASCE)HE.1943-5584.0000197 (87 failures): Q_p = 0.0176·(V·H)^0.606, V the volume and H the height of the
 * water behind the dam (V_w, h_w).
 */
export function pierce2010Peak(volumeM3: number, headM: number): number {
  return 0.0176 * Math.pow(volumeM3 * headM, 0.606);
}

// ─── The set ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export const RELATIONS: readonly Relation[] = [
  {
    id: 'froehlich2008',
    label: 'Froehlich 2008 breach, routed',
    cite: 'Froehlich 2008, J. Water Resour. Plann. Manage. 134(3):217',
    kind: 'breach',
    geometry: froehlich2008Geometry,
    peak: (c) => routedPeak(c, froehlich2008Geometry(c)).peak,
  },
  {
    id: 'froehlich1995b',
    label: 'Froehlich 1995 breach, routed',
    cite: 'Froehlich 1995, Proc. 1st Int. Conf. Water Resour. Eng., ASCE, 887',
    kind: 'breach',
    geometry: froehlich1995Geometry,
    peak: (c) => routedPeak(c, froehlich1995Geometry(c)).peak,
  },
  {
    id: 'vonThun1990',
    label: 'Von Thun & Gillette 1990 breach, routed',
    cite: 'Von Thun & Gillette 1990, USBR guidance (Wahl 1998 Eqs. 1–3)',
    kind: 'breach',
    geometry: vonThunGeometry,
    peak: (c) => routedPeak(c, vonThunGeometry(c)).peak,
  },
  {
    id: 'macdonald1984',
    label: 'MacDonald & Langridge-Monopolis 1984',
    cite: 'MacDonald & Langridge-Monopolis 1984, J. Hydraul. Eng. 110(5):567',
    kind: 'regression',
    peak: (c) => macDonald1984Peak(c.volumeM3, c.headM),
  },
  {
    id: 'froehlich1995',
    label: 'Froehlich 1995 peak',
    cite: 'Froehlich 1995, J. Water Resour. Plann. Manage. 121(1):90',
    kind: 'regression',
    peak: (c) => froehlich1995Peak(c.volumeM3, c.headM),
  },
  {
    id: 'froehlich2016',
    label: 'Froehlich 2016 peak',
    cite: 'Froehlich 2016, J. Hydrol. Eng. 21(11):04016041',
    kind: 'regression',
    peak: (c) => {
      const hb = Math.max(c.breachHeightM, c.headM);
      let w = froehlich2008Geometry({ ...c, breachHeightM: hb }).avgWidthM;
      if (c.maxWidthM && c.maxWidthM > 0) w = Math.min(w, c.maxWidthM);
      return froehlich2016Peak(c.volumeM3, c.headM, hb, w, c.overtopping);
    },
  },
  {
    id: 'xuZhang2009',
    label: 'Xu & Zhang 2009 peak',
    cite: 'Xu & Zhang 2009, J. Geotech. Geoenviron. Eng. 135(12):1957',
    kind: 'regression',
    peak: (c) => xuZhang2009Peak(c),
  },
  {
    id: 'pierce2010',
    label: 'Pierce et al. 2010 peak',
    cite: 'Pierce, Thornton & Abt 2010, J. Hydrol. Eng. 15(5):338',
    kind: 'regression',
    peak: (c) => pierce2010Peak(c.volumeM3, c.headM),
  },
];

export function relationById(id: RelationId): Relation {
  return RELATIONS.find((r) => r.id === id)!;
}

/**
 * The relation the band is centred on, chosen on evidence: the smallest root-mean-square log error against the
 * historical failures in src/dams/historicalFailures.ts (tests/dams/breachRelations.test.ts keeps it so). Not chosen to
 * match Teton.
 */
export const CENTRAL_RELATION: RelationId = 'froehlich1995';

export interface PeakBand {
  /** Every applicable relation's peak, m³/s, in RELATIONS order. */
  values: Array<{ id: RelationId; label: string; cite: string; kind: Relation['kind']; peak: number }>;
  low: { id: RelationId; peak: number };
  central: { id: RelationId; peak: number };
  high: { id: RelationId; peak: number };
}

/** Low / central / high across the relations for one dam: low and high are the extreme relations, central is CENTRAL_RELATION's. */
export function peakBand(c: DamCase): PeakBand {
  const values: PeakBand['values'] = [];
  for (const r of RELATIONS) {
    const q = r.peak(c);
    if (q !== null && Number.isFinite(q) && q > 0) values.push({ id: r.id, label: r.label, cite: r.cite, kind: r.kind, peak: q });
  }
  let lo = values[0];
  let hi = values[0];
  for (const v of values) {
    if (v.peak < lo.peak) lo = v;
    if (v.peak > hi.peak) hi = v;
  }
  const mid = values.find((v) => v.id === CENTRAL_RELATION) ?? lo;
  return { values, low: { id: lo.id, peak: lo.peak }, central: { id: mid.id, peak: mid.peak }, high: { id: hi.id, peak: hi.peak } };
}

/**
 * Wave-front arrival for a different peak, from an arrival time read off the map for the run's own peak: a kinematic
 * flood wave in a wide channel travels at c = (5/3)·v with Manning's v ∝ q^(2/5), so travel time scales as Q^(−2/5).
 * Indicative only: it ignores the rising limb's shape, the valley's width changing with stage, and attenuation.
 */
export const ARRIVAL_EXPONENT = 0.4;
export function scaledArrival(arrivalS: number, runPeak: number, otherPeak: number): number {
  if (!(runPeak > 0) || !(otherPeak > 0)) return arrivalS;
  return arrivalS * Math.pow(runPeak / otherPeak, ARRIVAL_EXPONENT);
}
