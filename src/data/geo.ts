/**
 * Web Mercator (EPSG:3857) math and grid <-> geographic conversions.
 *
 * The simulation grid is linear in Web Mercator: cell columns are equally spaced in mercator X and rows are
 * equally spaced in mercator Y. At the ~1–20 km scale of a Deluge domain the mercator scale factor
 * 1/cos(φ) varies by well under 0.1 % across the domain, so cells are square on the ground to that precision
 * and `cellSize = groundSize / n`.
 */
import type { GeoBounds } from '../contracts';

/** WGS84 semi-major axis used by EPSG:3857, meters. */
export const EARTH_RADIUS = 6378137;
/** Latitude limit of the Web Mercator projection. */
export const MAX_MERCATOR_LAT = 85.05112878;
const DEG = Math.PI / 180;

export interface MercatorBBox {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}

export function lonLatToMercator(lon: number, lat: number): { x: number; y: number } {
  const φ = Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * DEG;
  return {
    x: EARTH_RADIUS * lon * DEG,
    y: EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + φ / 2)),
  };
}

export function mercatorToLonLat(x: number, y: number): { lon: number; lat: number } {
  return {
    lon: x / EARTH_RADIUS / DEG,
    lat: (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG,
  };
}

export function boundsToMercator(b: GeoBounds): MercatorBBox {
  const sw = lonLatToMercator(b.west, b.south);
  const ne = lonLatToMercator(b.east, b.north);
  return { xmin: sw.x, ymin: sw.y, xmax: ne.x, ymax: ne.y };
}

export function mercatorToBounds(m: MercatorBBox): GeoBounds {
  const sw = mercatorToLonLat(m.xmin, m.ymin);
  const ne = mercatorToLonLat(m.xmax, m.ymax);
  return { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat };
}

/** Ground meters per mercator meter at a latitude (the mercator scale factor is 1/cos φ). */
export function groundScale(lat: number): number {
  return Math.cos(lat * DEG);
}

/**
 * Square domain of `sizeMeters` ground meters centered on (lat, lon).
 * The mercator extent is sizeMeters / cos(φ) so the box is `sizeMeters` wide on the ground at its center.
 */
export function squareDomain(
  center: { lat: number; lon: number },
  sizeMeters: number,
): { bounds: GeoBounds; merc: MercatorBBox } {
  const c = lonLatToMercator(center.lon, center.lat);
  const half = sizeMeters / 2 / groundScale(center.lat);
  const merc = { xmin: c.x - half, ymin: c.y - half, xmax: c.x + half, ymax: c.y + half };
  return { bounds: mercatorToBounds(merc), merc };
}

/** Latitude of the mercator-center of a bounds (not the arithmetic mean of south/north). */
export function centerOf(b: GeoBounds): { lat: number; lon: number } {
  const m = boundsToMercator(b);
  return mercatorToLonLat((m.xmin + m.xmax) / 2, (m.ymin + m.ymax) / 2);
}

/** Ground meters per cell for a bounds covered by `nx` columns (square cells). */
export function cellSizeFor(b: GeoBounds, nx: number): number {
  const m = boundsToMercator(b);
  return ((m.xmax - m.xmin) * groundScale(centerOf(b).lat)) / nx;
}

type GridRef = { nx: number; ny: number; bounds: GeoBounds };

/** Geographic → continuous grid coordinates (cell units, j north→south, cell centers at +0.5). */
export function geoToGrid(t: GridRef, lon: number, lat: number): { gx: number; gy: number } {
  const m = boundsToMercator(t.bounds);
  const p = lonLatToMercator(lon, lat);
  return {
    gx: ((p.x - m.xmin) / (m.xmax - m.xmin)) * t.nx,
    gy: ((m.ymax - p.y) / (m.ymax - m.ymin)) * t.ny,
  };
}

/** Continuous grid coordinates → geographic. */
export function gridToGeo(t: GridRef, gx: number, gy: number): { lon: number; lat: number } {
  const m = boundsToMercator(t.bounds);
  const x = m.xmin + (gx / t.nx) * (m.xmax - m.xmin);
  const y = m.ymax - (gy / t.ny) * (m.ymax - m.ymin);
  return mercatorToLonLat(x, y);
}

/**
 * Precomputed affine lon/lat → grid converter for bulk work (road graphs with 100k+ vertices).
 * X is exactly linear in longitude; Y uses the exact mercator formula.
 */
export function makeGeoToGrid(t: GridRef): (lon: number, lat: number) => [number, number] {
  const m = boundsToMercator(t.bounds);
  const sx = t.nx / (m.xmax - m.xmin);
  const sy = t.ny / (m.ymax - m.ymin);
  return (lon, lat) => {
    const p = lonLatToMercator(lon, lat);
    return [(p.x - m.xmin) * sx, (m.ymax - p.y) * sy];
  };
}

/** Round up to a multiple of 16 (grid dimensions must be multiples of 16). */
export function roundTo16(n: number): number {
  return Math.max(16, Math.round(n / 16) * 16);
}

/** Slippy-map tile coordinates (fractional) of a mercator point at zoom z. */
export function mercatorToTile(x: number, y: number, z: number): { tx: number; ty: number } {
  const world = 2 * Math.PI * EARTH_RADIUS;
  const n = 2 ** z;
  return {
    tx: ((x + world / 2) / world) * n,
    ty: ((world / 2 - y) / world) * n,
  };
}

/** Great-circle-free approximate ground distance (m) between two lon/lat points (equirectangular). */
export function groundDistance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const x = (lon2 - lon1) * DEG * Math.cos(((lat1 + lat2) / 2) * DEG);
  const y = (lat2 - lat1) * DEG;
  return Math.hypot(x, y) * EARTH_RADIUS;
}

/**
 * True if a lon/lat lies roughly within USGS 3DEP coverage: CONUS, Alaska (with the Aleutians, which cross the
 * antimeridian), Hawaii, Puerto Rico and the US Virgin Islands, and Guam. The one coverage check (the location picker's
 * "outside coverage" warning uses it too).
 */
export function isLikelyUS(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  const x = ((((lon + 180) % 360) + 360) % 360) - 180;
  const conus = lat > 24 && lat < 50 && x > -125.5 && x < -66;
  const alaska = lat > 51 && lat < 71.6 && (x > -180 && x < -129 || x > 172 && x <= 180);
  const hawaii = lat > 18.5 && lat < 22.5 && x > -160.5 && x < -154.5;
  const prUsvi = lat > 17.5 && lat < 18.7 && x > -67.5 && x < -64.5;
  const guam = lat > 13.2 && lat < 13.8 && x > 144.5 && x < 145.1;
  return conus || alaska || hawaii || prUsvi || guam;
}
