/**
 * The national dam index: a compact, same-origin copy of the public fields of the U.S. Army Corps of Engineers
 * National Inventory of Dams (NID) for every dam big enough to make a breach flood worth mapping.
 *
 * WHERE IT COMES FROM. The NID API (nid.sec.usace.army.mil/api/…) answers requests from a browser page with no
 * Access-Control-Allow-Origin header (checked October 2026: a GET carrying an Origin header gets 200 with
 * Access-Control-Allow-Credentials but no allowed origin, and the national CSV export answers 403), so the page cannot
 * read it — and the CSP stays without it. scripts/bake-nid.ts reads the NID's own national GeoPackage export
 * (nid.sec.usace.army.mil/api/nation/gpkg, the "public" fields only) and writes public/dams/nid-index.bin, which this
 * module decodes. The same reasoning as the NOAA Atlas 14 grid (src/data/atlas14.ts).
 *
 * WHAT IS IN IT. Dams with NID storage ≥ 1,000 acre-ft, or ≥ 6 m high and holding ≥ 50 acre-ft (NID_INDEX_RULE):
 * small ponds whose breach would not leave the property are left out. Per dam: NID id, name, state, location, NID
 * height and hydraulic height, NID (maximum) and normal storage, surface area, maximum spillway discharge, length,
 * year completed, hazard potential, primary owner type and primary dam type. Restricted NID fields (condition
 * assessments of some federal dams, EAP details, inundation maps) are not in the public export and not here.
 *
 * FORMAT ("DLNID001", little-endian, column-major so gzip finds the redundancy):
 *   header  8  magic · u32 count · u32 nameBytes · u32 reserved (0)
 *   columns count × each, in this order:
 *     id        8 bytes ASCII, NUL-padded ([A-Z0-9], 5–8 characters)
 *     lat, lon  i32 × 1e-5 degrees
 *     height    u16 NID height, 0.1 m          hydraulic  u16 hydraulic height, 0.1 m (0 = not reported)
 *     storage   u32 NID storage, 0.1 acre-ft   normal     u32 normal storage, 0.1 acre-ft (NO_VALUE = not reported,
 *                                              0 = reported as zero: a dry dam with no permanent pool — isDryDam)
 *     area      u32 surface area, 0.1 acre (NO_VALUE)   discharge u32 max discharge, ft³/s (NO_VALUE)
 *     length    u32 dam length, ft (NO_VALUE)  year u16 (0 = unknown)
 *     hazard, owner, type, state   u8 codes into HAZARDS / OWNERS / DAM_TYPES / STATES
 *   names   nameBytes of UTF-8, one name per record, separated by "\n"
 *
 * The decoder trusts nothing (same rules as the Atlas 14 grid): a download cap, a gzip-output cap, an exact length
 * from the header, bounded counts, every record range-checked (a bad record is dropped, never guessed), names decoded
 * strictly and cleaned of control and bidi characters, and a cap on name length.
 */
import { gunzipCapped } from '../data/atlas14';
import { fetchBytes, MB } from '../data/net';

export const NID_MAGIC = 'DLNID001';
const HEADER_BYTES = 20;
/** Bytes per record across all columns. */
export const NID_RECORD_BYTES = 8 + 4 + 4 + 2 + 2 + 4 + 4 + 4 + 4 + 4 + 2 + 4;
export const NO_VALUE = 0xffffffff;
export const ACRE_FT_M3 = 1233.48183754752;
export const ACRE_M2 = 4046.8564224;
export const CFS_M3S = 0.028316846592;
export const FT_M = 0.3048;

/** Which dams the bake keeps (acre-ft, m). */
export const NID_INDEX_RULE = { storageAcFt: 1000, heightM: 6, minStorageAcFt: 50 } as const;

export const NID_LIMITS = {
  maxCount: 200_000,
  maxNameBytes: 8 * MB,
  /** Largest decompressed file accepted. The real one is ~3.6 MB. */
  maxBytes: 24 * MB,
  /** Largest download accepted (the real one is ~1.4 MB gzip). */
  maxDownload: 6 * MB,
  maxNameChars: 100,
  /** Tallest dam in the U.S. is ~235 m (Oroville); the field allows 400. */
  maxHeightM: 400,
  /** Lake Mead is ~3.2e7 acre-ft; the field allows 5e7. */
  maxStorageAcFt: 5e7,
} as const;

