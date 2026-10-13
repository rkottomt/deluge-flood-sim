/// <reference types="node" />
/**
 * `deluge serve` — the CLI's commands as an HTTP job API (docs/api.md), on node:http with no other dependency.
 *
 *   GET    /v1/health                         liveness (no auth)
 *   GET    /v1/presets                        `deluge presets --json --levels`
 *   POST   /v1/runs                           `deluge run`        → 202 + job
 *   POST   /v1/portfolio-assessments          `deluge portfolio`  → 202 + job
 *   POST   /v1/site-checks                    `deluge site`       → 202 + job
 *   GET    /v1/jobs                           the jobs held (newest first)
 *   GET    /v1/jobs/{id}                      status, progress, engine, files
 *   GET    /v1/jobs/{id}/results/{file}       a result file (also …/files/{file})
 *   DELETE /v1/jobs/{id}                      cancel (queued or running) or delete (finished) — files go too
 *
 * NO NEW PHYSICS: a job runs the command handler of src/cli/commands.ts with the options its request maps to
 * (src/cli/api.ts), in-process, with a CliEnv whose `write` lands in the job's directory — the same code as the CLI, so
 * the same numbers (tests/cli/server.test.ts compares an API run with the binary's, raster byte for byte).
 *
 * ONE GPU QUEUE: jobs run one at a time, first in first out; the device is the process's one Dawn device.
 *
 * SECURITY (docs/api.md § Security):
 *   • binds 127.0.0.1 unless told otherwise, and refuses a non-loopback address without a bearer token;
 *   • bearer token compared in constant time; on a loopback bind the Host header must be a loopback name (so a web
 *     page cannot reach the API by DNS rebinding), and POSTs must be application/json (so a page cannot send one
 *     without a CORS preflight, which this server never grants);
 *   • bodies capped (64 KiB; 12 MiB for a portfolio, whose CSV is then held to parsePortfolio's 5 M characters and
 *     5,000 rows), headers and requests time out, the queue is bounded;
 *   • ids and file names are matched against fixed patterns and an allowlist before any path is built, so a download
 *     cannot leave the job's directory;
 *   • every error is a fixed sentence (RFC 9457 problem+json) that never contains request input;
 *   • finished jobs and their files are deleted after the retention period; a portfolio's CSV is deleted when its
 *     job ends.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { EXIT, num, str, type ParsedOptions } from './args';
import { ApiError, ASSETS_CSV, checkSpec, portfolioRequest, runRequest, siteRequest, type CheckResult, type JobKind, type JobSpec } from './api';
import { HANDLERS, presetsCommand, type CliEnv } from './commands';
import { NoGpuError } from './gpu';
import { createLog, type Log } from './io';
import { UsageError } from './scenario';

/** What the server needs from the machine: the CLI's environment minus its per-command I/O. */
export interface Engine extends Pick<CliEnv, 'version' | 'presetIds' | 'presetMeta' | 'loadTerrain' | 'loadAtlas14' | 'loadNidIndex' | 'openScene' | 'gpuName' | 'now'> {
  /** Uncaptured WebGPU errors so far (a job during which this grows has failed). */
  gpuErrorCount(): number;
  /** Let queued GPU work finish (after each job). */
  settle(): Promise<void>;
}

export interface ServerOptions {
  engine: Engine;
  /** Job records and result files live in `<dataDir>/jobs/<id>/`. */
  dataDir: string;
  host?: string;
  /** 0 = any free port. */
  port?: number;
  /** Bearer token clients must send; null = no auth (loopback binds only). */
  token?: string | null;
  /** Finished jobs are deleted this long after they end, ms. */
  retentionMs?: number;
  /** Jobs waiting for the GPU at most. */
  maxQueue?: number;
  /** Source revision recorded with each job (git commit), if known. */
  commit?: string | null;
  /** The server's own log (job lifecycle; never request bodies). */
  log?: Log;
}

