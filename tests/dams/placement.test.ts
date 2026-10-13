/**
 * Where a breach flood goes on the map (src/dams/placement.ts, src/dams/scenario.ts): the injection cell, the flow
 * path across flats, the downstream bearing from a coarse probe, the arrival readout, and the dam scenario on a
 * synthetic valley — whose inflow delivers exactly the breach volume and is never scaled by the climate layer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HazardFields, ScenarioPreset } from '../../src/contracts';
import { damScenario } from '../../src/dams/breachModel';
import type { NidDam } from '../../src/dams/nidIndex';
import { areaCentreForDam, descentPath, downstreamBearing, injectionCell, offsetLatLon, readDownstream } from '../../src/dams/placement';
import { DAM_INFLOW_ID, damBreachScenario, withoutDamText } from '../../src/dams/scenario';
import { climateForcing, scaleSources } from '../../src/climate/apply';
import { hydrographVolume } from '../../src/sim/forcing';

/**
 * A valley falling south (grid y grows southward): 100 m at the north edge to 40 m at the south, a V-shaped channel
 * down the middle column, a 2 m high flat "lake" (hydro-flattened) across rows 60–70, and a dam ridge at row 30.
 */
function valley(n = 128): Float32Array {
  const z = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let e = 100 - (60 * j) / (n - 1) + 0.15 * Math.abs(i - n / 2);
      if (j >= 60 && j <= 70) e = 100 - (60 * 60) / (n - 1); // a flat water surface across the lake rows
      if (j === 30) e += 15; // the dam
      z[j * n + i] = e;
    }
  }
  return z;
}

test('injection cell: the lowest ground near the dam, below it', () => {
  const n = 128;
  const z = valley(n);
  const c = injectionCell(z, n, n, 10, { gx: 64.5, gy: 30.5 }, 150);
  assert.ok(c);
  assert.ok(c.gy > 30, `downstream of the dam (gy ${c.gy})`);
  assert.ok(Math.abs(c.gx - 64.5) < 1.01, `in the channel (gx ${c.gx})`);
  assert.ok(c.distanceM <= 150 + 1e-6);
  assert.equal(injectionCell(z, n, n, 10, { gx: -5, gy: 3 }, 150), null);
});

test('flow path: steepest descent down the channel, across a flat lake, to the grid edge', () => {
  const n = 128;
  const z = valley(n);
  const path = descentPath(z, n, n, 10, { gx: 64.5, gy: 31.5 }, 1e6);
  const end = path[path.length - 1];
  assert.equal(Math.floor(end.gy), n - 1, `ends on the south edge (gy ${end.gy})`);
  assert.ok(path.every((p, i) => i === 0 || p.s > path[i - 1].s), 'distance grows');
  assert.ok(path.every((p, i) => i === 0 || p.z <= path[i - 1].z + 0.05 + 1e-6), 'never climbs more than the flat tolerance');
  assert.ok(Math.abs(end.s - (n - 1 - 31) * 10) < 60, `length ${end.s} m`);
  // A pit nothing escapes stops the path rather than looping.
  const pit = new Float32Array(16 * 16).fill(10);
  pit[8 * 16 + 8] = 0;
  const p = descentPath(pit, 16, 16, 10, { gx: 8.5, gy: 8.5 }, 1e6, { maxFlatCells: 10 });
  assert.equal(p.length, 1);
});

test('downstream bearing from a coarse probe, and the area centred below the dam', () => {
  const n = 64;
  // Falls to the east: bearing ≈ π/2.
  const east = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) east[j * n + i] = 200 - 2 * i + 0.3 * Math.abs(j - n / 2);
  const b = downstreamBearing(east, n, 190, { gx: 32, gy: 32 }, 30);
  assert.ok(b !== null && Math.abs(b - Math.PI / 2) < 0.2, `bearing ${b}`);
  // Falls to the south: bearing ≈ π.
  const south = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) south[j * n + i] = 200 - 2 * j + 0.3 * Math.abs(i - n / 2);
  const bs = downstreamBearing(south, n, 190, { gx: 32, gy: 32 }, 30)!;
  assert.ok(Math.abs(Math.abs(bs) - Math.PI) < 0.2, `bearing ${bs}`);
  // Flat ground: no bearing, the area stays centred on the dam.
  assert.equal(downstreamBearing(new Float32Array(n * n), n, 190, { gx: 32, gy: 32 }, 30), null);
  const dam = { lat: 40, lon: -105 };
  assert.deepEqual(areaCentreForDam(dam, null, 12000), dam);
  const c = areaCentreForDam(dam, Math.PI / 2, 12000);
  assert.ok(Math.abs(c.lat - 40) < 1e-9 && c.lon > -105, 'east of the dam');
  const o = offsetLatLon(40, -105, 0, 1000);
  assert.ok(Math.abs((o.lat - 40) * 111_320 - 1000) < 1e-6);
});

