/**
 * Flood-probability ensembles: sampling, member forcing and aggregation (src/loss/ensemble.ts), and the DEM noise field
 * (src/sim/demNoise.ts). Pure; the GPU side is tests/sim/ensemble.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addToTally,
  band,
  bandQuantile,
  defaultRanges,
  DEM_SIGMA_M,
  demSourceOf,
  ENSEMBLE_PER_CELL,
  ENSEMBLE_THRESHOLDS,
  ensembleCellUpdate,
  exceedance,
  floodedArea,
  latinHypercube,
  memberForcing,
  newTally,
  sampleMembers,
  shiftScaleHydrograph,
  summarizeMembers,
  tallySentence,
  type ForcingState,
  type MemberResult,
} from '../../src/loss/ensemble';
import { boxRadiusFor, demPerturbation, smoothField } from '../../src/sim/demNoise';

test('Latin hypercube: one point per stratum in every dimension, inside [0, 1)', () => {
  for (const n of [3, 12, 32]) {
    const pts = latinHypercube(n, 4, 7);
    assert.equal(pts.length, n);
    for (let d = 0; d < 4; d++) {
      const strata = pts.map((p) => Math.floor(p[d] * n)).sort((a, b) => a - b);
      assert.deepEqual(strata, Array.from({ length: n }, (_, i) => i), `n=${n} dim ${d}`);
      for (const p of pts) assert.ok(p[d] >= 0 && p[d] < 1);
    }
  }
});

test('sampling is deterministic in the seed and differs between seeds', () => {
  const r = defaultRanges('3dep');
  const a = sampleMembers(12, r, 42);
  const b = sampleMembers(12, r, 42);
  const c = sampleMembers(12, r, 43);
  assert.deepEqual(a, b);
  assert.notDeepEqual(
    a.map((m) => m.u),
    c.map((m) => m.u),
  );
  assert.equal(new Set(a.map((m) => m.seed)).size, 12, 'every member has its own DEM seed');
});

test('members stay inside their bands and spread across them', () => {
  const r = { ...defaultRanges('3dep'), inflowPct: 20, rainPct: 25, stageM: 0.3, manningLo: 0.025, manningHi: 0.05 };
  const ms = sampleMembers(12, r, 1);
  for (const m of ms) {
    assert.ok(m.inflowFactor >= 0.8 && m.inflowFactor <= 1.2, `inflow ${m.inflowFactor}`);
    assert.ok(m.rainFactor >= 0.75 && m.rainFactor <= 1.25);
    assert.ok(Math.abs(m.stageDelta) <= 0.3);
    assert.ok(m.manningN >= 0.025 && m.manningN <= 0.05);
    assert.equal(m.chain, null);
  }
  // LHS: one member in each twelfth of the inflow band, so the extremes are covered.
  const f = ms.map((m) => m.inflowFactor).sort((a, b) => a - b);
  assert.ok(f[0] < 0.8 + 0.4 / 12 && f[11] > 1.2 - 0.4 / 12, f.join(','));
  // Manning is log-uniform: the stratum boundaries are geometric, so the median sits near √(0.025·0.05).
  const n = ms.map((m) => m.manningN).sort((a, b) => a - b);
  assert.ok(Math.abs((n[5] + n[6]) / 2 - Math.sqrt(0.025 * 0.05)) < 0.004, `median n ${(n[5] + n[6]) / 2}`);
  // Zero-width bands leave the scenario alone.
  const z = sampleMembers(5, { ...r, inflowPct: 0, rainPct: 0, stageM: 0, manningLo: 0.035, manningHi: 0.035 }, 9);
  for (const m of z) assert.deepEqual([m.inflowFactor, m.rainFactor, m.stageDelta, Math.round(m.manningN * 1e6)], [1, 1, 0, 35000]);
});

test('member forcing: inflows, hydrographs, rain, storms, stage (clamped) and Manning n', () => {
  const base: ForcingState = {
    sources: [
      { id: 'a', type: 'inflow', gx: 1, gy: 1, radius: 2, discharge: 100, hydrograph: [{ t: 0, q: 10 }, { t: 600, q: 100 }] },
      { id: 's', type: 'stage', gx: 5, gy: 5, radius: 3, level: 230 },
    ],
    storms: [{ id: 'c', gx: 0, gy: 0, radius: 10, intensity: 50 }],
    rainRate: 20,
    stageOffset: 2.9,
    manningN: 0.035,
  };
  const [m] = sampleMembers(1, defaultRanges('3dep'), 3);
  const mm = { ...m, inflowFactor: 1.2, rainFactor: 0.8, stageDelta: 0.3, manningN: 0.04 };
  const f = memberForcing(base, mm, { stageMax: 3 });
  const a = f.sources[0] as Extract<ForcingState['sources'][number], { type: 'inflow' }>;
  assert.equal(a.discharge, 120);
  assert.deepEqual(a.hydrograph, [{ t: 0, q: 12 }, { t: 600, q: 120 }]);
  assert.deepEqual(f.sources[1], base.sources[1], 'stage sources follow the stage offset, not a factor');
  assert.equal(f.storms[0].intensity, 40);
  assert.equal(f.rainRate, 16);
  assert.equal(f.stageOffset, 3, 'clamped to the slider range');
  assert.equal(f.manningN, 0.04);
  assert.equal(memberForcing(base, { ...mm, stageDelta: -5 }, { stageMax: 3 }).stageOffset, 0);
  assert.equal(memberForcing(base, mm, { stageMax: null }).stageOffset, 2.9, 'no stage control: untouched');
  assert.equal((base.sources[0] as { discharge: number }).discharge, 100, 'the base is not mutated');
});

test('glacier chain: the routed inflow takes a chain member’s peak and front; shiftScaleHydrograph keeps the baseflow', () => {
  const h = [
    { t: 0, q: 50 },
    { t: 300, q: 50 },
    { t: 600, q: 1050 },
    { t: 1200, q: 50 },
  ];
  // Excess above the baseflow doubled, 120 s later.
  const g = shiftScaleHydrograph(h, 2, 120);
  assert.deepEqual(g[0], { t: 0, q: 50 });
  assert.deepEqual(g.find((p) => p.t === 720), { t: 720, q: 2050 });
  // Earlier by 400 s: the curve is re-anchored at 0 with the interpolated value there.
  const e = shiftScaleHydrograph(h, 1, -400);
  assert.equal(e[0].t, 0);
  assert.ok(Math.abs(e[0].q - (50 + (1000 * 100) / 300)) < 1e-9, `q(0) ${e[0].q}`);
  assert.deepEqual(e.find((p) => p.t === 200), { t: 200, q: 1050 });

  const det = { entryPeak: 1000, entryFront: 3600 };
  const members = [500, 800, 1000, 1500, 2000].map((p, k) => ({ entryPeak: p, entryFront: 3600 - (p - 1000) / 10 }));
  const ms = sampleMembers(5, defaultRanges('copernicus'), 11, { det, members });
  const picked = ms.map((m) => m.chain!.peakFactor).sort((a, b) => a - b);
  assert.deepEqual(picked, [0.5, 0.8, 1, 1.5, 2], 'one chain member per stratum');
  for (const m of ms) assert.ok(Math.abs(m.chain!.frontShift + (m.chain!.peakFactor * 1000 - 1000) / 10) < 1e-9);
  const base: ForcingState = { sources: [{ id: 'chain-inflow', type: 'inflow', gx: 0, gy: 0, radius: 2, discharge: 1050, hydrograph: h }], storms: [], rainRate: 0, stageOffset: 0, manningN: 0.035 };
  const big = ms.find((m) => m.chain!.peakFactor === 2)!;
  const f = memberForcing(base, big, { stageMax: null, chainSourceId: 'chain-inflow' });
  assert.equal((f.sources[0] as { discharge: number }).discharge, 2050);
  // Without members, the p10/p50/p90 band (comonotonic: a bigger peak comes earlier).
  const viaBand = sampleMembers(3, defaultRanges('copernicus'), 2, { det, band: { qPeak: [600, 1000, 1800], tFront: [3000, 3600, 4000] } });
  for (const m of viaBand) {
    assert.ok(m.chain!.peakFactor >= 0.6 && m.chain!.peakFactor <= 1.8);
    assert.ok((m.chain!.peakFactor - 1) * m.chain!.frontShift <= 0, 'bigger peak, earlier front');
  }
  assert.equal(bandQuantile([1, 2, 3], 0.05), 1);
  assert.equal(bandQuantile([1, 2, 3], 0.3), 1.5);
  assert.equal(bandQuantile([1, 2, 3], 0.95), 3);
});

test('aggregation: p10/p50/p90, flooded area, the cell tally and per-asset sentences', () => {
  assert.deepEqual(band([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), [2, 6, 10]);
  const row = (i: number, area: number, loss: number): MemberResult => ({
    index: i,
    params: sampleMembers(1, defaultRanges('3dep'), i)[0],
    simTime: 1800,
    floodedM2: area,
    flooded50M2: area / 2,
    reached: area / 100,
    loss,
    lossLo: loss * 0.8,
    lossHi: loss * 1.2,
    runMs: 0,
    readMs: 0,
    lossMs: 0,
  });
  const s = summarizeMembers(Array.from({ length: 11 }, (_, i) => row(i, (i + 1) * 1000, (i + 1) * 1e6)));
  assert.deepEqual(s.floodedM2, [2000, 6000, 10000]);
  assert.deepEqual(s.loss, [2e6, 6e6, 10e6]);
  assert.ok(s.lossWide[0] < s.loss[0] && s.lossWide[1] > s.loss[2]);

  // Flooded area: only land dry at the start (firstWet ≠ 0), over the threshold.
  assert.equal(floodedArea([0.1, 0.2, 0.6, 2], [-1, 120, 300, 0], 2, 0.15), 8);
  assert.equal(floodedArea([0.1, 0.2, 0.6, 2], [-1, 120, 300, 0], 2, 0.5), 4);

  // Cell tally (the GPU pass's CPU mirror).
  const acc = new Float32Array(2 * ENSEMBLE_PER_CELL);
  for (const d of [0.1, 0.2, 0.7, NaN, 0.3]) ensembleCellUpdate(acc, 1, d);
  assert.deepEqual([...acc.slice(4)], [3, 1, Math.fround(1.3), Math.fround(0.7)]);
  assert.equal(exceedance(3, 12), 0.25);
  assert.ok(Number.isNaN(exceedance(1, 0)));

  const t = newTally('a', 'Office');
  for (const d of [0, 0.2, 0.6]) addToTally(t, d, 0);
  assert.equal(t.members, 3);
  assert.equal(t.reached, 2);
  assert.equal(t.over50, 1);
  assert.equal(tallySentence(t), 'floods (> 15 cm) in 2 of 3 members');
  const dry = newTally('b', 'Dry');
  addToTally(dry, 0, 0);
  assert.match(tallySentence(dry), /below 15 cm in all 1 members/);
  // The same strict thresholds as the map's cells: exactly 0.15 m / 0.5 m is not "over" on either.
  const edge = newTally('e', 'Edge');
  addToTally(edge, ENSEMBLE_THRESHOLDS[0], 0);
  addToTally(edge, ENSEMBLE_THRESHOLDS[1], 0);
  const cell = new Float32Array(ENSEMBLE_PER_CELL);
  ensembleCellUpdate(cell, 0, ENSEMBLE_THRESHOLDS[0]);
  ensembleCellUpdate(cell, 0, ENSEMBLE_THRESHOLDS[1]);
  assert.deepEqual([edge.reached, edge.over50], [cell[0], cell[1]], 'asset tally and cell tally agree at the thresholds');
  // Not assessed (outside the map) is never "dry".
  const off = newTally('o', 'Off the map');
  for (let k = 0; k < 3; k++) addToTally(off, NaN, NaN);
  assert.equal(off.outside, 3);
  assert.equal(tallySentence(off), 'is outside the map (not assessed)');
  addToTally(t, NaN, NaN);
  assert.equal(tallySentence(t), 'floods (> 15 cm) in 2 of 3 assessed members (not assessed in 1: outside the map)');
});

test('DEM source and σ come from the attribution line', () => {
  assert.equal(demSourceOf('Elevation: USGS 3DEP · Imagery: USDA NAIP'), '3dep');
  assert.equal(demSourceOf('Elevation: Copernicus DEM GLO-30 (© DLR …)'), 'copernicus');
  assert.equal(demSourceOf('Mapzen Terrarium'), 'terrarium');
  assert.equal(demSourceOf(''), 'unknown');
  assert.equal(defaultRanges('copernicus').demSigmaM, DEM_SIGMA_M.copernicus);
  assert.ok(DEM_SIGMA_M['3dep'] >= 0.1 && DEM_SIGMA_M['3dep'] <= 0.3);
  assert.ok(DEM_SIGMA_M.copernicus >= 2 && DEM_SIGMA_M.copernicus <= 4);
});

test('DEM noise: σ exact, smooth at the correlation length, deterministic, zero under the initial water', () => {
  const nx = 128;
  const ny = 96;
  const opts = { nx, ny, cellSize: 8, sigma: 0.25, corrLenM: 80, seed: 5 };
  const a = demPerturbation(opts);
  const b = demPerturbation(opts);
  assert.deepEqual(a, b, 'deterministic');
  assert.notDeepEqual(a, demPerturbation({ ...opts, seed: 6 }));
  let s = 0;
  let s2 = 0;
  for (const v of a) ((s += v), (s2 += v * v));
  const sd = Math.sqrt(s2 / a.length - (s / a.length) ** 2);
  assert.ok(Math.abs(sd - 0.25) < 1e-3, `σ ${sd}`);
  // Neighbouring cells are strongly correlated (10-cell kernel); cells far apart are not.
  const corr = (lag: number) => {
    let num = 0;
    let n = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i + lag < nx; i++) ((num += a[j * nx + i] * a[j * nx + i + lag]), n++);
    return num / n / (sd * sd);
  };
  assert.ok(corr(1) > 0.95, `lag-1 correlation ${corr(1)}`);
  assert.ok(Math.abs(corr(60)) < 0.35, `lag-60 correlation ${corr(60)}`);
  // A river along row 40–44: no perturbation under it, a fade beside it, full σ far from it.
  const depth = new Float32Array(nx * ny);
  for (let j = 40; j < 45; j++) for (let i = 0; i < nx; i++) depth[j * nx + i] = 2;
  const m = demPerturbation({ ...opts, initialDepth: depth, featherCells: 4 });
  for (let j = 40; j < 45; j++) for (let i = 0; i < nx; i++) assert.equal(m[j * nx + i], 0);
  const rms = (rows: number[]) => Math.sqrt(rows.reduce((acc, j) => acc + Array.from({ length: nx }, (_, i) => m[j * nx + i] ** 2).reduce((x, y) => x + y, 0), 0) / (rows.length * nx));
  assert.ok(rms([39, 45]) < 0.3 * rms([10, 11, 80, 81]), `beside the river ${rms([39, 45])} vs far ${rms([10, 11, 80, 81])}`);
  // The box-filter radius approximates the requested Gaussian σ.
  for (const sg of [2, 5, 12, 25]) {
    const r = boxRadiusFor(sg);
    const eff = Math.sqrt((3 * ((2 * r + 1) ** 2 - 1)) / 12);
    assert.ok(Math.abs(eff - sg) <= 1, `σ ${sg} → r ${r} → ${eff}`);
  }
  assert.equal(smoothField(new Float32Array(4).fill(1), 2, 2, 0)[0], 1);
});
