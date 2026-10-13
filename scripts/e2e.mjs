#!/usr/bin/env node
/**
 * Deluge end-to-end demo flows in headless Chromium on the real GPU.
 *
 *   node scripts/e2e.mjs                    in-process Vite dev server on :5190 (or the next free port), all flows
 *   node scripts/e2e.mjs --prod             production build + `vite preview` (what `npm run demo` serves)
 *   E2E_URL=http://localhost:5173/ node scripts/e2e.mjs      use an already running server
 *   node scripts/e2e.mjs --only=1,2,5       run a subset (flows that need an earlier result compute it themselves)
 *   node scripts/e2e.mjs --preset=sandbox   run the preset-specific flows on another preset (default pittsburgh)
 *   node scripts/e2e.mjs --live             also run the live-area flow (needs internet: USGS, Esri, TIGERweb)
 *   node scripts/e2e.mjs --browser=brave    run the flows in installed Brave (the demo browser) → artifacts/e2e-brave
 *   node scripts/e2e.mjs --only=23 --compare-minutes=30   flow 23 (projects + design comparison) with longer runs per level
 *
 * Offline guarantee: every request to a non-local host is blocked (the demo venue's wifi is unreliable) and
 * reported; the baked-preset flows must not need any. Only the opt-in live flow may use the network. The startup-cancel
 * flow holds external requests unanswered instead (stalled venue wifi), so it needs no network either.
 *
 * Debug API: the flows drive the app through `window.__deluge`, which a released build no longer contains
 * (FINDINGS.json SEC-07). This script therefore sets DELUGE_DEBUG_API=1 before it builds, which is what
 * vite.config.ts's `define` reads. To point --prod/E2E_URL at a server you built yourself, build it the same way:
 * `DELUGE_DEBUG_API=1 npm run demo`. A plain `npm run demo` has no debug API, which is the point.
 *
 * Screenshots → artifacts/e2e/NN-name.png, machine-readable report → artifacts/e2e/report.json.
 * Prints a PASS/FAIL table with measured numbers and exits non-zero if any flow fails.
 * Console errors, page errors and window.__deluge.errors are collected per flow; any of them fails the flow, unless
 * the flow declares them in `expectedErrors` (flow 14 destroys the GPU device on purpose).
 *
 * Flow 14 destroys the GPU device and flow 13 pretends the tab was hidden; both put the page back afterwards.
 */
import { chromium } from 'playwright';
import { build, createServer, preview } from 'vite';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const only = args.only ? new Set(String(args.only).split(',').map((s) => Number(s.trim()))) : null;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A Brave run writes elsewhere, so it never overwrites the canonical Chromium screenshots and report.
const OUT = path.join(ROOT, 'artifacts', args.out ?? (args.browser === 'brave' ? 'e2e-brave' : 'e2e'));
const WIDTH = 1600;
const HEIGHT = 1000;
const TOOL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const ALL_TOOLS = ['orbit', 'wall', 'eraseWall', 'inflow', 'storm', 'water', 'dig', 'evac', 'shelter', 'probe'];
/** The demo laptop presents in Brave, so the flows can be run there too (--browser=brave). */
const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
/** Main preset for flows 1–5 and 8 (the demo is Pittsburgh; other presets are useful while developing). */
const PRESET = String(args.preset ?? process.env.E2E_PRESET ?? 'pittsburgh');
/**
 * Flow 7 loads every other scene the app offers, so it is read off the baked directory rather than hard-coded:
 * a preset added by a bake but forgotten here would otherwise never be driven end to end.
 */
const BAKED_PRESETS = fs
  .readdirSync(path.join(ROOT, 'public', 'presets'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'public', 'presets', d.name, 'meta.json')))
  .map((d) => d.name)
  .sort();
const OTHER_PRESETS = ['pittsburgh', 'sandbox', ...BAKED_PRESETS.filter((p) => p !== 'pittsburgh')].filter(
  (p) => p !== PRESET,
);

fs.mkdirSync(OUT, { recursive: true });

// The flows need window.__deluge, which vite.config.ts only compiles in when this is set (SEC-07). Set before any
// build()/createServer() call, because the config reads process.env when it is loaded. `??=` so an explicit 0 wins.
process.env.DELUGE_DEBUG_API ??= '1';

// ─── process management ────────────────────────────────────────────────────────────────────────
/** In-process Vite server (dev or preview); closed on exit, so it can never be left running. */
let vite = null;
let browser = null;
let cleanedUp = false;

async function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  try {
    if (vite?.close) await withTimeout(Promise.resolve(vite.close()), 5000, 'vite close');
    else if (vite?.httpServer) await new Promise((r) => vite.httpServer.close(r));
  } catch {
    /* exiting anyway */
  }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, async () => {
    console.log(`\n[e2e] ${sig} — cleaning up`);
    await cleanup();
    process.exit(130);
  });
}
process.on('uncaughtException', async (e) => {
  console.error('[e2e] uncaught exception', e);
  await cleanup();
  process.exit(2);
});

function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/**
 * Start Vite in this process. Dev mode disables HMR and file watching: other people editing the tree while
 * the flows run must not reload the page mid-flow. Prod mode builds to artifacts/e2e/dist and previews it.
 */
async function startVite() {
  let port = Number(args.port ?? 5190);
  while (!(await portFree(port))) port++;
  const common = { root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn', clearScreen: false };
  if (args.prod) {
    const outDir = path.join(OUT, 'dist');
    const t0 = Date.now();
    console.log('[e2e] building production bundle…');
    await build({ ...common, build: { outDir, emptyOutDir: true } });
    console.log(`[e2e] built in ${((Date.now() - t0) / 1000).toFixed(1)} s → ${path.relative(ROOT, outDir)}`);
    vite = await preview({ ...common, build: { outDir }, preview: { port, strictPort: true, host: '127.0.0.1', open: false } });
  } else {
    vite = await createServer({ ...common, server: { port, strictPort: true, host: '127.0.0.1', hmr: false, watch: null, open: false } });
    await vite.listen();
  }
  const url = `http://127.0.0.1:${port}/`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`vite answered ${r.status} on ${url}`);
  return url;
}

const isLocalUrl = (u) => {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') return true;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return true;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${(ms / 1000).toFixed(0)} s`)), ms);
    }),
  ]);
}

// ─── formatting ────────────────────────────────────────────────────────────────────────────────
const km2 = (m2) => `${(m2 / 1e6).toFixed(3)} km²`;
const m3 = (v) => (Number.isFinite(v) ? `${v.toExponential(2)} m³` : String(v));
const num = (v, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : String(v));

// ─── main ──────────────────────────────────────────────────────────────────────────────────────
const results = [];
let page;
let consoleErrors = [];
const httpFailures = [];
/** Requests to non-local hosts during the current flow (blocked unless the flow allows the network). */
let externalRequests = [];
let allowNetwork = false;
/** Hold external requests unanswered instead of failing them (a flow simulating stalled wifi); released after the flow. */
let stallNetwork = false;
let stalledRoutes = [];
async function releaseStalled() {
  const routes = stalledRoutes;
  stalledRoutes = [];
  await Promise.all(routes.map((route) => route.abort('internetdisconnected').catch(() => {})));
}

