/**
 * "Break it" — the stability demo, started and stopped the same way from every button that offers it
 * (How it works, the getting-started strip, the Advanced switch, the red banner).
 *
 * At normal speeds the naive scheme's Δt is ~1.3 s and it diverges within about ten steps, i.e. in a fraction of
 * a second at 60×: the calm → spike → NaN sequence is never visible. The demo therefore slows the clock to
 * BREAK_TIME_SCALE until the solution has diverged (a few real seconds), then puts the user's speed back so the
 * NaN noise visibly spreads.
 *
 * Still water is a resting state even for the naive scheme: on a calm river it first blows up where water moves
 * fastest, usually an inflow at the edge of the map, far from where the viewer is looking (and often under the
 * Try-it strip). So the demo also drops a small splash of water into the river nearest the middle of the view — the
 * same kind of disturbance the robust scheme absorbs whenever someone pours water — and the blow-up starts there
 * and runs along the river (NaN only spreads through wet cells).
 */
import type { CameraPose, Store } from '../contracts';
import type { UIContext } from './dom';
import { bridgeFor } from './bridge';
import { isDiverged } from './stats';

/** Sim speed while the naive solver runs. */
export const BREAK_TIME_SCALE = 3;

/** Splash dropped at the camera target when the demo starts. */
export const BREAK_SPLASH = {
  /** Water added at the centre, m. */
  depth: 2,
  /** Radius as a fraction of the camera distance (≈ 2 % of the view width). */
  radiusOfDistance: 0.02,
  /** Radius limits, cells. */
  minCells: 4,
  maxCells: 40,
  /** The splash moves to the nearest water at least this deep… */
  wetDepth: 1,
  /** …within this fraction of the camera distance of the view centre. */
  searchOfDistance: 0.25,
};

/**
 * Nearest cell centre with depth ≥ minDepth within maxDist cells of (gx, gy), or null. Row-major depth (nx·ny);
 * scans the bounding box every `stride` cells (~0.1 ms for a 300-cell box at stride 2).
 */
export function nearestWet(
  depth: ArrayLike<number>,
  nx: number,
  ny: number,
  gx: number,
  gy: number,
  maxDist: number,
  minDepth: number,
  stride = 2,
): { gx: number; gy: number } | null {
  if (depth.length < nx * ny) return null;
  const i0 = Math.max(0, Math.floor(gx - maxDist));
  const i1 = Math.min(nx - 1, Math.ceil(gx + maxDist));
  const j0 = Math.max(0, Math.floor(gy - maxDist));
  const j1 = Math.min(ny - 1, Math.ceil(gy + maxDist));
  let best: { gx: number; gy: number } | null = null;
  let bestD = maxDist;
  for (let j = j0; j <= j1; j += stride) {
    for (let i = i0; i <= i1; i += stride) {
      const h = depth[j * nx + i];
      if (!(h >= minDepth)) continue;
      const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy);
      if (d <= bestD) {
        bestD = d;
        best = { gx: i + 0.5, gy: j + 0.5 };
      }
    }
  }
  return best;
}

/**
 * Water brush for the splash: in the water nearest the middle of the view when there is some (a splash on dry land
 * blows up in place but can't spread), else at the view centre. Null when the camera looks off the map.
 */
export function breakSplash(
  pose: Pick<CameraPose, 'target' | 'distance'> | null | undefined,
  grid: { nx: number; ny: number; cellSize: number },
  depth?: ArrayLike<number> | null,
): { kind: 'water'; gx: number; gy: number; radius: number; amount: number } | null {
  if (!pose || !(grid.cellSize > 0)) return null;
  let { gx, gy } = pose.target;
  if (!Number.isFinite(gx) || !Number.isFinite(gy) || gx < 0 || gy < 0 || gx > grid.nx || gy > grid.ny) return null;
  const distance = Number.isFinite(pose.distance) ? Math.max(0, pose.distance) : 0;
  if (depth) {
    const wet = nearestWet(depth, grid.nx, grid.ny, gx, gy, (distance * BREAK_SPLASH.searchOfDistance) / grid.cellSize, BREAK_SPLASH.wetDepth);
    if (wet) ({ gx, gy } = wet);
  }
  const cells = (distance * BREAK_SPLASH.radiusOfDistance) / grid.cellSize;
  const radius = Math.min(BREAK_SPLASH.maxCells, Math.max(BREAK_SPLASH.minCells, cells));
  return { kind: 'water', gx, gy, radius, amount: BREAK_SPLASH.depth };
}

const saved = new WeakMap<Store, number>();

export function startBreakDemo(ctx: Pick<UIContext, 'store' | 'actions'>): void {
  const { store, actions } = ctx;
  const s = store.get();
  if (s.sim.stabilityMode === 'naive') return;
  if (s.sim.timeScale !== BREAK_TIME_SCALE) saved.set(store, s.sim.timeScale);
  // setStabilityDemo patches `sim` from the current state, so the slower clock survives it.
  store.set({ paused: false, sim: { ...s.sim, timeScale: BREAK_TIME_SCALE } });
  actions.setStabilityDemo(true);
  const scene = bridgeFor(store).scene;
  try {
    const solver = scene?.getSolver() ?? null;
    const snap = solver?.getSnapshot() ?? null;
    const depth = solver && snap && snap.nx === solver.nx && snap.ny === solver.ny ? snap.depth : null;
    const splash = solver ? breakSplash(scene?.getCamera?.()?.pose, solver, depth) : null;
    if (solver && splash) solver.applyBrush(splash);
  } catch {
    /* no scene or renderer yet: the demo still breaks, just not in the middle of the view */
  }
}

export function stopBreakDemo(ctx: Pick<UIContext, 'store' | 'actions'>): void {
  if (ctx.store.get().sim.stabilityMode !== 'naive') return;
  ctx.actions.setStabilityDemo(false);
}

/** Real time the slowed clock keeps running after the solution has diverged, before the user's speed returns. */
const AFTER_DIVERGE_MS = 1500;

/**
 * Put the user's sim speed back once the slow part is over: shortly after the solution diverges (so the NaN
 * noise then spreads at the user's speed), or whenever the demo ends — from any button, or when the app leaves
 * it on its own (loading a scene). A speed the user picked during the demo is kept.
 */
export function installBreakDemoRestore(ctx: UIContext): void {
  const { store, bind } = ctx;
  let timer = 0;
  const restore = () => {
    clearTimeout(timer);
    const prev = saved.get(store);
    if (prev === undefined) return;
    saved.delete(store);
    const sim = store.get().sim;
    if (sim.timeScale === BREAK_TIME_SCALE) store.set({ sim: { ...sim, timeScale: prev } });
  };
  bind(
    (s) => s.sim.stabilityMode,
    (mode) => {
      if (mode === 'robust') restore();
    },
  );
  bind(
    (s) => s.sim.stabilityMode === 'naive' && isDiverged(s.stats),
    (diverged) => {
      clearTimeout(timer);
      if (diverged) timer = window.setTimeout(restore, AFTER_DIVERGE_MS);
    },
  );
}
