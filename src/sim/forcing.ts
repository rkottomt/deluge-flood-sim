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
import type { StormCell, WaterSource } from '../contracts';
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
  /** Total inflow discharge actually represented (sources fully outside the domain are dropped), m³/s. */
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
      const q = Number.isFinite(s.discharge) ? s.discharge : 0;
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
