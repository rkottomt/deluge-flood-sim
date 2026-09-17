/**
 * Visual harness for the routing module (served by Vite at /tests/routing/harness.html).
 *
 *   ?data=city  synthetic 20×20-block city with a river and two bridges   &scene=dry|floodA|floodBoth|wet|startWater
 *   ?data=pgh   the shipped Pittsburgh preset (public/presets/pittsburgh)   &level=<m above normal pool>
 *   &start=gx,gy  start point
 *
 * window.__harness = { ready, bench(), state() } for screenshot automation (bench = warm in-browser timings).
 */
import { createRouter, type DelugeRouteResult } from '../../src/routing/index';
import type { RoadNetwork, Shelter } from '../../src/contracts';
import type { PresetMeta } from '../../src/data/presets';
import { floodRect, makeCity, shelterAt } from './city';
import { PLACES, pittsburghWorld } from './pittsburghPreset';

interface World {
  name: string;
  nx: number;
  ny: number;
  cellSize: number;
  net: RoadNetwork;
  elev: Float32Array | null;
  shelters: Shelter[];
  baseline: Float32Array;
  /** Controls to show for this world. */
  controls: Array<{ label: string; apply: () => Float32Array }>;
  initialDepth: () => Float32Array;
  defaultStart: { gx: number; gy: number };
}

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const $ = (id: string) => document.getElementById(id)!;
const router = createRouter();

let world: World;
let depth: Float32Array;
let start: { gx: number; gy: number } | null = null;
let lastRoute: DelugeRouteResult | null = null;
let timings = '';
let background: ImageBitmap | null = null;

// ─── worlds ──────────────────────────────────────────────────────────────────────────────────

function cityWorld(): World {
  const city = makeCity();
  const ax = city.pos(city.bridgeACol, 0).gx;
  const bx = city.pos(city.bridgeBCol, 0).gx;
  const floodA = (d: Float32Array) => floodRect(d, city.nx, ax - 14, city.riverY0 - 14, ax + 14, city.riverY1 + 14, 1.2);
  const floodB = (d: Float32Array) => floodRect(d, city.nx, bx - 14, city.riverY0 - 14, bx + 14, city.riverY1 + 14, 1.2);
  const sp = city.pos(city.bridgeACol + 1, 6);
  const defaultStart = { gx: sp.gx + 4, gy: sp.gy + 7 };
  const hp = city.pos(city.bridgeACol, 16);
  const scenes: Record<string, () => Float32Array> = {
    dry: () => city.baseline(),
    floodA: () => {
      const d = city.baseline();
      floodA(d);
      return d;
    },
    floodBoth: () => {
      const d = city.baseline();
      floodA(d);
      floodB(d);
      return d;
    },
    wet: () => {
      const d = city.baseline();
      for (let k = 0; k < d.length; k++) if (d[k] === 0) d[k] = 0.1;
      floodRect(d, city.nx, 300, 60, 420, 150, 0.6);
      return d;
    },
    startWater: () => {
      const d = city.baseline();
      floodRect(d, city.nx, defaultStart.gx - 20, defaultStart.gy - 20, defaultStart.gx + 20, defaultStart.gy + 20, 0.8);
      return d;
    },
  };
  return {
    name: 'Synthetic city',
    nx: city.nx,
    ny: city.ny,
    cellSize: city.cellSize,
    net: city.net,
    elev: null,
    shelters: [shelterAt('Hilltop School', hp.gx + 6, hp.gy + 5), shelterAt('East Clinic', city.pos(19, 17).gx + 5, city.pos(19, 17).gy + 4)],
    baseline: city.baseline(),
    controls: Object.entries(scenes).map(([label, apply]) => ({ label, apply })),
    initialDepth: scenes[params.get('scene') ?? 'dry'] ?? scenes.dry,
    defaultStart,
  };
}

async function pghWorld(): Promise<World> {
  const base = '/presets/pittsburgh';
  const meta = (await fetch(`${base}/meta.json`).then((r) => r.json())) as PresetMeta;
  const [roads, elevBuf] = await Promise.all([
    fetch(`${base}/${meta.files.roads}`).then((r) => r.json()),
    fetch(`${base}/${meta.files.elevation}`).then((r) => r.arrayBuffer()),
  ]);
  const w = pittsburghWorld(meta, elevBuf, roads);
  const abovePool = (level: number) => `+${(level - w.pool).toFixed(1)} m`;
  const controls = [
    { label: 'Normal pool', apply: () => w.bathtub(w.pool) },
    ...w.marks.map((m) => ({ label: `${m.label} ${m.ft} ft (${abovePool(m.level)})`, apply: () => w.bathtub(m.level) })),
    ...[8, 12].map((dz) => ({ label: `+${dz} m`, apply: () => w.bathtub(w.pool + dz) })),
  ];
  const initialLevel = Number(params.get('level') ?? 0);
  return {
    name: 'Pittsburgh preset (TIGER roads, USGS 3DEP)',
    nx: w.nx,
    ny: w.ny,
    cellSize: w.cellSize,
    net: w.roads,
    elev: w.elevation,
    shelters: w.shelters,
    baseline: w.initialWater,
    controls,
    initialDepth: () => w.bathtub(w.pool + (Number.isFinite(initialLevel) ? initialLevel : 0)),
    defaultStart: w.at(PLACES.downtown.lon, PLACES.downtown.lat),
  };
}

