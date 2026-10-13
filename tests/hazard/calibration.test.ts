/**
 * CALIBRATION REGRESSION against the three real events the presets carry, on the BAKED valleys (public/presets/<id>/
 * chain.json) and the baked chain runs (chain-result.json, which tests/data/presets.test.ts re-derives from the engine).
 *
 * The bounds below are where the model honestly stands after the October 2026 calibration — not the observations'
 * own tolerance. They exist to catch a regression (a re-bake or an engine change that moves the answers), and the
 * diagnostics print model against observation for every station. Residuals, Oct 2026 (research spec §G.9):
 *   Nepal 2026       Betrawati front 70 min (ensemble 58–83) vs 43 min (NDRRMA) / 23 min (OPRI): the model is LATE,
 *                    +62 %. Rasuwagadhi 17 vs 3–7, Syafrubesi 32 vs ≤ 13. With Manning n 0.05 instead of Ferguson's
 *                    variable-power law (D84 0.5 m): 75 min (+76 %). Before the first calibration: 884 min (transient
 *                    dam on a profile with no valley to pond), 104 min (direct flow on the staircase profile).
 *   South Lhonak     Chungthang front 109 min (ensemble 99–156) vs ~137 min observed: −21 %, and the observation is
 *                    inside the ensemble band. Peak 9,800 m³/s, inside the published 7,355–14,673. Manning n 0.05:
 *                    the variable-power law would make it earlier (103 min), so it is not used here.
 *   Chamoli 2021     Tapovan barrage front 21 min (ensemble 18–25) vs ~15 min (seismic): +39 % (Manning: 22 min,
 *                    +49 %). Raini peak 10,900 m³/s inside the reconstructed 8,200–14,200; below Tapovan 5,900 against
 *                    2,900–4,900 (21 % above the band; Manning 5,400).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runChain } from '../../src/hazard/chain';
import type { BakedChainResult, ChainFile, HazardChainSpec } from '../../src/hazard/types';

const ROOT = path.resolve(import.meta.dirname, '../../public/presets');
const read = <T,>(id: string, f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, id, f), 'utf8')) as T;
const have = (id: string) => fs.existsSync(path.join(ROOT, id, 'chain-result.json'));
const min = (t: number | null) => (t === null ? 'never' : `${(t / 60).toFixed(0)} min`);

function table(r: BakedChainResult): string {
  return r.stations
    .map((st) => {
      const o = (st.observed ?? []).filter((x) => x.tFront !== undefined).map((x) => min(x.tFront!)).join(' / ');
      const b = st.band ? `[${st.band.tFront.map(min).join(', ')}]` : '';
      return `${st.name.padEnd(44)} front ${min(st.tFront).padStart(7)} ${b.padEnd(26)} obs ${o || '—'}  peak ${st.qPeak} m³/s`;
    })
    .join('\n');
}

test('Nepal 2026: Betrawati front within the calibrated tolerance; Rasuwagadhi → Syafrubesi → Betrawati in order', { skip: !have('nepal') }, (t) => {
  const r = read<BakedChainResult>('nepal', 'chain-result.json');
  t.diagnostic(table(r));
  const at = (name: string) => r.stations.find((s) => s.name === name)!;
  const ras = at('Rasuwagadhi').tFront!;
  const sya = at('Syafrubesi gauge (DHM, position approximate)').tFront!;
  const bet = at('Betrawati').tFront!;
  assert.ok(ras < sya && sya < bet, 'fronts in downstream order');
  // The avalanche's own travel is in the clock: nothing arrives before the mass reaches the river (4.3 min).
  assert.ok(at('Lhende Khola at 2,900 m (avalanche runout)').tFront! >= 13000 / 50 - 1);
  // Betrawati: observed 43 min (NDRRMA). Model 70 min (×1.62). Bound ×1.7 (73 min): tightened from ×2.1 when the
  // variable-power resistance law came in — a fall back to Manning n 0.05 (75 min, ×1.76) fails it — and not
  // suddenly early either.
  const ratio = bet / (43 * 60);
  t.diagnostic(`Betrawati: model ${min(bet)} vs observed 43 min (×${ratio.toFixed(2)}); ensemble ${at('Betrawati').band!.tFront.map(min).join(' / ')}`);
  assert.ok(ratio > 0.75 && ratio < 1.7, `Betrawati front ×${ratio.toFixed(2)} of the observed 43 min`);
  // The melt water the chain releases is DHM's measured excess at Devghat, to 10 %.
  assert.ok(Math.abs(r.source.volume * (1 - r.source.cv) - 19.96e6) / 19.96e6 < 0.1, `water ${(r.source.volume * (1 - r.source.cv) / 1e6).toFixed(1)} Mm³`);
});

test('South Lhonak 2023: Chungthang front within ±25 % of 2 h 15 min and inside the ensemble band; peak inside the published 7,355–14,673 m³/s', { skip: !have('chungthang') }, (t) => {
  const r = read<BakedChainResult>('chungthang', 'chain-result.json');
  t.diagnostic(table(r));
  const ch = r.stations.find((s) => s.name === 'Chungthang')!;
  const obs = 8200;
  const ratio = ch.tFront! / obs;
  t.diagnostic(`Chungthang: model ${min(ch.tFront)} vs observed ${min(obs)} (×${ratio.toFixed(2)}), peak ${ch.qPeak} m³/s; band ${ch.band!.tFront.map(min).join(' / ')}`);
  assert.ok(ratio > 0.75 && ratio < 1.25, `Chungthang front ×${ratio.toFixed(2)}`);
  const [lo, , hi] = ch.band!.tFront;
  assert.ok(lo !== null && lo <= obs && (hi === null || obs <= hi), 'the observed arrival lies inside the ensemble’s p10–p90');
  assert.ok(ch.qPeak >= 7355 && ch.qPeak <= 14673, `peak ${ch.qPeak} m³/s`);
  const [qlo, , qhi] = ch.band!.qPeak;
  assert.ok(qlo < 14673 && qhi > 7355, 'the ensemble’s peak band overlaps the published range');
});

test('Nepal: the trigger as baked (direct flow) — the engine reproduces the calibrated run, and a transient dam at s = 0 would not', { skip: !have('nepal') }, () => {
  const meta = read<{ scenario: { hazardChain: HazardChainSpec } }>('nepal', 'meta.json');
  const file = read<ChainFile>('nepal', 'chain.json');
  const spec = meta.scenario.hazardChain;
  const r = runChain(spec, file, { routing: { stopFraction: 0.5 } });
  const bet = r.stations.find((s) => s.name === 'Betrawati')!;
  // Default member (source Cv 0.4): 73.5 min with the variable-power law.
  assert.ok(bet.tFront < 1.8 * 43 * 60, `deterministic Betrawati ${(bet.tFront / 60).toFixed(1)} min`);
  // The old trigger on the same valley: no valley above s = 0 to pond, so the "dam" takes hours to fill.
  if (spec.trigger.kind !== 'massIntoRiver') return;
  const dam = runChain({ ...spec, trigger: { ...spec.trigger, mode: 'transientDam' } }, file, { routing: { stopFraction: 0.5 } });
  assert.ok(dam.sourceInfo.notes.some((n) => /no valley upstream of the impact/.test(n)), 'the engine says why a dam there is wrong');
  assert.ok(dam.stations.find((s) => s.name === 'Betrawati')!.tFront > 5 * 3600);
});

test('Chamoli 2021: Tapovan barrage front within the calibrated tolerance of ~15 min; Raini peak inside the reconstruction', { skip: !have('chamoli') }, (t) => {
  const r = read<BakedChainResult>('chamoli', 'chain-result.json');
  t.diagnostic(table(r));
  const at = (name: string) => r.stations.find((s) => s.name === name)!;
  const tap = at('Tapovan-Vishnugad HEP barrage (under construction)');
  const raini = at('Rishiganga HEP, Raini (position approximate)');
  const below = at('Tapovan');
  const ratio = tap.tFront! / (15 * 60);
  t.diagnostic(`Tapovan barrage: model ${min(tap.tFront)} vs ~15 min (×${ratio.toFixed(2)}); band ${tap.band!.tFront.map(min).join(' / ')}; Raini peak ${raini.qPeak}, below Tapovan ${below.qPeak} m³/s`);
  // Model 21 min (×1.39). Bound ×1.45 (21.75 min): a fall back to Manning n 0.05 (22.3 min, ×1.49) fails it.
  assert.ok(ratio > 0.75 && ratio < 1.45, `Tapovan barrage front ×${ratio.toFixed(2)} of ~15 min`);
  assert.ok(raini.tFront! < tap.tFront! && tap.tFront! <= below.tFront!, 'fronts in downstream order');
  assert.ok(raini.qPeak >= 8200 && raini.qPeak <= 14200, `Raini peak ${raini.qPeak} m³/s inside 8,200–14,200`);
  // Below Tapovan the model is HIGH (no barrage or deposition in the profile): bounded here, not hidden.
  assert.ok(below.qPeak < 1.3 * 4900, `below-Tapovan peak ${below.qPeak} m³/s within 30 % of the reconstruction's top`);
});

test('bed resistance as decided in research spec §G.9: Ferguson (2007) VPE on D84 0.5 m for Nepal and Chamoli, Manning for Chungthang', () => {
  const law = (id: string) => read<{ scenario: { hazardChain: HazardChainSpec } }>(id, 'meta.json').scenario.hazardChain.routing?.resistance;
  for (const id of ['nepal', 'chamoli']) if (have(id)) assert.deepEqual(law(id), { law: 'ferguson2007', d84: 0.5 }, id);
  if (have('chungthang')) assert.equal(law('chungthang'), undefined, 'chungthang routes with the profile’s Manning n');
});
