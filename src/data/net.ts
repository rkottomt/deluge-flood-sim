/**
 * Network helpers: fetch with timeout, retries with exponential backoff, and detection of ArcGIS errors
 * (ArcGIS REST endpoints often answer HTTP 200 with a JSON `{ error: ... }` body).
 * Works in browsers and Node ≥ 18 (global fetch / AbortController).
 */

export interface FetchOptions {
  /** Per-attempt timeout, ms. */
  timeoutMs?: number;
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

async function attempt(url: string, opts: FetchOptions): Promise<{ buf: ArrayBuffer; type: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('timeout')), opts.timeoutMs ?? 45000);
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new HttpError(`${hostOf(url)} responded HTTP ${res.status}`, res.status);
    const type = res.headers.get('content-type') ?? '';
    const buf = await res.arrayBuffer();
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
    if (ctrl.signal.aborted && !opts.signal?.aborted) throw new Error(`${hostOf(url)} timed out after ${opts.timeoutMs ?? 45000} ms`);
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

export const isBrowser = typeof document !== 'undefined' && typeof window !== 'undefined';
