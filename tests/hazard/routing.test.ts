/**
 * 1-D routing (src/hazard/routing.ts) against what a river must do: hold Manning normal depth in a uniform channel,
 * carry a small disturbance at the kinematic celerity dQ/dA (≈ 5/3·u in a wide channel), attenuate a flood peak
 * monotonically, pass flow over a weir at its rating and slow it through a reservoir, conserve water (and sediment)
 * to rounding, stay positive and bounded on a dry steep bed — and do it fast enough for an ensemble.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalDepth, prepareNetwork, readProbe, resampleProfile, route } from '../../src/hazard/routing';
import { Series } from '../../src/hazard/series';
import { weirErosionBreach } from '../../src/hazard/breach';
import { prismaticChannel, syntheticValley, trapezoid } from '../helpers/valley';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

test('uniform prismatic channel settles at Manning normal depth (dry start, 4 h of constant inflow)', () => {
  const S0 = 0.004;
  const n = 0.035;
  const b = 40;
  const Q = 150;
  const file = prismaticChannel(20000, S0, b, 0, n);
  // Analytic normal depth of the rectangular channel: Q = (1/n)·b·h·(bh/(b+2h))^{2/3}·√S0.
  let lo = 0;
  let hi = 20;
  for (let i = 0; i < 80; i++) {
    const h = 0.5 * (lo + hi);
    const A = b * h;
    if ((A * Math.pow(A / (b + 2 * h), 2 / 3) * Math.sqrt(S0)) / n < Q) lo = h;
    else hi = h;
  }
  const hn = 0.5 * (lo + hi);
  close(normalDepth(prepareNetwork(file), 100, Q, S0), hn, 1e-3 * hn, 'table normal depth');
  const r = route(file, { inflows: [], baseflow: Q, dryStart: true, tEnd: 4 * 3600, cvMode: 'tracer', probes: [{ name: 'mid', s: 10000 }] });
  const p = r.probes[0];
  const hSim = p.stage[p.stage.length - 1] - file.zBed[p.node];
  close(hSim, hn, 0.01 * hn, 'simulated depth at mid-reach');
  close(p.q[p.q.length - 1], Q, 0.005 * Q, 'steady discharge');
});

test('a small disturbance travels at the kinematic celerity dQ/dA ≈ 5/3·u (wide channel)', () => {
  const S0 = 0.001;
  const n = 0.03;
  const b = 300;
  const Q0 = 600;
  const file = prismaticChannel(40000, S0, b, 0, n);
  // A +5 % smooth bump on top of steady flow.
  const t: number[] = [];
  const q: number[] = [];
  for (let k = 0; k <= 120; k++) {
    const tt = k * 30;
    t.push(tt);
    q.push(0.05 * Q0 * Math.pow(Math.sin((Math.PI * tt) / 3600), 2));
  }
  const r = route(file, {
    inflows: [{ s: 0, series: new Series(t, q) }],
    baseflow: Q0,
    spinUp: 3 * 3600,
    tEnd: 6 * 3600,
    cvMode: 'tracer',
    probes: [
      { name: 'a', s: 10000 },
      { name: 'b', s: 30000 },
    ],
  });
  const [a, bb] = r.probes.map((p) => readProbe(r.t, p));
  const c = 20000 / (bb.tPeak - a.tPeak);
  // Exact dQ/dA of Manning in this rectangle at the base flow, and the wide-channel 5/3·u.
  const net = prepareNetwork(file);
  const h0 = normalDepth(net, 200, Q0, S0);
  const qOf = (h: number) => {
    const A = b * h;
    return (A * Math.pow(A / (b + 2 * h), 2 / 3) * Math.sqrt(S0)) / n;
  };
  const ck = (qOf(h0 + 0.001) - qOf(h0 - 0.001)) / (b * 0.002);
  const u = Q0 / (b * h0);
  close(c / ck, 1, 0.08, `celerity ${c.toFixed(3)} m/s vs dQ/dA ${ck.toFixed(3)}`);
  close(c / u, 5 / 3, 0.15, `celerity / u (u = ${u.toFixed(3)} m/s)`);
});

test('a flood peak attenuates monotonically down a uniform channel, and the front arrives in order', () => {
  const file = prismaticChannel(50000, 0.003, 60, 2, 0.04);
  const src = weirErosionBreach({ volume: 2e6, depth: 15, erosionRate: 60 });
  const stations = [2000, 10000, 20000, 30000, 40000, 49000];
  const r = route(file, { inflows: [{ s: 0, series: src.series }], baseflow: 30, cvMode: 'tracer', probes: stations.map((s) => ({ name: `${s}`, s })) });
  const out = r.probes.map((p) => readProbe(r.t, p));
  for (let i = 1; i < out.length; i++) {
    assert.ok(out[i].qPeak < out[i - 1].qPeak, `peak at ${stations[i]} (${out[i].qPeak}) < at ${stations[i - 1]} (${out[i - 1].qPeak})`);
    assert.ok(out[i].tFront > out[i - 1].tFront, 'front arrives in order');
    assert.ok(out[i].tPeak > out[i - 1].tPeak, 'peak arrives in order');
  }
  assert.ok(out[0].qPeak <= src.peak * 1.001 + 30, 'never above the source peak + baseflow');
});

test('steep supercritical reach: the wave stays bounded (no roll-wave spikes above the source peak)', () => {
  // 5 % slope: Fr ≈ 1.3–2.4. Bates' local-inertial without advection turned a 2,900 m³/s pulse into 30,000 m³/s here.
  const file = syntheticValley({ reaches: [{ length: 30000, drop: 1500, bottomWidth: 25, sideSlope: 1, n: 0.05 }], z0: 3000, tableDepth: 60 });
  const src = new Series([0, 600, 2400, 2401], [0, 2900, 0, 0]);
  const r = route(file, { inflows: [{ s: 0, series: src }], baseflow: 50, cvMode: 'tracer', probes: [5000, 15000, 29000].map((s) => ({ name: `${s}`, s })) });
  for (const p of r.probes) {
    const o = readProbe(r.t, p);
    assert.ok(o.qPeak < 2950 + 50, `${p.name}: ${o.qPeak}`);
    assert.ok(o.qPeak > 1500, `${p.name}: the wave got there (${o.qPeak})`);
  }
  assert.equal(r.capped, 0, 'the speed cap never bound');
});

test('mass conservation to rounding: valley with a reservoir weir, tributary, bulking and deposition', () => {
  const file = syntheticValley({
    reaches: [
      { length: 8000, drop: 600, bottomWidth: 20, sideSlope: 1, n: 0.05 },
      { length: 12000, drop: 120, bottomWidth: 50, sideSlope: 2, n: 0.04 },
    ],
    z0: 2000,
    structures: [{ s: 15000, name: 'barrage', kind: 'weir', crest: 2000 - 600 - 70 + 6, width: 40, storage: [[2000 - 670, 0], [2000 - 660, 2e6], [2000 - 650, 5e6]] }],
  });
  const src = weirErosionBreach({ volume: 3e6, depth: 20, erosionRate: 100 });
  for (const cvMode of ['relax', 'tracer'] as const) {
    const r = route(file, {
      inflows: [{ s: 500, series: src.series, cv: 0.3 }],
      baseflow: 25,
      tributaries: [{ s: 9000, q: 40 }],
      cvMode,
      stopWhenPassed: false,
    });
    const m = r.massBalance;
    const scale = m.waterIn + m.waterStored0;
    assert.ok(Math.abs(m.waterResidual) < 1e-9 * scale, `${cvMode} water residual ${m.waterResidual} of ${scale}`);
    assert.ok(Math.abs(m.sedimentResidual) < 1e-9 * scale, `${cvMode} sediment residual ${m.sedimentResidual}`);
    if (cvMode === 'tracer') assert.equal(m.sedimentEntrained, 0);
    else assert.ok(m.sedimentEntrained < 0, 'the steep-reach load deposits where the valley flattens');
    // What crossed the outlet face is what the entry series says (default entry = outlet).
    close(r.entry.volume, m.waterOut + m.sedimentOut, 1e-6 * r.entry.volume, 'entry series volume');
  }
});

test('weir: steady flow passes at the broad-crested rating; a reservoir behind it delays and lowers the peak', () => {
  const crest = 1000 - 50 + 5; // 5 m above the bed at s ≈ 10 km of a 1 %-sloped reach (bed 950 m there)
  const mk = (storage?: Array<[number, number]>) =>
    syntheticValley({
      reaches: [{ length: 20000, drop: 100, bottomWidth: 30, sideSlope: 0, n: 0.04 }],
      z0: 1000,
      structures: [{ s: 10050, name: 'weir', kind: 'weir', crest, width: 30, storage }],
    });
  const Q = 120;
  const steady = route(mk(), { inflows: [], baseflow: Q, spinUp: 4 * 3600, tEnd: 600, cvMode: 'tracer', probes: [{ name: 'up', s: 10000 }] });
  const head = steady.probes[0].stage[steady.probes[0].stage.length - 1] - crest;
  close(head, Math.pow(Q / (1.7 * 30), 2 / 3), 0.06, 'head over the crest (free weir)');

  const src = new Series([0, 900, 2700, 2701], [0, 1500, 0, 0]);
  const run = (file: ReturnType<typeof mk>) =>
    readProbe(
      ...((r) => [r.t, r.probes[0]] as const)(route(file, { inflows: [{ s: 0, series: src }], baseflow: Q, cvMode: 'tracer', probes: [{ name: 'below', s: 12000 }] })),
    );
  const plain = run(mk());
  const reservoir = run(mk([[crest - 5, 0], [crest, 1e6], [crest + 10, 1e7]]));
  assert.ok(reservoir.qPeak < 0.9 * plain.qPeak, `reservoir lowers the peak (${reservoir.qPeak} vs ${plain.qPeak})`);
  assert.ok(reservoir.tPeak > plain.tPeak, 'and delays it');
});

test('dry steep bed: a big pulse stays finite and positive, and the run is deterministic', () => {
  const file = syntheticValley({ reaches: [{ length: 15000, drop: 1200, bottomWidth: 15, sideSlope: 1, n: 0.05 }], z0: 3000 });
  const src = new Series([0, 120, 900, 901], [0, 8000, 0, 0]);
  const opts = { inflows: [{ s: 0, series: src, cv: 0.4 }], dryStart: true, probes: [5000, 14000].map((s) => ({ name: `${s}`, s })) };
  const a = route(file, opts);
  const b = route(file, opts);
  for (const p of a.probes) for (const v of p.stage) assert.ok(Number.isFinite(v));
  for (const p of a.probes) for (let i = 0; i < p.stage.length; i++) assert.ok(p.stage[i] >= file.zBed[p.node] - 1e-9);
  assert.deepEqual(Array.from(a.entry.q), Array.from(b.entry.q), 'same inputs, same bits');
  assert.deepEqual(Array.from(a.probes[1].q), Array.from(b.probes[1].q));
});

test('performance: 100 km at 100 m spacing (measured and logged; the bound is generous on purpose)', (t) => {
  const file = syntheticValley({
    reaches: [
      { length: 20000, drop: 1000, bottomWidth: 25, sideSlope: 1, n: 0.05 },
      { length: 40000, drop: 800, bottomWidth: 40, sideSlope: 1.5, n: 0.05 },
      { length: 40000, drop: 200, bottomWidth: 80, sideSlope: 3, n: 0.04 },
    ],
    z0: 3000,
    tableDepth: 60,
  });
  const src = weirErosionBreach({ volume: 5e6, depth: 18, erosionRate: 100 });
  const opts = { inflows: [{ s: 0, series: src.series }], baseflow: 50, probes: [{ name: 'end', s: 99000 }] };
  route(file, opts); // warm the JIT
  const r = route(file, opts);
  const coarse = route(resampleProfile(file, 250), opts);
  const nsPerNodeStep = (r.ms * 1e6) / r.nodeSteps;
  // An ensemble member: same run, stopped once the flood is half past the last probe (chain.ts MEMBER_STOP_FRACTION).
  const member = route(file, { ...opts, stopFraction: 0.5 });
  t.diagnostic(
    `100 km @ 100 m: ${r.ms.toFixed(0)} ms, ${r.steps} steps (dt ${r.dtMean.toFixed(2)} s, ${(r.tEnd / 3600).toFixed(1)} h simulated), ` +
      `${(r.nodeSteps / 1e6).toFixed(2)} M node updates (${((100 * r.nodeSteps) / (r.steps * file.s.length)).toFixed(0)} % of every node every step), ` +
      `${nsPerNodeStep.toFixed(0)} ns each; as an ensemble member (early stop): ${member.ms.toFixed(0)} ms, ${(member.tEnd / 3600).toFixed(1)} h; @ 250 m: ${coarse.ms.toFixed(0)} ms`,
  );
  assert.ok(r.ms < 5000, `${r.ms} ms`);
  // The coarse grid gives the same picture: peak at the end within 15 %.
  const fine = readProbe(r.t, r.probes[0]);
  const crs = readProbe(coarse.t, coarse.probes[0]);
  close(crs.qPeak / fine.qPeak, 1, 0.15, 'coarse vs fine peak');
  close(crs.tFront / fine.tFront, 1, 0.1, 'coarse vs fine front');
});

test('quiescent-reach window and early stop: same fronts and peaks for less work, water still conserved', () => {
  const file = syntheticValley({
    reaches: [
      { length: 20000, drop: 1000, bottomWidth: 25, sideSlope: 1, n: 0.05 },
      { length: 40000, drop: 800, bottomWidth: 40, sideSlope: 1.5, n: 0.05 },
    ],
    z0: 3000,
    tableDepth: 60,
  });
  const src = weirErosionBreach({ volume: 5e6, depth: 18, erosionRate: 100 });
  const probes = [10000, 30000, 59000].map((s) => ({ name: `${s}`, s }));
  const base = { inflows: [{ s: 0, series: src.series }], baseflow: 50, tributaries: [{ s: 40000, q: 30 }], probes, entryS: 50000 };
  const full = route(file, { ...base, window: false });
  const win = route(file, base);
  const early = route(file, { ...base, stopFraction: 0.5 });
  assert.ok(win.nodeSteps < 0.85 * full.nodeSteps, `window: ${win.nodeSteps} vs ${full.nodeSteps} node-steps`);
  assert.ok(early.tEnd < 0.8 * win.tEnd, `early stop at ${early.tEnd} s vs ${win.tEnd} s`);
  for (let k = 0; k < probes.length; k++) {
    const a = readProbe(full.t, full.probes[k]);
    for (const r of [win, early]) {
      const b = readProbe(r.t, r.probes[k]);
      close(b.tFront, a.tFront, 10, `${probes[k].name}: front`);
      close(b.qPeak / a.qPeak, 1, 0.01, `${probes[k].name}: peak`);
    }
  }
  // The steady reach beyond the window passes on what enters it, so the books still close to rounding, and the entry
  // series (its face beyond the window at first) carries that water.
  for (const r of [win, early]) {
    const m = r.massBalance;
    assert.ok(Math.abs(m.waterResidual) < 1e-9 * (m.waterIn + m.waterStored0), `water residual ${m.waterResidual}`);
  }
  close(win.entry.volume / full.entry.volume, 1, 2e-3, 'entry volume');
});

test('trapezoid helper matches the closed forms the routing tables are built from', () => {
  const g = trapezoid(10, 2, 3);
  close(g.area, (10 + 6) * 3, 1e-12, 'area');
  close(g.width, 22, 1e-12, 'width');
  close(g.perimeter, 10 + 6 * Math.sqrt(5), 1e-12, 'perimeter');
});
