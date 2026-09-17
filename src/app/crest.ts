import type { FloodSolver, Store, WaterSource } from '../contracts';
import { footprintRadius } from '../sim/forcing';
import { errorMessage, type ErrorReporter } from './errors';

/**
 * River crests arrive along the whole river at once.
 *
 * The stage slider raises the level of the stage sources, which sit at the domain edges. On its own that starts a
 * dam-break bore at every edge that needs ~8 km and ~20 sim-minutes to reach downtown Pittsburgh, at 11–14 m/s
 * (which also cuts the CFL timestep to a third). A real crest is a wave hours long: over an 8 km reach the river
 * rises everywhere at practically the same time. So when the stage goes UP, the water already in the river
 * channels connected to a stage source is raised to the new level right away, and overbank flooding starts from
 * every bank at once (measured on Pittsburgh at the 1936 crest: 4.1 km² flooded after 1.4 sim-min, against 0.7 km²
 * with the bore alone). Lowering the stage is left to the boundaries (the river drains out over time).
 *
 * "Channel" = cells wet in the scenario's initial fill that are 4-connected, through wet cells, to a stage source
 * footprint. Its base water surface is bed + initial depth per cell (so sloping rivers and different pools keep
 * their shape); at offset o the target surface is base + o.
 *
 * Two ways to apply it:
 *   • in place, if the solver implements `raiseWaterSurface` (h = max(h, target − bed), the added volume booked as
 *     inflow): works any time, including mid-flood and continuously while the slider is dragged;
 *   • otherwise by restarting the water from the initial fill with the channels raised (solver.setInitialWater),
 *     which resets the sim clock. That is only done while nothing has happened to the water yet (no flooded land,
 *     volume within a few % of the initial fill), i.e. nothing visible is lost — the "raise the river" moment at
 *     the start of a demo. Later raises fall back to the boundary bore.
 *
 * Reset water (R) is "the scenario start at the current river stage": the initial fill with the channels at the
 * current offset (otherwise R at the crest would replay the slow bore).
 */

/** Optional solver extension: raise the water surface in place (see handoff notes in the class comment). */
export interface RaiseWaterSurface {
  /** nx·ny water-surface elevations (m); for every finite entry h = max(h, level − bed). NaN leaves a cell alone. */
  raiseWaterSurface(level: Float32Array): void;
}

export function canRaiseInPlace(solver: FloodSolver): solver is FloodSolver & RaiseWaterSurface {
  return typeof (solver as Partial<RaiseWaterSurface>).raiseWaterSurface === 'function';
}

/** Initial-fill depth above which a cell counts as river channel. */
export const CHANNEL_WET_DEPTH = 0.05;

/**
 * Base water surface (m) of every channel cell connected to a stage source, NaN elsewhere; null if no stage
 * source touches wet water. `bed` = ground + barrier at the time of computation.
 */
export function channelBaseSurface(
  initialDepth: Float32Array,
  bedAt: (index: number) => number,
  nx: number,
  ny: number,
  sources: readonly WaterSource[],
): Float32Array | null {
  const n = nx * ny;
  const inChannel = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  const wet = (c: number) => initialDepth[c] > CHANNEL_WET_DEPTH;
  for (const s of sources) {
    if (s.type !== 'stage' || !Number.isFinite(s.gx) || !Number.isFinite(s.gy)) continue;
    const R = footprintRadius(s.radius);
    const i0 = Math.max(0, Math.floor(s.gx - R - 1));
    const i1 = Math.min(nx - 1, Math.ceil(s.gx + R + 1));
    const j0 = Math.max(0, Math.floor(s.gy - R - 1));
    const j1 = Math.min(ny - 1, Math.ceil(s.gy + R + 1));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        if (inChannel[c] || !wet(c) || Math.hypot(i + 0.5 - s.gx, j + 0.5 - s.gy) > R + 0.5) continue;
        inChannel[c] = 1;
        queue[tail++] = c;
      }
    }
  }
  if (tail === 0) return null;
  while (head < tail) {
    const c = queue[head++];
    const i = c % nx;
    if (i > 0 && !inChannel[c - 1] && wet(c - 1)) (inChannel[c - 1] = 1), (queue[tail++] = c - 1);
    if (i < nx - 1 && !inChannel[c + 1] && wet(c + 1)) (inChannel[c + 1] = 1), (queue[tail++] = c + 1);
    if (c >= nx && !inChannel[c - nx] && wet(c - nx)) (inChannel[c - nx] = 1), (queue[tail++] = c - nx);
    if (c + nx < n && !inChannel[c + nx] && wet(c + nx)) (inChannel[c + nx] = 1), (queue[tail++] = c + nx);
  }
  const base = new Float32Array(n).fill(NaN);
  for (let c = 0; c < n; c++) if (inChannel[c]) base[c] = bedAt(c) + initialDepth[c];
  return base;
}

