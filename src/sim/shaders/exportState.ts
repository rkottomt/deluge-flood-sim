/**
 * Export pass (once per frame, not per substep): converts the internal staggered state into the
 * render-friendly cell-centered texture of the FloodSolver contract:
 *   r = h, g = u (east, m/s), b = v (south, m/s), a = max depth since reset.
 *
 * Cell velocity = total face discharge / total face flow depth:  u = (q_W + q_E) / (hf_W + hf_E).
 * For smooth flow hf ≈ h and this equals the usual (q_W + q_E) / 2h, but it stays physical in a thin cell
 * that water shoots through (e.g. at the foot of a cliff), where q/h would report absurd speeds.
 * u = v = 0 where h < velDepth (1 mm). Max depth is ping-ponged with this texture.
 *
 * HAZARD ACCUMULATORS (FloodSolver.readHazardFields, contracts.ts HazardFields), folded into this pass rather than the
 * substeps: one vec4f per cell in a storage buffer, (max speed while wet, max h·|u|, first-wet time, wet seconds),
 * updated in place (each invocation owns its cell, so no ping-pong). "Wet" is h > ARRIVAL_DEPTH. Between two exports
 * h is taken to vary linearly from the previous export's depth (prevTex.r, a texel this pass loads anyway) to this
 * one's, so a crossing of ARRIVAL_DEPTH is placed inside the interval rather than at its end:
 *     r = (h − A) / (h − h_prev)  ∈ [0, 1]   the fraction of the interval, counted back from now, on h's side of A,
 * the first-wet time is hzTime − hzSpan·r and the wet seconds grow by hzSpan × the wet fraction. Resolution is
 * therefore the export interval (every other rendered frame in the app, ≤ readbackIntervalMs while step() runs), not
 * the substep — arrival times land within one interval of the per-substep answer, ~¼ of one on average on a dam-break
 * front (tests/sim/hazard.test.ts) — a cell that wets AND dries between two exports is missed, and max speed and
 * max h·|u| are sampled at exports, exactly as max depth always has been. Doing it per substep instead would add a
 * 16-byte read (and, on wet cells, a write) to every substep of up to 256 a frame — ~20 % of a substep at 1024², by
 * the accounting buffer's measured cost — for a field nobody reads at sub-second resolution. Here cells that are dry
 * now, were dry at the last export and carry no flow (most of any domain) neither read nor write the buffer: the
 * export at 1024² went from 0.21 to 0.23 ms on a river valley and to 0.30 ms with every cell wet (Dawn/D3D12).
 * Reset (resetMax) rewrites every cell: firstWet 0 where already wet (rivers, lakes), −1 elsewhere.
 * Non-finite depths or speeds (naive mode only) are detected from the IEEE-754 bit pattern — as in stats.ts, never by
 * a NaN comparison, which FXC folds away — and leave the accumulators untouched, so nothing non-finite is ever stored.
 */
import { ARRIVAL_DEPTH } from '../constants';
import { HELPERS_WGSL, POROSITY_WGSL, SIM_WGSL } from './common';

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

export const exportWGSL = /* wgsl */ `
${SIM_WGSL}
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var prevTex: texture_2d<f32>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba32float, write>;
// Hazard accumulators, nx·ny row-major: (max speed while wet m/s, max h·|u| m²/s, first-wet time s or −1, wet seconds).
@group(0) @binding(4) var<storage, read_write> hazard: array<vec4f>;
@group(0) @binding(5) var porTex: texture_2d<f32>;
// Pipeline variant: building porosity on — the exported depth and velocity are those of the open part of the cell
// (true depth V/φ, discharge per unit open width), what the renderer, the hazard maxima and the loss model read.
override POROSITY: bool = false;
${HELPERS_WGSL}
${POROSITY_WGSL}

fn stx(i: i32, j: i32) -> vec4f {
  let s = st(i, j);
  if (POROSITY) { return openState(s, por(i, j)); }
  return s;
}

const ARRIVAL = ${f(ARRIVAL_DEPTH)};

fn finite(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  let j = i32(id.y);
  if (i >= sim.nx || j >= sim.ny) { return; }
  let s = stx(i, j);
  let h = s.r;
  var u = 0.0;
  var v = 0.0;
  if (h >= sim.velDepth) {
    let e = stx(i + 1, j);
    let w = stx(i - 1, j);
    let so = stx(i, j + 1);
    let n = stx(i, j - 1);
    // Domain-edge faces: the ghost cell has the same depth, so hf = h; W/N boundary fluxes are recomputed.
    var qW = w.g;
    var hfW = faceDepth(w.r, w.a, h, s.a);
    if (i == 0) { qW = -bflux(h, i, j, 1, 0); hfW = h; }
    var qN = n.b;
    var hfN = faceDepth(n.r, n.a, h, s.a);
    if (j == 0) { qN = -bflux(h, i, j, 0, 1); hfN = h; }
    var hfE = faceDepth(h, s.a, e.r, e.a);
    if (i == sim.nx - 1) { hfE = h; }
    var hfS = faceDepth(h, s.a, so.r, so.a);
    if (j == sim.ny - 1) { hfS = h; }
    u = (qW + s.g) / max(hfW + hfE, 2.0 * sim.velDepth);
    v = (qN + s.b) / max(hfN + hfS, 2.0 * sim.velDepth);
    if (sim.robust != 0) {
      let sp = sqrt(u * u + v * v);
      if (sp > sim.uMax) {
        u = u * sim.uMax / sp;
        v = v * sim.uMax / sp;
      }
    }
  }
  var hmax = h;
  // The previous export (this cell's last exported depth and max depth); stale before the first export after a reset.
  var prev = vec4f(h, 0.0, 0.0, h);
  if (sim.resetMax == 0) {
    prev = textureLoad(prevTex, vec2i(i, j), 0);
    hmax = max(prev.a, h);
  }
  textureStore(outTex, vec2i(i, j), vec4f(h, u, v, hmax));

  // ── Hazard accumulators (header) ──
  let speed = sqrt(u * u + v * v);
  let dv = h * speed;
  let ok = finite(h) && finite(dv);
  let wetNow = finite(h) && h > ARRIVAL;
  let wetPrev = finite(prev.r) && prev.r > ARRIVAL;
  let c = u32(j) * u32(sim.nx) + u32(i);
  var hz = vec4f(0.0, 0.0, -1.0, 0.0);
  if (sim.resetMax == 0) {
    // Nothing to record: dry now, dry at the last export, no flow.
    if (!wetNow && !wetPrev && !(ok && dv > 0.0)) { return; }
    hz = hazard[c];
  }
  // Wet fraction of the interval since the last export (h linear in between; see the header).
  var wetFrac = select(0.0, 1.0, wetNow);
  if (wetNow != wetPrev) {
    // h ≠ h_prev here (one is above A, the other not). A non-finite side gives r = 1: the cell's present state then
    // holds for the whole interval.
    var r = (h - ARRIVAL) / (h - prev.r);
    r = clamp(select(1.0, r, finite(r)), 0.0, 1.0);
    wetFrac = select(1.0 - r, r, wetNow);
  }
  hz.w = hz.w + sim.hzSpan * wetFrac;
  if (wetNow && hz.z < 0.0) { hz.z = max(sim.hzTime - sim.hzSpan * wetFrac, 0.0); }
  if (wetNow && ok) { hz.x = max(hz.x, speed); }
  if (ok) { hz.y = max(hz.y, dv); }
  hazard[c] = hz;
}
`;
