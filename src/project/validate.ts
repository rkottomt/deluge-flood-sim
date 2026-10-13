/**
 * Reading and writing project files (format.ts) — the reader trusts nothing.
 *
 *   parseProjectText(text, { fromLink })   text → { project, warnings } or { error }
 *   readProject(value, { fromLink })      an already-parsed value (the ?project= decoder) → the same
 *   projectToJson(project)                the file's text
 *
 * Order of defences: a character cap before anything else; a scan of the raw text for nesting depth (so a hostile
 * "[[[[…" never reaches a recursive walk); JSON.parse with a reviver that counts values and refuses `__proto__`,
 * `constructor` and `prototype` keys anywhere; then a field-by-field rebuild where every number is finite and inside its
 * range, every enum is from its list, every string is cleaned (cleanPlaceLabel: control, format and bidi characters
 * removed, NFKC, length-capped) — and nothing that was not rebuilt here reaches the caller. Error messages are FIXED
 * sentences: text from the file is never echoed into one.
 */
import { CLIMATE_HORIZONS, CLIMATE_PATHWAYS, RAIN_SCALINGS, type ClimateSelection } from '../climate/scenarios';
import type { CameraPose, HydrographPoint, Shelter, StormCell, WaterSource, WaterViewMode } from '../contracts';
import { cleanPlaceLabel, linkPlaceLabel } from '../data/placeName';
import { isPresetId } from '../data/presets';
import type { MitigationType } from '../loss/eal';
import { BCA_LIMITS } from '../loss/bca';
import { ENSEMBLE_LIMITS, RANGE_LIMITS } from '../loss/ensemble';
import { SITE_LIMITS, SITE_OCCUPANCIES, type SiteOccupancy } from '../loss/site';
import {
  PROJECT_FORMAT,
  PROJECT_LIMITS,
  PROJECT_VERSION,
  RANGES,
  type BcaSettings,
  type ComparisonSummary,
  type DesignCost,
  type DesignSpec,
  type EnsembleSettings,
  type LadderKind,
  type ProjectChain,
  type ProjectEdit,
  type ProjectFile,
  type ProjectScenario,
  type ProjectScene,
  type ProjectSite,
  type ProjectView,
  type SiteCheckSettings,
} from './format';
import { editsCost } from './edits';

export interface ReadOptions {
  /** The project came from a ?project= link: names are dropped (someone else's text), no portfolio, no cached results. */
  fromLink?: boolean;
}

export type ReadResult = { ok: true; project: ProjectFile; warnings: string[] } | { ok: false; error: string };

/** Fixed sentences only. */
export const PROJECT_ERRORS = {
  tooLarge: 'The file is too large to be a Deluge project.',
  notJson: 'The file is not valid JSON, so it is not a Deluge project.',
  tooDeep: 'The file is nested too deeply to be a Deluge project.',
  tooMany: 'The file holds too many values to be a Deluge project.',
  forbiddenKey: 'The file contains a reserved key (__proto__, constructor or prototype) and was refused.',
  notProject: 'The file is not a Deluge project (its "format" is missing or different).',
  newer: 'The project was saved by a newer version of Deluge (a later format version) and cannot be read here.',
  invalid: 'The project file is damaged or was edited by hand: a required part did not pass the checks.',
  tooHeavy: 'The project’s walls and terrain edits cover more of the map than Deluge replays when opening a project (a link carries far less than a file), so it was refused.',
} as const;

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const WATER_MODES: readonly WaterViewMode[] = ['realistic', 'depth', 'maxDepth', 'velocity', 'arrival', 'hazard', 'probability'];
const MITIGATION_TYPES: readonly MitigationType[] = ['earthen', 'floodwall', 'gabion'];
const LADDERS: readonly LadderKind[] = ['stage', 'scale', 'rain'];
const TIMES_OF_DAY = ['daylight', 'goldenHour', 'morning'] as const;
const ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;
/** SimParams keys a project may carry: the user-facing ones and any numeric / boolean parameter a later solver adds. */
const SIM_KEY_RE = /^[A-Za-z][A-Za-z0-9]{0,39}$/;
/** Internal solver tunables a project never sets ('naive' is the deliberately unstable reference scheme). */
const SIM_DENY = new Set(['stabilityMode', 'cfl', 'maxSubstepsPerFrame']);
const SIM_RANGES: Record<string, readonly [number, number]> = {
  manningN: RANGES.manning,
  rainRate: RANGES.rain,
  infiltrationRate: [0, 1000],
  timeScale: [0, 3600],
};
/** A numeric SimParams key without its own range (a later solver's) is kept inside this. */
const SIM_GENERIC: readonly [number, number] = [-1e6, 1e6];

