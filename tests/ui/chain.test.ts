/**
 * The hazard chain's UI helpers (src/ui/chainTime.ts) and the app controller that drives the map with the routed wave
 * (src/app/hazardChain.ts): event clock in the event's own time zone, the front's position along the valley, station
 * states, lead times, label layout, the trigger summary's provenance, and the controller end to end on a synthetic
 * valley with the chain run inline.
 *
 * Run: node --import tsx --test tests/ui/chain.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ct from '../../src/ui/chainTime';
import { domainClockOffset, runChain } from '../../src/hazard/chain';
import { HazardChainController, domainOffsetSync, isChainFile, replaceEntryInflow, specFor } from '../../src/app/hazardChain';
import { createStore } from '../../src/app/store';
import { bridgeFor, type ChainView } from '../../src/ui/bridge';
import type { HazardChainBackend } from '../../src/hazard/workerClient';
import type { HazardChainSpec } from '../../src/hazard/types';
import type { WaterSource } from '../../src/contracts';
import { syntheticValley } from '../helpers/valley';
import { baseState } from './helpers';

const NB = ' ';

// ─── Event clock ─────────────────────────────────────────────────────────────────────────────────

test('timeline window: a flood with no front at the map edge (entryFront NaN) still gets a finite chart', async () => {
  const { chartWindow } = await import('../../src/ui/chainTimeline');
  // The usual case: 300 s before the first outflow, to the entry wave's tail.
  assert.deepEqual(chartWindow({ starts: [1000], entryFront: 4000, tPeak: 5000, tEnd: 20000, obsFronts: [] }), [700, 5000 + 1.5 * 1000]);
  // No front at the edge: the window runs from the outflow to the routing's end — not NaN.
  const w = chartWindow({ starts: [1000, NaN], entryFront: NaN, tPeak: 0, tEnd: 90000, obsFronts: [NaN] });
  assert.ok(w.every(Number.isFinite), JSON.stringify(w));
  assert.deepEqual(w, [700, 90000]);
  // Nothing finite at all: a 10-minute window at 0.
  assert.deepEqual(chartWindow({ starts: [NaN], entryFront: NaN, tPeak: NaN, tEnd: NaN, obsFronts: [] }), [0, 600]);
  // An observation after the modelled tail keeps the window open past it.
  assert.equal(chartWindow({ starts: [0], entryFront: 100, tPeak: 200, tEnd: 5000, obsFronts: [9000] })[1], 9300);
});

test('event clock: ISO offsets are kept, so the clock reads in the event’s own zone', () => {
  const np = ct.parseEventClock('2026-08-26T08:37:00+05:45')!;
  assert.equal(np.offsetMin, 345);
  assert.equal(new Date(np.ms).toISOString(), '2026-08-26T02:52:00.000Z');
  assert.equal(ct.formatEventTime(np, 0), `08:37${NB}NPT`);
  // Betrawati: 43 minutes after the failure.
  assert.equal(ct.formatEventTime(np, 43 * 60), `09:20${NB}NPT`);
  assert.equal(ct.formatEventTime(np, 37 * 60 + 59.9), `09:14${NB}NPT`, 'floors to the minute');
  assert.equal(ct.formatEventTime(np, 37 * 60, { date: true }), `26${NB}Aug${NB}2026 09:14${NB}NPT`);
  // South Lhonak: 22:13:20 IST, Chungthang ~2 h 17 min later — past midnight, on the 4th.
  const ind = ct.parseEventClock('2023-10-03T22:13:20+05:30')!;
  assert.equal(ind.offsetMin, 330);
  assert.equal(ct.formatEventTime(ind, 8200, { date: true }), `4${NB}Oct${NB}2023 00:30${NB}IST`);
  assert.equal(ct.formatEventTime(ind, 0, { seconds: true, zone: false }), '22:13:20');
  // Negative and Z offsets; unnamed zones spelled out.
  const z = ct.parseEventClock('2025-05-28T13:24:00Z')!;
  assert.equal(z.offsetMin, 0);
  assert.equal(ct.formatEventTime(z, 60), `13:25${NB}UTC`);
  const ny = ct.parseEventClock('2024-01-01T00:00:00-05:00')!;
  assert.equal(ct.formatEventTime(ny, 0), `00:00${NB}UTC−05:00`);
  assert.equal(ct.zoneLabel(345), 'NPT');
  assert.equal(ct.zoneLabel(330), 'IST');
  assert.equal(ct.zoneLabel(-210), 'UTC−03:30');
});

test('event clock: times without an offset, and garbage, are refused', () => {
  assert.equal(ct.parseEventClock('2026-08-26T08:37:00'), null, 'no offset: would silently take the viewer’s zone');
  assert.equal(ct.parseEventClock('26 Aug 2026'), null);
  assert.equal(ct.parseEventClock(undefined), null);
  assert.equal(ct.parseEventClock('2026-08-26T08:37:00+25:00'), null);
  assert.equal(ct.formatEventTime(ct.parseEventClock('2026-08-26T08:37:00+05:45')!, NaN), '—');
});

test('chain time, spans and lead times', () => {
  assert.equal(ct.formatChainTime(0), `T+0${NB}min`);
  assert.equal(ct.formatChainTime(2 * 3600 + 15 * 60), `T+2${NB}h 15${NB}min`);
  assert.equal(ct.formatChainTime(-120), `T−2${NB}min`);
  assert.equal(ct.formatWhen(null, 3600), `T+1${NB}h`);
  assert.equal(ct.formatSpan(30), `30${NB}s`);
  assert.equal(ct.formatSpan(5 * 60), `5${NB}min`);
  assert.equal(ct.formatSpan(3 * 3600 + 60), `3${NB}h 1${NB}min`);
  // Nepal 2026: SMS 09:15 (2280 s), water at Betrawati 09:20 (2580 s) → 5 minutes.
  assert.equal(ct.leadTime(2280, 2580), 300);
  assert.equal(ct.formatLead(ct.leadTime(2280, 2580)), `5${NB}min`);
  // Rasuwagadhi was hit at 08:40, before any alert.
  assert.match(ct.formatLead(ct.leadTime(2280, 180)), /^none — water 35.min before the alert$/);
  assert.equal(ct.leadTime(undefined, 2580), null);
  assert.equal(ct.leadTime(2280, NaN), null);
  assert.equal(ct.formatLead(null), '—');
});

// ─── Front position ──────────────────────────────────────────────────────────────────────────────

test('front table: sorted by chainage, monotone in time, NaN stations dropped', () => {
  const t = ct.frontTable([
    { s: 30000, t: 900 },
    { s: 0, t: 0 },
    { s: 15000, t: 400 },
    { s: 16000, t: 390 }, // the router's thresholds put it 10 s "before" its upstream neighbour
    { s: 50000, t: NaN },
    { s: 15000, t: 420 }, // a second station at one place
  ]);
  assert.deepEqual(t, [
    { s: 0, t: 0 },
    { s: 15000, t: 400 },
    { s: 16000, t: 400 },
    { s: 30000, t: 900 },
  ]);
});

test('front position: none before release, linear between stations, keeps its speed to the end of the profile', () => {
  const table = ct.frontTable([
    { s: 0, t: 100 },
    { s: 10000, t: 1100 },
    { s: 20000, t: 1600 },
  ]);
  assert.equal(ct.frontAt(table, 50), null);
  assert.equal(ct.frontAt(table, 100), 0);
  assert.equal(ct.frontAt(table, 600), 5000);
  assert.equal(ct.frontAt(table, 1100), 10000);
  assert.equal(ct.frontAt(table, 1350), 15000);
  // Past the last station at the last reach's 20 m/s, capped at the profile end.
  assert.equal(ct.frontAt(table, 1700, 30000), 22000);
  assert.equal(ct.frontAt(table, 99999, 30000), 30000);
  // Without a known end it stops at the last station.
  assert.equal(ct.frontAt(table, 1700), 20000);
  assert.equal(ct.frontAt([], 10), null);
  assert.equal(ct.frontAt([{ s: 5, t: 0 }], 10), 5);
  assert.equal(ct.frontAt(table, NaN), null);
});

test('station states: passed, the next one by time, pending, never', () => {
  assert.deepEqual(ct.stationStates([100, 200, 300], 150), ['passed', 'next', 'pending']);
  assert.deepEqual(ct.stationStates([100, 200, 300], 300), ['passed', 'passed', 'passed']);
  assert.deepEqual(ct.stationStates([100, 200, NaN], 50), ['next', 'pending', 'never']);
  // A town and its gauge at one place, listed gauge-last but reached first: "next" follows time, not list order.
  assert.deepEqual(ct.stationStates([500, 450], 0), ['pending', 'next']);
});

// ─── Stations, trigger, labels ───────────────────────────────────────────────────────────────────

test('station names and kinds for the profile', () => {
  assert.equal(ct.shortStationName({ name: 'Rasuwagadhi HEP headworks', kind: 'hydro' }), 'Rasuwagadhi HEP');
  assert.equal(ct.shortStationName({ name: 'Upper Trishuli-1 HEP (under construction)', kind: 'hydro' }), 'Upper Trishuli-1 HEP');
  assert.equal(ct.shortStationName({ name: 'Lhende Khola at 2,900 m (avalanche runout)', kind: 'source' }), 'Lhende Khola');
  assert.equal(ct.shortStationName({ name: 'Betrawati 2-D domain (north edge)', kind: 'domainEdge' }), 'Map edge');
  assert.equal(ct.stationKindLabel({ kind: 'hydro', capacityMW: 22.1 }), `Hydropower plant · 22.1${NB}MW`);
  assert.equal(ct.stationKindLabel({ kind: 'hydro', capacityMW: 1200 }), `Hydropower plant · 1,200${NB}MW`);
  const obs = [{ station: 'Betrawati', tFront: 2580, note: '', source: '' }, { station: 'Devghat', qPeak: 5850, note: '', source: '' }];
  assert.equal(ct.observedFront(obs, 'Betrawati')?.tFront, 2580);
  assert.equal(ct.observedFront(obs, 'Devghat'), null, 'a peak is not an arrival');
});

test('trigger summary: what started it, with provenance', () => {
  const defaults = { avalancheDamRate: 150, triggeredRate: 100 };
  const nepal: HazardChainSpec = {
    trigger: { kind: 'massIntoRiver', mass: { volume: 113e6, iceFraction: 0.2, fallHeight: 2300, pathLength: 13000 }, mode: 'transientDam', baseflow: 100 },
    profile: 'chain.json',
    rheology: { kind: 'water' },
  };
  const a = ct.triggerSummary(nepal, { clockZero: '2026-08-26T08:37:00+05:45' }, defaults);
  assert.equal(a.title, 'Ice-rock avalanche into the river');
  assert.deepEqual([a.volume!.lo, a.volume!.median, a.volume!.hi], [56.5e6, 113e6, 226e6]);
  assert.equal(a.volume!.provenance, 'reconstructed', 'a real event’s published volume');
  assert.equal(a.facts[0].provenance, 'observed');
  assert.deepEqual(a.modes, ['transientDam', 'directFlow']);
  assert.equal(a.erosionRate, 150);
  // The same trigger as a what-if (no clock zero): a scenario.
  const w = ct.triggerSummary(nepal, {}, defaults);
  assert.equal(w.volume!.provenance, 'scenario');
  assert.equal(w.facts[0].provenance, 'scenario');
  assert.equal(ct.volumeFactorFor(a, 56.5e6), 0.5);

  const lake = { id: 'l', name: 'South Lhonak Lake', lat: 0, lon: 0, elevation: 5200, area: 1.674e6, volume: { median: 102.4e6, lo: 76.8e6, hi: 128e6, method: 'empirical' as const }, damType: 'moraine' as const };
  const breach = { model: 'weirErosion' as const, erosionRate: 30, finalDepth: 40, widthRatio: 2, sideSlope: 1, hypsometry: 1.5 };
  const sl = ct.triggerSummary(
    { trigger: { kind: 'massIntoLake', lake, mass: { volume: 14.7e6, iceFraction: 0.2, fallHeight: 150, pathLength: 500 }, breach }, profile: 'chain.json', rheology: { kind: 'water' } },
    { clockZero: '2023-10-03T22:13:20+05:30' },
    defaults,
  );
  assert.equal(sl.volume!.provenance, 'modelled', 'a volume from the lake area is modelled');
  assert.equal(sl.volume!.median, 102.4e6);
  assert.equal(sl.erosionRate, 100, 'a triggered breach cuts at the triggered rate');
  assert.ok(sl.facts.some((f) => f.label === 'Mass into the lake' && f.provenance === 'reconstructed'));
  const bathy = ct.triggerSummary({ trigger: { kind: 'breach', lake: { ...lake, volume: { ...lake.volume, method: 'bathymetry' } }, breach }, profile: 'c.json', rheology: { kind: 'water' } }, {}, defaults);
  assert.equal(bathy.volume!.provenance, 'observed');
  assert.equal(bathy.erosionRate, 30);
  const given = ct.triggerSummary({ trigger: { kind: 'given', hydrograph: [[0, 0], [600, 100]], provenance: 'reconstructed' }, profile: 'c.json', rheology: { kind: 'water' } }, {}, defaults);
  assert.equal(given.volume, null);
  assert.equal(given.erodes, false);
});

test('label rows: no two labels overlap; important ones placed first; the rest dropped', () => {
  const xs = [10, 20, 30, 300];
  const widths = [60, 60, 60, 60];
  const rows = ct.labelRows(xs, widths, 2);
  assert.deepEqual(rows, [0, 1, -1, 0]);
  // Priority: the third marker (say, the map edge) wins a row over the first two.
  const pr = ct.labelRows(xs, widths, 2, [5, 5, 0, 5]);
  assert.equal(pr[2], 0);
  assert.equal(pr.filter((r) => r === 0).length, 2);
  // Never-label entries.
  assert.deepEqual(ct.labelRows([10, 200], [20, 20], 1, [0, Infinity]), [0, -1]);
  // Kept inside the box: a label at the right edge is pushed left, so it collides with its neighbour.
  assert.deepEqual(ct.labelRows([150, 200], [60, 60], 1, undefined, 200), [0, -1]);
});

test('profile geometry: x by chainage, y by elevation (top = highest), decimated', () => {
  const s = Array.from({ length: 1001 }, (_, i) => i * 10);
  const z = s.map((v) => 3000 - v / 10);
  const g = ct.profileGeometry(s, z, { x0: 0, x1: 100, y0: 0, y1: 50 }, 100);
  assert.ok(g.points.length <= 102);
  assert.deepEqual(g.points[0], [0, 0]);
  assert.deepEqual(g.points[g.points.length - 1], [100, 50]);
  assert.equal(g.x(5000), 50);
  assert.equal(ct.bedAt(s, z, 55), 2994.5);
  assert.match(ct.pathOf([[0, 0], [1.234, 2.25]]), /^M0 0 L1.2 2.3$/);
});

// ─── App controller ──────────────────────────────────────────────────────────────────────────────

const valley = () =>
  syntheticValley({
    reaches: [
      { length: 12000, drop: 900, bottomWidth: 25, sideSlope: 1, n: 0.05 },
      { length: 10000, drop: 300, bottomWidth: 45, sideSlope: 1.5, n: 0.045 },
    ],
    dx: 200,
    z0: 3000,
    tableDepth: 60,
    stations: [
      { s: 0, name: 'Source', kind: 'source', lat: 0, lon: 0 },
      { s: 8000, name: 'Plant', kind: 'hydro', lat: 0, lon: 0, capacityMW: 50 },
      { s: 18000, name: 'Map edge', kind: 'domainEdge', lat: 0, lon: 0 },
      { s: 21000, name: 'Town', kind: 'town', lat: 0, lon: 0 },
    ],
    entryS: 18000,
    clockZero: '2026-08-26T08:37:00+05:45',
  });

const givenSpec = (): HazardChainSpec => ({
  trigger: { kind: 'given', hydrograph: [[0, 0], [300, 3000], [1200, 0]], provenance: 'reconstructed' },
  profile: 'chain.json',
  rheology: { kind: 'water' },
  alertTime: 600,
});

test('domainOffsetSync agrees with the chain engine’s domainClockOffset', () => {
  const file = valley();
  const r = runChain(givenSpec(), file, { routeDx: 400 });
  assert.ok(Number.isFinite(r.entryFront));
  assert.equal(domainOffsetSync(r), domainClockOffset(r));
  assert.equal(domainOffsetSync({ entryFront: NaN }), domainClockOffset({ ...r, entryFront: NaN }));
  assert.equal(domainOffsetSync({ entryFront: 100 }), 0);
});

test('replaceEntryInflow swaps the inflow at the domain entry and keeps the others', () => {
  const entry = { s: 0, gx: 100, gy: 8, radius: 4 };
  const routed: WaterSource = { id: 'chain-inflow', type: 'inflow', gx: 100, gy: 8, radius: 4, discharge: 500, hydrograph: [{ t: 0, q: 1 }] };
  const preset: WaterSource[] = [
    { id: 'edge', type: 'inflow', gx: 101.5, gy: 8.5, radius: 4, discharge: 11100, stopAfter: 1800 },
    { id: 'creek', type: 'inflow', gx: 600, gy: 900, radius: 3, discharge: 20 },
    { id: 'outlet', type: 'stage', gx: 100, gy: 8, radius: 4, level: 500 },
  ];
  assert.deepEqual(replaceEntryInflow(preset, entry, routed).map((w) => w.id), ['chain-inflow', 'creek', 'outlet']);
  assert.deepEqual(replaceEntryInflow(preset, entry, null).map((w) => w.id), ['creek', 'outlet'], 'held back while the chain runs');
  assert.deepEqual(replaceEntryInflow(preset.slice(1), entry, routed).map((w) => w.id), ['creek', 'outlet', 'chain-inflow'], 'appended when the preset has none there');
});

test('isChainFile and specFor', () => {
  assert.ok(isChainFile(valley()));
  assert.ok(!isChainFile({ version: 1, s: [0, 1], zBed: [1] }));
  assert.ok(!isChainFile(null));
  assert.ok(!isChainFile({ ...valley(), version: 2 }));
  const spec: HazardChainSpec = {
    trigger: { kind: 'massIntoRiver', mass: { volume: 1e6, iceFraction: 0.2, fallHeight: 1000, pathLength: 3000 }, mode: 'transientDam', baseflow: 50 },
    profile: 'chain.json',
    rheology: { kind: 'water' },
  };
  const d = specFor(spec, { overrides: {}, mode: 'directFlow' });
  assert.equal(d.trigger.kind === 'massIntoRiver' && d.trigger.mode, 'directFlow');
  assert.equal(spec.trigger.kind === 'massIntoRiver' && spec.trigger.mode, 'transientDam', 'the scenario is not mutated');
  assert.equal(specFor(givenSpec(), { overrides: {}, mode: 'directFlow' }).trigger.kind, 'given');
});

/** The chain functions on this thread, as the worker client's fallback runs them. */
function inlineBackend(): HazardChainBackend & { runs: number } {
  let id = 0;
  const b = {
    runs: 0,
    offThread: false,
    async run(spec: HazardChainSpec, file: Parameters<HazardChainBackend['run']>[1], overrides?: Parameters<HazardChainBackend['run']>[2]) {
      b.runs++;
      const { runChain: rc } = await import('../../src/hazard/chain');
      return { id: ++id, ms: 1, result: rc(spec, file, { routeDx: 400, ...overrides }) };
    },
    async ensemble(spec: HazardChainSpec, file: Parameters<HazardChainBackend['run']>[1], overrides?: Parameters<HazardChainBackend['run']>[2], opts?: { onProgress?: (d: number, t: number) => void }) {
      const { runEnsemble } = await import('../../src/hazard/chain');
      return { id: ++id, ms: 1, ensemble: runEnsemble(spec, file, { routeDx: 400, ...overrides }, { memberDx: 400, onProgress: opts?.onProgress }) };
    },
    dispose() {},
  };
  return b;
}

