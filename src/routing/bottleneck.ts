/**
 * Road egress as a QUEUE: how long a site's cars take to get out when they all use the same way out.
 *
 * Not traffic simulation. One bottleneck per route — the link with the least capacity, lanes × a per-lane discharge
 * rate by road class — and a point queue in front of it (Newell's cumulative-curve construction):
 *
 *     A(t)  cars that have left their parking space by t          (departure curve × cars: departure.ts)
 *     D(t)  cars through the bottleneck by t = min over s ≤ t of [ A(s) + c·(t − s) ]
 *     queue(t) = A(t) − D(t)
 *
 * With everyone leaving at once the clearance is cars / c; with a departure curve it is never shorter than the curve
 * itself and never shorter than cars / c.
 *
 * CAPACITY (vehicles per hour per lane; confidence tags as in pedestrianEvac.ts: [S] secondary, [M] from memory,
 * [I] illustrative assumption):
 *   • highway 1,600 — the highest per-lane flows observed on interstates during the Hurricane Floyd evacuation (1999),
 *     1,500–1,600 veh/h/ln (Southeast U.S. Hurricane Evacuation Study, USACE/FEMA/NOAA, 2000) [S]. HCM 6th ed.
 *     ch. 12 puts basic freeway capacity at 2,250–2,400 pc/h/ln [M]; evacuations have not reached it.
 *   • major / minor 950 — HCM 6th ed. ch. 19 base saturation flow 1,900 pc/h/ln at a signal [M] × the share of green
 *     the evacuating movement gets, 0.5 [I] (signals that are put on flash or manned by police can do better).
 *   • local 500 — a local street (or the site's driveway) joins the network at a stop or yield sign. HCM two-way
 *     stop control potential capacity of a minor-street right turn, c = v·e^(−v·tc/3600) / (1 − e^(−v·tf/3600)) with
 *     tc 6.2 s, tf 3.3 s [M] (HCM 6th ed. ch. 20 base values) against v = 600 veh/h of other traffic on the bigger
 *     road [I]: 505 veh/h, rounded to 500.
 *   • lanes in the evacuating direction: highway 2, major 2, minor 1, local 1 [I] — the baked road data carries
 *     the class of a road, not its lane count.
 *   • the site's own exit: `exitLanes` lanes (default 1 [I]) at the local rate.
 *
 * CARS from occupants: persons per car by use — 2.0 for homes (US Census 2020: 2.51 persons per household [M]; KLD's
 * Beaver Valley evacuation-time survey: 1.23 vehicles per evacuating household [S]; 2.51 / 1.23 = 2.04), 1.18 for
 * workplaces (NHTS 2017 average vehicle occupancy on work trips [M]). Hospitals, schools and care homes evacuate by
 * bus and ambulance — not modelled; their staff cars are counted at the workplace rate.
 *
 * Other traffic sharing the route (the neighbours evacuating too) is NOT counted, except as the 600 veh/h the local
 * exit has to merge into: the clearance here is a lower bound for a busy evacuation.
 *
 * Pure: no DOM.
 */
import type { Occupancy } from '../loss/value';
import { departedShare, departureQuantileS, type DepartureCurve } from './departure';

export type RoadClassCode = 0 | 1 | 2 | 3;
export const ROAD_CLASS_NAMES = ['highway', 'major road', 'minor road', 'local street'] as const;

/** Per-lane discharge at a bottleneck, vehicles/h/lane, by CLASS_CODE (highway, major, minor, local). */
export const LANE_FLOW_VPH: readonly number[] = [1600, 950, 950, 500];
/** Lanes in the evacuating direction, by CLASS_CODE [I]. */
export const CLASS_LANES: readonly number[] = [2, 2, 1, 1];
/** HCM base saturation flow at a signal, pc/h/ln [M], and the green share assumed for evacuating traffic [I]. */
export const HCM_BASE_SATURATION_FLOW = 1900;
export const SIGNAL_GREEN_SHARE = 0.5;
/** The site's exit onto the street: lanes by default [I], each at the local (stop-controlled) rate. */
export const DEFAULT_EXIT_LANES = 1;
/** A road class only counts as the route's bottleneck when the route runs on it for at least this long, m. */
export const MIN_BOTTLENECK_M = 20;

export const LANE_FLOW_SOURCES: readonly string[] = [
  'highway: 1,600 veh/h/ln, peak interstate flows in the Hurricane Floyd evacuation (Southeast U.S. Hurricane Evacuation Study, 2000)',
  'major / minor road: HCM 6th ed. base saturation flow 1,900 pc/h/ln at a signal × 0.5 of the green (assumption)',
  'local street and the site exit: 500 veh/h/ln, HCM two-way-stop capacity of a right turn into 600 veh/h of other traffic (tc 6.2 s, tf 3.3 s)',
];

/** HCM two-way stop control potential capacity of a minor-street movement, veh/h (tc, tf in s; v conflicting veh/h). */
export function twscCapacity(conflictingVph: number, tcS = 6.2, tfS = 3.3): number {
  const v = Math.max(1, conflictingVph);
  return (v * Math.exp((-v * tcS) / 3600)) / (1 - Math.exp((-v * tfS) / 3600));
}

/** Persons per evacuating car by planned use. */
export const PERSONS_PER_VEHICLE = { home: 2.0, work: 1.18 } as const;

export function defaultPersonsPerVehicle(occ: Occupancy): { value: number; basis: string } {
  if (occ === 'res' || occ === 'apt') return { value: PERSONS_PER_VEHICLE.home, basis: '2.0 per car: 2.51 persons per household (Census 2020) over 1.23 cars per evacuating household (KLD ETE survey)' };
  return { value: PERSONS_PER_VEHICLE.work, basis: '1.18 per car: NHTS 2017 work-trip vehicle occupancy' };
}

