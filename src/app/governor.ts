import type { StepInfo } from '../contracts';

/**
 * Adaptive solver work budget driven by what the user feels: FRAME TIME and GPU LATENCY.
 *
 * The solver advances `realDt × timeScale` sim seconds per frame in CFL-limited substeps; every substep is
 * GPU work that competes with rendering. On a fanless laptop the GPU also slows down as it heats up, so a
 * fixed substep count that is smooth at minute 1 stutters at minute 10. A governor owns a substep cap (fed
 * to the solver as `maxSubstepsPerFrame`) and steers it with an AIMD controller, like TCP congestion control:
 *
 *   • over target → multiplicative decrease (cap × 0.7); that cap is remembered as a ceiling and probed
 *     again only after a backoff (1 s, 2 s, 4 s … 8 s), so the cap settles instead of sawtoothing;
 *   • under target AND this cap is what limits the sim → additive increase.
 *
 * Two signals, because each is blind to one failure: requestAnimationFrame keeps firing at ~60 Hz while the
 * GPU queue silently backs up (measured on the M4 at 1024²: render-only frames are acknowledged by the GPU
 * after ~13 ms, with 4 substeps after ~51 ms, with 8 after ~72 ms — 3–4 frames of input lag at "57 fps"), and
 * GPU latency alone can't see main-thread stalls. Frame time per window is a trimmed mean (one hitch per
 * window is ignored); latency is the window median of submit → onSubmittedWorkDone. The first frames after
 * a (re)start are ignored (shader compilation, tab switches).
 */
export interface GovernorConfig {
  /** Frame-time target, ms. */
  targetMs: number;
  /** GPU latency target (render submit → queue done), ms. */
  latencyMs: number;
  /** Dead band around the target (fraction): decrease above target·(1+band), increase below target·(1−band). */
  band: number;
  minCap: number;
  initialCap: number;
  /** Evaluation window: at least this long and this many frames. */
  windowMs: number;
  windowFrames: number;
  /** Frames ignored after start/resume/scene change. */
  warmupFrames: number;
}

const BASE_CONFIG: Omit<GovernorConfig, 'targetMs' | 'latencyMs' | 'initialCap'> = {
  band: 0.05,
  minCap: 1,
  windowMs: 300,
  windowFrames: 10,
  warmupFrames: 8,
};

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 8000;
/** After this long without a decrease the backoff and ceiling are forgotten (conditions may have changed). */
const CALM_RESET_MS = 15000;

export class SubstepGovernor {
  /** Current substep cap (integer ≥ minCap). */
  cap: number;

  private window: number[] = [];
  private latencies: number[] = [];
  private windowStart = -Infinity;
  private frames = 0;
  /** Cap at which the last decrease happened (probing at/above it waits for the backoff). */
  private ceiling = Infinity;
  private holdUntil = -Infinity;
  private backoffMs = MIN_BACKOFF_MS;
  private lastDecrease = -Infinity;
  /** After a decrease the GPU queue needs a moment to drain; windows until then are not judged. */
  private settleUntil = -Infinity;
  private throttledInWindow = false;
  /**
   * Externally imposed frame interval (ms, 0 = none; see frameCeiling.ts). Under a 30 Hz browser cap a 33 ms
   * frame is on target, not overloaded, so the frame-time target is raised to just above it.
   */
  floorMs = 0;

  constructor(readonly config: GovernorConfig) {
    this.cap = config.initialCap;
  }

  /** Forget measurements (scene change, resume after pause/hidden, mode switch). Keeps the learned cap. */
  restart(): void {
    this.frames = 0;
    this.window = [];
    this.latencies = [];
    this.windowStart = -Infinity;
    this.throttledInWindow = false;
  }

  /** A GPU latency sample (ms from a frame's submit until the queue finished it). */
  noteLatency(ms: number): void {
    if (ms >= 0 && ms < 2000 && this.frames > this.config.warmupFrames) this.latencies.push(ms);
  }

