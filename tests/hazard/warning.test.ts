/**
 * The early-warning designer (src/hazard/warning.ts) and the front-arrival profile behind it (frontProfile.ts):
 * lead time grows as the sensor moves upstream, latency subtracts one for one, the optimiser's site matches a brute-force
 * sweep, seismic detection does not care where the sensor is, the ensemble bands are ordered — and on the baked Nepal
 * profile, what a sensor at Rasuwagadhi or Syafrubesi would have given Betrawati (printed as a diagnostic).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChainFile, GlacialLake, HazardChainSpec } from '../../src/hazard/types';
import { runChain, runEnsemble } from '../../src/hazard/chain';
import { profileProbeChainages, runChainWithProfile } from '../../src/hazard/frontProfile';
import {
  LATENCY_PRESETS,
  alertTimeOf,
  bestSite,
  ensembleLeads,
  frontLineOf,
  frontTimeAt,
  isSeismicTrigger,
  leadCurve,
  memberProfile,
  monotoneFront,
  objectiveValue,
  warningLeads,
  warningTargets,
  type Sensor,
  type SensorTemplate,
  type WarningInput,
  type WarningTarget,
} from '../../src/hazard/warning';
import { syntheticValley } from '../helpers/valley';

const auto: SensorTemplate = { kind: 'gauge', detectionLatency: 60, alertLatency: 60 };

/** A front at a constant 10 m/s from s = 0, released at t = 300 s, over 40 km. */
function linearInput(): WarningInput {
  const s = Array.from({ length: 41 }, (_, k) => k * 1000);
  return { profile: { s, t: s.map((x) => 300 + x / 10) }, eventTime: 0, seismicTrigger: true };
}

test('lead time grows (never shrinks) as the sensor moves upstream; latency subtracts one for one', () => {
  const input = linearInput();
  const target: WarningTarget = { name: 'Town', s: 30000, tFront: 300 + 3000 };
  const curve = leadCurve(input, target, auto, { sMin: 0, sMax: 30000, n: 61 });
  for (let k = 1; k < curve.s.length; k++) assert.ok(curve.lead[k] <= curve.lead[k - 1] + 1e-9, `lead at ${curve.s[k]} m`);
  // Exact here: (30 km − s) / 10 m/s − 2 min.
  curve.s.forEach((x, k) => assert.ok(Math.abs(curve.lead[k] - ((30000 - x) / 10 - 120)) < 1e-6));
  for (const extra of [0, 60, 600, 1800]) {
    const sn: Sensor = { id: 'a', s: 5000, kind: 'gauge', detectionLatency: 30, alertLatency: 30 + extra };
    const r = warningLeads(input, [sn], [target]);
    assert.ok(Math.abs(r.leads[0].lead - (2500 - 60 - extra)) < 1e-6, `latency ${extra}`);
  }
  // A sensor below the town: negative lead (the water came first) — and still exact.
  const below = warningLeads(input, [{ id: 'b', s: 35000, ...auto }], [target]);
  assert.ok(Math.abs(below.leads[0].lead - (-500 - 120)) < 1e-6);
});

