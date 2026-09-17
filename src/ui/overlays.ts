/**
 * Loading overlay, error & notice toasts, stability-demo banner, and the WebGPU-unsupported screen.
 */
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon, logoMark } from './icons';
import { bridgeFor, type Notice } from './bridge';
import { BREAK_TIME_SCALE, stopBreakDemo } from './stabilityDemo';

const TIPS = [
  'Tip: press ? any time for shortcuts and a 30-second tour.',
  'Tip: drag a wall (2) across a street and watch the water reroute.',
  'Tip: “How it works” has a button that deliberately breaks the solver.',
  'Tip: plan an evacuation (8) — the route re-plans as roads flood.',
  'Tip: the mass-balance error in the HUD proves no water is created or lost.',
];

export function createLoadingOverlay(ctx: UIContext): HTMLElement {
  const { bind, actions } = ctx;
  const title = h('div', { class: 'dl-loading-title' }, 'Loading terrain');
  const msg = h('div', { class: 'dl-loading-msg' });
  const fill = h('div', { class: 'dl-progress-fill' });
  const bar = h('div', { class: 'dl-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const pct = h('span', { class: 'dl-loading-pct' });
  const tip = h('span', { class: 'dl-loading-tip' });
  // Live areas download from public services that can stall on bad wifi: always offer a way out. The scene on screen
  // is kept (it is only replaced once the new terrain has arrived).
  const cancel = h(
    'button',
    {
      type: 'button',
      class: 'dl-btn dl-btn-ghost dl-loading-cancel',
      hidden: true,
      onclick: () => actions.cancelLoad?.(),
    },
    'Cancel',
  );
  const wave = h(
    'div',
    { class: 'dl-loading-wave', 'aria-hidden': 'true' },
    logoMark(56),
    h('div', { class: 'dl-loading-ripple' }),
  );
  const el = h(
    'div',
    { class: 'dl-loading', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'dl-loading-card dl-glass' }, wave, title, msg, h('div', { class: 'dl-progress-row' }, bar, pct), tip, cancel),
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
    (s) => !!s.loading?.cancellable && !!actions.cancelLoad,
    (on) => {
      cancel.hidden = !on;
      setText(title, on ? 'Loading live area' : 'Loading terrain');
    },
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
  return el;
}

export interface Notices {
  /** Top-center column: getting-started strip, error toast, notices. */
  top: HTMLElement;
  /** Bottom-center column: stability-demo banner, evacuation route chip. */
  bottom: HTMLElement;
}

export function createNotices(ctx: UIContext, extra: { top?: HTMLElement[]; bottom?: HTMLElement[] } = {}): Notices {
  const { bind, store } = ctx;

  // Stability demo banner. It sits at the bottom: the blow-up starts where rivers enter the map, which in most
  // framings is the top of the screen.
  const banner = h(
    'div',
    { class: 'dl-naive-banner', role: 'status' },
    h('span', { class: 'dl-naive-icon' }, icon('bolt', 16)),
    h(
      'span',
      { class: 'dl-naive-text' },
      h('span', { class: 'dl-naive-line' }, h('b', null, 'Stability demo'), ' — naive explicit solver at Courant 1.8', h('span', { class: 'dl-naive-slow' }), '.'),
      h('span', { class: 'dl-naive-legend' }, h('i', { class: 'dl-naive-swatch', 'aria-hidden': 'true' }), 'Magenta speckle = cells whose depth became infinite or NaN'),
    ),
    h(
      'button',
      { type: 'button', class: 'dl-btn dl-btn-ok dl-btn-sm', onclick: () => stopBreakDemo(ctx) },
      icon('shield', 14),
      h('span', null, 'Restore robust solver'),
    ),
  );
  const slowText = banner.querySelector('.dl-naive-slow') as HTMLElement;
  bind((s) => s.sim.stabilityMode === 'naive', (on) => toggleClass(banner, 'dl-show', on));
  bind(
    (s) => s.sim.timeScale === BREAK_TIME_SCALE,
    (slow) => setText(slowText, slow ? `, slowed to ${BREAK_TIME_SCALE}× so you can watch it start` : ''),
  );

  // Error toast (real failures only; limits and guidance use the notice toast below).
  const toastMsg = h('p', { class: 'dl-toast-msg' });
  const toast = h(
    'div',
    { class: 'dl-toast', role: 'alert' },
    h('span', { class: 'dl-toast-icon' }, icon('warning', 18)),
    h('div', { class: 'dl-toast-body' }, h('b', null, 'Something went wrong'), toastMsg),
    h('button', { type: 'button', class: 'dl-icon-btn dl-toast-close', 'aria-label': 'Dismiss', onclick: () => store.set({ error: null }) }, icon('close', 16)),
  );
  const errorTimer = autoDismiss(toast, () => store.set({ error: null }), () => !!store.get().error);
  bind(
    (s) => s.error,
    (err) => {
      toggleClass(toast, 'dl-show', !!err);
      toast.inert = !err;
      if (err) {
        setText(toastMsg, err);
        errorTimer.arm(12000);
      } else {
        errorTimer.stop();
      }
    },
  );

  // Notice toast: neutral information, guidance and warnings that are not failures.
  const noticeIcon = h('span', { class: 'dl-toast-icon' });
  const noticeTitle = h('b');
  const noticeMsg = h('p', { class: 'dl-toast-msg' });
  const noticeActions = h('div', { class: 'dl-toast-actions' });
  let current: Notice | null = null;
  const hideNotice = () => {
    current = null;
    toggleClass(notice, 'dl-show', false);
    notice.inert = true;
    noticeTimer.stop();
  };
  const notice = h(
    'div',
    { class: 'dl-toast dl-notice', role: 'status', 'aria-live': 'polite' },
    noticeIcon,
    h('div', { class: 'dl-toast-body' }, noticeTitle, noticeMsg, noticeActions),
    h('button', { type: 'button', class: 'dl-icon-btn dl-toast-close', 'aria-label': 'Dismiss', onclick: hideNotice }, icon('close', 16)),
  );
  notice.inert = true;
  const noticeTimer = autoDismiss(notice, hideNotice, () => current !== null);
  const showNotice = (n: Notice) => {
    const same = current !== null && n.key !== undefined && current.key === n.key && notice.classList.contains('dl-show');
    current = n;
    notice.dataset.kind = n.kind;
    noticeIcon.replaceChildren(icon(n.kind === 'success' ? 'check' : n.kind === 'warn' ? 'warning' : 'spark', 18));
    setText(noticeTitle, n.title);
    setText(noticeMsg, n.message);
    noticeActions.replaceChildren();
    if (n.action) {
      const { label, run } = n.action;
      noticeActions.append(
        h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', onclick: () => (run(), hideNotice()) }, h('span', null, label)),
      );
    }
    noticeActions.hidden = !n.action;
    notice.inert = false;
    if (!same) {
      // Restart the entrance animation for a new message.
      notice.classList.remove('dl-show');
      void notice.offsetWidth;
    }
    notice.classList.add('dl-show');
    noticeTimer.arm(n.durationMs ?? 7000);
  };
  ctx.own(bridgeFor(store).onNotice(showNotice));
  // A new scene makes scene-specific notices stale.
  bind((s) => s.terrainName, () => current && hideNotice());

  return {
    top: h('div', { class: 'dl-notices' }, ...(extra.top ?? []), toast, notice),
    bottom: h('div', { class: 'dl-notices-bottom' }, ...(extra.bottom ?? []), banner),
  };
}

/** Auto-dismiss with a visible countdown bar that pauses while hovered. */
function autoDismiss(el: HTMLElement, onExpire: () => void, stillShown: () => boolean) {
  const bar = h('div', { class: 'dl-toast-timer' });
  el.append(bar);
  let timer = 0;
  let duration = 7000;
  const run = () => {
    clearTimeout(timer);
    bar.classList.remove('dl-run');
    void bar.offsetWidth; // restart the CSS countdown animation
    bar.style.animationDuration = `${duration}ms`;
    bar.classList.add('dl-run');
    timer = window.setTimeout(onExpire, duration);
  };
  el.addEventListener('pointerenter', () => {
    clearTimeout(timer);
    bar.classList.remove('dl-run');
  });
  el.addEventListener('pointerleave', () => stillShown() && run());
  return {
    arm(ms: number) {
      duration = ms;
      run();
    },
    stop() {
      clearTimeout(timer);
      bar.classList.remove('dl-run');
    },
  };
}

