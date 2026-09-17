/**
 * Renderer harness.
 *
 * Two scene sources:
 *   • default: synthetic valley + MockFloodSolver (animated analytic water, no solver needed)
 *   • preset=<id>: a real baked preset (src/data) driven by the real GPU solver (src/sim), with real routing
 *
 * URL params:
 *   mode=realistic|depth|maxDepth|velocity   exag=1.5   rain=0 (mm/hr)   quality=auto|high|balanced|low
 *   cam=overview|grazing|top|shore|wall|creek|town (mock) | scenario|top|point|low (preset)
 *       or yaw= pitch= dist= gx= gy= elev=
 *   overlays=1 roads=1 imagery=1 contours=0 route=ok|blocked|none  hud=1
 *   mock only:   n=512|1024|2048   stage=<m> (fixed; default animates)   t=<s> freeze animation at this time
 *   preset only: stage=<m above normal pool>   run=<sim seconds to pre-run>   evac=gx,gy   timescale=60
 * Interaction: drag to orbit, right-drag pan, wheel zoom; shift+click drops wall segments under the cursor;
 *   keys 1-4 water modes, R rain, C contours, I imagery, O overlays, F frame all, T top-down, Q cycle quality.
 * Automation: window.__renderReady (Promise), window.__perf(ms) (rAF frame times), window.__bench(frames)
 *   (unthrottled GPU throughput), window.__pick(x, y), window.__renderer, window.__errors.
 */
import type {
  CameraPose,
  FloodSolver,
  OverlayState,
  RoadStatusArray,
  RouteResult,
  TerrainData,
  WaterSource,
  WaterViewMode,
} from '../src/contracts';
import { createDelugeDevice } from '../src/gpu';
import { createRenderer, type DelugeRendererAPI, type RendererQuality } from '../src/render';
import { createMockScene } from './render.mockSolver';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const flag = (k: string, d: boolean) => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' : d);

const hud = document.getElementById('hud')!;
if (!flag('hud', true)) hud.classList.add('hidden');

interface PerfResult {
  frames: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
  fps: number;
  width: number;
  height: number;
  gpu?: unknown;
}

declare global {
  interface Window {
    __renderReady: Promise<void>;
    __perf: (ms: number) => Promise<PerfResult>;
    __bench: (frames: number) => Promise<{ frames: number; msPerFrame: number; fps: number; gpu: unknown }>;
    __pick: (x: number, y: number) => unknown;
    __renderer: DelugeRendererAPI;
    __errors: string[];
    /** Change harness settings without reloading (automation). */
    __set: (o: {
      mode?: WaterViewMode;
      rain?: number;
      contours?: boolean;
      imagery?: boolean;
      overlays?: boolean;
      cam?: string;
      pose?: Partial<CameraPose> & { target?: Partial<CameraPose['target']> };
      exag?: number;
    }) => void;
    /** Replace the scene with a new mock scene (exercises setScene/dispose); resolves after a few frames. */
    __swap: (o: { n?: number; imagery?: boolean; roads?: boolean }) => Promise<string>;
  }
}
window.__errors = [];
let resolveReady!: () => void;
window.__renderReady = new Promise((r) => (resolveReady = r));

/** What a scene source provides to the shared frame loop. */
interface HarnessScene {
  terrain: TerrainData;
  solver: FloodSolver;
  cameras: Record<string, CameraPose>;
  /** Advance the scene by real seconds (may be 0). */
  tick(dt: number): void;
  /** Overlays for the current frame (without cursor). */
  overlays(): Omit<OverlayState, 'cursor'>;
  status(): string;
  /** Initial cursor ring. */
  cursor: OverlayState['cursor'];
}

