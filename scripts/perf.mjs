#!/usr/bin/env node
/**
 * Deluge LAG SUITE — "does it ever feel slow?", as a pass/fail gate.
 *
 *   npm run test:perf                 # full run (~8 min): 6 scenarios x 2 viewports + a 60 s sustain check
 *   npm run test:perf -- --quick      # fast subset (~2 min): 2 scenarios, demo viewport, short windows
 *   node scripts/perf.mjs --url=https://example.com/deluge/   # measure an already-served copy
 *
 * What it does, from a fresh clone with no other setup:
 *   1. builds the production bundle into a temp dist (unless --url is given),
 *   2. serves it with `vite preview` on its own port,
 *   3. drives it in headless Chromium on the real GPU (channel 'chromium', WebGPU enabled),
 *   4. measures every scenario and asserts thresholds,
 *   5. writes artifacts/perf/perf-results.json, prints a table, and exits non-zero on a regression.
 *
 * Measured per scenario/viewport:
 *   fps mean and p95-low · frame-time p50/p95/p99 · frames slower than 34 ms and 50 ms · achieved sim speed
 *   (simulated seconds per wall second) · main-thread CPU ms per frame (mean/p95) · GPU queue latency
 *   (onSubmittedWorkDone, median/p90) · input latency (a real pointer drag, measured to the frame that shows it)
 *   · time-to-interactive · and, once, a 60 s sustain run checked for drift.
 *
 * THRESHOLDS come in two tiers (see THRESHOLDS below):
 *   • floor  — always fatal. A miss here is a broken build, not a noisy laptop.
 *   • target — the number this machine actually hits today, with margin. Fatal on a quiet machine on AC power;
 *              ADVISORY (reported, exit 0) when the run is noisy: on battery, in Low Power Mode, or with other
 *              GPU/browser processes running. `--strict` makes targets fatal regardless; DELUGE_PERF_ADVISORY=1
 *              makes them advisory regardless.
 * Every threshold is overridable by env var, e.g. DELUGE_PERF_MIN_FPS=50 npm run test:perf.
 *
 * Power state (`pmset -g batt`, Low Power Mode) and machine load are recorded in the JSON report and printed,
 * because they move these numbers by more than the margins do.
 *
 * Flags: --quick --strict --url=<url> --port=<n> --json=<path> --seconds=<n> --sustain=<s>
 *        --scenario=idle,crest,... --viewport=air|wide|both --keep-dist --headed --calibrate --allow-low-power
 *   --calibrate prints the measured numbers as a ready-to-paste THRESHOLDS block and never fails.
 *   --allow-low-power measures with macOS Low Power Mode on and keeps the floors fatal. Off by default: LPM caps
 *   the GPU clocks, and the same scenario measured 162x sim speed with it off against 27x with it on.
 */
import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'perf');

// ── arguments ───────────────────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const QUICK = argv.quick === 'true';
const STRICT = argv.strict === 'true';
const CALIBRATE = argv.calibrate === 'true';
const KEEP_DIST = argv['keep-dist'] === 'true' || process.env.DELUGE_TEST_KEEP_DIST === '1';
const PORT = Number(argv.port ?? 5701);
const EXTERNAL_URL = String(argv.url ?? process.env.DELUGE_TEST_URL ?? '');
const JSON_OUT = String(argv.json ?? path.join(OUT_DIR, 'perf-results.json'));
const SECONDS = Number(argv.seconds ?? (QUICK ? 8 : 15));
const SUSTAIN_S = Number(argv.sustain ?? (QUICK ? 0 : 60));

