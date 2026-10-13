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
import { GRAVITY, INFLOW_EDGE_MASK_CELLS, MAX_SOURCES } from './constants';
import { footprintWeight, stormWeight, type PackedForcing } from './forcing';
import { RHEO_VISC_DEPTH, type RheologyCoefficients } from './rheology';

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
  /** Fraction of advection kept on faces whose advection stencil touches a dry/blocked face (SolverOptions.wallAdvection). */
  wallAdvection: number;
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
  /**
   * Land-cover roughness factor per cell (row-major), relative to manningN: a face uses n = manningN · (r_L + r_R)/2
   * (shaders/momentum.ts ROUGHNESS MAP). Absent = uniform n.
   */
  roughness?: ArrayLike<number> | null;
  /** Storm-drain capacity per cell, m/s (already scaled), removed after infiltration. Absent = no drains. */
  drain?: ArrayLike<number> | null;
  /**
   * Building porosity as the solver applies it (shaders/common.ts POROSITY_WGSL): h then holds the volume per unit cell
   * area and qx/qy the discharge per unit cell width; the momentum pass works on h/φ and q/ψ and stores ψ·q. roof and
   * spout route the rain on roofs (continuity.ts DOWNSPOUTS). Absent = no porosity.
   */
  porosity?: { cell: ArrayLike<number>; faceE: ArrayLike<number>; faceS: ArrayLike<number>; roof: ArrayLike<number>; spout: ArrayLike<number> } | null;
  /** Debris-flow rheology (src/sim/rheology.ts rheologyCoefficients); absent or kind 0 = water (Manning). Robust mode only. */
  rheology?: RheologyCoefficients;
}

const g = GRAVITY;

/**
 * Free-outflow boundary flux magnitude (outward, ≥ 0) of edge cell (i, j); (di, dj) points into the domain.
 * max(normal flow, transmissive), capped at Froude boundaryFroudeMax in robust mode:
 *  • normal flow: ghost cell with the same depth and a surface lower by dx·S, S = max(boundaryMinSlope,
 *    min(bed slope, surface slope)) toward the edge between the first and second inner cells (boundaryMinSlope
 *    alone if either is dry): q = h^{5/3}·√S / n;
 *  • transmissive: q = u_in·h with u_in the outward velocity of the last interior face (old state).
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
  const qNormal = (Math.pow(hc, 5 / 3) * Math.sqrt(S)) / Math.max(p.manningN, 0.01);
  let qIn = 0;
  if (di < 0) qIn = qx[a];
  if (dj < 0) qIn = qy[a];
  if (di > 0) qIn = -qx[c];
  if (dj > 0) qIn = -qy[c];
  const hfIn = faceDepth(hc, z[c], h[a], z[a]);
  const uIn = qIn > 0 && hfIn >= p.hMin ? Math.min(qIn / hfIn, p.uMax) : 0;
  let q = Math.max(qNormal, uIn * hc);
  if (p.robust) q = Math.min(q, hc * Math.min(p.uMax, p.boundaryFroudeMax * Math.sqrt(g * hc)));
  return q;
}

/**
 * boundaryFlux with the inflow-source mask of the continuity pass (bfluxC in shaders/continuity.ts): 0 on edge cells
 * within radius + INFLOW_EDGE_MASK_CELLS of an inflow source.
 */
export function boundaryFluxMasked(
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
  const f = p.forcing;
  if (f) {
    for (let k = 0; k < f.nSources; k++) {
      const o = 8 * k;
      if (f.data[o + 3] !== 0) continue;
      // Float32 like the uniform, so the comparison matches the shader at the mask rim.
      const reach = Math.fround(f.data[o + 2] + INFLOW_EDGE_MASK_CELLS);
      if (Math.fround(Math.hypot(i + 0.5 - f.data[o], j + 0.5 - f.data[o + 1])) < reach) return 0;
    }
  }
  return boundaryFlux(h, z, qx, qy, nx, ny, i, j, di, dj, p);
}

/** Face flow depth hf = max(ηL, ηR) − max(zL, zR), arranged so bed differences cancel before depths add. */
export function faceDepth(hL: number, zL: number, hR: number, zR: number): number {
  const zf = Math.max(zL, zR);
  return Math.max(hL + (zL - zf), hR + (zR - zf));
}

/**
 * Wet/dry weight of a neighbouring face with depth hfN seen from a wet face of depth hf: 0 below hMin, 1 above
 * hMin + max(hMin, 1 % of hf) (a continuous wet/dry threshold for the advection stencil; see shaders/momentum.ts).
 */
