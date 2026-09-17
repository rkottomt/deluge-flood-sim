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
 * Free-outflow boundary flux magnitude (outward, ≥ 0) of edge cell (i, j); (di, dj) points into the domain.
 * max(normal flow, transmissive):
 *  • normal flow: ghost cell with the same depth and a surface lower by dx·S, S = max(boundaryMinSlope,
 *    min(bed slope, surface slope)) toward the edge between the first and second inner cells (boundaryMinSlope
 *    alone if either is dry): q = h^{5/3}·√S / n, capped at Froude boundaryFroudeMax in robust mode;
 *  • transmissive: the outward discharge through the last interior face (old state), capped at the interior
 *    velocity/Froude cap in robust mode.
 * See bflux in shaders/common.ts for why.
 */
export function boundaryFlux(
  h: ArrayLike<number>,
  z: ArrayLike<number>,
  qx: ArrayLike<number>,
  qy: ArrayLike<number>,
  nx: number,
  ny: number,
  i: number,
  j: number,
  di: number,
  dj: number,
  p: SchemeStepParams,
): number {
  const c = j * nx + i;
  const hc = h[c];
  if (!p.open || !(hc >= p.hMin)) return 0;
  const at = (ii: number, jj: number) => Math.min(ny - 1, Math.max(0, jj)) * nx + Math.min(nx - 1, Math.max(0, ii));
  const a = at(i + di, j + dj);
  const b = at(i + 2 * di, j + 2 * dj);
  let S = p.boundaryMinSlope;
  if (h[a] >= p.hMin && h[b] >= p.hMin) {
    const bedS = (z[b] - z[a]) / p.dx;
    const surfS = (z[b] - z[a] + (h[b] - h[a])) / p.dx;
    S = Math.max(Math.min(bedS, surfS), p.boundaryMinSlope);
  }
  let qNormal = (Math.pow(hc, 5 / 3) * Math.sqrt(S)) / Math.max(p.manningN, 0.01);
  let qIn = 0;
  if (di < 0) qIn = qx[a];
  if (dj < 0) qIn = qy[a];
  if (di > 0) qIn = -qx[c];
  if (dj > 0) qIn = -qy[c];
  qIn = Math.max(qIn, 0);
  if (p.robust) {
    const cw = Math.sqrt(g * hc);
    qNormal = Math.min(qNormal, hc * Math.min(p.uMax, p.boundaryFroudeMax * cw));
    qIn = Math.min(qIn, hc * Math.min(p.uMax, p.froudeMax * cw));
  }
  return Math.max(qNormal, qIn);
}

/** Face flow depth hf = max(ηL, ηR) − max(zL, zR), arranged so bed differences cancel before depths add. */
export function faceDepth(hL: number, zL: number, hR: number, zR: number): number {
  const zf = Math.max(zL, zR);
  return Math.max(hL + (zL - zf), hR + (zR - zf));
}

/** Wet/dry ramp of a face depth: 0 below hMin, 1 above 2·hMin (a continuous hMin threshold; see shaders/momentum.ts). */
export function wetRamp(hf: number, hMin: number): number {
  return Math.min(1, Math.max(0, hf / hMin - 1));
}

/** minmod(a, b): the smaller-magnitude argument if both have the same sign, else 0. */
export function minmod(a: number, b: number): number {
  if (!(a * b > 0)) return 0;
  return a > 0 ? Math.min(a, b) : Math.max(a, b);
}

/**
 * Smoothing increment of one face: minmod(L, G) with L the depth-weighted 1-D Laplacian along the face normal
 * (a dry/blocked or much deeper neighbour counts as equal to this face) and G = divJump = D_R − D_L, the jump in
 * net cell outflow across the face (see shaders/momentum.ts).
 */
export function smoothingIncrement(
  hf: number,
  qc: number,
  qUp: number,
  hfUp: number,
  qDn: number,
  hfDn: number,
  divJump: number,
  p: SchemeStepParams,
): number {
  const w = (hfN: number) => wetRamp(hfN, p.hMin) * Math.min(1, (p.smoothingDepthRatio * hf) / Math.max(hfN, p.hMin));
  return minmod(w(hfUp) * (qUp - qc) + w(hfDn) * (qDn - qc), divJump);
}

/**
 * Momentum update for one face (see shaders/momentum.ts for the full explanation).
 *   hf: face depth; S: water-surface slope (ηR − ηL)/dx; qc: old flux; dq: smoothing increment
 *   (smoothingIncrement); qPerp: mean of the 4 surrounding perpendicular faces; adv: convective acceleration
 *   ∂(q·u)/∂x + ∂(q·v)/∂y at this face.
 */
