/**
 * Units and vertical datums for comparing observed water levels with the model.
 *
 * The model's elevations are metres above NAVD88 for every U.S. preset (USGS 3DEP; checked against lidar in
 * public/presets/SOURCES.txt). Observations arrive in U.S. survey or international feet and, for older records, above
 * NGVD29 or a local gauge datum. Every observed level goes through toNavd88Metres() before it meets the model, and an
 * observation in a datum we cannot convert is REJECTED rather than compared — a 0.3 m datum slip is the size of the
 * errors we are trying to measure.
 */

/** International foot, m (NAVD88 elevations in USGS STN and FEMA NFHL are published in international feet). */
export const FT = 0.3048;
/** U.S. survey foot, m (retired 2022; some NGVD29-era records still use it — the difference is 2 ppm, 0.6 mm per 300 m). */
export const US_SURVEY_FT = 1200 / 3937;

export type LengthUnit = 'ft' | 'usft' | 'm';
export type VerticalDatum = 'NAVD88' | 'NGVD29' | 'GAUGE' | 'EGM2008' | 'UNKNOWN';

/**
 * A numeric field of a downloaded record (USGS RDB, ArcGIS attributes): a blank, null or non-numeric value is NaN —
 * not 0, which is what Number('') and Number(null) give, and which would pass as a gauge datum, a coordinate or a
 * BFE of zero.
 */
export function numberField(v: unknown): number {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  return s === '' ? NaN : Number(s);
}

export function toMetres(value: number, unit: LengthUnit): number {
  if (unit === 'm') return value;
  if (unit === 'usft') return value * US_SURVEY_FT;
  return value * FT;
}

/** Normalise the many spellings of a vertical datum in STN / NFHL / NWIS records. */
export function parseDatum(name: string | null | undefined): VerticalDatum {
  const s = String(name ?? '').toUpperCase().replace(/[\s_-]/g, '');
  if (s.startsWith('NAVD88') || s === 'NAVD1988') return 'NAVD88';
  if (s.startsWith('NGVD29') || s === 'NGVD1929') return 'NGVD29';
  if (s === 'EGM2008' || s === 'EGM08') return 'EGM2008';
  if (s.includes('GAUGE') || s.includes('GAGE') || s === 'LOCAL') return 'GAUGE';
  return 'UNKNOWN';
}

/** Parse a length unit spelled as in NFHL (`Feet`, `Meters`, `US Survey Feet`). */
export function parseUnit(name: string | null | undefined): LengthUnit | null {
  const s = String(name ?? '').toLowerCase();
  if (s.includes('survey')) return 'usft';
  if (s.startsWith('f') || s === 'ft') return 'ft';
  if (s.startsWith('m')) return 'm';
  return null;
}

export interface DatumContext {
  /**
   * NAVD88 − NGVD29 at the site, m (NGS VERTCON; e.g. about −0.2 m in Pittsburgh). Required to convert an NGVD29
   * value; without it such values are rejected.
   */
  navd88MinusNgvd29?: number;
  /** Gauge datum (the gauge's zero) in metres NAVD88, to convert a stage reading; without it GAUGE values are rejected. */
  gaugeDatumNavd88?: number;
}

/**
 * An observed level → metres NAVD88, or null when the datum cannot be converted with what `ctx` provides.
 * NAVD88 = NGVD29 + (NAVD88 − NGVD29); a gauge reading is stage + gauge datum.
 */
export function toNavd88Metres(value: number, unit: LengthUnit, datum: VerticalDatum, ctx: DatumContext = {}): number | null {
  if (!Number.isFinite(value)) return null;
  const m = toMetres(value, unit);
  switch (datum) {
    case 'NAVD88':
      return m;
    case 'NGVD29':
      return typeof ctx.navd88MinusNgvd29 === 'number' ? m + ctx.navd88MinusNgvd29 : null;
    case 'GAUGE':
      return typeof ctx.gaugeDatumNavd88 === 'number' ? m + ctx.gaugeDatumNavd88 : null;
    default:
      return null;
  }
}
