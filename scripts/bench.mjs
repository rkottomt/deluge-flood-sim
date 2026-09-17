#!/usr/bin/env node
/**
 * Deluge performance benchmark (headless Chromium on the real Apple GPU).
 *
 *   npm run demo                            (production build served on http://localhost:4173/), then:
 *   node scripts/bench.mjs --scenario=idle|pgh|johnstown [--w=1600 --h=1000 --dpr=1] [--seconds=20]
 *        [--cap30] [--url=http://localhost:4173/] [--label=before] [--shot=path.png] [--sustain=600]
 *
 * --url must end with "/" (the script appends ?preset=…). The MacBook Air demo size is --w=1470 --h=956 --dpr=2.
 *
 * Prints one JSON report line (prefixed "[report]") with fps, frame-time percentiles, achieved sim speed,
 * GPU ms split (renderer prep/main/post via timestamp queries, solver ms/substep via the solver's budget probe).
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const W = Number(args.w ?? 1600);
const H = Number(args.h ?? 1000);
const DPR = Number(args.dpr ?? 1);
const SECONDS = Number(args.seconds ?? 20);
const SCENARIO = String(args.scenario ?? 'pgh');
const URL0 = String(args.url ?? 'http://localhost:4173/');
const LABEL = String(args.label ?? '');
const CAP30 = args.cap30 === 'true';
const SUSTAIN = Number(args.sustain ?? 0);
const SLOW = Number(args.slow ?? 0); // inject artificial main-thread ms per frame during a phase

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: DPR });
const logs = [];
page.on('console', (m) => {
  const t = m.text();
  logs.push(`[${m.type()}] ${t}`);
  if (m.type() === 'error' || m.type() === 'warning' || /deluge\]/.test(t)) console.log(`[console.${m.type()}] ${t.slice(0, 300)}`);
});
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));

if (CAP30) {
  // Chrome Energy Saver: rAF callbacks at most every other 60 Hz vsync (~30 fps).
  await page.addInitScript(() => {
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    let queue = new Map();
    let nextId = 1;
    let scheduled = false;
    let lastFire = -1e9;
    const pump = (t) => {
      if (t - lastFire < 33.33 - 6) {
        raf(pump);
        return;
      }
      lastFire = t;
      scheduled = false;
      const q = queue;
      queue = new Map();
      for (const cb of q.values()) cb(t);
    };
    window.requestAnimationFrame = (cb) => {
      const id = nextId++;
      queue.set(id, cb);
      if (!scheduled) {
        scheduled = true;
        raf(pump);
      }
      return id;
    };
    window.cancelAnimationFrame = (id) => {
      queue.delete(id);
    };
    void caf;
  });
}

const preset = SCENARIO === 'johnstown' ? 'johnstown' : 'pittsburgh';
await page.goto(`${URL0}?preset=${preset}`, { waitUntil: 'load', timeout: 120000 });
const tReady0 = Date.now();
if (args.noblur) await page.addStyleTag({ content: '*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}' });
if (args.hideui) await page.addStyleTag({ content: '#ui-root{display:none!important}' });
await page.evaluate(async () => {
  await window.__deluge.ready;
});
const readyS = (Date.now() - tReady0) / 1000;
await page.waitForTimeout(3000); // camera fly-in + shader warm-up
if (args.quality) await page.evaluate((q) => window.__deluge.getRenderer().setQuality(q), String(args.quality));
if (args.notimer) await page.evaluate(() => { window.__deluge.getRenderer().timer.querySet = null; });
if (args.skip) await page.evaluate((k) => k.split(',').forEach((x) => window.__deluge.getRenderer().debugSkip.add(x)), String(args.skip));

/** Installs in-page instrumentation (frame times, substeps, latency) and returns nothing. */
await page.evaluate(() => {
  const d = window.__deluge;
  const I = (window.__perf = { frames: [], steps: [], lat: [], caps: [], installedSolver: null });
  const r = d.getRenderer();
  const origRender = r.render.bind(r);
  const q = d.app.gpu.device.queue;
  I.latPending = false;
  I.gpuLat = [];
  r.render = (s) => {
    const t0 = performance.now();
    origRender(s);
    const t1 = performance.now();
    I.frames.push([t0, t1 - t0]);
    if (!I.latPending) {
      I.latPending = true;
      q.onSubmittedWorkDone().then(() => {
        I.gpuLat.push(performance.now() - t1);
        I.latPending = false;
      });
    }
  };
  I.cpu = [];
  const drv = d.app.driver;
  const origFrame = drv.frame.bind(drv);
  drv.frame = (a, b, c) => {
    const t0 = performance.now();
    const r0 = origFrame(a, b, c);
    I.cpu.push(performance.now() - t0);
    return r0;
  };
  I.patchSolver = () => {
    const solver = d.getSolver();
    if (!solver || I.installedSolver === solver) return;
    I.installedSolver = solver;
    const orig = solver.step.bind(solver);
    solver.step = (dt) => {
      const info = orig(dt);
      I.steps.push([performance.now(), info.substeps, info.simSecondsAdvanced, info.throttled ? 1 : 0, dt]);
      return info;
    };
    // Enable the solver's own GPU timestamp probe (budget so large it never limits): gives GPU ms per substep.
    solver.gpuBudgetMs = 1e7;
  };
  I.patchSolver();
  I.sampler = setInterval(() => {
    const app = d.app;
    I.caps.push([performance.now(), app.budget.cap, app.budget.mode, app.lastLatencyMs, d.getRenderer().stats.autoLevel, app.frameCeiling.floorMs]);
  }, 250);
});

