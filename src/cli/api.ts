/**
 * The HTTP API's requests (docs/api.md) → the CLI's options, and every check that can run before a job is queued.
 *
 * A request body is turned into exactly the options its CLI command takes (`POST /v1/runs` → `deluge run …`), so the
 * job runs the command handler unchanged (src/cli/commands.ts) and an API number is a CLI number. The checks are the
 * CLI's own functions (requirePreset, minutesOf, parseClimate, resolveForcing, siteFromOptions, planSite,
 * parsePortfolio) run one stage at a time, so a bad preset, level, stage, climate, site or CSV is a 400 before the
 * GPU is involved — the CLI's exit code 2 cases.
 *
 * ERROR MESSAGES NEVER ECHO INPUT. Every 400 carries a fixed sentence chosen by the stage that failed (it may name a
 * field of the schema — our name, not the client's — and the schema's own limits). The CLI's UsageError messages
 * quote what they were given ("unknown preset "<id>""), which is right on a terminal and wrong in an HTTP response
 * that a browser, a log viewer or a ticket system may render, so they are never passed through.
 */
import type { TerrainData } from '../contracts';
import { CLIMATE_HORIZONS, CLIMATE_PATHWAYS, RAIN_SCALINGS } from '../climate/scenarios';
import { CSV_LIMITS, parseCsv } from '../loss/csv';
import { ENSEMBLE_LIMITS, parsePortfolio, SITE_LIMITS, SITE_OCCUPANCIES } from '../loss';
import type { Atlas14Point } from '../data/atlas14';
import type { ParsedOptions } from './args';
import { minutesOf, parseRp, planSite, rainAt, requirePreset, scenarioFlags, siteFromOptions, sweepLevels, type CliEnv } from './commands';
import { DEPARTURE_CURVES, type DepartureCurveId } from '../routing/departure';
import { buildLadder, parseClimate, resolveForcing, type LadderKind } from './scenario';

export type JobKind = 'run' | 'portfolio' | 'site';

/** An HTTP error with a fixed sentence (RFC 9457 problem details). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

const invalid = (detail: string) => new ApiError(400, 'Invalid request', detail);

/** The file the portfolio command reads its CSV from (a name inside the job, never a path the client chose). */
export const ASSETS_CSV = 'assets.csv';

/** A request turned into its CLI command and options. */
export interface JobSpec {
  kind: JobKind;
  /** The CLI command it runs. */
  command: 'run' | 'portfolio' | 'site';
  /** Exactly what the command's parser would produce from the equivalent command line. */
  options: ParsedOptions;
  /** The equivalent command line (for the record; every value in it passed the schema). */
  argv: string[];
  /** The request as validated (assetsCsv replaced by a count), stored with the job. */
  request: Record<string, unknown>;
  /** The portfolio's CSV text (kept only until the job ends). */
  csv: string | null;
}

// ─── Schema helpers: plain JSON objects, known fields only, typed and bounded ─────────────────────────────────────

type Obj = Record<string, unknown>;

function object(v: unknown, field: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw invalid(`${field} must be a JSON object.`);
  return v as Obj;
}

function onlyKeys(o: Obj, allowed: readonly string[], field: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw invalid(`${field} has a field this endpoint does not accept (see docs/api.md).`);
}

