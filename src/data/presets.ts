/**
 * Preset registry and loader for baked presets (public/presets/<id>/) plus the procedural `sandbox`.
 *
 * Baked files:
 *   meta.json      PresetMeta (grid, bounds, attribution, scenario, provenance)
 *   elevation.f32  nx·ny little-endian Float32, row-major (north row first), hydro-conditioned
 *   imagery.jpg    Esri World Imagery covering exactly `bounds`, north-up
 *   roads.json     CompactRoads (see roads.ts)
 */
import type { GeoBounds, PresetInfo, ProgressFn, ScenarioPreset, TerrainData } from '../contracts';
import { decodeImageBitmap } from './imagery';
import { fetchBytes, fetchJSON } from './net';
import { type CompactRoads, decodeRoads } from './roads';
import { generateSandbox, SANDBOX_NAME } from './sandbox';

export const PRESETS: PresetInfo[] = [
  { id: 'pittsburgh', name: 'Pittsburgh — Three Rivers', subtitle: "1936 St. Patrick's Day flood — raise the rivers" },
  { id: 'johnstown', name: 'Johnstown — Conemaugh Valley', subtitle: 'The Flood City — 1936 peak flows in the concrete channels' },
  { id: 'ellicott', name: 'Ellicott City — Main Street', subtitle: 'Flash floods of 2016 & 2018 — a storm over the Tiber branch' },
  { id: 'sandbox', name: SANDBOX_NAME, subtitle: 'Offline sandbox — river town, reservoir and dam' },
];

export interface PresetMeta {
  version: 1;
  id: string;
  name: string;
  subtitle: string;
  nx: number;
  ny: number;
  cellSize: number;
  bounds: GeoBounds;
  attribution: string;
  scenario: ScenarioPreset;
  files: { elevation: string; imagery: string | null; roads: string | null };
  /** Provenance / QA info written by the bake script (informational). */
  bake?: Record<string, unknown>;
}

let presetBase: string | null = null;

/** Override where baked presets are fetched from (default: `${import.meta.env.BASE_URL}presets/`). */
export function setPresetBaseUrl(url: string): void {
  presetBase = url.endsWith('/') ? url : `${url}/`;
}

function baseUrl(): string {
  if (presetBase) return presetBase;
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  return `${env?.BASE_URL ?? '/'}presets/`;
}

export function listPresets(): PresetInfo[] {
  return PRESETS.map((p) => ({ ...p }));
}

/** Decode elevation.f32 bytes (little-endian Float32). */
export function decodeElevation(buf: ArrayBuffer, nx: number, ny: number): Float32Array {
  if (buf.byteLength !== nx * ny * 4) {
    throw new Error(`elevation.f32 has ${buf.byteLength} bytes, expected ${nx * ny * 4} for ${nx}×${ny}`);
  }
  const dv = new DataView(buf);
  const out = new Float32Array(nx * ny);
  const littleEndianHost = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (littleEndianHost) out.set(new Float32Array(buf));
  else for (let k = 0; k < out.length; k++) out[k] = dv.getFloat32(k * 4, true);
  for (let k = 0; k < out.length; k++) {
    if (!Number.isFinite(out[k])) throw new Error('elevation.f32 contains non-finite values');
  }
  return out;
}

