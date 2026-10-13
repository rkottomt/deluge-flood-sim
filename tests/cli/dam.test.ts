/// <reference types="node" />
/**
 * `deluge dam` (src/cli/dam.ts): the peak band and hydrograph for an NID dam or a described one, the history table, and
 * usage errors — in-process, with the app's baked NID index read from disk (no GPU, no network).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, parseOptions } from '../../src/cli/args';
import { HANDLERS, type CliEnv } from '../../src/cli/commands';
import { createLog } from '../../src/cli/io';
import { loadNidIndexFromDisk } from '../../src/cli/presetFiles';
import { UsageError } from '../../src/cli/scenario';

async function run(args: string[]): Promise<{ code: number; out: string; files: Map<string, string> }> {
  const out: string[] = [];
  const files = new Map<string, string>();
  const env = {
    log: createLog({ quiet: true }),
    loadNidIndex: loadNidIndexFromDisk,
    write: (f: string, d: string) => void files.set(f, d),
    stdout: (t: string) => void out.push(t),
  } as unknown as CliEnv;
  const code = await HANDLERS.dam(env, parseOptions(COMMANDS.dam, args));
  return { code, out: out.join(''), files };
}

test('dam --nid: Edenville Dam flood-induced — the band, the central hydrograph, the assumptions', async () => {
  const r = await run(['--nid', 'MI00549', '--breach', 'flood', '--json']);
  assert.equal(r.code, 0);
  const j = JSON.parse(r.out);
  assert.equal(j.dam.nid, 'MI00549');
  assert.equal(j.mode, 'flood');
  assert.equal(j.method, 'central');
  assert.equal(j.relations.length, 8);
  assert.equal(j.band.central.relation, 'froehlich1995');
  assert.ok(j.band.low.peakM3s <= j.band.central.peakM3s && j.band.central.peakM3s <= j.band.high.peakM3s);
  assert.ok(Math.abs(j.peakM3s / j.band.central.peakM3s - 1) < 3e-3, `${j.peakM3s} vs ${j.band.central.peakM3s}`);
  assert.ok(j.hydrograph.length > 100 && j.hydrograph[0][1] > 0, 'starts on the spillway base flow');
  assert.ok(j.assumptions.some((a: string) => /spillway discharge/.test(a)));
  // The high case is the band's top; the CSV is the hydrograph sent to the map.
  const hi = await run(['--nid', 'mi00549', '--breach', 'flood', '--method', 'high', '--out', 'h.csv']);
  assert.equal(hi.code, 0);
  assert.match(hi.out, /Peak outflow, 8 published relations: .* – .*\n {2}central /);
  const csv = hi.files.get('h.csv')!;
  assert.match(csv, /^t_s,q_m3s\n0,/);
  assert.ok(csv.trim().split('\n').length > 100);
});

test('dam --volume-m3: Teton described on the command line; the band holds the observed 65,120 m³/s', async () => {
  const r = await run(['--volume-m3', '3.1e8', '--head-m', '77.4', '--height-m', '86.9', '--json']);
  const j = JSON.parse(r.out);
  assert.ok(j.band.low.peakM3s < 65_120 && 65_120 < j.band.high.peakM3s);
  assert.ok(Math.abs(j.band.central.peakM3s / 65_120 - 0.66) < 0.03);
  assert.ok(Math.abs(j.froehlich2008.avgWidthM - 168) < 2);
});

test('dam --history: the score table, Froehlich 1995 first and marked central', async () => {
  const r = await run(['--history']);
  assert.equal(r.code, 0);
  const rows = r.out.split('\n').filter((l) => /^\S.* {2,}\d+ +[+-]\d/.test(l));
  assert.equal(rows.length, 8);
  assert.match(rows[0], /^Froehlich 1995 peak \* +21 +-0\.07 +0\.15 +100 %/);
});

test('dam: usage errors are exit code 2 material (UsageError), never a crash', async () => {
  for (const args of [[], ['--nid', '<script>'], ['--nid', 'ZZ99999'], ['--nid', 'MI00549', '--breach', 'now'], ['--nid', 'MI00549', '--method', 'x'], ['--volume-m3', '1e6'], ['--volume-m3', '-5', '--head-m', '3'], ['--nid', 'MI00549', '--volume-m3', '1e6']]) {
    await assert.rejects(run(args), UsageError, args.join(' '));
  }
});
