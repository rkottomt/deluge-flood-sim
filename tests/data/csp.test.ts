/**
 * The production Content-Security-Policy (FINDINGS.json SEC-02).
 *
 * A CSP that is too tight breaks the demo silently — a blocked request looks exactly like venue wifi. So this suite
 * checks both directions: every endpoint the app really calls is allowed, and everything else is not. The last test
 * scans src/data for `https://` literals, so adding a data source without extending the policy fails here rather than
 * in front of judges.
 *
 * Run: node --import tsx --test tests/data/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { CSP_DIRECTIVES, REFERRER_POLICY, contentSecurityPolicy, cspAllows } from '../../src/data/csp';
import { TERRARIUM_TILES, USGS_3DEP_EXPORT, usgs3depUrl } from '../../src/data/dem';
import { ESRI_IMAGERY_EXPORT, ESRI_LABELS_TILE_TEMPLATE, ESRI_TILE_TEMPLATE, NAIP_IMAGERY_EXPORT, esriImageryUrl } from '../../src/data/imagery';
import { OSM_MAP_API, TIGERWEB_TRANSPORT } from '../../src/data/roads';
import { NOMINATIM_REVERSE, NOMINATIM_SEARCH } from '../../src/data/placeName';
import { lonLatToMercator } from '../../src/data/geo';

/** A Leaflet tile template with a real tile filled in — what the browser actually requests. */
const tile = (template: string) => template.replace('{z}', '12').replace('{x}', '1140').replace('{y}', '1541');

const MERC = (() => {
  const a = lonLatToMercator(-80.01, 40.43);
  const b = lonLatToMercator(-79.98, 40.45);
  return { xmin: a.x, ymin: a.y, xmax: b.x, ymax: b.y };
})();

test('every URL the app fetches at runtime is allowed by connect-src', () => {
  const urls = [
    // Elevation: 3DEP first, Terrarium as the worldwide fallback.
    usgs3depUrl(MERC, 512, 512),
    `${TERRARIUM_TILES}/12/1140/1541.png`,
    // Imagery for a live area.
    esriImageryUrl(MERC, 2048, 2048),
    // Roads: TIGERweb, then the OSM API for small areas.
    `${TIGERWEB_TRANSPORT}/2/query?where=1%3D1&f=geojson`,
    `${OSM_MAP_API}?bbox=-80.01,40.43,-79.98,40.45`,
    // Place names: the picker's search box and reverse geocoding.
    `${NOMINATIM_SEARCH}?q=Pittsburgh&format=json&limit=5`,
    `${NOMINATIM_REVERSE}?format=jsonv2&lat=40.44000&lon=-80.00000&zoom=12`,
  ];
  for (const u of urls) assert.ok(cspAllows(u, 'connect-src'), `connect-src blocks ${u}`);
});

test('the location picker’s map tiles are allowed by img-src', () => {
  for (const t of [tile(ESRI_TILE_TEMPLATE), tile(ESRI_LABELS_TILE_TEMPLATE)]) {
    assert.ok(cspAllows(t, 'img-src'), `img-src blocks ${t}`);
  }
  // Leaflet's marker images and the inline favicon are data: URIs.
  assert.ok(cspAllows('data:image/png;base64,iVBORw0KGgo=', 'img-src'));
  // Tiles are images, not fetches: they must NOT need a connect-src entry (keeping that list at what fetch() uses).
  assert.ok(!cspAllows('https://evil.example/tile.png', 'img-src'));
});

test('sources are path-restricted, not host-wide', () => {
  // The whole point of the path restriction: s3.amazonaws.com and arcgisonline host anyone's data.
  assert.ok(!cspAllows('https://s3.amazonaws.com/attacker-bucket/exfil', 'connect-src'), 'any S3 bucket would be an exfiltration target');
  assert.ok(cspAllows(`${TERRARIUM_TILES}/1/2/3.png`, 'connect-src'));
  assert.ok(!cspAllows('https://server.arcgisonline.com/ArcGIS/rest/services/Other_Service/MapServer/export', 'connect-src'));
  assert.ok(cspAllows(`${ESRI_IMAGERY_EXPORT}?f=image`, 'connect-src'));
  // Exact-path sources (no trailing slash) do not match a longer path.
  assert.ok(cspAllows(NOMINATIM_SEARCH, 'connect-src'));
  assert.ok(!cspAllows(`${NOMINATIM_SEARCH}/../../admin`, 'connect-src'));
  assert.ok(!cspAllows('https://nominatim.openstreetmap.org/status.php', 'connect-src'));
  // Scheme and host are matched strictly.
  assert.ok(!cspAllows('http://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage', 'connect-src'));
  assert.ok(!cspAllows('https://elevation.nationalmap.gov.evil.example/arcgis/rest/services/3DEPElevation/x', 'connect-src'));
  assert.ok(cspAllows(USGS_3DEP_EXPORT, 'connect-src'), 'the 3DEP endpoint itself, without a query');
  assert.ok(!cspAllows('https://elevation.nationalmap.gov/arcgis/rest/services/Other/ImageServer/exportImage', 'connect-src'));
  // Nonsense input is refused rather than throwing.
  for (const junk of ['', 'not a url', 'javascript:alert(1)', '//evil.example']) assert.equal(cspAllows(junk, 'connect-src'), false);
  assert.equal(cspAllows('https://example.com', 'no-such-directive'), false);
});

