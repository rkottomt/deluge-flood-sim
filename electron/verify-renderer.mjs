#!/usr/bin/env node
/**
 * §V verification, renderer half — checklist items 1-8, 14 and 15 of
 * artifacts/security-report/ELECTRON_REQUIREMENTS.md.
 *
 * Drives the *real* main process (`electron/main.js`) with Playwright's `_electron` API. It runs the
 * unpackaged binary on purpose: Playwright launches Electron with `--inspect=0` / `--remote-debugging-pipe`,
 * and the packaged app refuses both (R11 fuses + the R12 guard) — that refusal is itself checklist item 10,
 * and `electron/verify-packaged.mjs` proves it. Everything under test here — the protocol handler, the
 * headers, the navigation, permission, TLS and network rules — is the same code either way, and item 14 is
 * re-run below against the exact production `dist/` that ships.
 *
 * Three launches, so one launch's deliberate failures cannot pollute another's console:
 *   A  debug build (DELUGE_DEBUG_API=1) — items 1-7, 15, plus the pitch flows.
 *   B  same build behind `--host-resolver-rules`, pointed at a local self-signed TLS server — item 8.
 *   C  the shipping production build — item 14, and "no console errors" on what judges actually see.
 *
 * Run: npm run app:check   (or: node electron/verify-renderer.mjs)
 * Writes artifacts/electron/verify-renderer.json.
 */
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:https';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(REPO, 'electron/main.js');
const OUT = path.join(REPO, 'artifacts/electron');
const DEBUG_DIST = 'artifacts/electron/dist-debug';
const TLS_PORT = 5604; // this agent's assigned port; nothing else in the wrapper ever listens
const PRESET_TIMEOUT = 90_000;

/** page.evaluate has no timeout of its own; a wedged app must fail the check, not hang the run. */
const withTimeout = (promise, ms, label) =>
  Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms))]);

const checks = [];
let failures = 0;
function record(id, req, name, ok, detail) {
  checks.push({ id, req, name, ok: ok === 'skip' ? 'skip' : !!ok, detail });
  if (ok !== 'skip' && !ok) failures += 1;
  const mark = ok === 'skip' ? 'skip' : ok ? 'ok  ' : 'FAIL';
  console.log(`  ${mark} V${id} ${name}${detail ? ` — ${detail}` : ''}`);
}
const section = (s) => console.log(`\n${s}`);

/* --------------------------------------------------------------------------------------- fixtures */

function buildDebugDist() {
  if (existsSync(path.join(REPO, DEBUG_DIST, 'index.html')) && !process.argv.includes('--rebuild')) return;
  section(`building ${DEBUG_DIST} (DELUGE_DEBUG_API=1)`);
  const r = spawnSync('npx', ['vite', 'build', '--outDir', DEBUG_DIST, '--emptyOutDir'], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, DELUGE_DEBUG_API: '1' },
  });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(1);
  }
}

/** A throwaway cert for `elevation.nationalmap.gov`, signed by nobody. Chromium must reject it. */
async function tlsFixture() {
  const dir = path.join(OUT, 'tls');
  await mkdir(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  if (!existsSync(cert)) {
    const r = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=elevation.nationalmap.gov'], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`openssl failed: ${r.stderr}`);
  }
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"trusted":false}');
  });
  await new Promise((resolve, reject) => server.listen(TLS_PORT, '127.0.0.1', resolve).on('error', reject));
  return server;
}

/** Launch the wrapper and collect everything the main process prints. */
async function launch({ dist, args = [] }) {
  const mainLog = [];
  const app = await electron.launch({
    executablePath: electronPath,
    args: [MAIN, ...args],
    cwd: REPO,
    env: { ...process.env, DELUGE_DIST: dist, DELUGE_SMOKE_OUT: '' },
  });
  app.process().stdout?.on('data', (b) => mainLog.push(String(b)));
  app.process().stderr?.on('data', (b) => mainLog.push(String(b)));
  const page = await app.firstWindow();
  const pageErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => pageErrors.push(`pageerror: ${e.message}`));
  // Installed before the document runs, then the page is reloaded, so no violation can be missed.
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__violations.push({ directive: e.violatedDirective, blocked: e.blockedURI }));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  return { app, page, mainLog, pageErrors, mainText: () => mainLog.join('') };
}

const waitReady = (page) =>
  page.waitForFunction(() => Boolean(window.__deluge) || Boolean(document.getElementById('deluge-fatal')), null, { timeout: 60_000 }).then(() => page.evaluate(() => window.__deluge?.ready));

