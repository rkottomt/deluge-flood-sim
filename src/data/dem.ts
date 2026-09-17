/**
 * Elevation (DEM) acquisition.
 *
 * Primary: USGS 3DEP ImageServer `exportImage` — best available resolution (1 m lidar where present,
 * else 1/3 arc-second ≈ 10 m), resampled server-side to exactly our mercator grid, delivered as a Float32
 * TIFF and decoded with `geotiff`. Fallback: AWS Terrarium tiles (global, ~30 m in the US), stitched and
 * bilinearly resampled onto the same grid.
 */
import { fromArrayBuffer } from 'geotiff';
import type { ProgressFn } from '../contracts';
import { EARTH_RADIUS, type MercatorBBox, mercatorToLonLat, mercatorToTile } from './geo';
import { ELEVATION_UNREACHABLE_MESSAGE, fetchBytes, isNetworkFailure, mapLimit, MB } from './net';
import { decodePNG } from './png';

export const USGS_3DEP_EXPORT =
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
export const TERRARIUM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

/** Values at or below this (or NaN / absurdly high) are treated as no-data. */
const NODATA_BELOW = -1000;
const NODATA_ABOVE = 10000;

export function isNoData(v: number): boolean {
  return !(v > NODATA_BELOW && v < NODATA_ABOVE);
}

export function usgs3depUrl(m: MercatorBBox, nx: number, ny: number): string {
  const f = (v: number) => v.toFixed(3);
  return (
    `${USGS_3DEP_EXPORT}?bbox=${f(m.xmin)},${f(m.ymin)},${f(m.xmax)},${f(m.ymax)}` +
    `&bboxSR=3857&imageSR=3857&size=${nx},${ny}&format=tiff&pixelType=F32` +
    // Ask for the uncompressed TIFF the service already returns by default (verified 2026-09-17: same ETag and body
    // with and without the parameter). Being explicit means a server-side default change fails the decoder's
    // compression check and falls back to Terrarium, instead of quietly handing an unbounded inflate hostile bytes —
    // and it keeps geotiff's WebAssembly LERC/ZSTD decoders (which the CSP blocks) off the path. FINDINGS SEC-03.
    `&compression=None` +
    `&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image`
  );
}

/** Decode a single-band float TIFF into a Float32Array (row-major, north row first). */
export async function decodeTiffF32(buf: ArrayBuffer, nx: number, ny: number): Promise<Float32Array> {
  const tiff = await fromArrayBuffer(buf);
  const image = await tiff.getImage();
  const w = image.getWidth();
  const h = image.getHeight();
  if (w !== nx || h !== ny) throw new Error(`DEM TIFF is ${w}×${h}, expected ${nx}×${ny}`);
  // 1 = no compression; an absent tag means the same (TIFF default). Anything else would inflate an attacker-chosen
  // amount of data from a few hundred kilobytes, so refuse it rather than decode it (FINDINGS.json SEC-03).
  //
  // `image.fileDirectory` is geotiff's ImageFileDirectory, NOT a plain object: reading `.Compression` off it is always
  // undefined, which would silently turn this check into a no-op. `getValue()` is the accessor geotiff itself uses
  // (geotiffimage.js: `this.fileDirectory.getValue('Compression') || 1`), and it throws only for deferred array tags —
  // Compression is a single SHORT and is always actualized. tests/data/hostileUpstream.ts pins this on a real
  // LZW-tagged TIFF, so a library upgrade that moves the accessor fails the suite instead of the demo.
  const compression = Number(image.fileDirectory.getValue('Compression') ?? 1);
  if (compression !== 1) throw new Error(`DEM TIFF uses compression ${compression}; only uncompressed DEMs are accepted`);
  const rasters = await image.readRasters({ samples: [0] });
  const band = (rasters as unknown as ArrayLike<number>[])[0];
  const noData = image.getGDALNoData();
  const out = new Float32Array(nx * ny);
  for (let i = 0; i < out.length; i++) {
    const v = band[i];
    out[i] = noData !== null && v === noData ? NaN : v;
  }
  return out;
}