test('the policy denies by default and leaves no script escape hatch', () => {
  const policy = contentSecurityPolicy();
  assert.deepEqual(CSP_DIRECTIVES['default-src'], ["'none'"]);
  for (const d of ['object-src', 'base-uri', 'form-action']) assert.deepEqual(CSP_DIRECTIVES[d], ["'none'"], d);
  assert.deepEqual(CSP_DIRECTIVES['script-src'], ["'self'"], 'no inline scripts, no CDN');
  assert.deepEqual(CSP_DIRECTIVES['worker-src'], ["'self'"], 'the sim/live workers are same-origin');
  for (const forbidden of ["'unsafe-eval'", "'wasm-unsafe-eval'", "'unsafe-inline' 'self' https:", 'https:', '*']) {
    assert.ok(!policy.split('; ').some((d) => d.split(' ').includes(forbidden)), `${forbidden} is in the policy`);
  }
  assert.ok(!policy.includes("script-src 'self' 'unsafe-inline'"));
  // One header value, directives separated by "; ", every directive non-empty.
  for (const d of policy.split('; ')) assert.match(d, /^[a-z-]+ \S.*$/, d);
  assert.equal(REFERRER_POLICY, 'strict-origin-when-cross-origin');
});

test('index.html carries the referrer policy, and the build injects the CSP after the charset', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.match(html, /<meta name="referrer" content="strict-origin-when-cross-origin"\s*\/?>/);
  // vite.config.ts anchors the CSP meta to this exact charset tag and throws if it is missing.
  assert.ok(html.includes('<meta charset="UTF-8" />'), 'the CSP plugin anchors on this tag');
  const charsetAt = html.indexOf('<meta charset="UTF-8" />');
  const firstScript = html.indexOf('<script');
  assert.ok(firstScript === -1 || charsetAt < firstScript, 'the anchor precedes every script (a meta CSP only governs what follows it)');
});

/**
 * Guard against a whole new data source that nobody adds to the policy. Every `https://` string literal in src/data
 * (comments stripped) must name a host the policy already allows. This is a *host*-level check on purpose: several of
 * these literals are base constants that are never requested as they stand (`${TERRARIUM_TILES}/${z}/${x}/${y}.png`),
 * so only the test above — which builds the URLs the app really issues — can check path coverage. Together they mean a
 * new endpoint fails CI whether it is a new service or a new path on a known one.
 */
test('no third-party host in src/data escapes the policy', () => {
  const EXEMPT = new Map<string, string>([
    // scripts/bake-presets.ts only (Node, at bake time). If the app ever selects NAIP live, add it to connect-src.
    [NAIP_IMAGERY_EXPORT, 'bake script only, never fetched by the browser'],
  ]);
  const allowedHosts = new Set<string>();
  for (const sources of Object.values(CSP_DIRECTIVES)) {
    for (const src of sources) {
      if (src.startsWith("'") || !src.includes('//')) continue;
      allowedHosts.add(new URL(src).host);
    }
  }
  assert.ok(allowedHosts.size >= 5, `expected the policy to name several hosts, got ${[...allowedHosts].join(', ')}`);

  const dir = new URL('../../src/data/', import.meta.url);
  const found = new Map<string, string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const src = readFileSync(new URL(f, dir), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    for (const m of src.matchAll(/['"`](https:\/\/[^'"`\s${]+)/g)) found.set(m[1], f);
  }
  assert.ok(found.size >= 7, `expected the endpoint constants to be found, got ${found.size}`);

  const uncovered: string[] = [];
  for (const [url, file] of found) {
    if (EXEMPT.has(url)) continue;
    if (!allowedHosts.has(new URL(url).host)) uncovered.push(`${url} (${file})`);
  }
  assert.deepEqual(uncovered, [], 'add these to src/data/csp.ts (or to this test\u2019s EXEMPT list with a reason)');
});
