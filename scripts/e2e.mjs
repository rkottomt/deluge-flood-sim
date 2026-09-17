#!/usr/bin/env node
/**
 * Deluge end-to-end judge flows in headless Chromium on the real GPU.
 *
 *   node scripts/e2e.mjs                    in-process Vite dev server on :5190 (or the next free port), all flows
 *   node scripts/e2e.mjs --prod             production build + `vite preview` (what `npm run demo` serves)
 *   E2E_URL=http://localhost:5173/ node scripts/e2e.mjs      use an already running server
 *   node scripts/e2e.mjs --only=1,2,6       run a subset (flows that need an earlier result compute it themselves)
 *   node scripts/e2e.mjs --preset=sandbox   run the preset-specific flows on another preset (default pittsburgh)
 *   node scripts/e2e.mjs --live             also run the live-area flow (needs internet: USGS, Esri, TIGERweb)
 *
 * Offline guarantee: every request to a non-local host is blocked (the demo venue's wifi is unreliable) and
 * reported; the baked-preset flows must not need any. Only the opt-in live flow may use the network. The startup-cancel
 * flow holds external requests unanswered instead (stalled venue wifi), so it needs no network either.
 *
 * Screenshots → artifacts/e2e/NN-name.png, machine-readable report → artifacts/e2e/report.json.
 * Prints a PASS/FAIL table with measured numbers and exits non-zero if any flow fails.
 * Console errors, page errors and window.__deluge.errors are collected per flow; any of them fails the flow.
 */
import { chromium } from 'playwright';
import { build, createServer, preview } from 'vite';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'artifacts', 'e2e');
const WIDTH = 1600;
const HEIGHT = 1000;
const TOOL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
const ALL_TOOLS = ['orbit', 'wall', 'eraseWall', 'inflow', 'storm', 'water', 'dig', 'evac', 'shelter', 'probe'];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const only = args.only ? new Set(String(args.only).split(',').map((s) => Number(s.trim()))) : null;
/** Main preset for flows 1–6 and 9 (the judge demo is Pittsburgh; other presets are useful while developing). */
const PRESET = String(args.preset ?? process.env.E2E_PRESET ?? 'pittsburgh');
const OTHER_PRESETS = ['pittsburgh', 'sandbox', 'johnstown', 'ellicott'].filter((p) => p !== PRESET);

