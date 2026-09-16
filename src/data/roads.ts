/**
 * Road networks: TIGERweb (US Census) fetch, OSM API XML fallback, noded graph construction in grid coordinates,
 * and the compact roads.json format used by baked presets.
 *
 * Graph construction (`buildRoadNetwork`):
 *   1. Project polylines to grid coords and clip them to the domain.
 *   2. Snap vertices to ~1 m (hash grid with neighbor lookup), drop consecutive duplicates.
 *   3. A vertex becomes a graph node if it is a polyline endpoint or is used more than once (shared by several
 *      polylines, or revisited by the same one). Polylines are split at nodes into edges.
 *   4. Identical edges from overlapping layers are deduplicated (keeping the higher class).
 *   5. Degree-2 nodes joining two edges of the same class and compatible names are merged away.
 *   6. Connected components shorter than `minComponentMeters` in total are dropped.
 *   7. Lengths are ground meters (grid length × cellSize).
 */
import type { GeoBounds, ProgressFn, RoadClass, RoadEdge, RoadNetwork } from '../contracts';
import { makeGeoToGrid } from './geo';
import { fetchBytes, fetchJSON } from './net';

export const TIGERWEB_TRANSPORT = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/Transportation/MapServer';
export const ROADS_ATTRIBUTION_TIGER = 'Roads: U.S. Census Bureau TIGER/Line';
export const ROADS_ATTRIBUTION_OSM = 'Roads © OpenStreetMap contributors';

/** A polyline in lon/lat with attributes, before graph construction. */
export interface RawRoad {
  /** [lon, lat] pairs. */
  coords: Array<[number, number]>;
  cls: RoadClass;
  name?: string;
}

const CLASS_RANK: Record<RoadClass, number> = { highway: 3, major: 2, minor: 1, local: 0 };
export const ROAD_CLASSES: RoadClass[] = ['highway', 'major', 'minor', 'local'];

/**
 * TIGER MTFCC → road class. Returns null for features that are not drivable streets (walkways, stairways,
 * parking-lot aisles, bike/bridle paths, 4WD trails, private service roads).
 */
export function classifyMTFCC(mtfcc: string | undefined): RoadClass | null {
  switch (mtfcc) {
    case 'S1100':
      return 'highway';
    case 'S1200':
      return 'major';
    case 'S1400':
      return 'local';
    case 'S1730': // alley
      return 'local';
    case 'S1630': // ramp
    case 'S1640': // service drive along a limited-access highway
      return 'minor';
    case 'S1500':
    case 'S1710':
    case 'S1720':
    case 'S1740':
    case 'S1750':
    case 'S1780':
    case 'S1820':
    case 'S1830':
      return null;
    default:
      return mtfcc && mtfcc.startsWith('S1') ? 'minor' : null;
  }
}

/** OSM highway=* → road class, or null for non-drivable / irrelevant ways. */
export function classifyOSMHighway(v: string | undefined): RoadClass | null {
  if (!v) return null;
  const base = v.replace(/_link$/, '');
  if (base === 'motorway' || base === 'trunk') return v.endsWith('_link') ? 'minor' : 'highway';
  if (base === 'primary' || base === 'secondary') return 'major';
  if (base === 'tertiary' || base === 'unclassified') return 'minor';
  if (v === 'residential' || v === 'living_street' || v === 'road') return 'local';
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Fetching
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface GeoJSONFeature {
  geometry: { type: string; coordinates: unknown } | null;
  properties: { NAME?: string | null; MTFCC?: string } | null;
}

/** Query one TIGERweb layer (paginated) for an envelope. */
async function fetchTigerLayer(layer: number, b: GeoBounds, signal?: AbortSignal): Promise<GeoJSONFeature[]> {
  const out: GeoJSONFeature[] = [];
  const pageSize = 20000;
  for (let offset = 0; offset < 400000; offset += pageSize) {
    const url =
      `${TIGERWEB_TRANSPORT}/${layer}/query?geometry=${b.west},${b.south},${b.east},${b.north}` +
      `&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects` +
      `&outFields=NAME,MTFCC&returnGeometry=true&orderByFields=OBJECTID&resultOffset=${offset}` +
      `&resultRecordCount=${pageSize}&f=geojson`;
    const json = await fetchJSON<{
      features?: GeoJSONFeature[];
      exceededTransferLimit?: boolean;
      properties?: { exceededTransferLimit?: boolean };
    }>(url, { timeoutMs: 90000, retries: 2, signal });
    const feats = json.features ?? [];
    out.push(...feats);
    const more = json.exceededTransferLimit || json.properties?.exceededTransferLimit;
    if (!more && feats.length < pageSize) break;
    if (feats.length === 0) break;
  }
  return out;
}

/** Fetch primary (2), secondary (6) and local (8) roads from TIGERweb as raw polylines. */
export async function fetchTigerRoads(b: GeoBounds, onProgress?: ProgressFn, signal?: AbortSignal): Promise<RawRoad[]> {
  const layers = [2, 6, 8];
  let done = 0;
  onProgress?.('Requesting roads (US Census TIGERweb)…', 0);
  const results = await Promise.all(
    layers.map(async (l) => {
      const f = await fetchTigerLayer(l, b, signal);
      onProgress?.(`Roads: ${++done}/${layers.length} layers`, done / layers.length);
      return f;
    }),
  );
  const roads: RawRoad[] = [];
  for (const feats of results) {
    for (const f of feats) {
      const cls = classifyMTFCC(f.properties?.MTFCC);
      if (!cls || !f.geometry) continue;
      const name = f.properties?.NAME ?? undefined;
      const g = f.geometry;
      const lines: unknown[] = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? (g.coordinates as unknown[]) : [];
      for (const line of lines) {
        const coords = (line as number[][]).filter((c) => c.length >= 2).map((c) => [c[0], c[1]] as [number, number]);
        if (coords.length >= 2) roads.push({ coords, cls, name: name || undefined });
      }
    }
  }
  return roads;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return XML_ENTITIES[e] ?? m;
  });
}
function attr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`)) ?? tag.match(new RegExp(`\\s${name}='([^']*)'`));
  return m ? decodeXml(m[1]) : undefined;
}

