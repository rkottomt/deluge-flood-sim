/**
 * Fetch the OBSERVED floods Deluge's scenarios are validated against, and derive the compact files the harness reads.
 *
 *   npx tsx scripts/validation/fetch.ts                 # fetch what is not cached yet, derive every preset
 *   npx tsx scripts/validation/fetch.ts --refresh       # re-download everything
 *   npx tsx scripts/validation/fetch.ts --preset=houston
 *
 * Raw downloads are cached under artifacts/validation/raw/ (gitignored, as every bake cache is). What is committed is
 * only the derived, grid-registered extract per preset under public/validation/<preset>/:
 *   observed.json     high-water marks (screened, merged by site), gauge peaks, the FEMA 1 % level at the stage gauge,
 *                     Copernicus EMS damage grades — each with its source, URL, licence and retrieval date
 *   fema-zones.json   the FEMA NFHL flood zones rasterised onto the preset grid, run-length encoded
 *
 * Sources (all checked for terms; see docs/VALIDATION.md "Data and licences"):
 *  • USGS STN high-water marks — https://stn.wim.usgs.gov/STNServices (USGS Flood Event Viewer). Public domain.
 *  • FEMA National Flood Hazard Layer — https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer, layers
 *    28 (Flood Hazard Zones), 16 (Base Flood Elevations), 15 (Coastal Transects). Public domain (U.S. Government work).
 *  • USGS NWIS annual peaks and site datums — https://nwis.waterdata.usgs.gov/nwis/peak, waterservices.usgs.gov. Public
 *    domain.
 *  • NOAA CO-OPS station metadata — api.tidesandcurrents.noaa.gov. Public domain.
 *  • Copernicus Emergency Management Service Rapid Mapping, EMSR927 (Nepal, Aug 2026) —
 *    https://rapidmapping.emergency.copernicus.eu. Free and open; attribution "© European Union, 2026, Copernicus EMS".
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { geoToGrid } from '../../src/data/geo';
import type { PresetMeta } from '../../src/data/presets';
import { mergeBySite, parseStnHwms, type StnHwmRecord } from '../../src/validation/hwm';
import { fillGeoJsonGeometry, rleEncode, ringToGrid, type GridSpec } from '../../src/validation/raster';
import { FT, numberField } from '../../src/validation/datum';
import {
  FEMA_CLASSES,
  type ObservedFile,
  type ObservedSource,
  type FemaZonesFile,
  type GaugePeak,
  type FemaLadder,
  type EmsDamage,
  type ParcelDamage,
} from '../../src/validation/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const RAW = path.join(ROOT, 'artifacts/validation/raw');
const OUT = path.join(ROOT, 'public/validation');
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const REFRESH = !!args.refresh;
const TODAY = new Date().toISOString().slice(0, 10);

const NFHL = 'https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer';
const STN = 'https://stn.wim.usgs.gov/STNServices';

// ─── what each preset is validated against ───────────────────────────────────────────────────────────────────────
interface PresetPlan {
  event: string;
  /** STN event id, and an optional state filter (Helene's NC marks are not in STN — see the doc). */
  stn?: { eventId: number; eventName: string; states?: string };
  gauges?: Array<{ site: string; name: string; peakDate: string }>;
  /** Stage presets: the gauge the slider reads, for the FEMA 1 % level. */
  ladderGauge?: { id: string; name: string; lon: number; lat: number; kind: 'riverine' | 'coastal' };
  fema: boolean;
  ems?: { activation: string; aoi: number; product: string; url: string };
  /** A post-flood parcel damage assessment (an ArcGIS polygon layer) and the gauged crest of the same flood. */
  damage?: { event: string; survey: string; layerUrl: string; licence: string; gauge: { site: string; name: string; peakDate: string } };
  /** Why nothing observed is available (shown in the report instead of a number). */
  none?: string;
}

