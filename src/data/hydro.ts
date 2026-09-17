/**
 * Hydro-conditioning of hydro-flattened DEMs.
 *
 * USGS 3DEP DEMs are "hydro-flattened": a river is a flat (or gently, monotonically sloping) surface at the
 * water level with no bathymetry, so a simulation would start with dry rivers. We carve ("burn") a channel:
 *
 *   1. Trace the river centerline between hand-placed waypoints with a least-cost path that prefers cells at
 *      or below the interpolated water level (it follows the flat water surface, not the valley floor).
 *   2. Estimate the water-surface profile along that centerline (median filter + monotone non-increasing
 *      downstream via isotonic regression) — or use a known flat pool level.
 *   3. Grow the water region outward from the centerline (multi-source BFS, each cell inheriting the level of
 *      its nearest centerline cell) through cells that are FLAT and within `tolerance` of that level, then add
 *      one ring of shoreline cells that are within tolerance but not flat (bilinear-resampled edges).
 *      Floodplain land is excluded by all three tests: elevation, flatness and connectivity.
 *   4. Lower the bed by `depth` with a smooth bank profile: depth·smoothstep(0, bankCells, d) where d is the
 *      Euclidean distance (cells) to the nearest dry cell.
 *
 * Live areas (no hand-placed waypoints) use `detectWaterBodies`: large flat connected regions whose
 * surroundings are higher (lakes, pools, wide rivers) get a 3 m burn.
 */

export interface GridPoint {
  gx: number;
  gy: number;
}

export interface RiverSpec {
  name: string;
  /** Centerline waypoints in grid coords, ordered UPSTREAM → DOWNSTREAM. At least one. */
  path: GridPoint[];
  /** Burn depth at the channel center, meters. */
  depth: number;
  /** Width of the smooth bank transition, cells. Default 3. */
  bankCells?: number;
  /** Max height above the local water level still considered water, meters. Default 0.3. */
  tolerance?: number;
  /** Max lateral growth distance from the centerline, cells. Default 120. */
  maxHalfWidth?: number;
  /** If set, the river is a flat pool at exactly this level (e.g. a navigation pool). */
  flatLevel?: number;
  /** Radius (cells) to search for the lowest cell when snapping waypoints. Default 5. */
  snapRadius?: number;
}

export interface RiverResult {
  name: string;
  /** Number of cells assigned to this river (first river wins at confluences). */
  cells: number;
  /** Dense centerline in grid coords (cell centers) [gx, gy, ...], upstream → downstream. */
  centerline: Float32Array;
  /** Water-surface level at each centerline vertex, meters. */
  levels: Float32Array;
  minLevel: number;
  maxLevel: number;
  depth: number;
}

export interface BurnResult {
  /** Conditioned elevation (new array). */
  elevation: Float32Array;
  /** 0 = land, k+1 = channel cell belonging to river k. */
  owner: Uint8Array;
  /** Water-surface level per channel cell (NaN on land). */
  waterLevel: Float32Array;
  /** Bed lowering per cell, meters (0 on land). */
  burn: Float32Array;
  /** EDT distance (cells) from each channel cell to the nearest land cell (0 on land). */
  dist: Float32Array;
  burnedCells: number;
  rivers: RiverResult[];
}

export const smoothstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Small data structures
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Binary min-heap of (key, value) with typed arrays; duplicates allowed (lazy deletion by caller). */
export class MinHeap {
  private keys: Float64Array;
  private vals: Int32Array;
  size = 0;
  constructor(capacity = 1024) {
    this.keys = new Float64Array(capacity);
    this.vals = new Int32Array(capacity);
  }
  push(key: number, val: number): void {
    if (this.size === this.keys.length) {
      const k = new Float64Array(this.size * 2);
      const v = new Int32Array(this.size * 2);
      k.set(this.keys);
      v.set(this.vals);
      this.keys = k;
      this.vals = v;
    }
    let i = this.size++;
    const K = this.keys;
    const V = this.vals;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= key) break;
      K[i] = K[p];
      V[i] = V[p];
      i = p;
    }
    K[i] = key;
    V[i] = val;
  }
  /** Key of the top element. */
  peekKey(): number {
    return this.keys[0];
  }
  /** Removes the top element and returns its value. */
  pop(): number {
    const K = this.keys;
    const V = this.vals;
    const top = V[0];
    const n = --this.size;
    if (n > 0) {
      const key = K[n];
      const val = V[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && K[c + 1] < K[c]) c++;
        if (K[c] >= key) break;
        K[i] = K[c];
        V[i] = V[c];
        i = c;
      }
      K[i] = key;
      V[i] = val;
    }
    return top;
  }
}

/**
 * Exact Euclidean distance transform (Felzenszwalb & Huttenlocher). Returns, for every cell, the distance in
 * cells to the nearest cell where `isSite` is true. Cells beyond the grid are not sites.
 */
export function distanceTransform(nx: number, ny: number, isSite: (k: number) => boolean): Float32Array {
  const INF = 1e20;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n);
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  const g = new Float64Array(nx * ny);
  for (let k = 0; k < nx * ny; k++) g[k] = isSite(k) ? 0 : INF;

  const pass = (len: number) => {
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
  };
  // Columns.
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = g[j * nx + i];
    pass(ny);
    for (let j = 0; j < ny; j++) g[j * nx + i] = d[j];
  }
  // Rows.
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = g[j * nx + i];
    pass(nx);
    for (let i = 0; i < nx; i++) out[j * nx + i] = Math.sqrt(Math.min(d[i], INF));
  }
  return out;
}

/** Max absolute elevation difference to the 4 neighbors (edge cells use available neighbors). */
export function localRelief(elev: Float32Array, nx: number, ny: number): Float32Array {
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const z = elev[k];
      let m = 0;
      if (i > 0) m = Math.max(m, Math.abs(elev[k - 1] - z));
      if (i < nx - 1) m = Math.max(m, Math.abs(elev[k + 1] - z));
      if (j > 0) m = Math.max(m, Math.abs(elev[k - nx] - z));
      if (j < ny - 1) m = Math.max(m, Math.abs(elev[k + nx] - z));
      out[k] = m;
    }
  }
  return out;
}

