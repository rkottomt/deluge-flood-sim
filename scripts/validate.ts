/**
 * Validation against real floods: run each preset's scenario on the real GPU and compare it with what was observed.
 *
 *   npx tsx scripts/validation/fetch.ts       # once: observed data → public/validation/<preset>/ (cached raw downloads)
 *   npx tsx scripts/validate.ts               # every preset: run, score, write the summary, the report tables, the maps
 *   npx tsx scripts/validate.ts --preset=ftmyers,houston
 *   npx tsx scripts/validate.ts --score-only  # re-score saved fields (artifacts/validation/fields) without a GPU
 *   npx tsx scripts/validate.ts --no-images
 *
 * Outputs:
 *   public/validation/summary.json    one headline per preset (the app's Validation block) + the pinned metrics
 *   artifacts/validation/results.json every row (each mark, each gauge), every contingency table
 *   artifacts/validation/results.md   the tables docs/VALIDATION.md quotes
 *   docs/validation/*.png             model-vs-observed scatter plots and extent agreement maps
 *
 * The solver is the shipping `src/sim` on Dawn (scripts/validation/run.ts sets the scene up as the app does). What is
 * compared, and why that is like-for-like, is in src/validation/score.ts and docs/VALIDATION.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { create, globals } from 'webgpu';
import { createDelugeDevice } from '../src/gpu';
import { loadPresetData, runScenario, stageDiscMask, type PresetData, type RunDef, type RunOutput } from './validation/run';
import { EXTENT_CELL, FLOOD_M, GAUGE_SEARCH_M, HWM_SEARCH_M, WET_M, EMS_NEAR_M, scoreBfeProfile, scoreDamage, scoreEms, scoreFema, scoreGauges, scoreHwms, type DamageResult, type EmsResult, type FemaResult, type ModelFields, type PointResult } from '../src/validation/score';
import { decodeBuildings, type CompactBuildings } from '../src/data/buildings';
import type { ExtentScores, PointScores } from '../src/validation/metrics';
import { lineCells, rleDecode } from '../src/validation/raster';
import type { FemaZonesFile, ObservedFile, ValidationHeadline, ValidationSummary, ValidationSummaryEntry } from '../src/validation/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts/validation');
const FIELDS = path.join(OUT, 'fields');
const PUB = path.join(ROOT, 'public/validation');
const DOCS_IMG = path.join(ROOT, 'docs/validation');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);

// ─── what each preset runs and is scored against ─────────────────────────────────────────────────────────────────
export interface PresetPlan {
  runs: (obs: ObservedFile) => RunDef[];
  hwmRun?: string;
  gaugeRun?: string;
  /** The run compared with the FEMA 1 % zone, and whether that is like-for-like (a stage set to FEMA's own 1 % level). */
  femaRun?: string;
  femaLikeForLike?: boolean;
  emsRun?: string;
  /** The run compared with a parcel damage survey (observed.json `damage`). */
  damageRun?: string;
}

/**
 * Minutes the May 2010 crest is held after it arrives. The real crest stood above 50 ft for about a day, so the like-
 * for-like comparison is the steady flood at that level: chosen as the shortest hold after which the flooded
 * footprints stop changing, not by the score: holds of 30, 60, 120 and 240 min flood the same 172 footprints and
 * land within 0.2 % of each other (docs/VALIDATION.md, Nashville 2010) — the same 30 min as the FEMA run.
 */
export const NASHVILLE_2010_HOLD_MIN = 30;

const damageRun = (obs: ObservedFile): RunDef[] => {
  const d = obs.damage;
  if (!d) return [];
  return [{ id: 'may2010', description: `the May 2010 crest: stage raised to ${d.gauge.stageFt} ft at ${d.gauge.id} (USGS peak, ${d.date}) and held ${NASHVILLE_2010_HOLD_MIN} min`, minutes: NASHVILLE_2010_HOLD_MIN, stageFt: d.gauge.stageFt }];
};

const ladderRun = (obs: ObservedFile, minutes: number): RunDef[] => {
  const l = obs.fema?.ladder;
  if (!l) return [];
  return [{ id: 'fema-1pct', description: `stage raised to FEMA's 1 % level at ${l.gauge} (${l.levelFt} ft NAVD88) and held ${minutes} min`, minutes, stageLevel: l.level }];
};

