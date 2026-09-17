/**
 * Deluge GPU shallow-water solver — module entry point.
 *
 * Numerics: shaders/momentum.ts (face discharges), shaders/continuity.ts (limiter + depth update + forcing),
 * pipeline + timestep + readback: Solver.ts, adaptive GPU budget: budget.ts, CPU cross-check: cpuReference.ts.
 *
 * Beyond the FloodSolver contract, the concrete GpuFloodSolver exposes (all optional for callers):
 *   solver.gpuBudgetMs          GPU compute ms per frame the solver may use (default 8; Infinity = off, e.g. when
 *                               the host paces the solver itself)
 *   solver.gpuMsPerSubstep      measured GPU cost of one substep (timestamp queries when available)
 *   solver.readbackDiagnostics  { nonFiniteCells, minDepth, processMs } of the latest readback
 *   solver.time                 simulated time of the work submitted so far (snapshots lag slightly)
 *   solver.computeDt()          the timestep the next substep would use
 *   solver.runSubsteps(n, dt?)  run exactly n substeps (tests/benchmarks; bypasses timeScale and budget)
 *   solver.readbackNow()        force a readback and await the snapshot (tests/automation)
 *   solver.options              numerical tunables (see SolverOptions / DEFAULT_SOLVER_OPTIONS)
 */
import type { SimParams, SolverTerrainInput } from '../contracts';
import type { SolverOptions } from './constants';
import { GpuFloodSolver } from './Solver';

export { GpuFloodSolver } from './Solver';
export type { ReadbackDiagnostics } from './Solver';
export { DEFAULT_SOLVER_OPTIONS } from './constants';
export type { SolverOptions } from './constants';
export { CpuReferenceSolver } from './cpuReference';

/**
 * Create the solver on `device` for the given terrain. The returned object implements the FloodSolver
 * contract; its concrete type also exposes the extras listed above. `options` (not part of the contract)
 * overrides numerical tunables — the defaults are tuned for the app.
 */
export function createSolver(
  device: GPUDevice,
  terrain: SolverTerrainInput,
  params?: Partial<SimParams>,
  options?: Partial<SolverOptions>,
): Promise<GpuFloodSolver> {
  return GpuFloodSolver.create(device, terrain, params, options);
}
