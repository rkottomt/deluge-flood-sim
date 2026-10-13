/**
 * The batch CLI (src/cli) gives the browser's numbers: its commands, driven end to end with a stand-in for the GPU
 * scene (hazard fields computed on the CPU from the forcing it was given), against the same fields put through the
 * loss module directly the way the app's panels do it — the Impact & loss export (src/ui/impact.ts exportCsv) and the
 * Site check sweep (src/ui/siteCheck.ts runContext / derived). No GPU: the GPU path is tests/cli/smoke.test.ts.
 *
 * Also: argument parsing, scenario flags → forcing, the ladders, the GeoTIFF georeferencing.
 * Run: node --import tsx --test tests/cli/parity.test.ts
 */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import type { AppState, HazardFields, SimSnapshot, TerrainData } from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { cloneScenarioLists, stageOffsetForFeet } from '../../src/app/stage';
import { climateForcing } from '../../src/climate/apply';
import { CLIMATE_TODAY } from '../../src/climate/scenarios';
import { boundsToMercator, makeGeoToGrid } from '../../src/data/geo';
import { computeInitialWater } from '../../src/data/initialWater';
import {
  analyze,
  assessSiteRun,
  buildAccessIndex,
  FloodTimeline,
  ladderFor,
  mitigationOptions,
  newSite,
  parsePortfolio,
  pickDesign,
  recommendFfe,
  regionForBounds,
  resultsCsv,
  RESULT_COLUMNS,
  siteVerdict,
  summarizeSweep,
  type ResultRowInput,
  type SweepRow,
} from '../../src/loss';
import { createRouter } from '../../src/routing';
import { formatMoney } from '../../src/ui/format';
import { COMMANDS, parseOptions } from '../../src/cli/args';
import { HANDLERS, type CliEnv, type SceneLike } from '../../src/cli/commands';
import type { ForcingPatch } from '../../src/cli/headless';
import { createLog } from '../../src/cli/io';
import { availablePresetIds, loadPresetFromDisk, readPresetMeta } from '../../src/cli/presetFiles';
import { geotiffBytes, hazardLayers } from '../../src/cli/rasters';
import { buildLadder, parseClimate, resolveForcing, UsageError } from '../../src/cli/scenario';

const FT = 0.3048;
const DEMO_CSV = path.resolve(import.meta.dirname, '../../public/demo/houston-portfolio.csv');

// ─── A stand-in scene: CPU hazard fields from the forcing in force ───────────────────────────────────────────────

/** Deterministic, non-trivial fields: a water plane at the stage (stage presets) or rain-scaled ponding in the lows. */
function fakeFields(terrain: TerrainData, state: AppState, initial: Float32Array, simTime: number): HazardFields {
  const n = terrain.nx * terrain.ny;
  const g = terrain.elevation;
  const st = state.scenario?.stage ?? null;
  const maxDepth = new Float32Array(n);
  const maxSpeed = new Float32Array(n);
  const maxDV = new Float32Array(n);
  const firstWet = new Float32Array(n).fill(-1);
  const wetSeconds = new Float32Array(n);
  const inflow = state.sources.reduce((s, w) => s + (w.type === 'inflow' ? w.discharge : 0), 0);
  for (let c = 0; c < n; c++) {
    let d: number;
    if (st) d = Math.max(0, st.normalLevel + state.stageOffset - g[c]);
    else d = Math.max(0, 1.2 * Math.sin((c % terrain.nx) / 37) * Math.cos(Math.floor(c / terrain.nx) / 29) + 0.3 ) * (state.sim.rainRate / 100 + inflow / 2000);
    if (initial[c] > 0.01) d = Math.max(d, initial[c]);
    maxDepth[c] = d;
    maxSpeed[c] = d > 0 ? 0.3 + 0.1 * (c % 7) : 0;
    maxDV[c] = d * maxSpeed[c];
    if (initial[c] > 0.01) firstWet[c] = 0;
    else if (d >= 0.15) firstWet[c] = Math.min(simTime, 60 + 40 * (1 + (c % 13)));
    wetSeconds[c] = firstWet[c] >= 0 ? simTime - firstWet[c] : 0;
  }
  return { nx: terrain.nx, ny: terrain.ny, simTime, maxDepth, maxSpeed, maxDV, firstWet, wetSeconds };
}