class Invalid extends Error {}
const fail = (): never => {
  throw new Invalid(PROJECT_ERRORS.invalid);
};

// ─── primitives ────────────────────────────────────────────────────────────────────────────────────────────────────
type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function obj(v: unknown): Obj {
  return isObj(v) ? v : fail();
}
function num(v: unknown, range: readonly [number, number]): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= range[0] && v <= range[1] ? v : fail();
}
function int(v: unknown, range: readonly [number, number]): number {
  const n = num(v, range);
  return Number.isInteger(n) ? n : fail();
}
function optNum(v: unknown, range: readonly [number, number]): number | null {
  return v === undefined || v === null ? null : num(v, range);
}
function optInt(v: unknown, range: readonly [number, number]): number | null {
  return v === undefined || v === null ? null : int(v, range);
}
function bool(v: unknown): boolean {
  return typeof v === 'boolean' ? v : fail();
}
function oneOf<T extends string>(v: unknown, list: readonly T[]): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fail();
}
function arr(v: unknown, max: number): unknown[] {
  return Array.isArray(v) && v.length <= max ? v : fail();
}
function text(v: unknown, max: number): string {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > max * 8) fail();
  return cleanPlaceLabel(v, max);
}
function id(v: unknown): string {
  return typeof v === 'string' && ID_RE.test(v) && !FORBIDDEN_KEYS.has(v) ? v : fail();
}
function pair(v: unknown, range: readonly [number, number]): [number, number] {
  const a = arr(v, 2);
  if (a.length !== 2) fail();
  return [num(a[0], range), num(a[1], range)];
}

/** Section readers that may fail on their own (the section is dropped with a warning; the rest of the file stands). */
function optional<T>(v: unknown, read: (v: unknown) => T, warnings: string[], what: string): T | null {
  if (v === undefined || v === null) return null;
  try {
    return read(v);
  } catch (err) {
    if (!(err instanceof Invalid)) throw err;
    warnings.push(`The ${what} in the project could not be read and were left as they are.`);
    return null;
  }
}

// ─── raw text checks ───────────────────────────────────────────────────────────────────────────────────────────────
/** Maximum bracket nesting of JSON text, ignoring brackets inside strings; stops early past `limit`. */
export function jsonDepth(s: string, limit = Infinity): number {
  let depth = 0;
  let max = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) {
      if (c === 92) i++; // backslash: skip the escaped char
      else if (c === 34) inStr = false;
      continue;
    }
    if (c === 34) inStr = true;
    else if (c === 123 || c === 91) {
      depth++;
      if (depth > max) {
        max = depth;
        if (max > limit) return max;
      }
    } else if (c === 125 || c === 93) depth--;
  }
  return max;
}

/** JSON.parse with the value count and reserved-key checks; throws Invalid-free errors as fixed results. */
function parseGuarded(t: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (t.length > PROJECT_LIMITS.maxFileChars) return { ok: false, error: PROJECT_ERRORS.tooLarge };
  if (jsonDepth(t, PROJECT_LIMITS.maxDepth) > PROJECT_LIMITS.maxDepth) return { ok: false, error: PROJECT_ERRORS.tooDeep };
  let nodes = 0;
  let forbidden = false;
  let value: unknown;
  try {
    value = JSON.parse(t, (k, v) => {
      nodes++;
      if (FORBIDDEN_KEYS.has(k)) forbidden = true;
      return v;
    });
  } catch {
    return { ok: false, error: PROJECT_ERRORS.notJson };
  }
  if (forbidden) return { ok: false, error: PROJECT_ERRORS.forbiddenKey };
  if (nodes > PROJECT_LIMITS.maxNodes) return { ok: false, error: PROJECT_ERRORS.tooMany };
  return { ok: true, value };
}