test('several sensors: the first alert wins; a baseline alert is only ever improved on; seismic ignores position', () => {
  const input = linearInput();
  const targets: WarningTarget[] = [
    { name: 'A', s: 10000, tFront: 1300 },
    { name: 'B', s: 30000, tFront: 3300 },
  ];
  const fast: Sensor = { id: 'fast', s: 8000, kind: 'tripwire', detectionLatency: 10, alertLatency: 50 };
  const slowUp: Sensor = { id: 'slow', s: 2000, kind: 'gauge', detectionLatency: 300, alertLatency: 900 };
  const r = warningLeads(input, [slowUp, fast], targets);
  // slow: 500 + 1200 = 1700; fast: 1100 + 60 = 1160 → fast wins.
  assert.equal(r.sensor, 1);
  assert.ok(Math.abs(r.alert - 1160) < 1e-6);
  const base = warningLeads(input, [slowUp], targets, 900);
  assert.equal(base.sensor, -1, 'the baseline alert (900 s) beats a sensor alerting at 1700 s');
  assert.ok(Math.abs(base.leads[1].lead - 2400) < 1e-6);
  // Seismic on a mass-movement trigger: event time + latencies, wherever the sensor is.
  const mono = monotoneFront(input.profile);
  const seis = (s: number) => alertTimeOf(input, mono, { s, kind: 'seismic', detectionLatency: 120, alertLatency: 180 });
  assert.equal(seis(0), 300);
  assert.equal(seis(39000), 300);
  // … and on a breach it hears the flow passing, like a gauge.
  assert.equal(alertTimeOf({ ...input, seismicTrigger: false }, mono, { s: 10000, kind: 'seismic', detectionLatency: 120, alertLatency: 180 }), 1300 + 300);
  assert.ok(isSeismicTrigger('massIntoRiver') && isSeismicTrigger('massIntoLake') && !isSeismicTrigger('breach'));
  // A sensor beyond the flood's reach never fires: everyone it would have warned gets none.
  const short: WarningInput = { ...input, profile: { s: [0, 1000, 2000], t: [300, 400, NaN] } };
  const none = warningLeads(short, [{ id: 'x', s: 2000, ...auto }], [{ name: 'C', s: 1500, tFront: 450 }]);
  assert.equal(none.leads[0].lead, -Infinity);
  assert.ok(Number.isNaN(frontTimeAt(monotoneFront(short.profile), 1500)));
});

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

const spec: HazardChainSpec = {
  trigger: { kind: 'breach', lake, breach: { model: 'weirErosion', erosionRate: 30, finalDepth: 20, widthRatio: 2, sideSlope: 1, hypsometry: 1.5 } },
  profile: 'chain.json',
  rheology: { kind: 'water' },
  alertTime: 600,
};

test('runChainWithProfile: the same stations as runChain, plus a front line through them every kilometre', () => {
  const file = valley();
  const plain = runChain(spec, file, { baseflow: 15 });
  const r = runChainWithProfile(spec, file, { baseflow: 15 });
  assert.deepEqual(
    r.stations.map((s) => [s.name, s.tFront, s.qPeak]),
    plain.stations.map((s) => [s.name, s.tFront, s.qPeak]),
  );
  assert.deepEqual(Object.keys(r.leadTime!), Object.keys(plain.leadTime!));
  const p = r.frontProfile!;
  assert.ok(p.s.length >= profileProbeChainages(file).length + r.stations.length);
  for (let i = 1; i < p.s.length; i++) assert.ok(p.s[i] >= p.s[i - 1]);
  const mono = monotoneFront(p);
  for (const st of r.stations) if (Number.isFinite(st.tFront)) assert.ok(frontTimeAt(mono, st.s) <= st.tFront + 1e-6, `${st.name} on the line`);
  // Fronts advance down the valley.
  assert.ok(mono.t[mono.t.length - 1] > mono.t[0]);
});

