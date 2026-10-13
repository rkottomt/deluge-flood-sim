/**
 * Ensemble flood-probability maps: the arithmetic (pure, no DOM, no GPU; tests/loss/ensemble.test.ts).
 *
 * One run says "this street floods". An ensemble re-runs the SAME scenario N times with its uncertain inputs nudged
 * within stated bands and reports, per cell and per asset, in how many of the N versions the water got deeper than a
 * threshold: "this street floods in 9 of 12 versions of this event". That is SENSITIVITY TO THE STATED INPUT
 * UNCERTAINTY, not a calibrated probability of the real event: the bands below are screening assumptions (each one
 * labelled with where it comes from), the members are equally weighted, and everything the model leaves out (drains,
 * buildings, bathymetry, the scheme itself) is the same in every member, so the spread is a LOWER bound on the real
 * uncertainty.
 *
 *   sampleMembers   Latin hypercube over the perturbed inputs, deterministic from a seed (mulberry32 + a stratified
 *                   permutation per dimension: every member falls in its own 1/N slice of every input's range)
 *   memberForcing   one member's sources, storms, rain, stage and Manning n from the user's scenario
 *   summarizeMembers / band   p10 / p50 / p90 across members (R type 7, the chain ensemble's quantile)
 *   ensembleCellUpdate        CPU mirror of the GPU accumulate pass (src/sim/shaders/ensemble.ts) — KEEP IN SYNC
 */
import type { HydrographPoint, StormCell, WaterSource } from '../contracts';
import { quantile } from '../hazard/chain';

// ─── Limits and default bands ───────────────────────────────────────────────────────────────────────────────────

export const ENSEMBLE_LIMITS = {
  /** Members per ensemble: 12 by default. Three is allowed for a quick look (probabilities then come in thirds). */
  minMembers: 3,
  maxMembers: 32,
  defaultMembers: 12,
  /** Simulated minutes per member. */
  minMinutes: 2,
  maxMinutes: 240,
  defaultMinutes: 30,
} as const;

/** Exceedance thresholds the GPU pass counts, m: ankle-deep (the solver's ARRIVAL_DEPTH) and "cars float". */
export const ENSEMBLE_THRESHOLDS = [0.15, 0.5] as const;
export type EnsembleThreshold = (typeof ENSEMBLE_THRESHOLDS)[number];

/** Float32 values per cell in the ensemble buffer: (members > 0.15 m, members > 0.5 m, Σ max depth, max of max depth). */
export const ENSEMBLE_PER_CELL = 4;

/**
 * The perturbation bands. Every one is a symmetric ± band sampled uniformly (Manning n: log-uniformly) across the
 * members by Latin hypercube. The user can edit all of them; these are the defaults.
 */
export interface EnsembleRanges {
  /** Inflow discharge (every inflow source, hydrograph included): × (1 ± inflowPct/100). */
  inflowPct: number;
  /** Rain (global rate and every storm cell): × (1 ± rainPct/100). */
  rainPct: number;
  /** River stage, m: the slider's target ± stageM (clamped to the slider's range). */
  stageM: number;
  /** Manning's n, log-uniform between these (replaces the scenario's single n in each member). */
  manningLo: number;
  manningHi: number;
  /** DEM error: σ of a smooth random bed perturbation, m (0 = off), and its correlation length, m. */
  demSigmaM: number;
  demCorrM: number;
}

/** Where a terrain's elevation came from, for the DEM σ default (read off the attribution line). */
export type DemSource = '3dep' | 'copernicus' | 'terrarium' | 'unknown';

export function demSourceOf(attribution: string): DemSource {
  const a = attribution.toLowerCase();
  if (a.includes('copernicus')) return 'copernicus';
  if (a.includes('3dep')) return '3dep';
  if (a.includes('terrarium') || a.includes('mapzen')) return 'terrarium';
  return 'unknown';
}

