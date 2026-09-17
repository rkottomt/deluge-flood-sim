/**
 * Pure helpers for the statistics readouts: an honest achieved-speed estimate and a "the solution has
 * diverged" test for the stability demo.
 */
import type { SimStats } from '../contracts';

/**
 * Achieved simulation speed = simulated seconds advanced / wall-clock seconds, measured over a sliding window
 * of stats readbacks. Readbacks arrive a few times a second with some latency jitter, so a window of a few
 * seconds keeps the error to a few percent. The window restarts when the clock jumps back (water reset), when
 * samples stop arriving (paused, hidden tab) or when asked to (scene change, speed change).
 */
export class SpeedEstimator {
  private t: number[] = [];
  private sim: number[] = [];

  constructor(
    private readonly windowMs = 3000,
    private readonly minSpanMs = 900,
    private readonly maxGapMs = 1500,
  ) {}

  reset(): void {
    this.t.length = 0;
    this.sim.length = 0;
  }

  /** Record a new readback (call once per new stats object, with its arrival time in ms). */
  push(nowMs: number, simTime: number): void {
    if (!Number.isFinite(simTime) || !Number.isFinite(nowMs)) return;
    const n = this.t.length;
    if (n) {
      const lastT = this.t[n - 1];
      const lastSim = this.sim[n - 1];
      if (simTime < lastSim - 1e-6 || nowMs - lastT > this.maxGapMs) this.reset();
      else if (nowMs <= lastT) return;
    }
    this.t.push(nowMs);
    this.sim.push(simTime);
    // Keep the oldest sample that still spans the window so the estimate always covers ≥ windowMs.
    while (this.t.length > 2 && nowMs - this.t[1] >= this.windowMs) {
      this.t.shift();
      this.sim.shift();
    }
  }

  /** Sim seconds per real second over the window, or null until enough time has been observed. */
  value(): number | null {
    const n = this.t.length;
    if (n < 2) return null;
    const span = this.t[n - 1] - this.t[0];
    if (span < this.minSpanMs) return null;
    return ((this.sim[n - 1] - this.sim[0]) * 1000) / span;
  }
}

/**
 * What to show for the achieved speed: the requested speed when the measurement agrees with it within the
 * measurement noise (so the readout doesn't wobble between 57× and 62×), otherwise the measurement.
 */
export function displaySpeed(achieved: number | null, requested: number, tolerance = 0.08): number | null {
  if (achieved === null || !Number.isFinite(achieved)) return null;
  if (requested > 0 && Math.abs(achieved - requested) <= tolerance * requested) return requested;
  return achieved;
}

/** Physically impossible statistics: the numerical solution has blown up (only the stability demo gets here). */
export function isDiverged(stats: SimStats | null | undefined): boolean {
  if (!stats) return false;
  const { maxDepth, maxSpeed, volume, massError } = stats;
  if (![maxDepth, maxSpeed, volume].every(Number.isFinite)) return true;
  if (Number.isNaN(massError) || massError === Infinity) return true;
  return volume < 0 || maxDepth > 1e4 || maxSpeed > 1e3 || massError > 0.5;
}

/** Requested speeds from here up are fast-forward requests ("as fast as the GPU allows"): the quick actions, 300×, 1200×. */
export const FAST_FORWARD_SPEED = 300;
/** Below this achieved speed the GPU is really struggling, whatever was asked for. */
export const SLOW_SPEED_FLOOR = 20;

/**
 * How to present the achieved speed.
 *  • 'none'  — meeting the request (or nothing measured yet).
 *  • 'max'   — the GPU is flat out below the request, which is normal for fast-forward (a 1024² grid runs ~45–70× on an
 *              M4): shown neutrally, as the GPU's maximum.
 *  • 'short' — a real shortfall: below SLOW_SPEED_FLOOR, or under a quarter of a moderate speed the user picked.
 *              Shown as a warning.
 */
export function speedShortfall(throttled: boolean, achieved: number | null, requested: number): 'none' | 'max' | 'short' {
  if (!throttled || achieved === null || !Number.isFinite(achieved) || !(requested > 0)) return 'none';
  if (achieved >= 0.9 * requested) return 'none';
  if (achieved < SLOW_SPEED_FLOOR || (requested < FAST_FORWARD_SPEED && achieved < 0.25 * requested)) return 'short';
  return 'max';
}

/**
 * Rain fallen since the last water reset, mm: global rain integrated over simulated time from the stats readbacks
 * (storm cells are local and not counted). The rate between two readbacks is taken as the current one; rain rarely
 * changes between readbacks a fraction of a second apart.
 */
export class RainGauge {
  private lastSim = NaN;
  private total = 0;

  reset(): void {
    this.lastSim = NaN;
    this.total = 0;
  }

  /** Record a readback: simulated time (s) and the global rain rate (mm/hr) in effect. */
  push(simTime: number, rainRate: number): void {
    if (!Number.isFinite(simTime)) return;
    if (Number.isFinite(this.lastSim)) {
      const dt = simTime - this.lastSim;
      if (dt < -1e-6) this.total = 0; // water reset: the clock went back
      else if (rainRate > 0 && Number.isFinite(rainRate)) this.total += (rainRate * dt) / 3600;
    }
    this.lastSim = simTime;
  }

  get mm(): number {
    return this.total;
  }
}
