/**
 * The terrain edit log: every wall, erase and dig / raise the user (or the one-click levee, or a loaded project) puts
 * on the map, in order and compacted, so a project can save it and a design comparison can swap edit sets in and out
 * (format.ts explains why a log rather than the barrier raster).
 *
 * The log is fed by a thin wrapper on the scene's solver instance (installEditRecorder, called by the app when a scene
 * is ready): applyBrush records the op after the solver has applied it, and reset({ resetTerrain }) empties the log.
 * Water brush ops are not terrain and are not recorded. While a comparison swaps designs in, the log is `suspended`
 * so the swaps do not overwrite the user's own edits, which are replayed afterwards.
 */
import type { BrushOp, FloodSolver, Store } from '../contracts';
import { brushOpValid, brushRect } from '../sim/brush';
import { PROJECT_LIMITS, RANGES, type ProjectEdit } from './format';

const POS_Q = 1000; // positions to 0.001 cell
const H_Q = 1000; // heights to 1 mm
const D_Q = 1e5; // terrain deltas to 0.01 mm (a dig frame is a few cm)
const q = (v: number, k: number) => Math.round(v * k) / k;
/** Wall ends this close (cells) are one joint. */
const JOIN_EPS = 1e-3;

/** A capsule that covers every cell of an nx × ny grid erases every wall (actions.clearWalls). */
export function erasesAll(op: { ax: number; ay: number; bx: number; by: number; radius: number }, nx: number, ny: number): boolean {
  const corners = [
    [0, 0],
    [nx, 0],
    [0, ny],
    [nx, ny],
  ];
  return corners.every(([x, y]) => capsule(x, y, op) <= op.radius);
}

function capsule(px: number, py: number, o: { ax: number; ay: number; bx: number; by: number }): number {
  const bax = o.bx - o.ax;
  const bay = o.by - o.ay;
  const t = Math.min(1, Math.max(0, ((px - o.ax) * bax + (py - o.ay) * bay) / Math.max(bax * bax + bay * bay, 1e-8)));
  return Math.hypot(px - o.ax - bax * t, py - o.ay - bay * t);
}

/**
 * Append one brush op to a compacted edit list (mutates `edits`). Returns false when the op is not a terrain edit
 * (water) or not valid.
 */
export function appendOp(edits: ProjectEdit[], op: BrushOp, grid: { nx: number; ny: number } | null): boolean {
  if (!brushOpValid(op)) return false;
  if (op.kind === 'water') return false;
  if (op.kind === 'wall') {
    const ax = q(op.ax, POS_Q);
    const ay = q(op.ay, POS_Q);
    const bx = q(op.bx, POS_Q);
    const by = q(op.by, POS_Q);
    // Inside the reader's range, or the saved file would not open (the wall tool keeps to 0.5–10 m anyway).
    const hh = q(Math.min(RANGES.wallHeight[1], Math.max(0, op.height)), H_Q);
    const r = q(op.radius, POS_Q);
    const last = edits[edits.length - 1];
    if (last && last.op === 'wall' && last.r === r && last.pts.length < PROJECT_LIMITS.maxWallPoints * 2) {
      const n = last.pts.length;
      if (Math.abs(last.pts[n - 2] - ax) <= JOIN_EPS && Math.abs(last.pts[n - 1] - ay) <= JOIN_EPS) {
        const segs = n / 2 - 1;
        const hs = typeof last.h === 'number' ? new Array<number>(segs).fill(last.h) : last.h;
        last.pts.push(bx, by);
        hs.push(hh);
        last.h = hs.every((v) => v === hs[0]) ? hs[0] : hs;
        return true;
      }
    }
    edits.push({ op: 'wall', pts: [ax, ay, bx, by], h: hh, r });
    return true;
  }
  if (op.kind === 'eraseWall') {
    if (grid && erasesAll(op, grid.nx, grid.ny)) {
      // Every wall before this one is gone: drop them (terrain edits stay — clearing walls leaves the ground alone).
      for (let i = edits.length - 1; i >= 0; i--) if (edits[i].op !== 'terrain') edits.splice(i, 1);
      return true;
    }
    edits.push({ op: 'erase', a: [q(op.ax, POS_Q), q(op.ay, POS_Q)], b: [q(op.bx, POS_Q), q(op.by, POS_Q)], r: q(op.radius, POS_Q) });
    return true;
  }
  // terrain
  const at: [number, number] = [q(op.gx, POS_Q), q(op.gy, POS_Q)];
  const r = q(op.radius, POS_Q);
  const [lo, hi] = RANGES.terrainDelta;
  const last = edits[edits.length - 1];
  // Merged digging on one spot stays inside the reader's range: past it, the next stroke starts a new entry (a dig
  // held for minutes would otherwise save a file that does not open).
  if (last && last.op === 'terrain' && last.r === r && last.at[0] === at[0] && last.at[1] === at[1] && last.d + op.delta >= lo && last.d + op.delta <= hi) {
    last.d = q(last.d + op.delta, D_Q);
    return true;
  }
  edits.push({ op: 'terrain', at, r, d: q(Math.min(hi, Math.max(lo, op.delta)), D_Q) });
  return true;
}