/**
 * DEM vertical error σ by source, m, for the bed perturbation. 3DEP: the lidar-derived 1/3″ DEM over these cities is
 * specified at ≤ 10 cm RMSEz for QL2 lidar in open terrain and degrades under vegetation and in the resampling to the
 * ~7.8 m grid — 0.2 m is the middle of the 0.1–0.3 m commonly quoted. Copernicus GLO-30: the spec is < 4 m absolute
 * (90 % LE); against 3DEP lidar on four U.S. valley floors this repo measured a 2–3.6 m mean bias and 2.2–4.8 m MAE
 * after the bare-earth filter (public/presets/SOURCES.txt) — 2.5 m is the random part. Terrarium (live-area fallback,
 * a mosaic of SRTM/NED/others): 3 m. Unknown: 1 m. The perturbation is random and unbiased: it does NOT represent a
 * DEM's systematic bias (Copernicus' positive valley-floor bias stays in every member).
 */
export const DEM_SIGMA_M: Readonly<Record<DemSource, number>> = { '3dep': 0.2, copernicus: 2.5, terrarium: 3, unknown: 1 };
/** Correlation length of the bed perturbation, m: DEM errors are spatially correlated (an assumption, not a measurement). */
export const DEM_CORR_M = 200;

/** Default bands. Sources / assumptions are stated in PERTURBATION_NOTES (shown in the panel and the docs). */
export function defaultRanges(dem: DemSource): EnsembleRanges {
  return { inflowPct: 20, rainPct: 25, stageM: 0.3, manningLo: 0.025, manningHi: 0.05, demSigmaM: DEM_SIGMA_M[dem], demCorrM: DEM_CORR_M };
}

export const RANGE_LIMITS = {
  inflowPct: [0, 80],
  rainPct: [0, 80],
  stageM: [0, 3],
  manning: [0.01, 0.2],
  demSigmaM: [0, 10],
} as const;

/** What each perturbation represents and where its default band comes from. [A] = assumption, labelled as such. */
export const PERTURBATION_NOTES: ReadonlyArray<{ key: string; title: string; text: string }> = [
  {
    key: 'inflow',
    title: 'Inflow ± 20 % [A]',
    text:
      'Every inflow (discharge and hydrograph) is scaled by the same factor. Peak discharges of big floods are rarely measured directly: they come from rating-curve extrapolation or indirect (slope-area) estimates, commonly quoted at ±10–25 % (USGS Techniques of Water-Resources Investigations, book 3 ch. A2/A10). ±20 % is an assumption inside that range. On a glacier-chain preset the routed outburst instead takes the peak and front time of one of the chain’s own ensemble members (volume × erosion rate × sediment), scaled and shifted onto the routed hydrograph.',
  },
  {
    key: 'rain',
    title: 'Rain ± 25 % [A]',
    text: 'Global rain and every storm cell scaled together. Radar-gauge rainfall at the hour and city-block scale is commonly uncertain by 20–30 %; ±25 % is an assumption, not a measurement for this storm.',
  },
  {
    key: 'stage',
    title: 'River stage ± 0.3 m [A]',
    text: 'The slider’s target stage plus or minus up to 0.3 m (about 1 ft), clamped to the slider’s range — roughly the size of a one-day river-stage forecast miss on a large river. An assumption; widen it for a longer forecast horizon.',
  },
  {
    key: 'manning',
    title: 'Manning n 0.025–0.05, log-uniform',
    text: 'One roughness for the whole map per member — or, with the land-cover roughness map on (Advanced), a multiplier on that map (n/0.035, so ×0.71–1.43). 0.025–0.05 spans short grass and pavement to light brush and urban floodplains in Chow (1959, table 5-6). On a debris-flow preset the friction law replaces Manning, so this input has no effect there.',
  },
  {
    key: 'dem',
    title: 'Terrain: smooth random bed error',
    text: `A smooth random field (correlation length ${DEM_CORR_M} m [A]) added to dry ground, σ 0.2 m for USGS 3DEP lidar-derived elevation, 2.5 m for Copernicus GLO-30, 3 m for the Terrarium fallback. It is zero under water that was there at the start (rivers, lakes) and fades in over a few cells, so the initial water stays at rest and the mass balance is untouched; walls stand on the perturbed ground. It is unbiased: a DEM’s systematic error (Copernicus reads valley floors 2–4 m high) is not in it.`,
  },
];

