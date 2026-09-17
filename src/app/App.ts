import type { AppActions, AppState, FloodRenderer, FloodSolver, StepInfo, ToolController } from '../contracts';
import { createDelugeDevice, type DelugeGPU } from '../gpu';
import { createRenderer, type DelugeRendererAPI } from '../render';
import { createRouter } from '../routing';
import { createToolController, mountUI } from '../ui';
import { createActions } from './actions';
import { CrestFill } from './crest';
import { createDebugApi, type DelugeDebug } from './debugApi';
import { APP_CONFIG, createInitialState } from './defaults';
import { FrameDriver } from './driver';
import { errorMessage, ErrorReporter } from './errors';
import { EvacController } from './evac';
import { WorkBudget, type BudgetMode } from './governor';
import { FrameCeiling } from './frameCeiling';
import { GpuLatencyProbe } from './latency';
import { FrameLoop } from './loop';
import { RenderPacer } from './pacer';
import { ProbeSampler } from './probe';
import { RunForScheduler } from './runFor';
import { SceneManager, SupersededLoadError, type Scene } from './scene';
import { SimSync } from './simSync';
import { StageLevels } from './stage';
import { StageRamp } from './stageRamp';
import { createStore } from './store';
import { showDeviceLost, WebGPUUnavailableError } from './unsupported';
import { postNotice } from '../ui/bridge';
import { parseStartupRequest, writeSceneToUrl, type SceneRequest } from './url';

export type LoadOutcome = 'ok' | 'failed' | 'superseded';

/**
 * Application orchestrator: creates the GPU device, renderer, router, UI and tool controller, owns the
 * current scene (terrain + solver), and runs the frame loop. The heavy lifting lives in focused helpers:
 *   SceneManager (load sequence) · SimSync (store → solver) · FrameDriver (per-frame work) ·
 *   WorkBudget (frame-time substep governor) · RenderPacer (power-aware rendering) ·
 *   EvacController (routing) · RunForScheduler (automation) · createActions · createDebugApi.
 */
export class App {
  readonly store = createStore(createInitialState());
  readonly errors = new ErrorReporter();
  readonly stage = new StageLevels();
  /** The applied river stage follows the slider at a limited rate in simulated time (see stageRamp.ts). */
  readonly stageRamp = new StageRamp();
  /** Applied offset last pushed to the solver (sources + channel raise), and when it was published to the store. */
  private stagePushed = 0;
  private stagePublishedAt = -Infinity;
  readonly runner = new RunForScheduler();
  /** Frame-time substep governor (one learned cap per interaction mode). */
  readonly budget = new WorkBudget();
  readonly pacer = new RenderPacer();
  /** GPU queue latency → work budget (see governor.ts for why frame time alone is not enough). */
  readonly latency = new GpuLatencyProbe(
    () => this.gpu?.device.queue ?? null,
    (ms) => {
      this.lastLatencyMs = ms;
      this.budget.noteLatency(ms);
    },
  );
  /** Latest GPU latency sample, ms (0 until the solver has run). */
  lastLatencyMs = 0;
  /** External frame-rate ceiling (e.g. Chrome Energy Saver / Low Power Mode at 30 fps), shared by both controllers. */
  readonly frameCeiling = new FrameCeiling();
  readonly router = createRouter();
  readonly evac: EvacController;
  readonly sim: SimSync;
  /** Stage raises lift the water in the river channels at once (see crest.ts). */
  readonly crest: CrestFill;
  readonly driver: FrameDriver;
  readonly loop: FrameLoop;
  readonly actions: AppActions;
  /** Automation API (exposed as window.__deluge by main.ts). */
  readonly debug: DelugeDebug;

  gpu: DelugeGPU | null = null;
  renderer: FloodRenderer | null = null;
  scenes: SceneManager | null = null;
  tools: ToolController | null = null;
  probe: ProbeSampler | null = null;

