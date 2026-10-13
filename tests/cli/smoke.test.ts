/**
 * End-to-end smoke test of the `deluge` binary on the real GPU (like tests/sim: needs a WebGPU adapter through Dawn).
 * Short runs (2 simulated minutes) of real presets: the commands' outputs, exit codes, the GeoTIFF georeferencing, and
 * that the binary's numbers are the loss module's on the same GPU flood (the run is deterministic, so a scene run here
 * in-process reproduces the binary's hazard fields exactly).
 * Run: node --import tsx --test tests/cli/smoke.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import { finishGpuTests, getDevice, gpuErrors } from '../helpers/gpu';
import { boundsToMercator } from '../../src/data/geo';
import { analyze, parsePortfolio, resultsCsv, RESULT_COLUMNS, type ResultRowInput } from '../../src/loss';
import { HeadlessScene } from '../../src/cli/headless';
import { loadPresetFromDisk, readPresetJson, readPresetMeta } from '../../src/cli/presetFiles';
import { resolveForcing } from '../../src/cli/scenario';

after(finishGpuTests);

const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(ROOT, 'bin', 'deluge.mjs');
const DEMO_CSV = path.join(ROOT, 'public', 'demo', 'houston-portfolio.csv');
let tmp = '';

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deluge-cli-'));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deluge(...args: string[]): { code: number | null; stdout: string; stderr: string; seconds: number } {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, seconds: (performance.now() - t0) / 1000 };
}

test('help, presets and usage errors (exit codes 0 / 2)', () => {
  const help = deluge('--help');
  assert.equal(help.code, 0);
  assert.match(help.stdout, /deluge <command>/);
  const list = deluge('presets', '--json');
  assert.equal(list.code, 0, list.stderr);
  const ids = (JSON.parse(list.stdout) as { presets: Array<{ id: string }> }).presets.map((p) => p.id);
  for (const id of ['pittsburgh', 'houston', 'nepal']) assert.ok(ids.includes(id), id);
  for (const bad of [['nope'], ['run', '--preset', 'atlantis'], ['run', '--preset', 'houston', '--minuts', '5'], ['portfolio', '--preset', 'houston', '--out', 'x.csv'], ['run', '--preset', 'houston', '--stage-ft', '30']]) {
    const r = deluge(...bad);
    assert.equal(r.code, 2, `${bad.join(' ')} → ${r.code}: ${r.stderr}`);
    assert.ok(r.stderr.length > 0);
  }
});

test('run: GeoTIFF rasters in EPSG:3857 on the preset’s bounds, and a summary', async () => {
  const out = path.join(tmp, 'run');
  const r = deluge('run', '--preset', 'houston', '--minutes', '2', '--out', out);
  assert.equal(r.code, 0, r.stderr);
  console.log(`  run houston 2 min: ${r.seconds.toFixed(1)} s wall · ${r.stdout.trim().split('\n')[0]}`);
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.ok(Math.abs(summary.flood.simulatedSeconds - 120) < 1e-3, `ran ${summary.flood.simulatedSeconds} s`);
  assert.equal(summary.scenario.rainMmHr, 173);
  assert.ok(summary.flood.floodedAreaM2Over15cm >= 0);
  const meta = readPresetMeta('houston')!;
  const m = boundsToMercator(meta.bounds);
  for (const f of ['max_depth_m.tif', 'max_speed_ms.tif', 'arrival_min.tif', 'hazard_aidr.tif']) {
    const buf = fs.readFileSync(path.join(out, f));
    const img = await (await fromArrayBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))).getImage();
    assert.equal(img.getWidth(), meta.nx);
    assert.equal(img.getHeight(), meta.ny);
    assert.equal(img.getGeoKeys()?.ProjectedCSTypeGeoKey, 3857);
    const bb = img.getBoundingBox();
    assert.ok(Math.abs(bb[0] - m.xmin) < 1e-3 && Math.abs(bb[3] - m.ymax) < 1e-3, `${f} corner`);
  }
});

test('portfolio: the binary’s CSV is the loss module’s on the same GPU flood (in-process run, deterministic)', async () => {
  const out = path.join(tmp, 'portfolio.csv');
  const r = deluge('portfolio', '--preset', 'houston', '--csv', DEMO_CSV, '--minutes', '10', '--out', out, '--quiet');
  assert.equal(r.code, 0, r.stderr);
  console.log(`  portfolio houston 10 min, 19 assets: ${r.seconds.toFixed(1)} s wall · ${r.stdout.trim().split('\n')[0]}`);
  const csv = fs.readFileSync(out, 'utf8');
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], RESULT_COLUMNS.join(','));
  assert.equal(lines.length, 1 + 19);

  // The same scenario on this process's GPU, then the Impact panel's export by hand.
  const terrain = await loadPresetFromDisk('houston');
  const scene = await HeadlessScene.create(await getDevice(), terrain, { presetId: 'houston', readPresetJson: (f) => readPresetJson('houston', f) });
  try {
    const f = resolveForcing('houston', scene.state.scenario, {});
    scene.setForcing({ sources: f.sources, storms: f.storms, rainRate: f.rainRate, manningN: 0.035, stageOffset: f.stageOffset });
    scene.resetWater();
    await scene.runFor(600);
    const { fields } = await scene.read();
    assert.ok(Math.abs(fields.simTime - 600) < 1e-3);
    const assets = parsePortfolio(fs.readFileSync(DEMO_CSV, 'utf8')).assets;
    const a = analyze({ fields, terrain, velocityKnown: true, debrisFlow: false, alertTime: 0, portfolio: assets });
    const rows: ResultRowInput[] = (a.portfolio?.results ?? []).map((x) => ({ id: x.m.asset.id, name: x.m.asset.name, source: 'portfolio', occ: x.occ, match: x.m.match, matchDistanceM: x.m.distanceM, r: x, valueStructure: x.valueStructure, valueContents: x.valueContents, valueSource: x.valueSource, currency: x.currency }));
    assert.equal(csv, resultsCsv(rows));
  } finally {
    scene.destroy();
  }
  assert.deepEqual(gpuErrors(), []);
});

test('site --sweep on two Pittsburgh levels: JSON report with EAL, FFE, verdict; repeat runs agree exactly', () => {
  const run = (name: string) => {
    const out = path.join(tmp, name);
    const r = deluge('site', '--preset', 'pittsburgh', '--at', '40.4425,-80.0085', '--use', 'office', '--floors', '3', '--sweep', '--levels', 'ivan2004,rp100', '--minutes', '4', '--out', out, '--quiet');
    assert.equal(r.code, 0, r.stderr);
    console.log(`  site sweep 2 levels × 4 min: ${r.seconds.toFixed(1)} s wall`);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  const a = run('site-a.json');
  const b = run('site-b.json');
  assert.deepEqual(a.sweep.levels.map((l: { level: { id: string } }) => l.level.id), ['ivan2004', 'rp100']);
  assert.ok(a.sweep.ffe && a.sweep.ffe.ffeAboveGradeM > 0);
  assert.ok(Array.isArray(a.sweep.verdict) && a.sweep.verdict.length >= 3);
  assert.equal(a.sweep.levels[1].level.returnPeriod, 100);
  // Deterministic readbacks: the second process lands on the very same numbers.
  delete a.generatedAt;
  delete b.generatedAt;
  delete a.timing;
  delete b.timing;
  assert.deepEqual(b, a);
});
