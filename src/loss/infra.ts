/**
 * Critical facilities in a flood: exposure (depth, first arrival, time under water), operating status by documented
 * or labelled depth thresholds per facility type, and — in infraDeps.ts — what each building depends on.
 *
 * EXPOSURE. Each facility is sampled over the cells within its radius (an area feature's half bounding-box diagonal,
 * capped at EXPOSURE_RADIUS_M; at least the cell under its point). Water present at reset (a river beside a water
 * intake, under a bridge) is not floodwater and is skipped. A bridge is judged by its two LANDINGS — the cells at the
 * ends of its deck — since its span crosses the river by design: a bridge whose approaches flood is closed to traffic
 * even when the deck stays dry. Deck overtopping, scour and debris loading are not modelled.
 *
 * TIMING is early (pessimistic), like egress.ts: a cell whose maximum crosses a threshold is taken to cross it when
 * water first stood 15 cm deep there (HazardFields.firstWet). "Fails at T+42 min" therefore means "water arrived at
 * T+42 min on ground that later reached the failure depth".
 *
 * THRESHOLDS. Confidence tags as in docs/research: [S] secondary source, [M] from memory, not re-read for this
 * feature, [I] illustrative assumption. No single standard gives a flood depth at which each facility type stops
 * working; these are SCREENING values, shown with their basis in the UI and the report.
 *
 * Pure: no DOM.
 */
import type { HazardFields } from '../contracts';
import { FACILITY_KINDS, type Facility, type FacilityKind } from '../data/facilities';

export type FacilityStatus = 'operational' | 'impaired' | 'failed';

export interface FacilityThreshold {
  /** Max depth (m) from which the facility is impaired / out of service. */
  impaired: number;
  failed: number;
  basis: string;
}

export const FACILITY_THRESHOLDS: Readonly<Record<FacilityKind, FacilityThreshold>> = {
  substation: {
    impaired: 0.15,
    failed: 0.45,
    basis:
      'Substations: impaired once water stands in the yard (0.15 m); out of service at 0.45 m [I] — mid-range of the 0.3–0.6 m used for ' +
      'functional failure of substations in flood-dependency studies (control cabinets, relays and low-voltage panels sit near grade; ' +
      'e.g. arXiv:2609.10473 tests 0.3–0.9 m [S]). Equipment DAMAGE comes much deeper (Hazus substation curves start near 1.2 m [S]); ' +
      'UK ENA ETR 138 asks grid and primary substations to be protected to the 1-in-100 (fluvial) / 1-in-200 (coastal) flood [S].',
  },
  power_plant: { impaired: 0.3, failed: 1.0, basis: 'Power plants: impaired at 0.3 m, out at 1.0 m [I] (switchyard and auxiliaries near grade).' },
  hospital: {
    impaired: 0.15,
    failed: 0.6,
    basis:
      'Hospitals: impaired when water reaches the site (0.15 m: basements and ground-floor services — Sandy 2012 closed NYU Langone and ' +
      'Bellevue when basement fuel pumps and electrical gear flooded [S]); out of service at 0.6 m on the ground floor [I].',
  },
  clinic: { impaired: 0.15, failed: 0.3, basis: 'Clinics: impaired at 0.15 m, closed at 0.3 m (single storey, at grade) [I].' },
  fire_station: { impaired: 0.15, failed: 0.6, basis: 'Fire stations: impaired at 0.15 m; out at 0.6 m, about the fording depth of a fire engine [I/M].' },
  police: { impaired: 0.15, failed: 0.6, basis: 'Police stations: impaired at 0.15 m; out at 0.6 m [I].' },
  water_works: { impaired: 0.3, failed: 1.0, basis: 'Water works: impaired at 0.3 m; out at 1.0 m (pump motors and controls) [I].' },
  wastewater_plant: { impaired: 0.3, failed: 1.0, basis: 'Wastewater plants: impaired at 0.3 m; out at 1.0 m [I]. Many sit low by design; overflows begin earlier.' },
  telecom: { impaired: 0.15, failed: 0.5, basis: 'Telecom exchanges: impaired at 0.15 m; out at 0.5 m [I] (Sandy flooded Verizon’s 140 West St. cable vault [S]).' },
  bridge: { impaired: 0.05, failed: 0.3, basis: 'Bridges: closed when an approach is under 0.3 m (the road router’s impassable depth); wet at 0.05 m. Deck and scour not modelled.' },
  fuel: { impaired: 0.15, failed: 0.6, basis: 'Fuel stations: pumps shut at 0.15 m (water in tanks and dispensers); out at 0.6 m [I].' },
};

/** Area facilities are sampled within this of their centre, m. */
export const EXPOSURE_RADIUS_M = 60;
const ARRIVAL = 0.15;

export interface FacilityExposure {
  facility: Facility;
  /** Grid position (null when outside the map). */
  gx: number;
  gy: number;
  inside: boolean;
  /** Max depth over the sampled cells, m. */
  depth: number;
  speed: number;
  /** First arrival (≥ 0.15 m), s since reset; NaN if never. */
  firstWet: number;
  /** Early estimate of when it became impaired / failed, s; NaN if never. */
  impairedAt: number;
  failedAt: number;
  /** Longest time a sampled cell stayed wet, s. */
  wetSeconds: number;
  status: FacilityStatus;
}

