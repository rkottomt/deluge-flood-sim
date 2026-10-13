/**
 * `deluge serve` (src/cli/server.ts, src/cli/api.ts) without a GPU: the server on an ephemeral port with a stand-in
 * scene, driven over HTTP — jobs end to end, the API's files equal the CLI handler's for the same options, the checks
 * before queueing (fixed sentences, never an echo), idempotency, cancel / delete, retention, a restart, and the security
 * rules (auth, Host, body caps, content type, path traversal). The GPU path is tests/cli/server-gpu.test.ts.
 * Run: node --import tsx --test tests/cli/server.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AppState, HazardFields, SimSnapshot, TerrainData } from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { cloneScenarioLists } from '../../src/app/stage';
import { climateForcing } from '../../src/climate/apply';
import { CLIMATE_TODAY } from '../../src/climate/scenarios';
import { computeInitialWater } from '../../src/data/initialWater';
import { COMMANDS, parseOptions } from '../../src/cli/args';
import { portfolioRequest, runRequest, siteRequest } from '../../src/cli/api';
import { HANDLERS, type CliEnv, type SceneLike } from '../../src/cli/commands';
import type { ForcingPatch, RunProgress } from '../../src/cli/headless';
import { createLog } from '../../src/cli/io';
import { availablePresetIds, loadAtlas14FromDisk, loadNidIndexFromDisk, loadPresetFromDisk, readPresetMeta } from '../../src/cli/presetFiles';
import { startServer, type ApiServer, type Engine } from '../../src/cli/server';

const DEMO_CSV = path.resolve(import.meta.dirname, '../../public/demo/houston-portfolio.csv');
const MARKER = 'EVIL<script>alert(1)</script>MARKER';

// ─── A stand-in scene (deterministic CPU fields), slowed down on request so a job can be caught running ─────────────

let frameDelayMs = 0;

class FakeScene implements SceneLike {
  readonly chain = null;
  frames = 0;
  substeps = 0;
  state: AppState;
  readonly initialWater: Float32Array;
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
  async runFor(seconds: number, onProgress?: (p: RunProgress) => void): Promise<void> {
    const steps = frameDelayMs ? 50 : 1;
    for (let i = 1; i <= steps; i++) {
      if (frameDelayMs) await new Promise((r) => setTimeout(r, frameDelayMs));
      this.frames++;
      onProgress?.({ simTime: this.clock + (seconds * i) / steps, target: this.clock + seconds, frames: this.frames, substeps: 0 });
    }
    this.clock += seconds;
  }
  async read(): Promise<{ fields: HazardFields; snapshot: SimSnapshot | null }> {
    const t = this.terrain;
    const n = t.nx * t.ny;
    const st = this.state.scenario?.stage ?? null;
    const maxDepth = new Float32Array(n);
    const maxSpeed = new Float32Array(n);
    const maxDV = new Float32Array(n);
    const firstWet = new Float32Array(n).fill(-1);
    const wetSeconds = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      const d = st ? Math.max(0, st.normalLevel + this.state.stageOffset - t.elevation[c]) : Math.max(0, Math.sin((c % t.nx) / 37) * Math.cos(Math.floor(c / t.nx) / 29) + 0.3) * (this.state.sim.rainRate / 100);
      maxDepth[c] = d;
      maxSpeed[c] = d > 0 ? 0.5 : 0;
      maxDV[c] = d * maxSpeed[c];
      if (d >= 0.15 && this.initialWater[c] <= 0.01) firstWet[c] = Math.min(this.clock, 60 + (c % 13) * 30);
      wetSeconds[c] = firstWet[c] >= 0 ? this.clock - firstWet[c] : 0;
    }
    return { fields: { nx: t.nx, ny: t.ny, simTime: this.clock, maxDepth, maxSpeed, maxDV, firstWet, wetSeconds }, snapshot: null };
  }
  ground(): Float32Array {
    return this.terrain.elevation;
  }
  setBedPerturbation(): void {}
  destroy(): void {}
}

const terrains = new Map<string, TerrainData>();
let clock = new Date('2026-10-01T00:00:00Z').getTime();

const engine: Engine = {
  version: 'test',
  presetIds: availablePresetIds,
  presetMeta: readPresetMeta,
  loadAtlas14: loadAtlas14FromDisk,
  async loadTerrain(id) {
    const t = terrains.get(id) ?? (await loadPresetFromDisk(id));
    terrains.set(id, t);
    return t;
  },
  openScene: async (terrain, presetId) => new FakeScene(terrain, presetId),
  loadNidIndex: loadNidIndexFromDisk,
  gpuName: async () => 'fake GPU',
  gpuErrorCount: () => 0,
  settle: async () => {},
  now: () => new Date(clock),
};

/** The CLI handler on the same stand-in, writing into a Map (what `deluge <cmd> …` would write). */
async function cliFiles(argv: string[], csv: string | null = null): Promise<Map<string, string | Uint8Array>> {
  const files = new Map<string, string | Uint8Array>();
  const [cmd, ...rest] = argv;
  const env: CliEnv = {
    ...engine,
    log: createLog({ quiet: true }),
    readText: () => csv ?? '',
    write: (f, d) => void files.set(path.basename(f), typeof d === 'string' ? d : new Uint8Array(d instanceof ArrayBuffer ? d : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength))),
    stdout: () => {},
  };
  assert.equal(await HANDLERS[cmd as 'run'](env, parseOptions(COMMANDS[cmd], rest)), 0);
  return files;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