class FakeScene implements SceneLike {
  readonly chain = null;
  frames = 0;
  substeps = 0;
  state: AppState;
  readonly initialWater: Float32Array;
  /** The stage offset of every case run (to check what a sweep asked for). */
  readonly ran: Array<{ stageOffset: number; rainRate: number; simTime: number }> = [];
  private clock = 0;

  constructor(
    readonly terrain: TerrainData,
    readonly presetId: string,
  ) {
    const lists = cloneScenarioLists(terrain.scenario);
    const s = createInitialState();
    this.state = { ...s, loading: null, presetId, scenario: terrain.scenario, attribution: terrain.attribution, sources: lists.sources, storms: lists.storms, shelters: lists.shelters, sim: { ...s.sim, rainRate: terrain.scenario?.rainRate ?? 0 } };
    this.initialWater = computeInitialWater(terrain, terrain.scenario);
  }
  get climateForcing() {
    return climateForcing(CLIMATE_TODAY, this.presetId, this.terrain.scenario);
  }
  setForcing(f: ForcingPatch): void {
    const sim = { ...this.state.sim, ...(f.rainRate !== undefined ? { rainRate: f.rainRate } : {}), ...(f.manningN !== undefined ? { manningN: f.manningN } : {}) };
    this.state = { ...this.state, sim, ...(f.sources ? { sources: f.sources } : {}), ...(f.storms ? { storms: f.storms } : {}), ...(f.stageOffset !== undefined ? { stageOffset: f.stageOffset } : {}) };
  }
  applyPatch(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
  }
  resetWater(): void {
    this.clock = 0;
  }
  async runFor(seconds: number): Promise<void> {
    this.clock += seconds;
    this.frames++;
  }
  async read(): Promise<{ fields: HazardFields; snapshot: SimSnapshot | null }> {
    const fields = fakeFields(this.terrain, this.state, this.initialWater, this.clock);
    this.ran.push({ stageOffset: this.state.stageOffset, rainRate: this.state.sim.rainRate, simTime: this.clock });
    const snapshot = { simTime: this.clock, nx: this.terrain.nx, ny: this.terrain.ny, depth: fields.maxDepth.slice(), stats: { simTime: this.clock, maxDepth: 0, maxSpeed: 0, volume: 0, wetArea: 0, floodedArea: 0, volumeIn: 0, volumeOut: 0, massError: 0, courant: 0 } };
    return { fields, snapshot };
  }
  ground(): Float32Array {
    return this.terrain.elevation;
  }
  setBedPerturbation(): void {}
  destroy(): void {}
}

const terrains = new Map<string, TerrainData>();
const scenes: FakeScene[] = [];

