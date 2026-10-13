/**
 * Impact & loss layer ("Deluge for Business"): pure TypeScript, no DOM, no GPU — everything here runs in node:test.
 *
 *   curves.ts     JRC 2017 global depth–damage curves (+ unverified USACE curves behind a flag)
 *   region.ts     domain bounds → country (cost table) and continent (curves)
 *   value.ts      occupancy, storeys, replacement values, per-storey damage
 *   hazard.ts     AIDR H1–H6, FD2321 hazard rating, fast-water structural rule, downtime heuristic
 *   footprints.ts footprint → grid cells (cached per BuildingSet)
 *   access.ts     is each building's nearest road impassable at the peak (via src/routing)
 *   impact.ts     per-building metrics and the scenario summary from HazardFields
 *   portfolio.ts  the user's CSV of assets: parse, match to footprints, assess, export
 *   eal.ts        expected annual loss, benefit–cost ratio, mitigation unit costs
 *   bca.ts        a design's benefit–cost analysis: avoided EAL, PV, BCR with its range, FEMA BCA Toolkit rows
 *   fallback.ts   depth-only HazardFields from snapshots, for a solver without readHazardFields
 *   egress.ts     when every road route from a site to a shelter closes (router over the arrival-ordered flood)
 *   site.ts       site check: one planned building across a ladder of events, FFE, mitigation options, verdict, link
 *   ladders.ts    sourced event ladders (NWS categories, FEMA/NOAA frequency levels, historic crests) per preset
 *   ensemble.ts   flood-probability ensembles: Latin-hypercube perturbations, member forcing, p10/p50/p90, tallies
 *
 * analyze() below strings them together for the UI.
 */
import type { HazardFields, TerrainData } from '../contracts';
import type { HeightProfile } from '../data/buildings';
import { makeGeoToGrid } from '../data/geo';
import { buildAccessIndex, type AccessIndex } from './access';
import { footprintIndex, type FootprintIndex } from './footprints';
import { computeBuildingImpacts, type ImpactReport } from './impact';
import { assessPortfolio, matchAssets, type MatchedAsset, type PortfolioAsset, type PortfolioResult, type PortfolioSummary } from './portfolio';
import { regionForBounds, type Region } from './region';

export * from './curves';
export * from './region';
export * from './value';
export * from './hazard';
export * from './footprints';
export * from './access';
export * from './impact';
export * from './portfolio';
export * from './csv';
export * from './eal';
export * from './bca';
export * from './fallback';
export * from './egress';
export * from './egressTiming';
export * from './site';
export * from './ladders';
export * from './ensemble';

/**
 * Presets whose flood is debris-laden (a glacial-lake outburst): the heuristic dv × 1.5 rule applies by default
 * (hazard.ts). The user can switch it off. Chamoli is the debris flow of 7 Feb 2021 (O'Brien–Julien rheology at Cv 0.45).
 */
export const DEBRIS_FLOW_PRESETS: ReadonlySet<string> = new Set(['nepal', 'chamoli']);

export type AnalysisTerrain = Pick<TerrainData, 'nx' | 'ny' | 'cellSize' | 'bounds' | 'roads'> & Partial<Pick<TerrainData, 'buildings'>>;

export interface AnalysisInput {
  fields: HazardFields;
  terrain: AnalysisTerrain;
  velocityKnown: boolean;
  debrisFlow: boolean;
  /** s since reset. */
  alertTime?: number;
  portfolio?: readonly PortfolioAsset[] | null;
}

export interface Analysis {
  region: Region;
  heightProfile: HeightProfile;
  report: ImpactReport | null;
  portfolio: { results: PortfolioResult[]; summary: PortfolioSummary; matched: MatchedAsset[] } | null;
  footprints: FootprintIndex | null;
  /** Nearest-road access for any grid point in this flood (null without road data). */
  access: AccessIndex | null;
  /** CPU time of the analysis, ms. */
  elapsedMs: number;
}

export function analyze(input: AnalysisInput): Analysis {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { fields, terrain } = input;
  if (fields.nx !== terrain.nx || fields.ny !== terrain.ny) throw new Error('hazard fields do not match the terrain grid');
  const region = regionForBounds(terrain.bounds);
  const heightProfile: HeightProfile = region.iso === 'NP' ? 'nepal' : 'us';
  const set = terrain.buildings ?? null;
  const fp = set ? footprintIndex(set, terrain.nx, terrain.ny, terrain.cellSize) : null;
  const access = buildAccessIndex(terrain.roads ?? null, fields, terrain.cellSize);
  const opts = { region, heightProfile, debrisFlow: input.debrisFlow, alertTime: input.alertTime ?? 0, velocityKnown: input.velocityKnown };
  const report = set && fp ? computeBuildingImpacts(fields, set, fp, opts, access) : null;
  let portfolio: Analysis['portfolio'] = null;
  if (input.portfolio && input.portfolio.length) {
    const matched = matchAssets(input.portfolio, set, fp, terrain, makeGeoToGrid(terrain));
    const r = assessPortfolio(matched, fields, { region, set, fp, heightProfile, debrisFlow: input.debrisFlow, alertTime: input.alertTime, access });
    portfolio = { ...r, matched };
  }
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { region, heightProfile, report, portfolio, footprints: fp, access, elapsedMs: t1 - t0 };
}