// ─── drawing ─────────────────────────────────────────────────────────────────────────────────

async function drawBackground(): Promise<void> {
  const { nx, ny, elev } = world;
  const img = new ImageData(nx, ny);
  let lo = Infinity, hi = -Infinity;
  if (elev) for (const v of elev) (lo = Math.min(lo, v)), (hi = Math.max(hi, v));
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      let r = 32, g = 38, b = 34;
      if (elev) {
        const e = elev[k];
        const ex = elev[j * nx + Math.min(nx - 1, i + 1)] - elev[j * nx + Math.max(0, i - 1)];
        const ey = elev[Math.min(ny - 1, j + 1) * nx + i] - elev[Math.max(0, j - 1) * nx + i];
        const shade = Math.max(0.35, Math.min(1.3, 0.85 + (-ex + ey) * 0.05));
        const t = (e - lo) / (hi - lo);
        r = (40 + 60 * t) * shade;
        g = (48 + 58 * t) * shade;
        b = (40 + 40 * t) * shade;
      }
      const d = depth[k];
      if (d > 0.01) {
        const a = Math.min(0.92, 0.45 + d * 0.12);
        const base = world.baseline[k] > 0.05;
        const wr = base ? 30 : 40, wg = base ? 80 : 110, wb = base ? 140 : 190;
        r = r * (1 - a) + wr * a;
        g = g * (1 - a) + wg * a;
        b = b * (1 - a) + wb * a;
      }
      img.data[4 * k] = r;
      img.data[4 * k + 1] = g;
      img.data[4 * k + 2] = b;
      img.data[4 * k + 3] = 255;
    }
  }
  background = await createImageBitmap(img);
}

