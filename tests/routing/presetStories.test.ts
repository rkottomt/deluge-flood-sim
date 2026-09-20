/// <reference types="node" />
/**
 * Real-data checks on the evacuation story each shipped stage preset actually tells: raise its river or its sea as a
 * bathtub from normal pool to the crest the scenario's own slider reaches (see presetWorld.ts) and follow the route
 * from the start the preset names in meta.json (scenario.evacStart).
 *
 * Two things are asserted, because both were broken in ways a single before/after comparison hides:
 *  1. Every preset's own start re-plans — a different shelter, or a materially different drive — at least once before
 *     the flood takes its last road. Comparing only "at load" with "at the crest" misses that: on Fort Myers 22 % of
 *     land starts re-plan somewhere in between, and exactly one differs between the two endpoints.
 *  2. Every blocked route explains itself. The reason and the numbers behind it (RouteDiagnosis) have to agree, so a
 *     blocked card can never say "all roads to shelters are flooded" about a start that is merely disconnected from
 *     the road network, or about a house that is itself under water.
 *
 * Run: node --import tsx --test tests/routing/presetStories.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROAD_FLOODED_DEPTH } from '../../src/routing/constants';
import { createRouter, type DelugeRouteResult } from '../../src/routing/index';
import { bakedPresetIds, loadPresetWorld } from './presetFiles';
import { scenarioPeakLevel, type PresetWorld } from './presetWorld';

/** A route's identity for "did it change?": the shelter it reaches and its length in 100 m buckets. */
function signature(r: DelugeRouteResult): string {
  return r.state === 'ok' ? `${r.shelter?.name ?? '?'}|${Math.round(r.lengthMeters / 100)}` : `!${r.state}:${r.reason}`;
}

/** The route at every step of the rise, from normal pool to the scenario's crest. */
function followTheRise(world: PresetWorld, start: { gx: number; gy: number }, steps: number) {
  const { nx, ny, shelters } = world;
  const peak = scenarioPeakLevel(world);
  const pool = world.pool!;
  const router = createRouter();
  router.setNetwork(world.roads, world.cellSize, { nx, ny });
  router.setBaselineWater(world.initialWater, nx, ny); // exactly what the app does at load
  const out: Array<{ ft: number; route: DelugeRouteResult }> = [];
  for (let k = 0; k <= steps; k++) {
    const level = pool + ((peak.level - pool) * k) / steps;
    router.updateFlood(world.bathtub(level), nx, ny);
    out.push({ ft: (level - world.stage!.gaugeDatum) / 0.3048, route: router.route(start, shelters) });
  }
  return { peak, steps: out };
}

/** Reason and numbers have to agree — whatever the preset, wherever the start. */
function assertDiagnosisAgrees(r: DelugeRouteResult, where: string): void {
  if (r.state !== 'blocked') {
    assert.equal(r.diagnosis, null, `${where}: only a blocked route carries a diagnosis`);
    return;
  }
  const d = r.diagnosis;
  assert.ok(d, `${where}: a blocked route says why`);
  assert.ok(d.shelters > 0 && d.dryShelters <= d.shelters, `${where}: ${d.dryShelters} dry of ${d.shelters} shelters`);
  assert.ok(d.startRoadsUsable <= d.startRoads, `${where}: ${d.startRoadsUsable} usable of ${d.startRoads} roads near the start`);
  switch (r.reason) {
    case 'start-flooded':
      assert.ok(d.startDepth >= ROAD_FLOODED_DEPTH, `${where}: "start flooded" means the start is under water (${d.startDepth} m)`);
      break;
    case 'start-roads-flooded':
      assert.equal(d.startRoadsUsable, 0, `${where}: "roads near the start flooded" means none of them is passable`);
      assert.ok(d.startRoads > 0, `${where}: ...and that there are roads there at all`);
      assert.ok(d.startDepth < ROAD_FLOODED_DEPTH, `${where}: ...and that the start itself is not the thing under water`);
      break;
    case 'shelters-flooded':
      assert.equal(d.dryShelters, 0, `${where}: "every shelter flooded" means no shelter is above water`);
      break;
    case 'cut-off':
      assert.ok(d.dryShelters > 0, `${where}: "cut off" means there is a dry shelter to be cut off from`);
      assert.ok(d.startRoadsUsable > 0, `${where}: ...reachable from a road the start can still use`);
      if (d.cutRoute) {
        assert.ok(d.cutRoute.lengthMeters > 0 && Number.isFinite(d.cutRoute.etaSeconds), `${where}: the cut route has a length and a time`);
        assert.ok(
          d.cutRoute.floodedMeters > 0 && d.cutRoute.floodedMeters <= d.cutRoute.lengthMeters + 1,
          `${where}: part of the cut route is under water (${d.cutRoute.floodedMeters} of ${d.cutRoute.lengthMeters} m)`,
        );
      }
      break;
    default:
      assert.fail(`${where}: unexpected blocked reason ${r.reason}`);
  }
}

