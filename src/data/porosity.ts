/**
 * Building footprints → the solver's building layers (FloodSolver.setLandSurface; ARCHITECTURE.md §3.11): integral
 * porosity for cells the footprints only partly cover, a building block for cells they (almost) fill, and where the
 * rain falling on the roofs goes (downspouts).
 *
 * POROSITY. Sanders, Schubert & Gallegos (2008, "Integral formulation of shallow-water equations with anisotropic
 * porosity for urban flood modeling", J. Hydrology 362) give every cell a storage porosity φ (the share of its area
 * open to water) and every face a conveyance porosity ψ (the share of its length open), measured from the building
 * footprints at a finer scale than the grid. Water then stores only in the open part of a cell and crosses a face only
 * through its open part, so a 3 m side yard between two houses stays a path on a 7.8 m grid. Simplified here: the
 * porosities are fixed (no depth dependence, no drag term for the building faces), and every face's ψ is capped at the
 * smaller φ of its two cells, which keeps the explicit scheme's gravity-wave speed √(g·h·ψ/φ) within the
 * uniform-grid CFL limit — the single-porosity bound of Guinot & Soares-Frazão (2006, Int. J. Numer. Meth. Fluids 50).
 *
 * The porosities are measured on an S×S sub-grid per cell (S = 8: 0.98 m sub-cells on the 7.8 m US presets), with
 * the footprints scan-converted by sub-cell centre: φ = open sub-cells / S²; a face is open at a sub-row where the
 * sub-cells on both sides of it are open, and ψ = open sub-rows / S.
 *
 * BLOCKS. A cell with φ < PHI_BLOCK (90 % or more under footprints) is a building block (the obstacle layer, the
 * method the solver already had): a raised bed at the roof, which water goes round or, overtopping it, over. Very
 * small φ makes the true depth V/φ ill-conditioned and the cell holds next to nothing, so the block is the better model
 * there. Touching blocked cells share one flat roof (obstacleHeights). Block faces carry no porosity of their own (the
 * wall is the raised bed): ψ is then the other cell's φ.
 *
 * Never porous or blocked: cells wet in the initial water (a footprint mapped over a river or a dock must not dam it,
 * and the initial depth is a true depth), and porous cells in the EDGE_BAND cells along the domain edges, whose
 * open-boundary rule reads raw depths (blocks are allowed there, as before).
 *
 * DOWNSPOUTS. Rain on a roof does not fall on the street beside the wall: gutters and downspouts take it to the storm
 * sewer (connected downspouts) or onto the ground at the foot of the building. `roof` is the share of each cell's area
 * that is roof; its rain is handled by the solver as:
 *   • storm drains on: piped into the cell's drain capacity first (the sewer it is connected to), and only what the
 *     sewer cannot take spills — onto the roof of a block (the film runs off its edge), into the open part of a
 *     partly covered cell;
 *   • no drains: discharged at the foot of the building as sheet flow: a partly covered cell's roof into its own open
 *     part, a block's roof into the nearest open cell (multi-source breadth-first search from the open cells around the
 *     building, the lowest one where several touch), so a large roof sheds all round, as its downspouts would.
 * `spout` is the roof area (in cells) whose rain lands on each cell when there are no drains (its own roof included).
 */
import type { BuildingSet, LandSurfacePorosity } from '../contracts';
import { POROSITY_EDGE_BAND } from '../sim/constants';
import { MIN_OBSTACLE_HEIGHT, obstacleHeights } from './landcover';

/** Sub-cells per cell edge for the footprint coverage (8 → 64 samples per cell, one byte per sub-row). */
export const POROSITY_SUBSAMPLES = 8;
/** Open fraction below which a cell is a building block instead of a porous cell. */
export const PHI_BLOCK = 0.1;
/** Cells along each domain edge kept non-porous (the open-boundary rule reads them; src/sim/constants.ts). */
export const EDGE_BAND = POROSITY_EDGE_BAND;

export interface BuildingLayers {
  /** Building-block heights above the ground (m), 0 = not blocked; null when no cell is blocked. */
  obstacles: Float32Array | null;
  /** Porosities and roof rain routing; null when no footprint covers any sub-cell. */
  porosity: LandSurfacePorosity | null;
  /** Cells blocked, cells partly covered (0 < 1 − φ), cells with any roof. */
  blockedCells: number;
  porousCells: number;
}

export interface BuildingLayerOptions {
  /** Ground elevation (nx·ny, m): touching blocks get one flat roof, and a block's downspouts discharge at the lowest open neighbour. */
  ground?: Float32Array | null;
  /** Initial water depth (nx·ny, m): cells with any initial water are neither porous nor blocked. */
  initialWater?: Float32Array | null;
}

const POPCOUNT8 = (() => {
  const t = new Uint8Array(256);
  for (let v = 0; v < 256; v++) t[v] = (v & 1) + t[v >> 1];
  return t;
})();

/**
 * Footprint coverage on the S×S sub-grid (S = POROSITY_SUBSAMPLES = 8): one byte per cell per sub-row, bit k = sub-cell
 * column k inside a footprint. Returns the bytes (row-major: sub-row fy, cell column i) and each cell's tallest roof
 * height among the footprints that touch it.
 */