export const PLANS: Record<string, PresetPlan> = {
  pittsburgh: { runs: (o) => ladderRun(o, 30), femaRun: 'fema-1pct', femaLikeForLike: true },
  nashville: { runs: (o) => [...ladderRun(o, 30), ...damageRun(o)], femaRun: 'fema-1pct', femaLikeForLike: true, damageRun: 'may2010' },
  ftmyers: {
    runs: (o) => [
      { id: 'ian', description: 'Hurricane Ian: the tide raised to the 12.92 ft record at NOAA 8725520 and held 60 min', minutes: 60, stageFt: 12.92 },
      ...ladderRun(o, 60),
    ],
    hwmRun: 'ian',
    femaRun: 'fema-1pct',
    femaLikeForLike: true,
  },
  houston: { runs: () => [{ id: 'harvey', description: 'the shipped scenario: 173 mm/hr for 60 min with Buffalo Bayou at 923 m³/s', minutes: 60 }], hwmRun: 'harvey', femaRun: 'harvey', femaLikeForLike: false },
  // 180 min: both peaks held until the water surface is steady at both gauges (180, 240 and 360 min agree to 1 cm;
  // at 90 min the French Broad gauge was still 1.5 m short of it — the peak had not arrived).
  asheville: { runs: () => [{ id: 'helene', description: 'the shipped scenario: both rivers at their Helene peak discharge, held 180 min until steady', minutes: 180 }], gaugeRun: 'helene', femaRun: 'helene', femaLikeForLike: false },
  boulder: { runs: () => [{ id: 'event', description: 'the shipped scenario: 238 m³/s out of Boulder Canyon for 60 min', minutes: 60 }], femaRun: 'event', femaLikeForLike: false },
  ellicott: { runs: () => [{ id: 'event', description: 'the shipped scenario: 110 mm/hr storm cell + the Patapsco 2016 peak for 60 min', minutes: 60 }], femaRun: 'event', femaLikeForLike: false },
  johnstown: { runs: () => [{ id: 'event', description: 'the shipped scenario: the 1889 dam-break inflow for 60 min', minutes: 60 }], femaRun: 'event', femaLikeForLike: false },
  nepal: { runs: () => [{ id: 'trishuli', description: 'the shipped scenario: the routed debris-flood hydrograph, 140 min', minutes: 140 }], emsRun: 'trishuli' },
  chamoli: { runs: () => [] },
  chungthang: { runs: () => [] },
};

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, 'utf8')) as T;
const fmt = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));
const sgn = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(d)}`);
const pct = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '—' : `${(v * 100).toFixed(d)} %`);
const round = (v: number | null | undefined, d = 4) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);

function fieldFile(preset: string, run: string) {
  return path.join(FIELDS, `${preset}-${run}.maxdepth.f32.gz`);
}
function saveField(preset: string, run: string, out: RunOutput) {
  fs.mkdirSync(FIELDS, { recursive: true });
  fs.writeFileSync(fieldFile(preset, run), zlib.gzipSync(Buffer.from(out.maxDepth.buffer, out.maxDepth.byteOffset, out.maxDepth.byteLength)));
  const { maxDepth: _m, ground: _g, ...rest } = out;
  fs.writeFileSync(path.join(FIELDS, `${preset}-${run}.json`), JSON.stringify(rest, null, 1));
}
function loadField(p: PresetData, run: RunDef): RunOutput {
  const buf = zlib.gunzipSync(fs.readFileSync(fieldFile(p.id, run.id)));
  const maxDepth = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const rest = readJson<Omit<RunOutput, 'maxDepth' | 'ground'>>(path.join(FIELDS, `${p.id}-${run.id}.json`));
  return { ...rest, maxDepth, ground: p.elevation };
}

// ─── scoring one preset ─────────────────────────────────────────────────────────────────────────────────────────
export interface PresetResult {
  preset: string;
  name: string;
  event: string;
  none: string | null;
  runs: Array<{ id: string; description: string; simMinutes: number; wallSeconds: number; substeps: number; massError: number; stageFt: number | null; nonFinite: number }>;
  hwm?: PointResult & { run: string; rejected: number; accepted: number; sites: number };
  gauges?: PointResult & { run: string };
  fema?: Omit<FemaResult, 'cells'> & { run: string; likeForLike: boolean; level?: { ft: number; m: number; gauge: string; stageFt: number | null } };
  ems?: EmsResult & { run: string };
  /** Deluge's water surface against FEMA's 1 % profile (Base Flood Elevation lines crossing the forced rivers). */
  bfe?: PointResult & { run: string };
  /** A parcel damage survey of a historic flood, building by building (src/validation/score.ts scoreDamage). */
  damage?: Omit<DamageResult, 'outcome' | 'centroids'> & { run: string; event: string; parcels: number; stageFt: number; gauge: string };
}

/** The preset's building footprints (grid coordinates), or null when it has none. */
export function loadFootprints(p: PresetData) {
  const f = p.meta.files.buildings;
  if (!f) return null;
  return decodeBuildings(readJson<CompactBuildings>(path.join(ROOT, 'public/presets', p.id, f)));
}

export function scorePreset(
  p: PresetData,
  obs: ObservedFile,
  plan: PresetPlan,
  outputs: Map<string, RunOutput>,
): { result: PresetResult; femaCells: Uint8Array | null; damage: DamageResult | null } {
  const result: PresetResult = {
    preset: p.id,
    name: p.meta.name,
    event: obs.event,
    none: obs.none,
    runs: [...outputs.values()].map((o) => ({
      id: o.run.id,
      description: o.run.description,
      simMinutes: round(o.simTime / 60, 2) as number,
      wallSeconds: round(o.wallSeconds, 1) as number,
      substeps: o.substeps,
      massError: o.stats.massError,
      stageFt: round(o.stageFt, 2),
      nonFinite: o.nonFinite,
    })),
  };
  const exclude = stageDiscMask(p);
  const fieldsOf = (id: string): ModelFields => {
    const o = outputs.get(id);
    if (!o) throw new Error(`${p.id}: run ${id} missing`);
    return { nx: p.meta.nx, ny: p.meta.ny, cellSize: p.meta.cellSize, ground: o.ground, maxDepth: o.maxDepth, initialWater: p.initialWater, exclude };
  };
  if (plan.hwmRun && obs.hwm) {
    const r = scoreHwms(fieldsOf(plan.hwmRun), obs);
    if (r) result.hwm = { ...r, run: plan.hwmRun, rejected: obs.hwm.rejected.length, accepted: obs.hwm.marksAccepted, sites: obs.hwm.sites.length };
  }
  if (plan.gaugeRun && obs.gauges) {
    const r = scoreGauges(fieldsOf(plan.gaugeRun), obs.gauges);
    if (r) result.gauges = { ...r, run: plan.gaugeRun };
  }
  let femaCells: Uint8Array | null = null;
  if (plan.femaRun && obs.fema && outputs.has(plan.femaRun)) {
    const zones = readJson<FemaZonesFile>(path.join(PUB, p.id, obs.fema.file));
    const { cells, ...rest } = scoreFema(fieldsOf(plan.femaRun), zones);
    femaCells = cells;
    const l = obs.fema.ladder;
    result.fema = {
      ...rest,
      run: plan.femaRun,
      likeForLike: !!plan.femaLikeForLike,
      ...(l && plan.femaLikeForLike ? { level: { ft: l.levelFt, m: l.level, gauge: l.gauge, stageFt: round(outputs.get(plan.femaRun)?.stageFt, 2) } } : {}),
    };
  }
  const bfeLines = obs.fema?.ladder?.bfeLines;
  if (plan.femaRun && plan.femaLikeForLike && bfeLines?.length && outputs.has(plan.femaRun)) {
    const { rows, scores } = scoreBfeProfile(fieldsOf(plan.femaRun), bfeLines);
    result.bfe = {
      run: plan.femaRun,
      rows: rows.map((r, k) => ({ id: `BFE ${k + 1}`, name: `${(r.elevation / 0.3048).toFixed(0)} ft line at (${r.gx.toFixed(0)}, ${r.gy.toFixed(0)})`, observed: r.elevation, modelled: r.modelled, residual: r.residual, distanceM: 0, ground: NaN, depthAtPoint: 0 })),
      wet: scores,
      dry: 0,
      all: scores,
    };
  }
  if (plan.emsRun && obs.ems && outputs.has(plan.emsRun)) {
    result.ems = { ...scoreEms(fieldsOf(plan.emsRun), obs.ems), run: plan.emsRun };
  }
  let damage: DamageResult | null = null;
  const fp = plan.damageRun && obs.damage && outputs.has(plan.damageRun) ? loadFootprints(p) : null;
  if (plan.damageRun && obs.damage && fp) {
    const sfha = obs.fema ? rleDecode(readJson<FemaZonesFile>(path.join(PUB, p.id, obs.fema.file)).rle, p.meta.nx * p.meta.ny) : null;
    damage = scoreDamage(fieldsOf(plan.damageRun), obs.damage.maskRle, fp, { sfhaCls: sfha, crestLevel: obs.damage.gauge.elevation });
    const { outcome: _o, centroids: _c, ...rest } = damage;
    result.damage = { ...rest, run: plan.damageRun, event: obs.damage.event, parcels: obs.damage.parcels, stageFt: obs.damage.gauge.stageFt, gauge: obs.damage.gauge.id };
  }
  return { result, femaCells, damage };
}

/** The one number per preset the app shows, and the metrics the regression test pins. */
export function summarise(r: PresetResult): ValidationSummaryEntry {
  const metrics: Record<string, number | null> = {};
  let headline: ValidationHeadline | null = null;
  const put = (k: string, v: number | null | undefined) => (metrics[k] = round(v, 4));
  const putPoints = (prefix: string, s: PointScores) => {
    put(`${prefix}.n`, s.n);
    put(`${prefix}.bias`, s.bias);
    put(`${prefix}.rmse`, s.rmse);
    put(`${prefix}.within03`, s.within03);
    put(`${prefix}.within1`, s.within1);
  };
  const putExtent = (prefix: string, s: ExtentScores) => {
    put(`${prefix}.csi`, s.csi);
    put(`${prefix}.hitRate`, s.hitRate);
    put(`${prefix}.falseAlarmRatio`, s.falseAlarmRatio);
    put(`${prefix}.frequencyBias`, s.frequencyBias);
  };
  if (r.fema) {
    putExtent('fema.connected', r.fema.connected);
    putExtent('fema.all', r.fema.all);
    put('fema.floodedIn02', r.fema.floodedIn02);
    if (r.bfe) putPoints('bfe', r.bfe.wet);
    if (r.fema.likeForLike) {
      const c = r.fema.connected;
      headline = {
        label: `FEMA 1 % flood zone, at the 1 % river level (${r.fema.level?.stageFt?.toFixed(1)} ft)`,
        value: `CSI ${pct(c.csi)} · hit rate ${pct(c.hitRate)} · false alarms ${pct(c.falseAlarmRatio)}${r.bfe?.wet.n ? ` · 1 % profile ${sgn(r.bfe.wet.bias)} m` : ''}`,
        note: 'Share of FEMA’s mapped 1 % floodplain (of the rivers this scene forces) that Deluge floods at the same river level, and how much it floods outside it.',
      };
    } else {
      const c = r.fema.all;
      headline = {
        label: 'FEMA 1 % flood zone (context only — this scenario is not the 1 % flood)',
        value: `floods ${pct(c.hitRate)} of it · ${pct(c.falseAlarmRatio)} of the flood lies outside it`,
        note: 'Not a skill score: the scenario is a historic event, not FEMA’s 1 % design flood.',
      };
    }
  }
  if (r.gauges) {
    putPoints('gauges', r.gauges.wet);
    put('gauges.dry', r.gauges.dry);
    for (const row of r.gauges.rows) put(`gauge.${row.id.replace(/\s+/g, '')}.residual`, row.residual);
    headline = {
      label: 'USGS gauge peaks, Helene 2024',
      value: r.gauges.rows.map((row) => `${row.name.split(' at ')[0].replace(' River', '')} ${sgn(row.residual)} m`).join(' · '),
      note: 'Modelled peak water level minus the gauged Helene peak (NAVD88), at the two USGS gauges in the domain.',
    };
  }
  if (r.hwm) {
    putPoints('hwm', r.hwm.wet);
    putPoints('hwm.all', r.hwm.all);
    put('hwm.dry', r.hwm.dry);
    const s = r.hwm.wet;
    headline = {
      label: `USGS high-water marks (${r.hwm.sites} sites)`,
      value: `bias ${sgn(s.bias)} m · RMSE ${fmt(s.rmse)} m · ${pct(s.within03)} within ±0.3 m${r.hwm.dry ? ` · ${r.hwm.dry} dry in the model` : ''}`,
      note: r.runs.find((x) => x.id === r.hwm?.run)?.stageFt != null
        ? 'Modelled peak water level minus the surveyed high-water mark (NAVD88). The tide is set to the gauged peak, so this checks how the surge spreads over the city, not a surge forecast.'
        : 'Modelled peak water level minus the surveyed high-water mark, NAVD88, at the marks the model wets.',
    };
  }
  if (r.ems) {
    put('ems.buildingHitRate', r.ems.buildingHitRate);
    put('ems.buildingHitRateNear', r.ems.buildingHitRateNear);
    putExtent('ems.roads', r.ems.roads);
    const n = (r.ems.buildings['Destroyed']?.n ?? 0) + (r.ems.buildings['Damaged']?.n ?? 0);
    headline = {
      label: `Copernicus EMS damage grading (EMSR927, ${n} damaged or destroyed buildings)`,
      value: `reaches ${pct(r.ems.buildingHitRate)} of them · road CSI ${pct(r.ems.roads.csi)}`,
      note: 'Share of the buildings EMS graded destroyed or damaged that the modelled flood reaches, and agreement on which road stretches were destroyed.',
    };
  }
  const more: ValidationHeadline[] = [];
  if (r.damage) {
    const d = r.damage;
    putExtent('damage.buildings', d.buildings);
    put('damage.parcelArea', d.parcelCells ? d.parcelCellsFlooded / d.parcelCells : null);
    if (d.inReach) putExtent('damage.inReach', d.inReach);
    const b = d.buildings;
    const reach = d.inReach;
    const outOfReach = reach && b.hits + b.misses ? 1 - (reach.hits + reach.misses) / (b.hits + b.misses) : null;
    more.push({
      label: `May 2010 flood: Metro Nashville’s damage survey, river at the ${d.stageFt.toFixed(2)} ft crest`,
      value: `reaches ${pct(b.hitRate)} of the damaged buildings${reach ? ` (${pct(reach.hitRate)} of those the river could reach)` : ''} · ${pct(b.falseAlarmRatio)} of the buildings it floods were not recorded`,
      note: `Building by building, against the parcels the city recorded as damaged.${outOfReach !== null ? ` ${pct(outOfReach)} of that damage stands above the crest or out of the river’s reach — creeks, rain and drains this scene does not run.` : ''} Damage is not inundation.`,
    });
  }
  return {
    preset: r.preset,
    event: r.event,
    headline,
    ...(more.length ? { more } : {}),
    metrics,
    runs: r.runs.map((x) => ({ id: x.id, description: x.description, simMinutes: x.simMinutes })),
  };
}

// ─── report tables ──────────────────────────────────────────────────────────────────────────────────────────────
function markdown(results: PresetResult[], gpu: string): string {
  const L: string[] = [];
  L.push(`# Validation results`, '', `Generated ${new Date().toISOString()} by \`npx tsx scripts/validate.ts\` on ${gpu}.`, '');
  L.push(`Point matching: nearest cell with max depth ≥ ${WET_M} m within ${HWM_SEARCH_M} m of a mark (${GAUGE_SEARCH_M} m of a gauge). Flooded land: max depth ≥ ${FLOOD_M} m.`, '');
  L.push('## Runs', '', '| Preset | Run | What | Sim min | Wall s | Substeps | Mass error |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) for (const x of r.runs) L.push(`| ${r.preset} | ${x.id} | ${x.description} | ${fmt(x.simMinutes, 1)} | ${fmt(x.wallSeconds, 0)} | ${x.substeps} | ${x.massError.toExponential(1)} |`);
  L.push('');
  const pointTable = (title: string, pr: PointResult) => {
    const s = pr.wet;
    L.push(`### ${title}`, '');
    L.push(`Wetted: ${s.n} of ${pr.rows.length} · bias ${sgn(s.bias)} m · RMSE ${fmt(s.rmse)} m · MAE ${fmt(s.mae)} m · median ${sgn(s.median)} m · within ±0.3 m ${pct(s.within03)} · within ±1 m ${pct(s.within1)}${pr.dry ? ` · dry in the model: ${pr.dry}` : ''}`);
    if (pr.dry) L.push('', `All ${pr.all.n}, dry scored as WSE = ground (favours the model): bias ${sgn(pr.all.bias)} m, RMSE ${fmt(pr.all.rmse)} m, within ±0.3 m ${pct(pr.all.within03)}`);
    if (pr.rows.every((row) => !Number.isFinite(row.ground))) {
      L.push('', '| Line | Where (grid) | FEMA BFE (m) | Deluge (m) | Deluge − FEMA (m) |', '| --- | --- | --- | --- | --- |');
      for (const row of pr.rows) L.push(`| ${row.id} | ${row.name} | ${fmt(row.observed)} | ${fmt(row.modelled)} | ${sgn(row.residual)} |`);
      L.push('');
      return;
    }
    L.push('', '| Site | Where | Observed (m) | Modelled (m) | Model − obs (m) | Read at (m) | DEM ground (m) | Obs − ground (m) |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const row of pr.rows) {
      L.push(`| ${row.id} | ${row.name.replace(/\|/g, '/').slice(0, 60)} | ${fmt(row.observed)} | ${fmt(row.modelled)} | ${row.residual === null ? 'dry' : sgn(row.residual)} | ${fmt(row.distanceM, 0)} | ${fmt(row.ground)} | ${sgn(row.observed - row.ground)} |`);
    }
    L.push('');
  };
  const ext = (s: ExtentScores) => `${pct(s.csi, 1)} | ${pct(s.hitRate, 1)} | ${pct(s.falseAlarmRatio, 1)} | ${fmt(s.frequencyBias)} | ${s.hits} | ${s.misses} | ${s.falseAlarms} | ${s.correctNegatives}`;
  for (const r of results) {
    L.push(`## ${r.preset} — ${r.name}`, '', `Observed: ${r.event}`, '');
    if (r.none) L.push(r.none, '');
    if (r.hwm) pointTable(`High-water marks (run \`${r.hwm.run}\`; ${r.hwm.accepted} marks accepted at ${r.hwm.sites} sites, ${r.hwm.rejected} rejected)`, r.hwm);
    if (r.gauges) pointTable(`Gauge peaks (run \`${r.gauges.run}\`)`, r.gauges);
    if (r.fema) {
      L.push(`### FEMA 1 % zone (run \`${r.fema.run}\`, ${r.fema.likeForLike ? `like-for-like: the stage set to FEMA's 1 % level ${r.fema.level?.ft} ft NAVD88 at ${r.fema.level?.gauge}, gauge ${r.fema.level?.stageFt} ft` : 'CONTEXT ONLY — the run is a historic event, not the 1 % flood'})`, '');
      L.push('| Comparison | CSI | Hit rate | False-alarm ratio | Frequency bias | Hits | Misses | False alarms | Correct dry |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      L.push(`| 1 % zones connected to the forced rivers | ${ext(r.fema.connected)} |`);
      L.push(`| every 1 % zone in the domain | ${ext(r.fema.all)} |`);
      L.push('', `Share of the 0.2 % zone (shaded X) flooded: ${pct(r.fema.floodedIn02, 1)}`, '');
    }
    if (r.bfe) pointTable(`FEMA 1 % profile: Deluge water surface at each Base Flood Elevation line crossing a forced river (run \`${r.bfe.run}\`)`, r.bfe);
    if (r.damage) {
      const d = r.damage;
      const b = d.buildings;
      L.push(`### ${d.event}: parcel damage survey, building by building (run \`${d.run}\`, ${d.stageFt} ft at ${d.gauge})`, '');
      L.push(`${d.parcels} damaged parcels in the domain. Building footprints compared: ${b.cells}.`, '');
      L.push('| Comparison | CSI | Hit rate | False-alarm ratio | Frequency bias | Hits | Misses | False alarms | Correct dry |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      L.push(`| footprints: on a damaged parcel vs modelled flooded | ${ext(b)} |`);
      if (d.inReach) L.push(`| … only footprints within the river's reach at the crest (below ${d.stageFt} ft, connected to the river) | ${ext(d.inReach)} |`);
      L.push('');
      L.push(`Damaged-parcel land flooded by the model: ${pct(d.parcelCells ? d.parcelCellsFlooded / d.parcelCells : null, 1)} of ${d.parcelCells} cells.${d.damagedInSfha !== null ? ` Damaged footprints touching FEMA's 1 % zone: ${d.damagedInSfha} of ${b.hits + b.misses} (${pct(b.hits + b.misses ? d.damagedInSfha / (b.hits + b.misses) : null)}).` : ''}`, '');
    }
    if (r.ems) {
      L.push(`### Copernicus EMS EMSR927 damage grading (run \`${r.ems.run}\`, ${r.ems.analysedCells} analysed cells)`, '');
      L.push('| Grade | Buildings | Reached by the modelled flood |', '| --- | --- | --- |');
      for (const [g, v] of Object.entries(r.ems.buildings)) L.push(`| ${g} | ${v.n} | ${v.flooded} (${pct(v.n ? v.flooded / v.n : null)}) |`);
      L.push('', `Destroyed + damaged reached: ${pct(r.ems.buildingHitRate, 1)} (within ${EMS_NEAR_M} m of the modelled flood: ${pct(r.ems.buildingHitRateNear, 1)})`, '');
      L.push('| Road cells: destroyed/damaged vs no visible damage | CSI | Hit rate | False-alarm ratio | Frequency bias | Hits | Misses | False alarms | Correct dry |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      L.push(`| | ${ext(r.ems.roads)} |`, '');
    }
  }
  return L.join('\n') + '\n';
}

// ─── images ─────────────────────────────────────────────────────────────────────────────────────────────────────
function hillshade(z: Float32Array, nx: number, ny: number, cell: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const g = (a: number, b: number) => z[Math.min(ny - 1, Math.max(0, b)) * nx + Math.min(nx - 1, Math.max(0, a))];
      const dzdx = (g(i + 1, j) - g(i - 1, j)) / (2 * cell);
      const dzdy = (g(i, j + 1) - g(i, j - 1)) / (2 * cell);
      const slope = Math.atan(Math.hypot(dzdx, dzdy) * 2);
      const aspect = Math.atan2(dzdy, -dzdx);
      const v = Math.cos(alt) * Math.cos(slope) + Math.sin(alt) * Math.sin(slope) * Math.cos(az - aspect);
      out[j * nx + i] = Math.max(0, Math.min(255, Math.round(150 + 90 * v)));
    }
  }
  return out;
}

type Shot = { file: string; html: string; width: number; height: number };

const PAGE_CSS = `body{margin:0;background:#fff;font:13px/1.35 -apple-system,"Segoe UI",Helvetica,Arial,sans-serif;color:#1d232b}
h1{font-size:15px;margin:0 0 2px}p{margin:0;color:#4a5562}.wrap{padding:14px 16px}
.legend{display:flex;flex-wrap:wrap;gap:6px 14px;margin-top:8px}.legend span{display:inline-flex;align-items:center;gap:6px}
.legend i{width:14px;height:14px;border-radius:3px;display:inline-block;border:1px solid rgba(0,0,0,.15)}`;

const EXTENT_COLORS: Record<number, [number, number, number, number]> = {
  [EXTENT_CELL.hit]: [37, 99, 235, 220],
  [EXTENT_CELL.miss]: [245, 158, 11, 220],
  [EXTENT_CELL.falseAlarm]: [219, 39, 119, 220],
  [EXTENT_CELL.permanentWater]: [125, 165, 200, 255],
  [EXTENT_CELL.otherFlood]: [167, 139, 250, 120],
};

function extentShot(p: PresetData, cells: Uint8Array, r: PresetResult): Shot {
  const { nx, ny, cellSize } = p.meta;
  const hs = hillshade(p.elevation, nx, ny, cellSize);
  const rgba = Buffer.alloc(nx * ny * 4);
  for (let k = 0; k < nx * ny; k++) {
    const g = hs[k];
    let [cr, cg, cb] = [g, g, g];
    const c = EXTENT_COLORS[cells[k]];
    if (c) {
      const a = c[3] / 255;
      cr = Math.round(cr * (1 - a) + c[0] * a);
      cg = Math.round(cg * (1 - a) + c[1] * a);
      cb = Math.round(cb * (1 - a) + c[2] * a);
    }
    rgba[4 * k] = cr;
    rgba[4 * k + 1] = cg;
    rgba[4 * k + 2] = cb;
    rgba[4 * k + 3] = 255;
  }
  const png = encodePng(rgba, nx, ny).toString('base64');
  const f = r.fema!;
  const s = f.connected;
  const title = f.likeForLike
    ? `${r.name}: FEMA 1 % zone vs Deluge at the 1 % river level (${f.level?.stageFt} ft at ${f.level?.gauge})`
    : `${r.name}: FEMA 1 % zone vs the shipped scenario — context, not like-for-like`;
  const html = `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style><div class="wrap" id="shot" style="width:640px">
<h1>${title}</h1><p>CSI ${pct(s.csi, 1)} · hit rate ${pct(s.hitRate, 1)} · false-alarm ratio ${pct(s.falseAlarmRatio, 1)} · flooded = max depth ≥ ${FLOOD_M} m · ${(nx * cellSize / 1000).toFixed(1)} km across, north up</p>
<img src="data:image/png;base64,${png}" style="width:640px;height:640px;display:block;margin-top:8px;image-rendering:auto">
<div class="legend"><span><i style="background:#2563eb"></i>both flooded</span><span><i style="background:#f59e0b"></i>FEMA 1 % only (miss)</span><span><i style="background:#db2777"></i>Deluge only (false alarm)</span><span><i style="background:#7da5c8"></i>permanent water / river at t = 0</span><span><i style="background:#cdbdfb"></i>1 % zone not connected to the forced water (left out)</span></div></div>`;
  return { file: `${p.id}-fema-extent.png`, html, width: 672, height: 760 };
}

/** Copernicus EMS damage grades over the modelled flood, cropped to the analysed area. */
function emsShot(p: PresetData, obs: ObservedFile, maxDepth: Float32Array, r: PresetResult): Shot {
  const { nx, ny, cellSize } = p.meta;
  const ems = obs.ems!;
  const analysed = rleDecode(ems.analysedRle, nx * ny);
  let i0 = nx, i1 = 0, j0 = ny, j1 = 0;
  for (let k = 0; k < nx * ny; k++) {
    if (!analysed[k]) continue;
    const i = k % nx;
    const j = (k - i) / nx;
    i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
  }
  const pad = 24;
  i0 = Math.max(0, i0 - pad); j0 = Math.max(0, j0 - pad); i1 = Math.min(nx - 1, i1 + pad); j1 = Math.min(ny - 1, j1 + pad);
  // Square crop so the picture keeps the grid's aspect.
  const side = Math.max(i1 - i0, j1 - j0) + 1;
  i0 = Math.max(0, Math.min(nx - side, i0)); j0 = Math.max(0, Math.min(ny - side, j0));
  const W = Math.min(side, nx - i0);
  const H = Math.min(side, ny - j0);
  const hs = hillshade(p.elevation, nx, ny, cellSize);
  const rgba = Buffer.alloc(W * H * 4);
  const put = (x: number, y: number, c: number[], a = 1) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = 4 * (y * W + x);
    for (let q = 0; q < 3; q++) rgba[o + q] = Math.round(rgba[o + q] * (1 - a) + c[q] * a);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = (j0 + y) * nx + (i0 + x);
      const g = analysed[k] ? hs[k] : Math.round(hs[k] * 0.75 + 255 * 0.25);
      const o = 4 * (y * W + x);
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
      rgba[o + 3] = 255;
      if (p.initialWater[k] > 0) put(x, y, [125, 165, 200]);
      else if (maxDepth[k] >= FLOOD_M) put(x, y, [37, 99, 235], 0.55);
    }
  }
  for (const rd of ems.roads) {
    if (rd.grade !== 'Destroyed' && rd.grade !== 'Damaged') continue;
    for (const k of lineCells(nx, ny, rd.pts)) {
      if (!analysed[k]) continue;
      put((k % nx) - i0, Math.floor(k / nx) - j0, [120, 53, 15]);
    }
  }
  for (const b of ems.buildings) {
    if (b.grade !== 'Destroyed' && b.grade !== 'Damaged') continue;
    const i = Math.floor(b.gx);
    const j = Math.floor(b.gy);
    if (!analysed[j * nx + i]) continue;
    let hit = false;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if (maxDepth[(j + dj) * nx + i + di] >= FLOOD_M) hit = true;
    const c = hit ? [30, 58, 138] : [245, 158, 11];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) put(i - i0 + dx, j - j0 + dy, c);
  }
  const png = encodePng(rgba, W, H).toString('base64');
  const e = r.ems!;
  const html = `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style><div class="wrap" id="shot" style="width:640px">
<h1>${p.meta.name}: Deluge's debris flood vs Copernicus EMS damage grading (${ems.activation} AOI${String(ems.aoi).padStart(2, '0')})</h1>
<p>Reaches ${pct(e.buildingHitRate, 1)} of the buildings EMS graded destroyed or damaged · road cells: hit rate ${pct(e.roads.hitRate, 1)}, false-alarm ratio ${pct(e.roads.falseAlarmRatio, 1)} · ${(W * cellSize / 1000).toFixed(1)} km across, north up · outside the analysed area is faded</p>
<img src="data:image/png;base64,${png}" style="width:640px;height:${Math.round((640 * H) / W)}px;display:block;margin-top:8px;image-rendering:pixelated">
<div class="legend"><span><i style="background:#7fa1e6"></i>Deluge flood (max depth ≥ ${FLOOD_M} m)</span><span><i style="background:#7da5c8"></i>river at t = 0</span><span><i style="background:#1e3a8a"></i>destroyed/damaged building, reached</span><span><i style="background:#f59e0b"></i>destroyed/damaged building, not reached</span><span><i style="background:#78350f"></i>road graded destroyed/damaged</span></div>
<p style="margin-top:6px">Damage grading © European Union, 2026, Copernicus Emergency Management Service.</p></div>`;
  return { file: `${p.id}-ems.png`, html, width: 672, height: Math.round((640 * H) / W) + 170 };
}

