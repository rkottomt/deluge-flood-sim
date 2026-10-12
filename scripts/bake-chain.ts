/// <reference types="node" />
/**
 * Bake a preset's glacier-hazard VALLEY PROFILE, public/presets/<id>/chain.json (the ChainFile contract in
 * src/hazard/types.ts), and write the preset's HazardChainSpec into its meta.json `scenario.hazardChain`.
 *
 *   npx tsx scripts/bake-chain.ts                 # every preset with a chain definition (scripts/chain-defs.ts)
 *   npx tsx scripts/bake-chain.ts nepal           # one
 *   options: --explore  (print the routed river and every OSM power plant / dam / weir / place / gauge / named bridge
 *                        within 1.5 km of it, with its chainage — how the station tables in chain-defs.ts were checked)
 *            --refresh  (refetch the cached OSM tiles and DEM)
 *
 * Run it AFTER scripts/bake-presets.ts for the same preset: the domain entry is read from the baked meta.json.
 *
 * PIPELINE, and every number it rests on:
 *
 * 1. CENTRELINE — OpenStreetMap waterways (© OpenStreetMap contributors, ODbL 1.0). The OSM API 0.6 `map` call is
 *    fetched in 0.03° tiles along a coarse corridor (ChainDef.route ± corridorDeg) and cached in
 *    artifacts/<id>-build/chain-osm/ (gitignored). Overpass would be one query, but the public instances answered
 *    "too busy"/504 for every corridor-sized request on the day of this bake (12 Oct 2026); the tiled API call is
 *    slower and always works. `waterway=river|stream` ways become a DIRECTED graph (OSM draws waterways in the
 *    flow direction); the profile is the shortest downstream path from the node nearest ChainDef.source to the node
 *    nearest ChainDef.end. Edges against the drawn direction cost 5× (a mis-drawn way does not break the route),
 *    and way ends within 150 m of another way's node are joined at 3× (mapping gaps). The bake logs how many metres
 *    of the route needed either crutch. HydroSHEDS/HydroRIVERS was not needed: its 15 arc-second (~500 m) network is
 *    far coarser than OSM's mapped channels in these gorges, and OSM is already the licence (ODbL) the presets carry.
 *
 * 2. RESAMPLING — nodes every NODE_SPACING = 100 m of chainage along the OSM line (the last spacing is whatever is
 *    left). `lonlat` is the OSM centreline at each node.
 *
 * 3. DEM — Copernicus GLO-30 (src/data/demGlobal.ts fetchCopernicusDEM) over the corridor's bbox on a ~25 m mercator
 *    grid, then the same bare-earth filter the 2-D presets use (bareEarthFromSurface, defaults). It is a radar
 *    SURFACE model acquired 2011–2015: over a river it sees the water surface on the acquisition day, never the bed,
 *    so "zBed" below is really the low-flow water surface of that day, and structures built since are absent.
 *
 * 4. THALWEG — min elevation in a ±THALWEG_HALF = 90 m window across the centreline (OSM lines in these gorges sit
 *    tens of metres off the channel), sampled every 15 m. Then a 5-node running median (removes single-node spikes:
 *    a bridge deck, a DSM blunder), then MONOTONE AND SMOOTH (scripts/chain-profile.ts monotoneSmooth): an isotonic
 *    (pool-adjacent-violators) least-squares fit of a non-increasing bed, its pooled blocks replaced by the
 *    piecewise-linear curve through their centroids, then a ±300 m moving average. The fit is exact — zBed never
 *    rises downstream, tolerance 0 m after rounding to 1 cm, which tests/data/presets.test.ts asserts. Isotonic
 *    rather than a running minimum because DSM noise goes both ways: a running minimum ("carving") lets one false pit
 *    drag the whole reach below it down, a running maximum ("filling") lets one false sill drown it; the
 *    least-squares fit splits the difference and the bake logs the largest sill it removed and the largest pit it
 *    filled (SILL_REPORT = 10 m and up are listed by chainage, so a real dam or a landslide barrier shows up in the
 *    log rather than vanishing silently). The block interpolation is what the first bake lacked: plain isotonic
 *    output is a staircase (Nepal: 158 of 638 faces exactly flat, drops up to 45 m per 100 m node) that the router
 *    reads as a chain of pools and waterfalls.
 *
 * 5. CROSS-SECTIONS — a DEM transect perpendicular to the centreline (direction from the nodes ±300 m away) through
 *    the thalweg point, sampled every 15 m out to TRANSECT_HALF = 1,500 m each side, or until the ground stands
 *    WALL_RISE = 150 m above the bed (the valley wall; nothing the stage table reaches). Ground below the bed is
 *    clipped to it. For each stage in STAGE_LEVELS (0 … 60 m above the bed) the wetted region is the part of the
 *    transect connected to the thalweg below that stage: area by trapezoids, top width, and wetted perimeter along
 *    the ground. Where a transect runs out still wet the section gets a vertical wall there (counted in the
 *    perimeter); the bake logs how many nodes needed one. Transects at sharp bends may overlap their neighbours —
 *    the 1-D model accepts that, as every 1-D model built from cross-sections does. Finally every section's floor is
 *    widened to at least MIN_FLOOR_WIDTH = 25 m, one DEM cell (scripts/chain-profile.ts withFloor): the DEM cannot
 *    resolve a narrower channel, and the V-slot it returns instead (3 m wide at 5 m of stage in the first bake) caps
 *    the hydraulic radius of a deep flood.
 *
 * 6. MANNING n — 0.05 at every node (research spec §I.3, steep mountain rivers, clear water). The rheology of a
 *    debris flood lives in HazardChainSpec, not here.
 *
 * 7. STATIONS and STRUCTURES — coordinates from OSM elements named in chain-defs.ts (each with its node/way id) or
 *    from the cited publication, snapped to the nearest chainage (the bake fails if a station is more than its
 *    allowed offset from the river). A structure's crest = the profile bed at its chainage + its published height;
 *    its width is the section's top width at the crest; its storage curve is integrated from the upstream sections.
 *
 * 8. DOMAIN ENTRY — the preset's existing inflow source (meta.json `scenario.sources`, gx/gy/radius exactly as baked),
 *    and the chainage of the profile node nearest to it.
 *
 * Output numbers are rounded (stage 1 cm, area 1 m², width and perimeter 0.1 m, coordinates 1e-5°) to keep the file
 * well under a megabyte.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { GeoBounds, WaterSource } from '../src/contracts';
import { bareEarthFromSurface, BARE_EARTH_ALGO_VERSION, BARE_EARTH_DEFAULTS, fetchCopernicusDEM } from '../src/data/demGlobal';
import { boundsToMercator, gridToGeo, makeGeoToGrid } from '../src/data/geo';
import type { PresetMeta } from '../src/data/presets';
import type { ChainFile, ChainSection, ChainStation, ChainStructure } from '../src/hazard/types';
import { CHAIN_DEFS, type ChainDef, type LonLat } from './chain-defs';
import { flatFaces, isotonicNonIncreasing, MIN_FLOOR_WIDTH, monotoneSmooth, withFloor } from './chain-profile';
import { osmMapTile, parseOsmDocs, REPO_ROOT, TILE_DEG, type OsmDoc } from './osm-fetch';

export const NODE_SPACING = 100;
export const THALWEG_HALF = 90;
export const TRANSECT_HALF = 1500;
export const TRANSECT_STEP = 15;
export const WALL_RISE = 150;
/** Stage levels above the bed, m. The deepest published flow in either case study is 25–30 m (Chungthang, modelled). */
export const STAGE_LEVELS = [0, 0.5, 1, 2, 3, 5, 7.5, 10, 15, 20, 30, 45, 60];
export const MANNING_N = 0.05;
const SILL_REPORT = 10;
const DEM_CELL = 25;

