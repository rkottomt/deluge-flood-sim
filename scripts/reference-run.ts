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
 * `Solver.computeDt()` (dt ∝ dx). A tick is covered by ⌊tick/dt⌋ substeps AT that timestep plus one short substep for
 * the remainder, so no grid is quietly run at a lower Courant number than another and every grid sits at exactly the
 * same simulated time at every comparison point.
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
 *
 * RUNNING THE NEXT RUNG (8192², 64× the demo grid) ON A CLOUD GPU. 1024²–4096² all fit on the demo MacBook Air;
 * 8192² needs ~7.5 GB of GPU memory and ~64× the 4096² work, so it wants a rented GPU (NVIDIA Brev, an A100/L40S
 * instance). `webgpu` ships prebuilt Dawn for linux-x64 and runs headless on the NVIDIA Vulkan ICD. Only the DEM and
 * the scenario are needed, so the upload is ~4 MB:
 *
 *   ssh brev … 'mkdir -p deluge/public/presets/pittsburgh'
 *   rsync -a package.json package-lock.json tsconfig.json src scripts tests/helpers brev:deluge/
 *   rsync -a public/presets/pittsburgh/{meta.json,elevation.f32} brev:deluge/public/presets/pittsburgh/
 *   ssh brev 'cd deluge && npm ci --omit=optional &&  *             npx tsx scripts/reference-run.ts --grids=8192 --cases=crest,rain --minutes=30'
 *   # copy back the run records and the two fields per case (67 MB each at 8192²… 268 MB total)
 *   rsync -a brev:deluge/artifacts/reference-run/{runs,fields} artifacts/reference-run/
 *   npx tsx scripts/reference-run.ts --compare-only --grids=1024,2048,4096,8192
 *
 * Expect roughly 25–60 min per case on an A100 (extrapolating 40 substeps/s at 4096² on an M4 by cells × 1/dt);
 * check the first progress line, which prints a projection. CAVEAT: comparing fields produced on two different GPUs
 * mixes two Float32 implementations. Differences from that are ~1e-5 m (tests/sim/reference.test.ts bounds the same
 * effect between Dawn/Metal and a Float64 CPU reference), i.e. far below the centimetre-scale numbers here — but say
 * so when quoting a cross-device result, and prefer running the whole ladder on one device where the memory allows.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
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

/** Depth that counts as "flooded" for the headline extent, area and IoU numbers, m. The app's hazard legend starts here. */
export const FLOOD_THRESHOLD_M = 0.15;
/**
 * The whole ladder of depth thresholds the areas are reported at. A single threshold is a trap: 100 mm/hr sheet flow
 * puts most of its water just below 0.15 m, where a percentage difference between two nearly-empty masks says nothing,
 * and the deep bands are where a flood map is actually used. Reporting all four makes the threshold sensitivity
 * visible instead of letting the choice of 0.15 m pick the answer.
 */
export const AREA_THRESHOLDS_M = [0.05, 0.15, 0.5, 1] as const;
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

