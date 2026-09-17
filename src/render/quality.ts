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
  high: { maxDpr: 2, maxPixels: 2560 * 1600, bloom: true, prepInterval: 1, idleFps: 60, rainDrops: 16000, lodQuadPixels: 3 },
  balanced: { maxDpr: 1.5, maxPixels: 1920 * 1200, bloom: true, prepInterval: 2, idleFps: 30, rainDrops: 12000, lodQuadPixels: 4 },
  low: { maxDpr: 1, maxPixels: 1440 * 900, bloom: false, prepInterval: 2, idleFps: 30, rainDrops: 6000, lodQuadPixels: 5 },
};

/**
 * 'auto' ladder, best → cheapest. Resolution is traded first down to 1 render pixel per CSS pixel; only then do
 * effects go (bloom, water-mesh refresh rate, coarser LOD), and sub-CSS resolution is the last resort.
 *
 * LOD density: vertex work (terrain + water meshes, ~1 M triangles at 3 px quads) was half of the renderer's GPU time
 * in the Pittsburgh flood on the M4; 4 px quads cut the renderer's GPU time by ~15 % (6.5 → 5.3 ms at 1600×1000) with
 * no visible difference (the imagery carries the detail and shorelines are resolved per fragment).
 */
export const AUTO_LADDER: QualityPreset[] = [
  { maxDpr: 2, maxPixels: 2560 * 1600, bloom: true, prepInterval: 1, idleFps: 30, rainDrops: 16000, lodQuadPixels: 3 },
  { maxDpr: 1.5, maxPixels: 1920 * 1200, bloom: true, prepInterval: 2, idleFps: 30, rainDrops: 14000, lodQuadPixels: 4 },
  { maxDpr: 1.25, maxPixels: 1680 * 1050, bloom: true, prepInterval: 2, idleFps: 30, rainDrops: 12000, lodQuadPixels: 4.5 },
  { maxDpr: 1, maxPixels: 1600 * 1000, bloom: true, prepInterval: 2, idleFps: 30, rainDrops: 10000, lodQuadPixels: 5 },
  { maxDpr: 1, maxPixels: 1440 * 900, bloom: false, prepInterval: 2, idleFps: 30, rainDrops: 8000, lodQuadPixels: 6 },
  { maxDpr: 0.8, maxPixels: 1280 * 800, bloom: false, prepInterval: 3, idleFps: 30, rainDrops: 6000, lodQuadPixels: 7 },
];
const AUTO_START_LEVEL = 1;

/**
 * How hard the simulation is pushing for GPU time (set by the host; see AdaptiveQuality.simPressure):
 *   0 — the sim keeps up (or is paused): the renderer may claim headroom;
 *   1 — the sim is GPU-limited: hold the current level (a better picture would come straight out of sim speed),
 *       but give up levels above the default one (claimed while the sim kept up) after LIMITED_RETURN_MS,
 *       except that quality lost to starvation comes back (up to the default level, not beyond, and not sooner than
 *       STARVED_RECOVER_MS after the sim was last starved: a throttling spell passed);
 *   2 — the sim is starved (its work budget is down to a substep or two): step down slowly, at most to
 *       STARVED_MAX_LEVEL, to give it room.
 */
export type SimPressure = 0 | 1 | 2;

/** Starvation steps quality down no further than this level (1 render pixel per CSS pixel, bloom on). */
export const STARVED_MAX_LEVEL = 3;
/** Sustained starvation before each step down, ms. */
const STARVED_STEP_MS = 3000;
/** Under pressure ≥ 1 for this long, a level better than the default steps back to it, ms. */
const LIMITED_RETURN_MS = 2000;
/** Under pressure 1, levels lost to starvation are only won back this long after the sim was last starved, ms. */
const STARVED_RECOVER_MS = 20000;

/** Frame interval (ms) above which 'auto' steps down (≈ 48 fps) and below which it may step up. */
const SLOW_MS = 20.8;
const FAST_MS = 17.6;

/**
 * Adaptive quality level from frame intervals. Only intervals between two consecutive *rendered* frames are fed
 * in (idle-capped frames are excluded by the caller), so a deliberately throttled idle scene never looks slow.
 * Steps down quickly (≈ 0.7 s of slow frames), steps up cautiously (4 s of fast frames, renderer GPU time low),
 * and doubles the wait after an up-step that had to be undone, so it settles instead of oscillating.
 */
