/**
 * The chain end to end (src/hazard/chain.ts): every trigger kind produces the source it should, stations read out in
 * order with lead times, the ensemble's bands are ordered and reproducible, and the hand-off to the 2-D solver
 * delivers exactly the routed volume on the 2-D clock.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChainFile, GlacialLake, HazardChainSpec } from '../../src/hazard/types';
import { domainClockOffset, massTravelTime, quantile, RAMP_MAX_S, RAMP_MIN_S, recessionRamp, runChain, runEnsemble, toWaterSource } from '../../src/hazard/chain';
import { meanInflow } from '../../src/sim/forcing';
import { syntheticValley } from '../helpers/valley';

const close = (a: number, b: number, tol: number, msg: string) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (±${tol})`);

/** A 30 km valley: 6 km of steep moraine/gorge, then a gentler valley with a town, a hydro intake and the domain. */
function valley(): ChainFile {
  return syntheticValley({
    reaches: [
      { length: 6000, drop: 600, bottomWidth: 20, sideSlope: 1, n: 0.05 },
      { length: 24000, drop: 480, bottomWidth: 45, sideSlope: 2, n: 0.045 },
    ],
    z0: 4500,
    stations: [
      { s: 0, name: 'Lake outlet', kind: 'lake', lat: 0, lon: 0 },
      { s: 9000, name: 'Village', kind: 'town', lat: 0, lon: 0 },
      { s: 18000, name: 'Intake', kind: 'hydro', lat: 0, lon: 0, capacityMW: 30 },
      { s: 29000, name: 'Bridge', kind: 'bridge', lat: 0, lon: 0 },
    ],
    entryS: 25000,
  });
}

const lake: GlacialLake = {
  id: 'L',
  name: 'Test Tsho',
  lat: 0,
  lon: 0,
  elevation: 4500,
  area: 0.3e6,
  volume: { median: 6e6, lo: 3e6, hi: 12e6, method: 'empirical' },
  damType: 'moraine',
  freeboard: 3,
};

function breachSpec(): HazardChainSpec {
  return {
    trigger: { kind: 'breach', lake, breach: { model: 'weirErosion', erosionRate: 30, finalDepth: 20, widthRatio: 2, sideSlope: 1, hypsometry: 1.5 } },
    profile: 'chain.json',
    rheology: { kind: 'water' },
    alertTime: 600,
  };
}

test('breach: source volume is the drainable volume, stations read out downstream in order, lead time = front − alert', () => {
  const file = valley();
  const r = runChain(breachSpec(), file, { baseflow: 15 });
  assert.ok(r.sourceInfo.flood);
  // D = p·V/A = 30 m > 20 m breach → drains V·[1 − (1/3)^1.5] = 0.8075·V.
  close(r.source.volume, 6e6 * (1 - Math.pow(1 / 3, 1.5)), 0.01 * 6e6, 'drained volume');
  const fronts = r.stations.filter((s) => s.kind !== 'lake').map((s) => s.tFront);
  for (let i = 1; i < fronts.length; i++) assert.ok(fronts[i] > fronts[i - 1], 'fronts in order');
  assert.ok(r.stations.every((s) => s.qPeak > s.qBase && s.rise > 0.5));
  for (const s of r.stations) close(r.leadTime![s.name], s.tFront - 600, 1e-9, `lead ${s.name}`);
  // Entry between the intake and the bridge.
  assert.ok(r.entryFront > r.stations[2].tFront && r.entryFront < r.stations[3].tFront);
  assert.ok(r.entry.length > 10 && r.entry.every((p) => Number.isFinite(p.q) && p.q >= 0));
  assert.ok(Math.abs(r.routing.massBalance.waterResidual) < 1e-6 * r.source.volume);
});

