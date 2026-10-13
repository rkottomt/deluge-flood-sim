/**
 * CALIBRATION REGRESSION against the three real events the presets carry, on the BAKED valleys (public/presets/<id>/
 * chain.json) and the baked chain runs (chain-result.json, which tests/data/presets.test.ts re-derives from the engine).
 *
 * The bounds below are where the model honestly stands after the October 2026 calibration — not the observations'
 * own tolerance. They exist to catch a regression (a re-bake or an engine change that moves the answers), and the
 * diagnostics print model against observation for every station. Residuals after the THIRD pass, Oct 2026 (research
 * spec §G.9: debris-flow surge source, the Trishuli's mean August flow, a sliding-block runout for Chamoli, Sattar et
 * al.'s 28 m drawdown and 00:35 arrival for South Lhonak); second-pass values in brackets:
 *   Nepal 2026       Betrawati front 65 min (ensemble 55–76) [70] vs 43 min (NDRRMA, the time its gauge was lost) /
 *                    23 min (OPRI): LATE, +51 % [+62 %]. Rasuwagadhi 14 [17] vs 3 (probably the last normal gauge
 *                    timestamp) – 7 (CCTV); Syafrubesi 29 [32] vs ≤ 13 (gauge lost) / 23 (OPRI). Before the first
 *                    calibration: 884 min (transient dam), 104 min (direct flow on the staircase profile).
 *   South Lhonak     Chungthang front 121 min (ensemble 110–156) [109] vs ~142 min reported (00:35; the 00:30 used before
 *                    was Sattar et al.'s own model result): −14 % [−23 % against 00:35]. Peak 5,700 m³/s against
 *                    the published reconstructions 5,340 (Sattar et al. 2025) – 14,673. Manning n 0.05.
 *   Chamoli 2021     Tapovan barrage front 19 min (ensemble 16–23) [21] vs ~15 (Cook) / 16 min (first wave, Tiwari
 *                    et al. 2022): +25 % [+39 %] of 15. Raini 11 min [14] vs 6 (seismic); Joshimath 34 min [36] vs 37.5
 *                    (seismic, Cook via GFZ). Raini peak 9,400 inside 8,200–14,200; below Tapovan 5,600 [5,900] against
 *                    2,900–4,900.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runChain } from '../../src/hazard/chain';
import { debrisFlowVelocity } from '../../src/hazard/mass';
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
  // Betrawati: observed 43 min (NDRRMA). Model 65 min (×1.51). Bound ×1.55 (66.7 min): tightened from ×1.7 by the third
  // pass (surge source + the river's mean August flow) — the second pass (70 min, ×1.62) fails it — and from ×2.1
  // before that; and not suddenly early either.
  const ratio = bet / (43 * 60);
  t.diagnostic(`Betrawati: model ${min(bet)} vs observed 43 min (×${ratio.toFixed(2)}); ensemble ${at('Betrawati').band!.tFront.map(min).join(' / ')}`);
  assert.ok(ratio > 0.75 && ratio < 1.55, `Betrawati front ×${ratio.toFixed(2)} of the observed 43 min`);
  // The river the flood runs on: the Trishuli's mean August flow at Betrawati, 621.8 m³/s (DHM 447 via ESSA 2014).
  assert.ok(Math.abs(r.entry.baseflow - 622) < 1, `entry baseflow ${r.entry.baseflow} m³/s`);
  // The melt water the chain releases is DHM's measured excess at Devghat, to 10 %.
  assert.ok(Math.abs(r.source.volume * (1 - r.source.cv) - 19.96e6) / 19.96e6 < 0.1, `water ${(r.source.volume * (1 - r.source.cv) / 1e6).toFixed(1)} Mm³`);
});

test('South Lhonak 2023: Chungthang front within −18 % / +25 % of the reported 00:35 and inside the ensemble band; peak inside the published 5,340–14,673 m³/s', { skip: !have('chungthang') }, (t) => {
  const r = read<BakedChainResult>('chungthang', 'chain-result.json');
  t.diagnostic(table(r));
  const ch = r.stations.find((s) => s.name === 'Chungthang')!;
  // ~00:35 IST, the "reported arrival" Sattar et al. 2025 compare their HEC-RAS result (00:30) with.
  const obs = 8500;
  const ratio = ch.tFront! / obs;
  t.diagnostic(`Chungthang: model ${min(ch.tFront)} vs observed ${min(obs)} (×${ratio.toFixed(2)}), peak ${ch.qPeak} m³/s; band ${ch.band!.tFront.map(min).join(' / ')}`);
  // Model 121 min (×0.86). Bound ×0.82 (116 min): the second pass (109 min, ×0.77, the spec's assumed 40 m breach) fails.
  assert.ok(ratio > 0.82 && ratio < 1.25, `Chungthang front ×${ratio.toFixed(2)}`);
  const [lo, , hi] = ch.band!.tFront;
  assert.ok(lo !== null && lo <= obs && (hi === null || obs <= hi), 'the observed arrival lies inside the ensemble’s p10–p90');
  assert.ok(ch.qPeak >= 5340 && ch.qPeak <= 14673, `peak ${ch.qPeak} m³/s`);
  const [qlo, , qhi] = ch.band!.qPeak;
  assert.ok(qlo < 14673 && qhi > 5340, 'the ensemble’s peak band overlaps the published range');
  // The breach drains toward Sattar et al.'s measured 50 ± 1.8 Mm³ (a 28 m drawdown; the slide's displacement is not modelled).
  assert.ok(r.source.volume > 0.75 * 50e6 && r.source.volume < 1.25 * 50e6, `released ${(r.source.volume / 1e6).toFixed(1)} Mm³`);
});

test('Nepal: the trigger as baked (direct flow) — the engine reproduces the calibrated run, and a transient dam at s = 0 would not', { skip: !have('nepal') }, () => {
  const meta = read<{ scenario: { hazardChain: HazardChainSpec } }>('nepal', 'meta.json');
  const file = read<ChainFile>('nepal', 'chain.json');
  const spec = meta.scenario.hazardChain;
  const r = runChain(spec, file, { routing: { stopFraction: 0.5 } });
  const bet = r.stations.find((s) => s.name === 'Betrawati')!;
  // Default member (source Cv 0.4).
  assert.ok(bet.tFront < 1.65 * 43 * 60, `deterministic Betrawati ${(bet.tFront / 60).toFixed(1)} min`);
  // The old trigger on the same valley: no valley above s = 0 to pond, so the "dam" takes hours to fill.
  if (spec.trigger.kind !== 'massIntoRiver') return;
  const dam = runChain({ ...spec, trigger: { ...spec.trigger, mode: 'transientDam' } }, file, { routing: { stopFraction: 0.5 } });
  assert.ok(dam.sourceInfo.notes.some((n) => /no valley upstream of the impact/.test(n)), 'the engine says why a dam there is wrong');
  assert.ok(dam.stations.find((s) => s.name === 'Betrawati')!.tFront > 5 * 3600);
});

test('Chamoli 2021: Raini, Tapovan barrage and Joshimath fronts within the calibrated tolerance of the seismic times; Raini peak inside the reconstruction', { skip: !have('chamoli') }, (t) => {
  const r = read<BakedChainResult>('chamoli', 'chain-result.json');
  t.diagnostic(table(r));
  const at = (name: string) => r.stations.find((s) => s.name === name)!;
  const tap = at('Tapovan-Vishnugad HEP barrage (under construction)');
  const raini = at('Rishiganga HEP, Raini (position approximate)');
  const below = at('Tapovan');
  const ratio = tap.tFront! / (15 * 60);
  t.diagnostic(`Tapovan barrage: model ${min(tap.tFront)} vs ~15 min (×${ratio.toFixed(2)}); band ${tap.band!.tFront.map(min).join(' / ')}; Raini peak ${raini.qPeak}, below Tapovan ${below.qPeak} m³/s`);
  // Model 18.8 min (×1.25). Bound ×1.3 (19.5 min): the second pass (20.9 min, gamma source starting at the stream head)
  // fails it, and so does Manning n 0.05.
  assert.ok(ratio > 0.75 && ratio < 1.3, `Tapovan barrage front ×${ratio.toFixed(2)} of ~15 min`);
  assert.ok(raini.tFront! < tap.tFront! && tap.tFront! <= below.tFront!, 'fronts in downstream order');
  assert.ok(raini.qPeak >= 8200 && raini.qPeak <= 14200, `Raini peak ${raini.qPeak} m³/s inside 8,200–14,200`);
  // Raini: Rishiganga HEP damaged 04:57 UTC, 6 min (Tiwari et al. 2022). Model 11.4 min (×1.9) — still LATE; bound ×2.1
  // (12.6 min) catches a fall back to the second pass (13.8 min).
  const rr = raini.tFront! / (6 * 60);
  assert.ok(rr > 0.75 && rr < 2.1, `Raini front ×${rr.toFixed(2)} of 6 min`);
  // Joshimath: 10:58:33 IST, 37.5 min (Cook et al. 2021 via GFZ). Model 34 min (×0.91): EARLY below Tapovan.
  const jr = at('Joshimath (Vishnuprayag confluence)').tFront! / (37.5 * 60);
  assert.ok(jr > 0.8 && jr < 1.2, `Joshimath front ×${jr.toFixed(2)} of 37.5 min`);
  // Below Tapovan the model is HIGH (no barrage or deposition in the profile): bounded here, not hidden.
  // 5,570 m³/s (third pass); the second pass's 5,917 fails the 20 % bound.
  assert.ok(below.qPeak < 1.2 * 4900, `below-Tapovan peak ${below.qPeak} m³/s within 20 % of the reconstruction's top`);
});

test('source models as decided in research spec §G.9 (third pass): a debris-flow surge for both avalanches, a sliding block only for Chamoli, the river’s August flow for Nepal, Sattar’s 28 m drawdown for South Lhonak', () => {
  const hc = (id: string) => read<{ scenario: { hazardChain: HazardChainSpec } }>(id, 'meta.json').scenario.hazardChain;
  if (have('nepal')) {
    const t = hc('nepal').trigger;
    assert.ok(t.kind === 'massIntoRiver' && t.shape === 'surge' && t.slide === undefined, 'nepal: surge, no sliding block');
    assert.deepEqual(hc('nepal').routing?.tributaries?.map((x) => x.q), [458, 64]);
  }
  if (have('chamoli')) {
    const t = hc('chamoli').trigger;
    assert.ok(t.kind === 'massIntoRiver' && t.shape === 'surge' && t.slide?.mu === 0.12 && t.slide.xi === 2500, 'chamoli: surge and the RAMMS pair');
  }
  if (have('chungthang')) {
    const t = hc('chungthang').trigger;
    assert.ok(t.kind === 'massIntoLake' && t.breach.finalDepth === 28 && t.breach.erosionRate === 100);
  }
});

test('bed resistance as decided in research spec §G.9: Ferguson (2007) VPE on D84 0.5 m for Nepal and Chamoli, Manning for Chungthang', () => {
  const law = (id: string) => read<{ scenario: { hazardChain: HazardChainSpec } }>(id, 'meta.json').scenario.hazardChain.routing?.resistance;
  for (const id of ['nepal', 'chamoli']) if (have(id)) assert.deepEqual(law(id), { law: 'ferguson2007', d84: 0.5 }, id);
  if (have('chungthang')) assert.equal(law('chungthang'), undefined, 'chungthang routes with the profile’s Manning n');
});

/**
 * Fourth pass (research spec §G.9): is the remaining Nepal gap in the ROUTING? Rickenmann's (1999) empirical debris-flow
 * mean velocity V = 2.1·Q^0.33·S^0.33 (src/hazard/mass.ts debrisFlowVelocity) is independent of the router — no
 * section geometry, no resistance law, no momentum scheme. Below Rasuwagadhi the routed front already moves at it, to
 * within a few per cent, for the discharge the router carries; the observed Betrawati time would need a discharge
 * several times the routed peak, held for 45 km. So the gap is not a celerity or a width the router gets wrong.
 */