  /**
   * Observe one frame in which the solver was stepped. `frameMs` is the interval since the previous frame,
   * `maxCap` the user's maxSubstepsPerFrame. Returns true if the cap changed.
   */
  observe(frameMs: number, info: StepInfo, now: number, maxCap: number): boolean {
    const c = this.config;
    const upper = Math.max(c.minCap, Math.floor(maxCap));
    if (this.cap > upper) {
      this.cap = upper;
      return true;
    }
    if (!(frameMs > 0) || frameMs > 1000) return false;
    if (++this.frames <= c.warmupFrames) return false;

    if (this.window.length === 0) this.windowStart = now;
    this.window.push(frameMs);
    // Only a throttle at OUR cap counts: if something else limits the solver (its own GPU budget, a backed-up
    // queue) raising the cap would do nothing now and cause a burst later.
    if (info.throttled && info.substeps >= this.cap) this.throttledInWindow = true;
    if (this.window.length < c.windowFrames || now - this.windowStart < c.windowMs) return false;

    const frameTime = trimmedMean(this.window);
    // Without enough latency samples (no WebGPU queue callback yet) judge by frame time alone.
    const latency = this.latencies.length >= 3 ? median(this.latencies) : 0;
    const throttled = this.throttledInWindow;
    this.window = [];
    this.latencies = [];
    this.throttledInWindow = false;

    if (now - this.lastDecrease > CALM_RESET_MS) {
      this.ceiling = Infinity;
      this.backoffMs = MIN_BACKOFF_MS;
    }
    const before = this.cap;
    if (now < this.settleUntil) return false;
    const targetMs = Math.max(c.targetMs, this.floorMs * 1.1);
    const over = frameTime > targetMs * (1 + c.band) || latency > c.latencyMs * (1 + c.band);
    const under = frameTime < targetMs * (1 - c.band) && latency < c.latencyMs * (1 - c.band);
    if (over && this.cap > c.minCap) {
      this.ceiling = this.cap;
      this.cap = Math.max(c.minCap, Math.floor(this.cap * 0.7));
      this.holdUntil = now + this.backoffMs;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
      this.lastDecrease = now;
      this.settleUntil = now + 2 * c.windowMs;
    } else if (!over && under && throttled && this.cap < upper) {
      let next = Math.min(upper, this.cap + Math.max(1, Math.round(this.cap * 0.1)));
      if (next >= this.ceiling && now < this.holdUntil) next = Math.max(this.cap, this.ceiling - 1);
      this.cap = next;
    }
    return this.cap !== before;
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Mean without the single largest sample (robust to one hitch per window). */
function trimmedMean(xs: number[]): number {
  if (xs.length < 3) return xs.reduce((a, b) => a + b, 0) / xs.length;
  let sum = 0;
  let max = -Infinity;
  for (const x of xs) {
    sum += x;
    if (x > max) max = x;
  }
  return (sum - max) / (xs.length - 1);
}

/**
 * What the frame is for, which decides how much GPU backlog is acceptable:
 *   interactive — the user is touching something (camera, tools, sliders): ~no queued frames (low input lag);
 *   watching    — hands off, the flood is the show: input lag is invisible, so the GPU queue may run a few
 *                 frames deep for more sim per frame (measured uncontended on the M4 at 1024²: 4 substeps →
 *                 57 fps, ~51 ms latency, 47 sim-s/s vs 1 substep → 60 fps, ~14 ms, 13 sim-s/s);
 *   automation  — runFor() fast-forwarding: a little deeper still.
 *
 * No mode trades FRAME RATE for sim speed: the renderer runs its own adaptive-resolution controller on frame
 * intervals (it lowers resolution above ~20.8 ms), so a sim that slows frames would blur the picture, and a
 * saturated queue makes the solver's in-flight guard skip whole frames. Picture quality and responsiveness
 * outrank sim speed; the HUD reports the achieved speed honestly ("GPU-limited").
 */
export type BudgetMode = 'interactive' | 'watching' | 'automation';

export const BUDGET_TARGETS: Record<BudgetMode, { frameMs: number; latencyMs: number }> = {
  interactive: { frameMs: 18.5, latencyMs: 28 },
  watching: { frameMs: 19.5, latencyMs: 60 },
  automation: { frameMs: 19.5, latencyMs: 80 },
};

/**
 * One learned cap per mode, so switching (e.g. grabbing the camera while the flood runs) applies that mode's
 * cap immediately instead of waiting for the controller to re-converge.
 */
export class WorkBudget {
  mode: BudgetMode = 'watching';
  private readonly governors: Record<BudgetMode, SubstepGovernor>;

  constructor(targets: Record<BudgetMode, { frameMs: number; latencyMs: number }> = BUDGET_TARGETS) {
    const make = (mode: BudgetMode, initialCap: number) =>
      new SubstepGovernor({ ...BASE_CONFIG, targetMs: targets[mode].frameMs, latencyMs: targets[mode].latencyMs, initialCap });
    this.governors = {
      interactive: make('interactive', 2),
      watching: make('watching', 4),
      automation: make('automation', 8),
    };
  }

  get cap(): number {
    return this.governors[this.mode].cap;
  }

  capFor(mode: BudgetMode): number {
    return this.governors[mode].cap;
  }

  /** Switch mode; returns true if the effective cap changed. */
  setMode(mode: BudgetMode): boolean {
    if (mode === this.mode) return false;
    const before = this.cap;
    this.mode = mode;
    this.governors[mode].restart();
    return this.cap !== before;
  }

  restart(): void {
    for (const g of Object.values(this.governors)) g.restart();
  }

  /** Apply a learned external frame-rate ceiling (ms per frame, 0 = none) to every mode. */
  setFrameFloor(ms: number): void {
    for (const g of Object.values(this.governors)) {
      g.floorMs = ms;
      g.restart();
    }
  }

  get frameFloorMs(): number {
    return this.governors.watching.floorMs;
  }

  observe(frameMs: number, info: StepInfo, now: number, maxCap: number): boolean {
    return this.governors[this.mode].observe(frameMs, info, now, maxCap);
  }

  noteLatency(ms: number): void {
    this.governors[this.mode].noteLatency(ms);
  }
}
