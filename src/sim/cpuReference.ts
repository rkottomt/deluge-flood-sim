/**
 * CPU (Float64) reference implementation of the Deluge shallow-water scheme.
 *
 * This is a deliberately straightforward, serial, line-by-line transcription of the GPU passes in
 * shaders/momentum.ts and shaders/continuity.ts. It exists so tests can cross-check the GPU solver
 * (Float32, massively parallel) against an independent implementation on small grids, and so the numerics
 * can be explored quickly in Node without a GPU. KEEP THE TWO IN SYNC.
 *
 * Staggered grid:  h[c] at cell centers; qx[c] = unit discharge (m²/s) through the EAST face of cell c
 * (i+½); qy[c] = through the SOUTH face (j+½). Domain-edge faces are "boundary faces": their flux is not a
 * prognostic variable, it is evaluated each step from the open-boundary rule (or 0 for walls). The value
 * stored in qx/qy of the last column/row is that (limited) boundary flux, kept for diagnostics/smoothing.
 */
import { GRAVITY, MAX_SOURCES } from './constants';
import { footprintWeight, stormWeight, type PackedForcing } from './forcing';

export interface SchemeStepParams {
  dt: number;
  dx: number;
  manningN: number;
  theta: number;
  /** K of the smoothing neighbour weight min(1, K·hf/hf_neighbour). */
  smoothingDepthRatio: number;
  /** Local Courant guard threshold Cr_max (robust mode). */
  courantGuard: number;
  hMin: number;
  uMax: number;
  froudeMax: number;
  /** Include the (conservative, upwind) convective acceleration terms. */
  advection: boolean;
  /** Global rain rate, m/s. */
  rain: number;
  /** Infiltration rate, m/s. */
  infiltration: number;
  open: boolean;
  robust: boolean;
  boundaryMinSlope: number;
  /** Froude cap on open-boundary outflow (robust mode). */
  boundaryFroudeMax: number;
  /** Stage relaxation factor for this step, 0..1. */
  stageAlpha: number;
  forcing?: PackedForcing | null;
}

const g = GRAVITY;

/**
 * Free-outflow boundary flux magnitude (outward, ≥ 0) for an edge cell with depth h and bed zc whose inner
 * neighbour has bed zin. Ghost cell: same depth, bed lowered by dx·S with S = max(local bed slope, minSlope).
 * The face depth is then h and the water-surface slope S; we use the steady (normal-flow) solution of the
 * momentum equation with Manning friction, q = h^{5/3}·√S / n, capped at Froude boundaryFroudeMax in robust mode.
 */
export function boundaryFlux(h: number, zc: number, zin: number, p: SchemeStepParams): number {
  if (!p.open || !(h >= p.hMin)) return 0;
  const S = Math.max((zin - zc) / p.dx, p.boundaryMinSlope);
  let q = (Math.pow(h, 5 / 3) * Math.sqrt(S)) / Math.max(p.manningN, 0.01);
  if (p.robust) q = Math.min(q, h * Math.min(p.uMax, p.boundaryFroudeMax * Math.sqrt(g * h)));
  return q;
}

/** Face flow depth hf = max(ηL, ηR) − max(zL, zR), arranged so bed differences cancel before depths add. */
export function faceDepth(hL: number, zL: number, hR: number, zR: number): number {
  const zf = Math.max(zL, zR);
  return Math.max(hL + (zL - zf), hR + (zR - zf));
}

/**
 * Momentum update for one face (see shaders/momentum.ts for the full explanation).
 *   hf: face depth; S: water-surface slope (ηR − ηL)/dx; qc: old flux; qUp/qDn with depths hfUp/hfDn: the
 *   neighbouring parallel faces (θ smoothing); qPerp: mean of the 4 surrounding perpendicular faces;
 *   adv: convective acceleration ∂(q·u)/∂x + ∂(q·v)/∂y at this face.
 */
