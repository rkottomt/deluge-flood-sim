/**
 * Per-building impact from HazardFields (src/loss/impact.ts, footprints.ts, access.ts, fallback.ts, analyze()).
 * HazardFields are mocked here: the GPU accumulators behind FloodSolver.readHazardFields are built separately.
 * Run: node --import tsx --test tests/loss/impact.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BuildingSet, FloodSolver, HazardFields, RoadNetwork } from '../../src/contracts';
import { BUILDING_KINDS, levelsToMeters } from '../../src/data/buildings';
import {
  ACCESS_CUT,
  ACCESS_OPEN,
  analyze,
  buildingAccess,
  computeBuildingImpacts,
  footprintIndex,
  openCells,
  rasterizeFootprints,
  regionAt,
  sampleCells,
  SnapshotHazardAccumulator,
  topByLoss,
} from '../../src/loss';

const NX = 64;
const NY = 64;
const CELL = 5;

function fields(fill: (i: number, j: number) => Partial<{ d: number; v: number; fw: number; w: number }>): HazardFields {
  const n = NX * NY;
  const f: HazardFields = {
    nx: NX,
    ny: NY,
    simTime: 3600,
    maxDepth: new Float32Array(n),
    maxSpeed: new Float32Array(n),
    maxDV: new Float32Array(n),
    firstWet: new Float32Array(n).fill(-1),
    wetSeconds: new Float32Array(n),
  };
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const c = j * NX + i;
      const p = fill(i, j);
      const d = p.d ?? 0;
      const v = p.v ?? 0;
      f.maxDepth[c] = d;
      f.maxSpeed[c] = v;
      f.maxDV[c] = d * v;
      f.firstWet[c] = p.fw ?? (d >= 0.15 ? 600 : -1);
      f.wetSeconds[c] = p.w ?? (d >= 0.15 ? 1200 : 0);
    }
  }
  return f;
}

/** Rectangular footprints [x0, y0, x1, y1] (grid coords), kinds and heights. */
function buildings(rects: Array<[number, number, number, number, string, number]>): BuildingSet {
  const offsets = new Uint32Array(rects.length + 1);
  const verts: number[] = [];
  rects.forEach(([x0, y0, x1, y1], k) => {
    offsets[k] = verts.length / 2;
    verts.push(x0, y0, x1, y0, x1, y1, x0, y1);
  });
  offsets[rects.length] = verts.length / 2;
  return {
    count: rects.length,
    offsets,
    verts: Float32Array.from(verts),
    base: new Float32Array(rects.length),
    height: Float32Array.from(rects.map((r) => r[5])),
    heightSource: new Uint8Array(rects.length).fill(1),
    kind: Uint8Array.from(rects.map((r) => BUILDING_KINDS.indexOf(r[4] as (typeof BUILDING_KINDS)[number]))),
    names: rects.map((_, k) => (k === 0 ? 'Riverside Warehouse' : undefined)),
    heightRaster: null,
    attribution: 'test',
  };
}

const US = regionAt(-80, 40.4);

test('footprints rasterise by cell centre, small ones fall back to their centroid cell, and the result is cached', () => {
  const set = buildings([
    [10, 10, 20, 14, 'industrial', 9],
    [30.2, 30.2, 30.6, 30.6, 'house', 6],
  ]);
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  assert.equal(fp.offsets[1] - fp.offsets[0], 10 * 4);
  assert.equal(fp.offsets[2] - fp.offsets[1], 1);
  assert.equal(fp.cells[fp.offsets[1]], 30 * NX + 30);
  assert.ok(Math.abs(fp.areaM2[0] - 40 * CELL * CELL) < 1e-6);
  assert.equal(footprintIndex(set, NX, NY, CELL), footprintIndex(set, NX, NY, CELL));
});

test('sampling takes the worst cell and ignores water that was there at reset', () => {
  const f = fields((i, j) => (i < 12 ? { d: 6, fw: 0 } : j === 12 ? { d: 0.8, v: 1, fw: 900 } : j === 11 ? { d: 0.4, fw: 300 } : {}));
  const set = buildings([[10, 10, 20, 14, 'industrial', 9]]);
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const s = sampleCells(f, fp.cells, fp.offsets[0], fp.offsets[1]);
  assert.equal(s.sampled, 8 * 4); // columns 10 and 11 are river (firstWet 0)
  assert.ok(Math.abs(s.maxDepth - 0.8) < 1e-6);
  assert.equal(s.firstWet, 300);
  assert.equal(s.maxSpeed, 1);
});

