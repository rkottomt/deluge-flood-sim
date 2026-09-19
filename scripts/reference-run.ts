/**
 * Grid-convergence reference runs: the shipping solver on the shipping Pittsburgh scenario, at 1024², 2048² and
 * 4096², compared cell by cell.
 *
 *   npx tsx scripts/reference-run.ts                          # default ladder, both cases, 45 sim-minutes
 *   npx tsx scripts/reference-run.ts --grids=1024,2048         # skip the expensive one
 *   npx tsx scripts/reference-run.ts --cases=crest --minutes=30
 *   npx tsx scripts/reference-run.ts --bed=nearest             # sensitivity: piecewise-constant bed refinement
 *   npx tsx scripts/reference-run.ts --compare-only            # re-derive metrics from saved fields (no GPU)
 *
 * WHAT THIS IS. The same `src/sim` solver (GPU, Dawn → Metal in Node) runs the same two scenarios on three grids
 * that differ only in cell size, and we measure how far the 1024² demo grid is from the finest run. This is a mesh
 * refinement study: it bounds the solver's DISCRETISATION error. It is not ground truth — see §"What this does not
 * prove" in ARCHITECTURE.md §9.
 *
 * WHAT IS HELD IDENTICAL ACROSS GRIDS (this is the whole point — anything else and the comparison measures the
 * harness, not the solver):
 *  • The bed. One 7.8 m DEM (`public/presets/pittsburgh/elevation.f32`) defines a single continuous surface; each
 *    grid samples THAT surface at its own cell centres (`--bed=bilinear`, the default) or replicates coarse cells
 *    exactly (`--bed=nearest`). The finer grids add no real terrain detail — they resolve the same band-limited
 *    bed more finely. Consequence, stated plainly in the report: this measures numerics, not DEM resolution.
 *  • The initial condition. The scenario's `initialFill` wetted footprint is taken once, on the 1024² grid, and
 *    replicated (piecewise-constant) to the finer grids, then filled to the same water surface (216.3 m). Re-running
 *    the flood fill per grid would let a bilinearly-smoothed bank open a new connection and change the wetted
 *    footprint, which would swamp the comparison.
 *  • The forcing, in metres and seconds. Stage-source centres and radii are grid coordinates, so they scale by the
 *    refinement factor; levels, discharges and rain rates do not.
 *  • The control cadence, in SIMULATED time: the stage ramp is advanced every `--tick` sim-seconds and pushed to the
 *    solver at the app's 5 cm granularity (src/app/App.ts STAGE_PUSH_STEP_M), and a readback is taken every
 *    `--sample` sim-seconds. The solver's CFL estimate reads back maxima, so a wall-clock cadence would give the
 *    grids different timesteps for reasons that have nothing to do with dx.
 *
 * WHAT IS NOT identical, on purpose: the timestep. Each grid runs at its own CFL limit from the shipping
 * `Solver.computeDt()` (dt ∝ dx), snapped down so a whole number of substeps lands exactly on each tick — so every
 * grid is at the same simulated time at every comparison point.
 *
 * SCENARIOS (both from `public/presets/pittsburgh/meta.json`, nothing invented here):
 *  • `crest` — the 1936 St. Patrick's Day flood: the river stage ramps from normal pool to 46 ft on the Point gauge
 *    at the app's rate (src/app/stageRamp.ts), with the channel raise of src/app/crest.ts, then holds.
 *  • `rain`  — 100 mm/hr over the whole domain, rivers at normal pool. Overland sheet flow at centimetre depths is
 *    where cell size should hurt most, so it is the harder of the two for the demo grid.
 *
 * OUTPUT (all under --out, default artifacts/reference-run/):
 *   runs/<case>-<grid>-<bed>.json     one run: stats, timings, landmark arrival series, provenance
 *   fields/<case>-<grid>-<bed>.maxdepth.f32, .depth.f32   raw Float32 fields, so `--compare-only` can redo the
 *                                     metrics without a GPU — and so a 4096² run done on a cloud box can be
 *                                     scp'd back and compared here
 *   results.json, results.md          the comparison table
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { create, globals } from 'webgpu';
import { createDelugeDevice } from '../src/gpu';
import { createSolver, type GpuFloodSolver } from '../src/sim';
import { WET_DEPTH } from '../src/sim/constants';
import { channelBaseSurface } from '../src/app/crest';
import { StageRamp } from '../src/app/stageRamp';
import { StageLevels, stageOffsetForFeet } from '../src/app/stage';
import { geoToGrid } from '../src/data/geo';
import { computeInitialWater } from '../src/data/initialWater';
import { decodeElevation, type PresetMeta } from '../src/data/presets';
import type { SimParams, SimStats, StormCell, WaterSource } from '../src/contracts';

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Tunables that define the measurement (every one of them appears in the report)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Depth that counts as "flooded" for extent, area and IoU, m. The app's hazard legend starts here. */
export const FLOOD_THRESHOLD_M = 0.15;
/** Point-gauge stage the crest case ramps to, ft (the preset's "1936 record" mark). */
const CREST_FT = 46;
/** Rain rate of the rain case, mm/hr. */
const RAIN_MM_HR = 100;
/** Radius of the disc a landmark probe averages over, m — the same patch of ground on every grid. */
const PROBE_RADIUS_M = 25;
/** The app pushes a moved stage to the solver every 5 cm (src/app/App.ts STAGE_PUSH_STEP_M). */
const STAGE_PUSH_STEP_M = 0.05;

/**
 * Landmark probes. Six sites the 1936 flood reached (the ones the NWS impact statements name, see ARCHITECTURE.md
 * §4) plus three dry controls on high ground — a grid that floods Mount Washington is wrong in a way no
 * area-agreement number would show.
 */
