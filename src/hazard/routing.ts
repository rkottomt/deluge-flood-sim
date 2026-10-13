/**
 * 1-D routing of the outburst down a valley profile (research spec §E.2): tens of kilometres of mountain river between
 * the source and the 2-D domain, cheap enough on the CPU to run 27 times for an ensemble.
 *
 * Scheme: local-inertial (Bates et al. 2010; de Almeida et al. 2012) — the same physics family as the 2-D GPU solver,
 * on a staggered 1-D grid. Nodes carry volumes; faces between them carry discharges:
 *
 *   Q* = θ·Q_f + (1 − θ)/2·(Q_{f−1} + Q_{f+1})                              (de Almeida's smoothing, θ = 0.8)
 *   Q_f ← [Q* − g·A_f·dt·(η_{i+1} − η_i)/L_f] / [1 + dt·g·n²·|Q*| / (A_f·R_f^{4/3})]  (semi-implicit Manning)
 *   M_i ← M_i + dt·(Q_{in} − Q_{out}) + sources
 *
 * Why local-inertial and not Muskingum–Cunge: a breach wave's rising limb is bore-like and reservoirs store water; the
 * diffusion-wave basis of MC represents neither (spec §E.2). Kinematic wave has no attenuation at all.
 *
 * Geometry: every node's ChainSection stage table is resampled once onto a uniform depth grid (depth above the
 * thalweg), so area, perimeter and width at any depth are an O(1) lookup — the hot loop does ~5 M face updates for
 * 100 km at 100 m. Above a table's top the valley walls are taken as vertical. A face's flow depth is
 * max(η_i, η_{i+1}) − max(z_i, z_{i+1}) (the 2-D solver's rule), its area the mean of both sections at that depth.
 *
 * Two phases: each node holds a water volume W and a sediment (solids) volume S; the hydraulics move the mixture
 * M = W + S, each face's flux carrying its donor's composition. Water is conserved to rounding. Sediment exchanges with
 * the bed: the concentration Cv = S/M relaxes toward Takahashi's equilibrium C∞(θ) over L_r = 1 km of travel (spec
 * §C.5/E.2), so a flood bulks on steep reaches and drops its load where the valley flattens. Rough beds of a debris
 * flood are rougher: n × dispersiveManningFactor(Cv) (Lin et al. 2005).
 *
 * Resistance law (RoutingOptions.resistance, src/hazard/resistance.ts): Manning with the profile's n per node
 * (default), or Ferguson's (2007) variable-power equation on a bed of D84, applied as the depth-dependent Manning n it
 * is equivalent to, n_eq(R) = R^{1/6}/(√g·U/u*), tabulated per node on the same depth grid as the geometry. The
 * dispersive factor multiplies either.
 *
 * Stability: dt from a CFL condition on |u| + √(g·A/W) (Courant 0.7), the semi-implicit friction can only slow water,
 * speeds are capped (30 m/s, Froude 8), and a donor-limited flux correction keeps every volume ≥ 0 exactly, which is
 * what makes the scheme mass-conservative AND positive on a dry bed.
 *
 * Structures (dams, barrages, intakes) replace the momentum equation on their face by a broad-crested weir with
 * Villemonte submergence, and may add a reservoir's stage–storage curve to the node just upstream.
 */
import type { ChainFile } from './types';
import {
  CV_RELAX_LENGTH,
  ENTRY_DT,
  G,
  ROUTING_CFL,
  ROUTING_DT_MAX,
  ROUTING_FROUDE_MAX,
  ROUTING_H_MIN,
  ROUTING_SPINUP,
  ROUTING_THETA,
  ROUTING_T_MAX,
  ROUTING_U_MAX,
  WEIR_C_RECT,
  FRONT_Q_FRAC,
  FRONT_Q_MIN,
  FRONT_STAGE_RISE,
} from './defaults';
import { CV_MAX, dispersiveManningFactor, takahashiCv } from './mass';
import { d84At, vpeManningN, type ResistanceLaw } from './resistance';
import type { Series } from './series';

/** Points in each node's resampled depth table. */
const TABLE_POINTS = 241;
/** Stride of Network.hyd: area, width, A·R^{4/3}. */
const HYD = 3;
/** dispersiveManningFactor tabulated on [0, CV_MAX] (one Math.exp per face per step was ~8 % of a run). */
const NTD_BINS = 512;
const NTD_TABLE = Float64Array.from({ length: NTD_BINS + 1 }, (_, k) => dispersiveManningFactor((k / NTD_BINS) * CV_MAX));
function ntdFactor(cv: number): number {
  const x = (cv < CV_MAX ? cv : CV_MAX) * (NTD_BINS / CV_MAX);
  const j = x | 0;
  return j >= NTD_BINS ? NTD_TABLE[NTD_BINS] : NTD_TABLE[j] + (NTD_TABLE[j + 1] - NTD_TABLE[j]) * (x - j);
}
/** Below this depth no sediment exchange happens (films), m. */
const CV_EXCHANGE_DEPTH = 0.05;
/** Half-window over which the bed slope is averaged for the equilibrium Cv and the normal depth, m. */
const SLOPE_WINDOW = 500;
/** Smallest slope used for normal depth / the outlet (flat or adverse DEM reaches), –. */
const SLOPE_MIN = 1e-4;
/** A run without a fixed end stops once less than this fraction of the flood volume is still in the valley. */
const ROUTING_DRAINED = 0.01;
/** …or once the discharge excess at the furthest point read is back under this fraction of its peak excess. */
const ROUTING_PASSED = 0.05;
/**
 * Quiescent-reach window: nodes this many beyond the furthest disturbed face stay active; the rest of the valley
 * (still at its spun-up baseflow) is not stepped until the flood comes within this distance. A disturbance moves at
 * most one node per step in this explicit scheme, so a margin of 8 checked every step can never be overtaken.
 */
const WINDOW_MARGIN = 8;
/** Tolerances: a face is "at baseflow" within 0.1 % + 0.01 m³/s (the spin-up's steadiness test), and disturbed once it
 * leaves its baseflow by 1.5 × its own spin-up fluctuation plus that (route()). */
const WINDOW_REL = 1e-3;
const WINDOW_ABS = 1e-2;
/** The baseflow spin-up stops early once every face carries its baseflow to 0.1 % + 0.01 m³/s (checked every 20
 * steps, after at least SPINUP_MIN s); ROUTING_SPINUP remains the upper bound. */
const SPINUP_MIN = 300;
/** Last part of the spin-up over which each face's fluctuation about its baseflow is measured for the window, s. */
const SPINUP_TAIL = 600;

// ────────────────────────────────────────────────────────────────────────────────────────────
// Prepared network
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A ChainFile turned into the arrays the stepper needs. Built once per file (cached) and shared by ensemble members. */
export interface Network {
  n: number;
  s: Float64Array;
  zb: Float64Array;
  manning: Float64Array;
  /** Control-volume length of each node, m (half-way to each neighbour). */
  dx: Float64Array;
  /** Face f joins nodes f and f+1; its length, m. invLf, invDx: reciprocals (the hot loop multiplies). */
  lf: Float64Array;
  invLf: Float64Array;
  invDx: Float64Array;
  /** Local bed slope (averaged over ±500 m), –, and Takahashi's equilibrium Cv for it. */
  slope: Float64Array;
  cInf: Float64Array;
  /** Uniform depth tables, depth step dh (m), TABLE_POINTS per node. */
  dh: number;
  /**
   * Interleaved [area m², top width m, A·R^{4/3}] per (node, depth) — what one face update reads, kept in one cache
   * line (three separate N×J tables cost a cache miss each and made the run memory-bound). A·R^{4/3} is tabulated so
   * the hot loop needs no cube root.
   */
  hyd: Float64Array;
  /** Wetted perimeter, m, and node volume (section area × Δx + reservoir storage), m³, per (node, depth). */
  perim: Float64Array;
  vol: Float64Array;
  /** Per face: index into `weirs`, or −1. */
  weirAt: Int32Array;
  weirs: Array<{ name: string; face: number; crest: number; width: number }>;
}

const networkCache = new WeakMap<ChainFile, Network>();

