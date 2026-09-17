/**
 * Wall distance field: for every cell, the distance (cells) to the nearest wall cell within WALL_FIELD_RADIUS, plus
 * that wall's height and crest elevation. The terrain and water shaders draw walls from it with a SCREEN-SPACE
 * minimum width (crest, sunlit / shaded face, dark casing, drop shadow), so a 12 m wide levee still reads as a
 * raised structure from 8 km away, where its real footprint is a couple of pixels.
 *
 * Walls are a raster (the solver's barrier heights), edited by brushes on the CPU mirror. The field is rebuilt
 * incrementally on the CPU: per-block checksums of the barrier mirror are scanned under a cell budget each frame
 * (plus "hot" regions under the brush cursor / a just-committed wall preview, scanned every frame), and only
 * changed blocks — expanded by the radius — are recomputed and uploaded as a sub-rectangle. Distances are measured
 * to the wall's sub-cell outline (see compute), so a wall drawn at an angle gets straight edges instead of a
 * staircase of cells.
 */

/** Maximum distance (cells) the field resolves; beyond it a texel reads as "no wall nearby". */
export const WALL_FIELD_RADIUS = 8;
/** Barrier heights below this (m) are not walls (brush falloff residue, erased walls). */
export const WALL_MIN_HEIGHT = 0.05;
const BLOCK = 32;

export interface Rect {
  x0: number;
  y0: number;
  /** Exclusive. */
  x1: number;
  y1: number;
}

/** Float → IEEE half (for rgba16float uploads). */
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = (x >>> 23) & 0xff;
  let m = x & 0x7fffff;
  if (e === 0xff) return sign | 0x7c00 | (m ? 0x200 : 0);
  const he = e - 127 + 15;
  if (he >= 0x1f) return sign | 0x7c00;
  if (he <= 0) {
    if (he < -10) return sign;
    m = (m | 0x800000) >>> (1 - he);
    return sign | ((m + 0x1000) >>> 13);
  }
  return sign | (he << 10) | ((m + 0x1000) >>> 13);
}

/** Recomputed field values over a rectangle (row-major, rect-sized). */
export interface FieldPatch {
  rect: Rect;
  /** Distance (cells) to the nearest wall, as a cell-centre distance corrected to the sub-cell outline; radius + 1 when none. */
  dist: Float32Array;
  /** Height (m) of the nearest wall (0 when none). */
  height: Float32Array;
  /** Crest elevation (m, absolute) of the nearest wall. */
  crest: Float32Array;
}

export class WallField {
  /** Any wall cell anywhere (lets shaders and uploads skip the field entirely). */
  anyWall = false;

  private readonly bx: number;
  private readonly by: number;
  private readonly sums: Float64Array;
  /** Ground checksums per block (terrain edits such as digging; they do not change the field). */
  private readonly groundSums: Float64Array;
  private edited = false;
  private scanCursor = 0;
  private dirty: Rect | null = null;

  constructor(
    readonly nx: number,
    readonly ny: number,
    private readonly ground: Float32Array,
    private readonly barrier: Float32Array,
    readonly radius = WALL_FIELD_RADIUS,
  ) {
    this.bx = Math.ceil(nx / BLOCK);
    this.by = Math.ceil(ny / BLOCK);
    this.sums = new Float64Array(this.bx * this.by).fill(NaN);
    this.groundSums = new Float64Array(this.bx * this.by).fill(NaN);
  }

  /** True once after any scanned block's walls or ground changed since the previous call. */
  consumeEdits(): boolean {
    const e = this.edited || this.dirty !== null;
    this.edited = false;
    return e;
  }

  /** Scan the whole barrier (and ground) once. */
  scanAll(): void {
    for (let b = 0; b < this.sums.length; b++) this.scanBlock(b, true);
  }

  /** Cyclic incremental scan within a cell budget: edits anywhere are picked up within a fraction of a second. */
  scanSome(cellBudget = 131_072): void {
    const blocks = Math.max(1, Math.floor(cellBudget / (BLOCK * BLOCK)));
    const total = this.sums.length;
    for (let k = 0; k < Math.min(blocks, total); k++) {
      this.scanBlock(this.scanCursor, false);
      this.scanCursor = (this.scanCursor + 1) % total;
    }
  }

  /**
   * Scan every block intersecting a grid-space rectangle now (brush cursor, committed wall), including the ground:
   * terrain brushes (digging) always act under a cursor, so the cyclic scan only has to watch walls.
   */
  scanRect(x0: number, y0: number, x1: number, y1: number): void {
    const bx0 = clampInt(Math.floor(x0 / BLOCK), 0, this.bx - 1);
    const by0 = clampInt(Math.floor(y0 / BLOCK), 0, this.by - 1);
    const bx1 = clampInt(Math.floor(x1 / BLOCK), 0, this.bx - 1);
    const by1 = clampInt(Math.floor(y1 / BLOCK), 0, this.by - 1);
    if (!(x1 >= 0 && y1 >= 0 && x0 <= this.nx && y0 <= this.ny)) return;
    for (let j = by0; j <= by1; j++) for (let i = bx0; i <= bx1; i++) this.scanBlock(j * this.bx + i, true);
  }