/** The caveat every ensemble result carries. */
export const ENSEMBLE_CAVEAT =
  'Not a calibrated probability of the real event: the share of these members — the same scenario with its inputs nudged within the bands above — in which the water got that deep. Everything the model leaves out or fixes (river bathymetry; buildings, roughness map and drains whether on or off) is the same in every member, so real uncertainty is wider.';

// ─── Deterministic sampling ─────────────────────────────────────────────────────────────────────────────────────

/** mulberry32: small, fast, seeded PRNG in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mix integers into one 32-bit seed (splitmix-style), for per-member / per-dimension streams. */
export function mixSeed(...xs: number[]): number {
  let h = 0x9e3779b9;
  for (const x of xs) {
    h = Math.imul(h ^ (x >>> 0), 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
  }
  return h >>> 0;
}

/**
 * Latin hypercube: n points in [0, 1)^dims. In every dimension each point falls in a different one of the n equal
 * strata (a random permutation of the strata per dimension), jittered uniformly inside its stratum. Deterministic in
 * `seed`. Returns points[i][d].
 */
export function latinHypercube(n: number, dims: number, seed: number): number[][] {
  const pts = Array.from({ length: n }, () => new Array<number>(dims).fill(0));
  for (let d = 0; d < dims; d++) {
    const rand = mulberry32(mixSeed(seed, d, 0x1a75));
    const perm = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    for (let i = 0; i < n; i++) pts[i][d] = (perm[i] + rand()) / n;
  }
  return pts;
}

/** Dimensions of the hypercube, in order. */
export const ENSEMBLE_DIMS = ['inflow', 'rain', 'stage', 'manning'] as const;

/** A chain ensemble member, or the deterministic run, as far as the 2-D inflow is concerned. */
export interface ChainMemberLike {
  entryPeak: number;
  /** Front arrival at the domain entry, s of chain time (NaN = never). */
  entryFront: number;
}

/** What the 2-D ensemble can borrow from a glacier chain's own ensemble (bridge ChainView). */
export interface ChainEnsembleInput {
  /** The run that drives the map now (its routed hydrograph is the inflow being perturbed). */
  det: ChainMemberLike;
  /** The chain ensemble's members, when it has run. */
  members?: readonly ChainMemberLike[] | null;
  /** Else its p10 / p50 / p90 band at the domain entry. */
  band?: { qPeak: readonly [number, number, number]; tFront: readonly [number, number, number] } | null;
}

export interface MemberParams {
  /** 0-based member number. */
  index: number;
  /** Seed of this member's own random streams (the DEM field). */
  seed: number;
  inflowFactor: number;
  rainFactor: number;
  /** m added to the stage slider's target. */
  stageDelta: number;
  manningN: number;
  /** Glacier chain presets: the routed inflow's peak factor and front shift (s), and the chain member it came from. */
  chain: { peakFactor: number; frontShift: number; member: number | null } | null;
  /** The hypercube point this member was drawn from (inflow, rain, stage, manning). */
  u: number[];
}

/** Piecewise-linear quantile function through (0.1, p10), (0.5, p50), (0.9, p90), held flat outside [0.1, 0.9]. */
export function bandQuantile(b: readonly [number, number, number], u: number): number {
  const [a, m, c] = b;
  if (u <= 0.1) return a;
  if (u >= 0.9) return c;
  return u < 0.5 ? a + ((m - a) * (u - 0.1)) / 0.4 : m + ((c - m) * (u - 0.5)) / 0.4;
}

function chainDraw(u: number, chain: ChainEnsembleInput): MemberParams['chain'] {
  const det = chain.det;
  if (!(det.entryPeak > 0)) return null;
  const ms = (chain.members ?? []).filter((m) => m.entryPeak > 0);
  if (ms.length) {
    // Members ordered by peak, one picked per stratum: the LHS spreads the 2-D members across the chain's range.
    const sorted = ms.map((m, k) => ({ m, k })).sort((a, b) => a.m.entryPeak - b.m.entryPeak);
    const pick = sorted[Math.min(sorted.length - 1, Math.floor(u * sorted.length))];
    const shift = Number.isFinite(pick.m.entryFront) && Number.isFinite(det.entryFront) ? pick.m.entryFront - det.entryFront : 0;
    return { peakFactor: pick.m.entryPeak / det.entryPeak, frontShift: shift, member: pick.k };
  }
  if (chain.band) {
    // No members: the band, comonotonic — a bigger peak comes with an earlier front (as in every chain run here).
    const peak = bandQuantile(chain.band.qPeak, u);
    const front = bandQuantile(chain.band.tFront, 1 - u);
    const shift = Number.isFinite(front) && Number.isFinite(det.entryFront) ? front - det.entryFront : 0;
    return { peakFactor: peak / det.entryPeak, frontShift: shift, member: null };
  }
  return null;
}

/** The members of an ensemble: Latin hypercube over ENSEMBLE_DIMS, deterministic in (n, ranges, seed, chain). */
export function sampleMembers(n: number, ranges: EnsembleRanges, seed: number, chain: ChainEnsembleInput | null = null): MemberParams[] {
  const N = Math.max(1, Math.floor(n));
  const pts = latinHypercube(N, ENSEMBLE_DIMS.length, seed);
  const sym = (u: number, half: number) => (half > 0 ? (2 * u - 1) * half : 0);
  const lo = Math.max(1e-4, Math.min(ranges.manningLo, ranges.manningHi));
  const hi = Math.max(lo, ranges.manningLo, ranges.manningHi);
  return pts.map((u, i) => ({
    index: i,
    seed: mixSeed(seed, i, 0xd3e),
    inflowFactor: Math.max(0, 1 + sym(u[0], ranges.inflowPct / 100)),
    rainFactor: Math.max(0, 1 + sym(u[1], ranges.rainPct / 100)),
    stageDelta: sym(u[2], ranges.stageM),
    manningN: lo * Math.pow(hi / lo, u[3]),
    chain: chain ? chainDraw(u[0], chain) : null,
    u,
  }));
}

// ─── One member's forcing ───────────────────────────────────────────────────────────────────────────────────────

/** The parts of the user's scenario an ensemble member perturbs. */
export interface ForcingState {
  sources: WaterSource[];
  storms: StormCell[];
  rainRate: number;
  stageOffset: number;
  manningN: number;
}

/**
 * A hydrograph with its excess over `base` scaled by `factor` and shifted `shift` s later (negative = earlier),
 * re-anchored at t = 0 (the solver holds the first point flat before it): q'(t) = base + factor·(q(t − shift) − base).
 */
export function shiftScaleHydrograph(points: readonly HydrographPoint[], factor: number, shift: number, base = points[0]?.q ?? 0): HydrographPoint[] {
  if (!points.length) return [];
  const qAt = (t: number): number => {
    if (t <= points[0].t) return points[0].q;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (b.t >= t) return b.t > a.t ? a.q + ((b.q - a.q) * (t - a.t)) / (b.t - a.t) : b.q;
    }
    return points[points.length - 1].q;
  };
  const sc = (q: number) => Math.max(0, base + factor * (q - base));
  const s = Number.isFinite(shift) ? shift : 0;
  const out: HydrographPoint[] = [{ t: 0, q: sc(qAt(-s)) }];
  for (const p of points) {
    const t = p.t + s;
    if (t > 0) out.push({ t, q: sc(p.q) });
  }
  return out;
}

