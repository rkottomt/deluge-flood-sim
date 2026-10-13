/**
 * `?project=` share links for small projects: the project's JSON (without names, portfolio or cached results — a link
 * is copied around, and its text is someone else's when it comes back), gzip-compressed with the browser's own
 * CompressionStream, in base64url, behind a version prefix:  ?project=p1.<base64url(gzip(json))>
 *
 * A project whose link would pass LINK_BUDGET characters is not linked — the user is told to share the file instead
 * (long URLs get truncated by chat apps and mail clients, and some servers refuse them).
 *
 * Decoding is bounded at every step: the parameter's length and alphabet, the compressed bytes, and the INFLATED bytes
 * (a gzip bomb stops at INFLATE_CAP), then the same strict reader as a file (validate.ts) with `fromLink`.
 */
import type { ProjectFile } from './format';
import { parseProjectText, projectToJson, type ReadResult } from './validate';

export const PROJECT_PARAM = 'project';
export const LINK_PREFIX = 'p1.';
/** Longest ?project= value written or read, characters. */
export const LINK_BUDGET = 6000;
/** Most bytes a link may inflate to. */
export const INFLATE_CAP = 256 * 1024;

export const LINK_ERRORS = {
  format: 'Ignoring a ?project= link value that is not in the expected format.',
  tooLong: 'Ignoring a ?project= link value that is longer than a project link can be.',
  inflate: 'Ignoring a ?project= link value that could not be unpacked (damaged, or larger than a project link may hold).',
  unsupported: 'This browser cannot unpack ?project= links (no DecompressionStream); open the project file instead.',
} as const;

const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** What a link carries: the project minus names, portfolio and cached results. */
export function linkableProject(p: ProjectFile): ProjectFile {
  return {
    ...p,
    name: '',
    savedAt: '',
    scene: p.scene.kind === 'live' ? { kind: 'live', lat: p.scene.lat, lon: p.scene.lon, sizeM: p.scene.sizeM, resolution: p.scene.resolution } : p.scene,
    scenario: {
      ...p.scenario,
      sources: p.scenario.sources.map((s) => {
        const { label: _label, ...rest } = s;
        return rest as typeof s;
      }),
      shelters: p.scenario.shelters.map((s, i) => ({ ...s, name: `Shelter ${i + 1}` })),
    },
    sites: p.sites.map((s) => ({ ...s, name: '' })),
    designs: p.designs.map((d) => ({ ...d, name: '' })),
    portfolio: null,
    comparison: null,
  };
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array | null {
  if (!B64URL_RE.test(s) || s.length % 4 === 1) return null;
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  try {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

async function pump(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(cs);
  const out = await pump(stream as ReadableStream<Uint8Array>, Number.MAX_SAFE_INTEGER);
  if (!out) throw new Error('compression failed');
  return out;
}

/** Inflate gzip bytes, giving up past `cap` inflated bytes (null). */
export async function gunzipCapped(bytes: Uint8Array, cap = INFLATE_CAP): Promise<Uint8Array | null> {
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  return pump(stream as ReadableStream<Uint8Array>, cap);
}

/** The ?project= value for a project, or null (with the length it would have) when it does not fit the budget. */
export async function encodeProjectLink(p: ProjectFile): Promise<{ value: string | null; length: number }> {
  const json = projectToJson(linkableProject(p), false);
  const z = await gzip(new TextEncoder().encode(json));
  const value = LINK_PREFIX + bytesToBase64Url(z);
  return value.length <= LINK_BUDGET ? { value, length: value.length } : { value: null, length: value.length };
}

/** Decode a ?project= value strictly (fixed warning sentences; nothing from the link is echoed). */
export async function decodeProjectLink(raw: string | null | undefined): Promise<ReadResult> {
  if (!raw) return { ok: false, error: LINK_ERRORS.format };
  if (raw.length > LINK_BUDGET) return { ok: false, error: LINK_ERRORS.tooLong };
  if (!raw.startsWith(LINK_PREFIX)) return { ok: false, error: LINK_ERRORS.format };
  const bytes = base64UrlToBytes(raw.slice(LINK_PREFIX.length));
  if (!bytes || bytes.length < 18) return { ok: false, error: LINK_ERRORS.format };
  if (typeof DecompressionStream !== 'function') return { ok: false, error: LINK_ERRORS.unsupported };
  const inflated = await gunzipCapped(bytes, INFLATE_CAP);
  if (!inflated) return { ok: false, error: LINK_ERRORS.inflate };
  let t: string;
  try {
    t = new TextDecoder('utf-8', { fatal: true }).decode(inflated);
  } catch {
    return { ok: false, error: LINK_ERRORS.inflate };
  }
  return parseProjectText(t, { fromLink: true });
}
