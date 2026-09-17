/// <reference types="node" />
/**
 * Load-robust timing for the routing performance checks.
 *
 * The router is synchronous and single-threaded, so the work it does is the main thread's CPU time. On a
 * busy machine (parallel test files, GPU tests, other processes) wall-clock time also includes time spent
 * descheduled; a 4 ms route that is preempted once reads as 15 ms. So every call is timed both ways:
 *
 *   • wall — performance.now(), printed so the real latency stays visible in the log;
 *   • cpu  — this thread's user + system CPU time (process.threadCpuUsage), what the assertions use.
 *
 * Load can still inflate CPU time a little (efficiency-core scheduling, cache contention), and noise only
 * ever adds time. So a workload is run in several interleaved passes and each item keeps its minimum over
 * the passes — a genuine regression slows every pass; a burst of load does not hit every pass of one item.
 */

export interface Timings {
  /** Per item: minimum wall-clock ms over the passes. */
  wall: number[];
  /** Per item: minimum main-thread CPU ms over the passes. */
  cpu: number[];
  /** Every call's wall-clock ms, unfiltered (for the log). */
  raw: number[];
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

/** Run `fn` on every item for `passes` interleaved passes; per-item minimum wall and CPU time. */
export function bestOfPasses<T>(items: readonly T[], passes: number, fn: (item: T, index: number) => void): Timings {
  const wall = items.map(() => Infinity);
  const cpu = items.map(() => Infinity);
  const raw: number[] = [];
  for (let p = 0; p < passes; p++) {
    for (let k = 0; k < items.length; k++) {
      const t = timeCall(() => fn(items[k], k));
      raw.push(t.wall);
      if (t.wall < wall[k]) wall[k] = t.wall;
      if (t.cpu < cpu[k]) cpu[k] = t.cpu;
    }
  }
  return { wall, cpu, raw };
}

/** q-quantile (0…1, nearest rank) of a list. */
export function quantile(xs: readonly number[], q: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

export const median = (xs: readonly number[]): number => quantile(xs, 0.5);

/**
 * One log line: unfiltered wall-clock latency, then the per-item best-of-passes wall and CPU figures the
 * assertions are based on — "median 0.94 / p95 3.81 / max 4.71 ms · best of 3: wall 0.93 / 3.79 / 4.60, cpu …".
 */
export function summarize(t: Timings, passes: number): string {
  const f = (xs: readonly number[]) =>
    xs.length === 1 ? xs[0].toFixed(2) : `${median(xs).toFixed(2)} / ${quantile(xs, 0.95).toFixed(2)} / ${Math.max(...xs).toFixed(2)}`;
  const stats = t.wall.length === 1 ? '' : 'median / p95 / max ';
  return `${stats}${f(t.raw)} ms · best of ${passes}${t.wall.length === 1 ? '' : ' per item'}: wall ${f(t.wall)}, cpu ${f(t.cpu)}`;
}