test('Nepal 2026: below Rasuwagadhi the routed front moves at Rickenmann’s debris-flow velocity for its own peak', { skip: !have('nepal') }, (t) => {
  const r = read<BakedChainResult>('nepal', 'chain-result.json');
  const c = read<ChainFile>('nepal', 'chain.json');
  const at = (name: string) => r.stations.find((s) => s.name === name)!;
  const zAt = (s: number) => {
    let k = 0;
    while (k < c.s.length - 2 && c.s[k + 1] < s) k++;
    return c.zBed[k] + ((s - c.s[k]) / (c.s[k + 1] - c.s[k])) * (c.zBed[k + 1] - c.zBed[k]);
  };
  const reach = (a: string, b: string) => {
    const A = at(a);
    const B = at(b);
    const slope = (zAt(A.s) - zAt(B.s)) / (B.s - A.s);
    const q = Math.sqrt(A.qPeak! * B.qPeak!);
    return { km: (B.s - A.s) / 1000, slope, q, model: (B.s - A.s) / (B.tFront! - A.tFront!), rickenmann: debrisFlowVelocity(q, slope) };
  };
  for (const [a, b] of [['Rasuwagadhi', 'Syafrubesi'], ['Syafrubesi', 'Upper Trishuli-1 HEP (under construction)'], ['Rasuwagadhi', 'Betrawati']]) {
    const x = reach(a, b);
    t.diagnostic(`${a} → ${b}: ${x.km.toFixed(1)} km at ${(x.slope * 100).toFixed(2)} %, front ${x.model.toFixed(1)} m/s, Rickenmann ${x.rickenmann.toFixed(1)} m/s at ${Math.round(x.q)} m³/s (×${(x.model / x.rickenmann).toFixed(2)})`);
    assert.ok(x.model / x.rickenmann > 0.85 && x.model / x.rickenmann < 1.15, `${a} → ${b}: ×${(x.model / x.rickenmann).toFixed(2)}`);
  }
  // What the observation would take: Betrawati at 43 min with the front at Rasuwagadhi at 7 min (CCTV, the earliest
  // credible) is 45 km in 36 min. Rickenmann's relation inverted for that speed on the same slope:
  const x = reach('Rasuwagadhi', 'Betrawati');
  const need = (x.km * 1000) / ((43 - 7) * 60);
  const qNeed = Math.pow(need / (2.1 * Math.pow(x.slope, 0.33)), 1 / 0.33);
  t.diagnostic(`observed 43 min needs ${need.toFixed(1)} m/s over the reach: Q ≈ ${Math.round(qNeed)} m³/s held for 45 km; routed peak ${Math.round(at('Rasuwagadhi').qPeak!)} → ${Math.round(at('Betrawati').qPeak!)}, ensemble p90 at Betrawati ${at('Betrawati').band!.qPeak[2]}`);
  assert.ok(qNeed > 1.4 * at('Betrawati').band!.qPeak[2], 'the observed time needs more than the ensemble’s p90 peak, by a margin');
});