/** Parse an OSM API 0.6 XML map response into raw road polylines (no DOMParser needed; works in Node). */
export function parseOSMXml(xml: string): RawRoad[] {
  const nodes = new Map<string, [number, number]>();
  for (const m of xml.matchAll(/<node\b[^>]*>/g)) {
    const id = attr(m[0], 'id');
    const lat = attr(m[0], 'lat');
    const lon = attr(m[0], 'lon');
    if (id && lat && lon) nodes.set(id, [Number(lon), Number(lat)]);
  }
  const roads: RawRoad[] = [];
  for (const m of xml.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
    const body = m[1];
    const tags: Record<string, string> = {};
    for (const t of body.matchAll(/<tag\b[^>]*\/?>/g)) {
      const k = attr(t[0], 'k');
      const v = attr(t[0], 'v');
      if (k && v !== undefined) tags[k] = v;
    }
    const cls = classifyOSMHighway(tags.highway);
    if (!cls) continue;
    const coords: Array<[number, number]> = [];
    for (const nd of body.matchAll(/<nd\b[^>]*\/?>/g)) {
      const p = nodes.get(attr(nd[0], 'ref') ?? '');
      if (p) coords.push(p);
    }
    if (coords.length >= 2) roads.push({ coords, cls, name: tags.name });
  }
  return roads;
}