test('toWaterSource: exactly the routed volume after the offset, on the 2-D clock, with the entry geometry', () => {
  const file = valley();
  const r = runChain(breachSpec(), file, { baseflow: 15 });
  for (const opts of [{}, { preroll: 0 }, { offset: 0 }]) {
    const ws = toWaterSource(r, file, opts);
    const off = domainClockOffset(r, opts);
    assert.equal(ws.type, 'inflow');
    assert.equal(ws.gx, file.domainEntry.gx);
    assert.equal(ws.hydrograph![0].t, 0);
    // The routed series' bins tile [0, seriesEnd] from t = 0 (the last one short when the run stopped mid-bin).
    let routed = 0;
    let edge = 0;
    for (const p of r.entry) {
      const a = edge;
      const b = (edge = 2 * p.t - a);
      if (b > off) routed += p.q * (b - Math.max(a, off));
    }
    const seriesEnd = edge - off;
    // What the 2-D forcing delivers through the end of the routed series is exactly the routed volume after the offset…
    const delivered = meanInflow(ws, 0, seriesEnd) * seriesEnd;
    close(delivered, routed, 1e-6 * routed, `volume with ${JSON.stringify(opts)}`);
    // … then a finite ramp down to the entry baseflow, which is all the forcing holds after it.
    const h = ws.hydrograph!;
    const end = h[h.length - 1].t;
    const qEnd = meanInflow(ws, seriesEnd, seriesEnd);
    const ramp = recessionRamp(r.entry, r.entryBase, qEnd);
    if (ramp) {
      close(end - seriesEnd, ramp.seconds, 1e-6, 'the ramp lasts its stated duration');
      assert.ok(ramp.seconds >= RAMP_MIN_S && ramp.seconds <= RAMP_MAX_S);
      close(h[h.length - 1].q, r.entryBase, 1e-9, 'it ends on the entry baseflow');
      close(meanInflow(ws, seriesEnd, end) * (end - seriesEnd), r.entryBase * ramp.seconds + ramp.excessVolume, 1e-6 * routed, 'ramp volume = baseflow + (q_end − q_base)·T/2');
    }
    // Afterwards the forcing holds the last point: the baseflow (or a series that already ended on it), nothing more.
    close(meanInflow(ws, end, end + 86400), ramp ? r.entryBase : qEnd, 1e-6, 'afterwards: baseflow only');
    close(ws.discharge, Math.max(...ws.hydrograph!.map((p) => p.q)), 1e-9, 'discharge is the peak');
  }
  // A series cut off while still well above baseflow (an early stop) ramps down instead of holding its last value.
  const early = runChain(breachSpec(), file, { baseflow: 15, routing: { stopFraction: 0.5 } });
  const qLast = early.entry[early.entry.length - 1].q;
  assert.ok(qLast > 2 * early.entryBase, `the early stop ends above baseflow (${qLast.toFixed(0)} vs ${early.entryBase})`);
  const we = toWaterSource(early, file).hydrograph!;
  close(we[we.length - 1].q, early.entryBase, 1e-9, 'back to baseflow');
  assert.ok(we[we.length - 1].t - we[we.length - 2].t >= RAMP_MIN_S);
  // Default: 300 s of baseflow before the front reaches the domain.
  close(domainClockOffset(r), r.entryFront - 300, 1e-9, 'preroll');
  const ws = toWaterSource(r, file);
  assert.ok(ws.hydrograph![0].q < r.entryBase * 1.5, 'the 2-D run starts on baseflow, not on the wave');
});

test('massIntoLake: a big freeboard survives (no flood); a small one overtops and breaches faster than a plain breach', () => {
  const file = valley();
  const mass = { volume: 2e6, iceFraction: 0.5, fallHeight: 600, pathLength: 1500 };
  const mk = (freeboard: number): HazardChainSpec => ({
    ...breachSpec(),
    trigger: { kind: 'massIntoLake', lake: { ...lake, freeboard }, mass, breach: { model: 'weirErosion', erosionRate: 30, finalDepth: 20, widthRatio: 2, sideSlope: 1, hypsometry: 1.5 } },
  });
  const safe = runChain(mk(500), file, { baseflow: 15 });
  assert.equal(safe.sourceInfo.flood, false);
  assert.ok(safe.sourceInfo.notes.some((n) => n.includes('survived')));
  assert.equal(safe.source.peak, 0);
  assert.ok(safe.stations.every((s) => Number.isNaN(s.tFront)), 'no front anywhere');
  const hit = runChain(mk(1), file, { baseflow: 15 });
  assert.ok(hit.sourceInfo.flood && (hit.sourceInfo.overtopVolume ?? 0) > 0);
  const plain = runChain(breachSpec(), file, { baseflow: 15 });
  assert.ok(hit.source.tPeak < plain.source.tPeak, 'the surge-scoured breach peaks sooner');
});

