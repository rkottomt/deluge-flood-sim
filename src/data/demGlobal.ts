/**
 * Global elevation: Copernicus DEM GLO-30, and the DSM → bare-earth step it needs.
 *
 * WHY THIS FILE EXISTS. `dem.ts` is built around USGS 3DEP, which is bare-earth lidar and stops at the US border.
 * Outside it the only open, redistributable 30 m elevation model is Copernicus DEM GLO-30 (AWS Open Data,
 * `copernicus-dem-30m`), and it is a **surface** model: forest canopy and buildings are part of the terrain. A flood
 * solver run on a DSM runs water over tree tops, so this module has two jobs — read the COGs correctly, then make a
 * defensible attempt at the ground underneath them and report what is left over.
 *
 * READING (fetchCopernicusDEM)
 *   • One COG per 1°×1° tile, 3600×3600 Float32, Deflate with the floating-point predictor, internal 1024² tiles and
 *     four overview levels (verified 2026-09-19, artifacts/nepal-build/out-cog.txt). geotiff fetches only the internal
 *     tiles a window touches over HTTP range requests, so an 8 km domain costs a few MB out of a 52 MB file.
 *   • A domain may straddle a tile line (the Betrawati domain crosses 28.0 N), so the covering tiles are mosaicked on a
 *     single virtual sample grid before resampling.
 *   • **PixelIsPoint.** GTRasterTypeGeoKey is 2: a sample sits ON its grid line, not in the middle of a cell. Tile
 *     N27_00_E085_00 therefore holds latitudes 28.0 down to 27.000278 in its 3600 rows, and its row 0 is the exact
 *     sample its northern neighbour's last row does not have — which is why the mosaic is seamless, and why the
 *     bilinear weights below carry no half-pixel shift. Getting this wrong displaces terrain by 15 m.
 *   • **Datum.** GLO-30 heights are EGM2008 orthometric, not ellipsoidal — re-verified here, not assumed: over the
 *     three US presets Copernicus minus 3DEP (NAVD88, i.e. also orthometric) has a median of +0.8 to +2.7 m
 *     (artifacts/nepal-build/out-vs3dep.txt, out-datum.txt). WGS84 ellipsoid heights would sit ~30 m away from that at
 *     those latitudes, so the tiles are orthometric and mix with the app's other elevations directly.
 *
 * THE SURFACE-MODEL PROBLEM (bareEarthFromSurface)
 *   A progressive morphological filter (after Zhang et al. 2003, with the slope allowance of Pingel et al.'s SMRF)
 *   removes what stands *above* a locally-openable surface: buildings, forest patches, embankment clutter. What it
 *   cannot do is recover ground under continuous canopy, because a forest that covers a whole hillside is
 *   morphologically indistinguishable from the hillside. Measured against 3DEP over four US domains
 *   (artifacts/nepal-build/out-bareearth.txt, `validate-global.ts bareearth`) the defaults below are the only setting in
 *   a five-point sweep that improved every site and damaged none: against 3DEP lidar it cuts Pittsburgh's error from
 *   4.93 to 4.10 m MAE (rms 8.50 → 6.40, p95 +21.0 → +14.8 m — those are buildings), Nashville's from 2.70 to 2.45,
 *   Asheville's from 3.30 to 3.20, and leaves Boulder's steep canyon mouth untouched at 2.98 m. What survives is a
 *   floor bias of +1.0 to +1.6 m under continuous canopy that no morphological filter can see, plus whatever the
 *   EGM2008-vs-NAVD88 datum difference contributes. Both numbers belong in the provenance of anything baked from it,
 *   and in public/presets/SOURCES.txt.
 */
import { fromUrl } from 'geotiff';
import type { GeoBounds, ProgressFn } from '../contracts';
import { fillNoData, isNoData } from './dem';
import { type MercatorBBox, mercatorToLonLat } from './geo';

