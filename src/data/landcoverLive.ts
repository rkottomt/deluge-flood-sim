/**
 * Land cover for live areas in the conterminous US (ARCHITECTURE.md §3.11): NLCD 2021 from the MRLC GeoServer WCS,
 * which answers with `Access-Control-Allow-Origin: *`, sampled onto the live grid the same way the preset bake does
 * (scripts/bake-landcover.ts), and the storm-drain design rainfall from the NOAA Atlas 14 grid this app already ships
 * (src/data/atlas14.ts, same origin). Elsewhere live areas still have no land cover: ESA WorldCover's bucket sends no
 * CORS headers, so a page cannot read it.
 *
 * SECURITY (src/data/csp.ts; FINDINGS SEC-02/03). One exact endpoint is added to connect-src. The request asks for an
 * UNCOMPRESSED tiled GeoTIFF and the decoder refuses anything else, so a hostile or broken upstream cannot hand the
 * page an unbounded inflate (as for the DEM); the body is size-capped, the grid checked (30 m, EPSG:5070 extent), and
 * any class code outside the NLCD legend is read as "no data" (the uniform n, no drains). Best-effort: a failure
 * leaves the area without land cover, as before.
 */
import { fromArrayBuffer } from 'geotiff';
import type { GeoBounds as Bounds } from '../contracts';
import { atlas14MayCover, loadAtlas14Grid, lookupAtlas14 } from './atlas14';
import { boundsToMercator, mercatorToLonLat } from './geo';
import { LANDCOVER_ATTRIBUTION, NLCD_CLASSES, type LandCover } from './landcover';
import { fetchBytes, MB } from './net';

/** MRLC GeoServer WCS 2.0.1 endpoint and the NLCD 2021 CONUS coverage (the one the preset bake reads). */
export const NLCD_WCS = 'https://www.mrlc.gov/geoserver/mrlc_download/wcs';
export const NLCD_COVERAGE = 'mrlc_download__NLCD_2021_Land_Cover_L48';
/** Land-cover raster edge length for a live area, pixels (the presets' 256 for ≤ 8 km; more for the 20 km areas). */
export const LIVE_LANDCOVER_SIZE = 512;
/** Largest WCS answer accepted: an uncompressed 2048² tile of bytes plus headers. */
export const NLCD_MAX_BYTES = 6 * MB;

// ── EPSG:5070, NAD83 / Conus Albers: Albers equal-area conic on GRS80 (Snyder 1987, Map Projections — A Working Manual,
//    eqs. 3-12, 14-3 … 14-6) ───────────────────────────────────────────────────────────────────────────────────────────
const GRS80_A = 6378137;
const GRS80_F = 1 / 298.257222101;
const E2 = 2 * GRS80_F - GRS80_F * GRS80_F;
const E = Math.sqrt(E2);
const D2R = Math.PI / 180;
const albersQ = (phi: number) => {
  const s = Math.sin(phi);
  return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s)));
};
const albersM = (phi: number) => Math.cos(phi) / Math.sqrt(1 - E2 * Math.sin(phi) ** 2);
const A_PHI1 = 29.5 * D2R;
const A_PHI2 = 45.5 * D2R;
const A_PHI0 = 23 * D2R;
const A_LAM0 = -96 * D2R;
const A_M1 = albersM(A_PHI1);
const A_M2 = albersM(A_PHI2);
const A_N = (A_M1 * A_M1 - A_M2 * A_M2) / (albersQ(A_PHI2) - albersQ(A_PHI1));
const A_C = A_M1 * A_M1 + A_N * albersQ(A_PHI1);
const A_RHO0 = (GRS80_A * Math.sqrt(A_C - A_N * albersQ(A_PHI0))) / A_N;

/** Geographic (NAD83 ≈ WGS84 at 30 m) → EPSG:5070 metres. */
export function conusAlbers(lon: number, lat: number): { x: number; y: number } {
  const rho = (GRS80_A * Math.sqrt(A_C - A_N * albersQ(lat * D2R))) / A_N;
  const theta = A_N * (lon * D2R - A_LAM0);
  return { x: rho * Math.sin(theta), y: A_RHO0 - rho * Math.cos(theta) };
}

/** Is the whole area inside the NLCD CONUS product (the lower 48)? */
export function nlcdCovers(b: Bounds): boolean {
  return b.south >= 24.3 && b.north <= 49.5 && b.west >= -125 && b.east <= -66.8;
}

