/**
 * The valley timeline (the hazard chain's hero visual): a strip at the bottom of the map with the valley's long profile
 * from the source to the 2-D map — chainage across, bed elevation up — its towns, gauges and hydropower plants, and the
 * flood front moving down it in step with the simulation clock. Each station lights up as the front passes and shows
 * when (the event's real clock where the chain has one: "09:20 NPT"), the observed arrival beside the modelled one, and
 * the warning lead time against the alert. Beside it a small hydrograph: discharge at the source and at the map's edge
 * against time, with the observed arrivals and peaks as ticks.
 *
 * TIME. The 2-D solver's t = 0 is `offset` seconds of chain time (ChainView.offset), so the front is drawn at chain time
 * offset + simTime — upstream of the map it has always passed by the time the map starts; "Replay upstream" plays the
 * part before the map in a few seconds.
 *
 * COST. The SVG is built once per result (and on resize); afterwards only attributes and a few text nodes change, at
 * most UPDATE_HZ times a second, driven by the ~5 Hz stats stream. No per-frame work, no layout reads per update.
 */
import type { AppState } from '../contracts';
import type { ChainFile } from '../hazard/types';
import { bridgeFor, type ChainView } from './bridge';
import { h, setText, toggleClass, type UIContext } from './dom';
import { icon } from './icons';
import { formatDischarge } from './format';
import {
  bedAt,
  formatLead,
  formatSpan,
  formatWhen,
  frontAt,
  frontTable,
  labelRows,
  leadTime,
  observedFront,
  parseEventClock,
  pathOf,
  profileGeometry,
  shortStationName,
  stationKindLabel,
  stationStates,
  type EventClock,
  type FrontPoint,
  type StationState,
} from './chainTime';
import { clampSensorS, ensureDesign, kindLabel, leadText, newSensor, warningModel, MAX_SENSORS } from './warningModel';

/** Upper bound on timeline updates per second. */
export const UPDATE_HZ = 10;
/** Wall-clock length of "Replay upstream", ms. */
const REPLAY_MS = 7000;
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROFILE_H = 118;
const CHART_W = 210;

type Attrs = Record<string, string | number | null | undefined>;

