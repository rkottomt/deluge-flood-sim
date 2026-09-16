/**
 * Renderer harness: synthetic valley + MockFloodSolver + fake overlays.
 *
 * URL params:
 *   mode=realistic|depth|maxDepth|velocity   n=512|1024|2048   exag=1.5   rain=0 (mm/hr)
 *   cam=overview|grazing|top|shore|wall|creek|town   or  yaw= pitch= dist= gx= gy= elev=
 *   overlays=1 roads=1 imagery=1 contours=0 route=ok|blocked|none   stage=<m> (fixed; default animates)
 *   t=<s> freeze animation at this time   hud=1
 * Interaction: drag to orbit, right-drag pan, wheel zoom; shift+click drops wall segments under the cursor;
 *   keys 1-4 water modes, R rain, C contours, I imagery, O overlays, F frame all, T top-down.
 * Automation: window.__renderReady (Promise), window.__perf(ms) → frame-time stats, window.__pick(x, y).
 */
import type { OverlayState, WaterViewMode, CameraPose, RoadStatusArray } from '../src/contracts';
import { createDelugeDevice } from '../src/gpu';
import { createRenderer } from '../src/render';
import { createMockScene } from '../src/render/mockSolver';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : d);
const flag = (k: string, d: boolean) => (q.has(k) ? q.get(k) !== '0' && q.get(k) !== 'false' : d);

const hud = document.getElementById('hud')!;
if (!flag('hud', true)) hud.classList.add('hidden');

declare global {
  interface Window {
    __renderReady: Promise<void>;
    __perf: (ms: number) => Promise<{ frames: number; avgMs: number; p95Ms: number; maxMs: number; fps: number; width: number; height: number }>;
    __pick: (x: number, y: number) => unknown;
    __errors: string[];
  }
}
window.__errors = [];
let resolveReady!: () => void;
window.__renderReady = new Promise((r) => (resolveReady = r));