/* ------------------------------------------------------------------------------- A: the main launch */

buildDebugDist();
const distFiles = readdirSync(path.join(REPO, DEBUG_DIST, 'assets'));
const WORKER_ASSET = distFiles.find((f) => f.startsWith('liveWorker')) ?? distFiles.find((f) => f.endsWith('.js'));

section('launch A — debug build');
const A = await launch({ dist: DEBUG_DIST });
await waitReady(A.page);

/* V1 renderer globals */
{
  const g = await A.page.evaluate(() => ({
    require: typeof require,
    process: typeof process,
    module: typeof module,
    global: typeof global,
    Buffer: typeof Buffer,
    suspicious: Object.keys(window).filter((k) => /electron|ipc|bridge|node/i.test(k)),
  }));
  const ok = g.require === 'undefined' && g.process === 'undefined' && g.module === 'undefined' && g.global === 'undefined' && g.Buffer === 'undefined' && g.suspicious.length === 0;
  record(1, 'R2,R3', 'no Node or bridge in the renderer', ok, JSON.stringify(g));
}

/* V2 origin, secure context, GPU */
{
  const env = await A.page.evaluate(async () => {
    const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
    return {
      origin: location.origin,
      secure: isSecureContext,
      gpu: Boolean(navigator.gpu),
      adapter: adapter ? { vendor: adapter.info?.vendor ?? null, architecture: adapter.info?.architecture ?? null, description: adapter.info?.description ?? null } : null,
    };
  });
  record(2, 'R4', 'origin is app://deluge and the context is secure', env.origin === 'app://deluge' && env.secure === true, `${env.origin}, isSecureContext=${env.secure}`);
  record('2b', 'R4', 'WebGPU adapter with no extra switches', Boolean(env.adapter), JSON.stringify(env.adapter));
}

/* V2 presets */
{
  const ids = await A.page.evaluate(() => window.__deluge.listPresets());
  const loaded = [];
  for (const id of ids) {
    try {
      await withTimeout(A.page.evaluate((p) => window.__deluge.loadPreset(p), id), PRESET_TIMEOUT, `loadPreset(${id})`);
      const st = await A.page.evaluate(() => {
        const s = window.__deluge.getSolver();
        return { preset: window.__deluge.getState().presetId, cells: s ? s.nx * s.ny : 0 };
      });
      loaded.push(`${id}:${st.preset === id && st.cells > 0 ? 'ok' : 'wrong'}`);
    } catch (err) {
      loaded.push(`${id}:FAIL(${String(err).slice(0, 80)})`);
    }
  }
  record('2c', 'R4', `all ${ids.length} presets load from the packaged assets`, loaded.every((l) => l.endsWith(':ok')), loaded.join(' '));
}

/* V2 protectionWorker via a levee, and the sim actually running */
{
  let detail = '';
  let ok = false;
  try {
    await withTimeout(A.page.evaluate(() => window.__deluge.loadPreset('pittsburgh')), PRESET_TIMEOUT, 'loadPreset(pittsburgh)');
    const prot = await withTimeout(A.page.evaluate(async () => {
      const g = window.__deluge.getSolver();
      const cx = Math.floor(g.nx / 2);
      const cy = Math.floor(g.ny / 2);
      window.__deluge.selectTool('wall');
      window.__deluge.drawWall([{ gx: cx - 40, gy: cy }, { gx: cx, gy: cy + 30 }, { gx: cx + 40, gy: cy }], 4);
      for (let i = 0; i < 200; i++) {
        const p = window.__deluge.getProtection();
        if (p && p.wallCells > 0) return p;
        await window.__deluge.waitFrames(2);
      }
      return window.__deluge.getProtection();
    }), 60_000, 'protection');
    ok = Boolean(prot && prot.wallCells > 0);
    detail = JSON.stringify(prot);
  } catch (err) {
    detail = String(err).slice(0, 160);
  }
  record('2d', 'R4', 'protectionWorker runs when a levee is drawn', ok, detail);
}
{
  const sim = await withTimeout(A.page.evaluate(async () => {
    window.__deluge.setRain(100);
    window.__deluge.setPaused(false);
    await window.__deluge.runFor(60);
    const perf = window.__deluge.getPerf();
    return { volume: window.__deluge.getStats()?.volume ?? 0, fps: perf.fps, frames: perf.frames };
  }), 120_000, 'runFor(60)');
  record('2e', 'R4', 'the solver runs under the wrapper', sim.volume > 0, `volume=${sim.volume.toFixed(0)} m³, fps=${sim.fps.toFixed(1)}`);
}

