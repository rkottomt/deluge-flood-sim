/**
 * Human names for live areas: "Harrisburg, Pennsylvania" instead of "40.2598°, -76.8870°".
 *
 * Reverse geocoding uses OpenStreetMap Nominatim (the location picker's search service). It is best-effort: short
 * timeout, and any failure (offline, rate-limited) falls back to a readable coordinate label.
 *
 * Every name reaching the UI is untrusted: it comes from a shared link (?name=), from crowd-edited OSM data, or from
 * whatever a geocoder answers. `cleanPlaceLabel` is the single hygiene pass for display; `linkPlaceLabel` is the much
 * stricter filter for a label a *link* supplies, so a crafted URL cannot turn the app's own chrome into an
 * announcement (FINDINGS.json SEC-01).
 */
import { fetchJSON, MB } from './net';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
/** Endpoint paths (also the connect-src entries in the CSP; see src/data/csp.ts). */
export const NOMINATIM_SEARCH = `${NOMINATIM}/search`;
export const NOMINATIM_REVERSE = `${NOMINATIM}/reverse`;

/** Nominatim reverse-geocoding answer (the fields used). Every field is `unknown`: the service is not trusted. */
export interface NominatimReverse {
  address?: Record<string, string | undefined>;
  display_name?: string;
  name?: string;
}

/** Longest label kept, in code points, before an ellipsis. Long enough for "Wilkes-Barre, Pennsylvania". */
const MAX_LABEL_CODEPOINTS = 48;
/** Nothing sane is longer; bounds the cost of normalising a hostile string. */
const MAX_INPUT_CHARS = 4096;
/** A ?name= from a link may be at most this many code points. */
const MAX_LINK_CODEPOINTS = 40;

/**
 * One-line display label for an untrusted name.
 *
 * Control characters and line separators become spaces; format characters (bidi overrides U+202A–202E and isolates
 * U+2066–2069, zero-width space/joiners), surrogates, private-use and unassigned code points are removed; runs of
 * whitespace collapse; the result is capped at `max` *code points* (never mid-surrogate-pair, so an emoji is dropped
 * whole rather than leaving a lone half).
 *
 * Note: stripping ZWJ/ZWNJ would damage scripts that need them (e.g. Devanagari, Persian) and can break multi-code-point
 * emoji into their parts. That is accepted for this US-only app, where the value of never letting an attacker reorder
 * or hide text in the app's own title bar is higher.
 */
export function cleanPlaceLabel(s: unknown, max = MAX_LABEL_CODEPOINTS): string {
  if (typeof s !== 'string' || !s) return '';
  const t = (s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s)
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/[\p{Cf}\p{Cs}\p{Co}\p{Cn}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = [...t];
  return cps.length > max ? `${cps.slice(0, max - 1).join('').trimEnd()}…` : t;
}

/** Letters, marks, and the punctuation real place names use. No digits, colons, slashes or symbols. */
const LINK_LABEL = /^[\p{L}\p{M}][\p{L}\p{M} ,.'’()-]*$/u;

/**
 * A ?name= label from a shared link: at most 40 code points of letters, spaces and , . ' ’ ( ) - — anything else
 * (digits, colons, phone numbers, exclamation marks, sentences) yields ''. A link may label a place; it may not write
 * a message into the app's chrome. Callers must still show the coordinates next to it (provenance, SEC-01).
 */
export function linkPlaceLabel(s: unknown): string {
  if (typeof s !== 'string' || s.length > 200) return '';
  const t = cleanPlaceLabel(s, 200);
  return [...t].length <= MAX_LINK_CODEPOINTS && LINK_LABEL.test(t) ? t : '';
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** "City, State" from a Nominatim answer, or '' if it names nothing useful. Cleaned; never trusts a field's type. */
export function placeNameFromNominatim(j: NominatimReverse | null | undefined): string {
  if (!j || typeof j !== 'object') return '';
  const raw = j as Record<string, unknown>;
  const a = (raw.address && typeof raw.address === 'object' ? raw.address : {}) as Record<string, unknown>;
  const locality =
    str(a.city) || str(a.town) || str(a.village) || str(a.hamlet) || str(a.suburb) || str(a.municipality) || str(a.county);
  const region = str(a.state) || str(a.territory) || str(a.country);
  const nm = [locality, region].filter(Boolean).join(', ');
  return cleanPlaceLabel(nm || str(raw.name) || str(raw.display_name).split(', ').slice(0, 2).join(', '));
}

/** "Area near 29.950° N, 90.070° W". */
export function coordinateName(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `Area near ${Math.abs(lat).toFixed(3)}° ${ns}, ${Math.abs(lon).toFixed(3)}° ${ew}`;
}

/**
 * True for names that are only coordinates ("29.9500°, -90.0700°", "29.950, -90.070"): worth replacing.
 * The length guard keeps the (quadratic on whitespace runs) regex off long hostile input — nothing near 64 characters
 * is a bare coordinate pair anyway.
 */
export function isCoordinateName(name: string | undefined | null): boolean {
  if (!name) return true;
  if (typeof name !== 'string' || name.length > 64) return false;
  return /^\s*-?\d+(\.\d+)?°?\s*[NS]?\s*,\s*-?\d+(\.\d+)?°?\s*[EW]?\s*$/i.test(name);
}

/** Reverse-geocode (lat, lon) to "City, State"; null on any failure. */
export async function reverseGeocodeName(lat: number, lon: number, signal?: AbortSignal, timeoutMs = 5000): Promise<string | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const url = `${NOMINATIM_REVERSE}?format=jsonv2&lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}&zoom=12&addressdetails=1`;
    const j = await fetchJSON<NominatimReverse>(url, { timeoutMs, stallMs: timeoutMs, retries: 0, signal, maxBytes: MB });
    return placeNameFromNominatim(j) || null;
  } catch {
    return null;
  }
}
