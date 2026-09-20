import type { RoadNetwork } from '../contracts';

/**
 * "What did my wall save?" — land the walls keep dry, as a hydrostatic counterfactual on the latest depth field.
 *
 * Water pressing against a wall (a deep cell within two cells of a wall cell, part of a large body of water, not a
 * puddle) sets a level L: its own surface. From every such seed, highest level first, the level spreads across LAND
 * (anything but large bodies of water) whose bed lies below it, twice:
 *
 *   without walls — over the bare ground, so the flood passes where the walls stand;
 *   with walls    — over ground + barrier, so a wall taller than L stops it (open ends, gaps and overtopped
 *                   stretches do not).
 *
 * A cell is protected when the flood without walls would stand ≥ 0.3 m deep on it (the HUD's "flooded land"
 * threshold) and the flood with walls would not, and it is not flooded right now. Two breadth-first passes over the
 * cells below the level near the walls: a few ms for a levee on a 1024² grid, never more than two passes over the grid.
 *
 * It is a bathtub estimate at the current water level, not a second simulation: it ignores how long a gap would take
 * to fill the land behind it, and water that could reach the same land from somewhere the walls do not touch shows up
 * only once it actually arrives (the land is then flooded, no longer protected).
 */

export interface ProtectionInput {
  nx: number;
  ny: number;
  cellSize: number;
  /** Bare ground, row-major nx·ny, m. */
  ground: Float32Array;
  /** Wall height above the ground, nx·ny, m. */
  barrier: Float32Array;
  /** Current water depth, nx·ny, m. */
  depth: Float32Array;
  roads?: RoadNetwork | null;
  /** Roads as packed (gx, gy, length) midpoint triples (see roadMidpoints); used instead of `roads` when given. */
  roadMids?: Float32Array | null;
  /**
   * Changes whenever `ground` or `barrier` is edited (the solver's terrainVersion). With it, the wall cells found by
   * the last run are reused while it stays the same, so a run without walls costs nothing instead of a full-grid scan.
   */
  terrainVersion?: number;
}

export interface ProtectionResult {
  /** Cells carrying a wall. */
  wallCells: number;
  /** Protected cells (see above). */
  cells: number;
  /** Protected land, m². */
  areaM2: number;
  /** Road length whose midpoint lies on protected land, m. */
  roadMeters: number;
  /** Road segments whose midpoint lies on protected land. */
  roadEdges: number;
  /** Highest water level held back by the walls, m (null when no water presses against them). */
  level: number | null;
  /** nx·ny, 255 where protected (null when nothing is). Owned by the analyzer: valid until its next run. */
  mask: Uint8Array | null;
  /** Bounding box of protected cells (inclusive-exclusive), or null. */
  bounds: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Barrier above which a cell counts as wall, m. */
export const PROTECT_WALL_MIN = 0.2;
/** Depth of a water cell / of flooded land, m (the HUD's flooded-land threshold). */
export const PROTECT_DEPTH = 0.3;
/** A body of water needs this much area to press on a wall (smaller ones are ponds and puddles), m². */
export const PROTECT_BIG_WATER_M2 = 50_000;
/** A run waits until the terrain has not changed for this long, ms (see ProtectionController.tick). */
const EDIT_QUIET_MS = 300;
/** Cells from a wall cell within which water counts as pressing against it. */
const SEED_RING = 2;
/** Seeds stand at most this far above the 95th percentile of all seeds (see analyze), m. */
const SEED_LEVEL_SLACK = 0.15;

const EMPTY: ProtectionResult = { wallCells: 0, cells: 0, areaM2: 0, roadMeters: 0, roadEdges: 0, level: null, mask: null, bounds: null };

/** Growable Int32 list (visited cells: typically a small part of the grid). */
class IntList {
  data = new Int32Array(1 << 14);
  length = 0;
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
}

/**
 * Reusable work buffers (one analyzer per scene: allocating a few MB per run would churn the GC). A run only touches
 * the cells near the walls and the land below the water level behind them, and resets just those before the next run,
 * so its cost is one pass over the barrier field plus work proportional to that land (~2 ms for a 4 km levee on a
 * 1024² grid).
 */
export class ProtectionAnalyzer {
  private n = 0;
  private lvlBare = new Float32Array(0);
  private lvlWall = new Float32Array(0);
  /** Water body class per cell for this run: 0 unknown, 1 large, 2 small (a pond: counts as land), 3 exploring. */
  private water = new Uint8Array(0);
  private mask = new Uint8Array(0);
  /** Cells written in the previous run, reset at the start of the next one. */
  private readonly bareList = new IntList();
  private readonly wallList = new IntList();
  private readonly waterList = new IntList();
  private readonly maskList = new IntList();
  private readonly walls = new IntList();
  /** Which barrier array and terrain version `walls` was collected from (null: must rescan). */
  private wallsOf: { barrier: Float32Array; version: number } | null = null;
  private waterQueue = new Int32Array(0);