// ── thresholds ──────────────────────────────────────────────────────────────────────────────────
// Calibrated on the demo machine (MacBook Air M4, 16 GB, macOS 15) on 2026-09-17 with
// `node scripts/perf.mjs --calibrate --port=5603` — 11 cases, on battery, Low Power Mode off. The worst case
// measured across all of them was: 60.0 fps mean, 52.6 fps p95-low, 16.7 ms p50, 19.0 ms p95, 23.1 ms p99,
// zero frames over 34 ms, 4.1 ms CPU p95, 43.0 ms GPU p90, 55.9 ms input p95, 0.55 s TTI (15.8 s for the live
// area, which is a download). Targets keep ~25-60% headroom beyond those so normal GPU-sharing noise cannot
// trip them; floors are "the demo is visibly broken", not "the laptop is busy".
const THRESHOLDS = {
  /** Mean rendered frames per second over the measurement window. */
  fpsMean: { dir: 'min', env: 'DELUGE_PERF_MIN_FPS', target: 55, floor: 30, unit: 'fps' },
  /** The fps you get 95% of the time (1000 / p95 frame interval). */
  fpsP95Low: { dir: 'min', env: 'DELUGE_PERF_MIN_FPS_P95', target: 45, floor: 20, unit: 'fps' },
  p50FrameMs: { dir: 'max', env: 'DELUGE_PERF_MAX_P50_MS', target: 18.5, floor: 34, unit: 'ms' },
  p95FrameMs: { dir: 'max', env: 'DELUGE_PERF_MAX_P95_MS', target: 24, floor: 50, unit: 'ms' },
  p99FrameMs: { dir: 'max', env: 'DELUGE_PERF_MAX_P99_MS', target: 34, floor: 80, unit: 'ms' },
  /** Fraction of frame intervals slower than 34 ms (a dropped frame at 60 Hz) and 50 ms (visible hitch). */
  slow34Frac: { dir: 'max', env: 'DELUGE_PERF_MAX_SLOW_FRAC', target: 0.03, floor: 0.25, unit: '' },
  slow50Frac: { dir: 'max', env: 'DELUGE_PERF_MAX_HITCH_FRAC', target: 0.01, floor: 0.1, unit: '' },
  /** Simulated seconds advanced per wall second, as a fraction of what the scenario asked for (per-scenario target). */
  simSpeedFrac: { dir: 'min', env: 'DELUGE_PERF_MIN_SIM_SPEED_FRAC', target: 0.9, floor: 0.25, unit: 'x' },
  /** Absolute simulated seconds per wall second. Only asserted for the scenarios that force a high time scale. */
  simSpeed: { dir: 'min', env: 'DELUGE_PERF_MIN_SIM_SPEED', target: 55, floor: 20, unit: 'x' },
  /** Main-thread time inside the app's own frame callback. */
  cpuFrameP95Ms: { dir: 'max', env: 'DELUGE_PERF_MAX_CPU_P95_MS', target: 12, floor: 30, unit: 'ms' },
  /** Time from queue submit to onSubmittedWorkDone — how far the GPU runs behind the main thread. */
  gpuLatP90Ms: { dir: 'max', env: 'DELUGE_PERF_MAX_GPU_LAT_MS', target: 70, floor: 140, unit: 'ms' },
  /** Real pointer drag to the first frame that shows the new camera. */
  inputLatP95Ms: { dir: 'max', env: 'DELUGE_PERF_MAX_INPUT_LATENCY_MS', target: 85, floor: 200, unit: 'ms' },
  /** Navigation start to __deluge.ready (first frame with terrain and water). Overridden for the live scenario. */
  ttiS: { dir: 'max', env: 'DELUGE_PERF_MAX_TTI_S', target: 9, floor: 25, unit: 's' },
  /**
   * Sustain run only, and ONE-SIDED: only degradation counts. A scenario that speeds up as the flood settles is
   * not a lag regression, so the checks below feed max(0, drop) rather than |change|.
   */
  driftPct: { dir: 'max', env: 'DELUGE_PERF_MAX_DRIFT_PCT', target: 12, floor: 40, unit: '%' },
  /** Sim speed legitimately moves with the physics (more wet cells = more work), so it is judged far more loosely. */
  simDriftPct: { dir: 'max', env: 'DELUGE_PERF_MAX_SIM_DRIFT_PCT', target: 45, floor: 75, unit: '%' },
  /** Frame-time p95 growth from the first chunk to the last: the clearest "it gets laggier the longer it runs". */
  p95GrowthMs: { dir: 'max', env: 'DELUGE_PERF_MAX_P95_GROWTH_MS', target: 5, floor: 15, unit: 'ms' },
};

// An explicitly set env var wins over both the default above and any per-scenario override below, so a single
// `DELUGE_PERF_MIN_FPS=50 npm run test:perf` really does apply to every scenario.
for (const t of Object.values(THRESHOLDS)) {
  const v = process.env[t.env];
  if (v !== undefined && v !== '' && Number.isFinite(Number(v))) {
    t.target = Number(v);
    t.envLocked = true;
  }
}

/** Per-scenario expectations: which metrics apply, and the requested sim speed to compare against. */
const SCENARIOS = {
  idle: {
    label: 'idle Pittsburgh',
    preset: 'pittsburgh',
    quick: true,
    // Nothing forces the clock, so the scenario must hit its requested 60x exactly.
    thresholds: { simSpeedFrac: { target: 0.9, floor: 0.5 } },
    async setup(page) {
      return page.evaluate(() => ({ requested: window.__deluge.getState().sim.timeScale }));
    },
  },
  crest: {
    label: 'crest raise (1936, 46 ft)',
    preset: 'pittsburgh',
    thresholds: { simSpeedFrac: { target: 0.9, floor: 0.5 } },
    async setup(page) {
      return page.evaluate(() => {
        const d = window.__deluge;
        const off = d.stageOffsetForFeet(46);
        d.setStageOffset(off);
        return { stageOffset: off, requested: d.getState().sim.timeScale };
      });
    },
  },
  'crest-rain': {
    label: 'crest + 100 mm/hr rain @ 300x',
    preset: 'pittsburgh',
    quick: true,
    sustain: true,
    // 300x on a 1024² grid is GPU-bound by design: the substep budget throttles to protect the frame rate, so the
    // guarantee is "still fast, and still much faster than real time", not "hits 300x". Measured 162x / 0.54 today.
    thresholds: { simSpeedFrac: { target: 0.40, floor: 0.15 }, simSpeed: { target: 110, floor: 40 } },
    async setup(page) {
      return page.evaluate(() => {
        const d = window.__deluge;
        const off = d.stageOffsetForFeet(46);
        d.setStageOffset(off);
        d.setRain(100);
        d.setTimeScale(300);
        return { stageOffset: off, rain: 100, requested: 300 };
      });
    },
  },
  johnstown: {
    label: 'Johnstown inflow',
    preset: 'johnstown',
    // Tripled inflows at 300x: the heaviest forcing in the suite. Measured 120x / 0.40 today.
    thresholds: { simSpeedFrac: { target: 0.30, floor: 0.12 }, simSpeed: { target: 85, floor: 30 } },
    async setup(page) {
      return page.evaluate(() => {
        const d = window.__deluge;
        const sc = d.getScenario();
        const inflows = (sc?.sources ?? []).filter((s) => s.type === 'inflow');
        for (const s of inflows) d.addSource({ ...s, id: `${s.id}-perf`, discharge: s.discharge * 3 });
        d.setTimeScale(300);
        return { inflows: inflows.length, requested: 300 };
      });
    },
  },
  levee: {
    label: 'levee build (real pointer drag)',
    preset: 'pittsburgh',
    thresholds: { simSpeedFrac: { target: 0.9, floor: 0.5 } },
    async setup(page, ctx) {
      await page.evaluate(() => {
        const d = window.__deluge;
        d.setStageOffset(d.stageOffsetForFeet(46));
        d.selectTool('wall');
      });
      // Draw the levee with real pointer events so the tool controller, the wall ghost preview and the
      // protected-land analysis all run exactly as they do for a presenter.
      const pts = await canvasDragPoints(page, ctx);
      await page.mouse.move(pts[0].x, pts[0].y);
      await page.mouse.down();
      for (const p of pts.slice(1)) {
        await page.mouse.move(p.x, p.y, { steps: 6 });
        await page.waitForTimeout(40);
      }
      await page.mouse.up();
      await page.waitForTimeout(400);
      return page.evaluate(() => {
        const d = window.__deluge;
        d.selectTool('orbit');
        return { protection: d.getProtection(), requested: d.getState().sim.timeScale };
      });
    },
  },
  live: {
    label: 'live area load (needs network)',
    // A live area is requested through the URL so the measurement includes its download + build.
    url: '?live=40.4406,-79.9959,3&res=512',
    needsNetwork: true,
    // TTI here includes a DEM + imagery download from USGS/Esri, so it is bounded by the network, not the GPU.
    // Measured 15.8 s today on home wifi. The other metrics are measured after the terrain is up and apply as usual.
    thresholds: { ttiS: { target: 26, floor: 60 }, simSpeedFrac: { target: 0.9, floor: 0.5 } },
    async setup(page) {
      return page.evaluate(() => ({
        preset: window.__deluge.getState().presetId,
        name: window.__deluge.getState().terrainName,
        requested: window.__deluge.getState().sim.timeScale,
      }));
    },
  },
};

