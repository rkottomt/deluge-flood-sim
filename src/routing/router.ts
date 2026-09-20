/**
 * Flood-aware evacuation router.
 *
 * Pipeline
 *  1. setNetwork  → buildRoadGraph (CSR adjacency, per-edge centreline cells, segment spatial hash).
 *  2. updateFlood → per-edge max water depth over its cells → status (dry / wet / flooded) and travel
 *                   cost (dry time, dry time / 0.3 when wet, +∞ when flooded). One tight typed-array loop.
 *  3. route       → snap the start and every shelter onto nearby usable roads (projection onto the
 *                   nearest segments, not just nodes), then a single multi-source / multi-target Dijkstra
 *                   over travel time with an indexed binary heap, stopping as soon as the best shelter
 *                   arrival can no longer improve. The path is rebuilt from oriented edge polylines,
 *                   including the partial edges at both ends.
 *
 * Standing water (rivers & lakes) vs. flood water
 *  Hydro-flattened DEM rivers hold metres of water at load time, and every bridge crosses one. Sampling
 *  naively would mark all bridges "flooded" before it has even rained. So cells that are already wet in
 *  the *baseline* water field are excluded from road sampling: a road over them is a bridge span, judged
 *  by where it lands (its elevated approaches are excluded too — see APPROACH_FRACTION). The app provides
 *  the baseline with setBaselineWater (the initial water from computeInitialWater) after setNetwork.
 *  Without a baseline every sample counts — the conservative choice: bridges over rivers read as flooded,
 *  but a route is never sent through water.
 */
import type { EvacuationRouter, RoadNetwork, RoadStatusArray, RouteDiagnosis, RouteReason, RouteResult, Shelter } from '../contracts';
import {
  APPROACH_FRACTION,
  CONNECTOR_SPEED,
  MAX_APPROACH_M,
  ROAD_FLOODED_DEPTH,
  ROAD_WET_DEPTH,
  SHELTER_CANDIDATES,
  SNAP_RADIUS_M,
  START_CANDIDATES,
  STATUS_DRY,
  STATUS_FLOODED,
  STATUS_WET,
  WET_SPEED_FACTOR,
} from './constants';
import { formatDistance, formatDuration } from './format';
import { buildRoadGraph, type RoadGraph } from './graph';
import { IndexedMinHeap } from './heap';

/** Why a result has no route (defined in the contract, see RouteResult.reason), and the numbers behind it. */
export type { RouteDiagnosis, RouteReason };

/**
 * A RouteResult plus the parts its `message` sentence is made of, so a UI can lay the route out and format
 * the numbers itself instead of parsing the sentence. `message` stays the complete stand-alone status line
 * (debug API, screen readers, the routing harness).
 */
export interface DelugeRouteResult extends RouteResult {
  /** null for 'ok'; otherwise why there is no route. */
  reason: RouteReason | null;
  /** 'ok': the streets carrying most of the route, in travel order (at most two; [] if unnamed). [] otherwise. */
  via: string[];
  /** 'ok': metres of the route on wet roads (passable, slowed — "drive slowly"). 0 otherwise. */
  wetMeters: number;
  /**
   * What to do, as a sentence that reads without a "No safe route" heading: for 'blocked', why and to shelter
   * in place ("Every shelter is flooded. Shelter in place on higher floors."); for 'none', how to get a route
   * (same as `message`); '' for 'ok'.
   */
  advice: string;
  /** 'blocked': the numbers behind `reason` — see RouteDiagnosis. null for 'ok' and 'none'. */
  diagnosis: RouteDiagnosis | null;
}

/** The router returned by createRouter(): the contract plus a few optional extras for the app/debugging. */
export interface DelugeRouter extends EvacuationRouter {
  /**
   * Rebuild the graph. `grid` (optional, beyond the contract) declares the terrain grid the network's
   * coordinates refer to; otherwise it is taken from the first updateFlood call.
   */
  setNetwork(net: RoadNetwork | null, cellSize: number, grid?: { nx: number; ny: number }): void;
  /**
   * Declare the standing water present at load (rivers, lakes — e.g. computeInitialWater's output) so
   * bridges over it are not treated as flooded. Pass null to judge roads purely by depth again (the default
   * after setNetwork). Applies to the current network: call after setNetwork.
   */
  setBaselineWater(depth: Float32Array | null, nx: number, ny: number): void;
  /** Per-edge max flood depth (m) from the last updateFlood, in edge order. Do not mutate. */
  getEdgeDepths(): Float32Array | null;
  /**
   * Current per-edge status (same array updateFlood last returned). updateFlood returns a different array
   * instance exactly when some status changed; the router recycles two buffers, so an array returned
   * earlier may be overwritten by a later update — read the latest one rather than keeping old ones.
   */
  getRoadStatus(): RoadStatusArray | null;
  /** Graph size information for diagnostics. */
  getGraphInfo(): { nodes: number; edges: number; samples: number; activeSamples: number } | null;
  route(start: { gx: number; gy: number } | null, shelters: Shelter[]): DelugeRouteResult;
}

export const NONE_NO_ROADS = 'No road data for this area — evacuation routing is unavailable.';
export const NONE_NO_START = 'Choose the Evac tool and click your starting point to plan a flood-safe route to shelter.';
export const NONE_NO_SHELTERS = 'No shelters yet — add one with the Shelter tool, then click a start point with the Evac tool.';
export const NONE_START_FAR = `No road within ${SNAP_RADIUS_M} m of the start point — click closer to a street with the Evac tool.`;
export const NONE_SHELTERS_FAR = `No shelter is within ${SNAP_RADIUS_M} m of a road — place shelters next to a street.`;
const SHELTER_IN_PLACE = 'Shelter in place on higher floors.';
export const ADVICE_CUT_OFF = `All roads to shelters are flooded. ${SHELTER_IN_PLACE}`;
export const ADVICE_START_ROADS = `Every road near the start is flooded. ${SHELTER_IN_PLACE}`;
export const ADVICE_SHELTERS_FLOODED = `Every shelter is flooded. ${SHELTER_IN_PLACE}`;

