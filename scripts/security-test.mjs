#!/usr/bin/env node
/**
 * Deluge SECURITY REGRESSION SUITE — the penetration test's findings, automated so they cannot silently return.
 *
 *   npm run test:security                # full run (~3 min)
 *   npm run test:security -- --quick     # fast subset (~1 min): the runtime cases, no audit, fewer flows
 *   node scripts/security-test.mjs --url=https://example.com/deluge/   # check a deployed copy (static checks skipped)
 *
 * It builds the RELEASED production bundle — a plain `vite build`, with no DELUGE_DEBUG_API, i.e. exactly what ships
 * — serves it, and drives it through the DOM only. Nothing here depends on window.__deluge, because one of the
 * things it checks is that window.__deluge is not there (FINDINGS.json SEC-07).
 *
 * Every external host is intercepted, so the run is hermetic and identical offline: hosts are either aborted (the
 * "venue wifi is down" case the lead re-confirmed SEC-01 under) or answered with a hostile payload of our choosing.
 *
 * CASES (each maps to a finding in artifacts/security-report/FINDINGS.json)
 *   SPOOF-*    SEC-01  ?name= / ?preset= / invalid ?live= / ?story= must never put attacker prose in the app's own chrome
 *   XSS-*      SEC-01/08/09/10  hostile Nominatim, preset meta and road data must not execute (window.__pwned unset)
 *   CSP-*      SEC-02  the policy ships in the built index.html, and the main flows raise zero violations
 *   CAP-*      SEC-03  oversized and gzip-bomb responses are refused without exhausting memory (Nominatim; the
 *                      same-origin NOAA Atlas 14 grid behind Site check's rain ladder)
 *   DIST-*     SEC-07  no source maps, no local paths, no debug surfaces in the released bundle
 *   AUDIT-*    supply chain: `npm audit --omit=dev` is clean
 *   *-PROJECT-*  saved projects (src/project): a ?project= link never puts its names on the page, never executes,
 *              never pollutes Object.prototype and stops a gzip bomb; a link of map-sized brushes is refused, not
 *              replayed, and a link's digging waits for the user's yes; hostile .deluge.json files get fixed refusals
 *   API-*      the HTTP job API (`deluge serve`, src/cli/server.ts), run as its own process with a token: loopback by
 *              default and no open bind without a token, bearer auth everywhere but /v1/health, DNS rebinding and
 *              cross-site posts refused, no path traversal out of a job's directory, body caps (declared and
 *              streamed) and the CSV row cap, and hostile requests answered with fixed sentences that echo nothing
 *
 * A case whose fix has not landed yet is reported as PENDING rather than failing the build; DELUGE_SEC_STRICT=1
 * makes pending fatal too. Results: artifacts/security/security-results.json + a printed table; regressions exit 1.
 *
 * Flags: --quick --url=<url> --port=<n> --json=<path> --case=<substring> --headed --keep-dist --strict
 */
import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'security');
/**
 * Vite's CLI run with this Node directly, not through `npx`: on Windows `npx` is a .cmd shim that spawn() cannot
 * start without a shell, and killing the shim would leave `vite preview` running.
 */
const VITE_BIN = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const QUICK = argv.quick === 'true';
const STRICT = argv.strict === 'true' || process.env.DELUGE_SEC_STRICT === '1';
const KEEP_DIST = argv['keep-dist'] === 'true' || process.env.DELUGE_TEST_KEEP_DIST === '1';
const PORT = Number(argv.port ?? 5703);
const EXTERNAL_URL = String(argv.url ?? process.env.DELUGE_TEST_URL ?? '');
const JSON_OUT = String(argv.json ?? path.join(OUT_DIR, 'security-results.json'));
const SKIP_AUDIT = process.env.DELUGE_SEC_SKIP_AUDIT === '1' || QUICK;
/** CAP-*: idle stretch for the same-page drift control, ms (about as long as searchFlow's wait). */
const CAP_IDLE_MS = 2500;
/** CAP-*: live-heap growth allowed on top of a quarter of the payload, MB: twice the ~1.5 MB noise floor after a forced GC. */
const CAP_HEAP_SLACK_MB = 3;
const CASE_FILTER = argv.case ? String(argv.case) : null;

// ── payloads ────────────────────────────────────────────────────────────────────────────────────
// The exact strings the penetration test used (FINDINGS.json SEC-01 poc.urls), so a regression reproduces it.
const SPOOF_NAME = 'EVACUATE NOW: levee failed. Call 555-0100';
const SPOOF_BIDI = 'Pittsburgh ‮YCNEGREME DOOLF';
const SPOOF_PRESET = 'OFFICIAL NOTICE evacuate now call 555-0100';
const SPOOF_LIVE = 'WARNING: flood zone. Evacuate now and call 555-0100';
/** Fragments that must never reach the rendered page. Checked against innerText and every attribute value. */
const SPOOF_MARKERS = ['EVACUATE NOW', '555-0100', 'OFFICIAL NOTICE', 'YCNEGREME', 'flood zone. Evacuate'];
const XSS_PAYLOADS = [
  '<img src=x onerror="window.__pwned=1">',
  '"><script>window.__pwned=1</script>',
  "'><svg/onload=window.__pwned=1>",
  'javascript:window.__pwned=1',
  '<iframe srcdoc="<script>parent.__pwned=1</script>">',
];
/** Every third-party host the app may touch. Aborted by default so a run is hermetic and offline-identical. */
const EXTERNAL_HOSTS = [
  'elevation.nationalmap.gov',
  's3.amazonaws.com',
  'server.arcgisonline.com',
  'tigerweb.geo.census.gov',
  'api.openstreetmap.org',
  'nominatim.openstreetmap.org',
  'tile.openstreetmap.org',
];

// ── plumbing ────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Both stacks: `vite preview` binds only [::1] on macOS, and an IPv4-only probe would never see it. */
async function portOpen(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const s = net.connect({ port, host });
      const done = (v) => (s.destroy(), resolve(v));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
      setTimeout(() => done(false), 1000);
    });
  return (await Promise.all([probe('127.0.0.1'), probe('::1')])).some(Boolean);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function buildAndServe(distDir, port, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
  process.stdout.write(`[security] building the RELEASED bundle (no debug API) → ${path.relative(ROOT, distDir)} … `);
  // Deliberately NOT setting DELUGE_DEBUG_API: this suite must test the artifact that ships.
  const env = { ...process.env };
  delete env.DELUGE_DEBUG_API;
  const build = spawn(process.execPath, [VITE_BIN, 'build', '--outDir', distDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  build.stdout.pipe(log, { end: false });
  build.stderr.pipe(log, { end: false });
  const [code] = await once(build, 'exit');
  if (code !== 0) throw new Error(`vite build failed (exit ${code}); see ${logFile}`);
  console.log('ok');
  if (await portOpen(port)) throw new Error(`port ${port} is already in use — pass --port=<free port>`);
  const server = spawn(process.execPath, [VITE_BIN, 'preview', '--outDir', distDir, '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  for (let i = 0; i < 150; i++) {
    if (await portOpen(port)) return { server, url: `http://localhost:${port}/` };
    if (server.exitCode !== null) throw new Error(`vite preview exited (${server.exitCode}); see ${logFile}`);
    await sleep(100);
  }
  killTree(server);
  throw new Error(`vite preview never came up on ${port}; see ${logFile}`);
}

// ── results ─────────────────────────────────────────────────────────────────────────────────────
const results = [];
/**
 * Record one case. `status`: 'pass' | 'fail' | 'pending' (fix not landed yet — reported, fatal only with --strict)
 * | 'skip' (could not be exercised here, e.g. a static check against a remote URL).
 */
function record(id, finding, what, status, detail, evidence) {
  results.push({ id, finding, what, status, detail: detail ?? '', evidence: evidence ?? null });
  const mark = { pass: ' ok ', fail: 'FAIL', pending: 'PEND', skip: 'skip' }[status];
  console.log(`  [${mark}] ${id.padEnd(22)} ${what}${detail ? ` — ${detail}` : ''}`);
}
const shouldRun = (id) => !CASE_FILTER || id.toLowerCase().includes(CASE_FILTER.toLowerCase());

// ── page helpers ────────────────────────────────────────────────────────────────────────────────
/**
 * A page with every external host intercepted and the two tripwires installed:
 * `window.__pwned` (set by any payload that manages to execute) and a CSP-violation recorder.
 * `routes` maps a host substring to a handler; a host with no handler is aborted.
 */
async function newPage(browser, routes = {}) {
  const page = await browser.newPage({ viewport: { width: 1470, height: 956 }, deviceScaleFactor: 1 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.effectiveDirective || e.violatedDirective,
        blocked: String(e.blockedURI || '').slice(0, 200),
        sample: String(e.sample || '').slice(0, 120),
      });
    });
  });
  const seen = [];
  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const host = EXTERNAL_HOSTS.find((h) => url.includes(h));
    if (!host) return route.continue();
    seen.push(url.slice(0, 160));
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler(route, url);
    }
    return route.abort('connectionrefused');
  });
  page.__externalSeen = seen;
  page.__pageErrors = pageErrors;
  return page;
}

/** The app is up once the top bar names a scene (or a failure toast is showing). No debug API needed. */
async function waitForApp(page, timeoutMs = 60000) {
  try {
    await page.waitForFunction(
      () => {
        const name = document.querySelector('.dl-scene-name');
        const toast = document.querySelector('.dl-toast-msg');
        return (name && name.textContent.trim().length > 0) || (toast && toast.textContent.trim().length > 0);
      },
      null,
      { timeout: timeoutMs },
    );
  } catch {
    return false;
  }
  await page.waitForTimeout(1200);
  return true;
}

/**
 * Which elements currently show `needle`? Returned with each spoof failure so the fix has an address, not just a
 * verdict: the element's tag/class and the text around the match.
 */
