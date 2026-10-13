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
import type { RenderSettings, TerrainData } from '../contracts';
import { fetchDEM } from '../data/dem';
import { makeGeoToGrid, squareDomain } from '../data/geo';
import { BREACH_METHOD_IDS, BREACH_METHODS, BREACH_MODES, damScenario, DEFAULT_BREACH_METHOD, DRY_DAM_NOTE, sunnyDayPossible, type BreachMethod, type BreachMode, type DamScenario } from '../dams/breachModel';
import { ARRIVAL_EXPONENT, relationById, scaledArrival } from '../dams/breachRelations';
import { damById, loadNidIndex, searchDams, type NidDam, type NidIndex } from '../dams/nidIndex';
import { areaCentreForDam, downstreamBearing, readDownstream, type DownstreamReading } from '../dams/placement';
import { damBreachScenario, withoutDamText, type DamBreachSpec } from '../dams/scenario';
import { bridgeFor, postNotice } from './bridge';
import { h, setText, type UIContext } from './dom';
import { storyHooksFor } from './storyHooks';
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
/** An arrival range: '12–19 min', or '1.2–1.8 h' when both ends are long. */
function fmtMinRange(a: number, b: number): string {
  if (a >= 90 * 60 && b >= 90 * 60) return `${fmtNum(a / 3600, 1)}–${fmtNum(b / 3600, 1)} h`;
  if (a < 90 * 60 && b < 90 * 60) return `${fmtNum(a / 60, 0)}–${fmtNum(b / 60, 0)} min`;
  return `${fmtMin(a)} – ${fmtMin(b)}`;
}
/** Which hydrograph a method sends to the map, in a few words. */
const METHOD_SHORT: Record<BreachMethod, string> = { central: 'central case', low: 'low case', high: 'high case', parametric: 'Froehlich 2008 breach, routed' };

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

  function radio<T extends string>(name: string, value: T, current: T, label: string, set: (v: T) => void, disabled = false): HTMLElement {
    const r = h('input', { type: 'radio', name, value, checked: value === current, disabled, 'data-dam': `${name}-${value}` });
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
    // The dry-dam note sits under the scenario choice instead.
    const notes = s.assumptions.filter((a) => a !== DRY_DAM_NOTE);
    const sizeSel = h('select', { class: 'dl-select', 'aria-label': 'Area size', 'data-dam': 'size' }, ...DAM_AREA_CHOICES_M.map((m) => h('option', { value: String(m), selected: m === sizeM }, `${m / 1000} km`)));
    sizeSel.addEventListener('change', () => (sizeM = Number(sizeSel.value) || DAM_AREA_M));
    const go = h('button', { type: 'button', class: 'dl-btn dl-btn-primary', 'data-dam': 'breach', onclick: () => void breach(d, mode, method, sizeM) }, icon('play', 14), h('span', null, 'Load the valley and breach'));
    const rows: Array<[string, string]> = [
      ['Released volume', `${fmtNum(s.volumeM3 / 1e6, 1)} million m³ (${fmtInt(s.volumeM3 / 1233.48)} acre-ft)`],
      ['Head at failure', `${fmtNum(s.headM, 1)} m above the streambed`],
      ['Breach width (Froehlich 2008)', `${fmtNum(r.avgWidthM, 0)} m average, ${fmtNum(r.bottomWidthM, 0)} m at the bottom`],
      ['Breach formation time', fmtMin(r.formationTimeS)],
      [`Peak outflow sent to the map (${METHOD_SHORT[s.method]})`, `${fmtQ(r.peak)} at ${fmtMin(r.tPeak)}`],
      [
        `Peak range, ${r.band.values.length} published relations`,
        `${fmtQ(r.band.low.peak)} – ${fmtQ(r.band.high.peak)} (central ${fmtQ(r.band.central.peak)}, ${relationById(r.band.central.id).label})`,
      ],
      ...(r.input.baseFlow > 0 ? [['River flood under it', fmtQ(r.input.baseFlow)] as [string, string]] : []),
    ];
    // Every relation, lowest to highest, with the band's ends and the central one marked.
    const ordered = [...r.band.values].sort((a, b) => a.peak - b.peak);
    const tag = (id: string) => (id === r.band.central.id ? ' · central' : id === r.band.low.id ? ' · low' : id === r.band.high.id ? ' · high' : '');
    const relations = h(
      'details',
      { class: 'dl-impact-methods', 'data-dam': 'relations' },
      h('summary', null, `The ${ordered.length} relations, and how they did on 21 past failures`),
      h(
        'table',
        { class: 'dl-site-table dl-dam-table' },
        h('tbody', null, ...ordered.map((x) => h('tr', { 'data-relation': x.id }, h('th', null, `${x.label}${tag(x.id)}`), h('td', null, fmtQ(x.peak)), h('td', { class: 'dl-dam-cite' }, x.cite)))),
      ),
      h(
        'p',
        { class: 'dl-impact-fine' },
        'Routed relations give a breach width and formation time, and the peak comes from draining this reservoir through that breach; the others give the peak directly. The central case is the relation with the smallest error on 21 documented failures with measured peaks (U.S. Bureau of Reclamation, Wahl 1998): Froehlich 1995, every one within a factor of two. That check is in-sample (the relations were fitted to many of the same failures), and on Teton 1976 the central case was a third low; the routed Froehlich 2008 breach, this tool’s earlier default, was 64 % high.',
      ),
    );
    detail.replaceChildren(
      h('h3', { class: 'dl-dam-name' }, d.name),
      h('p', { class: 'dl-uc-addr-status' }, `${damLine(d)} · ${d.damType}${d.year ? `, ${d.year}` : ''} · owner: ${d.owner}`),
      // A dry dam (NID normal storage 0) has no sunny-day failure: the choice is shown, greyed, with the reason.
      h(
        'div',
        { class: 'dl-dam-choices', role: 'radiogroup', 'aria-label': 'Breach scenario' },
        radio('dam-mode', 'sunny', s.mode, BREACH_MODES.sunny.label, (v) => (mode = v), !sunnyDayPossible(d)),
        radio('dam-mode', 'flood', s.mode, BREACH_MODES.flood.label, (v) => (mode = v)),
      ),
      sunnyDayPossible(d) ? h('span') : h('p', { class: 'dl-uc-addr-status', 'data-dam': 'dry' }, DRY_DAM_NOTE),
      h('div', { class: 'dl-dam-choices dl-dam-methods', role: 'radiogroup', 'aria-label': 'Hydrograph sent to the map' }, ...BREACH_METHOD_IDS.map((id) => radio('dam-method', id, method, BREACH_METHODS[id], (v) => (method = v)))),
      h('table', { class: 'dl-site-table dl-dam-table', 'data-dam': 'params' }, h('tbody', null, ...rows.map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))))),
      relations,
      notes.length ? h('ul', { class: 'dl-impact-issues', 'data-dam': 'assumptions' }, ...notes.map((a) => h('li', null, a))) : h('span'),
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

  function writeLink(dam: NidDam, breachMode: BreachMode): void {
    try {
      const url = new URL(window.location.href);
      url.searchParams.set(USE_CASE_PARAM, 'dam');
      url.searchParams.set(DAM_PARAM, dam.id);
      url.searchParams.set(BREACH_PARAM, breachMode);
      if (method !== DEFAULT_BREACH_METHOD) url.searchParams.set(METHOD_PARAM, method);
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
  /** The last downstream readout, for a story's {arrival:…} tokens. */
  let reading: { spec: DamBreachSpec; rows: DownstreamReading[]; simTime: number } | null = null;
  /** The view and clock before the first breach on this scenario, and what the view set them to. */
  let raised: { waterMode: RenderSettings['waterMode']; timeScale: number; set: { waterMode: RenderSettings['waterMode']; timeScale: number } } | null = null;
  ctx.bind(
    (s) => !!s.scenario?.damBreach,
    (on) => {
      if (on || !raised) return;
      const r = raised;
      raised = null;
      const s = store.get();
      // A new scene opens in its own view (src/app/scene.ts); on the same map, a view still on the breach's is put back.
      const sameMap = !!last && (bridge.scene?.getTerrain() ?? null) === last.terrain;
      if (sameMap && s.render.waterMode === r.set.waterMode) ctx.setRender({ waterMode: r.waterMode });
      if (s.sim.timeScale === r.set.timeScale) store.set({ sim: { ...s.sim, timeScale: r.timeScale } });
    },
  );

  function install(dam: NidDam, s: DamScenario): void {
    const def = useCaseById('dam');
    const t = bridge.scene?.getTerrain() ?? null;
    const at = damOnMap(t, dam);
    const base = store.get().scenario;
    if (!t || !at || !base) return;
    // A previous breach on this map is replaced, not stacked.
    const clean = { ...base, description: withoutDamText(base), sources: base.sources.filter((x) => x.id !== 'dam-breach'), damBreach: undefined };
    const out = damBreachScenario({ elevation: t.elevation, nx: t.nx, ny: t.ny, cellSize: t.cellSize }, clean, at, s);
    if (!out) {
      postNotice(store, { kind: 'warn', key: 'usecase', title: def.title, message: 'The dam is not on the loaded map.' });
      return;
    }
    // The arrival view and a faster clock while the wave runs; what they were is put back when the breach goes
    // (another scene, or the scenario restored without it) — unless the user has changed them since.
    const before = { waterMode: store.get().render.waterMode, timeScale: store.get().sim.timeScale };
    store.set({ scenario: out.scenario });
    ctx.actions.restoreScenario();
    ctx.actions.resetWater();
    ctx.setRender({ waterMode: 'arrival' });
    const sim = store.get().sim;
    const timeScale = Math.max(sim.timeScale, DAM_TIME_SCALE);
    store.set({ paused: false, sim: { ...sim, timeScale } });
    raised ??= { ...before, set: { waterMode: 'arrival', timeScale } };
    raised.set = { waterMode: 'arrival', timeScale };
    last = { spec: out.spec, terrain: t };
    writeLink(dam, s.mode);
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
      // The breach's own peak with the breach's own volume; the river's flood under it is named separately.
      message: `Peak breach outflow ${fmtQ(out.spec.peak)} at ${fmtMin(out.spec.tPeak)} (${METHOD_SHORT[s.method]}; published relations ${fmtQ(out.spec.band.low.peak)} – ${fmtQ(out.spec.band.high.peak)}), ${fmtNum(s.result.breachVolume / 1e6, 1)} million m³ through the breach${s.result.input.baseFlow > 0 ? ` (${fmtNum(out.spec.volume / 1e6, 1)} million m³ in all with the river’s flood under it)` : ''}. ${def.howTo}`,
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
    // The readback is asynchronous: the scene, its solver or the breach may have changed meanwhile.
    if ((bridge.scene?.getSolver() ?? null) !== solver || (bridge.scene?.getTerrain() ?? null) !== t || (store.get().scenario?.damBreach ?? null) !== spec) {
      renderReadout(null, 'The scene changed while the arrivals were being read. Breach a dam first: the readout follows the flow path below it.');
      return null;
    }
    const rows = readDownstream(fields, spec.path);
    reading = { spec, rows, simTime: fields.simTime };
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
          h('thead', null, h('tr', null, h('th', null, 'Downstream'), h('th', null, 'Wave arrives'), h('th', null, 'If the peak were high – low*'), h('th', null, 'Peak depth'), h('th', null, 'Peak speed'))),
          h(
            'tbody',
            null,
            ...rows.map((r) =>
              h(
                'tr',
                null,
                h('td', null, `${fmtNum(r.distanceM / 1000, 1)} km`),
                h('td', null, r.arrivalS === null ? 'not yet' : fmtMin(r.arrivalS)),
                h('td', { 'data-dam': 'arrival-band' }, r.arrivalS === null || !spec?.band ? '—' : fmtMinRange(scaledArrival(r.arrivalS, spec.peak, spec.band.high.peak), scaledArrival(r.arrivalS, spec.peak, spec.band.low.peak))),
                h('td', null, `${fmtNum(r.maxDepth, 1)} m`),
                h('td', null, `${fmtNum(r.maxSpeed, 1)} m/s`),
              ),
            ),
          ),
        )
      : h('p', { class: 'dl-uc-addr-status' }, 'The flow path below the dam is too short on this map for a readout.');
    readout.replaceChildren(
      head,
      body,
      h('p', { class: 'dl-impact-fine' }, `After ${fmtMin(simTime)} of simulated time since the breach started. Arrival: the first time water stood 0.15 m deep within ~6 cells of the flow path, on ground that was dry at the start. Peak depth is the deepest water near the path, the river channel included. Distances follow the steepest-descent path on the elevation model from the dam’s toe.`),
      spec?.band
        ? h(
            'p',
            { class: 'dl-impact-fine', 'data-dam': 'arrival-note' },
            `* Not simulated: the arrival above rescaled to the published relations’ highest and lowest peaks (${fmtQ(spec.band.high.peak)}, ${spec.band.high.label}; ${fmtQ(spec.band.low.peak)}, ${spec.band.low.label}) against this run’s ${fmtQ(spec.peak)}, by the kinematic-wave rule that travel time goes as peak^−${ARRIVAL_EXPONENT} (Manning flow in a wide channel). Indicative only — to see either case on the map, pick the low or high case and breach again.`,
          )
        : h('span'),
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

  // ─── Narrated stories (storyHooks.ts) ─────────────────────────────────────────────────────────────────────
  /** The breach on screen is this dam's, on the map it was installed on. */
  const isOn = (nid: string): boolean => {
    const spec = store.get().scenario?.damBreach ?? null;
    return !!spec && spec.nidId === nid && !!last && last.terrain === (bridge.scene?.getTerrain() ?? null);
  };
  /** The NID record behind the breach on screen (the index is loaded by then). */
  const damOnScreen = (): NidDam | null => {
    const spec = store.get().scenario?.damBreach ?? null;
    return spec && index ? damById(index, spec.nidId) : null;
  };
  storyHooksFor(store).dam = {
    async open(nid, breachMode) {
      const idx = await ensureIndex();
      const dam = idx ? damById(idx, nid) : null;
      if (!dam) return false;
      if (isOn(nid) && store.get().scenario?.damBreach?.mode === breachMode) return true;
      selected = dam;
      renderDetail();
      reading = null;
      await breach(dam, breachMode, DEFAULT_BREACH_METHOD, DAM_AREA_M);
      return isOn(nid);
    },
    isOn,
    async readArrivals() {
      return !!(await readArrivals());
    },
    fact(f) {
      const spec = store.get().scenario?.damBreach ?? null;
      if (!spec) return null;
      const dam = damOnScreen();
      const band = spec.band;
      switch (f) {
        case 'name':
          return spec.name;
        case 'nid':
          return spec.nidId;
        case 'height':
          return dam ? `${fmtNum(dam.heightM, 1)} m` : null;
        case 'storage':
          return dam ? `${fmtInt(dam.storageAcFt)} acre-ft (${fmtNum((dam.storageAcFt * 1233.48) / 1e6, 1)} million m³)` : null;
        case 'hazard':
          return dam ? `${dam.hazard.toLowerCase()}` : null;
        case 'mode':
          return BREACH_MODES[spec.mode].label.toLowerCase();
        case 'peak':
          return fmtQ(spec.peak);
        case 'tpeak':
          return fmtMin(spec.tPeak);
        case 'band':
          return `${fmtQ(band.low.peak)} – ${fmtQ(band.high.peak)}`;
        case 'central':
          return `${fmtQ(band.central.peak)} (${band.central.label})`;
        case 'low':
          return `${fmtQ(band.low.peak)} (${band.low.label})`;
        case 'high':
          return `${fmtQ(band.high.peak)} (${band.high.label})`;
        case 'volume':
          return `${fmtNum(spec.volume / 1e6, 1)} million m³`;
        case 'width':
          return `${fmtNum(spec.widthM, 0)} m`;
        case 'formation':
          return fmtMin(spec.formationS);
        case 'readat':
          return reading && reading.spec === spec ? fmtMin(reading.simTime) : null;
      }
      return null;
    },
    arrival(km) {
      const spec = store.get().scenario?.damBreach ?? null;
      if (!spec || !reading || reading.spec !== spec) return null;
      const r = reading.rows.find((x) => Math.abs(x.distanceM - km * 1000) < 1);
      if (!r) return null;
      if (r.arrivalS === null) return `not yet, ${fmtMin(reading.simTime)} after the breach began`;
      return `${fmtMin(r.arrivalS)} (${fmtMinRange(scaledArrival(r.arrivalS, spec.peak, spec.band.high.peak), scaledArrival(r.arrivalS, spec.peak, spec.band.low.peak))} across the band)`;
    },
  };

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
