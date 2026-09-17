/**
 * R6 drift guard: electron/endpoints.js must stay a faithful mirror of src/data/csp.ts.
 *
 * The main process is plain JavaScript and cannot import the app's TypeScript, so the endpoint list exists
 * in two files. This check makes that safe: it fails the build if the policies differ by so much as a
 * space, if the R10 allowlist and the CSP disagree about any endpoint, or if the app's own reachability
 * probes would be blocked by either layer.
 *
 * Run: node --import tsx electron/check-endpoints.mjs
 */
import assert from 'node:assert/strict';
import { CONNECT_SOURCES, CSP, CSP_META, ESRI_TILE_PREFIX, EXACT, isAllowedDataUrl, PREFIXES, REFERRER_POLICY } from './endpoints.js';
import { contentSecurityPolicy, cspAllows, CSP_CONNECT_SRC, CSP_IMG_SRC, REFERRER_POLICY as APP_REFERRER } from '../src/data/csp.ts';
import { DATA_HOST_PROBES } from '../src/data/net.ts';

const problems = [];
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (err) {
    problems.push(`${label}: ${err.message}`);
    console.log(`  FAIL ${label}\n       ${err.message.split('\n')[0]}`);
  }
};

console.log('electron/endpoints.js vs src/data/csp.ts');

check('meta CSP is byte-identical to the app policy', () => {
  assert.equal(CSP_META, contentSecurityPolicy());
});

check("header CSP is the app policy plus frame-ancestors 'none'", () => {
  assert.equal(CSP, `${contentSecurityPolicy()}; frame-ancestors 'none'`);
  assert.match(CSP, /frame-ancestors 'none'/);
});

check('referrer policy matches', () => {
  assert.equal(REFERRER_POLICY, APP_REFERRER);
});

check('connect-src sources match the app list', () => {
  assert.deepEqual(CONNECT_SOURCES, CSP_CONNECT_SRC.filter((s) => !s.startsWith("'")));
});

check('the Esri tile prefix is in the app img-src list', () => {
  assert.ok(CSP_IMG_SRC.includes(ESRI_TILE_PREFIX), `${ESRI_TILE_PREFIX} missing from CSP_IMG_SRC`);
});

check('every allowlist entry is permitted by CSP connect-src or img-src', () => {
  for (const prefix of PREFIXES) {
    const sample = `${prefix}sample`;
    assert.ok(cspAllows(sample, 'connect-src') || cspAllows(sample, 'img-src'), `${prefix} is in the R10 allowlist but no CSP directive permits it`);
  }
  for (const exact of EXACT) {
    assert.ok(cspAllows(exact, 'connect-src'), `${exact} is in the R10 allowlist but connect-src does not permit it`);
  }
});

check('every CSP connect-src endpoint is permitted by the R10 allowlist', () => {
  for (const src of CSP_CONNECT_SRC) {
    if (src.startsWith("'")) continue;
    const sample = src.endsWith('/') ? `${src}sample` : src;
    assert.ok(isAllowedDataUrl(new URL(sample)), `${src} is allowed by CSP but the main-process allowlist would cancel it`);
  }
});

check("the app's in-load reachability probes pass both layers", () => {
  for (const probe of DATA_HOST_PROBES) {
    assert.ok(isAllowedDataUrl(new URL(probe)), `probe blocked by the R10 allowlist: ${probe}`);
    assert.ok(cspAllows(probe, 'connect-src'), `probe blocked by CSP connect-src: ${probe}`);
  }
});

check('the allowlist rejects the things SEC-02 and R10 call out', () => {
  const rejected = [
    'https://evil.example/',
    'https://s3.amazonaws.com/attacker-bucket/x', // host-only policies would allow this one
    'https://elevation.nationalmap.gov.evil.example/arcgis/rest/services/3DEPElevation/x',
    'http://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/x', // no http
    'https://user:pw@nominatim.openstreetmap.org/search', // no embedded credentials
    'https://nominatim.openstreetmap.org:8443/search', // no explicit port
    'https://nominatim.openstreetmap.org/searchx', // exact paths stay exact
    'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage', // bake script only
  ];
  for (const url of rejected) {
    assert.equal(isAllowedDataUrl(new URL(url)), false, `allowlist should reject ${url}`);
  }
});

check('no unsafe CSP source slipped in', () => {
  assert.doesNotMatch(CSP, /unsafe-eval|wasm-unsafe-eval/);
  assert.match(CSP, /script-src 'self';/);
  assert.doesNotMatch(CSP, /script-src[^;]*unsafe-inline/);
});

if (problems.length) {
  console.error(`\n${problems.length} endpoint/CSP drift problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nendpoints.js and src/data/csp.ts agree.');
