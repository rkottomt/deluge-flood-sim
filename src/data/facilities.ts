/**
 * Critical facilities per preset — substations and power plants, hospitals and clinics, fire and police stations,
 * water and wastewater works, telecom exchanges, bridges on major roads, fuel stations — from OpenStreetMap, baked by
 * scripts/bake-facilities.ts into public/presets/<id>/facilities.json and loaded lazily (only when Infrastructure or
 * Site check needs them).
 *
 * OSM TAGS (wiki.openstreetmap.org, Map features):
 *   power=substation · power=plant · amenity=hospital (or healthcare=hospital) · amenity=clinic · amenity=fire_station ·
 *   amenity=police · man_made=water_works · man_made=wastewater_plant · telecom=exchange|central_office|data_center ·
 *   bridge=* on highway=motorway|trunk|primary|secondary (and their _link roads) · amenity=fuel
 *
 * LICENCE. © OpenStreetMap contributors, ODbL 1.0 — the same attribution the buildings already carry on screen
 * (BUILDINGS_ATTRIBUTION_OSM) and in public/presets/SOURCES.txt; facilities.json is a derived database offered under
 * the ODbL like its source.
 *
 * LIVE AREAS get no facilities: the selective query needs the Overpass API, which is not in the app's
 * Content-Security-Policy (src/data/csp.ts). The OSM API 0.6 /map call that IS allowed returns every object in a bbox
 * (a 5 km live area is tens of MB and over its 50 000-node limit downtown), so it is not used for this.
 *
 * A facilities file comes from the network (a static host): decodeFacilities validates every field and drops what it
 * cannot read, and names are cleaned (cleanPlaceLabel) and only ever written as text.
 */
import { fetchJSON } from './net';
import { cleanPlaceLabel } from './placeName';
import { isPresetId, presetFileUrl } from './presets';

export const FACILITY_KINDS = ['substation', 'power_plant', 'hospital', 'clinic', 'fire_station', 'police', 'water_works', 'wastewater_plant', 'telecom', 'bridge', 'fuel'] as const;
export type FacilityKind = (typeof FACILITY_KINDS)[number];

export const FACILITY_LABELS: Readonly<Record<FacilityKind, string>> = {
  substation: 'Substation',
  power_plant: 'Power plant',
  hospital: 'Hospital',
  clinic: 'Clinic',
  fire_station: 'Fire station',
  police: 'Police',
  water_works: 'Water works',
  wastewater_plant: 'Wastewater plant',
  telecom: 'Telecom exchange',
  bridge: 'Bridge',
  fuel: 'Fuel station',
};

export const FACILITIES_ATTRIBUTION = 'Facilities © OpenStreetMap contributors (ODbL)';
export const FACILITIES_FILE = 'facilities.json';
/** Largest radius kept for an area feature, m (a campus or a plant's fence line is sampled within this of its centre). */
export const MAX_FACILITY_RADIUS_M = 150;
export const MAX_FACILITIES = 5000;

export interface Facility {
  /** OSM element, e.g. 'n123', 'w456', 'r7'. */
  id: string;
  kind: FacilityKind;
  /** '' when unnamed. */
  name: string;
  lon: number;
  lat: number;
  /** Half the diagonal of the feature's bounding box, m (0 for a point), capped at MAX_FACILITY_RADIUS_M. */
  radiusM: number;
  /** Bridges: the two ends of the deck [lon, lat, lon, lat] — where its approaches land. */
  ends?: [number, number, number, number];
  /** Bridges: the road it carries; substations: the OSM substation=* value (transmission, distribution …). */
  detail?: string;
}

/** On disk: [kindIndex, lon, lat, radiusM, name, id, detail?, ends?]. */
export type CompactFacility = [number, number, number, number, string, string, string?, number[]?];
export interface CompactFacilities {
  v: 1;
  attribution: string;
  /** ISO date of the OSM snapshot used. */
  osmDate: string;
  kinds: readonly string[];
  f: CompactFacility[];
}

const HIGHWAY_BRIDGE = /^(motorway|trunk|primary|secondary)(_link)?$/;

/** OSM tags → facility kind, or null. */
export function classifyFacility(tags: Record<string, string | undefined>, isWay = true): FacilityKind | null {
  if (tags.power === 'substation') return 'substation';
  if (tags.power === 'plant') return 'power_plant';
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'hospital';
  if (tags.amenity === 'clinic') return 'clinic';
  if (tags.amenity === 'fire_station') return 'fire_station';
  if (tags.amenity === 'police') return 'police';
  if (tags.man_made === 'water_works') return 'water_works';
  if (tags.man_made === 'wastewater_plant') return 'wastewater_plant';
  if (tags.telecom === 'exchange' || tags.telecom === 'central_office' || tags.telecom === 'data_center') return 'telecom';
  if (isWay && tags.bridge && tags.bridge !== 'no' && HIGHWAY_BRIDGE.test(tags.highway ?? '')) return 'bridge';
  if (tags.amenity === 'fuel') return 'fuel';
  return null;
}