const REFRESH = process.argv.includes('--refresh');
const EXPLORE = process.argv.includes('--explore');
const PRESETS_DIR = path.join(REPO_ROOT, 'public/presets');

const log = (id: string, ...a: unknown[]) => console.log(`[${id}]`, ...a);
const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ── Local metric frame (equirectangular about a reference latitude; < 0.1 % error over 100 km here)
interface Frame {
  toXY: (ll: LonLat) => [number, number];
  toLL: (x: number, y: number) => LonLat;
}
function frameAt(lat0: number, lon0: number): Frame {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const ky = 110_574;
  return { toXY: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * ky], toLL: (x, y) => [lon0 + x / kx, lat0 + y / ky] };
}

// ── 1. OSM corridor and route
function corridorTiles(def: ChainDef): GeoBounds[] {
  const keys = new Set<string>();
  const out: GeoBounds[] = [];
  const add = (lon: number, lat: number) => {
    for (let i = Math.floor((lon - def.corridorDeg) / TILE_DEG); i <= Math.floor((lon + def.corridorDeg) / TILE_DEG); i++) {
      for (let j = Math.floor((lat - def.corridorDeg) / TILE_DEG); j <= Math.floor((lat + def.corridorDeg) / TILE_DEG); j++) {
        const k = `${i},${j}`;
        if (keys.has(k)) continue;
        keys.add(k);
        out.push({ west: r(i * TILE_DEG, 5), south: r(j * TILE_DEG, 5), east: r((i + 1) * TILE_DEG, 5), north: r((j + 1) * TILE_DEG, 5) });
      }
    }
  };
  for (let q = 0; q + 1 < def.route.length; q++) {
    const [a, b] = [def.route[q], def.route[q + 1]];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01));
    for (let t = 0; t <= n; t++) add(a[0] + ((b[0] - a[0]) * t) / n, a[1] + ((b[1] - a[1]) * t) / n);
  }
  return out;
}

