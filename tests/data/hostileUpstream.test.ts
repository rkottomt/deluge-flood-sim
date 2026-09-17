/// <reference types="node" />
/**
 * Hostile or broken upstreams must cost a fallback, never the tab (FINDINGS.json SEC-03 and SEC-10).
 *
 * Every byte the app decodes comes from a third party it cannot authenticate: USGS, Esri, AWS S3, TIGERweb, the OSM
 * API, Nominatim. A compromised or merely misbehaving one could answer with an endless body, a 300 kB PNG that
 * inflates to gigabytes, a compressed TIFF, or coordinates that are `null`/`1e999`. The demo laptop has 16 GB and no
 * fan; an out-of-memory tab mid-pitch is unrecoverable, and a NaN that reaches the routing graph poisons every route.
 *
 * These tests use loopback-free fake `fetch` implementations (no sockets, no network) and hand-built PNG/TIFF bytes.
 *
 * Run: node --import tsx --test tests/data/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoadNetwork, classifyMTFCC, classifyOSMHighway, decodeRoads, encodeRoads, parseOSMXml, type RawRoad } from '../../src/data/roads';
import { decodeTiffF32 } from '../../src/data/dem';
import { decodePNG } from '../../src/data/png';
import { DEFAULT_MAX_BYTES, HttpError, MB, fetchBytes, fetchJSON, isNetworkFailure } from '../../src/data/net';
import { makeGeoToGrid, squareDomain } from '../../src/data/geo';

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

/** A response that streams `chunk` for ever (an upstream that never stops sending). Counts attempts and chunks. */
function endlessFetch(counters: { attempts: number; chunks: number }, chunk = new Uint8Array(64 * 1024)) {
  return ((_i: unknown, init?: RequestInit) => {
    counters.attempts++;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        counters.chunks++;
        c.enqueue(chunk.slice());
      },
      cancel() {},
    });
    init?.signal?.addEventListener('abort', () => {});
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'application/octet-stream' } }));
  }) as typeof fetch;
}

// ─── SEC-03: response byte caps ─────────────────────────────────────────────────────────────────

test('an endless response body is cut off at maxBytes and never retried', async () => {
  const counters = { attempts: 0, chunks: 0 };
  const err = await withFetch(endlessFetch(counters), () =>
    // retries: 2 — a size failure must NOT be one of the retryable ones, or a hostile upstream gets three goes at
    // filling memory instead of one.
    fetchBytes('https://example.test/big', { maxBytes: MB, retries: 2, timeoutMs: 5000 }).then(() => null, (e: Error) => e),
  );
  assert.ok(err instanceof HttpError, `expected HttpError, got ${err}`);
  assert.equal(err.status, 413);
  assert.match(err.message, /more than 1 MB/);
  assert.equal(counters.attempts, 1, 'exactly one attempt: the cap must not trigger a retry storm');
  // The reader is cancelled as soon as the cap is passed, so only a little over the cap is ever in memory.
  assert.ok(counters.chunks <= MB / (64 * 1024) + 2, `${counters.chunks} chunks read for a 1 MB cap`);
  // It is an upstream answer, not a network fault: the app must not report "can't reach the service".
  assert.ok(!isNetworkFailure(err));
});

test('a declared Content-Length over the cap is refused without draining the body', async () => {
  let pulls = 0;
  let cancelled = false;
  const lying = (() => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        pulls++;
        c.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    return Promise.resolve(new Response(body, { headers: { 'content-length': String(500 * MB), 'content-type': 'image/png' } }));
  }) as typeof fetch;
  const err = await withFetch(lying, () => fetchBytes('https://example.test/huge', { maxBytes: 4 * MB, retries: 0 }).then(() => null, (e: Error) => e));
  assert.ok(err instanceof HttpError && err.status === 413, `${err}`);
  // A ReadableStream primes its own one-chunk queue on construction, so one pull is the stream, not the reader. What
  // matters is that nothing loops: the header alone decided it, and the body was cancelled.
  assert.ok(pulls <= 1, `${pulls} pulls — the body was being drained`);
  assert.ok(cancelled, 'the body is cancelled so the socket is released');
});

