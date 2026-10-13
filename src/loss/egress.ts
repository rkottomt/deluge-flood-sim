/**
 * Egress from a site: can someone drive from it to a dry shelter, and from when can they not?
 *
 * The evacuation router (src/routing) answers for ONE depth field. The hazard accumulators (HazardFields) hold, per
 * cell, the deepest water of the run (maxDepth) and when water first arrived (firstWet, at 0.15 m). From those two a
 * "flood state at time t" is rebuilt for any t:
 *
 *     depth_t(c) = maxDepth(c)   if the cell was wet at reset (river, lake: bridged by the router's baseline)
 *                               or water arrived there at or before t (0 < firstWet(c) ≤ t)
 *                = 0             otherwise
 *
 * and the router is asked for a route at that state. depth_t only grows with t, so "every route to this shelter is
 * cut" is monotone in t and the moment it first holds is found by bisection over the sorted arrival times — exactly,
 * to the arrival of one cell, with ~20 router calls.
 *
 * This is an EARLY (pessimistic) estimate of the closure, by construction: a cell is given its peak depth the moment
 * water first reaches it, so a road is called flooded (≥ 0.3 m) as soon as 15 cm arrives on a stretch that later
 * reached 0.3 m. For a river rising to a held crest that is minutes early; for a flash flood that comes and goes it is
 * the right order but cannot say when a road REOPENS. Reopening is judged from the depth at the end of the run when
 * one is given (endDepth: the latest snapshot): still cut then → cut off for at least (end − closure).
 *
 * The LATEST SAFE DEPARTURE is what a car leaving the site needs: per shelter, its closure (its last route cut, or
 * the shelter itself under ≥ 0.3 m — the router skips a flooded shelter) minus the dry drive there, the latest over
 * the shelters. A shelter that floods, or whose road goes under, before a car leaving later could reach it does not
 * stretch the window. egressTiming.ts sets the occupants' departures and the queue at the exit against it.
 *
 * Shelters are the scenario's / user's shelters (AppState.shelters). A route needs a road within the router's snap
 * radius of the site and of the shelter; without road data or shelters the answer is "unknown", never "safe".
 */
import type { HazardFields, Shelter } from '../contracts';
import { ROAD_WET_DEPTH } from '../routing/constants';

/** The part of the evacuation router this module uses (src/routing createRouter() provides it). */
export interface EgressRouter {
  setBaselineWater?(depth: Float32Array | null, nx: number, ny: number): void;
  updateFlood(depth: Float32Array, nx: number, ny: number): unknown;
  route(
    start: { gx: number; gy: number },
    shelters: Shelter[],
  ): { state: 'ok' | 'blocked' | 'none'; polyline: Float32Array | null; lengthMeters: number; etaSeconds: number; shelter: Shelter | null; reason?: string | null; classMeters?: number[] };
}

export interface EgressShelter {
  name: string;
  /** A route to this shelter exists before any floodwater arrives (rivers at their reset level). */
  openAtStart: boolean;
  /** …and at the peak of the run. */
  openAtPeak: boolean;
  /** Early estimate of when the last route to this shelter closed, s since reset; NaN if it never closed (or never opened). */
  closesAt: number;
  /** Dry-network drive, m and s (NaN when there is none). */
  lengthM: number;
  etaS: number;
}

