/**
 * Deluge wrapper — the one list of places this app is allowed to talk to.
 *
 * ELECTRON_REQUIREMENTS.md R6 ("keep one source of truth for endpoints"). The web app's policy lives in
 * `src/data/csp.ts`; the main process cannot import TypeScript, so this module mirrors it and
 * `electron/check-endpoints.mjs` — run by `npm run app:build` and by the verification script — fails the
 * build if the two ever drift apart, in either direction.
 *
 * Two things are added here that a meta CSP cannot express:
 *   • `frame-ancestors 'none'` (SEC-11), which is header-only;
 *   • the R10 request allowlist, a second layer independent of CSP that also covers workers.
 *
 * Trailing slashes matter. A source ending in "/" is a path prefix; one without is an exact
 * `origin + pathname` match. CSP and the allowlist read them the same way.
 */

/** Path-prefix endpoints. */
export const PREFIXES = Object.freeze([
  // USGS 3DEP elevation (ImageServer metadata + exportImage GeoTIFF) — src/data/dem.ts
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/',
  // Mapzen/AWS Terrarium DEM tiles, the fallback when 3DEP is down — src/data/dem.ts
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/',
  // Esri World Imagery: exportImage for the scene texture, XYZ tiles for the picker map
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/',
  // Esri place-label overlay — picker map only, and only ever as <img> tiles (see IMG_ONLY)
  'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/',
  // US Census TIGERweb roads — src/data/roads.ts
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/',
]);

/** Exact `origin + pathname` endpoints (query strings vary, the path never does). */
export const EXACT = Object.freeze([
  'https://api.openstreetmap.org/api/0.6/map',
  'https://nominatim.openstreetmap.org/search',
  'https://nominatim.openstreetmap.org/reverse',
]);

/**
 * Loaded only as <img> tiles by Leaflet in the location picker, never by fetch/XHR, so it belongs in
 * img-src (covered by ESRI_TILE_PREFIX) and must stay out of connect-src. This is why the R10 allowlist
 * has one more entry than CSP_CONNECT_SRC.
 */
const IMG_ONLY = new Set(['https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/']);

/** Covers both Esri tile layers the picker map draws as <img>. */
export const ESRI_TILE_PREFIX = 'https://server.arcgisonline.com/ArcGIS/rest/services/';

/** The seven endpoints the page may fetch() — must equal src/data/csp.ts CSP_CONNECT_SRC minus 'self'. */
export const CONNECT_SOURCES = Object.freeze([...PREFIXES.filter((p) => !IMG_ONLY.has(p)), ...EXACT]);

/**
 * Must render byte-identical to `contentSecurityPolicy()` in src/data/csp.ts (check-endpoints.mjs asserts it).
 *
 * - script-src has no 'unsafe-inline', no 'unsafe-eval' and no 'wasm-unsafe-eval' (SEC-03 keeps the DEM
 *   path uncompressed, so geotiff never needs its wasm decoders).
 * - style-src needs 'unsafe-inline': index.html and src/app/unsupported.ts each insert a <style> block.
 * - No Cross-Origin-Embedder-Policy anywhere: it would block the Esri tile <img> loads (they send no CORP).
 */
const DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self'",
  "worker-src 'self'",
  `connect-src 'self' ${CONNECT_SOURCES.join(' ')}`,
  `img-src 'self' data: ${ESRI_TILE_PREFIX}`,
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** The web app's policy, exactly. */
export const CSP_META = DIRECTIVES.join('; ');

/** What the app:// handler sends as a header: the same policy plus the header-only SEC-11 directive. */
export const CSP = [...DIRECTIVES, "frame-ancestors 'none'"].join('; ');

export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * R10's independent second layer: does this URL point at one of the endpoints above?
 * Stricter than CSP on purpose — https only, no embedded credentials, no explicit port.
 */
export function isAllowedDataUrl(url) {
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password || url.port !== '') return false;
  const base = `${url.origin}${url.pathname}`;
  return PREFIXES.some((p) => base.startsWith(p)) || EXACT.includes(base);
}

/** R9: the only external links the wrapper will ever hand to the OS browser. */
export const EXTERNAL_LINKS = Object.freeze(['https://github.com/rkottomt/deluge-flood-sim']);