/** Prepare (or fetch the cached) network of a ChainFile. Throws on a malformed file. */
export function prepareNetwork(file: ChainFile): Network {
  const hit = networkCache.get(file);
  if (hit) return hit;
  const net = buildNetwork(file);
  networkCache.set(file, net);
  return net;
}

function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (x <= xs[0]) return ys[0];
  if (x >= xs[n - 1]) return ys[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const span = xs[hi] - xs[lo];
  return span > 0 ? ys[lo] + ((ys[hi] - ys[lo]) * (x - xs[lo])) / span : ys[hi];
}

function buildNetwork(file: ChainFile): Network {
  const n = file.s.length;
  if (n < 3) throw new Error('chain profile needs at least 3 nodes');
  if (file.zBed.length !== n || file.sections.length !== n || file.n.length !== n) throw new Error('chain profile arrays differ in length');
  const s = Float64Array.from(file.s);
  for (let i = 1; i < n; i++) if (!(s[i] > s[i - 1])) throw new Error(`chain profile chainage must ascend (node ${i})`);
  const zb = Float64Array.from(file.zBed);
  const manning = Float64Array.from(file.n, (v) => (v > 0 ? v : 0.05));
  const dx = new Float64Array(n);
  const lf = new Float64Array(n - 1);
  for (let f = 0; f < n - 1; f++) lf[f] = s[f + 1] - s[f];
  for (let i = 0; i < n; i++) dx[i] = 0.5 * ((i > 0 ? lf[i - 1] : 0) + (i < n - 1 ? lf[i] : 0));

  const slope = new Float64Array(n);
  const cInf = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let a = i;
    let b = i;
    while (a > 0 && s[i] - s[a] < SLOPE_WINDOW) a--;
    while (b < n - 1 && s[b] - s[i] < SLOPE_WINDOW) b++;
    const sl = (zb[a] - zb[b]) / (s[b] - s[a]);
    slope[i] = sl;
    cInf[i] = takahashiCv(Math.atan(Math.max(0, sl)));
  }

  // Depth range of the tables: the deepest section in the file (vertical walls above it).
  let hTop = 1;
  for (let i = 0; i < n; i++) {
    const st = file.sections[i].stage;
    if (!st || st.length === 0) throw new Error(`chain section ${i} is empty`);
    hTop = Math.max(hTop, st[st.length - 1] - zb[i]);
  }
  const J = TABLE_POINTS;
  const dh = hTop / (J - 1);
  const hyd = new Float64Array(n * J * HYD);
  const perim = new Float64Array(n * J);
  const vol = new Float64Array(n * J);

  // Reservoir storage, added to the node just upstream of its structure.
  const weirs: Network['weirs'] = [];
  const weirAt = new Int32Array(n).fill(-1);
  const storageAt = new Map<number, Array<[number, number]>>();
  for (const st of file.structures ?? []) {
    // The face whose midpoint is nearest the structure's chainage.
    let f = 0;
    for (let k = 1; k < n - 1; k++) if (Math.abs(0.5 * (s[k] + s[k + 1]) - st.s) < Math.abs(0.5 * (s[f] + s[f + 1]) - st.s)) f = k;
    if (weirAt[f] >= 0) continue; // two structures on one face: keep the first
    weirAt[f] = weirs.length;
    weirs.push({ name: st.name, face: f, crest: st.crest, width: Math.max(1, st.width) });
    if (st.storage && st.storage.length > 0) storageAt.set(f, [...st.storage].sort((p, q) => p[0] - q[0]));
  }

  for (let i = 0; i < n; i++) {
    const sec = file.sections[i];
    const st = sec.stage;
    const z = zb[i];
    const top = st.length - 1;
    // Linear from (thalweg, 0) up to the table's first stage when it starts above the thalweg.
    const at = (ys: readonly number[], depth: number): number => {
      const e = z + depth;
      if (e <= st[0]) return st[0] > z ? ys[0] * Math.max(0, depth / (st[0] - z)) : ys[0];
      return interp(st, ys, e);
    };
    const store = storageAt.get(i);
    const se = store ? store.map((p) => p[0]) : [];
    const sv = store ? store.map((p) => p[1]) : [];
    /** Reservoir storage below elevation e, m³: the curve, extrapolated with its last slope above its top. */
    const storageOf = (e: number): number => {
      if (!store) return 0;
      const top = se.length - 1;
      if (e > se[top] && top > 0) return sv[top] + ((sv[top] - sv[top - 1]) / Math.max(1e-6, se[top] - se[top - 1])) * (e - se[top]);
      return interp(se, sv, e);
    };
    const s0 = storageOf(z);
    const o = i * J;
    let prevA = 0;
    let prevV = -1;
    for (let j = 0; j < J; j++) {
      const depth = j * dh;
      const e = z + depth;
      let A: number;
      let P: number;
      let W: number;
      if (e <= st[top]) {
        A = at(sec.area, depth);
        P = at(sec.perimeter, depth);
        W = at(sec.width, depth);
      } else {
        // Vertical walls above the table.
        const over = e - st[top];
        W = sec.width[top];
        A = sec.area[top] + W * over;
        P = sec.perimeter[top] + 2 * over;
      }
      A = Math.max(A, prevA); // area never shrinks with depth
      prevA = A;
      perim[o + j] = Math.max(P, 1e-6);
      hyd[(o + j) * HYD] = A;
      hyd[(o + j) * HYD + 1] = Math.max(W, 1e-3);
      hyd[(o + j) * HYD + 2] = A * Math.pow(A / perim[o + j], 4 / 3);
      let V = A * dx[i] + Math.max(0, storageOf(e) - s0);
      V = Math.max(V, prevV + 1e-9); // strictly increasing, for the inversion
      prevV = V;
      vol[o + j] = V;
    }
    vol[o] = 0;
  }
  const invLf = Float64Array.from(lf, (v) => 1 / v);
  const invDx = Float64Array.from(dx, (v) => 1 / v);
  return { n, s, zb, manning, dx, lf, invLf, invDx, slope, cInf, dh, hyd, perim, vol, weirAt, weirs };
}

/** Area at depth h of node i (O(1); vertical walls above the table). */
function areaAt(net: Network, i: number, h: number): number {
  const J = TABLE_POINTS;
  const x = h / net.dh;
  const t = net.hyd;
  if (x >= J - 1) {
    const top = (i * J + J - 1) * HYD;
    return t[top] + t[top + 1] * (h - (J - 1) * net.dh);
  }
  const j = Math.floor(x);
  const o = (i * J + j) * HYD;
  return t[o] + (t[o + HYD] - t[o]) * (x - j);
}
function perimAt(net: Network, i: number, h: number): number {
  const J = TABLE_POINTS;
  const x = h / net.dh;
  const o = i * J;
  if (x >= J - 1) return net.perim[o + J - 1] + 2 * (h - (J - 1) * net.dh);
  const j = Math.floor(x);
  const f = x - j;
  return net.perim[o + j] + (net.perim[o + j + 1] - net.perim[o + j]) * f;
}
function widthAt(net: Network, i: number, h: number): number {
  const J = TABLE_POINTS;
  const x = h / net.dh;
  const t = net.hyd;
  if (x >= J - 1) return t[(i * J + J - 1) * HYD + 1];
  const j = Math.floor(x);
  const o = (i * J + j) * HYD + 1;
  return t[o] + (t[o + HYD] - t[o]) * (x - j);
}
function volAt(net: Network, i: number, h: number): number {
  const J = TABLE_POINTS;
  const x = h / net.dh;
  const o = i * J;
  if (x >= J - 1) {
    const top = o + J - 1;
    return net.vol[top] + ((net.vol[top] - net.vol[top - 1]) / net.dh) * (h - (J - 1) * net.dh);
  }
  const j = Math.floor(x);
  const f = x - j;
  return net.vol[o + j] + (net.vol[o + j + 1] - net.vol[o + j]) * f;
}

/**
 * Depth at node i holding volume v (inverse of volAt). `hint` is the table index found last time: water levels move
 * little per step, so walking from it is O(1) amortised.
 */