function request(api: ApiServer, method: string, url: string, opts: { body?: string | Buffer; headers?: Record<string, string>; token?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...opts.headers };
    const req = http.request({ host: '127.0.0.1', port: api.port, method, path: url, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const text = body.toString('utf8');
        let j: unknown = null;
        try {
          j = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, text, json: j });
      });
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const post = (api: ApiServer, url: string, body: unknown, headers: Record<string, string> = {}, token?: string) => request(api, 'POST', url, { body: typeof body === 'string' ? body : JSON.stringify(body), headers, token });

async function waitFor(api: ApiServer, id: string, until: (status: string) => boolean = (s) => !['queued', 'running'].includes(s), token?: string): Promise<Reply> {
  for (let i = 0; i < 2000; i++) {
    const r = await request(api, 'GET', `/v1/jobs/${id}`, { token });
    if (r.status !== 200 || until(r.json.status)) return r;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('job never finished');
}

/** A summary or report without its wall-clock timings (the only fields two runs of the same scenario differ in). */
function withoutTiming(text: string): unknown {
  const j = JSON.parse(text);
  delete j.timing;
  if (j.run) for (const k of ['wallSeconds', 'loadSeconds', 'simSpeedX']) delete j.run[k];
  return j;
}

let tmp = '';
let api: ApiServer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deluge-serve-'));
  for (const id of ['houston', 'pittsburgh']) terrains.set(id, await loadPresetFromDisk(id));
  api = await startServer({ engine, dataDir: path.join(tmp, 'main'), port: 0 });
});
after(async () => {
  await api?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ─── Requests map to exactly the CLI's options ──────────────────────────────────────────────────────────────────────

test('requests map to the CLI command line: its parser gives exactly the options the job runs with', () => {
  const specs = [
    runRequest({ preset: 'pittsburgh', scenario: { minutes: 12, stageFt: 40, manningN: 0.04, climate: { horizon: '2050', pathway: 'ssp245' } }, rasters: false }),
    runRequest({ preset: 'houston', scenario: { level: 'a14-100', rainMmHr: 80, scale: 1.5 } }),
    portfolioRequest({ preset: 'houston', assetsCsv: 'asset_id,lat,lon\nA,29.77,-95.38\n', ensemble: { members: 4, seed: 9, demNoise: false } }),
    siteRequest({ preset: 'pittsburgh', site: { name: 'North Shore lot', lat: 40.4425, lon: -80.0085, use: 'office', floors: 3, ring: [[40.44, -80.01], [40.45, -80.01], [40.45, -80.0]], valueUsd: 2e6, firstFloorHeightM: 0.5 }, sweep: { levels: ['ivan2004', 'rp100'], returnPeriods: { ivan2004: 30 }, design: 'rp100', freeboardFt: 2 } }),
    siteRequest({ preset: 'pittsburgh', site: { lat: 40.4425, lon: -80.0085 }, egress: { occupants: 400, alertMin: -180, departure: 'good-likely', personsPerCar: 1.5, exitLanes: 2 } }),
  ];
  for (const s of specs) {
    const parsed = parseOptions(COMMANDS[s.command], s.argv.slice(1));
    assert.deepEqual(parsed, s.options, s.argv.join(' '));
  }
  assert.equal(specs[0].options.climate, '2050:ssp245:cc');
  assert.equal(specs[3].options.at, '40.4425,-80.0085');
  assert.equal(specs[4].options['alert-min'], -180);
  assert.equal(specs[4].options.departure, 'good-likely');
});

// ─── Jobs end to end ────────────────────────────────────────────────────────────────────────────────────────────────

test('POST /v1/runs: 202 + job, poll, download — the files are the CLI handler’s, byte for byte', async () => {
  const r = await post(api, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 } });
  assert.equal(r.status, 202, r.text);
  assert.match(r.json.id, /^job_[0-9a-f]{24}$/);
  assert.equal(r.headers.location, `/v1/jobs/${r.json.id}`);
  assert.deepEqual(r.json.command, ['deluge', 'run', '--preset', 'houston', '--quiet', '--minutes', '2', '--out', '.']);
  const done = await waitFor(api, r.json.id);
  assert.equal(done.json.status, 'succeeded', done.text);
  assert.deepEqual(done.json.engine, { version: 'test', commit: null, gpu: 'fake GPU' });
  assert.deepEqual(done.json.files.map((f: { name: string }) => f.name).sort(), ['arrival_min.tif', 'hazard_aidr.tif', 'max_depth_m.tif', 'max_speed_ms.tif', 'summary.json']);
  const cli = await cliFiles(['run', '--preset', 'houston', '--minutes', '2', '--out', '.']);
  for (const f of done.json.files) {
    const got = await request(api, 'GET', f.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers['content-type'], f.contentType);
    assert.match(String(got.headers['content-disposition']), /^attachment; filename="[a-z_]+\.(json|tif)"$/);
    const want = cli.get(f.name)!;
    if (typeof want === 'string') assert.deepEqual(withoutTiming(got.text), withoutTiming(want), f.name);
    else assert.deepEqual(new Uint8Array(got.body), want, f.name);
  }
  const summary = JSON.parse((await request(api, 'GET', `/v1/jobs/${r.json.id}/results/summary.json`)).text);
  assert.equal(summary.version, 'test');
  assert.equal(summary.run.gpu, 'fake GPU');
  assert.equal(summary.scenario.simulatedMinutes, 2);
  // The sketch's /files/ path is an alias.
  assert.equal((await request(api, 'GET', `/v1/jobs/${r.json.id}/files/summary.json`)).status, 200);
});

