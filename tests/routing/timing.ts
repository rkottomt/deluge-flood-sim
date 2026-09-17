/// <reference types="node" />
/**
 * Load-robust timing for the routing performance checks.
 *
 * The spec targets (DESIGN.md §6) are for the demo machine, an Apple M4, but the tests run on a shared machine:
 * parallel test files, GPU tests, other processes. Three kinds of noise, three counter-measures:
 *
 *  1. Preemption. The router is synchronous and single-threaded, so its work is the main thread's CPU time
 *     (process.threadCpuUsage); time spent descheduled is not. Wall-clock time is still printed.
 *  2. Bursts. Noise only ever adds time, so a workload runs in several interleaved passes and each item keeps its
 *     minimum over them: a genuine regression slows every pass, a burst of load does not.
 *  3. A slower core. Under load the thread may be put on an efficiency core or a throttled one — CPU time itself
 *     grows (this machine, shared, ran the same fixed code 2–4× slower for seconds at a time). So a small
 *     reference kernel (code the router cannot change) is timed between chunks of the workload, and each
 *     measurement is divided by the kernel's slowdown around it against its time on a full-speed M4 performance
 *     core. The slowdown is never taken below 1 (a faster machine keeps the spec bounds as they are) and is
 *     capped, so a far-too-slow machine still fails.
 *
 * Assertions use `norm`: per-item best-of-passes CPU ms, rescaled to the reference core.
 */

export interface Timings {
  /** Per item: minimum wall-clock ms over the passes. */
  wall: number[];
  /** Per item: minimum main-thread CPU ms over the passes. */
  cpu: number[];
  /** Per item: minimum over the passes of CPU ms ÷ the machine slowdown measured around it (see above). */
  norm: number[];
  /** Every call's wall-clock ms, unfiltered (for the log). */
  raw: number[];
  /** Largest slowdown applied (1 = reference speed). */
  maxSlowdown: number;
}

const threadCpu: () => NodeJS.CpuUsage =
  typeof process.threadCpuUsage === 'function' ? () => process.threadCpuUsage() : () => process.cpuUsage();

/** Wall-clock and main-thread CPU milliseconds of one call. */
export function timeCall(fn: () => void): { wall: number; cpu: number } {
  const c0 = threadCpu();
  const t0 = performance.now();
  fn();
  const wall = performance.now() - t0;
  const c1 = threadCpu();
  return { wall, cpu: (c1.user - c0.user + (c1.system - c0.system)) / 1000 };
}

// ─── reference kernel ────────────────────────────────────────────────────────────────────────────

/**
 * Best main-thread CPU ms of referenceKernel() on an Apple M4 performance core at full speed: the minimum over
 * repeated measureReferenceKernel() runs. Re-measure if the kernel changes.
 */
const REFERENCE_KERNEL_MS = 0.4;
/** Slowdowns beyond this are not compensated: the machine is too busy (or too slow) for a meaningful check. */
const MAX_SLOWDOWN = 3;
/** Workload CPU ms between kernel measurements. */
const CHUNK_MS = 25;

const scratch = new Float64Array(2048);
let kernelWarm = false;

/**
 * Pure compute over an L1-sized table (≈0.4 ms): measures how fast the core this thread is on runs right now
 * (performance vs efficiency core, thermal throttling). Deliberately cache-light — a memory-heavy kernel reads
 * slower right after the workload has filled the caches, which would over-compensate. Memory contention is thus
 * not compensated, which can only make the checks stricter.
 */
function referenceKernel(): number {
  let x = 12345;
  let s = 0;
  for (let i = 0; i < 200_000; i++) {
    x = (Math.imul(x, 1103515245) + 12345) | 0;
    const k = (x >>> 21) & 2047;
    scratch[k] = scratch[k] * 0.5 + Math.sqrt(i);
    s += scratch[(k * 7) & 2047];
  }
  return s;
}

function warmKernel(): void {
  if (kernelWarm) return;
  for (let k = 0; k < 50; k++) referenceKernel();
  kernelWarm = true;
}

/** How much slower than the reference core this thread runs right now (best of two kernel runs; 1…MAX_SLOWDOWN). */
export function machineSlowdown(): number {
  warmKernel();
  const ms = Math.min(timeCall(referenceKernel).cpu, timeCall(referenceKernel).cpu);
  return Math.min(MAX_SLOWDOWN, Math.max(1, ms / REFERENCE_KERNEL_MS));
}

/** Best CPU ms of the kernel over `runs` warm runs (to recalibrate REFERENCE_KERNEL_MS on an idle machine). */
export function measureReferenceKernel(runs = 500): number {
  warmKernel();
  let best = Infinity;
  for (let k = 0; k < runs; k++) best = Math.min(best, timeCall(referenceKernel).cpu);
  return best;
}

// ─── workload timing ─────────────────────────────────────────────────────────────────────────────

/** Run `fn` on every item for `passes` interleaved passes; per-item best wall, CPU and normalized CPU time. */
export function bestOfPasses<T>(items: readonly T[], passes: number, fn: (item: T, index: number) => void): Timings {
  const wall = items.map(() => Infinity);
  const cpu = items.map(() => Infinity);
  const norm = items.map(() => Infinity);
  const raw: number[] = [];
  let maxSlowdown = 1;
  const pending: number[] = []; // [item, cpu ms] pairs awaiting the kernel measurement after their chunk
  let before = machineSlowdown();
  let chunkMs = 0;
  for (let p = 0; p < passes; p++) {
    for (let k = 0; k < items.length; k++) {
      const t = timeCall(() => fn(items[k], k));
      raw.push(t.wall);
      if (t.wall < wall[k]) wall[k] = t.wall;
      if (t.cpu < cpu[k]) cpu[k] = t.cpu;
      pending.push(k, t.cpu);
      chunkMs += t.cpu;
      if (chunkMs < CHUNK_MS && k < items.length - 1) continue;
      // The machine state around the chunk: the smaller slowdown of the two sides (never over-compensates
      // when load changes mid-chunk).
      const after = machineSlowdown();
      const slowdown = Math.min(before, after);
      if (slowdown > maxSlowdown) maxSlowdown = slowdown;
      for (let q = 0; q < pending.length; q += 2) {
        const v = pending[q + 1] / slowdown;
        if (v < norm[pending[q]]) norm[pending[q]] = v;
      }
      pending.length = 0;
      chunkMs = 0;
      before = after;
    }
  }
  return { wall, cpu, norm, raw, maxSlowdown };
}

/** q-quantile (0…1, nearest rank) of a list. */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

/**
 * One log line: unfiltered wall-clock latency, then per-item best-of-passes wall, CPU and normalized CPU
 * (median / p95 / max for lists) and the largest slowdown compensated.
 */
export function summarize(t: Timings, passes: number): string {
  const one = t.wall.length === 1;
  const f = (xs: readonly number[]) =>
    one ? xs[0].toFixed(2) : `${median(xs).toFixed(2)} / ${quantile(xs, 0.95).toFixed(2)} / ${Math.max(...xs).toFixed(2)}`;
  const raw = one ? `${median(t.raw).toFixed(2)} ms median of ${t.raw.length}` : `median / p95 / max ${f(t.raw)} ms`;
  return (
    `${raw} · best of ${passes}${one ? '' : ' per item'}: wall ${f(t.wall)}, cpu ${f(t.cpu)}, ` +
    `normalized ${f(t.norm)} (slowdown ≤ ${t.maxSlowdown.toFixed(2)}×)`
  );
}