const has = (o: Obj, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null;

function number(o: Obj, k: string, field: string, lo: number, hi: number, integer = false): number | undefined {
  if (!has(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi || (integer && !Number.isInteger(v))) throw invalid(`${field} must be ${integer ? 'a whole number' : 'a number'} from ${lo} to ${hi}.`);
  return v;
}

function bool(o: Obj, k: string, field: string): boolean | undefined {
  if (!has(o, k)) return undefined;
  if (typeof o[k] !== 'boolean') throw invalid(`${field} must be true or false.`);
  return o[k] as boolean;
}

/** An identifier (preset, level, ladder id): short, plain ASCII. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function ident(o: Obj, k: string, field: string, message = `${field} must be a short identifier (letters, digits, . _ -).`): string | undefined {
  if (!has(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== 'string' || !ID.test(v)) throw invalid(message);
  return v;
}

function oneOf<T extends string>(o: Obj, k: string, field: string, values: readonly T[]): T | undefined {
  if (!has(o, k)) return undefined;
  const v = o[k];
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) throw invalid(`${field} must be one of ${values.join(', ')}.`);
  return v as T;
}

const MSG_PRESET = 'Unknown preset: GET /v1/presets lists the presets this server has.';

// ─── Requests → CLI options ───────────────────────────────────────────────────────────────────────────────────────

const SCENARIO_KEYS = ['minutes', 'level', 'stageFt', 'rainMmHr', 'scale', 'manningN', 'climate'] as const;

/** `scenario` → the CLI's shared scenario options (and their command-line form). */
function scenarioOptions(body: Obj, o: ParsedOptions, argv: string[]): Obj {
  const rec: Obj = {};
  if (!has(body, 'scenario')) return rec;
  const s = object(body.scenario, 'scenario');
  onlyKeys(s, SCENARIO_KEYS, 'scenario');
  const set = (cli: string, v: string | number | undefined, key: string) => {
    if (v === undefined) return;
    o[cli] = v;
    argv.push(`--${cli}`, String(v));
    rec[key] = v;
  };
  set('minutes', number(s, 'minutes', 'scenario.minutes', ENSEMBLE_LIMITS.minMinutes, ENSEMBLE_LIMITS.maxMinutes), 'minutes');
  set('scenario', ident(s, 'level', 'scenario.level'), 'level');
  set('stage-ft', number(s, 'stageFt', 'scenario.stageFt', -1000, 1000), 'stageFt');
  set('rain', number(s, 'rainMmHr', 'scenario.rainMmHr', 0, 1000), 'rainMmHr');
  set('scale', number(s, 'scale', 'scenario.scale', 0, 100), 'scale');
  set('manning', number(s, 'manningN', 'scenario.manningN', 0.005, 0.3), 'manningN');
  if (has(s, 'climate')) {
    const c = object(s.climate, 'scenario.climate');
    onlyKeys(c, ['horizon', 'pathway', 'scaling'], 'scenario.climate');
    const horizon = oneOf(c, 'horizon', 'scenario.climate.horizon', CLIMATE_HORIZONS) ?? 'today';
    const pathway = oneOf(c, 'pathway', 'scenario.climate.pathway', CLIMATE_PATHWAYS) ?? 'ssp585';
    const scaling = oneOf(c, 'scaling', 'scenario.climate.scaling', RAIN_SCALINGS) ?? 'cc';
    if (horizon !== 'today') set('climate', `${horizon}:${pathway}:${scaling}`, 'climateText');
    rec.climate = { horizon, pathway, scaling };
    delete rec.climateText;
  }
  return rec;
}

function presetOf(body: Obj): string {
  if (!has(body, 'preset')) throw invalid('preset is required (GET /v1/presets lists them).');
  const v = body.preset;
  if (typeof v !== 'string' || !ID.test(v)) throw invalid(MSG_PRESET);
  return v;
}

function start(body: unknown, command: JobSpec['command'], keys: readonly string[]): { b: Obj; o: ParsedOptions; argv: string[]; request: Obj } {
  const b = object(body, 'The request body');
  onlyKeys(b, keys, 'The request body');
  const preset = presetOf(b);
  const o: ParsedOptions = { preset, quiet: true };
  const argv = [command, '--preset', preset, '--quiet'];
  const request: Obj = { preset };
  const sc = scenarioOptions(b, o, argv);
  if (Object.keys(sc).length) request.scenario = sc;
  return { b, o, argv, request };
}

/** `POST /v1/runs` → `deluge run`. Results: summary.json and (unless rasters: false) the four GeoTIFFs. */
export function runRequest(body: unknown): JobSpec {
  const { b, o, argv, request } = start(body, 'run', ['preset', 'scenario', 'rasters']);
  o.out = '.';
  const rasters = bool(b, 'rasters', 'rasters') ?? true;
  if (!rasters) {
    o['no-rasters'] = true;
    argv.push('--no-rasters');
  }
  request.rasters = rasters;
  argv.push('--out', '.');
  return { kind: 'run', command: 'run', options: o, argv, request, csv: null };
}

/** `POST /v1/portfolio-assessments` → `deluge portfolio`. Results: results.csv and summary.json. */
export function portfolioRequest(body: unknown): JobSpec {
  const { b, o, argv, request } = start(body, 'portfolio', ['preset', 'scenario', 'assetsCsv', 'ensemble']);
  if (!has(b, 'assetsCsv') || typeof b.assetsCsv !== 'string') throw invalid('assetsCsv is required: the portfolio CSV as one JSON string.');
  const csv = b.assetsCsv;
  if (csv.length > CSV_LIMITS.maxChars) throw invalid(`assetsCsv is longer than ${CSV_LIMITS.maxChars / 1e6} million characters.`);
  o.csv = ASSETS_CSV;
  o.out = 'results.csv';
  o.summary = 'summary.json';
  argv.push('--csv', ASSETS_CSV, '--out', 'results.csv', '--summary', 'summary.json');
  if (has(b, 'ensemble')) {
    const e = object(b.ensemble, 'ensemble');
    onlyKeys(e, ['members', 'seed', 'demNoise'], 'ensemble');
    const members = number(e, 'members', 'ensemble.members', ENSEMBLE_LIMITS.minMembers, ENSEMBLE_LIMITS.maxMembers, true);
    if (members === undefined) throw invalid(`ensemble.members is required with an ensemble (${ENSEMBLE_LIMITS.minMembers} to ${ENSEMBLE_LIMITS.maxMembers}).`);
    const seed = number(e, 'seed', 'ensemble.seed', 1, 999999, true) ?? 1;
    const demNoise = bool(e, 'demNoise', 'ensemble.demNoise') ?? true;
    o.members = members;
    o.seed = seed;
    argv.push('--members', String(members), '--seed', String(seed));
    if (!demNoise) {
      o['no-dem-noise'] = true;
      argv.push('--no-dem-noise');
    }
    request.ensemble = { members, seed, demNoise };
  }
  return { kind: 'portfolio', command: 'portfolio', options: o, argv, request, csv };
}

/** `POST /v1/site-checks` → `deluge site`. Result: report.json. */
export function siteRequest(body: unknown): JobSpec {
  const { b, o, argv, request } = start(body, 'site', ['preset', 'scenario', 'site', 'sweep', 'egress']);
  o.out = 'report.json';
  if (!has(b, 'site')) throw invalid('site is required ({ "lat": …, "lon": … }).');
  const s = object(b.site, 'site');
  onlyKeys(s, ['name', 'lat', 'lon', 'ring', 'use', 'floors', 'valueUsd', 'footprintM2', 'firstFloorHeightM', 'criticalElevM'], 'site');
  const lat = number(s, 'lat', 'site.lat', -90, 90);
  const lon = number(s, 'lon', 'site.lon', -180, 180);
  if (lat === undefined || lon === undefined) throw invalid('site.lat and site.lon are required (WGS84 degrees).');
  o.at = `${lat},${lon}`;
  argv.push('--at', o.at);
  const site: Obj = { lat, lon };
  if (has(s, 'name')) {
    const name = s.name;
    // Names are the client's own label for the report: printable, no control or bidi-override characters.
    if (typeof name !== 'string' || name.length > SITE_LIMITS.nameChars || /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(name)) throw invalid(`site.name must be plain text of at most ${SITE_LIMITS.nameChars} characters.`);
    o.name = name;
    argv.push('--name', name);
    site.name = name;
  }
  if (has(s, 'ring')) {
    const r = s.ring;
    const ok = Array.isArray(r) && r.length >= 3 && r.length <= SITE_LIMITS.maxRing && r.every((p) => Array.isArray(p) && p.length === 2 && p.every((x) => typeof x === 'number' && Number.isFinite(x)) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180);
    if (!ok) throw invalid(`site.ring must be 3 to ${SITE_LIMITS.maxRing} [lat, lon] corners in degrees.`);
    o.ring = (r as number[][]).map((p) => `${p[0]},${p[1]}`).join(';');
    argv.push('--ring', o.ring);
    site.ring = r;
  }
  const use = oneOf(s, 'use', 'site.use', SITE_OCCUPANCIES);
  if (use) o.use = site.use = use;
  const nums: Array<[string, string, number, number, boolean]> = [
    ['floors', 'floors', 1, SITE_LIMITS.maxFloors, true],
    ['valueUsd', 'value', 0, SITE_LIMITS.maxValue, false],
    ['footprintM2', 'footprint', 1, SITE_LIMITS.maxFootprintM2, false],
    ['firstFloorHeightM', 'ffh', 0, SITE_LIMITS.maxFirstFloorM, false],
    ['criticalElevM', 'critical', 0, SITE_LIMITS.maxCriticalM, false],
  ];
  for (const [key, cli, lo, hi, int] of nums) {
    const v = number(s, key, `site.${key}`, lo, hi, int);
    if (v === undefined) continue;
    o[cli] = v;
    argv.push(`--${cli}`, String(v));
    site[key] = v;
  }
  if (use) argv.push('--use', use);
  request.site = site;
  if (has(b, 'egress')) {
    // Leaving by road: the same options and limits as `deluge site` (commands.ts egressOptions).
    const e = object(b.egress, 'egress');
    onlyKeys(e, ['occupants', 'alertMin', 'departure', 'personsPerCar', 'exitLanes'], 'egress');
    const egress: Obj = {};
    const enums: Array<[string, string, number, number, boolean]> = [
      ['occupants', 'occupants', 1, 100000, true],
      ['alertMin', 'alert-min', -1440, 1440, false],
      ['personsPerCar', 'persons-per-car', 1, 10, false],
      ['exitLanes', 'exit-lanes', 1, 12, true],
    ];
    for (const [key, cli, lo, hi, int] of enums) {
      const v = number(e, key, `egress.${key}`, lo, hi, int);
      if (v === undefined) continue;
      o[cli] = v;
      argv.push(`--${cli}`, String(v));
      egress[key] = v;
    }
    const dep = oneOf(e, 'departure', 'egress.departure', Object.keys(DEPARTURE_CURVES) as DepartureCurveId[]);
    if (dep) {
      o.departure = egress.departure = dep;
      argv.push('--departure', dep);
    }
    request.egress = egress;
  }
  if (has(b, 'sweep')) {
    const w = object(b.sweep, 'sweep');
    onlyKeys(w, ['ladder', 'levels', 'returnPeriods', 'design', 'freeboardFt'], 'sweep');
    const sc = request.scenario as Obj | undefined;
    if (sc && (sc.level !== undefined || sc.stageFt !== undefined)) throw invalid('A sweep runs the ladder of levels itself: drop scenario.level and scenario.stageFt (use sweep.levels to pick levels).');
    o.sweep = true;
    argv.push('--sweep');
    const sweep: Obj = {};
    const ladder = oneOf(w, 'ladder', 'sweep.ladder', ['stage', 'rain', 'scale'] as const);
    if (ladder) {
      o.ladder = sweep.ladder = ladder;
      argv.push('--ladder', ladder);
    }
    if (has(w, 'levels')) {
      const L = w.levels;
      const ok = L === 'all' || (Array.isArray(L) && L.length >= 1 && L.length <= 32 && L.every((x) => typeof x === 'string' && ID.test(x)));
      if (!ok) throw invalid('sweep.levels must be "all" or a list of 1 to 32 level ids (GET /v1/presets lists them).');
      o.levels = L === 'all' ? 'all' : (L as string[]).join(',');
      argv.push('--levels', o.levels);
      sweep.levels = L;
    }
    if (has(w, 'returnPeriods')) {
      const rp = object(w.returnPeriods, 'sweep.returnPeriods');
      const entries = Object.keys(rp).map((k) => [k, rp[k]] as const);
      const ok = entries.length <= 32 && entries.every(([k, v]) => ID.test(k) && typeof v === 'number' && Number.isFinite(v) && v >= 1 && v <= 100000);
      if (!ok) throw invalid('sweep.returnPeriods must map up to 32 level ids to years from 1 to 100000.');
      if (entries.length) {
        o.rp = entries.map(([k, v]) => `${k}=${v}`).join(',');
        argv.push('--rp', o.rp);
        sweep.returnPeriods = Object.fromEntries(entries);
      }
    }
    const design = ident(w, 'design', 'sweep.design');
    if (design) {
      o.design = sweep.design = design;
      argv.push('--design', design);
    }
    const fb = number(w, 'freeboardFt', 'sweep.freeboardFt', 0, 10);
    if (fb !== undefined) {
      o['freeboard-ft'] = sweep.freeboardFt = fb;
      argv.push('--freeboard-ft', String(fb));
    }
    request.sweep = sweep;
  }
  argv.push('--out', 'report.json');
  return { kind: 'site', command: 'site', options: o, argv, request, csv: null };
}

// ─── The checks before queueing (the CLI's functions, one stage at a time) ──────────────────────────────────────

/** What the checks need from the engine: the presets on disk and the Atlas 14 grid (no GPU). */
export type CheckEnv = Pick<CliEnv, 'presetIds' | 'presetMeta' | 'loadAtlas14' | 'log'>;

/** Run `fn`; any error it throws becomes a 400 with `detail` (the CLI's message, which quotes input, is dropped). */
function stage<T>(detail: string, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw invalid(detail);
  }
}

/** Facts the checks learned, recorded with the job. */
export interface CheckResult {
  assets?: { rows: number; usable: number; skippedRows: number };
}

/**
 * Everything the command would check before it starts the GPU, as a 400 with a fixed sentence. Mirrors prepare(),
 * portfolioCommand's CSV checks and siteCommand's ladder checks, calling the same functions.
 */
export async function checkSpec(env: CheckEnv, spec: JobSpec): Promise<CheckResult> {
  const o = spec.options;
  const out: CheckResult = {};
  const presetId = stage(MSG_PRESET, () => requirePreset(env, o));
  if (o.minutes !== undefined) stage(`scenario.minutes must be from ${ENSEMBLE_LIMITS.minMinutes} to ${ENSEMBLE_LIMITS.maxMinutes}.`, () => minutesOf(o));
  stage('scenario.climate is not a climate this server knows.', () => parseClimate(o.climate as string | undefined));

  if (spec.kind === 'portfolio') {
    const text = spec.csv ?? '';
    const table = parseCsv(text);
    if (table.error) throw invalid('assetsCsv could not be read as CSV (empty, binary, an unclosed quote, or too large).');
    if (table.truncatedRows) throw invalid(`assetsCsv has more than ${CSV_LIMITS.maxRows.toLocaleString('en-US')} asset rows.`);
    const parsed = parsePortfolio(text);
    if (parsed.fatal) throw invalid('assetsCsv needs an asset_id column and lat and lon (or wkt) columns.');
    if (!parsed.assets.length) throw invalid('assetsCsv has no usable assets (each needs an asset_id and a valid location).');
    out.assets = { rows: table.rows.length, usable: parsed.assets.length, skippedRows: parsed.errors.length };
  }
  if (spec.kind === 'site') stage('site is not a valid site (see docs/api.md SiteRequest).', () => siteFromOptions(o));

  const meta = env.presetMeta(presetId);
  if (!meta) return out; // the procedural sandbox: its scenario exists only once built, so the job checks it
  const flags = scenarioFlags(o);
  let rain: Atlas14Point | null = null;
  if (spec.kind === 'site' || flags.level !== undefined) rain = await rainAt(env, meta.bounds);
  const sc = meta.scenario;
  // Each scenario field alone first, so the sentence names the one that does not fit, then all together.
  if (flags.level !== undefined) stage('scenario.level is not a level of this preset: GET /v1/presets lists each preset’s levels.', () => resolveForcing(presetId, sc, { level: flags.level }, { rain }));
  if (flags.stageFt !== undefined) stage('scenario.stageFt is outside this preset’s gauge range, or the preset has no river stage: GET /v1/presets has each range.', () => resolveForcing(presetId, sc, { stageFt: flags.stageFt }, { rain }));
  if (flags.scale !== undefined) stage('scenario.scale must be a number of at least 0.', () => resolveForcing(presetId, sc, { scale: flags.scale }, { rain }));
  if (flags.rain !== undefined) stage('scenario.rainMmHr must be from 0 to 1000.', () => resolveForcing(presetId, sc, { rain: flags.rain }, { rain }));
  if (flags.manning !== undefined) stage('scenario.manningN must be from 0.005 to 0.3.', () => resolveForcing(presetId, sc, { manning: flags.manning }, { rain }));
  stage('The scenario does not fit this preset: GET /v1/presets lists its forcing and levels.', () => resolveForcing(presetId, sc, flags, { rain }));

  if (spec.kind === 'site') {
    const site = siteFromOptions(o);
    const b = meta.bounds;
    if (!(site.lat >= b.south && site.lat <= b.north && site.lon >= b.west && site.lon <= b.east)) throw invalid('The site is outside this preset’s map: GET /v1/presets has each map’s bounds.');
    const kind = o.ladder as LadderKind | undefined;
    const ladder = stage('sweep.ladder is not available for this preset: GET /v1/presets lists the ladders each preset has.', () => buildLadder(presetId, sc, { rain, kind }));
    const rp = parseRp(o.rp as string | undefined);
    if (o.sweep) {
      const todo = stage('sweep.levels names a level this preset’s ladder does not have, or one beyond its stage range.', () => sweepLevels(ladder.rungs, o.levels as string | undefined));
      if (!todo.length) throw invalid('The sweep has no levels to run.');
      for (const id of rp.keys()) if (!ladder.rungs.some((l) => l.id === id)) throw invalid('sweep.returnPeriods names a level this preset’s ladder does not have.');
      if (o.design !== undefined && !todo.some((l) => l.id === o.design)) throw invalid('sweep.design must be one of the levels swept.');
    }
    stage('The sweep does not fit this preset.', () => planSite(o, presetId, sc as TerrainData['scenario'], rain, rp));
  }
  return out;
}
