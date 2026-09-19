import type {
  AppActions,
  AppState,
  CameraPose,
  DelugeDebugAPI,
  FloodRenderer,
  FloodSolver,
  PickResult,
  ScenarioPreset,
  SimStats,
  Store,
  ToolId,
  WaterSource,
} from '../contracts';
import { geoToGrid, gridToGeo } from '../data';
import type { App } from './App';
import { wallRadiusCells } from './defaults';
import { stageOffsetForFeet } from './stage';
import type { WakeLockStatus } from './wakeLock';

/** Sampled scalar field (for automation: e2e scripts pick wall sites, check flooding, etc.). */
export interface GridSample {
  /** Samples per row/column. */
  w: number;
  h: number;
  /** Cells per sample; sample (x, y) covers cells [x·stride, (x+1)·stride) × [y·stride, (y+1)·stride). */
  stride: number;
  /** Row-major w·h values (max over the block for depth/barrier, mean for ground). */
  data: number[];
}

/**
 * Extras beyond the DelugeDebugAPI contract. Non-contract, for automation and debugging only.
 */
export interface DelugeDebugExtras {
  /** The application object itself (diagnostics / profiling only). */
  readonly app: App;
  readonly store: Store;
  readonly actions: AppActions;
  getState(): AppState;
  /** The current solver (concrete type may expose extras such as gpuMsPerSubstep / runSubsteps). */
  getSolver(): FloodSolver | null;
  getRenderer(): FloodRenderer | null;
  /** Frame pacing / work budget diagnostics. */
  getPerf(): {
    fps: number;
    substepCap: number;
    budgetMode: string;
    adaptiveBudget: boolean;
    frames: number;
    animTime: number;
    /** Learned external frame-rate ceiling (ms per frame), 0 = none. */
    frameFloorMs: number;
  };
  /** Enable/disable the frame-time substep governor (benchmarks). */
  setAdaptiveBudget(on: boolean): void;
  selectTool(tool: ToolId): void;
  resetWater(): void;
  isStabilityDemo(): boolean;
  getFps(): number;
  getFrameCount(): number;
  getSimClock(): number;
  getScenario(): ScenarioPreset | null;
  /** Stage offset (m) for a gauge reading in feet, or null if the scenario has no stage control. */
  stageOffsetForFeet(feet: number): number | null;
  /**
   * setStageOffset with options. By default the river rises to the new stage at a limited rate in simulated time
   * (≈ 3.7 sim-min to the 1936 crest); `instant: true` applies it at once (a dam break along every bank).
   */
  setStage(meters: number, opts?: { instant?: boolean }): void;
  /** Stage offset currently applied in the simulation (m) and whether it is still moving toward the slider. */
  getStageApplied(): { applied: number; target: number; moving: boolean };
  geoToGrid(lon: number, lat: number): { gx: number; gy: number } | null;
  gridToGeo(gx: number, gy: number): { lon: number; lat: number } | null;
  sampleGrid(field: 'depth' | 'ground' | 'barrier', stride: number): GridSample | null;
  sampleAt(gx: number, gy: number): { ground: number; barrier: number; depth: number } | null;
  getRoadStatusCounts(): { dry: number; wet: number; flooded: number; total: number } | null;
  pick(cssX: number, cssY: number): PickResult | null;
  /** Screen Wake Lock state (src/app/wakeLock.ts): is the display being held awake right now? */
  getWakeLock(): WakeLockStatus;
  /**
   * The View panel's "Reference (N²)" overlay. Switching it on draws nothing unless the live state is the scenario the
   * reference was computed for — `getReference()` says whether it applies and, when it does not, why.
   */
  setReferenceOverlay(on: boolean): void;
  getReference(): AppState['reference'];
  /** Latest protected-land analysis (src/app/protection.ts) without its mask, and how long it took (ms). */
  getProtection(): { wallCells: number; cells: number; areaM2: number; roadMeters: number; roadEdges: number; level: number | null; ms: number } | null;
  waitFrames(n: number): Promise<void>;
}

export type DelugeDebug = DelugeDebugAPI & DelugeDebugExtras;