export const HAZARDS = ['Undetermined', 'Low', 'Significant', 'High'] as const;
export type NidHazard = (typeof HAZARDS)[number];
export const OWNERS = ['Not listed', 'Federal', 'State', 'Local Government', 'Public Utility', 'Private', 'Tribal Government'] as const;
export const DAM_TYPES = ['Not listed', 'Earth', 'Rockfill', 'Gravity', 'Concrete', 'Arch', 'Multi-Arch', 'Buttress', 'Roller-Compacted Concrete', 'Masonry', 'Stone', 'Timber Crib', 'Other'] as const;
/** Embankment types the Froehlich breach relations were fitted to (src/dams/breachModel.ts). */
export const EMBANKMENT_TYPES: ReadonlySet<string> = new Set(['Earth', 'Rockfill']);
export const STATES = [
  '', 'AK', 'AL', 'AR', 'AS', 'AZ', 'CA', 'CO', 'CT', 'DC', 'DE', 'FL', 'GA', 'GU', 'HI', 'IA', 'ID', 'IL', 'IN', 'KS', 'KY', 'LA', 'MA', 'MD', 'ME', 'MI', 'MN',
  'MO', 'MP', 'MS', 'MT', 'NC', 'ND', 'NE', 'NH', 'NJ', 'NM', 'NV', 'NY', 'OH', 'OK', 'OR', 'PA', 'PR', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VA', 'VI', 'VT', 'WA',
  'WI', 'WV', 'WY',
] as const;

export interface NidDam {
  id: string;
  name: string;
  state: string;
  lat: number;
  lon: number;
  /** NID height (the largest of dam, hydraulic and structural height), m. */
  heightM: number;
  /** Hydraulic height (max design water level to the streambed at the toe), m; null when not reported. */
  hydraulicHeightM: number | null;
  /** NID storage (the maximum storage), acre-ft. */
  storageAcFt: number;
  /** Normal storage, acre-ft; null when not reported; 0 for a dry dam (no permanent pool — isDryDam). */
  normalStorageAcFt: number | null;
  /** Surface area at normal pool, acres; null when not reported. */
  surfaceAreaAc: number | null;
  /** Maximum spillway discharge, ft³/s; null when not reported. */
  maxDischargeCfs: number | null;
  /** Crest length, ft; null when not reported. */
  lengthFt: number | null;
  year: number | null;
  hazard: NidHazard;
  owner: string;
  damType: string;
}

export interface NidIndex {
  dams: NidDam[];
  /** Records the decoder refused (out of range), for the bake's report and the tests. */
  dropped: number;
}

/**
 * A dry dam: the NID reports its normal storage as zero — a flood-control detention dam, or a tailings or debris basin,
 * that holds no permanent pool and stores water only while a flood passes. Not the same as "not reported" (null).
 */
export function isDryDam(dam: Pick<NidDam, 'normalStorageAcFt'>): boolean {
  return dam.normalStorageAcFt === 0;
}

/** Letters, digits; 5–8 of them. NID ids are two-letter state codes and digits (e.g. CA00035). */
export const NID_ID_RE = /^[A-Z]{2}[A-Z0-9]{3,6}$/;

/** Drop control, bidi and other format characters, collapse spaces, cap the length. */
export function cleanDamName(s: string): string {
  return s
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿￹-￻]/g, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NID_LIMITS.maxNameChars);
}

/** Encode (the bake script's writer; the tests build hostile variants with it). Values are written as given. */
export function encodeNidIndex(dams: readonly NidDam[]): Uint8Array {
  const n = dams.length;
  const names = new TextEncoder().encode(dams.map((d) => d.name.replace(/\n/g, ' ')).join('\n'));
  const out = new Uint8Array(HEADER_BYTES + n * NID_RECORD_BYTES + names.byteLength);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = NID_MAGIC.charCodeAt(i);
  dv.setUint32(8, n, true);
  dv.setUint32(12, names.byteLength, true);
  dv.setUint32(16, 0, true);
  let o = HEADER_BYTES;
  const col = (bytes: number, put: (d: NidDam, at: number) => void) => {
    for (const d of dams) {
      put(d, o);
      o += bytes;
    }
  };
  const u32 = (v: number | null, scale = 1) => (v === null || !Number.isFinite(v) ? NO_VALUE : Math.max(0, Math.min(NO_VALUE - 1, Math.round(v * scale))));
  col(8, (d, at) => {
    for (let k = 0; k < 8; k++) out[at + k] = k < d.id.length ? d.id.charCodeAt(k) & 0x7f : 0;
  });
  col(4, (d, at) => dv.setInt32(at, Math.round(d.lat * 1e5), true));
  col(4, (d, at) => dv.setInt32(at, Math.round(d.lon * 1e5), true));
  col(2, (d, at) => dv.setUint16(at, Math.max(0, Math.min(0xffff, Math.round(d.heightM * 10))), true));
  col(2, (d, at) => dv.setUint16(at, d.hydraulicHeightM === null ? 0 : Math.max(0, Math.min(0xffff, Math.round(d.hydraulicHeightM * 10))), true));
  col(4, (d, at) => dv.setUint32(at, u32(d.storageAcFt, 10), true));
  col(4, (d, at) => dv.setUint32(at, u32(d.normalStorageAcFt, 10), true));
  col(4, (d, at) => dv.setUint32(at, u32(d.surfaceAreaAc, 10), true));
  col(4, (d, at) => dv.setUint32(at, u32(d.maxDischargeCfs), true));
  col(4, (d, at) => dv.setUint32(at, u32(d.lengthFt), true));
  col(2, (d, at) => dv.setUint16(at, d.year ?? 0, true));
  const code = (list: readonly string[], v: string) => Math.max(0, list.indexOf(v));
  col(1, (d, at) => (out[at] = code(HAZARDS, d.hazard)));
  col(1, (d, at) => (out[at] = code(OWNERS, d.owner)));
  col(1, (d, at) => (out[at] = code(DAM_TYPES, d.damType)));
  col(1, (d, at) => (out[at] = code(STATES, d.state)));
  out.set(names, o);
  return out;
}

