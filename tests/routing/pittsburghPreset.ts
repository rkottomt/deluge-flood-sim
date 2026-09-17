/**
 * The shipped Pittsburgh preset (public/presets/pittsburgh: USGS 3DEP DEM with burned river channels, Census
 * TIGER roads, scenario shelters and the Point gauge) prepared for routing checks without a GPU: the rivers
 * are raised as a "bathtub" — every cell 4-connected to the water present at load whose bed is below the new
 * level fills up to it. The rivers in this preset are flat at normal pool, so this is where the solver's
 * stage sources settle when the stage slider is raised and held.
 *
 * Used by pittsburgh.test.ts (files read from disk) and by the visual harness (?data=pgh, fetched).
 */
import type { RoadNetwork, Shelter } from '../../src/contracts';
import { geoToGrid } from '../../src/data/geo';
import { computeInitialWater } from '../../src/data/initialWater';
import { decodeElevation, type PresetMeta } from '../../src/data/presets';
import { type CompactRoads, decodeRoads } from '../../src/data/roads';

const FT = 0.3048;

export interface PittsburghWorld {
  meta: PresetMeta;
  nx: number;
  ny: number;
  cellSize: number;
  elevation: Float32Array;
  roads: RoadNetwork;
  /** Water at load (computeInitialWater) — what the app passes to router.setBaselineWater. */
  initialWater: Float32Array;
  shelters: Shelter[];
  /** Normal pool water surface, m (stage offset 0). */
  pool: number;
  /** Water surface elevation (m) for a Point-gauge reading in feet. */
  gaugeLevel(ft: number): number;
  /** Named Point-gauge marks from the scenario: flood stage and historic crests, as water surface elevations. */
  marks: Array<{ label: string; ft: number; level: number }>;
  /** Depth field with the rivers raised to `level` (m); `level` ≤ pool gives the water at load. */
  bathtub(level: number): Float32Array;
  /** Grid coordinates of a longitude / latitude. */
  at(lon: number, lat: number): { gx: number; gy: number };
}

/** Places used by the checks. */
export const PLACES = {
  /** Downtown, a block east of Market Square — on the Point, which floods first. */
  downtown: { lon: -80.0018, lat: 40.4413 },
  /** North Shore by PNC Park — on the Allegheny's flood plain. */
  northShore: { lon: -80.0057, lat: 40.4474 },
} as const;

export function pittsburghWorld(meta: PresetMeta, elevationBytes: ArrayBuffer, roads: CompactRoads): PittsburghWorld {
  const { nx, ny } = meta;
  const stage = meta.scenario.stage;
  if (!stage) throw new Error('pittsburgh preset has no stage control');
  const elevation = decodeElevation(elevationBytes, nx, ny);
  const initialWater = computeInitialWater({ nx, ny, elevation }, meta.scenario);
  const gaugeLevel = (ft: number) => stage.gaugeDatum + ft * FT;
  const marks = [
    ...(stage.floodStageFt !== undefined ? [{ label: 'flood stage', ft: stage.floodStageFt }] : []),
    ...(stage.marks ?? []),
  ].map((m) => ({ ...m, level: gaugeLevel(m.ft) }));

  const n = nx * ny;
  const queue = new Int32Array(n);
  const seen = new Uint8Array(n);
  const bathtub = (level: number): Float32Array => {
    const d = initialWater.slice();
    seen.fill(0);
    let head = 0;
    let tail = 0;
    for (let k = 0; k < n; k++) {
      if (initialWater[k] > 0) {
        seen[k] = 1;
        queue[tail++] = k;
      }
    }
    while (head < tail) {
      const k = queue[head++];
      const depth = level - elevation[k];
      if (depth <= 0 && initialWater[k] <= 0) continue;
      if (depth > d[k]) d[k] = depth;
      const i = k % nx;
      if (i > 0 && !seen[k - 1]) (seen[k - 1] = 1), (queue[tail++] = k - 1);
      if (i < nx - 1 && !seen[k + 1]) (seen[k + 1] = 1), (queue[tail++] = k + 1);
      if (k >= nx && !seen[k - nx]) (seen[k - nx] = 1), (queue[tail++] = k - nx);
      if (k + nx < n && !seen[k + nx]) (seen[k + nx] = 1), (queue[tail++] = k + nx);
    }
    return d;
  };

  return {
    meta,
    nx,
    ny,
    cellSize: meta.cellSize,
    elevation,
    roads: decodeRoads(roads),
    initialWater,
    shelters: meta.scenario.shelters,
    pool: stage.normalLevel,
    gaugeLevel,
    marks,
    bathtub,
    at: (lon, lat) => geoToGrid(meta, lon, lat),
  };
}

/** Look up a scenario mark by (part of) its label, e.g. "1936". */
export function mark(world: PittsburghWorld, label: string): { label: string; ft: number; level: number } {
  const m = world.marks.find((x) => x.label.includes(label));
  if (!m) throw new Error(`pittsburgh preset has no "${label}" stage mark (have: ${world.marks.map((x) => x.label).join(', ')})`);
  return m;
}