test('a flooded block: losses, hazard classes, collapse, earliest arrival and the top-10 order', () => {
  const set = buildings([
    [10, 10, 20, 14, 'industrial', 9], // 1 m of slow water
    [30, 10, 34, 14, 'house', levelsToMeters('2')!], // 2.5 m of 4 m/s water (10 m²/s, past the 5–9 band): collapse
    [40, 40, 44, 44, 'office', levelsToMeters('20')!], // dry
    [50, 10, 54, 14, 'house', 6], // 5 cm: listed but not reached
  ]);
  const f = fields((i, j) => {
    if (j >= 10 && j < 14 && i >= 10 && i < 20) return { d: 1, v: 0.5, fw: 1200 };
    if (j >= 10 && j < 14 && i >= 30 && i < 34) return { d: 2.5, v: 4, fw: 420 };
    if (j >= 10 && j < 14 && i >= 50 && i < 54) return { d: 0.05 };
    return {};
  });
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const { summary: s, impacts } = computeBuildingImpacts(f, set, fp, { region: US, alertTime: 300 });
  assert.equal(s.assessed, 4);
  assert.equal(impacts.length, 3);
  assert.equal(s.reached, 2);
  assert.equal(s.destroyed, 1);
  assert.equal(s.damaged, 2);
  assert.deepEqual(s.aidr, [0, 0, 0, 1, 0, 0, 1]);
  assert.equal(s.earliest?.k, 1);
  assert.equal(s.earliest?.leadTime, 120);
  const wh = impacts.find((b) => b.k === 0)!;
  assert.equal(wh.occ, 'industrial');
  assert.equal(wh.floors, 1); // 9 m tall hall: one storey
  assert.equal(wh.name, 'Riverside Warehouse');
  // 40 cells × 25 m² × $1,250 = $1.25 M structure (60 % damageable), contents ×1.5; NA industrial f(1 m) = 0.5114.
  const S = 40 * 25 * 1250;
  assert.ok(Math.abs(wh.loss - 0.5114 * (0.6 * S + 1.5 * S)) < 1e-3);
  assert.ok(wh.lossLo < wh.loss && wh.loss < wh.lossHi);
  assert.ok(wh.downtimeDays > 21);
  const house = impacts.find((b) => b.k === 1)!;
  assert.equal(house.state, 'collapse');
  assert.equal(house.damage, 1);
  assert.equal(house.aidr, 6);
  assert.equal(house.hrClass, 'extreme');
  assert.ok(Math.abs(s.loss - impacts.reduce((a, b) => a + b.loss, 0)) < 1e-6);
  assert.ok(s.lossLo <= s.loss && s.loss <= s.lossHi);
  assert.ok(s.exposedValue > s.loss);
  const top = topByLoss(impacts, 2);
  assert.ok(top[0].loss >= top[1].loss);
  // Outside the cost tables: hazard and damage still, dollars unknown (NaN), never zero.
  const paris = computeBuildingImpacts(f, set, fp, { region: regionAt(2.35, 48.85) });
  assert.ok(Number.isNaN(paris.summary.loss));
  assert.equal(paris.summary.destroyed, 1);
});

test('a film of water books nothing; an edge-only wetting is flagged by its wet share', () => {
  const set = buildings([
    [10, 10, 14, 14, 'house', 6],
    [30, 10, 40, 20, 'office', 6],
  ]);
  const f = fields((i, j) => (i >= 10 && i < 14 && j >= 10 && j < 14 ? { d: 0.1 } : i === 30 && j >= 10 && j < 20 ? { d: 0.6 } : {}));
  const { impacts } = computeBuildingImpacts(f, set, rasterizeFootprints(set, NX, NY, CELL), { region: US });
  const house = impacts.find((b) => b.k === 0)!;
  assert.equal(house.loss, 0); // NA residential is 0.24 at 0.1 m in the table — below DAMAGE_MIN_DEPTH it is not booked
  assert.equal(house.reached, false);
  const office = impacts.find((b) => b.k === 1)!;
  assert.ok(Math.abs(office.wetFraction - 0.1) < 1e-9);
  assert.ok(office.loss > 0);
});

