/**
 * The avalanche's own runout and the shape of the flood it becomes (research spec §G.9, third pass):
 * src/hazard/runout.ts (Voellmy–Salm sliding block, handover to the routed flood), mass.ts surgeHydrograph, and the
 * chain's use of both — plus HazardChainSpec.routing.tributaries.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChainFile, HazardChainSpec, MassMovement } from '../../src/hazard/types';
import { directFlow, surgeHydrograph, surgeRiseTime } from '../../src/hazard/mass';
import { slideRunout, slideTimeAt } from '../../src/hazard/runout';
import { runChain } from '../../src/hazard/chain';
import { G } from '../../src/hazard/defaults';
import { syntheticValley } from '../helpers/valley';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

/** 8 km of 20 % gorge, then 30 km of 2 % valley; the domain entry at 30 km. */
function gorge(): ChainFile {
  return syntheticValley({
    reaches: [
      { length: 8000, drop: 1600, bottomWidth: 30, sideSlope: 1, n: 0.05 },
      { length: 30000, drop: 600, bottomWidth: 60, sideSlope: 2, n: 0.05 },
    ],
    z0: 4000,
    tableDepth: 60,
    stations: [
      { s: 0, name: 'Runout', kind: 'source', lat: 0, lon: 0 },
      { s: 4000, name: 'Gorge', kind: 'gauge', lat: 0, lon: 0 },
      { s: 20000, name: 'Town', kind: 'town', lat: 0, lon: 0 },
      { s: 36000, name: 'Plant', kind: 'hydro', lat: 0, lon: 0 },
    ],
    entryS: 30000,
  });
}

const MASS: MassMovement = { volume: 27e6, iceFraction: 0.2, fallHeight: 1400, pathLength: 3700 };
const RAMMS = { mu: 0.12, xi: 2500 };

test('surge hydrograph: peak at the front, linear recession, exact volume; rise = slab length / speed', () => {
  const h = surgeHydrograph(14000, 6.2e6, 12);
  close(h.series.total, 6.2e6, 1e-6 * 6.2e6, 'volume');
  assert.equal(h.peak, 14000);
  assert.equal(h.tPeak, 12);
  close(h.series.end, (2 * 6.2e6) / 14000, 1e-9, 'T = 2V/Qp');
  // Chamoli's slab (26.9 Mm³): ℓ = 2·V^(1/3) ≈ 600 m, at 50 m/s ≈ 12 s.
  close(surgeRiseTime({ volume: 26.9e6, iceFraction: 0.2, fallHeight: 1, pathLength: 1 }), (2 * Math.cbrt(26.9e6)) / 50, 1e-9, 'rise');
  // Same peak and volume as the gamma: only the timing within the surge differs.
  const g = directFlow(MASS, { cv: 0.2 });
  const s = directFlow(MASS, { cv: 0.2, shape: 'surge' });
  close(s.series.total, g.series.total, 1e-6 * g.series.total, 'same volume');
  close(s.peak, g.peak, 1e-3 * g.peak, 'same peak (the gamma’s sampled peak is rescaled by < 0.1 %)');
  assert.ok(s.tPeak < 60 && g.tPeak > 240, `surge peak at ${s.tPeak} s, gamma at ${g.tPeak} s`);
  // A degenerate request (rise longer than the whole surge) is clamped, not broken.
  const d = surgeHydrograph(100, 1000, 1e6);
  close(d.series.total, 1000, 1e-9, 'clamped volume');
});

