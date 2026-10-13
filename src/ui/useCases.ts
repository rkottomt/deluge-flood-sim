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
import { isLikelyUS, makeGeoToGrid } from '../data/geo';
import { cleanPlaceLabel } from '../data/placeName';
import { decodeSites } from '../loss/site';
import { parseStoryParam } from '../story/registry';
import { MAX_GEO_QUERY, searchUSPlaces, type GeoChoice } from './geoResults';
import { bridgeFor, postNotice } from './bridge';
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon, type IconName } from './icons';
import { printReport } from './impactReport';
import { createModal, type Modal } from './modal';
import type { Panel } from './panel';
import { sitesFor } from './sites';
import { createDamView } from './damView';
import { createSurgeView } from './surgeView';
import {
  ADDRESS_AREA_M,
  ADDRESS_PARAM,
  addressAreaRequest,
  BRIEF,
  BRIEF_LIMITS,
  DEMO_PORTFOLIO_NAME,
  DEMO_PORTFOLIO_PATH,
  DEMO_SITES_PARAM,
  formatAddressAt,
  parseAddressAt,
  parseUseCase,
  USE_CASE_PARAM,
  USE_CASES,
  useCaseById,
  type UseCaseId,
} from './useCaseDefs';

const CARD_ICONS: Record<UseCaseId, IconName> = { site: 'site', glacier: 'mountain', portfolio: 'database', address: 'location', dam: 'wall', surge: 'gauge' };
/** A geocoder result as a site name: "1600 Smith Street" rather than a bare house number. */
function addressLabel(c: GeoChoice): string {
  return /^\d[\w-]*$/.test(c.first) && c.rest[0] ? `${c.first} ${c.rest[0]}` : c.first;
}

/** "lat, lon" typed into the address box: used as is, without asking the geocoder. */
const LATLON_TYPED = /^\s*(-?\d{1,2}(?:\.\d{1,8})?)\s*,\s*(-?\d{1,3}(?:\.\d{1,8})?)\s*$/;
/** Speed the portfolio case runs the rain at, so losses build up within seconds (as fast as the GPU allows). */
const PORTFOLIO_TIME_SCALE = 300;
/** Longest wait for the hazard chain before the glacier case stops waiting to scroll to Early warning, ms. */
const CHAIN_WAIT_MS = 60_000;

export interface UseCases {
  modal: Modal;
  /** Load a use case's scene and set it up (resolves once it is set up, or once it gave up). */
  apply(id: UseCaseId): Promise<void>;
  /** Show the cards (default), the brief, or the address search. */
  open(view?: UseCaseView): void;
}

export type UseCaseView = 'cards' | 'brief' | 'address' | 'dam' | 'surge';

/** Base URL the app is served from (relative builds: './'). */
function baseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return env?.BASE_URL ?? '/';
}

/**
 * Put `?usecase=<id>` in the address bar (the scene's own ?preset= / ?live= is written by the app); for the address
 * case also `at=<lat>,<lon>` — coordinates only, never the text the user typed.
 */
