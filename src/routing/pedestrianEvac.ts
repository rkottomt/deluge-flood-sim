/**
 * Evacuating a building on foot: N occupants, split into walking groups, leave through the building's exits after
 * the alert and walk the WalkNetwork (pedestrian.ts) to a refuge — a shelter or any high ground — or go up, if the
 * building has a floor safely above the water and is not at risk of structural failure (vertical evacuation).
 *
 *   everyone out of the door   T_out  = alert + pre-movement + N / exit flow
 *   everyone at a refuge       T_safe = T_out + walk of the slowest group departing at T_out
 *   X of N reach safety        person i leaves at alert + pre + i / flow; they make it if a refuge is still reachable
 *                              at their group's pace departing then (groups mixed evenly through the queue)
 *
 * NUMBERS AND SOURCES (confidence tags as in docs/research: [S] secondary, [M] from memory, not re-read for this
 * feature, [I] illustrative assumption):
 *   • Walking speeds: 1.22 m/s (4 ft/s) for able adults — the "slow walk" of tsunami-evacuation mapping (Wood &
 *     Schmidtlein 2012, Natural Hazards 62:275) and the planning pace of FEMA P-646 (2019) evacuation-time estimates
 *     [M]; 0.91 m/s (3.0 ft/s) for older adults — MUTCD 2009 §4E.06, the walking speed for slower pedestrians [M];
 *     0.6 m/s for people with mobility impairments or being assisted [I] (about 2 ft/s).
 *   • Exit flow: SFPE Handbook ch. "Employing the hydraulic model in assessing emergency movement" (Gwynne & Rosenbaum):
 *     maximum specific flow ≈ 1.3 persons/s per metre of EFFECTIVE width, effective width = clear width − 0.15 m
 *     boundary layer each side of a door [S: Thunderhead Engineering's Pathfinder SFPE reference applies 1.316 p/s/m].
 *   • Default exit width: IBC 1005.3.2 egress capacity, 0.2 in (5.1 mm) per occupant for doors and level components,
 *     and at least two exits of 32 in (0.81 m) clear [M]; we use 0.91 m (36 in) doors [I].
 *   • Default occupant load: IBC Table 1004.5 occupant load factors (gross floor area per occupant) [M] — a DESIGN
 *     maximum, so the default count is an upper bound; type the real number in.
 *   • Pre-movement (alert → first person through the door): 10 min [I]; drills and tsunami studies range from minutes
 *     to tens of minutes.
 *   • Vertical evacuation: a floor counts when its level is at least VERTICAL_FREEBOARD_M above the maximum depth at the
 *     site [I] (FEMA P-646 sets tsunami refuges 30 % / 10 ft above the inundation [M]; a river flood has no such
 *     rule) and the building is not in the fast-water collapse band (hazard.ts collapseShare < 0.1, state ≠ collapse).
 *
 * Pure: no DOM.
 */
import type { HazardFields } from '../contracts';
import { openCells } from '../loss/footprints';
import type { Occupancy, StructuralState } from '../loss/value';
import { unsafeForWalking, type WalkNetwork, type WalkSeed } from './pedestrian';

/**
 * When a site's own surroundings turn unsafe for people walking out (s; +∞ never): the median over its cells — half
 * the exits gone. With buildings as obstacles (HazardFields.blocked) the footprint itself stays dry, so the cells
 * against its walls are read instead (footprints.ts openCells, as site.ts and impact.ts do). Water present at reset is
 * skipped; unsafe water with no arrival time (firstWet −1) counts from the end of the run and is flagged `untimed`
 * (walkHazard's UNTIMED rule) — never from T+0.
 */
export function siteExitUnsafeAt(footprint: readonly number[], f: HazardFields): { t: number; untimed: boolean } {
  const cells = (f.blocked && openCells(footprint, 0, footprint.length, f.blocked, f.nx, f.ny)) || footprint;
  if (!cells.length) return { t: Infinity, untimed: false };
  const ts: Array<{ t: number; untimed: boolean }> = [];
  for (const c of cells) {
    const fw = f.firstWet[c];
    if (fw === 0) continue;
    if (!unsafeForWalking(f.maxDepth[c], f.maxSpeed[c], f.maxDV[c])) continue;
    ts.push(fw > 0 ? { t: fw, untimed: false } : { t: f.simTime, untimed: true });
  }
  const half = Math.ceil(cells.length / 2);
  if (ts.length < half) return { t: Infinity, untimed: false };
  ts.sort((a, b) => a.t - b.t);
  return ts[half - 1];
}

