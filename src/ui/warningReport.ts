/**
 * The "Early warning" section of the impact report (impactReport.ts) on a chain preset: the existing alert, the
 * sensors placed in the Early warning block (warningPanel.ts) and the warning time each town, bridge and hydropower
 * plant gets with them, with the ensemble's p10 and the caveats. Same h() markup and classes as the rest of the
 * report; null when the scene has no chain result.
 */
import type { ChainView, WarningDesign } from './bridge';
import { h } from './dom';
import { formatWhen, parseEventClock } from './chainTime';
import { kindLabel, leadText, presetById, suggestSite, warningModel, whereLabel } from './warningModel';

export function buildWarningSection(view: ChainView | null, design: WarningDesign | null): HTMLElement | null {
  const d = design && view && design.sceneKey === view.sceneKey ? design : null;
  const m = warningModel(view, d);
  if (!view || !m) return null;
  const clock = parseEventClock(view.file?.clockZero);
  const sensors = d?.sensors ?? [];
  const kv: Array<[string, string]> = [];
  kv.push(['Existing alert', m.baseline !== undefined ? `${formatWhen(clock, m.baseline)} (observed)` : 'none known for this scenario']);
  kv.push(['Sensors placed', sensors.length ? String(sensors.length) : 'none']);
  sensors.forEach((sn, i) => {
    kv.push([
      `Sensor ${i + 1} — ${kindLabel(sn.kind)}`,
      `${sn.kind === 'seismic' && m.input.seismicTrigger ? 'hears the mass movement itself' : whereLabel(m.file, sn.s)}; detect ${leadText(sn.detectionLatency)}, alert out ${leadText(sn.alertLatency)}${m.combined.sensor === i ? ' — alerts first' : ''}`,
    ]);
  });
  const best = suggestSite(m, d ?? { sceneKey: view.sceneKey, sensors: [], objective: 'maxMin', maxElevation: null, presetId: 'auto', target: null, placing: false });
  if (Number.isFinite(best.s)) {
    kv.push([`Best single site (${presetById(d?.presetId ?? 'auto').label})`, `${whereLabel(m.file, best.s)} — ${d?.objective === 'weighted' ? 'weighted mean' : 'worst-off place'} ${leadText(best.value)}${d?.maxElevation ? ` (bed ≤ ${d.maxElevation} m)` : ''}`]);
  }
  const head = ['Place', 'Modelled front', 'Existing alert', ...(sensors.length ? ['Sensors alone', 'Combined'] : []), ...(m.bands ? ['Combined p10 (ensemble)'] : [])];
  const rows = m.targets.map((t, i) => [
    t.name,
    formatWhen(clock, t.tFront),
    m.baseLeads ? leadText(m.baseLeads[i].lead) : '—',
    ...(sensors.length ? [leadText(m.sensorsOnly!.leads[i].lead), leadText(m.combined.leads[i].lead)] : []),
    ...(m.bands ? [leadText(m.bands[i][0])] : []),
  ]);
  return h(
    'section',
    null,
    h('h2', null, 'Early warning'),
    h('dl', { class: 'dl-rep-kv' }, ...kv.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    h(
      'table',
      { class: 'dl-rep-table' },
      h('thead', null, h('tr', null, ...head.map((c) => h('th', null, c)))),
      h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c) => h('td', null, c))))),
    ),
    h(
      'p',
      { class: 'dl-rep-note' },
      'Lead time = modelled front arrival − (detection + alert latency) of the first sensor to alert, or the existing alert if earlier. ' +
        'These are MODEL front times from the 1-D hazard chain, not observations. Sensors fail in the events they are built for (the DHM Syafrubesi gauge stopped at 08:50 on 26 Aug 2026 and was swept away). ' +
        'Lead time is not evacuation: people must receive, trust and act on the alert and have somewhere to go.',
    ),
  );
}