/** AWS Open Data bucket (no requester-pays) holding the GLO-30 COGs. */
export const COPERNICUS_DEM_30M_BASE = 'https://copernicus-dem-30m.s3.amazonaws.com';
/** Samples per degree in GLO-30: 1 arc-second posting, 3600 per tile. */
export const COPERNICUS_SAMPLES_PER_DEGREE = 3600;
/**
 * Attribution required by the Copernicus DEM licence (ESA/DLR/Airbus, free to use and redistribute with credit).
 * Kept next to the endpoint so a preset's `attribution` string and SOURCES.txt cannot drift from it.
 */
export const COPERNICUS_DEM_ATTRIBUTION = 'Elevation: Copernicus DEM GLO-30 (© DLR e.V. 2010–2014 / © Airbus Defence and Space GmbH, ESA)';

/** GLO-30 tile id for the 1°×1° cell containing (lat, lon), e.g. `Copernicus_DSM_COG_10_N27_00_E085_00_DEM`. */
export function copernicusTileId(lat: number, lon: number): string {
  const la = Math.floor(lat);
  const lo = Math.floor(lon);
  const ns = la < 0 ? 'S' : 'N';
  const ew = lo < 0 ? 'W' : 'E';
  return `Copernicus_DSM_COG_10_${ns}${String(Math.abs(la)).padStart(2, '0')}_00_${ew}${String(Math.abs(lo)).padStart(3, '0')}_00_DEM`;
}

export function copernicusTileUrl(id: string): string {
  return `${COPERNICUS_DEM_30M_BASE}/${id}/${id}.tif`;
}

/** Every 1° tile touched by `b`, south-west corner first. */
export function copernicusTilesCovering(b: GeoBounds): Array<{ id: string; latFloor: number; lonFloor: number }> {
  const out: Array<{ id: string; latFloor: number; lonFloor: number }> = [];
  for (let la = Math.floor(b.south); la <= Math.floor(b.north); la++) {
    for (let lo = Math.floor(b.west); lo <= Math.floor(b.east); lo++) {
      out.push({ id: copernicusTileId(la + 0.5, lo + 0.5), latFloor: la, lonFloor: lo });
    }
  }
  return out;
}

/**
 * Virtual global sample indices of a lon/lat: `i` counts samples east from 0° E, `j` counts them south from 90° N.
 * Every GLO-30 tile lands on this one grid (PixelIsPoint, exactly 3600 samples per degree), which is what lets tiles
 * be mosaicked without resampling and without a seam.
 */
export function globalSampleIndex(lon: number, lat: number): { i: number; j: number } {
  return { i: lon * COPERNICUS_SAMPLES_PER_DEGREE, j: (90 - lat) * COPERNICUS_SAMPLES_PER_DEGREE };
}

/** Sample index range a tile owns: i ∈ [i0, i0+3599], j ∈ [j0, j0+3599]. */
function tileSampleOrigin(latFloor: number, lonFloor: number): { i0: number; j0: number } {
  return { i0: lonFloor * COPERNICUS_SAMPLES_PER_DEGREE, j0: (89 - latFloor) * COPERNICUS_SAMPLES_PER_DEGREE };
}

export interface CopernicusReadResult {
  elevation: Float32Array;
  /** Tile ids actually read. */
  tiles: string[];
  /** Cells with no valid sample behind them, before filling. */
  voids: number;
  /** Cells repaired by the no-data fill. */
  filled: number;
}

