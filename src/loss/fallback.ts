/**
 * Depth-only stand-in for FloodSolver.readHazardFields, for a solver that does not have it: accumulates the
 * asynchronous depth snapshots (2–4 Hz) on the CPU into the same HazardFields shape.
 *
 * What it cannot know, and how that is reported:
 *  • speed — maxSpeed and maxDV are NaN, so hazard classes are depth-only and no building can be flagged as
 *    collapsed (callers print "velocity not recorded");
 *  • the true peak between snapshots — a snapshot every ~0.3 s of wall time is minutes of simulated time at high
 *    speed-ups, so a brief peak can be missed (max depth is a lower bound) and arrival times are rounded up to the
 *    next snapshot;
 *  • what happened before tracking started — cells already wet when tracking began are given that moment as their
 *    arrival (flagged by `startedAt` > 0), except the water that was there at reset (`baseline`), which is "normally
 *    wet" (firstWet = 0) as in the GPU accumulators.
 */
import type { HazardFields } from '../contracts';
import { REACHED_DEPTH } from './impact';

export class SnapshotHazardAccumulator {
  private nx = 0;
  private ny = 0;
  private maxDepth = new Float32Array(0);
  private firstWet = new Float32Array(0);
  private wetSeconds = new Float32Array(0);
  private lastTime = NaN;
  /** Simulated time of the first snapshot since the last (re)start; 0 when tracking began at reset. */
  startedAt = NaN;
  samples = 0;
  private baseline: Float32Array | null = null;

  /** Water present at reset (computeInitialWater): cells with ≥ REACHED_DEPTH there are "normally wet". */
  setBaseline(depth: Float32Array | null): void {
    this.baseline = depth;
  }

  reset(): void {
    this.samples = 0;
    this.lastTime = NaN;
    this.startedAt = NaN;
  }

  /** Feed one snapshot. A snapshot earlier than the last one means the water was reset: start over. */
  feed(depth: Float32Array, nx: number, ny: number, simTime: number): void {
    const n = nx * ny;
    if (depth.length < n) return;
    if (nx !== this.nx || ny !== this.ny) {
      this.nx = nx;
      this.ny = ny;
      this.maxDepth = new Float32Array(n);
      this.firstWet = new Float32Array(n);
      this.wetSeconds = new Float32Array(n);
      this.samples = 0;
    }
    if (this.samples > 0 && simTime < this.lastTime - 1e-6) this.samples = 0;
    if (this.samples > 0 && simTime === this.lastTime) return;
    const base = this.baseline && this.baseline.length >= n ? this.baseline : null;
    if (this.samples === 0) {
      this.startedAt = simTime;
      const fresh = simTime <= 1;
      for (let c = 0; c < n; c++) {
        const d = depth[c];
        this.maxDepth[c] = d;
        this.wetSeconds[c] = 0;
        const normal = base ? base[c] >= REACHED_DEPTH : fresh && d >= REACHED_DEPTH;
        this.firstWet[c] = normal ? 0 : d >= REACHED_DEPTH ? Math.max(simTime, 1e-3) : -1;
      }
    } else {
      const dt = simTime - this.lastTime;
      for (let c = 0; c < n; c++) {
        const d = depth[c];
        if (d > this.maxDepth[c]) this.maxDepth[c] = d;
        if (d >= REACHED_DEPTH) {
          if (this.firstWet[c] < 0) this.firstWet[c] = simTime;
          this.wetSeconds[c] += dt;
        }
      }
    }
    this.lastTime = simTime;
    this.samples++;
  }

  /** The accumulated fields (copies), or null before the first snapshot. */
  fields(): HazardFields | null {
    if (this.samples === 0) return null;
    const n = this.nx * this.ny;
    const nan = new Float32Array(n).fill(NaN);
    return {
      nx: this.nx,
      ny: this.ny,
      simTime: this.lastTime,
      maxDepth: this.maxDepth.slice(),
      maxSpeed: nan,
      maxDV: nan,
      firstWet: this.firstWet.slice(),
      wetSeconds: this.wetSeconds.slice(),
    };
  }
}
