/**
 * Egress timing: the latest safe departure (egress.ts), and the share of occupants out before it with a departure
 * curve and a bottleneck queue (egressTiming.ts), in the verdict and the card.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HazardFields, Shelter } from '../../src/contracts';
import { analyzeEgress, type EgressResult, type EgressRouter } from '../../src/loss/egress';
import { clearanceSentence, egressTiming, shareOutSentence, timingCaveats, timingDefaults, timingForRun, type EgressTimingInput } from '../../src/loss/egressTiming';
import { DEPARTURE_CURVES, departedShare, type DepartureCurve } from '../../src/routing/departure';

const NX = 64;
const NY = 64;
const N = NX * NY;

const close = (a: number, b: number, tol: number, msg = '') => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (±${tol})`);

/** Shelter A is reached along road cell 10 (2 min drive), shelter B along cell 20 (10 min drive), shelter C's own cell is 40. */
function fakeRouter(): EgressRouter {
  let depth: Float32Array = new Float32Array(N);
  const roadOf: Record<string, number> = { A: 10, B: 20, C: 30 };
  const eta: Record<string, number> = { A: 120, B: 600, C: 300 };
  return {
    updateFlood(d) {
      depth = d;
    },
    route(_start, shelters) {
      // A shelter whose own cell is flooded is no shelter (router.ts 'shelters-flooded').
      const open = shelters.filter((s) => depth[roadOf[s.name]] < 0.3 && depth[s.gy * NX + s.gx] < 0.3);
      if (!open.length) return { state: 'blocked', polyline: null, lengthMeters: 0, etaSeconds: 0, shelter: null, reason: 'cut-off' };
      const best = open.sort((a, b) => eta[a.name] - eta[b.name])[0];
      return { state: 'ok', polyline: new Float32Array([0, 0, 1, 1]), lengthMeters: 1000, etaSeconds: eta[best.name], shelter: best, reason: null, classMeters: [0, 800, 0, 200] };
    },
  };
}

function flood(arrivals: Array<[number, number, number]>, simTime = 7200): HazardFields {
  const f: HazardFields = {
    nx: NX,
    ny: NY,
    simTime,
    maxDepth: new Float32Array(N),
    maxSpeed: new Float32Array(N),
    maxDV: new Float32Array(N),
    firstWet: new Float32Array(N).fill(-1),
    wetSeconds: new Float32Array(N),
  };
  for (const [c, t, d] of arrivals) {
    f.firstWet[c] = t;
    f.maxDepth[c] = d;
  }
  return f;
}

const A: Shelter = { name: 'A', gx: 1, gy: 1 };
const B: Shelter = { name: 'B', gx: 2, gy: 2 };
const C: Shelter = { name: 'C', gx: 40, gy: 0 };

test('latest safe departure: each shelter’s closure minus its drive, the latest over shelters', () => {
  // Road A floods at 1,000 s, road B at 1,500 s: leave for B by 1,500 − 600 = 900, for A by 1,000 − 120 = 880.
  const e = analyzeEgress(fakeRouter(), flood([[10, 1000, 0.5], [20, 1500, 0.5]]), { gx: 5, gy: 5 }, [A, B]);
  assert.equal(e.lastRouteClosesAt, 1500);
  assert.equal(e.lastSafeDepartureAt, 900);
  assert.equal(e.lastSafeShelter, 'B');
  assert.deepEqual(e.routeClassMeters, [0, 800, 0, 200]);
  // A shelter whose route stays open: no deadline.
  const open = analyzeEgress(fakeRouter(), flood([[10, 1000, 0.5]]), { gx: 5, gy: 5 }, [A, B]);
  assert.equal(open.lastSafeDepartureAt, Infinity);
  assert.equal(open.lastSafeShelter, 'B');
});

test('a shelter that floods itself before the occupants get there does not count', () => {
  // Shelter C's road stays dry but C itself goes under at 600 s: leave for it by 600 − 300 = 300 s. B is the
  // better deadline (1,500 − 600 = 900 s).
  const e = analyzeEgress(fakeRouter(), flood([[C.gy * NX + C.gx, 600, 1.0], [20, 1500, 0.5]]), { gx: 5, gy: 5 }, [B, C]);
  const c = e.shelters.find((s) => s.name === 'C')!;
  assert.equal(c.closesAt, 600);
  assert.equal(e.lastSafeDepartureAt, 900);
  assert.equal(e.lastSafeShelter, 'B');
  // With C alone, the deadline is C's flooding minus the drive — earlier than the route's own closure.
  const only = analyzeEgress(fakeRouter(), flood([[C.gy * NX + C.gx, 600, 1.0]]), { gx: 5, gy: 5 }, [C]);
  assert.equal(only.lastRouteClosesAt, 600);
  assert.equal(only.lastSafeDepartureAt, 300);
  // Unknown egress: NaN, never a number that reads as safe.
  assert.ok(Number.isNaN(analyzeEgress(fakeRouter(), flood([]), { gx: 5, gy: 5 }, []).lastSafeDepartureAt!));
});

