/**
 * Pass A — momentum. For every cell (i, j) compute the new unit discharge through its EAST face (qx) and its
 * SOUTH face (qy) from the old state. Output: rg32float flux texture (r = qx*, g = qy*), not yet limited.
 *
 *   q_new = ( q̃ − dt·A − g·hf·dt·S ) / ( 1 + g·dt·n²·|q| / hf^{7/3} )
 *
 *   q̃   de Almeida θ-smoothing: θ·q + (1−θ)/2·(w_up·q_up + w_down·q_down). Damps the grid-scale (2Δx)
 *        oscillation that a staggered explicit scheme otherwise develops when friction is small.
 *        w = min(1, K·hf/hf_neighbour) (K = smoothingDepthRatio): smoothing may not pour a DEEP neighbour's
 *        discharge into a much shallower face (e.g. a 3 mm shoreline film next to a 20 m channel), where the
 *        same q would mean a huge velocity. For ordinary depth variations (< K×) w = 1 and uniform discharge
 *        is preserved exactly. w ≤ 1 only shortens the smoothing stencil, so the stability limit (Cr ≤ √θ,
 *        see Solver.computeDt) is unchanged.
 *   A    convective acceleration ∂(q·u)/∂x + ∂(q·v)/∂y, first-order upwind in conservative (momentum-flux)
 *        form. Without it (the pure Bates 2010 "local inertial" model) a frictionless dam break advances at
 *        only ~50 % of the true speed; with it the scheme reproduces the Ritter solution.
 *   S    water-surface slope (η_R − η_L)/dx. Written ((z_R − z_L) + (h_R − h_L))/dx so a lake at rest has
 *        S = 0 to rounding: the scheme is WELL-BALANCED (still water on steep terrain stays still).
 *   denominator: friction treated SEMI-IMPLICITLY. An explicit Manning term −dt·g·n²·q|q|/h^{7/3} is
 *        a stiff decay with rate ∝ 1/h^{4/3} → it overshoots and flips sign on thin films for any practical
 *        dt. Dividing instead can only shrink |q| toward 0, unconditionally stable.
 *   cap  robust mode clamps |q| ≤ hf·min(uMax, FrMax·√(g·hf)) — a last line of defence on thin films.
 *
 * LOCAL COURANT GUARD (robust mode). dt comes from maxima read back asynchronously, so it can be stale: a dam
 * break piling water against a wall deepens it faster than the CPU learns about it. For each face we compute
 * its own Courant number Cr_f = √2·(√(g·hf) + |u_f|)·dt/dx. If Cr_f exceeds the stability limit Cr_max we
 * advance THIS face's momentum with dt_m = dt·(Cr_max/Cr_f)². The gravity-wave stability condition of the
 * forward–backward scheme involves the product dt_m·dt_continuity, so the face is exactly back at Cr_max.
 * The water still moves (continuity uses the full dt), mass is still exactly conserved, still water still
 * stays still (S = 0 ⇒ q = 0), and whenever the global CFL estimate is valid the guard is inactive (dt_m = dt).
 *
 * 'naive' mode (stability demo) uses explicit friction, no smoothing, no guard and no cap.
 */
import { HELPERS_WGSL, SIM_WGSL } from './common';

