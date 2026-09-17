/**
 * Pass B — flux limiter + continuity + forcing + mass accounting.
 *
 * Reads the old state and the unlimited fluxes from pass A, writes the new state (h, limited qx, limited qy, z)
 * and accumulates per-cell external volume into the accounting storage buffer (in, out) — in units of depth.
 *
 * POSITIVITY-PRESERVING FLUX LIMITER (robust mode). For each cell the volume that would leave in this step is
 *   O = dt/dx · (max(qE,0) + max(−qW,0) + max(qS,0) + max(−qN,0)),   k = min(1, h/O).
 * Every face flux is multiplied by k of its DONOR (upwind) cell. A cell can then never export more water than
 * it holds, so h ≥ 0 holds by construction — no clamping, which would silently create mass. Both cells
 * sharing a face apply the identical limited flux, so mass is conserved exactly (see EXACT TO THE LAST BIT).
 * Computing k of a neighbour needs that neighbour's four faces, hence the 13-texel flux stencil below.
 *
 * Stage sources set the depth to max(0, level − z) and zero the stored discharge of faces fully inside their disc (a
 * reservoir at rest; see the stage loop). Open-boundary outflow is closed on edge cells near inflow sources (bfluxC).
 *
 * Mass accounting: every change to h other than an exchange with a neighbour is added to the accounting buffer
 * (ACC_PER_CELL slots per cell): rain, inflow and stage refills to "in", open-boundary outflow, infiltration and stage
 * drains to "out", Float32 rounding (signed) to "rounding". The stats pass sums it exactly per block and zeroes it in
 * the same command encoder as the depth readback; the CPU adds the blocks in Float64, so SimStats.massError is real.
 *
 * EXACT TO THE LAST BIT. On a 20 m deep river one Float32 ULP of h is 1.9e-6 m while a substep moves ~1e-6–1e-5 m, so
 * h + Δ rounds by up to half a ULP, with the same sign substep after substep on a steady cell. The old booking
 * measured (h + Δ) − h, which Metal's compiler folds to Δ, so the rounding went unbooked: Pittsburgh at the 1936
 * crest in hurricane rain drifted 2.8e-4 per sim-hour (tests/sim/conservation.test.ts). Now:
 *   • the volume through each face, v = dt/dx·q, is ONE Float32 product computed identically by both cells sharing
 *     the face, so interior exchanges cancel exactly (a per-cell dt/dx·(Σq) rounds differently in each cell);
 *   • every face volume and the rain are snapped (SNAP_WGSL) to the ULP grid of the largest of h and those
 *     increments, so h + Σ(snapped) is exact, and what the snaps took off each face volume is booked;
 *   • infiltration and stage changes are snapped to the grid of the depth they change and booked as applied.
 * Left unbooked: a sum carrying into the next power of two, or h off the grid because an increment exceeds it
 * (a cell filling from nearly dry): half a ULP at most, once, random in sign.
 */
import { INFLOW_EDGE_MASK_CELLS } from '../constants';
import { ACC_PER_CELL, FORCING_WGSL, HELPERS_WGSL, SIM_WGSL, SNAP_WGSL } from './common';

