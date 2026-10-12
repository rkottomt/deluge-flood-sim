/**
 * Pure helpers behind the glacier hazard chain's UI (the panel section in chainPanel.ts, the valley timeline in
 * chainTimeline.ts, the event clock in the top bar): the real event clock from the chain's ISO clock zero, where the
 * flood front is along the valley at a given time, which stations it has passed, warning lead times, and what the
 * trigger was and where each of its numbers came from. No DOM, unit-tested in tests/ui/chain.test.ts.
 *
 * Times: CHAIN time is seconds after the chain's clock zero (the trigger). The 2-D solver's clock starts at
 * `offset` seconds of chain time (src/hazard/chain.ts domainClockOffset), so chain time = offset + simTime.
 */
import type { ChainFile, ChainObservation, ChainStation, HazardChainSpec, Provenance } from '../hazard/types';
import { fmtNum } from './format';

const NBSP = ' ';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ─── Event clock ─────────────────────────────────────────────────────────────────────────────────

/** An absolute instant and the UTC offset its ISO string was written in (minutes east of UTC). */
export interface EventClock {
  /** Epoch milliseconds of clock zero. */
  ms: number;
  /** The local UTC offset of the event, minutes (+345 for Nepal, +330 for India). */
  offsetMin: number;
}

/**
 * Parse an ISO 8601 date-time WITH an explicit offset ('2026-08-26T08:37:00+05:45', '…Z'). The offset is kept: the
 * clock is shown in the event's own local time whatever the viewer's time zone. Null for anything else — a time
 * without an offset would silently take the viewer's zone, which is exactly the mistake this avoids.
 */
