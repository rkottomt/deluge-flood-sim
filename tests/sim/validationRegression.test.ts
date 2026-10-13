/**
 * Validation regression: every preset's scenario re-run on the real GPU and re-scored against the observed flood, with
 * the result pinned to the numbers published in public/validation/summary.json (docs/VALIDATION.md).
 *
 * This is not a pass/fail on accuracy — several published numbers are poor, and say so. It makes a physics change show
 * its effect on agreement with reality: change the friction law, the boundary handling or the forcing, and this test
 * says which preset moved, which metric, and by how much. If the change is intended, re-run
 * `npx tsx scripts/validate.ts` (it rewrites summary.json, the report tables and the maps) and update the prose in
 * docs/VALIDATION.md to match.
 *
 * Tolerances cover a different GPU (Float32 rounding and CFL readback timing change the substep sequence): ±0.10 m on
 * water levels, ±3 points on shares and skill scores, ±0.05 on frequency bias, ±1 on counts of dry points.
 *
 * Runtime is a few minutes (ten scenario runs of 30–180 simulated minutes at 1024²). DELUGE_VALIDATION=pittsburgh,ftmyers
 * limits it to some presets; DELUGE_VALIDATION=0 skips it.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishGpuTests, getDevice, gpuErrors } from '../helpers/gpu';
import { PLANS, scorePreset, summarise } from '../../scripts/validate';
import { loadPresetData, runScenario, type RunOutput } from '../../scripts/validation/run';
import type { ObservedFile, ValidationSummary } from '../../src/validation/types';

after(finishGpuTests);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const summary = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/validation/summary.json'), 'utf8')) as ValidationSummary;
const env = process.env.DELUGE_VALIDATION;
const selected = env && env !== '1' ? new Set(env.split(',').map((s) => s.trim())) : null;

export function tolerance(key: string): number {
  if (/\.(n|dry)$/.test(key)) return 1;
  if (/frequencyBias$/.test(key)) return 0.05;
  if (/(bias|rmse|residual|median)$/.test(key)) return 0.1;
  return 0.03;
}

for (const [id, plan] of Object.entries(PLANS)) {
  const pinned = summary.presets[id];
  const skip = env === '0' ? 'DELUGE_VALIDATION=0' : selected && !selected.has(id) ? `not in DELUGE_VALIDATION` : false;
  test(`validation against the real flood: ${id}`, { skip, timeout: 20 * 60_000 }, async () => {
    assert.ok(pinned, `${id} has no entry in public/validation/summary.json — run npx tsx scripts/validate.ts`);
    const obs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/validation', id, 'observed.json'), 'utf8')) as ObservedFile;
    const runs = plan.runs(obs);
    if (runs.length === 0) {
      // Nothing observed to run against (chamoli, chungthang): the summary must say so rather than show a number.
      assert.equal(pinned.headline, null);
      assert.ok(obs.none && obs.none.length > 20, 'a preset without observations must explain why');
      return;
    }
    const device = await getDevice();
    const p = loadPresetData(id);
    const outputs = new Map<string, RunOutput>();
    for (const run of runs) {
      const o = await runScenario(device, p, run);
      assert.equal(o.nonFinite, 0, `${id}/${run.id}: non-finite max depth`);
      assert.ok(o.stats.massError < 1e-5, `${id}/${run.id}: mass error ${o.stats.massError}`);
      outputs.set(run.id, o);
    }
    const now = summarise(scorePreset(p, obs, plan, outputs).result);
    const drift: string[] = [];
    for (const [key, want] of Object.entries(pinned.metrics)) {
      const got = now.metrics[key];
      if (want === null || got === null || got === undefined) {
        if ((want === null) !== (got === null || got === undefined)) drift.push(`${key}: pinned ${want}, now ${got}`);
        continue;
      }
      if (Math.abs(got - want) > tolerance(key)) drift.push(`${key}: pinned ${want}, now ${got.toFixed(4)} (±${tolerance(key)})`);
    }
    assert.deepEqual(drift, [], `${id}: agreement with the observed flood moved:\n  ${drift.join('\n  ')}`);
    assert.deepEqual(gpuErrors(), []);
  });
}