/** Value count, depth and reserved keys of an already-parsed value (iterative; for readProject on non-text input). */
function checkShape(v: unknown): string | null {
  const stack: Array<{ v: unknown; d: number }> = [{ v, d: 1 }];
  let nodes = 0;
  while (stack.length) {
    const { v: x, d } = stack.pop()!;
    if (++nodes > PROJECT_LIMITS.maxNodes) return PROJECT_ERRORS.tooMany;
    if (typeof x !== 'object' || x === null) continue;
    if (d > PROJECT_LIMITS.maxDepth) return PROJECT_ERRORS.tooDeep;
    if (Array.isArray(x)) {
      for (const y of x) stack.push({ v: y, d: d + 1 });
    } else {
      if (Object.getPrototypeOf(x) !== Object.prototype && Object.getPrototypeOf(x) !== null) return PROJECT_ERRORS.invalid;
      for (const k of Object.keys(x)) {
        if (FORBIDDEN_KEYS.has(k)) return PROJECT_ERRORS.forbiddenKey;
        stack.push({ v: (x as Obj)[k], d: d + 1 });
      }
    }
  }
  return null;
}

// ─── sections ──────────────────────────────────────────────────────────────────────────────────────────────────────
function readScene(v: unknown, opts: ReadOptions): ProjectScene {
  const o = obj(v);
  const kind = oneOf(own(o, 'kind'), ['preset', 'live'] as const);
  if (kind === 'preset') {
    const pid = own(o, 'id');
    return isPresetId(pid) ? { kind: 'preset', id: pid } : fail();
  }
  const lat = num(own(o, 'lat'), [-85, 85]);
  const lon = num(own(o, 'lon'), [-180, 180]);
  const sizeM = num(own(o, 'sizeM'), [1000, 20000]);
  const resolution = own(o, 'resolution');
  if (resolution !== 512 && resolution !== 1024 && resolution !== 2048) fail();
  const rawName = own(o, 'name');
  // A link may label a place but not write a sentence (SEC-01): the link rule, and the loader shows coordinates with it.
  const name = opts.fromLink ? linkPlaceLabel(rawName) : text(rawName, PROJECT_LIMITS.nameChars);
  return { kind: 'live', lat, lon, sizeM, resolution: resolution as 512 | 1024 | 2048, ...(name ? { name } : {}) };
}

function readGrid(v: unknown): ProjectFile['grid'] {
  const o = obj(v);
  return { nx: int(own(o, 'nx'), [16, 8192]), ny: int(own(o, 'ny'), [16, 8192]), cellSize: num(own(o, 'cellSize'), [0.05, 1000]) };
}

/** What bounds an edit set: the project's grid (radii and the cell count are clipped to it) and the cell budget. */
interface EditBounds {
  grid: { nx: number; ny: number };
  maxCells: number;
}

function editBounds(grid: ProjectFile['grid'], opts: ReadOptions): EditBounds {
  const side = PROJECT_LIMITS.maxRadiusCells;
  return { grid: grid ? { nx: grid.nx, ny: grid.ny } : { nx: side, ny: side }, maxCells: opts.fromLink ? PROJECT_LIMITS.maxLinkBrushCells : PROJECT_LIMITS.maxBrushCells };
}

function readEdits(v: unknown, bounds: EditBounds): ProjectEdit[] {
  const a = arr(v, PROJECT_LIMITS.maxEdits);
  const out: ProjectEdit[] = [];
  let points = 0;
  // No brush needs a radius past the grid's longer side (Clear walls uses exactly that): a larger one is clamped.
  const maxR = Math.max(bounds.grid.nx, bounds.grid.ny);
  for (const e of a) {
    const o = obj(e);
    const op = oneOf(own(o, 'op'), ['wall', 'erase', 'terrain'] as const);
    const r = Math.min(maxR, num(own(o, 'r'), RANGES.radiusCells));
    if (op === 'wall') {
      const pts = arr(own(o, 'pts'), PROJECT_LIMITS.maxWallPoints * 2).map((x) => num(x, RANGES.grid));
      if (pts.length < 2 || pts.length % 2 !== 0) fail();
      points += pts.length / 2;
      if (points > PROJECT_LIMITS.maxEditPoints) fail();
      const segs = Math.max(1, pts.length / 2 - 1);
      const hv = own(o, 'h');
      const h = Array.isArray(hv) ? (hv.length === segs ? hv.map((x) => num(x, RANGES.wallHeight)) : fail()) : num(hv, RANGES.wallHeight);
      out.push({ op, pts, h, r });
    } else if (op === 'erase') {
      out.push({ op, a: pair(own(o, 'a'), RANGES.grid), b: pair(own(o, 'b'), RANGES.grid), r });
    } else {
      points++;
      if (points > PROJECT_LIMITS.maxEditPoints) fail();
      out.push({ op, at: pair(own(o, 'at'), RANGES.grid), r, d: num(own(o, 'd'), RANGES.terrainDelta) });
    }
  }
  if (editsCost(out, bounds.grid).cells > bounds.maxCells) throw new Invalid(PROJECT_ERRORS.tooHeavy);
  return out;
}