async function fetch3DEPTile(m: MercatorBBox, nx: number, ny: number, signal?: AbortSignal): Promise<Float32Array> {
  const buf = await fetchBytes(usgs3depUrl(m, nx, ny), {
    // Time to first byte (the server renders the export first: a few seconds even at 2048²); a stalled body fails
    // separately after 20 s without data (net.ts), so a slow but moving download is never cut off.
    timeoutMs: 45000,
    retries: 1,
    expectType: 'image/',
    // The largest export we ask for is 2048² F32 = 16 MB; 64 MB leaves room for TIFF overhead and nothing else.
    maxBytes: 64 * MB,
    signal,
  });
  return decodeTiffF32(buf, nx, ny);
}

/**
 * Fetch a DEM from USGS 3DEP. Large grids are requested as 2×2 quadrants (each exactly aligned with the grid)
 * when the single request fails, since the ImageServer occasionally times out on big exports.
 */
export async function fetch3DEP(
  m: MercatorBBox,
  nx: number,
  ny: number,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<Float32Array> {
  onProgress?.('Requesting USGS 3DEP elevation…', 0);
  try {
    const d = await fetch3DEPTile(m, nx, ny, signal);
    onProgress?.('Elevation received', 1);
    return d;
  } catch (e) {
    if (signal?.aborted || nx < 64 || ny < 64) throw e;
    onProgress?.('Retrying elevation in 4 parts…', 0.1);
  }
  const hx = nx / 2;
  const hy = ny / 2;
  const xm = m.xmin + (m.xmax - m.xmin) / 2;
  const ym = m.ymax - (m.ymax - m.ymin) / 2;
  const parts = [
    { i0: 0, j0: 0, bb: { xmin: m.xmin, xmax: xm, ymin: ym, ymax: m.ymax } },
    { i0: hx, j0: 0, bb: { xmin: xm, xmax: m.xmax, ymin: ym, ymax: m.ymax } },
    { i0: 0, j0: hy, bb: { xmin: m.xmin, xmax: xm, ymin: m.ymin, ymax: ym } },
    { i0: hx, j0: hy, bb: { xmin: xm, xmax: m.xmax, ymin: m.ymin, ymax: ym } },
  ];
  const out = new Float32Array(nx * ny);
  let done = 0;
  await mapLimit(parts, 2, async (p) => {
    const d = await fetch3DEPTile(p.bb, hx, hy, signal);
    for (let j = 0; j < hy; j++) out.set(d.subarray(j * hx, (j + 1) * hx), (p.j0 + j) * nx + p.i0);
    onProgress?.('Elevation parts received', 0.1 + (0.9 * ++done) / 4);
  });
  return out;
}

/** Fraction of cells that are no-data. */
export function noDataFraction(elev: Float32Array): number {
  let bad = 0;
  for (let i = 0; i < elev.length; i++) if (isNoData(elev[i])) bad++;
  return bad / elev.length;
}

/**
 * Fill no-data cells in place with a smooth, nearest-valid-dominated interpolation (push–pull pyramid).
 * Valid cells are untouched. Returns the number of cells filled. If every cell is no-data, fills with 0.
 */
export function fillNoData(elev: Float32Array, nx: number, ny: number): number {
  const n = nx * ny;
  const val0 = new Float32Array(n);
  const w0 = new Float32Array(n);
  let missing = 0;
  for (let k = 0; k < n; k++) {
    if (isNoData(elev[k])) missing++;
    else {
      val0[k] = elev[k];
      w0[k] = 1;
    }
  }
  if (missing === 0) return 0;
  if (missing === n) {
    elev.fill(0);
    return n;
  }
  // Push: build a pyramid of weighted averages.
  const levels: { v: Float32Array; w: Float32Array; nx: number; ny: number }[] = [{ v: val0, w: new Float32Array(w0), nx, ny }];
  while (levels[levels.length - 1].nx > 1 || levels[levels.length - 1].ny > 1) {
    const p = levels[levels.length - 1];
    const cx = Math.max(1, Math.ceil(p.nx / 2));
    const cy = Math.max(1, Math.ceil(p.ny / 2));
    const v = new Float32Array(cx * cy);
    const w = new Float32Array(cx * cy);
    for (let j = 0; j < p.ny; j++) {
      for (let i = 0; i < p.nx; i++) {
        const s = j * p.nx + i;
        const d = (j >> 1) * cx + (i >> 1);
        v[d] += p.v[s] * p.w[s];
        w[d] += p.w[s];
      }
    }
    let allCovered = true;
    for (let k = 0; k < v.length; k++) {
      if (w[k] > 0) v[k] /= w[k];
      else allCovered = false;
      w[k] = Math.min(1, w[k]);
    }
    levels.push({ v, w, nx: cx, ny: cy });
    if (allCovered && cx * cy <= 4) break;
  }
  // Pull: fill uncovered cells of each level from the (bilinearly upsampled) coarser level, blending partial weights.
  for (let l = levels.length - 2; l >= 0; l--) {
    const f = levels[l];
    const c = levels[l + 1];
    for (let j = 0; j < f.ny; j++) {
      const cyf = Math.min(Math.max((j + 0.5) / 2 - 0.5, 0), c.ny - 1);
      const j0 = Math.floor(cyf);
      const j1 = Math.min(j0 + 1, c.ny - 1);
      const ty = cyf - j0;
      for (let i = 0; i < f.nx; i++) {
        const k = j * f.nx + i;
        const wf = f.w[k];
        if (wf >= 1) continue;
        const cxf = Math.min(Math.max((i + 0.5) / 2 - 0.5, 0), c.nx - 1);
        const i0 = Math.floor(cxf);
        const i1 = Math.min(i0 + 1, c.nx - 1);
        const tx = cxf - i0;
        const up =
          (c.v[j0 * c.nx + i0] * (1 - tx) + c.v[j0 * c.nx + i1] * tx) * (1 - ty) +
          (c.v[j1 * c.nx + i0] * (1 - tx) + c.v[j1 * c.nx + i1] * tx) * ty;
        f.v[k] = wf * f.v[k] + (1 - wf) * up;
        f.w[k] = 1;
      }
    }
  }
  for (let k = 0; k < n; k++) if (w0[k] === 0) elev[k] = val0[k];
  return missing;
}

/**
 * Mark seams of exact zeros (voids between lidar tiles that the ImageServer returns as 0) as no-data, when
 * zeros are rare enough to be artifacts rather than a real sea-level surface. Returns cells cleared.
 */
export function markZeroSeams(elev: Float32Array): number {
  let zeros = 0;
  for (let k = 0; k < elev.length; k++) if (elev[k] === 0) zeros++;
  if (zeros === 0 || zeros > elev.length * 0.005) return 0;
  for (let k = 0; k < elev.length; k++) if (elev[k] === 0) elev[k] = NaN;
  return zeros;
}

/**
 * Remove single-cell no-data spikes that survive as valid-looking numbers (e.g. seams of zeros between
 * lidar tiles, and their bilinear halos): a cell more than `threshold` m below BOTH horizontal or BOTH
 * vertical neighbors is replaced by NaN so fillNoData can repair it. Returns the number of cells cleared.
 */
export function markPits(elev: Float32Array, nx: number, ny: number, threshold = 15): number {
  let total = 0;
  for (let pass = 0; pass < 4; pass++) {
    const clear: number[] = [];
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const z = elev[k];
        if (Number.isNaN(z)) continue;
        const valid = (m: number) => !Number.isNaN(elev[m]);
        let pit = false;
        if (i > 0 && i < nx - 1) {
          const l = elev[k - 1];
          const r = elev[k + 1];
          if (valid(k - 1) && valid(k + 1) && z < Math.min(l, r) - threshold) pit = true;
        }
        if (!pit && j > 0 && j < ny - 1) {
          const u = elev[k - nx];
          const d = elev[k + nx];
          if (valid(k - nx) && valid(k + nx) && z < Math.min(u, d) - threshold) pit = true;
        }
        if (pit) clear.push(k);
      }
    }
    for (const k of clear) elev[k] = NaN;
    total += clear.length;
    if (!clear.length) break;
  }
  return total;
}

