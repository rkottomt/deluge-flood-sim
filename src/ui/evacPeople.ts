/**
 * Site check extras: EVACUATION ON FOOT from the selected site (src/routing/pedestrianEvac.ts), LEAVING BY ROAD — the
 * departure curve after the alert and the queue at the exit (src/loss/egressTiming.ts) — and its INFRASTRUCTURE
 * DEPENDENCIES (src/loss/infraDeps.ts), as blocks in the site card, a dashed walking route on the map and three
 * sections of the printed site assessment.
 *
 * The occupants, their mix of walking paces, the exit width, the pre-movement time, the alert time, the departure
 * curve, persons per car and exit lanes are per site and stay in this tab (defaults from the planned use: IBC
 * occupant load, IBC egress width, Sorensen & Mileti's departure curve, persons per car by use). Everything is computed
 * for the flood Site check last read ("Assess this run"), and cached per flood, site and inputs.
 *
 * Built with h() and text nodes only.
 */
import type { HazardFields, TerrainData, Store } from '../contracts';
import { OCCUPANCY_PROFILES, type SiteRun, type SiteSpec } from '../loss';
import type { EgressRouter } from '../loss/egress';
import { clearanceSentence, EGRESS_TIMING_METHOD, fmtMin, shareOutSentence, timingCaveats, timingDefaults, timingForRun, type EgressTiming } from '../loss/egressTiming';
import { downtimeWithDependencies, reachLine, shelterLine, siteDependencies, utilityLine, type SiteDependencies } from '../loss/infraDeps';
import { DEFAULT_EXIT_LANES, LANE_FLOW_SOURCES } from '../routing/bottleneck';
import { DEFAULT_DEPARTURE_CURVE, DEPARTURE_CURVES, type DepartureCurveId } from '../routing/departure';
import { WalkNetwork } from '../routing/pedestrian';
import {
  analyzePeopleEvac,
  siteExitUnsafeAt,
  defaultExitWidth,
  defaultMix,
  defaultOccupants,
  DEFAULT_PRE_MOVEMENT_S,
  formatTPlus,
  OCCUPANT_LOAD_FT2,
  peopleEvacSentences,
  WALK_GROUPS,
  type PeopleEvacResult,
  type WalkGroupId,
} from '../routing/pedestrianEvac';
import { h } from './dom';
import { fmtNum } from './format';
import { infraFor } from './infraState';
import { kvList } from './siteReport';

/** Per-site inputs (null = the default for the use). */
export interface PeopleParams {
  occupants: number | null;
  olderPct: number | null;
  impairedPct: number | null;
  exitWidthM: number | null;
  preMovementMin: number;
  /** When the warning reaches the occupants, min since the run started (negative: before it). */
  alertMin: number | null;
  /** Leaving by road (null / absent = the default). */
  departure?: DepartureCurveId;
  departBMin?: number | null;
  departMaxPct?: number | null;
  personsPerCar?: number | null;
  exitLanes?: number | null;
}

/** Bounds of the "Alert at T+ min" input: a warning up to a day before the run starts, or a day into it. */
export const ALERT_MIN_RANGE = { min: -1440, max: 1440 } as const;

const DEFAULT_PARAMS: PeopleParams = { occupants: null, olderPct: null, impairedPct: null, exitWidthM: null, preMovementMin: DEFAULT_PRE_MOVEMENT_S / 60, alertMin: null };

export interface SiteExtrasDeps {
  store: Store;
  getTerrain(): TerrainData | null;
  /** Bare-earth ground on the flood's grid. */
  getGround(): Float32Array | null;
  /** Site check's car router (carries the roads). */
  getRouter(): EgressRouter | null;
  setWalkRoute(route: Float32Array | null, cut?: boolean): void;
  /** Re-render the card (inputs changed, async results arrived). */
  rerender(): void;
}

