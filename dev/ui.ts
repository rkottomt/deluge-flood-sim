/**
 * UI dev harness: the full UI over a procedurally drawn "aerial" map with a fake store, fake renderer
 * (top-down pick), fake solver (records brush ops and draws walls), realistic 5 Hz stats, and
 * console-logging actions.
 *
 * URL params (for screenshots): ?panel=help|how|picker  ?loading=1  ?error=1  ?tool=<ToolId>
 *   ?route=ok|blocked|none|cycle  ?naive=1  ?paused=1  ?stage=<ft>  ?rain=<mm/hr>  ?mode=<WaterViewMode>
 *   ?closed=1 (panel collapsed)  ?probe=x,y (css px)  ?scroll=<px> (how-it-works body)  ?lowfx=1|0 (force glass mode)
 */
import { createStore } from '../src/app/store';
import { mountUI, createToolController } from '../src/ui';
import { DEFAULT_SIM_PARAMS } from '../src/contracts';
import type {
  AppActions,
  AppState,
  BrushOp,
  FloodRenderer,
  FloodSolver,
  LiveAreaRequest,
  PickResult,
  PresetInfo,
  RouteResult,
  ScenarioPreset,
  TerrainData,
  ToolId,
  WaterViewMode,
} from '../src/contracts';

const params = new URLSearchParams(location.search);
const NX = 1024;
const NY = 1024;
const CELL = 7.8;

// ─── Fake terrain: height field + a painted "aerial" image ───────────────────────────────────────
function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number) {
  let s = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 5; o++) {
    s += amp * vnoise(x * f, y * f);
    f *= 2.03;
    amp *= 0.5;
  }
  return s;
}
/**
 * Low-frequency noise is sampled on coarse grids and bilinearly upsampled: the harness must boot fast even on
 * a busy machine (it is screenshotted dozens of times per iteration).
 */