/** Bilinear lookup in the mosaic that skips no-data corners (falls back to the nearest valid of the four). */
function sampleMosaic(mos: Float32Array, W: number, H: number, fi: number, fj: number): number {
  const i0 = Math.floor(fi);
  const j0 = Math.floor(fj);
  const tx = fi - i0;
  const ty = fj - j0;
  const i1 = Math.min(i0 + 1, W - 1);
  const j1 = Math.min(j0 + 1, H - 1);
  if (i0 < 0 || j0 < 0 || i0 >= W || j0 >= H) return NaN;
  const a = mos[j0 * W + i0];
  const b = mos[j0 * W + i1];
  const c = mos[j1 * W + i0];
  const d = mos[j1 * W + i1];
  const wa = (1 - tx) * (1 - ty);
  const wb = tx * (1 - ty);
  const wc = (1 - tx) * ty;
  const wd = tx * ty;
  let sum = 0;
  let wsum = 0;
  if (!isNoData(a)) { sum += a * wa; wsum += wa; }
  if (!isNoData(b)) { sum += b * wb; wsum += wb; }
  if (!isNoData(c)) { sum += c * wc; wsum += wc; }
  if (!isNoData(d)) { sum += d * wd; wsum += wd; }
  return wsum > 0.05 ? sum / wsum : NaN;
}

/**
 * Read Copernicus GLO-30 for a mercator bbox onto an `nx`×`ny` grid (row-major, north row first).
 *
 * The heights are EGM2008 orthometric and include canopy and buildings — pass the result through
 * `bareEarthFromSurface` before using it as a flood bed, or say plainly that you did not.
 */