export interface SiteExtrasResult {
  evac: PeopleEvacResult | null;
  occupantBasis: string;
  deps: SiteDependencies | null;
  depsNote: string;
  downtime: { base: number; withDeps: number; from: string } | null;
}

/** Methods for the report appendix. */
export const PEOPLE_METHOD_NOTES: ReadonlyArray<{ title: string; text: string }> = [
  EGRESS_TIMING_METHOD,
  {
    title: 'Evacuation on foot',
    text:
      'Occupants leave through the exits after the alert and a pre-movement time, at the SFPE maximum specific flow (≈ 1.3 persons/s per metre of effective ' +
      'width), and walk every road edge in both directions (the baked road data carries no footways) to the nearest refuge: a shelter that stays safe, or any ' +
      'ground that stays dry and stands 1 m above the highest water within 300 m. A street is unsafe for people once its water reaches FD2321 hazard rating ' +
      '0.75 (“danger for some”) or AIDR H3 (“unsafe for children and the elderly”), counted from the first arrival of water there — an early estimate. ' +
      'Paces: 1.22 m/s able adults (FEMA P-646 / Wood & Schmidtlein 2012), 0.91 m/s older adults (MUTCD 2009 §4E.06), 0.6 m/s mobility-impaired (assumption). ' +
      'Occupants default to the IBC Table 1004.5 design load (an upper bound), exits to the IBC 1005.3.2 width. Vertical evacuation: the first floor at least ' +
      '1 m above the site’s max depth, in a building outside the fast-water collapse band. Traffic, crowding on the street, stairs, night-time and people ' +
      'who do not leave are not modelled.',
  },
];

/**
 * The cache key of a site's extras for one flood: everything the answer depends on. The shelters are in it — they are
 * refuges for the walk, so adding, moving or removing one changes the answer.
 */
export function extrasKey(
  spec: SiteSpec,
  simTime: number,
  alertTime: number,
  params: PeopleParams,
  infraStatus: string,
  shelters: ReadonlyArray<{ gx: number; gy: number; name?: string }>,
): string {
  return JSON.stringify([
    spec.id, spec.lon, spec.lat, spec.ring, spec.occupancy, spec.floors, spec.footprintM2, spec.firstFloorHeight,
    simTime, alertTime, params, infraStatus, shelters.map((s) => [s.gx, s.gy, s.name ?? '']),
  ]);
}

function num(v: number, d = 0): string {
  return Number.isFinite(v) ? fmtNum(v, d) : '—';
}

