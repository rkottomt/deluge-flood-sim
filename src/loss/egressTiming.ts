/**
 * Egress TIMING: of the people in a building, how many get out by road before the way out closes?
 *
 * egress.ts says when the last road route to a shelter closes. Two things stand between that and "everyone is out":
 *
 *   1. people do not leave the moment the alert goes out — departure.ts: a published mobilisation curve
 *      (Sorensen & Mileti 2015b) spreads departures over the hours after the warning, and some never leave;
 *   2. the cars queue at the route's bottleneck — bottleneck.ts: lanes × a per-lane discharge rate (HCM-based), and a
 *      point queue in front of it.
 *
 * Out of them:
 *
 *   window      the latest safe departure (egress.ts lastSafeDepartureAt: each shelter's closure minus its drive) minus
 *               the alert — how long the occupants have
 *   out         share of ALL occupants whose car is through the bottleneck by then
 *   queued      …who have left the building but are still in the queue when it closes
 *   inside      …who have not left yet (including those the curve says never leave)
 *   clearance   alert → the last car that leaves is through the bottleneck, against the window
 *
 * Everything is a transparent calculation on stated defaults; every default can be overridden per site. Pure: no DOM.
 */
import type { Occupancy } from './value';
import type { EgressResult } from './egress';
import { DEFAULT_DEPARTURE_CURVE, departureBand, departureCurve, type DepartureCurve, type DepartureCurveId } from '../routing/departure';
import { bottleneckQueue, DEFAULT_EXIT_LANES, defaultPersonsPerVehicle, departedBy, routeBottleneck, throughBy, vehiclesFor, type Bottleneck } from '../routing/bottleneck';
import { defaultOccupants } from '../routing/pedestrianEvac';

export interface EgressTimingInput {
  occupants: number;
  /** Where the occupant count comes from (shown with it). */
  occupantsBasis: string;
  personsPerVehicle: number;
  personsPerVehicleBasis: string;
  exitLanes: number;
  curve: DepartureCurve;
  /** When the warning reaches the occupants, s since reset (may be negative: warned before the run starts). */
  alertTime: number;
}

export interface EgressTiming {
  /** False when egress was not assessed or there was no route even before the flood. */
  known: boolean;
  note: string;
  occupants: number;
  occupantsBasis: string;
  vehicles: number;
  personsPerVehicle: number;
  personsPerVehicleBasis: string;
  curve: DepartureCurve;
  /** Departure-curve percentiles among those who leave, s after the alert. */
  band: { p10: number; p50: number; p90: number };
  bottleneck: Bottleneck;
  /** Alert → last leaving car through the bottleneck, s. */
  clearanceS: number;
  /** Cars that leave / capacity: the clearance if all left at once, s. */
  queueOnlyS: number;
  maxQueue: number;
  alertTime: number;
  /** Latest safe departure, s since reset (+∞: a route stays open through the run). */
  lastSafeAt: number;
  lastSafeShelter: string;
  /** lastSafeAt − alert, s (+∞ when no route closes; ≤ 0 when it closes before the alert). */
  windowS: number;
  /** Shares of all occupants when the window ends (NaN when it never ends). */
  shareOut: number;
  shareQueued: number;
  shareInside: number;
  /** Everyone who leaves is through the bottleneck before the window ends. */
  clearsInWindow: boolean;
}

/** Defaults for a planned building: occupants come from the caller (pedestrianEvac.defaultOccupants), cars from the use. */
export function timingDefaults(occ: Occupancy): { personsPerVehicle: number; basis: string } {
  const d = defaultPersonsPerVehicle(occ);
  return { personsPerVehicle: d.value, basis: d.basis };
}

/** A site's inputs as the user typed them (null / absent = the default). Shared by Site check and the CLI. */
export interface TimingOverrides {
  occupants?: number | null;
  /** When the warning reaches the occupants, min since the run started (negative: before it). */
  alertMin?: number | null;
  departure?: DepartureCurveId;
  departBMin?: number | null;
  departMaxPct?: number | null;
  personsPerCar?: number | null;
  exitLanes?: number | null;
}

/**
 * Leaving by road for one run of a planned building: occupants default to the IBC design load for its use and floor
 * area (pedestrianEvac.defaultOccupants — an upper bound), cars to the use's persons per car, the curve to
 * DEFAULT_DEPARTURE_CURVE, one exit lane, the alert to `alertTime` (s since reset). Null for a site outside the map.
 */
