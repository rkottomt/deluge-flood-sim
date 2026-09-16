/**
 * Road graph construction: everything that depends only on the RoadNetwork (not on water) is
 * precomputed here once, into flat typed arrays, so the per-snapshot flood update and the per-query
 * shortest path never allocate or touch JS objects.
 *
 *  • CSR adjacency (undirected: each usable edge appears in the lists of both endpoints).
 *  • All edge polylines copied into one Float32Array, always oriented a → b.
 *  • Per-edge grid cells under the road centreline (exact grid traversal, consecutive duplicates
 *    removed), packed as (j << 16 | i) so they can be re-indexed for any depth grid size.
 *  • A uniform-bucket spatial hash of polyline segments for nearest-road snapping.
 */
import type { RoadNetwork } from '../contracts';
import { CLASS_CODE, CLASS_SPEEDS } from './constants';
import { normalizeStreetName } from './format';

export interface SegmentHash {
  originX: number;
  originY: number;
  /** Bucket edge length in grid cells. */
  bucketSize: number;
  cols: number;
  rows: number;
  /** CSR: segments of bucket k are bucketSeg[bucketStart[k] .. bucketStart[k+1]). */
  bucketStart: Int32Array;
  /** Segment ids = index of the segment's first point in RoadGraph.px/py. */
  bucketSeg: Int32Array;
}

export interface RoadGraph {
  nodeCount: number;
  edgeCount: number;
  cellSize: number;
  nodeX: Float32Array;
  nodeY: Float32Array;

  edgeA: Int32Array;
  edgeB: Int32Array;
  /** 1 when the edge can be traversed (valid distinct endpoints). Self loops / bad indices are 0. */
  edgeUsable: Uint8Array;
  /** Ground length in meters. */
  edgeLength: Float64Array;
  /** Polyline length in grid cells (used for fractional positions along an edge). */
  edgeGridLength: Float64Array;
  /** Dry free-flow travel time in seconds. */
  edgeDryTime: Float64Array;
  edgeClass: Uint8Array;
  /** Display names ('' when unnamed). */
  edgeName: string[];

  /** Polyline points of edge e are indices ptStart[e] .. ptStart[e+1]-1, oriented a → b. */
  ptStart: Int32Array;
  px: Float32Array;
  py: Float32Array;
  /** Owning edge of each point (segment p → p+1 belongs to ptEdge[p]). */
  ptEdge: Int32Array;

  adjStart: Int32Array;
  adjTo: Int32Array;
  adjEdge: Int32Array;

  /** Samples of edge e are sampleCell[sampleStart[e] .. sampleStart[e+1]); packed (j << 16) | i. */
  sampleStart: Int32Array;
  sampleCell: Uint32Array;
  /** Largest i / j among samples + 1 (the smallest grid that contains every sample unclamped). */
  sampleExtentI: number;
  sampleExtentJ: number;

  hash: SegmentHash;
}

/** Coordinates are clamped into this range before grid traversal so garbage input cannot explode. */
const MAX_CELL = 65535;

function clampCoord(v: number): number {
  return v < 0 ? 0 : v > MAX_CELL + 0.999 ? MAX_CELL + 0.999 : v;
}