/** A parcel damage survey over the modelled flood: every compared building as a dot coloured by its outcome. */
function damageShot(p: PresetData, obs: ObservedFile, maxDepth: Float32Array, damage: DamageResult, r: PresetResult): Shot {
  const { nx, ny, cellSize } = p.meta;
  const hs = hillshade(p.elevation, nx, ny, cellSize);
  const mask = rleDecode(obs.damage!.maskRle, nx * ny);
  const rgba = Buffer.alloc(nx * ny * 4);
  const put = (k: number, c: number[], a = 1) => {
    for (let q = 0; q < 3; q++) rgba[4 * k + q] = Math.round(rgba[4 * k + q] * (1 - a) + c[q] * a);
  };
  for (let k = 0; k < nx * ny; k++) {
    rgba[4 * k] = rgba[4 * k + 1] = rgba[4 * k + 2] = hs[k];
    rgba[4 * k + 3] = 255;
    if (p.initialWater[k] > 0) put(k, [125, 165, 200]);
    else if (maxDepth[k] >= FLOOD_M) put(k, [37, 99, 235], 0.35);
    if (mask[k]) put(k, [120, 113, 108], 0.35);
  }
  const colour: Record<number, number[]> = {
    [EXTENT_CELL.hit]: [30, 58, 138],
    [EXTENT_CELL.miss]: [245, 158, 11],
    [EXTENT_CELL.falseAlarm]: [219, 39, 119],
  };
  for (let b = 0; b < damage.outcome.length; b++) {
    const c = colour[damage.outcome[b]];
    if (!c) continue;
    const i = Math.floor(damage.centroids[2 * b]);
    const j = Math.floor(damage.centroids[2 * b + 1]);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const x = i + di;
      const y = j + dj;
      if (x >= 0 && y >= 0 && x < nx && y < ny) put(y * nx + x, c);
    }
  }
  const png = encodePng(rgba, nx, ny).toString('base64');
  const d = r.damage!;
  const html = `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style><div class="wrap" id="shot" style="width:640px">
<h1>${p.meta.name}: Deluge at the May 2010 crest (${d.stageFt} ft) vs Metro Nashville's damage survey</h1>
<p>Buildings on damaged parcels reached ${pct(d.buildings.hitRate, 1)} · buildings flooded but not recorded ${pct(d.buildings.falseAlarmRatio, 1)} · CSI ${pct(d.buildings.csi, 1)} · flooded = max depth ≥ ${FLOOD_M} m · ${(nx * cellSize / 1000).toFixed(1)} km across, north up</p>
<img src="data:image/png;base64,${png}" style="width:640px;height:640px;display:block;margin-top:8px;image-rendering:auto">
<div class="legend"><span><i style="background:#9fb6ea"></i>Deluge flood</span><span><i style="background:#7da5c8"></i>river at t = 0</span><span><i style="background:#b9b4b0"></i>parcel recorded damaged</span><span><i style="background:#1e3a8a"></i>building on a damaged parcel, flooded</span><span><i style="background:#f59e0b"></i>on a damaged parcel, dry in the model</span><span><i style="background:#db2777"></i>flooded, not recorded</span></div>
<p style="margin-top:6px">Damage survey: Metro Nashville (MetroGIS, Metro Stormwater, Metro Codes). Buildings © OpenStreetMap contributors (ODbL).</p></div>`;
  return { file: `${p.id}-may2010-damage.png`, html, width: 672, height: 800 };
}