export function momentum(
  hf: number,
  S: number,
  qc: number,
  qUp: number,
  hfUp: number,
  qDn: number,
  hfDn: number,
  qPerp: number,
  adv: number,
  p: SchemeStepParams,
): number {
  if (!(hf >= p.hMin)) return 0;
  const n2 = p.manningN * p.manningN;
  const qmag = Math.sqrt(qc * qc + qPerp * qPerp);
  const hf73 = Math.pow(hf, 7 / 3);
  if (p.robust) {
    // Local Courant guard: advance this face with dt_m = dt·(Cr_max/Cr_f)² if its own Courant number is too big.
    const uf = Math.min(qmag / hf, p.uMax);
    const cr = (Math.SQRT2 * (Math.sqrt(g * hf) + uf) * p.dt) / p.dx;
    const ratio = Math.min(1, p.courantGuard / Math.max(cr, 1e-6));
    const dtm = p.dt * ratio * ratio;
    // θ smoothing with depth-ratio-limited neighbour weights.
    const w = (hfN: number) => (hfN >= p.hMin ? Math.min(1, (p.smoothingDepthRatio * hf) / hfN) : 0);
    const qt = p.theta * qc + 0.5 * (1 - p.theta) * (w(hfUp) * qUp + w(hfDn) * qDn);
    const q = (qt - dtm * adv - g * hf * dtm * S) / (1 + (g * dtm * n2 * qmag) / hf73);
    const cap = hf * Math.min(p.uMax, p.froudeMax * Math.sqrt(g * hf));
    return Math.min(cap, Math.max(-cap, q));
  }
  return qc - p.dt * adv - g * hf * p.dt * S - (p.dt * g * n2 * qc * qmag) / hf73;
}

/** Positivity-preserving limiter factor for a cell with depth h and (unlimited) face fluxes. */
export function limiterK(h: number, qE: number, qW: number, qS: number, qN: number, r: number): number {
  const out = r * (Math.max(qE, 0) + Math.max(-qW, 0) + Math.max(qS, 0) + Math.max(-qN, 0));
  if (!(h > 0)) return out > 0 ? 0 : 1;
  // (1 − 1e-6) keeps the limited outflow a hair below the available depth so Float32 rounding on the GPU
  // cannot produce a negative depth. It changes no mass: both neighbours see the same limited flux.
  return out > h ? (h * (1 - 1e-6)) / out : 1;
}

export class CpuReferenceSolver {
  readonly nx: number;
  readonly ny: number;
  h: Float64Array;
  qx: Float64Array;
  qy: Float64Array;
  /** Bed elevation used by the scheme (any datum). */
  z: Float64Array;
  /** Cumulative external volume in / out, m³ (same categories as the GPU accounting buffer). */
  volumeIn = 0;
  volumeOut = 0;
  simTime = 0;

  constructor(nx: number, ny: number, bed: ArrayLike<number>, depth?: ArrayLike<number>) {
    this.nx = nx;
    this.ny = ny;
    const n = nx * ny;
    this.z = Float64Array.from(bed);
    this.h = depth ? Float64Array.from(depth) : new Float64Array(n);
    this.qx = new Float64Array(n);
    this.qy = new Float64Array(n);
  }

  volume(dx: number): number {
    let v = 0;
    for (let i = 0; i < this.h.length; i++) v += this.h[i];
    return v * dx * dx;
  }

