/// <reference types="node" />
/**
 * Pedestrian evacuation (src/routing/pedestrian.ts, pedestrianEvac.ts) on synthetic streets with a hand-made flood
 * timeline, so every expected time can be worked out on paper.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HazardFields, RoadNetwork } from '../../src/contracts';
import { unsafeForWalking, WalkNetwork, walkHazard } from '../../src/routing/pedestrian';
import { analyzePeopleEvac, defaultExitWidth, defaultOccupants, exitFlow, peopleEvacSentences, verticalEvacuation, WALK_GROUPS } from '../../src/routing/pedestrianEvac';

const NX = 100;
const NY = 20;
const CS = 10; // m per cell

/** One straight street along gy = 10, nodes every 10 cells from x = 0 to 90. */
function street(): RoadNetwork {
  const xs = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  const nodes = new Float32Array(xs.flatMap((x) => [x + 0.5, 10.5]));
  const edges = xs.slice(1).map((x, k) => ({ a: k, b: k + 1, length: 100, cls: 'local' as const, name: 'Main St', pts: new Float32Array([xs[k] + 0.5, 10.5, x + 0.5, 10.5]) }));
  return { nodes, edges };
}

function emptyFields(simTime = 3600): HazardFields {
  const n = NX * NY;
  return { nx: NX, ny: NY, simTime, maxDepth: new Float32Array(n), maxSpeed: new Float32Array(n), maxDV: new Float32Array(n), firstWet: new Float32Array(n).fill(-1), wetSeconds: new Float32Array(n) };
}

/**
 * West of x = 45 is shallow, safe water from T+5 min (not dry → no high ground there); x 62–68 floods 0.6 m deep at
 * T+20 min (unsafe); the ground rises to 50 m from x = 80, the only high ground.
 */
function scenario(): { f: HazardFields; ground: Float32Array } {
  const f = emptyFields();
  const ground = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      if (i >= 80) ground[c] = 50;
      if (i < 45) {
        f.maxDepth[c] = 0.1;
        f.firstWet[c] = 300;
      }
      if (i >= 62 && i <= 68) {
        f.maxDepth[c] = 0.6;
        f.maxSpeed[c] = 0.5;
        f.maxDV[c] = 0.3;
        f.firstWet[c] = 1200;
      }
    }
  }
  return { f, ground };
}

function network(): WalkNetwork {
  const { f, ground } = scenario();
  const net = new WalkNetwork(street(), CS, NX, NY);
  net.setFields(f, { ground });
  return net;
}

test('walking safety: FD2321 HR ≥ 0.75 or AIDR ≥ H3 is unsafe; shallow still water is not', () => {
  assert.equal(unsafeForWalking(0.1, 0, 0), false);
  assert.equal(unsafeForWalking(0.2, 1.0, 0.2), false); // HR = 0.2 + 0.1 = 0.3, H1
  assert.equal(unsafeForWalking(0.2, 2.5, 0.5), true); // v > 2 m/s: DF 1, H5+
  assert.equal(unsafeForWalking(0.3, 0, 0), true); // DF = 1 above 0.25 m (urban)
  assert.equal(unsafeForWalking(0.6, NaN, NaN), true); // depth alone: H3
});

test('edge timeline: unsafe from first arrival; water at reset (a bridge span) is ignored', () => {
  const { f } = scenario();
  // A river at reset under x 20–24 (firstWet 0, 3 m deep): the edge over it stays safe.
  for (let i = 20; i <= 24; i++) {
    const c = 10 * NX + i;
    f.maxDepth[c] = 3;
    f.firstWet[c] = 0;
  }
  const net = new WalkNetwork(street(), CS, NX, NY);
  const hz = walkHazard(net.g, NX, NY, f);
  // Edge 6 runs x 60 → 70.
  assert.equal(hz.tUnsafe[6], 1200);
  assert.equal(hz.tUnsafe[2], Infinity, 'the bridge over the river is judged by its landings');
  assert.equal(hz.tUnsafe[8], Infinity);
  assert.equal(hz.tWet[0], 300, 'shallow water slows walkers from its arrival');
  assert.equal(hz.tUnsafe[0], Infinity);
});

test('only dry ground above the nearby water is high ground', () => {
  const net = network();
  const refuges = [...Array(net.g.nodeCount).keys()].filter((n) => net.isRefuge(n)).map((n) => Math.floor(net.g.nodeX[n]));
  assert.deepEqual(refuges, [80, 90]);
});