export function vehiclesFor(occupants: number, personsPerVehicle: number): number {
  if (!(occupants > 0)) return 0;
  return Math.max(1, Math.ceil(occupants / Math.max(1, personsPerVehicle)));
}

export interface Bottleneck {
  /** Vehicles per hour through it. */
  capacityVph: number;
  /** 'exit' = the site's own exit; otherwise the road class of the limiting link. */
  where: 'exit' | 'road';
  cls: RoadClassCode | -1;
  lanes: number;
  perLaneVph: number;
  label: string;
}

/**
 * The route's bottleneck: the site exit (exitLanes at the local rate) or the road class on the route with the least
 * lanes × per-lane flow. `classMeters` is the router's per-class length of the route (router.ts, CLASS_CODE order);
 * classes the route touches for less than MIN_BOTTLENECK_M (a snapping sliver) are skipped.
 */
export function routeBottleneck(classMeters: readonly number[] | null | undefined, exitLanes = DEFAULT_EXIT_LANES): Bottleneck {
  const lanes = Math.max(1, Math.round(exitLanes));
  let best: Bottleneck = { capacityVph: lanes * LANE_FLOW_VPH[3], where: 'exit', cls: -1, lanes, perLaneVph: LANE_FLOW_VPH[3], label: `the site exit (${lanes} lane${lanes === 1 ? '' : 's'})` };
  if (classMeters) {
    for (let k = 0; k < 4; k++) {
      if (!((classMeters[k] ?? 0) >= MIN_BOTTLENECK_M)) continue;
      const cap = CLASS_LANES[k] * LANE_FLOW_VPH[k];
      if (cap < best.capacityVph) best = { capacityVph: cap, where: 'road', cls: k as RoadClassCode, lanes: CLASS_LANES[k], perLaneVph: LANE_FLOW_VPH[k], label: `a ${ROAD_CLASS_NAMES[k]} on the route (${CLASS_LANES[k]} lane${CLASS_LANES[k] === 1 ? '' : 's'})` };
    }
  }
  return best;
}

export interface QueueResult {
  vehicles: number;
  capacityVph: number;
  /** Cars that leave at all (vehicles × the curve's maxShare). */
  leaving: number;
  /**
   * Seconds after the warning until the last car that leaves is through the bottleneck. The curve's long tail is cut
   * at its 99th percentile: the last 1 % of leavers are taken to leave then.
   */
  clearanceS: number;
  /** cars / capacity: the clearance if everyone left at the same moment, s. */
  queueOnlyS: number;
  /** Longest queue in front of the bottleneck, cars. */
  maxQueue: number;
}

const STEP_S = 10;
const LAST_SHARE = 0.99;

/** A(t): cars that have left by t s after the warning; the last 1 % of leavers go at the curve's 99th percentile. */
export function departedBy(vehicles: number, curve: DepartureCurve, s: number): number {
  if (!(s > 0) || !(vehicles > 0)) return 0;
  return s >= departureQuantileS(curve, LAST_SHARE) ? vehicles * curve.maxShare : vehicles * departedShare(curve, s);
}

/**
 * Cars through the bottleneck by `atS` seconds after the warning (D(t) above), departures following `curve`.
 * Exact for the point queue up to the STEP_S time grid.
 */
export function throughBy(vehicles: number, capacityVph: number, curve: DepartureCurve, atS: number): number {
  if (!(atS > 0) || !(vehicles > 0)) return 0;
  const c = capacityVph / 3600;
  if (!(c > 0)) return 0;
  // D(t) = min over s ≤ t of A(s) + c (t − s); A is increasing, so the min is at t itself or at some earlier s.
  let best = departedBy(vehicles, curve, atS);
  for (let s = 0; s < atS; s += STEP_S) {
    const v = departedBy(vehicles, curve, s) + c * (atS - s);
    if (v < best) best = v;
  }
  return Math.max(0, best);
}

export function bottleneckQueue(vehicles: number, capacityVph: number, curve: DepartureCurve): QueueResult {
  const V = Math.max(0, vehicles);
  const c = Math.max(0, capacityVph) / 3600;
  const leaving = V * curve.maxShare;
  const out: QueueResult = { vehicles: V, capacityVph, leaving, clearanceS: 0, queueOnlyS: c > 0 ? leaving / c : Infinity, maxQueue: 0 };
  if (!(leaving > 0)) return out;
  if (!(c > 0)) {
    out.clearanceS = Infinity;
    out.maxQueue = leaving;
    return out;
  }
  // March the queue: q' = arrivals − c while q > 0. The last 1 % of leavers go at the curve's 99th percentile.
  const target = leaving;
  const lastDep = departureQuantileS(curve, LAST_SHARE);
  const horizon = lastDep + leaving / c + 3600;
  let q = 0;
  let through = 0;
  let prevA = 0;
  for (let t = STEP_S; t <= horizon + STEP_S; t += STEP_S) {
    const A = departedBy(V, curve, t);
    q += A - prevA;
    prevA = A;
    const served = Math.min(q, c * STEP_S);
    q -= served;
    through += served;
    if (q > out.maxQueue) out.maxQueue = q;
    if (through >= target - 1e-6) {
      // Interpolate within the step.
      const over = through - target;
      out.clearanceS = t - (served > 0 ? (over / served) * STEP_S : 0);
      return out;
    }
  }
  out.clearanceS = Infinity;
  return out;
}
