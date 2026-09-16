/**
 * Renderer quality presets and the adaptive resolution controller.
 *
 * The demo machine is a fanless MacBook Air: it can burst to 60 fps but throttles under sustained load, and the
 * solver shares the same GPU (its substep budget shrinks when rendering is expensive). So the default quality is
 * 'auto': the render resolution follows measured frame times (hysteresis + cooldowns, no oscillation), idle
 * frames are capped at 30 fps, and derived water textures are only rebuilt when the solver state changed.
 */

export type RendererQuality = 'auto' | 'high' | 'balanced' | 'low';

export interface QualityPreset {
  /** Device-pixel-ratio cap. */
  maxDpr: number;
  /** Render pixel budget (the canvas backing store is scaled down to fit; CSS upscales). */
  maxPixels: number;
  bloom: boolean;
  /** Minimum frames between derived-texture rebuilds while the solver state is changing every frame. */
  prepInterval: number;
  /** Frame-rate cap when nothing but the animation clock changed (camera still, sim paused, no rain). */
  idleFps: number;
  /** Screen-space rain drop budget at the heaviest rain. */
  rainDrops: number;
  /** CDLOD target: on-screen size of a terrain/water quad in pixels (larger = coarser, cheaper). */
  lodQuadPixels: number;
}

export const QUALITY_PRESETS: Record<Exclude<RendererQuality, 'auto'>, QualityPreset> = {
  high: { maxDpr: 2, maxPixels: 2560 * 1600, bloom: true, prepInterval: 1, idleFps: 60, rainDrops: 16000, lodQuadPixels: 2.5 },
  balanced: { maxDpr: 1.5, maxPixels: 1920 * 1200, bloom: true, prepInterval: 1, idleFps: 30, rainDrops: 12000, lodQuadPixels: 3.5 },
  low: { maxDpr: 1, maxPixels: 1440 * 900, bloom: false, prepInterval: 2, idleFps: 30, rainDrops: 6000, lodQuadPixels: 5 },
};

/** Pixel-budget bounds for 'auto'. */
const AUTO_MIN_PIXELS = 960 * 600;
const AUTO_MAX_PIXELS = 2560 * 1600;
const AUTO_START_PIXELS = 1920 * 1200;

/** Frame interval (ms) above which 'auto' lowers resolution (≈ 48 fps) and below which it may raise it. */
const SLOW_MS = 20.8;
const FAST_MS = 17.6;

/**
 * Adaptive pixel budget from frame intervals. Only intervals between two consecutive *rendered* frames are fed
 * in (idle-capped frames are excluded by the caller), so a deliberately throttled idle scene never looks slow.
 */
export class AdaptiveResolution {
  pixels = AUTO_START_PIXELS;
  private ema = 16.7;
  private slowFrames = 0;
  private fastFrames = 0;
  private cooldownUntil = 0;
  /** After a raise that had to be undone, wait longer before trying again. */
  private raiseHoldMs = 4000;
  private lastRaiseAt = -Infinity;

  reset(): void {
    this.pixels = AUTO_START_PIXELS;
    this.ema = 16.7;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.cooldownUntil = 0;
    this.raiseHoldMs = 4000;
  }

  /**
   * Feed one frame interval; returns true when the budget changed.
   * `gpuMs` (optional, from timestamp queries) lets us refuse raises when the GPU is already busy.
   */
  sample(intervalMs: number, now: number, gpuMs?: number): boolean {
    if (!(intervalMs > 0) || intervalMs > 250) return false;
    this.ema += (intervalMs - this.ema) * 0.08;
    if (now < this.cooldownUntil) return false;
    this.slowFrames = this.ema > SLOW_MS ? this.slowFrames + 1 : 0;
    this.fastFrames = this.ema < FAST_MS ? this.fastFrames + 1 : 0;

    if (this.slowFrames > 40 && this.pixels > AUTO_MIN_PIXELS) {
      // Frame time scales ≈ with pixels: aim for the target with a margin.
      const ratio = Math.min(0.85, Math.max(0.6, (FAST_MS / this.ema) ** 1.2));
      this.pixels = Math.max(AUTO_MIN_PIXELS, Math.round(this.pixels * ratio));
      if (now - this.lastRaiseAt < 6000) this.raiseHoldMs = Math.min(60000, this.raiseHoldMs * 2);
      this.settle(now, 1500);
      return true;
    }
    const gpuBusy = gpuMs !== undefined && gpuMs > 9;
    if (this.fastFrames > 240 && this.pixels < AUTO_MAX_PIXELS && !gpuBusy) {
      this.pixels = Math.min(AUTO_MAX_PIXELS, Math.round(this.pixels * 1.2));
      this.lastRaiseAt = now;
      this.settle(now, this.raiseHoldMs);
      return true;
    }
    return false;
  }

  private settle(now: number, ms: number): void {
    this.cooldownUntil = now + ms;
    this.slowFrames = 0;
    this.fastFrames = 0;
    this.ema = 16.7;
  }
}

/** Backing-store size for a canvas under a DPR cap and pixel budget (aspect preserved). */
export function targetSize(cssW: number, cssH: number, dpr: number, maxDpr: number, maxPixels: number, maxDim: number): [number, number] {
  const d = Math.min(maxDpr, dpr > 0 ? dpr : 1);
  let w = Math.max(1, Math.round(cssW * d));
  let h = Math.max(1, Math.round(cssH * d));
  if (w * h > maxPixels) {
    const s = Math.sqrt(maxPixels / (w * h));
    w = Math.max(1, Math.floor(w * s));
    h = Math.max(1, Math.floor(h * s));
  }
  return [Math.min(w, maxDim), Math.min(h, maxDim)];
}
