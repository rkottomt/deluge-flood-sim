#!/usr/bin/env node
/**
 * Deluge end-to-end judge flows (DESIGN.md §9) in headless Chromium on the real GPU.
 *
 *   node scripts/e2e.mjs                 start a Vite dev server on :5190 (or the next free port) and run all flows
 *   E2E_URL=http://localhost:5173/ node scripts/e2e.mjs      use an already running server
 *   node scripts/e2e.mjs --only=1,2,6    run a subset (flows that need an earlier result compute it themselves)
 *   node scripts/e2e.mjs --preset=sandbox   run the preset-specific flows on another preset (default pittsburgh)
 *
 * Screenshots → artifacts/e2e/NN-name.png, machine-readable report → artifacts/e2e/report.json.
 * Prints a PASS/FAIL table with measured numbers and exits non-zero if any flow fails.
 * Console errors, page errors and window.__deluge.errors are collected per flow; any of them fails the flow.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
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
  if (vite && vite.exitCode === null) {
    try {
      process.kill(-vite.pid, 'SIGTERM'); // whole process group (npx → node vite)
    } catch {
      try {
        vite.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
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

async function startVite() {
  let port = Number(args.port ?? 5190);
  while (!(await portFree(port))) port++;
  const logPath = path.join(OUT, 'vite.log');
  const log = fs.openSync(logPath, 'w');
  vite = spawn('npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, BROWSER: 'none' },
  });
  const url = `http://127.0.0.1:${port}/`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) throw new Error(`vite exited early (code ${vite.exitCode}); see ${logPath}`);
    try {
      const r = await fetch(url);
      if (r.ok) return url;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`vite did not come up on ${url} within 60 s; see ${logPath}`);
}

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

async function main() {
  const baseUrl = process.env.E2E_URL ?? (await startVite());
  console.log(`[e2e] app URL ${baseUrl}${vite ? ' (own vite server)' : ''}`);

  browser = await chromium.launch({
    headless: true,
    channel: 'chromium', // new headless: real Metal GPU → hardware WebGPU (the headless shell only has SwiftShader)
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
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
    if (only && !only.has(flow.id)) continue;
    if (!flow.resetsPage && page.url() === 'about:blank') {
      // Flow 1 was skipped: open the app first.
      await page.goto(ctx.appUrl, { waitUntil: 'domcontentloaded' });
      await waitReady(120_000);
    }
    await runFlow(flow, ctx);
  }
}

/** Run one flow with timeout + per-flow error collection. */
async function runFlow(flow, ctx) {
  const r = { id: flow.id, name: flow.name, pass: false, checks: [], metrics: {}, notes: [], errors: [], seconds: 0 };
  results.push(r);
  console.log(`\n[e2e] (${flow.id}) ${flow.name}`);
  consoleErrors = [];
  const t0 = Date.now();
  let threw = false;
  // Every flow after the first starts from a ready app (also covers an unexpected page reload).
  if (!flow.resetsPage) await waitReady(60_000).catch(() => {});
  const errBase = await delugeErrorCount();
  try {
    await withTimeout(flow.run(r, ctx), flow.timeoutMs ?? 300_000, `flow ${flow.id}`);
  } catch (e) {
    threw = true;
    r.notes.push(`exception: ${e.message}`);
    console.log(`  ✗ exception: ${e.message}`);
  }
  r.seconds = (Date.now() - t0) / 1000;
  const appErrors = await delugeErrors(flow.resetsPage ? 0 : errBase);
  r.errors = [...consoleErrors, ...appErrors.filter((e) => !consoleErrors.some((c) => c.includes(e)))];
  check(r, 'no console / page / WebGPU errors', r.errors.length === 0, `${r.errors.length} errors`);
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
 * The "control" flood: Pittsburgh at the 1936 crest for 1800 s without walls. Records the initial and
 * flooded depth fields (stride 4) in the page as window.__e2e for later flows.
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
  await runFor(1800);
  await D(() => {
    window.__e2e.control = window.__deluge.sampleGrid('depth', 4);
  });
  r?.notes.push('computed control flood (crest, 1800 s)');
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
      check(r, 'DESIGN target < 5 s', readyMs < 5_000, `${(readyMs / 1000).toFixed(2)} s`, { soft: true });

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
      const t600 = await runFor(600);
      const mid = await stats();
      await shot('02a-crest-600s');
      const t1800 = await runFor(1200);
      const after = await stats();
      await D(() => {
        window.__e2e.control = window.__deluge.sampleGrid('depth', 4);
      });
      await shot('02b-crest-1800s');
      r.metrics = { before: before?.floodedArea, at600: mid?.floodedArea, at1800: after?.floodedArea, runSeconds: t600 + t1800 };
      const grown = (after?.floodedArea ?? 0) - (before?.floodedArea ?? 0);
      check(r, 'flooded area grows substantially (≥ 0.25 km²)', grown >= 250_000, `${km2(before?.floodedArea ?? 0)} → ${km2(mid?.floodedArea ?? 0)} → ${km2(after?.floodedArea ?? 0)}`);
      check(r, 'flooding is progressive (600 s < 1800 s)', (mid?.floodedArea ?? 0) <= (after?.floodedArea ?? 0) && (mid?.floodedArea ?? 0) > (before?.floodedArea ?? 0), `sim 1800 s in ${(t600 + t1800).toFixed(1)} s real`);
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
      // Pick a wall site on land that floods in the control run, at the flood edge nearest the domain center.
      const site = await D(() => {
        const { initial, control } = window.__e2e;
        const { w, h, stride } = control;
        const at = (g, x, y) => g.data[y * w + x];
        let best = null;
        for (let y = 2; y < h - 2; y++) {
          for (let x = 2; x < w - 2; x++) {
            const d = at(control, x, y);
            if (!(d > 0.5 && d < 4) || at(initial, x, y) > 0.01) continue;
            // Direction toward dry land (unflooded in control) among the 8 neighbors at distance 3.
            let dx = 0, dy = 0, dry = 0;
            for (let oy = -1; oy <= 1; oy++)
              for (let ox = -1; ox <= 1; ox++) {
                if (!ox && !oy) continue;
                const xx = x + ox * 2, yy = y + oy * 2;
                if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
                if (at(control, xx, yy) < 0.05) { dx += ox; dy += oy; dry++; }
              }
            if (dry < 2 || (dx === 0 && dy === 0)) continue;
            const cx = (x + 0.5) * stride, cy = (y + 0.5) * stride;
            const dist = Math.hypot(cx - (w * stride) / 2, cy - (h * stride) / 2);
            if (!best || dist < best.dist) best = { cx, cy, dx, dy, dist, depth: d };
          }
        }
        if (!best) return null;
        const len = Math.hypot(best.dx, best.dy);
        const ux = best.dx / len, uy = best.dy / len; // toward dry land
        // Wall inside the flooded zone, perpendicular to the flow toward the dry land; "behind" is flooded land
        // between the wall and the control flood edge (what the wall is meant to protect).
        const c = { gx: best.cx - ux * 14, gy: best.cy - uy * 14 };
        const half = 32;
        const a = { gx: c.gx - uy * half, gy: c.gy + ux * half };
        const b = { gx: c.gx + uy * half, gy: c.gy - ux * half };
        const behind = { gx: c.gx + ux * 8, gy: c.gy + uy * 8 };
        return { a, b, c, behind, ux, uy, controlDepth: best.depth };
      });
      check(r, 'found a flooding street site', !!site, site ? `center (${num(site.c.gx, 0)}, ${num(site.c.gy, 0)})` : 'none');
      if (!site) return;

      await calm();
      await runFor(30);
      await D((s) => window.__deluge.drawWall([s.a, s.c, s.b], 4), site);
      await D(() => window.__deluge.waitFrames(3));
      const wall = await D((s) => window.__deluge.sampleAt(s.c.gx, s.c.gy), site);
      check(r, 'wall raised on the bed (CPU mirror)', (wall?.barrier ?? 0) >= 3.5, `barrier ${num(wall?.barrier ?? 0)} m`);

      await D((o) => window.__deluge.setStageOffset(o), crest.offset);
      const secs = await runFor(900);
      const behind = await D((s) => {
        const d = window.__deluge;
        let with_ = 0;
        let n = 0;
        for (let oy = -2; oy <= 2; oy++)
          for (let ox = -2; ox <= 2; ox++) {
            with_ += d.sampleAt(s.behind.gx + ox, s.behind.gy + oy).depth;
            n++;
          }
        const { control } = window.__e2e;
        const cx = Math.floor(s.behind.gx / control.stride), cy = Math.floor(s.behind.gy / control.stride);
        return { withWall: with_ / n, control: control.data[cy * control.w + cx] };
      }, site);
      r.metrics = { site, behind, runSeconds: secs };
      check(r, 'protected side drier than without the wall', behind.withWall <= behind.control + 1e-3, `${num(behind.withWall)} m with wall vs ${num(behind.control)} m without`, { soft: true });

      const ground = await D((s) => window.__deluge.sampleAt(s.c.gx, s.c.gy).ground, site);
      const yaw = Math.atan2(site.ux, -site.uy); // look from the wet side toward the protected land
      await D(
        (p) => window.__deluge.setCamera({ target: { gx: p.gx, gy: p.gy, elevation: p.elev }, distance: 650, yaw: p.yaw, pitch: 0.62 }),
        { gx: site.c.gx, gy: site.c.gy, elev: ground, yaw },
      );
      await sleep(600);
      await shot('03-levee');
    },
  },
  {
    id: 4,
    name: 'Crank the rain → streets pond',
    timeoutMs: 300_000,
    async run(r) {
      await calm();
      await runFor(60);
      const before = await stats();
      const grid = (await state(['grid'])).grid;
      await D(() => window.__deluge.setRain(100));
      const secs = await runFor(900);
      const after = await stats();
      const expectedRain = (100 / 1000 / 3600) * 900 * grid.nx * grid.ny * grid.cellSize ** 2;
      const dv = (after?.volume ?? 0) - (before?.volume ?? 0);
      r.metrics = { before, after, expectedRainVolume: expectedRain, runSeconds: secs };
      check(r, 'water volume increases', dv > 0, `${m3(before?.volume)} → ${m3(after?.volume)} (Δ ${m3(dv)}, rain delivered ≈ ${m3(expectedRain)})`);
      check(r, 'volume gain ≥ 20 % of rain delivered (rest drains / leaves domain)', dv >= 0.2 * expectedRain, `${num((dv / expectedRain) * 100, 1)} %`, { soft: true });
      check(r, 'wet area grows', (after?.wetArea ?? 0) > (before?.wetArea ?? 0), `${km2(before?.wetArea ?? 0)} → ${km2(after?.wetArea ?? 0)}`);
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
      await D(() => window.__deluge.actions.cameraFrameAll());
      // Prefer the real UI button when it is visible; otherwise use the debug API.
      let via = 'debug API';
      const button = page.locator('button', { hasText: /break it/i }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        via = 'UI button';
      }
      if (!(await D(() => window.__deluge.isStabilityDemo()))) {
        await D(() => window.__deluge.actions.setStabilityDemo(true));
        via = via === 'UI button' ? 'UI button (did not toggle) → debug API' : via;
      }
      const params = await D(() => window.__deluge.getState().sim);
      check(r, 'naive mode active', params.stabilityMode === 'naive' && params.cfl > 1, `${params.stabilityMode}, CFL ${params.cfl} via ${via}`);
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
      await shot('06a-stability-blowup');

      await D(() => window.__deluge.actions.setStabilityDemo(false));
      await runFor(60);
      const healed = await stats();
      r.metrics.recovered = healed;
      const sim = await D(() => window.__deluge.getState().sim);
      check(r, 'robust mode restored', sim.stabilityMode === 'robust' && sim.cfl <= 1, `${sim.stabilityMode}, CFL ${sim.cfl}`);
      check(r, 'stats sane after recovery', statsFinite(healed) && healed.maxSpeed < 30 && healed.massError < 0.01, `maxSpeed ${num(healed?.maxSpeed)} m/s, maxDepth ${num(healed?.maxDepth)} m, massError ${num((healed?.massError ?? NaN) * 100, 4)} %`);
      await shot('06b-stability-recovered');
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
];

// ─── report ────────────────────────────────────────────────────────────────────────────────────
function printTable() {
  const rows = results.map((r) => {
    const failed = r.checks.filter((c) => !c.ok && !c.soft);
    const shown = (failed.length ? failed : r.checks.filter((c) => c.label !== 'no console / page / WebGPU errors'))
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
