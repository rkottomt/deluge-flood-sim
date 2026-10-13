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
  parseUseCase,
  USE_CASE_IDS,
  USE_CASE_WARNING,
  USE_CASES,
  useCaseById,
} from '../../src/ui/useCaseDefs';

const presetMeta = (id: string) => JSON.parse(readFileSync(new URL(`../../public/presets/${id}/meta.json`, import.meta.url), 'utf8'));
const inside = (b: { west: number; east: number; south: number; north: number }, lat: number, lon: number) =>
  lon > b.west && lon < b.east && lat > b.south && lat < b.north;

test('usecase: exactly the three ids are accepted', () => {
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

test('usecase: every use case runs on a preset that exists', () => {
  for (const u of USE_CASES) {
    assert.equal(useCaseById(u.id), u);
    assert.equal(presetMeta(u.preset).id, u.preset);
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