/** The Overpass QL that bake-facilities.ts sends for a bbox (south, west, north, east). */
export function overpassFacilitiesQuery(b: { south: number; west: number; north: number; east: number }): string {
  const bb = `(${b.south},${b.west},${b.north},${b.east})`;
  return [
    '[out:json][timeout:180];',
    '(',
    `  nwr["power"~"^(substation|plant)$"]${bb};`,
    `  nwr["amenity"~"^(hospital|clinic|fire_station|police|fuel)$"]${bb};`,
    `  nwr["healthcare"="hospital"]${bb};`,
    `  nwr["man_made"~"^(water_works|wastewater_plant)$"]${bb};`,
    `  nwr["telecom"~"^(exchange|central_office|data_center)$"]${bb};`,
    `  way["bridge"]["bridge"!="no"]["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"]${bb};`,
    ');',
    'out tags geom;',
  ].join('\n');
}

const M_PER_DEG = 111_320;
function halfDiagonalM(minlat: number, minlon: number, maxlat: number, maxlon: number): number {
  const lat = (minlat + maxlat) / 2;
  const dx = (maxlon - minlon) * M_PER_DEG * Math.cos((lat * Math.PI) / 180);
  const dy = (maxlat - minlat) * M_PER_DEG;
  return Math.hypot(dx, dy) / 2;
}

export function distanceM(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const dx = (lon2 - lon1) * M_PER_DEG * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180);
  const dy = (lat2 - lat1) * M_PER_DEG;
  return Math.hypot(dx, dy);
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
  geometry?: Array<{ lat: number; lon: number } | null>;
}

/**
 * An Overpass JSON answer (`out tags geom`) → facilities inside `bounds`, de-duplicated: the same kind within 40 m of
 * another (a hospital mapped as a point and as its campus) keeps the named / larger one; bridge ways carrying the same
 * road within 80 m of each other (twin carriageways, a deck split at a joint) become one bridge.
 */
