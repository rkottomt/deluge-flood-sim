/**
 * Global keyboard shortcuts. Installed by mountUI because several need AppActions.
 *   1…0 tools · Space play/pause · R reset water · F frame all · T top-down · V next water view · H or ? help
 *   Esc closes the top-most modal (the tool controller separately cancels an in-progress wall)
 *   [ and ] shrink / grow the brush
 */
import type { AppState, WaterViewMode } from '../contracts';
import { isTypingTarget, type UIContext } from './dom';
import { selectTool, scaleBrush, toolForKey } from './toolDefs';

/** Water views in the order V cycles through them (the View section's segmented control order). */
export const VIEW_CYCLE: WaterViewMode[] = ['realistic', 'depth', 'maxDepth', 'velocity'];

export function nextViewMode(mode: WaterViewMode, backwards = false): WaterViewMode {
  const k = VIEW_CYCLE.indexOf(mode);
  const n = VIEW_CYCLE.length;
  return VIEW_CYCLE[((k < 0 ? 0 : k) + (backwards ? n - 1 : 1)) % n];
}

export function installKeyboard(ctx: UIContext): () => void {
  const { store, actions } = ctx;

  const topModal = (s: AppState): keyof AppState['panels'] | null => {
    if (s.panels.locationPicker) return 'locationPicker';
    if (s.panels.howItWorks) return 'howItWorks';
    if (s.panels.help) return 'help';
    return null;
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const s = store.get();

    if (e.key === 'Escape') {
      if (ctx.skipTutorial && document.querySelector('.dl-tutorial:not([hidden])')) {
        e.preventDefault();
        ctx.skipTutorial();
        return;
      }
      const m = topModal(s);
      if (m) {
        e.preventDefault();
        ctx.setPanel(m, false);
      }
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;

    const modal = topModal(s);
    if (e.key === '?' || e.key === 'h' || e.key === 'H') {
      if (modal && modal !== 'help') return;
      e.preventDefault();
      ctx.setPanel('help', !s.panels.help);
      return;
    }
    if (modal) return; // tools & sim shortcuts are inert behind a modal

    // Digits: use `code` so Shift or keyboard layouts don't break them.
    const digit = /^Digit(\d)$/.exec(e.code)?.[1] ?? /^Numpad(\d)$/.exec(e.code)?.[1] ?? (/^\d$/.test(e.key) ? e.key : null);
    if (digit !== null && !e.shiftKey) {
      const def = toolForKey(digit);
      if (def) {
        e.preventDefault();
        selectTool(store, def.id);
      }
      return;
    }

    switch (e.key) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        if (!e.repeat) store.set({ paused: !s.paused });
        return;
      case 'r':
      case 'R':
        if (e.repeat) return;
        e.preventDefault();
        actions.resetWater();
        return;
      case 'f':
      case 'F':
        e.preventDefault();
        actions.cameraFrameAll();
        return;
      case 't':
      case 'T':
        e.preventDefault();
        actions.cameraTopDown();
        return;
      case 'v':
      case 'V':
        // Realistic → Depth → Max depth → Speed (Shift+V goes back).
        e.preventDefault();
        ctx.setRender({ waterMode: nextViewMode(s.render.waterMode, e.shiftKey) });
        return;
      case '[':
        e.preventDefault();
        scaleBrush(store, 1 / 1.25);
        return;
      case ']':
        e.preventDefault();
        scaleBrush(store, 1.25);
        return;
    }
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
