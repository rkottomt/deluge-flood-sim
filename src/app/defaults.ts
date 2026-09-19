import { DEFAULT_SIM_PARAMS, type AppState } from '../contracts';

/** Tuning constants for the application loop. */
export const APP_CONFIG = {
  /** Real seconds per frame are clamped to this (tab switches, GC pauses, breakpoints). */
  maxRealDt: 0.1,
  /**
   * rAF callbacks closer together than this are skipped: caps work at 60 Hz on 90/120 Hz displays
   * (4 ms of slack so a 60 Hz display with jitter never drops frames).
   */
  minFrameIntervalMs: 1000 / 60 - 4,
  /**
   * Solver tunables beyond the SimParams contract (4th createSolver argument, see src/contracts.ts):
   *
   *  • gpuBudgetMs — Infinity switches the solver's own per-frame GPU budget (and its timestamp-query readbacks) off:
   *    the app's work budget (governor.ts) owns pacing because it sees what the user feels — frame time AND GPU queue
   *    latency including the renderer — and it picks a different trade-off per interaction mode. Two independent
   *    controllers over the same GPU would fight (each backs off when the other's work shows up).
   */
  solverOptions: { gpuBudgetMs: Infinity },
  /**
   * While hands-off, a GPU-limited solver whose work budget is down to this many substeps per frame counts as starved:
   * the renderer's adaptive quality then steps down a little (see SimPressure in src/render/quality.ts).
   */
  starvedSubsteps: 3,
  /** Canvas input or camera motion within this window counts as "interacting" (low-latency work budget). */
  interactionHoldMs: 1500,
  /** Store updates that drive the HUD (stats, stepInfo, fps) are throttled to this interval. */
  hudIntervalMs: 200,
  /** Road flood status + evacuation route recomputation interval (≤ 4 Hz). */
  routeIntervalMs: 250,
  /** Smoothing factor of the frame-time exponential moving average. */
  fpsEmaAlpha: 0.08,
  /** Stability demo ("Break it") settings. */
  stabilityDemoCfl: 1.8,
  robustCfl: 0.7,
  /** Sim speed used by the debug API's runFor(). */
  runForTimeScale: 3600,
  /** Default grid resolution for ?live= areas. */
  liveResolution: 1024 as const,
  defaultPreset: 'pittsburgh',
  fallbackPreset: 'sandbox',
  /**
   * A ?live= startup load falls back to the offline default preset when its download makes no progress for this
   * long, or has not finished after the deadline (a healthy 1024² area loads in well under 15 s). The stall limit
   * stays above the optional-download grace (LIVE_EXTRAS_GRACE_MS, 25 s: while Esri renders an export no bytes arrive), and the
   * deadline above the elevation download plus that grace.
   */
  startupLiveStallMs: 27_000,
  startupLiveDeadlineMs: 45_000,
};

/** The initial application state before any terrain is loaded. */
export function createInitialState(): AppState {
  return {
    presetId: null,
    terrainName: '',
    attribution: '',
    loading: { message: 'Starting WebGPU…', progress: 0 },
    error: null,
    paused: false,
    tool: 'orbit',
    wallHeight: 2,
    brushRadius: 30,
    inflowDischarge: 500,
    stormIntensity: 80,
    sim: { ...DEFAULT_SIM_PARAMS },
    stageOffset: 0,
    stageOffsetApplied: 0,
    render: {
      waterMode: 'realistic',
      verticalExaggeration: 1.5,
      showImagery: true,
      showRoads: true,
      showContours: false,
    },
    sources: [],
    storms: [],
    shelters: [],
    evacStart: null,
    scenario: null,
    grid: null,
    stats: null,
    stepInfo: null,
    fps: 0,
    route: null,
    probe: null,
    panels: { howItWorks: false, locationPicker: false, help: false },
    gpuInfo: '',
    reference: null,
    referenceOn: false,
  };
}

/**
 * Capsule radius (cells) for walls drawn through the debug API: at least 0.8 cells so any diagonal
 * segment rasterizes to a 4-connected (watertight) barrier, and at least ~3 m on the ground.
 */
export function wallRadiusCells(cellSize: number): number {
  return Math.max(0.8, 3 / cellSize);
}