async function main() {
  const baseUrl = process.env.E2E_URL ?? (await startVite());
  console.log(`[e2e] app URL ${baseUrl}${vite ? (args.prod ? ' (own production preview)' : ' (own vite dev server)') : ''}`);

  // New headless: real Metal GPU → hardware WebGPU (the headless shell only has SwiftShader). Brave is the browser
  // the demo is actually presented in, and it is Chromium underneath, so the same flows run in it unchanged.
  const brave = args.browser === 'brave';
  if (brave && !fs.existsSync(BRAVE)) throw new Error(`--browser=brave: not installed at ${BRAVE}`);
  browser = await chromium.launch({
    headless: true,
    ...(brave ? { executablePath: BRAVE } : { channel: 'chromium' }),
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  console.log(`[e2e] ${brave ? 'Brave' : 'Chromium'} ${browser.version()} → ${path.relative(ROOT, OUT)}`);
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  // Offline enforcement: the built-in presets must work without internet.
  // (Predicate matcher: local requests — every dev module — are never intercepted.)
  await context.route((u) => !isLocalUrl(u.href), (route) => {
    const url = route.request().url();
    externalRequests.push(url);
    if (allowNetwork) return route.continue();
    if (stallNetwork) return void stalledRoutes.push(route);
    return route.abort('internetdisconnected');
  });
  page = await context.newPage();
  page.setDefaultTimeout(120_000);
  page.on('console', (m) => {
    const text = m.text();
    if (m.type() === 'error') {
      if (text.startsWith('Failed to load resource')) return; // reported with its URL by the response hook
      consoleErrors.push(text);
      console.log(`  [console.error] ${text.slice(0, 400)}`);
    } else if (m.type() === 'warning' && args.verbose) {
      console.log(`  [console.warn] ${text.slice(0, 300)}`);
    }
  });
  page.on('pageerror', (e) => {
    consoleErrors.push(`pageerror: ${e.message}`);
    console.log(`  [pageerror] ${e.message}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) {
      const entry = `HTTP ${r.status()} ${r.url()}`;
      httpFailures.push(entry);
      if (!r.url().endsWith('favicon.ico')) console.log(`  [http] ${entry}`);
    }
  });
  page.on('crash', () => {
    consoleErrors.push('page crashed');
    console.log('  [page] CRASHED');
  });

  const url = new URL(baseUrl);
  if (PRESET !== 'pittsburgh') url.searchParams.set('preset', PRESET);
  const ctx = { baseUrl, appUrl: url.href };
  for (const flow of FLOWS) {
    if (only ? !only.has(flow.id) : flow.optIn && !args[flow.optIn]) continue;
    if (!flow.resetsPage) {
      // Every later flow starts from a running app (also recovers from a crash / unexpected reload).
      const problem = await ensureApp(ctx);
      if (problem) {
        skipFlow(flow, `app not running: ${problem}`);
        continue;
      }
    }
    await runFlow(flow, ctx);
  }
}

/** Last startup failure (module load error, fallback screen…); later flows fail fast instead of cascading. */
let startupFailure = null;

/** Make sure the app is up and `ready`; navigate (once) if not. Returns a problem description or null. */
async function ensureApp(ctx) {
  if (startupFailure) return startupFailure;
  try {
    if (page.url() === 'about:blank') await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
    await waitReady(60_000);
    return null;
  } catch (e) {
    try {
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(90_000);
      return null;
    } catch (e2) {
      startupFailure = e2.message.split('\n')[0];
      return startupFailure;
    }
  }
}

function skipFlow(flow, reason) {
  console.log(`\n[e2e] (${flow.id}) ${flow.name}\n  ✗ ${reason}`);
  results.push({ id: flow.id, name: flow.name, pass: false, checks: [], metrics: {}, notes: [`exception: ${reason}`], errors: [], seconds: 0 });
}

/** Run one flow with timeout + per-flow error collection. */
async function runFlow(flow, ctx) {
  const r = { id: flow.id, name: flow.name, pass: false, checks: [], metrics: {}, notes: [], errors: [], seconds: 0 };
  results.push(r);
  console.log(`\n[e2e] (${flow.id}) ${flow.name}`);
  consoleErrors = [];
  externalRequests = [];
  allowNetwork = !!flow.network;
  stallNetwork = !!flow.stallNetwork;
  const t0 = Date.now();
  let threw = false;
  const errBase = await delugeErrorCount();
  try {
    await withTimeout(flow.run(r, ctx), flow.timeoutMs ?? 300_000, `flow ${flow.id}`);
  } catch (e) {
    threw = true;
    r.notes.push(`exception: ${e.message}`);
    console.log(`  ✗ exception: ${e.message}`);
  }
  stallNetwork = false;
  await releaseStalled();
  r.seconds = (Date.now() - t0) / 1000;
  const appErrors = await delugeErrors(flow.resetsPage ? 0 : errBase);
  const all = [...consoleErrors, ...appErrors.filter((e) => !consoleErrors.some((c) => c.includes(e)))];
  // A flow that breaks something on purpose (flow 14 destroys the GPU device) declares the errors that proves it
  // worked; they are reported but do not fail it. Everything else still does.
  const expected = flow.expectedErrors ? all.filter((e) => flow.expectedErrors.test(e)) : [];
  r.errors = all.filter((e) => !expected.includes(e));
  if (expected.length) r.metrics.expectedErrors = expected.slice(0, 10);
  check(r, 'no console / page / WebGPU errors', r.errors.length === 0, `${r.errors.length} errors${expected.length ? ` (+${expected.length} expected)` : ''}`);
  if (!flow.network && !flow.stallNetwork) {
    const hosts = [...new Set(externalRequests.map((u) => new URL(u).host))];
    r.metrics.externalRequests = externalRequests.slice(0, 20);
    check(r, 'works offline (no external requests)', externalRequests.length === 0, externalRequests.length ? `${externalRequests.length} blocked: ${hosts.join(', ')}` : '0 requests');
  }
  allowNetwork = false;
  r.pass = !threw && r.checks.every((c) => c.ok || c.soft);
  console.log(`  → ${r.pass ? 'PASS' : 'FAIL'} (${r.seconds.toFixed(1)} s)`);
}

function check(r, label, ok, measured, { soft = false } = {}) {
  r.checks.push({ label, ok: !!ok, measured, soft });
  console.log(`  ${ok ? '✓' : soft ? '~' : '✗'} ${label}${measured !== undefined ? ` — ${measured}` : ''}`);
}

async function delugeErrorCount() {
  try {
    return await page.evaluate(() => window.__deluge?.errors.length ?? 0);
  } catch {
    return 0;
  }
}
async function delugeErrors(from) {
  try {
    return await page.evaluate((f) => (window.__deluge?.errors ?? []).slice(f), from);
  } catch {
    return [];
  }
}

// ─── in-page helpers ───────────────────────────────────────────────────────────────────────────
const D = (fn, arg) => page.evaluate(fn, arg);
const stats = () => D(() => window.__deluge.getStats());
const state = (keys) =>
  D((ks) => {
    const s = window.__deluge.getState();
    return Object.fromEntries(ks.map((k) => [k, s[k]]));
  }, keys);

async function runFor(simSeconds) {
  const t0 = Date.now();
  await D((s) => window.__deluge.runFor(s), simSeconds);
  return (Date.now() - t0) / 1000;
}

async function shot(name) {
  await D(() => window.__deluge.waitFrames(6));
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  [shot] ${path.relative(ROOT, file)}`);
  return file;
}

/** Poll a Node-side predicate until it is true (or the timeout runs out). Returns whether it became true. */
async function waitFor(predicate, timeoutMs, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

async function waitReady(timeoutMs) {
  await page.waitForFunction(() => window.__deluge || document.getElementById('deluge-fatal'), null, {
    timeout: timeoutMs,
  });
  const fatal = await D(() => document.getElementById('deluge-fatal')?.innerText ?? null);
  if (fatal) throw new Error(`app showed fallback screen: ${fatal.slice(0, 300)}`);
  return D(async () => {
    await window.__deluge.ready;
    return performance.now();
  });
}

function statsFinite(s) {
  return !!s && ['maxDepth', 'maxSpeed', 'volume', 'wetArea', 'floodedArea', 'massError'].every((k) => Number.isFinite(s[k]));
}

/**
 * Stage offset for the historic crest: the scenario mark mentioning 1936 (Pittsburgh's St. Patrick's Day
 * flood), else the highest mark, else 46 ft for Pittsburgh, else the slider maximum.
 */
async function crestOffset() {
  return D((preset) => {
    const d = window.__deluge;
    const stage = d.getScenario()?.stage;
    if (!stage) return null;
    const marks = [...(stage.marks ?? [])].sort((a, b) => b.ft - a.ft);
    const mark = marks.find((m) => /1936/.test(m.label)) ?? marks[0] ?? null;
    if (mark) return { ft: mark.ft, offset: d.stageOffsetForFeet(mark.ft), maxOffset: stage.maxOffset, label: `${mark.label} (${mark.ft} ft)` };
    if (preset === 'pittsburgh') return { ft: 46, offset: d.stageOffsetForFeet(46), maxOffset: stage.maxOffset, label: '46 ft (assumed)' };
    return { ft: NaN, offset: stage.maxOffset, maxOffset: stage.maxOffset, label: 'slider maximum' };
  }, PRESET);
}

/** Return to a calm baseline: no walls, scenario sources, stage 0, rain 0, water reset. */
async function calm() {
  await D(() => {
    const d = window.__deluge;
    d.store.set({ panels: { howItWorks: false, locationPicker: false, help: false } });
    d.actions.clearWalls();
    d.actions.restoreScenario();
    d.setStageOffset(0);
    d.setRain(0);
    d.setWaterMode('realistic');
    d.setEvacStart(null);
    d.setPaused(false);
    d.actions.resetWater();
  });
}

/**
 * The "control" flood: Pittsburgh at the 1936 crest without walls. Records the initial depth field and the
 * flooded fields after 900 s and 1800 s (stride 4, max per block) in the page as window.__e2e for later flows.
 */
async function ensureControlFlood(r) {
  const have = await D(() => !!window.__e2e?.control);
  if (have) return;
  const crest = await crestOffset();
  if (!crest) throw new Error('scenario has no stage control');
  await calm();
  await runFor(30);
  await D(() => {
    window.__e2e = { initial: window.__deluge.sampleGrid('depth', 4) };
  });
  await D((o) => window.__deluge.setStageOffset(o), crest.offset);
  await runFor(900);
  await D(() => {
    window.__e2e.control900 = window.__deluge.sampleGrid('depth', 4);
  });
  await runFor(900);
  await D(() => {
    window.__e2e.control = window.__deluge.sampleGrid('depth', 4);
  });
  r?.notes.push('computed control flood (crest, 900 s + 1800 s)');
}

// ─── flows ─────────────────────────────────────────────────────────────────────────────────────
const FLOWS = [
  {
    id: 1,
    name: `${PRESET} loads with full rivers`,
    timeoutMs: 240_000,
    resetsPage: true,
    async run(r, ctx) {
      // Warm-up navigation: lets Vite transform modules / pre-bundle deps so the timed load reflects the app.
      const coldT0 = Date.now();
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
      r.metrics.coldLoadSeconds = (Date.now() - coldT0) / 1000;
      consoleErrors = [];

      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      const readyMs = await waitReady(60_000);
      r.metrics.loadSeconds = readyMs / 1000;
      check(r, 'ready < 10 s after navigation', readyMs < 10_000, `${(readyMs / 1000).toFixed(2)} s (cold ${r.metrics.coldLoadSeconds.toFixed(1)} s)`);
      check(r, 'load target < 5 s', readyMs < 5_000, `${(readyMs / 1000).toFixed(2)} s`, { soft: true });

      const s0 = await state(['presetId', 'terrainName', 'grid', 'gpuInfo']);
      check(r, `preset is ${PRESET} (no fallback)`, s0.presetId === PRESET, `${s0.presetId} “${s0.terrainName}”`);
      r.metrics.grid = s0.grid;
      r.metrics.gpu = s0.gpuInfo;

      await page
        .waitForFunction(() => (window.__deluge.getStats()?.volume ?? 0) > 0, null, { timeout: 10_000 })
        .catch(() => {});
      const s = await stats();
      r.metrics.volume = s?.volume;
      check(r, 'rivers have water (volume > 0)', (s?.volume ?? 0) > 0, s ? `${m3(s.volume)}, wet ${km2(s.wetArea)}` : 'no stats');
      // The Try-it strip offers the demo moments in pitch order: Evacuate before the levee, so building the levee
      // (which replays the rise) visibly re-plans a route that is already on screen.
      if (PRESET === 'pittsburgh') {
        const order = await D(() => [...document.querySelectorAll('.dl-try-step:not([hidden])')].map((b) => b.dataset.step));
        const labels = await D(() => [...document.querySelectorAll('.dl-try-step:not([hidden])')].map((b) => b.textContent.trim()));
        check(r, 'Try-it strip order: raise, evacuate, levee, rain', order.join(',') === 'flood,evac,levee,rain', labels.join(' · '));
      }
      await sleep(2600); // camera fly-in
      await shot(`01-${PRESET}-loaded`);
    },
  },
  {
    id: 2,
    name: 'Raise stage to the historic crest → town floods',
    timeoutMs: 360_000,
    async run(r) {
      const crest = await crestOffset();
      check(r, 'scenario has a stage control', !!crest, crest ? `${crest.label}: ${num(crest.offset)} m offset (max ${num(crest.maxOffset)})` : 'none');
      if (!crest) return;
      await calm();
      await runFor(30);
      await D(() => {
        window.__e2e = { initial: window.__deluge.sampleGrid('depth', 4) };
      });
      const before = await stats();
      await D((o) => window.__deluge.setStageOffset(o), crest.offset);
      // The river rises to the crest along its whole length (src/app/crest.ts) at a limited rate in simulated time
      // (src/app/stageRamp.ts: ~3.7 sim-min to 46 ft), not as a bore from the domain edges and not as a dam break.
      // Sample the HUD's max speed while it rises: an instant 9 m jump pinned it at the 15 m/s cap.
      await D(() => {
        const d = window.__deluge;
        window.__e2eSpeed = { max: 0, samples: 0 };
        window.__e2eSpeedTimer = setInterval(() => {
          const v = d.getStats()?.maxSpeed;
          if (Number.isFinite(v)) {
            window.__e2eSpeed.max = Math.max(window.__e2eSpeed.max, v);
            window.__e2eSpeed.samples++;
          }
        }, 100);
      });
      const t300 = await runFor(300);
      const rise = await D(() => {
        clearInterval(window.__e2eSpeedTimer);
        return { ...window.__e2eSpeed, stage: window.__deluge.getStageApplied() };
      });
      const early = await stats();
      await shot('02-crest-300s');
      const t900 = t300 + (await runFor(600));
      const mid = await stats();
      await D(() => {
        window.__e2e.control900 = window.__deluge.sampleGrid('depth', 4);
      });
      await shot('02a-crest-900s');
      const t1800 = await runFor(900);
      const after = await stats();
      await D(() => {
        window.__e2e.control = window.__deluge.sampleGrid('depth', 4);
      });
      await shot('02b-crest-1800s');
      r.metrics = { before: before?.floodedArea, at300: early?.floodedArea, at900: mid?.floodedArea, at1800: after?.floodedArea, runSeconds: t900 + t1800, riseMaxSpeed: rise.max, riseSamples: rise.samples };
      const grown = (after?.floodedArea ?? 0) - (before?.floodedArea ?? 0);
      const earlyShare = grown > 0 ? ((early?.floodedArea ?? 0) - (before?.floodedArea ?? 0)) / grown : 0;
      check(r, 'the river reaches the crest within 5 sim-min', !rise.stage.moving && Math.abs(rise.stage.applied - crest.offset) < 1e-6, `applied ${num(rise.stage.applied)} m of ${num(crest.offset)} m`);
      check(r, 'rivers rise along their whole length: ≥ 30 % of the 30-min flood within 5 sim-min', earlyShare >= 0.3, `${km2(early?.floodedArea ?? 0)} after 300 s (${num(earlyShare * 100, 0)} % of ${km2(after?.floodedArea ?? 0)})`);
      check(r, 'no dam-break speeds while the river rises (HUD max speed < 10 m/s)', rise.samples > 0 && rise.max < 10, `peak ${num(rise.max)} m/s over ${rise.samples} HUD samples`);
      check(r, 'flooded area grows substantially (≥ 0.25 km²)', grown >= 250_000, `${km2(before?.floodedArea ?? 0)} → ${km2(mid?.floodedArea ?? 0)} → ${km2(after?.floodedArea ?? 0)}`);
      // With the whole river at the crest the flood spreads over the first minutes and then holds (shallow fringes
      // drain back a little as it settles), so "progressive" = it keeps growing after 2 min and is sustained at 30.
      const [a300, a900, a1800] = [early?.floodedArea ?? 0, mid?.floodedArea ?? 0, after?.floodedArea ?? 0];
      check(r, 'flooding develops, then holds at the crest (300 s < 900 s, 1800 s ≥ 90 % of 900 s)', a300 < a900 && a1800 >= 0.9 * a900, `${km2(a300)} → ${km2(a900)} → ${km2(a1800)}; sim 1800 s in ${(t900 + t1800).toFixed(1)} s real`);
      check(r, 'mass balance error < 1 %', (after?.massError ?? 1) < 0.01, `${num((after?.massError ?? NaN) * 100, 4)} %`);
    },
  },
  {
    id: 3,
    name: 'Draw a levee across a flooding street',
    timeoutMs: 420_000,
    async run(r) {
      await ensureControlFlood(r);
      const crest = await crestOffset();
      // Pick a wall site on DRY land between a river and neighborhood that floods in the control run:
      // multi-source BFS from the initially wet cells (rivers) gives, for every land sample, the distance and
      // direction to the nearest river; the wall goes across that direction, the protected land lies inland.
      const site = await D(() => {
        const d = window.__deluge;
        const { initial, control } = window.__e2e; // stride 4, max depth per block
        const { w, h, stride } = control;
        const N = w * h;
        const wet0 = (k) => initial.data[k] > 0.05;
        const dist = new Int32Array(N).fill(-1);
        const src = new Int32Array(N).fill(-1);
        const queue = new Int32Array(N);
        let qh = 0;
        let qt = 0;
        for (let k = 0; k < N; k++) if (wet0(k)) { dist[k] = 0; src[k] = k; queue[qt++] = k; }
        while (qh < qt) {
          const k = queue[qh++];
          const x = k % w, y = (k / w) | 0;
          for (let oy = -1; oy <= 1; oy++)
            for (let ox = -1; ox <= 1; ox++) {
              const xx = x + ox, yy = y + oy;
              if ((!ox && !oy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
              const kk = yy * w + xx;
              if (dist[kk] >= 0) continue;
              dist[kk] = dist[k] + 1;
              src[kk] = src[k];
              queue[qt++] = kk;
            }
        }
        // "Floods" = dry at the start, ≥ 30 cm after 900 s at the crest (the with-wall run is also 900 s).
        const c900 = window.__e2e.control900 ?? control;
        const floods = (k) => c900.data[k] > 0.3 && initial.data[k] < 0.01;
        const HALF = 11; // wall half-length in samples (44 cells)
        let best = null;
        for (let y = 14; y < h - 14; y++)
          for (let x = 14; x < w - 14; x++) {
            const k = y * w + x;
            if (dist[k] < 2 || dist[k] > 5 || initial.data[k] > 0.01) continue; // land, 8–20 cells from a river
            const sx = src[k] % w, sy = (src[k] / w) | 0;
            let ux = x - sx, uy = y - sy;
            const len = Math.hypot(ux, uy);
            if (len < 1) continue;
            ux /= len; uy /= len; // inland
            // The wall itself must stand on dry land (not across the river or a flooded park).
            let dryWall = 0;
            for (let l = -HALF; l <= HALF; l++) {
              const wx = Math.round(x - uy * l), wy = Math.round(y + ux * l);
              if (wx >= 0 && wy >= 0 && wx < w && wy < h && initial.data[wy * w + wx] < 0.01) dryWall++;
            }
            if (dryWall < 0.85 * (2 * HALF + 1)) continue;
            // Streets behind it that flood without the wall.
            const behindPts = [];
            for (let t = 2; t <= 10; t++)
              for (let l = -8; l <= 8; l++) {
                const bx = Math.round(x + ux * t - uy * l), by = Math.round(y + uy * t + ux * l);
                if (bx >= 0 && by >= 0 && bx < w && by < h && floods(by * w + bx)) behindPts.push([bx, by]);
              }
            const score = behindPts.length - 30 * (Math.hypot(x - w / 2, y - h / 2) / w);
            if (!best || score > best.score) best = { x, y, ux, uy, behindPts, score };
          }
        if (!best || best.behindPts.length < 10) return null;
        const c = { gx: (best.x + 0.5) * stride, gy: (best.y + 0.5) * stride };
        const half = HALF * stride;
        const a = { gx: c.gx - best.uy * half, gy: c.gy + best.ux * half };
        const b = { gx: c.gx + best.uy * half, gy: c.gy - best.ux * half };
        const pts = best.behindPts.map(([bx, by]) => ({ gx: (bx + 0.5) * stride, gy: (by + 0.5) * stride }));
        const behind = {
          gx: pts.reduce((acc, p) => acc + p.gx, 0) / pts.length,
          gy: pts.reduce((acc, p) => acc + p.gy, 0) / pts.length,
        };
        const g = d.getState().grid;
        const inside = (p) => p.gx > 1 && p.gy > 1 && p.gx < g.nx - 1 && p.gy < g.ny - 1;
        if (![a, b, behind].every(inside)) return null;
        return { a, b, c, behind, behindPts: pts, ux: best.ux, uy: best.uy, floodedBehindSamples: pts.length };
      });
      check(r, 'found a levee site (dry land between river and flooding streets)', !!site, site ? `center (${num(site.c.gx, 0)}, ${num(site.c.gy, 0)}), ${site.floodedBehindSamples} flooded samples behind` : 'none');
      if (!site) return;

      await calm();
      await runFor(30);
      await D((s) => window.__deluge.drawWall([s.a, s.c, s.b], 4), site);
      await D(() => window.__deluge.waitFrames(3));
      const wall = await D((s) => window.__deluge.sampleAt(s.c.gx, s.c.gy), site);
      check(r, 'wall raised on the bed (CPU mirror)', (wall?.barrier ?? 0) >= 3.5, `barrier ${num(wall?.barrier ?? 0)} m`);

      await D((o) => window.__deluge.setStageOffset(o), crest.offset);
      const secs = await runFor(900);
      // Mean depth over the protected streets (each a 4×4-cell block, max depth) with vs without the wall.
      const behind = await D((s) => {
        const d = window.__deluge;
        const withWall = d.sampleGrid('depth', 4);
        const control = window.__e2e.control900;
        let w = 0;
        let c = 0;
        for (const p of s.behindPts) {
          const k = Math.floor(p.gy / 4) * withWall.w + Math.floor(p.gx / 4);
          w += withWall.data[k];
          c += control.data[k];
        }
        return { withWall: w / s.behindPts.length, control: c / s.behindPts.length };
      }, site);
      r.metrics = { site: { ...site, behindPts: site.behindPts.length }, behind, runSeconds: secs };
      check(r, 'protected streets drier than without the wall (same 900 s at the crest)', behind.withWall < behind.control - 0.05, `mean ${num(behind.withWall)} m with wall vs ${num(behind.control)} m without (${site.behindPts.length} blocks)`, { soft: true });

      const ground = await D((s) => window.__deluge.sampleAt(s.c.gx, s.c.gy).ground, site);
      // Look from the river side across the wall toward the protected land.
      const yaw = Math.atan2(site.ux, -site.uy);
      await D(
        (p) => window.__deluge.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: p.elev }, distance: 1500, yaw: p.yaw, pitch: 0.78 }),
        { gx: site.behind.gx, gy: site.behind.gy, elev: ground, yaw },
      );
      await sleep(600);
      await shot('03a-levee');
      await D(() => window.__deluge.setWaterMode('maxDepth'));
      await sleep(400);
      await shot('03b-levee-max-depth');
      // The solver's hazard accumulators (readHazardFields) after the same 900 s at the crest, and the two views
      // drawn from them.
      const hz = await D(async () => {
        const s = window.__deluge.getSolver();
        if (!s?.readHazardFields) return null;
        const f = await s.readHazardFields();
        let arrived = 0;
        let never = 0;
        let bad = 0;
        let latest = 0;
        for (let k = 0; k < f.firstWet.length; k++) {
          const t = f.firstWet[k];
          if (![t, f.maxSpeed[k], f.maxDV[k], f.wetSeconds[k]].every(Number.isFinite)) bad++;
          else if (t > 0) {
            arrived++;
            latest = Math.max(latest, t);
          } else if (t < 0) never++;
        }
        return { simTime: f.simTime, arrived, never, bad, latest };
      });
      r.metrics.hazard = hz;
      check(
        r,
        'hazard fields: water arrived on land dry at reset, every value finite',
        !!hz && hz.arrived > 0 && hz.bad === 0 && hz.latest <= hz.simTime,
        hz ? `${hz.arrived} cells reached since reset (latest at ${num(hz.latest / 60, 1)} of ${num(hz.simTime / 60, 1)} min), ${hz.never} never wet, ${hz.bad} non-finite` : 'readHazardFields missing',
      );
      await D(() => window.__deluge.setWaterMode('arrival'));
      await sleep(400);
      await shot('03c-levee-arrival');
      await D(() => window.__deluge.setWaterMode('hazard'));
      await sleep(400);
      await shot('03d-levee-hazard');
      await D(() => window.__deluge.setWaterMode('realistic'));
    },
  },
  {
    id: 4,
    name: 'Crank the rain → streets pond',
    timeoutMs: 300_000,
    async run(r) {
      // Rivers keep draining toward their steady state after a reset, so "volume went up" alone is not a
      // valid test. Compare against a no-rain control run from the same initial state instead.
      const grid = (await state(['grid'])).grid;
      await calm();
      await runFor(60);
      const base = await stats();
      const controlSecs = await runFor(900);
      const control = await stats();
      await calm();
      await runFor(60);
      const before = await stats();
      await D(() => window.__deluge.setRain(100));
      const secs = await runFor(900);
      const after = await stats();
      const expectedRain = (100 / 1000 / 3600) * 900 * grid.nx * grid.ny * grid.cellSize ** 2;
      const gain = (after?.volume ?? 0) - (control?.volume ?? 0);
      r.metrics = { base, control, before, after, expectedRainVolume: expectedRain, runSeconds: secs + controlSecs };
      check(r, 'rain adds water vs a no-rain control', gain > 0, `${m3(control?.volume)} without rain → ${m3(after?.volume)} with 100 mm/hr (Δ ${m3(gain)}, rain delivered ≈ ${m3(expectedRain)})`);
      check(r, 'retained ≥ 20 % of the rain after 15 min (rest drains / leaves domain)', gain >= 0.2 * expectedRain, `${num((gain / expectedRain) * 100, 1)} %`, { soft: true });
      check(r, 'rain is accounted as inflow', (after?.volumeIn ?? 0) - (before?.volumeIn ?? 0) >= 0.9 * expectedRain, `volumeIn +${m3((after?.volumeIn ?? 0) - (before?.volumeIn ?? 0))}`);
      check(r, 'wet area grows (streets pond)', (after?.wetArea ?? 0) > (control?.wetArea ?? 0), `${km2(control?.wetArea ?? 0)} → ${km2(after?.wetArea ?? 0)}`);
      check(r, 'mass balance error < 1 %', (after?.massError ?? 1) < 0.01, `${num((after?.massError ?? NaN) * 100, 4)} %`);
      await D(() => window.__deluge.setWaterMode('depth'));
      await D(() => window.__deluge.actions.cameraFrameAll());
      await sleep(1800);
      await shot('04-rain-depth-mode');
      await D(() => {
        window.__deluge.setRain(0);
        window.__deluge.setWaterMode('realistic');
      });
    },
  },
  {
    id: 5,
    name: 'Evacuation route re-plans as roads flood',
    timeoutMs: 420_000,
    async run(r) {
      await ensureControlFlood(r);
      const crest = await crestOffset();
      await calm();
      await runFor(30);
      const shelters = await D(() => window.__deluge.getState().shelters.length);
      check(r, 'scenario has shelters', shelters > 0, `${shelters} shelters`);

      // Pittsburgh: Downtown / Strip District / North Shore candidates; prefer one that floods in the control run.
      const candidates = [
        { name: 'Strip District (Penn Ave)', lat: 40.4509, lon: -79.9858 },
        { name: 'Downtown (Penn Ave & 7th)', lat: 40.4436, lon: -80.0004 },
        { name: 'Point State Park area', lat: 40.4425, lon: -80.0085 },
        { name: 'North Shore', lat: 40.4468, lon: -80.0100 },
        { name: 'Market Square', lat: 40.4406, lon: -80.0023 },
      ];
      // Generic candidates (any preset): land that floods in the control run, nearest the domain center first.
      const auto = await D(() => {
        const { initial, control } = window.__e2e;
        const { w, h, stride } = control;
        const out = [];
        for (let y = 1; y < h - 1; y++)
          for (let x = 1; x < w - 1; x++) {
            const k = y * w + x;
            if (control.data[k] > 0.3 && control.data[k] < 3 && initial.data[k] < 0.01)
              out.push({ gx: (x + 0.5) * stride, gy: (y + 0.5) * stride, d: Math.hypot(x - w / 2, y - h / 2) });
          }
        out.sort((a, b) => a.d - b.d);
        const g = window.__deluge.getState().grid;
        // Flooded cells first, then points on the land around them (more likely to be near a street).
        const seeds = out.filter((_, i) => i % 5 === 0).slice(0, 16);
        const ring = [];
        for (const r of [12, 28, 48])
          for (const p of seeds)
            for (let a = 0; a < 8; a++) {
              const gx = p.gx + r * Math.cos((a * Math.PI) / 4), gy = p.gy + r * Math.sin((a * Math.PI) / 4);
              if (gx > 1 && gy > 1 && gx < g.nx - 1 && gy < g.ny - 1) ring.push({ gx, gy });
            }
        return [...seeds, ...ring].slice(0, 160).map((p) => {
          const geo = window.__deluge.gridToGeo(p.gx, p.gy);
          return { name: `auto (${Math.round(p.gx)}, ${Math.round(p.gy)}) of ${g.nx}`, lat: geo.lat, lon: geo.lon };
        });
      });
      if (PRESET !== 'pittsburgh') candidates.length = 0;
      candidates.push(...auto);
      let chosen = null;
      for (const c of candidates) {
        const res = await D((cand) => {
          const d = window.__deluge;
          const p = d.geoToGrid(cand.lon, cand.lat);
          const g = d.getState().grid;
          if (!p || p.gx < 0 || p.gy < 0 || p.gx >= g.nx || p.gy >= g.ny) return null;
          d.setEvacStart(p);
          const route = d.getRoute();
          const { control } = window.__e2e;
          let floods = 0;
          const cx = Math.floor(p.gx / control.stride), cy = Math.floor(p.gy / control.stride);
          for (let oy = -3; oy <= 3; oy++)
            for (let ox = -3; ox <= 3; ox++) {
              const v = control.data[(cy + oy) * control.w + (cx + ox)];
              if (v > 0.3) floods++;
            }
          return { p, state: route?.state ?? 'none', floods };
        }, c);
        if (!res || res.state !== 'ok') continue;
        if (!chosen || (chosen.floods === 0 && res.floods > 0)) chosen = { ...c, ...res };
        if (res.floods > 0) break;
      }
      check(r, 'route found from a downtown start at normal stage', !!chosen, chosen ? `${chosen.name} (floods nearby: ${chosen.floods > 0})` : 'no candidate produced an ok route');
      if (!chosen) return;
      await D((p) => window.__deluge.setEvacStart(p), chosen.p);
      await D(() => window.__deluge.waitFrames(3));
      const before = await D(() => window.__deluge.getRoute());
      const roadsBefore = await D(() => window.__deluge.getRoadStatusCounts());
      r.metrics.before = { state: before?.state, length: before?.lengthMeters, eta: before?.etaSeconds, message: before?.message };
      const ground = await D((p) => window.__deluge.sampleAt(p.gx, p.gy).ground, chosen.p);
      await D(
        (p) => window.__deluge.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: p.elev }, distance: 4200, yaw: 0.35, pitch: 0.95 }),
        { ...chosen.p, elev: ground },
      );
      await sleep(800);
      await shot('05a-evac-normal-stage');

      await D((o) => window.__deluge.setStageOffset(o), crest.offset);
      await runFor(1800);
      await sleep(700); // routing refresh ≤ 4 Hz
      const after = await D(() => window.__deluge.getRoute());
      const roadsAfter = await D(() => window.__deluge.getRoadStatusCounts());
      r.metrics.after = { state: after?.state, length: after?.lengthMeters, eta: after?.etaSeconds, message: after?.message };
      r.metrics.roads = { before: roadsBefore, after: roadsAfter };
      const changed =
        after?.state === 'blocked' ||
        after?.state !== before?.state ||
        Math.abs((after?.lengthMeters ?? 0) - (before?.lengthMeters ?? 0)) > 1 ||
        after?.message !== before?.message;
      check(r, 'route changes or becomes blocked at the crest', changed, `${before?.state} “${before?.message}” → ${after?.state} “${after?.message}”`);
      check(r, 'more roads flooded at the crest', (roadsAfter?.flooded ?? 0) > (roadsBefore?.flooded ?? 0), `${roadsBefore?.flooded ?? '?'} → ${roadsAfter?.flooded ?? '?'} of ${roadsAfter?.total ?? '?'}`);
      await shot('05b-evac-crest');
      // Leave no route behind: the later flows expect a clean map.
      await D(() => window.__deluge.setEvacStart(null));
    },
  },
  {
    id: 6,
    name: 'Other presets load and run 300 s',
    timeoutMs: 600_000,
    async run(r) {
      for (const id of OTHER_PRESETS) {
        const t0 = Date.now();
        let ok = true;
        try {
          await D((p) => window.__deluge.loadPreset(p), id);
        } catch (e) {
          ok = false;
          check(r, `${id}: loads`, false, e.message);
          continue;
        }
        const loadS = (Date.now() - t0) / 1000;
        const presetId = (await state(['presetId'])).presetId;
        check(r, `${id}: loads`, ok && presetId === id, `${loadS.toFixed(2)} s (presetId ${presetId})`);
        await D(() => window.__deluge.setPaused(false));
        const secs = await runFor(300);
        const s = await stats();
        r.metrics[id] = { loadSeconds: loadS, runSeconds: secs, stats: s };
        check(r, `${id}: runs 300 s with sane stats`, statsFinite(s) && s.maxSpeed < 50, s ? `volume ${m3(s.volume)}, maxDepth ${num(s.maxDepth)} m, maxSpeed ${num(s.maxSpeed)} m/s, massErr ${num(s.massError * 100, 4)} % (${secs.toFixed(1)} s real)` : 'no stats');
        await sleep(2400); // camera fly-in
        await shot(`06-${id}`);
      }
    },
  },
  {
    id: 7,
    name: 'Every tool selectable via keyboard 1…0',
    timeoutMs: 180_000,
    async run(r) {
      await D(() => window.__deluge.setPaused(false));
      const cx = WIDTH / 2;
      const cy = HEIGHT / 2 + 60;
      // Focus the page without triggering tool actions (orbit tool: a click is a no-op).
      await page.keyboard.press('1');
      await page.mouse.click(cx, cy);
      const seen = [];
      for (const key of TOOL_KEYS) {
        await page.keyboard.press(key);
        await D(() => window.__deluge.waitFrames(2));
        const tool = (await state(['tool'])).tool;
        seen.push(tool);
        // Exercise the tool: hover, short drag, release.
        await page.mouse.move(cx - 40, cy);
        await D(() => window.__deluge.waitFrames(2));
        await page.mouse.down();
        for (let k = 1; k <= 6; k++) {
          await page.mouse.move(cx - 40 + k * 14, cy + k * 4);
          await D(() => window.__deluge.waitFrames(1));
        }
        await page.mouse.up();
        await D(() => window.__deluge.waitFrames(4));
        if (key === '0') await shot('07-probe-tool');
      }
      r.metrics.keyToTool = Object.fromEntries(TOOL_KEYS.map((k, i) => [k, seen[i]]));
      const distinct = new Set(seen);
      const missing = ALL_TOOLS.filter((t) => !distinct.has(t));
      check(r, 'keys 1…0 select all 10 tools', distinct.size === 10 && missing.length === 0, TOOL_KEYS.map((k, i) => `${k}:${seen[i]}`).join(' ') + (missing.length ? ` missing: ${missing.join(',')}` : ''));
      await page.keyboard.press('Escape');
      await page.keyboard.press('1');
      await D(() => {
        window.__deluge.actions.restoreScenario();
        window.__deluge.actions.clearWalls();
        window.__deluge.setEvacStart(null);
      });
      const tool = (await state(['tool'])).tool;
      check(r, 'back to navigate tool', tool === 'orbit', tool);
    },
  },
  {
    id: 8,
    name: `Frame rate ≥ 30 fps at 1600×1000 (${PRESET}, 60× speed)`,
    timeoutMs: 180_000,
    async run(r) {
      const cur = (await state(['presetId'])).presetId;
      if (cur !== PRESET) await D((p) => window.__deluge.loadPreset(p), PRESET);
      await D(() => {
        const d = window.__deluge;
        d.setPaused(false);
        d.setTimeScale(60);
        d.setRain(0);
        d.setWaterMode('realistic');
      });
      await sleep(3000); // fly-in + shader warm-up
      const sample = await D(
        () =>
          new Promise((resolve) => {
            let frames = 0;
            const t0 = performance.now();
            const tick = (t) => {
              frames++;
              if (t - t0 >= 3000) resolve({ frames, ms: t - t0, ema: window.__deluge.getFps(), step: window.__deluge.getState().stepInfo });
              else requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          }),
      );
      const fps = (sample.frames * 1000) / sample.ms;
      r.metrics = { fps, emaFps: sample.ema, stepInfo: sample.step };
      check(r, 'fps ≥ 30 over 3 s', fps >= 30, `${fps.toFixed(1)} fps (EMA ${num(sample.ema, 1)}), ${sample.step?.substeps ?? '?'} substeps/frame, dt ${num(sample.step?.dt ?? NaN, 3)} s`);
      await shot(`08-fps-${PRESET}`);
    },
  },
  {
    id: 9,
    name: 'Power: paused view goes idle, input wakes it',
    timeoutMs: 120_000,
    async run(r) {
      // Count renderer.render() calls from inside the page (the loop keeps running rAF callbacks cheaply).
      await D(() => {
        const d = window.__deluge;
        const renderer = d.getRenderer();
        if (!window.__e2eRenderCount) {
          window.__e2eRenderCount = { n: 0 };
          const orig = renderer.render.bind(renderer);
          renderer.render = (settings) => {
            window.__e2eRenderCount.n++;
            return orig(settings);
          };
        }
        d.setPaused(false);
      });
      const countOver = (ms) =>
        D(async (dur) => {
          const c = window.__e2eRenderCount;
          const d = window.__deluge;
          const n0 = c.n;
          const t0 = d.getSimClock();
          await new Promise((res) => setTimeout(res, dur));
          return { renders: c.n - n0, simAdvanced: d.getSimClock() - t0, anim: d.getPerf().animTime };
        }, ms);
      const running = await countOver(2000);
      await D(() => window.__deluge.setPaused(true));
      await sleep(1800); // hold period after the last change
      const idle = await countOver(3000);
      const idle2 = await countOver(1000);
      // Mouse input over the canvas wakes full-rate rendering (camera/tools need it).
      const woke = D(async () => {
        const c = window.__e2eRenderCount;
        const n0 = c.n;
        await new Promise((res) => setTimeout(res, 800));
        return c.n - n0;
      });
      for (let k = 0; k < 16; k++) {
        await page.mouse.move(WIDTH / 2 + k * 6, HEIGHT / 2);
        await sleep(45);
      }
      const wokeRenders = await woke;
      await D(() => window.__deluge.setPaused(false));
      r.metrics = { running, idle, wokeRenders };
      // Relative to idle (absolute rates vary with other GPU load on the machine).
      const runRate = running.renders / 2;
      const idleRate = idle.renders / 3;
      check(r, 'running: renders every frame (≥ 20/s and ≥ 4× the idle rate)', runRate >= 20 && runRate >= 4 * idleRate, `${runRate.toFixed(0)} renders/s running vs ${idleRate.toFixed(1)}/s idle, ${num(running.simAdvanced, 0)} sim s`);
      check(r, 'paused: sim time frozen', idle.simAdvanced === 0, `${num(idle.simAdvanced)} sim s advanced`);
      check(r, 'paused + idle: ≤ 6 renders/s', idle.renders <= 18, `${(idle.renders / 3).toFixed(1)} renders/s`);
      check(r, 'paused + idle: animation clock frozen', idle.anim === idle2.anim, `${num(idle.anim, 3)} → ${num(idle2.anim, 3)} s`);
      check(r, 'input wakes full-rate rendering', wokeRenders >= 25, `${wokeRenders} renders in 0.8 s of mouse movement`);
    },
  },
  {
    id: 10,
    name: 'Live area: real USGS data for any US location (network)',
    timeoutMs: 240_000,
    optIn: 'live',
    network: true,
    async run(r) {
      const req = { center: { lat: 40.4443, lon: -79.9608 }, sizeMeters: 4000, resolution: 512, name: 'Oakland, Pittsburgh (live)' };
      const t0 = Date.now();
      const outcome = await D(async (q) => {
        const d = window.__deluge;
        await d.actions.loadLiveArea(q);
        const s = d.getState();
        return { presetId: s.presetId, name: s.terrainName, grid: s.grid, attribution: s.attribution };
      }, req);
      const loadS = (Date.now() - t0) / 1000;
      check(r, 'live area loaded', outcome.name && outcome.grid?.nx === req.resolution, `“${outcome.name}” ${outcome.grid?.nx}×${outcome.grid?.ny} @ ${num(outcome.grid?.cellSize)} m in ${loadS.toFixed(1)} s`);
      check(r, 'attribution shown', /USGS|3DEP/i.test(outcome.attribution ?? ''), outcome.attribution);
      await D(() => window.__deluge.setRain(50));
      const secs = await runFor(600);
      const s = await stats();
      check(r, 'rain ponds on live terrain', (s?.volume ?? 0) > 0 && statsFinite(s), s ? `volume ${m3(s.volume)}, wet ${km2(s.wetArea)} (${secs.toFixed(1)} s real)` : 'no stats');
      await D(() => window.__deluge.setRain(0));
      await sleep(2000);
      await shot('10-live-area');
      r.metrics = { loadSeconds: loadS, requests: externalRequests.length };
    },
  },
  {
    id: 11,
    name: 'Cancel a ?live= link while it loads → offline scenario',
    timeoutMs: 180_000,
    resetsPage: true,
    stallNetwork: true,
    async run(r, ctx) {
      // A reload after picking a live area, on venue wifi that stalls: the USGS / Esri / TIGER requests never answer.
      const live = new URL(ctx.baseUrl);
      live.search = '?live=40.25980,-76.88700,6&name=Harrisburg,+Pennsylvania';
      await page.goto(live.href, { waitUntil: 'domcontentloaded' });
      const cancel = page.locator('.dl-loading-cancel');
      await cancel.waitFor({ state: 'visible', timeout: 90_000 });
      // The Cancel button appears the instant the live load starts — BEFORE the first USGS request has been issued,
      // and well before Playwright's route handler has run in this process. Reading externalRequests right here is a
      // sampling race (it was 0 in Brave, 5 in Chromium: artifacts/browsers3/e2e-brave-noflags.log). Wait for the
      // requests to actually be held, with the same "> 0" bar — a stall that never issues one still fails.
      const stalled = await waitFor(() => stalledRoutes.length > 0, 30_000);
      const before = await D(() => window.__deluge.getState().loading);
      check(
        r,
        'live download stalls with Cancel offered',
        !!before?.cancellable && stalled,
        `“${before?.message}”, ${stalledRoutes.length} of ${externalRequests.length} requests held unanswered`,
      );
      const t0 = Date.now();
      await cancel.click();
      const shown = await page
        .waitForFunction(() => window.__deluge.getState().presetId && !window.__deluge.getState().loading, null, { timeout: 30_000 })
        .then(() => true, () => false);
      const loadS = (Date.now() - t0) / 1000;
      const after = await D(async () => {
        const d = window.__deluge;
        const ready = await Promise.race([d.ready.then(() => 'ready', (e) => `rejected: ${e.message}`), new Promise((res) => setTimeout(() => res('pending'), 10_000))]);
        const s = d.getState();
        const notice = [...document.querySelectorAll('button')].find((b) => /^Retry /.test(b.textContent ?? ''));
        return { ready, presetId: s.presetId, name: s.terrainName, search: location.search, retry: notice?.textContent ?? null };
      });
      check(r, 'Cancel shows the offline default scenario (not a black screen)', shown && after.presetId === 'pittsburgh' && after.ready === 'ready', `${after.name || '(nothing)'} in ${loadS.toFixed(1)} s, ready ${after.ready}`);
      // SEC-01: the area is named by its coordinates, never by the `?name=` the link carried — an attacker must not
      // get a sentence of their own into the app's chrome. The link says "Harrisburg, Pennsylvania"; the button
      // must not.
      check(
        r,
        'notice offers a retry, naming the area by its coordinates and not by the link (SEC-01)',
        !!after.retry && after.retry.includes('40.260, -76.887') && !/Harrisburg/i.test(after.retry),
        after.retry ?? 'no retry button',
      );
      check(r, 'address bar points at the preset (a reload does not download again)', after.search === '?preset=pittsburgh', after.search);
      await shot('11-startup-cancel');
      await releaseStalled();
      const held = externalRequests.length;
      await page.goto(page.url(), { waitUntil: 'domcontentloaded' });
      await waitReady(90_000);
      const reloaded = (await state(['presetId'])).presetId;
      check(r, 'reload opens the preset without any network request', reloaded === 'pittsburgh' && externalRequests.length === held, `${reloaded}, ${externalRequests.length - held} new external requests`);
      r.metrics = { cancelToSceneSeconds: loadS, heldRequests: held };
      // Leave the page on the preset the later flows expect.
      if (page.url() !== ctx.appUrl) {
        await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
        await waitReady(90_000);
      }
    },
  },
  {
    id: 12,
    name: 'One-click levee keeps its land dry at the 1936 crest',
    timeoutMs: 300_000,
    async run(r) {
      const levee = await D(() => window.__deluge.getScenario()?.levee ?? null);
      if (!levee) {
        r.notes.push(`${PRESET} has no demo levee: skipped`);
        check(r, 'scenario without a demo levee (nothing to check)', true, PRESET);
        return;
      }
      await calm();
      // The real Try-it button: raises the wall along its line over ~2 s, then sends the river to the crest.
      await D(() => window.__deluge.store.set({ paused: false }));
      await page.click('.dl-try-step[data-step="levee"]');
      const built = await page
        .waitForFunction(() => {
          const d = window.__deluge;
          const s = d.getState();
          const crest = d.stageOffsetForFeet(Math.max(...(s.scenario?.stage?.marks ?? [{ ft: 0 }]).map((m) => m.ft)));
          return (d.getProtection()?.wallCells ?? 0) > 500 && Math.abs(s.stageOffset - crest) < 0.01;
        }, null, { timeout: 30_000 })
        .then(() => true, () => false);
      const wall = await D(() => window.__deluge.getProtection());
      check(r, 'levee raised and the river sent to the crest', built, `${wall?.wallCells ?? 0} wall cells`);
      await runFor(1500);
      const res = await D(() => {
        const d = window.__deluge;
        const p = d.getProtection();
        const pts = d.getScenario().levee.points;
        // Probe the land behind the middle of the levee: 25 cells inland of its midpoint, away from the river.
        const a = pts[Math.floor(pts.length / 2) - 1];
        const b = pts[Math.floor(pts.length / 2)];
        const mid = { gx: (a.gx + b.gx) / 2, gy: (a.gy + b.gy) / 2 };
        const len = Math.hypot(b.gx - a.gx, b.gy - a.gy) || 1;
        const n = { gx: (b.gy - a.gy) / len, gy: -(b.gx - a.gx) / len };
        const probe = (sgn) => d.sampleAt(mid.gx + sgn * n.gx * 25, mid.gy + sgn * n.gy * 25);
        const [s1, s2] = [probe(1), probe(-1)];
        const status = [...document.querySelectorAll('.dl-try-status-kept')].find((e) => !e.hidden)?.textContent ?? null;
        const overtopNotice = [...document.querySelectorAll('.dl-toast')].some((t) => t.getClientRects().length > 0 && /pouring over your wall/i.test(t.textContent ?? ''));
        return { p, sides: [s1, s2], status, overtopNotice, stats: d.getStats() };
      });
      const p = res.p;
      const glow = await D(() => {
        const d = window.__deluge;
        return { maskOn: !!d.getRenderer()?.scene?.protectOn, offThread: !!d.app.protection.backend };
      });
      check(r, 'protected land glows on the map (mask uploaded)', glow.maskOn, glow.maskOn ? 'mask on' : 'no mask');
      check(r, 'analysis runs in its Web Worker (not on the main thread)', glow.offThread, glow.offThread ? 'worker' : 'main-thread fallback');
      const dryBehind = Math.min(res.sides[0].depth, res.sides[1].depth);
      const wetFront = Math.max(res.sides[0].depth, res.sides[1].depth);
      check(r, 'land behind the levee stays dry while the river side floods', dryBehind < 0.05 && wetFront > 1, `behind ${num(dryBehind)} m, river side ${num(wetFront)} m`);
      check(r, 'protected-land analysis reports the land it keeps dry', (p?.areaM2 ?? 0) > 0.3e6, p ? `${km2(p.areaM2)}, ${num(p.roadMeters / 1000, 1)} km of streets, level ${num(p.level ?? NaN)} m, ${num(p.ms, 1)} ms` : 'none');
      check(r, 'status line under the Try-it strip counts it', /Walls keep \d[\d,]* acres dry/.test(res.status ?? ''), res.status ?? 'hidden');
      check(r, 'no false "water is pouring over your wall" alarm', !res.overtopNotice, res.overtopNotice ? 'notice shown' : 'none');
      check(r, 'stats stay finite', statsFinite(res.stats), `mass error ${res.stats?.massError}`);
      r.metrics = { protection: p, flooded: res.stats?.floodedArea };
      await D((c) => window.__deluge.setCamera(c), levee.camera);
      await sleep(800);
      await shot('12-demo-levee');
      // The step toggles: "Remove levee" clears the walls, the status line and the glow.
      const label = await page.locator('.dl-try-step[data-step="levee"]').textContent();
      await page.click('.dl-try-step[data-step="levee"]');
      const removed = await page
        .waitForFunction(
          () => {
            const d = window.__deluge;
            const kept = [...document.querySelectorAll('.dl-try-status-kept')].some((e) => !e.hidden);
            return (d.getProtection()?.wallCells ?? 0) === 0 && !kept && !d.getRenderer()?.scene?.protectOn;
          },
          null,
          { timeout: 10_000 },
        )
        .then(() => true, () => false);
      const after = await page.locator('.dl-try-step[data-step="levee"]').textContent();
      check(r, '"Remove levee" clears the walls, the count and the glow', /remove levee/i.test(label ?? '') && removed && /build a levee/i.test(after ?? ''), `“${label?.trim()}” → “${after?.trim()}”, cleared ${removed}`);
      await calm();
    },
  },
  {
    id: 15,
    name: 'Site check: drop a site in Pittsburgh, sweep two levels, export the assessment',
    timeoutMs: 300_000,
    async run(r) {
      if (PRESET !== 'pittsburgh') {
        r.notes.push(`${PRESET}: the flow is written for Pittsburgh's ladder: skipped`);
        check(r, 'preset without the Pittsburgh ladder (nothing to check)', true, PRESET);
        return;
      }
      await calm();
      // A riverfront lot at the Point: dry at NWS minor flood, under about a metre at FEMA's 1 % level.
      const site = { lat: 40.4425, lon: -80.0085 };
      const g = await D((p) => window.__deluge.geoToGrid(p.lon, p.lat), site);
      const before = await D(() => {
        const s = window.__deluge.getState();
        return { stageOffset: s.stageOffset, paused: s.paused, sources: s.sources.length };
      });
      await D((p) => {
        const d = window.__deluge;
        const ground = d.sampleAt(p.gx, p.gy).ground;
        d.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: ground }, distance: 900, yaw: 0, pitch: Math.PI / 2 - 0.01 });
      }, g);
      await D(() => window.__deluge.waitFrames(4));
      await D(() => window.__deluge.selectTool('site'));
      const box = await page.locator('#deluge-canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const placed = await page
        .waitForFunction(() => document.querySelectorAll('.dl-site-item').length === 1 && document.querySelector('[data-section="site"]')?.classList.contains('dl-open'), null, { timeout: 5000 })
        .then(() => true, () => false);
      check(r, 'a click with the Site tool drops a site and opens the Site check section', placed, placed ? '1 site' : 'none');
      await D(() => window.__deluge.selectTool('orbit'));

      // This run: assess the calm river (the site must be dry, and reach a shelter).
      await page.click('[data-section="site"] button:has-text("Assess this run")');
      await page.waitForFunction(() => /Flood at T\+/.test(document.querySelector('[data-section="site"] .dl-impact-status')?.textContent ?? ''), null, { timeout: 20_000 });
      const card = await D(() => document.querySelector('.dl-site-card')?.textContent ?? '');
      await D(() => document.querySelector('.dl-site-card')?.scrollIntoView({ block: 'center' }));
      await sleep(400);
      const cardShot = path.join(OUT, '15-site-card.png');
      await page.locator('.dl-panel').screenshot({ path: cardShot });
      console.log(`  [shot] ${path.relative(ROOT, cardShot)}`);
      check(r, 'site card renders for the flood on screen (dry, with egress)', /Water at the site/.test(card) && /Egress to a shelter/.test(card), card.slice(0, 160));

      // Sweep: NWS minor flood and FEMA's 1 % (100-yr) level only, 4 simulated minutes each (the river ramps at ~3 m/min).
      await page.fill('[data-site-field="duration"]', '4');
      await page.dispatchEvent('[data-site-field="duration"]', 'change');
      await D(() => {
        for (const box of document.querySelectorAll('.dl-site-ladder input[type=checkbox]')) {
          const want = box.dataset.level === 'minor' || box.dataset.level === 'rp100';
          if (box.checked !== want) box.click();
        }
      });
      const t0 = Date.now();
      await page.click('[data-site="run-sweep"]');
      const done = await page
        .waitForFunction(() => /^(Done|Sweep stopped|Cancelled)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 240_000 })
        .then(() => true, () => false);
      const sweepS = (Date.now() - t0) / 1000;
      const out = await D(() => ({
        status: document.querySelector('[data-site="sweep-status"]')?.textContent ?? '',
        verdict: [...document.querySelectorAll('[data-site="verdict"] p')].map((p) => p.textContent),
        rows: document.querySelectorAll('.dl-site-sweep-out table tbody tr').length,
        chart: !!document.querySelector('.dl-site-sweep-out svg.dl-site-chart'),
        state: (() => {
          const s = window.__deluge.getState();
          return { stageOffset: s.stageOffset, paused: s.paused, sources: s.sources.length };
        })(),
      }));
      check(r, 'two-level sweep completes', done && /^Done: 2 levels/.test(out.status), `${out.status.slice(0, 90)} (${num(sweepS, 1)} s wall)`);
      check(r, 'sweep table has both levels and a verdict', out.rows >= 2 && out.verdict.length >= 3, `${out.rows} rows; ${out.verdict[0] ?? ''}`);
      const timed = out.verdict.find((v) => /occupants out before the last route closes|no route to a shelter closes during the run/.test(v ?? '')) ?? '';
      check(r, 'the verdict says who gets out by road: share out, clearance vs route window', /Clearance time .+ vs (route window|a route window)/.test(timed), timed.slice(0, 200));
      check(r, 'the user’s scenario is put back (stage, play state, sources)', JSON.stringify(out.state) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(out.state)}`);
      r.metrics.sweepSeconds = sweepS;
      r.metrics.verdict = out.verdict;
      await D(() => document.querySelector('[data-site="verdict"]')?.scrollIntoView({ block: 'start' }));
      await sleep(400);
      const panelShot = path.join(OUT, '15-site-sweep.png');
      await page.locator('.dl-panel').screenshot({ path: panelShot });
      console.log(`  [shot] ${path.relative(ROOT, panelShot)}`);
      await shot('15-site-map');

      // Export: the standalone report, as a download.
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-site="report-html"]')]);
      const file = path.join(OUT, '15-site-assessment.html');
      await dl.saveAs(file);
      const html = fs.readFileSync(file, 'utf8');
      const has = ['site assessment', 'Verdict', 'Sweep', 'Expected annual loss', 'Egress timeline', 'Occupants out before it closes', 'Clearance vs window', 'Recommendations (indicative)', 'Limitations', 'NWS minor flood', 'FEMA 1 % (100-yr)', 'ASCE 24-14', 'Freeboard', 'BCR 7 %'];
      const missing = has.filter((s) => !html.includes(s));
      check(r, 'site assessment report renders every section', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : `${(html.length / 1024).toFixed(0)} KB`);
      check(r, 'report carries no script', !/<script/i.test(html), 'no <script>');
      // Render the downloaded report for a screenshot.
      const rp = await page.context().newPage();
      await rp.setContent(html);
      const reportShot = path.join(OUT, '15-site-report.png');
      await rp.screenshot({ path: reportShot, fullPage: true });
      await rp.close();
      console.log(`  [shot] ${path.relative(ROOT, reportShot)}`);
      await calm();
    },
  },
  {
    id: 13,
    name: 'Screen Wake Lock holds the display awake while the pitch runs',
    timeoutMs: 60_000,
    async run(r) {
      // A running simulation is not "user activity" to macOS, so without this the demo laptop's display dims and
      // blanks mid-pitch (artifacts/browsers3: 2 min on battery). src/app/wakeLock.ts asks the browser to hold it.
      const held = await page
        .waitForFunction(() => window.__deluge.getWakeLock().held, null, { timeout: 15_000 })
        .then(() => true, () => false);
      const status = await D(() => window.__deluge.getWakeLock());
      r.metrics = { wakeLock: status };
      check(r, 'the browser supports the Screen Wake Lock API', status.supported, status.supported ? 'navigator.wakeLock' : 'missing');
      check(r, 'a screen wake lock is held while the tab is visible', held && status.held && status.acquired >= 1, `held ${status.held}, acquired ${status.acquired}, error ${status.lastError ?? 'none'}`);

      // Hidden tabs must hand the lock back (the browser would anyway; the app says so explicitly so its own state
      // stays honest). document.visibilityState is read-only, so the getter is swapped for the length of the check.
      const hide = (hidden) =>
        D((h) => {
          const saved = window.__e2eVis ?? (window.__e2eVis = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState'));
          if (h) Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => 'hidden' });
          else Object.defineProperty(Document.prototype, 'visibilityState', saved);
          document.dispatchEvent(new Event('visibilitychange'));
        }, hidden);
      await hide(true);
      const released = await page
        .waitForFunction(() => !window.__deluge.getWakeLock().held, null, { timeout: 10_000 })
        .then(() => true, () => false);
      check(r, 'the lock is released when the tab is hidden', released, released ? 'released' : 'still held');

      await hide(false);
      const regained = await page
        .waitForFunction(() => window.__deluge.getWakeLock().held, null, { timeout: 10_000 })
        .then(() => true, () => false);
      const after = await D(() => window.__deluge.getWakeLock());
      r.metrics.wakeLockAfter = after;
      check(
        r,
        're-requested when the tab comes back (the browser drops it on every hide)',
        regained && after.acquired > status.acquired,
        `held ${after.held}, acquired ${status.acquired} → ${after.acquired}`,
      );
      check(r, 'no refusals along the way', after.lastError === null, after.lastError ?? 'none');
    },
  },
  {
    id: 14,
    name: 'GPU lost while a scene loads → the load is abandoned, not run on a dead device',
    timeoutMs: 180_000,
    resetsPage: true,
    stallNetwork: true,
    // Destroying the device is the point of the flow; these are what a working loss looks like.
    expectedErrors: /GPU device lost|Device was destroyed|device was lost/i,
    async run(r, ctx) {
      // artifacts/soak3/t3-devlost.json, S5b: the GPU died while a live area was downloading. The load carried on,
      // timed out 15 s later, fell back to a preset and reported THAT as the scene — on a destroyed device, and over
      // the address bar the loss handler had just set. src/app/scene.ts abandon() stops it; this flow proves it.
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(90_000);
      // Seed this tab's reload history so the card waits for the user (two losses already in the window) and so its
      // lead has a real "how long did it run" to report: 4 minutes, which it must NOT call "again after restarting".
      await D(() => {
        const now = Date.now();
        sessionStorage.setItem('deluge:gpu-lost-reload-at', JSON.stringify([now - 300_000, now - 240_000]));
      });

      const live = new URL(ctx.baseUrl);
      live.search = '?live=40.25980,-76.88700,6&name=Harrisburg,+Pennsylvania';
      await page.goto(live.href, { waitUntil: 'domcontentloaded' });
      await page.locator('.dl-loading-cancel').waitFor({ state: 'visible', timeout: 90_000 });
      await waitFor(() => stalledRoutes.length > 0, 30_000);
      const before = await D(() => ({ search: location.search, loading: window.__deluge.getState().loading, presetId: window.__deluge.getState().presetId }));
      check(r, 'a live scene is downloading when the device dies', !!before.loading && before.presetId === null, `“${before.loading?.message}”, ${stalledRoutes.length} requests held`);

      await D(() => window.__deluge.app.gpu.device.destroy());
      const carded = await page
        .waitForFunction(() => document.getElementById('deluge-fatal'), null, { timeout: 30_000 })
        .then(() => true, () => false);
      const card = await D(() => {
        const root = document.getElementById('deluge-fatal');
        if (!root) return null;
        return {
          title: root.querySelector('h1')?.textContent ?? '',
          lead: root.querySelector('.lead')?.textContent ?? '',
          countdown: root.querySelector('.countdown')?.textContent ?? null,
          buttons: [...root.querySelectorAll('button')].map((b) => b.textContent?.trim()),
          search: location.search,
          usable: window.__deluge.app.scenes?.usable ?? null,
        };
      });
      r.metrics = { card };
      check(r, 'the device-lost card takes over', carded && /Lost connection to the GPU/.test(card?.title ?? ''), card?.title ?? 'no card');
      check(r, 'the load in flight is abandoned at once (no work left on the dead device)', card?.usable === false, `scenes.usable ${card?.usable}`);
      check(
        r,
        'the card does not claim the driver "reset again after restarting" when it ran for minutes',
        !!card && !/again after restarting/.test(card.lead) && /ran for 4 minutes/.test(card.lead),
        `“${(card?.lead ?? '').slice(0, 120)}…”`,
      );
      check(
        r,
        'a non-default scene gets a way out besides Reload',
        !!card && card.buttons.includes('Reload this scene') && card.buttons.some((b) => /^Start with /.test(b ?? '')),
        (card?.buttons ?? []).join(' · ') || 'no buttons',
      );
      check(r, 'it waits for the user rather than reloading into the same loss', card?.countdown === null, card?.countdown ?? 'no countdown');
      check(r, 'the address bar still points at the scene that was loading', card?.search === before.search, `${card?.search}`);
      await shot('14-device-lost-mid-load');

      // Let the held downloads fail, which is what used to wake the abandoned load up: it gave up, ran its fallback
      // and rewrote the address bar behind the card. Nothing may happen now.
      await releaseStalled();
      await sleep(8000);
      const after = await D(() => {
        const s = window.__deluge.getState();
        return { search: location.search, presetId: s.presetId, terrainName: s.terrainName, scene: !!window.__deluge.app.scenes?.scene };
      });
      r.metrics.after = after;
      check(r, 'the abandoned load never rewrites the address bar afterwards', after.search === before.search, `${after.search}`);
      check(r, 'and never builds a fallback scene on the dead device', after.presetId === null && !after.scene, `presetId ${after.presetId}, scene ${after.scene}`);

      // Leave the tab as the later runs expect: no seeded history, the default scene on screen.
      await D(() => sessionStorage.removeItem('deluge:gpu-lost-reload-at'));
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(90_000);
    },
  },
  {
    id: 16,
    name: 'Glacier hazard chain: the routed wave drives the map, the valley timeline follows it',
    timeoutMs: 600_000,
    async run(r) {
      // src/app/hazardChain.ts runs the chain in a worker on load and swaps the preset's inflow for the routed wave;
      // the panel's Hazard chain section and the valley timeline (src/ui/chainPanel.ts, chainTimeline.ts) draw it.
      for (const id of ['nepal', 'chungthang', 'chamoli']) {
        await D((p) => window.__deluge.loadPreset(p), id);
        const t0 = Date.now();
        const ready = await page
          .waitForFunction(() => window.__deluge.getHazardChain()?.status === 'ready', null, { timeout: 120_000 })
          .then(() => true, () => false);
        const chain = await D(() => window.__deluge.getHazardChain());
        r.metrics[id] = { chainSeconds: (Date.now() - t0) / 1000, status: chain?.status, offset: chain?.offset, entryFront: chain?.entryFront, entryPeak: chain?.entryPeak, error: chain?.error };
        check(r, `${id}: chain ran in the worker (run + 27-member ensemble)`, ready && !!chain?.bands, `${chain?.status} in ${((Date.now() - t0) / 1000).toFixed(1)} s, edge peak ${num(chain?.entryPeak ?? NaN, 0)} m³/s`);
        const sources = await D(() => window.__deluge.getState().sources.map((s) => ({ id: s.id, n: s.hydrograph?.length ?? 0 })));
        check(r, `${id}: the map's inflow is the routed hydrograph`, sources.some((s) => s.id === 'chain-inflow' && s.n > 3), JSON.stringify(sources));

        const ui = await D(() => {
          const vis = (el) => !!el && !el.hidden && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none';
          const sec = document.querySelector('[data-section="chain"]');
          const line = document.querySelector('.dl-chainline');
          const step = (k) => vis(document.querySelector(`.dl-try-step[data-step="${k}"]`));
          return {
            section: vis(sec),
            results: sec?.querySelectorAll('.dl-chain-kv').length ?? 0,
            provenance: [...(sec?.querySelectorAll('.dl-prov') ?? [])].map((b) => b.textContent),
            timeline: vis(line),
            svgs: line?.querySelectorAll('svg.dl-cl-svg').length ?? 0,
            markers: line?.querySelectorAll('.dl-cl-st').length ?? 0,
            chips: line?.querySelectorAll('.dl-cl-chipbox').length ?? 0,
            eventClock: document.querySelector('.dl-clock-event')?.textContent ?? '',
            steps: { flood: step('flood'), arrival: step('arrival'), evac: step('evac'), rain: step('rain'), levee: step('levee') },
            floodLabel: document.querySelector('.dl-try-step[data-step="flood"]')?.textContent ?? '',
          };
        });
        r.metrics[id].ui = ui;
        check(r, `${id}: Hazard chain section with results and provenance badges`, ui.section && ui.results >= 2 && ui.provenance.includes('modelled') && ui.provenance.includes('observed'), `${ui.results} results, badges ${[...new Set(ui.provenance)].join('/')}`);
        check(r, `${id}: valley timeline with profile, hydrograph and stations`, ui.timeline && ui.svgs === 2 && ui.markers >= 4 && ui.chips >= 3, `${ui.svgs} svg, ${ui.markers} markers, ${ui.chips} chips`);
        check(r, `${id}: the real event clock in the top bar`, /\d{4} \d\d:\d\d.(NPT|IST)$/.test(ui.eventClock.replace(/\u00a0/g, ' ')), ui.eventClock);
        check(r, `${id}: Try-it offers the glacier steps, no hurricane rain or levee`, ui.steps.flood && ui.steps.arrival && ui.steps.evac && !ui.steps.rain && !ui.steps.levee && /Release the flood/.test(ui.floodLabel), JSON.stringify(ui.steps));

        // Early warning (src/ui/warningPanel.ts + the sensors on the timeline): add a sensor by clicking the profile at
        // Rasuwagadhi, see Betrawati's lead-time chip get a sensor lead, drag the sensor downstream (less warning), then
        // let the optimiser place one.
        if (id === 'nepal') {
          const ewRead = () =>
            D(() => {
              const chip = document.querySelector('.dl-ew-chip[data-station="Betrawati"]');
              const blk = document.querySelector('[data-ew="block"]');
              return {
                block: !!blk && !blk.hidden,
                chips: document.querySelectorAll('.dl-ew-chip').length,
                lead: chip?.getAttribute('data-lead') ?? null,
                sensorLead: chip?.getAttribute('data-sensor-lead') ?? null,
                sensors: document.querySelectorAll('.dl-ew-sensor').length,
                markers: document.querySelectorAll('.dl-cl-sensor').length,
                timelineChip: document.querySelector('.dl-cl-chipbox[data-station="Betrawati"] .dl-cl-chip-ew:not([hidden])')?.textContent ?? '',
                suggestion: document.querySelector('.dl-ew-suggestion')?.textContent ?? '',
              };
            });
          const stationX = (name) =>
            D((n) => {
              const g = [...document.querySelectorAll('.dl-cl-st')].find((e) => (e.getAttribute('data-tip') ?? '').startsWith(`${n} —`));
              const m = g?.querySelector('.dl-cl-mark')?.getBoundingClientRect();
              const s = g?.ownerSVGElement?.getBoundingClientRect();
              return m && s ? { x: m.left + m.width / 2, y: s.top + s.height / 2 } : null;
            }, name);
          const ew0 = await ewRead();
          check(r, 'nepal: Early warning block with a lead-time chip per town / plant', ew0.block && ew0.chips >= 5 && ew0.lead !== null && ew0.sensorLead === null, JSON.stringify(ew0));
          await page.locator('.dl-ew-add').click();
          const rasu = await stationX('Rasuwagadhi');
          if (rasu) await page.mouse.click(rasu.x, rasu.y);
          await sleep(250);
          const ew1 = await ewRead();
          const lead1 = Number(ew1.sensorLead);
          check(r, 'nepal: a sensor placed on the profile at Rasuwagadhi gives Betrawati a sensor lead time', !!rasu && ew1.sensors === 1 && ew1.markers === 1 && Number.isFinite(lead1) && lead1 > 0 && /sensors: [0-9]/.test(ew1.timelineChip), `${ew1.sensors} sensor, Betrawati ${num(lead1 / 60, 1)} min (combined ${num(Number(ew1.lead) / 60, 1)} min); timeline chip “${ew1.timelineChip}”`);
          // Drag it downstream to Syafrubesi.
          const mk = await D(() => {
            const b = document.querySelector('.dl-cl-sensor .dl-cl-sensor-mark')?.getBoundingClientRect();
            return b ? { x: b.left + b.width / 2, y: b.top + b.height / 2 } : null;
          });
          const syaf = await stationX('Syafrubesi');
          if (mk && syaf) {
            await page.mouse.move(mk.x, mk.y);
            await page.mouse.down();
            await page.mouse.move(syaf.x, mk.y, { steps: 8 });
            await page.mouse.up();
          }
          await sleep(250);
          const ew2 = await ewRead();
          const lead2 = Number(ew2.sensorLead);
          check(r, 'nepal: dragging the sensor downstream shortens the warning (chip updates live)', Number.isFinite(lead2) && lead2 < lead1 - 60, `Betrawati ${num(lead1 / 60, 1)} → ${num(lead2 / 60, 1)} min`);
          await page.locator('.dl-ew-suggest').click();
          await sleep(250);
          const ew3 = await ewRead();
          check(r, 'nepal: Suggest best site places a sensor and says where', ew3.sensors === 2 && ew3.markers === 2 && /km \d/.test(ew3.suggestion) && Number(ew3.sensorLead) >= lead1 - 1, `${ew3.suggestion.slice(0, 120)} · Betrawati ${num(Number(ew3.sensorLead) / 60, 1)} min`);
          r.metrics[id].warning = { atRasuwagadhiMin: lead1 / 60, atSyafrubesiMin: lead2 / 60, best: ew3.suggestion, bestBetrawatiMin: Number(ew3.sensorLead) / 60 };
          await page.locator('.dl-chainline').screenshot({ path: path.join(OUT, '16-nepal-warning-strip.png') });
          await D(() => document.querySelector('[data-ew="block"]')?.scrollIntoView());
          await sleep(300);
          await page.locator('[data-section="chain"]').screenshot({ path: path.join(OUT, '16-nepal-warning-panel.png') });
          await D(() => document.querySelector('.dl-ew-caveats')?.scrollIntoView({ block: 'end' }));
          await sleep(300);
          await page.locator('[data-section="chain"]').screenshot({ path: path.join(OUT, '16-nepal-warning-chart.png') });
          await shot('16-nepal-warning');
        }

        // Advance the flood until every station the front reaches inside the map has been passed.
        const runS = Math.min(3600, Math.max(300, ...chain.stations.filter((s) => Number.isFinite(s.tFront)).map((s) => s.tFront - chain.offset + 60)));
        await D(() => {
          window.__deluge.setPaused(false);
          window.__deluge.actions.resetWater();
        });
        await D(() => window.__deluge.waitFrames(4));
        // The timeline follows the stats readback (~300 ms), not the reset itself: wait until a readback shows the
        // reset clock, or 'before' reads the previous run's lit stations.
        for (let i = 0; i < 50 && (await D(() => window.__deluge.getStats()?.simTime ?? 0)) > 120; i++) await sleep(100);
        // ...and until the timeline has redrawn from it: its updates are coalesced (≤ 10 Hz) and trail the readback, so
        // poll the lit-station count until three reads 150 ms apart agree.
        {
          const lit = () => D(() => document.querySelectorAll('.dl-cl-chipbox.dl-cl-passed').length);
          let prev = await lit();
          for (let i = 0, same = 0; i < 40 && same < 2; i++) {
            await sleep(150);
            const n = await lit();
            same = n === prev ? same + 1 : 0;
            prev = n;
          }
        }
        const read = () =>
          D(() => ({
            x: Number(document.querySelector('.dl-cl-frontline')?.getAttribute('x1') ?? NaN),
            passed: document.querySelectorAll('.dl-cl-chipbox.dl-cl-passed').length,
            chips: document.querySelectorAll('.dl-cl-chipbox').length,
            clock: document.querySelector('.dl-cl-clock')?.textContent ?? '',
            t: window.__deluge.getStats()?.simTime ?? 0,
          }));
        const before = await read();
        if (id === 'nepal') await shot('16-nepal-start');
        await runFor(runS);
        await sleep(400); // the timeline updates at ≤ 10 Hz
        const after = await read();
        r.metrics[id].timeline = { runS, before, after };
        check(r, `${id}: stations light up as the front passes`, after.passed > before.passed, `${before.passed} → ${after.passed} of ${after.chips} lit after ${Math.round(runS)} s`);
        check(r, `${id}: the front moved down the valley`, after.x > before.x, `x ${num(before.x, 1)} → ${num(after.x, 1)} px; clock ${before.clock} → ${after.clock}`);
        await shot(`16-${id}-timeline`);
        await page.locator('.dl-chainline').screenshot({ path: path.join(OUT, `16-${id}-strip.png`) });
        await D(() => document.querySelector('[data-section="chain"]')?.scrollIntoView());
        await sleep(300);
        await page.locator('[data-section="chain"]').screenshot({ path: path.join(OUT, `16-${id}-panel.png`) });
      }
      // Leave the page on the suite's own preset: later flows assume it (the ensemble flow frames Pittsburgh's crest).
      await D((p) => window.__deluge.loadPreset(p), PRESET);
      await waitReady(120_000);
    },
  },
  {
    id: 17,
    name: 'Flood-probability ensemble: 3 members, the probability view and its legend, scenario restored',
    timeoutMs: 600_000,
    async run(r) {
      // src/ui/ensemble.ts: the Uncertainty section runs N perturbed members of the scenario on screen headless (the
      // Site check machinery), folds each member's max depth into a GPU tally (src/sim/ensemble.ts) and switches the
      // map to the 'probability' water view. 3 members × 5 simulated minutes keeps the flow short.
      await calm();
      const crest = await crestOffset();
      const ft = PRESET === 'pittsburgh' ? 40 : null;
      const offset = crest ? (ft !== null ? await D((f) => window.__deluge.stageOffsetForFeet(f), ft) : crest.offset * 0.8) : 0;
      if (crest) await D((o) => window.__deluge.setStage(o, { instant: true }), offset);
      // A Site check site at the Point (Pittsburgh's riverfront), for the "floods in k of N members" line.
      let siteName = null;
      if (PRESET === 'pittsburgh') {
        const have = await D(() => document.querySelectorAll('.dl-site-item').length);
        const g = await D((p) => window.__deluge.geoToGrid(p.lon, p.lat), { lat: 40.4425, lon: -80.0085 });
        if (!have) {
          await D((p) => {
            const d = window.__deluge;
            d.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: d.sampleAt(p.gx, p.gy).ground }, distance: 900, yaw: 0, pitch: Math.PI / 2 - 0.01 });
          }, g);
          await D(() => window.__deluge.waitFrames(4));
          await D(() => window.__deluge.selectTool('site'));
          const box = await page.locator('#deluge-canvas').boundingBox();
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForFunction(() => document.querySelectorAll('.dl-site-item').length >= 1, null, { timeout: 5000 }).catch(() => {});
          await D(() => window.__deluge.selectTool('orbit'));
        }
        siteName = await D(() => document.querySelector('.dl-site-item .dl-impact-name')?.textContent ?? null);
      }
      // Frame the flood from above, then freeze the user's scenario (paused) so the restore can be checked exactly.
      await D(() => {
        const d = window.__deluge;
        const cam = d.getScenario()?.camera;
        if (cam) d.setCamera({ ...cam, distance: cam.distance * 1.1, pitch: Math.PI / 2 - 0.05 });
        d.setPaused(true);
      });
      const before = await D(() => {
        const s = window.__deluge.getState();
        return { stageOffset: s.stageOffset, paused: s.paused, sources: JSON.stringify(s.sources), rain: s.sim.rainRate, manning: s.sim.manningN };
      });
      const probHiddenBefore = await D(() => document.querySelector('.dl-seg-btn[data-mode="probability"]')?.hidden ?? null);
      check(r, 'no probability view before an ensemble exists', probHiddenBefore === true, `button hidden: ${probHiddenBefore}`);

      await D(() => {
        const sec = document.querySelector('[data-section="ensemble"]');
        if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head').click();
        sec?.scrollIntoView();
      });
      for (const [name, v] of [['members', '3'], ['minutes', '5']]) {
        await page.fill(`[data-ens-field="${name}"]`, v);
        await page.dispatchEvent(`[data-ens-field="${name}"]`, 'change');
      }
      const t0 = Date.now();
      await page.click('[data-ens="run"]');
      const done = await page
        .waitForFunction(() => /^(Done|Stopped|Cancelled)/.test(document.querySelector('[data-ens="status"]')?.textContent ?? ''), null, { timeout: 480_000 })
        .then(() => true, () => false);
      const wall = (Date.now() - t0) / 1000;
      await D(() => window.__deluge.waitFrames(8));
      const out = await D(() => {
        const s = window.__deluge.getState();
        return {
          status: document.querySelector('[data-ens="status"]')?.textContent ?? '',
          results: !!document.querySelector('[data-ens="results"]')?.textContent,
          kv: document.querySelector('[data-ens="results"] .dl-site-kv')?.textContent ?? '',
          mode: s.render.waterMode,
          legendTitle: document.querySelector('.dl-legend-title')?.textContent ?? '',
          legendRows: document.querySelectorAll('.dl-legend-rows .dl-legend-row').length,
          probButton: !(document.querySelector('.dl-seg-btn[data-mode="probability"]')?.hidden ?? true),
          siteLine: document.querySelector('[data-site="ensemble"]')?.textContent ?? '',
          after: { stageOffset: s.stageOffset, paused: s.paused, sources: JSON.stringify(s.sources), rain: s.sim.rainRate, manning: s.sim.manningN },
        };
      });
      const ens = await D(() => window.__deluge.getEnsemble());
      r.metrics.ensemble = { wallSeconds: wall, status: out.status, members: ens?.members, floodedM2: ens?.floodedM2, loss: ens?.loss, map: ens?.map, rows: ens?.rows };
      check(r, '3-member ensemble completes', done && /^Done: 3 members/.test(out.status), `${out.status.slice(0, 160)} (${num(wall, 1)} s wall)`);
      check(r, 'results: flooded area and loss p10/p50/p90', out.results && /p10 · p50 · p90/.test(out.kv) && ens?.members === 3, out.kv.slice(0, 160));
      const distinct = new Set((ens?.rows ?? []).map((m) => `${m.inflowFactor}|${m.rainFactor}|${m.stageDelta}|${m.manningN}`)).size;
      check(r, 'members are perturbed (Latin hypercube: every member differs)', distinct === 3, `${distinct} distinct members: n ${(ens?.rows ?? []).map((m) => num(m.manningN, 3)).join(', ')}`);
      check(r, 'the GPU tally holds every member, with intermediate probabilities somewhere', !!ens?.map && ens.map.members === 3 && ens.map.any > 0 && ens.map.partial > 0, JSON.stringify(ens?.map));
      check(r, 'the map switches to the probability view with its legend (6 bands + normal river)', out.mode === 'probability' && /Share of ensemble members deeper than 15 cm/.test(out.legendTitle) && out.legendRows === 7 && out.probButton, `${out.mode} · “${out.legendTitle}” · ${out.legendRows} rows`);
      check(r, 'the user’s scenario is put back (stage, play state, sources, rain, Manning n)', JSON.stringify(out.after) === JSON.stringify(before), JSON.stringify(out.after).slice(0, 160));
      if (siteName !== null) check(r, 'the Site check card says in how many members the site floods', /^Ensemble: (floods|stays).* of 3 members|in all 3 members/.test(out.siteLine), out.siteLine.slice(0, 140));

      // Legend vs pixels (as scripts/visual.mjs does for the other hazard views): the probability map against the same
      // frozen frame in the max-depth view; among the pixels that changed and look like ANY legend swatch, the nearest
      // swatch must be a probability one. The bar is lower than the visual suite's 0.9: there the reference is another
      // hazard view on the SAME surface, here the user's own (reset) max depth, so the mask also takes in the river and
      // the band edges blended over it. Measured 82 % on Pittsburgh; a view wired to the wrong ramp scores near 0.
      const palettes = {};
      for (const m of ['depth', 'maxDepth', 'velocity', 'arrival', 'hazard', 'probability']) {
        palettes[m] = await D((mode) => {
          window.__deluge.setWaterMode(mode);
          return [...document.querySelectorAll('.dl-legend-bar span')].map((e) => getComputedStyle(e).backgroundColor.match(/\d+/g).slice(0, 3).map(Number));
        }, m);
      }
      palettes.velocity = palettes.velocity.slice(1); // its slowest band is drawn as plain water
      r.metrics.palettes = palettes;
      const grab = async (mode) => {
        await D((m) => window.__deluge.setWaterMode(m), mode);
        await D(() => window.__deluge.waitFrames(12));
        return (await page.locator('#deluge-canvas').screenshot({ type: 'png' })).toString('base64');
      };
      const refPng = await grab('maxDepth');
      const probPng = await grab('probability');
      const agree = await D(
        async ({ a, b, palettes }) => {
          const load = async (b64) => {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            const cv = new OffscreenCanvas(bmp.width, bmp.height);
            const cx = cv.getContext('2d');
            cx.drawImage(bmp, 0, 0);
            return cx.getImageData(0, 0, bmp.width, bmp.height).data;
          };
          const [p, q] = [await load(a), await load(b)];
          const names = Object.keys(palettes);
          let changed = 0;
          let classified = 0;
          let own = 0;
          const byMode = {};
          for (let o = 0; o < p.length; o += 4) {
            if (Math.max(Math.abs(p[o] - q[o]), Math.abs(p[o + 1] - q[o + 1]), Math.abs(p[o + 2] - q[o + 2])) <= 18) continue;
            changed++;
            // Plain (muted) water carries no band colour: the normal river is grey in both views, but sits on a
            // different surface in each (the envelope vs the user's own max depth), so it changes. Every probability
            // swatch is strongly coloured (chroma ≥ 90); greys and near-blacks are not judged.
            if (Math.max(p[o], p[o + 1], p[o + 2]) - Math.min(p[o], p[o + 1], p[o + 2]) < 40) continue;
            let best = 60 * 60;
            let who = null;
            for (const n of names) for (const c of palettes[n]) {
              const d = (p[o] - c[0]) ** 2 + (p[o + 1] - c[1]) ** 2 + (p[o + 2] - c[2]) ** 2;
              if (d < best) ((best = d), (who = n));
            }
            if (who) ((classified += 1), (own += who === 'probability' ? 1 : 0), (byMode[who] = (byMode[who] ?? 0) + 1));
          }
          return { changedFrac: changed / (p.length / 4), classified, agreement: classified ? own / classified : null, byMode };
        },
        { a: probPng, b: refPng, palettes },
      );
      r.metrics.legendAgreement = agree;
      check(r, 'legend matches the pixels: mapped water reads as the probability palette', agree.classified > 500 && agree.agreement >= 0.75, `${num(agree.agreement * 100, 1)} % of ${agree.classified} legend-coloured pixels (${num(agree.changedFrac * 100, 1)} % of the frame mapped; nearest: ${JSON.stringify(agree.byMode)})`);
      await shot('17-ensemble-map');
      // The 0.5 m threshold.
      await page.click('[data-section="ensemble"] .dl-seg-btn:has-text("> 50 cm")');
      await D(() => window.__deluge.waitFrames(6));
      const t50 = await D(() => ({ title: document.querySelector('.dl-legend-title')?.textContent ?? '', thr: window.__deluge.getState().render.probabilityThreshold }));
      check(r, 'the 0.5 m threshold toggle', t50.thr === 0.5 && /deeper than 50 cm/.test(t50.title), `${t50.thr} · “${t50.title.slice(0, 60)}”`);
      await shot('17-ensemble-map-50cm');
      await D(() => document.querySelector('[data-ens="results"]')?.scrollIntoView({ block: 'start' }));
      await sleep(400);
      const panelShot = path.join(OUT, '17-ensemble-panel.png');
      await page.locator('.dl-panel').screenshot({ path: panelShot });
      console.log(`  [shot] ${path.relative(ROOT, panelShot)}`);
      await D(() => window.__deluge.store.set({ render: { ...window.__deluge.getState().render, probabilityThreshold: 0.15 } }));
      await calm();
    },
  },
  {
    id: 18,
    name: 'Future climate: Houston 2050 SSP5-8.5 scales the forcing; Site check EAL today vs future',
    timeoutMs: 420_000,
    async run(r) {
      // src/climate + src/app/climate.ts: a layer on what the solver receives; the store (and the sliders) keep today.
      await D((p) => window.__deluge.loadPreset(p), 'houston');
      await D(() => {
        const d = window.__deluge;
        d.store.set({ climate: { horizon: 'today', pathway: 'ssp585', scaling: 'cc' } });
        d.actions.restoreScenario();
        d.setPaused(false);
        d.actions.resetWater();
      });
      const read = () =>
        D(() => {
          const d = window.__deluge;
          const solver = d.getSolver();
          const inflow = (solver?.sources ?? []).find((s) => s.type === 'inflow');
          return {
            solverRain: solver?.params.rainRate ?? NaN,
            solverInflow: inflow?.discharge ?? NaN,
            storeRain: d.getState().sim.rainRate,
            storeInflow: d.getState().sources.find((s) => s.type === 'inflow')?.discharge ?? NaN,
            badge: document.querySelector('[data-climate="badge"]')?.textContent ?? '',
            rainLine: document.querySelector('[data-climate="rain"]')?.textContent ?? '',
            inflowLine: document.querySelector('[data-climate="inflow"]')?.textContent ?? '',
            note: document.querySelector('[data-climate="note-line"]')?.textContent ?? '',
          };
        });
      const today = await read();
      check(r, 'Today: the solver gets the scenario as it ships', today.solverRain === today.storeRain && today.solverInflow === today.storeInflow && /Today/.test(today.badge), `rain ${num(today.solverRain, 1)} mm/hr, inflow ${num(today.solverInflow, 0)} m³/s, badge “${today.badge}”`);

      // The UI: Weather & rivers → Future climate → 2050, SSP5-8.5.
      await D(() => document.querySelector('.dl-climate')?.scrollIntoView({ block: 'center' }));
      await page.click('[data-climate-horizon="2050"]');
      await page.click('[data-climate-pathway="ssp585"]');
      await sleep(200);
      const fut = await read();
      const k = fut.solverRain / today.solverRain;
      const expected = Math.pow(1.07, 2.4 - 0.85); // AR6 SPM.1 2041–2060 SSP5-8.5, from 1995–2014, at 7 %/°C
      r.metrics.climate = { today, future: fut, multiplier: k };
      check(r, 'the badge and the rain line name the climate and the multiplier', /2050 · SSP5-8\.5/.test(fut.badge) && /× 1\.11/.test(fut.rainLine) && /173/.test(fut.rainLine), `“${fut.badge}” · “${fut.rainLine.slice(0, 110)}”`);
      check(r, 'the solver’s rain and the bayou inflow are scaled by the same multiplier', Math.abs(k - expected) < 1e-3 && Math.abs(fut.solverInflow / today.solverInflow - expected) < 1e-3, `× ${num(k, 4)} (expected ${num(expected, 4)}): ${num(fut.solverRain, 1)} mm/hr, ${num(fut.solverInflow, 0)} m³/s`);
      check(r, 'the store keeps today’s values (the sliders keep their meaning), and a note says so', fut.storeRain === today.storeRain && fut.storeInflow === today.storeInflow && /the sliders show today/.test(fut.note), `store rain ${num(fut.storeRain, 1)}, inflow ${num(fut.storeInflow, 0)}; “${fut.note.slice(0, 80)}”`);
      await sleep(300);
      const climShot = path.join(OUT, '18-climate-panel.png');
      await page.locator('.dl-climate').screenshot({ path: climShot });
      console.log(`  [shot] ${path.relative(ROOT, climShot)}`);

      // Site check: a lot that floods in today's storm. Run the scenario 10 sim-min, take a cell that was dry at the
      // start and is under 1–3 m now (block maximum), drop the site there.
      await D(() => window.__deluge.actions.resetWater());
      await runFor(2); // a readback of the reset water
      await D(() => {
        window.__e2e17 = { initial: window.__deluge.sampleGrid('depth', 8) };
      });
      await runFor(600);
      const spot = await D(() => {
        const d = window.__deluge;
        const a = window.__e2e17.initial;
        const b = d.sampleGrid('depth', 8);
        if (!a || !b) return { diag: `no samples (${!!a}, ${!!b})` };
        let best = null;
        let wet = 0;
        let max = 0;
        for (let k = 0; k < b.data.length; k++) {
          max = Math.max(max, b.data[k]);
          if (b.data[k] > 0.3) wet++;
          if (a.data[k] > 0.02 || !(b.data[k] > 1 && b.data[k] < 3)) continue;
          const gx = (k % b.w) * b.stride + b.stride / 2;
          const gy = Math.floor(k / b.w) * b.stride + b.stride / 2;
          const score = -Math.hypot(gx - (b.w * b.stride) / 2, gy - (b.h * b.stride) / 2);
          if (!best || score > best.score) best = { gx, gy, depth: b.data[k], score };
        }
        if (best) {
          // The block maximum is somewhere in the block: put the pin on the deepest cell of it.
          const x0 = best.gx - b.stride / 2;
          const y0 = best.gy - b.stride / 2;
          let deep = { gx: best.gx, gy: best.gy, depth: -1 };
          for (let j = 0; j < b.stride; j++) {
            for (let i = 0; i < b.stride; i++) {
              const dd = d.sampleAt(x0 + i + 0.5, y0 + j + 0.5)?.depth ?? 0;
              if (dd > deep.depth) deep = { gx: x0 + i + 0.5, gy: y0 + j + 0.5, depth: dd };
            }
          }
          best = { ...best, ...deep };
        }
        return best ?? { diag: `${wet} blocks > 0.3 m, max ${max.toFixed(2)} m, t ${d.getStats()?.simTime}` };
      });
      const found = spot && !spot.diag;
      check(r, 'found a lot that floods in today’s storm', found, found ? `(${num(spot.gx, 0)}, ${num(spot.gy, 0)}) ${num(spot.depth, 2)} m after 10 min` : spot?.diag ?? 'none');
      if (!found) return;
      await D((p) => {
        const d = window.__deluge;
        const ground = d.sampleAt(p.gx, p.gy).ground;
        d.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: ground }, distance: 700, yaw: 0, pitch: Math.PI / 2 - 0.01 });
      }, spot);
      await D(() => window.__deluge.waitFrames(4));
      await D(() => window.__deluge.selectTool('site'));
      const box = await page.locator('#deluge-canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      const placed = await page
        .waitForFunction(() => document.querySelectorAll('.dl-site-item').length >= 1 && document.querySelector('[data-section="site"]')?.classList.contains('dl-open'), null, { timeout: 5000 })
        .then(() => true, () => false);
      check(r, 'a site is dropped on the lot', placed);
      await D(() => window.__deluge.selectTool('orbit'));

      // Ladder: forcing × 0.5 and × 1 with return periods typed in (10 and 100 years, the user's input), 10 min each.
      // Houston is rain-led, so Site check opens on the NOAA Atlas 14 rain ladder once it has looked it up: pick the
      // forcing multipliers instead (flow 20 covers the rain ladder).
      await page
        .waitForFunction(() => [...document.querySelectorAll('[data-site="ladder"] option')].some((o) => o.value === 'rain'), null, { timeout: 20_000 })
        .catch(() => {});
      await page.selectOption('[data-site="ladder"]', 'scale').catch(() => {});
      await page.fill('[data-site-field="duration"]', '10');
      await page.dispatchEvent('[data-site-field="duration"]', 'change');
      await D(() => {
        for (const box of document.querySelectorAll('.dl-site-ladder input[type=checkbox]')) {
          const want = box.dataset.level === 'x0.5' || box.dataset.level === 'x1';
          if (box.checked !== want) box.click();
        }
        for (const [id, T] of [['x0.5', '10'], ['x1', '100']]) {
          const inp = document.querySelector(`.dl-site-ladder input[data-level="${id}"]`)?.closest('tr')?.querySelector('.dl-site-rp');
          if (inp) {
            inp.value = T;
            inp.dispatchEvent(new Event('change'));
          }
        }
      });
      const btnState = await D(() => ({ disabled: document.querySelector('[data-site="run-climate-sweep"]')?.disabled ?? null }));
      check(r, '“Today vs future” is enabled under 2050 SSP5-8.5', btnState.disabled === false, JSON.stringify(btnState));
      const t0 = Date.now();
      await page.click('[data-site="run-climate-sweep"]');
      const done = await page
        .waitForFunction(() => /^(Done: 2 levels today|Sweep stopped|Cancelled)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 360_000 })
        .then(() => true, () => false);
      const out = await D(() => ({
        status: document.querySelector('[data-site="sweep-status"]')?.textContent ?? '',
        eal: document.querySelector('[data-site="climate-eal"]')?.textContent ?? '',
        rows: [...document.querySelectorAll('[data-site="climate-compare"] tbody tr')].map((tr) => [...[...tr.children].map((td) => td.textContent), tr.dataset.simS]),
        climate: window.__deluge.getState().climate,
        solverRain: window.__deluge.getSolver()?.params.rainRate ?? NaN,
      }));
      r.metrics.compare = { ...out, seconds: (Date.now() - t0) / 1000 };
      check(r, 'today-vs-future sweep completes', done && /^Done: 2 levels today and under 2050 · SSP5-8\.5/.test(out.status), `${out.status.slice(0, 90)} (${num((Date.now() - t0) / 1000, 1)} s wall)`);
      check(r, 'the site card shows “EAL today $X → 2050 · SSP5-8.5 $Y”', /^EAL today .+ a year → 2050 · SSP5-8\.5 /.test(out.eal), out.eal);
      const money = (s) => Number(String(s).replace(/[^0-9.kKMB]/g, '').replace(/k$/i, 'e3').replace(/M$/, 'e6').replace(/B$/, 'e9'));
      const worse = out.rows.length === 2 && out.rows.every((row) => !(money(row[2]) < money(row[1]))) && out.rows.some((row) => money(row[2]) > money(row[1]));
      // Soft: a lot whose water comes from a front can still sit on either side of it by run-to-run timestep noise
      // (the runs themselves are now exactly as long: rows end "today s|future s").
      check(r, 'per-level loss under 2050 SSP5-8.5 is no lower than today, and higher somewhere', worse, JSON.stringify(out.rows), { soft: true });
      // Headless runs stop on the asked time (they used to overshoot by up to a readback: 614–706 s for 600).
      check(r, 'both runs of every level ran exactly the asked 10 min', out.rows.length === 2 && out.rows.every((row) => String(row[3]).split('|').every((s) => Number(s) === 600)), JSON.stringify(out.rows.map((row) => row[3])));
      check(r, 'the user’s climate is put back afterwards', out.climate?.horizon === '2050' && Math.abs(out.solverRain / today.solverRain - expected) < 1e-3, `${JSON.stringify(out.climate)}, solver rain ${num(out.solverRain, 1)}`);
      await D(() => document.querySelector('[data-site="climate-compare"]')?.scrollIntoView({ block: 'center' }));
      await sleep(400);
      const siteShot = path.join(OUT, '18-site-climate.png');
      await page.locator('.dl-panel').screenshot({ path: siteShot });
      console.log(`  [shot] ${path.relative(ROOT, siteShot)}`);
      await shot('18-houston-2050');

      // The report carries the comparison.
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-site="report-html"]')]);
      const file = path.join(OUT, '18-site-assessment-climate.html');
      await dl.saveAs(file);
      const html = fs.readFileSync(file, 'utf8');
      check(r, 'the site assessment report has the climate comparison', /Future climate — today vs 2050 · SSP5-8\.5/.test(html) && /EAL today/.test(html), `${(html.length / 1024).toFixed(0)} KB`);

      // Back to Today: the identity again.
      await D(() => document.querySelector('.dl-climate')?.scrollIntoView({ block: 'center' }));
      await page.click('[data-climate-horizon="today"]');
      await sleep(200);
      const back = await read();
      check(r, 'Today again restores the scenario’s own forcing', back.solverRain === today.solverRain && back.solverInflow === today.solverInflow, `rain ${num(back.solverRain, 1)}, inflow ${num(back.solverInflow, 0)}`);
      await D((p) => window.__deluge.loadPreset(p), PRESET);
    },
  },
  {
    id: 19,
    name: 'Business use cases: ?usecase= deep links set up site / glacier / portfolio',
    timeoutMs: 600_000,
    resetsPage: true,
    async run(r, ctx) {
      // src/ui/useCases.ts: each ?usecase= link opens its preset and sets up the demo (sites, chain + early warning,
      // the bundled portfolio CSV); the top bar opens the cards and the business brief. A hostile value is ignored.
      const open = (qs) => page.goto(new URL(qs, ctx.baseUrl).href, { waitUntil: 'domcontentloaded' }).then(() => waitReady(120_000));
      const sec = (id) => D((s) => document.querySelector(`[data-section="${s}"]`)?.classList.contains('dl-open') ?? false, id);

      // Site check before you build.
      await open('?usecase=site');
      const sites = await page
        .waitForFunction(() => document.querySelectorAll('.dl-site-item').length === 2, null, { timeout: 30_000 })
        .then(() => true, () => false);
      const site = await D(() => ({
        preset: window.__deluge.getState().presetId,
        url: location.search,
        names: [...document.querySelectorAll('.dl-site-item')].map((e) => e.textContent ?? ''),
      }));
      check(r, 'site: ?usecase=site opens Pittsburgh with the two demo parcels', sites && site.preset === 'pittsburgh' && site.names.some((n) => /Demo parcel A \(North Shore\)/.test(n)), `${site.preset}, ${site.names.length} sites`);
      check(r, 'site: Site check section open, use case kept in the link', (await sec('site')) && /usecase=site/.test(site.url), site.url);
      await sleep(1600); // camera flight to the parcel
      await shot('19-usecase-site');

      // Repeated sweeps agree. The North Shore parcel at the 1936 crest is the demo's fast-water case: its damage used
      // to flip between 15 % and 100 % from one sweep to the next (runs of unequal length, the hazard maxima sampled at
      // whatever moment a readback fell on, the stage raised in metre steps at 3600×, and a step at d·v = 7 m²/s read
      // off the worst cell). Three sweeps of FEMA's 1 % level and the 1936 crest, 30 simulated minutes each.
      await page.click('.dl-site-item:has-text("Demo parcel A") .dl-site-pick');
      await page.fill('[data-site-field="duration"]', '30');
      await page.dispatchEvent('[data-site-field="duration"]', 'change');
      await D(() => {
        for (const box of document.querySelectorAll('.dl-site-ladder input[type=checkbox]')) {
          const want = box.dataset.level === 'rp100' || box.dataset.level === 'record1936';
          if (box.checked !== want) box.click();
        }
      });
      const money = (s) => {
        const m = String(s).replace(/[^0-9.kMB]/g, '').match(/^([0-9.]+)([kMB]?)$/);
        return m ? Number(m[1]) * ({ k: 1e3, M: 1e6, B: 1e9 }[m[2]] ?? 1) : NaN;
      };
      const sweeps = [];
      for (let k = 0; k < 3; k++) {
        await page.click('[data-site="run-sweep"]');
        const ok = await page
          .waitForFunction(() => /^(Done|Sweep stopped|Cancelled)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 180_000 })
          .then(() => true, () => false);
        const row = await D(() => {
          const tr = [...document.querySelectorAll('.dl-site-sweep-out table tbody tr')].find((t) => /1936/.test(t.textContent ?? ''));
          return { site: document.querySelector('.dl-site-item.dl-on')?.textContent ?? '', status: document.querySelector('[data-site="sweep-status"]')?.textContent ?? '', cells: tr ? [...tr.children].map((td) => td.textContent ?? '') : [] };
        });
        sweeps.push({ ok: ok && /^Done: 2 levels/.test(row.status), site: row.site, depth: Number(row.cells[1]), loss: money(row.cells[3]), text: row.cells.join(' | ') });
      }
      r.metrics.repeatSweeps = sweeps;
      const losses = sweeps.map((s) => s.loss);
      const spread = (Math.max(...losses) - Math.min(...losses)) / Math.max(...losses);
      check(r, 'site: three sweeps complete, on parcel A', sweeps.every((s) => s.ok && /Demo parcel A/.test(s.site)), sweeps.map((s) => s.text).join(' ¦ '));
      // Measured on the GTX 1660 Ti: $39.2–40.1 M (damage 79–81 %) across sweeps; it used to be $7.5 M or $49.5 M.
      check(r, 'site: repeated sweeps agree on the 1936-crest loss at parcel A (within 10 %)', losses.every(Number.isFinite) && spread <= 0.1, `${losses.map((l) => `$${(l / 1e6).toFixed(1)} M`).join(', ')} (spread ${(spread * 100).toFixed(1)} %)`);

      // The design event: choosing the 1936 crest must not claim that no 1 % level was run — it was.
      await D(() => {
        const sel = document.querySelector('.dl-site-sweep-out select[aria-label="Design event"]');
        if (sel) {
          sel.value = 'record1936';
          sel.dispatchEvent(new Event('change'));
        }
      });
      const design = await D(() => [...document.querySelectorAll('.dl-site-sweep-out .dl-site-kv')].map((e) => e.textContent ?? '').join(' '));
      check(r, 'site: a user-chosen design event says the 1 % level was also run', /your selection; the 1 % level was also run \(FEMA 1 % \(100-yr\)/.test(design) && !/no 1 % level was run/.test(design), design.slice(0, 200));

      // The cards and the brief, from the top bar.
      await page.click('.dl-uc-btn');
      await page.waitForSelector('[data-modal="usecases"].dl-open .dl-uc-card');
      const modal = await D(() => ({
        cards: [...document.querySelectorAll('.dl-uc-card')].map((c) => c.getAttribute('data-usecase')),
        welcomeLink: !!document.querySelector('.dl-welcome-uc'),
      }));
      check(r, 'top bar opens the six use-case cards (the Try-it strip links to them too)', modal.cards.join() === 'site,glacier,portfolio,address,dam,surge' && modal.welcomeLink, modal.cards.join(', '));
      await sleep(300);
      await shot('19-usecases-modal');
      await page.click('[data-uc="toggle"]');
      const brief = await D(() => ({
        questions: [...document.querySelectorAll('.dl-uc-brief-q')].map((q) => q.textContent),
        caveats: document.querySelectorAll('.dl-uc-brief-caveat').length,
        print: !document.querySelector('[data-uc="print"]')?.hidden,
      }));
      check(r, 'business brief: every question with its limit, printable', brief.questions.length >= 6 && brief.caveats >= 5 && brief.print, `${brief.questions.length} sections, ${brief.caveats} caveats`);
      await sleep(300);
      await shot('19-business-brief');
      await page.keyboard.press('Escape');
      const closed = await D(() => !window.__deluge.getState().panels.useCases);
      check(r, 'Esc closes the use-case dialog', closed, String(closed));

      // Glacier risk for hydropower.
      await open('?usecase=glacier');
      const chainReady = await page
        .waitForFunction(() => window.__deluge.getHazardChain()?.status === 'ready', null, { timeout: 180_000 })
        .then(() => true, () => false);
      await sleep(1200);
      const glacier = await D(() => {
        const blk = document.querySelector('[data-ew="block"]');
        const panel = document.querySelector('.dl-panel-scroll')?.getBoundingClientRect();
        const b = blk?.getBoundingClientRect();
        return {
          preset: window.__deluge.getState().presetId,
          visible: !!blk && !blk.hidden && !!b && !!panel && b.top < panel.bottom && b.bottom > panel.top,
          chips: document.querySelectorAll('.dl-ew-chip').length,
        };
      });
      check(r, 'glacier: ?usecase=glacier opens Nepal with the hazard chain run', chainReady && glacier.preset === 'nepal' && (await sec('chain')), glacier.preset);
      check(r, 'glacier: the Early warning designer is scrolled into view', glacier.visible && glacier.chips >= 5, `${glacier.chips} lead-time chips`);
      await shot('19-usecase-glacier');

      // Portfolio exposure.
      await open('?usecase=portfolio');
      const read = await page
        .waitForFunction(() => /19 assets read/.test(document.querySelector('.dl-impact-portfolio')?.textContent ?? ''), null, { timeout: 60_000 })
        .then(() => true, () => false);
      const assessed = await page
        .waitForFunction(() => /of 19 reached/.test(document.querySelector('.dl-impact-portfolio')?.textContent ?? ''), null, { timeout: 60_000 })
        .then(() => true, () => false);
      const speed = await D(() => ({ timeScale: window.__deluge.getState().sim.timeScale, paused: window.__deluge.getState().paused }));
      // Half an hour of Harvey's worst-hour rain, then a few of the 5 s auto-recomputes.
      await runFor(1800);
      await D(() => window.__deluge.setPaused(false));
      const grew = await page
        .waitForFunction(() => /[1-9]\d* of 19 reached · loss \$[0-9.]+\s?[KMB]/.test(document.querySelector('.dl-impact-portfolio')?.textContent ?? ''), null, { timeout: 30_000 })
        .then(() => true, () => false);
      const pf = await D(() => ({
        preset: window.__deluge.getState().presetId,
        info: document.querySelector('.dl-impact-portfolio')?.textContent ?? '',
        rows: document.querySelectorAll('.dl-impact-portfolio + .dl-impact-table tbody tr').length,
        simTime: window.__deluge.getStats()?.simTime ?? 0,
        ensembleAssets: window.__deluge.getPortfolioIds()?.length ?? 0,
      }));
      r.metrics.portfolio = { ...pf, speed };
      // The demo arrives through loadPortfolioText, not the file input: the ensemble must tally those same assets.
      check(r, 'portfolio: the ensemble sees the demo portfolio (UI bridge), not a stale or empty one', pf.ensembleAssets === 19, `${pf.ensembleAssets} assets on the bridge`);
      check(r, 'portfolio: ?usecase=portfolio opens Houston with the demo CSV in Impact & loss, the rain fast-forwarded', read && pf.preset === 'houston' && (await sec('impact')) && speed.timeScale >= 300 && !speed.paused, `${pf.info.slice(0, 60)} · ${speed.timeScale}×`);
      check(r, 'portfolio: the assets are assessed as the rain falls (auto-recompute)', assessed && grew && pf.rows === 19, pf.info.split('.').slice(1).join('.').slice(0, 160));
      await shot('19-usecase-portfolio');

      // A hostile ?usecase= is ignored with a fixed sentence and never reaches the page.
      await open('?usecase=%3Cimg%20src%3Dx%20onerror%3D%22window.__pwned%3D1%22%3EEVACUATE%20NOW');
      await sleep(500);
      const hostile = await D(() => ({
        preset: window.__deluge.getState().presetId,
        pwned: window.__pwned === 1,
        echoed: /EVACUATE NOW|onerror/.test(document.body.innerText),
        url: location.search,
      }));
      check(r, 'a hostile ?usecase= falls back to the default scene, unechoed and inert', hostile.preset === 'pittsburgh' && !hostile.pwned && !hostile.echoed && !/usecase/.test(hostile.url), JSON.stringify(hostile));

      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
    },
  },
  {
    id: 20,
    name: 'Narrated story: ?story= link, keys, and the Pittsburgh story played end to end',
    timeoutMs: 420_000,
    resetsPage: true,
    async run(r, ctx) {
      // src/ui/storyPlayer.ts + src/story: a ?story= link loads the story's preset and starts the caption card; Space,
      // → and Esc drive it; then the whole Pittsburgh story is played at 1/20 of its reading time, sampling the card,
      // the camera and the simulation on every beat.
      const open = (qs) => page.goto(new URL(qs, ctx.baseUrl).href, { waitUntil: 'domcontentloaded' }).then(() => waitReady(120_000));
      const card = () =>
        D(() => {
          const ui = document.getElementById('ui-root')?.__delugeUI;
          const d = window.__deluge;
          const s = d.getState();
          const pose = d.getRenderer()?.camera?.pose;
          return {
            ...(ui?.story?.debugState() ?? {}),
            dataState: document.querySelector('.dl-nar')?.getAttribute('data-state') ?? null,
            visible: !!document.querySelector('.dl-nar:not([hidden])'),
            mode: !!document.querySelector('.dl-nar-mode'),
            simPaused: s.paused,
            stageOffset: s.stageOffset,
            stageApplied: s.stageOffsetApplied,
            evac: !!s.evacStart,
            route: s.route?.state ?? null,
            walls: d.getProtection()?.wallCells ?? 0,
            camera: pose ? { gx: pose.target.gx, gy: pose.target.gy, distance: pose.distance, yaw: pose.yaw } : null,
            url: location.search,
          };
        });

      // 1. The link.
      await open('?story=pittsburgh-1936');
      const started = await page
        .waitForFunction(() => document.querySelector('.dl-nar[data-story="pittsburgh-1936"]:not([hidden])'), null, { timeout: 60_000 })
        .then(() => true, () => false);
      await sleep(800);
      let c = await card();
      const preset = await D(() => window.__deluge.getState().presetId);
      check(r, '?story=pittsburgh-1936 opens Pittsburgh and starts the story in story mode', started && preset === 'pittsburgh' && c.mode && c.storyId === 'pittsburgh-1936' && /story=pittsburgh-1936/.test(c.url), `${preset}, beat ${c.beatId}, “${(c.caption ?? '').slice(0, 60)}…”`);
      check(r, 'the first caption cites its source', /Allegheny/.test(c.caption) && /^Source: .+/.test(c.source), c.source);
      await shot('20-story-first-beat');

      // 2. Keys: Space pauses the story and the simulation, → moves on, Esc leaves story mode.
      await page.keyboard.press('Space');
      await sleep(300);
      const paused = await card();
      await page.keyboard.press('Space');
      await sleep(300);
      const resumed = await card();
      check(r, 'Space pauses the story and the simulation, and resumes both', paused.paused && paused.simPaused && paused.dataState === 'paused' && !resumed.paused && !resumed.simPaused, `paused ${paused.paused}/${paused.simPaused}, resumed ${resumed.paused}/${resumed.simPaused}`);
      const before = (await card()).index;
      await page.keyboard.press('ArrowRight');
      await sleep(300);
      const after = (await card()).index;
      check(r, '→ goes to the next beat', after === before + 1, `${before} → ${after}`);
      await page.keyboard.press('Escape');
      await sleep(300);
      c = await card();
      check(r, 'Esc exits: card hidden, story mode off, ?story= dropped from the address bar', !c.visible && !c.mode && !/story=/.test(c.url), c.url || '(no query)');

      // 3. The entry points: "Watch the story" in the Scenario section, and the stories row in Use cases.
      const entry = await D(() => ({
        watch: !!document.querySelector('.dl-nar-watch:not([hidden])'),
        chips: [...document.querySelectorAll('.dl-uc .dl-nar-chip')].map((b) => `${b.getAttribute('data-story-group')}:${b.getAttribute('data-story')}`),
        watchTip: document.querySelector('.dl-nar-watch')?.getAttribute('data-tip') ?? '',
      }));
      check(
        r,
        'entry points: Watch the story (Scenario, the 1936 event) and eight stories under Use cases, the three decisions first',
        entry.watch && /What a wall would have saved/.test(entry.watchTip) && entry.chips.length === 8 && entry.chips.slice(0, 3).join() === 'business:site-decision,business:levee-bca,business:dam-upstream' && entry.chips.includes('event:nepal-2026'),
        entry.chips.join(', '),
      );

      // 4. The whole story at 1/20 pace (waits capped at 30 s so a slow GPU cannot stall the flow).
      await D(() => window.__deluge.setPaused(false));
      // The user's own state before the story: put back when it ends (a wall of theirs included).
      const userState = () =>
        D(() => {
          const s = window.__deluge.getState();
          const walls = window.__deluge.getSolver()?.getBarrierCPU().reduce((n, v) => n + (v > 0.2 ? 1 : 0), 0) ?? -1;
          return { stage: s.stageOffset, rain: s.sim.rainRate, timeScale: s.sim.timeScale, view: s.render.waterMode, evac: !!s.evacStart, walls };
        });
      await D(() => {
        const d = window.__deluge;
        d.getSolver().applyBrush({ kind: 'wall', ax: 100, ay: 100, bx: 140, by: 100, radius: 2, height: 3 });
        d.setStageOffset(1.5);
      });
      const pre = await userState();
      const ok = await D(() => document.getElementById('ui-root').__delugeUI.story.play('pittsburgh-1936', { pace: 0.05, maxWaitCapMs: 30_000 }));
      check(r, 'the story plays from the debug handle', ok === true, String(ok));
      const seen = new Map();
      const t0 = Date.now();
      let last = null;
      while (Date.now() - t0 < 300_000) {
        last = await card();
        if (last.beatId && !seen.has(last.beatId) && !last.finished) {
          seen.set(last.beatId, { ...last, at: (Date.now() - t0) / 1000 });
          console.log(`  · ${((Date.now() - t0) / 1000).toFixed(1)} s beat ${last.beatId}: ${last.caption.slice(0, 90)}`);
          if (last.beatId === 'kept' || last.beatId === 'under') await shot(`20-story-${last.beatId}`);
        }
        if (last.finished) break;
        await sleep(150);
      }
      const order = [...seen.keys()];
      r.metrics.storyBeats = [...seen.values()].map((b) => ({ beat: b.beatId, at: b.at, timedOut: b.timedOut, caption: b.caption }));
      check(r, 'every beat played, in order, and the story finished', last?.finished && order.join() === 'point,record,under,evacuate,levee,kept,limits' && last.dataState === 'finished', `${order.join(' → ')} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      const captions = [...seen.values()].map((b) => b.caption);
      check(r, 'captions carry their facts, live tokens resolved (no raw {token})', /46 ft/.test(seen.get('record')?.caption ?? '') && captions.every((t) => t && !/\{[a-z]+(:[^}]*)?\}/.test(t)), captions.map((t) => t.slice(0, 40)).join(' | '));
      const pCam = seen.get('point')?.camera;
      const lCam = seen.get('levee')?.camera;
      await sleep(300);
      const end = await card();
      const camMoved = !!pCam && !!end.camera && (Math.hypot(pCam.gx - end.camera.gx, pCam.gy - end.camera.gy) > 20 || Math.abs(pCam.distance - end.camera.distance) > 100);
      check(r, 'the camera moves with the story (scenario → North Shore levee → wide)', camMoved && !!lCam, `point (${num(pCam?.gx, 0)}, ${num(pCam?.gy, 0)}) ${num(pCam?.distance, 0)} m · end (${num(end.camera?.gx, 0)}, ${num(end.camera?.gy, 0)}) ${num(end.camera?.distance, 0)} m`);
      const kept = seen.get('kept');
      check(r, 'the simulation changes with it: river raised, route planned, levee standing', end.stageOffset > 5 && end.stageApplied > 1 && end.evac && end.walls > 0, `stage offset ${num(end.stageOffset)} m (applied ${num(end.stageApplied)}), route ${end.route}, ${end.walls} wall cells`);
      check(r, 'kept-dry figure is read live from the protection estimate', !!kept && /acres|nothing yet/.test(kept.caption), kept?.caption.slice(0, 120));
      await shot('20-story-end');
      await D(() => document.getElementById('ui-root').__delugeUI.story.stop());
      await sleep(300);
      const post = await userState();
      check(r, 'leaving the story puts the user’s stage, rain, time scale, view, route and walls back', JSON.stringify({ ...post, walls: 0 }) === JSON.stringify({ ...pre, walls: 0 }) && pre.walls > 0 && Math.abs(post.walls - pre.walls) <= 2, `before ${JSON.stringify(pre)} · after ${JSON.stringify(post)}`);
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
    },
  },
  {
    id: 21,
    name: 'Check any US address: search → live area → site → NOAA Atlas 14 rain sweep → EAL (fixtures)',
    timeoutMs: 600_000,
    resetsPage: true,
    async run(r, ctx) {
      // Hermetic: the geocoder and USGS 3DEP are answered from fixtures in this script (a synthetic 5 km bowl around
      // the address), every other external host is refused, so nothing leaves the machine. The Atlas 14 grid is the
      // real baked file, served by our own server. Flow 21 (--live) runs the same path against the real services.
      const AT = { lat: 29.7604, lon: -95.3698 };
      const intercepted = [];
      await page.route((u) => !isLocalUrl(u.href), (route) => addressFixtures(route, intercepted));
      try {
        await page.goto(new URL('?preset=pittsburgh', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
        await page.click('.dl-uc-btn');
        await page.waitForSelector('[data-modal="usecases"].dl-open [data-usecase="address"]');
        const cards = await D(() => [...document.querySelectorAll('.dl-uc-card')].map((c) => c.getAttribute('data-usecase')).join());
        check(r, 'the use-case dialog offers the address card next to the others', cards === 'site,glacier,portfolio,address,dam,surge', cards);
        await page.click('[data-usecase="address"]');
        await page.fill('[data-uc="address-input"]', '1600 Smith St, Houston, TX');
        await page.click('[data-uc="address-search"]');
        await page.waitForSelector('[data-uc="address-choice"]', { timeout: 15_000 });
        await shot('21-address-search');
        const t0 = Date.now();
        await page.click('[data-uc="address-choice"]');
        const out = await addressSetUp(r, AT, 120_000);
        r.metrics.loadAndSetUpSeconds = (Date.now() - t0) / 1000;
        // The app may write the area's own name back (?name=; here the coordinate fallback, as reverse geocoding is
        // refused) — never the address the user typed.
        const nameParam = new URLSearchParams(out.url).get('name');
        check(r, 'the address bar carries the coordinates, never the typed address', /usecase=address/.test(out.url) && /at=29\.76040,-95\.36980/.test(out.url) && !/Smith|1600/i.test(decodeURIComponent(out.url)) && (nameParam === null || /^Area near /.test(nameParam)), out.url);
        const siteName = await D(() => document.querySelector('.dl-site-item .dl-impact-name')?.textContent ?? '');
        check(r, 'the site is named after the street address (kept in this tab only)', /^1600 Smith Street$/.test(siteName), siteName);
        await page.click('[data-site="share-link"]');
        const shared = await D(() => new URLSearchParams(location.search).get('sites'));
        check(r, 'its Share link (?sites=) carries the coordinates, not the address', !!shared && /29\.7604/.test(shared) && !/smith|1600/i.test(shared), String(shared));
        await addressSweep(r, '21');
        // The same link, reloaded: a fresh page reopens the area, the site and the rain ladder, and no ?name= spoof.
        await page.goto(new URL('?usecase=address&at=29.7604,-95.3698&name=EVACUATE%20NOW%20call%20555-0100', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
        const again = await addressSetUp(r, AT, 120_000, 'link');
        const spoof = await D(() => /EVACUATE|555-0100/.test(document.body.innerText));
        check(r, 'link: ?usecase=address&at= reopens it; a ?name= in the link never reaches the page', again.ok && !spoof, `${again.sites} site(s), ladder ${again.ladder}, spoof ${spoof ? 'SHOWN' : 'absent'}`);
        // A point outside the US: fixed warning, default scene, the address search open.
        await page.goto(new URL('?usecase=address&at=51.5,-0.12', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
        const asks = await page
          .waitForFunction(() => document.querySelector('[data-modal="usecases"].dl-open [data-uc-view="address"]:not([hidden])'), null, { timeout: 30_000 })
          .then(() => true, () => false);
        const bad = await D(() => ({ preset: window.__deluge.getState().presetId, text: document.body.innerText }));
        check(r, 'link: an at= outside the US loads the default scene and opens the address search', asks && bad.preset === 'pittsburgh', `preset ${bad.preset}, search ${asks ? 'open' : 'closed'}`);
        r.metrics.intercepted = intercepted.slice(0, 12);
      } finally {
        await page.unroute((u) => !isLocalUrl(u.href)).catch(() => {});
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
      }
    },
  },
  {
    id: 22,
    name: 'Check any US address against the real services (network): Houston, Atlas 14 sweep, EAL',
    timeoutMs: 900_000,
    optIn: 'live',
    network: true,
    resetsPage: true,
    async run(r, ctx) {
      // Real Nominatim, USGS 3DEP, Esri and TIGERweb. The address is a public building (Houston City Hall).
      const query = String(args.address ?? '901 Bagby St, Houston, TX');
      await page.goto(new URL('?preset=pittsburgh', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
      await page.click('.dl-uc-btn');
      await page.click('[data-usecase="address"]');
      await page.fill('[data-uc="address-input"]', query);
      await page.click('[data-uc="address-search"]');
      const found = await page.waitForSelector('[data-uc="address-choice"]', { timeout: 30_000 }).then(() => true, () => false);
      check(r, `Nominatim finds “${query}”`, found, found ? 'found' : 'no result');
      if (!found) return;
      const t0 = Date.now();
      await page.click('[data-uc="address-choice"]');
      const at = await page
        .waitForFunction(() => /[?&]at=/.test(location.search) && new URLSearchParams(location.search).get('at'), null, { timeout: 240_000 })
        .then((h) => h.jsonValue(), () => null);
      const [lat, lon] = String(at ?? 'NaN,NaN').split(',').map(Number);
      const out = await addressSetUp(r, { lat, lon }, 240_000);
      r.metrics.liveLoadSeconds = (Date.now() - t0) / 1000;
      r.metrics.at = { lat, lon };
      r.metrics.atlas14 = out.levels;
      if (!out.ok) return;
      await addressSweep(r, '22');
    },
  },
  {
    id: 23,
    name: 'Projects & design comparison: save / open a project with a wall and a site, compare two designs',
    timeoutMs: 900_000,
    async run(r) {
      if (PRESET !== 'pittsburgh') {
        r.notes.push(`${PRESET}: the flow is written for Pittsburgh's levee and ladder: skipped`);
        check(r, 'preset without the Pittsburgh levee (nothing to check)', true, PRESET);
        return;
      }
      const minutes = Number(args['compare-minutes'] ?? 6);
      await calm();
      const openSection = (id) =>
        D((sid) => {
          const sec = document.querySelector(`[data-section="${sid}"]`);
          if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head')?.click();
        }, id);
      const barrierCells = () => D(() => window.__deluge.getSolver().getBarrierCPU().reduce((n, v) => n + (v > 0.2 ? 1 : 0), 0));
      // Start without sites (flow 15 leaves none, but a rerun may).
      await D(() => document.querySelectorAll('.dl-site-remove').forEach((b) => b.click()));

      // Design A: the one-click levee (the real Try-it button), then the river back to normal pool.
      await D(() => window.__deluge.store.set({ paused: false }));
      await page.click('.dl-try-step[data-step="levee"]');
      const built = await page
        .waitForFunction(() => (window.__deluge.getProtection()?.wallCells ?? 0) > 500 && /remove levee/i.test(document.querySelector('.dl-try-step[data-step="levee"]')?.textContent ?? ''), null, { timeout: 30_000 })
        .then(() => true, () => false);
      await D(() => {
        const d = window.__deluge;
        d.setPaused(true);
        d.setStageOffset(0);
        d.actions.resetWater();
      });
      const leveeCells = await barrierCells();
      check(r, 'the one-click levee is up', built && leveeCells > 500, `${leveeCells} wall cells`);
      await openSection('designs');
      await page.click('[data-compare="capture"]');
      // Design B: a shorter wall — the levee's upstream half at the same crest.
      await page.click('[data-compare="clear"]');
      await page.waitForFunction(() => window.__deluge.getSolver().getBarrierCPU().every((v) => v <= 0.2), null, { timeout: 10_000 });
      const short = await D(() => {
        const d = window.__deluge;
        const lv = d.getScenario().levee;
        const n = Math.max(2, Math.ceil(lv.points.length / 2));
        const pts = lv.points.slice(0, n);
        let low = Infinity;
        for (const p of pts) low = Math.min(low, d.sampleAt(p.gx, p.gy).ground);
        const height = Math.min(10, Math.max(0.5, Math.ceil((lv.crest - low) * 10) / 10));
        d.drawWall(pts, height);
        return { n, of: lv.points.length, height };
      });
      await page.click('[data-compare="capture"]');
      const designs = await D(() => [...document.querySelectorAll('[data-design-id]')].map((e) => e.getAttribute('data-design-id')));
      check(r, 'two designs captured (the levee, and a shorter wall)', designs.join() === 'A,B', `${designs.join(', ')}; short wall: ${short.n} of ${short.of} levee points at ${short.height} m`);
      await D(() => {
        const name = document.querySelector('[data-compare-design="B"]');
        name.value = 'Shorter wall';
        name.dispatchEvent(new Event('change'));
        const a = document.querySelector('[data-compare-design="A"]');
        a.value = 'One-click levee';
        a.dispatchEvent(new Event('change'));
      });
      const wallCells = await barrierCells();

      // A site at the Point (as flow 15).
      const g = await D((p) => window.__deluge.geoToGrid(p.lon, p.lat), { lat: 40.4425, lon: -80.0085 });
      await D((p) => {
        const d = window.__deluge;
        d.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: d.sampleAt(p.gx, p.gy).ground }, distance: 900, yaw: 0, pitch: Math.PI / 2 - 0.01 });
      }, g);
      await D(() => window.__deluge.waitFrames(4));
      await D(() => window.__deluge.selectTool('site'));
      const box = await page.locator('#deluge-canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForFunction(() => document.querySelectorAll('.dl-site-item').length === 1, null, { timeout: 5000 });
      await D(() => window.__deluge.selectTool('orbit'));

      // Save the project.
      await openSection('project');
      await page.fill('[data-project="name"]', 'North Shore levee study');
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-project="save"]')]);
      const file = path.join(OUT, '23-project.deluge.json');
      await dl.saveAs(file);
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      const walls = saved.edits.filter((e) => e.op === 'wall');
      check(
        r,
        'the saved .deluge.json holds the scene, the wall, the site and both designs',
        dl.suggestedFilename().endsWith('.deluge.json') && saved.format === 'deluge-project' && saved.version === 1 && saved.scene.id === 'pittsburgh' && walls.length === 1 && saved.sites.length === 1 && saved.designs.length === 2 && saved.portfolio === null,
        `${dl.suggestedFilename()}, ${(fs.statSync(file).size / 1024).toFixed(1)} KB: ${saved.edits.length} edit(s), ${saved.sites.length} site, designs ${saved.designs.map((d) => `${d.name} (${d.edits.length} edit, ${d.edits[0]?.pts?.length / 2} pts)`).join(' / ')}`,
      );

      // Wipe it, then open the file again.
      await D(() => {
        const d = window.__deluge;
        d.actions.clearWalls();
        document.querySelectorAll('.dl-site-remove').forEach((b) => b.click());
        d.setStageOffset(2);
      });
      await page.setInputFiles('[data-project="file"]', file);
      const opened = await page
        .waitForFunction(() => /^Opened/.test(document.querySelector('[data-project="status"]')?.textContent ?? ''), null, { timeout: 30_000 })
        .then(() => true, () => false);
      const back = await D(() => ({
        status: document.querySelector('[data-project="status"]')?.textContent ?? '',
        sites: document.querySelectorAll('.dl-site-item').length,
        designs: [...document.querySelectorAll('[data-design-id]')].length,
        stage: window.__deluge.getState().stageOffset,
      }));
      const reopened = await barrierCells();
      check(r, 'opening the file puts the wall, the site, the designs and the scenario back', opened && back.sites === 1 && back.designs === 2 && Math.abs(reopened - wallCells) <= Math.max(2, wallCells * 0.01) && back.stage === 0, `${back.status.slice(0, 100)} · ${reopened} wall cells (saved ${wallCells}), stage ${back.stage}`);

      // Hostile file: refused with a fixed sentence, nothing changed.
      const hostile = path.join(OUT, '23-hostile.deluge.json');
      fs.writeFileSync(hostile, '{"format":"deluge-project","version":1,"name":"<img src=x onerror=window.__pwned=1>","__proto__":{"polluted":1}}');
      await page.setInputFiles('[data-project="file"]', hostile);
      await sleep(400);
      const refused = await D(() => ({ status: document.querySelector('[data-project="status"]')?.textContent ?? '', pwned: !!window.__pwned, polluted: ({}).polluted !== undefined }));
      check(r, 'a hostile project file is refused (no pollution, no markup)', /reserved key/.test(refused.status) && !refused.pwned && !refused.polluted, refused.status.slice(0, 100));

      // Compare: baseline + 2 designs on the FEMA 1 % level and the 1936 crest (return period typed: 500 yr, labelled).
      await openSection('designs');
      await page.fill('[data-compare-field="minutes"]', String(minutes));
      await page.dispatchEvent('[data-compare-field="minutes"]', 'change');
      await D(() => {
        for (const box of document.querySelectorAll('[data-compare-level]')) {
          const want = box.dataset.compareLevel === 'rp100' || box.dataset.compareLevel === 'record1936';
          if (box.checked !== want) box.click();
        }
        const rp = document.querySelector('[data-compare-rp="record1936"]');
        rp.value = '500';
        rp.dispatchEvent(new Event('change'));
      });
      const before = await D(() => {
        const s = window.__deluge.getState();
        return { stageOffset: s.stageOffset, paused: s.paused, sources: s.sources.length };
      });
      const t0 = Date.now();
      await page.click('[data-compare="run"]');
      // Mid-run, Clear walls waits (the run owns the map and puts the user's walls back from the edit log).
      await sleep(300);
      const midRun = await D(() => {
        window.__deluge.actions.clearWalls();
        return document.querySelector('.dl-notice.dl-show')?.textContent ?? '';
      });
      const done = await page
        .waitForFunction(() => /^(Done|Comparison stopped|Cancelled)/.test(document.querySelector('[data-compare="status"]')?.textContent ?? ''), null, { timeout: 800_000 })
        .then(() => true, () => false);
      const seconds = (Date.now() - t0) / 1000;
      const out = await D(() => ({
        status: document.querySelector('[data-compare="status"]')?.textContent ?? '',
        head: [...document.querySelectorAll('[data-compare="table"] thead th')].map((t) => t.textContent),
        rows: [...document.querySelectorAll('[data-compare="table"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
        maps: document.querySelectorAll('[data-compare-map]').length,
        transfer: document.querySelector('[data-compare="transfer"]')?.textContent ?? '',
        state: (() => {
          const s = window.__deluge.getState();
          return { stageOffset: s.stageOffset, paused: s.paused, sources: s.sources.length };
        })(),
      }));
      const after = await barrierCells();
      check(r, 'the 2-design comparison completes', done && /^Done/.test(out.status), `${out.status.slice(0, 110)} (${num(seconds, 1)} s wall)`);
      const row = (label) => out.rows.find((x) => x[0].startsWith(label)) ?? [];
      check(r, 'the table has loss per level, EAL, ΔEAL, cost, NPV, BCR, protected and transferred risk for both designs', out.head.length === 4 && ['Loss · FEMA', 'Loss · 1936', 'Expected annual loss', 'ΔEAL', 'Cost', 'NPV at 7 %', 'NPV at 3.1 %', 'BCR at 7 %', 'BCR at 3.1 %', 'Buildings protected', 'Buildings newly reached', 'Land newly flooded'].every((l) => row(l).length === 4), out.head.join(' | '));
      check(r, 'a depth-change map per design', out.maps === 2, `${out.maps} maps`);
      check(r, 'your scenario and walls are put back', JSON.stringify(out.state) === JSON.stringify(before) && Math.abs(after - reopened) <= 2, `${JSON.stringify(out.state)}; ${after} wall cells (were ${reopened})`);
      r.metrics.compare = { minutes, seconds, head: out.head, rows: out.rows, transfer: out.transfer };
      for (const x of out.rows) console.log(`    ${x.join(' | ')}`);

      // Benefit–cost: every BCR with its range and the uncertainties named; inputs recompute without a re-run.
      const bcaTable = () =>
        D(() => ({
          rows: [...document.querySelectorAll('[data-compare="bca"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
          note: document.querySelector('[data-compare="bca-note"]')?.textContent ?? '',
        }));
      const bca0 = await bcaTable();
      const brow = (t, label) => t.rows.find((x) => x[0].startsWith(label)) ?? [];
      r.metrics.bca = { at7: bca0.rows, note: bca0.note };
      for (const x of bca0.rows) console.log(`    ${x.join(' | ')}`);
      check(
        r,
        'the benefit–cost block gives each design ΔEAL, PV, BCR with its range, net benefit, break-even cost and a verdict, and names its uncertainties',
        ['Avoided EAL', 'Useful life', 'PV of benefits at 7 %', 'PV of costs', 'BCR (central)', 'BCR range', 'BCR · damage curves', 'Net benefit', 'Break-even', 'Verdict'].every((l) => brow(bca0, l).length === 3) &&
          brow(bca0, 'Useful life').every((v, k) => k === 0 || /^50 yr \(FEMA standard\)$/.test(v)) &&
          /damage curves ±1σ/.test(bca0.note) &&
          /Never included/.test(bca0.note),
        `BCR ${brow(bca0, 'BCR (central)').slice(1).join(' / ')}; range ${brow(bca0, 'BCR range').slice(1).join(' / ')}`,
      );
      const bcrA0 = Number((brow(bca0, 'BCR (central)')[1] ?? '').replace('−', '-'));
      await page.fill('[data-compare-field="life-A"]', '30');
      await page.dispatchEvent('[data-compare-field="life-A"]', 'change');
      const bca30 = await bcaTable();
      const bcrA30 = Number((brow(bca30, 'BCR (central)')[1] ?? '').replace('−', '-'));
      await page.fill('[data-compare-field="discount-rate"]', '3.1');
      await page.dispatchEvent('[data-compare-field="discount-rate"]', 'change');
      const bca31 = await bcaTable();
      const bcrA31 = Number((brow(bca31, 'BCR (central)')[1] ?? '').replace('−', '-'));
      check(
        r,
        'a shorter useful life lowers the BCR and a lower discount rate raises it, without re-running',
        bcrA0 > 0 && bcrA30 < bcrA0 && bcrA31 > bcrA30 && /^30 yr \(your input/.test(brow(bca30, 'Useful life')[1] ?? '') && brow(bca31, 'PV of benefits at 3.1 %').length === 3 && /^Done/.test(await D(() => document.querySelector('[data-compare="status"]')?.textContent ?? '')),
        `design A BCR ${bcrA0} (50 yr, 7 %) → ${bcrA30} (30 yr) → ${bcrA31} (30 yr, 3.1 %)`,
      );
      r.metrics.bca.design30at31 = bca31.rows;
      await D(() => document.querySelector('[data-compare="results"]')?.scrollIntoView({ block: 'start' }));
      await sleep(400);
      const panelShot = path.join(OUT, '23-compare.png');
      await page.locator('.dl-panel').screenshot({ path: panelShot });
      console.log(`  [shot] ${path.relative(ROOT, panelShot)}`);

      // The report.
      const [rep] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-compare="report-html"]')]);
      const repFile = path.join(OUT, '23-design-comparison.html');
      await rep.saveAs(repFile);
      const html = fs.readFileSync(repFile, 'utf8');
      const need = [
        'mitigation design comparison',
        'One-click levee',
        'Shorter wall',
        'Expected annual loss',
        'BCR at 7 %',
        'NPV at 3.1 %',
        'Who gets wetter',
        'Change in maximum depth',
        'data:image/png',
        'your input',
        'Benefit–cost',
        'BCR range',
        'Appendix — FEMA BCA Toolkit inputs',
        'This is not a FEMA-accepted benefit–cost analysis',
        'Damages before mitigation',
        'Damages after mitigation',
        'Project useful life',
        'Analysis year',
        'not the Toolkit’s default (7 %)',
      ];
      const missing = need.filter((s) => !html.includes(s));
      check(r, 'the comparison report renders every section, with the maps and no script', missing.length === 0 && !/<script/i.test(html), missing.length ? `missing: ${missing.join(', ')}` : `${(html.length / 1024).toFixed(0)} KB`);

      // Save again: the comparison's numbers travel in the project.
      const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-project="save"]')]);
      const file2 = path.join(OUT, '23-project-with-results.deluge.json');
      await dl2.saveAs(file2);
      const saved2 = JSON.parse(fs.readFileSync(file2, 'utf8'));
      check(r, 'a saved project carries the comparison summary', saved2.comparison?.designs?.length === 2 && saved2.comparison.levels.length === 2, saved2.comparison ? `${saved2.comparison.designs.map((d) => `${d.name}: BCR7 ${d.bcr7 == null ? '—' : d.bcr7.toFixed(2)}`).join('; ')}` : 'none');
      const c2 = saved2.comparison?.designs?.[0];
      check(
        r,
        'the project keeps the benefit–cost inputs (rate, analysis year, useful life) and the BCR with its range',
        saved2.bca?.discountRate === 0.031 && Number.isInteger(saved2.bca?.analysisYear) && saved2.designs[0].cost.usefulLifeYears === 30 && saved2.designs[1].cost.usefulLifeYears == null && saved2.comparison?.discountRate === 0.031 && c2?.years === 30 && c2.bcrLow <= c2.bcr && c2.bcr <= c2.bcrHigh,
        `bca ${JSON.stringify(saved2.bca)}; design A ${c2 ? `${c2.years} yr, BCR ${c2.bcr?.toFixed(2)} (${c2.bcrLow?.toFixed(2)}–${c2.bcrHigh?.toFixed(2)})` : '—'}`,
      );
      const walls2 = saved2.edits.filter((e) => e.op === 'wall').length;
      check(r, 'Clear walls during the comparison waits, and the edit log still matches the walls on the map', /Map editing paused/.test(midRun) && walls2 === 1, `notice: ${midRun.slice(0, 60) || '(none)'}; ${walls2} wall(s) in the saved log`);

      // Share link: small enough, and it opens the walls and the site in a fresh tab.
      await page.click('[data-project="share"]');
      await page.waitForFunction(() => new URL(location.href).searchParams.has('project'), null, { timeout: 10_000 }).catch(() => {});
      const link = await D(() => location.href);
      const value = new URL(link).searchParams.get('project') ?? '';
      const tab = await page.context().newPage();
      await tab.goto(link, { waitUntil: 'domcontentloaded' });
      await tab.waitForFunction(() => window.__deluge, null, { timeout: 90_000 });
      await tab.evaluate(() => window.__deluge.ready);
      const linked = await tab
        .waitForFunction(() => document.querySelectorAll('.dl-site-item').length === 1 && window.__deluge.getSolver()?.getBarrierCPU().some((v) => v > 0.2), null, { timeout: 60_000 })
        .then(() => true, () => false);
      const tabInfo = await tab.evaluate(() => ({
        cells: window.__deluge.getSolver().getBarrierCPU().reduce((n, v) => n + (v > 0.2 ? 1 : 0), 0),
        designs: document.querySelectorAll('[data-design-id]').length,
        names: [...document.querySelectorAll('.dl-site-item .dl-impact-name')].map((e) => e.textContent),
        rate: document.querySelector('[data-compare-field="discount-rate"]')?.value ?? '',
        lifeA: document.querySelector('[data-compare-field="life-A"]')?.value ?? '',
        lifeB: document.querySelector('[data-compare-field="life-B"]')?.value ?? '',
      }));
      await tab.close();
      check(r, 'the ?project= link reopens the wall, the site and the designs (no names carried)', value.startsWith('p1.') && value.length <= 6000 && linked && tabInfo.designs === 2 && tabInfo.names.join() === 'Site 1', `${value.length} characters; ${tabInfo.cells} wall cells, ${tabInfo.designs} designs, sites: ${tabInfo.names.join(', ')}`);
      check(r, 'the link round-trips the benefit–cost inputs (3.1 %, design A 30 yr, design B FEMA default)', tabInfo.rate === '3.1' && tabInfo.lifeA === '30' && tabInfo.lifeB === '', `rate ${tabInfo.rate} %, life A ${tabInfo.lifeA || '(default)'}, life B ${tabInfo.lifeB || '(default)'}`);

      // Leave the app as the other flows expect it.
      await D(() => {
        const u = new URL(location.href);
        u.searchParams.delete('project');
        history.replaceState(null, '', u);
        document.querySelectorAll('.dl-site-remove').forEach((b) => b.click());
      });
      if (/remove levee/i.test((await page.locator('.dl-try-step[data-step="levee"]').textContent()) ?? '')) await page.click('.dl-try-step[data-step="levee"]');
      await calm();
    },
  },
  {
    id: 24,
    name: 'Land surface: buildings block flow, land-cover roughness and storm drains',
    timeoutMs: 300_000,
    async run(r) {
      // src/app/landSurface.ts → FloodSolver.setLandSurface (ARCHITECTURE.md §3.11). The Advanced panel's switches, what
      // the solver ends up with, and that rain on a blocked city stays out of the footprints with mass intact.
      const setSim = (patch) => D((p) => window.__deluge.store.set({ sim: { ...window.__deluge.getState().sim, ...p } }), patch);
      const land = () =>
        D(() => ({
          solver: window.__deluge.getSolver()?.landSurfaceState ?? null,
          status: window.__deluge.getState().landSurface ?? null,
          switches: Object.fromEntries(
            [...document.querySelectorAll('[data-section="advanced"] .dl-switch')].map((b) => [b.textContent?.trim() ?? '', b.getAttribute('aria-checked')]),
          ),
          note: [...document.querySelectorAll('[data-section="advanced"] .dl-impact-fine')].map((e) => e.textContent ?? '').join(' '),
        }));
      await calm();
      const off = await land();
      r.metrics.off = off;
      check(r, 'Pittsburgh has footprints and NLCD 2021 land cover; every layer starts off', !!off.status && off.status.obstacleCells > 20_000 && off.status.porousCells > 50_000 && off.status.landCover === 'NLCD 2021' && off.solver?.obstacles === 0 && !off.solver.roughness && !off.solver.drains, JSON.stringify(off.status));
      check(r, 'the Advanced panel shows the switches and the honest fine print', 'Buildings block flow' in off.switches && 'Storm drains' in off.switches && /not a pipe network/.test(off.note), Object.keys(off.switches).join(', '));
      await setSim({ buildingObstacles: true, roughnessMap: true, drainage: true });
      const on = await land();
      r.metrics.on = on;
      check(r, 'switching on reaches the solver and the panel', on.solver?.obstacles === off.status.obstacleCells && on.solver.porous === off.status.porousCells && on.solver.roughness && on.solver.drains && on.switches['Buildings block flow'] === 'true', JSON.stringify(on.solver));
      const before = await stats();
      await D(() => window.__deluge.setRain(100));
      await runFor(600);
      const after = await stats();
      // Blocked cells stay dry under the rain apart from the film running off their roofs (a handful of roofs lower than
      // the hillside beside them fill like pits: ARCHITECTURE.md §3.11), so fewer than 0.5 % hold 10 cm.
      const roof = await D(() => {
        const d = window.__deluge;
        const s = d.getSolver();
        const obst = s?.getObstacleCPU?.();
        if (!obst) return null;
        const depth = s.getSnapshot()?.depth;
        let blocked = 0;
        let maxRoof = 0;
        let deep = 0;
        for (let c = 0; c < obst.length; c++) {
          if (obst[c] > 0) {
            blocked++;
            if (depth && depth[c] > maxRoof) maxRoof = depth[c];
            if (depth && depth[c] >= 0.1) deep++;
          }
        }
        return { blocked, maxRoof, deep };
      });
      r.metrics.roof = roof;
      check(r, 'no water stands in a footprint (roof films; < 0.5 % of blocked cells hold 10 cm)', !!roof && roof.blocked > 20_000 && roof.deep < 0.005 * roof.blocked, JSON.stringify(roof));
      check(r, 'drains take water out and it is booked (volumeOut grows; mass balance < 0.1 %)', (after?.volumeOut ?? 0) > (before?.volumeOut ?? 0) && (after?.massError ?? 1) < 1e-3, `out ${m3(before?.volumeOut)} → ${m3(after?.volumeOut)}, massError ${num((after?.massError ?? NaN) * 100, 5)} %`);
      await D(() => window.__deluge.setWaterMode('depth'));
      await shot('24-land-surface');
      await setSim({ buildingObstacles: false, roughnessMap: false, drainage: false });
      const back = await land();
      check(r, 'switching off restores the bare-earth solver', back.solver?.obstacles === 0 && back.solver.porous === 0 && !back.solver.roughness && !back.solver.drains, JSON.stringify(back.solver));
      await D(() => {
        window.__deluge.setRain(0);
        window.__deluge.setWaterMode('realistic');
      });
    },
  },
  {
    id: 25,
    name: 'Infrastructure & evacuation on foot: Pittsburgh 1936 and Houston — facilities out, a site’s walking evacuation, dependencies, report',
    timeoutMs: 600_000,
    async run(r) {
      /** Drop one site at a lon/lat (camera straight down on it, click with the Site tool); clears earlier sites first. */
      const placeSite = async (lonlat) => {
        await D(() => {
          for (const b of document.querySelectorAll('.dl-site-remove')) b.click();
        });
        const g = await D((p) => window.__deluge.geoToGrid(p.lon, p.lat), lonlat);
        await D((p) => {
          const d = window.__deluge;
          d.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: d.sampleAt(p.gx, p.gy).ground }, distance: 1600, yaw: 0, pitch: Math.PI / 2 - 0.01 });
        }, g);
        await D(() => window.__deluge.waitFrames(4));
        await D(() => window.__deluge.selectTool('site'));
        const box = await page.locator('#deluge-canvas').boundingBox();
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForFunction(() => document.querySelectorAll('.dl-site-item').length === 1, null, { timeout: 5000 });
        await D(() => window.__deluge.selectTool('orbit'));
      };
      /** Infrastructure: open the section, assess, read the summary. */
      const assessInfra = async (tag) => {
        await D(() => {
          const sec = document.querySelector('[data-section="infra"]');
          if (!sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head').click();
        });
        await page.waitForFunction(() => !document.querySelector('[data-infra="assess"]')?.disabled, null, { timeout: 20_000 });
        await page.click('[data-infra="assess"]');
        await page.waitForFunction(() => /Flood at T\+/.test(document.querySelector('[data-infra="status"]')?.textContent ?? ''), null, { timeout: 30_000 });
        const out = await D(() => ({
          summary: document.querySelector('[data-infra="summary"]')?.textContent ?? '',
          rows: [...document.querySelectorAll('[data-infra-row]')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '').slice(1).join(' | ')),
          pins: document.querySelectorAll('.dl-infra-pin').length,
          failedPins: document.querySelectorAll('.dl-infra-pin.dl-infra-failed').length,
        }));
        await D(() => document.querySelector('[data-infra="summary"]')?.scrollIntoView({ block: 'start' }));
        await sleep(400);
        const sp = path.join(OUT, `25-${tag}-infra-panel.png`);
        await page.locator('.dl-panel').screenshot({ path: sp });
        console.log(`  [shot] ${path.relative(ROOT, sp)}`);
        return out;
      };
      /** Site check: assess this run and read the evacuation-on-foot and dependency blocks. */
      const assessSite = async (tag) => {
        await page.click('[data-section="site"] button:has-text("Assess this run")');
        await page.waitForFunction(() => /reach safety on foot|not assessed/.test(document.querySelector('[data-site="people"]')?.textContent ?? ''), null, { timeout: 60_000 });
        await page.waitForFunction(() => /Power|Dependencies/.test(document.querySelector('[data-site="deps"]')?.textContent ?? '') && !/loading facilities/.test(document.querySelector('[data-site="deps"]')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => {});
        const out = await D(() => ({
          people: [...document.querySelectorAll('[data-people="summary"] p')].map((p) => p.textContent ?? ''),
          deps: [...document.querySelectorAll('[data-site="deps"] dt')].map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent ?? ''}`),
          flags: [...document.querySelectorAll('[data-site="dep-flags"] li')].map((li) => li.textContent ?? ''),
          walkPts: (document.querySelector('[data-site="walk-route"]')?.getAttribute('points') ?? '').split(' ').filter(Boolean).length,
        }));
        await D(() => document.querySelector('[data-site="people"]')?.scrollIntoView({ block: 'start' }));
        await sleep(400);
        const sp = path.join(OUT, `25-${tag}-site-card.png`);
        await page.locator('.dl-panel').screenshot({ path: sp });
        console.log(`  [shot] ${path.relative(ROOT, sp)}`);
        await shot(`25-${tag}-map`);
        return out;
      };

      // ── Pittsburgh at the 1936 crest ──
      await D((p) => window.__deluge.loadPreset(p), 'pittsburgh');
      await calm();
      const crest = await crestOffset();
      await D((o) => window.__deluge.setStageOffset(o), crest.offset);
      await runFor(1800);
      const pi = await assessInfra('pittsburgh');
      r.metrics.pittsburghInfra = pi.summary;
      r.metrics.pittsburghInfraRows = pi.rows.slice(0, 12);
      check(r, 'Pittsburgh 1936: facilities assessed, some out of service, icons on the map', /out of service/.test(pi.summary) && pi.rows.length > 0 && pi.pins > 50 && pi.failedPins > 0, `${pi.summary.slice(0, 140)} · ${pi.pins} icons (${pi.failedPins} red)`);
      // A three-storey office on the North Shore, by PNC Park.
      await placeSite({ lon: -80.0057, lat: 40.4474 });
      const ps = await assessSite('pittsburgh');
      r.metrics.pittsburghSite = ps;
      check(r, 'site card: everyone-out time, X of N, vertical evacuation', ps.people.length === 3 && /Everyone out of the building by T\+/.test(ps.people[0]) && /of [\d,]+ reach safety on foot/.test(ps.people[1]) && /Vertical evacuation feasible: (yes|no)/.test(ps.people[2]), ps.people.join(' / ').slice(0, 300));
      check(r, 'walking route drawn on the map (dashed, distinct from the car route)', ps.walkPts >= 2, `${ps.walkPts} points`);
      check(r, 'dependency lines: power (approximate service area), hospital, fire station', ps.deps.some((d) => /^Power: .*approximate service area/.test(d)) && ps.deps.some((d) => /^Hospital:/.test(d)) && ps.deps.some((d) => /^Fire station:/.test(d)), ps.deps.join(' / ').slice(0, 300));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-site="report-html"]')]);
      const file = path.join(OUT, '25-site-assessment.html');
      await dl.saveAs(file);
      const html = fs.readFileSync(file, 'utf8');
      const has = ['Evacuation on foot', 'Infrastructure dependencies', 'reach safety on foot', 'Vertical evacuation feasible', 'approximate service area', 'SFPE', 'FD2321', 'Voronoi'];
      const missing = has.filter((s) => !html.includes(s));
      check(r, 'site assessment report carries both sections and their methods', missing.length === 0 && !/<script/i.test(html), missing.length ? `missing: ${missing.join(', ')}` : `${(html.length / 1024).toFixed(0)} KB`);

      // ── Houston, Harvey rain ──
      await D((p) => window.__deluge.loadPreset(p), 'houston');
      await D(() => {
        const d = window.__deluge;
        d.actions.restoreScenario();
        d.setPaused(false);
        d.actions.resetWater();
      });
      await runFor(1200);
      const hi = await assessInfra('houston');
      r.metrics.houstonInfra = hi.summary;
      r.metrics.houstonInfraRows = hi.rows.slice(0, 12);
      check(r, 'Houston: facilities assessed against the Harvey rain', /operational/.test(hi.summary) && hi.pins > 50, `${hi.summary.slice(0, 160)} · ${hi.pins} icons`);
      // Downtown Houston, by City Hall.
      await placeSite({ lon: -95.3694, lat: 29.7604 });
      const hs = await assessSite('houston');
      r.metrics.houstonSite = hs;
      check(r, 'Houston site: walking evacuation and dependencies assessed', hs.people.length >= 2 && /reach safety on foot/.test(hs.people.join(' ')) && hs.deps.some((d) => /^Power:/.test(d)), `${hs.people.join(' / ').slice(0, 240)} · ${hs.deps.slice(0, 2).join(' / ').slice(0, 160)}`);
      await D(() => {
        for (const b of document.querySelectorAll('.dl-site-remove')) b.click();
      });
      await D((p) => window.__deluge.loadPreset(p), PRESET);
      await calm();
    },
  },
  {
    id: 50,
    name: 'Leaving by road: departure curve after the alert and the queue at the exit — share out before the last route closes, clearance vs window, shelters as dependencies',
    timeoutMs: 300_000,
    async run(r) {
      await D((p) => window.__deluge.loadPreset(p), 'pittsburgh');
      await calm();
      const crest = await crestOffset();
      await D((o) => window.__deluge.setStageOffset(o), crest.offset);
      await runFor(1800);
      // A pin on the North Shore demo parcel A (between the stadiums).
      await D(() => {
        for (const b of document.querySelectorAll('.dl-site-remove')) b.click();
      });
      const g = await D((p) => window.__deluge.geoToGrid(p.lon, p.lat), { lon: -80.0124, lat: 40.446 });
      await D((p) => {
        const d = window.__deluge;
        d.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: d.sampleAt(p.gx, p.gy).ground }, distance: 1600, yaw: 0, pitch: Math.PI / 2 - 0.01 });
      }, g);
      await D(() => window.__deluge.waitFrames(4));
      await D(() => {
        const sec = document.querySelector('[data-section="site"]');
        if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head')?.click();
      });
      await D(() => window.__deluge.selectTool('site'));
      const box = await page.locator('#deluge-canvas').boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForFunction(() => document.querySelectorAll('.dl-site-item').length === 1, null, { timeout: 5000 });
      await D(() => window.__deluge.selectTool('orbit'));
      await page.click('[data-section="site"] button:has-text("Assess this run")');
      await page.waitForFunction(() => /occupants out before|No route to a shelter closes|Not assessed/.test(document.querySelector('[data-site="road"]')?.textContent ?? ''), null, { timeout: 60_000 });
      // The card re-renders (the extras block fills in after the card is on screen): wait for a filled road block.
      const read = async () => {
        await page.waitForFunction(() => (document.querySelector('[data-road="share"]')?.textContent ?? '') !== '' && (document.querySelector('[data-site="deps"]')?.textContent ?? '') !== '', null, { timeout: 30_000 });
        await page.waitForFunction(() => !/loading facilities/.test(document.querySelector('[data-site="deps"]')?.textContent ?? ''), null, { timeout: 30_000 }).catch(() => {});
        return readNow();
      };
      const readNow = () =>
        D(() => ({
          share: document.querySelector('[data-road="share"]')?.textContent ?? '',
          clearance: document.querySelector('[data-road="clearance"]')?.textContent ?? '',
          block: document.querySelector('[data-site="road"]')?.textContent ?? '',
          caveats: [...document.querySelectorAll('[data-road="caveats"] li')].map((li) => li.textContent ?? ''),
          shelters: [...document.querySelectorAll('[data-site="deps"] dt')].filter((dt) => /^Shelter /.test(dt.textContent ?? '')).map((dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent ?? ''}`),
        }));
      const at0 = await read();
      r.metrics.alertAtT0 = at0;
      check(
        r,
        'road block: share of occupants out before the last route closes, with the p10–p90 departure band',
        /^(\d+|< 1|> 99) % of occupants out before the last route closes \(departures p10–p90 \d+ min–\d+ h \d+ min after the alert, “Unprepared, threat seen as likely”\)/.test(at0.share) || /^No route to a shelter closes/.test(at0.share),
        at0.share.slice(0, 220),
      );
      check(r, 'road block: clearance time vs route window, cars through the bottleneck', /^Clearance time .+ vs (route window .+|a route window that stays open through the run): [\d,]+ cars \([\d,]+ occupants ÷ 1\.18\) through .+ cars\/h/.test(at0.clearance), at0.clearance.slice(0, 220));
      check(r, 'plain-language caveats: published curve, other traffic, the time-lapse rise', at0.caveats.some((c) => /Sorensen & Mileti 2015b/.test(c)) && at0.caveats.some((c) => /lower bound/.test(c)) && at0.caveats.some((c) => /time-lapsed/.test(c)), `${at0.caveats.length} caveats`);
      check(r, 'shelters listed as dependencies (own flooding, substation)', at0.shelters.length > 0 && at0.shelters.every((s) => /stays dry|floods itself|substation/.test(s)), at0.shelters.slice(0, 3).join(' / ').slice(0, 260));
      // The alert 3 h before the run: a longer window, more people out.
      await page.fill('[data-site="extras"] [data-people="alert"]', '-180');
      await page.dispatchEvent('[data-site="extras"] [data-people="alert"]', 'change');
      await page.waitForFunction((before) => (document.querySelector('[data-road="share"]')?.textContent ?? '') !== before, at0.share, { timeout: 30_000 });
      const early = await read();
      r.metrics.alertAtTminus180 = early;
      const pctOf = (s) => {
        const m = /^(\d+|< 1|> 99) %/.exec(s);
        return !m ? NaN : m[1] === '< 1' ? 0.5 : m[1] === '> 99' ? 99.5 : Number(m[1]);
      };
      check(r, 'an alert 3 h before the run lets more occupants out', pctOf(early.share) > pctOf(at0.share) || /^No route/.test(early.share), `${at0.share.slice(0, 40)} → ${early.share.slice(0, 40)}`);
      // The prepared curve and two exit lanes: faster departures, a shorter clearance.
      await page.selectOption('[data-road="curve"]', 'good-likely');
      await page.waitForFunction(() => /Prepared, threat seen as likely/.test(document.querySelector('[data-road="share"]')?.textContent ?? ''), null, { timeout: 30_000 });
      const prepared = await read();
      r.metrics.prepared = prepared;
      const minutes = (s) => {
        const m = /^Clearance time (?:(\d+) h (\d+) min|(\d+) min)/.exec(s);
        return !m ? NaN : m[3] ? Number(m[3]) : Number(m[1]) * 60 + Number(m[2]);
      };
      check(r, 'the prepared curve clears sooner than the default one', minutes(prepared.clearance) < minutes(early.clearance), `${minutes(early.clearance)} → ${minutes(prepared.clearance)} min`);
      await D(() => document.querySelector('[data-site="road"]')?.scrollIntoView({ block: 'start' }));
      await sleep(400);
      const sp = path.join(OUT, '50-road-block.png');
      await page.locator('.dl-panel').screenshot({ path: sp });
      console.log(`  [shot] ${path.relative(ROOT, sp)}`);
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-site="report-html"]')]);
      const file = path.join(OUT, '50-site-assessment.html');
      await dl.saveAs(file);
      const html = fs.readFileSync(file, 'utf8');
      const has = ['Leaving by road', 'Out before the last route closes', 'Clearance vs route window', 'Sorensen &amp; Mileti', 'saturation flow', 'Shelter '];
      const missing = has.filter((s) => !html.includes(s));
      check(r, 'report: leaving-by-road section, its method and the shelters', missing.length === 0 && !/<script/i.test(html), missing.length ? `missing: ${missing.join(', ')}` : `${(html.length / 1024).toFixed(0)} KB`);
      await D(() => {
        for (const b of document.querySelectorAll('.dl-site-remove')) b.click();
      });
      await D((p) => window.__deluge.loadPreset(p), PRESET);
      await calm();
    },
  },
  {
    id: 26,
    name: 'Dam breach: NID search → valley below the dam → breach wave → arrivals; link (fixtures)',
    timeoutMs: 600_000,
    resetsPage: true,
    async run(r, ctx) {
      // Hermetic: USGS 3DEP is answered from a synthetic valley falling south from Edenville Dam's NID point (a 222 m
      // dam ridge across it, a flat reservoir north of it); everything else external is refused. The dam index is the
      // real baked file from our own server.
      const intercepted = [];
      await page.route((u) => !isLocalUrl(u.href), (route) => damFixtures(route, intercepted, EDENVILLE));
      try {
        await damFlow(r, ctx, { tag: '26', fixtures: true });
        // Hostile link: a bad nid is a fixed warning, never echoed, and the dam search opens.
        await page.goto(new URL('?usecase=dam&nid=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E&breach=EVACUATE', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
        const asks = await page.waitForSelector('[data-modal="usecases"].dl-open [data-uc-view="dam"]:not([hidden])', { timeout: 30_000 }).then(() => true, () => false);
        const bad = await D(() => ({ text: document.body.innerText, pwned: !!window.__pwned, imgs: document.querySelectorAll('img[src="x"]').length }));
        check(r, 'link: a hostile nid= is a fixed warning, never echoed; the dam search opens', asks && !/EVACUATE|onerror/.test(bad.text) && /invalid dam link value/.test(bad.text) && !bad.pwned && bad.imgs === 0, `search ${asks ? 'open' : 'closed'}`);
        r.metrics.intercepted = intercepted.slice(0, 12);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
      }
    },
  },
  {
    id: 27,
    name: 'Coastal surge: point → live area → sea boundary → NOAA EWL ladder sweep → EAL (fixtures)',
    timeoutMs: 900_000,
    resetsPage: true,
    async run(r, ctx) {
      // Hermetic: 3DEP is a synthetic coast west of downtown Fort Myers (open water at 0 m, land rising east through the
      // site at ~1.5 m NAVD88); the NOAA station table is the real baked file. The point is typed as lat, lon, so no
      // geocoder is involved.
      const intercepted = [];
      await page.route((u) => !isLocalUrl(u.href), (route) => surgeFixtures(route, intercepted, FTM_POINT));
      try {
        await surgeFlow(r, ctx, { tag: '27', fixtures: true, minutes: 30 });
        r.metrics.intercepted = intercepted.slice(0, 12);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
      }
    },
  },
  {
    id: 28,
    name: 'Dam breach against the real services (network): Edenville Dam, flood-induced',
    timeoutMs: 900_000,
    optIn: 'live',
    network: true,
    resetsPage: true,
    async run(r, ctx) {
      await damFlow(r, ctx, { tag: '28', fixtures: false, simMinutes: Number(args['dam-minutes'] ?? 90) });
    },
  },
  {
    id: 29,
    name: 'Coastal surge against the real services (network): Fort Myers Beach, EWL sweep, EAL',
    timeoutMs: 1_500_000,
    optIn: 'live',
    network: true,
    resetsPage: true,
    async run(r, ctx) {
      // Fort Myers Beach (Estero Island), where Hurricane Ian's surge did its worst; --surge-at=lat,lon for another point.
      const at = String(args['surge-at'] ?? '26.4515,-81.9506').split(',').map(Number);
      await surgeFlow(r, ctx, { tag: '29', fixtures: false, minutes: Number(args['surge-minutes'] ?? 90), point: { lat: at[0], lon: at[1] }, ffh: 0 });
    },
  },
  {
    id: 45,
    name: 'Benefit–cost with the ensemble: the levee’s BCR at the ensemble’s p10 / p50 / p90, labelled',
    timeoutMs: 900_000,
    async run(r) {
      if (PRESET !== 'pittsburgh') {
        r.notes.push(`${PRESET}: the flow is written for Pittsburgh's levee and ladder: skipped`);
        check(r, 'preset without the Pittsburgh levee (nothing to check)', true, PRESET);
        return;
      }
      const minutes = Number(args['compare-minutes'] ?? 6);
      await calm();
      const openSection = (id) =>
        D((sid) => {
          const sec = document.querySelector(`[data-section="${sid}"]`);
          if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head')?.click();
        }, id);
      // Start from no designs (flow 23 leaves two), then capture the one-click levee as the only design.
      await openSection('designs');
      await D(() => {
        for (const card of document.querySelectorAll('[data-design-id]')) [...card.querySelectorAll('button')].find((b) => /Remove/.test(b.textContent ?? ''))?.click();
      });
      await page.click('.dl-try-step[data-step="levee"]');
      const built = await page
        .waitForFunction(() => (window.__deluge.getProtection()?.wallCells ?? 0) > 500 && /remove levee/i.test(document.querySelector('.dl-try-step[data-step="levee"]')?.textContent ?? ''), null, { timeout: 30_000 })
        .then(() => true, () => false);
      await D(() => window.__deluge.setPaused(true));
      await page.click('[data-compare="capture"]');
      const captured = await D(() => [...document.querySelectorAll('[data-design-id]')].map((e) => e.getAttribute('data-design-id')).join());
      check(r, 'the one-click levee is captured as the only design', built && captured === 'A', captured);

      // The ensemble: the bare scene at the 1936 crest, 3 members.
      await page.click('[data-compare="clear"]');
      await page.waitForFunction(() => window.__deluge.getSolver().getBarrierCPU().every((v) => v <= 0.2), null, { timeout: 10_000 });
      const crest = await crestOffset();
      await D((o) => {
        const d = window.__deluge;
        d.setStageOffset(o);
        d.actions.resetWater();
      }, crest.offset);
      await D(() => {
        const sec = document.querySelector('[data-section="ensemble"]');
        if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head').click();
      });
      for (const [name, v] of [['members', '3'], ['minutes', String(minutes)]]) {
        await page.fill(`[data-ens-field="${name}"]`, v);
        await page.dispatchEvent(`[data-ens-field="${name}"]`, 'change');
      }
      await page.click('[data-ens="run"]');
      const ensDone = await page
        .waitForFunction(() => /^(Done|Stopped|Cancelled)/.test(document.querySelector('[data-ens="status"]')?.textContent ?? ''), null, { timeout: 480_000 })
        .then(() => true, () => false);
      const ens = await D(() => window.__deluge.getEnsemble());
      check(r, 'a 3-member ensemble of the bare scene at the 1936 crest completes with a loss band', ensDone && ens?.members === 3 && Array.isArray(ens.loss) && ens.loss[1] > 0, ens ? `loss p10 / p50 / p90 ${ens.loss.map((v) => `$${num(v / 1e9, 2)} B`).join(' / ')}` : 'none');

      // Compare on the 1936 crest with the 500-year return period typed (the user's input, as in flow 23).
      await openSection('designs');
      await page.fill('[data-compare-field="minutes"]', String(minutes));
      await page.dispatchEvent('[data-compare-field="minutes"]', 'change');
      // The FEMA default rate (flow 23 leaves 3.1 % behind when run first).
      await page.fill('[data-compare-field="discount-rate"]', '7');
      await page.dispatchEvent('[data-compare-field="discount-rate"]', 'change');
      await D(() => {
        const sel = document.querySelector('[data-compare="ladder"]');
        if (sel && sel.value !== 'stage') {
          sel.value = 'stage';
          sel.dispatchEvent(new Event('change'));
        }
      });
      await D(() => {
        for (const box of document.querySelectorAll('[data-compare-level]')) {
          const want = box.dataset.compareLevel === 'record1936';
          if (box.checked !== want) box.click();
        }
        const rp = document.querySelector('[data-compare-rp="record1936"]');
        rp.value = '500';
        rp.dispatchEvent(new Event('change'));
      });
      await page.click('[data-compare="run"]');
      const done = await page
        .waitForFunction(() => /^(Done|Comparison stopped|Cancelled)/.test(document.querySelector('[data-compare="status"]')?.textContent ?? ''), null, { timeout: 600_000 })
        .then(() => true, () => false);
      const out = await D(() => ({
        status: document.querySelector('[data-compare="status"]')?.textContent ?? '',
        rows: [...document.querySelectorAll('[data-compare="bca"] tbody tr')].map((tr) => [...tr.children].map((td) => td.textContent)),
        note: document.querySelector('[data-compare="bca-note"]')?.textContent ?? '',
      }));
      r.metrics.bca = out;
      for (const x of out.rows) console.log(`    ${x.join(' | ')}`);
      const row = (label) => out.rows.find((x) => x[0].startsWith(label)) ?? [];
      const ensRow = row('BCR · ensemble p10 / p50 / p90');
      const nums = (s) => (s ?? '').split(/ \/ | – /).map((x) => Number(x.replace('−', '-')));
      const [e10, e50, e90] = nums(ensRow[1]);
      const [lo, hi] = nums(row('BCR range')[1]);
      check(r, 'the comparison completes', done && /^Done/.test(out.status), out.status.slice(0, 110));
      check(
        r,
        'the BCR is shown at the ensemble’s p10 / p50 / p90, inside the overall range, and the note says what the ensemble is',
        /\(3 members\)/.test(ensRow[0] ?? '') && e10 <= e50 && e50 <= e90 && lo <= e10 && e90 <= hi && /the ensemble’s loss p10–p90/.test(out.note) && /ran on the scenario on screen, not on each design and level/.test(out.note),
        `ensemble ${ensRow[1] ?? '—'}; range ${row('BCR range')[1] ?? '—'}`,
      );
      await D(() => document.querySelector('[data-compare="bca"]')?.scrollIntoView({ block: 'start' }));
      await sleep(400);
      const shot = path.join(OUT, '45-bca-ensemble.png');
      await page.locator('.dl-panel').screenshot({ path: shot });
      console.log(`  [shot] ${path.relative(ROOT, shot)}`);

      // Leave the app as the other flows expect it.
      if (/remove levee/i.test((await page.locator('.dl-try-step[data-step="levee"]').textContent()) ?? '')) await page.click('.dl-try-step[data-step="levee"]');
      await calm();
    },
  },
  {
    id: 55,
    name: 'Checked against the real flood: the Scenario section’s validation block per scene, Nashville’s May 2010 line under its headline',
    timeoutMs: 240_000,
    async run(r) {
      const block = () =>
        D(() => {
          const el = document.querySelector('[data-validation="block"]');
          if (!el) return null;
          const more = el.querySelector('[data-validation="more"]');
          return {
            hidden: el.hidden,
            label: el.querySelector('.dl-validation-label')?.textContent ?? '',
            value: el.querySelector('.dl-validation-value')?.textContent ?? '',
            moreHidden: !more || more.hidden,
            more: more ? [...more.querySelectorAll('.dl-validation-item')].map((m) => m.textContent ?? '') : [],
          };
        });
      const show = async (id, want) => {
        await D((p) => window.__deluge.loadPreset(p), id);
        // The summary is fetched once and filled in asynchronously after the preset change.
        const deadline = Date.now() + 15_000;
        let b = await block();
        while (Date.now() < deadline && !(b && !b.hidden && b.label && want(b))) {
          await sleep(200);
          b = await block();
        }
        return b;
      };
      const nash = await show('nashville', (b) => b.more.length > 0);
      r.metrics.nashville = nash;
      check(r, 'nashville: the headline is the FEMA 1 % comparison', !!nash && !nash.hidden && /FEMA 1 %/.test(nash.label) && /CSI \d+ %/.test(nash.value), nash ? `${nash.label}: ${nash.value}` : 'no block');
      check(
        r,
        'nashville: a second line for the May 2010 flood, with its hit rate and false alarms',
        !!nash && !nash.moreHidden && nash.more.length === 1 && /2010/.test(nash.more[0]) && /reaches \d+ %/.test(nash.more[0]) && /\d+ % of the buildings it floods/.test(nash.more[0]) && !/NaN|undefined|null/.test(nash.more[0]),
        nash?.more[0]?.slice(0, 200) ?? 'none',
      );
      await D(() => document.querySelector('[data-validation="block"]')?.scrollIntoView({ block: 'center' }));
      await shot('55-validation-nashville');
      const fm = await show('ftmyers', (b) => /high-water/.test(b.label));
      check(r, 'ftmyers: the Ian marks, and no second line', !!fm && /high-water marks/.test(fm.label) && fm.moreHidden, fm ? `${fm.label}: ${fm.value} · more ${fm.more.length}` : 'no block');
      const ch = await show('chamoli', (b) => /Not checked/.test(b.label));
      check(r, 'chamoli: says there is nothing to compare against, and no second line', !!ch && /Not checked/.test(ch.label) && ch.moreHidden, ch ? ch.label : 'no block');
      await shot('55-validation-block');
    },
  },
  {
    id: 60,
    name: 'Business story “Should we build here?”: the demo parcels swept, verdict, egress, floor level, the pick; Esc puts the user’s sites back',
    timeoutMs: 600_000,
    resetsPage: true,
    async run(r, ctx) {
      // The user's own scene first: one site of theirs from a ?sites= link, a wall and a raised river. The story swaps the
      // demo parcels in, sweeps them, and must leave all of it as it was.
      await page.goto(new URL('?preset=pittsburgh&sites=v1:40.4405,-79.996~office~4~~~~~My%20own%20lot', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
      await D(() => {
        const d = window.__deluge;
        d.getSolver().applyBrush({ kind: 'wall', ax: 100, ay: 100, bx: 140, by: 100, radius: 2, height: 3 });
        d.setStageOffset(1.5);
      });
      const pre = await userScene();
      check(r, 'the user’s own scene: their site, a wall, the river raised', pre.sites.join() === 'My own lot' && pre.walls > 0 && pre.stage > 1, JSON.stringify(pre));
      const out = await playStory(r, 'site-decision', ['brief', 'sweep', 'a-verdict', 'a-egress', 'a-eal', 'a-floor', 'b-verdict', 'pick', 'limits'], { shots: ['a-verdict', 'pick'] });
      const cap = (id) => out.seen.get(id)?.caption ?? '';
      const during = out.seen.get('a-verdict');
      check(r, 'the demo parcels replace the user’s site while the story plays, and the sweep has run', during?.sites?.join(' | ') === 'Demo parcel A (North Shore) | Demo parcel B (Allegheny Center)' && /in \d+ s\./.test(during?.sweepStatus ?? ''), `${during?.sites?.join(' | ')} · ${during?.sweepStatus?.slice(0, 80)}`);
      check(r, 'Parcel A’s verdict is the panel’s own sentences, read live', /^Parcel A, in the panel’s own words: (Water reaches Demo parcel A \(North Shore\) at the .+ m at the lowest grade\.|Demo parcel A \(North Shore\) stays dry)/.test(cap('a-verdict')), cap('a-verdict').slice(0, 200));
      check(r, 'egress, EAL and the two floor levels are filled in from the sweep', /route|access|Egress/.test(cap('a-egress')) && /Expected annual loss|No expected annual loss/.test(cap('a-eal')) && /Designed to the FEMA 1 % level, the floor is .*(m above grade|m above the lowest grade).*Designed for the worst level that reaches it, the floor is \d/.test(cap('a-floor')), `${cap('a-egress').slice(0, 90)} | ${cap('a-eal').slice(0, 60)} | ${cap('a-floor').slice(0, 160)}`);
      check(r, 'the pick: B is dry where A is not', /B is dry at the 1936 record crest \(46\.0 ft\); A takes \d+\.\d m at the lowest grade/.test(cap('pick')), cap('pick').slice(0, 220));
      await D(() => document.getElementById('ui-root').__delugeUI.story.stop());
      await sleep(600);
      const post = await userScene();
      check(r, 'Esc / close: the user’s site, wall, river and view are back', JSON.stringify({ ...post, walls: 0 }) === JSON.stringify({ ...pre, walls: 0 }) && Math.abs(post.walls - pre.walls) <= 2, `before ${JSON.stringify(pre)} · after ${JSON.stringify(post)}`);
      // Esc in the middle of the sweep: the sweep is cancelled, and the user's state comes back once it has stopped.
      await D(() => document.getElementById('ui-root').__delugeUI.story.play('site-decision', { pace: 0.05, maxWaitCapMs: 30_000 }));
      const inSweep = await page
        .waitForFunction(() => /Level \d+ of \d+/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 60_000 })
        .then(() => true, () => false);
      await page.keyboard.press('Escape');
      const stopped = await page
        .waitForFunction(() => /^(Cancelled|Done|Sweep stopped)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 120_000 })
        .then(() => true, () => false);
      await sleep(800);
      const mid = await userScene();
      const status = await D(() => document.querySelector('[data-site="sweep-status"]')?.textContent ?? '');
      check(r, 'Esc mid-sweep cancels it and still puts the user’s site, wall, river and view back', inSweep && stopped && /^Cancelled/.test(status) && JSON.stringify({ ...mid, walls: 0 }) === JSON.stringify({ ...pre, walls: 0 }) && Math.abs(mid.walls - pre.walls) <= 2, `${status.slice(0, 60)} · after ${JSON.stringify(mid)}`);
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
    },
  },
  {
    id: 61,
    name: 'Business story “Is the levee worth it?”: the levee compared headless, BCR with its range, break-even; Esc puts the user’s designs and walls back',
    timeoutMs: 600_000,
    resetsPage: true,
    async run(r, ctx) {
      await page.goto(new URL('?preset=pittsburgh', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
      // The user's own design work: a short wall of theirs, captured as their Design A, and the river raised a little.
      await D(() => {
        const d = window.__deluge;
        d.getSolver().applyBrush({ kind: 'wall', ax: 100, ay: 100, bx: 140, by: 100, radius: 2, height: 3 });
        d.setStageOffset(1.5);
        const sec = document.querySelector('[data-section="designs"]');
        if (sec && !sec.classList.contains('dl-open')) sec.querySelector('.dl-sec-head')?.click();
      });
      await page.click('[data-compare="capture"]');
      const userDesign = () => D(() => document.querySelector('[data-design-id="A"]')?.textContent ?? '');
      const mine = await userDesign();
      const pre = await userScene();
      check(r, 'the user’s own scene: their wall captured as Design A, the river raised', pre.designs === 'A' && pre.walls > 0 && pre.stage > 1, `${JSON.stringify(pre)} · ${mine.slice(0, 60)}`);
      const out = await playStory(r, 'levee-bca', ['question', 'build', 'compare', 'benefit', 'bcr', 'breakeven', 'limits'], { shots: ['bcr'] });
      const cap = (id) => out.seen.get(id)?.caption ?? '';
      const during = out.seen.get('bcr');
      check(r, 'the comparison ran the wall as the only design, against the baseline', during?.designs === 'A' && /^Done: baseline \+ 1 design × 2 levels/.test(during?.compareStatus ?? ''), `${during?.designs} · ${during?.compareStatus?.slice(0, 90)}`);
      check(r, 'avoided EAL and cost come from the comparison', /avoids \$[\d.]+\s?[kMB]? a year \(\$.+\) in expected annual loss/.test(cap('benefit')) && /unit rates: \$[\d.]+\s?[kMB]? \(unit-cost estimate/.test(cap('benefit')), cap('benefit').slice(0, 220));
      check(r, 'the BCR is never alone: central, range and verdict, at 7 % over 50 years', /At 7 % over 50 yr \(FEMA standard\), the BCR is \d+\.\d\d, with a range of \d+\.\d\d( – \d+\.\d\d)?\. The panel’s verdict: (Pays|Uncertain|Does not pay|Makes)/.test(cap('bcr')), cap('bcr').slice(0, 220));
      check(r, 'break-even cost against the estimate', /still pay at the central estimate: \$[\d.]+\s?[kMB]?, against an estimate of \$/.test(cap('breakeven')), cap('breakeven').slice(0, 160));
      await D(() => document.getElementById('ui-root').__delugeUI.story.stop());
      await sleep(600);
      const post = await userScene();
      const theirs = await userDesign();
      check(r, 'the story’s design was the levee, not the user’s wall', during?.designText !== mine && /2\.\d+ km/.test(during?.designText ?? ''), `${(during?.designText ?? '').slice(0, 60)} vs ${mine.slice(0, 60)}`);
      check(r, 'Esc / close: the user’s own Design A, walls, river and view are back', theirs === mine && JSON.stringify({ ...post, walls: 0 }) === JSON.stringify({ ...pre, walls: 0 }) && Math.abs(post.walls - pre.walls) <= 2, `before ${JSON.stringify(pre)} · after ${JSON.stringify(post)}`);
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
    },
  },
  {
    id: 62,
    name: 'Business story “A dam upstream”: ?story= link breaches Edenville on its valley, band, wave, arrivals, the county (fixtures)',
    timeoutMs: 600_000,
    resetsPage: true,
    async run(r, ctx) {
      // Hermetic, as flow 26: USGS 3DEP answered by the synthetic valley below Edenville Dam's NID point.
      const intercepted = [];
      await page.route((u) => !isLocalUrl(u.href), (route) => damFixtures(route, intercepted, EDENVILLE));
      try {
        await page.goto(new URL('?story=dam-upstream', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
        const started = await page
          .waitForFunction(() => document.querySelector('.dl-nar[data-story="dam-upstream"]:not([hidden])') && window.__deluge.getScenario()?.damBreach?.nidId === 'MI00549', null, { timeout: 240_000 })
          .then(() => true, () => false);
        const s0 = await D(() => ({ preset: window.__deluge.getState().presetId, mode: window.__deluge.getScenario()?.damBreach?.mode ?? null, url: location.search }));
        check(r, '?story=dam-upstream loads the valley below Edenville Dam, breaches it flood-induced and starts the story', started && s0.preset === null && s0.mode === 'flood' && /story=dam-upstream/.test(s0.url), JSON.stringify(s0));
        await D(() => document.getElementById('ui-root').__delugeUI.story.stop());
        await sleep(300);
        // The whole story at 1/20 pace, on the area already loaded (the player keeps it rather than loading it again).
        const out = await playStory(r, 'dam-upstream', ['dam', 'band', 'wave', 'arrivals', 'county', 'limits'], { shots: ['arrivals'], pace: 0.2 });
        const cap = (id) => out.seen.get(id)?.caption ?? '';
        check(r, 'the dam’s NID numbers and the band of eight relations are read live', /^Edenville Dam \(NID MI00549\) held [\d,]+ acre-ft/.test(cap('dam')) && /peak outflow at [\d,]+ m³\/s – [\d,]+ m³\/s for this dam\. The map runs the central case, [\d,]+ m³\/s \(Froehlich 1995/.test(cap('band')), `${cap('dam').slice(0, 90)} | ${cap('band').slice(0, 200)}`);
        check(r, 'arrival times downstream, each with its spread across the band', /at 1 km in (\d+ min|[\d.]+ h) \(.+ across the band\)/.test(cap('arrivals')) && !/\{/.test(cap('arrivals')), cap('arrivals').slice(0, 260));
        check(r, 'what to tell the county is filled in', /For the county: water at 2 km in (\d+ min|[\d.]+ h|not yet)/.test(cap('county')), cap('county').slice(0, 200));
        const loads = await D(() => window.__deluge.getState().terrainName);
        await page.keyboard.press('Escape');
        await sleep(300);
        const after = await D(() => ({ visible: !!document.querySelector('.dl-nar:not([hidden])'), terrain: window.__deluge.getState().terrainName, breach: window.__deluge.getScenario()?.damBreach?.nidId ?? null, url: location.search }));
        check(r, 'Esc leaves the story on the dam’s valley (the scene it loaded), ?story= dropped', !after.visible && after.terrain === loads && after.breach === 'MI00549' && !/story=/.test(after.url), JSON.stringify(after));
        r.metrics.intercepted = intercepted.slice(0, 12);
      } finally {
        await page.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
        await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
        await waitReady(120_000);
      }
    },
  },
];

/** Flows 60–62: the user's own state the business stories must put back (sites, designs, walls, river, view). */
async function userScene() {
  return D(() => {
    const d = window.__deluge;
    const s = d.getState();
    return {
      sites: [...document.querySelectorAll('.dl-site-item .dl-impact-name')].map((e) => e.textContent),
      designs: [...document.querySelectorAll('[data-design-id]')].map((e) => e.getAttribute('data-design-id')).join(),
      stage: s.stageOffset,
      rain: s.sim.rainRate,
      timeScale: s.sim.timeScale,
      view: s.render.waterMode,
      walls: d.getSolver()?.getBarrierCPU().reduce((n, v) => n + (v > 0.2 ? 1 : 0), 0) ?? -1,
    };
  });
}

/**
 * Flows 60–62: play a story from the debug handle at 1/20 of its reading time (or `pace`; waits capped at 30 s), sampling the
 * card and the panels on every beat; checks that every beat played in order, the story finished and no caption kept a
 * raw {token}.
 */
async function playStory(r, id, order, { shots = [], pace = 0.05 } = {}) {
  const sample = () =>
    D(() => {
      const ui = document.getElementById('ui-root')?.__delugeUI;
      return {
        ...(ui?.story?.debugState() ?? {}),
        dataState: document.querySelector('.dl-nar')?.getAttribute('data-state') ?? null,
        sites: [...document.querySelectorAll('.dl-site-item .dl-impact-name')].map((e) => e.textContent),
        sweepStatus: [...document.querySelectorAll('.dl-impact-status')].map((e) => e.textContent).find((t) => /^Done: \d+ level/.test(t ?? '')) ?? '',
        designs: [...document.querySelectorAll('[data-design-id]')].map((e) => e.getAttribute('data-design-id')).join(),
        designText: document.querySelector('[data-design-id="A"]')?.textContent ?? '',
        compareStatus: document.querySelector('[data-compare="status"]')?.textContent ?? '',
      };
    });
  const ok = await D(([sid, p]) => document.getElementById('ui-root').__delugeUI.story.play(sid, { pace: p, maxWaitCapMs: 30_000 }), [id, pace]);
  check(r, `${id} plays from the debug handle`, ok === true, String(ok));
  const seen = new Map();
  const t0 = Date.now();
  let last = null;
  let prev = null;
  const logBeat = (b) => b && console.log(`  · ${b.at.toFixed(1)} s beat ${b.beatId}: ${b.caption.slice(0, 120)}`);
  while (Date.now() - t0 < 420_000) {
    last = await sample();
    // Each beat keeps its latest sample while it is on screen (a sweep or a comparison runs inside a beat's actions,
    // and the live tokens refresh), so what is recorded is what the viewer last read.
    if (last.beatId && !last.finished) {
      const first = !seen.has(last.beatId);
      seen.set(last.beatId, { ...last, at: first ? (Date.now() - t0) / 1000 : seen.get(last.beatId).at });
      if (first) {
        logBeat(prev && seen.get(prev));
        prev = last.beatId;
        if (shots.includes(last.beatId)) await shot(`${r.id}-story-${last.beatId}`);
      }
    }
    if (last.finished) break;
    await sleep(120);
  }
  logBeat(prev && seen.get(prev));
  const played = [...seen.keys()];
  r.metrics.storyBeats = [...seen.values()].map((b) => ({ beat: b.beatId, at: b.at, timedOut: b.timedOut, caption: b.caption }));
  check(r, 'every beat played, in order, and the story finished', !!last?.finished && played.join() === order.join() && last.dataState === 'finished', `${played.join(' → ')} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const captions = [...seen.values()].map((b) => b.caption);
  check(r, 'captions resolved: no raw {token} left on screen', captions.every((t) => t && !/\{[a-z]+(:[^}]*)?\}/.test(t)), captions.map((t) => t.slice(0, 40)).join(' | '));
  return { seen, last };
}


// ─── Dam breach and coastal surge helpers (flows 23–26) ─────────────────────────────────────────────────────────

/** Edenville Dam, Michigan (NID MI00549) — failed 19 May 2020. The NID point, as baked (1e-5°). */
const EDENVILLE = { nid: 'MI00549', lat: 43.81667, lon: -84.38833 };
/** Downtown Fort Myers on the Caloosahatchee (near NOAA 8725520). */
const FTM_POINT = { lat: 26.6406, lon: -81.8723 };
const R_EARTH = 6378137;
const mercOf = (lat, lon) => ({ x: (R_EARTH * lon * Math.PI) / 180, y: R_EARTH * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) });

/** A 3DEP exportImage answered from `ground(dn, de)` — metres north and east of `at` on the ground. */
function demFixture(route, intercepted, at, ground) {
  const url = route.request().url();
  intercepted.push(url.slice(0, 120));
  const u = new URL(url);
  if (u.hostname === 'elevation.nationalmap.gov' && u.pathname.endsWith('/exportImage')) {
    const [w, h] = (u.searchParams.get('size') ?? '64,64').split(',').map(Number);
    const [xmin, ymin, xmax, ymax] = (u.searchParams.get('bbox') ?? '0,0,1,1').split(',').map(Number);
    const c = mercOf(at.lat, at.lon);
    const k = Math.cos((at.lat * Math.PI) / 180);
    const tiff = float32Tiff(w, h, (fx, fy) => ground((ymax - fy * (ymax - ymin) - c.y) * k, (xmin + fx * (xmax - xmin) - c.x) * k));
    return route.fulfill({ status: 200, headers: { 'content-type': 'image/tiff', 'access-control-allow-origin': '*' }, body: tiff });
  }
  if (u.hostname === 'elevation.nationalmap.gov') {
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '{}' });
  }
  return route.abort('internetdisconnected');
}

/** A valley falling south from the dam: 222 m crest across it, a 215 m reservoir north of it, 190 m at its toe. */
function damFixtures(route, intercepted, dam) {
  return demFixture(route, intercepted, dam, (dn, de) => {
    const walls = 0.04 * Math.max(0, Math.abs(de) - 300);
    if (dn > 60) return Math.max(215, 205 + walls);
    if (dn >= -60) return 222 + 0.01 * Math.abs(de);
    return 190 + 0.004 * dn + walls;
  });
}

/** A coast: open water from 500 m west of the point, land rising east at 0.8 m/km (0.7 m NAVD88 at the point). */
function surgeFixtures(route, intercepted, at) {
  return demFixture(route, intercepted, at, (_dn, de) => (de < -500 ? 0 : 0.3 + 0.0008 * (de + 500)));
}

async function openUseCase(id) {
  await page.click('.dl-uc-btn');
  await page.waitForSelector('[data-modal="usecases"].dl-open');
  // The dialog reopens on the view it was left on: back to the cards first.
  const card = `[data-modal="usecases"].dl-open [data-usecase="${id}"]`;
  if (!(await page.isVisible(card))) await page.click('[data-uc="toggle"]');
  await page.waitForSelector(card);
  await page.click(card);
}

/** Flows 23 / 25: search the NID, breach Edenville flood-induced, run the wave, read the arrivals, reopen the link. */
async function damFlow(r, ctx, { tag, fixtures, simMinutes = 30 }) {
  await page.goto(new URL('?preset=pittsburgh', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
  await waitReady(120_000);
  await openUseCase('dam');
  await page.fill('[data-dam="input"]', 'Edenville');
  await page.click('[data-dam="search"]');
  const found = await page.waitForSelector(`[data-dam="result"][data-nid="${EDENVILLE.nid}"]`, { timeout: 30_000 }).then(() => true, () => false);
  check(r, 'the NID index finds Edenville Dam (MI00549) by name', found, found ? 'found' : 'not found');
  if (!found) return;
  await page.click(`[data-dam="result"][data-nid="${EDENVILLE.nid}"]`);
  await page.click('[data-dam="dam-mode-flood"]');
  const card = await D(() => ({
    params: document.querySelector('[data-dam="params"]')?.textContent ?? '',
    relations: [...document.querySelectorAll('[data-dam="relations"] tr[data-relation]')].map((tr) => tr.getAttribute('data-relation')),
    methods: [...document.querySelectorAll('input[name="dam-method"]')].map((i) => `${i.value}${i.checked ? '*' : ''}`),
  }));
  const params = card.params;
  check(
    r,
    'the breach card shows Froehlich 2008 width and time, the peak sent to the map, the low–high range of eight relations (central Froehlich 1995) and the four hydrographs',
    /Froehlich 2008/.test(params) && /Peak range, 8 published relations/.test(params) && /central [\d,]+ m³\/s, Froehlich 1995 peak/.test(params) && /River flood under it/.test(params) && card.relations.length === 8 && card.relations.includes('macdonald1984') && card.relations.includes('xuZhang2009') && card.methods.join() === 'central*,low,high,parametric',
    `${params.slice(0, 200)} · ${card.relations.join(',')} · ${card.methods.join(',')}`,
  );
  await shot(`${tag}-dam-card`);
  const t0 = Date.now();
  await page.click('[data-dam="breach"]');
  const ok = await page
    .waitForFunction((nid) => window.__deluge?.getScenario()?.damBreach?.nidId === nid && !window.__deluge.getState().loading, EDENVILLE.nid, { timeout: fixtures ? 180_000 : 400_000 })
    .then(() => true, () => false);
  r.metrics.loadSeconds = (Date.now() - t0) / 1000;
  const s = await D(() => {
    const d = window.__deluge;
    const sc = d.getScenario();
    const g = d.getState().grid;
    const c = g ? d.gridToGeo(g.nx / 2, g.ny / 2) : null;
    const src = sc?.sources.find((x) => x.id === 'dam-breach') ?? null;
    return {
      spec: sc?.damBreach ? { mode: sc.damBreach.mode, method: sc.damBreach.method, band: sc.damBreach.band, peak: sc.damBreach.peak, tPeak: sc.damBreach.tPeak, volume: sc.damBreach.volume, dam: sc.damBreach.dam, inflow: sc.damBreach.inflow, pathKm: sc.damBreach.path.at(-1)?.s / 1000 } : null,
      src: src ? { gx: src.gx, gy: src.gy, points: src.hydrograph?.length ?? 0, discharge: src.discharge } : null,
      centreLat: c ? c.lat : NaN,
      size: g ? g.nx * g.cellSize : 0,
      mode: d.getState().render.waterMode,
      url: location.search,
    };
  });
  r.metrics.dam = s;
  check(r, 'the valley below the dam loads, with the breach inflow at its toe', ok && !!s.spec && !!s.src && s.src.points > 50 && Math.abs(s.size - 12000) < 1, ok ? `peak ${Math.round(s.spec?.peak ?? 0)} m³/s at ${Math.round((s.spec?.tPeak ?? 0) / 60)} min, ${((s.spec?.volume ?? 0) / 1e6).toFixed(1)} Mm³, path ${s.spec?.pathKm?.toFixed(1)} km, load ${r.metrics.loadSeconds.toFixed(1)} s` : 'not set up');
  if (!ok || !s.spec) return;
  if (fixtures) {
    check(r, 'the area is centred downstream (south) of the dam, the inflow below it', s.centreLat < EDENVILLE.lat - 0.02 && s.spec.inflow.gy > s.spec.dam.gy, `centre ${s.centreLat.toFixed(4)} vs dam ${EDENVILLE.lat}; inflow gy ${s.spec.inflow.gy.toFixed(0)} vs dam ${s.spec.dam.gy.toFixed(0)}`);
  }
  check(r, 'the link carries the NID id and the scenario, never the dam’s name; the Arrival view is on', s.spec.method === 'central' && !/method=/.test(s.url) && /usecase=dam/.test(s.url) && /nid=MI00549/.test(s.url) && /breach=flood/.test(s.url) && !/Edenville[+ ]Dam/i.test(decodeURIComponent(s.url)) && s.mode === 'arrival', `${s.url} · ${s.mode}`);
  const v0 = (await stats())?.volume ?? 0;
  const wall = await runFor(simMinutes * 60);
  await D(() => window.__deluge.waitFrames(30));
  const v1 = (await stats())?.volume ?? 0;
  r.metrics.runSeconds = wall;
  check(r, `the breach wave enters the map (${simMinutes} simulated min)`, v1 > v0 + 1e5, `volume ${m3(v0)} → ${m3(v1)} in ${num(wall, 1)} s`);
  await shot(`${tag}-dam-arrival`);
  await openUseCase('dam');
  await page.click('[data-dam="read"]');
  const rows = await page
    .waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-dam="arrivals"] tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? ''));
      return rows.length ? rows : null;
    }, null, { timeout: 30_000 })
    .then((h) => h.jsonValue(), () => []);
  r.metrics.arrivals = rows;
  const arrived = rows.filter((row) => /min|h$/.test(row[1]));
  const mins = arrived.map((row) => (/h$/.test(row[1]) ? 60 * parseFloat(row[1]) : parseFloat(row[1])));
  const depths = rows.map((row) => parseFloat(row[3]));
  check(r, 'the downstream readout gives arrival times that grow with distance, and peak depths', rows.length >= 3 && arrived.length >= 2 && mins.every((m, i) => i === 0 || m >= mins[i - 1] - 1) && depths[0] > 0.3, rows.map((row) => `${row[0]}: ${row[1]} (${row[2]}), ${row[3]}`).join(' · '));
  const note = await D(() => document.querySelector('[data-dam="arrival-note"]')?.textContent ?? '');
  check(r, 'each arrival comes with its spread at the band’s high and low peaks, labelled as not simulated', arrived.every((row) => /\d.*–.*\d/.test(row[2])) && /Not simulated/.test(note) && /peak\^−0\.4/.test(note), `${arrived.map((row) => row[2]).join(' · ')} · ${note.slice(0, 120)}`);
  await sleep(300);
  await shot(`${tag}-dam-readout`);
  await page.keyboard.press('Escape');
  if (!fixtures) return;
  // The link, reloaded: the same breach on the same area.
  const link = s.url;
  await page.goto(new URL(link, ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
  await waitReady(120_000);
  const again = await page
    .waitForFunction((nid) => window.__deluge?.getScenario()?.damBreach?.nidId === nid && !window.__deluge.getState().loading, EDENVILLE.nid, { timeout: 180_000 })
    .then(() => true, () => false);
  const peak2 = await D(() => window.__deluge.getScenario()?.damBreach?.peak ?? 0);
  check(r, 'link: reopening it breaches the same dam the same way', again && Math.abs(peak2 - s.spec.peak) < 1e-6 * s.spec.peak, `${again ? 'set up' : 'not set up'}, peak ${Math.round(peak2)} m³/s`);
}

/** Flows 24 / 26: a coastal point → the surge scenario → the EWL sweep → EAL → the report → the link. */
async function surgeFlow(r, ctx, { tag, fixtures, minutes, point = FTM_POINT, ffh }) {
  await page.goto(new URL('?preset=pittsburgh', ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
  await waitReady(120_000);
  await openUseCase('surge');
  await page.fill('[data-surge="input"]', `${point.lat}, ${point.lon}`);
  await page.click('[data-surge="search"]');
  await page.waitForSelector('[data-surge="choice"]', { timeout: 15_000 });
  const t0 = Date.now();
  await page.click('[data-surge="choice"]');
  const ready = await page
    .waitForFunction(
      () => {
        const s = window.__deluge?.getState();
        return !!s && !s.loading && !!s.scenario?.coastal && document.querySelector('[data-site="ladder"]')?.value === 'stage' && document.querySelectorAll('.dl-site-ladder input[data-level^="ewl-"]').length === 5 && document.querySelectorAll('.dl-site-item').length >= 1;
      },
      null,
      { timeout: fixtures ? 180_000 : 400_000 },
    )
    .then(() => true, () => false);
  r.metrics.loadSeconds = (Date.now() - t0) / 1000;
  const s = await D(() => {
    const sc = window.__deluge.getScenario();
    return {
      coastal: sc?.coastal ? { station: sc.coastal.stationName, km: sc.coastal.stationKm, datum: sc.coastal.datum, mhhw: sc.coastal.mhhw, runs: sc.coastal.seaRuns, l100: sc.coastal.levels.at(-1)?.elevation } : null,
      sea: sc?.sources.filter((x) => x.type === 'stage').map((x) => ({ id: x.id, gx: Math.round(x.gx), gy: Math.round(x.gy), r: Math.round(x.radius) })) ?? [],
      stage: sc?.stage?.label ?? '',
      levels: [...document.querySelectorAll('.dl-site-ladder tbody tr')].map((tr) => [...tr.querySelectorAll('.dl-impact-meta')].map((m) => m.textContent ?? '').join(' ')),
      url: location.search,
    };
  });
  r.metrics.surge = s;
  check(r, 'an 8 km coastal area loads with the sea boundary on its seaward edges at the nearest NOAA gauge', ready && !!s.coastal && (!fixtures || s.coastal.station === 'Fort Myers') && s.sea.length >= 1 && s.sea.every((x) => x.id.startsWith('sea-')), ready ? `${s.coastal?.station} ${s.coastal?.km} km, MHHW ${s.coastal?.mhhw} m ${s.coastal?.datum}, 1 % ${s.coastal?.l100} m; ${s.sea.length} sea source(s) ${JSON.stringify(s.sea).slice(0, 80)}; load ${r.metrics.loadSeconds.toFixed(1)} s` : 'not set up');
  if (!ready) return;
  if (fixtures) check(r, 'the sea boundary is on the west (open-water) side only', s.sea.every((x) => x.gx < 400 || x.gy < 0 || x.gy > 1024), JSON.stringify(s.sea));
  const rps = s.levels.map((t) => (/([\d.]+) yr · source/.exec(t) ?? [])[1]);
  check(r, 'Site check offers the NOAA 1- to 100-yr ladder with sourced return periods', rps.join() === '1.01,2,10,50,100' || rps.join() === '1,2,10,50,100', `${rps.join(', ')} yr`);
  check(r, 'the link carries the coordinates only', /usecase=surge/.test(s.url) && s.url.includes(`at=${point.lat.toFixed(5)},${point.lon.toFixed(5)}`), s.url);
  if (ffh !== undefined && (await page.isVisible('[data-site-field="ffh"]'))) {
    // A slab-on-grade building (ground-floor retail): the first floor at grade.
    await page.fill('[data-site-field="ffh"]', String(ffh));
    await page.dispatchEvent('[data-site-field="ffh"]', 'change');
    r.notes.push(`first floor ${ffh} m above grade`);
  }
  await page.fill('[data-site-field="duration"]', String(minutes));
  await page.dispatchEvent('[data-site-field="duration"]', 'change');
  const before = await D(() => {
    const st = window.__deluge.getState();
    return { rain: st.sim.rainRate, stageOffset: st.stageOffset, sources: st.sources.length };
  });
  await shot(`${tag}-surge-site`);
  const ts = Date.now();
  await page.click('[data-site="run-sweep"]');
  const done = await page
    .waitForFunction(() => /^(Done|Sweep stopped|Cancelled)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 1_200_000 })
    .then(() => true, () => false);
  const sweepS = (Date.now() - ts) / 1000;
  const out = await D(() => ({
    status: document.querySelector('[data-site="sweep-status"]')?.textContent ?? '',
    verdict: [...document.querySelectorAll('[data-site="verdict"] p')].map((p) => p.textContent ?? ''),
    rows: [...document.querySelectorAll('.dl-site-sweep-out .dl-site-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')),
    caveats: !!document.querySelector('[data-site="surge-caveats"]'),
    gauge: document.querySelector('[data-site="surge-gauge"]')?.textContent ?? '',
    after: (() => {
      const st = window.__deluge.getState();
      return { rain: st.sim.rainRate, stageOffset: st.stageOffset, sources: st.sources.length };
    })(),
  }));
  const eal = out.verdict.find((v) => /Expected annual loss/.test(v)) ?? '';
  r.metrics.sweepSeconds = sweepS;
  r.metrics.sweepRows = out.rows;
  r.metrics.verdict = out.verdict;
  check(r, 'the five-level surge sweep completes', done && /^Done: 5 levels/.test(out.status), `${out.status.slice(0, 80)} (${num(sweepS, 1)} s wall)`);
  check(r, 'EAL comes from NOAA’s return periods (no “needs your input”), and the low site has one', /Expected annual loss \$/.test(eal) && (!fixtures || !/Expected annual loss \$0\b/.test(eal)) && !/your input|No expected annual loss/.test(out.verdict.join(' ')), eal.slice(0, 160));
  check(r, 'the surge ladder’s caveats are shown with the result', out.caveats, String(out.caveats));
  check(r, 'the result names the gauge and its distance, flagging a gauge off the map as possibly in another bay', /NOAA gauge .* km from the map centre: (on this map|off this map, so possibly in another bay)/.test(out.gauge) && (!fixtures || /on this map/.test(out.gauge)), out.gauge);
  check(r, 'the user’s scenario is put back', JSON.stringify(out.after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(out.after)}`);
  await D(() => document.querySelector('[data-site="verdict"]')?.scrollIntoView({ block: 'start' }));
  await sleep(400);
  const panelShot = path.join(OUT, `${tag}-surge-sweep.png`);
  await page.locator('.dl-panel').screenshot({ path: panelShot });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-site="report-html"]')]);
  const file = path.join(OUT, `${tag}-surge-assessment.html`);
  await dl.saveAs(file);
  const html = fs.readFileSync(file, 'utf8');
  const has = ['NOAA CO-OPS Extreme Water Levels', 'Surge ladder caveats', 'Expected annual loss', 'tidesandcurrents.noaa.gov'];
  const missing = has.filter((x) => !html.includes(x));
  check(r, 'the site assessment cites NOAA’s extreme water levels and carries the caveats', missing.length === 0 && !/<script/i.test(html), missing.length ? `missing: ${missing.join(', ')}` : `${(html.length / 1024).toFixed(0)} KB`);
  // Today vs 2050 SSP5-8.5: the same ladder with NOAA's Intermediate sea-level rise at the gauge on top.
  await D(() => window.__deluge.store.set({ climate: { horizon: '2050', pathway: 'ssp585', scaling: 'cc' } }));
  await sleep(300);
  const enabled = await D(() => document.querySelector('[data-site="run-climate-sweep"]')?.disabled === false);
  check(r, '“Today vs future” is offered on the surge ladder under 2050 SSP5-8.5', enabled, String(enabled));
  if (enabled) {
    await page.click('[data-site="run-climate-sweep"]');
    const cdone = await page
      .waitForFunction(() => /^(Done: .* under|Sweep stopped|Cancelled)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 1_800_000 })
      .then(() => true, () => false);
    const cmp = await D(() => ({ eal: document.querySelector('[data-site="climate-eal"]')?.textContent ?? '', block: document.querySelector('[data-site="climate-compare"]')?.textContent ?? '' }));
    r.metrics.climate = cmp.eal;
    check(r, 'today vs 2050: the sea is raised by NOAA’s 0.32 m at the gauge and the EAL is compared', cdone && /0\.32 m/.test(cmp.block) && /EAL/.test(cmp.eal), cmp.eal.slice(0, 200));
  }
  await D(() => window.__deluge.store.set({ climate: { horizon: 'today', pathway: 'ssp585', scaling: 'cc' } }));
  if (!fixtures) return;
  await page.goto(new URL(`?usecase=surge&at=${point.lat},${point.lon}`, ctx.baseUrl).href, { waitUntil: 'domcontentloaded' });
  await waitReady(120_000);
  const again = await page
    .waitForFunction(() => window.__deluge?.getScenario()?.coastal?.stationId === '8725520' && document.querySelector('[data-site="ladder"]')?.value === 'stage', null, { timeout: 180_000 })
    .then(() => true, () => false);
  check(r, 'link: ?usecase=surge&at= reopens the surge set-up', again, String(again));
}

// ─── "Check any US address" helpers (flows 21 and 22) ────────────────────────────────────────────

/** A minimal little-endian, uncompressed, single-strip float32 TIFF — what the 3DEP exportImage call returns. */
function float32Tiff(w, h, valueAt) {
  const entries = [
    [256, 4, 1, w], // ImageWidth
    [257, 4, 1, h], // ImageLength
    [258, 3, 1, 32], // BitsPerSample
    [259, 3, 1, 1], // Compression: none
    [262, 3, 1, 1], // Photometric: min-is-black
    [273, 4, 1, 0], // StripOffsets (patched below)
    [277, 3, 1, 1], // SamplesPerPixel
    [278, 4, 1, h], // RowsPerStrip
    [279, 4, 1, w * h * 4], // StripByteCounts
    [284, 3, 1, 1], // PlanarConfiguration
    [339, 3, 1, 3], // SampleFormat: IEEE float
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataOff = 8 + ifdSize + ((4 - ((8 + ifdSize) % 4)) % 4);
  entries[5][3] = dataOff;
  const buf = Buffer.alloc(dataOff + w * h * 4);
  buf.write('II', 0, 'latin1');
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const o = 10 + i * 12;
    buf.writeUInt16LE(tag, o);
    buf.writeUInt16LE(type, o + 2);
    buf.writeUInt32LE(count, o + 4);
    if (type === 3) buf.writeUInt16LE(value, o + 8);
    else buf.writeUInt32LE(value, o + 8);
  });
  buf.writeUInt32LE(0, 10 + entries.length * 12);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) buf.writeFloatLE(valueAt(i / (w - 1), j / (h - 1)), dataOff + (j * w + i) * 4);
  return buf;
}

/**
 * Fixtures for the hermetic address flow: Nominatim search → one Houston result; 3DEP exportImage → a 5 km bowl
 * (20 m at the rim, 12 m at the centre, with a gentle west–east tilt) so rain runs to the address and ponds; the
 * 3DEP reachability probe → 200. Everything else (imagery, roads, reverse geocoding) is refused: the loader then goes
 * on without them, as it does on a bad connection.
 */
function addressFixtures(route, intercepted) {
  const url = route.request().url();
  intercepted.push(url.slice(0, 120));
  const u = new URL(url);
  if (u.hostname === 'nominatim.openstreetmap.org' && u.pathname === '/search') {
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: JSON.stringify([{ place_id: 1, display_name: '1600, Smith Street, Downtown, Houston, Harris County, Texas, 77002, United States', lat: '29.7604', lon: '-95.3698', class: 'place', type: 'house' }]),
    });
  }
  if (u.hostname === 'elevation.nationalmap.gov' && u.pathname.endsWith('/exportImage')) {
    const [w, h] = (u.searchParams.get('size') ?? '1024,1024').split(',').map(Number);
    const tiff = float32Tiff(w, h, (x, y) => {
      const r2 = ((x - 0.5) ** 2 + (y - 0.5) ** 2) * 4; // 0 at the centre, 1 at the edge midpoints
      return 12 + 8 * Math.min(1.5, r2) + 0.5 * x;
    });
    return route.fulfill({ status: 200, headers: { 'content-type': 'image/tiff', 'access-control-allow-origin': '*' }, body: tiff });
  }
  if (u.hostname === 'elevation.nationalmap.gov') {
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: '{}' });
  }
  return route.abort('internetdisconnected');
}

