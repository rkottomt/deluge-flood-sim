/**
 * What a building depends on, and what the flood does to it (infra.ts exposures):
 *
 *   power      the NEAREST substation in a straight line — a Voronoi service area, which is only an APPROXIMATION:
 *              real feeders follow the utility's network, and a substation outside this map may serve the site
 *   water      the nearest water works; telecom: the nearest exchange; wastewater: the nearest wastewater plant
 *              (same approximation — a city usually has one or two, so this is "the system", not a service area)
 *   hospital   the nearest hospital BY ROAD at the flood's peak, with flooded roads closed (the evacuation router over
 *   fire       the arrival-ordered flood of egress.ts), and when the last route to one was cut
 *
 * and the flags a lender or an operator asks about: "site dry but its substation floods", "nearest hospital unreachable".
 *
 * DOWNTIME. The business-interruption heuristic (hazard.ts downtimeDays: max(access days, clean-up + damage × rebuild +
 * utility days)) gets its utility days from here: the longest restoration among the site's failed / impaired
 * utilities (they are restored in parallel). The restoration days are a LABELLED HEURISTIC [I] — round numbers in the
 * range utilities reported after Sandy (most customers back within about two weeks, flooded substations in days to
 * weeks) [S/M], not a fitted model.
 *
 * Pure: no DOM.
 */
import type { HazardFields, Shelter } from '../contracts';
import { distanceM, FACILITY_LABELS, type FacilityKind } from '../data/facilities';
import { baselineFromFields, FloodTimeline, type EgressRouter } from './egress';
import { cleanupDays } from './hazard';
import type { FacilityExposure, FacilityStatus } from './infra';

/** Utility restoration after the flood, days, by status [I]. */
export const UTILITY_RESTORATION_DAYS: Readonly<Record<'power' | 'water' | 'telecom' | 'wastewater', Record<Exclude<FacilityStatus, 'operational'>, number>>> = {
  power: { impaired: 2, failed: 10 },
  water: { impaired: 3, failed: 14 },
  telecom: { impaired: 1, failed: 7 },
  wastewater: { impaired: 2, failed: 7 },
};

/** Nearest-facility dependencies farther than this are flagged as possibly served from off the map, m. */
export const FAR_DEPENDENCY_M = 5000;
/** Facilities offered to the router per type (the straight-line nearest), to bound its work. */
const ROAD_CANDIDATES = 4;

export type UtilityKind = 'power' | 'water' | 'telecom' | 'wastewater';
const UTILITY_FACILITY: Readonly<Record<UtilityKind, FacilityKind>> = { power: 'substation', water: 'water_works', telecom: 'telecom', wastewater: 'wastewater_plant' };

export interface UtilityDependency {
  utility: UtilityKind;
  exposure: FacilityExposure;
  distanceM: number;
  /** Farther than FAR_DEPENDENCY_M: may well be served from elsewhere. */
  far: boolean;
}

export interface ReachDependency {
  kind: 'hospital' | 'fire_station';
  /** Any facility of the kind on the map. */
  known: boolean;
  /** Before the flood: nearest by road. */
  dryName: string;
  dryEtaS: number;
  /** At the peak. */
  reachable: boolean;
  peakName: string;
  peakEtaS: number;
  /** Early estimate of when the last route to one of them was cut, s; NaN when not cut. */
  cutAt: number;
  note: string;
}

export interface SiteDependencies {
  utilities: UtilityDependency[];
  hospital: ReachDependency | null;
  fire: ReachDependency | null;
  /** Plain-language flags. */
  flags: string[];
  /** Longest restoration among the site's affected utilities, days [I]. */
  utilityDays: number;
  /** Which utility sets it ('' when none). */
  utilityDaysFrom: string;
}

