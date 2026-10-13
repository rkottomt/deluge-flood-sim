/// <reference types="node" />
/**
 * A Dawn WebGPU device for the batch CLI — the same route the GPU tests take (tests/helpers/gpu.ts): the `webgpu` npm
 * package's GPU object and src/gpu.ts createDelugeDevice, so the CLI gets exactly the app's limits and features.
 *
 * The GPU instance must stay referenced for the life of the process (a collected Dawn instance tears itself down and
 * the next async callback crashes), hence the module-level handle.
 */
import { createDelugeDevice, type DelugeGPU } from '../gpu';

let instance: GPU | null = null;
let pending: Promise<DelugeGPU> | null = null;

/** Thrown when no WebGPU adapter exists (exit code 3). */
export class NoGpuError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoGpuError';
  }
}

/** Uncaptured WebGPU errors seen so far (a validation error is a bug: the CLI reports it and fails). */
export const gpuErrors: string[] = [];

export function getGpu(): Promise<DelugeGPU> {
  pending ??= (async () => {
    let webgpu: typeof import('webgpu');
    try {
      webgpu = await import('webgpu');
    } catch (err) {
      throw new NoGpuError(`the 'webgpu' package (Dawn for Node) could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
    }
    Object.assign(globalThis, webgpu.globals);
    instance = webgpu.create([]);
    let gpu: DelugeGPU;
    try {
      gpu = await createDelugeDevice(instance);
    } catch (err) {
      throw new NoGpuError(err instanceof Error ? err.message : String(err));
    }
    gpu.device.onuncapturederror = (ev) => {
      const msg = (ev as GPUUncapturedErrorEvent).error?.message ?? String(ev);
      gpuErrors.push(msg);
    };
    return gpu;
  })();
  return pending;
}

/** Let queued GPU work finish (call before exiting). */
export async function finishGpu(): Promise<void> {
  if (!pending) return;
  try {
    const { device } = await pending;
    await device.queue.onSubmittedWorkDone();
  } catch {
    /* no device: nothing queued */
  }
  void instance;
}
