/**
 * Site check (src/loss/site.ts, egress.ts, ladders.ts): egress closure timing, one site in one flood, the sweep
 * summary and EAL, the finished-floor recommendation, mitigation BCR, the verdict sentences, and the ?sites= link
 * format — including links written by an attacker.
 * Run: node --import tsx --test tests/loss/site.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HazardFields, Shelter } from '../../src/contracts';
import { analyzeEgress, FloodTimeline, type EgressRouter } from '../../src/loss/egress';
import { ealRange, mitigationCost, upv, DISCOUNT_RATE_FEMA, USEFUL_LIFE_WALL_YEARS } from '../../src/loss/eal';
import { ladderFor, LADDER_SOURCES, PRESET_LADDERS } from '../../src/loss/ladders';
import { regionAt } from '../../src/loss/region';
import {
  assessSiteRun,
  decodeSites,
  designEventText,
  DEFAULT_FIRST_FLOOR_M,
  encodeSites,
  exceedanceCurve,
  freeboardFor,
  lossAtFloor,
  mitigationOptions,
  newSite,
  pickDesign,
  recommendFfe,
  ringAreaM2,
  ringPerimeterM,
  siteFact,
  siteVerdict,
  siteVerdictParts,
  SITE_LIMITS,
  summarizeSweep,
  type SiteSpec,
  type SweepLevelInfo,
  type SweepRow,
} from '../../src/loss/site';
import { egressTiming } from '../../src/loss/egressTiming';

const NX = 64;
const NY = 64;
const CELL = 10;
const N = NX * NY;
const GROUND = 100;
const ground = new Float32Array(N).fill(GROUND);
const region = regionAt(-80, 40);
const identity = (lon: number, lat: number): [number, number] => [lon, lat];
const money = (v: number) => (Number.isFinite(v) ? `$${Math.round(v)}` : '—');

/** Uniform flood of depth `d` everywhere, arriving at `fw` s. */
function uniform(d: number, fw = 600, simTime = 1800): HazardFields {
  return {
    nx: NX,
    ny: NY,
    simTime,
    maxDepth: new Float32Array(N).fill(d),
    maxSpeed: new Float32Array(N).fill(d > 0 ? 0.5 : 0),
    maxDV: new Float32Array(N).fill(d * 0.5),
    firstWet: new Float32Array(N).fill(d >= 0.15 ? fw : -1),
    wetSeconds: new Float32Array(N).fill(d >= 0.15 ? simTime - fw : 0),
  };
}

const ctx = (fields: HazardFields) => ({ region, grid: { nx: NX, ny: NY, cellSize: CELL }, toGrid: identity, ground, alertTime: 0 });

function site(patch: Partial<SiteSpec> = {}): SiteSpec {
  return { ...newSite('s1', 32.5, 32.5), name: 'Lot 4', occupancy: 'office', floors: 3, footprintM2: 1000, ...patch };
}

// ─── Egress ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** A router over two "roads" (single cells): shelter A is reached along road cell 10, shelter B along cell 20. */
function fakeRouter(): EgressRouter & { calls: number } {
  let depth: Float32Array = new Float32Array(N);
  const roadOf: Record<string, number> = { A: 10, B: 20 };
  return {
    calls: 0,
    updateFlood(d) {
      depth = d;
    },
    route(_start, shelters) {
      this.calls++;
      const open = shelters.filter((s) => depth[roadOf[s.name]] < 0.3);
      if (open.length) return { state: 'ok', polyline: new Float32Array([0, 0, 1, 1]), lengthMeters: 1000, etaSeconds: 120, shelter: open[0], reason: null };
      return { state: 'blocked', polyline: null, lengthMeters: 0, etaSeconds: 0, shelter: null, reason: 'cut-off' };
    },
  };
}

function roadFlood(): HazardFields {
  const f = uniform(0);
  f.firstWet.fill(-1);
  // A river (wet at reset), irrelevant to the roads; road A floods at 100 s, road B at 300 s, a puddle at 200 s.
  f.firstWet[0] = 0;
  f.maxDepth[0] = 3;
  f.firstWet[10] = 100;
  f.maxDepth[10] = 0.5;
  f.firstWet[20] = 300;
  f.maxDepth[20] = 0.6;
  f.firstWet[30] = 200;
  f.maxDepth[30] = 0.1;
  return f;
}

