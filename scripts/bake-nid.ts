/// <reference types="node" />
/**
 * Bake the U.S. National Inventory of Dams (USACE NID) into public/dams/nid-index.bin (format: src/dams/nidIndex.ts).
 *
 *   node --import tsx scripts/bake-nid.ts --download --cache=<dir>   # fetch the national GeoPackage (~80 MB) into <dir>
 *   node --import tsx scripts/bake-nid.ts --cache=<dir>              # bake from it
 *
 * Needs Node 22.13+ (node:sqlite reads the GeoPackage; nothing else is installed for it).
 *
 * WHY A BAKED INDEX. The NID API sends no Access-Control-Allow-Origin header to a browser page (checked October 2026),
 * so the app cannot query it; the national export is published for download. NID data are public information
 * collected by USACE from federal and state dam-safety agencies; the public export leaves out the restricted fields.
 *
 * SOURCE. https://nid.sec.usace.army.mil/api/nation/gpkg (redirects to the current national export on S3), table
 * `dams`: heights in ft, storage in acre-ft, surface area in acres, discharge in ft³/s, length in ft, WGS84 lat/lon.
 *
 * KEPT. NID storage ≥ 1,000 acre-ft, or NID height ≥ 6 m with storage ≥ 50 acre-ft (NID_INDEX_RULE), with a location.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { cleanDamName, DAM_TYPES, decodeNidIndex, encodeNidIndex, FT_M, HAZARDS, NID_ID_RE, NID_INDEX_RULE, OWNERS, STATES, type NidDam, type NidHazard } from '../src/dams/nidIndex';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'dams', 'nid-index.bin');
const SOURCE = 'https://nid.sec.usace.army.mil/api/nation/gpkg';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const cache = path.resolve(String(args.cache ?? path.join(ROOT, 'artifacts', 'bake-cache', 'nid')));
const gpkg = path.join(cache, 'nation.gpkg');

async function download(): Promise<void> {
  fs.mkdirSync(cache, { recursive: true });
  console.log(`[nid] downloading ${SOURCE} …`);
  const res = await fetch(SOURCE, { redirect: 'follow', headers: { 'user-agent': 'deluge-bake (public NID export)' } });
  if (!res.ok) throw new Error(`NID export: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('NID export: not a GeoPackage');
  fs.writeFileSync(gpkg, buf);
  console.log(`[nid] ${(buf.length / 1048576).toFixed(1)} MB → ${gpkg}`);
}

const num = (v: unknown): number => (v === null || v === undefined || v === '' ? NaN : Number(v));
const orNull = (v: number): number | null => (Number.isFinite(v) && v > 0 ? v : null);
// Normal storage keeps a reported 0: it is a value, not a gap — a dry dam (a flood-control detention dam, a tailings
// or debris basin) that holds no permanent pool. ~2,800 NID records say so; folding them into "not reported" gave
// them a sunny-day breach of half the maximum storage (src/dams/breachModel.ts damScenario).
const orNullKeepZero = (v: number): number | null => (Number.isFinite(v) && v >= 0 ? v : null);

async function bake(): Promise<void> {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(gpkg, { readOnly: true });
  const rows = db
    .prepare(
      'select name, nidId, stateKey, latitude, longitude, nidHeight, hydraulicHeight, nidStorage, normalStorage, surfaceArea, maxDischarge, damLength, yearCompleted, publicHazardId, primaryOwnerTypeId, primaryDamTypeId from dams',
    )
    .all() as Array<Record<string, unknown>>;
  const dams: NidDam[] = [];
  const skipped = { small: 0, noLocation: 0, badId: 0 };
  for (const r of rows) {
    const heightM = num(r.nidHeight) * FT_M;
    const storage = num(r.nidStorage);
    const keep = storage >= NID_INDEX_RULE.storageAcFt || (heightM >= NID_INDEX_RULE.heightM && storage >= NID_INDEX_RULE.minStorageAcFt);
    if (!keep) {
      skipped.small++;
      continue;
    }
    const lat = num(r.latitude);
    const lon = num(r.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) {
      skipped.noLocation++;
      continue;
    }
    const id = String(r.nidId ?? '').trim().toUpperCase();
    if (!NID_ID_RE.test(id)) {
      skipped.badId++;
      continue;
    }
    const hazard = (HAZARDS as readonly string[]).includes(String(r.publicHazardId)) ? (String(r.publicHazardId) as NidHazard) : 'Undetermined';
    const owner = (OWNERS as readonly string[]).includes(String(r.primaryOwnerTypeId)) ? String(r.primaryOwnerTypeId) : 'Not listed';
    const damType = (DAM_TYPES as readonly string[]).includes(String(r.primaryDamTypeId)) ? String(r.primaryDamTypeId) : 'Not listed';
    const state = (STATES as readonly string[]).includes(String(r.stateKey)) ? String(r.stateKey) : '';
    const year = num(r.yearCompleted);
    dams.push({
      id,
      name: cleanDamName(String(r.name ?? '')) || id,
      state,
      lat,
      lon,
      heightM,
      hydraulicHeightM: orNull(num(r.hydraulicHeight) * FT_M),
      storageAcFt: storage,
      normalStorageAcFt: orNullKeepZero(num(r.normalStorage)),
      surfaceAreaAc: orNull(num(r.surfaceArea)),
      maxDischargeCfs: orNull(num(r.maxDischarge)),
      lengthFt: orNull(num(r.damLength)),
      year: Number.isInteger(year) && year >= 1600 && year <= 2100 ? year : null,
      hazard,
      owner,
      damType,
    });
  }
  // Several structures can share one NID id (a reservoir's main dam and its saddle dams, told apart only by
  // otherStructureId): keep the tallest — the main dam — so an id names one dam.
  const byId = new Map<string, NidDam>();
  let shared = 0;
  for (const d of dams) {
    const prev = byId.get(d.id);
    if (prev) shared++;
    if (!prev || d.heightM > prev.heightM || (d.heightM === prev.heightM && d.storageAcFt > prev.storageAcFt)) byId.set(d.id, d);
  }
  dams.length = 0;
  dams.push(...[...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)));
  console.log(`[nid] ${shared} structures shared an NID id with a taller one and were folded into it`);
  const raw = encodeNidIndex(dams);
  const back = decodeNidIndex(raw);
  const gz = zlib.gzipSync(raw, { level: 9 });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, gz);
  const byHazard = Object.fromEntries(HAZARDS.map((h) => [h, back.dams.filter((d) => d.hazard === h).length]));
  console.log(`[nid] ${rows.length} NID records → kept ${dams.length} (skipped ${JSON.stringify(skipped)}); decoder dropped ${back.dropped}`);
  console.log(`[nid] by hazard ${JSON.stringify(byHazard)}`);
  console.log(`[nid] ${(raw.length / 1048576).toFixed(2)} MB raw → ${(gz.length / 1048576).toFixed(2)} MB gzip → ${path.relative(ROOT, OUT)}`);
}

if (args.download) await download();
if (!fs.existsSync(gpkg)) {
  console.error(`[nid] no ${gpkg}: run with --download first`);
  process.exit(2);
}
await bake();
