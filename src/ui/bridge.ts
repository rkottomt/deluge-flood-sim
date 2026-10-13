/**
 * UI-internal channel between the two entry points the app creates separately: mountUI (the DOM) and
 * createToolController (canvas input — the only part of the UI that sees the terrain and the solver).
 *
 * It is keyed by the Store both receive, so it needs no contract change. It carries
 *  • hover: the ground under the cursor (for live "will this wall hold?" checks in the options card),
 *  • notices: neutral / warning / success toasts that are NOT errors (limits, guidance, overtopped walls),
 *  • scene access: terrain, solver and camera getters (for one-click suggestions such as an evacuation start),
 *  • walls: a wall was drawn by the user, the latest check of the drawn walls against the water, and the land they
 *    keep dry (published by the app, see src/app/protection.ts),
 *  • the glacier hazard chain: the routed run behind a chain preset's inflow and the control to re-run it (published by
 *    src/app/hazardChain.ts, drawn by chainPanel.ts, chainTimeline.ts and the top bar's event clock).
 */
import type { CameraController, FloodSolver, Store, TerrainData } from '../contracts';
import type { WallStatus } from './wallCheck';
import type { ChainFile, HazardChainSpec } from '../hazard/types';
import type { ChainOverrides, ChainRunResult, EnsembleMember, EnsembleResult } from '../hazard/chain';
import type { Sensor, WarningObjective } from '../hazard/warning';
import type { AssetTally, EnsembleRanges, EnsembleSummary, MemberResult } from '../loss/ensemble';
import type { PortfolioAsset } from '../loss/portfolio';

/** Terrain under the cursor while a tool that cares about it is active. */
export interface HoverInfo {
  gx: number;
  gy: number;
  /** Bare ground elevation, m (without walls). */
  ground: number;
  /** Wall height above the ground at this cell, m. */
  barrier: number;
  /** Water depth from the latest snapshot, m (0 if unknown). */
  depth: number;
}

export type NoticeKind = 'info' | 'warn' | 'success';

export interface Notice {
  kind: NoticeKind;
  title: string;
  message: string;
  /** Optional one-click follow-up shown as a button in the toast. */
  action?: { label: string; run(): void };
  /** Notices with the same key replace each other instead of re-animating (e.g. repeated limit clicks). */
  key?: string;
  /** Auto-dismiss after this many ms (default 7000). */
  durationMs?: number;
}

export interface SceneAccess {
  getTerrain(): TerrainData | null;
  getSolver(): FloodSolver | null;
  /** The renderer's camera (null before the renderer exists). */
  getCamera?(): CameraController | null;
  /**
   * Raise walls as if the user had drawn them (the wall checks and overtopping notices watch them; wallDrawn fires).
   * `radius` in cells; defaults to the wall tool's width.
   */
  buildWalls?(segments: WallSegment[], radius?: number): void;
}

/** Land the walls on the map keep dry right now (src/app/protection.ts). */
export interface ProtectionSummary {
  /** Cells carrying a wall. */
  wallCells: number;
  /** Land that would stand ≥ 0.3 m under water without the walls and does not with them, m². */
  areaM2: number;
  /** Road length on that land, m, and the number of road segments. */
  roadMeters: number;
  roadEdges: number;
  /** Highest water level held back, m (null when no water presses on a wall yet). */
  level: number | null;
}

/** Wall segments to raise (grid coords, per-segment height in m), e.g. the one-click demo levee. */
export interface WallSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  height: number;
}

/**
 * Automation the app lends the UI for long headless runs (the Site check sweep): the same runFor the debug API uses,
 * and a render hold that drops the 3D view to a slow heartbeat so the GPU time goes to the solver.
 */
export interface SimControl {
  /** Advance the simulation by `simSeconds` as fast as the GPU allows (even while paused); resolves once a readback includes it. */
  runFor(simSeconds: number): Promise<void>;
  /** Simulated seconds since the last water reset. */
  simClock(): number;
  /** While on, the view renders at most a couple of times a second. */
  setRenderHold(on: boolean): void;
  /** The GPU flood-probability accumulator on the scene's grid (src/sim/ensemble.ts), or null without a GPU scene. */
  ensembleMap?(): EnsembleMapControl | null;
}