export function wetRamp(hfN: number, hf: number, hMin: number): number {
  return Math.min(1, Math.max(0, (hfN - hMin) / Math.max(hMin, 0.01 * hf)));
}

/** minmod(a, b): the smaller-magnitude argument if both have the same sign, else 0. */
export function minmod(a: number, b: number): number {
  if (!(a * b > 0)) return 0;
  return a > 0 ? Math.min(a, b) : Math.max(a, b);
}

/**
 * Smoothing increment of one face: minmod(L, G) with L the 1-D Laplacian along the face normal (a much deeper
 * neighbour weighted down) and G = divJump = D_R − D_L, the jump in net cell outflow across the face (see
 * shaders/momentum.ts).
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
  const w = (hfN: number) => Math.min(1, (p.smoothingDepthRatio * hf) / Math.max(hfN, p.hMin));
  return minmod(w(hfUp) * (qUp - qc) + w(hfDn) * (qDn - qc), divJump);
}

/**
 * Rheology momentum update of one face (shaders/momentum.ts rheoMomentum and RHEOLOGY): explicit predictor, stop-or-reduce
 * for the yield / Coulomb impulse, semi-implicit viscous + turbulent denominator. dz: bed rise z_R − z_L across the face.
 */
export function rheoMomentum(
  hf: number,
  hf73: number,
  S: number,
  dz: number,
  qt: number,
  qmag: number,
  qPerp: number,
  adv: number,
  dtm: number,
  p: SchemeStepParams,
  r: RheologyCoefficients,
): number {
  const qStar = qt - dtm * adv - g * hf * dtm * S;
  const bedS = dz / p.dx;
  const cosT = 1 / Math.sqrt(1 + bedS * bedS);
  const stopQ = dtm * (r.tauRho + r.mu * g * hf * cosT);
  const qsMag = Math.sqrt(qStar * qStar + qPerp * qPerp);
  const q = qsMag > stopQ ? qStar * (1 - stopQ / qsMag) : 0;
  const hv = Math.max(hf, RHEO_VISC_DEPTH);
  const lin = r.visc / (hv * hv);
  const quad = ((g * r.n2) / hf73 + r.gXi / (hf * hf)) * qmag;
  return q / (1 + dtm * (lin + quad));
}

/**
 * Momentum update for one face (see shaders/momentum.ts for the full explanation).
 *   hf: face depth; S: water-surface slope (ηR − ηL)/dx; dz: bed rise z_R − z_L; qc: old flux; dq: smoothing increment
 *   (smoothingIncrement); qPerp: mean of the 4 surrounding perpendicular faces; adv: convective acceleration
 *   ∂(q·u)/∂x + ∂(q·v)/∂y at this face.
 */
