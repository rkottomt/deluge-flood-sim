/**
 * Pedestrian evacuation routing: people ON FOOT leaving a building, over a walking network, against a flood that
 * changes with time (ARCHITECTURE.md §7.1).
 *
 * The car router (router.ts) answers for one depth field. People walking out of a building need the flood as it
 * develops: a street that is safe at T+10 min may be knee-deep and fast at T+40. HazardFields carries, per cell, the
 * maxima of the run and the moment water first stood 15 cm deep (firstWet), so — exactly like egress.ts — an
 * EARLY (pessimistic) timeline is rebuilt: a cell whose maxima are unsafe for people is treated as unsafe from the
 * moment water first arrived there. Water with no arrival time (firstWet −1: never 15 cm deep) is not "from T+0": it
 * does not slow walkers, and when it is unsafe (thin and fast) the edge closes from the end of the run, counted as
 * UNTIMED in the result (walkHazard).
 *
 * WALKING NETWORK. The baked road files are TIGER/Line (US) or OSM drivable ways (the global presets); neither carries
 * footways, paths or steps, so people walk along every road edge, in both directions, ignoring car-only restrictions
 * (one-way rules are not in the data in the first place). When a network does carry footways (a future OSM bake), the
 * same graph code takes them as ordinary edges. Bridges are handled as in router.ts: samples over water present at
 * reset (firstWet = 0) and their approaches are ignored, so a river bridge is judged by its landings.
 *
 * SAFE FOR PEOPLE. An edge is unsafe for walking once ANY cell under it (bridges excepted) reaches
 *   • FD2321 hazard rating HR = d (v + 0.5) + DF ≥ 0.75 — "danger for some" (DEFRA / Environment Agency, Flood Risks to
 *     People FD2321/TR2, 2006; the debris factor DF is the standard urban table, hazard.ts), or
 *   • AIDR class H3 or worse — "unsafe for children and the elderly" (AIDR Guideline 7-3, 2017; d > 0.5 m or d·v > 0.6),
 * i.e. people are only routed through water inside AIDR H1–H2 and FD2321 "low". d·v is the solver's own maximum (the
 * maxima come from different moments); without speeds (the snapshot fallback) only depth decides, which understates
 * the hazard — the UI says so. A wet but safe edge (≥ 5 cm) is walked at WADE_SPEED_FACTOR of the dry pace [I].
 *
 * TIME-DEPENDENT SEARCH. Departing at t0 at speed s, a label-setting Dijkstra on arrival time: an edge may be used only
 * if the walker is across it before it turns unsafe. Edges only ever close (the timeline is monotone), so arrival is
 * FIFO and Dijkstra is exact; and if no refuge can be reached departing at t0, none can departing later — the latest
 * safe departure is found by bisection.
 *
 * REFUGES. Any named shelter that stays safe, and ANY high ground: a network node that stays dry for the whole run (no
 * water ≥ 5 cm in its own or its 8 neighbouring cells) and stands at least HIGH_GROUND_FREEBOARD_M above the highest
 * water surface within HIGH_GROUND_RADIUS_M of it [I]. "For the run as simulated": a run stopped before the crest
 * cannot know the crest.
 *
 * Pure: no DOM, no GPU. Grid coordinates are the network's (the terrain grid); a HazardFields of another size with
 * the same aspect is treated as a resampling of the same domain, as in router.ts.
 */
import type { HazardFields, RoadNetwork } from '../contracts';
import { aidrClass, debrisFactor } from '../loss/hazard';
import { APPROACH_FRACTION, MAX_APPROACH_M, SNAP_RADIUS_M } from './constants';
import { buildRoadGraph, type RoadGraph } from './graph';
import { IndexedMinHeap } from './heap';

