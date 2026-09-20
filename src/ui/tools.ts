/**
 * Tool controller: turns pointer input on the WebGPU canvas into solver edits and store changes.
 *
 * Design notes
 *  • Picking (a CPU ray march in the renderer) runs at most once per frame for the hover cursor, inside
 *    update(); drag gestures that need precision (wall polylines, erasing) pick on the pointer event.
 *  • Right/middle drags and wheel always belong to the camera. Left drags orbit only for 'orbit' and 'probe'.
 *  • getTransientOverlay() is called every frame by the app, so it returns a cached object that is only
 *    rebuilt when something changed (no per-frame allocations).
 *  • Global shortcuts that need AppActions (R, F, T, Space, digits…) live in keyboard.ts (mounted by
 *    mountUI). This controller only handles Esc (cancel the current gesture) and Shift tracking.
 */
import type {
  AppState,
  FloodSolver,
  OverlayState,
  PickResult,
  Shelter,
  StormCell,
  ToolController,
  ToolControllerDeps,
  ToolId,
  WaterSource,
} from '../contracts';
import { gridToGeo } from '../data/geo';
import { TOOL_BY_ID } from './toolDefs';
import { bridgeFor, type HoverInfo, type WallSegment } from './bridge';
import { checkWall, scanWalls, stageSurface, suggestedWallHeight, wallShare, WALL_ALARM_CELLS, WALL_MAX, WALL_MIN } from './wallCheck';
import { formatStageFt } from './format';
import { stageFt } from './scales';

/** Max inflow + stage sources and storm cells the solver supports (MAX_SOURCES / MAX_STORMS in src/sim/constants.ts). */
export const MAX_SOURCES = 16;
export const MAX_STORMS = 8;
/** How often walls are checked against the water (overtopping notices), ms. */
const WALL_SCAN_MS = 1500;
/** Shortest gap between wall scans triggered by wall edits, ms. */
const WALL_RESCAN_MIN_MS = 250;
/** Simulated seconds after a wall is drawn before water on top of it counts as overtopping. */
const OVERTOP_SETTLE_S = 120;
/** A stage change is judged against existing walls once the slider has been still this long, ms. */
const STAGE_SETTLE_MS = 700;
/** Cursor ring colours. */
const RING_REMOVE: [number, number, number] = [1.0, 0.36, 0.38];
const RING_LIMIT: [number, number, number] = [0.58, 0.62, 0.7];
const RING_WALL_LOW: [number, number, number] = [1.0, 0.3, 0.32];
/** Ring that follows the head of a wall being raised by buildWalls (the one-click levee), and how long it lingers. */
const RING_BUILD: [number, number, number] = [1.0, 0.78, 0.32];
const BUILD_RING_MS = 700;
/** Click-to-remove distance as a fraction of the domain's larger side. */
export const REMOVE_FRACTION = 0.03;
/** Pour / pump rate at the brush center, meters of depth per real second. */
export const WATER_RATE = 1.5;
/** Dig / raise rate at the brush center, meters per real second. */
export const DIG_RATE = 3;
/** Probe store updates per second. */
const PROBE_HZ = 15;
/** Pixels a pointer may travel between down and up and still count as a click. */
const CLICK_SLOP_PX = 7;
/**
 * The hover pick (a CPU ray march) is repeated only when the pointer or camera moved, or at this interval so
 * water depth under a still cursor (and ground being dug) stays fresh.
 */
const HOVER_REFRESH_MS = 150;

type Transient = Pick<OverlayState, 'wallPreview' | 'cursor'>;

type Gesture =
  | { kind: 'none' }
  | { kind: 'wall'; pointerId: number; pts: number[] }
  | { kind: 'erase'; pointerId: number; last: { gx: number; gy: number } | null }
  | { kind: 'hold'; pointerId: number }
  | { kind: 'click'; pointerId: number; x: number; y: number; moved: boolean };

