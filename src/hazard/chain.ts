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
import type { ChainFile, ChainResult, ChainStation, HazardChainSpec, HazardTrigger, MassMovement, ResistanceLaw } from './types';
import { breachHydrograph, type Hydrograph } from './breach';
import {
  AVALANCHE_SPEED,
  BASEFLOW_DEFAULT,
  CV_ENSEMBLE,
  DAM_LENGTH,
  EROSION_RATE,
  EROSION_RATE_AVALANCHE_DAM,
  EROSION_RATE_ENSEMBLE,
  EROSION_RATE_TRIGGERED,
  LAKE_HYPSOMETRY,
  ROUTING_DX,
  ROUTING_T_MAX,
} from './defaults';
import { damHeight, directFlow, impulseWave, overtopping, runout, type ImpulseWave, type Runout } from './mass';
import { meltFromTrigger } from './melt';
import { slideRunout, slideTimeAt, type SlideRunout } from './runout';
import { nodeAt, readProbe, resampleProfile, route, sectionArea, valleyStorage, type MassBalance, type RoutingOptions } from './routing';
import { Series, sumSeries, zeroSeries } from './series';
import { drainableVolume } from './volume';
import type { FrontProfile } from './frontProfile';

/** What a caller may change about one run without editing the scenario. */
export interface ChainOverrides {
  /** Multiplies the source volume (the lake's drainable volume, or the mass movement's volume). */
  volumeFactor?: number;
  /** Breach down-cutting rate, m/h (replaces the trigger's, and the triggered / avalanche-dam defaults). */
  erosionRate?: number;
  /** Sediment concentration of the outflow as it leaves the source. */
  cv?: number;
  /** River baseflow at the profile's upstream end, m³/s, and tributaries joining downstream (replace the spec's
   * routing.tributaries for this run). */
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
  /** Mass movements: seconds from the collapse (clock zero) to the mass reaching the lake or river. */
  travelTime?: number;
  /** Direct flow with a sliding-block runout (HazardTrigger.slide): the block's track and where the flood starts. */
  slide?: SlideRunout;
}

/**
 * The avalanche's own travel time, s: path length / mean speed (MassMovement.travelSpeed, default AVALANCHE_SPEED).
 * The chain's clock starts at the collapse — for a real event, its seismic signal — and no water leaves the impact
 * point before the mass gets there. Observed arrival times downstream include this; the routing must not be tuned to
 * absorb it.
 */