const SHELTER_NONE = -1;

export function createRouter(): DelugeRouter {
  return new Router();
}

class Router implements DelugeRouter {
  private g: RoadGraph | null = null;

  // ── Grid mapping ──
  /** Grid the network coordinates refer to (0 = not known yet). */
  private refNx = 0;
  private refNy = 0;

  // ── Baseline (standing water) mask, per sample: 1 = ignore ──
  private sampleMask: Uint8Array | null = null;
  /** Bitmask of standing-water cells in the baseline grid (baseNx × baseNy), for start-point messages. */
  private baseWater: Uint8Array | null = null;
  private baseNx = 0;
  private baseNy = 0;
  private maskVersion = 0;

  // ── Active sample flat indices for a specific depth grid ──
  private activeStart = new Int32Array(1);
  private activeIdx = new Int32Array(0);
  private indexNx = 0;
  private indexNy = 0;
  private indexMaskVersion = -1;

  // ── Flood state ──
  private edgeDepth = new Float32Array(0);
  private edgeCost = new Float64Array(0);
  private statusCur = new Uint8Array(0);
  private statusNext = new Uint8Array(0);
  private hasFlood = false;
  private lastDepth: Float32Array | null = null;
  private lastNx = 0;
  private lastNy = 0;

  // ── Search scratch (sized per network) ──
  private dist = new Float64Array(0);
  private predEdge = new Int32Array(0);
  /** For seed nodes (predEdge = -1): 2 × start candidate + side (0 = reached via the edge's a end, 1 = b). */
  private seedCand = new Int32Array(0);
  private heap = new IndexedMinHeap(1, new Float64Array(1));
  private attachHead = new Int32Array(0);
  private queryStamp = new Int32Array(0);
  private queryBestD2 = new Float64Array(0);
  private queryBestSeg = new Int32Array(0);
  private queryBestU = new Float64Array(0);
  private stamp = 0;
  private touched = new Int32Array(256);

  // ── Candidates (struct of arrays; start candidates first, then shelter candidates) ──
  private candCap = 0;
  private candEdge = new Int32Array(0);
  private candSeg = new Int32Array(0);
  private candU = new Float64Array(0);
  private candX = new Float64Array(0);
  private candY = new Float64Array(0);
  private candFrac = new Float64Array(0);
  /** Off-network connector length in grid cells. */
  private candConn = new Float64Array(0);
  private candShelter = new Int32Array(0);
  private attachNext = new Int32Array(0);
  private attachCost = new Float64Array(0);
  private candCount = 0;

  // ── Path output scratch ──
  private poly = new Float32Array(1024);
  private polyLen = 0;
  private pieceEdge = new Int32Array(256);
  private pieceMeters = new Float64Array(256);
  private pieceCount = 0;
  private pathEdges = new Int32Array(256);
  private nameList: string[] = [];
  private nameMeters: number[] = [];
  private nameFirst: number[] = [];

  // ── Search result ──
  private best = Infinity;
  private bestAttachCand = -1;
  private bestAttachSide = 0;
  private bestAttachNode = -1;
  private bestDirectStart = -1;
  private bestDirectTarget = -1;

  // ────────────────────────────────────────────────────────────────────────────────────────
  // Network
  // ────────────────────────────────────────────────────────────────────────────────────────

  setNetwork(net: RoadNetwork | null, cellSize: number, grid?: { nx: number; ny: number }): void {
    this.lastDepth = null;
    this.lastNx = this.lastNy = 0;
    this.sampleMask = null;
    this.baseWater = null;
    this.maskVersion++;
    this.indexNx = this.indexNy = 0;
    this.hasFlood = false;
    this.refNx = grid && grid.nx > 0 ? grid.nx : 0;
    this.refNy = grid && grid.ny > 0 ? grid.ny : 0;

    if (!net || !net.nodes || !net.edges) {
      this.g = null;
      return;
    }
    const g = buildRoadGraph(net, cellSize);
    this.g = g;
    const E = g.edgeCount;
    const N = g.nodeCount;

    this.edgeDepth = new Float32Array(E);
    this.edgeCost = g.edgeDryTime.slice();
    this.statusCur = new Uint8Array(E);
    this.statusNext = new Uint8Array(E);
    this.activeStart = new Int32Array(E + 1);
    this.activeIdx = new Int32Array(g.sampleCell.length);

    this.dist = new Float64Array(N);
    this.predEdge = new Int32Array(N);
    this.seedCand = new Int32Array(N);
    this.heap = new IndexedMinHeap(N, this.dist);
    this.attachHead = new Int32Array(N).fill(-1);
    this.queryStamp = new Int32Array(E);
    this.queryBestD2 = new Float64Array(E);
    this.queryBestSeg = new Int32Array(E);
    this.queryBestU = new Float64Array(E);
    this.stamp = 0;
    this.ensureCandidateCapacity(START_CANDIDATES + 8 * SHELTER_CANDIDATES);
  }

  setBaselineWater(depth: Float32Array | null, nx: number, ny: number): void {
    const g = this.g;
    if (!g) return;
    this.maskVersion++;
    if (!depth) {
      this.sampleMask = null;
      this.baseWater = null;
      return;
    }
    if (!this.acceptGrid(depth, nx, ny)) return;
    this.captureBaseline(depth, nx, ny);
  }