/* V2 a live area, when the venue (or this machine) actually has network */
{
  const online = await A.page.evaluate(() => fetch('https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png', { mode: 'no-cors', cache: 'no-store' }).then(() => true).catch(() => false));
  if (!online) {
    record('2f', 'R4', 'a live area loads through the allowlist', 'skip', 'machine is offline — presets cover the demo path');
  } else {
    let ok = false;
    let detail = '';
    try {
      const r = await withTimeout(
        A.page.evaluate(async () => {
          // A small area over the Point, loaded exactly as the picker does it (liveWorker + the seven hosts).
          const outcome = await window.__deluge.actions.loadLiveArea({ center: { lat: 40.4425, lon: -79.9959 }, sizeMeters: 4000, resolution: 512, name: 'Verify' });
          const s = window.__deluge.getSolver();
          return { outcome: outcome ?? 'ok', cells: s ? s.nx * s.ny : 0, name: window.__deluge.getState().terrainName ?? null };
        }),
        180_000,
        'loadLiveArea',
      );
      ok = r.cells > 0 && r.outcome !== 'failed';
      detail = JSON.stringify(r);
    } catch (err) {
      detail = String(err).slice(0, 200);
    }
    record('2f', 'R4', 'a live area loads through the allowlist (liveWorker)', ok, detail);
  }
}

/* V3 CSP */
{
  const hdr = await A.page.evaluate(async (asset) => {
    const r = await fetch(`app://deluge/assets/${asset}`);
    return { status: r.status, csp: r.headers.get('content-security-policy'), type: r.headers.get('content-type'), referrer: r.headers.get('referrer-policy'), nosniff: r.headers.get('x-content-type-options') };
  }, WORKER_ASSET);
  const ok = hdr.status === 200 && typeof hdr.csp === 'string' && hdr.csp.includes("frame-ancestors 'none'") && hdr.csp.includes("script-src 'self'") && !/unsafe-eval/.test(hdr.csp);
  record(3, 'R6', 'worker asset carries the CSP header with frame-ancestors', ok, `${hdr.status} ${hdr.type}; referrer-policy=${hdr.referrer}; nosniff=${hdr.nosniff}`);
}
{
  const injected = await A.page.evaluate(() => {
    // The SEC-08 regression: a payload that reaches an HTML sink must not execute under script-src 'self'.
    const host = document.createElement('div');
    host.innerHTML = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1<\/script>';
    document.body.appendChild(host);
    return new Promise((r) => setTimeout(() => { host.remove(); r({ pwned: window.__pwned ?? null, violations: window.__violations.length }); }, 400));
  });
  record('3b', 'R6', 'an injected payload executes nothing', injected.pwned === null, `window.__pwned=${injected.pwned}`);
}

/* V4 traversal — from the renderer, and straight at the handler through the session (CSP-independent) */
{
  const TRAVERSAL = [
    'app://deluge/..%2f..%2fpackage.json',
    'app://deluge/%2e%2e/%2e%2e/etc/passwd',
    'app://deluge/assets/..%5c..%5cmain.js',
    'app://deluge/index.html%00.js',
    'app://deluge/presets/',
    'app://deluge/assets/x.map',
    'app://deluge/main.js',
    'app://deluge/../main.js',
    'app://deluge/%2e%2e%2fmain.js',
    'app://other/index.html',
  ];
  const viaSession = await A.app.evaluate(async ({ session }, urls) => {
    const ses = session.fromPartition('persist:deluge');
    const out = {};
    for (const u of urls) {
      try {
        const r = await ses.fetch(u);
        out[u] = r.status;
      } catch (err) {
        out[u] = `throw:${String(err).slice(0, 40)}`;
      }
    }
    return out;
  }, TRAVERSAL);
  const served = Object.entries(viaSession).filter(([, v]) => v === 200);
  record(4, 'R5', 'every traversal and out-of-tree path is refused', served.length === 0, served.length ? `SERVED: ${JSON.stringify(served)}` : Object.values(viaSession).join(','));

  const good = await A.app.evaluate(async ({ session }) => {
    const ses = session.fromPartition('persist:deluge');
    const a = await ses.fetch('app://deluge/');
    const b = await ses.fetch('app://deluge/presets/index.json').catch(() => ({ status: 'err' }));
    const post = await ses.fetch('app://deluge/index.html', { method: 'POST' }).catch((e) => ({ status: `throw:${String(e).slice(0, 30)}` }));
    return { root: a.status, rootType: a.headers.get('content-type'), presets: b.status, post: post.status };
  });
  record('4b', 'R5', 'legitimate paths still serve, and POST does not', good.root === 200 && good.post !== 200, JSON.stringify(good));
}

