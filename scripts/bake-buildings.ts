/// <reference types="node" />
/**
 * Bake building footprints with heights into public/presets/<id>/buildings.json, and register the file in the
 * preset's meta.json.
 *
 *   npx tsx scripts/bake-buildings.ts                 # all presets that have a baked meta.json
 *   npx tsx scripts/bake-buildings.ts pittsburgh      # one preset
 *   options:
 *     --refresh    refetch the OSM tiles instead of using artifacts/bake-cache/<id>/osm-*.xml
 *     --dry        parse and report, write nothing
 *     --fit        also print the metres-per-storey fit from every building that carries BOTH `height` and
 *                  `building:levels` (this is where LEVEL_HEIGHT_LOW / LEVEL_HEIGHT_HIGH come from)
 *     --fill / --no-fill   force the Microsoft ML footprint fill on/off (default: on where OSM coverage is thin)
 *     --profile=us|nepal   regional calibration of the ESTIMATED height prior (default: per preset; Nepal uses
 *                  'nepal', everything else 'us'). Never touches a tagged, floor-counted or remote-sensed height.
 *     --out=<dir>  default public/presets
 *
 * SECOND SOURCE: where OpenStreetMap has mapped fewer than MS_FILL_DENSITY buildings per km^2, the gap is filled
 * from Microsoft's Global ML Building Footprints (ODbL 1.0, same licence, so the baked file's terms are unchanged).
 * Those come with a stereo-imagery height per building and are added only where OSM has no footprint at all, so a
 * hand-mapped building is never replaced by a machine-extracted one. Johnstown needs this; Pittsburgh does not.
 *
 * SOURCE: OpenStreetMap, via the OSM API 0.6 `/map` endpoint — the same host the roads fallback already uses, and the
 * one geodata API reachable from the venue network (Overpass is blocked here). The API refuses more than 50 000 nodes
 * per request, so the preset's bbox is tiled at about 0.019 deg and a tile that still comes back "too many nodes" is
 * split in four. Ways crossing a tile boundary come back complete (the API returns every way referencing a node inside
 * the bbox, plus the nodes those ways need), so no padding is needed — only de-duplication, which
 * `buildBuildingSet` does by quantised centroid.
 *
 * LICENCE: OSM is ODbL 1.0. Attribution ships on screen (`BUILDINGS_ATTRIBUTION_OSM`, folded into the preset's
 * `attribution` line) and in public/presets/SOURCES.txt, and buildings.json — a derived database — is offered under
 * ODbL like its source. Compatible with a public repo; the rest of the baked data (3DEP elevation, NAIP imagery,
 * TIGER/Line roads) stays public domain and is unaffected.
 *
 * HONESTY: every building records how its height was obtained (measured / levels / estimated) and the run prints the
 * split. The tallest towers downtown are measured; the low-rise mass is estimated and says so.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import type { BuildingSet, GeoBounds } from '../src/contracts';
import {
  buildBuildingSet,
  type HeightProfile,
  BUILDING_KINDS,
  BUILDINGS_ATTRIBUTION_OSM,
  BUILDINGS_ATTRIBUTION_OSM_MS,
  buildingStats,
  encodeBuildings,
  HEIGHT_SOURCES,
  parseHeightMeters,
  parseLevels,
  parseMSBuildings,
  parseOSMBuildings,
  rasterizeBuildingHeights,
  validateCompactBuildings,
  type RawBuilding,
} from '../src/data/buildings';
import { makeGeoToGrid } from '../src/data/geo';
import { computeInitialWater } from '../src/data/initialWater';
import { decodeElevation, PRESETS, type PresetMeta } from '../src/data/presets';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE = path.join(ROOT, 'artifacts/bake-cache');
const argValue = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const OUT = path.resolve(ROOT, argValue('out') ?? 'public/presets');
const REFRESH = process.argv.includes('--refresh');
const DRY = process.argv.includes('--dry');
const FIT = process.argv.includes('--fit');
const FILL = process.argv.includes('--fill') ? true : process.argv.includes('--no-fill') ? false : null;
/**
 * Regional calibration of the estimated-height prior (src/data/buildings.ts). Defaults per preset, because the prior
 * was fitted to US building stock: everything in the United States takes it as fitted, Betrawati does not.
 */