const PLANS: Record<string, PresetPlan> = {
  pittsburgh: {
    event: '1936 St. Patrick’s Day flood (no surveyed marks in a public database); FEMA 1 % zone at the matching stage',
    ladderGauge: { id: 'USGS 03085152', name: 'Point gauge (Monongahela R at Point State Park)', lon: -80.0108333, lat: 40.43944444, kind: 'riverine' },
    fema: true,
  },
  johnstown: { event: '1889 South Fork Dam flood (no surveyed marks in a public database)', fema: true },
  ellicott: { event: 'July 30 2016 flash flood (no USGS STN marks; county survey not public as data)', fema: true },
  asheville: {
    event: 'Hurricane Helene, 27 Sep 2024',
    gauges: [
      { site: '03451500', name: 'French Broad River at Asheville', peakDate: '2024-09-27' },
      { site: '03451000', name: 'Swannanoa River at Biltmore', peakDate: '2024-09-27' },
    ],
    fema: true,
  },
  nashville: {
    event: 'May 2010 flood: Metro Nashville’s parcel damage assessment (no STN marks); FEMA 1 % zone at the matching stage',
    ladderGauge: { id: 'USGS 03431500', name: 'Cumberland River at Nashville', lon: -86.7726764, lat: 36.1614984, kind: 'riverine' },
    fema: true,
    damage: {
      event: 'Cumberland River flood, 1–3 May 2010',
      survey: 'Metro Nashville windshield damage assessment after the May 2010 flood: parcels whose structure was damaged “based on outward appearance” (Metro Stormwater, Metro Codes)',
      layerUrl: 'https://maps.nashville.gov/arcgis/rest/services/May2010Flood/May2010_DamageParcels/MapServer/1',
      licence: 'Public record of the Metropolitan Government of Nashville and Davidson County (MetroGIS, Metro Stormwater, Metro Codes), published as a public map service with no licence stated; used with attribution. Only a rasterised mask is committed — no owners, addresses or parcel IDs.',
      gauge: { site: '03431500', name: 'Cumberland River at Nashville', peakDate: '2010-05-03' },
    },
  },
  houston: { event: 'Hurricane Harvey, Aug 2017', stn: { eventId: 180, eventName: '2017 Harvey', states: 'TX' }, fema: true },
  boulder: { event: 'Sep 2013 Colorado Front Range flood (no STN marks inside the domain)', stn: { eventId: 11, eventName: '2013 September CO Flood', states: 'CO' }, fema: true },
  ftmyers: {
    event: 'Hurricane Ian, 28 Sep 2022',
    stn: { eventId: 325, eventName: '2022 Ian', states: 'FL' },
    ladderGauge: { id: 'NOAA 8725520', name: 'Fort Myers, Caloosahatchee River', lon: -81.8712, lat: 26.6477, kind: 'coastal' },
    fema: true,
  },
  nepal: {
    event: 'Lhende avalanche / Trishuli debris flood, 26 Aug 2026',
    ems: {
      activation: 'EMSR927',
      aoi: 3,
      product: 'GRA_MONIT01',
      url: 'https://rapidmapping.emergency.copernicus.eu/backend/EMSR927/AOI03/GRA_MONIT01/EMSR927_AOI03_GRA_MONIT01_v1.zip',
    },
    fema: false,
  },
  chamoli: { event: 'Chamoli, 7 Feb 2021', fema: false, none: 'No Copernicus EMS activation and no public surveyed flood extent or high-water marks inside the domain; the hazard chain is checked against published arrival times and reconstructed peaks instead (tests/hazard).' },
  chungthang: { event: 'South Lhonak GLOF, 4 Oct 2023', fema: false, none: 'No Copernicus EMS activation and no public surveyed flood extent or high-water marks inside the domain; the hazard chain is checked against the published arrival time and reconstructed peaks instead (tests/hazard).' },
};