test('best single site = brute force over a 10 m sweep (both objectives, with an elevation limit)', () => {
  const file = valley();
  const r = runChainWithProfile(spec, file, { baseflow: 15 });
  const input: WarningInput = { profile: r.frontProfile!, eventTime: 0, seismicTrigger: false };
  const capacity = (n: string) => file.stations.find((s) => s.name === n)?.capacityMW;
  const targets = warningTargets(r.stations, capacity);
  assert.deepEqual(targets.map((t) => t.name), ['Village', 'Intake', 'Bridge']);
  const bed = { s: file.s, z: file.zBed };
  for (const objective of ['maxMin', 'weighted'] as const) {
    for (const maxElevation of [undefined, 4200, 3900]) {
      const cons = { sourceS: 0, minBelowSource: 1000, maxElevation, bed };
      const best = bestSite(input, targets, auto, cons, objective);
      // Brute force.
      const mono = monotoneFront(input.profile);
      let bv = -Infinity;
      let bs = NaN;
      for (let x = 1000; x <= 29000; x += 10) {
        const z = (() => {
          let i = 1;
          while (file.s[i] < x) i++;
          return file.zBed[i - 1] + ((file.zBed[i] - file.zBed[i - 1]) * (x - file.s[i - 1])) / (file.s[i] - file.s[i - 1]);
        })();
        if (maxElevation !== undefined && z > maxElevation) continue;
        const al = alertTimeOf(input, mono, { ...auto, s: x });
        const leads = targets.map((t) => ({ name: t.name, s: t.s, tFront: t.tFront, lead: t.tFront - al }));
        const v = objectiveValue(objective, leads, targets);
        if (v > bv) {
          bv = v;
          bs = x;
        }
      }
      // The optimiser's value is at least the sweep's best (it is exact at the feasible bounds; the sweep is a grid) and
      // no better than the sweep's best plus what 100 m of bed (one node: the elevation limit's resolution) is worth.
      assert.ok(best.value >= bv - 1, `${objective} ≤${maxElevation}: optimiser ${best.value} vs sweep ${bv}`);
      assert.ok(Math.abs(best.s - bs) <= 110, `${objective} ≤${maxElevation}: optimiser at ${best.s} m vs sweep at ${bs} m`);
    }
  }
  // An elevation limit pushes the site downstream (lower), and costs lead time.
  const free = bestSite(input, targets, auto, { sourceS: 0, bed }, 'maxMin');
  const capped = bestSite(input, targets, auto, { sourceS: 0, bed, maxElevation: 3900 }, 'maxMin');
  assert.ok(capped.s > free.s && capped.value < free.value);
});

test('ensemble: member fronts warp the profile through their station anchors; p10 ≤ p50 ≤ p90', () => {
  const det = { s: [0, 1000, 2000, 3000], t: [0, 100, 300, 400] };
  const m = memberProfile(det, [
    { s: 0, det: 0, mem: 0 },
    { s: 3000, det: 400, mem: 200 },
  ]);
  assert.deepEqual(m.t, [0, 50, 150, 200], 'the deterministic shape, stretched to the member’s travel time');
  const file = valley();
  const ens = runEnsemble(spec, file, { baseflow: 15 }, { memberDx: 500 });
  const r = runChainWithProfile(spec, file, { baseflow: 15 });
  const input: WarningInput = { profile: frontLineOf(r, file.domainEntry.s), eventTime: 0, seismicTrigger: false };
  const targets = warningTargets(r.stations);
  const sensors: Sensor[] = [{ id: 's', s: 3000, ...auto }];
  const bands = ensembleLeads(input, sensors, targets, ens.members, r.stations);
  const det0 = warningLeads(input, sensors, targets);
  bands.forEach((b, i) => {
    assert.ok(b[0] <= b[1] && b[1] <= b[2], `${targets[i].name} ${b}`);
    assert.ok(b[0] > 0 && b[0] <= det0.leads[i].lead * 1.5, `${targets[i].name}: p10 ${b[0]} vs deterministic ${det0.leads[i].lead}`);
  });
});