  /** Stability demo ("Break it") state; the CFL to restore when it is switched off. */
  stabilityDemo = false;
  preDemoCfl: number = APP_CONFIG.robustCfl;

  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readySettled = false;
  /** performance.now() of the last user input event anywhere in the page. */
  private lastInputAt = -Infinity;
  private resizePending = true;
  private adaptiveBudgetOn = true;
  /** The GPU device is gone (see onDeviceLost); nothing may touch the GPU any more. */
  private gpuLost = false;
  /** The page is being unloaded (a reload destroys the device on its way out: not a loss to report). */
  private unloading = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly uiRoot: HTMLElement,
  ) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Nobody may be awaiting `ready` (normal users) — don't turn a startup failure into an unhandled rejection.
    this.ready.catch(() => {});

    this.errors.installWindowHandlers();
    this.errors.attachStore(this.store);

    this.evac = new EvacController(this.router, this.store, this.errors);
    this.sim = new SimSync({
      store: this.store,
      stage: this.stage,
      errors: this.errors,
      getSolver: () => this.scenes?.scene?.solver ?? null,
      getAppliedStageOffset: () => this.stageRamp.applied,
      onRouteInputsChanged: () => this.evac.recomputeRoute(),
    });
    this.crest = new CrestFill({
      store: this.store,
      errors: this.errors,
      getScene: () => this.scenes?.scene ?? null,
      getStageOffset: () => this.stageRamp.applied,
      onWaterReset: () => {
        this.driver.onSolverReset();
        this.requestRender();
      },
    });
    this.driver = new FrameDriver(this);
    this.loop = new FrameLoop(
      (dt, now, frameMs) => this.frame(dt, now, frameMs),
      (err) => this.errors.report('frame', errorMessage(err), err),
    );
    this.actions = createActions(this);
    this.debug = createDebugApi(this, this.ready);
  }

  /**
   * Initialize GPU + modules and kick off the initial terrain load (not awaited).
   * Throws WebGPUUnavailableError if no usable WebGPU device exists; other errors are fatal startup errors.
   */
  async start(): Promise<void> {
    try {
      await this.init();
    } catch (err) {
      this.failReady(err instanceof Error ? err : new Error(errorMessage(err)));
      throw err;
    }
    void this.loadInitial();
  }

  private async init(): Promise<void> {
    const { store } = this;
    let gpu: DelugeGPU;
    try {
      if (!navigator.gpu) throw new Error('navigator.gpu is undefined');
      gpu = await createDelugeDevice(navigator.gpu);
    } catch (err) {
      throw new WebGPUUnavailableError(errorMessage(err));
    }
    this.gpu = gpu;
    window.addEventListener('pagehide', () => (this.unloading = true));
    this.errors.attachDevice(gpu.device, (info) => this.onDeviceLost(info));
    store.set({ gpuInfo: gpu.description, loading: { message: 'Compiling GPU shaders…', progress: 0 } });

    // UI first so the loading overlay is up while shaders compile.
    try {
      mountUI(this.uiRoot, store, this.actions);
    } catch (err) {
      this.errors.report('ui', `mountUI failed: ${errorMessage(err)}`, err);
    }
    document.getElementById('boot')?.remove();

    const format = navigator.gpu.getPreferredCanvasFormat();
    const renderer = await createRenderer(gpu.device, this.canvas, format);
    this.renderer = renderer;

    this.scenes = new SceneManager({
      device: gpu.device,
      store,
      renderer,
      router: this.router,
      stage: this.stage,
      // The old solver is destroyed right after this: that is when a stability demo on it ends. Exiting any earlier
      // (at load start) would leave its NaN water on screen without the demo banner and its Restore button if the
      // load then fails or is superseded; the new solver is created afterwards, so it starts robust.
      onSceneCleared: () => {
        this.exitStabilityDemoQuietly();
        this.crest.onSceneChanged();
        this.setStageNow(0);
        this.evac.reset();
      },
      onSceneReady: (scene) => this.onSceneReady(scene),
    });

    // The tool controller owns pointer input on the canvas, including renderer.camera.leftDragOrbits.
    try {
      this.tools = createToolController(this.canvas, {
        store,
        renderer,
        getSolver: () => this.scenes?.scene?.solver ?? null,
        getTerrain: () => this.scenes?.scene?.terrain ?? null,
      });
    } catch (err) {
      this.errors.report('ui', `createToolController failed: ${errorMessage(err)}`, err);
    }

    this.probe = new ProbeSampler(store, gpu.device);
    this.probe.install();
    this.sim.install();
    this.store.subscribe((s, prev) => {
      if (s.stageOffset === prev.stageOffset) return;
      this.stageRamp.setTarget(s.stageOffset);
      // Paused: nothing advances the ramp, but the UI shows where the river is heading.
      this.requestRender();
    });
    this.sim.setOverride('governor', { maxSubstepsPerFrame: this.budget.cap });
    this.installResizeHandling();
    this.installActivityTracking();
    this.store.subscribe((s, prev) => {
      if (s.sim.stabilityMode !== prev.sim.stabilityMode) this.stabilityDemo = s.sim.stabilityMode === 'naive';
    });
    this.loop.start();
  }

  private async loadInitial(): Promise<void> {
    const { request, warnings } = parseStartupRequest(window.location.search);
    for (const w of warnings) {
      console.warn(`[deluge] ${w}`);
      postNotice(this.store, { kind: 'info', title: 'Link parameter ignored', message: w });
    }
    const outcome = request.kind === 'live' ? await this.loadStartupLive(request) : await this.loadScene(request);
    if (outcome === 'failed' && !this.scenes?.scene) {
      this.failReady(new Error('No terrain could be loaded (preset and offline sandbox both failed)'));
    }
  }

  /**
   * A ?live= link (typically a reload after picking an area) needs the network before anything can be shown, and
   * venue wifi may be down or stall. Bound that wait: offline, or when the download makes no progress for a while
   * or runs too long, show the offline default preset instead. That load supersedes the live one (whose late
   * result is discarded). The address bar keeps the live link, and the notice offers a retry.
   */
  private loadStartupLive(request: SceneRequest & { kind: 'live' }): Promise<LoadOutcome> {
    const scenes = this.scenes;
    if (!scenes) return this.loadScene(request);
    const label = SceneManager.label(request);
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (offline) return this.fallBackFromLive(request, `${label} needs the internet, and this computer is offline.`);

    return new Promise<LoadOutcome>((resolve) => {
      const t0 = performance.now();
      let progressKey = '';
      let progressAt = t0;
      const unsubscribe = this.store.subscribe((s) => {
        const key = s.loading ? `${s.loading.message}|${s.loading.progress}` : '';
        if (key !== progressKey) {
          progressKey = key;
          progressAt = performance.now();
        }
      });
      let gaveUp = false;
      const stop = () => {
        clearInterval(watchdog);
        unsubscribe();
      };
      const watchdog = setInterval(() => {
        // Only while the live request itself is loading (not the preset fallback loadScene may already be running).
        if (scenes.loadingRequest !== request) return;
        const now = performance.now();
        const stalledS = (now - progressAt) / 1000;
        const totalS = (now - t0) / 1000;
        if (stalledS * 1000 < APP_CONFIG.startupLiveStallMs && totalS * 1000 < APP_CONFIG.startupLiveDeadlineMs) return;
        gaveUp = true;
        stop();
        const why =
          stalledS * 1000 >= APP_CONFIG.startupLiveStallMs
            ? `the download of ${label} made no progress for ${stalledS.toFixed(0)} s`
            : `${label} was still downloading after ${totalS.toFixed(0)} s`;
        void this.fallBackFromLive(request, `The network looks slow or down: ${why}.`).then(resolve);
      }, 500);
      void this.loadScene(request).then((outcome) => {
        if (gaveUp) return; // resolved by the fallback
        stop();
        resolve(outcome);
      });
    });
  }

  /** Show the offline default preset in place of a live area that cannot load right now; offer a retry. */
  private async fallBackFromLive(request: SceneRequest & { kind: 'live' }, reason: string): Promise<LoadOutcome> {
    const outcome = await this.loadFallbackScene(null, null);
    const shown = this.scenes?.scene;
    if (shown && shown.request !== request) {
      postNotice(this.store, {
        kind: 'warn',
        key: 'startup-live-fallback',
        title: `Showing ${shown.terrain.name} (offline) instead`,
        message: `${reason} Baked scenarios work without a connection.`,
        action: { label: `Retry ${SceneManager.label(request)}`, run: () => void this.actions.loadLiveArea(request.req) },
        durationMs: 20000,
      });
    }
    return outcome;
  }

  /**
   * Load a scene. On failure the error is reported and, if no scene is left to show (initial load, or the
   * old scene was already torn down), a fallback scene is loaded (see loadFallbackScene). With `rethrow` (debug
   * API) the original error is re-thrown after the fallback.
   */
  async loadScene(request: SceneRequest, opts: { rethrow?: boolean; fallback?: boolean; quietToast?: boolean } = {}): Promise<LoadOutcome> {
    const scenes = this.scenes;
    if (!scenes || this.gpuLost) {
      const err = new Error(this.gpuLost ? 'The GPU device was lost (reload the page)' : 'App is not started (WebGPU unavailable?)');
      if (opts.rethrow) throw err;
      return 'failed';
    }
    try {
      const scene = await scenes.load(request);
      if (request.kind === 'live') this.noteLiveLoad(scene);
      // An automatic fallback keeps the address bar on what the user asked for (reload retries it). A live area
      // keeps the name it was given (the reverse-geocoded one), so a reload does not look it up again.
      if (!opts.fallback) {
        writeSceneToUrl(request.kind === 'live' ? { kind: 'live', req: { ...request.req, name: scene.terrain.name } } : request);
      }
      return 'ok';
    } catch (err) {
      if (err instanceof SupersededLoadError) {
        if (opts.rethrow) throw err;
        return 'superseded';
      }
      const msg = `Could not load ${SceneManager.label(request)}: ${errorMessage(err)}`;
      this.errors.report('load', msg, err, { toast: !opts.quietToast || !scenes.scene });
      if (!scenes.scene && !opts.fallback && !this.gpuLost) await this.loadFallbackScene(request, msg);
      if (opts.rethrow) throw err;
      return 'failed';
    }
  }

  /** A live area loaded without its optional downloads: say what is missing and what that means. */
  private noteLiveLoad(scene: Scene): void {
    const { terrain } = scene;
    const missing = [terrain.imagery ? '' : 'aerial imagery', terrain.roads ? '' : 'roads'].filter(Boolean);
    if (!missing.length) return;
    postNotice(this.store, {
      kind: 'info',
      key: 'live-missing-extras',
      title: `Loaded ${terrain.name} without ${missing.join(' or ')}`,
      message: `${missing.length === 2 ? 'Those services' : 'That service'} did not answer in time. The flood simulation works as usual${
        terrain.roads ? '' : '; evacuation routing needs the road network'
      }.`,
      durationMs: 9000,
    });
  }

  /**
   * Nothing is left on screen: load the baked default preset (offline, the real demo), and only if that fails too
   * the synthetic sandbox (needs no assets at all). The request that just failed is skipped.
   */
  private async loadFallbackScene(failed: SceneRequest | null, reason: string | null): Promise<LoadOutcome> {
    let outcome: LoadOutcome = 'failed';
    for (const id of [APP_CONFIG.defaultPreset, APP_CONFIG.fallbackPreset]) {
      if (failed?.kind === 'preset' && failed.id === id) continue;
      const label = SceneManager.label({ kind: 'preset', id });
      if (reason) this.errors.toast(`${reason} — loading “${label}” instead.`, true);
      outcome = await this.loadScene({ kind: 'preset', id }, { fallback: true });
      if (outcome !== 'failed' || this.gpuLost) return outcome;
      reason = `Could not load “${label}” either`;
    }
    return outcome;
  }

  /**
   * Advance the river stage by one frame's simulated seconds (FrameDriver). The solver gets the new stage when it
   * has moved ≥ 5 cm (a few centimetres of channel rise per step keep the bank overtopping gradual) or has arrived;
   * the store's stageOffsetApplied follows at ≤ 5 Hz for the UI.
   */
  advanceStage(simSeconds: number, now: number): void {
    const ramp = this.stageRamp;
    if (!ramp.advance(simSeconds)) return;
    if (Math.abs(ramp.applied - this.stagePushed) >= STAGE_PUSH_STEP_M || !ramp.moving) this.pushStage();
    if (now - this.stagePublishedAt >= APP_CONFIG.hudIntervalMs || !ramp.moving) this.publishStage(now);
  }

  /** Apply `offset` at once as both the slider target and the simulated stage (scene changes, automation). */
  setStageNow(offset: number): void {
    this.stageRamp.jump(offset);
    if (this.store.get().stageOffset !== offset) this.store.set({ stageOffset: offset });
    this.pushStage();
    this.publishStage(performance.now());
  }

  /** Water reset: the river goes back to normal pool and rises to the slider's stage again. */
  restartStage(): void {
    this.stageRamp.restartFrom(0);
    this.pushStage();
    this.publishStage(performance.now());
  }

  private pushStage(): void {
    const offset = this.stageRamp.applied;
    this.stagePushed = offset;
    this.sim.pushSources();
    this.crest.onStageOffset(offset);
  }

  private publishStage(now: number): void {
    this.stagePublishedAt = now;
    const applied = this.stageRamp.moving ? Math.round(this.stageRamp.applied * 1000) / 1000 : this.stageRamp.applied;
    if (this.store.get().stageOffsetApplied !== applied) this.store.set({ stageOffsetApplied: applied });
  }

  runFor(simSeconds: number): Promise<void> {
    const run = this.runner.start(simSeconds, performance.now());
    this.sim.setOverride('runFor', { timeScale: APP_CONFIG.runForTimeScale });
    this.requestRender();
    const restore = () => {
      if (!this.runner.active) this.sim.setOverride('runFor', null);
    };
    return run.then(restore, (err: unknown) => {
      restore();
      throw err;
    });
  }

  /** Run `fn` with the current solver, reporting (not throwing) failures. No-op without a scene. */
  withSolver(what: string, fn: (solver: FloodSolver) => void): void {
    const solver = this.scenes?.scene?.solver;
    if (!solver) return;
    try {
      fn(solver);
    } catch (err) {
      this.errors.report('sim', `${what} failed: ${errorMessage(err)}`, err);
    }
  }

  /** Frame-time substep governor on (default). Off = only the user's maxSubstepsPerFrame applies (benchmarks). */
  get adaptiveBudget(): boolean {
    return this.adaptiveBudgetOn;
  }
  set adaptiveBudget(on: boolean) {
    this.adaptiveBudgetOn = on;
    this.budget.restart();
    this.sim.setOverride('governor', on ? { maxSubstepsPerFrame: this.budget.cap } : null);
  }

  /** Something changed the picture outside the store / input paths: render at full rate for a moment. */
  requestRender(): void {
    this.pacer.poke(performance.now());
  }

  /**
   * Feed one simulated frame's timing to the work budget and apply its cap. The mode (and with it the
   * frame-time target) follows what the user is doing: touching → smooth frames, watching → more sim.
   */
  observeFrameBudget(frameMs: number, info: StepInfo, now: number): void {
    if (!this.adaptiveBudgetOn) return;
    const interacting = now - Math.max(this.lastInputAt, this.pacer.lastCameraMotion) < APP_CONFIG.interactionHoldMs;
    const mode: BudgetMode = this.runner.active ? 'automation' : interacting ? 'interactive' : 'watching';
    const switched = this.budget.setMode(mode);
    const adapted = this.budget.observe(frameMs, info, now, this.store.get().sim.maxSubstepsPerFrame);
    if (switched || adapted) this.sim.setOverride('governor', { maxSubstepsPerFrame: this.budget.cap });
  }

  /**
   * Feed one frame's pacing (interval since the previous frame, and the frame's own work in ms) to the external
   * frame-rate ceiling detector; a change retunes the work budget and the renderer's adaptive quality.
   */
  observeFramePacing(frameMs: number, busyMs: number): void {
    if (!this.frameCeiling.sample(frameMs, busyMs)) return;
    const floor = this.frameCeiling.floorMs;
    this.budget.setFrameFloor(floor);
    (this.renderer as Partial<DelugeRendererAPI> | null)?.setFrameIntervalFloor?.(floor);
    console.info(
      floor > 0
        ? `[deluge] browser paces frames at ~${(1000 / floor).toFixed(0)} fps (power saving); budgets retuned to it`
        : '[deluge] frame-rate ceiling lifted',
    );
  }

  markReady(): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.resolveReady();
  }

  private failReady(err: Error): void {
    if (this.readySettled) return;
    this.readySettled = true;
    this.rejectReady(err);
  }

  /**
   * The GPU device is gone (GPU-process crash or reset). Every texture, buffer and pipeline died with it, so the
   * frame loop stops (it would only spin no-op frames, burning battery, behind a frozen or blank canvas that still
   * looks live) and a full-screen card takes over, reloading the page once. The address bar is pointed at the
   * scene on screen first, so the reload brings back exactly that (not, say, a live area that needs the network).
   */
  private onDeviceLost(info: GPUDeviceLostInfo): void {
    if (this.gpuLost || this.unloading) return;
    this.gpuLost = true;
    this.loop.stop();
    this.runner.cancelAll('the GPU device was lost');
    const details = `GPU device lost (${info.reason ?? 'unknown'}): ${info.message || 'no details'}`;
    this.failReady(new Error(details));
    const shown = this.scenes?.scene?.request;
    if (shown) writeSceneToUrl(shown);
    console.error(`[deluge] ${details} — frame loop stopped`);
    showDeviceLost(details);
  }

  private onSceneReady(scene: Scene): void {
    this.stageRamp.jump(this.store.get().stageOffset);
    this.stagePushed = this.stageRamp.applied;
    this.publishStage(performance.now());
    this.sim.pushAll();
    this.crest.onSceneChanged();
    this.evac.reset();
    this.probe?.reset();
    this.budget.restart();
    this.driver.onSceneChanged(performance.now());
    console.info(
      `[deluge] loaded “${scene.terrain.name}” ${scene.terrain.nx}×${scene.terrain.ny} @ ${scene.terrain.cellSize.toFixed(2)} m`,
    );
  }

  /** The scene running the stability demo is being destroyed: the next solver always starts robust. */
  private exitStabilityDemoQuietly(): void {
    const sim = this.store.get().sim;
    if (sim.stabilityMode !== 'naive') return;
    const cfl = this.preDemoCfl > 0 && this.preDemoCfl <= 1 ? this.preDemoCfl : APP_CONFIG.robustCfl;
    this.stabilityDemo = false;
    this.store.set({ sim: { ...sim, stabilityMode: 'robust', cfl } });
  }

  private frame(realDt: number, now: number, frameMs: number): boolean {
    if (this.resizePending && this.renderer && !document.hidden) {
      this.resizePending = false;
      this.renderer.resize();
      this.pacer.poke(now);
    }
    return this.driver.frame(realDt, now, frameMs);
  }

  /** Coalesce window/canvas/DPR changes into one renderer.resize() at the start of the next frame. */
  private installResizeHandling(): void {
    const mark = () => {
      this.resizePending = true;
    };
    window.addEventListener('resize', mark);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(mark).observe(this.canvas);
    this.resizePending = true;
  }

  /**
   * Wake the render pacer on anything that can change the picture while the sim is paused: user input
   * anywhere (canvas tools, camera, UI controls, shortcuts), store changes other than the HUD stream, and
   * the tab becoming visible again. Input ON THE CANVAS (camera drags, tool strokes, the cursor ring) also
   * marks the user as interacting, which switches the work budget to low-latency mode; hovering panels or
   * dragging a DOM slider does not (that feedback is DOM, and the flood should keep its speed).
   */
  private installActivityTracking(): void {
    const poke = () => this.pacer.poke(performance.now());
    const onInput = (ev: Event) => {
      const now = performance.now();
      if (ev.target === this.canvas) this.lastInputAt = now;
      this.pacer.poke(now);
    };
    const opts: AddEventListenerOptions = { capture: true, passive: true };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel', 'keydown', 'keyup', 'touchstart', 'touchmove']) {
      window.addEventListener(type, onInput, opts);
    }
    document.addEventListener('visibilitychange', poke);
    this.store.subscribe((s, prev) => {
      for (const key in s) {
        const k = key as keyof AppState;
        if (s[k] !== prev[k] && !HUD_ONLY_KEYS.has(k)) {
          poke();
          return;
        }
      }
    });
  }
}

/** The solver's stage follows the ramp in steps of this many meters (or when the ramp arrives). */
const STAGE_PUSH_STEP_M = 0.05;

/** Store keys that only feed DOM readouts; their ~5 Hz updates must not keep the 3D view rendering. */
const HUD_ONLY_KEYS: ReadonlySet<keyof AppState> = new Set<keyof AppState>(['stats', 'stepInfo', 'fps', 'probe', 'error']);
