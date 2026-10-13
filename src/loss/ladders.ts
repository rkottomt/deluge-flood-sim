/**
 * Event ladders for the site sweep: the river or tide levels a site is run against, per preset, each with where it
 * comes from and — only where a published frequency analysis gives one — its return period.
 *
 * Levels are gauge readings in FEET above the gauge datum, the same unit as StageControl.marks (the app converts them
 * with stageOffsetForFeet). Every number below was read from the source named next to it in October 2026; a
 * "converted" value is the source's NAVD88 elevation minus the gauge datum, and says so. A level without a return
 * period is NOT given one here: the panel asks the user for it and labels it "your input".
 *
 * Caveats that travel with the numbers (repeated in the report):
 *  • Pittsburgh and Nashville flows are regulated by upstream flood-control reservoirs (Pittsburgh: Tygart 1938,
 *    Crooked Creek 1940, … Kinzua 1965; the Allegheny County FIS says they "reduce major flood peaks at Pittsburgh by
 *    an average of 5 to 8 feet"). The 1936 crest predates them: the same storm today would crest lower.
 *  • FEMA's 1 % levels are read off National Flood Hazard Layer cross-sections near the gauge, not off a stage-frequency
 *    curve at the gauge; the 10 %, 2 % and 0.2 % stages are only on the FIS profile sheets and are not transcribed.
 *  • NOAA's Extreme Water Levels for Fort Myers are a still-water tide-gauge statistic with wide confidence intervals
 *    (1 %: 6.46 ft above MHHW, 90 % CI 4.56–11.13); they exclude waves.
 *  • NWS flood categories are impact thresholds, not frequencies.
 */

export type LadderGroup = 'nws' | 'frequency' | 'historic';

export interface LadderLevel {
  id: string;
  label: string;
  /** Gauge reading, ft above the gauge datum. */
  ft: number;
  group: LadderGroup;
  /** Return period in years from the cited source; null = none published (the user may enter one). */
  returnPeriod: number | null;
  /** Short source key into LADDER_SOURCES. */
  source: string;
  note?: string;
}

export interface LadderSource {
  key: string;
  text: string;
  url: string;
}