function readHydrograph(v: unknown): HydrographPoint[] {
  return arr(v, PROJECT_LIMITS.maxHydrograph).map((p) => {
    const o = obj(p);
    return { t: num(own(o, 't'), RANGES.seconds), q: num(own(o, 'q'), RANGES.discharge) };
  });
}

function readSource(v: unknown, opts: ReadOptions): WaterSource {
  const o = obj(v);
  const type = oneOf(own(o, 'type'), ['inflow', 'stage'] as const);
  const base = { id: id(own(o, 'id')), gx: num(own(o, 'gx'), RANGES.grid), gy: num(own(o, 'gy'), RANGES.grid), radius: num(own(o, 'radius'), RANGES.radiusCells) };
  const label = opts.fromLink ? '' : text(own(o, 'label'), PROJECT_LIMITS.labelChars);
  if (type === 'inflow') {
    const stopAfter = optNum(own(o, 'stopAfter'), RANGES.seconds);
    const hg = own(o, 'hydrograph');
    return {
      ...base,
      type,
      discharge: num(own(o, 'discharge'), RANGES.discharge),
      ...(stopAfter !== null ? { stopAfter } : {}),
      ...(hg !== undefined && hg !== null ? { hydrograph: readHydrograph(hg) } : {}),
      ...(label ? { label } : {}),
    };
  }
  const offsetScale = optNum(own(o, 'offsetScale'), [0, 5]);
  return { ...base, type, level: num(own(o, 'level'), RANGES.level), ...(offsetScale !== null ? { offsetScale } : {}), ...(label ? { label } : {}) };
}

function readStorm(v: unknown): StormCell {
  const o = obj(v);
  return { id: id(own(o, 'id')), gx: num(own(o, 'gx'), RANGES.grid), gy: num(own(o, 'gy'), RANGES.grid), radius: num(own(o, 'radius'), RANGES.radiusCells), intensity: num(own(o, 'intensity'), RANGES.rain) };
}

function readShelter(v: unknown, i: number, opts: ReadOptions): Shelter {
  const o = obj(v);
  const name = opts.fromLink ? '' : text(own(o, 'name'), PROJECT_LIMITS.labelChars);
  return { name: name || `Shelter ${i + 1}`, gx: num(own(o, 'gx'), RANGES.grid), gy: num(own(o, 'gy'), RANGES.grid) };
}

function readSim(v: unknown): ProjectScenario['sim'] {
  const o = obj(v);
  const out: ProjectScenario['sim'] = {};
  for (const k of Object.keys(o)) {
    if (!SIM_KEY_RE.test(k) || SIM_DENY.has(k)) continue;
    const x = o[k];
    if (k === 'boundary') out[k] = oneOf(x, ['open', 'wall'] as const);
    else if (typeof x === 'number') out[k] = num(x, SIM_RANGES[k] ?? SIM_GENERIC);
    else if (typeof x === 'boolean') out[k] = x;
    // other types (strings of unknown enums, objects) are not carried
  }
  return out;
}

function readClimate(v: unknown): ClimateSelection {
  const o = obj(v);
  return { horizon: oneOf(own(o, 'horizon'), CLIMATE_HORIZONS), pathway: oneOf(own(o, 'pathway'), CLIMATE_PATHWAYS), scaling: oneOf(own(o, 'scaling'), RAIN_SCALINGS) };
}

