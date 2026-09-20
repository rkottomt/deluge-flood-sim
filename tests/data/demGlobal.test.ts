/// <reference types="node" />
/**
 * The global elevation path (src/data/demGlobal.ts): Copernicus GLO-30 tile geometry, and the DSM → bare-earth filter.
 *
 * WHAT IS TESTED WHERE, because the split is deliberate:
 *   • Tile naming and the virtual sample grid are pure arithmetic, and they are where a mosaic silently misplaces
 *     terrain by half a pixel or a whole degree — so they are checked exhaustively here.
 *   • The filter is checked on synthetic ground whose truth is known exactly: a plane must survive, a hill must
 *     survive, a building must not. Its accuracy against real lidar is a separate measurement over four US domains
 *     (artifacts/nepal-build/validate-global.ts bareearth, out-bareearth-padded.txt) — a unit test cannot tell you
 *     that a filter is 2 m biased under a hardwood canopy, and it is not asked to.
 *   • The reader's REFUSALS are tested against a stubbed range server. What is not tested here is a full two-tile
 *     mosaic read: a GLO-30 tile is 3600² Float32, so a synthetic pair would allocate ~100 MB inside the test to
 *     re-check arithmetic already covered above. The real stitch is verified end to end on the baked product instead
 *     (the seam test at the bottom of this file).
 *
 * Offline: no test here touches the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { writeArrayBuffer } from 'geotiff';
import {
  BARE_EARTH_ALGO_VERSION,
  BARE_EARTH_DEFAULTS,
  bareEarthFromSurface,
  COPERNICUS_DEM_30M_BASE,
  COPERNICUS_DEM_ATTRIBUTION,
  COPERNICUS_SAMPLES_PER_DEGREE,
  copernicusTileId,
  copernicusTilesCovering,
  copernicusTileUrl,
  fetchCopernicusDEM,
  globalSampleIndex,
  morphologicalOpening,
} from '../../src/data/demGlobal';
import { lonLatToMercator, mercatorToLonLat, squareDomain } from '../../src/data/geo';

const CELL = 7.8125; // the 8 km / 1024 grid every baked preset uses

test('GLO-30 tile ids follow the AWS Open Data naming, in every hemisphere', () => {
  // The Betrawati domain's two tiles, as the bake recorded them.
  assert.equal(copernicusTileId(27.99, 85.186), 'Copernicus_DSM_COG_10_N27_00_E085_00_DEM');
  assert.equal(copernicusTileId(28.01, 85.186), 'Copernicus_DSM_COG_10_N28_00_E085_00_DEM');
  // Three digits of longitude, two of latitude, always the floor — which for negatives is the SOUTH/WEST neighbour.
  assert.equal(copernicusTileId(40.44, -79.99), 'Copernicus_DSM_COG_10_N40_00_W080_00_DEM');
  assert.equal(copernicusTileId(0.5, 0.5), 'Copernicus_DSM_COG_10_N00_00_E000_00_DEM');
  assert.equal(copernicusTileId(-33.87, 151.21), 'Copernicus_DSM_COG_10_S34_00_E151_00_DEM');
  assert.equal(copernicusTileId(-0.2, -0.2), 'Copernicus_DSM_COG_10_S01_00_W001_00_DEM');
  // The URL repeats the id as the directory, which is the bucket's layout.
  const id = copernicusTileId(27.99, 85.186);
  assert.equal(copernicusTileUrl(id), `${COPERNICUS_DEM_30M_BASE}/${id}/${id}.tif`);
  assert.ok(COPERNICUS_DEM_30M_BASE.startsWith('https://'), 'no plaintext bucket');
  // The licence credit travels with the endpoint so a preset's attribution cannot drift from it.
  assert.match(COPERNICUS_DEM_ATTRIBUTION, /Copernicus DEM GLO-30/);
  assert.match(COPERNICUS_DEM_ATTRIBUTION, /ESA/);
});

test('the covering tile list includes every 1° cell a box touches, seams included', () => {
  const one = copernicusTilesCovering({ west: 85.14, east: 85.22, south: 27.95, north: 27.99 });
  assert.deepEqual(one.map((t) => t.id), ['Copernicus_DSM_COG_10_N27_00_E085_00_DEM']);

  // The Betrawati domain straddles 28° N: two tiles, south-west corner first.
  const nepal = copernicusTilesCovering({ west: 85.1453, east: 85.2267, south: 27.9541, north: 28.0259 });
  assert.deepEqual(nepal.map((t) => t.id), [
    'Copernicus_DSM_COG_10_N27_00_E085_00_DEM',
    'Copernicus_DSM_COG_10_N28_00_E085_00_DEM',
  ]);
  assert.deepEqual(nepal.map((t) => [t.latFloor, t.lonFloor]), [[27, 85], [28, 85]]);

  // A box over both a latitude and a longitude line needs all four.
  const corner = copernicusTilesCovering({ west: 84.98, east: 85.02, south: 27.98, north: 28.02 });
  assert.equal(corner.length, 4);
  assert.deepEqual(new Set(corner.map((t) => t.id)).size, 4);
  for (const t of corner) assert.equal(t.id, copernicusTileId(t.latFloor + 0.5, t.lonFloor + 0.5), 'id matches its own corner');
});

test('the virtual sample grid is PixelIsPoint at 3600/degree, and tiles abut on it without overlap', () => {
  assert.equal(COPERNICUS_SAMPLES_PER_DEGREE, 3600, '1 arc-second posting');
  // Whole degrees land exactly on a sample: that is what PixelIsPoint means, and it is why two tiles can be
  // mosaicked by index instead of resampled.
  const a = globalSampleIndex(85, 28);
  assert.equal(a.i, 85 * 3600);
  assert.equal(a.j, (90 - 28) * 3600);
  assert.equal(Number.isInteger(a.i) && Number.isInteger(a.j), true);
  // One sample is one arc-second, in both axes, and j counts SOUTH from 90 N.
  const b = globalSampleIndex(85 + 1 / 3600, 28 - 1 / 3600);
  assert.ok(Math.abs(b.i - (a.i + 1)) < 1e-6, `${b.i} vs ${a.i + 1}`);
  assert.ok(Math.abs(b.j - (a.j + 1)) < 1e-6, `${b.j} vs ${a.j + 1}`);
  assert.ok(globalSampleIndex(0, 89.9).j < globalSampleIndex(0, 0).j, 'j grows southwards');

  /*
   * The seam. A GLO-30 tile is 3600 samples for a degree that contains 3601 sample lines, so the tiles cannot both
   * own the line at the shared degree: N27_00 covers latitudes (27, 28] — its row 0 IS 28.0 N — and N28_00 covers
   * (28, 29], its last row sitting one arc-second above 28.0. Get this off by one and the mosaic doubles or drops a
   * row at every tile boundary. These are the indices the reader computes from `tileSampleOrigin`.
   */
  const rowOf = (lat: number) => globalSampleIndex(0, lat).j;
  const n27row0 = (89 - 27) * 3600;
  const n28row3599 = (89 - 28) * 3600 + 3599;
  assert.equal(rowOf(28), n27row0, 'the N27 tile owns the 28.0 N line');
  assert.equal(n28row3599, n27row0 - 1, 'the N28 tile stops exactly one sample above it: contiguous, no overlap');
  assert.ok(Math.abs(rowOf(28 + 1 / 3600) - n28row3599) < 1e-6);
});

