/**
 * The "Reference (N²)" overlay: the grid-convergence study's finest run, shipped as data so the app can DRAW the
 * validation instead of linking to a table.
 *
 * `scripts/reference-run.ts` runs the shipping solver on the same scenario at 1024², 2048² and 4096² and writes
 * `public/presets/<id>/reference.{json,bin}` from the finest run. This module is the read side: it defines the
 * format, decodes it, and is the ONLY thing the renderer needs to know about.
 *
 * FORMAT (version 1)
 * ------------------
 * `reference.json` is the manifest; `reference.bin` is the planes' bytes concatenated. Each plane is `nx*ny` bytes
 * of u8 — one byte per cell of the PRESET grid, row-major, same indexing as `elevation.f32` — gzip-compressed
 * independently so one fetch serves them all and a caller inflates only what it draws.
 *
 * Two plane kinds, both reserving code 0 for "nothing here":
 *   maxDepth  the deepest water each cell reached, m. Sqrt-quantised: `d = scale * (code/255)²`. The curve puts the
 *             fine steps where a flood map is read (~1.2 cm per code at the 0.15 m hazard band, ~12 cm at 16 m)
 *             instead of spreading a flat 6 cm step over a range nobody reads that precisely. Code 0 = dry, and any
 *             positive depth gets at least code 1, so a thin sheet never vanishes into the dry background.
 *   arrival   when the cell first reached `arrivalThreshold`, s. Linear: `t = (code-1)/254 * scale`.
 *             Code 0 = never reached it, which decodes to NaN so it cannot be mistaken for "arrived at t=0".
 *
 * `plane.quantMaxError` records the worst round-trip error the quantisation actually introduced when the file was
 * written, in the plane's own unit — so a caller can check the encoding is not the limiting factor rather than
 * taking it on faith. For the Pittsburgh crest case it is ~6 cm worst / ~2 cm RMSE against a 0.13–0.29 m
 * discretisation error, i.e. an order of magnitude below the thing the overlay illustrates.
 *
 * OPTIONAL BY DESIGN. A preset without `reference.json` is normal: `loadReferenceOverlay` resolves to null for a
 * missing file, a malformed manifest, or a browser without `DecompressionStream`, and never throws for any of
 * those. Callers should treat null as "no overlay for this preset" and hide the control, not as an error. gzip is a
 * strictly weaker requirement than WebGPU, so in practice any browser that can run the simulation can read this.
 */

/** Bumped only for a breaking change to the layout; a loader refuses anything it does not recognise. */
export const REFERENCE_OVERLAY_VERSION = 1;

/** Hard ceiling on a plane's cell count, so a hostile or corrupt manifest cannot ask for a huge allocation. */
const MAX_PLANE_CELLS = 8192 * 8192;

export type ReferenceOverlayCase = string;

export interface ReferenceOverlayPlane {
  /** Scenario this plane belongs to, e.g. 'crest' or 'rain'. */
  case: ReferenceOverlayCase;
  kind: 'maxDepth' | 'arrival';
  /** Byte range of this plane's gzip member inside `reference.bin`. */
  offset: number;
  length: number;
  /** Byte length after inflation; must equal nx*ny. */
  inflatedLength: number;
  quant: 'sqrt' | 'linear';
  /** The value code 255 decodes to, in `unit`. */
  scale: number;
  unit: 'm' | 's';
  /** Worst round-trip error the quantisation introduced when this file was written, in `unit`. */
  quantMaxError: number;
  /** Cells with a non-zero code (wet, or arrived). */
  nonZeroCells: number;
}

export interface ReferenceOverlayManifest {
  version: number;
  preset: string;
  /** Overlay grid — equal to the preset's baked grid, so live cell indices address it directly. */
  nx: number;
  ny: number;
  cellSize: number;
  /** The grid the reference run was computed on (e.g. 4096) and its refinement over nx. */
  referenceGrid: number;
  refine: number;
  bed: string;
  durationSeconds: number;
  /** Depth whose first crossing the arrival planes record, m. */
  arrivalThreshold: number;
  resample: 'block-mean';
  encoding: 'gzip';
  binary: string;
  sha256: string;
  planes: ReferenceOverlayPlane[];
  provenance: {
    generatedAt: string;
    gpu: string;
    host: string;
    runs: Record<string, { wallClockS: number; substeps: number; massError: number }>;
  };
}

