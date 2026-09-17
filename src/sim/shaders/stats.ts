/**
 * Readback reduction pass (runs only when a readback is due, ~3×/s — never per substep).
 *
 * Instead of mapping the whole rgba32float state (16 B/cell) plus the accounting buffer (8 B/cell) and looping
 * over millions of cells on the main thread, the GPU:
 *   • copies depth h into a compact storage buffer (4 B/cell) → SimSnapshot.depth, and
 *   • reduces everything else to one small record per 16×16 block (layout below).
 * The CPU then does one memcpy and a Float64 loop over N/256 blocks: ~1 ms at 1024² instead of ~20 ms.
 *
 * Per-block sums of depth and of the accounting buffer are EXACT: each value is split into a part on the ULP grid of
 * 512 × the block's largest value (these add up exactly in Float32) and the remainder (tiny; summed separately), and
 * the CPU adds both in Float64. A plain Float32 running sum rounds every small value added to a large total the same
 * way every readback: a stage disc's inflow (~100 m of depth per window) summed with its cells' rain (~1e-3 m) drifted
 * massError by ~1e-5 per sim-hour in tests/sim/conservation.test.ts.
 * Non-finite values (possible only in 'naive' mode) are detected from the IEEE-754 bit pattern — not with
 * `x != x`, which an optimizing shader compiler may fold away — counted, and excluded from sums and maxima.
 */
import { ACC_PER_CELL, SIM_WGSL, SNAP_WGSL } from './common';
import { FLOODED_DEPTH, WET_DEPTH } from '../constants';

/** Float32 slots per 16×16 block in the stats buffer. */
export const STATS_PER_BLOCK = 14;
export const STAT = {
  /** accIn + accInLo, accOut + accOutLo and volume + volumeLo are the exact block sums (see header). */
  accIn: 0,
  accOut: 1,
  volume: 2,
  maxDepth: 3,
  minDepth: 4,
  /** max u² + v² over cells with h > WET_DEPTH (SimStats.maxSpeed). */
  maxSpeed2Wet: 5,
  /** max u² + v² over cells with h ≥ VELOCITY_DEPTH (CFL input). */
  maxSpeed2: 6,
  /** max √(g·h) + |u| over cells with h ≥ VELOCITY_DEPTH (Courant statistic). */
  maxWave: 7,
  wetCells: 8,
  floodedCells: 9,
  nonFiniteCells: 10,
  accInLo: 11,
  accOutLo: 12,
  volumeLo: 13,
} as const;

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

export const statsWGSL = /* wgsl */ `
${SIM_WGSL}
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var exportTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read> acc: array<f32>;
// Bit c of dryMask = 1 if cell c was dry (h < WET_DEPTH) at reset (for SimStats.floodedArea).
@group(0) @binding(3) var<storage, read> dryMask: array<u32>;
@group(0) @binding(4) var<storage, read_write> depthOut: array<f32>;
@group(0) @binding(5) var<storage, read_write> blocks: array<f32>;

const WET = ${f(WET_DEPTH)};
const FLOODED = ${f(FLOODED_DEPTH)};
${SNAP_WGSL}

fn finite(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let bnx = sim.nx / 16;
  let bny = sim.ny / 16;
  let bx = i32(id.x);
  let by = i32(id.y);
  if (bx >= bnx || by >= bny) { return; }

  // First pass: the largest magnitudes, which fix the grid of the exact sums. Σ over 256 values ≤ 256·max < 512·max,
  // so running sums of values snapped to the ULP grid of 512·max never round.
  var mIn = 0.0;
  var mOut = 0.0;
  var mH = 0.0;
  for (var jj = 0; jj < 16; jj++) {
    let j = by * 16 + jj;
    for (var ii = 0; ii < 16; ii++) {
      let i = bx * 16 + ii;
      let c = u32(j) * u32(sim.nx) + u32(i);
      let a = ${ACC_PER_CELL}u * c;
      mIn = max(mIn, abs(acc[a]));
      mOut = max(mOut, abs(acc[a + 1u]));
      let h = textureLoad(exportTex, vec2i(i, j), 0).r;
      if (finite(h)) { mH = max(mH, abs(h)); }
    }
  }
  let eIn = ulpExp(512.0 * mIn);
  let eOut = ulpExp(512.0 * mOut);
  let eH = ulpExp(512.0 * mH);

  var accIn = 0.0;
  var accInLo = 0.0;
  var accOut = 0.0;
  var accOutLo = 0.0;
  var vol = 0.0;
  var volLo = 0.0;
  var maxH = 0.0;
  var minH = 0.0;
  var maxSp2Wet = 0.0;
  var maxSp2 = 0.0;
  var maxWave = 0.0;
  var wet = 0.0;
  var flooded = 0.0;
  var nonFinite = 0.0;

  for (var jj = 0; jj < 16; jj++) {
    let j = by * 16 + jj;
    for (var ii = 0; ii < 16; ii++) {
      let i = bx * 16 + ii;
      let c = u32(j) * u32(sim.nx) + u32(i);
      let t = textureLoad(exportTex, vec2i(i, j), 0);
      let h = t.r;
      depthOut[c] = h;
      let a = ${ACC_PER_CELL}u * c;
      let aI = acc[a];
      let aO = acc[a + 1u];
      let aIQ = snapE(aI, eIn);
      let aOQ = snapE(aO, eOut);
      accIn = accIn + aIQ;
      accInLo = accInLo + (aI - aIQ);
      accOut = accOut + aOQ;
      accOutLo = accOutLo + (aO - aOQ);
      if (!finite(h)) {
        nonFinite = nonFinite + 1.0;
        continue;
      }
      let hQ = snapE(h, eH);
      vol = vol + hQ;
      volLo = volLo + (h - hQ);
      maxH = max(maxH, h);
      minH = min(minH, h);
      if (h >= sim.velDepth) {
        let sp2 = t.g * t.g + t.b * t.b;
        if (!finite(sp2)) {
          nonFinite = nonFinite + 1.0;
          continue;
        }
        maxSp2 = max(maxSp2, sp2);
        maxWave = max(maxWave, sqrt(sim.g * h) + sqrt(sp2));
        if (h > WET) {
          wet = wet + 1.0;
          maxSp2Wet = max(maxSp2Wet, sp2);
          if (h > FLOODED && ((dryMask[c >> 5u] >> (c & 31u)) & 1u) == 1u) {
            flooded = flooded + 1.0;
          }
        }
      }
    }
  }

  let o = u32(by * bnx + bx) * ${STATS_PER_BLOCK}u;
  blocks[o + ${STAT.accIn}u] = accIn;
  blocks[o + ${STAT.accOut}u] = accOut;
  blocks[o + ${STAT.volume}u] = vol;
  blocks[o + ${STAT.maxDepth}u] = maxH;
  blocks[o + ${STAT.minDepth}u] = minH;
  blocks[o + ${STAT.maxSpeed2Wet}u] = maxSp2Wet;
  blocks[o + ${STAT.maxSpeed2}u] = maxSp2;
  blocks[o + ${STAT.maxWave}u] = maxWave;
  blocks[o + ${STAT.wetCells}u] = wet;
  blocks[o + ${STAT.floodedCells}u] = flooded;
  blocks[o + ${STAT.nonFiniteCells}u] = nonFinite;
  blocks[o + ${STAT.accInLo}u] = accInLo;
  blocks[o + ${STAT.accOutLo}u] = accOutLo;
  blocks[o + ${STAT.volumeLo}u] = volLo;
}
`;