const HEIGHT_PROFILE_BY_PRESET: Record<string, HeightProfile> = { nepal: 'nepal' };
const PROFILE_ARG = argValue('profile') as HeightProfile | undefined;
if (PROFILE_ARG && PROFILE_ARG !== 'us' && PROFILE_ARG !== 'nepal') {
  throw new Error(`--profile must be 'us' or 'nepal', got '${PROFILE_ARG}'`);
}
const heightProfileFor = (id: string): HeightProfile => PROFILE_ARG ?? HEIGHT_PROFILE_BY_PRESET[id] ?? 'us';
/** Lidar path (see the block comment above HS_LIDAR): dump footprints for the sampler / apply the sampled roofs. */
const LIDAR_EXPORT = argValue('lidar-export');
const LIDAR_APPLY = argValue('lidar');

/** Below this many OSM buildings per km^2, fill the gaps from the Microsoft footprints. */
const MS_FILL_DENSITY = 150;
const MS_INDEX = 'https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv';
/** Quadkey zoom the Microsoft tiles are published at. */
const MS_ZOOM = 9;

/** Tile edge in degrees. 0.02 deg squares stay under the API's 50 000-node cap even over downtown Pittsburgh. */
const TILE_DEG = 0.02;
/** Be a good OSM citizen: one request at a time, with a pause between them. */
const PAUSE_MS = 1000;

const log = (id: string, msg: string) => console.log(`[${id}] ${msg}`);

function tileKey(b: GeoBounds): string {
  return `${b.west.toFixed(5)}_${b.south.toFixed(5)}_${b.east.toFixed(5)}_${b.north.toFixed(5)}`;
}

