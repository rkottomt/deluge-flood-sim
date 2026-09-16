/**
 * Bottom-left stats HUD and the cursor-following probe readout.
 * All values are bound to formatted strings, so the ~5 Hz stats stream only touches text nodes whose
 * text actually changed (tabular figures keep widths stable → no layout shift).
 */
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon } from './icons';
import {
  formatKm2,
  formatAcres,
  formatVolume,
  formatPools,
  formatMeters,
  formatFeet,
  formatSpeed,
  formatPercent,
  formatDt,
  formatSpeedup,
  formatLatLon,
  fmtNum,
  DASH,
} from './format';
import { waterHazard } from './scales';

export function createHud(ctx: UIContext, achievedSpeed: () => number | null): HTMLElement {
  const { bind, store } = ctx;

  const stat = (labelText: string, tip: string, big = false) => {
    const value = h('span', { class: 'dl-stat-value' }, DASH);
    const sub = h('span', { class: 'dl-stat-sub' });
    const el = h(
      'div',
      { class: `dl-stat${big ? ' dl-stat-big' : ''}`, 'data-tip': tip, 'data-tip-side': 'top' },
      h('span', { class: 'dl-stat-label' }, labelText),
      value,
      sub,
    );
    return { el, value, sub };
  };

  const area = stat('Flooded land', 'Area newly under ≥ 30 cm of water since reset', true);
  const volume = stat('Water volume', 'Total water stored on the map', true);
  const depth = stat('Max depth', 'Deepest water anywhere on the map');
  const speed = stat('Max speed', 'Fastest flow anywhere on the map');
  const mass = stat('Mass error', 'Relative mass-balance error: |V − (V₀ + in − out)| / (V₀ + in). Proves no water is created or destroyed.');
  const simSpeed = stat('Sim speed', 'Simulated seconds per real second actually achieved');

  bind((s) => formatKm2(s.stats?.floodedArea), (v) => setText(area.value, v));
  bind((s) => (s.stats ? formatAcres(s.stats.floodedArea) : ''), (v) => setText(area.sub, v));
  bind((s) => formatVolume(s.stats?.volume), (v) => setText(volume.value, v));
  bind((s) => (s.stats ? formatPools(s.stats.volume) : ''), (v) => setText(volume.sub, v));
  bind((s) => formatMeters(s.stats?.maxDepth), (v) => setText(depth.value, v));
  bind((s) => (s.stats ? formatFeet(s.stats.maxDepth) : ''), (v) => setText(depth.sub, v));
  bind((s) => formatSpeed(s.stats?.maxSpeed), (v) => setText(speed.value, v));
  bind((s) => (s.stats && Number.isFinite(s.stats.maxSpeed) ? `${fmtNum(s.stats.maxSpeed * 2.23694, 1)} mph` : ''), (v) => setText(speed.sub, v));
  bind((s) => formatPercent(s.stats?.massError), (v) => setText(mass.value, v));
  bind(
    (s) => {
      const e = s.stats?.massError;
      if (e === undefined || e === null) return 'calm';
      if (!Number.isFinite(e) || e > 0.01) return 'danger';
      if (e > 0.001) return 'warn';
      return 'ok';
    },
    (sev) => {
      mass.el.dataset.sev = sev;
      setText(mass.sub, sev === 'ok' ? 'conserved' : sev === 'warn' ? 'drifting' : sev === 'danger' ? 'unstable!' : '');
    },
  );
  bind(
    (s) => {
      if (s.paused) return 'paused';
      if (!s.stats) return DASH;
      const a = achievedSpeed();
      return formatSpeedup(a ?? s.sim.timeScale);
    },
    (v) => setText(simSpeed.value, v),
  );
  bind(
    (s) => (s.stepInfo?.throttled && !s.paused ? 'GPU-limited' : `of ${fmtNum(s.sim.timeScale, 0)}×`),
    (v) => setText(simSpeed.sub, v),
  );
  bind(
    (s) => !!s.stepInfo?.throttled && !s.paused,
    (t) => (simSpeed.el.dataset.sev = t ? 'warn' : 'calm'),
  );

  // Diagnostics strip.
  const diag = (labelText: string, tip: string) => {
    const v = h('b', null, DASH);
    const el = h('span', { class: 'dl-diag-item', 'data-tip': tip, 'data-tip-side': 'top' }, h('span', null, labelText), v);
    return { el, v };
  };
  const dDt = diag('Δt', 'Adaptive timestep per substep (CFL-limited)');
  const dSub = diag('substeps', 'Solver substeps this frame');
  const dCo = diag('Courant', 'Largest Courant number seen — must stay below 1 for stability');
  const dFps = diag('fps', 'Rendered frames per second');
  bind((s) => formatDt(s.stepInfo?.dt), (v) => setText(dDt.v, v));
  bind((s) => (s.stepInfo ? String(s.stepInfo.substeps) : DASH), (v) => setText(dSub.v, v));
  bind((s) => (s.stats ? fmtNum(s.stats.courant, 2) : DASH), (v) => setText(dCo.v, v));
  bind(
    (s) => {
      const c = s.stats?.courant;
      return c === undefined ? 'calm' : !Number.isFinite(c) || c > 1 ? 'danger' : c > 0.9 ? 'warn' : 'calm';
    },
    (sev) => (dCo.el.dataset.sev = sev),
  );
  bind((s) => fmtNum(s.fps, 0), (v) => setText(dFps.v, v));

  const gpu = h('span', { class: 'dl-hud-gpu' });
  bind((s) => s.gpuInfo, (v) => {
    setText(gpu, v || 'WebGPU');
    gpu.title = v;
  });

  // Compact probe line (always in HUD when a probe reading exists).
  const probeLine = h('div', { class: 'dl-hud-probe' });
  const probeText = h('span');
  probeLine.append(icon('probe', 13), probeText);
  bind(
    (s) => {
      const p = s.probe;
      if (!p) return '';
      return `${formatMeters(p.elevation, 1)} ground · ${p.depth > 0.01 ? formatMeters(p.depth) + ' deep' : 'dry'}${p.speed > 0 ? ' · ' + formatSpeed(p.speed) : ''}`;
    },
    (v) => {
      setText(probeText, v);
      probeLine.hidden = !v;
    },
  );

  const naive = h('div', { class: 'dl-hud-naive' }, icon('bolt', 13), h('span', null, 'Naive solver — expect instability'));
  bind((s) => s.sim.stabilityMode === 'naive', (on) => (naive.hidden = !on));

  const collapseBtn = h(
    'button',
    { type: 'button', class: 'dl-hud-collapse', 'aria-label': 'Collapse statistics', 'data-tip': 'Collapse / expand stats', 'data-tip-side': 'top' },
    icon('chevronDown', 14),
  );

  const el = h(
    'section',
    { class: 'dl-hud dl-glass', 'aria-label': 'Simulation statistics' },
    h('div', { class: 'dl-hud-head' }, h('span', { class: 'dl-hud-title' }, h('span', { class: 'dl-live-dot' }), 'Live solver'), gpu, collapseBtn),
    h('div', { class: 'dl-hud-body' }, h('div', { class: 'dl-hud-big' }, area.el, volume.el), h('div', { class: 'dl-hud-grid' }, depth.el, speed.el, mass.el, simSpeed.el), h('div', { class: 'dl-hud-diag' }, dDt.el, dSub.el, dCo.el, dFps.el)),
    naive,
    probeLine,
  );
  collapseBtn.addEventListener('click', () => {
    const c = el.classList.toggle('dl-collapsed');
    collapseBtn.setAttribute('aria-label', c ? 'Expand statistics' : 'Collapse statistics');
  });
  bind((s) => s.paused || !s.stats, (idle) => toggleClass(el, 'dl-idle', idle));
  void store;
  return el;
}