function readChain(v: unknown): ProjectChain {
  const o = obj(v);
  const out: ProjectChain = { inflow: oneOf(own(o, 'inflow'), ['chain', 'scenario'] as const) };
  const vf = optNum(own(o, 'volumeFactor'), [0.05, 20]);
  const er = optNum(own(o, 'erosionRate'), [0, 1000]);
  const cv = optNum(own(o, 'cv'), [0, 0.7]);
  const bk = optNum(own(o, 'bulking'), [0.1, 20]);
  const bf = optNum(own(o, 'baseflow'), [0, 1e5]);
  if (vf !== null) out.volumeFactor = vf;
  if (er !== null) out.erosionRate = er;
  if (cv !== null) out.cv = cv;
  if (bk !== null) out.bulking = bk;
  if (bf !== null) out.baseflow = bf;
  const mode = own(o, 'mode');
  if (mode !== undefined && mode !== null) out.mode = oneOf(mode, ['transientDam', 'directFlow'] as const);
  return out;
}

function readScenario(v: unknown, opts: ReadOptions, warnings: string[]): ProjectScenario {
  const o = obj(v);
  const evac = own(o, 'evacStart');
  return {
    stageOffset: num(own(o, 'stageOffset'), RANGES.stageOffset),
    sim: readSim(own(o, 'sim') ?? {}),
    sources: arr(own(o, 'sources') ?? [], PROJECT_LIMITS.maxSources).map((s) => readSource(s, opts)),
    storms: arr(own(o, 'storms') ?? [], PROJECT_LIMITS.maxStorms).map(readStorm),
    shelters: arr(own(o, 'shelters') ?? [], PROJECT_LIMITS.maxShelters).map((s, i) => readShelter(s, i, opts)),
    evacStart: evac === undefined || evac === null ? null : (() => {
      const e = obj(evac);
      return { gx: num(own(e, 'gx'), RANGES.grid), gy: num(own(e, 'gy'), RANGES.grid) };
    })(),
    climate: optional(own(o, 'climate'), readClimate, warnings, 'future-climate settings'),
    chain: optional(own(o, 'chain'), readChain, warnings, 'hazard-chain settings'),
  };
}

function readSite(v: unknown, i: number, opts: ReadOptions): ProjectSite {
  const o = obj(v);
  const lon = num(own(o, 'lon'), [-180, 180]);
  const lat = num(own(o, 'lat'), [-85, 85]);
  const rv = own(o, 'ring');
  let ring: number[] | null = null;
  if (rv !== undefined && rv !== null) {
    const r = arr(rv, SITE_LIMITS.maxRing * 2);
    if (r.length % 2 !== 0 || r.length < 6) fail();
    ring = r.map((x, k) => num(x, k % 2 === 0 ? [-180, 180] : [-85, 85]));
  }
  const name = opts.fromLink ? '' : text(own(o, 'name'), SITE_LIMITS.nameChars);
  return {
    name: name || `Site ${i + 1}`,
    lon,
    lat,
    ring,
    occupancy: oneOf(own(o, 'occupancy'), SITE_OCCUPANCIES) as SiteOccupancy,
    floors: int(own(o, 'floors'), [1, SITE_LIMITS.maxFloors]),
    value: optNum(own(o, 'value'), [0, SITE_LIMITS.maxValue]),
    footprintM2: optNum(own(o, 'footprintM2'), [1, SITE_LIMITS.maxFootprintM2]),
    firstFloorHeight: optNum(own(o, 'firstFloorHeight'), [0, SITE_LIMITS.maxFirstFloorM]),
    criticalElev: optNum(own(o, 'criticalElev'), [0, SITE_LIMITS.maxCriticalM]),
  };
}

function readRpMap(v: unknown): Record<string, number> {
  const o = obj(v);
  const keys = Object.keys(o);
  if (keys.length > 32) fail();
  const out: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const k of keys) out[id(k)] = num(o[k], [1, 100000]);
  return out;
}

function readSiteCheck(v: unknown): SiteCheckSettings {
  const o = obj(v);
  const lv = own(o, 'levels');
  const fb = own(o, 'freeboardFt');
  const de = own(o, 'designEvent');
  return {
    ladder: oneOf(own(o, 'ladder'), [...LADDERS, 'auto'] as const),
    minutes: num(own(o, 'minutes'), [2, 240]),
    levels: lv === undefined || lv === null ? null : arr(lv, 32).map(id),
    userRp: readRpMap(own(o, 'userRp') ?? {}),
    designEvent: de === undefined || de === null ? null : id(de),
    freeboardFt: fb === undefined || fb === null ? null : fb === 1 || fb === 2 || fb === 3 ? fb : fail(),
  };
}

