/// <reference types="node" />
/**
 * Dev tool (not a test): bakes a real-world routing fixture for the visual harness and the real-data check.
 *
 *   node --import tsx tests/routing/tools/bakePittsburgh.ts
 *
 * Downloads, for an 8 km box spanning Pittsburgh's Point → Oakland at 1024²:
 *   • USGS 3DEP elevation (Float32 TIFF)  → artifacts/routing-pgh/elev.f32
 *   • US Census TIGERweb roads (primary, secondary, local), noded where polylines share vertices
 *                                          → artifacts/routing-pgh/roads.json
 *   • meta.json (grid, cell size, bounds, river seed + pool level)
 * artifacts/ is gitignored; nothing here ships in the app (the data module owns real loading).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fromArrayBuffer } from 'geotiff';
import type { RoadClass } from '../../../src/contracts';

const OUT = path.resolve(import.meta.dirname, '../../../artifacts/routing-pgh');
const N = 1024;
const SIZE_M = 8000;
const CENTER = { lat: 40.445, lon: -79.985 };
const R = 6378137;
const DEG = Math.PI / 180;

const merc = (lon: number, lat: number) => ({ x: R * lon * DEG, y: R * Math.log(Math.tan(Math.PI / 4 + (lat * DEG) / 2)) });
const unmerc = (x: number, y: number) => ({ lon: x / R / DEG, lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) / DEG });

const c = merc(CENTER.lon, CENTER.lat);
const half = SIZE_M / 2 / Math.cos(CENTER.lat * DEG);
const box = { xmin: c.x - half, ymin: c.y - half, xmax: c.x + half, ymax: c.y + half };
const sw = unmerc(box.xmin, box.ymin);
const ne = unmerc(box.xmax, box.ymax);
const bounds = { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat };
const cellSize = SIZE_M / N;
const toGrid = (lon: number, lat: number): [number, number] => {
  const p = merc(lon, lat);
  return [((p.x - box.xmin) / (box.xmax - box.xmin)) * N, ((box.ymax - p.y) / (box.ymax - box.ymin)) * N];
};

async function get(url: string): Promise<ArrayBuffer> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function bakeDEM(): Promise<Float32Array> {
  const url =
    'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage' +
    `?bbox=${box.xmin},${box.ymin},${box.xmax},${box.ymax}&bboxSR=3857&imageSR=3857&size=${N},${N}` +
    '&format=tiff&pixelType=F32&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image';
  const tiff = await fromArrayBuffer(await get(url));
  const img = await tiff.getImage();
  if (img.getWidth() !== N || img.getHeight() !== N) throw new Error('unexpected DEM size');
  const band = (await img.readRasters({ samples: [0] })) as unknown as ArrayLike<number>[];
  const elev = Float32Array.from(band[0]);
  for (let k = 0; k < elev.length; k++) if (!(elev[k] > -1000)) elev[k] = elev[k - 1] ?? 220;
  return elev;
}

type Feature = { geometry: { type: string; coordinates: number[][] | number[][][] } | null; properties: Record<string, unknown> };

function classOf(mtfcc: string): RoadClass | null {
  if (mtfcc === 'S1100') return 'highway';
  if (mtfcc === 'S1200') return 'major';
  if (mtfcc === 'S1400' || mtfcc === 'S1730') return 'local';
  if (mtfcc === 'S1630' || mtfcc === 'S1640') return 'minor';
  return null; // walkways, stairs, parking lots, private & 4WD tracks
}

async function bakeRoads() {
  const seen = new Set<string>();
  const lines: Array<{ cls: RoadClass; name: string; pts: Array<[number, number]> }> = [];
  const T = 4;
  for (const layer of [2, 6, 8]) {
    for (let ty = 0; ty < T; ty++) {
      for (let tx = 0; tx < T; tx++) {
        const w = bounds.west + ((bounds.east - bounds.west) * tx) / T;
        const e = bounds.west + ((bounds.east - bounds.west) * (tx + 1)) / T;
        const s = bounds.south + ((bounds.north - bounds.south) * ty) / T;
        const n = bounds.south + ((bounds.north - bounds.south) * (ty + 1)) / T;
        const url =
          `https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer/${layer}/query` +
          `?geometry=${w},${s},${e},${n}&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326` +
          '&outFields=OBJECTID,NAME,MTFCC&returnGeometry=true&f=geojson';
        const json = JSON.parse(new TextDecoder().decode(await get(url))) as { features: Feature[]; exceededTransferLimit?: boolean };
        if (json.exceededTransferLimit) console.warn(`layer ${layer} tile ${tx},${ty}: transfer limit exceeded`);
        for (const f of json.features ?? []) {
          const id = `${layer}:${f.properties.OBJECTID}`;
          if (seen.has(id) || !f.geometry) continue;
          seen.add(id);
          const cls = classOf(String(f.properties.MTFCC ?? ''));
          if (!cls) continue;
          const parts = (f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates]) as number[][][];
          for (const part of parts) lines.push({ cls, name: String(f.properties.NAME ?? ''), pts: part.map(([lon, lat]) => toGrid(lon, lat)) });
        }
        process.stdout.write('.');
      }
    }
  }
  console.log(`\n${lines.length} TIGER polylines`);

  // Node where polylines share a vertex (quantized to 1 m) and at every polyline end.
  const key = (p: [number, number]) => `${Math.round(p[0] * cellSize)}|${Math.round(p[1] * cellSize)}`;
  const count = new Map<string, number>();
  for (const l of lines) {
    let last = '';
    l.pts.forEach((p, i) => {
      const k = key(p);
      if (k === last) return;
      last = k;
      const endpoint = i === 0 || i === l.pts.length - 1;
      count.set(k, (count.get(k) ?? 0) + (endpoint ? 2 : 1));
    });
  }
  const nodeId = new Map<string, number>();
  const nodes: number[] = [];
  const node = (p: [number, number]) => {
    const k = key(p);
    let id = nodeId.get(k);
    if (id === undefined) {
      id = nodes.length / 2;
      nodeId.set(k, id);
      nodes.push(Math.round(p[0] * 100) / 100, Math.round(p[1] * 100) / 100);
    }
    return id;
  };
  const edges: Array<{ a: number; b: number; length: number; cls: RoadClass; name?: string; pts: number[] }> = [];
  for (const l of lines) {
    let cur: Array<[number, number]> = [];
    let last = '';
    for (const p of l.pts) {
      const k = key(p);
      if (k === last) continue;
      last = k;
      cur.push(p);
      if (cur.length > 1 && (count.get(k) ?? 0) >= 2) {
        const a = node(cur[0]);
        const b = node(cur[cur.length - 1]);
        let len = 0;
        for (let i = 1; i < cur.length; i++) len += Math.hypot(cur[i][0] - cur[i - 1][0], cur[i][1] - cur[i - 1][1]);
        if (a !== b || cur.length > 2) {
          edges.push({
            a,
            b,
            length: Math.round(len * cellSize * 10) / 10,
            cls: l.cls,
            ...(l.name ? { name: l.name } : {}),
            pts: cur.flatMap(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]),
          });
        }
        cur = [p];
      }
    }
  }
  console.log(`${nodes.length / 2} nodes, ${edges.length} edges`);
  return { nodes, edges };
}

fs.mkdirSync(OUT, { recursive: true });
const [elev, roads] = await Promise.all([bakeDEM(), bakeRoads()]);
fs.writeFileSync(path.join(OUT, 'elev.f32'), Buffer.from(elev.buffer));
fs.writeFileSync(path.join(OUT, 'roads.json'), JSON.stringify(roads));

// River seed: the lowest cell near the Point (confluence of the Allegheny and Monongahela).
const [pgx, pgy] = toGrid(-80.0135, 40.4415);
let seed = { i: Math.floor(pgx), j: Math.floor(pgy) };
for (let j = Math.floor(pgy) - 25; j <= Math.floor(pgy) + 25; j++) {
  for (let i = Math.floor(pgx) - 25; i <= Math.floor(pgx) + 25; i++) {
    if (i >= 0 && j >= 0 && i < N && j < N && elev[j * N + i] < elev[seed.j * N + seed.i]) seed = { i, j };
  }
}
const pool = elev[seed.j * N + seed.i];
const shelters = [
  { name: 'Cathedral of Learning', lon: -79.9532, lat: 40.4443 },
  { name: 'Grandview Park, Mount Washington', lon: -80.0125, lat: 40.4318 },
  { name: 'Troy Hill', lon: -79.9855, lat: 40.4595 },
].map((s) => {
  const [gx, gy] = toGrid(s.lon, s.lat);
  return { name: s.name, gx, gy };
});
fs.writeFileSync(
  path.join(OUT, 'meta.json'),
  JSON.stringify({ nx: N, ny: N, cellSize, bounds, seed, poolLevel: pool, shelters }, null, 2),
);
console.log(`baked → ${OUT} (pool ${pool.toFixed(2)} m at cell ${seed.i},${seed.j})`);
