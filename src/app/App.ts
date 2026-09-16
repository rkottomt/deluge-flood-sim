import type { AppActions, FloodRenderer, FloodSolver, ToolController } from '../contracts';
import { createDelugeDevice, type DelugeGPU } from '../gpu';
import { createRenderer } from '../render';
import { createRouter } from '../routing';
import { createToolController, mountUI } from '../ui';
import { createActions } from './actions';
import { createDebugApi, type DelugeDebug } from './debugApi';
import { APP_CONFIG, createInitialState } from './defaults';
import { FrameDriver } from './driver';
import { errorMessage, ErrorReporter } from './errors';
import { EvacController } from './evac';
import { FrameLoop } from './loop';
import { ProbeSampler } from './probe';
import { RunForScheduler } from './runFor';
import { SceneManager, SupersededLoadError, type Scene } from './scene';
import { SimSync } from './simSync';
import { StageLevels } from './stage';
import { createStore } from './store';
import { WebGPUUnavailableError } from './unsupported';
import { parseStartupRequest, writeSceneToUrl, type SceneRequest } from './url';

export type LoadOutcome = 'ok' | 'failed' | 'superseded';

/**
 * Application orchestrator: creates the GPU device, renderer, router, UI and tool controller, owns the
 * current scene (terrain + solver), and runs the frame loop. The heavy lifting lives in focused helpers:
 *   SceneManager (load sequence) · SimSync (store → solver) · FrameDriver (per-frame work) ·
 *   EvacController (routing) · RunForScheduler (automation) · createActions · installDebugApi.
 */
export class App {
  readonly store = createStore(createInitialState());
  readonly errors = new ErrorReporter();
  readonly stage = new StageLevels();
  readonly runner = new RunForScheduler();
  readonly router = createRouter();
  readonly evac: EvacController;
  readonly sim: SimSync;
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
  private resizePending = true;

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
      onRouteInputsChanged: () => this.evac.recomputeRoute(),
    });
    this.driver = new FrameDriver(this);
    this.loop = new FrameLoop(
      (dt, now) => this.frame(dt, now),
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
    this.errors.attachDevice(gpu.device);
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
      onSceneCleared: () => this.evac.reset(),
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
    this.installResizeHandling();
    this.store.subscribe((s, prev) => {
      if (s.sim.stabilityMode !== prev.sim.stabilityMode) this.stabilityDemo = s.sim.stabilityMode === 'naive';
    });
    this.loop.start();
  }

  private async loadInitial(): Promise<void> {
    const { request, warnings } = parseStartupRequest(window.location.search);
    for (const w of warnings) {
      console.warn(`[deluge] ${w}`);
      this.errors.toast(w, true);
    }
    const outcome = await this.loadScene(request);
    if (outcome === 'failed' && !this.scenes?.scene) {
      this.failReady(new Error('No terrain could be loaded (preset and offline sandbox both failed)'));
    }
  }

  /**
   * Load a scene. On failure the error is reported and, if no scene is left to show (initial load, or the
   * old scene was already torn down), the offline sandbox is loaded instead. With `rethrow` (debug API)
   * the original error is re-thrown after the fallback.
   */
  async loadScene(request: SceneRequest, opts: { rethrow?: boolean; fallback?: boolean } = {}): Promise<LoadOutcome> {
    const scenes = this.scenes;
    if (!scenes) {
      const err = new Error('App is not started (WebGPU unavailable?)');
      if (opts.rethrow) throw err;
      return 'failed';
    }
    this.exitStabilityDemoQuietly();
    try {
      await scenes.load(request);
      // An automatic fallback keeps the address bar on what the user asked for (reload retries it).
      if (!opts.fallback) writeSceneToUrl(request);
      return 'ok';
    } catch (err) {
      if (err instanceof SupersededLoadError) {
        if (opts.rethrow) throw err;
        return 'superseded';
      }
      const msg = `Could not load ${SceneManager.label(request)}: ${errorMessage(err)}`;
      this.errors.report('load', msg, err);
      const isFallback = request.kind === 'preset' && request.id === APP_CONFIG.fallbackPreset;
      if (!scenes.scene && !isFallback) {
        this.errors.toast(`${msg} — loading the offline sandbox instead.`, true);
        await this.loadScene({ kind: 'preset', id: APP_CONFIG.fallbackPreset }, { fallback: true });
      }
      if (opts.rethrow) throw err;
      return 'failed';
    }
  }

  runFor(simSeconds: number): Promise<void> {
    const run = this.runner.start(simSeconds, performance.now());
    this.sim.setOverrides({ timeScale: APP_CONFIG.runForTimeScale });
    const restore = () => {
      if (!this.runner.active) this.sim.setOverrides({});
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

  private onSceneReady(scene: Scene): void {
    this.sim.pushAll();
    this.evac.reset();
    this.probe?.reset();
    this.driver.onSceneChanged(performance.now());
    console.info(
      `[deluge] loaded “${scene.terrain.name}” ${scene.terrain.nx}×${scene.terrain.ny} @ ${scene.terrain.cellSize.toFixed(2)} m`,
    );
  }

  /** A newly loaded scene always starts with the robust solver. */
  private exitStabilityDemoQuietly(): void {
    const sim = this.store.get().sim;
    if (sim.stabilityMode !== 'naive') return;
    const cfl = this.preDemoCfl > 0 && this.preDemoCfl <= 1 ? this.preDemoCfl : APP_CONFIG.robustCfl;
    this.stabilityDemo = false;
    this.store.set({ sim: { ...sim, stabilityMode: 'robust', cfl } });
  }

  private frame(realDt: number, now: number): void {
    if (this.resizePending && this.renderer) {
      this.resizePending = false;
      this.renderer.resize();
    }
    this.driver.frame(realDt, now);
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
}