/** mask[k] = a[k] || b[k] (in place on a fresh array). */
export function maskOr(a: Uint8Array, b: Uint8Array): Uint8Array {
  const m = new Uint8Array(a.length);
  for (let k = 0; k < a.length; k++) if (a[k] || b[k]) m[k] = 1;
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

/** Largest masked cell count for which fieldError also sorts |Δ| for percentiles (bounds the temporary array). */
const PERCENTILE_CELL_CAP = 12e6;

export interface FieldError {
  rmse: number;
  l1: number;
  maxAbs: number;
  cells: number;
  nonFinite: number;
  /**
   * Percentiles of |Δ| over the mask, or null when no mask was given (or it covered too many cells to sort). The
   * mean and RMSE hide the shape: a flood map can agree to a few centimetres over most of its area and still be a
   * metre out down the narrow flow paths a 7.8 m cell cannot resolve. p50/p90/p99 is where that shows.
   */
  p50: number | null;
  p90: number | null;
  p99: number | null;
}

/** RMSE, mean |Δ| (L1), max |Δ| and (masked only) percentiles of |Δ| over `mask` (all cells when mask is null). */
export function fieldError(a: Float32Array, b: Float32Array, mask: Uint8Array | null): FieldError {
  let sq = 0;
  let abs = 0;
  let maxAbs = 0;
  let cells = 0;
  let nonFinite = 0;
  const want = mask !== null ? maskCount(mask) : 0;
  const keep = mask !== null && want > 0 && want <= PERCENTILE_CELL_CAP ? new Float64Array(want) : null;
  for (let k = 0; k < a.length; k++) {
    if (mask && !mask[k]) continue;
    const d = a[k] - b[k];
    if (!Number.isFinite(d)) {
      nonFinite++;
      continue;
    }
    const m = Math.abs(d);
    if (keep) keep[cells] = m;
    cells++;
    sq += d * d;
    abs += m;
    if (m > maxAbs) maxAbs = m;
  }
  let p50: number | null = null;
  let p90: number | null = null;
  let p99: number | null = null;
  if (keep && cells > 0) {
    const v = keep.subarray(0, cells).slice().sort();
    const at = (q: number) => v[Math.min(cells - 1, Math.max(0, Math.round(q * (cells - 1))))];
    p50 = at(0.5);
    p90 = at(0.9);
    p99 = at(0.99);
  }
  return { rmse: cells ? Math.sqrt(sq / cells) : 0, l1: cells ? abs / cells : 0, maxAbs, cells, nonFinite, p50, p90, p99 };
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

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// The shippable overlay: public/presets/<id>/reference.{json,bin}
//
// PURPOSE. The ladder below proves the demo grid is close to a 16x-finer run, but it proves it in a table. This
// writes the finest run's answer into the app as data, so the renderer can draw "Reference (4096²)" beside the live
// 1024² simulation and a judge can see the agreement instead of reading about it.
//
// FORMAT (version 1). Two files, mirroring the preset convention of meta.json + elevation.f32:
//   reference.json  the manifest: grid, provenance, and one entry per plane with its offset/length in the binary,
//                   its quantisation and that quantisation's measured worst-case error.
//   reference.bin   the planes' bytes, concatenated. Each plane is nx*ny bytes of u8, gzip-compressed
//                   INDEPENDENTLY, so a loader can inflate just the plane it needs from one fetch.
//
// Every choice here is made to keep the file honest and small, in that order:
//  • Resampled to the PRESET grid (1024²) by 4x4 block mean, not to some new grid of its own. That is exactly the
//    "at coarse resolution" frame the convergence table already reports, so the overlay and the metrics are the same
//    comparison, and the renderer can index it with the live simulation's own cell indices.
//  • Depth is quantised with a SQRT curve rather than linearly. Linear u8 over 16 m gives a flat 6.3 cm step, which
//    is coarse exactly where a flood map is read — the hazard legend's first band is 0.15 m. The sqrt curve spends
//    its codes where the water is shallow: ~1.2 cm per code at 0.15 m, degrading to ~12 cm at 16 m where nobody
//    cares about the third digit. Measured round-trip error on flooded land is ~2 cm, an order of magnitude below
//    the 0.13-0.29 m discretisation error the overlay exists to illustrate — so the encoding is not what limits it,
//    and `quantMaxError` in the manifest states that per plane instead of asking anyone to trust this comment.
//  • Arrival time is linear (its 7 s step is far finer than the minutes-scale structure) with 0 reserved for
//    "never reached the threshold", which is also how the depth plane spells "dry".
//  • gzip, because the domain is mostly dry and it takes ~4 MB of planes under the 2 MB budget. DecompressionStream
//    is a strictly weaker requirement than WebGPU, which the app already needs.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const OVERLAY_VERSION = 1 as const;

export interface OverlayPlane {
  case: CaseId;
  kind: 'maxDepth' | 'arrival';
  /** Offset and length of this plane's gzip member inside reference.bin. */
  offset: number;
  length: number;
  /** Bytes after inflation; a loader must check this equals nx*ny before trusting the plane. */
  inflatedLength: number;
  /** 'sqrt' for depth, 'linear' for arrival. Byte 0 always means "dry"/"never". */
  quant: 'sqrt' | 'linear';
  /** The value byte 255 decodes to, in `unit`. */
  scale: number;
  unit: 'm' | 's';
  /** Largest round-trip error this plane's quantisation actually introduced, in `unit`. */
  quantMaxError: number;
  /** Cells with a non-zero code, i.e. wet / arrived. */
  nonZeroCells: number;
}

export interface ReferenceOverlayManifest {
  version: typeof OVERLAY_VERSION;
  preset: string;
  /** Overlay grid = the preset's baked grid, so live cell indices address it directly. */
  nx: number;
  ny: number;
  cellSize: number;
  /** The grid the reference run was computed on, and its refinement over nx. */
  referenceGrid: number;
  refine: number;
  bed: BedMode;
  durationSeconds: number;
  /** Depth whose first crossing the arrival planes record, m. */
  arrivalThreshold: number;
  resample: 'block-mean';
  encoding: 'gzip';
  binary: string;
  sha256: string;
  planes: OverlayPlane[];
  provenance: {
    generatedAt: string;
    gpu: string;
    host: string;
    /** Wall clock of the source runs, s, keyed by run. */
    runs: Record<string, { wallClockS: number; substeps: number; massError: number }>;
  };
}

/**
 * Quantise a depth field to u8 with a sqrt curve. Code 0 is reserved for "dry": any positive depth gets at least
 * code 1, so a thin sheet of water never disappears into the dry background of the overlay.
 */
export function encodeDepthPlane(field: Float32Array, scale: number): Uint8Array {
  if (!(scale > 0)) throw new Error(`depth scale must be positive (got ${scale})`);
  const q = new Uint8Array(field.length);
  for (let k = 0; k < field.length; k++) {
    const d = field[k];
    if (!(d > 0)) continue;
    const t = Math.sqrt(Math.min(d, scale) / scale);
    q[k] = Math.min(255, Math.max(1, Math.round(255 * t)));
  }
  return q;
}

/** Inverse of encodeDepthPlane. */
export function decodeDepthPlane(q: Uint8Array, scale: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) {
    if (q[k] === 0) continue;
    const t = q[k] / 255;
    out[k] = scale * t * t;
  }
  return out;
}

/**
 * Quantise arrival times to u8, linearly over [0, duration]. Code 0 means "never reached the threshold"; arrived
 * cells occupy 1..255, so t = (code - 1) / 254 * duration.
 */
export function encodeArrivalPlane(arrival: Float32Array, duration: number): Uint8Array {
  if (!(duration > 0)) throw new Error(`duration must be positive (got ${duration})`);
  const q = new Uint8Array(arrival.length);
  for (let k = 0; k < arrival.length; k++) {
    const t = arrival[k];
    if (!(t >= 0)) continue;
    const u = Math.min(1, Math.max(0, t / duration));
    q[k] = Math.min(255, 1 + Math.round(u * 254));
  }
  return q;
}

/** Inverse of encodeArrivalPlane. NaN = never arrived. */
export function decodeArrivalPlane(q: Uint8Array, duration: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) {
    out[k] = q[k] === 0 ? Number.NaN : ((q[k] - 1) / 254) * duration;
  }
  return out;
}

/**
 * Block-average a fine arrival field onto the coarse grid, keeping it consistent with the coarsened depth plane: a
 * coarse cell is "arrived" only where the coarsened MAX DEPTH clears the threshold, and its time is then the mean
 * over the fine sub-cells that themselves arrived. Averaging "never" (-1) in as a number would have invented early
 * arrivals at the flood edge; gating on the depth plane means every cell the overlay draws as flooded has a time,
 * and no cell it draws as dry has one.
 */
