/**
 * `deluge serve` on the real GPU (like tests/cli/smoke.test.ts: needs a WebGPU adapter through Dawn): the server on an
 * ephemeral port with the CLI's own engine, a 2-minute Houston run POSTed, polled and downloaded — and the binary run
 * with the same options gives the same files (rasters byte for byte, the summary but for its timestamps and timings),
 * because both run the same command handler and the readbacks are on simulated time.
 * Run: node --import tsx --test tests/cli/server-gpu.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finishGpu, gpuErrors } from '../../src/cli/gpu';
import { gpuEngine, version } from '../../src/cli/main';
import { startServer, type ApiServer } from '../../src/cli/server';

const ROOT = path.resolve(import.meta.dirname, '../..');
const BIN = path.join(ROOT, 'bin', 'deluge.mjs');
let tmp = '';
let api: ApiServer;

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deluge-serve-gpu-'));
  api = await startServer({ engine: gpuEngine(version()), dataDir: path.join(tmp, 'api'), port: 0 });
});
after(async () => {
  await api?.close();
  await finishGpu();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const get = async (p: string) => {
  const r = await fetch(`${api.url}${p}`);
  return { status: r.status, body: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') };
};

function comparable(text: string): unknown {
  const j = JSON.parse(text);
  delete j.generatedAt;
  delete j.outDir;
  for (const k of ['wallSeconds', 'loadSeconds', 'simSpeedX']) delete j.run[k];
  return j;
}

test('a run POSTed to the server on the GPU equals the binary’s run, raster for raster', async () => {
  const t0 = performance.now();
  const r = await fetch(`${api.url}/v1/runs`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'gpu-test' }, body: JSON.stringify({ preset: 'houston', scenario: { minutes: 2 } }) });
  assert.equal(r.status, 202);
  const job = (await r.json()) as { id: string };
  type JobView = { status: string; files: Array<{ name: string; url: string }>; engine: { gpu: string | null }; error: string | null };
  let state: JobView | null = null;
  for (let i = 0; i < 6000; i++) {
    state = (await (await fetch(`${api.url}/v1/jobs/${job.id}`)).json()) as JobView;
    if (state && state.status !== 'queued' && state.status !== 'running') break;
    await new Promise((res) => setTimeout(res, 100));
  }
  assert.equal(state?.status, 'succeeded', JSON.stringify(state));
  assert.ok(state!.engine.gpu && state!.engine.gpu.length > 0, 'the GPU is recorded');
  console.log(`  API run houston 2 min: ${((performance.now() - t0) / 1000).toFixed(1)} s wall on ${state!.engine.gpu}`);
  assert.deepEqual(gpuErrors, []);

  const out = path.join(tmp, 'cli');
  const cli = spawnSync(process.execPath, [BIN, 'run', '--preset', 'houston', '--minutes', '2', '--out', out, '--quiet'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  assert.equal(cli.status, 0, cli.stderr);
  for (const f of state!.files) {
    const got = await get(f.url);
    assert.equal(got.status, 200);
    const want = fs.readFileSync(path.join(out, f.name));
    if (f.name.endsWith('.json')) assert.deepEqual(comparable(Buffer.from(got.body).toString('utf8')), comparable(want.toString('utf8')), f.name);
    else assert.ok(Buffer.from(got.body).equals(want), `${f.name}: the API's raster is the CLI's, byte for byte`);
  }
  assert.equal(state!.files.length, 5);
});
