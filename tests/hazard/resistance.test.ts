/**
 * Ferguson (2007) variable-power resistance equation (src/hazard/resistance.ts) and its use in the 1-D routing:
 * the curve's values and both asymptotes, normal depth and steady flow under it, mass conservation and stability on
 * steep (5–30 %) dry and wet beds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { G, VPE_A1, VPE_A2 } from '../../src/hazard/defaults';
import { d84At, fergusonVpe, vpeCf, vpeManningN } from '../../src/hazard/resistance';
import { normalDepth, prepareNetwork, readProbe, resistanceTable, route, type RoutingOptions } from '../../src/hazard/routing';
import { Series } from '../../src/hazard/series';
import { weirErosionBreach } from '../../src/hazard/breach';
import type { ResistanceLaw } from '../../src/hazard/types';
import { prismaticChannel, syntheticValley } from '../helpers/valley';

const rel = (a: number, b: number) => Math.abs(a - b) / Math.abs(b);

test('VPE reproduces Ferguson’s (2007) curve: U/u* at sample R/D84', () => {
  assert.equal(VPE_A1, 6.5);
  assert.equal(VPE_A2, 2.5);
  // U/u* = 16.25·x / √(42.25 + 6.25·x^{5/3}); values evaluated independently (4 significant figures).
  const cases: Array<[number, number]> = [
    [0.5, 1.222], // shallow: boulders poke through, ≈ a2·x = 1.25
    [1, 2.333],
    [2, 4.124],
    [5, 7.029],
    [10, 8.914],
    [20, 10.47],
    [50, 12.41],
  ];
  for (const [x, v] of cases) assert.ok(rel(fergusonVpe(x), v) < 2e-3, `x = ${x}: ${fergusonVpe(x)} vs ${v}`);
  // Monotone in submergence.
  let prev = 0;
  for (let x = 0.05; x < 200; x *= 1.2) {
    const v = fergusonVpe(x);
    assert.ok(v > prev, `increasing at ${x}`);
    prev = v;
  }
  // Cf = (u*/U)², n_eq = R^{1/6}/(√g·U/u*), and g·n²/R^{1/3} = Cf (the identity the router's friction term uses).
  for (const R of [0.3, 2, 8, 25]) {
    const n = vpeManningN(R, 0.5);
    assert.ok(rel((G * n * n) / Math.cbrt(R), vpeCf(R, 0.5)) < 1e-12);
  }
});

test('VPE asymptotes: Manning–Strickler at high submergence, the roughness-layer law at low', () => {
  for (const d84 of [0.2, 0.5, 1]) {
    // Deep: U/u* → a1·(R/D84)^{1/6}, i.e. a constant n = D84^{1/6}/(a1·√g).
    const nStrickler = Math.pow(d84, 1 / 6) / (VPE_A1 * Math.sqrt(G));
    const deep = [100, 1000, 10000].map((x) => rel(vpeManningN(x * d84, d84), nStrickler));
    assert.ok(deep[0] < 0.06 && deep[1] < 0.015 && deep[2] < 0.003, `D84 ${d84}: ${deep.map((e) => e.toFixed(4)).join(', ')}`);
    assert.ok(deep[1] < deep[0] && deep[2] < deep[1], 'converging');
    // Shallow: U/u* → a2·R/D84.
    for (const x of [0.01, 0.05]) assert.ok(rel(fergusonVpe(x), VPE_A2 * x) < 0.02, `shallow x = ${x}`);
  }
  // The deep-flow n of a 0.5 m boulder bed is ~0.044: the VPE does not give a "smooth" flood channel.
  assert.ok(Math.abs(Math.pow(0.5, 1 / 6) / (VPE_A1 * Math.sqrt(G)) - 0.0439) < 5e-4);
});

test('D84 reaches: a value applies from its chainage downstream', () => {
  const r = [
    { s: 0, d84: 0.8 },
    { s: 10000, d84: 0.4 },
  ];
  assert.equal(d84At(0.5, 123), 0.5);
  assert.equal(d84At(r, -5), 0.8);
  assert.equal(d84At(r, 9999), 0.8);
  assert.equal(d84At(r, 10000), 0.4);
  assert.equal(d84At(r, 50000), 0.4);
});

