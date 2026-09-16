/**
 * "Start here" card for walk-up users (judges get no instructions). Appears under the transport bar once the
 * first terrain is ready and offers the three most rewarding first moves, derived from the loaded scenario.
 * It goes away for good as soon as the user does anything meaningful — or closes it.
 */
import type { AppState, StageControl } from '../contracts';
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon } from './icons';
import { kbd } from './controls';
import { selectTool } from './toolDefs';
import { clamp, offsetForFt, stageRangeFt } from './scales';
import { fmtNum } from './format';

/** Sim speed used by the quick actions, so a flood visibly develops within seconds. */
const QUICK_TIME_SCALE = 300;

/** The most dramatic stage the slider can reach: the highest in-range historic mark, else the top of the range. */
export function dramaticStage(ctrl: StageControl): { ft: number; label: string } {
  const range = stageRangeFt(ctrl);
  const marks = (ctrl.marks ?? []).filter((m) => m.ft <= range.max + 0.01 && m.ft >= range.min).sort((a, b) => b.ft - a.ft);
  if (marks.length) return { ft: marks[0].ft, label: marks[0].label };
  return { ft: range.max, label: `${fmtNum(range.max, 0)} ft` };
}

export function createWelcome(ctx: UIContext): HTMLElement {
  const { store, bind } = ctx;
  let dismissed = false;

  const floodText = h('span');
  const floodBtn = h(
    'button',
    { type: 'button', class: 'dl-btn dl-btn-primary dl-btn-sm dl-welcome-main', onclick: () => floodIt() },
    icon('water', 15),
    floodText,
  );
  const wallBtn = h(
    'button',
    { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', onclick: () => act(() => selectTool(store, 'wall')) },
    icon('wall', 15),
    h('span', null, 'Build a levee'),
    kbd('2'),
  );
  const guideBtn = h(
    'button',
    { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', onclick: () => act(() => ctx.setPanel('help', true)) },
    icon('help', 15),
    h('span', null, 'Guide'),
    kbd('?'),
  );
  const close = h(
    'button',
    { type: 'button', class: 'dl-icon-btn dl-welcome-close', 'aria-label': 'Dismiss', onclick: () => dismiss() },
    icon('close', 15),
  );
  const el = h(
    'section',
    { class: 'dl-welcome dl-glass', 'aria-label': 'Getting started' },
    h(
      'div',
      { class: 'dl-welcome-head' },
      h('span', { class: 'dl-welcome-spark' }, icon('spark', 15)),
      h('span', { class: 'dl-welcome-title' }, 'Everything here is live — solved on your GPU. Try:'),
      close,
    ),
    h('div', { class: 'dl-welcome-actions' }, floodBtn, wallBtn, guideBtn),
  );

  function floodIt() {
    const s = store.get();
    const ctrl = s.scenario?.stage ?? null;
    const patch: Partial<AppState> = { paused: false, sim: { ...s.sim, timeScale: Math.max(s.sim.timeScale, QUICK_TIME_SCALE) } };
    if (ctrl) {
      patch.stageOffset = clamp(offsetForFt(ctrl, dramaticStage(ctrl).ft), 0, ctrl.maxOffset);
    } else {
      patch.sim = { ...patch.sim!, rainRate: Math.max(s.sim.rainRate, 100) };
    }
    act(() => store.set(patch));
  }

  function act(fn: () => void) {
    dismiss();
    fn();
  }

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    sync(store.get());
  }

  function sync(s: AppState) {
    const show = !dismissed && !!s.terrainName && !s.loading && s.sim.stabilityMode === 'robust';
    toggleClass(el, 'dl-show', show);
    el.inert = !show;
  }

  bind(
    (s) => s.scenario?.stage ?? null,
    (ctrl) => setText(floodText, ctrl ? `Raise the river to ${dramaticStage(ctrl).label}` : 'Unleash a 100 mm/hr storm'),
  );
  // Any meaningful interaction means the user found their way: retire the card. The baseline is taken a
  // moment after each load settles, because the app itself resets tool-adjacent state (stage, rain…) on load.
  type Key = readonly unknown[];
  const keyOf = (s: AppState): Key => [s.tool, s.stageOffset, s.sim.rainRate, s.panels.help, s.panels.howItWorks, s.panels.locationPicker, s.evacStart];
  const sameKey = (a: Key, b: Key) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
  let baseline: Key | null = null;
  let armTimer = 0;
  bind(keyOf, (k) => {
    if (baseline && !sameKey(k, baseline)) dismiss();
  }, sameKey);
  bind(
    (s) => `${!!s.terrainName}|${!!s.loading}|${s.sim.stabilityMode}`,
    (_k, s) => {
      clearTimeout(armTimer);
      if (s.terrainName && !s.loading) armTimer = window.setTimeout(() => (baseline = keyOf(store.get())), 800);
      else baseline = null;
      sync(s);
    },
  );
  return el;
}
