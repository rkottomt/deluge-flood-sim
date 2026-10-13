/**
 * NOAA Atlas 14 rain return periods for any U.S. point — 1-hour intensity at 2, 10, 25, 100 and 500 years.
 *
 * WHERE THE NUMBERS COME FROM. NOAA's Precipitation Frequency Data Server (PFDS, hdsc.nws.noaa.gov) answers point
 * queries, but it sends no Access-Control-Allow-Origin header (checked October 2026: a GET with an Origin header gets
 * none back, and an OPTIONS preflight gets HTTP 500), so a browser page cannot read it. Instead, scripts/bake-atlas14.ts
 * resamples NOAA's own published Atlas 14 GIS grids (30″, partial-duration series, 60-minute duration — the same
 * estimates the PFDS serves) into one compact same-origin file, public/atlas14/pf60m-pds.bin, which this module
 * decodes and interpolates. NOAA Atlas 14 data are public domain ("no restrictions apply"; NOAA asks for
 * acknowledgement — the citation is LADDER_SOURCES['noaa-atlas14'] in src/loss/ladders.ts, shown in every report).
 * NOAA Atlas 15 has not superseded it: as of October 2026 only a Montana pilot is out, CONUS preliminary estimates
 * are "no earlier than September 2026" and published ones "no earlier than September 2027"
 * (water.noaa.gov/about/atlas15); Atlas 14 is the national standard.
 *
 * Coverage is Atlas 14's: CONUS except western Washington and Oregon (Volume 12 covers only the interior Northwest; the
 * coast is still on NOAA Atlas 2, which this does not use), plus Alaska, Hawaii and Puerto Rico / USVI. Outside it the
 * lookup returns null and the app says so — it never guesses.
 *
 * TWO PARSERS, BOTH STRICT. Bytes from anywhere are untrusted, even our own static host (a mirror, a proxy, a cache):
 *   decodeAtlas14Grid   the baked binary grid (what the app loads): exact length, bounded counts, every value range-
 *                       checked; a cell that is not non-decreasing in return period is dropped, not trusted.
 *   parsePfdsResponse   a PFDS point answer (the bake script's cross-check and the test fixtures): a size cap, a fixed
 *                       19 × 10 table of short decimal strings, and the echoed request must match the one asked.
 *
 * RETURN PERIODS. The grids are a partial-duration series (PDS): "100-yr" is an average recurrence interval (ARI). The
 * loss maths needs an annual exceedance probability, so the ladder converts with Langbein's relation
 * AEP = 1 − exp(−1/ARI) (the relation NOAA Atlas 14 itself uses to relate its PDS and AMS results): 2-yr ARI is a 39 %
 * annual chance (1 in 2.5 years); 10, 25, 100 and 500-yr are 1 in 10.5, 25.5, 100.5 and 500.5 years.
 */
import { fetchBytes, MB } from './net';

/** Return periods (years, PDS ARI) baked into the grid, in file order. */
export const ATLAS14_ARIS = [2, 10, 25, 100, 500] as const;

/**
 * Whether a point is in the part of the world Atlas 14 could cover (the Americas north of 15° N, plus nothing else
 * worth a download): scenes elsewhere — the Himalayan presets — never fetch the grid. The lookup decides the rest.
 */
export function atlas14MayCover(lat: number, lon: number): boolean {
  return lon < -60 && lat > 15;
}

