/// <reference types="node" />
/**
 * Evacuation on foot and infrastructure dependencies on the shipped Pittsburgh preset, at the 1936 record (46 ft),
 * without a GPU: the "bathtub" of presetWorld.ts (where the stage sources settle when the slider is held), with the
 * river rising linearly from normal pool to the crest over an hour so every cell gets an arrival time, and a gentle
 * 0.3 m/s everywhere for speeds. The numbers it prints are the ones the final report quotes for this check; the
 * assertions are the qualitative story (the Point floods, the high ground does not, the walk reaches it).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { HazardFields } from '../../src/contracts';
import { makeGeoToGrid } from '../../src/data/geo';
import { decodeFacilities } from '../../src/data/facilities';
import { assessFacilities, summarizeInfra } from '../../src/loss/infra';
import { siteDependencies, utilityLine } from '../../src/loss/infraDeps';
import { createRouter } from '../../src/routing';
import { WalkNetwork } from '../../src/routing/pedestrian';
import { analyzePeopleEvac, peopleEvacSentences } from '../../src/routing/pedestrianEvac';
import { loadPresetWorld, PRESETS_DIR } from './presetFiles';
import { mark, PLACES } from './pittsburghPreset';

const RISE_S = 3600;
const SPEED = 0.3;

function fieldsAt(level: number): { f: HazardFields; w: ReturnType<typeof loadPresetWorld> } {
  const w = loadPresetWorld('pittsburgh');
  const { nx, ny, elevation, initialWater } = w;
  const d = w.bathtub(level);
  const n = nx * ny;
  const pool = w.stage!.normalLevel;
  const f: HazardFields = { nx, ny, simTime: RISE_S + 600, maxDepth: d, maxSpeed: new Float32Array(n), maxDV: new Float32Array(n), firstWet: new Float32Array(n).fill(-1), wetSeconds: new Float32Array(n) };
  for (let c = 0; c < n; c++) {
    if (initialWater[c] >= 0.15) {
      f.firstWet[c] = 0;
      continue;
    }
    if (d[c] < 0.01) continue;
    f.maxSpeed[c] = SPEED;
    f.maxDV[c] = d[c] * SPEED;
    if (d[c] >= 0.15) {
      const t = ((elevation[c] + 0.15 - pool) / (level - pool)) * RISE_S;
      f.firstWet[c] = Math.max(1, Math.min(RISE_S, t));
      f.wetSeconds[c] = f.simTime - f.firstWet[c];
    }
  }
  return { f, w };
}

test('Pittsburgh 1936: facilities on the Point fail, a North Shore office walks to high ground in time or partly', () => {
  const { f, w } = fieldsAt(mark(loadPresetWorld('pittsburgh'), '1936').level);
  const toGrid = makeGeoToGrid(w.meta);
  const list = decodeFacilities(JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, 'pittsburgh', 'facilities.json'), 'utf8')));
  const ex = assessFacilities(list, f, toGrid, w.cellSize);
  const s = summarizeInfra(ex);
  console.log(`  facilities: ${s.inside} on the map, ${s.failed} out of service, ${s.impaired} impaired`);
  assert.ok(s.failed >= 3, 'the 1936 crest takes several facilities out');
  assert.ok(s.failed + s.impaired < s.inside, 'but not the hilltops');

  const net = new WalkNetwork(w.roads, w.cellSize, w.nx, w.ny);
  const t0 = performance.now();
  net.setFields(f, { ground: w.elevation, shelters: w.shelters });
  const [gx, gy] = toGrid(PLACES.northShore.lon, PLACES.northShore.lat);
  const r = analyzePeopleEvac(net, { gx, gy }, {
    occupants: 430,
    mix: [{ id: 'able', share: 0.9 }, { id: 'older', share: 0.07 }, { id: 'impaired', share: 0.03 }],
    exitWidthM: 2 * 0.91,
    preMovementS: 600,
    alertTime: 0,
    exitUnsafeAt: Infinity,
    building: { floors: 3, firstFloorHeight: 0.3, storeyHeight: 3.9, maxDepth: f.maxDepth[Math.floor(gy) * w.nx + Math.floor(gx)], collapseShare: 0, state: 'none' },
  });
  const ms = performance.now() - t0;
  for (const line of peopleEvacSentences(r)) console.log(`  ${line}`);
  console.log(`  (${net.refugeCount()} high-ground / shelter nodes; ${ms.toFixed(0)} ms)`);
  assert.ok(r.known, r.note);
  assert.ok(r.route && r.route.meters > 100, 'a walking route to a refuge exists before the water comes');
  assert.ok(r.reach > 0 && r.reach <= 430);
  assert.ok(ms < 5000, `${ms.toFixed(0)} ms`);

  const router = createRouter();
  router.setNetwork(w.roads, w.cellSize, { nx: w.nx, ny: w.ny });
  const deps = siteDependencies({ ...PLACES.northShore, gx, gy, siteWet: true }, { fields: f, exposures: ex, router });
  for (const u of deps.utilities) console.log(`  ${u.utility}: ${utilityLine(u)}`);
  console.log(`  hospital: ${deps.hospital?.reachable ? 'reachable' : 'unreachable'}; fire: ${deps.fire?.reachable ? 'reachable' : 'unreachable'}; flags: ${deps.flags.join(' | ') || 'none'}`);
  assert.ok(deps.utilities.some((u) => u.utility === 'power'), 'a substation is assigned');
  assert.ok(deps.hospital?.known);
});
