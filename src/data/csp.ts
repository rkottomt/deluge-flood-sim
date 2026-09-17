/**
 * The production Content-Security-Policy, in one place.
 *
 * vite.config.ts injects it as a `<meta http-equiv>` into the built index.html, and tests/data/csp.test.ts checks
 * that every endpoint the app actually calls is still covered — so adding a data source fails CI instead of silently
 * falling back in production.
 *
 * Sources are *path-restricted*, not host-only: `https://s3.amazonaws.com/` alone would still permit exfiltration to
 * any attacker-owned S3 bucket. A source ending in `/` matches by path prefix; one without matches that path exactly
 * (query strings are not part of CSP path matching).
 *
 * Kept deliberately small: no 'unsafe-eval' and no 'wasm-unsafe-eval', so geotiff's WebAssembly LERC/ZSTD decoders
 * cannot run — which is fine because the DEM request asks for uncompressed TIFFs and the decoder rejects anything
 * else (src/data/dem.ts, FINDINGS SEC-03).
 *
 * Caveats that come with delivering a policy as meta rather than a header: `frame-ancestors`, `report-uri` and
 * `sandbox` are ignored (SEC-11 accepts framing on GitHub Pages; Electron must send the policy as a real header —
 * ELECTRON_REQUIREMENTS.md R6), and a cross-host redirect would be blocked even though the path check is skipped
 * after a redirect.
 */

/** Everything the app fetches with fetch()/XHR. */
export const CSP_CONNECT_SRC = [
  "'self'",
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/',
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/',
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/',
  'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/',
  'https://api.openstreetmap.org/api/0.6/map',
  'https://nominatim.openstreetmap.org/search',
  'https://nominatim.openstreetmap.org/reverse',
];

/** `<img>` sources: the inline favicon and Leaflet's bundled marker images are data:/same-origin; map tiles are Esri. */
export const CSP_IMG_SRC = ["'self'", 'data:', 'https://server.arcgisonline.com/ArcGIS/rest/services/'];

export const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  'worker-src': ["'self'"],
  'connect-src': CSP_CONNECT_SRC,
  'img-src': CSP_IMG_SRC,
  // index.html carries an inline <style>, and the fallback screens (src/app/unsupported.ts) insert one. A hash-only
  // style-src also passes, but every edit to either block would then have to be re-hashed.
  'style-src': ["'self'", "'unsafe-inline'"],
  'object-src': ["'none'"],
  'base-uri': ["'none'"],
  'form-action': ["'none'"],
};

/** The policy as one header/meta value. */
export function contentSecurityPolicy(): string {
  return Object.entries(CSP_DIRECTIVES)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ');
}

/** Referrer policy shipped alongside: Nominatim's usage policy wants an identifying Referer, and browsers cannot set a User-Agent. */
export const REFERRER_POLICY = 'strict-origin-when-cross-origin';

/**
 * Would `url` be allowed by `directive`? Implements the subset of CSP source matching this app uses: scheme sources
 * (`data:`), and `scheme://host[:port]/path` with prefix matching when the path ends in `/`. `'self'` and `'none'`
 * are not resolvable without an origin and are ignored here (callers test absolute third-party URLs).
 */
export function cspAllows(url: string, directive: keyof typeof CSP_DIRECTIVES | string): boolean {
  const sources = CSP_DIRECTIVES[directive];
  if (!sources) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return sources.some((src) => {
    if (src.startsWith("'")) return false;
    if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) return u.protocol === src.toLowerCase();
    let s: URL;
    try {
      s = new URL(src);
    } catch {
      return false;
    }
    if (s.protocol !== u.protocol || s.host !== u.host) return false;
    if (s.pathname === '/' || s.pathname === '') return true;
    return s.pathname.endsWith('/') ? u.pathname.startsWith(s.pathname) : u.pathname === s.pathname;
  });
}