  getEdgeDepths(): Float32Array | null {
    return this.g ? this.edgeDepth : null;
  }

  getRoadStatus(): RoadStatusArray | null {
    return this.g ? this.statusCur : null;
  }

  getGraphInfo(): { nodes: number; edges: number; samples: number; activeSamples: number } | null {
    const g = this.g;
    if (!g) return null;
    return {
      nodes: g.nodeCount,
      edges: g.edgeCount,
      samples: g.sampleCell.length,
      activeSamples: this.indexNx > 0 ? this.activeStart[g.edgeCount] : g.sampleCell.length,
    };
  }

  // ────────────────────────────────────────────────────────────────────────────────────────
  // Flood update
  // ────────────────────────────────────────────────────────────────────────────────────────

  updateFlood(depth: Float32Array, nx: number, ny: number): RoadStatusArray | null {
    const g = this.g;
    if (!g) return null;
    if (!this.acceptGrid(depth, nx, ny)) return null;

    this.lastDepth = depth;
    this.lastNx = nx;
    this.lastNy = ny;
    this.ensureIndex(nx, ny);

    const E = g.edgeCount;
    const start = this.activeStart;
    const idx = this.activeIdx;
    const edgeDepth = this.edgeDepth;
    const cost = this.edgeCost;
    const dry = g.edgeDryTime;
    const next = this.statusNext;
    const cur = this.statusCur;
    const wetDiv = 1 / WET_SPEED_FACTOR;
    let changed = !this.hasFlood;

    let s = start[0];
    for (let e = 0; e < E; e++) {
      const end = start[e + 1];
      let m = 0;
      // NaN depths (stability-demo blow-ups) fail the comparison and are ignored; +∞ floods the edge.
      for (; s < end; s++) {
        const d = depth[idx[s]];
        if (d > m) m = d;
      }
      edgeDepth[e] = m;
      const st = m >= ROAD_FLOODED_DEPTH ? STATUS_FLOODED : m >= ROAD_WET_DEPTH ? STATUS_WET : STATUS_DRY;
      next[e] = st;
      cost[e] = st === STATUS_DRY ? dry[e] : st === STATUS_WET ? dry[e] * wetDiv : Infinity;
      if (st !== cur[e]) changed = true;
    }
    this.hasFlood = true;

    // Identity changes iff the content changed: consumers can cheaply skip GPU re-uploads with ===.
    if (changed) {
      this.statusNext = cur;
      this.statusCur = next;
    }
    return this.statusCur;
  }

  /**
   * Validate a depth grid and relate it to the network's reference grid. A grid with a different size
   * but the same aspect ratio is treated as a resampling of the same domain; anything else is rejected.
   */
  private acceptGrid(depth: Float32Array, nx: number, ny: number): boolean {
    if (!(Number.isInteger(nx) && Number.isInteger(ny) && nx > 0 && ny > 0)) return false;
    if (!depth || depth.length < nx * ny) return false;
    if (this.refNx === 0 || this.refNy === 0) {
      this.refNx = nx;
      this.refNy = ny;
      return true;
    }
    return nx * this.refNy === ny * this.refNx;
  }

  /**
   * Mark samples that sit on standing water in `depth` (bridge spans) and their elevated approaches, so they
   * are ignored from now on (see APPROACH_FRACTION).
   */
  private captureBaseline(depth: Float32Array, nx: number, ny: number): void {
    const g = this.g!;
    const n = g.sampleCell.length;
    const mask = new Uint8Array(n);
    const sx = nx / this.refNx;
    const sy = ny / this.refNy;
    const cells = g.sampleCell;
    for (let s = 0; s < n; s++) {
      const key = cells[s];
      const idx = cellIndex(key & 0xffff, key >>> 16, sx, sy, nx, ny);
      if (depth[idx] >= ROAD_WET_DEPTH) mask[s] = 1;
    }

    // Extend every span along its edge by its approach allowance (in samples; samples per cell of road
    // length varies with the road's direction, so convert through the edge's sample density).
    const maxApproachCells = MAX_APPROACH_M / g.cellSize;
    for (let e = 0; e < g.edgeCount; e++) {
      const s0 = g.sampleStart[e], s1 = g.sampleStart[e + 1];
      const gl = g.edgeGridLength[e];
      if (s1 - s0 < 3 || !(gl > 0)) continue;
      const density = (s1 - s0) / gl;
      for (let s = s0; s < s1; ) {
        if (mask[s] !== 1) {
          s++;
          continue;
        }
        let r = s;
        while (r < s1 && mask[r] === 1) r++;
        const ext = Math.floor(Math.min(maxApproachCells * density, APPROACH_FRACTION * (r - s)));
        for (let k = Math.max(s0, s - ext); k < s; k++) if (mask[k] === 0) mask[k] = 2;
        for (let k = r; k < Math.min(s1, r + ext); k++) if (mask[k] === 0) mask[k] = 2;
        s = r;
      }
    }
    this.sampleMask = mask;

    const bits = new Uint8Array((nx * ny + 7) >> 3);
    for (let k = 0; k < nx * ny; k++) if (depth[k] >= ROAD_FLOODED_DEPTH) bits[k >> 3] |= 1 << (k & 7);
    this.baseWater = bits;
    this.baseNx = nx;
    this.baseNy = ny;
    this.maskVersion++;
  }