function env(files: Map<string, string | ArrayBuffer | Uint8Array>, out: string[]): CliEnv {
  return {
    log: createLog({ quiet: true }),
    version: 'test',
    presetIds: availablePresetIds,
    presetMeta: readPresetMeta,
    async loadTerrain(id) {
      const t = terrains.get(id) ?? (await loadPresetFromDisk(id));
      terrains.set(id, t);
      return t;
    },
    async openScene(terrain, presetId) {
      const s = new FakeScene(terrain, presetId);
      scenes.push(s);
      return s;
    },
    gpuName: async () => 'fake',
    readText: (f) => (files.has(f) ? String(files.get(f)) : fs.readFileSync(f, 'utf8')),
    write: (f, d) => void files.set(f, d),
    stdout: (t) => void out.push(t),
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
}

async function cli(argv: string[], files = new Map<string, string | ArrayBuffer | Uint8Array>()) {
  const [cmd, ...rest] = argv;
  const out: string[] = [];
  const code = await HANDLERS[cmd as keyof typeof HANDLERS](env(files, out), parseOptions(COMMANDS[cmd], rest));
  return { code, files, out: out.join(''), scene: scenes[scenes.length - 1] };
}

before(async () => {
  for (const id of ['houston', 'pittsburgh']) terrains.set(id, await loadPresetFromDisk(id));
});

// ─── Portfolio ──────────────────────────────────────────────────────────────────────────────────────────────────

test('portfolio: the CLI CSV is the in-app export, cell for cell, for every assessed asset', async () => {
  const { code, files, scene } = await cli(['portfolio', '--preset', 'houston', '--csv', DEMO_CSV, '--minutes', '30', '--out', 'r.csv', '--summary', 's.json']);
  assert.equal(code, 0);
  const csv = String(files.get('r.csv'));
  // The same fields through the loss module, as src/ui/impact.ts recompute + exportCsv do it (portfolio rows).
  const terrain = terrains.get('houston')!;
  const fields = fakeFields(terrain, scene.state, scene.initialWater, 1800);
  const assets = parsePortfolio(fs.readFileSync(DEMO_CSV, 'utf8')).assets;
  const a = analyze({ fields, terrain, velocityKnown: true, debrisFlow: false, alertTime: 0, portfolio: assets });
  const rows: ResultRowInput[] = (a.portfolio?.results ?? []).map((r) => ({ id: r.m.asset.id, name: r.m.asset.name, source: 'portfolio', occ: r.occ, match: r.m.match, matchDistanceM: r.m.distanceM, r, valueStructure: r.valueStructure, valueContents: r.valueContents, valueSource: r.valueSource, currency: r.currency }));
  const expected = resultsCsv(rows).split('\r\n');
  const got = csv.split('\r\n');
  assert.equal(got[0], RESULT_COLUMNS.join(','), 'the in-app export columns');
  assert.ok(rows.length >= 10, `${rows.length} assessed assets`);
  assert.ok(rows.some((r) => r.r.loss > 0), 'some loss, so the comparison is not of zeros');
  assert.deepEqual(got.slice(0, rows.length + 1), expected.slice(0, rows.length + 1));
  // The forcing it ran: Harvey's rain, 30 simulated minutes.
  assert.deepEqual(scene.ran, [{ stageOffset: 0, rainRate: 173, simTime: 1800 }]);
  const summary = JSON.parse(String(files.get('s.json')));
  assert.equal(summary.portfolio.summary.loss, a.portfolio!.summary.loss);
  assert.equal(summary.portfolio.summary.reached, a.portfolio!.summary.reached);
});

test('portfolio: ensemble members are the Uncertainty panel’s (same seed → same members), tallied per asset', async () => {
  const files = new Map<string, string | ArrayBuffer | Uint8Array>();
  const run = async (seed: number, tag = '') => (await cli(['portfolio', '--preset', 'houston', '--csv', DEMO_CSV, '--minutes', '2', '--members', '4', '--seed', String(seed), '--no-dem-noise', '--out', `e${seed}${tag}.csv`, '--summary', `e${seed}.json`], files)).scene;
  const s1 = await run(5);
  await run(5, 'again');
  const s3 = await run(6);
  assert.equal(String(files.get('e5.csv')).split('\r\n')[0], [...RESULT_COLUMNS, 'ens_members', 'ens_assessed', 'ens_reached_members', 'ens_over_50cm_members', 'ens_depth_p10_m', 'ens_depth_p50_m', 'ens_depth_p90_m', 'ens_loss_p10', 'ens_loss_p50', 'ens_loss_p90', 'ens_summary'].join(','));
  const j5 = JSON.parse(String(files.get('e5.json')));
  // Rain ± 25 % by Latin hypercube: one member per quarter of the band.
  const rains = s1.ran.slice(1).map((r) => r.rainRate / 173).sort();
  assert.equal(rains.length, 4);
  rains.forEach((k, i) => assert.ok(k >= 0.75 + 0.125 * i - 1e-9 && k <= 0.75 + 0.125 * (i + 1) + 1e-9, `member rain factor ${k} in its stratum`));
  assert.deepEqual(j5.ensemble.memberParams.map((m: { rainFactor: number }) => m.rainFactor), s1.ran.slice(1).map((r) => r.rainRate / 173));
  assert.equal(String(files.get('e5again.csv')), String(files.get('e5.csv')), 'the same seed, the same CSV');
  assert.match(String(files.get('e5.csv')), /members/);
  assert.notDeepEqual(s3.ran.map((r) => r.rainRate), s1.ran.map((r) => r.rainRate), 'another seed, other members');
});

test('portfolio: a broken CSV is a usage error, an asset off the map gets an "outside" row', async () => {
  const files = new Map<string, string | ArrayBuffer | Uint8Array>([['bad.csv', 'name,lat\nx,1\n'], ['off.csv', 'asset_id,lat,lon\nFAR,10,10\nNEAR,29.77253,-95.38365\n']]);
  await assert.rejects(cli(['portfolio', '--preset', 'houston', '--csv', 'bad.csv', '--out', 'x.csv'], files), (e: unknown) => e instanceof UsageError && /asset_id/.test(e.message));
  const r = await cli(['portfolio', '--preset', 'houston', '--csv', 'off.csv', '--minutes', '2', '--out', 'o.csv'], files);
  const lines = String(files.get('o.csv')).trim().split('\r\n');
  assert.equal(r.code, 0);
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^NEAR,/);
  assert.match(lines[2], /^FAR,,portfolio,,outside,/);
});

