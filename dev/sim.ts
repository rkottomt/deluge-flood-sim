/**
 * Solver harness: runs the real GPU solver on a synthetic valley (or a baked preset) and draws a top-down
 * colormap of the exported state with a tiny render pass. No renderer / UI modules involved.
 *
 * URL params:
 *   n=512            grid size for the synthetic valley (multiple of 16)
 *   preset=pittsburgh  load public/presets/<id> (elevation + stage sources) instead of the valley
 *   rain=20          global rain, mm/hr          ts=60     time scale (sim s per real s)
 *   mode=robust|naive                            cfl=0.7   Courant number
 *   view=depth|max|speed                         boundary=open|wall
 *   budget=8         solver GPU budget per frame, ms (0 = default)
 *   run=0            sim seconds to fast-forward before showing (via __sim.runFor)
 * Interaction: left-drag draws a 4 m wall, right-click pours water, space pause, N naive/robust, R reset,
 *   1/2/3 views, +/- time scale.
 * Automation: window.__sim = { ready, solver, errors, runFor(simSeconds), stats(), setParams(p), frameMs() }.
 */
import type { SimParams, SimStats, WaterSource } from '../src/contracts';
import { createDelugeDevice } from '../src/gpu';
import { createSolver, type GpuFloodSolver } from '../src/sim';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const str = (k: string, d: string) => q.get(k) ?? d;

const hud = document.getElementById('hud') as HTMLDivElement;
const legend = document.getElementById('legend') as HTMLDivElement;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const errors: string[] = [];
// Installed immediately so automation can await `__sim.ready` before the solver exists; filled in by main().
let readyResolve!: () => void;
let readyReject!: (e: unknown) => void;
const simApi: Record<string, unknown> = {
  ready: new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  }),
  errors,
};
(window as unknown as { __sim: unknown }).__sim = simApi;

interface Scene {
  name: string;
  nx: number;
  ny: number;
  cellSize: number;
  elevation: Float32Array;
  depth: Float32Array;
  sources: WaterSource[];
}

/** Synthetic river valley: meandering channel on a smooth floodplain between noisy hills. */
function valley(n: number): Scene {
  const cellSize = 4096 / n;
  const elevation = new Float32Array(n * n);
  const depth = new Float32Array(n * n);
  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i / n;
      const y = j / n;
      const river = 0.5 + 0.14 * Math.sin(y * 5.5) + 0.03 * Math.sin(y * 17);
      const d = Math.abs(x - river);
      const floor = 140 - 24 * y; // floodplain falls ~6 m/km toward the south
      // Flat floodplain (|d| < 0.06), then hillsides; noise only on the hills.
      const hill = smooth(0.06, 0.4, d);
      let z = floor + 1.2 * smooth(0.0, 0.06, d) + 160 * hill * hill + hill * (7 * Math.sin(x * 23) * Math.cos(y * 19) + 2.5 * Math.sin(x * 71 + y * 53));
      // Channel: 4 m deep, smooth banks.
      z -= 4 * (1 - smooth(0.006, 0.016, d));
      elevation[j * n + i] = z;
      if (d < 0.016) depth[j * n + i] = Math.max(depth[j * n + i], floor + 0.2 - z);
    }
  }
  return {
    name: `synthetic valley ${n}²`,
    nx: n,
    ny: n,
    cellSize,
    elevation,
    depth,
    sources: [{ id: 'river', type: 'inflow', gx: n * 0.5, gy: 3, radius: n / 100, discharge: 250, label: 'river inflow' }],
  };
}