export function createSiteExtras(deps: SiteExtrasDeps) {
  const params = new Map<string, PeopleParams>();
  let walk: { terrain: TerrainData; net: WalkNetwork } | null = null;
  let walkFields: HazardFields | null = null;
  let walkShelters: unknown = null;
  const cache = new Map<string, SiteExtrasResult>();
  let cacheFields: HazardFields | null = null;
  let pendingKey = '';

  const paramsFor = (id: string) => params.get(id) ?? { ...DEFAULT_PARAMS };

  function network(t: TerrainData): WalkNetwork | null {
    if (!t.roads || !t.roads.edges.length) return null;
    if (walk?.terrain !== t) walk = { terrain: t, net: new WalkNetwork(t.roads, t.cellSize, t.nx, t.ny) };
    return walk.net;
  }

  function computeEvac(spec: SiteSpec, run: SiteRun, f: HazardFields, alertTime: number): { evac: PeopleEvacResult | null; basis: string } {
    const t = deps.getTerrain();
    const r = run.result;
    if (!t || !r) return { evac: null, basis: '' };
    const net = network(t);
    if (!net) return { evac: null, basis: 'no road data' };
    const shelters = deps.store.get().shelters;
    if (walkFields !== f || walkShelters !== shelters) {
      net.setFields(f, { ground: deps.getGround(), shelters });
      walkFields = f;
      walkShelters = shelters;
    }
    const p = paramsFor(spec.id);
    const occ = defaultOccupants(r.occ, r.gfaM2);
    const N = p.occupants ?? occ.n;
    const mix = defaultMix(r.occ);
    if (p.olderPct != null) mix.older = p.olderPct / 100;
    if (p.impairedPct != null) mix.impaired = p.impairedPct / 100;
    mix.able = Math.max(0, 1 - mix.older - mix.impaired);
    // When the site's own surroundings turn unsafe: the cells against its walls when buildings are obstacles.
    const exit = siteExitUnsafeAt(run.result?.m.cells ?? [], f);
    const evac = analyzePeopleEvac(net, { gx: run.geometry.gx, gy: run.geometry.gy }, {
      occupants: N,
      mix: (Object.keys(mix) as WalkGroupId[]).map((id) => ({ id, share: mix[id] })),
      exitWidthM: p.exitWidthM ?? defaultExitWidth(N),
      preMovementS: p.preMovementMin * 60,
      alertTime: p.alertMin != null ? p.alertMin * 60 : alertTime,
      exitUnsafeAt: exit.t,
      exitUntimed: exit.untimed,
      building: run.assetSpec
        ? { floors: r.floors, firstFloorHeight: run.firstFloorHeight, storeyHeight: run.assetSpec.storeyHeight, maxDepth: r.reached ? r.depth : 0, collapseShare: r.collapseShare, state: r.state }
        : null,
    });
    return { evac, basis: p.occupants != null ? 'your input' : `${occ.basis} × ${fmtNum(r.gfaM2)} m² floor area — a design maximum` };
  }

  function computeDeps(spec: SiteSpec, run: SiteRun, f: HazardFields): { deps: SiteDependencies | null; note: string; downtime: SiteExtrasResult['downtime'] } {
    const t = deps.getTerrain();
    const st = infraFor(deps.store);
    const r = run.result;
    if (!t || !r) return { deps: null, note: '', downtime: null };
    if (st.load.status !== 'ok') return { deps: null, note: st.load.status === 'loading' || st.load.status === 'idle' ? 'loading facilities…' : st.load.note || 'no facility data for this map', downtime: null };
    const ex = st.exposuresFor(f, t, st.load.list);
    const d = siteDependencies(
      { lon: spec.lon, lat: spec.lat, gx: run.geometry.gx, gy: run.geometry.gy, siteWet: r.reached },
      { fields: f, exposures: ex, router: deps.getRouter(), shelters: deps.store.get().shelters, grid: { nx: t.nx, ny: t.ny, cellSize: t.cellSize } },
    );
    const withDeps = downtimeWithDependencies({ baseDays: r.downtimeDays, depthAboveFloor: r.depthAboveFloor, damage: r.damage, rebuildDays: OCCUPANCY_PROFILES[r.occ].rebuildDays, utilityDays: d.utilityDays });
    return { deps: d, note: '', downtime: { base: r.downtimeDays, withDeps, from: d.utilityDaysFrom } };
  }

  /** Leaving by road for one run of a site (the current flood or a sweep level): cheap, not cached. */
  function timingFor(spec: SiteSpec, run: SiteRun, alertTime: number): EgressTiming | null {
    return timingForRun(run, alertTime, paramsFor(spec.id));
  }

  function keyOf(spec: SiteSpec, run: SiteRun, alertTime: number): string {
    return extrasKey(spec, run.simTime, alertTime, paramsFor(spec.id), infraFor(deps.store).load.status, deps.store.get().shelters);
  }

  /** Compute now (sync; cached). */
  function resultFor(spec: SiteSpec, run: SiteRun, f: HazardFields, alertTime: number): SiteExtrasResult {
    if (cacheFields !== f) {
      cache.clear();
      cacheFields = f;
    }
    const key = keyOf(spec, run, alertTime);
    let res = cache.get(key);
    if (!res) {
      const e = computeEvac(spec, run, f, alertTime);
      const d = computeDeps(spec, run, f);
      res = { evac: e.evac, occupantBasis: e.basis, deps: d.deps, depsNote: d.note, downtime: d.downtime };
      cache.set(key, res);
    }
    return res;
  }

  function input(label: string, value: number | null, placeholder: string, attr: string, min: number, max: number, step: number, on: (v: number | null) => void): HTMLElement {
    const el = h('input', { type: 'number', class: 'dl-num-input', min, max, step, inputmode: 'decimal', placeholder, 'aria-label': label, 'data-people': attr, value: value == null ? '' : String(value) });
    el.addEventListener('change', () => {
      const v = el.value.trim() === '' ? null : Number(el.value);
      on(v == null || !Number.isFinite(v) ? null : Math.min(max, Math.max(min, v)));
    });
    return h('label', null, label, el);
  }

  function peopleBlock(spec: SiteSpec, run: SiteRun, res: SiteExtrasResult): HTMLElement {
    const p = paramsFor(spec.id);
    const upd = (patch: Partial<PeopleParams>) => {
      params.set(spec.id, { ...p, ...patch });
      deps.rerender();
    };
    const e = res.evac;
    const r = run.result!;
    const occ = defaultOccupants(r.occ, r.gfaM2);
    const mix = defaultMix(r.occ);
    const parts: HTMLElement[] = [h('p', { class: 'dl-people-head' }, 'People on foot')];
    if (!e) parts.push(h('p', { class: 'dl-impact-fine' }, `Not assessed: ${res.occupantBasis || 'no flood read'}.`));
    else {
      parts.push(h('div', { class: 'dl-people-lines', 'data-people': 'summary' }, ...peopleEvacSentences(e).map((s) => h('p', null, s))));
      if (e.known) {
        parts.push(
          h(
            'div',
            { class: 'dl-impact-table' },
            h(
              'table',
              null,
              h('thead', null, h('tr', null, h('th', null, 'Group'), h('th', null, 'People'), h('th', null, 'Leave by'), h('th', null, 'Walk'))),
              h(
                'tbody',
                null,
                ...e.groups.map((g) =>
                  h(
                    'tr',
                    null,
                    h('td', null, h('span', { class: 'dl-impact-name' }, g.label), h('span', { class: 'dl-impact-meta' }, `${fmtNum(g.speed, 2)} m/s`)),
                    h('td', null, `${num(g.reach)} of ${num(g.people)}`),
                    h('td', null, Number.isNaN(g.latestDeparture) ? 'none' : g.latestDeparture === Infinity ? `> ${formatTPlus(e.horizon)}` : formatTPlus(g.latestDeparture)),
                    h('td', null, Number.isFinite(g.walkS) ? `${fmtNum(g.walkS / 60, 0)} min` : '—'),
                  ),
                ),
              ),
            ),
          ),
        );
        parts.push(
          h(
            'p',
            { class: 'dl-impact-fine' },
            `Exits ${fmtNum(e.exitFlowPerS * 60, 0)} people/min · occupants: ${res.occupantBasis}${e.speedsKnown ? '' : ' · depth-only flood (no speeds): street hazard understated'} · the run covers to ${formatTPlus(e.horizon)}. Leave by: the latest departure from the door that still reaches a refuge (> : still open when the run ended). Walking route: dashed blue on the map (orange: the walk the flood closed).`,
          ),
        );
      }
    }
    parts.push(
      h(
        'div',
        { class: 'dl-people-inputs' },
        input('Occupants', p.occupants, String(occ.n), 'occupants', 1, 100000, 1, (v) => upd({ occupants: v == null ? null : Math.round(v) })),
        input('Older adults %', p.olderPct, String(Math.round(mix.older * 100)), 'older', 0, 100, 1, (v) => upd({ olderPct: v })),
        input('Mobility-impaired %', p.impairedPct, String(Math.round(mix.impaired * 100)), 'impaired', 0, 100, 1, (v) => upd({ impairedPct: v })),
        input('Exit width m', p.exitWidthM, fmtNum(defaultExitWidth(p.occupants ?? occ.n), 2), 'exit', 0.5, 100, 0.1, (v) => upd({ exitWidthM: v })),
        input('Pre-movement min', p.preMovementMin, String(DEFAULT_PRE_MOVEMENT_S / 60), 'pre', 0, 240, 1, (v) => upd({ preMovementMin: v ?? DEFAULT_PRE_MOVEMENT_S / 60 })),
        input('Alert at T+ min', p.alertMin, '0', 'alert', ALERT_MIN_RANGE.min, ALERT_MIN_RANGE.max, 1, (v) => upd({ alertMin: v })),
      ),
    );
    return h('div', { class: 'dl-people', 'data-site': 'people' }, ...parts);
  }

  /** "Leaving by road": who is out when the way out closes, clearance vs window, and the inputs behind it. */
  function roadBlock(spec: SiteSpec, run: SiteRun, alertTime: number): HTMLElement {
    const p = paramsFor(spec.id);
    const upd = (patch: Partial<PeopleParams>) => {
      params.set(spec.id, { ...paramsFor(spec.id), ...patch });
      deps.rerender();
    };
    const t = timingFor(spec, run, alertTime);
    const parts: HTMLElement[] = [h('p', { class: 'dl-people-head' }, 'Leaving by road')];
    if (!t || !t.known) parts.push(h('p', { class: 'dl-impact-fine' }, `Not assessed: ${t?.note || 'no flood read'}.`));
    else {
      parts.push(
        h(
          'div',
          { class: 'dl-people-lines dl-road-lines', 'data-road': 'summary' },
          h('p', { 'data-road': 'share' }, shareOutSentence(t)),
          h('p', { class: t.clearsInWindow ? null : 'dl-road-late', 'data-road': 'clearance' }, clearanceSentence(t)),
        ),
      );
      parts.push(
        h(
          'p',
          { class: 'dl-impact-fine' },
          `Alert at T${t.alertTime < 0 ? '−' : '+'}${fmtMin(Math.abs(t.alertTime))}${Number.isFinite(t.lastSafeAt) ? ` · latest safe departure ${t.lastSafeShelter ? `for ${t.lastSafeShelter} ` : ''}T${t.lastSafeAt < 0 ? '−' : '+'}${fmtMin(Math.abs(t.lastSafeAt))} (its closure minus the drive)` : ''} · occupants: ${t.occupantsBasis} · ${t.personsPerVehicleBasis} · longest queue ${num(t.maxQueue)} cars.`,
        ),
        h(
          'details',
          { class: 'dl-impact-methods', 'data-road': 'caveats' },
          h('summary', null, 'What this leaves out'),
          h('ul', { class: 'dl-impact-issues' }, ...timingCaveats(t).map((c) => h('li', null, c)), ...LANE_FLOW_SOURCES.map((c) => h('li', null, `Capacity — ${c}.`))),
        ),
      );
    }
    const curveSel = h(
      'select',
      { class: 'dl-num-input', 'aria-label': 'Departure curve', 'data-road': 'curve' },
      ...(Object.keys(DEPARTURE_CURVES) as DepartureCurveId[]).map((id) => h('option', { value: id, selected: id === (p.departure ?? DEFAULT_DEPARTURE_CURVE) }, DEPARTURE_CURVES[id].label)),
    );
    curveSel.addEventListener('change', () => {
      const id = curveSel.value as DepartureCurveId;
      if (Object.hasOwn(DEPARTURE_CURVES, id)) upd({ departure: id, departBMin: null, departMaxPct: null });
    });
    const base = DEPARTURE_CURVES[p.departure ?? DEFAULT_DEPARTURE_CURVE];
    const occDefault = run.result ? timingDefaults(run.result.occ).personsPerVehicle : 1.18;
    parts.push(
      h('label', { class: 'dl-road-curve' }, 'Departures after the alert', curveSel),
      h(
        'div',
        { class: 'dl-people-inputs', 'data-road': 'inputs' },
        input('Departure scale b, min', p.departBMin ?? null, fmtNum(base.bMin, 1), 'depart-b', 1, 1440, 1, (v) => upd({ departBMin: v })),
        input('Ever leave %', p.departMaxPct ?? null, fmtNum(base.maxShare * 100, 1), 'depart-max', 0, 100, 1, (v) => upd({ departMaxPct: v })),
        input('Persons per car', p.personsPerCar ?? null, fmtNum(occDefault, 2), 'per-car', 1, 10, 0.1, (v) => upd({ personsPerCar: v })),
        input('Exit lanes', p.exitLanes ?? null, String(DEFAULT_EXIT_LANES), 'lanes', 1, 12, 1, (v) => upd({ exitLanes: v == null ? null : Math.round(v) })),
      ),
    );
    return h('div', { class: 'dl-people', 'data-site': 'road' }, ...parts);
  }

  function roadRows(t: EgressTiming | null): Array<[string, string]> {
    if (!t || !t.known) return [['Result', `not assessed${t?.note ? ` (${t.note})` : ''}`]];
    return [
      ['Out before the last route closes', shareOutSentence(t)],
      ['Clearance vs route window', clearanceSentence(t)],
      ['Departure curve', `${t.curve.label}: a ${fmtNum(t.curve.a, 2)}, b ${fmtNum(t.curve.bMin, 1)} min, ${fmtNum(t.curve.maxShare * 100, 1)} % ever leave — ${t.curve.source}`],
      ['Alert', `T${t.alertTime < 0 ? '−' : '+'}${fmtMin(Math.abs(t.alertTime))}`],
      ['Cars', `${num(t.vehicles)} — ${num(t.occupants)} occupants (${t.occupantsBasis}); ${t.personsPerVehicleBasis}`],
      ...timingCaveats(t).map((c, k): [string, string] => [k === 0 ? 'Caveats' : '', c]),
    ];
  }

  function depsRows(res: SiteExtrasResult): Array<[string, string]> {
    const d = res.deps;
    if (!d) return [['Dependencies', res.depsNote || 'not assessed']];
    const rows: Array<[string, string]> = [];
    const label = { power: 'Power', water: 'Water', telecom: 'Telecom', wastewater: 'Wastewater' } as const;
    for (const u of d.utilities) rows.push([label[u.utility], utilityLine(u)]);
    if (!d.utilities.some((u) => u.utility === 'power')) rows.push(['Power', 'no substation mapped on this map — service area unknown']);
    if (d.hospital) rows.push(['Hospital', reachLine(d.hospital)]);
    if (d.fire) rows.push(['Fire station', reachLine(d.fire)]);
    for (const s of d.shelters) rows.push([`Shelter ${s.name}`, shelterLine(s)]);
    if (res.downtime) {
      const dt = res.downtime;
      rows.push(['Downtime (heuristic)', dt.withDeps > dt.base + 0.05 ? `${num(dt.base, 0)} d on its own → ${num(dt.withDeps, 0)} d with ${dt.from} (illustrative restoration days)` : `${num(dt.base, 0)} d — no dependency adds to it`]);
    }
    return rows;
  }

  function depsBlock(res: SiteExtrasResult): HTMLElement {
    const d = res.deps;
    return h(
      'div',
      { class: 'dl-people', 'data-site': 'deps' },
      h('p', { class: 'dl-people-head' }, 'Depends on'),
      ...(d && d.flags.length ? [h('ul', { class: 'dl-deps-flags', 'data-site': 'dep-flags' }, ...d.flags.map((x) => h('li', null, x)))] : []),
      kvList(depsRows(res), 'dl-site-kv'),
    );
  }

  return {
    /** The card block for the selected site; heavy work runs after the card is on screen. */
    card(spec: SiteSpec, run: SiteRun, f: HazardFields, alertTime: number): HTMLElement {
      const el = h('div', { class: 'dl-site-extras', 'data-site': 'extras' });
      if (!run.result) {
        deps.setWalkRoute(null);
        return el;
      }
      const st = infraFor(deps.store);
      const t = deps.getTerrain();
      // Make sure this scene's facilities are (being) loaded; re-render once when they arrive.
      const before = st.load.status;
      void st.facilities(t, deps.store.get().presetId).then(() => {
        if (before !== 'ok' && st.load.status === 'ok') deps.rerender();
      });
      const key = keyOf(spec, run, alertTime);
      const cached = cacheFields === f ? cache.get(key) : undefined;
      const fill = (res: SiteExtrasResult) => {
        el.replaceChildren(peopleBlock(spec, run, res), roadBlock(spec, run, alertTime), depsBlock(res));
        deps.setWalkRoute(res.evac?.route?.polyline ?? null, !!res.evac?.route?.cut);
      };
      if (cached) fill(cached);
      else {
        el.replaceChildren(h('p', { class: 'dl-impact-fine' }, 'Working out evacuation on foot and dependencies…'));
        pendingKey = key;
        setTimeout(() => {
          if (pendingKey !== key) return;
          try {
            fill(resultFor(spec, run, f, alertTime));
          } catch (err) {
            el.replaceChildren(h('p', { class: 'dl-impact-fine dl-warn' }, `Evacuation on foot not assessed: ${err instanceof Error ? err.message : String(err)}`));
          }
        }, 0);
      }
      return el;
    },
    /** Leaving by road for one run of a site (the verdict calls it for the sweep's levels). */
    timing: timingFor,
    /** Report sections for a site (computed now if needed). */
    report(spec: SiteSpec, run: SiteRun | null, f: HazardFields | null, alertTime: number): HTMLElement[] {
      if (!run || !run.result || !f) return [];
      const res = resultFor(spec, run, f, alertTime);
      const e = res.evac;
      const rows: Array<[string, string]> = [];
      if (e) {
        peopleEvacSentences(e).forEach((s, k) => rows.push([k === 0 ? 'Summary' : '', s]));
        if (e.known) {
          for (const g of e.groups) rows.push([g.label, `${num(g.reach)} of ${num(g.people)} reach safety · ${fmtNum(g.speed, 2)} m/s · latest safe departure ${Number.isNaN(g.latestDeparture) ? 'none' : g.latestDeparture === Infinity ? `after ${formatTPlus(e.horizon)}` : formatTPlus(g.latestDeparture)}`]);
          rows.push(['Exit flow', `${fmtNum(e.exitFlowPerS * 60, 0)} people/min (SFPE specific flow over the exits’ effective width)`]);
          rows.push(['Occupants', `${num(e.occupants)} — ${res.occupantBasis}`]);
          if (e.route) rows.push(['Refuge', `${e.route.refuge}, ${fmtNum(e.route.meters, 0)} m on foot${e.route.via ? ` via ${e.route.via}` : ''}`]);
        }
      }
      return [
        h('h3', null, 'Evacuation on foot'),
        kvList(rows.length ? rows : [['Result', 'not assessed']]),
        h('h3', null, 'Leaving by road'),
        kvList(roadRows(timingFor(spec, run, alertTime))),
        h('h3', null, 'Infrastructure dependencies'),
        ...(res.deps && res.deps.flags.length ? [h('ul', { class: 'dl-rep-note' }, ...res.deps.flags.map((x) => h('li', null, x)))] : []),
        kvList(depsRows(res)),
      ];
    },
    reset() {
      cache.clear();
      cacheFields = null;
      walkFields = null;
      deps.setWalkRoute(null);
    },
  };
}

export { OCCUPANT_LOAD_FT2, WALK_GROUPS };
