/**
 * Early-warning designer (research spec §E.2 "lead time", §G.1, §G.3, §G.4): where a sensor sits on the river, and how
 * fast the alert chain behind it is, decides how many minutes each town, bridge and hydropower plant gets.
 *
 *   lead(station) = front(station) − alert,   alert = min over sensors of (detect(sensor) + alertLatency)
 *   detect(sensor) = front(sensor's chainage) + detectionLatency        gauge, camera, trip-wire
 *                  = event time + detectionLatency                       seismic, when the trigger is a mass movement
 *
 * The sensor that alerts first is the one used ("the most upstream sensor that detects first"; ties go upstream). An
 * existing alert (HazardChainSpec.alertTime — Nepal 2026: SMS at 09:15 NPT) can be passed as a baseline: sensors are
 * then IN ADDITION to it, so they never make a station's lead time worse.
 *
 * SEISMIC. Large mass movements are recorded by regional seismic networks the moment they happen: the 26 Aug 2026
 * Lirung avalanche was a USGS M 5.2 landslide signal (us7000tbwb) at 08:37, 38 min before the SMS (spec §G.1); the
 * Gongbatongsha 2016 flood was tracked seismically down the valley (Sattar et al. 2022); debris-flow alarm systems
 * on geophones and infrasound arrays run operationally (Illgraben: Badoux et al. 2009, NHESS 9:517; infrasound:
 * Marchetti et al. 2019, JGR Earth Surface 124:567). Here a 'seismic' sensor detects the TRIGGER at the event time
 * when the trigger is a mass movement (massIntoRiver / massIntoLake) — its position on the profile does not matter —
 * and otherwise (a breach, a published hydrograph) the flow passing its chainage, like a geophone on the bank.
 * Seismic detection says "something big moved", not "a flood is coming": turning it into an alert needs a person or a
 * rule, which is what its latency is for.
 *
 * WHAT THIS IS NOT. Fronts are the chain's MODEL front times (routing.ts readProbe's threshold), not observations;
 * sensors fail in exactly the events they are for (the DHM Syafrubesi gauge stopped at 08:50 and was swept away — it
 * still counts here only if it detected before it died, which a gauge at the front's arrival does); and lead time is
 * not evacuation: people must receive, believe and act on the alert, and have somewhere to go.
 *
 * Pure, no DOM, no chain engine: the UI imports it on the main thread. Times in s after the chain's clock zero,
 * chainage in m.
 */

export type SensorKind = 'gauge' | 'camera' | 'tripwire' | 'seismic';

export interface Sensor {
  id: string;
  /** Chainage on the profile, m. */
  s: number;
  kind: SensorKind;
  /** From the physical event at the sensor to a detection somebody's system knows about (telemetry interval, a
   * person looking at a camera), s. */
  detectionLatency: number;
  /** From the detection to the alert reaching people (SMS gateway, siren, phone tree), s. */
  alertLatency: number;
}

/** A sensor's kind and latencies without a position (for the curve and the optimiser). */
export type SensorTemplate = Omit<Sensor, 'id' | 's'>;

/** Latency presets for the UI (illustrative; the spec quotes Bhutan's sirens within 15 min of a detection [S]). */
export interface LatencyPreset extends SensorTemplate {
  id: string;
  label: string;
  note: string;
}

export const LATENCY_PRESETS: readonly LatencyPreset[] = [
  { id: 'auto', label: 'Automated gauge + SMS', kind: 'gauge', detectionLatency: 60, alertLatency: 60, note: 'telemetered stage threshold, automatic SMS blast — 2 min' },
  { id: 'tripwire', label: 'Trip-wire + siren', kind: 'tripwire', detectionLatency: 10, alertLatency: 50, note: 'a wire across the channel, broken by the flow, sounds sirens downstream — 1 min' },
  { id: 'camera', label: 'Camera + operator', kind: 'camera', detectionLatency: 180, alertLatency: 120, note: 'an operator watching a feed confirms and triggers — 5 min (dark or cloud: longer)' },
  { id: 'manual', label: 'Manual relay', kind: 'gauge', detectionLatency: 300, alertLatency: 600, note: 'a gauge reader phones the district office, which calls the villages — 15 min' },
  { id: 'seismic', label: 'Seismic network + SMS', kind: 'seismic', detectionLatency: 120, alertLatency: 180, note: 'a regional network flags the mass movement, a duty officer sends the alert — 5 min' },
];

