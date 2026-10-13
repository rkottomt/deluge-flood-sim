/**
 * "Dam-breach inundation" — a view of the Use cases dialog (src/ui/useCases.ts): find a dam in the National Inventory
 * of Dams (by name or NID id, or near the map on screen), pick a breach scenario, and Deluge loads the valley below it
 * as a live area and sends the breach hydrograph in at the dam's toe (src/dams). Afterwards the same view reads the
 * arrival time and peak depth along the flow path from the solver's hazard fields.
 *
 * Data: the baked index public/dams/nid-index.bin (same origin, strict decoder, src/dams/nidIndex.ts); terrain: the
 * same USGS 3DEP / Esri / TIGERweb live-area loaders as "Pick any US location" — plus ONE small 3DEP elevation probe
 * (64 × 64 cells) around the dam first, to find which way the valley falls so the area can be centred below the dam.
 * No new endpoint: both requests go to hosts the CSP already allows.
 *
 * SECURITY. Every string shown comes from the baked index through cleanDamName or from constant text, set with h()
 * (textContent). The link carries `nid=` (a strict id pattern), `breach=` and `method=` (fixed words) — never a name.
 */
import type { TerrainData } from '../contracts';
import { fetchDEM } from '../data/dem';
import { makeGeoToGrid, squareDomain } from '../data/geo';
import { BREACH_METHODS, BREACH_MODES, damScenario, type BreachMethod, type BreachMode, type DamScenario } from '../dams/breachModel';
import { damById, loadNidIndex, searchDams, type NidDam, type NidIndex } from '../dams/nidIndex';
import { areaCentreForDam, downstreamBearing, readDownstream, type DownstreamReading } from '../dams/placement';
import { damBreachScenario, type DamBreachSpec } from '../dams/scenario';
import { bridgeFor, postNotice } from './bridge';
import { h, setText, type UIContext } from './dom';
import { fmtNum } from './format';
import { icon } from './icons';
import type { Panel } from './panel';
import { BREACH_PARAM, DAM_AREA_CHOICES_M, DAM_AREA_M, DAM_PARAM, METHOD_PARAM, parseDamLink, USE_CASE_PARAM, useCaseById } from './useCaseDefs';
import './damSurge.css';

/** Grid of the coarse elevation probe around the dam. */
const PROBE_N = 64;
/** "Dams near this map": search radius, km. */
const NEAR_KM = 60;
/** Simulated seconds per real second while the wave runs. */
const DAM_TIME_SCALE = 180;

export interface DamView {
  el: HTMLElement;
  /** Show the view (the caller opens the dialog). */
  focus(): void;
  /** A `?usecase=dam` link: breach the dam it names, or show the search. */
  apply(): Promise<void>;
}

const fmtInt = (v: number) => Math.round(v).toLocaleString('en-US');
const fmtQ = (q: number) => `${fmtInt(q >= 1000 ? Math.round(q / 10) * 10 : q)} m³/s`;
const fmtMin = (s: number) => (s < 90 * 60 ? `${fmtNum(s / 60, 0)} min` : `${fmtNum(s / 3600, 1)} h`);

function damLine(d: NidDam): string {
  return `${d.id}${d.state ? ` · ${d.state}` : ''} · ${fmtNum(d.heightM, 0)} m · ${fmtInt(d.storageAcFt)} acre-ft · ${d.hazard} hazard`;
}