export async function fetchCopernicusDEM(
  m: MercatorBBox,
  nx: number,
  ny: number,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<CopernicusReadResult> {
  // Cell-centre lon/lat: longitude is exactly linear in mercator x, latitude is not.
  const lons = new Float64Array(nx);
  for (let i = 0; i < nx; i++) lons[i] = mercatorToLonLat(m.xmin + ((i + 0.5) / nx) * (m.xmax - m.xmin), 0).lon;
  const lats = new Float64Array(ny);
  for (let j = 0; j < ny; j++) lats[j] = mercatorToLonLat(0, m.ymax - ((j + 0.5) / ny) * (m.ymax - m.ymin)).lat;
  const bounds: GeoBounds = { west: lons[0], east: lons[nx - 1], south: lats[ny - 1], north: lats[0] };

  // One sample of margin so the bilinear window of every edge cell is inside the mosaic.
  const nw = globalSampleIndex(bounds.west, bounds.north);
  const se = globalSampleIndex(bounds.east, bounds.south);
  const i0 = Math.floor(nw.i) - 1;
  const i1 = Math.ceil(se.i) + 1;
  const j0 = Math.floor(nw.j) - 1;
  const j1 = Math.ceil(se.j) + 1;
  const W = i1 - i0 + 1;
  const H = j1 - j0 + 1;
  const mosaic = new Float32Array(W * H).fill(NaN);

  const tiles = copernicusTilesCovering(bounds);
  const read: string[] = [];
  let done = 0;
  for (const t of tiles) {
    signal?.throwIfAborted();
    onProgress?.(`Copernicus DEM tile ${done + 1}/${tiles.length}…`, done / tiles.length);
    const org = tileSampleOrigin(t.latFloor, t.lonFloor);
    const S = COPERNICUS_SAMPLES_PER_DEGREE;
    // Intersect the needed sample window with this tile's own range, in tile-local pixels.
    const x0 = Math.max(0, i0 - org.i0);
    const x1 = Math.min(S - 1, i1 - org.i0);
    const y0 = Math.max(0, j0 - org.j0);
    const y1 = Math.min(S - 1, j1 - org.j0);
    if (x1 < x0 || y1 < y0) continue;
    const image = await (await fromUrl(copernicusTileUrl(t.id))).getImage(0);
    // Refuse anything that is not the tile geometry this reader was written against, rather than silently
    // misplacing terrain: 3600², 1 arc-second, PixelIsPoint, origin on the tile's north-west grid line.
    if (image.getWidth() !== S || image.getHeight() !== S) throw new Error(`${t.id} is ${image.getWidth()}×${image.getHeight()}, expected ${S}²`);
    const res = image.getResolution();
    if (Math.abs(Math.abs(res[0]) - 1 / S) > 1e-9 || Math.abs(Math.abs(res[1]) - 1 / S) > 1e-9) {
      throw new Error(`${t.id} posting is ${res[0]}, ${res[1]}, expected ±${1 / S}`);
    }
    const origin = image.getOrigin();
    if (Math.abs(origin[0] - t.lonFloor) > 1e-6 || Math.abs(origin[1] - (t.latFloor + 1)) > 1e-6) {
      throw new Error(`${t.id} origin is ${origin[0]}, ${origin[1]}, expected ${t.lonFloor}, ${t.latFloor + 1}`);
    }
    const rasterType = (image.getGeoKeys() as { GTRasterTypeGeoKey?: number }).GTRasterTypeGeoKey;
    if (rasterType !== 2) throw new Error(`${t.id} is not PixelIsPoint (GTRasterTypeGeoKey ${rasterType})`);
    const rasters = await image.readRasters({ window: [x0, y0, x1 + 1, y1 + 1], samples: [0], interleave: false, signal });
    const band = (rasters as unknown as ArrayLike<number>[])[0];
    const rw = (rasters as unknown as { width: number }).width;
    const noData = image.getGDALNoData();
    for (let y = y0; y <= y1; y++) {
      const mj = org.j0 + y - j0;
      for (let x = x0; x <= x1; x++) {
        const v = band[(y - y0) * rw + (x - x0)];
        mosaic[mj * W + (org.i0 + x - i0)] = noData !== null && v === noData ? NaN : v;
      }
    }
    read.push(t.id);
    done++;
  }
  if (!read.length) throw new Error('Copernicus DEM: no tile covers this area');

  const elevation = new Float32Array(nx * ny);
  let voids = 0;
  for (let j = 0; j < ny; j++) {
    const fj = globalSampleIndex(0, lats[j]).j - j0;
    for (let i = 0; i < nx; i++) {
      const v = sampleMosaic(mosaic, W, H, lons[i] * COPERNICUS_SAMPLES_PER_DEGREE - i0, fj);
      if (isNoData(v)) voids++;
      elevation[j * nx + i] = v;
    }
  }
  const filled = voids ? fillNoData(elevation, nx, ny) : 0;
  onProgress?.('Copernicus elevation received', 1);
  return { elevation, tiles: read, voids, filled };
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// DSM → bare earth
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Sliding-window minimum of one row into `out` (van Herk style deque, O(1) per sample). */
function rowMin(src: Float32Array, out: Float32Array, off: number, stride: number, n: number, r: number, idx: Int32Array): void {
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n + r; i++) {
    if (i < n) {
      const v = src[off + i * stride];
      while (tail > head && src[off + idx[tail - 1] * stride] >= v) tail--;
      idx[tail++] = i;
    }
    const k = i - r;
    if (k >= 0) {
      while (idx[head] < k - r) head++;
      out[off + k * stride] = src[off + idx[head] * stride];
    }
  }
}

/** Sliding-window maximum, mirror of rowMin. */
function rowMax(src: Float32Array, out: Float32Array, off: number, stride: number, n: number, r: number, idx: Int32Array): void {
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n + r; i++) {
    if (i < n) {
      const v = src[off + i * stride];
      while (tail > head && src[off + idx[tail - 1] * stride] <= v) tail--;
      idx[tail++] = i;
    }
    const k = i - r;
    if (k >= 0) {
      while (idx[head] < k - r) head++;
      out[off + k * stride] = src[off + idx[head] * stride];
    }
  }
}

/**
 * Grey-scale morphological opening with a (2r+1)² flat square: erosion then dilation, each separable into a row and a
 * column pass. A flat structuring element makes opening exact on planar ground — a uniform slope, however steep, comes
 * back unchanged — so what the threshold below sees is convexity (a building, a canopy patch, a sharp ridge), not
 * slope. That is the property the whole filter rests on.
 */