export class AdaptiveQuality {
  level = AUTO_START_LEVEL;
  private ema = 16.7;
  /** Milliseconds of consecutive slow / fast frames. */
  private slowMs = 0;
  private fastMs = 0;
  private cooldownUntil = 0;
  private raiseHoldMs = 4000;
  private lastRaiseAt = -Infinity;
  /**
   * Externally imposed frame interval (ms, 0 = none), e.g. a browser's 30 fps battery-saver cap. Frames at that
   * ceiling are not slow — lowering resolution could not make them faster — so the thresholds move above it.
   */
  floorMs = 0;
  /**
   * Sim pressure hint (see SimPressure). Frame intervals alone cannot see it: the host's work budget keeps frames on
   * time by giving the solver fewer substeps, so without the hint quality climbed to the best level while the flood
   * ran at a fraction of the requested speed.
   */
  simPressure: SimPressure = 0;
  private starvedMs = 0;
  private limitedMs = 0;
  private lastSampleAt = -Infinity;
  private lastStarvedAt = -Infinity;

  get preset(): QualityPreset {
    return AUTO_LADDER[this.level];
  }

  reset(): void {
    this.level = AUTO_START_LEVEL;
    this.ema = 16.7;
    this.slowMs = 0;
    this.fastMs = 0;
    this.cooldownUntil = 0;
    this.raiseHoldMs = 4000;
    this.lastRaiseAt = -Infinity;
    this.starvedMs = 0;
    this.limitedMs = 0;
  }

  /**
   * Feed one frame interval; returns true when the level changed.
   * `gpuMs` (optional, from timestamp queries) lets us refuse up-steps when the renderer is already expensive.
   */
  sample(intervalMs: number, now: number, gpuMs?: number): boolean {
    if (!(intervalMs > 0) || intervalMs > 250) return false;
    this.ema += (intervalMs - this.ema) * 0.12;
    const elapsed = Math.min(250, Math.max(0, now - this.lastSampleAt));
    this.lastSampleAt = now;
    this.starvedMs = this.simPressure === 2 ? this.starvedMs + elapsed : 0;
    this.limitedMs = this.simPressure >= 1 ? this.limitedMs + elapsed : 0;
    if (this.simPressure === 2) this.lastStarvedAt = now;
    if (now < this.cooldownUntil) return false;
    if (this.limitedMs > LIMITED_RETURN_MS && this.level < AUTO_START_LEVEL) {
      this.level = AUTO_START_LEVEL;
      this.settle(now, 1200);
      this.limitedMs = 0;
      return true;
    }
    if (this.starvedMs > STARVED_STEP_MS && this.level < STARVED_MAX_LEVEL) {
      this.level++;
      this.settle(now, 1200);
      this.starvedMs = 0;
      return true;
    }
    const slowThreshold = Math.max(SLOW_MS, this.floorMs * 1.25);
    const fastThreshold = Math.max(FAST_MS, this.floorMs * 1.06);
    this.slowMs = this.ema > slowThreshold ? this.slowMs + intervalMs : 0;
    this.fastMs = this.ema < fastThreshold ? this.fastMs + intervalMs : 0;

    if (this.slowMs > 700 && this.level < AUTO_LADDER.length - 1) {
      this.level++;
      if (now - this.lastRaiseAt < 4000) this.raiseHoldMs = Math.min(64000, this.raiseHoldMs * 2);
      this.settle(now, 1200);
      return true;
    }
    // The solver shares the GPU and sizes its substeps to what is left, so only claim more when the renderer
    // itself is clearly cheap.
    const gpuBusy = gpuMs !== undefined && gpuMs > 6;
    const mayRaise =
      this.simPressure === 0 ||
      (this.simPressure === 1 && this.level > AUTO_START_LEVEL && now - this.lastStarvedAt > STARVED_RECOVER_MS);
    if (this.fastMs > this.raiseHoldMs && this.level > 0 && !gpuBusy && mayRaise) {
      this.level--;
      this.lastRaiseAt = now;
      // Short settle: a bad up-step must be undone quickly (the next up-step then needs longer headroom).
      this.settle(now, 1500);
      return true;
    }
    return false;
  }

  private settle(now: number, ms: number): void {
    this.cooldownUntil = now + ms;
    this.slowMs = 0;
    this.fastMs = 0;
    this.ema = Math.max(16.7, this.floorMs);
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
