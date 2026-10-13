/**
 * Scenario flags → forcing, and the Site check ladders — pure functions (no GPU), unit-tested in tests/cli.
 *
 * A scenario is the preset's own forcing with the CLI's changes on top, in the app's units: a river stage as a gauge
 * reading in feet (Pittsburgh's 1936 crest is 46 ft, as on the slider), global rain in mm/hr, a forcing multiplier
 * (×k on rain, storm cells and inflows: the Site check ladder for presets without a stage), Manning n, and a future
 * climate (src/climate). `--scenario <level>` picks a rung of the preset's Site check ladder by id (`rp100`,
 * `record1936`, `x0.5` …), the same levels the app sweeps.
 */
import type { ScenarioPreset, StageControl, StormCell, WaterSource } from '../contracts';
import { ladderFor, LADDER_SOURCES, SCALE_LADDER } from '../loss/ladders';
import { CLIMATE_HORIZONS, CLIMATE_PATHWAYS, CLIMATE_TODAY, RAIN_SCALINGS, type ClimateHorizon, type ClimatePathway, type ClimateSelection, type RainScaling } from '../climate/scenarios';
import { stageOffsetForFeet } from '../app/stage';

const FT = 0.3048;

/** A usage error: bad flag values (exit code 2). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** One rung of a Site check ladder (src/ui/siteCheck.ts LevelCfg, without the UI state). */
export interface LadderRung {
  id: string;
  label: string;
  /** Gauge reading, ft (stage ladders); NaN on a scale ladder. */
  ft: number;
  /** Forcing multiplier (scale ladders); NaN on a stage ladder. */
  scale: number;
  /** Return period from the cited source, years, or null. */
  sourceRp: number | null;
  source: string;
  sourceText: string;
  note: string;
  /** Ticked by default in the app. */
  on: boolean;
  /** Beyond the stage slider's range for this scenario (never run). */
  outOfRange: boolean;
}

/**
 * The ladder the app's Site check offers for a scenario (siteCheck.ts buildLadder): the preset's researched stage
 * ladder, else the slider's own marks, else the forcing multipliers (× 0.5 and × 1 ticked).
 */
export function buildLadder(presetId: string | null, stage: StageControl | null | undefined): LadderRung[] {
  const ladder = ladderFor(presetId);
  let rungs: LadderRung[];
  if (stage && ladder) {
    rungs = ladder.map((l) => {
      const off = l.ft * FT + stage.gaugeDatum - stage.normalLevel;
      return { id: l.id, label: l.label, ft: l.ft, scale: NaN, sourceRp: l.returnPeriod, source: l.source, sourceText: LADDER_SOURCES[l.source]?.text ?? '', note: l.note ?? '', on: true, outOfRange: off < 0 || off > stage.maxOffset };
    });
  } else if (stage) {
    rungs = [...(stage.floodStageFt != null ? [{ label: 'Flood stage', ft: stage.floodStageFt }] : []), ...(stage.marks ?? []).map((m) => ({ label: m.label, ft: m.ft }))].map((m, i) => ({
      id: `m${i}`,
      label: m.label,
      ft: m.ft,
      scale: NaN,
      sourceRp: null,
      source: '',
      sourceText: '',
      note: '',
      on: true,
      outOfRange: false,
    }));
  } else {
    rungs = SCALE_LADDER.map((k) => ({ id: `x${k}`, label: `Scenario forcing × ${k}`, ft: NaN, scale: k, sourceRp: null, source: '', sourceText: '', note: '', on: k === 0.5 || k === 1, outOfRange: false }));
  }
  for (const r of rungs) if (r.outOfRange) r.on = false;
  return rungs;
}

/** Rain, storm cells and inflows (hydrographs included) × k — the scale ladder's forcing (siteCheck.ts scaledForcing). */
export function scaledForcing(k: number, base: { sources: readonly WaterSource[]; storms: readonly StormCell[]; rainRate: number }): { sources: WaterSource[]; storms: StormCell[]; rainRate: number } {
  return {
    sources: base.sources.map((s) =>
      s.type === 'inflow' ? { ...s, discharge: s.discharge * k, ...(s.hydrograph ? { hydrograph: s.hydrograph.map((p) => ({ t: p.t, q: p.q * k })) } : {}) } : { ...s },
    ),
    storms: base.storms.map((s) => ({ ...s, intensity: s.intensity * k })),
    rainRate: base.rainRate * k,
  };
}