export function momentum(
  hf: number,
  S: number,
  dz: number,
  qc: number,
  dq: number,
  qPerp: number,
  adv: number,
  p: SchemeStepParams,
  n2: number = p.manningN * p.manningN,
): number {
  if (!(hf >= p.hMin)) return 0;
  const qmag = Math.sqrt(qc * qc + qPerp * qPerp);
  const hf73 = Math.pow(hf, 7 / 3);
  if (p.robust) {
    // Local Courant guard: advance this face with dt_m = dt·(Cr_max/Cr_f)² if its own Courant number is too big.
    const uf = Math.min(qmag / hf, p.uMax);
    const cr = (Math.SQRT2 * (Math.sqrt(g * hf) + uf) * p.dt) / p.dx;
    const ratio = Math.min(1, p.courantGuard / Math.max(cr, 1e-6));
    const dtm = p.dt * ratio * ratio;
    const qt = qc + 0.5 * (1 - p.theta) * dq;
    const r = p.rheology;
    const q =
      r && r.kind !== 0
        ? rheoMomentum(hf, hf73, S, dz, qt, qmag, qPerp, adv, dtm, p, r)
        : (qt - dtm * adv - g * hf * dtm * S) / (1 + (g * dtm * n2 * qmag) / hf73);
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
    const { nx, ny, z } = this;
    const N = nx * ny;
    // The stored state (volume per unit area and discharge per unit cell width with porosity), read by pass B…
    const hV = this.h;
    const qxV = this.qx;
    const qyV = this.qy;
    // …and as pass A sees it: with porosity, the open part of each cell (depth V/φ, discharge q/ψ per unit open width).
    const por = p.porosity ?? null;
    let h = hV;
    let qx = qxV;
    let qy = qyV;
    if (por) {
      h = new Float64Array(N);
      qx = new Float64Array(N);
      qy = new Float64Array(N);
      for (let c = 0; c < N; c++) {
        h[c] = hV[c] / por.cell[c];
        qx[c] = por.faceE[c] > 0 ? qxV[c] / por.faceE[c] : 0;
        qy[c] = por.faceS[c] > 0 ? qyV[c] / por.faceS[c] : 0;
      }
    }
    const at = (i: number, j: number) => Math.min(ny - 1, Math.max(0, j)) * nx + Math.min(nx - 1, Math.max(0, i));

    // Face depths of the OLD state (clamped neighbours at the domain edge, like textureLoad).
    const hfxOf = (i: number, j: number) => faceDepth(h[at(i, j)], z[at(i, j)], h[at(i + 1, j)], z[at(i + 1, j)]);
    const hfyOf = (i: number, j: number) => faceDepth(h[at(i, j)], z[at(i, j)], h[at(i, j + 1)], z[at(i, j + 1)]);
    const wet = (hf: number) => hf >= p.hMin;
    // Velocity of a WET face for the advection term, bounded by uMax in robust mode.
    const vel = (q: number, hf: number) => {
      const u = q / hf;
      return p.robust ? Math.min(p.uMax, Math.max(-p.uMax, u)) : u;
    };
    // Neighbour velocity in the advection stencil: its own when wet, the face's own (free slip) when dry, blended
    // over hMin..2·hMin.
    const velN = (q: number, hfN: number, uC: number) => {
      const w = Math.min(1, Math.max(0, hfN / p.hMin - 1));
      return w <= 0 ? uC : uC + (vel(q, hfN) - uC) * w;
    };
    // Advection weight: 1 if the 4 neighbouring parallel faces are wet, wallAdvection if any is dry (wetRamp blend).
    const wallAdv = Math.min(1, Math.max(0, p.wallAdvection));
    const advWeight = (hf: number, a: number, b: number, c: number, d: number) =>
      wallAdv + (1 - wallAdv) * wetRamp(Math.min(a, b, c, d), hf, p.hMin);
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

    // Manning n² of the face between cells a and b: uniform, or from the roughness map (mean factor of the two cells).
    const n2u = p.manningN * p.manningN;
    const rough = p.roughness;
    const n2Face = (a: number, b: number) => {
      if (!rough) return n2u;
      const rf = 0.5 * (rough[a] + rough[b]);
      return n2u * rf * rf;
    };

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
          if (p.advection && wet(hf)) {
            const uC = vel(qx[c], hf);
            const uW = velN(qW, hfW, uC);
            const uE = velN(qE, hfE, uC);
            // x-momentum flux q·u at the two adjacent cell centres (upwind velocity).
            const qbL = 0.5 * (qW + qx[c]);
            const qbR = 0.5 * (qx[c] + qE);
            const mL = qbL * (qbL >= 0 ? uW : uC);
            const mR = qbR * (qbR >= 0 ? uC : uE);
            // y-flux of x-momentum q·v at the two adjacent corners.
            const vS = 0.5 * (qy[c] + qy[e]);
            const vN = 0.5 * (qyN + qyNE);
            const gS = vS * (vS >= 0 ? uC : velN(qx[at(i, j + 1)], hfS, uC));
            const gN = vN * (vN >= 0 ? velN(qx[at(i, j - 1)], hfN, uC) : uC);
            adv = (advWeight(hf, hfW, hfE, hfS, hfN) * (mR - mL + (gS - gN))) / p.dx;
          }
          const dq = wet(hf) ? smoothingIncrement(hf, qx[c], qW, hfW, qE, hfE, div[e] - div[c], p) : 0;
          fx[c] = momentum(hf, S, z[e] - z[c], qx[c], dq, qPerp, adv, p, n2Face(c, e)) * (por ? por.faceE[c] : 1);
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
          if (p.advection && wet(hf)) {
            const vC = vel(qy[c], hf);
            const vN = velN(qN, hfN, vC);
            const vS = velN(qS, hfS, vC);
            const qbU = 0.5 * (qN + qy[c]);
            const qbD = 0.5 * (qy[c] + qS);
            const mU = qbU * (qbU >= 0 ? vN : vC);
            const mD = qbD * (qbD >= 0 ? vC : vS);
            const uE = 0.5 * (qx[c] + qx[s]);
            const uW = 0.5 * (qxW + qxSW);
            const gE = uE * (uE >= 0 ? vC : velN(qy[at(i + 1, j)], hfE, vC));
            const gW = uW * (uW >= 0 ? velN(qy[at(i - 1, j)], hfW, vC) : vC);
            adv = (advWeight(hf, hfN, hfS, hfE, hfW) * (mD - mU + (gE - gW))) / p.dx;
          }
          const dq = wet(hf) ? smoothingIncrement(hf, qy[c], qN, hfN, qS, hfS, div[s] - div[c], p) : 0;
          fy[c] = momentum(hf, S, z[s] - z[c], qy[c], dq, qPerp, adv, p, n2Face(c, s)) * (por ? por.faceS[c] : 1);
        }
      }
    }

    // ── Pass B: limiter + continuity + forcing ──────────────────────────────────────────────────────
    const r = p.dt / p.dx;
    // Face fluxes of an arbitrary cell (boundary faces from the open-boundary rule, closed near inflow sources).
    const faces = (i: number, j: number): [number, number, number, number] => {
      const c = j * nx + i;
      const qE = i === nx - 1 ? boundaryFluxMasked(hV, z, qxV, qyV, nx, ny, i, j, -1, 0, p) : fx[c];
      const qW = i === 0 ? -boundaryFluxMasked(hV, z, qxV, qyV, nx, ny, i, j, 1, 0, p) : fx[c - 1];
      const qS = j === ny - 1 ? boundaryFluxMasked(hV, z, qxV, qyV, nx, ny, i, j, 0, -1, p) : fy[c];
      const qN = j === 0 ? -boundaryFluxMasked(hV, z, qxV, qyV, nx, ny, i, j, 0, 1, p) : fy[c - nx];
      return [qE, qW, qS, qN];
    };
    const kOf = (i: number, j: number) => {
      const [qE, qW, qS, qN] = faces(i, j);
      return limiterK(hV[j * nx + i], qE, qW, qS, qN, r);
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
        let hn = hV[c] + r * (qW - qE + (qN - qS));
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
        }
        // Rain and storms (rainRate) vs inflow sources, which are not rain (porosity below splits the rain only).
        const rainRate = rate;
        if (f) {
          for (let k = 0; k < f.nSources; k++) {
            const o = 8 * k;
            if (f.data[o + 3] !== 0) continue;
            const R = f.data[o + 2];
            const d = Math.hypot(gx - f.data[o], gy - f.data[o + 1]);
            if (d < R + 0.5) rate += f.data[o + 4] * footprintWeight(d, R);
          }
        }
        // Downspouts (porosity): the roof share's rain is piped into the drains first (the rest spills onto the cell),
        // or with no drains lands where the roofs discharge (spout).
        let piped = 0;
        if (por) {
          if (p.drain) {
            piped = Math.min(rainRate * por.roof[c], p.drain[c]);
            rate -= piped;
          } else {
            rate += rainRate * (por.spout[c] - por.roof[c]);
          }
        }
        const h2 = hn + p.dt * rate;
        volIn += h2 - hn;
        // Infiltration: only where there is water, never more than is available.
        let h3 = h2;
        if (h2 > 0) h3 = h2 - Math.min(p.infiltration * p.dt * (por ? 1 - por.roof[c] : 1), h2);
        volOut += h2 - h3;
        // Storm drains: the cell's capacity (less the roof rain piped into it), never more than is there (booked as
        // outflow, like infiltration).
        if (p.drain && h3 > 0) {
          const cap = (p.drain[c] - piped) * p.dt;
          if (cap > 0) {
            const d = Math.min(cap, h3);
            h3 -= d;
            volOut += d;
          }
        }
        // Stage sources relax the depth toward max(0, level − z).
        let h4 = h3;
        let qEs = qE;
        let qSs = qS;
        if (f) {
          for (let k = 0; k < f.nSources; k++) {
            const o = 8 * k;
            if (f.data[o + 3] !== 1) continue;
            const R = f.data[o + 2];
            const d = Math.hypot(gx - f.data[o], gy - f.data[o + 1]);
            if (d >= R + 0.5) continue;
            // Momentum sponge: faces with both cells fully inside the disc forget their discharge.
            if (d <= R - 0.5) {
              if (i < nx - 1 && Math.hypot(gx + 1 - f.data[o], gy - f.data[o + 1]) <= R - 0.5) qEs = 0;
              if (j < ny - 1 && Math.hypot(gx - f.data[o], gy + 1 - f.data[o + 1]) <= R - 0.5) qSs = 0;
            }
            const a = p.stageAlpha * footprintWeight(d, R);
            const target = Math.max(0, f.data[o + 4] - z[c]) * (por ? por.cell[c] : 1);
            const before = h4;
            h4 = h4 + a * (target - h4);
            const dv = h4 - before;
            if (dv > 0) volIn += dv;
            else volOut -= dv;
          }
        }
        newH[c] = h4;
        newQx[c] = qEs;
        newQy[c] = qSs;
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