export const momentumWGSL = /* wgsl */ `
${SIM_WGSL}
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var fluxOut: texture_storage_2d<rg32float, write>;
${HELPERS_WGSL}

// Face velocity used by the advection term (0 on dry faces; bounded in robust mode).
fn vel(q: f32, hf: f32) -> f32 {
  if (!(hf >= sim.hMin)) { return 0.0; }
  let u = q / hf;
  if (sim.robust != 0) { return clamp(u, -sim.uMax, sim.uMax); }
  return u;
}

// Smoothing weight of a neighbouring parallel face with flow depth hfN (see header).
fn smoothW(hf: f32, hfN: f32) -> f32 {
  if (!(hfN >= sim.hMin)) { return 0.0; }
  return min(1.0, sim.smoothRatio * hf / hfN);
}

// hf: face depth (≥ hMin), slope: (η_R − η_L)/dx, qc: old flux, qUp/qDn + hfUp/hfDn: the two neighbouring
// parallel faces, qPerp: mean of the 4 surrounding perpendicular faces, adv: convective acceleration.
fn momentum(hf: f32, slope: f32, qc: f32, qUp: f32, hfUp: f32, qDn: f32, hfDn: f32, qPerp: f32, adv: f32) -> f32 {
  let qmag = sqrt(qc * qc + qPerp * qPerp);
  // hf ≥ hMin (1e-4) here, so hf^{7/3} ≥ 4.6e-10: no underflow / division by zero in Float32.
  let hf73 = pow(hf, 7.0 / 3.0);
  if (sim.robust != 0) {
    // Local Courant guard (see header).
    let uf = min(qmag / hf, sim.uMax);
    let cr = 1.41421356 * (sqrt(sim.g * hf) + uf) * sim.dt / sim.dx;
    let ratio = min(1.0, sim.crGuard / max(cr, 1e-6));
    let dtm = sim.dt * ratio * ratio;
    let qt = sim.theta * qc + 0.5 * (1.0 - sim.theta) * (smoothW(hf, hfUp) * qUp + smoothW(hf, hfDn) * qDn);
    let fric = sim.g * dtm * sim.n2 * qmag / hf73;
    let q = (qt - dtm * adv - sim.g * hf * dtm * slope) / (1.0 + fric);
    let cap = hf * min(sim.uMax, sim.frMax * sqrt(sim.g * hf));
    return clamp(q, -cap, cap);
  }
  let fric = sim.g * sim.dt * sim.n2 * qmag / hf73;
  return qc - sim.dt * adv - sim.g * hf * sim.dt * slope - fric * qc;
}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  let j = i32(id.y);
  if (i >= sim.nx || j >= sim.ny) { return; }

  // 3×3 neighbourhood (minus the NW corner). The EE / SS texels are fetched only on wet faces.
  let c  = st(i, j);
  let e  = st(i + 1, j);
  let w  = st(i - 1, j);
  let s  = st(i, j + 1);
  let n  = st(i, j - 1);
  let ne = st(i + 1, j - 1);
  let sw = st(i - 1, j + 1);
  let se = st(i + 1, j + 1);

  var qxNew = 0.0;
  var qyNew = 0.0;

  // ── x-face between (i, j) and (i+1, j). The east edge face is a boundary face (handled in pass B). ──
  if (i < sim.nx - 1) {
    let hf = faceDepth(c.r, c.a, e.r, e.a);
    if (hf >= sim.hMin) {
      let ee = st(i + 2, j);
      let slope = ((e.a - c.a) + (e.r - c.r)) / sim.dx;
      let qPerp = 0.25 * (c.b + e.b + n.b + ne.b);
      // Depths of the parallel neighbour faces i−½ and i+3/2.
      let hfW = faceDepth(w.r, w.a, c.r, c.a);
      let hfE = faceDepth(e.r, e.a, ee.r, ee.a);
      var adv = 0.0;
      if (sim.advection != 0) {
        let uW = vel(w.g, hfW);
        let uC = vel(c.g, hf);
        let uE = vel(e.g, hfE);
        // x-flux of x-momentum at the cell centres left/right of the face.
        let qbL = 0.5 * (w.g + c.g);
        let qbR = 0.5 * (c.g + e.g);
        let mL = qbL * select(uC, uW, qbL >= 0.0);
        let mR = qbR * select(uE, uC, qbR >= 0.0);
        // y-flux of x-momentum at the corners south/north of the face.
        let vS = 0.5 * (c.b + e.b);
        let vN = 0.5 * (n.b + ne.b);
        let uS = vel(s.g, faceDepth(s.r, s.a, se.r, se.a));
        let uN = vel(n.g, faceDepth(n.r, n.a, ne.r, ne.a));
        let gS = vS * select(uS, uC, vS >= 0.0);
        let gN = vN * select(uC, uN, vN >= 0.0);
        adv = ((mR - mL) + (gS - gN)) / sim.dx;
      }
      qxNew = momentum(hf, slope, c.g, w.g, hfW, e.g, hfE, qPerp, adv);
    }
  }

  // ── y-face between (i, j) and (i, j+1). ──
  if (j < sim.ny - 1) {
    let hf = faceDepth(c.r, c.a, s.r, s.a);
    if (hf >= sim.hMin) {
      let ss = st(i, j + 2);
      let slope = ((s.a - c.a) + (s.r - c.r)) / sim.dx;
      let qPerp = 0.25 * (c.g + w.g + s.g + sw.g);
      // Depths of the parallel neighbour faces j−½ and j+3/2.
      let hfN = faceDepth(n.r, n.a, c.r, c.a);
      let hfS = faceDepth(s.r, s.a, ss.r, ss.a);
      var adv = 0.0;
      if (sim.advection != 0) {
        let vN = vel(n.b, hfN);
        let vC = vel(c.b, hf);
        let vS = vel(s.b, hfS);
        let qbU = 0.5 * (n.b + c.b);
        let qbD = 0.5 * (c.b + s.b);
        let mU = qbU * select(vC, vN, qbU >= 0.0);
        let mD = qbD * select(vS, vC, qbD >= 0.0);
        let uE = 0.5 * (c.g + s.g);
        let uW = 0.5 * (w.g + sw.g);
        let vE = vel(e.b, faceDepth(e.r, e.a, se.r, se.a));
        let vW = vel(w.b, faceDepth(w.r, w.a, sw.r, sw.a));
        let gE = uE * select(vE, vC, uE >= 0.0);
        let gW = uW * select(vC, vW, uW >= 0.0);
        adv = ((mD - mU) + (gE - gW)) / sim.dx;
      }
      qyNew = momentum(hf, slope, c.b, n.b, hfN, s.b, hfS, qPerp, adv);
    }
  }

  textureStore(fluxOut, vec2i(i, j), vec4f(qxNew, qyNew, 0.0, 0.0));
}
`;