export function createDamView(ctx: UIContext, deps: { panel: Pick<Panel, 'reveal'>; show(): void }): DamView {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  const link = parseDamLink(typeof location === 'undefined' ? '' : location.search);
  let index: NidIndex | null = null;
  let selected: NidDam | null = null;
  let mode: BreachMode = link.breach;
  let method: BreachMethod = link.method;
  let sizeM = DAM_AREA_M;
  let busy = false;

  // ─── Search ───────────────────────────────────────────────────────────────────────────────────────────────
  const input = h('input', {
    type: 'search',
    class: 'dl-uc-addr-input',
    placeholder: 'Dam name or NID id, e.g. Oroville or CA00035',
    'aria-label': 'Dam name or NID id',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 80,
    'data-dam': 'input',
  });
  const findBtn = h('button', { type: 'submit', class: 'dl-btn dl-btn-primary dl-btn-sm', 'data-dam': 'search' }, icon('search', 14), h('span', null, 'Find'));
  const nearBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', 'data-dam': 'near', onclick: () => void findNear() }, icon('location', 14), h('span', null, 'Dams near this map'));
  const form = h('form', { class: 'dl-uc-addr-form', role: 'search' }, input, findBtn);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void find();
  });
  const status = h('p', { class: 'dl-uc-addr-status', 'aria-live': 'polite', 'data-dam': 'status' });
  const results = h('div', { class: 'dl-uc-addr-results dl-dam-results', role: 'listbox', 'data-dam': 'results' });
  const detail = h('div', { class: 'dl-dam-detail', 'data-dam': 'detail', hidden: true });
  const readout = h('div', { class: 'dl-dam-readout', 'data-dam': 'readout', hidden: true });

  const el = h(
    'div',
    { class: 'dl-uc-view dl-dam', 'data-uc-view': 'dam', hidden: true },
    h(
      'p',
      { class: 'dl-uc-lede' },
      'Every U.S. dam in the National Inventory of Dams that holds at least 1,000 acre-ft, or stands 6 m high over at least 50 acre-ft — about 55,000 of them, from a copy served with the app. Pick one: Deluge loads the valley below it (USGS 3DEP elevation, imagery and roads — this needs internet), breaches it and runs the wave down the valley.',
    ),
    h('div', { class: 'dl-row dl-dam-search' }, form, nearBtn),
    status,
    results,
    detail,
    readout,
  );

  async function ensureIndex(): Promise<NidIndex | null> {
    if (index) return index;
    setText(status, 'Loading the dam index…');
    try {
      index = await loadNidIndex();
      setText(status, '');
      return index;
    } catch (err) {
      console.warn('[dams] index unavailable:', err);
      setText(status, 'The dam index could not be loaded. Reload the page to try again.');
      return null;
    }
  }

  async function find(): Promise<void> {
    const q = input.value.trim().slice(0, 80);
    if (!q) return setText(status, 'Type part of a dam’s name or its NID id.');
    const idx = await ensureIndex();
    if (!idx) return;
    const t = bridge.scene?.getTerrain() ?? null;
    const near = t ? { lat: (t.bounds.north + t.bounds.south) / 2, lon: (t.bounds.east + t.bounds.west) / 2, radiusKm: 20000 } : undefined;
    showResults(searchDams(idx, { text: q, limit: 30, near }), `No dam in the index matches “${q.slice(0, 40)}”.`);
  }

  async function findNear(): Promise<void> {
    const idx = await ensureIndex();
    if (!idx) return;
    const t = bridge.scene?.getTerrain() ?? null;
    if (!t) return setText(status, 'Load a scene first.');
    const c = { lat: (t.bounds.north + t.bounds.south) / 2, lon: (t.bounds.east + t.bounds.west) / 2 };
    showResults(searchDams(idx, { near: { ...c, radiusKm: NEAR_KM }, limit: 30 }), `No dam in the index within ${NEAR_KM} km of this map (the index is U.S. only).`);
  }

  function showResults(list: Array<{ dam: NidDam; km: number | null }>, none: string): void {
    results.replaceChildren();
    if (!list.length) return setText(status, none);
    setText(status, list.length === 1 ? 'One dam:' : `${list.length} dams${list.length === 30 ? ' (the first 30)' : ''}:`);
    results.replaceChildren(
      ...list.map(({ dam, km }) =>
        h(
          'button',
          { type: 'button', class: 'dl-search-result', role: 'option', 'data-dam': 'result', 'data-nid': dam.id, onclick: () => pick(dam) },
          icon('wall', 15),
          h('span', { class: 'dl-result-text' }, h('b', null, dam.name), h('span', null, `${damLine(dam)}${km !== null && km < 20000 ? ` · ${fmtNum(km, km < 10 ? 1 : 0)} km away` : ''}`)),
        ),
      ),
    );
  }

  // ─── One dam ──────────────────────────────────────────────────────────────────────────────────────────────
  function pick(dam: NidDam): void {
    selected = dam;
    renderDetail();
    detail.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }

  function radio<T extends string>(name: string, value: T, current: T, label: string, set: (v: T) => void): HTMLElement {
    const r = h('input', { type: 'radio', name, value, checked: value === current, 'data-dam': `${name}-${value}` });
    r.addEventListener('change', () => {
      if (r.checked) {
        set(value);
        renderDetail();
      }
    });
    return h('label', { class: 'dl-dam-choice' }, r, h('span', null, label));
  }

  function renderDetail(): void {
    const d = selected;
    detail.hidden = !d;
    if (!d) return;
    const s = damScenario(d, mode, method);
    const r = s.result;
    const sizeSel = h('select', { class: 'dl-select', 'aria-label': 'Area size', 'data-dam': 'size' }, ...DAM_AREA_CHOICES_M.map((m) => h('option', { value: String(m), selected: m === sizeM }, `${m / 1000} km`)));
    sizeSel.addEventListener('change', () => (sizeM = Number(sizeSel.value) || DAM_AREA_M));
    const go = h('button', { type: 'button', class: 'dl-btn dl-btn-primary', 'data-dam': 'breach', onclick: () => void breach(d, mode, method, sizeM) }, icon('play', 14), h('span', null, 'Load the valley and breach'));
    const rows: Array<[string, string]> = [
      ['Released volume', `${fmtNum(s.volumeM3 / 1e6, 1)} million m³ (${fmtInt(s.volumeM3 / 1233.48)} acre-ft)`],
      ['Head at failure', `${fmtNum(s.headM, 1)} m above the streambed`],
      ['Breach width (Froehlich 2008)', `${fmtNum(r.avgWidthM, 0)} m average, ${fmtNum(r.bottomWidthM, 0)} m at the bottom`],
      ['Breach formation time', fmtMin(r.formationTimeS)],
      [`Peak outflow — ${method === 'parametric' ? 'modelled' : 'Froehlich 2016'}`, `${fmtQ(r.peak)} at ${fmtMin(r.tPeak)}`],
      ...r.relations.map((x): [string, string] => [`Peak — ${x.label}`, fmtQ(x.peak)]),
      ...(r.input.baseFlow > 0 ? [['River flood under it', fmtQ(r.input.baseFlow)] as [string, string]] : []),
    ];
    detail.replaceChildren(
      h('h3', { class: 'dl-dam-name' }, d.name),
      h('p', { class: 'dl-uc-addr-status' }, `${damLine(d)} · ${d.damType}${d.year ? `, ${d.year}` : ''} · owner: ${d.owner}`),
      h('div', { class: 'dl-dam-choices', role: 'radiogroup', 'aria-label': 'Breach scenario' }, radio('dam-mode', 'sunny', mode, BREACH_MODES.sunny.label, (v) => (mode = v)), radio('dam-mode', 'flood', mode, BREACH_MODES.flood.label, (v) => (mode = v))),
      h('div', { class: 'dl-dam-choices', role: 'radiogroup', 'aria-label': 'Hydrograph method' }, radio('dam-method', 'parametric', method, BREACH_METHODS.parametric, (v) => (method = v)), radio('dam-method', 'regression', method, BREACH_METHODS.regression, (v) => (method = v))),
      h('table', { class: 'dl-site-table dl-dam-table', 'data-dam': 'params' }, h('tbody', null, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
      s.assumptions.length ? h('ul', { class: 'dl-impact-issues', 'data-dam': 'assumptions' }, ...s.assumptions.map((a) => h('li', null, a))) : h('span'),
      h('details', { class: 'dl-impact-methods', 'data-dam': 'caveats' }, h('summary', null, 'What this leaves out'), h('ul', { class: 'dl-impact-issues' }, ...s.caveats.map((c) => h('li', null, c)))),
      h('div', { class: 'dl-row dl-dam-go' }, h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Area'), sizeSel), go),
    );
  }

  // ─── Load and breach ──────────────────────────────────────────────────────────────────────────────────────
  /** The dam's grid position on the map on screen, or null when it is not on it. */
  function damOnMap(t: TerrainData | null, dam: NidDam): { gx: number; gy: number } | null {
    if (!t) return null;
    const [gx, gy] = makeGeoToGrid(t)(dam.lon, dam.lat);
    const m = 4;
    return gx >= m && gy >= m && gx < t.nx - m && gy < t.ny - m ? { gx, gy } : null;
  }

  function writeLink(dam: NidDam): void {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(USE_CASE_PARAM, 'dam');
      url.searchParams.set(DAM_PARAM, dam.id);
      url.searchParams.set(BREACH_PARAM, mode);
      if (method !== 'parametric') url.searchParams.set(METHOD_PARAM, method);
      else url.searchParams.delete(METHOD_PARAM);
      url.search = url.search.replace(/%2C/gi, ',');
      if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    } catch {
      /* sandboxed: not essential */
    }
  }

  async function breach(dam: NidDam, m: BreachMode, meth: BreachMethod, size: number): Promise<void> {
    if (busy) return;
    busy = true;
    mode = m;
    method = meth;
    ctx.setPanel('useCases', false);
    const def = useCaseById('dam');
    try {
      const s0 = store.get();
      const t0 = bridge.scene?.getTerrain() ?? null;
      const onMap = s0.presetId === null && !s0.loading ? damOnMap(t0, dam) : null;
      if (!onMap) {
        postNotice(store, { kind: 'info', key: 'usecase', title: def.title, message: `Finding the valley below ${dam.name}…`, durationMs: 8000 });
        let bearing: number | null = null;
        try {
          const { merc } = squareDomain({ lat: dam.lat, lon: dam.lon }, size);
          const probe = await fetchDEM(merc, PROBE_N, PROBE_N, size / PROBE_N);
          bearing = downstreamBearing(probe.elevation, PROBE_N, size / PROBE_N, { gx: PROBE_N / 2, gy: PROBE_N / 2 }, dam.heightM);
        } catch (err) {
          console.warn('[dams] elevation probe failed; centring the area on the dam:', err);
        }
        const center = areaCentreForDam(dam, bearing, size);
        let outcome: unknown;
        try {
          outcome = await ctx.actions.loadLiveArea({ center, sizeMeters: size, resolution: 1024 });
        } catch {
          outcome = 'failed';
        }
        if (outcome === 'superseded') return;
        if (outcome === 'failed' || !damOnMap(bridge.scene?.getTerrain() ?? null, dam)) {
          postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'The valley below this dam could not be loaded (it needs USGS 3DEP elevation over the internet). Try again, or open a built-in scenario.' });
          return;
        }
      }
      install(dam, damScenario(dam, mode, method));
    } finally {
      busy = false;
    }
  }

  let last: { spec: DamBreachSpec; terrain: TerrainData } | null = null;

  function install(dam: NidDam, s: DamScenario): void {
    const def = useCaseById('dam');
    const t = bridge.scene?.getTerrain() ?? null;
    const at = damOnMap(t, dam);
    const base = store.get().scenario;
    if (!t || !at || !base) return;
    // A previous breach on this map is replaced, not stacked.
    const clean = { ...base, sources: base.sources.filter((x) => x.id !== 'dam-breach'), damBreach: undefined };
    const out = damBreachScenario({ elevation: t.elevation, nx: t.nx, ny: t.ny, cellSize: t.cellSize }, clean, at, s);
    if (!out) {
      postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'The dam is not on the loaded map.' });
      return;
    }
    store.set({ scenario: out.scenario });
    ctx.actions.restoreScenario();
    ctx.actions.resetWater();
    ctx.setRender({ waterMode: 'arrival' });
    const sim = store.get().sim;
    store.set({ paused: false, sim: { ...sim, timeScale: Math.max(sim.timeScale, DAM_TIME_SCALE) } });
    last = { spec: out.spec, terrain: t };
    writeLink(dam);
    renderReadout(null);
    const camera = bridge.scene?.getCamera?.() ?? null;
    try {
      camera?.flyTo({ target: { gx: out.spec.inflow.gx, gy: out.spec.inflow.gy, elevation: out.spec.inflow.elevation }, distance: Math.min(6000, 0.45 * t.nx * t.cellSize), yaw: camera.pose.yaw, pitch: 0.8 }, 1.6);
    } catch {
      /* renderer gone */
    }
    postNotice(store, {
      kind: 'info',
      key: 'usecase',
      title: `${dam.name}: ${BREACH_MODES[s.mode].short.toLowerCase()} breach`,
      message: `Peak outflow ${fmtQ(out.spec.peak)} at ${fmtMin(out.spec.tPeak)}, ${fmtNum(out.spec.volume / 1e6, 1)} million m³. ${def.howTo}`,
      durationMs: 30000,
      action: { label: 'Read arrivals', run: () => void openReadout() },
    });
  }

  // ─── Arrival readout ──────────────────────────────────────────────────────────────────────────────────────
  async function openReadout(): Promise<void> {
    deps.show();
    ctx.setPanel('useCases', true);
    await readArrivals();
  }

  async function readArrivals(): Promise<DownstreamReading[] | null> {
    const t = bridge.scene?.getTerrain() ?? null;
    const solver = bridge.scene?.getSolver() ?? null;
    const spec = store.get().scenario?.damBreach ?? null;
    if (!spec || !t || !solver || last?.terrain !== t) {
      renderReadout(null, 'Breach a dam first: the readout follows the flow path below it.');
      return null;
    }
    if (typeof solver.readHazardFields !== 'function') {
      renderReadout(null, 'This solver keeps no arrival times; use the Arrival view on the map.');
      return null;
    }
    const fields = await solver.readHazardFields();
    const rows = readDownstream(fields, spec.path);
    renderReadout(rows, null, fields.simTime);
    return rows;
  }

  function renderReadout(rows: DownstreamReading[] | null, note: string | null = null, simTime = 0): void {
    const spec = store.get().scenario?.damBreach ?? null;
    readout.hidden = !spec && !note;
    if (readout.hidden) return;
    const btn = h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', 'data-dam': 'read', onclick: () => void readArrivals() }, icon('clock', 14), h('span', null, 'Read arrivals'));
    const head = h('div', { class: 'dl-row' }, h('h3', { class: 'dl-dam-name' }, spec ? `Below ${spec.name}` : 'Downstream readout'), btn);
    if (!rows) {
      readout.replaceChildren(head, h('p', { class: 'dl-uc-addr-status' }, note ?? 'Arrival time and peak depth along the flow path below the dam, from the run so far. Press Read arrivals once the wave has had time to travel.'));
      return;
    }
    const body = rows.length
      ? h(
          'table',
          { class: 'dl-site-table dl-dam-table', 'data-dam': 'arrivals' },
          h('thead', null, h('tr', null, h('th', null, 'Downstream'), h('th', null, 'Wave arrives'), h('th', null, 'Peak depth'), h('th', null, 'Peak speed'))),
          h(
            'tbody',
            null,
            ...rows.map((r) =>
              h('tr', null, h('td', null, `${fmtNum(r.distanceM / 1000, 1)} km`), h('td', null, r.arrivalS === null ? 'not yet' : fmtMin(r.arrivalS)), h('td', null, `${fmtNum(r.maxDepth, 1)} m`), h('td', null, `${fmtNum(r.maxSpeed, 1)} m/s`)),
            ),
          ),
        )
      : h('p', { class: 'dl-uc-addr-status' }, 'The flow path below the dam is too short on this map for a readout.');
    readout.replaceChildren(
      head,
      body,
      h('p', { class: 'dl-impact-fine' }, `After ${fmtMin(simTime)} of simulated time since the breach started. Arrival: the first time water stood 0.15 m deep within ~6 cells of the flow path, on ground that was dry at the start. Peak depth is the deepest water near the path, the river channel included. Distances follow the steepest-descent path on the elevation model from the dam’s toe.`),
    );
  }

  // ─── Link ─────────────────────────────────────────────────────────────────────────────────────────────────
  async function apply(): Promise<void> {
    for (const w of link.warnings) postNotice(store, { kind: 'warn', key: 'dam-link', title: 'Dam link', message: w });
    if (!link.nid) {
      deps.show();
      ctx.setPanel('useCases', true);
      return;
    }
    const idx = await ensureIndex();
    const dam = idx ? damById(idx, link.nid) : null;
    if (!dam) {
      postNotice(store, { kind: 'warn', key: 'dam-link', title: 'Dam link', message: 'That NID id is not in the dam index (it covers dams of at least 1,000 acre-ft, or 6 m high over 50 acre-ft).' });
      deps.show();
      ctx.setPanel('useCases', true);
      return;
    }
    selected = dam;
    renderDetail();
    await breach(dam, link.breach, link.method, sizeM);
  }

  return {
    el,
    focus() {
      void ensureIndex();
      renderReadout(null);
      requestAnimationFrame(() => input.focus());
    },
    apply,
  };
}