/** Wait for the address case to be set up: live area on the point, one site there, Site check on the rain ladder. */
async function addressSetUp(r, at, timeoutMs, label = 'search') {
  const ready = await page
    .waitForFunction(
      (p) => {
        const s = window.__deluge?.getState();
        const sel = document.querySelector('[data-site="ladder"]');
        return !!s && s.presetId === null && !!s.terrainName && !s.loading && document.querySelectorAll('.dl-site-item').length >= 1 && sel?.value === 'rain' && document.querySelectorAll('.dl-site-ladder input[data-level^="a14-"]').length === 5;
      },
      at,
      { timeout: timeoutMs },
    )
    .then(() => true, () => false);
  const out = await D(() => {
    const s = window.__deluge.getState();
    const t = window.__deluge.getTerrain?.() ?? null;
    return {
      name: s.terrainName,
      grid: s.grid,
      bounds: t?.bounds ?? null,
      url: location.search,
      sites: document.querySelectorAll('.dl-site-item').length,
      ladder: document.querySelector('[data-site="ladder"]')?.value ?? '',
      siteOpen: document.querySelector('[data-section="site"]')?.classList.contains('dl-open') ?? false,
      levels: [...document.querySelectorAll('.dl-site-ladder tbody tr')].map((tr) => tr.textContent ?? ''),
      ticked: [...document.querySelectorAll('.dl-site-ladder input[data-level^="a14-"]')].filter((b) => b.checked).length,
      intro: document.querySelector('[data-section="site"] .dl-impact-block .dl-impact-fine')?.textContent ?? '',
      notice: document.querySelector('.dl-notice.dl-show')?.textContent ?? '',
    };
  });
  out.ok = ready;
  if (label === 'link') return out;
  check(r, 'a 5 km live area loads on the address, with one site on the point and Site check open', ready && out.sites >= 1 && out.siteOpen && Math.abs((out.grid?.nx ?? 0) * (out.grid?.cellSize ?? 0) - 5000) < 1, `“${out.name}” ${out.grid?.nx}² @ ${num(out.grid?.cellSize)} m, ${out.sites} site(s)`);
  const rain = out.levels.map((t) => (/(\d+(?:\.\d+)?) mm\/h/.exec(t) ?? [])[1]).map(Number);
  const rps = out.levels.map((t) => (/([\d.]+) yr · source/.exec(t) ?? [])[1]);
  out.levels = out.levels.map((t, i) => ({ text: t.slice(0, 80), mmPerHour: rain[i], rp: rps[i] }));
  check(r, 'the NOAA Atlas 14 rain ladder is pre-ticked: 2 to 500-yr, rising, with sourced return periods', out.ticked === 5 && rain.every((v, i) => v > 0 && (i === 0 || v > rain[i - 1])) && rps.join() === '2.5,10.5,25.5,100.5,500.5', `${rain.join(' / ')} mm/h · ${rps.join(', ')} yr`);
  check(r, 'a notice offers “Run the sweep”', /Run the sweep/.test(out.notice), out.notice.slice(0, 120));
  return out;
}