export interface ApiServer {
  readonly server: http.Server;
  readonly url: string;
  readonly port: number;
  /** Delete finished jobs past retention now (also runs on a timer). */
  sweep(): void;
  /** Resolves when the queue is empty and nothing runs. */
  idle(): Promise<void>;
  /** Stop listening, cancel the running job, wait for it. */
  close(): Promise<void>;
}

export const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  retentionMs: 30 * 24 * 3600 * 1000,
  maxQueue: 32,
  /** Body caps, bytes. A portfolio's CSV arrives JSON-escaped and UTF-8 encoded; its length is checked once parsed. */
  maxBody: 64 * 1024,
  maxPortfolioBody: 12 * 1024 * 1024,
  minTokenChars: 16,
} as const;

/** The files a job may produce (the CLI's outputs). Downloads are limited to these names. */
export const RESULT_FILES: Readonly<Record<string, string>> = {
  'summary.json': 'application/json',
  'results.csv': 'text/csv; charset=utf-8',
  'report.json': 'application/json',
  'max_depth_m.tif': 'image/tiff',
  'max_speed_ms.tif': 'image/tiff',
  'arrival_min.tif': 'image/tiff',
  'hazard_aidr.tif': 'image/tiff',
};

const ID_RE = /^job_[0-9a-f]{24}$/;
const KEY_RE = /^[\x21-\x7e]{1,128}$/;
const INPUT_FILE = 'input.csv';
const RECORD_FILE = 'job.json';

type Status = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

interface Job {
  id: string;
  kind: JobKind;
  status: Status;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The request as validated (a portfolio's CSV replaced by its counts and digest). */
  request: Record<string, unknown>;
  /** The equivalent CLI command line. */
  command: string[];
  engine: { version: string; commit: string | null; gpu: string | null };
  files: string[];
  error: string | null;
  idempotencyKey: string | null;
  requestHash: string;
  /** In memory only. */
  progress?: { fraction: number; case: string } | null;
  cancelRequested?: boolean;
}

class JobCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'JobCancelled';
  }
}

/** Fixed sentences for a job that ended badly (the cause goes to the server log only). */
const JOB_ERRORS = {
  usage: 'The request did not fit the preset once it was loaded (for example a site outside the simulation grid).',
  noGpu: 'No WebGPU device is available on this server.',
  gpu: 'The GPU reported an error during the run; no results were kept.',
  failed: 'The simulation failed; the server log has the details.',
  restart: 'The server stopped before this job finished.',
} as const;

const isLoopback = (host: string) => host === 'localhost' || host === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** Strip anything that could forge a log line. */
const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').slice(0, 300);

