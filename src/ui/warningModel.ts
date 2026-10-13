/**
 * The early-warning designer's model for the UI: the chain view on screen + the design (sensors, optimiser settings)
 * → lead times per station with and without the sensors, ensemble bands, the lead-vs-position curve and the best
 * site. Pure (no DOM): the panel block (warningPanel.ts), the valley timeline (chainTimeline.ts) and the report
 * (impactReport.ts) all read the same numbers from here. The maths is src/hazard/warning.ts.
 */
import type { ChainFile, ChainObservation } from '../hazard/types';
import {
  DEFAULT_PRESET,
  LATENCY_PRESETS,
  bestSite,
  ensembleLeads,
  frontLineOf,
  isSeismicTrigger,
  leadCurve,
  warningLeads,
  warningTargets,
  type LatencyPreset,
  type Sensor,
  type SiteChoice,
  type TargetLead,
  type WarningInput,
  type WarningResult,
  type WarningTarget,
} from '../hazard/warning';
import type { ChainView, UIBridge, WarningDesign } from './bridge';
import { bedAt, formatSpan, shortStationName } from './chainTime';

/** Default minimum distance below the source for a sensor, m (warning.ts SiteConstraints). */
export const MIN_BELOW_SOURCE = 1000;
/** At most this many sensors (the list has to fit the panel). */
export const MAX_SENSORS = 6;

export interface WarningModel {
  input: WarningInput;
  /** Towns, bridges and hydropower plants, in profile order, with their kind. */
  targets: Array<WarningTarget & { kind: string; short: string }>;
  /** The scenario's own alert (spec.alertTime), s after clock zero. */
  baseline: number | undefined;
  /** Leads with the baseline alert alone (null without one). */
  baseLeads: TargetLead[] | null;
  /** Leads with the sensors (in addition to the baseline when there is one). */
  combined: WarningResult;
  /** Leads with the sensors alone (null without sensors). */
  sensorsOnly: WarningResult | null;
  /** p10 / p50 / p90 of the combined lead per target, once the ensemble has run. */
  bands: Array<[number, number, number]> | null;
  sourceS: number;
  /** Furthest chainage a sensor may go (the furthest target). */
  sMax: number;
  file: ChainFile;
}

/** The design for this chain view: the bridge's when it belongs to this scene, else a fresh one (published). */
export function ensureDesign(bridge: UIBridge, view: ChainView): WarningDesign {
  const w = bridge.warning;
  if (w && w.sceneKey === view.sceneKey) return w;
  const fresh: WarningDesign = { sceneKey: view.sceneKey, sensors: [], objective: 'maxMin', maxElevation: null, presetId: DEFAULT_PRESET.id, target: null, placing: false };
  bridge.setWarning(fresh);
  return fresh;
}

export function presetById(id: string): LatencyPreset {
  return LATENCY_PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET;
}

/** Everything the warning UI shows, or null before the chain has a result. */
export function warningModel(view: ChainView | null, design: WarningDesign | null): WarningModel | null {
  const file = view?.file;
  const res = view?.result;
  if (!view || !file || !res) return null;
  const capacity = new Map(file.stations.map((s) => [s.name, s.capacityMW]));
  const kinds = new Map(file.stations.map((s) => [s.name, s.kind]));
  const targets = warningTargets(res.stations, (n) => capacity.get(n)).map((t) => {
    const kind = kinds.get(t.name) ?? 'town';
    return { ...t, kind, short: shortStationName({ name: t.name, kind }) };
  });
  const input: WarningInput = { profile: frontLineOf(res, file.domainEntry.s), eventTime: 0, seismicTrigger: isSeismicTrigger(view.spec.trigger.kind) };
  const baseline = Number.isFinite(view.spec.alertTime) ? view.spec.alertTime : undefined;
  const sensors = design?.sensors ?? [];
  const combined = warningLeads(input, sensors, targets, baseline);
  const baseLeads = baseline !== undefined ? warningLeads(input, [], targets, baseline).leads : null;
  const sensorsOnly = sensors.length ? warningLeads(input, sensors, targets) : null;
  const bands = view.members?.length ? ensembleLeads(input, sensors, targets, view.members, res.stations, baseline) : null;
  const sourceS = res.sourceInfo.s;
  const sMax = targets.length ? Math.max(...targets.map((t) => t.s)) : file.s[file.s.length - 1];
  return { input, targets, baseline, baseLeads, combined, sensorsOnly, bands, sourceS, sMax, file };
}

/** The target the chart is about: the design's, else the furthest town, else the furthest target. */
export function chartTarget(m: WarningModel, design: WarningDesign | null): (WarningModel['targets'][number]) | null {
  const named = design?.target ? m.targets.find((t) => t.name === design.target) : undefined;
  if (named) return named;
  const towns = m.targets.filter((t) => t.kind === 'town');
  return towns[towns.length - 1] ?? m.targets[m.targets.length - 1] ?? null;
}

