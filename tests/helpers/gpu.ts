/**
 * Node test helpers: a shared Dawn (Metal on macOS) WebGPU device and solver conveniences.
 *
 * Usage in a node:test file:
 *   import { after } from 'node:test';
 *   import { getDevice, finishGpuTests } from '../helpers/gpu';
 *   after(finishGpuTests);   // Dawn keeps the process alive; this exits once the tests are done.
 */
import { create, globals } from 'webgpu';
import { createDelugeDevice, type DelugeGPU } from '../../src/gpu';
import type { SimParams, SimSnapshot } from '../../src/contracts';
import { createSolver, type GpuFloodSolver, type SolverOptions } from '../../src/sim';

Object.assign(globalThis, globals);

let gpuPromise: Promise<DelugeGPU> | null = null;
/**
 * The Dawn GPU instance MUST stay referenced for the life of the process: if it is garbage-collected, Dawn
 * tears down its instance and the next async callback (mapAsync, onSubmittedWorkDone, ...) segfaults.
 */
let gpuInstance: GPU | null = null;
const errors: string[] = [];

/** Shared device for the whole test file (created on first use). Validation errors are collected. */
export function getGpu(): Promise<DelugeGPU> {
  if (!gpuPromise) {
    gpuPromise = (async () => {
      gpuInstance = create([]);
      const d = await createDelugeDevice(gpuInstance);
      d.device.onuncapturederror = (ev) => {
        const msg = (ev as GPUUncapturedErrorEvent).error?.message ?? String(ev);
        errors.push(msg);
        console.error('[webgpu]', msg);
      };
      return d;
    })();
  }
  return gpuPromise;
}

export async function getDevice(): Promise<GPUDevice> {
  return (await getGpu()).device;
}

/** Uncaptured WebGPU errors so far (tests assert this stays empty). */
export function gpuErrors(): readonly string[] {
  return errors;
}

/** Call from `after()`: gives pending callbacks a moment, then exits (Dawn would keep node alive). */
export async function finishGpuTests(): Promise<void> {
  setTimeout(() => process.exit(process.exitCode ?? 0), 50);
}

export interface TestSolverSetup {
  nx: number;
  ny: number;
  cellSize: number;
  elevation: Float32Array;
  depth?: Float32Array;
  params?: Partial<SimParams>;
  options?: Partial<SolverOptions>;
}

export async function makeSolver(s: TestSolverSetup): Promise<GpuFloodSolver> {
  const device = await getDevice();
  const solver = await createSolver(
    device,
    { nx: s.nx, ny: s.ny, cellSize: s.cellSize, elevation: s.elevation },
    s.params,
    s.options,
  );
  if (s.depth) solver.setInitialWater(s.depth);
  return solver;
}

/**
 * Advance exactly `n` substeps (fixed `dt`, or the solver's CFL dt re-evaluated every `chunk` substeps from
 * fresh readbacks) and return a fresh snapshot.
 */
export async function stepAndSnapshot(
  solver: GpuFloodSolver,
  n: number,
  opts: { dt?: number; chunk?: number } = {},
): Promise<SimSnapshot> {
  const chunk = Math.max(1, opts.chunk ?? (opts.dt === undefined ? 50 : n));
  let left = n;
  while (left > 0) {
    const k = Math.min(chunk, left);
    solver.runSubsteps(k, opts.dt);
    left -= k;
    if (opts.dt === undefined && left > 0) await solver.readbackNow(); // refresh CFL maxima
  }
  return solver.readbackNow();
}

/** Max |a − b| over two equally long arrays. */
export function maxAbsDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

export function sum(a: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s;
}