/**
 * One member's forcing from the user's scenario: inflows × inflowFactor (the chain's routed inflow instead takes the
 * chain member's peak factor and front shift), rain and storms × rainFactor, stage target + stageDelta clamped to
 * [0, stageMax] (only when the scenario has a stage), Manning n replaced.
 */
export function memberForcing(base: ForcingState, m: MemberParams, opts: { stageMax: number | null; chainSourceId?: string | null } = { stageMax: null }): ForcingState {
  const sources = base.sources.map((s): WaterSource => {
    if (s.type !== 'inflow') return { ...s };
    if (m.chain && opts.chainSourceId && s.id === opts.chainSourceId && s.hydrograph?.length) {
      const hydrograph = shiftScaleHydrograph(s.hydrograph, m.chain.peakFactor, m.chain.frontShift);
      return { ...s, hydrograph, discharge: hydrograph.reduce((mx, p) => Math.max(mx, p.q), 0) };
    }
    const k = m.inflowFactor;
    return { ...s, discharge: s.discharge * k, ...(s.hydrograph ? { hydrograph: s.hydrograph.map((p) => ({ t: p.t, q: p.q * k })) } : {}) };
  });
  const storms = base.storms.map((c) => ({ ...c, intensity: c.intensity * m.rainFactor }));
  const stageOffset = opts.stageMax != null ? Math.min(opts.stageMax, Math.max(0, base.stageOffset + m.stageDelta)) : base.stageOffset;
  return { sources, storms, rainRate: base.rainRate * m.rainFactor, stageOffset, manningN: m.manningN };
}

