/**
 * Coastal still-water levels by return period for any U.S. coastal point: NOAA CO-OPS Extreme Water Levels at the
 * nearest long-term tide station, put on the elevation model's datum (NAVD88) with that station's tidal datums.
 *
 * WHY THESE AND NOT SLOSH. NOAA's SLOSH "Maximum of Maximums" (MOMs) are the other national surge product, but they
 * are per hurricane CATEGORY, not per return period (no annual chance, so no expected annual loss), the public
 * National Storm Surge Hazard Maps are above-ground depth bins rather than a water level, and the MOMs themselves are
 * distributed through the SLOSH Display Program for emergency managers ("not meant for use by the general public").
 * The CO-OPS Extreme Water Levels are a frequency analysis — a GEV fitted to each station's annual maxima of observed
 * water level (astronomical tide + storm surge + the wave setup the gauge feels; no wave run-up), published as annual
 * exceedance probability levels above MHHW with 90 % confidence intervals. That is the same kind of number as NOAA
 * Atlas 14 for rain, so the surge ladder ends in an EAL with no input from the user.
 *
 * WHERE THE NUMBERS COME FROM. scripts/bake-surge.ts reads the CO-OPS derived-product and metadata APIs (the EWL
 * analyses, the station datums, and the NOAA 2022 sea-level-rise projections) into public/surge/ewl-stations.json
 * (≈ 120 stations, ≈ 40 kB), served from the app's own origin. This module parses it strictly: a size cap, an exact
 * format tag, a bounded station count, every field type- and range-checked, levels required to rise with return
 * period. A station that fails a check is dropped, never guessed.
 *
 * DATUMS. Levels are published above MHHW. USGS 3DEP elevations are NAVD88, so a level's elevation on the map is
 * (MHHW − NAVD88) + level. A station with no NAVD88 tie (Hawaii, the Pacific and Caribbean islands, parts of Alaska)
 * falls back to MSL, which is what the 3DEP and territorial DEMs there are referenced to — approximate, and labelled.
 */
import { fetchBytes } from '../data/net';

export const SURGE_FORMAT = 'deluge-ewl-1';
/** Annual exceedance probabilities baked per station, in file order (CO-OPS publishes 0.99 … 0.01). */
export const SURGE_AEPS = [0.99, 0.5, 0.1, 0.02, 0.01] as const;
/** Their return periods, years (1 / AEP). */
export const SURGE_RETURN_PERIODS = SURGE_AEPS.map((p) => 1 / p);
export const SURGE_LIMITS = {
  /** The real file is ~40 kB. */
  maxBytes: 512 * 1024,
  maxStations: 400,
  maxNameChars: 60,
  /** Far above any published EWL 1 % level (the bake prints the largest). */
  maxLevelM: 8,
  /** MHHW above NAVD88 / MSL: a few metres at most, even in Cook Inlet. */
  maxDatumM: 6,
  /** Furthest a station is used from the site, km. */
  maxDistanceKm: 120,
} as const;

export type SlrScenarioKey = 'low' | 'intLow' | 'int' | 'intHigh' | 'high';
export const SLR_SCENARIO_KEYS: readonly SlrScenarioKey[] = ['low', 'intLow', 'int', 'intHigh', 'high'];

export interface SurgeStation {
  /** CO-OPS station id, 7 digits. */
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  /** Tidal datum epoch, e.g. "1983-2001". */
  epoch: string;
  /** MHHW above NAVD88, m; null when the station has no NAVD88 tie. */
  mhhwNavd88: number | null;
  /** MHHW above MSL, m. */
  mhhwMsl: number;
  /** Still-water levels above MHHW, m, one per SURGE_AEPS. */
  levels: number[];
  /** 90 % confidence interval of the 1 % level, m above MHHW. */
  ci100: [number, number];
  /** NOAA 2022 relative SLR (median, m since 2005) at 2050 / 2080 / 2100 per scenario; null if not published here. */
  slr: Record<SlrScenarioKey, [number, number, number]> | null;
}

export interface SurgeTable {
  generated: string;
  stations: SurgeStation[];
  /** Stations the parser refused. */
  dropped?: number;
}