/** A tilted plane: the surface the filter must return untouched, however steep. */
function plane(nx: number, ny: number, slope: number, base = 600): Float32Array {
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = base + slope * i * CELL;
  return z;
}

test('opening is exact on a plane — at the border as well as the middle', () => {
  /*
   * The filter's whole claim is that what it flags is convexity, not slope, and that rests on opening being the
   * identity on planar ground. It is — but only because the input is padded by extrapolating the edge gradient.
   * Unpadded, the window truncates at the boundary, the opened surface drops below the plane at the upslope edge,
   * and the threshold reads a perfect plane as a row of buildings (measured: 1.95 % of a 256² domain on a 0.30
   * slope, up to the full 12 m maxDrop removed). This test is that regression.
   */
  for (const slope of [0, 0.02, 0.15, 0.3, 0.6]) {
    const nx = 96;
    const ny = 64;
    const z = plane(nx, ny, slope);
    for (const r of [1, 2, 4, 8]) {
      const open = morphologicalOpening(z, nx, ny, r);
      let worst = 0;
      let worstAt = -1;
      for (let k = 0; k < z.length; k++) {
        const d = Math.abs(open[k] - z[k]);
        if (d > worst) {
          worst = d;
          worstAt = k;
        }
      }
      assert.ok(worst < 1e-3, `slope ${slope}, r=${r}: opening moved cell ${worstAt % nx},${(worstAt / nx) | 0} by ${worst.toFixed(3)} m`);
    }
    const bare = bareEarthFromSurface(z, nx, ny, { cellSize: CELL });
    assert.equal(bare.removedFraction, 0, `slope ${slope}: a plane has nothing on it`);
    for (let k = 0; k < z.length; k++) assert.equal(bare.ground[k], z[k]);
  }
});

