import type {
  CameraPose,
  EvacuationRouter,
  FloodRenderer,
  FloodSolver,
  PresetInfo,
  ProgressFn,
  SimParams,
  SolverTerrainInput,
  Store,
  TerrainData,
} from '../contracts';
import { computeInitialWater, listPresets, loadLiveArea, loadPreset } from '../data';
import { createSolver } from '../sim';
import { APP_CONFIG } from './defaults';
import { cloneScenarioLists, type StageLevels } from './stage';
import type { SceneRequest } from './url';

/** A fully bound terrain + solver pair. */
export interface Scene {
  request: SceneRequest;
  terrain: TerrainData;
  solver: FloodSolver;
}

/** Thrown by a load that was overtaken by a newer load request. Callers should ignore it silently. */
export class SupersededLoadError extends Error {
  constructor() {
    super('Load superseded by a newer request');
    this.name = 'SupersededLoadError';
  }
}

export interface SceneManagerDeps {
  device: GPUDevice;
  store: Store;
  renderer: FloodRenderer;
  router: EvacuationRouter;
  stage: StageLevels;
  /** Old scene is about to be destroyed: stop using its solver. */
  onSceneCleared(): void;
  /** New scene is bound to renderer/router and its scenario applied to the store. */
  onSceneReady(scene: Scene): void;
}

/** Share of the loading bar used by data fetching; the rest covers solver creation and binding. */
const DATA_PROGRESS_SHARE = 0.85;

/**
 * Owns the current Scene and runs the terrain load sequence. Concurrent loads are guarded by a
 * monotonically increasing token: after every await a load checks it is still the latest request, and
 * a stale load cleans up after itself and throws SupersededLoadError.
 */
export class SceneManager {
  private token = 0;
  private current: Scene | null = null;

  constructor(private readonly deps: SceneManagerDeps) {}

  get scene(): Scene | null {
    return this.current;
  }

  /** Human label for a request (for loading messages and errors). */
  static label(request: SceneRequest): string {
    if (request.kind === 'live') {
      const { center, sizeMeters, name } = request.req;
      return name ?? `${center.lat.toFixed(3)}, ${center.lon.toFixed(3)} (${(sizeMeters / 1000).toFixed(1)} km)`;
    }
    try {
      return listPresets().find((p: PresetInfo) => p.id === request.id)?.name ?? `preset “${request.id}”`;
    } catch {
      return `preset “${request.id}”`;
    }
  }

  async load(request: SceneRequest): Promise<Scene> {
    const token = ++this.token;
    const { store, device, renderer, router } = this.deps;
    const label = SceneManager.label(request);
    const isCurrent = () => token === this.token;
    const progress: ProgressFn = (message, fraction) => {
      if (!isCurrent()) return;
      const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
      store.set({ loading: { message, progress: f * DATA_PROGRESS_SHARE } });
    };

    store.set({ loading: { message: `Loading ${label}…`, progress: 0 } });
    /** Solver created by this load but not yet owned by a Scene (destroyed if the load fails). */
    let pending: FloodSolver | null = null;
    try {
      // 1. Terrain data (network / decode). The previous scene keeps rendering meanwhile.
      const terrain =
        request.kind === 'preset' ? await loadPreset(request.id, progress) : await loadLiveArea(request.req, progress);
      if (!isCurrent()) throw new SupersededLoadError();
      validateTerrain(terrain);

      // 2. Tear down the old scene before allocating the new solver (large grids are GPU-memory heavy).
      store.set({ loading: { message: 'Building GPU solver…', progress: 0.88 } });
      this.clear();

      const solver = await createSolverWithOptions(device, terrain, store.get().sim);
      pending = solver;
      if (!isCurrent()) throw new SupersededLoadError();

      // 3. Initial condition: rivers and lakes start full.
      store.set({ loading: { message: 'Filling rivers…', progress: 0.93 } });
      const initialWater = computeInitialWater(terrain, terrain.scenario);
      solver.setInitialWater(initialWater);

      // 4. Bind renderer + router.
      renderer.setScene(terrain, solver);
      bindRouter(router, terrain, initialWater);

      const scene: Scene = { request, terrain, solver };
      this.current = scene;
      pending = null; // ownership transferred to the scene

      // 5. Scenario → store (subscriptions + onSceneReady push it into the solver).
      this.applyScenario(scene);
      this.frameCamera(terrain);
      this.deps.onSceneReady(scene);
      store.set({ loading: null });
      return scene;
    } catch (err) {
      pending?.destroy();
      if (isCurrent()) store.set({ loading: null });
      throw err;
    }
  }

