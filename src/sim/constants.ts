/**
 * Numerical constants and tunables shared by the GPU solver, the CPU reference and the tests.
 *
 * Everything here is in SI units (m, s). The UI talks in mm/hr; conversion happens at the solver boundary.
 */

/** Gravitational acceleration, m/s². */
export const GRAVITY = 9.81;

/**
 * Solver tunables that are NOT part of the public SimParams contract. They have good defaults; they are
 * exposed (4th argument of createSolver) mainly for tests, benchmarks and experimentation.
 */
export interface SolverOptions {
  /**
   * de Almeida (2012) θ-smoothing weight. q̃ = θ·q_c + (1−θ)/2·(q_up + q_down). θ = 1 disables smoothing.
   * 0.7–0.9 damps the grid-scale (checkerboard) oscillations that the plain local-inertial scheme develops
   * at low friction, at the cost of a tiny amount of numerical diffusion.
   */
  theta: number;
  /**
   * K in the θ-smoothing neighbour weight w = min(1, K·hf/hf_neighbour): a neighbouring face contributes fully
   * unless it is more than K× deeper than this face. Stops smoothing from pouring a deep channel's discharge
   * into a thin shoreline film (spurious velocities, slow drift of a lake at rest) while leaving ordinary
   * depth variations — and uniform discharge — untouched.
   */
  smoothingDepthRatio: number;
  /**
   * Include the convective acceleration terms ∂(q·u)/∂x + ∂(q·v)/∂y (first-order upwind, conservative form).
   * false = the pure local-inertial model of Bates et al. (2010). With advection the scheme reproduces the
   * Ritter dam-break solution; without it fronts on frictionless beds advance at roughly half speed.
   */
  advection: boolean;
  /** Face flow depth below which a face carries no flux (wetting/drying threshold), m. */
  hMin: number;
  /** Robust mode velocity cap, m/s. */
  uMax: number;
  /** Robust mode Froude-number cap. */
  froudeMax: number;
  /** Minimum bed slope used by the open (free outflow) boundary ghost cell. */
  boundaryMinSlope: number;
  /** Robust mode Froude cap on open-boundary outflow; 1 = critical flow over a free edge (see bflux in shaders/common.ts). */
  boundaryFroudeMax: number;
  /** Relaxation time constant for stage sources, s (0 = set level directly). */
  stageRelaxSeconds: number;
  /**
   * Largest Courant number robust mode will use, whatever SimParams.cfl says. Courant numbers in Deluge are
   * TWO-DIMENSIONAL: Cr = √2·(√(g·h) + |u|)·dt/dx (see Solver.computeDt for the derivation). The staggered
   * forward–backward scheme is stable for Cr ≤ 1 without smoothing, and for Cr ≤ √θ with de Almeida
   * θ-smoothing (the smoothing damps the checkerboard mode but also shortens its stability interval).
   * θ = 0.8 → limit 0.894; we stop at 0.85.
   */
  robustCflMax: number;
  /** Timestep clamp, s. */
  dtMin: number;
  dtMax: number;
  /** Target interval between asynchronous readbacks (snapshots / stats), ms. */
  readbackIntervalMs: number;
  /**
   * GPU time budget for the solver per rendered frame, ms. The solver measures its own GPU cost per substep
   * and caps substeps so the UI stays interactive (in addition to SimParams.maxSubstepsPerFrame).
   */
  gpuBudgetMs: number;
  /** Multiplicative + additive safety margins applied to the lagged (stale) readback maxima for CFL. */
  cflDepthMargin: number;
  cflSpeedMargin: number;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  theta: 0.8,
  smoothingDepthRatio: 4,
  advection: true,
  hMin: 1e-4,
  uMax: 15,
  froudeMax: 8,
  boundaryMinSlope: 0.001,
  boundaryFroudeMax: 1,
  stageRelaxSeconds: 10,
  robustCflMax: 0.85,
  dtMin: 0.001,
  dtMax: 5,
  readbackIntervalMs: 300,
  gpuBudgetMs: 10,
  cflDepthMargin: 1.15,
  cflSpeedMargin: 1.25,
};

/** Depth thresholds used by statistics (contract definitions). */
export const WET_DEPTH = 0.01;
export const FLOODED_DEPTH = 0.3;
/** Below this cell depth the exported velocity is zero (avoids q/h blow-up on films). */
export const VELOCITY_DEPTH = 1e-3;

/** Hard limits of the uniform arrays in the shaders. */
export const MAX_SOURCES = 16;
export const MAX_STORMS = 8;

/** mm/hr → m/s */
export const MMHR_TO_MS = 1 / 3.6e6;

/** Minimum effective footprint radius (cells) for sources / brushes so a footprint always covers a cell center. */
export const MIN_FOOTPRINT_RADIUS = 0.75;
