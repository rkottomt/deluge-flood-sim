/**
 * Export pass (once per frame, not per substep): converts the internal staggered state into the
 * render-friendly cell-centered texture of the FloodSolver contract:
 *   r = h, g = u (east, m/s), b = v (south, m/s), a = max depth since reset.
 *
 * Cell velocity = total face discharge / total face flow depth:  u = (q_W + q_E) / (hf_W + hf_E).
 * For smooth flow hf ≈ h and this equals the usual (q_W + q_E) / 2h, but it stays physical in a thin cell
 * that water shoots through (e.g. at the foot of a cliff), where q/h would report absurd speeds.
 * u = v = 0 where h < velDepth (1 mm). Max depth is ping-ponged with this texture.
 */
import { HELPERS_WGSL, SIM_WGSL } from './common';

export const exportWGSL = /* wgsl */ `
${SIM_WGSL}
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var prevTex: texture_2d<f32>;
@group(0) @binding(3) var outTex: texture_storage_2d<rgba32float, write>;
${HELPERS_WGSL}

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = i32(id.x);
  let j = i32(id.y);
  if (i >= sim.nx || j >= sim.ny) { return; }
  let s = st(i, j);
  let h = s.r;
  var u = 0.0;
  var v = 0.0;
  if (h >= sim.velDepth) {
    let e = st(i + 1, j);
    let w = st(i - 1, j);
    let so = st(i, j + 1);
    let n = st(i, j - 1);
    // Domain-edge faces: the ghost cell has the same depth, so hf = h; W/N boundary fluxes are recomputed.
    var qW = w.g;
    var hfW = faceDepth(w.r, w.a, h, s.a);
    if (i == 0) { qW = -bflux(h, s.a, e.a); hfW = h; }
    var qN = n.b;
    var hfN = faceDepth(n.r, n.a, h, s.a);
    if (j == 0) { qN = -bflux(h, s.a, so.a); hfN = h; }
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
  if (sim.resetMax == 0) { hmax = max(textureLoad(prevTex, vec2i(i, j), 0).a, h); }
  textureStore(outTex, vec2i(i, j), vec4f(h, u, v, hmax));
}
`;