export function buildRoadGraph(net: RoadNetwork, cellSize: number): RoadGraph {
  const nodeCount = Math.floor(net.nodes.length / 2);
  const edges = net.edges;
  const edgeCount = edges.length;
  const cs = cellSize > 0 && Number.isFinite(cellSize) ? cellSize : 1;

  const nodeX = new Float32Array(nodeCount);
  const nodeY = new Float32Array(nodeCount);
  for (let k = 0; k < nodeCount; k++) {
    nodeX[k] = net.nodes[2 * k];
    nodeY[k] = net.nodes[2 * k + 1];
  }

  const edgeA = new Int32Array(edgeCount);
  const edgeB = new Int32Array(edgeCount);
  const edgeUsable = new Uint8Array(edgeCount);
  const edgeLength = new Float64Array(edgeCount);
  const edgeGridLength = new Float64Array(edgeCount);
  const edgeDryTime = new Float64Array(edgeCount);
  const edgeClass = new Uint8Array(edgeCount);
  const edgeName: string[] = new Array(edgeCount);

  // ── Polylines: count, then copy (oriented a → b; non-finite vertices dropped; fewer than two usable
  //    vertices fall back to the straight chord between the end nodes) ──
  const ptStart = new Int32Array(edgeCount + 1);
  const validNode = (n: number) =>
    Number.isInteger(n) && n >= 0 && n < nodeCount && Number.isFinite(nodeX[n]) && Number.isFinite(nodeY[n]);
  const finitePoints = (pts: Float32Array | undefined) => {
    let n = 0;
    if (pts) for (let k = 0; k + 1 < pts.length; k += 2) if (Number.isFinite(pts[k]) && Number.isFinite(pts[k + 1])) n++;
    return n;
  };
  const finiteCount = new Int32Array(edgeCount);
  for (let e = 0; e < edgeCount; e++) {
    const ed = edges[e];
    const n = (finiteCount[e] = finitePoints(ed.pts));
    let count = n >= 2 ? n : 2;
    if (n < 2 && !(validNode(ed.a) && validNode(ed.b))) count = 0;
    ptStart[e + 1] = ptStart[e] + count;
  }
  const totalPts = ptStart[edgeCount];
  const px = new Float32Array(totalPts);
  const py = new Float32Array(totalPts);
  const ptEdge = new Int32Array(totalPts);

  const degree = new Int32Array(nodeCount + 1);
  const nameCache = new Map<string, string>(); // street names repeat across many edges
  for (let e = 0; e < edgeCount; e++) {
    const ed = edges[e];
    const a = ed.a;
    const b = ed.b;
    edgeA[e] = validNode(a) ? a : -1;
    edgeB[e] = validNode(b) ? b : -1;
    const usable = validNode(a) && validNode(b) && a !== b;
    edgeUsable[e] = usable ? 1 : 0;
    edgeClass[e] = Object.hasOwn(CLASS_CODE, ed.cls) ? CLASS_CODE[ed.cls] : CLASS_CODE.local;
    const rawName = ed.name ?? '';
    let name = nameCache.get(rawName);
    if (name === undefined) nameCache.set(rawName, (name = normalizeStreetName(rawName)));
    edgeName[e] = name;

    const s = ptStart[e];
    const count = ptStart[e + 1] - s;
    const src = ed.pts;
    const n = finiteCount[e];
    if (count > 0) {
      if (n >= 2) {
        let w = s;
        for (let k = 0; k + 1 < src.length; k += 2) {
          if (!(Number.isFinite(src[k]) && Number.isFinite(src[k + 1]))) continue;
          px[w] = src[k];
          py[w++] = src[k + 1];
        }
        // Contract: pts start at node a. Be tolerant of reversed input by checking which end is closer.
        if (validNode(a) && validNode(b) && a !== b) {
          const dA = (px[s] - nodeX[a]) ** 2 + (py[s] - nodeY[a]) ** 2;
          const dB = (px[s] - nodeX[b]) ** 2 + (py[s] - nodeY[b]) ** 2;
          if (dB < dA) {
            px.subarray(s, s + n).reverse();
            py.subarray(s, s + n).reverse();
          }
        }
      } else {
        px[s] = nodeX[a];
        py[s] = nodeY[a];
        px[s + 1] = nodeX[b];
        py[s + 1] = nodeY[b];
      }
      ptEdge.fill(e, s, s + count);
    }

    let gridLen = 0;
    for (let p = s; p < s + count - 1; p++) {
      const dx = px[p + 1] - px[p], dy = py[p + 1] - py[p];
      gridLen += Math.sqrt(dx * dx + dy * dy);
    }
    edgeGridLength[e] = gridLen;
    const len = ed.length > 0 && Number.isFinite(ed.length) ? ed.length : gridLen * cs;
    edgeLength[e] = len;
    edgeDryTime[e] = len / CLASS_SPEEDS[edgeClass[e]];

    if (usable) {
      degree[a]++;
      degree[b]++;
    }
  }

  // ── CSR adjacency ──
  const adjStart = new Int32Array(nodeCount + 1);
  for (let k = 0; k < nodeCount; k++) adjStart[k + 1] = adjStart[k] + degree[k];
  const adjTo = new Int32Array(adjStart[nodeCount]);
  const adjEdge = new Int32Array(adjStart[nodeCount]);
  const fill = degree; // reuse as write cursor
  for (let k = 0; k < nodeCount; k++) fill[k] = adjStart[k];
  for (let e = 0; e < edgeCount; e++) {
    if (!edgeUsable[e]) continue;
    const a = edgeA[e];
    const b = edgeB[e];
    adjTo[fill[a]] = b;
    adjEdge[fill[a]++] = e;
    adjTo[fill[b]] = a;
    adjEdge[fill[b]++] = e;
  }

  const samples = buildSamples(edgeCount, ptStart, px, py);
  const hash = buildSegmentHash(edgeCount, ptStart, px, py, ptEdge, cs);

  return {
    nodeCount,
    edgeCount,
    cellSize: cs,
    nodeX,
    nodeY,
    edgeA,
    edgeB,
    edgeUsable,
    edgeLength,
    edgeGridLength,
    edgeDryTime,
    edgeClass,
    edgeName,
    ptStart,
    px,
    py,
    ptEdge,
    adjStart,
    adjTo,
    adjEdge,
    ...samples,
    hash,
  };
}