test('the fast-water rule reads the footprint’s 90th percentile: one fast cell does not write a building off, a building in the current does', () => {
  // A 4 × 4 block (16 cells) under 3 m of water at 1 m/s (3 m²/s), with one cell of 4 m/s (12 m²/s): a jet along an edge.
  const set = buildings([[30, 10, 34, 14, 'office', levelsToMeters('3')!]]);
  const one = fields((i, j) => (j >= 10 && j < 14 && i >= 30 && i < 34 ? { d: 3, v: i === 30 && j === 10 ? 4 : 1, fw: 420 } : {}));
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const s = sampleCells(one, fp.cells, fp.offsets[0], fp.offsets[1]);
  assert.equal(s.maxDV, 12, 'the worst cell is still reported (hazard classes read it)');
  // Linear interpolation at 0.9 × 15 = 13.5 between the 14th and 15th of 16 sorted values (both 3), not the 16th (12).
  assert.equal(s.structDV, 3);
  assert.equal(s.structSpeed, 1);
  const r = computeBuildingImpacts(one, set, fp, { region: US });
  assert.equal(r.impacts[0].state, 'none'); // under the old worst-cell rule: collapse (12 m²/s at 4 m/s)
  assert.equal(r.impacts[0].collapseShare, 0);
  assert.equal(r.impacts[0].dv, 12);
  assert.equal(r.summary.destroyed, 0);
  // The whole block in a 3 m/s current (9 m²/s): written off.
  const all = fields((i, j) => (j >= 10 && j < 14 && i >= 30 && i < 34 ? { d: 3, v: 3, fw: 420 } : {}));
  const r2 = computeBuildingImpacts(all, set, fp, { region: US });
  assert.equal(r2.impacts[0].state, 'collapse');
  assert.equal(r2.impacts[0].damage, 1);
  assert.equal(r2.summary.destroyed, 1);
  // Three of the sixteen cells fast (over a tenth of the footprint): the statistic reads them.
  const three = fields((i, j) => (j >= 10 && j < 14 && i >= 30 && i < 34 ? { d: 3, v: j === 10 && i < 33 ? 3 : 1, fw: 420 } : {}));
  const s3 = sampleCells(three, fp.cells, fp.offsets[0], fp.offsets[1]);
  assert.ok(Math.abs(s3.structDV! - 9) < 1e-9, `${s3.structDV}`);
});

test('without velocity (snapshot fallback) nothing is called collapsed and classes are depth-only', () => {
  const set = buildings([[30, 10, 34, 14, 'house', 6]]);
  const f = fields((i, j) => (j >= 10 && j < 14 && i >= 30 && i < 34 ? { d: 2.5, v: NaN } : {}));
  for (let c = 0; c < f.maxDV.length; c++) f.maxDV[c] = NaN;
  const r = computeBuildingImpacts(f, set, rasterizeFootprints(set, NX, NY, CELL), { region: US, velocityKnown: false });
  assert.equal(r.summary.destroyed, 0);
  assert.equal(r.impacts[0].state, 'unknown');
  assert.equal(r.impacts[0].aidr, 5);
  assert.equal(r.summary.velocityKnown, false);
});