/** Floating probe card that follows the cursor over the canvas while the probe tool is active. */
export function createProbeTooltip(ctx: UIContext): { el: HTMLElement; destroy(): void } {
  const { bind, store } = ctx;
  const depthV = h('span', { class: 'dl-probe-depth' });
  const hazard = h('span', { class: 'dl-probe-hazard' });
  const elev = h('b');
  const speed = h('b');
  const coords = h('span', { class: 'dl-probe-coords' });
  const speedRow = h('div', { class: 'dl-probe-row' }, h('span', null, 'Flow'), speed);
  const el = h(
    'div',
    { class: 'dl-probe', 'aria-hidden': 'true' },
    h('div', { class: 'dl-probe-head' }, depthV, hazard),
    h('div', { class: 'dl-probe-row' }, h('span', null, 'Ground'), elev),
    speedRow,
    coords,
  );

  let px = -1000;
  let py = -1000;
  let overCanvas = false;
  let raf = 0;
  let w = 220;
  let hgt = 120;
  const place = () => {
    raf = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = px + 18;
    let y = py + 20;
    if (x + w > vw - 8) x = px - w - 18;
    if (y + hgt > vh - 8) y = py - hgt - 18;
    el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  const onMove = (e: PointerEvent) => {
    px = e.clientX;
    py = e.clientY;
    overCanvas = e.target instanceof HTMLCanvasElement;
    toggleClass(el, 'dl-over', overCanvas);
    if (!raf) raf = requestAnimationFrame(place);
  };
  window.addEventListener('pointermove', onMove, { passive: true });

  bind(
    (s) => {
      const p = s.probe;
      if (s.tool !== 'probe' || !p) return null;
      return `${p.depth}|${p.elevation}|${p.speed}|${p.lat}|${p.lon}`;
    },
    (key) => {
      const p = store.get().probe;
      const show = key !== null && !!p;
      toggleClass(el, 'dl-show', show);
      if (!show || !p) return;
      const wet = p.depth > 0.01;
      setText(depthV, wet ? `${formatMeters(p.depth)} deep` : 'Dry ground');
      const hz = waterHazard(p.depth, p.speed);
      setText(hazard, wet ? hz.label : '');
      el.dataset.sev = hz.severity;
      setText(elev, `${formatMeters(p.elevation, 1)} · ${formatFeet(p.elevation, 0)}`);
      speedRow.hidden = !(p.speed > 0);
      setText(speed, formatSpeed(p.speed));
      setText(coords, formatLatLon(p.lat, p.lon));
      // Measure once per content change (not per pointer move).
      w = el.offsetWidth || w;
      hgt = el.offsetHeight || hgt;
    },
  );

  return {
    el,
    destroy() {
      window.removeEventListener('pointermove', onMove);
      if (raf) cancelAnimationFrame(raf);
    },
  };
}