// ─── Aggregation ────────────────────────────────────────────────────────────────────────────────────────────────

export type Band = [number, number, number];

/** p10 / p50 / p90 (R type 7 between order statistics; NaN counts as +∞ like the chain ensemble's). */
export function band(xs: readonly number[]): Band {
  return [quantile(xs, 0.1), quantile(xs, 0.5), quantile(xs, 0.9)];
}

/** What one member produced, for the summary. */
export interface MemberResult {
  index: number;
  params: MemberParams;
  /** Simulated seconds the member ran. */
  simTime: number;
  /** Land dry at the start that got deeper than 0.15 m, m². */
  floodedM2: number;
  /** The same for 0.5 m, m². */
  flooded50M2: number;
  /** Buildings reached (≥ 0.15 m), NaN without buildings. */
  reached: number;
  /** Summary loss and its ±1σ curve range, NaN without buildings or a cost table. */
  loss: number;
  lossLo: number;
  lossHi: number;
  /** Wall time: the run, and the readback + loss on the CPU, ms. */
  runMs: number;
  readMs: number;
  lossMs: number;
}

export interface EnsembleSummary {
  members: number;
  floodedM2: Band;
  flooded50M2: Band;
  reached: Band;
  loss: Band;
  /** Loss band including the curve uncertainty: p10 of the members' low ends, p90 of their high ends. */
  lossWide: [number, number];
}

export function summarizeMembers(rows: readonly MemberResult[]): EnsembleSummary {
  const col = (f: (r: MemberResult) => number) => rows.map(f);
  return {
    members: rows.length,
    floodedM2: band(col((r) => r.floodedM2)),
    flooded50M2: band(col((r) => r.flooded50M2)),
    reached: band(col((r) => r.reached)),
    loss: band(col((r) => r.loss)),
    lossWide: [quantile(col((r) => r.lossLo), 0.1), quantile(col((r) => r.lossHi), 0.9)],
  };
}

/** Flooded area of one member from its hazard fields: cells not wet at reset (firstWet ≠ 0) whose max depth > t. */
export function floodedArea(maxDepth: ArrayLike<number>, firstWet: ArrayLike<number>, cellSize: number, threshold: number): number {
  let n = 0;
  for (let c = 0; c < maxDepth.length; c++) if (firstWet[c] !== 0 && maxDepth[c] > threshold) n++;
  return n * cellSize * cellSize;
}

/**
 * CPU mirror of the GPU accumulate pass (src/sim/shaders/ensemble.ts), one cell: acc[4c..4c+3] =
 * (members with max depth > 0.15, > 0.5, Σ max depth, max of max depth). A non-finite max depth is not recorded.
 */