const LANDMARKS: Array<{ name: string; lon: number; lat: number; expect: 'wet' | 'dry' }> = [
  { name: 'Point State Park', lon: -80.0098, lat: 40.4417, expect: 'wet' },
  { name: 'Acrisure Stadium', lon: -80.0157, lat: 40.4468, expect: 'wet' },
  { name: 'PNC Park (North Shore)', lon: -80.0057, lat: 40.4474, expect: 'wet' },
  { name: 'Strip District (16th St)', lon: -79.9875, lat: 40.4507, expect: 'wet' },
  { name: 'Station Square', lon: -80.0053, lat: 40.4344, expect: 'wet' },
  { name: 'Market Square (downtown)', lon: -80.0018, lat: 40.4413, expect: 'wet' },
  { name: 'Grant Street ridge', lon: -79.9958, lat: 40.44, expect: 'dry' },
  { name: 'Mount Washington', lon: -80.0072, lat: 40.4327, expect: 'dry' },
  { name: 'Cathedral of Learning', lon: -79.9533, lat: 40.4443, expect: 'dry' },
];

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests/sim/referenceMetrics.test.ts)
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type BedMode = 'bilinear' | 'nearest';

/**
 * Refine an n0² field to (n0·r)² .
 *  • 'bilinear': sample the continuous bilinear interpolant of the coarse cell CENTRES at the fine cell centres
 *    (clamped at the border). The finer grid then resolves the same smooth surface more finely.
 *  • 'nearest': replicate each coarse cell into its r² fine cells. Exactly the same piecewise-constant surface, so
 *    block means — and therefore the initial water volume — are preserved to the bit.
 */
export function refineField(src: Float32Array, n0: number, r: number, mode: BedMode): Float32Array {
  if (r === 1) return src.slice();
  const n = n0 * r;
  const out = new Float32Array(n * n);
  if (mode === 'nearest') {
    for (let j = 0; j < n; j++) {
      const j0 = (j / r) | 0;
      for (let i = 0; i < n; i++) out[j * n + i] = src[j0 * n0 + ((i / r) | 0)];
    }
    return out;
  }
  const clamp = (v: number) => (v < 0 ? 0 : v > n0 - 1 ? n0 - 1 : v);
  for (let j = 0; j < n; j++) {
    const fy = (j + 0.5) / r - 0.5;
    const jf = Math.floor(fy);
    const j0 = clamp(jf);
    const j1 = clamp(jf + 1);
    const ty = fy <= 0 ? 0 : fy >= n0 - 1 ? 1 : fy - jf;
    for (let i = 0; i < n; i++) {
      const fx = (i + 0.5) / r - 0.5;
      const iF = Math.floor(fx);
      const i0 = clamp(iF);
      const i1 = clamp(iF + 1);
      const tx = fx <= 0 ? 0 : fx >= n0 - 1 ? 1 : fx - iF;
      const a = src[j0 * n0 + i0] * (1 - tx) + src[j0 * n0 + i1] * tx;
      const b = src[j1 * n0 + i0] * (1 - tx) + src[j1 * n0 + i1] * tx;
      out[j * n + i] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

/** Replicate an n0² byte mask into (n0·r)² cells. */
export function refineMask(src: Uint8Array, n0: number, r: number): Uint8Array {
  if (r === 1) return src.slice();
  const n = n0 * r;
  const out = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    const j0 = (j / r) | 0;
    for (let i = 0; i < n; i++) out[j * n + i] = src[j0 * n0 + ((i / r) | 0)];
  }
  return out;
}

/** Block mean of an n² field down to (n/r)² — the conservative coarsening (r² fine cells → one coarse cell). */
export function blockMean(src: Float32Array, n: number, r: number): Float32Array {
  if (r === 1) return src.slice();
  const m = n / r;
  const out = new Float64Array(m * m);
  for (let j = 0; j < n; j++) {
    const jo = ((j / r) | 0) * m;
    for (let i = 0; i < n; i++) out[jo + ((i / r) | 0)] += src[j * n + i];
  }
  const inv = 1 / (r * r);
  const f = new Float32Array(m * m);
  for (let k = 0; k < f.length; k++) f[k] = out[k] * inv;
  return f;
}

/** mask[k] = 1 where field[k] ≥ threshold (non-finite counts as 0 and is reported separately). */
export function maskAtLeast(field: Float32Array, threshold: number): Uint8Array {
  const m = new Uint8Array(field.length);
  for (let k = 0; k < field.length; k++) if (field[k] >= threshold) m[k] = 1;
  return m;
}

/** mask[k] = a[k] && b[k] (in place on a fresh array). */
export function maskAnd(a: Uint8Array, b: Uint8Array): Uint8Array {
  const m = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) if (a[k] && b[k]) m[k] = 1;
  return m;
}

export function maskCount(m: Uint8Array): number {
  let c = 0;
  for (let k = 0; k < m.length; k++) c += m[k];
  return c;
}

/** Intersection over union of two equally long masks, plus the raw counts. */
export function iou(a: Uint8Array, b: Uint8Array): { iou: number; inter: number; union: number; onlyA: number; onlyB: number } {
  let inter = 0;
  let onlyA = 0;
  let onlyB = 0;
  for (let k = 0; k < a.length; k++) {
    const x = a[k];
    const y = b[k];
    if (x && y) inter++;
    else if (x) onlyA++;
    else if (y) onlyB++;
  }
  const union = inter + onlyA + onlyB;
  return { iou: union > 0 ? inter / union : 1, inter, union, onlyA, onlyB };
}

/** RMSE, mean |Δ| (L1) and max |Δ| of two fields over `mask` (all cells when mask is null). */
export function fieldError(
  a: Float32Array,
  b: Float32Array,
  mask: Uint8Array | null,
): { rmse: number; l1: number; maxAbs: number; cells: number; nonFinite: number } {
  let sq = 0;
  let abs = 0;
  let maxAbs = 0;
  let cells = 0;
  let nonFinite = 0;
  for (let k = 0; k < a.length; k++) {
    if (mask && !mask[k]) continue;
    const d = a[k] - b[k];
    if (!Number.isFinite(d)) {
      nonFinite++;
      continue;
    }
    cells++;
    sq += d * d;
    abs += Math.abs(d);
    if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d);
  }
  return { rmse: cells ? Math.sqrt(sq / cells) : 0, l1: cells ? abs / cells : 0, maxAbs, cells, nonFinite };
}

