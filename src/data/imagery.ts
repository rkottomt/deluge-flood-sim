/**
 * Aerial imagery for an exact mercator bbox as a north-up JPEG: Esri World Imagery (MapServer `export`, global) for live
 * areas, USDA NAIP (ImageServer `exportImage`, US, public domain) for the baked presets. In browsers the JPEG is decoded
 * to an ImageBitmap; in Node (bake script) callers keep bytes.
 */
import type { GridRect, ProgressFn } from '../contracts';
import type { MercatorBBox } from './geo';
import { fetchBytes, MB } from './net';

export const ESRI_IMAGERY_EXPORT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
export const IMAGERY_ATTRIBUTION = 'Imagery © Esri, Vantor, Earthstar Geographics, and the GIS User Community';
/**
 * Leaflet tile templates for the location picker's map. They live here, next to the other Esri endpoints, so the
 * CSP/endpoint sync test (tests/data/csp.test.ts) can import them without pulling in Leaflet and its stylesheet.
 */
export const ESRI_TILE_TEMPLATE = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const ESRI_LABELS_TILE_TEMPLATE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}';
/**
 * USDA NAIP orthoimagery (≈ 0.6 m, US only, public domain) from The National Map. Esri's World Imagery item states the
 * layer "is not intended to be used to export tiles for offline" use outside ArcGIS apps, so this is the source to
 * bake redistributable preset imagery from (scripts/bake-presets.ts, the default). Exports are limited to 4000 px.
 */
export const NAIP_IMAGERY_EXPORT = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage';
export const NAIP_ATTRIBUTION = 'Imagery: USDA NAIP via USGS The National Map';
export const NAIP_MAX_EXPORT = 4000;
export type ImagerySource = 'esri' | 'naip';

export function esriImageryUrl(m: MercatorBBox, width: number, height: number): string {
  const f = (v: number) => v.toFixed(3);
  return (
    `${ESRI_IMAGERY_EXPORT}?bbox=${f(m.xmin)},${f(m.ymin)},${f(m.xmax)},${f(m.ymax)}` +
    `&bboxSR=3857&imageSR=3857&size=${width},${height}&format=jpg&f=image`
  );
}

export function naipImageryUrl(m: MercatorBBox, width: number, height: number): string {
  const f = (v: number) => v.toFixed(3);
  return (
    `${NAIP_IMAGERY_EXPORT}?bbox=${f(m.xmin)},${f(m.ymin)},${f(m.xmax)},${f(m.ymax)}` +
    `&bboxSR=3857&imageSR=3857&size=${width},${height}&format=jpg&bandIds=0,1,2&f=image`
  );
}

/** Download the imagery JPEG bytes covering exactly `m` from `source` (default Esri World Imagery). */
export async function fetchImageryBytes(
  m: MercatorBBox,
  size = 2048,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
  source: ImagerySource = 'esri',
): Promise<Uint8Array> {
  if (source === 'naip' && size > NAIP_MAX_EXPORT) throw new Error(`NAIP exports are limited to ${NAIP_MAX_EXPORT} px (asked ${size})`);
  onProgress?.('Requesting aerial imagery…', 0);
  const url = source === 'naip' ? naipImageryUrl(m, size, size) : esriImageryUrl(m, size, size);
  const buf = await fetchBytes(url, {
    // The server renders the export before sending a byte; a 4096² export (the bake size) can take over a minute.
    timeoutMs: size > 2048 ? 180000 : 60000,
    retries: 2,
    expectType: 'image/',
    // A JPEG export of this size is a few MB; the cap only stops an upstream from streaming forever.
    maxBytes: size > 2048 ? 256 * MB : 64 * MB,
    signal,
  });
  onProgress?.('Imagery received', 1);
  return new Uint8Array(buf);
}