/** Structural validation of a meta.json object. Returns a list of problems (empty = valid). */
export function validatePresetMeta(m: PresetMeta): string[] {
  const errs: string[] = [];
  const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (m.version !== 1) errs.push('version must be 1');
  if (!m.name) errs.push('missing name');
  if (!(m.nx > 0 && m.nx % 16 === 0)) errs.push(`nx ${m.nx} not a positive multiple of 16`);
  if (!(m.ny > 0 && m.ny % 16 === 0)) errs.push(`ny ${m.ny} not a positive multiple of 16`);
  if (!isNum(m.cellSize) || m.cellSize <= 0) errs.push('bad cellSize');
  const b = m.bounds;
  if (!b || !(b.west < b.east && b.south < b.north)) errs.push('bad bounds');
  const s = m.scenario;
  if (!s) return errs.concat('missing scenario');
  const inside = (gx: number, gy: number) => gx >= 0 && gy >= 0 && gx <= m.nx && gy <= m.ny;
  for (const src of s.sources) {
    if (!isNum(src.gx) || !isNum(src.gy) || !(src.radius > 0)) errs.push(`source ${src.id} has a bad position or radius`);
    if (src.type === 'inflow') {
      // The whole discharge must land inside the domain.
      if (!inside(src.gx, src.gy)) errs.push(`source ${src.id} outside grid`);
      if (src.gx - src.radius < 0 || src.gy - src.radius < 0 || src.gx + src.radius > m.nx || src.gy + src.radius > m.ny) {
        errs.push(`source ${src.id} footprint crosses the domain edge`);
      }
    } else {
      // A stage source is a boundary condition: its disc may (and at a river's edge crossing should) extend past
      // the edge — its centre may even lie outside — but it must overlap the domain.
      const dx = Math.max(0, -src.gx, src.gx - m.nx);
      const dy = Math.max(0, -src.gy, src.gy - m.ny);
      if (Math.hypot(dx, dy) >= src.radius - 0.5) errs.push(`stage ${src.id} footprint does not overlap the grid`);
    }
    if (src.type === 'inflow' && !(src.discharge > 0)) errs.push(`inflow ${src.id} has no discharge`);
    if (src.type === 'stage' && !isNum(src.level)) errs.push(`stage ${src.id} has no level`);
    if (src.type === 'stage' && src.offsetScale !== undefined && !(isNum(src.offsetScale) && src.offsetScale > 0.5 && src.offsetScale < 2)) {
      errs.push(`stage ${src.id} offsetScale must be a number between 0.5 and 2`);
    }
  }
  for (const st of s.storms) if (!inside(st.gx, st.gy) || !(st.radius > 0)) errs.push(`storm ${st.id} invalid`);
  for (const sh of s.shelters) if (!inside(sh.gx, sh.gy) || !sh.name) errs.push(`shelter ${sh.name} invalid`);
  for (const f of s.initialFill) {
    if (!isNum(f.level)) errs.push('initialFill level not a number');
    for (const sd of f.seeds) if (!inside(sd.gx, sd.gy)) errs.push('initialFill seed outside grid');
  }
  if (s.stage) {
    const st = s.stage;
    if (![st.gaugeDatum, st.normalLevel, st.maxOffset].every(isNum) || st.maxOffset <= 0) errs.push('bad stage control');
  }
  if (s.camera) {
    const c = s.camera;
    if (!inside(c.target.gx, c.target.gy) || !(c.distance > 0) || !(c.pitch > 0 && c.pitch <= Math.PI / 2)) {
      errs.push('bad camera pose');
    }
  }
  return errs;
}

/** Yield to the event loop so progress callbacks can paint. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export async function loadPreset(id: string, onProgress?: ProgressFn): Promise<TerrainData> {
  const info = PRESETS.find((p) => p.id === id);
  if (!info) throw new Error(`Unknown preset "${id}"`);
  if (id === 'sandbox') {
    onProgress?.('Generating synthetic valley…', 0.1);
    await tick();
    const t = generateSandbox();
    onProgress?.('Ready', 1);
    return t;
  }

  const dir = `${baseUrl()}${id}/`;
  onProgress?.(`Loading ${info.name}…`, 0.02);
  const meta = await fetchJSON<PresetMeta>(`${dir}meta.json`, { timeoutMs: 20000, retries: 2 });
  const problems = validatePresetMeta(meta);
  if (problems.length) throw new Error(`Preset ${id} meta.json invalid: ${problems.join('; ')}`);

  // Weighted progress across the parallel downloads.
  const parts = { elevation: 0, imagery: 0, roads: 0 };
  const weights = { elevation: 0.45, imagery: 0.35, roads: 0.2 };
  const report = (msg: string) => {
    const f = 0.05 + 0.9 * (parts.elevation * weights.elevation + parts.imagery * weights.imagery + parts.roads * weights.roads);
    onProgress?.(msg, Math.min(0.95, f));
  };

  const elevationP = fetchBytes(`${dir}${meta.files.elevation}`, { timeoutMs: 60000, retries: 2 }).then((buf) => {
    parts.elevation = 1;
    report('Elevation loaded');
    return decodeElevation(buf, meta.nx, meta.ny);
  });
  const imageryP = meta.files.imagery
    ? fetchBytes(`${dir}${meta.files.imagery}`, { timeoutMs: 60000, retries: 2 })
        .then(async (buf) => {
          const bmp = await decodeImageBitmap(buf, 'image/jpeg');
          parts.imagery = 1;
          report('Imagery loaded');
          return bmp;
        })
        .catch((e) => {
          console.warn(`[data] imagery for ${id} unavailable:`, e);
          parts.imagery = 1;
          return null;
        })
    : Promise.resolve(null);
  const roadsP = meta.files.roads
    ? fetchJSON<CompactRoads>(`${dir}${meta.files.roads}`, { timeoutMs: 60000, retries: 2 })
        .then((c) => {
          parts.roads = 1;
          report('Roads loaded');
          return decodeRoads(c);
        })
        .catch((e) => {
          console.warn(`[data] roads for ${id} unavailable:`, e);
          parts.roads = 1;
          return null;
        })
    : Promise.resolve(null);

  const [elevation, imagery, roads] = await Promise.all([elevationP, imageryP, roadsP]);
  onProgress?.('Ready', 1);
  return {
    name: meta.name,
    nx: meta.nx,
    ny: meta.ny,
    cellSize: meta.cellSize,
    elevation,
    bounds: meta.bounds,
    imagery,
    roads,
    attribution: meta.attribution,
    scenario: meta.scenario,
  };
}
