/// <reference types="node" />
/**
 * OpenStreetMap downloads for the bake scripts, cached under artifacts/ (gitignored) so a re-bake never refetches.
 *
 *   npx tsx scripts/osm-fetch.ts roads <id> <west,south,east,north>   # drivable ways → artifacts/<id>-build/osm-roads.xml
 *
 * Two endpoints, both © OpenStreetMap contributors under the ODbL 1.0:
 *   • the Overpass API, for anything selective (river centrelines across 80 km of valley, named places, power plants,
 *     dams, the drivable ways of one domain). Several public instances run the same software; when the main one
 *     answers "too busy" or times out the next is tried, in order, after a pause.
 *   • the OSM API 0.6 `map` call, as a fallback for a small bbox (it refuses > 0.25 deg² or 50 000 nodes), tiled.
 *
 * USAGE POLICY. Both services ask for an identifying User-Agent, one request at a time, and no repeated heavy
 * queries (wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances, operations.osmfoundation.org/
 * policies/api). Every request here is serial, carries the User-Agent below, waits PAUSE_MS after it, and is cached
 * on disk forever (pass `refresh` to refetch) — a bake hits each endpoint once per query, ever.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GeoBounds } from '../src/contracts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
export const USER_AGENT = 'Deluge-flood-sim/0.1 (offline flood simulator; one-off preset bake)';
const PAUSE_MS = 2000;
/** Public Overpass instances, tried in order (overpass-api.de first: it is the reference instance). */
export const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run an Overpass QL query, caching the raw response at `cacheFile` (absolute or repo-relative). The query text is
 * stored beside it (`.query`) and a changed query invalidates the cache, so editing a bake cannot silently reuse the
 * answer to a different question.
 */
export async function overpass(query: string, cacheFile: string, opts: { refresh?: boolean; log?: (m: string) => void } = {}): Promise<string> {
  const file = path.isAbsolute(cacheFile) ? cacheFile : path.join(REPO_ROOT, cacheFile);
  const qfile = `${file}.query`;
  const log = opts.log ?? ((m: string) => console.log(m));
  if (!opts.refresh && fs.existsSync(file) && fs.existsSync(qfile) && fs.readFileSync(qfile, 'utf8') === query && fs.statSync(file).size > 0) {
    return fs.readFileSync(file, 'utf8');
  }
  let lastErr = '';
  for (let round = 0; round < 2; round++) {
    for (const url of OVERPASS_MIRRORS) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(240_000),
        });
        const body = await res.text();
        await sleep(PAUSE_MS);
        // Overpass reports overload and timeouts as an HTML/XML "remark" with a 200 or a 429/504; treat both as failure.
        const remark = /runtime error|too busy|Dispatcher_Client|rate_limited|timed out/i.test(body.slice(0, 4000));
        if (!res.ok || remark || body.length < 20) {
          lastErr = `${url}: HTTP ${res.status} ${body.slice(0, 200).replace(/\s+/g, ' ')}`;
          log(`  overpass: ${lastErr}`);
          continue;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
        fs.writeFileSync(qfile, query);
        log(`  overpass: ${(body.length / 1e3).toFixed(0)} kB from ${new URL(url).host} → ${path.relative(REPO_ROOT, file)}`);
        return body;
      } catch (e) {
        lastErr = `${url}: ${(e as Error).message}`;
        log(`  overpass: ${lastErr}`);
        await sleep(PAUSE_MS);
      }
    }
    await sleep(15_000);
  }
  throw new Error(`every Overpass instance failed; last: ${lastErr}`);
}

/** Overpass bbox order: south,west,north,east. */
export const ovBox = (b: GeoBounds) => `${b.south.toFixed(5)},${b.west.toFixed(5)},${b.north.toFixed(5)},${b.east.toFixed(5)}`;

/**
 * Drivable ways of a domain as OSM XML (the same element shapes the OSM API `map` call returns, which is what
 * src/data/roads.ts parseOSMXml reads). Only `highway=*` ways and their nodes — no buildings, which
 * scripts/bake-buildings.ts fetches itself.
 */
export function roadsQuery(b: GeoBounds): string {
  return `[out:xml][timeout:180];\nway["highway"](${ovBox(b)});\n(._;>;);\nout body;`;
}

export const tileKey = (b: GeoBounds) => `${b.west.toFixed(3)}_${b.south.toFixed(3)}_${b.east.toFixed(3)}_${b.north.toFixed(3)}`;

/**
 * OSM API 0.6 `map` XML for one small bbox, cached as `<cacheDir>/osm-<bbox>.xml`. A tile the API refuses as too dense
 * is split in four (returning several documents). Everything in the box comes back — that is the API — so keep tiles
 * small; the corridor fetches use 0.03°.
 */