export function morphologicalOpening(z: Float32Array, nx: number, ny: number, r: number): Float32Array {
  const idx = new Int32Array(Math.max(nx, ny) + 2 * r + 2);
  const a = new Float32Array(z.length);
  const b = new Float32Array(z.length);
  for (let j = 0; j < ny; j++) rowMin(z, a, j * nx, 1, nx, r, idx);
  for (let i = 0; i < nx; i++) rowMin(a, b, i, nx, ny, r, idx);
  for (let j = 0; j < ny; j++) rowMax(b, a, j * nx, 1, nx, r, idx);
  for (let i = 0; i < nx; i++) rowMax(a, b, i, nx, ny, r, idx);
  return b;
}

export interface BareEarthOptions {
  cellSize: number;
  /**
   * Largest object removed, ground meters of half-width (default 120, validated). 120 m covers a village block or a
   * stand of trees. Raising it to 250 m buys a little in towns and starts taking the tops off real spurs: at Boulder's
   * canyon mouth it turned a harmless 2.97 m MAE into 3.41 and pushed rms from 3.40 to 4.71.
   */
  maxObjectMeters?: number;
  /**
   * Terrain-convexity allowance, m per m of window half-width (Zhang's slope parameter; default 0.1, validated).
   * Lowering it to 0.05 flags a third of Asheville and starts eating ridges (p5 −10.3 m against lidar).
   */
  slopeTolerance?: number;
  /** Threshold at the finest window, m: the DEM's own vertical noise, below which nothing is an object (default 1). */
  baseThreshold?: number;
  /**
   * Never lower a cell by more than this, m (default 12) — a hard ceiling on what a "surface feature" can be. Twelve
   * metres is a tall tree or a few storeys smeared over a 30 m posting; a 25 m drop is terrain, so it is refused.
   */
  maxDrop?: number;
  /**
   * SLOPE GATE, m/m (default 0.364 = 20°): cells on ground steeper than this are never flagged, however convex.
   * This is the one parameter that makes the filter defensible in mountains, and it comes from measurement, not taste.
   * Over the Betrawati domain — 24 % of it steeper than 35°, 53 % at 20–35° — the ungated filter flagged a near-uniform
   * 13 % of every slope band with a mean drop of 11 m (artifacts/nepal-build/out-bareearth-nepal.txt). A filter that
   * removes the same share of a 2,400 m ridge as of a village street is not finding buildings; it is finding the
   * terrain's own convexity, and it was shaving 8–12 m off spur crests. Below the gate the morphology means what the
   * US validation says it means; above it there is nothing to distinguish a spur nose from a roof, so the surface
   * model is left alone and the provenance says which cells were touched.
   */
  slopeGate?: number;
}

/**
 * Validated defaults, in one object so a bake cache key can name the filter it ran (a tuning change must invalidate a
 * cached DEM — otherwise a re-bake silently keeps the old terrain).
 */
export const BARE_EARTH_DEFAULTS = { maxObjectMeters: 120, slopeTolerance: 0.1, baseThreshold: 1, maxDrop: 12, slopeGate: 0.364 } as const;

export interface BareEarthResult {
  ground: Float32Array;
  /** 1 where the surface was judged to be an object (building, canopy) rather than ground. */
  objectMask: Uint8Array;
  /** Fraction of cells flagged. */
  removedFraction: number;
  /** Largest and mean drop over flagged cells, m. */
  maxRemoved: number;
  meanRemoved: number;
  /** Window half-widths used, ground meters. */
  windows: number[];
  /** Fraction of cells the slope gate made ineligible (left as the raw surface model). */
  steepFraction: number;
}