/** Load a baked preset; rivers are filled by a flood fill from the scenario seeds (harness-only version). */
async function preset(id: string): Promise<Scene> {
  const base = `/presets/${id}/`;
  const meta = await (await fetch(base + 'meta.json')).json();
  const elevation = new Float32Array(await (await fetch(base + 'elevation.f32')).arrayBuffer());
  const { nx, ny } = meta;
  const depth = new Float32Array(nx * ny);
  const queue = new Int32Array(nx * ny);
  for (const fill of meta.scenario?.initialFill ?? []) {
    const L: number = fill.level;
    let head = 0;
    let tail = 0;
    for (const s of fill.seeds) {
      const k = Math.floor(s.gy) * nx + Math.floor(s.gx);
      if (k >= 0 && k < nx * ny && elevation[k] < L && depth[k] === 0) {
        depth[k] = L - elevation[k];
        queue[tail++] = k;
      }
    }
    while (head < tail) {
      const k = queue[head++];
      const i = k % nx;
      for (const nb of [i > 0 ? k - 1 : -1, i < nx - 1 ? k + 1 : -1, k - nx, k + nx]) {
        if (nb < 0 || nb >= nx * ny || depth[nb] > 0 || elevation[nb] >= L) continue;
        depth[nb] = L - elevation[nb];
        queue[tail++] = nb;
      }
    }
  }
  return { name: meta.name, nx, ny, cellSize: meta.cellSize, elevation, depth, sources: meta.scenario?.sources ?? [] };
}

const renderWGSL = /* wgsl */ `
struct U { nx: i32, ny: i32, view: i32, _p: i32, zmin: f32, zmax: f32, cell: f32, _q: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var bedTex: texture_2d<f32>;
@group(0) @binding(3) var barrierTex: texture_2d<f32>;

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

@vertex fn vs(@builtin(vertex_index) vi: u32) -> VOut {
  let p = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: VOut;
  o.pos = vec4f(p * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  o.uv = p;
  return o;
}

fn cl(c: vec2i) -> vec2i { return clamp(c, vec2i(0), vec2i(u.nx - 1, u.ny - 1)); }
fn bed(c: vec2i) -> f32 { return textureLoad(bedTex, cl(c), 0).r; }
fn finite(x: f32) -> bool { return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u; }

// Perceptual-ish blue ramp for depth (log scale 1 cm … 8 m).
fn depthColor(h: f32) -> vec3f {
  let t = clamp(log(max(h, 0.01) / 0.01) / log(800.0), 0.0, 1.0);
  return mix(mix(vec3f(0.62, 0.86, 0.98), vec3f(0.16, 0.52, 0.86), smoothstep(0.0, 0.55, t)), vec3f(0.03, 0.12, 0.40), smoothstep(0.5, 1.0, t));
}
// Speed ramp 0 … 5 m/s (dark blue → teal → yellow → red).
fn speedColor(s: f32) -> vec3f {
  let t = clamp(s / 5.0, 0.0, 1.0);
  let a = mix(vec3f(0.10, 0.15, 0.45), vec3f(0.10, 0.70, 0.70), smoothstep(0.0, 0.35, t));
  let b = mix(a, vec3f(0.98, 0.85, 0.20), smoothstep(0.3, 0.7, t));
  return mix(b, vec3f(0.90, 0.20, 0.15), smoothstep(0.7, 1.0, t));
}

@fragment fn fs(in: VOut) -> @location(0) vec4f {
  let c = cl(vec2i(floor(in.uv * vec2f(f32(u.nx), f32(u.ny)))));
  let z = bed(c);
  let dzdx = (bed(c + vec2i(1, 0)) - bed(c - vec2i(1, 0))) / (2.0 * u.cell);
  let dzdy = (bed(c + vec2i(0, 1)) - bed(c - vec2i(0, 1))) / (2.0 * u.cell);
  let nrm = normalize(vec3f(-dzdx, -dzdy, 1.0));
  let shade = clamp(dot(nrm, normalize(vec3f(-1.0, -1.0, 1.2))), 0.0, 1.0) * 0.85 + 0.2;
  let t = clamp((z - u.zmin) / max(u.zmax - u.zmin, 1e-3), 0.0, 1.0);
  var col = mix(vec3f(0.23, 0.30, 0.20), vec3f(0.66, 0.60, 0.50), t) * shade;
  if (textureLoad(barrierTex, c, 0).r > 0.05) { col = vec3f(0.85, 0.52, 0.22) * shade; }

  let s = textureLoad(stateTex, c, 0);
  if (!finite(s.r) || !finite(s.g) || !finite(s.b) || s.r < 0.0 || s.r > 1e4) {
    return vec4f(1.0, 0.0, 0.85, 1.0); // blown up (naive mode)
  }
  var h = s.r;
  if (u.view == 1) { h = s.a; }
  if (h > 0.003) {
    var w = depthColor(h);
    if (u.view == 2) { w = speedColor(length(s.gb)); }
    let a = smoothstep(0.003, 0.08, h) * 0.88;
    col = mix(col, w * (0.75 + 0.25 * shade), a);
  }
  return vec4f(col, 1.0);
}
`;

