/**
 * Extruded 3D buildings — the city the flood runs BETWEEN instead of over a photograph of one.
 *
 * WHAT THIS OWNS. Turning `TerrainData.buildings` (footprint rings + real heights, see src/data/buildings.ts) into
 * one static vertex/index buffer, slicing it into spatial chunks that can be frustum-culled and truncated by
 * distance, and drawing the selection. The shading lives in shaders/buildings.ts; the shadows buildings cast come
 * from the sun-shading raster (shadows.ts), which takes their roof heights as part of the occluder height field.
 *
 * GEOMETRY. Each footprint gives one open ring. Walls are a quad per ring edge (4 vertices, 6 indices — no sharing,
 * because a flat-shaded corner needs two different normals), roofs are the ring ear-clipped into a fan-free
 * triangulation. Pittsburgh's 45 084 buildings hold 233 476 ring vertices, so the whole city is 1.17 M vertices /
 * 610 k triangles / ~31 MB of GPU memory — about half the terrain mesh, built once at scene load.
 *
 * WINDING. Rings are normalised to CLOCKWISE in grid coordinates, which (grid +x → world +X east, grid +y → world
 * +Z south, world +Y up — a right-handed frame) makes the roof's right-hand-rule normal point up and each wall's
 * point out of the building. A triangle whose geometric normal faces the camera comes out CLOCKWISE in framebuffer
 * coordinates under this projection, hence `frontFace: 'cw'` with back-face culling in pipelines.ts —
 * tests/render/buildings.test.ts pins that with the real camera matrices rather than trusting the derivation.
 *
 * DRAPING. Footprint bases in the data are the 5th-percentile bare-earth elevation under the footprint, which is
 * not enough on its own: the rendered terrain is a CDLOD surface that morphs, and a building planted exactly on
 * the DEM shows daylight under its downhill wall. So the wall bottoms are sunk to the MINIMUM ground found around
 * the footprint's perimeter, minus a margin — everything below ground is hidden anyway, and nothing can float.
 *
 * LOD. Buildings are stored in Morton order, so a contiguous slice of them is a contiguous patch of city. Chunks of
 * ~384 are frustum-culled whole; inside a chunk the buildings are sorted tallest-first, so "draw only what is worth
 * a few pixels from here" is a prefix of the chunk's index range. The vertex shader collapses a building's roof
 * toward its floor over the last octave before that cut, so nothing pops — it sinks.
 */

import type { BuildingSet } from '../contracts';
import { BUILDING_UNIFORM_SIZE, IMAGERY_ROOF_FADE } from './shaders/buildings';

const BUILDING_UNIFORM_FLOATS = BUILDING_UNIFORM_SIZE / 4;

/** Buildings per chunk: the unit of frustum culling and of the distance cut. */
export const BUILDING_CHUNK = 384;

/**
 * How far below the lowest ground under its perimeter a wall bottom is sunk (metres). Two cells' worth of CDLOD
 * morph plus a margin; everything under the ground is hidden, so this is free insurance against floating.
 */
export const BASE_SINK_M = 2.5;

/**
 * A footprint on a slope must not end up buried: its roof is lifted, if needed, to this far above the 75th
 * percentile of the ground around its perimeter (metres). Uses a quantile rather than the max so one clipped
 * corner on a cliff cannot inflate a rowhouse into a tower.
 */
export const MIN_ROOF_CLEARANCE_M = 2.5;

/** Longest ring edge that is sampled only at its ends when looking for the ground under a footprint (cells). */
const EDGE_SAMPLE_CELLS = 1.5;

/**
 * How tall a building has to be, in DEM cells, before it is allowed into the sun-shading raster (fading in
 * between the two). The raster has one height per cell — 7.8 m in Pittsburgh — so nothing narrower or shorter than
 * a couple of cells is resolved by it: a block of 7 m rowhouses fuses into one solid slab, and a warehouse under
 * the flood turns the water above it into a mosaic of lit footprints and shaded gaps, because the cells that
 * carry a roof are shaded at roof height and the ones between them at street level. Towers are both tall enough to
 * resolve and the only ones whose shadow anybody can see across a city, so the raster carries those and the rest
 * are carried by their own N·L — which is exactly right at any resolution. (The same threshold gates how far a
 * facade trusts the raster; see `resolved` in shaders/buildings.ts.)
 */
export const SHADOW_MIN_CELLS = 1.0;
export const SHADOW_FULL_CELLS = 2.4;

/**
 * The roof-height raster, with everything the sun raster cannot resolve faded out of it. Returns null when nothing
 * survives, so the caller can skip the upload and leave the raster exactly as it was before buildings existed.
 */
