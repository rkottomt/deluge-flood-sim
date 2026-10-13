/**
 * What a climate selection does to one scenario: the multipliers and offsets for this preset (climateForcing) and the
 * pure transforms that apply them to the forcing the solver receives (scaleSources, scaleStorms, scaleRain).
 *
 * Applying is a LAYER: the store keeps today's forcing (the rain slider, the inflow list and the stage slider keep their
 * meaning), and the app scales what it hands the solver (src/app/simSync.ts, src/app/climate.ts). "Today" is the
 * identity, so nothing changes until a future is chosen.
 *
 * Per preset:
 *   • rain and storm cells: × the extreme-rain multiplier, everywhere;
 *   • inflows of rain-fed rivers: × the same multiplier [M — peak discharge taken to scale like the rain that makes it;
 *     a wet catchment passes rain on nearly 1:1, a dry one less, so this is an upper-middle estimate]; a dam-break surge
 *     (Johnstown 1889) and a hazard-chain wave are NOT rain-fed and are left alone;
 *   • a coastal stage (Fort Myers): + NOAA's relative sea-level rise on the sea boundary, on top of the stage slider;
 *   • a river stage (Pittsburgh, Nashville): unchanged — no stage scaling is defensible (docs/research/climate-scenarios.md §C);
 *   • a glacial lake behind a hazard chain: area grown along its trend, volume from the V–A relations, chain re-run.
 */
import type { StormCell, WaterSource } from '../contracts';
import { volumeFromArea } from '../hazard/volume';
import {
  CLIMATE_REGIONS,
  CLIMATE_TODAY,
  type ClimateHorizon,
  type ClimatePathway,
  type ClimateRegion,
  type ClimateRegionId,
  type ClimateSelection,
  extraMeltPerDay,
  globalWarming,
  horizonYear,
  LAKE_TRENDS,
  lakeAreaAfterWarming,
  type LakeTrend,
  NOAA_SCENARIO_LABELS,
  PATHWAY_LABELS,
  PATHWAY_SLR_SCENARIO,
  RAIN_SCALING,
  rainMultiplier,
  seaLevelRise,
  TIDE_GAUGE_SLR,
  type TideGaugeSlr,
  type Warming,
  warmingBetween,
} from './scenarios';

export interface PresetClimateProfile {
  region: ClimateRegionId;
  /** What the scenario's stage boundary is: a river (never scaled) or the sea at a tide gauge (+ SLR). */
  stage: 'river' | { sea: string } | null;
  /** Inflow source ids that are NOT rain-fed (a dam break, a hazard-chain wave): never scaled. */
  fixedInflows?: readonly string[];
  /** Every inflow is a hazard-chain wave (not rain-fed). */
  chainInflows?: boolean;
  /** Glacial lake (LAKE_TRENDS key) behind the hazard chain, if the chain's source is a lake. */
  lake?: string;
  /** One line on what the climate control does here, for the panel. */
  note?: string;
}

/** Preset → climate profile. Live areas and the sandbox use DEFAULT_PROFILE (rain and all inflows scaled). */
export const PRESET_CLIMATE: Readonly<Record<string, PresetClimateProfile>> = {
  pittsburgh: { region: 'us-northeast', stage: 'river', note: 'The river stage is a boundary you set with the slider: it is not scaled.' },
  johnstown: { region: 'us-northeast', stage: null, fixedInflows: ['little-conemaugh-inflow'], note: 'The 1889 surge is a dam-break volume, not rain: only the Stonycreek inflow and rain are scaled.' },
  ellicott: { region: 'us-northeast', stage: null },
  asheville: { region: 'us-southeast', stage: null },
  nashville: { region: 'us-southeast', stage: 'river', note: 'The river stage is a boundary you set with the slider: it is not scaled.' },
  houston: { region: 'us-south-plains', stage: null },
  boulder: { region: 'us-southwest', stage: null },
  ftmyers: { region: 'us-southeast', stage: { sea: 'fort-myers' } },
  nepal: { region: 'hkh', stage: null, chainInflows: true, note: 'The flood is an ice-rock avalanche, not a lake: nothing in the chain is scaled.' },
  chungthang: { region: 'hkh', stage: null, chainInflows: true, lake: 'south-lhonak' },
  // No lake: the 2021 flow came from the Ronti Peak rock-and-ice collapse itself, and no sourced trend says how that
  // slope changes with warming — so nothing in the chain is scaled.
  chamoli: { region: 'hkh', stage: null, chainInflows: true, note: 'The flood is a rock-and-ice avalanche turned debris flow, not a lake or rain: nothing in the chain is scaled.' },
};

export const DEFAULT_PROFILE: PresetClimateProfile = { region: 'us', stage: null };