// ─── download helpers (curl: the same client the bake scripts' manual steps used; it follows S3 redirects) ─────────
function cached(name: string, url: string, opts: { binary?: boolean } = {}): string {
  const file = path.join(RAW, name);
  if (!REFRESH && fs.existsSync(file) && fs.statSync(file).size > 0) return file;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  console.log(`  ↓ ${url.length > 140 ? url.slice(0, 140) + '…' : url}`);
  execFileSync('curl', ['-sSL', '--fail', '-m', '600', '-o', file, url], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (!opts.binary && fs.statSync(file).size === 0) throw new Error(`empty download: ${url}`);
  return file;
}
const readJson = <T>(file: string): T => JSON.parse(fs.readFileSync(file, 'utf8')) as T;

function loadMeta(id: string): PresetMeta {
  return readJson<PresetMeta>(path.join(ROOT, 'public/presets', id, 'meta.json'));
}
function insideBounds(meta: PresetMeta) {
  const b = meta.bounds;
  return (lon: number, lat: number) => lon >= b.west && lon <= b.east && lat >= b.south && lat <= b.north;
}
function gridOf(meta: PresetMeta): GridSpec {
  return { nx: meta.nx, ny: meta.ny, bounds: meta.bounds };
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ─── FEMA NFHL ─────────────────────────────────────────────────────────────────────────────────────────────────
interface GeoJsonFC {
  type: 'FeatureCollection';
  features: Array<{ type: 'Feature'; properties: Record<string, unknown>; geometry: { type: string; coordinates: unknown } | null }>;
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
}

function nfhlQuery(preset: string, meta: PresetMeta, layer: number, fields: string, generalize: boolean): GeoJsonFC {
  const b = meta.bounds;
  const all: GeoJsonFC = { type: 'FeatureCollection', features: [] };
  for (let page = 0, offset = 0; page < 50; page++) {
    const q = new URLSearchParams({
      where: '1=1',
      geometry: `${b.west},${b.south},${b.east},${b.north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: fields,
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: '1000',
      f: 'geojson',
    });
    // ~1 m generalisation: far below the 4.9–7.8 m cells the zones are rasterised onto, and it keeps pages small.
    if (generalize) q.set('maxAllowableOffset', '0.00001');
    const file = cached(`nfhl/${preset}-L${layer}-p${page}.geojson`, `${NFHL}/${layer}/query?${q}`);
    const fc = readJson<GeoJsonFC>(file);
    all.features.push(...fc.features);
    const more = fc.exceededTransferLimit || fc.properties?.exceededTransferLimit;
    if (!more || fc.features.length === 0) break;
    offset += fc.features.length;
  }
  return all;
}

/** FEMA zone → class (FEMA_CLASSES). */
export function femaClass(p: Record<string, unknown>): number {
  const zone = String(p.FLD_ZONE ?? '').toUpperCase();
  const sub = String(p.ZONE_SUBTY ?? '').toUpperCase();
  if (zone === 'OPEN WATER') return 4;
  if (String(p.SFHA_TF ?? '').toUpperCase() === 'T') return 1;
  if (zone === 'X' && sub.includes('0.2')) return 2;
  return 3;
}

function deriveFema(preset: string, meta: PresetMeta): { zones: FemaZonesFile; femaSources: ObservedSource[]; zonesFc: GeoJsonFC } {
  const fc = nfhlQuery(preset, meta, 28, 'FLD_ZONE,ZONE_SUBTY,SFHA_TF,STATIC_BFE,V_DATUM,LEN_UNIT,DFIRM_ID', true);
  const grid = gridOf(meta);
  const raster = new Uint8Array(meta.nx * meta.ny);
  // Paint in increasing priority so an overlap resolves to the more specific zone: minimal < 0.2 % < 1 % < open water.
  const order = [3, 2, 1, 4];
  const dfirms = new Set<string>();
  for (const cls of order) {
    for (const f of fc.features) {
      if (femaClass(f.properties) !== cls) continue;
      fillGeoJsonGeometry(raster, grid, f.geometry, cls);
      if (f.properties.DFIRM_ID) dfirms.add(String(f.properties.DFIRM_ID));
    }
  }
  const counts: Record<string, number> = {};
  for (let k = 0; k < raster.length; k++) counts[raster[k]] = (counts[raster[k]] ?? 0) + 1;
  return {
    zones: {
      version: 1,
      preset,
      nx: meta.nx,
      ny: meta.ny,
      classes: FEMA_CLASSES,
      counts,
      dfirm: [...dfirms].sort(),
      polygons: fc.features.length,
      rle: rleEncode(raster),
    },
    femaSources: [
      {
        id: 'fema-nfhl',
        title: `FEMA National Flood Hazard Layer — Flood Hazard Zones (layer 28), FIRM databases ${[...dfirms].sort().join(', ')}`,
        url: `${NFHL}/28`,
        licence: 'Public domain (U.S. Government work); FEMA NFHL terms of use',
        retrieved: TODAY,
      },
    ],
    zonesFc: fc,
  };
}

/** Distance from a point to a polyline, both in grid coordinates (cells). */
function distToPolyline(px: number, py: number, pts: number[]): number {
  let best = Infinity;
  for (let a = 0; a + 3 < pts.length; a += 2) {
    const x0 = pts[a];
    const y0 = pts[a + 1];
    const dx = pts[a + 2] - x0;
    const dy = pts[a + 3] - y0;
    const L = dx * dx + dy * dy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy)));
  }
  return best;
}

/**
 * The FEMA 1 % water level at a stage gauge.
 *  • Riverine: the Base Flood Elevation lines (layer 16) are drawn across the floodplain at whole-foot steps of the 1 %
 *    profile. The two nearest the gauge bracket it; their distance-weighted mean is the 1 % level there.
 *  • Coastal: BFE polygons include wave crest height, which a still-water stage does not. The coastal transects
 *    (layer 15) carry the 1 % STILLWATER elevation (SWEL) the zones were built from; the nearest transects' mean is used.
 */
function deriveLadder(preset: string, meta: PresetMeta, g: NonNullable<PresetPlan['ladderGauge']>): FemaLadder | null {
  const grid = gridOf(meta);
  const at = geoToGrid(grid, g.lon, g.lat);
  const cellM = meta.cellSize;
  if (g.kind === 'riverine') {
    const fc = nfhlQuery(preset, meta, 16, 'ELEV,LEN_UNIT,V_DATUM,BFE_LN_ID', false);
    const near: Array<{ d: number; elevFt: number; datum: string }> = [];
    /** Every NAVD88 BFE line in the domain, for the 1 % profile comparison (src/validation/score.ts scoreBfeProfile). */
    const bfeLines: NonNullable<FemaLadder['bfeLines']> = [];
    for (const f of fc.features) {
      const geom = f.geometry;
      if (!geom) continue;
      const lines = geom.type === 'LineString' ? [geom.coordinates as number[][]] : geom.type === 'MultiLineString' ? (geom.coordinates as number[][][]) : [];
      let d = Infinity;
      const elev = numberField(f.properties.ELEV);
      if (!Number.isFinite(elev) || String(f.properties.LEN_UNIT ?? '').toLowerCase().startsWith('m')) continue;
      for (const l of lines) {
        const pts = ringToGrid(grid, l);
        d = Math.min(d, distToPolyline(at.gx, at.gy, pts));
        if (String(f.properties.V_DATUM ?? '').toUpperCase().startsWith('NAVD')) bfeLines.push({ elevFt: elev, elev: r3(elev * FT), pts: pts.map((v) => Math.round(v * 10) / 10) });
      }
      near.push({ d: d * cellM, elevFt: elev, datum: String(f.properties.V_DATUM ?? '') });
    }
    near.sort((a, b) => a.d - b.d);
    const use = near.filter((n) => n.d <= 800).slice(0, 2);
    if (use.length === 0 || use.some((u) => !u.datum.toUpperCase().startsWith('NAVD'))) return null;
    const w = use.map((u) => 1 / Math.max(1, u.d));
    const ft = use.reduce((s, u, k) => s + u.elevFt * w[k], 0) / w.reduce((s, v) => s + v, 0);
    return {
      gauge: g.id,
      gaugeName: g.name,
      method: 'riverine BFE lines (layer 16): inverse-distance mean of the two nearest the gauge',
      levelFt: r2(ft),
      level: r3(ft * FT),
      datum: 'NAVD88',
      samples: use.map((u) => ({ distanceM: Math.round(u.d), elevationFt: u.elevFt })),
      sourceUrl: `${NFHL}/16`,
      bfeLines,
    };
  }
  const fc = nfhlQuery(preset, meta, 15, 'TRAN_LN_ID,TRAN_NO,SWEL,ELEV_UNIT,V_DATUM,WTR_NM,EVENT_TYP', false);
  const near: Array<{ d: number; swel: number; datum: string }> = [];
  for (const f of fc.features) {
    const geom = f.geometry;
    const swel = numberField(f.properties.SWEL);
    if (!geom || !Number.isFinite(swel) || swel <= 0 || swel > 50) continue;
    const lines = geom.type === 'LineString' ? [geom.coordinates as number[][]] : geom.type === 'MultiLineString' ? (geom.coordinates as number[][][]) : [];
    let d = Infinity;
    for (const l of lines) d = Math.min(d, distToPolyline(at.gx, at.gy, ringToGrid(grid, l)));
    near.push({ d: d * cellM, swel, datum: String(f.properties.V_DATUM ?? '') });
  }
  near.sort((a, b) => a.d - b.d);
  const use = near.slice(0, 3);
  if (use.length === 0 || use.some((u) => !u.datum.toUpperCase().startsWith('NAVD'))) return null;
  const ft = use.reduce((s, u) => s + u.swel, 0) / use.length;
  return {
    gauge: g.id,
    gaugeName: g.name,
    method: 'coastal transects (layer 15): mean 1 % stillwater elevation (SWEL) of the three nearest the gauge',
    levelFt: r2(ft),
    level: r3(ft * FT),
    datum: 'NAVD88',
    samples: use.map((u) => ({ distanceM: Math.round(u.d), elevationFt: u.swel })),
    sourceUrl: `${NFHL}/15`,
  };
}

// ─── USGS gauges ─────────────────────────────────────────────────────────────────────────────────────────────
function parseRdb(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter((l) => l && !l.startsWith('#'));
  if (lines.length < 2) return [];
  const head = lines[0].split('\t');
  return lines.slice(2).map((l) => {
    const c = l.split('\t');
    return Object.fromEntries(head.map((h, k) => [h, c[k] ?? '']));
  });
}

function deriveGauges(meta: PresetMeta, list: NonNullable<PresetPlan['gauges']>): GaugePeak[] {
  const out: GaugePeak[] = [];
  const grid = gridOf(meta);
  for (const g of list) {
    const site = parseRdb(fs.readFileSync(cached(`nwis/site-${g.site}.rdb`, `https://waterservices.usgs.gov/nwis/site/?format=rdb&sites=${g.site}&siteOutput=expanded`), 'utf8'))[0];
    const peaks = parseRdb(fs.readFileSync(cached(`nwis/peak-${g.site}.rdb`, `https://nwis.waterdata.usgs.gov/nwis/peak?site_no=${g.site}&agency_cd=USGS&format=rdb`), 'utf8'));
    const pk = peaks.find((p) => p.peak_dt === g.peakDate);
    if (!site || !pk) {
      console.warn(`  ! ${g.site}: no site record or no peak on ${g.peakDate}`);
      continue;
    }
    const datumFt = numberField(site.alt_va);
    if (site.alt_datum_cd !== 'NAVD88' || !Number.isFinite(datumFt)) {
      console.warn(`  ! ${g.site}: gauge datum ${site.alt_va} ${site.alt_datum_cd} is not NAVD88 — skipped`);
      continue;
    }
    const lon = numberField(site.dec_long_va);
    const lat = numberField(site.dec_lat_va);
    const stageFt = numberField(pk.gage_ht);
    // A blank field is missing, not zero (numberField): no location or no gauge height → no peak to compare.
    if (!Number.isFinite(lon) || !Number.isFinite(lat) || !Number.isFinite(stageFt)) {
      console.warn(`  ! ${g.site}: no location or no gauge height for the ${g.peakDate} peak — skipped`);
      continue;
    }
    const at = geoToGrid(grid, lon, lat);
    out.push({
      id: `USGS ${g.site}`,
      name: g.name,
      lon,
      lat,
      gx: r2(at.gx),
      gy: r2(at.gy),
      date: g.peakDate,
      stageFt,
      gaugeDatumFt: datumFt,
      datum: 'NAVD88',
      elevation: r3((stageFt + datumFt) * FT),
      dischargeCfs: Number(pk.peak_va) || null,
      codes: pk.peak_cd || '',
      datumAccuracyFt: Number(site.alt_acy_va) || null,
      source: `https://nwis.waterdata.usgs.gov/nwis/peak?site_no=${g.site}`,
    });
  }
  return out;
}

// ─── Copernicus EMS (Nepal) ───────────────────────────────────────────────────────────────────────────────────
function deriveEms(meta: PresetMeta, e: NonNullable<PresetPlan['ems']>): EmsDamage {
  const dir = path.join(RAW, `ems-${e.activation}-AOI0${e.aoi}`);
  const zip = cached(`ems-${e.activation}-AOI0${e.aoi}/${e.product}.zip`, e.url, { binary: true });
  const unz = path.join(dir, e.product);
  if (!fs.existsSync(unz) || REFRESH) {
    fs.mkdirSync(unz, { recursive: true });
    execFileSync('unzip', ['-o', '-q', zip, '-d', unz]);
  }
  const base = `${e.activation}_AOI0${e.aoi}_${e.product}`;
  const layer = (name: string) => readJson<GeoJsonFC>(path.join(unz, `${base}_${name}_v1.json`));
  const grid = gridOf(meta);
  const inside = insideBounds(meta);
  const aoi = new Uint8Array(meta.nx * meta.ny);
  for (const f of layer('areaOfInterestA').features) fillGeoJsonGeometry(aoi, grid, f.geometry, 1);
  const notAnalysed = new Uint8Array(meta.nx * meta.ny);
  for (const f of layer('notAnalysedA').features) fillGeoJsonGeometry(notAnalysed, grid, f.geometry, 1);
  for (let k = 0; k < aoi.length; k++) if (notAnalysed[k]) aoi[k] = 0;

  const grade = (p: Record<string, unknown>) => String(p.damage_gra ?? p.damage_gr ?? '').trim();
  const buildings: EmsDamage['buildings'] = [];
  for (const f of layer('builtUpP').features) {
    const g = f.geometry;
    if (!g || g.type !== 'Point') continue;
    const [lon, lat] = g.coordinates as number[];
    if (!inside(lon, lat)) continue;
    const at = geoToGrid(grid, lon, lat);
    buildings.push({ gx: r2(at.gx), gy: r2(at.gy), grade: grade(f.properties) });
  }
  const roads: EmsDamage['roads'] = [];
  for (const f of layer('transportationL').features) {
    const g = f.geometry;
    if (!g) continue;
    const lines = g.type === 'LineString' ? [g.coordinates as number[][]] : g.type === 'MultiLineString' ? (g.coordinates as number[][][]) : [];
    for (const l of lines) {
      if (!l.some((p) => inside(p[0], p[1]))) continue;
      const pts = ringToGrid(grid, l).map(r2);
      roads.push({ pts, grade: grade(f.properties), type: String(f.properties.obj_type ?? f.properties.info ?? '') });
    }
  }
  const observed = layer('observedEventA').features.map((f) => String(f.properties.obj_desc ?? ''));
  const images = layer('imageFootprintA').features.map((f) => `${f.properties.sensor_name ?? f.properties.sensor ?? ''} ${f.properties.acq_time ?? f.properties.acquisitio ?? ''}`.trim());
  return {
    activation: e.activation,
    aoi: e.aoi,
    product: e.product,
    images,
    observedEvent: observed,
    analysedRle: rleEncode(aoi),
    buildings,
    roads,
  };
}

// ─── a parcel damage assessment (Nashville, May 2010) ──────────────────────────────────────────────────────────
/** Every polygon of an ArcGIS layer that intersects the domain, paged by OBJECTID; only `fields` are requested. */
function arcgisPolygons(cacheName: string, layerUrl: string, meta: PresetMeta, fields: string): GeoJsonFC {
  const b = meta.bounds;
  const all: GeoJsonFC = { type: 'FeatureCollection', features: [] };
  for (let page = 0, offset = 0; page < 50; page++) {
    const q = new URLSearchParams({
      where: '1=1',
      geometry: `${b.west},${b.south},${b.east},${b.north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: fields,
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'OBJECTID',
      resultOffset: String(offset),
      resultRecordCount: '1000',
      f: 'geojson',
    });
    const fc = readJson<GeoJsonFC>(cached(`${cacheName}-p${page}.geojson`, `${layerUrl}/query?${q}`));
    all.features.push(...fc.features);
    const more = fc.exceededTransferLimit || fc.properties?.exceededTransferLimit;
    if (!more || fc.features.length === 0) break;
    offset += fc.features.length;
  }
  return all;
}

/**
 * The damaged parcels as a mask on the grid. A parcel paints the cells whose centres it contains; a parcel too small
 * to contain one (a condominium unit, a narrow lot) paints the cell under its vertex centroid instead, so no damaged
 * parcel is lost to the raster. Only OBJECTID is requested: the layer also carries owner names and addresses, which
 * the comparison does not need and the repo must not hold.
 */
function deriveDamage(id: string, meta: PresetMeta, d: NonNullable<PresetPlan['damage']>): ParcelDamage | null {
  const fc = arcgisPolygons(`damage/${id}`, d.layerUrl, meta, 'OBJECTID');
  const grid = gridOf(meta);
  const toGrid = (lon: number, lat: number) => geoToGrid(grid, lon, lat);
  const mask = new Uint8Array(meta.nx * meta.ny);
  let parcels = 0;
  let subCell = 0;
  for (const f of fc.features) {
    const g = f.geometry;
    if (!g) continue;
    const n = fillGeoJsonGeometry(mask, grid, g, 1);
    // Vertex centroid of the outer ring(s), for the in-domain test and the sub-cell fallback.
    const rings = g.type === 'Polygon' ? [(g.coordinates as number[][][])[0]] : g.type === 'MultiPolygon' ? (g.coordinates as number[][][][]).map((p) => p[0]) : [];
    let sx = 0;
    let sy = 0;
    let m = 0;
    for (const r of rings) for (const p of r) { sx += p[0]; sy += p[1]; m++; }
    if (m === 0) continue;
    const c = toGrid(sx / m, sy / m);
    const i = Math.floor(c.gx);
    const j = Math.floor(c.gy);
    const inside = i >= 0 && j >= 0 && i < meta.nx && j < meta.ny;
    if (n === 0 && !inside) continue;
    parcels++;
    if (n === 0) {
      subCell++;
      mask[j * meta.nx + i] = 1;
    }
  }
  const gauge = d.gauge;
  const [g] = deriveGauges(meta, [gauge]);
  if (!g) {
    console.warn(`  ! ${id}: no ${gauge.peakDate} peak at ${gauge.site} — damage comparison skipped`);
    return null;
  }
  return {
    event: d.event,
    date: gauge.peakDate,
    survey: d.survey,
    gauge: { id: g.id, name: g.name, stageFt: g.stageFt, gaugeDatumFt: g.gaugeDatumFt, datum: 'NAVD88', elevation: g.elevation, source: g.source },
    parcels,
    subCellParcels: subCell,
    maskRle: rleEncode(mask),
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────────────────────────────────────
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value) + '\n');
  console.log(`  → ${path.relative(ROOT, file)} (${(fs.statSync(file).size / 1024).toFixed(1)} kB)`);
}

function main(): void {
  const only = args.preset ? String(args.preset).split(',') : Object.keys(PLANS);
  const stnCache = new Map<number, StnHwmRecord[]>();
  for (const id of only) {
    const plan = PLANS[id];
    if (!plan) throw new Error(`no validation plan for ${id}`);
    console.log(`\n[validation] ${id} — ${plan.event}`);
    const meta = loadMeta(id);
    const sources: ObservedSource[] = [];
    const observed: ObservedFile = { version: 1, preset: id, event: plan.event, retrieved: TODAY, sources, none: plan.none ?? null };

    if (plan.stn) {
      const { eventId, states } = plan.stn;
      let recs = stnCache.get(eventId);
      if (!recs) {
        const url = `${STN}/HWMs/FilteredHWMs.json?Event=${eventId}${states ? `&States=${states}` : ''}`;
        recs = readJson<StnHwmRecord[]>(cached(`stn/hwm-${eventId}${states ? '-' + states : ''}.json`, url));
        stnCache.set(eventId, recs);
      }
      const { marks, rejected } = parseStnHwms(recs, insideBounds(meta));
      const sites = mergeBySite(marks).map((s) => {
        const at = geoToGrid(gridOf(meta), s.lon, s.lat);
        return { ...s, lon: Math.round(s.lon * 1e6) / 1e6, lat: Math.round(s.lat * 1e6) / 1e6, elevation: r3(s.elevation), spread: r3(s.spread), gx: r2(at.gx), gy: r2(at.gy) };
      });
      observed.hwm = { event: plan.stn.eventName, eventId, marksAccepted: marks.length, sites, rejected };
      sources.push({
        id: 'usgs-stn',
        title: `USGS Short-Term Network high-water marks, event ${eventId} "${plan.stn.eventName}" (USGS Flood Event Viewer)`,
        url: `${STN}/HWMs/FilteredHWMs.json?Event=${eventId}${states ? `&States=${states}` : ''}`,
        licence: 'Public domain (U.S. Geological Survey)',
        retrieved: TODAY,
      });
      console.log(`  HWM: ${marks.length} accepted marks at ${sites.length} sites, ${rejected.length} rejected`);
    }
    if (plan.gauges) {
      observed.gauges = deriveGauges(meta, plan.gauges);
      sources.push({ id: 'usgs-nwis', title: 'USGS NWIS annual peak streamflow and site datum', url: 'https://nwis.waterdata.usgs.gov/nwis/peak', licence: 'Public domain (U.S. Geological Survey)', retrieved: TODAY });
      for (const g of observed.gauges) console.log(`  gauge ${g.id}: ${g.stageFt} ft + ${g.gaugeDatumFt} ft → ${g.elevation} m NAVD88`);
    }
    if (plan.fema) {
      const { zones, femaSources } = deriveFema(id, meta);
      sources.push(...femaSources);
      writeJson(path.join(OUT, id, 'fema-zones.json'), zones);
      observed.fema = { file: 'fema-zones.json', counts: zones.counts, dfirm: zones.dfirm };
      console.log(`  FEMA: ${zones.polygons} polygons, classes ${JSON.stringify(zones.counts)}`);
      if (plan.ladderGauge) {
        const ladder = deriveLadder(id, meta, plan.ladderGauge);
        if (ladder) {
          observed.fema.ladder = ladder;
          console.log(`  FEMA 1 % level at ${ladder.gauge}: ${ladder.levelFt} ft NAVD88 (${ladder.level} m) — ${ladder.method}`);
        } else console.warn('  ! no FEMA 1 % level found near the gauge');
      }
    }
    if (plan.ems) {
      observed.ems = deriveEms(meta, plan.ems);
      sources.push({
        id: 'copernicus-ems',
        title: `Copernicus EMS Rapid Mapping ${plan.ems.activation} AOI${String(plan.ems.aoi).padStart(2, '0')} (Bidur) ${plan.ems.product} — grading product`,
        url: 'https://rapidmapping.emergency.copernicus.eu/EMSR927/',
        licence: '© European Union, 2026, Copernicus Emergency Management Service — free and open use with attribution',
        retrieved: TODAY,
      });
      const g: Record<string, number> = {};
      for (const b of observed.ems.buildings) g[b.grade] = (g[b.grade] ?? 0) + 1;
      console.log(`  EMS: ${observed.ems.buildings.length} graded buildings in the domain ${JSON.stringify(g)}, ${observed.ems.roads.length} road lines`);
    }
    if (plan.damage) {
      const dmg = deriveDamage(id, meta, plan.damage);
      if (dmg) {
        observed.damage = dmg;
        sources.push({ id: 'parcel-damage', title: plan.damage.survey, url: plan.damage.layerUrl, licence: plan.damage.licence, retrieved: TODAY });
        if (!sources.some((s) => s.id === 'usgs-nwis')) {
          sources.push({ id: 'usgs-nwis', title: 'USGS NWIS annual peak streamflow and site datum', url: 'https://nwis.waterdata.usgs.gov/nwis/peak', licence: 'Public domain (U.S. Geological Survey)', retrieved: TODAY });
        }
        console.log(`  damage: ${dmg.parcels} damaged parcels in the domain (${dmg.subCellParcels} smaller than a cell); crest ${dmg.gauge.stageFt} ft at ${dmg.gauge.id} = ${dmg.gauge.elevation} m NAVD88`);
      }
    }
    writeJson(path.join(OUT, id, 'observed.json'), observed);
  }
}

main();
