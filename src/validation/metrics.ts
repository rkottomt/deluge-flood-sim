/**
 * Validation metrics: how a modelled flood compares with an observed one (docs/VALIDATION.md).
 *
 * Two families, both standard in flood-model benchmarking:
 *
 *  • POINT comparisons — modelled peak water-surface elevation (WSE) at a surveyed high-water mark or a gauge, against
 *    the observed one: bias (mean of model − observed), RMSE, MAE and the share within ±0.3 m and ±1 m.
 *  • EXTENT comparisons — a binary contingency table of modelled-wet against observed-wet cells over a comparison mask:
 *    hits (both wet), misses (observed only), false alarms (model only), correct negatives (both dry). From it the
 *    critical success index CSI = hits / (hits + misses + false alarms) — the "fit" statistic of Bates & De Roo (2000)
 *    and the Wing et al. (2017) benchmark — the hit rate (probability of detection) hits / (hits + misses), the false
 *    alarm ratio false alarms / (hits + false alarms), and the frequency bias (hits + false alarms) / (hits + misses).
 *    CSI ignores correct negatives on purpose: a domain that is mostly dry hill would otherwise score near 1 for any map.
 *
 * Everything here is pure (no GPU, no files) so it is unit-tested in tests/validation/metrics.test.ts.
 */

export interface Contingency {
  hits: number;
  misses: number;
  falseAlarms: number;
  correctNegatives: number;
}

export interface ExtentScores extends Contingency {
  /** Cells compared (inside the comparison mask). */
  cells: number;
  /** hits / (hits + misses + falseAlarms); null when nothing is wet in either map. */
  csi: number | null;
  /** hits / (hits + misses): share of the observed flood the model reproduces. */
  hitRate: number | null;
  /** falseAlarms / (hits + falseAlarms): share of the modelled flood the observation does not have. */
  falseAlarmRatio: number | null;
  /** (hits + falseAlarms) / (hits + misses): > 1 the model floods more ground than observed. */
  frequencyBias: number | null;
}

const ratio = (a: number, b: number): number | null => (b > 0 ? a / b : null);

/** Scores from a contingency table. */
export function scoreContingency(c: Contingency): ExtentScores {
  const { hits, misses, falseAlarms, correctNegatives } = c;
  return {
    hits,
    misses,
    falseAlarms,
    correctNegatives,
    cells: hits + misses + falseAlarms + correctNegatives,
    csi: ratio(hits, hits + misses + falseAlarms),
    hitRate: ratio(hits, hits + misses),
    falseAlarmRatio: ratio(falseAlarms, hits + falseAlarms),
    frequencyBias: ratio(hits + falseAlarms, hits + misses),
  };
}

/**
 * Cell-by-cell contingency of two binary maps over a comparison mask (all three nx·ny, row-major; non-zero = true).
 * `mask` null compares every cell.
 */
export function contingency(model: ArrayLike<number>, observed: ArrayLike<number>, mask: ArrayLike<number> | null): Contingency {
  if (model.length !== observed.length || (mask && mask.length !== model.length)) {
    throw new Error(`contingency: length mismatch (${model.length}, ${observed.length}, ${mask?.length})`);
  }
  let hits = 0;
  let misses = 0;
  let falseAlarms = 0;
  let correctNegatives = 0;
  for (let k = 0; k < model.length; k++) {
    if (mask && !mask[k]) continue;
    const m = model[k] !== 0;
    const o = observed[k] !== 0;
    if (m && o) hits++;
    else if (o) misses++;
    else if (m) falseAlarms++;
    else correctNegatives++;
  }
  return { hits, misses, falseAlarms, correctNegatives };
}

/** contingency() then scoreContingency(). */
export function extentScores(model: ArrayLike<number>, observed: ArrayLike<number>, mask: ArrayLike<number> | null): ExtentScores {
  return scoreContingency(contingency(model, observed, mask));
}

export interface PointScores {
  /** Pairs compared. */
  n: number;
  /** Mean of (model − observed), m: positive = the model is too high. */
  bias: number | null;
  rmse: number | null;
  mae: number | null;
  /** Median of (model − observed), m. */
  median: number | null;
  /** Share of |model − observed| ≤ 0.3 m. */
  within03: number | null;
  /** Share of |model − observed| ≤ 1 m. */
  within1: number | null;
  /** Largest |model − observed|, m. */
  maxAbs: number | null;
}

