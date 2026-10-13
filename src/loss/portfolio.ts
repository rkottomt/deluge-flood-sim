/**
 * A user's own asset list (spec §E.1), read from a CSV file in the browser, matched to the footprints on the map and
 * assessed with the same per-asset model as the city's buildings.
 *
 * PRIVACY: the file is read with File.text() and parsed here; nothing is sent anywhere (the app has no backend, and
 * its Content-Security-Policy would block an upload to anything but the data endpoints). Every string from the file
 * is cleaned of control and bidi-override characters and capped in length before it can reach the screen, and the UI
 * only ever writes it as text.
 *
 * Columns (header names are case-insensitive; `latitude`/`longitude`/`lng`/`id` are accepted aliases):
 *   asset_id (required) · lat, lon (required unless wkt) · wkt (POLYGON in lon/lat, overrides footprint matching) ·
 *   name · occupancy · replacement_value · contents_value · currency · floors · gfa_m2 · first_floor_height_m ·
 *   critical_elev_m · basement · construction · daily_revenue · gross_margin · recapture · deductible · limit · tags
 *
 * Matching: a point inside a footprint takes that building; otherwise the nearest footprint whose outline is within
 * MATCH_RADIUS_M; otherwise the asset is assessed at its own cell only. A wkt polygon is rasterised onto the grid.
 */
import type { BuildingSet, HazardFields } from '../contracts';
import { pointInRing, type HeightProfile } from '../data/buildings';
import { cleanPlaceLabel } from '../data/placeName';
import type { AccessIndex, AccessResult } from './access';
import { parseCsv, toCsv, type CsvValue } from './csv';
import type { FootprintIndex } from './footprints';
import { ringCells } from './footprints';
import { assessAsset, sampleCells, type AssetResult } from './impact';
import type { Region } from './region';
import {
  assetValue,
  CONSTRUCTIONS,
  curveForOccupancy,
  floorsFromHeight,
  OCCUPANCIES,
  OCCUPANCY_PROFILES,
  occupancyForKind,
  storeyHeightFor,
  type Construction,
  type Occupancy,
} from './value';
import { BUILDING_KINDS } from '../data/buildings';

/** A point within this distance of a footprint's outline is matched to it, m (spec §G.5). */
export const MATCH_RADIUS_M = 30;
/** Most vertices read from one WKT polygon. */
export const MAX_WKT_VERTICES = 5000;
/** Longest asset id / name / tag kept, code points. */
export const MAX_ID_CHARS = 64;
export const MAX_NAME_CHARS = 80;
/** Most issues listed (the rest are counted). */
const MAX_ISSUES = 50;

export interface PortfolioAsset {
  /** 1-based data row in the file (header = row 0), for messages. */
  row: number;
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  /** Outer ring as [lon, lat, lon, lat, …], or null. */
  ring: number[] | null;
  occupancy: Occupancy | null;
  replacementValue: number | null;
  contentsValue: number | null;
  currency: string | null;
  floors: number | null;
  gfaM2: number | null;
  firstFloorHeight: number | null;
  criticalElev: number | null;
  basement: boolean | null;
  construction: Construction | null;
  dailyRevenue: number | null;
  grossMargin: number | null;
  recapture: number | null;
  deductible: number | null;
  limit: number | null;
  tags: string;
}

export interface ParseIssue {
  row: number;
  message: string;
}

export interface PortfolioParse {
  assets: PortfolioAsset[];
  /** Rows skipped, with why. */
  errors: ParseIssue[];
  /** Rows kept with a value ignored, with why. */
  warnings: ParseIssue[];
  /** A problem with the whole file (nothing was read). */
  fatal: string | null;
  /** Issues not listed because of the cap. */
  moreIssues: number;
  /** Columns in the file this reader does not use. */
  ignoredColumns: string[];
}

const ALIASES: Readonly<Record<string, string>> = {
  latitude: 'lat',
  longitude: 'lon',
  lng: 'lon',
  long: 'lon',
  id: 'asset_id',
  assetid: 'asset_id',
};

const KNOWN = new Set([
  'asset_id', 'name', 'lat', 'lon', 'wkt', 'occupancy', 'replacement_value', 'contents_value', 'currency', 'floors', 'gfa_m2',
  'first_floor_height_m', 'critical_elev_m', 'basement', 'construction', 'daily_revenue', 'gross_margin', 'recapture',
  'deductible', 'limit', 'tags',
]);

