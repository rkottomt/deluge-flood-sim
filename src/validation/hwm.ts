/**
 * USGS Short-Term Network (STN) high-water marks → the points the model is scored against.
 *
 * Source: USGS Flood Event Viewer / STN Services, `https://stn.wim.usgs.gov/STNServices/HWMs/FilteredHWMs.json?Event=<id>`
 * (public domain, U.S. Geological Survey). One record per surveyed mark; several marks often share a site (both banks,
 * inside and outside a building). Elevations are `elev_ft` in the record's `verticalDatumName`, which for every mark
 * inside a Deluge domain is NAVD88 (international feet).
 *
 * Which marks count — the rule is applied in code, the same for every event, and every rejected mark is kept in the
 * derived file with its reason so the report can show what was left out:
 *  • a SURVEYED elevation (elev_ft present) in a datum we can convert (src/validation/datum.ts);
 *  • a peak-marking type: seed / mud / debris / vegetation / stain line, or "present at peak". Type "Other" is rejected:
 *    in Harvey those records are a USACE measure point minus a series of tape-downs — a stage time series, not a peak;
 *  • a quality of Excellent, Good or Fair (±0.05–0.20 ft). Poor (±0.40 ft) and Very Poor are rejected;
 *  • a surveyed vertical method. A "Tape measure" reading is a tape-down from a bridge rail to the water at an unknown
 *    time; in Harvey the three of them sit 7–10 m below every surveyed mark within 2 km, so they are rejected.
 * Accepted marks at one site are then merged into one point (median elevation) so a site with eight marks does not
 * outvote a site with one.
 */
import { parseDatum, toNavd88Metres, type DatumContext, type VerticalDatum } from './datum';

/** The STN fields we read (the API returns many more). */
export interface StnHwmRecord {
  hwm_id: number;
  site_no?: string;
  site_id?: number;
  latitude_dd?: number;
  longitude_dd?: number;
  latitude?: number;
  longitude?: number;
  elev_ft?: number | null;
  verticalDatumName?: string;
  hwmQualityName?: string;
  hwmTypeName?: string;
  verticalMethodName?: string;
  hwm_environment?: string;
  stillwater?: number | string | null;
  height_above_gnd?: number | null;
  waterbody?: string;
  siteDescription?: string;
  hwm_locationdescription?: string;
  eventName?: string;
}

export type HwmQuality = 'excellent' | 'good' | 'fair' | 'poor' | 'very poor' | 'unknown';

export interface HighWaterMark {
  id: number;
  site: string;
  lon: number;
  lat: number;
  /** Observed peak water-surface elevation, m NAVD88. */
  elevation: number;
  /** As published, ft, in `datum`. */
  elevationFt: number;
  datum: VerticalDatum;
  quality: HwmQuality;
  type: string;
  method: string;
  environment: 'riverine' | 'coastal' | 'unknown';
  /** Height of the mark above the ground beside it, m, if the survey recorded one. */
  heightAboveGround: number | null;
  waterbody: string;
  description: string;
}

export interface RejectedMark {
  id: number;
  site: string;
  reason: string;
}

const PEAK_TYPES = /^(seed line|mud line|debris|vegetation line|stain line|present at peak)/i;

export function parseQuality(name: string | null | undefined): HwmQuality {
  const s = String(name ?? '').toLowerCase();
  if (s.startsWith('excellent')) return 'excellent';
  if (s.startsWith('good')) return 'good';
  if (s.startsWith('fair')) return 'fair';
  if (s.startsWith('poor')) return 'poor';
  if (s.startsWith('vp') || s.startsWith('very poor')) return 'very poor';
  return 'unknown';
}

function environmentOf(s: string | undefined): HighWaterMark['environment'] {
  const v = String(s ?? '').toLowerCase();
  return v.startsWith('riverine') ? 'riverine' : v.startsWith('coastal') ? 'coastal' : 'unknown';
}

/**
 * Parse and screen STN records. `inside(lon, lat)` limits the result to a domain (rejected marks outside it are not
 * listed at all — they are simply somewhere else).
 */