/**
 * Decode the baked index. Throws on anything structurally wrong (magic, counts, exact length, names that are not
 * UTF-8 or do not match the count); drops any single record whose values are out of range.
 */
export function decodeNidIndex(buf: ArrayBuffer | Uint8Array): NidIndex {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength > NID_LIMITS.maxBytes) throw new Error('Dam index: file too large');
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Dam index: file too short');
  for (let i = 0; i < 8; i++) if (bytes[i] !== NID_MAGIC.charCodeAt(i)) throw new Error('Dam index: not a Deluge dam index');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(8, true);
  const nameBytes = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0) throw new Error('Dam index: unknown header flags');
  if (n < 1 || n > NID_LIMITS.maxCount) throw new Error('Dam index: bad record count');
  if (nameBytes > NID_LIMITS.maxNameBytes) throw new Error('Dam index: names too large');
  if (bytes.byteLength !== HEADER_BYTES + n * NID_RECORD_BYTES + nameBytes) throw new Error('Dam index: length does not match its header');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(HEADER_BYTES + n * NID_RECORD_BYTES));
  } catch {
    throw new Error('Dam index: names are not UTF-8');
  }
  const names = text.split('\n');
  if (names.length !== n) throw new Error('Dam index: name count does not match');

  let o = HEADER_BYTES;
  const colStart = (bytesPer: number) => {
    const at = o;
    o += n * bytesPer;
    return at;
  };
  const cId = colStart(8);
  const cLat = colStart(4);
  const cLon = colStart(4);
  const cH = colStart(2);
  const cHh = colStart(2);
  const cS = colStart(4);
  const cNs = colStart(4);
  const cA = colStart(4);
  const cQ = colStart(4);
  const cL = colStart(4);
  const cY = colStart(2);
  const cHz = colStart(1);
  const cOw = colStart(1);
  const cTy = colStart(1);
  const cSt = colStart(1);

  const dams: NidDam[] = [];
  let dropped = 0;
  const opt = (v: number, scale: number, max: number): number | null | undefined => {
    if (v === NO_VALUE) return null;
    const x = v / scale;
    return x <= max ? x : undefined;
  };
  for (let i = 0; i < n; i++) {
    let id = '';
    for (let k = 0; k < 8; k++) {
      const c = bytes[cId + i * 8 + k];
      if (c === 0) break;
      id += String.fromCharCode(c);
    }
    const lat = dv.getInt32(cLat + i * 4, true) / 1e5;
    const lon = dv.getInt32(cLon + i * 4, true) / 1e5;
    const heightM = dv.getUint16(cH + i * 2, true) / 10;
    const hh = dv.getUint16(cHh + i * 2, true) / 10;
    const storage = opt(dv.getUint32(cS + i * 4, true), 10, NID_LIMITS.maxStorageAcFt);
    const normal = opt(dv.getUint32(cNs + i * 4, true), 10, NID_LIMITS.maxStorageAcFt);
    const area = opt(dv.getUint32(cA + i * 4, true), 10, 5e6);
    const q = opt(dv.getUint32(cQ + i * 4, true), 1, 1e7);
    const len = opt(dv.getUint32(cL + i * 4, true), 1, 1e6);
    const year = dv.getUint16(cY + i * 2, true);
    const hz = bytes[cHz + i];
    const ow = bytes[cOw + i];
    const ty = bytes[cTy + i];
    const st = bytes[cSt + i];
    const name = cleanDamName(names[i]);
    const ok =
      NID_ID_RE.test(id) &&
      // U.S. and territories: Guam / CNMI to the east of 180° are written as negative longitudes past −180 → refused;
      // the NID's Pacific territories sit at +144…+146 and are kept.
      lat >= -15 && lat <= 72 && ((lon >= -180 && lon <= -60) || (lon >= 140 && lon <= 150)) &&
      heightM > 0 && heightM <= NID_LIMITS.maxHeightM && hh <= NID_LIMITS.maxHeightM &&
      typeof storage === 'number' && storage > 0 &&
      normal !== undefined && area !== undefined && q !== undefined && len !== undefined &&
      (year === 0 || (year >= 1600 && year <= 2100)) &&
      hz < HAZARDS.length && ow < OWNERS.length && ty < DAM_TYPES.length && st < STATES.length &&
      name.length > 0;
    if (!ok) {
      dropped++;
      continue;
    }
    dams.push({
      id,
      name,
      state: STATES[st],
      lat,
      lon,
      heightM,
      hydraulicHeightM: hh > 0 ? hh : null,
      storageAcFt: storage as number,
      normalStorageAcFt: normal as number | null,
      surfaceAreaAc: area as number | null,
      maxDischargeCfs: q as number | null,
      lengthFt: len as number | null,
      year: year || null,
      hazard: HAZARDS[hz],
      owner: OWNERS[ow],
      damType: DAM_TYPES[ty],
    });
  }
  return { dams, dropped };
}