/** What the ensemble runner may do with the GPU accumulator (the app owns it and hands it to the renderer). */
export interface EnsembleMapControl {
  /** Start over: every count back to 0, and the probability view shows nothing until the next accumulate. */
  clear(): void;
  /** Fold the solver's current max depth in as one more member; the probability view shows the tally so far. */
  accumulate(): void;
  readonly members: number;
  /** The accumulator read back (nx·ny × 4 floats; tests and exports). */
  read(): Promise<Float32Array>;
}

/** The latest flood-probability ensemble of the scene on screen (src/ui/ensemble.ts), for the map, Site check and the panel. */
export interface EnsembleView {
  /** presetId|terrainName of the scene it was run on. */
  sceneKey: string;
  ranges: EnsembleRanges;
  seed: number;
  /** Members planned and completed (completed < planned after a cancel). */
  planned: number;
  rows: MemberResult[];
  summary: EnsembleSummary | null;
  /** Simulated seconds per member. */
  durationS: number;
  /** Per Site check site (by site id) and per portfolio asset (in CSV order). */
  sites: Map<string, AssetTally>;
  assets: AssetTally[];
  /** Site specs as they were when the ensemble ran (JSON keys), to flag later edits. */
  siteKeys: Map<string, string>;
  cancelled: boolean;
  /** Wall seconds the whole run took. */
  seconds: number;
}

/** Where the inflow on the map comes from on a chain preset. */
export type ChainInflowMode = 'chain' | 'scenario';

/** What the user may change about the chain from the panel (ChainOverrides plus the trigger's mode). */
export interface ChainWhatIf {
  overrides: ChainOverrides;
  /** massIntoRiver only: replaces the trigger's mode. */
  mode?: 'transientDam' | 'directFlow';
}

/** The hazard chain of the scene on screen (null on scenes without one). */
export interface ChainView {
  /** Changes with every scene, so a late answer for an old scene is recognisable. */
  sceneKey: string;
  spec: HazardChainSpec;
  /** Null until chain.json has arrived. */
  file: ChainFile | null;
  /** loading = fetching the profile; running = the deterministic run; ensemble = the bands; ready; error. */
  status: 'loading' | 'running' | 'ensemble' | 'ready' | 'error';
  progress: { done: number; total: number } | null;
  error: string | null;
  /** The run on screen (the deterministic member of the what-if last applied). */
  result: ChainRunResult | null;
  /** p10 / p50 / p90 per station and at the domain entry, once the ensemble has run for this what-if. */
  bands: EnsembleResult['stationBands'] | null;
  entryBand: ChainRunResult['ensemble'] | null;
  /** The ensemble's members (station fronts), for the early-warning lead-time bands; null/absent until it has run. */
  members?: EnsembleMember[] | null;
  /** Chain time (s after clock zero) at the 2-D solver's t = 0. */
  offset: number;
  /** The what-if the result is for. */
  whatIf: ChainWhatIf;
  /** What drives the map: the routed chain hydrograph, or the preset's own inflow. */
  inflow: ChainInflowMode;
  /** The result came from the bake (calibrated) or from a run in this tab. */
  origin: 'baked' | 'worker';
  /** Worker time of the last run, ms. */
  ms: number | null;
  /** Future-climate lake growth applied on top of the what-if (src/climate); null/absent = today. */
  climate?: { label: string; volumeFactor: number } | null;
}

/**
 * The early-warning design on a chain preset (src/ui/warningPanel.ts edits it, chainTimeline.ts draws and drags its
 * sensors): sensors placed on the valley profile and the optimiser's settings. UI state only — nothing in the app or
 * the simulation reads it. Tied to the chain's sceneKey: a new scene starts a fresh design.
 */
export interface WarningDesign {
  sceneKey: string;
  sensors: Sensor[];
  objective: WarningObjective;
  /** Highest bed elevation a sensor may sit at, m a.s.l. (access), or null for anywhere on the profile. */
  maxElevation: number | null;
  /** Latency preset new sensors get (src/hazard/warning.ts LATENCY_PRESETS id). */
  presetId: string;
  /** The station the lead-time-vs-position chart is about (null: the furthest town). */
  target: string | null;
  /** The next click on the valley profile places a sensor. */
  placing: boolean;
}

/** What the chain section may ask of the app. */
export interface ChainControl {
  /** Re-run the chain for this what-if (worker; progress in ChainView) and drive the map with it. */
  run(whatIf: ChainWhatIf): void;
  /** Drive the map with the routed chain or with the preset's own inflow (resets the water). */
  setInflow(mode: ChainInflowMode): void;
}

type Listener<T> = (v: T) => void;

