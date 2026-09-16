/**
 * Location picker: Leaflet map (Esri World Imagery + reference labels), Nominatim search, quick picks,
 * a ground-true square footprint preview, size & resolution selectors, and Load → actions.loadLiveArea.
 * Leaflet is only initialised the first time the dialog opens.
 */
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LiveAreaRequest } from '../contracts';
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon } from './icons';
import { segmented } from './controls';
import { createModal, type Modal } from './modal';
import { squareFootprint, isLikelyUSCoverage } from './geo';
import { formatLatLon, fmtNum } from './format';

const IMAGERY_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
const NOMINATIM = 'https://nominatim.openstreetmap.org';

export const QUICK_PICKS: Array<{ name: string; lat: number; lon: number; note: string }> = [
  { name: 'New Orleans', lat: 29.9511, lon: -90.0715, note: 'Below sea level' },
  { name: 'Houston', lat: 29.7604, lon: -95.3698, note: 'Bayous, Harvey 2017' },
  { name: 'Miami', lat: 25.7617, lon: -80.1918, note: 'Low coastal city' },
  { name: 'Boulder', lat: 40.015, lon: -105.2705, note: 'Canyon flash floods' },
  { name: 'Asheville NC', lat: 35.5951, lon: -82.5515, note: 'Mountain river valley' },
  { name: 'Sacramento', lat: 38.5816, lon: -121.4944, note: 'River confluence' },
];

const SIZES = [2000, 5000, 8000, 12000] as const;
const RESOLUTIONS = [512, 1024, 2048] as const;

interface GeoResult {
  display_name: string;
  lat: string;
  lon: string;
  type?: string;
  class?: string;
}