test('POST /v1/portfolio-assessments and /v1/site-checks: the CSV and the report are the CLI’s', async () => {
  const csv = fs.readFileSync(DEMO_CSV, 'utf8');
  const p = await post(api, '/v1/portfolio-assessments', { preset: 'houston', scenario: { minutes: 3 }, assetsCsv: csv, ensemble: { members: 3, seed: 4 } });
  assert.equal(p.status, 202, p.text);
  assert.equal(p.json.request.assets.usable, 19);
  assert.equal(p.json.request.assetsCsv, undefined, 'the CSV is not echoed back in the job');
  const s = await post(api, '/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.4425, lon: -80.0085, use: 'office', floors: 3 }, sweep: { levels: ['ivan2004', 'rp100'] }, scenario: { minutes: 4 } });
  assert.equal(s.status, 202, s.text);
  const pd = await waitFor(api, p.json.id);
  const sd = await waitFor(api, s.json.id);
  assert.equal(pd.json.status, 'succeeded', pd.text);
  assert.equal(sd.json.status, 'succeeded', sd.text);
  const cliP = await cliFiles(['portfolio', '--preset', 'houston', '--minutes', '3', '--members', '3', '--seed', '4', '--csv', 'assets.csv', '--out', 'results.csv', '--summary', 'summary.json'], csv);
  assert.equal((await request(api, 'GET', `/v1/jobs/${p.json.id}/results/results.csv`)).text, cliP.get('results.csv'));
  assert.deepEqual(withoutTiming((await request(api, 'GET', `/v1/jobs/${p.json.id}/results/summary.json`)).text), withoutTiming(String(cliP.get('summary.json'))));
  const cliS = await cliFiles(['site', '--preset', 'pittsburgh', '--at', '40.4425,-80.0085', '--use', 'office', '--floors', '3', '--sweep', '--levels', 'ivan2004,rp100', '--minutes', '4', '--out', 'report.json']);
  const report = (await request(api, 'GET', `/v1/jobs/${s.json.id}/results/report.json`)).text;
  assert.deepEqual(withoutTiming(report), withoutTiming(String(cliS.get('report.json'))));
  assert.equal(fs.existsSync(path.join(tmp, 'main', 'jobs', p.json.id, 'input.csv')), false, 'the CSV is deleted when the job ends');
});

test('GET /v1/presets is `deluge presets --json`', async () => {
  const r = await request(api, 'GET', '/v1/presets');
  assert.equal(r.status, 200);
  const ids = r.json.presets.map((p: { id: string }) => p.id);
  assert.ok(ids.includes('pittsburgh') && ids.includes('houston'));
  assert.ok(r.json.presets.find((p: { id: string }) => p.id === 'pittsburgh').levels.some((l: { id: string }) => l.id === 'rp100'));
});

// ─── Fail fast, with fixed sentences ────────────────────────────────────────────────────────────────────────────────

test('bad requests are 400 at once, with fixed sentences that never echo the input', async () => {
  const before = (await request(api, 'GET', '/v1/jobs')).json.jobs.length;
  const cases: Array<[string, unknown, RegExp]> = [
    ['/v1/runs', { preset: MARKER }, /Unknown preset/],
    ['/v1/runs', { preset: 'atlantis' }, /Unknown preset/],
    ['/v1/runs', { preset: 'pittsburgh', scenario: { level: 'rp9999' } }, /scenario\.level/],
    ['/v1/runs', { preset: 'pittsburgh', scenario: { level: MARKER } }, /scenario\.level/],
    ['/v1/runs', { preset: 'pittsburgh', scenario: { stageFt: 400 } }, /scenario\.stageFt/],
    ['/v1/runs', { preset: 'houston', scenario: { stageFt: 30 } }, /scenario\.stageFt/],
    ['/v1/runs', { preset: 'houston', scenario: { minutes: 1 } }, /scenario\.minutes/],
    ['/v1/runs', { preset: 'houston', scenario: { climate: { horizon: MARKER } } }, /scenario\.climate\.horizon must be one of/],
    ['/v1/runs', { preset: 'houston', [MARKER]: 1 }, /does not accept/],
    ['/v1/runs', { preset: 'houston', callbackUrl: 'http://169.254.169.254/' }, /does not accept/],
    ['/v1/runs', [1, 2], /must be a JSON object/],
    ['/v1/portfolio-assessments', { preset: 'houston', assetsCsv: `name,lat\n${MARKER},1\n` }, /asset_id/],
    ['/v1/portfolio-assessments', { preset: 'houston', assetsCsv: `asset_id,lat,lon\n${Array.from({ length: 5001 }, (_, i) => `A${i},29.77,-95.38`).join('\n')}\n` }, /more than 5,000 asset rows/],
    ['/v1/portfolio-assessments', { preset: 'houston', assetsCsv: `asset_id,lat,lon\n${MARKER},x,y\n` }, /no usable assets/],
    ['/v1/portfolio-assessments', { preset: 'houston', assetsCsv: 'asset_id,lat,lon\nA,29.77,-95.38\n', ensemble: { members: 99 } }, /ensemble\.members/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 29.77, lon: -95.38 } }, /outside this preset/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0, use: MARKER } }, /site\.use must be one of/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0 }, egress: { departure: MARKER } }, /egress\.departure must be one of/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0 }, egress: { exitLanes: 99 } }, /egress\.exitLanes/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0 }, egress: { [MARKER]: 1 } }, /does not accept/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0, name: `${MARKER}‮` } }, /site\.name/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0 }, sweep: { levels: ['rp100', 'nope'] } }, /sweep\.levels/],
    ['/v1/site-checks', { preset: 'houston', site: { lat: 29.7725, lon: -95.3837 }, sweep: { ladder: 'stage' } }, /sweep\.ladder/],
    ['/v1/site-checks', '{"preset":"pittsburgh","site":{"lat":40.44,"lon":-80.0},"sweep":{"returnPeriods":{"__proto__":5,"EVILMARKER":10}}}', /sweep\.returnPeriods/],
    ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0 }, scenario: { stageFt: 40 }, sweep: {} }, /drop scenario\.level/],
  ];
  for (const [url, body, want] of cases) {
    const r = await post(api, url, body);
    assert.equal(r.status, 400, `${url} ${JSON.stringify(body).slice(0, 80)} → ${r.status} ${r.text}`);
    assert.equal(r.headers['content-type'], 'application/problem+json');
    assert.match(r.json.detail, want);
    assert.ok(!r.text.includes('EVIL') && !r.text.includes('MARKER') && !r.text.includes('atlantis') && !r.text.includes('9999') && !r.text.includes('nope'), `echoed: ${r.text}`);
  }
  assert.equal((await post(api, '/v1/runs', '{"preset":')).status, 400);
  assert.equal((await request(api, 'POST', '/v1/runs', { body: '{"preset":', headers: {} })).json.detail, 'The request body is not valid JSON.');
  assert.equal((await request(api, 'GET', '/v1/jobs')).json.jobs.length, before, 'nothing was queued');
});