test('a body within the cap is returned untouched, and the default cap is a sane ceiling', async () => {
  const payload = new Uint8Array(300 * 1024).fill(7);
  const ok = (() => Promise.resolve(new Response(payload))) as typeof fetch;
  const buf = await withFetch(ok, () => fetchBytes('https://example.test/ok', { maxBytes: MB, retries: 0 }));
  assert.equal(buf.byteLength, payload.length);
  assert.deepEqual(new Uint8Array(buf).slice(0, 4), payload.slice(0, 4));
  // Every call site names its own smaller cap; the default only exists so a new one is bounded too.
  assert.ok(DEFAULT_MAX_BYTES > 0 && DEFAULT_MAX_BYTES <= 256 * MB, `${DEFAULT_MAX_BYTES} bytes`);
});

test('fetchJSON is capped too: a geocoder that answers for ever fails instead of filling memory', async () => {
  const counters = { attempts: 0, chunks: 0 };
  const endlessJson = endlessFetch(counters, new TextEncoder().encode(`${'{"a":1},'.repeat(4096)}`));
  const err = await withFetch(endlessJson, () =>
    fetchJSON('https://example.test/search?q=x', { maxBytes: MB, retries: 0, timeoutMs: 5000 }).then(() => null, (e: Error) => e),
  );
  assert.ok(err instanceof HttpError && err.status === 413, `${err}`);
});

// ─── SEC-03: decoder output caps ────────────────────────────────────────────────────────────────

/** A PNG chunk: length, type, body, and a CRC the decoder does not check (it never trusts the bytes anyway). */
function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

/** A PNG whose IHDR says `width`×`height` RGBA8 but whose IDAT inflates to `rawBytes` of zeroes. */
async function pngWithOversizedIdat(width: number, height: number, rawBytes: number): Promise<Uint8Array> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const deflated = new Uint8Array(
    await new Response(new Blob([new Uint8Array(rawBytes)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer(),
  );
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflated),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  return png;
}

test('a PNG deflate bomb is rejected at the size its own header promises', async () => {
  // A 256² Terrarium tile inflates to (256·4+1)·256 = 262,400 bytes. This one hides 64 MB of zeroes in ~64 kB.
  const bomb = await pngWithOversizedIdat(256, 256, 64 * MB);
  assert.ok(bomb.length < 200 * 1024, `the bomb is only ${(bomb.length / 1024).toFixed(0)} kB on the wire`);
  const t0 = performance.now();
  await assert.rejects(decodePNG(bomb), /larger than its header says/);
  assert.ok(performance.now() - t0 < 5000, 'it fails quickly rather than inflating the whole payload first');
});

test('a PNG with absurd dimensions is refused before anything is inflated', async () => {
  // 65535² RGBA would be 17 GB of output, and the header alone is enough to know that.
  const huge = await pngWithOversizedIdat(65535, 65535, 1024);
  await assert.rejects(decodePNG(huge), /unsupported PNG size 65535×65535/);
  await assert.rejects(decodePNG(await pngWithOversizedIdat(0, 256, 16)), /unsupported PNG size/);
  await assert.rejects(decodePNG(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /not a PNG/);
});

test('a well-formed Terrarium-sized PNG still decodes (the cap is not too tight)', async () => {
  const w = 256;
  const h = 256;
  const raw = new Uint8Array((w * 4 + 1) * h); // one filter byte per row, filter 0, all-zero pixels
  const deflated = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflated), pngChunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    png.set(p, o);
    o += p.length;
  }
  const out = await decodePNG(png);
  assert.equal(out.width, 256);
  assert.equal(out.height, 256);
  assert.equal(out.data.length, 256 * 256 * 4);
});

