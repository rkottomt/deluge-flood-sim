/// <reference types="node" />
/**
 * Bake land cover into public/presets/<id>/landcover.u8 and register it in the preset's meta.json (the `landcover`
 * block and `files.landcover`). bake-presets.ts runs this after every preset it bakes; on its own it re-bakes the land
 * cover of already-baked presets without touching anything else.
 *
 *   npx tsx scripts/bake-landcover.ts               # every preset with a baked meta.json
 *   npx tsx scripts/bake-landcover.ts houston       # one preset
 *   options: --refresh (refetch cached downloads), --out=<dir> (default public/presets)
 *
 * SOURCES (src/data/landcover.ts says how the classes are used):
 *  • US: NLCD 2021 Land Cover (CONUS), USGS / MRLC, public domain, 30 m, EPSG:5070 (NAD83 / Conus Albers) — read
 *    from the MRLC GeoServer WCS (GetCoverage, native grid, no resampling server-side) and resampled here nearest-
 *    neighbour onto the preset's Web-Mercator grid at LANDCOVER_SIZE_US² (31 m pixels on the 8 km presets).
 *  • elsewhere: ESA WorldCover 10 m 2021 v200, CC BY 4.0, EPSG:4326 3°×3° Cloud-Optimised GeoTIFFs on the ESA bucket
 *    (esa-worldcover.s3.eu-central-1.amazonaws.com), read by window and resampled to LANDCOVER_SIZE_GLOBAL² (15.6 m).
 *  • drain design rainfall (US only): NOAA Atlas 14 point precipitation-frequency estimates, 2-year 60-minute intensity
 *    (partial-duration series), from the HDSC PFDS CSV service at the domain centre. No equivalent is used elsewhere:
 *    non-US presets get designRainMmHr 0, i.e. no drains.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromArrayBuffer, fromUrl } from 'geotiff';
import { boundsToMercator, centerOf, isLikelyUS, mercatorToLonLat } from '../src/data/geo';
import { computeInitialWater } from '../src/data/initialWater';
import { classTable, LANDCOVER_ATTRIBUTION, type LandCoverMeta, type LandCoverScheme, validateLandCoverMeta } from '../src/data/landcover';
import type { PresetMeta } from '../src/data/presets';
import { conusAlbers, NLCD_COVERAGE, NLCD_WCS } from '../src/data/landcoverLive';

// EPSG:5070 (NAD83 / Conus Albers), shared with the live-area land cover; re-exported for the tests.
export { conusAlbers };

/** Land-cover raster edge length, pixels: about NLCD's own 30 m on the 8 km US presets, about 15 m for WorldCover. */
export const LANDCOVER_SIZE_US = 256;
export const LANDCOVER_SIZE_GLOBAL = 512;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(HERE, '../artifacts/bake-cache');
const WORLDCOVER_TILE = (lat: number, lon: number) => {
  const la = Math.floor(lat / 3) * 3;
  const lo = Math.floor(lon / 3) * 3;
  const ns = `${la >= 0 ? 'N' : 'S'}${String(Math.abs(la)).padStart(2, '0')}`;
  const ew = `${lo >= 0 ? 'E' : 'W'}${String(Math.abs(lo)).padStart(3, '0')}`;
  return { id: `${ns}${ew}`, lat0: la, lon0: lo, url: `https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_${ns}${ew}_Map.tif` };
};

function log(id: string, ...a: unknown[]) {
  console.log(`[${id}]`, ...a);
}

async function cached(id: string, name: string, key: string, refresh: boolean, fetcher: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const dir = path.join(CACHE, id);
  const file = path.join(dir, name);
  if (!refresh && fs.existsSync(file) && fs.existsSync(`${file}.key`) && fs.readFileSync(`${file}.key`, 'utf8') === key) {
    return new Uint8Array(fs.readFileSync(file));
  }
  const bytes = await fetcher();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(`${file}.key`, key);
  return bytes;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return new Uint8Array(await r.arrayBuffer());
    } catch (e) {
      if (attempt >= 2) throw e;
      await new Promise((res) => setTimeout(res, 2000 * (attempt + 1)));
    }
  }
}