// ─── Idempotency ────────────────────────────────────────────────────────────────────────────────────────────────────

test('Idempotency-Key: a repeat returns the existing job; the same key with another body is a 409', async () => {
  const body = { preset: 'houston', scenario: { minutes: 2 }, rasters: false };
  const a = await post(api, '/v1/runs', body, { 'idempotency-key': 'order-42' });
  assert.equal(a.status, 202);
  const b = await post(api, '/v1/runs', body, { 'idempotency-key': 'order-42' });
  assert.equal(b.status, 200);
  assert.equal(b.json.id, a.json.id);
  assert.equal(b.headers['idempotent-replayed'], 'true');
  const c = await post(api, '/v1/runs', { ...body, scenario: { minutes: 3 } }, { 'idempotency-key': 'order-42' });
  assert.equal(c.status, 409);
  const d = await post(api, '/v1/runs', body, { 'idempotency-key': 'x'.repeat(200) });
  assert.equal(d.status, 400);
  assert.ok(!d.text.includes('xxxx'));
  await waitFor(api, a.json.id);
});

// ─── Cancel and delete ──────────────────────────────────────────────────────────────────────────────────────────────

test('DELETE: cancels a running job between frames and a queued one before it starts; deletes a finished one', async () => {
  frameDelayMs = 20;
  try {
    const running = await post(api, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 } });
    const queued = await post(api, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 } });
    await waitFor(api, running.json.id, (s) => s === 'running');
    const q = await request(api, 'DELETE', `/v1/jobs/${queued.json.id}`);
    assert.equal(q.status, 204);
    assert.equal((await request(api, 'GET', `/v1/jobs/${queued.json.id}`)).json.status, 'cancelled');
    const r = await request(api, 'DELETE', `/v1/jobs/${running.json.id}`);
    assert.equal(r.status, 202);
    const end = await waitFor(api, running.json.id);
    assert.equal(end.json.status, 'cancelled');
    assert.deepEqual(end.json.files, []);
    assert.deepEqual(fs.readdirSync(path.join(tmp, 'main', 'jobs', running.json.id)), ['job.json'], 'no result files left');
  } finally {
    frameDelayMs = 0;
  }
  const done = await post(api, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 }, rasters: false });
  await waitFor(api, done.json.id);
  assert.equal((await request(api, 'DELETE', `/v1/jobs/${done.json.id}`)).status, 204);
  assert.equal((await request(api, 'GET', `/v1/jobs/${done.json.id}`)).status, 404);
  assert.equal(fs.existsSync(path.join(tmp, 'main', 'jobs', done.json.id)), false);
});