/** Press "Run the sweep" in the notice and check the sweep, its EAL, the caveats, the restored scenario and the report. */
async function addressSweep(r, tag) {
  const before = await D(() => {
    const s = window.__deluge.getState();
    return { rain: s.sim.rainRate, stageOffset: s.stageOffset, storms: s.storms.length, sources: s.sources.length };
  });
  await shot(`${tag}-address-site`);
  const t0 = Date.now();
  await page.click('.dl-notice.dl-show .dl-toast-actions button');
  const done = await page
    .waitForFunction(() => /^(Done|Sweep stopped|Cancelled)/.test(document.querySelector('[data-site="sweep-status"]')?.textContent ?? ''), null, { timeout: 480_000 })
    .then(() => true, () => false);
  const sweepS = (Date.now() - t0) / 1000;
  const out = await D(() => ({
    status: document.querySelector('[data-site="sweep-status"]')?.textContent ?? '',
    verdict: [...document.querySelectorAll('[data-site="verdict"] p')].map((p) => p.textContent ?? ''),
    rows: [...document.querySelectorAll('.dl-site-sweep-out .dl-site-table tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent ?? '')),
    caveats: !!document.querySelector('[data-site="rain-caveats"]'),
    chart: !!document.querySelector('.dl-site-sweep-out svg'),
    after: (() => {
      const s = window.__deluge.getState();
      return { rain: s.sim.rainRate, stageOffset: s.stageOffset, storms: s.storms.length, sources: s.sources.length };
    })(),
  }));
  const eal = out.verdict.find((v) => /Expected annual loss/.test(v)) ?? '';
  r.metrics.sweepSeconds = sweepS;
  r.metrics.sweepRows = out.rows;
  r.metrics.verdict = out.verdict;
  check(r, 'the five-level rain sweep completes', done && /^Done: 5 levels/.test(out.status), `${out.status.slice(0, 80)} (${num(sweepS, 1)} s wall)`);
  check(r, 'EAL comes from sourced return periods (no “needs your input”)', /Expected annual loss \$/.test(eal) && !/your input|No expected annual loss/.test(out.verdict.join(' ')), eal.slice(0, 160));
  check(r, 'the rain ladder’s caveats are shown with the result', out.caveats, String(out.caveats));
  check(r, 'the user’s scenario is put back (rain, stage, storms, sources)', JSON.stringify(out.after) === JSON.stringify(before), `${JSON.stringify(before)} → ${JSON.stringify(out.after)}`);
  await D(() => document.querySelector('[data-site="verdict"]')?.scrollIntoView({ block: 'start' }));
  await sleep(400);
  const panelShot = path.join(OUT, `${tag}-address-sweep.png`);
  await page.locator('.dl-panel').screenshot({ path: panelShot });
  console.log(`  [shot] ${path.relative(ROOT, panelShot)}`);
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.click('[data-site="report-html"]')]);
  const file = path.join(OUT, `${tag}-address-assessment.html`);
  await dl.saveAs(file);
  const html = fs.readFileSync(file, 'utf8');
  const has = ['NOAA Atlas 14', 'Rain ladder caveats', 'stationary', 'Atlas 14 100-yr 1-hour rain', 'hdsc.nws.noaa.gov', 'Expected annual loss'];
  const missing = has.filter((s) => !html.includes(s));
  check(r, 'the site assessment cites NOAA Atlas 14 and carries the caveats', missing.length === 0 && !/<script/i.test(html), missing.length ? `missing: ${missing.join(', ')}` : `${(html.length / 1024).toFixed(0)} KB`);
}