export function coarsenArrival(
  arrivalFine: Float32Array,
  nFine: number,
  r: number,
  coarseMaxDepth: Float32Array,
  threshold: number,
): Float32Array {
  const n = nFine / r;
  if (!Number.isInteger(n)) throw new Error(`refinement ${r} does not divide ${nFine}`);
  if (coarseMaxDepth.length !== n * n) throw new Error(`coarse depth is ${coarseMaxDepth.length} cells, expected ${n * n}`);
  const out = new Float32Array(n * n).fill(-1);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const k = y * n + x;
      if (coarseMaxDepth[k] < threshold) continue;
      let sum = 0;
      let cnt = 0;
      for (let j = 0; j < r; j++) {
        const row = (y * r + j) * nFine + x * r;
        for (let i = 0; i < r; i++) {
          const t = arrivalFine[row + i];
          if (t >= 0) {
            sum += t;
            cnt++;
          }
        }
      }
      // cnt can only be 0 if no sub-cell ever cleared the threshold while their mean did, which the block mean
      // makes impossible; guard anyway rather than write a silent 0 s arrival.
      out[k] = cnt > 0 ? sum / cnt : -1;
    }
  }
  return out;
}

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
  /**
   * Also accumulate a PER-CELL arrival time of FLOOD_THRESHOLD_M from the readbacks (`--arrival`). Off by default
   * because it is pure CPU work over every cell at every sample (16.7 M cells x 362 samples at 4096²) and the
   * ladder's headline number is wall clock; when it is on, its cost is measured separately and SUBTRACTED from
   * `wallClockS`, and reported as `arrivalOverheadS`, so the timings stay comparable with runs made without it.
   */
  arrival: boolean;
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
  /**
   * The whole probe series (one value per entry of RunResult.sampleTimes), so `--compare-only` can re-derive an
   * arrival time at ANY threshold without re-running. 100 mm/hr rain never puts 0.15 m on most of these sites, and a
   * table of "never / never" would have hidden a real difference in when the water shows up at all.
   */
  series: number[];
  seriesCell: number[];
}

