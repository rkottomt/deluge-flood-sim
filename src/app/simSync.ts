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
 * Override layers let the app change e.g. timeScale (runFor automation) or the substep cap (frame-time
 * governor) without touching user-facing state.
 */
export class SimSync {
  /** Named override layers (e.g. 'runFor' → timeScale, 'governor' → maxSubstepsPerFrame), applied in order. */
  private readonly layers = new Map<string, Partial<SimParams>>();
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

  /** Replace (or with null/empty, remove) one override layer and push the result to the solver. */
  setOverride(layer: string, patch: Partial<SimParams> | null): void {
    if (!patch || Object.keys(patch).length === 0) {
      if (!this.layers.delete(layer)) return;
    } else {
      this.layers.set(layer, patch);
    }
    this.pushParams();
  }

  /** Convenience for the single default layer (automation). */
  setOverrides(overrides: Partial<SimParams>): void {
    this.setOverride('default', overrides);
  }

  /**
   * User params with override layers applied. `maxSubstepsPerFrame` layers can only LOWER the user's cap
   * (a work budget must never exceed what the user allowed); every other key replaces the value.
   */
  effectiveParams(): SimParams {
    const out: SimParams = { ...this.deps.store.get().sim };
    for (const patch of this.layers.values()) {
      for (const key of Object.keys(patch) as Array<keyof SimParams>) {
        const value = patch[key];
        if (value === undefined) continue;
        if (key === 'maxSubstepsPerFrame') out.maxSubstepsPerFrame = Math.min(out.maxSubstepsPerFrame, value as number);
        else (out as unknown as Record<string, unknown>)[key] = value;
      }
    }
    return out;
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