test('opening removes what sits on the ground and keeps the ground', () => {
  const nx = 64;
  const ny = 64;
  const z = plane(nx, ny, 0.05);
  const truth = Float32Array.from(z);
  for (let j = 30; j < 34; j++) for (let i = 30; i < 34; i++) z[j * nx + i] += 9; // 31 m wide, 9 m tall
  const open = morphologicalOpening(z, nx, ny, 4); // 31 m half-width erases a 31 m object
  for (let k = 0; k < z.length; k++) assert.ok(Math.abs(open[k] - truth[k]) < 1e-3, `cell ${k}: ${open[k]} vs ${truth[k]}`);
  // A structuring element smaller than the object leaves its middle standing — which is why the filter sweeps r.
  const small = morphologicalOpening(z, nx, ny, 1);
  assert.ok(small[32 * nx + 32] > truth[32 * nx + 32] + 8, 'r=1 cannot reach the middle of a 4-cell block');
});

test('the bare-earth filter takes off buildings and canopy, leaves terrain, and clamps how far it may cut', () => {
  const nx = 256;
  const ny = 256;
  const bare = (z: Float32Array) => bareEarthFromSurface(z, nx, ny, { cellSize: CELL });
  // Ground: a gentle slope with a broad 60 m hill on it — real terrain, convex, and 3 km wide.
  const ground = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const dx = (i - 128) * CELL;
      const dy = (j - 128) * CELL;
      ground[j * nx + i] = 600 + 0.05 * i * CELL + 60 * Math.exp(-(dx * dx + dy * dy) / (2 * 400 * 400));
    }
  }
  const clean = bare(ground);
  assert.equal(clean.removedFraction, 0, 'a hill is not an object');

  const surface = Float32Array.from(ground);
  for (let j = 40; j < 46; j++) for (let i = 40; i < 46; i++) surface[j * nx + i] += 8; // village block, 47 m, 8 m tall
  for (let j = 150; j < 170; j++) for (let i = 150; i < 170; i++) surface[j * nx + i] += 14; // canopy patch, 156 m
  for (let j = 200; j < 203; j++) for (let i = 60; i < 63; i++) surface[j * nx + i] += 40; // a 40 m tower
  const r = bare(surface);

  // Bare earth is never above the surface, and never more than maxDrop below it.
  for (let k = 0; k < surface.length; k++) {
    assert.ok(r.ground[k] <= surface[k] + 1e-4, `cell ${k} is above the surface`);
    assert.ok(surface[k] - r.ground[k] <= BARE_EARTH_DEFAULTS.maxDrop + 1e-4, `cell ${k} cut by ${(surface[k] - r.ground[k]).toFixed(1)} m`);
  }
  // The reported statistics describe the mask they came with.
  const flagged = r.objectMask.reduce((a: number, b) => a + b, 0);
  assert.ok(Math.abs(r.removedFraction - flagged / surface.length) < 1e-9);
  assert.ok(r.meanRemoved > 0 && r.maxRemoved >= r.meanRemoved);
  assert.deepEqual(r.windows, [8, 16, 31, 63], 'doubling windows up to maxObjectMeters, in ground metres');

  // The objects are found and the hill is not touched.
  const flaggedIn = (i0: number, i1: number, j0: number, j1: number) => {
    let n = 0;
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) n += r.objectMask[j * nx + i];
    return n;
  };
  assert.ok(flaggedIn(40, 46, 40, 46) >= 16, `village block: ${flaggedIn(40, 46, 40, 46)} of 36 cells flagged`);
  assert.equal(flaggedIn(60, 63, 200, 203) > 0, true, 'tower flagged');
  /*
   * The canopy patch is 156 m across and the largest structuring element is 63 m of half-width, so by construction the
   * filter can only reach its RIM: a stand of trees wider than maxObjectMeters looks exactly like a plateau to an
   * opening, and nothing in 30 m radar says otherwise. That is the limitation the docstring states as "it does not
   * invent ground under continuous forest", and it is why the Betrawati scenario text says the valley floor is still
   * about a metre high. Widening the window to cover the patch works, and costs real spurs elsewhere — measured, not
   * guessed: at Boulder's canyon mouth maxObjectMeters 250 turned a 2.97 m MAE against lidar into 3.13.
   */
  const canopyFlagged = flaggedIn(150, 170, 150, 170);
  assert.ok(canopyFlagged > 0 && canopyFlagged < 200, `canopy patch: ${canopyFlagged} of 400 cells flagged — rim only`);
  const wide = bareEarthFromSurface(surface, nx, ny, { cellSize: CELL, maxObjectMeters: 400 });
  let wideFlagged = 0;
  for (let j = 150; j < 170; j++) for (let i = 150; i < 170; i++) wideFlagged += wide.objectMask[j * nx + i];
  assert.ok(wideFlagged > canopyFlagged * 3, `a wide enough window reaches into the patch (${wideFlagged} vs ${canopyFlagged})`);
  assert.equal(flaggedIn(108, 148, 108, 148), 0, 'the hill is terrain');
  // The tower is cut down by metres, but the clamp stops it being cut to the valley floor.
  const towerDrop = surface[201 * nx + 61] - r.ground[201 * nx + 61];
  assert.ok(towerDrop > 6 && towerDrop <= BARE_EARTH_DEFAULTS.maxDrop, `tower dropped ${towerDrop.toFixed(1)} m`);

  /*
   * And the honest half: a 30 m posting smears a 47 m building over a handful of cells, so what is left where the
   * building stood is metres above true ground, not centimetres. The filter is a reduction, not a removal, and the
   * preset text and SOURCES.txt say so rather than claiming a DTM.
   */
  let err = 0;
  let n = 0;
  for (let j = 40; j < 46; j++) for (let i = 40; i < 46; i++) {
    err += Math.abs(r.ground[j * nx + i] - ground[j * nx + i]);
    n++;
  }
  assert.ok(err / n > 1, 'this test would be lying if it claimed the building was fully removed');
  assert.ok(err / n < 6, `residual over the building ${(err / n).toFixed(2)} m`);
});

