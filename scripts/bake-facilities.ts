/// <reference types="node" />
/**
 * Bake critical facilities (src/data/facilities.ts) into public/presets/<id>/facilities.json.
 *
 *   npx tsx scripts/bake-facilities.ts                 # every baked preset
 *   npx tsx scripts/bake-facilities.ts pittsburgh      # one preset
 *   options:  --refresh   re-query Overpass instead of using artifacts/bake-cache/<id>/facilities-overpass.json
 *             --dry       report, write nothing
 *
 * SOURCE: OpenStreetMap through the Overpass API (scripts/osm-fetch.ts: mirrors in order, identifying User-Agent, one
 * request at a time, cached on disk forever). One query per preset over the preset's bounds; the query text is
 * overpassFacilitiesQuery() so the app and the bake agree on the tags. © OpenStreetMap contributors, ODbL 1.0.
 *
 * The file is small (a few hundred rows of [kind, lon, lat, radius, name, id …]); the run prints its size and the
 * public/presets total against the 125 MB budget in tests/data/presets.test.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { encodeFacilities, FACILITIES_FILE, FACILITY_KINDS, overpassFacilitiesQuery, parseOverpassFacilities } from '../src/data/facilities';
import type { PresetMeta } from '../src/data/presets';
import { overpass, REPO_ROOT } from './osm-fetch';

const OUT = path.join(REPO_ROOT, 'public/presets');
const CACHE = path.join(REPO_ROOT, 'artifacts/bake-cache');
const REFRESH = process.argv.includes('--refresh');
const DRY = process.argv.includes('--dry');
const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const ids = fs
  .readdirSync(OUT, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(OUT, d.name, 'meta.json')))
  .map((d) => d.name)
  .filter((id) => !want.length || want.includes(id))
  .sort();

for (const id of ids) {
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, id, 'meta.json'), 'utf8')) as PresetMeta;
  const b = meta.bounds;
  console.log(`${id}: querying Overpass over ${b.south.toFixed(4)},${b.west.toFixed(4)},${b.north.toFixed(4)},${b.east.toFixed(4)}`);
  const body = await overpass(overpassFacilitiesQuery(b), path.join(CACHE, id, 'facilities-overpass.json'), { refresh: REFRESH });
  const json = JSON.parse(body) as { elements?: unknown[]; osm3s?: { timestamp_osm_base?: string } };
  const list = parseOverpassFacilities(json as Parameters<typeof parseOverpassFacilities>[0], b);
  const osmDate = (json.osm3s?.timestamp_osm_base ?? '').slice(0, 10);
  const counts = FACILITY_KINDS.map((k) => [k, list.filter((f) => f.kind === k).length] as const).filter(([, n]) => n > 0);
  const text = JSON.stringify(encodeFacilities(list, osmDate));
  console.log(`  ${list.length} facilities (${counts.map(([k, n]) => `${k} ${n}`).join(', ')}) from ${json.elements?.length ?? 0} OSM elements, OSM ${osmDate} → ${(text.length / 1024).toFixed(1)} KB`);
  if (!DRY) fs.writeFileSync(path.join(OUT, id, FACILITIES_FILE), text);
}

let total = 0;
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
};
walk(OUT);
console.log(`public/presets total: ${(total / 1e6).toFixed(2)} MB (budget 125 MB)`);
