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

test('elevation services unreachable (wifi off): a clear network message, not "open water"', async () => {
  const { merc } = squareDomain({ lat: 40.44, lon: -80 }, 2000);
  const offline = (() => Promise.reject(new TypeError('Failed to fetch'))) as typeof fetch;
  const msg = await withFetch(offline, () => fetchDEM(merc, 64, 64, 2000 / 64).then(() => 'loaded', (e: Error) => e.message));
  assert.equal(msg, ELEVATION_UNREACHABLE_MESSAGE);
  assert.match(msg, /Can.t reach the elevation service/);
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
