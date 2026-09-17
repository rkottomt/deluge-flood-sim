/**
 * Detects a frame-rate ceiling imposed from OUTSIDE the app.
 *
 * Browsers pace requestAnimationFrame below the display refresh in some situations that matter for a laptop
 * demo: Chrome's Energy Saver (on battery, by default when the battery is low) and macOS Low Power Mode cap
 * pages at 30 fps. Both frame-time controllers — the substep governor and the renderer's adaptive resolution —
 * target ~60 fps and read a 33 ms frame as "overloaded", so without this they cut the solver to one substep and
 * the picture to the lowest quality step while the GPU sits mostly idle.
 *
 * rAF intervals alone can't tell "the browser caps us at 30 Hz" from "our work makes every frame miss a 60 Hz
 * vsync". Our own work can: a ceiling is learned only when (nearly) every frame in a window was slow while the
 * frame's own work — main-thread time and GPU queue latency — filled under half of the interval. It is kept
 * (hysteresis: once the controllers add work to use the headroom, work is no longer small) until frames clearly
 * faster than it appear, i.e. the cap was lifted (charger plugged in, Energy Saver off).
 */
export class FrameCeiling {
  /** Learned externally imposed minimum frame interval, ms. 0 = none (frames are paced by our own work/display). */
  floorMs = 0;

  private intervals: number[] = [];
  private busy: number[] = [];

  constructor(
    private readonly opts = {
      /** Frames per evaluation window (~1.5 s at 30 Hz). */
      windowFrames: 45,
      /** 10th-percentile interval above which frames count as uniformly slow (well above a 60 Hz vsync). */
      slowMs: 24,
      /** Work must fill less than this fraction of the median interval for the pacing to be external. */
      maxBusyFraction: 0.5,
      /** A window whose 10th-percentile interval is below floor × this lifts the ceiling. */
      liftFraction: 0.8,
    },
  ) {}

  /**
   * One frame: `intervalMs` since the previous frame, `busyMs` the frame's own work (max of main-thread time
   * and the latest GPU latency). Returns true when `floorMs` changed.
   */
  sample(intervalMs: number, busyMs: number): boolean {
    if (!(intervalMs > 0) || intervalMs > 250 || !(busyMs >= 0)) return false;
    this.intervals.push(intervalMs);
    this.busy.push(busyMs);
    if (this.intervals.length < this.opts.windowFrames) return false;

    const sorted = [...this.intervals].sort((a, b) => a - b);
    const p10 = sorted[Math.floor(sorted.length * 0.1)];
    const med = sorted[sorted.length >> 1];
    const busyMed = [...this.busy].sort((a, b) => a - b)[this.busy.length >> 1];
    this.intervals = [];
    this.busy = [];

    const before = this.floorMs;
    const externallyPaced = p10 > this.opts.slowMs && busyMed < this.opts.maxBusyFraction * med;
    if (this.floorMs > 0 && p10 < this.floorMs * this.opts.liftFraction) {
      this.floorMs = 0; // faster frames than the ceiling allowed: it was lifted
    } else if (externallyPaced && (this.floorMs === 0 || p10 > this.floorMs * 1.25)) {
      this.floorMs = p10; // new ceiling, or a tighter one (e.g. 30 → 20 Hz)
    }
    return this.floorMs !== before;
  }

  reset(): void {
    this.floorMs = 0;
    this.intervals = [];
    this.busy = [];
  }
}
