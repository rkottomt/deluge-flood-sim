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
   * de Almeida (2012) θ-smoothing weight: q̃ = q_c + (1−θ)/2·L with L = (q_up − q_c) + (q_down − q_c), limited by
   * the divergence-damping increment (minmod, shaders/momentum.ts) so only divergent — gravity-wave — grid-scale
   * patterns are damped, not flow turning along a staircase bank. θ = 1 disables smoothing. 0.7–0.9 damps the
   * checkerboard oscillations the plain local-inertial scheme develops at low friction. It also lowers the 2-D
   * Courant stability limit from 1 to √θ (see robustCflMax and Solver.computeDt).
   */
  theta: number;
  /**
   * K in the smoothing neighbour weight w = min(1, K·hf/hf_neighbour): a neighbouring face contributes fully
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
  /**
   * Fraction of the (free-slip) advection kept on faces whose advection stencil touches a dry or blocked face — the
   * stair steps of every bank that is not aligned with the grid (see shaders/momentum.ts). 1 = full advection
   * everywhere: channels at 30° to the grid run ~20 % deeper than Manning's normal depth. 0 = none there: exact
   * normal depth, but nothing damps grid-scale circulations along banks (a rough-terrain lake at n = 0.01 spun up
   * 10 m/s jets). 0.1: within 7 % of normal depth at 0–60° (tests/sim/channel.test.ts), lakes stay calm.
   */
  wallAdvection: number;
  /** Face flow depth below which a face carries no flux (wetting/drying threshold), m. */
  hMin: number;
  /** Robust mode velocity cap, m/s. */
  uMax: number;
  /**
   * Robust mode Froude-number cap on interior faces: |q| ≤ hf·min(uMax, froudeMax·√(g·hf)). A safety net for thin
   * films, not physics — 8 rather than ~2 because a dam-break front is legitimately strongly supercritical
   * (the Ritter tip has Fr → ∞); with Fr ≤ 2 the dam-break front of tests/sim/dambreak.test.ts runs 22 % slow.
   */
  froudeMax: number;
  /**
   * Minimum slope S of the open (free outflow) boundary: outflow is at least normal flow q = h^{5/3}·√S/n with
   * S = max(local bed slope, boundaryMinSlope) (and at least what arrives at the edge's velocity; see bflux). Where terrain is flat at the edge — rivers, whose channels
   * are flat after hydro-conditioning — this IS the river's energy slope and it sets the discharge leaving
   * the domain. 1e-4 is typical of large rivers: a 6 m deep Ohio at Pittsburgh then carries ~2,000 m³/s at
   * ~1 m/s (real mean flow ≈ 900 m³/s) and ~11,000 m³/s at the 1936 stage (record ≈ 16,000 m³/s); 1e-3 would
   * drain ~7,000 m³/s at normal pool. Steep edges use their own (larger) local slope.
   */
  boundaryMinSlope: number;
  /** Robust mode Froude cap on open-boundary outflow; 1 = critical flow over a free edge (see bflux in shaders/common.ts). */
  boundaryFroudeMax: number;
  /**
   * Relaxation time constant for stage sources, s (0 = set the level directly; ARCHITECTURE.md §3.4).
   * Stage sources are boundary conditions (their discs cover a river's edge crossing, see edgeStageDisc in
   * src/data/hydro.ts): with relaxation the open boundary drains the footprint faster than it refills — at
   * Pittsburgh's 1936 crest τ = 10 s left the Point ~6 m below the stage after 105 sim-minutes.
   */
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
   * (timestamp queries) and caps substeps so the UI stays interactive (in addition to
   * SimParams.maxSubstepsPerFrame). Infinity = off: no measurement readbacks; for hosts that pace the solver
   * themselves (the Deluge app's governor, src/app/governor.ts).
   */
  gpuBudgetMs: number;
  /**
   * Rain on dry or shallow ground (robust-mode CFL; see Solver.computeDt). A dry live area reads back no water, so dt
   * sat at dtMax = 5 s and the first readbacks after the rain started showed Courant 4–19 (the local guard kept it
   * stable, the HUD showed it in red). While it rains, the CFL estimate assumes:
   *  • rainRunoffSpeed: waves at least this fast (m/s, at 100 mm/hr) until readbacks show faster ones. Sheet flow on
   *    steep rough ground reaches ~0.5–1.2 m/s within the first minute, before any readback can show it. Manning sheet
   *    flow speed grows as (rain rate)^0.4, so 300 mm/hr assumes 3.1 m/s and 10 mm/hr 0.8 m/s.
   *  • rainPondingFactor: the deepest water rising this many times faster than the rain falls for as long as the
   *    readback lags. Runoff collects in hollows: on rough 6 m terrain, 100 mm/hr for 6 minutes left 0.23–0.25 m in
   *    the deepest one (waves ≈ 2.2 m/s), 300 mm/hr 0.8 m (≈ 4 m/s) — ~50× the rain depth. At 1200× a readback window
   *    is ~6 sim-minutes, so this matters at high time scales.
   */
  rainRunoffSpeed: number;
  rainPondingFactor: number;
  /** Multiplicative + additive safety margins applied to the lagged (stale) readback maxima for CFL. */
  cflDepthMargin: number;
  cflSpeedMargin: number;
}

export const DEFAULT_SOLVER_OPTIONS: SolverOptions = {
  theta: 0.8,
  smoothingDepthRatio: 4,
  advection: true,
  wallAdvection: 0.1,
  hMin: 1e-4,
  uMax: 15,
  froudeMax: 8,
  boundaryMinSlope: 1e-4,
  boundaryFroudeMax: 1,
  stageRelaxSeconds: 0,
  robustCflMax: 0.85,
  dtMin: 0.001,
  dtMax: 5,
  readbackIntervalMs: 300,
  gpuBudgetMs: 8,
  rainRunoffSpeed: 2,
  rainPondingFactor: 50,
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

/**
 * Open-boundary outflow is switched off on domain-edge cells within (radius + this many cells) of an INFLOW source.
 * Inflows sit on a river just inside the edge it enters through; the mound the source builds spreads both ways, and
 * without the mask 20–58 % of a preset river's discharge left straight back out of that edge (Johnstown's Stonycreek
 * lost 963 of 1,671 m³/s). A radius + 8 mask still leaked through the edge cells just outside it; + 24 stops the
 * leak (see continuity.ts bfluxC). Only edge cells are affected, and only near inflows.
 */
export const INFLOW_EDGE_MASK_CELLS = 24;

/** Minimum effective footprint radius (cells) for sources / brushes so a footprint always covers a cell center. */
export const MIN_FOOTPRINT_RADIUS = 0.75;
