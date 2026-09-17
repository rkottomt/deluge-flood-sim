/**
 * Wall distance field: for every cell, the distance (cells) to the nearest wall cell within WALL_FIELD_RADIUS, plus
 * that wall's height and crest elevation. The terrain and water shaders draw walls from it with a SCREEN-SPACE
 * minimum width (crest, sunlit / shaded face, dark casing, drop shadow), so a 12 m wide levee still reads as a
 * raised structure from 8 km away, where its real footprint is a couple of pixels.
 *
 * Walls are a raster (the solver's barrier heights), edited by brushes on the CPU mirror. The field is rebuilt
 * incrementally on the CPU: per-block checksums of the barrier mirror are scanned under a cell budget each frame
 * (plus "hot" regions under the brush cursor / a just-committed wall preview, scanned every frame), and only
 * changed blocks — expanded by the radius — are recomputed with an exact bounded 2-pass Euclidean distance
 * transform and uploaded as a sub-rectangle.
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

export class WallField {
  /** Distance (cells) to the nearest wall cell centre, capped at radius + 1. */
  readonly dist: Float32Array;
  /** Height (m) of the nearest wall (0 when none). */
  readonly height: Float32Array;
  /** Crest elevation (m, absolute) of the nearest wall. */
  readonly crest: Float32Array;
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
  // Scratch rows for the transform.
  private hd = new Float32Array(0);
  private hh = new Float32Array(0);
  private hc = new Float32Array(0);

  constructor(
    readonly nx: number,
    readonly ny: number,
    private readonly ground: Float32Array,
    private readonly barrier: Float32Array,
    readonly radius = WALL_FIELD_RADIUS,
  ) {
    const n = nx * ny;
    this.dist = new Float32Array(n).fill(radius + 1);
    this.height = new Float32Array(n);
    this.crest = new Float32Array(n);
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

  /** Scan the whole barrier once (scene load, reset-all). */
  scanAll(): void {
    for (let b = 0; b < this.sums.length; b++) this.scanBlock(b);
  }

  /** Cyclic incremental scan within a cell budget: edits anywhere are picked up within a fraction of a second. */
  scanSome(cellBudget = 131_072): void {
    const blocks = Math.max(1, Math.floor(cellBudget / (BLOCK * BLOCK)));
    const total = this.sums.length;
    for (let k = 0; k < Math.min(blocks, total); k++) {
      this.scanBlock(this.scanCursor);
      this.scanCursor = (this.scanCursor + 1) % total;
    }
  }

  /** Scan every block intersecting a grid-space rectangle now (brush cursor, committed wall). */
  scanRect(x0: number, y0: number, x1: number, y1: number): void {
    const bx0 = clampInt(Math.floor(x0 / BLOCK), 0, this.bx - 1);
    const by0 = clampInt(Math.floor(y0 / BLOCK), 0, this.by - 1);
    const bx1 = clampInt(Math.floor(x1 / BLOCK), 0, this.bx - 1);
    const by1 = clampInt(Math.floor(y1 / BLOCK), 0, this.by - 1);
    if (!(x1 >= 0 && y1 >= 0 && x0 <= this.nx && y0 <= this.ny)) return;
    for (let j = by0; j <= by1; j++) for (let i = bx0; i <= bx1; i++) this.scanBlock(j * this.bx + i);
  }

  get pending(): boolean {
    return this.dirty !== null;
  }

  /**
   * Recompute the field where the barrier changed. Returns the rectangle of cells whose field values changed
   * (to upload), or null when nothing changed.
   */
  update(): Rect | null {
    const d = this.dirty;
    if (!d) return null;
    this.dirty = null;
    const R = this.radius;
    const out: Rect = {
      x0: Math.max(0, d.x0 - R - 1),
      y0: Math.max(0, d.y0 - R - 1),
      x1: Math.min(this.nx, d.x1 + R + 1),
      y1: Math.min(this.ny, d.y1 + R + 1),
    };
    this.compute(out);
    let any = false;
    for (let b = 0; b < this.sums.length && !any; b++) any = this.sums[b] > 0;
    this.anyWall = any;
    return out;
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

  private scanBlock(b: number): void {
    const i0 = (b % this.bx) * BLOCK;
    const j0 = Math.floor(b / this.bx) * BLOCK;
    const i1 = Math.min(this.nx, i0 + BLOCK);
    const j1 = Math.min(this.ny, j0 + BLOCK);
    const { nx, barrier, ground } = this;
    let s = 0;
    let g = 0;
    for (let j = j0; j < j1; j++) {
      const row = j * nx;
      for (let i = i0; i < i1; i++) {
        const v = barrier[row + i];
        // Weight by position so moving a wall within a block (same total) still changes the checksum.
        if (v > 0) s += v * (1 + ((i - i0) * 31 + (j - j0) * 17) * 1e-3);
        g += ground[row + i] * (1 + (i - i0) * 1e-3);
      }
    }
    const prevG = this.groundSums[b];
    this.groundSums[b] = g;
    if (!Number.isNaN(prevG) && prevG !== g) this.edited = true;
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
   * Exact Euclidean distance transform bounded by the radius, over `out`: pass 1 finds the horizontal distance to
   * the nearest wall cell in each row (two sweeps), pass 2 minimises hd(x, y+dy)² + dy² over |dy| ≤ R.
   */
  private compute(out: Rect): void {
    const R = this.radius;
    const { nx, ny, ground, barrier } = this;
    const cap = R + 1;
    const rx0 = Math.max(0, out.x0 - R);
    const rx1 = Math.min(nx, out.x1 + R);
    const ry0 = Math.max(0, out.y0 - R);
    const ry1 = Math.min(ny, out.y1 + R);
    const w = out.x1 - out.x0;
    const rows = ry1 - ry0;
    if (this.hd.length < w * rows) {
      this.hd = new Float32Array(w * rows);
      this.hh = new Float32Array(w * rows);
      this.hc = new Float32Array(w * rows);
    }
    const hd = this.hd;
    const hh = this.hh;
    const hc = this.hc;
    const rowHas = new Uint8Array(rows);
    const rw = rx1 - rx0;
    const lastPos = new Int32Array(rw);
    const isWall = new Uint8Array(rw);
    for (let r = 0; r < rows; r++) {
      const j = ry0 + r;
      let has = false;
      for (let x = rx0; x < rx1; x++) {
        const wall = this.isWallCell(x, j);
        isWall[x - rx0] = wall ? 1 : 0;
        if (wall) has = true;
      }
      const o = r * w;
      if (!has) {
        hd.fill(cap, o, o + w);
        continue;
      }
      rowHas[r] = 1;
      // Left → right: nearest wall at or before x.
      let last = -1_000_000;
      for (let x = rx0; x < rx1; x++) {
        if (isWall[x - rx0]) last = x;
        lastPos[x - rx0] = last;
      }
      for (let x = out.x0; x < out.x1; x++) {
        hd[o + x - out.x0] = Math.min(cap, x - lastPos[x - rx0]);
        hc[o + x - out.x0] = lastPos[x - rx0];
      }
      // Right → left.
      last = 1_000_000;
      for (let x = rx1 - 1; x >= rx0; x--) {
        if (isWall[x - rx0]) last = x;
        if (x >= out.x0 && x < out.x1) {
          const k = o + x - out.x0;
          if (last - x < hd[k]) {
            hd[k] = Math.min(cap, last - x);
            hc[k] = last;
          }
        }
      }
      // Wall height + crest of the chosen wall cell (hc temporarily holds its column).
      for (let x = out.x0; x < out.x1; x++) {
        const k = o + x - out.x0;
        if (hd[k] <= R) {
          const wx = hc[k];
          const b = this.localMax(wx, j);
          hh[k] = b;
          hc[k] = ground[j * nx + wx] + barrier[j * nx + wx];
        } else {
          hh[k] = 0;
          hc[k] = 0;
        }
      }
    }
    // Prefix counts of rows with walls, to skip empty windows.
    const pre = new Int32Array(rows + 1);
    for (let r = 0; r < rows; r++) pre[r + 1] = pre[r] + rowHas[r];
    const { dist, height, crest } = this;
    for (let y = out.y0; y < out.y1; y++) {
      const r = y - ry0;
      const a = Math.max(0, r - R);
      const b = Math.min(rows - 1, r + R);
      const row = y * nx;
      if (pre[b + 1] - pre[a] === 0) {
        dist.fill(cap, row + out.x0, row + out.x1);
        height.fill(0, row + out.x0, row + out.x1);
        crest.fill(0, row + out.x0, row + out.x1);
        continue;
      }
      for (let x = out.x0; x < out.x1; x++) {
        let best = cap * cap;
        let bh = 0;
        let bc = 0;
        const c = x - out.x0;
        for (let rr = a; rr <= b; rr++) {
          if (!rowHas[rr]) continue;
          const h = hd[rr * w + c];
          if (h > R) continue;
          const dy = rr - r;
          const d2 = h * h + dy * dy;
          if (d2 < best) {
            best = d2;
            bh = hh[rr * w + c];
            bc = hc[rr * w + c];
          }
        }
        const dd = Math.sqrt(best);
        dist[row + x] = dd > R ? cap : dd;
        height[row + x] = dd > R ? 0 : bh;
        crest[row + x] = dd > R ? 0 : bc;
      }
    }
  }

  /**
   * rgba16float texels for a rectangle: r = proximity 1 − distance/(radius + 1) (so an all-zero texture means "no
   * wall anywhere" and bilinear filtering interpolates distance), g = wall height (m), b = crest elevation (m)
   * relative to elevOrigin (half floats keep ~0.25 m precision over a few hundred metres of relief), a = 0.
   */
  packHalf(rect: Rect, elevOrigin: number): Uint16Array {
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    const out = new Uint16Array(w * h * 4);
    const { nx, dist, height, crest } = this;
    const cap = this.radius + 1;
    for (let y = 0; y < h; y++) {
      const src = (rect.y0 + y) * nx;
      for (let x = 0; x < w; x++) {
        const s = src + rect.x0 + x;
        const d = dist[s];
        if (d > this.radius) continue; // zeros
        const o = (y * w + x) * 4;
        out[o] = toHalf(1 - d / cap);
        out[o + 1] = toHalf(height[s]);
        out[o + 2] = toHalf(crest[s] - elevOrigin);
      }
    }
    return out;
  }
}

function clampInt(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