function normHeader(h: string): string {
  const k = cleanPlaceLabel(h, 40).toLowerCase().replace(/[\s-]+/g, '_');
  return ALIASES[k] ?? k;
}

/**
 * A plain decimal (optionally with thousands commas, a leading + or −, an exponent). null for empty, NaN for junk.
 *
 * `delimiter` is the file's (src/loss/csv.ts detects it from the header). A ';' or tab file is what a spreadsheet in a
 * decimal-comma locale writes (its comma is taken), so there a comma is the DECIMAL mark — "2,500" is 2.5, never 2500 —
 * and dots group thousands only beside a decimal comma ("1.250.000,5"); a lone dot ("12.5") still reads as a decimal
 * point, since many such files are written with dot decimals. A comma file keeps the thousands-comma reading.
 */
export function parseNumber(s: string | undefined, delimiter: ',' | ';' | '\t' = ','): number | null {
  if (s === undefined) return null;
  let t = s.trim();
  if (t === '') return null;
  if (delimiter !== ',') {
    if (/^[+-]?\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
    else if (/^[+-]?\d+,\d+([eE][+-]?\d+)?$/.test(t)) t = t.replace(',', '.');
  } else if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(t)) return NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : NaN;
}

export function parseBool(s: string | undefined): boolean | null | undefined {
  if (s === undefined) return null;
  const t = s.trim().toLowerCase();
  if (t === '') return null;
  if (['true', 'yes', 'y', '1'].includes(t)) return true;
  if (['false', 'no', 'n', '0'].includes(t)) return false;
  return undefined;
}

/**
 * The outer ring of a WKT POLYGON (or the first polygon of a MULTIPOLYGON), as [lon, lat, …] without the closing
 * repeat. Returns a string describing the problem instead when it cannot be read.
 */
