import type { ScenarioPreset, StageControl, WaterSource } from '../contracts';

const FT = 0.3048;

/**
 * Tracks the BASE water-surface level of every stage source so the river-stage slider offsets from the
 * scenario's normal levels instead of accumulating. Invariant maintained by the app:
 *
 *     store.sources[k].level === base(k) + store.stageOffset      for every stage source k
 *
 * Sources arriving from the UI/debug API (added, removed or edited) re-derive their base from the
 * current offset; a stage-offset change rewrites the levels from the stored bases.
 */
export class StageLevels {
  private readonly bases = new Map<string, number>();

  /** Forget everything and take the given sources' levels as bases (offset 0). */
  resetFrom(sources: WaterSource[]): void {
    this.bases.clear();
    this.record(sources, 0);
  }

  /** Re-derive bases from sources whose levels already include `offset`. */
  record(sources: WaterSource[], offset: number): void {
    const live = new Set<string>();
    for (const s of sources) {
      if (s.type !== 'stage') continue;
      live.add(s.id);
      this.bases.set(s.id, s.level - offset);
    }
    for (const id of [...this.bases.keys()]) if (!live.has(id)) this.bases.delete(id);
  }

  /**
   * Return `sources` with stage levels = base + offset. Returns the SAME array when nothing changes
   * (so callers can skip a store update).
   */
  apply(sources: WaterSource[], offset: number): WaterSource[] {
    let changed = false;
    const out = sources.map((s) => {
      if (s.type !== 'stage') return s;
      const base = this.bases.get(s.id) ?? s.level;
      const level = base + offset;
      if (level === s.level) return s;
      changed = true;
      return { ...s, level };
    });
    return changed ? out : sources;
  }
}

/** Deep-enough copies of scenario lists so UI edits never mutate the preset itself. */
export function cloneScenarioLists(scenario: ScenarioPreset | null): Pick<ScenarioPreset, 'sources' | 'storms' | 'shelters'> {
  return {
    sources: (scenario?.sources ?? []).map((s) => ({ ...s })),
    storms: (scenario?.storms ?? []).map((s) => ({ ...s })),
    shelters: (scenario?.shelters ?? []).map((s) => ({ ...s })),
  };
}

/** Stage offset (m above normal level) corresponding to a gauge reading in feet. */
export function stageOffsetForFeet(stage: StageControl, feet: number): number {
  return feet * FT + stage.gaugeDatum - stage.normalLevel;
}

/** Gauge reading (ft) shown for a given stage offset. */
export function feetForStageOffset(stage: StageControl, offset: number): number {
  return (stage.normalLevel + offset - stage.gaugeDatum) / FT;
}
