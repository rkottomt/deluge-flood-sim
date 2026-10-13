/// <reference types="node" />
/**
 * Run each glacier preset's hazard chain once at bake time and make the 2-D scenario USE it:
 *
 *   npx tsx scripts/bake-chain-result.ts            # every preset with a chain (scripts/chain-defs.ts)
 *   npx tsx scripts/bake-chain-result.ts nepal
 *
 * Run it after scripts/bake-chain.ts (it reads chain.json and meta.json `scenario.hazardChain`). It
 *
 *   1. runs the ensemble (src/hazard/chain.ts runEnsemble: volume × erosion rate × source Cv, every member on the
 *      baked 100 m grid);
 *   2. picks the ensemble's MEDIAN MEMBER — the member whose peak at the domain entry is the median of the members'
 *      (the member counts are odd, so it is one of them) — and re-runs it to the end of its recession;
 *   3. writes that run's routed entry hydrograph into meta.json as the preset's inflow (toWaterSource: the chain's
 *      clock shifted so the 2-D run starts five minutes before the front reaches the map, the volume after that
 *      instant exact, then a finite ramp down to the entry baseflow), replacing the placeholder that stood there, with
 *      a provenance label — so the standalone 2-D
 *      scenario is that member, not a separate guess;
 *   4. writes public/presets/<id>/chain-result.json (src/hazard/types.ts BakedChainResult): station fronts, peaks,
 *      stages and lead times of that run, the ensemble's p10/p50/p90 per station, and the observations beside them,
 *      so the UI shows them without re-running the chain;
 *   5. rewrites the scenario description from those numbers (DESCRIPTIONS below), so the text a visitor reads says
 *      what the model gives against what was observed, in the event's own clock.
 *
 * scripts/bake-presets.ts calls applyChainResult() too, so re-baking a preset keeps the chain inflow.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PresetMeta } from '../src/data/presets';
import type { ScenarioPreset, WaterSource } from '../src/contracts';
import { domainClockOffset, MEMBER_DX, runChain, runEnsemble, toWaterSource, type ChainRunResult } from '../src/hazard/chain';
import type { BakedBand, BakedChainResult, ChainFile, HazardChainSpec } from '../src/hazard/types';
import { CHAIN_DEFS } from './chain-defs';
import { REPO_ROOT } from './osm-fetch';

const PRESETS_DIR = path.join(REPO_ROOT, 'public/presets');
export const CHAIN_RESULT_FILE = 'chain-result.json';

const fin = (x: number): number | null => (Number.isFinite(x) ? Math.round(x) : null);
const r1 = (x: number) => Math.round(x * 10) / 10;
const band = (b: { tFront: [number, number, number]; qPeak: [number, number, number] }): BakedBand => ({
  tFront: [fin(b.tFront[0]), fin(b.tFront[1]), fin(b.tFront[2])],
  qPeak: [Math.round(b.qPeak[0]), Math.round(b.qPeak[1]), Math.round(b.qPeak[2])],
});

/** "HH:MM" of chain time t (s) on the event's own clock (the offset in ChainFile.clockZero, e.g. +05:45). */
export function clockAt(clockZero: string, t: number): string {
  const m = /T(\d\d):(\d\d)(?::(\d\d))?/.exec(clockZero);
  if (!m) return `${Math.round(t / 60)} min`;
  const s0 = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
  const s = (((Math.round(s0 + t) % 86400) + 86400) % 86400) / 60;
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

export interface ChainBake {
  result: BakedChainResult;
  inflow: Extract<WaterSource, { type: 'inflow' }>;
  run: ChainRunResult;
}

/** Steps 1–4 for one preset, without touching the disk. */
export function bakeChainResult(id: string, spec: HazardChainSpec, file: ChainFile, sourceId: string, label: string): ChainBake {
  const t0 = performance.now();
  const ens = runEnsemble(spec, file);
  const order = ens.members.map((m, k) => ({ k, q: m.entryPeak })).sort((a, b) => a.q - b.q || a.k - b.k);
  const med = ens.members[order[(order.length - 1) >> 1].k];
  const run = runChain(spec, file, {
    volumeFactor: med.volumeFactor,
    ...(Number.isFinite(med.erosionRate) ? { erosionRate: med.erosionRate } : {}),
    cv: med.cv,
  });
  const ms = performance.now() - t0;
  const inflow = toWaterSource(run, file, { id: sourceId, label });
  inflow.hydrograph = inflow.hydrograph!.map((p) => ({ t: Math.round(p.t * 10) / 10, q: Math.round(p.q * 100) / 100 }));
  inflow.discharge = Math.round(inflow.discharge);
  const offset = domainClockOffset(run);
  const obs = spec.observations ?? [];
  // The whole curve: the routed volume after the offset plus the ramp to baseflow (toWaterSource ends on it).
  const inflowVolume = hydrographArea(inflow.hydrograph!);
  const result: BakedChainResult = {
    version: 1,
    preset: id,
    profile: spec.profile,
    ...(file.clockZero ? { clockZero: file.clockZero } : {}),
    generated: new Date().toISOString().slice(0, 10),
    generator: 'scripts/bake-chain-result.ts',
    provenance: 'modelled',
    label: `Hazard chain, modelled: the ensemble's median member (volume ×${r1(med.volumeFactor)}, ` +
      `${Number.isFinite(med.erosionRate) ? `breach ${med.erosionRate} m/h, ` : ''}source Cv ${med.cv}) routed down ${file.name}`,
    run: {
      routeDx: run.routing.dx,
      memberDx: MEMBER_DX,
      members: ens.members.length,
      ms: Math.round(ms),
      member: { volumeFactor: med.volumeFactor, ...(Number.isFinite(med.erosionRate) ? { erosionRate: med.erosionRate } : {}), cv: med.cv },
      note: `${ens.members.length} members (${ens.ms.toFixed(0)} ms), median member re-run to the end of its recession; ${run.sourceInfo.notes.join('; ')}`,
    },
    source: {
      trigger: spec.trigger.kind,
      volume: Math.round(run.source.volume),
      peak: Math.round(run.source.peak),
      tPeak: Math.round(run.source.tPeak),
      cv: run.sourceInfo.cv,
      notes: run.sourceInfo.notes,
    },
    stations: run.stations.map((st) => {
      const o = obs.filter((x) => x.station === st.name);
      const b = ens.stationBands[st.name];
      const kind = st.kind === 'entry' ? 'domainEdge' : st.kind;
      return {
        name: st.name,
        s: st.s,
        kind,
        tFront: fin(st.tFront),
        tPeak: Math.round(st.tPeak),
        qPeak: Math.round(st.qPeak),
        stageMax: Math.round(st.stageMax * 100) / 100,
        rise: Math.round(st.rise * 100) / 100,
        ...(run.leadTime ? { leadTime: fin(run.leadTime[st.name]) } : {}),
        ...(b ? { band: band(b) } : {}),
        ...(o.length ? { observed: o.map((x) => ({ ...(x.tFront !== undefined ? { tFront: x.tFront } : {}), ...(x.qPeak !== undefined ? { qPeak: x.qPeak } : {}), ...(x.tPeak !== undefined ? { tPeak: x.tPeak } : {}), note: x.note, source: x.source })) } : {}),
      };
    }),
    entry: {
      s: file.domainEntry.s,
      tFront: fin(run.entryFront),
      qPeak: Math.round(run.entryPeak),
      volume: Math.round(run.entry.reduce((a, p) => a + p.q, 0) * (run.entry.length > 1 ? run.entry[1].t - run.entry[0].t : 0)),
      baseflow: r1(run.entryBase),
      ...(ens.result.ensemble ? { band: band(ens.result.ensemble) } : {}),
    },
    ...(spec.alertTime !== undefined ? { alertTime: spec.alertTime } : {}),
    domain: { offset: Math.round(offset), sourceId, inflowVolume: Math.round(inflowVolume), inflowPeak: inflow.discharge },
  };
  return { result, inflow, run };
}

/** Area under a piecewise-linear hydrograph plus `hold` seconds of its last value, m³. */
export function hydrographArea(h: ReadonlyArray<{ t: number; q: number }>, hold = 0): number {
  let a = 0;
  for (let i = 1; i < h.length; i++) a += 0.5 * (h[i].q + h[i - 1].q) * (h[i].t - h[i - 1].t);
  return a + (h.length ? h[h.length - 1].q * hold : 0);
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Scenario text — from the baked numbers, so it cannot drift from them
// ────────────────────────────────────────────────────────────────────────────────────────────

const fmt = (x: number) => Math.round(x).toLocaleString('en-US');
const mins = (t: number | null) => (t === null ? 'never' : `${Math.round(t / 60)} min`);

function station(r: BakedChainResult, name: string) {
  const s = r.stations.find((x) => x.name === name);
  if (!s) throw new Error(`${r.preset}: no station "${name}" in the chain result`);
  return s;
}

const DESCRIPTIONS: Record<string, (r: BakedChainResult) => string> = {
  nepal: (r) => {
    const cz = r.clockZero!;
    const bet = station(r, 'Betrawati');
    const b = bet.band!;
    const start = clockAt(cz, r.domain.offset);
    return (
      'Betrawati stands where the Phalakhu Khola meets the Trishuli on the Nuwakot–Rasuwa district line, and its ' +
      'bridge carried the Pasang Lhamu Highway — the only road into Rasuwa district. At 8:37 am on 26 August 2026 rock ' +
      'and glacier ice broke from the north face of Langtang Lirung and fell about 1,200 m into the Lhende Khola, ' +
      'sending a debris flood down the Bhote Koshi and the Trishuli; it reached Betrawati around 9:20 am by the ' +
      'official account (about 9:00 in another reconstruction), minutes after the first SMS alerts went out, and took ' +
      'the bridge with it. The flood entering this map is modelled, not measured: a 1-D hazard-chain model turns the ' +
      `avalanche's melted ice into a debris flood — about ${fmt(r.source.volume / 1e6)} million m³ of debris-laden flow ` +
      `leaving the Lhende, ${fmt((r.source.volume * (1 - r.source.cv)) / 1e6)} million m³ of it water ` +
      '(Nepal’s Flood Forecasting Division measured about 20 million m³ of excess water far downstream) — and routes ' +
      `it ${Math.round(r.entry.s / 1000)} km down the valley on top of the river’s mean August flow (about ` +
      `${fmt(r.entry.baseflow)} m³/s here, from 44 years of the Betrawati gauge); this is the median of its ${r.run.members} runs, peaking at ` +
      `about ${fmt(r.domain.inflowPeak)} m³/s at the north edge. No gauge measured the peak: the one here ` +
      '(warning level 4.1 m, danger level 5 m) last read 3.55 m and was swept away before the crest arrived. ' +
      `The clock is the event's: the run starts at ${start}, five minutes before the modelled front reaches the north ` +
      `edge. The model puts the front at Betrawati at ${clockAt(cz, bet.tFront ?? 0)} (its runs span ` +
      `${clockAt(cz, b.tFront[0] ?? 0)}–${b.tFront[2] === null ? 'later' : clockAt(cz, b.tFront[2])}) — later than ` +
      'reported, and that gap is the model’s error, not the river’s: its valley comes from a 30 m elevation model ' +
      'and its channel roughness is a published boulder-bed law (Ferguson 2007) on an assumed, not surveyed, boulder size. Inside the map the run carries no sediment: it moves the water ' +
      'under one uniform debris-flood friction law with a 25 m/s speed cap. ' +
      'The terrain is Copernicus 30 m radar data, a surface model with canopy and buildings in it. The bare-earth ' +
      'filter only runs on ground flatter than 20°, and 77 % of this domain is steeper: the valley floor is filtered ' +
      'and still a metre or two high, the walls above it are the raw surface model. No photograph is baked in — open ' +
      'satellite imagery of this valley could be redistributed, but composing a cloud-free monsoon mosaic of it was ' +
      'beyond this bake and the ready-made cloud-free mosaics are licensed against redistribution — so the ground is ' +
      'shaded by height instead. The rivers start dry and get five minutes of the modelled baseflow before the front, ' +
      'so almost every drop you see is the modelled flood. Watch which roads go under and in what order, and where the ' +
      'routes turn uphill, and do not read street-level depths.'
    );
  },
  chungthang: (r) => {
    const cz = r.clockZero!;
    const ch = station(r, 'Chungthang');
    const b = ch.band!;
    const start = clockAt(cz, r.domain.offset);
    return (
      'Chungthang stands where the Lachen Chu and the Lachung Chu meet to form the Teesta, and the 60 m dam of the ' +
      '1,200 MW Teesta-III hydropower project stood just below it. At 10:13 pm on 3 October 2023 about 14.7 million m³ ' +
      'of frozen moraine collapsed into South Lhonak Lake, 5,200 m up and some 68 km upstream; the wave it raised, ' +
      'about 20 m high, breached the moraine dam, and about 50 million m³ of water — half the lake — came down the ' +
      'valley. It reached Chungthang around 00:35, about two hours and twenty minutes later, and destroyed the dam ' +
      '(Sattar et al., Science, 2025). The flood entering this map is modelled, not measured: a 1-D hazard-chain model ' +
      `raises the wave, breaches the dam (${fmt(r.source.volume / 1e6)} million m³ released, against about 50 reported) ` +
      'and routes the outburst ' +
      `${Math.round(r.entry.s / 1000)} km down the valley; this is the median of its ${r.run.members} runs, peaking at ` +
      `about ${fmt(r.domain.inflowPeak)} m³/s at the north edge. No gauge survived here, and the published peaks at ` +
      'Chungthang are reconstructions that disagree by almost a factor of three (5,340 to 14,673 m³/s); the model’s runs span ' +
      `${fmt(b.qPeak[0])}–${fmt(b.qPeak[2])} m³/s at Chungthang. The clock is the event's: the run starts at ${start}, ` +
      `five minutes before the modelled front reaches the north edge, and the model has the front at Chungthang at ` +
      `${clockAt(cz, ch.tFront ?? 0)} (its runs span ${clockAt(cz, b.tFront[0] ?? 0)}–` +
      `${b.tFront[2] === null ? 'later' : clockAt(cz, b.tFront[2])}) against about 00:35 reported — earlier than the ` +
      'real flood, and that gap is the model’s error. The real flood was a debris flood that moved hundreds of ' +
      'millions of cubic metres of sediment; inside the map this run carries no sediment — it moves the water under ' +
      'one uniform debris-flood friction law with a 25 m/s speed cap. The terrain is Copernicus 30 m radar data, a surface model with ' +
      'canopy and buildings in it, acquired in 2011–2015 while the dam was being built, so neither the dam nor its ' +
      'reservoir is in it. The bare-earth filter only runs on ground flatter than 20°, and 94 % of this domain is ' +
      'steeper: the valley floor is filtered and still a metre or two high, the walls above it are the raw surface ' +
      'model. No photograph is baked in — open satellite imagery of this valley could be redistributed, but composing ' +
      'a cloud-free mosaic of it was beyond this bake — so the ground is shaded by height instead. OpenStreetMap maps ' +
      'only the highway and a few lanes here, and one named place on the road network stands clear of the river. The ' +
      'rivers start dry and get five minutes of the modelled baseflow before the front, so almost every drop you see ' +
      'is the modelled flood. Watch which ground goes under and in what order, and do not read street-level depths.'
    );
  },
  chamoli: (r) => {
    const cz = r.clockZero!;
    const raini = station(r, 'Rishiganga HEP, Raini (position approximate)');
    const tap = station(r, 'Tapovan-Vishnugad HEP barrage (under construction)');
    const below = station(r, 'Tapovan');
    const b = tap.band!;
    const start = clockAt(cz, r.domain.offset);
    return (
      'Raini stands where the Rishiganga meets the Dhauliganga, and the 13.2 MW Rishiganga hydropower plant stood ' +
      'beside it; 6 km downstream, at Tapovan, the barrage of the 520 MW Tapovan-Vishnugad project was being built. ' +
      'At 10:21 on the morning of 7 February 2021 about 27 million m³ of rock and glacier ice broke from the north ' +
      'face of Ronti Peak, 5,500 m up and some 15 km away. Its ice melted on the way down, and the avalanche became a ' +
      'debris flow that ran down the Ronti Gad and the Rishiganga at about 25 m/s, destroyed the Rishiganga plant, ' +
      'reached the Tapovan barrage about a quarter of an hour after the collapse and destroyed it too. Most of the ' +
      'people it took were workers at the two projects (Shugar et al., Science, 2021). Nothing gauged the flow; the ' +
      'published reconstruction gives a mean discharge of 8,200 to 14,200 m³/s at the Rishiganga plant over 10–20 ' +
      'minutes, and 2,900 to 4,900 m³/s below Tapovan. The flood entering this map is modelled, not measured: a 1-D ' +
      'hazard-chain model runs the avalanche down its path and the upper Ronti Gad as a sliding mass, then turns its ' +
      `melted ice into a debris flow — about ${fmt(r.source.volume / 1e6)} ` +
      `million m³ of it, ${fmt((r.source.volume * (1 - r.source.cv)) / 1e6)} million m³ of that water — and routes it ` +
      `${Math.round(r.entry.s / 1000)} km down the Ronti Gad and the Rishiganga; this is the median of its ` +
      `${r.run.members} runs, peaking at about ${fmt(r.domain.inflowPeak)} m³/s at the east edge, ` +
      `${fmt(raini.qPeak)} m³/s at Raini and ${fmt(below.qPeak)} m³/s below Tapovan. The clock is the event's: the run ` +
      `starts at ${start}, five minutes before the modelled front reaches the east edge. The model puts the front at ` +
      `the Tapovan barrage at ${clockAt(cz, tap.tFront ?? 0)} (its runs span ${clockAt(cz, b.tFront[0] ?? 0)}–` +
      `${b.tFront[2] === null ? 'later' : clockAt(cz, b.tFront[2])}) against about 10:36–10:37 in the seismic records — later than the ` +
      'real flow, and that gap is the model’s error: its valley comes from a 30 m elevation model and its channel ' +
      'roughness is a published boulder-bed law (Ferguson 2007) on an assumed, not surveyed, boulder size. Inside the map the flow moves as one fluid under a uniform debris-flow friction ' +
      'law (O’Brien–Julien, 45 % solids by volume) with a 25 m/s speed cap; it neither picks up nor drops sediment, so ' +
      'the 8 million m³ the real flow left near the Ronti Gad and the mud it laid down at Tapovan are not here. The ' +
      'terrain is Copernicus 30 m radar data, a surface model with canopy and buildings in it, acquired in 2011–2015, ' +
      'before the Tapovan barrage was finished. The radar cannot see the floor of the Rishiganga gorge and puts false ' +
      'dams across it, so a 60 m wide floor has been cut along the river for the flow to run on. The bare-earth filter ' +
      'only runs on ground flatter than 20°, and 90 % of this domain is steeper: the valley floor is filtered and still ' +
      'a metre or two high, the walls above it are the raw surface model. No photograph is baked in, so the ground is ' +
      'shaded by height instead. OpenStreetMap maps the Joshimath–Malari road and a few village lanes here. The rivers ' +
      'start dry and get five minutes of the modelled baseflow before the front, so almost every drop you see is the ' +
      'modelled flow. Watch where it goes and in what order, and do not read street-level depths.'
    );
  },
};

const LABELS: Record<string, string> = {
  chamoli: 'Rishiganga — routed debris flow from the Ronti Peak avalanche (modelled: hazard-chain median member, not a measured hydrograph)',
  nepal: 'Trishuli — routed debris flood from the Lhende avalanche (modelled: hazard-chain median member, not a measured hydrograph)',
  chungthang: 'Lachen Chu — routed South Lhonak outburst (modelled: hazard-chain median member, not a measured hydrograph)',
};

/**
 * Bake the chain result for one preset and fold it into its scenario: the inflow source becomes the routed
 * hydrograph, hazardChain.result names the file, and the description is rewritten. Writes chain-result.json.
 */
export function applyChainResult(id: string, scenario: ScenarioPreset, log: (m: string) => void = (m) => console.log(`[${id}] ${m}`), dir = PRESETS_DIR): BakedChainResult {
  const spec = scenario.hazardChain;
  if (!spec) throw new Error(`${id}: no scenario.hazardChain`);
  const def = CHAIN_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(`${id}: no chain definition`);
  const file = JSON.parse(fs.readFileSync(path.join(dir, id, spec.profile), 'utf8')) as ChainFile;
  const sourceId = def.domainEntry.sourceId;
  const k = scenario.sources.findIndex((s) => s.id === sourceId);
  if (k < 0) throw new Error(`${id}: no source "${sourceId}" to replace`);
  const { result, inflow } = bakeChainResult(id, spec, file, sourceId, LABELS[id] ?? `${file.name} — routed flood (modelled)`);
  scenario.sources[k] = inflow;
  scenario.hazardChain = { ...spec, result: CHAIN_RESULT_FILE };
  const describe = DESCRIPTIONS[id];
  if (describe) scenario.description = describe(result);
  fs.writeFileSync(path.join(dir, id, CHAIN_RESULT_FILE), `${JSON.stringify(result, null, 1)}\n`);
  for (const st of result.stations) {
    const o = st.observed?.find((x) => x.tFront !== undefined);
    log(`  ${st.name.padEnd(44)} front ${mins(st.tFront).padStart(8)} [${st.band ? st.band.tFront.map(mins).join(' / ') : '—'}]${o ? ` obs ${mins(o.tFront!)}` : ''}  peak ${fmt(st.qPeak)} m³/s`);
  }
  log(`inflow: ${inflow.hydrograph!.length} points from chain time ${result.domain.offset} s, peak ${fmt(inflow.discharge)} m³/s, ${(result.domain.inflowVolume / 1e6).toFixed(2)} Mm³; ${result.run.note}`);
  return result;
}

function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  for (const def of CHAIN_DEFS) {
    if (only.length && !only.includes(def.id)) continue;
    const metaFile = path.join(PRESETS_DIR, def.id, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as PresetMeta;
    meta.scenario.hazardChain = { ...def.hazardChain };
    applyChainResult(def.id, meta.scenario);
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
    console.log(`[${def.id}] wrote meta.json and ${CHAIN_RESULT_FILE}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('bake-chain-result.ts')) main();