export function parseWktPolygon(wkt: string): number[] | string {
  const t = wkt.trim().replace(/^SRID=\d+;/i, '');
  const m = /^(MULTI)?POLYGON\s*\(\s*\(\s*\(?\s*([^()]*)\)/i.exec(t);
  if (!m) return 'wkt is not a POLYGON';
  const pts = m[2].split(',');
  if (pts.length > MAX_WKT_VERTICES + 1) return `wkt polygon has more than ${MAX_WKT_VERTICES} vertices`;
  const ring: number[] = [];
  for (const p of pts) {
    const xy = p.trim().split(/\s+/);
    if (xy.length < 2) return 'wkt has a malformed coordinate';
    const x = parseNumber(xy[0]);
    const y = parseNumber(xy[1]);
    if (x === null || y === null || Number.isNaN(x) || Number.isNaN(y) || Math.abs(x) > 180 || Math.abs(y) > 90) return 'wkt has a coordinate out of range';
    ring.push(x, y);
  }
  if (ring.length >= 4 && ring[0] === ring[ring.length - 2] && ring[1] === ring[ring.length - 1]) ring.length -= 2;
  if (ring.length < 6) return 'wkt polygon needs at least three corners';
  return ring;
}

export function parsePortfolio(text: string): PortfolioParse {
  const out: PortfolioParse = { assets: [], errors: [], warnings: [], fatal: null, moreIssues: 0, ignoredColumns: [] };
  const table = parseCsv(text);
  if (table.error) {
    out.fatal = table.error;
    return out;
  }
  const header = table.header.map(normHeader);
  const col = new Map<string, number>();
  header.forEach((h, i) => {
    if (h && !col.has(h)) col.set(h, i);
  });
  out.ignoredColumns = header.filter((h) => h && !KNOWN.has(h)).map((h) => cleanPlaceLabel(h, 40));
  const missing: string[] = [];
  if (!col.has('asset_id')) missing.push('asset_id');
  if (!col.has('wkt') && !(col.has('lat') && col.has('lon'))) missing.push(col.has('lat') ? 'lon' : col.has('lon') ? 'lat' : 'lat, lon (or wkt)');
  if (missing.length) {
    out.fatal = `Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`;
    return out;
  }
  let issues = 0;
  const note = (list: ParseIssue[], row: number, message: string) => {
    if (issues++ < MAX_ISSUES) list.push({ row, message });
    else out.moreIssues++;
  };
  for (const w of table.warnings) note(out.warnings, 0, w);
  if (table.truncatedRows) note(out.warnings, 0, `Only the first ${table.rows.length} rows were read; ${table.truncatedRows} more were ignored.`);

  const seen = new Set<string>();
  table.rows.forEach((cells, r) => {
    const row = r + 1;
    const get = (k: string) => {
      const i = col.get(k);
      return i === undefined ? undefined : cells[i];
    };
    const num = (k: string, lo = -Infinity, hi = Infinity): number | null => {
      const v = parseNumber(get(k), table.delimiter);
      if (v === null) return null;
      if (Number.isNaN(v) || v < lo || v > hi) {
        note(out.warnings, row, `${k} is not a valid number${Number.isFinite(lo) || Number.isFinite(hi) ? ` in range` : ''}; ignored.`);
        return null;
      }
      return v;
    };
    const id = cleanPlaceLabel(get('asset_id') ?? '', MAX_ID_CHARS);
    if (!id) {
      note(out.errors, row, 'asset_id is empty; row skipped.');
      return;
    }
    if (seen.has(id)) note(out.warnings, row, `asset_id "${id}" appears more than once.`);
    seen.add(id);

    let ring: number[] | null = null;
    const wkt = get('wkt');
    if (wkt && wkt.trim()) {
      const parsed = parseWktPolygon(wkt);
      if (typeof parsed === 'string') note(out.warnings, row, `${parsed}; using lat/lon instead.`);
      else ring = parsed;
    }
    let lat = num('lat', -90, 90);
    let lon = num('lon', -180, 180);
    if (lat === null || lon === null) {
      if (!ring) {
        note(out.errors, row, 'needs a valid lat and lon (or a wkt polygon); row skipped.');
        return;
      }
      lat = lon = null;
    }

    let occupancy: Occupancy | null = null;
    const occRaw = (get('occupancy') ?? '').trim().toLowerCase();
    if (occRaw) {
      if ((OCCUPANCIES as readonly string[]).includes(occRaw)) occupancy = occRaw as Occupancy;
      else note(out.warnings, row, `occupancy "${cleanPlaceLabel(occRaw, 24)}" is not one of the listed classes; inferred from the map instead.`);
    }
    let construction: Construction | null = null;
    const conRaw = (get('construction') ?? '').trim().toLowerCase();
    if (conRaw) {
      if ((CONSTRUCTIONS as readonly string[]).includes(conRaw)) construction = conRaw as Construction;
      else note(out.warnings, row, `construction "${cleanPlaceLabel(conRaw, 24)}" is not recognised; treated as masonry.`);
    }
    let currency: string | null = null;
    const curRaw = (get('currency') ?? '').trim().toUpperCase();
    if (curRaw) {
      if (/^[A-Z]{3}$/.test(curRaw)) currency = curRaw;
      else note(out.warnings, row, 'currency is not an ISO 4217 code; ignored.');
    }
    const basement = parseBool(get('basement'));
    if (basement === undefined) note(out.warnings, row, 'basement is not true/false; ignored.');
    let margin = num('gross_margin', 0, 100);
    if (margin !== null && margin > 1) {
      note(out.warnings, row, 'gross_margin above 1 read as a percentage.');
      margin /= 100;
    }
    out.assets.push({
      row,
      id,
      name: cleanPlaceLabel(get('name') ?? '', MAX_NAME_CHARS),
      lat,
      lon,
      ring,
      occupancy,
      replacementValue: num('replacement_value', 0),
      contentsValue: num('contents_value', 0),
      currency,
      floors: num('floors', 1, 200),
      gfaM2: num('gfa_m2', 0),
      firstFloorHeight: num('first_floor_height_m', -5, 20),
      criticalElev: num('critical_elev_m', -10, 100),
      basement: basement ?? null,
      construction,
      dailyRevenue: num('daily_revenue', 0),
      grossMargin: margin,
      recapture: num('recapture', 0, 1),
      deductible: num('deductible', 0),
      limit: num('limit', 0),
      tags: cleanPlaceLabel(get('tags') ?? '', MAX_NAME_CHARS),
    });
  });
  return out;
}

// ─── Matching ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MatchKind = 'wkt' | 'inside' | 'nearest' | 'point' | 'outside';

export interface MatchedAsset {
  asset: PortfolioAsset;
  gx: number;
  gy: number;
  match: MatchKind;
  /** Footprint index, or −1. */
  building: number;
  /** Distance to the matched footprint's outline, m (0 inside). */
  distanceM: number;
  /** Grid cells assessed. */
  cells: number[];
}

/** Squared distance from (x, y) to segment a–b. */
function segDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const px = ax + t * dx - x;
  const py = ay + t * dy - y;
  return px * px + py * py;
}

export function matchAssets(
  assets: readonly PortfolioAsset[],
  set: BuildingSet | null,
  fp: FootprintIndex | null,
  grid: { nx: number; ny: number; cellSize: number },
  toGrid: (lon: number, lat: number) => [number, number],
): MatchedAsset[] {
  const { nx, ny, cellSize } = grid;
  // Bucket footprints by bounding box.
  const B = 16;
  const bw = Math.ceil(nx / B);
  const bh = Math.ceil(ny / B);
  let buckets: number[][] | null = null;
  if (set && fp && fp.count) {
    buckets = Array.from({ length: bw * bh }, () => []);
    for (let k = 0; k < fp.count; k++) {
      const i0 = Math.max(0, Math.floor(fp.minX[k] / B));
      const i1 = Math.min(bw - 1, Math.floor(fp.maxX[k] / B));
      const j0 = Math.max(0, Math.floor(fp.minY[k] / B));
      const j1 = Math.min(bh - 1, Math.floor(fp.maxY[k] / B));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) buckets[j * bw + i].push(k);
    }
  }
  const radius = MATCH_RADIUS_M / cellSize;
  const out: MatchedAsset[] = [];
  for (const a of assets) {
    if (a.ring) {
      const g: number[] = [];
      for (let i = 0; i < a.ring.length; i += 2) g.push(...toGrid(a.ring[i], a.ring[i + 1]));
      let sx = 0;
      let sy = 0;
      for (let i = 0; i < g.length; i += 2) {
        sx += g[i];
        sy += g[i + 1];
      }
      const gx = sx / (g.length / 2);
      const gy = sy / (g.length / 2);
      const cells = ringCells(g, nx, ny);
      out.push({ asset: a, gx, gy, match: cells.length ? 'wkt' : 'outside', building: -1, distanceM: 0, cells });
      continue;
    }
    const [gx, gy] = toGrid(a.lon as number, a.lat as number);
    if (!(gx >= 0 && gy >= 0 && gx < nx && gy < ny)) {
      out.push({ asset: a, gx, gy, match: 'outside', building: -1, distanceM: NaN, cells: [] });
      continue;
    }
    let found = -1;
    let foundD2 = radius * radius;
    let inside = false;
    if (buckets && set && fp) {
      const bi = Math.floor(gx / B);
      const bj = Math.floor(gy / B);
      const span = Math.ceil(radius / B) + 1;
      const tested = new Set<number>();
      outer: for (let j = bj - span; j <= bj + span; j++) {
        if (j < 0 || j >= bh) continue;
        for (let i = bi - span; i <= bi + span; i++) {
          if (i < 0 || i >= bw) continue;
          for (const k of buckets[j * bw + i]) {
            if (tested.has(k)) continue;
            tested.add(k);
            if (gx < fp.minX[k] - radius || gx > fp.maxX[k] + radius || gy < fp.minY[k] - radius || gy > fp.maxY[k] + radius) continue;
            const a0 = set.offsets[k];
            const a1 = set.offsets[k + 1];
            const ring = set.verts.subarray(a0 * 2, a1 * 2);
            if (gx >= fp.minX[k] && gx <= fp.maxX[k] && gy >= fp.minY[k] && gy <= fp.maxY[k] && pointInRing(ring, gx, gy)) {
              found = k;
              foundD2 = 0;
              inside = true;
              break outer;
            }
            const m = a1 - a0;
            for (let p = 0, q = m - 1; p < m; q = p++) {
              const d2 = segDist2(gx, gy, ring[q * 2], ring[q * 2 + 1], ring[p * 2], ring[p * 2 + 1]);
              if (d2 < foundD2) {
                foundD2 = d2;
                found = k;
              }
            }
          }
        }
      }
    }
    if (found >= 0 && fp) {
      out.push({
        asset: a,
        gx,
        gy,
        match: inside ? 'inside' : 'nearest',
        building: found,
        distanceM: Math.sqrt(foundD2) * cellSize,
        cells: Array.from(fp.cells.subarray(fp.offsets[found], fp.offsets[found + 1])),
      });
    } else {
      out.push({ asset: a, gx, gy, match: 'point', building: -1, distanceM: NaN, cells: [Math.floor(gy) * nx + Math.floor(gx)] });
    }
  }
  return out;
}