/** Where the index is served from (same origin; covered by CSP 'self'). */
export function nidIndexUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? '/'}dams/nid-index.bin`;
}

let indexPromise: Promise<NidIndex> | null = null;

/** Download (once per page) and decode the index. Same-origin, size-capped, gzip-capped. */
export function loadNidIndex(url = nidIndexUrl()): Promise<NidIndex> {
  indexPromise ??= fetchBytes(url, { maxBytes: NID_LIMITS.maxDownload, timeoutMs: 30000, retries: 1 })
    .then(async (buf) => decodeNidIndex(await gunzipCapped(new Uint8Array(buf), NID_LIMITS.maxBytes)))
    .catch((e) => {
      indexPromise = null;
      // gunzipCapped names the Atlas 14 grid in its messages; say what failed here.
      throw new Error(e instanceof Error ? e.message.replace(/^Atlas 14 grid/, 'Dam index') : 'Dam index unavailable');
    });
  return indexPromise;
}

/** Test hook. */
export function resetNidCache(): void {
  indexPromise = null;
}

// ─── Search ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Great-circle distance, km. */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export interface DamQuery {
  /** Free text: part of a name, or an NID id. Matched case- and accent-insensitively. */
  text?: string;
  /** Sort by distance from here, and keep only dams within `radiusKm`. */
  near?: { lat: number; lon: number; radiusKm: number };
  /** Only these hazard classes. */
  hazards?: readonly NidHazard[];
  limit?: number;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Find dams. Text matches rank: exact id, id prefix, name word-start, name substring; ties by storage. */
export function searchDams(index: NidIndex, q: DamQuery): Array<{ dam: NidDam; km: number | null }> {
  const text = fold((q.text ?? '').trim().slice(0, 80));
  const limit = Math.max(1, Math.min(200, q.limit ?? 25));
  const out: Array<{ dam: NidDam; km: number | null; rank: number }> = [];
  for (const dam of index.dams) {
    if (q.hazards && !q.hazards.includes(dam.hazard)) continue;
    let rank = 0;
    if (text) {
      const id = dam.id.toLowerCase();
      const name = fold(dam.name);
      if (id === text) rank = 4;
      else if (text.length >= 3 && id.startsWith(text)) rank = 3;
      else if (name.startsWith(text) || name.includes(` ${text}`)) rank = 2;
      else if (name.includes(text)) rank = 1;
      else continue;
    }
    let km: number | null = null;
    if (q.near) {
      km = distanceKm(q.near.lat, q.near.lon, dam.lat, dam.lon);
      if (km > q.near.radiusKm) continue;
    }
    out.push({ dam, km, rank });
  }
  out.sort((a, b) => b.rank - a.rank || (a.km !== null && b.km !== null ? a.km - b.km : 0) || b.dam.storageAcFt - a.dam.storageAcFt);
  return out.slice(0, limit).map(({ dam, km }) => ({ dam, km }));
}

export function damById(index: NidIndex, id: string): NidDam | null {
  return index.dams.find((d) => d.id === id) ?? null;
}