test('readout: earliest arrival and peak depth near each distance along the path', () => {
  const n = 64;
  const fields: HazardFields = {
    nx: n,
    ny: n,
    simTime: 3600,
    maxDepth: new Float32Array(n * n),
    maxSpeed: new Float32Array(n * n),
    maxDV: new Float32Array(n * n),
    firstWet: new Float32Array(n * n).fill(-1),
    wetSeconds: new Float32Array(n * n),
  };
  // A wave moving south down column 32 at 2 m/s on 10 m cells: arrives at row j at 5·j s, 3 m deep.
  for (let j = 0; j < 50; j++) {
    fields.firstWet[j * n + 32] = 5 * j;
    fields.maxDepth[j * n + 32] = 3;
    fields.maxSpeed[j * n + 32] = 2;
  }
  const path = Array.from({ length: 60 }, (_, j) => ({ gx: 32.5, gy: j + 0.5, s: j * 10, z: 0 }));
  const rows = readDownstream(fields, path, [100, 300, 550], 2);
  assert.equal(rows.length, 3);
  assert.ok(Math.abs(rows[0].arrivalS! - 5 * 8) <= 5 * 2, `${rows[0].arrivalS}`);
  assert.equal(rows[0].maxDepth, 3);
  assert.equal(rows[2].arrivalS, null, 'beyond the wave: not yet');
  assert.equal(readDownstream(fields, path, [100, 5000]).length, 1, 'distances past the path are cut');
});

function nidDam(): NidDam {
  return { id: 'XX00001', name: 'Test Dam', state: 'CO', lat: 40, lon: -105, heightM: 15, hydraulicHeightM: 14, storageAcFt: 20000, normalStorageAcFt: 12000, surfaceAreaAc: 900, maxDischargeCfs: 8000, lengthFt: 1500, year: 1960, hazard: 'High', owner: 'State', damType: 'Earth' };
}

const BASE: ScenarioPreset = {
  description: 'Live area.',
  sources: [{ id: 'stage-1', type: 'stage', gx: 0, gy: 64, radius: 5, level: 40 }],
  storms: [],
  shelters: [],
  rainRate: 0,
  stage: null,
  initialFill: [],
};

test('the dam scenario: an inflow at the toe carrying exactly the breach volume, never climate-scaled', () => {
  const n = 128;
  const z = valley(n);
  const s = damScenario(nidDam(), 'flood');
  const out = damBreachScenario({ elevation: z, nx: n, ny: n, cellSize: 10 }, BASE, { gx: 64.5, gy: 30.5 }, s);
  assert.ok(out);
  const src = out.source;
  assert.equal(src.id, DAM_INFLOW_ID);
  assert.ok(src.gy > 30 && src.hydrograph && src.hydrograph.length > 50);
  const v = hydrographVolume(src.hydrograph!, 0, 1e9);
  assert.ok(Math.abs(v / out.spec.volume - 1) < 1e-9, `${v} vs ${out.spec.volume}`);
  assert.equal(out.scenario.sources[0], src);
  assert.equal(out.scenario.sources[1].id, 'stage-1', 'the area’s own boundaries are kept');
  assert.ok(out.spec.path.length > 10 && out.spec.path.length <= 400);
  assert.match(out.scenario.description, /Test Dam \(NID XX00001/);
  // Climate: 2080 SSP5-8.5 scales rain-fed inflows on a live area — but not the breach.
  const f = climateForcing({ horizon: '2080', pathway: 'ssp585', scaling: 'cc' }, null, out.scenario);
  assert.ok(f.inflowMult > 1);
  const scaled = scaleSources(out.scenario.sources, f);
  assert.equal(scaled.find((x) => x.id === DAM_INFLOW_ID), src);
  // Off the map: no scenario.
  assert.equal(damBreachScenario({ elevation: z, nx: n, ny: n, cellSize: 10 }, BASE, { gx: 500, gy: 30 }, s), null);
});

test('re-running a breach replaces its sentences in the description, never stacks them', () => {
  const n = 128;
  const z = valley(n);
  const grid = { elevation: z, nx: n, ny: n, cellSize: 10 };
  const first = damBreachScenario(grid, BASE, { gx: 64.5, gy: 30.5 }, damScenario(nidDam(), 'flood'))!;
  // As the dam view does: the previous breach taken out, then the new one put in.
  const clean = { ...first.scenario, description: withoutDamText(first.scenario), damBreach: undefined };
  assert.equal(clean.description, BASE.description);
  const again = damBreachScenario(grid, clean, { gx: 64.5, gy: 30.5 }, damScenario(nidDam(), 'sunny'))!;
  assert.equal((again.scenario.description.match(/NID XX00001/g) ?? []).length, 1, again.scenario.description);
  assert.match(again.scenario.description, /sunny-day/);
  assert.ok(again.scenario.description.endsWith(BASE.description));
  // Even handed the breached scenario itself, the builder starts from the base description.
  const direct = damBreachScenario(grid, first.scenario, { gx: 64.5, gy: 30.5 }, damScenario(nidDam(), 'flood'))!;
  assert.equal((direct.scenario.description.match(/NID XX00001/g) ?? []).length, 1);
});
