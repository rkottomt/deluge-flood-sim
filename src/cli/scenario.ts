/**
 * Scenario flags → forcing, and the Site check ladders — pure functions (no GPU), unit-tested in tests/cli.
 *
 * A scenario is the preset's own forcing with the CLI's changes on top, in the app's units: a river stage as a gauge
 * reading in feet (Pittsburgh's 1936 crest is 46 ft, as on the slider), global rain in mm/hr, a forcing multiplier
 * (×k on rain, storm cells and inflows: the Site check ladder for presets without a stage), Manning n, and a future
 * climate (src/climate). `--scenario <level>` picks a rung of one of the preset's Site check ladders by id (`rp100`,
 * `record1936`, `a14-100`, `x0.5` …), the same levels the app sweeps.
 *
 * THE LADDERS are the app's (src/ui/siteCheck.ts buildLadder), chosen the same way (src/loss/ladders.ts ladderKinds):
 *   stage  a researched river / tide ladder (or a coastal scenario's tide-station levels), else the slider's marks;
 *   rain   NOAA Atlas 14 1-hour rain at the map centre (src/data/atlas14.ts, the same baked grid, read from disk), for
 *          maps Atlas 14 covers — a rain level is rain only: rivers at normal level, inflows and storm cells off, the
 *          level's intensity over the whole map for RAIN_DESIGN_DURATION_S, then run-off;
 *   scale  the scenario's forcing × multipliers.
 */
import type { ScenarioPreset, StageControl, StormCell, WaterSource } from '../contracts';
import type { Atlas14Point } from '../data/atlas14';
import { ladderFor, ladderKinds, LADDER_SOURCES, RAIN_DESIGN_DURATION_S, rainLadder, SCALE_LADDER, type LadderKind, type LadderLevel } from '../loss/ladders';
import { CLIMATE_HORIZONS, CLIMATE_PATHWAYS, CLIMATE_TODAY, RAIN_SCALINGS, type ClimateHorizon, type ClimatePathway, type ClimateSelection, type RainScaling } from '../climate/scenarios';
import { stageOffsetForFeet } from '../app/stage';

export type { LadderKind } from '../loss/ladders';

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
  /** Gauge reading, ft (stage ladders); NaN otherwise. */
  ft: number;
  /** Forcing multiplier (scale ladders); NaN otherwise. */
  scale: number;
  /** Uniform rain for the first RAIN_DESIGN_DURATION_S, mm/h (rain ladders); NaN otherwise. */
  mmPerHour: number;
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

/** What the ladders read from a scenario. */
export type LadderScenario = { stage?: StageControl | null; rainRate?: number; coastal?: { ladder: readonly LadderLevel[] } | null } | null | undefined;

export interface Ladder {
  /** The ladder built. */
  kind: LadderKind;
  /** Every ladder this scenario offers (the app's "Event ladder" choices). */
  kinds: LadderKind[];
  rungs: LadderRung[];
}

export interface LadderOptions {
  /** NOAA Atlas 14 at the map centre (null / absent: no rain ladder — outside coverage or not looked up). */
  rain?: Atlas14Point | null;
  /** A ladder by name (`--ladder`); absent = the one the app picks by itself. */
  kind?: LadderKind;
}

const rung = (r: Partial<LadderRung> & Pick<LadderRung, 'id' | 'label'>): LadderRung => ({ ft: NaN, scale: NaN, mmPerHour: NaN, sourceRp: null, source: '', sourceText: '', note: '', on: true, outOfRange: false, ...r });

/**
 * The ladder the app's Site check offers for a scenario (siteCheck.ts buildLadder): by default the one it picks itself
 * — a researched stage ladder, else (rain-led preset under Atlas 14) the rain ladder, else the slider's own marks, else
 * the forcing multipliers (× 0.5 and × 1 ticked).
 */
export function buildLadder(presetId: string | null, scenario: LadderScenario, opts: LadderOptions = {}): Ladder {
  const rain = opts.rain ?? null;
  const { kinds, auto } = ladderKinds(presetId, scenario, !!rain);
  if (opts.kind && !kinds.includes(opts.kind)) {
    const why = opts.kind === 'rain' ? ' (NOAA Atlas 14 does not cover this map)' : opts.kind === 'stage' ? ' (no river-stage control)' : '';
    throw new UsageError(`--ladder ${opts.kind}: not available for this preset${why} (one of ${kinds.join(', ')})`);
  }
  const kind = opts.kind ?? auto;
  const stage = scenario?.stage ?? null;
  const ladder = ladderFor(presetId, scenario);
  let rungs: LadderRung[];
  if (kind === 'rain' && rain) {
    rungs = rainLadder(rain).map((l) =>
      rung({ id: l.id, label: l.label, mmPerHour: l.mmPerHour, sourceRp: l.returnPeriod, source: l.source, sourceText: LADDER_SOURCES[l.source]?.text ?? '', note: `${l.ari}-yr average recurrence` }),
    );
  } else if (kind === 'stage' && stage && ladder) {
    rungs = ladder.map((l) => {
      const off = l.ft * FT + stage.gaugeDatum - stage.normalLevel;
      return rung({ id: l.id, label: l.label, ft: l.ft, sourceRp: l.returnPeriod, source: l.source, sourceText: LADDER_SOURCES[l.source]?.text ?? '', note: l.note ?? '', outOfRange: off < 0 || off > stage.maxOffset });
    });
  } else if (kind === 'stage' && stage) {
    rungs = [...(stage.floodStageFt != null ? [{ label: 'Flood stage', ft: stage.floodStageFt }] : []), ...(stage.marks ?? []).map((m) => ({ label: m.label, ft: m.ft }))].map((m, i) => rung({ id: `m${i}`, label: m.label, ft: m.ft }));
  } else {
    rungs = SCALE_LADDER.map((k) => rung({ id: `x${k}`, label: `Scenario forcing × ${k}`, scale: k, on: k === 0.5 || k === 1 }));
  }
  for (const r of rungs) if (r.outOfRange) r.on = false;
  return { kind, kinds, rungs };
}