export function timingForRun(run: { result: { occ: Occupancy; gfaM2: number } | null; egress: EgressResult | null }, alertTime: number, o: TimingOverrides = {}): EgressTiming | null {
  const r = run.result;
  if (!r) return null;
  const occ = defaultOccupants(r.occ, r.gfaM2);
  const d = timingDefaults(r.occ);
  const curve = departureCurve(o.departure ?? DEFAULT_DEPARTURE_CURVE, { bMin: o.departBMin ?? null, maxShare: o.departMaxPct == null ? null : o.departMaxPct / 100 });
  return egressTiming(run.egress, {
    occupants: o.occupants ?? occ.n,
    occupantsBasis: o.occupants != null ? 'your input' : `${occ.basis} — a design maximum`,
    personsPerVehicle: o.personsPerCar ?? d.personsPerVehicle,
    personsPerVehicleBasis: o.personsPerCar != null ? 'your input' : d.basis,
    exitLanes: o.exitLanes ?? DEFAULT_EXIT_LANES,
    curve,
    alertTime: o.alertMin != null ? o.alertMin * 60 : alertTime,
  });
}

export function egressTiming(e: EgressResult | null, input: EgressTimingInput): EgressTiming {
  const N = Math.max(0, Math.round(input.occupants));
  const V = vehiclesFor(N, input.personsPerVehicle);
  const bottleneck = routeBottleneck(e?.routeClassMeters ?? null, input.exitLanes);
  const q = bottleneckQueue(V, bottleneck.capacityVph, input.curve);
  const out: EgressTiming = {
    known: false,
    note: '',
    occupants: N,
    occupantsBasis: input.occupantsBasis,
    vehicles: V,
    personsPerVehicle: input.personsPerVehicle,
    personsPerVehicleBasis: input.personsPerVehicleBasis,
    curve: input.curve,
    band: departureBand(input.curve),
    bottleneck,
    clearanceS: q.clearanceS,
    queueOnlyS: q.queueOnlyS,
    maxQueue: q.maxQueue,
    alertTime: input.alertTime,
    lastSafeAt: NaN,
    lastSafeShelter: '',
    windowS: NaN,
    shareOut: NaN,
    shareQueued: NaN,
    shareInside: NaN,
    clearsInWindow: false,
  };
  if (!e) {
    out.note = 'egress not assessed';
    return out;
  }
  if (!e.known) {
    out.note = e.note || 'egress not assessed';
    return out;
  }
  if (!e.openAtStart) {
    out.note = 'no road route to a shelter even before the flood';
    return out;
  }
  if (!(N > 0)) {
    out.note = 'no occupants';
    return out;
  }
  out.known = true;
  // Older results (hand-built, or from before lastSafeDepartureAt) fall back on the last route's closure.
  const lastSafe = e.lastSafeDepartureAt ?? (e.openAtPeak ? Infinity : e.lastRouteClosesAt);
  out.lastSafeAt = Number.isNaN(lastSafe) ? (e.openAtPeak ? Infinity : e.lastRouteClosesAt) : lastSafe;
  out.lastSafeShelter = e.lastSafeShelter ?? '';
  out.windowS = out.lastSafeAt - input.alertTime;
  if (out.windowS === Infinity) {
    out.clearsInWindow = Number.isFinite(q.clearanceS);
    return out;
  }
  const w = Math.max(0, out.windowS);
  const departed = departedBy(V, input.curve, w);
  const through = Math.min(departed, throughBy(V, bottleneck.capacityVph, input.curve, w));
  out.shareOut = through / V;
  out.shareQueued = Math.max(0, departed - through) / V;
  out.shareInside = Math.max(0, 1 - departed / V);
  out.clearsInWindow = q.clearanceS <= out.windowS;
  return out;
}

// ─── Words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const pct = (v: number) => {
  if (!Number.isFinite(v)) return '—';
  const p = v * 100;
  if (p > 0 && p < 1) return '< 1 %';
  if (p < 100 && p > 99) return '> 99 %';
  return `${Math.round(p)} %`;
};

export function fmtMin(s: number): string {
  if (s === Infinity) return '∞';
  if (!Number.isFinite(s)) return '—';
  const m = Math.round(s / 60);
  if (Math.abs(m) < 90) return `${m} min`;
  const sign = m < 0 ? '−' : '';
  const a = Math.abs(m);
  return `${sign}${Math.floor(a / 60)} h ${String(a % 60).padStart(2, '0')} min`;
}

