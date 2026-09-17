/**
 * Network helpers: fetch with timeout, retries with exponential backoff, and detection of ArcGIS errors
 * (ArcGIS REST endpoints often answer HTTP 200 with a JSON `{ error: ... }` body).
 * Works in browsers and Node ≥ 18 (global fetch / AbortController).
 */

export interface FetchOptions {
  /**
   * Per-attempt timeout until the response headers arrive, ms (ArcGIS export services render the whole image before
   * sending a byte, so this must allow for that).
   */
  timeoutMs?: number;
  /**
   * Once the body is streaming, abort the attempt if no bytes arrive for this long, ms (default 20 s). A slow but
   * moving download is never cut off; a stalled one (dead venue wifi) fails in seconds instead of minutes.
   */
  stallMs?: number;
  /** Additional attempts after the first. */
  retries?: number;
  /** Base backoff, ms (doubles per retry). */
  backoffMs?: number;
  /** Expected content-type prefix (e.g. 'image/'); anything else is treated as an error. */
  expectType?: string;
  signal?: AbortSignal;
  /** Called before each retry. */
  onRetry?: (attempt: number, err: unknown) => void;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Short, readable host for error messages. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 60);
  }
}

/** Read a response body, aborting through `ctrl` when no bytes arrive for `stallMs`. */
async function readBody(res: Response, ctrl: AbortController, stallMs: number, onStall: () => void): Promise<ArrayBuffer> {
  const reader = res.body?.getReader?.();
  if (!reader) return res.arrayBuffer();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer = setTimeout(onStall, stallMs);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      clearTimeout(timer);
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
      timer = setTimeout(onStall, stallMs);
    }
  } catch (e) {
    if (ctrl.signal.aborted) void reader.cancel().catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out.buffer;
}

async function attempt(url: string, opts: FetchOptions): Promise<{ buf: ArrayBuffer; type: string }> {
  opts.signal?.throwIfAborted();
  const ctrl = new AbortController();
  let why = '';
  const giveUp = (reason: string) => {
    why = reason;
    ctrl.abort(new Error(reason));
  };
  const timeoutMs = opts.timeoutMs ?? 45000;
  const timer = setTimeout(() => giveUp(`${hostOf(url)} timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new HttpError(`${hostOf(url)} responded HTTP ${res.status}`, res.status);
    const type = res.headers.get('content-type') ?? '';
    const stallMs = opts.stallMs ?? 20000;
    const buf = await readBody(res, ctrl, stallMs, () => giveUp(`${hostOf(url)} timed out: the download stalled for ${Math.round(stallMs / 1000)} s`));
    if (opts.expectType && !type.startsWith(opts.expectType)) {
      // ArcGIS reports failures as JSON/HTML with status 200.
      let detail = '';
      try {
        detail = new TextDecoder().decode(buf.slice(0, 300));
      } catch {
        /* ignore */
      }
      throw new HttpError(`${hostOf(url)} returned ${type || 'unknown type'} instead of ${opts.expectType}: ${detail}`, 200);
    }
    return { buf, type };
  } catch (e) {
    if (ctrl.signal.aborted && !opts.signal?.aborted) throw new Error(why || `${hostOf(url)} timed out`);
    throw e;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

/** Fetch bytes with timeout + retries. 4xx responses (other than 408/429) are not retried. */
export async function fetchBytes(url: string, opts: FetchOptions = {}): Promise<ArrayBuffer> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      return (await attempt(url, opts)).buf;
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      const status = e instanceof HttpError ? e.status : 0;
      const permanent = status >= 400 && status < 500 && status !== 408 && status !== 429;
      if (permanent || i === retries) break;
      opts.onRetry?.(i + 1, e);
      await sleep((opts.backoffMs ?? 600) * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Fetch + parse JSON with retries; throws on ArcGIS `{error}` bodies. */
export async function fetchJSON<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const buf = await fetchBytes(url, { ...opts, retries: 0 });
      const json = JSON.parse(new TextDecoder().decode(buf)) as T & { error?: { message?: string; code?: number } };
      if (json && typeof json === 'object' && 'error' in json && json.error) {
        throw new HttpError(`${hostOf(url)}: ${json.error.message ?? 'service error'}`, json.error.code ?? 500);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (opts.signal?.aborted) throw e;
      const status = e instanceof HttpError ? e.status : 0;
      if ((status >= 400 && status < 500 && status !== 408 && status !== 429) || i === retries) break;
      opts.onRetry?.(i + 1, e);
      await sleep((opts.backoffMs ?? 600) * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Run async jobs with bounded concurrency, preserving result order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const k = next++;
      out[k] = await fn(items[k], k);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * True for failures that say nothing about the place asked for, only that the service could not be reached: fetch
 * TypeErrors ("Failed to fetch"), timeouts and stalls. HTTP errors (the service answered) are not network failures.
 */
export function isNetworkFailure(e: unknown): boolean {
  if (e instanceof HttpError) return false;
  if (e instanceof TypeError) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /timed out|stalled|failed to fetch|networkerror|network error|load failed|err_internet|err_network|unreachable/i.test(msg);
}

/** Hosts a live load needs; reaching any of them means the network is up. */
export const DATA_HOST_PROBES = [
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=json',
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png',
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json',
];

/**
 * True when at least one of `urls` answers within `timeoutMs`. `navigator.onLine` alone is not trusted (captive portals
 * and broken venue wifi report online); an opaque no-cors response is enough to prove reachability.
 */
export async function probeReachable(urls: readonly string[] = DATA_HOST_PROBES, timeoutMs = 3000): Promise<boolean> {
  if (browserOffline()) return noteProbe(false);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await Promise.any(urls.map((u) => fetch(u, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })));
    return noteProbe(true);
  } catch {
    return noteProbe(false);
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** The browser itself reports no network (navigator.onLine false). "Online" is not trusted (see probeReachable). */
export function browserOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

const clockMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
let lastProbe: { ok: boolean; at: number } | null = null;

function noteProbe(ok: boolean): boolean {
  lastProbe = { ok, at: clockMs() };
  return ok;
}

/**
 * The latest probeReachable answer (from anywhere in the page, e.g. the location picker's offline check) came back
 * unreachable less than `maxAgeMs` ago: a live load then checks reachability at once instead of after a grace period.
 */
export function recentlyUnreachable(maxAgeMs = 120_000): boolean {
  return !!lastProbe && !lastProbe.ok && clockMs() - lastProbe.at < maxAgeMs;
}

/** Test hook: forget the latest probe answer. */
export function resetProbeMemory(): void {
  lastProbe = null;
}

/**
 * A live load failed because the data services could not be reached (offline, dead wifi): an expected condition the UI
 * explains, not a bug.
 */
export function isUnreachableFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg === ELEVATION_UNREACHABLE_MESSAGE || isNetworkFailure(e);
}

/** Message of a live load that could not reach the elevation service at all (the UI maps it to its offline help). */
export const ELEVATION_UNREACHABLE_MESSAGE =
  'Can’t reach the elevation service (USGS 3DEP / Terrarium): the network looks down or very slow. Check the connection, or pick a built-in scenario — they work offline.';