// ─── Retention and restart ──────────────────────────────────────────────────────────────────────────────────────────

test('retention deletes finished jobs and their files; a restart keeps finished jobs and fails unfinished ones', async () => {
  const dir = path.join(tmp, 'retain');
  const s1 = await startServer({ engine, dataDir: dir, port: 0, retentionMs: 3600e3 });
  const a = await post(s1, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 }, rasters: false }, { 'idempotency-key': 'keep-me' });
  const done = await waitFor(s1, a.json.id);
  assert.equal(done.json.status, 'succeeded');
  assert.equal(done.json.expiresAt, new Date(Date.parse(done.json.finishedAt) + 3600e3).toISOString());
  await s1.close();
  // A job record left "running" by a crash.
  const crashed = 'job_' + 'ab'.repeat(12);
  fs.mkdirSync(path.join(dir, 'jobs', crashed));
  fs.writeFileSync(path.join(dir, 'jobs', crashed, 'job.json'), JSON.stringify({ ...done.json, id: crashed, status: 'running', files: [], idempotencyKey: null }));
  fs.mkdirSync(path.join(dir, 'jobs', 'not-a-job'));
  const s2 = await startServer({ engine, dataDir: dir, port: 0, retentionMs: 3600e3 });
  try {
    const again = await request(s2, 'GET', `/v1/jobs/${a.json.id}`);
    assert.equal(again.json.status, 'succeeded');
    assert.equal((await request(s2, 'GET', `/v1/jobs/${a.json.id}/results/summary.json`)).status, 200);
    assert.equal((await post(s2, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 }, rasters: false }, { 'idempotency-key': 'keep-me' })).json.id, a.json.id, 'keys survive a restart');
    const c = await request(s2, 'GET', `/v1/jobs/${crashed}`);
    assert.equal(c.json.status, 'failed');
    assert.match(c.json.error, /stopped before this job finished/);
    clock += 3600e3 + 1;
    s2.sweep();
    assert.equal((await request(s2, 'GET', `/v1/jobs/${a.json.id}`)).status, 404);
    assert.equal(fs.existsSync(path.join(dir, 'jobs', a.json.id)), false);
    assert.ok(fs.existsSync(path.join(dir, 'jobs', 'not-a-job')), 'directories that are not jobs are left alone');
  } finally {
    await s2.close();
  }
});