/** The bake's writer (stable key order, one station per line). */
export function encodeSurgeTable(t: SurgeTable): string {
  const lines = t.stations.map((s) => '    ' + JSON.stringify({ id: s.id, name: s.name, state: s.state, lat: s.lat, lon: s.lon, epoch: s.epoch, mhhwNavd88: s.mhhwNavd88, mhhwMsl: s.mhhwMsl, levels: s.levels, ci100: s.ci100, slr: s.slr }));
  return `{\n  "format": "${SURGE_FORMAT}",\n  "generated": ${JSON.stringify(t.generated)},\n  "aeps": ${JSON.stringify(SURGE_AEPS)},\n  "stations": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

const isNum = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length > 4 * max) return null;
  const s = v
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g, ' ')
    .replace(/[^A-Za-z0-9 .,'()/&-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.slice(0, max);
}

/** Validate one station; null when anything is out of range. */
function parseStation(o: unknown): SurgeStation | null {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^\d{7}$/.test(r.id)) return null;
  const name = cleanText(r.name, SURGE_LIMITS.maxNameChars);
  const state = cleanText(r.state ?? '', 4);
  const epoch = typeof r.epoch === 'string' && /^(\d{4}-\d{4})?$/.test(r.epoch) ? r.epoch : '';
  if (!name || state === null) return null;
  if (!isNum(r.lat, -20, 75) || !isNum(r.lon, -180, 180)) return null;
  const navd = r.mhhwNavd88 === null ? null : isNum(r.mhhwNavd88, -SURGE_LIMITS.maxDatumM, SURGE_LIMITS.maxDatumM) ? r.mhhwNavd88 : undefined;
  if (navd === undefined) return null;
  if (!isNum(r.mhhwMsl, 0, SURGE_LIMITS.maxDatumM)) return null;
  if (!Array.isArray(r.levels) || r.levels.length !== SURGE_AEPS.length) return null;
  const levels: number[] = [];
  for (const v of r.levels) {
    if (!isNum(v, -1, SURGE_LIMITS.maxLevelM)) return null;
    if (levels.length && v < levels[levels.length - 1]) return null;
    levels.push(v);
  }
  if (!Array.isArray(r.ci100) || r.ci100.length !== 2 || !isNum(r.ci100[0], -1, 3 * SURGE_LIMITS.maxLevelM) || !isNum(r.ci100[1], -1, 3 * SURGE_LIMITS.maxLevelM) || r.ci100[0] > r.ci100[1]) return null;
  let slr: SurgeStation['slr'] = null;
  if (r.slr !== null) {
    if (!r.slr || typeof r.slr !== 'object' || Array.isArray(r.slr)) return null;
    const s = r.slr as Record<string, unknown>;
    const out = {} as Record<SlrScenarioKey, [number, number, number]>;
    for (const k of SLR_SCENARIO_KEYS) {
      const v = s[k];
      if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => isNum(x, -2, 5))) return null;
      out[k] = [v[0], v[1], v[2]];
    }
    slr = out;
  }
  return { id: r.id, name, state, lat: r.lat, lon: r.lon, epoch, mhhwNavd88: navd, mhhwMsl: r.mhhwMsl, levels, ci100: [r.ci100[0], r.ci100[1]], slr };
}

/** Parse the baked table. Throws on a wrong shape; drops any station that fails a check. */
export function parseSurgeTable(input: string | Uint8Array): SurgeTable {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > SURGE_LIMITS.maxBytes) throw new Error('Surge table: file too large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Surge table: not UTF-8 text');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('Surge table: not JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Surge table: not an object');
  const d = doc as Record<string, unknown>;
  if (d.format !== SURGE_FORMAT) throw new Error('Surge table: unknown format');
  if (!Array.isArray(d.aeps) || d.aeps.length !== SURGE_AEPS.length || d.aeps.some((v, i) => v !== SURGE_AEPS[i])) throw new Error('Surge table: unexpected probabilities');
  if (!Array.isArray(d.stations) || d.stations.length < 1 || d.stations.length > SURGE_LIMITS.maxStations) throw new Error('Surge table: bad station count');
  const generated = typeof d.generated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.generated) ? d.generated : '';
  const stations: SurgeStation[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const o of d.stations) {
    const s = parseStation(o);
    if (!s || seen.has(s.id)) {
      dropped++;
      continue;
    }
    seen.add(s.id);
    stations.push(s);
  }
  if (!stations.length) throw new Error('Surge table: no valid station');
  return { generated, stations, dropped };
}

export function surgeTableUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? '/'}surge/ewl-stations.json`;
}