  /** (Re)build the flat depth-array index of every non-masked sample for an nx × ny depth grid. */
  private ensureIndex(nx: number, ny: number): void {
    if (this.indexNx === nx && this.indexNy === ny && this.indexMaskVersion === this.maskVersion) return;
    const g = this.g!;
    const cells = g.sampleCell;
    const sStart = g.sampleStart;
    const mask = this.sampleMask;
    const start = this.activeStart;
    const idx = this.activeIdx;
    const sx = nx / this.refNx;
    const sy = ny / this.refNy;
    let w = 0;
    for (let e = 0; e < g.edgeCount; e++) {
      start[e] = w;
      for (let s = sStart[e]; s < sStart[e + 1]; s++) {
        if (mask && mask[s]) continue;
        const key = cells[s];
        idx[w++] = cellIndex(key & 0xffff, key >>> 16, sx, sy, nx, ny);
      }
    }
    start[g.edgeCount] = w;
    this.indexNx = nx;
    this.indexNy = ny;
    this.indexMaskVersion = this.maskVersion;
  }

  /** True when (gx, gy) was standing water (river, lake) in the baseline field. */
  private isBaselineWater(gx: number, gy: number): boolean {
    const bits = this.baseWater;
    if (!bits || this.refNx === 0) return false;
    const i = clampInt(Math.floor(gx * (this.baseNx / this.refNx)), this.baseNx - 1);
    const j = clampInt(Math.floor(gy * (this.baseNy / this.refNy)), this.baseNy - 1);
    const k = j * this.baseNx + i;
    return (bits[k >> 3] & (1 << (k & 7))) !== 0;
  }

  /** Water depth (m) of the latest field at a grid coordinate, 0 when unknown. */
  private depthAt(gx: number, gy: number): number {
    const d = this.lastDepth;
    const nx = this.lastNx, ny = this.lastNy;
    if (!d || d.length < nx * ny || nx === 0) return 0;
    const i = clampInt(Math.floor(gx * (nx / this.refNx)), nx - 1);
    const j = clampInt(Math.floor(gy * (ny / this.refNy)), ny - 1);
    const v = d[j * nx + i];
    return v > 0 ? v : 0;
  }

  /**
   * Deepest water crossed walking the straight line (x0,y0) → (x1,y1) in network grid coords, excluding
   * the cell of the end point (the road itself, which may legitimately sit over a bridge's river cell).
   */
  private maxDepthAlong(x0: number, y0: number, x1: number, y1: number): number {
    const d = this.lastDepth;
    const nx = this.lastNx, ny = this.lastNy;
    if (!d || d.length < nx * ny || nx === 0) return 0;
    const sx = nx / this.refNx, sy = ny / this.refNy;
    const ax = clampF(x0 * sx, nx), ay = clampF(y0 * sy, ny), bx = clampF(x1 * sx, nx), by = clampF(y1 * sy, ny);
    let i = Math.floor(ax), j = Math.floor(ay);
    const iEnd = Math.floor(bx), jEnd = Math.floor(by);
    let remI = Math.abs(iEnd - i), remJ = Math.abs(jEnd - j);
    const dx = bx - ax, dy = by - ay;
    const stepI = iEnd > i ? 1 : -1, stepJ = jEnd > j ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    let tmx = dx > 0 ? (i + 1 - ax) / dx : dx < 0 ? (ax - i) / -dx : Infinity;
    let tmy = dy > 0 ? (j + 1 - ay) / dy : dy < 0 ? (ay - j) / -dy : Infinity;
    let m = 0;
    while (remI > 0 || remJ > 0) {
      const v = d[j * nx + i];
      if (v > m) m = v;
      if (remJ === 0 || (remI > 0 && tmx < tmy)) {
        i += stepI;
        tmx += tdx;
        remI--;
      } else {
        j += stepJ;
        tmy += tdy;
        remJ--;
      }
    }
    return m;
  }

  // ────────────────────────────────────────────────────────────────────────────────────────
  // Routing
  // ────────────────────────────────────────────────────────────────────────────────────────

