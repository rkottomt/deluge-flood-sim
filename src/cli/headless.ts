/**
 * One scenario on the GPU, headless, in Node — the batch CLI's equivalent of the app's headless runs (Site check
 * sweeps, ensembles; src/ui/headless.ts), built from the app's own parts so the flood is the browser's flood:
 *
 *   • the store (src/app/store.ts) holding the scenario's forcing exactly as the app keeps it;
 *   • SimSync (store → solver: params, sources, storms, the climate layer's scaling), StageLevels and the StageRamp
 *     (the river rises at 3 m per simulated minute), CrestFill (connected river channels lifted with the stage) and the
 *     ClimateLayer (future rain, inflows, sea level) — the same classes App wires together;
 *   • the solver created with the app's solver options (APP_CONFIG.solverOptions), the scenario's initial water and
 *     its rheology (applyScenarioRheology);
 *   • the frame loop of a runFor-only run (src/app/driver.ts with the user's flood paused): 1/60 s of wall time per
 *     frame at the runFor time scale (3600×), every frame capped so the run ends exactly on its target
 *     (FloodSolver.step's maxSimSeconds), frames ending on the RAMP_FRAME_S grid while the stage ramps, the stage pushed
 *     to the solver in ≥ 5 cm steps (App.advanceStage).
 *
 * ONE DIFFERENCE, ON PURPOSE: readbacks. In the browser a readback of the water lands every 300 ms of WALL time, and
 * its maxima steer the CFL timestep — so two runs of the same scenario take different timestep sequences and agree only
 * to a few mm of depth and a few % of d·v (tests/sim/exactStop.test.ts measures it). Here readbacks happen on a grid of
 * SIMULATED time (every `readbackEveryS`, 60 s by default), at most two frames are queued on the GPU (the solver's
 * backlog guard never skips one), and nothing from the scene's load is still in flight when a case starts — so the
 * timestep sequence is a function of the inputs alone: the same command gives bit-identical rasters and the same
 * numbers every time on the same machine (tests/cli/smoke.test.ts runs a sweep twice and compares).
 * `appCadence: true` restores the browser's wall-clock readbacks for a like-for-like comparison.
 */
import type { AppState, FloodSolver, HazardFields, SimSnapshot, StormCell, Store, TerrainData, WaterSource } from '../contracts';
import { createStore } from '../app/store';
import { APP_CONFIG, createInitialState } from '../app/defaults';
import { cloneScenarioLists, StageLevels } from '../app/stage';
import { StageRamp } from '../app/stageRamp';
import { SimSync } from '../app/simSync';
import { CrestFill } from '../app/crest';
import { ClimateLayer } from '../app/climate';
import { ErrorReporter } from '../app/errors';
import { applyScenarioRheology } from '../app/scene';
import { rampFrameLimit, RUN_TARGET_EPSILON_S } from '../app/runFor';
import { computeInitialWater } from '../data/initialWater';
import { climateForcing, type ClimateForcing } from '../climate/apply';
import { CLIMATE_TODAY, type ClimateSelection } from '../climate/scenarios';
import { createSolver, type GpuFloodSolver } from '../sim';
import { setupChain, type ChainSetup } from './chain';

/** App.advanceStage: the solver gets the new stage when it has moved this much (or arrived), m. */
const STAGE_PUSH_STEP_M = 0.05;
/** Wall seconds per frame of a runFor run (the app's frames at 60 Hz). */
const FRAME_REAL_DT = 1 / 60;
/** Frames in a row that advance nothing before the run is declared stalled. */
const MAX_IDLE_FRAMES = 2000;
/** Default simulated seconds between the deterministic readbacks. */
export const READBACK_EVERY_S = 60;