const instant: DepartureCurve = { id: 'custom', label: 'instant', a: 1, bMin: 1 / 60, maxShare: 1, source: 'test' };

function input(patch: Partial<EgressTimingInput> = {}): EgressTimingInput {
  return { occupants: 590, occupantsBasis: 'test', personsPerVehicle: 1.18, personsPerVehicleBasis: 'test', exitLanes: 1, curve: instant, alertTime: 0, ...patch };
}

function egress(lastSafe: number, classMeters: number[] | null = [0, 800, 0, 0]): EgressResult {
  return {
    known: true,
    note: '',
    openAtStart: true,
    openAtPeak: lastSafe === Infinity,
    lastRouteClosesAt: lastSafe === Infinity ? NaN : lastSafe + 120,
    peakReason: '',
    cutAtEnd: null,
    endTime: 7200,
    cutOffAtLeastS: NaN,
    shelters: [],
    routeBefore: null,
    routeAtPeak: null,
    peakShelter: '',
    routerCalls: 1,
    lastSafeDepartureAt: lastSafe,
    lastSafeShelter: 'B',
    routeClassMeters: classMeters,
  };
}

test('one exit lane, 500 cars: clearance an hour, longer than a 30-minute window — half get out', () => {
  const t = egressTiming(egress(1800), input());
  assert.ok(t.known);
  assert.equal(t.vehicles, 500);
  assert.equal(t.bottleneck.where, 'exit');
  assert.equal(t.bottleneck.capacityVph, 500);
  close(t.clearanceS, 3600, 15);
  assert.equal(t.windowS, 1800);
  assert.equal(t.clearsInWindow, false);
  close(t.shareOut, 0.5, 0.01);
  close(t.shareQueued, 0.5, 0.01);
  close(t.shareInside, 0, 1e-9);
  assert.match(clearanceSentence(t), /^Clearance time 60 min vs route window 30 min: 500 cars \(590 occupants ÷ 1\.18\) through the site exit \(1 lane\), 500 cars\/h; the queue alone takes 60 min\. The way out closes before the site has cleared\.$/);
  assert.match(shareOutSentence(t), /^50 % of occupants out before the last route closes \(departures p10–p90 0 min–0 min after the alert, “instant”\); 0 % still inside and 50 % queued at the exit when it closes\.$/);
  // Two exit lanes (1,000/h) on a route with a local street (500/h): still 500/h.
  const viaLocal = egressTiming(egress(1800, [0, 800, 0, 300]), input({ exitLanes: 2 }));
  assert.equal(viaLocal.bottleneck.where, 'road');
  assert.equal(viaLocal.bottleneck.capacityVph, 500);
  // Four exit lanes straight onto a major road (1,900/h): clears in 16 min, inside the window.
  const wide = egressTiming(egress(1800), input({ exitLanes: 4 }));
  close(wide.clearanceS, (500 / 1900) * 3600, 15);
  assert.ok(wide.clearsInWindow);
  close(wide.shareOut, 1, 1e-6);
  assert.match(clearanceSentence(wide), /The site clears before the way out closes\./);
});