/** Split a bounds into a grid of tiles no larger than TILE_DEG on a side. */
function tiles(b: GeoBounds): GeoBounds[] {
  const cols = Math.max(1, Math.ceil((b.east - b.west) / TILE_DEG));
  const rows = Math.max(1, Math.ceil((b.north - b.south) / TILE_DEG));
  const out: GeoBounds[] = [];
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      out.push({
        west: b.west + (i * (b.east - b.west)) / cols,
        east: b.west + ((i + 1) * (b.east - b.west)) / cols,
        south: b.south + (j * (b.north - b.south)) / rows,
        north: b.south + ((j + 1) * (b.north - b.south)) / rows,
      });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * OSM XML for one tile: from artifacts/bake-cache/<id>/osm-<key>.xml when present, else fetched and stored. A tile the
 * API rejects as too large is split in four and each quarter fetched instead.
 */
async function tileXml(id: string, b: GeoBounds, depth = 0): Promise<string[]> {
  const dir = path.join(CACHE, id);
  const file = path.join(dir, `osm-${tileKey(b)}.xml`);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 0) return [fs.readFileSync(file, 'utf8')];
  if (depth > 3) throw new Error(`cannot split tile ${tileKey(b)} any further`);
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${b.west.toFixed(5)},${b.south.toFixed(5)},${b.east.toFixed(5)},${b.north.toFixed(5)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Deluge-flood-sim/0.1 (offline flood simulator; one-off building footprint bake)' },
  });
  const body = await res.text();
  if (res.status === 400 && /too many nodes/i.test(body)) {
    log(id, `  tile ${tileKey(b)} too dense — splitting`);
    const mx = (b.west + b.east) / 2;
    const my = (b.south + b.north) / 2;
    const quads: GeoBounds[] = [
      { west: b.west, south: b.south, east: mx, north: my },
      { west: mx, south: b.south, east: b.east, north: my },
      { west: b.west, south: my, east: mx, north: b.north },
      { west: mx, south: my, east: b.east, north: b.north },
    ];
    const out: string[] = [];
    for (const q of quads) out.push(...(await tileXml(id, q, depth + 1)));
    return out;
  }
  if (!res.ok) throw new Error(`OSM ${res.status} for ${tileKey(b)}: ${body.slice(0, 120)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  await sleep(PAUSE_MS);
  return [body];
}

/** Metres-per-storey fit over every building that carries both tags — the evidence behind LEVEL_HEIGHT_*. */
function fitLevels(xmls: string[]): void {
  const lo: number[] = [];
  const hi: number[] = [];
  for (const xml of xmls) {
    for (const m of xml.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
      const body = m[1];
      const h = parseHeightMeters(body.match(/k="height" v="([^"]*)"/)?.[1]);
      const n = parseLevels(body.match(/k="building:levels" v="([^"]*)"/)?.[1]);
      if (h === null || n === null || n < 1) continue;
      (n >= 4 ? hi : lo).push(h / n);
    }
  }
  const med = (a: number[]) => (a.length ? a.slice().sort((p, q) => p - q)[a.length >> 1] : NaN);
  console.log(`\n  metres per storey — low-rise (<4 levels): n=${lo.length} median=${med(lo).toFixed(2)}`);
  console.log(`  metres per storey — high-rise (>=4 levels): n=${hi.length} median=${med(hi).toFixed(2)}\n`);
}

/** Bing/Microsoft quadkey of the tile containing a lon/lat at `z`. */
function quadkey(lat: number, lon: number, z: number): string {
  const s = Math.sin((lat * Math.PI) / 180);
  const x = Math.floor(((lon + 180) / 360) * 2 ** z);
  const y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z);
  let q = '';
  for (let i = z; i > 0; i--) {
    const m = 1 << (i - 1);
    q += String((x & m ? 1 : 0) + (y & m ? 2 : 0));
  }
  return q;
}

/** Download (once) and return a cached file's bytes. */
async function cached(id: string, name: string, url: string): Promise<Buffer> {
  const dir = path.join(CACHE, id);
  const file = path.join(dir, name);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
  log(id, `  downloading ${name}…`);
  const res = await fetch(url, { headers: { 'User-Agent': 'Deluge-flood-sim/0.1 (one-off building footprint bake)' } });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

/** Microsoft ML footprints covering `bounds` (the quadkey tiles its corners fall in). */
async function msBuildings(id: string, bounds: GeoBounds): Promise<RawBuilding[]> {
  const index = (await cached('shared', 'ms-dataset-links.csv', MS_INDEX)).toString('utf8');
  const keys = new Set(
    [
      quadkey(bounds.south, bounds.west, MS_ZOOM),
      quadkey(bounds.south, bounds.east, MS_ZOOM),
      quadkey(bounds.north, bounds.west, MS_ZOOM),
      quadkey(bounds.north, bounds.east, MS_ZOOM),
    ],
  );
  const out: RawBuilding[] = [];
  for (const line of index.split('\n')) {
    const [, qk, url] = line.split(',');
    if (!qk || !keys.has(qk.trim()) || !url) continue;
    const gz = await cached(id, `ms-${qk.trim()}.csv.gz`, url.trim());
    const jsonl = zlib.gunzipSync(gz).toString('utf8');
    const part = parseMSBuildings(jsonl, bounds);
    log(id, `  Microsoft tile ${qk.trim()}: ${part.length} footprints inside the domain`);
    out.push(...part);
  }
  return out;
}


// ──────────────────────────────────────────────────────────────────────────────────────────────
// LIDAR PATH — roof heights MEASURED from USGS 3DEP point clouds
// ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Two modes, used as a pair, that replace guessed heights with roof heights measured from lidar. The heavy lifting
 * (400 M points of 3DEP) happens outside this script; see artifacts/gfx-lidar/README.md.
 *
 *   npx tsx scripts/bake-buildings.ts pittsburgh --lidar-export=artifacts/gfx-lidar/pittsburgh-footprints.json
 *   …sample the DSM over those footprints (artifacts/gfx-lidar/sample-roofs.py, run on a big box)…
 *   npx tsx scripts/bake-buildings.ts pittsburgh --lidar=artifacts/gfx-lidar/pittsburgh-roofs.json
 *
 * WHY THE SAMPLER RETURNS A ROOF *ELEVATION*, NOT A HEIGHT: buildBuildingSet plants every footprint on `base`, the
 * BASE_QUANTILE (5th percentile) of the bare-earth DEM under it, and `height` is measured up from there. The number
 * that makes the rendered roof land where the lidar actually saw it is therefore `roofElevation - base`, computed here
 * against the very base this bake just chose. A pre-subtracted height would double-count the slope under every
 * hillside building in Pittsburgh — which is most of them.
 *
 * CRS: no reprojection anywhere. The usgs-lidar-public EPT builds for PA_WesternPA_1/2_2019 are published in
 * EPSG:3857, and the preset grid is linear in EPSG:3857 (src/data/geo.ts), so the sampler rasterises the point cloud
 * on a grid that is exactly 8x the preset grid and indexes it directly. Vertically both sides are NAVD88 metres; the
 * measured lidar-ground-vs-elevation.f32 residual is recorded in artifacts/gfx-lidar/ rather than assumed to be zero.
 *
 * PROVENANCE: a lidar roof is recorded as heightSource 3 'remote' — "measured remotely rather than surveyed", which is
 * exactly what a lidar roof is, and the only free slot in the 2-bit field the renderer unpacks (src/render/buildings.ts
 * masks `heightSource & 3`, and contracts.ts documents 4 values). Widening that field to separate 'lidar' from the
 * Microsoft stereo-imagery heights needs src/contracts.ts, src/data/buildings.ts and src/render/buildings.ts to change
 * together; until then the exact split is written into meta.json's bake block and public/presets/SOURCES.txt.
 */
/** heightSource code used for a lidar-measured roof. */
const HS_LIDAR = 3;
/** A lidar roof this far below its base is a mis-sample (footprint over water, DEM/DSM disagreement) — keep OSM. */
const LIDAR_MIN_HEIGHT = 2;
/** Nothing in these domains is taller than this; above it, suspect a noise return — keep OSM. */
const LIDAR_MAX_HEIGHT = 300;

/** Shoelace twice-area of an open ring of interleaved coords (mirrors the private helper in src/data/buildings.ts). */
function ringArea2Of(ring: ArrayLike<number>): number {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return a;
}

/**
 * The key buildBuildingSet already dedups footprints on — quantised centroid plus rounded area — recomputed from the
 * finished BuildingSet. Stable across re-bakes and independent of the Morton ordering, so the exported footprints and
 * the sampled roofs line up without either side depending on an array position.
 */
function footprintKey(set: BuildingSet, k: number, cellSize: number): string {
  const a = set.offsets[k];
  const e = set.offsets[k + 1];
  const ring = set.verts.subarray(a * 2, e * 2);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < ring.length; i += 2) {
    sx += ring[i];
    sy += ring[i + 1];
  }
  const n = ring.length / 2;
  const area = (Math.abs(ringArea2Of(ring)) / 2) * cellSize * cellSize;
  return `${Math.round((sx / n) * 8)},${Math.round((sy / n) * 8)},${Math.round(area)}`;
}

/** Recount the height-provenance fields of a report from the set, after the lidar pass has rewritten some of them. */
function recountProvenance(set: BuildingSet, report: { measured: number; levels: number; estimated: number; remote: number }): void {
  report.measured = 0;
  report.levels = 0;
  report.estimated = 0;
  report.remote = 0;
  for (let k = 0; k < set.count; k++) {
    const s = set.heightSource[k] & 3;
    if (s === 0) report.measured++;
    else if (s === 1) report.levels++;
    else if (s === 2) report.estimated++;
    else report.remote++;
  }
}

/** Footprints in grid coordinates for the sampler, plus the base and the height the OSM path arrived at. */
function writeLidarExport(id: string, file: string, set: BuildingSet, grid: { nx: number; ny: number; cellSize: number; bounds: GeoBounds }): void {
  const buildings = [];
  for (let k = 0; k < set.count; k++) {
    const a = set.offsets[k];
    const e = set.offsets[k + 1];
    const ring: number[] = [];
    for (let i = a; i < e; i++) ring.push(round4(set.verts[i * 2]), round4(set.verts[i * 2 + 1]));
    buildings.push({
      key: footprintKey(set, k, grid.cellSize),
      ring,
      base: round4(set.base[k]),
      osmHeight: round4(set.height[k]),
      osmSource: set.heightSource[k] & 3,
      name: set.names[k],
    });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      preset: id,
      nx: grid.nx,
      ny: grid.ny,
      cellSize: grid.cellSize,
      bounds: grid.bounds,
      note: 'ring coords are GRID cells: x east from the west edge, y south from the north edge. base/osmHeight in metres.',
      buildings,
    }),
  );
  log(id, `lidar export: ${buildings.length} footprints -> ${path.relative(ROOT, file)}`);
}

const round4 = (x: number) => Math.round(x * 1e4) / 1e4;

interface LidarRoofFile {
  preset: string;
  /** Footprint key -> measured roof elevation in metres (same vertical datum as elevation.f32) and sample count. */
  roofs: Record<string, [z: number, n: number]>;
  /** How the roof elevation was reduced from the DSM. */
  estimator?: string;
  /** Acquisition window of the point cloud. */
  acquired?: string;
  /** Measured lidar-ground-minus-DEM residual, the evidence that the two vertical datums agree. */
  groundResidualVsDemM?: { median: number; mad: number };
  /** Why the sampler declined to measure a footprint, by reason — these keep whatever the OSM path decided. */
  keptOsmBecause?: Record<string, number>;
}

/** Overwrite heights with lidar roof elevations where the sample is trustworthy; keep the OSM value where it is not. */
function applyLidarRoofs(
  id: string,
  file: string,
  set: BuildingSet,
  cellSize: number,
): { applied: number; missing: number; rejected: number; deltas: number[]; doc: LidarRoofFile } {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as LidarRoofFile;
  if (doc.preset !== id) throw new Error(`lidar roof file is for "${doc.preset}", not "${id}"`);
  let applied = 0;
  let missing = 0;
  let rejected = 0;
  const deltas: number[] = [];
  for (let k = 0; k < set.count; k++) {
    const r = doc.roofs[footprintKey(set, k, cellSize)];
    if (!r) {
      missing++;
      continue;
    }
    const h = r[0] - set.base[k];
    if (!(h >= LIDAR_MIN_HEIGHT) || h > LIDAR_MAX_HEIGHT) {
      rejected++;
      continue;
    }
    // Only compare against heights that were themselves real numbers, not the estimated mass.
    const was = set.heightSource[k] & 3;
    if (was === 0 || was === 1) deltas.push(h - set.height[k]);
    set.height[k] = h;
    set.heightSource[k] = HS_LIDAR;
    applied++;
  }
  log(id, `lidar: ${applied} roofs measured, ${missing} footprints kept their OSM/estimated height, ${rejected} rejected as implausible`);
  if (doc.keptOsmBecause) {
    for (const [why, n] of Object.entries(doc.keptOsmBecause)) if (n) log(id, `  kept OSM — ${why}: ${n}`);
  }
  return { applied, missing, rejected, deltas, doc };
}

/** Re-derive report.tallest after the lidar pass rewrote heights (mirrors the top-15 buildBuildingSet computes). */
function recountTallest(
  set: BuildingSet,
  report: { tallest: Array<{ name: string; height: number; source: string }> },
): void {
  const order = Array.from({ length: set.count }, (_, k) => k).sort((a, b) => set.height[b] - set.height[a]);
  report.tallest = order.slice(0, 15).map((k) => ({
    name: set.names[k] ?? `(unnamed ${BUILDING_KINDS[set.kind[k]]})`,
    height: Math.round(set.height[k] * 10) / 10,
    source: HEIGHT_SOURCES[set.heightSource[k] & 3],
  }));
}

async function bake(id: string): Promise<void> {
  const dir = path.join(OUT, id);
  const metaFile = path.join(dir, 'meta.json');
  if (!fs.existsSync(metaFile)) {
    log(id, 'no baked meta.json — skipping (run bake-presets.ts first)');
    return;
  }
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as PresetMeta & { files: { buildings?: string | null } };
  const { nx, ny, cellSize, bounds } = meta;
  const elevation = decodeElevation(
    new Uint8Array(fs.readFileSync(path.join(dir, meta.files.elevation))).slice().buffer,
    nx,
    ny,
  );
  const water = computeInitialWater({ nx, ny, elevation }, meta.scenario);

  const ts = tiles(bounds);
  log(id, `${ts.length} OSM tiles over ${bounds.west.toFixed(4)},${bounds.south.toFixed(4)} → ${bounds.east.toFixed(4)},${bounds.north.toFixed(4)}`);
  const xmls: string[] = [];
  for (let i = 0; i < ts.length; i++) {
    const parts = await tileXml(id, ts[i]);
    xmls.push(...parts);
    log(id, `  tile ${i + 1}/${ts.length} — ${parts.length} response(s), ${(parts.reduce((n, p) => n + p.length, 0) / 1e6).toFixed(1)} MB`);
  }
  if (FIT) fitLevels(xmls);

  const raw: RawBuilding[] = [];
  for (const xml of xmls) raw.push(...parseOSMBuildings(xml));
  log(id, `parsed ${raw.length} OSM footprints (${raw.filter((b) => b.height !== null).length} with a tagged height)`);

  const heightProfile = heightProfileFor(id);
  if (heightProfile !== 'us') log(id, `estimated-height prior: '${heightProfile}' profile`);
  let built = buildBuildingSet(raw, { nx, ny, cellSize, bounds, elevation, water, heightProfile });
  const areaKm2 = (nx * cellSize * ny * cellSize) / 1e6;
  const density = built.set.count / areaKm2;
  let msAdded = 0;
  if (FILL ?? density < MS_FILL_DENSITY) {
    log(id, `OSM density ${density.toFixed(0)} buildings/km^2 — filling the gaps from Microsoft ML footprints`);
    const ms = await msBuildings(id, bounds);
    // Only where OSM has mapped nothing: rasterise what OSM gave and skip any footprint whose centre lands on it.
    // A hand-mapped building always wins over a machine-extracted one.
    const covered = rasterizeBuildingHeights(built.set, nx, ny);
    const toGrid = makeGeoToGrid({ nx, ny, bounds });
    const keep: RawBuilding[] = [];
    for (const b of ms) {
      let sx = 0;
      let sy = 0;
      for (const p of b.ring) {
        const [gx, gy] = toGrid(p[0], p[1]);
        sx += gx;
        sy += gy;
      }
      const ci = Math.round(sx / b.ring.length - 0.5);
      const cj = Math.round(sy / b.ring.length - 0.5);
      if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) continue;
      if (covered[cj * nx + ci] > 0) continue;
      keep.push(b);
    }
    msAdded = keep.length;
    log(id, `  kept ${msAdded} of ${ms.length} Microsoft footprints (the rest overlap OSM buildings or the domain edge)`);
    built = buildBuildingSet(raw.concat(keep), {
      nx,
      ny,
      cellSize,
      bounds,
      elevation,
      water,
      heightProfile,
      attribution: msAdded > 0 ? BUILDINGS_ATTRIBUTION_OSM_MS : BUILDINGS_ATTRIBUTION_OSM,
    });
  }
  const { set, report } = built;

  // ── lidar path ─────────────────────────────────────────────────────────────────────────────
  if (LIDAR_EXPORT) {
    writeLidarExport(id, path.resolve(ROOT, LIDAR_EXPORT), set, { nx, ny, cellSize, bounds });
    return;
  }
  let lidar: ReturnType<typeof applyLidarRoofs> | null = null;
  if (LIDAR_APPLY) {
    lidar = applyLidarRoofs(id, path.resolve(ROOT, LIDAR_APPLY), set, cellSize);
    recountProvenance(set, report);
    recountTallest(set, report);
  }

  const stats = buildingStats(set);
  log(
    id,
    `kept ${report.kept} buildings, ${report.vertices} vertices · dropped ${report.droppedTiny} tiny, ` +
      `${report.droppedOutside} outside, ${report.droppedInWater} in water, ${report.duplicates} duplicate`,
  );
  log(
    id,
    `heights: ${report.measured} measured (${((100 * report.measured) / Math.max(1, report.kept)).toFixed(1)} %), ` +
      `${report.levels} from floor counts, ${report.remote} remote-sensed, ${report.estimated} estimated · ` +
      `median ${stats.medianHeight.toFixed(1)} m, max ${stats.maxHeight.toFixed(1)} m`,
  );
  const byKind = new Map<string, number>();
  for (let k = 0; k < set.count; k++) {
    const nm = BUILDING_KINDS[set.kind[k]];
    byKind.set(nm, (byKind.get(nm) ?? 0) + 1);
  }
  log(id, `kinds: ${[...byKind].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  log(id, 'tallest:');
  for (const t of report.tallest) log(id, `   ${t.height.toFixed(1)} m  ${t.source.padEnd(9)}  ${t.name}`);

  // The raster the renderer may use — built here only to time it and prove it is cheap; the loader rebuilds it.
  const t0 = performance.now();
  const raster = rasterizeBuildingHeights(set, nx, ny);
  let covered = 0;
  for (let i = 0; i < raster.length; i++) if (raster[i] > 0) covered++;
  log(id, `height raster: ${((performance.now() - t0) | 0)} ms, ${((100 * covered) / raster.length).toFixed(1)} % of cells built on`);

  // Sanity: nothing standing in the rivers.
  let inWater = 0;
  for (let k = 0; k < set.count; k++) {
    const a = set.offsets[k];
    const i = Math.max(0, Math.min(nx - 1, Math.round(set.verts[a * 2] - 0.5)));
    const j = Math.max(0, Math.min(ny - 1, Math.round(set.verts[a * 2 + 1] - 0.5)));
    if (water[j * nx + i] > 0.5) inWater++;
  }
  log(id, `buildings with a corner in the initial river: ${inWater}`);

  const compact = encodeBuildings(set);
  const json = JSON.stringify(compact);
  log(id, `buildings.json ${(json.length / 1e6).toFixed(2)} MB (${compact.b.length} rows, ${compact.names.length} names)`);
  const problems = validateCompactBuildings(compact, nx, ny);
  if (problems.length) throw new Error(`buildings.json for ${id} is invalid: ${problems.join('; ')}`);

  if (DRY) {
    log(id, 'dry run — nothing written');
    return;
  }
  fs.writeFileSync(path.join(dir, 'buildings.json'), json);
  meta.files.buildings = 'buildings.json';
  // Replace any previous buildings credit rather than appending a second one on a re-bake.
  meta.attribution = `${meta.attribution.replace(/\s*·\s*Buildings ©[^·]*/g, '').trim()} · ${set.attribution}`;
  meta.bake = {
    ...(meta.bake ?? {}),
    buildings: {
      bakedAt: new Date().toISOString(),
      source: 'OpenStreetMap API 0.6 /map (ODbL 1.0)',
      tiles: ts.length,
      microsoftFootprintsAdded: msAdded,
      // Which regional calibration produced the 'estimated' heights below (src/data/buildings.ts).
      heightProfile,
      ...(lidar
        ? {
            lidar: {
              source: 'USGS 3DEP via AWS Open Data s3://usgs-lidar-public (EPT), PA_WesternPA_1_2019 + PA_WesternPA_2_2019',
              licence: 'public domain (USGS)',
              acquired: lidar.doc.acquired,
              estimator: lidar.doc.estimator,
              groundResidualVsDemM: lidar.doc.groundResidualVsDemM,
              measured: lidar.applied,
              keptOsmBecause: lidar.doc.keptOsmBecause,
              rejectedOnApply: lidar.rejected,
            },
          }
        : {}),
      ...report,
      medianHeight: Math.round(stats.medianHeight * 10) / 10,
      maxHeight: Math.round(stats.maxHeight * 10) / 10,
      bytes: json.length,
      cellsBuiltOn: covered,
    },
  };
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 1));
  log(id, `wrote buildings.json and updated meta.json`);
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const ids = (only.length ? only : PRESETS.map((p) => p.id)).filter((id) => id !== 'sandbox');
  for (const id of ids) {
    if (!PRESETS.some((p) => p.id === id)) throw new Error(`unknown preset "${id}"`);
    await bake(id);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