export function shadowOccluderHeights(raster: Float32Array, cellSize: number): Float32Array | null {
  const lo = SHADOW_MIN_CELLS * cellSize;
  const hi = SHADOW_FULL_CELLS * cellSize;
  const out = new Float32Array(raster.length);
  let any = false;
  for (let i = 0; i < raster.length; i++) {
    const h = raster[i];
    if (!(h > lo)) continue;
    const t = Math.min(1, (h - lo) / Math.max(hi - lo, 1e-3));
    out[i] = h * t * t * (3 - 2 * t);
    if (out[i] > 0) any = true;
  }
  return any ? out : null;
}

/**
 * Winding the buildings pipeline culls by (src/render/pipelines.ts).
 *
 * buildBuildingMesh emits every face with its right-hand-rule normal pointing OUT of the box. WebGPU decides
 * facing from the signed area in FRAMEBUFFER space, whose y axis points DOWN, and that flip turns those faces
 * counter-clockwise there. It lives here, next to the code that does the winding, because getting it backwards is
 * silent and total: it culls exactly the faces that should be visible, and the whole city renders as open-topped
 * boxes with no roofs at all — which is how it shipped into this branch. tests/render/buildings.test.ts asserts
 * the rule against this constant, over a footprint of each orientation.
 */
export const BUILDING_FRONT_FACE: GPUFrontFace = 'ccw';

/** Vertex stride in bytes: vec3f position (gx, elevation m, gy) + u32 packed attributes + f32 building height. */
export const BUILDING_VERTEX_BYTES = 20;
const VERTEX_FLOATS = BUILDING_VERTEX_BYTES / 4;

/** Bit layout of the packed per-vertex attribute word (see shaders/buildings.ts, which unpacks it). */
export const PACK = {
  /** Horizontal normal, two snorm8s (0 for a roof vertex). */
  nxShift: 0,
  nzShift: 8,
  /** 1 = this vertex belongs to the roof cap (normal is up). */
  roofBit: 1 << 16,
  /** 1 = this vertex sits on the roof plane (roof cap or wall top) and moves when the LOD fade collapses it. */
  topBit: 1 << 17,
  heightSourceShift: 18,
  kindShift: 20,
  seedShift: 24,
} as const;

export interface BuildingChunk {
  /** Index of the first building of the chunk in the source BuildingSet order (diagnostics only). */
  firstBuilding: number;
  count: number;
  /** First index of the chunk in the shared index buffer. */
  firstIndex: number;
  /** Total indices of the chunk (all its buildings). */
  indexCount: number;
  /**
   * Roof heights of the chunk's buildings, DESCENDING, and the running index count after each of them: drawing
   * the first m of them is `drawIndexed(prefix[m], 1, firstIndex)`. `prefix[0] = 0`, `prefix[count] = indexCount`.
   */
  heights: Float32Array;
  prefix: Uint32Array;
  /** Grid-space bounds (cells) and elevation bounds (metres, no exaggeration). */
  gx0: number;
  gy0: number;
  gx1: number;
  gy1: number;
  yMin: number;
  yMax: number;
}

export interface BuildingMesh {
  /** Interleaved vertex data, BUILDING_VERTEX_BYTES per vertex. */
  vertices: ArrayBuffer;
  vertexCount: number;
  indices: Uint32Array;
  chunks: BuildingChunk[];
  /** Buildings actually meshed (footprints that degenerated are dropped). */
  buildingCount: number;
  triangleCount: number;
  /** Tallest roof above its floor, metres. */
  maxHeight: number;
}

/** Twice the signed area of an open ring of interleaved coordinates; negative = clockwise in a y-down grid. */
export function ringArea2(verts: ArrayLike<number>, start: number, n: number): number {
  let a = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = verts[(start + i) * 2];
    const yi = verts[(start + i) * 2 + 1];
    const xj = verts[(start + j) * 2];
    const yj = verts[(start + j) * 2 + 1];
    a += xi * yj - xj * yi;
  }
  return a;
}

/**
 * Ear clipping for one simple polygon, given CLOCKWISE in grid coordinates (see the winding note at the top).
 * Writes `(n - 2) * 3` indices of ring-local vertex numbers into `out` and returns how many it wrote; a ring that
 * cannot be triangulated (self-intersecting, or collapsed by the source quantisation) falls back to a fan, which
 * is wrong for a concave footprint but never leaves a hole in the roof.
 *
 * `xs`/`ys` are the ring's coordinates, already un-interleaved by the caller (it has them anyway).
 */