export const DEFAULT_PRESET = LATENCY_PRESETS[0];

/** Front arrival along the profile (src/hazard/frontProfile.ts; s ascending, t in s after clock zero, NaN = never). */
export interface FrontLine {
  s: readonly number[];
  t: readonly number[];
}

export interface WarningInput {
  /** Front arrival along the profile. */
  profile: FrontLine;
  /** When the trigger happened (chain clock; 0 = clock zero). */
  eventTime: number;
  /** The trigger is a mass movement a seismic network records at eventTime. */
  seismicTrigger: boolean;
}

/** A place that wants warning time. */
export interface WarningTarget {
  name: string;
  s: number;
  /** Modelled front arrival, s (NaN = the flood never gets there). */
  tFront: number;
  /** Weight in the 'weighted' objective (default 1). */
  weight?: number;
}

/** Lead time at a target: s (+∞ = not reached by the flood; −∞ = reached but nobody alerted). */
export interface TargetLead {
  name: string;
  s: number;
  tFront: number;
  lead: number;
}

// ─── Front along the profile ─────────────────────────────────────────────────────────────────────

/**
 * The profile as a monotone table: finite points only, sorted by chainage, each time held at least as late as the one
 * upstream (the front threshold can put a node a few seconds "before" its upstream neighbour where peaks differ; a
 * sensor's detection must never get EARLIER as it moves downstream). Several points at one chainage keep the earliest.
 */
export function monotoneFront(profile: FrontLine): FrontLine {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < Math.min(profile.s.length, profile.t.length); i++) {
    if (Number.isFinite(profile.s[i]) && Number.isFinite(profile.t[i])) pts.push([profile.s[i], profile.t[i]]);
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const s: number[] = [];
  const t: number[] = [];
  for (const [ps, pt] of pts) {
    if (s.length && s[s.length - 1] === ps) continue;
    s.push(ps);
    t.push(Math.max(pt, t.length ? t[t.length - 1] : -Infinity));
  }
  return { s, t };
}

/**
 * Front arrival at chainage `x` (linear between profile points). NaN upstream of the first point (above the source
 * nothing flows) and downstream of the last point the front reached (it never gets there). Expects monotoneFront's
 * output.
 */
export function frontTimeAt(m: FrontLine, x: number): number {
  const n = m.s.length;
  if (!n || !Number.isFinite(x) || x < m.s[0] - 1e-6 || x > m.s[n - 1] + 1e-6) return NaN;
  if (n === 1) return m.t[0];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (m.s[mid] <= x) lo = mid;
    else hi = mid;
  }
  const a = m.s[lo];
  const b = m.s[hi];
  if (x <= a) return m.t[lo];
  if (x >= b) return m.t[hi];
  return m.t[lo] + ((m.t[hi] - m.t[lo]) * (x - a)) / (b - a);
}

// ─── Detection, alert, lead ──────────────────────────────────────────────────────────────────────

/** When `sensor` detects (s after clock zero; +∞ = never: the flood does not reach it). */
export function detectionTime(input: WarningInput, mono: FrontLine, sensor: SensorTemplate & { s: number }): number {
  const det = Math.max(0, sensor.detectionLatency);
  if (sensor.kind === 'seismic' && input.seismicTrigger) return input.eventTime + det;
  const tf = frontTimeAt(mono, sensor.s);
  return Number.isFinite(tf) ? tf + det : Infinity;
}

/** When `sensor`'s alert reaches people (+∞ = never). */
export function alertTimeOf(input: WarningInput, mono: FrontLine, sensor: SensorTemplate & { s: number }): number {
  return detectionTime(input, mono, sensor) + Math.max(0, sensor.alertLatency);
}

export interface WarningResult {
  /** The alert that goes out first, s (+∞ = none), and which sensor raised it (-1 = the baseline, -2 = none). */
  alert: number;
  sensor: number;
  /** Per target, in the order given. */
  leads: TargetLead[];
}

/**
 * Lead time at every target for a set of sensors (and an optional existing alert they add to). The first alert wins;
 * between sensors alerting at the same second, the most upstream one is credited.
 */
