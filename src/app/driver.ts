import type { AppState, FloodSolver, SimSnapshot, SimStats, StepInfo } from '../contracts';
import type { App } from './App';
import { APP_CONFIG } from './defaults';
import { errorMessage } from './errors';
import { NO_TRANSIENT, OverlayComposer } from './overlays';
import { footprintRadius, stormWeight } from '../sim/forcing';

/** Rain rate (mm/hr) at grid position (gx, gy): global rain plus storm cells, with the solver's storm profile. */
export function rainAt(state: Pick<AppState, 'sim' | 'storms'>, gx: number, gy: number): number {
  let rain = Math.max(0, state.sim.rainRate);
  for (const st of state.storms) {
    rain += Math.max(0, st.intensity) * stormWeight(Math.hypot(gx - st.gx, gy - st.gy), footprintRadius(st.radius));
  }
  return rain;
}

/** Treat speeds above this as a numerical blow-up (no real flood flows at > 100 m/s). */
const BLOWUP_SPEED = 100;
/** How long ready() waits for the first readback after the first rendered frame. */
const READY_SNAPSHOT_WAIT_MS = 3000;

/**
 * Per-frame work: step the solver (feeding the frame-time governor), consume readbacks (stats → HUD,
 * depth → routing), compose overlays and render (paced: full rate only while something changes). Also
 * tracks the sim clock used by runFor() and resolves the debug API's `ready` promise.
 */
export class FrameDriver {
  /** Sim seconds advanced since the last reset / scene load (sum of StepInfo.simSecondsAdvanced). */
  simClock = 0;
  frameCount = 0;
  lastSnapshot: SimSnapshot | null = null;

  private lastSnapTime = NaN;
  private lastStepInfo: StepInfo | null = null;
  private lastAdvance = 0;
  private pendingStats: SimStats | null = null;
  private lastHud = -Infinity;
  private sceneFrames = 0;
  private sceneReadyAt = 0;
  private blowupNotified = false;
  private wasRunning = false;
  private readonly overlays = new OverlayComposer();

  constructor(private readonly app: App) {}

  /** New scene bound: drop everything derived from the previous solver. */
  onSceneChanged(now: number): void {
    this.simClock = 0;
    this.lastSnapshot = null;
    this.lastSnapTime = NaN;
    this.lastStepInfo = null;
    this.lastAdvance = 0;
    this.pendingStats = null;
    this.sceneFrames = 0;
    this.sceneReadyAt = now;
    this.blowupNotified = false;
    this.overlays.invalidate();
    this.app.runner.onReset();
  }

  /** solver.reset() was called. */
  onSolverReset(): void {
    this.simClock = 0;
    this.blowupNotified = false;
    this.app.runner.onReset();
  }

  /** Announce the next numerical blow-up again (stability demo re-enabled). */
  rearmBlowupNotice(): void {
    this.blowupNotified = false;
  }

  /**
   * One frame. Returns true if it was rendered at full rate (for the FPS meter).
   * `frameMs` is the raw interval since the previous frame (feeds the substep governor).
   */
  frame(realDt: number, now: number, frameMs: number): boolean {
    const workStart = performance.now();
    const { store, renderer, runner, scenes, evac, pacer } = this.app;
    const scene = scenes?.scene;
    if (!scene || !renderer) {
      this.publishHud(now, store.get());
      return false;
    }
    const { solver } = scene;
    let state = store.get();

    // Each stage is isolated: a module that throws every frame (reported once, deduplicated) must not
    // stop the others — above all, rendering must keep going.

    // 1. Simulation. The old scene may still be shown while a new one loads — never step it then.
    const hidden = document.hidden;
    const running = (!state.paused || runner.active) && !state.loading && !hidden;
    this.lastAdvance = 0;
    if (running) {
      if (!this.wasRunning) this.app.budget.restart();
      this.guard('solver.step', () => {
        const info = solver.step(realDt);
        this.lastStepInfo = info;
        // A blown-up solver (stability demo) may report NaN; count the requested time so runFor can't hang.
        const requested = realDt * this.app.sim.effectiveParams().timeScale;
        const advance = Number.isFinite(info.simSecondsAdvanced) ? info.simSecondsAdvanced : requested;
        this.lastAdvance = advance;
        this.simClock += advance;
        runner.onStep(advance, this.simClock, now, this.lastSnapshot);
        this.app.observeFrameBudget(frameMs, info, now);
      });
    } else if (this.lastStepInfo && this.lastStepInfo.substeps !== 0) {
      this.lastStepInfo = { ...this.lastStepInfo, simSecondsAdvanced: 0, substeps: 0, throttled: false };
    }
    this.wasRunning = running;
    const tools = this.app.tools;
    if (tools && !state.loading) this.guard('tools.update', () => tools.update(realDt));

    // 2. Readbacks → stats, road status, route; probe sampling; runFor completion.
    const snap = this.pollSnapshot(solver, now);
    this.guard('evac', () => evac.tick(now));
    if (!state.loading) this.guard('probe', () => this.app.probe?.tick(now, solver));
    runner.onFrame(snap, this.lastAdvance, now);

    // 3. Overlays + render — at full rate while anything changes, otherwise a low-rate heartbeat.
    state = store.get();
    const camera = renderer.camera;
    const pace = pacer.decide(now, running || runner.active || !!state.loading, hidden, camera.pose);
    let rendered = false;
    if (pace.render) {
      this.guard('overlays', () => {
        const transient = tools?.getTransientOverlay() ?? NO_TRANSIENT;
        const overlay = this.overlays.compose(state, evac.roadStatus, evac.statusVersion, transient);
        if (overlay) {
          renderer.setOverlays(overlay);
          pacer.poke(now);
        }
      });
      rendered = this.guard('render', () =>
        renderer.render({
          ...state.render,
          // Rain the viewer is standing in: global rain plus any storm cell over the camera target.
          rainRate: running ? rainAt(state, camera.pose.target.gx, camera.pose.target.gy) : 0,
          time: pacer.animTime,
        }),
      );
      pacer.rendered(now, realDt, pace.active, camera.pose);
      if (rendered) this.sceneFrames++;
      if (rendered && running && this.app.adaptiveBudget) this.app.latency.afterSubmit();
    }
    this.frameCount++;

    // 4. First frame with terrain + water → debug API ready.
    if (this.sceneFrames >= 2 && (this.lastSnapshot || now - this.sceneReadyAt > READY_SNAPSHOT_WAIT_MS)) {
      this.app.markReady();
    }

    this.publishHud(now, state);
    // Frame pacing vs our own work (main thread + GPU queue) → external frame-rate ceiling detection.
    const busyMs = Math.max(performance.now() - workStart, running ? this.app.lastLatencyMs : 0);
    this.app.observeFramePacing(frameMs, busyMs);
    return rendered && pace.active;
  }