async function fetchCorridor(def: ChainDef): Promise<OsmDoc> {
  const tiles = corridorTiles(def);
  const dir = path.join(REPO_ROOT, `artifacts/${def.id}-build/chain-osm`);
  log(def.id, `OSM: ${tiles.length} tiles of ${TILE_DEG}° along the corridor (cache ${path.relative(REPO_ROOT, dir)})`);
  const xmls: string[] = [];
  let k = 0;
  for (const t of tiles) {
    xmls.push(...(await osmMapTile(t, dir, { refresh: REFRESH, log: (m) => log(def.id, m) })));
    if (++k % 20 === 0) log(def.id, `  ${k}/${tiles.length} tiles`);
  }
  return parseOsmDocs(xmls);
}

interface Route {
  coords: LonLat[];
  wayIds: string[];
  reversedM: number;
  bridgedM: number;
}

function routeRiver(def: ChainDef, doc: OsmDoc, fr: Frame): Route {
  const allowed = new Set(def.waterways ?? ['river', 'stream']);
  type Edge = { to: string; w: number; way: string; kind: 0 | 1 | 2 };
  const adj = new Map<string, Edge[]>();
  const push = (a: string, e: Edge) => {
    const l = adj.get(a);
    if (l) l.push(e);
    else adj.set(a, [e]);
  };
  const xy = (id: string) => {
    const n = doc.nodes.get(id)!;
    return fr.toXY([n.lon, n.lat]);
  };
  const dist = (a: string, b: string) => {
    const p = xy(a);
    const q = xy(b);
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  };
  const ends: string[] = [];
  const graphNodes = new Set<string>();
  const wayName = new Map<string, string>();
  for (const [wid, w] of doc.ways) {
    if (!allowed.has(w.tags.waterway ?? '')) continue;
    if (w.tags.tunnel && w.tags.tunnel !== 'culvert') continue;
    const ns = w.nodes.filter((n) => doc.nodes.has(n));
    if (ns.length < 2) continue;
    for (let i = 0; i + 1 < ns.length; i++) {
      const d = dist(ns[i], ns[i + 1]);
      push(ns[i], { to: ns[i + 1], w: d, way: wid, kind: 0 });
      push(ns[i + 1], { to: ns[i], w: 5 * d, way: wid, kind: 1 });
      graphNodes.add(ns[i]);
      graphNodes.add(ns[i + 1]);
    }
    ends.push(ns[0], ns[ns.length - 1]);
    const nm = Object.entries(w.tags)
      .filter(([k]) => /name/.test(k))
      .map(([, v]) => v)
      .join('|');
    for (const id of ns) wayName.set(id, `${wayName.get(id) ?? ''}|${nm}`);
  }
  // Gap bridging: a way end within 150 m of a node of a different way.
  const nodeList = [...graphNodes];
  const cell = 200;
  const bins = new Map<string, string[]>();
  for (const n of nodeList) {
    const [x, y] = xy(n);
    const k = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
    (bins.get(k) ?? bins.set(k, []).get(k)!).push(n);
  }
  for (const e of new Set(ends)) {
    const [x, y] = xy(e);
    const own = new Set((adj.get(e) ?? []).map((ed) => ed.to));
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const n of bins.get(`${Math.floor(x / cell) + di},${Math.floor(y / cell) + dj}`) ?? []) {
          if (n === e || own.has(n)) continue;
          const d = dist(e, n);
          if (d > 0 && d <= 150) {
            push(e, { to: n, w: 3 * d + 1, way: 'gap', kind: 2 });
            push(n, { to: e, w: 3 * d + 1, way: 'gap', kind: 2 });
          }
        }
      }
    }
  }
  const nearest = (ll: LonLat, name?: RegExp) => {
    const [x, y] = fr.toXY(ll);
    let best = '';
    let bd = Infinity;
    for (const n of nodeList) {
      if (name && !name.test(wayName.get(n) ?? '')) continue;
      const p = xy(n);
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return { id: best, d: bd };
  };
  const a = nearest(def.source.at, def.source.wayName);
  const b = nearest(def.end);
  log(def.id, `route: source snapped ${a.d.toFixed(0)} m, end snapped ${b.d.toFixed(0)} m; graph ${nodeList.length} nodes`);
  if (a.d > 1500 || b.d > 1500) throw new Error(`${def.id}: route ends are not on a mapped waterway (${a.d.toFixed(0)} m / ${b.d.toFixed(0)} m)`);
  // Dijkstra (binary heap).
  const D = new Map<string, number>([[a.id, 0]]);
  const prev = new Map<string, { from: string; e: Edge }>();
  const heap: Array<[number, string]> = [[0, a.id]];
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (rr < heap.length && heap[rr][0] < heap[m][0]) m = rr;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const pushH = (v: [number, string]) => {
    heap.push(v);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  while (heap.length) {
    const [d, u] = pop();
    if (u === b.id) break;
    if (d > (D.get(u) ?? Infinity)) continue;
    for (const e of adj.get(u) ?? []) {
      const nd = d + e.w;
      if (nd < (D.get(e.to) ?? Infinity)) {
        D.set(e.to, nd);
        prev.set(e.to, { from: u, e });
        pushH([nd, e.to]);
      }
    }
  }
  if (!D.has(b.id)) throw new Error(`${def.id}: no waterway route from source to end`);
  const ids: string[] = [b.id];
  const ways: string[] = [];
  let reversedM = 0;
  let bridgedM = 0;
  for (let u = b.id; u !== a.id; ) {
    const p = prev.get(u)!;
    const len = dist(p.from, u);
    if (p.e.kind === 1) reversedM += len;
    if (p.e.kind === 2) bridgedM += len;
    if (ways[ways.length - 1] !== p.e.way) ways.push(p.e.way);
    ids.push(p.from);
    u = p.from;
  }
  ids.reverse();
  ways.reverse();
  return { coords: ids.map((id) => [doc.nodes.get(id)!.lon, doc.nodes.get(id)!.lat]), wayIds: [...new Set(ways.filter((w) => w !== 'gap'))], reversedM, bridgedM };
}

/** Resample a polyline every `step` metres of length (local frame); returns points and their chainage. */
function resample(coords: LonLat[], fr: Frame, step: number): { pts: Array<[number, number]>; s: number[] } {
  const xy = coords.map(fr.toXY);
  const cum = [0];
  for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const L = cum[cum.length - 1];
  const s: number[] = [];
  for (let v = 0; v < L - step * 0.3; v += step) s.push(v);
  s.push(L);
  const pts: Array<[number, number]> = [];
  let j = 0;
  for (const v of s) {
    while (j + 1 < cum.length - 1 && cum[j + 1] < v) j++;
    const seg = cum[j + 1] - cum[j] || 1;
    const t = Math.min(1, Math.max(0, (v - cum[j]) / seg));
    pts.push([xy[j][0] + (xy[j + 1][0] - xy[j][0]) * t, xy[j][1] + (xy[j + 1][1] - xy[j][1]) * t]);
  }
  return { pts, s };
}

// ── 3. DEM
interface Dem {
  z: Float32Array;
  nx: number;
  ny: number;
  bounds: GeoBounds;
  toGrid: (lon: number, lat: number) => [number, number];
  tiles: string[];
  bare: { flaggedPercent: number; meanDropM: number; steepPercent: number };
}

async function corridorDem(def: ChainDef, coords: LonLat[]): Promise<Dem> {
  const padLat = (TRANSECT_HALF + 1000) / 110_574;
  const lat0 = coords.reduce((a, c) => a + c[1], 0) / coords.length;
  const padLon = (TRANSECT_HALF + 1000) / (111_320 * Math.cos((lat0 * Math.PI) / 180));
  const bounds: GeoBounds = {
    west: r(Math.min(...coords.map((c) => c[0])) - padLon, 4),
    east: r(Math.max(...coords.map((c) => c[0])) + padLon, 4),
    south: r(Math.min(...coords.map((c) => c[1])) - padLat, 4),
    north: r(Math.max(...coords.map((c) => c[1])) + padLat, 4),
  };
  const groundW = (bounds.east - bounds.west) * 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const groundH = (bounds.north - bounds.south) * 110_574;
  const nx = Math.ceil(groundW / DEM_CELL);
  const ny = Math.ceil(groundH / DEM_CELL);
  const key = JSON.stringify({ bounds, nx, ny, bare: BARE_EARTH_DEFAULTS, algo: BARE_EARTH_ALGO_VERSION });
  const dir = path.join(REPO_ROOT, `artifacts/${def.id}-build`);
  const file = path.join(dir, 'chain-dem.f32');
  const meta = path.join(dir, 'chain-dem.json');
  const merc = boundsToMercator(bounds);
  let z: Float32Array;
  let info: { key: string; tiles: string[]; bare: Dem['bare'] };
  if (!REFRESH && fs.existsSync(file) && fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8')).key === key) {
    const buf = fs.readFileSync(file);
    z = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    info = JSON.parse(fs.readFileSync(meta, 'utf8'));
    log(def.id, `DEM: cached ${nx}×${ny}`);
  } else {
    log(def.id, `DEM: Copernicus GLO-30 ${nx}×${ny} at ~${DEM_CELL} m over ${JSON.stringify(bounds)}`);
    const g = await fetchCopernicusDEM(merc, nx, ny, (m) => log(def.id, `  ${m}`));
    // Cell size of the mercator grid on the ground at the corridor's mean latitude.
    const cellSize = groundW / nx;
    const bare = bareEarthFromSurface(g.elevation, nx, ny, { cellSize });
    z = bare.ground;
    info = {
      key,
      tiles: g.tiles,
      bare: { flaggedPercent: r(bare.removedFraction * 100, 2), meanDropM: r(bare.meanRemoved, 2), steepPercent: r(bare.steepFraction * 100, 1) },
    };
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, Buffer.from(z.buffer, z.byteOffset, z.byteLength));
    fs.writeFileSync(meta, JSON.stringify(info));
  }
  log(def.id, `DEM: tiles ${info.tiles.join(', ')}; bare-earth filter flagged ${info.bare.flaggedPercent} % (mean drop ${info.bare.meanDropM} m), ${info.bare.steepPercent} % steeper than the gate`);
  return { z, nx, ny, bounds, toGrid: makeGeoToGrid({ nx, ny, bounds }), tiles: info.tiles, bare: info.bare };
}

