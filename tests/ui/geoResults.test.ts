/**
 * Geocoder answers are untrusted JSON (FINDINGS.json SEC-09 and SEC-01).
 *
 * Nominatim's search results become clickable buttons in the location picker, and clicking one hands its coordinates
 * straight to Leaflet and then to the live loader. A result with `lat: "n/a"` used to render as a button that threw
 * "Invalid LatLng object: (NaN, NaN)" out of Leaflet on click — surfacing as the red "Something went wrong" toast, with
 * a NaN selection left behind. A 5,000-entry answer to a `limit=5` request used to render 5,000 buttons.
 *
 * Run: node --import tsx --test tests/ui/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_GEO_RESULTS, geoChoices, isLatLon } from '../../src/ui/geoResults';

const result = (patch: Record<string, unknown> = {}) => ({
  display_name: 'Pittsburgh, Allegheny County, Pennsylvania, United States',
  lat: '40.4406',
  lon: '-79.9959',
  ...patch,
});

test('isLatLon accepts real positions and rejects everything Leaflet would throw on', () => {
  assert.ok(isLatLon(40.4406, -79.9959));
  assert.ok(isLatLon(0, 0));
  assert.ok(isLatLon(-90, 180), 'the corners of the range are valid');
  assert.ok(isLatLon(90, -180));
  for (const [lat, lon] of [
    [NaN, -80],
    [40, NaN],
    [Infinity, -80],
    [40, -Infinity],
    [91, 0],
    [-91, 0],
    [0, 181],
    [0, -181],
  ] as Array<[number, number]>) {
    assert.ok(!isLatLon(lat, lon), `accepted ${lat},${lon}`);
  }
});

test('a well-formed answer becomes a choice with a split, cleaned label', () => {
  const [c] = geoChoices([result()]);
  assert.equal(c.lat, 40.4406);
  assert.equal(c.lon, -79.9959);
  assert.equal(c.first, 'Pittsburgh');
  assert.deepEqual(c.rest, ['Allegheny County', 'Pennsylvania', 'United States']);
  // Nominatim sends lat/lon as strings; numbers must work too.
  const [n] = geoChoices([result({ lat: 40.4406, lon: -79.9959 })]);
  assert.equal(n.lat, 40.4406);
});

test('entries without a usable position are dropped, not rendered as broken buttons', () => {
  const list = [
    result({ lat: 'n/a' }),
    result({ lat: '' }),
    result({ lon: null }),
    result({ lat: undefined, lon: undefined }),
    result({ lat: '1e999' }), // JSON.parse turns 1e999 into Infinity
    result({ lat: '91.5' }),
    result({ lon: '-400' }),
    result({ lat: {}, lon: [] }),
    result(), // the only good one
  ];
  const choices = geoChoices(list);
  assert.equal(choices.length, 1, `kept ${choices.length}: ${JSON.stringify(choices.map((c) => [c.lat, c.lon]))}`);
  for (const c of choices) assert.ok(isLatLon(c.lat, c.lon));
});

test('non-objects, missing display_name and unusable labels are dropped', () => {
  const choices = geoChoices([
    null,
    undefined,
    42,
    'a string',
    [],
    {},
    result({ display_name: undefined }),
    result({ display_name: 42 }),
    result({ display_name: '' }),
    result({ display_name: '​‮' }), // cleans away to nothing
    result(),
  ]);
  assert.equal(choices.length, 1);
  assert.equal(choices[0].first, 'Pittsburgh');
});

test('the answer is capped at the limit the request asked for', () => {
  const many = Array.from({ length: 5000 }, (_, i) => result({ display_name: `Place ${i}, Pennsylvania` }));
  const t0 = performance.now();
  const choices = geoChoices(many);
  assert.equal(choices.length, MAX_GEO_RESULTS);
  assert.equal(MAX_GEO_RESULTS, 5, 'the picker requests limit=5');
  // It stops at the cap instead of cleaning all 5,000 labels first.
  assert.ok(performance.now() - t0 < 100, 'capping happens while scanning, not after');
  assert.equal(geoChoices(many, 2).length, 2);
  assert.equal(geoChoices(many, 0).length, 0);
});

test('a hostile display_name cannot write a message into the results list', () => {
  const spoof = 'EVACUATE NOW: levee failed. Call 555-0100';
  const [c] = geoChoices([result({ display_name: `${spoof}, Pennsylvania` })]);
  // This label IS shown (it is a search result the user typed towards, not the app's own chrome), but it is cleaned:
  // capped, and stripped of the bidi and zero-width characters that let text be reordered or hidden.
  assert.ok([...c.first].length <= 48, `${[...c.first].length} code points`);
  const [b] = geoChoices([result({ display_name: 'Pitts‮burgh​, PA' })]);
  assert.equal(b.first, 'Pittsburgh');
  assert.ok(!b.first.includes('‮') && !b.first.includes('​'));
  // A 200 kB name is capped rather than laid out.
  const [long] = geoChoices([result({ display_name: 'A'.repeat(200_000) })]);
  assert.ok([...long.first].length <= 48);
  // Empty parts (", , ,") do not become blank lines in the secondary text.
  const [sparse] = geoChoices([result({ display_name: 'Erie, , ​, Pennsylvania' })]);
  assert.deepEqual(sparse.rest, ['Pennsylvania']);
});

test('anything that is not an array yields no choices', () => {
  for (const v of [null, undefined, {}, 'nope', 42, { results: [result()] }]) {
    assert.deepEqual(geoChoices(v), [], JSON.stringify(v));
  }
});
