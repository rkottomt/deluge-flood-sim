/**
 * The future-climate layer (src/climate) for the scene on screen: recomputes the scenario's ClimateForcing when the
 * selection or the preset changes and tells the app, which re-pushes the forcing to the solver (SimSync scales rain,
 * storm cells and rain-fed inflows), shifts the sea boundary by the sea-level rise (on top of the stage slider, which
 * keeps its meaning) and hands a grown glacial lake to the hazard chain.
 */
import type { Store } from '../contracts';
import { climateForcing, stageShift, type ClimateForcing } from '../climate/apply';

export interface ClimateLayerDeps {
  store: Store;
  /** The forcing changed (prev → next): push it to the solver, the stage and the chain. */
  onChange(next: ClimateForcing, prev: ClimateForcing): void;
}

export class ClimateLayer {
  private forcing: ClimateForcing;
  private key: string;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: ClimateLayerDeps) {
    const s = deps.store.get();
    this.key = keyOf(s.climate, s.presetId, scenarioKey(s.scenario));
    this.forcing = climateForcing(s.climate, s.presetId, s.scenario);
  }

  install(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.deps.store.subscribe((s, prev) => {
      if (s.climate === prev.climate && s.presetId === prev.presetId && s.scenario === prev.scenario) return;
      this.refresh();
    });
  }

  /** Recompute from the store; notifies when the result differs. */
  refresh(): void {
    const s = this.deps.store.get();
    const key = keyOf(s.climate, s.presetId, scenarioKey(s.scenario));
    if (key === this.key) return;
    this.key = key;
    const prev = this.forcing;
    this.forcing = climateForcing(s.climate, s.presetId, s.scenario);
    this.deps.onChange(this.forcing, prev);
  }

  get(): ClimateForcing {
    return this.forcing;
  }

  /** Metres the sea boundary sits above the stage slider's level (sea-level rise; 0 elsewhere). */
  get stageShift(): number {
    return stageShift(this.forcing);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}

/** What the forcing depends on: the selection, the preset, and what its scenario carries (a hazard chain, a dam breach, a sea gauge). */
function keyOf(sel: { horizon: string; pathway: string; scaling: string } | undefined, presetId: string | null, scenario: string): string {
  return `${sel ? `${presetId}|${sel.horizon}|${sel.pathway}|${sel.scaling}` : `${presetId}|today`}|${scenario}`;
}

function scenarioKey(sc: { hazardChain?: unknown; damBreach?: { nidId: string }; coastal?: { stationId: string } } | null | undefined): string {
  return `${sc?.hazardChain ? 'chain' : ''}|${sc?.damBreach ? `dam:${sc.damBreach.nidId}` : ''}|${sc?.coastal ? `sea:${sc.coastal.stationId}` : ''}`;
}