export function parseEventClock(iso: string | null | undefined): EventClock | null {
  if (typeof iso !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(iso.trim());
  if (!m) return null;
  const offsetMin = m[7] === 'Z' ? 0 : (m[8] === '-' ? -1 : 1) * (Number(m[9]) * 60 + Number(m[10]));
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  if (!Number.isFinite(utc) || Math.abs(offsetMin) > 14 * 60) return null;
  return { ms: utc - offsetMin * 60_000, offsetMin };
}

/**
 * Name of a UTC offset for the clock's label. Only the zones of the presets' events are named (an offset alone does
 * not identify a zone: +05:30 is India and Sri Lanka); everything else reads "UTC+hh:mm".
 */
export function zoneLabel(offsetMin: number): string {
  const named: Record<number, string> = { 345: 'NPT', 330: 'IST', 360: 'BST', 0: 'UTC', 60: 'CET', 120: 'CEST' };
  if (named[offsetMin]) return named[offsetMin];
  const sign = offsetMin < 0 ? '−' : '+';
  const a = Math.abs(offsetMin);
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

/**
 * The event's local wall-clock time `t` seconds after clock zero: "09:20 NPT", or with `date` "26 Aug 2026 09:14 NPT".
 * Seconds are dropped (floored), so the clock ticks over exactly at the minute.
 */
export function formatEventTime(clock: EventClock, t: number, opts: { date?: boolean; zone?: boolean; seconds?: boolean } = {}): string {
  if (!Number.isFinite(t)) return '—';
  const d = new Date(clock.ms + Math.floor(t) * 1000 + clock.offsetMin * 60_000);
  const p2 = (n: number) => String(n).padStart(2, '0');
  let s = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
  if (opts.seconds) s += `:${p2(d.getUTCSeconds())}`;
  if (opts.date) s = `${d.getUTCDate()}${NBSP}${MONTHS[d.getUTCMonth()]}${NBSP}${d.getUTCFullYear()} ${s}`;
  if (opts.zone !== false) s += `${NBSP}${zoneLabel(clock.offsetMin)}`;
  return s;
}

/** Chain time as "T+1 h 12 min" (what-ifs with no real clock). */
export function formatChainTime(t: number): string {
  if (!Number.isFinite(t)) return '—';
  const sign = t < 0 ? '−' : '+';
  const a = Math.abs(t);
  const min = Math.floor(a / 60);
  if (min < 60) return `T${sign}${min}${NBSP}min`;
  const h = Math.floor(min / 60);
  return `T${sign}${h}${NBSP}h${min % 60 ? ` ${min % 60}${NBSP}min` : ''}`;
}

/** A time for display: the event clock where there is one, else chain time. */
export function formatWhen(clock: EventClock | null, t: number): string {
  return clock ? formatEventTime(clock, t) : formatChainTime(t);
}

/** "5 min", "1 h 05 min", "—"; negative lead (the water came first) as "none (water 3 min before)". */
export function formatLead(lead: number | null | undefined): string {
  if (lead === null || lead === undefined || !Number.isFinite(lead)) return '—';
  if (lead < 0) return `none — water ${formatSpan(-lead)} before the alert`;
  return formatSpan(lead);
}

/** A duration rounded to whole minutes: "45 s" under a minute, "5 min", "2 h 15 min". */
export function formatSpan(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const a = Math.max(0, s);
  if (a < 59.5) return `${Math.round(a)}${NBSP}s`;
  const min = Math.round(a / 60);
  if (min < 60) return `${min}${NBSP}min`;
  return `${Math.floor(min / 60)}${NBSP}h${min % 60 ? ` ${min % 60}${NBSP}min` : ''}`;
}

// ─── Front position along the valley ─────────────────────────────────────────────────────────────

/** A point the front is known to pass: chainage (m) at chain time (s). */
export interface FrontPoint {
  s: number;
  t: number;
}

/**
 * The front's passage times as a monotone table: the points with a finite time, sorted by chainage, each time held at
 * least as late as the one upstream of it (the router's thresholds can put a station a few seconds "before" its
 * neighbour upstream when their peaks differ; a front that runs backwards would make the timeline jitter).
 */
export function frontTable(points: readonly FrontPoint[]): FrontPoint[] {
  const pts = points.filter((p) => Number.isFinite(p.s) && Number.isFinite(p.t)).sort((a, b) => a.s - b.s || a.t - b.t);
  const out: FrontPoint[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    // Several points at one chainage (a town and its gauge): the earliest counts — they are sorted by time.
    if (last && last.s === p.s) continue;
    out.push({ s: p.s, t: Math.max(p.t, last ? last.t : -Infinity) });
  }
  return out;
}

/**
 * Where the front is at chain time `t`, m of chainage: null before it leaves the first point; linear in time between
 * points; past the last point it keeps the last reach's speed until `sEnd` (the profile's downstream end). A table
 * of one point is reached and stays there.
 */
export function frontAt(table: readonly FrontPoint[], t: number, sEnd = Infinity): number | null {
  if (!table.length || !Number.isFinite(t) || t < table[0].t) return null;
  for (let i = 1; i < table.length; i++) {
    const a = table[i - 1];
    const b = table[i];
    if (t <= b.t) return b.t > a.t ? a.s + ((b.s - a.s) * (t - a.t)) / (b.t - a.t) : b.s;
  }
  const last = table[table.length - 1];
  if (table.length < 2) return last.s;
  const prev = table[table.length - 2];
  const v = last.t > prev.t ? (last.s - prev.s) / (last.t - prev.t) : 0;
  return Math.min(Math.max(last.s, sEnd === Infinity ? last.s : sEnd), last.s + v * (t - last.t));
}

export type StationState = 'passed' | 'next' | 'pending' | 'never';

/**
 * State of each station at chain time `t`: passed (the front got there), next (the one it reaches next — by time, not
 * list order: stations at one chainage, or the router's thresholds, can be reached out of order), pending, or never
 * (the run says the flood does not reach it). Index-aligned with `fronts`.
 */
export function stationStates(fronts: readonly number[], t: number): StationState[] {
  const states: StationState[] = fronts.map((tf) => (!Number.isFinite(tf) ? 'never' : Number.isFinite(t) && t >= tf ? 'passed' : 'pending'));
  let best = -1;
  fronts.forEach((tf, i) => {
    if (states[i] === 'pending' && (best < 0 || tf < fronts[best])) best = i;
  });
  if (best >= 0) states[best] = 'next';
  return states;
}

// ─── Stations, observations, lead time ───────────────────────────────────────────────────────────

/** The observation of a station's front arrival, if the scenario has one (the station's name or its town's name). */
export function observedFront(observations: readonly ChainObservation[] | undefined, station: string): ChainObservation | null {
  if (!observations) return null;
  return observations.find((o) => o.tFront !== undefined && o.station === station) ?? null;
}

/** Warning lead time at a station: front − alert, s (null without an alert time or a front). */
export function leadTime(alertTime: number | undefined, tFront: number): number | null {
  if (alertTime === undefined || !Number.isFinite(alertTime) || !Number.isFinite(tFront)) return null;
  return tFront - alertTime;
}

/** A short label for a station on the profile: "Rasuwagadhi HEP headworks" → "Rasuwagadhi HEP". */
export function shortStationName(st: Pick<ChainStation, 'name' | 'kind'>): string {
  let n = st.name.replace(/\s*\([^)]*\)\s*/g, ' ').trim();
  if (st.kind === 'domainEdge') return 'Map edge';
  n = n.replace(/\b(headworks|powerhouse)\b/gi, '').replace(/\s+/g, ' ').trim();
  n = n.replace(/ at [\d,]+ m$/, '');
  return n.length > 22 ? `${n.slice(0, 21)}…` : n;
}

/** What a station is, for its tooltip: "Hydropower plant · 111 MW". */
export function stationKindLabel(st: Pick<ChainStation, 'kind' | 'capacityMW'>): string {
  switch (st.kind) {
    case 'hydro':
      return `Hydropower plant${st.capacityMW ? ` · ${fmtNum(st.capacityMW, st.capacityMW % 1 ? 1 : 0)}${NBSP}MW` : ''}`;
    case 'town':
      return 'Town';
    case 'gauge':
      return 'River gauge';
    case 'bridge':
      return 'Bridge';
    case 'lake':
      return 'Glacial lake (source)';
    case 'source':
      return 'Source of the flood';
    case 'domainEdge':
      return 'Where the flood enters the 2-D map';
  }
}

// ─── Trigger summary ─────────────────────────────────────────────────────────────────────────────

export interface TriggerSummary {
  /** "Ice-rock avalanche into the river" */
  title: string;
  /** The volume the what-if slider scales, with its band (m³) and where it came from. */
  volume: { label: string; median: number; lo: number; hi: number; provenance: Provenance; note: string } | null;
  /** Other facts, each with its provenance. */
  facts: Array<{ label: string; value: string; provenance: Provenance }>;
  /** The trigger has a breach that erodes (the erosion-rate control applies). */
  erodes: boolean;
  /** Default erosion rate, m/h, for the control. */
  erosionRate: number | null;
  /** The trigger has a transient-dam / direct-flow choice. */
  modes: Array<'transientDam' | 'directFlow'> | null;
}

/**
 * What started the chain, in words, with the provenance of each number. A real event (the chain file has a clock zero)
 * makes the event itself observed and a published volume reconstructed; a lake volume measured by bathymetry is
 * observed, one estimated from the lake's area is modelled; what-ifs are scenarios.
 */
export function triggerSummary(spec: HazardChainSpec, file: Pick<ChainFile, 'clockZero'>, defaults: { avalancheDamRate: number; triggeredRate: number }): TriggerSummary {
  const real = !!parseEventClock(file.clockZero);
  const tr = spec.trigger;
  const Mm3 = (v: number) => `${fmtNum(v / 1e6, v < 1e7 ? 1 : 0)}${NBSP}Mm³`;
  const event: Provenance = real ? 'observed' : 'scenario';
  switch (tr.kind) {
    case 'breach':
    case 'massIntoLake': {
      const lv = tr.lake.volume;
      const vp: Provenance = lv.method === 'bathymetry' ? 'observed' : 'modelled';
      const facts: TriggerSummary['facts'] = [{ label: 'Lake', value: `${tr.lake.name}, ${fmtNum(tr.lake.elevation, 0)}${NBSP}m`, provenance: 'observed' }];
      if (tr.kind === 'massIntoLake') facts.push({ label: 'Mass into the lake', value: Mm3(tr.mass.volume), provenance: real ? 'reconstructed' : 'scenario' });
      return {
        title: tr.kind === 'breach' ? 'Glacial lake outburst (dam breach)' : 'Mass movement into a glacial lake → outburst',
        volume: {
          label: 'Lake volume',
          median: lv.median,
          lo: lv.lo,
          hi: lv.hi,
          provenance: vp,
          note: lv.method === 'bathymetry' ? 'from bathymetry' : lv.method === 'veh2025' ? 'from the lake area (V–A, 2025)' : 'from the lake area (empirical V–A)',
        },
        facts: [{ label: 'Event', value: real ? 'observed' : 'scenario', provenance: event }, ...facts],
        erodes: true,
        erosionRate: tr.kind === 'massIntoLake' ? Math.max(tr.breach.erosionRate, defaults.triggeredRate) : tr.breach.erosionRate,
        modes: null,
      };
    }
    case 'massIntoRiver':
      return {
        title: 'Ice-rock avalanche into the river',
        volume: {
          label: 'Avalanche volume',
          median: tr.mass.volume,
          lo: tr.mass.volume / 2,
          hi: tr.mass.volume * 2,
          provenance: real ? 'reconstructed' : 'scenario',
          note: `${fmtNum(tr.mass.iceFraction * 100, 0)}${NBSP}% ice, fell ${fmtNum(tr.mass.fallHeight, 0)}${NBSP}m; band ×½–×2`,
        },
        facts: [
          { label: 'Event', value: real ? 'observed' : 'scenario', provenance: event },
          { label: 'Mechanism', value: tr.mode === 'transientDam' ? 'blocks the river, then the dam breaches' : 'flows on as a debris flood', provenance: 'modelled' },
        ],
        erodes: tr.mode === 'transientDam',
        erosionRate: defaults.avalancheDamRate,
        modes: ['transientDam', 'directFlow'],
      };
    case 'meltAnomaly':
      return {
        title: 'Glacier melt anomaly',
        volume: null,
        facts: [{ label: 'Warming', value: `+${fmtNum(tr.deltaT, 1)}${NBSP}°C for ${tr.days} days`, provenance: 'scenario' }],
        erodes: false,
        erosionRate: null,
        modes: null,
      };
    case 'given':
      return {
        title: 'Published outflow hydrograph',
        volume: null,
        facts: [{ label: 'Hydrograph', value: tr.provenance, provenance: tr.provenance }],
        erodes: false,
        erosionRate: null,
        modes: null,
      };
  }
}

/** The what-if volume factor that gives `volume` (the slider works in absolute volume, the chain in a factor). */
export function volumeFactorFor(summary: TriggerSummary, volume: number): number {
  return summary.volume && summary.volume.median > 0 ? volume / summary.volume.median : 1;
}

// ─── Geometry for the SVG profile ────────────────────────────────────────────────────────────────

/**
 * The valley's long profile as polyline points in a w × h box (x = chainage, y = bed elevation, top = highest), at most
 * `maxPoints` of them (the bake's 600–700 nodes would be wasted on a 600 px strip). Returns the scale functions too.
 */
export function profileGeometry(
  s: readonly number[],
  z: readonly number[],
  box: { x0: number; x1: number; y0: number; y1: number },
  maxPoints = 160,
): { points: Array<[number, number]>; x(s: number): number; y(z: number): number; zMin: number; zMax: number } {
  const n = Math.min(s.length, z.length);
  const s0 = n ? s[0] : 0;
  const s1 = n ? s[n - 1] : 1;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(z[i])) continue;
    zMin = Math.min(zMin, z[i]);
    zMax = Math.max(zMax, z[i]);
  }
  if (!(zMax > zMin)) {
    zMin = Number.isFinite(zMin) ? zMin - 1 : 0;
    zMax = zMin + 2;
  }
  const x = (v: number) => box.x0 + ((v - s0) / Math.max(1e-9, s1 - s0)) * (box.x1 - box.x0);
  const y = (v: number) => box.y1 - ((v - zMin) / (zMax - zMin)) * (box.y1 - box.y0);
  const step = Math.max(1, Math.ceil(n / maxPoints));
  const points: Array<[number, number]> = [];
  for (let i = 0; i < n; i += step) if (Number.isFinite(z[i])) points.push([x(s[i]), y(z[i])]);
  if (n && (n - 1) % step !== 0 && Number.isFinite(z[n - 1])) points.push([x(s[n - 1]), y(z[n - 1])]);
  return { points, x, y, zMin, zMax };
}