/** An SVG element with attributes (no markup parsing anywhere: attributes and textContent only). */
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<SVGElement | string | null>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) {
    if (c === null) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/** The stations the timeline draws, in chain order, with their modelled front (s after clock zero). */
interface Row {
  name: string;
  short: string;
  kind: string;
  s: number;
  tFront: number;
  capacityMW?: number;
  observed: number | null;
  observedNote: string | null;
  lead: number | null;
  band: [number, number, number] | null;
}

function rowsOf(view: ChainView, file: ChainFile): Row[] {
  const res = view.result;
  const out: Row[] = file.stations.map((st) => {
    const r = res?.stations.find((x) => x.name === st.name && x.s === st.s) ?? null;
    const tFront = r ? r.tFront : NaN;
    const obs = observedFront(view.spec.observations, st.name);
    return {
      name: st.name,
      short: shortStationName(st),
      kind: st.kind,
      s: st.s,
      tFront: st.kind === 'domainEdge' && res ? res.entryFront : tFront,
      capacityMW: st.capacityMW,
      observed: obs?.tFront ?? null,
      observedNote: obs ? `${obs.note} (${obs.source})` : null,
      lead: leadTime(view.spec.alertTime, tFront),
      band: view.bands?.[st.name]?.tFront ?? null,
    };
  });
  // Two stations at one place (a town and its gauge) share a marker: keep both rows, the chips show both.
  return out;
}

/**
 * The chart's time window [tA, tB], chain s: from 300 s before the earliest of the first outflow, the observed fronts
 * and the modelled front at the map edge, to the entry wave's tail (or the routing's end), at least 10 min wide and
 * past the last observation. Non-finite times are ignored — a flood with no front at the edge (the routing stopped
 * first, or it died out: entryFront NaN) must not turn the whole window, and every path drawn on it, into NaN.
 */
export function chartWindow(o: { starts: readonly number[]; entryFront: number; tPeak: number; tEnd: number; obsFronts: readonly number[] }): [number, number] {
  const early = [...o.starts, o.entryFront].filter(Number.isFinite);
  const tA = early.length ? Math.max(0, Math.min(...early) - 300) : 0;
  const tail = Number.isFinite(o.entryFront) && Number.isFinite(o.tPeak) ? o.tPeak + 1.5 * Math.max(600, o.tPeak - o.entryFront) : o.tEnd;
  const obsLast = Math.max(-Infinity, ...o.obsFronts.filter(Number.isFinite));
  const end = Math.min(Number.isFinite(o.tEnd) ? o.tEnd : Infinity, Number.isFinite(tail) ? tail : Infinity);
  const tB = Math.max(tA + 600, Number.isFinite(end) ? end : tA + 600, obsLast + 300);
  return [tA, tB];
}

export interface ChainTimeline {
  el: HTMLElement;
}

export function createChainTimeline(ctx: UIContext): ChainTimeline {
  const { store, bind } = ctx;
  const bridge = bridgeFor(store);

  let collapsed = false;
  let view: ChainView | null = null;
  let rows: Row[] = [];
  let table: FrontPoint[] = [];
  let clock: EventClock | null = null;
  let sEnd = 0;
  let lastUpdate = -Infinity;
  let pendingTimer = 0;
  let replay: { start: number; from: number; to: number; timer: number } | null = null;

  // ── Dynamic parts (rebuilt with the SVG, then only their attributes change) ──
  let wetClip: SVGRectElement | null = null;
  let frontLine: SVGLineElement | null = null;
  let frontDot: SVGCircleElement | null = null;
  let chartCursor: SVGLineElement | null = null;
  let chartX: ((t: number) => number) | null = null;
  let profileX: ((s: number) => number) | null = null;
  /** Bed y (px) at a chainage, in the current build. */
  let yOf: ((s: number) => number) | null = null;
  let markers: Array<{ g: SVGGElement; row: Row; state: StationState | '' }> = [];
  let chips: Array<{ el: HTMLElement; row: Row; state: StationState | '' }> = [];
  // Early-warning sensors (warningPanel.ts designs them; here they are drawn, placed and dragged on the profile).
  let sensorLayer: SVGGElement | null = null;
  let profileSvg: SVGSVGElement | null = null;
  /** Chainage under a profile x (px), in the current build. */
  let sOfX: ((x: number) => number) | null = null;
  let drag: { id: string; pointer: number; raf: number; s: number } | null = null;
  const ewSpans = new Map<string, HTMLElement>();

  // ── Shell ──
  const title = h('span', { class: 'dl-cl-title' }, 'Valley timeline');
  const sub = h('span', { class: 'dl-cl-sub' });
  const clockText = h('span', { class: 'dl-cl-clock', 'data-tip': 'Event time on the valley timeline', 'data-tip-side': 'top' });
  const frontText = h('span', { class: 'dl-cl-front', role: 'status', 'aria-live': 'off' });
  const alertChip = h('span', { class: 'dl-chip dl-cl-alert', 'data-sev': 'warn', hidden: true });
  const replayBtn = h(
    'button',
    { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm dl-cl-replay', 'data-tip': 'Play the flood’s run down the valley before it reaches the map', 'data-tip-side': 'top', onclick: () => startReplay() },
    icon('play', 14),
    h('span', null, 'Replay upstream'),
  );
  const collapseBtn = h(
    'button',
    { type: 'button', class: 'dl-icon-btn dl-cl-collapse', 'aria-label': 'Collapse the valley timeline', 'aria-expanded': 'true', onclick: () => setCollapsed(!collapsed) },
    icon('chevronDown', 16),
  );
  const head = h('div', { class: 'dl-cl-head' }, h('span', { class: 'dl-cl-icon' }, icon('mountain', 15)), title, sub, h('span', { class: 'dl-flex' }), frontText, clockText, alertChip, replayBtn, collapseBtn);
  const status = h('div', { class: 'dl-cl-status', role: 'status' });
  const profileHost = h('div', { class: 'dl-cl-profile' });
  const chartHost = h('div', { class: 'dl-cl-chart' });
  const plots = h('div', { class: 'dl-cl-plots' }, profileHost, chartHost);
  const chipRow = h('div', { class: 'dl-cl-chips', role: 'list', 'aria-label': 'Stations down the valley' });
  const body = h('div', { class: 'dl-cl-body' }, status, plots, chipRow);
  const el = h('section', { class: 'dl-chainline dl-glass', 'aria-label': 'Valley timeline: the flood’s run from the source to the map', hidden: true }, head, body);

  function setCollapsed(c: boolean) {
    collapsed = c;
    toggleClass(el, 'dl-collapsed', c);
    collapseBtn.setAttribute('aria-expanded', String(!c));
    collapseBtn.setAttribute('aria-label', c ? 'Expand the valley timeline' : 'Collapse the valley timeline');
  }

  // ── Build ──
  function build() {
    profileHost.replaceChildren();
    chartHost.replaceChildren();
    chipRow.replaceChildren();
    markers = [];
    chips = [];
    wetClip = frontLine = frontDot = chartCursor = null;
    chartX = profileX = yOf = null;
    sensorLayer = profileSvg = null;
    sOfX = null;
    ewSpans.clear();
    const v = view;
    const file = v?.file ?? null;
    el.hidden = !v;
    if (!v) return;
    setText(sub, file ? file.name : '');
    clock = parseEventClock(file?.clockZero);
    const alert = v.spec.alertTime;
    alertChip.hidden = alert === undefined || !Number.isFinite(alert);
    if (!alertChip.hidden) {
      setText(alertChip, `Alert ${formatWhen(clock, alert!)}`);
      alertChip.dataset.tip = 'When the first warning went out (the 2026 SMS alerts); each station’s warning time counts from here';
    }
    plots.hidden = !file || !v.result;
    chipRow.hidden = !file || !v.result;
    replayBtn.hidden = !v.result;
    if (!file || !v.result) return;
    rows = rowsOf(v, file);
    sEnd = file.s[file.s.length - 1];
    table = frontTable([
      ...rows.map((r) => ({ s: r.s, t: r.tFront })),
      { s: file.domainEntry.s, t: v.result.entryFront },
      // The front leaves the source at its first outflow.
      { s: v.result.sourceInfo.s, t: firstFlow(v) },
    ]);
    buildProfile(v, file);
    buildChart(v, file);
    buildChips();
    drawSensors();
    lastUpdate = -Infinity;
    update(true);
  }

  /** First time the source puts out a flood (Q above 1 % of its peak). */
  function firstFlow(v: ChainView): number {
    const { t, q, peak } = v.result!.source;
    for (let i = 0; i < q.length; i++) if (q[i] > 0.01 * peak) return t[i];
    return NaN;
  }

  function buildProfile(v: ChainView, file: ChainFile) {
    const W = Math.max(280, Math.round(profileHost.clientWidth || 520));
    const H = PROFILE_H;
    const box = { x0: 8, x1: W - 8, y0: 30, y1: H - 22 };
    const g = profileGeometry(file.s, file.zBed, box);
    profileX = g.x;
    yOf = (s: number) => g.y(bedAt(file.s, file.zBed, s));
    const bed = pathOf(g.points);
    const area = `${bed} L${r1(box.x1)} ${H - 14} L${r1(box.x0)} ${H - 14} Z`;
    const entryX = g.x(file.domainEntry.s);
    const root = svg('svg', { class: 'dl-cl-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Long profile of ${file.name}: ${Math.round(g.zMax)} m at the source to ${Math.round(g.zMin)} m` });
    const clipId = `dl-cl-wet-${Math.random().toString(36).slice(2, 8)}`;
    wetClip = svg('rect', { x: 0, y: 0, width: 0, height: H });
    root.append(
      svg('defs', {}, svg('clipPath', { id: clipId }, wetClip)),
      // The part of the valley inside the 2-D map.
      svg('rect', { class: 'dl-cl-map', x: r1(entryX), y: 4, width: r1(Math.max(0, box.x1 - entryX + 8)), height: H - 18, rx: 4 }),
      svg('text', { class: 'dl-cl-maplabel', x: r1(box.x1), y: 48, 'text-anchor': 'end' }, '2-D MAP'),
      svg('path', { class: 'dl-cl-ground', d: area }),
      svg('path', { class: 'dl-cl-bed', d: bed }),
      svg('path', { class: 'dl-cl-wet', d: bed, 'clip-path': `url(#${clipId})` }),
      // Distance axis: km from the source at the ends.
      svg('text', { class: 'dl-cl-axis', x: box.x0, y: H - 3 }, `${Math.round(g.zMax).toLocaleString('en-US')} m`),
      svg('text', { class: 'dl-cl-axis', x: box.x1, y: H - 3, 'text-anchor': 'end' }, `${Math.round((sEnd - file.s[0]) / 1000)} km · ${Math.round(bedAt(file.s, file.zBed, sEnd))} m`),
    );
    // Stations: a marker on the bed, the label above in one of three rows.
    const xs = rows.map((r) => g.x(r.s));
    const widths = rows.map((r) => 6 * r.short.length + 6);
    // Labels that do not fit are dropped, least important first: the map edge and towns before plants and gauges, and
    // a second station at one place (a town's gauge) never gets its own.
    const rank: Record<string, number> = { domainEdge: 0, source: 1, lake: 1, town: 2, hydro: 3, bridge: 4, gauge: 5 };
    const priority = rows.map((r, i) => (rows.findIndex((o) => Math.abs(g.x(o.s) - xs[i]) < 1) < i ? Infinity : rank[r.kind] ?? 6));
    const lane = labelRows(xs, widths, 3, priority, W);
    rows.forEach((row, i) => {
      const x = xs[i];
      const y = g.y(bedAt(file.s, file.zBed, row.s));
      const ly = 12 + Math.max(0, lane[i]) * 11;
      const lx = Math.min(W - widths[i] / 2, Math.max(widths[i] / 2, x));
      const grp = svg(
        'g',
        { class: `dl-cl-st dl-cl-st-${row.kind}`, 'data-tip': stationTip(row), 'data-tip-side': 'top' },
        lane[i] >= 0 ? svg('line', { class: 'dl-cl-stem', x1: r1(x), x2: r1(x), y1: r1(ly + 2), y2: r1(y - 4) }) : null,
        row.kind === 'hydro'
          ? svg('rect', { class: 'dl-cl-mark', x: r1(x - 4.5), y: r1(y - 4.5), width: 9, height: 9, rx: 2 })
          : row.kind === 'domainEdge'
            ? svg('path', { class: 'dl-cl-mark', d: `M${r1(x)} ${r1(y - 6)} L${r1(x + 5.5)} ${r1(y + 3)} L${r1(x - 5.5)} ${r1(y + 3)} Z` })
            : svg('circle', { class: 'dl-cl-mark', cx: r1(x), cy: r1(y), r: 4.5 }),
        lane[i] >= 0 ? svg('text', { class: 'dl-cl-label', x: r1(lx), y: r1(ly), 'text-anchor': 'middle' }, row.short) : null,
      );
      root.append(grp);
      markers.push({ g: grp, row, state: '' });
    });
    sOfX = (px: number) => file.s[0] + ((px - box.x0) / Math.max(1, box.x1 - box.x0)) * (sEnd - file.s[0]);
    sensorLayer = svg('g', { class: 'dl-cl-sensors' });
    root.append(sensorLayer);
    profileSvg = root;
    root.addEventListener('pointerdown', onProfileDown);
    root.addEventListener('pointermove', onProfileMove);
    root.addEventListener('pointerup', onProfileUp);
    root.addEventListener('pointercancel', onProfileUp);
    frontLine = svg('line', { class: 'dl-cl-frontline', x1: 0, x2: 0, y1: 20, y2: H - 14 });
    frontDot = svg('circle', { class: 'dl-cl-frontdot', cx: 0, cy: 0, r: 5 });
    root.append(frontLine, frontDot);
    profileHost.append(root);
  }

  function buildChart(v: ChainView, file: ChainFile) {
    const res = v.result!;
    const W = CHART_W;
    const H = PROFILE_H;
    const box = { x0: 6, x1: W - 6, y0: 16, y1: H - 30 };
    // Time window: from the first outflow (or the earliest observation on the profile) to the entry wave's tail.
    const onProfile = new Set(file.stations.map((s) => s.name));
    const obs = (v.spec.observations ?? []).filter((o) => onProfile.has(o.station));
    const obsFronts = obs.map((o) => o.tFront ?? NaN);
    const tPeak = res.entry.reduce((m, p) => (p.q > m.q ? p : m), res.entry[0] ?? { t: 0, q: 0 });
    const [tA, tB] = chartWindow({ starts: [firstFlow(v), ...obsFronts], entryFront: res.entryFront, tPeak: tPeak.t, tEnd: res.routing.tEnd, obsFronts });
    const obsPeak = obs.reduce((m, o) => Math.max(m, o.qPeak ?? 0), 0);
    const yMax = Math.max(1, res.entryPeak, obsPeak) * 1.25;
    const x = (t: number) => box.x0 + ((t - tA) / (tB - tA)) * (box.x1 - box.x0);
    const y = (q: number) => box.y1 - (Math.min(q, yMax) / yMax) * (box.y1 - box.y0);
    chartX = x;
    const series = (ts: ArrayLike<number>, qs: ArrayLike<number>) => {
      // Max per pixel column: a 60-second impulse must not vanish between samples.
      const cols = new Map<number, number>();
      for (let i = 0; i < ts.length; i++) {
        const t = ts[i];
        if (t < tA || t > tB) continue;
        const c = Math.round(x(t));
        cols.set(c, Math.max(cols.get(c) ?? 0, qs[i]));
      }
      const pts = [...cols.entries()].sort((a, b) => a[0] - b[0]).map(([c, q]) => [c, y(q)] as [number, number]);
      return pts.length ? pathOf(pts) : '';
    };
    const srcPath = series(res.source.t, res.source.q);
    const entryPath = series(
      res.entry.map((p) => p.t),
      res.entry.map((p) => p.q),
    );
    const root = svg('svg', { class: 'dl-cl-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Discharge at the source and at the map edge; peak at the map edge ${formatDischarge(res.entryPeak)}` });
    root.append(
      svg('line', { class: 'dl-cl-base', x1: box.x0, x2: box.x1, y1: box.y1, y2: box.y1 }),
      svg('path', { class: 'dl-cl-q-src', d: srcPath }),
      svg('path', { class: 'dl-cl-q-entry', d: entryPath }),
      svg('text', { class: 'dl-cl-axis', x: box.x0, y: 10 }, `Q · peak at map edge ${formatDischarge(res.entryPeak)}`),
    );
    if (res.source.peak > yMax) {
      root.append(svg('text', { class: 'dl-cl-axis dl-cl-off', x: r1(Math.min(box.x1 - 50, Math.max(box.x0 + 50, x(res.source.tPeak)))), y: box.y0 + 10, 'text-anchor': 'middle' }, `source ${formatDischarge(res.source.peak)} ↑`));
    }
    if (obsPeak > 0) {
      const o = obs.find((x) => x.qPeak === obsPeak)!;
      const yy = r1(y(obsPeak));
      root.append(
        svg(
          'g',
          { class: 'dl-cl-obspeak', 'data-tip': `${o.station}: peak ${formatDischarge(obsPeak)} — ${o.note}`, 'data-tip-side': 'top' },
          svg('line', { x1: box.x0, x2: box.x1, y1: yy, y2: yy }),
          // The scenarios' "observed" peaks are sometimes reconstructions (no gauge survived): the note says which.
          svg('text', { class: 'dl-cl-axis', x: box.x1, y: yy - 3, 'text-anchor': 'end' }, `${o.station} ${formatDischarge(obsPeak)} (${/MODELLED|reconstruct/i.test(o.note) ? 'reconstr.' : 'obs.'})`),
        ),
      );
    }
    // Arrival ticks under the chart: modelled (filled) and observed (open) at each station with an observation, and
    // the modelled arrival at the map edge.
    const lane = box.y1 + 9;
    const tick = (t: number, cls: string, tip: string) => {
      if (!Number.isFinite(t) || t < tA || t > tB) return;
      const xx = r1(x(t));
      root.append(svg('g', { class: cls, 'data-tip': tip, 'data-tip-side': 'top' }, svg('path', { d: `M${xx} ${lane - 5} L${xx + 4} ${lane + 2} L${xx - 4} ${lane + 2} Z` })));
    };
    tick(res.entryFront, 'dl-cl-tick dl-cl-tick-entry', `Modelled: the front reaches the map edge at ${formatWhen(clock, res.entryFront)}`);
    for (const o of obs) {
      const row = rows.find((r) => r.name === o.station);
      if (o.tFront === undefined) continue;
      tick(o.tFront, 'dl-cl-tick dl-cl-tick-obs', `Observed: ${o.station} at ${formatWhen(clock, o.tFront)} — ${o.note}`);
      if (row) tick(row.tFront, 'dl-cl-tick dl-cl-tick-mod', `Modelled: ${o.station} at ${formatWhen(clock, row.tFront)}`);
    }
    root.append(
      svg('text', { class: 'dl-cl-axis', x: box.x0, y: H - 3 }, formatWhen(clock, tA)),
      svg('text', { class: 'dl-cl-axis', x: box.x1, y: H - 3, 'text-anchor': 'end' }, formatWhen(clock, tB)),
    );
    chartCursor = svg('line', { class: 'dl-cl-cursor', x1: 0, x2: 0, y1: box.y0 - 4, y2: box.y1 + 12 });
    root.append(chartCursor);
    const legend = h(
      'div',
      { class: 'dl-cl-legend' },
      h('span', { class: 'dl-cl-key dl-cl-key-src' }, 'source'),
      h('span', { class: 'dl-cl-key dl-cl-key-entry' }, 'map edge'),
      obs.some((o) => o.tFront !== undefined) ? h('span', { class: 'dl-cl-key dl-cl-key-obs' }, 'observed') : null,
    );
    chartHost.append(root, legend);
  }

  function stationTip(row: Row): string {
    const parts = [`${row.name} — ${stationKindLabel({ kind: row.kind as never, capacityMW: row.capacityMW })}`];
    parts.push(Number.isFinite(row.tFront) ? `modelled front ${formatWhen(clock, row.tFront)}` : 'the modelled flood does not reach it');
    if (row.band && Number.isFinite(row.band[0])) parts.push(`p10–p90 ${formatWhen(clock, row.band[0])}–${Number.isFinite(row.band[2]) ? formatWhen(clock, row.band[2]) : 'never'}`);
    if (row.observed !== null) parts.push(`observed ${formatWhen(clock, row.observed)}`);
    if (row.lead !== null) parts.push(`warning ${formatLead(row.lead)}`);
    return parts.join(' · ');
  }

  function buildChips() {
    for (const row of rows) {
      if (row.kind === 'source' || row.kind === 'lake') continue;
      const time = h('span', { class: 'dl-cl-chip-time' }, Number.isFinite(row.tFront) ? formatWhen(clock, row.tFront) : 'not reached');
      const extra: HTMLElement[] = [];
      if (row.observed !== null) extra.push(h('span', { class: 'dl-cl-chip-obs', 'data-tip': row.observedNote ?? '', 'data-tip-side': 'top' }, `obs ${formatWhen(clock, row.observed)}`));
      if (row.lead !== null) {
        extra.push(h('span', { class: `dl-cl-chip-lead${row.lead < 10 * 60 ? ' dl-short' : ''}` }, row.lead < 0 ? 'no warning' : `warning ${formatSpan(row.lead)}`));
      }
      const kindLine = row.kind === 'hydro' && row.capacityMW ? `${row.capacityMW} MW` : row.kind === 'domainEdge' ? 'map edge' : row.kind;
      const chip = h(
        'div',
        { class: `dl-cl-chipbox dl-cl-chip-${row.kind}`, role: 'listitem', 'data-tip': stationTip(row), 'data-tip-side': 'top', 'data-station': row.name },
        h('span', { class: 'dl-cl-chip-name' }, row.short),
        h('span', { class: 'dl-cl-chip-kind' }, kindLine),
        time,
        ...extra,
      );
      const ew = h('span', { class: 'dl-cl-chip-ew', hidden: true });
      chip.append(ew);
      ewSpans.set(row.name, ew);
      chipRow.append(chip);
      chips.push({ el: chip, row, state: '' });
    }
  }

  // ── Update (≤ UPDATE_HZ) ──
  function chainTime(s: AppState): number {
    if (replay) return replay.from + Math.min(1, (performance.now() - replay.start) / REPLAY_MS) * (replay.to - replay.from);
    return (view?.offset ?? 0) + (s.stats?.simTime ?? 0);
  }

  function update(force = false) {
    const now = performance.now();
    if (!force && now - lastUpdate < 1000 / UPDATE_HZ) {
      // Coalesce: one trailing update so the last state is always drawn.
      if (!pendingTimer) pendingTimer = window.setTimeout(() => ((pendingTimer = 0), update(true)), 1000 / UPDATE_HZ);
      return;
    }
    lastUpdate = now;
    const v = view;
    if (!v) return;
    const s = store.get();
    const t = chainTime(s);
    setText(clockText, v.file ? `${formatWhen(clock, t)}${replay ? ' · replay' : ''}` : '');
    toggleClass(el, 'dl-replaying', !!replay);
    if (v.status === 'loading' || v.status === 'running') {
      setText(status, v.status === 'loading' ? 'Loading the valley profile…' : 'Routing the flood wave down the valley…');
      status.hidden = false;
    } else if (v.status === 'error') {
      setText(status, `The upstream chain could not run: ${v.error ?? 'unknown error'}`);
      status.hidden = false;
    } else status.hidden = true;
    if (!v.result || !profileX) {
      setText(frontText, '');
      return;
    }
    const front = frontAt(table, t, sEnd);
    const x = front === null ? null : profileX(front);
    wetClip?.setAttribute('width', String(x === null ? 0 : r1(x)));
    const fx = x === null ? -20 : r1(x);
    frontLine?.setAttribute('x1', String(fx));
    frontLine?.setAttribute('x2', String(fx));
    if (frontDot && yOf) {
      frontDot.setAttribute('cx', String(fx));
      frontDot.setAttribute('cy', String(front === null ? 0 : r1(yOf(front))));
    }
    toggleClass(el, 'dl-has-front', x !== null);
    const states = stationStates(
      rows.map((r) => r.tFront),
      t,
    );
    markers.forEach((m, i) => {
      if (m.state !== states[i]) {
        m.state = states[i];
        m.g.setAttribute('class', `dl-cl-st dl-cl-st-${m.row.kind} dl-cl-${states[i]}`);
      }
    });
    for (const c of chips) {
      const st = states[rows.indexOf(c.row)];
      if (c.state !== st) {
        if (c.state) c.el.classList.remove(`dl-cl-${c.state}`);
        c.el.classList.add(`dl-cl-${st}`);
        c.state = st;
      }
    }
    if (chartCursor && chartX) {
      const cx = r1(chartX(t));
      chartCursor.setAttribute('x1', String(cx));
      chartCursor.setAttribute('x2', String(cx));
    }
    setText(frontText, frontSummary(v, t, front, states));
  }

  /** "Front at Syafrubesi · 24 km to the map" / "Waiting: the avalanche dam fills" / "In the map". */
  function frontSummary(v: ChainView, t: number, front: number | null, states: StationState[]): string {
    const file = v.file!;
    if (front === null) {
      const tf = table[0]?.t;
      if (!Number.isFinite(tf)) return 'The modelled flood does not leave the source';
      return `Release in ${formatSpan(tf - t)}${v.result?.sourceInfo.dam ? ' (the avalanche dam fills)' : ''}`;
    }
    if (front >= file.domainEntry.s) return 'Flood front in the map';
    const last = rows.filter((r, i) => states[i] === 'passed').pop();
    const km = (file.domainEntry.s - front) / 1000;
    return `${last ? `Past ${last.short} · ` : ''}${km >= 10 ? Math.round(km) : km.toFixed(1)} km to the map`;
  }

  function startReplay() {
    const v = view;
    if (!v?.result || !table.length) return;
    stopReplay();
    const from = Math.max(0, table[0].t - 60);
    const to = Math.max(from + 60, v.offset + (store.get().stats?.simTime ?? 0));
    replay = { start: performance.now(), from, to, timer: 0 };
    replay.timer = window.setInterval(() => {
      if (!replay) return;
      if (performance.now() - replay.start >= REPLAY_MS) stopReplay();
      update(true);
    }, 1000 / UPDATE_HZ);
    update(true);
  }

  function stopReplay() {
    if (!replay) return;
    clearInterval(replay.timer);
    replay = null;
    update(true);
  }

  // ── Early-warning sensors on the profile ──
  /** Profile x (px) of a pointer event. */
  function localX(e: PointerEvent): number {
    const r = profileSvg!.getBoundingClientRect();
    const vb = profileSvg!.viewBox.baseVal;
    return ((e.clientX - r.left) / Math.max(1, r.width)) * (vb?.width || r.width);
  }

  function onProfileDown(e: PointerEvent) {
    const v = view;
    if (!v || !sOfX || !profileSvg) return;
    const d = ensureDesign(bridge, v);
    const m = warningModel(v, d);
    if (!m) return;
    const hit = (e.target as Element | null)?.closest?.('[data-sensor]');
    if (hit) {
      const id = hit.getAttribute('data-sensor')!;
      const sn = d.sensors.find((x) => x.id === id);
      if (!sn) return;
      drag = { id, pointer: e.pointerId, raf: 0, s: sn.s };
      profileSvg.setPointerCapture?.(e.pointerId);
      profileHost.classList.add('dl-cl-dragging');
      e.preventDefault();
      return;
    }
    if (!d.placing || d.sensors.length >= MAX_SENSORS) return;
    const s = clampSensorS(m, sOfX(localX(e)));
    bridge.setWarning({ ...d, sensors: [...d.sensors, newSensor(s, d.presetId)], placing: false });
    e.preventDefault();
  }

  function onProfileMove(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer || !sOfX || !view) return;
    const m = warningModel(view, bridge.warning);
    if (!m) return;
    drag.s = clampSensorS(m, sOfX(localX(e)));
    if (drag.raf) return;
    drag.raf = requestAnimationFrame(() => {
      if (!drag) return;
      drag.raf = 0;
      const d = bridge.warning;
      if (d) bridge.setWarning({ ...d, sensors: d.sensors.map((x) => (x.id === drag!.id ? { ...x, s: drag!.s } : x)) });
    });
  }

  function onProfileUp(e: PointerEvent) {
    if (!drag || e.pointerId !== drag.pointer) return;
    const { id, s, raf } = drag;
    cancelAnimationFrame(raf);
    drag = null;
    profileHost.classList.remove('dl-cl-dragging');
    const d = bridge.warning;
    if (d) bridge.setWarning({ ...d, sensors: d.sensors.map((x) => (x.id === id ? { ...x, s } : x)) });
  }

  /** Draw the design's sensors on the profile and their lead times on the chips. */
  function drawSensors() {
    const v = view;
    const d = v && v.file && v.result ? ensureDesign(bridge, v) : null;
    toggleClass(profileHost, 'dl-cl-placing', !!d?.placing);
    profileHost.title = d?.placing ? 'Click to place the sensor' : '';
    if (!sensorLayer || !profileX || !yOf || !d) return;
    const m = warningModel(v, d);
    sensorLayer.replaceChildren();
    d.sensors.forEach((sn, i) => {
      const x = r1(profileX!(sn.s));
      const y = r1(yOf!(sn.s));
      const first = m?.combined.sensor === i;
      sensorLayer!.append(
        svg(
          'g',
          { class: `dl-cl-sensor${first ? ' dl-cl-sensor-first' : ''}`, 'data-sensor': sn.id, 'data-tip': `${kindLabel(sn.kind)} ${i + 1} · km ${(sn.s / 1000).toFixed(1)} · drag to move`, 'data-tip-side': 'top' },
          svg('line', { class: 'dl-cl-sensor-stem', x1: x, x2: x, y1: y - 14, y2: y }),
          svg('path', { class: 'dl-cl-sensor-mark', d: `M${x} ${y - 27} L${x + 6.5} ${y - 20.5} L${x} ${y - 14} L${x - 6.5} ${y - 20.5} Z` }),
          svg('text', { class: 'dl-cl-sensor-num', x, y: y - 17.5, 'text-anchor': 'middle' }, String(i + 1)),
          svg('circle', { class: 'dl-cl-sensor-hit', cx: x, cy: y - 16, r: 11 }),
        ),
      );
    });
    for (const [name, span] of ewSpans) {
      const k = m ? m.targets.findIndex((t) => t.name === name) : -1;
      const show = !!m && d.sensors.length > 0 && k >= 0;
      span.hidden = !show;
      if (show) {
        // The chip's own "warning" line is the existing alert; this is what the sensors alone would give.
        const lead = (m!.sensorsOnly ?? m!.combined).leads[k].lead;
        setText(span, `sensors: ${leadText(lead)}`);
        span.dataset.sev = lead === Infinity || lead >= 1800 ? 'ok' : lead >= 600 ? 'tight' : 'short';
      }
    }
  }

  // ── Wiring ──
  const rebuild = () => build();
  ctx.own(
    bridge.chainChanged.on((c) => {
      const prev = view;
      view = c;
      if (c?.sceneKey !== prev?.sceneKey) stopReplay();
      // Rebuild when the run, its bands (the tooltips show them), the profile or the clock offset change; a status or
      // progress change only updates.
      if (!c || !prev || c.sceneKey !== prev.sceneKey || c.result !== prev.result || c.file !== prev.file || c.bands !== prev.bands || c.offset !== prev.offset) rebuild();
      update(true);
    }),
  );
  ctx.own(bridge.warningChanged.on(() => drawSensors()));
  ctx.own(() => {
    stopReplay();
    clearTimeout(pendingTimer);
  });
  bind(
    (s) => s.stats?.simTime ?? 0,
    () => update(),
  );
  // Width changes (window, panel open/close) rebuild the SVG; coalesced to one rebuild per animation frame.
  if (typeof ResizeObserver !== 'undefined') {
    let w = 0;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      const nw = Math.round(profileHost.clientWidth);
      if (!nw || nw === w) return;
      w = nw;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (view?.result) rebuild();
      });
    });
    ro.observe(profileHost);
    ctx.own(() => ro.disconnect());
  }
  view = bridge.chain;
  build();
  return { el };
}