/** `2050:ssp585[:cc|super10|super14]`, `today`. */
export function parseClimate(text: string | undefined): ClimateSelection {
  if (text === undefined || text === '' || text === 'today') return { ...CLIMATE_TODAY };
  const [h, p = 'ssp585', s = 'cc'] = text.toLowerCase().split(':');
  const horizon = h as ClimateHorizon;
  const pathway = p.replace(/[-.]/g, '') as ClimatePathway;
  const scaling = s as RainScaling;
  if (!CLIMATE_HORIZONS.includes(horizon)) throw new UsageError(`--climate: unknown horizon "${h}" (one of ${CLIMATE_HORIZONS.join(', ')})`);
  if (!CLIMATE_PATHWAYS.includes(pathway)) throw new UsageError(`--climate: unknown pathway "${p}" (one of ${CLIMATE_PATHWAYS.join(', ')})`);
  if (!RAIN_SCALINGS.includes(scaling)) throw new UsageError(`--climate: unknown rain scaling "${s}" (one of ${RAIN_SCALINGS.join(', ')})`);
  return { horizon, pathway, scaling };
}

/** What the user asked to change about the preset's scenario. */
export interface ScenarioFlags {
  /** Gauge reading, ft. */
  stageFt?: number;
  /** Global rain, mm/hr. */
  rain?: number;
  /** Forcing multiplier (rain, storm cells, inflows). */
  scale?: number;
  /** A ladder rung id (`rp100`, `x0.5` …). */
  level?: string;
  manning?: number;
}

/** The forcing a scenario resolves to, in the store's terms. */
export interface ResolvedForcing {
  stageOffset: number;
  sources: WaterSource[];
  storms: StormCell[];
  rainRate: number;
  manningN: number | undefined;
  /** Plain-words description of what changed from the preset. */
  changes: string[];
  /** The ladder rung picked with --scenario, if any. */
  level: LadderRung | null;
}

/**
 * The preset's forcing with the flags applied. Order: a ladder level first (a stage, or a forcing multiplier), then
 * --scale, then --rain (absolute, after any multiplier) and --stage-ft (overrides a level's stage).
 */
export function resolveForcing(presetId: string | null, scenario: Pick<ScenarioPreset, 'sources' | 'storms' | 'rainRate' | 'stage'> | null, flags: ScenarioFlags): ResolvedForcing {
  const base = { sources: (scenario?.sources ?? []).map((s) => ({ ...s })), storms: (scenario?.storms ?? []).map((s) => ({ ...s })), rainRate: scenario?.rainRate ?? 0 };
  const stage = scenario?.stage ?? null;
  const changes: string[] = [];
  let f = { ...base };
  let stageOffset = 0;
  let level: LadderRung | null = null;
  if (flags.level !== undefined) {
    const ladder = buildLadder(presetId, stage);
    level = ladder.find((r) => r.id === flags.level) ?? null;
    if (!level) throw new UsageError(`--scenario: no level "${flags.level}" for this preset (one of ${ladder.map((r) => r.id).join(', ')})`);
    if (level.outOfRange) throw new UsageError(`--scenario ${level.id}: ${level.ft} ft is beyond this scenario's stage range`);
    if (Number.isFinite(level.ft) && stage) {
      stageOffset = stageOffsetForFeet(stage, level.ft);
      changes.push(`${level.label}: ${level.ft} ft`);
    } else if (Number.isFinite(level.scale)) {
      f = scaledForcing(level.scale, f);
      changes.push(`${level.label}`);
    }
  }
  if (flags.scale !== undefined) {
    if (!(flags.scale >= 0) || !Number.isFinite(flags.scale)) throw new UsageError('--scale must be a number ≥ 0');
    f = scaledForcing(flags.scale, f);
    changes.push(`forcing × ${flags.scale}`);
  }
  if (flags.rain !== undefined) {
    if (!(flags.rain >= 0) || flags.rain > 1000) throw new UsageError('--rain must be between 0 and 1000 mm/hr');
    f.rainRate = flags.rain;
    changes.push(`rain ${flags.rain} mm/hr`);
  }
  if (flags.stageFt !== undefined) {
    if (!stage) throw new UsageError('--stage-ft: this preset has no river-stage control (try --rain or --scale)');
    const off = stageOffsetForFeet(stage, flags.stageFt);
    const lo = (stage.normalLevel - stage.gaugeDatum) / FT;
    const hi = (stage.normalLevel + stage.maxOffset - stage.gaugeDatum) / FT;
    if (!(off >= -1e-9) || off > stage.maxOffset + 1e-9) throw new UsageError(`--stage-ft ${flags.stageFt}: outside this gauge's range ${lo.toFixed(1)}–${hi.toFixed(1)} ft`);
    stageOffset = Math.max(0, off);
    changes.push(`stage ${flags.stageFt} ft (${stage.label})`);
  }
  if (flags.manning !== undefined) {
    if (!(flags.manning >= 0.005 && flags.manning <= 0.3)) throw new UsageError('--manning must be between 0.005 and 0.3');
    changes.push(`Manning n ${flags.manning}`);
  }
  return { stageOffset, sources: f.sources, storms: f.storms, rainRate: f.rainRate, manningN: flags.manning, changes, level };
}

/** Gauge reading (ft) of a stage offset, or null without a stage. */
export function feetOf(stage: StageControl | null | undefined, offset: number): number | null {
  return stage ? (stage.normalLevel + offset - stage.gaugeDatum) / FT : null;
}