const shelters: Shelter[] = [
  { name: 'A', gx: 1, gy: 1 },
  { name: 'B', gx: 2, gy: 2 },
];

test('FloodTimeline: arrivals in order, seek forwards and back restores the field exactly', () => {
  const f = roadFlood();
  const tl = new FloodTimeline(f);
  assert.deepEqual(Array.from(tl.times), [100, 200, 300]);
  assert.equal(tl.seek(0)[0], 3); // water present at reset is always there
  assert.equal(tl.seek(0)[10], 0);
  assert.equal(tl.seek(1)[10], 0.5);
  assert.equal(tl.seek(3)[20], Math.fround(0.6));
  const back = tl.seek(1);
  assert.equal(back[20], 0);
  assert.equal(back[30], 0);
  assert.equal(back[10], 0.5);
});

test('egress: per-shelter closure times and the last route, found by bisection over arrivals', () => {
  const f = roadFlood();
  const r = fakeRouter();
  const e = analyzeEgress(r, f, { gx: 5, gy: 5 }, shelters);
  assert.ok(e.known);
  assert.ok(e.openAtStart);
  assert.equal(e.openAtPeak, false);
  assert.equal(e.lastRouteClosesAt, 300);
  assert.deepEqual(e.shelters.map((s) => [s.name, s.closesAt]), [['A', 100], ['B', 300]]);
  assert.ok(e.routerCalls < 20, `${e.routerCalls} router calls`);
  // End-of-run depth: road B dry again → a route reopened; still flooded → cut off for at least end − closure.
  const dry = new Float32Array(N);
  assert.equal(analyzeEgress(fakeRouter(), f, { gx: 5, gy: 5 }, shelters, { endDepth: dry }).cutAtEnd, false);
  const wet = new Float32Array(N).fill(1);
  const still = analyzeEgress(fakeRouter(), f, { gx: 5, gy: 5 }, shelters, { endDepth: wet });
  assert.equal(still.cutAtEnd, true);
  assert.equal(still.cutOffAtLeastS, 1800 - 300);
});

test('egress: unknown without shelters or roads, open when roads stay dry', () => {
  const f = roadFlood();
  assert.equal(analyzeEgress(fakeRouter(), f, { gx: 5, gy: 5 }, []).known, false);
  assert.equal(analyzeEgress(fakeRouter(), f, { gx: 5, gy: 5 }, shelters, { hasRoads: false }).known, false);
  const e = analyzeEgress(fakeRouter(), uniform(0), { gx: 5, gy: 5 }, shelters);
  assert.ok(e.openAtPeak);
  assert.ok(Number.isNaN(e.lastRouteClosesAt));
});

// ─── One site ────────────────────────────────────────────────────────────────────────────────────────────────────

test('one site in one flood: depth at grade and above the floor, water surface, value from floor area', () => {
  const f = uniform(1.2);
  const run = assessSiteRun(site(), f, ctx(f));
  assert.ok(run.result);
  assert.equal(run.result!.m.match, 'point');
  assert.equal(run.grade, GROUND);
  assert.ok(Math.abs(run.wse - (GROUND + 1.2)) < 1e-4);
  assert.equal(run.firstFloorHeight, DEFAULT_FIRST_FLOOR_M);
  assert.ok(Math.abs(run.result!.depthAboveFloor - (1.2 - DEFAULT_FIRST_FLOOR_M)) < 1e-6);
  assert.equal(run.result!.valueSource, 'unit-cost');
  assert.equal(run.result!.valueStructure, 1000 * 3 * 3000); // footprint × floors × office unit cost
  assert.equal(run.geometry.footprintSource, 'given');
  // Raising the floor above the water removes the loss; lowering it adds to it.
  assert.equal(lossAtFloor(run, 2), 0);
  assert.ok(lossAtFloor(run, 0) > run.result!.loss);
  // A pin outside the map.
  assert.equal(assessSiteRun(site({ lon: -3, lat: 5 }), f, ctx(f)).outside, true);
});