  /** Run one frame stage; report (deduplicated) instead of throwing. Returns false if it threw. */
  private guard(stage: string, fn: () => void): boolean {
    try {
      fn();
      return true;
    } catch (err) {
      this.app.errors.report('frame', `${stage}: ${errorMessage(err)}`, err);
      return false;
    }
  }

  /** Latest readback; triggers onSnapshot when it is new (identity or sim time changed). */
  private pollSnapshot(solver: FloodSolver, now: number): SimSnapshot | null {
    let snap: SimSnapshot | null = null;
    try {
      snap = solver.getSnapshot();
    } catch (err) {
      this.app.errors.report('frame', `getSnapshot: ${errorMessage(err)}`, err);
      return null;
    }
    if (snap && (snap !== this.lastSnapshot || !Object.is(snap.simTime, this.lastSnapTime))) {
      this.guard('snapshot', () => this.onSnapshot(snap, now));
    }
    return snap;
  }

  private onSnapshot(snap: SimSnapshot, now: number): void {
    this.app.pacer.poke(now);
    this.lastSnapshot = snap;
    this.lastSnapTime = snap.simTime;
    this.pendingStats = { ...snap.stats };
    this.app.evac.onSnapshot(snap, now);
    this.detectBlowup(snap.stats);
  }

  /**
   * In the stability demo, log when the naive scheme has visibly exploded (once per activation). The UI shows
   * it to the user (demo banner + NaN/unstable HUD); an error toast would make an intended demo look broken.
   */
  private detectBlowup(stats: SimStats): void {
    if (this.blowupNotified || this.app.store.get().sim.stabilityMode !== 'naive') return;
    const exploded =
      !Number.isFinite(stats.maxSpeed) ||
      !Number.isFinite(stats.maxDepth) ||
      !Number.isFinite(stats.volume) ||
      stats.maxSpeed > BLOWUP_SPEED;
    if (!exploded) return;
    this.blowupNotified = true;
    const speed = Number.isFinite(stats.maxSpeed) ? `${stats.maxSpeed.toExponential(1)} m/s` : String(stats.maxSpeed);
    console.info(
      `[deluge] stability demo: the naive explicit scheme diverged at sim t=${stats.simTime.toFixed(1)} s ` +
        `(max speed ${speed}); restoring the robust solver resets the water.`,
    );
  }

  /** HUD store updates (stats, stepInfo, fps) at ~5 Hz. */
  private publishHud(now: number, state: AppState): void {
    if (now - this.lastHud < APP_CONFIG.hudIntervalMs) return;
    this.lastHud = now;
    const patch: Partial<AppState> = { fps: Math.round(this.app.loop.fps * 10) / 10 };
    if (this.pendingStats) {
      patch.stats = this.pendingStats;
      this.pendingStats = null;
    }
    if (this.lastStepInfo !== state.stepInfo) patch.stepInfo = this.lastStepInfo;
    this.app.store.set(patch);
  }
}