/**
 * The climate profile of a preset. A scenario with a hazard chain (ScenarioPreset.hazardChain) floods from a mass
 * movement or an outburst upstream, never from rain, so its inflows are chain inflows whatever the table says — a
 * chain preset missing from PRESET_CLIMATE must not fall back to rain-scaled US defaults.
 */
export function climateProfile(presetId: string | null | undefined, scenario?: ClimateScenarioHints | null): PresetClimateProfile {
  let p = presetId && Object.prototype.hasOwnProperty.call(PRESET_CLIMATE, presetId) ? PRESET_CLIMATE[presetId] : DEFAULT_PROFILE;
  if (scenario?.hazardChain && !p.chainInflows) p = { ...p, chainInflows: true };
  // A dam-breach wave is a reservoir's volume, not rain (src/dams): never scaled.
  if (scenario?.damBreach) p = { ...p, fixedInflows: [...(p.fixedInflows ?? []), 'dam-breach'], note: p.note ?? 'The dam-breach wave is the reservoir’s volume, not rain: it is not scaled.' };
  // A coastal live area (src/surge): its stage is the sea at its NOAA tide station, which carries its own SLR record.
  if (scenario?.coastal) p = { ...p, stage: { sea: scenario.coastal.slr?.id ?? `coops-${scenario.coastal.stationId}` } };
  return p;
}

/** The parts of a scenario the climate layer reads. */
export interface ClimateScenarioHints {
  hazardChain?: unknown;
  damBreach?: unknown;
  coastal?: { stationId: string; slr: TideGaugeSlr | null } | null;
}

export interface LakeChange {
  lake: LakeTrend;
  /** Area at the horizon, km². */
  area: number;
  areaFactor: number;
  /** Volume ratio from the V–A relations (the chain's volumeFactor). */
  volumeFactor: number;
  /** Global warming from the lake's reference year to the horizon, °C. */
  deltaT: number;
}

export interface ClimateForcing {
  selection: ClimateSelection;
  /** True when nothing is changed (Today). */
  identity: boolean;
  /** "Today" or e.g. "2050 · SSP5-8.5". */
  label: string;
  /** Global warming since 1995–2014, °C. */
  warming: Warming;
  region: ClimateRegion;
  /** Local warming, °C (global × regional factor). */
  localWarming: number;
  /** α of the chosen rain scaling. */
  alpha: number;
  /** Rain and storm-cell multiplier, with its range over the AR6 very likely warming range. */
  rainMult: number;
  rainMultRange: [number, number];
  /** Multiplier on rain-fed inflows (1 where there are none to scale). */
  inflowMult: number;
  /** Inflow ids left alone (dam break; every inflow on a chain preset). */
  fixedInflows: ReadonlySet<string>;
  chainInflows: boolean;
  /** Sea-level rise added to the sea boundary, m (0 when there is no sea gauge). */
  seaRiseM: number;
  seaGauge: TideGaugeSlr | null;
  seaScenario: string | null;
  /** River stage present and left alone. */
  riverStageUnscaled: boolean;
  lake: LakeChange | null;
  /** Extra clean-ice melt at the local warming, mm w.e./day (Himalayan presets). */
  meltPerDay: number | null;
  note: string | null;
}

export function climateLabel(sel: ClimateSelection): string {
  return sel.horizon === 'today' ? 'Today' : `${sel.horizon} · ${PATHWAY_LABELS[sel.pathway].short}`;
}

export function isTodaySelection(sel: ClimateSelection | null | undefined): boolean {
  return !sel || sel.horizon === 'today';
}

/** Lake change at a horizon under a pathway (null for Today). */
export function lakeChange(lake: LakeTrend, pathway: ClimatePathway, horizon: ClimateHorizon): LakeChange | null {
  if (horizon === 'today') return null;
  const deltaT = warmingBetween(pathway, lake.year0, horizonYear(horizon));
  const area = lakeAreaAfterWarming(lake, deltaT);
  const areaFactor = area / lake.area0;
  const v0 = volumeFromArea(lake.area0 * 1e6).median;
  const v1 = volumeFromArea(area * 1e6).median;
  return { lake, area, areaFactor, volumeFactor: v0 > 0 ? v1 / v0 : 1, deltaT };
}

/**
 * Everything a selection does to a preset's scenario. Today returns the identity. Pass the scenario when it is at
 * hand: a hazard chain in it marks the inflows as chain inflows (climateProfile).
 */
