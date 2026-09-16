/**
 * Aerial imagery from the Esri World Imagery MapServer `export` endpoint: one request, exact mercator bbox,
 * north-up JPEG. In browsers the JPEG is decoded to an ImageBitmap; in Node (bake script) callers keep bytes.
 */
import type { ProgressFn } from '../contracts';
import type { MercatorBBox } from './geo';
import { fetchBytes } from './net';

export const ESRI_IMAGERY_EXPORT = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export';
export const IMAGERY_ATTRIBUTION = 'Imagery © Esri, Maxar, Earthstar Geographics';

export function esriImageryUrl(m: MercatorBBox, width: number, height: number): string {
  const f = (v: number) => v.toFixed(3);
  return (
    `${ESRI_IMAGERY_EXPORT}?bbox=${f(m.xmin)},${f(m.ymin)},${f(m.xmax)},${f(m.ymax)}` +
    `&bboxSR=3857&imageSR=3857&size=${width},${height}&format=jpg&f=image`
  );
}

/** Download the imagery JPEG bytes covering exactly `m`. */
export async function fetchImageryBytes(
  m: MercatorBBox,
  size = 2048,
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  onProgress?.('Requesting aerial imagery…', 0);
  const buf = await fetchBytes(esriImageryUrl(m, size, size), {
    timeoutMs: 60000,
    retries: 2,
    expectType: 'image/',
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