function readEnsemble(v: unknown): EnsembleSettings {
  const o = obj(v);
  const r = obj(own(o, 'ranges'));
  const ranges = {
    inflowPct: num(own(r, 'inflowPct'), RANGE_LIMITS.inflowPct),
    rainPct: num(own(r, 'rainPct'), RANGE_LIMITS.rainPct),
    stageM: num(own(r, 'stageM'), RANGE_LIMITS.stageM),
    manningLo: num(own(r, 'manningLo'), RANGE_LIMITS.manning),
    manningHi: num(own(r, 'manningHi'), RANGE_LIMITS.manning),
    demSigmaM: num(own(r, 'demSigmaM'), RANGE_LIMITS.demSigmaM),
  };
  if (ranges.manningHi < ranges.manningLo) fail();
  const corr = optNum(own(r, 'demCorrM'), [1, 1e5]);
  return {
    members: int(own(o, 'members'), [ENSEMBLE_LIMITS.minMembers, ENSEMBLE_LIMITS.maxMembers]),
    minutes: num(own(o, 'minutes'), [ENSEMBLE_LIMITS.minMinutes, ENSEMBLE_LIMITS.maxMinutes]),
    seed: int(own(o, 'seed'), [1, 999999]),
    ranges: corr !== null ? { ...ranges, demCorrM: corr } : ranges,
  };
}

function readCamera(v: unknown): CameraPose {
  const o = obj(v);
  const t = obj(own(o, 'target'));
  return {
    target: { gx: num(own(t, 'gx'), [-1e5, 1e5]), gy: num(own(t, 'gy'), [-1e5, 1e5]), elevation: num(own(t, 'elevation'), RANGES.elevation) },
    distance: num(own(o, 'distance'), RANGES.distance),
    yaw: num(own(o, 'yaw'), [-1000, 1000]),
    pitch: num(own(o, 'pitch'), [0.001, Math.PI / 2]),
  };
}

function readView(v: unknown): ProjectView {
  const o = obj(v);
  const out: ProjectView = {
    waterMode: oneOf(own(o, 'waterMode'), WATER_MODES),
    verticalExaggeration: num(own(o, 'verticalExaggeration'), [1, 5]),
    showImagery: bool(own(o, 'showImagery')),
    showRoads: bool(own(o, 'showRoads')),
    showContours: bool(own(o, 'showContours')),
  };
  const pt = own(o, 'probabilityThreshold');
  if (pt !== undefined && pt !== null) out.probabilityThreshold = pt === 0.15 || pt === 0.5 ? pt : fail();
  const tod = own(o, 'timeOfDay');
  if (tod !== undefined && tod !== null) out.timeOfDay = oneOf(tod, TIMES_OF_DAY);
  const b = own(o, 'buildings');
  if (b !== undefined && b !== null) out.buildings = bool(b);
  return out;
}

function readCost(v: unknown): DesignCost {
  const o = obj(v ?? {});
  const type = own(o, 'type');
  // Useful life: whole years inside FEMA-plausible bounds; absent / null = FEMA's standard value for the type.
  const years = optInt(own(o, 'usefulLifeYears'), BCA_LIMITS.years);
  return {
    type: type === undefined ? 'floodwall' : oneOf(type, MITIGATION_TYPES),
    capexUsd: optNum(own(o, 'capexUsd'), RANGES.money),
    omUsdPerYear: optNum(own(o, 'omUsdPerYear'), RANGES.money),
    lengthM: optNum(own(o, 'lengthM'), [0, 1e6]),
    heightM: optNum(own(o, 'heightM'), RANGES.wallHeight),
    ...(years !== null ? { usefulLifeYears: years } : {}),
  };
}

function readBca(v: unknown): BcaSettings {
  const o = obj(v);
  return { discountRate: num(own(o, 'discountRate'), BCA_LIMITS.rate), analysisYear: int(own(o, 'analysisYear'), BCA_LIMITS.analysisYear) };
}

const DESIGN_IDS = ['A', 'B', 'C'] as const;