  /** Destroy the current scene (renderer must not be asked to render it afterwards). */
  clear(): void {
    const old = this.current;
    if (!old) return;
    this.current = null;
    this.deps.onSceneCleared();
    old.solver.destroy();
  }

  private applyScenario(scene: Scene): void {
    const { store, stage } = this.deps;
    const { terrain, request } = scene;
    const scenario = terrain.scenario;
    const lists = cloneScenarioLists(scenario);
    // Scenario levels are the bases; offset starts at 0 so store levels === bases.
    stage.resetFrom(lists.sources);
    const s = store.get();
    store.set({
      presetId: request.kind === 'preset' ? request.id : null,
      terrainName: terrain.name,
      attribution: terrain.attribution,
      scenario,
      grid: { nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize },
      sources: lists.sources,
      storms: lists.storms,
      shelters: lists.shelters,
      stageOffset: 0,
      sim: { ...s.sim, rainRate: scenario?.rainRate ?? 0 },
      evacStart: null,
      route: null,
      stats: null,
      stepInfo: null,
      probe: null,
    });
  }

  private frameCamera(terrain: TerrainData): void {
    const camera = this.deps.renderer.camera;
    const pose = terrain.scenario?.camera;
    if (!pose) {
      camera.frameAll();
      return;
    }
    // Cinematic fly-in: start wider, higher and slightly rotated, then settle on the scenario framing.
    const intro: CameraPose = {
      target: { ...pose.target },
      distance: pose.distance * 1.7,
      yaw: pose.yaw - 0.35,
      pitch: Math.min(Math.PI / 2 - 0.05, pose.pitch + 0.25),
    };
    camera.pose = intro;
    camera.flyTo({ ...pose, target: { ...pose.target } }, 2.2);
  }
}

/** Bind the road network; the standing water at load is the baseline so bridges over full rivers aren't "flooded". */
function bindRouter(router: EvacuationRouter, terrain: TerrainData, initialWater: Float32Array): void {
  router.setNetwork(terrain.roads, terrain.cellSize, { nx: terrain.nx, ny: terrain.ny });
  router.setBaselineWater?.(initialWater, terrain.nx, terrain.ny);
}

/**
 * createSolver with the app's solver options (APP_CONFIG.solverOptions). The 4th `options` argument is an
 * extra of src/sim beyond the contract factory signature; it is passed through a loose signature so the app
 * still compiles (and the options are simply ignored) against a contract-only implementation.
 */
function createSolverWithOptions(device: GPUDevice, terrain: TerrainData, params: SimParams): Promise<FloodSolver> {
  const create = createSolver as unknown as (
    device: GPUDevice,
    terrain: SolverTerrainInput,
    params?: Partial<SimParams>,
    options?: Record<string, unknown>,
  ) => Promise<FloodSolver>;
  return create(device, terrain, params, { ...APP_CONFIG.solverOptions });
}

function validateTerrain(t: TerrainData): void {
  const problems: string[] = [];
  if (!(t.nx > 0 && t.nx % 16 === 0)) problems.push(`nx=${t.nx} is not a positive multiple of 16`);
  if (!(t.ny > 0 && t.ny % 16 === 0)) problems.push(`ny=${t.ny} is not a positive multiple of 16`);
  if (!(t.cellSize > 0)) problems.push(`cellSize=${t.cellSize} must be > 0`);
  if (!t.elevation || t.elevation.length !== t.nx * t.ny)
    problems.push(`elevation length ${t.elevation?.length} ≠ nx·ny = ${t.nx * t.ny}`);
  if (problems.length) throw new Error(`Invalid terrain “${t.name}”: ${problems.join('; ')}`);
}
