import { APP_CONFIG } from './defaults';

/**
 * Frame callback. `realDt` is the clamped frame time in seconds, `frameMs` the raw interval since the
 * previous processed frame. Returns true if the frame was rendered at full rate (counts toward FPS).
 */
export type FrameFn = (realDt: number, nowMs: number, frameMs: number) => boolean;

/**
 * requestAnimationFrame driver: caps processing at ~60 Hz (a 120 Hz display must not double the GPU work
 * on a fanless laptop), computes the clamped real dt and a smoothed FPS of full-rate frames, and isolates
 * exceptions thrown by a frame so one bad frame can't stop the loop.
 */
export class FrameLoop {
  /** Smoothed frames per second of full-rate rendering (EMA of frame time). Idle frames don't count. */
  fps = 0;
  private handle = 0;
  private lastMs = -1;
  private frameMsEma = 0;
  private lastWasActive = false;
  private running = false;

  constructor(
    private readonly onFrame: FrameFn,
    private readonly onError: (err: unknown) => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.handle = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
    document.removeEventListener('visibilitychange', this.onVisibility);
  }

  private readonly onVisibility = (): void => {
    // rAF stops while hidden; don't count the hidden period as one giant frame (or as a slow frame for FPS).
    this.lastMs = -1;
    this.lastWasActive = false;
  };

  private readonly tick = (nowMs: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    if (this.lastMs >= 0 && nowMs - this.lastMs < APP_CONFIG.minFrameIntervalMs) return; // > 60 Hz display
    const rawMs = this.lastMs < 0 ? 1000 / 60 : Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    const realDt = Math.min(APP_CONFIG.maxRealDt, rawMs / 1000);

    let active = false;
    try {
      active = this.onFrame(realDt, nowMs, rawMs);
    } catch (err) {
      this.onError(err);
    }
    if (active && this.lastWasActive && rawMs > 0 && rawMs < 1000) {
      const a = APP_CONFIG.fpsEmaAlpha;
      this.frameMsEma = this.frameMsEma === 0 ? rawMs : this.frameMsEma + a * (rawMs - this.frameMsEma);
      this.fps = 1000 / this.frameMsEma;
    }
    this.lastWasActive = active;
  };
}