/** Nearest facility of a kind by straight line (lon/lat). */
function nearest(ex: readonly FacilityExposure[], kind: FacilityKind, lon: number, lat: number, k = 1): Array<{ e: FacilityExposure; d: number }> {
  return ex
    .filter((e) => e.facility.kind === kind && e.inside)
    .map((e) => ({ e, d: distanceM(lon, lat, e.facility.lon, e.facility.lat) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
}

/**
 * Road reach from a site to the nearest of `targets` before the flood and at its peak, and when the last route was cut
 * (bisection over the arrival-ordered flood, ~20 router calls when it is cut, 2 otherwise).
 */
function reach(kind: 'hospital' | 'fire_station', router: EgressRouter, tl: FloodTimeline, start: { gx: number; gy: number }, targets: FacilityExposure[]): ReachDependency {
  const out: ReachDependency = { kind, known: targets.length > 0, dryName: '', dryEtaS: NaN, reachable: false, peakName: '', peakEtaS: NaN, cutAt: NaN, note: '' };
  if (!targets.length) {
    out.note = `no ${FACILITY_LABELS[kind].toLowerCase()} on this map`;
    return out;
  }
  const shelters: Shelter[] = targets.map((t) => ({ name: t.facility.name || FACILITY_LABELS[kind], gx: t.gx, gy: t.gy }));
  const { nx, ny } = tl.fields;
  const ask = (k: number) => {
    router.updateFlood(tl.seek(k), nx, ny);
    return router.route(start, shelters);
  };
  const before = ask(0);
  if (before.state === 'none') {
    out.note = before.reason === 'start-off-network' ? 'no road near the site' : 'not on the road network';
    return out;
  }
  if (before.state === 'ok') {
    out.dryName = before.shelter?.name ?? '';
    out.dryEtaS = before.etaSeconds;
  }
  const peak = ask(tl.count);
  out.reachable = peak.state === 'ok';
  if (out.reachable) {
    out.peakName = peak.shelter?.name ?? '';
    out.peakEtaS = peak.etaSeconds;
  } else if (before.state === 'ok') {
    let lo = 0, hi = tl.count;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (ask(mid).state === 'ok') lo = mid;
      else hi = mid;
    }
    out.cutAt = hi > 0 ? tl.times[hi - 1] : 0;
  }
  return out;
}

export interface DependencyContext {
  fields: HazardFields;
  exposures: readonly FacilityExposure[];
  /** A car router carrying this grid's roads (null: no road reach). */
  router: EgressRouter | null;
  timeline?: FloodTimeline;
}

const tPlus = (s: number) => {
  if (!Number.isFinite(s)) return '—';
  const m = Math.round(s / 60);
  return m < 90 ? `T+${m} min` : `T+${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

/** Dependencies of a site at (lon, lat) / grid (gx, gy) that itself is `siteWet` (reached by the flood). */
export function siteDependencies(site: { lon: number; lat: number; gx: number; gy: number; siteWet: boolean }, ctx: DependencyContext): SiteDependencies {
  const utilities: UtilityDependency[] = [];
  for (const u of Object.keys(UTILITY_FACILITY) as UtilityKind[]) {
    const n = nearest(ctx.exposures, UTILITY_FACILITY[u], site.lon, site.lat)[0];
    if (n) utilities.push({ utility: u, exposure: n.e, distanceM: n.d, far: n.d > FAR_DEPENDENCY_M });
  }
  let hospital: ReachDependency | null = null;
  let fire: ReachDependency | null = null;
  if (ctx.router) {
    const tl = ctx.timeline && ctx.timeline.fields === ctx.fields ? ctx.timeline : new FloodTimeline(ctx.fields);
    ctx.router.setBaselineWater?.(baselineFromFields(ctx.fields), ctx.fields.nx, ctx.fields.ny);
    const start = { gx: site.gx, gy: site.gy };
    hospital = reach('hospital', ctx.router, tl, start, nearest(ctx.exposures, 'hospital', site.lon, site.lat, ROAD_CANDIDATES).map((x) => x.e));
    fire = reach('fire_station', ctx.router, tl, start, nearest(ctx.exposures, 'fire_station', site.lon, site.lat, ROAD_CANDIDATES).map((x) => x.e));
  }
  const flags: string[] = [];
  let utilityDays = 0;
  let utilityDaysFrom = '';
  for (const u of utilities) {
    const st = u.exposure.status;
    if (st === 'operational' || u.far) continue;
    const days = UTILITY_RESTORATION_DAYS[u.utility][st];
    if (days > utilityDays) ((utilityDays = days), (utilityDaysFrom = `${u.utility} (${facilityName(u.exposure)} ${st})`));
    if (u.utility === 'power' && st === 'failed') {
      const when = Number.isFinite(u.exposure.failedAt) ? ` at ${tPlus(u.exposure.failedAt)}` : '';
      flags.push(site.siteWet ? `Its substation (${facilityName(u.exposure)}) also floods${when} — power is lost even where the building is protected.` : `Site stays dry but its substation (${facilityName(u.exposure)}) floods${when} — expect a power outage.`);
    }
  }
  for (const r of [hospital, fire]) {
    if (!r || !r.known || !Number.isFinite(r.dryEtaS)) continue;
    const what = r.kind === 'hospital' ? 'hospital' : 'fire station';
    if (!r.reachable) flags.push(`Nearest ${what} unreachable by road at the peak${Number.isFinite(r.cutAt) ? ` (the last route was cut at ${tPlus(r.cutAt)})` : ''}.`);
  }
  return { utilities, hospital, fire, flags, utilityDays, utilityDaysFrom };
}

export function facilityName(e: FacilityExposure): string {
  return e.facility.name || `Unnamed ${FACILITY_LABELS[e.facility.kind].toLowerCase()} (OSM ${e.facility.id})`;
}

/** "Substation X floods at T+42 min (approximate service area)" and the like, one line per utility. */
export function utilityLine(u: UtilityDependency): string {
  const e = u.exposure;
  const name = facilityName(e);
  const far = u.far ? `, ${(u.distanceM / 1000).toFixed(1)} km away — may be served from elsewhere` : `, ${u.distanceM < 995 ? `${Math.round(u.distanceM / 10) * 10} m` : `${(u.distanceM / 1000).toFixed(1)} km`} away`;
  const approx = u.utility === 'power' ? ' (approximate service area: nearest substation' : ' (approximate: nearest on the map';
  if (e.status === 'failed') return `${name} floods (${e.depth.toFixed(2)} m)${Number.isFinite(e.failedAt) ? ` at ${tPlus(e.failedAt)}` : ''} — out of service${approx}${far})`;
  if (e.status === 'impaired') return `${name} impaired (${e.depth.toFixed(2)} m)${Number.isFinite(e.impairedAt) ? ` from ${tPlus(e.impairedAt)}` : ''}${approx}${far})`;
  return `${name} stays dry${approx}${far})`;
}

export function reachLine(r: ReachDependency): string {
  if (!r.known) return r.note;
  if (!Number.isFinite(r.dryEtaS)) return r.note || 'no road route even before the flood';
  const dry = `${r.dryName}, ${Math.max(1, Math.round(r.dryEtaS / 60))} min by road before the flood`;
  if (r.reachable) return r.peakName === r.dryName ? `${dry}; still reachable at the peak (${Math.max(1, Math.round(r.peakEtaS / 60))} min)` : `${dry}; at the peak only ${r.peakName} (${Math.max(1, Math.round(r.peakEtaS / 60))} min)`;
  return `${dry}; UNREACHABLE at the peak${Number.isFinite(r.cutAt) ? ` — last route cut at ${tPlus(r.cutAt)}` : ''}`;
}

/**
 * Downtime with dependencies, days (heuristic): the site's own downtime (`baseDays`, hazard.ts downtimeDays) or its
 * clean-up + damage × rebuild + the utility days, whichever is longer — the same formula with utilityDays filled in.
 */
export function downtimeWithDependencies(o: { baseDays: number; depthAboveFloor: number; damage: number; rebuildDays: number; utilityDays: number }): number {
  const site = cleanupDays(o.depthAboveFloor >= 0.05 ? o.depthAboveFloor : 0) + Math.max(0, Math.min(1, o.damage)) * o.rebuildDays + Math.max(0, o.utilityDays);
  return Math.max(o.baseDays || 0, site);
}
