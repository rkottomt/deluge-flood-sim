/**
 * The "Early warning" block of the Hazard chain panel section: design where the flood is detected and how fast the
 * alert gets out, and see how many minutes each town, bridge and hydropower plant would get.
 *
 *   • the scenario's own alert as the baseline (Nepal 2026: the SMS at 09:15 NPT),
 *   • sensors — added with "Add sensor" (then a click on the valley timeline's profile places it; drag it there to
 *     move it), each with its detection and alert latency (presets: automated gauge + SMS 2 min … manual relay 15 min),
 *   • per-station lead-time chips that update live, with the ensemble's p10 (the early-front members),
 *   • "Suggest best site": the optimiser (src/hazard/warning.ts bestSite) places one sensor,
 *   • a small chart: lead time at one station against where a single sensor sits.
 *
 * The numbers are MODEL front times; the caveats under the block say what that leaves out. The design lives on the UI
 * bridge (WarningDesign) so the timeline can draw and drag the same sensors. All text goes through textContent.
 */
import type { Sensor } from '../hazard/warning';
import { LATENCY_PRESETS } from '../hazard/warning';
import { bridgeFor, type ChainView, type WarningDesign } from './bridge';
import { h, setText, toggleClass, type UIContext } from './dom';
import { button, segmented } from './controls';
import { fmtNum } from './format';
import { formatSpan, formatWhen, parseEventClock, type EventClock } from './chainTime';
import {
  MAX_SENSORS,
  bedElevation,
  chartTarget,
  curveFor,
  ensureDesign,
  kindLabel,
  leadSev,
  leadText,
  newSensor,
  observedLead,
  presetById,
  suggestSite,
  warningModel,
  whereLabel,
  type WarningModel,
} from './warningModel';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_W = 300;
const CHART_H = 110;

type Attrs = Record<string, string | number | null | undefined>;
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Array<SVGElement | string | null>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const c of children) if (c !== null) el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  return el;
}
const r1 = (v: number) => Math.round(v * 10) / 10;

const ELEVATION_LIMITS: Array<{ v: number | null; label: string }> = [
  { v: null, label: 'anywhere on the profile' },
  { v: 3000, label: 'bed ≤ 3,000 m' },
  { v: 2500, label: 'bed ≤ 2,500 m' },
  { v: 2000, label: 'bed ≤ 2,000 m' },
  { v: 1500, label: 'bed ≤ 1,500 m' },
];

