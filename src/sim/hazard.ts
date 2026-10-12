/**
 * Hazard accumulators (contracts.ts HazardFields; FloodSolver.readHazardFields): the GPU layout, a Float64 CPU mirror
 * of the export pass's update, and the unpacking of a readback.
 *
 * GPU layout: one vec4f per cell in a storage buffer (GpuFloodSolver.hazardBuffer), nx·ny row-major:
 *   x = max speed while wet (m/s)   y = max h·|u| (m²/s)   z = first-wet time (s since reset, −1 never)   w = wet seconds
 * Max depth is not duplicated there: it already lives in stateTexture.a.
 *
 * The update runs in the export pass (shaders/exportState.ts, where the header explains the design): per export, with
 * h_prev the depth of the previous export, `time` the simulated time this export describes and `span` the simulated
 * seconds since the previous export. hazardUpdate below is the same arithmetic in Float64, so tests can replay a run's
 * exports on the CPU and compare (tests/sim/hazard.test.ts). KEEP THE TWO IN SYNC.
 */
import type { HazardFields } from '../contracts';
import { ARRIVAL_DEPTH } from './constants';

/** Float32 values per cell in the hazard buffer. */
export const HAZARD_PER_CELL = 4;
/** Slot of each accumulator inside a cell's vec4f. */
export const HZ = { maxSpeed: 0, maxDV: 1, firstWet: 2, wetSeconds: 3 } as const;

/** A fresh (reset-state, nothing recorded) accumulator array for `n` cells: firstWet −1, everything else 0. */
export function newHazardAccumulator(n: number): Float64Array {
  const a = new Float64Array(n * HAZARD_PER_CELL);
  for (let c = 0; c < n; c++) a[c * HAZARD_PER_CELL + HZ.firstWet] = -1;
  return a;
}

/**
 * One export's update of cell `c` (Float64 mirror of shaders/exportState.ts). `h` and `speed` are the exported depth and
 * cell-centred speed |(u, v)|, `hPrev` the previous export's depth; `reset` is the first export after a reset (the GPU's
 * resetMax), which starts the cell over from its current state with span 0. Non-finite inputs never reach the stored
 * values: a non-finite depth counts as dry, a non-finite speed or h·|u| is not recorded.
 */
export function hazardUpdate(
  acc: Float64Array | Float32Array,
  c: number,
  h: number,
  hPrev: number,
  speed: number,
  time: number,
  span: number,
  reset: boolean,
): void {
  const o = c * HAZARD_PER_CELL;
  const dv = h * speed;
  const ok = Number.isFinite(h) && Number.isFinite(dv);
  const wetNow = Number.isFinite(h) && h > ARRIVAL_DEPTH;
  if (reset) {
    acc[o + HZ.maxSpeed] = 0;
    acc[o + HZ.maxDV] = 0;
    acc[o + HZ.firstWet] = -1;
    acc[o + HZ.wetSeconds] = 0;
    hPrev = h;
    span = 0;
  }
  const wetPrev = Number.isFinite(hPrev) && hPrev > ARRIVAL_DEPTH;
  if (!reset && !wetNow && !wetPrev && !(ok && dv > 0)) return;
  let wetFrac = wetNow ? 1 : 0;
  if (wetNow !== wetPrev) {
    let r = (h - ARRIVAL_DEPTH) / (h - hPrev);
    r = Math.min(1, Math.max(0, Number.isFinite(r) ? r : 1));
    wetFrac = wetNow ? r : 1 - r;
  }
  acc[o + HZ.wetSeconds] += span * wetFrac;
  if (wetNow && acc[o + HZ.firstWet] < 0) acc[o + HZ.firstWet] = Math.max(time - span * wetFrac, 0);
  if (wetNow && ok) acc[o + HZ.maxSpeed] = Math.max(acc[o + HZ.maxSpeed], speed);
  if (ok) acc[o + HZ.maxDV] = Math.max(acc[o + HZ.maxDV], dv);
}

/**
 * HazardFields from a readback: `hazard` is the buffer's nx·ny·4 floats, `state` the exported rgba32float state
 * (h, u, v, max depth; nx·ny·4 floats, rows unpadded) of the same export.
 */
export function unpackHazardFields(hazard: Float32Array, state: Float32Array, nx: number, ny: number, simTime: number): HazardFields {
  const n = nx * ny;
  const maxDepth = new Float32Array(n);
  const maxSpeed = new Float32Array(n);
  const maxDV = new Float32Array(n);
  const firstWet = new Float32Array(n);
  const wetSeconds = new Float32Array(n);
  for (let c = 0, o = 0; c < n; c++, o += HAZARD_PER_CELL) {
    maxDepth[c] = state[o + 3];
    maxSpeed[c] = hazard[o + HZ.maxSpeed];
    maxDV[c] = hazard[o + HZ.maxDV];
    firstWet[c] = hazard[o + HZ.firstWet];
    wetSeconds[c] = hazard[o + HZ.wetSeconds];
  }
  return { nx, ny, simTime, maxDepth, maxSpeed, maxDV, firstWet, wetSeconds };
}