export interface ReferenceOverlay {
  manifest: ReferenceOverlayManifest;
  case: ReferenceOverlayCase;
  /** Deepest water each cell reached during the reference run, m. Length nx*ny. */
  maxDepth: Float32Array;
  /**
   * When each cell first reached `manifest.arrivalThreshold`, s; NaN where it never did. null when this preset
   * ships no arrival plane for the case.
   */
  arrival: Float32Array | null;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Codecs. Encode lives next to decode on purpose: the round-trip is the format, and
// tests/sim/referenceOverlay.test.ts asserts they are inverses. The encoders are build-time only and
// tree-shake out of the app bundle.
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Quantise depths (m) to u8 with the sqrt curve. Code 0 = dry; any positive depth gets at least 1. */
export function encodeDepthPlane(field: Float32Array, scale: number): Uint8Array {
  if (!(scale > 0)) throw new Error(`depth scale must be positive (got ${scale})`);
  const q = new Uint8Array(field.length);
  for (let k = 0; k < field.length; k++) {
    const d = field[k];
    if (!(d > 0)) continue;
    q[k] = Math.min(255, Math.max(1, Math.round(255 * Math.sqrt(Math.min(d, scale) / scale))));
  }
  return q;
}

/** Inverse of {@link encodeDepthPlane}: 0 → 0 m, else `scale * (code/255)²`. */
export function decodeDepthPlane(q: Uint8Array, scale: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) {
    if (q[k] === 0) continue;
    const t = q[k] / 255;
    out[k] = scale * t * t;
  }
  return out;
}

/** Quantise arrival times (s) to u8, linearly over [0, duration]. Negative/NaN → code 0 ("never"). */
export function encodeArrivalPlane(arrival: Float32Array, duration: number): Uint8Array {
  if (!(duration > 0)) throw new Error(`duration must be positive (got ${duration})`);
  const q = new Uint8Array(arrival.length);
  for (let k = 0; k < arrival.length; k++) {
    const t = arrival[k];
    if (!(t >= 0)) continue;
    q[k] = Math.min(255, 1 + Math.round(Math.min(1, t / duration) * 254));
  }
  return q;
}