export function warningLeads(input: WarningInput, sensors: readonly Sensor[], targets: readonly WarningTarget[], baselineAlert?: number): WarningResult {
  const mono = monotoneFront(input.profile);
  let alert = Infinity;
  let who = -2;
  if (baselineAlert !== undefined && Number.isFinite(baselineAlert)) {
    alert = baselineAlert;
    who = -1;
  }
  sensors.forEach((sn, i) => {
    const t = alertTimeOf(input, mono, sn);
    if (t < alert - 1e-9 || (who >= 0 && Math.abs(t - alert) <= 1e-9 && sn.s < sensors[who].s)) {
      alert = t;
      who = i;
    }
  });
  return { alert, sensor: who, leads: targets.map((tg) => ({ name: tg.name, s: tg.s, tFront: tg.tFront, lead: leadOf(tg.tFront, alert) })) };
}

/** front − alert, with +∞ for "never reached" and −∞ for "reached, never alerted". */
export function leadOf(tFront: number, alert: number): number {
  if (!Number.isFinite(tFront)) return Infinity;
  if (!Number.isFinite(alert)) return -Infinity;
  return tFront - alert;
}

// ─── Lead time against sensor position ───────────────────────────────────────────────────────────

/**
 * Lead time at `target` for one sensor of `template`'s kind at each of `n` chainages from `sMin` to `sMax` (default:
 * the profile's first point to the target). No baseline: the curve shows what the sensor alone gives.
 */
export function leadCurve(input: WarningInput, target: WarningTarget, template: SensorTemplate, opts: { sMin?: number; sMax?: number; n?: number } = {}): { s: number[]; lead: number[] } {
  const mono = monotoneFront(input.profile);
  const sMin = opts.sMin ?? mono.s[0] ?? 0;
  const sMax = opts.sMax ?? target.s;
  const n = Math.max(2, opts.n ?? 120);
  const s: number[] = [];
  const lead: number[] = [];
  for (let k = 0; k < n; k++) {
    const x = sMin + ((sMax - sMin) * k) / (n - 1);
    s.push(x);
    lead.push(leadOf(target.tFront, alertTimeOf(input, mono, { ...template, s: x })));
  }
  return { s, lead };
}

// ─── Best single site ────────────────────────────────────────────────────────────────────────────

export type WarningObjective = 'maxMin' | 'weighted';

/**
 * Where a sensor may go. Kept deliberately simple:
 *   • on the profile, at least `minBelowSource` m below the source (default 1 km: the source zone — the avalanche
 *     deposit, the breach — destroys anything in it before it can transmit);
 *   • not below `sMax` (default: the furthest target — a sensor below everyone warns no one);
 *   • optionally no higher than `maxElevation` m a.s.l. (access: above it, no road, power or phone signal to maintain
 *     it), which needs the bed profile (`bed`).
 */
export interface SiteConstraints {
  sourceS: number;
  minBelowSource?: number;
  sMax?: number;
  maxElevation?: number;
  bed?: { s: readonly number[]; z: readonly number[] };
}

export interface SiteChoice {
  /** Best chainage, m (NaN when no site is feasible). */
  s: number;
  /** The objective there: maxMin → the smallest lead over the targets, s; weighted → the weighted mean of max(0, lead), s. */
  value: number;
  leads: TargetLead[];
  /** Every feasible candidate and its objective, by chainage (the brute-force picture). */
  candidates: Array<{ s: number; value: number }>;
}

/** Default weights: one per town or bridge, capacity / 100 MW per hydropower plant (no population data on the
 * profile — illustrative, documented on screen). */
export function defaultWeight(kind: string, capacityMW?: number): number {
  if (kind === 'hydro') return Math.max(0.1, (capacityMW ?? 50) / 100);
  return 1;
}

/** The objective for one set of leads (+∞ leads — never reached — are left out; −∞ is "no warning", counted as 0 in
 * 'weighted' and as −∞ in 'maxMin'). */
