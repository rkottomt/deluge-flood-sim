/**
 * Web Mercator helpers (pure). The terrain grid is linear in EPSG:3857 (see contracts / DESIGN §4), so
 * grid ↔ lat/lon is an affine map in mercator meters. Used for the probe readout and the location
 * picker's square footprint preview.
 */
import type { GeoBounds } from '../contracts';

export const EARTH_R = 6378137;
const D2R = Math.PI / 180;

export const lonToMercX = (lon: number) => EARTH_R * lon * D2R;
export const latToMercY = (lat: number) => EARTH_R * Math.log(Math.tan(Math.PI / 4 + (lat * D2R) / 2));
export const mercXToLon = (x: number) => x / EARTH_R / D2R;
export const mercYToLat = (y: number) => (2 * Math.atan(Math.exp(y / EARTH_R)) - Math.PI / 2) / D2R;

/** Grid coords (cell units, j north→south) → WGS84. Equivalent to src/data gridToGeo. */
export function gridToGeoLocal(
  t: { nx: number; ny: number; bounds: GeoBounds },
  gx: number,
  gy: number,
): { lon: number; lat: number } {
  const x0 = lonToMercX(t.bounds.west);
  const x1 = lonToMercX(t.bounds.east);
  const y0 = latToMercY(t.bounds.north);
  const y1 = latToMercY(t.bounds.south);
  return {
    lon: mercXToLon(x0 + (gx / t.nx) * (x1 - x0)),
    lat: mercYToLat(y0 + (gy / t.ny) * (y1 - y0)),
  };
}

/**
 * Bounds of a square of `sizeMeters` ON THE GROUND centered at lat/lon. In Web Mercator the local scale
 * factor is 1/cos(φ), so the mercator extent is size / cos(φ). The result is also a square on a
 * Web Mercator map (e.g. Leaflet), which is exactly what the data loader will fetch.
 */
export function squareFootprint(lat: number, lon: number, sizeMeters: number): GeoBounds {
  const half = sizeMeters / 2 / Math.cos(lat * D2R);
  const cx = lonToMercX(lon);
  const cy = latToMercY(lat);
  return {
    west: mercXToLon(cx - half),
    east: mercXToLon(cx + half),
    south: mercYToLat(cy - half),
    north: mercYToLat(cy + half),
  };
}

/** Haversine distance in meters. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * D2R;
  const dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Coarse "is this covered by USGS 3DEP" check: CONUS, Alaska, Hawaii, Puerto Rico / USVI, Guam.
 * Only used to show a warning — the loader is the authority.
 */
export function isLikelyUSCoverage(lat: number, lon: number): boolean {
  const inBox = (s: number, w: number, n: number, e: number) => lat >= s && lat <= n && lon >= w && lon <= e;
  return (
    inBox(24.3, -125.0, 49.5, -66.8) || // contiguous US
    inBox(51.0, -180.0, 71.6, -129.0) || // Alaska
    inBox(18.8, -160.5, 22.4, -154.6) || // Hawaii
    inBox(17.6, -67.5, 18.6, -64.5) || // Puerto Rico & USVI
    inBox(13.2, 144.5, 13.8, 145.1) // Guam
  );
}