/**
 * Progressive morphological filter: DSM in, an estimate of bare earth out.
 *
 * At each of a doubling sequence of window half-widths r the surface is opened; a cell standing more than
 * `baseThreshold + slopeTolerance · r · cellSize` above the opened surface is flagged as an object, and the filtered
 * surface takes the opened value there. Growing the allowance with the window is what keeps a legitimate ridge — whose
 * convexity scales with the window — from being shaved off while a building of fixed size is removed. Flagged cells are
 * then re-interpolated from the cells that survived (`fillNoData`'s push–pull pyramid), and the result is clamped to
 * the surface (bare earth can never be above the thing standing on it) and to `maxDrop`.
 *
 * What it does NOT do: invent ground under continuous forest. Both the flagged fraction and the residual against
 * lidar belong in the provenance of anything baked from it.
 */
export function bareEarthFromSurface(surface: Float32Array, nx: number, ny: number, opts: BareEarthOptions): BareEarthResult {
  const cellSize = opts.cellSize;
  const maxObject = opts.maxObjectMeters ?? BARE_EARTH_DEFAULTS.maxObjectMeters;
  const slope = opts.slopeTolerance ?? BARE_EARTH_DEFAULTS.slopeTolerance;
  const dh0 = opts.baseThreshold ?? BARE_EARTH_DEFAULTS.baseThreshold;
  const maxDrop = opts.maxDrop ?? BARE_EARTH_DEFAULTS.maxDrop;
  const slopeGate = opts.slopeGate ?? BARE_EARTH_DEFAULTS.slopeGate;
  const n = nx * ny;
  // Local slope of the surface over ±2 cells: wide enough not to read a building's own wall as steep ground, which
  // would gate the building out of its own removal.
  const eligible = new Uint8Array(n);
  let steep = 0;
  const g = 2;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const xa = Math.max(0, i - g);
      const xb = Math.min(nx - 1, i + g);
      const ya = Math.max(0, j - g);
      const yb = Math.min(ny - 1, j + g);
      const dzdx = (surface[j * nx + xb] - surface[j * nx + xa]) / ((xb - xa) * cellSize || cellSize);
      const dzdy = (surface[yb * nx + i] - surface[ya * nx + i]) / ((yb - ya) * cellSize || cellSize);
      if (Math.hypot(dzdx, dzdy) <= slopeGate) eligible[k] = 1;
      else steep++;
    }
  }
  const z = Float32Array.from(surface);
  const mask = new Uint8Array(n);
  const windows: number[] = [];
  for (let r = 1; r * cellSize <= maxObject; r *= 2) {
    const opened = morphologicalOpening(z, nx, ny, r);
    const dhT = Math.min(maxDrop, dh0 + slope * r * cellSize);
    windows.push(Math.round(r * cellSize));
    for (let k = 0; k < z.length; k++) {
      if (eligible[k] && z[k] - opened[k] > dhT) {
        mask[k] = 1;
        z[k] = opened[k];
      }
    }
  }
  // Re-interpolate the flagged cells from surviving ground instead of keeping the opened (over-eroded) value.
  const ground = Float32Array.from(surface);
  let flagged = 0;
  for (let k = 0; k < ground.length; k++) {
    if (mask[k]) {
      ground[k] = NaN;
      flagged++;
    }
  }
  if (flagged && flagged < ground.length) fillNoData(ground, nx, ny);
  let maxRemoved = 0;
  let sumRemoved = 0;
  for (let k = 0; k < ground.length; k++) {
    if (!mask[k]) continue;
    // Bare earth is at or below the surface, and never more than maxDrop below it.
    const g = Math.max(surface[k] - maxDrop, Math.min(surface[k], ground[k]));
    ground[k] = g;
    const d = surface[k] - g;
    if (d > maxRemoved) maxRemoved = d;
    sumRemoved += d;
  }
  return {
    ground,
    objectMask: mask,
    removedFraction: flagged / ground.length,
    maxRemoved,
    meanRemoved: flagged ? sumRemoved / flagged : 0,
    windows,
    steepFraction: steep / n,
  };
}