export interface EgressResult {
  /** False without roads or shelters (or with a site off the road network): then nothing below is meaningful. */
  known: boolean;
  /** Why it is unknown, plain words ('' when known). */
  note: string;
  /** Best route before the flood (any shelter). */
  openAtStart: boolean;
  /** Any route at the peak. */
  openAtPeak: boolean;
  /** Early estimate of when the LAST route to any shelter closed, s since reset; NaN if one stayed open. */
  lastRouteClosesAt: number;
  /** The router's reason at the peak when no route is left (e.g. 'cut-off', 'start-flooded'). */
  peakReason: string;
  /** Route still cut at the end of the run (endDepth given): true / false; null when not judged. */
  cutAtEnd: boolean | null;
  /** Simulated time at the end of the run, s. */
  endTime: number;
  /** Seconds the site was cut off, from lastRouteClosesAt to the end of the run when still cut then (a lower bound); NaN otherwise. */
  cutOffAtLeastS: number;
  /** Per shelter, in the order given. */
  shelters: EgressShelter[];
  /** Best route before the flood, grid polyline (null when none). */
  routeBefore: Float32Array | null;
  /** Best route at the peak (null when none). */
  routeAtPeak: Float32Array | null;
  /** Shelter the best route at the peak reaches. */
  peakShelter: string;
  /** Router calls made (cost diagnostics). */
  routerCalls: number;
  /**
   * Latest moment a car can still leave and reach a shelter before the way to it closes, s since reset: per shelter,
   * its closure minus its dry drive time, the latest over all shelters; +∞ when a route stays open through the peak,
   * NaN when there was no route at all. A shelter that floods, or whose last road goes under, before a car leaving
   * later could get there is not counted. (Optional so hand-built results stay valid; analyzeEgress always sets it.)
   */
  lastSafeDepartureAt?: number;
  /** Shelter that sets lastSafeDepartureAt ('' when none). */
  lastSafeShelter?: string;
  /** Metres of the best dry route on each road class (router.ts classMeters, CLASS_CODE order); null when unknown. */
  routeClassMeters?: number[] | null;
}

/** Arrival-ordered flood rebuild for one HazardFields (reused across sites and shelters). */
export class FloodTimeline {
  /** Cells that become wet during the run and are deep enough to matter to a road, by arrival time. */
  readonly order: Int32Array;
  readonly times: Float32Array;
  readonly depth: Float32Array;
  /** Number of `order` cells currently applied to `depth`. */
  private applied = 0;

  constructor(readonly fields: HazardFields) {
    const { nx, ny, firstWet, maxDepth } = fields;
    const n = nx * ny;
    this.depth = new Float32Array(n);
    let count = 0;
    for (let c = 0; c < n; c++) {
      const fw = firstWet[c];
      if (fw === 0) this.depth[c] = maxDepth[c];
      else if (fw > 0 && maxDepth[c] >= ROAD_WET_DEPTH) count++;
    }
    const idx = new Int32Array(count);
    let k = 0;
    for (let c = 0; c < n; c++) {
      const fw = firstWet[c];
      if (fw > 0 && maxDepth[c] >= ROAD_WET_DEPTH) idx[k++] = c;
    }
    const sorted = Array.from(idx).sort((a, b) => firstWet[a] - firstWet[b]);
    this.order = Int32Array.from(sorted);
    this.times = new Float32Array(this.order.length);
    for (let i = 0; i < this.order.length; i++) this.times[i] = firstWet[this.order[i]];
  }

  get count(): number {
    return this.order.length;
  }

  /** Apply the first `k` arrivals (0 = the start: only water present at reset; count = the peak). */
  seek(k: number): Float32Array {
    k = Math.max(0, Math.min(this.order.length, Math.floor(k)));
    const { order, depth } = this;
    const max = this.fields.maxDepth;
    while (this.applied < k) {
      const c = order[this.applied++];
      depth[c] = max[c];
    }
    while (this.applied > k) {
      const c = order[--this.applied];
      depth[c] = 0;
    }
    return depth;
  }
}

/** Water at reset (firstWet = 0) as a baseline field for the router's bridge detection. */
export function baselineFromFields(fields: HazardFields): Float32Array {
  const n = fields.nx * fields.ny;
  const b = new Float32Array(n);
  for (let c = 0; c < n; c++) if (fields.firstWet[c] === 0) b[c] = 1;
  return b;
}

const isOpen = (r: { state: string }) => r.state === 'ok';

/**
 * Egress from `start` (grid coords) to `shelters` over the flood in `fields`. The router must already carry the road
 * network (setNetwork) for this grid; its baseline is set here from the fields. `timeline` may be shared between
 * calls on the same fields (it is rebuilt otherwise). `endDepth`: the depth field at the end of the run, to tell
 * "still cut off" from "reopened".
 */
