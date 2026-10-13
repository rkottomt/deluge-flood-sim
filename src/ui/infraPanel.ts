/**
 * The "Infrastructure" panel section: the scenario's critical facilities (substations, hospitals, fire and police
 * stations, water and wastewater works, telecom exchanges, bridges, fuel — src/data/facilities.ts) checked against the
 * flood on screen: which ones fail or are impaired, and from when (src/loss/infra.ts), with map icons coloured by
 * status. Site check reads the same exposures for its dependency lines (infraState.ts, evacPeople.ts).
 *
 * Built with h() and text nodes only: facility names come from OpenStreetMap and are never parsed as markup.
 */
import './infraEvac.css';
import type { FloodSolver, HazardFields, TerrainData } from '../contracts';
import { makeGeoToGrid } from '../data/geo';
import { computeInitialWater } from '../data/initialWater';
import { FACILITIES_ATTRIBUTION, FACILITY_KINDS, FACILITY_LABELS } from '../data/facilities';
import { FACILITY_THRESHOLDS, sortExposures, summarizeInfra, type FacilityExposure } from '../loss/infra';
import { SnapshotHazardAccumulator } from '../loss/fallback';
import { facilityName, UTILITY_RESTORATION_DAYS } from '../loss/infraDeps';
import { bridgeFor } from './bridge';
import { button, toggleSwitch } from './controls';
import { h, setText, toggleClass, type UIContext } from './dom';
import { fmtNum, formatClock } from './format';
import { infraFor } from './infraState';
import { createInfraOverlay, KIND_GLYPH } from './infraOverlay';

export interface InfraSection {
  body: HTMLElement[];
  badge: HTMLElement;
  overlay: HTMLElement;
  activate(): void;
  /** Press "Assess infrastructure". */
  assess(): Promise<void>;
}

const STATUS_TEXT = { failed: 'out of service', impaired: 'impaired', operational: 'operational' } as const;

/** The methods notes shared by the panel and the site report. */
export const INFRA_METHOD_NOTES: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: 'Facilities',
    text:
      'From OpenStreetMap (power=substation|plant, amenity=hospital|clinic|fire_station|police|fuel, healthcare=hospital, ' +
      'man_made=water_works|wastewater_plant, telecom=exchange|central_office|data_center, bridge=* on motorway/trunk/primary/secondary roads), ' +
      'baked per scenario. OSM coverage is uneven: a facility missing here may still exist. Live areas have none (the Overpass API is not an allowed endpoint).',
  },
  {
    title: 'Exposure and status',
    text:
      'Maximum depth over the facility’s cells (within 60 m of its centre; a bridge at the two landings of its deck, since its span crosses the river by design), ' +
      'ignoring water present at reset. Status by depth thresholds per type — screening values, each with its basis below. Times are early estimates: water ' +
      'that later reached the threshold is counted from its first arrival (15 cm).',
  },
  {
    title: 'Dependencies (Site check)',
    text:
      'Power: the nearest substation in a straight line — a Voronoi service area, an APPROXIMATION (feeders follow the utility’s network). Water, telecom, ' +
      'wastewater: the nearest such facility on the map. Hospital and fire station: the nearest by road at the flood’s peak, flooded roads closed, and when the ' +
      `last route was cut. Downtime adds the longest utility restoration (power ${UTILITY_RESTORATION_DAYS.power.failed} d, water ${UTILITY_RESTORATION_DAYS.water.failed} d, ` +
      `telecom ${UTILITY_RESTORATION_DAYS.telecom.failed} d when failed) to the business-interruption heuristic — illustrative numbers, labelled as such.`,
  },
];