/** Row-major indices of the cells whose centres lie within `radius` cells of (gx, gy), clipped to the grid. */
export function discCells(nx: number, ny: number, gx: number, gy: number, radius: number): Int32Array {
  const out: number[] = [];
  const i0 = Math.max(0, Math.floor(gx - radius));
  const i1 = Math.min(nx - 1, Math.ceil(gx + radius));
  const j0 = Math.max(0, Math.floor(gy - radius));
  const j1 = Math.min(ny - 1, Math.ceil(gy + radius));
  const r2 = radius * radius;
  for (let j = j0; j <= j1; j++) {
    for (let i = i0; i <= i1; i++) {
      const dx = i + 0.5 - gx;
      const dy = j + 0.5 - gy;
      if (dx * dx + dy * dy <= r2) out.push(j * nx + i);
    }
  }
  // A radius below half a cell can miss every centre: fall back to the containing cell.
  if (out.length === 0) {
    const i = Math.min(nx - 1, Math.max(0, Math.floor(gx)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor(gy)));
    out.push(j * nx + i);
  }
  return Int32Array.from(out);
}

/**
 * First time a probe series crosses `threshold`, linearly interpolated between the two straddling samples
 * (the samples are `sampleSeconds` apart, so interpolation is what makes an arrival-time difference smaller than
 * the sampling interval meaningful). null = never crossed.
 */
export function arrivalTime(times: number[], values: number[], threshold: number): number | null {
  for (let k = 0; k < values.length; k++) {
    if (!(values[k] >= threshold)) continue;
    if (k === 0) return times[0];
    const v0 = values[k - 1];
    const v1 = values[k];
    const f = v1 > v0 ? (threshold - v0) / (v1 - v0) : 1;
    return times[k - 1] + f * (times[k] - times[k - 1]);
  }
  return null;
}

/** Percentage difference of `a` against reference `b`, or null when the reference is zero. */
export function pctDiff(a: number, b: number): number | null {
  return b === 0 ? null : ((a - b) / b) * 100;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Preset → grid
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../..');
const PRESET_DIR = path.join(ROOT, 'public/presets/pittsburgh');

interface Preset {
  meta: PresetMeta;
  elevation: Float32Array;
  /** Wetted footprint of the scenario's initial fill on the BAKED grid (the one authority for every grid). */
  wet0: Uint8Array;
  /** Water surface of that fill, m (all of Pittsburgh's seeds share one level). */
  fillLevel: number;
}

function loadPreset(): Preset {
  const meta = JSON.parse(fs.readFileSync(path.join(PRESET_DIR, 'meta.json'), 'utf8')) as PresetMeta;
  const raw = fs.readFileSync(path.join(PRESET_DIR, meta.files.elevation));
  const elevation = decodeElevation(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), meta.nx, meta.ny);
  const h0 = computeInitialWater({ nx: meta.nx, ny: meta.ny, elevation }, meta.scenario);
  const wet0 = new Uint8Array(h0.length);
  for (let k = 0; k < h0.length; k++) if (h0[k] > 0) wet0[k] = 1;
  const fills = meta.scenario.initialFill;
  const levels = new Set<number>();
  for (const f of fills) for (const s of f.seeds) levels.add(typeof s.level === 'number' ? s.level : f.level);
  if (levels.size !== 1) {
    throw new Error(`reference-run assumes one initial-fill level; this preset has ${[...levels].join(', ')}`);
  }
  return { meta, elevation, wet0, fillLevel: [...levels][0] };
}

interface Grid {
  n: number;
  /** Refinement factor against the baked 1024² grid. */
  r: number;
  cellSize: number;
  elevation: Float32Array;
  initialWater: Float32Array;
  /** 1 where the initial fill is dry (h < WET_DEPTH): the land a flood can newly cover. */
  dry0: Uint8Array;
  storms: StormCell[];
  sources: WaterSource[];
  /** Channel water surface for the crest raise (src/app/crest.ts), or null. */
  channelBase: Float32Array | null;
  channelCells: number;
  initialVolume: number;
}

/**
 * Build the n² version of the preset. Everything physical (metres, seconds, elevations, discharges) is unchanged;
 * only cell-indexed quantities are scaled.
 */
function buildGrid(p: Preset, n: number, bed: BedMode): Grid {
  const n0 = p.meta.nx;
  if (n % n0 !== 0) throw new Error(`grid ${n} is not a whole multiple of the baked ${n0}`);
  const r = n / n0;
  const cellSize = (p.meta.cellSize * n0) / n;
  const elevation = refineField(p.elevation, n0, r, bed);
  const wet = refineMask(p.wet0, n0, r);
  const initialWater = new Float32Array(n * n);
  for (let k = 0; k < initialWater.length; k++) {
    if (wet[k]) initialWater[k] = Math.max(0, p.fillLevel - elevation[k]);
  }
  const dry0 = new Uint8Array(n * n);
  for (let k = 0; k < dry0.length; k++) if (initialWater[k] < WET_DEPTH) dry0[k] = 1;
  const sources = p.meta.scenario.sources.map((s) => ({ ...s, gx: s.gx * r, gy: s.gy * r, radius: s.radius * r }));
  const storms = p.meta.scenario.storms.map((s) => ({ ...s, gx: s.gx * r, gy: s.gy * r, radius: s.radius * r }));
  const channelBase = channelBaseSurface(initialWater, (k) => elevation[k], n, n, sources);
  let channelCells = 0;
  if (channelBase) for (let k = 0; k < channelBase.length; k++) if (channelBase[k] === channelBase[k]) channelCells++;
  let vol = 0;
  for (let k = 0; k < initialWater.length; k++) vol += initialWater[k];
  return {
    n,
    r,
    cellSize,
    elevation,
    initialWater,
    dry0,
    storms,
    sources,
    channelBase,
    channelCells,
    initialVolume: vol * cellSize * cellSize,
  };
}

