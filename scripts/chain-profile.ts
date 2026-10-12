/**
 * Pure profile operations of the hazard-chain bake (scripts/bake-chain.ts), split out so tests can exercise them
 * without the network: the monotone thalweg fit and the minimum channel floor.
 *
 * WHY THESE EXIST (calibration against the 2026 Lhende → Trishuli event, Oct 2026). The first bake fitted the bed with
 * a plain isotonic regression. Pool-adjacent-violators returns a STAIRCASE: every run of DSM noise that rises
 * downstream is pooled into one flat block, so 158 of Nepal's 638 faces were exactly flat and the drops between them
 * reached 45 m per 100 m node. In the local-inertial router a flat face is driven only by its water-surface slope and
 * a 45 m step is a waterfall the Froude cap throttles, so the wave crept through a chain of pools. And a 30 m DEM
 * cannot see a channel floor narrower than its own cell, so gorge sections came out as V-shaped slots (3 m wide at
 * 5 m stage) whose hydraulic radius — and so Manning speed — stops growing with the flood.
 */
import type { ChainSection } from '../src/hazard/types';

/** Least-squares non-increasing fit (pool adjacent violators), weights = node spacing. */
export function isotonicNonIncreasing(v: number[], w: number[]): number[] {
  return isotonicBlocks(v, w).flatMap((b) => Array<number>(b.n).fill(b.sum / b.wt));
}

interface Block {
  sum: number;
  wt: number;
  n: number;
}

function isotonicBlocks(v: number[], w: number[]): Block[] {
  const blocks: Block[] = [];
  for (let i = 0; i < v.length; i++) {
    blocks.push({ sum: v[i] * w[i], wt: w[i], n: 1 });
    // Non-increasing: merge while the later block's mean exceeds the earlier one's.
    while (blocks.length > 1) {
      const b = blocks[blocks.length - 1];
      const a = blocks[blocks.length - 2];
      if (b.sum / b.wt <= a.sum / a.wt) break;
      blocks.splice(blocks.length - 2, 2, { sum: a.sum + b.sum, wt: a.wt + b.wt, n: a.n + b.n });
    }
  }
  return blocks;
}

/**
 * Half-window of the moving average applied after the block interpolation, m. 300 m = ±3 nodes at the bake's 100 m:
 * long enough to round the kinks at block centres, short against the 5–15 km over which the valley's gradient
 * changes (Nepal: 10 % in the Lhende, 2–3 % past Syafrubesi). [H]
 */
export const THALWEG_SMOOTH_HALF = 300;

/**
 * Smooth monotone bed (non-increasing downstream) from noisy thalweg samples:
 *
 *   1. isotonic least-squares fit (pool adjacent violators) — the best non-increasing step function;
 *   2. each pooled block is replaced by its weighted mean placed at its weighted-centroid chainage, and the bed is the
 *      piecewise-linear curve through those points (extended at both ends with the slope of the first / last
 *      segment). The block means strictly decrease, so this curve strictly decreases: the staircase's flats become
 *      the gradient the block averaged over, and its steps are spread across the distance between block centres;
 *   3. a moving average over ±`half` m (windows truncated at the ends, never re-centred). A moving average of a
 *      non-increasing sequence is non-increasing — moving the window one node drops its largest (most upstream)
 *      member and adds one no larger than any it holds — so monotonicity survives the smoothing exactly.
 *
 * The result is monotone with no tolerance and has no flat faces except where the data are flat. Its total drop is
 * the isotonic fit's to within the end extrapolation; the bake logs the residual against the raw samples.
 */