/* V5 navigation */
{
  const nav = await A.page.evaluate(async () => {
    const opened = window.open('https://example.com');
    const before = location.href;
    try { location.href = 'https://example.com'; } catch {}
    try { location.href = 'file:///etc/passwd'; } catch {}
    await new Promise((r) => setTimeout(r, 600));
    return { openedNull: opened === null, before, after: location.href };
  });
  const ok = nav.openedNull && nav.after === nav.before && nav.after.startsWith('app://deluge/');
  record(5, 'R7', 'no new windows and no navigation off app://deluge', ok, JSON.stringify(nav));
  record('5b', 'R7,R9', 'main process logged the blocks', /blocked navigation|blocked external open/.test(A.mainText()), A.mainText().match(/\[deluge\] blocked[^\n]*/g)?.slice(0, 2).join(' | ') ?? 'no log line');
}

/* V6 network allowlist */
{
  const before = A.mainText().length;
  const net = await A.page.evaluate(async () => {
    const out = {};
    const tryFetch = async (u) => { try { await fetch(u, { mode: 'no-cors', cache: 'no-store' }); return 'reached'; } catch { return 'blocked'; } };
    out.evil = await tryFetch('https://evil.example/');
    out.bucket = await tryFetch('https://s3.amazonaws.com/attacker-bucket/x');
    // Permitted by CSP img-src (the Esri services prefix) but NOT by the main-process allowlist: the one case
    // where the two layers disagree, which is exactly what proves R10 stands on its own.
    out.cspOkAllowlistNo = await new Promise((r) => {
      const img = new Image();
      img.onload = () => r('reached');
      img.onerror = () => r('blocked');
      img.src = 'https://server.arcgisonline.com/ArcGIS/rest/services/Utilities/PrintingTools/GPServer/x.png';
      setTimeout(() => r('timeout'), 8000);
    });
    out.violations = window.__violations.map((v) => `${v.directive}:${v.blocked}`);
    return out;
  });
  const log = A.mainText().slice(before);
  const blockedLines = log.match(/\[net\] blocked[^\n]*/g) ?? [];
  record(6, 'R10', 'evil hosts are refused', net.evil === 'blocked' && net.bucket === 'blocked', `evil=${net.evil}, attacker bucket=${net.bucket}; CSP violations: ${net.violations.join(', ') || 'none'}`);
  record('6b', 'R10', 'the allowlist blocks what CSP would have permitted', net.cspOkAllowlistNo !== 'reached' && blockedLines.some((l) => l.includes('PrintingTools')), `${net.cspOkAllowlistNo}; main log: ${blockedLines.join(' | ') || 'none'}`);
}

/* V7 permissions */
{
  const perms = await A.page.evaluate(async () => {
    const rejected = async (fn) => { try { await fn(); return false; } catch { return true; } };
    return {
      getUserMedia: await rejected(() => navigator.mediaDevices.getUserMedia({ video: true })),
      notification: typeof Notification !== 'undefined' ? await Notification.requestPermission() : 'absent',
      geolocation: (await navigator.permissions.query({ name: 'geolocation' })).state,
      clipboard: await rejected(() => navigator.clipboard.readText()),
      bluetooth: navigator.bluetooth ? await rejected(() => navigator.bluetooth.requestDevice({ acceptAllDevices: true })) : 'absent',
      usb: navigator.usb ? await rejected(() => navigator.usb.requestDevice({ filters: [] })) : 'absent',
      hid: navigator.hid ? await rejected(() => navigator.hid.requestDevice({ filters: [] })) : 'absent',
      serial: navigator.serial ? await rejected(() => navigator.serial.requestPort()) : 'absent',
      midi: (await navigator.permissions.query({ name: 'midi' }).catch(() => ({ state: 'absent' }))).state,
    };
  });
  const bad = Object.entries(perms).filter(([k, v]) => (k === 'notification' ? v !== 'denied' && v !== 'absent' : k === 'geolocation' || k === 'midi' ? v !== 'denied' && v !== 'absent' : v !== true && v !== 'absent'));
  record(7, 'R8', 'every permission-gated API is denied', bad.length === 0, JSON.stringify(perms));
}

