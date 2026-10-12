/**
 * The flood front's arrival time ALONG the valley profile, not only at the named stations — what the early-warning
 * designer (src/hazard/warning.ts) needs to place a sensor anywhere on the river.
 *
 * How (additive, no change to the router): the run gets extra probes — pseudo-stations every `spacing` metres between
 * the source and the furthest point anyone already reads (the last station or the domain entry). Probes only record;
 * they do not change the flow, and since none lies beyond the furthest existing probe the router's "flood has passed"
 * stop is unchanged, so the run's station results are bit-identical to runChain's. Each probe is read with the same
 * front rule as a station (routing.ts readProbe), so a sensor placed at a town reads the town's own front.
 *
 * Cost: each probe stores Q, stage and Cv per step (24 B); the default 1 km spacing on the 54 km Nepal profile is ~60
 * probes, a few tens of MB transient in the worker for a full-resolution run, ~10 % more CPU. The augmented file is
 * cached per input file so the router's prepared network is reused across what-if runs.
 */
import type { ChainFile, ChainStation, HazardChainSpec } from './types';
import { runChain, sourceChainage, type ChainOverrides, type ChainRunResult } from './chain';

/** Front arrival along the profile: chainage (m, ascending) and front time (s after clock zero; NaN = never). */
export interface FrontProfile {
  s: number[];
  t: number[];
}

/** Prefix of the pseudo-stations' names (never shown: they are stripped from the result). */
const PROBE_PREFIX = '__front__';
/** Default spacing of the profile probes, m. */
export const FRONT_PROFILE_SPACING = 1000;

const augmented = new WeakMap<ChainFile, { spacing: number; file: ChainFile; count: number }>();

/** The chainages the profile probes sit at: every `spacing` m from the source to the furthest station / the entry. */
export function profileProbeChainages(file: ChainFile, spacing = FRONT_PROFILE_SPACING): number[] {
  const s0 = sourceChainage(file);
  const sMax = Math.max(file.domainEntry.s, ...file.stations.map((st) => st.s));
  const out: number[] = [];
  if (!(spacing > 0) || !(sMax > s0)) return out;
  for (let s = s0 + spacing; s < sMax - 1; s += spacing) out.push(s);
  return out;
}

/** The file with the profile probes appended to its stations (cached; the stations' order is kept, probes last). */
function withProbes(file: ChainFile, spacing: number): { file: ChainFile; count: number } {
  const c = augmented.get(file);
  if (c && c.spacing === spacing) return c;
  const near = file.lonlat?.length ? file.lonlat : null;
  const extra: ChainStation[] = profileProbeChainages(file, spacing).map((s, k) => {
    const i = Math.max(0, Math.min(file.s.length - 1, file.s.findIndex((x) => x >= s)));
    const ll = near ? near[i] : [0, 0];
    return { s, name: `${PROBE_PREFIX}${k}`, kind: 'gauge', lat: ll[1], lon: ll[0] };
  });
  const entry = { spacing, file: { ...file, stations: [...file.stations, ...extra] }, count: extra.length };
  augmented.set(file, entry);
  return entry;
}

/**
 * runChain plus the front-arrival profile. The result is runChain's (the pseudo-stations removed) with
 * `frontProfile` set: the source, every station and every probe, sorted by chainage.
 */
export function runChainWithProfile(spec: HazardChainSpec, file: ChainFile, overrides: ChainOverrides = {}, spacing = FRONT_PROFILE_SPACING): ChainRunResult {
  const { file: aug, count } = withProbes(file, spacing);
  const r = runChain(spec, aug, overrides);
  const n = r.stations.length - count;
  const probes = r.stations.slice(n);
  r.stations = r.stations.slice(0, n);
  if (r.leadTime) for (const p of probes) delete r.leadTime[p.name];
  const pts: Array<{ s: number; t: number }> = [...r.stations, ...probes].map((st) => ({ s: st.s, t: st.tFront }));
  if (Number.isFinite(r.entryFront)) pts.push({ s: file.domainEntry.s, t: r.entryFront });
  pts.sort((a, b) => a.s - b.s || a.t - b.t);
  r.frontProfile = { s: pts.map((p) => p.s), t: pts.map((p) => p.t) };
  return r;
}