// ─── Site check ─────────────────────────────────────────────────────────────────────────────────────────────────

test('site --sweep: levels, EAL, FFE, mitigation and verdict equal the loss module run like the Site check panel', async () => {
  const { code, files, scene } = await cli(['site', '--preset', 'pittsburgh', '--at', '40.4425,-80.0085', '--use', 'office', '--floors', '3', '--sweep', '--minutes', '30', '--out', 'site.json']);
  assert.equal(code, 0);
  const report = JSON.parse(String(files.get('site.json')));
  const terrain = terrains.get('pittsburgh')!;
  const st = terrain.scenario!.stage!;
  const ladder = ladderFor('pittsburgh')!;
  // The app's ticked levels, each at its gauge reading, 30 simulated minutes.
  assert.deepEqual(scene.ran.map((r) => Math.round(r.stageOffset * 1e6)), ladder.map((l) => Math.round((l.ft * FT + st.gaugeDatum - st.normalLevel) * 1e6)));
  assert.ok(scene.ran.every((r) => r.simTime === 1800));
  // Directly: siteCheck.ts runContext + assessAll per level, then derived().
  const spec = { ...newSite('s1', -80.0085, 40.4425), occupancy: 'office' as const, floors: 3 };
  const region = regionForBounds(terrain.bounds);
  const router = createRouter();
  router.setNetwork(terrain.roads!, terrain.cellSize, { nx: terrain.nx, ny: terrain.ny });
  const initial = computeInitialWater(terrain, terrain.scenario);
  const rows: SweepRow[] = ladder.map((l) => {
    const stageOffset = stageOffsetForFeet(st, l.ft);
    const fields = fakeFields(terrain, { ...scene.state, stageOffset }, initial, 1800);
    const run = assessSiteRun(spec, fields, {
      region,
      grid: { nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize },
      toGrid: makeGeoToGrid(terrain),
      ground: terrain.elevation,
      heightProfile: 'us',
      debrisFlow: false,
      alertTime: 0,
      access: buildAccessIndex(terrain.roads, fields, terrain.cellSize),
      router,
      shelters: terrain.scenario!.shelters,
      hasRoads: true,
      timeline: new FloodTimeline(fields),
      endDepth: fields.maxDepth.slice(),
    });
    return { level: { id: l.id, label: l.label, ft: l.ft, scale: NaN, returnPeriod: l.returnPeriod, rpFrom: l.returnPeriod != null ? 'source' : null, durationS: 1800 }, run };
  });
  const sum = summarizeSweep(rows);
  const design = pickDesign(sum.rows, null)!;
  const rec = recommendFfe(design.row, design.basis, 'office', undefined, design.onePercent)!;
  const options = mitigationOptions(sum, { occ: 'office', rec, country: region.costCountry, perimeterM: sum.rows[0].run.geometry.perimeterM });
  const sw = report.sweep;
  assert.deepEqual(
    sw.levels.map((l: { run: { result: { depthM: number; loss: number } } }) => [l.run.result.depthM, l.run.result.loss]),
    sum.rows.map((r) => [Math.round(r.run.result!.depth * 1000) / 1000, Math.round(r.run.result!.loss)]),
  );
  assert.ok(sum.rows.some((r) => r.run.result!.loss > 0));
  assert.equal(sw.eal.low, Math.round(sum.eal!.low));
  assert.equal(sw.eal.high, Math.round(sum.eal!.high));
  assert.equal(sw.ffe.ffeAboveGradeM, Math.round(rec.ffeAboveGrade * 1000) / 1000);
  assert.equal(sw.ffe.designEvent, rec.designLabel);
  assert.deepEqual(sw.mitigation.map((m: { kind: string; avoidedEal: number }) => [m.kind, m.avoidedEal]), options.map((o) => [o.kind, Number.isFinite(o.deltaEal) ? Math.round(o.deltaEal) : null]));
  assert.deepEqual(sw.verdict, siteVerdict('The site', sum, (v) => formatMoney(v).replace(/ /g, ' ')));
  assert.equal(sw.firstReached, sum.firstReached?.level.id ?? null);
});

