/// <reference types="node" />
/**
 * Infrastructure dependencies: the OSM facility parser and the baked files (src/data/facilities.ts), exposure and
 * status by type (src/loss/infra.ts), and what a site depends on (src/loss/infraDeps.ts) on a synthetic street.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { HazardFields, RoadNetwork } from '../../src/contracts';
import { classifyFacility, decodeFacilities, encodeFacilities, FACILITY_KINDS, overpassFacilitiesQuery, parseOverpassFacilities, type Facility, type OverpassElement } from '../../src/data/facilities';
import { assessFacilities, FACILITY_THRESHOLDS, sortExposures, summarizeInfra } from '../../src/loss/infra';
import { downtimeWithDependencies, reachLine, shelterLine, siteDependencies, utilityLine } from '../../src/loss/infraDeps';
import { createRouter } from '../../src/routing';

const NX = 100, NY = 20, CS = 10;
/** 1 grid cell = 0.0001° in both axes; lon 0 at gx 0, lat decreasing southwards from 0.002 at gy 0. */
const toGrid = (lon: number, lat: number): [number, number] => [lon / 0.0001, (0.002 - lat) / 0.0001];
const toLonLat = (gx: number, gy: number) => ({ lon: gx * 0.0001, lat: 0.002 - gy * 0.0001 });

function fields(simTime = 3600): HazardFields {
  const n = NX * NY;
  return { nx: NX, ny: NY, simTime, maxDepth: new Float32Array(n), maxSpeed: new Float32Array(n), maxDV: new Float32Array(n), firstWet: new Float32Array(n).fill(-1), wetSeconds: new Float32Array(n) };
}
function wet(f: HazardFields, i0: number, i1: number, d: number, t: number, j0 = 0, j1 = NY - 1) {
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const c = j * NX + i;
    f.maxDepth[c] = d;
    f.firstWet[c] = t;
    f.wetSeconds[c] = 1800;
  }
}
const fac = (kind: Facility['kind'], gx: number, gy: number, name: string, extra: Partial<Facility> = {}): Facility => ({ id: `n${name.length}${gx}`, kind, name, ...toLonLat(gx, gy), radiusM: 0, ...extra });

test('OSM tags → facility kinds (bridges only on major roads)', () => {
  assert.equal(classifyFacility({ power: 'substation' }), 'substation');
  assert.equal(classifyFacility({ healthcare: 'hospital' }), 'hospital');
  assert.equal(classifyFacility({ man_made: 'wastewater_plant' }), 'wastewater_plant');
  assert.equal(classifyFacility({ telecom: 'exchange' }), 'telecom');
  assert.equal(classifyFacility({ bridge: 'yes', highway: 'primary' }), 'bridge');
  assert.equal(classifyFacility({ bridge: 'yes', highway: 'residential' }), null);
  assert.equal(classifyFacility({ bridge: 'yes', highway: 'motorway_link' }, false), null, 'a node is no bridge');
  assert.match(overpassFacilitiesQuery({ south: 1, west: 2, north: 3, east: 4 }), /out tags geom;/);
});

test('Overpass JSON: centres, radii, bridge decks chained, duplicates merged, round trip', () => {
  const bounds = { west: 0, south: 0, east: 1, north: 1 };
  const json: { elements: OverpassElement[] } = {
    elements: [
      { type: 'node' as const, id: 1, lat: 0.5, lon: 0.5, tags: { amenity: 'hospital', name: 'General' } },
      { type: 'way' as const, id: 2, bounds: { minlat: 0.4999, minlon: 0.4999, maxlat: 0.5001, maxlon: 0.5001 }, tags: { amenity: 'hospital' } },
      { type: 'way' as const, id: 3, tags: { bridge: 'yes', highway: 'primary', name: 'Main St' }, geometry: [{ lat: 0.2, lon: 0.2 }, { lat: 0.2, lon: 0.2005 }] },
      { type: 'way' as const, id: 4, tags: { bridge: 'yes', highway: 'primary', name: 'Main St' }, geometry: [{ lat: 0.2, lon: 0.2005 }, { lat: 0.2, lon: 0.201 }] },
      { type: 'node' as const, id: 5, lat: 2, lon: 2, tags: { power: 'substation' } }, // outside
      { type: 'node' as const, id: 6, lat: 0.3, lon: 0.3, tags: { shop: 'bakery' } },
    ],
  };
  const list = parseOverpassFacilities(json, bounds);
  assert.equal(list.filter((f) => f.kind === 'hospital').length, 1, 'point and campus are one hospital');
  assert.equal(list.find((f) => f.kind === 'hospital')!.name, 'General');
  const bridges = list.filter((f) => f.kind === 'bridge');
  assert.equal(bridges.length, 1, 'two deck segments are one bridge');
  assert.deepEqual(bridges[0].ends, [0.2, 0.2, 0.201, 0.2]);
  const back = decodeFacilities(JSON.parse(JSON.stringify(encodeFacilities(list, '2026-10-13'))));
  assert.deepEqual(back, list);
  // Hostile rows are dropped, never thrown on.
  assert.deepEqual(decodeFacilities({ v: 1, kinds: FACILITY_KINDS, f: [[0, 'x', 1, 0, 'a', 'n1'], [99, 1, 1, 0, '', 'n2'], null] }), []);
  assert.deepEqual(decodeFacilities('nonsense'), []);
});