export function climateForcing(
  selection: ClimateSelection | null | undefined,
  presetId: string | null | undefined,
  scenario?: ClimateScenarioHints | null,
): ClimateForcing {
  const sel = selection ?? CLIMATE_TODAY;
  const profile = climateProfile(presetId, scenario);
  const region = CLIMATE_REGIONS[profile.region];
  const warming = globalWarming(sel.pathway, sel.horizon);
  const alpha = RAIN_SCALING[sel.scaling]?.alpha ?? RAIN_SCALING.cc.alpha;
  const identity = sel.horizon === 'today';
  const rainMult = identity ? 1 : rainMultiplier(warming.best, alpha);
  const rainMultRange: [number, number] = identity ? [1, 1] : [rainMultiplier(warming.lo, alpha), rainMultiplier(warming.hi, alpha)];
  const seaGauge = scenario?.coastal ? (scenario.coastal.slr ?? null) : profile.stage && typeof profile.stage === 'object' ? (TIDE_GAUGE_SLR[profile.stage.sea] ?? null) : null;
  const seaRiseM = seaGauge && !identity ? seaLevelRise(seaGauge, sel.pathway, sel.horizon) : 0;
  const lakeTrend = profile.lake ? (LAKE_TRENDS[profile.lake] ?? null) : null;
  const lake = lakeTrend ? lakeChange(lakeTrend, sel.pathway, sel.horizon) : null;
  const localWarming = warming.best * region.factor;
  return {
    selection: { ...sel },
    identity,
    label: climateLabel(sel),
    warming,
    region,
    localWarming,
    alpha,
    rainMult,
    rainMultRange,
    inflowMult: profile.chainInflows ? 1 : rainMult,
    fixedInflows: new Set(profile.fixedInflows ?? []),
    chainInflows: !!profile.chainInflows,
    seaRiseM,
    seaGauge,
    seaScenario: seaGauge ? NOAA_SCENARIO_LABELS[PATHWAY_SLR_SCENARIO[sel.pathway]] : null,
    riverStageUnscaled: profile.stage === 'river',
    lake,
    meltPerDay: profile.region === 'hkh' && !identity ? extraMeltPerDay(localWarming) : null,
    note: profile.note ?? null,
  };
}

/** Is this inflow scaled with the rain? */
export function inflowScaled(f: ClimateForcing, source: WaterSource): boolean {
  return source.type === 'inflow' && !f.chainInflows && !f.fixedInflows.has(source.id) && f.inflowMult !== 1;
}

/**
 * Sources as the solver should get them: rain-fed inflows (discharge and hydrograph) × inflowMult. Stage levels are not
 * touched here — sea-level rise is an offset on the stage boundary (src/app/App.ts). Returns the SAME array when nothing
 * changes.
 */
export function scaleSources(sources: WaterSource[], f: ClimateForcing | null): WaterSource[] {
  if (!f || f.identity) return sources;
  let changed = false;
  const out = sources.map((s) => {
    if (!inflowScaled(f, s) || s.type !== 'inflow') return s;
    changed = true;
    const k = f.inflowMult;
    return { ...s, discharge: s.discharge * k, ...(s.hydrograph ? { hydrograph: s.hydrograph.map((p) => ({ t: p.t, q: p.q * k })) } : {}) };
  });
  return changed ? out : sources;
}

/** Storm cells × rainMult (same array when nothing changes). */
export function scaleStorms(storms: StormCell[], f: ClimateForcing | null): StormCell[] {
  if (!f || f.identity || f.rainMult === 1 || storms.length === 0) return storms;
  return storms.map((s) => ({ ...s, intensity: s.intensity * f.rainMult }));
}

/** Uniform rain × rainMult. */
export function scaleRain(rainRate: number, f: ClimateForcing | null): number {
  if (!f || f.identity) return rainRate;
  return rainRate * f.rainMult;
}

/** Sea-level rise to add to the stage boundary, m. */
export function stageShift(f: ClimateForcing | null): number {
  return f && !f.identity ? f.seaRiseM : 0;
}

/**
 * Can the Site check compare today with this future by re-running its ladder? Yes for forcing ladders (rain / inflows),
 * the NOAA Atlas 14 rain ladder and sea-level ladders; no for a river-stage ladder (no stage scaling) or a hazard chain (its wave is re-routed
 * asynchronously by the chain, not by the sweep).
 */
export function sweepComparable(f: ClimateForcing, ladder: 'stage' | 'scale' | 'rain'): { ok: boolean; why: string } {
  if (f.identity) return { ok: false, why: 'Choose a future climate (Weather & rivers → Future climate) to compare.' };
  if (f.chainInflows) return { ok: false, why: 'The flood here comes from the hazard chain: apply the climate and re-run the sweep instead.' };
  if (ladder === 'stage' && f.riverStageUnscaled) return { ok: false, why: 'This ladder is river stages, which Deluge does not scale with climate (no defensible stage scaling).' };
  if (ladder === 'stage' && f.seaRiseM > 0) return { ok: true, why: '' };
  if (ladder === 'scale' && (f.rainMult !== 1 || f.inflowMult !== 1)) return { ok: true, why: '' };
  // The NOAA Atlas 14 rain ladder is rain only (inflows off), so only the rain multiplier changes it.
  if (ladder === 'rain' && f.rainMult !== 1) return { ok: true, why: '' };
  return { ok: false, why: 'This climate changes nothing the ladder runs.' };
}
