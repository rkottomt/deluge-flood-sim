/// <reference types="node" />
/**
 * The baked presets off disk, through the app's own loader.
 *
 * src/data/presets.ts loadPreset() fetches `${base}<id>/meta.json`, the elevation, roads and buildings and validates
 * them; the CLI points that base at public/presets/ as a file:// URL and gives Node's fetch (which refuses file:) a
 * small shim that serves file:// URLs from disk. Everything else about the load — validation, decoding, the building
 * raster — is the browser's code path, so the terrain the CLI simulates is the terrain the app simulates. (Imagery
 * decodes to null: Node has no createImageBitmap, and the loader already treats imagery as optional.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { TerrainData } from '../contracts';
import { ATLAS14_MAX_DOWNLOAD, decodeAtlas14Grid, gunzipCapped, type Atlas14Grid } from '../data/atlas14';
import { listPresets, loadPreset, setPresetBaseUrl, type PresetMeta } from '../data/presets';
import { decodeNidIndex, NID_LIMITS, type NidIndex } from '../dams/nidIndex';

/** public/presets of this checkout (overridable with DELUGE_PRESETS_DIR, e.g. for a packaged install). */
export function presetsDir(): string {
  const env = process.env.DELUGE_PRESETS_DIR;
  if (env) return path.resolve(env);
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/presets');
}

const CONTENT_TYPES: Record<string, string> = { '.json': 'application/json', '.f32': 'application/octet-stream', '.jpg': 'image/jpeg', '.png': 'image/png' };

let installed = false;

/** Serve file:// URLs from disk through globalThis.fetch (idempotent); other URLs go to the real fetch. */
export function installFileFetch(): void {
  if (installed) return;
  installed = true;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith('file:')) return real(input, init);
    const file = fileURLToPath(url);
    try {
      const buf = await fs.promises.readFile(file);
      const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
        status: 200,
        headers: { 'content-type': type, 'content-length': String(buf.byteLength) },
      });
    } catch {
      return new Response('not found', { status: 404 });
    }
  }) as typeof fetch;
}

/** Ids of the baked presets on disk plus the procedural sandbox (registry order). */
export function availablePresetIds(): string[] {
  const dir = presetsDir();
  return listPresets()
    .map((p) => p.id)
    .filter((id) => id === 'sandbox' || fs.existsSync(path.join(dir, id, 'meta.json')));
}

/** A preset's meta.json, or null for the sandbox / a missing file. */
export function readPresetMeta(id: string): PresetMeta | null {
  const file = path.join(presetsDir(), id, 'meta.json');
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as PresetMeta;
}

/** A JSON file baked next to a preset's meta.json (chain.json, chain-result.json). */
export function readPresetJson(id: string, file: string): unknown {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}\.json$/i.test(file) || file.includes('..')) throw new Error(`not a baked file name: ${file}`);
  return JSON.parse(fs.readFileSync(path.join(presetsDir(), id, file), 'utf8'));
}

/**
 * The app's NOAA Atlas 14 grid (public/atlas14/pf60m-pds.bin, next to public/presets), through the app's own capped
 * gunzip and strict decoder — the rain ladder the CLI builds is the one the Site check builds. Read once per process.
 */
let atlas14: Promise<Atlas14Grid> | null = null;
export function loadAtlas14FromDisk(): Promise<Atlas14Grid> {
  atlas14 ??= (async () => {
    const file = path.join(path.dirname(presetsDir()), 'atlas14', 'pf60m-pds.bin');
    const buf = await fs.promises.readFile(file);
    if (buf.byteLength > ATLAS14_MAX_DOWNLOAD) throw new Error('Atlas 14 grid: file too large');
    return decodeAtlas14Grid(await gunzipCapped(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
  })().catch((e) => {
    atlas14 = null;
    throw e;
  });
  return atlas14;
}

let nidIndex: Promise<NidIndex> | null = null;

/** The baked National Inventory of Dams index (public/dams/nid-index.bin, the app's file, decoded by the app's decoder). */
export function loadNidIndexFromDisk(): Promise<NidIndex> {
  nidIndex ??= (async () => {
    const file = path.join(path.dirname(presetsDir()), 'dams', 'nid-index.bin');
    const buf = await fs.promises.readFile(file);
    if (buf.byteLength > NID_LIMITS.maxDownload) throw new Error('Dam index: file too large');
    return decodeNidIndex(await gunzipCapped(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), NID_LIMITS.maxBytes));
  })().catch((e) => {
    nidIndex = null;
    throw e;
  });
  return nidIndex;
}

/** Load a preset with the app's loader, from disk. */
export async function loadPresetFromDisk(id: string, onProgress?: (message: string, fraction: number) => void): Promise<TerrainData> {
  installFileFetch();
  setPresetBaseUrl(pathToFileURL(presetsDir()).href);
  return loadPreset(id, onProgress);
}