export const LADDER_SOURCES: Readonly<Record<string, LadderSource>> = {
  'nwps-pttp1': {
    key: 'nwps-pttp1',
    text: 'NOAA NWS National Water Prediction Service, Ohio River at Pittsburgh (PTTP1): flood categories action 18 / minor 22 / moderate 25 / major 28 ft; historic crests.',
    url: 'https://water.noaa.gov/gauges/pttp1',
  },
  'nfhl-pittsburgh': {
    key: 'nfhl-pittsburgh',
    text: 'FEMA National Flood Hazard Layer, cross-section A (Monongahela R. at the Point; the Ohio and Allegheny sections there agree): 1 %-annual-chance WSEL 728.98 ft NAVD88; gauge zero 693.6 ft NAVD88 → 35.38 ft (converted).',
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/14',
  },
  'fis-allegheny': {
    key: 'fis-allegheny',
    text: 'FEMA Flood Insurance Study, Allegheny County PA (rev. 26 Sep 2014): reservoir regulation; 1936 crest pre-dates it.',
    url: 'https://map1.msc.fema.gov/data/42/S/PDF/42003CV001B.pdf',
  },
  'nwps-nast1': {
    key: 'nwps-nast1',
    text: 'NOAA NWS National Water Prediction Service, Cumberland River at Nashville (NAST1): flood categories action 30 / minor 40 / moderate 42 / major 45 ft; historic crests (lists 2010 at 52.55 ft — the preset slider mark is 51.86 ft).',
    url: 'https://water.noaa.gov/gauges/nast1',
  },
  'nfhl-nashville': {
    key: 'nfhl-nashville',
    text: 'FEMA National Flood Hazard Layer, Cumberland River cross-sections BF/BG either side of the gauge: 1 % WSEL 415.1–415.5 ft NAVD88; gauge zero 367.45 ft NAVD88 → 47.65–48.05 ft (converted; midpoint used).',
    url: 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/14',
  },
  'fis-davidson': {
    key: 'fis-davidson',
    text: 'FEMA Flood Insurance Study, Davidson County TN (rev. 5 Apr 2017), p. 15: a stage of 49.0 ft at the Shelby Street / Riverfront Park gages "has about a 0.8 percent chance of occurring in any given year".',
    url: 'https://map1.msc.fema.gov/data/47/S/PDF/47037CV001B.pdf',
  },
  'coops-8725520': {
    key: 'coops-8725520',
    text: 'NOAA CO-OPS station 8725520 Fort Myers: datums (MHHW 5.68 ft above station datum; record 12.92 ft, Hurricane Ian, 29 Sep 2022) and NWS coastal flood thresholds minor 7.68 / moderate 9.18 / major 10.68 ft.',
    url: 'https://tidesandcurrents.noaa.gov/stationhome.html?id=8725520',
  },
  'ewl-8725520': {
    key: 'ewl-8725520',
    text: 'NOAA CO-OPS Extreme Water Levels, 8725520: annual exceedance levels above MHHW 50 % 1.60, 10 % 3.00, 2 % 5.15, 1 % 6.46 ft (1 % 90 % CI 4.56–11.13); + 5.68 ft MHHW → station-datum feet (converted). No 0.2 % level.',
    url: 'https://tidesandcurrents.noaa.gov/est/est_station.shtml?stnid=8725520',
  },
  'noaa-atlas14': {
    key: 'noaa-atlas14',
    text: 'NOAA Atlas 14 precipitation-frequency estimates, 60-minute duration, partial-duration series (NOAA / NWS Office of Water Prediction, Hydrometeorological Design Studies Center; public domain), read from a 1/12° resampling of the HDSC GIS grids at the centre of the map (within 3.4 % of PFDS point values at 11 test points). Return periods for the loss maths: 1 / AEP with AEP = 1 − e^(−1/ARI) (Langbein).',
    url: 'https://hdsc.nws.noaa.gov/pfds/',
  },
  'noaa-ewl': {
    key: 'noaa-ewl',
    text: 'NOAA CO-OPS Extreme Water Levels at the nearest long-term tide station (annual exceedance probability levels of a GEV fit to the annual maxima of observed water level: tide + surge + gauge-felt wave setup, no run-up; public domain), put on the map’s datum with the station’s tidal datums (MHHW above NAVD88, or MSL where there is no NAVD88 tie); baked into public/surge/ewl-stations.json by scripts/bake-surge.ts. Return periods are 1 / AEP.',
    url: 'https://tidesandcurrents.noaa.gov/est/',
  },
};