/** A minimal little-endian TIFF, 4×4 float32, with the given Compression tag value. */
function tiffWithCompression(compression: number): ArrayBuffer {
  const nx = 4;
  const ny = 4;
  const bytes = nx * ny * 4;
  const tags: Array<[number, number, number]> = [
    [0x0100, 3, nx], // ImageWidth
    [0x0101, 3, ny], // ImageLength
    [0x0102, 3, 32], // BitsPerSample
    [0x0103, 3, compression], // Compression
    [0x0106, 3, 1], // PhotometricInterpretation
    [0x0111, 4, 0], // StripOffsets (patched to the pixel data below)
    [0x0115, 3, 1], // SamplesPerPixel
    [0x0116, 4, ny], // RowsPerStrip
    [0x0117, 4, bytes], // StripByteCounts
    [0x0153, 3, 3], // SampleFormat = IEEE float
  ];
  const ifdOff = 8;
  const dataOff = ifdOff + 2 + tags.length * 12 + 4;
  const buf = new ArrayBuffer(dataOff + bytes);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true); // little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdOff, true);
  dv.setUint16(ifdOff, tags.length, true);
  tags.forEach(([tag, type, value], i) => {
    const o = ifdOff + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, 1, true);
    const v = tag === 0x0111 ? dataOff : value;
    if (type === 3) dv.setUint16(o + 8, v, true);
    else dv.setUint32(o + 8, v, true);
  });
  dv.setUint32(ifdOff + 2 + tags.length * 12, 0, true);
  for (let i = 0; i < nx * ny; i++) dv.setFloat32(dataOff + i * 4, 250 + i, true);
  return buf;
}

test('a compressed DEM TIFF is refused; the uncompressed one 3DEP sends decodes', async () => {
  // The request asks for &compression=None (src/data/dem.ts). Anything else means the service changed or is being
  // impersonated, and LZW/Deflate/LERC would inflate an attacker-chosen amount from a small body.
  for (const [code, name] of [
    [5, 'LZW'],
    [8, 'Deflate'],
    [32946, 'Deflate (old tag)'],
    [34887, 'LERC'],
  ] as Array<[number, string]>) {
    await assert.rejects(
      decodeTiffF32(tiffWithCompression(code), 4, 4),
      new RegExp(`uses compression ${code}`),
      `${name} (${code}) was accepted`,
    );
  }
  // Compression 1 is "none": this must still decode, or every live area breaks.
  const out = await decodeTiffF32(tiffWithCompression(1), 4, 4);
  assert.equal(out.length, 16);
  assert.equal(out[0], 250);
  assert.equal(out[15], 265);
});

// ─── SEC-10: road parser robustness ─────────────────────────────────────────────────────────────

test('OSM XML: nodes with unusable positions are skipped, not stored as NaN', () => {
  const xml = `<osm>
    <node id="1" lat="40.440" lon="-80.000"/>
    <node id="2" lat="40.441" lon="-79.999"/>
    <node id="3" lat="nonsense" lon="-79.998"/>
    <node id="4" lat="" lon="-79.997"/>
    <node id="5" lat="1e999" lon="-79.996"/>
    <node id="6" lat="999" lon="-79.995"/>
    <node id="7" lat="40.443" lon="-400"/>
    <node id="8" lat="40.444" lon="-79.993"/>
    <way id="100"><nd ref="1"/><nd ref="3"/><nd ref="5"/><nd ref="7"/><nd ref="8"/><tag k="highway" v="residential"/></way>
  </osm>`;
  const roads = parseOSMXml(xml);
  assert.equal(roads.length, 1, 'the way survives; only its bad vertices are dropped');
  for (const [lon, lat] of roads[0].coords) {
    assert.ok(Number.isFinite(lon) && Number.isFinite(lat), `non-finite vertex ${lon},${lat}`);
    assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90, `out-of-range vertex ${lon},${lat}`);
  }
  assert.deepEqual(roads[0].coords, [
    [-80, 40.44],
    [-79.993, 40.444],
  ]);
});

test('OSM XML: a tag named __proto__ or constructor cannot change what the parser reads', () => {
  // With a plain `{}` for tags, `<tag k="constructor">` leaves tags.highway resolving through Object.prototype and a
  // road with no highway tag can be misclassified — or `tags.__proto__` can be made to swallow the assignment.
  const xml = `<osm>
    <node id="1" lat="40.440" lon="-80.000"/><node id="2" lat="40.441" lon="-79.999"/>
    <way id="1"><nd ref="1"/><nd ref="2"/><tag k="__proto__" v="{&quot;highway&quot;:&quot;motorway&quot;}"/></way>
    <way id="2"><nd ref="1"/><nd ref="2"/><tag k="constructor" v="motorway"/></way>
    <way id="3"><nd ref="1"/><nd ref="2"/><tag k="hasOwnProperty" v="motorway"/></way>
    <way id="4"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/></way>
  </osm>`;
  const roads = parseOSMXml(xml);
  assert.equal(roads.length, 1, 'only the real highway way becomes a road');
  assert.equal(roads[0].cls, 'local', 'highway=residential is the "local" class');
  assert.equal(({} as Record<string, unknown>).highway, undefined, 'Object.prototype is untouched');
});

