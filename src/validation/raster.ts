/**
 * Map polygons → the model grid, and a compact encoding for the class rasters committed under public/validation/.
 *
 * A cell belongs to a polygon when its CENTRE is inside it (even–odd rule over all rings, so holes work). Coordinates
 * are converted with the grid's own Web-Mercator mapping (src/data/geo.ts), so a FEMA or Copernicus polygon lands on
 * exactly the cells the solver's elevation came from.
 */
import { makeGeoToGrid } from '../data/geo';
import type { GeoBounds } from '../contracts';

export interface GridSpec {
  nx: number;
  ny: number;
  bounds: GeoBounds;
}

/** A ring in GRID coordinates, [gx0, gy0, gx1, gy1, …] (closing vertex optional). */
export type GridRing = number[];

/** lon/lat ring ([[lon, lat], …]) → grid ring. */
export function ringToGrid(grid: GridSpec, ring: ReadonlyArray<ReadonlyArray<number>>): GridRing {
  const toGrid = makeGeoToGrid(grid);
  const out: number[] = [];
  for (const p of ring) {
    const [gx, gy] = toGrid(p[0], p[1]);
    out.push(gx, gy);
  }
  return out;
}

/** The row-major indices of the cells whose centres are inside the polygon made of `rings` (even–odd). */
export function polygonCells(nx: number, ny: number, rings: readonly GridRing[]): number[] {
  // Even–odd pairs on one scanline never overlap, so every cell is visited once.
  const cells: number[] = [];
  scanPolygon(nx, ny, rings, (k) => cells.push(k));
  return cells;
}

/**
 * Set `value` in `out` (nx·ny) for every cell whose centre is inside the polygon made of `rings` (even–odd).
 * Scanline fill: for each row, intersect the row's centre line with every edge, sort, and fill between pairs.
 */
export function fillPolygon(out: Uint8Array, nx: number, ny: number, rings: readonly GridRing[], value: number): number {
  return scanPolygon(nx, ny, rings, (k) => (out[k] = value));
}

function scanPolygon(nx: number, ny: number, rings: readonly GridRing[], visit: (k: number) => void): number {
  let ymin = Infinity;
  let ymax = -Infinity;
  for (const r of rings) {
    for (let k = 1; k < r.length; k += 2) {
      if (r[k] < ymin) ymin = r[k];
      if (r[k] > ymax) ymax = r[k];
    }
  }
  if (!Number.isFinite(ymin)) return 0;
  const j0 = Math.max(0, Math.ceil(ymin - 0.5));
  const j1 = Math.min(ny - 1, Math.floor(ymax - 0.5));
  let filled = 0;
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = j + 0.5;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length >> 1;
      for (let a = 0; a < n; a++) {
        const b = (a + 1) % n;
        const ya = r[2 * a + 1];
        const yb = r[2 * b + 1];
        // Half-open rule: an edge counts when y is in [min, max), so a vertex on the scanline is counted once.
        if ((ya <= y && yb > y) || (yb <= y && ya > y)) {
          const xa = r[2 * a];
          const xb = r[2 * b];
          xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
        }
      }
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil(xs[k] - 0.5));
      const i1 = Math.min(nx - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = i0; i <= i1; i++) {
        visit(j * nx + i);
        filled++;
      }
    }
  }
  return filled;
}

/** GeoJSON Polygon / MultiPolygon geometry (lon/lat) → fill. Other geometry types are ignored. */
export function fillGeoJsonGeometry(
  out: Uint8Array,
  grid: GridSpec,
  geometry: { type: string; coordinates: unknown } | null | undefined,
  value: number,
): number {
  if (!geometry) return 0;
  const polys: number[][][][] =
    geometry.type === 'Polygon'
      ? [geometry.coordinates as number[][][]]
      : geometry.type === 'MultiPolygon'
        ? (geometry.coordinates as number[][][][])
        : [];
  let n = 0;
  for (const poly of polys) n += fillPolygon(out, grid.nx, grid.ny, poly.map((r) => ringToGrid(grid, r)), value);
  return n;
}

/**
 * Run-length encoding of a small-alphabet raster (row-major): `[value, count, value, count, …]`. A FEMA zone map of a
 * 1024² domain is a few thousand runs — tens of kB as JSON instead of 1 MB.
 */
export function rleEncode(a: ArrayLike<number>): number[] {
  const out: number[] = [];
  if (a.length === 0) return out;
  let v = a[0];
  let n = 1;
  for (let k = 1; k < a.length; k++) {
    if (a[k] === v) n++;
    else {
      out.push(v, n);
      v = a[k];
      n = 1;
    }
  }
  out.push(v, n);
  return out;
}

export function rleDecode(runs: readonly number[], length: number): Uint8Array {
  const out = new Uint8Array(length);
  let k = 0;
  for (let r = 0; r + 1 < runs.length; r += 2) {
    const v = runs[r];
    const n = runs[r + 1];
    if (k + n > length) throw new Error(`rleDecode: runs overflow ${length} cells`);
    if (v) out.fill(v, k, k + n);
    k += n;
  }
  if (k !== length) throw new Error(`rleDecode: runs cover ${k} of ${length} cells`);
  return out;
}

/**
 * Sample a polyline in grid coordinates every `step` cells; returns the row-major cell index of each sample inside the
 * grid (duplicates removed, order kept).
 */
export function lineCells(nx: number, ny: number, pts: readonly number[], step = 0.5): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  const add = (x: number, y: number) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    if (i < 0 || j < 0 || i >= nx || j >= ny) return;
    const k = j * nx + i;
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  };
  for (let a = 0; a + 3 < pts.length; a += 2) {
    const x0 = pts[a];
    const y0 = pts[a + 1];
    const dx = pts[a + 2] - x0;
    const dy = pts[a + 3] - y0;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dy) / step));
    for (let s = 0; s <= n; s++) add(x0 + (dx * s) / n, y0 + (dy * s) / n);
  }
  if (pts.length === 2) add(pts[0], pts[1]);
  return out;
}
