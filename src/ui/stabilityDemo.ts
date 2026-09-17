/**
 * "Break it" — the stability demo, started and stopped the same way from every button that offers it
 * (How it works, the getting-started strip, the Advanced switch, the red banner).
 *
 * At normal speeds the naive scheme's Δt is ~1.3 s and it diverges within about ten steps, i.e. in a fraction of
 * a second at 60×: the ripple → spike → NaN sequence is never visible. The demo therefore slows the clock to
 * BREAK_TIME_SCALE while it runs (a few real seconds of growth) and puts the user's speed back afterwards.
 */
import type { Store } from '../contracts';
import type { UIContext } from './dom';

/** Sim speed while the naive solver runs. */
export const BREAK_TIME_SCALE = 3;

const saved = new WeakMap<Store, number>();

export function isBreakDemo(store: Store): boolean {
  return store.get().sim.stabilityMode === 'naive';
}

export function startBreakDemo(ctx: Pick<UIContext, 'store' | 'actions'>): void {
  const { store, actions } = ctx;
  const s = store.get();
  if (s.sim.stabilityMode === 'naive') return;
  if (s.sim.timeScale !== BREAK_TIME_SCALE) saved.set(store, s.sim.timeScale);
  // setStabilityDemo patches `sim` from the current state, so the slower clock survives it.
  store.set({ paused: false, sim: { ...s.sim, timeScale: BREAK_TIME_SCALE } });
  actions.setStabilityDemo(true);
}

export function stopBreakDemo(ctx: Pick<UIContext, 'store' | 'actions'>): void {
  if (ctx.store.get().sim.stabilityMode !== 'naive') return;
  ctx.actions.setStabilityDemo(false);
}

/**
 * Put the user's sim speed back whenever the demo ends — from any button, or when the app leaves it on its own
 * (loading a scene). A speed the user picked during the demo is kept.
 */
export function installBreakDemoRestore(ctx: UIContext): void {
  const { store, bind } = ctx;
  bind(
    (s) => s.sim.stabilityMode,
    (mode) => {
      if (mode !== 'robust') return;
      const prev = saved.get(store);
      if (prev === undefined) return;
      saved.delete(store);
      const sim = store.get().sim;
      if (sim.timeScale === BREAK_TIME_SCALE) store.set({ sim: { ...sim, timeScale: prev } });
    },
  );
}