test('VPE routing: a prismatic channel settles at the VPE normal depth; the Manning path is unchanged without it', () => {
  const S0 = 0.01;
  const b = 40;
  const Q = 300;
  const d84 = 0.5;
  const law: ResistanceLaw = { law: 'ferguson2007', d84 };
  const file = prismaticChannel(20000, S0, b, 0, 0.05);
  // Analytic: Q = b·h·(U/u*)·√(g·R·S0), R = bh/(b+2h).
  let lo = 0;
  let hi = 30;
  for (let i = 0; i < 80; i++) {
    const h = 0.5 * (lo + hi);
    const R = (b * h) / (b + 2 * h);
    if (b * h * fergusonVpe(R / d84) * Math.sqrt(G * R * S0) < Q) lo = h;
    else hi = h;
  }
  const hn = 0.5 * (lo + hi);
  const net = prepareNetwork(file);
  const tab = resistanceTable(net, law);
  assert.ok(tab && resistanceTable(net, law) === tab, 'cached per network and law');
  assert.ok(rel(normalDepth(net, 100, Q, S0, tab), hn) < 2e-3, `normal depth ${normalDepth(net, 100, Q, S0, tab)} vs ${hn}`);
  const r = route(file, { inflows: [], baseflow: Q, dryStart: true, tEnd: 3 * 3600, cvMode: 'tracer', resistance: law, probes: [{ name: 'mid', s: 10000 }] });
  const p = r.probes[0];
  const hSim = p.stage[p.stage.length - 1] - file.zBed[p.node];
  assert.ok(rel(hSim, hn) < 0.01, `simulated depth ${hSim} vs ${hn}`);
  assert.ok(rel(p.q[p.q.length - 1], Q) < 0.005);
  // 'manning' and no law route identically, bit for bit.
  const opts = { inflows: [], baseflow: Q, dryStart: true, tEnd: 1800, cvMode: 'tracer' as const, probes: [{ name: 'mid', s: 10000 }] };
  assert.deepEqual(Array.from(route(file, { ...opts, resistance: { law: 'manning' } }).probes[0].q), Array.from(route(file, opts).probes[0].q));
});

test('VPE routing on steep beds (5, 10, 20, 30 %): bounded, positive, deterministic, water and sediment conserved', () => {
  const law: ResistanceLaw = { law: 'ferguson2007', d84: [{ s: 0, d84: 1 }, { s: 6000, d84: 0.5 }] };
  for (const slope of [0.05, 0.1, 0.2, 0.3]) {
    const L = 12000;
    const file = syntheticValley({ reaches: [{ length: L, drop: slope * L, bottomWidth: 20, sideSlope: 1, n: 0.05 }], z0: 5000, tableDepth: 60 });
    const src = new Series([0, 300, 1500, 1501], [0, 5000, 0, 0]);
    for (const dryStart of [true, false]) {
      const opts: RoutingOptions = {
        inflows: [{ s: 0, series: src, cv: 0.4 }],
        ...(dryStart ? { dryStart: true } : { baseflow: 30 }),
        resistance: law,
        stopWhenPassed: false,
        probes: [3000, 9000, 11500].map((s) => ({ name: `${s}`, s })),
      };
      const r = route(file, opts);
      const tag = `${slope * 100} % ${dryStart ? 'dry' : 'wet'}`;
      for (const p of r.probes) {
        for (let i = 0; i < p.q.length; i++) {
          assert.ok(Number.isFinite(p.q[i]) && Number.isFinite(p.stage[i]), `${tag}: finite`);
          assert.ok(p.stage[i] >= file.zBed[p.node] - 1e-9, `${tag}: positive depth`);
        }
        const o = readProbe(r.t, p);
        // No roll-wave spikes: never above the source peak (+ baseflow), bulking included (×1/(1−Cv) at most 0.65).
        assert.ok(o.qPeak < 5000 / (1 - 0.65) + 30, `${tag} ${p.name}: peak ${o.qPeak}`);
        assert.ok(o.qPeak > 500, `${tag} ${p.name}: the wave got there (${o.qPeak})`);
      }
      const m = r.massBalance;
      const scale = m.waterIn + m.waterStored0;
      assert.ok(Math.abs(m.waterResidual) < 1e-9 * scale, `${tag}: water residual ${m.waterResidual}`);
      assert.ok(Math.abs(m.sedimentResidual) < 1e-9 * scale, `${tag}: sediment residual ${m.sedimentResidual}`);
      assert.ok(r.uPeak <= 30 + 1e-9, `${tag}: speed ${r.uPeak}`);
      assert.deepEqual(Array.from(route(file, opts).entry.q), Array.from(r.entry.q), `${tag}: deterministic`);
    }
  }
});

test('VPE vs Manning n = 0.05 on a flood: faster at flood depth over a 0.5 m bed, slower at baseflow depth', () => {
  // The two claims the preset calibration rests on, measured on one channel: deep flow over D84 = 0.5 m is less
  // resistant than n = 0.05 (n_eq → 0.044); shallow flow is more.
  const nDeep = vpeManningN(10, 0.5);
  const nShallow = vpeManningN(0.5, 0.5);
  assert.ok(nDeep < 0.05 && nDeep > 0.04, `n_eq at R = 10 m: ${nDeep}`);
  assert.ok(nShallow > 0.1, `n_eq at R = 0.5 m: ${nShallow}`);
  const file = syntheticValley({ reaches: [{ length: 30000, drop: 900, bottomWidth: 30, sideSlope: 1, n: 0.05 }], z0: 3000 });
  const src = weirErosionBreach({ volume: 20e6, depth: 30, erosionRate: 100 });
  const run = (resistance?: ResistanceLaw) =>
    readProbe(...((r) => [r.t, r.probes[0]] as const)(route(file, { inflows: [{ s: 0, series: src.series }], baseflow: 50, cvMode: 'tracer', resistance, probes: [{ name: 'x', s: 25000 }] })));
  const man = run();
  const vpe = run({ law: 'ferguson2007', d84: 0.5 });
  assert.ok(vpe.tPeak < man.tPeak, `peak earlier under the VPE (${vpe.tPeak} vs ${man.tPeak} s)`);
});
