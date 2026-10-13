/**
 * Design comparison arithmetic (src/project/compare.ts): EAL, ΔEAL, NPV and BCR per design against hand-worked numbers,
 * costs from the drawn polylines, and transferred risk — buildings and land made wetter — counted, never netted off.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { areaDelta, buildingDelta, compareDesigns, comparisonSummary, depthChangeThumb, resolveCost, type CompareLevel, type LevelRun } from '../../src/project/compare';
import { DISCOUNT_RATE_FEMA, DISCOUNT_RATE_LOW, mitigationCost, upv } from '../../src/loss/eal';
import { readProject } from '../../src/project/validate';
import { PROJECT_FORMAT, PROJECT_VERSION } from '../../src/project/format';

const close = (a: number, b: number, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

const run = (loss: number, buildings: Array<[number, number, number]> = []): LevelRun => ({
  loss,
  lossLo: loss * 0.7,
  lossHi: loss * 1.3,
  reached: buildings.filter((b) => b[2] >= 0.15).length,
  buildings: new Map(buildings.map(([k, l, d]) => [k, { loss: l, depth: d }])),
  area: null,
});

test('building delta: protected, newly reached, deeper and worse are separate lines', () => {
  const base = new Map([
    [1, { loss: 100, depth: 1.0 }],
    [2, { loss: 50, depth: 0.5 }],
    [3, { loss: 0, depth: 0.05 }],
  ]);
  const cur = new Map([
    [1, { loss: 0, depth: 0.0 }], // protected
    [2, { loss: 80, depth: 0.9 }], // deeper and worse
    [3, { loss: 20, depth: 0.3 }], // newly reached (and deeper, worse)
    [4, { loss: 10, depth: 0.2 }], // newly reached, not in the baseline at all
  ]);
  const d = buildingDelta(base, cur);
  assert.equal(d.protectedCount, 1);
  assert.equal(d.newlyReached, 2);
  assert.equal(d.newlyReachedLoss, 30);
  assert.equal(d.deeper, 3);
  assert.equal(d.worse, 3);
  assert.equal(d.worseLoss, 30 + 20 + 10);
});

test('area delta skips rivers and splits newly flooded, deeper and kept dry', () => {
  const base = new Float32Array([0, 0.5, 0.5, 1.0, 0.2, 3]);
  const cur = new Float32Array([0.4, 0.55, 0.9, 0.0, 0.2, 5]);
  const water = new Uint8Array([0, 0, 0, 0, 0, 1]);
  const a = areaDelta(base, cur, water, 10);
  assert.equal(a.newlyFloodedM2, 100);
  assert.equal(a.deeperM2, 100); // 0.5 → 0.9 (0.5 → 0.55 is within 10 cm)
  assert.equal(a.protectedM2, 100);
  const th = depthChangeThumb(base, cur, water, 3, 2, 2);
  assert.equal(th.stride, 2);
  assert.equal(th.w, 2);
  assert.equal(th.h, 1);
  // Block (0,0) holds cells 0,1 (row 0) and 3,4 (row 1): the largest change is −1.0 at cell 3.
  close(th.data[0], -1.0);
});

test('cost from the drawn polylines sums segment by segment; overrides win', () => {
  const edits = [{ op: 'wall' as const, pts: [0, 0, 100, 0, 100, 50], h: [2, 3], r: 1 }];
  const c = resolveCost({ type: 'floodwall', capexUsd: null, omUsdPerYear: 1000, lengthM: null, heightM: null }, edits, 8, 'US');
  const expect = mitigationCost('floodwall', 800, 2, 'US').mid + mitigationCost('floodwall', 400, 3, 'US').mid;
  close(c.capex, expect);
  close(c.lengthM, 1200);
  close(c.meanHeightM, (800 * 2 + 400 * 3) / 1200);
  assert.equal(c.basis, 'segments');
  assert.equal(c.om, 1000);
  close(c.low, expect * 0.5);
  const o = resolveCost({ type: 'earthen', capexUsd: 2e6, omUsdPerYear: null, lengthM: null, heightM: null }, edits, 8, 'US');
  assert.equal(o.capex, 2e6);
  assert.equal(o.basis, 'override');
  const dims = resolveCost({ type: 'earthen', capexUsd: null, omUsdPerYear: null, lengthM: 500, heightM: 2 }, edits, 8, 'US');
  close(dims.capex, mitigationCost('earthen', 500, 2, 'US').mid);
  const erased = resolveCost({ type: 'floodwall', capexUsd: null, omUsdPerYear: null, lengthM: null, heightM: null }, [...edits, { op: 'erase', a: [0, 0], b: [1, 0], r: 1 }], 8, 'US', { lengthM: 300, meanHeightM: 2 });
  assert.equal(erased.basis, 'raster');
  close(erased.capex, mitigationCost('floodwall', 300, 2, 'US').mid);
  const dug = resolveCost({ type: 'floodwall', capexUsd: null, omUsdPerYear: null, lengthM: null, heightM: null }, [{ op: 'terrain', at: [1, 1], r: 2, d: -1 }], 8, 'US');
  assert.equal(dug.capex, 0);
  assert.ok(dug.terrainNotCosted);
});

test('EAL, ΔEAL, NPV and BCR per design match the hand calculation', () => {
  const levels: CompareLevel[] = [
    { id: 'rp100', label: 'FEMA 1 %', returnPeriod: 100, rpFrom: 'source' },
    { id: 'record1936', label: '1936 crest', returnPeriod: 500, rpFrom: 'user' },
    { id: 'minor', label: 'NWS minor', returnPeriod: null, rpFrom: null },
  ];
  const baseline = [run(10e6, [[1, 1e6, 1.0]]), run(100e6, [[1, 2e6, 2.0], [2, 1e6, 0.6]]), run(1e6)];
  const capex = 20e6;
  const designs = [
    { id: 'A', name: 'Levee', cost: { type: 'floodwall' as const, capex, low: capex / 2, high: capex * 1.5, om: 0, lengthM: 2000, meanHeightM: 3, basis: 'segments' as const, terrainNotCosted: false }, levels: [run(0), run(30e6, [[2, 1.2e6, 0.9], [7, 3e5, 0.4]]), run(0)] },
  ];
  const c = compareDesigns(levels, baseline, designs);
  // Baseline EAL: trapezoid 0.5·(10 + 100)·(1/100 − 1/500) + tail 100/500, in $M.
  const eB = 0.5 * (10e6 + 100e6) * (0.01 - 0.002) + 100e6 / 500;
  const eA = 0.5 * (0 + 30e6) * (0.01 - 0.002) + 30e6 / 500;
  close(c.baseline.eal!, eB);
  close(c.baseline.ealNoTail!, 0.5 * (10e6 + 100e6) * 0.008);
  const d = c.designs[0];
  close(d.eal!, eA);
  close(d.deltaEal!, eB - eA);
  close(d.npv7!, (eB - eA) * upv(DISCOUNT_RATE_FEMA, 50) - capex);
  close(d.bcr7!, ((eB - eA) * upv(DISCOUNT_RATE_FEMA, 50)) / capex);
  close(d.bcr3!, ((eB - eA) * upv(DISCOUNT_RATE_LOW, 50)) / capex);
  assert.equal(c.withRp, 2);
  assert.equal(d.protectedBuildings, 1, 'building 1 is dry with the levee at both levels; the most over levels is 1');
  assert.equal(d.newlyReached, 1, 'building 7 is newly reached at the 1936 crest');
  assert.equal(d.deeperBuildings, 2, 'building 2 (0.6 → 0.9 m) and building 7');
  close(d.perLevel[1].avoided, 70e6);
  // What a project keeps, and that it passes the strict reader.
  const s = comparisonSummary(c, 'stage', 1800, new Date('2026-10-12T00:00:00Z'));
  assert.equal(s.designs[0].bcr7, d.bcr7);
  const r = readProject({
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    scene: { kind: 'preset', id: 'pittsburgh' },
    scenario: { stageOffset: 0, sim: {} },
    comparison: JSON.parse(JSON.stringify(s)),
  });
  assert.ok(r.ok && r.project.comparison && r.project.comparison.designs[0].bcr7 === d.bcr7);
});

test('no return period: no EAL, no BCR — and nothing invented', () => {
  const levels: CompareLevel[] = [{ id: 'current', label: 'On screen', returnPeriod: null, rpFrom: null }];
  const c = compareDesigns(levels, [run(5e6)], [{ id: 'A', name: 'A', cost: { type: 'floodwall', capex: 1e6, low: 5e5, high: 1.5e6, om: 0, lengthM: 100, meanHeightM: 2, basis: 'segments', terrainNotCosted: false }, levels: [run(1e6)] }]);
  assert.equal(c.withRp, 0);
  assert.equal(c.baseline.eal, null);
  assert.equal(c.designs[0].deltaEal, null);
  assert.equal(c.designs[0].bcr7, null);
  assert.equal(c.designs[0].bca, null);
  close(c.designs[0].perLevel[0].avoided, 4e6);
});

test('the benefit–cost analysis per design: the chosen rate, a user useful life, the curve and cost band, and what a project keeps', () => {
  const levels: CompareLevel[] = [
    { id: 'rp100', label: 'FEMA 1 %', returnPeriod: 100, rpFrom: 'source' },
    { id: 'record1936', label: '1936 crest', returnPeriod: 500, rpFrom: 'user' },
  ];
  const baseline = [run(10e6), run(100e6)];
  const cost = { type: 'floodwall' as const, capex: 20e6, low: 10e6, high: 30e6, om: 100_000, lengthM: 2000, meanHeightM: 3, basis: 'segments' as const, terrainNotCosted: false };
  const designs = [
    { id: 'A', name: 'Levee', cost, levels: [run(0), run(30e6)] },
    { id: 'B', name: 'Levee, 30-yr life', cost: { ...cost, years: 30, yearsFrom: 'user' as const }, levels: [run(0), run(30e6)] },
    { id: 'C', name: 'Makes it worse', cost, levels: [run(12e6), run(120e6)] },
  ];
  const c = compareDesigns(levels, baseline, designs, { rate: 0.031 });
  assert.equal(c.rate, 0.031);
  const [a, b, w] = c.designs;
  assert.equal(a.years, 50, 'FEMA’s standard value for a flood wall');
  assert.equal(b.years, 30);
  const dE = a.deltaEal!;
  close(a.bca!.eal.avoided, dE);
  close(a.bca!.central.bcr, (dE * upv(0.031, 50)) / (20e6 + 100_000 * upv(0.031, 50)));
  close(b.bca!.central.bcr, (dE * upv(0.031, 30)) / (20e6 + 100_000 * upv(0.031, 30)));
  // The NPVs at 7 % / 3.1 % use the design's own useful life too.
  close(b.npv7!, dE * upv(DISCOUNT_RATE_FEMA, 30) - 20e6 - 100_000 * upv(DISCOUNT_RATE_FEMA, 30));
  // The run's loss range is ±30 %: the curve band scales the avoided EAL by 0.7 / 1.3.
  close(a.bca!.curve!.lo.deltaEal, dE * 0.7);
  close(a.bca!.curve!.hi.deltaEal, dE * 1.3);
  assert.deepEqual(a.bca!.included, ['curve', 'cost', 'tail']);
  assert.ok(a.bca!.range.bcr[0] < a.bca!.central.bcr && a.bca!.central.bcr < a.bca!.range.bcr[1]);
  assert.equal(w.bca!.verdict, 'worse');
  assert.ok(w.bca!.central.bcr < 0);
  // An ensemble spread widens the range and is labelled.
  const e = compareDesigns(levels, baseline, designs, { ensemble: { p10: 0.5, p90: 2, members: 12 } });
  assert.equal(e.rate, 0.07, 'the FEMA default when no rate is given');
  assert.ok(e.designs[0].bca!.included.includes('ensemble'));
  close(e.designs[0].bca!.ensemble!.p90.bcr, e.designs[0].bca!.central.bcr * 2);
  // What a project keeps passes the strict reader, the BCA fields included.
  const s = comparisonSummary(c, 'stage', 1800, new Date('2026-10-12T00:00:00Z'));
  assert.equal(s.discountRate, 0.031);
  assert.equal(s.designs[1].years, 30);
  close(s.designs[0].bcr!, a.bca!.central.bcr);
  close(s.designs[0].bcrLow!, a.bca!.range.bcr[0]);
  close(s.designs[0].breakEvenCost!, a.bca!.central.breakEvenCapex);
  const r = readProject({ format: PROJECT_FORMAT, version: PROJECT_VERSION, scene: { kind: 'preset', id: 'pittsburgh' }, scenario: { stageOffset: 0, sim: {} }, comparison: JSON.parse(JSON.stringify(s)) });
  assert.ok(r.ok && r.project.comparison);
  if (r.ok && r.project.comparison) {
    assert.deepEqual(r.project.comparison.designs.map((d) => d.years), [50, 30, 50]);
    assert.equal(r.project.comparison.discountRate, 0.031);
  }
  // A free design with a benefit: an infinite BCR is saved as "no value", and the summary still reads back.
  const free = compareDesigns(levels, baseline, [{ id: 'A', name: 'Free', cost: { ...cost, capex: 0, low: 0, high: 0, om: 0 }, levels: [run(0), run(0)] }]);
  assert.equal(free.designs[0].bca!.central.bcr, Infinity);
  const fsum = comparisonSummary(free, 'stage', 60);
  assert.equal(fsum.designs[0].bcr, null);
  assert.ok(readProject({ format: PROJECT_FORMAT, version: PROJECT_VERSION, scene: { kind: 'preset', id: 'pittsburgh' }, scenario: { stageOffset: 0, sim: {} }, comparison: JSON.parse(JSON.stringify(fsum)) }).ok);
});

test('the benefit–cost rows never show a BCR without its range, and say which uncertainty is in it', async () => {
  const { bcaHead, bcaRows, bcaUncertaintyNote } = await import('../../src/ui/compareReport');
  const levels: CompareLevel[] = [
    { id: 'rp100', label: 'FEMA 1 %', returnPeriod: 100, rpFrom: 'source' },
    { id: 'record1936', label: '1936 crest', returnPeriod: 500, rpFrom: 'user' },
  ];
  const cost = { type: 'floodwall' as const, capex: 2e6, low: 1e6, high: 3e6, om: 0, lengthM: 200, meanHeightM: 3, basis: 'segments' as const, terrainNotCosted: false };
  const designs = [
    { id: 'A', name: 'Wall', cost, levels: [run(0), run(30e6)] },
    { id: 'B', name: 'Free', cost: { ...cost, capex: 0, low: 0, high: 0, basis: 'override' as const, years: 30, yearsFrom: 'user' as const }, levels: [run(0), run(30e6)] },
  ];
  const plain = compareDesigns(levels, [run(10e6), run(100e6)], designs);
  assert.deepEqual(bcaHead(plain), ['', 'Wall', 'Free']);
  const rows = bcaRows(plain);
  const row = (label: string) => rows.find((r) => r[0].startsWith(label))!;
  assert.match(row('BCR range')[1], /^\d+\.\d\d – \d+\.\d\d$/);
  assert.equal(row('BCR (central)')[2], '∞', 'a benefit at no cost');
  assert.equal(row('BCR · construction cost')[2], 'your figure (no band)');
  assert.equal(row('Useful life')[1], '50 yr (FEMA standard)');
  assert.equal(row('Useful life')[2], '30 yr (your input; outside FEMA’s 35–50 yr)');
  assert.ok(!rows.some((r) => r[0].includes('ensemble')), 'no ensemble row when none has run');
  const note = bcaUncertaintyNote(plain);
  assert.match(note, /At 7 % real/);
  assert.match(note, /damage curves ±1σ/);
  assert.match(note, /No flood-probability ensemble has run/);
  assert.match(note, /Never included: the return periods themselves/);
  const withEns = compareDesigns(levels, [run(10e6), run(100e6)], designs, { rate: 0.031, ensemble: { p10: 0.6, p90: 1.5, members: 12 } });
  assert.ok(bcaRows(withEns).some((r) => r[0] === 'BCR · ensemble p10 / p50 / p90 (12 members)'));
  assert.match(bcaUncertaintyNote(withEns), /At 3\.1 % real.*the ensemble’s loss p10–p90.*×0\.60, ×1\.50/s);
});

test('the facts a narrated story quotes are the benefit–cost block’s own figures, for the first design', async () => {
  const { bcaFact, bcaRows } = await import('../../src/ui/compareReport');
  const levels: CompareLevel[] = [
    { id: 'rp100', label: 'FEMA 1 %', returnPeriod: 100, rpFrom: 'source' },
    { id: 'record1936', label: '1936 crest', returnPeriod: 500, rpFrom: 'user' },
  ];
  const cost = { type: 'floodwall' as const, capex: 2e6, low: 1e6, high: 3e6, om: 0, lengthM: 200, meanHeightM: 3, basis: 'segments' as const, terrainNotCosted: false };
  const c = compareDesigns(levels, [run(10e6), run(100e6)], [{ id: 'A', name: 'Wall', cost, levels: [run(0), run(30e6)] }]);
  const rows = bcaRows(c);
  const row = (label: string) => rows.find((r) => r[0].startsWith(label))![1];
  assert.equal(bcaFact(c, 'design'), 'Wall');
  assert.equal(bcaFact(c, 'bcr'), row('BCR (central)'));
  assert.equal(bcaFact(c, 'range'), row('BCR range'));
  assert.equal(bcaFact(c, 'verdict'), row('Verdict'));
  assert.equal(`${bcaFact(c, 'breakeven')} `, row('Break-even construction cost').split('(')[0]);
  assert.equal(bcaFact(c, 'rate'), '7 %');
  assert.equal(bcaFact(c, 'life'), '50 yr (FEMA standard)');
  assert.match(bcaFact(c, 'deltaeal')!, /^\$[\d.]+\s?[kMB]? a year \(\$.+\)$/);
  assert.match(bcaFact(c, 'cost')!, /^\$2\.0\sM \(unit-cost estimate, \$1\.0\sM\s–\s\$3\.0\sM\)$/);
  assert.equal(bcaFact(c, 'levels'), 'FEMA 1 % (100 yr) and 1936 crest (500 yr, your input)');
  // No return period: no benefit–cost facts, and nothing invented.
  const none = compareDesigns([{ id: 'x', label: 'X', returnPeriod: null, rpFrom: null }], [run(5e6)], [{ id: 'A', name: 'A', cost, levels: [run(1e6)] }]);
  assert.equal(bcaFact(none, 'bcr'), null);
  assert.equal(bcaFact(none, 'design'), 'A');
});

test('resolveCost: the useful life is the user’s, else FEMA’s standard value for the type', () => {
  const edits = [{ op: 'wall' as const, pts: [0, 0, 100, 0], h: 2, r: 1 }];
  const fema = resolveCost({ type: 'earthen', capexUsd: null, omUsdPerYear: null, lengthM: null, heightM: null }, edits, 8, 'US');
  assert.equal(fema.years, 50);
  assert.equal(fema.yearsFrom, 'fema');
  const mine = resolveCost({ type: 'earthen', capexUsd: null, omUsdPerYear: null, lengthM: null, heightM: null, usefulLifeYears: 75 }, edits, 8, 'US');
  assert.equal(mine.years, 75);
  assert.equal(mine.yearsFrom, 'user');
});
