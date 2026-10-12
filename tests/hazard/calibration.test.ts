/**
 * CALIBRATION REGRESSION against the two real events the presets carry, on the BAKED valleys (public/presets/<id>/
 * chain.json) and the baked chain runs (chain-result.json, which tests/data/presets.test.ts re-derives from the engine).
 *
 * The bounds below are where the model honestly stands after the October 2026 calibration — not the observations'
 * own tolerance. They exist to catch a regression (a re-bake or an engine change that moves the answers), and the
 * diagnostics print model against observation for every station. Residuals, Oct 2026:
 *   Nepal 2026       Betrawati front 75 min (ensemble 63–90) vs 43 min (NDRRMA) / 23 min (OPRI): the model is LATE,
 *                    +75 %. Rasuwagadhi 18 vs 3–7, Syafrubesi 34 vs ≤ 13. Before the calibration: 884 min (transient
 *                    dam on a profile with no valley to pond), 104 min (direct flow on the staircase profile).
 *   South Lhonak     Chungthang front 109 min (ensemble 99–156) vs ~137 min observed: −20 %, and the observation is
 *                    inside the ensemble band. Peak 9,800 m³/s, inside the published 7,355–14,673.
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
  // Betrawati: observed 43 min (NDRRMA). Model 75 min. Bound: never worse than ×2.1 (the pre-calibration answer was
  // 104 min on this trigger, 884 min on the old one), and not suddenly early either.
  const ratio = bet / (43 * 60);
  t.diagnostic(`Betrawati: model ${min(bet)} vs observed 43 min (×${ratio.toFixed(2)}); ensemble ${at('Betrawati').band!.tFront.map(min).join(' / ')}`);
  assert.ok(ratio > 0.75 && ratio < 2.1, `Betrawati front ×${ratio.toFixed(2)} of the observed 43 min`);
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
  assert.ok(bet.tFront < 2.1 * 43 * 60, `deterministic Betrawati ${(bet.tFront / 60).toFixed(0)} min`);
  // The old trigger on the same valley: no valley above s = 0 to pond, so the "dam" takes hours to fill.
  if (spec.trigger.kind !== 'massIntoRiver') return;
  const dam = runChain({ ...spec, trigger: { ...spec.trigger, mode: 'transientDam' } }, file, { routing: { stopFraction: 0.5 } });
  assert.ok(dam.sourceInfo.notes.some((n) => /no valley upstream of the impact/.test(n)), 'the engine says why a dam there is wrong');
  assert.ok(dam.stations.find((s) => s.name === 'Betrawati')!.tFront > 5 * 3600);
});
