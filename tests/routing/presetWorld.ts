/**
 * A shipped preset (public/presets/<id>: DEM with burned river channels, TIGER/OSM roads, scenario shelters and
 * the gauge) prepared for routing checks without a GPU.
 *
 * The flood is a "bathtub": every cell 4-connected to the water present at load whose bed is below a given water
 * surface fills up to it. That is where the solver's stage sources settle when the stage slider is raised and
 * held, so it stands in for the GPU's steady state on the stage presets (checked against the real solver in
 * artifacts/evac-story). It says nothing about rain or inflow scenarios, which never reach hydrostatic rest —
 * those are measured in the browser.
 *
 * Pure (no node:fs): the visual harness fetches the same files. Node callers use presetFiles.ts.
 */
import type { RoadNetwork, Shelter, StageControl } from '../../src/contracts';
import { geoToGrid } from '../../src/data/geo';
import { computeInitialWater } from '../../src/data/initialWater';
import { decodeElevation, type PresetMeta } from '../../src/data/presets';
import { type CompactRoads, decodeRoads } from '../../src/data/roads';

const FT = 0.3048;

export interface StageMark {
  label: string;
  ft: number;
  /** Water surface elevation, m. */
  level: number;
}

export interface PresetWorld {
  id: string;
  meta: PresetMeta;
  nx: number;
  ny: number;
  cellSize: number;
  elevation: Float32Array;
  roads: RoadNetwork;
  /** Water at load (computeInitialWater) — what the app passes to router.setBaselineWater. */
  initialWater: Float32Array;
  shelters: Shelter[];
  /** The scenario's stage control, or null for rain / inflow scenarios. */
  stage: StageControl | null;
  /** Normal pool water surface, m (stage offset 0); null without a stage control. */
  pool: number | null;
  /** Water surface elevation (m) for a gauge reading in feet (throws without a stage control). */
  gaugeLevel(ft: number): number;
  /** Named gauge marks from the scenario — flood stage and historic crests — as water surface elevations. */
  marks: StageMark[];
  /** Depth field with the water bodies raised to `level` (m); `level` ≤ pool gives the water at load. */
  bathtub(level: number): Float32Array;
  /** Grid coordinates of a longitude / latitude. */
  at(lon: number, lat: number): { gx: number; gy: number };
  /** Ground elevation (m) at a grid point. */
  groundAt(gx: number, gy: number): number;
}

export function presetWorld(meta: PresetMeta, elevationBytes: ArrayBuffer, roads: CompactRoads): PresetWorld {
  const { nx, ny } = meta;
  const stage = meta.scenario.stage ?? null;
  const elevation = decodeElevation(elevationBytes, nx, ny);
  const initialWater = computeInitialWater({ nx, ny, elevation }, meta.scenario);
  const gaugeLevel = (ft: number) => {
    if (!stage) throw new Error(`preset ${meta.id} has no stage control`);
    return stage.gaugeDatum + ft * FT;
  };
  const marks = stage
    ? [...(stage.floodStageFt !== undefined ? [{ label: 'flood stage', ft: stage.floodStageFt }] : []), ...(stage.marks ?? [])].map((m) => ({
        ...m,
        level: gaugeLevel(m.ft),
      }))
    : [];

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
    id: meta.id,
    meta,
    nx,
    ny,
    cellSize: meta.cellSize,
    elevation,
    roads: decodeRoads(roads),
    initialWater,
    shelters: meta.scenario.shelters,
    stage,
    pool: stage ? stage.normalLevel : null,
    gaugeLevel,
    marks,
    bathtub,
    at: (lon, lat) => geoToGrid(meta, lon, lat),
    groundAt: (gx, gy) => {
      const x = Math.min(nx - 1, Math.max(0, Math.floor(gx)));
      const y = Math.min(ny - 1, Math.max(0, Math.floor(gy)));
      return elevation[y * nx + x];
    },
  };
}

/** Look up a scenario mark by (part of) its label, e.g. "1936". */
export function mark(world: PresetWorld, label: string): StageMark {
  const m = world.marks.find((x) => x.label.includes(label));
  if (!m) throw new Error(`preset ${world.id} has no "${label}" stage mark (have: ${world.marks.map((x) => x.label).join(', ')})`);
  return m;
}

/**
 * The flood surface the scenario's own story reaches on a stage preset: its highest in-range gauge mark, the way
 * src/ui/welcome.ts's "Play the flood" raises the slider (dramaticStage). Throws without a stage control.
 */
export function scenarioPeakLevel(world: PresetWorld): StageMark {
  const stage = world.stage;
  if (!stage) throw new Error(`preset ${world.id} has no stage control`);
  const maxFt = (stage.normalLevel + stage.maxOffset - stage.gaugeDatum) / FT;
  const inRange = world.marks.filter((m) => m.ft <= maxFt + 0.01 && m.label !== 'flood stage').sort((a, b) => b.ft - a.ft);
  if (inRange.length) return inRange[0];
  return { label: `${maxFt.toFixed(0)} ft`, ft: maxFt, level: world.gaugeLevel(maxFt) };
}