function writeUseCaseToUrl(id: UseCaseId | null, at?: { lat: number; lon: number }): void {
  try {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set(USE_CASE_PARAM, id);
    else url.searchParams.delete(USE_CASE_PARAM);
    if (id === 'address' && at) url.searchParams.set(ADDRESS_PARAM, formatAddressAt(at.lat, at.lon));
    else url.searchParams.delete(ADDRESS_PARAM);
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

export function createUseCases(ctx: UIContext, deps: { panel: Pick<Panel, 'reveal' | 'loadPortfolio' | 'siteCheck'> }): UseCases {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  let view: UseCaseView = 'cards';
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
          onclick: () => (u.id === 'address' ? openAddress() : u.id === 'dam' ? openView('dam') : u.id === 'surge' ? openView('surge') : void apply(u.id)),
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

  // ─── "Check any US address" ───────────────────────────────────────────────────────────────────────────────
  const addrInput = h('input', {
    type: 'search',
    class: 'dl-uc-addr-input',
    placeholder: 'Street address, place, or lat, lon',
    'aria-label': 'US address to check',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: MAX_GEO_QUERY,
    'data-uc': 'address-input',
  });
  const addrBtn = h('button', { type: 'submit', class: 'dl-btn dl-btn-primary dl-btn-sm', 'data-uc': 'address-search' }, icon('search', 14), h('span', null, 'Find'));
  const addrResults = h('div', { class: 'dl-uc-addr-results', role: 'listbox', 'data-uc': 'address-results' });
  const addrStatus = h('p', { class: 'dl-uc-addr-status', 'aria-live': 'polite', 'data-uc': 'address-status' });
  const addrForm = h('form', { class: 'dl-uc-addr-form', role: 'search' }, addrInput, addrBtn);
  const addressView = h(
    'div',
    { class: 'dl-uc-view dl-uc-address', 'data-uc-view': 'address', hidden: true },
    h(
      'p',
      { class: 'dl-uc-lede' },
      `Type a US address. Deluge loads ${ADDRESS_AREA_M / 1000} km of elevation (USGS 3DEP), imagery and roads around it — this needs internet — drops a site on the point and opens Site check on NOAA Atlas 14 rain return periods. What you type goes to the OpenStreetMap geocoder only; links carry the coordinates, never the address.`,
    ),
    addrForm,
    addrStatus,
    addrResults,
  );
  let addrAbort: AbortController | null = null;
  // Dam-breach and coastal-surge views (src/ui/damView.ts, src/ui/surgeView.ts).
  const damView = createDamView(ctx, { panel: deps.panel, show: () => show('dam') });
  const surgeView = createSurgeView(ctx, { panel: deps.panel, show: () => show('surge') });
  function openView(v: 'dam' | 'surge') {
    show(v);
    ctx.setPanel('useCases', true);
    (v === 'dam' ? damView : surgeView).focus();
  }
  addrForm.addEventListener('submit', (e) => {
    e.preventDefault();
    void findAddress();
  });

  async function findAddress(): Promise<void> {
    const q = addrInput.value.trim().slice(0, MAX_GEO_QUERY);
    addrResults.replaceChildren();
    // A search still in flight must not land on top of this one (typed coordinates included).
    addrAbort?.abort();
    addrAbort = null;
    if (!q) return setText(addrStatus, 'Type an address first.');
    const typed = LATLON_TYPED.exec(q);
    if (typed) {
      const lat = Number(typed[1]);
      const lon = Number(typed[2]);
      if (!isLikelyUS(lat, lon)) return setText(addrStatus, 'That point is outside the United States: NOAA Atlas 14 and USGS 3DEP cover the US only.');
      return showAddressChoices([{ lat, lon, first: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, rest: ['coordinates as typed'] }]);
    }
    const mine = (addrAbort = new AbortController());
    setText(addrStatus, 'Searching…');
    try {
      const choices = await searchUSPlaces(q, mine.signal);
      if (addrAbort !== mine) return;
      if (!choices.length) return setText(addrStatus, 'No US place found. Try street, city and state, e.g. “1600 Smith St, Houston, TX”.');
      showAddressChoices(choices);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError' || addrAbort !== mine) return;
      setText(addrStatus, 'The address search is unavailable right now (it needs internet). You can type the point as “lat, lon” instead.');
    }
  }

  function showAddressChoices(choices: GeoChoice[]) {
    setText(addrStatus, choices.length === 1 ? 'Check this place:' : 'Pick the right one:');
    addrResults.replaceChildren(
      ...choices.map((c) =>
        h(
          'button',
          { type: 'button', class: 'dl-search-result', role: 'option', 'data-uc': 'address-choice', onclick: () => void checkAddress({ lat: c.lat, lon: c.lon }, addressLabel(c)) },
          icon('pin', 15),
          h('span', { class: 'dl-result-text' }, h('b', null, c.first), h('span', null, c.rest.slice(0, 3).join(', '))),
        ),
      ),
    );
  }

  function openAddress() {
    show('address');
    ctx.setPanel('useCases', true);
    requestAnimationFrame(() => addrInput.focus());
  }
  bridge.openAddressCheck = openAddress;
  ctx.own(() => {
    if (bridge.openAddressCheck === openAddress) bridge.openAddressCheck = null;
  });

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
    body: [cardsView, briefView, addressView, damView.el, surgeView.el],
    footer: h('footer', { class: 'dl-modal-foot' }, footNote, h('div', { class: 'dl-row' }, printBtn, toggleBtn)),
  });

  function show(v: UseCaseView) {
    view = v;
    cardsView.hidden = v !== 'cards';
    briefView.hidden = v !== 'brief';
    addressView.hidden = v !== 'address';
    damView.el.hidden = v !== 'dam';
    surgeView.el.hidden = v !== 'surge';
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
  /** The scene on screen; a set-up that waits (a download, the chain's worker) checks it is still the same one. */
  const sceneKey = () => {
    const s = store.get();
    return `${s.presetId}|${s.terrainName}`;
  };

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
    if (id === 'address') {
      // From a link: the point is in `at=` (strictly parsed); without one, ask for the address.
      const at = parseAddressAt(typeof location === 'undefined' ? '' : location.search).at;
      if (at) await checkAddress(at, null);
      else openAddress();
      return;
    }
    if (id === 'dam') return damView.apply();
    if (id === 'surge') return surgeView.apply();
    if (busy) return;
    busy = true;
    ctx.setPanel('useCases', false);
    const def = useCaseById(id);
    try {
      if (!def.preset || !(await ensureScene(def.preset))) return;
      writeUseCaseToUrl(id);
      if (id === 'site') setUpSite();
      else if (id === 'glacier') setUpGlacier();
      else await setUpPortfolio();
      postNotice(store, { kind: 'info', key: 'usecase', title: def.title, message: def.howTo, durationMs: 14000 });
    } finally {
      busy = false;
    }
  }

  // ─── The address case ─────────────────────────────────────────────────────────────────────────────────────
  /** The live area on screen is the one loaded around `at` (a reload of an address link, or a second click). */
  function onAddressArea(at: { lat: number; lon: number }): boolean {
    const s = store.get();
    const t = bridge.scene?.getTerrain() ?? null;
    if (s.presetId !== null || !t || s.loading || !s.terrainName) return false;
    const cLat = (t.bounds.north + t.bounds.south) / 2;
    const cLon = (t.bounds.east + t.bounds.west) / 2;
    return Math.abs(cLat - at.lat) < 1e-4 && Math.abs(cLon - at.lon) < 1e-4 && Math.abs(t.nx * t.cellSize - ADDRESS_AREA_M) < 1;
  }

  /**
   * Load the area around `at`, drop a site on the point, open Site check on the NOAA Atlas 14 rain ladder and offer
   * to run the sweep. `label` is the geocoder's (cleaned) name for the place, or null from a link — a link never names
   * the place; the loader reverse-geocodes it.
   */
  async function checkAddress(at: { lat: number; lon: number }, label: string | null): Promise<void> {
    if (busy) return;
    busy = true;
    ctx.setPanel('useCases', false);
    const def = useCaseById('address');
    try {
      if (!onAddressArea(at)) {
        const req = addressAreaRequest(at);
        let outcome: unknown;
        try {
          // No name: the area is named by the app's own reverse geocoding (a neighbourhood), so the scene title and
          // the ?live=&name= the app writes into the address bar never carry the street address the user typed.
          outcome = await ctx.actions.loadLiveArea(req);
        } catch {
          outcome = 'failed';
        }
        if (outcome === 'superseded') return;
        if (outcome === 'failed' || !onAddressArea(at)) {
          postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'The area around this address could not be loaded (it needs USGS 3DEP elevation over the internet). Try again, or open a built-in scenario.' });
          return;
        }
      }
      writeUseCaseToUrl('address', at);
      const key0 = sceneKey();
      const registry = sitesFor(store);
      const name = cleanPlaceLabel(label ?? '') || 'The address';
      let site = registry.sites.find((s) => Math.abs(s.lat - at.lat) < 1e-6 && Math.abs(s.lon - at.lon) < 1e-6) ?? null;
      if (site) registry.select(site.id);
      else {
        site = registry.add(at.lon, at.lat);
        // Named after the address on screen; geocodedName keeps that name out of share links (encodeSites).
        if (site) registry.update(site.id, label ? { name, geocodedName: name } : { name });
      }
      deps.panel.reveal('site');
      flyTo(at.lon, at.lat, 900);
      const rainOk = await deps.panel.siteCheck.useRainLadder();
      if (sceneKey() !== key0) return;
      if (!site) {
        postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'Site check is full: remove a site, then press S and click the address on the map.' });
      } else if (rainOk) {
        postNotice(store, {
          kind: 'info',
          key: 'usecase',
          title: def.title,
          message: def.howTo,
          durationMs: 30000,
          action: { label: 'Run the sweep', run: () => void deps.panel.siteCheck.runSweep() },
        });
      } else {
        postNotice(store, {
          kind: 'info',
          key: 'usecase',
          title: def.title,
          message: 'The site is in Site check, but no NOAA Atlas 14 rain estimate covers this place (western Washington and Oregon are not in Atlas 14), so there is no rain ladder: the sweep uses this area’s water-level control instead, and needs your return periods for an EAL.',
          durationMs: 20000,
        });
      }
    } finally {
      busy = false;
    }
  }

  function flyTo(lon: number, lat: number, distance: number): void {
    const terrain = bridge.scene?.getTerrain() ?? null;
    const camera = bridge.scene?.getCamera?.() ?? null;
    if (!terrain || !camera) return;
    const [gx, gy] = makeGeoToGrid(terrain)(lon, lat);
    if (!(gx >= 0 && gy >= 0 && gx < terrain.nx && gy < terrain.ny)) return;
    const elevation = terrain.elevation[Math.floor(gy) * terrain.nx + Math.floor(gx)];
    try {
      camera.flyTo({ target: { gx, gy, elevation }, distance, yaw: camera.pose.yaw, pitch: 0.85 }, 1.4);
    } catch {
      /* renderer gone */
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
    // The chain runs in a worker after the scene loads: wait for its result, then show the designer — on THIS scene
    // only: leaving it (another preset, a live area) ends the wait, so a later chain elsewhere does not scroll the panel.
    const key0 = sceneKey();
    let done = false;
    const stop = () => {
      done = true;
      clearTimeout(timer);
      offChain();
      offScene();
    };
    const timer = setTimeout(stop, CHAIN_WAIT_MS);
    const offScene = store.subscribe(() => {
      if (sceneKey() !== key0) stop();
    });
    const offChain = bridge.chainChanged.on((c) => {
      if (!c?.result) return;
      // The block renders from the same event; look for it once it has.
      requestAnimationFrame(() => {
        if (!done && sceneKey() === key0 && scrollToWarning()) stop();
      });
    });
  }

  async function setUpPortfolio(): Promise<void> {
    // The demo's assets are on the Houston map and its fast-forward is for Houston's rain: if the user leaves the
    // scene while the CSV downloads, neither may land in the next one.
    const key0 = sceneKey();
    let text: string;
    try {
      const res = await fetch(`${baseUrl()}${DEMO_PORTFOLIO_PATH}`, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(String(res.status));
      text = await res.text();
    } catch {
      if (sceneKey() !== key0) return;
      postNotice(store, { kind: 'info', key: 'usecase-csv', title: 'Demo portfolio not found', message: 'The bundled demo CSV could not be read. Load your own under Impact & loss.' });
      deps.panel.reveal('impact');
      return;
    }
    if (sceneKey() !== key0 || store.get().loading) return;
    deps.panel.reveal('impact');
    deps.panel.loadPortfolio(DEMO_PORTFOLIO_NAME, text, { auto: true });
    const s = store.get();
    store.set({ paused: false, sim: { ...s.sim, timeScale: Math.max(s.sim.timeScale, PORTFOLIO_TIME_SCALE) } });
    // The asset table sits below the city-wide cards: bring it into view once the panel has scrolled to the section.
    setTimeout(() => document.querySelector('.dl-impact-portfolio')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 700);
  }

  // A ?usecase= link: set it up once the first scene is on screen (src/app/url.ts already loaded its preset).
  // A ?story= link wins: the story sets up its own scene (a dam story breaches its dam itself; a story that used a use
  // case leaves ?usecase= in the address bar, which must not set it up a second time under the story).
  const search = typeof location === 'undefined' ? '' : location.search;
  const { useCase } = parseUseCase(search);
  if (useCase && !parseStoryParam(search).story) {
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

