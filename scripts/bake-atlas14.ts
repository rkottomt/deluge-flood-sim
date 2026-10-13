/// <reference types="node" />
/**
 * Bake NOAA Atlas 14 1-hour rain intensities (2, 10, 25, 100, 500-yr, partial-duration series) into one compact grid
 * the browser can load from its own origin: public/atlas14/pf60m-pds.bin (format: src/data/atlas14.ts).
 *
 *   node --import tsx scripts/bake-atlas14.ts --download --cache=<dir>   # fetch the 55 HDSC zips (~87 MB) into <dir>
 *   node --import tsx scripts/bake-atlas14.ts --cache=<dir>              # bake from them
 *   node --import tsx scripts/bake-atlas14.ts --cache=<dir> --info       # print each grid's extent and stop
 *   node --import tsx scripts/bake-atlas14.ts --verify=<dir of PFDS .txt> # compare the baked file with PFDS answers
 *
 * WHY A BAKED GRID. The PFDS point service (hdsc.nws.noaa.gov/cgi-bin/new/cgi_readH5.py) sends no CORS headers, so
 * a page cannot read it; the GIS grids it is built from are published for download and are public domain (each
 * grid's FGDC metadata: "no restrictions apply and data is public domain"; acknowledge NOAA/NWS/OWP/HDSC).
 *
 * SOURCE FILES. https://hdsc.nws.noaa.gov/pub/hdsc/data/<region>/<region><T>yr60ma.zip — ESRI ASCII grids, 30″
 * (0.008333°), NAD83 geographic, values = 60-minute precipitation depth in 1/1000 inch (= the 1-hour intensity in
 * in/h), −9 = no data. Regions (NOAA Atlas 14 volume): sa (1, semiarid Southwest), orb (2, Ohio River basin and
 * surroundings), pr (3, Puerto Rico / USVI), hi (4, Hawaii), sw (6, California), ak (7, Alaska), mw (8, Midwest),
 * se (9, Southeast), ne (10, Northeast), tx (11, Texas), inw (12, interior Northwest). Volume 5 (Pacific islands) is
 * not baked (no U.S. 3DEP live areas there).
 *
 * RESAMPLING. Each output cell is the mean of the valid 30″ source cells inside it, taken from ONE volume: where
 * volumes overlap at their borders, the one covering more of the cell wins (ties: the newer volume). Means smooth the
 * sharpest orographic gradients a little; --verify reports the error against PFDS point values (a few per cent).
 * Output steps: CONUS 1/12° (~9 km), Hawaii and Puerto Rico 1/24°, Alaska 1/6°.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { ATLAS14_ARIS, decodeAtlas14Grid, encodeAtlas14Grid, lookupAtlas14, parsePfdsResponse, pfdsOneHour, type Atlas14Grid, type Atlas14Tile } from '../src/data/atlas14';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'atlas14', 'pf60m-pds.bin');
const BASE = 'https://hdsc.nws.noaa.gov/pub/hdsc/data';
/** Oldest → newest volume: later entries win ties. */
const REGIONS = ['sa', 'orb', 'pr', 'hi', 'sw', 'ak', 'mw', 'se', 'ne', 'tx', 'inw'] as const;
const INCH_MM = 25.4;

interface TileDef {
  name: string;
  south: number;
  west: number;
  north: number;
  east: number;
  step: number;
  regions: readonly string[];
}
const TILES: TileDef[] = [
  { name: 'conus', south: 24, west: -125, north: 50, east: -66.5, step: 1 / 12, regions: ['sa', 'orb', 'sw', 'mw', 'se', 'ne', 'tx', 'inw'] },
  { name: 'alaska', south: 50.5, west: -180, north: 72.5, east: -129, step: 1 / 6, regions: ['ak'] },
  { name: 'hawaii', south: 18.5, west: -160.5, north: 22.5, east: -154.5, step: 1 / 24, regions: ['hi'] },
  { name: 'puertorico', south: 17.5, west: -68, north: 18.75, east: -64.5, step: 1 / 24, regions: ['pr'] },
];

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);