// ─── Assessment ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PortfolioResult extends AssetResult {
  m: MatchedAsset;
  occ: Occupancy;
  floors: number;
  gfaM2: number;
  valueStructure: number;
  valueContents: number;
  valueSource: 'given' | 'unit-cost' | 'none';
  currency: string;
}

export interface PortfolioSummary {
  assets: number;
  outside: number;
  reached: number;
  destroyed: number;
  /**
   * Totals in the region's currency (USD); assets in another currency are summed separately below. NaN (shown "—")
   * when no asset contributed one — nothing assessed, or nothing valued in USD — so an unknown total never reads $0.
   * bi / insured likewise sum only the assets with revenue / policy terms, and are NaN when none has them.
   */
  loss: number;
  lossLo: number;
  lossHi: number;
  bi: number;
  insured: number;
  /** Assets with no value (no replacement_value and no cost row): their loss is unknown, not zero. */
  unvalued: number;
  /** Assets whose values are in a currency other than USD (not added to the totals). */
  otherCurrency: number;
  earliest: { id: string; firstWet: number; leadTime: number } | null;
}

export function assessPortfolio(
  matched: readonly MatchedAsset[],
  fields: HazardFields,
  ctx: {
    region: Region;
    set: BuildingSet | null;
    fp: FootprintIndex | null;
    heightProfile?: HeightProfile;
    debrisFlow?: boolean;
    alertTime?: number;
    access?: AccessResult | AccessIndex | null;
  },
): { results: PortfolioResult[]; summary: PortfolioSummary } {
  const accessIndex = ctx.access ? (('query' in ctx.access ? ctx.access : ctx.access.index) ?? null) : null;
  const results: PortfolioResult[] = [];
  const sum: PortfolioSummary = { assets: matched.length, outside: 0, reached: 0, destroyed: 0, loss: 0, lossLo: 0, lossHi: 0, bi: 0, insured: 0, unvalued: 0, otherCurrency: 0, earliest: null };
  const profile = ctx.heightProfile ?? 'us';
  let nLoss = 0;
  let nBi = 0;
  let nInsured = 0;
  for (const m of matched) {
    const a = m.asset;
    if (m.match === 'outside' || m.cells.length === 0) {
      sum.outside++;
      continue;
    }
    const k = m.building;
    const area = k >= 0 && ctx.fp ? ctx.fp.areaM2[k] : 0;
    const mapFloors = k >= 0 && ctx.set ? floorsFromHeight(ctx.set.height[k], profile) : 1;
    let occ = a.occupancy;
    if (!occ) occ = k >= 0 && ctx.set ? occupancyForKind(BUILDING_KINDS[ctx.set.kind[k]] ?? 'other', area, mapFloors).occ : 'other';
    const prof = OCCUPANCY_PROFILES[occ];
    const floors = a.floors ?? (prof.maxFloors ? Math.min(prof.maxFloors, mapFloors) : mapFloors);
    const gfa = a.gfaM2 ?? area * floors;
    const currency = a.currency ?? ctx.region.currency;
    const foreign = currency !== ctx.region.currency;
    // Unit costs are USD: never mix them with a row priced in another currency.
    const value = assetValue({
      occ,
      gfaM2: gfa,
      country: foreign ? null : ctx.region.costCountry,
      construction: a.construction,
      structureGiven: a.replacementValue,
      contentsGiven: a.contentsValue,
    });
    const s = sampleCells(fields, m.cells);
    const gp = a.dailyRevenue != null && a.grossMargin != null ? a.dailyRevenue * a.grossMargin : null;
    const r = assessAsset(
      s,
      {
        occ,
        floors,
        storeyHeight: storeyHeightFor(floors, profile),
        structure: value.structure,
        contents: value.contents,
        construction: a.construction,
        firstFloorHeight: a.firstFloorHeight ?? 0,
        criticalElev: a.criticalElev,
        dailyGrossProfit: gp,
        recapture: a.recapture,
        deductible: a.deductible,
        limit: a.limit,
      },
      { curve: curveForOccupancy(occ, ctx.region.continent), debrisFlow: !!ctx.debrisFlow, alertTime: ctx.alertTime ?? 0 },
      accessIndex ? accessIndex.query(m.gx, m.gy) : null,
    );
    results.push({ ...r, m, occ, floors, gfaM2: gfa, valueStructure: value.structure, valueContents: value.contents, valueSource: value.source, currency });
    if (r.reached) sum.reached++;
    if (r.state === 'collapse') sum.destroyed++;
    if (value.source === 'none') sum.unvalued++;
    if (foreign) sum.otherCurrency++;
    else if (Number.isFinite(r.loss)) {
      sum.loss += r.loss;
      sum.lossLo += r.lossLo;
      sum.lossHi += r.lossHi;
      nLoss++;
      if (Number.isFinite(r.biLoss)) ((sum.bi += r.biLoss), nBi++);
      if (Number.isFinite(r.insuredLoss)) ((sum.insured += r.insuredLoss), nInsured++);
    }
    if (r.reached && r.firstWet > 0 && (!sum.earliest || r.firstWet < sum.earliest.firstWet)) {
      sum.earliest = { id: a.id, firstWet: r.firstWet, leadTime: r.leadTime };
    }
  }
  if (!nLoss) sum.loss = sum.lossLo = sum.lossHi = NaN;
  if (!nBi) sum.bi = NaN;
  if (!nInsured) sum.insured = NaN;
  return { results, summary: sum };
}