/** Near-zero band used to recognize clamped cells, m. */
const CLAMP_EPS = 0.02;

/**
 * Fraction of cells within ±2 cm of zero, or 0 if the DEM has genuinely negative values. The USGS 3DEP
 * ImageServer serves some request pixel sizes (observed ≈ 4–8 m) from a source layer that clamps below-sea-level
 * ground to 0 — e.g. New Orleans comes back as a flat plain at 0.00 m, while the same bbox at ~2 m or ≥ 10 m
 * pixels has the true −2 … −5 m. A large near-zero fraction with no negatives is that signature.
 */
export function zeroClampFraction(elev: Float32Array): number {
  let near = 0;
  for (let k = 0; k < elev.length; k++) {
    const v = elev[k];
    if (v < -CLAMP_EPS) return 0;
    if (v <= CLAMP_EPS && v >= -CLAMP_EPS) near++;
  }
  return near / elev.length;
}

/**
 * Repair a 3DEP DEM whose below-sea-level ground was clamped to 0 (see `zeroClampFraction`): refetch the same bbox
 * at ≥ 10.5 m pixels (a source layer that keeps negative elevations) and replace the clamped cells with its
 * bilinear upsampling. Detail elsewhere is untouched. Returns the number of cells replaced (0 if not needed).
 */
