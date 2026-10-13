/**
 * Where a dam's breach flood goes on the map — pure grid geometry, no network, no DOM.
 *
 *   injectionCell     the cell the breach outflow enters at: the lowest ground within a few dam-heights of the NID
 *                     point (the toe and the channel just below it — the NID point is the dam, often its crest)
 *   descentPath       the flow path from a cell down the terrain: steepest descent, with flats (hydro-flattened rivers,
 *                     burned channels) crossed by a breadth-first search for the nearest lower cell
 *   downstreamBearing which way the valley falls from the dam, read off a coarse elevation probe before the real area
 *                     is loaded, so the live area can be centred downstream of the dam instead of on its reservoir
 *   readDownstream    arrival time and peak depth at fixed distances along that path, from the solver's hazard fields
 */
import type { HazardFields } from '../contracts';

export interface GridPoint {
  gx: number;
  gy: number;
}

/** Search radius for the injection cell: 2.5 × the dam height, clamped to [150, 600] m. */
export function injectionRadiusM(heightM: number): number {
  return Math.min(600, Math.max(150, 2.5 * heightM));
}

/**
 * The lowest cell within `radiusM` of (gx, gy) — the toe of the dam and the channel just below it. Ties go to the cell
 * nearest the dam. Null when the point is off the grid.
 */
export function injectionCell(elev: Float32Array, nx: number, ny: number, cellSize: number, at: GridPoint, radiusM: number): (GridPoint & { elevation: number; distanceM: number }) | null {
  if (!(at.gx >= 0 && at.gy >= 0 && at.gx < nx && at.gy < ny)) return null;
  const r = Math.max(1, Math.round(radiusM / cellSize));
  const ci = Math.floor(at.gx);
  const cj = Math.floor(at.gy);
  let best = -1;
  let bestZ = Infinity;
  let bestD = Infinity;
  for (let j = Math.max(0, cj - r); j <= Math.min(ny - 1, cj + r); j++) {
    for (let i = Math.max(0, ci - r); i <= Math.min(nx - 1, ci + r); i++) {
      const d = Math.hypot(i - ci, j - cj);
      if (d > r) continue;
      const z = elev[j * nx + i];
      if (!Number.isFinite(z)) continue;
      if (z < bestZ - 1e-6 || (Math.abs(z - bestZ) <= 1e-6 && d < bestD)) {
        best = j * nx + i;
        bestZ = z;
        bestD = d;
      }
    }
  }
  if (best < 0) return null;
  const gx = (best % nx) + 0.5;
  const gy = Math.floor(best / nx) + 0.5;
  return { gx, gy, elevation: bestZ, distanceM: bestD * cellSize };
}

const NB: ReadonlyArray<[number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

export interface PathPoint extends GridPoint {
  /** Distance along the path from its start, m. */
  s: number;
  z: number;
}

/**
 * The flow path from `start`: each step goes to the lowest of the 8 neighbours if it is lower; on a flat (or in a pit
 * shallower than `flatTol`) a breadth-first search over cells no higher than the current one + flatTol finds the
 * nearest strictly lower cell and the path walks there. Stops at `maxLengthM`, at the grid edge, or in a pit no search
 * of `maxFlatCells` cells escapes.
 */
export function descentPath(elev: Float32Array, nx: number, ny: number, cellSize: number, start: GridPoint, maxLengthM: number, opts: { flatTol?: number; maxFlatCells?: number } = {}): PathPoint[] {
  const tol = opts.flatTol ?? 0.05;
  const maxFlat = opts.maxFlatCells ?? Math.max(20000, (nx * ny) >> 2);
  let i = Math.min(nx - 1, Math.max(0, Math.floor(start.gx)));
  let j = Math.min(ny - 1, Math.max(0, Math.floor(start.gy)));
  const visited = new Uint8Array(nx * ny);
  const out: PathPoint[] = [{ gx: i + 0.5, gy: j + 0.5, s: 0, z: elev[j * nx + i] }];
  visited[j * nx + i] = 1;
  let s = 0;
  const push = (ni: number, nj: number) => {
    s += Math.hypot(ni - i, nj - j) * cellSize;
    i = ni;
    j = nj;
    visited[j * nx + i] = 1;
    out.push({ gx: i + 0.5, gy: j + 0.5, s, z: elev[j * nx + i] });
  };
  while (s < maxLengthM) {
    const z = elev[j * nx + i];
    let bi = -1;
    let bj = -1;
    let best = 0;
    for (const [di, dj, w] of NB) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny || visited[b * nx + a]) continue;
      // Steepest drop per metre, not the lowest cell: a diagonal must fall √2 times as far to win.
      const slope = (z - elev[b * nx + a]) / w;
      if (slope > best + 1e-9) {
        best = slope;
        bi = a;
        bj = b;
      }
    }
    if (bi >= 0) {
      push(bi, bj);
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) break;
      continue;
    }
    // A flat or a pit: breadth-first search for the nearest lower cell, first across the flat, then — as water would,
    // by filling the depression until it spills — over rims up to 1, 3 and 8 m above the current cell (burned lakes and
    // channels in a live area sit metres below their banks).
    let route: number[] | null = null;
    for (const t of [tol, 1, 3, 8]) {
      route = escapeFlat(elev, nx, ny, i, j, z, Math.max(tol, t), maxFlat, visited);
      if (route) break;
    }
    if (!route) break;
    for (const k of route) push(k % nx, Math.floor(k / nx));
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) break;
  }
  return out;
}