/** Where the grid is served from (same origin; covered by CSP 'self'). */
export function atlas14GridUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? '/'}atlas14/pf60m-pds.bin`;
}

// ─── The baked grid ──────────────────────────────────────────────────────────────────────────────────────────────────

/** "DLA14PF1": Deluge Atlas 14 precipitation frequency, format 1. */
const MAGIC = [0x44, 0x4c, 0x41, 0x31, 0x34, 0x50, 0x46, 0x31];
const HEADER_BYTES = 12;
const TILE_HEADER_BYTES = 16;
/** Stored value: 0.1 mm/h units; NODATA marks a cell outside Atlas 14 coverage. */
export const ATLAS14_UNIT_MM_H = 0.1;
export const ATLAS14_NODATA = 0xffff;
/** Hard limits a valid file stays well inside. */
export const ATLAS14_LIMITS = {
  maxAris: 12,
  maxTiles: 8,
  maxSide: 2048,
  /** Largest file the app will download or decode. The real one is about 2.2 MB. */
  maxBytes: 8 * MB,
  /** No 1-hour intensity anywhere in Atlas 14 comes near this (the U.S. 1-hr record is ~305 mm). */
  maxMmPerHour: 600,
} as const;

export interface Atlas14Tile {
  /** South-west corner of cell (0, 0), degrees. */
  south: number;
  west: number;
  /** Cell size, degrees (same in lat and lon). */
  step: number;
  nlat: number;
  nlon: number;
  /** values[a][row * nlon + col], row 0 = southernmost; mm/h, NaN = no data. */
  values: Float32Array[];
}

export interface Atlas14Grid {
  aris: number[];
  tiles: Atlas14Tile[];
}

/** Encode (the bake script's writer; also used by tests to build hostile variants). */
export function encodeAtlas14Grid(grid: Atlas14Grid): Uint8Array {
  const nA = grid.aris.length;
  let size = HEADER_BYTES + 2 * nA;
  for (const t of grid.tiles) size += TILE_HEADER_BYTES + 2 * nA * t.nlat * t.nlon;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out.set(MAGIC, 0);
  dv.setUint16(8, nA, true);
  dv.setUint16(10, grid.tiles.length, true);
  let o = HEADER_BYTES;
  for (const a of grid.aris) {
    dv.setUint16(o, a, true);
    o += 2;
  }
  for (const t of grid.tiles) {
    dv.setInt32(o, Math.round(t.south * 1e6), true);
    dv.setInt32(o + 4, Math.round(t.west * 1e6), true);
    dv.setInt32(o + 8, Math.round(t.step * 1e6), true);
    dv.setUint16(o + 12, t.nlat, true);
    dv.setUint16(o + 14, t.nlon, true);
    o += TILE_HEADER_BYTES;
  }
  for (const t of grid.tiles) {
    for (let a = 0; a < nA; a++) {
      const v = t.values[a];
      for (let i = 0; i < t.nlat * t.nlon; i++) {
        const x = v[i];
        dv.setUint16(o, Number.isFinite(x) ? Math.max(0, Math.min(ATLAS14_NODATA - 1, Math.round(x / ATLAS14_UNIT_MM_H))) : ATLAS14_NODATA, true);
        o += 2;
      }
    }
  }
  return out;
}

/**
 * Decode the baked grid. Throws on anything structurally wrong (wrong magic, counts out of range, a length that does
 * not match the header exactly, a tile outside the globe); drops (→ NaN) any cell whose values are out of range or
 * decrease with return period, so one corrupt cell can never yield a nonsense ladder.
 */
export function decodeAtlas14Grid(buf: ArrayBuffer | Uint8Array): Atlas14Grid {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (bytes.byteLength > ATLAS14_LIMITS.maxBytes) throw new Error('Atlas 14 grid: file too large');
  if (bytes.byteLength < HEADER_BYTES) throw new Error('Atlas 14 grid: file too short');
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) throw new Error('Atlas 14 grid: not a Deluge Atlas 14 file');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nA = dv.getUint16(8, true);
  const nT = dv.getUint16(10, true);
  if (nA < 1 || nA > ATLAS14_LIMITS.maxAris) throw new Error('Atlas 14 grid: bad return-period count');
  if (nT < 1 || nT > ATLAS14_LIMITS.maxTiles) throw new Error('Atlas 14 grid: bad tile count');
  let o = HEADER_BYTES;
  const need = (n: number) => {
    if (o + n > bytes.byteLength) throw new Error('Atlas 14 grid: truncated');
  };
  need(2 * nA);
  const aris: number[] = [];
  for (let a = 0; a < nA; a++) {
    const v = dv.getUint16(o, true);
    o += 2;
    if (v < 1 || v > 10000 || (aris.length && v <= aris[aris.length - 1])) throw new Error('Atlas 14 grid: return periods must increase');
    aris.push(v);
  }
  need(TILE_HEADER_BYTES * nT);
  const heads: Array<Omit<Atlas14Tile, 'values'>> = [];
  let cells = 0;
  for (let t = 0; t < nT; t++) {
    const south = dv.getInt32(o, true) / 1e6;
    const west = dv.getInt32(o + 4, true) / 1e6;
    const step = dv.getInt32(o + 8, true) / 1e6;
    const nlat = dv.getUint16(o + 12, true);
    const nlon = dv.getUint16(o + 14, true);
    o += TILE_HEADER_BYTES;
    const ok =
      step >= 0.001 && step <= 5 &&
      nlat >= 1 && nlat <= ATLAS14_LIMITS.maxSide && nlon >= 1 && nlon <= ATLAS14_LIMITS.maxSide &&
      south >= -90 && south + nlat * step <= 90 + 1e-6 &&
      west >= -180 && west + nlon * step <= 180 + 1e-6;
    if (!ok) throw new Error('Atlas 14 grid: tile outside the globe or too large');
    heads.push({ south, west, step, nlat, nlon });
    cells += nlat * nlon;
  }
  // Exact length: no trailing bytes, nothing missing.
  if (bytes.byteLength !== o + 2 * nA * cells) throw new Error('Atlas 14 grid: length does not match its header');
  const maxRaw = ATLAS14_LIMITS.maxMmPerHour / ATLAS14_UNIT_MM_H;
  const tiles: Atlas14Tile[] = heads.map((h) => {
    const n = h.nlat * h.nlon;
    const values: Float32Array[] = [];
    for (let a = 0; a < nA; a++) {
      const v = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const raw = dv.getUint16(o, true);
        o += 2;
        v[i] = raw === ATLAS14_NODATA || raw === 0 || raw > maxRaw ? NaN : raw * ATLAS14_UNIT_MM_H;
      }
      values.push(v);
    }
    // A cell is all-or-nothing and non-decreasing in return period.
    for (let i = 0; i < n; i++) {
      let bad = false;
      for (let a = 0; a < nA; a++) {
        if (!Number.isFinite(values[a][i]) || (a > 0 && values[a][i] < values[a - 1][i])) bad = true;
      }
      if (bad) for (let a = 0; a < nA; a++) values[a][i] = NaN;
    }
    return { ...h, values };
  });
  return { aris, tiles };
}

export interface Atlas14Point {
  lat: number;
  lon: number;
  /** One entry per grid return period (PDS ARI, years), ascending. */
  levels: Array<{ ari: number; mmPerHour: number }>;
}

/**
 * Bilinear interpolation between the four surrounding cell centres, using only the ones with data (weights
 * renormalised). Null when the point is outside every tile or all four are empty (outside Atlas 14 coverage).
 */
export function lookupAtlas14(grid: Atlas14Grid, lat: number, lon: number): Atlas14Point | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  for (const t of grid.tiles) {
    if (lat < t.south || lat > t.south + t.nlat * t.step || lon < t.west || lon > t.west + t.nlon * t.step) continue;
    const fy = (lat - t.south) / t.step - 0.5;
    const fx = (lon - t.west) / t.step - 0.5;
    const y0 = Math.floor(fy);
    const x0 = Math.floor(fx);
    const wy = fy - y0;
    const wx = fx - x0;
    const corners: Array<[number, number, number]> = [
      [y0, x0, (1 - wy) * (1 - wx)],
      [y0, x0 + 1, (1 - wy) * wx],
      [y0 + 1, x0, wy * (1 - wx)],
      [y0 + 1, x0 + 1, wy * wx],
    ];
    const sums = new Array<number>(grid.aris.length).fill(0);
    let wsum = 0;
    for (const [y, x, w] of corners) {
      // Clamp to the tile (a point in the outer half-cell uses the edge cells).
      const yy = Math.min(t.nlat - 1, Math.max(0, y));
      const xx = Math.min(t.nlon - 1, Math.max(0, x));
      const i = yy * t.nlon + xx;
      if (!Number.isFinite(t.values[0][i]) || w <= 0) continue;
      for (let a = 0; a < grid.aris.length; a++) sums[a] += w * t.values[a][i];
      wsum += w;
    }
    // Most of the weight must be on cells with data: a point just past the coverage edge is not extrapolated.
    if (wsum < 0.25) return null;
    return { lat, lon, levels: grid.aris.map((ari, a) => ({ ari, mmPerHour: sums[a] / wsum })) };
  }
  return null;
}

/**
 * The shipped file is gzip-compressed (0.7 MB instead of 2.8 MB, whatever the static host does). Inflate with a hard
 * output cap, reading chunk by chunk, so a gzip bomb in its place stops at `maxOut` bytes instead of taking the tab's
 * memory (the same rule as the PNG decoder, SEC-03). Uncompressed bytes (a host that already removed the gzip layer
 * via Content-Encoding) pass straight through.
 */
export async function gunzipCapped(bytes: Uint8Array, maxOut: number = ATLAS14_LIMITS.maxBytes): Promise<Uint8Array> {
  if (!(bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) return bytes;
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxOut) {
        await reader.cancel().catch(() => {});
        throw new Error('Atlas 14 grid: inflates past its size limit');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('Atlas 14 grid')) throw e;
    throw new Error('Atlas 14 grid: corrupt compressed data');
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

/** Largest compressed download accepted (the real file is ~0.75 MB). */
export const ATLAS14_MAX_DOWNLOAD = 4 * MB;

let gridPromise: Promise<Atlas14Grid> | null = null;

/** Download (once per page) and decode the baked grid. Same-origin, size-capped, never retried into a loop. */
export function loadAtlas14Grid(url = atlas14GridUrl()): Promise<Atlas14Grid> {
  gridPromise ??= fetchBytes(url, { maxBytes: ATLAS14_MAX_DOWNLOAD, timeoutMs: 30000, retries: 1 })
    .then(async (buf) => decodeAtlas14Grid(await gunzipCapped(new Uint8Array(buf))))
    .catch((e) => {
      gridPromise = null;
      throw e;
    });
  return gridPromise;
}

/** Test hook: forget the cached grid. */
export function resetAtlas14Cache(): void {
  gridPromise = null;
}

// ─── PFDS point responses ────────────────────────────────────────────────────────────────────────────────────────────

/** PFDS duration rows, in response order. */
export const PFDS_DURATIONS = ['5-min', '10-min', '15-min', '30-min', '60-min', '2-hr', '3-hr', '6-hr', '12-hr', '24-hr', '2-day', '3-day', '4-day', '7-day', '10-day', '20-day', '30-day', '45-day', '60-day'] as const;
/** PFDS ARI columns, years. */
export const PFDS_ARIS = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000] as const;
/** A real response is about 3.8 kB; anything past this is not one. */
export const PFDS_MAX_BYTES = 32 * 1024;

export type PfdsResult =
  | { covered: false }
  | {
      covered: true;
      lat: number;
      lon: number;
      /** e.g. "Texas" — cleaned to letters, digits, spaces and . , ( ) / & - */
      region: string;
      volume: number;
      version: number;
      /** quantiles[duration][ari], same units as asked (here: mm/h). */
      quantiles: number[][];
      upper: number[][];
      lower: number[][];
    };

const NUM_RE = /^\d{1,5}(?:\.\d{1,4})?$/;

function parseTable(text: string, name: string): number[][] {
  const m = new RegExp(`^${name} = (\\[\\[[0-9'., \\[\\]]{1,12000}\\]\\]);$`, 'm').exec(text);
  if (!m) throw new Error(`PFDS: no ${name} table`);
  const body = m[1];
  const rows = body.slice(2, -2).split('], [');
  if (rows.length !== PFDS_DURATIONS.length) throw new Error(`PFDS: ${name} has ${rows.length} rows`);
  return rows.map((r) => {
    const cells = r.split(', ');
    if (cells.length !== PFDS_ARIS.length) throw new Error(`PFDS: ${name} row has ${cells.length} values`);
    return cells.map((c) => {
      if (c.length < 3 || c[0] !== "'" || c[c.length - 1] !== "'") throw new Error(`PFDS: ${name} value not quoted`);
      const s = c.slice(1, -1);
      if (!NUM_RE.test(s)) throw new Error(`PFDS: ${name} value is not a number`);
      return Number(s);
    });
  });
}

function field(text: string, name: string): string | null {
  const m = new RegExp(`^${name} = '([^'\\n]{0,200})';$`, 'm').exec(text);
  return m ? m[1] : null;
}

/**
 * Parse a PFDS cgi_readH5.py answer for `type=pf&data=intensity&units=metric&series=pds`. Throws on anything that is
 * not exactly that shape; `{covered:false}` for the server's "not within a project area" answer. The response echoes
 * the request: if its lat/lon/series/datatype/unit differ from what was asked, it is not the answer to this question.
 */
export function parsePfdsResponse(input: string | Uint8Array, asked: { lat: number; lon: number }): PfdsResult {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  if (bytes.byteLength > PFDS_MAX_BYTES) throw new Error('PFDS: response too large');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
  } catch {
    throw new Error('PFDS: response is not UTF-8 text');
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new Error('PFDS: control characters in response');
  const result = field(text, 'result');
  if (result === 'none') return { covered: false };
  if (result !== 'values') throw new Error('PFDS: unexpected result');
  if (field(text, 'type') !== 'pf' || field(text, 'ser') !== 'pds' || field(text, 'datatype') !== 'intensity' || field(text, 'unit') !== 'metric') {
    throw new Error('PFDS: response is for a different query');
  }
  const lat = Number(field(text, 'lat'));
  const lon = Number(field(text, 'lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat - asked.lat) > 1e-3 || Math.abs(lon - asked.lon) > 1e-3) {
    throw new Error('PFDS: response is for a different place');
  }
  const volume = Number(field(text, 'volume'));
  const version = Number(field(text, 'version'));
  if (!Number.isInteger(volume) || volume < 1 || volume > 20 || !Number.isInteger(version) || version < 1 || version > 20) throw new Error('PFDS: bad volume');
  const region = (field(text, 'region') ?? '').replace(/[^A-Za-z0-9 .,()/&-]/g, '').slice(0, 60).trim();
  const quantiles = parseTable(text, 'quantiles');
  const upper = parseTable(text, 'upper');
  const lower = parseTable(text, 'lower');
  return { covered: true, lat, lon, region, volume, version, quantiles, upper, lower };
}

/** The 60-minute row of a parsed PFDS answer at the grid's return periods, mm/h. */
export function pfdsOneHour(r: Extract<PfdsResult, { covered: true }>, aris: readonly number[] = ATLAS14_ARIS): number[] {
  const row = r.quantiles[PFDS_DURATIONS.indexOf('60-min')];
  return aris.map((a) => {
    const k = (PFDS_ARIS as readonly number[]).indexOf(a);
    if (k < 0) throw new Error(`PFDS: no ${a}-yr column`);
    return row[k];
  });
}
