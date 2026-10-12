/**
 * EAL, present-value factors and benefit–cost ratios (src/loss/eal.ts), against hand arithmetic and the research
 * spec's Houston warehouse example (§E.4), which is rebuilt here from the damage curve up.
 * Run: node --import tsx --test tests/loss/eal.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bcr,
  breakEvenReturnPeriod,
  DISCOUNT_RATE_FEMA,
  DISCOUNT_RATE_LOW,
  eal,
  ealRange,
  mitigationCost,
  upv,
  upvGrowing,
  wallGeometry,
} from '../../src/loss/eal';
import { curveFor } from '../../src/loss/curves';
import { storeyDamage } from '../../src/loss/value';

const close = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, `${msg ?? ''} ${a} vs ${b}`);

test('EAL on a hand-computed example', () => {
  // T = 10, 100 with losses 10 and 100: trapezoid ½(10+100)(0.1−0.01) = 4.95; tail 100/100 = 1.
  const pts = [
    { T: 100, loss: 100 },
    { T: 10, loss: 10 },
  ];
  close(eal(pts, false), 4.95, 1e-12);
  close(eal(pts, true), 5.95, 1e-12);
  assert.deepEqual(ealRange(pts), { low: eal(pts, false), high: eal(pts, true) });
  assert.equal(eal([]), 0);
  close(eal([{ T: 50, loss: 7 }]), 0.14, 1e-12); // one point: the tail term only
});

test('UPV factors match the spec table (§C.7)', () => {
  close(upv(0.07, 30), 12.41, 0.005);
  close(upv(0.07, 50), 13.8, 0.005);
  close(upv(0.07, 100), 14.27, 0.005);
  close(upv(0.031, 30), 19.35, 0.005);
  close(upv(0.031, 50), 25.25, 0.005);
  close(upv(0.031, 100), 30.73, 0.005);
  assert.equal(upv(0, 20), 20);
  close(upvGrowing(0.07, 50, 0), upv(0.07, 50), 1e-9);
  assert.ok(upvGrowing(0.07, 50, 0.02) > upv(0.07, 50));
});

test("the spec's Houston warehouse: losses per return period, EAL ≈ $1.44 M, BCR ≈ 1.9 (wall) and ≈ 8.7 (deployable)", () => {
  // 500,000 ft² single-storey DC: structure $1,250/m² × 46,450 m², 60 % damageable; inventory $40 M; $250k/day GP.
  const curve = curveFor('industrial', 'northAmerica');
  const structure = 46450 * 1250;
  const lossAt = (depth: number, downtimeDays: number) => {
    const d = storeyDamage({ depth, floors: 1, storeyHeight: 3.2, curve, structureValue: structure, contentsValue: 40e6, undamageable: 0.4, state: 'none' });
    return d.structure + d.contents + downtimeDays * 250e3;
  };
  const table: Array<[number, number, number, number]> = [
    // T, depth m, downtime d, spec loss $M
    [10, 0, 0, 0],
    [25, 0.15, 3, 9.4],
    [50, 0.4, 10, 22.2],
    [100, 0.8, 30, 40.1],
    [500, 1.5, 60, 62.7],
  ];
  const pts = table.map(([T, d, dt, spec]) => {
    const loss = lossAt(d, dt);
    close(loss / 1e6, spec, 0.06, `T=${T}`); // the spec rounds f to 3 dp
    return { T, loss };
  });
  const e = eal(pts);
  close(e / 1e6, 1.44, 0.01, 'EAL');

  // Option A: 900 m wall at $3,500/ft, protects to the 500-yr event (ΔEAL = EAL), 50-yr life.
  const capexA = 3500 * 3.28084 * 900;
  close(capexA / 1e6, 10.3, 0.05);
  const a7 = bcr({ deltaEal: e, capex: capexA, rate: DISCOUNT_RATE_FEMA, years: 50 });
  close(a7.bcr, 1.9, 0.05, 'A @7%');
  const a3 = bcr({ deltaEal: e, capex: capexA, rate: DISCOUNT_RATE_LOW, years: 50 });
  close(a3.bcr, 3.5, 0.06, 'A @3.1%');

  // Option B: deployable barriers $1.5 M + $20k/yr, 85 % effective — the spec's 8.7 / 12.6 come out at a 30-yr life.
  const b7 = bcr({ deltaEal: 0.85 * e, capex: 1.5e6, om: 20e3, rate: DISCOUNT_RATE_FEMA, years: 30 });
  close(b7.bcr, 8.7, 0.1, 'B @7%');
  const b3 = bcr({ deltaEal: 0.85 * e, capex: 1.5e6, om: 20e3, rate: DISCOUNT_RATE_LOW, years: 30 });
  close(b3.bcr, 12.6, 0.1, 'B @3.1%');
  close(b7.npv, b7.pvBenefits - b7.pvCosts, 1e-6);
});

test('break-even return period is where the single-event BCR is 1', () => {
  const T = breakEvenReturnPeriod(10e6, 1e6, 0, 0.07, 50);
  // ΔL/T × UPV = capex  →  T = ΔL × UPV / capex = 10 × 13.80 = 138 yr.
  close(T, 138.0, 0.1);
  const check = bcr({ deltaEal: 10e6 / T, capex: 1e6, rate: 0.07, years: 50 });
  close(check.bcr, 1, 1e-9);
  assert.ok(Number.isNaN(breakEvenReturnPeriod(0, 1e6, 0, 0.07, 50)));
});

test('mitigation unit costs: a 1.5 m US floodwall is ≈ $10k/m, ±50 % band; Nepal uses South-Asian rates', () => {
  const w = mitigationCost('floodwall', 100, 1.5, 'US');
  close(w.perMetre, 10165, 10);
  close(w.mid, 100 * w.perMetre, 1e-6);
  close(w.low, 0.5 * w.mid, 1e-6);
  close(w.high, 1.5 * w.mid, 1e-6);
  const np = mitigationCost('earthen', 1000, 1.5, 'NP');
  close(np.perMetre, 90 * Math.pow(1.5, 1.3), 1e-9);
  assert.ok(mitigationCost('earthen', 100, 3, 'US').mid > mitigationCost('earthen', 100, 2, 'US').mid);
});

test('wall length from the barrier raster: exact for a straight wall, close for a diagonal one', () => {
  const nx = 64;
  const ny = 64;
  const b = new Float32Array(nx * ny);
  for (let i = 10; i < 50; i++) for (let w = 0; w < 3; w++) b[(20 + w) * nx + i] = 2; // 40 × 3 cells
  const g = wallGeometry(b, nx, ny, 5);
  close(g.lengthM, 200, 1e-9);
  close(g.meanHeightM, 2, 1e-9);
  assert.equal(g.cells, 120);
  const d = new Float32Array(nx * ny);
  for (let t = 0; t < 40; t++) for (let w = 0; w < 2; w++) d[(10 + t) * nx + 10 + t + w] = 1.5; // a 2-cell-wide diagonal
  const gd = wallGeometry(d, nx, ny, 5);
  const truth = 40 * Math.SQRT2 * 5;
  assert.ok(gd.lengthM > truth * 0.9 && gd.lengthM < truth * 1.5, `diagonal ${gd.lengthM} vs ${truth}`);
  assert.equal(wallGeometry(new Float32Array(16), 4, 4, 5).lengthM, 0);
});