async function setup() {
  if (SCENARIO === 'idle') {
    return {};
  }
  if (SCENARIO === 'pgh') {
    return page.evaluate(() => {
      const d = window.__deluge;
      const off = d.stageOffsetForFeet(46);
      const s = d.getSolver();
      const snap = s.getSnapshot();
      const initial = snap ? Float32Array.from(snap.depth) : null;
      // Downtown Pittsburgh (Golden Triangle) box.
      const a = d.geoToGrid(-80.0125, 40.4455);
      const b = d.geoToGrid(-79.9950, 40.4365);
      window.__perf.box = { x0: Math.floor(Math.min(a.gx, b.gx)), x1: Math.ceil(Math.max(a.gx, b.gx)), y0: Math.floor(Math.min(a.gy, b.gy)), y1: Math.ceil(Math.max(a.gy, b.gy)) };
      window.__perf.initial = initial;
      d.setRain(50);
      d.setTimeScale(1200);
      d.setStageOffset(off);
      window.__perf.t0 = performance.now();
      window.__perf.sim0 = d.getSimClock();
      return { off, box: window.__perf.box };
    });
  }
  if (SCENARIO === 'johnstown') {
    return page.evaluate(() => {
      const d = window.__deluge;
      const sc = d.getScenario();
      const src = sc.sources.filter((s) => s.type === 'inflow');
      for (const s of src) d.addSource({ ...s, id: `${s.id}-big`, discharge: s.discharge * 3 });
      d.setRain(50);
      d.setTimeScale(1200);
      window.__perf.t0 = performance.now();
      window.__perf.sim0 = d.getSimClock();
      return { added: src.length };
    });
  }
  throw new Error(`unknown scenario ${SCENARIO}`);
}

const setupInfo = await setup();
if (args.fixed) {
  await page.evaluate((k) => {
    const d = window.__deluge;
    d.setAdaptiveBudget(false);
    d.store.set({ sim: { ...d.getState().sim, maxSubstepsPerFrame: k } });
  }, Number(args.fixed));
}

/** Downtown flood fraction over time (pgh only): cells in the box dry at start with depth > 0.3 m. */
async function floodTrack(maxMs) {
  return page.evaluate(async (maxMs) => {
    const d = window.__deluge;
    const P = window.__perf;
    const out = [];
    const t0 = P.t0;
    const { x0, x1, y0, y1 } = P.box;
    const nx = d.getSolver().nx;
    const series = [];
    while (performance.now() - t0 < maxMs) {
      await new Promise((r) => setTimeout(r, 250));
      const snap = d.getSolver().getSnapshot();
      if (!snap) continue;
      let land = 0;
      let flooded = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const k = y * nx + x;
          if (P.initial && P.initial[k] > 0.01) continue;
          land++;
          if (snap.depth[k] > 0.3) flooded++;
        }
      series.push([(performance.now() - t0) / 1000, d.getSimClock() - P.sim0, land ? flooded / land : 0, snap.stats.floodedArea]);
    }
    return series;
  }, maxMs);
}

