/**
 * "Try it" strip for walk-up users (judges get no instructions). Once the first terrain is ready it offers the
 * demo moments as one-click actions, derived from the loaded scenario:
 *
 *   1 raise the rivers to the record crest (or play the flood fast)   2 build a levee   3 plan an evacuation
 *   4 hurricane rain   5 break the solver
 *
 * Each step shows a check once done, and the ones with an obvious inverse (rivers, rain, solver) toggle back.
 * The strip stays available while the user explores (after the first click its heading folds away to keep the
 * map clear) and goes away for good only when closed.
 */
import type { AppState, StageControl, Store } from '../contracts';
import { h, setText, toggleClass, setAttr, type UIContext } from './dom';
import { icon, type IconName } from './icons';
import { selectTool } from './toolDefs';
import { clamp, offsetForFt, stageRangeFt } from './scales';
import { fmtNum } from './format';
import { bridgeFor, postNotice } from './bridge';
import { suggestEvacStarts } from './evacSuggest';
import { startBreakDemo, stopBreakDemo } from './stabilityDemo';

/** Sim speed used by the quick actions, so a flood visibly develops within seconds. */
export const QUICK_TIME_SCALE = 300;
/** "Hurricane rain" rate, mm/hr (Hurricane Harvey's peak hourly rates). */
export const HURRICANE_RAIN = 100;

/** The most dramatic stage the slider can reach: the highest in-range historic mark, else the top of the range. */
export function dramaticStage(ctrl: StageControl): { ft: number; label: string } {
  const range = stageRangeFt(ctrl);
  const marks = (ctrl.marks ?? []).filter((m) => m.ft <= range.max + 0.01 && m.ft >= range.min).sort((a, b) => b.ft - a.ft);
  if (marks.length) return { ft: marks[0].ft, label: marks[0].label };
  return { ft: range.max, label: `${fmtNum(range.max, 0)} ft` };
}

/** Stage offset (m) of the dramatic crest. */
export function dramaticOffset(ctrl: StageControl): number {
  return clamp(offsetForFt(ctrl, dramaticStage(ctrl).ft), 0, ctrl.maxOffset);
}

interface Step {
  id: 'flood' | 'levee' | 'evac' | 'rain' | 'break';
  icon: IconName;
  key?: string;
  /** Current label (may depend on state, e.g. toggles). */
  label(s: AppState): string;
  tip(s: AppState): string;
  done(s: AppState): boolean;
  /** Toggle steps show their inverse action once done. */
  active?(s: AppState): boolean;
  run(): void;
}