/** Decode image bytes to an ImageBitmap (browser only). Returns null where createImageBitmap is unavailable. */
export async function decodeImageBitmap(bytes: Uint8Array | ArrayBuffer, mime = 'image/jpeg'): Promise<ImageBitmap | null> {
  if (typeof createImageBitmap !== 'function' || typeof Blob === 'undefined') return null;
  const blob = new Blob([bytes as BlobPart], { type: mime });
  // Imagery is a color texture: no premultiply / color-space conversion surprises, keep it north-up (ignore any
  // EXIF orientation). 'from-image' is the current spelling of the old 'none'; fall back to defaults if a browser
  // rejects either option rather than losing the imagery.
  for (const imageOrientation of ['from-image', 'none'] as ImageOrientation[]) {
    try {
      return await createImageBitmap(blob, { imageOrientation, premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    } catch (e) {
      if (!(e instanceof TypeError)) throw e;
    }
  }
  return createImageBitmap(blob);
}

/**
 * Fetch imagery and decode it. Never throws for imagery problems (imagery is optional): returns null and
 * logs a warning so terrain can still load.
 */
export async function fetchImagery(
  m: MercatorBBox,
  size = 2048,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<ImageBitmap | null> {
  try {
    const bytes = await fetchImageryBytes(m, size, onProgress, signal);
    return await decodeImageBitmap(bytes);
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[data] imagery unavailable:', e);
    return null;
  }
}

// ── Detail inset ───────────────────────────────────────────────────────────────────────────────
/*
 * A baked preset covers 4-8 km with ONE 4096² photo (Pittsburgh: 1.95 m per texel), which is sharp from the air and
 * mush in a close-up — judges zoom in. Raising the base to 8192² would cost ~358 MB of GPU memory with mips; instead
 * a second 4096² photo covers only the middle of the domain, where the scenario camera and the levee demo live, at
 * 3x the texel density for ~90 MB and a few MB on disk. The renderer blends it over the base inside its rectangle
 * (src/render/shaders/terrain.ts); everything below is the geometry that keeps the two exactly registered.
 *
 * Measured over downtown Pittsburgh (artifacts/detail-imagery): NAIP's own detail runs out just under 1 m per texel,
 * so an inset finer than ~0.6 m/texel buys nothing but bytes — DETAIL_TARGET_MPT is the size to aim for.
 */

/** Ground meters per texel a detail inset aims for: NAIP's usable limit, not the finest export the server allows. */
export const DETAIL_TARGET_MPT = 0.75;
/** Detail inset edge length in texels (4096² = 67 MB + mips; see the budget note above). */
export const DETAIL_SIZE = 4096;

/**
 * Grid rectangle for a detail inset: a square of `sizeMeters` centred on (`gx`, `gy`), snapped to whole cells and
 * shifted (not clipped) to stay inside the grid, so the inset is always square and cell-aligned. Returns null when
 * the square would cover the whole domain anyway — then the base photo should simply be finer.
 */
export function detailRect(nx: number, ny: number, cellSize: number, center: { gx: number; gy: number }, sizeMeters: number): GridRect | null {
  if (!(sizeMeters > 0) || !(cellSize > 0)) return null;
  const side = Math.round(sizeMeters / cellSize);
  if (!(side > 0) || side >= Math.min(nx, ny)) return null;
  const clampStart = (c: number, n: number) => Math.max(0, Math.min(n - side, Math.round(c - side / 2)));
  const x0 = clampStart(center.gx, nx);
  const y0 = clampStart(center.gy, ny);
  return { x0, y0, x1: x0 + side, y1: y0 + side };
}

/** Is `r` a whole-cell rectangle inside an nx x ny grid with a positive area? */
export function isValidDetailRect(r: GridRect | null | undefined, nx: number, ny: number): r is GridRect {
  if (!r) return false;
  const ints = [r.x0, r.y0, r.x1, r.y1].every((v) => Number.isInteger(v));
  return ints && r.x0 >= 0 && r.y0 >= 0 && r.x1 > r.x0 && r.y1 > r.y0 && r.x1 <= nx && r.y1 <= ny;
}

/**
 * Mercator sub-bbox of a grid rectangle. The grid is linear in mercator (src/data/geo.ts), so this is an exact
 * sub-rectangle of the domain's own export bbox: the inset lands on the same ground as the base photo, to the pixel.
 */
export function detailMercatorBBox(m: MercatorBBox, nx: number, ny: number, r: GridRect): MercatorBBox {
  const w = m.xmax - m.xmin;
  const h = m.ymax - m.ymin;
  return {
    xmin: m.xmin + (r.x0 / nx) * w,
    xmax: m.xmin + (r.x1 / nx) * w,
    // Grid rows run north → south, mercator y runs south → north.
    ymin: m.ymax - (r.y1 / ny) * h,
    ymax: m.ymax - (r.y0 / ny) * h,
  };
}

/** Ground meters per texel of a `size`² photo over `r`. */
export function detailMetersPerTexel(r: GridRect, cellSize: number, size: number): number {
  return ((r.x1 - r.x0) * cellSize) / size;
}
