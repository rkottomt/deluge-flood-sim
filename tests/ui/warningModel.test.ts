/**
 * The early-warning UI model (src/ui/warningModel.ts): sensor labels, the observed-arrivals check (Nepal 2026: a
 * 2-minute gauge at Rasuwagadhi would have given Betrawati 38 minutes on the OBSERVED times) and lead-time wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { ChainFile, HazardChainSpec } from '../../src/hazard/types';
import { clampSensorS, leadSev, leadText, newSensor, observedLead, whereLabel } from '../../src/ui/warningModel';

const W = new URL('../../public/presets/nepal/', import.meta.url);
const file = JSON.parse(readFileSync(new URL('chain.json', W), 'utf8')) as ChainFile;
const meta = JSON.parse(readFileSync(new URL('meta.json', W), 'utf8'));
const spec = (meta.scenario ?? meta).hazardChain as HazardChainSpec;

test('observed check: a 2-min gauge at Rasuwagadhi → Betrawati gets 40 − 2 = 38 min on the observed arrivals', () => {
  const rasu = file.stations.find((s) => s.name === 'Rasuwagadhi')!;
  const sn = newSensor(rasu.s + 100, 'auto');
  assert.equal(observedLead(spec.observations, file, sn, 'Betrawati', true), 2580 - 180 - 120);
  // The Syafrubesi gauge's 08:50 is an upper bound (it was washed away): not used.
  const syaf = file.stations.find((s) => s.name === 'Syafrubesi')!;
  assert.equal(observedLead(spec.observations, file, newSensor(syaf.s, 'auto'), 'Betrawati', true), null);
  // Seismic on a mass movement: the observed front minus the latencies.
  assert.equal(observedLead(spec.observations, file, newSensor(40000, 'seismic'), 'Betrawati', true), 2580 - 300);
});

test('labels and wording', () => {
  const rasu = file.stations.find((s) => s.name === 'Rasuwagadhi')!;
  assert.match(whereLabel(file, rasu.s), /^km 15\.0 · at Rasuwagadhi/);
  assert.match(whereLabel(file, 22000), /km 22\.0 · 3\.5 km below Timure/);
  assert.equal(clampSensorS({ sourceS: 0, sMax: 60000 }, -5), 0);
  assert.equal(clampSensorS({ sourceS: 0, sMax: 60000 }, 99999), 60000);
  assert.equal(leadText(Infinity), 'not reached');
  assert.equal(leadText(-Infinity), 'no warning');
  assert.match(leadText(-120), /^none — water 2/);
  assert.equal(leadSev(300), 'short');
  assert.equal(leadSev(1200), 'tight');
  assert.equal(leadSev(3600), 'ok');
});
