import type { StepInfo } from '../contracts';

/**
 * Adaptive solver work budget driven by what the user feels: FRAME TIME and GPU LATENCY.
 *
 * The solver advances `realDt × timeScale` sim seconds per frame in CFL-limited substeps; every substep is
 * GPU work that competes with rendering. On a fanless laptop the GPU also slows down as it heats up, so a
 * fixed substep count that is smooth at minute 1 stutters at minute 10. A governor owns a substep cap (fed
 * to the solver as `maxSubstepsPerFrame`) and steers it with an AIMD controller, like TCP congestion control:
 *
 *   • over target → decrease (~10 % when slightly over, × 0.7 when clearly over); that cap is remembered as a
 *     ceiling and probed again only after a backoff (1 s, 2 s, 4 s … 8 s), so the cap settles instead of sawtoothing;
 *   • under target AND this cap is what limits the sim → additive increase (half substeps: see `cap`).
 *
 * Two signals, because each is blind to one failure: requestAnimationFrame keeps firing at ~60 Hz while the
 * GPU queue silently backs up (measured on the M4 at 1024²: render-only frames are acknowledged by the GPU
 * after ~13 ms, with 4 substeps after ~51 ms, with 8 after ~72 ms — 3–4 frames of input lag at "57 fps"), and
 * GPU latency alone can't see main-thread stalls. Frame time per window is a trimmed mean (one hitch per
 * window is ignored); latency is the median of submit → onSubmittedWorkDone over the last ~1 s. The first frames after
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
  /**
   * Current substep cap (≥ minCap, in steps of CAP_STEP): fractional caps are met on average by the solver (4.5 →
   * alternately 4 and 5), which matters because a saturated GPU queue has a latency cliff between whole numbers.
   */
  cap: number;

  private window: number[] = [];
  private latencies: number[] = [];
  /** Latency samples of the previous windows (median over ~1 s: per-frame latency is noisy, see observe). */
  private latencyHistory: number[][] = [];
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
    this.latencyHistory = [];
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
    if (info.throttled && info.substeps >= Math.floor(this.cap)) this.throttledInWindow = true;
    if (this.window.length < c.windowFrames || now - this.windowStart < c.windowMs) return false;

    const frameTime = trimmedMean(this.window);
    // Without enough latency samples (no WebGPU queue callback yet) judge by frame time alone.
    // Median over this and the previous LATENCY_WINDOWS − 1 windows: single frames differ by several ms (frames
    // that refresh the water textures or read back stats carry extra work), and a 300 ms median still flickered.
    this.latencyHistory.push(this.latencies);
    if (this.latencyHistory.length > LATENCY_WINDOWS) this.latencyHistory.shift();
    const recent = this.latencyHistory.flat();
    const latency = recent.length >= 3 ? median(recent) : 0;
    const throttled = this.throttledInWindow;
    this.window = [];
    this.latencies = [];
    this.throttledInWindow = false;

    if (now - this.lastDecrease > CALM_RESET_MS) {
      this.ceiling = Infinity;
      this.backoffMs = MIN_BACKOFF_MS;
    }
    const before = this.cap;
    if (now < this.settleUntil) {
      this.latencyHistory = [];
      return false;
    }
    const targetMs = Math.max(c.targetMs, this.floorMs * 1.1);
    // Under a frame-rate ceiling one frame of queued work is the ceiling's interval, not a 60 Hz vsync.
    const latencyMs = Math.max(c.latencyMs, this.floorMs * 1.05);
    const over = frameTime > targetMs * (1 + c.band) || latency > latencyMs * (1 + c.band);
    const under = frameTime < targetMs * (1 - c.band) && latency < latencyMs * (1 - c.band);
    if (over && this.cap > c.minCap) {
      this.ceiling = this.cap;
      // Graded: slightly over (GPU latency sampled per frame is noisy — readback and water-refresh frames carry
      // extra work) takes one substep off; clearly over (a missed-vsync frame rate, a long queue) cuts by 30 %.
      const severe = frameTime > targetMs * 1.2 || latency > latencyMs * 1.4;
      this.cap = Math.max(c.minCap, severe ? stepFloor(this.cap * 0.7) : this.cap - Math.max(CAP_STEP, stepRound(this.cap * 0.1)));
      this.holdUntil = now + this.backoffMs;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
      this.lastDecrease = now;
      this.settleUntil = now + 2 * c.windowMs;
      this.latencyHistory = []; // judged again only on samples taken after the queue drained
    } else if (!over && under && throttled && this.cap < upper) {
      // Far below target (the GPU queue is idle: e.g. right after the user raised the rivers) grow by a quarter, else
      // by ~10 %: the first seconds of a flood are the ones people watch.
      const idle = latency < latencyMs * 0.5 && frameTime < targetMs * 0.92;
      let next = Math.min(upper, this.cap + Math.max(CAP_STEP, stepRound(this.cap * (idle ? 0.25 : 0.1))));
      if (next >= this.ceiling && now < this.holdUntil) next = Math.max(this.cap, this.ceiling - CAP_STEP);
      this.cap = next;
    }
    return this.cap !== before;
  }
}

/** Evaluation windows whose latency samples are pooled (3 × 300 ms). */
const LATENCY_WINDOWS = 3;

/** Resolution of the substep cap. */
const CAP_STEP = 0.5;
const stepRound = (x: number) => Math.round(x / CAP_STEP) * CAP_STEP;
const stepFloor = (x: number) => Math.floor(x / CAP_STEP) * CAP_STEP;

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
 *   watching    — hands off, the flood is the show: input lag is invisible, so the GPU queue may run about two
 *                 frames deep for more sim per frame. Not deeper: measured on the M4 (Pittsburgh at the 1936 crest
 *                 with 50 mm/hr rain, 1600×1000), a fixed 5 substeps per frame ran at 60 fps with a p95 frame time
 *                 of 19 ms and ~28 ms latency; 6 substeps → ~40 ms latency and dropped frames (p95 24 ms); the old
 *                 60 ms target settled at ~6 substeps with a p95 of 31 ms for only ~10 % more sim speed;
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
  watching: { frameMs: 19.5, latencyMs: 34 },
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