/**
 * Every grid cell the centreline of each edge passes through (Amanatides–Woo traversal), so a road can
 * never "skip" a flooded cell no matter how its polyline is spaced. Consecutive identical cells —
 * including across polyline joints — are stored once.
 */
function buildSamples(
  edgeCount: number,
  ptStart: Int32Array,
  px: Float32Array,
  py: Float32Array,
): Pick<RoadGraph, 'sampleStart' | 'sampleCell' | 'sampleExtentI' | 'sampleExtentJ'> {
  // Pass 1: exact upper bound (a segment visits |Δi| + |Δj| + 1 cells). px/py are finite (sanitized).
  let bound = 0;
  for (let e = 0; e < edgeCount; e++) {
    for (let p = ptStart[e]; p < ptStart[e + 1] - 1; p++) {
      const x0 = px[p], y0 = py[p], x1 = px[p + 1], y1 = py[p + 1];
      bound +=
        Math.abs(Math.floor(clampCoord(x1)) - Math.floor(clampCoord(x0))) +
        Math.abs(Math.floor(clampCoord(y1)) - Math.floor(clampCoord(y0))) +
        1;
    }
  }

  const sampleStart = new Int32Array(edgeCount + 1);
  const sampleCell = new Uint32Array(bound);
  let w = 0;
  let maxI = 0;
  let maxJ = 0;

  for (let e = 0; e < edgeCount; e++) {
    sampleStart[e] = w;
    let last = -1;
    for (let p = ptStart[e]; p < ptStart[e + 1] - 1; p++) {
      const x0 = clampCoord(px[p]), y0 = clampCoord(py[p]), x1 = clampCoord(px[p + 1]), y1 = clampCoord(py[p + 1]);

      let i = Math.floor(x0);
      let j = Math.floor(y0);
      const iEnd = Math.floor(x1);
      const jEnd = Math.floor(y1);
      let remI = Math.abs(iEnd - i);
      let remJ = Math.abs(jEnd - j);
      const dx = x1 - x0;
      const dy = y1 - y0;
      const stepI = iEnd > i ? 1 : -1;
      const stepJ = jEnd > j ? 1 : -1;
      const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
      const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
      let tMaxX = dx > 0 ? (i + 1 - x0) / dx : dx < 0 ? (x0 - i) / -dx : Infinity;
      let tMaxY = dy > 0 ? (j + 1 - y0) / dy : dy < 0 ? (y0 - j) / -dy : Infinity;

      for (;;) {
        const key = (j * 65536 + i) >>> 0;
        if (key !== last) {
          sampleCell[w++] = key;
          last = key;
          if (i > maxI) maxI = i;
          if (j > maxJ) maxJ = j;
        }
        if (remI === 0 && remJ === 0) break;
        // Counting remaining steps per axis (instead of trusting float comparisons alone) guarantees
        // the walk ends exactly in the end cell.
        if (remJ === 0 || (remI > 0 && tMaxX < tMaxY)) {
          i += stepI;
          tMaxX += tDeltaX;
          remI--;
        } else {
          j += stepJ;
          tMaxY += tDeltaY;
          remJ--;
        }
      }
    }
  }
  sampleStart[edgeCount] = w;
  return { sampleStart, sampleCell, sampleExtentI: maxI + 1, sampleExtentJ: maxJ + 1 };
}