function depthOf(net: Network, i: number, v: number, hint: Int32Array): number {
  if (!(v > 0)) return 0;
  const J = TABLE_POINTS;
  const o = i * J;
  const vol = net.vol;
  const top = o + J - 1;
  if (v >= vol[top]) {
    hint[i] = J - 2;
    const slope = (vol[top] - vol[top - 1]) / net.dh;
    return (J - 1) * net.dh + (v - vol[top]) / slope;
  }
  let j = hint[i];
  if (j < 0 || j > J - 2) j = 0;
  while (j > 0 && vol[o + j] > v) j--;
  while (j < J - 2 && vol[o + j + 1] <= v) j++;
  hint[i] = j;
  const v0 = vol[o + j];
  const v1 = vol[o + j + 1];
  return (j + (v - v0) / (v1 - v0)) * net.dh;
}

/**
 * Normal depth at node i for discharge q on the node's averaged slope (bisection): Manning with the node's n, or —
 * given a resistance table (resistanceTable) — the depth-dependent n of that law.
 */
export function normalDepth(net: Network, i: number, q: number, slope?: number, nTab?: ResistanceTable | null): number {
  if (!(q > 0)) return 0;
  const S = Math.max(SLOPE_MIN, slope ?? net.slope[i]);
  const qOf = (h: number) => {
    const A = areaAt(net, i, h);
    const P = perimAt(net, i, h);
    const n = nTab ? nAt(net, nTab, i, h, A / P) : net.manning[i];
    return (A * Math.pow(A / P, 2 / 3) * Math.sqrt(S)) / n;
  };
  let lo = 0;
  let hi = 1;
  while (qOf(hi) < q && hi < 1e4) hi *= 2;
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (qOf(mid) < q) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/**
 * Volume of water the valley can pond upstream of node `i` below elevation `crest`, m³: the contiguous run of nodes
 * above i whose bed lies below the crest, each holding its section's area at that level. For an avalanche dam's
 * impoundment (chain.ts). Also returns the length of the pond, m.
 */
export function valleyStorage(file: ChainFile, i: number, crest: number): { volume: number; length: number } {
  const net = prepareNetwork(file);
  let v = 0;
  let j = i;
  while (j >= 0 && net.zb[j] < crest) {
    v += areaAt(net, j, crest - net.zb[j]) * net.dx[j];
    j--;
  }
  return { volume: v, length: net.s[i] - net.s[Math.max(0, j + 1)] };
}

/** Area of the valley section at node i below height h above its thalweg, m² (for avalanche-dam heights). */
export function sectionArea(file: ChainFile, i: number, h: number): number {
  return areaAt(prepareNetwork(file), i, Math.max(0, h));
}

/**
 * A depth-dependent resistance law on a network: the equivalent Manning n per (node, table depth) — n_eq at the
 * hydraulic radius of that node's section at that depth — plus each node's D84 for depths above the table.
 */
export interface ResistanceTable {
  n: Float64Array;
  d84: Float64Array;
  a1?: number;
  a2?: number;
}
const resistanceCache = new WeakMap<Network, Map<string, ResistanceTable>>();

/** The table of a law on a network (cached per network and law); null for Manning (the profile's own n). */
export function resistanceTable(net: Network, law: ResistanceLaw | undefined): ResistanceTable | null {
  if (!law || law.law === 'manning') return null;
  if (law.law !== 'ferguson2007') throw new Error(`unknown resistance law ${(law as { law: string }).law}`);
  const key = JSON.stringify(law);
  let m = resistanceCache.get(net);
  if (!m) resistanceCache.set(net, (m = new Map()));
  const hit = m.get(key);
  if (hit) return hit;
  const J = TABLE_POINTS;
  const d84 = Float64Array.from(net.s, (s) => d84At(law.d84, s));
  for (let i = 0; i < net.n; i++) if (!(d84[i] > 0)) throw new Error(`ferguson2007: D84 must be > 0 (node ${i})`);
  const n = new Float64Array(net.n * J);
  for (let i = 0; i < net.n; i++) {
    const o = i * J;
    for (let j = 1; j < J; j++) {
      const R = net.hyd[(o + j) * HYD] / net.perim[o + j];
      n[o + j] = vpeManningN(R, d84[i], law.a1, law.a2);
    }
    // Depth 0 carries no flow (ROUTING_H_MIN); the first wet entry stands for it so interpolation stays finite.
    n[o] = n[o + 1];
  }
  const t: ResistanceTable = { n, d84, ...(law.a1 !== undefined ? { a1: law.a1 } : {}), ...(law.a2 !== undefined ? { a2: law.a2 } : {}) };
  m.set(key, t);
  return t;
}

/** Equivalent n at node i, depth h (hydraulic radius R there, used above the table). */
function nAt(net: Network, t: ResistanceTable, i: number, h: number, R: number): number {
  const J = TABLE_POINTS;
  const x = h / net.dh;
  if (x >= J - 1) return vpeManningN(R, t.d84[i], t.a1, t.a2);
  const j = Math.floor(x);
  const o = i * J + j;
  return t.n[o] + (t.n[o + 1] - t.n[o]) * (x - j);
}

/**
 * The same valley on a coarser grid: nodes kept at spacing ≥ dx (the first and last always), their sections, bed and n
 * as baked. Stations, structures and the domain entry are by chainage and need no change. For the ensemble, where 27
 * members on the baked 100 m grid would take seconds: the routing's cost scales with (nodes × steps) ∝ 1/dx².
 */
export function resampleProfile(file: ChainFile, dx: number): ChainFile {
  const keep: number[] = [0];
  for (let i = 1; i < file.s.length - 1; i++) if (file.s[i] - file.s[keep[keep.length - 1]] >= dx * 0.999) keep.push(i);
  keep.push(file.s.length - 1);
  if (keep.length >= file.s.length) return file;
  const pick = <T,>(a: readonly T[]) => keep.map((i) => a[i]);
  return { ...file, s: pick(file.s), zBed: pick(file.zBed), n: pick(file.n), sections: pick(file.sections), lonlat: pick(file.lonlat) };
}

/** Index of the node nearest chainage s. */
export function nodeAt(file: ChainFile | Network, s: number): number {
  const xs = file.s;
  let best = 0;
  for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - s) < Math.abs(xs[best] - s)) best = i;
  return best;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Routing run
// ────────────────────────────────────────────────────────────────────────────────────────────

/** A point inflow of mixture at chainage s (the outburst), with its sediment concentration. */
export interface RoutingInflow {
  s: number;
  series: Series;
  /** Volumetric sediment concentration of what flows in (default 0: clear water). */
  cv?: number;
}

export interface RoutingProbe {
  name: string;
  s: number;
}

export interface RoutingOptions {
  /** The flood: point inflows of mixture on top of the baseflow. */
  inflows: RoutingInflow[];
  /** Clear-water baseflow entering at the upstream end, m³/s (default 0: a dry valley). */
  baseflow?: number;
  /** Tributaries: constant clear-water inflows at chainages, m³/s. */
  tributaries?: Array<{ s: number; q: number }>;
  /** Where to record Q, stage and Cv every step. */
  probes?: RoutingProbe[];
  /** Chainage whose face's flux becomes the entry hydrograph (default: the outlet). */
  entryS?: number;
  /** Sampling interval of the entry hydrograph, s (default 30). */
  entryDt?: number;
  /** Run exactly to this time (s after t = 0). Without it the run ends once the flood has drained past the outlet. */
  tEnd?: number;
  /** Hard limit, s after the first inflow starts (default 24 h; from t = 0 without inflows). */
  tMax?: number;
  /** Baseflow-only spin-up before t = 0, s (default 1800; 0 = start from the normal-depth guess). */
  spinUp?: number;
  cfl?: number;
  theta?: number;
  uMax?: number;
  dtMax?: number;
  /** 'relax' (default): Cv relaxes toward Takahashi's equilibrium (entrainment/deposition). 'tracer': no exchange with
   * the bed — sediment is only carried, so it is conserved too (used by the conservation tests). */
  cvMode?: 'relax' | 'tracer';
  relaxLength?: number;
  /** Without tEnd: also stop once the flood has passed the furthest probe / the entry (default true). Off, the run
   * continues until the valley has drained (what mass-balance tests want). */
  stopWhenPassed?: boolean;
  /** Start the river dry instead of at baseflow normal depth (tests). */
  dryStart?: boolean;
  /**
   * Without tEnd and with stopWhenPassed: the fraction of its peak excess the flow at the furthest point read must
   * fall back under before the run stops (default 0.05). An ensemble member, which only needs each station's front and
   * peak, can stop far earlier on the recession (0.5); a run whose entry hydrograph feeds the 2-D solver should not.
   */
  stopFraction?: number;
  /** Step only the reach the flood has reached (plus a margin); default true. Off: every node every step. */
  window?: boolean;
  /**
   * Bed resistance law (src/hazard/resistance.ts). Default Manning with the profile's n per node; 'ferguson2007' is
   * Ferguson's variable-power equation on the given D84, which replaces the profile's n. The dispersive factor for
   * the sediment load multiplies either.
   */
  resistance?: ResistanceLaw;
}