export function earClip(xs: Float64Array, ys: Float64Array, n: number, out: Uint32Array, outOffset: number): number {
  if (n < 3) return 0;
  let o = outOffset;
  if (n === 3) {
    out[o++] = 0;
    out[o++] = 1;
    out[o++] = 2;
    return 3;
  }
  // Doubly-linked ring of remaining vertices.
  const next = new Uint32Array(n);
  const prev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    next[i] = (i + 1) % n;
    prev[i] = (i + n - 1) % n;
  }
  // Clockwise in a y-down grid means the interior is on the left of each edge in "cross ≥ 0" terms below.
  const convex = (a: number, b: number, c: number) =>
    (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]) <= 0;
  const inside = (a: number, b: number, c: number, p: number) => {
    const d1 = (xs[p] - xs[b]) * (ys[a] - ys[b]) - (xs[a] - xs[b]) * (ys[p] - ys[b]);
    const d2 = (xs[p] - xs[c]) * (ys[b] - ys[c]) - (xs[b] - xs[c]) * (ys[p] - ys[c]);
    const d3 = (xs[p] - xs[a]) * (ys[c] - ys[a]) - (xs[c] - xs[a]) * (ys[p] - ys[a]);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };

  let remaining = n;
  let cur = 0;
  // Every vertex visited without clipping an ear means the ring is not simple: bail out to the fan.
  let stall = 0;
  while (remaining > 3 && stall <= remaining) {
    const a = prev[cur];
    const b = cur;
    const c = next[cur];
    let ear = convex(a, b, c);
    if (ear) {
      for (let p = next[c]; p !== a; p = next[p]) {
        if (inside(a, b, c, p)) {
          ear = false;
          break;
        }
      }
    }
    if (ear) {
      out[o++] = a;
      out[o++] = b;
      out[o++] = c;
      next[a] = c;
      prev[c] = a;
      remaining--;
      stall = 0;
      cur = c;
    } else {
      stall++;
      cur = next[cur];
    }
  }
  if (remaining === 3) {
    const a = cur;
    const b = next[a];
    const c = next[b];
    out[o++] = a;
    out[o++] = b;
    out[o++] = c;
    return o - outOffset;
  }
  // Degenerate ring: a fan is never a hole, and these are a handful of footprints out of tens of thousands.
  o = outOffset;
  for (let i = 1; i + 1 < n; i++) {
    out[o++] = 0;
    out[o++] = i;
    out[o++] = i + 1;
  }
  return o - outOffset;
}

/** Deterministic per-building 8-bit variation seed (stable between runs, so screenshots compare). */
export function buildingSeed(k: number, gx: number, gy: number): number {
  let h = (k * 0x9e3779b1) >>> 0;
  h ^= (Math.round(gx * 8) * 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35) >>> 0;
  h ^= (Math.round(gy * 8) * 0x27d4eb2f) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x165667b1) >>> 0;
  return (h ^ (h >>> 16)) & 0xff;
}

function snorm8(v: number): number {
  return (Math.max(-127, Math.min(127, Math.round(v * 127))) + 256) & 0xff;
}

interface GroundSampler {
  /** Lowest ground (m) in the cell containing (gx, gy) and its neighbours to the north-west. */
  lo(gx: number, gy: number): number;
}

function groundSampler(ground: Float32Array, nx: number, ny: number): GroundSampler {
  return {
    lo(gx, gy) {
      const i = Math.max(0, Math.min(nx - 1, Math.floor(gx)));
      const j = Math.max(0, Math.min(ny - 1, Math.floor(gy)));
      const i0 = Math.max(0, i - 1);
      const j0 = Math.max(0, j - 1);
      let m = Infinity;
      for (let jj = j0; jj <= j; jj++) {
        const row = jj * nx;
        for (let ii = i0; ii <= i; ii++) {
          const v = ground[row + ii];
          if (v < m) m = v;
        }
      }
      return Number.isFinite(m) ? m : 0;
    },
  };
}

/**
 * Build the whole city's geometry. `ground` is the solver's bed (what is actually on screen), not the raw DEM, so
 * that a hydro-conditioned river bank cannot leave a warehouse hanging over the water.
 */
