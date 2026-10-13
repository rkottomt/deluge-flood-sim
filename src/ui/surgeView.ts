/**
 * "Coastal surge exposure" — a view of the Use cases dialog (src/ui/useCases.ts): a place on the U.S. coast (geocoder,
 * typed lat, lon, or the live area already on screen) → an 8 km live area → the sea held on its seaward edges at the
 * nearest NOAA tide station's extreme water levels (src/surge) → a site on the point and Site check on that ladder,
 * ready to sweep to an expected annual loss.
 *
 * Data: public/surge/ewl-stations.json (same origin, strict parser). No new endpoint: the geocoder is the picker's own
 * Nominatim search, the terrain the usual live-area loaders. The link carries `at=<lat>,<lon>` only (parseAddressAt).
 */
import { cleanPlaceLabel } from '../data/placeName';
import { isLikelyUS, makeGeoToGrid } from '../data/geo';
import { coastalSetup, gaugeNote, withoutSurgeText } from '../surge/coastal';
import { loadSurgeTable, nearestStation, SURGE_LIMITS, type SurgeTable } from '../surge/stations';
import { bridgeFor, postNotice } from './bridge';
import { h, setText, type UIContext } from './dom';
import { fmtNum } from './format';
import { MAX_GEO_QUERY, searchUSPlaces, type GeoChoice } from './geoResults';
import { icon } from './icons';
import type { Panel } from './panel';
import { sitesFor } from './sites';
import { ADDRESS_PARAM, formatAddressAt, parseAddressAt, SURGE_AREA_M, surgeAreaRequest, USE_CASE_PARAM, useCaseById } from './useCaseDefs';
import './damSurge.css';

const LATLON_TYPED = /^\s*(-?\d{1,2}(?:\.\d{1,8})?)\s*,\s*(-?\d{1,3}(?:\.\d{1,8})?)\s*$/;

export interface SurgeView {
  el: HTMLElement;
  focus(): void;
  /** A `?usecase=surge&at=` link: set the point up, or show the search. */
  apply(): Promise<void>;
}