/** Point-comparison statistics of residuals (model − observed, metres). Non-finite residuals are skipped. */
export function pointScores(residuals: ArrayLike<number>): PointScores {
  const r: number[] = [];
  for (let k = 0; k < residuals.length; k++) if (Number.isFinite(residuals[k])) r.push(residuals[k]);
  const n = r.length;
  if (n === 0) return { n: 0, bias: null, rmse: null, mae: null, median: null, within03: null, within1: null, maxAbs: null };
  let s = 0;
  let s2 = 0;
  let sa = 0;
  let w03 = 0;
  let w1 = 0;
  let mx = 0;
  for (const v of r) {
    const a = Math.abs(v);
    s += v;
    s2 += v * v;
    sa += a;
    // A residual of exactly 0.3 m counts as within: compare with a small tolerance so 0.1 + 0.2 does too.
    if (a <= 0.3 + 1e-9) w03++;
    if (a <= 1 + 1e-9) w1++;
    if (a > mx) mx = a;
  }
  return {
    n,
    bias: s / n,
    rmse: Math.sqrt(s2 / n),
    mae: sa / n,
    median: percentile(r, 0.5),
    within03: w03 / n,
    within1: w1 / n,
    maxAbs: mx,
  };
}

/** Linear-interpolated percentile (p in [0, 1]) of a list of numbers; null for an empty list. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const x = Math.min(1, Math.max(0, p)) * (s.length - 1);
  const lo = Math.floor(x);
  const hi = Math.ceil(x);
  return s[lo] + (s[hi] - s[lo]) * (x - lo);
}

/**
 * Binary 4-connected components of `mask` (nx·ny); returns a label per cell (0 = background, 1…count).
 * Iterative flood fill, so a 1024² mask cannot overflow the stack.
 */
export function labelComponents(mask: ArrayLike<number>, nx: number, ny: number): { labels: Int32Array; count: number } {
  const labels = new Int32Array(nx * ny);
  const stack = new Int32Array(nx * ny);
  let count = 0;
  for (let start = 0; start < nx * ny; start++) {
    if (!mask[start] || labels[start]) continue;
    count++;
    let top = 0;
    stack[top++] = start;
    labels[start] = count;
    while (top > 0) {
      const k = stack[--top];
      const i = k % nx;
      const j = (k - i) / nx;
      const push = (q: number) => {
        if (mask[q] && !labels[q]) {
          labels[q] = count;
          stack[top++] = q;
        }
      };
      if (i > 0) push(k - 1);
      if (i < nx - 1) push(k + 1);
      if (j > 0) push(k - nx);
      if (j < ny - 1) push(k + nx);
    }
  }
  return { labels, count };
}

/**
 * The parts of `zone` (nx·ny binary) that are 4-connected to any `seed` cell, the seed cells being treated as part of
 * the zone for connectivity (so a floodplain that touches a river which is itself not in `zone` still counts).
 *
 * Used to keep only the FEMA 1 % zones of the rivers a scenario actually forces: a floodplain of an unmodelled creek is
 * not a miss of a Point-gauge stage run, it is a different flood.
 */
export function connectedTo(zone: ArrayLike<number>, seed: ArrayLike<number>, nx: number, ny: number): Uint8Array {
  const n = nx * ny;
  const both = new Uint8Array(n);
  for (let k = 0; k < n; k++) both[k] = zone[k] || seed[k] ? 1 : 0;
  const { labels, count } = labelComponents(both, nx, ny);
  const keep = new Uint8Array(count + 1);
  for (let k = 0; k < n; k++) if (seed[k] && labels[k]) keep[labels[k]] = 1;
  const out = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (zone[k] && keep[labels[k]]) out[k] = 1;
  return out;
}

/** Grow a binary mask by `r` cells (square structuring element). */
export function dilate(mask: ArrayLike<number>, nx: number, ny: number, r: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  if (r <= 0) {
    for (let k = 0; k < nx * ny; k++) out[k] = mask[k] ? 1 : 0;
    return out;
  }
  // Separable: rows then columns.
  const tmp = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!mask[j * nx + i]) continue;
      for (let d = Math.max(0, i - r); d <= Math.min(nx - 1, i + r); d++) tmp[j * nx + d] = 1;
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!tmp[j * nx + i]) continue;
      for (let d = Math.max(0, j - r); d <= Math.min(ny - 1, j + r); d++) out[d * nx + i] = 1;
    }
  }
  return out;
}