test('massIntoRiver: direct flow carries its sediment; a transient dam fills, then breaches', () => {
  const file = valley();
  const direct: HazardChainSpec = {
    ...breachSpec(),
    trigger: { kind: 'massIntoRiver', mass: { volume: 5e6, iceFraction: 0.3, fallHeight: 1500, pathLength: 5000 }, mode: 'directFlow', baseflow: 15 },
  };
  const d = runChain(direct, file);
  assert.ok(d.sourceInfo.flood && d.sourceInfo.cv === 0.4);
  close(d.source.volume, (5e6 * 0.3 * 0.917) / 0.6, 1, 'mixture volume');
  // The Cv relaxes toward the steep reach's equilibrium and drops out where the valley flattens.
  assert.ok(d.stations[3].cv < d.sourceInfo.cv);

  const dam: HazardChainSpec = {
    ...breachSpec(),
    trigger: { kind: 'massIntoRiver', mass: { volume: 0.3e6, iceFraction: 0.3, fallHeight: 1500, pathLength: 5000 }, mode: 'transientDam', damLength: 500, baseflow: 15 },
  };
  // The dam sits at the source station (s = 0): no valley upstream of it to pond — use a mid-valley source instead.
  const mid: ChainFile = { ...file, stations: [{ s: 12000, name: 'Impact', kind: 'source', lat: 0, lon: 0 }, ...file.stations.filter((s) => s.kind !== 'lake')] };
  const t = runChain(dam, mid);
  assert.ok(t.sourceInfo.dam && t.sourceInfo.dam.height > 1 && t.sourceInfo.dam.impounded > 0);
  assert.ok(t.source.t[0] >= t.sourceInfo.dam.fillTime - 1e-6, 'nothing leaves before the impoundment is full');
  assert.ok(t.sourceInfo.flood);
});

test('transient dam: the routing limit counts from the breach, not t = 0 — a two-day fill still reaches the map edge', () => {
  const file = valley();
  const mid: ChainFile = { ...file, stations: [{ s: 12000, name: 'Impact', kind: 'source', lat: 0, lon: 0 }, ...file.stations.filter((s) => s.kind !== 'lake')] };
  const dam: HazardChainSpec = {
    ...breachSpec(),
    trigger: { kind: 'massIntoRiver', mass: { volume: 2e6, iceFraction: 0.3, fallHeight: 1500, pathLength: 5000 }, mode: 'transientDam', damLength: 500, baseflow: 15 },
  };
  const t = runChain(dam, mid, { routeDx: 400 });
  const fill = t.sourceInfo.dam!.fillTime;
  assert.ok(fill > 24 * 3600, `the impoundment takes ${(fill / 3600).toFixed(1)} h to fill — longer than the 24 h limit`);
  assert.ok(t.sourceInfo.flood);
  assert.ok(Number.isFinite(t.entryFront) && t.entryFront > fill, `front at the map edge ${t.entryFront} s, after the fill`);
  assert.ok(t.entryPeak > 1000, `the breach wave arrives (${t.entryPeak.toFixed(0)} m³/s)`);
  assert.equal(t.routing.timedOut, false);
  // A limit too short for the wave: said so, and the missing front is explained rather than a bare NaN.
  const cut = runChain(dam, mid, { routeDx: 400, routing: { tMax: 600 } });
  assert.equal(cut.routing.timedOut, true);
  assert.ok(Number.isNaN(cut.entryFront));
  assert.ok(cut.sourceInfo.notes.some((n) => /warning: the routing stopped at its 10 min limit/.test(n)), cut.sourceInfo.notes.join(' | '));
  assert.ok(cut.sourceInfo.notes.some((n) => /had not reached the map edge/.test(n)));
});

