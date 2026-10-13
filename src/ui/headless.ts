/**
 * Headless batch runs of the scenario on screen — the machinery behind Site check's sweep and the flood-probability
 * ensemble: pause the user's flood, hold the 3-D view to a slow heartbeat (SimControl.setRenderHold), then for each
 * case apply its forcing, reset the water and run it a fixed simulated time at full speed (SimControl.runFor, in
 * chunks so Cancel answers within one), collect the result, and finally put the user's scenario back — forcing,
 * stage, Manning n, the water from its start, play/pause — whatever happened.
 *
 * Every case runs exactly `durationS` simulated seconds: with the user's flood paused, runFor stops the solver on its
 * target (FloodSolver.step's maxSimSeconds; src/app/runFor.ts), so the chunks add up to the duration to float
 * rounding whatever their size. (They used to overshoot by up to a readback each — 600 s ended at 614–706 s — which
 * made two runs of one level differ by more than the climate change being compared.) Progress is still read off
 * the simulation clock rather than summed from the requests.
 */
import type { AppActions, AppState, Store, TerrainData } from '../contracts';
import type { SimControl } from './bridge';

/** The parts of the user's scenario a batch may change, as they were before it. */
export interface SavedScenario {
  stageOffset: number;
  sources: AppState['sources'];
  storms: AppState['storms'];
  rainRate: number;
  manningN: number;
  paused: boolean;
}

export function saveScenario(s: AppState): SavedScenario {
  return { stageOffset: s.stageOffset, sources: s.sources, storms: s.storms, rainRate: s.sim.rainRate, manningN: s.sim.manningN, paused: s.paused };
}

export interface HeadlessCase {
  /** Set this case's forcing in the store (and anything else it needs) before the water is reset. */
  apply(): void | Promise<void>;
}

export interface HeadlessOptions<C extends HeadlessCase> {
  store: Store;
  actions: AppActions;
  sim: SimControl;
  /** The scene the batch is for; a different one appearing mid-run aborts it. */
  terrain: TerrainData;
  getTerrain(): TerrainData | null;
  cases: readonly C[];
  /** Simulated seconds per case. */
  durationS: number;
  /** Simulated seconds per runFor call (the cancel latency, and the snapshot cadence for `afterChunk`). */
  chunkS: number;
  /** Polled between chunks. */
  cancelled(): boolean;
  /** After each chunk (e.g. feed a snapshot accumulator), with the case index and its simulated clock. */
  afterChunk?(index: number, t: number): void;
  /** After the water reset that starts a case, before it runs. */
  afterReset?(index: number): void;
  /** The case has run its time: read and record its result. */
  collect(index: number, c: C): Promise<void>;
  /** 0–1 over the whole batch, with the case index. */
  onProgress?(fraction: number, index: number): void;
  /** Undo anything `apply` did outside the saved scenario (e.g. a bed perturbation). Runs before the final reset. */
  cleanup?(): void;
}

export interface HeadlessOutcome {
  /** Cases collected. */
  done: number;
  cancelled: boolean;
  /** Why it stopped early, or null. */
  error: string | null;
  seconds: number;
}

/** A case is done when its clock is this close to the duration, s (the chunks' sum carries float rounding). */
const CLOCK_SLACK_S = 1e-3;

/** Stores with a batch in flight: two at once (a sweep and an ensemble) would fight over the same scenario. */
const busyStores = new WeakSet<Store>();

/** Is a headless batch running on this store right now? */
export function headlessBusy(store: Store): boolean {
  return busyStores.has(store);
}

/** Run `cases` headless one after another and put the user's scenario back afterwards (see the header). */
export async function runHeadless<C extends HeadlessCase>(o: HeadlessOptions<C>): Promise<HeadlessOutcome> {
  const { store } = o;
  if (busyStores.has(store)) return { done: 0, cancelled: false, error: 'another batch run (a sweep or an ensemble) is in progress', seconds: 0 };
  busyStores.add(store);
  try {
    return await runBatch(o);
  } finally {
    busyStores.delete(store);
  }
}

async function runBatch<C extends HeadlessCase>(o: HeadlessOptions<C>): Promise<HeadlessOutcome> {
  const { store, actions, sim } = o;
  const saved = saveScenario(store.get());
  const t0 = performance.now();
  let done = 0;
  let error: string | null = null;
  store.set({ paused: true });
  sim.setRenderHold(true);
  try {
    for (let i = 0; i < o.cases.length; i++) {
      if (o.cancelled()) break;
      await o.cases[i].apply();
      actions.resetWater();
      o.afterReset?.(i);
      let t = sim.simClock();
      while (t < o.durationS - CLOCK_SLACK_S && !o.cancelled()) {
        await sim.runFor(Math.min(o.chunkS, o.durationS - t));
        if (o.getTerrain() !== o.terrain) throw new Error('the scene changed during the run');
        t = sim.simClock();
        o.afterChunk?.(i, t);
        o.onProgress?.((i + Math.min(1, t / o.durationS)) / o.cases.length, i);
      }
      if (o.cancelled()) break;
      await o.collect(i, o.cases[i]);
      done++;
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    // Put the user's scenario back: whatever the cases changed, then forcing, stage and roughness, then the water from
    // its start, then play/pause as it was.
    if (o.getTerrain() === o.terrain) {
      try {
        o.cleanup?.();
      } catch (err) {
        error ??= err instanceof Error ? err.message : String(err);
      }
      const s = store.get();
      store.set({ stageOffset: saved.stageOffset, sources: saved.sources, storms: saved.storms, sim: { ...s.sim, rainRate: saved.rainRate, manningN: saved.manningN } });
      actions.resetWater();
    }
    store.set({ paused: saved.paused });
    sim.setRenderHold(false);
  }
  return { done, cancelled: o.cancelled(), error, seconds: (performance.now() - t0) / 1000 };
}
