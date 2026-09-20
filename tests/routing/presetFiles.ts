/// <reference types="node" />
/**
 * Node-side loader for the shipped presets: reads public/presets/<id>/ off disk into a PresetWorld.
 * Kept apart from presetWorld.ts so the browser harness can use the same preparation without node:fs.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { PresetMeta } from '../../src/data/presets';
import type { CompactRoads } from '../../src/data/roads';
import { presetWorld, type PresetWorld } from './presetWorld';

export const PRESETS_DIR = path.resolve(import.meta.dirname, '../../public/presets');

/** Preset ids that ship baked files (directory order is not guaranteed; sorted). */
export function bakedPresetIds(): string[] {
  return fs
    .readdirSync(PRESETS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PRESETS_DIR, d.name, 'meta.json')))
    .map((d) => d.name)
    .sort();
}

export function loadPresetWorld(id: string): PresetWorld {
  const dir = path.join(PRESETS_DIR, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as PresetMeta;
  const buf = fs.readFileSync(path.join(dir, meta.files.elevation));
  if (!meta.files.roads) throw new Error(`preset ${id} has no road network`);
  const roads = JSON.parse(fs.readFileSync(path.join(dir, meta.files.roads), 'utf8')) as CompactRoads;
  return presetWorld(meta, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, roads);
}
