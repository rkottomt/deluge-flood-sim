/// <reference types="node" />
/**
 * Coastal surge (src/surge): the baked NOAA CO-OPS table, the return-period ladder on the map's datum — checked
 * against the Fort Myers preset's hand-researched ladder (Hurricane Ian, NOAA 8725520) — the seaward-edge boundary on
 * a synthetic coast, the climate layer's sea-level rise at the station, the expected annual loss the ladder gives, and
 * the strict parser against hostile tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScenarioPreset } from '../../src/contracts';
import { climateForcing } from '../../src/climate/apply';
import { TIDE_GAUGE_SLR } from '../../src/climate/scenarios';
import { eal } from '../../src/loss/eal';
import { ladderFor, PRESET_LADDERS } from '../../src/loss/ladders';
import { coastalSetup, gaugeNote, seaMask, stationSlr, surgeLadder, withoutSurgeText } from '../../src/surge/coastal';
import { encodeSurgeTable, mhhwOnDem, nearestStation, parseSurgeTable, SURGE_AEPS, SURGE_LIMITS, surgeLevels, type SurgeStation } from '../../src/surge/stations';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLE = parseSurgeTable(fs.readFileSync(path.join(ROOT, 'public', 'surge', 'ewl-stations.json')));
const FT = 0.3048;
/** Fort Myers preset: gauge datum (station datum) in NAVD88 m (public/presets/ftmyers/meta.json). */
const FTM_GAUGE_DATUM = -1.646;

test('the baked table: ~125 NOAA stations, small, every one valid', () => {
  const bytes = fs.statSync(path.join(ROOT, 'public', 'surge', 'ewl-stations.json')).size;
  assert.ok(bytes < 64 * 1024, `${bytes} bytes`);
  assert.ok(TABLE.stations.length >= 110, `${TABLE.stations.length} stations`);
  assert.equal(TABLE.dropped, 0);
  const withNavd = TABLE.stations.filter((s) => s.mhhwNavd88 !== null).length;
  assert.ok(withNavd >= 80, `${withNavd} with a NAVD88 tie`);
  for (const s of TABLE.stations) assert.ok(s.levels.every((v, i) => i === 0 || v >= s.levels[i - 1]));
});

test('Fort Myers: the generic ladder reproduces the preset’s hand-researched NOAA EWL levels to the centimetre', () => {
  const s = TABLE.stations.find((x) => x.id === '8725520')!;
  assert.ok(s);
  const levels = surgeLevels(s);
  assert.deepEqual(levels.map((l) => l.id), ['ewl-1', 'ewl-2', 'ewl-10', 'ewl-50', 'ewl-100']);
  const preset = PRESET_LADDERS.ftmyers;
  for (const [ours, theirs] of [['ewl-2', 'rp2'], ['ewl-10', 'rp10'], ['ewl-50', 'rp50'], ['ewl-100', 'rp100']] as const) {
    const a = levels.find((l) => l.id === ours)!;
    const b = preset.find((l) => l.id === theirs)!;
    const bNavd = b.ft * FT + FTM_GAUGE_DATUM;
    assert.ok(Math.abs(a.elevation - bNavd) < 0.012, `${ours}: ${a.elevation} m vs preset ${bNavd.toFixed(3)} m NAVD88`);
    assert.equal(a.returnPeriod, b.returnPeriod);
  }
  // The 1 % level: 6.46 ft above MHHW, 90 % CI 4.56–11.13 ft (src/loss/ladders.ts ewl-8725520).
  assert.ok(Math.abs(s.levels[4] / FT - 6.46) < 0.03);
  assert.ok(Math.abs(s.ci100[0] / FT - 4.56) < 0.03 && Math.abs(s.ci100[1] / FT - 11.13) < 0.03);
  // NOAA 2022 SLR at the gauge equals the climate layer's hand-entered Fort Myers record.
  const slr = stationSlr(s)!;
  assert.deepEqual(slr.rise, TIDE_GAUGE_SLR['fort-myers'].rise);
});

test('nearest station: on the coast within range, inland or abroad none', () => {
  const ftm = nearestStation(TABLE, 26.62, -81.87);
  assert.equal(ftm?.station.id, '8725520');
  assert.ok(ftm!.km < 5);
  assert.equal(nearestStation(TABLE, 39.74, -104.99), null, 'Denver');
  assert.equal(nearestStation(TABLE, 51.5, -0.12), null, 'London');
  assert.ok(nearestStation(TABLE, 29.31, -94.79)?.station.name.includes('Galveston'));
});

