/// <reference types="node" />
/**
 * Bake NOAA CO-OPS Extreme Water Levels, tidal datums and NOAA 2022 sea-level-rise projections for every CO-OPS
 * station with an extreme-water-level analysis into public/surge/ewl-stations.json (format: src/surge/stations.ts).
 *
 *   node --import tsx scripts/bake-surge.ts            # fetch from the CO-OPS APIs (≈ 380 small requests) and bake
 *   node --import tsx scripts/bake-surge.ts --check    # re-read the baked file through the app's parser and print it
 *
 * SOURCES (all NOAA National Ocean Service, Center for Operational Oceanographic Products and Services; public domain):
 *   station list + EWL   https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product.json?name=extremewaterlevels
 *   exceedance levels    …/product.json?name=extremewaterlevels&station=<id>&details=exceedancelevels&levelType=high&units=metric
 *                        (annual exceedance probability levels of the GEV fit to annual maxima, metres above MHHW)
 *   datums               https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations/<id>/datums.json?units=metric
 *                        (MHHW, MSL and NAVD88 on station datum → MHHW above NAVD88, the datum of USGS 3DEP)
 *   sea-level rise       https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json
 *                        ?station=<id>&units=metric&report_year=2022&affil=US  (Sweet et al. 2022, median, zeroed 2005)
 *
 * WHY BAKED, NOT LIVE. The CO-OPS APIs do send Access-Control-Allow-Origin: * (checked October 2026), so the page COULD
 * call them — but 126 stations are 30 kB, a site check must work offline like every other ladder, and a baked table
 * adds no endpoint to the CSP. Re-bake when NOAA updates its EWL analysis.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSurgeTable, parseSurgeTable, SURGE_AEPS, type SurgeStation } from '../src/surge/stations';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'surge', 'ewl-stations.json');
const DP = 'https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi';
const MD = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';

async function json<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'deluge-bake (NOAA public data)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (attempt >= 2) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

interface EwlListEntry {
  stationId: string;
  stationName: string;
  state: string;
  epoch: string;
  latitude: number;
  longitude: number;
}
interface ExceedanceLevel {
  probability: number;
  returnPeriod: number;
  level: number;
  upper90CI: number;
  lower90CI: number;
}

const SLR_KEYS: Record<string, 'low' | 'intLow' | 'int' | 'intHigh' | 'high'> = {
  Low: 'low',
  'Intermediate-Low': 'intLow',
  Intermediate: 'int',
  'Intermediate-High': 'intHigh',
  High: 'high',
};

async function bake(): Promise<void> {
  const list = await json<{ ExtremeWaterLevels: EwlListEntry[] }>(`${DP}/product.json?name=extremewaterlevels`);
  const stations: SurgeStation[] = [];
  const skipped: string[] = [];
  for (const e of list.ExtremeWaterLevels) {
    const id = e.stationId;
    try {
      const ex = await json<{ datum: string; units: string; GEV_HI?: { exceedanceLevels: ExceedanceLevel[] } }>(
        `${DP}/product.json?name=extremewaterlevels&station=${id}&details=exceedancelevels&levelType=high&units=metric`,
      );
      if (ex.datum !== 'MHHW' || !/^met/.test(ex.units) || !ex.GEV_HI) throw new Error(`unexpected datum/units ${ex.datum}/${ex.units}`);
      const lv = ex.GEV_HI.exceedanceLevels;
      const pick = (aep: number) => lv.find((l) => Math.abs(l.probability - aep) < 1e-6);
      const levels = SURGE_AEPS.map((aep) => pick(aep));
      if (levels.some((l) => !l)) throw new Error('missing an exceedance level');
      const d = await json<{ datums: Array<{ name: string; value: number }> }>(`${MD}/stations/${id}/datums.json?units=metric`);
      const dv = (n: string) => d.datums?.find((x) => x.name === n)?.value;
      const mhhw = dv('MHHW');
      const msl = dv('MSL');
      const navd = dv('NAVD88');
      if (mhhw === undefined || msl === undefined) throw new Error('no MHHW/MSL datum');
      let slr: SurgeStation['slr'] = null;
      try {
        const s = await json<{ SlrProjections?: Array<{ scenario: string; projectionYear: number; projectionRsl: number; units: string }> }>(
          `${DP}/product/slr_projections.json?station=${id}&units=metric&report_year=2022&affil=US`,
        );
        const rows = s.SlrProjections ?? [];
        const out: Record<string, [number, number, number]> = {};
        for (const [name, key] of Object.entries(SLR_KEYS)) {
          const at = (y: number) => rows.find((r) => r.scenario === name && r.projectionYear === y);
          const v = [2050, 2080, 2100].map((y) => at(y));
          if (v.every((r) => r && r.units === 'cm' && Number.isFinite(r.projectionRsl))) out[key] = v.map((r) => Math.round(r!.projectionRsl) / 100) as [number, number, number];
        }
        if (Object.keys(out).length === 5) slr = out as NonNullable<SurgeStation['slr']>;
      } catch {
        slr = null;
      }
      const ci = pick(0.01)!;
      stations.push({
        id,
        name: e.stationName,
        state: /^[A-Z]{2}$/.test(e.state ?? '') ? e.state : '',
        lat: e.latitude,
        lon: e.longitude,
        epoch: e.epoch ?? '',
        mhhwNavd88: navd === undefined ? null : Math.round((mhhw - navd) * 1000) / 1000,
        mhhwMsl: Math.round((mhhw - msl) * 1000) / 1000,
        levels: levels.map((l) => Math.round(l!.level * 100) / 100),
        ci100: [ci.lower90CI, ci.upper90CI],
        slr,
      });
      console.log(`[surge] ${id} ${e.stationName}: 1 % ${ci.level} m above MHHW, MHHW ${navd === undefined ? 'no NAVD88' : `${(mhhw - navd).toFixed(3)} m NAVD88`}${slr ? '' : ', no SLR'}`);
    } catch (err) {
      skipped.push(`${id} ${e.stationName}: ${(err as Error).message}`);
    }
  }
  const text = encodeSurgeTable({ generated: new Date().toISOString().slice(0, 10), stations });
  const back = parseSurgeTable(text);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`[surge] ${list.ExtremeWaterLevels.length} EWL stations → ${back.stations.length} baked (${(text.length / 1024).toFixed(1)} kB); skipped ${skipped.length}`);
  for (const s of skipped) console.log(`  skipped ${s}`);
}

if (process.argv.includes('--check')) {
  const t = parseSurgeTable(fs.readFileSync(OUT, 'utf8'));
  console.log(`${t.stations.length} stations, generated ${t.generated}`);
  for (const s of t.stations.slice(0, 5)) console.log(s);
} else {
  await bake();
}