fs.mkdirSync(OUT, { recursive: true });

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

  browser = await chromium.launch({
    headless: true,
    channel: 'chromium', // new headless: real Metal GPU → hardware WebGPU (the headless shell only has SwiftShader)
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
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
  r.errors = [...consoleErrors, ...appErrors.filter((e) => !consoleErrors.some((c) => c.includes(e)))];
  check(r, 'no console / page / WebGPU errors', r.errors.length === 0, `${r.errors.length} errors`);
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
    if (d.isStabilityDemo()) d.actions.setStabilityDemo(false);
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
    },
  },
  {
    id: 6,
    name: 'Stability demo breaks and recovers',
    timeoutMs: 300_000,
    async run(r) {
      await calm();
      await runFor(30);
      // A flooded evacuation start first: the blow-up's NaN depths must not read as dry roads and "re-plan" a safe route.
      const crest = await crestOffset();
      let routeBefore = null;
      if (crest) {
        await D((o) => window.__deluge.setStageOffset(o), crest.offset);
        await runFor(300);
        // Deeply flooded streets near the centre (not the river channel), nearest first.
        const starts = await D(() => {
          const g = window.__deluge.sampleGrid('depth', 8);
          const c = [];
          for (let y = 0; y < g.h; y++)
            for (let x = 0; x < g.w; x++) {
              const dep = g.data[y * g.w + x];
              if (dep >= 1.5 && dep <= 4) c.push({ gx: (x + 0.5) * 8, gy: (y + 0.5) * 8, dist: Math.hypot(x - g.w / 2, y - g.h / 2) });
            }
          return c.sort((p, q) => p.dist - q.dist).slice(0, 6);
        });
        for (const p of starts) {
          await D((q) => window.__deluge.setEvacStart({ gx: q.gx, gy: q.gy }), p);
          const blocked = await page
            .waitForFunction(() => window.__deluge.getRoute()?.state === 'blocked', null, { timeout: 2500 })
            .then(() => true)
            .catch(() => false);
          if (blocked) break;
        }
      }
      await D(() => window.__deluge.actions.cameraFrameAll());
      await sleep(1600); // camera flight
      // Use the real UI: "How it works" → "Break it" (falls back to the debug API if the UI changed).
      let via = 'debug API';
      await D(() => window.__deluge.store.set({ panels: { ...window.__deluge.getState().panels, howItWorks: true } }));
      const button = page.locator('button.dl-break-btn').first();
      if (!(await button.isVisible({ timeout: 1500 }).catch(() => false))) {
        // The explainer may be tabbed: open its "Break it" section first.
        const tab = page.locator('button:has-text("Break it"):not(.dl-break-btn)').first();
        if (await tab.isVisible().catch(() => false)) await tab.click();
      }
      await button.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        await button.click();
        via = 'How it works → Break it';
      }
      await sleep(600); // the dialog closes itself so the blow-up is visible
      if (!(await D(() => window.__deluge.isStabilityDemo()))) {
        await D(() => window.__deluge.actions.setStabilityDemo(true));
        via = via === 'debug API' ? via : `${via} (did not toggle) → debug API`;
      }
      await D(() => window.__deluge.store.set({ panels: { ...window.__deluge.getState().panels, howItWorks: false } }));
      const params = await D(() => window.__deluge.getState().sim);
      check(r, 'naive mode active', params.stabilityMode === 'naive' && params.cfl > 1, `${params.stabilityMode}, CFL ${params.cfl} via ${via}`);
      // The route the robust solver last planned (routing ignores the naive solver's readbacks from here on).
      if (crest) {
        routeBefore = await D(() => {
          const rt = window.__deluge.getRoute();
          return rt && { state: rt.state, message: rt.message };
        });
      }
      let runNote = 'completed';
      await runFor(60).catch((e) => {
        runNote = `runFor: ${e.message}`;
      });
      const broken = await stats();
      const blewUp =
        !broken ||
        !Number.isFinite(broken.maxSpeed) ||
        !Number.isFinite(broken.volume) ||
        !Number.isFinite(broken.maxDepth) ||
        broken.maxSpeed > 50 ||
        broken.massError > 0.05;
      r.metrics.broken = broken;
      check(r, 'instability evident', blewUp, `maxSpeed ${broken?.maxSpeed}, maxDepth ${broken?.maxDepth}, massError ${broken?.massError} (${runNote})`);
      await sleep(800); // several route intervals of diverged readbacks
      const routeBroken = await D(() => {
        const rt = window.__deluge.getRoute();
        return rt && { state: rt.state, message: rt.message };
      });
      check(
        r,
        'the blow-up does not re-plan the evacuation (NaN water is not dry road)',
        !!routeBefore && routeBefore.state !== 'ok' && routeBroken?.state === routeBefore.state && routeBroken?.message === routeBefore.message,
        `before “${routeBefore?.state}: ${routeBefore?.message ?? 'no route'}” → during blow-up “${routeBroken?.state}: ${routeBroken?.message ?? 'no route'}”`,
      );
      await shot('06a-stability-blowup');

      // Restore through the banner's button (debug API fallback).
      const restore = page.locator('.dl-naive-banner button').first();
      let restoredVia = 'debug API';
      if (await restore.isVisible({ timeout: 2000 }).catch(() => false)) {
        await restore.click();
        restoredVia = 'banner button';
      }
      if (await D(() => window.__deluge.isStabilityDemo())) await D(() => window.__deluge.actions.setStabilityDemo(false));
      r.notes.push(`restored via ${restoredVia}`);
      await runFor(60);
      const healed = await stats();
      r.metrics.recovered = healed;
      const sim = await D(() => window.__deluge.getState().sim);
      check(r, 'robust mode restored', sim.stabilityMode === 'robust' && sim.cfl <= 1, `${sim.stabilityMode}, CFL ${sim.cfl}`);
      check(r, 'stats sane after recovery', statsFinite(healed) && healed.maxSpeed < 30 && healed.massError < 0.01, `maxSpeed ${num(healed?.maxSpeed)} m/s, maxDepth ${num(healed?.maxDepth)} m, massError ${num((healed?.massError ?? NaN) * 100, 4)} %`);
      await shot('06b-stability-recovered');
      await D(() => window.__deluge.setEvacStart(null));
    },
  },
  {
    id: 7,
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
        await shot(`07-${id}`);
      }
    },
  },
  {
    id: 8,
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
        if (key === '0') await shot('08-probe-tool');
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
    id: 9,
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
      await shot(`09-fps-${PRESET}`);
    },
  },
  {
    id: 10,
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
    id: 11,
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
      await shot('11-live-area');
      r.metrics = { loadSeconds: loadS, requests: externalRequests.length };
    },
  },
  {
    id: 12,
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
      const before = await D(() => window.__deluge.getState().loading);
      check(r, 'live download stalls with Cancel offered', !!before?.cancellable && externalRequests.length > 0, `“${before?.message}”, ${externalRequests.length} requests held`);
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
        const notice = [...document.querySelectorAll('button')].find((b) => /^Retry Harrisburg/.test(b.textContent ?? ''));
        return { ready, presetId: s.presetId, name: s.terrainName, search: location.search, retry: notice?.textContent ?? null };
      });
      check(r, 'Cancel shows the offline default scenario (not a black screen)', shown && after.presetId === 'pittsburgh' && after.ready === 'ready', `${after.name || '(nothing)'} in ${loadS.toFixed(1)} s, ready ${after.ready}`);
      check(r, 'notice offers a retry of the live area', !!after.retry, after.retry ?? 'no retry button');
      check(r, 'address bar points at the preset (a reload does not download again)', after.search === '?preset=pittsburgh', after.search);
      await shot('12-startup-cancel');
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
];

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