let tablePromise: Promise<SurgeTable> | null = null;

/** Download (once per page) and parse the table. Same-origin, size-capped. */
export function loadSurgeTable(url = surgeTableUrl()): Promise<SurgeTable> {
  tablePromise ??= fetchBytes(url, { maxBytes: SURGE_LIMITS.maxBytes, timeoutMs: 20000, retries: 1 })
    .then((buf) => parseSurgeTable(new Uint8Array(buf)))
    .catch((e) => {
      tablePromise = null;
      throw e;
    });
  return tablePromise;
}

export function resetSurgeCache(): void {
  tablePromise = null;
}

function km(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The nearest station within `maxKm`, or null. */
export function nearestStation(t: SurgeTable, lat: number, lon: number, maxKm: number = SURGE_LIMITS.maxDistanceKm): { station: SurgeStation; km: number } | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let best: { station: SurgeStation; km: number } | null = null;
  for (const s of t.stations) {
    const d = km(lat, lon, s.lat, s.lon);
    if (d <= maxKm && (!best || d < best.km)) best = { station: s, km: d };
  }
  return best;
}

/** MHHW on the elevation model's datum (NAVD88, or MSL where the station has no NAVD88 tie), m. */
export function mhhwOnDem(s: SurgeStation): { m: number; datum: 'NAVD88' | 'MSL' } {
  return s.mhhwNavd88 !== null ? { m: s.mhhwNavd88, datum: 'NAVD88' } : { m: s.mhhwMsl, datum: 'MSL' };
}

/** Return period as text: 1.01 → "1", 2 → "2". */
export function rpLabel(T: number): string {
  return T < 1.5 ? '1' : String(Math.round(T));
}

export interface SurgeLevel {
  id: string;
  label: string;
  /** Annual exceedance probability. */
  aep: number;
  returnPeriod: number;
  /** Above MHHW, m. */
  aboveMhhw: number;
  /** Elevation on the map's datum, m. */
  elevation: number;
}

/** The ladder for one station: one level per AEP, on the map's datum. */
export function surgeLevels(s: SurgeStation): SurgeLevel[] {
  const z0 = mhhwOnDem(s).m;
  return SURGE_AEPS.map((aep, i) => {
    const T = 1 / aep;
    return {
      id: `ewl-${rpLabel(T)}`,
      label: `NOAA ${Math.round(aep * 100)} % (${rpLabel(T)}-yr) water level`,
      aep,
      returnPeriod: T,
      aboveMhhw: s.levels[i],
      elevation: Math.round((z0 + s.levels[i]) * 1000) / 1000,
    };
  });
}

/** Ladder source key (src/loss/ladders.ts LADDER_SOURCES). */
export const SURGE_SOURCE_KEY = 'noaa-ewl';
/**
 * Default simulated time per surge level, minutes: the sea boundary rises over the stage ramp and the water then has to
 * cross the low ground of an up-to-20 km map, which takes far longer than a river crest spilling over its banks.
 */
export const SURGE_SWEEP_MINUTES = 90;

/** Caveats that travel with every surge-ladder result (panel and report). */
export const SURGE_LADDER_CAVEATS: readonly string[] = [
  'Still-water level only: NOAA’s Extreme Water Levels are what the tide gauge recorded (tide + surge + the wave setup the gauge feels), not wave run-up or the waves riding on the surge, which add metres on an open coast.',
  'One station for the whole map: the nearest long-term NOAA tide gauge, which may be tens of kilometres away and in a different bay — surge varies strongly along a coast and up estuaries.',
  'The level is held on the seaward edges of the map and floods inland over the simulated time; a real surge lasts hours and its peak minutes, so low ground far inland can come out wetter here than in a short peak. There is no sea-floor bathymetry (open water is the elevation model’s flat water surface, burned a few metres deep), so the surge crosses wide bays more slowly than it would: give each level enough simulated time (90 min by default).',
  'Bare-earth terrain: seawalls, levees, flood gates, buildings and storm drains are not in the elevation model unless you draw them.',
  'NOAA’s levels are stationary (fitted to the gauge record as if sea level did not rise). Today vs future adds NOAA’s 2022 sea-level-rise scenario at the same gauge.',
];
