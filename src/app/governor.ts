import type { StepInfo } from '../contracts';

/**
 * Adaptive solver work budget driven by MEASURED FRAME TIME (the thing the user actually feels).
 *
 * The solver advances `realDt × timeScale` sim seconds per frame in CFL-limited substeps; every substep is
 * GPU work that competes with rendering. On a fanless laptop the GPU also slows down as it heats up, so a
 * fixed substep count that is smooth at minute 1 stutters at minute 10. A governor owns a substep cap (fed
 * to the solver as `maxSubstepsPerFrame`) and steers it with an AIMD controller, like TCP congestion control:
 *
 *   • frame time above target → multiplicative decrease (cap × 0.7); that cap is remembered as a ceiling and
 *     probed again only after a backoff (1 s, 2 s, 4 s … 8 s), so the cap settles instead of sawtoothing;
 *   • frame time below target AND this cap is what limits the sim → additive increase.
 *
 * Frame time per evaluation window is a trimmed mean (the single worst interval is dropped), so isolated
 * hitches (a GC pause, a readback) don't cost throughput. The first frames after a (re)start are ignored
 * (shader compilation, tab switches).
 */
export interface GovernorConfig {
  /** Frame-time target, ms. */
  targetMs: number;
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

const BASE_CONFIG: Omit<GovernorConfig, 'targetMs' | 'initialCap'> = {
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
  private windowStart = -Infinity;
  private frames = 0;
  /** Cap at which the last decrease happened (probing at/above it waits for the backoff). */
  private ceiling = Infinity;
  private holdUntil = -Infinity;
  private backoffMs = MIN_BACKOFF_MS;
  private lastDecrease = -Infinity;
  private throttledInWindow = false;

  constructor(readonly config: GovernorConfig) {
    this.cap = config.initialCap;
  }

  /** Forget measurements (scene change, resume after pause/hidden, mode switch). Keeps the learned cap. */
  restart(): void {
    this.frames = 0;
    this.window = [];
    this.windowStart = -Infinity;
    this.throttledInWindow = false;
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
    const throttled = this.throttledInWindow;
    this.window = [];
    this.throttledInWindow = false;

    if (now - this.lastDecrease > CALM_RESET_MS) {
      this.ceiling = Infinity;
      this.backoffMs = MIN_BACKOFF_MS;
    }
    const before = this.cap;
    if (frameTime > c.targetMs * (1 + c.band) && this.cap > c.minCap) {
      this.ceiling = this.cap;
      this.cap = Math.max(c.minCap, Math.floor(this.cap * 0.7));
      this.holdUntil = now + this.backoffMs;
      this.backoffMs = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2);
      this.lastDecrease = now;
    } else if (frameTime < c.targetMs * (1 - c.band) && throttled && this.cap < upper) {
      let next = Math.min(upper, this.cap + Math.max(1, Math.round(this.cap * 0.1)));
      if (next >= this.ceiling && now < this.holdUntil) next = Math.max(this.cap, this.ceiling - 1);
      this.cap = next;
    }
    return this.cap !== before;
  }
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
 * What the frame is for, which decides the frame-time target:
 *   interactive — the user is touching something (camera, tools, sliders): smoothness first (~55–60 fps);
 *   watching    — hands off, the flood is the show: more substeps per frame (~40 fps);
 *   automation  — runFor() fast-forwarding: throughput first (~20 fps).
 */
export type BudgetMode = 'interactive' | 'watching' | 'automation';

export const BUDGET_TARGET_MS: Record<BudgetMode, number> = {
  // 60 Hz display: grow only while (nearly) every frame makes vsync, shrink once ~1 in 8 frames is dropped.
  interactive: 18.5,
  watching: 26,
  automation: 50,
};

/**
 * One learned cap per mode, so switching (e.g. grabbing the camera while the flood runs) applies that mode's
 * cap immediately instead of waiting for the controller to re-converge.
 */
export class WorkBudget {
  mode: BudgetMode = 'watching';
  private readonly governors: Record<BudgetMode, SubstepGovernor>;

  constructor(targets: Record<BudgetMode, number> = BUDGET_TARGET_MS) {
    const make = (targetMs: number, initialCap: number) => new SubstepGovernor({ ...BASE_CONFIG, targetMs, initialCap });
    this.governors = {
      interactive: make(targets.interactive, 4),
      watching: make(targets.watching, 8),
      automation: make(targets.automation, 16),
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

  observe(frameMs: number, info: StepInfo, now: number, maxCap: number): boolean {
    return this.governors[this.mode].observe(frameMs, info, now, maxCap);
  }
}