export type WalkGroupId = 'able' | 'older' | 'impaired';

export interface WalkGroup {
  id: WalkGroupId;
  label: string;
  /** m/s */
  speed: number;
  source: string;
}

export const WALK_GROUPS: Readonly<Record<WalkGroupId, WalkGroup>> = {
  able: { id: 'able', label: 'Able adults', speed: 1.22, source: '4 ft/s: Wood & Schmidtlein 2012 slow walk; FEMA P-646 planning pace [M]' },
  older: { id: 'older', label: 'Older adults', speed: 0.91, source: '3.0 ft/s: MUTCD 2009 §4E.06 slower pedestrians [M]' },
  impaired: { id: 'impaired', label: 'Mobility-impaired / assisted', speed: 0.6, source: '≈ 2 ft/s [I]' },
};

/** SFPE maximum specific flow, persons per second per metre of effective width [S]. */
export const SPECIFIC_FLOW = 1.3;
/** SFPE boundary layer at each side of a door, m. */
export const DOOR_BOUNDARY_M = 0.15;
/** Door clear width assumed for the default exits, m [I]. */
export const DOOR_WIDTH_M = 0.91;
/** IBC 1005.3.2: 0.2 in of egress width per occupant (doors, level components) [M]. */
export const EGRESS_WIDTH_PER_OCCUPANT_M = 0.2 * 0.0254;
/** Alert → first person out of the door, s [I]. */
export const DEFAULT_PRE_MOVEMENT_S = 600;
/** Freeboard of a vertical-evacuation floor above the max depth, m [I]. */
export const VERTICAL_FREEBOARD_M = 1.0;
/** collapseShare at or above which the building is no vertical refuge [I]. */
export const VERTICAL_MAX_COLLAPSE_SHARE = 0.1;

const SQFT = 0.09290304;
/** IBC Table 1004.5 occupant load factors, ft² gross per occupant [M]; [I] where the use has no row of its own. */
export const OCCUPANT_LOAD_FT2: Readonly<Record<string, { ft2: number; basis: string }>> = {
  res: { ft2: 200, basis: 'IBC 1004.5 residential, 200 ft² gross' },
  apt: { ft2: 200, basis: 'IBC 1004.5 residential, 200 ft² gross' },
  retail: { ft2: 60, basis: 'IBC 1004.5 mercantile, 60 ft² gross' },
  office: { ft2: 150, basis: 'IBC 1004.5 business, 150 ft² gross' },
  warehouse: { ft2: 500, basis: 'IBC 1004.5 storage/warehouse, 500 ft² gross' },
  industrial: { ft2: 100, basis: 'IBC 1004.5 industrial, 100 ft² gross' },
  hospital: { ft2: 240, basis: 'IBC 1004.5 institutional inpatient, 240 ft² gross' },
  school: { ft2: 50, basis: 'IBC 1004.5 educational (20 ft² net in classrooms) — 50 ft² gross over the whole building [I]' },
  datacenter: { ft2: 300, basis: 'no IBC row; 300 ft² gross [I]' },
  civic: { ft2: 100, basis: 'no single IBC row; 100 ft² gross [I]' },
};
const LOAD_OTHER = { ft2: 150, basis: 'IBC 1004.5 business, 150 ft² gross (default)' };

/** Share of occupants per walking group by use [I] (the residential older share is about the US 65+ share [M]). */
export const DEFAULT_MIX: Readonly<Record<string, Record<WalkGroupId, number>>> = {
  res: { able: 0.78, older: 0.17, impaired: 0.05 },
  apt: { able: 0.78, older: 0.17, impaired: 0.05 },
  hospital: { able: 0.3, older: 0.2, impaired: 0.5 },
  school: { able: 0.95, older: 0.02, impaired: 0.03 },
  civic: { able: 0.8, older: 0.15, impaired: 0.05 },
};
const MIX_OTHER: Record<WalkGroupId, number> = { able: 0.9, older: 0.07, impaired: 0.03 };

export function defaultOccupants(occ: Occupancy, gfaM2: number): { n: number; basis: string } {
  const f = OCCUPANT_LOAD_FT2[occ] ?? LOAD_OTHER;
  return { n: Math.max(1, Math.round(gfaM2 / (f.ft2 * SQFT))), basis: f.basis };
}