test('every baked preset ships a small, valid facilities.json', () => {
  const root = path.resolve(import.meta.dirname, '../../public/presets');
  let total = 0;
  for (const id of fs.readdirSync(root)) {
    if (!fs.existsSync(path.join(root, id, 'meta.json'))) continue;
    const file = path.join(root, id, 'facilities.json');
    assert.ok(fs.existsSync(file), `${id} has facilities.json (the app fetches it for every baked preset)`);
    const size = fs.statSync(file).size;
    total += size;
    assert.ok(size < 100_000, `${id}: ${size} B`);
    const meta = JSON.parse(fs.readFileSync(path.join(root, id, 'meta.json'), 'utf8'));
    const list = decodeFacilities(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const f of list) {
      const b = meta.bounds;
      assert.ok(f.lon >= b.west && f.lon <= b.east && f.lat >= b.south && f.lat <= b.north, `${id} ${f.id} inside the bounds`);
    }
  }
  assert.ok(total < 300_000, `${total} B in all`);
  const pgh = decodeFacilities(JSON.parse(fs.readFileSync(path.join(root, 'pittsburgh', 'facilities.json'), 'utf8')));
  assert.ok(pgh.filter((f) => f.kind === 'substation').length >= 5 && pgh.some((f) => f.kind === 'hospital') && pgh.some((f) => f.kind === 'bridge'));
});

test('exposure and status by documented thresholds; times are first arrivals; rivers and bridge spans skipped', () => {
  const f = fields();
  wet(f, 10, 12, 0.5, 900); // substation at 11 → failed (≥ 0.45)
  wet(f, 30, 32, 0.2, 1500); // hospital at 31 → impaired (< 0.6)
  wet(f, 49, 51, 4, 0); // a river at reset under the bridge span
  const list = [
    fac('substation', 11, 10, 'Sub A'),
    fac('hospital', 31, 10, 'General'),
    fac('fire_station', 70, 10, 'Engine 1'),
    fac('bridge', 50, 10, 'River Br', { ends: [toLonLat(46, 10).lon, toLonLat(46, 10).lat, toLonLat(54, 10).lon, toLonLat(54, 10).lat] }),
    fac('fuel', 500, 10, 'Off map'),
  ];
  const ex = assessFacilities(list, f, toGrid, CS);
  const by = (n: string) => ex.find((e) => e.facility.name === n)!;
  assert.equal(by('Sub A').status, 'failed');
  assert.equal(by('Sub A').failedAt, 900);
  assert.equal(by('General').status, 'impaired');
  assert.equal(by('General').impairedAt, 1500);
  assert.ok(Number.isNaN(by('General').failedAt));
  assert.equal(by('Engine 1').status, 'operational');
  assert.equal(by('River Br').status, 'operational', 'the river under the span is not a flood');
  assert.equal(by('Off map').inside, false);
  const s = summarizeInfra(ex);
  assert.deepEqual([s.inside, s.failed, s.impaired], [4, 1, 1]);
  assert.equal(sortExposures(ex)[0].facility.name, 'Sub A');
  assert.ok(FACILITY_THRESHOLDS.substation.failed >= 0.3 && FACILITY_THRESHOLDS.substation.failed <= 0.6);
});

function street(): RoadNetwork {
  const xs = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const nodes = new Float32Array(xs.flatMap((x) => [x + 0.5, 10.5]));
  const edges = xs.slice(1).map((x, k) => ({ a: k, b: k + 1, length: 100, cls: 'local' as const, name: 'Main St', pts: new Float32Array([xs[k] + 0.5, 10.5, x + 0.5, 10.5]) }));
  return { nodes, edges };
}