  get pending(): boolean {
    return this.dirty !== null;
  }

  /**
   * Recompute the field where the barrier changed: the values over the rectangle that may have changed (to upload;
   * nothing domain-sized is kept on the CPU), or null when nothing changed.
   */
  update(): FieldPatch | null {
    const d = this.dirty;
    if (!d) return null;
    this.dirty = null;
    // A changed cell changes which cells are walls within 1 cell (the half-local-maximum test), outline status and
    // insets within 2, and those outline cells reach radius + 1 further.
    const pad = this.radius + 3;
    const out: Rect = {
      x0: Math.max(0, d.x0 - pad),
      y0: Math.max(0, d.y0 - pad),
      x1: Math.min(this.nx, d.x1 + pad),
      y1: Math.min(this.ny, d.y1 + pad),
    };
    const patch = this.compute(out);
    let any = false;
    for (let b = 0; b < this.sums.length && !any; b++) any = this.sums[b] > 0;
    this.anyWall = any;
    return patch;
  }

  /** Wall-ness of a cell: tall enough, and at least half of the local wall height (so the brush's soft fringe is not). */
  isWallCell(i: number, j: number): boolean {
    const { nx, barrier } = this;
    const b = barrier[j * nx + i];
    if (!(b >= WALL_MIN_HEIGHT)) return false;
    return b >= 0.5 * this.localMax(i, j);
  }

  private localMax(i: number, j: number): number {
    const { nx, ny, barrier } = this;
    let m = 0;
    for (let y = Math.max(0, j - 1); y <= Math.min(ny - 1, j + 1); y++) {
      for (let x = Math.max(0, i - 1); x <= Math.min(nx - 1, i + 1); x++) {
        const v = barrier[y * nx + x];
        if (v > m) m = v;
      }
    }
    return m;
  }

  private scanBlock(b: number, withGround: boolean): void {
    const i0 = (b % this.bx) * BLOCK;
    const j0 = Math.floor(b / this.bx) * BLOCK;
    const i1 = Math.min(this.nx, i0 + BLOCK);
    const j1 = Math.min(this.ny, j0 + BLOCK);
    const { nx, barrier, ground } = this;
    let s = 0;
    for (let j = j0; j < j1; j++) {
      const row = j * nx;
      for (let i = i0; i < i1; i++) {
        const v = barrier[row + i];
        // Weight by position so moving a wall within a block (same total) still changes the checksum.
        if (v > 0) s += v * (1 + ((i - i0) * 31 + (j - j0) * 17) * 1e-3);
      }
    }
    if (withGround) {
      let g = 0;
      for (let j = j0; j < j1; j++) {
        const row = j * nx;
        for (let i = i0; i < i1; i++) g += ground[row + i] * (1 + (i - i0) * 1e-3);
      }
      const prevG = this.groundSums[b];
      this.groundSums[b] = g;
      if (!Number.isNaN(prevG) && prevG !== g) this.edited = true;
    }
    const prev = this.sums[b];
    this.sums[b] = s;
    if (prev === s || (Number.isNaN(prev) && s === 0)) return;
    const d = this.dirty;
    if (!d) this.dirty = { x0: i0, y0: j0, x1: i1, y1: j1 };
    else {
      d.x0 = Math.min(d.x0, i0);
      d.y0 = Math.min(d.y0, j0);
      d.x1 = Math.max(d.x1, i1);
      d.y1 = Math.max(d.y1, j1);
    }
  }

