/**
 * Portfolio CSV: parsing (src/loss/csv.ts), the asset schema (src/loss/portfolio.ts), footprint matching, assessment
 * and the export — including files written by spreadsheets and files written by an attacker.
 * Run: node --import tsx --test tests/loss/portfolio.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildingSet, HazardFields } from '../../src/contracts';
import { BUILDING_KINDS } from '../../src/data/buildings';
import { csvField, parseCsv, toCsv } from '../../src/loss/csv';
import { rasterizeFootprints } from '../../src/loss/footprints';
import {
  assessPortfolio,
  assessSite,
  matchAssets,
  parseNumber,
  parsePortfolio,
  parseWktPolygon,
  resultsCsv,
  RESULT_COLUMNS,
} from '../../src/loss/portfolio';
import { regionAt } from '../../src/loss/region';

test('RFC 4180: quotes, escaped quotes, delimiters and line breaks inside quotes', () => {
  const t = parseCsv('a,b,c\n"x, y","say ""hi""","line1\nline2"\n1,,3\n');
  assert.equal(t.error, null);
  assert.deepEqual(t.header, ['a', 'b', 'c']);
  assert.deepEqual(t.rows, [
    ['x, y', 'say "hi"', 'line1\nline2'],
    ['1', '', '3'],
  ]);
});

test('BOM, CRLF, CR-only, blank lines and a missing final newline', () => {
  const t = parseCsv('﻿asset_id,lat\r\nA,1\r\n\r\nB,2\rC,3');
  assert.deepEqual(t.header, ['asset_id', 'lat']);
  assert.deepEqual(t.rows, [
    ['A', '1'],
    ['B', '2'],
    ['C', '3'],
  ]);
});

test('semicolon- and tab-separated files are recognised from the header', () => {
  assert.equal(parseCsv('asset_id;lat;lon\nA;1;2').delimiter, ';');
  assert.deepEqual(parseCsv('asset_id;lat;lon\nA;1;2').rows[0], ['A', '1', '2']);
  assert.deepEqual(parseCsv('asset_id\tlat\nA\t1').rows[0], ['A', '1']);
});

test('broken and hostile files fail cleanly', () => {
  assert.match(parseCsv('a,b\n"open,1\n').error ?? '', /never closed/);
  assert.match(parseCsv('').error ?? '', /empty/);
  assert.match(parseCsv('a\u0000b').error ?? '', /binary/);
  assert.match(parseCsv('x'.repeat(100), { maxChars: 10, maxRows: 10, maxCols: 10, maxFieldChars: 10 }).error ?? '', /too large/);
  const many = parseCsv(`a\n${'1\n'.repeat(50)}`, { maxChars: 1e6, maxRows: 10, maxCols: 10, maxFieldChars: 100 });
  assert.equal(many.rows.length, 10);
  assert.equal(many.truncatedRows, 40);
  const long = parseCsv(`a\n${'z'.repeat(500)}`, { maxChars: 1e6, maxRows: 10, maxCols: 10, maxFieldChars: 100 });
  assert.equal(long.rows[0][0].length, 100);
  assert.ok(long.warnings.length > 0);
});

test('numbers: plain, signed, exponent, thousands commas; junk is NaN; empty is null', () => {
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber(' -3 '), -3);
  assert.equal(parseNumber('1e3'), 1000);
  assert.equal(parseNumber('1,250,000'), 1250000);
  assert.equal(parseNumber(''), null);
  assert.equal(parseNumber(undefined), null);
  for (const junk of ['12abc', '0x10', '1,2,3', 'Infinity', 'NaN', '=1+1', '$100']) assert.ok(Number.isNaN(parseNumber(junk)), junk);
});

test('WKT polygons', () => {
  assert.deepEqual(parseWktPolygon('POLYGON ((-80 40, -79.9 40, -79.9 40.1, -80 40))'), [-80, 40, -79.9, 40, -79.9, 40.1]);
  assert.deepEqual(parseWktPolygon('SRID=4326;MULTIPOLYGON (((1 2, 3 4, 5 6, 1 2)))'), [1, 2, 3, 4, 5, 6]);
  assert.equal(typeof parseWktPolygon('POINT (1 2)'), 'string');
  assert.equal(typeof parseWktPolygon('POLYGON ((1 2, 3 4))'), 'string');
  assert.equal(typeof parseWktPolygon('POLYGON ((1 2, 3 400, 5 6))'), 'string');
});

test('the portfolio schema: aliases, required columns, per-row validation, warnings', () => {
  const missing = parsePortfolio('name,lat\nA,1');
  assert.match(missing.fatal ?? '', /asset_id/);
  assert.match(missing.fatal ?? '', /lon/);
  const p = parsePortfolio(
    [
      'ID,Name,Latitude,Longitude,occupancy,replacement_value,currency,gross_margin,daily_revenue,basement,construction,Extra',
      'W1,Warehouse,40.4,-80.0,warehouse,"58,000,000",usd,35,100000,yes,steel,x',
      'W2,No position,,,office,,,,,,,',
      ',Nameless,40.4,-80,,,,,,,,',
      'W3,Odd values,95,-80,spaceship,abc,dollars,,,maybe,adobe,',
      'W1,Duplicate,40.41,-80.01,,,,,,,,',
    ].join('\n'),
  );
  assert.equal(p.fatal, null);
  assert.deepEqual(p.ignoredColumns, ['extra']);
  assert.equal(p.assets.length, 2);
  const w1 = p.assets[0];
  assert.equal(w1.id, 'W1');
  assert.equal(w1.replacementValue, 58e6);
  assert.equal(w1.currency, 'USD');
  assert.equal(w1.grossMargin, 0.35);
  assert.equal(w1.basement, true);
  assert.equal(w1.construction, 'steel');
  assert.equal(w1.occupancy, 'warehouse');
  assert.equal(p.errors.length, 3); // no position; empty id; lat out of range (and no wkt)
  assert.ok(p.warnings.some((w) => /more than once/.test(w.message)));
  assert.ok(p.warnings.some((w) => /percentage/.test(w.message)));
});

test('hostile strings are cleaned before they can reach the screen', () => {
  const evil = [
    'asset_id,name,lat,lon,tags',
    `"<img src=x onerror=alert(1)>","‮evil‬ name\u0007 with bell","40.4","-80","=HYPERLINK(""http://x"")"`,
    `"${'A'.repeat(500)}","${'B'.repeat(500)}",40.4,-80,`,
  ].join('\n');
  const p = parsePortfolio(evil);
  assert.equal(p.assets.length, 2);
  const a = p.assets[0];
  // Markup stays text (the UI writes it with textContent); control and bidi characters are gone.
  assert.equal(a.id, '<img src=x onerror=alert(1)>');
  assert.ok(!/[‪-‮⁦-⁩\u0000-\u001F]/.test(a.name));
  assert.equal(a.name, 'evil name with bell');
  assert.ok([...p.assets[1].id].length <= 64);
  assert.ok([...p.assets[1].name].length <= 80);
  // Re-exported, a formula is defused.
  assert.equal(csvField('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(csvField('+1'), "'+1");
  assert.equal(csvField('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvField(-5), '-5'); // numbers are numbers
  assert.equal(csvField(NaN), '');
  assert.equal(toCsv(['a', 'b'], [['x,y', 'q"']]), 'a,b\r\n"x,y","q"""\r\n');
});

// ─── Matching and assessment on a toy grid ───────────────────────────────────────────────────────────────────────────

const NX = 64;
const NY = 64;
const CELL = 5;
const terrain = { nx: NX, ny: NY, cellSize: CELL };
/** A linear lon/lat ↔ grid map for the toy domain: 0.0001° per cell. */
const toGrid = (lon: number, lat: number): [number, number] => [(lon + 80) / 0.0001, (40.01 - lat) / 0.0001];