test('every stage preset names an evacuation start whose route re-plans, then loses its last road', () => {
  const ids = bakedPresetIds();
  let checked = 0;
  for (const id of ids) {
    const world = loadPresetWorld(id);
    const hint = world.meta.scenario.evacStart;
    if (!world.stage || !hint) continue;
    checked++;
    const { peak, steps } = followTheRise(world, hint, 20);
    const first = steps[0].route;
    assert.equal(first.state, 'ok', `${id}: the named start has a route at normal pool — ${first.message}`);
    assert.ok(first.shelter, `${id}: ...to a named shelter`);

    // The start is a home, not a river: dry land at load, and a street the router can snap to.
    assert.equal(world.initialWater[Math.floor(hint.gy) * world.nx + Math.floor(hint.gx)], 0, `${id}: the start is on dry land at load`);

    const sigs = steps.map((s) => signature(s.route));
    const closedAt = sigs.findIndex((s) => s.startsWith('!'));
    assert.ok(closedAt > 0, `${id}: the flood takes the last route before the crest (${peak.label}); states ${sigs.join(' ')}`);
    const before = new Set(sigs.slice(0, closedAt));
    assert.ok(
      before.size >= 2,
      `${id}: the route re-plans at least once before it closes — ${[...before].join(' → ')} (${steps[0].route.message})`,
    );
    for (const s of steps) assertDiagnosisAgrees(s.route, `${id} at ${s.ft.toFixed(1)} ft`);

    // Something is lost between the first route and the last one: a different shelter, or a different way there.
    const lastOk = steps[closedAt - 1].route;
    assert.equal(lastOk.state, 'ok');
    console.log(
      `[story ${id}] ${hint.label ?? `${hint.gx},${hint.gy}`}: ${steps[0].ft.toFixed(1)} ft “${first.message}”\n` +
        `  re-plans: ${[...before].join('  →  ')}\n` +
        `  last route at ${steps[closedAt - 1].ft.toFixed(1)} ft “${lastOk.message}”, cut at ${steps[closedAt].ft.toFixed(1)} ft ` +
        `(${steps[closedAt].route.reason}) — crest is ${peak.label} at ${peak.ft.toFixed(2)} ft`,
    );
  }
  assert.ok(checked >= 3, `checked ${checked} stage presets with an evacuation start`);
});

test('Pittsburgh: the named start still re-plans Mount Washington → Hill District and is then cut off', () => {
  const world = loadPresetWorld('pittsburgh');
  const hint = world.meta.scenario.evacStart!;
  const { steps } = followTheRise(world, hint, 20);
  const shelters = steps.map((s) => s.route.shelter?.name ?? '');
  const first = shelters.find(Boolean);
  assert.match(first ?? '', /Mount Washington/, `the first shelter is across the Monongahela: ${steps[0].route.message}`);
  const hill = shelters.findIndex((n) => /Hill District/.test(n));
  assert.ok(hill > 0, `it re-plans to the Hill District as the rivers rise: ${shelters.filter(Boolean).join(' → ')}`);
  const closedAt = steps.findIndex((s) => s.route.state !== 'ok');
  assert.ok(closedAt > hill, 'and only then loses its last road');
  const cut = steps[closedAt].route;
  assert.equal(cut.state, 'blocked');
  // A downtown start a metre above the 1936 crest: the roads go, not the house.
  assert.equal(cut.reason, 'cut-off', cut.message);
  assert.ok(cut.diagnosis?.cutRoute, 'the route the flood cut is reported, so the card can say how long the drive was');
  assert.ok(cut.polyline && cut.polyline.length > 4, 'and drawn in red on the map');
});

