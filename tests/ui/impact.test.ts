/**
 * The Impact panel's pure parts: before/after comparison and BCR view (src/ui/impactCompare.ts), money formatting,
 * export file names, and the methods text staying in step with the constants it quotes.
 * Run: node --import tsx --test tests/ui/impact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DAMAGE_MIN_DEPTH, DISCOUNT_RATE_FEMA, upv, type ImpactSummary } from '../../src/loss';
import { safeFilename } from '../../src/ui/download';
import { formatMoney, leadVsWarningText, warningIssuedText } from '../../src/ui/format';
import { bcrView, compareRuns, type RunSignature, type RunSnapshot } from '../../src/ui/impactCompare';
import { CITATIONS, METHOD_NOTES } from '../../src/ui/impactMethods';

const sig = (patch: Partial<RunSignature> = {}): RunSignature => ({
  terrainName: 'Pittsburgh',
  presetId: 'pittsburgh',
  simTime: 1800,
  stageOffset: 9,
  rainRate: 0,
  forcing: 's:a:1',
  wallCells: 0,
  ...patch,
});

const summary = (loss: number): ImpactSummary => ({
  simTime: 1800,
  buildings: 10,
  assessed: 10,
  reached: 0,
  damaged: 0,
  partial: 0,
  destroyed: 0,
  exposedValue: 1e9,
  loss,
  lossLo: loss * 0.7,
  lossHi: loss * 1.3,
  lossStructure: loss / 2,
  lossContents: loss / 2,
  aidr: [0, 0, 0, 0, 0, 0, 0],
  hr: { low: 0, moderate: 0, significant: 0, extreme: 0 },
  accessCut: 0,
  earliest: null,
  byOccupancy: {},
  velocityKnown: true,
  debrisFlow: false,
  heightEstimated: 0,
  occupancyGuessed: 0,
});

const snap = (s: RunSignature, loss: number, b: Array<[number, number, number]>): RunSnapshot => ({
  sig: s,
  summary: summary(loss),
  buildings: new Map(b.map(([k, l, d]) => [k, { loss: l, depth: d }])),
});

test('compareRuns: avoided loss, buildings saved, and water pushed elsewhere counted on its own', () => {
  const before = snap(sig(), 100e6, [
    [1, 60e6, 2],
    [2, 40e6, 1],
  ]);
  const after = snap(sig({ wallCells: 500 }), 30e6, [
    [2, 25e6, 0.8],
    [3, 5e6, 0.5], // newly wet: behind the wall's end
  ]);
  const c = compareRuns(before, after);
  assert.equal(c.avoided, 70e6);
  assert.ok(Math.abs(c.avoidedLo - 49e6) < 1 && Math.abs(c.avoidedHi - 91e6) < 1);
  assert.equal(c.noLongerReached, 1);
  assert.equal(c.newlyReached, 1);
  assert.equal(c.newlyReachedLoss, 5e6);
  assert.equal(c.worse, 1);
  assert.deepEqual(c.warnings, []);
});

test('compareRuns warns when the runs are not like for like', () => {
  const c = compareRuns(snap(sig(), 1, []), snap(sig({ simTime: 3600, stageOffset: 4, rainRate: 50, forcing: 'x', terrainName: 'Houston' }), 1, []));
  assert.equal(c.warnings.length, 6);
});

test('bcrView: single-event BCR = (ΔL / T) × UPV / cost, with a cost and benefit range, and the break-even T', () => {
  const c = compareRuns(snap(sig(), 100e6, []), snap(sig({ wallCells: 10 }), 30e6, []));
  const v = bcrView(c, { type: 'floodwall', lengthM: 1000, heightM: 2, country: 'US', returnPeriod: 100 });
  const cost = 6000 * Math.pow(2, 1.3) * 1000;
  assert.ok(Math.abs(v.cost.mid - cost) < 1e-6);
  const expected = ((70e6 / 100) * upv(DISCOUNT_RATE_FEMA, 50)) / cost;
  assert.ok(Math.abs(v.bcr7 - expected) < 1e-9);
  assert.ok(v.bcr7Range[0] < v.bcr7 && v.bcr7 < v.bcr7Range[1]);
  assert.ok(v.bcr3 > v.bcr7);
  assert.ok(Math.abs(v.breakEvenT - (70e6 * upv(DISCOUNT_RATE_FEMA, 50)) / cost) < 1e-6);
  const noT = bcrView(c, { type: 'earthen', lengthM: 1000, heightM: 2, country: 'NP', returnPeriod: null });
  assert.ok(Number.isNaN(noT.bcr7));
  assert.ok(Number.isFinite(noT.breakEvenT));
});

test('money: rounded, unknown is a dash, other currencies are named', () => {
  const money = (v: number | null, c?: string) => formatMoney(v, c).replace(/ /g, ' ');
  assert.equal(money(5.5e9), '$5.5 B');
  assert.equal(money(399e6), '$399 M');
  assert.equal(money(12.4e6), '$12.4 M');
  assert.equal(money(466e3), '$466 k');
  assert.equal(money(1234), '$1,230');
  assert.equal(money(-2e6), '−$2.0 M');
  assert.equal(money(NaN), '—');
  assert.equal(money(null), '—');
  assert.equal(money(3e6, 'EUR'), '3.0 M EUR');
  // Unit boundaries: a value that ROUNDS up to the next unit is written in it ("$1.0 M", never "$1,000 k").
  assert.equal(money(999_400), '$999 k');
  assert.equal(money(999_600), '$1.0 M');
  assert.equal(money(9_996), '$10 k');
  assert.equal(money(99.96e6), '$100 M');
  assert.equal(money(999.4e6), '$999 M');
  assert.equal(money(999.6e6), '$1.0 B');
  assert.equal(money(99.96e9), '$100 B');
  assert.equal(money(-999_600), '−$1.0 M');
});

test('warning wording: no alert set (≤ 0) is never "issued at T+00:00:00"; panel and report share the rule', () => {
  assert.doesNotMatch(warningIssuedText(0), /T\+/);
  assert.match(warningIssuedText(0), /not set/);
  assert.doesNotMatch(warningIssuedText(-60), /T\+/);
  assert.equal(warningIssuedText(900), 'T+00:15:00');
  assert.equal(leadVsWarningText(600, 0), 'after the scenario started');
  assert.match(leadVsWarningText(600, 300), /after the warning$/);
  assert.match(leadVsWarningText(-120, 300), /before the warning$/);
});

test('export file names are tame', () => {
  assert.equal(safeFilename('deluge-impact-pittsburgh-T30min.csv'), 'deluge-impact-pittsburgh-T30min.csv');
  assert.equal(safeFilename('../../etc/passwd'), 'etc-passwd');
  assert.equal(safeFilename('‮evil<>:"|?*.csv'), 'evil-.csv');
  assert.equal(safeFilename(''), 'deluge-export');
});

test('the methods text quotes the constants it describes and every source has a title', () => {
  const all = METHOD_NOTES.map((n) => n.text).join(' ');
  assert.ok(all.includes(`${DAMAGE_MIN_DEPTH} m`));
  assert.ok(all.includes('7 %'));
  assert.ok(METHOD_NOTES.every((n) => n.title && n.text.length > 80));
  assert.ok(CITATIONS.some((c) => /JRC105688/.test(c.url ?? '')));
});