test('sliding block: bounded by the energy line, faster than the flood in the gorge, hands over before the domain, deterministic', () => {
  const file = gorge();
  const qp = directFlow(MASS).peak;
  const r = slideRunout(MASS, file, RAMMS, qp, 0, 30000 - 100);
  // Never faster than a frictionless fall from the detachment to where it is.
  for (const p of r.track) {
    const drop = MASS.fallHeight + (file.zBed[0] - file.zBed[Math.round(p.s / 100)]);
    assert.ok(p.v <= Math.sqrt(2 * G * drop) + 1e-6, `v ${p.v} at ${p.s}`);
  }
  assert.ok(r.vPath > 30 && r.vPath < 100, `path end ${r.vPath} m/s`);
  // On the 20 % gorge the block is the faster: the flood starts below its top; on 2 % it cannot keep up.
  assert.ok(r.sHand > 0 && r.sHand <= 30000 - 100, `handover at ${r.sHand}`);
  assert.ok(r.tHand > r.tPath, 'time runs on');
  for (let k = 1; k < r.track.length; k++) assert.ok(r.track[k].t > r.track[k - 1].t && r.track[k].s > r.track[k - 1].s);
  close(slideTimeAt(r, r.sHand), r.tHand, 1e-9, 'track ends at the handover');
  assert.deepEqual(slideRunout(MASS, file, RAMMS, qp, 0, 29900), r, 'deterministic');
  // More Coulomb friction: slower, and handed over no further down.
  const stiff = slideRunout(MASS, file, { mu: 0.2, xi: 2500 }, qp, 0, 29900);
  assert.ok(stiff.vPath < r.vPath && stiff.sHand <= r.sHand);
  // A bed flatter than μ stops a slow block where it starts.
  const flat = syntheticValley({ reaches: [{ length: 5000, drop: 50, bottomWidth: 40, sideSlope: 1 }], z0: 1000, entryS: 5000 });
  const f = slideRunout({ ...MASS, fallHeight: 10, pathLength: 1000 }, flat, RAMMS, qp, 0, 4900);
  assert.ok(f.vPath === 0 || f.stopped || f.sHand <= 200, `flat: ${JSON.stringify({ v: f.vPath, s: f.sHand })}`);
});

test('chain with a sliding block: the flood starts at the handover, the stations above read the mass, water is conserved', () => {
  const file = gorge();
  const base: HazardChainSpec = {
    trigger: { kind: 'massIntoRiver', mass: MASS, mode: 'directFlow', baseflow: 20, shape: 'surge' },
    profile: 'chain.json',
    rheology: { kind: 'water' },
  } as HazardChainSpec;
  const spec: HazardChainSpec = { ...base, trigger: { ...(base.trigger as Extract<HazardChainSpec['trigger'], { kind: 'massIntoRiver' }>), slide: RAMMS } };
  const plain = runChain(base, file, { cv: 0.2 });
  const slid = runChain(spec, file, { cv: 0.2 });
  const sl = slid.sourceInfo.slide!;
  assert.ok(sl, 'the block ran');
  assert.equal(slid.sourceInfo.s, sl.sHand);
  assert.ok(slid.sourceInfo.notes.some((n) => /Voellmy block/.test(n)) && slid.sourceInfo.notes.some((n) => /hands over/.test(n)));
  // Same water in, same water through the valley (only where and when it starts differ).
  close(slid.source.volume, plain.source.volume, 1e-6 * plain.source.volume, 'source volume');
  assert.ok(Math.abs(slid.routing.massBalance.waterResidual) < 1e-6 * slid.routing.massBalance.waterIn);
  // Stations above the handover read the block passing, with the surge's peak.
  for (const st of slid.stations.filter((x) => x.s < sl.sHand)) {
    close(st.tFront, slideTimeAt(sl, st.s), 1e-9, st.name);
    close(st.qPeak, slid.source.peak, 1e-6 * slid.source.peak, `${st.name} peak`);
  }
  // In the gorge the mass outruns the water: every station downstream is reached no later than without the block.
  for (const st of slid.stations) {
    const p = plain.stations.find((x) => x.name === st.name)!;
    assert.ok(st.tFront <= p.tFront + 1, `${st.name}: ${st.tFront} vs ${p.tFront}`);
  }
  const fronts = slid.stations.map((s) => s.tFront);
  for (let k = 1; k < fronts.length; k++) assert.ok(fronts[k] > fronts[k - 1], 'downstream order');
});

test('spec tributaries join the routed river (and an override replaces them)', () => {
  const file = gorge();
  const spec: HazardChainSpec = {
    trigger: { kind: 'massIntoRiver', mass: MASS, mode: 'directFlow', baseflow: 20 },
    profile: 'chain.json',
    rheology: { kind: 'water' },
    routing: { tributaries: [{ s: 10000, q: 300, name: 'a tributary' }] },
  } as HazardChainSpec;
  const r = runChain(spec, file, { cv: 0.2, routing: { stopFraction: 0.5 } });
  close(r.entryBase, 320, 1e-6, 'baseflow + tributary at the entry');
  const o = runChain(spec, file, { cv: 0.2, tributaries: [], routing: { stopFraction: 0.5 } });
  close(o.entryBase, 20, 1e-6, 'override');
  // A fuller river carries the front no slower.
  const t = (x: typeof r, n: string) => x.stations.find((s) => s.name === n)!.tFront;
  assert.ok(t(r, 'Plant') <= t(o, 'Plant') + 1);
});
