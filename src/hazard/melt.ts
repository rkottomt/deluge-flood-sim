/**
 * Glacier melt under a heatwave or a warmer climate (research spec §F): a degree-day model giving the EXTRA runoff over
 * climatology, in m³/s.
 *
 * Be honest about what this is: melt is a SLOW forcing — tens of m³/s sustained over days (100 km² of glacier at
 * +3 °C gives ~24 m³/s) — never a flash flood. In the chain it does two things only: it raises the BASEFLOW the routed
 * flood rides on (and the river at the domain edge before the surge), and it FILLS LAKES, eating freeboard until an
 * overtopping or a displacement wave is more likely. It must not be presented as the cause of an outburst — it
 * modifies probability and the baseline (Thame 2024 followed the warmest 17 Jul–15 Aug on record [V, Khadka 2026]).
 */
import {
  DDF_ICE_HIGH,
  DDF_ICE_LOW,
  DDF_SNOW_HIGH,
  DDF_SNOW_LOW,
  DDF_SPLIT_ELEVATION,
  DEBRIS_MELT_FACTOR,
  LAPSE_ANNUAL,
} from './defaults';

export type MeltSurface = 'snow' | 'ice' | 'debris';

/** Degree-day factor, mm w.e. °C⁻¹ d⁻¹, for a surface at an elevation (Parajuli et al. 2015, Lirung Glacier [V]). */
export function degreeDayFactor(surface: MeltSurface, elevation: number): number {
  const high = elevation >= DDF_SPLIT_ELEVATION;
  if (surface === 'snow') return high ? DDF_SNOW_HIGH : DDF_SNOW_LOW;
  const ice = high ? DDF_ICE_HIGH : DDF_ICE_LOW;
  return surface === 'debris' ? ice * DEBRIS_MELT_FACTOR : ice;
}

/** An elevation band of glacier: area (m²), mean elevation (m), surface class. */
export interface MeltBand {
  area: number;
  elevation: number;
  surface: MeltSurface;
}

export interface MeltAnomaly {
  /** Extra runoff over climatology, m³/s (the "baseflow / lake-filling" term — NOT a flood wave). */
  extraQ: number;
  /** Extra water over the anomaly's duration, m³. */
  volume: number;
  /** Area-weighted extra melt rate, mm w.e./day. */
  meltRate: number;
  /** Always 'baseflow': what kind of forcing this is, for the UI's label. */
  kind: 'baseflow';
}

/**
 * Extra runoff from a temperature anomaly ΔT over glacier bands (spec §F.1):
 *   T(z) = T_ref + Γ·(z − z_ref) + ΔT        M_k = DDF_k·max(0, T(z_k))
 *   ΔQ = Σ_k (M_k − M_k,clim)·A_k / (1000·86,400)
 * With no reference temperature, every band is assumed to be melting already (T > 0 through the melt season), so the
 * anomaly melt is simply DDF·ΔT — an upper estimate for bands near the snowline. With `tRef` at `zRef`, bands below
 * freezing in the climatology only melt for the part of ΔT that lifts them above 0 °C.
 */
export function meltAnomaly(
  bands: readonly MeltBand[],
  deltaT: number,
  days: number,
  opts: { tRef?: number; zRef?: number; lapse?: number } = {},
): MeltAnomaly {
  const lapse = (opts.lapse ?? LAPSE_ANNUAL) / 1000; // °C per m
  let q = 0;
  let area = 0;
  for (const b of bands) {
    if (!(b.area > 0)) continue;
    const ddf = degreeDayFactor(b.surface, b.elevation);
    let dM: number;
    if (opts.tRef === undefined) dM = ddf * Math.max(0, deltaT);
    else {
      const T = opts.tRef + lapse * (b.elevation - (opts.zRef ?? b.elevation));
      dM = ddf * (Math.max(0, T + deltaT) - Math.max(0, T));
    }
    q += (dM * b.area) / (1000 * 86400);
    area += b.area;
  }
  return { extraQ: q, volume: q * days * 86400, meltRate: area > 0 ? (q * 1000 * 86400) / area : 0, kind: 'baseflow' };
}

/**
 * The trigger record's form (HazardTrigger 'meltAnomaly'): one band at the glacier's mean elevation, split into clean and
 * debris-covered ice by `debrisFraction`.
 */
export function meltFromTrigger(t: { glacierArea: number; meanElevation: number; debrisFraction: number; deltaT: number; days: number }): MeltAnomaly {
  const f = Math.min(1, Math.max(0, t.debrisFraction));
  return meltAnomaly(
    [
      { area: t.glacierArea * (1 - f), elevation: t.meanElevation, surface: 'ice' },
      { area: t.glacierArea * f, elevation: t.meanElevation, surface: 'debris' },
    ],
    t.deltaT,
    t.days,
  );
}

/**
 * Days for extra inflow to a lake to raise its level by `freeboard` m (lake area m², the fraction of the extra melt
 * that reaches the lake): the "lake filling → trigger" pathway of spec §F.2. Infinity when nothing reaches it.
 */
export function daysToFill(freeboard: number, lakeArea: number, extraQ: number, fractionToLake = 1): number {
  const inflow = extraQ * fractionToLake;
  return inflow > 0 ? (freeboard * lakeArea) / inflow / 86400 : Infinity;
}