export function monotoneSmooth(s: number[], v: number[], w: number[], half = THALWEG_SMOOTH_HALF): number[] {
  const n = v.length;
  if (n < 3) return isotonicNonIncreasing(v, w);
  const blocks = isotonicBlocks(v, w);
  // Block centroids (chainage) and means.
  const xs: number[] = [];
  const ys: number[] = [];
  let i0 = 0;
  for (const b of blocks) {
    let sw = 0;
    let sx = 0;
    for (let k = i0; k < i0 + b.n; k++) {
      sw += w[k];
      sx += w[k] * s[k];
    }
    xs.push(sx / sw);
    ys.push(b.sum / b.wt);
    i0 += b.n;
  }
  let z: number[];
  if (xs.length === 1) z = Array<number>(n).fill(ys[0]);
  else {
    const m = xs.length;
    z = s.map((x) => {
      let j = 0;
      if (x <= xs[0]) j = 0;
      else if (x >= xs[m - 1]) j = m - 2;
      else while (j < m - 2 && xs[j + 1] < x) j++;
      return ys[j] + ((ys[j + 1] - ys[j]) * (x - xs[j])) / (xs[j + 1] - xs[j]);
    });
  }
  if (half <= 0) return z;
  // Truncated moving average, weighted by node spacing, by prefix sums.
  const cw = [0];
  const cz = [0];
  for (let k = 0; k < n; k++) {
    cw.push(cw[k] + w[k]);
    cz.push(cz[k] + w[k] * z[k]);
  }
  const out = new Array<number>(n);
  let a = 0;
  let b = 0;
  for (let k = 0; k < n; k++) {
    while (s[k] - s[a] > half) a++;
    while (b + 1 < n && s[b + 1] - s[k] <= half) b++;
    out[k] = (cz[b + 1] - cz[a]) / (cw[b + 1] - cw[a]);
  }
  // Exact monotonicity after floating-point sums.
  for (let k = 1; k < n; k++) if (out[k] > out[k - 1]) out[k] = out[k - 1];
  return out;
}

/**
 * Minimum channel floor width, m. A 30 m DEM (Copernicus GLO-30, resampled to the bake's 25 m grid) cannot resolve a
 * channel narrower than about one cell: its "thalweg" is one pixel whose neighbours already sit on the banks, so the
 * transect is a V that closes to a few metres at the bottom (Nepal: 3 m wide at 5 m of stage). Whatever the real
 * channel is, the DEM says nothing about anything narrower than its cell, and a V-slot is the one shape that is
 * certainly wrong: it caps the hydraulic radius near half its width and with it the Manning speed of a deep flood. So
 * every section's floor is widened to at least one DEM cell. 25 m is a RESOLUTION floor, not a measured width [H]; as
 * a plausibility check, a bankfull-width relation of the w ≈ 4–5·Q^0.5 family (Leopold & Maddock 1953 form [M]) gives
 * 45–80 m for the 100–300 m³/s monsoon flows of these rivers, so the floor errs narrow. The bake logs how many
 * sections it widened.
 */
export const MIN_FLOOR_WIDTH = 25;

/** Depth at which a section's floor width is read (the top of the DEM's unresolvable bottom metre), m. */
export const FLOOR_DEPTH = 1;

/**
 * Section with a floor at least `minWidth` wide: where the section is narrower than that at FLOOR_DEPTH above the
 * bed, a flat strip of the missing width δ is inserted at the thalweg — every stage then gains δ of top width, δ·h of
 * area and δ of wetted perimeter (the strip's bottom); the banks above keep the DEM's shape. Returns the section
 * unchanged when it is already wide enough.
 */
export function withFloor(sec: ChainSection, bed: number, minWidth = MIN_FLOOR_WIDTH): { section: ChainSection; added: number } {
  const st = sec.stage;
  const zf = bed + FLOOR_DEPTH;
  let wAt = sec.width[st.length - 1];
  for (let i = 1; i < st.length; i++) {
    if (zf <= st[i]) {
      wAt = sec.width[i - 1] + ((sec.width[i] - sec.width[i - 1]) * (zf - st[i - 1])) / Math.max(1e-9, st[i] - st[i - 1]);
      break;
    }
  }
  const added = Math.max(0, minWidth - wAt);
  if (!(added > 0)) return { section: sec, added: 0 };
  const r = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  return {
    section: {
      stage: [...st],
      area: st.map((z, i) => Math.round(sec.area[i] + added * Math.max(0, z - bed))),
      width: st.map((z, i) => r(z > bed ? sec.width[i] + added : sec.width[i], 1)),
      perimeter: st.map((z, i) => r(z > bed ? sec.perimeter[i] + added : sec.perimeter[i], 1)),
    },
    added,
  };
}

/** Count of faces with no drop (zBed[i] === zBed[i−1]) — the staircase's signature. */
export function flatFaces(z: number[]): number {
  let k = 0;
  for (let i = 1; i < z.length; i++) if (z[i] === z[i - 1]) k++;
  return k;
}