test('mass movements: the avalanche’s own travel is on the clock — nothing leaves the impact before pathLength / travelSpeed', () => {
  const file = valley();
  const spec = (travelSpeed?: number): HazardChainSpec => ({
    ...breachSpec(),
    trigger: { kind: 'massIntoRiver', mass: { volume: 5e6, iceFraction: 0.3, fallHeight: 1500, pathLength: 6000, ...(travelSpeed ? { travelSpeed } : {}) }, mode: 'directFlow', baseflow: 15 },
  });
  const slow = runChain(spec(30), file);
  const dflt = runChain(spec(), file);
  close(massTravelTime({ volume: 1, iceFraction: 0, fallHeight: 1, pathLength: 6000, travelSpeed: 30 }), 200, 1e-9, '6 km at 30 m/s');
  close(slow.sourceInfo.travelTime!, 200, 1e-9, 'source info');
  close(dflt.sourceInfo.travelTime!, 6000 / 50, 1e-9, 'default AVALANCHE_SPEED 50 m/s');
  assert.ok(slow.source.t[0] >= 200 - 1e-9 && dflt.source.t[0] >= 120 - 1e-9, 'the hydrograph starts when the mass arrives');
  // Same flood, shifted: the downstream fronts move by the difference in travel time.
  const st = (r: typeof slow) => r.stations[r.stations.length - 1].tFront;
  close(st(slow) - st(dflt), 80, 15, 'fronts shift by the extra 80 s');
});

test('meltAnomaly: no flood wave — the entry carries the raised baseflow; given: the series as published', () => {
  const file = valley();
  const melt: HazardChainSpec = { ...breachSpec(), trigger: { kind: 'meltAnomaly', glacierArea: 50e6, meanElevation: 5200, debrisFraction: 0.3, deltaT: 3, days: 10 } };
  const m = runChain(melt, file, { baseflow: 15 });
  assert.equal(m.sourceInfo.flood, false);
  assert.ok((m.sourceInfo.meltQ ?? 0) > 5);
  const last = m.entry[m.entry.length - 1].q;
  close(last, 15 + m.sourceInfo.meltQ!, 0.5, 'entry = baseflow + melt');

  const given: HazardChainSpec = { ...breachSpec(), trigger: { kind: 'given', hydrograph: [[0, 0], [600, 900], [2400, 0]], provenance: 'reconstructed' } };
  const g = runChain(given, file, { baseflow: 15 });
  close(g.source.volume, 0.5 * 900 * 2400, 1e-6, 'given volume');
  close(g.source.peak, 900, 1e-9, 'given peak');
});

test('ensemble: 27 members, p10 ≤ p50 ≤ p90, bigger lakes and faster erosion peak higher; deterministic', () => {
  const file = valley();
  const a = runEnsemble(breachSpec(), file, { baseflow: 15 });
  const b = runEnsemble(breachSpec(), file, { baseflow: 15 });
  assert.equal(a.members.length, 27);
  const e = a.result.ensemble!;
  assert.ok(e.qPeak[0] <= e.qPeak[1] && e.qPeak[1] <= e.qPeak[2], `qPeak ${e.qPeak}`);
  assert.ok(e.tFront[0] <= e.tFront[1] && e.tFront[1] <= e.tFront[2], `tFront ${e.tFront}`);
  assert.ok(e.qPeak[2] > e.qPeak[0] * 1.5, 'a real spread');
  for (const band of Object.values(a.stationBands)) {
    assert.ok(band.qPeak[0] <= band.qPeak[1] && band.qPeak[1] <= band.qPeak[2]);
    assert.ok(band.tFront[0] <= band.tFront[1] && band.tFront[1] <= band.tFront[2]);
  }
  const peak = (vf: number, k: number) => a.members.find((m) => m.volumeFactor === vf && m.erosionRate === k && m.cv === 0)!.entryPeak;
  assert.ok(peak(2, 30) > peak(0.5, 30), 'bigger lake, bigger peak');
  assert.ok(peak(1, 100) > peak(1, 10), 'faster erosion, bigger peak');
  assert.deepEqual(
    a.members.map((m) => [m.entryPeak, m.entryFront]),
    b.members.map((m) => [m.entryPeak, m.entryFront]),
    'same inputs, same ensemble',
  );
  assert.deepEqual(a.result.entry, b.result.entry);
});

test('quantile: type-7 interpolation, never-arrived counts as +∞', () => {
  assert.equal(quantile([1, 2, 3, 4, 5], 0.5), 3);
  close(quantile([1, 2, 3, 4, 5], 0.1), 1.4, 1e-12, 'p10');
  assert.equal(quantile([1, NaN, 3], 0.9), Infinity);
});
