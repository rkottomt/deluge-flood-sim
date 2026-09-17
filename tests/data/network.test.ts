/**
 * Live-area robustness on bad networks (no GPU, no browser): stalled downloads fail fast, network-level failures are
 * reported as "can't reach the service" (not "open water"), a live load can be cancelled, and live areas get place
 * names instead of raw coordinates.
 * Run: node --import tsx --test tests/data/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchDEM } from '../../src/data/dem';
import { squareDomain } from '../../src/data/geo';
import { loadLiveArea } from '../../src/data/live';
import { ELEVATION_UNREACHABLE_MESSAGE, fetchBytes, HttpError, isNetworkFailure } from '../../src/data/net';
import { coordinateName, isCoordinateName, placeNameFromNominatim } from '../../src/data/placeName';

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** A fetch that never answers (dead venue wifi), honouring abort. */
const hangingFetch = ((_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const s = init?.signal;
    if (s?.aborted) return reject(s.reason);
    s?.addEventListener('abort', () => reject(s.reason ?? new DOMException('aborted', 'AbortError')));
  })) as typeof fetch;

test('network failures are told apart from answers: TypeErrors, timeouts and stalls vs HTTP errors', () => {
  assert.ok(isNetworkFailure(new TypeError('Failed to fetch')));
  assert.ok(isNetworkFailure(new Error('elevation.nationalmap.gov timed out after 45 s')));
  assert.ok(isNetworkFailure(new Error('x timed out: the download stalled for 20 s')));
  assert.ok(!isNetworkFailure(new HttpError('HTTP 404', 404)));
  assert.ok(!isNetworkFailure(new Error('This area is open water')));
});

test('a download whose body stalls fails after stallMs, while a slow but moving one completes', async () => {
  const stalled = ((_i: unknown, init?: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]));
        init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
      },
    });
    return Promise.resolve(new Response(body));
  }) as typeof fetch;
  const t0 = performance.now();
  const err = await withFetch(stalled, () => fetchBytes('https://example.test/a', { stallMs: 150, retries: 0 }).then(() => null, (e: Error) => e));
  assert.ok(err && /stalled/.test(err.message), `stall reported: ${err?.message}`);
  assert.ok(performance.now() - t0 < 2000, 'fails fast');
  assert.ok(isNetworkFailure(err));

  const slow = (() => {
    let n = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(c) {
        await new Promise((r) => setTimeout(r, 60));
        if (n++ < 5) c.enqueue(new Uint8Array([n]));
        else c.close();
      },
    });
    return Promise.resolve(new Response(body));
  }) as typeof fetch;
  const buf = await withFetch(slow, () => fetchBytes('https://example.test/b', { stallMs: 150, retries: 0 }));
  assert.deepEqual([...new Uint8Array(buf)], [1, 2, 3, 4, 5], '300 ms total at 60 ms per chunk is not a stall');
});

test('elevation services unreachable (wifi off): a clear network message, not "open water"', async (t) => {
  // The 3DEP → Terrarium fallback logs a warning with the network error's stack; capture it (restored after the test)
  // so a passing run prints no stack trace, and check the fallback was really taken.
  const warn = t.mock.method(console, 'warn', () => {});
  const { merc } = squareDomain({ lat: 40.44, lon: -80 }, 2000);
  const offline = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  const msg = await withFetch(offline, () => fetchDEM(merc, 64, 64, 2000 / 64).then(() => 'loaded', (e: Error) => e.message));
  assert.equal(msg, ELEVATION_UNREACHABLE_MESSAGE);
  assert.match(msg, /Can.t reach the elevation service/);
  assert.ok(
    warn.mock.calls.some((c) => /falling back to Terrarium/.test(String(c.arguments[0]))),
    `expected the Terrarium fallback warning, got ${JSON.stringify(warn.mock.calls.map((c) => String(c.arguments[0])))}`,
  );
});

