/**
 * The glacier hazard chain end to end (research spec §0): trigger → outflow hydrograph at the source → 1-D routing
 * down the baked valley → arrival, peak and stage at every station, warning lead time, and the hydrograph that enters
 * the 2-D domain. Pure and deterministic: runs in a Web Worker (src/hazard/worker.ts) and in node tests.
 *
 *   runChain(spec, file, overrides?)   one run — the deterministic "median" scenario, or one ensemble member
 *   runEnsemble(spec, file, …)         the 3 × 3 × 3 ensemble of spec §I.5 → p10 / p50 / p90 bands
 *   toWaterSource(result, file, …)     the routed hydrograph as the 2-D solver's inflow (WaterSource.hydrograph)
 *
 * Times are seconds after the chain's clock zero (the trigger; ChainFile.clockZero where the event is real).
 */
import type { WaterSource } from '../contracts';
import type { ChainFile, ChainResult, ChainStation, HazardChainSpec, HazardTrigger, MassMovement } from './types';
import { breachHydrograph, type Hydrograph } from './breach';
import {
  BASEFLOW_DEFAULT,
  CV_ENSEMBLE,
  DAM_LENGTH,
  EROSION_RATE,
  EROSION_RATE_AVALANCHE_DAM,
  EROSION_RATE_ENSEMBLE,
  EROSION_RATE_TRIGGERED,
  LAKE_HYPSOMETRY,
  ROUTING_DX,
} from './defaults';
import { damHeight, directFlow, impulseWave, overtopping, runout, type ImpulseWave, type Runout } from './mass';
import { meltFromTrigger } from './melt';
import { nodeAt, readProbe, resampleProfile, route, sectionArea, valleyStorage, type MassBalance, type RoutingOptions } from './routing';
import { Series, sumSeries, zeroSeries } from './series';
import { drainableVolume } from './volume';

/** What a caller may change about one run without editing the scenario. */
export interface ChainOverrides {
  /** Multiplies the source volume (the lake's drainable volume, or the mass movement's volume). */
  volumeFactor?: number;
  /** Breach down-cutting rate, m/h (replaces the trigger's, and the triggered / avalanche-dam defaults). */
  erosionRate?: number;
  /** Sediment concentration of the outflow as it leaves the source. */
  cv?: number;
  /** River baseflow at the profile's upstream end, m³/s, and tributaries joining downstream. */
  baseflow?: number;
  tributaries?: Array<{ s: number; q: number }>;
  /** "Bulking ×" knob (spec §C.5): multiplies the source outflow for the material and river water the flood picks up
   * on its first steep reach (Gongbatongsha 2016 grew ×6.6 in 6.5 km). Default 1. */
  bulking?: number;
  /** Route on a coarser grid, m (resampleProfile); the ensemble uses this for speed. */
  routeDx?: number;
  /** Passed through to the router (cfl, theta, uMax, cvMode, entryDt, tMax …). */
  routing?: Partial<RoutingOptions>;
}

/** How the source behaved — the "why" behind the hydrograph, for the UI. */
export interface SourceInfo {
  trigger: HazardTrigger['kind'];
  /** Chainage where the outflow enters the profile, m. */
  s: number;
  /** Sediment concentration of the outflow. */
  cv: number;
  /** False when the chain stopped at the source (the avalanche stopped short, the wave did not overtop). */
  flood: boolean;
  notes: string[];
  runout?: Runout;
  wave?: ImpulseWave;
  overtopVolume?: number;
  /** Avalanche dam: height above the thalweg, impounded volume, and the time it takes the river to fill it, s. */
  dam?: { height: number; impounded: number; fillTime: number };
  /** Melt anomaly: extra baseflow, m³/s. */
  meltQ?: number;
}

/** A station's read-out (ChainResult.stations entry plus what the UI also wants). */
export interface StationResult {
  name: string;
  s: number;
  kind: ChainStation['kind'] | 'entry';
  tFront: number;
  tPeak: number;
  qPeak: number;
  stageMax: number;
  cv: number;
  /** Stage rise above the stage at t = 0, m, and the baseflow through the station, m³/s. */
  rise: number;
  qBase: number;
}