test('the slope gate refuses to guess on steep ground, and reports how much it skipped', () => {
  const nx = 128;
  const ny = 128;
  const withBuilding = (slope: number) => {
    const z = plane(nx, ny, slope);
    for (let j = 60; j < 66; j++) for (let i = 60; i < 66; i++) z[j * nx + i] += 8;
    return z;
  };
  // Below the gate (0.364 ≈ 20°) the morphology means what the US validation says it means.
  const gentle = bareEarthFromSurface(withBuilding(0.2), nx, ny, { cellSize: CELL });
  assert.ok(gentle.steepFraction < 0.02, `steepFraction ${gentle.steepFraction}`);
  assert.ok(gentle.removedFraction > 0, 'the building is removed on ground the filter understands');

  /*
   * Above it, nothing distinguishes a roof from a spur nose in 30 m radar, so the surface model is left alone. That is
   * the decision that makes this filter defensible in a Himalayan valley, and it costs exactly what it says: on a 35°
   * slope the same building survives untouched. The Betrawati domain is 77 % steeper than 20°.
   */
  const steep = bareEarthFromSurface(withBuilding(0.7), nx, ny, { cellSize: CELL });
  assert.ok(steep.steepFraction > 0.9, `steepFraction ${steep.steepFraction}`);
  assert.equal(steep.removedFraction, 0, 'nothing is flagged above the gate');
  assert.equal(steep.objectMask[63 * nx + 63], 0, 'including the building');

  // The gate is a parameter, not a hard-coded cliff: raising it puts steep ground back in scope.
  const ungated = bareEarthFromSurface(withBuilding(0.7), nx, ny, { cellSize: CELL, slopeGate: 10 });
  assert.equal(ungated.steepFraction, 0);
  assert.ok(ungated.removedFraction > 0);
  assert.equal(BARE_EARTH_DEFAULTS.slopeGate, 0.364, '20°, from artifacts/nepal-build/out-bareearth-nepal.txt');
  assert.ok(BARE_EARTH_ALGO_VERSION >= 2, 'the cache key must change when the filter output does');
});