const VIEWPORTS = {
  air: { label: 'Air 1470x956 @2', width: 1470, height: 956, dpr: 2 },
  wide: { label: 'Wide 1600x1000 @1', width: 1600, height: 1000, dpr: 1 },
};

// ── machine state ───────────────────────────────────────────────────────────────────────────────
async function machineState() {
  const run = async (cmd, args) => {
    try {
      return (await execFileAsync(cmd, args, { timeout: 8000 })).stdout.trim();
    } catch {
      return '';
    }
  };
  const batt = await run('pmset', ['-g', 'batt']);
  // `pmset -g` prints the settings CURRENTLY IN USE. `pmset -g custom` prints the AC block too, whose
  // lowpowermode says nothing about a run on battery — reading that instead reports Low Power Mode backwards.
  const active = await run('pmset', ['-g']);
  const psList = await run('bash', ['-lc', "ps -Ao %cpu=,comm= | sort -rn | head -12"]);
  const onBattery = /Battery Power/i.test(batt);
  const pct = Number(batt.match(/(\d+)%/)?.[1] ?? NaN);
  const lowPower = /lowpowermode\s+1/.test(active);
  const load = os.loadavg();
  const cpuCount = os.cpus().length || 8;
  const loadNorm = load[0] / cpuCount;
  // Another browser or Playwright run sharing the GPU is the most common source of noise here.
  const rows = psList
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const gpuHogs = rows.filter(
    (l) => /(Chromium|Google Chrome|Brave|Safari|WebKit|firefox)/i.test(l) && Number(l.split(/\s+/)[0]) > 15,
  );
  // …but so is anything else eating the machine. Spotlight reindexing the repo (corespotlightd) sat at 250% CPU
  // during a calibration run on this laptop and slowed every scenario, without moving the load average much.
  const cpuHogs = rows.filter((l) => {
    const cpu = Number(l.split(/\s+/)[0]);
    return cpu > 80 && !/(Chromium|Google Chrome|Brave|Safari|WebKit|firefox|node$|vite)/i.test(l);
  });
  const reasons = [];
  if (onBattery) reasons.push(`on battery (${Number.isFinite(pct) ? pct + '%' : 'unknown'})`);
  if (lowPower) reasons.push('Low Power Mode is ON');
  if (loadNorm > 0.7) reasons.push(`load average ${load[0].toFixed(1)} over ${cpuCount} cores`);
  if (gpuHogs.length) reasons.push(`${gpuHogs.length} other browser process(es) busy — the GPU is shared`);
  if (cpuHogs.length) reasons.push(`busy: ${cpuHogs.map((l) => l.split(/\s+/).slice(1).join(' ').split('/').pop()).join(', ')}`);
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    cpus: cpuCount,
    memGB: +(os.totalmem() / 1024 ** 3).toFixed(1),
    loadavg: load.map((x) => +x.toFixed(2)),
    pmsetBatt: batt,
    onBattery,
    batteryPct: Number.isFinite(pct) ? pct : null,
    lowPowerMode: lowPower,
    busyProcesses: gpuHogs.concat(cpuHogs),
    noisy: reasons.length > 0,
    noisyReasons: reasons,
  };
}

// ── build + serve ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Is anything listening on `port`? Both stacks are probed: `vite preview --host localhost` binds only [::1] on
 * macOS, so an IPv4-only probe reports a healthy server as down and the suite times out waiting for it.
 */
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