function scatterShot(id: string, title: string, subtitle: string, pr: PointResult, xLabel = 'Observed peak water level (m NAVD88)'): Shot {
  const W = 560;
  const H = 520;
  const m = { l: 62, r: 18, t: 16, b: 50 };
  const pts = pr.rows.map((row) => ({ o: row.observed, m: row.modelled ?? row.ground + row.depthAtPoint, dry: row.modelled === null, id: row.id }));
  const vals = pts.flatMap((q) => [q.o, q.m]);
  let lo = Math.floor(Math.min(...vals) - 0.5);
  let hi = Math.ceil(Math.max(...vals) + 0.5);
  if (hi - lo < 2) {
    lo -= 1;
    hi += 1;
  }
  const X = (v: number) => m.l + ((v - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (v: number) => H - m.b - ((v - lo) / (hi - lo)) * (H - m.t - m.b);
  const step = hi - lo > 12 ? 2 : hi - lo > 6 ? 1 : 0.5;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
  const band = (d: number, fill: string) =>
    `<polygon points="${X(lo)},${Y(lo + d)} ${X(hi - d)},${Y(hi)} ${X(hi)},${Y(hi)} ${X(hi)},${Y(hi - d)} ${X(lo + d)},${Y(lo)} ${X(lo)},${Y(lo)}" fill="${fill}"/>`;
  const svg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block;margin-top:8px">
${band(1, '#eef2f7')}${band(0.3, '#dbe4ef')}
${ticks.map((t) => `<line x1="${X(t)}" y1="${Y(lo)}" x2="${X(t)}" y2="${Y(hi)}" stroke="#e5e7eb"/><line x1="${X(lo)}" y1="${Y(t)}" x2="${X(hi)}" y2="${Y(t)}" stroke="#e5e7eb"/>
<text x="${X(t)}" y="${H - m.b + 16}" text-anchor="middle" font-size="11" fill="#4a5562">${t}</text><text x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end" font-size="11" fill="#4a5562">${t}</text>`).join('')}
<line x1="${X(lo)}" y1="${Y(lo)}" x2="${X(hi)}" y2="${Y(hi)}" stroke="#4a5562" stroke-dasharray="4 3"/>
<rect x="${X(lo)}" y="${Y(hi)}" width="${X(hi) - X(lo)}" height="${Y(lo) - Y(hi)}" fill="none" stroke="#9aa4b1"/>
${pts.map((q) => (q.dry ? `<circle cx="${X(q.o)}" cy="${Y(q.m)}" r="5" fill="#fff" stroke="#db2777" stroke-width="2"><title>${q.id}</title></circle>` : `<circle cx="${X(q.o)}" cy="${Y(q.m)}" r="5" fill="#2563eb" fill-opacity=".85" stroke="#fff"><title>${q.id}</title></circle>`)).join('')}
<text x="${(X(lo) + X(hi)) / 2}" y="${H - 10}" text-anchor="middle" font-size="12" fill="#1d232b">${xLabel}</text>
<text transform="translate(16 ${(Y(lo) + Y(hi)) / 2}) rotate(-90)" text-anchor="middle" font-size="12" fill="#1d232b">Deluge peak water level (m NAVD88)</text>
</svg>`;
  const s = pr.wet;
  const html = `<!doctype html><meta charset="utf-8"><style>${PAGE_CSS}</style><div class="wrap" id="shot" style="width:${W}px">
<h1>${title}</h1><p>${subtitle}</p><p>bias ${sgn(s.bias)} m · RMSE ${fmt(s.rmse)} m · ${pct(s.within03)} within ±0.3 m · ${pct(s.within1)} within ±1 m (n = ${s.n}${pr.dry ? `; ${pr.dry} dry in the model, drawn hollow at ground level` : ''})</p>
${svg}<div class="legend"><span><i style="background:#dbe4ef"></i>±0.3 m</span><span><i style="background:#eef2f7"></i>±1 m</span><span><i style="background:#2563eb;border-radius:50%"></i>wetted by the model</span>${pr.dry ? '<span><i style="background:#fff;border:2px solid #db2777;border-radius:50%"></i>dry in the model</span>' : ''}</div></div>`;
  return { file: `${id}.png`, html, width: W + 32, height: H + 130 };
}

async function renderShots(shots: Shot[]): Promise<void> {
  if (shots.length === 0) return;
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 720, height: 800 }, deviceScaleFactor: 1 });
    fs.mkdirSync(DOCS_IMG, { recursive: true });
    for (const s of shots) {
      await page.setViewportSize({ width: s.width + 20, height: s.height + 40 });
      await page.setContent(s.html, { waitUntil: 'load' });
      await page.locator('#shot').screenshot({ path: path.join(DOCS_IMG, s.file) });
      console.log(`  → docs/validation/${s.file}`);
    }
  } finally {
    await browser.close();
  }
}

// Minimal PNG encoder (RGBA8) for the map layers.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(rgba: Buffer, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const only = args.preset ? String(args.preset).split(',') : Object.keys(PLANS);
  const scoreOnly = !!args['score-only'];
  let device: GPUDevice | null = null;
  let gpuName = 'saved fields (--score-only)';
  let instance: GPU | null = null;
  if (!scoreOnly) {
    Object.assign(globalThis, globals);
    instance = create([]);
    const d = await createDelugeDevice(instance);
    device = d.device;
    gpuName = d.description ?? 'Dawn';
    device.onuncapturederror = (ev) => console.error('[webgpu]', (ev as GPUUncapturedErrorEvent).error?.message);
  }
  console.log(`[validate] ${gpuName}`);
  const summaryFile = path.join(PUB, 'summary.json');
  const resultsFile = path.join(OUT, 'results.json');
  const summary: ValidationSummary = fs.existsSync(summaryFile)
    ? readJson<ValidationSummary>(summaryFile)
    : { version: 1, generated: '', solver: '', presets: {} };
  const allResults: Record<string, PresetResult> = fs.existsSync(resultsFile) ? readJson(resultsFile) : {};
  const shots: Shot[] = [];
  for (const id of only) {
    const plan = PLANS[id];
    if (!plan) throw new Error(`no plan for ${id}`);
    const obsFile = path.join(PUB, id, 'observed.json');
    if (!fs.existsSync(obsFile)) throw new Error(`${obsFile} missing — run scripts/validation/fetch.ts first`);
    const obs = readJson<ObservedFile>(obsFile);
    const p = loadPresetData(id);
    console.log(`\n[validate] ${id} — ${obs.event}`);
    const outputs = new Map<string, RunOutput>();
    for (const run of plan.runs(obs)) {
      if (scoreOnly) outputs.set(run.id, loadField(p, run));
      else {
        console.log(`  run ${run.id}: ${run.description}`);
        const o = await runScenario(device as GPUDevice, p, run, { log: console.log });
        console.log(`    ${(o.simTime / 60).toFixed(1)} sim-min in ${o.wallSeconds.toFixed(0)} s, ${o.substeps} substeps, mass error ${o.stats.massError.toExponential(1)}${o.stageFt !== null ? `, stage ${o.stageFt.toFixed(2)} ft` : ''}`);
        saveField(id, run.id, o);
        outputs.set(run.id, o);
      }
    }
    const { result, femaCells, damage } = scorePreset(p, obs, plan, outputs);
    allResults[id] = result;
    summary.presets[id] = summarise(result);
    const h = summary.presets[id].headline;
    console.log(`  headline: ${h ? `${h.label}: ${h.value}` : obs.none ?? 'none'}`);
    if (!args['no-images']) {
      if (femaCells && result.fema) shots.push(extentShot(p, femaCells, result));
      if (damage && result.damage && plan.damageRun) shots.push(damageShot(p, obs, outputs.get(plan.damageRun)!.maxDepth, damage, result));
      if (result.ems && plan.emsRun) shots.push(emsShot(p, obs, outputs.get(plan.emsRun)!.maxDepth, result));
      if (result.hwm) shots.push(scatterShot(`${id}-hwm`, `${p.meta.name}: Deluge vs USGS high-water marks`, `${obs.hwm?.event} · run: ${plan.runs(obs).find((r) => r.id === result.hwm?.run)?.description}`, result.hwm));
      if (result.bfe && result.bfe.rows.length) shots.push(scatterShot(`${id}-bfe-profile`, `${p.meta.name}: Deluge vs FEMA's 1 % profile`, `water surface at each Base Flood Elevation line crossing a forced river · run: ${plan.runs(obs).find((r) => r.id === result.bfe?.run)?.description}`, result.bfe, 'FEMA Base Flood Elevation (m NAVD88)'));
      if (result.gauges) shots.push(scatterShot(`${id}-gauges`, `${p.meta.name}: Deluge vs USGS gauge peaks`, `Helene 2024 · run: ${plan.runs(obs).find((r) => r.id === result.gauges?.run)?.description}`, result.gauges));
    }
  }
  summary.generated = new Date().toISOString();
  if (!scoreOnly) summary.solver = `src/sim on ${gpuName}`;
  // Keep presets in a stable order.
  summary.presets = Object.fromEntries(Object.keys(PLANS).filter((k) => summary.presets[k]).map((k) => [k, summary.presets[k]]));
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 1) + '\n');
  fs.writeFileSync(resultsFile, JSON.stringify(allResults, null, 1));
  const ordered = Object.keys(PLANS).filter((k) => allResults[k]).map((k) => allResults[k]);
  fs.writeFileSync(path.join(OUT, 'results.md'), markdown(ordered, gpuName));
  console.log(`\n  → public/validation/summary.json, artifacts/validation/results.{json,md}`);
  await renderShots(shots);
  if (device) await device.queue.onSubmittedWorkDone();
  void instance;
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
