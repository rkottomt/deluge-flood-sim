/**
 * CDLOD terrain/water level of detail (Strugar 2009, "Continuous Distance-Dependent Level of Detail").
 *
 * The base surface is the vertex grid at `baseStride` cells (see heightfield.ts). A quadtree of nodes covers the
 * domain; every node is drawn with the same G×G-quad patch, so a level-ℓ node has quads of baseStride·2^ℓ cells.
 * A node is subdivided while it intersects the sphere of radius range[ℓ−1] around the camera, and vertices morph
 * continuously toward the parent grid over [morphStart[ℓ], range[ℓ]] — so neighbouring nodes of different levels
 * meet without cracks or popping. Ranges come from a screen-space quad-size target (pixels), bounded below so
 * that the no-crack condition (morphStart[ℓ+1] ≥ range[ℓ] + diagonal of a level-(ℓ+1) node) always holds.
 *
 * Node bounding boxes use a min/max elevation pyramid over ground+barrier that is refreshed incrementally (a
 * band of rows per frame), padded for water above the ground and recent edits.
 */
import type { Vec3 } from './math';

/** Quads per node side. Must be a power of two. */
export const LOD_PATCH = 32;
/** Floats per node instance: originGx, originGy, quadCells, level, morphStart, morphEnd, pad, pad. */
export const LOD_INSTANCE_FLOATS = 8;

export interface LodSelection {
  /** Instance data, LOD_INSTANCE_FLOATS per node. */
  instances: Float32Array;
  count: number;
  /** Nodes per level (diagnostics). */
  perLevel: number[];
}

/** Six frustum planes (a, b, c, d) with a·x + b·y + c·z + d ≥ 0 inside, from a column-major viewProj. */
export function frustumPlanes(m: ArrayLike<number>): Float64Array {
  // Rows of the matrix (column-major storage): row k = [m[k], m[4+k], m[8+k], m[12+k]].
  const row = (k: number) => [m[k], m[4 + k], m[8 + k], m[12 + k]];
  const r0 = row(0);
  const r1 = row(1);
  const r2 = row(2);
  const r3 = row(3);
  const planes = new Float64Array(24);
  const set = (i: number, p: number[]) => {
    const l = Math.hypot(p[0], p[1], p[2]) || 1;
    planes[i * 4] = p[0] / l;
    planes[i * 4 + 1] = p[1] / l;
    planes[i * 4 + 2] = p[2] / l;
    planes[i * 4 + 3] = p[3] / l;
  };
  const add = (a: number[], b: number[], s: number) => a.map((v, i) => v + s * b[i]);
  set(0, add(r3, r0, 1)); // left   (w + x ≥ 0)
  set(1, add(r3, r0, -1)); // right  (w − x ≥ 0)
  set(2, add(r3, r1, 1)); // bottom
  set(3, add(r3, r1, -1)); // top
  // Reversed-Z WebGPU clip: 0 ≤ z ≤ w. z ≤ w is the near plane; z ≥ 0 is the far plane at infinity (skip).
  set(4, add(r3, r2, -1)); // near
  set(5, [0, 0, 0, 1]); // no far plane
  return planes;
}

export class LodTree {
  readonly levels: number;
  /** Min/max elevation (m) per leaf-node-sized block: [min, max] × leafCols × leafRows, then coarser levels. */
  private minMax: Float32Array[] = [];
  private cols: number[] = [];
  private rows: number[] = [];
  private refreshRow = 0;
  private out = new Float32Array(1024 * LOD_INSTANCE_FLOATS);
  private perLevel: number[] = [];

  /** Leaf node side in cells. */
  readonly leafCells: number;

  constructor(
    readonly nx: number,
    readonly ny: number,
    readonly cellSize: number,
    readonly baseStride: number,
    private ground: Float32Array,
    private barrier: Float32Array,
  ) {
    this.leafCells = LOD_PATCH * baseStride;
    let lv = 0;
    while (this.leafCells * 2 ** lv < Math.max(nx, ny)) lv++;
    this.levels = lv + 1;
    let c = Math.ceil(nx / this.leafCells);
    let r = Math.ceil(ny / this.leafCells);
    for (let l = 0; l < this.levels; l++) {
      this.cols.push(c);
      this.rows.push(r);
      this.minMax.push(new Float32Array(c * r * 2));
      c = Math.ceil(c / 2);
      r = Math.ceil(r / 2);
    }
    this.perLevel = new Array(this.levels).fill(0);
    this.refreshAll();
  }