test('Fort Myers: the surge pushes the route inland off the riverfront, then closes it before Ian’s crest', () => {
  const world = loadPresetWorld('ftmyers');
  const hint = world.meta.scenario.evacStart!;
  const { peak, steps } = followTheRise(world, hint, 20);
  assert.match(steps[0].route.via.join(' '), /McGregor/, `the first way out runs along the riverfront: ${steps[0].route.message}`);
  const inland = steps.find((s) => s.route.state === 'ok' && !/McGregor/.test(s.route.via.join(' ')));
  assert.ok(inland, 'the route leaves McGregor Blvd as the surge takes it');
  const closedAt = steps.findIndex((s) => s.route.state !== 'ok');
  assert.ok(closedAt > 0 && steps[closedAt].ft < peak.ft, `the last route closes at ${steps[closedAt].ft.toFixed(1)} ft, below Ian's ${peak.ft} ft`);
});

test('Fort Myers: a home that stays dry can still lose every road, and the card gets the numbers to say so', () => {
  const world = loadPresetWorld('ftmyers');
  // Terry Ave in east Fort Myers, 3.1 m NAVD88 — above the 2.29 m the Ian mark puts on this gauge.
  const start = { gx: 861.3, gy: 151.3 };
  const { steps } = followTheRise(world, start, 20);
  const cut = steps.filter((s) => s.route.state === 'blocked').at(-1)!.route;
  assert.equal(cut.reason, 'cut-off', cut.message);
  const d = cut.diagnosis!;
  assert.ok(d.startDepth < ROAD_FLOODED_DEPTH, `the home is not under water (${d.startDepth.toFixed(2)} m)`);
  assert.equal(d.dryShelters, d.shelters, 'every shelter is still above water');
  assert.ok(d.startRoadsUsable > 0, 'there are still streets at the door');
  assert.ok(d.cutRoute, 'but no way through: the drive that the flood cut is measured');
  assert.ok(d.cutRoute.floodedMeters > 500, `${d.cutRoute.floodedMeters.toFixed(0)} m of the ${d.cutRoute.lengthMeters.toFixed(0)} m drive out is under water`);
  assert.ok(d.cutRoute.shelterName.length > 0, 'and named');
});

test('Fort Myers: at the Ian crest every blocked start is explained, and most of them re-planned first', () => {
  const world = loadPresetWorld('ftmyers');
  const { nx, ny, shelters } = world;
  const peak = scenarioPeakLevel(world);
  const pool = world.pool!;
  const router = createRouter();
  router.setNetwork(world.roads, world.cellSize, { nx, ny });
  router.setBaselineWater(world.initialWater, nx, ny);

  const STEPS = 10;
  const SPACING = 40;
  const starts: Array<{ gx: number; gy: number }> = [];
  router.updateFlood(world.bathtub(pool), nx, ny);
  for (let gy = 12; gy < ny - 12; gy += SPACING) {
    for (let gx = 12; gx < nx - 12; gx += SPACING) {
      if (world.initialWater[Math.floor(gy) * nx + Math.floor(gx)] > 0) continue; // in the estuary at load
      if (router.route({ gx, gy }, shelters).reason === 'start-off-network') continue;
      starts.push({ gx, gy });
    }
  }
  assert.ok(starts.length > 100, `${starts.length} land starts on a ${SPACING}-cell grid`);

  const sigs = starts.map(() => [] as string[]);
  for (let k = 0; k <= STEPS; k++) {
    router.updateFlood(world.bathtub(pool + ((peak.level - pool) * k) / STEPS), nx, ny);
    for (let i = 0; i < starts.length; i++) {
      const r = router.route(starts[i], shelters);
      assertDiagnosisAgrees(r, `ftmyers start ${starts[i].gx},${starts[i].gy} at step ${k}`);
      sigs[i].push(signature(r));
    }
  }

  let blocked = 0;
  let blockedAfterReplan = 0;
  let replanned = 0;
  for (const seq of sigs) {
    if (seq[0].startsWith('!')) continue; // no route even at normal tide
    const closedAt = seq.findIndex((s) => s.startsWith('!'));
    const distinct = new Set(seq.slice(0, closedAt < 0 ? seq.length : closedAt)).size;
    if (distinct > 1) replanned++;
    if (closedAt > 0) {
      blocked++;
      if (distinct > 1) blockedAfterReplan++;
    }
  }
  console.log(
    `[story ftmyers] ${starts.length} land starts, ${STEPS} steps to ${peak.label}: ${replanned} ever re-plan, ` +
      `${blocked} lose their last route (${blockedAfterReplan} of those re-planned first)`,
  );
  assert.ok(blocked > 20, `${blocked} starts lose their last route on the way to the Ian crest`);
  assert.ok(
    blockedAfterReplan / blocked > 0.5,
    `most starts that end up cut off re-plan first (${blockedAfterReplan}/${blocked}) — "everything is simply cut" is not the whole story`,
  );
});
