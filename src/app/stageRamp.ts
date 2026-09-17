/**
 * The river stage follows the slider in SIMULATED time, at a limited rate.
 *
 * Applying a new stage at once is a dam break: at Pittsburgh's 1936 crest (+9.1 m) every bank overtops at the same
 * instant, bores run over the floodplain at the solver's 15 m/s velocity cap, and the HUD reads 8–15 m/s for
 * minutes, which looks like an instability. A real crest rises over hours. Here the applied offset moves toward the
 * slider's target with a bounded rate and acceleration (a smooth, time-optimal approach that never overshoots and
 * stays smooth when the target moves on mid-rise, e.g. while the slider is dragged up). At the default 3 m per
 * sim-minute the 1936 crest takes ~3.7 sim-minutes (a few seconds at 60×). Measured on the GPU solver: peak flood
 * speed 6.1 m/s instead of the 15 m/s cap, the same flooded area once the crest has arrived (4.3 km² vs 4.2 km²
 * at 4 min), and no extra substeps.
 *
 * This is a TIME-LAPSE: in March 1936 the Point rose ~21 ft over ~30 hours (~0.7 ft/h); here it
 * rises ~10 ft per simulated minute, roughly 600–850× faster. The HUD's 4–6 m/s peak speeds do not come from
 * that speed-up: they come from water spilling over the banks into low basins. At half this rate the peaks were
 * the same (5.4–6.0 m/s for ~10 sim-minutes), then ~1–1.5 m/s once the low areas had filled, and the crest took
 * twice as long to arrive. So the rate stays.
 *
 * When the slider is moved back past the applied stage, the ramp stops at once and heads the other way (no
 * coasting): otherwise the river would keep rising for a while under a "Falling to …" readout. The solver only
 * sees 5 cm steps of the stage, so the sudden stop does not show.
 *
 * Pure state machine (no store, no solver): App advances it with the simulated seconds of each frame.
 */

/** Largest rise/fall rate, m per simulated second (3 m per sim-minute). */
export const STAGE_RATE_MAX = 3 / 60;
/** Simulated seconds to reach the full rate from rest (and to stop from it). */
export const STAGE_RAMP_ACCEL_SECONDS = 40;
/** Offsets closer than this count as arrived, m. */
const ARRIVE_EPS = 1e-4;
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

  /**
   * New slider target. Further along the current direction, the applied offset keeps its rate and heads there; on
   * the other side of the applied offset (the slider moved back past it), it stops at once and turns around.
   */
  setTarget(target: number): void {
    if (!Number.isFinite(target)) return;
    this.goal = target;
    if (this.v !== 0 && Math.sign(this.v) !== Math.sign(target - this.x)) this.v = 0;
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
      // Never moving away from the target (setTarget stops a reversal; this also covers any rounding).
      if (this.v !== 0 && Math.sign(this.v) !== dir) this.v = 0;
      const dv = vStop - this.v;
      const step = this.accel * dt;
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