function draw(): void {
  const { nx, net } = world;
  const scale = canvas.width / nx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (background) ctx.drawImage(background, 0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const status = router.getRoadStatus();
  const colors = ['#8a96a3', '#ffb020', '#ff3b3b'];
  const widthBy = { highway: 2.6, major: 1.8, minor: 1.3, local: 1.0 };
  for (const pass of [0, 1, 2]) {
    for (const cls of ['local', 'minor', 'major', 'highway'] as const) {
      ctx.beginPath();
      let any = false;
      net.edges.forEach((e, k) => {
        if (e.cls !== cls || (status ? status[k] : 0) !== pass) return;
        any = true;
        ctx.moveTo(e.pts[0], e.pts[1]);
        for (let q = 2; q < e.pts.length; q += 2) ctx.lineTo(e.pts[q], e.pts[q + 1]);
      });
      if (!any) continue;
      ctx.strokeStyle = colors[pass];
      ctx.globalAlpha = pass === 0 ? 0.55 : 0.95;
      ctx.lineWidth = (widthBy[cls] * (pass === 0 ? 1 : 1.5)) / scale;
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const r = lastRoute;
  if (r?.polyline) {
    const p = r.polyline;
    const path = new Path2D();
    path.moveTo(p[0], p[1]);
    for (let q = 2; q < p.length; q += 2) path.lineTo(p[q], p[q + 1]);
    if (r.state === 'ok') {
      ctx.strokeStyle = 'rgba(94,232,255,0.25)';
      ctx.lineWidth = 12 / scale;
      ctx.stroke(path);
      ctx.strokeStyle = '#5ee8ff';
      ctx.lineWidth = 4 / scale;
      ctx.stroke(path);
    } else {
      ctx.setLineDash([10 / scale, 7 / scale]);
      ctx.strokeStyle = '#ff5a5a';
      ctx.lineWidth = 4 / scale;
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  }

  const pin = (x: number, y: number, fill: string, label?: string) => {
    ctx.beginPath();
    ctx.arc(x, y, 7 / scale, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = 2 / scale;
    ctx.strokeStyle = '#0b1016';
    ctx.stroke();
    if (label) {
      ctx.font = `${13 / scale}px system-ui`;
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3 / scale;
      ctx.strokeText(label, x + 10 / scale, y + 4 / scale);
      ctx.fillText(label, x + 10 / scale, y + 4 / scale);
    }
  };
  for (const s of world.shelters) pin(s.gx, s.gy, '#3ddc84', s.name);
  if (start) pin(start.gx, start.gy, '#ffffff', 'Start');

  const msg = $('msg');
  msg.textContent = r ? r.message : '—';
  msg.className = `msg ${r?.state ?? 'none'}`;
  $('detail').textContent = r
    ? `state=${r.state}${r.reason ? ` (${r.reason})` : ''}  length=${Math.round(r.lengthMeters)} m  eta=${Math.round(r.etaSeconds)} s  ` +
      `wet=${Math.round(r.wetMeters)} m  shelter=${r.shelter?.name ?? '—'}  via=${r.via.join(' → ') || '—'}  points=${(r.polyline?.length ?? 0) / 2}`
    : '';
  $('timing').textContent = timings;
}

// ─── flow ────────────────────────────────────────────────────────────────────────────────────

async function applyDepth(d: Float32Array): Promise<void> {
  depth = d;
  const t0 = performance.now();
  router.updateFlood(depth, world.nx, world.ny);
  const t1 = performance.now();
  replan(t1 - t0);
  await drawBackground();
  draw();
}

function replan(updateMs?: number): void {
  const t0 = performance.now();
  lastRoute = router.route(start, world.shelters);
  const routeMs = performance.now() - t0;
  const info = router.getGraphInfo();
  const status = router.getRoadStatus();
  const counts = [0, 0, 0];
  if (status) for (const s of status) counts[s]++;
  timings =
    `${world.name}: ${info?.edges} edges, ${info?.nodes} nodes, ${info?.samples} samples (${info?.activeSamples} active)\n` +
    `${updateMs !== undefined ? `updateFlood ${updateMs.toFixed(2)} ms · ` : ''}route ${routeMs.toFixed(2)} ms · dry/wet/flooded ${counts.join('/')}`;
}

async function main(): Promise<void> {
  world = params.get('data') === 'pgh' ? await pghWorld() : cityWorld();
  canvas.width = canvas.height = world.nx;
  const t0 = performance.now();
  router.setNetwork(world.net, world.cellSize, { nx: world.nx, ny: world.ny });
  const buildMs = performance.now() - t0;
  router.setBaselineWater(world.baseline, world.nx, world.ny);
  const s = params.get('start');
  start = s ? { gx: Number(s.split(',')[0]), gy: Number(s.split(',')[1]) } : world.defaultStart;

  const controls = $('controls');
  for (const c of world.controls) {
    const b = document.createElement('button');
    b.textContent = c.label;
    b.onclick = () => void applyDepth(c.apply());
    controls.appendChild(b);
  }
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    start = { gx: ((ev.clientX - rect.left) / rect.width) * world.nx, gy: ((ev.clientY - rect.top) / rect.height) * world.ny };
    replan();
    draw();
  });
  await applyDepth(world.initialDepth());
  timings = `setNetwork ${buildMs.toFixed(1)} ms\n` + timings;
  draw();
  console.log(`[harness] ${lastRoute?.state}: ${lastRoute?.message}`);
}

/** Warm in-browser timings: alternating flood levels for updateFlood, random starts for route. */
function bench(): Record<string, number> {
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const fields = world.controls.slice(0, 4).map((c) => c.apply());
  const up: number[] = [];
  for (let k = 0; k < 40; k++) {
    const t0 = performance.now();
    router.updateFlood(fields[k % fields.length], world.nx, world.ny);
    if (k >= 8) up.push(performance.now() - t0);
  }
  const rt: number[] = [];
  let seed = 11;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let k = 0; k < 120; k++) {
    const st = { gx: rand() * world.nx, gy: rand() * world.ny };
    const t0 = performance.now();
    router.route(st, world.shelters);
    if (k >= 20) rt.push(performance.now() - t0);
  }
  const t0 = performance.now();
  router.setNetwork(world.net, world.cellSize, { nx: world.nx, ny: world.ny });
  const build = performance.now() - t0;
  router.setBaselineWater(world.baseline, world.nx, world.ny);
  router.updateFlood(depth, world.nx, world.ny);
  return { updateFloodMedian: median(up), updateFloodMax: Math.max(...up), routeMedian: median(rt), routeMax: Math.max(...rt), setNetworkWarm: build };
}

const ready = main();
(window as unknown as { __harness: unknown }).__harness = {
  ready,
  bench,
  state: () => ({ route: lastRoute && { ...lastRoute, polyline: lastRoute.polyline ? lastRoute.polyline.length / 2 : 0 }, timings }),
};