  private ensure(n: number): void {
    if (this.n === n) {
      for (let q = 0; q < this.bareList.length; q++) this.lvlBare[this.bareList.data[q]] = -Infinity;
      for (let q = 0; q < this.wallList.length; q++) this.lvlWall[this.wallList.data[q]] = -Infinity;
      for (let q = 0; q < this.waterList.length; q++) this.water[this.waterList.data[q]] = 0;
      for (let q = 0; q < this.maskList.length; q++) this.mask[this.maskList.data[q]] = 0;
    } else {
      this.n = n;
      this.lvlBare = new Float32Array(n).fill(-Infinity);
      this.lvlWall = new Float32Array(n).fill(-Infinity);
      this.water = new Uint8Array(n);
      this.mask = new Uint8Array(n);
    }
    this.bareList.length = 0;
    this.wallList.length = 0;
    this.waterList.length = 0;
    this.maskList.length = 0;
  }

  analyze(input: ProtectionInput): ProtectionResult {
    const { nx, ny, ground, barrier, depth } = input;
    const n = nx * ny;
    if (!(nx > 0 && ny > 0) || ground.length < n || barrier.length < n || depth.length < n) return EMPTY;

    // Wall cells: one pass over the barrier field, repeated only when the terrain changed (a 1024² scan is ~2 ms).
    const walls = this.walls;
    const version = input.terrainVersion;
    const cached = version !== undefined && this.wallsOf?.barrier === barrier && this.wallsOf.version === version;
    if (!cached) {
      walls.length = 0;
      for (let k = 0; k < n; k++) if (barrier[k] > PROTECT_WALL_MIN) walls.push(k);
      this.wallsOf = version !== undefined ? { barrier, version } : null;
    }
    const wallCells = walls.length;
    if (!wallCells) return EMPTY;
    this.ensure(n);

    const { water, lvlBare, lvlWall, mask, bareList, wallList, waterList, maskList } = this;
    const bigCells = Math.max(16, Math.ceil(PROTECT_BIG_WATER_M2 / (input.cellSize * input.cellSize)));
    if (this.waterQueue.length < bigCells + 8) this.waterQueue = new Int32Array(bigCells + 8);
    const wq = this.waterQueue;

    /** Classify the water body containing the water cell k0: flood fill bounded at bigCells, cached for the run. */
    const isLargeWater = (k0: number): boolean => {
      const w0 = water[k0];
      if (w0) return w0 === 1;
      let head = 0;
      let tail = 0;
      wq[tail++] = k0;
      water[k0] = 3;
      let large = false;
      while (head < tail && !large && tail < bigCells) {
        const k = wq[head++];
        const i = k % nx;
        for (let d = 0; d < 4; d++) {
          const m = d === 0 ? (i > 0 ? k - 1 : -1) : d === 1 ? (i < nx - 1 ? k + 1 : -1) : d === 2 ? k - nx : k + nx;
          if (m < 0 || m >= n || !(depth[m] >= PROTECT_DEPTH) || barrier[m] > PROTECT_WALL_MIN) continue;
          const w = water[m];
          if (w === 1) large = true;
          if (w) continue;
          water[m] = 3;
          wq[tail++] = m;
        }
      }
      if (tail >= bigCells) large = true;
      const cls = large ? 1 : 2;
      for (let q = 0; q < tail; q++) {
        water[wq[q]] = cls;
        waterList.push(wq[q]);
      }
      return large;
    };

    // Seeds: large-water cells within SEED_RING of a wall cell, with their surface level (lvlBare marks them seen).
    const seedK: number[] = [];
    const seedL: number[] = [];
    for (let q = 0; q < wallCells; q++) {
      const k = walls.data[q];
      const i = k % nx;
      const j = (k - i) / nx;
      const j0 = Math.max(0, j - SEED_RING);
      const j1 = Math.min(ny - 1, j + SEED_RING);
      const i0 = Math.max(0, i - SEED_RING);
      const i1 = Math.min(nx - 1, i + SEED_RING);
      for (let jj = j0; jj <= j1; jj++) {
        for (let ii = i0; ii <= i1; ii++) {
          const m = jj * nx + ii;
          if (lvlBare[m] !== -Infinity || !(depth[m] >= PROTECT_DEPTH) || barrier[m] > PROTECT_WALL_MIN) continue;
          const level = ground[m] + depth[m];
          if (!Number.isFinite(level) || !isLargeWater(m)) continue;
          seedK.push(m);
          seedL.push(level);
        }
      }
      // Mark the seeds of this neighbourhood seen only now, so a cell is tested once per run.
      for (let s = seedK.length - 1; s >= 0 && lvlBare[seedK[s]] === -Infinity; s--) {
        lvlBare[seedK[s]] = -1e30;
        bareList.push(seedK[s]);
      }
    }
    if (!seedK.length) return { ...EMPTY, wallCells };
    const order = seedK.map((_, q) => q).sort((a, b) => seedL[b] - seedL[a]);
    // A few cells of water piled against a wall by the flow (run-up where a fast current meets it) are not the level
    // the wall holds back: cap every seed at the 95th percentile of the seeds plus a little.
    const cap = seedL[order[Math.floor(order.length * 0.05)]] + SEED_LEVEL_SLACK;
    for (const q of order) if (seedL[q] > cap) seedL[q] = cap;

    /** Spread each seed's level over land whose bed lies below it (highest first). Visited cells go to `list`. */
    const spread = (lvl: Float32Array, list: IntList, withWalls: boolean) => {
      for (const q of order) {
        const k0 = seedK[q];
        const L = seedL[q];
        if (lvl[k0] > -1e29) continue; // reached by a higher seed already
        lvl[k0] = L;
        list.push(k0);
        let head = list.length - 1;
        while (head < list.length) {
          const k = list.data[head++];
          const i = k % nx;
          for (let d = 0; d < 4; d++) {
            const m = d === 0 ? (i > 0 ? k - 1 : -1) : d === 1 ? (i < nx - 1 ? k + 1 : -1) : d === 2 ? k - nx : k + nx;
            if (m < 0 || m >= n || lvl[m] > -1e29) continue; // off the grid, or visited (seed marks are -1e30)
            const bed = withWalls ? ground[m] + barrier[m] : ground[m];
            if (!(bed < L)) continue;
            // Land: anything but a large body of water (ponds count as land).
            if (depth[m] >= PROTECT_DEPTH && barrier[m] <= PROTECT_WALL_MIN && isLargeWater(m)) continue;
            lvl[m] = L;
            list.push(m);
          }
        }
      }
    };
    spread(lvlBare, bareList, false);
    spread(lvlWall, wallList, true);

    let cells = 0;
    let x0 = nx;
    let y0 = ny;
    let x1 = 0;
    let y1 = 0;
    let level = -Infinity;
    for (let q = 0; q < bareList.length; q++) {
      const k = bareList.data[q];
      const L = lvlBare[k];
      if (!(L > -1e29) || mask[k]) continue;
      const g = ground[k];
      if (L - g < PROTECT_DEPTH || barrier[k] > PROTECT_WALL_MIN || depth[k] >= PROTECT_DEPTH) continue;
      if (lvlWall[k] - g >= PROTECT_DEPTH) continue;
      mask[k] = 255;
      maskList.push(k);
      cells++;
      if (L > level) level = L;
      const i = k % nx;
      const j = (k - i) / nx;
      if (i < x0) x0 = i;
      if (i + 1 > x1) x1 = i + 1;
      if (j < y0) y0 = j;
      if (j + 1 > y1) y1 = j + 1;
    }
    if (!cells) return { ...EMPTY, wallCells, level: seedL[order[0]] };

    let roadMeters = 0;
    let roadEdges = 0;
    const mids = input.roadMids ?? (input.roads ? roadMidpoints(input.roads) : null);
    if (mids) {
      for (let q = 0; q + 2 < mids.length; q += 3) {
        const gx = mids[q];
        const gy = mids[q + 1];
        if (!(gx >= 0 && gy >= 0 && gx < nx && gy < ny)) continue;
        if (mask[Math.floor(gy) * nx + Math.floor(gx)]) {
          roadMeters += mids[q + 2];
          roadEdges++;
        }
      }
    }

    return {
      wallCells,
      cells,
      areaM2: cells * input.cellSize * input.cellSize,
      roadMeters,
      roadEdges,
      level: Number.isFinite(level) ? level : seedL[order[0]],
      mask,
      bounds: { x0, y0, x1, y1 },
    };
  }
}

const midCache = new WeakMap<RoadNetwork, Float32Array>();

/** Each road segment's midpoint vertex and length, packed as (gx, gy, length) triples (cached per network). */
export function roadMidpoints(roads: RoadNetwork): Float32Array {
  let mids = midCache.get(roads);
  if (!mids) {
    mids = new Float32Array(roads.edges.length * 3);
    roads.edges.forEach((e, q) => {
      const mid = Math.floor(e.pts.length / 4) * 2;
      mids![3 * q] = e.pts[mid] ?? NaN;
      mids![3 * q + 1] = e.pts[mid + 1] ?? NaN;
      mids![3 * q + 2] = e.length;
    });
    midCache.set(roads, mids);
  }
  return mids;
}

/** Whether any cell carries a wall (stops at the first one). */
export function hasWalls(barrier: Float32Array): boolean {
  for (let k = 0; k < barrier.length; k++) if (barrier[k] > PROTECT_WALL_MIN) return true;
  return false;
}

/**
 * Runs analyses off the main thread (src/app/protectionWorkerClient.ts: a Web Worker). A run on a 1024² grid is 2–3 ms
 * of warm work but often took 10–20 ms on the page's main thread, dropping a frame about every other second during the
 * levee demo; in a worker the page only copies the depth field.
 */
export interface ProtectionBackend {
  analyze(input: ProtectionInput): Promise<{ result: ProtectionResult; ms: number }>;
}

/** m² → acres. */
export const M2_PER_ACRE = 4046.8564224;

/** What the UI and the renderer receive after each analysis. */
export interface ProtectionSink {
  /** Summary for the UI (null = no walls / nothing to say). */
  publish(result: ProtectionResult | null): void;
}

/**
 * Runs the analysis on solver readbacks at most once per `intervalMs`, only while walls exist (a scan of the barrier
 * field is all it costs otherwise). Readbacks from a diverged or non-robust solver are skipped, so the
 * last physical answer stays up.
 */
export class ProtectionController {
  private readonly analyzer = new ProtectionAnalyzer();
  private pending = false;
  private lastRun = -Infinity;
  private published = false;
  /** The last run's collapse is waiting for confirmation. */
  private held = false;
  /** Milliseconds the last analysis took (diagnostics; in the worker when there is one). */
  lastMs = 0;
  last: ProtectionResult | null = null;
  /** Whether the barrier held walls at a terrain version (skips runs, and the worker, while there are none). */
  private walls: { barrier: Float32Array; version: number; any: boolean } | null = null;
  private backend: ProtectionBackend | null | undefined = undefined;
  /** A backend run is in flight (runs never overlap); `generation` drops answers from before a reset. */
  private inFlight = false;
  private generation = 0;
  /** The depth field, barrier array and terrain version of the last run. */
  private lastInput: { depth: Float32Array; barrier: Float32Array; version: number } | null = null;
  /** The newest terrain edit seen by tick, and when. */
  private editSeen: { barrier: Float32Array; version: number; at: number } | null = null;