/** Cells one brush op touches on an nx × ny grid (its rectangle clipped to the grid: what the CPU mirror visits). */
export function opCells(op: BrushOp, grid: { nx: number; ny: number }): number {
  const r = brushRect(op, grid.nx, grid.ny);
  return r ? r.w * r.h : 0;
}

/**
 * What replaying an edit list costs: wall and dig points (PROJECT_LIMITS.maxEditPoints) and grid cells visited
 * (maxBrushCells). The reader and the edit log count alike, so a log the app records is a log it can open.
 */
export function editsCost(edits: readonly ProjectEdit[], grid: { nx: number; ny: number }): { points: number; cells: number } {
  let points = 0;
  let cells = 0;
  for (const e of edits) {
    if (e.op === 'wall') points += e.pts.length / 2;
    else if (e.op === 'terrain') points++;
  }
  for (const op of expandEdits(edits)) cells += opCells(op, grid);
  return { points, cells };
}

/** Compact a sequence of brush ops (water ops are dropped). */
export function compactOps(ops: readonly BrushOp[], grid: { nx: number; ny: number } | null = null): ProjectEdit[] {
  const out: ProjectEdit[] = [];
  for (const op of ops) appendOp(out, op, grid);
  return out;
}

/** The brush ops an edit list stands for, in order. */
export function expandEdits(edits: readonly ProjectEdit[]): BrushOp[] {
  const ops: BrushOp[] = [];
  for (const e of edits) {
    if (e.op === 'wall') {
      const n = e.pts.length / 2;
      if (n === 1) {
        ops.push({ kind: 'wall', ax: e.pts[0], ay: e.pts[1], bx: e.pts[0], by: e.pts[1], radius: e.r, height: typeof e.h === 'number' ? e.h : e.h[0] });
        continue;
      }
      for (let k = 0; k + 1 < n; k++) {
        const height = typeof e.h === 'number' ? e.h : e.h[k];
        ops.push({ kind: 'wall', ax: e.pts[2 * k], ay: e.pts[2 * k + 1], bx: e.pts[2 * k + 2], by: e.pts[2 * k + 3], radius: e.r, height });
      }
    } else if (e.op === 'erase') {
      ops.push({ kind: 'eraseWall', ax: e.a[0], ay: e.a[1], bx: e.b[0], by: e.b[1], radius: e.r });
    } else {
      ops.push({ kind: 'terrain', gx: e.at[0], gy: e.at[1], radius: e.r, delta: e.d });
    }
  }
  return ops;
}

/** Wall segments of an edit list (for costing): length in cells and height, m. Erases make the estimate approximate. */
export function wallSegments(edits: readonly ProjectEdit[]): { segments: Array<{ lengthCells: number; height: number }>; erased: boolean; terrain: boolean } {
  const segments: Array<{ lengthCells: number; height: number }> = [];
  let erased = false;
  let terrain = false;
  for (const e of edits) {
    if (e.op === 'erase') erased = true;
    else if (e.op === 'terrain') terrain = true;
    else {
      const n = e.pts.length / 2;
      for (let k = 0; k + 1 < n; k++) {
        segments.push({ lengthCells: Math.hypot(e.pts[2 * k + 2] - e.pts[2 * k], e.pts[2 * k + 3] - e.pts[2 * k + 1]), height: typeof e.h === 'number' ? e.h : e.h[k] });
      }
    }
  }
  return { segments, erased, terrain };
}

/** Counts for labels: walls (polylines), wall length in cells, erases, terrain edits. */
export function describeEdits(edits: readonly ProjectEdit[]): { walls: number; wallCells: number; erases: number; terrain: number } {
  let walls = 0;
  let wallCells = 0;
  let erases = 0;
  let terrain = 0;
  for (const e of edits) {
    if (e.op === 'wall') {
      walls++;
      for (let k = 0; k + 3 < e.pts.length; k += 2) wallCells += Math.hypot(e.pts[k + 2] - e.pts[k], e.pts[k + 3] - e.pts[k + 1]);
    } else if (e.op === 'erase') erases++;
    else terrain++;
  }
  return { walls, wallCells, erases, terrain };
}

export function cloneEdits(edits: readonly ProjectEdit[]): ProjectEdit[] {
  return edits.map((e) =>
    e.op === 'wall'
      ? { op: 'wall', pts: e.pts.slice(), h: typeof e.h === 'number' ? e.h : e.h.slice(), r: e.r }
      : e.op === 'erase'
        ? { op: 'erase', a: [e.a[0], e.a[1]], b: [e.b[0], e.b[1]], r: e.r }
        : { op: 'terrain', at: [e.at[0], e.at[1]], r: e.r, d: e.d },
  );
}

type Listener = () => void;

