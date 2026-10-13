/**
 * Building footprints → the grid cells each one covers, rasterised once per BuildingSet and cached.
 *
 * A cell belongs to a footprint when its CENTRE is inside the ring (even-odd scanline fill, the same rule as
 * rasterizeBuildingHeights in src/data/buildings.ts). A footprint too small to contain any cell centre — a 60 m² house
 * on 7.8 m cells — gets the single cell under its centroid, so every building inside the grid is sampled somewhere.
 */
import type { BuildingSet } from '../contracts';

export interface FootprintIndex {
  count: number;
  /** Length count+1: building k owns cells[offsets[k] … offsets[k+1]). */
  offsets: Uint32Array;
  /** Row-major cell indices j·nx + i. */
  cells: Uint32Array;
  /** Centroid in grid coords (vertex mean of the ring). NaN for degenerate rings. */
  cx: Float32Array;
  cy: Float32Array;
  /** Footprint area on the ground, m² (shoelace, absolute). */
  areaM2: Float32Array;
  /** Bounding box in grid coords (for point matching). */
  minX: Float32Array;
  minY: Float32Array;
  maxX: Float32Array;
  maxY: Float32Array;
  nx: number;
  ny: number;
  cellSize: number;
}

const cache = new WeakMap<BuildingSet, FootprintIndex>();

/** Rasterise (or fetch the cached rasterisation of) a building set on an nx × ny grid of `cellSize` m cells. */
export function footprintIndex(set: BuildingSet, nx: number, ny: number, cellSize: number): FootprintIndex {
  const hit = cache.get(set);
  if (hit && hit.nx === nx && hit.ny === ny && hit.cellSize === cellSize) return hit;
  const idx = rasterizeFootprints(set, nx, ny, cellSize);
  cache.set(set, idx);
  return idx;
}

export function rasterizeFootprints(set: BuildingSet, nx: number, ny: number, cellSize: number): FootprintIndex {
  const n = set.count;
  const offsets = new Uint32Array(n + 1);
  let cells = new Uint32Array(Math.max(1024, n * 4));
  let len = 0;
  const push = (c: number) => {
    if (len === cells.length) {
      const next = new Uint32Array(cells.length * 2);
      next.set(cells);
      cells = next;
    }
    cells[len++] = c;
  };
  const cx = new Float32Array(n);
  const cy = new Float32Array(n);
  const areaM2 = new Float32Array(n);
  const minX = new Float32Array(n);
  const minY = new Float32Array(n);
  const maxX = new Float32Array(n);
  const maxY = new Float32Array(n);
  const xs: number[] = [];
  const V = set.verts;
  for (let k = 0; k < n; k++) {
    offsets[k] = len;
    const a = set.offsets[k];
    const b = set.offsets[k + 1];
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let sx = 0;
    let sy = 0;
    let area2 = 0;
    for (let i = a, p = b - 1; i < b; p = i++) {
      const x = V[i * 2];
      const y = V[i * 2 + 1];
      sx += x;
      sy += y;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      area2 += V[p * 2] * y - x * V[p * 2 + 1];
    }
    const m = b - a;
    cx[k] = m > 0 ? sx / m : NaN;
    cy[k] = m > 0 ? sy / m : NaN;
    areaM2[k] = (Math.abs(area2) / 2) * cellSize * cellSize;
    minX[k] = x0;
    minY[k] = y0;
    maxX[k] = x1;
    maxY[k] = y1;
    if (m >= 3) {
      const j0 = Math.max(0, Math.ceil(y0 - 0.5));
      const j1 = Math.min(ny - 1, Math.floor(y1 - 0.5));
      for (let j = j0; j <= j1; j++) {
        const y = j + 0.5;
        xs.length = 0;
        for (let i = a, p = b - 1; i < b; p = i++) {
          const yi = V[i * 2 + 1];
          const yp = V[p * 2 + 1];
          if (yi > y === yp > y) continue;
          const xi = V[i * 2];
          const xp = V[p * 2];
          xs.push(((xp - xi) * (y - yi)) / (yp - yi) + xi);
        }
        if (xs.length < 2) continue;
        xs.sort((u, w) => u - w);
        for (let s = 0; s + 1 < xs.length; s += 2) {
          const i0 = Math.max(0, Math.ceil(xs[s] - 0.5));
          const i1 = Math.min(nx - 1, Math.floor(xs[s + 1] - 0.5));
          for (let i = i0; i <= i1; i++) push(j * nx + i);
        }
      }
    }
    if (len === offsets[k] && Number.isFinite(cx[k])) {
      const i = Math.floor(cx[k]);
      const j = Math.floor(cy[k]);
      if (i >= 0 && j >= 0 && i < nx && j < ny) push(j * nx + i);
    }
  }
  offsets[n] = len;
  return { count: n, offsets, cells: cells.slice(0, len), cx, cy, areaM2, minX, minY, maxX, maxY, nx, ny, cellSize };
}