export function massTravelTime(mass: MassMovement): number {
  const v = mass.travelSpeed ?? AVALANCHE_SPEED;
  return v > 0 && mass.pathLength > 0 ? mass.pathLength / v : 0;
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
  routing: { steps: number; nodeSteps: number; ms: number; tEnd: number; timedOut: boolean; capped: number; uPeak: number; massBalance: MassBalance; dx: number };
  /** Front arrival along the profile (src/hazard/frontProfile.ts runChainWithProfile; absent from a plain runChain). */
  frontProfile?: FrontProfile;
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

function sourceOf(trigger: HazardTrigger, file: ChainFile, ov: ChainOverrides, baseflow: number, law?: ResistanceLaw): Source {
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
      const wave = impulseWave(mass, lake, trigger.wave);
      const ot = overtopping(wave, lake);
      const travel = massTravelTime(mass);
      notes.push(`the mass reaches the lake ${(travel / 60).toFixed(1)} min after the collapse (${(mass.pathLength / 1000).toFixed(1)} km at ${(mass.travelSpeed ?? AVALANCHE_SPEED).toFixed(0)} m/s)`);
      notes.push(
        `impulse wave ${wave.waveType}: H ${wave.heightAtDam.toFixed(1)} m, crest ${wave.amplitudeAtDam.toFixed(1)} m at the dam ${(wave.distance / 1000).toFixed(2)} km away (flume value ${wave.heightAtDam2D.toFixed(1)} m; spreading β ${((wave.spread * 180) / Math.PI).toFixed(0)}°, γ′ ${((wave.angle * 180) / Math.PI).toFixed(0)}°)` +
          (wave.warnings.length ? `; ${wave.warnings.join('; ')}` : ''),
      );
      if (!ot.overtops) {
        notes.push(`crest ${wave.amplitudeAtDam.toFixed(1)} m at the dam does not clear the freeboard — the lake survived`);
        return { series: zeroSeries(), info: info(0, false, { runout: ro, wave }), extraBase: 0 };
      }
      // The surge has already scoured the crest by (H − f) and cuts at the triggered rate (spec §C.2).
      const drain = drainableVolume(lake.volume.median, lake.area, breach.finalDepth, breach.hypsometry || LAKE_HYPSOMETRY);
      const k = ov.erosionRate ?? Math.max(breach.erosionRate, EROSION_RATE_TRIGGERED);
      const b = breachHydrograph(Math.max(0, drain - ot.volume), { ...breach, model: breach.model, erosionRate: k }, { startHead: Math.min(breach.finalDepth, ot.excess) });
      notes.push(`P = ${wave.P.toFixed(2)}: overtops by ${ot.excess.toFixed(1)} m, ${(ot.volume / 1e6).toFixed(2)} Mm³ pulse, breach at ${k} m/h`);
      return {
        series: sumSeries([ot.pulse.series, b.series]).shifted(travel),
        info: info(ov.cv ?? 0, true, { runout: ro, wave, overtopVolume: ot.volume, travelTime: travel }),
        extraBase: 0,
      };
    }
    case 'massIntoRiver': {
      const mass = scaledMass(trigger.mass, vf);
      const ro = runout(mass);
      if (!ro.reaches) {
        notes.push(`the mass stops short of the river (path H/L ${ro.pathRatio.toFixed(2)} < mobility ${ro.mobility.toFixed(2)})`);
        return { series: zeroSeries(), info: info(0, false, { runout: ro }), extraBase: 0 };
      }
      if (trigger.mode === 'directFlow') {
        const shape = trigger.shape ?? 'gamma';
        const df = directFlow(mass, { cv: ov.cv, shape });
        const flowNote = () =>
          `direct flow: ${(df.water / 1e6).toFixed(1)} Mm³ of melt water, ${(df.mixture / 1e6).toFixed(1)} Mm³ at Cv ${df.cv.toFixed(2)}, peak ${df.peak.toFixed(0)} m³/s` +
          (shape === 'surge' ? ` as a debris-flow surge (peak ${df.tPeak.toFixed(0)} s after its front, over by ${(df.series.end / 60).toFixed(0)} min)` : '');
        if (trigger.slide && df.peak > 0) {
          // The avalanche runs as a sliding block until the routed flood would be the faster (src/hazard/runout.ts).
          const sl = slideRunout(mass, file, trigger.slide, df.peak, s, file.domainEntry.s - ROUTING_DX, law);
          const src = trigger.slide.source ? `, ${trigger.slide.source}` : '';
          notes.push(`the mass reaches the river ${(sl.tPath / 60).toFixed(1)} min after the collapse at ${sl.vPath.toFixed(0)} m/s (Voellmy block, μ ${trigger.slide.mu}, ξ ${trigger.slide.xi} m/s²${src})`);
          notes.push(
            `it runs on down the valley as a debris flow and hands over to the routed flood at ${(sl.sHand / 1000).toFixed(1)} km, ${(sl.tHand / 60).toFixed(1)} min after the collapse, at ${sl.vHand.toFixed(0)} m/s${sl.stopped ? ' (where it stopped)' : ' (no faster than the flood there)'}`,
          );
          notes.push(flowNote());
          return {
            series: df.series.shifted(sl.tHand),
            info: { ...info(df.cv, df.volume > 0, { runout: ro, travelTime: sl.tPath, slide: sl }), s: sl.sHand },
            extraBase: 0,
          };
        }
        const travel = massTravelTime(mass);
        notes.push(`the mass reaches the river ${(travel / 60).toFixed(1)} min after the collapse (${(mass.pathLength / 1000).toFixed(1)} km at ${(mass.travelSpeed ?? AVALANCHE_SPEED).toFixed(0)} m/s)`);
        notes.push(flowNote());
        return { series: df.series.shifted(travel), info: info(df.cv, df.volume > 0, { runout: ro, travelTime: travel }), extraBase: 0 };
      }
      const travel = massTravelTime(mass);
      notes.push(`the mass reaches the river ${(travel / 60).toFixed(1)} min after the collapse (${(mass.pathLength / 1000).toFixed(1)} km at ${(mass.travelSpeed ?? AVALANCHE_SPEED).toFixed(0)} m/s)`);
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
      // Say when the answer rests on extrapolation: a dam taller than the surveyed transect (vertical walls assumed
      // above it), or a source at the profile's upstream end, where there is no valley in the file to pond.
      const sec = file.sections[node];
      if (H > sec.stage[sec.stage.length - 1] - file.zBed[node]) notes.push('warning: the dam is taller than the surveyed valley section — its height and the impoundment are extrapolated');
      if (imp.length < 2 * (file.s[1] - file.s[0])) notes.push('warning: no valley upstream of the impact in the profile — the impoundment is not represented; consider mode directFlow');
      if (!Number.isFinite(fill)) return { series: zeroSeries(), info: info(0, false, { runout: ro, dam: { height: H, impounded: imp.volume, fillTime: fill } }), extraBase: 0 };
      // The river's own baseflow keeps flowing in the routing while the lake fills (simplification: the dry river bed
      // below a blockage — itself a warning sign — is not modelled), so the breach ODE takes no inflow.
      return {
        series: b.series.shifted(travel + fill),
        info: info(ov.cv ?? 0, b.volume > 0, { runout: ro, travelTime: travel, dam: { height: H, impounded: imp.volume, fillTime: fill } }),
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
  const law = ov.routing?.resistance ?? spec.routing?.resistance;
  const src = sourceOf(spec.trigger, file, ov, base, law);
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
    tributaries: ov.tributaries ?? spec.routing?.tributaries?.map((t) => ({ s: t.s, q: t.q })),
    probes,
    entryS: file.domainEntry.s,
    // A run without a flood still routes an hour so the entry shows the (raised) baseflow.
    ...(src.info.flood ? {} : { tEnd: 3600 }),
    ...(spec.routing?.resistance ? { resistance: spec.routing.resistance } : {}),
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

  // Above a sliding block's handover the routed river carries no flood: what passes there is the mass itself. Those
  // stations read the block's passage as their front and the debris flow's peak (the surge's Qp) as their peak.
  const sl = src.info.slide;
  if (sl) {
    for (const st of stations) {
      if (!(st.s < sl.sHand)) continue;
      const tf = slideTimeAt(sl, st.s);
      if (!Number.isFinite(tf)) continue;
      st.tFront = tf;
      st.tPeak = tf + (sourcePeak.t - sl.tHand);
      st.qPeak = sourcePeak.q;
      st.cv = src.info.cv;
    }
  }

  // Say why a flood has no front at the map edge rather than leave a bare NaN: the routing's time limit (it counts
  // from the first outflow, so a slow-filling dam is routed in full) or a flood that dies out before the edge.
  if (src.info.flood && r.timedOut) {
    const lim = ov.routing?.tMax ?? ROUTING_T_MAX;
    src.info.notes.push(`warning: the routing stopped at its ${lim >= 3600 ? `${Math.round(lim / 3600)} h` : `${Math.round(lim / 60)} min`} limit after the first outflow, before the flood had passed — later arrivals and the recession are cut off`);
  }
  if (src.info.flood && !Number.isFinite(entryFront)) {
    src.info.notes.push(r.timedOut ? 'the flood had not reached the map edge when the routing stopped' : 'the flood attenuated to the river’s own fluctuation before the map edge: no front arrives there');
  }

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
    routing: { steps: r.steps, nodeSteps: r.nodeSteps, ms: r.ms, tEnd: r.tEnd, timedOut: r.timedOut, capped: r.capped, uPeak: r.uPeak, massBalance: r.massBalance, dx: ov.routeDx ?? ROUTING_DX },
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
 * Grid of the ensemble members, m. The baked 100 m: with the quiescent-reach window, the exact per-node CFL step and
 * the early stop below, a member on the full grid costs what a 250 m member used to — and a coarser member is not
 * the same model: on Nepal's DEM profile 250 m members ran the front ~15 % faster than the 100 m deterministic run,
 * so their band did not bracket it.
 */
export const MEMBER_DX = ROUTING_DX;
/**
 * A member stops once the flood at the furthest station is back under half its peak excess and the valley holds less
 * than half the most flood water it held (routing.ts stopFraction): every front and peak is behind it by then, and a
 * member reports nothing else. The deterministic run keeps the full recession — its entry hydrograph is the 2-D inflow.
 */
export const MEMBER_STOP_FRACTION = 0.5;

/**
 * The 3 × 3 × 3 ensemble of spec §I.5 — volume lo/median/hi × erosion rate 10/30/100 m/h × source Cv 0/0.2/0.4 —
 * collapsing dimensions a trigger does not have (a given hydrograph has no volume band or erosion rate). Members are
 * routed on MEMBER_DX and stop early (MEMBER_STOP_FRACTION); the deterministic result is routed on the baked grid to
 * the end of the recession. Members are equally weighted; p10/p50/p90 interpolate between order statistics, with
 * "never arrived" as +∞.
 */
export function runEnsemble(
  spec: HazardChainSpec,
  file: ChainFile,
  overrides: ChainOverrides = {},
  opts: { memberDx?: number; stopFraction?: number; onProgress?: (done: number, total: number) => void } = {},
): EnsembleResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const result = runChain(spec, file, overrides);
  const vfs = volumeFactors(spec.trigger);
  const ks = erosionRates(spec.trigger);
  const cvs = spec.trigger.kind === 'meltAnomaly' ? [0] : [...CV_ENSEMBLE];
  const memberDx = opts.memberDx ?? MEMBER_DX;
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
          routing: { stopFraction: opts.stopFraction ?? MEMBER_STOP_FRACTION, ...overrides.routing },
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

/** Bins at the end of the routed entry series whose mean slope is the recession rate the tail ramp continues. */
export const RECESSION_FIT_BINS = 10;
/** Bounds on the tail ramp to baseflow, s: at least one 10-minute step, at most 6 h. */
export const RAMP_MIN_S = 600;
export const RAMP_MAX_S = 6 * 3600;

/**
 * The tail after the routed entry series: where it ends (2-D clock), its discharge there, and the linear ramp from that
 * down to the entry baseflow. The routing stops once the flood has passed (stopFraction), so its last bin can still be
 * well above baseflow (Nepal's ends at ~370 against 100 m³/s); held flat, as the forcing holds a hydrograph's last
 * value, that excess would flow FOREVER. The ramp continues the series' own recession — the mean slope over its last
 * RECESSION_FIT_BINS bins — until it reaches the baseflow: duration (q_end − q_base) / slope, clamped to
 * [RAMP_MIN_S, RAMP_MAX_S] (RAMP_MAX_S when the series is not receding). A linear ramp at the current slope carries
 * half the excess an exponential recession at the same rate would (q_excess² / slope), so it is the conservative tail,
 * and it is finite: (q_end − q_base)·T/2 above baseflow. null when the series already ends at (or under) baseflow.
 */
export function recessionRamp(entry: ReadonlyArray<{ t: number; q: number }>, base: number, qEnd: number): { seconds: number; excessVolume: number } | null {
  if (!(qEnd > base * (1 + 1e-3) + 1e-6) || entry.length < 2) return null;
  const n = entry.length;
  const k = Math.max(0, n - 1 - RECESSION_FIT_BINS);
  const slope = (entry[k].q - entry[n - 1].q) / Math.max(1e-9, entry[n - 1].t - entry[k].t);
  const seconds = slope > 0 ? Math.min(RAMP_MAX_S, Math.max(RAMP_MIN_S, (qEnd - base) / slope)) : RAMP_MAX_S;
  return { seconds, excessVolume: 0.5 * (qEnd - base) * seconds };
}

/**
 * The routed hydrograph at the domain entry as the 2-D solver's inflow WaterSource, times shifted to the 2-D clock
 * (domainClockOffset). `discharge` is the peak (the label and the CFL estimate's fallback read it).
 *
 * VOLUME. The routed entry series is one mean discharge per sampling bin, exact in volume. As a piecewise-linear curve
 * through the bin centres (what src/sim/forcing.ts integrates), plus a point holding the last bin's value to the end
 * of that bin, its area differs by the curvature within bins, so these points are rescaled — by a factor within ~1e-3
 * of 1 — to deliver EXACTLY the routed volume after the offset, through the end of the routed series. After that the
 * curve ramps linearly down to the entry baseflow (recessionRamp: the series' own recession rate, ≤ 6 h, a finite and
 * stated extra volume), and the forcing then holds that last point: the river keeps its baseflow, and nothing more.
 */
export function toWaterSource(result: ChainRunResult, file: ChainFile, opts: WaterSourceOptions = {}): Extract<WaterSource, { type: 'inflow' }> {
  const off = domainClockOffset(result, opts);
  const e = result.entry;
  const pts: Array<{ t: number; q: number }> = [];
  // Exact routed volume after the offset: whole bins after it plus the part of the straddling bin. The bins tile the
  // run from t = 0 and each point sits at its bin's centre, so every edge follows from the one before — including the
  // last bin's, which is short when the run stopped mid-bin (routing.ts).
  let exact = 0;
  let edge = 0;
  for (const p of e) {
    const a = edge;
    const b = (edge = Math.max(a, 2 * p.t - a));
    if (b <= off) continue;
    exact += p.q * (b - Math.max(a, off));
  }
  const seriesEnd = edge;
  // Q at the offset, interpolated, then every bin centre after it.
  const at = (t: number): number => {
    if (e.length === 0) return 0;
    if (t <= e[0].t) return e[0].q;
    for (let i = 1; i < e.length; i++) if (e[i].t >= t) return e[i - 1].q + ((e[i].q - e[i - 1].q) * (t - e[i - 1].t)) / (e[i].t - e[i - 1].t);
    return e[e.length - 1].q;
  };
  pts.push({ t: 0, q: at(off) });
  for (const p of e) if (p.t > off) pts.push({ t: p.t - off, q: p.q });
  // The last bin's value held to the end of that bin: the routed series' own span, explicit.
  const last = pts[pts.length - 1];
  const tSeriesEnd = Math.max(last.t, seriesEnd - off);
  if (tSeriesEnd > last.t + 1e-9) pts.push({ t: tSeriesEnd, q: last.q });
  // Area of the piecewise-linear curve over the same span.
  let area = 0;
  for (let i = 1; i < pts.length; i++) area += 0.5 * (pts[i].q + pts[i - 1].q) * (pts[i].t - pts[i - 1].t);
  const f = area > 0 && exact > 0 ? exact / area : 1;
  const hydrograph = pts.map((p) => ({ t: p.t, q: p.q * f }));
  // Then down to baseflow, which the forcing holds from there on (see recessionRamp).
  const qEnd = hydrograph[hydrograph.length - 1].q;
  const ramp = recessionRamp(e, result.entryBase, qEnd);
  if (ramp) hydrograph.push({ t: hydrograph[hydrograph.length - 1].t + ramp.seconds, q: result.entryBase });
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