/** Target surface at `offset` (NaN outside the channel), written into `out`. */
export function channelTarget(base: Float32Array, offset: number, out: Float32Array): Float32Array {
  for (let c = 0; c < base.length; c++) out[c] = base[c] + offset;
  return out;
}

/** Initial fill with the channel raised to base + offset: depth = max(initial, base + offset − bed). */
export function raisedInitialDepth(
  initialDepth: Float32Array,
  base: Float32Array,
  bedAt: (index: number) => number,
  offset: number,
): Float32Array {
  const out = Float32Array.from(initialDepth);
  if (!(offset > 0)) return out;
  for (let c = 0; c < out.length; c++) {
    const b = base[c];
    if (b === b) out[c] = Math.max(out[c], b + offset - bedAt(c));
  }
  return out;
}

export interface CrestScene {
  solver: FloodSolver;
  /** The scenario's initial fill (what solver.reset() restores until the fill is replaced here). */
  initialWater: Float32Array;
}

export interface CrestFillDeps {
  store: Store;
  errors: ErrorReporter;
  getScene(): CrestScene | null;
  /** The solver's water was reset (clock back to 0): the app resets its sim clock and wakes the renderer. */
  onWaterReset(): void;
}

/** Stage changes closer together than this form one gesture (a slider drag). */
const GESTURE_GAP_MS = 300;
/** Minimum spacing of in-place raises during a drag. */
const RAISE_INTERVAL_MS = 100;
/** Offsets closer than this are the same level. */
const EPS = 0.005;
/** "Nothing has happened to the water yet": flooded land and volume drift below these (see isPristine). */
const PRISTINE_FLOODED_M2 = 20_000;
const PRISTINE_FLOODED_FRACTION = 0.001;
const PRISTINE_VOLUME_DRIFT = 0.02;