async function buildAndServe(distDir, port, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
  process.stdout.write(`[perf] building production bundle → ${path.relative(ROOT, distDir)} … `);
  // Production build in every respect that costs frames (minified, tree-shaken, real assets) but with the
  // automation surface compiled in: SEC-07 strips window.__deluge from a released bundle, and this suite
  // measures through it. scripts/e2e.mjs does the same. The released build is what test:security checks.
  const build = spawn('npx', ['vite', 'build', '--outDir', distDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DELUGE_DEBUG_API: '1' },
  });
  build.stdout.pipe(log, { end: false });
  build.stderr.pipe(log, { end: false });
  const [code] = await once(build, 'exit');
  if (code !== 0) throw new Error(`vite build failed (exit ${code}); see ${logFile}`);
  console.log('ok');
  if (await portOpen(port)) throw new Error(`port ${port} is already in use — pass --port=<free port>`);
  // `detached` puts the server in its own process group: `npx` forks the real vite process, so killing the npx
  // pid alone leaves a preview server holding the port for the next run. killTree() kills the group.
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

/** Kill a detached child and everything it spawned. */
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

async function networkReachable() {
  const probes = [
    'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=json',
    'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png',
  ];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    await Promise.any(probes.map((u) => fetch(u, { method: 'HEAD', signal: ctrl.signal })));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ── in-page instrumentation ─────────────────────────────────────────────────────────────────────
/** Installed once per page: frame times, main-thread cost, GPU queue latency, input latency, sim steps. */
function instrument() {
  const d = window.__deluge;
  const I = (window.__perfSuite = {
    frames: [], // [tStart, cpuRenderMs]
    cpu: [], // main-thread ms inside driver.frame
    gpuLat: [],
    steps: [], // [t, substeps, simSecondsAdvanced, throttled]
    inputLat: [],
    pendingInput: null,
    solverPatched: null,
  });
  const r = d.getRenderer();
  const queue = d.app.gpu.device.queue;
  const poseKey = () => {
    const p = r.camera.pose;
    return `${p.target.gx.toFixed(4)},${p.target.gy.toFixed(4)},${p.distance.toFixed(4)},${p.yaw.toFixed(5)},${p.pitch.toFixed(5)}`;
  };
  I.poseKey = poseKey;
  let gpuLatPending = false;
  const origRender = r.render.bind(r);
  r.render = (s) => {
    const t0 = performance.now();
    origRender(s);
    const t1 = performance.now();
    I.frames.push([t0, t1 - t0]);
    // One outstanding fence at a time: the queue latency of a representative frame, not of every frame.
    if (!gpuLatPending) {
      gpuLatPending = true;
      queue.onSubmittedWorkDone().then(() => {
        I.gpuLat.push(performance.now() - t1);
        gpuLatPending = false;
      });
    }
    // Input latency: this frame is the first one whose camera differs from the pose at event time.
    const p = I.pendingInput;
    if (p && poseKey() !== p.pose) {
      I.inputLat.push(t1 - p.t);
      I.pendingInput = null;
    }
  };
  const drv = d.app.driver;
  const origFrame = drv.frame.bind(drv);
  drv.frame = (...a) => {
    const t0 = performance.now();
    const out = origFrame(...a);
    I.cpu.push(performance.now() - t0);
    return out;
  };
  // Trusted pointer events only: Playwright's CDP input is trusted, page-script dispatches are not.
  // `armInput` is set immediately before each measured move and cleared by the first event it catches, so a
  // stray move (the one that positions the cursor before the drag starts, which moves no camera) can never be
  // the sample that is waiting for a pose change.
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!e.isTrusted || !I.armInput) return;
      I.armInput = false;
      I.pendingInput = { t: e.timeStamp, pose: poseKey() };
    },
    true,
  );
  I.patchSolver = () => {
    const solver = d.getSolver();
    if (!solver || I.solverPatched === solver) return;
    I.solverPatched = solver;
    const origStep = solver.step.bind(solver);
    solver.step = (dt) => {
      const info = origStep(dt);
      I.steps.push([performance.now(), info.substeps, info.simSecondsAdvanced, info.throttled ? 1 : 0]);
      return info;
    };
  };
  I.patchSolver();
}

/** Reset the counters and start a measurement window. */
function beginWindow() {
  const I = window.__perfSuite;
  I.patchSolver();
  I.frames.length = 0;
  I.cpu.length = 0;
  I.gpuLat.length = 0;
  I.steps.length = 0;
  I.mark = { t: performance.now(), sim: window.__deluge.getSimClock(), frames: window.__deluge.getFrameCount() };
}