test("access: a building whose street floods is cut off; one whose street stays dry is not; bridges don't count", () => {
  // Two east-west streets: row 20 (floods), row 40 (dry except where it bridges the river at column 5).
  const road = (y: number): RoadNetwork['edges'][number] => ({ a: 0, b: 1, length: 300, cls: 'local', pts: Float32Array.from([2, y, 62, y]) });
  const net: RoadNetwork = { nodes: Float32Array.from([2, 20, 62, 20, 2, 40, 62, 40]), edges: [road(20.5), { ...road(40.5), a: 2, b: 3 }] };
  const f = fields((i, j) => (j >= 18 && j < 23 ? { d: 0.6 } : i === 5 ? { d: 5, fw: 0 } : {}));
  const set = buildings([
    [20, 22, 24, 26, 'house', 6],
    [20, 36, 24, 39, 'house', 6],
  ]);
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const acc = buildingAccess(net, fp, f, CELL);
  assert.equal(acc.status[0], ACCESS_CUT);
  assert.equal(acc.status[1], ACCESS_OPEN);
  assert.ok(acc.roadWetSeconds[0] > 0);
  assert.equal(acc.roadCutAt[0], 600);
  assert.ok(Number.isNaN(acc.roadCutAt[1]));
  const r = computeBuildingImpacts(f, set, fp, { region: US, alertTime: 120 }, acc);
  assert.equal(r.summary.accessCut, 1);
  const b0 = r.impacts.find((b) => b.k === 0);
  // The cut building is listed only if it has water on it; query the index directly for the dry one.
  const q = acc.index!.query(22, 37.5);
  assert.equal(q.status, ACCESS_OPEN);
  assert.ok(q.distanceM > 0 && q.distanceM < 30);
  if (b0) {
    assert.equal(b0.accessCut, true);
    assert.equal(b0.accessLeadTime, 480);
  }
});

test('analyze() through a mocked solver.readHazardFields, and the depth-only fallback accumulator', async () => {
  const set = buildings([[10, 10, 20, 14, 'retail', 4.4]]);
  const f = fields((i, j) => (j >= 10 && j < 14 && i >= 10 && i < 20 ? { d: 1.2, v: 0.8 } : {}));
  const solver = { readHazardFields: async () => f } as unknown as FloodSolver;
  assert.equal(typeof solver.readHazardFields, 'function'); // the UI feature-detects exactly this
  const got = await solver.readHazardFields!();
  const terrain = { nx: NX, ny: NY, cellSize: CELL, bounds: { west: -80.01, south: 40.39, east: -79.99, north: 40.41 }, roads: null, buildings: set };
  const a = analyze({ fields: got, terrain, velocityKnown: true, debrisFlow: false });
  assert.equal(a.region.costCountry, 'US');
  assert.equal(a.report?.summary.reached, 1);
  assert.ok(a.report!.summary.loss > 0);
  assert.throws(() => analyze({ fields: { ...f, nx: 32 }, terrain, velocityKnown: true, debrisFlow: false }));

  // Fallback: three snapshots; the middle one is the peak; a reset (time going back) starts over.
  const acc = new SnapshotHazardAccumulator();
  const base = new Float32Array(NX * NY);
  base[0] = 3; // a river cell
  acc.setBaseline(base);
  const snap = (d: number) => {
    const s = new Float32Array(NX * NY);
    s[0] = 3;
    s[NX + 1] = d;
    return s;
  };
  acc.feed(snap(0), NX, NY, 0);
  acc.feed(snap(0.5), NX, NY, 60);
  acc.feed(snap(0.2), NX, NY, 120);
  const ff = acc.fields()!;
  assert.equal(ff.firstWet[0], 0);
  assert.equal(ff.firstWet[NX + 1], 60);
  assert.ok(Math.abs(ff.maxDepth[NX + 1] - 0.5) < 1e-6);
  assert.equal(ff.wetSeconds[NX + 1], 120); // each snapshot's interval is booked to the state at its end
  assert.ok(Number.isNaN(ff.maxSpeed[0]));
  acc.feed(snap(0), NX, NY, 5);
  assert.equal(acc.fields()!.maxDepth[NX + 1], 0);
  assert.equal(acc.startedAt, 5);
});

// ── Buildings as obstacles (HazardFields.blocked) ──────────────────────────────────────────────────────────────────────

/** What the solver blocks: every cell whose centre is inside a footprint (the same rasterisation rule). */
function blockedMask(set: BuildingSet): Uint8Array {
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const m = new Uint8Array(NX * NY);
  for (let q = 0; q < fp.cells.length; q++) m[fp.cells[q]] = 1;
  return m;
}