function set(): BuildingSet {
  const rects: Array<[number, number, number, number]> = [
    [10, 10, 20, 14],
    [40, 40, 44, 44],
  ];
  const verts: number[] = [];
  const offsets = new Uint32Array(rects.length + 1);
  rects.forEach(([x0, y0, x1, y1], k) => {
    offsets[k] = verts.length / 2;
    verts.push(x0, y0, x1, y0, x1, y1, x0, y1);
  });
  offsets[rects.length] = verts.length / 2;
  return {
    count: 2,
    offsets,
    verts: Float32Array.from(verts),
    base: new Float32Array(2),
    height: Float32Array.from([9, 6]),
    heightSource: new Uint8Array(2),
    kind: Uint8Array.from([BUILDING_KINDS.indexOf('industrial'), BUILDING_KINDS.indexOf('house')]),
    names: [undefined, undefined],
    heightRaster: null,
    attribution: '',
  };
}

test('matching: inside a footprint, nearest within 30 m, a bare point, outside the map, a WKT polygon', () => {
  const B = set();
  const fp = rasterizeFootprints(B, NX, NY, CELL);
  const p = parsePortfolio(
    [
      'asset_id,lat,lon,wkt',
      'in,40.0088,-79.9985,', // grid (15, 12): inside building 0
      'near,40.0094,-79.9985,', // (15, 6): 4 cells = 20 m north of building 0
      'far,40.0070,-79.9970,', // (30, 30): nothing within 30 m
      'off,41,-79,', // outside the domain
      'poly,,,"POLYGON ((-79.995 40.005, -79.994 40.005, -79.994 40.004, -79.995 40.004, -79.995 40.005))"',
    ].join('\n'),
  );
  assert.equal(p.assets.length, 5);
  const m = matchAssets(p.assets, B, fp, terrain, toGrid);
  assert.deepEqual(
    m.map((x) => [x.asset.id, x.match, x.building]),
    [
      ['in', 'inside', 0],
      ['near', 'nearest', 0],
      ['far', 'point', -1],
      ['off', 'outside', -1],
      ['poly', 'wkt', -1],
    ],
  );
  assert.ok(Math.abs(m[1].distanceM - 20) < 1e-3);
  assert.equal(m[2].cells.length, 1);
  assert.equal(m[4].cells.length, 100);
});