/** FD2321 "low" ends here: HR ≥ 0.75 is "danger for some — children, the elderly and the infirm". */
export const WALK_UNSAFE_HR = 0.75;
/** AIDR H3 "unsafe for vehicles, children and the elderly" and worse are unsafe to walk through. */
export const WALK_UNSAFE_AIDR = 3;
/** Depth (m) from which an edge is wet: walked, but slowly (wading). */
export const WALK_WET_DEPTH = 0.05;
/** Walking pace through shallow water as a share of the dry pace [I] (no sourced figure; wading is slow). */
export const WADE_SPEED_FACTOR = 0.5;
/** High ground: radius (m) over which the highest water surface is taken, and the margin (m) above it [I]. */
export const HIGH_GROUND_RADIUS_M = 300;
export const HIGH_GROUND_FREEBOARD_M = 1;
/** Nodes considered when a point (the building door, a shelter) is put onto the network. */
const SEED_NODES = 6;
/** Seeds farther than the nearest node by more than this are dropped, m. */
const SEED_SLACK_M = 60;

/** Unsafe for people walking (see the header). `v` may be NaN (speed unknown): depth alone then decides. */
export function unsafeForWalking(d: number, v: number, dv: number): boolean {
  if (!(d >= WALK_WET_DEPTH)) return false;
  const vv = Number.isFinite(v) ? v : 0;
  const dvv = Number.isFinite(dv) ? dv : d * vv;
  const hr = dvv + 0.5 * d + debrisFactor(d, vv);
  return hr >= WALK_UNSAFE_HR || aidrClass(d, vv, dvv) >= WALK_UNSAFE_AIDR;
}

/** Per-edge walking hazard timeline (s since reset). */
export interface WalkHazard {
  /** When the edge turns unsafe for people; +∞ if it stays safe for the run. */
  tUnsafe: Float64Array;
  /** When water ≥ WALK_WET_DEPTH first stood on it (wading pace from then); +∞ if never. */
  tWet: Float64Array;
  /** Simulated time the fields were read at: nothing is known beyond it. */
  simTime: number;
  /** The fields carried speeds (false: snapshot fallback, depth only). */
  speedsKnown: boolean;
  /** Edges unsafe only through water with no arrival time, closed from the end of the run (walkHazard UNTIMED). */
  untimedUnsafe: number;
}

export interface WalkPoint {
  gx: number;
  gy: number;
  name?: string;
}

export interface WalkSeed {
  node: number;
  /** Straight-line connector from the point to the node, m. */
  meters: number;
  /** When the connector's own ground turns unsafe for people, s (+∞ never). */
  tUnsafe: number;
}

export interface WalkSearchResult {
  ok: boolean;
  /** Arrival time at the refuge, s since reset (NaN when !ok). */
  arrive: number;
  /** Refuge node reached (−1 when !ok). */
  node: number;
}

export interface WalkRoute {
  /** Grid polyline from the start point to the refuge node. */
  polyline: Float32Array;
  meters: number;
}

/**
 * A walking network for one terrain grid: the road graph (walked both ways) plus scratch for the time-dependent
 * search. Build once per scene; feed it a HazardFields with setFields().
 */
export class WalkNetwork {
  readonly g: RoadGraph;
  private hz: WalkHazard | null = null;
  private fields: HazardFields | null = null;
  private refuge: Uint8Array;
  private refugeName = new Map<number, string>();
  private readonly dist: Float64Array;
  private readonly pred: Int32Array;
  private readonly heap: IndexedMinHeap;
  /** True when the network came with footways (never for today's baked roads). */
  readonly hasFootways: boolean;

  constructor(
    net: RoadNetwork,
    cellSize: number,
    readonly refNx: number,
    readonly refNy: number,
  ) {
    this.g = buildRoadGraph(net, cellSize);
    const N = this.g.nodeCount;
    this.dist = new Float64Array(N);
    this.pred = new Int32Array(N);
    this.heap = new IndexedMinHeap(N, this.dist);
    this.refuge = new Uint8Array(N);
    this.hasFootways = false;
  }

  get hazard(): WalkHazard | null {
    return this.hz;
  }