test('an outline: area, perimeter, cells, and a planned value that wins over the estimate', () => {
  const ring = [20, 20, 30, 20, 30, 30, 20, 30];
  assert.equal(ringAreaM2(ring, CELL), 100 * 100);
  assert.equal(ringPerimeterM(ring, CELL), 400);
  const f = uniform(0.5);
  const run = assessSiteRun(site({ lon: 25, lat: 25, ring, footprintM2: null, value: 5e6 }), f, ctx(f));
  assert.equal(run.result!.m.match, 'wkt');
  assert.equal(run.result!.m.cells.length, 100);
  assert.equal(run.geometry.footprintSource, 'outline');
  assert.equal(run.geometry.perimeterM, 400);
  assert.equal(run.result!.valueStructure, 5e6);
});

// ─── Sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────

function level(id: string, ft: number, T: number | null, rpFrom: SweepLevelInfo['rpFrom'] = T ? 'source' : null): SweepLevelInfo {
  return { id, label: id, ft, scale: NaN, returnPeriod: T, rpFrom, durationS: 1800 };
}

function sweepRows(spec = site()): SweepRow[] {
  const ladder: Array<[SweepLevelInfo, number]> = [
    [level('minor', 22, 10), 0],
    [level('major', 28, null), 0.2],
    [level('rp100', 35, 100), 1.0],
    [level('record', 46, 500, 'user'), 2.5],
  ];
  return ladder.map(([lv, d]) => {
    const f = uniform(d);
    return { level: lv, run: assessSiteRun(spec, f, ctx(f)) };
  });
}

test('sweep summary: first level reached / inside, EAL from the levels with return periods only', () => {
  const rows = sweepRows();
  const sum = summarizeSweep([...rows].reverse());
  assert.deepEqual(sum.rows.map((r) => r.level.id), ['minor', 'major', 'rp100', 'record']);
  assert.equal(sum.firstReached?.level.id, 'major');
  assert.equal(sum.firstInside?.level.id, 'rp100');
  assert.equal(sum.points.length, 3); // 'major' has no return period
  assert.ok(sum.userReturnPeriods);
  const expect = ealRange(sum.points);
  assert.deepEqual(sum.eal, expect);
  assert.equal(sum.points[0].loss, 0);
  assert.ok(sum.eal!.high > sum.eal!.low && sum.eal!.low > 0);
  const curve = exceedanceCurve(sum.points);
  assert.deepEqual(curve.map((c) => c.T), [10, 100, 500]);
  assert.equal(curve[1].p, 0.01);
});

test('finished-floor recommendation: 100-yr water surface + ASCE 24 freeboard; the user can pick another design level', () => {
  const sum = summarizeSweep(sweepRows());
  const design = pickDesign(sum.rows, null)!;
  assert.equal(design.row.level.id, 'rp100');
  assert.equal(design.basis, '100-yr');
  const rec = recommendFfe(design.row, design.basis, 'office')!;
  assert.ok(Math.abs(rec.designWse - (GROUND + 1)) < 1e-4);
  assert.ok(Math.abs(rec.freeboardM - 0.3048) < 1e-9);
  assert.ok(Math.abs(rec.ffeAboveGrade - (1 + 0.3048)) < 1e-4);
  assert.ok(Math.abs(rec.raiseBy - (1.3048 - DEFAULT_FIRST_FLOOR_M)) < 1e-4);
  assert.equal(freeboardFor('hospital').ft, 2);
  assert.match(freeboardFor('school').basis, /Class 3/);
  const rec3 = recommendFfe(design.row, design.basis, 'office', 3 * 0.3048)!;
  assert.match(rec3.freeboardBasis, /chosen by the user/);
  const picked = pickDesign(sum.rows, 'record')!;
  assert.equal(picked.basis, 'selected');
  // The user designs to the record, but the 1 % level WAS run: the recommendation carries it, and says so.
  assert.equal(picked.onePercent?.level.id, 'rp100');
  const recRecord = recommendFfe(picked.row, picked.basis, 'office', undefined, picked.onePercent)!;
  assert.equal(recRecord.onePercent?.label, 'rp100');
  assert.ok(Math.abs(recRecord.onePercent!.wse - (GROUND + 1)) < 1e-4);
  const said = designEventText(recRecord);
  assert.match(said, /^record — your selection; the 1 % level was also run \(rp100: water surface .* m above datum\)$/);
  assert.doesNotMatch(said, /no 1 % level was run/);
  // Designing to the 1 % level itself: no "also run".
  assert.equal(recommendFfe(design.row, design.basis, 'office', undefined, design.onePercent)!.onePercent, null);
  assert.equal(designEventText(rec), 'rp100 — the 1 %-annual-chance level');
  // No 1 % level in the sweep: the highest level stands in, and the text says why.
  const noRp = summarizeSweep(sweepRows().filter((r) => r.level.id !== 'rp100'));
  const auto = pickDesign(noRp.rows, null)!;
  assert.deepEqual([auto.row.level.id, auto.basis, auto.onePercent], ['record', 'highest', null]);
  assert.match(designEventText(recommendFfe(auto.row, auto.basis, 'office', undefined, auto.onePercent)!), /^record — the highest level run, as no published 1 % level was run$/);
  const chosen = pickDesign(noRp.rows, 'major')!;
  assert.match(designEventText(recommendFfe(chosen.row, chosen.basis, 'office', undefined, chosen.onePercent)!), /^major — your selection; no 1 % level was run$/);
  // A design level that does not reach the site: no requirement, the planned floor stands.
  const dry = recommendFfe(sum.rows[0], 'selected', 'office')!;
  assert.ok(Number.isNaN(dry.designWse));
  assert.ok(Math.abs(dry.raiseBy) < 1e-9);
});