/** "the site exit (1 lane, 500 cars/h)" */
export function bottleneckText(b: Bottleneck): string {
  return `${b.label}, ${Math.round(b.capacityVph).toLocaleString('en-US')} cars/h`;
}

/** The headline: share out before the last route closes, with the departure band. */
export function shareOutSentence(t: EgressTiming): string {
  if (!t.known) return `Departure timing not assessed: ${t.note}.`;
  const band = `departures p10–p90 ${fmtMin(t.band.p10)}–${fmtMin(t.band.p90)} after the alert, “${t.curve.label}”`;
  if (t.windowS === Infinity) return `No route to a shelter closes during the run: ${pct(t.curve.maxShare)} of occupants leave by road eventually (${band}); the rest stay.`;
  if (t.windowS <= 0) return `0 % of occupants out before the last route closes — it closes ${fmtMin(-t.windowS)} before the alert (${band}).`;
  return `${pct(t.shareOut)} of occupants out before the last route closes (${band}); ${pct(t.shareInside)} still inside and ${pct(t.shareQueued)} queued at the exit when it closes.`;
}

/** Clearance time against the route window. */
export function clearanceSentence(t: EgressTiming): string {
  if (!t.known) return '';
  const cars = `${t.vehicles.toLocaleString('en-US')} car${t.vehicles === 1 ? '' : 's'} (${t.occupants.toLocaleString('en-US')} occupants ÷ ${t.personsPerVehicle.toFixed(2)})`;
  const via = `through ${bottleneckText(t.bottleneck)}`;
  const win = t.windowS === Infinity ? 'a route window that stays open through the run' : `route window ${t.windowS <= 0 ? '0 min' : fmtMin(t.windowS)}`;
  let s = `Clearance time ${fmtMin(t.clearanceS)} vs ${win}: ${cars} ${via}; the queue alone takes ${fmtMin(t.queueOnlyS)}.`;
  if (t.windowS !== Infinity) s += t.clearsInWindow ? ' The site clears before the way out closes.' : ' The way out closes before the site has cleared.';
  return s;
}

/** Plain-language caveats for the card and the report. */
export function timingCaveats(t: EgressTiming): string[] {
  const out = [
    `Departures follow a published average curve for flood warnings (${t.curve.source}); it starts when the warning reaches people — getting the warning out takes longer. ${pct(1 - t.curve.maxShare)} take no protective action within 8 hours on this curve.`,
    'One queue at one bottleneck: other traffic on the route (neighbours evacuating too) is not counted, so the clearance is a lower bound in a busy evacuation. Lane counts are assumed by road class; the road data has none.',
    'The window ends when the last shelter can no longer be reached — its route cut or the shelter itself flooded — minus the drive there; like the closure, an early estimate.',
    'On scenarios whose river rise is time-lapsed (the river-stage presets), the window is far shorter than the real event’s: enter a negative alert time for a warning issued before the run starts.',
  ];
  return out;
}

export const EGRESS_TIMING_METHOD = {
  title: 'Leaving by road: departures and the queue',
  text:
    'Departures after the alert follow Sorensen & Mileti’s (2015b) protective-action-initiation curves for dam and levee floods, ' +
    'P(t) = m·(1 − exp(−t²/(a·b²))) with t in minutes after the warning is received — by default the most likely curve for an unprepared ' +
    'population that sees the threat as likely (a 1.79, b 111.8 min, m 74.3 % within 8 h), as tabulated in Silva et al. (2025, NHESS 25:1501, ' +
    'Suppl. Table S2). Occupants become cars at 2.0 persons per car for homes (Census household size over 1.23 cars per evacuating household, ' +
    'KLD survey) and 1.18 for workplaces (NHTS 2017). The cars queue at the route’s bottleneck: the site exit (1 lane by default) or the ' +
    'weakest road class on the dry route — 500 cars/h per lane for a local street joining at a stop sign (HCM two-way-stop capacity into ' +
    '600 veh/h), 950 for a signalised road (HCM 1,900 pc/h/ln base saturation flow × 0.5 green), 1,600 for a highway (Hurricane Floyd ' +
    'observed). A point queue (Newell’s cumulative curves) gives the share through the bottleneck when the latest safe departure passes — ' +
    'each shelter’s closure minus its drive — and the clearance time. Not a traffic simulation.',
} as const;