  /**
   * Read a flood: the per-edge timeline, and the refuges (`shelters` that stay safe, plus high ground when `ground` —
   * bare-earth elevation on the fields' grid — is given).
   */
  setFields(f: HazardFields, opts: { ground?: Float32Array | null; shelters?: readonly WalkPoint[]; highGround?: boolean } = {}): void {
    this.fields = f;
    this.hz = walkHazard(this.g, this.refNx, this.refNy, f);
    this.refuge = opts.ground && opts.highGround !== false ? highGroundNodes(this.g, this.refNx, this.refNy, f, opts.ground) : new Uint8Array(this.g.nodeCount);
    this.refugeName = new Map();
    for (const s of opts.shelters ?? []) {
      if (!Number.isFinite(s.gx) || !Number.isFinite(s.gy)) continue;
      // A shelter that itself becomes unsafe is no refuge.
      const c = this.fieldCell(s.gx, s.gy);
      if (c >= 0 && unsafeForWalking(f.maxDepth[c], f.maxSpeed[c], f.maxDV[c])) continue;
      const seeds = this.seeds(s.gx, s.gy, 1);
      if (!seeds.length) continue;
      this.refuge[seeds[0].node] = 1;
      this.refugeName.set(seeds[0].node, s.name ?? 'Shelter');
    }
  }

  isRefuge(node: number): boolean {
    return this.refuge[node] === 1;
  }

  /** Shelter name of a refuge node ('' for high ground). */
  refugeLabel(node: number): string {
    return this.refugeName.get(node) ?? '';
  }

  refugeCount(): number {
    let n = 0;
    for (let k = 0; k < this.refuge.length; k++) n += this.refuge[k];
    return n;
  }

  /** Flat index into the fields' grid of a network grid point (−1 without fields). */
  fieldCell(gx: number, gy: number): number {
    const f = this.fields;
    if (!f) return -1;
    const i = Math.min(f.nx - 1, Math.max(0, Math.floor((gx * f.nx) / this.refNx)));
    const j = Math.min(f.ny - 1, Math.max(0, Math.floor((gy * f.ny) / this.refNy)));
    return j * f.nx + i;
  }

  /** The nearest usable nodes within SNAP_RADIUS_M of a point, nearest first. */
  seeds(gx: number, gy: number, k = SEED_NODES): WalkSeed[] {
    const g = this.g;
    const r = SNAP_RADIUS_M / g.cellSize;
    const r2 = r * r;
    const best: Array<{ node: number; d2: number }> = [];
    for (let n = 0; n < g.nodeCount; n++) {
      if (g.adjStart[n + 1] === g.adjStart[n]) continue;
      const dx = g.nodeX[n] - gx, dy = g.nodeY[n] - gy;
      const d2 = dx * dx + dy * dy;
      if (!(d2 <= r2)) continue;
      if (best.length < k) best.push({ node: n, d2 });
      else if (d2 < best[best.length - 1].d2) best[best.length - 1] = { node: n, d2 };
      else continue;
      best.sort((a, b) => a.d2 - b.d2);
    }
    // Only nodes about as near as the nearest (a door connects to its own street, not to one 300 m away across a
    // block), and never across a river; water that turns unsafe later closes the connector from then, like an edge.
    const near = best.length ? Math.sqrt(best[0].d2) * g.cellSize + SEED_SLACK_M : 0;
    return best
      .map((b) => ({ node: b.node, meters: Math.sqrt(b.d2) * g.cellSize, tUnsafe: this.connectorUnsafeAt(gx, gy, g.nodeX[b.node], g.nodeY[b.node]) }))
      .filter((b) => b.meters <= near && b.tUnsafe > -Infinity);
  }