export interface ProbeSeries {
  name: string;
  s: number;
  node: number;
  face: number;
  /** Baseflow through the probe, m³/s, and the stage at t = 0, m. */
  qBase: number;
  stage0: number;
  /** One value per recorded step (times in RoutingResult.t): mixture discharge, stage (m a.s.l.), Cv. */
  q: Float64Array;
  stage: Float64Array;
  cv: Float64Array;
}

export interface MassBalance {
  /** Water: in (baseflow, tributaries, inflows) − out (outlet) − Δstorage = residual, m³. Storage counted from t = 0. */
  waterIn: number;
  waterOut: number;
  waterStored0: number;
  waterStored1: number;
  waterResidual: number;
  /** Sediment: in − out + entrained from the bed − Δstorage = residual, m³ (solids volume). */
  sedimentIn: number;
  sedimentOut: number;
  sedimentEntrained: number;
  sedimentStored0: number;
  sedimentStored1: number;
  sedimentResidual: number;
}

export interface RoutingResult {
  /** Times of the recorded steps, s after t = 0 (the first is t = 0). */
  t: Float64Array;
  probes: ProbeSeries[];
  /** Entry hydrograph: bin centres, mean mixture discharge per bin (exact volume), mean Cv per bin. */
  entry: { t: Float64Array; q: Float64Array; cv: Float64Array; volume: number; face: number };
  massBalance: MassBalance;
  steps: number;
  /** Node updates actually performed after t = 0 (Σ active nodes over steps): the work, independent of the machine. */
  nodeSteps: number;
  tEnd: number;
  /** Without tEnd: the run hit the tMax limit before the flood had passed (or drained) — the read-outs may be cut short. */
  timedOut: boolean;
  dtMin: number;
  dtMean: number;
  /** Face updates that hit the speed cap (should be ~0: the cap is a safety net). */
  capped: number;
  /** Largest face speed seen, m/s. */
  uPeak: number;
  ms: number;
}