async function measure(ms, tag) {
  await page.evaluate(() => {
    const P = window.__perf;
    P.patchSolver();
    P.frames = [];
    P.cpu = [];
    P.gpuLat = [];
    P.steps = [];
    P.caps = [];
    P.m0 = { t: performance.now(), sim: window.__deluge.getSimClock(), frames: window.__deluge.getFrameCount() };
  });
  await page.waitForTimeout(ms);
  return page.evaluate((tag) => {
    const d = window.__deluge;
    const P = window.__perf;
    const t1 = performance.now();
    const dur = (t1 - P.m0.t) / 1000;
    const fr = P.frames.filter(([t]) => t >= P.m0.t);
    const iv = [];
    for (let i = 1; i < fr.length; i++) iv.push(fr[i][0] - fr[i - 1][0]);
    iv.sort((a, b) => a - b);
    const pct = (p) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(iv.length * p))] : NaN);
    const mean = iv.reduce((a, b) => a + b, 0) / Math.max(1, iv.length);
    const cpuRender = fr.reduce((a, [, c]) => a + c, 0) / Math.max(1, fr.length);
    const steps = P.steps;
    const substeps = steps.reduce((a, s) => a + s[1], 0);
    const simAdv = d.getSimClock() - P.m0.sim;
    const r = d.getRenderer();
    const solver = d.getSolver();
    const msSub = solver.gpuMsPerSubstep;
    const subPerFrame = substeps / Math.max(1, steps.length);
    const caps = P.caps;
    const capMean = caps.reduce((a, c) => a + c[1], 0) / Math.max(1, caps.length);
    const lat = caps.map((c) => c[3]).sort((a, b) => a - b);
    const st = d.getStats();
    return {
      tag,
      seconds: +dur.toFixed(2),
      renderedFrames: fr.length,
      fps: +(fr.length / dur).toFixed(1),
      meanFrameMs: +mean.toFixed(2),
      p50FrameMs: +pct(0.5).toFixed(2),
      p95FrameMs: +pct(0.95).toFixed(2),
      p99FrameMs: +pct(0.99).toFixed(2),
      maxFrameMs: +(iv[iv.length - 1] ?? NaN).toFixed(1),
      simSpeed: +(simAdv / dur).toFixed(1),
      requested: d.getState().sim.timeScale,
      substepsPerFrame: +subPerFrame.toFixed(2),
      dt: steps.length ? +steps[steps.length - 1][4].toFixed(3) : null,
      throttledFrac: +(steps.filter((s) => s[3]).length / Math.max(1, steps.length)).toFixed(2),
      capMean: +capMean.toFixed(1),
      latencyMedMs: +(lat[lat.length >> 1] ?? NaN).toFixed(1),
      gpuLatMed: (() => { const g = [...P.gpuLat].sort((a, b) => a - b); return +(g[g.length >> 1] ?? NaN).toFixed(1); })(),
      gpuLatP90: (() => { const g = [...P.gpuLat].sort((a, b) => a - b); return +(g[Math.floor(g.length * 0.9)] ?? NaN).toFixed(1); })(),
      gpu: {
        prep: +r.stats.prepMs.toFixed(2),
        main: +r.stats.mainMs.toFixed(2),
        post: +r.stats.postMs.toFixed(2),
        renderTotal: +r.stats.gpuMs.toFixed(2),
        solverMsPerSubstep: +msSub.toFixed(3),
        solverPerFrame: +(msSub * (subPerFrame + 0.5)).toFixed(2),
      },
      cpuRenderMs: +cpuRender.toFixed(2),
      cpuFrameMean: +(P.cpu.reduce((a, b) => a + b, 0) / Math.max(1, P.cpu.length)).toFixed(2),
      cpuFrameP95: +([...P.cpu].sort((a, b) => a - b)[Math.floor(P.cpu.length * 0.95)] ?? NaN).toFixed(2),
      render: { w: r.stats.width, h: r.stats.height, scale: +r.stats.renderScale.toFixed(2), autoLevel: r.stats.autoLevel, lodNodes: r.lodStats?.nodes },
      frameFloorMs: d.app.frameCeiling.floorMs,
      budgetMode: d.app.budget.mode,
      capSeries: caps.filter((_, i) => i % 2 === 0).map((c) => `${c[1]}@${c[3].toFixed(0)}`).join(' '),
      maxDepth: st ? +st.maxDepth.toFixed(2) : null,
      courant: st ? +st.courant.toFixed(2) : null,
      solverDt: +solver.computeDt().toFixed(3),
      floodedKm2: st ? +(st.floodedArea / 1e6).toFixed(3) : null,
      massError: st ? st.massError : null,
    };
  }, tag);
}

const report = { label: LABEL, scenario: SCENARIO, viewport: `${W}x${H}@${DPR}`, cap30: CAP30, readyS, setup: setupInfo, phases: [] };