test('a live load on a network that never answers can be cancelled at once', async () => {
  const ctrl = new AbortController();
  const t0 = performance.now();
  const outcome = withFetch(hangingFetch, () =>
    loadLiveArea({ center: { lat: 40.0, lon: -105.27 }, sizeMeters: 2000, resolution: 512 }, undefined, ctrl.signal).then(
      () => 'loaded',
      (e: unknown) => (ctrl.signal.aborted && e === ctrl.signal.reason ? 'cancelled' : `failed: ${String(e)}`),
    ),
  );
  setTimeout(() => ctrl.abort(new Error('user cancelled')), 50);
  assert.equal(await outcome, 'cancelled');
  assert.ok(performance.now() - t0 < 1000, `cancel took ${(performance.now() - t0).toFixed(0)} ms`);
});

test('live areas are named like places: Nominatim "City, State", otherwise a readable coordinate label', () => {
  assert.equal(placeNameFromNominatim({ address: { city: 'New Orleans', state: 'Louisiana', country: 'United States' } }), 'New Orleans, Louisiana');
  assert.equal(placeNameFromNominatim({ address: { village: 'Adak', state: 'Alaska' } }), 'Adak, Alaska');
  assert.equal(placeNameFromNominatim({ address: { county: 'Boulder County', state: 'Colorado' } }), 'Boulder County, Colorado');
  assert.equal(placeNameFromNominatim({ display_name: 'Somewhere, Far, Away' }), 'Somewhere, Far');
  assert.equal(placeNameFromNominatim(null), '');
  assert.equal(coordinateName(29.95, -90.07), 'Area near 29.950° N, 90.070° W');
  for (const raw of ['29.9500°, -90.0700°', '29.950, -90.070', '', undefined]) assert.ok(isCoordinateName(raw), String(raw));
  for (const nm of ['Harrisburg, Pennsylvania', 'Asheville NC', 'Area 51']) assert.ok(!isCoordinateName(nm), nm);
});

test('offline: a live load fails at once when the browser reports no network, and within a moment after an unreachable probe', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { browserOffline, probeReachable, recentlyUnreachable, resetProbeMemory } = await import('../../src/data/net');
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const setOnline = (onLine: boolean) => Object.defineProperty(globalThis, 'navigator', { value: { onLine }, configurable: true, writable: true });
  try {
    // navigator.onLine false: no request is even made.
    setOnline(false);
    assert.ok(browserOffline());
    let fetched = 0;
    const counting = (() => {
      fetched++;
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as typeof fetch;
    const t0 = performance.now();
    const msg = await withFetch(counting, () =>
      loadLiveArea({ center: { lat: 29.76, lon: -95.37 }, sizeMeters: 2000, resolution: 512 }).then(() => 'loaded', (e: Error) => e.message),
    );
    assert.equal(msg, ELEVATION_UNREACHABLE_MESSAGE);
    assert.equal(fetched, 0, 'no download attempted');
    assert.ok(performance.now() - t0 < 200, `took ${(performance.now() - t0).toFixed(0)} ms`);

    // "Online" but the page's probe just found the data hosts unreachable (the picker's "You're offline"): the load
    // checks at once instead of after LIVE_DEM_PROBE_MS, even while the downloads hang.
    setOnline(true);
    resetProbeMemory();
    assert.equal(recentlyUnreachable(), false);
    assert.equal(await withFetch(hangingFetch, () => probeReachable(['https://example.test/probe'], 50)), false);
    assert.ok(recentlyUnreachable());
    const t1 = performance.now();
    const msg2 = await withFetch(hangingFetch, () =>
      loadLiveArea({ center: { lat: 29.76, lon: -95.37 }, sizeMeters: 2000, resolution: 512 }).then(() => 'loaded', (e: Error) => e.message),
    );
    assert.equal(msg2, ELEVATION_UNREACHABLE_MESSAGE);
    assert.ok(performance.now() - t1 < 4500, `gave up after ${(performance.now() - t1).toFixed(0)} ms (probe timeout 3 s)`);
    resetProbeMemory();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'navigator', desc);
    else delete (globalThis as { navigator?: unknown }).navigator;
  }
});

test('unreachable live loads are told apart from other load failures', async () => {
  const { isUnreachableFailure } = await import('../../src/data/net');
  assert.ok(isUnreachableFailure(new Error(ELEVATION_UNREACHABLE_MESSAGE)));
  assert.ok(isUnreachableFailure(new TypeError('Failed to fetch')));
  assert.ok(!isUnreachableFailure(new Error('This area is open water')));
  assert.ok(!isUnreachableFailure(new HttpError('HTTP 500', 500)));
});