test('openCells: a blocked footprint reads the open cells against its walls, through neighbours when walled in', () => {
  // A 2×2-cell house alone, and a terrace of three touching ones (the middle one is open only front and back).
  const set = buildings([
    [10, 10, 12, 12, 'house', 6],
    [20, 20, 22, 22, 'house', 6],
    [22, 20, 24, 22, 'house', 6],
    [24, 20, 26, 22, 'house', 6],
  ]);
  const blocked = blockedMask(set);
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const alone = openCells(fp.cells, fp.offsets[0], fp.offsets[1], blocked, NX, NY)!;
  assert.equal(alone.length, 8, 'the cells against the walls of a 2×2 block');
  for (const c of alone) assert.equal(blocked[c], 0);
  const middle = openCells(fp.cells, fp.offsets[2], fp.offsets[3], blocked, NX, NY)!;
  // Front and back only: rows 19 and 22 over its own columns 22–23.
  assert.equal(middle.length, 4);
  for (const c of middle) assert.equal(blocked[c], 0);
  // A footprint with no blocked cell is sampled as is.
  assert.equal(openCells(fp.cells, fp.offsets[0], fp.offsets[1], new Uint8Array(NX * NY), NX, NY), null);
  // Walled in deeper than OPEN_RING_MAX rings: nothing to read.
  assert.deepEqual(openCells([20 * NX + 20], 0, 1, new Uint8Array(NX * NY).fill(1), NX, NY), []);
});

test('with obstacles the street depth against the walls is booked, not the dry footprint', () => {
  const set = buildings([[10, 10, 14, 14, 'house', 6]]);
  const blocked = blockedMask(set);
  // 0.9 m in the street along the west wall only; the footprint itself is dry (the solver keeps water out of it).
  const f = fields((i, j) => (!blocked[j * NX + i] && i === 9 && j >= 9 && j <= 14 ? { d: 0.9, v: 0.5, fw: 400 } : {}));
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const dry = sampleCells(f, fp.cells, fp.offsets[0], fp.offsets[1]);
  assert.equal(dry.maxDepth, 0, 'without the mask the footprint reads dry');
  const wet = sampleCells({ ...f, blocked }, fp.cells, fp.offsets[0], fp.offsets[1]);
  assert.ok(Math.abs(wet.maxDepth - 0.9) < 1e-6, `perimeter depth ${wet.maxDepth}`);
  assert.equal(wet.firstWet, 400);
  assert.equal(wet.sampled, 16, 'the 16 cells against the walls of a 4×4 block');
  const report = computeBuildingImpacts({ ...f, blocked }, set, fp, { region: US });
  assert.equal(report.summary.reached, 1);
  assert.ok(report.summary.loss > 0);
});

test('with obstacles, water in a gutter below the building pad counts only above the building’s ground', () => {
  const set = buildings([[10, 10, 14, 14, 'house', 6]]);
  const blocked = blockedMask(set);
  // Pad at 1.0 m; the street west of it at 0.8 m with 0.9 m of water (0.7 m above the pad), the street north at 0.95 m
  // with 0.18 m (0.13 m above the pad: not reached), the yard east uphill at 1.3 m with 0.2 m (its own depth counts).
  const ground = new Float32Array(NX * NY).fill(1.0);
  for (let j = 0; j < NY; j++) {
    ground[j * NX + 9] = 0.8;
    ground[j * NX + 14] = 1.3;
  }
  for (let i = 10; i < 14; i++) ground[9 * NX + i] = 0.95;
  const f = fields((i, j) =>
    i === 9 && j >= 10 && j < 14 ? { d: 0.9, v: 1, fw: 400 } : j === 9 && i >= 10 && i < 14 ? { d: 0.18, v: 1, fw: 200 } : i === 14 && j >= 10 && j < 14 ? { d: 0.2, v: 0.5, fw: 300 } : {},
  );
  const fp = rasterizeFootprints(set, NX, NY, CELL);
  const s = sampleCells({ ...f, blocked, ground }, fp.cells, fp.offsets[0], fp.offsets[1]);
  assert.ok(Math.abs(s.maxDepth - 0.7) < 1e-6, `depth above the pad ${s.maxDepth}`);
  assert.ok(Math.abs(s.maxDV - 0.7) < 1e-6, `depth × speed scaled with the depth that reaches the wall: ${s.maxDV}`);
  // North cells (0.13 m above the pad) are not an arrival; the east yard (its own 0.2 m) at 300 s is the first.
  assert.equal(s.firstWet, 300);
  assert.equal(s.reachedCells, 4 + 4, 'west and east walls reached, north not');
});