function demAt(dem: Dem, ll: LonLat): number {
  const [gx, gy] = dem.toGrid(ll[0], ll[1]);
  const fx = Math.min(dem.nx - 1.001, Math.max(0, gx - 0.5));
  const fy = Math.min(dem.ny - 1.001, Math.max(0, gy - 0.5));
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const tx = fx - i;
  const ty = fy - j;
  const k = j * dem.nx + i;
  const z = dem.z;
  return (z[k] * (1 - tx) + z[k + 1] * tx) * (1 - ty) + (z[k + dem.nx] * (1 - tx) + z[k + dem.nx + 1] * tx) * ty;
}

// ── 4. Thalweg
/** Running median of odd width w. */
function median(v: number[], w: number): number[] {
  const h = w >> 1;
  return v.map((_, i) => {
    const win = v.slice(Math.max(0, i - h), Math.min(v.length, i + h + 1)).sort((a, b) => a - b);
    return win[win.length >> 1];
  });
}

export { isotonicNonIncreasing };

// ── 5. Sections
interface Transect {
  /** Ground elevation (clipped to the bed) at offsets k·step, k = 0 … n, on each side. */
  left: number[];
  right: number[];
}

export function stageTable(bed: number, t: Transect, step: number): { section: ChainSection; open: boolean } {
  const stage: number[] = [];
  const area: number[] = [];
  const width: number[] = [];
  const perimeter: number[] = [];
  let open = false;
  for (const h of STAGE_LEVELS) {
    const st = bed + h;
    let A = 0;
    let W = 0;
    let P = 0;
    for (const side of [t.left, t.right]) {
      let k = 0;
      for (; k + 1 < side.length; k++) {
        const d0 = st - side[k];
        const d1 = st - side[k + 1];
        if (d0 <= 0) break;
        if (d1 >= 0) {
          A += ((d0 + d1) / 2) * step;
          W += step;
          P += Math.hypot(step, side[k + 1] - side[k]);
        } else {
          const f = d0 / (d0 - d1);
          A += (d0 * f * step) / 2;
          W += f * step;
          P += Math.hypot(f * step, d0);
          break;
        }
      }
      if (k + 1 >= side.length && st - side[side.length - 1] > 0) {
        // Ran out of transect while still wet: a vertical wall at its end.
        P += st - side[side.length - 1];
        if (h <= 30) open = true;
      }
    }
    stage.push(r(st, 2));
    area.push(Math.round(A));
    width.push(r(W, 1));
    perimeter.push(r(P, 1));
  }
  return { section: { stage, area, width, perimeter }, open };
}