export function createLocationPicker(ctx: UIContext): Modal {
  const { store, actions, bind } = ctx;

  let center: { lat: number; lon: number } | null = null;
  let placeName = '';
  let size: number = 8000;
  let resolution: LiveAreaRequest['resolution'] = 1024;
  let loadingHere = false;

  let map: L.Map | null = null;
  let rect: L.Rectangle | null = null;
  let marker: L.Marker | null = null;

  // ── Map ──
  const mapEl = h('div', { class: 'dl-picker-map' });
  const mapHint = h('div', { class: 'dl-picker-hint' }, icon('location', 16), h('span', null, 'Click anywhere in the US to center your area'));
  const mapWrap = h('div', { class: 'dl-picker-map-wrap' }, mapEl, mapHint);

  // ── Search ──
  const searchInput = h('input', {
    type: 'search',
    class: 'dl-search-input',
    placeholder: 'Search a US city, town or address…',
    'aria-label': 'Search for a place',
    autocomplete: 'off',
    spellcheck: 'false',
  });
  const searchBtn = h('button', { type: 'submit', class: 'dl-btn dl-btn-subtle dl-search-btn', 'aria-label': 'Search' }, icon('search', 16));
  const results = h('div', { class: 'dl-search-results', role: 'listbox', hidden: true });
  const searchForm = h('form', { class: 'dl-search', role: 'search' }, h('span', { class: 'dl-search-icon' }, icon('search', 16)), searchInput, searchBtn, results);

  let searchAbort: AbortController | null = null;
  let lastSearchAt = 0;
  searchForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = searchInput.value.trim();
    if (!q) return;
    // Nominatim usage policy: ≤ 1 request/second.
    const wait = Math.max(0, 1000 - (performance.now() - lastSearchAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    lastSearchAt = performance.now();
    searchAbort?.abort();
    searchAbort = new AbortController();
    results.hidden = false;
    results.replaceChildren(h('div', { class: 'dl-search-status' }, h('span', { class: 'dl-spinner dl-spin-on' }), 'Searching…'));
    try {
      const url = `${NOMINATIM}/search?q=${encodeURIComponent(q)}&format=json&limit=5&countrycodes=us&addressdetails=0`;
      const res = await fetch(url, { signal: searchAbort.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const list = (await res.json()) as GeoResult[];
      showResults(list);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      results.replaceChildren(h('div', { class: 'dl-search-status dl-search-error' }, icon('warning', 14), 'Search is unavailable right now — click the map instead.'));
    }
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !results.hidden) {
      e.preventDefault();
      e.stopPropagation();
      results.hidden = true;
    } else if (e.key === 'ArrowDown' && !results.hidden) {
      e.preventDefault();
      results.querySelector<HTMLButtonElement>('button')?.focus();
    }
  });
  results.addEventListener('keydown', (e) => {
    const items = Array.from(results.querySelectorAll<HTMLButtonElement>('button'));
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' && i >= 0) {
      e.preventDefault();
      items[Math.min(items.length - 1, i + 1)].focus();
    } else if (e.key === 'ArrowUp' && i >= 0) {
      e.preventDefault();
      (i === 0 ? searchInput : items[i - 1]).focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      results.hidden = true;
      searchInput.focus();
    }
  });

  function showResults(list: GeoResult[]) {
    if (!list.length) {
      results.replaceChildren(h('div', { class: 'dl-search-status' }, 'No US places found. Try a city and state, e.g. “Nashville, TN”.'));
      return;
    }
    results.replaceChildren(
      ...list.map((r) => {
        const [first, ...rest] = r.display_name.split(', ');
        return h(
          'button',
          {
            type: 'button',
            class: 'dl-search-result',
            role: 'option',
            onclick: () => {
              results.hidden = true;
              searchInput.value = first;
              setCenter(parseFloat(r.lat), parseFloat(r.lon), first, true);
            },
          },
          icon('pin', 15),
          h('span', { class: 'dl-result-text' }, h('b', null, first), h('span', null, rest.slice(0, 3).join(', '))),
        );
      }),
    );
  }
  document.addEventListener('pointerdown', (e) => {
    if (!results.hidden && e.target instanceof Node && !searchForm.contains(e.target)) results.hidden = true;
  });

  // ── Quick picks ──
  const quick = h(
    'div',
    { class: 'dl-quick' },
    ...QUICK_PICKS.map((p) =>
      h(
        'button',
        { type: 'button', class: 'dl-quick-btn', 'data-tip': p.note, 'data-tip-side': 'top', onclick: () => setCenter(p.lat, p.lon, p.name, true) },
        h('span', null, p.name),
      ),
    ),
  );

  // ── Size & resolution ──
  const sizeSeg = segmented<number>(
    SIZES.map((s) => ({ value: s, label: `${s / 1000} km` })),
    (v) => {
      size = v;
      sizeSeg.set(v);
      updateFootprint(true);
      updateSummary();
    },
    { label: 'Area size', className: 'dl-seg-full' },
  );
  sizeSeg.set(size);

  const resSeg = segmented<number>(
    RESOLUTIONS.map((r) => ({ value: r, label: `${r}²` })),
    (v) => {
      resolution = v as LiveAreaRequest['resolution'];
      resSeg.set(v);
      updateSummary();
    },
    { label: 'Grid resolution', className: 'dl-seg-full' },
  );
  resSeg.set(resolution);
  const resHint = h('div', { class: 'dl-res-hint' });

  // ── Summary / load ──
  const sumName = h('div', { class: 'dl-sum-name' });
  const sumCoords = h('div', { class: 'dl-sum-coords' });
  const sumGrid = h('div', { class: 'dl-sum-grid' });
  const coverageWarn = h('div', { class: 'dl-coverage-warn', hidden: true }, icon('warning', 14), h('span', null, 'Outside USGS 3DEP coverage — elevation may be unavailable.'));
  const summary = h('div', { class: 'dl-picker-summary' }, h('span', { class: 'dl-sum-icon' }, icon('pin', 18)), h('div', { class: 'dl-sum-text' }, sumName, sumCoords, sumGrid));

  const loadFill = h('span', { class: 'dl-load-fill' });
  const loadText = h('span', { class: 'dl-load-text' }, 'Load this area');
  const loadBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-primary dl-load-btn' }, loadFill, icon('arrowRight', 16), loadText);
  const loadError = h('div', { class: 'dl-load-error', hidden: true });

  loadBtn.addEventListener('click', async () => {
    if (!center || loadingHere || store.get().loading) return;
    loadingHere = true;
    loadError.hidden = true;
    syncLoad();
    const req: LiveAreaRequest = {
      center: { lat: center.lat, lon: center.lon },
      sizeMeters: size,
      resolution,
      name: placeName || `${center.lat.toFixed(3)}, ${center.lon.toFixed(3)}`,
    };
    try {
      await actions.loadLiveArea(req);
      loadingHere = false;
      syncLoad();
      ctx.setPanel('locationPicker', false);
    } catch (err) {
      loadingHere = false;
      syncLoad();
      loadError.hidden = false;
      setText(loadError, `Couldn’t load this area: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  function syncLoad() {
    const s = store.get();
    const busy = loadingHere && !!s.loading;
    toggleClass(loadBtn, 'dl-busy', loadingHere);
    loadBtn.disabled = !center || (!!s.loading && !loadingHere);
    const p = s.loading ? Math.max(0, Math.min(1, s.loading.progress)) : 0;
    loadFill.style.setProperty('--p', String(busy ? p : 0));
    setText(loadText, loadingHere ? (s.loading ? `${s.loading.message || 'Loading'} · ${Math.round(p * 100)}%` : 'Starting…') : center ? 'Load this area' : 'Pick a location first');
    for (const el of [searchInput, searchBtn] as Array<HTMLInputElement | HTMLButtonElement>) el.disabled = loadingHere;
  }
  bind((s) => (s.loading ? `${s.loading.message}|${s.loading.progress.toFixed(3)}` : ''), () => syncLoad());

  const usNote = h(
    'div',
    { class: 'dl-us-note' },
    icon('layers', 15),
    h('span', null, h('b', null, 'US only.'), ' Elevation comes from USGS 3DEP (1 m lidar where available, otherwise ~10 m). Imagery © Esri; roads from US Census TIGER.'),
  );

  const side = h(
    'aside',
    { class: 'dl-picker-side' },
    searchForm,
    h('div', { class: 'dl-label' }, 'Quick picks'),
    quick,
    h('div', { class: 'dl-label' }, 'Area size'),
    sizeSeg.el,
    h('div', { class: 'dl-label' }, 'Grid resolution'),
    resSeg.el,
    resHint,
    h('div', { class: 'dl-picker-spacer' }),
    summary,
    coverageWarn,
    usNote,
    loadError,
    loadBtn,
  );

  // ── Behaviour ──
  function updateSummary() {
    const cell = size / resolution;
    const km = size / 1000;
    setText(
      resHint,
      resolution === 512
        ? `Fastest — ${fmtNum(cell, 1)} m cells. Smooth on any laptop GPU.`
        : resolution === 1024
          ? `Recommended — ${fmtNum(cell, 1)} m cells, about 1 million.`
          : `Finest — ${fmtNum(cell, 1)} m cells, 4 million. Needs a strong GPU.`,
    );
    if (cell < 1) resHint.append(h('span', { class: 'dl-res-warn' }, ' Finer than the source lidar (1 m).'));
    else if (cell > 12) resHint.append(h('span', { class: 'dl-res-warn' }, ' Coarse: small streets may vanish.'));
    if (!center) {
      setText(sumName, 'No location selected');
      setText(sumCoords, 'Search, pick a city, or click the map');
      setText(sumGrid, `${km} × ${km} km · ${resolution} × ${resolution} cells`);
    } else {
      setText(sumName, placeName || 'Selected area');
      setText(sumCoords, formatLatLon(center.lat, center.lon, 4));
      setText(sumGrid, `${km} × ${km} km · ${resolution} × ${resolution} cells · ${fmtNum(cell, cell < 10 ? 1 : 0)} m`);
    }
    coverageWarn.hidden = !center || isLikelyUSCoverage(center.lat, center.lon);
    toggleClass(summary, 'dl-empty', !center);
    syncLoad();
  }

  let reverseTimer = 0;
  let reverseAbort: AbortController | null = null;
  function reverseGeocode(lat: number, lon: number) {
    clearTimeout(reverseTimer);
    reverseAbort?.abort();
    reverseTimer = window.setTimeout(async () => {
      reverseAbort = new AbortController();
      try {
        const res = await fetch(`${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lon}&zoom=12`, { signal: reverseAbort.signal });
        if (!res.ok) return;
        const j = (await res.json()) as { address?: Record<string, string>; display_name?: string };
        const a = j.address ?? {};
        const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || '';
        const state = a.state ?? '';
        const nm = [locality, state].filter(Boolean).join(', ') || j.display_name?.split(', ')[0] || '';
        if (center && center.lat === lat && center.lon === lon && nm) {
          placeName = nm;
          updateSummary();
        }
      } catch {
        /* offline or rate-limited: keep coordinates as the name */
      }
    }, 900);
  }

  function setCenter(lat: number, lon: number, name: string, fly: boolean) {
    center = { lat, lon };
    placeName = name;
    mapHint.hidden = true;
    if (!name) reverseGeocode(lat, lon);
    updateFootprint(fly);
    updateSummary();
  }

  function updateFootprint(fly: boolean) {
    if (!map || !center) return;
    const b = squareFootprint(center.lat, center.lon, size);
    const bounds = L.latLngBounds([b.south, b.west], [b.north, b.east]);
    if (!rect) {
      rect = L.rectangle(bounds, { color: '#4fb4ff', weight: 2, opacity: 1, fillColor: '#4fb4ff', fillOpacity: 0.14, interactive: false, className: 'dl-picker-rect' }).addTo(map);
    } else rect.setBounds(bounds);
    const ll = L.latLng(center.lat, center.lon);
    if (!marker) {
      marker = L.marker(ll, {
        interactive: false,
        keyboard: false,
        icon: L.divIcon({ className: 'dl-picker-center', html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      }).addTo(map);
    } else marker.setLatLng(ll);
    if (fly) {
      const target = bounds.pad(0.35);
      if (map.getZoom() < 7) map.flyToBounds(target, { duration: 1.1 });
      else map.flyToBounds(target, { duration: 0.6 });
    }
  }

  function initMap() {
    if (map) return;
    map = L.map(mapEl, { center: [39.5, -97.5], zoom: 4, minZoom: 3, maxZoom: 18, worldCopyJump: true, zoomControl: true, attributionControl: true });
    L.tileLayer(IMAGERY_URL, { maxZoom: 18, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }).addTo(map);
    L.tileLayer(LABELS_URL, { maxZoom: 18, maxNativeZoom: 19, opacity: 0.9, pane: 'overlayPane' }).addTo(map);
    map.attributionControl.setPrefix('');
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (loadingHere) return;
      setCenter(e.latlng.lat, L.Util.wrapNum(e.latlng.lng, [-180, 180], true), '', false);
    });
    if (center) updateFootprint(true);
  }

  const modal = createModal({
    id: 'picker',
    title: 'Pick any US location',
    subtitle: 'Deluge fetches live elevation, imagery and roads for a square area and floods it.',
    icon: 'globe',
    className: 'dl-picker',
    onRequestClose: () => ctx.setPanel('locationPicker', false),
    body: [h('div', { class: 'dl-picker-grid' }, mapWrap, side)],
  });

  modal.onOpen(() => {
    initMap();
    // The dialog animates in with a transform; re-measure once it settles.
    requestAnimationFrame(() => map?.invalidateSize());
    setTimeout(() => map?.invalidateSize(), 260);
  });
  bind((s) => s.panels.locationPicker, (open) => modal.setOpen(open));

  updateSummary();

  /** Exposed for the dev harness / automation: select a quick pick by name. */
  (modal as Modal & { selectQuickPick?: (name: string) => void }).selectQuickPick = (name: string) => {
    const p = QUICK_PICKS.find((q) => q.name === name);
    if (p) setCenter(p.lat, p.lon, p.name, true);
  };
  return modal;
}