test('mitigation: wall height and cost from eal.ts, BCR = PV(avoided EAL)/cost, break-even capex, dry floodproofing rules', () => {
  const sum = summarizeSweep(sweepRows());
  const design = pickDesign(sum.rows, null)!;
  const rec = recommendFfe(design.row, design.basis, 'office')!;
  const perim = sum.rows[0].run.geometry.perimeterM;
  const opts = mitigationOptions(sum, { occ: 'office', rec, country: 'US', perimeterM: perim });
  const wall = opts.find((o) => o.kind === 'floodwall')!;
  assert.ok(Math.abs(wall.heightM - 1.3048) < 1e-4);
  const cost = mitigationCost('floodwall', perim, wall.heightM, 'US');
  assert.equal(wall.cost!.mid, cost.mid);
  // The wall tops the 100-yr level, not the record: only levels up to rp100 lose their loss.
  const before = (sum.eal!.low + sum.eal!.high) / 2;
  assert.ok(wall.ealAfter!.high > 0);
  assert.ok(Math.abs(wall.deltaEal - (before - (wall.ealAfter!.low + wall.ealAfter!.high) / 2)) < 1e-6);
  const f = upv(DISCOUNT_RATE_FEMA, USEFUL_LIFE_WALL_YEARS);
  assert.ok(Math.abs(wall.bcr7!.mid - (wall.deltaEal * f) / cost.mid) < 1e-9);
  assert.ok(wall.bcr7!.low < wall.bcr7!.mid && wall.bcr7!.mid < wall.bcr7!.high);
  const elev = opts.find((o) => o.kind === 'elevate')!;
  assert.equal(elev.cost, null);
  // Each option over FEMA's standard useful life (BCA Reference Guide 2009, App. D): walls 50 yr, raising an office 25.
  assert.equal(wall.usefulLifeYears, 50);
  assert.equal(elev.usefulLifeYears, 25);
  assert.ok(Math.abs(elev.breakEvenCapex7 - elev.deltaEal * upv(DISCOUNT_RATE_FEMA, 25)) < 1e-6);
  assert.ok(elev.applicable);
  const dp = opts.find((o) => o.kind === 'dryproof')!;
  assert.ok(dp.applicable); // 0.7 m above the floor at the design level: under 3 ft
  // Homes cannot be dry floodproofed under the NFIP.
  const res = mitigationOptions(sum, { occ: 'res', rec, country: 'US', perimeterM: perim }).find((o) => o.kind === 'dryproof')!;
  assert.equal(res.applicable, false);
  assert.ok(res.caveats.some((c) => /residential/.test(c)));
  // Raising a home: FEMA's 30 years; a caller's life applies to every option.
  const home = mitigationOptions(sum, { occ: 'res', rec, country: 'US', perimeterM: perim });
  assert.equal(home.find((o) => o.kind === 'elevate')!.usefulLifeYears, 30);
  assert.ok(mitigationOptions(sum, { occ: 'res', rec, country: 'US', perimeterM: perim, years: 40 }).every((o) => o.usefulLifeYears === 40));
});