test('OSM XML: entity decoding survives junk without dropping the response', () => {
  const xml = `<osm>
    <node id="1" lat="40.440" lon="-80.000"/><node id="2" lat="40.441" lon="-79.999"/>
    <way id="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/>
      <tag k="name" v="Main &amp; Vine &#x110000; &#999999999; &notanentity; &#x41;"/></way>
  </osm>`;
  const roads = parseOSMXml(xml);
  assert.equal(roads.length, 1);
  // Valid entities decode; out-of-range code points and unknown names stay literal instead of throwing.
  assert.equal(roads[0].name, 'Main & Vine &#x110000; &#999999999; &notanentity; A');
  // An entity naming an Object.prototype member is not looked up on a prototype chain.
  const proto = parseOSMXml(`<osm><node id="1" lat="40.44" lon="-80"/><node id="2" lat="40.441" lon="-79.999"/>
    <way id="1"><nd ref="1"/><nd ref="2"/><tag k="highway" v="residential"/><tag k="name" v="&constructor; &toString;"/></way></osm>`);
  assert.equal(proto[0].name, '&constructor; &toString;');
});

test('OSM XML: an empty or malformed document yields no roads rather than throwing', () => {
  for (const xml of ['', '<osm></osm>', 'not xml at all', '<osm><way id="1"><nd ref="missing"/></way></osm>', '<osm><node id="1"/></osm>']) {
    assert.deepEqual(parseOSMXml(xml), [], JSON.stringify(xml.slice(0, 30)));
  }
});

test('road classification ignores prototype members and unknown codes', () => {
  assert.equal(classifyMTFCC('S1100'), 'highway');
  assert.equal(classifyOSMHighway('residential'), 'local');
  for (const junk of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'S9999', '', undefined]) {
    assert.equal(classifyMTFCC(junk as string | undefined), null, `classifyMTFCC(${junk})`);
    assert.equal(classifyOSMHighway(junk as string | undefined), null, `classifyOSMHighway(${junk})`);
  }
});

test('buildRoadNetwork drops vertices that do not project to a finite grid point', () => {
  const N = 128;
  const CELL = 10;
  const { bounds } = squareDomain({ lat: 40.44, lon: -80.0 }, N * CELL);
  const grid = { nx: N, ny: N, cellSize: CELL, toGrid: makeGeoToGrid({ nx: N, ny: N, bounds }) };
  // A road whose middle vertex is non-finite: its neighbours must simply join up, and nothing may reach the graph
  // as NaN (a single NaN node poisons snapping, clipping and every route computed afterwards).
  const roads: RawRoad[] = [
    {
      cls: 'local',
      coords: [
        [-80.002, 40.438],
        [Number.NaN, 40.439],
        [-79.998, 40.442],
      ] as Array<[number, number]>,
    },
    {
      cls: 'local',
      coords: [
        [-80.002, 40.442],
        [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
        [-79.998, 40.438],
      ] as Array<[number, number]>,
    },
  ];
  const net = buildRoadNetwork(roads, grid);
  assert.ok(net.nodes.length > 0, 'the roads still produce a graph');
  for (const v of net.nodes) assert.ok(Number.isFinite(v), `non-finite node coordinate ${v}`);
  for (const e of net.edges) {
    assert.ok(Number.isFinite(e.length) && e.length > 0, `bad edge length ${e.length}`);
    for (const v of e.pts) assert.ok(Number.isFinite(v), `non-finite polyline point ${v}`);
  }
  // The compact encoding a preset is baked from must round-trip the same finite values.
  const back = decodeRoads(encodeRoads(net));
  for (const v of back.nodes) assert.ok(Number.isFinite(v));
});