function problem(res: http.ServerResponse, status: number, title: string, detail: string, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  const body = JSON.stringify({ type: 'about:blank', title, status, detail });
  res.writeHead(status, { 'content-type': 'application/problem+json', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

function json(res: http.ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const body = `${JSON.stringify(value, (_k, x) => (typeof x === 'number' && !Number.isFinite(x) ? null : x), 2)}\n`;
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

/** Read a JSON body up to `cap` bytes (413 beyond, 415 for another type, 400 for bad UTF-8 or JSON). */
async function readJson(req: http.IncomingMessage, cap: number): Promise<{ value: unknown; raw: Buffer }> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new ApiError(415, 'Unsupported media type', 'Send the request as application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > cap) throw new ApiError(413, 'Request too large', `The request body is larger than this endpoint accepts (${Math.round(cap / 1024)} KiB).`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > cap) throw new ApiError(413, 'Request too large', `The request body is larger than this endpoint accepts (${Math.round(cap / 1024)} KiB).`);
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new ApiError(400, 'Invalid request', 'The request body is not valid UTF-8.');
  }
  try {
    return { value: JSON.parse(text), raw };
  } catch {
    throw new ApiError(400, 'Invalid request', 'The request body is not valid JSON.');
  }
}

function sameSecret(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export async function startServer(opts: ServerOptions): Promise<ApiServer> {
  const engine = opts.engine;
  const host = opts.host ?? DEFAULTS.host;
  const token = opts.token ?? null;
  if (!isLoopback(host) && !token) throw new UsageError('a bearer token is required to listen on a non-loopback address');
  if (token !== null && token.length < DEFAULTS.minTokenChars) throw new UsageError(`the token must be at least ${DEFAULTS.minTokenChars} characters`);
  const retentionMs = opts.retentionMs ?? DEFAULTS.retentionMs;
  const maxQueue = opts.maxQueue ?? DEFAULTS.maxQueue;
  const log = opts.log ?? createLog({ quiet: true });
  const jobsDir = path.resolve(opts.dataDir, 'jobs');
  fs.mkdirSync(jobsDir, { recursive: true });
  const dirOf = (id: string) => {
    if (!ID_RE.test(id)) throw new Error('bad job id');
    return path.join(jobsDir, id);
  };

  const jobs = new Map<string, Job>();
  const byKey = new Map<string, string>();
  const queue: Job[] = [];
  const specs = new Map<string, JobSpec>();
  let current: Job | null = null;
  let closing = false;
  let idleWaiters: Array<() => void> = [];

  const persist = (job: Job) => {
    const { progress: _p, cancelRequested: _c, ...rec } = job;
    void _p;
    void _c;
    try {
      fs.writeFileSync(path.join(dirOf(job.id), RECORD_FILE), `${JSON.stringify(rec, null, 2)}\n`);
    } catch (err) {
      log.warn(`job ${job.id}: could not save its record (${clean(String(err))})`);
    }
  };
  const removeFiles = (job: Job) => {
    for (const f of [...job.files, INPUT_FILE]) fs.rmSync(path.join(dirOf(job.id), f), { force: true });
    job.files = [];
  };
  const forget = (job: Job) => {
    jobs.delete(job.id);
    specs.delete(job.id);
    if (job.idempotencyKey && byKey.get(job.idempotencyKey) === job.id) byKey.delete(job.idempotencyKey);
    fs.rmSync(dirOf(job.id), { recursive: true, force: true });
  };

  // ── Jobs left by an earlier run of the server ───────────────────────────────────────────────────────────────────
  for (const name of fs.readdirSync(jobsDir)) {
    if (!ID_RE.test(name)) continue;
    try {
      const file = path.join(jobsDir, name, RECORD_FILE);
      if (fs.statSync(file).size > 1024 * 1024) continue;
      const rec = JSON.parse(fs.readFileSync(file, 'utf8')) as Job;
      if (rec.id !== name || !['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(rec.status) || !Array.isArray(rec.files)) continue;
      rec.files = rec.files.filter((f) => typeof f === 'string' && Object.hasOwn(RESULT_FILES, f) && fs.existsSync(path.join(jobsDir, name, f)));
      if (typeof rec.idempotencyKey !== 'string' || !KEY_RE.test(rec.idempotencyKey)) rec.idempotencyKey = null;
      if (rec.status === 'queued' || rec.status === 'running') {
        rec.status = 'failed';
        rec.error = JOB_ERRORS.restart;
        rec.finishedAt = engine.now().toISOString();
        jobs.set(rec.id, rec);
        removeFiles(rec);
        persist(rec);
      } else jobs.set(rec.id, rec);
      if (rec.idempotencyKey) byKey.set(rec.idempotencyKey, rec.id);
    } catch {
      /* not a record of ours: left alone */
    }
  }

  // ── Retention ──────────────────────────────────────────────────────────────────────────────────────────────────
  const sweep = () => {
    const now = engine.now().getTime();
    for (const job of [...jobs.values()]) {
      if (job.finishedAt && now - Date.parse(job.finishedAt) >= retentionMs) {
        forget(job);
        log.info(`job ${job.id}: deleted after the retention period`);
      }
    }
  };
  sweep();
  const sweeper = setInterval(sweep, Math.max(1000, Math.min(retentionMs / 4, 10 * 60 * 1000)));
  sweeper.unref();

  // ── The GPU queue ──────────────────────────────────────────────────────────────────────────────────────────────
  const jobEnv = (job: Job, dir: string): CliEnv => {
    const check = () => {
      if (job.cancelRequested || closing) throw new JobCancelled();
    };
    return {
      log: {
        info: () => check(),
        warn: () => {},
        progress(label, fraction) {
          check();
          job.progress = { fraction: Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0)), case: label };
        },
        endProgress: () => {},
      },
      version: engine.version,
      presetIds: engine.presetIds,
      presetMeta: engine.presetMeta,
      loadTerrain: engine.loadTerrain,
      loadAtlas14: engine.loadAtlas14,
      loadNidIndex: engine.loadNidIndex,
      openScene: engine.openScene,
      gpuName: engine.gpuName,
      now: engine.now,
      readText(file) {
        if (file !== ASSETS_CSV) throw new Error('not an input of this job');
        return fs.readFileSync(path.join(dir, INPUT_FILE), 'utf8');
      },
      write(file, data) {
        const name = path.basename(file);
        if (!Object.hasOwn(RESULT_FILES, name)) throw new Error('not a result file');
        fs.writeFileSync(path.join(dir, name), typeof data === 'string' ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data));
        if (!job.files.includes(name)) job.files.push(name);
      },
      stdout: () => {},
    };
  };

  const runJob = async (job: Job) => {
    const spec = specs.get(job.id)!;
    const dir = dirOf(job.id);
    current = job;
    job.status = 'running';
    job.startedAt = engine.now().toISOString();
    job.progress = { fraction: 0, case: 'load' };
    persist(job);
    log.info(`job ${job.id}: running (${job.kind} ${clean(String(spec.options.preset))})`);
    const errorsBefore = engine.gpuErrorCount();
    let status: Status = 'failed';
    let error: string | null = JOB_ERRORS.failed;
    try {
      job.engine.gpu = await engine.gpuName();
      const code = await HANDLERS[spec.command](jobEnv(job, dir), spec.options);
      if (engine.gpuErrorCount() > errorsBefore) error = JOB_ERRORS.gpu;
      else if (code === EXIT.ok) {
        status = 'succeeded';
        error = null;
      }
    } catch (err) {
      if (err instanceof JobCancelled) {
        status = 'cancelled';
        error = null;
      } else if (err instanceof UsageError) error = JOB_ERRORS.usage;
      else if (err instanceof NoGpuError) error = JOB_ERRORS.noGpu;
      if (!(err instanceof JobCancelled)) log.warn(`job ${job.id}: ${clean(err instanceof Error ? err.message : String(err))}`);
    }
    try {
      await engine.settle();
    } catch {
      /* the device is gone; the next job reports it */
    }
    // A cancel that arrived after the last frame still cancels: the client asked for the results to go.
    if (job.cancelRequested) {
      status = 'cancelled';
      error = null;
    }
    fs.rmSync(path.join(dir, INPUT_FILE), { force: true });
    if (status !== 'succeeded') removeFiles(job);
    specs.delete(job.id);
    job.status = status;
    job.error = error;
    job.finishedAt = engine.now().toISOString();
    job.progress = status === 'succeeded' ? { fraction: 1, case: 'done' } : null;
    current = null;
    log.info(`job ${job.id}: ${status}`);
    persist(job);
  };

  let pumping = false;
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length && !closing) await runJob(queue.shift()!);
    } finally {
      pumping = false;
      if (!queue.length) {
        const w = idleWaiters;
        idleWaiters = [];
        for (const f of w) f();
      }
    }
  };

  const enqueue = async (spec: JobSpec, checked: CheckResult, key: string | null, hash: string): Promise<Job> => {
    const id = `job_${crypto.randomBytes(12).toString('hex')}`;
    const request = { ...spec.request };
    if (spec.csv !== null) request.assets = { ...checked.assets, sha256: crypto.createHash('sha256').update(spec.csv).digest('hex') };
    const job: Job = {
      id,
      kind: spec.kind,
      status: 'queued',
      createdAt: engine.now().toISOString(),
      startedAt: null,
      finishedAt: null,
      request,
      command: ['deluge', ...spec.argv],
      engine: { version: engine.version, commit: opts.commit ?? null, gpu: null },
      files: [],
      error: null,
      idempotencyKey: key,
      requestHash: hash,
      progress: null,
    };
    fs.mkdirSync(dirOf(id), { recursive: true });
    if (spec.csv !== null) fs.writeFileSync(path.join(dirOf(id), INPUT_FILE), spec.csv);
    // The CSV now lives on disk until the job ends, not in memory.
    specs.set(id, { ...spec, csv: null });
    jobs.set(id, job);
    if (key) byKey.set(key, id);
    persist(job);
    queue.push(job);
    log.info(`job ${id}: queued (${job.kind} ${clean(String(spec.options.preset))}, ${queue.length} waiting)`);
    void pump();
    return job;
  };

  // ── Views ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const view = (job: Job) => ({
    id: job.id,
    kind: job.kind,
    status: job.status,
    progress: job.status === 'queued' ? { fraction: 0, case: 'queued', position: queue.indexOf(job) + 1 } : (job.progress ?? null),
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    expiresAt: job.finishedAt ? new Date(Date.parse(job.finishedAt) + retentionMs).toISOString() : null,
    cancelRequested: job.cancelRequested ? true : undefined,
    engine: job.engine,
    request: job.request,
    command: job.command,
    files: job.status === 'succeeded'
      ? job.files.map((name) => ({ name, url: `/v1/jobs/${job.id}/results/${name}`, contentType: RESULT_FILES[name], bytes: safeSize(path.join(dirOf(job.id), name)) }))
      : [],
    error: job.error,
  });

  let presetsCache: Promise<unknown> | null = null;
  const presets = () => {
    presetsCache ??= (async () => {
      let out = '';
      const env = { log: createLog({ quiet: true }), presetIds: engine.presetIds, presetMeta: engine.presetMeta, loadAtlas14: engine.loadAtlas14, stdout: (t: string) => void (out += t) } as unknown as CliEnv;
      await presetsCommand(env, { json: true, levels: true } as ParsedOptions);
      return JSON.parse(out);
    })().catch((e) => {
      presetsCache = null;
      throw e;
    });
    return presetsCache;
  };

  const checkEnv = { presetIds: engine.presetIds, presetMeta: engine.presetMeta, loadAtlas14: engine.loadAtlas14, log: createLog({ quiet: true }) };

  // ── HTTP ───────────────────────────────────────────────────────────────────────────────────────────────────────
  const ENDPOINTS: Record<string, { build: (body: unknown) => JobSpec; cap: number }> = {
    runs: { build: runRequest, cap: DEFAULTS.maxBody },
    'portfolio-assessments': { build: portfolioRequest, cap: DEFAULTS.maxPortfolioBody },
    'site-checks': { build: siteRequest, cap: DEFAULTS.maxBody },
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('referrer-policy', 'no-referrer');
    const method = req.method ?? 'GET';
    const target = req.url ?? '/';
    if (target.length > 512 || !target.startsWith('/')) return problem(res, 404, 'Not found', 'There is no such endpoint.');
    // On a loopback bind, only loopback host names: a web page that rebinds its own name to 127.0.0.1 is refused.
    if (isLoopback(host)) {
      const h = String(req.headers.host ?? '').toLowerCase();
      const name = h.startsWith('[') ? h.slice(0, h.indexOf(']') + 1) : h.split(':')[0];
      if (!['localhost', '127.0.0.1', '[::1]'].includes(name) && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)) return problem(res, 403, 'Forbidden', 'This server only answers requests addressed to a loopback host name.');
    }
    const pathname = target.split('?')[0];
    const seg = pathname.split('/').slice(1);
    if (seg[0] !== 'v1') return problem(res, 404, 'Not found', 'There is no such endpoint.');
    if (seg[1] === 'health' && seg.length === 2) {
      if (method !== 'GET' && method !== 'HEAD') return problem(res, 405, 'Method not allowed', 'This endpoint does not take that method.', { allow: 'GET' });
      return json(res, 200, { status: 'ok' });
    }
    if (token !== null) {
      const auth = String(req.headers.authorization ?? '');
      const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(auth);
      if (!m || !sameSecret(m[1], token)) return problem(res, 401, 'Unauthorized', 'A valid bearer token is required.', { 'www-authenticate': 'Bearer' });
    }
    const allow = (methods: string) => problem(res, 405, 'Method not allowed', 'This endpoint does not take that method.', { allow: methods });

    if (seg[1] === 'presets' && seg.length === 2) {
      if (method !== 'GET') return allow('GET');
      return json(res, 200, await presets());
    }
    if (seg.length === 2 && Object.hasOwn(ENDPOINTS, seg[1])) {
      if (method !== 'POST') return allow('POST');
      const ep = ENDPOINTS[seg[1]];
      const keyHeader = req.headers['idempotency-key'];
      const key = keyHeader === undefined ? null : String(keyHeader);
      if (key !== null && !KEY_RE.test(key)) throw new ApiError(400, 'Invalid request', 'The Idempotency-Key header must be 1 to 128 printable ASCII characters.');
      const { value, raw } = await readJson(req, ep.cap);
      const hash = crypto.createHash('sha256').update(seg[1]).update('\n').update(raw).digest('hex');
      if (key !== null) {
        const prior = jobs.get(byKey.get(key) ?? '');
        if (prior) {
          if (prior.requestHash !== hash) throw new ApiError(409, 'Conflict', 'This Idempotency-Key was already used for a different request.');
          return json(res, 200, view(prior), { location: `/v1/jobs/${prior.id}`, 'idempotent-replayed': 'true' });
        }
      }
      if (closing) throw new ApiError(503, 'Unavailable', 'The server is shutting down.');
      if (queue.length >= maxQueue) throw new ApiError(503, 'Unavailable', 'The job queue is full; try again later.');
      const spec = ep.build(value);
      const checked = await checkSpec(checkEnv, spec);
      // A request with the same key may have been queued while this one was being checked.
      if (key !== null && jobs.has(byKey.get(key) ?? '')) {
        const prior = jobs.get(byKey.get(key)!)!;
        if (prior.requestHash !== hash) throw new ApiError(409, 'Conflict', 'This Idempotency-Key was already used for a different request.');
        return json(res, 200, view(prior), { location: `/v1/jobs/${prior.id}`, 'idempotent-replayed': 'true' });
      }
      const job = await enqueue(spec, checked, key, hash);
      return json(res, 202, view(job), { location: `/v1/jobs/${job.id}` });
    }
    if (seg[1] === 'jobs') {
      if (seg.length === 2) {
        if (method !== 'GET') return allow('GET');
        const list = [...jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((j) => ({ id: j.id, kind: j.kind, status: j.status, createdAt: j.createdAt, finishedAt: j.finishedAt }));
        return json(res, 200, { jobs: list });
      }
      const id = seg[2];
      const job = ID_RE.test(id) ? jobs.get(id) : undefined;
      if (!job) return problem(res, 404, 'Not found', 'There is no such job.');
      if (seg.length === 3) {
        if (method === 'GET') return json(res, 200, view(job));
        if (method === 'DELETE') {
          if (job.status === 'running') {
            job.cancelRequested = true;
            log.info(`job ${job.id}: cancel requested`);
            return json(res, 202, view(job));
          }
          if (job.status === 'queued') {
            queue.splice(queue.indexOf(job), 1);
            job.status = 'cancelled';
            job.finishedAt = engine.now().toISOString();
            specs.delete(job.id);
            removeFiles(job);
            persist(job);
            log.info(`job ${job.id}: cancelled before it ran`);
          } else {
            forget(job);
            log.info(`job ${job.id}: deleted`);
          }
          res.writeHead(204);
          return res.end();
        }
        return allow('GET, DELETE');
      }
      if (seg.length === 5 && (seg[3] === 'results' || seg[3] === 'files')) {
        if (method !== 'GET' && method !== 'HEAD') return allow('GET');
        const name = seg[4];
        // The name must be one of the CLI's output names AND one this job wrote; only then is a path built.
        if (!Object.hasOwn(RESULT_FILES, name) || job.status !== 'succeeded' || !job.files.includes(name)) return problem(res, 404, 'Not found', 'This job has no such file.');
        const file = path.join(dirOf(job.id), name);
        let size: number;
        try {
          size = fs.statSync(file).size;
        } catch {
          return problem(res, 404, 'Not found', 'This job has no such file.');
        }
        res.writeHead(200, { 'content-type': RESULT_FILES[name], 'content-length': size, 'content-disposition': `attachment; filename="${name}"` });
        if (method === 'HEAD') return res.end();
        fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
        return;
      }
    }
    return problem(res, 404, 'Not found', 'There is no such endpoint.');
  };

  const server = http.createServer({ requestTimeout: 120_000, headersTimeout: 15_000, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof ApiError) {
        // A body cap: answer, then drop the connection rather than read the rest.
        const close = err.status === 413 ? { connection: 'close' } : undefined;
        problem(res, err.status, err.title, err.detail, close);
        const socket = req.socket;
        if (close) res.on('finish', () => socket?.destroy());
        return;
      }
      log.warn(`request failed: ${clean(err instanceof Error ? err.message : String(err))}`);
      problem(res, 500, 'Internal error', 'The server could not handle this request.');
    });
  });
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? DEFAULTS.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;

  return {
    server,
    url,
    port,
    sweep,
    idle: () => (queue.length || current ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve()),
    async close() {
      closing = true;
      clearInterval(sweeper);
      if (current) current.cancelRequested = true;
      for (const job of queue.splice(0)) {
        job.status = 'cancelled';
        job.error = JOB_ERRORS.restart;
        job.finishedAt = engine.now().toISOString();
        removeFiles(job);
        persist(job);
      }
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections();
      });
      while (pumping) await new Promise((r) => setTimeout(r, 20));
    },
  };
}