test('site dependencies: nearest substation floods while the site stays dry; the hospital is cut off by road', () => {
  const f = fields();
  wet(f, 18, 22, 0.6, 1200); // the street floods between the site (x 30) and the hospital (x 5) at T+20 min
  const list = [fac('substation', 20, 12, 'Sub West'), fac('substation', 95, 12, 'Sub East'), fac('hospital', 5, 10, 'Westside Hospital'), fac('fire_station', 60, 10, 'Engine 7')];
  const ex = assessFacilities(list, f, toGrid, CS);
  const router = createRouter();
  router.setNetwork(street(), CS, { nx: NX, ny: NY });
  const site = { ...toLonLat(30, 10), gx: 30.5, gy: 10.5, siteWet: false };
  const deps = siteDependencies(site, { fields: f, exposures: ex, router });
  const power = deps.utilities.find((u) => u.utility === 'power')!;
  assert.equal(power.exposure.facility.name, 'Sub West', 'nearest by straight line');
  assert.match(utilityLine(power), /Sub West floods \(0\.60 m\) at T\+20 min — out of service \(approximate service area/);
  assert.ok(deps.flags.some((x) => /Site stays dry but its substation \(Sub West\) floods at T\+20 min/.test(x)));
  assert.equal(deps.hospital!.reachable, false);
  assert.equal(deps.hospital!.cutAt, 1200);
  assert.match(reachLine(deps.hospital!), /UNREACHABLE at the peak — last route cut at T\+20 min/);
  assert.ok(deps.flags.some((x) => /Nearest hospital unreachable by road/.test(x)));
  assert.equal(deps.fire!.reachable, true);
  assert.equal(deps.utilityDays, 10);
  // Downtime: a dry, undamaged site is down as long as its power is.
  assert.equal(downtimeWithDependencies({ baseDays: 0, depthAboveFloor: -1, damage: 0, rebuildDays: 180, utilityDays: deps.utilityDays }), 10);
  assert.equal(downtimeWithDependencies({ baseDays: 30, depthAboveFloor: 0.5, damage: 0.05, rebuildDays: 180, utilityDays: 10 }), 21 + 9 + 10);
});

test('shelters as dependencies: one that floods itself and one that loses its substation are flagged; routing skips the flooded one', () => {
  const f = fields();
  wet(f, 18, 22, 0.6, 1200); // Sub West and the shelter at x 20 flood at T+20 min
  const list = [fac('substation', 20, 12, 'Sub West'), fac('substation', 95, 12, 'Sub East')];
  const ex = assessFacilities(list, f, toGrid, CS);
  const shelters = [
    { name: 'Low School', gx: 20.5, gy: 10.5 },
    { name: 'Hill Church', gx: 30.5, gy: 2.5 },
    { name: 'East Hall', gx: 90.5, gy: 10.5 },
  ];
  const router = createRouter();
  router.setNetwork(street(), CS, { nx: NX, ny: NY });
  const site = { ...toLonLat(40, 10), gx: 40.5, gy: 10.5, siteWet: false };
  const deps = siteDependencies(site, { fields: f, exposures: ex, router, shelters, grid: { nx: NX, ny: NY, cellSize: CS } });
  assert.deepEqual(deps.shelters.map((s) => s.name), ['Low School', 'Hill Church', 'East Hall']);
  const [low, hill, east] = deps.shelters;
  assert.equal(low.floodsAt, 1200);
  assert.match(shelterLine(low), /floods itself \(0\.60 m\) from about T\+20 min — not a refuge from then/);
  assert.ok(Number.isNaN(hill.floodsAt));
  assert.equal(hill.power!.exposure.facility.name, 'Sub West');
  assert.ok(hill.power!.distanceM > 100 && hill.power!.distanceM < 150, `${hill.power!.distanceM}`);
  assert.match(shelterLine(hill), /its substation \(Sub West\) floods at T\+20 min — expect no grid power there/);
  assert.equal(east.power!.exposure.facility.name, 'Sub East');
  assert.match(shelterLine(east), /^stays dry; its substation \(Sub East\) keeps working$/);
  assert.ok(deps.flags.some((x) => /^Shelter Low School floods itself from about T\+20 min/.test(x)));
  assert.ok(deps.flags.some((x) => /^Shelter Hill Church stays dry but its substation \(Sub West\) floods at T\+20 min/.test(x)));
  assert.ok(!deps.flags.some((x) => /East Hall/.test(x)));
  // The router at the peak: the flooded shelter is no destination; East Hall is reached instead.
  router.updateFlood(f.maxDepth, NX, NY);
  const r = router.route({ gx: 40.5, gy: 10.5 }, [shelters[0], shelters[2]]);
  assert.equal(r.state, 'ok');
  assert.equal(r.shelter!.name, 'East Hall');
  // No shelters given: none listed.
  assert.deepEqual(siteDependencies(site, { fields: f, exposures: ex, router: null }).shelters, []);
});