/** Ladders by preset id. Ordered by level. */
export const PRESET_LADDERS: Readonly<Record<string, readonly LadderLevel[]>> = {
  pittsburgh: [
    { id: 'minor', label: 'NWS minor flood', ft: 22, group: 'nws', returnPeriod: null, source: 'nwps-pttp1' },
    { id: 'moderate', label: 'NWS moderate flood', ft: 25, group: 'nws', returnPeriod: null, source: 'nwps-pttp1' },
    { id: 'major', label: 'NWS major flood', ft: 28, group: 'nws', returnPeriod: null, source: 'nwps-pttp1' },
    { id: 'ivan2004', label: '2004 Ivan crest', ft: 31, group: 'historic', returnPeriod: null, source: 'nwps-pttp1' },
    { id: 'rp100', label: 'FEMA 1 % (100-yr)', ft: 35.38, group: 'frequency', returnPeriod: 100, source: 'nfhl-pittsburgh' },
    { id: 'agnes1972', label: '1972 Agnes crest', ft: 35.8, group: 'historic', returnPeriod: null, source: 'nwps-pttp1' },
    { id: 'record1936', label: '1936 record crest', ft: 46, group: 'historic', returnPeriod: null, source: 'nwps-pttp1', note: 'pre-dates the flood-control reservoirs' },
  ],
  nashville: [
    { id: 'minor', label: 'NWS minor flood', ft: 40, group: 'nws', returnPeriod: null, source: 'nwps-nast1' },
    { id: 'moderate', label: 'NWS moderate flood', ft: 42, group: 'nws', returnPeriod: null, source: 'nwps-nast1' },
    { id: 'major', label: 'NWS major flood', ft: 45, group: 'nws', returnPeriod: null, source: 'nwps-nast1' },
    { id: 'rp100', label: 'FEMA 1 % (100-yr)', ft: 47.85, group: 'frequency', returnPeriod: 100, source: 'nfhl-nashville' },
    { id: 'fis125', label: 'FIS 0.8 % stage', ft: 49, group: 'frequency', returnPeriod: 125, source: 'fis-davidson', note: '"about a 0.8 percent chance"' },
    { id: 'flood2010', label: '2010 flood crest', ft: 51.86, group: 'historic', returnPeriod: null, source: 'nwps-nast1', note: 'NWPS lists 52.55 ft' },
    { id: 'flood1937', label: '1937 flood crest', ft: 53.9, group: 'historic', returnPeriod: null, source: 'nwps-nast1' },
    { id: 'record1927', label: '1927 record crest', ft: 56.2, group: 'historic', returnPeriod: null, source: 'nwps-nast1' },
  ],
  ftmyers: [
    { id: 'rp2', label: 'NOAA 50 % (2-yr) high water', ft: 7.28, group: 'frequency', returnPeriod: 2, source: 'ewl-8725520' },
    { id: 'minor', label: 'NWS minor coastal flood', ft: 7.68, group: 'nws', returnPeriod: null, source: 'coops-8725520' },
    { id: 'rp10', label: 'NOAA 10 % (10-yr)', ft: 8.68, group: 'frequency', returnPeriod: 10, source: 'ewl-8725520' },
    { id: 'moderate', label: 'NWS moderate coastal flood', ft: 9.18, group: 'nws', returnPeriod: null, source: 'coops-8725520' },
    { id: 'major', label: 'NWS major coastal flood', ft: 10.68, group: 'nws', returnPeriod: null, source: 'coops-8725520' },
    { id: 'rp50', label: 'NOAA 2 % (50-yr)', ft: 10.83, group: 'frequency', returnPeriod: 50, source: 'ewl-8725520' },
    { id: 'rp100', label: 'NOAA 1 % (100-yr)', ft: 12.14, group: 'frequency', returnPeriod: 100, source: 'ewl-8725520', note: '90 % CI 10.24–16.81 ft' },
    { id: 'ian2022', label: 'Hurricane Ian record', ft: 12.92, group: 'historic', returnPeriod: null, source: 'coops-8725520' },
  ],
};

/**
 * Forcing-multiplier ladder for presets without a stage control (rain, storm cells, inflows): the scenario's own
 * forcing × these factors. No frequency is known for any of them — the return period is always the user's input
 * (e.g. from NOAA Atlas 14 for a rain depth-duration, or a gauge analysis for an inflow).
 */
export const SCALE_LADDER: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25];

/**
 * Ladder for a preset, or null when it has no stage ladder (the forcing-multiplier ladder applies). A live area set up
 * for coastal surge (ScenarioPreset.coastal, src/surge/coastal.ts) carries its own: the nearest NOAA tide station's
 * extreme water levels.
 */
export function ladderFor(presetId: string | null, scenario?: { coastal?: { ladder: readonly LadderLevel[] } | null } | null): readonly LadderLevel[] | null {
  if (presetId && Object.prototype.hasOwnProperty.call(PRESET_LADDERS, presetId)) return PRESET_LADDERS[presetId];
  return scenario?.coastal?.ladder?.length ? scenario.coastal.ladder : null;
}

// ─── Rain return-period ladder (NOAA Atlas 14) ───────────────────────────────────────────────────────────────────────

/**
 * Design storm duration for the rain ladder, s. One hour: live areas are 1–20 km squares (5 km from "Check an
 * address"), and the times of concentration of the small urban catchments inside them are well under an hour — the
 * regime where the 1-hour intensity is the design rain (the rational method takes the intensity at the time of
 * concentration). Larger or slower catchments respond to longer storms, which the 1-hour storm understates; river
 * floods are not rain on the map at all (RAIN_LADDER_CAVEATS).
 */