  /**
   * `backend` creates the off-thread runner on first use (only once walls exist); without one, or once it fails, the
   * analysis runs synchronously on this thread.
   */
  constructor(
    private readonly sink: ProtectionSink,
    private readonly intervalMs = 1000,
    private readonly createBackend: (() => ProtectionBackend | null) | null = null,
  ) {}

  reset(): void {
    this.pending = false;
    this.lastRun = -Infinity;
    this.last = null;
    this.held = false;
    this.walls = null;
    this.lastInput = null;
    this.editSeen = null;
    this.inFlight = false;
    this.generation++;
    if (this.published) {
      this.published = false;
      this.sink.publish(null);
    }
  }

  /** A new physical readback arrived. */
  onSnapshot(): void {
    this.pending = true;
  }

  /**
   * Run when a readback is pending and the interval has passed, or every other interval regardless (walls drawn or
   * erased while paused bring no new readback). `force` skips the interval.
   */
  tick(now: number, input: () => ProtectionInput | null, force = false): void {
    if (this.inFlight) return;
    // On this thread, a heavy run (a rising flood spreads the level over a lot of shallow land) spaces the next ones
    // out, up to 3×: at most ~1–2 % of main-thread time.
    const interval = this.backend ? this.intervalMs : Math.max(this.intervalMs, Math.min(3 * this.intervalMs, this.lastMs * 80));
    const due = now - this.lastRun >= (this.pending ? interval : 2 * interval);
    if (!force && !due) return;
    const data = input();
    if (!data) return;
    // Walls going up (a drag, the one-click levee raising a piece every frame): wait until the edits pause rather than
    // copying the terrain for the worker on every run.
    const version = data.terrainVersion;
    if (version !== undefined && this.lastInput && (this.lastInput.barrier !== data.barrier || this.lastInput.version !== version)) {
      if (this.editSeen?.barrier !== data.barrier || this.editSeen.version !== version) this.editSeen = { barrier: data.barrier, version, at: now };
      if (!force && now - this.editSeen.at < EDIT_QUIET_MS) return;
    }
    this.pending = false;
    this.lastRun = now;
    // Same water on the same terrain as the last run (paused): nothing new to say.
    const seen = this.lastInput;
    if (!force && seen && data.terrainVersion !== undefined && seen.depth === data.depth && seen.barrier === data.barrier && seen.version === data.terrainVersion) return;
    this.lastInput = data.terrainVersion !== undefined ? { depth: data.depth, barrier: data.barrier, version: data.terrainVersion } : null;
    // No walls at this terrain version: nothing to analyse (checked once per terrain edit, stopping at the first wall).
    if (version === undefined || this.walls?.barrier !== data.barrier || this.walls.version !== version) {
      this.walls = version === undefined ? null : { barrier: data.barrier, version, any: hasWalls(data.barrier) };
    }
    if (this.walls && !this.walls.any) {
      this.lastMs = 0;
      this.accept({ ...EMPTY }, now);
      return;
    }
    if (this.backend === undefined) {
      try {
        this.backend = this.createBackend?.() ?? null;
      } catch {
        this.backend = null;
      }
      if (this.backend) {
        // Starting the worker costs the page a few ms, and its first run copies the terrain too: run on the next tick.
        this.lastInput = null;
        this.pending = true;
        this.lastRun = -Infinity;
        return;
      }
    }
    const backend = this.backend;
    if (backend) {
      const gen = this.generation;
      this.inFlight = true;
      backend.analyze(data).then(
        ({ result, ms }) => {
          if (gen !== this.generation) return;
          this.inFlight = false;
          this.lastMs = ms;
          this.accept(result, typeof performance !== 'undefined' ? performance.now() : now);
        },
        (err: unknown) => {
          if (gen !== this.generation) return;
          this.inFlight = false;
          if (this.backend === backend) this.backend = null;
          this.lastInput = null;
          this.pending = true;
          this.lastRun = -Infinity;
          console.warn('[deluge] protected-land worker failed, analysing on the main thread:', err);
        },
      );
      return;
    }
    const t0 = performance.now();
    const result = this.analyzer.analyze(data);
    this.lastMs = performance.now() - t0;
    this.accept(result, now);
  }

  private accept(result: ProtectionResult, now: number): void {
    if (result.wallCells === 0) {
      this.last = result;
      this.held = false;
      if (this.published) {
        this.published = false;
        this.sink.publish(null);
      }
      return;
    }
    // A sudden collapse of the protected area is confirmed by the next run (half an interval later) before it is shown:
    // one readback caught mid-surge should not make the green land blink off.
    const prev = this.last;
    if (!this.held && prev && prev.areaM2 > 0 && result.areaM2 < prev.areaM2 * 0.5 && result.wallCells === prev.wallCells) {
      this.held = true;
      this.pending = true;
      this.lastInput = null; // confirm even if the water has not changed (paused)
      this.lastRun = now - this.intervalMs / 2;
      return;
    }
    this.held = false;
    this.last = result;
    this.published = true;
    this.sink.publish(result);
  }
}