test('Nepal baked profile: a sensor at Rasuwagadhi / Syafrubesi, the 2026 SMS baseline, and the best site', (t) => {
  const W = new URL('../../public/presets/nepal/', import.meta.url);
  const file = JSON.parse(readFileSync(new URL('chain.json', W), 'utf8')) as ChainFile;
  const meta = JSON.parse(readFileSync(new URL('meta.json', W), 'utf8'));
  const baseSpec = (meta.scenario ?? meta).hazardChain as HazardChainSpec;
  assert.equal(baseSpec.trigger.kind, 'massIntoRiver');
  const lines: string[] = [];
  for (const mode of ['transientDam', 'directFlow'] as const) {
    const sp: HazardChainSpec = baseSpec.trigger.kind === 'massIntoRiver' ? { ...baseSpec, trigger: { ...baseSpec.trigger, mode } } : baseSpec;
    const r = runChainWithProfile(sp, file);
    const input: WarningInput = { profile: frontLineOf(r, file.domainEntry.s), eventTime: 0, seismicTrigger: true };
    const targets = warningTargets(r.stations, (n) => file.stations.find((s) => s.name === n)?.capacityMW);
    const st = (n: string) => r.stations.find((s) => s.name === n)!;
    const betra = st('Betrawati');
    const rasu = st('Rasuwagadhi');
    const syaf = st('Syafrubesi');
    assert.ok(Number.isFinite(betra.tFront) && Number.isFinite(rasu.tFront) && Number.isFinite(syaf.tFront), 'the flood reaches all three');
    const lead = (s: number, tmpl: SensorTemplate) => warningLeads(input, [{ id: 'x', s, ...tmpl }], targets).leads.find((l) => l.name === 'Betrawati')!.lead;
    const atRasu = lead(rasu.s, auto);
    const atSyaf = lead(syaf.s, auto);
    // A sensor at a station reads (about) that station's own front: lead = travel time − 2 min. Not exactly: the front
    // line is held monotone, so a probe just upstream that read its front a little late carries over (≤ 3 min here).
    const mono = monotoneFront(input.profile);
    assert.ok(Math.abs(atRasu - (betra.tFront - frontTimeAt(mono, rasu.s) - 120)) < 1e-6);
    assert.ok(Math.abs(atRasu - (betra.tFront - rasu.tFront - 120)) < 180, `Rasuwagadhi: ${atRasu}`);
    assert.ok(Math.abs(atSyaf - (betra.tFront - syaf.tFront - 120)) < 180, `Syafrubesi: ${atSyaf}`);
    assert.ok(atRasu > atSyaf && atSyaf > 0, 'further upstream, more warning');
    const manual = LATENCY_PRESETS.find((p) => p.id === 'manual')!;
    const seismic = LATENCY_PRESETS.find((p) => p.id === 'seismic')!;
    const atRasuManual = lead(rasu.s, manual);
    assert.ok(Math.abs(atRasu - atRasuManual - (manual.detectionLatency + manual.alertLatency - 120)) < 1e-6);
    const seis = lead(0, seismic);
    assert.ok(Math.abs(seis - (betra.tFront - 300)) < 1e-6, 'seismic: the event itself + 5 min');
    const baseline = betra.tFront - sp.alertTime!;
    const best = bestSite(input, targets, auto, { sourceS: 0, minBelowSource: 1000, bed: { s: file.s, z: file.zBed } }, 'maxMin');
    const best2k = bestSite(input, targets, auto, { sourceS: 0, minBelowSource: 1000, maxElevation: 2000, bed: { s: file.s, z: file.zBed } }, 'maxMin');
    const m = (x: number) => (x / 60).toFixed(1);
    lines.push(
      `${mode}: Betrawati front ${m(betra.tFront)} min after 08:37 (obs 43); Rasuwagadhi ${m(rasu.tFront)}, Syafrubesi ${m(syaf.tFront)}`,
      `  Betrawati lead — sensor at Rasuwagadhi, automated 2 min: ${m(atRasu)} min; manual relay 15 min: ${m(atRasuManual)} min`,
      `  Betrawati lead — sensor at Syafrubesi, automated: ${m(atSyaf)} min; seismic network (5 min): ${m(seis)} min; 2026 SMS baseline: ${m(baseline)} min`,
      `  best single automated site (max-min over ${targets.length} towns/plants): ${(best.s / 1000).toFixed(1)} km, min lead ${m(best.value)} min; bed ≤ 2,000 m: ${(best2k.s / 1000).toFixed(1)} km, min lead ${m(best2k.value)} min`,
    );
    assert.ok(best.s <= rasu.s && best.value >= Math.min(...warningLeads(input, [{ id: 'r', s: rasu.s, ...auto }], targets).leads.map((l) => l.lead)) - 1);
    assert.ok(best2k.s >= best.s && best2k.value <= best.value + 1);
  }
  t.diagnostic(lines.join('\n'));
});