export function momentum(hf: number, S: number, qc: number, dq: number, qPerp: number, adv: number, p: SchemeStepParams): number {
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
    const qt = qc + 0.5 * (1 - p.theta) * dq;
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

    // Face depths of the OLD state (clamped neighbours at the domain edge, like textureLoad).
    const hfxOf = (i: number, j: number) => faceDepth(h[at(i, j)], z[at(i, j)], h[at(i + 1, j)], z[at(i + 1, j)]);
    const hfyOf = (i: number, j: number) => faceDepth(h[at(i, j)], z[at(i, j)], h[at(i, j + 1)], z[at(i, j + 1)]);
    const wet = (hf: number) => hf >= p.hMin;
    // Advection weight: 1 if the 4 neighbouring parallel faces are wet, 0 if any is dry (wetRamp).
    const advWeight = (a: number, b: number, c: number, d: number) => wetRamp(Math.min(a, b, c, d), p.hMin);
    // Velocity of a WET face for the advection term, bounded by uMax in robust mode.
    const vel = (q: number, hf: number) => {
      const u = q / hf;
      return p.robust ? Math.min(p.uMax, Math.max(-p.uMax, u)) : u;
    };
    // Net outflow of every cell (old fluxes; the west/north domain-edge fluxes from the boundary rule, the stored
    // qx/qy of the last column/row are the east/south ones).
    const div = new Float64Array(N);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        const qW = i > 0 ? qx[c - 1] : -boundaryFlux(h, z, qx, qy, nx, ny, i, j, 1, 0, p);
        const qN = j > 0 ? qy[c - nx] : -boundaryFlux(h, z, qx, qy, nx, ny, i, j, 0, 1, p);
        div[c] = qx[c] - qW + (qy[c] - qN);
      }
    }

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
          const hfS = hfxOf(i, j + 1);
          const hfN = hfxOf(i, j - 1);
          let adv = 0;
          // Advection only where the whole stencil (the 4 neighbouring x-faces) is wet.
          const wAdv = advWeight(hfW, hfE, hfS, hfN);
          if (p.advection && wet(hf) && wAdv > 0) {
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
            const gS = vS * (vS >= 0 ? uC : vel(qx[at(i, j + 1)], hfS));
            const gN = vN * (vN >= 0 ? vel(qx[at(i, j - 1)], hfN) : uC);
            adv = (wAdv * (mR - mL + (gS - gN))) / p.dx;
          }
          const dq = wet(hf) ? smoothingIncrement(hf, qx[c], qW, hfW, qE, hfE, div[e] - div[c], p) : 0;
          fx[c] = momentum(hf, S, qx[c], dq, qPerp, adv, p);
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
          const hfE = hfyOf(i + 1, j);
          const hfW = hfyOf(i - 1, j);
          let adv = 0;
          const wAdv = advWeight(hfN, hfS, hfE, hfW);
          if (p.advection && wet(hf) && wAdv > 0) {
            const vN = vel(qN, hfN);
            const vC = vel(qy[c], hf);
            const vS = vel(qS, hfS);
            const qbU = 0.5 * (qN + qy[c]);
            const qbD = 0.5 * (qy[c] + qS);
            const mU = qbU * (qbU >= 0 ? vN : vC);
            const mD = qbD * (qbD >= 0 ? vC : vS);
            const uE = 0.5 * (qx[c] + qx[s]);
            const uW = 0.5 * (qxW + qxSW);
            const gE = uE * (uE >= 0 ? vC : vel(qy[at(i + 1, j)], hfE));
            const gW = uW * (uW >= 0 ? vel(qy[at(i - 1, j)], hfW) : vC);
            adv = (wAdv * (mD - mU + (gE - gW))) / p.dx;
          }
          const dq = wet(hf) ? smoothingIncrement(hf, qy[c], qN, hfN, qS, hfS, div[s] - div[c], p) : 0;
          fy[c] = momentum(hf, S, qy[c], dq, qPerp, adv, p);
        }
      }
    }

    // ── Pass B: limiter + continuity + forcing ──────────────────────────────────────────────────────
    const r = p.dt / p.dx;
    // Face fluxes of an arbitrary cell (boundary faces from the open-boundary rule).
    const faces = (i: number, j: number): [number, number, number, number] => {
      const c = j * nx + i;
      const qE = i === nx - 1 ? boundaryFlux(h, z, qx, qy, nx, ny, i, j, -1, 0, p) : fx[c];
      const qW = i === 0 ? -boundaryFlux(h, z, qx, qy, nx, ny, i, j, 1, 0, p) : fx[c - 1];
      const qS = j === ny - 1 ? boundaryFlux(h, z, qx, qy, nx, ny, i, j, 0, -1, p) : fy[c];
      const qN = j === 0 ? -boundaryFlux(h, z, qx, qy, nx, ny, i, j, 0, 1, p) : fy[c - nx];
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
