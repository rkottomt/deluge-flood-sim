/**
 * CPU replica of the rendered terrain surface. The GPU mesh places a vertex at every `stride`-th cell CORNER
 * (grid coords k·stride), whose elevation is avg(ground of the 4 touching cells) + max(barrier of those
 * cells) — walls keep their full height even when only one cell wide. Quads are split along the
 * (k+1,l)–(k,l+1) diagonal. `heightAt` reproduces that exact piecewise-linear surface, so picking and the
 * camera terrain-clearance agree with what is on screen to floating-point precision.
 */

export const MAX_MESH_VERTICES = 1_100_000;

/** Smallest power-of-two stride that keeps the (nx/s+1)(ny/s+1) vertex grid within budget. */
export function meshStride(nx: number, ny: number): number {
  let s = 1;
  while ((Math.floor(nx / s) + 1) * (Math.floor(ny / s) + 1) > MAX_MESH_VERTICES && s < 64) s *= 2;
  return s;
}

export class HeightField {
  readonly vx: number; // vertices per row
  readonly vy: number;
  /** Min/max of ground+barrier (meters), refreshed by `refreshRange()`. */
  minElev = 0;
  maxElev = 0;

  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly cellSize: number,
    readonly ground: Float32Array,
    readonly barrier: Float32Array,
    readonly stride: number = meshStride(nx, ny),
  ) {
    this.vx = Math.floor(nx / stride) + 1;
    this.vy = Math.floor(ny / stride) + 1;
    this.refreshRange();
  }

  refreshRange(): void {
    let lo = Infinity;
    let hi = -Infinity;
    const g = this.ground;
    const b = this.barrier;
    for (let i = 0; i < g.length; i++) {
      const z = g[i] + (b[i] || 0);
      if (z < lo) lo = z;
      if (z > hi) hi = z;
    }
    if (!Number.isFinite(lo)) lo = hi = 0;
    this.minElev = lo;
    this.maxElev = hi;
  }

  /** Mesh vertex elevation (meters, unexaggerated) at vertex (k, l). */
  corner(k: number, l: number): number {
    const s = this.stride;
    const nx = this.nx;
    const x0 = Math.min(Math.max(k * s - 1, 0), nx - 1);
    const x1 = Math.min(k * s, nx - 1);
    const y0 = Math.min(Math.max(l * s - 1, 0), this.ny - 1);
    const y1 = Math.min(l * s, this.ny - 1);
    const i00 = y0 * nx + x0;
    const i10 = y0 * nx + x1;
    const i01 = y1 * nx + x0;
    const i11 = y1 * nx + x1;
    const g = this.ground;
    const b = this.barrier;
    const gAvg = 0.25 * (g[i00] + g[i10] + g[i01] + g[i11]);
    const bMax = Math.max(b[i00], b[i10], b[i01], b[i11]);
    return gAvg + bMax;
  }

  /** Elevation of the rendered surface (meters, unexaggerated) at grid coords. Clamped to the domain. */
  heightAt(gx: number, gy: number): number {
    const s = this.stride;
    let fx = Math.min(Math.max(gx, 0), this.nx) / s;
    let fy = Math.min(Math.max(gy, 0), this.ny) / s;
    let k = Math.floor(fx);
    let l = Math.floor(fy);
    if (k > this.vx - 2) k = this.vx - 2;
    if (l > this.vy - 2) l = this.vy - 2;
    const tx = fx - k;
    const ty = fy - l;
    const b = this.corner(k + 1, l);
    const c = this.corner(k, l + 1);
    if (tx + ty <= 1) {
      const a = this.corner(k, l);
      return a + (b - a) * tx + (c - a) * ty;
    }
    const d = this.corner(k + 1, l + 1);
    return d + (c - d) * (1 - tx) + (b - d) * (1 - ty);
  }

  /** Nearest-cell raw values. */
  cellIndex(gx: number, gy: number): number {
    const i = Math.min(Math.max(Math.floor(gx), 0), this.nx - 1);
    const j = Math.min(Math.max(Math.floor(gy), 0), this.ny - 1);
    return j * this.nx + i;
  }
}
