/**
 * The glacier hazard chain for the batch CLI, synchronously in Node: what src/app/hazardChain.ts does in a Web Worker
 * when a chain preset loads (nepal, chungthang, chamoli). Read the valley profile and the baked run's member
 * parameters, run the chain with them (times the future-climate lake growth), and replace the preset's entry inflow
 * with the routed hydrograph, clock offset as the app sets it — so the 2-D map is driven by the same wave.
 *
 * The chain's own 27-member ensemble is run only when an ensemble needs it (portfolio --members): its members are what
 * the 2-D ensemble perturbs the routed inflow with on a chain preset (src/loss/ensemble.ts chainDraw).
 */
import type { ScenarioPreset, WaterSource } from '../contracts';
import type { BakedChainResult, ChainFile } from '../hazard/types';
import { runEnsemble, toWaterSource, type ChainOverrides, type ChainRunResult } from '../hazard/chain';
import { runChainWithProfile } from '../hazard/frontProfile';
import { domainOffsetSync, isChainFile, replaceEntryInflow } from '../app/hazardChain';
import type { ChainEnsembleInput } from '../loss';

export interface ChainSetup {
  file: ChainFile;
  result: ChainRunResult;
  overrides: ChainOverrides;
  /** The scenario with the routed inflow in place of the preset's entry inflow. */
  scenario: ScenarioPreset;
  sources: WaterSource[];
  /** Id of the routed inflow source ('chain-inflow', as in the app). */
  sourceId: string;
  ms: number;
}

export const CHAIN_SOURCE_ID = 'chain-inflow';

/**
 * Run a preset's chain and drive its inflow. `readJson(file)` reads a file baked next to meta.json. `volumeFactor` is
 * the future-climate lake growth (1 = today).
 */
export function setupChain(scenario: ScenarioPreset, readJson: (file: string) => unknown, volumeFactor = 1): ChainSetup | null {
  const spec = scenario.hazardChain;
  if (!spec) return null;
  const t0 = performance.now();
  const raw = readJson(spec.profile);
  if (!isChainFile(raw)) throw new Error(`${spec.profile} is not a valley profile this version can read`);
  const file = raw;
  // The baked run's member parameters (hazardChain.ts loadBaked) under the climate's lake growth.
  const base: ChainOverrides = {};
  if (spec.result) {
    try {
      const baked = readJson(spec.result) as Partial<BakedChainResult> | null;
      const m = baked?.run?.member;
      if (m && Number.isFinite(m.volumeFactor) && m.volumeFactor > 0) base.volumeFactor = m.volumeFactor;
      if (m && m.erosionRate !== undefined && Number.isFinite(m.erosionRate) && m.erosionRate > 0) base.erosionRate = m.erosionRate;
      if (m && Number.isFinite(m.cv) && m.cv >= 0 && m.cv < 1) base.cv = m.cv;
    } catch {
      /* the app runs from the trigger's defaults then, too */
    }
  }
  const overrides: ChainOverrides = { ...base };
  if (volumeFactor !== 1) overrides.volumeFactor = (overrides.volumeFactor ?? 1) * volumeFactor;
  const result = runChainWithProfile(spec, file, overrides);
  const routed = toWaterSource(result, file, {
    offset: domainOffsetSync(result),
    id: CHAIN_SOURCE_ID,
    label: `Routed flood wave from upstream (${file.name}) — modelled by the 1-D hazard chain`,
  });
  const sources = replaceEntryInflow(scenario.sources, file.domainEntry, routed);
  return { file, result, overrides, scenario: { ...scenario, sources }, sources: sources.map((w) => ({ ...w })), sourceId: CHAIN_SOURCE_ID, ms: performance.now() - t0 };
}

/** The chain's own ensemble, as the 2-D ensemble borrows it (src/ui/ensemble.ts chainInput). */
export function chainEnsembleInput(scenario: ScenarioPreset, chain: ChainSetup): ChainEnsembleInput {
  const ens = runEnsemble(scenario.hazardChain!, chain.file, chain.overrides);
  return {
    det: { entryPeak: chain.result.entryPeak, entryFront: chain.result.entryFront },
    members: ens.members,
    band: ens.result.ensemble ?? null,
  };
}
