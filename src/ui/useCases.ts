/**
 * "Use cases" — the business way into the app (opened from the top bar, the Try-it strip's heading, or a
 * `?usecase=site|glacier|portfolio` link). A modal with three cards, each of which loads a scene and sets it up:
 *
 *   site       Pittsburgh + two demo parcels in Site check (read through the strict ?sites= decoder), section open,
 *              camera on the North Shore parcel;
 *   glacier    Nepal + the Hazard chain section scrolled to its Early warning designer;
 *   portfolio  Houston + the bundled fictional portfolio CSV (public/demo/) loaded into Impact & loss, updating as the
 *              rain falls.
 *
 * and a second view, "What Deluge answers for your business": a one-page brief of the questions, the numbers the app
 * computes for each, and their limits (useCaseDefs.ts BRIEF), printable through the same print path as the reports.
 *
 * Everything here is constant text written with h(); nothing from the URL reaches the page (the `?usecase=` value is
 * matched against three ids in useCaseDefs.ts). The demo CSV is fetched from this app's own origin.
 */
import { makeGeoToGrid } from '../data/geo';
import { decodeSites } from '../loss/site';
import { bridgeFor, postNotice } from './bridge';
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon, type IconName } from './icons';
import { printReport } from './impactReport';
import { createModal, type Modal } from './modal';
import type { Panel } from './panel';
import { sitesFor } from './sites';
import {
  BRIEF,
  BRIEF_LIMITS,
  DEMO_PORTFOLIO_NAME,
  DEMO_PORTFOLIO_PATH,
  DEMO_SITES_PARAM,
  parseUseCase,
  USE_CASE_PARAM,
  USE_CASES,
  useCaseById,
  type UseCaseId,
} from './useCaseDefs';

const CARD_ICONS: Record<UseCaseId, IconName> = { site: 'site', glacier: 'mountain', portfolio: 'database' };
/** Speed the portfolio case runs the rain at, so losses build up within seconds (as fast as the GPU allows). */
const PORTFOLIO_TIME_SCALE = 300;
/** Longest wait for the hazard chain before the glacier case stops waiting to scroll to Early warning, ms. */
const CHAIN_WAIT_MS = 60_000;

export interface UseCases {
  modal: Modal;
  /** Load a use case's scene and set it up (resolves once it is set up, or once it gave up). */
  apply(id: UseCaseId): Promise<void>;
  /** Show the cards (default) or the brief. */
  open(view?: 'cards' | 'brief'): void;
}

/** Base URL the app is served from (relative builds: './'). */
function baseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? '/';
}

/** Put `?usecase=<id>` in the address bar (the scene's own ?preset= is written by the app). */
function writeUseCaseToUrl(id: UseCaseId | null): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(USE_CASE_PARAM, id);
    else url.searchParams.delete(USE_CASE_PARAM);
    url.search = url.search.replace(/%2C/gi, ',');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  } catch {
    /* sandboxed iframe: not essential */
  }
}

/** The one-page brief as elements (used both in the modal and in the printed page). */
export function briefContent(print: boolean): HTMLElement[] {
  const c = (screen: string, paper: string) => (print ? paper : screen);
  const items = BRIEF.map((b) =>
    h(
      'section',
      { class: c('dl-uc-brief-item', '') },
      h(print ? 'h2' : 'h3', { class: c('dl-uc-brief-q', '') }, b.question),
      h('p', { class: c('dl-uc-brief-where', 'dl-rep-meta') }, `In the app: ${b.where}`),
      h('ul', { class: c('dl-uc-brief-list', '') }, ...b.numbers.map((n) => h('li', null, n))),
      h('p', { class: c('dl-uc-brief-caveat', 'dl-rep-warn') }, h('b', null, 'Limit: '), b.caveat),
    ),
  );
  const limits = h(
    'section',
    { class: c('dl-uc-brief-item dl-uc-brief-limits', '') },
    h(print ? 'h2' : 'h3', { class: c('dl-uc-brief-q', '') }, 'What none of these numbers are'),
    h('ul', { class: c('dl-uc-brief-list', '') }, ...BRIEF_LIMITS.map((n) => h('li', null, n))),
  );
  return [...items, limits];
}

