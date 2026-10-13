/**
 * Future-climate scenarios (src/climate): the tables and their arithmetic, "Today" as the identity, what each preset
 * scales and what it leaves alone, the layer in SimSync (solver scaled, store untouched), the climate panel's lines and
 * the Site check's today-vs-future EAL.
 * Run: node --import tsx --test tests/climate/climate.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { FloodSolver, ScenarioPreset, SimParams, StormCell, WaterSource } from '../../src/contracts';
import { PRESETS } from '../../src/data/presets';
import {
  AR6_WARMING_PREINDUSTRIAL,
  AR6_WARMING_RECENT,
  CLIMATE_SOURCES,
  CLIMATE_TODAY,
  climateForcing,
  globalWarming,
  inflowScaled,
  LAKE_TRENDS,
  PRESET_CLIMATE,
  rainMultiplier,
  RAIN_SCALING,
  scaleRain,
  scaleSources,
  scaleStorms,
  seaLevelRise,
  seaLevelRiseAt,
  stageShift,
  sweepComparable,
  TIDE_GAUGE_SLR,
  warmingBetween,
  type ClimateSelection,
} from '../../src/climate';
import { createInitialState } from '../../src/app/defaults';
import { ErrorReporter } from '../../src/app/errors';
import { SimSync } from '../../src/app/simSync';
import { StageLevels } from '../../src/app/stage';
import { createStore } from '../../src/app/store';
import { ClimateLayer } from '../../src/app/climate';
import { climateItems } from '../../src/ui/climatePanel';
import { climateEalSentence, compareClimate, lengthWarning } from '../../src/ui/siteClimate';
import type { SweepRow } from '../../src/loss';

const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps;
const sel = (horizon: ClimateSelection['horizon'], pathway: ClimateSelection['pathway'] = 'ssp585', scaling: ClimateSelection['scaling'] = 'cc'): ClimateSelection => ({ horizon, pathway, scaling });

const inflow = (id: string, q: number, hydrograph?: Array<{ t: number; q: number }>): WaterSource => ({ id, type: 'inflow', gx: 1, gy: 1, radius: 2, discharge: q, ...(hydrograph ? { hydrograph } : {}) });
const stage = (id: string, level: number): WaterSource => ({ id, type: 'stage', gx: 0, gy: 0, radius: 2, level });
const storm = (id: string, intensity: number): StormCell => ({ id, gx: 5, gy: 5, radius: 10, intensity });

// ─── tables ─────────────────────────────────────────────────────────────────────────────────────

test('warming: AR6 Table SPM.1 shifted to the 1995–2014 baseline (−0.85 °C); 2080 interpolated', () => {
  assert.deepEqual(AR6_WARMING_PREINDUSTRIAL.ssp585.mid, { best: 2.4, lo: 1.9, hi: 3.0 });
  assert.deepEqual(AR6_WARMING_PREINDUSTRIAL.ssp245.long, { best: 2.7, lo: 2.1, hi: 3.5 });
  assert.ok(near(AR6_WARMING_RECENT.ssp245.mid.best, 1.15));
  assert.ok(near(AR6_WARMING_RECENT.ssp585.long.best, 3.55));
  assert.deepEqual(globalWarming('ssp585', 'today'), { best: 0, lo: 0, hi: 0 });
  assert.ok(near(globalWarming('ssp585', '2050').best, 1.55));
  assert.ok(near(globalWarming('ssp585', '2100').best, 3.55));
  // 2080 = 2050 + 0.75·(2090 − 2050 values)
  assert.ok(near(globalWarming('ssp585', '2080').best, 1.55 + 0.75 * 2.0, 0.006));
  assert.ok(near(globalWarming('ssp245', '2080').best, 1.15 + 0.75 * 0.7, 0.006));
  for (const p of ['ssp245', 'ssp585'] as const) {
    const w = [globalWarming(p, '2050'), globalWarming(p, '2080'), globalWarming(p, '2100')];
    for (const x of w) assert.ok(x.lo < x.best && x.best < x.hi);
    assert.ok(w[0].best < w[1].best && w[1].best < w[2].best, 'warming grows with the horizon');
  }
  assert.ok(globalWarming('ssp585', '2100').best > globalWarming('ssp245', '2100').best);
});

test('rain multiplier: (1+α)^ΔT; 7 %/°C reproduces AR6 Fig. SPM.6 (10-yr 1-day: +14.0 % at 2 °C, +30.2 % at 4 °C)', () => {
  assert.equal(rainMultiplier(0, 0.07), 1);
  assert.equal(rainMultiplier(-1, 0.07), 1);
  assert.ok(near(rainMultiplier(1.55, 0.07), Math.pow(1.07, 1.55)));
  assert.ok(Math.abs(rainMultiplier(2, 0.07) - 1.14) < 0.01);
  assert.ok(Math.abs(rainMultiplier(4, 0.07) - 1.302) < 0.012);
  assert.deepEqual(Object.values(RAIN_SCALING).map((r) => r.alpha), [0.07, 0.1, 0.14]);
  const cc = climateForcing(sel('2050', 'ssp585', 'cc'), 'houston');
  const sc = climateForcing(sel('2050', 'ssp585', 'super14'), 'houston');
  assert.ok(near(cc.rainMult, Math.pow(1.07, 1.55)));
  assert.ok(near(sc.rainMult, Math.pow(1.14, 1.55)));
  assert.ok(cc.rainMultRange[0] < cc.rainMult && cc.rainMult < cc.rainMultRange[1]);
});

test('sea level: NOAA 2022 at Fort Myers (zeroed 2005); SSP2-4.5 → Intermediate-Low, SSP5-8.5 → Intermediate', () => {
  const g = TIDE_GAUGE_SLR['fort-myers'];
  assert.equal(seaLevelRise(g, 'ssp585', 'today'), 0);
  assert.equal(seaLevelRise(g, 'ssp585', '2050'), 0.32);
  assert.equal(seaLevelRise(g, 'ssp585', '2080'), 0.7);
  assert.equal(seaLevelRise(g, 'ssp585', '2100'), 1.1);
  assert.equal(seaLevelRise(g, 'ssp245', '2050'), 0.28);
  assert.equal(seaLevelRise(g, 'ssp245', '2100'), 0.62);
  assert.equal(seaLevelRiseAt(g, 'int', 2005), 0);
  assert.ok(near(seaLevelRiseAt(g, 'int', 2026), (0.32 * 21) / 45));
  for (const s of ['low', 'intLow', 'int', 'intHigh', 'high'] as const) {
    const r = g.rise[s];
    assert.ok(r[2050] < r[2080] && r[2080] < r[2100], s);
  }
});

test('glacial lake: South Lhonak grows with warming, capped at 2×; volume from the V–A relations (×A^~1.45)', () => {
  const lake = LAKE_TRENDS['south-lhonak'];
  assert.ok(warmingBetween('ssp585', 2023, 2023) === 0);
  assert.ok(warmingBetween('ssp585', 2023, 2050) > warmingBetween('ssp245', 2023, 2050));
  const mid = climateForcing(sel('2050', 'ssp245'), 'chungthang').lake!;
  const hi = climateForcing(sel('2100', 'ssp585'), 'chungthang').lake!;
  assert.ok(mid.areaFactor > 1 && mid.areaFactor < 2, `2050 SSP2-4.5 area ×${mid.areaFactor}`);
  assert.ok(near(hi.area, lake.maxArea!), 'capped');
  // V ∝ A^1.38–1.53 for the default members: the volume factor sits between A^1.3 and A^1.6.
  for (const l of [mid, hi]) assert.ok(l.volumeFactor > Math.pow(l.areaFactor, 1.3) && l.volumeFactor < Math.pow(l.areaFactor, 1.6), `${l.areaFactor} → ${l.volumeFactor}`);
  assert.equal(climateForcing(sel('2050'), 'nepal').lake, null, 'an avalanche is not a lake');
});

test('every source key the tables cite exists', () => {
  const keys = new Set(Object.keys(CLIMATE_SOURCES));
  for (const r of Object.values(RAIN_SCALING)) for (const k of r.sources) assert.ok(keys.has(k), k);
  for (const g of Object.values(TIDE_GAUGE_SLR)) assert.ok(keys.has(g.source), g.source);
  for (const l of Object.values(LAKE_TRENDS)) assert.ok(keys.has(l.source), l.source);
  for (const id of Object.keys(PRESET_CLIMATE)) assert.ok(keys.has(climateForcing(sel('2050'), id).region.source), id);
});

// ─── Today is the identity ───────────────────────────────────────────────────────────────────────

test('"Today" is the identity on every preset: same arrays, same rain, no sea rise, no lake', () => {
  const sources = [inflow('a', 100, [{ t: 0, q: 10 }, { t: 60, q: 100 }]), stage('s', 3)];
  const storms = [storm('x', 80)];
  for (const id of [...Object.keys(PRESET_CLIMATE), 'sandbox', null]) {
    for (const s of [CLIMATE_TODAY, sel('today', 'ssp245', 'super14'), undefined]) {
      const f = climateForcing(s, id);
      assert.equal(f.identity, true);
      assert.equal(f.rainMult, 1);
      assert.equal(f.inflowMult, 1);
      assert.equal(f.seaRiseM, 0);
      assert.equal(f.lake, null);
      assert.equal(stageShift(f), 0);
      assert.equal(scaleSources(sources, f), sources);
      assert.equal(scaleStorms(storms, f), storms);
      assert.equal(scaleRain(173, f), 173);
      assert.equal(f.label, 'Today');
    }
  }
  assert.equal(scaleSources(sources, null), sources);
});

// ─── what each preset scales ─────────────────────────────────────────────────────────────────────

test('Houston 2050 SSP5-8.5: rain, storm cells and the bayou inflow (and its hydrograph) scale together; stage untouched', () => {
  const f = climateForcing(sel('2050'), 'houston');
  const k = f.rainMult;
  assert.ok(k > 1.1 && k < 1.12, `×${k}`);
  assert.equal(f.inflowMult, k);
  const sources = [inflow('buffalo-bayou-inflow', 923, [{ t: 0, q: 100 }, { t: 600, q: 923 }]), stage('s', 3)];
  const out = scaleSources(sources, f);
  assert.notEqual(out, sources);
  const q = out[0] as Extract<WaterSource, { type: 'inflow' }>;
  assert.ok(near(q.discharge, 923 * k));
  assert.ok(near(q.hydrograph![1].q, 923 * k) && q.hydrograph![1].t === 600);
  assert.equal(out[1], sources[1], 'stage sources pass through');
  assert.equal((sources[0] as { discharge: number }).discharge, 923, 'input not mutated');
  assert.ok(near(scaleStorms([storm('a', 110)], f)[0].intensity, 110 * k));
  assert.ok(near(scaleRain(173, f), 173 * k));
  assert.equal(f.seaRiseM, 0);
  assert.equal(sweepComparable(f, 'scale').ok, true);
});

test('Johnstown: the 1889 dam-break surge is never rain-scaled; the Stonycreek is', () => {
  const f = climateForcing(sel('2080'), 'johnstown');
  const out = scaleSources([inflow('stonycreek-inflow', 300), inflow('little-conemaugh-inflow', 3730)], f);
  assert.ok(near((out[0] as { discharge: number }).discharge, 300 * f.rainMult));
  assert.equal((out[1] as { discharge: number }).discharge, 3730);
});

test('Pittsburgh: river stage not scaled; the sweep cannot compare a stage ladder', () => {
  const f = climateForcing(sel('2100'), 'pittsburgh');
  assert.equal(f.riverStageUnscaled, true);
  assert.equal(stageShift(f), 0);
  assert.equal(sweepComparable(f, 'stage').ok, false);
  assert.ok(f.rainMult > 1, 'rain still scales');
});

test('Fort Myers: sea-level rise shifts the sea boundary; the tide ladder can be compared', () => {
  const f = climateForcing(sel('2050', 'ssp585'), 'ftmyers');
  assert.equal(stageShift(f), 0.32);
  assert.equal(f.seaScenario, 'Intermediate');
  assert.equal(sweepComparable(f, 'stage').ok, true);
  assert.equal(sweepComparable(climateForcing(CLIMATE_TODAY, 'ftmyers'), 'stage').ok, false);
});

test('chain presets: the chain wave is not rain-scaled; South Lhonak grows; no sweep comparison', () => {
  const f = climateForcing(sel('2050'), 'chungthang');
  assert.equal(f.inflowMult, 1);
  const sources = [inflow('chain-inflow', 9578)];
  assert.equal(scaleSources(sources, f), sources);
  assert.ok(f.lake && f.lake.volumeFactor > 1);
  assert.ok(f.meltPerDay! > 0);
  assert.equal(sweepComparable(f, 'scale').ok, false);
});

test('every preset: a hazard-chain flood is never rain-scaled, and every baked preset has its own climate profile', () => {
  const root = path.resolve(import.meta.dirname, '../../public/presets');
  const f2100 = sel('2100');
  for (const { id } of PRESETS) {
    const file = path.join(root, id, 'meta.json');
    if (id === 'sandbox' || !fs.existsSync(file)) continue;
    const scenario = (JSON.parse(fs.readFileSync(file, 'utf8')) as { scenario: ScenarioPreset }).scenario;
    // A baked preset is not left to the US defaults (the region decides the warming and the rain scaling).
    assert.ok(Object.prototype.hasOwnProperty.call(PRESET_CLIMATE, id), `${id}: no PRESET_CLIMATE entry`);
    const chain = !!scenario.hazardChain;
    // With and without the scenario (the Site check asks by preset id alone): the same answer.
    for (const f of [climateForcing(f2100, id, scenario), climateForcing(f2100, id)]) {
      assert.equal(f.chainInflows, chain, `${id}: chainInflows`);
      if (chain) {
        assert.equal(f.inflowMult, 1, `${id}: the chain wave is a mass movement / outburst, not rain`);
        assert.equal(f.region.id, 'hkh', `${id}: a Himalayan chain is not a US region`);
        for (const s of scenario.sources) if (s.type === 'inflow') assert.equal(inflowScaled(f, s), false, `${id}: ${s.id} scaled`);
        assert.equal(scaleSources(scenario.sources, f), scenario.sources, `${id}: sources untouched`);
      }
      if (!scenario.stage) assert.equal(f.seaRiseM, 0, `${id}: no stage, no sea-level rise`);
    }
  }
  // Chamoli: the Ronti Peak rock-ice avalanche — no lake to grow, no stage.
  const ch = climateForcing(f2100, 'chamoli');
  assert.equal(ch.lake, null);
  assert.equal(ch.seaRiseM, 0);
  assert.ok(ch.note && /avalanche/.test(ch.note));
  // Any scenario with a hazard chain defaults to an unscaled chain inflow, even one no table knows.
  const spec = { trigger: { kind: 'given', hydrograph: [], provenance: 'test' }, profile: 'chain.json' } as unknown as ScenarioPreset['hazardChain'];
  const unknown = climateForcing(f2100, 'not-a-preset', { hazardChain: spec });
  assert.equal(unknown.chainInflows, true);
  assert.equal(unknown.inflowMult, 1);
  assert.equal(inflowScaled(unknown, inflow('chain-inflow', 5000)), false);
  assert.equal(climateForcing(f2100, 'not-a-preset').chainInflows, false, 'without a chain: the defaults (rain-fed inflows scaled)');
});

// ─── the layer in the app ────────────────────────────────────────────────────────────────────────

class FakeSolver {
  params: SimParams | null = null;
  sources: WaterSource[] = [];
  storms: StormCell[] = [];
  setSources(s: WaterSource[]) {
    this.sources = s;
  }
  setStorms(s: StormCell[]) {
    this.storms = s;
  }
}

test('SimSync + ClimateLayer: the solver gets the scaled forcing, the store keeps today’s; back to Today restores it', () => {
  const store = createStore({ ...createInitialState(), presetId: 'houston' });
  const solver = new FakeSolver();
  const levels = new StageLevels();
  let layer: ClimateLayer | null = null;
  const sync = new SimSync({
    store,
    stage: levels,
    errors: new ErrorReporter(),
    getSolver: () => solver as unknown as FloodSolver,
    getAppliedStageOffset: () => store.get().stageOffset,
    onRouteInputsChanged: () => {},
    getClimate: () => layer?.get() ?? null,
  });
  layer = new ClimateLayer({ store, onChange: () => sync.pushAll() });
  layer.install();
  sync.install();
  const sources = [inflow('buffalo-bayou-inflow', 923)];
  store.set({ sources, storms: [storm('s', 100)], sim: { ...store.get().sim, rainRate: 173 } });
  assert.equal(solver.params!.rainRate, 173);
  assert.equal((solver.sources[0] as { discharge: number }).discharge, 923);

  store.set({ climate: sel('2050') });
  const k = climateForcing(sel('2050'), 'houston').rainMult;
  assert.ok(near(solver.params!.rainRate, 173 * k));
  assert.ok(near((solver.sources[0] as { discharge: number }).discharge, 923 * k));
  assert.ok(near(solver.storms[0].intensity, 100 * k));
  assert.equal(store.get().sim.rainRate, 173, 'the rain slider keeps today');
  assert.equal(store.get().sources, sources, 'the inflow list keeps today');

  // Editing today's rain under a future climate scales the new value.
  store.set({ sim: { ...store.get().sim, rainRate: 50 } });
  assert.ok(near(solver.params!.rainRate, 50 * k));

  store.set({ climate: { ...CLIMATE_TODAY } });
  assert.equal(solver.params!.rainRate, 50);
  assert.equal((solver.sources[0] as { discharge: number }).discharge, 923);
  assert.equal(solver.storms[0].intensity, 100);
});

// ─── UI text and the Site check comparison ───────────────────────────────────────────────────────

test('climate panel lines: nothing for Today; the rain line names the multiplier and the map’s numbers', () => {
  const s = { sources: [inflow('buffalo-bayou-inflow', 923)], storms: [] as StormCell[], sim: { rainRate: 173 } };
  assert.deepEqual(climateItems(climateForcing(CLIMATE_TODAY, 'houston'), s), []);
  const items = climateItems(climateForcing(sel('2050'), 'houston'), s);
  const rain = items.find((i) => i.key === 'rain')!;
  assert.ok(rain.applied && /× 1\.11/.test(rain.value) && /173/.test(rain.value), rain.value);
  assert.ok(items.find((i) => i.key === 'inflow')!.applied);
  const pgh = climateItems(climateForcing(sel('2050'), 'pittsburgh'), { sources: [], storms: [], sim: { rainRate: 0 } });
  assert.ok(pgh.some((i) => i.key === 'stage' && !i.applied));
  const fm = climateItems(climateForcing(sel('2080', 'ssp245'), 'ftmyers'), { sources: [], storms: [], sim: { rainRate: 0 } });
  assert.ok(fm.some((i) => i.key === 'sea' && i.applied && /\+0\.49 m/.test(i.value)));
});

test('today vs future: EAL from the same return periods, the future losses higher', () => {
  const row = (id: string, T: number, loss: number): SweepRow =>
    ({
      level: { id, label: id, ft: NaN, scale: T, returnPeriod: null, rpFrom: null, durationS: 600 },
      run: { result: { reached: loss > 0, loss, depthAboveFloor: 0.5 }, egress: null },
    }) as unknown as SweepRow;
  const pair = {
    label: '2050 · SSP5-8.5',
    changes: ['rain & storm cells × 1.11'],
    today: new Map([['s1', [row('x0.5', 10, 0), row('x1', 100, 1000)]]]),
    future: new Map([['s1', [row('x0.5', 10, 200), row('x1', 100, 1500)]]]),
  };
  const rp = (id: string) => (id === 'x0.5' ? 10 : 100);
  const c = compareClimate(pair, 's1', rp)!;
  assert.ok(c.todayEal && c.futureEal);
  // today: ½(0+1000)(0.1−0.01) = 45, tail 10 → 45–55; future: ½(200+1500)(0.09) = 76.5, tail 15 → 76.5–91.5
  assert.ok(near(c.todayEal!.low, 45) && near(c.todayEal!.high, 55));
  assert.ok(near(c.futureEal!.low, 76.5) && near(c.futureEal!.high, 91.5));
  assert.ok(near(c.change!, 84 / 50 - 1));
  const text = climateEalSentence(c, (v) => `$${Math.round(v)}`);
  assert.equal(text, 'EAL today $45–$55 a year → 2050 · SSP5-8.5 $77–$92 (+68 %)');
  assert.equal(compareClimate(pair, 'other', rp), null);
  const none = compareClimate(pair, 's1', () => null)!;
  assert.match(climateEalSentence(none, String), /not computed/);
  // Equal run lengths: no warning. A future run 10 % longer: the panel says part of the change is run length.
  assert.equal(lengthWarning(c), null);
  const long = { ...pair, future: new Map([['s1', pair.future.get('s1')!.map((r) => ({ ...r, level: { ...r.level, durationS: 660 } }))]]) };
  assert.match(lengthWarning(compareClimate(long, 's1', rp)!) ?? '', /differ in simulated length .*10 vs 11 min/);
});

// ─── the chain re-runs with the grown lake ───────────────────────────────────────────────────────

test('hazard chain: the climate volume factor multiplies every run (on top of the panel’s what-if) and re-runs it', async () => {
  const { HazardChainController } = await import('../../src/app/hazardChain');
  const { bridgeFor } = await import('../../src/ui/bridge');
  const file = { version: 1, name: 'v', s: [0, 1000], zBed: [10, 0], n: [0.04, 0.04], sections: [{}, {}], stations: [], structures: [], domainEntry: { s: 1000, gx: 0, gy: 0, radius: 2 } };
  const spec = { trigger: { kind: 'given' }, profile: 'chain.json', rheology: { kind: 'water' } };
  const scenario = { description: '', sources: [], storms: [], shelters: [], rainRate: 0, stage: null, initialFill: [], hazardChain: spec };
  const store = createStore({ ...createInitialState(), presetId: 'chungthang', scenario: scenario as never });
  const seen: Array<number | undefined> = [];
  // A backend whose runs never finish: only what it was asked matters here.
  const backend = () => ({
    offThread: false,
    run: (_s: unknown, _f: unknown, o?: { volumeFactor?: number }) => {
      seen.push(o?.volumeFactor);
      return new Promise<never>(() => {});
    },
    ensemble: () => new Promise<never>(() => {}),
    dispose() {},
  });
  const c = new HazardChainController({ store, errors: { warn() {} } as never, resetWater() {}, createBackend: backend as never, loadFile: async () => file });
  c.setClimateVolumeFactor(2, '2050 · SSP5-8.5'); // before the scene: kept for its first run
  c.onSceneReady({ request: { kind: 'preset', id: 'chungthang' }, terrain: { scenario } } as never);
  assert.deepEqual(bridgeFor(store).chain?.climate, { label: '2050 · SSP5-8.5', volumeFactor: 2 });
  const until = async (f: () => boolean) => {
    for (let i = 0; i < 400 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
    assert.ok(f());
  };
  await until(() => seen.length === 1);
  assert.equal(seen[0], 2);
  bridgeFor(store).chainControl!.run({ overrides: { volumeFactor: 0.5 } });
  await until(() => seen.length === 2);
  assert.equal(seen[1], 1, 'the panel’s 0.5 × the climate’s 2');
  c.setClimateVolumeFactor(1, null);
  await until(() => seen.length === 3);
  assert.equal(seen[2], 0.5, 'back to today: the what-if alone');
  assert.equal(bridgeFor(store).chain?.climate, null);
  c.setClimateVolumeFactor(1, null);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.length, 3, 'no change, no re-run');
  c.dispose();
});