test('verdict: plain sentences with their numbers; no score; EAL caveats', () => {
  const rows = sweepRows();
  // Egress on the rp100 level closes 10 min before water reaches the site.
  rows[2].run.egress = { known: true, note: '', openAtStart: true, openAtPeak: false, lastRouteClosesAt: 0, peakReason: 'cut-off', cutAtEnd: true, endTime: 1800, cutOffAtLeastS: 1800, shelters: [], routeBefore: null, routeAtPeak: null, peakShelter: '', routerCalls: 1 };
  const v = siteVerdict('Lot 4', summarizeSweep(rows), money);
  const text = v.join(' ');
  assert.match(v[0], /Water reaches Lot 4 at the major \(28\.0 ft\): 0\.20 m at the lowest grade\. Dry at the minor \(22\.0 ft\) and below\./);
  assert.match(text, /floods the planned floor \(0\.30 m above grade\) from the rp100 \(35\.0 ft\), with 0\.70 m inside/);
  assert.match(text, /Dry access is lost from the rp100/);
  assert.match(text, /10 min before water reaches the site/);
  assert.match(text, /still cut off at the end of the run \(at least 30 min\)/);
  assert.match(text, /Expected annual loss \$\d+ – \$\d+/);
  assert.match(text, /some of them your input/);
  assert.doesNotMatch(text, /score/i);
  // With departure timing: who is out when the route closes, and clearance against the window, at that level.
  rows[2].run.egress = { ...rows[2].run.egress!, lastSafeDepartureAt: 1800, lastSafeShelter: 'A', routeClassMeters: [0, 900, 0, 0] };
  const instant = { id: 'custom' as const, label: 'instant', a: 1, bMin: 1 / 60, maxShare: 1, source: 'test' };
  const timed = siteVerdict('Lot 4', summarizeSweep(rows), money, (run) =>
    egressTiming(run.egress, { occupants: 590, occupantsBasis: 'test', personsPerVehicle: 1.18, personsPerVehicleBasis: 'test', exitLanes: 1, curve: instant, alertTime: 0 }),
  );
  assert.match(timed.join(' '), /At the rp100 \(35\.0 ft\): 50 % of occupants out before the last route closes .*Clearance time 60 min vs route window 30 min: 500 cars/);
  assert.equal(timed.length, v.length + 1);
  // A site that stays dry everywhere.
  const dry = siteVerdict('', summarizeSweep(rows.slice(0, 1)), money);
  assert.match(dry[0], /The site stays dry at every level run, up to the minor/);
  // Return periods only on levels that do no damage: $0, and the damaging level without one is named.
  const onlyDry = rows.map((r) => (r.level.id === 'minor' ? r : { ...r, level: { ...r.level, returnPeriod: null, rpFrom: null } }));
  assert.match(siteVerdict('X', summarizeSweep(onlyDry), money).join(' '), /Expected annual loss \$0: the one level with a return period does not damage the planned building\. The levels that do \(rp100, record\) have no published return period/);
  // No return periods → no EAL, and the user is told what to enter.
  const noRp = rows.map((r) => ({ ...r, level: { ...r.level, returnPeriod: null, rpFrom: null } }));
  assert.match(siteVerdict('X', summarizeSweep(noRp), money).join(' '), /No expected annual loss/);
});