test('latest safe departure: across the flooding block before it turns unsafe', () => {
  const net = network();
  const seeds = net.seeds(50.5, 10.5);
  assert.equal(seeds[0].meters, 0);
  // Node 70 must be reached by T+1200: 200 m at the group's pace.
  for (const id of ['able', 'impaired'] as const) {
    const v = WALK_GROUPS[id].speed;
    const latest = net.latestDeparture(seeds, v, 0, 3600, 1);
    assert.ok(Math.abs(latest - (1200 - 200 / v)) < 2, `${id}: ${latest.toFixed(0)} s vs ${(1200 - 200 / v).toFixed(0)} s`);
  }
  // Departing early, the walk is 300 m to the high ground at x = 80.
  const r = net.search(seeds, 0, 1.22);
  assert.ok(r.ok);
  assert.ok(Math.abs(r.arrive - 300 / 1.22) < 1e-6);
  const route = net.route(50.5, 10.5, r.node);
  assert.ok(Math.abs(route.meters - 300) < 1e-6);
  assert.equal(route.polyline[0], 50.5);
  assert.equal(route.polyline[route.polyline.length - 2], 80.5);
  // Too late: no refuge.
  assert.equal(net.search(seeds, 1100, 1.22).ok, false);
});

test('a shelter that stays safe is a named refuge', () => {
  const { f, ground } = scenario();
  ground.fill(0); // no high ground anywhere
  const net = new WalkNetwork(street(), CS, NX, NY);
  net.setFields(f, { ground, shelters: [{ gx: 90.5, gy: 11, name: 'School gym' }] });
  const r = net.search(net.seeds(50.5, 10.5), 0, 1.22);
  assert.ok(r.ok);
  assert.equal(net.refugeLabel(r.node), 'School gym');
  // A shelter standing in unsafe water is no refuge.
  const net2 = new WalkNetwork(street(), CS, NX, NY);
  net2.setFields(f, { ground, shelters: [{ gx: 65.5, gy: 10.5, name: 'Flooded hall' }] });
  assert.equal(net2.refugeCount(), 0);
});

test('X of N: the exit queue decides who leaves before the route closes', () => {
  const net = network();
  const width = 2 * 0.91;
  const flow = exitFlow(width);
  assert.ok(Math.abs(flow - 1.3 * (1.82 - 0.6)) < 1e-9);
  const r = analyzePeopleEvac(net, { gx: 50.5, gy: 10.5 }, {
    occupants: 1000,
    mix: [{ id: 'able', share: 1 }],
    exitWidthM: width,
    preMovementS: 600,
    alertTime: 0,
    exitUnsafeAt: Infinity,
    building: { floors: 3, firstFloorHeight: 0.3, storeyHeight: 3.5, maxDepth: 1.6, collapseShare: 0, state: 'none' },
  });
  assert.ok(r.known);
  const latest = 1200 - 200 / 1.22;
  const want = Math.floor(((latest - 600) * flow) / 1000 * 1000);
  assert.ok(Math.abs(r.reach - want) <= 3, `${r.reach} vs ${want}`);
  assert.ok(Number.isNaN(r.everyoneSafeAt), 'not everyone makes it');
  assert.ok(Math.abs(r.everyoneOutAt - (600 + 1000 / flow)) < 1e-6);
  assert.equal(r.vertical?.feasible, true);
  assert.equal(r.vertical?.floor, 2);
  assert.equal(r.route?.refugeKind, 'high-ground');
  const text = peopleEvacSentences(r).join(' ');
  assert.match(text, /of 1,000 reach safety on foot/);
  assert.match(text, /Vertical evacuation feasible: yes — floor 2/);

  // A small office leaves in time: everyone at the refuge, the slowest group last.
  const small = analyzePeopleEvac(net, { gx: 50.5, gy: 10.5 }, {
    occupants: 50,
    mix: [{ id: 'able', share: 0.8 }, { id: 'impaired', share: 0.2 }],
    exitWidthM: width,
    preMovementS: 300,
    alertTime: 0,
    exitUnsafeAt: Infinity,
    building: null,
  });
  assert.equal(small.reach, 50);
  const out = 300 + 50 / flow;
  assert.ok(Math.abs(small.everyoneSafeAt - (out + 300 / 0.6)) < 1e-6, `${small.everyoneSafeAt}`);
});

test('vertical evacuation: not in the collapse band, and only with a floor high enough', () => {
  assert.equal(verticalEvacuation({ floors: 1, firstFloorHeight: 0.3, storeyHeight: 3, maxDepth: 0.5, collapseShare: 0, state: 'none' }).feasible, false);
  const v = verticalEvacuation({ floors: 10, firstFloorHeight: 0.3, storeyHeight: 3, maxDepth: 4, collapseShare: 0.4, state: 'partial' });
  assert.equal(v.feasible, false);
  assert.match(v.reason, /collapse band/);
});

test('defaults: IBC occupant load and egress width', () => {
  assert.equal(defaultOccupants('office', 1393.5).n, 100); // 15,000 ft² / 150
  assert.equal(defaultExitWidth(100), 2 * 0.91);
  assert.ok(defaultExitWidth(1000) >= 1000 * 0.00508);
});
