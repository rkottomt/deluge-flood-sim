/// <reference types="node" />
/**
 * The baked National Inventory of Dams index (public/dams/nid-index.bin, src/dams/nidIndex.ts): the real file decodes
 * to the dams it should hold, search finds them, and the decoder refuses or drops anything malformed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cleanDamName, damById, decodeNidIndex, encodeNidIndex, isDryDam, NID_RECORD_BYTES, searchDams, type NidDam } from '../../src/dams/nidIndex';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILE = path.join(ROOT, 'public', 'dams', 'nid-index.bin');

const real = (() => {
  const gz = fs.readFileSync(FILE);
  return { gz, index: decodeNidIndex(zlib.gunzipSync(gz)) };
})();

function dam(over: Partial<NidDam> = {}): NidDam {
  return {
    id: 'TX00001',
    name: 'Bardwell Dam',
    state: 'TX',
    lat: 32.25097,
    lon: -96.64137,
    heightM: 25,
    hydraulicHeightM: 23.8,
    storageAcFt: 317483,
    normalStorageAcFt: 54866,
    surfaceAreaAc: 3570,
    maxDischargeCfs: 102944,
    lengthFt: 15400,
    year: 1965,
    hazard: 'High',
    owner: 'Federal',
    damType: 'Earth',
    ...over,
  };
}

test('the baked index: ~55,000 dams, small on the wire, every record valid', () => {
  const { gz, index } = real;
  assert.ok(gz.length < 3 * 1024 * 1024, `${(gz.length / 1048576).toFixed(2)} MB gzip (budget 3 MB)`);
  assert.ok(index.dams.length > 50_000 && index.dams.length < 70_000, `${index.dams.length} dams`);
  assert.ok(index.dropped < 10, `${index.dropped} dropped`);
  const high = index.dams.filter((d) => d.hazard === 'High').length;
  assert.ok(high > 12_000, `${high} high-hazard dams`);
  // Every kept dam passes the bake's size rule.
  for (const d of index.dams) assert.ok(d.storageAcFt >= 1000 || (d.heightM >= 5.99 && d.storageAcFt >= 50), `${d.id} is under the threshold`);
});

test('the baked index holds the dams it should, with their NID numbers', () => {
  const oro = damById(real.index, 'CA00035');
  assert.ok(oro, 'Oroville Dam');
  assert.equal(oro.name, 'Oroville Dam');
  assert.equal(oro.state, 'CA');
  assert.ok(Math.abs(oro.heightM - 770 * 0.3048) < 0.1, `height ${oro.heightM}`);
  assert.equal(oro.storageAcFt, 3_540_000);
  assert.equal(oro.hazard, 'High');
  assert.equal(oro.damType, 'Earth');
  const eden = damById(real.index, 'MI00549');
  assert.ok(eden && eden.name === 'Edenville Dam' && eden.maxDischargeCfs === 21070 && eden.normalStorageAcFt === 36000);
});

test('the baked index keeps a reported normal storage of 0 (dry dams), apart from "not reported"', () => {
  // Red Rock Detention Dam, Las Vegas: a flood-control detention basin, NID normal storage 0 (October 2026 export).
  const red = damById(real.index, 'NV10406');
  assert.ok(red, 'Red Rock Detention Dam');
  assert.equal(red.normalStorageAcFt, 0);
  assert.ok(isDryDam(red));
  const dry = real.index.dams.filter(isDryDam).length;
  assert.ok(dry > 1000, `${dry} dry dams`);
  assert.ok(real.index.dams.some((d) => d.normalStorageAcFt === null), 'some dams still report no normal storage');
});

test('search: by name, by id, and near a point', () => {
  const byName = searchDams(real.index, { text: 'oroville' });
  assert.equal(byName[0].dam.id, 'CA00035');
  const byId = searchDams(real.index, { text: 'ca00035' });
  assert.equal(byId[0].dam.id, 'CA00035');
  const near = searchDams(real.index, { near: { lat: 43.8167, lon: -84.3883, radiusKm: 30 }, limit: 10 });
  assert.equal(near[0].dam.id, 'MI00549');
  assert.ok(near.every((r, i) => r.km !== null && r.km <= 30 && (i === 0 || r.km >= near[i - 1].km!)));
  assert.equal(searchDams(real.index, { text: 'zzzz-no-such-dam' }).length, 0);
  const high = searchDams(real.index, { text: 'lake', hazards: ['High'], limit: 50 });
  assert.ok(high.length === 50 && high.every((r) => r.dam.hazard === 'High'));
});

test('encode → decode round-trips every field', () => {
  const dams = [dam(), dam({ id: 'CA00035', name: 'Oroville Dam', hydraulicHeightM: null, normalStorageAcFt: null, surfaceAreaAc: null, maxDischargeCfs: null, lengthFt: null, year: null, hazard: 'Low', owner: 'State', damType: 'Arch', state: 'CA', lat: 39.5364, lon: -121.4834 })];
  const back = decodeNidIndex(encodeNidIndex(dams));
  assert.equal(back.dropped, 0);
  assert.equal(back.dams.length, 2);
  assert.deepEqual(back.dams[0], { ...dams[0], heightM: 25, hydraulicHeightM: 23.8 });
  const b = back.dams[1];
  assert.equal(b.hydraulicHeightM, null);
  assert.equal(b.normalStorageAcFt, null);
  assert.equal(b.year, null);
  assert.equal(b.damType, 'Arch');
  // 0 is a value (a dry dam), not "not reported".
  const z = decodeNidIndex(encodeNidIndex([dam({ normalStorageAcFt: 0 })])).dams[0];
  assert.equal(z.normalStorageAcFt, 0);
  assert.ok(isDryDam(z) && !isDryDam(b) && !isDryDam(back.dams[0]));
});

test('hostile index files: wrong magic, short, a lying header, too many records, broken names → refused', () => {
  const good = encodeNidIndex([dam(), dam({ id: 'TX00002' })]);
  const bad = (mut: (b: Uint8Array) => Uint8Array) => mut(good.slice());
  assert.throws(() => decodeNidIndex(bad((b) => ((b[0] = 0x58), b))), /not a Deluge dam index/);
  assert.throws(() => decodeNidIndex(good.subarray(0, 12)), /too short/);
  assert.throws(() => decodeNidIndex(bad((b) => b.subarray(0, b.length - 1))), /length does not match|name count/);
  assert.throws(() => decodeNidIndex(new Uint8Array([...good, 0x41])), /length does not match/);
  assert.throws(() => decodeNidIndex(bad((b) => (new DataView(b.buffer).setUint32(8, 4_000_000, true), b))), /record count/);
  assert.throws(() => decodeNidIndex(bad((b) => (new DataView(b.buffer).setUint32(16, 1, true), b))), /header flags/);
  // Names: invalid UTF-8, and a name count that does not match.
  const nameAt = 20 + 2 * NID_RECORD_BYTES;
  assert.throws(() => decodeNidIndex(bad((b) => ((b[nameAt] = 0xff), b))), /not UTF-8/);
  const twoInOne = encodeNidIndex([dam(), dam({ id: 'TX00002' })]);
  const nl = twoInOne.indexOf(0x0a, nameAt);
  twoInOne[nl] = 0x20;
  assert.throws(() => decodeNidIndex(twoInOne), /name count/);
  // A file far over the cap is refused before anything is read.
  assert.throws(() => decodeNidIndex(new Uint8Array(25 * 1024 * 1024)), /too large/);
});

test('hostile records are dropped, one at a time, never guessed', () => {
  const rows = [
    dam(),
    dam({ id: '<script>' }),
    dam({ id: 'TX00003', lat: 91 }),
    dam({ id: 'TX00004', lon: 10 }),
    dam({ id: 'TX00005', heightM: 0 }),
    dam({ id: 'TX00006', storageAcFt: 0 }),
    dam({ id: 'TX00007', name: '' }),
    dam({ id: 'TX00008', year: 3000 }),
  ];
  const back = decodeNidIndex(encodeNidIndex(rows));
  assert.deepEqual(back.dams.map((d) => d.id), ['TX00001']);
  assert.equal(back.dropped, rows.length - 1);
  // A hazard code past the table.
  const enc = encodeNidIndex([dam()]);
  const hz = 20 + (8 + 4 + 4 + 2 + 2 + 4 + 4 + 4 + 4 + 4 + 2);
  enc[hz] = 9;
  assert.equal(decodeNidIndex(enc).dams.length, 0);
});

test('names are cleaned: no controls, no bidi overrides, no markup, capped', () => {
  assert.equal(cleanDamName('Lake‮ enoD\u0007 <b>Dam</b>'), 'Lake enoD bDam/b');
  assert.equal(cleanDamName('x'.repeat(500)).length, 100);
  const back = decodeNidIndex(encodeNidIndex([dam({ name: 'Evil ⁦Dam⁩ <img src=x onerror=alert(1)>' })]));
  assert.doesNotMatch(back.dams[0].name, /[<>⁦⁩]/);
});