test('site: a pin off the map, a bad occupancy and --sweep with a stage are usage errors', async () => {
  await assert.rejects(cli(['site', '--preset', 'pittsburgh', '--at', '29.77,-95.38', '--out', 'x.json']), (e: unknown) => e instanceof UsageError && /outside the pittsburgh map/.test(e.message));
  await assert.rejects(cli(['site', '--preset', 'pittsburgh', '--at', '40.44,-80.0', '--use', 'castle']), (e: unknown) => e instanceof UsageError && /--use/.test(e.message));
  await assert.rejects(cli(['site', '--preset', 'pittsburgh', '--at', '40.44,-80.0', '--sweep', '--stage-ft', '40']), UsageError);
  await assert.rejects(cli(['site', '--preset', 'pittsburgh', '--at', '40.44,-80.0', '--sweep', '--levels', 'rp100,nope']), (e: unknown) => e instanceof UsageError && /nope/.test(e.message));
});

// ─── Pure pieces ────────────────────────────────────────────────────────────────────────────────────────────────

test('arguments: values, switches, numbers; unknown options and missing values fail', () => {
  const o = parseOptions(COMMANDS.run, ['--preset', 'houston', '--minutes=60', '--rain', '173', '--quiet', '--climate', '2050:ssp585']);
  assert.deepEqual(o, { preset: 'houston', minutes: 60, rain: 173, quiet: true, climate: '2050:ssp585' });
  assert.throws(() => parseOptions(COMMANDS.run, ['--preset']), /needs a value/);
  assert.throws(() => parseOptions(COMMANDS.run, ['--minuts', '5']), /unknown option --minuts/);
  assert.throws(() => parseOptions(COMMANDS.run, ['--minutes', 'ten']), /must be a number/);
  assert.throws(() => parseOptions(COMMANDS.run, ['houston']), /unexpected argument/);
  assert.equal(parseOptions(COMMANDS.site, ['--stage-ft', '-1']).stageFt, undefined);
  assert.equal(parseOptions(COMMANDS.site, ['--stage-ft', '-1'])['stage-ft'], -1);
});

