/**
 * External forcing: storm cells and point sources (inflow / stage), shared by the GPU solver and the CPU
 * reference so both evaluate exactly the same footprints.
 *
 * Layout packed into the `Forcing` uniform (see shaders/common.ts):
 *   src[2k]   = (gx, gy, R, kind)       kind 0 = inflow, 1 = stage
 *   src[2k+1] = (value, 0, 0, 0)        inflow: m/s of depth per unit weight  (= Q / (Σw · cellArea))
 *                                       stage : target water-surface elevation relative to the datum z0
 *   storm[k]  = (gx, gy, R, rate m/s)
 */
import type { HydrographPoint, StormCell, WaterSource } from '../contracts';
import { MAX_SOURCES, MAX_STORMS, MIN_FOOTPRINT_RADIUS, MMHR_TO_MS } from './constants';

export const FORCING_FLOATS = (2 * MAX_SOURCES + MAX_STORMS) * 4;

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Effective footprint radius in cells. */
export function footprintRadius(radius: number): number {
  return Math.max(Number.isFinite(radius) ? radius : 0, MIN_FOOTPRINT_RADIUS);
}

/**
 * Source footprint weight at distance d (cells) from the source center: a flat-topped disc of radius R
 * with a one-cell smooth rim. With R ≥ 0.75 at least one cell center always gets weight > 0.
 */
export function footprintWeight(d: number, R: number): number {
  return 1 - smoothstep(R - 0.5, R + 0.5, d);
}

/** Storm rain profile: full intensity inside 0.3·R, smooth falloff to zero at R. */
export function stormWeight(d: number, R: number): number {
  return 1 - smoothstep(0.3 * R, R, d);
}

/** The simulated-time window a packed forcing will be used over: [from, to] seconds (to = from while paused). */
export interface ForcingWindow {
  from: number;
  to: number;
}

/**
 * Fraction of its discharge a timed inflow (WaterSource.stopAfter) delivers over the window [from, to].
 *
 * A hard on/off switch would round the delivered volume to whole frames — at 256 substeps a frame the Nepal surge
 * would over- or under-deliver by up to a minute of discharge. Instead the frame that STRADDLES the stop gets the
 * fraction of itself that lies before it, so the total delivered is exactly Q·stopAfter however the run is chunked.
 * No stopAfter (or a non-finite one) means the inflow never stops, which is every other preset.
 */
export function inflowFactor(stopAfter: number | undefined, from: number, to: number): number {
  if (stopAfter === undefined || !Number.isFinite(stopAfter)) return 1;
  const stop = Math.max(0, stopAfter);
  if (!(to > from)) return from < stop ? 1 : 0;
  return Math.min(1, Math.max(0, (stop - from) / (to - from)));
}

/** A timed or hydrograph inflow, as far as its delivery over time goes (a subset of the inflow WaterSource). */
export interface InflowTiming {
  discharge: number;
  stopAfter?: number;
  hydrograph?: readonly HydrographPoint[];
}

/**
 * The usable points of a hydrograph, sorted by time: non-finite points are dropped and negative discharges clamped
 * to 0. Null when fewer than one point survives (the source then falls back to its constant `discharge`).
 */
export function cleanHydrograph(points: readonly HydrographPoint[] | undefined): HydrographPoint[] | null {
  if (!points || points.length === 0) return null;
  const out: HydrographPoint[] = [];
  for (const p of points) {
    if (!p || !Number.isFinite(p.t) || !Number.isFinite(p.q)) continue;
    out.push({ t: p.t, q: Math.max(0, p.q) });
  }
  if (out.length === 0) return null;
  out.sort((a, b) => a.t - b.t);
  return out;
}