/** A synthetic coast: open water at 0 m on the west third, land rising east from 0.3 m to 6 m. */
function coast(n = 128) {
  const z = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) z[j * n + i] = i < n / 3 ? 0 : 0.3 + (5.7 * (i - n / 3)) / (n - n / 3);
  return z;
}
const LIVE: ScenarioPreset = {
  description: 'Live area.',
  sources: [{ id: 'stage-1', type: 'stage', gx: 127, gy: 64, radius: 4, level: 5 }, { id: 'in-1', type: 'inflow', gx: 100, gy: 10, radius: 2, discharge: 3 }],
  storms: [],
  shelters: [],
  rainRate: 0,
  stage: { label: 'Water level', gaugeDatum: 5, normalLevel: 5, maxOffset: 10 },
  initialFill: [],
};

test('the gauge line: its distance always, and "possibly in another bay" when it stands off the map', () => {
  const s = TABLE.stations.find((x) => x.id === '8725520')!;
  const n = 128; // 7.68 km square: half-diagonal 5.4 km
  const near = coastalSetup({ elevation: coast(n), nx: n, ny: n, cellSize: 60 }, LIVE, s, 3.2);
  const far = coastalSetup({ elevation: coast(n), nx: n, ny: n, cellSize: 60 }, LIVE, s, 23.4);
  assert.ok(!('error' in near) && !('error' in far));
  assert.equal(near.spec.gaugeOffMap, false);
  assert.equal(far.spec.gaugeOffMap, true);
  assert.match(gaugeNote(near.spec), /Fort Myers \(8725520\), 3\.2 km from the map centre: on this map\./);
  assert.match(gaugeNote(far.spec), /23 km from the map centre: off this map, so possibly in another bay or up another estuary/);
  // A spec saved before the flag existed gives the distance and claims nothing either way.
  assert.equal(gaugeNote({ stationName: 'X', stationId: '1', stationKm: 40 }), 'NOAA gauge X (1), 40 km from the map centre.');
});

test('coastal set-up: the sea boundary on the seaward edges, a NAVD88 stage control, and the ladder in Site check', () => {
  const s = TABLE.stations.find((x) => x.id === '8725520')!;
  const n = 128;
  const out = coastalSetup({ elevation: coast(n), nx: n, ny: n, cellSize: 60 }, LIVE, s, 3.2);
  assert.ok(!('error' in out), 'error' in out ? out.error : '');
  const sc = out.scenario;
  const sea = sc.sources.filter((x) => x.type === 'stage');
  assert.ok(sea.length >= 1 && sea.every((x) => x.id.startsWith('sea-')), 'only sea boundaries');
  assert.ok(sea.every((x) => x.gx < n / 3 || x.gy < 0 || x.gy > n), `on the seaward side: ${sea.map((x) => `${x.gx.toFixed(0)},${x.gy.toFixed(0)}`).join(' ')}`);
  assert.ok(sc.sources.some((x) => x.id === 'in-1'), 'inflows kept');
  assert.equal(out.method, 'dem');
  const st = sc.stage!;
  assert.equal(st.gaugeDatum, 0);
  assert.ok(Math.abs(st.normalLevel - 0.083) < 1e-6);
  const ladder = ladderFor(null, sc)!;
  assert.equal(ladder.length, SURGE_AEPS.length);
  const l100 = ladder[ladder.length - 1];
  // Site check's stage offset for a level: ft·0.3048 + gaugeDatum − normalLevel = the level above MHHW.
  assert.ok(Math.abs(l100.ft * FT - st.normalLevel - 1.97) < 0.01);
  assert.ok(ladder.every((l) => l.ft * FT - st.normalLevel <= st.maxOffset), 'every level inside the control');
  assert.equal(l100.source, 'noaa-ewl');
  // Climate: today vs 2050 SSP5-8.5 raises the sea by NOAA Intermediate at the gauge (0.32 m).
  const f = climateForcing({ horizon: '2050', pathway: 'ssp585', scaling: 'cc' }, null, sc);
  assert.ok(Math.abs(f.seaRiseM - 0.32) < 1e-9, `${f.seaRiseM}`);
  assert.match(f.seaGauge!.name, /Fort Myers/);
});

test('coastal set-up: pre-filled water at sea level is the sea; a lake at 12 m reaching the edge is not', () => {
  const s = TABLE.stations.find((x) => x.id === '8725520')!;
  const n = 96;
  const z = new Float32Array(n * n).fill(10);
  const depth = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < 20; i++) {
      z[j * n + i] = -3; // burned sea, filled to 0 m
      depth[j * n + i] = 3;
    }
    for (let i = n - 20; i < n; i++) {
      z[j * n + i] = 9; // an upland lake at 12 m
      depth[j * n + i] = 3;
    }
  }
  const z0 = mhhwOnDem(s).m;
  const m = seaMask(z, n, n, 60, depth, { mhhw: z0, msl: z0 - s.mhhwMsl });
  assert.equal(m.method, 'water');
  assert.equal(m.mask[10 * n + 5], 1);
  assert.equal(m.mask[10 * n + n - 5], 0);
  // Inland with no sea at all: a reason, not a scenario.
  const inland = coastalSetup({ elevation: new Float32Array(n * n).fill(30), nx: n, ny: n, cellSize: 60 }, LIVE, s, 50);
  assert.ok('error' in inland && /No sea reaches the edge/.test(inland.error));
});