export function defaultMix(occ: Occupancy): Record<WalkGroupId, number> {
  return { ...(DEFAULT_MIX[occ] ?? MIX_OTHER) };
}

/** Total exit clear width, m: IBC capacity for N, at least two 0.91 m doors. */
export function defaultExitWidth(n: number): number {
  const need = Math.max(2 * DOOR_WIDTH_M, n * EGRESS_WIDTH_PER_OCCUPANT_M);
  return Math.ceil(need / DOOR_WIDTH_M) * DOOR_WIDTH_M;
}

/** Exit flow, persons per second, for a total clear width split into DOOR_WIDTH_M doors. */
export function exitFlow(widthM: number): number {
  if (!(widthM > 0)) return 0;
  const doors = Math.max(1, Math.round(widthM / DOOR_WIDTH_M));
  return SPECIFIC_FLOW * Math.max(0.3, widthM - 2 * DOOR_BOUNDARY_M * doors);
}

export interface VerticalEvac {
  /** Some floor is high enough and the building is not in the collapse band. */
  feasible: boolean;
  /** Lowest floor (1 = ground floor) whose level clears max depth + freeboard; NaN when none. */
  floor: number;
  /** That floor's level above grade, m. */
  floorLevelM: number;
  /** Max depth + freeboard, m above grade. */
  needM: number;
  reason: string;
}

export function verticalEvacuation(o: { floors: number; firstFloorHeight: number; storeyHeight: number; maxDepth: number; collapseShare: number; state: StructuralState }): VerticalEvac {
  const need = Math.max(0, o.maxDepth) + VERTICAL_FREEBOARD_M;
  let floor = NaN, level = NaN;
  for (let k = 1; k <= Math.max(1, Math.floor(o.floors)); k++) {
    const lv = o.firstFloorHeight + (k - 1) * o.storeyHeight;
    if (lv >= need) {
      floor = k;
      level = lv;
      break;
    }
  }
  const structural = o.state === 'collapse' || o.collapseShare >= VERTICAL_MAX_COLLAPSE_SHARE;
  let reason: string;
  if (structural) reason = `fast water puts the building in the collapse band (${Math.round(o.collapseShare * 100)} % of the way to total loss) — do not shelter in it`;
  else if (!Number.isFinite(floor)) reason = `no floor reaches ${need.toFixed(1)} m above grade (max depth ${o.maxDepth.toFixed(2)} m + ${VERTICAL_FREEBOARD_M} m freeboard)`;
  else reason = `floor ${floor} (${level.toFixed(1)} m above grade) clears the ${o.maxDepth.toFixed(2)} m max depth + ${VERTICAL_FREEBOARD_M} m freeboard`;
  return { feasible: !structural && Number.isFinite(floor), floor, floorLevelM: level, needM: need, reason };
}

export interface GroupShare {
  id: WalkGroupId;
  share: number;
}

export interface PeopleEvacInput {
  occupants: number;
  mix: readonly GroupShare[];
  /** Total exit clear width, m. */
  exitWidthM: number;
  preMovementS: number;
  /** When the alert goes out, s since reset. */
  alertTime: number;
  /** When the building's own surroundings turn unsafe for people (nobody leaves after), s; +∞ if never. */
  exitUnsafeAt: number;
  /** exitUnsafeAt is the end-of-run fallback for water with no arrival time (siteExitUnsafeAt). */
  exitUntimed?: boolean;
  /** For vertical evacuation. */
  building: { floors: number; firstFloorHeight: number; storeyHeight: number; maxDepth: number; collapseShare: number; state: StructuralState } | null;
}

export interface GroupResult {
  id: WalkGroupId;
  label: string;
  speed: number;
  share: number;
  people: number;
  /** Latest departure from the door that still reaches a refuge, s; NaN none, +∞ beyond the run. */
  latestDeparture: number;
  /** Walk time departing at the first-out moment, s (NaN when none). */
  walkS: number;
  /** Of this group, how many reach a refuge. */
  reach: number;
}

