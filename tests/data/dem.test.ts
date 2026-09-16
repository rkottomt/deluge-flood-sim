/// <reference types="node" />
/**
 * DEM decoding and repair: Float32 GeoTIFF decode (the USGS 3DEP path), no-data fill, lidar-seam repair,
 * Terrarium PNG decoding (all PNG filter types) and zoom selection. Offline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { writeArrayBuffer } from 'geotiff';
import { cleanDEM, decodeTiffF32, fillNoData, isNoData, terrariumZoom, usgs3depUrl } from '../../src/data/dem';
import { squareDomain } from '../../src/data/geo';
import { decodePNG } from '../../src/data/png';

test('Float32 TIFF decodes row-major, north row first', async () => {
  const nx = 16;
  const ny = 8;
  const values = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) values[j * nx + i] = 200 + i * 0.25 - j * 1.5;
  const buf = await writeArrayBuffer(values as unknown as number[], {
    width: nx,
    height: ny,
    BitsPerSample: [32],
    SampleFormat: [3],
    SamplesPerPixel: 1,
    PhotometricInterpretation: 1,
  } as Record<string, unknown>);
  const out = await decodeTiffF32(buf as ArrayBuffer, nx, ny);
  for (let k = 0; k < values.length; k++) assert.ok(Math.abs(out[k] - values[k]) < 1e-4, `cell ${k}: ${out[k]} vs ${values[k]}`);
  await assert.rejects(decodeTiffF32(buf as ArrayBuffer, 32, 32), /expected 32×32/);
});

test('fillNoData fills holes smoothly from valid neighbors and leaves valid cells untouched', () => {
  const nx = 96;
  const ny = 64;
  const truth = (i: number, j: number) => 300 + 0.5 * i + 0.2 * j;
  const z = new Float32Array(nx * ny);
  const hole = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      z[k] = truth(i, j);
      const big = Math.hypot(i - 40, j - 30) < 9; // big void
      const speck = (i * 7 + j * 13) % 97 === 0; // scattered no-data
      const edge = i < 3 && j > 50; // void at the domain edge
      if (big || speck || edge) {
        z[k] = (i + j) % 2 ? NaN : -3.4028235e38;
        hole[k] = 1;
      }
    }
  }
  const before = new Float32Array(z);
  const filled = fillNoData(z, nx, ny);
  assert.equal(filled, hole.reduce((a, b) => a + b, 0));
  for (let k = 0; k < z.length; k++) {
    assert.ok(Number.isFinite(z[k]), 'finite');
    if (!hole[k]) assert.equal(z[k], before[k]);
    else {
      const i = k % nx;
      const j = (k / nx) | 0;
      // Plane-like data: the fill must stay within the local value range (±8 m) of the true plane.
      assert.ok(Math.abs(z[k] - truth(i, j)) < 8, `fill at ${i},${j}: ${z[k]} vs ${truth(i, j)}`);
    }
  }
  const all = new Float32Array(16).fill(NaN);
  assert.equal(fillNoData(all, 4, 4), 16);
  assert.ok(all.every((v) => v === 0));
});

test('cleanDEM repairs lidar tile seams of zeros and single-cell pits', () => {
  const nx = 64;
  const ny = 64;
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = 250 + Math.sin(i / 9) * 3 + j * 0.1;
  for (let j = 0; j < ny; j++) z[j * nx + 20] = 0; // seam of zeros between tiles
  z[40 * nx + 40] = 180; // pit
  cleanDEM(z, nx, ny);
  for (let j = 0; j < ny; j++) assert.ok(Math.abs(z[j * nx + 20] - (250 + Math.sin(20 / 9) * 3 + j * 0.1)) < 1.5, `seam row ${j}: ${z[j * nx + 20]}`);
  assert.ok(Math.abs(z[40 * nx + 40] - (250 + Math.sin(40 / 9) * 3 + 4)) < 1.5, `pit ${z[40 * nx + 40]}`);
  assert.ok(isNoData(NaN) && isNoData(-9999) && !isNoData(-50) && !isNoData(4000));
});

/** Build a PNG with a given filter type per row (exercises the unfilter code). */
function makePNG(width: number, height: number, rgb: Uint8Array): Buffer {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (buf: Buffer) => {
    let c = -1;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const bpp = 3;
  const stride = width * bpp;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const ft = y % 5; // None, Sub, Up, Average, Paeth
    raw[y * (stride + 1)] = ft;
    for (let x = 0; x < stride; x++) {
      const v = rgb[y * stride + x];
      const a = x >= bpp ? rgb[y * stride + x - bpp] : 0;
      const b = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? rgb[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (ft === 1) pred = a;
      else if (ft === 2) pred = b;
      else if (ft === 3) pred = (a + b) >> 1;
      else if (ft === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('PNG decoder: all filter types; Terrarium elevation encoding', async () => {
  const w = 23;
  const h = 17;
  const elev = (x: number, y: number) => 180.5 + x * 3.25 - y * 7.125; // meters
  const rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = elev(x, y) + 32768;
      const o = (y * w + x) * 3;
      rgb[o] = Math.floor(v / 256);
      rgb[o + 1] = Math.floor(v) % 256;
      rgb[o + 2] = Math.round((v - Math.floor(v)) * 256);
    }
  }
  const png = await decodePNG(makePNG(w, h, rgb));
  assert.equal(png.width, w);
  assert.equal(png.height, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const e = png.data[s] * 256 + png.data[s + 1] + png.data[s + 2] / 256 - 32768;
      assert.ok(Math.abs(e - elev(x, y)) < 1 / 256 + 1e-9, `pixel ${x},${y}: ${e}`);
      assert.equal(png.data[s + 3], 255);
    }
  }
});

test('request URLs and Terrarium zoom selection', () => {
  const { merc } = squareDomain({ lat: 40.44, lon: -80 }, 8000);
  const url = usgs3depUrl(merc, 1024, 1024);
  assert.match(url, /exportImage\?bbox=-?\d+\.\d{3},-?\d+\.\d{3},/);
  assert.match(url, /bboxSR=3857&imageSR=3857&size=1024,1024&format=tiff&pixelType=F32/);
  const z = terrariumZoom(merc, 7.8);
  assert.ok(z >= 12 && z <= 15, `zoom ${z}`);
  const zSmall = terrariumZoom(merc, 7.8, 4);
  assert.ok(zSmall < z, 'tile budget lowers the zoom');
});