/** Inverse of {@link encodeArrivalPlane}. NaN = never reached the threshold. */
export function decodeArrivalPlane(q: Uint8Array, duration: number): Float32Array {
  const out = new Float32Array(q.length);
  for (let k = 0; k < q.length; k++) out[k] = q[k] === 0 ? Number.NaN : ((q[k] - 1) / 254) * duration;
  return out;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────────────
// Validation and loading
// ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Structural validation of a parsed reference.json. Returns a list of problems (empty = usable). Mirrors
 * `validatePresetMeta`'s contract: the loader turns any problem into "no overlay" rather than a thrown error, so a
 * stale or truncated file degrades to the app simply not offering the overlay.
 */
export function validateReferenceOverlayManifest(m: unknown, binaryLength?: number): string[] {
  const p: string[] = [];
  if (typeof m !== 'object' || m === null) return ['manifest is not an object'];
  const o = m as Partial<ReferenceOverlayManifest>;
  if (o.version !== REFERENCE_OVERLAY_VERSION) p.push(`version ${String(o.version)} (expected ${REFERENCE_OVERLAY_VERSION})`);
  if (o.encoding !== 'gzip') p.push(`encoding ${String(o.encoding)} (expected gzip)`);
  if (o.binary !== 'reference.bin') p.push(`binary ${String(o.binary)} (expected reference.bin)`);
  const int = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;
  if (!int(o.nx) || !int(o.ny)) p.push('nx/ny must be positive integers');
  else if (o.nx * o.ny > MAX_PLANE_CELLS) p.push(`${o.nx}×${o.ny} exceeds the ${MAX_PLANE_CELLS}-cell cap`);
  if (typeof o.durationSeconds !== 'number' || !(o.durationSeconds > 0)) p.push('durationSeconds must be positive');
  if (typeof o.arrivalThreshold !== 'number' || !(o.arrivalThreshold >= 0)) p.push('arrivalThreshold must be >= 0');
  if (!Array.isArray(o.planes) || o.planes.length === 0) {
    p.push('planes must be a non-empty array');
    return p;
  }
  const cells = int(o.nx) && int(o.ny) ? o.nx * o.ny : 0;
  o.planes.forEach((pl, i) => {
    const at = `planes[${i}]`;
    if (typeof pl !== 'object' || pl === null) {
      p.push(`${at} is not an object`);
      return;
    }
    if (typeof pl.case !== 'string' || pl.case.length === 0) p.push(`${at}.case must be a non-empty string`);
    if (pl.kind !== 'maxDepth' && pl.kind !== 'arrival') p.push(`${at}.kind ${String(pl.kind)} unknown`);
    if (pl.quant !== 'sqrt' && pl.quant !== 'linear') p.push(`${at}.quant ${String(pl.quant)} unknown`);
    if (typeof pl.scale !== 'number' || !(pl.scale > 0)) p.push(`${at}.scale must be positive`);
    if (!Number.isInteger(pl.offset) || pl.offset < 0) p.push(`${at}.offset must be a non-negative integer`);
    if (!Number.isInteger(pl.length) || pl.length <= 0) p.push(`${at}.length must be a positive integer`);
    if (cells && pl.inflatedLength !== cells) p.push(`${at}.inflatedLength ${String(pl.inflatedLength)} != ${cells}`);
    if (binaryLength !== undefined && Number.isInteger(pl.offset) && Number.isInteger(pl.length)) {
      if (pl.offset + pl.length > binaryLength) p.push(`${at} range ${pl.offset}+${pl.length} overruns ${binaryLength} bytes`);
    }
  });
  return p;
}

/** Does this runtime have the gzip decoder the format needs? */
export function referenceOverlaySupported(): boolean {
  return typeof DecompressionStream === 'function';
}

/** Inflate one gzip member. Split out so the test can exercise it without a network. */
export async function inflateGzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Cases a manifest carries, in manifest order, de-duplicated. */
export function referenceOverlayCases(m: ReferenceOverlayManifest): ReferenceOverlayCase[] {
  return [...new Set(m.planes.map((p) => p.case))];
}

export interface LoadReferenceOverlayOptions {
  /**
   * Where presets are served from. Defaults to `${BASE_URL}presets/`, matching `loadPreset`'s default. Pass the same
   * value here if the app has overridden it with `setPresetBaseUrl` (Electron, or a test server).
   */
  baseUrl?: string;
  /** Aborts the two fetches. */
  signal?: AbortSignal;
  /** Called with a one-line reason whenever the overlay is unavailable, for a debug HUD. */
  onUnavailable?: (reason: string) => void;
}

/**
 * Load the reference overlay for `presetId` / `caseId`, or null when there is none.
 *
 * Returns null (never throws) for: no `DecompressionStream`, a 404 on either file, an unparseable or invalid
 * manifest, a case the manifest does not carry, a plane whose bytes do not inflate to the declared length, or a
 * decoded field containing non-finite depths. Anything else is a bug and propagates.
 */
export async function loadReferenceOverlay(
  presetId: string,
  caseId: ReferenceOverlayCase,
  opts: LoadReferenceOverlayOptions = {},
): Promise<ReferenceOverlay | null> {
  const bail = (reason: string): null => {
    opts.onUnavailable?.(reason);
    return null;
  };
  if (!referenceOverlaySupported()) return bail('DecompressionStream unavailable');
  // The preset id reaches a URL, and in this app it can originate from `?preset=` (see isPresetId / SEC-01). Even
  // though callers are expected to validate first, refuse anything but a plain slug rather than build the URL.
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(presetId)) return bail(`invalid preset id`);

  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  const rawBase = opts.baseUrl ?? `${env?.BASE_URL ?? '/'}presets/`;
  const base = rawBase.endsWith('/') ? rawBase : `${rawBase}/`;
  const dir = `${base}${presetId}/`;

  let manifest: ReferenceOverlayManifest;
  let bin: Uint8Array;
  try {
    const mRes = await fetch(`${dir}reference.json`, { signal: opts.signal });
    if (!mRes.ok) return bail(`reference.json: HTTP ${mRes.status}`);
    const parsed: unknown = await mRes.json();
    // The binary's name is fixed by the format, not taken from the manifest: a manifest is fetched content, and
    // letting it name the next URL would hand it a path it should not control.
    const bRes = await fetch(`${dir}reference.bin`, { signal: opts.signal });
    if (!bRes.ok) return bail(`reference.bin: HTTP ${bRes.status}`);
    bin = new Uint8Array(await bRes.arrayBuffer());
    const problems = validateReferenceOverlayManifest(parsed, bin.byteLength);
    if (problems.length) return bail(`invalid manifest: ${problems.join('; ')}`);
    manifest = parsed as ReferenceOverlayManifest;
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return bail(`fetch failed: ${(err as Error)?.message ?? String(err)}`);
  }

  const depthPlane = manifest.planes.find((p) => p.case === caseId && p.kind === 'maxDepth');
  if (!depthPlane) return bail(`no maxDepth plane for case "${caseId}"`);
  const arrivalPlane = manifest.planes.find((p) => p.case === caseId && p.kind === 'arrival');

  const inflate = async (pl: ReferenceOverlayPlane): Promise<Uint8Array | null> => {
    const raw = await inflateGzip(bin.subarray(pl.offset, pl.offset + pl.length));
    return raw.byteLength === pl.inflatedLength ? raw : null;
  };

  const dq = await inflate(depthPlane);
  if (!dq) return bail(`maxDepth plane inflated to the wrong length`);
  const maxDepth = decodeDepthPlane(dq, depthPlane.scale);
  for (let k = 0; k < maxDepth.length; k++) {
    if (!Number.isFinite(maxDepth[k])) return bail('maxDepth contains non-finite values');
  }

  let arrival: Float32Array | null = null;
  if (arrivalPlane) {
    const aq = await inflate(arrivalPlane);
    // A bad arrival plane costs the sweep animation, not the overlay: keep the depths and carry on.
    if (aq) arrival = decodeArrivalPlane(aq, arrivalPlane.scale);
    else opts.onUnavailable?.('arrival plane inflated to the wrong length; depths only');
  }

  return { manifest, case: caseId, maxDepth, arrival };
}