  step(p: SchemeStepParams): void {
    const { nx, ny, h, z, qx, qy } = this;
    const N = nx * ny;
    const at = (i: number, j: number) => Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i));

    // Face depths & velocities of the OLD state (clamped neighbours at the domain edge, like textureLoad).
    const hfxOf = (i: number, j: number) => faceDepth(h[at(i, j)], z[at(i, j)], h[at(i + 1, j)], z[at(i + 1, j)]);
    const hfyOf = (i: number, j: number) => faceDepth(h[at(i, j)], z[at(i, j)], h[at(i, j + 1)], z[at(i, j + 1)]);
    // Face velocity for the advection term: 0 on dry faces, bounded by uMax in robust mode.
    const vel = (q: number, hf: number) => {
      if (!(hf >= p.hMin)) return 0;
      const u = q / hf;
      return p.robust ? Math.min(p.uMax, Math.max(-p.uMax, u)) : u;
    };
    const uxOf = (i: number, j: number) => vel(qx[at(i, j)], hfxOf(i, j));
    const vyOf = (i: number, j: number) => vel(qy[at(i, j)], hfyOf(i, j));

    // ── Pass A: momentum on interior faces ──────────────────────────────────────────────────────────
    const fx = new Float64Array(N);
    const fy = new Float64Array(N);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (i < nx - 1) {
          const e = c + 1;
          const hf = hfxOf(i, j);
          const S = (z[e] - z[c] + (h[e] - h[c])) / p.dx;
          const qW = qx[at(i - 1, j)];
          const qE = qx[at(i + 1, j)];
          const qyN = qy[at(i, j - 1)];
          const qyNE = qy[at(i + 1, j - 1)];
          const qPerp = 0.25 * (qy[c] + qy[e] + qyN + qyNE);
          const hfW = hfxOf(i - 1, j);
          const hfE = hfxOf(i + 1, j);
          let adv = 0;
          if (p.advection && hf >= p.hMin) {
            const uW = vel(qW, hfW);
            const uC = vel(qx[c], hf);
            const uE = vel(qE, hfE);
            // x-momentum flux q·u at the two adjacent cell centres (upwind velocity).
            const qbL = 0.5 * (qW + qx[c]);
            const qbR = 0.5 * (qx[c] + qE);
            const mL = qbL * (qbL >= 0 ? uW : uC);
            const mR = qbR * (qbR >= 0 ? uC : uE);
            // y-flux of x-momentum q·v at the two adjacent corners.
            const vS = 0.5 * (qy[c] + qy[e]);
            const vN = 0.5 * (qyN + qyNE);
            const gS = vS * (vS >= 0 ? uC : uxOf(i, j + 1));
            const gN = vN * (vN >= 0 ? uxOf(i, j - 1) : uC);
            adv = (mR - mL + (gS - gN)) / p.dx;
          }
          fx[c] = momentum(hf, S, qx[c], qW, hfW, qE, hfE, qPerp, adv, p);
        }
        if (j < ny - 1) {
          const s = c + nx;
          const hf = hfyOf(i, j);
          const S = (z[s] - z[c] + (h[s] - h[c])) / p.dx;
          const qN = qy[at(i, j - 1)];
          const qS = qy[at(i, j + 1)];
          const qxW = qx[at(i - 1, j)];
          const qxSW = qx[at(i - 1, j + 1)];
          const qPerp = 0.25 * (qx[c] + qxW + qx[s] + qxSW);
          const hfN = hfyOf(i, j - 1);
          const hfS = hfyOf(i, j + 1);
          let adv = 0;
          if (p.advection && hf >= p.hMin) {
            const vN = vel(qN, hfN);
            const vC = vel(qy[c], hf);
            const vS = vel(qS, hfS);
            const qbU = 0.5 * (qN + qy[c]);
            const qbD = 0.5 * (qy[c] + qS);
            const mU = qbU * (qbU >= 0 ? vN : vC);
            const mD = qbD * (qbD >= 0 ? vC : vS);
            const uE = 0.5 * (qx[c] + qx[s]);
            const uW = 0.5 * (qxW + qxSW);
            const gE = uE * (uE >= 0 ? vC : vyOf(i + 1, j));
            const gW = uW * (uW >= 0 ? vyOf(i - 1, j) : vC);
            adv = (mD - mU + (gE - gW)) / p.dx;
          }
          fy[c] = momentum(hf, S, qy[c], qN, hfN, qS, hfS, qPerp, adv, p);
        }
      }
    }

    // ── Pass B: limiter + continuity + forcing ──────────────────────────────────────────────────────
    const r = p.dt / p.dx;
    // Face fluxes of an arbitrary cell (boundary faces from the open-boundary rule).
    const faces = (i: number, j: number): [number, number, number, number] => {
      const c = j * nx + i;
      const qE = i === nx - 1 ? boundaryFlux(h[c], z[c], z[at(i - 1, j)], p) : fx[c];
      const qW = i === 0 ? -boundaryFlux(h[c], z[c], z[at(i + 1, j)], p) : fx[c - 1];
      const qS = j === ny - 1 ? boundaryFlux(h[c], z[c], z[at(i, j - 1)], p) : fy[c];
      const qN = j === 0 ? -boundaryFlux(h[c], z[c], z[at(i, j + 1)], p) : fy[c - nx];
      return [qE, qW, qS, qN];
    };
    const kOf = (i: number, j: number) => {
      const [qE, qW, qS, qN] = faces(i, j);
      return limiterK(h[j * nx + i], qE, qW, qS, qN, r);
    };

    const newH = new Float64Array(N);
    const newQx = new Float64Array(N);
    const newQy = new Float64Array(N);
    const f = p.forcing;
    let volIn = 0;
    let volOut = 0;

    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        let [qE, qW, qS, qN] = faces(i, j);
        if (p.robust) {
          const kc = kOf(i, j);
          qE *= qE >= 0 || i === nx - 1 ? kc : kOf(i + 1, j);
          qW *= qW < 0 || i === 0 ? kc : kOf(i - 1, j);
          qS *= qS >= 0 || j === ny - 1 ? kc : kOf(i, j + 1);
          qN *= qN < 0 || j === 0 ? kc : kOf(i, j - 1);
        }
        let hn = h[c] + r * (qW - qE + (qN - qS));
        // Outflow through domain-edge faces (only ever outward).
        let bOut = 0;
        if (i === nx - 1) bOut += qE;
        if (i === 0) bOut -= qW;
        if (j === ny - 1) bOut += qS;
        if (j === 0) bOut -= qN;
        volOut += r * bOut;

        if (p.robust && hn < 0) {
          volIn += -hn;
          hn = 0;
        }
        // Rain + storms + inflow sources.
        let rate = p.rain;
        const gx = i + 0.5;
        const gy = j + 0.5;
        if (f) {
          const base = 2 * MAX_SOURCES * 4;
          for (let k = 0; k < f.nStorms; k++) {
            const o = base + 4 * k;
            const d = Math.hypot(gx - f.data[o], gy - f.data[o + 1]);
            if (d < f.data[o + 2]) rate += f.data[o + 3] * stormWeight(d, f.data[o + 2]);
          }
          for (let k = 0; k < f.nSources; k++) {
            const o = 8 * k;
            if (f.data[o + 3] !== 0) continue;
            const R = f.data[o + 2];
            const d = Math.hypot(gx - f.data[o], gy - f.data[o + 1]);
            if (d < R + 0.5) rate += f.data[o + 4] * footprintWeight(d, R);
          }
        }
        const h2 = hn + p.dt * rate;
        volIn += h2 - hn;
        // Infiltration: only where there is water, never more than is available.
        let h3 = h2;
        if (h2 > 0) h3 = h2 - Math.min(p.infiltration * p.dt, h2);
        volOut += h2 - h3;
        // Stage sources relax the depth toward max(0, level − z).
        let h4 = h3;
        if (f) {
          for (let k = 0; k < f.nSources; k++) {
            const o = 8 * k;
            if (f.data[o + 3] !== 1) continue;
            const R = f.data[o + 2];
            const d = Math.hypot(gx - f.data[o], gy - f.data[o + 1]);
            if (d >= R + 0.5) continue;
            const a = p.stageAlpha * footprintWeight(d, R);
            const target = Math.max(0, f.data[o + 4] - z[c]);
            const before = h4;
            h4 = h4 + a * (target - h4);
            const dv = h4 - before;
            if (dv > 0) volIn += dv;
            else volOut -= dv;
          }
        }
        newH[c] = h4;
        newQx[c] = qE;
        newQy[c] = qS;
      }
    }
    this.h = newH;
    this.qx = newQx;
    this.qy = newQy;
    const area = p.dx * p.dx;
    this.volumeIn += volIn * area;
    this.volumeOut += volOut * area;
    this.simTime += p.dt;
  }
}