export class CrestFill {
  /** Stage offset the channel water currently reflects (0 after a reset to the scenario fill). */
  private applied = 0;
  /** Offset baked into the solver's initial water by a restart (0 = the scenario's own fill). */
  private installed = 0;
  private installedVolume = NaN;
  private base: Float32Array | null | undefined;
  private baseKey = '';
  private target: Float32Array | null = null;
  private lastChangeAt = -Infinity;
  private lastRaiseAt = -Infinity;
  /** The current gesture started while the water was untouched: its final level restarts the water. */
  private gesturePristine = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: CrestFillDeps) {}

  /** A new scene is bound (or the old one is gone). */
  onSceneChanged(): void {
    this.cancelTimer();
    this.applied = 0;
    this.installed = 0;
    this.installedVolume = NaN;
    this.base = undefined;
    this.baseKey = '';
    this.target = null;
    this.lastChangeAt = -Infinity;
    this.gesturePristine = false;
  }

  /** store.stageOffset changed. */
  onStageOffset(offset: number, now = performance.now()): void {
    const scene = this.deps.getScene();
    const s = this.deps.store.get();
    if (!scene || s.loading || s.sim.stabilityMode === 'naive' || !Number.isFinite(offset)) {
      this.applied = Math.min(this.applied, Math.max(0, offset));
      return;
    }
    const inGesture = now - this.lastChangeAt < GESTURE_GAP_MS;
    this.lastChangeAt = now;

    if (canRaiseInPlace(scene.solver)) {
      if (offset <= this.applied + EPS) {
        this.applied = Math.max(0, offset);
        return;
      }
      if (now - this.lastRaiseAt >= RAISE_INTERVAL_MS) this.raiseInPlace(scene, offset, now);
      else this.schedule(RAISE_INTERVAL_MS - (now - this.lastRaiseAt));
      return;
    }

    // Restart path: decided once per gesture, from the state before the gesture changed anything.
    if (!inGesture) {
      if (offset <= this.applied + EPS) {
        this.applied = Math.max(0, offset);
        this.gesturePristine = false;
        return;
      }
      this.gesturePristine = this.isPristine(scene);
      if (this.gesturePristine) this.restart(scene, offset);
      else this.applied = offset; // too late for a restart: the boundaries carry this raise
    } else if (!this.gesturePristine) {
      this.applied = Math.max(0, offset);
    }
    if (this.gesturePristine) this.schedule(GESTURE_GAP_MS);
  }

  /**
   * Reset the water to the scenario start at the current river stage (actions.resetWater / resetAll). Returns
   * false if there is no solver.
   */
  resetWater(opts: { resetTerrain?: boolean } = {}): boolean {
    this.cancelTimer();
    this.gesturePristine = false;
    const scene = this.deps.getScene();
    if (!scene) return false;
    const { solver } = scene;
    const offset = Math.max(0, this.deps.store.get().stageOffset);
    const inPlace = canRaiseInPlace(solver);
    const base = offset > EPS || this.installed > EPS ? this.channelBase(scene) : null;
    // setInitialWater resets by itself; reset first only when terrain must be restored (the raised fill uses the bed).
    const reinstall = !!base && !inPlace && Math.abs(offset - this.installed) > EPS;
    if (!reinstall || opts.resetTerrain) solver.reset(opts.resetTerrain ? { resetTerrain: true } : undefined);
    this.applied = this.installed;
    if (reinstall) this.install(scene, offset, base);
    else if (base && inPlace && offset > EPS) this.raiseInPlace(scene, offset, performance.now());
    this.deps.onWaterReset();
    return true;
  }

  private raiseInPlace(scene: CrestScene, offset: number, now: number): void {
    const base = this.channelBase(scene);
    this.lastRaiseAt = now;
    this.applied = offset;
    if (!base || !canRaiseInPlace(scene.solver)) return;
    this.target ??= new Float32Array(base.length);
    try {
      scene.solver.raiseWaterSurface(channelTarget(base, offset, this.target));
    } catch (err) {
      this.deps.errors.report('sim', `raiseWaterSurface failed: ${errorMessage(err)}`, err);
    }
  }

  private restart(scene: CrestScene, offset: number): void {
    const base = this.channelBase(scene);
    this.applied = offset;
    if (!base) return;
    this.install(scene, offset, base);
    this.deps.onWaterReset();
  }

  /** Replace the solver's initial water with the fill at `offset` (this resets the water). */
  private install(scene: CrestScene, offset: number, base: Float32Array): void {
    const { solver } = scene;
    const depth = offset > EPS ? raisedInitialDepth(scene.initialWater, base, this.bedAt(solver), offset) : scene.initialWater;
    try {
      solver.setInitialWater(depth);
    } catch (err) {
      this.deps.errors.report('sim', `setInitialWater failed: ${errorMessage(err)}`, err);
      return;
    }
    this.installed = offset > EPS ? offset : 0;
    this.applied = this.installed;
    let sum = 0;
    for (let c = 0; c < depth.length; c++) sum += depth[c];
    this.installedVolume = sum * solver.cellSize * solver.cellSize;
  }

  /** Nothing has happened to the water since the last reset: no flooded land, volume ≈ the installed fill. */
  private isPristine(scene: CrestScene): boolean {
    const snap = scene.solver.getSnapshot();
    if (!snap) return true; // no readback since the reset yet
    const { floodedArea, volume } = snap.stats;
    if (!Number.isFinite(floodedArea) || !Number.isFinite(volume)) return false;
    const { solver } = scene;
    const area = solver.nx * solver.ny * solver.cellSize * solver.cellSize;
    if (floodedArea > Math.max(PRISTINE_FLOODED_M2, PRISTINE_FLOODED_FRACTION * area)) return false;
    let reference = this.installedVolume;
    if (!Number.isFinite(reference)) {
      let sum = 0;
      for (let c = 0; c < scene.initialWater.length; c++) sum += scene.initialWater[c];
      reference = this.installedVolume = sum * solver.cellSize * solver.cellSize;
    }
    return Math.abs(volume - reference) <= PRISTINE_VOLUME_DRIFT * Math.max(reference, 1000);
  }

  /** Trailing edge: in-place raise to the latest offset, or the gesture's final restart. */
  private schedule(ms: number): void {
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      const scene = this.deps.getScene();
      const s = this.deps.store.get();
      if (!scene || s.loading || s.sim.stabilityMode === 'naive') return;
      const offset = Math.max(0, s.stageOffset);
      if (canRaiseInPlace(scene.solver)) {
        if (offset > this.applied + EPS) this.raiseInPlace(scene, offset, performance.now());
      } else if (this.gesturePristine && Math.abs(offset - this.installed) > EPS) {
        this.restart(scene, offset);
      }
    }, Math.max(0, ms));
  }

  private cancelTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private channelBase(scene: CrestScene): Float32Array | null {
    const { solver } = scene;
    const stages = this.deps.store.get().sources.filter((s) => s.type === 'stage');
    // Levels change with the offset; only the footprints decide connectivity.
    const key = stages.map((s) => `${s.id}:${s.gx}:${s.gy}:${s.radius}`).join('|');
    if (this.base !== undefined && key === this.baseKey) return this.base;
    this.baseKey = key;
    try {
      this.base = channelBaseSurface(scene.initialWater, this.bedAt(solver), solver.nx, solver.ny, stages);
    } catch (err) {
      this.deps.errors.report('app', `river channel detection failed: ${errorMessage(err)}`, err);
      this.base = null;
    }
    return this.base;
  }

  private bedAt(solver: FloodSolver): (c: number) => number {
    const ground = solver.getGroundCPU();
    const barrier = solver.getBarrierCPU();
    return (c) => ground[c] + barrier[c];
  }
}
