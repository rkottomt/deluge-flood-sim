/**
 * Deluge GPU shallow-water solver — module entry point.
 * See Solver.ts for the pipeline overview and shaders/*.ts for the numerics.
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
 * contract; its concrete type also exposes a few extras (runSubsteps, readbackNow, computeDt, ...).
 * `options` (not part of the contract) overrides numerical tunables — defaults are tuned for the app.
 */
export function createSolver(
  device: GPUDevice,
  terrain: SolverTerrainInput,
  params?: Partial<SimParams>,
  options?: Partial<SolverOptions>,
): Promise<GpuFloodSolver> {
  return GpuFloodSolver.create(device, terrain, params, options);
}