  /**
   * When the straight connector (x0,y0) → (x1,y1) turns unsafe for people (s; +∞ never), or −∞ when it crosses a
   * river (water present at reset, ≥ 0.3 m): nobody walks across that.
   */
  private connectorUnsafeAt(x0: number, y0: number, x1: number, y1: number): number {
    const f = this.fields;
    if (!f) return Infinity;
    const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
    let t = Infinity;
    let untimed = false;
    for (let k = 1; k < steps; k++) {
      const c = this.fieldCell(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps);
      const fw = f.firstWet[c];
      if (fw === 0) {
        if (f.maxDepth[c] >= 0.3) return -Infinity;
        continue;
      }
      if (!unsafeForWalking(f.maxDepth[c], f.maxSpeed[c], f.maxDV[c])) continue;
      if (fw > 0) t = Math.min(t, fw);
      else untimed = true;
    }
    // Unsafe water with no arrival time: from the end of the run, as walkHazard's UNTIMED edges.
    return t === Infinity && untimed ? f.simTime : t;
  }

  /**
   * Earliest arrival at any refuge, departing the seeds' point at t0 and walking at `speed` m/s. Without fields every
   * edge is safe and only shelters (none) count — callers set fields first.
   */
  search(seeds: readonly WalkSeed[], t0: number, speed: number, opts: { ignoreHazard?: boolean } = {}): WalkSearchResult {
    const g = this.g;
    const hz = opts.ignoreHazard ? null : this.hz;
    const dist = this.dist, pred = this.pred, heap = this.heap;
    dist.fill(Infinity);
    heap.clear();
    if (!(speed > 0)) return { ok: false, arrive: NaN, node: -1 };
    for (const s of seeds) {
      const t = t0 + s.meters / speed;
      if (hz && t > s.tUnsafe) continue;
      if (t < dist[s.node]) {
        dist[s.node] = t;
        pred[s.node] = -1;
        heap.pushOrDecrease(s.node);
      }
    }
    const tUnsafe = hz?.tUnsafe, tWet = hz?.tWet;
    const { adjStart, adjTo, adjEdge, edgeLength } = g;
    while (heap.size > 0) {
      const u = heap.pop();
      const du = dist[u];
      if (this.refuge[u]) return { ok: true, arrive: du, node: u };
      for (let k = adjStart[u]; k < adjStart[u + 1]; k++) {
        const e = adjEdge[k];
        const sp = tWet && du >= tWet[e] ? speed * WADE_SPEED_FACTOR : speed;
        const arr = du + edgeLength[e] / sp;
        if (tUnsafe && arr > tUnsafe[e]) continue;
        const v = adjTo[k];
        if (arr < dist[v]) {
          dist[v] = arr;
          pred[v] = e;
          heap.pushOrDecrease(v);
        }
      }
    }
    return { ok: false, arrive: NaN, node: -1 };
  }

  /**
   * Latest departure time in [lo, hi] from which a refuge is still reached: NaN if none even at lo, +∞ if one is still
   * reached at hi (safe for as long as the run knows). Bisection to `tol` s.
   */
  latestDeparture(seeds: readonly WalkSeed[], speed: number, lo: number, hi: number, tol = 5): number {
    if (!this.search(seeds, lo, speed).ok) return NaN;
    if (this.search(seeds, hi, speed).ok) return Infinity;
    let a = lo, b = hi;
    for (let it = 0; it < 40 && b - a > tol; it++) {
      const m = (a + b) / 2;
      if (this.search(seeds, m, speed).ok) a = m;
      else b = m;
    }
    return a;
  }

  /** The route of the LAST search() that succeeded, from point (gx, gy) to `node`. */
  route(gx: number, gy: number, node: number): WalkRoute {
    const g = this.g;
    const edges: number[] = [];
    let n = node;
    for (let guard = 0; n >= 0 && this.pred[n] >= 0 && guard <= g.nodeCount; guard++) {
      const e = this.pred[n];
      edges.push(e);
      n = g.edgeA[e] === n ? g.edgeB[e] : g.edgeA[e];
    }
    const pts: number[] = [gx, gy, g.nodeX[n], g.nodeY[n]];
    let meters = Math.hypot(g.nodeX[n] - gx, g.nodeY[n] - gy) * g.cellSize;
    let at = n;
    for (let k = edges.length - 1; k >= 0; k--) {
      const e = edges[k];
      const p0 = g.ptStart[e], p1 = g.ptStart[e + 1] - 1;
      if (g.edgeA[e] === at) {
        for (let q = p0 + 1; q <= p1; q++) pts.push(g.px[q], g.py[q]);
        at = g.edgeB[e];
      } else {
        for (let q = p1 - 1; q >= p0; q--) pts.push(g.px[q], g.py[q]);
        at = g.edgeA[e];
      }
      meters += g.edgeLength[e];
    }
    return { polyline: Float32Array.from(pts), meters };
  }