export function objectiveValue(objective: WarningObjective, leads: readonly TargetLead[], targets: readonly WarningTarget[]): number {
  let min = Infinity;
  let sum = 0;
  let wsum = 0;
  leads.forEach((l, i) => {
    if (l.lead === Infinity) return;
    min = Math.min(min, l.lead);
    const w = targets[i]?.weight ?? 1;
    sum += w * Math.max(0, Number.isFinite(l.lead) ? l.lead : 0);
    wsum += w;
  });
  if (objective === 'maxMin') return min;
  return wsum > 0 ? sum / wsum : 0;
}

function bedZ(bed: SiteConstraints['bed'], x: number): number {
  if (!bed || !bed.s.length) return NaN;
  const { s, z } = bed;
  if (x <= s[0]) return z[0];
  if (x >= s[s.length - 1]) return z[z.length - 1];
  let i = 1;
  while (s[i] < x) i++;
  return z[i - 1] + ((z[i] - z[i - 1]) * (x - s[i - 1])) / (s[i] - s[i - 1]);
}

/**
 * The best site for ONE sensor of `template`'s kind. Candidates: every profile point, every bed node (when given)
 * and the feasible interval's ends. For a front-detecting sensor each target's lead is piecewise linear in the
 * sensor's chainage with breaks only at profile points, so the best of these candidates is the true optimum over
 * any feasible interval whose ends are candidates (the elevation limit is resolved to the bed nodes). Between
 * candidates within 1 s of the best, the most DOWNSTREAM is chosen: closer to roads and towns, easier to keep alive.
 * A seismic sensor on a mass-movement trigger scores the same everywhere — its position does not matter.
 */
export function bestSite(input: WarningInput, targets: readonly WarningTarget[], template: SensorTemplate, constraints: SiteConstraints, objective: WarningObjective = 'maxMin'): SiteChoice {
  const mono = monotoneFront(input.profile);
  const lo = constraints.sourceS + (constraints.minBelowSource ?? 1000);
  const reached = targets.filter((t) => Number.isFinite(t.s));
  const hi = constraints.sMax ?? (reached.length ? Math.max(...reached.map((t) => t.s)) : (mono.s[mono.s.length - 1] ?? lo));
  const cand = new Set<number>([lo, hi]);
  for (const x of mono.s) if (x >= lo && x <= hi) cand.add(x);
  if (constraints.bed) for (const x of constraints.bed.s) if (x >= lo && x <= hi) cand.add(x);
  const feasible = [...cand]
    .filter((x) => x >= lo - 1e-9 && x <= hi + 1e-9)
    .filter((x) => constraints.maxElevation === undefined || !constraints.bed || bedZ(constraints.bed, x) <= constraints.maxElevation + 1e-9)
    .sort((a, b) => a - b);
  const candidates = feasible.map((x) => {
    const al = alertTimeOf(input, mono, { ...template, s: x });
    const leads = targets.map((tg) => ({ name: tg.name, s: tg.s, tFront: tg.tFront, lead: leadOf(tg.tFront, al) }));
    return { s: x, value: objectiveValue(objective, leads, targets), leads };
  });
  if (!candidates.length) return { s: NaN, value: NaN, leads: [], candidates: [] };
  // The maximum, then the most downstream candidate within 1 s of it (candidates are sorted by chainage).
  const top = Math.max(...candidates.map((c) => c.value));
  const near = candidates.filter((c) => c.value >= top - 1 || c.value === top);
  const best = near[near.length - 1];
  return { s: best.s, value: best.value, leads: best.leads, candidates: candidates.map((c) => ({ s: c.s, value: c.value })) };
}

// ─── Ensemble robustness ─────────────────────────────────────────────────────────────────────────

/** One ensemble member's station fronts (src/hazard/chain.ts EnsembleMember). */
export interface MemberFronts {
  stations: ReadonlyArray<{ name: string; tFront: number }>;
}

/**
 * A member's front along the profile: its station fronts as anchors, the deterministic profile's shape between them
 * (each reach's deterministic travel-time curve stretched to the member's travel time over that reach). Outside the
 * anchors the nearest anchor's offset is applied. Members run on a coarser grid without profile probes, so this is
 * how a sensor between stations gets a member front.
 */
