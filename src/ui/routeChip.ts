/**
 * Evacuation route chip: a compact, always-visible summary of the current route whenever an evacuation start is
 * set — destination, distance and drive time, or a red NO SAFE ROUTE — so the result of the evacuation tool
 * never hides below the fold of the side panel. Clicking it opens the Evacuation section for details.
 */
import type { AppState, RouteResult } from '../contracts';
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon } from './icons';
import { formatDistance, formatDuration } from './format';
import { blockedSummary, closureText } from './routeText';

/** How long the chip holds the "last route out just closed" announcement before settling to the standing reason. */
const CLOSURE_FLASH_MS = 6000;

export function createRouteChip(ctx: UIContext, opts: { reveal(): void }): HTMLElement {
  const { store, bind } = ctx;

  const statusIcon = h('span', { class: 'dl-route-icon' });
  const label = h('span', { class: 'dl-route-label' });
  const dest = h('span', { class: 'dl-route-dest' });
  const metrics = h('span', { class: 'dl-route-metrics' });
  const body = h(
    'button',
    {
      type: 'button',
      class: 'dl-route-body',
      'data-tip': 'Show evacuation details',
      'data-tip-side': 'top',
      onclick: () => opts.reveal(),
    },
    statusIcon,
    h('span', { class: 'dl-route-text' }, label, dest),
    metrics,
  );
  const clear = h(
    'button',
    {
      type: 'button',
      class: 'dl-icon-btn dl-route-clear',
      'aria-label': 'Clear the evacuation start',
      'data-tip': 'Clear the evacuation start',
      'data-tip-side': 'top',
      onclick: () => store.set({ evacStart: null }),
    },
    icon('close', 14),
  );
  const el = h('div', { class: 'dl-route-chip', role: 'status', 'aria-live': 'polite' }, body, clear);

  let lastShelter: string | null = null;
  let lastStart: AppState['evacStart'] = null;
  /** The closure already announced, so the "last route closed" moment flashes once and not at every readback. */
  let announcedClosure = -1;
  /** True while the closure flash owns the chip's text (later readbacks must not overwrite it mid-flash). */
  let flashingClosure = false;
  let flashTimer = 0;
  let iconKind = '';
  const setIcon = (kind: 'ok' | 'blocked' | 'wait') => {
    if (kind === iconKind) return;
    iconKind = kind;
    statusIcon.replaceChildren(kind === 'ok' ? icon('check', 17) : kind === 'blocked' ? icon('warning', 17) : h('span', { class: 'dl-spinner dl-spin-on' }));
  };

  /** The standing blocked text, once any closure flash is over. */
  function settle() {
    const r = store.get().route;
    setText(label, 'No safe route');
    setText(dest, blockedSummary(r));
  }

  function render(route: RouteResult | null, s: AppState) {
    // Hidden during the stability demo: routing ignores the blown-up depths (src/app/evac.ts), so the chip would only
    // repeat a stale verdict as a second red alarm under the demo banner. It comes back with the robust solver.
    const show = !!s.evacStart && !!s.terrainName && !s.loading;
    // A new start point is a new plan, not a re-plan.
    if (s.evacStart !== lastStart) {
      lastStart = s.evacStart;
      lastShelter = null;
      announcedClosure = -1;
      flashingClosure = false;
      clearTimeout(flashTimer);
    }
    toggleClass(el, 'dl-show', show);
    el.inert = !show;
    if (!show) {
      lastShelter = null;
      return;
    }
    const state = route?.state ?? 'none';
    el.dataset.state = state === 'none' ? 'wait' : state;
    if (state === 'ok' && route) {
      setIcon('ok');
      setText(label, 'Safe route to');
      setText(dest, route.shelter?.name ?? 'nearest shelter');
      setText(metrics, `${formatDistance(route.lengthMeters)} · ${formatDuration(route.etaSeconds)}`);
      metrics.hidden = false;
      // A different shelter than before means the flood forced a re-plan: flash the chip.
      const name = route.shelter?.name ?? '';
      if (lastShelter !== null && name !== lastShelter) {
        el.classList.remove('dl-replanned');
        void el.offsetWidth;
        el.classList.add('dl-replanned');
        clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          el.classList.remove('dl-replanned');
          setText(label, 'Safe route to');
        }, 4000);
        setText(label, 'Re-planned — safe route to');
      }
      lastShelter = name;
    } else if (state === 'blocked') {
      setIcon('blocked');
      metrics.hidden = true;
      lastShelter = '';
      // The moment the last way out closes is the loudest thing in the demo: flash it once, with the sim clock and
      // the route that was lost, then settle back to the standing reason.
      const closure = route?.closure ?? null;
      if (closure && closure.simTime !== announcedClosure) {
        announcedClosure = closure.simTime;
        flashingClosure = true;
        setText(label, 'Last route out just closed');
        setText(dest, closureText(route));
        el.classList.remove('dl-replanned');
        void el.offsetWidth;
        el.classList.add('dl-replanned');
        clearTimeout(flashTimer);
        flashTimer = window.setTimeout(() => {
          flashingClosure = false;
          el.classList.remove('dl-replanned');
          settle();
        }, CLOSURE_FLASH_MS);
      } else if (!flashingClosure) settle();
    } else {
      setIcon('wait');
      setText(label, s.shelters.length ? 'Planning evacuation route…' : 'No shelters to route to');
      setText(dest, s.shelters.length ? '' : 'Add one with the Shelter tool (9)');
      metrics.hidden = true;
    }
  }

  bind(
    (s) => [s.route, s.evacStart, s.shelters.length, !!s.loading, s.terrainName] as const,
    (_k, s) => render(s.route, s),
    (a, b) => a.every((x, i) => Object.is(x, b[i])),
  );
  return el;
}
