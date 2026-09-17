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
 *   SPOOF-*    SEC-01  ?name= / ?preset= / invalid ?live= must never put attacker prose in the app's own chrome
 *   XSS-*      SEC-01/08/09/10  hostile Nominatim, preset meta and road data must not execute (window.__pwned unset)
 *   CSP-*      SEC-02  the policy ships in the built index.html, and the main flows raise zero violations
 *   CAP-*      SEC-03  oversized and gzip-bomb responses are refused without exhausting memory
 *   DIST-*     SEC-07  no source maps, no local paths, no debug surfaces in the released bundle
 *   AUDIT-*    supply chain: `npm audit --omit=dev` is clean
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
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'security');

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
  const build = spawn('npx', ['vite', 'build', '--outDir', distDir], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  build.stdout.pipe(log, { end: false });
  build.stderr.pipe(log, { end: false });
  const [code] = await once(build, 'exit');
  if (code !== 0) throw new Error(`vite build failed (exit ${code}); see ${logFile}`);
  console.log('ok');
  if (await portOpen(port)) throw new Error(`port ${port} is already in use — pass --port=<free port>`);
  const server = spawn('npx', ['vite', 'preview', '--outDir', distDir, '--port', String(port), '--strictPort'], {
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

  // ── SEC-03 response byte caps ────────────────────────────────────────────────────────────────
  console.log('\nResponse byte caps (SEC-03)');
  /**
   * Nominatim's search is capped at 1 MB (src/ui/locationPicker.ts). Each variant puts a unique marker in the FIRST
   * result, so the marker can only reach the screen if the oversized body was read and parsed: seeing it is the
   * failure. Memory is sampled too — a cap that only throws after buffering has not protected anything.
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
  for (const c of capCases.filter((c) => shouldRun(c.id))) {
    const { body, opts } = c.build(c.marker);
    const wire = opts.gzip ? zlib.gzipSync(Buffer.from(body)).length : Buffer.byteLength(body);
    const page = await newPage(browser, {
      'nominatim.openstreetmap.org': (route) => fulfilJSON(route, body, opts),
    });
    await page.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await waitForApp(page);
    const before = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const flow = await searchFlow(page, 'pittsburgh');
    const after = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const text = await visibleText(page);
    const alive = await page.evaluate(() => !!document.querySelector('.dl-scene-name'));
    const leaked = text.includes(c.marker);
    const growthMB = before !== null && after !== null ? +((after - before) / 1048576).toFixed(1) : null;
    // 12 MB of inflated JSON must not become 12 MB of live heap; a generous bound still catches "buffer it all".
    const memoryOk = growthMB === null || growthMB < 64;
    const ok = !leaked && alive && memoryOk;
    record(
      c.id,
      'SEC-03',
      c.what,
      flow.typed ? (ok ? 'pass' : 'fail') : 'pending',
      flow.typed
        ? `${(Buffer.byteLength(body) / 1048576).toFixed(1)} MB payload (${(wire / 1024).toFixed(0)} KB on the wire), marker ${leaked ? 'RENDERED' : 'never rendered'}, heap +${growthMB ?? '?'} MB, app ${alive ? 'alive' : 'DEAD'}`
        : 'search UI not reachable — case not exercised',
      { leaked, alive, growthMB, wireBytes: wire },
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

  // ── supply chain ─────────────────────────────────────────────────────────────────────────────
  console.log('\nSupply chain');
  if (shouldRun('AUDIT-PROD')) {
    if (SKIP_AUDIT) record('AUDIT-PROD', 'supply-chain', 'npm audit --omit=dev is clean', 'skip', QUICK ? 'skipped in --quick' : 'DELUGE_SEC_SKIP_AUDIT=1');
    else {
      try {
        const { stdout } = await execFileAsync('npm', ['audit', '--omit=dev', '--json'], { cwd: ROOT, timeout: 120000, maxBuffer: 32 * 1024 * 1024 }).catch((e) => ({ stdout: e.stdout ?? '' }));
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