export function createWarningBlock(ctx: UIContext): { el: HTMLElement } {
  const bridge = bridgeFor(ctx.store);
  let view: ChainView | null = null;
  let clock: EventClock | null = null;
  let suggestion: string | null = null;

  const design = (): WarningDesign | null => (view ? ensureDesign(bridge, view) : null);
  const patch = (p: Partial<WarningDesign>) => {
    const d = design();
    if (d) bridge.setWarning({ ...d, ...p });
  };

  // ── Controls ──
  const presetSel = h(
    'select',
    {
      class: 'dl-num-input dl-ew-preset',
      'aria-label': 'Sensor and alert chain for new sensors',
      onchange: () => patch({ presetId: presetSel.value }),
    },
    ...LATENCY_PRESETS.map((p) => h('option', { value: p.id }, `${p.label} · ${formatSpan(p.detectionLatency + p.alertLatency)}`)),
  );
  const presetNote = h('div', { class: 'dl-ew-note' });
  const addBtn = button('Add sensor', () => togglePlacing(), {
    icon: 'plus',
    tip: 'Then click the valley profile in the timeline to place it (drag it there to move it)',
    className: 'dl-btn-sm dl-ew-add',
  });
  const suggestBtn = button('Suggest best site', () => suggest(), {
    icon: 'spark',
    tip: 'Place one sensor where it gives the most warning (by the objective below), within the access limit',
    className: 'dl-btn-sm dl-ew-suggest',
  });
  const clearBtn = button('', () => patch({ sensors: [], placing: false }), { icon: 'trash', tip: 'Remove every sensor', ariaLabel: 'Remove every sensor', className: 'dl-btn-sm dl-ew-clear' });
  const placingHint = h('div', { class: 'dl-ew-hint', role: 'status' });
  const sensorList = h('div', { class: 'dl-ew-sensors', role: 'list', 'aria-label': 'Sensors' });
  const objectiveSeg = segmented<'maxMin' | 'weighted'>(
    [
      { value: 'maxMin', label: 'Worst-off place', tip: 'Maximise the smallest lead time over the towns, bridges and plants' },
      { value: 'weighted', label: 'Weighted', tip: 'Maximise the weighted mean lead time: 1 per town or bridge, capacity ÷ 100 MW per hydropower plant (illustrative — no population data on the profile)' },
    ],
    (v) => patch({ objective: v }),
    { label: 'What the suggestion maximises', className: 'dl-seg-full', tipSide: 'top' },
  );
  const elevSel = h(
    'select',
    {
      class: 'dl-num-input dl-ew-elev',
      'aria-label': 'Highest site a sensor may go (access)',
      onchange: () => patch({ maxElevation: elevSel.value === '' ? null : Number(elevSel.value) }),
    },
    ...ELEVATION_LIMITS.map((o) => h('option', { value: o.v === null ? '' : String(o.v) }, o.label)),
  );
  const suggestText = h('div', { class: 'dl-ew-suggestion', role: 'status', 'aria-live': 'polite' });
  const baselineRow = h('div', { class: 'dl-ew-baseline' });
  const chips = h('div', { class: 'dl-ew-chips', role: 'list', 'aria-label': 'Warning time per place' });
  const chartTargetSel = h('select', { class: 'dl-num-input dl-ew-target', 'aria-label': 'Station the chart is about', onchange: () => patch({ target: chartTargetSel.value }) });
  const chartHost = h('div', { class: 'dl-ew-chart' });
  const observedRow = h('div', { class: 'dl-ew-observed' });
  const caveats = h(
    'ul',
    { class: 'dl-ew-caveats' },
    h('li', null, 'These are the chain’s MODEL front times, not observations — where the model is slow or fast, so are these minutes.'),
    h('li', null, 'Sensors fail in the events they are for: the Syafrubesi gauge stopped transmitting at 08:50 on 26 Aug 2026 and was swept away. A gauge only counts if it sends before it dies; a trip-wire works once.'),
    h('li', null, 'Lead time is not evacuation: people must receive the alert, believe it and act, and have somewhere higher to go. At night, in rain, or for workers in a powerhouse tunnel, minutes go fast.'),
    h('li', null, 'A seismic network hears a large mass movement as it happens (Lirung 2026: USGS M 5.2 landslide signal at 08:37), but says “something big moved”, not “a flood is coming” — someone has to decide.'),
  );

  const el = h(
    'div',
    { class: 'dl-ew', 'data-ew': 'block' },
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Early warning'), h('span', { class: 'dl-prov dl-prov-modelled', 'data-tip': 'Lead times from the chain’s modelled front times', 'data-tip-side': 'left' }, 'modelled')),
    h('p', { class: 'dl-ew-intro' }, 'Where the flood is detected, and how fast the alert gets out, decides how many minutes each place gets.'),
    baselineRow,
    h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'New sensor and alert chain'), presetSel),
    presetNote,
    h('div', { class: 'dl-row dl-ew-actions' }, addBtn, suggestBtn, h('span', { class: 'dl-flex' }), clearBtn),
    placingHint,
    sensorList,
    chips,
    observedRow,
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Best site for one sensor')),
    objectiveSeg.el,
    h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Highest site (access: road, power, signal)'), elevSel),
    suggestText,
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Lead time vs sensor position')),
    chartTargetSel,
    chartHost,
    caveats,
  );

  function togglePlacing() {
    const d = design();
    if (!d) return;
    if (!d.placing && d.sensors.length >= MAX_SENSORS) return;
    patch({ placing: !d.placing });
  }

  function suggest() {
    const d = design();
    const m = warningModel(view, d);
    if (!d || !m) return;
    const best = suggestSite(m, d);
    if (!Number.isFinite(best.s)) {
      suggestion = 'No site meets the access limit on this profile.';
      render();
      return;
    }
    const z = bedElevation(m.file, best.s);
    const p = presetById(d.presetId);
    const objective = d.objective === 'maxMin' ? 'the worst-off place gets' : 'weighted mean';
    suggestion = `${p.kind === 'seismic' && m.input.seismicTrigger ? 'Anywhere (a seismic network hears the event itself): ' : ''}${whereLabel(m.file, best.s)} (bed ${fmtNum(z, 0)} m) — ${objective} ${leadText(best.value)}. ${
      d.maxElevation === null ? 'On model times the furthest-upstream site always wins; what limits it in practice is access and survival.' : ''
    }`;
    const sensors = [...d.sensors.filter((x) => x.id !== 'best'), { ...newSensor(best.s, d.presetId), id: 'best' }];
    bridge.setWarning({ ...d, sensors: sensors.slice(-MAX_SENSORS), placing: false });
  }

  function setSensor(id: string, p: Partial<Sensor>) {
    const d = design();
    if (!d) return;
    patch({ sensors: d.sensors.map((x) => (x.id === id ? { ...x, ...p } : x)) });
  }

  function minutesInput(label: string, value: number, onSet: (s: number) => void): HTMLElement {
    const input = h('input', {
      type: 'number',
      class: 'dl-num-input',
      min: 0,
      max: 240,
      step: 0.5,
      inputmode: 'decimal',
      value: String(Math.round((value / 60) * 10) / 10),
      'aria-label': label,
      onchange: () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && v >= 0) onSet(Math.min(240, v) * 60);
      },
    });
    return h('label', { class: 'dl-num-field dl-ew-lat' }, h('span', { class: 'dl-num-label' }, label), h('span', { class: 'dl-num-wrap' }, input, h('span', { class: 'dl-num-unit' }, 'min')));
  }

  function renderSensors(m: WarningModel, d: WarningDesign) {
    sensorList.replaceChildren(
      ...d.sensors.map((sn, i) => {
        const first = m.combined.sensor === i;
        const label = `${kindLabel(sn.kind)} ${i + 1}`;
        const seismicAnywhere = sn.kind === 'seismic' && m.input.seismicTrigger;
        return h(
          'div',
          { class: `dl-ew-sensor${first ? ' dl-ew-first' : ''}`, role: 'listitem', 'data-sensor': sn.id },
          h('div', { class: 'dl-ew-sensor-head' }, h('span', { class: 'dl-ew-dot' }, String(i + 1)), h('b', null, label), h('span', { class: 'dl-ew-where' }, seismicAnywhere ? 'hears the event itself' : whereLabel(m.file, sn.s)), first ? h('span', { class: 'dl-ew-tag' }, 'alerts first') : null, button('', () => patch({ sensors: d.sensors.filter((x) => x.id !== sn.id) }), { icon: 'close', ariaLabel: `Remove ${label}`, className: 'dl-btn-sm dl-ew-remove' })),
          h(
            'div',
            { class: 'dl-ew-sensor-lat' },
            minutesInput('Detect', sn.detectionLatency, (v) => setSensor(sn.id, { detectionLatency: v })),
            minutesInput('Alert out', sn.alertLatency, (v) => setSensor(sn.id, { alertLatency: v })),
          ),
        );
      }),
    );
  }

  function renderChips(m: WarningModel) {
    chips.replaceChildren(
      ...m.targets.map((t, i) => {
        const lead = m.combined.leads[i].lead;
        const base = m.baseLeads?.[i].lead;
        const own = m.sensorsOnly?.leads[i].lead;
        const band = m.bands?.[i];
        const sev = leadSev(lead);
        const num = (v: number) => (Number.isFinite(v) ? String(Math.round(v)) : String(v));
        const tipParts = [`${t.name}: modelled front ${formatWhen(clock, t.tFront)}`];
        if (own !== undefined) tipParts.push(`the sensors alone: ${leadText(own)}`);
        if (base !== undefined) tipParts.push(`the existing alert alone: ${leadText(base)}`);
        if (band) tipParts.push(`ensemble p10 / p50 / p90: ${band.map(leadText).join(' / ')} (p10 = the early-front members)`);
        return h(
          'div',
          {
            class: `dl-ew-chip dl-ew-${sev}`,
            role: 'listitem',
            'data-station': t.name,
            'data-lead': num(lead),
            'data-sensor-lead': own !== undefined ? num(own) : null,
            'data-tip': tipParts.join(' · '),
            'data-tip-side': 'left',
          },
          h('span', { class: 'dl-ew-chip-name' }, t.short),
          h('span', { class: 'dl-ew-chip-lead' }, leadText(lead)),
          own !== undefined && base !== undefined ? h('span', { class: 'dl-ew-chip-sub dl-ew-chip-own' }, `sensors ${leadText(own)}`) : null,
          own !== undefined && base !== undefined ? h('span', { class: 'dl-ew-chip-sub' }, `alert ${leadText(base)}`) : null,
          band && Number.isFinite(band[0]) ? h('span', { class: 'dl-ew-chip-sub' }, `p10 ${leadText(band[0])}`) : null,
        );
      }),
    );
  }

  function renderChart(m: WarningModel, d: WarningDesign) {
    chartHost.replaceChildren();
    const target = chartTarget(m, d);
    chartTargetSel.replaceChildren(...m.targets.map((t) => h('option', { value: t.name, selected: target?.name === t.name }, t.short)));
    const c = curveFor(m, d);
    if (!target || !c) return;
    const W = CHART_W;
    const H = CHART_H;
    const box = { x0: 30, x1: W - 8, y0: 10, y1: H - 20 };
    const finite = c.lead.filter(Number.isFinite);
    const base = m.baseLeads?.[m.targets.indexOf(target)].lead;
    const yMaxRaw = Math.max(60, ...finite, Number.isFinite(base) ? base! : 0);
    const yMin = Math.min(0, ...finite);
    const yMax = yMaxRaw * 1.08;
    const x = (s: number) => box.x0 + ((s - c.s[0]) / Math.max(1, c.s[c.s.length - 1] - c.s[0])) * (box.x1 - box.x0);
    const y = (v: number) => box.y1 - ((Math.max(yMin, Math.min(yMax, v)) - yMin) / Math.max(1, yMax - yMin)) * (box.y1 - box.y0);
    const pts = c.s.map((s, k) => (Number.isFinite(c.lead[k]) ? `${r1(x(s))} ${r1(y(c.lead[k]))}` : null)).filter((p): p is string => p !== null);
    const root = svg('svg', { class: 'dl-ew-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Warning time at ${target.short} against where one sensor sits` });
    const mins = (v: number) => `${Math.round(v / 60)}`;
    root.append(
      svg('line', { class: 'dl-ew-axis-line', x1: box.x0, x2: box.x1, y1: r1(y(0)), y2: r1(y(0)) }),
      svg('text', { class: 'dl-ew-axis', x: box.x0 - 4, y: r1(y(yMaxRaw)) + 3, 'text-anchor': 'end' }, mins(yMaxRaw)),
      svg('text', { class: 'dl-ew-axis', x: box.x0 - 4, y: r1(y(0)) + 3, 'text-anchor': 'end' }, '0'),
      svg('text', { class: 'dl-ew-axis', x: box.x0 - 4, y: r1(y(yMaxRaw)) + 13, 'text-anchor': 'end' }, 'min'),
      svg('text', { class: 'dl-ew-axis', x: box.x0, y: H - 4 }, `source · km ${(c.s[0] / 1000).toFixed(0)}`),
      svg('text', { class: 'dl-ew-axis', x: box.x1, y: H - 4, 'text-anchor': 'end' }, `${target.short} · km ${(c.s[c.s.length - 1] / 1000).toFixed(0)}`),
      svg('path', { class: 'dl-ew-curve', d: pts.length ? `M${pts.join(' L')}` : '' }),
    );
    if (base !== undefined && Number.isFinite(base)) {
      const yy = r1(y(base));
      root.append(
        svg('line', { class: 'dl-ew-base-line', x1: box.x0, x2: box.x1, y1: yy, y2: yy }),
        svg('text', { class: 'dl-ew-axis dl-ew-base-label', x: box.x1, y: yy - 3, 'text-anchor': 'end' }, `existing alert ${leadText(base)}`),
      );
    }
    d.sensors.forEach((sn, i) => {
      if (sn.s > c.s[c.s.length - 1] || sn.s < c.s[0]) return;
      const k = Math.round(((sn.s - c.s[0]) / Math.max(1, c.s[c.s.length - 1] - c.s[0])) * (c.s.length - 1));
      const p = presetById(d.presetId);
      // The curve is for the preset's latencies; a sensor's own dot uses its own.
      const own = c.lead[k] + (p.detectionLatency + p.alertLatency) - (sn.detectionLatency + sn.alertLatency);
      if (!Number.isFinite(own)) return;
      root.append(svg('circle', { class: 'dl-ew-pt', cx: r1(x(sn.s)), cy: r1(y(own)), r: 3.5 }, svg('title', {}, `Sensor ${i + 1}: ${leadText(own)}`)));
    });
    chartHost.append(root, h('div', { class: 'dl-ew-note' }, `One sensor (${presetById(d.presetId).label}) anywhere from the source down to ${target.short}: the further upstream, the more warning.`));
  }

  function render() {
    const d = design();
    const m = warningModel(view, d);
    el.hidden = !m || !d;
    if (!m || !d) return;
    // Controls reflect the design.
    presetSel.value = d.presetId;
    const p = presetById(d.presetId);
    setText(presetNote, p.note);
    objectiveSeg.set(d.objective);
    elevSel.value = d.maxElevation === null ? '' : String(d.maxElevation);
    setText(addBtn.lastChild as HTMLElement, d.placing ? 'Cancel placing' : 'Add sensor');
    toggleClass(addBtn, 'dl-on', d.placing);
    addBtn.disabled = !d.placing && d.sensors.length >= MAX_SENSORS;
    clearBtn.disabled = d.sensors.length === 0;
    setText(placingHint, d.placing ? 'Click the valley profile in the timeline below the map to place the sensor.' : d.sensors.length ? 'Drag a sensor along the valley profile to move it.' : '');
    setText(suggestText, suggestion ?? '');

    // Baseline: the scenario's own alert.
    baselineRow.replaceChildren();
    if (m.baseline !== undefined) {
      const far = chartTarget(m, d);
      const bl = far ? m.baseLeads?.[m.targets.indexOf(far)].lead : undefined;
      baselineRow.append(h('span', { class: 'dl-ew-k' }, 'Existing alert'), h('span', { class: 'dl-ew-v' }, formatWhen(clock, m.baseline), h('span', { class: 'dl-prov dl-prov-observed' }, 'observed')));
      if (far && bl !== undefined) baselineRow.append(h('span', { class: 'dl-ew-band' }, `${far.short}: ${leadText(bl)} of warning on model times`));
    } else baselineRow.append(h('span', { class: 'dl-ew-k' }, 'No alert time is known for this scenario: add a sensor.'));

    renderSensors(m, d);
    renderChips(m);
    renderObserved(m, d);
    renderChart(m, d);
  }

  /** The observed arrivals' answer for the first sensor, where the scenario has them (Nepal: Rasuwagadhi → Betrawati). */
  function renderObserved(m: WarningModel, d: WarningDesign) {
    observedRow.replaceChildren();
    const v = view;
    const far = chartTarget(m, d);
    if (!v || !far) return;
    for (const sn of d.sensors) {
      const lead = observedLead(v.spec.observations, m.file, sn, far.name, m.input.seismicTrigger);
      if (lead === null) continue;
      const obs = v.spec.observations?.find((o) => o.station === far.name)?.tFront;
      observedRow.append(
        h('span', { class: 'dl-prov dl-prov-observed' }, 'observed'),
        ` With the observed arrivals instead of the model's, sensor ${d.sensors.indexOf(sn) + 1} would have given ${far.short} ${leadText(lead)}`,
        m.baseline !== undefined && obs !== undefined ? ` (the 2026 alert gave ${leadText(obs - m.baseline)}).` : '.',
      );
      return;
    }
  }

  ctx.own(
    bridge.chainChanged.on((v) => {
      const prevKey = view?.sceneKey;
      view = v;
      if (v?.sceneKey !== prevKey) {
        suggestion = null;
        clock = parseEventClock(v?.file?.clockZero);
      } else if (v && !clock) clock = parseEventClock(v.file?.clockZero);
      render();
    }),
  );
  ctx.own(bridge.warningChanged.on(() => render()));
  view = bridge.chain;
  clock = parseEventClock(view?.file?.clockZero);
  render();
  return { el };
}