async function main() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  if (!navigator.gpu) throw new Error('WebGPU not available');
  const gpu = await createDelugeDevice(navigator.gpu);
  const device = gpu.device;
  device.onuncapturederror = (e) => {
    window.__errors.push(e.error.message);
    console.error('[webgpu]', e.error.message);
  };
  device.lost.then((info) => console.error('[webgpu] device lost', info.message));
  const format = navigator.gpu.getPreferredCanvasFormat();
  const t0 = performance.now();
  const quality = (q.get('quality') ?? 'auto') as RendererQuality;
  const renderer = await createRenderer(device, canvas, format, { quality });
  window.__renderer = renderer;

  const presetId = q.get('preset');
  let scene = presetId ? await presetScene(device, presetId) : await mockScene(device);
  renderer.setScene(scene.terrain, scene.solver);
  console.log(`[harness] scene ready in ${(performance.now() - t0).toFixed(0)} ms, ${scene.terrain.nx}×${scene.terrain.ny}, ${gpu.description}`);

  const base = scene.cameras[q.get('cam') ?? 'overview'] ?? scene.cameras.overview;
  renderer.camera.pose = {
    target: { gx: num('gx', base.target.gx), gy: num('gy', base.target.gy), elevation: num('elev', base.target.elevation) },
    distance: num('dist', base.distance),
    yaw: num('yaw', base.yaw),
    pitch: num('pitch', base.pitch),
  };

  // ── Settings & interaction ────────────────────────────────────────────────────────────
  let waterMode = (q.get('mode') ?? 'realistic') as WaterViewMode;
  let rain = num('rain', 0);
  let contours = flag('contours', false);
  let imagery = flag('imagery', true);
  let overlaysOn = flag('overlays', true);
  let exag = num('exag', 1.5);
  let cursor = scene.cursor;

  let lastWall: { gx: number; gy: number } | null = null;
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const hit = renderer.pick(e.clientX - r.left, e.clientY - r.top);
    if (hit && cursor) cursor = { ...cursor, gx: hit.gx, gy: hit.gy };
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (!e.shiftKey || e.button !== 0) return;
    const r = canvas.getBoundingClientRect();
    const hit = renderer.pick(e.clientX - r.left, e.clientY - r.top);
    if (!hit) return;
    const a = lastWall ?? hit;
    scene.solver.applyBrush({ kind: 'wall', ax: a.gx, ay: a.gy, bx: hit.gx, by: hit.gy, radius: 1, height: 3 });
    lastWall = hit;
  });
  renderer.camera.leftDragOrbits = true;
  const qualities: RendererQuality[] = ['auto', 'high', 'balanced', 'low'];
  window.addEventListener('keydown', (e) => {
    const modes: WaterViewMode[] = ['realistic', 'depth', 'maxDepth', 'velocity'];
    if (e.key >= '1' && e.key <= '4') waterMode = modes[Number(e.key) - 1];
    if (e.key === 'r') rain = rain > 0 ? 0 : 40;
    if (e.key === 'c') contours = !contours;
    if (e.key === 'i') imagery = !imagery;
    if (e.key === 'o') overlaysOn = !overlaysOn;
    if (e.key === 'f') renderer.camera.frameAll();
    if (e.key === 't') renderer.camera.topDown();
    if (e.key === 'q') renderer.setQuality(qualities[(qualities.indexOf(renderer.quality) + 1) % qualities.length]);
    if (e.key === 'Escape') lastWall = null;
  });

  window.__pick = (x, y) => renderer.pick(x, y);
  window.__swap = async (o) => {
    const old = scene;
    const next = await mockScene(device, o);
    renderer.setScene(next.terrain, next.solver);
    scene = next;
    old.solver.destroy();
    renderer.camera.frameAll();
    await new Promise((r) => setTimeout(r, 500));
    await device.queue.onSubmittedWorkDone();
    return `${next.terrain.nx}×${next.terrain.ny} imagery=${!!next.terrain.imagery} roads=${!!next.terrain.roads} lod=${(renderer as unknown as { lodStats: { nodes: number } }).lodStats.nodes}`;
  };
  window.__set = (o) => {
    if (o.mode) waterMode = o.mode;
    if (o.rain !== undefined) rain = o.rain;
    if (o.contours !== undefined) contours = o.contours;
    if (o.imagery !== undefined) imagery = o.imagery;
    if (o.overlays !== undefined) overlaysOn = o.overlays;
    if (o.exag !== undefined) exag = o.exag;
    if (o.cam || o.pose) {
      const b = o.cam ? (scene.cameras[o.cam] ?? renderer.camera.pose) : renderer.camera.pose;
      const t = { ...b.target, ...(o.pose?.target ?? {}) };
      renderer.camera.pose = {
        target: t,
        distance: o.pose?.distance ?? b.distance,
        yaw: o.pose?.yaw ?? b.yaw,
        pitch: o.pose?.pitch ?? b.pitch,
      };
    }
  };

  const emptyOverlay: OverlayState = {
    roadStatus: null,
    route: null,
    routeState: 'none',
    sources: [],
    storms: [],
    shelters: [],
    evacStart: null,
    wallPreview: null,
    cursor: null,
  };
  const settings = (time: number) => ({
    waterMode,
    verticalExaggeration: exag,
    showImagery: imagery,
    showRoads: overlaysOn && flag('roads', true),
    showContours: contours,
    rainRate: rain,
    time,
  });

  // ── Frame loop with timing ────────────────────────────────────────────────────────────
  const frameTimes: number[] = [];
  let last = performance.now();
  let frames = 0;
  let animTime = 0;
  let benchActive = false;
  const renderFrame = (dt: number) => {
    scene.tick(dt);
    animTime += dt;
    renderer.setOverlays(overlaysOn ? { ...scene.overlays(), cursor } : emptyOverlay);
    renderer.render(settings(animTime));
  };
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameTimes.push(now - last);
    if (frameTimes.length > 600) frameTimes.shift();
    last = now;
    if (!benchActive) renderFrame(dt);
    frames++;
    if (frames % 20 === 0) {
      const recent = frameTimes.slice(-60);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const p = renderer.camera.pose;
      const st = renderer.stats;
      hud.textContent =
        `${(1000 / avg).toFixed(0)} fps  ${avg.toFixed(1)} ms  ${canvas.width}×${canvas.height}  grid ${scene.terrain.nx}×${scene.terrain.ny}  quality ${renderer.quality} (scale ${st.renderScale.toFixed(2)})\n` +
        `gpu ${st.gpuMs.toFixed(2)} ms (prep ${st.prepMs.toFixed(2)} main ${st.mainMs.toFixed(2)} post ${st.postMs.toFixed(2)})  cpu ${st.cpuMs.toFixed(2)} ms\n` +
        `mode ${waterMode}  rain ${rain}  lod ${(renderer as unknown as { lodStats: { nodes: number; perLevel: number[] } }).lodStats.nodes} [${(renderer as unknown as { lodStats: { perLevel: number[] } }).lodStats.perLevel.join(",")}]  ${scene.status()}\n` +
        `cam gx=${p.target.gx.toFixed(0)} gy=${p.target.gy.toFixed(0)} elev=${p.target.elevation.toFixed(0)} d=${p.distance.toFixed(0)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)}`;
    }
    if (frames === 8) device.queue.onSubmittedWorkDone().then(() => resolveReady());
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  window.__perf = async (ms: number) => {
    await window.__renderReady;
    const start = performance.now();
    const times: number[] = [];
    let prev = start;
    await new Promise<void>((res) => {
      const tick = () => {
        const t = performance.now();
        times.push(t - prev);
        prev = t;
        if (t - start < ms) requestAnimationFrame(tick);
        else res();
      };
      requestAnimationFrame(tick);
    });
    times.shift();
    const sorted = [...times].sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / Math.max(1, times.length);
    return {
      frames: times.length,
      avgMs: +avg.toFixed(2),
      p95Ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(2),
      maxMs: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
      fps: +(1000 / avg).toFixed(1),
      width: canvas.width,
      height: canvas.height,
      gpu: { ...renderer.stats },
    };
  };

  /** Unthrottled throughput: render + wait for the GPU, back to back (no vsync), including the scene tick. */
  window.__bench = async (count: number) => {
    await window.__renderReady;
    benchActive = true;
    await device.queue.onSubmittedWorkDone();
    const start = performance.now();
    for (let i = 0; i < count; i++) {
      renderFrame(1 / 60);
      await device.queue.onSubmittedWorkDone();
    }
    const ms = (performance.now() - start) / count;
    benchActive = false;
    return { frames: count, msPerFrame: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), gpu: { ...renderer.stats } };
  };
}