// ─── Zip (central directory → one deflated .asc) ─────────────────────────────────────────────────────────────────────
function readAscFromZip(file: string): Buffer {
  const z = fs.readFileSync(file);
  let eocd = -1;
  for (let i = z.length - 22; i >= Math.max(0, z.length - 66000); i--) {
    if (z.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error(`${file}: not a zip`);
  const entries = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  for (let e = 0; e < entries; e++) {
    if (z.readUInt32LE(p) !== 0x02014b50) throw new Error(`${file}: bad central directory`);
    const method = z.readUInt16LE(p + 10);
    const csize = z.readUInt32LE(p + 20);
    const nlen = z.readUInt16LE(p + 28);
    const xlen = z.readUInt16LE(p + 30);
    const clen = z.readUInt16LE(p + 32);
    const local = z.readUInt32LE(p + 42);
    const name = z.toString('latin1', p + 46, p + 46 + nlen);
    p += 46 + nlen + xlen + clen;
    // The grid itself: .asc, or (Volume 1) .ver4 — the same ESRI ASCII format under a version suffix.
    if (!/\.(asc|ver\d+)$/i.test(name)) continue;
    const lnlen = z.readUInt16LE(local + 26);
    const lxlen = z.readUInt16LE(local + 28);
    const data = z.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data, { maxOutputLength: 512 * 1024 * 1024 });
    throw new Error(`${file}: unsupported compression ${method}`);
  }
  throw new Error(`${file}: no ASCII grid inside`);
}

interface AscGrid {
  ncols: number;
  nrows: number;
  xll: number;
  yll: number;
  cell: number;
  nodata: number;
  /** Row 0 = NORTH (ESRI ASCII order). */
  data: Float32Array;
}

function parseAsc(buf: Buffer): AscGrid {
  let p = 0;
  const header: Record<string, number> = {};
  for (let k = 0; k < 6; k++) {
    let e = buf.indexOf(10, p);
    if (e < 0) e = buf.length;
    const [key, val] = buf.toString('latin1', p, e).trim().split(/\s+/);
    header[key.toLowerCase()] = Number(val);
    p = e + 1;
  }
  const ncols = header.ncols;
  const nrows = header.nrows;
  const xll = header.xllcorner ?? header.xllcenter;
  const yll = header.yllcorner ?? header.yllcenter;
  const cell = header.cellsize;
  const nodata = header.nodata_value ?? -9;
  if (!(ncols > 0 && nrows > 0 && cell > 0) || !Number.isFinite(xll) || !Number.isFinite(yll)) throw new Error('bad ASC header');
  const data = new Float32Array(ncols * nrows);
  let i = 0;
  let num = 0;
  let neg = false;
  let inNum = false;
  let frac = 0;
  let scale = 1;
  for (; p < buf.length && i < data.length; p++) {
    const c = buf[p];
    if (c === 45) {
      neg = true;
      inNum = true;
    } else if (c >= 48 && c <= 57) {
      if (frac) {
        scale /= 10;
        num += (c - 48) * scale;
      } else num = num * 10 + (c - 48);
      inNum = true;
    } else if (c === 46) {
      frac = 1;
    } else if (inNum) {
      data[i++] = neg ? -num : num;
      num = 0;
      neg = false;
      inNum = false;
      frac = 0;
      scale = 1;
    }
  }
  if (inNum && i < data.length) data[i++] = neg ? -num : num;
  if (i !== data.length) throw new Error(`ASC: ${i} values, header says ${data.length}`);
  return { ncols, nrows, xll, yll, cell, nodata, data };
}

function zipPath(cache: string, region: string, T: number): string {
  return path.join(cache, `${region}${T}yr60ma.zip`);
}

async function download(cache: string): Promise<void> {
  fs.mkdirSync(cache, { recursive: true });
  for (const r of REGIONS) {
    for (const T of ATLAS14_ARIS) {
      const f = zipPath(cache, r, T);
      if (fs.existsSync(f) && fs.statSync(f).size > 0) continue;
      const url = `${BASE}/${r}/${path.basename(f)}`;
      process.stdout.write(`  ${url} … `);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(f, buf);
      console.log(`${(buf.length / 1e6).toFixed(1)} MB`);
      await new Promise((r2) => setTimeout(r2, 500)); // be polite to NOAA
    }
  }
}

function bake(cache: string): Atlas14Grid {
  const tiles: Atlas14Tile[] = [];
  for (const def of TILES) {
    const nlat = Math.round((def.north - def.south) / def.step);
    const nlon = Math.round((def.east - def.west) / def.step);
    const n = nlat * nlon;
    const best = new Int32Array(n); // valid source cells behind the chosen value
    const values = ATLAS14_ARIS.map(() => new Float32Array(n).fill(NaN));
    for (const region of def.regions) {
      const sums = ATLAS14_ARIS.map(() => new Float64Array(n));
      const counts = new Int32Array(n);
      ATLAS14_ARIS.forEach((T, a) => {
        const g = parseAsc(readAscFromZip(zipPath(cache, region, T)));
        const sum = sums[a];
        for (let r = 0; r < g.nrows; r++) {
          const lat = g.yll + (g.nrows - r - 0.5) * g.cell;
          const ty = Math.floor((lat - def.south) / def.step);
          if (ty < 0 || ty >= nlat) continue;
          for (let c = 0; c < g.ncols; c++) {
            const v = g.data[r * g.ncols + c];
            if (v === g.nodata || !(v > 0)) continue;
            let lon = g.xll + (c + 0.5) * g.cell;
            if (lon > 180) lon -= 360;
            const tx = Math.floor((lon - def.west) / def.step);
            if (tx < 0 || tx >= nlon) continue;
            const k = ty * nlon + tx;
            sum[k] += (v / 1000) * INCH_MM; // 60-min depth in inches → mm in one hour = mm/h
            if (a === 0) counts[k]++;
          }
        }
        console.log(`  ${def.name} ← ${region} ${T}-yr (${g.ncols}×${g.nrows})`);
      });
      for (let k = 0; k < n; k++) {
        const c = counts[k];
        if (c === 0 || c < best[k]) continue;
        best[k] = c;
        for (let a = 0; a < ATLAS14_ARIS.length; a++) values[a][k] = sums[a][k] / c;
      }
    }
    // Monotone in return period by construction of the source; enforce against float noise in the means.
    for (let k = 0; k < n; k++) for (let a = 1; a < ATLAS14_ARIS.length; a++) if (values[a][k] < values[a - 1][k]) values[a][k] = values[a - 1][k];
    let filled = 0;
    for (let k = 0; k < n; k++) if (Number.isFinite(values[0][k])) filled++;
    console.log(`${def.name}: ${nlon}×${nlat} cells at ${def.step.toFixed(4)}°, ${filled} with data`);
    tiles.push({ south: def.south, west: def.west, step: def.step, nlat, nlon, values });
  }
  return { aris: [...ATLAS14_ARIS], tiles };
}

/** Sample points with captured PFDS answers (tests/fixtures/atlas14/pfds-*.txt). */
export const VERIFY_POINTS: Record<string, [number, number]> = {
  houston: [29.7604, -95.3698],
  asheville: [35.5951, -82.5515],
  denver: [39.7392, -104.9903],
  phoenix: [33.4484, -112.074],
  losangeles: [34.0522, -118.2437],
  missoula: [46.8721, -113.994],
  miami: [25.7617, -80.1918],
  boston: [42.3601, -71.0589],
  honolulu: [21.3069, -157.8583],
  sanjuan: [18.4655, -66.1057],
  anchorage: [61.2181, -149.9003],
  seattle: [47.6062, -122.3321],
};

function verify(dir: string): void {
  const grid = decodeAtlas14Grid(zlib.gunzipSync(fs.readFileSync(OUT)));
  let worst = 0;
  for (const [name, [lat, lon]] of Object.entries(VERIFY_POINTS)) {
    const f = path.join(dir, `pfds-${name}.txt`);
    if (!fs.existsSync(f)) continue;
    const r = parsePfdsResponse(fs.readFileSync(f), { lat, lon });
    const got = lookupAtlas14(grid, lat, lon);
    if (!r.covered) {
      console.log(`${name.padEnd(11)} PFDS: not covered · grid: ${got ? 'HAS DATA (!)' : 'none'}`);
      continue;
    }
    const want = pfdsOneHour(r);
    const have = got ? got.levels.map((l) => l.mmPerHour) : [];
    const errs = want.map((w, i) => (have[i] - w) / w);
    worst = Math.max(worst, ...errs.map(Math.abs));
    console.log(`${name.padEnd(11)} PFDS ${want.join('/')} mm/h · grid ${have.map((v) => v.toFixed(0)).join('/')} · err ${errs.map((e) => `${(e * 100).toFixed(0)}%`).join(' ')}`);
  }
  console.log(`worst relative error: ${(worst * 100).toFixed(1)} %`);
}

async function main() {
  if (args.verify) return verify(String(args.verify));
  const cache = String(args.cache ?? path.join(ROOT, 'artifacts', 'bake-cache', 'atlas14'));
  if (args.download === 'true') await download(cache);
  if (args.info === 'true') {
    for (const r of REGIONS) {
      const g = parseAsc(readAscFromZip(zipPath(cache, r, 100)));
      console.log(`${r}: ${g.ncols}×${g.nrows} lon ${g.xll.toFixed(3)}..${(g.xll + g.ncols * g.cell).toFixed(3)} lat ${g.yll.toFixed(3)}..${(g.yll + g.nrows * g.cell).toFixed(3)} cell ${g.cell}`);
    }
    return;
  }
  const grid = bake(cache);
  const bytes = encodeAtlas14Grid(grid);
  decodeAtlas14Grid(bytes); // the app's own decoder must accept what we ship
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const gz = zlib.gzipSync(bytes, { level: 9 });
  fs.writeFileSync(OUT, gz);
  console.log(`wrote ${path.relative(ROOT, OUT)}: ${(gz.length / 1e6).toFixed(2)} MB gzip (${(bytes.length / 1e6).toFixed(2)} MB inflated)`);
}

await main();