/** Close the measurement window and return the metrics. */
function endWindow() {
  const d = window.__deluge;
  const I = window.__perfSuite;
  const dur = (performance.now() - I.mark.t) / 1000;
  const frames = I.frames.filter(([t]) => t >= I.mark.t);
  const iv = [];
  for (let i = 1; i < frames.length; i++) iv.push(frames[i][0] - frames[i - 1][0]);
  const sorted = [...iv].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : NaN);
  const pctOf = (arr, p) => {
    const s = [...arr].sort((a, b) => a - b);
    return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN;
  };
  const simAdvanced = d.getSimClock() - I.mark.sim;
  const r = d.getRenderer();
  const stats = d.getStats();
  const round = (x, n = 2) => (Number.isFinite(x) ? +x.toFixed(n) : null);
  return {
    seconds: round(dur),
    renderedFrames: frames.length,
    fpsMean: round(frames.length / dur, 1),
    fpsP95Low: round(1000 / pct(0.95), 1),
    p50FrameMs: round(pct(0.5)),
    p95FrameMs: round(pct(0.95)),
    p99FrameMs: round(pct(0.99)),
    maxFrameMs: round(sorted[sorted.length - 1], 1),
    slow34: iv.filter((x) => x > 34).length,
    slow50: iv.filter((x) => x > 50).length,
    slow34Frac: round(iv.filter((x) => x > 34).length / Math.max(1, iv.length), 4),
    slow50Frac: round(iv.filter((x) => x > 50).length / Math.max(1, iv.length), 4),
    simSpeed: round(simAdvanced / dur, 1),
    requestedSpeed: d.getState().sim.timeScale,
    substepsPerFrame: round(I.steps.reduce((a, s) => a + s[1], 0) / Math.max(1, I.steps.length)),
    throttledFrac: round(I.steps.filter((s) => s[3]).length / Math.max(1, I.steps.length), 3),
    cpuFrameMeanMs: round(I.cpu.reduce((a, b) => a + b, 0) / Math.max(1, I.cpu.length)),
    cpuFrameP95Ms: round(pctOf(I.cpu, 0.95)),
    cpuRenderMeanMs: round(frames.reduce((a, f) => a + f[1], 0) / Math.max(1, frames.length)),
    gpuLatMedMs: round(pctOf(I.gpuLat, 0.5), 1),
    gpuLatP90Ms: round(pctOf(I.gpuLat, 0.9), 1),
    appLatencyMs: round(d.app.lastLatencyMs, 1),
    renderScale: round(r.stats.renderScale),
    autoLevel: r.stats.autoLevel,
    budgetCap: d.app.budget.cap,
    budgetMode: d.app.budget.mode,
    maxDepthM: round(stats?.maxDepth ?? NaN),
    floodedKm2: round((stats?.floodedArea ?? NaN) / 1e6, 3),
  };
}