function briefReport(): HTMLElement {
  return h(
    'div',
    { class: 'dl-print-report' },
    h(
      'header',
      { class: 'dl-rep-head' },
      h('div', { class: 'dl-rep-kicker' }, 'Deluge — flood screening for sites, portfolios and infrastructure'),
      h('h1', null, 'What Deluge answers for your business'),
      h('p', { class: 'dl-rep-meta' }, `Printed ${new Date().toISOString().slice(0, 10)}. Every number below is computed in the browser from public terrain, imagery, roads and building data; nothing is uploaded.`),
    ),
    ...briefContent(true),
  );
}

export function createUseCases(ctx: UIContext, deps: { panel: Pick<Panel, 'reveal' | 'loadPortfolio'> }): UseCases {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  let view: 'cards' | 'brief' = 'cards';
  let busy = false;

  const cards = h(
    'div',
    { class: 'dl-uc-cards' },
    ...USE_CASES.map((u) =>
      h(
        'button',
        {
          type: 'button',
          class: 'dl-uc-card',
          'data-usecase': u.id,
          onclick: () => void apply(u.id),
        },
        h('span', { class: 'dl-uc-card-icon', 'aria-hidden': 'true' }, icon(CARD_ICONS[u.id], 20)),
        h('span', { class: 'dl-uc-card-title' }, u.title),
        h('span', { class: 'dl-uc-card-who' }, u.who),
        h('span', { class: 'dl-uc-card-blurb' }, u.blurb),
        h('span', { class: 'dl-uc-card-go' }, 'Open', icon('arrowRight', 14)),
      ),
    ),
  );
  const cardsView = h(
    'div',
    { class: 'dl-uc-view', 'data-uc-view': 'cards' },
    h('p', { class: 'dl-uc-lede' }, 'Each opens a real place with demo data already in it. Swap in your own sites or CSV afterwards — nothing leaves this browser tab.'),
    cards,
  );
  const briefView = h(
    'div',
    { class: 'dl-uc-view dl-uc-brief', 'data-uc-view': 'brief', hidden: true },
    h('p', { class: 'dl-uc-lede' }, 'The questions a site, a portfolio or a plant brings, the numbers Deluge computes for each, and where those numbers stop.'),
    ...briefContent(false),
  );

  const toggleBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', 'data-uc': 'toggle', onclick: () => show(view === 'cards' ? 'brief' : 'cards') });
  const printBtn = h(
    'button',
    { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', 'data-uc': 'print', hidden: true, onclick: () => printReport(briefReport()) },
    icon('book', 14),
    h('span', null, 'Print'),
  );
  const footNote = h('span', { class: 'dl-foot-note' }, 'Indicative screening, not engineering advice.');

  const modal = createModal({
    id: 'usecases',
    title: 'Use cases',
    subtitle: 'Deluge for site due diligence, portfolios and infrastructure',
    icon: 'briefcase',
    className: 'dl-uc',
    onRequestClose: () => ctx.setPanel('useCases', false),
    body: [cardsView, briefView],
    footer: h('footer', { class: 'dl-modal-foot' }, footNote, h('div', { class: 'dl-row' }, printBtn, toggleBtn)),
  });

  function show(v: 'cards' | 'brief') {
    view = v;
    cardsView.hidden = v !== 'cards';
    briefView.hidden = v !== 'brief';
    printBtn.hidden = v !== 'brief';
    setText(toggleBtn, v === 'cards' ? 'What Deluge answers for your business' : 'Back to use cases');
    toggleClass(modal.dialog, 'dl-uc-brief-open', v === 'brief');
    modal.body.scrollTop = 0;
  }
  show('cards');

  ctx.bind(
    (s) => !!s.panels.useCases,
    (open) => modal.setOpen(open),
  );

  // ─── Applying a use case ──────────────────────────────────────────────────────────────────────────────────
  async function ensureScene(preset: string): Promise<boolean> {
    const s = store.get();
    if (s.presetId === preset && s.terrainName && !s.loading) return true;
    try {
      await ctx.actions.loadPreset(preset);
    } catch {
      return false;
    }
    const after = store.get();
    return after.presetId === preset && !!after.terrainName;
  }

  async function apply(id: UseCaseId): Promise<void> {
    if (busy) return;
    busy = true;
    ctx.setPanel('useCases', false);
    const def = useCaseById(id);
    try {
      if (!(await ensureScene(def.preset))) return;
      writeUseCaseToUrl(id);
      if (id === 'site') setUpSite();
      else if (id === 'glacier') setUpGlacier();
      else await setUpPortfolio();
      postNotice(store, { kind: 'info', key: 'usecase', title: def.title, message: def.howTo, durationMs: 14000 });
    } finally {
      busy = false;
    }
  }

  function setUpSite(): void {
    const registry = sitesFor(store);
    // A ?sites= link (or sites the user already placed) wins over the demo parcels.
    if (!registry.sites.length) {
      const { sites } = decodeSites(DEMO_SITES_PARAM);
      if (sites.length) registry.replace(sites);
    }
    deps.panel.reveal('site');
    const first = registry.selected ?? registry.sites[0];
    const terrain = bridge.scene?.getTerrain() ?? null;
    const camera = bridge.scene?.getCamera?.() ?? null;
    if (!first || !terrain || !camera) return;
    const [gx, gy] = makeGeoToGrid(terrain)(first.lon, first.lat);
    if (!(gx >= 0 && gy >= 0 && gx < terrain.nx && gy < terrain.ny)) return;
    const elevation = terrain.elevation[Math.floor(gy) * terrain.nx + Math.floor(gx)];
    try {
      camera.flyTo({ target: { gx, gy, elevation }, distance: 1400, yaw: camera.pose.yaw, pitch: 0.85 }, 1.4);
    } catch {
      /* renderer gone */
    }
  }

  function setUpGlacier(): void {
    deps.panel.reveal('chain');
    const scrollToWarning = () => {
      const blk = document.querySelector<HTMLElement>('[data-ew="block"]');
      if (!blk || blk.hidden) return false;
      requestAnimationFrame(() => blk.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return true;
    };
    if (bridge.chain?.result && scrollToWarning()) return;
    // The chain runs in a worker after the scene loads: wait for its result, then show the designer.
    let off = () => {};
    const timer = setTimeout(() => off(), CHAIN_WAIT_MS);
    off = bridge.chainChanged.on((c) => {
      if (!c?.result) return;
      // The block renders from the same event; look for it once it has.
      requestAnimationFrame(() => {
        if (scrollToWarning()) {
          clearTimeout(timer);
          off();
        }
      });
    });
  }

  async function setUpPortfolio(): Promise<void> {
    let text: string;
    try {
      const res = await fetch(`${baseUrl()}${DEMO_PORTFOLIO_PATH}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      text = await res.text();
    } catch {
      postNotice(store, { kind: 'info', key: 'usecase-csv', title: 'Demo portfolio not found', message: 'The bundled demo CSV could not be read. Load your own under Impact & loss.' });
      deps.panel.reveal('impact');
      return;
    }
    deps.panel.reveal('impact');
    deps.panel.loadPortfolio(DEMO_PORTFOLIO_NAME, text, { auto: true });
    const s = store.get();
    store.set({ paused: false, sim: { ...s.sim, timeScale: Math.max(s.sim.timeScale, PORTFOLIO_TIME_SCALE) } });
    // The asset table sits below the city-wide cards: bring it into view once the panel has scrolled to the section.
    setTimeout(() => document.querySelector('.dl-impact-portfolio')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 700);
  }

  // A ?usecase= link: set it up once the first scene is on screen (src/app/url.ts already loaded its preset).
  const { useCase } = parseUseCase(typeof location === 'undefined' ? '' : location.search);
  if (useCase) {
    let pending = true;
    ctx.bind(
      (s) => !!(s.terrainName && !s.loading),
      (ready) => {
        if (!pending || !ready) return;
        pending = false;
        // After the panel's own first render (its sections are built in this same mount).
        queueMicrotask(() => void apply(useCase));
      },
    );
  }

  return {
    modal,
    apply,
    open(v = 'cards') {
      show(v);
      ctx.setPanel('useCases', true);
    },
  };
}