test('departure curve: who is still inside when the last route closes', () => {
  const c = DEPARTURE_CURVES['poor-likely'];
  // A small site (no queue to speak of), alert at T+10 min, last safe departure at T+130 min: 2 h of window.
  const t = egressTiming(egress(130 * 60), input({ occupants: 20, curve: c, alertTime: 600 }));
  assert.equal(t.windowS, 7200);
  const left = departedShare(c, 7200);
  close(t.shareOut + t.shareQueued, left, 0.06, 'out + queued = departed (whole cars)');
  close(t.shareInside, 1 - left, 0.06);
  close(t.shareOut + t.shareQueued + t.shareInside, 1, 1e-9);
  assert.ok(t.shareOut > 0.25 && t.shareOut < 0.4, `${t.shareOut}`);
  close(t.band.p10 / 60, 48.6, 0.2);
  close(t.band.p90 / 60, 226.9, 0.3);
  assert.match(shareOutSentence(t), /^\d+ % of occupants out before the last route closes \(departures p10–p90 49 min–3 h 47 min after the alert, “Unprepared, threat seen as likely”\)/);
  // The clearance follows the curve's tail (99th percentile) when there is no queue.
  assert.ok(t.clearanceS > 5 * 3600, `${t.clearanceS}`);
  assert.equal(t.clearsInWindow, false);
  // Caveats in plain words, with the curve's source and the share that never leaves.
  const cav = timingCaveats(t).join(' ');
  assert.match(cav, /Sorensen & Mileti 2015b/);
  assert.match(cav, /26 % take no protective action within 8 hours/);
  assert.match(cav, /lower bound/);
  assert.match(cav, /negative alert time/);
});

test('route closes before the alert, stays open, or was never there', () => {
  const before = egressTiming(egress(300), input({ alertTime: 600 }));
  assert.equal(before.windowS, -300);
  assert.equal(before.shareOut, 0);
  close(before.shareInside, 1, 1e-9);
  assert.match(shareOutSentence(before), /^0 % of occupants out before the last route closes — it closes 5 min before the alert/);
  assert.match(clearanceSentence(before), /route window 0 min/);
  // A warning issued before the run starts (negative alert): the window is longer.
  const early = egressTiming(egress(300), input({ alertTime: -3600 }));
  assert.equal(early.windowS, 3900);
  // Open through the run: no shares, the eventual share and the clearance.
  const open = egressTiming(egress(Infinity), input({ curve: DEPARTURE_CURVES['good-likely'] }));
  assert.equal(open.windowS, Infinity);
  assert.ok(Number.isNaN(open.shareOut));
  assert.ok(open.clearsInWindow);
  assert.match(shareOutSentence(open), /^No route to a shelter closes during the run: 89 % of occupants leave by road eventually/);
  assert.match(clearanceSentence(open), /a route window that stays open through the run/);
  // Unknown.
  assert.equal(egressTiming(null, input()).known, false);
  assert.match(shareOutSentence(egressTiming(null, input())), /not assessed: egress not assessed/);
  const none = { ...egress(300), openAtStart: false };
  assert.match(egressTiming(none, input()).note, /no road route/);
  assert.equal(egressTiming(egress(300), input({ occupants: 0 })).known, false);
  // A hand-built result without lastSafeDepartureAt falls back on the last route's closure.
  const old = egress(300);
  delete old.lastSafeDepartureAt;
  assert.equal(egressTiming(old, input()).windowS, 420);
});

test('a planned building’s defaults: IBC occupants, persons per car by use, the default curve, one exit lane', () => {
  const e = egress(3600);
  // A 3-storey office of 2,000 m² a floor: 6,000 m² / (150 ft² = 13.94 m²) = 431 occupants → 366 cars at 1.18.
  const t = timingForRun({ result: { occ: 'office', gfaM2: 6000 }, egress: e }, 0)!;
  assert.equal(t.occupants, 431);
  assert.match(t.occupantsBasis, /IBC 1004\.5 business.*design maximum/);
  assert.equal(t.vehicles, 366);
  assert.equal(t.curve.id, 'poor-likely');
  assert.equal(t.bottleneck.capacityVph, 500);
  assert.equal(t.windowS, 3600);
  // Overrides: the user's count, an alert 2 h before the run, the prepared curve, two lanes, 1.5 per car.
  const o = timingForRun({ result: { occ: 'office', gfaM2: 6000 }, egress: e }, 0, { occupants: 300, alertMin: -120, departure: 'good-likely', exitLanes: 2, personsPerCar: 1.5 })!;
  assert.equal(o.occupantsBasis, 'your input');
  assert.equal(o.vehicles, 200);
  assert.equal(o.alertTime, -7200);
  assert.equal(o.windowS, 3600 + 7200);
  assert.equal(o.curve.id, 'good-likely');
  assert.equal(o.bottleneck.capacityVph, 1000, 'two exit lanes (1,000/h) onto a major road (1,900/h): the exit');
  assert.equal(timingForRun({ result: null, egress: e }, 0), null);
});

test('defaults by use: cars per person', () => {
  assert.equal(timingDefaults('res').personsPerVehicle, 2.0);
  assert.equal(timingDefaults('office').personsPerVehicle, 1.18);
  assert.equal(timingDefaults('hospital').personsPerVehicle, 1.18);
});