export interface PeopleEvacResult {
  /** False without a walking network near the site or without a flood read. */
  known: boolean;
  note: string;
  occupants: number;
  exitFlowPerS: number;
  /** alert + pre-movement + N / flow, s. */
  everyoneOutAt: number;
  /** Everyone at a refuge (slowest group, last out), s; NaN when not everyone makes it. */
  everyoneSafeAt: number;
  reach: number;
  groups: GroupResult[];
  /** The able-adult route at the first-out moment (or the slowest group's when that fails). */
  route: {
    polyline: Float32Array;
    meters: number;
    refuge: string;
    refugeKind: 'shelter' | 'high-ground';
    via: string;
    /** No group reaches a refuge: this is the walk the flood closed (dry-network route). */
    cut: boolean;
  } | null;
  vertical: VerticalEvac | null;
  /** Simulated span the answer covers, s. */
  horizon: number;
  alertTime: number;
  speedsKnown: boolean;
  /** Streets (and the exits, when `exitUntimed`) unsafe only through water with no arrival time: closed from the end of the run. */
  untimedUnsafe: number;
  exitUntimed: boolean;
}

/**
 * Evacuate `occupants` from (gx, gy) over `net` (setFields() already called). The search runs ~25 times per group, a
 * few ms each on a city network.
 */
export function analyzePeopleEvac(net: WalkNetwork, start: { gx: number; gy: number }, input: PeopleEvacInput): PeopleEvacResult {
  const hz = net.hazard;
  const N = Math.max(0, Math.round(input.occupants));
  const flow = exitFlow(input.exitWidthM);
  const t1 = input.alertTime + input.preMovementS;
  const outAt = t1 + (flow > 0 ? N / flow : Infinity);
  const out: PeopleEvacResult = {
    known: false,
    note: '',
    occupants: N,
    exitFlowPerS: flow,
    everyoneOutAt: outAt,
    everyoneSafeAt: NaN,
    reach: 0,
    groups: [],
    route: null,
    vertical: input.building ? verticalEvacuation(input.building) : null,
    horizon: hz?.simTime ?? 0,
    alertTime: input.alertTime,
    speedsKnown: hz?.speedsKnown ?? false,
    untimedUnsafe: hz?.untimedUnsafe ?? 0,
    exitUntimed: !!input.exitUntimed && Number.isFinite(input.exitUnsafeAt),
  };
  if (!hz) {
    out.note = 'No flood read yet.';
    return out;
  }
  const seeds: WalkSeed[] = net.seeds(start.gx, start.gy);
  if (!seeds.length) {
    out.note = 'No street within walking reach of the site (300 m).';
    return out;
  }
  if (net.refugeCount() === 0) {
    out.note = 'No refuge on this map: no shelter and no ground that stays dry above the water.';
    return out;
  }
  out.known = true;
  const horizon = Math.max(hz.simTime, t1);
  // Nobody leaves once the building's own surroundings are unsafe.
  const lastExit = Math.min(horizon, input.exitUnsafeAt);
  const shares = normalise(input.mix);
  let reach = 0;
  let everyoneSafe = true;
  let slowestArrive = -Infinity;
  for (const { id, share } of shares) {
    const g = WALK_GROUPS[id];
    const people = N * share;
    let latest = lastExit < 0 ? NaN : net.latestDeparture(seeds, g.speed, 0, Math.max(0, lastExit), 2);
    // A finite exit-unsafe moment caps an "always reachable" answer.
    if (latest === Infinity && Number.isFinite(input.exitUnsafeAt)) latest = input.exitUnsafeAt;
    const first = net.search(seeds, t1, g.speed);
    const walkS = first.ok && t1 <= lastExit ? first.arrive - t1 : NaN;
    // Persons of this group leave evenly from t1 to outAt; those leaving by `latest` make it.
    let made: number;
    if (Number.isNaN(latest)) made = 0;
    else if (latest === Infinity || outAt <= latest) made = people;
    else made = latest < t1 ? 0 : people * Math.min(1, ((latest - t1) * flow) / Math.max(1, N));
    reach += made;
    if (made < people - 1e-9) everyoneSafe = false;
    else {
      const last = net.search(seeds, outAt, g.speed);
      if (last.ok) slowestArrive = Math.max(slowestArrive, last.arrive);
      else if (people > 0) {
        // Reachable "beyond the run" (latest = +∞) but the search at outAt past the horizon still uses the same
        // closures, so a failure here means the timeline closed it: count as not everyone.
        everyoneSafe = false;
      }
    }
    out.groups.push({ id, label: g.label, speed: g.speed, share, people, latestDeparture: latest, walkS, reach: made });
  }
  out.reach = Math.floor(reach + 1e-6);
  out.everyoneSafeAt = everyoneSafe && Number.isFinite(slowestArrive) ? slowestArrive : NaN;
  // The route to draw: able adults leaving first (else any group that makes it).
  const order = [...shares].sort((a, b) => WALK_GROUPS[b.id].speed - WALK_GROUPS[a.id].speed);
  for (const { id } of order) {
    const g = WALK_GROUPS[id];
    for (const t of [t1, 0]) {
      const r = net.search(seeds, t, g.speed);
      if (!r.ok) continue;
      const rt = net.route(start.gx, start.gy, r.node);
      const shelter = net.refugeLabel(r.node);
      // Found only departing at T+0: the walk was open before the alert and closed by the first-out moment — cut.
      out.route = { ...rt, refuge: shelter || (net.streetAt(r.node) ? `high ground on ${net.streetAt(r.node)}` : 'high ground'), refugeKind: shelter ? 'shelter' : 'high-ground', via: net.mainStreet(r.node), cut: t !== t1 };
      break;
    }
    if (out.route) break;
  }
  if (!out.route) {
    // Nobody makes it: show the walk the flood closed (the dry-network route), drawn as cut.
    const r = net.search(seeds, 0, WALK_GROUPS.able.speed, { ignoreHazard: true });
    if (r.ok) {
      const rt = net.route(start.gx, start.gy, r.node);
      const shelter = net.refugeLabel(r.node);
      out.route = { ...rt, refuge: shelter || (net.streetAt(r.node) ? `high ground on ${net.streetAt(r.node)}` : 'high ground'), refugeKind: shelter ? 'shelter' : 'high-ground', via: net.mainStreet(r.node), cut: true };
    }
  }
  return out;
}