function escapeFlat(elev: Float32Array, nx: number, ny: number, i0: number, j0: number, z0: number, tol: number, maxCells: number, visited: Uint8Array): number[] | null {
  const start = j0 * nx + i0;
  const prev = new Map<number, number>([[start, -1]]);
  const queue: number[] = [start];
  for (let q = 0; q < queue.length && queue.length < maxCells; q++) {
    const k = queue[q];
    const i = k % nx;
    const j = Math.floor(k / nx);
    for (const [di, dj] of NB) {
      const a = i + di;
      const b = j + dj;
      if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
      const n = b * nx + a;
      if (prev.has(n) || visited[n]) continue;
      const zn = elev[n];
      if (zn < z0 - 1e-3) {
        prev.set(n, k);
        const route: number[] = [];
        for (let c = n; c !== start; c = prev.get(c)!) route.push(c);
        return route.reverse();
      }
      if (zn <= z0 + tol) {
        prev.set(n, k);
        queue.push(n);
      }
    }
  }
  return null;
}

/**
 * Bearing the valley falls in from the dam, radians clockwise from north (0 = north, π/2 = east), read off a coarse
 * square elevation probe centred on the dam: the direction from the dam to where its descent path is `alongM`
 * downstream (or ends). Null when the path goes nowhere (a pit, flat ground).
 */
export function downstreamBearing(elev: Float32Array, n: number, cellSize: number, dam: GridPoint, heightM: number): number | null {
  const toe = injectionCell(elev, n, n, cellSize, dam, Math.max(injectionRadiusM(heightM), 1.5 * cellSize));
  if (!toe) return null;
  const path = descentPath(elev, n, n, cellSize, toe, 0.4 * n * cellSize);
  const end = path[path.length - 1];
  const dx = end.gx - dam.gx;
  const dy = end.gy - dam.gy;
  if (Math.hypot(dx, dy) * cellSize < 2 * cellSize) return null;
  // Grid y grows southward.
  return Math.atan2(dx, -dy);
}

/** A point `distanceM` from (lat, lon) along `bearing` (radians clockwise from north). Local flat-earth; fine below ~50 km. */
export function offsetLatLon(lat: number, lon: number, bearing: number, distanceM: number): { lat: number; lon: number } {
  const dn = Math.cos(bearing) * distanceM;
  const de = Math.sin(bearing) * distanceM;
  return { lat: lat + dn / 111_320, lon: lon + de / (111_320 * Math.cos((lat * Math.PI) / 180)) };
}

/**
 * Centre for a live area of `sizeM` that holds the dam near its upstream side and as much of the valley below it as
 * possible: `share` of the way from the middle to the edge, along the bearing (default 0.32 of the side: the dam sits
 * 18 % in from the upstream edge, its reservoir mostly off the map).
 */
export function areaCentreForDam(dam: { lat: number; lon: number }, bearing: number | null, sizeM: number, share = 0.32): { lat: number; lon: number } {
  if (bearing === null || !Number.isFinite(bearing)) return { lat: dam.lat, lon: dam.lon };
  return offsetLatLon(dam.lat, dam.lon, bearing, share * sizeM);
}

export interface DownstreamReading {
  /** Distance downstream along the flow path, m. */
  distanceM: number;
  gx: number;
  gy: number;
  /** First time water stood > 0.15 m deeper than at the start, s; null if never. */
  arrivalS: number | null;
  /** Peak depth near the path point, m. */
  maxDepth: number;
  /** Peak speed near the path point, m/s. */
  maxSpeed: number;
}

/** Distances (m) the downstream readout reports at, cut to the path's length. */
export const READOUT_DISTANCES_M = [500, 1000, 2000, 3000, 5000, 8000, 12000] as const;

/**
 * Arrival time and peak depth along the flow path at fixed distances: at each, the cells within `halfWidth` cells of
 * the path point (the channel and its banks), taking the earliest first-wet time among cells that got ≥ 0.15 m and
 * the largest max depth. Cells wet at reset (firstWet 0: the river itself) count as arrival only through their depth
 * rise, which the fields cannot tell — so they are skipped for the arrival and kept for the depth.
 */
export function readDownstream(fields: HazardFields, path: readonly PathPoint[], distances: readonly number[] = READOUT_DISTANCES_M, halfWidth = 6): DownstreamReading[] {
  const out: DownstreamReading[] = [];
  if (!path.length) return out;
  const total = path[path.length - 1].s;
  for (const d of distances) {
    if (d > total) break;
    let k = 0;
    while (k < path.length - 1 && path[k].s < d) k++;
    const p = path[k];
    const ci = Math.floor(p.gx);
    const cj = Math.floor(p.gy);
    let arrival = Infinity;
    let depth = 0;
    let speed = 0;
    for (let j = Math.max(0, cj - halfWidth); j <= Math.min(fields.ny - 1, cj + halfWidth); j++) {
      for (let i = Math.max(0, ci - halfWidth); i <= Math.min(fields.nx - 1, ci + halfWidth); i++) {
        const c = j * fields.nx + i;
        const md = fields.maxDepth[c];
        if (md > depth) depth = md;
        if (fields.maxSpeed[c] > speed) speed = fields.maxSpeed[c];
        const fw = fields.firstWet[c];
        if (fw > 0 && md >= 0.15 && fw < arrival) arrival = fw;
      }
    }
    out.push({ distanceM: d, gx: p.gx, gy: p.gy, arrivalS: Number.isFinite(arrival) ? arrival : null, maxDepth: depth, maxSpeed: speed });
  }
  return out;
}