// ── Scene: synthetic valley + mock solver ──────────────────────────────────────────────────

async function mockScene(device: GPUDevice, o: { n?: number; imagery?: boolean; roads?: boolean } = {}): Promise<HarnessScene> {
  const n = o.n ?? num('n', 1024);
  const fixedStage = q.has('stage') ? num('stage', 3) : undefined;
  const { terrain, solver, mock } = await createMockScene(device, {
    n,
    stage: fixedStage,
    imagery: o.imagery ?? flag('imagery', true),
    roads: o.roads ?? flag('roads', true),
  });
  const T = mock.town;
  const P = mock.protectedRect;
  const s = n / 1024;
  const elevAt = (gx: number, gy: number) => mock.ground[Math.floor(gy) * n + Math.floor(gx)];
  const cameras: Record<string, CameraPose> = {
    overview: { target: { gx: n / 2, gy: n * 0.53, elevation: 240 }, distance: n * mock.cellSize * 1.12, yaw: 0.32, pitch: 0.66 },
    grazing: { target: { gx: (T.x0 + T.x1) / 2 + 60 * s, gy: (T.y0 + T.y1) / 2, elevation: elevAt((T.x0 + T.x1) / 2, (T.y0 + T.y1) / 2) }, distance: 2600, yaw: -0.55, pitch: 0.2 },
    top: { target: { gx: n / 2, gy: n / 2, elevation: 230 }, distance: n * mock.cellSize * 1.2, yaw: 0, pitch: Math.PI / 2 },
    shore: { target: { gx: T.x1 - 10 * s, gy: T.y1 + 25 * s, elevation: elevAt(T.x1, T.y1) }, distance: 520, yaw: 0.9, pitch: 0.38 },
    wall: { target: { gx: P.x1, gy: P.y0 + 12 * s, elevation: elevAt(P.x1, P.y0) }, distance: 300, yaw: -1.1, pitch: 0.42 },
    creek: { target: { gx: mock.creek[40], gy: mock.creek[41], elevation: elevAt(mock.creek[40], mock.creek[41]) }, distance: 900, yaw: -0.4, pitch: 0.45 },
    town: { target: { gx: (T.x0 + T.x1) / 2, gy: (T.y0 + T.y1) / 2, elevation: elevAt((T.x0 + T.x1) / 2, (T.y0 + T.y1) / 2) }, distance: 1500, yaw: 0.2, pitch: 0.7 },
  };

  const roads = terrain.roads;
  const roadStatus: RoadStatusArray | null = roads ? new Uint8Array(roads.edges.length) : null;
  const updateRoadStatus = () => {
    const snap = solver.getSnapshot();
    if (!snap || !roadStatus || !roads) return;
    roads.edges.forEach((e, k) => {
      let maxD = 0;
      for (let p = 0; p < e.pts.length; p += 2) {
        const i = Math.min(n - 1, Math.max(0, Math.floor(e.pts[p])));
        const j = Math.min(n - 1, Math.max(0, Math.floor(e.pts[p + 1])));
        maxD = Math.max(maxD, snap.depth[j * n + i]);
      }
      roadStatus[k] = maxD >= 0.3 ? 2 : maxD >= 0.05 ? 1 : 0;
    });
  };
  const evacStart = { gx: (P.x0 + P.x1) / 2, gy: (P.y0 + P.y1) / 2 };
  const hwX = (gy: number) => mock.riverX(gy) - 150 * s;
  const shelter1 = { name: 'Hilltop School', gx: T.x0 - 170 * s, gy: T.y0 - 60 * s };
  const routePts: number[] = [evacStart.gx, evacStart.gy, evacStart.gx, T.y0 + 36 * s, T.x0, T.y0 + 36 * s];
  const hy0 = T.y0 + 36 * s;
  routePts.push(hwX(hy0), hy0);
  for (let y = hy0; y > T.y0 - 60 * s; y -= 6 * s) routePts.push(hwX(y), y);
  routePts.push(shelter1.gx, shelter1.gy);
  const routeMode = (q.get('route') ?? 'ok') as 'ok' | 'blocked' | 'none';
  const route = routeMode === 'none' ? null : new Float32Array(routePts);
  const wallPts = new Float32Array([T.x0 + 10 * s, T.y1 + 8 * s, T.x0 + 40 * s, T.y1 + 14 * s, T.x0 + 62 * s, T.y1 + 10 * s]);

  const frozen = q.has('t');
  if (frozen) solver.time = num('t', 0);
  let frame = 0;
  let statusAt = -1;
  let clock = 0;
  const gauge: WaterSource = { id: 'st1', type: 'stage', gx: mock.riverX(8), gy: 8, radius: 12, level: mock.riverLevel(8), label: 'River gauge' };
  let overlay: Omit<OverlayState, 'cursor'> | null = null;
  const build = (): Omit<OverlayState, 'cursor'> => ({
    roadStatus,
    route,
    routeState: routeMode,
    sources: [
      { id: 'in1', type: 'inflow', gx: mock.creek[6], gy: mock.creek[7], radius: 4, discharge: 120, label: 'Creek inflow' },
      { ...gauge, level: mock.riverLevel(8) + solver.currentStage() } as WaterSource,
    ],
    storms: [{ id: 'storm1', gx: n * 0.8, gy: n * 0.72, radius: 90 * s, intensity: 60 }],
    shelters: [shelter1, { name: 'East Ridge Church', gx: n * 0.86, gy: n * 0.5 }],
    evacStart,
    wallPreview: { pts: wallPts, height: 2.5, radius: 1.2 },
  });

  return {
    terrain,
    solver,
    cameras,
    cursor: { gx: T.x0 + 70 * s, gy: T.y1 + 10 * s, radius: 6 * s, color: [0.35, 0.8, 1.0] },
    tick(dt) {
      clock += dt;
      if (!frozen) solver.step(dt);
      else if (frame < 3) solver.step(0);
      frame++;
      if (clock - statusAt > 0.5 || !overlay) {
        statusAt = clock;
        updateRoadStatus();
        overlay = build();
      }
    },
    overlays: () => overlay ?? (overlay = build()),
    status: () => `stage ${solver.currentStage().toFixed(2)} m (mock)`,
  };
}