function normalise(mix: readonly GroupShare[]): GroupShare[] {
  const valid = mix.filter((m) => m.share > 0 && Number.isFinite(m.share) && WALK_GROUPS[m.id]);
  const sum = valid.reduce((a, m) => a + m.share, 0);
  return sum > 0 ? valid.map((m) => ({ id: m.id, share: m.share / sum })) : [{ id: 'able', share: 1 }];
}

const tPlus = (s: number) => {
  if (!Number.isFinite(s)) return '—';
  const sign = s < -30 ? 'T−' : 'T+';
  const m = Math.abs(Math.round(s / 60));
  return m < 90 ? `${sign}${m} min` : `${sign}${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

/** The three headline sentences: everyone out, X of N, vertical evacuation. */
export function peopleEvacSentences(r: PeopleEvacResult): string[] {
  if (!r.known) return [`Evacuation on foot not assessed: ${r.note}`];
  const out: string[] = [];
  const alert = `if the alert goes out at ${tPlus(r.alertTime)}`;
  const route = r.route ? ` (${r.route.cut ? 'the walk it closed: ' : ''}${r.route.refuge}, ${r.route.meters >= 995 ? `${(r.route.meters / 1000).toFixed(1)} km` : `${Math.round(r.route.meters / 10) * 10} m`} on foot${r.route.via ? ` via ${r.route.via}` : ''})` : '';
  if (Number.isFinite(r.everyoneSafeAt)) {
    out.push(`Everyone out of the building by ${tPlus(r.everyoneOutAt)} and at a refuge by ${tPlus(r.everyoneSafeAt)} ${alert}${route}.`);
  } else {
    out.push(`Everyone out of the building by ${tPlus(r.everyoneOutAt)} ${alert} — but not everyone can still reach a refuge on foot${route}.`);
  }
  out.push(`With the alert at ${tPlus(r.alertTime)}, ${r.reach.toLocaleString('en-US')} of ${r.occupants.toLocaleString('en-US')} reach safety on foot.`);
  const v = r.vertical;
  if (v) out.push(`Vertical evacuation feasible: ${v.feasible ? 'yes' : 'no'} — ${v.reason}.`);
  if (r.untimedUnsafe > 0 || r.exitUntimed) {
    const what = [r.exitUntimed ? 'the site’s exits' : '', r.untimedUnsafe > 0 ? `${r.untimedUnsafe} street segment${r.untimedUnsafe === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
    out.push(`Untimed: ${what} turn unsafe only through thin, fast water that never stood 15 cm deep, so it has no arrival time — counted as unsafe from the end of the run (${tPlus(r.horizon)}).`);
  }
  return out;
}

export { tPlus as formatTPlus };
