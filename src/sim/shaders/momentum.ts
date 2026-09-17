/**
 * Pass A — momentum. For every cell (i, j) compute the new unit discharge through its EAST face (qx) and its
 * SOUTH face (qy) from the old state. Output: rg32float flux texture (r = qx*, g = qy*), not yet limited.
 *
 *   q_new = ( q̃ − dt·A − g·hf·dt·S ) / ( 1 + g·dt·n²·|q| / hf^{7/3} )
 *
 *   q̃   grid-scale smoothing, q̃ = q + (1−θ)/2 · minmod(L, G)   (see SMOOTHING below).
 *   A    convective acceleration ∂(q·u)/∂x + ∂(q·v)/∂y, first-order upwind in conservative (momentum-flux)
 *        form, on faces whose whole stencil is wet (see ADVECTION below). Without it (the pure Bates 2010
 *        "local inertial" model) a frictionless dam break advances at only ~50 % of the true speed; with it
 *        the scheme reproduces the Ritter solution.
 *   S    water-surface slope (η_R − η_L)/dx. Written ((z_R − z_L) + (h_R − h_L))/dx so a lake at rest has
 *        S = 0 to rounding: the scheme is WELL-BALANCED (still water on steep terrain stays still).
 *   denominator: friction treated SEMI-IMPLICITLY. An explicit Manning term −dt·g·n²·q|q|/h^{7/3} is
 *        a stiff decay with rate ∝ 1/h^{4/3} → it overshoots and flips sign on thin films for any practical
 *        dt. Dividing instead can only shrink |q| toward 0, unconditionally stable.
 *   cap  robust mode clamps |q| ≤ hf·min(uMax, FrMax·√(g·hf)) — a last line of defence on thin films.
 *
 * SMOOTHING. A staggered explicit scheme is non-dissipative for gravity waves, so at low friction it keeps
 * grid-scale (2Δx) sloshing forever. de Almeida et al. (2012) damp it with θ-smoothing along each face's normal,
 * q̃ = q + (1−θ)/2·L with the 1-D Laplacian L = w_up·(q_up − q) + w_down·(q_down − q). On its own L is also a
 * strong artificial viscosity (≈ 0.1·dx²/dt ≈ 10 m²/s on a 7 m grid) acting on EVERY grid-scale pattern,
 * including the zig-zag a river MUST follow to run diagonally across a raster (it turns 90° at every stair step
 * of its banks): channels not aligned with the grid ran 3–5× deeper than Manning's normal depth. So L is
 * limited by the divergence-damping increment G = D_R − D_L, where D is the discrete divergence (net outflow) of
 * the two cells sharing the face, the same operator the continuity pass uses:
 *     L, G same sign → the one closer to 0;   opposite signs → 0          (minmod).
 *  • gravity-wave noise is DIVERGENT: L and G agree (G = L plus transverse terms of the same sign), the damping
 *    is de Almeida's. The 2-D checkerboard is damped exactly as before, so the stability limit Cr ≤ √θ
 *    (Solver.computeDt) is unchanged; for any other Fourier mode the damping lies between 0 and de Almeida's,
 *    which only relaxes the limit.
 *  • flow turning around a stair step is DIVERGENCE-FREE (G = 0): not damped at all.
 *  • a wet/dry front or flow into a dead end is 1-D and divergent (G = L): damped as before. A dry face stores
 *    q = 0, which is simply its value in L; no wet/dry switch is needed.
 *  • uniform flow: L = G = 0, preserved exactly; still water: q = 0 stays 0 (well-balanced).
 *  w = min(1, K·hf/hf_neighbour) (K = smoothingDepthRatio): a neighbour more than K× deeper counts less, so a deep
 *  channel's discharge is not poured into a thin shoreline film; |minmod(L, G)| ≤ |L| inherits that protection.
 *
 * ADVECTION is evaluated only where the 4 neighbouring faces of the same orientation (the stencil of the
 * upwind momentum fluxes) are all wet (advWeight). Next to a dry or blocked face the first-order upwind flux of a
 * staircase bank is dominated by the stair steps, not by resolved flow: dry neighbours counted as u = 0 act as
 * no-slip walls, and even with free slip the upwind dissipation of the 90° turns kept a 30° channel 20 %
 * too deep. Those faces use the local-inertial balance instead (Bates et al. 2010, as LISFLOOD-FP does
 * everywhere). Interior faces — where fronts are carried and the Ritter speed comes from — keep full advection.
 * tests/sim/channel.test.ts pins Manning normal depth in walled channels at 0/30/45/60°.
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

// Velocity of a WET face for the advection term (bounded in robust mode).
fn vel(q: f32, hf: f32) -> f32 {
  let u = q / hf;
  if (sim.robust != 0) { return clamp(u, -sim.uMax, sim.uMax); }
  return u;
}

fn isWet(hf: f32) -> bool {
  return hf >= sim.hMin;
}

// Wet/dry weight of a neighbouring face with flow depth hfN seen from a wet face of depth hf: 0 when the neighbour
// is dry or blocked (hfN < hMin), 1 once it holds max(hMin, 1 % of hf) more — a neighbour 100× shallower than this
// face is still "dry" for the purpose of the advection stencil. A threshold, but a CONTINUOUS one: a film hovering
// at the wet/dry threshold cannot switch the advection of a deep face on and off, and neither can rounding (Metal
// compiles with fast-math, so a film's face depth max(η) − max(z) carries the Float32 rounding of the bed
// elevation: ~1e-6 m at 10 m above the datum, ~1e-5 m at 100 m).
fn wetRamp(hfN: f32, hf: f32) -> f32 {
  return clamp((hfN - sim.hMin) / max(sim.hMin, 0.01 * hf), 0.0, 1.0);
}

// Advection weight of a face with depth hf from the depths of its 4 neighbouring parallel faces: 1 when all are
// wet, 0 when any is dry or blocked (see header).
fn advWeight(hf: f32, hfA: f32, hfB: f32, hfC: f32, hfD: f32) -> f32 {
  return wetRamp(min(min(hfA, hfB), min(hfC, hfD)), hf);
}

// Laplacian weight of a neighbouring parallel face with flow depth hfN: 1, or less if the neighbour is more than
// K× deeper (see header). No wet/dry switch: a dry face stores q = 0, which is simply its value.
fn smoothW(hf: f32, hfN: f32) -> f32 {
  return min(1.0, sim.smoothRatio * hf / max(hfN, sim.hMin));
}

fn minmod(a: f32, b: f32) -> f32 {
  if (!(a * b > 0.0)) { return 0.0; }
  return select(max(a, b), min(a, b), a > 0.0);
}

// Smoothing increment minmod(L, G) (see header). qc: this face; qUp/qDn + hfUp/hfDn: the parallel neighbours
// along the face normal; divJump: D_R − D_L of the two cells sharing the face.
fn smoothIncrement(hf: f32, qc: f32, qUp: f32, hfUp: f32, qDn: f32, hfDn: f32, divJump: f32) -> f32 {
  let lap = smoothW(hf, hfUp) * (qUp - qc) + smoothW(hf, hfDn) * (qDn - qc);
  return minmod(lap, divJump);
}

// hf: face depth (≥ hMin), slope: (η_R − η_L)/dx, qc: old flux, dq: smoothing increment, qPerp: mean of the
// 4 surrounding perpendicular faces, adv: convective acceleration.
fn momentum(hf: f32, slope: f32, qc: f32, dq: f32, qPerp: f32, adv: f32) -> f32 {
  let qmag = sqrt(qc * qc + qPerp * qPerp);
  // hf ≥ hMin (1e-4) here, so hf^{7/3} ≥ 4.6e-10: no underflow / division by zero in Float32.
  let hf73 = pow(hf, 7.0 / 3.0);
  if (sim.robust != 0) {
    // Local Courant guard (see header).
    let uf = min(qmag / hf, sim.uMax);
    let cr = 1.41421356 * (sqrt(sim.g * hf) + uf) * sim.dt / sim.dx;
    let ratio = min(1.0, sim.crGuard / max(cr, 1e-6));
    let dtm = sim.dt * ratio * ratio;
    let qt = qc + 0.5 * (1.0 - sim.theta) * dq;
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

  // C, E and S alone decide whether either face is wet. Most cells of a real map are dry, so the other
  // texels are fetched only when there is flow to compute (≈15–20 % faster on the Pittsburgh preset).
  let c = st(i, j);
  let e = st(i + 1, j);
  let s = st(i, j + 1);
  var hfx = 0.0;
  var hfy = 0.0;
  if (i < sim.nx - 1) { hfx = faceDepth(c.r, c.a, e.r, e.a); }
  if (j < sim.ny - 1) { hfy = faceDepth(c.r, c.a, s.r, s.a); }
  if (!isWet(hfx) && !isWet(hfy)) {
    // Both faces dry (east/south domain-edge faces are boundary faces, handled in pass B).
    textureStore(fluxOut, vec2i(i, j), vec4f(0.0));
    return;
  }
  let w  = st(i - 1, j);
  let n  = st(i, j - 1);
  let ne = st(i + 1, j - 1);
  let sw = st(i - 1, j + 1);
  let se = st(i + 1, j + 1);

  // Net outflow (m²/s) of this cell, for the smoothing limiter. The stored qx/qy of the last column/row are the
  // east/south boundary fluxes; west/north domain-edge fluxes are not stored, so evaluate the boundary rule.
  var qWc = w.g;
  var qNc = n.b;
  if (i == 0) { qWc = -bflux(c.r, i, j, 1, 0); }
  if (j == 0) { qNc = -bflux(c.r, i, j, 0, 1); }
  let divC = (c.g - qWc) + (c.b - qNc);

  var qxNew = 0.0;
  var qyNew = 0.0;

  // ── x-face between (i, j) and (i+1, j). The east edge face is a boundary face (handled in pass B). ──
  if (i < sim.nx - 1) {
    let hf = hfx;
    if (isWet(hf)) {
      let ee = st(i + 2, j);
      let slope = ((e.a - c.a) + (e.r - c.r)) / sim.dx;
      let qPerp = 0.25 * (c.b + e.b + n.b + ne.b);
      // Depths of the neighbouring x-faces: i−½, i+3/2 (along x) and the faces south/north of this one.
      let hfW = faceDepth(w.r, w.a, c.r, c.a);
      let hfE = faceDepth(e.r, e.a, ee.r, ee.a);
      let hfS = faceDepth(s.r, s.a, se.r, se.a);
      let hfN = faceDepth(n.r, n.a, ne.r, ne.a);
      var adv = 0.0;
      let wAdv = advWeight(hf, hfW, hfE, hfS, hfN);
      if (sim.advection != 0 && wAdv > 0.0) {
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
        let uS = vel(s.g, hfS);
        let uN = vel(n.g, hfN);
        let gS = vS * select(uS, uC, vS >= 0.0);
        let gN = vN * select(uC, uN, vN >= 0.0);
        adv = wAdv * ((mR - mL) + (gS - gN)) / sim.dx;
      }
      var qNe = ne.b;
      if (j == 0) { qNe = -bflux(e.r, i + 1, j, 0, 1); }
      let divE = (e.g - c.g) + (e.b - qNe);
      let dq = smoothIncrement(hf, c.g, w.g, hfW, e.g, hfE, divE - divC);
      qxNew = momentum(hf, slope, c.g, dq, qPerp, adv);
    }
  }

  // ── y-face between (i, j) and (i, j+1). ──
  if (j < sim.ny - 1) {
    let hf = hfy;
    if (isWet(hf)) {
      let ss = st(i, j + 2);
      let slope = ((s.a - c.a) + (s.r - c.r)) / sim.dx;
      let qPerp = 0.25 * (c.g + w.g + s.g + sw.g);
      // Depths of the neighbouring y-faces: j−½, j+3/2 (along y) and the faces east/west of this one.
      let hfN = faceDepth(n.r, n.a, c.r, c.a);
      let hfS = faceDepth(s.r, s.a, ss.r, ss.a);
      let hfE = faceDepth(e.r, e.a, se.r, se.a);
      let hfW = faceDepth(w.r, w.a, sw.r, sw.a);
      var adv = 0.0;
      let wAdv = advWeight(hf, hfN, hfS, hfE, hfW);
      if (sim.advection != 0 && wAdv > 0.0) {
        let vN = vel(n.b, hfN);
        let vC = vel(c.b, hf);
        let vS = vel(s.b, hfS);
        let qbU = 0.5 * (n.b + c.b);
        let qbD = 0.5 * (c.b + s.b);
        let mU = qbU * select(vC, vN, qbU >= 0.0);
        let mD = qbD * select(vS, vC, qbD >= 0.0);
        let uE = 0.5 * (c.g + s.g);
        let uW = 0.5 * (w.g + sw.g);
        let vE = vel(e.b, hfE);
        let vW = vel(w.b, hfW);
        let gE = uE * select(vE, vC, uE >= 0.0);
        let gW = uW * select(vC, vW, uW >= 0.0);
        adv = wAdv * ((mD - mU) + (gE - gW)) / sim.dx;
      }
      var qSw = sw.g;
      if (i == 0) { qSw = -bflux(s.r, i, j + 1, 1, 0); }
      let divS = (s.g - qSw) + (s.b - c.b);
      let dq = smoothIncrement(hf, c.b, n.b, hfN, s.b, hfS, divS - divC);
      qyNew = momentum(hf, slope, c.b, dq, qPerp, adv);
    }
  }

  textureStore(fluxOut, vec2i(i, j), vec4f(qxNew, qyNew, 0.0, 0.0));
}
`;