/** Find a level by id in any ladder the scenario offers (the default one first). */
export function findLevel(presetId: string | null, scenario: LadderScenario, id: string, rain: Atlas14Point | null = null): { level: LadderRung | null; kind: LadderKind; known: string[] } {
  const first = buildLadder(presetId, scenario, { rain });
  const all = [first, ...first.kinds.filter((k) => k !== first.kind).map((k) => buildLadder(presetId, scenario, { rain, kind: k }))];
  for (const l of all) {
    const level = l.rungs.find((r) => r.id === id);
    if (level) return { level, kind: l.kind, known: [] };
  }
  return { level: null, kind: first.kind, known: all.flatMap((l) => l.rungs.map((r) => r.id)) };
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

/**
 * A rain level's forcing (siteCheck.ts runSweep, rain ladder): rain only — inflows off (the river stays at its normal
 * level: the caller sets stage offset 0), storm cells off, the level's intensity over the whole map.
 */
export function rainForcing(mmPerHour: number, base: { sources: readonly WaterSource[] }): { sources: WaterSource[]; storms: StormCell[]; rainRate: number } {
  return { sources: base.sources.filter((s) => s.type !== 'inflow').map((s) => ({ ...s })), storms: [], rainRate: mmPerHour };
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
  /** A ladder rung id (`rp100`, `a14-100`, `x0.5` …). */
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
  /** Simulated time at which the rain stops (an Atlas 14 level's 1-hour storm), s; null = it never stops. */
  rainStopsAtS: number | null;
}

/**
 * The preset's forcing with the flags applied. Order: a ladder level first (a stage, a rain level or a forcing
 * multiplier), then --scale, then --rain (absolute, after any multiplier; on a rain level it replaces the storm's
 * intensity and the rain no longer stops after the hour) and --stage-ft (overrides a level's stage).
 */
export function resolveForcing(
  presetId: string | null,
  scenario: (Pick<ScenarioPreset, 'sources' | 'storms' | 'rainRate' | 'stage'> & { coastal?: { ladder: readonly LadderLevel[] } | null }) | null,
  flags: ScenarioFlags,
  ctx: { rain?: Atlas14Point | null } = {},
): ResolvedForcing {
  const base = { sources: (scenario?.sources ?? []).map((s) => ({ ...s })), storms: (scenario?.storms ?? []).map((s) => ({ ...s })), rainRate: scenario?.rainRate ?? 0 };
  const stage = scenario?.stage ?? null;
  const changes: string[] = [];
  let f = { ...base };
  let stageOffset = 0;
  let level: LadderRung | null = null;
  let rainStopsAtS: number | null = null;
  if (flags.level !== undefined) {
    const found = findLevel(presetId, scenario, flags.level, ctx.rain ?? null);
    level = found.level;
    if (!level) {
      const hint = /^a14-/.test(flags.level) && !ctx.rain ? ' — NOAA Atlas 14 does not cover this map' : '';
      throw new UsageError(`--scenario: no level "${flags.level}" for this preset${hint} (one of ${found.known.join(', ')})`);
    }
    if (level.outOfRange) throw new UsageError(`--scenario ${level.id}: ${level.ft} ft is beyond this scenario's stage range`);
    if (Number.isFinite(level.ft) && stage) {
      stageOffset = stageOffsetForFeet(stage, level.ft);
      changes.push(`${level.label}: ${level.ft} ft`);
    } else if (Number.isFinite(level.mmPerHour)) {
      f = rainForcing(level.mmPerHour, f);
      rainStopsAtS = RAIN_DESIGN_DURATION_S;
      changes.push(`${level.label}: ${level.mmPerHour} mm/hr for ${RAIN_DESIGN_DURATION_S / 60} min, rain only (inflows and storm cells off)`);
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
    rainStopsAtS = null;
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
  return { stageOffset, sources: f.sources, storms: f.storms, rainRate: f.rainRate, manningN: flags.manning, changes, level, rainStopsAtS };
}

/** Gauge reading (ft) of a stage offset, or null without a stage. */
export function feetOf(stage: StageControl | null | undefined, offset: number): number | null {
  return stage ? (stage.normalLevel + offset - stage.gaugeDatum) / FT : null;
}