export interface InfraSummary {
  total: number;
  inside: number;
  failed: number;
  impaired: number;
  byKind: Record<FacilityKind, { total: number; failed: number; impaired: number }>;
}

/** Cells to sample for a facility: every cell within r of (gx, gy) (at least the one under it). */
function cellsAround(gx: number, gy: number, rCells: number, nx: number, ny: number): number[] {
  const out: number[] = [];
  const i0 = Math.floor(gx), j0 = Math.floor(gy);
  const R = Math.ceil(rCells);
  for (let j = j0 - R; j <= j0 + R; j++) {
    for (let i = i0 - R; i <= i0 + R; i++) {
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      if (Math.hypot(i + 0.5 - gx, j + 0.5 - gy) > rCells + 0.71 && !(i === i0 && j === j0)) continue;
      out.push(j * nx + i);
    }
  }
  return out;
}

/**
 * Exposure and status of every facility in a flood. `toGrid` maps lon/lat to the FIELDS' grid; `cellSize` is that
 * grid's cell size in m.
 */
export function assessFacilities(list: readonly Facility[], f: HazardFields, toGrid: (lon: number, lat: number) => [number, number], cellSize: number): FacilityExposure[] {
  const { nx, ny } = f;
  return list.map((fac) => {
    const [gx, gy] = toGrid(fac.lon, fac.lat);
    const inside = gx >= 0 && gy >= 0 && gx < nx && gy < ny;
    const ex: FacilityExposure = { facility: fac, gx, gy, inside, depth: 0, speed: 0, firstWet: NaN, impairedAt: NaN, failedAt: NaN, wetSeconds: 0, status: 'operational' };
    if (!inside) return ex;
    let cells: number[];
    if (fac.kind === 'bridge' && fac.ends) {
      const [ax, ay] = toGrid(fac.ends[0], fac.ends[1]);
      const [bx, by] = toGrid(fac.ends[2], fac.ends[3]);
      cells = [...cellsAround(ax, ay, 1, nx, ny), ...cellsAround(bx, by, 1, nx, ny)];
    } else {
      cells = cellsAround(gx, gy, Math.min(EXPOSURE_RADIUS_M, fac.radiusM) / cellSize, nx, ny);
    }
    const th = FACILITY_THRESHOLDS[fac.kind];
    for (const c of cells) {
      const fw = f.firstWet[c];
      if (fw === 0) continue; // water present at reset: river, lake
      const d = f.maxDepth[c];
      if (!(d > 0)) continue;
      if (d > ex.depth) ex.depth = d;
      const v = f.maxSpeed[c];
      if (Number.isFinite(v) && v > ex.speed) ex.speed = v;
      if (f.wetSeconds[c] > ex.wetSeconds) ex.wetSeconds = f.wetSeconds[c];
      if (fw > 0 && d >= ARRIVAL && !(fw >= ex.firstWet)) ex.firstWet = fw;
      // A threshold below the 15 cm arrival depth (a bridge's 5 cm "wet") is timed by the arrival as well.
      const t = fw > 0 ? fw : NaN;
      if (Number.isFinite(t) && d >= th.impaired && !(t >= ex.impairedAt)) ex.impairedAt = t;
      if (Number.isFinite(t) && d >= th.failed && !(t >= ex.failedAt)) ex.failedAt = t;
    }
    ex.status = ex.depth >= th.failed ? 'failed' : ex.depth >= th.impaired ? 'impaired' : 'operational';
    // No arrival time recorded (snapshot fallback, or water only between 0.05 and 0.15 m): the status stands untimed.
    return ex;
  });
}

export function summarizeInfra(ex: readonly FacilityExposure[]): InfraSummary {
  const byKind = Object.fromEntries(FACILITY_KINDS.map((k) => [k, { total: 0, failed: 0, impaired: 0 }])) as InfraSummary['byKind'];
  const s: InfraSummary = { total: ex.length, inside: 0, failed: 0, impaired: 0, byKind };
  for (const e of ex) {
    if (!e.inside) continue;
    s.inside++;
    const k = byKind[e.facility.kind];
    k.total++;
    if (e.status === 'failed') ((s.failed++), k.failed++);
    else if (e.status === 'impaired') ((s.impaired++), k.impaired++);
  }
  return s;
}

/** Most affected first: failed by failure time, then impaired by time, then the rest by kind and name. */
export function sortExposures(ex: readonly FacilityExposure[]): FacilityExposure[] {
  const rank = (e: FacilityExposure) => (e.status === 'failed' ? 0 : e.status === 'impaired' ? 1 : 2);
  const time = (e: FacilityExposure) => {
    const t = e.status === 'failed' ? e.failedAt : e.impairedAt;
    return Number.isFinite(t) ? t : Infinity;
  };
  return [...ex].filter((e) => e.inside).sort((a, b) => rank(a) - rank(b) || time(a) - time(b) || b.depth - a.depth || FACILITY_KINDS.indexOf(a.facility.kind) - FACILITY_KINDS.indexOf(b.facility.kind) || a.facility.name.localeCompare(b.facility.name));
}