/** Lead at the chart's target against the position of one sensor with the design's preset. */
export function curveFor(m: WarningModel, design: WarningDesign | null, n = 90): { s: number[]; lead: number[] } | null {
  const t = chartTarget(m, design);
  if (!t) return null;
  const p = presetById(design?.presetId ?? DEFAULT_PRESET.id);
  return leadCurve(m.input, t, p, { sMin: m.sourceS, sMax: t.s, n });
}

/** The optimiser's site for one sensor with the design's preset, objective and access limit. */
export function suggestSite(m: WarningModel, design: WarningDesign): SiteChoice {
  const p = presetById(design.presetId);
  return bestSite(
    m.input,
    m.targets,
    p,
    { sourceS: m.sourceS, minBelowSource: MIN_BELOW_SOURCE, sMax: m.sMax, maxElevation: design.maxElevation ?? undefined, bed: { s: m.file.s, z: m.file.zBed } },
    design.objective,
  );
}

let nextId = 1;

/** A new sensor at chainage `s` with a preset's kind and latencies. */
export function newSensor(s: number, presetId: string): Sensor {
  const p = presetById(presetId);
  return { id: `ew${nextId++}`, s, kind: p.kind, detectionLatency: p.detectionLatency, alertLatency: p.alertLatency };
}

/** Clamp a chainage to where a sensor can go on the profile (below the source, above the furthest target). */
export function clampSensorS(m: Pick<WarningModel, 'sourceS' | 'sMax'>, s: number): number {
  return Math.max(m.sourceS, Math.min(m.sMax, s));
}

/** "km 15.0 · Rasuwagadhi" / "km 22.4 · 4 km below Timure" — where a sensor is, for its label. */
export function whereLabel(file: ChainFile, s: number): string {
  const km = `km ${(s / 1000).toFixed(1)}`;
  let best: { name: string; d: number; kind: string } | null = null;
  for (const st of file.stations) {
    if (st.kind === 'domainEdge') continue;
    const d = s - st.s;
    if (d >= -300 && (!best || Math.abs(d) < Math.abs(best.d))) best = { name: st.name, d, kind: st.kind };
  }
  if (!best) return km;
  const short = shortStationName({ name: best.name, kind: best.kind as never });
  if (Math.abs(best.d) <= 300) return `${km} · at ${short}`;
  return `${km} · ${(best.d / 1000).toFixed(1)} km below ${short}`;
}

/** Bed elevation at a chainage, m. */
export function bedElevation(file: ChainFile, s: number): number {
  return bedAt(file.s, file.zBed, s);
}

/** A sensor kind in words. */
export function kindLabel(kind: Sensor['kind']): string {
  return kind === 'gauge' ? 'Gauge' : kind === 'camera' ? 'Camera' : kind === 'tripwire' ? 'Trip-wire' : 'Seismic';
}

/**
 * What the OBSERVED arrivals say a sensor would have given a target: when the sensor sits within 500 m of a station
 * with an observed front and the target has one too — observed front(target) − observed front(sensor) − latencies.
 * (The Nepal 2026 observations: Rasuwagadhi ~08:40, Betrawati ~09:20 — the official series; both coincide with gauge
 * timestamps, a last normal reading and a lost signal, research spec §G.9.) Bounds ("upper bound", a gauge washed
 * away) and secondary reconstructions are not mixed into the official series. Null otherwise.
 */
export function observedLead(observations: readonly ChainObservation[] | undefined, file: ChainFile, sensor: Sensor, target: string, seismicTrigger: boolean): number | null {
  if (!observations) return null;
  const obs = (name: string) => observations.find((o) => o.station === name && o.tFront !== undefined)?.tFront;
  const tTarget = obs(target);
  if (tTarget === undefined) return null;
  const lat = sensor.detectionLatency + sensor.alertLatency;
  if (sensor.kind === 'seismic' && seismicTrigger) return tTarget - lat;
  const near = file.stations.filter((st) => Math.abs(st.s - sensor.s) <= 500 && obs(st.name) !== undefined && !/upper bound|washed away|secondary source/i.test(observations.find((o) => o.station === st.name)?.note ?? ''));
  if (!near.length) return null;
  return tTarget - obs(near[0].name)! - lat;
}

/** A lead time in words: "38 min", "no warning", "not reached", "none — water first". */
export function leadText(lead: number): string {
  if (lead === Infinity) return 'not reached';
  if (lead === -Infinity) return 'no warning';
  if (!Number.isFinite(lead)) return '—';
  if (lead < 0) return `none — water ${formatSpan(-lead)} first`;
  return formatSpan(lead);
}

/** Severity of a lead time for colouring: < 10 min is short, < 30 min tight. */
export function leadSev(lead: number): 'none' | 'short' | 'tight' | 'ok' {
  if (lead === Infinity) return 'ok';
  if (!(lead > 0)) return 'none';
  if (lead < 600) return 'short';
  if (lead < 1800) return 'tight';
  return 'ok';
}