export async function osmMapTile(b: GeoBounds, cacheDir: string, opts: { refresh?: boolean; log?: (m: string) => void; depth?: number } = {}): Promise<string[]> {
  const dir = path.isAbsolute(cacheDir) ? cacheDir : path.join(REPO_ROOT, cacheDir);
  const file = path.join(dir, `osm-${tileKey(b)}.xml`);
  const log = opts.log ?? ((m: string) => console.log(m));
  const depth = opts.depth ?? 0;
  if (!opts.refresh && fs.existsSync(file) && fs.statSync(file).size > 0) return [fs.readFileSync(file, 'utf8')];
  if (depth > 3) throw new Error(`cannot split OSM tile ${tileKey(b)} any further`);
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${b.west.toFixed(5)},${b.south.toFixed(5)},${b.east.toFixed(5)},${b.north.toFixed(5)}`;
  let res: Response | null = null;
  let body = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(120_000) });
      body = await res.text();
      await sleep(PAUSE_MS / 2);
      if (res.status !== 429 && res.status < 500) break;
      log(`  osm api: HTTP ${res.status} for ${tileKey(b)}, retrying`);
    } catch (e) {
      log(`  osm api: ${(e as Error).message} for ${tileKey(b)}, retrying`);
    }
    await sleep(10_000);
  }
  if (res && res.status === 400 && /too many nodes/i.test(body)) {
    log(`  osm api: tile ${tileKey(b)} too dense — splitting`);
    const mx = (b.west + b.east) / 2;
    const my = (b.south + b.north) / 2;
    const out: string[] = [];
    for (const q of [
      { west: b.west, south: b.south, east: mx, north: my },
      { west: mx, south: b.south, east: b.east, north: my },
      { west: b.west, south: my, east: mx, north: b.north },
      { west: mx, south: my, east: b.east, north: b.north },
    ]) {
      out.push(...(await osmMapTile(q, dir, { ...opts, depth: depth + 1 })));
    }
    return out;
  }
  if (!res || !res.ok) throw new Error(`OSM API ${res?.status ?? 'no response'} for ${tileKey(b)}: ${body.slice(0, 160)}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  return [body];
}

/** Elements of an OSM XML document (API `map` or Overpass `out body`), as plain records. */
export interface OsmDoc {
  nodes: Map<string, { lon: number; lat: number; tags: Record<string, string> }>;
  ways: Map<string, { nodes: string[]; tags: Record<string, string> }>;
}

const xmlAttr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]*)"`).exec(s)?.[1];
const unescapeXml = (s: string) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

function tagsOf(body: string): Record<string, string> {
  const tags: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const t of body.matchAll(/<tag\b[^>]*\/?>/g)) {
    const k = xmlAttr(t[0], 'k');
    const v = xmlAttr(t[0], 'v');
    if (k && v !== undefined) tags[unescapeXml(k)] = unescapeXml(v);
  }
  return tags;
}

/** Merge OSM XML documents into one element set (tiles overlap in the ways that cross them — de-duplicated by id). */
export function parseOsmDocs(xmls: string[]): OsmDoc {
  const doc: OsmDoc = { nodes: new Map(), ways: new Map() };
  for (const xml of xmls) {
    for (const m of xml.matchAll(/<node\b([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
      const id = xmlAttr(m[1], 'id');
      const lat = Number(xmlAttr(m[1], 'lat'));
      const lon = Number(xmlAttr(m[1], 'lon'));
      if (!id || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const tags = m[3] ? tagsOf(m[3]) : (Object.create(null) as Record<string, string>);
      const prev = doc.nodes.get(id);
      if (!prev || Object.keys(tags).length > Object.keys(prev.tags).length) doc.nodes.set(id, { lon, lat, tags });
    }
    for (const m of xml.matchAll(/<way\b([^>]*)>([\s\S]*?)<\/way>/g)) {
      const id = xmlAttr(m[1], 'id');
      if (!id || doc.ways.has(id)) continue;
      const nodes = [...m[2].matchAll(/<nd\b[^>]*ref="(\d+)"/g)].map((n) => n[1]);
      doc.ways.set(id, { nodes, tags: tagsOf(m[2]) });
    }
  }
  return doc;
}

/** Edge of the aligned tile grid the corridor and domain fetches share (so a tile is downloaded once). */
export const TILE_DEG = 0.03;

/** The aligned TILE_DEG tiles covering a bbox. */
export function alignedTiles(b: GeoBounds): GeoBounds[] {
  const out: GeoBounds[] = [];
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  for (let i = Math.floor(b.west / TILE_DEG); i <= Math.floor(b.east / TILE_DEG); i++) {
    for (let j = Math.floor(b.south / TILE_DEG); j <= Math.floor(b.north / TILE_DEG); j++) {
      out.push({ west: r5(i * TILE_DEG), south: r5(j * TILE_DEG), east: r5((i + 1) * TILE_DEG), north: r5((j + 1) * TILE_DEG) });
    }
  }
  return out;
}

/** The bbox a cached tile file covers, from its name (`osm-<west>_<south>_<east>_<north>.xml`), or null. */
export function tileBoundsOf(file: string): GeoBounds | null {
  const m = /osm-(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)_(-?[\d.]+)\.xml$/.exec(path.basename(file));
  return m ? { west: Number(m[1]), south: Number(m[2]), east: Number(m[3]), north: Number(m[4]) } : null;
}

async function cli(): Promise<void> {
  const [what, id, box] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const refresh = process.argv.includes('--refresh');
  if ((what !== 'roads' && what !== 'tiles') || !id || !box) {
    console.error('usage: npx tsx scripts/osm-fetch.ts roads <id> <west,south,east,north> [--refresh]   (Overpass, one file)');
    console.error('       npx tsx scripts/osm-fetch.ts tiles <cache dir> <west,south,east,north> [--refresh]   (OSM API, aligned 0.03° tiles)');
    process.exit(2);
  }
  const [west, south, east, north] = box.split(',').map(Number);
  if (what === 'tiles') {
    const tiles = alignedTiles({ west, south, east, north });
    let k = 0;
    for (const t of tiles) {
      await osmMapTile(t, id, { refresh });
      console.log(`${++k}/${tiles.length} ${tileKey(t)}`);
    }
    return;
  }
  const xml = await overpass(roadsQuery({ west, south, east, north }), `artifacts/${id}-build/osm-roads.xml`, { refresh });
  console.log(`${(xml.match(/<way /g) ?? []).length} ways`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
