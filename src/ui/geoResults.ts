/**
 * Validation and labelling of geocoder (Nominatim) answers, kept out of locationPicker.ts so it can be tested without
 * Leaflet and its stylesheet.
 *
 * Nothing here trusts the service: a result may be any JSON at all. An entry without a usable position used to render
 * as a clickable button and then throw "Invalid LatLng object: (NaN, NaN)" out of Leaflet, which surfaced as the red
 * "Something went wrong" toast and left a NaN selection behind (FINDINGS.json SEC-09); a 5,000-entry answer to a
 * `limit=5` request used to render 5,000 buttons. Labels are cleaned like every other untrusted place name (SEC-01).
 */
import { cleanPlaceLabel } from '../data/placeName';

/** Nominatim search result (the fields used). Every one is untrusted, hence the loose types. */
export interface GeoResult {
  display_name: string;
  lat: string | number;
  lon: string | number;
  type?: string;
  class?: string;
}

/** A result that is safe to show and to select. */
export interface GeoChoice {
  lat: number;
  lon: number;
  /** Primary label (the place itself), cleaned. */
  first: string;
  /** Remaining `display_name` parts (county, state, country), cleaned, empties dropped. */
  rest: string[];
}

/** The request asks for limit=5; the answer is held to it whatever it says. */
export const MAX_GEO_RESULTS = 5;

/** A usable geographic position. Leaflet throws on NaN, and the loader cannot do anything with an out-of-range one. */
export function isLatLon(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/** Validated, cleaned and capped choices from whatever the geocoder answered. */
export function geoChoices(list: unknown, max = MAX_GEO_RESULTS): GeoChoice[] {
  if (!Array.isArray(list)) return [];
  const out: GeoChoice[] = [];
  for (const r of list) {
    if (out.length >= max) break;
    if (!r || typeof r !== 'object') continue;
    const { display_name: displayName, lat: rawLat, lon: rawLon } = r as GeoResult;
    if (typeof displayName !== 'string') continue;
    const lat = Number(rawLat);
    const lon = Number(rawLon);
    if (!isLatLon(lat, lon)) continue;
    const parts = displayName.split(', ').map((p) => cleanPlaceLabel(p));
    const first = parts[0] || cleanPlaceLabel(displayName);
    if (!first) continue;
    out.push({ lat, lon, first, rest: parts.slice(1).filter(Boolean) });
  }
  return out;
}
