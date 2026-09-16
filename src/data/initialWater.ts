/**
 * Initial water depth from a scenario's `initialFill` list.
 *
 * Contract semantics: every cell 4-connected to a seed through cells whose bed is below `level` gets
 * h = level − bed (4-connectivity matches the solver's face fluxes: water cannot pass diagonally).
 *
 * Extension for sloping rivers: a seed may carry its own `level` (`{ gx, gy, level }`). Seeds of one fill then
 * flood simultaneously (multi-source BFS) and every reached cell takes the level of the seed whose front got
 * there first — i.e. the geodesically nearest seed along the channel — and that first front also decides
 * whether the cell is wet. With all of a river's seeds in ONE fill, spaced along the channel, this reproduces a
 * sloping water surface without the "lake" leak where an upstream level would flood downstream
 * banks. Seeds without a level use the fill's `level`. Overlapping fills take the maximum depth.
 */
import type { ScenarioPreset, TerrainData } from '../contracts';

type Seed = { gx: number; gy: number; level?: number };

export function computeInitialWater(
  terrain: Pick<TerrainData, 'nx' | 'ny' | 'elevation'>,
  scenario: Pick<ScenarioPreset, 'initialFill'> | null,
): Float32Array {
  const { nx, ny, elevation: bed } = terrain;
  const n = nx * ny;
  const h = new Float32Array(n);
  if (!scenario || !scenario.initialFill?.length) return h;

  const levelAt = new Float32Array(n);
  const stamp = new Uint32Array(n); // visited marker per fill (fill index + 1)
  const queue = new Int32Array(n);

  scenario.initialFill.forEach((fill, f) => {
    const mark = f + 1;
    let qh = 0;
    let qt = 0;
    for (const s of fill.seeds as Seed[]) {
      const L = typeof s.level === 'number' && Number.isFinite(s.level) ? s.level : fill.level;
      if (!Number.isFinite(L)) continue;
      const k = findSeedCell(bed, nx, ny, s.gx, s.gy, L);
      if (k < 0 || stamp[k] === mark) continue;
      stamp[k] = mark;
      levelAt[k] = L;
      queue[qt++] = k;
    }
    // The FIRST front to reach a cell decides it, wet or dry. Otherwise a higher upstream front could later
    // walk along dry floodplain cells that nearer (lower) fronts had rejected.
    const nb = [0, 0, 0, 0];
    while (qh < qt) {
      const k = queue[qh++];
      const L = levelAt[k];
      const d = L - bed[k];
      if (d > h[k]) h[k] = d;
      const i = k % nx;
      const j = (k / nx) | 0;
      nb[0] = i > 0 ? k - 1 : -1;
      nb[1] = i < nx - 1 ? k + 1 : -1;
      nb[2] = j > 0 ? k - nx : -1;
      nb[3] = j < ny - 1 ? k + nx : -1;
      for (let q = 0; q < 4; q++) {
        const m = nb[q];
        if (m < 0 || stamp[m] === mark) continue;
        stamp[m] = mark;
        if (bed[m] >= L) continue;
        levelAt[m] = L;
        queue[qt++] = m;
      }
    }
  });
  return h;
}

/**
 * The seed's own cell, or — if that cell is not below the level (a seed placed a hair onto the bank) — the
 * lowest cell below the level within a 3-cell radius. −1 if none.
 */
function findSeedCell(bed: Float32Array, nx: number, ny: number, gx: number, gy: number, level: number): number {
  const ci = Math.floor(gx);
  const cj = Math.floor(gy);
  if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) return -1;
  const k0 = cj * nx + ci;
  if (bed[k0] < level) return k0;
  let best = -1;
  for (let dj = -3; dj <= 3; dj++) {
    for (let di = -3; di <= 3; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = j * nx + i;
      if (bed[k] < level && (best < 0 || bed[k] < bed[best])) best = k;
    }
  }
  return best;
}
