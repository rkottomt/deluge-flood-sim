/**
 * First-run interactive tour. A spotlight card walks a new visitor through looking around, raising the river,
 * the green shelter pins, evacuating, building a levee, and speeding time up — then gets out of the way.
 *
 * Auto-starts once per tab (sessionStorage) after the terrain is on screen. Playwright (`navigator.webdriver`)
 * and `?tutorial=0` skip it so visual / e2e / security captures stay clean; `?tutorial=1` forces it.
 *
 * Nothing here is stored on disk. Closing the tab forgets that the tour ran.
 */
import type { AppState } from '../contracts';
import { h, setText, toggleClass, type UIContext } from './dom';
import { selectTool } from './toolDefs';

export const TUTORIAL_STORAGE_KEY = 'deluge:tutorial-done';

/** Tools a first-time visitor does not need. Hidden until they open "More tools". */
export const ADVANCED_TOOL_IDS = ['inflow', 'storm', 'water', 'dig'] as const;

export type TutorialStepId = 'welcome' | 'look' | 'raise' | 'shelters' | 'evac' | 'levee' | 'speed' | 'done';

export interface TutorialStep {
  id: TutorialStepId;
  title: string;
  body: string;
  /** Selector for the spotlight, or null for a centred card. */
  target: string | null;
  /** Primary button label. */
  primary: string;
  /** Secondary: skip / later. Hidden on the last step. */
  skip?: string;
  /** When set, the primary button also fires this Try-it step (same as clicking the strip). */
  tryStep?: 'flood' | 'evac' | 'levee';
  /** Advance automatically when this is true of app state. */
  done?: (s: AppState) => boolean;
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'welcome',
    title: 'This is a live flood map',
    body: 'You are looking at real Pittsburgh terrain. The rivers are already running. I’ll show you the few things that matter — you can skip any time.',
    target: null,
    primary: 'Show me',
    skip: 'Skip',
  },
  {
    id: 'look',
    title: 'Look around',
    body: 'Drag the map to spin it. Right-drag to slide. Scroll to zoom. Try a drag, or press Next.',
    target: null,
    primary: 'Next',
    skip: 'Skip tour',
  },
  {
    id: 'raise',
    title: 'Flood the city',
    body: 'This button raises the rivers to the 1936 record — the worst flood Pittsburgh has seen. Watch downtown and the North Shore go under.',
    target: '.dl-try-step[data-step="flood"]',
    primary: 'Raise the river',
    skip: 'Next',
    tryStep: 'flood',
    done: (s) => s.stageOffset > 0.3,
  },
  {
    id: 'shelters',
    title: 'Green pins are shelters',
    body: 'Those glowing green markers are high ground people can evacuate to — hospitals, hilltops, big buildings. They are not the flood. You can add or remove them with the shield tool on the left.',
    target: '.dl-tool[data-tool="shelter"]',
    primary: 'Got it',
    skip: 'Skip tour',
  },
  {
    id: 'evac',
    title: 'Get people out',
    body: 'Evacuate picks a street and draws a route to the nearest dry shelter. As roads flood, the line re-plans — or turns red if every way out is cut.',
    target: '.dl-try-step[data-step="evac"]',
    primary: 'Plan a route',
    skip: 'Next',
    tryStep: 'evac',
    done: (s) => !!s.evacStart,
  },
  {
    id: 'levee',
    title: 'Hold the water back',
    body: 'Build a levee raises a floodwall along the North Shore and replays the rise. Land it keeps dry turns green. Or pick the wall tool (the brick icon) and drag your own.',
    target: '.dl-try-step[data-step="levee"]',
    primary: 'Build a levee',
    skip: 'Next',
    tryStep: 'levee',
  },
  {
    id: 'speed',
    title: 'Speed up time',
    body: 'The flood is solved at real speed, so a day of water would take a day. These buttons skip ahead: 60× is a good watch-it-happen speed. Space pauses.',
    target: '.dl-speed',
    primary: 'Next',
    skip: 'Skip tour',
  },
  {
    id: 'done',
    title: 'That’s the whole app',
    body: 'The buttons up top are the easy path. Extra tools (rain storms, digging, pouring water) sit under More on the left. The side panel has weather, views and the science — only if you want it.',
    target: null,
    primary: 'Start exploring',
  },
];