/* V15 launch surface */
{
  const surface = await A.app.evaluate(({ app }) => ({
    deepLink: app.isDefaultProtocolClient('deluge'),
    appLink: app.isDefaultProtocolClient('app'),
    packaged: app.isPackaged,
    version: app.getVersion(),
  }));
  record(15, 'R13', 'no URL scheme is registered to this app', surface.deepLink === false && surface.appLink === false, JSON.stringify(surface));
}

/* console hygiene for the debug build */
record('A-console', 'R2', 'debug build produced no unexpected renderer errors', A.pageErrors.filter((e) => !/blocked|violat|net::ERR|Failed to load resource|evil\.example|attacker-bucket|PrintingTools/i.test(e)).length === 0, A.pageErrors.slice(0, 4).join(' | ') || 'clean');

await A.app.close();

/* ---------------------------------------------------------------------------------- B: TLS (V8) */

section('launch B — TLS rejection');
{
  let server;
  try {
    server = await tlsFixture();
    const B = await launch({ dist: DEBUG_DIST, args: [`--host-resolver-rules=MAP elevation.nationalmap.gov 127.0.0.1:${TLS_PORT}`] });
    await B.page.waitForFunction(() => Boolean(window.__deluge) || Boolean(document.getElementById('deluge-fatal')), null, { timeout: 60_000 });
    const res = await B.page.evaluate(async () => {
      try {
        const r = await fetch('https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=json', { cache: 'no-store' });
        return { reached: true, status: r.status, body: (await r.text()).slice(0, 40) };
      } catch (err) {
        return { reached: false, error: String(err).slice(0, 80) };
      }
    });
    await new Promise((r) => setTimeout(r, 500));
    const logged = /certificate rejected/.test(B.mainText());
    record(8, 'R10', 'a self-signed data host is rejected, nothing is trusted', res.reached === false, `${JSON.stringify(res)}; main logged certificate-error: ${logged}`);
    // The app must survive it: presets still load with the DEM host poisoned.
    await B.page.evaluate(() => window.__deluge.ready);
    const still = await withTimeout(
      B.page.evaluate(async () => {
        await window.__deluge.loadPreset('pittsburgh');
        const s = window.__deluge.getSolver();
        return s ? s.nx * s.ny : 0;
      }),
      PRESET_TIMEOUT,
      'preset fallback after TLS failure',
    );
    record('8b', 'R10', 'the app falls back to offline presets when TLS fails', still > 0, `${still} cells`);
    await B.app.close();
  } catch (err) {
    record(8, 'R10', 'a self-signed data host is rejected', false, String(err).slice(0, 200));
  } finally {
    server?.close();
  }
}

/* ------------------------------------------------------------- C: the shipping build (V14, hygiene) */

section('launch C — production build');
{
  if (!existsSync(path.join(REPO, 'dist/index.html'))) {
    record(14, 'R12', 'production build has no debug API', false, 'no dist/ — run npm run app:build first');
  } else {
    const C = await launch({ dist: 'dist' });
    await C.page.waitForFunction(() => document.querySelectorAll('canvas').length > 0 || Boolean(document.getElementById('deluge-fatal')), null, { timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 12_000));
    const dbg = await C.page.evaluate(() => ({
      deluge: typeof window.__deluge,
      ui: typeof document.getElementById('ui-root')?.__delugeUI,
      canvas: document.querySelectorAll('canvas').length,
      fatal: Boolean(document.getElementById('deluge-fatal')),
      violations: window.__violations.length,
    }));
    record(14, 'R12,SEC-07', 'the shipping renderer has no debug API', dbg.deluge === 'undefined' && dbg.ui === 'undefined', JSON.stringify(dbg));
    record('3c', 'R6', 'zero CSP violations on the shipping build', dbg.violations === 0, `${dbg.violations} violations`);
    record('C-console', 'R2', 'shipping build produced no renderer errors', C.pageErrors.length === 0, C.pageErrors.slice(0, 4).join(' | ') || 'clean');
    await C.app.close();
  }
}

/* ------------------------------------------------------------------------------------------ report */

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'verify-renderer.json'), `${JSON.stringify({ when: new Date().toISOString(), electron: process.versions.electron ?? null, checks }, null, 2)}\n`);
console.log(`\n${checks.filter((c) => c.ok === true).length} passed, ${failures} failed, ${checks.filter((c) => c.ok === 'skip').length} skipped → artifacts/electron/verify-renderer.json`);
process.exit(failures ? 1 : 0);