// ─── Security ───────────────────────────────────────────────────────────────────────────────────────────────────────

test('security: a non-loopback bind needs a token; bearer auth; Host check; caps; content type; no traversal', async () => {
  await assert.rejects(startServer({ engine, dataDir: path.join(tmp, 'x'), host: '0.0.0.0', port: 0 }), /token is required/);
  await assert.rejects(startServer({ engine, dataDir: path.join(tmp, 'x'), port: 0, token: 'short' }), /at least 16/);
  const token = 'a-long-test-token-0123456789';
  const s = await startServer({ engine, dataDir: path.join(tmp, 'auth'), port: 0, token });
  try {
    assert.equal((await request(s, 'GET', '/v1/health')).status, 200, 'health needs no token');
    for (const auth of [undefined, 'Bearer wrong-token-wrong-token', `Basic ${token}`, `Bearer ${token}x`]) {
      const r = await request(s, 'GET', '/v1/presets', { headers: auth ? { authorization: auth } : {} });
      assert.equal(r.status, 401);
      assert.equal(r.headers['www-authenticate'], 'Bearer');
    }
    assert.equal((await request(s, 'GET', '/v1/presets', { token })).status, 200);
    assert.equal((await post(s, '/v1/runs', { preset: 'houston' })).status, 401, 'POST without a token');
    // DNS rebinding: a page whose name now points at 127.0.0.1.
    const rebound = await request(s, 'GET', '/v1/presets', { token, headers: { host: `evil.example:${s.port}` } });
    assert.equal(rebound.status, 403);
    // Bodies over the cap: refused before parsing (declared or streamed).
    const big = JSON.stringify({ preset: 'houston', pad: 'x'.repeat(70 * 1024) });
    const r413 = await request(s, 'POST', '/v1/runs', { body: big, token }).catch((e) => ({ status: 413, err: e }));
    assert.equal(r413.status, 413);
    // A form post (what a web page can send without a CORS preflight) is refused.
    const form = await request(s, 'POST', '/v1/runs', { body: '{"preset":"houston"}', headers: { 'content-type': 'text/plain' }, token });
    assert.equal(form.status, 415);
    assert.equal(form.headers['access-control-allow-origin'], undefined);
    // A finished job, then every way out of its directory.
    const job = await post(s, '/v1/runs', { preset: 'houston', scenario: { minutes: 2 }, rasters: false }, {}, token);
    await waitFor(s, job.json.id, undefined, token);
    fs.writeFileSync(path.join(tmp, 'auth', 'secret.txt'), 'TOP-SECRET');
    const id = job.json.id;
    for (const p of [`/v1/jobs/${id}/results/job.json`, `/v1/jobs/${id}/results/..%2f..%2fsecret.txt`, `/v1/jobs/${id}/results/%2e%2e/%2e%2e/secret.txt`, `/v1/jobs/${id}/results/..\\..\\secret.txt`, `/v1/jobs/${id}/results/../../secret.txt`, `/v1/jobs/..%2fsecret.txt/results/summary.json`, `/v1/jobs/${id}/results/summary.json%00.txt`, `/v1/jobs/${id}/results/max_depth_m.tif`, '/v1/../secret.txt', '/../../secret.txt']) {
      const r = await request(s, 'GET', p, { token });
      assert.equal(r.status, 404, `${p} → ${r.status}`);
      assert.ok(!r.text.includes('TOP-SECRET') && !r.text.includes('"requestHash"'), p);
    }
    assert.equal((await request(s, 'GET', `/v1/jobs/${id}/results/summary.json`, { token })).status, 200);
    // Every response says no-store / nosniff.
    const h = (await request(s, 'GET', `/v1/jobs/${id}`, { token })).headers;
    assert.equal(h['cache-control'], 'no-store');
    assert.equal(h['x-content-type-options'], 'nosniff');
  } finally {
    await s.close();
  }
});
