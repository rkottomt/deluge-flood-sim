/**
 * Number / unit formatting for the UI. Pure functions (no DOM) so they can be unit-tested in Node.
 * Every formatter tolerates null/undefined (→ "—") and non-finite values (→ "NaN" / "∞"), because the
 * stability demo deliberately produces NaNs and the HUD must keep rendering something sensible.
 */

export const DASH = '—';
const THIN = ' '; // no-break space between number and unit (thin spaces vanish in some UI fonts)
const NBSP = ' ';

export const ACRES_PER_M2 = 1 / 4046.8564224;
export const OLYMPIC_POOL_M3 = 2500;
export const FT_PER_M = 1 / 0.3048;

function bad(v: number | null | undefined): string | null {
  if (v === null || v === undefined) return DASH;
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '−∞';
  return null;
}

/** Locale-independent thousands grouping ("1,234,567"). */
export function groupThousands(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Compact scientific notation for runaway values (the stability demo): "3.4e6", "−1.3e18". */
function sci(v: number): string {
  return v.toExponential(1).replace('e+', 'e').replace(/-/g, '−');
}

/**
 * Beyond these magnitudes formatters switch to scientific notation (only reachable when the solver is
 * unstable): plain grouped numbers above ten billion, SI-suffixed ones above a quadrillion.
 */
const SCI_LIMIT_PLAIN = 1e10;
const SCI_LIMIT = 1e15;

/** Fixed decimals with thousands separators and a real minus sign. */
export function fmtNum(v: number | null | undefined, decimals = 0): string {
  const b = bad(v);
  if (b) return b;
  if (Math.abs(v as number) >= SCI_LIMIT_PLAIN) return sci(v as number);
  const s = Math.abs(v as number).toFixed(decimals);
  const [i, f] = s.split('.');
  const neg = (v as number) < 0 && Number(s) !== 0;
  return (neg ? '−' : '') + groupThousands(i) + (f ? '.' + f : '');
}

/** Sim clock: T+hh:mm:ss, or T+3d 04:05:06 beyond 99 hours. */
export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return 'T+00:00:00';
  const s = Math.floor(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (hh > 99) {
    const d = Math.floor(hh / 24);
    return `T+${d}d${NBSP}${p2(hh % 24)}:${p2(mm)}:${p2(ss)}`;
  }
  return `T+${p2(hh)}:${p2(mm)}:${p2(ss)}`;
}

/** SI-suffixed magnitude: 950 → "950", 12 300 → "12.3 k", 4.56e6 → "4.56 M". */
export function siParts(v: number): { num: string; suffix: string } {
  const a = Math.abs(v);
  if (a >= SCI_LIMIT) return { num: sci(v), suffix: '' };
  const units: Array<[number, string]> = [
    [1e12, 'T'],
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [scale, suffix] of units) {
    if (a >= scale * 0.9995) {
      const x = v / scale;
      const ax = Math.abs(x);
      const d = ax >= 100 ? 0 : ax >= 10 ? 1 : 2;
      return { num: fmtNum(x, d), suffix };
    }
  }
  const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 1 : a === 0 ? 0 : 2;
  return { num: fmtNum(v, d), suffix: '' };
}

export function formatSI(v: number | null | undefined, unit: string): string {
  const b = bad(v);
  if (b) return b;
  const { num, suffix } = siParts(v as number);
  return `${num}${suffix}${THIN}${unit}`;
}

/** Area in km² with sensible precision. */
export function formatKm2(m2: number | null | undefined): string {
  const b = bad(m2);
  if (b) return b;
  const km2 = (m2 as number) / 1e6;
  const a = Math.abs(km2);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2;
  return `${fmtNum(km2, d)}${THIN}km²`;
}

export function formatAcres(m2: number | null | undefined): string {
  const b = bad(m2);
  if (b) return b;
  const ac = (m2 as number) * ACRES_PER_M2;
  if (Math.abs(ac) >= 100000) return `${siParts(ac).num}${siParts(ac).suffix} acres`;
  return `${fmtNum(ac, Math.abs(ac) >= 10 ? 0 : 1)} acres`;
}

/** Volume with SI suffix, e.g. "3.42 M m³". */
export function formatVolume(m3: number | null | undefined): string {
  return formatSI(m3, "m³");
}

/** "1,368 Olympic pools". */
export function formatPools(m3: number | null | undefined): string {
  const b = bad(m3);
  if (b) return b;
  const pools = (m3 as number) / OLYMPIC_POOL_M3;
  const a = Math.abs(pools);
  if (a >= 1e6) {
    const p = siParts(pools);
    return `${p.num}${p.suffix} Olympic pools`;
  }
  const n = fmtNum(pools, a >= 10 ? 0 : 1);
  return `${n} Olympic pool${n === '1.0' || n === '1' ? '' : 's'}`;
}

export function formatMeters(m: number | null | undefined, decimals?: number): string {
  const b = bad(m);
  if (b) return b;
  const a = Math.abs(m as number);
  if (a >= 1e5) return `${sci(m as number)}${THIN}m`;
  const d = decimals ?? (a >= 100 ? 0 : a >= 10 ? 1 : 2);
  return `${fmtNum(m, d)}${THIN}m`;
}

export function formatFeet(m: number | null | undefined, decimals?: number): string {
  const b = bad(m);
  if (b) return b;
  const ft = (m as number) * FT_PER_M;
  const a = Math.abs(ft);
  if (a >= 1e5) return `${sci(ft)}${THIN}ft`;
  const d = decimals ?? (a >= 100 ? 0 : 1);
  return `${fmtNum(ft, d)}${THIN}ft`;
}

export function formatSpeed(ms: number | null | undefined): string {
  const b = bad(ms);
  if (b) return b;
  const a = Math.abs(ms as number);
  if (a >= 1e4) return `${sci(ms as number)}${THIN}m/s`;
  return `${fmtNum(ms, a >= 100 ? 0 : a >= 10 ? 1 : 2)}${THIN}m/s`;
}

/** Relative error (fraction) as percent: 3e-5 → "0.003 %". */
export function formatPercent(frac: number | null | undefined): string {
  const b = bad(frac);
  if (b) return b;
  const p = (frac as number) * 100;
  const a = Math.abs(p);
  let s: string;
  if (a === 0) s = '0.000';
  else if (a < 0.001) s = '<0.001';
  else if (a < 1) s = fmtNum(p, 3);
  else if (a < 100) s = fmtNum(p, 1);
  else if (a < 1e6) s = fmtNum(p, 0);
  else s = p.toExponential(1);
  return `${s}${THIN}%`;
}

/** Timestep: "0.84 s", "42 ms". */
export function formatDt(s: number | null | undefined): string {
  const b = bad(s);
  if (b) return b;
  const v = s as number;
  if (v < 0.1) return `${fmtNum(v * 1000, v < 0.01 ? 1 : 0)}${THIN}ms`;
  return `${fmtNum(v, v >= 10 ? 1 : 2)}${THIN}s`;
}

/** Route distance: "850 m", "3.4 km". */
export function formatDistance(m: number | null | undefined): string {
  const b = bad(m);
  if (b) return b;
  const v = m as number;
  // Boundaries where rounding changes the unit: 996 m reads "1.0 km" (not "1,000 m"), 99,960 m "100 km".
  if (v < 995) return `${fmtNum(Math.round(v / 10) * 10, 0)}${THIN}m`;
  return `${fmtNum(v / 1000, v >= 99_950 ? 0 : 1)}${THIN}km`;
}

/** Travel time: "45 s", "6 min", "1 h 12 min". */
export function formatDuration(s: number | null | undefined): string {
  const b = bad(s);
  if (b) return b;
  const v = Math.max(0, s as number);
  // 59.7 s reads "1 min" (not "60 s").
  if (v < 59.5) return `${Math.round(v)}${THIN}s`;
  const min = Math.round(v / 60);
  if (min < 60) return `${min}${THIN}min`;
  const h = Math.floor(min / 60);
  const mm = min % 60;
  return mm ? `${h}${THIN}h ${mm}${THIN}min` : `${h}${THIN}h`;
}

/** "40.4417° N, 80.0125° W". */
export function formatLatLon(lat: number, lon: number, decimals = 4): string {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return DASH;
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(decimals)}°${NBSP}${ns}, ${Math.abs(lon).toFixed(decimals)}°${NBSP}${ew}`;
}

/** Discharge: "250 m³/s", "12.5 k m³/s". */
export function formatDischarge(q: number | null | undefined): string {
  const b = bad(q);
  if (b) return b;
  const v = q as number;
  if (v >= 10000) return `${fmtNum(v / 1000, 1)}${THIN}k${THIN}m³/s`;
  return `${fmtNum(v, v >= 100 ? 0 : v >= 10 ? 0 : 1)}${THIN}m³/s`;
}

/** Discharge in cubic feet per second (US gauges report cfs). */
export function formatCfs(q: number | null | undefined): string {
  const b = bad(q);
  if (b) return b;
  const cfs = (q as number) * 35.3146667;
  const { num, suffix } = siParts(cfs);
  return `${num}${suffix}${THIN}cfs`;
}

/** Rain rate: "12.5 mm/hr". */
export function formatRain(mmhr: number | null | undefined): string {
  const b = bad(mmhr);
  if (b) return b;
  const v = mmhr as number;
  if (v === 0) return `0${THIN}mm/hr`;
  return `${fmtNum(v, v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 1 : 2)}${THIN}mm/hr`;
}

export function formatInchesPerHour(mmhr: number | null | undefined): string {
  const b = bad(mmhr);
  if (b) return b;
  const v = (mmhr as number) / 25.4;
  return `${fmtNum(v, v >= 10 ? 1 : 2)}${THIN}in/hr`;
}

/** Achieved sim speed multiple: "212×". */
export function formatSpeedup(x: number | null | undefined): string {
  const b = bad(x);
  if (b) return b;
  const v = x as number;
  if (v >= 10000) return `${siParts(v).num}${siParts(v).suffix}×`;
  return `${fmtNum(v, v >= 10 ? 0 : 1)}×`;
}

/** Compact brush size: "35 m", "1.2 km". */
export function formatBrush(m: number): string {
  if (!Number.isFinite(m)) return DASH;
  if (m >= 1000) return `${fmtNum(m / 1000, m >= 10000 ? 0 : 1)}${THIN}km`;
  return `${fmtNum(m, m >= 10 ? 0 : 1)}${THIN}m`;
}

/** Stage in feet: "25.0 ft". */
export function formatStageFt(ft: number | null | undefined): string {
  const b = bad(ft);
  if (b) return b;
  return `${fmtNum(ft, 1)}${THIN}ft`;
}