export const continuityWGSL = /* wgsl */ `
${SIM_WGSL}
${FORCING_WGSL}
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<uniform> forcing: Forcing;
@group(0) @binding(2) var stateTex: texture_2d<f32>;
@group(0) @binding(3) var fluxTex: texture_2d<f32>;
@group(0) @binding(4) var stateOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(5) var<storage, read_write> acc: array<f32>;
${HELPERS_WGSL}
${SNAP_WGSL}

// Open-boundary outflow of an edge cell, closed near inflow sources: an inflow sits on a river just inside the edge
// it enters through, and the mound it builds would otherwise pour part of the discharge straight back out of that
// edge (INFLOW_EDGE_MASK_CELLS in constants.ts). Every boundary flux in this pass goes through here. momentum.ts
// has no forcing binding and uses plain bflux for its divergence estimate on the west/north edges (smoothing only).
fn bfluxC(h: f32, i: i32, j: i32, di: i32, dj: i32) -> f32 {
  let p = vec2f(f32(i) + 0.5, f32(j) + 0.5);
  for (var k = 0; k < sim.nSrc; k++) {
    let a = forcing.src[2 * k];
    if (a.w != 0.0) { continue; }
    if (distance(p, a.xy) < a.z + ${INFLOW_EDGE_MASK_CELLS.toFixed(1)}) { return 0.0; }
  }
  return bflux(h, i, j, di, dj);
}

fn fl(i: i32, j: i32) -> vec2f {
  return textureLoad(fluxTex, vec2i(clamp(i, 0, sim.nx - 1), clamp(j, 0, sim.ny - 1)), 0).rg;
}

// Limiter factor of a cell with depth h and unlimited face fluxes (E, W, S, N; positive = +x / +y).
fn kfac(h: f32, qE: f32, qW: f32, qS: f32, qN: f32, r: f32) -> f32 {
  let o = r * (max(qE, 0.0) + max(-qW, 0.0) + max(qS, 0.0) + max(-qN, 0.0));
  if (!(h > 0.0)) { return select(1.0, 0.0, o > 0.0); }
  // (1 − 1e-6): keep the limited outflow a hair below h so Float32 rounding cannot produce h < 0.
  return select(1.0, h * (1.0 - 1e-6) / o, o > h);
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  let j = i32(id.y);
  if (i >= sim.nx || j >= sim.ny) { return; }
  let nx1 = sim.nx - 1;
  let ny1 = sim.ny - 1;
  let r = sim.dt / sim.dx;

  let sc = st(i, j);
  let fc = fl(i, j);
  let fW = fl(i - 1, j);
  let fN = fl(i, j - 1);

  // Unlimited fluxes on the four faces of this cell (domain-edge faces from the boundary rule).
  var qE = fc.x;
  var qS = fc.y;
  var qW = fW.x;
  var qN = fN.y;
  if (i == nx1) { qE = bfluxC(sc.r, i, j, -1, 0); }
  if (i == 0)   { qW = -bfluxC(sc.r, i, j, 1, 0); }
  if (j == ny1) { qS = bfluxC(sc.r, i, j, 0, -1); }
  if (j == 0)   { qN = -bfluxC(sc.r, i, j, 0, 1); }

  if (sim.robust != 0) {
    let kc = kfac(sc.r, qE, qW, qS, qN, r);
    // East face: donor is this cell if flow is eastward, else the east neighbour.
    var kE = kc;
    if (qE < 0.0 && i < nx1) {
      let s = st(i + 1, j);
      let f = fl(i + 1, j);
      var e = f.x;
      var sS = f.y;
      var nN = fl(i + 1, j - 1).y;
      if (i + 1 == nx1) { e = bfluxC(s.r, i + 1, j, -1, 0); }
      if (j == ny1) { sS = bfluxC(s.r, i + 1, j, 0, -1); }
      if (j == 0) { nN = -bfluxC(s.r, i + 1, j, 0, 1); }
      kE = kfac(s.r, e, qE, sS, nN, r);
    }
    // West face: donor is the west neighbour if flow is eastward.
    var kW = kc;
    if (qW > 0.0 && i > 0) {
      let s = st(i - 1, j);
      var w = fl(i - 2, j).x;
      var sS = fW.y;
      var nN = fl(i - 1, j - 1).y;
      if (i - 1 == 0) { w = -bfluxC(s.r, i - 1, j, 1, 0); }
      if (j == ny1) { sS = bfluxC(s.r, i - 1, j, 0, -1); }
      if (j == 0) { nN = -bfluxC(s.r, i - 1, j, 0, 1); }
      kW = kfac(s.r, qW, w, sS, nN, r);
    }
    // South face: donor is the south neighbour if flow is northward.
    var kS = kc;
    if (qS < 0.0 && j < ny1) {
      let s = st(i, j + 1);
      let f = fl(i, j + 1);
      var e = f.x;
      var w = fl(i - 1, j + 1).x;
      var sS = f.y;
      if (i == nx1) { e = bfluxC(s.r, i, j + 1, -1, 0); }
      if (i == 0) { w = -bfluxC(s.r, i, j + 1, 1, 0); }
      if (j + 1 == ny1) { sS = bfluxC(s.r, i, j + 1, 0, -1); }
      kS = kfac(s.r, e, w, sS, qS, r);
    }
    // North face: donor is the north neighbour if flow is southward.
    var kN = kc;
    if (qN > 0.0 && j > 0) {
      let s = st(i, j - 1);
      var e = fN.x;
      var w = fl(i - 1, j - 1).x;
      var nN = fl(i, j - 2).y;
      if (i == nx1) { e = bfluxC(s.r, i, j - 1, -1, 0); }
      if (i == 0) { w = -bfluxC(s.r, i, j - 1, 1, 0); }
      if (j - 1 == 0) { nN = -bfluxC(s.r, i, j - 1, 0, 1); }
      kN = kfac(s.r, e, w, qN, nN, r);
    }
    qE = qE * select(kE, kc, qE >= 0.0);
    qW = qW * select(kc, kW, qW > 0.0);
    qS = qS * select(kS, kc, qS >= 0.0);
    qN = qN * select(kc, kN, qN > 0.0);
  }

  // ── Continuity + rain + inflow sources (see ROUNDING in the header) ──
  // Volume per unit area through each face this substep (positive = +x / +y). Both cells sharing a face compute the
  // identical Float32 product from the identical limited flux, so these cancel EXACTLY across every interior face;
  // only open-boundary faces take water out of the domain.
  let vE = r * qE;
  let vW = r * qW;
  let vS = r * qS;
  let vN = r * qN;
  var aIn = 0.0;
  var aOut = 0.0;
  var aRound = 0.0;
  var bOut = 0.0;
  if (i == nx1) { bOut = bOut + vE; }
  if (i == 0)   { bOut = bOut - vW; }
  if (j == ny1) { bOut = bOut + vS; }
  if (j == 0)   { bOut = bOut - vN; }
  aOut = aOut + bOut;

  let p = vec2f(f32(i) + 0.5, f32(j) + 0.5);
  var rate = sim.rain;
  for (var k = 0; k < sim.nStorm; k++) {
    let sc4 = forcing.storm[k];
    let d = distance(p, sc4.xy);
    if (d < sc4.z) { rate = rate + sc4.w * (1.0 - smoothstep(0.3 * sc4.z, sc4.z, d)); }
  }
  for (var k = 0; k < sim.nSrc; k++) {
    let a = forcing.src[2 * k];
    if (a.w != 0.0) { continue; }
    let d = distance(p, a.xy);
    if (d < a.z + 0.5) { rate = rate + forcing.src[2 * k + 1].x * (1.0 - smoothstep(a.z - 0.5, a.z + 0.5, d)); }
  }
  let rainT = sim.dt * rate;
  // One grid for h and every increment: the ULP of the largest of them, so the sum below is exact.
  let e0 = ulpExp(max(max(abs(sc.r), abs(rainT)), max(max(abs(vE), abs(vW)), max(abs(vS), abs(vN)))));
  let vEQ = snapE(vE, e0);
  let vWQ = snapE(vW, e0);
  let vSQ = snapE(vS, e0);
  let vNQ = snapE(vN, e0);
  let rainQ = snapE(rainT, e0);
  var h = sc.r + (((vWQ - vEQ) + (vNQ - vSQ)) + rainQ);
  aIn = aIn + rainQ;
  // What the snaps left out of the face volumes (each exact, ≤ half a ULP): booked, never silently created or lost.
  aRound = aRound - (((vW - vWQ) - (vE - vEQ)) + ((vN - vNQ) - (vS - vSQ)));
  // Float32 rounding residue of the limiter (≈1e-9 m at most): accounted.
  if (sim.robust != 0 && h < 0.0) {
    aRound = aRound - h;
    h = 0.0;
  }

  // ── Infiltration: only where there is water, never more than is available ──
  if (h > 0.0) {
    let infQ = snapInc(h, min(sim.infil * sim.dt, h));
    h = h - infQ;
    aOut = aOut + infQ;
  }

  // ── Stage sources: relax depth toward max(0, level − z) ──
  var h4 = h;
  var qEs = qE;
  var qSs = qS;
  for (var k = 0; k < sim.nSrc; k++) {
    let a = forcing.src[2 * k];
    if (a.w != 1.0) { continue; }
    let d = distance(p, a.xy);
    if (d >= a.z + 0.5) { continue; }
    // Momentum sponge: a stage disc is a reservoir at rest. Its depth is reset every substep but the stored
    // discharge is not, so without this momentum coasts across a large flat disc and re-emerges at the far rim
    // as a jet with no surface slope behind it. Faces with BOTH cells fully inside the disc (weight 1) forget
    // their discharge; rim faces keep theirs, so exchange with the domain is unaffected. Mass is untouched (h
    // above already used this step's flux).
    if (d <= a.z - 0.5) {
      if (i < nx1 && distance(p + vec2f(1.0, 0.0), a.xy) <= a.z - 0.5) { qEs = 0.0; }
      if (j < ny1 && distance(p + vec2f(0.0, 1.0), a.xy) <= a.z - 0.5) { qSs = 0.0; }
    }
    let alpha = sim.stageAlpha * (1.0 - smoothstep(a.z - 0.5, a.z + 0.5, d));
    let goal = max(0.0, forcing.src[2 * k + 1].x - sc.a);
    let before = h4;
    let dv = snapInc(before, alpha * (goal - before));
    h4 = before + dv;
    if (dv > 0.0) { aIn = aIn + dv; } else { aOut = aOut - dv; }
  }

  if (aIn != 0.0 || aOut != 0.0 || aRound != 0.0) {
    let idx = ${ACC_PER_CELL}u * (u32(j) * u32(sim.nx) + u32(i));
    acc[idx] = acc[idx] + aIn;
    acc[idx + 1u] = acc[idx + 1u] + aOut;
    acc[idx + 2u] = acc[idx + 2u] + aRound;
  }
  // Stored qx/qy of the last column/row are the limited boundary outflows (diagnostics + θ smoothing).
  textureStore(stateOut, vec2i(i, j), vec4f(h4, qEs, qSs, sc.a));
}
`;