/** 3×3 box blur (edge cells average their in-grid neighbors). */
export function boxBlur3(src: Float32Array, nx: number, ny: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < ny; j++) {
    const row = j * nx;
    for (let i = 0; i < nx; i++) {
      let s = src[row + i];
      let c = 1;
      if (i > 0) {
        s += src[row + i - 1];
        c++;
      }
      if (i < nx - 1) {
        s += src[row + i + 1];
        c++;
      }
      tmp[row + i] = s / c;
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let s = tmp[k];
      let c = 1;
      if (j > 0) {
        s += tmp[k - nx];
        c++;
      }
      if (j < ny - 1) {
        s += tmp[k + nx];
        c++;
      }
      out[k] = s / c;
    }
  }
  return out;
}

/** Flatness threshold for water surfaces: ~0.4 % slope, at least 3 cm per cell. */
export function flatThreshold(cellSize: number): number {
  return Math.max(0.03, 0.004 * cellSize);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Centerline tracing
// ──────────────────────────────────────────────────────────────────────────────────────────────

const clampI = (v: number, n: number) => Math.min(n - 1, Math.max(0, Math.floor(v)));

/**
 * Snap a point to the lowest cell within `radius` cells, preferring flat (water-like) cells: non-flat cells are
 * penalized by 1 m so a waypoint beside a river snaps onto the water surface rather than into a ditch.
 */
export function snapToLowest(
  elev: Float32Array,
  nx: number,
  ny: number,
  p: GridPoint,
  radius: number,
  relief?: Float32Array,
  flatTol = Infinity,
): number {
  const ci = clampI(p.gx, nx);
  const cj = clampI(p.gy, ny);
  let best = cj * nx + ci;
  let bestZ = Infinity;
  let bestD = Infinity;
  for (let dj = -radius; dj <= radius; dj++) {
    for (let di = -radius; di <= radius; di++) {
      const d2 = di * di + dj * dj;
      if (d2 > radius * radius) continue;
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = j * nx + i;
      const z = elev[k] + (relief && relief[k] > flatTol ? 1 : 0);
      if (z < bestZ - 1e-3 || (Math.abs(z - bestZ) <= 1e-3 && d2 < bestD)) {
        best = k;
        bestZ = z;
        bestD = d2;
      }
    }
  }
  return best;
}

/**
 * Least-cost 8-connected path between two cells that prefers cells at or below the water level interpolated
 * between the endpoints' levels. Returns cell indices from a to b (inclusive).
 */
export function traceChannel(
  elev: Float32Array,
  nx: number,
  ny: number,
  a: number,
  b: number,
  levelA: number,
  levelB: number,
): number[] {
  const ai = a % nx;
  const aj = (a / nx) | 0;
  const bi = b % nx;
  const bj = (b / nx) | 0;
  const segLen = Math.hypot(bi - ai, bj - aj);
  const margin = Math.max(40, Math.ceil(segLen * 0.6));
  const i0 = Math.max(0, Math.min(ai, bi) - margin);
  const i1 = Math.min(nx - 1, Math.max(ai, bi) + margin);
  const j0 = Math.max(0, Math.min(aj, bj) - margin);
  const j1 = Math.min(ny - 1, Math.max(aj, bj) + margin);
  const w = i1 - i0 + 1;
  const h = j1 - j0 + 1;
  const dist = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  const heap = new MinHeap(4096);
  const local = (k: number) => (((k / nx) | 0) - j0) * w + ((k % nx) - i0);
  const dx = bi - ai;
  const dy = bj - aj;
  const len2 = Math.max(1e-9, dx * dx + dy * dy);
  const KAPPA = 25; // cost multiplier per meter above the interpolated water level
  const cellCost = (i: number, j: number) => {
    const t = Math.min(1, Math.max(0, ((i - ai) * dx + (j - aj) * dy) / len2));
    const lvl = levelA + (levelB - levelA) * t;
    const above = Math.max(0, elev[j * nx + i] - lvl - 0.05);
    return 1 + KAPPA * above;
  };
  dist[local(a)] = 0;
  heap.push(0, local(a));
  const target = local(b);
  const DI = [1, -1, 0, 0, 1, 1, -1, -1];
  const DJ = [0, 0, 1, -1, 1, -1, 1, -1];
  while (heap.size > 0) {
    const key = heap.peekKey();
    const u = heap.pop();
    if (key > dist[u]) continue;
    if (u === target) break;
    const ui = (u % w) + i0;
    const uj = ((u / w) | 0) + j0;
    const cu = cellCost(ui, uj);
    for (let s = 0; s < 8; s++) {
      const vi = ui + DI[s];
      const vj = uj + DJ[s];
      if (vi < i0 || vi > i1 || vj < j0 || vj > j1) continue;
      const v = (vj - j0) * w + (vi - i0);
      const step = s < 4 ? 1 : Math.SQRT2;
      const nd = key + step * 0.5 * (cu + cellCost(vi, vj));
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }
  const out: number[] = [];
  for (let u = target; u !== -1; u = prev[u]) out.push(((u / w) | 0) * nx + j0 * nx + (u % w) + i0);
  out.reverse();
  return out;
}

/** Median filter of radius r over a 1-D array. */
function median1d(src: ArrayLike<number>, r: number): Float64Array {
  const n = src.length;
  const out = new Float64Array(n);
  const buf: number[] = [];
  for (let k = 0; k < n; k++) {
    buf.length = 0;
    for (let q = Math.max(0, k - r); q <= Math.min(n - 1, k + r); q++) buf.push(src[q]);
    buf.sort((x, y) => x - y);
    out[k] = buf[buf.length >> 1];
  }
  return out;
}

/** Weighted isotonic regression (pool adjacent violators) producing a NON-INCREASING sequence. */
export function monotoneNonIncreasing(values: ArrayLike<number>, weights?: ArrayLike<number>): Float64Array {
  const n = values.length;
  const mean: number[] = [];
  const wsum: number[] = [];
  const count: number[] = [];
  for (let k = 0; k < n; k++) {
    mean.push(values[k]);
    wsum.push(Math.max(weights ? weights[k] : 1, 1e-9));
    count.push(1);
    while (mean.length > 1 && mean[mean.length - 2] < mean[mean.length - 1]) {
      const m2 = mean.pop()!;
      const w2 = wsum.pop()!;
      const c2 = count.pop()!;
      const m1 = mean.pop()!;
      const w1 = wsum.pop()!;
      const c1 = count.pop()!;
      mean.push((m1 * w1 + m2 * w2) / (w1 + w2));
      wsum.push(w1 + w2);
      count.push(c1 + c2);
    }
  }
  const out = new Float64Array(n);
  let o = 0;
  for (let b = 0; b < mean.length; b++) for (let c = 0; c < count[b]; c++) out[o++] = mean[b];
  return out;
}

/**
 * Water-surface profile along a traced centerline: median filter, then a weighted monotone (non-increasing
 * downstream) fit where non-flat cells count little and cells far above the fit (bridge decks, banks where the
 * path cut a corner) are rejected iteratively.
 */
export function riverLevelProfile(z: ArrayLike<number>, flat: ArrayLike<boolean>): Float64Array {
  const n = z.length;
  const zm = median1d(z, 6);
  const w = new Float64Array(n);
  for (let k = 0; k < n; k++) w[k] = flat[k] ? 1 : 0.05;
  let L = monotoneNonIncreasing(zm, w);
  for (let iter = 0; iter < 4; iter++) {
    let changed = false;
    for (let k = 0; k < n; k++) {
      const r = zm[k] - L[k];
      if (w[k] > 0.001 && (r > 0.4 || r < -1.5)) {
        w[k] = 0.001;
        changed = true;
      }
    }
    if (!changed) break;
    L = monotoneNonIncreasing(zm, w);
  }
  return L;
}

/** Local water-surface slope (m per cell of path) along a level profile. */
function profileSlope(levels: ArrayLike<number>, cells: number[], nx: number, half = 8): Float32Array {
  const n = levels.length;
  const out = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - half);
    const b = Math.min(n - 1, k + half);
    if (a === b) continue;
    const ka = cells[a];
    const kb = cells[b];
    const len = Math.max(1, Math.hypot((ka % nx) - (kb % nx), ((ka / nx) | 0) - ((kb / nx) | 0)));
    out[k] = Math.abs(levels[a] - levels[b]) / len;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Channel burning
// ──────────────────────────────────────────────────────────────────────────────────────────────

export function burnRivers(
  elevation: Float32Array,
  nx: number,
  ny: number,
  cellSize: number,
  specs: RiverSpec[],
): BurnResult {
  const n = nx * ny;
  const elev = elevation; // read-only source
  const relief = localRelief(elev, nx, ny);
  const flatTol = flatThreshold(cellSize);
  const owner = new Uint8Array(n);
  const waterLevel = new Float32Array(n).fill(NaN);
  const depthOf = new Float32Array(n);
  const bankOf = new Float32Array(n);
  const rivers: RiverResult[] = [];

  // 1–2. Centerlines and level profiles for every river.
  const centerCells: number[][] = [];
  const centerLevels: Float64Array[] = [];
  const centerSlopes: Float32Array[] = [];
  specs.forEach((spec) => {
    const snapR = spec.snapRadius ?? 5;
    const wp = spec.path.map((p) => snapToLowest(elev, nx, ny, p, snapR, relief, flatTol));
    let cells: number[] = [wp[0]];
    for (let s = 1; s < wp.length; s++) {
      const la = spec.flatLevel ?? elev[wp[s - 1]];
      const lb = spec.flatLevel ?? elev[wp[s]];
      cells = cells.concat(traceChannel(elev, nx, ny, wp[s - 1], wp[s], la, lb).slice(1));
    }
    const levels =
      spec.flatLevel !== undefined
        ? new Float64Array(cells.length).fill(spec.flatLevel)
        : riverLevelProfile(
            cells.map((k) => elev[k]),
            cells.map((k) => relief[k] <= flatTol),
          );
    centerCells.push(cells);
    centerLevels.push(levels);
    centerSlopes.push(profileSlope(levels, cells, nx));
  });

  // 3. Joint multi-source BFS from all centerlines: each water cell belongs to (and takes the level and local
  //    surface slope of) the geodesically nearest centerline cell, so confluences split cleanly between rivers.
  const queue = new Int32Array(n);
  const hops = new Uint16Array(n);
  const slopeOf = new Float32Array(n);
  let qh = 0;
  let qt = 0;
  specs.forEach((_, r) => {
    centerCells[r].forEach((k, idx) => {
      if (owner[k]) return;
      owner[k] = r + 1;
      waterLevel[k] = centerLevels[r][idx];
      slopeOf[k] = centerSlopes[r][idx];
      queue[qt++] = k;
    });
  });
  const tolOf = specs.map((s) => s.tolerance ?? 0.3);
  const hwOf = specs.map((s) => s.maxHalfWidth ?? 120);
  const nb4 = (k: number, out: Int32Array) => {
    const i = k % nx;
    const j = (k / nx) | 0;
    out[0] = i > 0 ? k - 1 : -1;
    out[1] = i < nx - 1 ? k + 1 : -1;
    out[2] = j > 0 ? k - nx : -1;
    out[3] = j < ny - 1 ? k + nx : -1;
  };
  const nb = new Int32Array(4);
  while (qh < qt) {
    const k = queue[qh++];
    const r = owner[k] - 1;
    const L = waterLevel[k];
    const sl = slopeOf[k];
    if (hops[k] + 1 > hwOf[r]) continue;
    nb4(k, nb);
    for (let q = 0; q < 4; q++) {
      const m = nb[q];
      if (m < 0 || owner[m]) continue;
      // Water must be within tolerance of the local level AND flat (relative to the river's own surface
      // slope) — except cells hugging the level itself, which lets the fill squeeze through narrow side
      // channels whose cells all touch a bank.
      if (elev[m] > L + tolOf[r] + 2 * sl) continue;
      if (relief[m] > Math.max(flatTol, 2.5 * sl + 0.01) && elev[m] > L + Math.min(tolOf[r], 0.2) + sl) continue;
      owner[m] = r + 1;
      waterLevel[m] = L;
      slopeOf[m] = sl;
      hops[m] = hops[k] + 1;
      queue[qt++] = m;
    }
  }
  // Shoreline ring: non-flat cells adjacent to the water that are still within tolerance of its level.
  for (let q = 0; q < qt; q++) {
    const k = queue[q];
    const r = owner[k] - 1;
    nb4(k, nb);
    for (let s = 0; s < 4; s++) {
      const m = nb[s];
      if (m < 0 || owner[m]) continue;
      if (elev[m] <= waterLevel[k] + tolOf[r] + 2 * slopeOf[k]) {
        owner[m] = r + 1;
        waterLevel[m] = waterLevel[k];
      }
    }
  }

  fillSmallHoles(owner, waterLevel, nx, ny, 8);

  // A cell far below its inherited level (steep reach, weir, or a profile outlier) would start with an
  // artificial pond on top of it; cap the local water surface at 0.5 m above the DEM surface there.
  for (let k = 0; k < n; k++) {
    if (owner[k] && waterLevel[k] > elev[k] + 0.5) waterLevel[k] = elev[k] + 0.5;
  }

  // Per-cell depth / bank width, smoothed across confluences so beds don't step where rivers meet.
  for (let k = 0; k < n; k++) {
    if (!owner[k]) continue;
    const spec = specs[owner[k] - 1];
    depthOf[k] = spec.depth;
    bankOf[k] = spec.bankCells ?? 3;
  }
  if (specs.length > 1) {
    maskedBlur(depthOf, owner, nx, ny, 6);
    maskedBlur(bankOf, owner, nx, ny, 6);
    maskedBlur(waterLevel, owner, nx, ny, 3);
  }

  specs.forEach((spec, r) => {
    const cells = centerCells[r];
    const levels = centerLevels[r];
    let count = 0;
    for (let k = 0; k < n; k++) if (owner[k] === r + 1) count++;
    const cl = new Float32Array(cells.length * 2);
    cells.forEach((k, idx) => {
      cl[idx * 2] = (k % nx) + 0.5;
      cl[idx * 2 + 1] = ((k / nx) | 0) + 0.5;
    });
    let minL = Infinity;
    let maxL = -Infinity;
    for (const v of levels) {
      minL = Math.min(minL, v);
      maxL = Math.max(maxL, v);
    }
    rivers.push({
      name: spec.name,
      cells: count,
      centerline: cl,
      levels: Float32Array.from(levels),
      minLevel: minL,
      maxLevel: maxL,
      depth: spec.depth,
    });
  });


  // 4. Burn with smooth banks.
  const dist = distanceTransform(nx, ny, (k) => owner[k] === 0);
  const out = new Float32Array(elev);
  const burn = new Float32Array(n);
  let burned = 0;
  for (let k = 0; k < n; k++) {
    if (!owner[k]) {
      dist[k] = 0;
      continue;
    }
    const b = depthOf[k] * smoothstep(0, bankOf[k], dist[k]);
    const bed = Math.min(elev[k], waterLevel[k]) - b;
    burn[k] = elev[k] - bed;
    out[k] = bed;
    burned++;
  }
  return { elevation: out, owner, waterLevel, burn, dist, burnedCells: burned, rivers };
}

/** Separable box blur of `field` restricted to cells where mask ≠ 0 (normalized by in-mask weight). */
export function maskedBlur(field: Float32Array, mask: Uint8Array, nx: number, ny: number, radius: number): void {
  const tmp = new Float32Array(field.length);
  const pass = (horizontal: boolean) => {
    const len = horizontal ? nx : ny;
    const lines = horizontal ? ny : nx;
    for (let a = 0; a < lines; a++) {
      let sum = 0;
      let cnt = 0;
      const idx = (t: number) => (horizontal ? a * nx + t : t * nx + a);
      // sliding window over [t - radius, t + radius]
      for (let t = -radius; t < len; t++) {
        const add = t + radius;
        if (add < len) {
          const k = idx(add);
          if (mask[k]) {
            sum += field[k];
            cnt++;
          }
        }
        const rem = t - radius - 1;
        if (rem >= 0) {
          const k = idx(rem);
          if (mask[k]) {
            sum -= field[k];
            cnt--;
          }
        }
        if (t >= 0) {
          const k = idx(t);
          tmp[k] = mask[k] && cnt > 0 ? sum / cnt : field[k];
        }
      }
    }
    field.set(tmp);
  };
  pass(true);
  pass(false);
}

/**
 * Fill enclosed land pockets of at most `maxCells` cells inside channel masks (lidar speckle, bridge-pier
 * artifacts). Real islands are larger and are kept.
 */
export function fillSmallHoles(owner: Uint8Array, waterLevel: Float32Array, nx: number, ny: number, maxCells: number): number {
  const seen = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const comp: number[] = [];
  let filled = 0;
  for (let s = 0; s < nx * ny; s++) {
    if (owner[s] || seen[s]) continue;
    comp.length = 0;
    stack.push(s);
    seen[s] = 1;
    let touchesEdge = false;
    let big = false;
    let ownerNb = 0;
    let levelNb = NaN;
    while (stack.length) {
      const k = stack.pop()!;
      if (!big) comp.push(k);
      if (comp.length > maxCells) big = true;
      const i = k % nx;
      const j = (k / nx) | 0;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) touchesEdge = true;
      const nb = [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, j > 0 ? k - nx : -1, j < ny - 1 ? k + nx : -1];
      for (const m of nb) {
        if (m < 0) continue;
        if (owner[m]) {
          ownerNb = owner[m];
          levelNb = waterLevel[m];
          continue;
        }
        if (!seen[m]) {
          seen[m] = 1;
          stack.push(m);
        }
      }
    }
    if (!big && !touchesEdge && ownerNb) {
      for (const k of comp) {
        owner[k] = ownerNb;
        waterLevel[k] = levelNb;
        filled++;
      }
    }
  }
  return filled;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Source placement helpers
// ──────────────────────────────────────────────────────────────────────────────────────────────

export type DomainEdge = 'north' | 'south' | 'west' | 'east';

/** Largest distance (cells) a boundary stage disc reaches into the domain. */
export const STAGE_DISC_MAX_PENETRATION = 32;

/**
 * Footprint of a STAGE source that holds the water level along a whole edge crossing of a river or lake: the run of
 * wet edge cells t0…t1 (inclusive, cell indices along the edge). A stage source is a boundary condition: every
 * boundary cell of the crossing must lie inside the disc, otherwise the open (free-outflow) boundary drains the
 * uncovered part and the river draws down toward the edge with spurious fast flow.
 *
 * Narrow crossings get a disc centred on the edge itself. For wide or oblique crossings a disc that spans the chord
 * would reach deep into the domain (and at a raised stage impose the level on land far from the boundary), so the
 * centre moves OUTSIDE the domain: the disc then cuts the crossing as a shallow lens reaching at most
 * `maxPenetration` cells inward. Footprint cells outside the domain simply don't exist for the solver.
 */
export function edgeStageDisc(
  edge: DomainEdge,
  t0: number,
  t1: number,
  nx: number,
  ny: number,
  maxPenetration = STAGE_DISC_MAX_PENETRATION,
): { gx: number; gy: number; radius: number } {
  // Half chord that must be fully covered at the first row of cell centres (+1.5 cells so the smooth rim of the
  // footprint lies beyond the crossing's last wet cell).
  const half = (t1 - t0 + 1) / 2 + 1.5;
  const mid = (t0 + t1 + 1) / 2;
  const P = Math.max(4, maxPenetration);
  // Disc centre at distance d outside the edge: radius R with R − d = penetration p and R² = half² + d².
  let d = 0;
  let R = half;
  if (half > P) {
    d = (half * half - P * P) / (2 * P);
    R = P + d;
  }
  // Full footprint weight needs distance ≤ R − 0.5 at the row of cell centres 0.5 inside the edge.
  R = Math.sqrt(half * half + (d + 0.5) * (d + 0.5)) + 0.5;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  switch (edge) {
    case 'north':
      return { gx: r2(mid), gy: r2(-d), radius: r2(R) };
    case 'south':
      return { gx: r2(mid), gy: r2(ny + d), radius: r2(R) };
    case 'west':
      return { gx: r2(-d), gy: r2(mid), radius: r2(R) };
    default:
      return { gx: r2(nx + d), gy: r2(mid), radius: r2(R) };
  }
}

/**
 * Runs of consecutive cells along one domain edge for which `wet(k)` holds (k = row-major cell index), as
 * inclusive [t0, t1] positions along the edge (x for north/south, y for west/east).
 */
export function edgeRuns(edge: DomainEdge, nx: number, ny: number, wet: (k: number) => boolean): Array<[number, number]> {
  const len = edge === 'north' || edge === 'south' ? nx : ny;
  const cell = (t: number) => edgeCell(edge, t, nx, ny);
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let t = 0; t <= len; t++) {
    const on = t < len && wet(cell(t));
    if (on && start < 0) start = t;
    if (!on && start >= 0) {
      runs.push([start, t - 1]);
      start = -1;
    }
  }
  return runs;
}

/** Row-major index of the t-th cell along a domain edge (west→east for north/south, north→south for west/east). */
export function edgeCell(edge: DomainEdge, t: number, nx: number, ny: number): number {
  return edge === 'north' ? t : edge === 'south' ? (ny - 1) * nx + t : edge === 'west' ? t * nx : t * nx + nx - 1;
}

/**
 * Widen an edge crossing t0…t1 along the edge while `floodable(k)` holds for the next edge cell — callers pass
 * "bed below the highest stage the slider allows, and either part of the water body or not below its normal
 * surface" — i.e. the cross-section the crossing grows to at the top of the slider. A stage disc sized from the
 * normal-pool crossing leaves the overbank cells beside it on the open boundary at a raised stage; that boundary
 * drains them, so the surface drops metres within a few cells of the disc rim and water jets out at the velocity
 * cap. (Cells below the normal surface that are NOT part of the water body — land behind a levee — stop the growth:
 * the disc would fill them at load.)
 */
export function growEdgeRun(
  edge: DomainEdge,
  t0: number,
  t1: number,
  nx: number,
  ny: number,
  floodable: (k: number) => boolean,
): [number, number] {
  const len = edge === 'north' || edge === 'south' ? nx : ny;
  let a = t0;
  let b = t1;
  while (a > 0 && floodable(edgeCell(edge, a - 1, nx, ny))) a--;
  while (b < len - 1 && floodable(edgeCell(edge, b + 1, nx, ny))) b++;
  return [a, b];
}

export interface RiverEnd {
  river: number;
  /** Which end of the traced centerline: 'upstream' (inflow) or 'downstream' (outflow). */
  end: 'upstream' | 'downstream';
  edge: 'north' | 'south' | 'west' | 'east';
  /** Channel-spine point just inside the domain edge, grid coords. */
  gx: number;
  gy: number;
  /** Footprint radius (cells) that fits inside both the channel and the domain. */
  radius: number;
  /** Local water-surface level, m. */
  level: number;
}

/**
 * For each river whose traced centerline starts/ends within `edgeReach` cells of the domain boundary, find the
 * best source location near that edge: the channel cell that fits the largest footprint (≤ maxRadius) fully
 * inside the channel and the domain, preferring cells close to the edge.
 */
export function findRiverEnds(res: BurnResult, nx: number, ny: number, maxRadius = 12, edgeReach = 16): RiverEnd[] {
  const out: RiverEnd[] = [];
  res.rivers.forEach((river, r) => {
    const cl = river.centerline;
    const npts = cl.length / 2;
    if (npts === 0) return;
    const ends: Array<{ end: RiverEnd['end']; gx: number; gy: number }> = [
      { end: 'upstream', gx: cl[0], gy: cl[1] },
      { end: 'downstream', gx: cl[(npts - 1) * 2], gy: cl[(npts - 1) * 2 + 1] },
    ];
    for (const e of ends) {
      const dN = e.gy;
      const dS = ny - e.gy;
      const dW = e.gx;
      const dE = nx - e.gx;
      const dMin = Math.min(dN, dS, dW, dE);
      if (dMin > edgeReach) continue;
      const edge: RiverEnd['edge'] = dMin === dN ? 'north' : dMin === dS ? 'south' : dMin === dW ? 'west' : 'east';
      const R = 48;
      let best = -1;
      let bestScore = -Infinity;
      let bestRadius = 0;
      const ci = Math.floor(e.gx);
      const cj = Math.floor(e.gy);
      for (let j = Math.max(0, cj - R); j <= Math.min(ny - 1, cj + R); j++) {
        for (let i = Math.max(0, ci - R); i <= Math.min(nx - 1, ci + R); i++) {
          const k = j * nx + i;
          if (res.owner[k] !== r + 1) continue;
          const toEdge = Math.min(i + 0.5, nx - i - 0.5, j + 0.5, ny - j - 0.5);
          const radius = Math.min(maxRadius, res.dist[k] * 0.85, toEdge - 1);
          if (radius < 1) continue;
          const score = radius - 0.06 * toEdge - 0.02 * Math.hypot(i + 0.5 - e.gx, j + 0.5 - e.gy);
          if (score > bestScore) {
            bestScore = score;
            best = k;
            bestRadius = radius;
          }
        }
      }
      if (best < 0) continue;
      out.push({
        river: r,
        end: e.end,
        edge,
        gx: (best % nx) + 0.5,
        gy: ((best / nx) | 0) + 0.5,
        radius: Math.max(1.5, bestRadius),
        level: res.waterLevel[best],
      });
    }
  });
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Automatic water-body detection (live areas)
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface WaterBody {
  /** Median water-surface elevation, m. */
  level: number;
  /** Lowest and highest surface elevation — they differ for gently sloping rivers, m. */
  minLevel: number;
  maxLevel: number;
  cells: number;
  /** A representative interior cell (max distance to shore), grid coords. */
  seed: GridPoint;
  /** Initial-fill seeds spread over the body, each carrying the local surface level. */
  seeds: Array<GridPoint & { level: number }>;
  /** Cell indices of the body (flat core + shoreline ring). */
  indices: Int32Array;
  /** Local water-surface level for each entry of `indices`, m. */
  levels: Float32Array;
  /** True if the body reaches the domain boundary (a river flowing through, or a lake cut by the edge). */
  touchesEdge: boolean;
}

export interface DetectOptions {
  /** Minimum area, m². Default 20 000 m² (≈ 2 ha). */
  minArea?: number;
  /** Max elevation spread allowed for a still water body, m. Default 0.15. */
  maxSpread?: number;
  /** Max overall surface gradient for a sloping (river) body, m per m. Default 0.002 (2 m/km). */
  maxGradient?: number;
  /** Fraction of the cells just beyond the shoreline that must be ≥ local level + 0.25 m. Default 0.7. */
  minRimHigher?: number;
  /** Shoreline tolerance: ring cells within ± this of the adjacent surface level join the body, m. Default 0.3. */
  tolerance?: number;
  /** Diagnostics: called for every flat component large enough to be considered, with the verdict. */
  onCandidate?: (info: {
    cells: number;
    level: number;
    spread: number;
    allowedSpread: number;
    /** Fractions of the rim just beyond the shoreline that are ≥ +0.25 m / below −0.25 m of the local level. */
    rimHigher: number;
    rimLower: number;
    accepted: boolean;
    bbox: [number, number, number, number];
  }) => void;
}

/**
 * Detect likely water bodies in a hydro-flattened DEM: large 4-connected regions of flat cells (a water surface
 * is flat or very gently sloping), plus up to two rings of shoreline cells near the surface level, whose
 * surroundings just beyond the shoreline are mostly higher (a local minimum — rejects flat fields, roofs and
 * hilltop parking lots). Handles lakes, reservoirs, navigation pools and gently sloping rivers.
 */
export function detectWaterBodies(
  elev: Float32Array,
  nx: number,
  ny: number,
  cellSize: number,
  opts: DetectOptions = {},
): WaterBody[] {
  const n = nx * ny;
  // Flatness is judged on a 3×3-smoothed surface: some 3DEP source layers serve rivers with centimeter noise or a
  // tilt (≈ 1 cm per 6 m cell on Pittsburgh's rivers at 5.9 m pixels) instead of a perfectly flat breakline
  // surface. After smoothing, water is flat or a tilted PLANE (~zero Laplacian) while bare-earth land essentially
  // never is (measured < 0.25 % of land cells on Pittsburgh, Harrisburg, New Orleans, Johnstown and Ellicott
  // City DEMs). A cell is "water-flat" if its relief ≤ flatTol, or its |Laplacian| ≤ 4 mm with slope ≤ 0.4 %.
  const smooth = boxBlur3(elev, nx, ny);
  const relief = localRelief(smooth, nx, ny);
  const flatTol = Math.max(0.01, 0.0015 * cellSize);
  const slopeTol = Math.max(flatTol, 0.004 * cellSize);
  const isFlat = new Uint8Array(n);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (relief[k] <= flatTol) {
        isFlat[k] = 1;
        continue;
      }
      if (relief[k] > slopeTol || i === 0 || j === 0 || i === nx - 1 || j === ny - 1) continue;
      const lap = Math.abs(smooth[k - 1] + smooth[k + 1] + smooth[k - nx] + smooth[k + nx] - 4 * smooth[k]);
      if (lap <= 0.004) isFlat[k] = 1;
    }
  }
  const minCells = Math.max(30, Math.ceil((opts.minArea ?? 20000) / (cellSize * cellSize)));
  const maxSpread = opts.maxSpread ?? 0.15;
  const maxGradient = opts.maxGradient ?? 0.002;
  const minRim = opts.minRimHigher ?? 0.7;
  const tol = opts.tolerance ?? 0.3;
  const label = new Int32Array(n).fill(-1); // flat-component id
  const inBody = new Int32Array(n); // accepted body id + 1
  const inSet = new Int32Array(n).fill(-1); // candidate id currently being evaluated (core + ring)
  const levelOf = new Float32Array(n);
  const stack = new Int32Array(n);
  const nb = new Int32Array(4);
  const nb4 = (k: number) => {
    const i = k % nx;
    const j = (k / nx) | 0;
    nb[0] = i > 0 ? k - 1 : -1;
    nb[1] = i < nx - 1 ? k + 1 : -1;
    nb[2] = j > 0 ? k - nx : -1;
    nb[3] = j < ny - 1 ? k + nx : -1;
  };
  // Pass 1: label every flat component (4-connected cells whose neighbor steps are within flatTol) and record
  // its size and bounding box. Knowing all components up front lets the rim test treat a boundary with another
  // substantial flat surface (the next reach of a river, just above or below a riffle or dam) as neutral.
  const startOf: number[] = [];
  const sizeOf: number[] = [];
  const bboxOf: Array<[number, number, number, number]> = [];
  for (let s = 0; s < n; s++) {
    if (label[s] !== -1 || !isFlat[s]) continue;
    const lab = startOf.length;
    startOf.push(s);
    let size = 0;
    let sp = 0;
    stack[sp++] = s;
    label[s] = lab;
    let i0 = nx;
    let i1 = 0;
    let j0 = ny;
    let j1 = 0;
    while (sp > 0) {
      const k = stack[--sp];
      size++;
      const ci = k % nx;
      const cj = (k / nx) | 0;
      if (ci < i0) i0 = ci;
      if (ci > i1) i1 = ci;
      if (cj < j0) j0 = cj;
      if (cj > j1) j1 = cj;
      const z = smooth[k];
      nb4(k);
      for (let q = 0; q < 4; q++) {
        const m = nb[q];
        if (m < 0 || label[m] !== -1 || !isFlat[m]) continue;
        if (Math.abs(smooth[m] - z) > slopeTol) continue;
        label[m] = lab;
        stack[sp++] = m;
      }
    }
    sizeOf.push(size);
    bboxOf.push([i0, j0, i1, j1]);
  }
  const neutralSize = Math.max(15, minCells / 2);

  // Pass 2: evaluate large components, biggest first. Cells of bodies already accepted are neutral in the rim
  // test; a rejected component that nothing drains out of and that touches an accepted body (the next reach of
  // the same river) is re-evaluated with a relaxed rim requirement until nothing changes.
  const bodies: WaterBody[] = [];
  const comp: number[] = [];
  let mark = 0;
  const bfsMark = new Int32Array(n);
  let bfsStamp = 0;
  const bfsQueue = new Int32Array(256);
  /** True if an accepted body is within `reach` 4-steps of cell k (the drain path of a riffle into it). */
  const nearAcceptedBody = (k: number, setId: number, reach: number): boolean => {
    const stamp = ++bfsStamp;
    let head = 0;
    let tail = 0;
    const depth: number[] = [];
    bfsQueue[tail++] = k;
    depth.push(0);
    bfsMark[k] = stamp;
    while (head < tail) {
      const c = bfsQueue[head];
      const dd = depth[head++];
      if (inBody[c]) return true;
      if (dd >= reach) continue;
      const ci = c % nx;
      const cj = (c / nx) | 0;
      const nbs = [ci > 0 ? c - 1 : -1, ci < nx - 1 ? c + 1 : -1, cj > 0 ? c - nx : -1, cj < ny - 1 ? c + nx : -1];
      for (const m of nbs) {
        if (m < 0 || bfsMark[m] === stamp || inSet[m] === setId || tail >= bfsQueue.length) continue;
        bfsMark[m] = stamp;
        bfsQueue[tail++] = m;
        depth.push(dd + 1);
      }
    }
    return false;
  };
  const evaluate = (lab: number, relaxed: boolean): 'accepted' | 'rejected' | 'retry' => {
    const [i0, j0, i1, j1] = bboxOf[lab];
    const id = ++mark;
    comp.length = 0;
    const s0 = startOf[lab];
    let sp = 0;
    // Gather the component's cells (any cell of it not already claimed by an accepted body).
    for (let q = 0, start = -1; q < 1 && start < 0; q++) {
      if (!inBody[s0]) start = s0;
      if (start >= 0) {
        stack[sp++] = start;
        inSet[start] = id;
      }
    }
    if (sp === 0) {
      // The seed cell was claimed by another body's shoreline; find any unclaimed cell in the bbox.
      for (let j = j0; j <= j1 && sp === 0; j++) {
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          if (label[k] === lab && !inBody[k]) {
            stack[sp++] = k;
            inSet[k] = id;
            break;
          }
        }
      }
    }
    while (sp > 0) {
      const k = stack[--sp];
      comp.push(k);
      nb4(k);
      for (let q = 0; q < 4; q++) {
        const m = nb[q];
        if (m < 0 || label[m] !== lab || inSet[m] === id || inBody[m]) continue;
        inSet[m] = id;
        stack[sp++] = m;
      }
    }
    if (comp.length < minCells) return 'rejected';

    // Surface statistics (sampled for big components).
    const step = Math.max(1, Math.floor(comp.length / 20000));
    const zs: number[] = [];
    for (let q = 0; q < comp.length; q += step) zs.push(smooth[comp[q]]);
    zs.sort((a, b) => a - b);
    const level = zs[zs.length >> 1];
    const p02 = zs[Math.floor(zs.length * 0.02)];
    const p98 = zs[Math.min(zs.length - 1, Math.floor(zs.length * 0.98))];
    const extent = Math.hypot(i1 - i0 + 1, j1 - j0 + 1) * cellSize;
    const allowedSpread = maxSpread + maxGradient * extent;
    const report = (rimHigher: number, rimLower: number, accepted: boolean) =>
      opts.onCandidate?.({ cells: comp.length, level, spread: p98 - p02, allowedSpread, rimHigher, rimLower, accepted, bbox: [i0, j0, i1, j1] });
    if (p98 - p02 > allowedSpread) {
      report(NaN, NaN, false);
      return 'rejected';
    }

    // Core cells carry their own (hydro-flattened) elevation as the surface level. Grow the shoreline: two rings
    // within ± tol of the adjacent level (resampled shore cells that failed the flatness test), then up to six
    // more within a tighter ± 0.12 m (riffles, gravel bars and unflattened patches inside wide rivers).
    for (const k of comp) levelOf[k] = Math.min(smooth[k], elev[k] + 0.05);
    const indices = comp.slice();
    let frontStart = 0;
    for (let ring = 0; ring < 8; ring++) {
      const ringTol = ring < 2 ? tol : Math.min(tol, 0.12);
      const frontEnd = indices.length;
      if (frontEnd === frontStart) break;
      for (let q = frontStart; q < frontEnd; q++) {
        const k = indices[q];
        const L = levelOf[k];
        nb4(k);
        for (let r = 0; r < 4; r++) {
          const m = nb[r];
          if (m < 0 || inSet[m] === id || inBody[m]) continue;
          if (Math.abs(elev[m] - L) > ringTol) continue;
          inSet[m] = id;
          levelOf[m] = L;
          indices.push(m);
        }
      }
      frontStart = frontEnd;
    }
    // Rim just beyond the shoreline. The domain edge, accepted bodies and other substantial flat surfaces
    // (adjacent river reaches, lake arms) are neutral.
    let rim = 0;
    let rimHigher = 0;
    let rimLower = 0;
    let touchesEdge = false;
    let attached = false;
    const lowerCells: number[] = [];
    for (const k of indices) {
      nb4(k);
      for (let r = 0; r < 4; r++) {
        const m = nb[r];
        if (m < 0) {
          touchesEdge = true;
          continue;
        }
        if (inSet[m] === id) continue;
        if (inBody[m]) {
          attached = true;
          continue;
        }
        if (label[m] >= 0 && label[m] !== lab && sizeOf[label[m]] >= neutralSize) continue;
        rim++;
        if (elev[m] >= levelOf[k] + 0.25) rimHigher++;
        else if (elev[m] < levelOf[k] - 0.25) {
          rimLower++;
          lowerCells.push(m);
        }
      }
    }
    // Lower rim cells within a few cells of an accepted body are the river draining over a riffle or weir into
    // its next reach — neutral, not an escape from a basin.
    if (lowerCells.length && bodies.length) {
      for (const m of lowerCells) {
        if (nearAcceptedBody(m, id, 6)) {
          rim--;
          rimLower--;
        }
      }
    }
    // Accept a clear basin (rim mostly higher), or a large surface nothing drains out of (no rim cells markedly
    // lower — a flat terrace or hilltop field always has a downhill side) whose rim is at least roughly half
    // higher: big rivers have long low banks, bars and islands only a few cm above the water. A drainless
    // surface attached to an accepted body only needs a quarter of its rim higher.
    const rimFrac = rim > 0 ? rimHigher / rim : 1;
    const lowerFrac = rim > 0 ? rimLower / rim : 0;
    const drainless = lowerFrac <= 0.03;
    const accepted =
      rimFrac >= minRim ||
      (drainless && comp.length >= 4 * minCells && rimFrac >= 0.45) ||
      (relaxed && drainless && attached && rimFrac >= 0.25);
    report(rimFrac, lowerFrac, accepted);
    // Not accepted yet: worth retrying once neighbors are accepted if little of the rim drains away.
    if (!accepted) return lowerFrac <= 0.3 ? 'retry' : 'rejected';

    const bodyId = bodies.length + 1;
    const levels = new Float32Array(indices.length);
    indices.forEach((k, q) => {
      inBody[k] = bodyId;
      levels[q] = levelOf[k];
    });
    bodies.push({
      level,
      minLevel: zs[0],
      maxLevel: zs[zs.length - 1],
      cells: indices.length,
      seed: { gx: 0, gy: 0 },
      seeds: [],
      indices: Int32Array.from(indices),
      levels,
      touchesEdge,
    });
    return 'accepted';
  };

  let pending: number[] = [];
  for (let lab = 0; lab < startOf.length; lab++) if (sizeOf[lab] >= minCells) pending.push(lab);
  pending.sort((a, b) => sizeOf[b] - sizeOf[a]);
  let retry: number[] = [];
  for (const lab of pending) if (evaluate(lab, false) === 'retry') retry.push(lab);
  for (let round = 0; round < 4 && retry.length; round++) {
    const before = bodies.length;
    pending = retry;
    retry = [];
    for (const lab of pending) if (evaluate(lab, true) === 'retry') retry.push(lab);
    if (bodies.length === before) break;
  }

  // Seeds: the interior-most cell of each body plus a lattice of interior cells, each carrying its local level
  // (computeInitialWater's per-seed levels reproduce sloping surfaces, and nearby seeds win over far ones).
  if (bodies.length) {
    const dist = distanceTransform(nx, ny, (k) => inBody[k] === 0);
    const lattice = Math.max(4, Math.round(80 / cellSize));
    for (const b of bodies) {
      // Interior-most, also counting the domain edge as shore (a river's widest point is often cut by the edge).
      const interior = (k: number) => Math.min(dist[k], (k % nx) + 0.5, nx - (k % nx) - 0.5, ((k / nx) | 0) + 0.5, ny - ((k / nx) | 0) - 0.5);
      let best = 0;
      for (let q = 0; q < b.indices.length; q++) if (interior(b.indices[q]) > interior(b.indices[best])) best = q;
      const kb = b.indices[best];
      b.seed = { gx: (kb % nx) + 0.5, gy: ((kb / nx) | 0) + 0.5 };
      b.seeds.push({ ...b.seed, level: b.levels[best] });
      {
        for (let q = 0; q < b.indices.length; q++) {
          const k = b.indices[q];
          const i = k % nx;
          const j = (k / nx) | 0;
          if (i % lattice === 0 && j % lattice === 0 && dist[k] >= 1.5) b.seeds.push({ gx: i + 0.5, gy: j + 0.5, level: b.levels[q] });
        }
      }
    }
  }
  bodies.sort((a, b) => b.cells - a.cells);
  return bodies;
}