// ─── report ────────────────────────────────────────────────────────────────────────────────────
function printTable() {
  const rows = results.map((r) => {
    const failed = r.checks.filter((c) => !c.ok && !c.soft);
    const boilerplate = new Set(['no console / page / WebGPU errors', 'works offline (no external requests)']);
    const shown = (failed.length ? failed : r.checks.filter((c) => !boilerplate.has(c.label)))
      .map((c) => `${c.ok ? '' : c.soft ? '(soft) ' : 'FAILED '}${c.label}: ${c.measured}`)
      .concat(r.notes.filter((n) => n.startsWith('exception')))
      .map((line) => line.split('\n')[0])
      .concat(r.errors.length ? [`errors: ${r.errors.slice(0, 3).map((e) => e.split('\n')[0]).join(' | ')}`] : []);
    return { r, shown };
  });
  const line = '─'.repeat(118);
  console.log(`\n${line}\n  #  Flow${' '.repeat(52)}Result   Time`);
  console.log(line);
  for (const { r, shown } of rows) {
    console.log(
      `  ${String(r.id).padEnd(2)} ${r.name.slice(0, 55).padEnd(56)} ${r.pass ? 'PASS' : 'FAIL'}   ${r.seconds.toFixed(1).padStart(6)} s`,
    );
    for (const s of shown) console.log(`       · ${s.slice(0, 220)}`);
  }
  console.log(line);
  const passed = results.filter((r) => r.pass).length;
  console.log(`  ${passed}/${results.length} flows passed${httpFailures.length ? ` · ${httpFailures.length} HTTP failures (see report.json)` : ''}`);
  console.log(`${line}\n`);
}

let exitCode = 0;
try {
  await main();
} catch (e) {
  console.error(`[e2e] fatal: ${e.message}`);
  results.push({ id: 0, name: 'setup', pass: false, checks: [], metrics: {}, notes: [`exception: ${e.message}`], errors: [], seconds: 0 });
  exitCode = 2;
} finally {
  printTable();
  fs.writeFileSync(
    path.join(OUT, 'report.json'),
    JSON.stringify({ date: new Date().toISOString(), results, httpFailures }, (k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 2),
  );
  await cleanup();
}
if (results.length === 0 || results.some((r) => !r.pass)) exitCode = exitCode || 1;
process.exit(exitCode);
