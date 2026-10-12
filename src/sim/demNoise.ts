/**
 * Smooth random bed perturbation for ensemble members (GpuFloodSolver.setBedPerturbation; src/loss/ensemble.ts).
 *
 * A DEM's error is spatially correlated: a lidar tile is a few centimetres off over a whole block, not ±σ cell by cell.
 * The field is white Gaussian noise (seeded, deterministic) smoothed by three passes of a separable box filter — a
 * close approximation of a Gaussian kernel whose standard deviation is `corrLenM` — then rescaled to exactly `sigma`
 * (population σ over the cells it may touch), and finally faded to zero over water present at the start:
 *
 *   δ = σ · ẑ · m,   m = 0 on initially wet cells, rising smoothly to 1 within `featherCells` of them.
 *
 * Why the mask: the initial water (rivers, lakes) is a lake at rest on the unperturbed bed. Moving its bed would set it
 * sloshing in every member and pour water across the banks — a dam break of the perturbation's making. For the same
 * reason a bank that stood above the water beside it is never lowered below that water's surface (given `elevation`;
 * this lifts a few low bank cells by up to σ, a small local upward bias, documented in ARCHITECTURE.md). Dry land is
 * free to move: water that later arrives there simply meets the perturbed ground. Mass accounting is untouched (the
 * initial volume is the same), and walls are a separate barrier layer that rides on top of whatever ground is there.
 */
import { mulberry32 } from '../loss/ensemble';

/** Standard normal deviates from a uniform PRNG (Box–Muller, both outputs used). */
function gaussianFill(out: Float32Array, rand: () => number): void {
  for (let i = 0; i < out.length; i += 2) {
    const u = Math.max(1e-12, rand());
    const v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v);
    if (i + 1 < out.length) out[i + 1] = r * Math.sin(2 * Math.PI * v);
  }
}

/** One box-filter pass of half-width r along rows (dir 0) or columns (dir 1), clamped at the edges. */
function boxPass(src: Float32Array, dst: Float32Array, nx: number, ny: number, r: number, dir: 0 | 1): void {
  const len = dir === 0 ? nx : ny;
  const lines = dir === 0 ? ny : nx;
  const stride = dir === 0 ? 1 : nx;
  const w = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = dir === 0 ? l * nx : l;
    const at = (k: number) => src[base + Math.min(len - 1, Math.max(0, k)) * stride];
    let acc = 0;
    for (let k = -r; k <= r; k++) acc += at(k);
    for (let k = 0; k < len; k++) {
      dst[base + k * stride] = acc * w;
      acc += at(k + r + 1) - at(k - r);
    }
  }
}

/** Three box passes in each direction: ≈ a Gaussian blur of standard deviation √(3·((2r+1)² − 1)/12) cells. */
export function smoothField(field: Float32Array, nx: number, ny: number, r: number): Float32Array {
  if (r < 1) return field;
  let a: Float32Array = field;
  let b: Float32Array = new Float32Array(field.length);
  for (let k = 0; k < 3; k++) {
    boxPass(a, b, nx, ny, r, 0);
    [a, b] = [b, a];
    boxPass(a, b, nx, ny, r, 1);
    [a, b] = [b, a];
  }
  return a;
}

/** Box half-width (cells) whose triple pass has Gaussian standard deviation ≈ `sigmaCells`. */
export function boxRadiusFor(sigmaCells: number): number {
  // Variance of one box of width w = 2r+1 is (w² − 1)/12; three passes add up.
  return Math.max(0, Math.round((Math.sqrt(4 * sigmaCells * sigmaCells + 1) - 1) / 2));
}

export interface DemNoiseOptions {
  nx: number;
  ny: number;
  cellSize: number;
  /** Target standard deviation, m (over the cells the field may move). */
  sigma: number;
  /** Correlation length (standard deviation of the smoothing kernel), m. */
  corrLenM: number;
  seed: number;
  /** Initial water depth (nx·ny, m): cells with ≥ wetDepth are left untouched. */
  initialDepth?: ArrayLike<number> | null;
  /** Depth that counts as wet at the start, m (default 0.01, the solver's WET_DEPTH). */
  wetDepth?: number;
  /** Cells over which the field fades in away from the initial water (default 4). */
  featherCells?: number;
  /**
   * Bare ground (nx·ny, m) the field is added to. With it, a dry cell near the initial water that stood above the
   * water's surface is never lowered below it: a bank nudged under the river's level would spill the river at t = 0.
   */
  elevation?: ArrayLike<number> | null;
}