/** Lon/lat of the centre of output pixel (x, y) of a size² raster over the preset's Web-Mercator bounds. */
function pixelLonLat(meta: PresetMeta, size: number) {
  const m = boundsToMercator(meta.bounds);
  return (x: number, y: number) =>
    mercatorToLonLat(m.xmin + ((x + 0.5) / size) * (m.xmax - m.xmin), m.ymax - ((y + 0.5) / size) * (m.ymax - m.ymin));
}

async function bakeNLCD(id: string, meta: PresetMeta, refresh: boolean): Promise<Uint8Array> {
  const size = LANDCOVER_SIZE_US;
  const ll = pixelLonLat(meta, size);
  const xs = new Float64Array(size * size);
  const ys = new Float64Array(size * size);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = ll(x, y);
      const a = conusAlbers(p.lon, p.lat);
      xs[y * size + x] = a.x;
      ys[y * size + x] = a.y;
      x0 = Math.min(x0, a.x);
      x1 = Math.max(x1, a.x);
      y0 = Math.min(y0, a.y);
      y1 = Math.max(y1, a.y);
    }
  }
  // Snap the request to NLCD's 30 m grid (origin on multiples of 30 m in EPSG:5070) with a 3-pixel margin.
  const snap = (v: number, up: boolean) => (up ? Math.ceil(v / 30) : Math.floor(v / 30)) * 30;
  const bx0 = snap(x0, false) - 90;
  const bx1 = snap(x1, true) + 90;
  const by0 = snap(y0, false) - 90;
  const by1 = snap(y1, true) + 90;
  const url =
    `${NLCD_WCS}?service=WCS&version=2.0.1&request=GetCoverage&coverageId=${NLCD_COVERAGE}` +
    `&subset=X(${bx0},${bx1})&subset=Y(${by0},${by1})&format=image/tiff` +
    // One Deflate tile: geotiff.js misreads GeoServer's default uncompressed 304² tiles at the image edge.
    `&geotiff:compression=Deflate&geotiff:tiling=true&geotiff:tilewidth=1024&geotiff:tileheight=1024`;
  log(id, `NLCD 2021 ${((bx1 - bx0) / 30) | 0}×${((by1 - by0) / 30) | 0} px from MRLC WCS`);
  const bytes = await cached(id, 'nlcd2021.tif', url, refresh, () => fetchBytes(url));
  const tiff = await fromArrayBuffer(bytes.slice().buffer);
  const image = await tiff.getImage();
  const [ox, oy] = image.getOrigin();
  const [rx, ry] = image.getResolution();
  if (Math.abs(Math.abs(rx) - 30) > 1e-6 || Math.abs(Math.abs(ry) - 30) > 1e-6) throw new Error(`${id}: NLCD resolution ${rx}, ${ry}`);
  const w = image.getWidth();
  const h = image.getHeight();
  const band = (await image.readRasters({ samples: [0], interleave: false }))[0] as unknown as ArrayLike<number>;
  const out = new Uint8Array(size * size);
  for (let k = 0; k < out.length; k++) {
    // North-up raster: the origin is the top-left corner (geotiff.js reports the pixel scale unsigned).
    const col = Math.floor((xs[k] - ox) / Math.abs(rx));
    const row = Math.floor((oy - ys[k]) / Math.abs(ry));
    if (col < 0 || row < 0 || col >= w || row >= h) throw new Error(`${id}: pixel ${k} falls outside the NLCD subset`);
    out[k] = band[row * w + col];
  }
  return out;
}