function safeSize(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/** The source revision, when this is a git checkout (recorded with each job). */
function gitCommit(): string | null {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    return execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}

/** `deluge serve`: runs until SIGINT / SIGTERM. */
export async function serveCommand(o: ParsedOptions, engine: Engine, log: Log): Promise<number> {
  const host = str(o, 'host') ?? DEFAULTS.host;
  const port = num(o, 'port') ?? DEFAULTS.port;
  const fail = (msg: string) => {
    process.stderr.write(`deluge serve: ${msg}\n`);
    return EXIT.usage;
  };
  if (!(Number.isInteger(port) && port >= 0 && port <= 65535)) return fail('--port must be a whole number from 0 to 65535');
  const hours = num(o, 'retention-hours') ?? DEFAULTS.retentionMs / 3600e3;
  if (!(hours > 0 && hours <= 24 * 3650)) return fail('--retention-hours must be more than 0 and at most 87600');
  const maxQueue = num(o, 'max-queue') ?? DEFAULTS.maxQueue;
  if (!(Number.isInteger(maxQueue) && maxQueue >= 1 && maxQueue <= 10000)) return fail('--max-queue must be a whole number from 1 to 10000');
  let token: string | null = process.env.DELUGE_API_TOKEN?.trim() || null;
  const tokenFile = str(o, 'token-file');
  if (tokenFile) {
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return fail('cannot read --token-file');
    }
  }
  if (token !== null && !/^[\x21-\x7e]+$/.test(token)) return fail('the token must be printable ASCII without spaces');
  const dataDir = path.resolve(str(o, 'data-dir') ?? 'results/api');
  let api: ApiServer;
  try {
    api = await startServer({ engine, dataDir, host, port, token, retentionMs: hours * 3600e3, maxQueue, commit: gitCommit(), log });
  } catch (err) {
    if (err instanceof UsageError) return fail(err.message);
    return fail(`cannot listen on ${host}:${port} (${err instanceof Error ? err.message : String(err)})`);
  }
  process.stderr.write(`deluge serve: listening on ${api.url} · jobs in ${dataDir} · ${token ? 'bearer token required' : 'no token (this machine only)'} · results kept ${hours} h\n`);
  await new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  process.stderr.write('deluge serve: stopping…\n');
  await api.close();
  return EXIT.ok;
}
