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

// Free-outflow ("open") boundary: a ghost cell with the same depth and a bed lowered by
// dx·max(local bed slope, minSlope). Face depth = h, water-surface slope = S, and we take the steady
// normal-flow solution of the momentum equation, q = h^{5/3}·√S / n (outflow only, never inflow).
// Robust mode caps the outflow at Froude bFrMax (1 = critical flow, q = h·√(g·h)): water pouring over a free
// edge (a weir brink) cannot leave faster than critical flow. It also matters numerically: the local slope comes
// from ONE inner neighbour, and on rough DEMs a single bump would otherwise imply a cliff beyond the edge and a
// 15 m/s jet out of the domain (inflating max speed and, through the CFL condition, shrinking dt). Rivers
// leaving the domain are far below the cap (Fr ≈ 0.4); supercritical sheet flow just thickens in the last cell.
fn bflux(h: f32, zc: f32, zin: f32) -> f32 {
  if (sim.openBnd == 0 || !(h >= sim.hMin)) { return 0.0; }
  let S = max((zin - zc) / sim.dx, sim.minSlope);
  var q = pow(h, 5.0 / 3.0) * sqrt(S) * sim.invN;
  if (sim.robust != 0) {
    q = min(q, h * min(sim.uMax, sim.bFrMax * sqrt(sim.g * h)));
  }
  return q;
}
`;
