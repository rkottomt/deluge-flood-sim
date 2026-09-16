import type { CameraPose } from '../contracts';

/** How long after the last input / state change / camera motion we keep rendering at full rate. */
const ACTIVE_HOLD_MS = 1200;
/** Render rate while idle (paused, no input, camera at rest): a heartbeat that picks up anything missed. */
const IDLE_INTERVAL_MS = 250;

export interface PaceDecision {
  /** Render this frame. */
  render: boolean;
  /** Full-rate frame (counts toward FPS; advances the animation clock). */
  active: boolean;
}

/**
 * Power-aware render pacing (the demo laptop is a fanless MacBook Air that throttles when hot).
 *
 * While the simulation runs every frame is rendered (the loop itself caps at 60 fps). While paused, the
 * GPU should be nearly idle: frames are only rendered at full rate for a short while after something could
 * have changed the picture — user input, a store change, a camera animation, a readback — and otherwise at
 * a 4 Hz heartbeat with the animation clock frozen (so those heartbeat frames are identical and cheap to
 * miss). Hidden tabs render nothing.
 */
export class RenderPacer {
  /** Animation clock (s) handed to the renderer: advances only on full-rate frames, so it never jumps. */
  animTime = 0;
  /** performance.now() when the camera pose last changed (user drag, damping, fly-to). */
  lastCameraMotion = -Infinity;
  private activeUntil = -Infinity;
  private lastRender = -Infinity;
  private readonly lastPose = new Float64Array(6).fill(NaN);

  /** Something may have changed what is on screen: render at full rate for a while. */
  poke(now: number, holdMs = ACTIVE_HOLD_MS): void {
    const until = now + holdMs;
    if (until > this.activeUntil) this.activeUntil = until;
  }

  /**
   * Decide what to do this frame. `busy` = the picture changes by itself (sim running, automation,
   * loading); `hidden` = document hidden.
   */
  decide(now: number, busy: boolean, hidden: boolean, pose: CameraPose | null): PaceDecision {
    if (hidden) return { render: false, active: false };
    if (pose && this.poseMoved(pose)) this.cameraMoved(now);
    const active = busy || now < this.activeUntil;
    const render = active || now - this.lastRender >= IDLE_INTERVAL_MS;
    return { render, active };
  }

  /** Record a rendered frame; `pose` is the camera pose AFTER rendering (the renderer integrates damping). */
  rendered(now: number, realDt: number, active: boolean, pose: CameraPose | null): void {
    this.lastRender = now;
    if (active) this.animTime += realDt;
    // Camera still gliding (damping / fly-to happens inside render): keep full rate until it settles.
    if (pose && this.poseMoved(pose)) this.cameraMoved(now);
  }

  private cameraMoved(now: number): void {
    this.lastCameraMotion = now;
    this.poke(now);
  }

  /** Compares against (and then remembers) the last seen pose. */
  private poseMoved(p: CameraPose): boolean {
    const v = this.lastPose;
    const moved =
      v[0] !== p.target.gx ||
      v[1] !== p.target.gy ||
      v[2] !== p.target.elevation ||
      v[3] !== p.distance ||
      v[4] !== p.yaw ||
      v[5] !== p.pitch;
    if (moved) {
      v[0] = p.target.gx;
      v[1] = p.target.gy;
      v[2] = p.target.elevation;
      v[3] = p.distance;
      v[4] = p.yaw;
      v[5] = p.pitch;
    }
    return moved;
  }
}