// ─── One site (due diligence) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A single site — a parcel a developer is weighing, a planned building, one asset typed in by hand — assessed exactly
 * like a portfolio row. Give its position in grid coordinates (gx, gy) or as lon/lat, and optionally its outline
 * (gridRing in grid coords, or ring in lon/lat). By default a site is NOT matched to an existing footprint
 * (a planned building is not the shed standing there today); set matchFootprint to value it from the building
 * under the point instead. Planned values (replacement_value, floors, gfa_m2, occupancy …) are the same fields as the
 * CSV schema. Pure: call it for every candidate site against one HazardFields.
 */
export interface SiteInput extends Partial<Omit<PortfolioAsset, 'row' | 'id'>> {
  id?: string;
  gx?: number;
  gy?: number;
  /** Outline in grid coords [gx, gy, …], open ring. */
  gridRing?: number[] | null;
  matchFootprint?: boolean;
}

export function siteAsset(site: SiteInput): PortfolioAsset {
  return {
    row: 0,
    id: cleanPlaceLabel(site.id ?? 'site', MAX_ID_CHARS) || 'site',
    name: cleanPlaceLabel(site.name ?? '', MAX_NAME_CHARS),
    lat: site.lat ?? null,
    lon: site.lon ?? null,
    ring: site.ring ?? null,
    occupancy: site.occupancy ?? null,
    replacementValue: site.replacementValue ?? null,
    contentsValue: site.contentsValue ?? null,
    currency: site.currency ?? null,
    floors: site.floors ?? null,
    gfaM2: site.gfaM2 ?? null,
    firstFloorHeight: site.firstFloorHeight ?? null,
    criticalElev: site.criticalElev ?? null,
    basement: site.basement ?? null,
    construction: site.construction ?? null,
    dailyRevenue: site.dailyRevenue ?? null,
    grossMargin: site.grossMargin ?? null,
    recapture: site.recapture ?? null,
    deductible: site.deductible ?? null,
    limit: site.limit ?? null,
    tags: cleanPlaceLabel(site.tags ?? '', MAX_NAME_CHARS),
  };
}