export function buildBuildingMesh(set: BuildingSet, ground: Float32Array, nx: number, ny: number): BuildingMesh {
  const count = set.count;
  const totalRingVerts = set.offsets[count];
  // Walls: 4 vertices / 6 indices per ring edge (one edge per ring vertex). Roof: one vertex per ring vertex,
  // 3·(n−2) indices.
  const maxVerts = totalRingVerts * 5;
  const maxIndices = totalRingVerts * 9;
  const vbuf = new ArrayBuffer(maxVerts * BUILDING_VERTEX_BYTES);
  const vf = new Float32Array(vbuf);
  const vu = new Uint32Array(vbuf);
  const indices = new Uint32Array(maxIndices);
  const sampler = groundSampler(ground, nx, ny);

  const xs = new Float64Array(512);
  const ys = new Float64Array(512);
  const tri = new Uint32Array(3 * 512);
  const perimeter: number[] = [];

  let vCount = 0;
  let iCount = 0;
  let built = 0;
  let maxHeight = 0;

  // Per-built-building bookkeeping for the chunking pass below.
  const bHeight = new Float32Array(count);
  const bIndexFirst = new Uint32Array(count + 1);
  const bGx0 = new Float32Array(count);
  const bGy0 = new Float32Array(count);
  const bGx1 = new Float32Array(count);
  const bGy1 = new Float32Array(count);
  const bYMin = new Float32Array(count);
  const bYMax = new Float32Array(count);

  for (let k = 0; k < count; k++) {
    const a = set.offsets[k];
    const b = set.offsets[k + 1];
    let n = b - a;
    if (n < 3 || n > xs.length) continue;

    const area2 = ringArea2(set.verts, a, n);
    for (let i = 0; i < n; i++) {
      xs[i] = set.verts[(a + i) * 2];
      ys[i] = set.verts[(a + i) * 2 + 1];
    }
    // Drop repeated vertices: a duplicate makes a zero-length edge, which has no normal.
    let m = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (Math.abs(xs[i] - xs[j]) < 1e-6 && Math.abs(ys[i] - ys[j]) < 1e-6) continue;
      xs[m] = xs[i];
      ys[m] = ys[i];
      m++;
    }
    n = m;
    if (n < 3) continue;

    // Clockwise in grid coordinates: roof normal up, wall normals out (see the winding note at the top).
    // Dropping zero-length edges cannot change the sign, so the source ring's own shoelace decides it.
    if (area2 > 0) {
      for (let i = 0, j = n - 1; i < j; i++, j--) {
        const tx = xs[i];
        const ty = ys[i];
        xs[i] = xs[j];
        ys[i] = ys[j];
        xs[j] = tx;
        ys[j] = ty;
      }
    }

    // ── Ground under the perimeter ───────────────────────────────────────────────────────────
    perimeter.length = 0;
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      const steps = Math.max(1, Math.min(64, Math.ceil(Math.hypot(dx, dy) / EDGE_SAMPLE_CELLS)));
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        perimeter.push(sampler.lo(xs[i] + dx * t, ys[i] + dy * t));
      }
      if (xs[i] < gx0) gx0 = xs[i];
      if (xs[i] > gx1) gx1 = xs[i];
      if (ys[i] < gy0) gy0 = ys[i];
      if (ys[i] > gy1) gy1 = ys[i];
    }
    perimeter.sort((p, q) => p - q);
    const floorY = perimeter[0] - BASE_SINK_M;
    const q75 = perimeter[Math.min(perimeter.length - 1, Math.floor(perimeter.length * 0.75))];
    const height = Math.max(2, set.height[k]);
    // Prefer the data's own base (the provenance behind "One Oxford Center is 188 m" is anchored to it) and only
    // lift the roof when the slope would otherwise bury the building.
    const roofY = Math.max(set.base[k] + height, q75 + MIN_ROOF_CLEARANCE_M, floorY + 2.5);
    const h = roofY - floorY;
    if (h > maxHeight) maxHeight = h;

    const seed = buildingSeed(k, xs[0], ys[0]);
    const kind = set.kind[k] & 0xf;
    const src = set.heightSource[k] & 3;
    const common =
      ((src << PACK.heightSourceShift) | (kind << PACK.kindShift) | (seed << PACK.seedShift)) >>> 0;

    const iStart = iCount;

    // ── Walls ────────────────────────────────────────────────────────────────────────────────
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = xs[j] - xs[i];
      const dy = ys[j] - ys[i];
      const len = Math.hypot(dx, dy) || 1;
      // Outward normal of a clockwise ring: rotate the edge direction by +90° in grid axes.
      const onx = -dy / len;
      const ony = dx / len;
      const packBase = (common | (snorm8(onx) << PACK.nxShift) | (snorm8(ony) << PACK.nzShift)) >>> 0;
      const base = vCount * VERTEX_FLOATS;
      // P0 (i, floor), P1 (j, floor), P2 (j, roof), P3 (i, roof)
      vf[base] = xs[i];
      vf[base + 1] = floorY;
      vf[base + 2] = ys[i];
      vu[base + 3] = packBase;
      vf[base + 4] = h;
      vf[base + 5] = xs[j];
      vf[base + 6] = floorY;
      vf[base + 7] = ys[j];
      vu[base + 8] = packBase;
      vf[base + 9] = h;
      vf[base + 10] = xs[j];
      vf[base + 11] = roofY;
      vf[base + 12] = ys[j];
      vu[base + 13] = (packBase | PACK.topBit) >>> 0;
      vf[base + 14] = h;
      vf[base + 15] = xs[i];
      vf[base + 16] = roofY;
      vf[base + 17] = ys[i];
      vu[base + 18] = (packBase | PACK.topBit) >>> 0;
      vf[base + 19] = h;
      indices[iCount] = vCount;
      indices[iCount + 1] = vCount + 1;
      indices[iCount + 2] = vCount + 2;
      indices[iCount + 3] = vCount;
      indices[iCount + 4] = vCount + 2;
      indices[iCount + 5] = vCount + 3;
      vCount += 4;
      iCount += 6;
    }

    // ── Roof ─────────────────────────────────────────────────────────────────────────────────
    const roofBase = vCount;
    const roofPack = (common | PACK.roofBit | PACK.topBit) >>> 0;
    for (let i = 0; i < n; i++) {
      const o = (vCount + i) * VERTEX_FLOATS;
      vf[o] = xs[i];
      vf[o + 1] = roofY;
      vf[o + 2] = ys[i];
      vu[o + 3] = roofPack;
      vf[o + 4] = h;
    }
    vCount += n;
    const wrote = earClip(xs, ys, n, tri, 0);
    for (let i = 0; i < wrote; i++) indices[iCount + i] = roofBase + tri[i];
    iCount += wrote;

    bHeight[built] = h;
    bIndexFirst[built] = iStart;
    bGx0[built] = gx0;
    bGy0[built] = gy0;
    bGx1[built] = gx1;
    bGy1[built] = gy1;
    bYMin[built] = floorY;
    bYMax[built] = roofY;
    built++;
  }
  bIndexFirst[built] = iCount;

  // ── Chunking ───────────────────────────────────────────────────────────────────────────────
  // Buildings arrive in Morton order, so a contiguous run is a contiguous patch of city. Inside a chunk the
  // buildings are reordered tallest-first (and their index ranges copied into place) so that the distance cut is a
  // prefix of the chunk.
  const chunks: BuildingChunk[] = [];
  const reordered = new Uint32Array(iCount);
  let outIndex = 0;
  const order: number[] = [];
  for (let c0 = 0; c0 < built; c0 += BUILDING_CHUNK) {
    const c1 = Math.min(built, c0 + BUILDING_CHUNK);
    const nc = c1 - c0;
    order.length = 0;
    for (let i = c0; i < c1; i++) order.push(i);
    order.sort((p, q) => bHeight[q] - bHeight[p]);
    const heights = new Float32Array(nc);
    const prefix = new Uint32Array(nc + 1);
    const firstIndex = outIndex;
    let gx0 = Infinity;
    let gy0 = Infinity;
    let gx1 = -Infinity;
    let gy1 = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (let t = 0; t < nc; t++) {
      const bi = order[t];
      const from = bIndexFirst[bi];
      const to = bIndexFirst[bi + 1];
      reordered.set(indices.subarray(from, to), outIndex);
      outIndex += to - from;
      heights[t] = bHeight[bi];
      prefix[t + 1] = outIndex - firstIndex;
      if (bGx0[bi] < gx0) gx0 = bGx0[bi];
      if (bGy0[bi] < gy0) gy0 = bGy0[bi];
      if (bGx1[bi] > gx1) gx1 = bGx1[bi];
      if (bGy1[bi] > gy1) gy1 = bGy1[bi];
      if (bYMin[bi] < yMin) yMin = bYMin[bi];
      if (bYMax[bi] > yMax) yMax = bYMax[bi];
    }
    chunks.push({
      firstBuilding: c0,
      count: nc,
      firstIndex,
      indexCount: outIndex - firstIndex,
      heights,
      prefix,
      gx0,
      gy0,
      gx1,
      gy1,
      yMin,
      yMax,
    });
  }

  return {
    vertices: vbuf.slice(0, vCount * BUILDING_VERTEX_BYTES),
    vertexCount: vCount,
    indices: reordered.subarray(0, outIndex),
    chunks,
    buildingCount: built,
    triangleCount: outIndex / 3,
    maxHeight,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Per-frame selection
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface BuildingDraw {
  firstIndex: number;
  indexCount: number;
}

export interface BuildingSelection {
  draws: BuildingDraw[];
  buildings: number;
  indices: number;
}

/**
 * The smallest roof height (metres) still worth drawing at `dist` metres, given that a building must cover at least
 * `minPx` pixels of screen height. `pixelScale` is the world size of one pixel at unit distance (Frame.elev.w).
 */
export function lodMinHeight(dist: number, pixelScale: number, minPx: number, exaggeration: number): number {
  return (minPx * Math.max(dist, 1) * pixelScale) / Math.max(exaggeration, 0.01);
}

/** Number of leading entries of a DESCENDING array that are >= v (binary search). */
export function countAtLeast(sorted: Float32Array, v: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] >= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Frustum-cull the chunks and truncate each to the buildings worth drawing from here, merging the runs that come
 * out adjacent in the index buffer so a full city is a handful of draw calls rather than a hundred.
 */
export function selectBuildings(
  chunks: readonly BuildingChunk[],
  eye: readonly [number, number, number],
  planes: Float64Array,
  nx: number,
  ny: number,
  cellSize: number,
  exaggeration: number,
  pixelScale: number,
  minPx: number,
  out: BuildingDraw[],
): BuildingSelection {
  out.length = 0;
  let buildings = 0;
  let indices = 0;
  const hx = (nx * cellSize) / 2;
  const hz = (ny * cellSize) / 2;
  for (const c of chunks) {
    const x0 = c.gx0 * cellSize - hx;
    const x1 = c.gx1 * cellSize - hx;
    const z0 = c.gy0 * cellSize - hz;
    const z1 = c.gy1 * cellSize - hz;
    const y0 = c.yMin * exaggeration;
    const y1 = c.yMax * exaggeration;
    let visible = true;
    for (let p = 0; p < 6 && visible; p++) {
      const a = planes[p * 4];
      const b = planes[p * 4 + 1];
      const cc = planes[p * 4 + 2];
      const d = planes[p * 4 + 3];
      // Farthest corner along the plane normal: outside means the whole box is outside.
      const fx = a >= 0 ? x1 : x0;
      const fy = b >= 0 ? y1 : y0;
      const fz = cc >= 0 ? z1 : z0;
      if (a * fx + b * fy + cc * fz + d < 0) visible = false;
    }
    if (!visible) continue;
    const dx = Math.max(x0 - eye[0], 0, eye[0] - x1);
    const dy = Math.max(y0 - eye[1], 0, eye[1] - y1);
    const dz = Math.max(z0 - eye[2], 0, eye[2] - z1);
    const dist = Math.hypot(dx, dy, dz);
    const minH = lodMinHeight(dist, pixelScale, minPx, exaggeration);
    const m = countAtLeast(c.heights, minH);
    if (m === 0) continue;
    const n = c.prefix[m];
    buildings += m;
    indices += n;
    const last = out.length > 0 ? out[out.length - 1] : null;
    if (last && last.firstIndex + last.indexCount === c.firstIndex) last.indexCount += n;
    else out.push({ firstIndex: c.firstIndex, indexCount: n });
  }
  return { draws: out, buildings, indices };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// GPU layer
// ────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Per-frame style knobs. Three of them sit on top of the quality tier rather than replacing it, so the adaptive
 * controller keeps its say while a host can still push further:
 *   minPx       — a FLOOR: the effective cut is max(tier, this), so 0 means "whatever the tier chose";
 *   detail      — a MULTIPLIER on the tier's facade detail, so 1 means "whatever the tier chose";
 *   reflections — a CEILING raiser: max(tier, this), so a screenshot can ask for glass on a non-cinematic tier.
 * The rest are plain strengths for the look, all 1 by default.
 */
export interface BuildingStyle {
  /** Extra floor under the tier's smallest on-screen building height (px). 0 = follow the tier. */
  minPx: number;
  /** Multiplier on the tier's facade detail (floor bands, mullions), 0..1. */
  detail: number;
  /** Raise the tier's sky/cloud reflections in glass curtain wall, 0..1. */
  reflections: number;
  /** How far the aerial photo is trusted for roof colour, 0..1. */
  roofImagery: number;
  /** Strength of the ambient darkening in the first few metres above the street. */
  baseAO: number;
  /** Wet-masonry band above the waterline. */
  wetBand: number;
  /** Foam at the contact line. */
  foam: number;
  /** Stain at the high-water mark. */
  stain: number;
  /** Muddy attenuation of the submerged facade. */
  mud: number;
  /**
   * How much of the city survives a HAZARD mode (depth / max depth / velocity), 0..1. Default 0 — hidden.
   *
   * The hazard modes are the instrument, not the picture: they are how a judge reads how deep the water is and
   * how fast it moves, and they were designed and validated against a scene with no buildings in it. An opaque
   * city sits exactly on top of the answer — at the oblique angle the demo is framed at, a block of downtown
   * hides the flooded streets behind it, and the flood's extent, the one thing the colormap exists to show,
   * stops being legible. Neutralising the facades to grey (B.lod.w in shaders/buildings.ts) keeps the city from
   * competing for the legend's colours, but it cannot stop it from standing in front of them.
   *
   * So the realistic mode gets the city and the hazard modes get the data. This is a draw-time switch: the
   * footprints stay resident and toggling a mode costs nothing.
   */
  hazardCity: number;
}

/** The tier and the style, combined. Produced by `effectiveBuildingStyle` and used by BOTH the CPU cut and the shader. */
export interface EffectiveBuildingStyle {
  minPx: number;
  detail: number;
  reflections: number;
}

export function effectiveBuildingStyle(
  tier: { buildingMinPx: number; buildingDetail: number; buildingReflections: number },
  style: BuildingStyle,
): EffectiveBuildingStyle {
  return {
    minPx: Math.max(tier.buildingMinPx, style.minPx),
    detail: tier.buildingDetail * style.detail,
    reflections: Math.max(tier.buildingReflections, style.reflections),
  };
}

export const DEFAULT_BUILDING_STYLE: BuildingStyle = {
  minPx: 0,
  detail: 1,
  reflections: 0,
  roofImagery: 0.72,
  baseAO: 1,
  wetBand: 1,
  foam: 1,
  stain: 1,
  mud: 1,
  hazardCity: 0,
};

/** Multiplier on `minPx` over which a building grows from nothing to full height (see the vertex shader). */
export const LOD_FADE_RANGE = 2.4;

/** The scene textures the building pass reads; the renderer owns them all (see setScene in index.ts). */
export interface BuildingTextures {
  frame: GPUBuffer;
  /** Sun-shading raster: r = sun visibility, g = open-sky fraction, at the top of each cell. */
  sun: GPUTextureView;
  imagery: GPUTextureView;
  /** Per-vertex (bed, water surface, mean depth, wet) — the same field the water mesh is built from. */
  vtx: GPUTextureView;
  /** Per-cell (barrier, max depth, …): the high-water mark on a facade comes from here. */
  misc: GPUTextureView;
  linearSampler: GPUSampler;
  imagerySampler: GPUSampler;
}

/**
 * The city on the GPU: one static vertex/index buffer, the chunk table the per-frame selection walks, the uniform
 * the shader reads, and the roof-height raster the sun-shading pass takes as an occluder field.
 */
export class BuildingLayer {
  readonly vertexBuffer: GPUBuffer;
  readonly indexBuffer: GPUBuffer;
  readonly chunks: readonly BuildingChunk[];
  readonly buildingCount: number;
  readonly triangleCount: number;
  readonly vertexCount: number;
  /**
   * Roof height above ground per cell (r32float) for the passes that march the city as a height field: the
   * sun-shading raster's occluders and the water pass's skyline reflection. NOT the raw footprint raster —
   * anything the grid cannot resolve has been faded out of it (`shadowOccluderHeights`), so a block of 7 m
   * rowhouses is absent while a tower is exact. Null when the scene has no buildings tall enough to matter.
   */
  readonly heightTexture: GPUTexture | null;
  private uniform: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private uniformData = new Float32Array(BUILDING_UNIFORM_FLOATS);
  private draws: BuildingDraw[] = [];
  /** Diagnostics for the perf report: what the last frame actually asked the GPU to draw. */
  drawnBuildings = 0;
  drawnIndices = 0;
  drawCalls = 0;

  private constructor(
    private device: GPUDevice,
    mesh: BuildingMesh,
    layout: GPUBindGroupLayout,
    tex: BuildingTextures,
    heightTexture: GPUTexture | null,
  ) {
    this.chunks = mesh.chunks;
    this.buildingCount = mesh.buildingCount;
    this.triangleCount = mesh.triangleCount;
    this.vertexCount = mesh.vertexCount;
    this.heightTexture = heightTexture;
    this.vertexBuffer = device.createBuffer({
      label: 'buildings-verts',
      size: mesh.vertices.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Uint8Array(this.vertexBuffer.getMappedRange()).set(new Uint8Array(mesh.vertices));
    this.vertexBuffer.unmap();
    this.indexBuffer = device.createBuffer({
      label: 'buildings-idx',
      size: Math.max(4, mesh.indices.byteLength),
      usage: GPUBufferUsage.INDEX,
      mappedAtCreation: true,
    });
    new Uint32Array(this.indexBuffer.getMappedRange()).set(mesh.indices);
    this.indexBuffer.unmap();
    this.uniform = device.createBuffer({
      label: 'buildings-uniform',
      size: BUILDING_UNIFORM_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = device.createBindGroup({
      label: 'buildings',
      layout,
      entries: [
        { binding: 0, resource: { buffer: tex.frame } },
        { binding: 1, resource: { buffer: this.uniform } },
        { binding: 2, resource: tex.sun },
        { binding: 3, resource: tex.imagery },
        { binding: 4, resource: tex.vtx },
        { binding: 5, resource: tex.misc },
        { binding: 6, resource: tex.linearSampler },
        { binding: 7, resource: tex.imagerySampler },
      ],
    });
  }

  /**
   * Mesh a scene's buildings and upload them. Returns null when there is nothing to draw, so every call site can
   * feature-detect with `?? null` exactly like the data contract asks.
   */
  static create(
    device: GPUDevice,
    set: BuildingSet | null | undefined,
    ground: Float32Array,
    nx: number,
    ny: number,
    cellSize: number,
    layout: GPUBindGroupLayout,
    tex: BuildingTextures,
  ): BuildingLayer | null {
    if (!set || set.count <= 0) return null;
    const mesh = buildBuildingMesh(set, ground, nx, ny);
    if (mesh.buildingCount === 0 || mesh.indices.length === 0) return null;
    let heightTexture: GPUTexture | null = null;
    const raster = set.heightRaster;
    const occluders = raster && raster.length >= nx * ny ? shadowOccluderHeights(raster, cellSize) : null;
    if (occluders) {
      heightTexture = device.createTexture({
        label: 'building-heights',
        size: [nx, ny],
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      device.queue.writeTexture({ texture: heightTexture }, occluders, { bytesPerRow: nx * 4 }, { width: nx, height: ny });
    }
    return new BuildingLayer(device, mesh, layout, tex, heightTexture);
  }

  /**
   * Write the per-frame uniform. `eff` carries the values the quality tier and the style have already been
   * combined into (see `effectiveBuildingStyle`) — the shader's LOD cut MUST be the same number the CPU used to
   * truncate the chunks, or buildings pop at the boundary. `hazard` is 1 in the depth / max-depth / velocity modes.
   */
  writeUniform(eff: EffectiveBuildingStyle, style: BuildingStyle, hazard: number, imageryOn: boolean): void {
    const u = this.uniformData;
    u[0] = eff.minPx;
    u[1] = LOD_FADE_RANGE;
    u[2] = 0;
    u[3] = hazard;
    u[4] = eff.detail;
    u[5] = style.roofImagery;
    u[6] = eff.reflections;
    u[7] = style.baseAO;
    u[8] = style.wetBand;
    u[9] = style.foam;
    u[10] = style.stain;
    u[11] = style.mud;
    u[12] = imageryOn ? 1 : 0;
    u[13] = IMAGERY_ROOF_FADE;
    u[14] = 0;
    u[15] = 0;
    this.device.queue.writeBuffer(this.uniform, 0, u);
  }

  /** Frustum-cull and truncate, then issue the draws. Returns how many buildings survived. */
  draw(
    pass: GPURenderPassEncoder,
    pipeline: GPURenderPipeline,
    eye: readonly [number, number, number],
    planes: Float64Array,
    nx: number,
    ny: number,
    cellSize: number,
    exaggeration: number,
    pixelScale: number,
    minPx: number,
  ): number {
    const sel = selectBuildings(this.chunks, eye, planes, nx, ny, cellSize, exaggeration, pixelScale, minPx, this.draws);
    this.drawnBuildings = sel.buildings;
    this.drawnIndices = sel.indices;
    this.drawCalls = sel.draws.length;
    if (sel.draws.length === 0) return 0;
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.setIndexBuffer(this.indexBuffer, 'uint32');
    for (const d of sel.draws) pass.drawIndexed(d.indexCount, 1, d.firstIndex);
    return sel.buildings;
  }

  destroy(): void {
    this.vertexBuffer.destroy();
    this.indexBuffer.destroy();
    this.uniform.destroy();
    this.heightTexture?.destroy();
  }
}
