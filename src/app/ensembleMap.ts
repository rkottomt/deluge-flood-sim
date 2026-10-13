/**
 * Owns the GPU flood-probability accumulator (src/sim/ensemble.ts) for the scene on screen and lends it to the UI's
 * ensemble runner (src/ui/ensemble.ts) through SimControl.ensembleMap. Every accumulate hands the tally so far to the
 * renderer's probability view, so the map builds up member by member while the ensemble runs. A scene change drops it
 * (the renderer first, then the buffer).
 */
import type { FloodSolver } from '../contracts';
import type { DelugeRendererAPI } from '../render';
import { EnsembleAccumulator } from '../sim/ensemble';
import type { EnsembleMapControl } from '../ui/bridge';

export interface EnsembleMapDeps {
  getSolver(): FloodSolver | null;
  getRenderer(): Partial<DelugeRendererAPI> | null;
  requestRender(): void;
}

export class EnsembleMapHost {
  private acc: EnsembleAccumulator | null = null;

  constructor(private readonly deps: EnsembleMapDeps) {}

  /** The accumulator on the current solver's grid (created on first use), or null without a scene. */
  control(): EnsembleMapControl | null {
    const solver = this.deps.getSolver();
    if (!solver) return null;
    if (!this.acc || this.acc.device !== solver.device || this.acc.nx !== solver.nx || this.acc.ny !== solver.ny) {
      this.drop();
      this.acc = new EnsembleAccumulator(solver.device, solver.nx, solver.ny);
    }
    const acc = this.acc;
    const publish = () => {
      this.deps.getRenderer()?.setEnsembleLayer?.(acc.members > 0 ? acc.layer : null);
      this.deps.requestRender();
    };
    return {
      clear: () => {
        acc.clear();
        publish();
      },
      accumulate: () => {
        // Reading stateTexture exports the latest step first (its max depth is what gets folded in).
        acc.accumulate(solver.stateTexture);
        publish();
      },
      get members() {
        return acc.members;
      },
      read: () => acc.read(),
    };
  }

  /** The scene is going away: the renderer lets go of the buffer before it is destroyed. */
  drop(): void {
    if (!this.acc) return;
    this.deps.getRenderer()?.setEnsembleLayer?.(null);
    this.acc.destroy();
    this.acc = null;
  }
}