/** Linear interpolation of a section's value at a water-surface elevation (extrapolates the top by its last slope). */
function sectionAt(sec: ChainSection, key: 'area' | 'width', z: number): number {
  const s = sec.stage;
  if (z <= s[0]) return 0;
  for (let i = 1; i < s.length; i++) {
    if (z <= s[i]) return sec[key][i - 1] + ((sec[key][i] - sec[key][i - 1]) * (z - s[i - 1])) / (s[i] - s[i - 1]);
  }
  const n = s.length - 1;
  return key === 'area' ? sec.area[n] + sec.width[n] * (z - s[n]) : sec.width[n];
}

// ── Main bake
async function bakeChain(def: ChainDef): Promise<void> {
  const t0 = performance.now();
  const fr = frameAt(def.route[0][1], def.route[0][0]);
  const doc = await fetchCorridor(def);
  log(def.id, `OSM: ${doc.nodes.size} nodes, ${doc.ways.size} ways`);
  const route = routeRiver(def, doc, fr);
  const names = [...new Set(route.wayIds.map((w) => doc.ways.get(w)!.tags['name:en'] ?? doc.ways.get(w)!.tags.name ?? '(unnamed)'))];
  log(def.id, `route: ${route.wayIds.length} OSM ways (${names.join(' → ')}); against drawn direction ${route.reversedM.toFixed(0)} m, gap joins ${route.bridgedM.toFixed(0)} m`);

  const dem = await corridorDem(def, route.coords);
  let { pts, s } = resample(route.coords, fr, NODE_SPACING);
  log(def.id, `profile: ${(s[s.length - 1] / 1000).toFixed(1)} km, ${s.length} nodes`);

  // Tangent / normal at each node from the points ±3 nodes away.
  const normals = (P: Array<[number, number]>) =>
    P.map((_, i) => {
      const a = P[Math.max(0, i - 3)];
      const b = P[Math.min(P.length - 1, i + 3)];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [-(b[1] - a[1]) / L, (b[0] - a[0]) / L] as [number, number];
    });
  const zXY = (x: number, y: number) => demAt(dem, fr.toLL(x, y));
  const thalweg = (P: Array<[number, number]>) => {
    const N = normals(P);
    return P.map((p, i) => {
      let best = Infinity;
      let off = 0;
      for (let o = -THALWEG_HALF; o <= THALWEG_HALF; o += TRANSECT_STEP) {
        const z = zXY(p[0] + N[i][0] * o, p[1] + N[i][1] * o);
        if (z < best || (z === best && Math.abs(o) < Math.abs(off))) {
          best = z;
          off = o;
        }
      }
      return { z: best, off };
    });
  };
  let raw = thalweg(pts);

  // Trim the start: a source defined by bed elevation (Lhende: the avalanche reached the river at ~2,900 m).
  if (def.source.bedBelow !== undefined) {
    const med = median(raw.map((t) => t.z), 5);
    const i0 = med.findIndex((z) => z <= def.source.bedBelow!);
    if (i0 < 0) throw new Error(`${def.id}: the profile never drops below ${def.source.bedBelow} m`);
    log(def.id, `source: first node with bed ≤ ${def.source.bedBelow} m is ${(s[i0] / 1000).toFixed(2)} km down the mapped river; profile starts there`);
    pts = pts.slice(i0);
    raw = raw.slice(i0);
    const s0 = s[i0];
    s = s.slice(i0).map((v) => v - s0);
  }
  const n = s.length;
  const rawZ = raw.map((t) => t.z);
  const med = median(rawZ, 5);
  const wts = s.map((_, i) => (i === 0 ? s[1] - s[0] : i === n - 1 ? s[n - 1] - s[n - 2] : (s[i + 1] - s[i - 1]) / 2));
  const stair = isotonicNonIncreasing(med, wts).map((z) => r(z, 2));
  const fit = monotoneSmooth(s, med, wts).map((z) => r(z, 2));
  for (let i = 1; i < n; i++) if (fit[i] > fit[i - 1]) fit[i] = fit[i - 1]; // rounding cannot break monotonicity, but be exact
  {
    let ss = 0;
    for (let i = 0; i < n; i++) ss += (fit[i] - med[i]) ** 2;
    log(def.id, `thalweg: ${flatFaces(stair)} of ${n - 1} faces flat in the plain isotonic fit, ${flatFaces(fit)} after block interpolation and ±300 m smoothing; RMS from the median-filtered samples ${Math.sqrt(ss / n).toFixed(1)} m`);
  }
  let maxSill = 0;
  let maxPit = 0;
  const sills: string[] = [];
  for (let i = 0; i < n; i++) {
    const dz = rawZ[i] - fit[i];
    if (dz > maxSill) maxSill = dz;
    if (-dz > maxPit) maxPit = -dz;
    if (dz >= SILL_REPORT && (i === 0 || rawZ[i - 1] - fit[i - 1] < SILL_REPORT)) sills.push(`${(s[i] / 1000).toFixed(1)} km (+${dz.toFixed(0)} m)`);
  }
  log(def.id, `thalweg: ${rawZ[0].toFixed(0)} → ${rawZ[n - 1].toFixed(0)} m raw; monotone fit removed sills up to ${maxSill.toFixed(1)} m and filled pits up to ${maxPit.toFixed(1)} m`);
  if (sills.length) log(def.id, `  raw sills ≥ ${SILL_REPORT} m above the fitted bed start at: ${sills.join(', ')}`);

  // Sections through the thalweg point.
  const N = normals(pts);
  const centres = pts.map((p, i) => [p[0] + N[i][0] * raw[i].off, p[1] + N[i][1] * raw[i].off] as [number, number]);
  const sections: ChainSection[] = [];
  let openCount = 0;
  let widened = 0;
  let sumWidth10 = 0;
  for (let i = 0; i < n; i++) {
    const bed = fit[i];
    const side = (sign: 1 | -1) => {
      const out = [bed];
      for (let o = TRANSECT_STEP; o <= TRANSECT_HALF; o += TRANSECT_STEP) {
        const z = Math.max(bed, zXY(centres[i][0] + sign * N[i][0] * o, centres[i][1] + sign * N[i][1] * o));
        out.push(z);
        if (z > bed + WALL_RISE) break;
      }
      return out;
    };
    const st = stageTable(bed, { left: side(-1), right: side(1) }, TRANSECT_STEP);
    if (st.open) openCount++;
    const fl = withFloor(st.section, bed);
    if (fl.added > 0) widened++;
    const section = fl.section;
    sumWidth10 += sectionAt(section, 'width', bed + 10);
    sections.push(section);
  }
  log(def.id, `sections: mean top width at 10 m ${(sumWidth10 / n).toFixed(0)} m; ${openCount} of ${n} transects run out of DEM before 30 m of stage (vertical wall at ${TRANSECT_HALF} m); ${widened} floors widened to ${MIN_FLOOR_WIDTH} m`);

  const lonlat = pts.map((p) => fr.toLL(p[0], p[1]).map((v) => r(v, 5)) as [number, number]);
  const project = (ll: LonLat) => {
    const [x, y] = fr.toXY(ll);
    let best = { s: 0, d: Infinity, i: 0 };
    for (let i = 0; i + 1 < n; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const L2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1;
      const t = Math.max(0, Math.min(1, ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / L2));
      const d = Math.hypot(a[0] + (b[0] - a[0]) * t - x, a[1] + (b[1] - a[1]) * t - y);
      if (d < best.d) best = { s: s[i] + (s[i + 1] - s[i]) * t, d, i: t < 0.5 ? i : i + 1 };
    }
    return best;
  };

  if (EXPLORE) {
    explore(def, doc, project);
    return;
  }

  // Domain entry from the baked preset.
  const metaFile = path.join(PRESETS_DIR, def.id, 'meta.json');
  const metaText = fs.readFileSync(metaFile, 'utf8');
  const meta = JSON.parse(metaText) as PresetMeta;
  const src = meta.scenario.sources.find((x) => x.id === def.domainEntry.sourceId) as (WaterSource & { type: 'inflow' }) | undefined;
  if (!src || src.type !== 'inflow') throw new Error(`${def.id}: no inflow source "${def.domainEntry.sourceId}" in meta.json`);
  const entryLL = gridToGeo({ nx: meta.nx, ny: meta.ny, bounds: meta.bounds }, src.gx, src.gy);
  const entry = project([entryLL.lon, entryLL.lat]);
  log(def.id, `domain entry: inflow ${src.id} (${src.gx}, ${src.gy}) r=${src.radius} is ${entry.d.toFixed(0)} m from the profile, at ${(entry.s / 1000).toFixed(2)} km`);
  if (entry.d > 300) throw new Error(`${def.id}: the preset's inflow is ${entry.d.toFixed(0)} m from the routed river`);

  // Stations.
  const stations: ChainStation[] = [];
  for (const st of def.stations) {
    const p = st.atSource ? { s: 0, d: 0, i: 0 } : project(st.at);
    const maxOff = st.maxOffset ?? 600;
    log(def.id, `  station ${st.name.padEnd(36)} ${(p.s / 1000).toFixed(2).padStart(6)} km, ${p.d.toFixed(0).padStart(4)} m off the river, bed ${fit[p.i].toFixed(0)} m`);
    if (p.d > maxOff) throw new Error(`${def.id}: station ${st.name} is ${p.d.toFixed(0)} m from the river (allowed ${maxOff})`);
    // A source-station keeps its own published position (a lake centroid) when it has one, else the profile's start.
    const ll = st.atSource && st.at[0] === 0 && st.at[1] === 0 ? lonlat[0] : st.at;
    stations.push({
      s: Math.round(p.s),
      name: st.name,
      kind: st.kind,
      lat: r(ll[1], 5),
      lon: r(ll[0], 5),
      ...(st.capacityMW !== undefined ? { capacityMW: st.capacityMW } : {}),
    });
  }
  stations.push({ s: Math.round(entry.s), name: def.domainEntry.name, kind: 'domainEdge', lat: r(entryLL.lat, 5), lon: r(entryLL.lon, 5) });
  stations.sort((a, b) => a.s - b.s);

  // Structures.
  const structures: ChainStructure[] = def.structures.map((d) => {
    const p = project(d.at);
    if (p.d > 600) throw new Error(`${def.id}: structure ${d.name} is ${p.d.toFixed(0)} m from the river`);
    const bed = fit[p.i];
    const crest = r(bed + d.height, 1);
    const width = r(sectionAt(sections[p.i], 'width', crest), 1);
    const storage: Array<[number, number]> = [];
    if (d.storage) {
      for (let k = 0; k <= 10; k++) {
        const z = bed + (d.height * k) / 10;
        let V = 0;
        for (let j = p.i; j >= 0 && fit[j] < z; j--) V += sectionAt(sections[j], 'area', z) * wts[j];
        storage.push([r(z, 1), Math.round(V / 1000) * 1000]);
      }
    }
    log(def.id, `  structure ${d.name}: ${(p.s / 1000).toFixed(2)} km, ${p.d.toFixed(0)} m off, bed ${bed.toFixed(1)} + ${d.height} m = crest ${crest} m, crest width ${width} m` + (storage.length ? `, storage at crest ${(storage[storage.length - 1][1] / 1e6).toFixed(2)} Mm³` : ''));
    return { s: Math.round(p.s), name: d.name, kind: d.kind, crest, width, ...(storage.length ? { storage } : {}) };
  });

  const chain: ChainFile = {
    version: 1,
    name: def.name,
    ...(def.clockZero ? { clockZero: def.clockZero } : {}),
    s: s.map((v) => Math.round(v)),
    zBed: fit,
    n: s.map(() => MANNING_N),
    sections,
    lonlat,
    structures,
    stations,
    domainEntry: { s: Math.round(entry.s), gx: src.gx, gy: src.gy, radius: src.radius },
    attribution:
      `${def.attribution} Centreline: OpenStreetMap waterways (© OpenStreetMap contributors, ODbL 1.0), ways ${route.wayIds.slice(0, 40).join(', ')}` +
      `${route.wayIds.length > 40 ? ` and ${route.wayIds.length - 40} more` : ''}. Bed and sections: Copernicus DEM GLO-30 (© DLR e.V. 2010–2014 / © Airbus Defence and Space GmbH 2014–2018, ESA), ` +
      `tiles ${dem.tiles.join(', ')}, bare-earth filtered; a radar surface model — the "bed" is the water surface on the acquisition day. ` +
      `Baked by scripts/bake-chain.ts on ${new Date().toISOString().slice(0, 10)}.`,
  };
  const out = path.join(PRESETS_DIR, def.id, 'chain.json');
  // One key per line, arrays compact: small, and a diff still says which part changed.
  const body = `{\n${Object.entries(chain)
    .map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(',\n')}\n}\n`;
  fs.writeFileSync(out, body);
  log(def.id, `wrote ${path.relative(REPO_ROOT, out)} ${(body.length / 1e3).toFixed(0)} kB`);

  // meta.json: add (or replace) scenario.hazardChain, leaving everything else byte-for-byte as baked.
  meta.scenario.hazardChain = def.hazardChain;
  const newMeta = JSON.stringify(meta, null, 1);
  if (newMeta !== metaText) {
    fs.writeFileSync(metaFile, newMeta);
    log(def.id, `meta.json: scenario.hazardChain written`);
  }
  log(def.id, `done in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

/** --explore: what OSM knows near the routed river, with chainage, for checking the station tables by hand. */
function explore(def: ChainDef, doc: OsmDoc, project: (ll: LonLat) => { s: number; d: number }) {
  const rows: Array<{ s: number; d: number; line: string }> = [];
  const interesting = (t: Record<string, string>) =>
    t.power === 'plant' ||
    (t.power === 'generator' && /hydro/.test(t['generator:source'] ?? '')) ||
    t.waterway === 'dam' ||
    t.waterway === 'weir' ||
    t.man_made === 'monitoring_station' ||
    t.man_made === 'dam' ||
    (t.place && t.name) ||
    (t.bridge && t.highway && t.name) ||
    /hydro|power|bridge|gauge|intake|headworks/i.test(t.name ?? '');
  const add = (kind: string, id: string, ll: LonLat, t: Record<string, string>) => {
    if (!interesting(t)) return;
    const p = project(ll);
    if (p.d > 1500) return;
    const tags = Object.entries(t)
      .filter(([k]) => /^(name|name:en|power|plant|generator|waterway|place|man_made|bridge|highway|operator|start_date|height|ele)/.test(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    rows.push({ s: p.s, d: p.d, line: `${kind}/${id} ${ll[1].toFixed(5)},${ll[0].toFixed(5)} ${tags}` });
  };
  for (const [id, nd] of doc.nodes) if (Object.keys(nd.tags).length) add('node', id, [nd.lon, nd.lat], nd.tags);
  for (const [id, w] of doc.ways) {
    const ns = w.nodes.map((k) => doc.nodes.get(k)).filter((x) => x) as Array<{ lon: number; lat: number }>;
    if (!ns.length) continue;
    const c: LonLat = [ns.reduce((a, q) => a + q.lon, 0) / ns.length, ns.reduce((a, q) => a + q.lat, 0) / ns.length];
    add('way', id, c, w.tags);
  }
  rows.sort((a, b) => a.s - b.s);
  for (const x of rows) console.log(`${(x.s / 1000).toFixed(2).padStart(7)} km ${x.d.toFixed(0).padStart(5)} m  ${x.line}`);
}

async function main() {
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const defs = only.length ? CHAIN_DEFS.filter((d) => only.includes(d.id)) : CHAIN_DEFS;
  if (!defs.length) throw new Error(`unknown chain(s): ${only.join(', ')}; known: ${CHAIN_DEFS.map((d) => d.id).join(', ')}`);
  for (const d of defs) await bakeChain(d);
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('bake-chain.ts')) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