function readDesigns(v: unknown, opts: ReadOptions, bounds: EditBounds, warnings: string[]): DesignSpec[] {
  const a = arr(v, PROJECT_LIMITS.maxDesigns);
  const out: DesignSpec[] = [];
  for (const d of a) {
    try {
      const o = obj(d);
      const did = oneOf(own(o, 'id'), DESIGN_IDS);
      if (out.some((x) => x.id === did)) fail();
      const name = opts.fromLink ? '' : text(own(o, 'name'), PROJECT_LIMITS.designNameChars);
      out.push({ id: did, name: name || `Design ${did}`, edits: readEdits(own(o, 'edits') ?? [], bounds), cost: readCost(own(o, 'cost')) });
    } catch (err) {
      if (!(err instanceof Invalid)) throw err;
      warnings.push(err.message === PROJECT_ERRORS.tooHeavy ? 'A design in the project edits more of the map than Deluge replays when opening a project and was skipped.' : 'A design in the project could not be read and was skipped.');
    }
  }
  return out;
}

function readComparison(v: unknown): ComparisonSummary {
  const o = obj(v);
  const levels = arr(own(o, 'levels'), PROJECT_LIMITS.maxLevels).map((l) => {
    const x = obj(l);
    const rpFrom = own(x, 'rpFrom');
    return {
      id: id(own(x, 'id')),
      label: text(own(x, 'label'), PROJECT_LIMITS.labelChars),
      returnPeriod: optNum(own(x, 'returnPeriod'), [1, 100000]),
      rpFrom: rpFrom === null || rpFrom === undefined ? null : oneOf(rpFrom, ['source', 'user'] as const),
    };
  });
  const n = levels.length;
  const losses = (x: unknown) => {
    // null: no value at that level (a scene without buildings has no loss model).
    const a = arr(x, PROJECT_LIMITS.maxLevels).map((y) => optNum(y, RANGES.money));
    return a.length === n ? a : fail();
  };
  const b = obj(own(o, 'baseline'));
  const optMoney = (x: unknown) => optNum(x, [-1e13, 1e13]);
  const optRatio = (x: unknown) => optNum(x, [-1e6, 1e6]);
  return {
    generatedAt: text(own(o, 'generatedAt'), 40),
    ladder: oneOf(own(o, 'ladder'), [...LADDERS, 'current'] as const),
    durationS: num(own(o, 'durationS'), RANGES.seconds),
    levels,
    baseline: { loss: losses(own(b, 'loss')), eal: optMoney(own(b, 'eal')) },
    designs: arr(own(o, 'designs'), PROJECT_LIMITS.maxDesigns).map((d) => {
      const x = obj(d);
      return {
        id: oneOf(own(x, 'id'), DESIGN_IDS),
        name: text(own(x, 'name'), PROJECT_LIMITS.designNameChars),
        loss: losses(own(x, 'loss')),
        eal: optMoney(own(x, 'eal')),
        deltaEal: optMoney(own(x, 'deltaEal')),
        costUsd: num(own(x, 'costUsd'), RANGES.money),
        npv7: optMoney(own(x, 'npv7')),
        npv3: optMoney(own(x, 'npv3')),
        bcr7: optRatio(own(x, 'bcr7')),
        bcr3: optRatio(own(x, 'bcr3')),
        protectedBuildings: int(own(x, 'protectedBuildings'), [0, 1e7]),
        newlyReached: int(own(x, 'newlyReached'), [0, 1e7]),
        deeperBuildings: int(own(x, 'deeperBuildings'), [0, 1e7]),
        wetterAreaM2: num(own(x, 'wetterAreaM2'), [0, 1e12]),
        years: optInt(own(x, 'years'), BCA_LIMITS.years),
        bcr: optRatio(own(x, 'bcr')),
        bcrLow: optRatio(own(x, 'bcrLow')),
        bcrHigh: optRatio(own(x, 'bcrHigh')),
        netBenefit: optMoney(own(x, 'netBenefit')),
        breakEvenCost: optMoney(own(x, 'breakEvenCost')),
      };
    }),
    discountRate: optNum(own(o, 'discountRate'), BCA_LIMITS.rate),
  };
}

