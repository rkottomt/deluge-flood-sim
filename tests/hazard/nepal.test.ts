/**
 * Calibration SANITY run against the 26 August 2026 Lhende → Bhote Koshi → Trishuli event (spec §G.1), on a SYNTHETIC
 * valley built from the spec's distances and elevations (tests/helpers/nepalValley.ts) — the baked chain.json is not
 * in this tree yet. Nothing here is tuned to the observations except the ice fraction (0.2 makes the melt water equal
 * DHM's 19.96 Mm³ excess at Devghat); the bounds are deliberately loose (factor 2 on front times) because the geometry
 * is guessed. The diagnostic prints model vs observed for every station: that table, not the pass, is the result.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runChain } from '../../src/hazard/chain';
import { NEPAL_OBSERVED, NEPAL_TRIBUTARIES, nepalSpec, nepalValley } from '../helpers/nepalValley';

test('Nepal 2026 (synthetic valley): fronts within ×2 of the NDRRMA timeline, Devghat peak within ±50 % of 5,850 m³/s', (t) => {
  const file = nepalValley();
  const r = runChain(nepalSpec(), file, { tributaries: NEPAL_TRIBUTARIES, routeDx: 250 });
  const rows: string[] = [];
  for (const st of r.stations) {
    const o = NEPAL_OBSERVED.find((x) => x.station === st.name);
    const obs = o?.tFront !== undefined ? `${(o.tFront / 60).toFixed(0)} min` : '—';
    rows.push(
      `${st.name.padEnd(15)} front ${(st.tFront / 60).toFixed(0).padStart(4)} min (obs ${obs.padStart(7)})  peak ${st.qPeak.toFixed(0).padStart(6)} m³/s at ${(st.tPeak / 60).toFixed(0).padStart(4)} min  lead ${(r.leadTime![st.name] / 60).toFixed(0).padStart(4)} min`,
    );
  }
  t.diagnostic(`source: ${r.sourceInfo.notes.join('; ')}\n${rows.join('\n')}`);

  const fronts = r.stations.filter((s) => s.kind !== 'source').map((s) => s.tFront);
  for (let i = 1; i < fronts.length; i++) assert.ok(fronts[i] > fronts[i - 1], 'fronts in downstream order');
  for (const o of NEPAL_OBSERVED) {
    if (o.station === 'Rasuwagadhi') continue; // "~3 min" for 20 km is 110 m/s — the spec flags it as implausible
    const st = r.stations.find((s) => s.name === o.station)!;
    const ratio = st.tFront / o.tFront!;
    assert.ok(ratio > 0.5 && ratio < 2, `${o.station}: model ${st.tFront} s vs observed ${o.tFront} s`);
  }
  const dev = r.stations.find((s) => s.name === 'Devghat')!;
  assert.ok(dev.qPeak > 0.5 * 5850 && dev.qPeak < 1.5 * 5850, `Devghat peak ${dev.qPeak}`);
  // Water is conserved: the melt water put in at the source left through the outlet or is still in the valley.
  assert.ok(Math.abs(r.routing.massBalance.waterResidual) < 1e-6 * r.routing.massBalance.waterIn);
});
