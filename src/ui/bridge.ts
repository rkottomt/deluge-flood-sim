/**
 * UI-internal channel between the two entry points the app creates separately: mountUI (the DOM) and
 * createToolController (canvas input — the only part of the UI that sees the terrain and the solver).
 *
 * It is keyed by the Store both receive, so it needs no contract change. It carries
 *  • hover: the ground under the cursor (for live "will this wall hold?" checks in the options card),
 *  • notices: neutral / warning / success toasts that are NOT errors (limits, guidance, overtopped walls),
 *  • scene access: terrain, solver and camera getters (for one-click suggestions such as an evacuation start),
 *  • walls: a wall was drawn by the user, the latest check of the drawn walls against the water, and the land they
 *    keep dry (published by the app, see src/app/protection.ts).
 */
import type { CameraController, FloodSolver, Store, TerrainData } from '../contracts';
import type { WallStatus } from './wallCheck';

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
  readonly hoverChanged = new Channel<HoverInfo | null>();
  readonly wallDrawn = new Channel<void>();
  /** Latest scan of the walls on the map (null = no walls). Same data as the overtopping notices. */
  wallStatus: WallStatus | null = null;
  readonly wallStatusChanged = new Channel<WallStatus | null>();
  /** Land the walls keep dry (null = no walls). */
  protection: ProtectionSummary | null = null;
  readonly protectionChanged = new Channel<ProtectionSummary | null>();
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