/** The edit log of the scene on screen (one per Store, like the UI bridge). */
export class EditLog {
  private list: ProjectEdit[] = [];
  private solverRef: FloodSolver | null = null;
  private grid: { nx: number; ny: number } | null = null;
  private suspendDepth = 0;
  /** The log hit PROJECT_LIMITS.maxEdits and stopped recording: a saved project would miss later edits. */
  overflow = false;
  /** Wall and dig points, and grid cells replaying the log visits (editsCost, kept up to date as ops arrive). */
  private points = 0;
  private cells = 0;
  private readonly fns = new Set<Listener>();

  get edits(): readonly ProjectEdit[] {
    return this.list;
  }
  get solver(): FloodSolver | null {
    return this.solverRef;
  }
  get suspended(): boolean {
    return this.suspendDepth > 0;
  }

  on(fn: Listener): () => void {
    this.fns.add(fn);
    return () => this.fns.delete(fn);
  }
  private emit(): void {
    for (const fn of this.fns) {
      try {
        fn();
      } catch (err) {
        console.error('[project] edit-log listener failed', err);
      }
    }
  }

  /** A new scene: a fresh, empty log for its solver. */
  attach(solver: FloodSolver | null): void {
    this.solverRef = solver;
    this.grid = solver ? { nx: solver.nx, ny: solver.ny } : null;
    this.list = [];
    this.overflow = false;
    this.points = 0;
    this.cells = 0;
    this.emit();
  }

  /**
   * Record one op. Past any budget the reader enforces (entries, points, cells — format.ts PROJECT_LIMITS) the op is
   * refused and `overflow` set (the op is still on the map; the panel says the log is full and a save says so), so a
   * saved project always opens again.
   */
  record(op: BrushOp): void {
    if (this.suspended || !brushOpValid(op) || op.kind === 'water') return;
    const cells = this.grid ? opCells(op, this.grid) : 0;
    // The most an op can add: two points (a new wall polyline) or one (a new dig spot).
    const pts = op.kind === 'wall' ? 2 : op.kind === 'terrain' ? 1 : 0;
    if (this.list.length >= PROJECT_LIMITS.maxEdits || this.points + pts > PROJECT_LIMITS.maxEditPoints || this.cells + cells > PROJECT_LIMITS.maxBrushCells) {
      if (!this.overflow) {
        this.overflow = true;
        this.emit();
      }
      return;
    }
    const n = this.list.length;
    if (!appendOp(this.list, op, this.grid)) return;
    if (op.kind === 'eraseWall' && this.grid && erasesAll(op, this.grid.nx, this.grid.ny)) this.recount();
    else if (this.list.length !== n) {
      // A new entry.
      this.points += pts;
      this.cells += cells;
    } else if (op.kind === 'wall') {
      // One more corner of the last polyline (a merged dig adds nothing: same spot, same rectangle).
      this.points += 1;
      this.cells += cells;
    }
    this.emit();
  }

  /** Points and cells of the whole log, from scratch (after Clear walls drops entries). */
  private recount(): void {
    const c = this.grid ? editsCost(this.list, this.grid) : { points: 0, cells: 0 };
    this.points = c.points;
    this.cells = c.cells;
  }

  /** The terrain was reset (walls and digging gone). */
  cleared(): void {
    if (this.suspended) return;
    this.list = [];
    this.overflow = false;
    this.points = 0;
    this.cells = 0;
    this.emit();
  }

  snapshot(): ProjectEdit[] {
    return cloneEdits(this.list);
  }

  /** Run `fn` without recording (design swaps during a comparison). */
  async withSuspended<T>(fn: () => T | Promise<T>): Promise<T> {
    this.suspendDepth++;
    try {
      return await fn();
    } finally {
      this.suspendDepth--;
    }
  }
  suspend(): void {
    this.suspendDepth++;
  }
  resume(): void {
    this.suspendDepth = Math.max(0, this.suspendDepth - 1);
  }
}

const logs = new WeakMap<Store, EditLog>();

export function editLogFor(store: Store): EditLog {
  let l = logs.get(store);
  if (!l) logs.set(store, (l = new EditLog()));
  return l;
}

const wrapped = new WeakSet<FloodSolver>();

/**
 * Record the terrain edits made on `solver` into the store's edit log (and start that log afresh). Wraps the
 * solver instance's applyBrush and reset once; the wrappers record only while this solver is the log's current one.
 */
export function installEditRecorder(store: Store, solver: FloodSolver): void {
  const log = editLogFor(store);
  log.attach(solver);
  if (wrapped.has(solver)) return;
  wrapped.add(solver);
  const apply = solver.applyBrush.bind(solver);
  const reset = solver.reset.bind(solver);
  solver.applyBrush = (op: BrushOp) => {
    apply(op);
    if (log.solver === solver) log.record(op);
  };
  solver.reset = (opts?: { resetTerrain?: boolean }) => {
    reset(opts);
    if (opts?.resetTerrain && log.solver === solver) log.cleared();
  };
}

/** Apply an edit list to a solver (ops in order). */
export function replayEdits(solver: FloodSolver, edits: readonly ProjectEdit[]): number {
  const ops = expandEdits(edits);
  for (const op of ops) solver.applyBrush(op);
  return ops.length;
}