/** Growable Float64 buffer. */
class Buf {
  a = new Float64Array(1024);
  n = 0;
  push(v: number) {
    if (this.n === this.a.length) {
      const b = new Float64Array(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  get(): Float64Array {
    return this.a.slice(0, this.n);
  }
}

/**
 * Everything one routing run mutates. The stepper is a set of module-level functions over this object rather than
 * closures inside route(): a closure is a new function object per run, and V8's optimised code for one run's step
 * deoptimises ("wrong call target") on the next run's — the ensemble runs 27 of them back to back.
 */
class RouterState {
  readonly N: number;
  /** Water and sediment volume per node, m³; depth above thalweg, m; depth-table hint. */
  readonly W: Float64Array;
  readonly S: Float64Array;
  readonly h: Float64Array;
  readonly hint: Int32Array;
  /** Face discharge (mixture, + downstream), m³/s; face N−1 is the outlet. Qn = this step's tentative fluxes. */
  readonly Q: Float64Array;
  readonly Qn: Float64Array;
  readonly outV: Float64Array;
  readonly lim: Float64Array;
  /** Face areas of the last step and the momentum fluxes Q²/A they give (the advection term). */
  readonly AfLast: Float64Array;
  readonly MF: Float64Array;
  /** Flow area and top width at each node's current depth. */
  readonly Anode: Float64Array;
  readonly Wnode: Float64Array;
  /** Manning multiplier for each node's sediment load (dispersiveManningFactor), and its Cv before this step's transport. */
  readonly nFac: Float64Array;
  readonly cvNow: Float64Array;
  /** Point-source rate into each node this step (baseflow, tributaries, the outburst), m³/s. */
  readonly srcRate: Float64Array;
  /** 1 / the shorter of each node's two face lengths. */
  readonly invLmin: Float64Array;
  /** Constant clear-water sources per node (baseflow, tributaries), and the baseflow each node passes on, m³/s. */
  readonly qConst: Float64Array;
  readonly constNodes: Int32Array;
  readonly qBaseNode: Float64Array;
  inflows: Array<{ node: number; series: Series; cv: number }> = [];
  /** Depth-dependent resistance (null: Manning with the profile's n). */
  readonly nTab: ResistanceTable | null;
  /**
   * Active nodes [0, nAct): beyond them the valley still holds its t = 0 baseflow and is not stepped. The face into
   * the first inactive node passes its water straight to the outlet (that reach is steady: what enters it leaves).
   */
  nAct: number;
  theta = ROUTING_THETA;
  uMax = ROUTING_U_MAX;
  cfl = ROUTING_CFL;
  dtMax = ROUTING_DT_MAX;
  relaxL = CV_RELAX_LENGTH;
  relax = true;
  outletSlope: number;
  entryFace: number;
  // Per-step outputs and running totals.
  entryFluxS = 0;
  capped = 0;
  uPeak = 0;
  /** |u| at each face in the last step (0 where dry or a weir), m/s: the advective part of each node's CFL rate. */
  readonly uFace: Float64Array;
  wIn = 0;
  wOut = 0;
  sIn = 0;
  sOut = 0;
  sEnt = 0;

  constructor(readonly net: Network, opts: RoutingOptions) {
    const N = net.n;
    this.N = N;
    this.nAct = N;
    this.W = new Float64Array(N);
    this.S = new Float64Array(N);
    this.h = new Float64Array(N);
    this.hint = new Int32Array(N);
    this.Q = new Float64Array(N);
    this.Qn = new Float64Array(N);
    this.outV = new Float64Array(N);
    this.lim = new Float64Array(N);
    this.AfLast = new Float64Array(N);
    this.MF = new Float64Array(N);
    this.Anode = new Float64Array(N);
    this.Wnode = new Float64Array(N);
    this.nFac = new Float64Array(N).fill(1);
    this.cvNow = new Float64Array(N);
    this.srcRate = new Float64Array(N);
    this.uFace = new Float64Array(N);
    const lf = net.lf;
    this.invLmin = Float64Array.from({ length: N }, (_, i) => 1 / Math.min(i > 0 ? lf[i - 1] : Infinity, i < N - 1 ? lf[i] : Infinity));
    this.qConst = new Float64Array(N);
    this.qConst[0] += Math.max(0, opts.baseflow ?? 0);
    for (const tr of opts.tributaries ?? []) if (tr.q > 0) this.qConst[nodeAt(net, tr.s)] += tr.q;
    this.constNodes = Int32Array.from(Array.from(this.qConst.keys()).filter((i) => this.qConst[i] > 0));
    this.qBaseNode = new Float64Array(N);
    let acc = 0;
    for (let i = 0; i < N; i++) {
      acc += this.qConst[i];
      this.qBaseNode[i] = acc;
    }
    this.inflows = opts.inflows.map((f) => ({ node: nodeAt(net, f.s), series: f.series, cv: Math.min(CV_MAX, Math.max(0, f.cv ?? 0)) }));
    this.theta = opts.theta ?? ROUTING_THETA;
    this.uMax = opts.uMax ?? ROUTING_U_MAX;
    this.cfl = opts.cfl ?? ROUTING_CFL;
    this.dtMax = opts.dtMax ?? ROUTING_DT_MAX;
    this.relaxL = opts.relaxLength ?? CV_RELAX_LENGTH;
    this.relax = (opts.cvMode ?? 'relax') === 'relax';
    this.outletSlope = Math.max(SLOPE_MIN, net.slope[N - 1]);
    this.entryFace = opts.entryS === undefined ? N - 1 : faceNear(net, opts.entryS);
    this.nTab = resistanceTable(net, opts.resistance);
  }
}

/** The face (0…N−2 between nodes, N−1 the outlet) nearest chainage s. */
function faceNear(net: Network, sx: number): number {
  const N = net.n;
  let best = N - 1;
  let bd = Math.abs(net.s[N - 1] - sx);
  for (let f = 0; f < N - 1; f++) {
    const d = Math.abs(0.5 * (net.s[f] + net.s[f + 1]) - sx);
    if (d < bd) {
      bd = d;
      best = f;
    }
  }
  return best;
}

/**
 * The per-node pass that closes a step: depth from volume, the flow area and width there, each node's Manning
 * multiplier for its sediment load, and the stable step for the next advance — dt = C / max_i[(|u|_i + c_i)/Δx_i] with
 * |u|_i the faster of node i's two face speeds in the last step and c_i = √(g·A/W) at the node. Exact per node: the
 * earlier bound max(|u|/Δx) + max(c/Δx) added the fastest face anywhere (a steep gorge) to the deepest node anywhere
 * (a reservoir) and cost ~30 % in step count on Chungthang for one square root per node saved. Returns that dt.
 */
function nodePass(st: RouterState): number {
  const { net, W, S, h, hint, Anode, Wnode, nFac, invLmin, uFace } = st;
  const HY = net.hyd;
  const J = TABLE_POINTS;
  const Jm1 = J - 1;
  const invDh = 1 / net.dh;
  const g = G;
  const VOL = net.vol;
  const dh = net.dh;
  // The advective part comes from the FACE speeds of the step just taken (capped at uMax and Froude 8 there), not from
  // Q/A at the nodes: a node all but drained by the positivity limiter has A → 0 under a finite flux, and that "speed"
  // drove dt to microseconds on the first real DEM profile.
  let rateMax = 0;
  for (let i = 0; i < st.nAct; i++) {
    const m = W[i] + S[i];
    // Depth from volume (depthOf, inlined): walk from last step's table index — levels move little per step.
    let hh = 0;
    if (m > 0) {
      const o = i * J;
      if (m >= VOL[o + Jm1]) hh = depthOf(net, i, m, hint);
      else {
        let j = hint[i];
        while (j > 0 && VOL[o + j] > m) j--;
        while (j < J - 2 && VOL[o + j + 1] <= m) j++;
        hint[i] = j;
        const v0 = VOL[o + j];
        hh = (j + (m - v0) / (VOL[o + j + 1] - v0)) * dh;
      }
    }
    h[i] = hh;
    let A: number;
    let Wd: number;
    const x = hh * invDh;
    if (x < Jm1) {
      const j = x | 0;
      const fr = x - j;
      const o = (i * J + j) * HYD;
      A = HY[o] + (HY[o + HYD] - HY[o]) * fr;
      Wd = HY[o + 1] + (HY[o + HYD + 1] - HY[o + 1]) * fr;
    } else {
      A = areaAt(net, i, hh);
      Wd = widthAt(net, i, hh);
    }
    Anode[i] = A;
    Wnode[i] = Wd;
    nFac[i] = S[i] > 0 ? ntdFactor(S[i] / m) : 1;
    const ua = i > 0 && uFace[i - 1] > uFace[i] ? uFace[i - 1] : uFace[i];
    if (!(hh > ROUTING_H_MIN) || !(A > 0)) {
      // A dry node still bounds the step by the speed through its faces (a drained donor next to a fast face).
      const r = ua * invLmin[i];
      if (r > rateMax) rateMax = r;
      continue;
    }
    const r = (ua + Math.sqrt((g * A) / Wd)) * invLmin[i];
    if (r > rateMax) rateMax = r;
  }
  return rateMax > 0 ? Math.min(st.dtMax, st.cfl / rateMax) : st.dtMax;
}

/**
 * Advance the state by dt from time t; returns the stable dt for the next step. `flood` adds the inflow hydrographs
 * (off during the spin-up). Four passes: sources; face fluxes; per-node limiter; transport; then nodePass.
 */
function advance(st: RouterState, t: number, dt: number, flood: boolean): number {
  const { net, N, W, S, h, Q, Qn, outV, lim, cvNow, srcRate, AfLast, MF, Anode, nFac, qConst, constNodes, qBaseNode, uFace } = st;
  const ZB = net.zb;
  const ILF = net.invLf;
  const IDX = net.invDx;
  const MAN = net.manning;
  const NT = st.nTab ? st.nTab.n : null;
  const WEIR = net.weirAt;
  const CINF = net.cInf;
  const HY = net.hyd;
  const J = TABLE_POINTS;
  const Jm1 = J - 1;
  const invDh = 1 / net.dh;
  const g = G;
  const theta = st.theta;
  const uMax = st.uMax;
  const FR2 = ROUTING_FROUDE_MAX * ROUTING_FROUDE_MAX;
  const entryFace = st.entryFace;
  // The active reach (RouterState.nAct): nodes [0, NA), faces [0, fEnd) — the last of them, when the window is not the
  // whole valley, feeds the steady reach beyond and passes its water to the outlet.
  const NA = st.nAct;
  const full = NA >= N;
  const fEnd = full ? N - 1 : NA;

  // 1. Sources: water with its sediment, booked into the balance; srcRate keeps each node's source rate this step.
  //    A constant source beyond the window is part of that reach's steady state: what it adds leaves at the outlet.
  srcRate.fill(0);
  let wIn = 0;
  let sIn = 0;
  let wPass = 0;
  for (let c = 0; c < constNodes.length; c++) {
    const i = constNodes[c];
    if (i >= NA) {
      wPass += qConst[i] * dt;
      continue;
    }
    const v = qConst[i] * dt;
    W[i] += v;
    srcRate[i] = qConst[i];
    wIn += v;
  }
  if (flood) {
    for (let k = 0; k < st.inflows.length; k++) {
      const f = st.inflows[k];
      const v = f.series.volume(t, t + dt);
      if (!(v > 0)) continue;
      const vs = v * f.cv;
      W[f.node] += v - vs;
      srcRate[f.node] += v / dt;
      S[f.node] += vs;
      wIn += v - vs;
      sIn += vs;
    }
  }

  // 2. Face fluxes (tentative), and each donor's total outflow for the limiter.
  outV.fill(0);
  let nCap = 0;
  let uTop = st.uPeak;
  for (let f = 0; f < fEnd; f++) {
    const i = f;
    const k = f + 1;
    const zi = ZB[i];
    const zk = ZB[k];
    const ei = zi + h[i];
    const ek = zk + h[k];
    const wi = WEIR[f];
    let q = 0;
    if (wi >= 0) {
      // Broad-crested weir (Q = 1.7·B·H^1.5) with Villemonte (1947) submergence, either direction.
      const w = net.weirs[wi];
      const up = ei >= ek ? ei : ek;
      const dn = ei >= ek ? ek : ei;
      const Hu = up - w.crest;
      if (Hu > 0) {
        q = WEIR_C_RECT * w.width * Hu * Math.sqrt(Hu);
        const Hd = dn - w.crest;
        if (Hd > 0) q *= Math.pow(Math.max(0, 1 - Math.pow(Hd / Hu, 1.5)), 0.385);
        // Never move more in one step than would level the two pools (the weir law is stiff near equal levels).
        const ui = ei >= ek ? i : k;
        const di = ei >= ek ? k : i;
        const cu = (volAt(net, ui, h[ui] + 0.01) - volAt(net, ui, h[ui])) / 0.01;
        const cd = (volAt(net, di, h[di] + 0.01) - volAt(net, di, h[di])) / 0.01;
        q = Math.min(q, (up - dn) / (1 / cu + 1 / cd) / dt);
        if (ek > ei) q = -q;
      }
      AfLast[f] = 0;
      uFace[f] = 0;
    } else {
      const hf = (ei > ek ? ei : ek) - (zi > zk ? zi : zk);
      if (!(hf > ROUTING_H_MIN)) {
        AfLast[f] = 0;
        uFace[f] = 0;
      } else {
        // Face geometry: the mean of the two sections at the face's flow depth. A·R^{4/3} is averaged as a whole
        // (tabulated per node) — identical to computing it from the mean A and P in a prismatic reach.
        let Af: number;
        let ARf: number;
        let Wf: number;
        let nBase: number;
        const x = hf * invDh;
        if (x < Jm1) {
          const j = x | 0;
          const fr = x - j;
          const oi = (i * J + j) * HYD;
          const ok = oi + J * HYD; // node k = i + 1
          Af = 0.5 * (HY[oi] + (HY[oi + HYD] - HY[oi]) * fr + HY[ok] + (HY[ok + HYD] - HY[ok]) * fr);
          Wf = 0.5 * (HY[oi + 1] + (HY[oi + HYD + 1] - HY[oi + 1]) * fr + HY[ok + 1] + (HY[ok + HYD + 1] - HY[ok + 1]) * fr);
          ARf = 0.5 * (HY[oi + 2] + (HY[oi + HYD + 2] - HY[oi + 2]) * fr + HY[ok + 2] + (HY[ok + HYD + 2] - HY[ok + 2]) * fr);
          if (NT) {
            const ni = i * J + j;
            const nk = ni + J;
            nBase = 0.5 * (NT[ni] + (NT[ni + 1] - NT[ni]) * fr + NT[nk] + (NT[nk + 1] - NT[nk]) * fr);
          } else nBase = 0.5 * (MAN[i] + MAN[k]);
        } else {
          Af = 0.5 * (areaAt(net, i, hf) + areaAt(net, k, hf));
          const Rf = Af / (0.5 * (perimAt(net, i, hf) + perimAt(net, k, hf)));
          ARf = Af * Rf * Math.cbrt(Rf);
          Wf = 0.5 * (widthAt(net, i, hf) + widthAt(net, k, hf));
          nBase = st.nTab ? 0.5 * (nAt(net, st.nTab, i, hf, Rf) + nAt(net, st.nTab, k, hf, Rf)) : 0.5 * (MAN[i] + MAN[k]);
        }
        const qPrev = Q[f];
        // Neighbours corrected for the point sources between them and this face (a tributary, the outburst inflow), so
        // the smoothing does not bleed a junction's jump in Q into the face above it.
        const qL = f > 0 && WEIR[f - 1] < 0 ? Q[f - 1] + srcRate[i] : qPrev;
        const qR = f < N - 2 && WEIR[f + 1] < 0 ? Q[f + 1] - srcRate[k] : qPrev;
        const qs = theta * qPrev + 0.5 * (1 - theta) * (qL + qR);
        const nEff = nBase * nFac[qs >= 0 ? i : k];
        // Semi-implicit Manning: g·n²·|Q|/(A·R^{4/3}) in the denominator can only slow the flow. With a depth-dependent
        // law n is its equivalent at this face's depth (g·n²/R^{1/3} = Cf): still a positive coefficient, still
        // implicit in |Q|.
        const fr = (dt * g * nEff * nEff * (qs >= 0 ? qs : -qs)) / ARf;
        // Convective acceleration ∂(Q²/A)/∂x, first-order upwind on the previous step's face momentum fluxes (zero
        // gradient at the upstream end and next to weirs). Without it the scheme is Bates' local-inertial, which on
        // steep supercritical reaches (5 % slopes, Fr > 1) amplified a breach wave into spikes ×10 its source peak in
        // testing — the omitted term is what carries momentum downstream there (de Almeida & Bates 2013 on the
        // scheme's Froude limits).
        let adv = 0;
        if (qPrev > 0) adv = (MF[f] - (f > 0 && WEIR[f - 1] < 0 ? MF[f - 1] : MF[f])) * IDX[i];
        else if (qPrev < 0) adv = ((f < N - 2 && WEIR[f + 1] < 0 ? MF[f + 1] : MF[f]) - MF[f]) * IDX[k];
        q = (qs - dt * adv - g * Af * dt * (ek - ei) * ILF[f]) / (1 + fr);
        AfLast[f] = Af;
        // Speed cap |u| ≤ min(uMax, 8·√(g·A/W)), tested without divisions (|q| > uMax·A, q²·W > 64·g·A³); the
        // square root only when it binds.
        const qa = q >= 0 ? q : -q;
        if (qa > uMax * Af || qa * qa * Wf > FR2 * g * Af * Af * Af) {
          const uc = Math.min(uMax, ROUTING_FROUDE_MAX * Math.sqrt((g * Af) / Wf));
          q = q > 0 ? uc * Af : -uc * Af;
          nCap++;
        }
        const qa2 = q >= 0 ? q : -q;
        if (qa2 > uTop * Af) uTop = qa2 / Af;
        uFace[f] = qa2 / Af;
      }
    }
    // The steady reach beyond the window gives nothing back upstream.
    if (!full && k === NA && q < 0) q = 0;
    Qn[f] = q;
    if (q > 0) outV[i] += q * dt;
    else if (q < 0) outV[k] -= q * dt;
  }
  st.capped += nCap;
  st.uPeak = uTop;
  // Outlet: normal flow on the last reach's slope.
  if (full) {
    const i = N - 1;
    const hh = h[i];
    let q = 0;
    if (hh > ROUTING_H_MIN) {
      const A = areaAt(net, i, hh);
      const R = A / perimAt(net, i, hh);
      const nOut = st.nTab ? nAt(net, st.nTab, i, hh, R) : MAN[i];
      q = (A * Math.cbrt(R * R) * Math.sqrt(st.outletSlope)) / (nOut * nFac[i]);
    }
    Qn[N - 1] = q;
    uFace[N - 1] = hh > ROUTING_H_MIN ? q / areaAt(net, i, hh) : 0;
    outV[N - 1] += q * dt;
  }

  // 3. Positivity: each donor gives at most what it holds (its outflows scaled together), and its composition before
  //    anything moves.
  for (let i = 0; i < NA; i++) {
    const m = W[i] + S[i];
    lim[i] = outV[i] > m ? (m > 0 ? m / outV[i] : 0) : 1;
    cvNow[i] = m > 0 ? S[i] / m : 0;
  }

  // 4. Transport: each (limited) flux carries its donor's composition; momentum fluxes for the next advection.
  let wOut = 0;
  let sOut = 0;
  for (let f = 0; f < (full ? N : fEnd); f++) {
    const q0 = Qn[f];
    if (q0 === 0) {
      Q[f] = 0;
      if (f < N - 1) MF[f] = 0;
      continue;
    }
    const d = q0 > 0 ? f : f + 1;
    const q = q0 * lim[d];
    Q[f] = q;
    const v = (q > 0 ? q : -q) * dt;
    const dS = v * cvNow[d];
    const dW = v - dS;
    W[d] -= dW;
    S[d] -= dS;
    if (f === entryFace || (!full && f === fEnd - 1 && entryFace >= fEnd)) st.entryFluxS = q > 0 ? dS / dt : -dS / dt;
    if (f === N - 1 || (f === fEnd - 1 && !full)) {
      // Out of the valley, or into the steady reach beyond the window (which passes it on unchanged).
      if (f < N - 1) {
        const a = AfLast[f];
        MF[f] = a > 0 ? (q * q) / a : 0;
      }
      wOut += dW;
      sOut += dS;
    } else {
      const r = q > 0 ? f + 1 : f;
      W[r] += dW;
      S[r] += dS;
      const a = AfLast[f];
      MF[f] = a > 0 ? (q * q) / a : 0;
    }
  }

  // 5. Clean-up and sediment exchange with the bed.
  let sEnt = 0;
  const relax = st.relax && flood; // no bed exchange during the baseflow spin-up
  const relaxL = st.relaxL;
  for (let i = 0; i < NA; i++) {
    // Rounding can leave −1e-12 in a drained cell: clear it, and leave the trace in the balance's residual.
    if (W[i] < 0) W[i] = 0;
    if (S[i] < 0) S[i] = 0;
    if (!relax) continue;
    const m = W[i] + S[i];
    if (!(m > 0) || h[i] < CV_EXCHANGE_DEPTH) continue;
    const a = i > 0 ? Q[i - 1] : 0;
    const b = Q[i];
    const qNode = 0.5 * ((a >= 0 ? a : -a) + (b >= 0 ? b : -b));
    const cv = S[i] / m;
    const cInf = CINF[i];
    // Supply-limited entrainment: only the flood's share of the flow picks up the bed (baseflow runs on an armoured
    // bed); deposition toward C∞ is unconditional. [H] A flow within 2 % of baseflow is baseflow (numerical ripples
    // of the steady state must not slowly load the river with sediment).
    const qb = qBaseNode[i];
    const cEq = qNode > 1.02 * qb ? cInf * (1 - qb / qNode) : 0;
    let target: number;
    if (cv < cEq) target = cEq;
    else if (cv > cInf) target = cInf;
    else continue;
    const u = qNode / Anode[i];
    if (!(u > 0)) continue;
    // e^{−x} by its (2,2) Padé approximant while x = u·dt/L_r is small (≤ 0.3 at 30 m/s, 10 s, 1 km; error < 1e-6
    // there), the real exponential beyond.
    const xr = (u * dt) / relaxL;
    const decay = xr < 0.5 ? (1 - xr / 2 + (xr * xr) / 12) / (1 + xr / 2 + (xr * xr) / 12) : Math.exp(-xr);
    const cNew = target + (cv - target) * decay;
    const sNew = (W[i] * cNew) / (1 - cNew);
    sEnt += sNew - S[i];
    S[i] = sNew;
  }
  st.wIn += wIn + wPass;
  st.sIn += sIn;
  st.wOut += wOut + wPass;
  st.sOut += sOut;
  st.sEnt += sEnt;

  // 6. Depths, areas, and the next step.
  return nodePass(st);
}

/** Route a flood down a ChainFile's valley. Deterministic: same inputs, same bits. */
export function route(file: ChainFile, opts: RoutingOptions): RoutingResult {
  const t0ms = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const net = prepareNetwork(file);
  const N = net.n;
  const st = new RouterState(net, opts);
  const { W, S, h, hint, Q, qBaseNode } = st;
  // When the inflows are (practically) over: 99 % of each one's volume delivered. A breach hydrograph trickles on for
  // hours at a few m³/s after its lake is nearly empty; that tail must not keep the run going.
  const inflowEnd = st.inflows.reduce((m, f) => {
    const s = f.series;
    let k = 0;
    while (k < s.t.length - 1 && s.cum[k] < 0.99 * s.total) k++;
    return Math.max(m, s.t[k]);
  }, 0);
  // For an early stop (stopFraction above the default): the time after which every inflow has fallen for good under
  // that fraction of its own peak — a slow breach still rising behind a first pulse holds the run open.
  const stopFracOpt = opts.stopFraction ?? ROUTING_PASSED;
  const inflowLow = st.inflows.reduce((m, f) => {
    const s = f.series;
    let pk = 0;
    for (let k = 0; k < s.q.length; k++) if (s.q[k] > pk) pk = s.q[k];
    let k = s.q.length - 1;
    while (k > 0 && s.q[k] < stopFracOpt * pk) k--;
    return Math.max(m, s.t[Math.min(s.t.length - 1, k + 1)]);
  }, 0);
  const sourceDone = stopFracOpt > ROUTING_PASSED ? Math.min(inflowEnd, inflowLow) : inflowEnd;

  // Initial state: baseflow at normal depth, pools behind structures filled to spilling.
  if (!opts.dryStart && st.constNodes.length > 0) {
    for (let i = 0; i < N; i++) h[i] = normalDepth(net, i, qBaseNode[i], undefined, st.nTab);
    for (const w of net.weirs) {
      const qb = qBaseNode[w.face];
      const pool = w.crest + Math.pow(qb / (WEIR_C_RECT * w.width), 2 / 3);
      for (let i = w.face; i >= 0 && net.zb[i] < pool; i--) h[i] = Math.max(h[i], pool - net.zb[i]);
    }
    for (let i = 0; i < N; i++) {
      W[i] = volAt(net, i, h[i]);
      h[i] = depthOf(net, i, W[i], hint);
      Q[i] = qBaseNode[i];
    }
  }
  let dtNext = nodePass(st);

  // Spin-up on baseflow alone; the balance is counted from t = 0.
  // Adaptive: it ends as soon as every face carries its baseflow (WINDOW_REL / WINDOW_ABS, checked every 20 steps
  // after SPINUP_MIN s); the river then is steady and the rest of the 30 minutes would change nothing that counts.
  // Only an explicit opts.spinUp is run in full.
  const spin = opts.dryStart ? 0 : (opts.spinUp ?? ROUTING_SPINUP);
  /** Every face carries its baseflow to WINDOW_REL + WINDOW_ABS. */
  const isSteady = (): boolean => {
    for (let f = 0; f < N; f++) if (Math.abs(Q[f] - qBaseNode[f]) > WINDOW_REL * qBaseNode[f] + WINDOW_ABS) return false;
    return true;
  };
  const adaptive = opts.spinUp === undefined;
  // Fluctuation of each face about its baseflow over the last SPINUP_TAIL s of the spin-up (what the window ignores).
  const amp = new Float64Array(N);
  for (let t = -spin, k = 0; t < 0; k++) {
    const dt = Math.min(dtNext, -t);
    dtNext = advance(st, t, dt, false);
    t += dt;
    if (t >= -SPINUP_TAIL) for (let f = 0; f < N; f++) amp[f] = Math.max(amp[f], Math.abs(Q[f] - qBaseNode[f]));
    if (adaptive && k % 20 === 19 && t + spin >= SPINUP_MIN && isSteady()) break;
  }
  st.wIn = st.wOut = st.sIn = st.sOut = st.sEnt = 0;
  // The window starts just below the furthest inflow and grows ahead of the flood (see the main loop).
  // A face counts as reached by the flood once its discharge leaves its baseflow by more than the spin-up's own
  // fluctuation there (steep reaches carry roll waves at baseflow: Nepal's 10 % Lhende swings 100 → 190 m³/s) times
  // 1.5, plus WINDOW_REL + WINDOW_ABS.
  const noise = Float64Array.from(amp, (a, f) => 1.5 * a + WINDOW_REL * qBaseNode[f] + WINDOW_ABS);
  if ((opts.window ?? true) && st.inflows.length > 0) st.nAct = Math.min(N, st.inflows.reduce((m, f) => Math.max(m, f.node), 0) + 1 + 2 * WINDOW_MARGIN);
  let w0 = 0;
  let s0 = 0;
  for (let i = 0; i < N; i++) {
    w0 += W[i];
    s0 += S[i];
  }

  // Probes: node and face nearest each chainage; baseflow through the face and the stage at t = 0.
  const probes = (opts.probes ?? []).map((p) => {
    const node = nodeAt(net, p.s);
    const face = faceNear(net, p.s);
    return { name: p.name, s: p.s, node, face, qBase: qBaseNode[face], stage0: net.zb[node] + h[node], q: new Buf(), stage: new Buf(), cv: new Buf() };
  });
  const tBuf = new Buf();
  const record = (t: number) => {
    tBuf.push(t);
    for (const p of probes) {
      p.q.push(Q[p.face]);
      p.stage.push(net.zb[p.node] + h[p.node]);
      const m = W[p.node] + S[p.node];
      p.cv.push(m > 0 ? S[p.node] / m : 0);
    }
  };
  record(0);

  const entryDt = opts.entryDt ?? ENTRY_DT;
  const entryV = new Buf();
  const entryS = new Buf();
  const tMax = opts.tMax ?? ROUTING_T_MAX;
  const tFixed = opts.tEnd;
  // The limit counts from the first inflow, not from t = 0: a transient dam's breach is shifted by the hours its
  // impoundment takes to fill (Series.start), and a limit from t = 0 could end the run before any flood water moved —
  // a "flood" with no front anywhere. RoutingResult.timedOut says when the limit, not the flood passing, ended it.
  const inflowStart = st.inflows.reduce((m, f) => Math.min(m, f.series.start), Infinity);
  const tStop = tFixed ?? (Number.isFinite(inflowStart) ? Math.max(0, inflowStart) : 0) + tMax;
  let t = 0;
  let steps = 0;
  let nodeSteps = 0;
  let dtMin = Infinity;
  let nextCheck = 60;
  let binV = 0;
  let binS = 0;
  let binEnd = entryDt;
  let injectedFlood = 0;
  for (const f of st.inflows) injectedFlood += f.series.volume(0, Math.max(f.series.end, 0));
  const stored0 = w0 + s0;
  // The furthest-downstream face anyone reads (entry or a probe), for the "flood has passed" stop.
  let watchFace = -1;
  if (tFixed === undefined && (opts.stopWhenPassed ?? true)) {
    if (opts.entryS !== undefined) watchFace = st.entryFace;
    for (const p of probes) watchFace = Math.max(watchFace, p.face);
  }
  const watchBase = watchFace >= 0 ? qBaseNode[Math.min(watchFace, N - 1)] : 0;
  let watchPeak = 0;
  const stopFrac = opts.stopFraction ?? ROUTING_PASSED;
  let maxExcess = 0;
  /**
   * Discharge through the entry face this step. Beyond the window the steady reach passes on what enters it at once, so
   * a frozen entry carries the window's boundary flux plus the constant sources between it and the entry (exactly the
   * water the balance books as leaving), not its frozen t = 0 value.
   */
  const entryFlux = (): number => {
    const ef = st.entryFace;
    const NA = st.nAct;
    if (NA >= N || ef < NA) return Q[ef];
    let q = Q[NA - 1];
    for (let i = NA; i <= ef && i < N; i++) q += st.qConst[i];
    return q;
  };

  while (t < tStop - 1e-9) {
    let dt = Math.min(dtNext, tStop - t);
    // Never step across an entry-bin boundary: each bin's volume is then exactly what crossed the face in it.
    if (t + dt > binEnd) dt = binEnd - t;
    if (!(dt > 1e-6)) dt = 1e-6;
    st.entryFluxS = 0;
    dtNext = advance(st, t, dt, true);
    t += dt;
    steps++;
    nodeSteps += st.nAct;
    if (dt < dtMin) dtMin = dt;
    binV += entryFlux() * dt;
    binS += st.entryFluxS * dt;
    if (t >= binEnd - 1e-9) {
      entryV.push(binV);
      entryS.push(binS);
      binV = 0;
      binS = 0;
      binEnd += entryDt;
    }
    record(t);
    if (st.nAct < N) {
      // Grow the window while the flood is within WINDOW_MARGIN nodes of its end.
      const lo = Math.max(0, st.nAct - WINDOW_MARGIN);
      for (let f = st.nAct - 1; f >= lo; f--) {
        if (Math.abs(Q[f] - qBaseNode[f]) > noise[f]) {
          st.nAct = Math.min(N, f + 1 + 2 * WINDOW_MARGIN);
          break;
        }
      }
    }
    if (watchFace >= 0) {
      const ex = Q[watchFace] - watchBase;
      if (ex > watchPeak) watchPeak = ex;
    }
    if (tFixed === undefined && t >= nextCheck) {
      nextCheck += 60;
      let m = 0;
      for (let i = 0; i < N; i++) m += W[i] + S[i];
      const excess = m - stored0;
      if (excess > maxExcess) maxExcess = excess;
      if (t > sourceDone) {
        // Done when the flood has passed the furthest point anyone reads (its excess back under stopFrac — 5 % by
        // default — of its peak excess). An early stop (stopFrac above the default) must also see the valley holding
        // less than that share of the most flood water it held, so a second wave still on its way (an overtopping
        // pulse ahead of the breach peak) cannot end the run …
        const passed = watchFace >= 0 && watchPeak > FRONT_Q_MIN && Q[watchFace] - watchBase < stopFrac * watchPeak;
        if (passed && (stopFrac <= ROUTING_PASSED || excess < stopFrac * maxExcess)) break;
        // … or what it added to the valley has drained past the outlet (to 1 %): the recession's tail is exponential
        // and carries nothing a warning depends on.
        if (excess <= ROUTING_DRAINED * Math.max(injectedFlood, 1)) break;
      }
    }
  }
  if (binV !== 0 || entryV.n === 0) {
    entryV.push(binV);
    entryS.push(binS);
  }

  let w1 = 0;
  let s1 = 0;
  for (let i = 0; i < N; i++) {
    w1 += W[i];
    s1 += S[i];
  }
  const ev = entryV.get();
  const es = entryS.get();
  const nb = ev.length;
  const et = new Float64Array(nb);
  const eq = new Float64Array(nb);
  const ec = new Float64Array(nb);
  let evTot = 0;
  for (let b = 0; b < nb; b++) {
    const start = b * entryDt;
    const len = Math.min(entryDt, t - start) || entryDt;
    et[b] = start + 0.5 * len;
    eq[b] = ev[b] / len;
    ec[b] = ev[b] !== 0 ? es[b] / ev[b] : 0;
    evTot += ev[b];
  }
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0ms;
  return {
    t: tBuf.get(),
    probes: probes.map((p) => ({
      name: p.name,
      s: p.s,
      node: p.node,
      face: p.face,
      qBase: p.qBase,
      stage0: p.stage0,
      q: p.q.get(),
      stage: p.stage.get(),
      cv: p.cv.get(),
    })),
    entry: { t: et, q: eq, cv: ec, volume: evTot, face: st.entryFace },
    massBalance: {
      waterIn: st.wIn,
      waterOut: st.wOut,
      waterStored0: w0,
      waterStored1: w1,
      waterResidual: st.wIn - st.wOut - (w1 - w0),
      sedimentIn: st.sIn,
      sedimentOut: st.sOut,
      sedimentEntrained: st.sEnt,
      sedimentStored0: s0,
      sedimentStored1: s1,
      sedimentResidual: st.sIn - st.sOut + st.sEnt - (s1 - s0),
    },
    steps,
    nodeSteps,
    tEnd: t,
    timedOut: tFixed === undefined && t >= tStop - 1e-9,
    dtMin: Number.isFinite(dtMin) ? dtMin : 0,
    dtMean: steps > 0 ? t / steps : 0,
    capped: st.capped,
    uPeak: st.uPeak,
    ms,
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Station read-outs
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface StationReadout {
  /** Front arrival, s (NaN: the flood never reached the threshold here). */
  tFront: number;
  /** Peak mixture discharge, m³/s, and its time, s. */
  qPeak: number;
  tPeak: number;
  /** Highest stage, m a.s.l., and its rise above the stage at t = 0, m. */
  stageMax: number;
  rise: number;
  /** Cv at the time of the peak. */
  cv: number;
}

/**
 * Front, peak and stage at a probe. Front = first time Q > baseflow + max(10 m³/s, 5 % of the peak's excess over
 * baseflow) OR the stage has risen 0.5 m while Q exceeds baseflow by 10 m³/s (defaults.ts FRONT_*), interpolated between
 * steps (the stage clause to the step it is met at).
 */
export function readProbe(t: Float64Array, p: ProbeSeries): StationReadout {
  let k = 0;
  let stageMax = -Infinity;
  for (let i = 0; i < p.q.length; i++) {
    if (p.q[i] > p.q[k]) k = i;
    if (p.stage[i] > stageMax) stageMax = p.stage[i];
  }
  const qPeak = p.q[k] ?? 0;
  const thrQ = p.qBase + Math.max(FRONT_Q_MIN, FRONT_Q_FRAC * Math.max(0, qPeak - p.qBase));
  const thrStage = p.stage0 + FRONT_STAGE_RISE;
  let tFront = NaN;
  for (let i = 1; i < p.q.length; i++) {
    const aq = p.q[i - 1];
    const bq = p.q[i];
    const as = p.stage[i - 1];
    const bs = p.stage[i];
    let fq = Infinity;
    let fs = Infinity;
    if (bq > thrQ) fq = aq > thrQ ? 0 : (thrQ - aq) / (bq - aq);
    // The stage clause counts only while more water is actually passing (Q above baseflow by 10 m³/s): a backwater rise
    // from a tributary junction or a reservoir settling after the spin-up is not a flood front.
    if (bs > thrStage && bq > p.qBase + FRONT_Q_MIN) fs = as > thrStage && aq > p.qBase + FRONT_Q_MIN ? 0 : 1;
    const fr = Math.min(fq, fs);
    if (Number.isFinite(fr)) {
      tFront = t[i - 1] + fr * (t[i] - t[i - 1]);
      break;
    }
  }
  return { tFront, qPeak, tPeak: t[k] ?? 0, stageMax, rise: stageMax - p.stage0, cv: p.cv[k] ?? 0 };
}