async function locateText(page, needles) {
  return page.evaluate((list) => {
    const hits = [];
    const describe = (el) =>
      `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;
    for (const el of document.querySelectorAll('*')) {
      if (el.children.length) continue; // leaf elements only: otherwise every ancestor matches too
      const text = el.textContent || '';
      for (const n of list) {
        if (text.includes(n)) hits.push({ needle: n, where: describe(el), text: text.slice(0, 160) });
      }
      for (const a of el.attributes) {
        for (const n of list) {
          if (String(a.value).includes(n)) hits.push({ needle: n, where: `${describe(el)}[${a.name}]`, text: String(a.value).slice(0, 160) });
        }
      }
    }
    return hits.slice(0, 8);
  }, needles);
}

/**
 * Everything the user can read: rendered text plus every attribute value (a payload can hide in a title= tooltip).
 * Deliberately NOT location.search — the address bar still holds whatever the attacker's link said, which is not
 * the app rendering it. Whether the app *rewrites* the address bar is checked separately, in SPOOF-PRESET-LOADED.
 */
async function visibleText(page) {
  return page.evaluate(() => {
    const parts = [document.body.innerText || ''];
    for (const el of document.querySelectorAll('*')) {
      for (const a of el.attributes) parts.push(a.value);
    }
    parts.push(document.title);
    return parts.join('\n');
  });
}

async function tripwires(page) {
  return page.evaluate(() => ({
    pwned: window.__pwned ?? null,
    injectedImgs: document.querySelectorAll('img[src="x"], img[onerror]').length,
    injectedScripts: [...document.querySelectorAll('script')].filter((s) => !s.src && /__pwned/.test(s.textContent || '')).length,
    iframes: document.querySelectorAll('iframe').length,
    csp: window.__cspViolations ?? [],
  }));
}

/** Fulfil a route with a body, optionally gzipped and/or with a forged Content-Length. */
/** A flat 20 m elevation tile as the 3DEP exportImage call returns it: little-endian, uncompressed float32 TIFF. */
function flatTiff(size) {
  const [w, h] = String(size ?? '64,64').split(',').map((v) => Math.max(2, Math.min(2048, Number(v) || 64)));
  const entries = [[256, 4, w], [257, 4, h], [258, 3, 32], [259, 3, 1], [262, 3, 1], [273, 4, 0], [277, 3, 1], [278, 4, h], [279, 4, w * h * 4], [284, 3, 1], [339, 3, 3]];
  const ifd = 2 + entries.length * 12 + 4;
  const dataOff = 8 + ifd + ((4 - ((8 + ifd) % 4)) % 4);
  entries[5][2] = dataOff;
  const buf = Buffer.alloc(dataOff + w * h * 4);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, value], i) => {
    const o = 10 + i * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(1, o + 4);
    if (type === 3) buf.writeUInt16LE(value, o + 8);
    else buf.writeUInt32LE(value, o + 8);
  });
  for (let k = 0; k < w * h; k++) buf.writeFloatLE(20, dataOff + k * 4);
  return buf;
}

function fulfilJSON(route, obj, opts = {}) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
  let body = Buffer.from(text, 'utf8');
  if (opts.gzip) {
    body = zlib.gzipSync(body);
    headers['content-encoding'] = 'gzip';
  }
  if (opts.contentLength) headers['content-length'] = String(opts.contentLength);
  return route.fulfill({ status: 200, headers, body });
}

// ── the HTTP job API (`deluge serve`, src/cli/server.ts) ────────────────────────────────────────
/**
 * API-* cases: the batch server as a separate process on a free loopback port, with a bearer token, a data directory
 * seeded with one finished job and a secret file next to the jobs. No GPU is needed: every case is refused before a
 * job would run (the job used for downloads is the seeded one).
 */
const DELUGE_BIN = path.join(ROOT, 'bin', 'deluge.mjs');
const API_TOKEN = 'security-suite-token-0123456789abcdef';
const API_MARKERS = ['EVACUATE', '555-0100', '<img', 'onerror', '__pwned', 'TOP-SECRET-DELUGE'];

function apiRequest(port, method, p, { body, headers = {}, token = API_TOKEN } = {}) {
  return new Promise((resolve) => {
    const h = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers };
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, text: '' }));
    });
    // A refused oversized body may reset the connection before the client has finished writing: that is a refusal too.
    req.on('error', (e) => resolve({ status: 0, headers: {}, text: '', error: e.code ?? String(e) }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Start `deluge serve`; resolves with the child and its port once it prints its address (or with its exit code). */
async function startApi(args, env = {}) {
  const child = spawn(process.execPath, [DELUGE_BIN, 'serve', ...args], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...env }, detached: process.platform !== 'win32' });
  let err = '';
  child.stderr.on('data', (c) => (err += c));
  for (let i = 0; i < 600; i++) {
    const m = /listening on http:\/\/([^\s]+):(\d+)/.exec(err);
    if (m) return { child, host: m[1], port: Number(m[2]), stderr: () => err };
    if (child.exitCode !== null) return { child, host: null, port: null, code: child.exitCode, stderr: () => err };
    await sleep(100);
  }
  killTree(child);
  throw new Error(`deluge serve never came up: ${err.slice(0, 300)}`);
}

async function apiCases() {
  console.log('\nHTTP job API (deluge serve)');
  const dataDir = path.join(OUT_DIR, 'api-data');
  fs.rmSync(dataDir, { recursive: true, force: true });
  const jobId = `job_${'5ec0'.repeat(6)}`;
  const jobDir = path.join(dataDir, 'jobs', jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({ id: jobId, kind: 'run', status: 'succeeded', createdAt: now, startedAt: now, finishedAt: now, request: { preset: 'houston' }, command: ['deluge', 'run', '--preset', 'houston'], engine: { version: 'seeded', commit: null, gpu: null }, files: ['summary.json'], error: null, idempotencyKey: null, requestHash: 'x' }));
  fs.writeFileSync(path.join(jobDir, 'summary.json'), '{"tool":"deluge","seeded":true}\n');
  fs.writeFileSync(path.join(dataDir, 'secret.txt'), 'TOP-SECRET-DELUGE');
  fs.writeFileSync(path.join(dataDir, 'jobs', 'secret.txt'), 'TOP-SECRET-DELUGE');

  if (shouldRun('API-BIND')) {
    const open = await startApi(['--host', '0.0.0.0', '--port', '0', '--data-dir', path.join(OUT_DIR, 'api-bind')], { DELUGE_API_TOKEN: '' });
    if (open.child.exitCode === null) await once(open.child, 'exit');
    const refused = open.child.exitCode === 2 && open.port === null && /token is required/.test(open.stderr());
    killTree(open.child);
    record('API-BIND', 'api', 'serve refuses a non-loopback address without a token', refused ? 'pass' : 'fail', refused ? '--host 0.0.0.0 without a token: exit 2' : `exit ${open.child.exitCode}: ${open.stderr().slice(0, 120)}`);
  }

  const api = await startApi(['--port', '0', '--data-dir', dataDir], { DELUGE_API_TOKEN: API_TOKEN });
  try {
    if (api.port === null) throw new Error(`deluge serve exited (${api.code}): ${api.stderr().slice(0, 300)}`);
    const port = api.port;
    if (shouldRun('API-BIND')) record('API-BIND-DEFAULT', 'api', 'the default bind is loopback', api.host === '127.0.0.1' ? 'pass' : 'fail', `listening on ${api.host}`);

    if (shouldRun('API-AUTH')) {
      const tries = [
        ['no token', await apiRequest(port, 'GET', '/v1/presets', { token: null })],
        ['wrong token', await apiRequest(port, 'GET', '/v1/presets', { token: 'security-suite-token-0123456789abcdeX' })],
        ['Basic scheme', await apiRequest(port, 'GET', '/v1/presets', { token: null, headers: { authorization: `Basic ${API_TOKEN}` } })],
        ['POST, no token', await apiRequest(port, 'POST', '/v1/runs', { token: null, body: '{"preset":"houston"}' })],
        ['download, no token', await apiRequest(port, 'GET', `/v1/jobs/${jobId}/results/summary.json`, { token: null })],
        ['DELETE, no token', await apiRequest(port, 'DELETE', `/v1/jobs/${jobId}`, { token: null })],
      ];
      const ok = await apiRequest(port, 'GET', '/v1/presets');
      const bad = tries.filter(([, r]) => r.status !== 401);
      record('API-AUTH', 'api', 'bearer token required on every endpoint but /v1/health', !bad.length && ok.status === 200 ? 'pass' : 'fail', bad.length ? bad.map(([w, r]) => `${w} → ${r.status}`).join(', ') : `${tries.length} refusals (401), the right token → ${ok.status}`);
    }

    if (shouldRun('API-HOST')) {
      const r = await apiRequest(port, 'GET', '/v1/presets', { headers: { host: `rebound.attacker.example:${port}` } });
      const pre = await apiRequest(port, 'OPTIONS', '/v1/runs', { token: null, headers: { origin: 'https://attacker.example', 'access-control-request-method': 'POST' } });
      const form = await apiRequest(port, 'POST', '/v1/runs', { body: '{"preset":"houston"}', headers: { 'content-type': 'text/plain' } });
      const ok = r.status === 403 && !pre.headers['access-control-allow-origin'] && form.status === 415;
      record('API-HOST', 'api', 'DNS rebinding and cross-site posts refused (Host check, no CORS, JSON only)', ok ? 'pass' : 'fail', `foreign Host → ${r.status}; preflight ACAO: ${pre.headers['access-control-allow-origin'] ?? 'none'}; text/plain POST → ${form.status}`);
    }

    if (shouldRun('API-TRAVERSAL')) {
      const paths = [
        `/v1/jobs/${jobId}/results/job.json`,
        `/v1/jobs/${jobId}/results/../../secret.txt`,
        `/v1/jobs/${jobId}/results/..%2f..%2fsecret.txt`,
        `/v1/jobs/${jobId}/results/%2e%2e%2f%2e%2e%2fsecret.txt`,
        `/v1/jobs/${jobId}/results/%2e%2e/%2e%2e/secret.txt`,
        `/v1/jobs/${jobId}/results/..%5c..%5csecret.txt`,
        `/v1/jobs/${jobId}/results/..\\..\\secret.txt`,
        `/v1/jobs/${jobId}/results/summary.json%00`,
        `/v1/jobs/${jobId}/results/secret.txt`,
        `/v1/jobs/${jobId}/files/..%2fsecret.txt`,
        `/v1/jobs/..%2fsecret.txt/results/summary.json`,
        `/v1/jobs/${jobId}/..%2f..%2fsecret.txt`,
        '/v1/jobs/secret.txt',
        '/v1/../secret.txt',
        '/../secret.txt',
        `/v1/jobs/${jobId}/results/max_depth_m.tif`,
      ];
      const leaks = [];
      for (const p of paths) {
        const r = await apiRequest(port, 'GET', p);
        if (r.status !== 404 || r.text.includes('TOP-SECRET') || r.text.includes('requestHash')) leaks.push(`${p} → ${r.status}`);
      }
      const good = await apiRequest(port, 'GET', `/v1/jobs/${jobId}/results/summary.json`);
      const ok = !leaks.length && good.status === 200 && good.text.includes('"seeded":true');
      record('API-TRAVERSAL', 'api', 'result downloads cannot leave the job directory', ok ? 'pass' : 'fail', leaks.length ? leaks.join('; ') : `${paths.length} traversal paths → 404; the job's own file → ${good.status}`);
    }

    if (shouldRun('API-BODY-CAP')) {
      const t0 = Date.now();
      const big = await apiRequest(port, 'POST', '/v1/runs', { body: JSON.stringify({ preset: 'houston', pad: 'x'.repeat(2 * 1024 * 1024) }) });
      const huge = await apiRequest(port, 'POST', '/v1/portfolio-assessments', { body: JSON.stringify({ preset: 'houston', assetsCsv: 'x'.repeat(13 * 1024 * 1024) }) });
      // Streamed with no Content-Length (chunked), so the cap must hold while reading, not only on the header.
      const chunked = await new Promise((resolve) => {
        const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/runs', headers: { 'content-type': 'application/json', authorization: `Bearer ${API_TOKEN}`, 'transfer-encoding': 'chunked' } }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
          res.on('error', () => resolve(res.statusCode));
        });
        req.on('error', () => resolve(0));
        const piece = Buffer.alloc(64 * 1024, 0x20);
        let sent = 0;
        const pump = () => {
          while (sent < 4 * 1024 * 1024) {
            sent += piece.length;
            if (!req.write(piece)) return req.once('drain', pump);
          }
          req.end();
        };
        pump();
      });
      const rows = `asset_id,lat,lon\n${Array.from({ length: 5001 }, (_, i) => `A${i},29.77,-95.38`).join('\n')}\n`;
      const many = await apiRequest(port, 'POST', '/v1/portfolio-assessments', { body: JSON.stringify({ preset: 'houston', assetsCsv: rows }) });
      const alive = await apiRequest(port, 'GET', '/v1/health', { token: null });
      const refused = (s) => s === 413 || s === 0;
      const ok = refused(big.status) && refused(huge.status) && refused(chunked) && many.status === 400 && alive.status === 200;
      record('API-BODY-CAP', 'api', 'oversized bodies (declared, streamed) and CSVs over 5,000 rows are refused; the server lives', ok ? 'pass' : 'fail', `2 MB run → ${big.status || big.error}; 13 MB portfolio → ${huge.status || huge.error}; 4 MB chunked → ${chunked || 'reset'}; 5,001 rows → ${many.status}; health → ${alive.status} (${Date.now() - t0} ms)`);
    }

    if (shouldRun('API-ECHO')) {
      const hostile = `${XSS_PAYLOADS[0]} ${SPOOF_NAME}`;
      const bodies = [
        ['/v1/runs', { preset: hostile }],
        ['/v1/runs', { preset: 'pittsburgh', scenario: { level: hostile } }],
        ['/v1/runs', { preset: 'houston', scenario: { climate: { horizon: hostile } } }],
        ['/v1/runs', { preset: 'houston', [hostile]: 1 }],
        ['/v1/runs', { preset: 'houston', callbackUrl: 'http://169.254.169.254/latest/meta-data/' }],
        ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0, use: hostile } }],
        ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0, name: SPOOF_BIDI } }],
        ['/v1/site-checks', { preset: 'pittsburgh', site: { lat: 40.44, lon: -80.0 }, sweep: { levels: [hostile] } }],
        ['/v1/portfolio-assessments', { preset: 'houston', assetsCsv: `name,lat\n${hostile},1\n` }],
        ['/v1/portfolio-assessments', { preset: 'houston', assetsCsv: `asset_id,lat,lon\n${hostile},x,y\n` }],
      ];
      const echoed = [];
      let n400 = 0;
      for (const [p, b] of bodies) {
        const r = await apiRequest(port, 'POST', p, { body: JSON.stringify(b) });
        if (r.status === 400) n400++;
        const hit = API_MARKERS.concat(SPOOF_MARKERS).filter((m) => r.text.includes(m));
        if (hit.length || r.status !== 400) echoed.push(`${p} → ${r.status}${hit.length ? ` echoed ${hit.join(',')}` : ''}`);
      }
      const key = await apiRequest(port, 'POST', '/v1/runs', { body: '{"preset":"houston"}', headers: { 'idempotency-key': SPOOF_NAME.replace(/ /g, '_').repeat(8) } });
      if (key.status !== 400 || API_MARKERS.some((m) => key.text.includes(m))) echoed.push(`Idempotency-Key → ${key.status}`);
      else n400++;
      const jobs = await apiRequest(port, 'GET', '/v1/jobs');
      const held = (JSON.parse(jobs.text || '{"jobs":[]}').jobs ?? []).length;
      record('API-ECHO', 'api', 'hostile requests: 400 with fixed sentences, nothing echoed, nothing queued', !echoed.length && held === 1 ? 'pass' : 'fail', echoed.length ? echoed.join('; ') : `${n400} refusals, no input in any response; jobs held: ${held} (the seeded one)`);
    }
  } finally {
    killTree(api.child);
    if (api.child.exitCode === null) await Promise.race([once(api.child, 'exit'), sleep(5000)]);
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.join(OUT_DIR, 'api-bind'), { recursive: true, force: true });
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
console.log('\n=== Deluge security regression suite ===');
console.log(`mode    : ${QUICK ? 'quick' : 'full'}${STRICT ? ' · STRICT (pending counts as failure)' : ''}`);