export interface TutorialPrefs {
  search: string;
  webdriver: boolean;
  storedDone: boolean;
}

/** Whether a fresh page load should pop the tour. */
export function shouldAutoStartTutorial(p: TutorialPrefs): boolean {
  const q = new URLSearchParams(p.search.startsWith('?') ? p.search.slice(1) : p.search);
  if (q.get('tutorial') === '1') return true;
  if (q.get('tutorial') === '0') return false;
  if (p.webdriver) return false;
  return !p.storedDone;
}

export function readTutorialDone(): boolean {
  try {
    return sessionStorage.getItem(TUTORIAL_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeTutorialDone(): void {
  try {
    sessionStorage.setItem(TUTORIAL_STORAGE_KEY, '1');
  } catch {
    /* private mode / disabled storage */
  }
}

export function stepIndex(id: TutorialStepId): number {
  return TUTORIAL_STEPS.findIndex((s) => s.id === id);
}

export function nextStepId(id: TutorialStepId): TutorialStepId | null {
  const i = stepIndex(id);
  if (i < 0 || i >= TUTORIAL_STEPS.length - 1) return null;
  return TUTORIAL_STEPS[i + 1].id;
}

export interface TutorialHandle {
  el: HTMLElement;
  start(): void;
  skip(): void;
  isOpen(): boolean;
}

export function createTutorial(ctx: UIContext): TutorialHandle {
  const { store, bind } = ctx;

  const hole = h('div', { class: 'dl-tutorial-hole', 'aria-hidden': 'true' });
  const kicker = h('div', { class: 'dl-tutorial-kicker' });
  const title = h('h2', { class: 'dl-tutorial-title' });
  const body = h('p', { class: 'dl-tutorial-body' });
  const primary = h('button', { type: 'button', class: 'dl-btn dl-btn-primary' });
  const skipBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-ghost' });
  const closeBtn = h('button', {
    type: 'button',
    class: 'dl-icon-btn dl-tutorial-close',
    'aria-label': 'Close the tour',
    'data-tip': 'Close',
    'data-tip-key': 'Esc',
    'data-tip-side': 'bottom',
  }, '×');
  const card = h(
    'div',
    { class: 'dl-tutorial-card dl-glass', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'dl-tutorial-title' },
    h('div', { class: 'dl-tutorial-head' }, kicker, closeBtn),
    title,
    body,
    h('div', { class: 'dl-tutorial-actions' }, skipBtn, primary),
  );
  title.id = 'dl-tutorial-title';
  const el = h('div', { class: 'dl-tutorial', hidden: true }, hole, card);

  let open = false;
  let step: TutorialStep = TUTORIAL_STEPS[0];
  let raf = 0;
  let dragDist = -1;
  let dragX = 0;
  let dragY = 0;

  const targetEl = (): Element | null => (step.target ? document.querySelector(step.target) : null);

  const place = () => {
    raf = 0;
    if (!open) return;
    const t = targetEl();
    const pad = 10;
    if (!t) {
      hole.hidden = true;
      if (step.id === 'look') {
        card.dataset.place = 'bottom';
        card.style.left = '50%';
        card.style.top = 'auto';
        card.style.bottom = '28px';
        card.style.transform = 'translate(-50%, 0)';
      } else {
        card.dataset.place = 'center';
        card.style.left = '50%';
        card.style.top = '46%';
        card.style.bottom = 'auto';
        card.style.transform = 'translate(-50%, -50%)';
      }
    } else {
      card.style.bottom = 'auto';
      const r = t.getBoundingClientRect();
      hole.hidden = false;
      hole.style.left = `${Math.round(r.left - pad)}px`;
      hole.style.top = `${Math.round(r.top - pad)}px`;
      hole.style.width = `${Math.round(r.width + pad * 2)}px`;
      hole.style.height = `${Math.round(r.height + pad * 2)}px`;
      const cardW = Math.min(360, window.innerWidth - 24);
      const cardH = card.offsetHeight || 220;
      let left = r.left;
      let top = r.bottom + 16;
      let placeName = 'below';
      if (top + cardH > window.innerHeight - 12) {
        top = r.top - cardH - 16;
        placeName = 'above';
      }
      if (top < 12) {
        left = r.right + 16;
        top = Math.max(12, r.top);
        placeName = 'right';
      }
      left = Math.max(12, Math.min(left, window.innerWidth - cardW - 12));
      top = Math.max(12, Math.min(top, window.innerHeight - cardH - 12));
      card.dataset.place = placeName;
      card.style.left = `${Math.round(left)}px`;
      card.style.top = `${Math.round(top)}px`;
      card.style.transform = 'none';
    }
    const tEl = targetEl();
    document.querySelectorAll('.dl-tutorial-target').forEach((n) => n.classList.remove('dl-tutorial-target'));
    if (tEl) tEl.classList.add('dl-tutorial-target');
    raf = requestAnimationFrame(place);
  };

  const render = () => {
    const i = stepIndex(step.id);
    setText(kicker, `Step ${i + 1} of ${TUTORIAL_STEPS.length}`);
    setText(title, step.title);
    setText(body, step.body);
    setText(primary, step.primary);
    skipBtn.hidden = !step.skip;
    if (step.skip) setText(skipBtn, step.skip);
    toggleClass(el, 'dl-tutorial-dimmed', step.target !== null);
  };

  const go = (id: TutorialStepId | null) => {
    if (!id) {
      finish();
      return;
    }
    step = TUTORIAL_STEPS[stepIndex(id)] ?? TUTORIAL_STEPS[0];
    render();
  };

  const clickTry = (id: NonNullable<TutorialStep['tryStep']>) => {
    document.querySelector<HTMLButtonElement>(`.dl-try-step[data-step="${id}"]`)?.click();
  };

  const finish = () => {
    if (!open) return;
    open = false;
    el.hidden = true;
    el.inert = true;
    writeTutorialDone();
    document.querySelectorAll('.dl-tutorial-target').forEach((n) => n.classList.remove('dl-tutorial-target'));
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };

  const start = () => {
    if (open) return;
    // Help / How it works on top of the map would cover the tour.
    ctx.setPanel('help', false);
    ctx.setPanel('howItWorks', false);
    ctx.setPanel('locationPicker', false);
    selectTool(store, 'orbit');
    open = true;
    step = TUTORIAL_STEPS[0];
    el.hidden = false;
    el.inert = false;
    render();
    if (!raf) raf = requestAnimationFrame(place);
    queueMicrotask(() => primary.focus());
  };

  primary.addEventListener('click', () => {
    const id = step.id;
    if (step.tryStep) clickTry(step.tryStep);
    // A store update (raise / evac) may already have advanced this step via `done`.
    if (step.id !== id) return;
    go(nextStepId(id));
  });
  skipBtn.addEventListener('click', () => {
    if (step.id === 'welcome') finish();
    else go(nextStepId(step.id));
  });
  closeBtn.addEventListener('click', () => finish());

  const onPointerDown = (e: PointerEvent) => {
    if (!open || step.id !== 'look') return;
    if (!(e.target instanceof HTMLCanvasElement)) return;
    dragDist = 0;
    dragX = e.clientX;
    dragY = e.clientY;
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!open || step.id !== 'look' || dragDist < 0) return;
    dragDist += Math.hypot(e.clientX - dragX, e.clientY - dragY);
    dragX = e.clientX;
    dragY = e.clientY;
    if (dragDist > 24) go(nextStepId('look'));
  };
  window.addEventListener('pointerdown', onPointerDown, { capture: true });
  window.addEventListener('pointermove', onPointerMove, { capture: true });
  ctx.own(() => {
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    open = false;
    if (raf) cancelAnimationFrame(raf);
  });

  bind(
    (s) => `${s.stageOffset}|${s.evacStart ? 1 : 0}|${s.terrainName}|${s.loading ? 1 : 0}`,
    (_k, s) => {
      if (!open) return;
      if (step.done?.(s)) go(nextStepId(step.id));
    },
  );

  // First terrain of the session: start the tour once loading has cleared.
  let armed = shouldAutoStartTutorial({
    search: typeof location === 'undefined' ? '' : location.search,
    webdriver: typeof navigator !== 'undefined' && !!navigator.webdriver,
    storedDone: readTutorialDone(),
  });
  bind(
    (s) => !!(s.terrainName && !s.loading),
    (ready) => {
      if (!armed || !ready || open) return;
      armed = false;
      start();
    },
  );

  el.inert = true;
  return { el, start, skip: finish, isOpen: () => open };
}
