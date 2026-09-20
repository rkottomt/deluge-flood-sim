import type { AppState, FloodSolver, SimSnapshot, SimStats, StepInfo } from '../contracts';
import type { App } from './App';
import { APP_CONFIG } from './defaults';
import { errorMessage } from './errors';
import { NO_TRANSIENT, OverlayComposer } from './overlays';
import { snapshotIsPhysical } from './evac';
import { footprintRadius, stormWeight } from '../sim/forcing';

/** Rain rate (mm/hr) at grid position (gx, gy): global rain plus storm cells, with the solver's storm profile. */
export function rainAt(state: Pick<AppState, 'sim' | 'storms'>, gx: number, gy: number): number {
  let rain = Math.max(0, state.sim.rainRate);
  for (const st of state.storms) {
    rain += Math.max(0, st.intensity) * stormWeight(Math.hypot(gx - st.gx, gy - st.gy), footprintRadius(st.radius));
  }
  return rain;
}

/**
 * Recent per-frame average of the solver's StepInfo for the HUD. A single frame's substep count is noisy: the solver
 * carries time between frames and skips a frame whenever the GPU queue is backed up, so a 5 Hz sample of one frame
 * read "0 sub" at 300× now and then while the achieved speed was high.
 */
export class StepAverager {
  private readonly sub: Float64Array;
  private readonly adv: Float64Array;
  private readonly thr: Uint8Array;
  private head = 0;
  private count = 0;
  private lastDt = 0;

  constructor(readonly frames = 60) {
    this.sub = new Float64Array(frames);
    this.adv = new Float64Array(frames);
    this.thr = new Uint8Array(frames);
  }

  push(info: StepInfo): void {
    const k = this.head;
    this.sub[k] = Number.isFinite(info.substeps) ? info.substeps : 0;
    this.adv[k] = Number.isFinite(info.simSecondsAdvanced) ? info.simSecondsAdvanced : 0;
    this.thr[k] = info.throttled ? 1 : 0;
    this.lastDt = info.dt;
    this.head = (k + 1) % this.frames;
    this.count = Math.min(this.frames, this.count + 1);
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
  }

  /** Mean substeps and sim seconds per frame over the window, the latest dt, throttled if most frames were; null if empty. */
  value(): StepInfo | null {
    if (this.count === 0) return null;
    let sub = 0;
    let adv = 0;
    let thr = 0;
    for (let i = 0; i < this.count; i++) {
      sub += this.sub[i];
      adv += this.adv[i];
      thr += this.thr[i];
    }
    return { substeps: sub / this.count, simSecondsAdvanced: adv / this.count, dt: this.lastDt, throttled: thr * 2 > this.count };
  }
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
  /** What the HUD shows: the last second's average (see StepAverager). */
  private readonly stepAverage = new StepAverager();
  private hudStepInfo: StepInfo | null = null;
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
    this.stepAverage.reset();
    this.hudStepInfo = null;
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
        this.stepAverage.push(info);
        // A blown-up solver (stability demo) may report NaN; count the requested time so runFor can't hang.
        const requested = realDt * this.app.sim.effectiveParams().timeScale;
        const advance = Number.isFinite(info.simSecondsAdvanced) ? info.simSecondsAdvanced : requested;
        this.lastAdvance = advance;
        this.simClock += advance;
        this.app.advanceStage(advance, now);
        runner.onStep(advance, this.simClock, now, this.lastSnapshot);
        this.app.observeFrameBudget(frameMs, info, now);
      });
    } else {
      // Paused / loading / hidden: nothing competes with the renderer for the GPU.
      this.app.setSimPressure(0);
      if (this.lastStepInfo && this.lastStepInfo.substeps !== 0) {
        this.lastStepInfo = { ...this.lastStepInfo, simSecondsAdvanced: 0, substeps: 0, throttled: false };
      }
      // Resuming starts a fresh average (not one diluted by the paused spell or carried over from before it).
      this.stepAverage.reset();
    }
    this.wasRunning = running;
    const tools = this.app.tools;
    if (tools && !state.loading) this.guard('tools.update', () => tools.update(realDt));

    // 2. Readbacks → stats, road status, route; probe sampling; runFor completion.
    const snap = this.pollSnapshot(solver, now);
    this.guard('evac', () => evac.tick(now));
    this.guard('protection', () => this.app.protection.tick(now, () => this.app.protectionInput()));
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
    // A blown-up solver's depths say nothing about what a wall holds back: keep the last physical answer.
    if (this.app.store.get().sim.stabilityMode === 'robust' && snapshotIsPhysical(snap)) this.app.protection.onSnapshot();
    this.detectBlowup(snap.stats);
  }

  /**
   * Log once per scene (or per reset) if the solver ever produces values no flood can reach. The robust scheme is
   * not supposed to get here — the HUD and renderer already refuse to present non-finite state — so this is a
   * diagnostic breadcrumb, not an error toast.
   */
  private detectBlowup(stats: SimStats): void {
    if (this.blowupNotified) return;
    const exploded =
      !Number.isFinite(stats.maxSpeed) ||
      !Number.isFinite(stats.maxDepth) ||
      !Number.isFinite(stats.volume) ||
      stats.maxSpeed > BLOWUP_SPEED;
    if (!exploded) return;
    this.blowupNotified = true;
    const speed = Number.isFinite(stats.maxSpeed) ? `${stats.maxSpeed.toExponential(1)} m/s` : String(stats.maxSpeed);
    console.info(
      `[deluge] the solver produced non-physical values at sim t=${stats.simTime.toFixed(1)} s ` +
        `(max speed ${speed}); resetting the water rewrites every state texture.`,
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
    // While running: the last second's average; paused: the last frame's (zeroed) info.
    const stepInfo = this.stepAverage.value() ?? this.lastStepInfo;
    if (!sameStepInfo(stepInfo, this.hudStepInfo) || state.stepInfo !== this.hudStepInfo) {
      this.hudStepInfo = stepInfo;
      patch.stepInfo = stepInfo;
    }
    this.app.store.set(patch);
  }
}

function sameStepInfo(a: StepInfo | null, b: StepInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.substeps === b.substeps && a.simSecondsAdvanced === b.simSecondsAdvanced && a.dt === b.dt && a.throttled === b.throttled;
}