if (SCENARIO === 'pgh') {
  // Time-to-flood tracking during the first 40 s, while measuring frames.
  const trackP = floodTrack(Math.max(SECONDS, 40) * 1000);
  report.phases.push(await measure(10000, 'rise-0-10s'));
  const series = await trackP;
  const at = (frac) => series.find((s) => s[2] >= frac);
  const final = series[series.length - 1];
  report.flood = {
    finalFrac: final ? +final[2].toFixed(3) : null,
    finalSim: final ? +final[1].toFixed(0) : null,
    t10: at(0.1)?.[0] ?? null,
    t25: at(0.25)?.[0] ?? null,
    t50: at(0.5)?.[0] ?? null,
    series: series.filter((_, i) => i % 4 === 0).map((s) => [+s[0].toFixed(2), +s[1].toFixed(0), +s[2].toFixed(3)]),
  };
  report.phases.push(await measure(SECONDS * 1000, 'steady'));
} else {
  report.phases.push(await measure(SECONDS * 1000, 'steady'));
}

if (SUSTAIN > 0) {
  const chunks = Math.ceil(SUSTAIN / 60);
  for (let i = 0; i < chunks; i++) {
    const p = await measure(60000, `sustain-${i + 1}min`);
    report.phases.push(p);
    console.log(JSON.stringify({ tag: p.tag, fps: p.fps, p95: p.p95FrameMs, speed: p.simSpeed, cap: p.capMean, auto: p.render.autoLevel, gpu: p.gpu }));
  }
}

const GPUSLOW = Number(args.gpuslow ?? 0);
if (GPUSLOW > 0) {
  // Emulate a thermally throttled GPU: extra useless compute work every frame (about GPUSLOW ms on this M4).
  await page.evaluate((k) => {
    const d = window.__deluge;
    const dev = d.app.gpu.device;
    const tex = dev.createTexture({ size: [1024, 1024], format: 'r32float', usage: GPUTextureUsage.STORAGE_BINDING });
    const mod = dev.createShaderModule({ code: `@group(0) @binding(0) var o: texture_storage_2d<r32float, write>;
      @compute @workgroup_size(16, 16) fn main(@builtin(global_invocation_id) id: vec3u) {
        var x = f32(id.x) * 0.001; for (var i = 0; i < 24; i++) { x = sin(x * 1.7 + f32(id.y)) * cos(x); }
        textureStore(o, vec2i(id.xy), vec4f(x)); }` });
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: tex.createView() }] });
    const r = d.getRenderer();
    const prev = r.render;
    window.__perf.ungpuslow = () => (r.render = prev);
    window.__perf.gpuslowK = k;
    r.render = (s) => {
      const enc = dev.createCommandEncoder();
      const p = enc.beginComputePass();
      p.setPipeline(pipe);
      p.setBindGroup(0, bg);
      for (let i = 0; i < window.__perf.gpuslowK; i++) p.dispatchWorkgroups(64, 64);
      p.end();
      dev.queue.submit([enc.finish()]);
      prev(s);
    };
  }, GPUSLOW);
  report.phases.push(await measure(10000, `gpuslow${GPUSLOW}-0-10s`));
  report.phases.push(await measure(20000, `gpuslow${GPUSLOW}-10-30s`));
  await page.evaluate(() => window.__perf.ungpuslow());
  report.phases.push(await measure(10000, 'gpu-recover-0-10s'));
  report.phases.push(await measure(20000, 'gpu-recover-10-30s'));
}

if (SLOW > 0) {
  // Artificially slow frames (main-thread busy wait inside render) → governor/adaptive-quality reaction.
  await page.evaluate((slow) => {
    const r = window.__deluge.getRenderer();
    const prev = r.render;
    window.__perf.unslow = () => (r.render = prev);
    r.render = (s) => {
      const t = performance.now();
      while (performance.now() - t < slow);
      prev(s);
    };
  }, SLOW);
  report.phases.push(await measure(8000, `slow${SLOW}-0-8s`));
  report.phases.push(await measure(8000, `slow${SLOW}-8-16s`));
  await page.evaluate(() => window.__perf.unslow());
  report.phases.push(await measure(8000, 'recover-0-8s'));
  report.phases.push(await measure(12000, 'recover-8-20s'));
}

if (args.shot) {
  fs.mkdirSync(path.dirname(String(args.shot)), { recursive: true });
  await page.screenshot({ path: String(args.shot) });
}
const errs = await page.evaluate(() => window.__deluge.errors?.map?.((e) => e.message ?? String(e)) ?? []);
report.errors = errs;
console.log('[report]', JSON.stringify(report));
if (args.out) fs.writeFileSync(String(args.out), JSON.stringify(report, null, 2));
await browser.close();