/** Cells covered by an arbitrary ring of grid coords (a portfolio WKT polygon), with the same centroid fallback. */
export function ringCells(ring: ArrayLike<number>, nx: number, ny: number): number[] {
  const set: BuildingSet = {
    count: 1,
    offsets: new Uint32Array([0, ring.length / 2]),
    verts: Float32Array.from(ring),
    base: new Float32Array(1),
    height: new Float32Array(1),
    heightSource: new Uint8Array(1),
    kind: new Uint8Array(1),
    names: [undefined],
    heightRaster: null,
    attribution: '',
  };
  return Array.from(rasterizeFootprints(set, nx, ny, 1).cells);
}

/**
 * Rings searched outward from a blocked footprint for open cells to sample: a building walled in by its neighbours
 * (a terrace, a city block mapped as touching footprints) reads the open ground up to this many cells away.
 */
export const OPEN_RING_MAX = 3;

let stamp: Uint32Array | null = null;
let stampGen = 0;

/**
 * The cells to sample for a footprint when building obstacles block flow (HazardFields.blocked): the solver keeps water
 * out of a blocked cell, so the depth against a building is read in the open cells around it — the street, the yard —
 * not on its footprint. Unblocked cells of `cells[start, end)` are kept as they are; the blocked ones are replaced by
 * the open cells sharing an edge with them (the cells against the walls; diagonal cells are not), searching up to
 * OPEN_RING_MAX rings out through other blocked cells when the first ring is closed (a terrace house open only front
 * and back reads those). Returns null when no cell of the range is blocked (sample it as is).
 */
export function openCells(
  cells: ArrayLike<number>,
  start: number,
  end: number,
  blocked: Uint8Array,
  nx: number,
  ny: number,
): number[] | null {
  let any = false;
  for (let q = start; q < end; q++) if (blocked[cells[q]]) { any = true; break; }
  if (!any) return null;
  const N = nx * ny;
  if (!stamp || stamp.length !== N) {
    stamp = new Uint32Array(N);
    stampGen = 0;
  }
  if (++stampGen === 0xffffffff) {
    stamp.fill(0);
    stampGen = 1;
  }
  const s = stamp;
  const g = stampGen;
  const out: number[] = [];
  let frontier: number[] = [];
  for (let q = start; q < end; q++) {
    const c = cells[q];
    if (s[c] === g) continue;
    s[c] = g;
    if (blocked[c]) frontier.push(c);
    else out.push(c);
  }
  for (let ring = 1; ring <= OPEN_RING_MAX && frontier.length; ring++) {
    const next: number[] = [];
    let found = 0;
    for (const c of frontier) {
      const i = c % nx;
      const j = (c - i) / nx;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if ((di === 0) === (dj === 0) || ii < 0 || ii >= nx) continue; // edge neighbours only
          const m = jj * nx + ii;
          if (s[m] === g) continue;
          s[m] = g;
          if (blocked[m]) next.push(m);
          else {
            out.push(m);
            found++;
          }
        }
      }
    }
    if (found > 0) break;
    frontier = next;
  }
  return out;
}
