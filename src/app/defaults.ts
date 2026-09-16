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
   * GPU time budget handed to the solver's own substep limiter (ms). Effectively disabled: the app's
   * frame-time governor (governor.ts) is the work budget. The solver estimates GPU cost per substep as
   * (onSubmittedWorkDone latency) / substeps, and in Chrome that latency is ~70 ms regardless of the work
   * (measured on the M4), so any budget below the latency collapses the solver to 1 substep per frame
   * (~12 sim-s per real second instead of the requested 60).
   */
  solverGpuBudgetMs: 1000,
  /** Input or camera motion within this window counts as "interacting" (smooth-frames work budget). */
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
  };
}

/**
 * Capsule radius (cells) for walls drawn through the debug API: at least 0.8 cells so any diagonal
 * segment rasterizes to a 4-connected (watertight) barrier, and at least ~3 m on the ground.
 */
export function wallRadiusCells(cellSize: number): number {
  return Math.max(0.8, 3 / cellSize);
}