export const RAIN_DESIGN_DURATION_S = 3600;
/** Default simulated time per rain level: the 1-hour storm plus an hour of run-off with the rain stopped. */
export const RAIN_SWEEP_MINUTES = 120;

export interface RainLadderLevel {
  id: string;
  label: string;
  /** Uniform rain rate over the domain for RAIN_DESIGN_DURATION_S, mm/h (= the 1-hour depth in mm). */
  mmPerHour: number;
  /** NOAA Atlas 14 partial-duration average recurrence interval, years. */
  ari: number;
  /** Return period for the loss maths, 1 / annual exceedance probability (Langbein: AEP = 1 − e^(−1/ARI)). */
  returnPeriod: number;
  source: 'noaa-atlas14';
}

/** Caveats that travel with every rain-ladder result (panel and report). */
export const RAIN_LADDER_CAVEATS: readonly string[] = [
  'Rain only: a uniform 1-hour storm over the whole map, then an hour of run-off. Rivers are held at their normal level and inflows and storm cells are off, so this is surface-water (pluvial) flooding, not a river or coastal flood.',
  'Run-off from outside the map is missing: a site low in a catchment larger than the map gets less water here than it would in reality.',
  'No storm drains or culverts, and infiltration is whatever Advanced → Infiltration is set to (default 0: every drop runs off).',
  'NOAA Atlas 14 is stationary: fitted to the historical record as if the climate did not change. For a warmer future, use Today vs future (Weather & rivers → Future climate).',
];

/** Return period for the loss maths of a PDS average recurrence interval (Langbein 1949). */
export function annualReturnPeriod(ari: number): number {
  return 1 / (1 - Math.exp(-1 / ari));
}

/** The rain ladder for an Atlas 14 point: one level per return period, 1-hour intensity. */
export function rainLadder(point: { levels: ReadonlyArray<{ ari: number; mmPerHour: number }> }): RainLadderLevel[] {
  return point.levels
    .filter((l) => Number.isFinite(l.mmPerHour) && l.mmPerHour > 0 && Number.isFinite(l.ari) && l.ari >= 1)
    .map((l) => ({
      id: `a14-${l.ari}`,
      label: `Atlas 14 ${l.ari}-yr 1-hour rain`,
      mmPerHour: Math.round(l.mmPerHour * 10) / 10,
      ari: l.ari,
      returnPeriod: annualReturnPeriod(l.ari),
      source: 'noaa-atlas14' as const,
    }));
}

// ─── Which ladder ────────────────────────────────────────────────────────────────────────────────────────────────────

/** stage: river / tide levels · scale: the scenario's forcing × multipliers · rain: NOAA Atlas 14 1-hour rain. */
export type LadderKind = 'stage' | 'scale' | 'rain';

/**
 * The event ladders a scenario can run, and the one the Site check picks by itself ('auto'): a researched river or
 * tide ladder (a preset's, or a coastal live area's tide-station levels) first; then, on a live area or a rain-led
 * preset where NOAA Atlas 14 covers the map, the rain ladder; then the stage slider's marks; else the forcing
 * multipliers. Shared by the panel (src/ui/siteCheck.ts) and the CLI (src/cli/scenario.ts), so `deluge site` sweeps
 * what the app sweeps.
 */
export function ladderKinds(
  presetId: string | null,
  scenario: { stage?: unknown; rainRate?: number; coastal?: { ladder: readonly LadderLevel[] } | null } | null | undefined,
  rainAvailable: boolean,
): { kinds: LadderKind[]; auto: LadderKind } {
  const st = !!scenario?.stage;
  const researched = st && !!ladderFor(presetId, scenario);
  const kinds: LadderKind[] = [...(st ? (['stage'] as const) : []), ...(rainAvailable ? (['rain'] as const) : []), 'scale'];
  const rainLed = presetId === null || (scenario?.rainRate ?? 0) > 0;
  const auto: LadderKind = researched ? 'stage' : rainAvailable && rainLed ? 'rain' : st ? 'stage' : 'scale';
  return { kinds, auto };
}
