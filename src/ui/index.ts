/**
 * Deluge UI — mountUI(root, store, actions) renders the whole interface from store state, and
 * createToolController(canvas, deps) turns canvas pointer input into edits (see tools.ts).
 *
 * Rendering model: every component registers selector → apply bindings on a single Binder. On each
 * store change the binder re-evaluates selectors and touches the DOM only where a selected value
 * changed, so the ~5 Hz stats stream never rebuilds panels, steals focus or interrupts slider drags.
 */
import './styles.css';
import { DEFAULT_SIM_PARAMS, type AppActions, type AppState, type Store } from '../contracts';
import { Binder, h, type UIContext } from './dom';
import { installTooltips } from './controls';
import { createTopBar } from './topbar';
import { createToolbar } from './toolbar';
import { createPanel } from './panel';
import { createHud, createProbeTooltip } from './hud';
import { createLoadingOverlay, createNotices } from './overlays';
import { createHelp } from './help';
import { createHowItWorks } from './howItWorks';
import { createLocationPicker } from './locationPicker';
import { installKeyboard } from './keyboard';
import { createWelcome } from './welcome';
import { createRouteChip } from './routeChip';
import { installBreakDemoRestore } from './stabilityDemo';
import { selectTool } from './toolDefs';

export { createToolController } from './tools';
/** Non-error notices (neutral toast) — e.g. for startup URL warnings. Safe to call before mountUI. */
export { postNotice, type Notice } from './bridge';

const mounted = new WeakMap<HTMLElement, () => void>();

export function mountUI(root: HTMLElement, store: Store, actions: AppActions): void {
  mounted.get(root)?.();
  root.classList.add('dl-ui');

  const binder = new Binder();
  const disposers: Array<() => void> = [];
  const ctx: UIContext = {
    own: (fn) => void disposers.push(fn),
    store,
    actions,
    bind: binder.bind.bind(binder),
    setSim(patch) {
      store.set({ sim: { ...store.get().sim, ...patch } });
    },
    setRender(patch) {
      store.set({ render: { ...store.get().render, ...patch } });
    },
    setPanel(name, open) {
      const panels = store.get().panels;
      if (panels[name] === open) return;
      store.set({ panels: { ...panels, [name]: open } });
    },
  };

  const panel = createPanel(ctx);
  const topbar = createTopBar(ctx, {
    onTogglePanel: () => panel.toggle(),
    isPanelOpen: () => panel.isOpen(),
  });
  panel.onChange(() => {
    const btn = topbar.el.querySelector('.dl-panel-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', String(panel.isOpen()));
      btn.classList.toggle('dl-on', panel.isOpen());
    }
    root.classList.toggle('dl-panel-open', panel.isOpen());
  });
  root.classList.toggle('dl-panel-open', panel.isOpen());

  const { toolbar, options } = createToolbar(ctx);
  const hud = createHud(ctx, topbar.achievedSpeed);
  const probe = createProbeTooltip(ctx);
  const routeChip = createRouteChip(ctx, { reveal: () => panel.reveal('evac') });
  const notices = createNotices(ctx, { top: [createWelcome(ctx)], bottom: [routeChip] });
  const loading = createLoadingOverlay(ctx);
  const help = createHelp(ctx);
  const how = createHowItWorks(ctx);
  const picker = createLocationPicker(ctx);

  installBreakDemoRestore(ctx);
  installSceneReset(ctx);

  const layer = h('div', { class: 'dl-layer' }, topbar.el, toolbar, options, hud, panel.el, notices.top, notices.bottom, probe.el);
  root.append(layer, loading, help.el, how.el, picker.el);

  const removeTooltips = installTooltips(root);
  const removeKeyboard = installKeyboard(ctx);

  // Modal open → mark the root so HUD/panels can dim and the canvas cursor ring can be ignored.
  binder.bind(
    (s: AppState) => s.panels.help || s.panels.howItWorks || s.panels.locationPicker,
    (anyOpen) => root.classList.toggle('dl-modal-open', anyOpen),
  );

  binder.run(store.get());
  const unsubscribe = store.subscribe((s) => binder.run(s));
  const removeAdaptive = installAdaptiveEffects(root, store);

  mounted.set(root, () => {
    disposers.splice(0).forEach((fn) => fn());
    unsubscribe();
    removeAdaptive();
    removeTooltips();
    removeKeyboard();
    probe.destroy();
    root.replaceChildren();
    root.classList.remove('dl-ui', 'dl-panel-open', 'dl-modal-open', 'dl-lowfx');
  });

  // Automation / dev hook (not part of the contract).
  (root as HTMLElement & { __delugeUI?: unknown }).__delugeUI = { picker, help, how, panel };
}

/**
 * A newly loaded scene starts like a fresh page: the Navigate tool (a first click on an unfamiliar map should orbit,
 * not set an evacuation start) and the default speed (the Try-it strip starts over too, and "Play the flood" should
 * not look done because 300× carried over). The first scene of the session keeps whatever the app set up.
 */
function installSceneReset(ctx: UIContext): void {
  const { store, bind } = ctx;
  let previous = store.get().terrainName;
  bind(
    (s) => s.terrainName,
    (name) => {
      const had = previous;
      previous = name;
      if (!had || !name || had === name) return;
      selectTool(store, 'orbit');
      const sim = store.get().sim;
      if (sim.timeScale !== DEFAULT_SIM_PARAMS.timeScale && sim.stabilityMode === 'robust') {
        store.set({ sim: { ...sim, timeScale: DEFAULT_SIM_PARAMS.timeScale } });
      }
    },
  );
}

/** Frame-rate thresholds for the low-effects glass (see styles.css `.dl-lowfx`). */
export const LOWFX = {
  /** Enable when the smoothed fps stays below this… */
  enterFps: 42,
  /** …for this long while the sim is running. */
  enterMs: 3000,
  /** Disable again only after fps stays at or above this… */
  exitFps: 56,
  /** …for this long (long, so a borderline machine doesn't flicker between the two looks). */
  exitMs: 20000,
};

/**
 * Adaptive UI effects: toggles `dl-lowfx` on the root from the app's measured fps (arrives ~5 Hz with the
 * stats), with hysteresis. Paused/loading periods are ignored — the app renders less then, so fps is not a
 * signal of load. `?lowfx=1` / `?lowfx=0` in the URL forces it for demos.
 */
function installAdaptiveEffects(root: HTMLElement, store: Store): () => void {
  const force = new URLSearchParams(location.search).get('lowfx');
  if (force === '1' || force === '0') {
    root.classList.toggle('dl-lowfx', force === '1');
    return () => {};
  }
  let low = false;
  let since: number | null = null;
  return store.subscribe((s, prev) => {
    if (s.fps === prev.fps) return;
    if (s.paused || s.loading || !(s.fps > 0)) {
      since = null;
      return;
    }
    const now = performance.now();
    const wantsSwitch = low ? s.fps >= LOWFX.exitFps : s.fps < LOWFX.enterFps;
    if (!wantsSwitch) {
      since = null;
      return;
    }
    since ??= now;
    if (now - since >= (low ? LOWFX.exitMs : LOWFX.enterMs)) {
      low = !low;
      since = null;
      root.classList.toggle('dl-lowfx', low);
    }
  });
}