  /** The most-walked street name along the last route to `node` ('' when unnamed). */
  mainStreet(node: number): string {
    const g = this.g;
    const m = new Map<string, number>();
    let n = node;
    for (let guard = 0; n >= 0 && this.pred[n] >= 0 && guard <= g.nodeCount; guard++) {
      const e = this.pred[n];
      if (g.edgeName[e]) m.set(g.edgeName[e], (m.get(g.edgeName[e]) ?? 0) + g.edgeLength[e]);
      n = g.edgeA[e] === n ? g.edgeB[e] : g.edgeA[e];
    }
    let best = '', bm = 0;
    for (const [k, v] of m) if (v > bm) ((best = k), (bm = v));
    return best;
  }

  /** A street name touching `node` ('' when none is named). */
  streetAt(node: number): string {
    const g = this.g;
    for (let k = g.adjStart[node]; k < g.adjStart[node + 1]; k++) if (g.edgeName[g.adjEdge[k]]) return g.edgeName[g.adjEdge[k]];
    return '';
  }
}

/** Flat index into an nx × ny grid of reference cell (i, j) of a refNx × refNy grid (cell centres, clamped). */
function mapCell(i: number, j: number, sx: number, sy: number, nx: number, ny: number): number {
  if (sx !== 1) i = Math.floor((i + 0.5) * sx);
  if (sy !== 1) j = Math.floor((j + 0.5) * sy);
  if (i > nx - 1) i = nx - 1;
  if (j > ny - 1) j = ny - 1;
  return j * nx + i;
}

/**
 * Per-edge walking hazard timeline from the run's per-cell maxima and arrival times (pessimistic: an unsafe cell is
 * unsafe from its first arrival). Samples on water present at reset, and their approaches, are bridge spans: ignored.
 */