export interface HeadlessSceneOptions {
  /** Preset id (drives the climate profile, the ladders and the debris-flow rule); null for an ad-hoc terrain. */
  presetId: string | null;
  climate?: ClimateSelection;
  /** Reads a JSON file baked next to the preset's meta.json (chain presets need chain.json). */
  readPresetJson?: (file: string) => unknown;
  /** Simulated seconds between readbacks (deterministic mode). */
  readbackEveryS?: number;
  /** Use the browser's 300 ms wall-clock readback cadence instead (repeats then differ in the last digits). */
  appCadence?: boolean;
  /** Substep cap per frame (SimParams.maxSubstepsPerFrame; the app's default 120). */
  maxSubstepsPerFrame?: number;
}

/** The parts of the forcing a run may change (the store's own fields; undefined = leave as is). */
export interface ForcingPatch {
  stageOffset?: number;
  rainRate?: number;
  manningN?: number;
  sources?: WaterSource[];
  storms?: StormCell[];
}

export interface RunProgress {
  simTime: number;
  target: number;
  frames: number;
  substeps: number;
}

export class HeadlessScene {
  readonly store: Store;
  readonly errors = new ErrorReporter();
  readonly stage = new StageLevels();
  readonly ramp = new StageRamp();
  readonly sim: SimSync;
  readonly crest: CrestFill;
  climate!: ClimateLayer;
  /** Simulated seconds since the last water reset (the driver's simClock). */
  simClock = 0;
  frames = 0;
  substeps = 0;
  private stagePushed = 0;
  private disposed = false;
  private readonly readbackEveryS: number;

  private constructor(
    readonly device: GPUDevice,
    readonly terrain: TerrainData,
    readonly solver: GpuFloodSolver,
    readonly initialWater: Float32Array,
    readonly presetId: string | null,
    readonly chain: ChainSetup | null,
    opts: HeadlessSceneOptions,
  ) {
    this.readbackEveryS = opts.readbackEveryS && opts.readbackEveryS > 0 ? opts.readbackEveryS : READBACK_EVERY_S;
    const state = createInitialState();
    this.store = createStore({ ...state, loading: null, paused: true, sim: { ...state.sim, maxSubstepsPerFrame: opts.maxSubstepsPerFrame ?? state.sim.maxSubstepsPerFrame } });
    this.sim = new SimSync({
      store: this.store,
      stage: this.stage,
      errors: this.errors,
      getSolver: () => (this.disposed ? null : this.solver),
      getAppliedStageOffset: () => this.ramp.applied + this.climate.stageShift,
      onRouteInputsChanged: () => {},
      getClimate: () => this.climate.get(),
    });
    this.crest = new CrestFill({
      store: this.store,
      errors: this.errors,
      getScene: () => (this.disposed ? null : { solver: this.solver as FloodSolver, initialWater: this.initialWater }),
      getStageOffset: () => this.ramp.applied + this.climate.stageShift,
      onWaterReset: () => {
        this.simClock = 0;
      },
    });
  }

