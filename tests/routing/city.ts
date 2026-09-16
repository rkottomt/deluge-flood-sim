/**
 * Synthetic test city: a Manhattan grid of streets cut east–west by a river that is crossed by exactly two
 * bridges. Everything is in grid coordinates on an N×N cell domain.
 *
 *     k = 0 … 20 (north → south) horizontal streets at gy = ORIGIN + k·BLOCK
 *     m = 0 … 20 (west → east)   vertical streets   at gx = ORIGIN + m·BLOCK
 *     river between street rows RIVER_ROW and RIVER_ROW+1, bridges on columns BRIDGE_A_COL, BRIDGE_B_COL
 *
 * Polylines have a few interior points (with a small wiggle) and ~half the edges have a/b swapped (with
 * pts reversed to match), so orientation handling is exercised.
 */
import type { RoadClass, RoadEdge, RoadNetwork, Shelter } from '../../src/contracts';

export interface CityOptions {
  /** Blocks per side (streets per side = blocks + 1). Default 20. */
  blocks?: number;
  /** Block size in cells. Default 24. */
  block?: number;
  /** Interior points per edge polyline. Default 2. */
  interior?: number;
  /** Include the river (no vertical streets across it except two bridges). Default true. */
  river?: boolean;
  seed?: number;
}

export interface City {
  net: RoadNetwork;
  nx: number;
  ny: number;
  cellSize: number;
  blocks: number;
  block: number;
  origin: number;
  /** River occupies rows [riverY0, riverY1) (cells). */
  riverY0: number;
  riverY1: number;
  bridgeACol: number;
  bridgeBCol: number;
  riverRow: number;
  node(m: number, k: number): number;
  /** Grid coordinate of street intersection (m, k). */
  pos(m: number, k: number): { gx: number; gy: number };
  /** Edge index of the bridge on column `col`. */
  bridgeEdge(col: number): number;
  /** Depth field with just the river filled (standing water). */
  baseline(riverDepth?: number): Float32Array;
}