/** Three short drags over the terrain, returning the per-drag latency samples. */
async function measureInputLatency(page, ctx) {
  const pts = await canvasDragPoints(page, ctx);
  await page.evaluate(() => {
    const I = window.__perfSuite;
    I.inputLat.length = 0;
    I.pendingInput = null;
    I.armInput = true;
  });
  const samples = [];
  const a = pts[0];
  for (let drag = 0; drag < 3; drag++) {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.waitForTimeout(150);
    for (let k = 0; k < 5; k++) {
      const before = await page.evaluate(() => {
        const I = window.__perfSuite;
        I.pendingInput = null;
        I.armInput = true;
        return I.inputLat.length;
      });
      await page.mouse.move(a.x + 22 + k * 14, a.y + (k % 2 ? 12 : -12));
      // 300 ms is far beyond any acceptable latency; if nothing lands, the sample is simply missing.
      await page.waitForTimeout(300);
      samples.push(...(await page.evaluate((n) => window.__perfSuite.inputLat.slice(n), before)));
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  }
  await page.evaluate(() => {
    window.__perfSuite.armInput = false;
    window.__perfSuite.pendingInput = null;
  });
  const s = samples.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return {
    samples: s.map((x) => +x.toFixed(1)),
    inputLatMedMs: s.length ? +s[s.length >> 1].toFixed(1) : null,
    inputLatP95Ms: s.length ? +s[Math.min(s.length - 1, Math.floor(s.length * 0.95))].toFixed(1) : null,
  };
}

/** Points inside the canvas that are not covered by UI panels (left-centre of the viewport). */
async function canvasDragPoints(page, ctx) {
  const pts = await page.evaluate(({ w, h }) => {
    const onCanvas = (x, y) => {
      const el = document.elementFromPoint(x, y);
      return !!el && (el.id === 'deluge-canvas' || el.tagName === 'CANVAS' || el.id === 'ui-root');
    };
    const out = [];
    for (const [fx, fy] of [
      [0.3, 0.55],
      [0.38, 0.6],
      [0.46, 0.64],
      [0.54, 0.6],
    ]) {
      const x = Math.round(w * fx);
      const y = Math.round(h * fy);
      if (onCanvas(x, y)) out.push({ x, y });
    }
    return out;
  }, ctx.viewport);
  if (pts.length >= 2) return pts;
  // Fallback: the canvas fills the window, so the left-centre band is terrain even if hit-testing was blocked.
  const { width: w, height: h } = ctx.viewport;
  return [
    { x: Math.round(w * 0.3), y: Math.round(h * 0.55) },
    { x: Math.round(w * 0.38), y: Math.round(h * 0.6) },
    { x: Math.round(w * 0.46), y: Math.round(h * 0.64) },
    { x: Math.round(w * 0.54), y: Math.round(h * 0.6) },
  ];
}

// ── one scenario at one viewport ────────────────────────────────────────────────────────────────
async function runCase(browser, baseUrl, scenarioId, viewportId, opts) {
  const sc = SCENARIOS[scenarioId];
  const vp = VIEWPORTS[viewportId];
  const ctx = { viewport: { w: vp.width, h: vp.height, width: vp.width, height: vp.height } };
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: vp.dpr,
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${m.text()}`);
  });
  // TTI: record performance.now() at the moment __deluge.ready resolves (timeOrigin = navigation start).
  await page.addInitScript(() => {
    const poll = () => {
      const d = window.__deluge;
      if (d && d.ready) d.ready.then(() => (window.__tti = performance.now())).catch(() => {});
      else setTimeout(poll, 4);
    };
    poll();
  });
  const url = sc.url ? new URL(sc.url, baseUrl).href : `${baseUrl}?preset=${sc.preset}`;
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.evaluate(async () => {
    await window.__deluge.ready;
  });
  const ttiPage = await page.evaluate(() => window.__tti ?? null);
  const ttiWallS = (Date.now() - t0) / 1000;
  // In-page time is from navigation start; the wall-clock fallback also contains Playwright's navigation overhead.
  const ttiS = Number.isFinite(ttiPage) ? ttiPage / 1000 : ttiWallS;
  // Camera fly-in + shader warm-up. Nothing measured here is representative.
  await page.waitForTimeout(QUICK ? 2500 : 3500);
  await page.evaluate(instrument);
  const setupInfo = (await sc.setup(page, ctx)) ?? {};
  // Let the scenario reach its working state (stage ramp, rain spin-up, protection analysis).
  await page.waitForTimeout(QUICK ? 1500 : 3000);

  await page.evaluate(beginWindow);
  await page.waitForTimeout(opts.seconds * 1000);
  const main = await page.evaluate(endWindow);

  const input = await measureInputLatency(page, ctx);

  // Sustain: consecutive 20 s chunks, compared first vs last for drift.
  let sustain = null;
  if (opts.sustainS > 0 && sc.sustain) {
    const chunks = [];
    const chunkS = 20;
    for (let i = 0; i < Math.ceil(opts.sustainS / chunkS); i++) {
      await page.evaluate(beginWindow);
      await page.waitForTimeout(chunkS * 1000);
      const c = await page.evaluate(endWindow);
      chunks.push({ chunk: i + 1, ...c });
      process.stdout.write(`   sustain ${(i + 1) * chunkS}s: ${c.fpsMean} fps, p95 ${c.p95FrameMs} ms, ${c.simSpeed}x\n`);
    }
    const a = chunks[0];
    const z = chunks[chunks.length - 1];
    sustain = {
      chunks,
      fpsDriftPct: +(((a.fpsMean - z.fpsMean) / Math.max(1e-6, a.fpsMean)) * 100).toFixed(1),
      simSpeedDriftPct: +(((a.simSpeed - z.simSpeed) / Math.max(1e-6, a.simSpeed)) * 100).toFixed(1),
      p95GrowthMs: +(z.p95FrameMs - a.p95FrameMs).toFixed(2),
    };
  }

  const appErrors = await page.evaluate(() => window.__deluge.errors?.slice?.(0) ?? []);
  await page.close();
  const simSpeedFrac =
    main.requestedSpeed > 0 && Number.isFinite(main.simSpeed) ? +(main.simSpeed / main.requestedSpeed).toFixed(3) : null;
  return {
    scenario: scenarioId,
    scenarioLabel: sc.label,
    viewport: viewportId,
    viewportLabel: vp.label,
    url,
    ttiS: +ttiS.toFixed(2),
    ttiWallS: +ttiWallS.toFixed(2),
    setup: setupInfo,
    ...main,
    ...input,
    simSpeedFrac,
    sustain,
    pageErrors,
    appErrors,
  };
}

// ── threshold evaluation ────────────────────────────────────────────────────────────────────────
function evaluate(row) {
  const checks = [];
  // A scenario may move a target/floor for a metric whose honest expectation differs from the suite default
  // (a 300x run is throttled by design; a live area's TTI is a download). An env var still wins over both.
  const over = SCENARIOS[row.scenario]?.thresholds ?? {};
  const add = (metric, value, opts = {}) => {
    const t = THRESHOLDS[metric];
    if (!t || value === null || value === undefined || !Number.isFinite(value)) return;
    const o = t.envLocked ? {} : (over[metric] ?? {});
    const target = opts.target ?? o.target ?? t.target;
    const floor = opts.floor ?? o.floor ?? t.floor;
    const okTarget = t.dir === 'min' ? value >= target : value <= target;
    const okFloor = t.dir === 'min' ? value >= floor : value <= floor;
    checks.push({
      metric: opts.name ?? metric,
      value,
      target,
      floor,
      dir: t.dir,
      unit: t.unit,
      status: okFloor ? (okTarget ? 'pass' : 'target-miss') : 'floor-miss',
    });
  };
  add('fpsMean', row.fpsMean);
  add('fpsP95Low', row.fpsP95Low);
  add('p50FrameMs', row.p50FrameMs);
  add('p95FrameMs', row.p95FrameMs);
  add('p99FrameMs', row.p99FrameMs);
  add('slow34Frac', row.slow34Frac);
  add('slow50Frac', row.slow50Frac);
  add('cpuFrameP95Ms', row.cpuFrameP95Ms);
  add('gpuLatP90Ms', row.gpuLatP90Ms);
  add('inputLatP95Ms', row.inputLatP95Ms);
  add('ttiS', row.ttiS);
  // The idle scenario runs at the default 60x with no forcing; a scenario that asks for 300x on a 1024² grid
  // is GPU-bound by design, so it is judged on the fraction of the request it achieves.
  if (row.simSpeedFrac !== null) add('simSpeedFrac', row.simSpeedFrac);
  // Absolute sim speed is only meaningful where the scenario asked for more than real time on purpose.
  if (over.simSpeed) add('simSpeed', row.simSpeed);
  if (row.sustain) {
    // Positive = it got worse over the run. Improvement is not a regression.
    add('driftPct', Math.max(0, row.sustain.fpsDriftPct), { name: 'fpsDriftPct' });
    add('simDriftPct', Math.max(0, row.sustain.simSpeedDriftPct), { name: 'simSpeedDriftPct' });
    add('p95GrowthMs', Math.max(0, row.sustain.p95GrowthMs), { name: 'p95GrowthMs' });
  }
  return checks;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const machine = await machineState();
const ALLOW_LOW_POWER = argv['allow-low-power'] === 'true' || process.env.DELUGE_PERF_ALLOW_LOW_POWER === '1';
const advisory = CALIBRATE || process.env.DELUGE_PERF_ADVISORY === '1' || (machine.noisy && !STRICT);
/**
 * Low Power Mode is not noise: macOS caps the GPU clocks, and this machine measured 162x sim speed with it off
 * against 27x with it on — six times the margin of any threshold here. A run in that state cannot tell a
 * regression from a setting, so even the floors are reported rather than fatal, and the banner says so loudly.
 * `--strict` (or --allow-low-power) measures anyway and fails normally.
 */
const lowPowerAdvisory = machine.lowPowerMode && !STRICT && !ALLOW_LOW_POWER;

console.log('\n=== Deluge lag suite ===');
console.log(`machine : ${machine.host} · ${machine.platform} · ${machine.cpus} cores · ${machine.memGB} GB`);
console.log(`power   : ${machine.pmsetBatt.split('\n').slice(-1)[0].trim() || 'unknown'}${machine.lowPowerMode ? ' · LOW POWER MODE ON' : ''}`);
console.log(`load    : ${machine.loadavg.join(' ')}${machine.busyProcesses.length ? ` · busy: ${machine.busyProcesses.join(', ')}` : ''}`);
if (advisory) console.log(`mode    : ADVISORY${CALIBRATE ? ' (--calibrate)' : ''} — target misses are reported, not fatal${machine.noisyReasons.length ? ` (${machine.noisyReasons.join('; ')})` : ''}`);
else console.log('mode    : STRICT — target misses fail the run');
if (lowPowerAdvisory) {
  console.log(
    '\n  ############################################################################\n' +
      '  #  LOW POWER MODE IS ON — these numbers measure the setting, not the app.  #\n' +
      '  #  Turn it off (System Settings > Battery > Low Power Mode: Never), plug   #\n' +
      '  #  in, and re-run. Nothing below can fail the build in this state.         #\n' +
      '  ############################################################################\n',
  );
}

let server = null;
let baseUrl = EXTERNAL_URL;
const distDir = path.join(OUT_DIR, 'dist');
try {
  if (!baseUrl) {
    const s = await buildAndServe(distDir, PORT, path.join(OUT_DIR, 'server.log'));
    server = s.server;
    baseUrl = s.url;
  }
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  console.log(`target  : ${baseUrl}\n`);

  const online = await networkReachable();
  const wanted = argv.scenario
    ? String(argv.scenario).split(',')
    : Object.keys(SCENARIOS).filter((k) => !QUICK || SCENARIOS[k].quick);
  const viewportIds =
    argv.viewport === 'both' || (!argv.viewport && !QUICK) ? ['air', 'wide'] : [String(argv.viewport ?? 'air')];

  const browser = await chromium.launch({
    headless: argv.headed !== 'true',
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });

  const rows = [];
  const skipped = [];
  for (const scenarioId of wanted) {
    const sc = SCENARIOS[scenarioId];
    if (!sc) throw new Error(`unknown scenario "${scenarioId}"; known: ${Object.keys(SCENARIOS).join(', ')}`);
    if (sc.needsNetwork && !online) {
      skipped.push({ scenario: scenarioId, reason: 'offline (no USGS/Esri host reachable)' });
      console.log(`- ${sc.label}: SKIPPED (offline)`);
      continue;
    }
    // A live area is one download; measuring it at two viewports adds minutes and no information.
    for (const viewportId of sc.needsNetwork ? [viewportIds[0]] : viewportIds) {
      process.stdout.write(`- ${sc.label} @ ${VIEWPORTS[viewportId].label} … `);
      const row = await runCase(browser, baseUrl, scenarioId, viewportId, {
        seconds: SECONDS,
        sustainS: SUSTAIN_S,
      });
      row.checks = evaluate(row);
      rows.push(row);
      const worst = row.checks.some((c) => c.status === 'floor-miss')
        ? 'FLOOR MISS'
        : row.checks.some((c) => c.status === 'target-miss')
          ? 'target miss'
          : 'ok';
      console.log(`${row.fpsMean} fps · p95 ${row.p95FrameMs} ms · ${row.simSpeed}x · ${worst}`);
    }
  }
  await browser.close();

  // ── report ────────────────────────────────────────────────────────────────────────────────────
  const pad = (s, n) => String(s ?? '').padEnd(n);
  const padL = (s, n) => String(s ?? '').padStart(n);
  console.log('\n' + pad('scenario', 30) + pad('viewport', 10) + padL('fps', 7) + padL('p95low', 8) + padL('p50', 7) + padL('p95', 7) + padL('p99', 7) + padL('>34', 6) + padL('>50', 6) + padL('sim', 8) + padL('cpu95', 7) + padL('gpuLat', 8) + padL('input', 7) + padL('tti', 7) + '  verdict');
  console.log('-'.repeat(132));
  for (const r of rows) {
    const worst = r.checks.some((c) => c.status === 'floor-miss') ? 'FLOOR MISS' : r.checks.some((c) => c.status === 'target-miss') ? 'target miss' : 'pass';
    console.log(
      pad(r.scenarioLabel, 30) +
        pad(r.viewport, 10) +
        padL(r.fpsMean, 7) +
        padL(r.fpsP95Low, 8) +
        padL(r.p50FrameMs, 7) +
        padL(r.p95FrameMs, 7) +
        padL(r.p99FrameMs, 7) +
        padL(r.slow34, 6) +
        padL(r.slow50, 6) +
        padL(`${r.simSpeed}/${r.requestedSpeed}`, 8) +
        padL(r.cpuFrameP95Ms, 7) +
        padL(r.gpuLatP90Ms, 8) +
        padL(r.inputLatP95Ms ?? '-', 7) +
        padL(r.ttiS, 7) +
        '  ' +
        worst,
    );
  }
  for (const s of skipped) console.log(`${pad(s.scenario, 30)}SKIPPED — ${s.reason}`);

  const misses = [];
  for (const r of rows) {
    for (const c of r.checks) {
      if (c.status !== 'pass') {
        misses.push({ scenario: r.scenario, viewport: r.viewport, ...c });
      }
    }
  }
  if (misses.length) {
    console.log('\nThreshold misses:');
    for (const m of misses) {
      const bound = m.status === 'floor-miss' ? `floor ${m.floor}` : `target ${m.target}`;
      console.log(`  ${m.status === 'floor-miss' ? '!!' : ' ·'} ${m.scenario}/${m.viewport} ${m.metric} = ${m.value}${m.unit} (${m.dir === 'min' ? '>=' : '<='} ${bound}${m.unit})`);
    }
  }
  const sustainRow = rows.find((r) => r.sustain);
  if (sustainRow) {
    const s = sustainRow.sustain;
    console.log(`\nSustain (${sustainRow.scenarioLabel}, ${s.chunks.length * 20}s): fps drift ${s.fpsDriftPct}% · sim-speed drift ${s.simSpeedDriftPct}% · p95 growth ${s.p95GrowthMs} ms`);
  }
  const errRows = rows.filter((r) => r.pageErrors.length || r.appErrors.length);
  for (const r of errRows) {
    console.log(`\nErrors in ${r.scenario}/${r.viewport}:`);
    for (const e of [...r.pageErrors, ...r.appErrors].slice(0, 8)) console.log(`   ${e}`);
  }

  if (CALIBRATE) {
    const agg = (key, how) => {
      const vals = rows.map((r) => r[key]).filter((x) => Number.isFinite(x));
      if (!vals.length) return null;
      return how === 'min' ? Math.min(...vals) : Math.max(...vals);
    };
    console.log('\n[calibrate] measured extremes across all cases (set targets with margin beyond these):');
    console.log(
      JSON.stringify(
        {
          fpsMean_min: agg('fpsMean', 'min'),
          fpsP95Low_min: agg('fpsP95Low', 'min'),
          p50FrameMs_max: agg('p50FrameMs', 'max'),
          p95FrameMs_max: agg('p95FrameMs', 'max'),
          p99FrameMs_max: agg('p99FrameMs', 'max'),
          slow34Frac_max: agg('slow34Frac', 'max'),
          slow50Frac_max: agg('slow50Frac', 'max'),
          simSpeedFrac_min: agg('simSpeedFrac', 'min'),
          cpuFrameP95Ms_max: agg('cpuFrameP95Ms', 'max'),
          gpuLatP90Ms_max: agg('gpuLatP90Ms', 'max'),
          inputLatP95Ms_max: agg('inputLatP95Ms', 'max'),
          ttiS_max: agg('ttiS', 'max'),
        },
        null,
        2,
      ),
    );
  }

  const floorMisses = misses.filter((m) => m.status === 'floor-miss');
  const targetMisses = misses.filter((m) => m.status === 'target-miss');
  const hardErrors = errRows.flatMap((r) => r.pageErrors);
  // A page error is a real bug in any power state; timing floors are not, while Low Power Mode is on.
  const failed = hardErrors.length > 0 || (!lowPowerAdvisory && floorMisses.length > 0) || (!advisory && targetMisses.length > 0);

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        suite: 'perf',
        schema: 'deluge-perf/1',
        date: new Date().toISOString(),
        quick: QUICK,
        advisory,
        lowPowerAdvisory,
        strict: STRICT,
        online,
        machine,
        thresholds: THRESHOLDS,
        seconds: SECONDS,
        sustainSeconds: SUSTAIN_S,
        baseUrl,
        rows,
        skipped,
        misses,
        verdict: failed ? 'FAIL' : (advisory || lowPowerAdvisory) && misses.length ? 'ADVISORY' : 'PASS',
      },
      null,
      2,
    ),
  );
  console.log(`\nJSON: ${path.relative(ROOT, JSON_OUT)}`);

  if (hardErrors.length) console.log(`\nFAIL: ${hardErrors.length} page error(s) during the run.`);
  if (floorMisses.length && lowPowerAdvisory)
    console.log(`\nNOT FATAL: ${floorMisses.length} floor threshold(s) missed with Low Power Mode ON — turn it off and re-run before believing them.`);
  else if (floorMisses.length) console.log(`FAIL: ${floorMisses.length} floor threshold(s) missed — the app is genuinely laggy.`);
  if (targetMisses.length && advisory && !floorMisses.length)
    console.log(
      `ADVISORY: ${targetMisses.length} target threshold(s) missed on a noisy machine (${machine.noisyReasons.join('; ') || 'advisory mode'}). Re-run on AC power with nothing else open before treating this as a regression.`,
    );
  if (!failed && !targetMisses.length) console.log('\nPASS — every threshold met.');
  process.exitCode = CALIBRATE ? 0 : failed ? 1 : 0;
} catch (e) {
  console.error(`\nFAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  killTree(server);
  if (!KEEP_DIST && !EXTERNAL_URL && fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
}