// ── Scene: real preset + real solver + real routing ────────────────────────────────────────

async function presetScene(device: GPUDevice, id: string): Promise<HarnessScene> {
  const [{ loadPreset, computeInitialWater }, { createSolver }, { createRouter }] = await Promise.all([
    import('../src/data'),
    import('../src/sim'),
    import('../src/routing'),
  ]);
  const terrain = await loadPreset(id, (m, f) => console.log(`[harness] ${m} ${(f * 100).toFixed(0)}%`));
  const scenario = terrain.scenario;
  const solver = await createSolver(device, terrain, { timeScale: num('timescale', 60) });
  const initial = computeInitialWater(terrain, scenario);
  solver.setInitialWater(initial);
  const stageOffset = num('stage', 0);
  const sources: WaterSource[] = (scenario?.sources ?? []).map((s) => (s.type === 'stage' ? { ...s, level: s.level + stageOffset } : { ...s }));
  solver.setSources(sources);
  solver.setStorms(scenario?.storms ?? []);
  solver.params.rainRate = num('rain', scenario?.rainRate ?? 0);

  const runSeconds = num('run', 0);
  if (runSeconds > 0) {
    const s = solver as FloodSolver & { runSubsteps?: (n: number) => number; computeDt?: () => number; readbackNow?: () => Promise<unknown> };
    let simulated = 0;
    const tStart = performance.now();
    while (simulated < runSeconds && s.runSubsteps && s.computeDt) {
      const dt = s.computeDt();
      const k = Math.max(1, Math.min(200, Math.ceil((runSeconds - simulated) / dt)));
      s.runSubsteps(k);
      simulated += k * dt;
      await device.queue.onSubmittedWorkDone();
      if (s.readbackNow) await s.readbackNow();
    }
    console.log(`[harness] pre-ran ${simulated.toFixed(0)} sim s in ${(performance.now() - tStart).toFixed(0)} ms`);
  }

  const router = createRouter();
  router.setNetwork(terrain.roads, terrain.cellSize);
  const evacParam = q.get('evac');
  const evacStart = evacParam ? { gx: Number(evacParam.split(',')[0]), gy: Number(evacParam.split(',')[1]) } : null;
  const shelters = scenario?.shelters ?? [];
  let roadStatus: RoadStatusArray | null = null;
  let routeRes: RouteResult | null = null;
  let lastSnap: unknown = null;

  const { nx, ny, cellSize } = terrain;
  const size = Math.max(nx, ny) * cellSize;
  const elevAt = (gx: number, gy: number) => terrain.elevation[Math.floor(gy) * nx + Math.floor(gx)];
  const scen = scenario?.camera ?? { target: { gx: nx / 2, gy: ny / 2, elevation: elevAt(nx / 2, ny / 2) }, distance: size, yaw: 0.3, pitch: 0.6 };
  const cameras: Record<string, CameraPose> = {
    overview: scen,
    scenario: scen,
    top: { target: { gx: nx / 2, gy: ny / 2, elevation: elevAt(nx / 2, ny / 2) }, distance: size * 1.2, yaw: 0, pitch: Math.PI / 2 },
    low: { ...scen, distance: scen.distance * 0.45, pitch: 0.22 },
    close: { ...scen, distance: 900, pitch: 0.45 },
  };
  const paused = flag('pause', false);
  const cursor = { gx: scen.target.gx, gy: scen.target.gy, radius: 8, color: [0.35, 0.8, 1.0] as [number, number, number] };

  return {
    terrain,
    solver,
    cameras,
    cursor,
    tick(dt) {
      if (!paused && dt > 0) solver.step(dt);
      const snap = solver.getSnapshot();
      if (snap && snap !== lastSnap) {
        lastSnap = snap;
        roadStatus = router.updateFlood(snap.depth, nx, ny);
        routeRes = evacStart ? router.route(evacStart, shelters) : null;
      }
    },
    overlays: () => ({
      roadStatus,
      route: routeRes?.polyline ?? null,
      routeState: routeRes?.state ?? 'none',
      sources,
      storms: scenario?.storms ?? [],
      shelters,
      evacStart,
      wallPreview: null,
    }),
    status: () => {
      const st = solver.getSnapshot()?.stats;
      return st ? `sim t=${st.simTime.toFixed(0)} s  maxDepth ${st.maxDepth.toFixed(2)} m  ${routeRes ? routeRes.message : ''}` : 'sim warming up';
    },
  };
}

main().catch((e) => {
  console.error(e);
  hud.textContent = String(e?.message ?? e);
});