/**
 * Burn detected water bodies (live areas): lower each by `depth` below its local surface with smooth banks,
 * bed = min(z, level) − depth·smoothstep(0, bankCells, distance to shore).
 *
 * Land cells bordering a body but LOWER than its surface are raised to surface + 2 cm ("sealed"). At 5–10 m cells a
 * floodwall or a narrow bank is sub-grid, so the DEM would connect a canal to the neighborhood behind it (New
 * Orleans' Industrial Canal) and the initial fill would drown it. The seal is invisible and any rise overtops it.
 *
 * Returns the conditioned elevation and ONE initial-fill entry holding every body's seeds with per-seed levels:
 * the nearest seed decides each cell, so adjacent river reaches at different levels don't flood each other.
 */
export function burnWaterBodies(
  elevation: Float32Array,
  nx: number,
  ny: number,
  bodies: WaterBody[],
  depth = 3,
  bankCells = 2,
): {
  elevation: Float32Array;
  burnedCells: number;
  sealedCells: number;
  fills: Array<{ seeds: Array<GridPoint & { level?: number }>; level: number }>;
} {
  const n = nx * ny;
  const mask = new Uint8Array(n);
  const level = new Float32Array(n);
  for (const b of bodies) {
    b.indices.forEach((k, q) => {
      mask[k] = 1;
      level[k] = b.levels[q];
    });
  }
  const dist = distanceTransform(nx, ny, (k) => mask[k] === 0);
  const out = new Float32Array(elevation);
  let burned = 0;
  for (let k = 0; k < n; k++) {
    if (!mask[k]) continue;
    out[k] = Math.min(elevation[k], level[k]) - depth * smoothstep(0, bankCells, dist[k]);
    burned++;
  }
  let sealed = 0;
  for (let k = 0; k < n; k++) {
    if (mask[k]) continue;
    const i = k % nx;
    const j = (k / nx) | 0;
    let top = -Infinity;
    if (i > 0 && mask[k - 1]) top = Math.max(top, level[k - 1]);
    if (i < nx - 1 && mask[k + 1]) top = Math.max(top, level[k + 1]);
    if (j > 0 && mask[k - nx]) top = Math.max(top, level[k - nx]);
    if (j < ny - 1 && mask[k + nx]) top = Math.max(top, level[k + nx]);
    if (top > -Infinity && out[k] < top + 0.02) {
      out[k] = top + 0.02;
      sealed++;
    }
  }
  const seeds: Array<GridPoint & { level: number }> = [];
  let minLevel = Infinity;
  for (const b of bodies) {
    for (const sd of b.seeds) seeds.push(sd);
    minLevel = Math.min(minLevel, b.minLevel);
  }
  return {
    elevation: out,
    burnedCells: burned,
    sealedCells: sealed,
    fills: seeds.length ? [{ seeds, level: minLevel }] : [],
  };
}