/** Uniform bucket grid over polyline segments, sized so a snap query touches only a few buckets. */
function buildSegmentHash(
  edgeCount: number,
  ptStart: Int32Array,
  px: Float32Array,
  py: Float32Array,
  ptEdge: Int32Array,
  cellSize: number,
): SegmentHash {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const totalPts = ptStart[edgeCount];
  for (let p = 0; p < totalPts; p++) {
    const x = px[p], y = py[p];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  if (!(minX <= maxX)) {
    minX = minY = 0;
    maxX = maxY = 1;
  }
  // ~150 m buckets (half the snap radius), but never more than ~1M buckets.
  let bucketSize = Math.max(1, 150 / cellSize);
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  while ((spanX / bucketSize + 1) * (spanY / bucketSize + 1) > 1_000_000) bucketSize *= 2;
  const cols = Math.floor(spanX / bucketSize) + 1;
  const rows = Math.floor(spanY / bucketSize) + 1;
  const inv = 1 / bucketSize;
  const bucketCount = cols * rows;
  const bucketStart = new Int32Array(bucketCount + 1);
  let bucketSeg = new Int32Array(0);
  let cursor = bucketStart;

  // Two passes over the segments (p → p+1 within one edge): count per bucket, prefix-sum, then fill.
  // A segment goes into every bucket its bounding box overlaps. px/py are finite (sanitized).
  for (let pass = 0; pass < 2; pass++) {
    for (let p = 0; p < totalPts - 1; p++) {
      if (ptEdge[p] !== ptEdge[p + 1]) continue;
      const x0 = px[p], y0 = py[p], x1 = px[p + 1], y1 = py[p + 1];
      const c0 = Math.floor(((x0 < x1 ? x0 : x1) - minX) * inv);
      const c1 = Math.floor(((x0 < x1 ? x1 : x0) - minX) * inv);
      const r0 = Math.floor(((y0 < y1 ? y0 : y1) - minY) * inv);
      const r1 = Math.floor(((y0 < y1 ? y1 : y0) - minY) * inv);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          if (pass === 0) bucketStart[r * cols + c + 1]++;
          else bucketSeg[cursor[r * cols + c]++] = p;
        }
      }
    }
    if (pass === 0) {
      for (let k = 0; k < bucketCount; k++) bucketStart[k + 1] += bucketStart[k];
      bucketSeg = new Int32Array(bucketStart[bucketCount]);
      cursor = bucketStart.slice(0, bucketCount);
    }
  }
  return { originX: minX, originY: minY, bucketSize, cols, rows, bucketStart, bucketSeg };
}