  /**
   * Build the solver for `terrain` and apply its scenario the way SceneManager.load + App.onSceneReady do (and, on a
   * chain preset, HazardChainController: the routed wave replaces the entry inflow).
   */
  static async create(device: GPUDevice, terrain: TerrainData, opts: HeadlessSceneOptions): Promise<HeadlessScene> {
    const climateSel = opts.climate ?? { ...CLIMATE_TODAY };
    const base = terrain.scenario;
    // The chain preset's lake grows with the climate (ClimateForcing.lake → HazardChainController.setClimateVolumeFactor).
    const forcing0 = climateForcing(climateSel, opts.presetId, base);
    const chain = base?.hazardChain && opts.readPresetJson ? setupChain(base, opts.readPresetJson, forcing0.lake?.volumeFactor ?? 1) : null;
    const scenario = chain?.scenario ?? base;

    const state = createInitialState();
    const options = { ...APP_CONFIG.solverOptions, ...(opts.appCadence ? {} : { readbackIntervalMs: 1e9 }) };
    const solver = await createSolver(device, { nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize, elevation: terrain.elevation }, state.sim, options);
    let scene: HeadlessScene;
    try {
      const initialWater = computeInitialWater(terrain, terrain.scenario);
      solver.setInitialWater(initialWater);
      applyScenarioRheology(solver, terrain.scenario);
      scene = new HeadlessScene(device, terrain, solver, initialWater, opts.presetId, chain, opts);
    } catch (err) {
      solver.destroy();
      throw err;
    }
    // SceneManager.applyScenario: the scenario's lists into the store, stage bases at offset 0.
    const lists = cloneScenarioLists(scenario);
    scene.stage.resetFrom(lists.sources);
    const s = scene.store.get();
    scene.store.set({
      presetId: opts.presetId,
      terrainName: terrain.name,
      attribution: terrain.attribution,
      scenario,
      grid: { nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize },
      sources: lists.sources,
      storms: lists.storms,
      shelters: lists.shelters,
      stageOffset: 0,
      climate: climateSel,
      sim: { ...s.sim, rainRate: scenario?.rainRate ?? 0 },
    });
    // App.init: the climate layer, store → solver sync, and the stage ramp following the slider target.
    scene.climate = new ClimateLayer({ store: scene.store, onChange: (next, prev) => scene.onClimateChange(next, prev) });
    scene.climate.install();
    scene.sim.install();
    scene.store.subscribe((st, prev) => {
      if (st.stageOffset !== prev.stageOffset) scene.ramp.setTarget(st.stageOffset);
    });
    // App.onSceneReady.
    scene.ramp.jump(scene.store.get().stageOffset);
    scene.stagePushed = scene.ramp.applied;
    scene.sim.pushAll();
    scene.crest.onSceneChanged();
    scene.crest.prewarm();
    // afterLoading: the climate's sea-level rise lifts the connected water once the scene is up.
    scene.pushStage();
    // Nothing from the load may still be in flight when the first case starts (a late readback of the scene's first
    // reset would race the case's own).
    await solver.flush();
    return scene;
  }

  /** The climate forcing in force (ClimateLayer). */
  get climateForcing(): ClimateForcing {
    return this.climate.get();
  }

  get state(): AppState {
    return this.store.get();
  }

  /**
   * Set the scenario the way a user does in the app: the river-stage slider separately from everything else. `sources`
   * carry the stage sources at their NORMAL levels (offset 0, as in the preset); `stageOffset` is the slider's target,
   * m above normal pool.
   *
   * The order matters because of StageLevels: a new `sources` list is authoritative and its stage levels are read as
   * already including the store's current offset (SimSync). So the slider goes to 0 first, the lists are set (their
   * levels are then the bases), and the slider goes to its target — which rewrites the stage levels from those bases.
   */
  setForcing(f: ForcingPatch): void {
    const s = this.store.get();
    const patch: Partial<AppState> = {};
    if (f.sources) patch.sources = f.sources;
    if (f.storms) patch.storms = f.storms;
    if (f.rainRate !== undefined || f.manningN !== undefined) {
      patch.sim = { ...s.sim, ...(f.rainRate !== undefined ? { rainRate: f.rainRate } : {}), ...(f.manningN !== undefined ? { manningN: f.manningN } : {}) };
    }
    if (f.sources) this.store.set({ stageOffset: 0 });
    this.store.set(patch);
    if (f.stageOffset !== undefined) this.store.set({ stageOffset: f.stageOffset });
  }

  /**
   * One store patch, exactly as given — what src/ui/ensemble.ts does for a member (sources, storms, stage, rain and n in
   * a single set; its stage levels are then read at the new offset, as in the app).
   */
  applyPatch(patch: Partial<AppState>): void {
    this.store.set(patch);
  }

  /** actions.resetWater: the river back to normal pool (it rises to the target stage again), water from the start. */
  resetWater(): void {
    this.ramp.restartFrom(0);
    this.pushStage();
    if (!this.crest.resetWater()) throw new Error('no solver');
    this.simClock = 0;
  }