test('filter options are honoured, and a degenerate grid does not throw', () => {
  const nx = 64;
  const ny = 64;
  const z = plane(nx, ny, 0.05);
  for (let j = 30; j < 36; j++) for (let i = 30; i < 36; i++) z[j * nx + i] += 20;
  const tight = bareEarthFromSurface(z, nx, ny, { cellSize: CELL, maxDrop: 3 });
  let worst = 0;
  for (let k = 0; k < z.length; k++) worst = Math.max(worst, z[k] - tight.ground[k]);
  assert.ok(worst <= 3 + 1e-4, `maxDrop 3 honoured, worst ${worst.toFixed(2)}`);
  // maxObjectMeters caps the window sweep.
  assert.deepEqual(bareEarthFromSurface(z, nx, ny, { cellSize: CELL, maxObjectMeters: 20 }).windows, [8, 16]);
  /*
   * baseThreshold does NOT raise the bar past maxDrop: the per-window threshold is min(maxDrop, dh0 + slope·r·cell), so
   * anything standing more than the clamp above the opened surface is an object whatever dh0 says. Silencing the filter
   * therefore takes both. Worth pinning down, because it is the one place where the clamp changes what gets FLAGGED and
   * not just how far a flagged cell may fall. (With the validated defaults the cap never binds: the coarsest window's
   * allowance is 1 + 0.1·63 = 7.3 m, below the 12 m clamp.)
   */
  assert.ok(bareEarthFromSurface(z, nx, ny, { cellSize: CELL, baseThreshold: 500 }).removedFraction > 0, 'maxDrop still caps the threshold');
  assert.equal(bareEarthFromSurface(z, nx, ny, { cellSize: CELL, baseThreshold: 500, maxDrop: 500 }).removedFraction, 0);
  // 1×N and 1×1 grids: no gradient to extrapolate, no crash.
  assert.equal(bareEarthFromSurface(new Float32Array([5]), 1, 1, { cellSize: CELL }).ground[0], 5);
  const row = bareEarthFromSurface(Float32Array.from([1, 2, 3, 4]), 4, 1, { cellSize: CELL });
  assert.deepEqual([...row.ground], [1, 2, 3, 4]);
});

/** A one-band Float32 GeoTIFF with GLO-30-style georeferencing, served whole through a stubbed range server. */
async function tiffOf(values: Float32Array, width: number, height: number, opts: { lon: number; lat: number; scale: number; rasterType?: number }): Promise<Uint8Array> {
  const buf = await writeArrayBuffer(values as unknown as number[], {
    width,
    height,
    BitsPerSample: [32],
    SampleFormat: [3],
    SamplesPerPixel: 1,
    PhotometricInterpretation: 1,
    ModelTiepoint: [0, 0, 0, opts.lon, opts.lat, 0],
    ModelPixelScale: [opts.scale, opts.scale, 0],
    GTRasterTypeGeoKey: opts.rasterType ?? 2,
  } as Record<string, unknown>);
  return new Uint8Array(buf as ArrayBuffer);
}

/** Answer every request with `bytes`, honouring Range like S3 does (geotiff reads COGs by range). */
async function withRangeServer<T>(bytes: Uint8Array, fn: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const hdrs = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const range = hdrs.get('range');
    const m = range && /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
      const slice = bytes.slice(start, end + 1);
      return new Response(slice, {
        status: 206,
        headers: { 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(slice.length), 'accept-ranges': 'bytes' },
      });
    }
    return new Response(bytes.slice(), { status: 200, headers: { 'content-length': String(bytes.length), 'accept-ranges': 'bytes' } });
  }) as typeof fetch;
  try {
    return { result: await fn(), urls };
  } finally {
    globalThis.fetch = real;
  }
}