export function analyzeEgress(
  router: EgressRouter,
  fields: HazardFields,
  start: { gx: number; gy: number },
  shelters: readonly Shelter[],
  opts: { timeline?: FloodTimeline; endDepth?: Float32Array | null; hasRoads?: boolean } = {},
): EgressResult {
  const out: EgressResult = {
    known: false,
    note: '',
    openAtStart: false,
    openAtPeak: false,
    lastRouteClosesAt: NaN,
    peakReason: '',
    cutAtEnd: null,
    endTime: fields.simTime,
    cutOffAtLeastS: NaN,
    shelters: [],
    routeBefore: null,
    routeAtPeak: null,
    peakShelter: '',
    routerCalls: 0,
    lastSafeDepartureAt: NaN,
    lastSafeShelter: '',
    routeClassMeters: null,
  };
  if (opts.hasRoads === false) {
    out.note = 'No road data for this area.';
    return out;
  }
  if (!shelters.length) {
    out.note = 'No shelters on the map — add one with the Shelter tool.';
    return out;
  }
  const { nx, ny } = fields;
  const tl = opts.timeline && opts.timeline.fields === fields ? opts.timeline : new FloodTimeline(fields);
  router.setBaselineWater?.(baselineFromFields(fields), nx, ny);
  const list = shelters.slice();
  const ask = (k: number, which: Shelter[]) => {
    router.updateFlood(tl.seek(k), nx, ny);
    out.routerCalls++;
    return router.route(start, which);
  };

  // Before the flood: does the site reach any shelter at all?
  const before = ask(0, list);
  if (before.state === 'none') {
    out.note = before.reason === 'start-off-network' ? 'No road within reach of the site.' : before.reason === 'shelters-off-network' ? 'No shelter is near a road.' : 'No route could be planned.';
    return out;
  }
  out.known = true;
  out.openAtStart = isOpen(before);
  out.routeBefore = before.polyline ? before.polyline.slice() : null;
  out.routeClassMeters = isOpen(before) && before.classMeters ? before.classMeters.slice() : null;

  const peak = ask(tl.count, list);
  out.openAtPeak = isOpen(peak);
  out.routeAtPeak = isOpen(peak) && peak.polyline ? peak.polyline.slice() : null;
  out.peakShelter = isOpen(peak) ? (peak.shelter?.name ?? '') : '';
  out.peakReason = isOpen(peak) ? '' : String(peak.reason ?? 'cut-off');

  /** Smallest k in (lo, hi] at which `which` has no route, given open at lo and closed at hi. */
  const bisect = (which: Shelter[]): number => {
    let lo = 0;
    let hi = tl.count;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (isOpen(ask(mid, which))) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const timeOf = (k: number) => (k > 0 ? tl.times[k - 1] : 0);

  if (out.openAtStart && !out.openAtPeak) out.lastRouteClosesAt = timeOf(bisect(list));

  for (const s of list) {
    const one = [s];
    const b = ask(0, one);
    const e: EgressShelter = { name: s.name, openAtStart: isOpen(b), openAtPeak: false, closesAt: NaN, lengthM: isOpen(b) ? b.lengthMeters : NaN, etaS: isOpen(b) ? b.etaSeconds : NaN };
    if (e.openAtStart) {
      e.openAtPeak = isOpen(ask(tl.count, one));
      if (!e.openAtPeak) e.closesAt = timeOf(bisect(one));
    }
    out.shelters.push(e);
  }

  // The latest safe departure: a car leaving at t reaches shelter s at about t + its dry drive, so it must leave by
  // the shelter's closure minus that drive (an early estimate, like the closure itself).
  let lastSafe = -Infinity;
  for (const e of out.shelters) {
    if (!e.openAtStart) continue;
    const t = e.openAtPeak ? Infinity : e.closesAt - (Number.isFinite(e.etaS) ? e.etaS : 0);
    if (t > lastSafe) {
      lastSafe = t;
      out.lastSafeShelter = e.name;
    }
  }
  out.lastSafeDepartureAt = lastSafe === -Infinity ? NaN : lastSafe;

  if (opts.endDepth && opts.endDepth.length === nx * ny && out.openAtStart && !out.openAtPeak) {
    router.updateFlood(opts.endDepth, nx, ny);
    out.routerCalls++;
    out.cutAtEnd = !isOpen(router.route(start, list));
    if (out.cutAtEnd && Number.isFinite(out.lastRouteClosesAt)) out.cutOffAtLeastS = Math.max(0, fields.simTime - out.lastRouteClosesAt);
  }
  return out;
}
