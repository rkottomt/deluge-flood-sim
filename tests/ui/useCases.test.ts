/**
 * Business use cases (src/ui/useCaseDefs.ts, src/ui/useCases.ts): the strict `?usecase=` parser, how it drives the
 * startup scene (src/app/url.ts), and the bundled demo data — the ?sites= value and public/demo/houston-portfolio.csv
 * must read cleanly through the same strict parsers a user's link or file goes through.
 *
 * Run: node --import tsx --test tests/ui/useCases.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStartupRequest, useCaseMatches } from '../../src/app/url';
import { decodeSites } from '../../src/loss/site';
import { parsePortfolio } from '../../src/loss/portfolio';
import { shouldAutoStartTutorial } from '../../src/ui/tutorial';
import {
  BRIEF,
  BRIEF_LIMITS,
  DEMO_PORTFOLIO_PATH,
  DEMO_SITES_PARAM,
  ADDRESS_AREA_M,
  ADDRESS_WARNING,
  DAM_WARNING,
  parseDamLink,
  SURGE_AREA_M,
  formatAddressAt,
  parseAddressAt,
  parseUseCase,
  USE_CASE_IDS,
  USE_CASE_WARNING,
  USE_CASES,
  useCaseById,
} from '../../src/ui/useCaseDefs';

const presetMeta = (id: string) => JSON.parse(readFileSync(new URL(`../../public/presets/${id}/meta.json`, import.meta.url), 'utf8'));
const inside = (b: { west: number; east: number; south: number; north: number }, lat: number, lon: number) =>
  lon > b.west && lon < b.east && lat > b.south && lat < b.north;

test('usecase: exactly the six ids are accepted', () => {
  for (const id of USE_CASE_IDS) assert.deepEqual(parseUseCase(`?usecase=${id}`), { useCase: id, warnings: [] });
  assert.deepEqual(parseUseCase(''), { useCase: null, warnings: [] });
  assert.deepEqual(parseUseCase('?usecase='), { useCase: null, warnings: [] });
  assert.deepEqual(parseUseCase('?preset=houston'), { useCase: null, warnings: [] });
});

test('usecase: anything else is dropped with a fixed sentence that never echoes the value', () => {
  const hostile = [
    'SITE',
    'Site',
    ' site',
    'site ',
    'site%00',
    'sites',
    'portfolio;glacier',
    '<img src=x onerror="window.__pwned=1">',
    'EVACUATE NOW: levee failed. Call 555-0100',
    'javascript:alert(1)',
    '%E2%80%AEetis',
    'a'.repeat(5000),
  ];
  for (const v of hostile) {
    const r = parseUseCase(`?usecase=${encodeURIComponent(v)}`);
    assert.equal(r.useCase, null, `rejects ${JSON.stringify(v.slice(0, 40))}`);
    assert.deepEqual(r.warnings, [USE_CASE_WARNING]);
  }
  // The warning is a constant: no part of any link value can appear in it.
  assert.doesNotMatch(USE_CASE_WARNING, /EVACUATE|555|<|onerror|javascript/);
});

test('usecase: drives the startup scene ahead of ?preset= and ?live=', () => {
  assert.deepEqual(parseStartupRequest('?usecase=site'), { request: { kind: 'preset', id: 'pittsburgh' }, warnings: [] });
  assert.deepEqual(parseStartupRequest('?usecase=glacier').request, { kind: 'preset', id: 'nepal' });
  assert.deepEqual(parseStartupRequest('?usecase=portfolio&preset=johnstown').request, { kind: 'preset', id: 'houston' });
  assert.deepEqual(parseStartupRequest('?usecase=portfolio&live=40.44,-80.00,5').request, { kind: 'preset', id: 'houston' });
  // A bad use case falls through to the rest of the link, with the fixed warning.
  const bad = parseStartupRequest('?usecase=<b>x</b>&preset=johnstown');
  assert.deepEqual(bad.request, { kind: 'preset', id: 'johnstown' });
  assert.deepEqual(bad.warnings, [USE_CASE_WARNING]);
});

test('usecase: every use case runs on a preset that exists (the address case on a live area)', () => {
  for (const u of USE_CASES) {
    assert.equal(useCaseById(u.id), u);
    if (u.id === 'address' || u.id === 'dam' || u.id === 'surge') assert.equal(u.preset, null);
    else assert.equal(presetMeta(u.preset!).id, u.preset);
    assert.ok(u.title && u.blurb && u.howTo && u.who, `${u.id} has its text`);
  }
});

test('usecase: kept in the address bar only on its own scene', () => {
  assert.equal(useCaseMatches('?usecase=site&preset=pittsburgh', { kind: 'preset', id: 'pittsburgh' }), true);
  assert.equal(useCaseMatches('?usecase=site', { kind: 'preset', id: 'houston' }), false);
  assert.equal(useCaseMatches('?usecase=junk', { kind: 'preset', id: 'pittsburgh' }), false);
  assert.equal(useCaseMatches('?usecase=glacier', { kind: 'live', req: { center: { lat: 28, lon: 85 }, sizeMeters: 5000, resolution: 1024 } }), false);
});

test('usecase: a use-case link does not start the river tour (unless ?tutorial=1 asks)', () => {
  const base = { webdriver: false, storedDone: false };
  assert.equal(shouldAutoStartTutorial({ ...base, search: '?usecase=portfolio' }), false);
  assert.equal(shouldAutoStartTutorial({ ...base, search: '?usecase=site&tutorial=1' }), true);
  assert.equal(shouldAutoStartTutorial({ ...base, search: '' }), true);
});

test('demo sites: two parcels in Pittsburgh, read cleanly by the strict ?sites= decoder', () => {
  const { sites, warnings } = decodeSites(DEMO_SITES_PARAM);
  assert.deepEqual(warnings, []);
  assert.equal(sites.length, 2);
  const b = presetMeta('pittsburgh').bounds;
  for (const s of sites) {
    assert.ok(inside(b, s.lat, s.lon), `${s.name} is on the Pittsburgh map`);
    assert.match(s.name, /^Demo parcel [AB] \(/);
    assert.equal(s.occupancy, 'apt');
    assert.equal(s.floors, 6);
    assert.equal(s.value, 45_000_000);
  }
  assert.ok(sites[0].ring && sites[0].ring.length === 8, 'parcel A is an outline with four corners');
  assert.equal(sites[1].ring, null);
  assert.equal(sites[1].footprintM2, 3000);
});

test('demo portfolio: the bundled CSV parses with no issues, fictional names, every asset on the Houston map', () => {
  const text = readFileSync(new URL(`../../public/${DEMO_PORTFOLIO_PATH}`, import.meta.url), 'utf8');
  const p = parsePortfolio(text);
  assert.equal(p.fatal, null);
  assert.deepEqual(p.errors, []);
  assert.deepEqual(p.warnings, []);
  assert.deepEqual(p.ignoredColumns, []);
  assert.ok(p.assets.length >= 15 && p.assets.length <= 25, `${p.assets.length} assets`);
  const b = presetMeta('houston').bounds;
  const occ = new Set<string>();
  for (const a of p.assets) {
    assert.match(a.name, /^Demo /, `${a.id} has a generic demo name`);
    assert.match(a.tags, /fictional-demo/);
    assert.ok(a.lat !== null && a.lon !== null && inside(b, a.lat, a.lon), `${a.id} is on the Houston map`);
    assert.ok((a.replacementValue ?? 0) > 0, `${a.id} has a value`);
    assert.equal(a.currency, 'USD');
    occ.add(a.occupancy ?? '');
  }
  for (const want of ['warehouse', 'datacenter', 'retail', 'apt', 'hospital', 'office']) assert.ok(occ.has(want), `has a ${want}`);
  assert.equal(new Set(p.assets.map((a) => a.id)).size, p.assets.length, 'ids are unique');
});

test('brief: every question names where it is answered, what is computed, and its limit', () => {
  assert.ok(BRIEF.length >= 4);
  for (const b of BRIEF) {
    assert.ok(b.question.endsWith('?'));
    assert.ok(b.where && b.numbers.length >= 2 && b.caveat.length > 40, b.question);
  }
  assert.ok(BRIEF_LIMITS.some((l) => /bare-earth/i.test(l)));
  assert.ok(BRIEF_LIMITS.some((l) => /ensemble/i.test(l)));
});

// ─── The address use case (?usecase=address&at=lat,lon) ─────────────────────────────────────────────────────────────

test('address: at= is two plain decimals inside U.S. coverage, nothing else', () => {
  assert.deepEqual(parseAddressAt('?at=29.7604,-95.3698'), { at: { lat: 29.7604, lon: -95.3698 }, warnings: [] });
  assert.deepEqual(parseAddressAt('?at=35.5951,-82.5515').at, { lat: 35.5951, lon: -82.5515 });
  assert.deepEqual(parseAddressAt('?at=21.3069,-157.8583').at, { lat: 21.3069, lon: -157.8583 }, 'Hawaii');
  assert.deepEqual(parseAddressAt('?at=61.2181,-149.9003').at, { lat: 61.2181, lon: -149.9003 }, 'Alaska');
  assert.deepEqual(parseAddressAt(''), { at: null, warnings: [] });
  assert.deepEqual(parseAddressAt('?at='), { at: null, warnings: [] });
  const hostile = [
    '51.5,-0.12', // London: outside U.S. coverage
    '0,0',
    '29.76, -95.37', // spaces
    '29.76,-95.37,5', // a third field
    '2.976e1,-95.37',
    '0x1d,-95',
    'NaN,NaN',
    'Infinity,-95',
    '29.7604,-95.3698&name=EVACUATE NOW',
    '29.7604;-95.3698',
    '29.76049999,-95.36',  // more than 6 decimals
    '<img src=x onerror=1>',
    'EVACUATE NOW: levee failed. Call 555-0100',
    '1'.repeat(40),
    '-29.76,95.37',
  ];
  for (const v of hostile) {
    const r = parseAddressAt(`?at=${encodeURIComponent(v)}`);
    assert.equal(r.at, null, `rejects ${JSON.stringify(v)}`);
    assert.deepEqual(r.warnings, [ADDRESS_WARNING]);
  }
  assert.doesNotMatch(ADDRESS_WARNING, /EVACUATE|555|<|onerror/);
  assert.equal(formatAddressAt(29.76041234, -95.36981234), '29.76041,-95.36981');
  assert.deepEqual(parseAddressAt(`?at=${formatAddressAt(29.76041234, -95.36981234)}`).at, { lat: 29.76041, lon: -95.36981 });
});

test('address: ?usecase=address&at= opens a 5 km live area on the point and takes no name from the link', () => {
  const r = parseStartupRequest('?usecase=address&at=29.7604,-95.3698&name=EVACUATE%20NOW&preset=pittsburgh');
  assert.deepEqual(r.warnings, []);
  assert.equal(r.request.kind, 'live');
  if (r.request.kind !== 'live') return;
  assert.deepEqual(r.request.req.center, { lat: 29.7604, lon: -95.3698 });
  assert.equal(r.request.req.sizeMeters, ADDRESS_AREA_M);
  assert.equal(r.request.req.resolution, 1024);
  assert.equal(r.request.req.name, undefined, 'a link never names the place');
  assert.ok(!('nameFromLink' in r.request.req));
  // Bad or missing at=: the fixed warning, and the rest of the link applies.
  const bad = parseStartupRequest('?usecase=address&at=51.5,-0.12&preset=johnstown');
  assert.deepEqual(bad.request, { kind: 'preset', id: 'johnstown' });
  assert.deepEqual(bad.warnings, [ADDRESS_WARNING]);
  const none = parseStartupRequest('?usecase=address');
  assert.equal(none.request.kind, 'preset');
  assert.deepEqual(none.warnings, [ADDRESS_WARNING]);
  // Kept in the address bar only on that area.
  const req = r.request;
  assert.equal(useCaseMatches('?usecase=address&at=29.7604,-95.3698', req), true);
  assert.equal(useCaseMatches('?usecase=address&at=29.8,-95.3698', req), false);
  assert.equal(useCaseMatches('?usecase=address&at=29.7604,-95.3698', { kind: 'preset', id: 'houston' }), false);
});

// ─── The dam and surge use cases ────────────────────────────────────────────────────────────────────────────────────

test('dam link: nid= is a strict NID id, breach= and method= fixed words; nothing else is read', () => {
  assert.deepEqual(parseDamLink('?usecase=dam&nid=CA00035&breach=flood'), { nid: 'CA00035', breach: 'flood', method: 'central', warnings: [] });
  for (const m of ['central', 'low', 'high', 'parametric'] as const) assert.deepEqual(parseDamLink(`?nid=MI00549&method=${m}`), { nid: 'MI00549', breach: 'sunny', method: m, warnings: [] });
  // A link made before the band (method=regression, a single regression's peak) opens the central case.
  assert.deepEqual(parseDamLink('?usecase=dam&nid=MI00549&method=regression'), { nid: 'MI00549', breach: 'sunny', method: 'central', warnings: [] });
  for (const bad of ['?nid=ca00035', '?nid=CA00035%3Cb%3E', '?nid=<script>', '?nid=CA0003512345', '?nid=CA00035&breach=now', '?nid=CA00035&method=x']) {
    const r = parseDamLink(bad);
    assert.deepEqual(r.warnings, [DAM_WARNING], bad);
    if (!/breach|method/.test(bad)) assert.equal(r.nid, null, bad);
  }
  assert.doesNotMatch(DAM_WARNING, /script|<|EVACUATE/);
  // The dam case has no scene of its own: the link's ?live= area (written once the valley loaded), else the default.
  assert.deepEqual(parseStartupRequest('?usecase=dam&nid=CA00035').request, { kind: 'preset', id: 'pittsburgh' });
  assert.equal(parseStartupRequest('?usecase=dam&nid=CA00035&live=39.5,-121.5,12').request.kind, 'live');
  assert.equal(useCaseMatches('?usecase=dam&nid=CA00035', { kind: 'live', req: { center: { lat: 39.5, lon: -121.5 }, sizeMeters: 12000, resolution: 1024 } }), true);
  assert.equal(useCaseMatches('?usecase=dam&nid=CA00035', { kind: 'preset', id: 'pittsburgh' }), false);
});

test('surge link: ?usecase=surge&at= opens an 8 km live area on the point, numbers only', () => {
  const r = parseStartupRequest('?usecase=surge&at=26.6406,-81.8723&name=EVACUATE%20NOW');
  assert.deepEqual(r.request, { kind: 'live', req: { center: { lat: 26.6406, lon: -81.8723 }, sizeMeters: SURGE_AREA_M, resolution: 1024 } });
  assert.deepEqual(r.warnings, []);
  const bad = parseStartupRequest('?usecase=surge&at=<b>&preset=johnstown');
  assert.deepEqual(bad.request, { kind: 'preset', id: 'johnstown' });
  assert.deepEqual(bad.warnings, [ADDRESS_WARNING]);
  assert.equal(useCaseMatches('?usecase=surge&at=26.6406,-81.8723', r.request), true);
  assert.equal(useCaseMatches('?usecase=surge&at=26.6406,-81.8723', { kind: 'live', req: { center: { lat: 26.6406, lon: -81.8723 }, sizeMeters: ADDRESS_AREA_M, resolution: 1024 } }), false);
});