export function footprintSubgrid(set: BuildingSet, nx: number, ny: number): { bits: Uint8Array; roof: Float32Array } {
  const S = POROSITY_SUBSAMPLES;
  const W = nx * S;
  const H = ny * S;
  const bits = new Uint8Array(nx * H);
  const roof = new Float32Array(nx * ny);
  // Scanline crossings, sorted by insertion (a footprint ring crosses a sub-row a handful of times).
  let xs = new Float64Array(64);
  let nxs = 0;
  const verts = set.verts;
  for (let k = 0; k < set.count; k++) {
    const a = set.offsets[k];
    const b = set.offsets[k + 1];
    if (b - a < 3) continue;
    const h = set.height[k];
    let minY = Infinity;
    let maxY = -Infinity;
    for (let v = a; v < b; v++) {
      const y = verts[v * 2 + 1];
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (b - a > xs.length) xs = new Float64Array(2 * (b - a));
    // Sub-rows whose centre (fy + ½)/S lies inside [minY, maxY].
    const f0 = Math.max(0, Math.ceil(minY * S - 0.5));
    const f1 = Math.min(H - 1, Math.floor(maxY * S - 0.5));
    for (let fy = f0; fy <= f1; fy++) {
      const y = (fy + 0.5) / S;
      nxs = 0;
      for (let v = a, p = b - 1; v < b; p = v++) {
        const yv = verts[v * 2 + 1];
        const yp = verts[p * 2 + 1];
        if (yv > y === yp > y) continue;
        const xv = verts[v * 2];
        const xp = verts[p * 2];
        const x = ((xp - xv) * (y - yv)) / (yp - yv) + xv;
        let q = nxs++;
        while (q > 0 && xs[q - 1] > x) {
          xs[q] = xs[q - 1];
          q--;
        }
        xs[q] = x;
      }
      if (nxs < 2) continue;
      const row = fy * nx;
      const j = (fy / S) | 0;
      for (let s = 0; s + 1 < nxs; s += 2) {
        const c0 = Math.max(0, Math.ceil(xs[s] * S - 0.5));
        const c1 = Math.min(W - 1, Math.floor(xs[s + 1] * S - 0.5));
        if (c1 < c0) continue;
        for (let fx = c0; fx <= c1; ) {
          const i = (fx / S) | 0;
          const lo = fx - i * S;
          const hi = Math.min(S - 1, c1 - i * S);
          bits[row + i] |= ((0xff << lo) & (0xff >> (S - 1 - hi))) & 0xff;
          if (h > roof[j * nx + i]) roof[j * nx + i] = h;
          fx = (i + 1) * S;
        }
      }
    }
  }
  return { bits, roof };
}

/**
 * The building layers of a scene (see the header): blocks, porosities and roof routing from the footprints. Null
 * layers when the set has no footprint big enough to cover a sub-cell.
 */
interface Coverage {
  nx: number;
  ny: number;
  bits: Uint8Array;
  roof: Float32Array;
  /** Covered sub-cells per cell, 0–S². */
  covered: Uint8Array;
  any: boolean;
}

/**
 * The sub-grid coverage of a footprint set (~0.1 s for Houston's 49,000 footprints at 1024²), kept per set so the
 * scene's status line and the layers built when the switch goes on share one scan. Freed with the set.
 */
const coverageCache = new WeakMap<BuildingSet, Coverage>();

function coverage(set: BuildingSet, nx: number, ny: number): Coverage {
  const hit = coverageCache.get(set);
  if (hit && hit.nx === nx && hit.ny === ny) return hit;
  const S = POROSITY_SUBSAMPLES;
  const N = nx * ny;
  const { bits, roof } = footprintSubgrid(set, nx, ny);
  const covered = new Uint8Array(N);
  let any = false;
  for (let j = 0; j < ny; j++) {
    for (let k = 0; k < S; k++) {
      const row = (j * S + k) * nx;
      for (let i = 0; i < nx; i++) {
        const v = bits[row + i];
        if (v) {
          covered[j * nx + i] += POPCOUNT8[v];
          any = true;
        }
      }
    }
  }
  const cov = { nx, ny, bits, roof, covered, any };
  coverageCache.set(set, cov);
  return cov;
}

/** How many cells the footprints would block and how many they partly cover (the rules of buildingLayers). */
export function buildingCellCounts(
  set: BuildingSet | null | undefined,
  nx: number,
  ny: number,
  initialWater?: Float32Array | null,
): { blockedCells: number; porousCells: number } {
  if (!set || !(set.count > 0)) return { blockedCells: 0, porousCells: 0 };
  const S = POROSITY_SUBSAMPLES;
  const { covered } = coverage(set, nx, ny);
  const water = initialWater && initialWater.length === nx * ny ? initialWater : null;
  let blockedCells = 0;
  let porousCells = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!covered[c] || (water && water[c] > 0)) continue;
      if (1 - covered[c] / (S * S) < PHI_BLOCK) blockedCells++;
      else if (!(i < EDGE_BAND || j < EDGE_BAND || i >= nx - EDGE_BAND || j >= ny - EDGE_BAND)) porousCells++;
    }
  }
  return { blockedCells, porousCells };
}