export function memberProfile(det: FrontLine, anchors: ReadonlyArray<{ s: number; det: number; mem: number }>): FrontLine {
  const mono = monotoneFront(det);
  const a = anchors.filter((x) => Number.isFinite(x.s) && Number.isFinite(x.det) && Number.isFinite(x.mem)).sort((p, q) => p.s - q.s);
  if (!a.length) return { s: [...mono.s], t: mono.s.map(() => NaN) };
  const t = mono.s.map((x, i) => {
    const P = mono.t[i];
    if (x <= a[0].s) return P - a[0].det + a[0].mem;
    if (x >= a[a.length - 1].s) {
      const z = a[a.length - 1];
      return P - z.det + z.mem;
    }
    let k = 1;
    while (a[k].s < x) k++;
    const p = a[k - 1];
    const q = a[k];
    const dd = q.det - p.det;
    const f = dd > 1e-9 ? (P - p.det) / dd : (x - p.s) / Math.max(1e-9, q.s - p.s);
    return p.mem + f * (q.mem - p.mem);
  });
  return { s: [...mono.s], t };
}

/** p-th quantile (R type 7) with NaN as +∞ (never reached). */
export function quantileOf(values: readonly number[], p: number): number {
  const v = values.map((x) => (Number.isNaN(x) ? Infinity : x)).sort((a, b) => a - b);
  if (!v.length) return NaN;
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi || v[hi] === v[lo] || !Number.isFinite(v[hi] - v[lo])) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (h - lo);
}

/**
 * Lead time at each target across the ensemble: p10 / p50 / p90 over the members (p10 = the early-front members —
 * a bigger, faster flood leaves less time between the sensor and the town). `stationS` gives each station's chainage;
 * targets match members by name. The baseline alert, when given, is a fixed clock time in every member.
 */
export function ensembleLeads(
  input: WarningInput,
  sensors: readonly Sensor[],
  targets: readonly WarningTarget[],
  members: readonly MemberFronts[],
  detStations: ReadonlyArray<{ name: string; s: number; tFront: number }>,
  baselineAlert?: number,
): Array<[number, number, number]> {
  const per: number[][] = targets.map(() => []);
  for (const m of members) {
    const byName = new Map(m.stations.map((x) => [x.name, x.tFront]));
    const anchors = detStations.map((st) => ({ s: st.s, det: st.tFront, mem: byName.get(st.name) ?? NaN }));
    const prof = memberProfile(input.profile, anchors);
    const mt = targets.map((tg) => ({ ...tg, tFront: byName.has(tg.name) ? byName.get(tg.name)! : tg.tFront }));
    const r = warningLeads({ ...input, profile: prof }, sensors, mt, baselineAlert);
    r.leads.forEach((l, i) => per[i].push(l.lead));
  }
  return per.map((xs) => (xs.length ? [quantileOf(xs, 0.1), quantileOf(xs, 0.5), quantileOf(xs, 0.9)] : [NaN, NaN, NaN]));
}

// ─── Glue for a chain result ─────────────────────────────────────────────────────────────────────

/** Trigger kinds a seismic network records as they happen (a mass movement). */
export function isSeismicTrigger(kind: string): boolean {
  return kind === 'massIntoRiver' || kind === 'massIntoLake';
}

/**
 * The front line of a chain run: its frontProfile when it has one, else its station fronts (and the domain entry) —
 * linear between stations, which is what the valley timeline draws.
 */
export function frontLineOf(result: { frontProfile?: FrontLine; stations: ReadonlyArray<{ s: number; tFront: number }>; entryFront: number }, entryS: number): FrontLine {
  if (result.frontProfile && result.frontProfile.s.length >= 2) return result.frontProfile;
  const pts = [...result.stations.map((x) => ({ s: x.s, t: x.tFront })), { s: entryS, t: result.entryFront }];
  return { s: pts.map((p) => p.s), t: pts.map((p) => p.t) };
}

/** Stations that want warning time: towns, bridges and hydropower plants (not the source, gauges or the map edge). */
export function warningTargets(
  stations: ReadonlyArray<{ name: string; s: number; kind: string; tFront: number }>,
  capacity: (name: string) => number | undefined = () => undefined,
): WarningTarget[] {
  return stations
    .filter((st) => st.kind === 'town' || st.kind === 'bridge' || st.kind === 'hydro')
    .map((st) => ({ name: st.name, s: st.s, tFront: st.tFront, weight: defaultWeight(st.kind, capacity(st.name)) }));
}