/**
 * GPU bytes the solver allocates for an n² grid, from the resource list in src/sim/Solver.ts (there is no API to
 * ask Dawn, and on unified memory the process RSS does not show it): 2 state + 2 export rgba32float (64 B/cell),
 * 1 flux rg32float (8), ground+barrier+bed r32float (12), accounting (8), depth readback (4), the dry mask (1/8),
 * up to two staging depth buffers (8), the reset cache below 2²⁰ cells (16) and the raise base when a run uses it (4).
 */
export function gpuBytesEstimate(n: number, opts: { raise: boolean }): number {
  const N = n * n;
  let perCell = 64 + 8 + 12 + 8 + 4 + 0.125 + 8;
  if (N <= 1 << 20) perCell += 16;
  if (opts.raise) perCell += 4;
  return Math.round(N * perCell);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// One run
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

type CaseId = 'crest' | 'rain';

interface RunOptions {
  case: CaseId;
  grid: number;
  bed: BedMode;
  /** Simulated seconds to run. */
  duration: number;
  /** Simulated seconds between stage-ramp updates. */
  tick: number;
  /** Simulated seconds between readbacks (landmark samples + the CFL's view of the flow). */
  sample: number;
}

interface LandmarkResult {
  name: string;
  expect: 'wet' | 'dry';
  lon: number;
  lat: number;
  gx: number;
  gy: number;
  bedElevation: number;
  /** Cells averaged for the disc probe (PROBE_RADIUS_M). */
  discCells: number;
  /** Arrival time of FLOOD_THRESHOLD_M, s, disc mean and containing cell; null = never. */
  arrival: number | null;
  arrivalCell: number | null;
  peak: number;
  peakCell: number;
  final: number;
}

interface RunResult {
  case: CaseId;
  grid: number;
  bed: BedMode;
  cellSize: number;
  duration: number;
  tick: number;
  sample: number;
  substeps: number;
  dtMean: number;
  dtMin: number;
  dtMax: number;
  wallClockS: number;
  peakRssMB: number;
  gpuBytesEstimate: number;
  initialVolume: number;
  stats: SimStats;
  /** Final stage offset applied (crest case), m, and the gauge reading it corresponds to. */
  stageOffset: number;
  landmarks: LandmarkResult[];
  /** Files holding the raw fields, relative to the output directory. */
  fields: { maxDepth: string; depth: string };
  nonFiniteCells: number;
  gpu: string;
  startedAt: string;
  host: string;
}

function runKey(o: { case: CaseId; grid: number; bed: BedMode }): string {
  return `${o.case}-${o.grid}-${o.bed}`;
}

async function runOne(device: GPUDevice, gpuName: string, p: Preset, grid: Grid, o: RunOptions, outDir: string): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const n = grid.n;
  const isCrest = o.case === 'crest';
  const stage = p.meta.scenario.stage;
  if (isCrest && !stage) throw new Error('crest case needs a stage control');
  // Manning's n, the stability mode and the CFL number are left at DEFAULT_SIM_PARAMS — exactly what the app ships.
  const params: Partial<SimParams> = { rainRate: isCrest ? p.meta.scenario.rainRate : RAIN_MM_HR, boundary: 'open' };

  // gpuBudgetMs: Infinity — we pace the solver ourselves (runSubsteps bypasses the budget anyway, and Infinity
  // stops it spending timestamp readbacks it cannot use). Every other numerical option stays at its shipped default.
  const solver: GpuFloodSolver = await createSolver(
    device,
    { nx: n, ny: n, cellSize: grid.cellSize, elevation: grid.elevation },
    params,
    { gpuBudgetMs: Infinity },
  );
  solver.setInitialWater(grid.initialWater);
  const levels = new StageLevels();
  levels.resetFrom(grid.sources);
  solver.setSources(levels.apply(grid.sources, 0));
  solver.setStorms(grid.storms);
  if (isCrest && grid.channelBase) solver.prepareRaiseSurface(grid.channelBase);

  const probes = LANDMARKS.map((L) => {
    const g = geoToGrid({ nx: n, ny: n, bounds: p.meta.bounds }, L.lon, L.lat);
    const cell = Math.min(n - 1, Math.max(0, Math.floor(g.gy))) * n + Math.min(n - 1, Math.max(0, Math.floor(g.gx)));
    return {
      ...L,
      gx: g.gx,
      gy: g.gy,
      cell,
      cells: discCells(n, n, g.gx, g.gy, PROBE_RADIUS_M / grid.cellSize),
      disc: [] as number[],
      point: [] as number[],
    };
  });
  const times: number[] = [];

  const ramp = new StageRamp();
  const target = isCrest && stage ? stageOffsetForFeet(stage, CREST_FT) : 0;
  ramp.setTarget(target);
  let pushed = 0;

  let substeps = 0;
  let dtSum = 0;
  let dtMin = Infinity;
  let dtMax = 0;
  let peakRss = process.memoryUsage().rss;
  let simTime = 0;
  let nextSample = 0;
  const t0 = performance.now();
  const sample = async () => {
    const snap = await solver.readbackNow();
    times.push(snap.simTime);
    for (const pr of probes) {
      let s = 0;
      for (let k = 0; k < pr.cells.length; k++) s += snap.depth[pr.cells[k]];
      pr.disc.push(s / pr.cells.length);
      pr.point.push(snap.depth[pr.cell]);
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    return snap;
  };
  await sample();
  nextSample = o.sample;

  let lastLog = performance.now();
  while (simTime < o.duration - 1e-9) {
    const tick = Math.min(o.tick, o.duration - simTime);
    if (isCrest && ramp.advance(tick)) {
      // Exactly the app's rule (App.advanceStage): push the moved stage at 5 cm granularity, or on arrival.
      if (Math.abs(ramp.applied - pushed) >= STAGE_PUSH_STEP_M || !ramp.moving) {
        pushed = ramp.applied;
        solver.setSources(levels.apply(grid.sources, pushed));
        if (grid.channelBase) solver.raiseWaterSurface(grid.channelBase, pushed);
      }
    }
    // Whole substeps landing exactly on the tick, at or below the solver's own CFL timestep: every grid is at the
    // same simulated time at every sample, and dt still falls with dx the way the CFL rule says.
    const cfl = solver.computeDt();
    const k = Math.max(1, Math.ceil(tick / cfl));
    const dt = tick / k;
    solver.runSubsteps(k, dt);
    substeps += k;
    dtSum += dt * k;
    dtMin = Math.min(dtMin, dt);
    dtMax = Math.max(dtMax, dt);
    simTime += tick;
    if (simTime >= nextSample - 1e-9) {
      await sample();
      nextSample = simTime + o.sample;
      if (performance.now() - lastLog > 15000) {
        lastLog = performance.now();
        const frac = simTime / o.duration;
        const el = (performance.now() - t0) / 1000;
        process.stdout.write(
          `    ${o.case} ${n}²  ${(frac * 100).toFixed(0)}%  sim ${(simTime / 60).toFixed(1)} min  ` +
            `dt ${dt.toFixed(4)}s  ${substeps} substeps  ${el.toFixed(0)}s elapsed, ~${(el / Math.max(frac, 1e-6) - el).toFixed(0)}s left\n`,
        );
      }
    }
  }
  const snap = await sample();
  await solver.flush();
  const wallClockS = (performance.now() - t0) / 1000;

  // Final fields: the export texture is (h, u, v, maxDepth since reset).
  const state = await solver.readTexture(solver.stateTexture, 4);
  const N = n * n;
  const maxDepth = new Float32Array(N);
  const depth = new Float32Array(N);
  let nonFinite = 0;
  for (let c = 0; c < N; c++) {
    depth[c] = state[4 * c];
    maxDepth[c] = state[4 * c + 3];
    if (!Number.isFinite(depth[c]) || !Number.isFinite(maxDepth[c])) nonFinite++;
  }
  peakRss = Math.max(peakRss, process.memoryUsage().rss);

  const key = runKey(o);
  const fieldsDir = path.join(outDir, 'fields');
  fs.mkdirSync(fieldsDir, { recursive: true });
  const fMax = `fields/${key}.maxdepth.f32`;
  const fDep = `fields/${key}.depth.f32`;
  fs.writeFileSync(path.join(outDir, fMax), Buffer.from(maxDepth.buffer, 0, maxDepth.byteLength));
  fs.writeFileSync(path.join(outDir, fDep), Buffer.from(depth.buffer, 0, depth.byteLength));

  const landmarks: LandmarkResult[] = probes.map((pr) => ({
    name: pr.name,
    expect: pr.expect,
    lon: pr.lon,
    lat: pr.lat,
    gx: pr.gx,
    gy: pr.gy,
    bedElevation: grid.elevation[pr.cell],
    discCells: pr.cells.length,
    arrival: arrivalTime(times, pr.disc, FLOOD_THRESHOLD_M),
    arrivalCell: arrivalTime(times, pr.point, FLOOD_THRESHOLD_M),
    peak: Math.max(...pr.disc),
    peakCell: Math.max(...pr.point),
    final: pr.disc[pr.disc.length - 1],
  }));

  const result: RunResult = {
    case: o.case,
    grid: n,
    bed: o.bed,
    cellSize: grid.cellSize,
    duration: o.duration,
    tick: o.tick,
    sample: o.sample,
    substeps,
    dtMean: dtSum / Math.max(1, substeps),
    dtMin: Number.isFinite(dtMin) ? dtMin : 0,
    dtMax,
    wallClockS,
    peakRssMB: peakRss / 1e6,
    gpuBytesEstimate: gpuBytesEstimate(n, { raise: isCrest && !!grid.channelBase }),
    initialVolume: grid.initialVolume,
    stats: snap.stats,
    stageOffset: ramp.applied,
    landmarks,
    fields: { maxDepth: fMax, depth: fDep },
    nonFiniteCells: nonFinite,
    gpu: gpuName,
    startedAt,
    host: `${os.platform()} ${os.arch()} ${os.cpus()[0]?.model ?? '?'} node ${process.version}`,
  };
  fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(outDir, 'runs', `${key}.json`), `${JSON.stringify(result, null, 1)}\n`);
  solver.destroy();
  await device.queue.onSubmittedWorkDone();
  return result;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Comparison
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Comparison {
  case: CaseId;
  bed: BedMode;
  coarse: number;
  fine: number;
  /** Refinement factor between them, and the cell-count ratio. */
  refine: number;
  cells: number;
  /** Wet extent (maxDepth ≥ threshold), whole domain. */
  extent: { coarseKm2: number; fineKm2: number; pct: number | null; iou: number; onlyCoarseKm2: number; onlyFineKm2: number };
  /** Newly flooded land only (maxDepth ≥ threshold on ground the initial fill left dry) — the headline number. */
  flooded: { coarseKm2: number; fineKm2: number; pct: number | null; iou: number; onlyCoarseKm2: number; onlyFineKm2: number };
  /** Max-depth field error on the FINE grid, coarse replicated cell-for-cell. */
  maxDepthFine: { rmse: number; l1: number; maxAbs: number; cells: number };
  /** Same, restricted to the union of the two newly-flooded masks. */
  maxDepthFlooded: { rmse: number; l1: number; maxAbs: number; cells: number };
  /** Max-depth error after block-averaging the fine field onto the coarse grid (what the coarse grid can represent). */
  maxDepthCoarsened: { rmse: number; l1: number; maxAbs: number; cells: number };
  /** Same, restricted to the coarse grid's newly-flooded cells. */
  maxDepthCoarsenedFlooded: { rmse: number; l1: number; maxAbs: number; cells: number };
  /** Final depth field, same two frames. */
  depthFine: { rmse: number; l1: number; maxAbs: number; cells: number };
  depthCoarsenedFlooded: { rmse: number; l1: number; maxAbs: number; cells: number };
  /** Volume held at the end, m³. */
  volume: { coarse: number; fine: number; pct: number | null };
  landmarks: Array<{
    name: string;
    expect: 'wet' | 'dry';
    coarseArrival: number | null;
    fineArrival: number | null;
    dArrival: number | null;
    coarsePeak: number;
    finePeak: number;
    dPeak: number;
  }>;
}

function loadField(outDir: string, rel: string, cells: number): Float32Array {
  const buf = fs.readFileSync(path.join(outDir, rel));
  if (buf.byteLength !== cells * 4) throw new Error(`${rel}: ${buf.byteLength} bytes, expected ${cells * 4}`);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function trim(e: { rmse: number; l1: number; maxAbs: number; cells: number }) {
  return { rmse: e.rmse, l1: e.l1, maxAbs: e.maxAbs, cells: e.cells };
}

function compare(outDir: string, p: Preset, coarse: RunResult, fine: RunResult): Comparison {
  const r = fine.grid / coarse.grid;
  const nc = coarse.grid;
  const nf = fine.grid;
  const areaC = coarse.cellSize * coarse.cellSize;
  const areaF = fine.cellSize * fine.cellSize;
  const km2 = 1e-6;

  const mdC = loadField(outDir, coarse.fields.maxDepth, nc * nc);
  const mdF = loadField(outDir, fine.fields.maxDepth, nf * nf);
  const dC = loadField(outDir, coarse.fields.depth, nc * nc);
  const dF = loadField(outDir, fine.fields.depth, nf * nf);

  // Each grid's own initially-dry land: a flood map is "new water on ground this grid started dry".
  const dryC = buildDryMask(p, nc, coarse.bed);
  const dryF = buildDryMask(p, nf, fine.bed);

  const extentC = maskAtLeast(mdC, FLOOD_THRESHOLD_M);
  const extentF = maskAtLeast(mdF, FLOOD_THRESHOLD_M);
  const floodC = maskAnd(extentC, dryC);
  const floodF = maskAnd(extentF, dryF);

  const extentCf = refineMask(extentC, nc, r);
  const floodCf = refineMask(floodC, nc, r);
  const mdCf = refineField(mdC, nc, r, 'nearest');
  const dCf = refineField(dC, nc, r, 'nearest');

  const extIou = iou(extentCf, extentF);
  const floodIou = iou(floodCf, floodF);
  const unionFlood = new Uint8Array(nf * nf);
  for (let k = 0; k < unionFlood.length; k++) if (floodCf[k] || floodF[k]) unionFlood[k] = 1;

  // Coarse frame: block-average the fine field down. This asks the fairer question — does the demo grid get the
  // answer right at the scales it can represent at all — and separates that from structure below 7.8 m.
  const mdFc = blockMean(mdF, nf, r);
  const dFc = blockMean(dF, nf, r);

  const extentKm2C = maskCount(extentC) * areaC * km2;
  const extentKm2F = maskCount(extentF) * areaF * km2;
  const floodKm2C = maskCount(floodC) * areaC * km2;
  const floodKm2F = maskCount(floodF) * areaF * km2;

  const lm = coarse.landmarks.map((a, i) => {
    const b = fine.landmarks[i];
    return {
      name: a.name,
      expect: a.expect,
      coarseArrival: a.arrival,
      fineArrival: b.arrival,
      dArrival: a.arrival !== null && b.arrival !== null ? a.arrival - b.arrival : null,
      coarsePeak: a.peak,
      finePeak: b.peak,
      dPeak: a.peak - b.peak,
    };
  });

  return {
    case: coarse.case,
    bed: coarse.bed,
    coarse: nc,
    fine: nf,
    refine: r,
    cells: r * r,
    extent: {
      coarseKm2: extentKm2C,
      fineKm2: extentKm2F,
      pct: pctDiff(extentKm2C, extentKm2F),
      iou: extIou.iou,
      onlyCoarseKm2: extIou.onlyA * areaF * km2,
      onlyFineKm2: extIou.onlyB * areaF * km2,
    },
    flooded: {
      coarseKm2: floodKm2C,
      fineKm2: floodKm2F,
      pct: pctDiff(floodKm2C, floodKm2F),
      iou: floodIou.iou,
      onlyCoarseKm2: floodIou.onlyA * areaF * km2,
      onlyFineKm2: floodIou.onlyB * areaF * km2,
    },
    maxDepthFine: trim(fieldError(mdCf, mdF, null)),
    maxDepthFlooded: trim(fieldError(mdCf, mdF, unionFlood)),
    maxDepthCoarsened: trim(fieldError(mdC, mdFc, null)),
    maxDepthCoarsenedFlooded: trim(fieldError(mdC, mdFc, floodC)),
    depthFine: trim(fieldError(dCf, dF, null)),
    depthCoarsenedFlooded: trim(fieldError(dC, dFc, floodC)),
    volume: { coarse: coarse.stats.volume, fine: fine.stats.volume, pct: pctDiff(coarse.stats.volume, fine.stats.volume) },
    landmarks: lm,
  };
}

/** The initially-dry mask of an n² grid (cheap to rebuild; avoids carrying it through the run files). */
function buildDryMask(p: Preset, n: number, bed: BedMode): Uint8Array {
  const r = n / p.meta.nx;
  const elevation = refineField(p.elevation, p.meta.nx, r, bed);
  const wet = refineMask(p.wet0, p.meta.nx, r);
  const dry = new Uint8Array(n * n);
  for (let k = 0; k < dry.length; k++) {
    const h = wet[k] ? Math.max(0, p.fillLevel - elevation[k]) : 0;
    if (h < WET_DEPTH) dry[k] = 1;
  }
  return dry;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Report
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

const f2 = (v: number) => v.toFixed(2);
const sgn = (v: number | null, digits = 1, unit = '') => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}${unit}`);
const mins = (s: number) => `${(s / 60).toFixed(0)} min`;

function markdown(runs: RunResult[], comps: Comparison[], p: Preset): string {
  const L: string[] = [];
  const first = runs[0];
  L.push('# Deluge — grid-convergence reference runs');
  L.push('');
  L.push(`Pittsburgh preset (8 km square, baked at ${p.meta.nx}² / ${p.meta.cellSize.toFixed(4)} m), same \`src/sim\` solver on every grid.`);
  L.push(`Generated ${new Date().toISOString()} · ${first?.gpu ?? '?'} · ${first?.host ?? '?'}`);
  L.push('');
  L.push('## Runs');
  L.push('');
  L.push('| Case | Grid | dx (m) | Sim duration | Substeps | mean dt (s) | Wall clock | GPU alloc | Peak RSS | mass error | max depth (m) | wet area (km²) | flooded area (km², h > 0.3) |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of runs) {
    L.push(
      `| ${r.case} | ${r.grid}² | ${r.cellSize.toFixed(3)} | ${mins(r.duration)} | ${r.substeps.toLocaleString('en-US')} | ${r.dtMean.toFixed(4)} | ` +
        `${r.wallClockS < 90 ? `${r.wallClockS.toFixed(0)} s` : `${(r.wallClockS / 60).toFixed(1)} min`} | ${(r.gpuBytesEstimate / 1e9).toFixed(2)} GB | ` +
        `${r.peakRssMB.toFixed(0)} MB | ${r.stats.massError.toExponential(1)} | ${f2(r.stats.maxDepth)} | ${(r.stats.wetArea / 1e6).toFixed(3)} | ${(r.stats.floodedArea / 1e6).toFixed(3)} |`,
    );
  }
  L.push('');
  for (const c of comps) {
    L.push(`## ${c.case}: ${c.coarse}² vs ${c.fine}² (${c.cells}× the cells, bed refinement \`${c.bed}\`)`);
    L.push('');
    L.push('| Measure | Value |');
    L.push('| --- | --- |');
    L.push(
      `| Newly flooded land, ${c.coarse}² / ${c.fine}² | ${c.flooded.coarseKm2.toFixed(3)} km² / ${c.flooded.fineKm2.toFixed(3)} km² (${sgn(c.flooded.pct, 2, ' %')}) |`,
    );
    L.push(`| Newly flooded IoU (≥ ${FLOOD_THRESHOLD_M} m) | ${(c.flooded.iou * 100).toFixed(1)} % |`);
    L.push(
      `| — disagreement | ${c.flooded.onlyCoarseKm2.toFixed(3)} km² only ${c.coarse}², ${c.flooded.onlyFineKm2.toFixed(3)} km² only ${c.fine}² |`,
    );
    L.push(
      `| Total wet extent, ${c.coarse}² / ${c.fine}² | ${c.extent.coarseKm2.toFixed(3)} km² / ${c.extent.fineKm2.toFixed(3)} km² (${sgn(c.extent.pct, 2, ' %')}), IoU ${(c.extent.iou * 100).toFixed(1)} % |`,
    );
    L.push(`| Water held at the end | ${sgn(c.volume.pct, 2, ' %')} (${(c.volume.coarse / 1e6).toFixed(2)} vs ${(c.volume.fine / 1e6).toFixed(2)} Mm³) |`);
    L.push(
      `| Max-depth error on the ${c.fine}² grid, flooded land | RMSE ${c.maxDepthFlooded.rmse.toFixed(3)} m, L1 ${c.maxDepthFlooded.l1.toFixed(3)} m, max ${c.maxDepthFlooded.maxAbs.toFixed(2)} m |`,
    );
    L.push(
      `| Max-depth error on the ${c.fine}² grid, whole domain | RMSE ${c.maxDepthFine.rmse.toFixed(3)} m, L1 ${c.maxDepthFine.l1.toFixed(4)} m, max ${c.maxDepthFine.maxAbs.toFixed(2)} m |`,
    );
    L.push(
      `| Max-depth error at ${c.coarse}² resolution (fine block-averaged), flooded land | RMSE ${c.maxDepthCoarsenedFlooded.rmse.toFixed(3)} m, L1 ${c.maxDepthCoarsenedFlooded.l1.toFixed(3)} m, max ${c.maxDepthCoarsenedFlooded.maxAbs.toFixed(2)} m |`,
    );
    L.push(
      `| Final-depth error at ${c.coarse}² resolution, flooded land | RMSE ${c.depthCoarsenedFlooded.rmse.toFixed(3)} m, L1 ${c.depthCoarsenedFlooded.l1.toFixed(3)} m |`,
    );
    L.push('');
    L.push('| Landmark | expect | ' + `${c.coarse}² arrival | ${c.fine}² arrival | Δ | ${c.coarse}² peak | ${c.fine}² peak | Δ |`);
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const l of c.landmarks) {
      const a = l.coarseArrival === null ? 'never' : `${(l.coarseArrival / 60).toFixed(2)} min`;
      const b = l.fineArrival === null ? 'never' : `${(l.fineArrival / 60).toFixed(2)} min`;
      const d = l.dArrival === null ? (l.coarseArrival === null && l.fineArrival === null ? '—' : 'n/a') : `${sgn(l.dArrival, 1, ' s')}`;
      L.push(`| ${l.name} | ${l.expect} | ${a} | ${b} | ${d} | ${f2(l.coarsePeak)} m | ${f2(l.finePeak)} m | ${sgn(l.dPeak, 2, ' m')} |`);
    }
    L.push('');
  }
  L.push('## Definitions');
  L.push('');
  L.push(`* "Flooded"/"wet" = max depth reached during the run ≥ ${FLOOD_THRESHOLD_M} m (the app's hazard legend's first band).`);
  L.push('* "Newly flooded land" excludes every cell the scenario\'s initial fill left wet, i.e. the rivers themselves.');
  L.push(
    '* Field errors "on the fine grid" replicate each coarse cell into its r² fine cells, so structure finer than the coarse cell counts as error. Errors "at coarse resolution" block-average the fine field down first, so only what the coarse grid can represent counts.',
  );
  L.push(
    `* Landmark probes are the mean depth over a ${PROBE_RADIUS_M} m radius disc — the same patch of ground on every grid — and arrival is the interpolated first crossing of ${FLOOD_THRESHOLD_M} m.`,
  );
  L.push('* Mass error is the solver\'s own ledger: |V − (V₀ + in − out)| / max(V₀, peak V).');
  L.push('* GPU alloc is computed from the resource list in `src/sim/Solver.ts`; peak RSS is the Node process only (Dawn\'s Metal heaps do not show there).');
  L.push('');
  return `${L.join('\n')}\n`;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