  route(start: { gx: number; gy: number } | null, shelters: Shelter[]): DelugeRouteResult {
    const g = this.g;
    if (!g || g.edgeCount === 0) return none('no-roads', NONE_NO_ROADS);
    if (!start || !Number.isFinite(start.gx) || !Number.isFinite(start.gy)) return none('no-start', NONE_NO_START);
    if (!shelters) shelters = [];
    if (!shelters.every(isValidShelter)) shelters = shelters.filter(isValidShelter);
    if (shelters.length === 0) return none('no-shelters', NONE_NO_SHELTERS);
    this.ensureCandidateCapacity(START_CANDIDATES + shelters.length * SHELTER_CANDIDATES);

    // 1. The start itself under water: a misplaced click into a river, or a home that is flooded — don't
    //    send anyone driving into floodwater.
    const startDepth = this.depthAt(start.gx, start.gy);
    if (startDepth >= ROAD_FLOODED_DEPTH && this.isBaselineWater(start.gx, start.gy)) {
      return none(
        'start-in-water-body',
        `Start point is under ${startDepth.toFixed(1)} m of water (river or lake) — click on land with the Evac tool.`,
      );
    }
    if (startDepth >= ROAD_FLOODED_DEPTH) {
      const advice = `Start point is under ${startDepth.toFixed(1)} m of water — don't drive into floodwater. ${SHELTER_IN_PLACE}`;
      return this.blocked(start, shelters, 'start-flooded', advice);
    }

    // 2. Snap the start onto usable roads.
    this.candCount = 0;
    const nStart = this.addCandidates(start.gx, start.gy, START_CANDIDATES, SHELTER_NONE, false);
    if (nStart === 0) {
      if (this.addCandidates(start.gx, start.gy, 1, SHELTER_NONE, true) === 0) return none('start-off-network', NONE_START_FAR);
      return this.blocked(start, shelters, 'start-roads-flooded', ADVICE_START_ROADS);
    }

    // 3. Snap every shelter that is itself above water.
    let anyDryShelter = false;
    for (let k = 0; k < shelters.length; k++) {
      const s = shelters[k];
      if (this.depthAt(s.gx, s.gy) >= ROAD_FLOODED_DEPTH) continue;
      anyDryShelter = true;
      this.addCandidates(s.gx, s.gy, SHELTER_CANDIDATES, k, false);
    }
    if (this.candCount === nStart) {
      if (!anyDryShelter) return this.blocked(start, shelters, 'shelters-flooded', ADVICE_SHELTERS_FLOODED);
      let anyNearRoad = false;
      for (let k = 0; k < shelters.length && !anyNearRoad; k++) {
        const c0 = this.candCount;
        anyNearRoad = this.addCandidates(shelters[k].gx, shelters[k].gy, 1, k, true) > 0;
        this.candCount = c0;
      }
      if (!anyNearRoad) return none('shelters-off-network', NONE_SHELTERS_FAR);
      return this.blocked(start, shelters, 'cut-off', ADVICE_CUT_OFF);
    }

    // 4. Multi-source / multi-target Dijkstra over travel time.
    if (!this.search(nStart, false)) return this.blocked(start, shelters, 'cut-off', ADVICE_CUT_OFF);

    const shelter = shelters[this.candShelter[this.bestTargetCand()]];
    const polyline = this.buildPath(start.gx, start.gy, shelters);
    const eta = this.best;
    let meters = 0;
    let wetMeters = 0;
    for (let p = 0; p < this.pieceCount; p++) {
      meters += this.pieceMeters[p];
      const e = this.pieceEdge[p];
      if (e >= 0 && this.statusCur[e] === STATUS_WET) wetMeters += this.pieceMeters[p];
    }

    if (wetMeters < 1) wetMeters = 0; // less than a metre of wet road isn't worth a warning
    const via = this.mainStreetNames();
    let message = `${via.length ? `Via ${via.join(' → ')} to` : 'Route to'} ${shelter.name} — ${formatDistance(meters)}, ${formatDuration(eta)}`;
    if (wetMeters > 0) message += ` (${formatDistance(wetMeters)} through shallow water — drive slowly)`;
    return { state: 'ok', polyline, lengthMeters: meters, etaSeconds: eta, shelter, message, reason: null, via, wetMeters, advice: '', diagnosis: null };
  }

  /**
   * A 'blocked' result. Its polyline is the route that *would* be taken if flooded roads were passable
   * (the one the flood has cut), so the renderer can draw it in red; null if even that doesn't exist.
   * The message is "No safe route — <advice>", except when the advice is already about the start point.
   *
   * It also measures WHY (RouteDiagnosis): depth over the start, how many shelters are above water, how many roads
   * the start can still reach, and — from the cut route it has just rebuilt — how long that drive was and how much
   * of it is under water. A cut route that does not exist at all means the start reaches no shelter even on a dry
   * network: a gap in the road data, not a flood. All of it comes from work this path already does, so a route that
   * is fine measures nothing.
   */
  private blocked(start: { gx: number; gy: number }, shelters: Shelter[], reason: RouteReason, advice: string): DelugeRouteResult {
    const message = reason === 'start-flooded' ? advice : `No safe route — ${advice[0].toLowerCase()}${advice.slice(1)}`;
    const startDepth = this.depthAt(start.gx, start.gy);
    let dryShelters = 0;
    for (let k = 0; k < shelters.length; k++) if (this.depthAt(shelters[k].gx, shelters[k].gy) < ROAD_FLOODED_DEPTH) dryShelters++;
    this.candCount = 0;
    const startRoadsUsable = this.addCandidates(start.gx, start.gy, START_CANDIDATES, SHELTER_NONE, false);
    this.candCount = 0;
    const nStart = this.addCandidates(start.gx, start.gy, START_CANDIDATES, SHELTER_NONE, true);
    let polyline: Float32Array | null = null;
    let cutRoute: RouteDiagnosis['cutRoute'] = null;
    if (nStart > 0) {
      for (let k = 0; k < shelters.length; k++) {
        this.addCandidates(shelters[k].gx, shelters[k].gy, SHELTER_CANDIDATES, k, true);
      }
      if (this.candCount > nStart && this.search(nStart, true)) {
        const etaSeconds = this.best;
        polyline = this.buildPath(start.gx, start.gy, shelters);
        let meters = 0;
        let floodedMeters = 0;
        for (let p = 0; p < this.pieceCount; p++) {
          meters += this.pieceMeters[p];
          const e = this.pieceEdge[p];
          if (e >= 0 && this.statusCur[e] === STATUS_FLOODED) floodedMeters += this.pieceMeters[p];
        }
        const shelter = shelters[this.candShelter[this.bestTargetCand()]];
        cutRoute = { lengthMeters: meters, etaSeconds, shelterName: shelter?.name ?? '', floodedMeters };
      }
    }
    const diagnosis: RouteDiagnosis = { startDepth, shelters: shelters.length, dryShelters, startRoads: nStart, startRoadsUsable, cutRoute };
    return { state: 'blocked', polyline, lengthMeters: 0, etaSeconds: 0, shelter: null, message, reason, via: [], wetMeters: 0, advice, diagnosis };
  }

  private ensureCandidateCapacity(n: number): void {
    if (n <= this.candCap) return;
    const cap = Math.max(n, this.candCap * 2);
    this.candEdge = new Int32Array(cap);
    this.candSeg = new Int32Array(cap);
    this.candU = new Float64Array(cap);
    this.candX = new Float64Array(cap);
    this.candY = new Float64Array(cap);
    this.candFrac = new Float64Array(cap);
    this.candConn = new Float64Array(cap);
    this.candShelter = new Int32Array(cap);
    this.attachNext = new Int32Array(cap * 2);
    this.attachCost = new Float64Array(cap * 2);
    this.candCap = cap;
  }

