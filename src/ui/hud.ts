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
import { displaySpeed, isDiverged, RainGauge, speedShortfall } from './stats';
import type { AppState } from '../contracts';

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
  /** Set a stat value; unusually long strings (runaway numbers in the stability demo) get a smaller font. */
  const setValue = (st: { value: HTMLElement }, text: string, longAt: number) => {
    setText(st.value, text);
    toggleClass(st.value, 'dl-long', text.length > longAt);
  };

  const area = stat('Flooded land', 'Land that was dry at reset and is now under ≥ 30 cm of water', true);
  const volume = stat('Water volume', 'Total water stored on the map', true);
  const depth = stat('Max depth', 'Deepest water anywhere on the map');
  const speed = stat(
    'Max speed',
    'Fastest flow anywhere on the map. Peaks at 4–6 m/s while a risen river spills onto the floodplain and fills low basins; ~1–1.5 m/s once they have filled.',
  );
  const mass = stat(
    'Mass error',
    'Mass-balance error: |V − (V₀ + in − out)| ÷ the most water held since reset. Every rain, river, boundary and brush change (and the GPU’s own Float32 rounding) is booked per cell and summed in Float64 — no water is created or destroyed.',
  );
  const simSpeed = stat('Sim speed', 'Simulated seconds per real second actually achieved');

  // Rain fallen since reset: under heavy rain the flooded area lags (runoff has to collect first), but this moves.
  const rain = new RainGauge();
  let rainMm = 0;
  let rainScene = '';
  bind(
    (s) => s.stats,
    (st, s) => {
      if (s.terrainName !== rainScene) {
        rainScene = s.terrainName;
        rain.reset();
      }
      if (st) rain.push(st.simTime, s.sim.rainRate);
      rainMm = rain.mm;
    },
  );

  // Once the stability demo has blown the solution up, the numbers are meaningless (−3e39 m³ of water, 1e36
  // Olympic pools…). Say so plainly instead of printing them.
  const diverged = (s: AppState) => isDiverged(s.stats);
  bind(diverged, (d) => {
    toggleClass(el, 'dl-diverged', d);
    for (const st of [area, volume, depth, speed]) st.el.dataset.sev = d ? 'danger' : 'calm';
  });
  bind((s) => (diverged(s) ? 'Diverged' : formatKm2(s.stats?.floodedArea)), (v) => setValue(area, v, 10));
  bind(
    (s) => {
      if (diverged(s)) return 'numbers no longer physical';
      if (!s.stats) return '';
      const acres = formatAcres(s.stats.floodedArea);
      return rainMm >= 1 ? `${acres} · ${fmtNum(rainMm, 0)} mm rain` : acres;
    },
    (v) => setText(area.sub, v),
  );
  bind((s) => (diverged(s) ? 'Diverged' : formatVolume(s.stats?.volume)), (v) => setValue(volume, v, 10));
  bind((s) => (diverged(s) ? 'water created from nothing' : s.stats ? formatPools(s.stats.volume) : ''), (v) => setText(volume.sub, v));
  bind((s) => (diverged(s) ? '∞' : formatMeters(s.stats?.maxDepth)), (v) => setValue(depth, v, 7));
  bind((s) => (diverged(s) ? 'blew up' : s.stats ? formatFeet(s.stats.maxDepth) : ''), (v) => setText(depth.sub, v));
  bind((s) => (diverged(s) ? '∞' : formatSpeed(s.stats?.maxSpeed)), (v) => setValue(speed, v, 8));
  bind(
    (s) => {
      if (diverged(s)) return 'blew up';
      const v = s.stats?.maxSpeed;
      if (v === undefined || !Number.isFinite(v)) return '';
      return `${fmtNum(v * 2.23694, 1)} mph`;
    },
    (v) => setText(speed.sub, v),
  );
  bind((s) => (diverged(s) ? '∞' : formatPercent(s.stats?.massError)), (v) => setValue(mass, v, 8));
  bind(
    (s) => {
      const e = s.stats?.massError;
      if (diverged(s)) return 'danger';
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
      const shown = displaySpeed(achievedSpeed(), s.sim.timeScale);
      return shown === null ? `${fmtNum(s.sim.timeScale, 0)}×` : formatSpeedup(shown);
    },
    (v) => setValue(simSpeed, v, 7),
  );
  // Fast-forward beyond what the GPU can do is normal and shown neutrally ("GPU max"); amber only for a real shortfall.
  const shortfall = (s: AppState) => (s.paused ? 'none' : speedShortfall(!!s.stepInfo?.throttled, achievedSpeed(), s.sim.timeScale));
  bind(
    (s) => {
      const f = shortfall(s);
      return f === 'short' ? 'GPU-limited' : f === 'max' ? 'GPU max' : `of ${fmtNum(s.sim.timeScale, 0)}×`;
    },
    (v) => setText(simSpeed.sub, v),
  );
  bind(
    (s) => shortfall(s),
    (f) => {
      simSpeed.el.dataset.sev = f === 'short' ? 'warn' : 'calm';
      simSpeed.el.dataset.tip =
        f === 'max'
          ? 'Simulated seconds per real second actually achieved — the GPU is running flat out; the requested speed is higher'
          : f === 'short'
            ? 'Simulated seconds per real second actually achieved — well below the requested speed (GPU busy, throttled or on battery)'
            : 'Simulated seconds per real second actually achieved';
    },
  );

  // Diagnostics strip.
  const diag = (labelText: string, tip: string) => {
    const v = h('b', null, DASH);
    const el = h('span', { class: 'dl-diag-item', 'data-tip': tip, 'data-tip-side': 'top' }, h('span', null, labelText), v);
    return { el, v };
  };
  const dDt = diag('Δt', 'Adaptive timestep per substep (CFL-limited)');
  const dSub = diag('substeps', 'Solver substeps this frame');
  const dCo = diag(
    'Courant',
    'Largest 2-D Courant number seen. Δt aims for 0.7 against a padded wave-speed estimate (the readback is a few hundred ms old), so it usually reads ≈ 0.55; the robust scheme is stable below √θ ≈ 0.89',
  );
  const dFps = diag('fps', 'Rendered frames per second');
  bind((s) => formatDt(s.stepInfo?.dt), (v) => setText(dDt.v, v));
  bind((s) => (s.stepInfo ? String(s.stepInfo.substeps) : DASH), (v) => setText(dSub.v, v));
  bind((s) => (s.stats ? fmtNum(s.stats.courant, 2) : DASH), (v) => setText(dCo.v, v));
  bind(
    (s) => {
      const c = s.stats?.courant;
      if (c === undefined) return 'calm';
      if (!Number.isFinite(c) || c > 1) return 'danger';
      // Naive mode runs at 1.8 on purpose; robust mode's limit with θ-smoothing is √0.8 ≈ 0.89.
      return c > 0.89 ? 'warn' : 'calm';
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
      const wet = p.depth > 0.01;
      return `${formatMeters(p.elevation, 1)} ground · ${wet ? formatMeters(p.depth) + ' deep' : 'dry'}${wet && p.speed > 0 ? ' · ' + formatSpeed(p.speed) : ''}`;
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
  const setCollapsed = (c: boolean) => {
    el.classList.toggle('dl-collapsed', c);
    collapseBtn.setAttribute('aria-label', c ? 'Expand statistics' : 'Collapse statistics');
  };
  collapseBtn.addEventListener('click', () => setCollapsed(!el.classList.contains('dl-collapsed')));
  // On a phone the full HUD would cover a third of the map: start collapsed there.
  if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 600px)').matches) setCollapsed(true);
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
      // Thin runoff films (< 1 cm) still carry a velocity in the solver export; the card calls them dry ground.
      speedRow.hidden = !(wet && p.speed > 0);
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