test('verdict by part, and the facts a narrated story quotes: the same sentences, the worst level, two floor levels', () => {
  const rows = sweepRows();
  const sum = summarizeSweep(rows);
  const parts = siteVerdictParts('Lot 4', sum, money)!;
  // siteVerdict is exactly the parts in order.
  assert.deepEqual(siteVerdict('Lot 4', sum, money), [parts.reach, parts.floor!, parts.egress, ...parts.eal]);
  assert.equal(siteVerdictParts('Lot 4', summarizeSweep([]), money), null);
  const fact = (k: Parameters<typeof siteFact>[3], s = sum) => siteFact('Lot 4', s, 'office', k, money);
  assert.equal(fact('name'), 'Lot 4');
  assert.equal(fact('reach'), parts.reach);
  assert.equal(fact('floor'), parts.floor);
  assert.equal(fact('egress'), parts.egress);
  assert.equal(fact('eal'), parts.eal[0]);
  // The worst level: depth at grade, above the floor, and the loss, at the rarest level run.
  assert.match(fact('worst')!, /^2\.5 m at the lowest grade and 2\.2 m above the planned floor at the record \(46\.0 ft\), a loss of about \$\d+$/);
  // Designed to the rarest level that reaches the site: its water + 1 ft of freeboard (ASCE 24-14 Class 2).
  assert.match(fact('ffe')!, /^2\.80 m above the lowest grade — water at 102\.50 m in the record \(46\.0 ft\), plus 0\.30 m of freeboard — 2\.50 m higher than the planned 0\.30 m$/);
  assert.match(fact('ffe100')!, /^1\.30 m above the lowest grade — water at 101\.00 m in the rp100 \(35\.0 ft\)/);
  // No level cuts the way out here: no cut-off fact.
  assert.equal(fact('cutoff'), null);
  // A site the 1 % level does not reach: the planned floor stands, and says why.
  const dry1 = summarizeSweep(rows.map((r) => (r.level.id === 'rp100' ? { ...r, run: rows[0].run } : r)));
  assert.match(fact('ffe100', dry1)!, /^the planned 0\.30 m above grade — the rp100 \(35\.0 ft\) does not reach the site$/);
  // A site that stays dry everywhere: no floor sentence, and the worst level says dry.
  const dry = summarizeSweep(rows.slice(0, 1));
  assert.equal(fact('floor', dry), null);
  assert.equal(fact('worst', dry), 'dry at the minor (22.0 ft)');
  // No sweep, no facts (except the name).
  assert.equal(fact('reach', null as never), null);
  assert.equal(siteFact('Lot 4', null, 'office', 'name', money), 'Lot 4');
});

// ─── Ladders ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('ladders: ordered, every level cites a known source, return periods only where published', () => {
  for (const [id, ladder] of Object.entries(PRESET_LADDERS)) {
    for (let i = 1; i < ladder.length; i++) assert.ok(ladder[i].ft >= ladder[i - 1].ft, `${id} ordered`);
    for (const l of ladder) {
      assert.ok(LADDER_SOURCES[l.source], `${id}/${l.id} source`);
      if (l.returnPeriod != null) assert.equal(l.group, 'frequency', `${id}/${l.id}: a return period only on a frequency level`);
    }
  }
  assert.equal(ladderFor('pittsburgh')?.find((l) => l.id === 'rp100')?.ft, 35.38);
  assert.equal(ladderFor('houston'), null);
  assert.equal(ladderFor('__proto__'), null);
  assert.equal(ladderFor(null), null);
});

// ─── The link ────────────────────────────────────────────────────────────────────────────────────────────────────

test('?sites= round trip: pins, outlines, values, defaults, names with separators', () => {
  const sites: SiteSpec[] = [
    { ...newSite('s1', -80.00123, 40.44123), name: 'Lot 4; "North" ~ <b>', occupancy: 'warehouse', floors: 1, value: 25e6, footprintM2: 12000, firstFloorHeight: 1.2, criticalElev: 2.5 },
    { ...newSite('s2', -80.01, 40.45, [-80.011, 40.449, -80.009, 40.449, -80.009, 40.451, -80.011, 40.451]), name: 'Riverside', occupancy: 'apt', floors: 6 },
  ];
  const enc = encodeSites(sites);
  assert.match(enc, /^v1:/);
  // Survives URLSearchParams both ways.
  const back = decodeSites(new URLSearchParams(new URLSearchParams({ sites: enc }).toString()).get('sites'));
  assert.deepEqual(back.warnings, []);
  assert.equal(back.sites.length, 2);
  const [a, b] = back.sites;
  assert.equal(a.name, 'Lot 4; "North" ~ <b>');
  assert.equal(a.occupancy, 'warehouse');
  assert.equal(a.value, 25e6);
  assert.equal(a.firstFloorHeight, 1.2);
  assert.equal(a.criticalElev, 2.5);
  assert.equal(a.footprintM2, 12000);
  assert.ok(Math.abs(a.lon + 80.00123) < 1e-9 && Math.abs(a.lat - 40.44123) < 1e-9);
  assert.equal(a.ring, null);
  assert.deepEqual(b.ring, sites[1].ring);
  assert.equal(b.value, null);
  assert.equal(b.firstFloorHeight, null);
  assert.equal(encodeSites([]), '');
});

