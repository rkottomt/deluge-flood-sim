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
