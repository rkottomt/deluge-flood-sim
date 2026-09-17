/**
 * Aerial imagery for an exact mercator bbox as a north-up JPEG: Esri World Imagery (MapServer `export`, global) for live
 * areas, USDA NAIP (ImageServer `exportImage`, US, public domain) for the baked presets. In browsers the JPEG is decoded
 * to an ImageBitmap; in Node (bake script) callers keep bytes.
 */
import type { ProgressFn } from '../contracts';
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
