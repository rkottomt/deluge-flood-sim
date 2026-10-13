/// <reference types="node" />
/**
 * `deluge` — the headless batch CLI. Entry point for bin/deluge.mjs (which registers tsx so this TypeScript runs as it
 * is, from the same sources as the app). See README "Batch / API" and docs/api.md.
 *
 *   deluge presets                         the scenarios that ship (no GPU)
 *   deluge run --preset …                  one scenario → GeoTIFF rasters + summary.json
 *   deluge portfolio --preset … --csv …    per-asset metrics, optional ensemble p10/p50/p90
 *   deluge site --preset … --at …          Site check (with --sweep: ladder, EAL, FFE, mitigation, verdict)
 *   deluge dam --nid …                     a dam breach's peak band and hydrograph (no GPU)
 *
 * Exit codes: 0 ok · 1 simulation or output failed · 2 bad arguments or input file · 3 no WebGPU adapter.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMANDS, commandHelp, EXIT, flag, mainHelp, parseOptions } from './args';
import { HANDLERS, type CliEnv } from './commands';
import { serveCommand, type Engine } from './server';
import { finishGpu, getGpu, gpuErrors, NoGpuError } from './gpu';
import { HeadlessScene } from './headless';
import { createLog, writeOutput } from './io';
import { availablePresetIds, loadAtlas14FromDisk, loadNidIndexFromDisk, loadPresetFromDisk, readPresetJson, readPresetMeta } from './presetFiles';
import { UsageError } from './scenario';

/** The engine version (package.json), recorded in every result. */
export function version(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Library code logs with console.info/log; in a CLI whose stdout carries results, all of that belongs on stderr. */
function routeConsoleToStderr(): void {
  const toErr = (...args: unknown[]) => console.error(...args);
  console.log = toErr;
  console.info = toErr;
  console.debug = toErr;
}

/** What every command shares: the presets on disk and this machine's GPU through Dawn (the CLI and `deluge serve`). */
export function gpuEngine(v: string): Engine {
  return {
    version: v,
    presetIds: availablePresetIds,
    presetMeta: readPresetMeta,
    loadTerrain: loadPresetFromDisk,
    loadAtlas14: loadAtlas14FromDisk,
    loadNidIndex: loadNidIndexFromDisk,
    async openScene(terrain, presetId, o) {
      const gpu = await getGpu();
      return HeadlessScene.create(gpu.device, terrain, { presetId, climate: o.climate, appCadence: o.appCadence, readPresetJson: (file) => readPresetJson(presetId, file) });
    },
    async gpuName() {
      return (await getGpu()).description;
    },
    gpuErrorCount: () => gpuErrors.length,
    settle: finishGpu,
    now: () => new Date(),
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const v = version();
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    const sub = cmd === 'help' ? rest[0] : undefined;
    process.stdout.write(sub && COMMANDS[sub] ? commandHelp(COMMANDS[sub]) : mainHelp(v));
    return cmd ? EXIT.ok : EXIT.usage;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${v}\n`);
    return EXIT.ok;
  }
  const spec = COMMANDS[cmd];
  if (!spec) {
    process.stderr.write(`deluge: unknown command "${cmd}"\n\n${mainHelp(v)}`);
    return EXIT.usage;
  }
  let opts;
  try {
    opts = parseOptions(spec, rest);
  } catch (err) {
    process.stderr.write(`deluge ${cmd}: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.usage;
  }
  if (flag(opts, 'help')) {
    process.stdout.write(commandHelp(spec));
    return EXIT.ok;
  }
  routeConsoleToStderr();
  const log = createLog({ quiet: flag(opts, 'quiet') });
  if (cmd === 'serve') return serveCommand(opts, gpuEngine(v), log);
  const env: CliEnv = {
    log,
    ...gpuEngine(v),
    readText: (file) => fs.readFileSync(file, 'utf8'),
    write: writeOutput,
    stdout: (text) => void process.stdout.write(text),
  };
  try {
    const code = await HANDLERS[cmd as keyof typeof COMMANDS](env, opts);
    if (gpuErrors.length) {
      log.warn(`WebGPU reported ${gpuErrors.length} error(s): ${gpuErrors.slice(0, 3).join(' | ')}`);
      return EXIT.failure;
    }
    return code;
  } catch (err) {
    log.endProgress();
    if (err instanceof UsageError) {
      process.stderr.write(`deluge ${cmd}: ${err.message}\n`);
      return EXIT.usage;
    }
    if (err instanceof NoGpuError) {
      process.stderr.write(`deluge ${cmd}: no WebGPU device — ${err.message}\n`);
      return EXIT.noGpu;
    }
    process.stderr.write(`deluge ${cmd}: failed — ${err instanceof Error ? err.message : String(err)}\n`);
    if (process.env.DELUGE_DEBUG && err instanceof Error && err.stack) process.stderr.write(`${err.stack}\n`);
    return EXIT.failure;
  } finally {
    await finishGpu();
  }
}