  /**
   * Append up to `k` snap candidates for point (x, y): the nearest distinct road edges within the snap
   * radius, each with the exact projection onto its polyline. Unless `anyStatus`, flooded edges are skipped
   * and so are candidates whose straight connector to the road crosses deep water (e.g. the far bank of a
   * river, or a flooded yard). Returns the number appended.
   */
  private addCandidates(x: number, y: number, k: number, shelter: number, anyStatus: boolean): number {
    const g = this.g!;
    const h = g.hash;
    const r = SNAP_RADIUS_M / g.cellSize;
    const r2 = r * r;
    const status = this.statusCur;
    const px = g.px, py = g.py, ptEdge = g.ptEdge, edgeA = g.edgeA, edgeB = g.edgeB;
    const stampArr = this.queryStamp, bestD2 = this.queryBestD2, bestSeg = this.queryBestSeg, bestU = this.queryBestU;
    const stamp = ++this.stamp;
    if (stamp === 0x7fffffff) {
      stampArr.fill(0);
      this.stamp = 1;
    }
    const st = this.stamp;

    const inv = 1 / h.bucketSize;
    const c0 = Math.max(0, Math.floor((x - r - h.originX) * inv));
    const c1 = Math.min(h.cols - 1, Math.floor((x + r - h.originX) * inv));
    const r0 = Math.max(0, Math.floor((y - r - h.originY) * inv));
    const r1 = Math.min(h.rows - 1, Math.floor((y + r - h.originY) * inv));
    let touchedCount = 0;

    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const b = row * h.cols + col;
        for (let q = h.bucketStart[b]; q < h.bucketStart[b + 1]; q++) {
          const p = h.bucketSeg[q];
          const e = ptEdge[p];
          if (edgeA[e] < 0 || edgeB[e] < 0) continue;
          if (!anyStatus && status[e] === STATUS_FLOODED) continue;
          const ax = px[p], ay = py[p];
          const vx = px[p + 1] - ax, vy = py[p + 1] - ay;
          const l2 = vx * vx + vy * vy;
          let u = l2 > 0 ? ((x - ax) * vx + (y - ay) * vy) / l2 : 0;
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          const ex = ax + u * vx - x, ey = ay + u * vy - y;
          const d2 = ex * ex + ey * ey;
          if (!(d2 <= r2)) continue;
          if (stampArr[e] !== st) {
            stampArr[e] = st;
            bestD2[e] = d2;
            bestSeg[e] = p;
            bestU[e] = u;
            if (touchedCount === this.touched.length) {
              const t = new Int32Array(this.touched.length * 2);
              t.set(this.touched);
              this.touched = t;
            }
            this.touched[touchedCount++] = e;
          } else if (d2 < bestD2[e]) {
            bestD2[e] = d2;
            bestSeg[e] = p;
            bestU[e] = u;
          }
        }
      }
    }

    // Selection of the k nearest (touched lists are small), validating connectors in distance order.
    let added = 0;
    let rejected = 0;
    const touched = this.touched;
    while (added < k && rejected < 24) {
      let bi = -1;
      let bd = Infinity;
      for (let t = 0; t < touchedCount; t++) {
        const d2 = bestD2[touched[t]];
        if (d2 < bd) {
          bd = d2;
          bi = t;
        }
      }
      if (bi < 0) break;
      const e = touched[bi];
      bestD2[e] = Infinity; // consumed
      const p = bestSeg[e], u = bestU[e];
      const qx = px[p] + u * (px[p + 1] - px[p]);
      const qy = py[p] + u * (py[p + 1] - py[p]);
      if (!anyStatus && this.maxDepthAlong(x, y, qx, qy) >= ROAD_FLOODED_DEPTH) {
        rejected++;
        continue;
      }
      const c = this.candCount++;
      this.candEdge[c] = e;
      this.candSeg[c] = p;
      this.candU[c] = u;
      this.candX[c] = qx;
      this.candY[c] = qy;
      this.candConn[c] = Math.sqrt(bd);
      this.candShelter[c] = shelter;
      // Fraction of the edge's polyline length before the projection point.
      let along = 0;
      for (let q = g.ptStart[e]; q <= p; q++) {
        const dx = px[q + 1] - px[q], dy = py[q + 1] - py[q];
        along += (q < p ? 1 : u) * Math.sqrt(dx * dx + dy * dy);
      }
      const gl = g.edgeGridLength[e];
      this.candFrac[c] = gl > 0 ? Math.min(1, along / gl) : 0;
      added++;
    }
    return added;
  }

  /**
   * Dijkstra from the start candidates (slots 0..nStart) to the shelter candidates (slots nStart..candCount).
   * Shelter candidates hang off both endpoints of their edge as "attachments" with the partial-edge cost;
   * the search stops once the cheapest unsettled node can't beat the best attachment found.
   */
  private search(nStart: number, ignoreFlood: boolean): boolean {
    const g = this.g!;
    const cost = ignoreFlood || !this.hasFlood ? g.edgeDryTime : this.edgeCost;
    const dist = this.dist, pred = this.predEdge, heap = this.heap;
    const head = this.attachHead, next = this.attachNext, acost = this.attachCost;
    const edgeA = g.edgeA, edgeB = g.edgeB, adjStart = g.adjStart, adjTo = g.adjTo, adjEdge = g.adjEdge;
    const connSec = g.cellSize / CONNECTOR_SPEED; // seconds per grid cell of off-road connector

    dist.fill(Infinity);
    heap.clear();
    this.best = Infinity;
    this.bestAttachCand = this.bestAttachNode = this.bestDirectStart = this.bestDirectTarget = -1;

    // Attach shelter candidates to their edge endpoints. Attachment id 2c = via node a, 2c+1 = via node b.
    for (let c = nStart; c < this.candCount; c++) {
      const e = this.candEdge[c];
      const t = cost[e];
      const f = this.candFrac[c];
      const conn = this.candConn[c] * connSec;
      const a = edgeA[e], b = edgeB[e];
      acost[2 * c] = f * t + conn;
      next[2 * c] = head[a];
      head[a] = 2 * c;
      acost[2 * c + 1] = (1 - f) * t + conn;
      next[2 * c + 1] = head[b];
      head[b] = 2 * c + 1;
    }

    // Seed from start candidates; also consider start & shelter snapped onto the very same edge.
    for (let s = 0; s < nStart; s++) {
      const e = this.candEdge[s];
      const t = cost[e];
      const f = this.candFrac[s];
      const conn = this.candConn[s] * connSec;
      this.seed(edgeA[e], f * t + conn, 2 * s);
      this.seed(edgeB[e], (1 - f) * t + conn, 2 * s + 1);
      for (let c = nStart; c < this.candCount; c++) {
        if (this.candEdge[c] !== e) continue;
        const direct = Math.abs(f - this.candFrac[c]) * t + conn + this.candConn[c] * connSec;
        if (direct < this.best) {
          this.best = direct;
          this.bestDirectStart = s;
          this.bestDirectTarget = c;
          this.bestAttachCand = -1;
        }
      }
    }

    while (heap.size > 0) {
      const u = heap.peek();
      const du = dist[u];
      if (du >= this.best) break;
      heap.pop();
      for (let a = head[u]; a >= 0; a = next[a]) {
        const total = du + acost[a];
        if (total < this.best) {
          this.best = total;
          this.bestAttachCand = a >> 1;
          this.bestAttachSide = a & 1;
          this.bestAttachNode = u;
          this.bestDirectStart = this.bestDirectTarget = -1;
        }
      }
      for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
        const e = adjEdge[k];
        const nd = du + cost[e];
        const v = adjTo[k];
        if (nd < dist[v]) {
          dist[v] = nd;
          pred[v] = e;
          heap.pushOrDecrease(v);
        }
      }
    }

    // Detach shelter candidates.
    for (let c = nStart; c < this.candCount; c++) {
      const e = this.candEdge[c];
      head[edgeA[e]] = -1;
      head[edgeB[e]] = -1;
    }
    return this.best < Infinity;
  }

  /** Offer `node` as a search source with initial cost d; `sideCode` = 2 × start candidate + side. */
  private seed(node: number, d: number, sideCode: number): void {
    if (!(d < this.dist[node])) return;
    this.dist[node] = d;
    this.predEdge[node] = -1;
    this.seedCand[node] = sideCode;
    this.heap.pushOrDecrease(node);
  }

  private bestTargetCand(): number {
    return this.bestAttachCand >= 0 ? this.bestAttachCand : this.bestDirectTarget;
  }

  /** Rebuild the polyline + per-edge pieces of the best path found by search(); returns a fresh array. */
  private buildPath(sx: number, sy: number, shelters: Shelter[]): Float32Array {
    const g = this.g!;
    this.polyLen = 0;
    this.pieceCount = 0;

    if (this.bestDirectStart >= 0) {
      const s = this.bestDirectStart, c = this.bestDirectTarget;
      const e = this.candEdge[s];
      this.pushConnector(sx, sy, s, true);
      this.push(this.candX[s], this.candY[s]);
      const ps = this.candSeg[s], us = this.candU[s], pc = this.candSeg[c], uc = this.candU[c];
      if (ps < pc || (ps === pc && us <= uc)) {
        for (let q = ps + 1; q <= pc; q++) this.push(g.px[q], g.py[q]);
      } else {
        for (let q = ps; q > pc; q--) this.push(g.px[q], g.py[q]);
      }
      this.push(this.candX[c], this.candY[c]);
      this.addPiece(e, Math.abs(this.candFrac[s] - this.candFrac[c]) * g.edgeLength[e]);
      const sh = shelters[this.candShelter[c]];
      this.pushConnector(sh.gx, sh.gy, c, false);
    } else {
      // Trace predecessor edges back from the node the winning shelter attachment hangs off.
      const c = this.bestAttachCand;
      const endNode = this.bestAttachNode;
      let n = 0;
      let node = endNode;
      for (let guard = 0; this.predEdge[node] >= 0 && guard <= g.nodeCount; guard++) {
        const e = this.predEdge[node];
        if (n === this.pathEdges.length) {
          const t = new Int32Array(n * 2);
          t.set(this.pathEdges);
          this.pathEdges = t;
        }
        this.pathEdges[n++] = e;
        node = g.edgeA[e] === node ? g.edgeB[e] : g.edgeA[e];
      }
      const seedNode = node;
      const s = this.seedCand[seedNode] >> 1;
      const startSide = this.seedCand[seedNode] & 1;

      // Start connector + partial start edge from the projection to the seed node.
      const es = this.candEdge[s];
      this.pushConnector(sx, sy, s, true);
      this.push(this.candX[s], this.candY[s]);
      const ps = this.candSeg[s];
      if (startSide === 0) {
        for (let q = ps; q >= g.ptStart[es]; q--) this.push(g.px[q], g.py[q]);
        this.addPiece(es, this.candFrac[s] * g.edgeLength[es]);
      } else {
        for (let q = ps + 1; q < g.ptStart[es + 1]; q++) this.push(g.px[q], g.py[q]);
        this.addPiece(es, (1 - this.candFrac[s]) * g.edgeLength[es]);
      }

      // Whole edges, in travel order, each oriented from the node we leave to the node we reach.
      let at = seedNode;
      for (let k = n - 1; k >= 0; k--) {
        const e = this.pathEdges[k];
        const p0 = g.ptStart[e], p1 = g.ptStart[e + 1] - 1;
        if (g.edgeA[e] === at) {
          for (let q = p0 + 1; q <= p1; q++) this.push(g.px[q], g.py[q]);
          at = g.edgeB[e];
        } else {
          for (let q = p1 - 1; q >= p0; q--) this.push(g.px[q], g.py[q]);
          at = g.edgeA[e];
        }
        this.addPiece(e, g.edgeLength[e]);
      }

      // Partial target edge from the end node to the shelter's projection + shelter connector.
      const ec = this.candEdge[c];
      const pc = this.candSeg[c];
      if (this.bestAttachSide === 0) {
        for (let q = g.ptStart[ec] + 1; q <= pc; q++) this.push(g.px[q], g.py[q]);
        this.addPiece(ec, this.candFrac[c] * g.edgeLength[ec]);
      } else {
        for (let q = g.ptStart[ec + 1] - 2; q > pc; q--) this.push(g.px[q], g.py[q]);
        this.addPiece(ec, (1 - this.candFrac[c]) * g.edgeLength[ec]);
      }
      this.push(this.candX[c], this.candY[c]);
      const sh = shelters[this.candShelter[c]];
      this.pushConnector(sh.gx, sh.gy, c, false);
    }
    return this.poly.slice(0, this.polyLen * 2);
  }

  /** Off-road leg between a point and its snapped road position (only when it is visibly long). */
  private pushConnector(x: number, y: number, cand: number, atStart: boolean): void {
    const meters = this.candConn[cand] * this.g!.cellSize;
    if (meters > 0) this.addPiece(-1, meters);
    // Start: the point precedes its road projection; shelter: it follows. Sub-metre legs are omitted.
    if (meters >= 0.5) this.push(x, y);
  }

  private push(x: number, y: number): void {
    const n = this.polyLen;
    if (n > 0) {
      const lx = this.poly[2 * n - 2], ly = this.poly[2 * n - 1];
      if (Math.abs(lx - x) < 1e-4 && Math.abs(ly - y) < 1e-4) return;
    }
    if (2 * n + 2 > this.poly.length) {
      const t = new Float32Array(this.poly.length * 2);
      t.set(this.poly);
      this.poly = t;
    }
    this.poly[2 * n] = x;
    this.poly[2 * n + 1] = y;
    this.polyLen = n + 1;
  }

  private addPiece(edge: number, meters: number): void {
    if (this.pieceCount === this.pieceEdge.length) {
      const e = new Int32Array(this.pieceCount * 2);
      e.set(this.pieceEdge);
      this.pieceEdge = e;
      const m = new Float64Array(this.pieceCount * 2);
      m.set(this.pieceMeters);
      this.pieceMeters = m;
    }
    this.pieceEdge[this.pieceCount] = edge;
    this.pieceMeters[this.pieceCount++] = meters;
  }

  /** Up to two street names with the most distance along the route, in travel order. */
  private mainStreetNames(): string[] {
    const g = this.g!;
    const names = this.nameList, meters = this.nameMeters, first = this.nameFirst;
    names.length = meters.length = first.length = 0;
    for (let p = 0; p < this.pieceCount; p++) {
      const e = this.pieceEdge[p];
      if (e < 0) continue;
      const name = g.edgeName[e];
      if (!name) continue;
      let k = names.indexOf(name);
      if (k < 0) {
        k = names.length;
        names.push(name);
        meters.push(0);
        first.push(p);
      }
      meters[k] += this.pieceMeters[p];
    }
    if (names.length === 0) return [];
    let k1 = 0;
    for (let k = 1; k < names.length; k++) if (meters[k] > meters[k1]) k1 = k;
    let k2 = -1;
    for (let k = 0; k < names.length; k++) if (k !== k1 && (k2 < 0 || meters[k] > meters[k2])) k2 = k;
    if (k2 < 0) return [names[k1]];
    return first[k1] <= first[k2] ? [names[k1], names[k2]] : [names[k2], names[k1]];
  }
}

function isValidShelter(s: Shelter | null | undefined): boolean {
  return !!s && Number.isFinite(s.gx) && Number.isFinite(s.gy);
}

/** A 'none' result: its message says how to get a route, so it doubles as the advice. */
function none(reason: RouteReason, message: string): DelugeRouteResult {
  return { state: 'none', polyline: null, lengthMeters: 0, etaSeconds: 0, shelter: null, message, reason, via: [], wetMeters: 0, advice: message, diagnosis: null };
}

function clampInt(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

/** Clamp a continuous grid coordinate into [0, n) so its floor is a valid cell. */
function clampF(v: number, n: number): number {
  return v < 0 ? 0 : v > n - 1e-3 ? n - 1e-3 : v;
}

/** Flat index into an nx × ny grid of reference cell (i, j), rescaled by (sx, sy) and clamped. */
function cellIndex(i: number, j: number, sx: number, sy: number, nx: number, ny: number): number {
  if (sx !== 1) i = Math.floor((i + 0.5) * sx);
  if (sy !== 1) j = Math.floor((j + 0.5) * sy);
  if (i > nx - 1) i = nx - 1;
  if (j > ny - 1) j = ny - 1;
  return j * nx + i;
}