function readPortfolio(v: unknown): { name: string; csv: string } {
  const o = obj(v);
  const csv = own(o, 'csv');
  if (typeof csv !== 'string' || csv.length > PROJECT_LIMITS.maxPortfolioChars) fail();
  return { name: text(own(o, 'name'), PROJECT_LIMITS.nameChars) || 'portfolio.csv', csv: csv as string };
}

// ─── entry points ──────────────────────────────────────────────────────────────────────────────────────────────────
/** Read an already-parsed value (shape-checked first). */
export function readProject(value: unknown, opts: ReadOptions = {}): ReadResult {
  const shape = checkShape(value);
  if (shape) return { ok: false, error: shape };
  return build(value, opts);
}

/** Read the text of a project file. */
export function parseProjectText(t: unknown, opts: ReadOptions = {}): ReadResult {
  if (typeof t !== 'string') return { ok: false, error: PROJECT_ERRORS.notJson };
  const p = parseGuarded(t);
  if (!p.ok) return p;
  return build(p.value, opts);
}

function build(value: unknown, opts: ReadOptions): ReadResult {
  if (!isObj(value) || own(value, 'format') !== PROJECT_FORMAT) return { ok: false, error: PROJECT_ERRORS.notProject };
  const version = own(value, 'version');
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return { ok: false, error: PROJECT_ERRORS.notProject };
  if (version > PROJECT_VERSION) return { ok: false, error: PROJECT_ERRORS.newer };
  const warnings: string[] = [];
  try {
    const o = value;
    const sitesRaw = arr(own(o, 'sites') ?? [], 64);
    const sites: ProjectSite[] = [];
    let badSites = 0;
    for (const s of sitesRaw.slice(0, SITE_LIMITS.maxSites)) {
      try {
        sites.push(readSite(s, sites.length, opts));
      } catch (err) {
        if (!(err instanceof Invalid)) throw err;
        badSites++;
      }
    }
    if (sitesRaw.length > SITE_LIMITS.maxSites) warnings.push(`Only the first ${SITE_LIMITS.maxSites} sites of the project were read.`);
    if (badSites) warnings.push(`${badSites} site${badSites === 1 ? '' : 's'} in the project could not be read and ${badSites === 1 ? 'was' : 'were'} skipped.`);
    const grid = own(o, 'grid') == null ? null : readGrid(own(o, 'grid'));
    const bounds = editBounds(grid, opts);
    const project: ProjectFile = {
      format: PROJECT_FORMAT,
      version: PROJECT_VERSION,
      name: opts.fromLink ? '' : text(own(o, 'name'), PROJECT_LIMITS.nameChars),
      savedAt: text(own(o, 'savedAt'), 40),
      scene: readScene(own(o, 'scene'), opts),
      grid,
      scenario: readScenario(own(o, 'scenario'), opts, warnings),
      edits: readEdits(own(o, 'edits') ?? [], bounds),
      sites,
      siteCheck: optional(own(o, 'siteCheck'), readSiteCheck, warnings, 'Site check settings'),
      ensemble: optional(own(o, 'ensemble'), readEnsemble, warnings, 'ensemble settings'),
      portfolio: opts.fromLink ? null : optional(own(o, 'portfolio'), readPortfolio, warnings, 'portfolio rows'),
      camera: optional(own(o, 'camera'), readCamera, warnings, 'camera settings'),
      view: optional(own(o, 'view'), readView, warnings, 'view settings'),
      designs: own(o, 'designs') == null ? [] : readDesigns(own(o, 'designs'), opts, bounds, warnings),
      comparison: opts.fromLink ? null : optional(own(o, 'comparison'), readComparison, warnings, 'cached comparison results'),
    };
    // Benefit–cost inputs: absent in files from before they existed (the panel's defaults then apply).
    const bca = optional(own(o, 'bca'), readBca, warnings, 'benefit–cost settings');
    if (bca) project.bca = bca;
    if (opts.fromLink && (own(o, 'portfolio') != null || own(o, 'comparison') != null)) warnings.push('A shared link never carries a portfolio or cached results; those parts were ignored.');
    return { ok: true, project, warnings };
  } catch (err) {
    // Invalid carries one of the fixed PROJECT_ERRORS sentences, never text from the file.
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

/** The file's text: stable key order, two-space indent (readable and diff-able). */
export function projectToJson(p: ProjectFile, pretty = true): string {
  return JSON.stringify(p, null, pretty ? 2 : undefined);
}