test('one site (due diligence): a planned parcel or point is assessed like a CSV row, footprints ignored by default', () => {
  const B = set();
  const fp = rasterizeFootprints(B, NX, NY, CELL);
  const n = NX * NY;
  const f: HazardFields = {
    nx: NX,
    ny: NY,
    simTime: 3600,
    maxDepth: new Float32Array(n).fill(0.8),
    maxSpeed: new Float32Array(n).fill(0.3),
    maxDV: new Float32Array(n).fill(0.24),
    firstWet: new Float32Array(n).fill(1200),
    wetSeconds: new Float32Array(n).fill(600),
  };
  const ctx = { region: regionAt(-80, 40), set: B, fp, grid: terrain, toGrid, alertTime: 600 };
  const parcel = assessSite({ id: 'P1', name: 'Parcel 7', gridRing: [30, 30, 40, 30, 40, 40, 30, 40], occupancy: 'apt', floors: 4, gfaM2: 4 * 2500 }, f, ctx)!;
  assert.equal(parcel.m.match, 'wkt');
  assert.equal(parcel.m.cells.length, 100);
  assert.equal(parcel.valueSource, 'unit-cost');
  assert.equal(parcel.valueStructure, 4 * 2500 * 2000);
  assert.equal(parcel.leadTime, 600);
  assert.ok(parcel.loss > 0);
  // A point on an existing building: not matched unless asked.
  const pt = assessSite({ gx: 15, gy: 12, occupancy: 'office', replacementValue: 1e6 }, f, ctx)!;
  assert.equal(pt.m.match, 'point');
  const matched = assessSite({ gx: 15, gy: 12, matchFootprint: true }, f, ctx)!;
  assert.equal(matched.m.match, 'inside');
  assert.equal(matched.occ, 'industrial');
  assert.equal(assessSite({ gx: -5, gy: 3 }, f, ctx), null); // outside the map
});