export function createWelcome(ctx: UIContext): HTMLElement {
  const { store, bind } = ctx;
  let dismissed = false;
  let used = false;
  let wallDrawn = false;

  const quickSpeed = (s: AppState) => ({ ...s.sim, timeScale: Math.max(s.sim.timeScale, QUICK_TIME_SCALE) });

  const steps: Step[] = [
    {
      id: 'flood',
      icon: 'water',
      label: (s) => {
        const ctrl = s.scenario?.stage;
        if (!ctrl) return 'Play the flood';
        return isRaised(s, ctrl) ? 'Back to normal' : `Raise to ${dramaticStage(ctrl).label}`;
      },
      tip: (s) => {
        const ctrl = s.scenario?.stage;
        if (!ctrl) return 'Run the scenario at 300× — five simulated minutes every second';
        return isRaised(s, ctrl) ? 'Lower the rivers to their normal pool' : `Raise the rivers to the ${dramaticStage(ctrl).label} crest (${fmtNum(dramaticStage(ctrl).ft, 1)} ft) and run at 300×`;
      },
      done: (s) => (s.scenario?.stage ? isRaised(s, s.scenario.stage) : !s.paused && s.sim.timeScale >= QUICK_TIME_SCALE),
      active: (s) => !!s.scenario?.stage && isRaised(s, s.scenario.stage),
      run: () => {
        const s = store.get();
        const ctrl = s.scenario?.stage ?? null;
        if (!ctrl) return store.set({ paused: false, sim: quickSpeed(s) });
        if (isRaised(s, ctrl)) return store.set({ stageOffset: 0 });
        store.set({ paused: false, sim: quickSpeed(s), stageOffset: dramaticOffset(ctrl) });
      },
    },
    {
      id: 'levee',
      icon: 'wall',
      key: '2',
      label: () => 'Build a levee',
      tip: () => 'Wall tool — drag across the path of the water',
      done: () => wallDrawn,
      run: () => {
        selectTool(store, 'wall');
        postNotice(store, {
          kind: 'info',
          key: 'try-levee',
          title: 'Drag on the map to build a wall',
          message:
            'Close off a low gap where water gets in and tie both ends into high ground — water runs around open ends. ' +
            'The tool card checks the height against the flood as you hover (red = too low).',
          durationMs: 9000,
        });
      },
    },
    {
      id: 'evac',
      icon: 'evac',
      key: '8',
      label: () => 'Evacuate',
      tip: () => 'Plan an evacuation from a low street to the nearest dry shelter — it re-plans as roads flood',
      done: (s) => !!s.evacStart,
      run: () => void planEvacuation(ctx),
    },
    {
      id: 'rain',
      icon: 'rain',
      label: (s) => (s.sim.rainRate >= HURRICANE_RAIN ? 'Stop rain' : 'Hurricane rain'),
      tip: (s) => (s.sim.rainRate >= HURRICANE_RAIN ? 'Turn the rain off' : `${HURRICANE_RAIN} mm/hr over the whole map (Harvey’s peak rates), at 300×`),
      done: (s) => s.sim.rainRate >= HURRICANE_RAIN,
      active: (s) => s.sim.rainRate >= HURRICANE_RAIN,
      run: () => {
        const s = store.get();
        if (s.sim.rainRate >= HURRICANE_RAIN) return ctx.setSim({ rainRate: 0 });
        store.set({ paused: false, sim: { ...quickSpeed(s), rainRate: HURRICANE_RAIN } });
      },
    },
    {
      id: 'break',
      icon: 'bolt',
      label: (s) => (s.sim.stabilityMode === 'naive' ? 'Restore solver' : 'Break it'),
      tip: (s) =>
        s.sim.stabilityMode === 'naive'
          ? 'Back to the robust scheme — the water resets'
          : 'Swap in a textbook explicit scheme and watch it blow up (How it works explains why)',
      done: (s) => s.sim.stabilityMode === 'naive',
      active: (s) => s.sim.stabilityMode === 'naive',
      run: () => (store.get().sim.stabilityMode === 'naive' ? stopBreakDemo(ctx) : startBreakDemo(ctx)),
    },
  ];

  const buttons = steps.map((step) => {
    const text = h('span', { class: 'dl-try-label' });
    const b = h(
      'button',
      {
        type: 'button',
        class: `dl-try-step${step.id === 'break' ? ' dl-try-danger' : ''}`,
        'data-step': step.id,
        'data-tip-side': 'bottom',
        'data-tip-key': step.key ?? null,
        'aria-keyshortcuts': step.key ?? null,
        onclick: () => {
          used = true;
          sync(store.get());
          step.run();
        },
      },
      h('span', { class: 'dl-try-mark', 'aria-hidden': 'true' }, icon(step.icon, 15, 'dl-try-icon'), icon('check', 15, 'dl-try-check')),
      text,
    );
    return { step, b, text };
  });

  const close = h(
    'button',
    { type: 'button', class: 'dl-icon-btn dl-welcome-close', 'aria-label': 'Hide the demo steps', 'data-tip': 'Hide — the ? guide has the same tour', 'data-tip-side': 'bottom', onclick: () => dismiss() },
    icon('close', 15),
  );
  const row = h('div', { class: 'dl-try-row', role: 'group', 'aria-label': 'Demo steps' }, ...buttons.map((x) => x.b));
  // Arrow keys move between steps (Tab still walks through them).
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const list = buttons.map((x) => x.b);
    const k = list.indexOf(document.activeElement as HTMLButtonElement);
    if (k < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list[(k + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length].focus();
  });
  const el = h(
    'section',
    { class: 'dl-welcome dl-glass', 'aria-label': 'Try the demo' },
    h(
      'div',
      { class: 'dl-welcome-head' },
      h('span', { class: 'dl-welcome-spark' }, icon('spark', 15)),
      h('span', { class: 'dl-welcome-title' }, h('b', null, 'Try it'), ' — every drop is solved live on your GPU'),
    ),
    h('div', { class: 'dl-try-body' }, row, close),
  );

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    sync(store.get());
  }

  function sync(s: AppState) {
    const show = !dismissed && !!s.terrainName && !s.loading;
    toggleClass(el, 'dl-show', show);
    toggleClass(el, 'dl-compact', used);
    el.inert = !show;
    if (!show) return;
    const firstOpen = buttons.find((x) => !x.step.done(s));
    for (const { step, b, text } of buttons) {
      const done = step.done(s);
      setText(text, step.label(s));
      b.dataset.tip = step.tip(s);
      toggleClass(b, 'dl-done', done);
      toggleClass(b, 'dl-next', firstOpen?.b === b);
      if (step.active) setAttr(b, 'aria-pressed', String(step.active(s)));
    }
  }

  bridgeFor(store).wallDrawn.on(() => {
    wallDrawn = true;
    sync(store.get());
  });
  bind(
    (s) =>
      `${!!s.terrainName}|${!!s.loading}|${s.scenario === null}|${s.stageOffset}|${s.sim.rainRate}|${s.sim.timeScale}|${s.paused}|${s.sim.stabilityMode}|${!!s.evacStart}`,
    (_k, s) => sync(s),
  );
  // A new scene starts the checklist over (the dismissal sticks).
  bind(
    (s) => s.terrainName,
    () => {
      wallDrawn = false;
    },
  );
  return el;
}