export function ensembleCellUpdate(acc: Float32Array | Float64Array, c: number, maxDepth: number): void {
  if (!Number.isFinite(maxDepth)) return;
  const d = Math.max(0, maxDepth);
  const k = c * ENSEMBLE_PER_CELL;
  if (d > ENSEMBLE_THRESHOLDS[0]) acc[k] += 1;
  if (d > ENSEMBLE_THRESHOLDS[1]) acc[k + 1] += 1;
  acc[k + 2] += d;
  acc[k + 3] = Math.max(acc[k + 3], d);
}

/** Exceedance probability (0–1) of a cell or asset: members over the threshold / members. */
export function exceedance(count: number, members: number): number {
  return members > 0 ? Math.min(1, Math.max(0, count / members)) : NaN;
}

/**
 * Per-asset tally across members (sites and portfolio assets). The thresholds are the probability map's own
 * (ENSEMBLE_THRESHOLDS, strictly deeper than — src/sim/ensemble.ts counts `d > T`), so "floods in 7 of 12 members"
 * on an asset and the map's share under it count the same thing. (The loss model's REACHED_DEPTH test is ≥ 0.15 m;
 * the two differ only for a depth of exactly 0.15 m.)
 */
export interface AssetTally {
  id: string;
  name: string;
  members: number;
  /** Members in which the asset was reached (> 0.15 m) / took > 0.5 m. */
  reached: number;
  over50: number;
  /** Members in which the asset was not assessed (outside the map: no cell to read), recorded as a NaN depth. */
  outside: number;
  /** Max depth at the asset per member, m (0 dry, NaN outside the map). */
  depths: number[];
  losses: number[];
}

export function newTally(id: string, name: string): AssetTally {
  return { id, name, members: 0, reached: 0, over50: 0, outside: 0, depths: [], losses: [] };
}

/** One member's result for an asset. A non-finite depth means "not assessed" (outside the map), never "dry". */
export function addToTally(t: AssetTally, depth: number, loss: number): void {
  t.members++;
  if (!Number.isFinite(depth)) t.outside++;
  else {
    if (depth > ENSEMBLE_THRESHOLDS[0]) t.reached++;
    if (depth > ENSEMBLE_THRESHOLDS[1]) t.over50++;
  }
  t.depths.push(depth);
  t.losses.push(loss);
}

/** "floods in 7 of 12 members"; "is outside the map" when no member could assess it. */
export function tallySentence(t: AssetTally): string {
  if (!t.members) return '';
  const n = t.members - t.outside;
  if (n === 0) return 'is outside the map (not assessed)';
  const tail = t.outside ? ` (not assessed in ${t.outside}: outside the map)` : '';
  const of = t.outside ? `${n} assessed members` : `${n} members`;
  if (t.reached === 0) return `stays at or below 15 cm in all ${of}${tail}`;
  if (t.reached === n) return `floods (> 15 cm) in all ${of}${tail}`;
  return `floods (> 15 cm) in ${t.reached} of ${of}${tail}`;
}

/**
 * One member's portfolio results folded into the per-asset tallies (tallies[k] ↔ assets[k], the CSV order). The
 * results are matched to the assets by IDENTITY (result.m.asset is the parsed asset object analyze() was given), not
 * by position: assessPortfolio drops the assets it cannot assess (outside the map, no cell), so the k-th result is
 * not the k-th asset once one is dropped. An asset with no result is recorded as not assessed (NaN depth) — "outside
 * the map", never "dry".
 */
export function addPortfolioMember(
  tallies: readonly AssetTally[],
  assets: readonly object[],
  results: ReadonlyArray<{ m: { asset: object }; depth: number; loss: number }>,
): void {
  const byAsset = new Map<object, { depth: number; loss: number }>();
  for (const r of results) byAsset.set(r.m.asset, r);
  tallies.forEach((t, k) => {
    const r = byAsset.get(assets[k]);
    addToTally(t, r ? r.depth : NaN, r ? r.loss : NaN);
  });
}
