/**
 * The river stage follows the slider in SIMULATED time, at a limited rate.
 *
 * Applying a new stage at once is a dam break: at Pittsburgh's 1936 crest (+9.1 m) every bank overtops at the same
 * instant, bores run over the floodplain at the solver's 15 m/s velocity cap, and the HUD reads 8–15 m/s for
 * minutes, which looks like an instability. A real crest rises over hours. Here the applied offset moves toward the
 * slider's target with a bounded rate and acceleration (a smooth, time-optimal approach that never overshoots and
 * stays smooth when the target changes mid-rise, e.g. while the slider is dragged). At the default 3 m per
 * sim-minute the 1936 crest takes ~3.7 sim-minutes (a few seconds at 60×). Measured on the GPU solver: peak flood
 * speed 6.1 m/s instead of the 15 m/s cap, the same flooded area once the crest has arrived (4.3 km² vs 4.2 km²
 * at 4 min), and no extra substeps.
 *
 * Pure state machine (no store, no solver): App advances it with the simulated seconds of each frame.
 */

/** Largest rise/fall rate, m per simulated second (3 m per sim-minute). */
export const STAGE_RATE_MAX = 3 / 60;
/** Simulated seconds to reach the full rate from rest (and to stop from it). */
export const STAGE_RAMP_ACCEL_SECONDS = 40;
/** Offsets closer than this count as arrived, m. */
const ARRIVE_EPS = 1e-4;
/** Deceleration multiplier while the rate still points away from the target. */
const REVERSE_BRAKE = 3;
/** Integration chunk for large frames (automation runs advance tens of sim-seconds per frame), s. */
const MAX_CHUNK = 1;

export class StageRamp {
  /** Offset currently applied in the simulation, m. */
  private x = 0;
  /** Current rate, m per simulated second (signed). */
  private v = 0;
  private goal = 0;

  constructor(
    private readonly rateMax = STAGE_RATE_MAX,
    private readonly accel = STAGE_RATE_MAX / STAGE_RAMP_ACCEL_SECONDS,
  ) {}

  get applied(): number {
    return this.x;
  }

  get target(): number {
    return this.goal;
  }

  /** True while the applied offset has not reached the target. */
  get moving(): boolean {
    return this.x !== this.goal;
  }

  /** New slider target; the applied offset keeps its current rate and heads there. */
  setTarget(target: number): void {
    if (Number.isFinite(target)) this.goal = target;
  }

  /** Apply `offset` at once (scene load, automation that asks for it). */
  jump(offset: number): void {
    if (!Number.isFinite(offset)) return;
    this.x = this.goal = offset;
    this.v = 0;
  }

  /** Restart from `offset` at rest, keeping the target (water reset: the river rises to the stage again). */
  restartFrom(offset: number): void {
    if (!Number.isFinite(offset)) return;
    this.x = offset;
    this.v = 0;
  }

  /**
   * Advance by `simSeconds`. Returns true if the applied offset changed. Bang-bang with limits: accelerate toward
   * the target up to rateMax, and brake so the rate reaches zero exactly at the target (v² = 2·a·distance).
   */
  advance(simSeconds: number): boolean {
    if (!(simSeconds > 0) || this.x === this.goal) return false;
    const before = this.x;
    let left = simSeconds;
    while (left > 0 && this.x !== this.goal) {
      const dt = Math.min(MAX_CHUNK, left);
      left -= dt;
      const d = this.goal - this.x;
      if (Math.abs(d) <= ARRIVE_EPS) {
        this.x = this.goal;
        this.v = 0;
        break;
      }
      const dir = Math.sign(d);
      const vStop = dir * Math.min(this.rateMax, Math.sqrt(2 * this.accel * Math.abs(d)));
      const dv = vStop - this.v;
      // Still moving away from a target that just changed sides (slider moved back): brake harder, so the river
      // does not keep rising a metre after the user lowered it.
      const reversing = this.v !== 0 && Math.sign(this.v) !== dir;
      const step = (reversing ? REVERSE_BRAKE : 1) * this.accel * dt;
      const v1 = Math.abs(dv) <= step ? vStop : this.v + Math.sign(dv) * step;
      const move = 0.5 * (this.v + v1) * dt;
      this.v = v1;
      // Never pass the target (the braking curve is exact only in the limit of small chunks).
      if (Math.sign(move) === dir && Math.abs(move) >= Math.abs(d)) {
        this.x = this.goal;
        this.v = 0;
        break;
      }
      this.x += move;
      // A crawl too slow to arrive (rounding at the very end): snap.
      if (Math.abs(this.goal - this.x) <= ARRIVE_EPS && Math.abs(this.v) <= this.accel * MAX_CHUNK) {
        this.x = this.goal;
        this.v = 0;
      }
    }
    return this.x !== before;
  }
}