export function createInfraSection(ctx: UIContext): InfraSection {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  const state = infraFor(store);
  const getSolver = (): FloodSolver | null => bridge.scene?.getSolver() ?? null;
  const getTerrain = (): TerrainData | null => bridge.scene?.getTerrain() ?? null;

  let busy = false;
  let shown = true;
  let active = false;
  let result: { fields: HazardFields; source: 'gpu' | 'snapshots'; exposures: FacilityExposure[] } | null = null;

  const badge = h('span', { class: 'dl-sec-badge', hidden: true });
  const intro = h(
    'p',
    { class: 'dl-impact-note' },
    'Which substations, hospitals, fire stations, water works, exchanges and bridges does this flood take out — and when? Facilities from OpenStreetMap; status by screening depth thresholds per type.',
  );
  const assessBtn = button('Assess infrastructure', () => void assess(), { icon: 'bolt', variant: 'primary', className: 'dl-btn-sm', tip: 'Read the flood on screen and check every facility against it', side: 'top' });
  assessBtn.dataset.infra = 'assess';
  const showSw = toggleSwitch('Show on map', (on) => {
    shown = on;
    overlay.setVisible(on);
  });
  showSw.set(true);
  const status = h('p', { class: 'dl-impact-status', 'aria-live': 'polite', 'data-infra': 'status' });
  const summary = h('div', { class: 'dl-infra-summary', 'data-infra': 'summary' });
  const table = h('div', { class: 'dl-impact-table dl-infra-table' });
  const okList = h('details', { class: 'dl-impact-methods', hidden: true });
  const methods = h(
    'details',
    { class: 'dl-impact-methods' },
    h('summary', null, 'How Infrastructure works'),
    ...INFRA_METHOD_NOTES.map((n) => h('div', { class: 'dl-impact-method' }, h('b', null, n.title), h('p', null, n.text))),
    h('div', { class: 'dl-impact-method' }, h('b', null, 'Thresholds'), h('ul', { class: 'dl-impact-issues' }, ...FACILITY_KINDS.map((k) => h('li', null, FACILITY_THRESHOLDS[k].basis)))),
    h('p', { class: 'dl-impact-fine' }, FACILITIES_ATTRIBUTION),
  );
  const body = [intro, h('div', { class: 'dl-row dl-row-wrap' }, assessBtn), showSw.el, status, summary, table, okList, methods];

  const overlay = createInfraOverlay({
    getCamera: () => bridge.scene?.getCamera?.() ?? null,
    getTerrain,
    getExaggeration: () => store.get().render.verticalExaggeration,
    getCanvas: () => (typeof document !== 'undefined' ? (document.getElementById('deluge-canvas') as HTMLCanvasElement | null) : null),
  });
  ctx.own(() => overlay.destroy());

  function setStatus(text: string, tone: 'info' | 'warn' = 'info') {
    setText(status, text);
    toggleClass(status, 'dl-warn', tone === 'warn');
  }

  function pinsFromLoad() {
    const t = getTerrain();
    if (!t || !active) return overlay.set([]);
    if (result) {
      overlay.set(result.exposures.filter((e) => e.inside).map((e) => ({ gx: (e.gx * t.nx) / result!.fields.nx, gy: (e.gy * t.ny) / result!.fields.ny, kind: e.facility.kind, status: e.status, label: `${facilityName(e)} — ${STATUS_TEXT[e.status]}` })));
      return;
    }
    // Before an assessment: every facility, status unknown.
    const geo = makeGeoToGrid(t);
    overlay.set(state.load.list.map((f) => ({ gx: geo(f.lon, f.lat)[0], gy: geo(f.lon, f.lat)[1], kind: f.kind, status: 'unknown' as const, label: f.name || FACILITY_LABELS[f.kind] })));
  }

  function render() {
    const l = state.load;
    const n = l.list.length;
    badge.hidden = !result && n === 0;
    if (result) {
      const s = summarizeInfra(result.exposures);
      setText(badge, s.failed ? `${s.failed} out` : `${s.inside}`);
      toggleClass(badge, 'dl-warn', s.failed > 0);
    } else setText(badge, `${n}`);
    assessBtn.disabled = busy || l.status !== 'ok' || n === 0;
    if (!result) {
      summary.replaceChildren(
        h('p', { class: 'dl-impact-fine' }, l.status === 'loading' ? 'Loading facilities…' : l.status === 'ok' ? `${n} facilities on this map (${FACILITY_KINDS.map((k) => [k, l.list.filter((f) => f.kind === k).length] as const).filter(([, c]) => c).map(([k, c]) => `${c} ${FACILITY_LABELS[k].toLowerCase()}${c === 1 ? '' : 's'}`).join(', ')}). Press “Assess infrastructure” to check them against the flood on screen.` : l.note || 'No facility data for this map.'),
      );
      table.replaceChildren();
      okList.hidden = true;
      return;
    }
    const s = summarizeInfra(result.exposures);
    summary.replaceChildren(
      h('p', null, h('b', null, `${s.failed} out of service`), ` · ${s.impaired} impaired · ${s.inside - s.failed - s.impaired} operational, of ${s.inside} facilities on the map — flood at ${formatClock(result.fields.simTime)}.`),
      h(
        'p',
        { class: 'dl-impact-fine' },
        FACILITY_KINDS.filter((k) => s.byKind[k].total > 0)
          .map((k) => `${FACILITY_LABELS[k]}s ${s.byKind[k].failed}/${s.byKind[k].total} out${s.byKind[k].impaired ? `, ${s.byKind[k].impaired} impaired` : ''}`)
          .join(' · '),
      ),
    );
    const sorted = sortExposures(result.exposures);
    const hit = sorted.filter((e) => e.status !== 'operational');
    table.replaceChildren(
      hit.length
        ? h(
            'table',
            null,
            h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Facility'), h('th', null, 'Status'), h('th', null, 'Depth'), h('th', null, 'From'))),
            h(
              'tbody',
              null,
              ...hit.map((e) =>
                h(
                  'tr',
                  { class: `dl-infra-row dl-infra-${e.status}`, 'data-infra-row': e.facility.kind },
                  h('td', null, h('span', { class: `dl-infra-glyph dl-infra-${e.status}` }, KIND_GLYPH[e.facility.kind])),
                  h('td', null, h('span', { class: 'dl-impact-name' }, facilityName(e)), h('span', { class: 'dl-impact-meta' }, `${FACILITY_LABELS[e.facility.kind]}${e.wetSeconds > 0 ? ` · wet ${fmtNum(e.wetSeconds / 60, 0)} min` : ''}`)),
                  h('td', null, STATUS_TEXT[e.status]),
                  h('td', null, `${fmtNum(e.depth, 2)} m`),
                  h('td', null, (() => {
                    const t = e.status === 'failed' ? e.failedAt : e.impairedAt;
                    return Number.isFinite(t) ? formatClock(t) : '—';
                  })()),
                ),
              ),
            ),
          )
        : h('p', { class: 'dl-impact-fine' }, 'No facility on this map is impaired by this flood.'),
    );
    const ok = sorted.filter((e) => e.status === 'operational');
    okList.hidden = ok.length === 0;
    okList.replaceChildren(h('summary', null, `${ok.length} operational`), h('ul', { class: 'dl-impact-issues' }, ...ok.slice(0, 300).map((e) => h('li', null, `${FACILITY_LABELS[e.facility.kind]}: ${facilityName(e)}${e.depth > 0.01 ? ` (${fmtNum(e.depth, 2)} m)` : ''}`))));
  }

  async function readFields(t: TerrainData): Promise<{ fields: HazardFields; source: 'gpu' | 'snapshots' } | null> {
    const solver = getSolver();
    if (!solver) return null;
    if (typeof solver.readHazardFields === 'function') return { fields: await solver.readHazardFields(), source: 'gpu' };
    const snap = solver.getSnapshot();
    if (!snap) return null;
    const acc = new SnapshotHazardAccumulator();
    try {
      acc.setBaseline(computeInitialWater(t, store.get().scenario));
    } catch {
      acc.setBaseline(null);
    }
    acc.feed(snap.depth, snap.nx, snap.ny, snap.simTime);
    const f = acc.fields();
    return f ? { fields: f, source: 'snapshots' } : null;
  }

  async function assess(): Promise<void> {
    if (busy) return;
    const t = getTerrain();
    if (!t) return setStatus('Load a scene first.', 'warn');
    busy = true;
    render();
    setStatus('Reading the flood…');
    try {
      const list = await state.facilities(t, store.get().presetId);
      if (!list.length) return setStatus(state.load.note || 'No facilities on this map.', 'warn');
      const r = await readFields(t);
      if (!r) return setStatus('Waiting for the first depth snapshot — try again in a moment.', 'warn');
      if (getTerrain() !== t) return;
      const t0 = performance.now();
      const exposures = state.exposuresFor(r.fields, t, list);
      result = { fields: r.fields, source: r.source, exposures };
      state.setLatest(r.fields, exposures);
      setStatus(`Flood at ${formatClock(r.fields.simTime)} · ${list.length} facilities in ${fmtNum(performance.now() - t0, 0)} ms${r.source === 'snapshots' ? ' · depth snapshot only (no arrival times or speeds)' : ''}.`);
    } catch (err) {
      setStatus(`Couldn’t assess the facilities: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    } finally {
      busy = false;
      render();
      pinsFromLoad();
    }
  }

  function ensureScene() {
    const t = getTerrain();
    result = null;
    void state.facilities(t, store.get().presetId).then(() => {
      render();
      pinsFromLoad();
    });
    render();
    pinsFromLoad();
  }

  ctx.own(state.on(() => render()));
  ctx.bind(
    (s) => `${s.presetId}|${s.terrainName}`,
    () => {
      setStatus('');
      result = null;
      // Facilities are fetched only once the section (or Site check) is in use.
      if (active) ensureScene();
      else render();
    },
  );
  render();
  return {
    body,
    badge,
    overlay: overlay.el,
    activate() {
      active = true;
      overlay.setVisible(shown);
      ensureScene();
    },
    assess,
  };
}
