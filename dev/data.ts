// Deluge — data module dev harness: top-down 2D inspection of presets and live areas.
// URL: /dev/data.html?preset=pittsburgh   or   /dev/data.html?live=40.015,-105.27,6000[,1024]
import { computeInitialWater, gridToGeo, listPresets, loadLiveArea, loadPreset } from '../src/data/index';
import type { RoadClass, TerrainData } from '../src/contracts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const logEl = $('log');

let resolveReady!: (v: unknown) => void;
(window as any).__dataReady = new Promise((r) => (resolveReady = r));

function log(msg: string) {
  logEl.textContent += `${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(`[data-dev] ${msg}`);
}

interface Loaded {
  t: TerrainData;
  h0: Float32Array;
  shade: HTMLCanvasElement;
  water: HTMLCanvasElement;
  imagery: HTMLCanvasElement | null;
  loadMs: number;
}
let cur: Loaded | null = null;
const view = { scale: 1, ox: 0, oy: 0 };

const layers = () => ({
  imagery: ($('lyImagery') as HTMLInputElement).checked,
  shade: ($('lyShade') as HTMLInputElement).checked,
  water: ($('lyWater') as HTMLInputElement).checked,
  roads: ($('lyRoads') as HTMLInputElement).checked,
  markers: ($('lyMarkers') as HTMLInputElement).checked,
  seeds: ($('lySeeds') as HTMLInputElement).checked,
});

function buildShade(t: TerrainData): HTMLCanvasElement {
  const { nx, ny, elevation: e, cellSize } = t;
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < e.length; k += 7) {
    lo = Math.min(lo, e[k]);
    hi = Math.max(hi, e[k]);
  }
  const c = document.createElement('canvas');
  c.width = nx;
  c.height = ny;
  const img = c.getContext('2d')!.createImageData(nx, ny);
  const L = [-0.5, -0.6, 0.62];
  const ll = Math.hypot(L[0], L[1], L[2]);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const zl = e[j * nx + Math.max(0, i - 1)];
      const zr = e[j * nx + Math.min(nx - 1, i + 1)];
      const zu = e[Math.max(0, j - 1) * nx + i];
      const zd = e[Math.min(ny - 1, j + 1) * nx + i];
      const dx = (zr - zl) / (2 * cellSize);
      const dy = (zd - zu) / (2 * cellSize);
      const nl = Math.hypot(dx, dy, 1);
      // normal = (-dx, -dy, 1) with y pointing south in image space
      const s = Math.max(0, (-dx * L[0] + -dy * L[1] + L[2]) / (nl * ll));
      const tt = (e[k] - lo) / Math.max(1, hi - lo);
      // hypsometric tint: green lowlands → tan → light
      const r = 70 + 150 * tt;
      const g = 110 + 90 * tt;
      const b = 70 + 110 * tt * tt;
      const sh = 0.35 + 0.75 * s;
      img.data[k * 4] = Math.min(255, r * sh);
      img.data[k * 4 + 1] = Math.min(255, g * sh);
      img.data[k * 4 + 2] = Math.min(255, b * sh);
      img.data[k * 4 + 3] = 255;
    }
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function buildWater(t: TerrainData, h0: Float32Array): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = t.nx;
  c.height = t.ny;
  const img = c.getContext('2d')!.createImageData(t.nx, t.ny);
  for (let k = 0; k < h0.length; k++) {
    const h = h0[k];
    if (h <= 0.005) continue;
    const a = Math.min(1, 0.45 + h / 8);
    img.data[k * 4] = 20;
    img.data[k * 4 + 1] = 110 - Math.min(60, h * 8);
    img.data[k * 4 + 2] = 255;
    img.data[k * 4 + 3] = 255 * a;
  }
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

function fitView() {
  if (!cur) return;
  const w = canvas.width;
  const h = canvas.height;
  view.scale = Math.min(w / cur.t.nx, h / cur.t.ny);
  view.ox = (w - cur.t.nx * view.scale) / 2;
  view.oy = (h - cur.t.ny * view.scale) / 2;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.round(r.width * devicePixelRatio);
  canvas.height = Math.round(r.height * devicePixelRatio);
  fitView();
  draw();
}

const ROAD_STYLE: Record<RoadClass, { color: string; width: number }> = {
  highway: { color: '#ff9f1c', width: 3 },
  major: { color: '#ffe066', width: 2.2 },
  minor: { color: '#f5f5f5', width: 1.6 },
  local: { color: '#9aa7b3', width: 1 },
};

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#05080c';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!cur) return;
  const { t } = cur;
  const L = layers();
  const px = 1 / view.scale; // one device pixel in grid units
  ctx.setTransform(view.scale, 0, 0, view.scale, view.ox, view.oy);
  ctx.imageSmoothingEnabled = view.scale < 2;
  if (L.imagery && cur.imagery) {
    ctx.drawImage(cur.imagery, 0, 0, t.nx, t.ny);
    if (L.shade) {
      ctx.globalAlpha = 0.25;
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(cur.shade, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
  } else if (L.shade) {
    ctx.drawImage(cur.shade, 0, 0);
  }
  if (L.water) {
    ctx.globalAlpha = L.imagery && cur.imagery ? 0.6 : 0.9;
    ctx.drawImage(cur.water, 0, 0);
    ctx.globalAlpha = 1;
  }
  const sw = Math.max(1, devicePixelRatio);
  if (L.roads && t.roads) {
    for (const cls of ['local', 'minor', 'major', 'highway'] as RoadClass[]) {
      const st = ROAD_STYLE[cls];
      ctx.beginPath();
      for (const e of t.roads.edges) {
        if (e.cls !== cls) continue;
        ctx.moveTo(e.pts[0], e.pts[1]);
        for (let q = 2; q < e.pts.length; q += 2) ctx.lineTo(e.pts[q], e.pts[q + 1]);
      }
      ctx.strokeStyle = st.color;
      ctx.globalAlpha = cls === 'local' ? 0.75 : 0.95;
      ctx.lineWidth = st.width * sw * px;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // nodes when zoomed in
    if (view.scale > 3) {
      ctx.fillStyle = '#ff3b8d';
      const r = 1.6 * sw * px;
      for (let k = 0; k < t.roads.nodes.length; k += 2) ctx.fillRect(t.roads.nodes[k] - r, t.roads.nodes[k + 1] - r, 2 * r, 2 * r);
    }
  }
  const s = t.scenario;
  if (s && L.seeds) {
    ctx.fillStyle = '#00ffd0';
    for (const f of s.initialFill) {
      for (const sd of f.seeds) {
        ctx.beginPath();
        ctx.arc(sd.gx, sd.gy, 2.2 * sw * px, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  if (s && L.markers) {
    for (const st of s.storms) {
      ctx.beginPath();
      ctx.arc(st.gx, st.gy, st.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120,140,255,0.16)';
      ctx.fill();
      ctx.setLineDash([8 * px, 6 * px]);
      ctx.strokeStyle = '#9fb0ff';
      ctx.lineWidth = 2 * sw * px;
      ctx.stroke();
      ctx.setLineDash([]);
      label(`storm ${st.intensity} mm/hr`, st.gx, st.gy, '#c9d2ff', px);
    }
    for (const src of s.sources) {
      ctx.beginPath();
      ctx.arc(src.gx, src.gy, Math.max(src.radius, 3 * px), 0, Math.PI * 2);
      ctx.fillStyle = src.type === 'inflow' ? 'rgba(40,160,255,0.45)' : 'rgba(255,170,0,0.45)';
      ctx.fill();
      ctx.lineWidth = 2.5 * sw * px;
      ctx.strokeStyle = src.type === 'inflow' ? '#39a8ff' : '#ffb000';
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(src.gx, src.gy, 14 * sw * px, 0, Math.PI * 2);
      ctx.lineWidth = 1.5 * sw * px;
      ctx.stroke();
      const txt = src.type === 'inflow' ? `inflow ${src.discharge} m³/s` : `stage ${src.level.toFixed(2)} m`;
      label(`${src.label ?? src.id}: ${txt}`, src.gx, src.gy - 18 * px * sw, src.type === 'inflow' ? '#9fd6ff' : '#ffd27a', px);
    }
    for (const sh of s.shelters) {
      ctx.beginPath();
      const r = 7 * sw * px;
      ctx.moveTo(sh.gx, sh.gy);
      ctx.lineTo(sh.gx - r * 0.7, sh.gy - r * 1.6);
      ctx.arc(sh.gx, sh.gy - r * 1.9, r * 0.8, Math.PI * 0.8, Math.PI * 0.2);
      ctx.closePath();
      ctx.fillStyle = '#2ee67a';
      ctx.fill();
      ctx.strokeStyle = '#063';
      ctx.lineWidth = 1.2 * sw * px;
      ctx.stroke();
      label(sh.name, sh.gx, sh.gy - 26 * px * sw, '#a8ffc8', px);
    }
    if (s.camera) {
      const c = s.camera;
      const len = Math.min(c.distance / t.cellSize, t.nx * 0.3);
      // yaw 0 = looking north (−gy), clockwise → east (+gx). The camera sits behind the target.
      const fx = Math.sin(c.yaw);
      const fy = -Math.cos(c.yaw);
      const bx = c.target.gx - fx * len * Math.cos(c.pitch);
      const by = c.target.gy - fy * len * Math.cos(c.pitch);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(c.target.gx, c.target.gy);
      ctx.strokeStyle = '#ff5ad1';
      ctx.lineWidth = 2 * sw * px;
      ctx.setLineDash([6 * px, 5 * px]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(c.target.gx, c.target.gy, 6 * sw * px, 0, Math.PI * 2);
      ctx.stroke();
      label('camera', bx, by, '#ff9fe6', px);
    }
  }
}

function label(text: string, gx: number, gy: number, color: string, px: number) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const x = gx * view.scale + view.ox;
  const y = gy * view.scale + view.oy;
  ctx.font = `${Math.round(11 * devicePixelRatio)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.lineWidth = 3 * devicePixelRatio;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
  void px;
}

function row(table: HTMLElement, k: string, v: string, cls = '') {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${k}</td><td class="${cls}">${v}</td>`;
  table.appendChild(tr);
}

function elevAt(t: TerrainData, gx: number, gy: number) {
  const i = Math.min(t.nx - 1, Math.max(0, Math.floor(gx)));
  const j = Math.min(t.ny - 1, Math.max(0, Math.floor(gy)));
  return t.elevation[j * t.nx + i];
}

function fillPanels(L: Loaded) {
  const { t, h0 } = L;
  $('title').textContent = t.name;
  $('subtitle').textContent = t.attribution;
  const tt = $('terrainTable');
  tt.innerHTML = '';
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of t.elevation) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  row(tt, 'grid', `${t.nx} × ${t.ny} @ ${t.cellSize.toFixed(2)} m (${((t.nx * t.cellSize) / 1000).toFixed(2)} km)`);
  row(tt, 'bounds', `${t.bounds.south.toFixed(5)}, ${t.bounds.west.toFixed(5)} → ${t.bounds.north.toFixed(5)}, ${t.bounds.east.toFixed(5)}`);
  row(tt, 'elevation', `${lo.toFixed(1)} … ${hi.toFixed(1)} m`);
  row(tt, 'imagery', t.imagery ? `${t.imagery.width} × ${t.imagery.height}` : 'none');
  if (t.roads) {
    const by: Record<string, number> = {};
    let km = 0;
    for (const e of t.roads.edges) {
      by[e.cls] = (by[e.cls] ?? 0) + 1;
      km += e.length;
    }
    row(tt, 'roads', `${t.roads.nodes.length / 2} nodes, ${t.roads.edges.length} edges, ${(km / 1000).toFixed(0)} km`);
    row(tt, 'by class', Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', '));
  } else row(tt, 'roads', 'none');
  row(tt, 'load time', `${L.loadMs.toFixed(0)} ms`);

  const s = t.scenario;
  $('desc').textContent = s?.description ?? '(no scenario)';
  const st = $('scenarioTable');
  st.innerHTML = '';
  const ct = $('checksTable');
  ct.innerHTML = '';
  let wet = 0;
  let maxH = 0;
  let vol = 0;
  for (const h of h0) {
    if (h > 0.01) wet++;
    maxH = Math.max(maxH, h);
    vol += h;
  }
  row(ct, 'initial water', `${wet} cells, max ${maxH.toFixed(2)} m, ${((vol * t.cellSize * t.cellSize) / 1e6).toFixed(2)} Mm³`, wet > 0 || !s?.initialFill.length ? 'ok' : 'bad');
  if (!s) return;
  row(st, 'sources', `${s.sources.length}`);
  row(st, 'storms', s.storms.map((x) => `${x.intensity} mm/hr r=${(x.radius * t.cellSize).toFixed(0)} m`).join(', ') || 'none');
  row(st, 'rain', `${s.rainRate} mm/hr`);
  if (s.stage) {
    const g = s.stage;
    const ft = (m: number) => ((m - g.gaugeDatum) / 0.3048).toFixed(1);
    row(st, 'stage', g.label);
    row(st, 'datum / normal', `${g.gaugeDatum.toFixed(2)} m / ${g.normalLevel.toFixed(2)} m (${ft(g.normalLevel)} ft)`);
    row(st, 'flood stage', g.floodStageFt !== undefined ? `${g.floodStageFt} ft = ${(g.gaugeDatum + g.floodStageFt * 0.3048).toFixed(2)} m` : '—');
    for (const m of g.marks ?? []) row(st, m.label, `${m.ft} ft = ${(g.gaugeDatum + m.ft * 0.3048).toFixed(2)} m (offset +${(g.gaugeDatum + m.ft * 0.3048 - g.normalLevel).toFixed(2)} m)`);
    row(st, 'max offset', `${g.maxOffset} m → ${ft(g.normalLevel + g.maxOffset)} ft`);
  }
  for (const src of s.sources) {
    const k = Math.floor(src.gy) * t.nx + Math.floor(src.gx);
    const depth = h0[k];
    const inside = src.gx - src.radius >= 0 && src.gy - src.radius >= 0 && src.gx + src.radius <= t.nx && src.gy + src.radius <= t.ny;
    const onRiver = depth > 0.3;
    row(ct, src.id, `${src.type} r=${src.radius} · depth ${depth.toFixed(2)} m · ${inside ? 'inside' : 'CROSSES EDGE'}`, onRiver && inside ? 'ok' : 'bad');
  }
  const ceiling = s.stage ? s.stage.normalLevel + s.stage.maxOffset : null;
  for (const sh of s.shelters) {
    const z = elevAt(t, sh.gx, sh.gy);
    const ok = ceiling === null || z > ceiling + 2;
    row(ct, sh.name, `${z.toFixed(1)} m${ceiling !== null ? ` (+${(z - ceiling).toFixed(1)} over max stage)` : ''}`, ok ? 'ok' : 'bad');
  }
}

async function show(loader: () => Promise<TerrainData>) {
  const bar = $('progress');
  const t0 = performance.now();
  try {
    const t = await loader();
    const loadMs = performance.now() - t0;
    log(`loaded "${t.name}" in ${loadMs.toFixed(0)} ms`);
    const h0 = computeInitialWater(t, t.scenario);
    let imagery: HTMLCanvasElement | null = null;
    if (t.imagery) {
      imagery = document.createElement('canvas');
      imagery.width = t.imagery.width;
      imagery.height = t.imagery.height;
      imagery.getContext('2d')!.drawImage(t.imagery, 0, 0);
    }
    cur = { t, h0, shade: buildShade(t), water: buildWater(t, h0), imagery, loadMs };
    (window as any).__data = { terrain: t, initialWater: h0, loadMs };
    fillPanels(cur);
    fitView();
    draw();
    bar.style.width = '100%';
    resolveReady({ name: t.name, loadMs });
  } catch (e) {
    log(`ERROR: ${(e as Error).message}`);
    console.error(e);
    $('subtitle').textContent = `Error: ${(e as Error).message}`;
    resolveReady({ error: String(e) });
  }
}

function progress(msg: string, f: number) {
  ($('progress') as HTMLDivElement).style.width = `${(f * 100).toFixed(0)}%`;
  $('subtitle').textContent = msg;
  log(`${(f * 100).toFixed(0).padStart(3)}% ${msg}`);
}

// ── UI wiring
const sel = $('presetSel') as HTMLSelectElement;
for (const p of listPresets()) {
  const o = document.createElement('option');
  o.value = p.id;
  o.textContent = p.name;
  sel.appendChild(o);
}
$('loadBtn').onclick = () => {
  history.replaceState(null, '', `?preset=${sel.value}`);
  show(() => loadPreset(sel.value, progress));
};
$('liveBtn').onclick = () => {
  const v = ($('liveInput') as HTMLInputElement).value;
  history.replaceState(null, '', `?live=${v}`);
  startLive(v);
};
for (const id of ['lyImagery', 'lyShade', 'lyWater', 'lyRoads', 'lyMarkers', 'lySeeds']) $(id).addEventListener('change', draw);

function startLive(spec: string) {
  const [lat, lon, size, res] = spec.split(',').map(Number);
  show(() =>
    loadLiveArea(
      { center: { lat, lon }, sizeMeters: size || 6000, resolution: ((res || 1024) as 512 | 1024 | 2048), name: `Live ${lat.toFixed(4)}, ${lon.toFixed(4)}` },
      progress,
    ),
  );
}

let drag: { x: number; y: number } | null = null;
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = (ev.clientX - r.left) * devicePixelRatio;
  const my = (ev.clientY - r.top) * devicePixelRatio;
  const f = Math.exp(-ev.deltaY * 0.0015);
  view.ox = mx - (mx - view.ox) * f;
  view.oy = my - (my - view.oy) * f;
  view.scale *= f;
  draw();
});
canvas.addEventListener('pointerdown', (ev) => {
  drag = { x: ev.clientX, y: ev.clientY };
  canvas.setPointerCapture(ev.pointerId);
});
canvas.addEventListener('pointerup', () => (drag = null));
canvas.addEventListener('dblclick', () => {
  fitView();
  draw();
});
canvas.addEventListener('pointermove', (ev) => {
  if (drag) {
    view.ox += (ev.clientX - drag.x) * devicePixelRatio;
    view.oy += (ev.clientY - drag.y) * devicePixelRatio;
    drag = { x: ev.clientX, y: ev.clientY };
    draw();
  }
  if (!cur) return;
  const r = canvas.getBoundingClientRect();
  const gx = ((ev.clientX - r.left) * devicePixelRatio - view.ox) / view.scale;
  const gy = ((ev.clientY - r.top) * devicePixelRatio - view.oy) / view.scale;
  const t = cur.t;
  if (gx < 0 || gy < 0 || gx >= t.nx || gy >= t.ny) return;
  const g = gridToGeo(t, gx, gy);
  const k = Math.floor(gy) * t.nx + Math.floor(gx);
  $('hover').textContent = `grid ${gx.toFixed(1)}, ${gy.toFixed(1)}\n${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}\nz ${t.elevation[k].toFixed(2)} m  h0 ${cur.h0[k].toFixed(2)} m`;
});

/** Automation: zoom to a grid rectangle (used for screenshot crops). */
(window as any).__zoomTo = (gx0: number, gy0: number, gx1: number, gy1: number) => {
  const s = Math.min(canvas.width / (gx1 - gx0), canvas.height / (gy1 - gy0));
  view.scale = s;
  view.ox = -gx0 * s + (canvas.width - (gx1 - gx0) * s) / 2;
  view.oy = -gy0 * s + (canvas.height - (gy1 - gy0) * s) / 2;
  draw();
};
(window as any).__setLayers = (o: Record<string, boolean>) => {
  const map: Record<string, string> = { imagery: 'lyImagery', shade: 'lyShade', water: 'lyWater', roads: 'lyRoads', markers: 'lyMarkers', seeds: 'lySeeds' };
  for (const [k, v] of Object.entries(o)) ($(map[k]) as HTMLInputElement).checked = v;
  draw();
};

window.addEventListener('resize', resize);
resize();
const params = new URLSearchParams(location.search);
if (params.get('live')) {
  ($('liveInput') as HTMLInputElement).value = params.get('live')!;
  startLive(params.get('live')!);
} else {
  const id = params.get('preset') ?? 'pittsburgh';
  sel.value = id;
  show(() => loadPreset(id, progress));
}