/** The NLCD request for an area: the WCS URL and, per output pixel (size², north row first), its EPSG:5070 centre. */
export function nlcdRequest(b: Bounds, size: number): { url: string; xs: Float64Array; ys: Float64Array; box: [number, number, number, number] } {
  const m = boundsToMercator(b);
  const xs = new Float64Array(size * size);
  const ys = new Float64Array(size * size);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = mercatorToLonLat(m.xmin + ((x + 0.5) / size) * (m.xmax - m.xmin), m.ymax - ((y + 0.5) / size) * (m.ymax - m.ymin));
      const a = conusAlbers(p.lon, p.lat);
      xs[y * size + x] = a.x;
      ys[y * size + x] = a.y;
      x0 = Math.min(x0, a.x);
      x1 = Math.max(x1, a.x);
      y0 = Math.min(y0, a.y);
      y1 = Math.max(y1, a.y);
    }
  }
  // Snap to NLCD's 30 m grid (origin on multiples of 30 m) with a 3-pixel margin.
  const snap = (v: number, up: boolean) => (up ? Math.ceil(v / 30) : Math.floor(v / 30)) * 30;
  const box: [number, number, number, number] = [snap(x0, false) - 90, snap(y0, false) - 90, snap(x1, true) + 90, snap(y1, true) + 90];
  const px = Math.max(box[2] - box[0], box[3] - box[1]) / 30;
  // One uncompressed tile holding the whole subset (GeoServer's default 304² tiles are misread at the image edge, and
  // strips fail to decode): the smallest power of two ≥ the subset, at least 256.
  const tile = Math.max(256, 2 ** Math.ceil(Math.log2(px)));
  const url =
    `${NLCD_WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${NLCD_COVERAGE}` +
    `&subset=X(${box[0]},${box[2]})&subset=Y(${box[1]},${box[3]})&format=image/tiff` +
    `&geotiff:compression=None&geotiff:tiling=true&geotiff:tilewidth=${tile}&geotiff:tileheight=${tile}`;
  return { url, xs, ys, box };
}

const NLCD_CODES = new Set(NLCD_CLASSES.map((k) => k.code));

/**
 * Decode the WCS answer and sample it at the output pixels (nearest neighbour). Throws on a compressed TIFF, a grid
 * that is not 30 m, or one that does not cover the request.
 */
export async function decodeNlcd(buf: ArrayBuffer, req: { xs: Float64Array; ys: Float64Array }): Promise<Uint8Array> {
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  // Uncompressed only (SEC-03): see the DEM decoder (src/data/dem.ts decodeTiffF32) for why getValue().
  const compression = Number(image.fileDirectory.getValue('Compression') ?? 1);
  if (compression !== 1) throw new Error(`NLCD TIFF uses compression ${compression}; only uncompressed is accepted`);
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  if (Math.abs(Math.abs(rx) - 30) > 1e-6 || Math.abs(Math.abs(ry) - 30) > 1e-6) throw new Error(`NLCD resolution ${rx}, ${ry}`);
  const w = image.getWidth();
  const h = image.getHeight();
  if (!(w > 0 && h > 0 && w <= 4096 && h <= 4096)) throw new Error(`NLCD TIFF is ${w}×${h}`);
  const band = (await image.readRasters({ samples: [0], interleave: false }))[0] as unknown as ArrayLike<number>;
  const out = new Uint8Array(req.xs.length);
  for (let k = 0; k < out.length; k++) {
    // North-up raster: the origin is the top-left corner (geotiff.js reports the pixel scale unsigned).
    const col = Math.floor((req.xs[k] - ox) / Math.abs(rx));
    const row = Math.floor((oy - req.ys[k]) / Math.abs(ry));
    if (col < 0 || row < 0 || col >= w || row >= h) throw new Error('NLCD subset does not cover the area');
    const v = band[row * w + col];
    out[k] = NLCD_CODES.has(v) ? v : 0;
  }
  return out;
}

/**
 * NLCD 2021 land cover for a live area in the lower 48 (null elsewhere, or when the service fails), with the drain
 * design rainfall from the shipped Atlas 14 grid (0 = none found: the area then has no drains).
 */
export async function fetchLiveLandCover(b: Bounds, signal?: AbortSignal): Promise<LandCover | null> {
  if (!nlcdCovers(b)) return null;
  const size = LIVE_LANDCOVER_SIZE;
  const req = nlcdRequest(b, size);
  const buf = await fetchBytes(req.url, { timeoutMs: 30000, retries: 1, expectType: 'image/', maxBytes: NLCD_MAX_BYTES, signal });
  const classes = await decodeNlcd(buf, req);
  const lat = (b.north + b.south) / 2;
  const lon = (b.east + b.west) / 2;
  let designRainMmHr = 0;
  let designRainSource = 'no NOAA Atlas 14 value at the area centre: no drains';
  if (atlas14MayCover(lat, lon)) {
    try {
      const p = lookupAtlas14(await loadAtlas14Grid(), lat, lon);
      const two = p?.levels.find((l) => l.ari === 2);
      if (two && Number.isFinite(two.mmPerHour) && two.mmPerHour > 0 && two.mmPerHour < 500) {
        designRainMmHr = Math.round(two.mmPerHour * 10) / 10;
        designRainSource = `NOAA Atlas 14, 2-year 60-minute (PDS) at ${lat.toFixed(3)}, ${lon.toFixed(3)}, from the app's baked grid`;
      }
    } catch {
      // No grid: the area gets roughness but no drains.
    }
  }
  const classCounts: Record<string, number> = {};
  for (const v of classes) classCounts[v] = (classCounts[v] ?? 0) + 1;
  return {
    scheme: 'nlcd',
    year: 2021,
    width: size,
    height: size,
    designRainMmHr,
    designRainSource,
    classCounts,
    classes,
    attribution: LANDCOVER_ATTRIBUTION.nlcd,
  };
}