  /**
   * Distance field over `out`, measured to the wall's sub-cell outline rather than to the centres of its raster cells.
   * Distances to cell centres step with the raster: a stroke drawn at a shallow angle is two cells thick here and
   * three there, and the drawn crest, faces and casing would trace those steps. The brush leaves a smooth falloff
   * in the barrier heights along the stroke's edges, so for every outline cell (a wall cell with a non-wall
   * 4-neighbour) the gradient of height / local wall height gives how far past its centre the half-height contour
   * lies (its inset, 0–1 cells; 0.5 for a hard edge). A cell p then gets the distance
   *
   *   min over outline cells c of  |p − c| + 0.5 − inset(c)     (clamped at 0; 0 inside the wall)
   *
   * which equals the exact distance to cell centres for hard-edged axis-aligned walls, and otherwise follows the
   * contour within a small fraction of a cell. Each outline cell stamps its disc of radius + 1 cells.
   */
  private compute(out: Rect): FieldPatch {
    const R = this.radius;
    const { nx, ny, ground, barrier } = this;
    const cap = R + 1;
    const reach = R + 1;
    const w = out.x1 - out.x0;
    const h = out.y1 - out.y0;
    const dist = new Float32Array(w * h).fill(cap);
    const height = new Float32Array(w * h);
    const crest = new Float32Array(w * h);
    // Wall cells that can reach `out`, plus a one-cell border for the outline test.
    const gx0 = Math.max(0, out.x0 - reach);
    const gx1 = Math.min(nx, out.x1 + reach);
    const gy0 = Math.max(0, out.y0 - reach);
    const gy1 = Math.min(ny, out.y1 + reach);
    const mx0 = Math.max(0, gx0 - 1);
    const my0 = Math.max(0, gy0 - 1);
    const mw = Math.min(nx, gx1 + 1) - mx0;
    const mh = Math.min(ny, gy1 + 1) - my0;
    const mask = new Uint8Array(mw * mh);
    let any = false;
    for (let j = 0; j < mh; j++) {
      for (let i = 0; i < mw; i++) {
        if (this.isWallCell(mx0 + i, my0 + j)) {
          mask[j * mw + i] = 1;
          any = true;
        }
      }
    }
    if (!any) return { rect: out, dist, height, crest };
    const wallAt = (i: number, j: number) => {
      const x = i - mx0;
      const y = j - my0;
      return x >= 0 && y >= 0 && x < mw && y < mh && mask[y * mw + x] === 1;
    };
    // Distances of the stamp offsets.
    const side = 2 * reach + 1;
    const disc = new Float32Array(side * side);
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) disc[(dy + reach) * side + dx + reach] = Math.hypot(dx, dy);
    const rel = (x: number, y: number, hLoc: number) => (x < 0 || y < 0 || x >= nx || y >= ny ? 0 : Math.min(1, barrier[y * nx + x] / hLoc));
    for (let j = gy0; j < gy1; j++) {
      for (let i = gx0; i < gx1; i++) {
        if (!wallAt(i, j)) continue;
        const c = j * nx + i;
        const hLoc = this.localMax(i, j);
        const top = ground[c] + barrier[c];
        const inOut = i >= out.x0 && i < out.x1 && j >= out.y0 && j < out.y1;
        if (wallAt(i - 1, j) && wallAt(i + 1, j) && wallAt(i, j - 1) && wallAt(i, j + 1)) {
          if (inOut) {
            const k = (j - out.y0) * w + (i - out.x0);
            dist[k] = 0;
            height[k] = hLoc;
            crest[k] = top;
          }
          continue;
        }
        const v = rel(i, j, hLoc);
        const gx = v - Math.min(rel(i - 1, j, hLoc), rel(i + 1, j, hLoc));
        const gy = v - Math.min(rel(i, j - 1, hLoc), rel(i, j + 1, hLoc));
        const g = Math.hypot(gx, gy);
        const inset = g > 1e-6 ? Math.min(1, Math.max(0, (v - 0.5) / g)) : 0.5;
        const offset = 0.5 - inset;
        const sx0 = Math.max(out.x0, i - reach);
        const sx1 = Math.min(out.x1, i + reach + 1);
        const sy0 = Math.max(out.y0, j - reach);
        const sy1 = Math.min(out.y1, j + reach + 1);
        for (let y = sy0; y < sy1; y++) {
          const drow = (y - j + reach) * side - i + reach;
          const orow = (y - out.y0) * w - out.x0;
          for (let x = sx0; x < sx1; x++) {
            const d = Math.max(0, disc[drow + x] + offset);
            const k = orow + x;
            if (d < dist[k] && d <= R) {
              dist[k] = d;
              height[k] = hLoc;
              crest[k] = top;
            }
          }
        }
      }
    }
    return { rect: out, dist, height, crest };
  }

  /**
   * rgba16float texels for a rectangle: r = proximity 1 − distance/(radius + 1) (so an all-zero texture means "no
   * wall anywhere" and bilinear filtering interpolates distance), g = wall height (m), b = crest elevation (m)
   * relative to elevOrigin (half floats keep ~0.25 m precision over a few hundred metres of relief), a = 0.
   */
  packHalf(patch: FieldPatch, elevOrigin: number): Uint16Array {
    const { rect, dist, height, crest } = patch;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const out = new Uint16Array(w * h * 4);
    const cap = this.radius + 1;
    for (let k = 0; k < w * h; k++) {
      const d = dist[k];
      if (d > this.radius) continue; // zeros
      const o = k * 4;
      out[o] = toHalf(1 - d / cap);
      out[o + 1] = toHalf(height[k]);
      out[o + 2] = toHalf(crest[k] - elevOrigin);
    }
    return out;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
