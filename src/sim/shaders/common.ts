/**
 * WGSL shared by the solver passes: uniform layouts + small numerical helpers.
 *
 * State texture layout (rgba32float, ping-ponged every substep):
 *   r = h   water depth at the cell center (m)
 *   g = qx  unit discharge through the cell's EAST face (m²/s)
 *   b = qy  unit discharge through the cell's SOUTH face (m²/s)
 *   a = z   bed elevation (ground + barrier) relative to the solver datum z0 (m)
 * Keeping z in the state texture means every pass gets h, q and z from a single texel fetch.
 * z is datum-relative so Float32 has ~1e-5 m resolution even for high-altitude terrain.
 */
import { MAX_SOURCES, MAX_STORMS } from '../constants';

/** Byte size of the `Sim` uniform (keep in sync with SIM_WGSL and packSimUniform in Solver.ts). */
export const SIM_UNIFORM_BYTES = 112;
/** Byte size of the `Forcing` uniform. */
export const FORCING_UNIFORM_BYTES = (2 * MAX_SOURCES + MAX_STORMS) * 16;

export const SIM_WGSL = /* wgsl */ `
struct Sim {
  nx: i32, ny: i32, dt: f32, dx: f32,
  g: f32, n2: f32, theta: f32, hMin: f32,
  uMax: f32, frMax: f32, rain: f32, infil: f32,
  robust: i32, openBnd: i32, nSrc: i32, nStorm: i32,
  stageAlpha: f32, invN: f32, minSlope: f32, advection: i32,
  resetMax: i32, velDepth: f32, crGuard: f32, smoothRatio: f32,
  bFrMax: f32, _pad0: f32, _pad1: f32, _pad2: f32,
};
`;

export const FORCING_WGSL = /* wgsl */ `
struct Forcing {
  // src[2k] = (gx, gy, R, kind 0 inflow / 1 stage), src[2k+1] = (value, 0, 0, 0)
  src: array<vec4f, ${2 * MAX_SOURCES}>,
  // storm[k] = (gx, gy, R, rate m/s)
  storm: array<vec4f, ${MAX_STORMS}>,
};
`;

/** Helpers; expect a uniform named \`sim\` and a texture named \`stateTex\` to be declared. */
export const HELPERS_WGSL = /* wgsl */ `
// Clamped texel fetch of the state (textureLoad on out-of-range coordinates is undefined → always clamp).
fn st(i: i32, j: i32) -> vec4f {
  return textureLoad(stateTex, vec2i(clamp(i, 0, sim.nx - 1), clamp(j, 0, sim.ny - 1)), 0);
}

// Face flow depth hf = max(ηL, ηR) − max(zL, zR). Written as max(hL + (zL − zf), hR + (zR − zf)) so the
// bed difference is formed first (exact for nearby Float32 values) and a lake at rest gives the same hf
// on both sides regardless of rounding in η = z + h.
fn faceDepth(hL: f32, zL: f32, hR: f32, zR: f32) -> f32 {
  let zf = max(zL, zR);
  return max(hL + (zL - zf), hR + (zR - zf));
}

// Free-outflow ("open") boundary flux (outward, ≥ 0) of the edge cell (i, j) with depth h; (di, dj) points INTO
// the domain. The larger of two outflows (outflow only, never inflow):
//
// 1. NORMAL FLOW. Ghost cell: same depth, water surface lower by dx·S → face depth h, surface slope S, and the
//    steady normal-flow solution of the momentum equation q = h^{5/3}·√S / n.
//    S = max(minSlope, min(bed slope, water-surface slope)), both measured toward the edge between the first and
//    second INNER cells (minSlope alone if either is dry). Each ingredient fixes a real failure seen on the
//    Pittsburgh DEM:
//     • bed slope alone: where the domain edge cuts a sloping river BANK, the bank cells pour out like a waterfall
//       (critical flow) and the pool rushes along the edge at 7 m/s;
//     • surface slope alone: outflow draws the surface down near the edge, which steepens the slope, which raises
//       the outflow… until whole rivers leave at critical speed;
//     • the minimum of the two: a river pool leaves at its minSlope "energy slope" (flat channel bed pins it, flat
//       pool surface pins the banks), hillside sheet flow leaves at its own slope (surface ∥ bed), and a single dry
//       bump next to the edge can't fake a cliff.
//    S never depends on this cell's own depth: an outflow that DEcreased as the edge cell filled would be
//    anti-diffusive, i.e. unstable in an explicit scheme. Robust mode caps this part at Froude bFrMax (1 = critical
//    flow, q = h·√(g·h)): water pouring over a free edge (a weir brink) cannot leave faster than critical flow.
//
// 2. TRANSMISSIVE: the discharge arriving through the last interior face (previous step). On its own, normal flow
//    needs the edge cell to pond until h^{5/3}·√S/n matches what arrives; once a river backs up its surface is flat,
//    S drops to minSlope, and a river sloping to the edge ran ~2.5× its normal depth over its last ~2 km. With
//    the max the edge cell simply passes on what reaches it, so a river leaves at the depth it arrives with. It
//    never drains the edge cell below what normal flow would, so it adds no feedback, and it depends only on the
//    neighbouring face, not on this cell's depth. Robust mode bounds it by the interior velocity/Froude cap
//    (the face it copies obeyed that cap already; this re-applies it at the edge cell's own depth).
fn bflux(h: f32, i: i32, j: i32, di: i32, dj: i32) -> f32 {
  if (sim.openBnd == 0 || !(h >= sim.hMin)) { return 0.0; }
  let a = st(i + di, j + dj);
  let b = st(i + 2 * di, j + 2 * dj);
  var S = sim.minSlope;
  if (a.r >= sim.hMin && b.r >= sim.hMin) {
    let bedS = (b.a - a.a) / sim.dx;
    let surfS = ((b.a - a.a) + (b.r - a.r)) / sim.dx;
    S = max(min(bedS, surfS), sim.minSlope);
  }
  var qNormal = pow(h, 5.0 / 3.0) * sqrt(S) * sim.invN;
  // Outward discharge through the last interior face: stored as the east/south face flux of the inner neighbour
  // for the east/south edges, and as this cell's own east/south face flux (sign flipped) for the west/north edges.
  var qIn = 0.0;
  if (di < 0) { qIn = a.g; }
  if (dj < 0) { qIn = a.b; }
  if (di > 0) { qIn = -st(i, j).g; }
  if (dj > 0) { qIn = -st(i, j).b; }
  qIn = max(qIn, 0.0);
  if (sim.robust != 0) {
    let c = sqrt(sim.g * h);
    qNormal = min(qNormal, h * min(sim.uMax, sim.bFrMax * c));
    qIn = min(qIn, h * min(sim.uMax, sim.frMax * c));
  }
  return max(qNormal, qIn);
}
`;