async function main() {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  if (!navigator.gpu) throw new Error('WebGPU not available');
  const gpu = await createDelugeDevice(navigator.gpu);
  const device = gpu.device;
  device.onuncapturederror = (e) => {
    window.__errors.push(e.error.message);
    console.error('[webgpu]', e.error.message);
  };
  const format = navigator.gpu.getPreferredCanvasFormat();
  const t0 = performance.now();
  const renderer = await createRenderer(device, canvas, format);
  const n = num('n', 1024);
  const fixedStage = q.has('stage') ? num('stage', 3) : undefined;
  const { terrain, solver, mock } = await createMockScene(device, {
    n,
    stage: fixedStage,
    imagery: flag('imagery', true),
    roads: flag('roads', true),
  });
  renderer.setScene(terrain, solver);
  console.log(`[harness] scene ready in ${(performance.now() - t0).toFixed(0)} ms, ${n}², ${gpu.description}`);

  // ── Camera presets ────────────────────────────────────────────────────────────────────
  const T = mock.town;
  const P = mock.protectedRect;
  const s = n / 1024;
  const elevAt = (gx: number, gy: number) => mock.ground[Math.floor(gy) * n + Math.floor(gx)];
  const presets: Record<string, CameraPose> = {
    overview: { target: { gx: n / 2, gy: n * 0.53, elevation: 240 }, distance: n * mock.cellSize * 1.12, yaw: 0.32, pitch: 0.66 },
    grazing: { target: { gx: (T.x0 + T.x1) / 2 + 60 * s, gy: (T.y0 + T.y1) / 2, elevation: elevAt((T.x0 + T.x1) / 2, (T.y0 + T.y1) / 2) }, distance: 2600, yaw: -0.55, pitch: 0.2 },
    top: { target: { gx: n / 2, gy: n / 2, elevation: 230 }, distance: n * mock.cellSize * 1.2, yaw: 0, pitch: Math.PI / 2 },
    shore: { target: { gx: T.x1 - 10 * s, gy: T.y1 + 25 * s, elevation: elevAt(T.x1, T.y1) }, distance: 520, yaw: 0.9, pitch: 0.38 },
    wall: { target: { gx: P.x1, gy: P.y0 + 12 * s, elevation: elevAt(P.x1, P.y0) }, distance: 300, yaw: -1.1, pitch: 0.42 },
    creek: { target: { gx: mock.creek[40], gy: mock.creek[41], elevation: elevAt(mock.creek[40], mock.creek[41]) }, distance: 900, yaw: -0.4, pitch: 0.45 },
    town: { target: { gx: (T.x0 + T.x1) / 2, gy: (T.y0 + T.y1) / 2, elevation: elevAt((T.x0 + T.x1) / 2, (T.y0 + T.y1) / 2) }, distance: 1500, yaw: 0.2, pitch: 0.7 },
  };
  const base = presets[q.get('cam') ?? 'overview'] ?? presets.overview;
  renderer.camera.pose = {
    target: { gx: num('gx', base.target.gx), gy: num('gy', base.target.gy), elevation: num('elev', base.target.elevation) },
    distance: num('dist', base.distance),
    yaw: num('yaw', base.yaw),
    pitch: num('pitch', base.pitch),
  };

  // ── Fake overlays ─────────────────────────────────────────────────────────────────────
  const roads = terrain.roads!;
  const roadStatus: RoadStatusArray | null = roads ? new Uint8Array(roads.edges.length) : null;
  const updateRoadStatus = () => {
    const snap = solver.getSnapshot();
    if (!snap || !roadStatus) return;
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
  const hx = hwX(hy0);
  routePts.push(hx, hy0);
  for (let y = hy0; y > T.y0 - 60 * s; y -= 6 * s) routePts.push(hwX(y), y);
  routePts.push(shelter1.gx, shelter1.gy);
  const routeMode = (q.get('route') ?? 'ok') as 'ok' | 'blocked' | 'none';
  const wallPts = new Float32Array([T.x0 + 10 * s, T.y1 + 8 * s, T.x0 + 40 * s, T.y1 + 14 * s, T.x0 + 62 * s, T.y1 + 10 * s]);
  const showOverlays = flag('overlays', true);
  let overlaysOn = showOverlays;
  let cursor: OverlayState['cursor'] = { gx: T.x0 + 70 * s, gy: T.y1 + 10 * s, radius: 6 * s, color: [0.35, 0.8, 1.0] };
  const overlayState = (): OverlayState =>
    overlaysOn
      ? {
          roadStatus,
          route: routeMode === 'none' ? null : new Float32Array(routePts),
          routeState: routeMode,
          sources: [
            { id: 'in1', type: 'inflow', gx: mock.creek[6], gy: mock.creek[7], radius: 4, discharge: 120, label: 'Creek inflow' },
            { id: 'st1', type: 'stage', gx: mock.riverX(8), gy: 8, radius: 12, level: mock.riverLevel(8) + solver.currentStage(), label: 'River gauge' },
          ],
          storms: [{ id: 'storm1', gx: n * 0.8, gy: n * 0.72, radius: 90 * s, intensity: 60 }],
          shelters: [shelter1, { name: 'East Ridge Church', gx: n * 0.86, gy: n * 0.5 }],
          evacStart,
          wallPreview: { pts: wallPts, height: 2.5, radius: 1.2 },
          cursor,
        }
      : { roadStatus: null, route: null, routeState: 'none', sources: [], storms: [], shelters: [], evacStart: null, wallPreview: null, cursor: null };

  // Stable route array identity (only rebuilt when overlays toggle).
  let cachedOverlay = overlayState();

  // ── Settings & interaction ────────────────────────────────────────────────────────────
  let waterMode = (q.get('mode') ?? 'realistic') as WaterViewMode;
  let rain = num('rain', 0);
  let contours = flag('contours', false);
  let imagery = flag('imagery', true);
  const exag = num('exag', 1.5);
  const frozen = q.has('t');
  const tFixed = num('t', 0);
  if (frozen) solver.time = tFixed;

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
    solver.applyBrush({ kind: 'wall', ax: a.gx, ay: a.gy, bx: hit.gx, by: hit.gy, radius: 1, height: 3 });
    lastWall = hit;
  });
  renderer.camera.leftDragOrbits = true;
  window.addEventListener('keydown', (e) => {
    const modes: WaterViewMode[] = ['realistic', 'depth', 'maxDepth', 'velocity'];
    if (e.key >= '1' && e.key <= '4') waterMode = modes[Number(e.key) - 1];
    if (e.key === 'r') rain = rain > 0 ? 0 : 40;
    if (e.key === 'c') contours = !contours;
    if (e.key === 'i') imagery = !imagery;
    if (e.key === 'o') {
      overlaysOn = !overlaysOn;
      cachedOverlay = overlayState();
    }
    if (e.key === 'f') renderer.camera.frameAll();
    if (e.key === 't') renderer.camera.topDown();
    if (e.key === 'Escape') lastWall = null;
  });

  window.__pick = (x, y) => renderer.pick(x, y);

  // ── Frame loop with timing ────────────────────────────────────────────────────────────
  const frameTimes: number[] = [];
  let last = performance.now();
  let frames = 0;
  let statusAt = 0;
  let animTime = frozen ? tFixed : 0;
  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameTimes.push(now - last);
    if (frameTimes.length > 600) frameTimes.shift();
    last = now;
    if (!frozen) {
      animTime += dt;
      solver.step(dt);
    } else if (frames < 3) {
      solver.step(0);
    }
    if (now - statusAt > 500) {
      statusAt = now;
      updateRoadStatus();
      if (overlaysOn) {
        const st = cachedOverlay.sources[1];
        if (st && st.type === 'stage') st.level = mock.riverLevel(8) + solver.currentStage();
        cachedOverlay = { ...cachedOverlay, sources: [...cachedOverlay.sources] };
      }
    }
    renderer.setOverlays({ ...cachedOverlay, cursor: overlaysOn ? cursor : null });
    renderer.render({
      waterMode,
      verticalExaggeration: exag,
      showImagery: imagery,
      showRoads: overlaysOn && flag('roads', true),
      showContours: contours,
      rainRate: rain,
      time: animTime,
    });
    frames++;
    if (frames % 20 === 0) {
      const recent = frameTimes.slice(-60);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const p = renderer.camera.pose;
      hud.textContent =
        `${(1000 / avg).toFixed(0)} fps  ${avg.toFixed(1)} ms  ${canvas.width}×${canvas.height}  grid ${n}²\n` +
        `mode ${waterMode}  stage ${solver.currentStage().toFixed(2)} m  rain ${rain}\n` +
        `cam gx=${p.target.gx.toFixed(0)} gy=${p.target.gy.toFixed(0)} d=${p.distance.toFixed(0)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)}`;
    }
    if (frames === 8) {
      device.queue.onSubmittedWorkDone().then(() => resolveReady());
    }
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
    };
  };
}

main().catch((e) => {
  console.error(e);
  hud.textContent = String(e?.message ?? e);
});
