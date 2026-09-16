/**
 * Loading overlay, error toast, stability-demo banner, and the WebGPU-unsupported screen.
 */
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon, logoMark } from './icons';

const TIPS = [
  'Tip: press ? any time for shortcuts and a 30-second tour.',
  'Tip: drag a wall (2) across a street and watch the water reroute.',
  'Tip: “How it works” has a button that deliberately breaks the solver.',
  'Tip: set an evacuation start (8) — the route re-plans as roads flood.',
  'Tip: the mass-balance error in the HUD proves no water is created or lost.',
];

export function createLoadingOverlay(ctx: UIContext): HTMLElement {
  const { bind } = ctx;
  const title = h('div', { class: 'dl-loading-title' }, 'Loading terrain');
  const msg = h('div', { class: 'dl-loading-msg' });
  const fill = h('div', { class: 'dl-progress-fill' });
  const bar = h('div', { class: 'dl-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const pct = h('span', { class: 'dl-loading-pct' });
  const tip = h('span', { class: 'dl-loading-tip' });
  const wave = h(
    'div',
    { class: 'dl-loading-wave', 'aria-hidden': 'true' },
    logoMark(56),
    h('div', { class: 'dl-loading-ripple' }),
  );
  const el = h(
    'div',
    { class: 'dl-loading', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'dl-loading-card dl-glass' }, wave, title, msg, bar, h('div', { class: 'dl-loading-foot' }, pct, tip)),
  );
  let tipIdx = Math.floor(Math.random() * TIPS.length);
  let tipTimer = 0;

  bind(
    (s) => s.loading !== null,
    (on) => {
      toggleClass(el, 'dl-show', on);
      el.inert = !on;
      clearInterval(tipTimer);
      if (on) {
        setText(tip, TIPS[tipIdx % TIPS.length]);
        tipTimer = window.setInterval(() => setText(tip, TIPS[++tipIdx % TIPS.length]), 4500);
      }
    },
  );
  bind(
    (s) => s.loading?.message ?? '',
    (v) => setText(msg, v || 'Preparing…'),
  );
  bind(
    (s) => (s.loading ? Math.round(Math.max(0, Math.min(1, s.loading.progress)) * 100) : -1),
    (p) => {
      if (p < 0) return;
      const indeterminate = p <= 0;
      toggleClass(bar, 'dl-indeterminate', indeterminate);
      fill.style.setProperty('--p', String(p / 100));
      bar.setAttribute('aria-valuenow', String(p));
      setText(pct, indeterminate ? '' : `${p}%`);
    },
  );
  bind(
    (s) => s.terrainName,
    () => {
      /* title stays generic; message carries specifics */
    },
  );
  return el;
}

export function createNotices(ctx: UIContext): HTMLElement {
  const { bind, store, actions } = ctx;

  // Stability demo banner.
  const banner = h(
    'div',
    { class: 'dl-naive-banner', role: 'status' },
    h('span', { class: 'dl-naive-icon' }, icon('bolt', 16)),
    h('span', { class: 'dl-naive-text' }, h('b', null, 'Stability demo'), ' — naive explicit solver, Courant 1.8. Watch it blow up.'),
    h(
      'button',
      { type: 'button', class: 'dl-btn dl-btn-ok dl-btn-sm', onclick: () => actions.setStabilityDemo(false) },
      icon('shield', 14),
      h('span', null, 'Restore robust solver'),
    ),
  );
  bind((s) => s.sim.stabilityMode === 'naive', (on) => toggleClass(banner, 'dl-show', on));

  // Error toast.
  const toastMsg = h('p', { class: 'dl-toast-msg' });
  const timerBar = h('div', { class: 'dl-toast-timer' });
  const toast = h(
    'div',
    { class: 'dl-toast', role: 'alert' },
    h('span', { class: 'dl-toast-icon' }, icon('warning', 18)),
    h('div', { class: 'dl-toast-body' }, h('b', null, 'Something went wrong'), toastMsg),
    h('button', { type: 'button', class: 'dl-icon-btn dl-toast-close', 'aria-label': 'Dismiss', onclick: () => store.set({ error: null }) }, icon('close', 16)),
    timerBar,
  );
  let timer = 0;
  const arm = () => {
    clearTimeout(timer);
    timerBar.classList.remove('dl-run');
    void timerBar.offsetWidth; // restart the CSS countdown animation
    timerBar.classList.add('dl-run');
    timer = window.setTimeout(() => store.set({ error: null }), 12000);
  };
  toast.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    timerBar.classList.remove('dl-run');
  });
  toast.addEventListener('pointerleave', () => store.get().error && arm());
  bind(
    (s) => s.error,
    (err) => {
      toggleClass(toast, 'dl-show', !!err);
      toast.inert = !err;
      if (err) {
        setText(toastMsg, err);
        arm();
      } else {
        clearTimeout(timer);
      }
    },
  );

  return h('div', { class: 'dl-notices' }, banner, toast);
}

/** Full-screen friendly message for browsers without WebGPU (used by the app on device failure). */
export function renderUnsupported(root: HTMLElement, detail?: string): void {
  root.classList.add('dl-ui');
  const el = h(
    'div',
    { class: 'dl-unsupported' },
    h(
      'div',
      { class: 'dl-unsupported-card dl-glass' },
      h('div', { class: 'dl-brand-mark dl-brand-lg' }, logoMark(44), h('span', { class: 'dl-wordmark' }, 'Deluge')),
      h('h1', null, 'This browser can’t run the GPU flood solver'),
      h(
        'p',
        null,
        'Deluge solves the shallow-water equations on your graphics card with ',
        h('b', null, 'WebGPU'),
        '. Please open it in a recent Chrome, Edge or Arc (version 113+) on macOS, Windows or ChromeOS — or Safari 26+.',
      ),
      detail ? h('pre', { class: 'dl-unsupported-detail' }, detail) : null,
      h(
        'ul',
        null,
        h('li', null, 'Make sure hardware acceleration is enabled in your browser settings.'),
        h('li', null, 'On Linux, Chrome may need the “Unsafe WebGPU” flag (chrome://flags/#enable-unsafe-webgpu).'),
      ),
    ),
  );
  root.append(el);
}