class Channel<T> {
  private fns = new Set<Listener<T>>();
  on(fn: Listener<T>): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  emit(v: T): void {
    for (const fn of this.fns) {
      try {
        fn(v);
      } catch (err) {
        console.error('[ui] bridge listener failed', err);
      }
    }
  }
  get size(): number {
    return this.fns.size;
  }
}

export class UIBridge {
  hover: HoverInfo | null = null;
  scene: SceneAccess | null = null;
  /** Set by the app once it runs (null in tests and before startup). */
  sim: SimControl | null = null;
  readonly hoverChanged = new Channel<HoverInfo | null>();
  readonly wallDrawn = new Channel<void>();
  /** Latest scan of the walls on the map (null = no walls). Same data as the overtopping notices. */
  wallStatus: WallStatus | null = null;
  readonly wallStatusChanged = new Channel<WallStatus | null>();
  /** Land the walls keep dry (null = no walls). */
  protection: ProtectionSummary | null = null;
  readonly protectionChanged = new Channel<ProtectionSummary | null>();
  /** The hazard chain of the scene on screen, and the app's handle on it (both null without a chain). */
  chain: ChainView | null = null;
  chainControl: ChainControl | null = null;
  readonly chainChanged = new Channel<ChainView | null>();
  /** The early-warning design (null until the chain section creates one for the scene). */
  warning: WarningDesign | null = null;
  readonly warningChanged = new Channel<WarningDesign | null>();
  /** The latest flood-probability ensemble (null: none for this scene). */
  ensemble: EnsembleView | null = null;
  readonly ensembleChanged = new Channel<EnsembleView | null>();
  /** The portfolio the Impact section has loaded (its parsed assets), for the ensemble's per-asset probabilities. */
  portfolio: PortfolioAsset[] | null = null;
  /** Open "Check an address" (set by src/ui/useCases.ts; Site check's button calls it). */
  openAddressCheck: (() => void) | null = null;
  private readonly notices = new Channel<Notice>();
  /** Notices posted before the UI mounted are delivered when it subscribes. */
  private pending: Notice[] = [];

  setHover(h: HoverInfo | null): void {
    const a = this.hover;
    if (a === h || (a && h && a.gx === h.gx && a.gy === h.gy && a.ground === h.ground && a.barrier === h.barrier && a.depth === h.depth)) return;
    this.hover = h;
    this.hoverChanged.emit(h);
  }

  setWallStatus(w: WallStatus | null): void {
    const a = this.wallStatus;
    if (
      a === w ||
      (a && w && a.cells === w.cells && a.overtopped === w.overtopped && a.belowLevel === w.belowLevel && a.neededHeight === w.neededHeight && a.settled === w.settled && a.stageFt === w.stageFt)
    ) {
      return;
    }
    this.wallStatus = w;
    this.wallStatusChanged.emit(w);
  }

  setProtection(p: ProtectionSummary | null): void {
    const a = this.protection;
    if (a === p || (a && p && a.wallCells === p.wallCells && a.areaM2 === p.areaM2 && a.roadMeters === p.roadMeters && a.level === p.level)) return;
    this.protection = p;
    this.protectionChanged.emit(p);
  }

  setChain(c: ChainView | null): void {
    if (c === this.chain) return;
    this.chain = c;
    this.chainChanged.emit(c);
  }

  setEnsemble(e: EnsembleView | null): void {
    if (e === this.ensemble) return;
    this.ensemble = e;
    this.ensembleChanged.emit(e);
  }

  setWarning(w: WarningDesign | null): void {
    if (w === this.warning) return;
    this.warning = w;
    this.warningChanged.emit(w);
  }

  notify(n: Notice): void {
    if (this.notices.size === 0) {
      this.pending.push(n);
      if (this.pending.length > 3) this.pending.shift();
      return;
    }
    this.notices.emit(n);
  }

  onNotice(fn: Listener<Notice>): () => void {
    const off = this.notices.on(fn);
    const queued = this.pending.splice(0);
    queued.forEach(fn);
    return off;
  }
}

const bridges = new WeakMap<Store, UIBridge>();

export function bridgeFor(store: Store): UIBridge {
  let b = bridges.get(store);
  if (!b) bridges.set(store, (b = new UIBridge()));
  return b;
}

/** Show a non-error notice (neutral toast). Safe to call before the UI is mounted. */
export function postNotice(store: Store, notice: Notice): void {
  bridgeFor(store).notify(notice);
}