/** Polyline points → an SVG path ("M x y L x y …"), rounded to 0.1 px. */
export function pathOf(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y], i) => `${i ? 'L' : 'M'}${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`).join(' ');
}

/**
 * Bed elevation at chainage `v` by linear interpolation (for placing station markers on the bed line).
 */
export function bedAt(s: readonly number[], z: readonly number[], v: number): number {
  const n = Math.min(s.length, z.length);
  if (!n) return 0;
  if (v <= s[0]) return z[0];
  if (v >= s[n - 1]) return z[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid] <= v) lo = mid;
    else hi = mid;
  }
  return z[lo] + ((z[hi] - z[lo]) * (v - s[lo])) / Math.max(1e-9, s[hi] - s[lo]);
}

/**
 * Label rows for markers along an axis so their labels never overlap: markers are placed in `priority` order (lower
 * first; default input order), each in the lowest of `rows` rows where its label (centred on x, `widths` px wide, kept
 * inside [0, maxX] when given) clears every label already there by 4 px. A marker that fits nowhere gets -1 (no label;
 * its tooltip and its chip still name it). Returns the row per marker, in input order.
 */
export function labelRows(xs: readonly number[], widths: readonly number[], rows: number, priority?: readonly number[], maxX = Infinity): number[] {
  const order = xs.map((_, i) => i).sort((a, b) => (priority ? priority[a] - priority[b] : 0) || a - b);
  const placed: Array<Array<[number, number]>> = Array.from({ length: rows }, () => []);
  const out = new Array<number>(xs.length).fill(-1);
  for (const i of order) {
    // An infinite priority means "never label".
    if (priority && !Number.isFinite(priority[i])) continue;
    let left = xs[i] - widths[i] / 2;
    left = Math.max(0, Math.min(left, maxX - widths[i]));
    const right = left + widths[i];
    const r = placed.findIndex((row) => row.every(([a, b]) => right + 4 <= a || left >= b + 4));
    if (r < 0) continue;
    placed[r].push([left, right]);
    out[i] = r;
  }
  return out;
}
