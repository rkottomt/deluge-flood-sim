/// <reference types="node" />
/**
 * Road graph construction from synthetic TIGER-like polylines: shared-vertex noding, ~1 m snapping, degree-2
 * chain merging, deduplication, clipping, lengths, tiny-component removal, compact encoding and OSM parsing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoadNetwork } from '../../src/contracts';
import { gridToGeo, makeGeoToGrid, squareDomain } from '../../src/data/geo';
import {
  buildRoadNetwork,
  classifyMTFCC,
  classifyOSMHighway,
  clipPolyline,
  decodeRoads,
  encodeRoads,
  nodeCrossings,
  parseOSMXml,
  type RawRoad,
} from '../../src/data/roads';

// A 2 km × 2 km, 400 × 400 domain (5 m cells) near Pittsburgh. Roads are authored in grid coords and
// converted to lon/lat, like TIGERweb GeoJSON, so the test exercises the real projection.
const N = 400;
const CELL = 5;
const { bounds } = squareDomain({ lat: 40.44, lon: -80.0 }, N * CELL);
const T = { nx: N, ny: N, bounds };
const grid = { nx: N, ny: N, cellSize: CELL, toGrid: makeGeoToGrid(T) };
const ll = (gx: number, gy: number): [number, number] => {
  const g = gridToGeo(T, gx, gy);
  return [g.lon, g.lat];
};
const road = (pts: Array<[number, number]>, cls: RawRoad['cls'] = 'local', name?: string): RawRoad => ({
  coords: pts.map(([x, y]) => ll(x, y)),
  cls,
  name,
});

function degree(net: RoadNetwork): number[] {
  const d = new Array(net.nodes.length / 2).fill(0);
  for (const e of net.edges) {
    d[e.a]++;
    d[e.b]++;
  }
  return d;
}

function assertEdgeGeometry(net: RoadNetwork) {
  for (const e of net.edges) {
    assert.ok(e.pts.length >= 4 && e.pts.length % 2 === 0);
    assert.ok(Math.abs(e.pts[0] - net.nodes[e.a * 2]) < 1e-3 && Math.abs(e.pts[1] - net.nodes[e.a * 2 + 1]) < 1e-3, 'pts start at node a');
    const L = e.pts.length;
    assert.ok(Math.abs(e.pts[L - 2] - net.nodes[e.b * 2]) < 1e-3 && Math.abs(e.pts[L - 1] - net.nodes[e.b * 2 + 1]) < 1e-3, 'pts end at node b');
    let len = 0;
    for (let q = 2; q < L; q += 2) len += Math.hypot(e.pts[q] - e.pts[q - 2], e.pts[q + 1] - e.pts[q - 1]);
    assert.ok(Math.abs(len * CELL - e.length) < 0.05 * CELL + 1e-3 * e.length, `length ${e.length} vs polyline ${len * CELL}`);
  }
}

test('crossing roads that share a vertex are split into four edges', () => {
  const net = buildRoadNetwork(
    [
      road([[100, 200], [150, 200], [200, 200], [250, 200], [300, 200]], 'major', 'Liberty Ave'),
      road([[200, 100], [200, 150], [200, 200], [200, 250], [200, 300]], 'local', 'Smithfield St'),
    ],
    grid,
  );
  assert.equal(net.edges.length, 4);
  assert.equal(net.nodes.length / 2, 5);
  const deg = degree(net);
  assert.equal(Math.max(...deg), 4);
  assert.equal(deg.filter((d) => d === 1).length, 4);
  for (const e of net.edges) assert.ok(Math.abs(e.length - 500) < 1, `edge length ${e.length} ≈ 100 cells × 5 m`);
  assert.equal(net.edges.filter((e) => e.name === 'Liberty Ave' && e.cls === 'major').length, 2);
  assertEdgeGeometry(net);
});

test('roads crossing WITHOUT a shared vertex are not connected (overpass semantics)', () => {
  const net = buildRoadNetwork(
    [
      road([[100, 200], [300, 200]], 'highway', 'I-376'),
      road([[200, 100], [200, 300]], 'local', 'Grant St'),
    ],
    grid,
  );
  assert.equal(net.edges.length, 2);
  assert.equal(net.nodes.length / 2, 4);
});

test('vertices within ~1 m are snapped together', () => {
  // The second road ends 0.12 cells (0.6 m) from the first road's interior vertex.
  const net = buildRoadNetwork(
    [road([[100, 200], [200, 200], [300, 200]], 'local', 'A St'), road([[200.12, 100], [200.12, 199.9]], 'local', 'B St')],
    grid,
  );
  assert.equal(net.edges.length, 3, 'T-junction formed at the snapped vertex');
  assert.equal(Math.max(...degree(net)), 3);
  // 3 m apart must NOT snap.
  const net2 = buildRoadNetwork(
    [road([[100, 200], [200, 200], [300, 200]], 'local', 'A St'), road([[200.6, 100], [200.6, 199.4]], 'local', 'B St')],
    grid,
  );
  assert.equal(net2.edges.length, 2);
});

test('degree-2 chains of the same class and name merge; different names do not', () => {
  // One street delivered as three consecutive features (TIGER splits at block boundaries).
  const net = buildRoadNetwork(
    [
      road([[50, 50], [80, 60], [110, 50]], 'local', 'Forbes Ave'),
      road([[110, 50], [140, 40], [170, 50]], 'local', 'Forbes Ave'),
      road([[170, 50], [200, 60], [230, 50]], 'local', 'Forbes Ave'),
    ],
    grid,
  );
  assert.equal(net.edges.length, 1);
  assert.equal(net.nodes.length / 2, 2);
  assert.equal(net.edges[0].pts.length / 2, 7);
  assertEdgeGeometry(net);

  const named = buildRoadNetwork(
    [road([[50, 50], [110, 50]], 'local', 'Forbes Ave'), road([[110, 50], [170, 50]], 'local', 'Fifth Ave')],
    grid,
  );
  assert.equal(named.edges.length, 2, 'name change keeps the node');
  const cls = buildRoadNetwork(
    [road([[50, 50], [110, 50]], 'major', 'Forbes Ave'), road([[110, 50], [170, 50]], 'local', 'Forbes Ave')],
    grid,
  );
  assert.equal(cls.edges.length, 2, 'class change keeps the node');
  // A reversed feature still merges (orientation handled).
  const rev = buildRoadNetwork(
    [road([[50, 50], [110, 50]], 'local', 'X'), road([[170, 50], [110, 50]], 'local', 'X')],
    grid,
  );
  assert.equal(rev.edges.length, 1);
  assertEdgeGeometry(rev);
});

test('a closed loop keeps a valid node and duplicate features from overlapping layers are deduplicated', () => {
  const loop = buildRoadNetwork([road([[100, 100], [200, 100], [200, 200], [100, 200], [100, 100]], 'local', 'Loop')], grid);
  assert.equal(loop.edges.length, 1);
  assert.equal(loop.edges[0].a, loop.edges[0].b);
  assert.ok(Math.abs(loop.edges[0].length - 2000) < 1);

  // Same geometry in layer 6 (secondary, S1200) and layer 8 (local): one edge with the higher class.
  const dup = buildRoadNetwork(
    [road([[50, 300], [150, 300], [250, 300]], 'local', 'Penn Ave'), road([[250, 300], [150, 300], [50, 300]], 'major', 'Penn Ave')],
    grid,
  );
  assert.equal(dup.edges.length, 1);
  assert.equal(dup.edges[0].cls, 'major');
});

test('tiny isolated components are dropped, polylines are clipped to the domain', () => {
  const net = buildRoadNetwork(
    [
      road([[10, 10], [40, 10]], 'local', 'Long Rd'), // 150 m → kept (not < 150)
      road([[300, 300], [310, 300]], 'local', 'Stub'), // 50 m → dropped
      road([[-50, 380], [450, 380]], 'highway', 'Edge Hwy'), // crosses both edges → clipped
    ],
    grid,
    { minComponentMeters: 100 },
  );
  assert.equal(net.edges.filter((e) => e.name === 'Stub').length, 0);
  const hwy = net.edges.find((e) => e.name === 'Edge Hwy')!;
  assert.ok(hwy, 'clipped highway kept');
  for (let q = 0; q < hwy.pts.length; q += 2) assert.ok(hwy.pts[q] >= 0 && hwy.pts[q] <= N);
  assert.ok(Math.abs(hwy.length - N * CELL) < 1, `clipped length ${hwy.length}`);

  const pieces = clipPolyline([-10, 5, 10, 5, 10, 50, -10, 50, -10, 60, 10, 60], 0, 0, 100, 100);
  assert.equal(pieces.length, 2);
});

test('compact roads.json encoding round-trips', () => {
  const net = buildRoadNetwork(
    [
      road([[100, 200], [150, 210.33], [200, 200], [250, 190.7], [300, 200]], 'major', 'Liberty Ave'),
      road([[200, 100], [200, 150], [200, 200], [200, 250], [200, 300]], 'local', 'Smithfield St'),
      road([[20, 20], [60, 25], [100, 20]], 'highway'),
    ],
    grid,
  );
  const json = JSON.parse(JSON.stringify(encodeRoads(net)));
  const back = decodeRoads(json);
  assert.equal(back.edges.length, net.edges.length);
  assert.equal(back.nodes.length, net.nodes.length);
  net.edges.forEach((e, k) => {
    const b = back.edges[k];
    assert.equal(b.a, e.a);
    assert.equal(b.b, e.b);
    assert.equal(b.cls, e.cls);
    assert.equal(b.name, e.name);
    assert.ok(Math.abs(b.length - e.length) <= 0.05);
    assert.equal(b.pts.length, e.pts.length);
    for (let q = 0; q < e.pts.length; q++) assert.ok(Math.abs(b.pts[q] - e.pts[q]) <= 0.051, 'quantized to 0.1 cell');
  });
  assertEdgeGeometry(back);
});

test('nodeCrossings inserts shared vertices at crossings and T-junctions', () => {
  const lines = nodeCrossings(
    [
      [0, 50, 100, 50], // horizontal
      [50, 0, 50, 100], // vertical, crosses at (50, 50)
      [80, 90, 80, 50.8], // ends 0.8 short of the horizontal line → T-junction
    ],
    1.5,
  );
  assert.deepEqual(lines[0], [0, 50, 50, 50, 80, 50, 100, 50]);
  assert.deepEqual(lines[1], [50, 0, 50, 50, 50, 100]);
  assert.deepEqual(lines[2], [80, 90, 80, 50]);
  const net = buildRoadNetwork(
    lines.map((flat) => ({ coords: [[flat[0], flat[1]], ...Array.from({ length: flat.length / 2 - 1 }, (_, q) => [flat[2 * q + 2], flat[2 * q + 3]] as [number, number])], cls: 'local' as const })),
    { nx: 100, ny: 100, cellSize: 1, toGrid: (x, y) => [x, y] },
    { minComponentMeters: 0, mergeDegree2: false },
  );
  // Horizontal split in 3, vertical in 2, stub 1.
  assert.equal(net.edges.length, 6);
});

test('MTFCC and OSM classification', () => {
  assert.equal(classifyMTFCC('S1100'), 'highway');
  assert.equal(classifyMTFCC('S1200'), 'major');
  assert.equal(classifyMTFCC('S1400'), 'local');
  assert.equal(classifyMTFCC('S1630'), 'minor');
  assert.equal(classifyMTFCC('S1710'), null); // walkway
  assert.equal(classifyOSMHighway('motorway'), 'highway');
  assert.equal(classifyOSMHighway('primary'), 'major');
  assert.equal(classifyOSMHighway('residential'), 'local');
  assert.equal(classifyOSMHighway('footway'), null);
});

test('OSM API XML parsing (no DOM)', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6">
 <node id="1" lat="40.44" lon="-80.00"/>
 <node id="2" lat="40.441" lon="-80.00"/>
 <node id="3" lat="40.442" lon="-80.001"/>
 <way id="10"><nd ref="1"/><nd ref="2"/><nd ref="3"/><tag k="highway" v="residential"/><tag k="name" v="O&apos;Hara &amp; Sons St"/></way>
 <way id="11"><nd ref="1"/><nd ref="3"/><tag k="highway" v="footway"/></way>
 <way id="12"><nd ref="2"/><nd ref="3"/><tag k="building" v="yes"/></way>
</osm>`;
  const roads = parseOSMXml(xml);
  assert.equal(roads.length, 1);
  assert.equal(roads[0].name, "O'Hara & Sons St");
  assert.equal(roads[0].cls, 'local');
  assert.deepEqual(roads[0].coords[2], [-80.001, 40.442]);
});