export async function repairZeroClamp(
  elev: Float32Array,
  m: MercatorBBox,
  nx: number,
  ny: number,
  cellSize: number,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<number> {
  if (zeroClampFraction(elev) < 0.02) return 0;
  const groundW = nx * cellSize;
  const cx = Math.max(32, Math.min(4000, Math.ceil(groundW / 10.5 / 16) * 16));
  const cy = Math.max(32, Math.min(4000, Math.round((cx * ny) / nx / 16) * 16));
  if (groundW / cx < 10) return 0; // domain too small for a coarser request to differ
  onProgress?.('Repairing below-sea-level elevations…', 0.95);
  let coarse: Float32Array;
  try {
    coarse = await fetch3DEPTile(m, cx, cy, signal);
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[data] could not refetch coarse 3DEP for zero-clamp repair:', e);
    return 0;
  }
  let hasNegative = false;
  for (let k = 0; k < coarse.length && !hasNegative; k++) if (coarse[k] < -CLAMP_EPS && !isNoData(coarse[k])) hasNegative = true;
  if (!hasNegative) return 0; // the ground really is at sea level
  let replaced = 0;
  for (let j = 0; j < ny; j++) {
    const fy = Math.min(Math.max(((j + 0.5) / ny) * cy - 0.5, 0), cy - 1);
    const j0 = Math.floor(fy);
    const j1 = Math.min(j0 + 1, cy - 1);
    const ty = fy - j0;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      const v = elev[k];
      if (!(v <= CLAMP_EPS && v >= -CLAMP_EPS)) continue;
      const fx = Math.min(Math.max(((i + 0.5) / nx) * cx - 0.5, 0), cx - 1);
      const i0 = Math.floor(fx);
      const i1 = Math.min(i0 + 1, cx - 1);
      const tx = fx - i0;
      const a = coarse[j0 * cx + i0];
      const b = coarse[j0 * cx + i1];
      const c = coarse[j1 * cx + i0];
      const d = coarse[j1 * cx + i1];
      if ([a, b, c, d].some(isNoData)) continue;
      // Only lower: clamping only ever raised values to 0.
      elev[k] = Math.min(v, (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty);
      replaced++;
    }
  }
  return replaced;
}

/** Full DEM clean-up: zero seams, pits, then no-data fill. Returns the number of repaired cells. */
export function cleanDEM(elev: Float32Array, nx: number, ny: number): number {
  markZeroSeams(elev);
  markPits(elev, nx, ny);
  return fillNoData(elev, nx, ny);
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Terrarium fallback
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** Pick the coarsest Terrarium zoom (≤ 15) whose pixels are no larger than cellSize, within `maxTiles` tiles. */
export function terrariumZoom(m: MercatorBBox, cellSize: number, maxTiles = 36): number {
  const lat = mercatorToLonLat(0, (m.ymin + m.ymax) / 2).lat;
  const cosφ = Math.cos((lat * Math.PI) / 180);
  const tileCount = (z: number) => {
    const a = mercatorToTile(m.xmin, m.ymax, z);
    const b = mercatorToTile(m.xmax, m.ymin, z);
    return (Math.floor(b.tx) - Math.floor(a.tx) + 1) * (Math.floor(b.ty) - Math.floor(a.ty) + 1);
  };
  let z = 0;
  while (z < 15 && (2 * Math.PI * EARTH_RADIUS * cosφ) / (256 * 2 ** z) > cellSize) z++;
  while (z > 0 && tileCount(z) > maxTiles) z--;
  return z;
}

/** Every Terrarium tile failed at the network level (see isNetworkFailure). */
export class ElevationUnreachableError extends Error {
  constructor() {
    super(ELEVATION_UNREACHABLE_MESSAGE);
    this.name = 'ElevationUnreachableError';
  }
}

export async function fetchTerrarium(
  m: MercatorBBox,
  nx: number,
  ny: number,
  cellSize: number,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const z = terrariumZoom(m, cellSize);
  const a = mercatorToTile(m.xmin, m.ymax, z);
  const b = mercatorToTile(m.xmax, m.ymin, z);
  const tx0 = Math.floor(a.tx);
  const ty0 = Math.floor(a.ty);
  const tw = Math.floor(b.tx) - tx0 + 1;
  const th = Math.floor(b.ty) - ty0 + 1;
  const T = 256;
  const mosaic = new Float32Array(tw * T * th * T).fill(NaN);
  const jobs: { x: number; y: number }[] = [];
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) jobs.push({ x, y });
  let done = 0;
  let networkFailures = 0;
  const nTiles = 2 ** z;
  await mapLimit(jobs, 6, async ({ x, y }) => {
    const txw = (((tx0 + x) % nTiles) + nTiles) % nTiles;
    const url = `${TERRARIUM_TILES}/${z}/${txw}/${ty0 + y}.png`;
    try {
      // A 256² Terrarium PNG is ~100 kB; 4 MB is already absurd for one, and six download in parallel.
      const png = await decodePNG(await fetchBytes(url, { timeoutMs: 30000, retries: 2, maxBytes: 4 * MB, signal }));
      for (let py = 0; py < Math.min(T, png.height); py++) {
        for (let px = 0; px < Math.min(T, png.width); px++) {
          const s = (py * png.width + px) * 4;
          const e = png.data[s] * 256 + png.data[s + 1] + png.data[s + 2] / 256 - 32768;
          mosaic[(y * T + py) * tw * T + x * T + px] = e;
        }
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      if (isNetworkFailure(e)) networkFailures++;
      // Leave NaN; filled later.
    }
    onProgress?.(`Terrarium elevation tiles ${++done}/${jobs.length}`, done / jobs.length);
  });
  // Not a single tile, and never because the server said no: the network is down (not "open water").
  if (jobs.length > 0 && networkFailures === jobs.length) throw new ElevationUnreachableError();
  const mw = tw * T;
  const mh = th * T;
  const out = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const my = m.ymax - ((j + 0.5) / ny) * (m.ymax - m.ymin);
    for (let i = 0; i < nx; i++) {
      const mx = m.xmin + ((i + 0.5) / nx) * (m.xmax - m.xmin);
      const t = mercatorToTile(mx, my, z);
      const fx = Math.min(Math.max((t.tx - tx0) * T - 0.5, 0), mw - 1);
      const fy = Math.min(Math.max((t.ty - ty0) * T - 0.5, 0), mh - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, mw - 1);
      const y1 = Math.min(y0 + 1, mh - 1);
      const ax = fx - x0;
      const ay = fy - y0;
      out[j * nx + i] =
        (mosaic[y0 * mw + x0] * (1 - ax) + mosaic[y0 * mw + x1] * ax) * (1 - ay) +
        (mosaic[y1 * mw + x0] * (1 - ax) + mosaic[y1 * mw + x1] * ax) * ay;
    }
  }
  return out;
}

/**
 * True if a 3DEP raster is an empty plane of exact zeros. Outside its coverage (abroad, open ocean) the ImageServer
 * answers with a valid raster of zeros rather than no-data. A real US area at sea level is never exactly 0
 * everywhere — ocean returned as 0 always comes with some land (Marathon, FL: 54 % zeros) — so a raster with
 * essentially no non-zero cell means no coverage.
 */
export function isEmptyZeroPlane(elev: Float32Array): boolean {
  let zeros = 0;
  let other = 0;
  for (let k = 0; k < elev.length; k++) {
    const v = elev[k];
    if (v === 0) zeros++;
    else if (!isNoData(v)) other++;
  }
  return zeros >= elev.length * 0.5 && other <= elev.length * 0.001;
}

/** Shown when no elevation source has land for the requested area. */
export const NO_LAND_MESSAGE = 'This area is open water or outside elevation coverage — pick a place on land.';

/**
 * Fetch the best available DEM for a mercator bbox: USGS 3DEP, falling back to Terrarium if 3DEP fails, is mostly
 * no-data, or is an empty zero plane (outside coverage). No-data is always filled. `source` reports which service
 * was used. Throws NO_LAND_MESSAGE when the Terrarium fallback finds only open water (or nothing).
 */
export async function fetchDEM(
  m: MercatorBBox,
  nx: number,
  ny: number,
  cellSize: number,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<{ elevation: Float32Array; source: 'usgs3dep' | 'terrarium'; filled: number }> {
  let elevation: Float32Array | null = null;
  let filled = 0;
  let depUnreachable = false;
  try {
    elevation = await fetch3DEP(m, nx, ny, onProgress, signal);
    if (noDataFraction(elevation) > 0.5) {
      elevation = null;
    } else {
      // Clamp repair first: a small, entirely below-sea-level US box can come back as a 0 plane at some pixel sizes.
      filled += await repairZeroClamp(elevation, m, nx, ny, cellSize, onProgress, signal);
      if (isEmptyZeroPlane(elevation)) elevation = null;
    }
    if (!elevation) onProgress?.('USGS 3DEP has no coverage here — using Terrarium tiles', 0);
  } catch (e) {
    if (signal?.aborted) throw e;
    depUnreachable = isNetworkFailure(e);
    console.warn('[data] USGS 3DEP failed, falling back to Terrarium tiles:', e);
    onProgress?.('USGS 3DEP unavailable — using Terrarium tiles', 0);
    elevation = null;
  }
  if (elevation) {
    filled += cleanDEM(elevation, nx, ny);
    return { elevation, source: 'usgs3dep', filled };
  }
  filled = 0;
  let terrarium: Float32Array;
  try {
    terrarium = await fetchTerrarium(m, nx, ny, cellSize, onProgress, signal);
  } catch (e) {
    // Both services unreachable: say so plainly (the UI shows its offline help for this message).
    if (e instanceof ElevationUnreachableError && depUnreachable) throw new Error(ELEVATION_UNREACHABLE_MESSAGE);
    if (e instanceof ElevationUnreachableError) throw new Error('USGS 3DEP has no data here and the Terrarium elevation tiles can’t be reached — check the network.');
    throw e;
  }
  // Deep ocean lies below the no-data floor; shallow seas and lake beds are valid but hold no land to flood.
  if (noDataFraction(terrarium) > 0.5 || landFraction(terrarium) < 0.01) throw new Error(NO_LAND_MESSAGE);
  filled += cleanDEM(terrarium, nx, ny);
  return { elevation: terrarium, source: 'terrarium', filled };
}

/** Fraction of cells that are valid and more than 0.5 m above sea level. */
export function landFraction(elev: Float32Array): number {
  let land = 0;
  for (let k = 0; k < elev.length; k++) if (!isNoData(elev[k]) && elev[k] > 0.5) land++;
  return land / elev.length;
}