test('?sites= never carries a street address: a site still named by the geocoder is shared without its name', () => {
  const addr = '1600 Smith Street';
  const site: SiteSpec = { ...newSite('s1', -95.3698, 29.7604), name: addr, geocodedName: addr };
  const enc = encodeSites([site]);
  assert.ok(!/Smith|1600/.test(decodeURIComponent(enc)), enc);
  const back = decodeSites(enc).sites[0];
  assert.equal(back.name, '');
  assert.ok(Math.abs(back.lat - 29.7604) < 1e-9 && Math.abs(back.lon + 95.3698) < 1e-9);
  // Renamed by the user: the name is theirs and travels.
  assert.match(decodeURIComponent(encodeSites([{ ...site, name: 'HQ' }])), /~HQ$/);
});

test('?sites= hostile input: bounded, strict, never echoed', () => {
  const ok = encodeSites([newSite('s1', -80, 40)]);
  const evil = [
    '<script>alert(1)</script>',
    'v2:40,-80~office~3~~~~~x',
    'v1:40,-80~admin~3~~~~~x', // unknown occupancy
    'v1:40,-80~office~0~~~~~x', // floors out of range
    'v1:40,-80~office~3~-5~~~~x', // negative value
    'v1:91,-80~office~3~~~~~x', // latitude out of range
    'v1:40,-80~office~3~1e3~~~~x', // exponent notation is not accepted
    'v1:40,-80~office~3~0x10~~~~x',
    'v1:40,-80~office~3~Infinity~~~~x',
    'v1:40,-80,41~office~3~~~~~x', // odd coordinate count
    'v1:40,-80~office~3~~~~', // missing field
    `v1:${'1,1,'.repeat(SITE_LIMITS.maxRing + 2)}1,1~office~3~~~~~x`, // too many corners
    'v1:40,-80~office~3~~~~~%E0%A4%A', // malformed percent-encoding: kept, name dropped
  ];
  for (const raw of evil) {
    const r = decodeSites(raw);
    for (const w of r.warnings) {
      assert.doesNotMatch(w, /script|admin|Infinity|0x10/, 'warnings are fixed sentences');
    }
  }
  assert.equal(decodeSites(evil[0]).sites.length, 0);
  assert.equal(decodeSites(evil[2]).sites.length, 0);
  assert.equal(decodeSites(evil[6]).sites.length, 0);
  const mal = decodeSites(evil[12]);
  assert.equal(mal.sites.length, 1);
  assert.equal(mal.sites[0].name, '');
  // Control and bidi-override characters are stripped from names; names are capped.
  const bidi = decodeSites(`v1:40,-80~office~3~~~~~${encodeURIComponent('A‮evil\u0000' + 'x'.repeat(100))}`);
  assert.ok(!/[‮\u0000]/.test(bidi.sites[0].name));
  assert.ok([...bidi.sites[0].name].length <= SITE_LIMITS.nameChars);
  // Too long, too many.
  assert.equal(decodeSites('v1:' + 'x'.repeat(SITE_LIMITS.maxParamChars)).sites.length, 0);
  const many = decodeSites('v1:' + Array(SITE_LIMITS.maxSites + 3).fill(ok.slice(3)).join(';'));
  assert.equal(many.sites.length, SITE_LIMITS.maxSites);
  assert.ok(many.warnings.length === 1);
  assert.deepEqual(decodeSites(null), { sites: [], warnings: [] });
});

// ─── The NOAA Atlas 14 rain ladder ──────────────────────────────────────────────────────────────────────────────────