test('re-running the coastal set-up replaces its sentences in the description, never stacks them', () => {
  const s = TABLE.stations.find((x) => x.id === '8725520')!;
  const n = 128;
  const grid = { elevation: coast(n), nx: n, ny: n, cellSize: 60 };
  const first = coastalSetup(grid, LIVE, s, 3.2);
  assert.ok(!('error' in first));
  // As the surge view does: the previous set-up taken out, then the new one put in.
  const again = coastalSetup(grid, { ...first.scenario, description: withoutSurgeText(first.scenario), coastal: undefined }, s, 3.2);
  assert.ok(!('error' in again));
  assert.equal((again.scenario.description.match(/Coastal surge set-up/g) ?? []).length, 1, again.scenario.description);
  assert.ok(again.scenario.description.startsWith(LIVE.description));
  // Handed the coastal scenario itself, the builder still starts from the area's own description.
  const direct = coastalSetup(grid, first.scenario, s, 3.2);
  assert.ok(!('error' in direct) && (direct.scenario.description.match(/Coastal surge set-up/g) ?? []).length === 1);
});

test('the surge ladder ends in an expected annual loss from NOAA’s return periods alone', () => {
  const s = TABLE.stations.find((x) => x.id === '8725520')!;
  const ladder = surgeLadder(surgeLevels(s), s);
  // A site whose loss grows with the level above a 1.0 m NAVD88 floor: $0 at 1-, 2-yr, then $40k per 0.1 m.
  const pts = ladder.map((l) => ({ T: l.returnPeriod!, loss: Math.max(0, l.ft * FT - 1.0) * 400_000 }));
  const e = eal(pts);
  assert.ok(e > 0 && e < 400_000, `EAL ${e}`);
  assert.ok(pts.every((p) => p.T >= 1));
});

const good = (): SurgeStation => ({
  id: '8725520',
  name: 'Fort Myers',
  state: 'FL',
  lat: 26.6478,
  lon: -81.8711,
  epoch: '1983-2001',
  mhhwNavd88: 0.083,
  mhhwMsl: 0.208,
  levels: [0.25, 0.49, 0.92, 1.57, 1.97],
  ci100: [1.39, 3.39],
  slr: null,
});

test('hostile surge tables: wrong shape refused, bad stations dropped, text cleaned', () => {
  const ok = encodeSurgeTable({ generated: '2026-10-13', stations: [good()] });
  assert.equal(parseSurgeTable(ok).stations.length, 1);
  assert.throws(() => parseSurgeTable('x'.repeat(SURGE_LIMITS.maxBytes + 1)), /too large/);
  assert.throws(() => parseSurgeTable('{"format": "deluge-ewl-1", '), /not JSON/);
  assert.throws(() => parseSurgeTable(new Uint8Array([0x7b, 0xff, 0x7d])), /not UTF-8/);
  assert.throws(() => parseSurgeTable(ok.replace('deluge-ewl-1', 'other')), /unknown format/);
  assert.throws(() => parseSurgeTable(ok.replace('"aeps": [0.99,', '"aeps": [0.9,')), /probabilities/);
  assert.throws(() => parseSurgeTable('[]'), /not an object/);
  const bad = [
    { ...good(), id: '<img src=x onerror=alert(1)>' },
    { ...good(), id: '8725521', levels: [0.25, 0.49, 0.3, 1.57, 1.97] },
    { ...good(), id: '8725522', levels: [0.25, 0.49, 0.92, 1.57, 99] },
    { ...good(), id: '8725523', lat: Number.NaN },
    { ...good(), id: '8725524', mhhwNavd88: 40 },
    { ...good(), id: '8725525', ci100: [3, 1] },
    { ...good(), id: '8725526', slr: { low: [0, 0, 0] } },
    { ...good(), id: '8725520' }, // duplicate
  ] as unknown as SurgeStation[];
  const mixed = parseSurgeTable(encodeSurgeTable({ generated: '2026-10-13', stations: [good(), ...bad] }));
  assert.deepEqual(mixed.stations.map((s) => s.id), ['8725520']);
  assert.equal(mixed.dropped, bad.length);
  const named = parseSurgeTable(encodeSurgeTable({ generated: '2026-10-13', stations: [{ ...good(), name: 'Fort ‮Myers <b>x</b>' }] }));
  assert.doesNotMatch(named.stations[0].name, /[<>‮]/);
  assert.throws(() => parseSurgeTable(encodeSurgeTable({ generated: 'x', stations: bad.slice(0, -1) })), /no valid station/);
});
