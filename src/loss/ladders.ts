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

/** Ladder for a preset, or null when it has no stage ladder (the forcing-multiplier ladder applies). */
export function ladderFor(presetId: string | null): readonly LadderLevel[] | null {
  return presetId && Object.prototype.hasOwnProperty.call(PRESET_LADDERS, presetId) ? PRESET_LADDERS[presetId] : null;
}