const until = async (f: () => boolean, ms = 20000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

test('controller: a chain preset routes the wave, drives the map with it, then adds the ensemble bands', async () => {
  const file = valley();
  const spec = givenSpec();
  const presetInflow: WaterSource = { id: 'edge', type: 'inflow', gx: 10, gy: 10, radius: 4, discharge: 7000, stopAfter: 1800 };
  const scenario = { description: '', sources: [presetInflow], storms: [], shelters: [], rainRate: 0, stage: null, initialFill: [], hazardChain: spec };
  const store = createStore(baseState({ presetId: 'nepal', scenario: scenario as never, sources: [{ ...presetInflow }] }));
  let resets = 0;
  const backend = inlineBackend();
  const c = new HazardChainController({ store, errors: { warn() {} } as never, resetWater: () => void resets++, createBackend: () => backend, loadFile: async () => file });
  const seen: ChainView['status'][] = [];
  bridgeFor(store).chainChanged.on((v) => v && seen.push(v.status));
  c.onSceneReady({ request: { kind: 'preset', id: 'nepal' }, terrain: { scenario } } as never);
  assert.equal(bridgeFor(store).chain?.status, 'loading');
  await until(() => bridgeFor(store).chain?.status === 'ready');
  const view = bridgeFor(store).chain!;
  assert.ok(view.result && view.bands && view.entryBand, 'result, station bands and the entry band');
  assert.equal(view.offset, domainClockOffset(view.result), 'the solver starts 300 s before the front reaches the edge');
  // The map's inflow is the routed wave, in the sources and in the scenario copy (Restore scenario keeps it).
  const s = store.get();
  assert.deepEqual(s.sources.map((w) => w.id), ['chain-inflow']);
  const w = s.sources[0] as Extract<WaterSource, { type: 'inflow' }>;
  assert.ok(w.hydrograph && w.hydrograph.length > 3);
  assert.equal(w.hydrograph[0].t, 0);
  assert.deepEqual(s.scenario!.sources.map((x) => x.id), ['chain-inflow']);
  assert.ok(resets >= 1, 'the water was reset for the new hydrograph');
  assert.ok(seen.includes('running') && seen.includes('ensemble'));

  // A what-if re-runs and replaces the inflow; the preset's own inflow comes back with the switch.
  const before = w.discharge;
  bridgeFor(store).chainControl!.run({ overrides: { volumeFactor: 0.5 } });
  await until(() => bridgeFor(store).chain?.status === 'ensemble' || bridgeFor(store).chain?.status === 'ready');
  await until(() => bridgeFor(store).chain?.status === 'ready');
  const half = store.get().sources[0] as Extract<WaterSource, { type: 'inflow' }>;
  assert.ok(half.discharge < before, `half the volume, lower peak (${half.discharge} < ${before})`);
  bridgeFor(store).chainControl!.setInflow('scenario');
  await until(() => store.get().sources[0]?.id === 'edge');
  assert.equal(bridgeFor(store).chain!.inflow, 'scenario');
  assert.equal(bridgeFor(store).chain!.offset, bridgeFor(store).chain!.result!.entryFront, 'the preset inflow starts as the front reaches the edge');

  // Leaving the scene clears the chain; a scene without one publishes nothing.
  c.onSceneCleared();
  assert.equal(bridgeFor(store).chain, null);
  c.onSceneReady({ request: { kind: 'preset', id: 'pittsburgh' }, terrain: { scenario: { ...scenario, hazardChain: undefined } } } as never);
  assert.equal(bridgeFor(store).chain, null);
  assert.equal(bridgeFor(store).chainControl, null);
});

test('controller: a crashed worker is replaced, not kept (the next run gets a fresh backend)', async () => {
  const file = valley();
  const spec = givenSpec();
  const presetInflow: WaterSource = { id: 'edge', type: 'inflow', gx: 10, gy: 10, radius: 4, discharge: 7000 };
  const scenario = { description: '', sources: [presetInflow], storms: [], shelters: [], rainRate: 0, stage: null, initialFill: [], hazardChain: spec };
  const store = createStore(baseState({ presetId: 'nepal', scenario: scenario as never, sources: [{ ...presetInflow }] }));
  // The first backend's worker dies on its first request (createHazardWorker's fail(): broken, every request refused).
  const crashed: HazardChainBackend & { disposed: boolean } = {
    offThread: true,
    broken: false,
    disposed: false,
    async run() {
      (crashed as { broken: boolean }).broken = true;
      throw new Error('hazard-chain worker failed');
    },
    async ensemble() {
      throw new Error('hazard-chain worker failed');
    },
    dispose() {
      crashed.disposed = true;
    },
  };
  const made: HazardChainBackend[] = [];
  const createBackend = () => {
    const b = made.length === 0 ? crashed : inlineBackend();
    made.push(b);
    return b;
  };
  const c = new HazardChainController({ store, errors: { warn() {} } as never, resetWater() {}, createBackend, loadFile: async () => file });
  c.onSceneReady({ request: { kind: 'preset', id: 'nepal' }, terrain: { scenario } } as never);
  await until(() => bridgeFor(store).chain?.status === 'error');
  assert.equal(crashed.disposed, true, 'the broken backend is disposed');
  bridgeFor(store).chainControl!.run({ overrides: {} });
  await until(() => bridgeFor(store).chain?.status === 'ready');
  assert.equal(made.length, 2, 'a new backend for the next run');
  assert.ok(bridgeFor(store).chain!.result, 'and it answers');
  c.dispose();
});

test('controller: a profile that cannot load falls back on the preset’s inflow and says why', async () => {
  const presetInflow: WaterSource = { id: 'edge', type: 'inflow', gx: 10, gy: 10, radius: 4, discharge: 7000 };
  const scenario = { description: '', sources: [presetInflow], storms: [], shelters: [], rainRate: 0, stage: null, initialFill: [], hazardChain: givenSpec() };
  const store = createStore(baseState({ scenario: scenario as never, sources: [{ ...presetInflow }] }));
  const c = new HazardChainController({ store, errors: { warn() {} } as never, resetWater() {}, createBackend: inlineBackend, loadFile: async () => ({ version: 7 }) });
  c.onSceneReady({ request: { kind: 'preset', id: 'nepal' }, terrain: { scenario } } as never);
  await until(() => bridgeFor(store).chain?.status === 'error');
  assert.match(bridgeFor(store).chain!.error!, /not a valley profile/);
  assert.equal(bridgeFor(store).chain!.inflow, 'scenario');
  assert.deepEqual(store.get().sources.map((w) => w.id), ['edge']);
});

test('Try-it strip: a glacier hazard-chain preset is recognised (it gets its own steps, no hurricane rain)', async () => {
  const { isGlacierScene } = await import('../../src/ui/welcome');
  assert.equal(isGlacierScene({ scenario: null }), false);
  assert.equal(isGlacierScene({ scenario: { sources: [], storms: [], shelters: [], rainRate: 0, stage: null, initialFill: [] } as never }), false);
  assert.equal(isGlacierScene({ scenario: { sources: [], hazardChain: givenSpec() } as never }), true);
});