test('scenario flags → forcing: gauge feet, ladder levels, multipliers, rain; out-of-range values fail', () => {
  const pit = readPresetMeta('pittsburgh')!.scenario;
  const crest = resolveForcing('pittsburgh', pit, { stageFt: 46 });
  assert.ok(Math.abs(crest.stageOffset - stageOffsetForFeet(pit.stage!, 46)) < 1e-12);
  assert.ok(Math.abs(resolveForcing('pittsburgh', pit, { level: 'rp100' }).stageOffset - stageOffsetForFeet(pit.stage!, 35.38)) < 1e-12);
  assert.throws(() => resolveForcing('pittsburgh', pit, { stageFt: 80 }), /outside this gauge's range/);
  assert.throws(() => resolveForcing('pittsburgh', pit, { level: 'x2' }), /no level "x2"/);
  const hou = readPresetMeta('houston')!.scenario;
  assert.throws(() => resolveForcing('houston', hou, { stageFt: 30 }), /no river-stage control/);
  const half = resolveForcing('houston', hou, { level: 'x0.5' });
  assert.equal(half.rainRate, 173 * 0.5);
  const q0 = hou.sources.find((s) => s.type === 'inflow')!;
  const q1 = half.sources.find((s) => s.id === q0.id)!;
  assert.ok(q0.type === 'inflow' && q1.type === 'inflow' && q1.discharge === q0.discharge * 0.5);
  assert.equal(resolveForcing('houston', hou, { scale: 2, rain: 100 }).rainRate, 100, '--rain is absolute, after a multiplier');
  assert.deepEqual(parseClimate('2050:ssp585'), { horizon: '2050', pathway: 'ssp585', scaling: 'cc' });
  assert.deepEqual(parseClimate('2080:SSP2-4.5:super10'), { horizon: '2080', pathway: 'ssp245', scaling: 'super10' });
  assert.throws(() => parseClimate('2040:ssp585'), /horizon/);
});

test('ladders: the Site check panel’s — researched stage ladders, else × multipliers with × 0.5 and × 1 ticked', () => {
  const pit = readPresetMeta('pittsburgh')!.scenario;
  const l = buildLadder('pittsburgh', pit.stage);
  assert.deepEqual(l.map((r) => r.id), ladderFor('pittsburgh')!.map((r) => r.id));
  assert.ok(l.every((r) => r.on && !r.outOfRange));
  const h = buildLadder('houston', null);
  assert.deepEqual(h.filter((r) => r.on).map((r) => r.id), ['x0.5', 'x1']);
});

test('GeoTIFF: EPSG:3857, the grid’s outer corners, row 0 north, nodata, values intact', async () => {
  const terrain = terrains.get('pittsburgh')!;
  const nx = terrain.nx;
  const ny = terrain.ny;
  const fields = fakeFields(terrain, { ...createInitialState(), scenario: terrain.scenario, stageOffset: 5, sources: [] }, computeInitialWater(terrain, terrain.scenario), 600);
  const layers = hazardLayers(fields);
  const arrival = layers.find((l) => l.name === 'arrival')!;
  const tif = await fromArrayBuffer(geotiffBytes(arrival.data, nx, ny, terrain.bounds, arrival.nodata));
  const img = await tif.getImage();
  const m = boundsToMercator(terrain.bounds);
  const bb = img.getBoundingBox();
  for (const [a, b] of [[bb[0], m.xmin], [bb[1], m.ymin], [bb[2], m.xmax], [bb[3], m.ymax]]) assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  assert.equal(img.getGeoKeys()?.ProjectedCSTypeGeoKey, 3857);
  assert.equal(img.getGDALNoData(), -9999);
  const r = (await img.readRasters())[0] as Float32Array;
  const k = 12345;
  assert.equal(r[k], arrival.data[k]);
  assert.equal(r[0], arrival.data[0], 'row 0 is the north row in both');
  const hz = layers.find((l) => l.name === 'hazard')!.data;
  assert.ok(hz.some((v) => v >= 1 && v <= 6));
});