declare global {
  interface Window {
    __deluge?: DelugeDebug;
  }
}

/**
 * Build the debug API for an App. `main.ts` exposes it as `window.__deluge` through the forwarding handle
 * (see debugHandle.ts) so automation can await `ready` before the App module has even loaded.
 */
export function createDebugApi(app: App, ready: Promise<void>): DelugeDebug {
  const { store, actions } = app;

  const requireSolver = () => {
    const solver = app.scenes?.scene?.solver;
    if (!solver) throw new Error('No terrain loaded yet (await __deluge.ready)');
    return solver;
  };
  const terrain = () => app.scenes?.scene?.terrain ?? null;

  const api: DelugeDebug = {
    ready,
    errors: app.errors.errors,

    async loadPreset(id) {
      await app.loadScene({ kind: 'preset', id }, { rethrow: true });
    },
    listPresets: () => actions.listPresets().map((p) => p.id),
    setPaused: (paused) => store.set({ paused }),
    setRain: (mmPerHour) => store.set({ sim: { ...store.get().sim, rainRate: Math.max(0, mmPerHour) } }),
    setReferenceOverlay: (on) => store.set({ referenceOn: !!on }),
    getReference: () => store.get().reference,
    setStageOffset: (meters) => store.set({ stageOffset: meters }),
    setStage(meters, opts) {
      if (!Number.isFinite(meters)) return;
      if (opts?.instant) app.setStageNow(meters);
      else store.set({ stageOffset: meters });
    },
    getStageApplied: () => ({ applied: app.stageRamp.applied, target: app.stageRamp.target, moving: app.stageRamp.moving }),
    setTimeScale: (scale) => store.set({ sim: { ...store.get().sim, timeScale: Math.max(0, scale) } }),
    setWaterMode: (mode) => store.set({ render: { ...store.get().render, waterMode: mode } }),

    drawWall(points, height) {
      const solver = requireSolver();
      if (points.length === 0) return;
      const radius = wallRadiusCells(solver.cellSize);
      const segs = points.length === 1 ? [points[0], points[0]] : points;
      for (let k = 0; k + 1 < segs.length; k++) {
        const a = segs[k];
        const b = segs[k + 1];
        solver.applyBrush({ kind: 'wall', ax: a.gx, ay: a.gy, bx: b.gx, by: b.gy, radius, height });
      }
      app.requestRender();
    },

    addSource(source: WaterSource) {
      store.set({ sources: [...store.get().sources, { ...source }] });
    },

    setEvacStart: (p) => store.set({ evacStart: p ? { gx: p.gx, gy: p.gy } : null }),

    setCamera(partial: Partial<CameraPose>) {
      const camera = app.renderer?.camera;
      if (!camera) throw new Error('Renderer not initialized');
      const cur = camera.pose;
      const pose: CameraPose = {
        target: { ...cur.target, ...(partial.target ?? {}) },
        distance: partial.distance ?? cur.distance,
        yaw: partial.yaw ?? cur.yaw,
        pitch: partial.pitch ?? cur.pitch,
      };
      // Assign directly (deterministic for screenshots) and cancel any in-flight fly-to animation.
      camera.pose = pose;
      camera.flyTo(pose, 0.01);
      app.requestRender();
    },

    runFor: (simSeconds) => app.runFor(simSeconds),

    getStats(): SimStats | null {
      const snap = app.scenes?.scene?.solver.getSnapshot();
      return snap ? { ...snap.stats } : store.get().stats;
    },
    getRoute: () => store.get().route,

    // ── extras ────────────────────────────────────────────────────────────────────────────
    app,
    store,
    actions,
    getState: () => store.get(),
    getSolver: () => app.scenes?.scene?.solver ?? null,
    getRenderer: () => app.renderer,
    getPerf: () => ({
      fps: app.loop.fps,
      substepCap: app.budget.cap,
      budgetMode: app.budget.mode,
      adaptiveBudget: app.adaptiveBudget,
      frames: app.driver.frameCount,
      animTime: app.pacer.animTime,
      frameFloorMs: app.frameCeiling.floorMs,
    }),
    setAdaptiveBudget(on) {
      app.adaptiveBudget = on;
    },
    selectTool: (tool) => store.set({ tool }),
    resetWater: () => actions.resetWater(),
    isStabilityDemo: () => store.get().sim.stabilityMode === 'naive',
    getFps: () => app.loop?.fps ?? 0,
    getFrameCount: () => app.driver?.frameCount ?? 0,
    getSimClock: () => app.driver?.simClock ?? 0,
    getScenario: () => store.get().scenario,

    stageOffsetForFeet(feet) {
      const stage = store.get().scenario?.stage;
      return stage ? stageOffsetForFeet(stage, feet) : null;
    },

    geoToGrid(lon, lat) {
      const t = terrain();
      return t ? geoToGrid(t, lon, lat) : null;
    },
    gridToGeo(gx, gy) {
      const t = terrain();
      return t ? gridToGeo(t, gx, gy) : null;
    },

    sampleGrid(field, stride) {
      const solver = app.scenes?.scene?.solver;
      if (!solver) return null;
      const src =
        field === 'ground'
          ? solver.getGroundCPU()
          : field === 'barrier'
            ? solver.getBarrierCPU()
            : solver.getSnapshot()?.depth;
      if (!src) return null;
      return downsample(src, solver.nx, solver.ny, Math.max(1, Math.floor(stride)), field === 'ground' ? 'mean' : 'max');
    },

    sampleAt(gx, gy) {
      const solver = app.scenes?.scene?.solver;
      if (!solver) return null;
      const i = Math.min(solver.nx - 1, Math.max(0, Math.floor(gx)));
      const j = Math.min(solver.ny - 1, Math.max(0, Math.floor(gy)));
      const k = j * solver.nx + i;
      return {
        ground: solver.getGroundCPU()[k],
        barrier: solver.getBarrierCPU()[k],
        depth: solver.getSnapshot()?.depth[k] ?? 0,
      };
    },

    getRoadStatusCounts() {
      const status = app.evac?.roadStatus;
      const net = terrain()?.roads;
      if (!net) return null;
      const counts = { dry: 0, wet: 0, flooded: 0, total: net.edges.length };
      if (!status) {
        counts.dry = net.edges.length;
        return counts;
      }
      for (let k = 0; k < status.length; k++) {
        if (status[k] === 2) counts.flooded++;
        else if (status[k] === 1) counts.wet++;
        else counts.dry++;
      }
      return counts;
    },

    pick: (cssX, cssY) => app.renderer?.pick(cssX, cssY) ?? null,

    getWakeLock: () => ({ ...app.wakeLock.status }),

    getProtection() {
      const r = app.protection.last;
      if (!r) return null;
      const { wallCells, cells, areaM2, roadMeters, roadEdges, level } = r;
      return { wallCells, cells, areaM2, roadMeters, roadEdges, level, ms: app.protection.lastMs };
    },

    waitFrames(n) {
      return new Promise<void>((resolve) => {
        let left = Math.max(1, Math.floor(n));
        const step = () => (--left <= 0 ? resolve() : requestAnimationFrame(step));
        requestAnimationFrame(step);
      });
    },
  };

  return api;
}

function downsample(src: Float32Array, nx: number, ny: number, stride: number, mode: 'max' | 'mean'): GridSample {
  const w = Math.ceil(nx / stride);
  const h = Math.ceil(ny / stride);
  const data = new Array<number>(w * h);
  for (let y = 0; y < h; y++) {
    const j1 = Math.min(ny, (y + 1) * stride);
    for (let x = 0; x < w; x++) {
      const i1 = Math.min(nx, (x + 1) * stride);
      let acc = mode === 'max' ? -Infinity : 0;
      let n = 0;
      for (let j = y * stride; j < j1; j++) {
        const row = j * nx;
        for (let i = x * stride; i < i1; i++) {
          const v = src[row + i];
          if (mode === 'mean') acc += v;
          else if (Number.isNaN(v)) acc = NaN; // NaN is sticky: a blown-up block reports NaN
          else if (v > acc) acc = v;
          n++;
        }
      }
      data[y * w + x] = mode === 'max' ? acc : acc / n;
    }
  }
  return { w, h, stride, data };
}