async function bakeWorldCover(id: string, meta: PresetMeta): Promise<Uint8Array> {
  const size = LANDCOVER_SIZE_GLOBAL;
  const ll = pixelLonLat(meta, size);
  const out = new Uint8Array(size * size);
  const PX = 12000; // pixels per degree (1/12000° ≈ 9.3 m)
  // Group the output pixels by WorldCover tile, then read each tile's bounding window once.
  const byTile = new Map<string, { t: ReturnType<typeof WORLDCOVER_TILE>; idx: number[]; lon: number[]; lat: number[] }>();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const p = ll(x, y);
      const t = WORLDCOVER_TILE(p.lat, p.lon);
      let g = byTile.get(t.id);
      if (!g) byTile.set(t.id, (g = { t, idx: [], lon: [], lat: [] }));
      g.idx.push(y * size + x);
      g.lon.push(p.lon);
      g.lat.push(p.lat);
    }
  }
  for (const { t, idx, lon, lat } of byTile.values()) {
    const image = await (await fromUrl(t.url)).getImage(0);
    const [ox, oy] = image.getOrigin();
    const [rx, ry] = image.getResolution();
    if (Math.abs(Math.abs(rx) - 1 / PX) > 1e-12 || Math.abs(Math.abs(ry) - 1 / PX) > 1e-12) throw new Error(`${id}: WorldCover ${t.id} resolution ${rx}, ${ry}`);
    const cols = lon.map((v) => Math.floor((v - ox) / Math.abs(rx)));
    const rows = lat.map((v) => Math.floor((oy - v) / Math.abs(ry)));
    const c0 = cols.reduce((a, b) => Math.min(a, b), Infinity);
    const c1 = cols.reduce((a, b) => Math.max(a, b), -Infinity);
    const r0 = rows.reduce((a, b) => Math.min(a, b), Infinity);
    const r1 = rows.reduce((a, b) => Math.max(a, b), -Infinity);
    log(id, `WorldCover ${t.id}: window ${c1 - c0 + 1}×${r1 - r0 + 1} px`);
    const ras = await image.readRasters({ window: [c0, r0, c1 + 1, r1 + 1], samples: [0], interleave: false });
    const band = (ras as unknown as ArrayLike<number>[])[0];
    const rw = c1 - c0 + 1;
    for (let k = 0; k < idx.length; k++) out[idx[k]] = band[(rows[k] - r0) * rw + (cols[k] - c0)];
  }
  return out;
}

/** NOAA Atlas 14 2-year 60-minute intensity (mm/hr, PDS) at a point, with the volume line of the response. */
async function noaaAtlas14(id: string, lat: number, lon: number, refresh: boolean): Promise<{ mmHr: number; source: string }> {
  const url = `https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv?lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&data=intensity&units=metric&series=pds`;
  const text = new TextDecoder().decode(await cached(id, 'atlas14-intensity.csv', url, refresh, () => fetchBytes(url)));
  const vol = text.split('\n').find((l) => /^NOAA Atlas 14/.test(l))?.trim() ?? 'NOAA Atlas 14';
  const header = text.split('\n').find((l) => /ARI \(years\)/.test(l));
  const row = text.split('\n').find((l) => /^60-min:/.test(l));
  if (!header || !row) throw new Error(`${id}: unexpected NOAA Atlas 14 response`);
  const aris = header.split(':,')[1].split(',').map((s) => Number(s.trim()));
  const vals = row.split(':,')[1].split(',').map((s) => Number(s.trim()));
  const k = aris.indexOf(2);
  if (k < 0 || !Number.isFinite(vals[k])) throw new Error(`${id}: no 2-year 60-minute value`);
  return { mmHr: vals[k], source: `${vol}, 2-year 60-minute intensity (partial-duration series) at ${lat.toFixed(3)}, ${lon.toFixed(3)}` };
}