export const CELL_SIZE = 8;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const V_NAMES = ['Smithfield', 'Wood', 'Market', 'Stanwix', 'Liberty', 'Grant', 'Ross', 'Forbes', 'Fifth', 'Craig'];
function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function makeCity(opts: CityOptions = {}): City {
  const blocks = opts.blocks ?? 20;
  const block = opts.block ?? 24;
  const interior = opts.interior ?? 2;
  const withRiver = opts.river ?? true;
  const rand = mulberry32(opts.seed ?? 1234);
  const origin = 16;
  const size = origin * 2 + blocks * block;
  const nx = Math.ceil(size / 16) * 16;
  const ny = nx;
  const per = blocks + 1;
  const riverRow = Math.floor((blocks - 1) / 2);
  const riverY0 = origin + riverRow * block + Math.round(block * 0.25);
  const riverY1 = origin + (riverRow + 1) * block - Math.round(block * 0.25);
  const bridgeACol = Math.round(blocks * 0.2);
  const bridgeBCol = Math.round(blocks * 0.75);

  const nodes = new Float32Array(per * per * 2);
  const node = (m: number, k: number) => k * per + m;
  const pos = (m: number, k: number) => ({ gx: origin + m * block + 0.5, gy: origin + k * block + 0.5 });
  for (let k = 0; k < per; k++) {
    for (let m = 0; m < per; m++) {
      const p = pos(m, k);
      nodes[2 * node(m, k)] = p.gx;
      nodes[2 * node(m, k) + 1] = p.gy;
    }
  }

  const edges: RoadEdge[] = [];
  const bridges = new Map<number, number>();

  const addEdge = (m0: number, k0: number, m1: number, k1: number, cls: RoadClass, name: string) => {
    const a = node(m0, k0);
    const b = node(m1, k1);
    const pa = pos(m0, k0);
    const pb = pos(m1, k1);
    const pts = new Float32Array((interior + 2) * 2);
    let len = 0;
    let lx = pa.gx, ly = pa.gy;
    const dx = pb.gx - pa.gx, dy = pb.gy - pa.gy;
    const L = Math.hypot(dx, dy);
    for (let q = 0; q <= interior + 1; q++) {
      const t = q / (interior + 1);
      // perpendicular wiggle on interior points only (≤ 0.35 cells)
      const w = q === 0 || q === interior + 1 ? 0 : (rand() - 0.5) * 0.7;
      const x = pa.gx + dx * t + (-dy / L) * w;
      const y = pa.gy + dy * t + (dx / L) * w;
      pts[2 * q] = x;
      pts[2 * q + 1] = y;
      len += Math.hypot(x - lx, y - ly);
      lx = x;
      ly = y;
    }
    const swap = rand() < 0.5;
    let e: RoadEdge;
    if (swap) {
      const rev = new Float32Array(pts.length);
      for (let q = 0; q < pts.length / 2; q++) {
        rev[2 * q] = pts[pts.length - 2 - 2 * q];
        rev[2 * q + 1] = pts[pts.length - 1 - 2 * q];
      }
      e = { a: b, b: a, length: len * CELL_SIZE, cls, name, pts: rev };
    } else {
      e = { a, b, length: len * CELL_SIZE, cls, name, pts };
    }
    edges.push(e);
    return edges.length - 1;
  };

  for (let k = 0; k < per; k++) {
    const major = k % 5 === 0 && k > 0 && k < blocks;
    const cls: RoadClass = k === blocks ? 'highway' : major ? 'major' : 'local';
    const name = k === blocks ? 'I-376' : major ? `${['', 'Penn', 'Liberty', 'Baum', 'Centre'][k / 5] ?? 'Main'} Ave` : `${ordinal(k + 1)} St`;
    for (let m = 0; m < blocks; m++) addEdge(m, k, m + 1, k, cls, name);
  }
  for (let m = 0; m < per; m++) {
    const cls: RoadClass = m === Math.floor(blocks / 2) ? 'major' : m % 4 === 0 ? 'minor' : 'local';
    const name = `${V_NAMES[m % V_NAMES.length]}${m >= V_NAMES.length ? ' ' + ordinal(Math.floor(m / V_NAMES.length) + 1) : ''} St`;
    for (let k = 0; k < blocks; k++) {
      if (withRiver && k === riverRow) {
        if (m === bridgeACol) bridges.set(m, addEdge(m, k, m, k + 1, 'local', 'Smithfield St Bridge'));
        else if (m === bridgeBCol) bridges.set(m, addEdge(m, k, m, k + 1, 'local', 'Hot Metal Bridge'));
        continue;
      }
      addEdge(m, k, m, k + 1, cls, name);
    }
  }

  return {
    net: { nodes, edges },
    nx,
    ny,
    cellSize: CELL_SIZE,
    blocks,
    block,
    origin,
    riverY0,
    riverY1,
    bridgeACol,
    bridgeBCol,
    riverRow,
    node,
    pos,
    bridgeEdge: (col: number) => {
      const e = bridges.get(col);
      if (e === undefined) throw new Error(`no bridge on column ${col}`);
      return e;
    },
    baseline: (riverDepth = 4) => {
      const d = new Float32Array(nx * ny);
      if (withRiver) for (let j = riverY0; j < riverY1; j++) d.fill(riverDepth, j * nx, (j + 1) * nx);
      return d;
    },
  };
}

/** Set depth = max(depth, value) over a rectangle of cells [x0, x1) × [y0, y1). */
export function floodRect(d: Float32Array, nx: number, x0: number, y0: number, x1: number, y1: number, value: number): void {
  const ny = Math.floor(d.length / nx);
  x0 = Math.max(0, Math.floor(x0));
  y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(nx, Math.ceil(x1));
  y1 = Math.min(ny, Math.ceil(y1));
  for (let j = y0; j < y1; j++) {
    for (let i = x0; i < x1; i++) {
      const k = j * nx + i;
      if (d[k] < value) d[k] = value;
    }
  }
}

export function shelterAt(name: string, gx: number, gy: number): Shelter {
  return { name, gx, gy };
}