export function buildingLayers(set: BuildingSet | null | undefined, nx: number, ny: number, opts: BuildingLayerOptions = {}): BuildingLayers {
  const none: BuildingLayers = { obstacles: null, porosity: null, blockedCells: 0, porousCells: 0 };
  if (!set || !(set.count > 0)) return none;
  const S = POROSITY_SUBSAMPLES;
  const N = nx * ny;
  const { bits, roof: roofHeight, covered, any } = coverage(set, nx, ny);
  if (!any) return none;
  const water = opts.initialWater && opts.initialWater.length === N ? opts.initialWater : null;
  const ground = opts.ground && opts.ground.length === N ? opts.ground : null;
  const wet = (c: number) => !!water && water[c] > 0;
  const inBand = (i: number, j: number) => i < EDGE_BAND || j < EDGE_BAND || i >= nx - EDGE_BAND || j >= ny - EDGE_BAND;

  const cell = new Float32Array(N).fill(1);
  const roof = new Float32Array(N);
  const blockRaster = new Float32Array(N);
  let blocked = 0;
  let porous = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (!covered[c] || wet(c)) continue;
      const phi = 1 - covered[c] / (S * S);
      if (phi < PHI_BLOCK) {
        blockRaster[c] = Math.max(MIN_OBSTACLE_HEIGHT, roofHeight[c]);
        roof[c] = 1;
        blocked++;
      } else if (!inBand(i, j)) {
        cell[c] = phi;
        roof[c] = 1 - phi;
        porous++;
      }
    }
  }
  const obstacles = blocked ? obstacleHeights(null, nx, ny, blockRaster, ground) : null;
  const isBlock = (c: number) => blockRaster[c] > 0;

  // Face porosities: open sub-rows (sub-columns) along the face, capped at the smaller φ of the two cells.
  const faceE = new Float32Array(N).fill(1);
  const faceS = new Float32Array(N).fill(1);
  const hiBit = 1 << (S - 1);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      if (i < nx - 1) {
        const e = c + 1;
        let open = S;
        if (!isBlock(c) && !isBlock(e) && !inBand(i, j) && !inBand(i + 1, j) && (covered[c] || covered[e])) {
          open = 0;
          for (let k = 0; k < S; k++) {
            const row = (j * S + k) * nx;
            if (!(bits[row + i] & hiBit) && !(bits[row + i + 1] & 1)) open++;
          }
        }
        faceE[c] = Math.min(open / S, cell[c], cell[e]);
      }
      if (j < ny - 1) {
        const s = c + nx;
        let open = S;
        if (!isBlock(c) && !isBlock(s) && !inBand(i, j) && !inBand(i, j + 1) && (covered[c] || covered[s])) {
          const a = bits[((j + 1) * S - 1) * nx + i];
          const b = bits[(j + 1) * S * nx + i];
          open = S - POPCOUNT8[(a | b) & 0xff];
        }
        faceS[c] = Math.min(open / S, cell[c], cell[s]);
      }
    }
  }

  // Downspouts with no drains: a porous cell's roof into its own open part, a block's into the nearest open cell.
  const spout = new Float32Array(N);
  for (let c = 0; c < N; c++) if (!isBlock(c)) spout[c] = roof[c];
  if (blocked) {
    const owner = new Int32Array(N).fill(-1);
    const queue = new Int32Array(N);
    let qh = 0;
    let qt = 0;
    const nb = new Int32Array(4);
    // The 4-neighbours of c into nb; returns how many.
    const neighbours = (c: number) => {
      let k = 0;
      const i = c % nx;
      if (i > 0) nb[k++] = c - 1;
      if (i < nx - 1) nb[k++] = c + 1;
      if (c >= nx) nb[k++] = c - nx;
      if (c < N - nx) nb[k++] = c + nx;
      return k;
    };
    for (let c = 0; c < N; c++) {
      if (!isBlock(c)) continue;
      let best = -1;
      for (let q = neighbours(c) - 1; q >= 0; q--) {
        const n = nb[q];
        if (isBlock(n)) continue;
        if (best < 0 || (ground && ground[n] < ground[best])) best = n;
      }
      if (best >= 0) {
        owner[c] = best;
        queue[qt++] = c;
      }
    }
    while (qh < qt) {
      const c = queue[qh++];
      for (let q = neighbours(c) - 1; q >= 0; q--) {
        const n = nb[q];
        if (isBlock(n) && owner[n] < 0) {
          owner[n] = owner[c];
          queue[qt++] = n;
        }
      }
    }
    for (let c = 0; c < N; c++) if (isBlock(c) && owner[c] >= 0) spout[owner[c]] += 1;
  }

  return { obstacles, porosity: { cell, faceE, faceS, roof, spout }, blockedCells: blocked, porousCells: porous };
}