export function assessSite(
  site: SiteInput,
  fields: HazardFields,
  ctx: Parameters<typeof assessPortfolio>[2] & { grid: { nx: number; ny: number; cellSize: number }; toGrid: (lon: number, lat: number) => [number, number] },
): PortfolioResult | null {
  const asset = siteAsset(site);
  const { nx, ny } = ctx.grid;
  let m: MatchedAsset;
  if (site.gridRing && site.gridRing.length >= 6) {
    const g = site.gridRing;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < g.length; i += 2) {
      sx += g[i];
      sy += g[i + 1];
    }
    const cells = ringCells(g, nx, ny);
    m = { asset, gx: sx / (g.length / 2), gy: sy / (g.length / 2), match: cells.length ? 'wkt' : 'outside', building: -1, distanceM: 0, cells };
  } else if (site.gx !== undefined && site.gy !== undefined && !site.ring) {
    const gx = site.gx;
    const gy = site.gy;
    const inside = gx >= 0 && gy >= 0 && gx < nx && gy < ny;
    if (inside && site.matchFootprint) {
      // Match through the same rules as a CSV point, by way of a lon/lat-free shim.
      m = matchAssets([asset], ctx.set, ctx.fp, ctx.grid, () => [gx, gy])[0];
    } else {
      m = { asset, gx, gy, match: inside ? 'point' : 'outside', building: -1, distanceM: NaN, cells: inside ? [Math.floor(gy) * nx + Math.floor(gx)] : [] };
    }
  } else {
    m = matchAssets([asset], site.matchFootprint ? ctx.set : null, site.matchFootprint ? ctx.fp : null, ctx.grid, ctx.toGrid)[0];
  }
  const r = assessPortfolio([m], fields, ctx);
  return r.results[0] ?? null;
}