/** Ramer–Douglas–Peucker simplification of an interleaved [x0,y0,x1,y1,…] polyline. */
export function simplifyPolyline(pts: number[], eps: number): number[] {
  const n = pts.length / 2;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[2 * a], ay = pts[2 * a + 1];
    const bx = pts[2 * b], by = pts[2 * b + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1;
    let idx = -1;
    for (let k = a + 1; k < b; k++) {
      const px = pts[2 * k] - ax, py = pts[2 * k + 1] - ay;
      let d: number;
      if (len2 < 1e-12) d = Math.hypot(px, py);
      else {
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        d = Math.hypot(px - t * dx, py - t * dy);
      }
      if (d > maxD) {
        maxD = d;
        idx = k;
      }
    }
    if (maxD > eps && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out: number[] = [];
  for (let k = 0; k < n; k++) if (keep[k]) out.push(pts[2 * k], pts[2 * k + 1]);
  return out;
}

/** Smallest positive integer n such that `${prefix} ${n}` is not already used. */
export function nextLabel(existing: Array<string | undefined>, prefix: string): string {
  const used = new Set(existing);
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/** Index of the nearest item within maxDist (grid cells), or -1. */
export function nearestWithin<T extends { gx: number; gy: number }>(
  items: readonly T[],
  gx: number,
  gy: number,
  maxDist: number,
  filter?: (t: T) => boolean,
): number {
  let best = -1;
  let bestD = maxDist;
  items.forEach((it, i) => {
    if (filter && !filter(it)) return;
    const d = Math.hypot(it.gx - gx, it.gy - gy);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

let uid = 0;
const newId = (prefix: string) => `${prefix}-u${Date.now().toString(36)}${(uid++).toString(36)}`;

export function createToolController(canvas: HTMLCanvasElement, deps: ToolControllerDeps): ToolController {
  const { store, renderer } = deps;

  const pointer = { x: 0, y: 0, inside: false, moved: true };
  let shift = false;
  let gesture: Gesture = { kind: 'none' };
  let hover: PickResult | null = null;
  let lastWallEnd: { gx: number; gy: number } | null = null;
  let lastTerrain = deps.getTerrain();
  let rect = canvas.getBoundingClientRect();
  let lastProbeAt = -Infinity;
  let lastHoverPickAt = -Infinity;
  const lastPose = { gx: NaN, gy: NaN, elevation: NaN, distance: NaN, yaw: NaN, pitch: NaN };
  let probeShown = false;
  let transient: Transient = { wallPreview: null, cursor: null };
  let transientDirty = true;
  const activePointers = new Set<number>();
  const bridge = bridgeFor(store);
  const scene = {
    getTerrain: () => deps.getTerrain(),
    getSolver: () => deps.getSolver(),
    getCamera: () => {
      try {
        return renderer.camera ?? null;
      } catch {
        return null;
      }
    },
    buildWalls: (segments: WallSegment[], radius?: number) => buildWalls(segments, radius),
  };
  bridge.scene = scene;
  /** Head of a wall being raised by buildWalls: a ring follows it (the renderer also re-scans walls under it at once). */
  let buildHead: { gx: number; gy: number; until: number } | null = null;
  /** Latest wall check at the cursor (drives the ring colour); null when not applicable. */
  let wallLow = false;

  // ─── helpers ──────────────────────────────────────────────────────────────────────────────────
  const state = (): AppState => store.get();
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function gridInfo(): { nx: number; ny: number; cellSize: number } | null {
    const solver = deps.getSolver();
    if (solver) return { nx: solver.nx, ny: solver.ny, cellSize: solver.cellSize };
    const t = deps.getTerrain();
    if (t) return { nx: t.nx, ny: t.ny, cellSize: t.cellSize };
    return state().grid;
  }

  function wallRadiusCells(s: AppState, cellSize: number) {
    return Math.max(0.75, s.brushRadius / cellSize / 2);
  }
  function brushCells(s: AppState, cellSize: number, min = 1) {
    return Math.max(min, s.brushRadius / cellSize);
  }
  function removeDistance(g: { nx: number; ny: number }) {
    return REMOVE_FRACTION * Math.max(g.nx, g.ny);
  }

  /** True (and remembers the pose) when the camera moved since the last call. */
  function cameraMoved(): boolean {
    let p;
    try {
      p = renderer.camera.pose;
    } catch {
      return false;
    }
    if (!p) return false;
    const moved =
      p.target.gx !== lastPose.gx ||
      p.target.gy !== lastPose.gy ||
      p.target.elevation !== lastPose.elevation ||
      p.distance !== lastPose.distance ||
      p.yaw !== lastPose.yaw ||
      p.pitch !== lastPose.pitch;
    if (moved) {
      lastPose.gx = p.target.gx;
      lastPose.gy = p.target.gy;
      lastPose.elevation = p.target.elevation;
      lastPose.distance = p.distance;
      lastPose.yaw = p.yaw;
      lastPose.pitch = p.pitch;
    }
    return moved;
  }

  function pickAt(x: number, y: number): PickResult | null {
    try {
      return renderer.pick(x, y);
    } catch {
      return null;
    }
  }

  function setPointerFrom(e: PointerEvent) {
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (x !== pointer.x || y !== pointer.y) pointer.moved = true;
    pointer.x = x;
    pointer.y = y;
  }

  function capture(id: number) {
    try {
      canvas.setPointerCapture(id);
    } catch {
      /* pointer may already be gone */
    }
  }
  function release(id: number) {
    try {
      if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id);
    } catch {
      /* ignore */
    }
  }

  function applyCameraMode(tool: ToolId) {
    try {
      renderer.camera.leftDragOrbits = tool === 'orbit' || tool === 'probe';
    } catch {
      /* renderer not ready */
    }
    canvas.style.cursor = tool === 'orbit' ? 'grab' : 'crosshair';
  }

  function cancelGesture() {
    if (gesture.kind !== 'none' && 'pointerId' in gesture) release(gesture.pointerId);
    gesture = { kind: 'none' };
    transientDirty = true;
  }

  // ─── wall ─────────────────────────────────────────────────────────────────────────────────────
  function commitWall(pts: number[]) {
    const solver = deps.getSolver();
    const g = gridInfo();
    if (!solver || !g || pts.length < 2) return;
    const s = state();
    const radius = wallRadiusCells(s, g.cellSize);
    const simple = simplifyPolyline(pts, 0.35);
    if (simple.length === 2) {
      solver.applyBrush({ kind: 'wall', ax: simple[0], ay: simple[1], bx: simple[0], by: simple[1], radius, height: s.wallHeight });
    } else {
      for (let k = 0; k + 3 < simple.length; k += 2) {
        solver.applyBrush({
          kind: 'wall',
          ax: simple[k],
          ay: simple[k + 1],
          bx: simple[k + 2],
          by: simple[k + 3],
          radius,
          height: s.wallHeight,
        });
      }
    }
    lastWallEnd = { gx: simple[simple.length - 2], gy: simple[simple.length - 1] };
    armWallScan(solver);
    bridge.wallDrawn.emit();
  }

  /** Walls raised by code (e.g. the one-click demo levee), watched exactly like drawn ones. */
  function buildWalls(segments: WallSegment[], radiusCells?: number) {
    const solver = deps.getSolver();
    const g = gridInfo();
    if (!solver || !g || !segments.length) return;
    const radius = radiusCells ?? wallRadiusCells(state(), g.cellSize);
    for (const sg of segments) {
      if (![sg.ax, sg.ay, sg.bx, sg.by, sg.height].every(Number.isFinite)) continue;
      const height = Math.min(WALL_MAX, Math.max(WALL_MIN, sg.height));
      solver.applyBrush({ kind: 'wall', ax: sg.ax, ay: sg.ay, bx: sg.bx, by: sg.by, radius, height });
    }
    const last = segments[segments.length - 1];
    buildHead = { gx: last.bx, gy: last.by, until: now() + BUILD_RING_MS };
    transientDirty = true;
    armWallScan(solver);
    bridge.wallDrawn.emit();
  }

  /** Let the solver allocate its brush scratch textures before the first stroke rather than during it. */
  function prepareBrushes() {
    try {
      (deps.getSolver() as (FloodSolver & { prepareBrushes?: () => void }) | null)?.prepareBrushes?.();
    } catch {
      /* solver gone */
    }
  }

  function armWallScan(solver: FloodSolver) {
    wallScan.armed = true;
    // Soon, but at most a few times a second: the one-click levee raises walls on every frame for ~2 s, and each scan
    // walks the whole grid.
    wallScan.nextAt = Math.min(wallScan.nextAt, wallScan.lastAt + WALL_RESCAN_MIN_MS);
    // A wall raised under standing water briefly carries that water on top; judge overtopping once it has drained.
    wallScan.settleUntil = (solver.getSnapshot?.()?.simTime ?? 0) + OVERTOP_SETTLE_S;
    // …and check the new wall against the river stage right away.
    wallScan.stageDirty = true;
    wallScan.stageChangedAt = 0;
  }

  function extendWall(pts: number[], hit: PickResult, cellSize: number) {
    const spacing = Math.max(1, wallRadiusCells(state(), cellSize));
    const n = pts.length;
    if (n === 0 || Math.hypot(hit.gx - pts[n - 2], hit.gy - pts[n - 1]) >= spacing) {
      pts.push(hit.gx, hit.gy);
      transientDirty = true;
    }
  }

  // ─── click tools ──────────────────────────────────────────────────────────────────────────────
  function clickAt(tool: ToolId, hit: PickResult) {
    const g = gridInfo();
    if (!g) return;
    const s = state();
    const maxD = removeDistance(g);
    switch (tool) {
      case 'inflow': {
        const i = nearestWithin(s.sources, hit.gx, hit.gy, maxD, (src) => src.type === 'inflow');
        if (i >= 0) {
          store.set({ sources: s.sources.filter((_, k) => k !== i) });
        } else if (s.sources.length >= MAX_SOURCES) {
          bridge.notify({
            kind: 'info',
            key: 'limit-sources',
            title: `Source limit reached (${MAX_SOURCES}/${MAX_SOURCES})`,
            message: 'The GPU solver takes up to 16 water sources, river boundaries included. Click an existing inflow to remove it, then place a new one.',
          });
        } else {
          const src: WaterSource = {
            id: newId('inflow'),
            type: 'inflow',
            gx: hit.gx,
            gy: hit.gy,
            radius: brushCells(s, g.cellSize, 1.5),
            discharge: s.inflowDischarge,
            label: nextLabel(s.sources.map((x) => x.label), 'Inflow'),
          };
          store.set({ sources: [...s.sources, src] });
        }
        break;
      }
      case 'storm': {
        const i = nearestWithin(s.storms, hit.gx, hit.gy, maxD);
        if (i >= 0) {
          store.set({ storms: s.storms.filter((_, k) => k !== i) });
        } else if (s.storms.length >= MAX_STORMS) {
          bridge.notify({
            kind: 'info',
            key: 'limit-storms',
            title: `Storm limit reached (${MAX_STORMS}/${MAX_STORMS})`,
            message: 'The GPU solver takes up to 8 storm cells. Click an existing storm to remove it, or raise the global rainfall in Weather & rivers.',
          });
        } else {
          const storm: StormCell = {
            id: newId('storm'),
            gx: hit.gx,
            gy: hit.gy,
            radius: brushCells(s, g.cellSize, 2),
            intensity: s.stormIntensity,
          };
          store.set({ storms: [...s.storms, storm] });
        }
        break;
      }
      case 'shelter': {
        const i = nearestWithin(s.shelters, hit.gx, hit.gy, maxD);
        if (i >= 0) {
          store.set({ shelters: s.shelters.filter((_, k) => k !== i) });
        } else {
          const sh: Shelter = { name: nextLabel(s.shelters.map((x) => x.name), 'Shelter'), gx: hit.gx, gy: hit.gy };
          store.set({ shelters: [...s.shelters, sh] });
        }
        break;
      }
      case 'evac':
        store.set({ evacStart: { gx: hit.gx, gy: hit.gy } });
        break;
    }
  }

  /** True when the active click tool can't place anything more (a click would only show the limit notice). */
  function atLimit(tool: ToolId): boolean {
    const s = state();
    if (tool === 'inflow') return s.sources.length >= MAX_SOURCES;
    if (tool === 'storm') return s.storms.length >= MAX_STORMS;
    return false;
  }

  // ─── ground under the cursor & wall checks ────────────────────────────────────────────────────
  function hoverInfo(hit: PickResult | null): HoverInfo | null {
    const solver = deps.getSolver();
    const g = gridInfo();
    if (!hit || !g) return null;
    const i = Math.min(g.nx - 1, Math.max(0, Math.floor(hit.gx)));
    const j = Math.min(g.ny - 1, Math.max(0, Math.floor(hit.gy)));
    let ground = hit.elevation;
    let barrier = 0;
    try {
      const k = j * g.nx + i;
      const gr = solver?.getGroundCPU();
      const ba = solver?.getBarrierCPU();
      if (gr && k < gr.length) ground = gr[k];
      if (ba && k < ba.length) barrier = ba[k];
    } catch {
      /* mirrors unavailable: fall back to the picked surface */
    }
    return { gx: hit.gx, gy: hit.gy, ground, barrier, depth: Number.isFinite(hit.depth) ? hit.depth : 0 };
  }

  function publishHover() {
    const tool = state().tool;
    const info = tool === 'wall' && pointer.inside ? hoverInfo(hover) : null;
    bridge.setHover(info);
    const s = state();
    const check = info
      ? checkWall({
          ground: info.ground,
          barrier: info.barrier,
          depth: info.depth,
          wallHeight: s.wallHeight,
          stageLevel: stageSurface(s.scenario?.stage, s.stageOffset),
        })
      : null;
    const low = !!check && !check.ok;
    if (low !== wallLow) {
      wallLow = low;
      transientDirty = true;
    }
  }

  /**
   * Walls vs water, every WALL_SCAN_MS: tell the user when water pours over a wall they built, and — right after
   * they raise the river — when the new level is higher than their walls. Each message fires once per wall layout.
   */
  const wallScan = { nextAt: 0, lastAt: -Infinity, armed: false, overtopSig: NaN, stageSig: NaN, lastSim: 0, settleUntil: 0, stageChangedAt: 0, stageDirty: false };
  function checkWalls(t: number) {
    if (!wallScan.armed || t < wallScan.nextAt) return;
    wallScan.nextAt = t + WALL_SCAN_MS;
    wallScan.lastAt = t;
    const solver = deps.getSolver();
    if (!solver) return;
    let ground: Float32Array, barrier: Float32Array;
    try {
      ground = solver.getGroundCPU();
      barrier = solver.getBarrierCPU();
    } catch {
      return;
    }
    const s = state();
    const snap = solver.getSnapshot?.() ?? null;
    const ctrl = s.scenario?.stage ?? null;
    const level = stageSurface(ctrl, s.stageOffset);
    const depth = snap && snap.nx === solver.nx && snap.ny === solver.ny ? snap.depth : null;
    // Solvers that track where walls were raised (GpuFloodSolver.wallBounds) let the scan skip the empty grid.
    const bounds = (solver as FloodSolver & { wallBounds?: { x0: number; y0: number; x1: number; y1: number } | null }).wallBounds;
    const scan = scanWalls(ground, barrier, depth, level, solver.nx, bounds);
    if (scan.cells === 0) {
      wallScan.armed = false;
      bridge.setWallStatus(null);
      return;
    }
    // Water reset → the same walls may be overtopped again later.
    if (snap && snap.simTime < wallScan.lastSim - 1) {
      wallScan.overtopSig = NaN;
      wallScan.settleUntil = snap.simTime + OVERTOP_SETTLE_S;
    }
    if (snap) wallScan.lastSim = snap.simTime;

    const settled = !!snap && snap.simTime >= wallScan.settleUntil;
    // Depths from a blown-up solver say nothing about the wall.
    const physical = s.sim.stabilityMode === 'robust';
    // The options card shows this same scan, so the card and the notices below always agree.
    bridge.setWallStatus({
      cells: scan.cells,
      overtopped: settled && physical ? scan.overtopped : 0,
      belowLevel: scan.belowLevel,
      neededHeight: scan.neededHeight,
      settled: settled && physical,
      stageFt: ctrl ? stageFt(ctrl, s.stageOffset) : null,
    });
    const need = suggestedWallHeight(scan, s.wallHeight);
    // With the wall card open the card already carries the details (and the live numbers): keep the notice to one line.
    const brief = s.tool === 'wall';
    // One notice per scan; overtopping (what is happening) wins over the stage warning (what will happen).
    let posted = false;
    if (settled && physical && scan.overtopped >= WALL_ALARM_CELLS && scan.signature !== wallScan.overtopSig) {
      posted = true;
      wallScan.overtopSig = scan.signature;
      bridge.notify({
        kind: 'warn',
        key: 'wall-overtopped',
        title: 'Water is pouring over your wall',
        // Brief: no share — the card next to it shows the live share, which moves as the water does.
        message: brief
          ? 'A wall only holds while its top stays above the flood.'
          : `About ${wallShare(scan.overtopped, scan.cells)}% of the wall is under water. A wall only holds while its top stays above the flood — ` +
            `and water also runs around open ends, so tie both ends into high ground.`,
        action: level !== null && need !== null ? { label: `Use ${need.toFixed(1)} m walls`, run: () => store.set({ wallHeight: need }) } : undefined,
        durationMs: 10000,
      });
    }

    if (wallScan.stageDirty && t - wallScan.stageChangedAt >= STAGE_SETTLE_MS && ctrl && level !== null) {
      wallScan.stageDirty = false;
      const sig = scan.signature * 31 + Math.round(level * 10);
      if (!posted && scan.belowLevel >= WALL_ALARM_CELLS && sig !== wallScan.stageSig) {
        wallScan.stageSig = sig;
        bridge.notify({
          kind: 'warn',
          key: 'wall-below-stage',
          title: `Your wall is lower than the river at ${formatStageFt(stageFt(ctrl, s.stageOffset))}`,
          message: brief
            ? `${wallShare(scan.belowLevel, scan.cells)}% of it will be overtopped.`
            : `The river will stand at ${level.toFixed(1)} m; the top of ${wallShare(scan.belowLevel, scan.cells)}% of your wall is lower, so expect it to be overtopped.`,
          action: need !== null ? { label: `Use ${need.toFixed(1)} m walls`, run: () => store.set({ wallHeight: need }) } : undefined,
          durationMs: 9000,
        });
      }
    }
  }

  /** True when a click at `hit` with the current tool would remove an existing object. */
  function wouldRemove(tool: ToolId, hit: PickResult): boolean {
    const g = gridInfo();
    if (!g) return false;
    const s = state();
    const maxD = removeDistance(g);
    if (tool === 'inflow') return nearestWithin(s.sources, hit.gx, hit.gy, maxD, (x) => x.type === 'inflow') >= 0;
    if (tool === 'storm') return nearestWithin(s.storms, hit.gx, hit.gy, maxD) >= 0;
    if (tool === 'shelter') return nearestWithin(s.shelters, hit.gx, hit.gy, maxD) >= 0;
    return false;
  }

  // ─── pointer events ───────────────────────────────────────────────────────────────────────────
  function onPointerDown(e: PointerEvent) {
    activePointers.add(e.pointerId);
    rect = canvas.getBoundingClientRect();
    setPointerFrom(e);
    pointer.inside = true;
    shift = e.shiftKey;
    // A second finger means pinch/pan: abandon whatever we were drawing.
    if (activePointers.size > 1) {
      cancelGesture();
      return;
    }
    if (e.button !== 0) return;
    const tool = state().tool;
    if (tool === 'orbit' || tool === 'probe') return;
    const g = gridInfo();
    if (!g) return;
    const hit = pickAt(pointer.x, pointer.y);

    switch (tool) {
      case 'wall': {
        const pts: number[] = [];
        if (e.shiftKey && lastWallEnd) pts.push(lastWallEnd.gx, lastWallEnd.gy);
        if (hit) extendWall(pts, hit, g.cellSize);
        gesture = { kind: 'wall', pointerId: e.pointerId, pts };
        capture(e.pointerId);
        transientDirty = true;
        break;
      }
      case 'eraseWall': {
        gesture = { kind: 'erase', pointerId: e.pointerId, last: null };
        capture(e.pointerId);
        if (hit) eraseTo(hit);
        break;
      }
      case 'water':
      case 'dig':
        gesture = { kind: 'hold', pointerId: e.pointerId };
        hover = hit;
        capture(e.pointerId);
        break;
      case 'inflow':
      case 'storm':
      case 'shelter':
      case 'evac':
        gesture = { kind: 'click', pointerId: e.pointerId, x: pointer.x, y: pointer.y, moved: false };
        capture(e.pointerId);
        break;
    }
    e.preventDefault?.();
  }

  function eraseTo(hit: PickResult) {
    if (gesture.kind !== 'erase') return;
    const solver = deps.getSolver();
    const g = gridInfo();
    if (!solver || !g) return;
    const radius = brushCells(state(), g.cellSize, 1);
    const last = gesture.last;
    if (last && Math.hypot(hit.gx - last.gx, hit.gy - last.gy) < Math.max(0.5, radius * 0.3)) return;
    const a = last ?? hit;
    solver.applyBrush({ kind: 'eraseWall', ax: a.gx, ay: a.gy, bx: hit.gx, by: hit.gy, radius });
    gesture.last = { gx: hit.gx, gy: hit.gy };
  }

  function onPointerMove(e: PointerEvent) {
    if (activePointers.size > 1) return;
    setPointerFrom(e);
    pointer.inside = true;
    shift = e.shiftKey;
    const g = gridInfo();
    switch (gesture.kind) {
      case 'wall': {
        if (e.pointerId !== gesture.pointerId || !g) break;
        // Use coalesced events so fast strokes don't skip corners.
        const evs = e.getCoalescedEvents?.() ?? [];
        const list = evs.length ? evs : [e];
        for (const ce of list) {
          const hit = pickAt(ce.clientX - rect.left, ce.clientY - rect.top);
          if (hit) extendWall(gesture.pts, hit, g.cellSize);
        }
        hover = pickAt(pointer.x, pointer.y);
        pointer.moved = false;
        transientDirty = true;
        break;
      }
      case 'erase': {
        if (e.pointerId !== gesture.pointerId) break;
        const hit = pickAt(pointer.x, pointer.y);
        if (hit) eraseTo(hit);
        hover = hit;
        pointer.moved = false;
        transientDirty = true;
        break;
      }
      case 'click':
        if (Math.hypot(pointer.x - gesture.x, pointer.y - gesture.y) > CLICK_SLOP_PX) gesture.moved = true;
        break;
    }
  }

  function onPointerUp(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    setPointerFrom(e);
    const g = gesture;
    if (g.kind === 'none' || g.pointerId !== e.pointerId) return;
    if (g.kind === 'wall') {
      commitWall(g.pts);
    } else if (g.kind === 'click' && !g.moved) {
      const hit = pickAt(pointer.x, pointer.y);
      if (hit) clickAt(state().tool, hit);
    }
    release(e.pointerId);
    gesture = { kind: 'none' };
    transientDirty = true;
  }

  function onPointerCancel(e: PointerEvent) {
    activePointers.delete(e.pointerId);
    if (gesture.kind !== 'none' && gesture.pointerId === e.pointerId) cancelGesture();
  }

  function onPointerEnter(e: PointerEvent) {
    setPointerFrom(e);
    pointer.inside = true;
  }

  function onPointerLeave() {
    if (gesture.kind !== 'none') return; // captured drags keep going
    pointer.inside = false;
    hover = null;
    transientDirty = true;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Shift') shift = e.type === 'keydown';
    if (e.type === 'keydown' && e.key === 'Escape' && gesture.kind !== 'none') {
      cancelGesture();
    }
  }

  function onBlur() {
    shift = false;
    activePointers.clear();
    if (gesture.kind === 'hold' || gesture.kind === 'click') cancelGesture();
  }

  function onResize() {
    rect = canvas.getBoundingClientRect();
  }

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerenter', onPointerEnter);
  canvas.addEventListener('pointerleave', onPointerLeave);
  const win: (Window & typeof globalThis) | null = typeof window !== 'undefined' ? window : null;
  win?.addEventListener('keydown', onKey);
  win?.addEventListener('keyup', onKey);
  win?.addEventListener('blur', onBlur);
  win?.addEventListener('resize', onResize);

  applyCameraMode(state().tool);
  const unsubscribe = store.subscribe((s, prev) => {
    if (s.tool !== prev.tool) {
      // The wall card reports on the walls already built: check them now rather than at the next wall edit.
      if (s.tool === 'wall') {
        wallScan.armed = true;
        wallScan.nextAt = 0;
        prepareBrushes();
      }
      cancelGesture();
      applyCameraMode(s.tool);
      if (prev.tool === 'probe' && s.probe) store.set({ probe: null });
      probeShown = false;
      pointer.moved = true;
      publishHover();
    }
    if (s.brushRadius !== prev.brushRadius || s.wallHeight !== prev.wallHeight) transientDirty = true;
    if (s.wallHeight !== prev.wallHeight || s.stageOffset !== prev.stageOffset || s.scenario !== prev.scenario) publishHover();
    if (s.stageOffset > prev.stageOffset) {
      wallScan.stageDirty = true;
      wallScan.stageChangedAt = now();
      wallScan.armed = true;
    }
  });

  // ─── per frame ────────────────────────────────────────────────────────────────────────────────
  function update(realSeconds: number) {
    const dt = Math.min(Math.max(realSeconds, 0), 0.1);
    const s = state();
    const tool = s.tool;

    // New terrain → forget the last wall end and any in-flight gesture.
    const terrain = deps.getTerrain();
    if (terrain !== lastTerrain) {
      lastTerrain = terrain;
      lastWallEnd = null;
      cancelGesture();
      wallScan.armed = false;
      wallScan.overtopSig = NaN;
      wallScan.stageSig = NaN;
      wallScan.lastSim = 0;
      bridge.setWallStatus(null);
    }

    if (buildHead && now() > buildHead.until) {
      buildHead = null;
      transientDirty = true;
    }

    // Hover pick for the cursor ring / probe / held brushes: at most once per frame, and only when something
    // that affects it changed (no wasted CPU on a fanless laptop while the cursor rests).
    const wantsHover = tool !== 'orbit';
    const t = now();
    if (
      wantsHover &&
      pointer.inside &&
      (gesture.kind === 'none' || gesture.kind === 'hold' || gesture.kind === 'click') &&
      (pointer.moved || cameraMoved() || t - lastHoverPickAt >= HOVER_REFRESH_MS)
    ) {
      const prevHover = hover;
      hover = pickAt(pointer.x, pointer.y);
      lastHoverPickAt = t;
      pointer.moved = false;
      if (
        !prevHover !== !hover ||
        (hover && prevHover && (hover.gx !== prevHover.gx || hover.gy !== prevHover.gy))
      ) {
        transientDirty = true;
      }
    } else if (!pointer.inside && hover) {
      hover = null;
      transientDirty = true;
    }
    if (tool === 'wall' || bridge.hover) publishHover();
    checkWalls(t);

    // Held brushes.
    if (gesture.kind === 'hold' && hover && dt > 0) {
      const solver = deps.getSolver();
      const g = gridInfo();
      if (solver && g) {
        const radius = brushCells(s, g.cellSize, 1);
        if (tool === 'water') {
          solver.applyBrush({ kind: 'water', gx: hover.gx, gy: hover.gy, radius, amount: (shift ? -1 : 1) * WATER_RATE * dt });
        } else if (tool === 'dig') {
          solver.applyBrush({ kind: 'terrain', gx: hover.gx, gy: hover.gy, radius, delta: (shift ? 1 : -1) * DIG_RATE * dt });
        }
      }
    }

    // Probe readout (throttled).
    if (tool === 'probe') {
      if (hover && t - lastProbeAt >= 1000 / PROBE_HZ) {
        lastProbeAt = t;
        const geo = terrain ? gridToGeo(terrain, hover.gx, hover.gy) : { lat: NaN, lon: NaN };
        store.set({
          probe: {
            gx: hover.gx,
            gy: hover.gy,
            elevation: hover.elevation,
            depth: hover.depth,
            // Snapshots carry depth only; the app may overwrite speed from the state texture if it has it.
            speed: 0,
            lat: geo.lat,
            lon: geo.lon,
          },
        });
        probeShown = true;
      } else if (!hover && probeShown) {
        probeShown = false;
        store.set({ probe: null });
      }
    }
  }

  function buildTransient(): Transient {
    const s = state();
    const g = gridInfo();
    let wallPreview: Transient['wallPreview'] = null;
    let cursor: Transient['cursor'] = null;
    if (g && gesture.kind === 'wall' && gesture.pts.length >= 2) {
      const pts = gesture.pts.slice();
      if (hover) {
        const n = pts.length;
        if (Math.hypot(hover.gx - pts[n - 2], hover.gy - pts[n - 1]) > 0.25) pts.push(hover.gx, hover.gy);
      }
      wallPreview = { pts: new Float32Array(pts), height: s.wallHeight, radius: wallRadiusCells(s, g.cellSize) };
    }
    const def = TOOL_BY_ID[s.tool];
    if (g && buildHead) {
      cursor = { gx: buildHead.gx, gy: buildHead.gy, radius: Math.max(2, 25 / g.cellSize), color: RING_BUILD };
    } else if (g && hover && def && s.tool !== 'orbit') {
      let radius: number;
      let color: [number, number, number] = def.ringColor ?? [1, 1, 1];
      switch (s.tool) {
        case 'wall':
          radius = wallRadiusCells(s, g.cellSize);
          // Red while a wall drawn here would be lower than the water it has to hold back.
          if (wallLow) color = RING_WALL_LOW;
          break;
        case 'inflow':
          radius = brushCells(s, g.cellSize, 1.5);
          break;
        case 'storm':
          radius = brushCells(s, g.cellSize, 2);
          break;
        case 'eraseWall':
        case 'water':
        case 'dig':
          radius = brushCells(s, g.cellSize, 1);
          if (s.tool === 'water' && shift) color = [1.0, 0.55, 0.3];
          break;
        case 'probe':
          radius = Math.max(1, 0.004 * Math.max(g.nx, g.ny));
          break;
        default:
          radius = Math.max(2, 0.01 * Math.max(g.nx, g.ny));
      }
      if (wouldRemove(s.tool, hover)) {
        color = RING_REMOVE;
        radius = Math.max(radius, removeDistance(g) * 0.5);
      } else if (atLimit(s.tool)) {
        // Nothing more can be placed: a muted ring says a click here won't add anything.
        color = RING_LIMIT;
      }
      cursor = { gx: hover.gx, gy: hover.gy, radius, color };
    }
    return { wallPreview, cursor };
  }

  let lastShift = shift;
  let lastSourcesRef: unknown = null;
  function getTransientOverlay(): Transient {
    const s = state();
    // Removal highlighting depends on the object lists; shift changes the water ring color.
    if (shift !== lastShift || lastSourcesRef !== s.sources || transientDirty) {
      lastShift = shift;
      lastSourcesRef = s.sources;
      transient = buildTransient();
      transientDirty = false;
    }
    return transient;
  }

  // Storms/shelters changes also affect the "would remove" ring color.
  const unsubscribe2 = store.subscribe((s, prev) => {
    if (s.storms !== prev.storms || s.shelters !== prev.shelters || s.grid !== prev.grid) transientDirty = true;
  });

  function destroy() {
    cancelGesture();
    if (bridge.scene === scene) bridge.scene = null;
    bridge.setHover(null);
    bridge.setWallStatus(null);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('pointerenter', onPointerEnter);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    win?.removeEventListener('keydown', onKey);
    win?.removeEventListener('keyup', onKey);
    win?.removeEventListener('blur', onBlur);
    win?.removeEventListener('resize', onResize);
    unsubscribe();
    unsubscribe2();
    try {
      renderer.camera.leftDragOrbits = true;
    } catch {
      /* ignore */
    }
    canvas.style.cursor = '';
  }

  return { getTransientOverlay, update, destroy };
}