test('the reader asks for the right tiles and refuses geometry that is not GLO-30', async () => {
  /*
   * The failure this guards against is the silent one. A tile with a different size, posting, origin or raster type
   * would still decode; the reader would place its samples on the wrong cells and the flood would run down a valley
   * that is not there. So the reader checks all four and throws, and a wrong tile must never be quietly accepted.
   */
  const { merc } = squareDomain({ lat: 27.99, lon: 85.186 }, 8000);
  const small = await tiffOf(new Float32Array(64 * 64).fill(700), 64, 64, { lon: 85, lat: 28, scale: 1 / 3600 });
  const wrong = await withRangeServer(small, () => fetchCopernicusDEM(merc, 64, 64).then(() => 'loaded', (e: Error) => e.message));
  assert.match(String(wrong.result), /is 64×64, expected 3600²/);
  // …and it asked for the two tiles this domain straddles, by name, over https.
  assert.ok(wrong.urls.length > 0, 'a request was made');
  assert.ok(wrong.urls.every((u) => u.startsWith(`${COPERNICUS_DEM_30M_BASE}/`)), wrong.urls.join(', '));
  assert.ok(wrong.urls.some((u) => u.includes('Copernicus_DSM_COG_10_N27_00_E085_00_DEM')), wrong.urls.join(', '));

  // A tile that cannot be reached at all fails with the bucket's own error, not with a plane of zeros.
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
  try {
    await assert.rejects(fetchCopernicusDEM(merc, 32, 32), (e: Error) => {
      assert.ok(e.message.length > 0);
      return true;
    });
  } finally {
    globalThis.fetch = real;
  }
});

/*
 * END-TO-END EVIDENCE THAT THE STITCH IS RIGHT, on the shipped product rather than on a synthetic tile.
 *
 * The Betrawati domain is deliberately one that straddles 28° N, so its elevation.f32 is a two-tile mosaic. A half-
 * pixel registration error between the tiles, or an off-by-one on the seam row, shows up as a STEP along the grid row
 * that holds 28.0 N — a discontinuity the surrounding terrain does not have. This measures that row against the rest
 * of the domain instead of taking the reader's word for it.
 */
test('the baked Nepal mosaic has no step at the 28° N tile seam', { skip: !fs.existsSync(path.resolve(import.meta.dirname, '../../public/presets/nepal/meta.json')) && 'not baked' }, () => {
  const dir = path.resolve(import.meta.dirname, '../../public/presets/nepal');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as {
    nx: number;
    ny: number;
    bounds: { west: number; east: number; south: number; north: number };
    bake?: { demTiles?: string[] };
  };
  assert.equal(meta.bake?.demTiles?.length, 2, 'this test is only meaningful on a two-tile mosaic');
  assert.ok(meta.bounds.south < 28 && meta.bounds.north > 28);
  const buf = fs.readFileSync(path.join(dir, 'elevation.f32'));
  const z = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const { nx, ny } = meta;

  // Mean |Δz| between row j and row j-1, for every row. Latitude is nonlinear in mercator, so rows are located the
  // way the reader locates them: through mercator y.
  const yTop = lonLatToMercator(0, meta.bounds.north).y;
  const yBot = lonLatToMercator(0, meta.bounds.south).y;
  const latOf = (j: number) => mercatorToLonLat(0, yTop - ((j + 0.5) / ny) * (yTop - yBot)).lat;
  let seamRow = -1;
  for (let j = 1; j < ny; j++) if (latOf(j - 1) > 28 && latOf(j) <= 28) seamRow = j;
  assert.ok(seamRow > 4 && seamRow < ny - 4, `the 28.0 N line falls on row ${seamRow}`);

  const stepOf = (j: number) => {
    let sum = 0;
    for (let i = 0; i < nx; i++) sum += Math.abs(z[j * nx + i] - z[(j - 1) * nx + i]);
    return sum / nx;
  };
  const steps: number[] = [];
  for (let j = 1; j < ny; j++) steps.push(stepOf(j));
  const sorted = steps.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const seam = stepOf(seamRow);
  /*
   * The seam row must be ordinary. It is: 2.4 m of mean |Δz| against a domain median near 2.8 m — the terrain's own
   * row-to-row roughness is LARGER than the join. A misregistered mosaic would put a constant offset into every one of
   * the 1024 cells of this row and land far above the 99th percentile.
   */
  assert.ok(seam < p99, `seam row ${seamRow}: ${seam.toFixed(2)} m of mean |Δz| against p99 ${p99.toFixed(2)} m`);
  assert.ok(seam < median * 1.6, `seam row ${seamRow}: ${seam.toFixed(2)} m vs median ${median.toFixed(2)} m`);
});