export function parseStnHwms(
  records: readonly StnHwmRecord[],
  inside: (lon: number, lat: number) => boolean,
  ctx: DatumContext = {},
): { marks: HighWaterMark[]; rejected: RejectedMark[] } {
  const marks: HighWaterMark[] = [];
  const rejected: RejectedMark[] = [];
  for (const r of records) {
    const lon = Number(r.longitude_dd ?? r.longitude);
    const lat = Number(r.latitude_dd ?? r.latitude);
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !inside(lon, lat)) continue;
    const site = String(r.site_no ?? r.site_id ?? r.hwm_id);
    const reject = (reason: string) => rejected.push({ id: r.hwm_id, site, reason });
    if (r.elev_ft === null || r.elev_ft === undefined || !Number.isFinite(Number(r.elev_ft))) {
      reject('not surveyed (no elevation)');
      continue;
    }
    const datum = parseDatum(r.verticalDatumName);
    const elevation = toNavd88Metres(Number(r.elev_ft), 'ft', datum, ctx);
    if (elevation === null) {
      reject(`datum ${r.verticalDatumName ?? '?'} cannot be converted`);
      continue;
    }
    const type = String(r.hwmTypeName ?? '');
    if (!PEAK_TYPES.test(type)) {
      reject(`type "${type}" does not mark a peak`);
      continue;
    }
    const quality = parseQuality(r.hwmQualityName);
    if (quality !== 'excellent' && quality !== 'good' && quality !== 'fair') {
      reject(`quality ${quality}`);
      continue;
    }
    const method = String(r.verticalMethodName ?? '');
    if (/tape/i.test(method)) {
      reject('tape-down reading (time and reference unknown)');
      continue;
    }
    const hag = r.height_above_gnd;
    marks.push({
      id: r.hwm_id,
      site,
      lon,
      lat,
      elevation,
      elevationFt: Number(r.elev_ft),
      datum,
      quality,
      type,
      method,
      environment: environmentOf(r.hwm_environment),
      heightAboveGround: typeof hag === 'number' && Number.isFinite(hag) && hag > 0 ? hag * 0.3048 : null,
      waterbody: String(r.waterbody ?? ''),
      description: String(r.siteDescription ?? r.hwm_locationdescription ?? '').slice(0, 120),
    });
  }
  return { marks, rejected };
}

/** One validation point per site: the median elevation (and mean position) of the site's accepted marks. */
export interface HwmSite {
  site: string;
  lon: number;
  lat: number;
  elevation: number;
  marks: number;
  /** Spread of the merged marks' elevations, m (max − min): how much the site disagrees with itself. */
  spread: number;
  environment: HighWaterMark['environment'];
  quality: HwmQuality;
  description: string;
  waterbody: string;
  ids: number[];
}

const QUALITY_RANK: Record<HwmQuality, number> = { excellent: 0, good: 1, fair: 2, poor: 3, 'very poor': 4, unknown: 5 };

export function mergeBySite(marks: readonly HighWaterMark[]): HwmSite[] {
  const by = new Map<string, HighWaterMark[]>();
  for (const m of marks) {
    const list = by.get(m.site) ?? [];
    list.push(m);
    by.set(m.site, list);
  }
  const out: HwmSite[] = [];
  for (const [site, list] of by) {
    const e = list.map((m) => m.elevation).sort((a, b) => a - b);
    const mid = e.length >> 1;
    const median = e.length % 2 ? e[mid] : (e[mid - 1] + e[mid]) / 2;
    const best = [...list].sort((a, b) => QUALITY_RANK[a.quality] - QUALITY_RANK[b.quality])[0];
    out.push({
      site,
      lon: list.reduce((s, m) => s + m.lon, 0) / list.length,
      lat: list.reduce((s, m) => s + m.lat, 0) / list.length,
      elevation: median,
      marks: list.length,
      spread: e[e.length - 1] - e[0],
      environment: best.environment,
      quality: best.quality,
      description: best.description,
      waterbody: best.waterbody,
      ids: list.map((m) => m.id),
    });
  }
  return out.sort((a, b) => a.site.localeCompare(b.site));
}