  /**
   * Advance exactly `seconds` of simulated time (App.runFor with the flood paused). Resolves once the solver has
   * stopped on the target and the GPU is idle.
   */
  async runFor(seconds: number, onProgress?: (p: RunProgress) => void): Promise<void> {
    if (!(seconds >= 0) || !Number.isFinite(seconds)) throw new Error(`runFor: invalid simulated time ${seconds}`);
    const { solver } = this;
    this.sim.setOverride('runFor', { timeScale: APP_CONFIG.runForTimeScale });
    try {
      // The reset's own readback first, so it cannot land mid-run (tests/sim/exactStop.test.ts does the same).
      await solver.flush();
      const target = this.simClock + seconds;
      let nextReadback = this.simClock + this.readbackEveryS;
      let idle = 0;
      let previous: Promise<unknown> = Promise.resolve();
      const scale = this.sim.effectiveParams().timeScale;
      while (target - this.simClock > RUN_TARGET_EPSILON_S) {
        let limit = Math.min(target - this.simClock, nextReadback - this.simClock);
        if (this.ramp.moving) limit = Math.min(limit, rampFrameLimit(this.simClock));
        const info = solver.step(FRAME_REAL_DT, limit);
        // A blown-up solver may report NaN: count the requested time so the run cannot hang (driver.ts).
        const requested = Math.min(FRAME_REAL_DT * scale, limit);
        const advance = Number.isFinite(info.simSecondsAdvanced) ? info.simSecondsAdvanced : requested;
        this.simClock += advance;
        this.frames++;
        this.substeps += info.substeps;
        this.advanceStage(advance);
        // At most two frames on the GPU (this one and the one before): the CPU encodes the next frame while the GPU runs
        // this one, and the solver's backlog guard (three frames queued) never skips a frame, so stepping is a function
        // of the state alone.
        const submitted = this.device.queue.onSubmittedWorkDone();
        await previous;
        previous = submitted;
        if (this.simClock >= nextReadback - RUN_TARGET_EPSILON_S) {
          await solver.readbackNow();
          nextReadback += this.readbackEveryS;
        }
        if (advance > 0) idle = 0;
        else if (++idle > MAX_IDLE_FRAMES) throw new Error(`the solver stopped advancing at ${this.simClock.toFixed(1)} s of ${target.toFixed(1)} s`);
        onProgress?.({ simTime: this.simClock, target, frames: this.frames, substeps: this.substeps });
      }
      await solver.flush();
    } finally {
      this.sim.setOverride('runFor', null);
    }
  }

  /** The hazard accumulators (max depth, speed, d·v, arrival, wet time) and a snapshot of where the run stopped. */
  async read(): Promise<{ fields: HazardFields; snapshot: SimSnapshot }> {
    const fields = await this.solver.readHazardFields();
    const snapshot = await this.solver.readbackNow();
    return { fields, snapshot };
  }

  /** Bare-earth ground as the solver has it (bed perturbations included). */
  ground(): Float32Array {
    return this.solver.getGroundCPU();
  }

  /** An ensemble member's DEM error (FloodSolver.setBedPerturbation); null removes it. Reset the water afterwards. */
  setBedPerturbation(delta: Float32Array | null): void {
    this.solver.setBedPerturbation(delta);
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sim.dispose();
    this.climate?.dispose();
    this.crest.onSceneChanged();
    this.solver.destroy();
  }

  // ─── App.advanceStage / pushStage / onClimateChange ──────────────────────────────────────────────────────────────

  private advanceStage(simSeconds: number): void {
    const ramp = this.ramp;
    if (!ramp.advance(simSeconds)) return;
    if (Math.abs(ramp.applied - this.stagePushed) >= STAGE_PUSH_STEP_M || !ramp.moving) this.pushStage();
  }

  private pushStage(): void {
    const offset = this.ramp.applied;
    this.stagePushed = offset;
    this.sim.pushSources();
    this.crest.onStageOffset(offset + this.climate.stageShift);
  }

  private onClimateChange(next: ClimateForcing, prev: ClimateForcing): void {
    this.sim.pushParams();
    this.sim.pushStorms();
    if (next.seaRiseM !== prev.seaRiseM) this.pushStage();
    else this.sim.pushSources();
  }
}