interface RunResult {
  case: CaseId;
  grid: number;
  bed: BedMode;
  cellSize: number;
  duration: number;
  tick: number;
  sample: number;
  /** Simulated seconds at which the probes were sampled. */
  sampleTimes: number[];
  substeps: number;
  dtMean: number;
  dtMin: number;
  dtMax: number;
  /** Mean CFL timestep the solver asked for (dtMean/dtCflMean shows how close the run stayed to its CFL limit). */
  dtCflMean: number;
  /** Largest 2-D Courant number the solver's own stats reported in the final window. */
  courant: number;
  wallClockS: number;
  peakRssMB: number;
  gpuBytesEstimate: number;
  initialVolume: number;
  stats: SimStats;
  /** Final stage offset applied (crest case), m, and the gauge reading it corresponds to. */
  stageOffset: number;
  landmarks: LandmarkResult[];
  /** Files holding the raw fields, relative to the output directory. */
  fields: { maxDepth: string; depth: string; arrival?: string };
  /**
   * Seconds spent in the per-cell arrival accumulator (`--arrival`), already excluded from `wallClockS`.
   * 0/absent when the run did not track it.
   */
  arrivalOverheadS?: number;
  /** Depth whose first crossing the per-cell arrival field records, m (FLOOD_THRESHOLD_M). */
  arrivalThreshold?: number;
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
  /** Mean of the raw CFL timestep the solver asked for, so the report can show we ran at it and not below it. */
  let cflSum = 0;
  let cflTicks = 0;
  let peakRss = process.memoryUsage().rss;
  let simTime = 0;
  let nextSample = 0;
  /**
   * Per-cell arrival time of FLOOD_THRESHOLD_M, s; -1 = not yet reached. Built from the SAME readbacks the landmark
   * probes use, at the same `--sample` cadence, so it costs no extra GPU work — but the scan itself is CPU time over
   * every cell, so it is timed into `arrivalMs` and taken back out of the reported wall clock.
   */
  const arrivalField = o.arrival ? new Float32Array(n * n).fill(-1) : null;
  /** Previous sample's depth field, for the interpolated crossing (same rule as arrivalTime()). */
  const prevDepth = o.arrival ? new Float32Array(n * n) : null;
  let prevTime = 0;
  let arrivalMs = 0;
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
    if (arrivalField && prevDepth) {
      const ta = performance.now();
      const T = FLOOD_THRESHOLD_M;
      const dt = snap.simTime - prevTime;
      for (let k = 0; k < arrivalField.length; k++) {
        if (arrivalField[k] >= 0) continue;
        const cur = snap.depth[k];
        if (cur < T) continue;
        const was = prevDepth[k];
        // Linear interpolation inside the sample interval, identical to arrivalTime(); at the first sample
        // dt is 0, so a cell already wet at t=0 correctly gets arrival 0.
        arrivalField[k] = was < T && cur > was ? prevTime + ((T - was) / (cur - was)) * dt : snap.simTime;
      }
      prevDepth.set(snap.depth);
      prevTime = snap.simTime;
      arrivalMs += performance.now() - ta;
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
    // Cover the tick with whole substeps at the solver's own CFL timestep, plus one short substep for the
    // remainder. Every grid therefore runs AT its CFL limit (not at tick/⌈tick/dt⌉, which would have run the coarse
    // grid at a materially lower Courant number than the fine one and flattered it), and every grid is at exactly
    // the same simulated time at every comparison point.
    const cfl = solver.computeDt();
    cflSum += cfl;
    cflTicks++;
    const k = Math.floor(tick / cfl);
    if (k < 1) {
      solver.runSubsteps(1, tick);
      substeps += 1;
      dtSum += tick;
      dtMin = Math.min(dtMin, tick);
      dtMax = Math.max(dtMax, tick);
    } else {
      solver.runSubsteps(k, cfl);
      substeps += k;
      dtSum += cfl * k;
      dtMin = Math.min(dtMin, cfl);
      dtMax = Math.max(dtMax, cfl);
      const rem = tick - k * cfl;
      if (rem > 1e-6) {
        solver.runSubsteps(1, rem);
        substeps += 1;
        dtSum += rem;
        dtMin = Math.min(dtMin, rem);
        dtMax = Math.max(dtMax, rem);
      }
    }
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
            `dt ${dtMax.toFixed(4)}s  ${substeps} substeps  ${el.toFixed(0)}s elapsed, ~${(el / Math.max(frac, 1e-6) - el).toFixed(0)}s left\n`,
        );
      }
    }
  }
  const snap = await sample();
  await solver.flush();
  // The arrival accumulator is CPU bookkeeping this harness added, not solver time: charge it separately so a
  // --arrival run's wall clock stays comparable with one made without it.
  const wallClockS = (performance.now() - t0) / 1000 - arrivalMs / 1000;

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
  let fArr: string | undefined;
  if (arrivalField) {
    fArr = `fields/${key}.arrival.f32`;
    fs.writeFileSync(path.join(outDir, fArr), Buffer.from(arrivalField.buffer, 0, arrivalField.byteLength));
  }

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
    peak: pr.disc.reduce((a, b) => Math.max(a, b), 0),
    peakCell: pr.point.reduce((a, b) => Math.max(a, b), 0),
    final: pr.disc[pr.disc.length - 1],
    series: pr.disc,
    seriesCell: pr.point,
  }));

  const result: RunResult = {
    case: o.case,
    grid: n,
    bed: o.bed,
    cellSize: grid.cellSize,
    duration: o.duration,
    tick: o.tick,
    sample: o.sample,
    sampleTimes: times,
    substeps,
    dtMean: dtSum / Math.max(1, substeps),
    dtMin: Number.isFinite(dtMin) ? dtMin : 0,
    dtMax,
    dtCflMean: cflSum / Math.max(1, cflTicks),
    courant: snap.stats.courant,
    wallClockS,
    peakRssMB: peakRss / 1e6,
    gpuBytesEstimate: gpuBytesEstimate(n, { raise: isCrest && !!grid.channelBase }),
    initialVolume: grid.initialVolume,
    stats: snap.stats,
    stageOffset: ramp.applied,
    landmarks,
    fields: { maxDepth: fMax, depth: fDep, ...(fArr ? { arrival: fArr } : {}) },
    ...(arrivalField ? { arrivalOverheadS: arrivalMs / 1000, arrivalThreshold: FLOOD_THRESHOLD_M } : {}),
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

interface AreaAgreement {
  threshold: number;
  coarseKm2: number;
  fineKm2: number;
  pct: number | null;
  iou: number;
  onlyCoarseKm2: number;
  onlyFineKm2: number;
}

interface Comparison {
  case: CaseId;
  bed: BedMode;
  coarse: number;
  fine: number;
  /** Refinement factor between them, and the cell-count ratio. */
  refine: number;
  cells: number;
  /** Wet extent (maxDepth ≥ threshold), whole domain, one entry per AREA_THRESHOLDS_M. */
  extent: AreaAgreement[];
  /** Newly flooded land only (maxDepth ≥ threshold on ground the initial fill left dry) — the headline number. */
  flooded: AreaAgreement[];
  /** Max-depth field error on the FINE grid, coarse replicated cell-for-cell. */
  maxDepthFine: ErrorSummary;
  /** Same, restricted to the union of the two newly-flooded masks. */
  maxDepthFlooded: ErrorSummary;
  /**
   * Same, restricted to the INTERSECTION — land both grids flood. Splitting interior from margin separates "the two
   * grids disagree about how deep it gets" from "they disagree about where the edge of the flood is".
   */
  maxDepthBothFlooded: ErrorSummary;
  /** Max-depth error after block-averaging the fine field onto the coarse grid (what the coarse grid can represent). */
  maxDepthCoarsened: ErrorSummary;
  /** Same, restricted to the coarse grid's newly-flooded cells. */
  maxDepthCoarsenedFlooded: ErrorSummary;
  /** Final depth field, same two frames. */
  depthFine: ErrorSummary;
  depthCoarsenedFlooded: ErrorSummary;
  /** Volume held at the end, m³. */
  volume: { coarse: number; fine: number; pct: number | null };
  /**
   * PER-CELL arrival-time agreement, s — present only when both runs were made with `--arrival`. The landmark table
   * gives nine points; this gives every cell, which is what the overlay actually draws. Restricted to cells BOTH
   * grids flooded: a cell only one grid ever wets has no time to compare, and that disagreement is already counted
   * by the IoU, so folding it in here as some sentinel value would double-count it as a huge time error.
   */
  arrival?: {
    /** Coarse replicated onto the fine grid. */
    fine: ErrorSummary;
    /** Fine block-averaged onto the coarse grid (what the demo grid can represent). */
    coarsened: ErrorSummary;
    /** Cells (coarse grid) where exactly one of the two grids ever reached the threshold. */
    onlyCoarseCells: number;
    onlyFineCells: number;
    bothCells: number;
  };
  landmarks: LandmarkComparison[];
}

interface LandmarkComparison {
  name: string;
  expect: 'wet' | 'dry';
  /** Arrival times (s) at each threshold of AREA_THRESHOLDS_M, and the coarse − fine difference. */
  arrivals: Array<{ threshold: number; coarse: number | null; fine: number | null; delta: number | null }>;
  coarsePeak: number;
  finePeak: number;
  dPeak: number;
}

function loadField(outDir: string, rel: string, cells: number): Float32Array {
  const buf = fs.readFileSync(path.join(outDir, rel));
  if (buf.byteLength !== cells * 4) throw new Error(`${rel}: ${buf.byteLength} bytes, expected ${cells * 4}`);
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

type ErrorSummary = Pick<FieldError, 'rmse' | 'l1' | 'maxAbs' | 'cells' | 'p50' | 'p90' | 'p99'>;

function trim(e: FieldError): ErrorSummary {
  return { rmse: e.rmse, l1: e.l1, maxAbs: e.maxAbs, cells: e.cells, p50: e.p50, p90: e.p90, p99: e.p99 };
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

  // Areas and IoU at every threshold of the ladder; the 0.15 m masks also define the "flooded land" the field
  // errors are restricted to.
  const agree = (mc: Uint8Array, mf: Uint8Array, threshold: number): AreaAgreement => {
    const o = iou(refineMask(mc, nc, r), mf);
    return {
      threshold,
      coarseKm2: maskCount(mc) * areaC * km2,
      fineKm2: maskCount(mf) * areaF * km2,
      pct: pctDiff(maskCount(mc) * areaC, maskCount(mf) * areaF),
      iou: o.iou,
      onlyCoarseKm2: o.onlyA * areaF * km2,
      onlyFineKm2: o.onlyB * areaF * km2,
    };
  };
  const extent: AreaAgreement[] = [];
  const flooded: AreaAgreement[] = [];
  for (const t of AREA_THRESHOLDS_M) {
    const ec = maskAtLeast(mdC, t);
    const ef = maskAtLeast(mdF, t);
    extent.push(agree(ec, ef, t));
    flooded.push(agree(maskAnd(ec, dryC), maskAnd(ef, dryF), t));
  }
  const floodC = maskAnd(maskAtLeast(mdC, FLOOD_THRESHOLD_M), dryC);
  const floodF = maskAnd(maskAtLeast(mdF, FLOOD_THRESHOLD_M), dryF);

  const mdCf = refineField(mdC, nc, r, 'nearest');
  const dCf = refineField(dC, nc, r, 'nearest');
  // Fine frame: land either grid calls flooded. Using only one grid's mask would hide exactly the disagreement we
  // are trying to measure (water the fine grid puts somewhere the coarse grid leaves dry, and vice versa).
  const unionFlood = maskOr(refineMask(floodC, nc, r), floodF);

  // Coarse frame: block-average the fine field down. This asks the fairer question — does the demo grid get the
  // answer right at the scales it can represent at all — and separates that from structure below 7.8 m.
  const mdFc = blockMean(mdF, nf, r);
  const dFc = blockMean(dF, nf, r);
  // Same union rule in the coarse frame (the rain case's coarse flood mask is nearly empty, and an empty mask would
  // have reported a flattering RMSE of exactly zero).
  const unionFloodC = maskOr(floodC, maskAnd(maskAtLeast(mdFc, FLOOD_THRESHOLD_M), dryC));

  const lm: LandmarkComparison[] = coarse.landmarks.map((a, i) => {
    const b = fine.landmarks[i];
    return {
      name: a.name,
      expect: a.expect,
      arrivals: AREA_THRESHOLDS_M.map((t) => {
        const ca = arrivalTime(coarse.sampleTimes, a.series, t);
        const fa = arrivalTime(fine.sampleTimes, b.series, t);
        return { threshold: t, coarse: ca, fine: fa, delta: ca !== null && fa !== null ? ca - fa : null };
      }),
      coarsePeak: a.peak,
      finePeak: b.peak,
      dPeak: a.peak - b.peak,
    };
  });

  // Per-cell arrival agreement, when both runs tracked it.
  let arrivalCmp: Comparison['arrival'];
  if (coarse.fields.arrival && fine.fields.arrival) {
    const aC = loadField(outDir, coarse.fields.arrival, nc * nc);
    const aF = loadField(outDir, fine.fields.arrival, nf * nf);
    const arrived = (f: Float32Array): Uint8Array => {
      const m = new Uint8Array(f.length);
      for (let k = 0; k < f.length; k++) if (f[k] >= 0) m[k] = 1;
      return m;
    };
    const okC = arrived(aC);
    const okF = arrived(aF);
    const bothFine = maskAnd(refineMask(okC, nc, r), okF);
    // Coarse frame: block-average the fine arrivals the same way the shipped overlay does, so this number bounds
    // the error of the artifact in public/presets/, not of some other reduction.
    const aFc = coarsenArrival(aF, nf, r, mdFc, FLOOD_THRESHOLD_M);
    const bothCoarse = maskAnd(okC, arrived(aFc));
    let onlyC = 0;
    let onlyF = 0;
    const okFc = arrived(aFc);
    for (let k = 0; k < okC.length; k++) {
      if (okC[k] && !okFc[k]) onlyC++;
      else if (!okC[k] && okFc[k]) onlyF++;
    }
    arrivalCmp = {
      fine: trim(fieldError(refineField(aC, nc, r, 'nearest'), aF, bothFine)),
      coarsened: trim(fieldError(aC, aFc, bothCoarse)),
      onlyCoarseCells: onlyC,
      onlyFineCells: onlyF,
      bothCells: maskCount(bothCoarse),
    };
  }

  return {
    case: coarse.case,
    bed: coarse.bed,
    coarse: nc,
    fine: nf,
    refine: r,
    cells: r * r,
    extent,
    flooded,
    maxDepthFine: trim(fieldError(mdCf, mdF, null)),
    maxDepthFlooded: trim(fieldError(mdCf, mdF, unionFlood)),
    maxDepthBothFlooded: trim(fieldError(mdCf, mdF, maskAnd(refineMask(floodC, nc, r), floodF))),
    maxDepthCoarsened: trim(fieldError(mdC, mdFc, null)),
    maxDepthCoarsenedFlooded: trim(fieldError(mdC, mdFc, unionFloodC)),
    depthFine: trim(fieldError(dCf, dF, null)),
    depthCoarsenedFlooded: trim(fieldError(dC, dFc, unionFloodC)),
    volume: { coarse: coarse.stats.volume, fine: fine.stats.volume, pct: pctDiff(coarse.stats.volume, fine.stats.volume) },
    ...(arrivalCmp ? { arrival: arrivalCmp } : {}),
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
/** The headline (FLOOD_THRESHOLD_M) row of a comparison's newly-flooded ladder. */
const headline = (c: Comparison): AreaAgreement => c.flooded.find((a) => a.threshold === FLOOD_THRESHOLD_M) ?? c.flooded[0];
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
  L.push(
    `Each run: ${mins(first?.duration ?? 0)} of simulated time, stage ramp advanced every ${first?.tick ?? 0} sim-s, readback every ${first?.sample ?? 0} sim-s.`,
  );
  L.push('');
  L.push('### Cost and timestep');
  L.push('');
  L.push('| Case | Grid | dx (m) | Substeps | mean dt (s) | dt / CFL dt | Courant | Wall clock | GPU alloc | Peak RSS (node) |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of runs) {
    const wall = r.wallClockS < 90 ? `${r.wallClockS.toFixed(0)} s` : `${(r.wallClockS / 60).toFixed(1)} min`;
    L.push(
      `| ${r.case} | ${r.grid}² | ${r.cellSize.toFixed(3)} | ${r.substeps.toLocaleString('en-US')} | ${r.dtMean.toFixed(4)} | ` +
        `${(r.dtMean / Math.max(r.dtCflMean, 1e-9)).toFixed(2)} | ${r.courant.toFixed(2)} | ${wall} | ${(r.gpuBytesEstimate / 1e9).toFixed(2)} GB | ${r.peakRssMB.toFixed(0)} MB |`,
    );
  }
  L.push('');
  L.push('### Result and conservation');
  L.push('');
  L.push('| Case | Grid | initial water (Mm³) | water held (Mm³) | mass error | max depth (m) | wet area (km²) | flooded area, h > 0.3 (km²) | non-finite cells |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of runs) {
    L.push(
      `| ${r.case} | ${r.grid}² | ${(r.initialVolume / 1e6).toFixed(3)} | ${(r.stats.volume / 1e6).toFixed(3)} | ${r.stats.massError.toExponential(1)} | ` +
        `${f2(r.stats.maxDepth)} | ${(r.stats.wetArea / 1e6).toFixed(3)} | ${(r.stats.floodedArea / 1e6).toFixed(3)} | ${r.nonFiniteCells} |`,
    );
  }
  L.push('');
  for (const c of comps) {
    L.push(`## ${c.case}: ${c.coarse}² vs ${c.fine}² (${c.cells}× the cells, bed refinement \`${c.bed}\`)`);
    L.push('');
    L.push(`Newly flooded land = max depth ≥ threshold on ground the initial river fill left dry.`);
    L.push('');
    L.push(`| Depth threshold | ${c.coarse}² | ${c.fine}² | difference | IoU | only ${c.coarse}² | only ${c.fine}² |`);
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const a of c.flooded) {
      L.push(
        `| ≥ ${a.threshold} m${a.threshold === FLOOD_THRESHOLD_M ? ' **(headline)**' : ''} | ${a.coarseKm2.toFixed(3)} km² | ${a.fineKm2.toFixed(3)} km² | ` +
          `${sgn(a.pct, 1, ' %')} | ${(a.iou * 100).toFixed(1)} % | ${a.onlyCoarseKm2.toFixed(3)} km² | ${a.onlyFineKm2.toFixed(3)} km² |`,
      );
    }
    L.push('');
    L.push(`Total wet extent (rivers included), same thresholds:`);
    L.push('');
    L.push(`| Depth threshold | ${c.coarse}² | ${c.fine}² | difference | IoU |`);
    L.push('| --- | --- | --- | --- | --- |');
    for (const a of c.extent) {
      L.push(
        `| ≥ ${a.threshold} m | ${a.coarseKm2.toFixed(3)} km² | ${a.fineKm2.toFixed(3)} km² | ${sgn(a.pct, 1, ' %')} | ${(a.iou * 100).toFixed(1)} % |`,
      );
    }
    L.push('');
    L.push('| Measure | Value |');
    L.push('| --- | --- |');
    L.push(`| Water held at the end | ${sgn(c.volume.pct, 2, ' %')} (${(c.volume.coarse / 1e6).toFixed(2)} vs ${(c.volume.fine / 1e6).toFixed(2)} Mm³) |`);
    L.push('');
    L.push('Max-depth field error (|Δ| between the two runs). "on the fine grid" replicates each coarse cell into its');
    L.push('r² fine cells; "at coarse resolution" block-averages the fine field down first.');
    L.push('');
    L.push('| Where | cells | RMSE | mean \\|Δ\\| | median | p90 | p99 | max |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    const erow = (label: string, e: ErrorSummary, digits = 3) => {
      const q = (v: number | null) => (v === null ? '—' : `${v.toFixed(digits)} m`);
      L.push(
        `| ${label} | ${e.cells.toLocaleString('en-US')} | ${e.rmse.toFixed(digits)} m | ${e.l1.toFixed(digits)} m | ` +
          `${q(e.p50)} | ${q(e.p90)} | ${q(e.p99)} | ${e.maxAbs.toFixed(2)} m |`,
      );
    };
    erow(`flooded land (either grid), on the ${c.fine}² grid`, c.maxDepthFlooded);
    erow(`flooded land (both grids), on the ${c.fine}² grid`, c.maxDepthBothFlooded);
    erow(`whole domain, on the ${c.fine}² grid`, c.maxDepthFine, 4);
    erow(`flooded land, at ${c.coarse}² resolution`, c.maxDepthCoarsenedFlooded);
    erow(`final depth, flooded land, at ${c.coarse}² resolution`, c.depthCoarsenedFlooded);
    L.push('');
    if (c.arrival) {
      L.push(
        `Per-cell arrival time of ${FLOOD_THRESHOLD_M} m (every cell, not just the nine landmarks), over cells both ` +
          'grids flooded.',
      );
      L.push('');
      L.push('| Where | cells | RMSE | mean \\|Δ\\| | median | p90 | p99 | max |');
      L.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      const arow = (label: string, e: ErrorSummary) => {
        const q = (v: number | null) => (v === null ? '—' : `${v.toFixed(1)} s`);
        L.push(
          `| ${label} | ${e.cells.toLocaleString('en-US')} | ${e.rmse.toFixed(1)} s | ${e.l1.toFixed(1)} s | ` +
            `${q(e.p50)} | ${q(e.p90)} | ${q(e.p99)} | ${e.maxAbs.toFixed(0)} s |`,
        );
      };
      arow(`on the ${c.fine}² grid`, c.arrival.fine);
      arow(`at ${c.coarse}² resolution (the shipped overlay's reduction)`, c.arrival.coarsened);
      L.push('');
      L.push(
        `Cells at ${c.coarse}² where only one grid ever reached ${FLOOD_THRESHOLD_M} m: ` +
          `${c.arrival.onlyCoarseCells.toLocaleString('en-US')} only ${c.coarse}², ` +
          `${c.arrival.onlyFineCells.toLocaleString('en-US')} only ${c.fine}² ` +
          `(against ${c.arrival.bothCells.toLocaleString('en-US')} both) — that disagreement is an extent difference, ` +
          'already counted by the IoU above, so it is excluded from the times.',
      );
      L.push('');
    }
    L.push(
      `| Landmark | expect | arrival ≥ 0.05 m (${c.coarse}² / ${c.fine}² / Δ) | arrival ≥ ${FLOOD_THRESHOLD_M} m (${c.coarse}² / ${c.fine}² / Δ) | peak ${c.coarse}² | peak ${c.fine}² | Δ peak |`,
    );
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    const cell = (a: { coarse: number | null; fine: number | null; delta: number | null }) => {
      const t = (v: number | null) => (v === null ? 'never' : `${(v / 60).toFixed(2)} min`);
      const d = a.delta === null ? (a.coarse === null && a.fine === null ? '—' : 'n/a') : sgn(a.delta, 1, ' s');
      return `${t(a.coarse)} / ${t(a.fine)} / ${d}`;
    };
    for (const l of c.landmarks) {
      const shallow = l.arrivals.find((a) => a.threshold === 0.05) ?? l.arrivals[0];
      const main = l.arrivals.find((a) => a.threshold === FLOOD_THRESHOLD_M) ?? l.arrivals[0];
      L.push(
        `| ${l.name} | ${l.expect} | ${cell(shallow)} | ${cell(main)} | ${f2(l.coarsePeak)} m | ${f2(l.finePeak)} m | ${sgn(l.dPeak, 2, ' m')} |`,
      );
    }
    L.push('');
  }
  // Observed convergence: with the finest grid as the reference, halving dx should roughly halve a first-order
  // scheme's error. Two error pairs are enough to see the trend; they are NOT enough for a formal order estimate,
  // which is why the report says "consistent with" and never prints an exponent.
  const cases = [...new Set(comps.map((c) => c.case))];
  const trend = cases
    .map((cs) => ({ cs, list: comps.filter((c) => c.case === cs).sort((a, b) => a.coarse - b.coarse) }))
    .filter((t) => t.list.length >= 2);
  if (trend.length) {
    L.push('## Observed convergence');
    L.push('');
    L.push(
      `Error of each grid against the finest run. A first-order scheme roughly halves its error when the cell size halves; the ratio column is error(${trend[0].list[0].coarse}²) / error(${trend[0].list[1].coarse}²).`,
    );
    L.push('');
    L.push('| Case | Measure | ' + trend[0].list.map((c) => `${c.coarse}²`).join(' | ') + ' | ratio |');
    L.push('| --- | --- | ' + trend[0].list.map(() => '---').join(' | ') + ' | --- |');
    for (const t of trend) {
      const vals = [
        {
          label: `flooded-area difference vs ${t.list[0].fine}²`,
          v: t.list.map((c) => Math.abs(headline(c).pct ?? NaN)),
          fmt: (x: number) => `${x.toFixed(2)} %`,
        },
        {
          label: 'max-depth RMSE on flooded land (m)',
          v: t.list.map((c) => c.maxDepthFlooded.rmse),
          fmt: (x: number) => x.toFixed(3),
        },
        {
          label: 'max-depth p90 on flooded land (m)',
          v: t.list.map((c) => c.maxDepthFlooded.p90 ?? NaN),
          fmt: (x: number) => x.toFixed(3),
        },
        {
          label: 'flood-extent IoU shortfall (1 − IoU)',
          v: t.list.map((c) => 1 - headline(c).iou),
          fmt: (x: number) => `${(x * 100).toFixed(2)} %`,
        },
        ...(t.list.every((c) => c.arrival)
          ? [
              {
                label: 'per-cell arrival RMSE, both flooded (s)',
                v: t.list.map((c) => c.arrival!.fine.rmse),
                fmt: (x: number) => x.toFixed(1),
              },
            ]
          : []),
      ];
      for (const row of vals) {
        const ratio = row.v.length >= 2 && row.v[1] > 0 ? (row.v[0] / row.v[1]).toFixed(2) + '×' : 'n/a';
        L.push(`| ${t.cs} | ${row.label} | ${row.v.map(row.fmt).join(' | ')} | ${ratio} |`);
      }
    }
    L.push('');
    L.push(
      'A ratio below 1 means the coarser grid happened to land closer — a total area is a difference of two large ' +
        'numbers and cancels, so it can agree while the water sits in different places. The IoU shortfall and the ' +
        'depth percentiles are the ones to read for placement; they behave consistently.',
    );
    L.push('');
  }
  L.push('## Definitions');
  L.push('');
  L.push(
    `* "Flooded"/"wet" = max depth reached during the run ≥ the threshold; ${FLOOD_THRESHOLD_M} m (the app's hazard legend's first band) is the headline, the rest of the ladder shows how much the choice of threshold matters.`,
  );
  L.push('* "Newly flooded land" excludes every cell the scenario\'s initial fill left wet, i.e. the rivers themselves.');
  L.push(
    '* Field errors "on the fine grid" replicate each coarse cell into its r² fine cells, so structure finer than the coarse cell counts as error. Errors "at coarse resolution" block-average the fine field down first, so only what the coarse grid can represent counts.',
  );
  L.push(
    `* Landmark probes are the mean depth over a ${PROBE_RADIUS_M} m radius disc — the same patch of ground on every grid — sampled every ${runs[0]?.sample ?? 0} sim-s, with arrival the interpolated first crossing of the threshold. The full series is in results.json, so an arrival at any other threshold can be re-derived.`,
  );
  L.push('* Mass error is the solver\'s own ledger: |V − (V₀ + in − out)| / max(V₀, peak V).');
  L.push('* GPU alloc is computed from the resource list in `src/sim/Solver.ts`; peak RSS is the Node process only (Dawn\'s Metal heaps do not show there).');
  L.push('');
  return `${L.join('\n')}\n`;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Main
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Write public/presets/<id>/reference.{json,bin} from the finest run of each case. Pure post-processing: it reads the
 * saved fields, so it needs no GPU and can be re-run after the fact (including on a different machine from the one
 * that produced the fields).
 */
function exportOverlay(outDir: string, p: Preset, runs: RunResult[], destDir: string): void {
  const byCase = new Map<CaseId, RunResult>();
  for (const r of runs) {
    const cur = byCase.get(r.case);
    if (!cur || r.grid > cur.grid) byCase.set(r.case, r);
  }
  if (byCase.size === 0) throw new Error('no runs to export an overlay from');
  const n = p.meta.nx;
  const finest = [...byCase.values()];
  const grids = new Set(finest.map((r) => r.grid));
  if (grids.size !== 1) {
    // Shipping one case at 4096² next to another at 2048² would put two different accuracies under one label.
    throw new Error(`cases disagree on the finest grid (${[...grids].join(', ')}); run the missing ones first`);
  }
  const refGrid = finest[0].grid;
  const r = refGrid / n;
  if (!Number.isInteger(r) || r < 1) throw new Error(`reference grid ${refGrid} is not a whole multiple of ${n}`);
  const durations = new Set(finest.map((x) => x.duration));
  if (durations.size !== 1) throw new Error(`cases disagree on duration (${[...durations].join(', ')})`);

  const chunks: Buffer[] = [];
  const planes: OverlayPlane[] = [];
  let offset = 0;
  const push = (
    plane: Omit<OverlayPlane, 'offset' | 'length' | 'inflatedLength' | 'quantMaxError' | 'nonZeroCells'>,
    q: Uint8Array,
    decoded: Float32Array,
    truth: Float32Array,
    /** Cells to measure the round-trip error over; others are "dry"/"never" in both. */
    count: (k: number) => boolean,
  ): void => {
    const gz = zlib.gzipSync(Buffer.from(q.buffer, q.byteOffset, q.byteLength), { level: 9 });
    let worst = 0;
    let nz = 0;
    for (let k = 0; k < q.length; k++) {
      if (q[k] !== 0) nz++;
      if (!count(k)) continue;
      const e = Math.abs(decoded[k] - truth[k]);
      if (e > worst) worst = e;
    }
    planes.push({ ...plane, offset, length: gz.byteLength, inflatedLength: q.length, quantMaxError: worst, nonZeroCells: nz });
    chunks.push(gz);
    offset += gz.byteLength;
  };

  for (const run of finest.sort((a, b) => a.case.localeCompare(b.case))) {
    const mdFine = loadField(outDir, run.fields.maxDepth, refGrid * refGrid);
    const md = blockMean(mdFine, refGrid, r);
    // Scale to the plane's own maximum (rounded up to 10 cm) rather than a shared constant: the rain case peaks at
    // ~8.8 m and gets ~40 % finer steps than it would under a 16 m scale shared with the crest case.
    let dmax = 0;
    for (let k = 0; k < md.length; k++) if (md[k] > dmax) dmax = md[k];
    const dScale = Math.max(0.5, Math.ceil(dmax * 10) / 10);
    const qd = encodeDepthPlane(md, dScale);
    push({ case: run.case, kind: 'maxDepth', quant: 'sqrt', scale: dScale, unit: 'm' }, qd, decodeDepthPlane(qd, dScale), md, (k) => md[k] > 0);

    if (!run.fields.arrival) continue;
    const arrFine = loadField(outDir, run.fields.arrival, refGrid * refGrid);
    const arr = coarsenArrival(arrFine, refGrid, r, md, FLOOD_THRESHOLD_M);
    const qa = encodeArrivalPlane(arr, run.duration);
    push(
      { case: run.case, kind: 'arrival', quant: 'linear', scale: run.duration, unit: 's' },
      qa,
      decodeArrivalPlane(qa, run.duration),
      arr,
      (k) => arr[k] >= 0,
    );
  }

  const bin = Buffer.concat(chunks);
  const manifest: ReferenceOverlayManifest = {
    version: OVERLAY_VERSION,
    preset: p.meta.id,
    nx: n,
    ny: p.meta.ny,
    cellSize: p.meta.cellSize,
    referenceGrid: refGrid,
    refine: r,
    bed: finest[0].bed,
    durationSeconds: finest[0].duration,
    arrivalThreshold: FLOOD_THRESHOLD_M,
    resample: 'block-mean',
    encoding: 'gzip',
    binary: 'reference.bin',
    sha256: crypto.createHash('sha256').update(bin).digest('hex'),
    planes,
    provenance: {
      generatedAt: new Date().toISOString(),
      gpu: finest[0].gpu,
      host: finest[0].host,
      runs: Object.fromEntries(
        finest.map((x) => [runKey(x), { wallClockS: x.wallClockS, substeps: x.substeps, massError: x.stats.massError }]),
      ),
    },
  };
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'reference.bin'), bin);
  fs.writeFileSync(path.join(destDir, 'reference.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  console.log(`\nWrote ${path.join(destDir, 'reference.json')} + reference.bin (${(bin.byteLength / 1e6).toFixed(3)} MB)`);
  for (const pl of planes) {
    console.log(
      `  ${pl.case} ${pl.kind}: ${(pl.length / 1e3).toFixed(0)} kB gzip of ${(pl.inflatedLength / 1e3).toFixed(0)} kB, ` +
        `scale ${pl.scale}${pl.unit}, worst round-trip ${pl.quantMaxError.toFixed(4)} ${pl.unit}, ` +
        `${((pl.nonZeroCells / pl.inflatedLength) * 100).toFixed(1)} % non-zero`,
    );
  }
}

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
  const arrival = flag('arrival');
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
        const o: RunOptions = { case: c, grid: g, bed, duration, tick, sample, arrival };
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
        // Taken from the runs themselves, not from the CLI: `--compare-only` re-derives the report with whatever
        // --minutes it was invoked with, and reading the flag here recorded 2700 s next to runs that were 1800 s.
        settings: {
          grids,
          cases,
          bed,
          durationSeconds: runs.length ? [...new Set(runs.map((r) => r.duration))] : [duration],
          tick: runs.length ? [...new Set(runs.map((r) => r.tick))] : [tick],
          sample: runs.length ? [...new Set(runs.map((r) => r.sample))] : [sample],
          threshold: FLOOD_THRESHOLD_M,
          probeRadiusM: PROBE_RADIUS_M,
        },
        runs,
        comparisons: comps,
      },
      null,
      1,
    )}\n`,
  );
  fs.writeFileSync(path.join(outDir, 'results.md'), markdown(runs, comps, p));
  console.log(`\nWrote ${path.join(outDir, 'results.json')} and results.md`);
  if (flag('export-overlay')) {
    exportOverlay(outDir, p, runs, path.resolve(ROOT, arg('overlay-out', `public/presets/${p.meta.id}`)));
  }
  for (const c of comps) {
    console.log(
      `  ${c.case} ${c.coarse}² vs ${c.fine}²: flooded ${headline(c).coarseKm2.toFixed(3)} vs ${headline(c).fineKm2.toFixed(3)} km² ` +
        `(${sgn(headline(c).pct, 2, ' %')}), IoU ${(headline(c).iou * 100).toFixed(1)} %, max-depth RMSE ${c.maxDepthFlooded.rmse.toFixed(3)} m on flooded land`,
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