export function createSurgeView(ctx: UIContext, deps: { panel: Pick<Panel, 'reveal' | 'siteCheck'>; show(): void }): SurgeView {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  let table: SurgeTable | null = null;
  let busy = false;
  let abort: AbortController | null = null;

  const input = h('input', {
    type: 'search',
    class: 'dl-uc-addr-input',
    placeholder: 'Coastal address, place, or lat, lon',
    'aria-label': 'US coastal place to check',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: MAX_GEO_QUERY,
    'data-surge': 'input',
  });
  const findBtn = h('button', { type: 'submit', class: 'dl-btn dl-btn-primary dl-btn-sm', 'data-surge': 'search' }, icon('search', 14), h('span', null, 'Find'));
  const hereBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', 'data-surge': 'here', onclick: () => void useThisMap() }, icon('location', 14), h('span', null, 'Use this map'));
  const form = h('form', { class: 'dl-uc-addr-form', role: 'search' }, input, findBtn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void find();
  });
  const status = h('p', { class: 'dl-uc-addr-status', 'aria-live': 'polite', 'data-surge': 'status' });
  const results = h('div', { class: 'dl-uc-addr-results', role: 'listbox', 'data-surge': 'results' });
  const el = h(
    'div',
    { class: 'dl-uc-view dl-surge', 'data-uc-view': 'surge', hidden: true },
    h(
      'p',
      { class: 'dl-uc-lede' },
      `Type a place on the U.S. coast. Deluge loads ${SURGE_AREA_M / 1000} km around it (this needs internet), holds the sea on the map’s seaward edges at NOAA’s 1-, 2-, 10-, 50- and 100-year still-water levels from the nearest long-term tide gauge, drops a site on the point and opens Site check on that ladder. Or use the live area already on screen.`,
    ),
    h('div', { class: 'dl-row dl-dam-search' }, form, hereBtn),
    status,
    results,
  );

  async function ensureTable(): Promise<SurgeTable | null> {
    if (table) return table;
    try {
      table = await loadSurgeTable();
      return table;
    } catch (err) {
      console.warn('[surge] station table unavailable:', err);
      setText(status, 'The NOAA tide-station table could not be loaded. Reload the page to try again.');
      return null;
    }
  }

  async function find(): Promise<void> {
    const q = input.value.trim().slice(0, MAX_GEO_QUERY);
    results.replaceChildren();
    if (!q) return setText(status, 'Type a place first.');
    const typed = LATLON_TYPED.exec(q);
    if (typed) {
      const lat = Number(typed[1]);
      const lon = Number(typed[2]);
      if (!isLikelyUS(lat, lon)) return setText(status, 'That point is outside the United States: the NOAA tide stations and USGS 3DEP used here are U.S. only.');
      return showChoices([{ lat, lon, first: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, rest: ['coordinates as typed'] }]);
    }
    abort?.abort();
    abort = new AbortController();
    setText(status, 'Searching…');
    try {
      const choices = await searchUSPlaces(q, abort.signal);
      if (!choices.length) return setText(status, 'No US place found. Try a street, city and state.');
      showChoices(choices);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setText(status, 'The place search is unavailable right now (it needs internet). You can type the point as “lat, lon” instead.');
    }
  }

  function showChoices(choices: GeoChoice[]): void {
    setText(status, choices.length === 1 ? 'Check this place:' : 'Pick the right one:');
    results.replaceChildren(
      ...choices.map((c) =>
        h(
          'button',
          { type: 'button', class: 'dl-search-result', role: 'option', 'data-surge': 'choice', onclick: () => void checkSurge({ lat: c.lat, lon: c.lon }, /^\d[\w-]*$/.test(c.first) && c.rest[0] ? `${c.first} ${c.rest[0]}` : c.first) },
          icon('pin', 15),
          h('span', { class: 'dl-result-text' }, h('b', null, c.first), h('span', null, c.rest.slice(0, 3).join(', '))),
        ),
      ),
    );
  }

  function onSurgeArea(at: { lat: number; lon: number }): boolean {
    const s = store.get();
    const t = bridge.scene?.getTerrain() ?? null;
    if (s.presetId !== null || !t || s.loading || !s.terrainName) return false;
    const cLat = (t.bounds.north + t.bounds.south) / 2;
    const cLon = (t.bounds.east + t.bounds.west) / 2;
    return Math.abs(cLat - at.lat) < 1e-4 && Math.abs(cLon - at.lon) < 1e-4 && Math.abs(t.nx * t.cellSize - SURGE_AREA_M) < 1;
  }

  function writeLink(at: { lat: number; lon: number } | null): void {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(USE_CASE_PARAM, 'surge');
      if (at) url.searchParams.set(ADDRESS_PARAM, formatAddressAt(at.lat, at.lon));
      else url.searchParams.delete(ADDRESS_PARAM);
      url.search = url.search.replace(/%2C/gi, ',');
      if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    } catch {
      /* not essential */
    }
  }

  /** Turn the live area on screen into the surge scenario. Returns a sentence for the notice, or null when it failed. */
  async function install(centre: { lat: number; lon: number }): Promise<{ ok: boolean; message: string }> {
    const tbl = await ensureTable();
    if (!tbl) return { ok: false, message: 'The NOAA tide-station table could not be loaded.' };
    const near = nearestStation(tbl, centre.lat, centre.lon);
    if (!near) return { ok: false, message: `No NOAA long-term tide station with an extreme-water-level analysis is within ${SURGE_LIMITS.maxDistanceKm} km: this is not on the U.S. coast, or not near a gauge NOAA has analysed.` };
    const t = bridge.scene?.getTerrain() ?? null;
    const base = store.get().scenario;
    if (!t || !base) return { ok: false, message: 'Load a scene first.' };
    // Re-installing on a coastal scenario starts from the area's own scenario sources, not the sea ones.
    const res = coastalSetup({ elevation: t.elevation, nx: t.nx, ny: t.ny, cellSize: t.cellSize }, { ...base, description: withoutSurgeText(base), coastal: undefined }, near.station, near.km);
    if ('error' in res) return { ok: false, message: res.error };
    store.set({ scenario: res.scenario });
    ctx.actions.restoreScenario();
    ctx.actions.resetWater();
    const l100 = res.spec.levels[res.spec.levels.length - 1];
    return {
      ok: true,
      message: `Nearest ${gaugeNote(res.spec)} Its 1 %-annual-chance still-water level is ${fmtNum(l100.elevation, 2)} m ${res.spec.datum} (${fmtNum(l100.aboveMhhw, 2)} m above MHHW); the sea boundary covers ${res.spec.seaRuns} seaward edge run${res.spec.seaRuns === 1 ? '' : 's'}.`,
    };
  }

  async function checkSurge(at: { lat: number; lon: number }, label: string | null): Promise<void> {
    if (busy) return;
    busy = true;
    ctx.setPanel('useCases', false);
    const def = useCaseById('surge');
    try {
      // The gauge first: no point loading 8 km of terrain inland.
      const tbl = await ensureTable();
      if (!tbl) {
        postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'The NOAA tide-station table could not be loaded, so there is no surge ladder. Reload the page to try again.' });
        return;
      }
      if (!nearestStation(tbl, at.lat, at.lon)) {
        postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: `No NOAA tide station with an extreme-water-level analysis within ${SURGE_LIMITS.maxDistanceKm} km of this point: pick a place on the U.S. coast.` });
        return;
      }
      if (!onSurgeArea(at)) {
        let outcome: unknown;
        try {
          outcome = await ctx.actions.loadLiveArea(surgeAreaRequest(at));
        } catch {
          outcome = 'failed';
        }
        if (outcome === 'superseded') return;
        if (outcome === 'failed' || !onSurgeArea(at)) {
          postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'The area around this place could not be loaded (it needs USGS 3DEP elevation over the internet). Try again, or open Fort Myers (Hurricane Ian) offline.' });
          return;
        }
      }
      const r = await install(at);
      if (!r.ok) {
        postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: r.message, durationMs: 20000 });
        return;
      }
      writeLink(at);
      const registry = sitesFor(store);
      let site = registry.sites.find((s) => Math.abs(s.lat - at.lat) < 1e-6 && Math.abs(s.lon - at.lon) < 1e-6) ?? null;
      if (site) registry.select(site.id);
      else {
        site = registry.add(at.lon, at.lat);
        if (site) registry.update(site.id, { name: cleanPlaceLabel(label ?? '') || 'The coastal site' });
      }
      deps.panel.reveal('site');
      const ok = deps.panel.siteCheck.useSurgeLadder();
      flyTo(at.lon, at.lat);
      postNotice(store, {
        kind: 'info',
        key: 'usecase',
        title: def.title,
        message: `${r.message} ${def.howTo}`,
        durationMs: 30000,
        ...(ok && site ? { action: { label: 'Run the sweep', run: () => void deps.panel.siteCheck.runSweep() } } : {}),
      });
    } finally {
      busy = false;
    }
  }

  async function useThisMap(): Promise<void> {
    const s = store.get();
    const t = bridge.scene?.getTerrain() ?? null;
    if (!t || s.loading) return setText(status, 'Load a scene first.');
    if (s.presetId !== null) {
      return setText(status, s.presetId === 'ftmyers' ? 'Fort Myers already holds the sea at its own NOAA gauge, with a researched ladder in Site check.' : 'Built-in scenarios keep their own boundaries: use a live area (Pick any US location) on the coast, or search for a place above.');
    }
    if (busy) return;
    busy = true;
    try {
      const c = { lat: (t.bounds.north + t.bounds.south) / 2, lon: (t.bounds.east + t.bounds.west) / 2 };
      const r = await install(c);
      setText(status, r.message);
      if (!r.ok) return;
      writeLink(null);
      ctx.setPanel('useCases', false);
      deps.panel.reveal('site');
      deps.panel.siteCheck.useSurgeLadder();
      postNotice(store, { kind: 'info', key: 'usecase', title: useCaseById('surge').title, message: `${r.message} Press S and click the map to add a site, then Run sweep.`, durationMs: 25000 });
    } finally {
      busy = false;
    }
  }

  function flyTo(lon: number, lat: number): void {
    const terrain = bridge.scene?.getTerrain() ?? null;
    const camera = bridge.scene?.getCamera?.() ?? null;
    if (!terrain || !camera) return;
    const [gx, gy] = makeGeoToGrid(terrain)(lon, lat);
    if (!(gx >= 0 && gy >= 0 && gx < terrain.nx && gy < terrain.ny)) return;
    try {
      camera.flyTo({ target: { gx, gy, elevation: terrain.elevation[Math.floor(gy) * terrain.nx + Math.floor(gx)] }, distance: 1800, yaw: camera.pose.yaw, pitch: 0.85 }, 1.4);
    } catch {
      /* renderer gone */
    }
  }

  async function apply(): Promise<void> {
    const at = parseAddressAt(typeof location === 'undefined' ? '' : location.search).at;
    if (at) return checkSurge(at, null);
    deps.show();
    ctx.setPanel('useCases', true);
  }

  return {
    el,
    focus() {
      void ensureTable();
      requestAnimationFrame(() => input.focus());
    },
    apply,
  };
}
