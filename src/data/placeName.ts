/**
 * Human names for live areas: "Harrisburg, Pennsylvania" instead of "40.2598°, -76.8870°".
 *
 * Reverse geocoding uses OpenStreetMap Nominatim (the location picker's search service). It is best-effort: short
 * timeout, and any failure (offline, rate-limited) falls back to a readable coordinate label.
 */
import { fetchJSON } from './net';

const NOMINATIM = 'https://nominatim.openstreetmap.org';

/** Nominatim reverse-geocoding answer (the fields used). */
export interface NominatimReverse {
  address?: Record<string, string | undefined>;
  display_name?: string;
  name?: string;
}

/** "City, State" from a Nominatim answer, or '' if it names nothing useful. */
export function placeNameFromNominatim(j: NominatimReverse | null | undefined): string {
  if (!j) return '';
  const a = j.address ?? {};
  const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county || '';
  const region = a.state || a.territory || a.country || '';
  const nm = [locality, region].filter(Boolean).join(', ');
  return nm || j.name || j.display_name?.split(', ').slice(0, 2).join(', ') || '';
}

/** "Area near 29.950° N, 90.070° W". */
export function coordinateName(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `Area near ${Math.abs(lat).toFixed(3)}° ${ns}, ${Math.abs(lon).toFixed(3)}° ${ew}`;
}

/** True for names that are only coordinates ("29.9500°, -90.0700°", "29.950, -90.070"): worth replacing. */
export function isCoordinateName(name: string | undefined | null): boolean {
  return !name || /^\s*-?\d+(\.\d+)?°?\s*[NS]?\s*,\s*-?\d+(\.\d+)?°?\s*[EW]?\s*$/i.test(name);
}

/** Reverse-geocode (lat, lon) to "City, State"; null on any failure. */
export async function reverseGeocodeName(lat: number, lon: number, signal?: AbortSignal, timeoutMs = 5000): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const url = `${NOMINATIM}/reverse?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=12&addressdetails=1`;
    const j = await fetchJSON<NominatimReverse>(url, { timeoutMs, stallMs: timeoutMs, retries: 0, signal });
    return placeNameFromNominatim(j) || null;
  } catch {
    return null;
  }
}