/** Discharge of a cleaned hydrograph at time t: linear between points, held flat before the first and after the last. */
export function hydrographAt(h: readonly HydrographPoint[], t: number): number {
  const n = h.length;
  if (t <= h[0].t) return h[0].q;
  if (t >= h[n - 1].t) return h[n - 1].q;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (h[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = h[lo];
  const b = h[hi];
  const span = b.t - a.t;
  return span > 0 ? a.q + ((b.q - a.q) * (t - a.t)) / span : b.q;
}

/**
 * ∫ Q dt over [a, b] (a ≤ b) of a cleaned hydrograph, m³ — exact for the piecewise-linear curve: each piece is a
 * trapezoid, the flat tails are rectangles.
 */
export function hydrographVolume(h: readonly HydrographPoint[], a: number, b: number): number {
  if (!(b > a)) return 0;
  // Breakpoints inside (a, b), with the window's own ends: Q is linear between consecutive ones.
  let v = 0;
  let t0 = a;
  let q0 = hydrographAt(h, a);
  for (const p of h) {
    if (p.t <= a) continue;
    if (p.t >= b) break;
    v += 0.5 * (q0 + p.q) * (p.t - t0);
    t0 = p.t;
    q0 = p.q;
  }
  v += 0.5 * (q0 + hydrographAt(h, b)) * (b - t0);
  return v;
}

/**
 * Mean discharge an inflow delivers over the window [from, to], m³/s, so the volume booked into the grid is exactly
 * ∫ Q dt however the run is chunked into frames. A constant source (no hydrograph) is `discharge · inflowFactor`, the
 * pre-hydrograph behaviour bit for bit. With a hydrograph Q(t) is piecewise linear in simulated time, and a
 * `stopAfter` still cuts it off. A zero-length window (paused) reads Q at the instant itself.
 */
export function meanInflow(s: InflowTiming, from: number, to: number): number {
  const h = cleanHydrograph(s.hydrograph);
  if (!h) {
    const q = Number.isFinite(s.discharge) ? s.discharge : 0;
    return q * inflowFactor(s.stopAfter, from, to);
  }
  const stop = s.stopAfter !== undefined && Number.isFinite(s.stopAfter) ? Math.max(0, s.stopAfter) : Infinity;
  if (!(to > from)) return from < stop ? hydrographAt(h, from) : 0;
  return hydrographVolume(h, from, Math.min(to, stop)) / (to - from);
}

/**
 * The simulated time after which an inflow's discharge no longer changes (0 = constant from the start): its stop, or
 * the last point of its hydrograph, whichever comes first. The solver re-packs the forcing every frame until then.
 */
export function inflowVariesUntil(s: InflowTiming): number {
  const stop = s.stopAfter !== undefined && Number.isFinite(s.stopAfter) ? Math.max(0, s.stopAfter) : Infinity;
  const h = cleanHydrograph(s.hydrograph);
  const last = h ? h[h.length - 1].t : 0;
  const until = h ? Math.min(stop, last) : stop;
  return Number.isFinite(until) ? Math.max(0, until) : 0;
}

/** The largest discharge an inflow reaches anywhere in [from, to], m³/s (for the CFL estimate). */
export function peakInflow(s: InflowTiming, from: number, to: number): number {
  const h = cleanHydrograph(s.hydrograph);
  const stop = s.stopAfter !== undefined && Number.isFinite(s.stopAfter) ? Math.max(0, s.stopAfter) : Infinity;
  if (from >= stop) return 0;
  const end = Math.min(to, stop);
  if (!h) return Math.max(0, Number.isFinite(s.discharge) ? s.discharge : 0);
  let q = Math.max(hydrographAt(h, from), hydrographAt(h, Math.max(from, end)));
  for (const p of h) if (p.t > from && p.t < end) q = Math.max(q, p.q);
  return q;
}

/** The cells (row-major indices) where a source footprint has weight > 0, in row-major order, with their weights. */
export interface Footprint {
  cells: Int32Array;
  weights: Float64Array;
}

/** Footprint of a source of `radius` cells at (gx, gy), clipped to the nx × ny grid. */
export function sourceFootprint(gx: number, gy: number, radius: number, nx: number, ny: number): Footprint {
  const R = footprintRadius(radius);
  const x0 = Math.max(0, Math.floor(gx - R - 1));
  const x1 = Math.min(nx - 1, Math.ceil(gx + R + 1));
  const y0 = Math.max(0, Math.floor(gy - R - 1));
  const y1 = Math.min(ny - 1, Math.ceil(gy + R + 1));
  const cells: number[] = [];
  const weights: number[] = [];
  for (let j = y0; j <= y1; j++) {
    for (let i = x0; i <= x1; i++) {
      const w = footprintWeight(Math.hypot(i + 0.5 - gx, j + 0.5 - gy), R);
      if (w > 0) {
        cells.push(j * nx + i);
        weights.push(w);
      }
    }
  }
  return { cells: Int32Array.from(cells), weights: Float64Array.from(weights) };
}

export interface PackedForcing {
  /** FORCING_FLOATS floats ready for the uniform buffer. */
  data: Float32Array;
  nSources: number;
  nStorms: number;
  /** Largest depth a stage source may impose anywhere in its footprint (for the CFL estimate), m. */
  stageDepthMax: number;
  /**
   * Total inflow discharge actually represented, m³/s: sources fully outside the domain are dropped, and a timed
   * inflow past its stopAfter contributes nothing.
   */
  inflowTotal: number;
  /** Largest storm-cell intensity packed, m/s (for the CFL estimate). */
  stormRateMax: number;
  /** Number of sources / storms dropped because the fixed-size arrays were full. */
  dropped: number;
}

/**
 * Pack sources and storms. `bedAt` (row-major index → bed meters, NOT datum-relative) bounds the depth a stage
 * source can create (given as a lookup so no combined array has to be allocated); z0 is the solver's internal
 * elevation datum. `footprintOf` may supply cached footprints (see sourceFootprint; same cells and weights).
 * `window` is the simulated-time window this packing will be stepped over, and only a timed inflow reads it
 * (WaterSource.stopAfter, see inflowFactor); omitted means t = 0, where nothing has stopped yet.
 */
export function packForcing(
  sources: readonly WaterSource[],
  storms: readonly StormCell[],
  nx: number,
  ny: number,
  cellSize: number,
  z0: number,
  bedAt: (index: number) => number,
  footprintOf?: (source: WaterSource) => Footprint,
  window?: ForcingWindow,
): PackedForcing {
  const data = new Float32Array(FORCING_FLOATS);
  const cellArea = cellSize * cellSize;
  let nSources = 0;
  let dropped = 0;
  let stageDepthMax = 0;
  let inflowTotal = 0;

  for (const s of sources) {
    if (nSources >= MAX_SOURCES) {
      dropped++;
      continue;
    }
    const R = footprintRadius(s.radius);
    const fp = footprintOf ? footprintOf(s) : sourceFootprint(s.gx, s.gy, s.radius, nx, ny);
    let wSum = 0;
    let minBed = Infinity;
    for (let k = 0; k < fp.cells.length; k++) {
      wSum += fp.weights[k];
      const b = bedAt(fp.cells[k]);
      if (b < minBed) minBed = b;
    }
    if (!(wSum > 0)) continue; // footprint entirely outside the domain
    const o = nSources * 8;
    data[o] = s.gx;
    data[o + 1] = s.gy;
    data[o + 2] = R;
    if (s.type === 'inflow') {
      const q = meanInflow(s, window?.from ?? 0, window?.to ?? 0);
      data[o + 3] = 0;
      data[o + 4] = q / (wSum * cellArea);
      inflowTotal += q;
    } else {
      data[o + 3] = 1;
      data[o + 4] = s.level - z0;
      stageDepthMax = Math.max(stageDepthMax, s.level - minBed);
    }
    nSources++;
  }

  let nStorms = 0;
  let stormRateMax = 0;
  const stormBase = 2 * MAX_SOURCES * 4;
  for (const st of storms) {
    if (nStorms >= MAX_STORMS) {
      dropped++;
      continue;
    }
    const o = stormBase + nStorms * 4;
    data[o] = st.gx;
    data[o + 1] = st.gy;
    data[o + 2] = footprintRadius(st.radius);
    data[o + 3] = Math.max(0, Number.isFinite(st.intensity) ? st.intensity : 0) * MMHR_TO_MS;
    stormRateMax = Math.max(stormRateMax, data[o + 3]);
    nStorms++;
  }
  return { data, nSources, nStorms, stageDepthMax, inflowTotal, stormRateMax, dropped };
}
