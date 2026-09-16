/**
 * Deluge UI — mountUI(root, store, actions) renders the whole interface from store state, and
 * createToolController(canvas, deps) turns canvas pointer input into edits (see tools.ts).
 *
 * Rendering model: every component registers selector → apply bindings on a single Binder. On each
 * store change the binder re-evaluates selectors and touches the DOM only where a selected value
 * changed, so the ~5 Hz stats stream never rebuilds panels, steals focus or interrupts slider drags.
 */
import './styles.css';
import type { AppActions, AppState, Store } from '../contracts';
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

export { createToolController } from './tools';
export { renderUnsupported } from './overlays';

const mounted = new WeakMap<HTMLElement, () => void>();

export function mountUI(root: HTMLElement, store: Store, actions: AppActions): void {
  mounted.get(root)?.();
  root.classList.add('dl-ui');

  const binder = new Binder();
  const ctx: UIContext = {
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
  const notices = createNotices(ctx);
  const loading = createLoadingOverlay(ctx);
  const help = createHelp(ctx);
  const how = createHowItWorks(ctx);
  const picker = createLocationPicker(ctx);

  const layer = h('div', { class: 'dl-layer' }, topbar.el, toolbar, options, hud, panel.el, notices, probe.el);
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

  mounted.set(root, () => {
    unsubscribe();
    removeTooltips();
    removeKeyboard();
    probe.destroy();
    root.replaceChildren();
    root.classList.remove('dl-ui', 'dl-panel-open', 'dl-modal-open');
  });

  // Automation / dev hook (not part of the contract).
  (root as HTMLElement & { __delugeUI?: unknown }).__delugeUI = { picker, help, how, panel };
}