/** Sliding-window maximum of half-width r along rows (dir 0) or columns (dir 1). O(len · r), fine for small r. */
function maxPass(src: Float32Array, dst: Float32Array, nx: number, ny: number, r: number, dir: 0 | 1): void {
  const len = dir === 0 ? nx : ny;
  const lines = dir === 0 ? ny : nx;
  const stride = dir === 0 ? 1 : nx;
  for (let l = 0; l < lines; l++) {
    const base = dir === 0 ? l * nx : l;
    for (let k = 0; k < len; k++) {
      let m = -Infinity;
      const a = Math.max(0, k - r);
      const b = Math.min(len - 1, k + r);
      for (let q = a; q <= b; q++) m = Math.max(m, src[base + q * stride]);
      dst[base + k * stride] = m;
    }
  }
}

/** The perturbation δ (nx·ny, m) for one member. Deterministic in (options, seed). */
export function demPerturbation(o: DemNoiseOptions): Float32Array {
  const N = o.nx * o.ny;
  const z = new Float32Array(N);
  if (!(o.sigma > 0)) return z;
  gaussianFill(z, mulberry32(o.seed));
  const sm = smoothField(z, o.nx, o.ny, boxRadiusFor(o.corrLenM / Math.max(1e-6, o.cellSize)));
  // Mask: 0 on the initial water, fading in over `feather` cells (box blur of the wet indicator).
  let mask: Float32Array | null = null;
  let eta: Float32Array | null = null;
  const wetDepth = o.wetDepth ?? 0.01;
  if (o.initialDepth && o.initialDepth.length >= N) {
    const wet = new Float32Array(N);
    let any = false;
    for (let c = 0; c < N; c++) if (o.initialDepth[c] >= wetDepth) ((wet[c] = 1), (any = true));
    if (any) {
      const f = Math.max(1, Math.round(o.featherCells ?? 4));
      const near = new Float32Array(N);
      const tmp = new Float32Array(N);
      boxPass(wet, tmp, o.nx, o.ny, f, 0);
      boxPass(tmp, near, o.nx, o.ny, f, 1);
      mask = new Float32Array(N);
      for (let c = 0; c < N; c++) {
        if (wet[c] > 0) continue;
        // near: share of wet cells in the (2f+1)² box. Beside a straight bank it is (f + 1 − d)/(2f + 1) at d cells
        // from the water, so t runs from f/(f+1) next to it to 0 at f + 1 cells: a smooth fade, not a step.
        const t = Math.min(1, (near[c] * (2 * f + 1)) / (f + 1));
        mask[c] = 1 - t * t * (3 - 2 * t);
      }
      // Highest initial water surface within reach of each cell (f + 2 cells: the fade plus a margin).
      if (o.elevation && o.elevation.length >= N) {
        const surf = new Float32Array(N).fill(-Infinity);
        for (let c = 0; c < N; c++) if (wet[c] > 0) surf[c] = o.elevation[c] + o.initialDepth[c];
        const t1 = new Float32Array(N);
        eta = new Float32Array(N);
        maxPass(surf, t1, o.nx, o.ny, f + 2, 0);
        maxPass(t1, eta, o.nx, o.ny, f + 2, 1);
      }
    }
  }
  // Rescale to σ over the cells the field may move.
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let c = 0; c < N; c++) {
    if (mask && mask[c] <= 0) continue;
    s += sm[c];
    s2 += sm[c] * sm[c];
    n++;
  }
  const mean = n ? s / n : 0;
  const sd = n ? Math.sqrt(Math.max(1e-30, s2 / n - mean * mean)) : 1;
  const k = o.sigma / sd;
  const out = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    const w = mask ? mask[c] : 1;
    let d = w > 0 ? (sm[c] - mean) * k * w : 0;
    // A bank that stood above the nearby water stays at least 1 mm above it.
    if (eta && w > 0 && Number.isFinite(eta[c])) {
      const z0 = o.elevation![c];
      if (z0 >= eta[c]) d = Math.max(d, eta[c] + 0.001 - z0);
    }
    out[c] = d;
  }
  return out;
}
