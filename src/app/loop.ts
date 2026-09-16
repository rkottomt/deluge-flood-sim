import { APP_CONFIG } from './defaults';

/**
 * requestAnimationFrame driver: computes clamped real dt, a smoothed FPS estimate, and isolates
 * exceptions thrown by a frame so one bad frame can't stop the loop.
 */
export class FrameLoop {
  /** Smoothed frames per second (EMA of frame time). */
  fps = 0;
  private handle = 0;
  private lastMs = -1;
  private frameMsEma = 0;
  private running = false;

  constructor(
    private readonly onFrame: (realDt: number, nowMs: number) => void,
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
  };

  private readonly tick = (nowMs: number): void => {
    if (!this.running) return;
    this.handle = requestAnimationFrame(this.tick);

    const rawMs = this.lastMs < 0 ? 1000 / 60 : Math.max(0, nowMs - this.lastMs);
    this.lastMs = nowMs;
    if (rawMs > 0 && rawMs < 1000) {
      const a = APP_CONFIG.fpsEmaAlpha;
      this.frameMsEma = this.frameMsEma === 0 ? rawMs : this.frameMsEma + a * (rawMs - this.frameMsEma);
      this.fps = 1000 / this.frameMsEma;
    }
    const realDt = Math.min(APP_CONFIG.maxRealDt, rawMs / 1000);
    try {
      this.onFrame(realDt, nowMs);
    } catch (err) {
      this.onError(err);
    }
  };
}