/** Bake (or re-bake) one preset's land cover; returns the file size in bytes. */
export async function bakeLandCover(id: string, outDir: string, refresh = false): Promise<number> {
  const dir = path.join(outDir, id);
  const metaFile = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaFile)) throw new Error(`${id}: no baked meta.json`);
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as PresetMeta;
  const c = centerOf(meta.bounds);
  const scheme: LandCoverScheme = isLikelyUS(c.lat, c.lon) ? 'nlcd' : 'worldcover';
  const classes = scheme === 'nlcd' ? await bakeNLCD(id, meta, refresh) : await bakeWorldCover(id, meta);
  const size = scheme === 'nlcd' ? LANDCOVER_SIZE_US : LANDCOVER_SIZE_GLOBAL;
  const design = scheme === 'nlcd' ? await noaaAtlas14(id, c.lat, c.lon, refresh) : { mmHr: 0, source: 'none: no drainage design data outside the US (no drains)' };

  // QA: every pixel has a known class, and the preset's river channels land mostly on water.
  const known = new Set(classTable(scheme).map((k) => k.code));
  const counts: Record<string, number> = {};
  let unknown = 0;
  for (const v of classes) {
    counts[v] = (counts[v] ?? 0) + 1;
    if (!known.has(v)) unknown++;
  }
  const elevation = new Float32Array(new Uint8Array(fs.readFileSync(path.join(dir, meta.files.elevation))).slice().buffer);
  const water = computeInitialWater({ nx: meta.nx, ny: meta.ny, elevation }, meta.scenario);
  const waterCode = scheme === 'nlcd' ? 11 : 80;
  let wet = 0;
  let wetOnWater = 0;
  for (let j = 0; j < meta.ny; j++) {
    for (let i = 0; i < meta.nx; i++) {
      if (!(water[j * meta.nx + i] >= 0.01)) continue;
      wet++;
      const x = Math.min(size - 1, Math.floor(((i + 0.5) * size) / meta.nx));
      const y = Math.min(size - 1, Math.floor(((j + 0.5) * size) / meta.ny));
      if (classes[y * size + x] === waterCode) wetOnWater++;
    }
  }
  const share = wet ? wetOnWater / wet : NaN;
  log(id, `${scheme} ${size}²: classes ${JSON.stringify(counts)}; ${unknown} unknown px; initial water on the water class ${(share * 100).toFixed(1)} %`);
  log(id, `drain design rain ${design.mmHr} mm/hr (${design.source})`);

  const block: LandCoverMeta = {
    scheme,
    year: 2021,
    width: size,
    height: size,
    designRainMmHr: design.mmHr,
    designRainSource: design.source,
    classCounts: counts,
  };
  const problems = validateLandCoverMeta(block);
  if (problems.length) throw new Error(`${id}: ${problems.join('; ')}`);
  const m = meta as PresetMeta & { files: PresetMeta['files'] & { landcover?: string | null }; landcover?: LandCoverMeta };
  m.files.landcover = 'landcover.u8';
  m.landcover = block;
  const attr = LANDCOVER_ATTRIBUTION[scheme];
  m.attribution = `${m.attribution.replace(/\s*·\s*Land cover:[^·]*(·\s*Contains modified Copernicus[^·]*)?/g, '').trim()} · ${attr}`;
  m.bake = { ...(m.bake ?? {}), landcover: { bakedAt: new Date().toISOString(), waterShare: Number.isFinite(share) ? Math.round(share * 1000) / 1000 : null } };
  fs.writeFileSync(path.join(dir, 'landcover.u8'), classes);
  fs.writeFileSync(metaFile, JSON.stringify(m, null, 1));
  return classes.byteLength;
}

async function main() {
  const argValue = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const out = path.resolve(argValue('out') ?? path.resolve(HERE, '../public/presets'));
  const refresh = process.argv.includes('--refresh');
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const ids = only.length ? only : fs.readdirSync(out).filter((d) => fs.existsSync(path.join(out, d, 'meta.json')));
  let total = 0;
  for (const id of ids) total += await bakeLandCover(id, out, refresh);
  console.log(`land cover: ${ids.length} presets, ${(total / 1e6).toFixed(2)} MB`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