test('assessment: given values win, foreign currencies stay out of the USD totals, BI and insured loss', () => {
  const B = set();
  const fp = rasterizeFootprints(B, NX, NY, CELL);
  const n = NX * NY;
  const f: HazardFields = {
    nx: NX,
    ny: NY,
    simTime: 7200,
    maxDepth: new Float32Array(n).fill(1),
    maxSpeed: new Float32Array(n).fill(0.5),
    maxDV: new Float32Array(n).fill(0.5),
    firstWet: new Float32Array(n).fill(900),
    wetSeconds: new Float32Array(n).fill(3600),
  };
  const p = parsePortfolio(
    [
      'asset_id,lat,lon,replacement_value,contents_value,daily_revenue,gross_margin,deductible,limit,currency,critical_elev_m,first_floor_height_m',
      'dc,40.0088,-79.9985,10000000,5000000,200000,0.5,1000000,4000000,USD,1.5,0.3',
      'eu,40.0088,-79.9985,10000000,,,,,,EUR,,',
      'est,40.0088,-79.9985,,,,,,,,,',
    ].join('\n'),
  );
  const m = matchAssets(p.assets, B, fp, terrain, toGrid);
  const { results, summary } = assessPortfolio(m, f, { region: regionAt(-80, 40), set: B, fp, alertTime: 0 });
  const dc = results[0];
  assert.ok(Math.abs(dc.depthAboveFloor - 0.7) < 1e-6);
  assert.equal(dc.criticalWet, false);
  assert.ok(dc.biLoss > 0);
  assert.ok(dc.insuredLoss <= 4e6 && dc.insuredLoss >= 0);
  assert.equal(results[1].currency, 'EUR');
  assert.equal(results[2].valueSource, 'unit-cost');
  assert.equal(results[2].occ, 'industrial');
  assert.equal(summary.otherCurrency, 1);
  assert.ok(Math.abs(summary.loss - (results[0].loss + results[2].loss)) < 1e-6);
  assert.equal(summary.earliest?.firstWet, 900);
  const csv = resultsCsv(
    results.map((r) => ({
      id: r.m.asset.id,
      name: r.m.asset.name,
      source: 'portfolio' as const,
      occ: r.occ,
      match: r.m.match,
      matchDistanceM: r.m.distanceM,
      r,
      valueStructure: r.valueStructure,
      valueContents: r.valueContents,
      valueSource: r.valueSource,
      currency: r.currency,
    })),
  );
  const back = parseCsv(csv);
  assert.deepEqual(back.header, [...RESULT_COLUMNS]);
  assert.equal(back.rows.length, 3);
  assert.equal(back.rows[0][0], 'dc');
});

test('decimal-comma files (; or tab delimited): commas are decimal marks, never thousands separators', () => {
  // Comma files keep the thousands-comma reading.
  assert.equal(parseNumber('2,500'), 2500);
  assert.equal(parseNumber('2,500', ','), 2500);
  // A ';' or tab file is a decimal-comma locale's: '2,500' is two and a half.
  for (const d of [';', '\t'] as const) {
    assert.equal(parseNumber('2,500', d), 2.5);
    assert.equal(parseNumber('-0,75', d), -0.75);
    assert.equal(parseNumber('1.250.000,5', d), 1250000.5, 'dots group thousands when a decimal comma is there');
    assert.equal(parseNumber('12.5', d), 12.5, 'a lone decimal point still reads as one');
    assert.equal(parseNumber('3', d), 3);
    for (const junk of ['1,2,3', '1.2,3.4', '12abc', '$100']) assert.ok(Number.isNaN(parseNumber(junk, d)), `${junk} with ${JSON.stringify(d)}`);
  }
  const p = parsePortfolio(['asset_id;lat;lon;replacement_value;first_floor_height_m', 'A;40,0088;-79,9985;2,500;0,3', 'B;40.0088;-79.9985;1.250.000,5;'].join('\n'));
  assert.deepEqual(p.warnings, []);
  assert.equal(p.assets[0].lat, 40.0088);
  assert.equal(p.assets[0].lon, -79.9985);
  assert.equal(p.assets[0].replacementValue, 2.5);
  assert.equal(p.assets[0].firstFloorHeight, 0.3);
  assert.equal(p.assets[1].replacementValue, 1250000.5);
});