export function walkHazard(g: RoadGraph, refNx: number, refNy: number, f: HazardFields): WalkHazard {
  const E = g.edgeCount;
  const tUnsafe = new Float64Array(E).fill(Infinity);
  const tWet = new Float64Array(E).fill(Infinity);
  const sx = f.nx / refNx, sy = f.ny / refNy;
  const cells = g.sampleCell;
  const n = cells.length;
  const idx = new Int32Array(n);
  const mask = new Uint8Array(n);
  for (let s = 0; s < n; s++) {
    const key = cells[s];
    const c = mapCell(key & 0xffff, key >>> 16, sx, sy, f.nx, f.ny);
    idx[s] = c;
    if (f.firstWet[c] === 0 && f.maxDepth[c] >= WALK_WET_DEPTH) mask[s] = 1;
  }
  // Approaches of bridge spans (router.ts captureBaseline).
  const maxApproachCells = MAX_APPROACH_M / g.cellSize;
  for (let e = 0; e < E; e++) {
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
  let speedsKnown = false;
  for (let k = 0; k < f.maxSpeed.length; k += 97) if (Number.isFinite(f.maxSpeed[k])) {
    speedsKnown = true;
    break;
  }
  let untimedUnsafe = 0;
  for (let e = 0; e < E; e++) {
    let tu = Infinity, tw = Infinity;
    let untimed = false;
    for (let s = g.sampleStart[e]; s < g.sampleStart[e + 1]; s++) {
      if (mask[s]) continue;
      const c = idx[s];
      const d = f.maxDepth[c];
      if (!(d >= WALK_WET_DEPTH)) continue;
      const fw = f.firstWet[c];
      const unsafe = unsafeForWalking(d, f.maxSpeed[c], f.maxDV[c]);
      // Untimed water (firstWet −1: it never stood 15 cm deep, so no arrival was recorded): not wet from T+0 — it
      // does not slow walkers — and, when unsafe, closes the edge at an unknown time (UNTIMED below).
      if (!(fw > 0)) {
        if (unsafe) untimed = true;
        continue;
      }
      if (fw < tw) tw = fw;
      if (fw < tu && unsafe) tu = fw;
    }
    // UNTIMED: thin fast water with no arrival time anywhere on the edge is unsafe, but WHEN is unknown — it is
    // counted from the end of the run, the one moment it is known to have happened by, and the result says how many
    // edges that touched (as src/loss/infra.ts leaves an untimed status standing without a time).
    if (tu === Infinity && untimed) {
      tu = f.simTime;
      untimedUnsafe++;
    }
    tUnsafe[e] = tu;
    tWet[e] = tw;
  }
  return { tUnsafe, tWet, simTime: f.simTime, speedsKnown, untimedUnsafe };
}

/**
 * Nodes that are "high ground" for this run: dry (no water ≥ WALK_WET_DEPTH in the node's cell or its 8 neighbours) and
 * at least HIGH_GROUND_FREEBOARD_M above the highest water surface (ground + max depth, any water incl. rivers) within
 * HIGH_GROUND_RADIUS_M. `ground` is on the fields' grid.
 */
export function highGroundNodes(
  g: RoadGraph,
  refNx: number,
  refNy: number,
  f: HazardFields,
  ground: Float32Array,
  opts: { radiusM?: number; freeboardM?: number } = {},
): Uint8Array {
  const out = new Uint8Array(g.nodeCount);
  const { nx, ny } = f;
  if (ground.length < nx * ny) return out;
  const radiusM = opts.radiusM ?? HIGH_GROUND_RADIUS_M;
  const fb = opts.freeboardM ?? HIGH_GROUND_FREEBOARD_M;
  const cs = (g.cellSize * refNx) / nx;
  // Block maxima of the water surface (blocks of B cells, B ≈ radius / 2).
  const B = Math.max(1, Math.round(radiusM / cs / 2));
  const bw = Math.ceil(nx / B), bh = Math.ceil(ny / B);
  const blk = new Float32Array(bw * bh).fill(-Infinity);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const d = f.maxDepth[c];
      if (!(d >= WALK_WET_DEPTH)) continue;
      const w = ground[c] + d;
      const b = ((j / B) | 0) * bw + ((i / B) | 0);
      if (w > blk[b]) blk[b] = w;
    }
  }
  const reach = Math.ceil(radiusM / (B * cs));
  for (let n = 0; n < g.nodeCount; n++) {
    if (g.adjStart[n + 1] === g.adjStart[n]) continue;
    const i = Math.min(nx - 1, Math.max(0, Math.floor((g.nodeX[n] * nx) / refNx)));
    const j = Math.min(ny - 1, Math.max(0, Math.floor((g.nodeY[n] * ny) / refNy)));
    let dry = true;
    for (let dj = -1; dj <= 1 && dry; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        const c = jj * nx + ii;
        if (f.maxDepth[c] >= WALK_WET_DEPTH || f.firstWet[c] >= 0) {
          dry = false;
          break;
        }
      }
    }
    if (!dry) continue;
    const bi = (i / B) | 0, bj = (j / B) | 0;
    let wmax = -Infinity;
    for (let y = Math.max(0, bj - reach); y <= Math.min(bh - 1, bj + reach); y++) {
      for (let x = Math.max(0, bi - reach); x <= Math.min(bw - 1, bi + reach); x++) if (blk[y * bw + x] > wmax) wmax = blk[y * bw + x];
    }
    if (!(ground[j * nx + i] >= wmax + fb)) continue;
    out[n] = 1;
  }
  return out;
}
