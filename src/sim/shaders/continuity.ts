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
 * sharing a face apply the identical limited flux, so mass is conserved exactly (up to Float32 rounding).
 * Computing k of a neighbour needs that neighbour's four faces, hence the 13-texel flux stencil below.
 *
 * Mass accounting: every external change is measured as the actual Float32 difference it made to h
 * (h_after − h_before) and added to acc[2c] (in) or acc[2c+1] (out). The CPU copies + zeroes this buffer in
 * the same command encoder as the depth readback and sums it in Float64, so SimStats.massError is real.
 */
import { FORCING_WGSL, HELPERS_WGSL, SIM_WGSL } from './common';

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
  if (i == nx1) { qE = bflux(sc.r, i, j, -1, 0); }
  if (i == 0)   { qW = -bflux(sc.r, i, j, 1, 0); }
  if (j == ny1) { qS = bflux(sc.r, i, j, 0, -1); }
  if (j == 0)   { qN = -bflux(sc.r, i, j, 0, 1); }

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
      if (i + 1 == nx1) { e = bflux(s.r, i + 1, j, -1, 0); }
      if (j == ny1) { sS = bflux(s.r, i + 1, j, 0, -1); }
      if (j == 0) { nN = -bflux(s.r, i + 1, j, 0, 1); }
      kE = kfac(s.r, e, qE, sS, nN, r);
    }
    // West face: donor is the west neighbour if flow is eastward.
    var kW = kc;
    if (qW > 0.0 && i > 0) {
      let s = st(i - 1, j);
      var w = fl(i - 2, j).x;
      var sS = fW.y;
      var nN = fl(i - 1, j - 1).y;
      if (i - 1 == 0) { w = -bflux(s.r, i - 1, j, 1, 0); }
      if (j == ny1) { sS = bflux(s.r, i - 1, j, 0, -1); }
      if (j == 0) { nN = -bflux(s.r, i - 1, j, 0, 1); }
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
      if (i == nx1) { e = bflux(s.r, i, j + 1, -1, 0); }
      if (i == 0) { w = -bflux(s.r, i, j + 1, 1, 0); }
      if (j + 1 == ny1) { sS = bflux(s.r, i, j + 1, 0, -1); }
      kS = kfac(s.r, e, w, sS, qS, r);
    }
    // North face: donor is the north neighbour if flow is southward.
    var kN = kc;
    if (qN > 0.0 && j > 0) {
      let s = st(i, j - 1);
      var e = fN.x;
      var w = fl(i - 1, j - 1).x;
      var nN = fl(i, j - 2).y;
      if (i == nx1) { e = bflux(s.r, i, j - 1, -1, 0); }
      if (i == 0) { w = -bflux(s.r, i, j - 1, 1, 0); }
      if (j - 1 == 0) { nN = -bflux(s.r, i, j - 1, 0, 1); }
      kN = kfac(s.r, e, w, qN, nN, r);
    }
    qE = qE * select(kE, kc, qE >= 0.0);
    qW = qW * select(kc, kW, qW > 0.0);
    qS = qS * select(kS, kc, qS >= 0.0);
    qN = qN * select(kc, kN, qN > 0.0);
  }

  // ── Continuity ──
  var h = sc.r + r * ((qW - qE) + (qN - qS));
  var aIn = 0.0;
  var aOut = 0.0;
  // Outflow through open domain edges (boundary fluxes only ever point outward).
  var bOut = 0.0;
  if (i == nx1) { bOut = bOut + qE; }
  if (i == 0)   { bOut = bOut - qW; }
  if (j == ny1) { bOut = bOut + qS; }
  if (j == 0)   { bOut = bOut - qN; }
  aOut = aOut + r * bOut;
  // Float32 rounding residue (≈1e-9 m at most with the limiter); accounted, never silently created.
  if (sim.robust != 0 && h < 0.0) {
    aIn = aIn - h;
    h = 0.0;
  }

  // ── Rain (global + storm cells) + inflow sources ──
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
  let h2 = h + sim.dt * rate;
  aIn = aIn + (h2 - h);

  // ── Infiltration: only where there is water, never more than is available ──
  var h3 = h2;
  if (h2 > 0.0) { h3 = h2 - min(sim.infil * sim.dt, h2); }
  aOut = aOut + (h2 - h3);

  // ── Stage sources: relax depth toward max(0, level − z) ──
  var h4 = h3;
  for (var k = 0; k < sim.nSrc; k++) {
    let a = forcing.src[2 * k];
    if (a.w != 1.0) { continue; }
    let d = distance(p, a.xy);
    if (d >= a.z + 0.5) { continue; }
    let alpha = sim.stageAlpha * (1.0 - smoothstep(a.z - 0.5, a.z + 0.5, d));
    let goal = max(0.0, forcing.src[2 * k + 1].x - sc.a);
    let before = h4;
    h4 = h4 + alpha * (goal - h4);
    let dv = h4 - before;
    if (dv > 0.0) { aIn = aIn + dv; } else { aOut = aOut - dv; }
  }

  if (aIn != 0.0 || aOut != 0.0) {
    let idx = 2u * (u32(j) * u32(sim.nx) + u32(i));
    acc[idx] = acc[idx] + aIn;
    acc[idx + 1u] = acc[idx + 1u] + aOut;
  }
  // Stored qx/qy of the last column/row are the limited boundary outflows (diagnostics + θ smoothing).
  textureStore(stateOut, vec2i(i, j), vec4f(h4, qE, qS, sc.a));
}
`;