/** OSM API fallback — only for small areas (the API refuses > 0.25 deg² or > 50k nodes). */
export async function fetchOSMRoads(b: GeoBounds, onProgress?: ProgressFn, signal?: AbortSignal): Promise<RawRoad[]> {
  const area = (b.east - b.west) * (b.north - b.south);
  if (area > 0.02) throw new Error('Area too large for the OSM API fallback');
  onProgress?.('Requesting roads (OpenStreetMap)…', 0);
  const url = `https://api.openstreetmap.org/api/0.6/map?bbox=${b.west},${b.south},${b.east},${b.north}`;
  const buf = await fetchBytes(url, { timeoutMs: 90000, retries: 1, signal });
  onProgress?.('Roads received', 1);
  return parseOSMXml(new TextDecoder().decode(buf));
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Graph construction
// ──────────────────────────────────────────────────────────────────────────────────────────────

export interface BuildOptions {
  /** Snap tolerance in meters. Default 1. */
  snapMeters?: number;
  /** Components with total length below this are dropped. Default 150 m. */
  minComponentMeters?: number;
  /** Merge degree-2 chains. Default true. */
  mergeDegree2?: boolean;
}

/** Liang–Barsky clip of segment p→q to [x0,x1]×[y0,y1]; returns t-range or null. */
function clipSegment(px: number, py: number, qx: number, qy: number, x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = qx - px;
  const dy = qy - py;
  const P = [-dx, dx, -dy, dy];
  const Q = [px - x0, x1 - px, py - y0, y1 - py];
  for (let k = 0; k < 4; k++) {
    if (P[k] === 0) {
      if (Q[k] < 0) return null;
    } else {
      const t = Q[k] / P[k];
      if (P[k] < 0) {
        if (t > t1) return null;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return null;
        if (t < t1) t1 = t;
      }
    }
  }
  return [t0, t1];
}

/** Clip a grid-coordinate polyline to the rectangle, returning the inside pieces. */
export function clipPolyline(pts: number[], x0: number, y0: number, x1: number, y1: number): number[][] {
  const pieces: number[][] = [];
  let cur: number[] | null = null;
  for (let s = 0; s + 3 < pts.length; s += 2) {
    const px = pts[s];
    const py = pts[s + 1];
    const qx = pts[s + 2];
    const qy = pts[s + 3];
    const c = clipSegment(px, py, qx, qy, x0, y0, x1, y1);
    if (!c) {
      if (cur) pieces.push(cur);
      cur = null;
      continue;
    }
    const [ta, tb] = c;
    const ax = px + (qx - px) * ta;
    const ay = py + (qy - py) * ta;
    const bx = px + (qx - px) * tb;
    const by = py + (qy - py) * tb;
    if (!cur || ta > 0) {
      if (cur) pieces.push(cur);
      cur = [ax, ay];
    }
    cur.push(bx, by);
    if (tb < 1) {
      pieces.push(cur);
      cur = null;
    }
  }
  if (cur) pieces.push(cur);
  return pieces.filter((p) => p.length >= 4);
}

interface WorkEdge {
  a: number;
  b: number;
  /** Vertex ids (snapped) from a to b. */
  verts: number[];
  cls: RoadClass;
  name?: string;
  dead?: boolean;
}

/**
 * Build a noded, undirected road graph in grid coordinates from lon/lat polylines.
 * `toGrid` maps lon/lat → grid coords; the domain is [0,nx]×[0,ny] and cells are `cellSize` meters.
 */
export function buildRoadNetwork(
  roads: RawRoad[],
  grid: { nx: number; ny: number; cellSize: number; toGrid: (lon: number, lat: number) => [number, number] },
  opts: BuildOptions = {},
): RoadNetwork {
  const { nx, ny, cellSize, toGrid } = grid;
  const snapCells = (opts.snapMeters ?? 1) / cellSize;
  const minComp = opts.minComponentMeters ?? 150;

  // ── Snapped vertex table.
  const vx: number[] = [];
  const vy: number[] = [];
  const cellMap = new Map<number, number[]>();
  const HASH = 65536;
  const vertexId = (x: number, y: number): number => {
    const qx = Math.floor(x / snapCells);
    const qy = Math.floor(y / snapCells);
    let best = -1;
    let bestD = snapCells * snapCells;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = cellMap.get((qx + dx) * HASH + (qy + dy));
        if (!list) continue;
        for (const id of list) {
          const d = (vx[id] - x) ** 2 + (vy[id] - y) ** 2;
          if (d <= bestD) {
            bestD = d;
            best = id;
          }
        }
      }
    }
    if (best >= 0) return best;
    const id = vx.length;
    vx.push(x);
    vy.push(y);
    const key = qx * HASH + qy;
    const list = cellMap.get(key);
    if (list) list.push(id);
    else cellMap.set(key, [id]);
    return id;
  };

  // ── Project, clip, snap.
  const EPS = 1e-4;
  const lines: Array<{ verts: number[]; cls: RoadClass; name?: string }> = [];
  for (const r of roads) {
    const flat: number[] = [];
    for (const [lon, lat] of r.coords) {
      const [gx, gy] = toGrid(lon, lat);
      flat.push(gx, gy);
    }
    for (const piece of clipPolyline(flat, EPS, EPS, nx - EPS, ny - EPS)) {
      const verts: number[] = [];
      for (let q = 0; q < piece.length; q += 2) {
        const id = vertexId(piece[q], piece[q + 1]);
        if (verts.length === 0 || verts[verts.length - 1] !== id) verts.push(id);
      }
      if (verts.length >= 2) lines.push({ verts, cls: r.cls, name: r.name?.trim() || undefined });
    }
  }

  // ── Node detection: endpoints and vertices used more than once.
  const uses = new Uint32Array(vx.length);
  const isNode = new Uint8Array(vx.length);
  for (const l of lines) {
    for (const v of l.verts) uses[v]++;
    isNode[l.verts[0]] = 1;
    isNode[l.verts[l.verts.length - 1]] = 1;
  }
  for (let v = 0; v < vx.length; v++) if (uses[v] > 1) isNode[v] = 1;

  // ── Split at nodes; dedupe identical edges.
  let edges: WorkEdge[] = [];
  const dedupe = new Map<string, number>();
  for (const l of lines) {
    let start = 0;
    for (let q = 1; q < l.verts.length; q++) {
      if (!isNode[l.verts[q]]) continue;
      const verts = l.verts.slice(start, q + 1);
      start = q;
      const fwd = verts.join(',');
      const key = verts[0] <= verts[verts.length - 1] ? fwd : verts.slice().reverse().join(',');
      const prev = dedupe.get(key);
      if (prev !== undefined) {
        const e = edges[prev];
        if (CLASS_RANK[l.cls] > CLASS_RANK[e.cls]) e.cls = l.cls;
        if (!e.name && l.name) e.name = l.name;
        continue;
      }
      dedupe.set(key, edges.length);
      edges.push({ a: verts[0], b: verts[verts.length - 1], verts, cls: l.cls, name: l.name });
    }
  }

  // ── Adjacency (edge ends per node).
  const adj = new Map<number, number[]>();
  const addAdj = (v: number, e: number) => {
    const list = adj.get(v);
    if (list) list.push(e);
    else adj.set(v, [e]);
  };
  edges.forEach((e, idx) => {
    addAdj(e.a, idx);
    addAdj(e.b, idx);
  });

  // ── Merge degree-2 chains.
  if (opts.mergeDegree2 ?? true) {
    const namesCompatible = (x?: string, y?: string) => !x || !y || x === y;
    const work = [...adj.keys()];
    for (const v of work) {
      const list = adj.get(v);
      if (!list || list.length !== 2) continue;
      const [e1i, e2i] = list;
      if (e1i === e2i) continue; // closed loop through v
      const e1 = edges[e1i];
      const e2 = edges[e2i];
      if (e1.dead || e2.dead || e1.cls !== e2.cls || !namesCompatible(e1.name, e2.name)) continue;
      // Orient e1 to end at v and e2 to start at v.
      const v1 = e1.b === v ? e1.verts : e1.verts.slice().reverse();
      const v2 = e2.a === v ? e2.verts : e2.verts.slice().reverse();
      const other1 = v1[0];
      const other2 = v2[v2.length - 1];
      if (other1 === v || other2 === v) continue;
      e1.verts = v1.concat(v2.slice(1));
      e1.a = other1;
      e1.b = other2;
      e1.name = e1.name ?? e2.name;
      e2.dead = true;
      adj.delete(v);
      const l2 = adj.get(other2)!;
      const pos = l2.indexOf(e2i);
      if (pos >= 0) l2[pos] = e1i;
    }
    edges = edges.filter((e) => !e.dead);
  }

  // ── Lengths.
  const lengthOf = (e: WorkEdge) => {
    let L = 0;
    for (let q = 1; q < e.verts.length; q++) L += Math.hypot(vx[e.verts[q]] - vx[e.verts[q - 1]], vy[e.verts[q]] - vy[e.verts[q - 1]]);
    return L * cellSize;
  };
  const lengths = edges.map(lengthOf);

  // ── Drop tiny components (union-find over vertex ids) and degenerate edges.
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) {
      const n = parent.get(c)!;
      parent.set(c, r);
      c = n;
    }
    return r;
  };
  for (const e of edges) {
    if (!parent.has(e.a)) parent.set(e.a, e.a);
    if (!parent.has(e.b)) parent.set(e.b, e.b);
    const ra = find(e.a);
    const rb = find(e.b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const compLen = new Map<number, number>();
  edges.forEach((e, idx) => {
    const r = find(e.a);
    compLen.set(r, (compLen.get(r) ?? 0) + lengths[idx]);
  });

  // ── Emit compacted network.
  const nodeIndex = new Map<number, number>();
  const nodeXY: number[] = [];
  const outEdges: RoadEdge[] = [];
  const nodeOf = (v: number) => {
    let id = nodeIndex.get(v);
    if (id === undefined) {
      id = nodeXY.length / 2;
      nodeIndex.set(v, id);
      nodeXY.push(vx[v], vy[v]);
    }
    return id;
  };
  edges.forEach((e, idx) => {
    if (lengths[idx] < 0.5 && e.a === e.b) return;
    if ((compLen.get(find(e.a)) ?? 0) < minComp) return;
    const pts = new Float32Array(e.verts.length * 2);
    e.verts.forEach((v, q) => {
      pts[q * 2] = vx[v];
      pts[q * 2 + 1] = vy[v];
    });
    outEdges.push({ a: nodeOf(e.a), b: nodeOf(e.b), length: lengths[idx], cls: e.cls, name: e.name, pts });
  });
  return { nodes: Float32Array.from(nodeXY), edges: outEdges };
}

/** Convenience: fetch roads for a domain (TIGERweb → OSM fallback) and build the graph. Null on failure. */
export async function fetchRoadNetwork(
  terrain: { nx: number; ny: number; cellSize: number; bounds: GeoBounds },
  onProgress?: ProgressFn,
  signal?: AbortSignal,
): Promise<{ network: RoadNetwork; attribution: string } | null> {
  const toGrid = makeGeoToGrid(terrain);
  const grid = { nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize, toGrid };
  try {
    const raw = await fetchTigerRoads(terrain.bounds, onProgress, signal);
    if (raw.length > 0) return { network: buildRoadNetwork(raw, grid), attribution: ROADS_ATTRIBUTION_TIGER };
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[data] TIGERweb roads failed:', e);
  }
  try {
    const raw = await fetchOSMRoads(terrain.bounds, onProgress, signal);
    if (raw.length > 0) return { network: buildRoadNetwork(raw, grid), attribution: ROADS_ATTRIBUTION_OSM };
  } catch (e) {
    if (signal?.aborted) throw e;
    console.warn('[data] OSM roads fallback failed:', e);
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Compact serialization (roads.json)
// ──────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Compact JSON: grid coords quantized to 1/scale cell and delta-encoded.
 *   { v: 1, scale, names: string[], nodes: [x, y, ...],
 *     edges: [[a, b, classIndex, nameIndex (-1 = none), length (dm), [dx, dy, ...interior deltas]], ...] }
 */
export interface CompactRoads {
  v: 1;
  scale: number;
  names: string[];
  nodes: number[];
  edges: Array<[number, number, number, number, number, number[]]>;
}

export function encodeRoads(net: RoadNetwork, scale = 10): CompactRoads {
  const names: string[] = [];
  const nameIdx = new Map<string, number>();
  const q = (v: number) => Math.round(v * scale);
  const nodes = Array.from(net.nodes, q);
  const edges: CompactRoads['edges'] = net.edges.map((e) => {
    let ni = -1;
    if (e.name) {
      ni = nameIdx.get(e.name) ?? -1;
      if (ni < 0) {
        ni = names.length;
        names.push(e.name);
        nameIdx.set(e.name, ni);
      }
    }
    const deltas: number[] = [];
    let px = nodes[e.a * 2];
    let py = nodes[e.a * 2 + 1];
    for (let k = 2; k + 2 < e.pts.length; k += 2) {
      const x = q(e.pts[k]);
      const y = q(e.pts[k + 1]);
      if (x === px && y === py) continue;
      deltas.push(x - px, y - py);
      px = x;
      py = y;
    }
    return [e.a, e.b, ROAD_CLASSES.indexOf(e.cls), ni, Math.round(e.length * 10), deltas];
  });
  return { v: 1, scale, names, nodes, edges };
}

export function decodeRoads(c: CompactRoads): RoadNetwork {
  if (!c || c.v !== 1) throw new Error('unsupported roads.json version');
  const s = 1 / c.scale;
  const nodes = Float32Array.from(c.nodes, (v) => v * s);
  const edges: RoadEdge[] = c.edges.map(([a, b, ci, ni, len, deltas]) => {
    const pts = new Float32Array(deltas.length + 4);
    let x = c.nodes[a * 2];
    let y = c.nodes[a * 2 + 1];
    pts[0] = x * s;
    pts[1] = y * s;
    for (let k = 0; k < deltas.length; k += 2) {
      x += deltas[k];
      y += deltas[k + 1];
      pts[k + 2] = x * s;
      pts[k + 3] = y * s;
    }
    pts[pts.length - 2] = nodes[b * 2];
    pts[pts.length - 1] = nodes[b * 2 + 1];
    const edge: RoadEdge = { a, b, length: len / 10, cls: ROAD_CLASSES[ci] ?? 'local', pts };
    if (ni >= 0) edge.name = c.names[ni];
    return edge;
  });
  return { nodes, edges };
}

/** Summary statistics (for logs and the dev page). */
export function roadStats(net: RoadNetwork): { nodes: number; edges: number; km: number; byClass: Record<RoadClass, number> } {
  const byClass: Record<RoadClass, number> = { highway: 0, major: 0, minor: 0, local: 0 };
  let m = 0;
  for (const e of net.edges) {
    byClass[e.cls]++;
    m += e.length;
  }
  return { nodes: net.nodes.length / 2, edges: net.edges.length, km: m / 1000, byClass };
}