function coarseField(res: number, fn: (gx: number, gy: number) => number): (gx: number, gy: number) => number {
  const vals = new Float32Array((res + 1) * (res + 1));
  const step = NX / res;
  for (let j = 0; j <= res; j++) for (let i = 0; i <= res; i++) vals[j * (res + 1) + i] = fn(i * step, j * step);
  return (gx, gy) => {
    const x = Math.min(res - 1e-6, Math.max(0, gx / step));
    const y = Math.min(res - 1e-6, Math.max(0, gy / step));
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const r = res + 1;
    const a = vals[j * r + i], b = vals[j * r + i + 1], c = vals[(j + 1) * r + i], d = vals[(j + 1) * r + i + 1];
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}
const wiggle = coarseField(64, (x, y) => (fbm(x * 0.004, y * 0.004) - 0.5) * 60);
const hillsAt = coarseField(128, (x, y) => fbm(x * 0.006, y * 0.006) * 110);
const urbanAt = coarseField(128, (x, y) => fbm(x * 0.01, y * 0.01));
const grainAt = coarseField(256, (x, y) => fbm(x * 0.05, y * 0.05));

/** Distance (cells) to a Pittsburgh-like confluence: two rivers join into one flowing west. */
function riverDist(gx: number, gy: number) {
  const px = 470, py = 520;
  const seg = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((gx - ax) * dx + (gy - ay) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(gx - ax - t * dx, gy - ay - t * dy);
  };
  const wig = wiggle(gx, gy);
  return Math.min(seg(px, py, 1100, 250 + wig), seg(px, py, 1100, 760 - wig), seg(-80, 470 + wig * 0.5, px, py));
}
const elevation = new Float32Array(NX * NY);
const riverD = new Float32Array(NX * NY);
for (let j = 0; j < NY; j++) {
  for (let i = 0; i < NX; i++) {
    const d = riverDist(i, j);
    riverD[j * NX + i] = d;
    const hills = hillsAt(i, j);
    const valley = Math.min(1, Math.max(0, (d - 18) / 170));
    elevation[j * NX + i] = 212 + (d < 18 ? -4 : 0) + valley * valley * 0.6 * hills + valley * 25;
  }
}
const NORMAL_POOL = 216.4;

const terrainImage = (() => {
  const c = document.createElement('canvas');
  c.width = NX;
  c.height = NY;
  const g = c.getContext('2d')!;
  const img = g.createImageData(NX, NY);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const k = j * NX + i;
      const e = elevation[k];
      const d = riverD[k];
      const n = grainAt(i, j) + (hash(i >> 1, j >> 1) - 0.5) * 0.25;
      let r: number, gg: number, b: number;
      if (d < 18) {
        r = 38 + n * 20; gg = 52 + n * 18; b = 48 + n * 12; // murky river
      } else {
        const t = Math.min(1, (e - 214) / 80);
        r = 52 + t * 30 + n * 30; gg = 70 + t * 18 + n * 34; b = 44 + n * 16; // vegetation
        const urban = d < 170 && hash(Math.floor(i / 6), Math.floor(j / 6)) > 0.3 && urbanAt(i, j) > 0.42;
        if (urban) {
          const roof = hash(Math.floor(i / 5), Math.floor(j / 5));
          r = 78 + roof * 55; gg = 76 + roof * 50; b = 74 + roof * 48;
        }
        const nx = (e - elevation[k - 1 >= 0 ? k - 1 : k]) * 6;
        r += nx; gg += nx; b += nx;
      }
      img.data[4 * k] = r; img.data[4 * k + 1] = gg; img.data[4 * k + 2] = b; img.data[4 * k + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  // Street grid.
  g.strokeStyle = 'rgba(180,180,170,0.16)';
  g.lineWidth = 1.2;
  for (let x = 200; x < 1000; x += 42) {
    g.beginPath(); g.moveTo(x + 10, 120); g.lineTo(x - 10, 940); g.stroke();
  }
  for (let y = 140; y < 940; y += 42) {
    g.beginPath(); g.moveTo(180, y); g.lineTo(1000, y + 8); g.stroke();
  }
  return c;
})();

// ─── Fake scenario / presets ────────────────────────────────────────────────────────────────────
const scenario: ScenarioPreset = {
  description:
    "On March 17–18, 1936, snowmelt and heavy rain sent the Allegheny and Monongahela surging into the Ohio. At the Point the river crested at 46 feet — 24 feet above flood stage — putting downtown Pittsburgh under as much as 15 feet of water. Raise the river to the 1936 crest and watch the Golden Triangle go under street by street; then try to save it with a levee.",
  sources: [
    { id: 'alle', type: 'stage', gx: 1010, gy: 300, radius: 12, level: NORMAL_POOL, label: 'Allegheny River' },
    { id: 'mon', type: 'stage', gx: 1010, gy: 720, radius: 12, level: NORMAL_POOL, label: 'Monongahela River' },
    { id: 'ohio', type: 'stage', gx: 12, gy: 480, radius: 12, level: NORMAL_POOL, label: 'Ohio River' },
  ],
  storms: [],
  shelters: [
    { name: 'Cathedral of Learning', gx: 900, gy: 610 },
    { name: 'Mount Washington', gx: 520, gy: 780 },
  ],
  rainRate: 0,
  stage: {
    label: 'Ohio River at Pittsburgh (Point gauge)',
    gaugeDatum: 211.6,
    normalLevel: NORMAL_POOL,
    floodStageFt: 22,
    marks: [
      { label: '1972 Agnes', ft: 35.8 },
      { label: '1936 crest', ft: 46 },
    ],
    maxOffset: 11,
  },
  initialFill: [],
};

const presets: PresetInfo[] = [
  { id: 'pittsburgh', name: 'Pittsburgh — Three Rivers', subtitle: "1936 St. Patrick's Day flood — raise the rivers" },
  { id: 'johnstown', name: 'Johnstown — Conemaugh valley', subtitle: 'Flood city: crank the inflows' },
  { id: 'ellicott', name: 'Ellicott City, MD', subtitle: 'Flash floods on Main Street — storm-driven' },
  { id: 'sandbox', name: 'Synthetic valley', subtitle: 'Offline sandbox with a dam and a town' },
];

const initial: AppState = {
  presetId: 'pittsburgh',
  terrainName: 'Pittsburgh — Three Rivers',
  attribution: 'Elevation: USGS 3DEP · Imagery © Esri, Vantor, Earthstar Geographics, and the GIS User Community · Roads: US Census TIGER/Line',
  loading: null,
  error: null,
  paused: false,
  tool: 'orbit',
  wallHeight: 2.5,
  brushRadius: 30,
  inflowDischarge: 500,
  stormIntensity: 80,
  sim: { ...DEFAULT_SIM_PARAMS },
  stageOffset: 0,
  stageOffsetApplied: 0,
  render: { waterMode: 'realistic', verticalExaggeration: 1.5, showImagery: true, showRoads: true, showContours: false },
  look: { quality: 'auto', timeOfDay: 'daylight', buildings: true, presentation: false },
  sources: scenario.sources.slice(),
  storms: [{ id: 'storm-a', gx: 700, gy: 320, radius: 150, intensity: 60 }],
  shelters: scenario.shelters.slice(),
  evacStart: null,
  scenario,
  grid: { nx: NX, ny: NY, cellSize: CELL },
  stats: null,
  stepInfo: null,
  fps: 60,
  route: null,
  probe: null,
  panels: { howItWorks: false, locationPicker: false, help: false },
  gpuInfo: 'apple metal-3 Apple M4',
};

const store = createStore(initial);

// ─── Fake renderer / solver ─────────────────────────────────────────────────────────────────────
const canvas = document.getElementById('bg') as HTMLCanvasElement;
const ctx2d = canvas.getContext('2d')!;
let vw = 0, vh = 0, S = 0, ox = 0, oy = 0;
function resize() {
  const dpr = window.devicePixelRatio || 1;
  vw = window.innerWidth;
  vh = window.innerHeight;
  canvas.width = Math.round(vw * dpr);
  canvas.height = Math.round(vh * dpr);
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  S = Math.max(vw, vh) * 1.05;
  ox = (vw - S) / 2;
  oy = (vh - S) / 2;
}
resize();
window.addEventListener('resize', resize);
const toCss = (gx: number, gy: number) => [ox + (gx / NX) * S, oy + (gy / NY) * S] as const;

function waterLevel() {
  return NORMAL_POOL + store.get().stageOffset;
}
function depthAt(gx: number, gy: number) {
  const i = Math.max(0, Math.min(NX - 1, Math.floor(gx)));
  const j = Math.max(0, Math.min(NY - 1, Math.floor(gy)));
  return Math.max(0, waterLevel() - elevation[j * NX + i]);
}

const walls: Array<{ ax: number; ay: number; bx: number; by: number; radius: number }> = [];
const camera = {
  pose: { target: { gx: 512, gy: 512, elevation: 220 }, distance: 9000, yaw: 0, pitch: 0.9 },
  leftDragOrbits: true,
  flyTo: () => console.log('[camera] flyTo'),
  frameAll: () => console.log('[camera] frameAll'),
  topDown: () => console.log('[camera] topDown'),
};
const renderer: FloodRenderer = {
  camera,
  setScene() {},
  setOverlays() {},
  render() {},
  resize() {},
  destroy() {},
  pick(x: number, y: number): PickResult | null {
    const gx = ((x - ox) / S) * NX;
    const gy = ((y - oy) / S) * NY;
    if (gx < 0 || gy < 0 || gx >= NX || gy >= NY) return null;
    const e = elevation[Math.floor(gy) * NX + Math.floor(gx)];
    return { gx, gy, elevation: e, depth: depthAt(gx, gy) };
  },
};
const solver = {
  nx: NX,
  ny: NY,
  cellSize: CELL,
  applyBrush(op: BrushOp) {
    if (op.kind === 'wall') walls.push(op);
    else if (op.kind === 'eraseWall') {
      for (let k = walls.length - 1; k >= 0; k--) {
        const w = walls[k];
        if (Math.hypot((w.ax + w.bx) / 2 - op.bx, (w.ay + w.by) / 2 - op.by) < op.radius + 6) walls.splice(k, 1);
      }
    }
  },
} as unknown as FloodSolver;
const terrain = {
  name: 'Pittsburgh — Three Rivers',
  nx: NX,
  ny: NY,
  cellSize: CELL,
  elevation,
  bounds: { west: -80.0605, east: -79.9645, north: 40.4783, south: 40.4051 },
  imagery: null,
  roads: null,
  attribution: '',
  scenario,
} satisfies TerrainData;

const tools = createToolController(canvas, { store, renderer, getSolver: () => solver, getTerrain: () => terrain });

// ─── Fake actions ───────────────────────────────────────────────────────────────────────────────
let simTime = 0;
let peakVolume = 0;
function fakeLoad(name: string, presetId: string | null) {
  return new Promise<void>((resolve) => {
    const steps = ['Fetching USGS 3DEP elevation…', 'Decoding elevation (1024 × 1024)…', 'Fetching aerial imagery…', 'Building road graph…', 'Compiling GPU shaders…'];
    let k = 0;
    store.set({ loading: { message: steps[0], progress: 0.02 } });
    const t = setInterval(() => {
      k++;
      if (k >= 10) {
        clearInterval(t);
        simTime = 0;
        store.set({ loading: null, presetId, terrainName: name, stats: null });
        resolve();
        return;
      }
      store.set({ loading: { message: steps[Math.min(steps.length - 1, Math.floor(k / 2))], progress: k / 10 } });
    }, 250);
  });
}
const actions: AppActions = {
  loadPreset: (id) => {
    console.log('[action] loadPreset', id);
    return fakeLoad(presets.find((p) => p.id === id)?.name ?? id, id);
  },
  loadLiveArea: (req: LiveAreaRequest) => {
    console.log('[action] loadLiveArea', JSON.stringify(req));
    return fakeLoad(req.name ?? 'Live area', null);
  },
  listPresets: () => presets,
  resetWater: () => {
    console.log('[action] resetWater');
    simTime = 0;
    store.set({ stats: null });
  },
  resetAll: () => {
    console.log('[action] resetAll');
    walls.length = 0;
    simTime = 0;
  },
  clearWalls: () => {
    console.log('[action] clearWalls');
    walls.length = 0;
  },
  restoreScenario: () => {
    console.log('[action] restoreScenario');
    store.set({ sources: scenario.sources.slice(), storms: [], shelters: scenario.shelters.slice(), stageOffset: 0, sim: { ...store.get().sim, rainRate: 0 } });
  },
  cameraFrameAll: () => camera.frameAll(),
  cameraTopDown: () => camera.topDown(),
  setStabilityDemo: (on) => {
    console.log('[action] setStabilityDemo', on);
    const sim = store.get().sim;
    store.set({ sim: { ...sim, stabilityMode: on ? 'naive' : 'robust', cfl: on ? 1.8 : 0.7 } });
    if (!on) simTime = 0;
  },
};

// ─── Mount ──────────────────────────────────────────────────────────────────────────────────────
const root = document.getElementById('ui-root')!;
mountUI(root, store, actions);
(window as unknown as Record<string, unknown>).__store = store;
(window as unknown as Record<string, unknown>).__actions = actions;
(window as unknown as Record<string, unknown>).__ui = (root as unknown as { __delugeUI: unknown }).__delugeUI;

// ─── Fake stats at 5 Hz ─────────────────────────────────────────────────────────────────────────
let naiveSince = 0;
let routeMode = params.get('route') ?? 'cycle';
let routeFlip = 0;
setInterval(() => {
  const s = store.get();
  if (s.loading) return;
  const dt = 0.2;
  const substeps = Math.min(s.sim.maxSubstepsPerFrame, Math.max(1, Math.ceil((s.sim.timeScale / 60) / 0.9)));
  const throttled = s.sim.timeScale >= 1200;
  if (!s.paused) simTime += dt * (throttled ? 880 : s.sim.timeScale);
  const level = waterLevel();
  const flooded = Math.max(0, (level - 217) * 0.42e6) + s.sim.rainRate * 3000 + Math.min(simTime, 3600) * 20;
  const volume = 5.8e6 + flooded * 1.7 + simTime * 40;
  peakVolume = Math.max(peakVolume, volume);
  const naive = s.sim.stabilityMode === 'naive';
  if (naive && !naiveSince) naiveSince = performance.now();
  if (!naive) naiveSince = 0;
  const blow = naive ? Math.pow(10, (performance.now() - naiveSince) / 700) : 1;
  const massError = naive ? (blow > 1e12 ? NaN : 3e-5 * blow) : 2.1e-5 + Math.random() * 1.2e-5;
  store.set({
    fps: 58 + Math.random() * 4,
    stepInfo: {
      simSecondsAdvanced: s.paused ? 0 : (throttled ? 880 : s.sim.timeScale) / 60,
      substeps: s.paused ? 0 : substeps,
      dt: 0.84 + Math.random() * 0.05,
      throttled: throttled && !s.paused,
    },
    stats: {
      simTime,
      maxDepth: Math.max(0, level - 204) + (naive ? blow * 0.1 : 0),
      maxSpeed: 1.8 + s.sim.rainRate * 0.01 + Math.random() * 0.2 + (naive ? blow : 0),
      volume,
      wetArea: 3.2e6 + flooded,
      floodedArea: flooded,
      volumeIn: simTime * 400,
      volumeOut: simTime * 350,
      massError,
      courant: naive ? 1.8 : 0.68 + Math.random() * 0.03,
    },
  });

  // Route
  let route: RouteResult | null = null;
  if (routeMode === 'cycle') {
    routeFlip = (routeFlip + 1) % 50;
    route = s.evacStart ? (routeFlip < 30 ? okRoute() : blockedRoute()) : null;
  } else if (routeMode === 'ok') route = okRoute();
  else if (routeMode === 'blocked') route = blockedRoute();
  if (!route || !s.route || route.state !== s.route.state) store.set({ route });
}, 200);

function okRoute(): RouteResult {
  return {
    state: 'ok',
    polyline: new Float32Array([420, 560, 520, 600, 700, 610, 900, 610]),
    lengthMeters: 3420,
    etaSeconds: 372,
    shelter: scenario.shelters[0],
    message: 'Via Forbes Ave and Boulevard of the Allies — avoid Smithfield St (flooded).',
  };
}
function blockedRoute(): RouteResult {
  return {
    state: 'blocked',
    polyline: null,
    lengthMeters: 0,
    etaSeconds: 0,
    shelter: null,
    message: 'No safe route — shelter in place / move to higher floors.',
  };
}

// ─── Draw the fake map + overlays each frame ────────────────────────────────────────────────────
const mask = document.createElement('canvas');
mask.width = 256;
mask.height = 256;
const mctx = mask.getContext('2d')!;
const maskImg = mctx.createImageData(256, 256);
let lastMaskLevel = NaN;
function updateMask() {
  const level = waterLevel() + Math.min(simTime / 3600, 1) * 0.6;
  if (Math.abs(level - lastMaskLevel) < 0.05) return;
  lastMaskLevel = level;
  const mode = store.get().render.waterMode;
  for (let j = 0; j < 256; j++) {
    for (let i = 0; i < 256; i++) {
      const e = elevation[(j * 4) * NX + i * 4];
      const d = level - e;
      const k = 4 * (j * 256 + i);
      if (d <= 0) {
        maskImg.data[k + 3] = 0;
        continue;
      }
      if (mode === 'realistic') {
        maskImg.data[k] = 70; maskImg.data[k + 1] = 95; maskImg.data[k + 2] = 92;
        maskImg.data[k + 3] = Math.min(230, 120 + d * 40);
      } else {
        const t = Math.min(1, d / 4);
        maskImg.data[k] = 220 - t * 210; maskImg.data[k + 1] = 240 - t * 196; maskImg.data[k + 2] = 163 + t * -31;
        maskImg.data[k + 3] = 200;
      }
    }
  }
  mctx.putImageData(maskImg, 0, 0);
}
store.subscribe((s, p) => {
  if (s.render.waterMode !== p.render.waterMode) lastMaskLevel = NaN;
});

let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  tools.update(dt);
  const s = store.get();
  ctx2d.fillStyle = '#05070d';
  ctx2d.fillRect(0, 0, vw, vh);
  ctx2d.imageSmoothingEnabled = true;
  ctx2d.drawImage(terrainImage, ox, oy, S, S);
  updateMask();
  ctx2d.drawImage(mask, ox, oy, S, S);
  const px = S / NX;

  // Walls
  ctx2d.lineCap = 'round';
  for (const w of walls) {
    const [ax, ay] = toCss(w.ax, w.ay);
    const [bx, by] = toCss(w.bx, w.by);
    ctx2d.strokeStyle = '#d9c9a6';
    ctx2d.lineWidth = Math.max(3, w.radius * 2 * px);
    ctx2d.beginPath(); ctx2d.moveTo(ax, ay); ctx2d.lineTo(bx, by); ctx2d.stroke();
  }
  const t = tools.getTransientOverlay();
  if (t.wallPreview) {
    const p = t.wallPreview.pts;
    ctx2d.strokeStyle = 'rgba(255,190,90,0.75)';
    ctx2d.lineWidth = Math.max(3, t.wallPreview.radius * 2 * px);
    ctx2d.beginPath();
    for (let k = 0; k < p.length; k += 2) {
      const [x, y] = toCss(p[k], p[k + 1]);
      if (k === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
  }
  // Storms, sources, shelters, evac
  for (const st of s.storms) {
    const [x, y] = toCss(st.gx, st.gy);
    ctx2d.fillStyle = 'rgba(150,140,255,0.18)';
    ctx2d.strokeStyle = 'rgba(180,170,255,0.6)';
    ctx2d.lineWidth = 1.5;
    ctx2d.beginPath(); ctx2d.arc(x, y, st.radius * px, 0, Math.PI * 2); ctx2d.fill(); ctx2d.stroke();
  }
  for (const src of s.sources) {
    const [x, y] = toCss(src.gx, src.gy);
    ctx2d.fillStyle = src.type === 'inflow' ? '#3aa8ff' : '#72d2ff';
    ctx2d.beginPath(); ctx2d.arc(x, y, 6, 0, Math.PI * 2); ctx2d.fill();
  }
  for (const sh of s.shelters) {
    const [x, y] = toCss(sh.gx, sh.gy);
    ctx2d.fillStyle = '#3ddc97';
    ctx2d.beginPath(); ctx2d.arc(x, y, 7, 0, Math.PI * 2); ctx2d.fill();
  }
  if (s.route?.state === 'ok' && s.route.polyline && s.evacStart) {
    const p = s.route.polyline;
    ctx2d.strokeStyle = '#5ff0ff';
    ctx2d.lineWidth = 4;
    ctx2d.shadowColor = '#3fd8ff';
    ctx2d.shadowBlur = 12;
    ctx2d.beginPath();
    for (let k = 0; k < p.length; k += 2) {
      const [x, y] = toCss(p[k], p[k + 1]);
      if (k === 0) ctx2d.moveTo(x, y); else ctx2d.lineTo(x, y);
    }
    ctx2d.stroke();
    ctx2d.shadowBlur = 0;
  }
  if (s.evacStart) {
    const [x, y] = toCss(s.evacStart.gx, s.evacStart.gy);
    ctx2d.fillStyle = '#fff';
    ctx2d.beginPath(); ctx2d.arc(x, y, 7, 0, Math.PI * 2); ctx2d.fill();
  }
  if (t.cursor) {
    const [x, y] = toCss(t.cursor.gx, t.cursor.gy);
    const [r, g, b] = t.cursor.color;
    ctx2d.strokeStyle = `rgb(${r * 255},${g * 255},${b * 255})`;
    ctx2d.lineWidth = 2;
    ctx2d.beginPath(); ctx2d.arc(x, y, Math.max(4, t.cursor.radius * px), 0, Math.PI * 2); ctx2d.stroke();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ─── URL-driven states for screenshots ──────────────────────────────────────────────────────────
const tool = params.get('tool') as ToolId | null;
if (tool) {
  const btn = document.querySelector<HTMLButtonElement>(`.dl-tool[data-tool="${tool}"]`);
  btn?.click();
}
if (params.get('paused')) store.set({ paused: true });
if (params.get('naive')) actions.setStabilityDemo(true);
if (params.get('stage')) {
  const ft = Number(params.get('stage'));
  store.set({ stageOffset: ft * 0.3048 + scenario.stage!.gaugeDatum - scenario.stage!.normalLevel });
}
if (params.get('rain')) store.set({ sim: { ...store.get().sim, rainRate: Number(params.get('rain')) } });
if (params.get('mode')) store.set({ render: { ...store.get().render, waterMode: params.get('mode') as WaterViewMode } });
if (params.get('route') && params.get('route') !== 'none') store.set({ evacStart: { gx: 420, gy: 560 } });
if (params.get('error'))
  store.set({ error: 'Couldn’t reach elevation.nationalmap.gov (HTTP 503). Falling back to the offline sandbox valley — your walls and sources were kept.' });
if (params.get('loading')) {
  // Freeze a loading state mid-way for the screenshot.
  store.set({ loading: { message: 'Fetching USGS 3DEP elevation (1024 × 1024)…', progress: 0.42 } });
}
if (params.get('closed')) document.querySelector<HTMLButtonElement>('.dl-panel-toggle')?.click();
const panel = params.get('panel');
if (panel === 'help') store.set({ panels: { ...store.get().panels, help: true } });
if (panel === 'how') store.set({ panels: { ...store.get().panels, howItWorks: true } });
if (panel === 'picker') store.set({ panels: { ...store.get().panels, locationPicker: true } });
const scroll = params.get('scroll');
if (scroll) setTimeout(() => document.querySelector('.dl-how .dl-modal-body')?.scrollTo({ top: Number(scroll) }), 400);
const probe = params.get('probe');
if (probe) {
  const [x, y] = probe.split(',').map(Number);
  setTimeout(() => {
    for (const type of ['pointerenter', 'pointermove']) {
      const ev = new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1 });
      canvas.dispatchEvent(ev);
    }
  }, 300);
}
routeMode = params.get('route') ?? 'cycle';