async function main() {
  if (!('gpu' in navigator)) throw new Error('WebGPU not available');
  const { device, description, timestampQuery } = await createDelugeDevice(navigator.gpu);
  device.onuncapturederror = (ev) => {
    const msg = (ev as GPUUncapturedErrorEvent).error.message;
    errors.push(msg);
    console.error('[webgpu]', msg);
  };
  void device.lost.then((info) => {
    errors.push(`device lost: ${info.message}`);
    console.error('[webgpu] device lost', info.message);
  });

  const presetId = q.get('preset');
  const scene = presetId ? await preset(presetId) : valley(num('n', 512));
  const params: Partial<SimParams> = {
    rainRate: num('rain', 20),
    timeScale: num('ts', 60),
    cfl: num('cfl', str('mode', 'robust') === 'naive' ? 1.8 : 0.7),
    stabilityMode: str('mode', 'robust') === 'naive' ? 'naive' : 'robust',
    boundary: str('boundary', 'open') === 'wall' ? 'wall' : 'open',
    maxSubstepsPerFrame: 400,
  };
  const solver: GpuFloodSolver = await createSolver(device, scene, params);
  if (num('budget', 0) > 0) solver.gpuBudgetMs = num('budget', 8);
  solver.setInitialWater(scene.depth);
  solver.setSources(scene.sources);

  // ── Canvas + render pipeline ──
  const format = navigator.gpu.getPreferredCanvasFormat();
  const ctx = canvas.getContext('webgpu') as GPUCanvasContext;
  ctx.configure({ device, format, alphaMode: 'opaque' });
  const resize = () => {
    const side = Math.max(64, Math.min(innerWidth, innerHeight) - 24);
    const w = scene.nx >= scene.ny ? side : (side * scene.nx) / scene.ny;
    const h = scene.nx >= scene.ny ? (side * scene.ny) / scene.nx : side;
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    canvas.width = Math.round(w * devicePixelRatio);
    canvas.height = Math.round(h * devicePixelRatio);
  };
  resize();
  addEventListener('resize', resize);

  const module = device.createShaderModule({ label: 'dev.sim.render', code: renderWGSL });
  const tex = (binding: number): GPUBindGroupLayoutEntry => ({
    binding,
    visibility: GPUShaderStage.FRAGMENT,
    texture: { sampleType: 'unfilterable-float' },
  });
  const layout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, tex(1), tex(2), tex(3)],
  });
  const pipeline = device.createRenderPipeline({
    label: 'dev.sim.render',
    layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  let zmin = Infinity;
  let zmax = -Infinity;
  for (const z of scene.elevation) {
    zmin = Math.min(zmin, z);
    zmax = Math.max(zmax, z);
  }
  const uBuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const uData = new ArrayBuffer(32);
  const views = { depth: 0, max: 1, speed: 2 } as const;
  let view: number = views[str('view', 'depth') as keyof typeof views] ?? 0;
  // stateTexture ping-pongs: one bind group per texture object.
  const bindGroups = new Map<GPUTexture, GPUBindGroup>();
  const bindGroupFor = (t: GPUTexture) => {
    let bg = bindGroups.get(t);
    if (!bg) {
      bg = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: uBuf } },
          { binding: 1, resource: t.createView() },
          { binding: 2, resource: solver.bedTexture.createView() },
          { binding: 3, resource: solver.barrierTexture.createView() },
        ],
      });
      bindGroups.set(t, bg);
    }
    return bg;
  };

  // ── Interaction ──
  let paused = false;
  let wallFrom: { gx: number; gy: number } | null = null;
  const toGrid = (e: PointerEvent | MouseEvent) => {
    const r = canvas.getBoundingClientRect();
    return { gx: ((e.clientX - r.left) / r.width) * scene.nx, gy: ((e.clientY - r.top) / r.height) * scene.ny };
  };
  const wallRadius = Math.max(0.8, 3 / scene.cellSize);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    const p = toGrid(e);
    if (e.button === 2) {
      solver.applyBrush({ kind: 'water', gx: p.gx, gy: p.gy, radius: 12, amount: 3 });
    } else if (e.button === 0) {
      wallFrom = p;
      canvas.setPointerCapture(e.pointerId);
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!wallFrom) return;
    const p = toGrid(e);
    if (Math.hypot(p.gx - wallFrom.gx, p.gy - wallFrom.gy) < 1) return;
    solver.applyBrush({ kind: 'wall', ax: wallFrom.gx, ay: wallFrom.gy, bx: p.gx, by: p.gy, radius: wallRadius, height: 4 });
    wallFrom = p;
  });
  canvas.addEventListener('pointerup', () => (wallFrom = null));
  addEventListener('keydown', (e) => {
    if (e.key === ' ') paused = !paused;
    else if (e.key === 'r') solver.reset();
    else if (e.key === 'n') setParams(solver.params.stabilityMode === 'naive' ? { stabilityMode: 'robust', cfl: 0.7 } : { stabilityMode: 'naive', cfl: 1.8 });
    else if (e.key >= '1' && e.key <= '3') view = Number(e.key) - 1;
    else if (e.key === '+' || e.key === '=') setParams({ timeScale: Math.min(3600, solver.params.timeScale * 2) });
    else if (e.key === '-') setParams({ timeScale: Math.max(1, solver.params.timeScale / 2) });
  });
  function setParams(p: Partial<SimParams>) {
    const wasNaive = solver.params.stabilityMode === 'naive';
    solver.params = { ...solver.params, ...p };
    // Leaving the stability demo: the blown-up state is discarded, like the app does.
    if (wasNaive && solver.params.stabilityMode === 'robust') solver.reset();
  }

  // ── Frame loop ──
  let last = performance.now();
  const frameTimes: number[] = [];
  let lastInfo = solver.step(0);
  let lastHud = 0;
  let runTarget: { t: number; resolve: () => void; ts: number } | null = null;
  let frames = 0;

  const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : `<span class="bad">${x}</span>`);
  const updateHud = (s: SimStats | null) => {
    const ft = frameTimes.slice(-60);
    const avg = ft.length ? ft.reduce((a, b) => a + b, 0) / ft.length : 0;
    const naive = solver.params.stabilityMode === 'naive';
    const lines = [
      `<b>${scene.name}</b>  ${scene.nx}×${scene.ny} @ ${scene.cellSize.toFixed(2)} m`,
      `${description}${timestampQuery ? ' (timestamps)' : ''}`,
      `mode ${naive ? '<span class="bad">NAIVE (reference scheme)</span>' : '<span class="ok">robust</span>'}  cfl ${solver.params.cfl}  ${solver.params.boundary}  rain ${solver.params.rainRate} mm/h`,
      `fps ${(avg > 0 ? 1000 / avg : 0).toFixed(0)}  ${paused ? 'PAUSED' : `×${solver.params.timeScale}`}  substeps ${lastInfo.substeps}${lastInfo.throttled ? ' (throttled)' : ''}  dt ${lastInfo.dt.toFixed(3)} s`,
      `gpu ${solver.gpuMsPerSubstep.toFixed(3)} ms/substep  budget ${solver.gpuBudgetMs} ms  readback ${solver.readbackDiagnostics.processMs.toFixed(2)} ms`,
    ];
    if (s) {
      const bad = s.massError > 1e-3 || !Number.isFinite(s.massError);
      lines.push(
        `T+${new Date(s.simTime * 1000).toISOString().slice(11, 19)}  volume ${(s.volume / 1e6).toFixed(4)} hm³`,
        `in ${(s.volumeIn / 1e6).toFixed(4)}  out ${(s.volumeOut / 1e6).toFixed(4)} hm³  mass error <span class="${bad ? 'bad' : 'ok'}">${
          Number.isFinite(s.massError) ? (s.massError * 100).toFixed(5) + ' %' : s.massError
        }</span>`,
        `max depth ${fmt(s.maxDepth)} m  max speed ${fmt(s.maxSpeed)} m/s  Courant ${fmt(s.courant)}`,
        `wet ${(s.wetArea / 1e6).toFixed(3)} km²  newly flooded ${(s.floodedArea / 1e6).toFixed(3)} km²`,
      );
      if (solver.readbackDiagnostics.nonFiniteCells > 0) lines.push(`<span class="bad">${solver.readbackDiagnostics.nonFiniteCells} non-finite cells — press R</span>`);
    }
    hud.innerHTML = lines.join('\n');
    legend.textContent = `view: ${['depth', 'max depth', 'speed'][view]} (1/2/3)\nleft-drag wall · right-click water\nspace pause · N naive · R reset · +/- speed`;
  };

  const frame = () => {
    const t = performance.now();
    const realDt = Math.min(0.1, (t - last) / 1000);
    frameTimes.push(t - last);
    if (frameTimes.length > 240) frameTimes.splice(0, 120);
    last = t;
    if (!paused || runTarget) lastInfo = solver.step(realDt);

    const dv = new DataView(uData);
    dv.setInt32(0, scene.nx, true);
    dv.setInt32(4, scene.ny, true);
    dv.setInt32(8, view, true);
    dv.setFloat32(16, zmin, true);
    dv.setFloat32(20, zmax, true);
    dv.setFloat32(24, scene.cellSize, true);
    device.queue.writeBuffer(uBuf, 0, uData);
    const enc = device.createCommandEncoder({ label: 'dev.sim.frame' });
    const pass = enc.beginRenderPass({
      colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroupFor(solver.stateTexture));
    pass.draw(3);
    pass.end();
    device.queue.submit([enc.finish()]);

    const snap = solver.getSnapshot();
    if (t - lastHud > 250) {
      lastHud = t;
      updateHud(snap?.stats ?? null);
    }
    if (runTarget && solver.time >= runTarget.t) {
      solver.params = { ...solver.params, timeScale: runTarget.ts };
      runTarget.resolve();
      runTarget = null;
    }
    if (++frames === 3) readyResolve();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  Object.assign(simApi, {
    solver,
    stats: () => solver.getSnapshot()?.stats ?? null,
    diagnostics: () => ({ ...solver.readbackDiagnostics, gpuMsPerSubstep: solver.gpuMsPerSubstep, lastInfo }),
    setParams,
    frameMs: () => {
      const ft = frameTimes.slice(-120);
      return ft.reduce((a, b) => a + b, 0) / Math.max(1, ft.length);
    },
    runFor: (simSeconds: number) =>
      new Promise<void>((resolve) => {
        const ts = solver.params.timeScale;
        solver.params = { ...solver.params, timeScale: 3600 };
        runTarget = { t: solver.time + simSeconds, resolve, ts };
      }),
  });
  const run = num('run', 0);
  if (run > 0) await (simApi.runFor as (s: number) => Promise<void>)(run);
}

main().catch((e) => {
  hud.textContent = `error: ${e?.message ?? e}`;
  console.error(e);
  readyReject(e);
});