let server = null;
let baseUrl = EXTERNAL_URL;
const distDir = path.join(OUT_DIR, 'dist');
let browser = null;
try {
  if (!baseUrl) {
    const s = await buildAndServe(distDir, PORT, path.join(OUT_DIR, 'server.log'));
    server = s.server;
    baseUrl = s.url;
  }
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  console.log(`target  : ${baseUrl}\n`);

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Static checks on the built artifact (SEC-02, SEC-07)
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  console.log('Built artifact');
  const haveDist = !EXTERNAL_URL && fs.existsSync(distDir);
  const distFiles = [];
  if (haveDist) {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else distFiles.push(p);
      }
    };
    walk(distDir);
  }
  const textFiles = distFiles.filter((f) => /\.(js|css|html|json|txt|map)$/.test(f));
  const readText = (f) => fs.readFileSync(f, 'utf8');

  if (shouldRun('CSP-META')) {
    if (!haveDist) record('CSP-META', 'SEC-02', 'CSP meta in built index.html', 'skip', 'no local dist (--url run)');
    else {
      const html = readText(path.join(distDir, 'index.html'));
      const m = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html);
      const required = ["default-src 'none'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'"];
      const missing = m ? required.filter((r) => !m[1].includes(r)) : required;
      const unsafe = m ? ["'unsafe-eval'", "'wasm-unsafe-eval'"].filter((u) => m[1].includes(u)) : [];
      // A meta CSP only governs what follows it, so it has to precede the first script tag.
      const beforeScript = m ? html.indexOf(m[0]) < html.indexOf('<script') : false;
      const ok = !!m && missing.length === 0 && unsafe.length === 0 && beforeScript;
      record(
        'CSP-META',
        'SEC-02',
        'CSP present, restrictive, before the first script',
        ok ? 'pass' : 'fail',
        !m ? 'no CSP meta found' : [missing.length ? `missing ${missing.join(', ')}` : '', unsafe.length ? `allows ${unsafe.join(', ')}` : '', beforeScript ? '' : 'meta comes after a <script>'].filter(Boolean).join('; ') || `${m[1].split(';').length} directives`,
        m ? { policy: m[1] } : null,
      );
    }
  }

  if (shouldRun('DIST-SOURCEMAPS')) {
    if (!haveDist) record('DIST-SOURCEMAPS', 'SEC-07', 'no source maps in dist', 'skip', 'no local dist (--url run)');
    else {
      const maps = distFiles.filter((f) => f.endsWith('.map')).map((f) => path.relative(distDir, f));
      const refs = textFiles.filter((f) => /sourceMappingURL/.test(readText(f))).map((f) => path.relative(distDir, f));
      record('DIST-SOURCEMAPS', 'SEC-07', 'no source maps or sourceMappingURL', maps.length || refs.length ? 'fail' : 'pass', maps.length || refs.length ? `${maps.concat(refs).join(', ')}` : `${distFiles.length} files clean`);
    }
  }

  if (shouldRun('DIST-PATHS')) {
    if (!haveDist) record('DIST-PATHS', 'SEC-07', 'no local filesystem paths in dist', 'skip', 'no local dist (--url run)');
    else {
      const home = process.env.HOME || '/Users';
      const leaks = [];
      for (const f of textFiles) {
        const t = readText(f);
        for (const needle of [ROOT, home, '/Users/', '/home/']) {
          if (t.includes(needle)) leaks.push(`${path.relative(distDir, f)} contains ${needle}`);
        }
      }
      record('DIST-PATHS', 'SEC-07', 'no build-machine paths leaked', leaks.length ? 'fail' : 'pass', leaks.slice(0, 4).join('; ') || `${textFiles.length} text files clean`);
    }
  }

  if (shouldRun('DIST-DEBUG')) {
    if (!haveDist) record('DIST-DEBUG', 'SEC-07', 'no debug surfaces in the bundle', 'skip', 'no local dist (--url run)');
    else {
      const hits = [];
      for (const f of textFiles.filter((f) => f.endsWith('.js'))) {
        const t = readText(f);
        if (t.includes('__deluge') || t.includes('__delugeUI')) hits.push(path.relative(distDir, f));
      }
      const chunk = distFiles.filter((f) => /debugApi/i.test(path.basename(f))).map((f) => path.relative(distDir, f));
      const ok = hits.length === 0 && chunk.length === 0;
      // SEC-07's fix is the DELUGE_DEBUG_API build gate in vite.config.ts. If it is ever reverted, this goes red.
      record('DIST-DEBUG', 'SEC-07', 'window.__deluge compiled out of the release build', ok ? 'pass' : 'fail', ok ? 'no debug symbols in any chunk' : `${hits.concat(chunk).join(', ')}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════════════════════════
  // Runtime checks
  // ══════════════════════════════════════════════════════════════════════════════════════════════
  browser = await chromium.launch({
    headless: argv.headed !== 'true',
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });

  // ── SEC-07 at runtime ────────────────────────────────────────────────────────────────────────
  console.log('\nRuntime: debug surfaces (SEC-07)');
  if (shouldRun('RUNTIME-DEBUG')) {
    const page = await newPage(browser);
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const surfaces = await page.evaluate(() => ({
      deluge: typeof window.__deluge,
      ui: typeof document.getElementById('ui-root')?.__delugeUI,
      keys: Object.keys(window).filter((k) => /deluge/i.test(k)),
    }));
    const ok = surfaces.deluge === 'undefined' && surfaces.ui === 'undefined' && surfaces.keys.length === 0;
    record('RUNTIME-DEBUG', 'SEC-07', 'no automation handles on a released page', ok ? 'pass' : 'fail', `window.__deluge: ${surfaces.deluge}, #ui-root.__delugeUI: ${surfaces.ui}${surfaces.keys.length ? `, extra: ${surfaces.keys.join(',')}` : ''}`);
    await page.close();
  }

  // ── SEC-01 content spoofing ──────────────────────────────────────────────────────────────────
  console.log('\nLink-parameter spoofing (SEC-01)');
  const spoofCases = [
    { id: 'SPOOF-NAME', query: `?live=40.4406,-79.9959,2&res=512&name=${encodeURIComponent(SPOOF_NAME)}`, what: '?name= sentence never becomes the scene title' },
    { id: 'SPOOF-BIDI', query: `?live=40.4406,-79.9959,2&res=512&name=${encodeURIComponent(SPOOF_BIDI)}`, what: '?name= bidi override is stripped' },
    { id: 'SPOOF-PRESET', query: `?preset=${encodeURIComponent(SPOOF_PRESET)}`, what: 'unknown ?preset= is rejected and never echoed' },
    { id: 'SPOOF-LIVE', query: `?live=${encodeURIComponent(SPOOF_LIVE)}`, what: 'invalid ?live= value is not echoed in a notice' },
    { id: 'SPOOF-STORY', query: `?story=${encodeURIComponent(SPOOF_PRESET)}`, what: 'unknown ?story= is rejected and never echoed (no story plays)' },
    // "Check any US address" (src/ui/useCaseDefs.ts parseAddressAt): the link carries numbers only; a ?name= or a
    // sentence in at= must never reach the page.
    { id: 'SPOOF-ADDRESS-NAME', query: `?usecase=address&at=29.7604,-95.3698&name=${encodeURIComponent(SPOOF_NAME)}`, what: '?usecase=address takes no name from the link' },
    { id: 'SPOOF-ADDRESS-AT', query: `?usecase=address&at=${encodeURIComponent(SPOOF_LIVE)}`, what: 'invalid ?at= value is not echoed in a notice' },
    // Dam breach and coastal surge (src/ui/damView.ts, src/ui/surgeView.ts): nid= is a strict NID id, breach= and
    // method= fixed words, at= numbers; none of them is ever shown.
    { id: 'SPOOF-DAM-NID', query: `?usecase=dam&nid=${encodeURIComponent(SPOOF_NAME)}&breach=${encodeURIComponent(SPOOF_PRESET)}`, what: '?usecase=dam: an invalid nid= / breach= is never echoed' },
    { id: 'SPOOF-SURGE-AT', query: `?usecase=surge&at=${encodeURIComponent(SPOOF_LIVE)}&name=${encodeURIComponent(SPOOF_NAME)}`, what: '?usecase=surge: an invalid at= and a ?name= are never echoed' },
  ];
  for (const c of spoofCases.filter((c) => shouldRun(c.id))) {
    const page = await newPage(browser); // every external host aborted: the lead's re-confirmation scenario
    await page.goto(`${baseUrl}${c.query}`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    // The notice for an ignored link parameter is transient; sample repeatedly so a short-lived echo is caught.
    let text = '';
    for (let i = 0; i < 12; i++) {
      text += '\n' + (await visibleText(page));
      await page.waitForTimeout(500);
    }
    const found = SPOOF_MARKERS.filter((m) => text.includes(m));
    // The toast that carries an attacker string is transient; if it has gone by now, locateText finds nothing and
    // the sampled text above is still the evidence.
    const where = found.length ? await locateText(page, found) : [];
    // U+202E must never survive into the DOM at all, wherever it came from.
    const bidi = /[‪-‮⁦-⁩]/.test(text);
    const sceneName = await page.evaluate(() => document.querySelector('.dl-scene-name')?.textContent?.trim() ?? '');
    const ok = found.length === 0 && !bidi;
    record(
      c.id,
      'SEC-01',
      c.what,
      ok ? 'pass' : 'fail',
      ok
        ? `scene title: "${sceneName}"`
        : `attacker text rendered: ${found.join(' | ')}${bidi ? ' + bidi control char in DOM' : ''} (title: "${sceneName}")${where.length ? ` — in ${where.map((w) => w.where).join(', ')}` : ''}`,
      { sceneName, found, bidi, where },
    );
    await page.close();
  }

  if (shouldRun('SPOOF-PRESET-LOADED')) {
    const page = await newPage(browser);
    await page.goto(`${baseUrl}?preset=${encodeURIComponent(SPOOF_PRESET)}`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    // "Loading…" already counts as a title for waitForApp; the address bar is only rewritten once the scene is in
    // (slower machines are still loading 1.2 s later), so wait for the load to finish before judging either.
    await page
      .waitForFunction(() => !/^Loading/.test(document.querySelector('.dl-scene-name')?.textContent?.trim() ?? 'Loading'), null, { timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(300);
    const { name, search } = await page.evaluate(() => ({
      name: document.querySelector('.dl-scene-name')?.textContent?.trim() ?? '',
      search: location.search,
    }));
    // The allowlist (src/data/presets.ts isPresetId) must substitute the default rather than fail or echo — and
    // writeSceneToUrl must rewrite the address bar to the scene that actually loaded, so a reload or a re-share
    // of the link no longer carries the spoof.
    const loaded = /pittsburgh/i.test(name);
    const barClean = !/OFFICIAL|555-0100|evacuate/i.test(decodeURIComponent(search));
    record('SPOOF-PRESET-LOADED', 'SEC-01', 'unknown preset falls back to the default, address bar rewritten', loaded && barClean ? 'pass' : 'fail', `scene title: "${name}", address bar: "${search}"`, { name, search });
    await page.close();
  }

  // ── XSS through hostile upstreams ────────────────────────────────────────────────────────────
  console.log('\nXSS through mocked upstreams (SEC-01/08/09/10)');

  // The real preset files are served by our own preview server; mutate copies of them.
  const realMeta = await (await fetch(`${baseUrl}presets/pittsburgh/meta.json`)).json();
  const realRoads = await (await fetch(`${baseUrl}presets/pittsburgh/roads.json`)).json();

  if (shouldRun('XSS-PRESET-META')) {
    const poisoned = structuredClone(realMeta);
    const p = XSS_PAYLOADS[0];
    poisoned.name = `${p} Pittsburgh`;
    poisoned.subtitle = XSS_PAYLOADS[1];
    poisoned.attribution = XSS_PAYLOADS[2];
    if (poisoned.scenario) {
      poisoned.scenario.description = XSS_PAYLOADS[0];
      if (poisoned.scenario.stage) poisoned.scenario.stage.label = XSS_PAYLOADS[1];
      if (poisoned.scenario.levee) poisoned.scenario.levee.name = XSS_PAYLOADS[0];
    }
    const page = await newPage(browser);
    await page.route('**/presets/pittsburgh/meta.json', (route) => fulfilJSON(route, poisoned));
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    await page.waitForTimeout(1500);
    const t = await tripwires(page);
    const ok = !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && t.iframes === 0;
    record('XSS-PRESET-META', 'SEC-08', 'hostile preset meta.json does not execute', ok ? 'pass' : 'fail', ok ? 'window.__pwned unset, no injected nodes' : JSON.stringify(t), t);
    await page.close();
  }

  if (shouldRun('XSS-ROADS')) {
    // Poison every name-ish string in the real road data, leaving the geometry intact so the layer still loads.
    const poisoned = structuredClone(realRoads);
    let poisonedCount = 0;
    const NAMEISH = /name|label|title|class|type|attribution/i;
    const walk = (node) => {
      if (Array.isArray(node)) {
        for (const v of node) walk(v);
      } else if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (typeof v === 'string' && NAMEISH.test(k)) {
            node[k] = XSS_PAYLOADS[poisonedCount % XSS_PAYLOADS.length];
            poisonedCount++;
          } else if (Array.isArray(v) && NAMEISH.test(k)) {
            // The compact road format keeps every street name in `names: string[]`, indexed by the edges.
            for (let i = 0; i < v.length; i++) {
              if (typeof v[i] === 'string') {
                v[i] = XSS_PAYLOADS[poisonedCount % XSS_PAYLOADS.length];
                poisonedCount++;
              } else walk(v[i]);
            }
          } else walk(v);
        }
      }
    };
    walk(poisoned);
    const page = await newPage(browser);
    await page.route('**/presets/pittsburgh/roads.json', (route) => fulfilJSON(route, poisoned));
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    await page.waitForTimeout(1500);
    const t = await tripwires(page);
    const clean = !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && t.iframes === 0;
    // A compact road format may carry no name-ish keys at all; then this case proved nothing and must say so
    // rather than report a green it did not earn.
    const status = !clean ? 'fail' : poisonedCount > 0 ? 'pass' : 'pending';
    record('XSS-ROADS', 'SEC-10', 'hostile road data does not execute', status, clean ? `${poisonedCount} poisoned fields, window.__pwned unset` : JSON.stringify(t), { poisonedCount, ...t });
    await page.close();
  }

  /** Open the location picker and search — the flow that renders Nominatim's answers. */
  async function searchFlow(page, query) {
    const opened = await page
      .getByRole('button', { name: /pick any|location|search/i })
      .first()
      .click({ timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!opened) return { opened: false };
    const input = page.locator('.dl-search-input');
    if (!(await input.count())) return { opened: true, typed: false };
    await input.fill(query);
    await page.waitForTimeout(2500);
    return { opened: true, typed: true };
  }

  if (shouldRun('XSS-NOMINATIM')) {
    const hostile = XSS_PAYLOADS.map((p, i) => ({
      place_id: i,
      display_name: `${p}, Pennsylvania, USA`,
      name: p,
      lat: '40.4406',
      lon: '-79.9959',
      type: p,
    }));
    const page = await newPage(browser, { 'nominatim.openstreetmap.org': (route) => fulfilJSON(route, hostile) });
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const flow = await searchFlow(page, 'pittsburgh');
    const t = await tripwires(page);
    const ok = !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && t.iframes === 0;
    record(
      'XSS-NOMINATIM',
      'SEC-09',
      'hostile geocoder results do not execute',
      flow.typed ? (ok ? 'pass' : 'fail') : ok ? 'pending' : 'fail',
      flow.typed ? (ok ? 'window.__pwned unset, no injected nodes' : JSON.stringify(t)) : 'search UI not reachable from the top bar — case not exercised',
      { ...flow, ...t },
    );
    await page.close();
  }

  /** Open "Check any US address" from the top bar and search — the second flow that renders Nominatim's answers. */
  async function addressSearchFlow(page, query) {
    const opened = await page
      .click('.dl-uc-btn', { timeout: 8000 })
      .then(() => page.click('[data-usecase="address"]', { timeout: 8000 }))
      .then(() => true)
      .catch(() => false);
    if (!opened) return { opened: false };
    const input = page.locator('[data-uc="address-input"]');
    if (!(await input.count())) return { opened: true, typed: false };
    await input.fill(query);
    await page.click('[data-uc="address-search"]').catch(() => {});
    await page.waitForTimeout(2500);
    return { opened: true, typed: true };
  }

  if (shouldRun('XSS-ADDRESS-GEOCODER')) {
    const hostile = XSS_PAYLOADS.map((p, i) => ({ place_id: i, display_name: `${p}, Houston, Texas`, lat: '29.7604', lon: '-95.3698', type: p }));
    const page = await newPage(browser, { 'nominatim.openstreetmap.org': (route) => fulfilJSON(route, hostile) });
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const flow = await addressSearchFlow(page, '1600 Smith St, Houston');
    const choices = await page.locator('[data-uc="address-choice"]').count();
    const t = await tripwires(page);
    const ok = !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && t.iframes === 0;
    record(
      'XSS-ADDRESS-GEOCODER',
      'SEC-09',
      'hostile geocoder results in "Check an address" do not execute',
      flow.typed ? (ok ? 'pass' : 'fail') : ok ? 'pending' : 'fail',
      flow.typed ? (ok ? `${choices} results rendered as text, window.__pwned unset` : JSON.stringify(t)) : 'address search not reachable — case not exercised',
      { ...flow, choices, ...t },
    );
    await page.close();
  }

  if (shouldRun('PRIVACY-ADDRESS-SHARE')) {
    // "Check an address" promises that links carry the coordinates, never the address. The site it drops is named
    // after the street address on screen; its Share link (?sites=) must leave that name out. Nominatim answers with a
    // street address, 3DEP with a flat 5 km tile (a tiny float32 TIFF); every other host is refused, as offline.
    const page = await newPage(browser, {
      'nominatim.openstreetmap.org': (route) => fulfilJSON(route, [{ place_id: 1, display_name: '1600, Smith Street, Downtown, Houston, Harris County, Texas, 77002, United States', lat: '29.7604', lon: '-95.3698', class: 'place', type: 'house' }]),
      'elevation.nationalmap.gov': (route, url) =>
        /\/exportImage/.test(url)
          ? route.fulfill({ status: 200, headers: { 'content-type': 'image/tiff', 'access-control-allow-origin': '*' }, body: flatTiff(new URL(url).searchParams.get('size')) })
          : fulfilJSON(route, {}),
    });
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const flow = await addressSearchFlow(page, '1600 Smith St, Houston');
    let link = null;
    let siteName = '';
    if (flow.typed && (await page.locator('[data-uc="address-choice"]').count())) {
      await page.click('[data-uc="address-choice"]');
      const placed = await page.waitForSelector('.dl-site-item', { timeout: 180000 }).then(() => true, () => false);
      if (placed) {
        siteName = (await page.locator('.dl-site-item').first().textContent()) ?? '';
        await page.click('[data-site="share-link"]').catch(() => {});
        await page.waitForTimeout(500);
        link = await page.evaluate(() => new URLSearchParams(location.search).get('sites'));
      }
    }
    const leaked = link !== null && /smith|1600/i.test(link);
    // Only a site named after the address on screen, and a link actually written, prove the case.
    const exercised = link !== null && /Smith/i.test(siteName);
    record(
      'PRIVACY-ADDRESS-SHARE',
      'SEC-01',
      'the Share link of an address-check site carries its coordinates, never the street address',
      leaked ? 'fail' : exercised ? 'pass' : 'pending',
      leaked ? `?sites= carries the address: ${link}` : exercised ? `site “${siteName.trim().slice(0, 40)}” shared as ${link}` : `flow not completed (${JSON.stringify(flow)}, link ${link})`,
      { ...flow, link, siteName },
    );
    await page.close();
  }

  // ── Saved projects: ?project= links and project files (src/project) ──────────────────────────
  console.log('\nSaved projects: ?project= links and .deluge.json files (SEC-01/03/08)');
  /** A project that passes the strict reader, with `text` in every name-ish field. */
  const hostileProject = (text) => ({
    format: 'deluge-project',
    version: 1,
    name: text,
    scene: { kind: 'preset', id: 'pittsburgh' },
    scenario: {
      stageOffset: 0,
      sim: { rainRate: 0 },
      sources: [{ id: 'ohio-stage', type: 'stage', gx: -275.13, gy: 276, radius: 308.08, level: 216.225, offsetScale: 0.98631, label: text }],
      storms: [],
      shelters: [{ name: text, gx: 600, gy: 500 }],
      evacStart: null,
    },
    edits: [{ op: 'wall', pts: [400, 500, 430, 488], h: 3, r: 2 }],
    sites: [{ name: text, lon: -80.0085, lat: 40.4425, occupancy: 'office', floors: 3 }],
    designs: [{ id: 'A', name: text, edits: [{ op: 'wall', pts: [400, 500, 430, 488], h: 3, r: 2 }], cost: { type: 'floodwall' } }],
  });
  const projectLink = (value) => `p1.${zlib.gzipSync(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)), { level: 9 }).toString('base64url')}`;
  /** Open the app on a ?project= link; sample what the page shows for a few seconds (a notice is transient). */
  async function openProjectLink(page, value) {
    await page.goto(`${baseUrl}?preset=pittsburgh&project=${value}`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    let text = '';
    for (let i = 0; i < 12; i++) {
      text += '\n' + (await visibleText(page));
      await page.waitForTimeout(500);
    }
    const applied = await page.evaluate(() => document.querySelectorAll('.dl-site-item').length);
    return { text, applied };
  }

  if (shouldRun('SPOOF-PROJECT-LINK')) {
    const page = await newPage(browser);
    const p = hostileProject(SPOOF_NAME);
    p.designs.push({ id: 'B', name: 'OFFICIAL NOTICE evacuate now', edits: [], cost: { type: 'earthen' } });
    p.sites.push({ name: SPOOF_BIDI, lon: -80.0, lat: 40.44, occupancy: 'office', floors: 3 });
    const { text, applied } = await openProjectLink(page, projectLink(p));
    const found = SPOOF_MARKERS.filter((m) => text.includes(m));
    const where = found.length ? await locateText(page, found) : [];
    const bidi = /[‪-‮⁦-⁩]/.test(text);
    const ok = found.length === 0 && !bidi;
    // A link that was never applied proved nothing: then the case is pending, not a pass.
    record('SPOOF-PROJECT-LINK', 'SEC-01', '?project= names (project, designs, sites, shelters, labels) never reach the page', !ok ? 'fail' : applied === 2 ? 'pass' : 'pending', ok ? `link applied (${applied} sites, named by the app); no attacker text` : `attacker text rendered: ${found.join(' | ')}${bidi ? ' + bidi' : ''}${where.length ? ` — in ${where.map((w) => w.where).join(', ')}` : ''}`, { found, bidi, where, applied });
    await page.close();
  }

  if (shouldRun('XSS-PROJECT-LINK')) {
    const page = await newPage(browser);
    const p = hostileProject(XSS_PAYLOADS[0]);
    p.designs.push({ id: 'B', name: XSS_PAYLOADS[1], edits: [], cost: { type: 'earthen' } });
    p.scenario.shelters.push({ name: XSS_PAYLOADS[2], gx: 610, gy: 510 });
    const { applied } = await openProjectLink(page, projectLink(p));
    const t = await tripwires(page);
    const clean = !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && t.iframes === 0;
    record('XSS-PROJECT-LINK', 'SEC-08', 'hostile ?project= names do not execute', !clean ? 'fail' : applied ? 'pass' : 'pending', clean ? `link applied (${applied} site), window.__pwned unset` : JSON.stringify(t), { applied, ...t });
    await page.close();
  }

  if (shouldRun('SPOOF-PROJECT-POLLUTE')) {
    const page = await newPage(browser);
    const raw = `{"format":"deluge-project","version":1,"name":${JSON.stringify(SPOOF_NAME)},"__proto__":{"polluted":"EVACUATE NOW"},"constructor":{"prototype":{"polluted":1}}}`;
    const { text } = await openProjectLink(page, projectLink(raw));
    const polluted = await page.evaluate(() => ({}).polluted !== undefined || Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'));
    const found = SPOOF_MARKERS.filter((m) => text.includes(m));
    const refused = /reserved key/.test(text);
    record('SPOOF-PROJECT-POLLUTE', 'SEC-08', '__proto__ / constructor in a ?project= link: refused with a fixed sentence, no pollution', !polluted && !found.length && refused ? 'pass' : 'fail', `${refused ? 'fixed refusal shown' : 'no refusal notice'}; Object.prototype ${polluted ? 'POLLUTED' : 'clean'}${found.length ? `; echoed ${found.join(' | ')}` : ''}`);
    await page.close();
  }

  if (shouldRun('CAP-PROJECT-LINK-BOMB')) {
    // ~4 MB of zeros gzips into a link-sized value; the decoder must stop inflating at 256 KB.
    const value = projectLink(Buffer.alloc(4 * 1048576).toString('latin1'));
    const page = await newPage(browser);
    const fits = value.length <= 6000;
    const { text } = await openProjectLink(page, value);
    const refused = /could not be unpacked/.test(text);
    const alive = await page.evaluate(() => !!document.querySelector('.dl-scene-name')?.textContent);
    record('CAP-PROJECT-LINK-BOMB', 'SEC-03', 'a gzip-bomb ?project= link (4 MB inflated) is refused', fits && refused && alive ? 'pass' : fits ? 'fail' : 'skip', `${value.length} characters; ${refused ? 'refused with the fixed sentence' : 'no refusal'}${alive ? ', app alive' : ', app dead'}`);
    await page.close();
  }

  if (shouldRun('CAP-PROJECT-LINK-BRUSH')) {
    // ~1.5 kB: 4,000 digs with a 99,999-cell radius. Replayed, each would visit the whole grid on the CPU mirror (~27 ms
    // at 1024²) — minutes of a frozen tab, again in every design comparison. The reader clamps the radius and refuses
    // the link past its replay budget (src/project/format.ts maxLinkBrushCells). DOM only: the app answers, the fixed
    // refusal is shown, and nothing of the link (its site) is on screen.
    const p = hostileProject('x');
    p.grid = { nx: 1024, ny: 1024, cellSize: 7.8125 };
    p.edits = Array.from({ length: 4000 }, (_, i) => ({ op: 'terrain', at: [500 + (i % 9), 512], r: 99999, d: -1 }));
    const value = projectLink(JSON.stringify(p));
    const page = await newPage(browser);
    const t0 = Date.now();
    const { text, applied } = await openProjectLink(page, value);
    const ping0 = Date.now();
    const alive = await page.evaluate(() => !!document.querySelector('.dl-scene-name')?.textContent).catch(() => false);
    const pingMs = Date.now() - ping0;
    const refused = /cover more of the map/.test(text);
    record('CAP-PROJECT-LINK-BRUSH', 'SEC-03', 'a ?project= link of thousands of map-sized brushes is refused, not replayed', value.length <= 6000 && refused && alive && !applied && pingMs < 2000 ? 'pass' : value.length <= 6000 ? 'fail' : 'skip', `${value.length} characters; ${refused ? 'refused with the fixed sentence' : 'no refusal'}${applied ? ', link APPLIED' : ''}; page answered in ${pingMs} ms (${((Date.now() - t0) / 1000).toFixed(1)} s with the load)${alive ? '' : ', app dead'}`);
    await page.close();
  }

  if (shouldRun('PROJECT-LINK-TERRAIN-ASK')) {
    // A link's digging is someone else's: its walls and sites open at once, the ground only after the user says yes —
    // on a card in the Project section, never a browser dialog.
    const p = hostileProject('x');
    p.grid = { nx: 1024, ny: 1024, cellSize: 7.8125 };
    p.edits = [...p.edits, { op: 'terrain', at: [600, 420], r: 6, d: -8 }];
    const page = await newPage(browser);
    const dialogs = [];
    page.on('dialog', (d) => {
      dialogs.push(d.type());
      void d.dismiss().catch(() => {});
    });
    const { applied } = await openProjectLink(page, projectLink(p));
    const card = await page.evaluate(() => {
      const el = document.querySelector('[data-project="link-terrain"]');
      return !!el && !el.hidden;
    });
    await page.evaluate(() => {
      const sec = document.querySelector('[data-section="project"]');
      if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head')?.click();
      document.querySelector('[data-project="link-terrain-apply"]')?.click();
    });
    await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ status: document.querySelector('[data-project="status"]')?.textContent ?? '', card: !document.querySelector('[data-project="link-terrain"]')?.hidden }));
    const yes = /^Applied the link.s 1 terrain edit/.test(after.status) && !after.card;
    record('PROJECT-LINK-TERRAIN-ASK', 'SEC-08', 'a ?project= link’s terrain edits wait for the user’s yes on an in-app card (no browser dialog)', !applied ? 'pending' : card && yes && !dialogs.length ? 'pass' : 'fail', `link applied (${applied} site); card ${card ? 'shown' : 'MISSING'}; after the yes: ${after.status.slice(0, 60) || '(no status)'}${dialogs.length ? `; browser dialogs: ${dialogs.join(', ')}` : ''}`);
    await page.close();
  }

  if (shouldRun('PROJECT-FILE-HOSTILE')) {
    const page = await newPage(browser);
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    await page.evaluate(() => {
      const sec = document.querySelector('[data-section="project"]');
      if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head')?.click();
    });
    const files = [
      { name: 'xss.deluge.json', body: JSON.stringify(hostileProject(XSS_PAYLOADS[0])), expect: /^Opened/ },
      { name: 'proto.deluge.json', body: '{"format":"deluge-project","version":1,"__proto__":{"polluted":1},"scene":{"kind":"preset","id":"pittsburgh"}}', expect: /reserved key/ },
      { name: 'deep.deluge.json', body: `{"format":"deluge-project","version":1,"x":${'['.repeat(100000)}${']'.repeat(100000)}}`, expect: /nested too deeply/ },
      { name: 'huge.deluge.json', body: `{"format":"deluge-project","version":1,"pad":"${'A'.repeat(3_100_000)}"}`, expect: /too large/ },
      { name: 'inf.deluge.json', body: JSON.stringify(hostileProject('x')).replace('"stageOffset":0', '"stageOffset":1e400'), expect: /damaged or was edited/ },
      { name: 'html.deluge.json', body: '<html><script>window.__pwned=1</script></html>', expect: /not valid JSON/ },
      { name: 'newer.deluge.json', body: JSON.stringify({ ...hostileProject('x'), version: 99 }), expect: /newer version/ },
    ];
    const outcomes = [];
    for (const f of files) {
      await page.setInputFiles('[data-project="file"]', { name: f.name, mimeType: 'application/json', buffer: Buffer.from(f.body) });
      await page.waitForFunction((prev) => {
        const s = document.querySelector('[data-project="status"]')?.textContent ?? '';
        return s && !/^Opening/.test(s) && s !== prev;
      }, outcomes.at(-1)?.status ?? '', { timeout: 30000 }).catch(() => {});
      const status = await page.evaluate(() => document.querySelector('[data-project="status"]')?.textContent ?? '');
      outcomes.push({ file: f.name, status, ok: f.expect.test(status) });
    }
    const t = await tripwires(page);
    const polluted = await page.evaluate(() => ({}).polluted !== undefined);
    const clean = !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && t.iframes === 0 && !polluted;
    const wrong = outcomes.filter((o) => !o.ok);
    record('PROJECT-FILE-HOSTILE', 'SEC-08', 'hostile .deluge.json files: refused with fixed sentences, names only ever text', clean && !wrong.length ? 'pass' : 'fail', clean ? (wrong.length ? `unexpected: ${wrong.map((o) => `${o.file}: ${o.status.slice(0, 60)}`).join('; ')}` : `${outcomes.length} files handled, window.__pwned unset, no pollution`) : JSON.stringify({ ...t, polluted }), { outcomes, ...t });
    await page.close();
  }

  // ── SEC-03 response byte caps ────────────────────────────────────────────────────────────────
  console.log('\nResponse byte caps (SEC-03)');
  /**
   * Nominatim's search is capped at 1 MB (src/ui/locationPicker.ts). Each variant puts a unique marker in the FIRST
   * result, so the marker can only reach the screen if the oversized body was read and parsed: seeing it is the
   * failure. Memory is sampled too — a cap that only throws after buffering has not protected anything: the live heap
   * after a forced GC, right before and right after the search (liveHeap below). That catches a body that is kept
   * (the string, or what parsing it builds, stays live: at least its own size); a body read in full and then dropped is
   * the streaming cap's job, tested chunk by chunk in tests/data/hostileUpstream.test.ts.
   */
  const capCases = [
    {
      id: 'CAP-OVERSIZE',
      what: 'a 4 MB body against a 1 MB cap is refused',
      marker: 'CAPMARKERALPHA',
      build: (marker) => {
        const pad = 'x'.repeat(2000);
        const rows = [{ place_id: 1, display_name: `${marker}, Pennsylvania`, lat: '40.44', lon: '-79.99' }];
        for (let i = 0; i < 2000; i++) rows.push({ place_id: i + 2, display_name: `Filler ${pad}`, lat: '40.44', lon: '-79.99' });
        return { body: JSON.stringify(rows), opts: {} };
      },
    },
    {
      id: 'CAP-DECLARED',
      what: 'a forged Content-Length over the cap is refused up front',
      marker: 'CAPMARKERBETA',
      build: (marker) => ({
        body: JSON.stringify([{ place_id: 1, display_name: `${marker}, Pennsylvania`, lat: '40.44', lon: '-79.99' }]),
        opts: { contentLength: 900 * 1024 * 1024 },
      }),
    },
    {
      id: 'CAP-GZIPBOMB',
      what: 'a gzip bomb (12 MB inflated, ~12 KB on the wire) is refused',
      marker: 'CAPMARKERGAMMA',
      build: (marker) => {
        const rows = [{ place_id: 1, display_name: `${marker}, Pennsylvania`, lat: '40.44', lon: '-79.99' }];
        // Valid JSON that inflates far past the cap while staying tiny compressed.
        const filler = `,{"place_id":9,"display_name":"${'A'.repeat(100000)}","lat":"40.44","lon":"-79.99"}`;
        return { body: `[${JSON.stringify(rows[0])}${filler.repeat(120)}]`, opts: { gzip: true } };
      },
    },
  ];
  /**
   * Live JS heap after a forced full GC, bytes (Chromium DevTools protocol: HeapProfiler.collectGarbage, then
   * Runtime.getHeapUsage). performance.memory alone — what this check used to read — is the heap including garbage
   * not yet collected, coarsened by Chromium: on Windows even the 0-byte CAP-DECLARED case read +44–164 MB, which is
   * the running simulation's per-readback allocations waiting for the next GC, not anything the response did.
   * Falls back to that (marked not forced) where CDP is unavailable.
   */
  async function liveHeap(page) {
    try {
      const cdp = await page.context().newCDPSession(page);
      try {
        await cdp.send('HeapProfiler.collectGarbage');
        await cdp.send('HeapProfiler.collectGarbage'); // a second pass frees what the first one's finalizers released
        const { usedSize } = await cdp.send('Runtime.getHeapUsage');
        return { bytes: usedSize, forced: true };
      } finally {
        await cdp.detach().catch(() => {});
      }
    } catch {
      return { bytes: await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null), forced: false };
    }
  }
  for (const c of capCases.filter((c) => shouldRun(c.id))) {
    const { body, opts } = c.build(c.marker);
    const wire = opts.gzip ? zlib.gzipSync(Buffer.from(body)).length : Buffer.byteLength(body);
    const page = await newPage(browser, {
      'nominatim.openstreetmap.org': (route) => fulfilJSON(route, body, opts),
    });
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    // Baseline on the same page right before the search, after a forced full GC (see liveHeap); and, for the report
    // only, the app's own drift over an idle stretch as long as the search, just before that (not subtracted: the app
    // does not drift at a steady rate, so taking it off could hide a kept body).
    const base0 = await liveHeap(page);
    const t0 = Date.now();
    await page.waitForTimeout(CAP_IDLE_MS);
    const base1 = await liveHeap(page);
    const idleMs = Date.now() - t0;
    const flow = await searchFlow(page, 'pittsburgh');
    const after = await liveHeap(page);
    const text = await visibleText(page);
    const alive = await page.evaluate(() => !!document.querySelector('.dl-scene-name'));
    const leaked = text.includes(c.marker);
    const payloadMB = Buffer.byteLength(body) / 1048576;
    const mb = (b) => +(b / 1048576).toFixed(1);
    const known = base0.bytes !== null && base1.bytes !== null && after.bytes !== null;
    const driftMB = known ? mb(base1.bytes - base0.bytes) : null;
    const growthMB = known ? mb(after.bytes - base1.bytes) : null;
    // Holding on to the oversized body — the raw string, or what parsing it builds — keeps at least its size live.
    // Measured after a full GC, the noise is ~1.5 MB (the app's own drift), so the bound can be a fraction of the
    // payload: a kept 4 MB body (3.9 MB live as the string alone, 7.8 MB with its parse, measured) cannot pass 3 + 1 MB.
    const limitMB = CAP_HEAP_SLACK_MB + 0.25 * payloadMB;
    const memoryOk = growthMB === null || !after.forced || growthMB < limitMB;
    const ok = !leaked && alive && memoryOk;
    const heapText = known
      ? after.forced
        ? `live heap +${growthMB} MB after GC (limit ${limitMB.toFixed(1)}; the app alone drifted ${driftMB >= 0 ? '+' : ''}${driftMB} MB over ${(idleMs / 1000).toFixed(1)} s idle)`
        : `heap +${growthMB} MB (GC could not be forced: not judged)`
      : 'heap not measurable';
    record(
      c.id,
      'SEC-03',
      c.what,
      flow.typed ? (ok ? 'pass' : 'fail') : 'pending',
      flow.typed
        ? `${payloadMB.toFixed(1)} MB payload (${(wire / 1024).toFixed(0)} KB on the wire), marker ${leaked ? 'RENDERED' : 'never rendered'}, ${heapText}, app ${alive ? 'alive' : 'DEAD'}`
        : 'search UI not reachable — case not exercised',
      { leaked, alive, growthMB, driftMB, limitMB, gcForced: after.forced, wireBytes: wire },
    );
    await page.close();
  }

  /**
   * The NOAA Atlas 14 grid (src/data/atlas14.ts) is fetched from this app's own origin, but a mirror, a proxy or a
   * cache can still hand back anything. Site check on Houston loads it; each variant must cost the rain ladder only:
   * the app stays up, nothing it sent is shown, and the heap does not keep the payload.
   */
  const atlasCases = [
    { id: 'CAP-ATLAS14-BOMB', what: 'a gzip-bomb Atlas 14 grid (64 MB inflated) is refused', body: () => zlib.gzipSync(Buffer.alloc(64 * 1048576), { level: 9 }), payloadMB: 64 },
    { id: 'CAP-ATLAS14-OVERSIZE', what: 'an oversized Atlas 14 grid (12 MB on the wire) is refused', body: () => Buffer.alloc(12 * 1048576, 7), payloadMB: 12 },
    {
      id: 'CAP-ATLAS14-HOSTILE',
      what: 'a hostile Atlas 14 grid (markup, wrong magic) is refused and never shown',
      body: () => Buffer.from(`DLA14PF1${XSS_PAYLOADS.join('')}${'\u0000'.repeat(64)}`, 'utf8'),
      payloadMB: 0,
    },
  ];
  for (const c of atlasCases.filter((c) => shouldRun(c.id))) {
    const body = c.body();
    const page = await newPage(browser);
    await page.route('**/atlas14/pf60m-pds.bin', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body }));
    await page.goto(`${baseUrl}?preset=houston`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const base = await liveHeap(page);
    const opened = await page
      .click('[data-section="site"] .dl-sec-head', { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (opened) {
      await page
        .waitForFunction(() => /could not be loaded/.test(document.querySelector('[data-site="rain-status"]')?.textContent ?? ''), null, { timeout: 30000 })
        .catch(() => {});
    }
    const statusText = opened ? await page.evaluate(() => document.querySelector('[data-site="rain-status"]')?.textContent ?? '') : '';
    const after = await liveHeap(page);
    const t = await tripwires(page);
    const alive = await page.evaluate(() => !!document.querySelector('.dl-scene-name'));
    const rainOffered = await page.evaluate(() => [...document.querySelectorAll('[data-site="ladder"] option')].some((o) => o.value === 'rain'));
    const growthMB = base.bytes !== null && after.bytes !== null ? +((after.bytes - base.bytes) / 1048576).toFixed(1) : null;
    const memoryOk = growthMB === null || !after.forced || growthMB < CAP_HEAP_SLACK_MB + 2.8 /* the decoded grid itself, when valid */;
    const ok = alive && !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && /could not be loaded/.test(statusText) && !rainOffered && memoryOk;
    record(
      c.id,
      'SEC-03',
      c.what,
      opened ? (ok ? 'pass' : 'fail') : 'pending',
      opened
        ? `${(body.length / 1048576).toFixed(2)} MB on the wire${c.payloadMB ? ` (${c.payloadMB} MB payload)` : ''}; rain ladder ${rainOffered ? 'OFFERED' : 'withheld'}; “${statusText.slice(0, 60)}”; live heap ${growthMB === null ? 'n/a' : `${growthMB >= 0 ? '+' : ''}${growthMB} MB`}; app ${alive ? 'alive' : 'DEAD'}`
        : 'Site check not reachable — case not exercised',
      { statusText, rainOffered, growthMB, alive, ...t },
    );
    await page.close();
  }

  /**
   * The dam index (src/dams/nidIndex.ts) and the NOAA tide-station table (src/surge/stations.ts) are same-origin files
   * too. Each hostile variant must cost only the dam search or the surge ladder: the app stays up, nothing it sent is
   * shown, and the heap does not keep the payload.
   */
  const damSurgeCases = [
    { id: 'CAP-NID-BOMB', route: '**/dams/nid-index.bin', what: 'a gzip-bomb dam index (64 MB inflated) is refused', body: () => zlib.gzipSync(Buffer.alloc(64 * 1048576), { level: 9 }), payloadMB: 64, view: 'dam' },
    { id: 'CAP-NID-OVERSIZE', route: '**/dams/nid-index.bin', what: 'an oversized dam index (12 MB on the wire) is refused', body: () => Buffer.alloc(12 * 1048576, 7), payloadMB: 12, view: 'dam' },
    { id: 'CAP-NID-HOSTILE', route: '**/dams/nid-index.bin', what: 'a hostile dam index (markup, right magic, lying header) is refused and never shown', body: () => Buffer.from(`DLNID001${XSS_PAYLOADS.join('')}`, 'utf8'), payloadMB: 0, view: 'dam' },
    { id: 'CAP-SURGE-OVERSIZE', route: '**/surge/ewl-stations.json', what: 'an oversized tide-station table (4 MB) is refused', body: () => Buffer.alloc(4 * 1048576, 0x20), payloadMB: 4, view: 'surge' },
    {
      id: 'CAP-SURGE-HOSTILE',
      route: '**/surge/ewl-stations.json',
      what: 'a hostile tide-station table (markup in names) is refused and never shown',
      body: () => Buffer.from(JSON.stringify({ format: 'deluge-ewl-1', aeps: [0.99, 0.5, 0.1, 0.02, 0.01], stations: XSS_PAYLOADS.map((p, i) => ({ id: `87255${String(i).padStart(2, '0')}`, name: p, lat: 26.6, lon: -81.9 })) }), 'utf8'),
      payloadMB: 0,
      view: 'surge',
    },
  ];
  for (const c of damSurgeCases.filter((c) => shouldRun(c.id))) {
    const body = c.body();
    const page = await newPage(browser);
    await page.route(c.route, (route) => route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body }));
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const base = await liveHeap(page);
    let opened = await page
      .click('.dl-uc-btn', { timeout: 8000 })
      .then(() => page.click(`[data-usecase="${c.view}"]`, { timeout: 8000 }))
      .then(() => true)
      .catch(() => false);
    let statusText = '';
    if (opened && c.view === 'dam') {
      await page.fill('[data-dam="input"]', 'Oroville').catch(() => (opened = false));
      await page.click('[data-dam="search"]').catch(() => (opened = false));
      await page.waitForFunction(() => /could not be loaded/.test(document.querySelector('[data-dam="status"]')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => {});
      statusText = await page.evaluate(() => document.querySelector('[data-dam="status"]')?.textContent ?? '');
    } else if (opened) {
      await page.fill('[data-surge="input"]', '26.6406, -81.8723').catch(() => (opened = false));
      await page.click('[data-surge="search"]').catch(() => (opened = false));
      await page.click('[data-surge="choice"]', { timeout: 8000 }).catch(() => (opened = false));
      await page.waitForFunction(() => /could not be loaded/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
      statusText = (await visibleText(page)).match(/[^\n]*could not be loaded[^\n]*/)?.[0] ?? '';
    }
    const after = await liveHeap(page);
    const t = await tripwires(page);
    const alive = await page.evaluate(() => !!document.querySelector('.dl-scene-name'));
    const shown = (await visibleText(page)).includes('onerror');
    const growthMB = base.bytes !== null && after.bytes !== null ? +((after.bytes - base.bytes) / 1048576).toFixed(1) : null;
    const memoryOk = growthMB === null || !after.forced || growthMB < CAP_HEAP_SLACK_MB + 4 /* the decoded index itself, when valid */;
    const ok = alive && !t.pwned && t.injectedImgs === 0 && t.injectedScripts === 0 && !shown && /could not be loaded/.test(statusText) && memoryOk;
    record(
      c.id,
      'SEC-03',
      c.what,
      opened ? (ok ? 'pass' : 'fail') : 'pending',
      opened
        ? `${(body.length / 1048576).toFixed(2)} MB on the wire${c.payloadMB ? ` (${c.payloadMB} MB payload)` : ''}; “${statusText.slice(0, 70)}”; live heap ${growthMB === null ? 'n/a' : `${growthMB >= 0 ? '+' : ''}${growthMB} MB`}; app ${alive ? 'alive' : 'DEAD'}`
        : `${c.view} view not reachable — case not exercised`,
      { statusText, growthMB, alive, shown, ...t },
    );
    await page.close();
  }

  // ── SEC-02 CSP violations across the main flows ──────────────────────────────────────────────
  console.log('\nCSP violations across the main flows (SEC-02)');
  if (shouldRun('CSP-FLOWS')) {
    const page = await newPage(browser);
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const flows = [];
    const click = async (label, rx) => {
      const ok = await page
        .getByRole('button', { name: rx })
        .first()
        .click({ timeout: 4000 })
        .then(() => true)
        .catch(() => false);
      flows.push(`${label}:${ok ? 'ok' : 'skip'}`);
      await page.waitForTimeout(600);
    };
    // Keyboard shortcuts cover the water modes without depending on panel layout (src/ui/keyboard.ts).
    for (const key of ['v', 'v', 'v', 'v', ' ', 'r']) {
      await page.keyboard.press(key === ' ' ? 'Space' : key);
      await page.waitForTimeout(300);
    }
    flows.push('viewModes:ok');
    await click('howItWorks', /how it works|how/i);
    await page.keyboard.press('Escape');
    await click('locationPicker', /pick any|location/i);
    await page.keyboard.press('Escape');
    // A drag on the canvas: orbit, then a wall with the wall tool if the shortcut exists.
    await page.mouse.move(500, 500);
    await page.mouse.down();
    await page.mouse.move(650, 560, { steps: 8 });
    await page.mouse.up();
    flows.push('orbit:ok');
    await page.waitForTimeout(1500);
    const t = await tripwires(page);
    const errs = page.__pageErrors.filter((e) => !/WebGPU|GPUDevice/i.test(e));
    const ok = t.csp.length === 0;
    record('CSP-FLOWS', 'SEC-02', 'zero CSP violations across the main flows', ok ? 'pass' : 'fail', ok ? `${flows.join(' ')} — no violations` : t.csp.map((v) => `${v.directive} blocked ${v.blocked}`).join(' | '), { flows, violations: t.csp, pageErrors: errs });
    await page.close();
  }

  await apiCases();

  // ── supply chain ─────────────────────────────────────────────────────────────────────────────
  console.log('\nSupply chain');
  if (shouldRun('AUDIT-PROD')) {
    if (SKIP_AUDIT) record('AUDIT-PROD', 'supply-chain', 'npm audit --omit=dev is clean', 'skip', QUICK ? 'skipped in --quick' : 'DELUGE_SEC_SKIP_AUDIT=1');
    else {
      try {
        // npm is a .cmd shim on Windows, which execFile only starts through a shell (constant arguments, so no injection);
        // without one it fails with ENOENT and the empty output would read as a clean audit.
        const { stdout } = await execFileAsync('npm', ['audit', '--omit=dev', '--json'], { cwd: ROOT, timeout: 120000, maxBuffer: 32 * 1024 * 1024, shell: process.platform === 'win32' }).catch((e) => ({ stdout: e.stdout ?? '' }));
        const j = JSON.parse(stdout || '{}');
        const v = j.metadata?.vulnerabilities ?? {};
        const total = Object.values(v).reduce((a, b) => a + b, 0);
        record('AUDIT-PROD', 'supply-chain', 'npm audit --omit=dev is clean', total === 0 ? 'pass' : 'fail', total === 0 ? 'no advisories in production dependencies' : JSON.stringify(v), v);
      } catch (e) {
        record('AUDIT-PROD', 'supply-chain', 'npm audit --omit=dev is clean', 'skip', `audit unavailable (${String(e.message).slice(0, 80)}) — needs network`);
      }
    }
  }

  await browser.close();
  browser = null;

  // ── report ────────────────────────────────────────────────────────────────────────────────────
  const counts = { pass: 0, fail: 0, pending: 0, skip: 0 };
  for (const r of results) counts[r.status]++;
  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log('\n' + pad('case', 24) + pad('finding', 14) + pad('status', 10) + 'what');
  console.log('-'.repeat(110));
  for (const r of results) console.log(pad(r.id, 24) + pad(r.finding, 14) + pad(r.status.toUpperCase(), 10) + r.what);
  console.log(`\n${counts.pass} pass · ${counts.fail} fail · ${counts.pending} pending · ${counts.skip} skipped`);

  const failures = results.filter((r) => r.status === 'fail' || (STRICT && r.status === 'pending'));
  if (failures.length) {
    console.log('\nRegressions:');
    for (const f of failures) console.log(`  ! ${f.id} (${f.finding}) ${f.what} — ${f.detail}`);
  }

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      { suite: 'security', schema: 'deluge-security/1', date: new Date().toISOString(), quick: QUICK, strict: STRICT, baseUrl, counts, results, verdict: failures.length ? 'FAIL' : counts.pending ? 'PASS (with pending cases)' : 'PASS' },
      null,
      2,
    ),
  );
  console.log(`\nJSON: ${path.relative(ROOT, JSON_OUT)}`);
  if (!failures.length) console.log('\nPASS — every automated pentest case still holds.');
  process.exitCode = failures.length ? 1 : 0;
} catch (e) {
  console.error(`\nFAIL: ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  killTree(server);
  if (!KEEP_DIST && !EXTERNAL_URL && fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
}