  /** Recompute every leaf block and propagate (O(nx·ny)). */
  refreshAll(): void {
    for (let r = 0; r < this.rows[0]; r++) this.refreshLeafRow(r);
    this.propagate();
  }

  /**
   * Incremental refresh: recompute leaf rows (cyclic) within a cell budget and propagate. ~0.1 ms per frame, so
   * edits (walls, digging) reach the bounding boxes within a fraction of a second at any grid size.
   */
  refreshSome(cellBudget = 70_000): void {
    const cellsPerRow = (this.leafCells + 2) * this.nx;
    const rowsPerCall = Math.max(1, Math.floor(cellBudget / cellsPerRow));
    for (let k = 0; k < rowsPerCall; k++) {
      this.refreshLeafRow(this.refreshRow);
      this.refreshRow = (this.refreshRow + 1) % this.rows[0];
    }
    this.propagate();
  }

  /** Global min / max elevation. */
  get range(): [number, number] {
    const top = this.minMax[this.levels - 1];
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < top.length; i += 2) {
      lo = Math.min(lo, top[i]);
      hi = Math.max(hi, top[i + 1]);
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 0];
  }

  private refreshLeafRow(r: number): void {
    const L = this.leafCells;
    const { nx, ny, ground, barrier } = this;
    const mm = this.minMax[0];
    const j0 = Math.max(0, r * L - 1);
    const j1 = Math.min(ny, (r + 1) * L + 1);
    for (let c = 0; c < this.cols[0]; c++) {
      const i0 = Math.max(0, c * L - 1);
      const i1 = Math.min(nx, (c + 1) * L + 1);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = j0; j < j1; j++) {
        const row = j * nx;
        for (let i = i0; i < i1; i++) {
          const g = ground[row + i];
          const z = g + barrier[row + i];
          if (g < lo) lo = g;
          if (z > hi) hi = z;
        }
      }
      if (!Number.isFinite(lo)) lo = hi = 0;
      mm[(r * this.cols[0] + c) * 2] = lo;
      mm[(r * this.cols[0] + c) * 2 + 1] = hi;
    }
  }

  private propagate(): void {
    for (let l = 1; l < this.levels; l++) {
      const src = this.minMax[l - 1];
      const dst = this.minMax[l];
      const sc = this.cols[l - 1];
      const sr = this.rows[l - 1];
      for (let r = 0; r < this.rows[l]; r++) {
        for (let c = 0; c < this.cols[l]; c++) {
          let lo = Infinity;
          let hi = -Infinity;
          for (let dr = 0; dr < 2; dr++) {
            const rr = 2 * r + dr;
            if (rr >= sr) continue;
            for (let dc = 0; dc < 2; dc++) {
              const cc = 2 * c + dc;
              if (cc >= sc) continue;
              const k = (rr * sc + cc) * 2;
              lo = Math.min(lo, src[k]);
              hi = Math.max(hi, src[k + 1]);
            }
          }
          dst[(r * this.cols[l] + c) * 2] = lo;
          dst[(r * this.cols[l] + c) * 2 + 1] = hi;
        }
      }
    }
  }

  /**
   * LOD ranges (world meters) for a camera. `pixelAngle` = radians per pixel at the screen center;
   * `quadPixels` = target on-screen size of a quad.
   */
  ranges(pixelAngle: number, quadPixels: number, exaggeration: number): { range: Float64Array; morphStart: Float64Array } {
    const baseQuad = this.baseStride * this.cellSize;
    const nodeWorld = this.leafCells * this.cellSize;
    // No-crack bound: morphStart[ℓ+1] = 0.8·range[ℓ+1] = 1.6·range[ℓ] ≥ range[ℓ] + diag(node ℓ+1)
    //   ⇔ range[ℓ] ≥ diag(node ℓ+1) / 0.6 with diag(node ℓ+1) ≈ 2·√2·nodeWorld·2^ℓ (+ a margin for relief).
    const minR0 = (2 * Math.SQRT2 * nodeWorld * 1.15) / 0.6 + 50 * exaggeration;
    const r0 = Math.max(baseQuad / (Math.max(0.5, quadPixels) * Math.max(1e-6, pixelAngle)), minR0);
    const range = new Float64Array(this.levels);
    const morphStart = new Float64Array(this.levels);
    for (let l = 0; l < this.levels; l++) {
      range[l] = r0 * 2 ** l;
      morphStart[l] = range[l] * 0.8;
    }
    // The coarsest level never morphs.
    range[this.levels - 1] = morphStart[this.levels - 1] = 1e12;
    return { range, morphStart };
  }

  /**
   * Select nodes for a camera. `padBelow/padAbove` (m, unexaggerated) extend bounding boxes (water surfaces,
   * pending edits). Returns instance data for drawing.
   */
  select(eye: Vec3, planes: Float64Array, pixelAngle: number, quadPixels: number, exaggeration: number, padBelow: number, padAbove: number): LodSelection {
    const { range, morphStart } = this.ranges(pixelAngle, quadPixels, exaggeration);
    this.perLevel.fill(0);
    let count = 0;
    const cs = this.cellSize;
    const hx = (this.nx / 2) * cs;
    const hz = (this.ny / 2) * cs;
    const top = this.levels - 1;

    const visit = (level: number, c: number, r: number) => {
      const size = this.leafCells * 2 ** level; // cells
      const gx0 = c * size;
      const gy0 = r * size;
      if (gx0 >= this.nx || gy0 >= this.ny) return;
      const gx1 = Math.min(this.nx, gx0 + size);
      const gy1 = Math.min(this.ny, gy0 + size);
      const k = (r * this.cols[level] + c) * 2;
      const mm = this.minMax[level];
      const x0 = gx0 * cs - hx;
      const x1 = gx1 * cs - hx;
      const z0 = gy0 * cs - hz;
      const z1 = gy1 * cs - hz;
      const y0 = (mm[k] - padBelow) * exaggeration;
      const y1 = (mm[k + 1] + padAbove) * exaggeration;
      // Frustum test (AABB fully outside any plane → cull).
      for (let p = 0; p < 5; p++) {
        const a = planes[p * 4];
        const b = planes[p * 4 + 1];
        const cc = planes[p * 4 + 2];
        const d = planes[p * 4 + 3];
        const px = a >= 0 ? x1 : x0;
        const py = b >= 0 ? y1 : y0;
        const pz = cc >= 0 ? z1 : z0;
        if (a * px + b * py + cc * pz + d < 0) return;
      }
      if (level > 0) {
        // Distance from the eye to the box.
        const dx = Math.max(x0 - eye[0], 0, eye[0] - x1);
        const dy = Math.max(y0 - eye[1], 0, eye[1] - y1);
        const dz = Math.max(z0 - eye[2], 0, eye[2] - z1);
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dist < range[level - 1]) {
          const cc2 = c * 2;
          const rr2 = r * 2;
          visit(level - 1, cc2, rr2);
          visit(level - 1, cc2 + 1, rr2);
          visit(level - 1, cc2, rr2 + 1);
          visit(level - 1, cc2 + 1, rr2 + 1);
          return;
        }
      }
      if ((count + 1) * LOD_INSTANCE_FLOATS > this.out.length) {
        const grown = new Float32Array(this.out.length * 2);
        grown.set(this.out);
        this.out = grown;
      }
      const o = count * LOD_INSTANCE_FLOATS;
      const out = this.out;
      out[o] = gx0;
      out[o + 1] = gy0;
      out[o + 2] = this.baseStride * 2 ** level;
      out[o + 3] = level;
      out[o + 4] = morphStart[level];
      out[o + 5] = range[level];
      out[o + 6] = 0;
      out[o + 7] = 0;
      count++;
      this.perLevel[level]++;
    };
    for (let r = 0; r < this.rows[top]; r++) for (let c = 0; c < this.cols[top]; c++) visit(top, c, r);
    return { instances: this.out.subarray(0, count * LOD_INSTANCE_FLOATS), count, perLevel: this.perLevel.slice() };
  }
}
