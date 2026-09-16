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
  OverlayState,
  PickResult,
  Shelter,
  StormCell,
  ToolController,
  ToolControllerDeps,
  ToolId,
  WaterSource,
} from '../contracts';
import { gridToGeoLocal } from './geo';
import { TOOL_BY_ID } from './toolDefs';

/** Max inflow + stage sources and storm cells the solver supports (DESIGN §3.2). */
export const MAX_SOURCES = 16;
export const MAX_STORMS = 8;
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
  let probeShown = false;
  let transient: Transient = { wallPreview: null, cursor: null };
  let transientDirty = true;
  const activePointers = new Set<number>();

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
          store.set({ error: `The solver supports up to ${MAX_SOURCES} water sources. Remove one first.` });
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
          store.set({ error: `The solver supports up to ${MAX_STORMS} storm cells. Remove one first.` });
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
      cancelGesture();
      applyCameraMode(s.tool);
      if (prev.tool === 'probe' && s.probe) store.set({ probe: null });
      probeShown = false;
      pointer.moved = true;
    }
    if (s.brushRadius !== prev.brushRadius || s.wallHeight !== prev.wallHeight) transientDirty = true;
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
    }

    // Hover pick for the cursor ring / probe / held brushes (once per frame at most).
    const wantsHover = tool !== 'orbit';
    if (wantsHover && pointer.inside && (gesture.kind === 'none' || gesture.kind === 'hold' || gesture.kind === 'click')) {
      const prevHover = hover;
      hover = pickAt(pointer.x, pointer.y);
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
      const t = now();
      if (hover && t - lastProbeAt >= 1000 / PROBE_HZ) {
        lastProbeAt = t;
        const geo = terrain ? gridToGeoLocal(terrain, hover.gx, hover.gy) : { lat: NaN, lon: NaN };
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
    if (g && hover && def && s.tool !== 'orbit') {
      let radius: number;
      let color: [number, number, number] = def.ringColor ?? [1, 1, 1];
      switch (s.tool) {
        case 'wall':
          radius = wallRadiusCells(s, g.cellSize);
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
        color = [1.0, 0.36, 0.38];
        radius = Math.max(radius, removeDistance(g) * 0.5);
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