function arg(name: string, dflt: string): string {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}
function flag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

async function main(): Promise<void> {
  const outDir = path.resolve(ROOT, arg('out', 'artifacts/reference-run'));
  const grids = arg('grids', '1024,2048,4096')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((v) => v > 0);
  const cases = arg('cases', 'crest,rain').split(',').map((s) => s.trim()) as CaseId[];
  const bed = arg('bed', 'bilinear') as BedMode;
  const duration = Number(arg('minutes', '45')) * 60;
  const tick = Number(arg('tick', '1'));
  const sample = Number(arg('sample', '5'));
  if (bed !== 'bilinear' && bed !== 'nearest') throw new Error(`--bed must be bilinear or nearest (got ${bed})`);
  for (const c of cases) if (c !== 'crest' && c !== 'rain') throw new Error(`--cases must be crest and/or rain (got ${c})`);
  fs.mkdirSync(path.join(outDir, 'runs'), { recursive: true });

  const p = loadPreset();
  grids.sort((a, b) => a - b);
  const runs: RunResult[] = [];

  if (flag('compare-only')) {
    for (const c of cases) {
      for (const g of grids) {
        const f = path.join(outDir, 'runs', `${runKey({ case: c, grid: g, bed })}.json`);
        if (!fs.existsSync(f)) {
          console.log(`  (no saved run for ${c} ${g}² ${bed} — skipping)`);
          continue;
        }
        runs.push(JSON.parse(fs.readFileSync(f, 'utf8')) as RunResult);
      }
    }
  } else {
    Object.assign(globalThis, globals);
    // The Dawn instance must stay referenced for the life of the process (see tests/helpers/gpu.ts).
    const instance = create([]);
    const { device, description } = await createDelugeDevice(instance);
    const uncaptured: string[] = [];
    device.onuncapturederror = (ev) => {
      const msg = (ev as GPUUncapturedErrorEvent).error?.message ?? String(ev);
      uncaptured.push(msg);
      console.error('[webgpu]', msg);
    };
    console.log(`GPU: ${description}`);
    console.log(
      `Pittsburgh ${p.meta.nx}² baked; grids ${grids.join(', ')}; cases ${cases.join(', ')}; bed ${bed}; ` +
        `${(duration / 60).toFixed(0)} sim-minutes; tick ${tick} s; sample ${sample} s`,
    );
    for (const g of grids) {
      const tb = performance.now();
      const grid = buildGrid(p, g, bed);
      console.log(
        `  ${g}²: dx ${grid.cellSize.toFixed(4)} m, initial water ${(grid.initialVolume / 1e6).toFixed(3)} Mm³, ` +
          `${grid.channelCells.toLocaleString('en-US')} channel cells, ` +
          `built in ${((performance.now() - tb) / 1000).toFixed(1)} s`,
      );
      for (const c of cases) {
        const o: RunOptions = { case: c, grid: g, bed, duration, tick, sample };
        const res = await runOne(device, description, p, grid, o, outDir);
        runs.push(res);
        console.log(
          `  → ${c} ${g}²: ${(res.wallClockS / 60).toFixed(1)} min wall, ${res.substeps.toLocaleString('en-US')} substeps, ` +
            `mass error ${res.stats.massError.toExponential(1)}, flooded ${(res.stats.floodedArea / 1e6).toFixed(3)} km², ` +
            `max depth ${res.stats.maxDepth.toFixed(2)} m${res.nonFiniteCells ? ` ⚠ ${res.nonFiniteCells} non-finite cells` : ''}`,
        );
      }
    }
    if (uncaptured.length) console.error(`⚠ ${uncaptured.length} uncaptured WebGPU errors`);
    void instance;
  }

  const comps: Comparison[] = [];
  for (const c of cases) {
    const forCase = runs.filter((r) => r.case === c).sort((a, b) => a.grid - b.grid);
    const finest = forCase[forCase.length - 1];
    if (!finest) continue;
    for (const r of forCase) {
      if (r.grid === finest.grid) continue;
      comps.push(compare(outDir, p, r, finest));
    }
  }

  fs.writeFileSync(
    path.join(outDir, 'results.json'),
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        preset: { id: p.meta.id, nx: p.meta.nx, cellSize: p.meta.cellSize, bounds: p.meta.bounds },
        settings: { grids, cases, bed, durationSeconds: duration, tick, sample, threshold: FLOOD_THRESHOLD_M, probeRadiusM: PROBE_RADIUS_M },
        runs,
        comparisons: comps,
      },
      null,
      1,
    )}\n`,
  );
  fs.writeFileSync(path.join(outDir, 'results.md'), markdown(runs, comps, p));
  console.log(`\nWrote ${path.join(outDir, 'results.json')} and results.md`);
  for (const c of comps) {
    console.log(
      `  ${c.case} ${c.coarse}² vs ${c.fine}²: flooded ${c.flooded.coarseKm2.toFixed(3)} vs ${c.flooded.fineKm2.toFixed(3)} km² ` +
        `(${sgn(c.flooded.pct, 2, ' %')}), IoU ${(c.flooded.iou * 100).toFixed(1)} %, max-depth RMSE ${c.maxDepthFlooded.rmse.toFixed(3)} m on flooded land`,
    );
  }
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
