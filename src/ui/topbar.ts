/**
 * Top bar: brand + scenario name (left), transport — play/pause, sim clock, speed, reset (center),
 * perf readout + How it works / help / panel toggle (right).
 */
import { h, setText, toggleClass, setAttr, type UIContext } from './dom';
import { icon, iconMarkup, logoMark } from './icons';
import { segmented } from './controls';
import { formatClock, fmtNum, formatSpeedup } from './format';
import { SpeedEstimator } from './stats';

export const SPEEDS: Array<{ value: number; label: string; tip: string }> = [
  { value: 1, label: '1×', tip: 'Real time' },
  { value: 10, label: '10×', tip: '10 simulated seconds per second' },
  { value: 60, label: '60×', tip: '1 simulated minute per second' },
  { value: 300, label: '300×', tip: '5 simulated minutes per second' },
  { value: 1200, label: '1200×', tip: '20 simulated minutes per second' },
];

export interface TopBar {
  el: HTMLElement;
  /** Measured achieved speed multiple (sim seconds per real second), shared with the HUD; null until known. */
  achievedSpeed(): number | null;
}

export function createTopBar(ctx: UIContext, opts: { onTogglePanel(): void; isPanelOpen(): boolean }): TopBar {
  const { store, actions, bind } = ctx;

  // ── Brand / scenario ──
  const name = h('span', { class: 'dl-scene-name' });
  const liveBadge = h('span', { class: 'dl-badge dl-badge-live' }, 'LIVE DATA');
  const brand = h(
    'div',
    { class: 'dl-island dl-brand' },
    h('div', { class: 'dl-brand-mark' }, logoMark(28), h('span', { class: 'dl-wordmark' }, 'Deluge')),
    h('span', { class: 'dl-vsep', 'aria-hidden': 'true' }),
    h('div', { class: 'dl-scene', 'data-tip': 'Current scenario', 'data-tip-side': 'bottom' }, name, liveBadge),
  );
  bind(
    (s) => s.terrainName || (s.loading ? 'Loading…' : 'No terrain loaded'),
    (v) => {
      setText(name, v);
      name.title = v;
    },
  );
  bind(
    (s) => s.presetId === null && !!s.terrainName,
    (live) => {
      liveBadge.hidden = !live;
    },
  );

  // ── Transport ──
  const playBtn = h('button', {
    type: 'button',
    class: 'dl-play',
    'data-tip': 'Play / pause',
    'data-tip-key': 'Space',
    'data-tip-side': 'bottom',
    onclick: () => store.set({ paused: !store.get().paused }),
  });
  bind(
    (s) => s.paused,
    (paused) => {
      playBtn.innerHTML = iconMarkup(paused ? 'play' : 'pause', 18);
      setAttr(playBtn, 'aria-label', paused ? 'Play simulation' : 'Pause simulation');
      toggleClass(playBtn, 'dl-paused', paused);
    },
  );

  const clockValue = h('span', { class: 'dl-clock-value' }, 'T+00:00:00');
  const clockState = h('span', { class: 'dl-clock-label' }, 'SIM TIME');
  const clock = h('div', { class: 'dl-clock', 'data-tip': 'Simulated time since the last reset', 'data-tip-side': 'bottom' }, clockState, clockValue);
  bind(
    (s) => formatClock(s.stats?.simTime ?? 0),
    (v) => setText(clockValue, v),
  );
  bind(
    (s) => (s.loading ? 'LOADING' : s.paused ? 'PAUSED' : 'SIM TIME'),
    (v) => {
      setText(clockState, v);
      toggleClass(clock, 'dl-clock-paused', v === 'PAUSED');
    },
  );

  const speed = segmented(
    SPEEDS.map((sp) => ({ value: sp.value, label: sp.label, tip: sp.tip })),
    (v) => ctx.setSim({ timeScale: v }),
    { label: 'Simulation speed', className: 'dl-speed' },
  );
  bind(
    (s) => s.sim.timeScale,
    (v) => speed.set(v),
  );

  const resetBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-icon-btn',
      'aria-label': 'Reset water',
      'data-tip': 'Reset water to the scenario start',
      'data-tip-key': 'R',
      'data-tip-side': 'bottom',
      onclick: () => actions.resetWater(),
    },
    icon('reset', 18),
  );

  const transport = h('div', { class: 'dl-island dl-transport' }, playBtn, clock, speed.el, resetBtn);

  // ── Right cluster ──
  const fps = h('span', { class: 'dl-perf-fps' }, '—');
  const sub = h('span', { class: 'dl-perf-sub' }, '—');
  const perf = h(
    'div',
    { class: 'dl-perf', 'data-tip': 'Frames per second · solver substeps per frame · achieved speed', 'data-tip-side': 'bottom' },
    h('span', { class: 'dl-perf-row' }, fps, h('span', { class: 'dl-perf-unit' }, 'fps')),
    h('span', { class: 'dl-perf-row' }, sub),
  );

  const howBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-btn dl-btn-accent dl-how-btn',
      'data-tip': 'The math, the GPU pipeline — and a button to break it',
      'data-tip-side': 'bottom',
      onclick: () => ctx.setPanel('howItWorks', true),
    },
    icon('book', 16),
    h('span', null, 'How it works'),
  );
  const helpBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-icon-btn',
      'aria-label': 'Help and shortcuts',
      'data-tip': 'Shortcuts & quick guide',
      'data-tip-key': '?',
      'data-tip-side': 'bottom',
      onclick: () => ctx.setPanel('help', !store.get().panels.help),
    },
    icon('help', 18),
  );
  const panelBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-icon-btn dl-panel-toggle',
      'aria-label': 'Toggle side panel',
      'aria-expanded': 'true',
      'data-tip': 'Show / hide controls panel',
      'data-tip-side': 'bottom',
      onclick: () => {
        opts.onTogglePanel();
        syncPanelBtn();
      },
    },
    icon('panel', 18),
  );
  const syncPanelBtn = () => {
    const open = opts.isPanelOpen();
    setAttr(panelBtn, 'aria-expanded', String(open));
    toggleClass(panelBtn, 'dl-on', open);
  };
  queueMicrotask(syncPanelBtn);

  const right = h('div', { class: 'dl-island dl-actions' }, perf, howBtn, helpBtn, panelBtn);

  // Achieved speed (sim seconds per real second), measured as simulated time advanced over wall-clock time across
  // a few seconds of readbacks. (One frame's simulated seconds × the average frame rate over-reads whenever that
  // frame happened to be long, e.g. "348×" at 300×.)
  const estimator = new SpeedEstimator();
  let achieved: number | null = null;
  bind(
    (s) => s.stats,
    (st, s) => {
      if (!st || s.paused || s.loading) {
        estimator.reset();
        achieved = null;
        return;
      }
      estimator.push(performance.now(), st.simTime);
      achieved = estimator.value();
    },
  );
  // A new requested speed starts a new measurement.
  bind(
    (s) => `${s.sim.timeScale}|${s.paused}|${s.terrainName}|${s.sim.stabilityMode}`,
    () => {
      estimator.reset();
      achieved = null;
    },
  );

  bind(
    (s) => `${fmtNum(s.fps, 0)}`,
    (v) => setText(fps, v),
  );
  bind(
    (s) => {
      const si = s.stepInfo;
      if (s.paused) return 'paused';
      if (!si) return '—';
      return `${si.substeps} sub${si.throttled && achieved !== null ? ` · ${formatSpeedup(achieved)}` : ''}`;
    },
    (v) => setText(sub, v),
  );
  bind(
    (s) => !!s.stepInfo?.throttled && !s.paused,
    (throttled) => {
      toggleClass(perf, 'dl-throttled', throttled);
      perf.dataset.tip = throttled
        ? 'GPU is at its substep budget — running slower than the requested speed'
        : 'Frames per second · solver substeps per frame';
    },
  );
  bind(
    (s) => s.fps < 24 && s.fps > 0,
    (slow) => toggleClass(fps, 'dl-warn-text', slow),
  );

  const el = h('header', { class: 'dl-topbar' }, brand, transport, right);
  return { el, achievedSpeed: () => achieved };
}