// ─── Export ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN);
const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : NaN);
const minutes = (s: number) => (s >= 0 && Number.isFinite(s) ? Math.round((s / 60) * 10) / 10 : NaN);
const minutesSigned = (s: number) => (Number.isFinite(s) ? Math.round((s / 60) * 10) / 10 : NaN);

export const RESULT_COLUMNS = [
  'asset_id', 'name', 'source', 'occupancy', 'match', 'match_distance_m', 'max_depth_m', 'wet_share_pct', 'depth_above_floor_m', 'max_velocity_ms',
  'max_dv_m2s', 'aidr_class', 'fd2321_hr', 'fd2321_class', 'first_wet_min', 'lead_time_min', 'wet_duration_min', 'structural_state',
  'damage_pct', 'value_structure', 'value_contents', 'value_source', 'loss_structure', 'loss_contents', 'loss_total',
  'loss_low_1sigma', 'loss_high_1sigma', 'downtime_days_heuristic', 'bi_loss', 'insured_loss', 'critical_equipment_wet',
  'access_road_cut', 'access_road', 'access_cut_from_min', 'access_lead_time_min', 'currency',
] as const;

export interface ResultRowInput {
  id: string;
  name: string;
  source: 'portfolio' | 'map';
  occ: Occupancy;
  match: string;
  matchDistanceM: number;
  r: AssetResult;
  valueStructure: number;
  valueContents: number;
  valueSource: string;
  currency: string;
}

export function resultRow(x: ResultRowInput): CsvValue[] {
  const r = x.r;
  return [
    x.id,
    x.name,
    x.source,
    x.occ,
    x.match,
    r2(x.matchDistanceM),
    r2(r.depth),
    r2(r.wetFraction * 100),
    r2(r.depthAboveFloor),
    r2(r.speed),
    r2(r.dv),
    `H${r.aidr}`,
    r2(r.hr),
    r.hrClass,
    minutes(r.firstWet),
    minutesSigned(r.leadTime),
    minutes(r.wetSeconds),
    r.state,
    r2(r.damage * 100),
    r0(x.valueStructure),
    r0(x.valueContents),
    x.valueSource,
    r0(r.lossStructure),
    r0(r.lossContents),
    r0(r.loss),
    r0(r.lossLo),
    r0(r.lossHi),
    r2(r.downtimeDays),
    r0(r.biLoss),
    r0(r.insuredLoss),
    r.criticalWet === null ? '' : r.criticalWet,
    r.accessKnown ? r.accessCut : '',
    r.accessRoad,
    minutes(r.accessCutAt),
    minutesSigned(r.accessLeadTime),
    x.currency,
  ];
}

export function resultsCsv(rows: readonly ResultRowInput[]): string {
  return toCsv(RESULT_COLUMNS, rows.map(resultRow));
}