test('rain ladder: Atlas 14 1-hour intensities become sourced levels with annual-chance return periods', async () => {
  const { rainLadder, annualReturnPeriod, RAIN_DESIGN_DURATION_S, RAIN_LADDER_CAVEATS } = await import('../../src/loss/ladders');
  // Houston's PFDS 60-minute row (tests/fixtures/atlas14/pfds-houston.txt).
  const houston = { levels: [2, 10, 25, 100, 500].map((ari, i) => ({ ari, mmPerHour: [57, 82, 98, 123, 162][i] })) };
  const L = rainLadder(houston);
  assert.deepEqual(L.map((l) => l.mmPerHour), [57, 82, 98, 123, 162]);
  assert.ok(L.every((l) => l.source === 'noaa-atlas14' && LADDER_SOURCES[l.source]));
  // Langbein: AEP = 1 − e^(−1/ARI). 2-yr ARI is a 39 % annual chance; 100-yr is 0.995 %.
  assert.ok(Math.abs(L[0].returnPeriod - 2.5415) < 1e-3, `${L[0].returnPeriod}`);
  assert.ok(Math.abs(L[3].returnPeriod - 100.5008) < 1e-3);
  assert.ok(Math.abs(1 / annualReturnPeriod(100) - 0.00995) < 1e-5);
  for (const l of L) assert.ok(l.returnPeriod > l.ari && l.returnPeriod - l.ari < 0.55, `${l.ari}: ${l.returnPeriod}`);
  assert.equal(RAIN_DESIGN_DURATION_S, 3600);
  assert.ok(RAIN_LADDER_CAVEATS.some((c) => /stationary/i.test(c)) && RAIN_LADDER_CAVEATS.some((c) => /river/i.test(c)));
  // Junk levels are dropped, never turned into a rain rate.
  assert.equal(rainLadder({ levels: [{ ari: 2, mmPerHour: NaN }, { ari: 0, mmPerHour: 10 }, { ari: 10, mmPerHour: -1 }] }).length, 0);
});

test('rain ladder sweep: EAL with sourced return periods, the 100-yr rain is the 1 % design level', async () => {
  const { rainLadder } = await import('../../src/loss/ladders');
  const { formatReturnPeriod, isOnePercent } = await import('../../src/loss/site');
  const L = rainLadder({ levels: [2, 10, 25, 100, 500].map((ari, i) => ({ ari, mmPerHour: [57, 82, 98, 123, 162][i] })) });
  const depths = [0, 0.1, 0.3, 0.7, 1.4];
  // Out of order on purpose: the summary orders rain levels by intensity.
  const rows: SweepRow[] = L.map((l, i) => {
    const f = uniform(depths[i]);
    const lv: SweepLevelInfo = { id: l.id, label: l.label, ft: NaN, scale: NaN, rainMmH: l.mmPerHour, returnPeriod: l.returnPeriod, rpFrom: 'source', durationS: 7200 };
    return { level: lv, run: assessSiteRun(site(), f, ctx(f)) };
  }).reverse();
  const sum = summarizeSweep(rows);
  assert.deepEqual(sum.rows.map((r) => r.level.rainMmH), [57, 82, 98, 123, 162]);
  assert.equal(sum.points.length, 5);
  assert.ok(sum.eal && sum.eal.high > sum.eal.low && sum.eal.low > 0, JSON.stringify(sum.eal));
  assert.equal(sum.userReturnPeriods, false);
  const design = pickDesign(sum.rows, null)!;
  assert.equal(design.basis, '100-yr');
  assert.equal(design.row.level.id, 'a14-100');
  assert.ok(isOnePercent(100) && isOnePercent(100.5008) && !isOnePercent(125) && !isOnePercent(null));
  // The 1 % level by its annual chance: 1 % itself, or the Atlas 14 100-yr ARI's 0.995 % (Langbein, 100.5 yr) —
  // not a neighbouring 99- or 101-yr level (1.01 % / 0.990 %).
  assert.ok(isOnePercent(L.find((l) => l.id === 'a14-100')!.returnPeriod) && isOnePercent(100.5));
  assert.ok(!isOnePercent(99) && !isOnePercent(101) && !isOnePercent(100.6) && !isOnePercent(99.9));
  assert.deepEqual(L.map((l) => formatReturnPeriod(l.returnPeriod)), ['2.5', '10.5', '25.5', '100.5', '500.5']);
  assert.equal(formatReturnPeriod(2), '2');
  const v = siteVerdict('Lot 9', sum, money).join(' ');
  assert.match(v, /Atlas 14 25-yr 1-hour rain \(98 mm\/h\)/);
  assert.match(v, /Expected annual loss/);
});

test('rain ladder: Today vs future compares it under a rain multiplier', async () => {
  const { sweepComparable } = await import('../../src/climate/apply');
  const base = { identity: false, chainInflows: false, riverStageUnscaled: true, seaRiseM: 0, rainMult: 1.2, inflowMult: 1.2 } as unknown as Parameters<typeof sweepComparable>[0];
  assert.equal(sweepComparable(base, 'rain').ok, true);
  assert.equal(sweepComparable({ ...base, rainMult: 1 } as typeof base, 'rain').ok, false);
  assert.equal(sweepComparable(base, 'stage').ok, false);
});
