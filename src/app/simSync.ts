import type { AppState, FloodSolver, SimParams, Store } from '../contracts';
import { errorMessage, type ErrorReporter } from './errors';
import type { StageLevels } from './stage';

export interface SimSyncDeps {
  store: Store;
  stage: StageLevels;
  errors: ErrorReporter;
  getSolver(): FloodSolver | null;
  /** Start point or shelters changed → re-plan the evacuation route. */
  onRouteInputsChanged(): void;
}

/**
 * Store → solver synchronization. The store is the single source of truth for user-facing parameters;
 * this class pushes every relevant change into the current solver:
 *   • sim params (identity change) → solver.params = {...sim, ...overrides}   (rain lives in sim.rainRate)
 *   • sources / storms             → setSources / setStorms
 *   • stageOffset                  → stage source levels = base + offset (rewrites store.sources)
 * `overrides` lets automation (runFor) temporarily change e.g. timeScale without touching user state.
 */
export class SimSync {
  private overrides: Partial<SimParams> = {};
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: SimSyncDeps) {}

  install(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.deps.store.subscribe((s, prev) => this.onChange(s, prev));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  setOverrides(overrides: Partial<SimParams>): void {
    this.overrides = overrides;
    this.pushParams();
  }

  effectiveParams(): SimParams {
    return { ...this.deps.store.get().sim, ...this.overrides };
  }

  /** Push the complete current state into the solver (new solver). */
  pushAll(): void {
    const s = this.deps.store.get();
    this.pushParams();
    this.guard('setSources', (solver) => solver.setSources(s.sources));
    this.guard('setStorms', (solver) => solver.setStorms(s.storms));
  }

  pushParams(): void {
    const params = this.effectiveParams();
    this.guard('params', (solver) => {
      solver.params = params;
    });
  }

  private onChange(s: AppState, prev: AppState): void {
    const { stage, store } = this.deps;

    if (s.sources !== prev.sources) {
      // Sources are authoritative (UI edits, scenario restore): their levels already include the offset.
      stage.record(s.sources, s.stageOffset);
      this.guard('setSources', (solver) => solver.setSources(s.sources));
    } else if (s.stageOffset !== prev.stageOffset) {
      const sources = stage.apply(s.sources, s.stageOffset);
      // Re-entrant set: delivered to subscribers after this pass; the branch above then pushes to the solver.
      if (sources !== s.sources) store.set({ sources });
    }

    if (s.storms !== prev.storms) this.guard('setStorms', (solver) => solver.setStorms(s.storms));
    if (s.sim !== prev.sim) this.pushParams();
    if (s.evacStart !== prev.evacStart || s.shelters !== prev.shelters) this.deps.onRouteInputsChanged();
  }

  private guard(what: string, fn: (solver: FloodSolver) => void): void {
    const solver = this.deps.getSolver();
    if (!solver) return;
    try {
      fn(solver);
    } catch (err) {
      this.deps.errors.report('sim', `${what} failed: ${errorMessage(err)}`, err);
    }
  }
}