test('totals: unknown (NaN, shown "—") when no asset was valued, not $0', () => {
  const B = set();
  const fp = rasterizeFootprints(B, NX, NY, CELL);
  const n = NX * NY;
  const f: HazardFields = {
    nx: NX,
    ny: NY,
    simTime: 7200,
    maxDepth: new Float32Array(n).fill(1),
    maxSpeed: new Float32Array(n).fill(0.5),
    maxDV: new Float32Array(n).fill(0.5),
    firstWet: new Float32Array(n).fill(900),
    wetSeconds: new Float32Array(n).fill(3600),
  };
  const ctx = { region: regionAt(-80, 40), set: B, fp, alertTime: 0 };
  // Every asset off the map: nothing assessed.
  const off = parsePortfolio(['asset_id,lat,lon', 'x,41,-79', 'y,42,-78'].join('\n'));
  const s1 = assessPortfolio(matchAssets(off.assets, B, fp, terrain, toGrid), f, ctx).summary;
  assert.equal(s1.outside, 2);
  for (const k of ['loss', 'lossLo', 'lossHi', 'bi', 'insured'] as const) assert.ok(Number.isNaN(s1[k]), `${k} with nothing assessed`);
  // Only assets in another currency: none of them enters the USD totals.
  const eur = parsePortfolio(['asset_id,lat,lon,replacement_value,currency', 'e,40.0088,-79.9985,1000000,EUR'].join('\n'));
  const s2 = assessPortfolio(matchAssets(eur.assets, B, fp, terrain, toGrid), f, ctx).summary;
  assert.equal(s2.otherCurrency, 1);
  assert.ok(Number.isNaN(s2.loss));
  // A valued asset that stays dry is a real $0; BI and insured loss stay unknown without revenue / policy terms.
  const dry: HazardFields = { ...f, maxDepth: new Float32Array(n), firstWet: new Float32Array(n).fill(-1), wetSeconds: new Float32Array(n) };
  const usd = parsePortfolio(['asset_id,lat,lon,replacement_value', 'u,40.0088,-79.9985,1000000'].join('\n'));
  const s3 = assessPortfolio(matchAssets(usd.assets, B, fp, terrain, toGrid), dry, ctx).summary;
  assert.equal(s3.loss, 0);
  assert.ok(Number.isNaN(s3.bi) && Number.isNaN(s3.insured));
});

test('ensemble tallies follow each asset, not its position, when assessPortfolio drops an off-map asset', async () => {
  const { addPortfolioMember, newTally, tallySentence } = await import('../../src/loss/ensemble');
  const B = set();
  const fp = rasterizeFootprints(B, NX, NY, CELL);
  const n = NX * NY;
  // Deep water over the east building only (grid x ≥ 32): 'east' floods, 'west' stays dry.
  const maxDepth = new Float32Array(n);
  for (let j = 0; j < NY; j++) for (let i = 32; i < NX; i++) maxDepth[j * NX + i] = 1.2;
  const f: HazardFields = { nx: NX, ny: NY, simTime: 3600, maxDepth, maxSpeed: new Float32Array(n), maxDV: new Float32Array(n), firstWet: new Float32Array(n).fill(600), wetSeconds: new Float32Array(n) };
  const p = parsePortfolio(['asset_id,lat,lon', 'west,40.0088,-79.9985', 'off,41,-79', 'east,40.0068,-79.9958'].join('\n'));
  const { results } = assessPortfolio(matchAssets(p.assets, B, fp, terrain, toGrid), f, { region: regionAt(-80, 40), set: B, fp });
  assert.equal(results.length, 2, 'the off-map asset has no result');
  const tallies = p.assets.map((a) => newTally(a.id, a.name || a.id));
  addPortfolioMember(tallies, p.assets, results);
  addPortfolioMember(tallies, p.assets, results);
  const [west, off, east] = tallies;
  assert.deepEqual([west.reached, off.reached, east.reached], [0, 0, 2]);
  assert.match(tallySentence(west), /stays at or below 15 cm in all 2 members/);
  assert.equal(tallySentence(off), 'is outside the map (not assessed)', 'off the map, not dry');
  assert.match(tallySentence(east), /floods \(> 15 cm\) in all 2 members/);
});