export function parseOverpassFacilities(json: { elements?: OverpassElement[] }, bounds: { west: number; south: number; east: number; north: number }): Facility[] {
  const raw: Facility[] = [];
  for (const el of json.elements ?? []) {
    const tags = el.tags ?? {};
    const kind = classifyFacility(tags, el.type !== 'node');
    if (!kind) continue;
    let lon = NaN, lat = NaN, radiusM = 0;
    let ends: Facility['ends'];
    if (el.type === 'node') {
      lon = el.lon ?? NaN;
      lat = el.lat ?? NaN;
    } else if (el.bounds) {
      const b = el.bounds;
      lon = (b.minlon + b.maxlon) / 2;
      lat = (b.minlat + b.maxlat) / 2;
      radiusM = Math.min(MAX_FACILITY_RADIUS_M, halfDiagonalM(b.minlat, b.minlon, b.maxlat, b.maxlon));
    }
    if (kind === 'bridge') {
      const g = (el.geometry ?? []).filter((p): p is { lat: number; lon: number } => !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (g.length < 2) continue;
      ends = [g[0].lon, g[0].lat, g[g.length - 1].lon, g[g.length - 1].lat];
      const mid = g[Math.floor(g.length / 2)];
      if (!Number.isFinite(lon)) ((lon = mid.lon), (lat = mid.lat));
    }
    if (!(Number.isFinite(lon) && Number.isFinite(lat))) continue;
    if (lon < bounds.west || lon > bounds.east || lat < bounds.south || lat > bounds.north) continue;
    const name = cleanPlaceLabel(tags.name ?? (kind === 'bridge' ? tags['bridge:name'] : undefined) ?? tags.operator, 48);
    const detail = kind === 'bridge' ? cleanPlaceLabel(tags.name ?? tags.ref, 48) : kind === 'substation' ? cleanPlaceLabel(tags.substation, 24) : '';
    raw.push({ id: `${el.type[0]}${el.id}`, kind, name, lon: round6(lon), lat: round6(lat), radiusM: Math.round(radiusM), ...(ends ? { ends: ends.map(round6) as Facility['ends'] } : {}), ...(detail ? { detail } : {}) });
  }
  return dedupe(raw);
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * One bridge from many ways: OSM splits a deck at every joint, ramp and lane change, and maps twin carriageways
 * separately. Ways carrying the same road (name / ref) whose ends meet (within 30 m) are chained into one; the merged
 * bridge keeps the farthest pair of ends and its midpoint.
 */
function mergeBridges(list: Facility[]): Facility[] {
  const bridges = list.filter((f) => f.kind === 'bridge' && f.ends);
  const other = list.filter((f) => !(f.kind === 'bridge' && f.ends));
  const parent = bridges.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const pts = (f: Facility) => [[f.ends![0], f.ends![1]], [f.ends![2], f.ends![3]]];
  for (let i = 0; i < bridges.length; i++) {
    for (let j = i + 1; j < bridges.length; j++) {
      if ((bridges[i].detail ?? '') !== (bridges[j].detail ?? '')) continue;
      const near = pts(bridges[i]).some(([x, y]) => pts(bridges[j]).some(([u, v]) => distanceM(x, y, u, v) < 30));
      if (near) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Facility[]>();
  bridges.forEach((f, i) => {
    const r = find(i);
    groups.set(r, [...(groups.get(r) ?? []), f]);
  });
  for (const g of groups.values()) {
    const all = g.flatMap(pts);
    let best: [number, number, number, number] = g[0].ends!;
    let bd = -1;
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
      const d = distanceM(all[a][0], all[a][1], all[b][0], all[b][1]);
      if (d > bd) ((bd = d), (best = [all[a][0], all[a][1], all[b][0], all[b][1]]));
    }
    const named = g.find((f) => f.name) ?? g[0];
    other.push({ ...named, lon: round6((best[0] + best[2]) / 2), lat: round6((best[1] + best[3]) / 2), radiusM: Math.min(MAX_FACILITY_RADIUS_M, Math.round(bd / 2)), ends: best });
  }
  return other;
}

function dedupe(input: Facility[]): Facility[] {
  const list = mergeBridges(input);
  // Areas and named first, so the survivor of a pair is the better-described one.
  const sorted = [...list].sort((a, b) => Number(!!b.name) - Number(!!a.name) || b.radiusM - a.radiusM || a.id.localeCompare(b.id));
  const out: Facility[] = [];
  for (const f of sorted) {
    const dup = out.find((o) => {
      if (o.kind !== f.kind) return false;
      const d = distanceM(o.lon, o.lat, f.lon, f.lat);
      if (f.kind === 'bridge') return (o.detail ?? '') === (f.detail ?? '') && d < 80;
      return d < 40 || d < Math.max(o.radiusM, f.radiusM) * 0.8;
    });
    if (!dup) {
      out.push(f);
      continue;
    }
    if (f.kind === 'bridge' && f.ends && dup.ends) {
      // Keep the longer deck.
      const len = (e: number[]) => distanceM(e[0], e[1], e[2], e[3]);
      if (len(f.ends) > len(dup.ends)) dup.ends = f.ends;
    }
    if (!dup.name && f.name) dup.name = f.name;
  }
  return out.sort((a, b) => FACILITY_KINDS.indexOf(a.kind) - FACILITY_KINDS.indexOf(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function encodeFacilities(list: readonly Facility[], osmDate: string): CompactFacilities {
  return {
    v: 1,
    attribution: '© OpenStreetMap contributors, ODbL 1.0',
    osmDate,
    kinds: FACILITY_KINDS,
    f: list.map((x) => {
      const row: CompactFacility = [FACILITY_KINDS.indexOf(x.kind), x.lon, x.lat, x.radiusM, x.name, x.id];
      if (x.detail || x.ends) row.push(x.detail ?? '');
      if (x.ends) row.push([...x.ends]);
      return row;
    }),
  };
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Validate and decode; rows that do not read are dropped (never thrown on). */
export function decodeFacilities(c: unknown): Facility[] {
  if (!c || typeof c !== 'object') return [];
  const o = c as Partial<CompactFacilities>;
  if (o.v !== 1 || !Array.isArray(o.f) || !Array.isArray(o.kinds)) return [];
  const out: Facility[] = [];
  for (const row of o.f.slice(0, MAX_FACILITIES)) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const [k, lon, lat, r, name, id, detail, ends] = row;
    const kindName = typeof k === 'number' ? o.kinds[k] : undefined;
    const kind = FACILITY_KINDS.find((x) => x === kindName);
    if (!kind || !finite(lon) || !finite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) continue;
    const f: Facility = {
      id: typeof id === 'string' ? id.slice(0, 24) : '',
      kind,
      name: cleanPlaceLabel(name, 48),
      lon,
      lat,
      radiusM: finite(r) ? Math.max(0, Math.min(MAX_FACILITY_RADIUS_M, r)) : 0,
    };
    const d = cleanPlaceLabel(detail, 48);
    if (d) f.detail = d;
    if (Array.isArray(ends) && ends.length === 4 && ends.every(finite)) f.ends = [ends[0], ends[1], ends[2], ends[3]];
    out.push(f);
  }
  return out;
}

const cache = new Map<string, Promise<Facility[] | null>>();

/**
 * The baked facilities of a preset, or null when it has none (the procedural sandbox, a live area) or the file could
 * not be read. Fetched once per preset per page.
 */
export function loadPresetFacilities(presetId: string | null): Promise<Facility[] | null> {
  if (!presetId || !isPresetId(presetId) || presetId === 'sandbox') return Promise.resolve(null);
  const url = presetFileUrl(presetId, FACILITIES_FILE);
  if (!url) return Promise.resolve(null);
  let p = cache.get(presetId);
  if (!p) {
    p = fetchJSON<unknown>(url, { timeoutMs: 30000, retries: 1 }).then(
      (json) => decodeFacilities(json),
      (e) => {
        console.warn(`[data] facilities for ${presetId} unavailable:`, e);
        cache.delete(presetId);
        return null;
      },
    );
    cache.set(presetId, p);
  }
  return p;
}