function isRaised(s: AppState, ctrl: StageControl): boolean {
  return s.stageOffset >= dramaticOffset(ctrl) - 0.05;
}

/**
 * Select the evacuation tool and put the start on a street that the scenario's flood will reach, trying a few
 * candidates until the router finds a route (a start the router can't connect makes a poor first impression).
 */
export async function planEvacuation(ctx: Pick<UIContext, 'store'>): Promise<void> {
  const { store } = ctx;
  selectTool(store, 'evac');
  const s = store.get();
  const scene = bridgeFor(store).scene;
  const terrain = scene?.getTerrain() ?? null;
  const solver = scene?.getSolver() ?? null;
  if (!s.shelters.length) {
    postNotice(store, {
      kind: 'info',
      key: 'try-evac',
      title: 'Add a shelter first',
      message: 'This area has no evacuation shelters yet. Press 9 and click high ground to add one, then click a home with the evacuation tool (8).',
    });
    return;
  }
  if (!terrain?.roads || !solver) {
    postNotice(store, { kind: 'info', key: 'try-evac', title: 'Click a home on the map', message: 'The route to the nearest dry shelter appears at once and re-plans as roads flood.' });
    return;
  }
  const ctrl = s.scenario?.stage ?? null;
  let ground: Float32Array;
  try {
    ground = solver.getGroundCPU();
  } catch {
    return;
  }
  const snap = solver.getSnapshot();
  const cands = suggestEvacStarts({
    nx: solver.nx,
    ny: solver.ny,
    ground,
    depth: snap && snap.nx === solver.nx && snap.ny === solver.ny ? snap.depth : null,
    roads: terrain.roads,
    shelters: s.shelters,
    focus: s.scenario?.camera?.target ?? { gx: solver.nx / 2, gy: solver.ny / 2 },
    floodLevel: ctrl ? ctrl.normalLevel + dramaticOffset(ctrl) : null,
    currentLevel: ctrl ? ctrl.normalLevel + s.stageOffset : null,
    max: 6,
  });
  if (!cands.length) {
    postNotice(store, { kind: 'info', key: 'try-evac', title: 'Click a home on the map', message: 'The route to the nearest dry shelter appears at once and re-plans as roads flood.' });
    return;
  }
  for (const c of cands) {
    const start = { gx: c.gx, gy: c.gy };
    const before = store.get().route;
    store.set({ evacStart: start });
    const state = await routeStateFor(store, start, before, 1500);
    if (store.get().evacStart !== start) return; // the user clicked a start of their own meanwhile
    if (state === 'ok') return;
  }
  store.set({ evacStart: { gx: cands[0].gx, gy: cands[0].gy } });
}

/**
 * Resolves with the route state the app computes for `start` (null on timeout or when the start changes). The app
 * usually re-plans synchronously inside the store update that moved the start, so a route that already differs
 * from `before` is the answer; otherwise wait for the next one.
 */
function routeStateFor(
  store: Store,
  start: AppState['evacStart'],
  before: AppState['route'],
  timeoutMs: number,
): Promise<'ok' | 'blocked' | 'none' | null> {
  const now = store.get().route;
  if (now !== before && now && now.state !== 'none') return Promise.resolve(now.state);
  return new Promise((resolve) => {
    const initial = now;
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const finish = (v: 'ok' | 'blocked' | 'none' | null) => {
      clearTimeout(timer);
      off();
      resolve(v);
    };
    off = store.subscribe((st) => {
      if (st.evacStart !== start) return finish(null);
      const r = st.route;
      if (r && r !== initial && r.state !== 'none') finish(r.state);
    });
  });
}
