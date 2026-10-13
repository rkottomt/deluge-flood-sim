/**
 * Live-area land cover (src/data/landcoverLive.ts): NLCD 2021 from the MRLC WCS for areas in the lower 48 — the request,
 * the decoder's refusals (compressed bodies, wrong grid, a subset that does not cover the area, unknown codes) and the
 * sampling onto the live grid. No network: the TIFFs are built here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cspAllows } from '../../src/data/csp';
import { conusAlbers, decodeNlcd, LIVE_LANDCOVER_SIZE, NLCD_WCS, nlcdCovers, nlcdRequest } from '../../src/data/landcoverLive';
import { squareDomain } from '../../src/data/geo';

/** A little-endian, single-strip uint8 GeoTIFF: w×h pixels of `values`, top-left corner (ox, oy), `res` m pixels. */
function geoTiffU8(w: number, h: number, values: number[], ox: number, oy: number, res = 30, compression = 1): ArrayBuffer {
  const tags: Array<[number, number, number, number | null]> = [
    // [tag, type, count, value] — value null = an offset to data written below
    [256, 3, 1, w],
    [257, 3, 1, h],
    [258, 3, 1, 8],
    [259, 3, 1, compression],
    [262, 3, 1, 1],
    [273, 4, 1, null], // StripOffsets
    [277, 3, 1, 1],
    [278, 4, 1, h],
    [279, 4, 1, w * h],
    [339, 3, 1, 1],
    [33550, 12, 3, null], // ModelPixelScale
    [33922, 12, 6, null], // ModelTiepoint
  ];
  const ifd = 8;
  const scaleOff = ifd + 2 + tags.length * 12 + 4;
  const tieOff = scaleOff + 24;
  const dataOff = tieOff + 48;
  const buf = new ArrayBuffer(dataOff + w * h);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949, true);
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifd, true);
  dv.setUint16(ifd, tags.length, true);
  tags.forEach(([tag, type, count, value], i) => {
    const o = ifd + 2 + i * 12;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, count, true);
    const v = value ?? (tag === 273 ? dataOff : tag === 33550 ? scaleOff : tieOff);
    if (type === 3) dv.setUint16(o + 8, v, true);
    else dv.setUint32(o + 8, v, true);
  });
  [res, res, 0].forEach((v, k) => dv.setFloat64(scaleOff + 8 * k, v, true));
  [0, 0, 0, ox, oy, 0].forEach((v, k) => dv.setFloat64(tieOff + 8 * k, v, true));
  values.forEach((v, k) => dv.setUint8(dataOff + k, v));
  return buf;
}

test('the request: lower 48 only, snapped to the 30 m grid, uncompressed, one exact CSP endpoint', () => {
  const { bounds } = squareDomain({ lat: 40.44, lon: -80.0 }, 20000);
  assert.ok(nlcdCovers(bounds));
  assert.ok(!nlcdCovers(squareDomain({ lat: 61.2, lon: -149.9 }, 8000).bounds), 'Alaska is not in the CONUS product');
  assert.ok(!nlcdCovers(squareDomain({ lat: 27.99, lon: 85.19 }, 8000).bounds), 'Nepal');
  const r = nlcdRequest(bounds, LIVE_LANDCOVER_SIZE);
  assert.ok(r.url.startsWith(`${NLCD_WCS}?`));
  assert.match(r.url, /geotiff:compression=None/);
  for (const v of r.box) assert.equal(v % 30, 0, 'on the NLCD grid');
  // A 20 km area is ~700 NLCD pixels: one 1024² tile.
  assert.match(r.url, /tilewidth=1024&geotiff:tileheight=1024/);
  assert.ok(cspAllows(r.url, 'connect-src'), 'the policy allows the request');
  assert.ok(!cspAllows('https://www.mrlc.gov/geoserver/other/wms', 'connect-src'), 'and nothing else on that host');
  // Every output pixel centre falls inside the requested box.
  for (let k = 0; k < r.xs.length; k += 997) {
    assert.ok(r.xs[k] > r.box[0] && r.xs[k] < r.box[2] && r.ys[k] > r.box[1] && r.ys[k] < r.box[3]);
  }
  // Downtown Pittsburgh in EPSG:5070 (the bake's WCS subset spans x 1,335,405–1,344,765 m, y 2,045,145–2,054,565 m).
  const p = conusAlbers(-79.99, 40.444);
  assert.ok(p.x > 1335405 && p.x < 1344765 && p.y > 2045145 && p.y < 2054565);
});

test('decodeNlcd samples by nearest neighbour; unknown codes read as no data', async () => {
  // 4×4 pixels of 30 m, top-left corner at (1000, 5000): row 0 = 11 21 22 23, row 1 = 24 41 42 43, …, one bad code (250).
  const vals = [11, 21, 22, 23, 24, 41, 42, 43, 52, 71, 81, 82, 90, 95, 31, 250];
  const tif = geoTiffU8(4, 4, vals, 1000, 5000);
  const xs = Float64Array.from([1015, 1105, 1045, 1100]);
  const ys = Float64Array.from([4985, 4985, 4955, 4895]);
  const out = await decodeNlcd(tif, { xs, ys });
  assert.deepEqual(Array.from(out), [11, 23, 41, 0]);
});

test('decodeNlcd refuses a compressed body, a grid that is not 30 m, and a subset that misses the area', async () => {
  const vals = new Array(16).fill(21);
  const xs = Float64Array.from([1015]);
  const ys = Float64Array.from([4985]);
  for (const code of [5, 8, 32946]) {
    await assert.rejects(decodeNlcd(geoTiffU8(4, 4, vals, 1000, 5000, 30, code), { xs, ys }), /compression/);
  }
  await assert.rejects(decodeNlcd(geoTiffU8(4, 4, vals, 1000, 5000, 10), { xs, ys }), /resolution/);
  await assert.rejects(decodeNlcd(geoTiffU8(4, 4, vals, 1000, 5000), { xs: Float64Array.from([900]), ys }), /does not cover/);
});