/** runChain's result: the contract's ChainResult plus diagnostics. */
export interface ChainRunResult extends ChainResult {
  stations: StationResult[];
  sourceInfo: SourceInfo;
  /** Baseflow through the domain entry, m³/s, and the Cv of the entry hydrograph per point. */
  entryBase: number;
  entryCv: number[];
  /** Front arrival and peak at the domain entry (also the ensemble's subject). */
  entryFront: number;
  entryPeak: number;
  routing: { steps: number; ms: number; tEnd: number; capped: number; uPeak: number; massBalance: MassBalance; dx: number };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Source
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Chainage of the source: the first 'source' or 'lake' station, else the profile's upstream end. */
export function sourceChainage(file: ChainFile): number {
  const st = file.stations.find((x) => x.kind === 'source' || x.kind === 'lake');
  return st ? st.s : file.s[0];
}

interface Source {
  series: Series;
  info: SourceInfo;
  /** Extra baseflow the source adds (melt). */
  extraBase: number;
}

function scaledMass(m: MassMovement, f: number): MassMovement {
  return { ...m, volume: m.volume * f };
}

function sourceOf(trigger: HazardTrigger, file: ChainFile, ov: ChainOverrides, baseflow: number): Source {
  const vf = ov.volumeFactor ?? 1;
  const s = sourceChainage(file);
  const notes: string[] = [];
  const info = (cv: number, flood: boolean, extra: Partial<SourceInfo> = {}): SourceInfo => ({ trigger: trigger.kind, s, cv, flood, notes, ...extra });
  switch (trigger.kind) {
    case 'breach': {
      const { lake, breach } = trigger;
      const V = lake.volume.median * vf;
      const drain = drainableVolume(V, lake.area, breach.finalDepth, breach.hypsometry || LAKE_HYPSOMETRY);
      const h = breachHydrograph(drain, { ...breach, erosionRate: ov.erosionRate ?? breach.erosionRate });
      notes.push(`breach ${breach.model}: ${(drain / 1e6).toFixed(2)} Mm³ drainable of ${(V / 1e6).toFixed(2)} Mm³`);
      return { series: h.series, info: info(ov.cv ?? 0, h.volume > 0), extraBase: 0 };
    }
    case 'massIntoLake': {
      // The volume factor scales the LAKE (its band is what the ensemble samples), not the mass.
      const { breach } = trigger;
      const lake = { ...trigger.lake, volume: { ...trigger.lake.volume, median: trigger.lake.volume.median * vf } };
      const mass = trigger.mass;
      const ro = runout(mass);
      if (!ro.reaches) {
        notes.push(`the mass stops short of the lake (path H/L ${ro.pathRatio.toFixed(2)} < mobility ${ro.mobility.toFixed(2)})`);
        return { series: zeroSeries(), info: info(0, false, { runout: ro }), extraBase: 0 };
      }
      const wave = impulseWave(mass, lake);
      const ot = overtopping(wave, lake);
      if (!ot.overtops) {
        notes.push(`wave ${wave.heightAtDam.toFixed(1)} m at the dam does not clear the freeboard — the lake survived`);
        return { series: zeroSeries(), info: info(0, false, { runout: ro, wave }), extraBase: 0 };
      }
      // The surge has already scoured the crest by (H − f) and cuts at the triggered rate (spec §C.2).
      const drain = drainableVolume(lake.volume.median, lake.area, breach.finalDepth, breach.hypsometry || LAKE_HYPSOMETRY);
      const k = ov.erosionRate ?? Math.max(breach.erosionRate, EROSION_RATE_TRIGGERED);
      const b = breachHydrograph(Math.max(0, drain - ot.volume), { ...breach, model: breach.model, erosionRate: k }, { startHead: Math.min(breach.finalDepth, ot.excess) });
      notes.push(`wave ${wave.heightAtDam.toFixed(1)} m at the dam (P = ${wave.P.toFixed(2)}): overtops by ${ot.excess.toFixed(1)} m, ${(ot.volume / 1e6).toFixed(2)} Mm³ pulse, breach at ${k} m/h`);
      return { series: sumSeries([ot.pulse.series, b.series]), info: info(ov.cv ?? 0, true, { runout: ro, wave, overtopVolume: ot.volume }), extraBase: 0 };
    }
    case 'massIntoRiver': {
      const mass = scaledMass(trigger.mass, vf);
      const ro = runout(mass);
      if (!ro.reaches) {
        notes.push(`the mass stops short of the river (path H/L ${ro.pathRatio.toFixed(2)} < mobility ${ro.mobility.toFixed(2)})`);
        return { series: zeroSeries(), info: info(0, false, { runout: ro }), extraBase: 0 };
      }
      if (trigger.mode === 'directFlow') {
        const df = directFlow(mass, { cv: ov.cv });
        notes.push(`direct flow: ${(df.water / 1e6).toFixed(1)} Mm³ of melt water, ${(df.mixture / 1e6).toFixed(1)} Mm³ at Cv ${df.cv.toFixed(2)}, peak ${df.peak.toFixed(0)} m³/s`);
        return { series: df.series, info: info(df.cv, df.volume > 0, { runout: ro }), extraBase: 0 };
      }
      // Transient dam: the deposit blocks the valley at the impact, the river fills the impoundment, then it breaches
      // like an ice-rich, uncompacted dam (spec §C.3 branch 1).
      const node = nodeAt(file, s);
      const H = damHeight(mass.volume, trigger.damLength ?? DAM_LENGTH, (h) => sectionArea(file, node, h));
      const crest = file.zBed[node] + H;
      const imp = valleyStorage(file, Math.max(0, node - 1), crest);
      const half = valleyStorage(file, Math.max(0, node - 1), file.zBed[node] + H / 2);
      const p = imp.volume > 0 && half.volume > 0 ? Math.min(3, Math.max(1, Math.log2(imp.volume / half.volume))) : LAKE_HYPSOMETRY;
      const qIn = trigger.baseflow > 0 ? trigger.baseflow : baseflow;
      const fill = qIn > 0 ? imp.volume / qIn : Infinity;
      const k = ov.erosionRate ?? EROSION_RATE_AVALANCHE_DAM;
      const b: Hydrograph = breachHydrograph(imp.volume, { model: 'weirErosion', erosionRate: k, finalDepth: H, widthRatio: 2, sideSlope: 1, hypsometry: p });
      notes.push(`avalanche dam ${H.toFixed(0)} m high impounds ${(imp.volume / 1e6).toFixed(2)} Mm³ over ${(imp.length / 1000).toFixed(1)} km; fills in ${(fill / 3600).toFixed(1)} h at ${qIn.toFixed(0)} m³/s, then breaches at ${k} m/h`);
      if (!Number.isFinite(fill)) return { series: zeroSeries(), info: info(0, false, { runout: ro, dam: { height: H, impounded: imp.volume, fillTime: fill } }), extraBase: 0 };
      // The river's own baseflow keeps flowing in the routing while the lake fills (simplification: the dry river bed
      // below a blockage — itself a warning sign — is not modelled), so the breach ODE takes no inflow.
      return {
        series: b.series.shifted(fill),
        info: info(ov.cv ?? 0, b.volume > 0, { runout: ro, dam: { height: H, impounded: imp.volume, fillTime: fill } }),
        extraBase: 0,
      };
    }
    case 'meltAnomaly': {
      const m = meltFromTrigger({ ...trigger, glacierArea: trigger.glacierArea * vf });
      notes.push(`melt anomaly: +${m.extraQ.toFixed(1)} m³/s of baseflow for ${trigger.days} days (not a flood wave)`);
      return { series: zeroSeries(), info: info(0, false, { meltQ: m.extraQ }), extraBase: m.extraQ };
    }
    case 'given': {
      const series = Series.fromPoints(trigger.hydrograph).scaled(vf);
      notes.push(`given hydrograph (${trigger.provenance})`);
      return { series, info: info(ov.cv ?? 0, series.total > 0), extraBase: 0 };
    }
  }
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// One run
// ────────────────────────────────────────────────────────────────────────────────────────────

/** The baseflow a run uses: override, else the trigger's (massIntoRiver), else the default. */
function baseflowOf(spec: HazardChainSpec, ov: ChainOverrides): number {
  if (ov.baseflow !== undefined) return Math.max(0, ov.baseflow);
  if (spec.trigger.kind === 'massIntoRiver' && spec.trigger.baseflow > 0) return spec.trigger.baseflow;
  return BASEFLOW_DEFAULT;
}

/**
 * Run the chain once. Deterministic: the same spec, file and overrides give the same bits.
 *
 * Station front = first time Q exceeds the station's baseflow by max(10 m³/s, 5 % of its peak excess) or its stage rose
 * 0.5 m (routing.ts readProbe); NaN where the flood never got there. Lead time = front − spec.alertTime.
 */
export function runChain(spec: HazardChainSpec, file: ChainFile, overrides: ChainOverrides = {}): ChainRunResult {
  const ov = overrides;
  const base = baseflowOf(spec, ov);
  const src = sourceOf(spec.trigger, file, ov, base);
  const bulking = Math.max(0, ov.bulking ?? 1);
  const series = bulking !== 1 ? src.series.scaled(bulking) : src.series;
  const sourcePeak = series.peak();

  const routeFile = ov.routeDx && ov.routeDx > ROUTING_DX ? resampleProfile(file, ov.routeDx) : file;
  const probes = file.stations.map((st) => ({ name: st.name, s: st.s }));
  const entryName = '__entry__';
  probes.push({ name: entryName, s: file.domainEntry.s });
  const r = route(routeFile, {
    inflows: src.info.flood ? [{ s: src.info.s, series, cv: src.info.cv }] : [],
    baseflow: base + src.extraBase,
    tributaries: ov.tributaries,
    probes,
    entryS: file.domainEntry.s,
    // A run without a flood still routes an hour so the entry shows the (raised) baseflow.
    ...(src.info.flood ? {} : { tEnd: 3600 }),
    ...ov.routing,
  });

  const stations: StationResult[] = [];
  let entryFront = NaN;
  let entryPeak = 0;
  let entryBase = 0;
  r.probes.forEach((p, k) => {
    const o = readProbe(r.t, p);
    if (p.name === entryName && k === r.probes.length - 1) {
      entryFront = o.tFront;
      entryPeak = o.qPeak;
      entryBase = p.qBase;
      return;
    }
    const st = file.stations[k];
    stations.push({ name: st.name, s: st.s, kind: st.kind, tFront: o.tFront, tPeak: o.tPeak, qPeak: o.qPeak, stageMax: o.stageMax, cv: o.cv, rise: o.rise, qBase: p.qBase });
  });

  const entry = Array.from(r.entry.t, (t, i) => ({ t, q: r.entry.q[i] }));
  let leadTime: Record<string, number> | undefined;
  if (spec.alertTime !== undefined && Number.isFinite(spec.alertTime)) {
    leadTime = {};
    for (const st of stations) leadTime[st.name] = st.tFront - spec.alertTime;
  }
  return {
    source: { t: series.t, q: series.q, volume: series.total, peak: sourcePeak.q, tPeak: sourcePeak.t },
    stations,
    entry,
    leadTime,
    sourceInfo: src.info,
    entryBase,
    entryCv: Array.from(r.entry.cv),
    entryFront,
    entryPeak,
    routing: { steps: r.steps, ms: r.ms, tEnd: r.tEnd, capped: r.capped, uPeak: r.uPeak, massBalance: r.massBalance, dx: ov.routeDx ?? ROUTING_DX },
  };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Ensemble
// ────────────────────────────────────────────────────────────────────────────────────────────

/** p-th quantile (0–1) by linear interpolation between order statistics (R type 7). NaN counts as +∞ (never arrived). */
export function quantile(values: readonly number[], p: number): number {
  const v = values.map((x) => (Number.isNaN(x) ? Infinity : x)).sort((a, b) => a - b);
  if (v.length === 0) return NaN;
  const h = (v.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi || v[hi] === v[lo]) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (h - lo);
}

export interface EnsembleMember {
  volumeFactor: number;
  erosionRate: number;
  cv: number;
  entryPeak: number;
  entryFront: number;
  stations: Array<{ name: string; tFront: number; qPeak: number }>;
  ms: number;
}

export interface EnsembleResult {
  /** The deterministic run (median volume, default k and Cv) on the full grid, with `ensemble` filled in. */
  result: ChainRunResult;
  members: EnsembleMember[];
  /** p10 / p50 / p90 per station. */
  stationBands: Record<string, { qPeak: [number, number, number]; tFront: [number, number, number] }>;
  ms: number;
}

/** The volume factors of the ensemble: the lake's own lo/median/hi band, else ×/÷2 around the given volume. */
function volumeFactors(trigger: HazardTrigger): number[] {
  if (trigger.kind === 'breach' || trigger.kind === 'massIntoLake') {
    const v = trigger.lake.volume;
    if (v.median > 0) return [v.lo / v.median, 1, v.hi / v.median];
  }
  if (trigger.kind === 'given') return [1];
  return [0.5, 1, 2];
}

/** The erosion rates of the ensemble: 10 / 30 / 100 m/h where a breach erodes, a single default otherwise. */
function erosionRates(trigger: HazardTrigger): Array<number | undefined> {
  if (trigger.kind === 'breach' || trigger.kind === 'massIntoLake') return [...EROSION_RATE_ENSEMBLE];
  if (trigger.kind === 'massIntoRiver' && trigger.mode === 'transientDam') return EROSION_RATE_ENSEMBLE.map((k) => (k * EROSION_RATE_AVALANCHE_DAM) / EROSION_RATE);
  return [undefined];
}

/**
 * The 3 × 3 × 3 ensemble of spec §I.5 — volume lo/median/hi × erosion rate 10/30/100 m/h × source Cv 0/0.2/0.4 —
 * collapsing dimensions a trigger does not have (a given hydrograph has no volume band or erosion rate). Members are
 * routed on a coarser grid (default 250 m: ~6× faster) — their spread is the point, not their last digit — and the
 * deterministic result is routed on the baked grid. Members are equally weighted; p10/p50/p90 interpolate between
 * order statistics, with "never arrived" as +∞.
 */
export function runEnsemble(
  spec: HazardChainSpec,
  file: ChainFile,
  overrides: ChainOverrides = {},
  opts: { memberDx?: number; onProgress?: (done: number, total: number) => void } = {},
): EnsembleResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = runChain(spec, file, overrides);
  const vfs = volumeFactors(spec.trigger);
  const ks = erosionRates(spec.trigger);
  const cvs = spec.trigger.kind === 'meltAnomaly' ? [0] : [...CV_ENSEMBLE];
  const memberDx = opts.memberDx ?? 250;
  const members: EnsembleMember[] = [];
  const total = vfs.length * ks.length * cvs.length;
  for (const vf of vfs)
    for (const k of ks)
      for (const cv of cvs) {
        const r = runChain(spec, file, {
          ...overrides,
          volumeFactor: (overrides.volumeFactor ?? 1) * vf,
          erosionRate: k ?? overrides.erosionRate,
          cv,
          routeDx: Math.max(memberDx, overrides.routeDx ?? 0),
        });
        members.push({
          volumeFactor: vf,
          erosionRate: k ?? overrides.erosionRate ?? NaN,
          cv,
          entryPeak: r.entryPeak,
          entryFront: r.entryFront,
          stations: r.stations.map((s) => ({ name: s.name, tFront: s.tFront, qPeak: s.qPeak })),
          ms: r.routing.ms,
        });
        opts.onProgress?.(members.length, total);
      }
  const band = (xs: number[]): [number, number, number] => [quantile(xs, 0.1), quantile(xs, 0.5), quantile(xs, 0.9)];
  result.ensemble = { qPeak: band(members.map((m) => m.entryPeak)), tFront: band(members.map((m) => m.entryFront)) };
  const stationBands: EnsembleResult['stationBands'] = {};
  for (const st of result.stations) {
    const rows = members.map((m) => m.stations.find((x) => x.name === st.name)!);
    stationBands[st.name] = { qPeak: band(rows.map((x) => x.qPeak)), tFront: band(rows.map((x) => x.tFront)) };
  }
  return { result, members, stationBands, ms: (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0 };
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Hand-off to the 2-D solver
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface WaterSourceOptions {
  /**
   * Chain time that becomes the 2-D solver's t = 0, s. Default: `preroll` seconds before the front reaches the domain
   * entry — the 2-D run should not spend forty simulated minutes waiting for a wave that is still 50 km upstream.
   */
  offset?: number;
  /**
   * Seconds of baseflow the 2-D run gets before the front (default 300). The baked rivers start DRY (Nepal: "the
   * rivers start dry"), so a few minutes of baseflow first wets the channel and the front then runs on water, not on a
   * dry bed — closer to the real river. Set 0 to start the 2-D run on the front itself.
   */
  preroll?: number;
  id?: string;
  label?: string;
}

/** The chain time that becomes the 2-D t = 0 (see WaterSourceOptions.offset). */
export function domainClockOffset(result: ChainRunResult, opts: WaterSourceOptions = {}): number {
  if (opts.offset !== undefined) return opts.offset;
  const pre = opts.preroll ?? 300;
  return Number.isFinite(result.entryFront) ? Math.max(0, result.entryFront - pre) : 0;
}

/**
 * The routed hydrograph at the domain entry as the 2-D solver's inflow WaterSource, times shifted to the 2-D clock
 * (domainClockOffset). The routed entry series is one mean discharge per sampling bin, exact in volume; as a
 * piecewise-linear curve through the bin centres (what src/sim/forcing.ts integrates) its area differs by the
 * curvature within bins, so the points are rescaled — by a factor within ~1e-3 of 1 — to deliver exactly the routed
 * volume after the offset. `discharge` is the peak (the label and the CFL estimate's fallback read it). After its last
 * point the forcing holds the last value: the river keeps its baseflow.
 */
export function toWaterSource(result: ChainRunResult, file: ChainFile, opts: WaterSourceOptions = {}): Extract<WaterSource, { type: 'inflow' }> {
  const off = domainClockOffset(result, opts);
  const e = result.entry;
  const pts: Array<{ t: number; q: number }> = [];
  // Exact routed volume after the offset: whole bins after it plus the part of the straddling bin.
  let exact = 0;
  const dtBin = e.length > 1 ? e[1].t - e[0].t : 2 * (e[0]?.t ?? 1);
  for (const p of e) {
    const a = p.t - dtBin / 2;
    const b = p.t + dtBin / 2;
    if (b <= off) continue;
    exact += p.q * (b - Math.max(a, off));
  }
  // Q at the offset, interpolated, then every bin centre after it.
  const at = (t: number): number => {
    if (e.length === 0) return 0;
    if (t <= e[0].t) return e[0].q;
    for (let i = 1; i < e.length; i++) if (e[i].t >= t) return e[i - 1].q + ((e[i].q - e[i - 1].q) * (t - e[i - 1].t)) / (e[i].t - e[i - 1].t);
    return e[e.length - 1].q;
  };
  pts.push({ t: 0, q: at(off) });
  for (const p of e) if (p.t > off) pts.push({ t: p.t - off, q: p.q });
  // Area of the piecewise-linear curve over the same span (the last half bin held flat).
  let area = 0;
  for (let i = 1; i < pts.length; i++) area += 0.5 * (pts[i].q + pts[i - 1].q) * (pts[i].t - pts[i - 1].t);
  area += pts[pts.length - 1].q * (dtBin / 2);
  const f = area > 0 && exact > 0 ? exact / area : 1;
  const hydrograph = pts.map((p) => ({ t: p.t, q: p.q * f }));
  const peak = hydrograph.reduce((m, p) => Math.max(m, p.q), 0);
  const d = file.domainEntry;
  return {
    id: opts.id ?? 'chain-inflow',
    type: 'inflow',
    gx: d.gx,
    gy: d.gy,
    radius: d.radius,
    discharge: peak,
    hydrograph,
    label: opts.label ?? `Routed outburst (${file.name}) — modelled, 1-D chain from the source`,
  };
}
