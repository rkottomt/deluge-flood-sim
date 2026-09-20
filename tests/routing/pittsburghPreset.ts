/**
 * The shipped Pittsburgh preset prepared for routing checks without a GPU, plus the places the checks name.
 * Everything general lives in presetWorld.ts (any preset, same bathtub); this file is the Pittsburgh-specific part.
 *
 * Used by pittsburgh.test.ts (files read from disk) and by the visual harness (?data=pgh, fetched).
 */
import type { PresetMeta } from '../../src/data/presets';
import type { CompactRoads } from '../../src/data/roads';
import { presetWorld, type PresetWorld } from './presetWorld';

export { mark } from './presetWorld';

/** A PresetWorld that is known to have a stage control, so `pool` is a number. */
export interface PittsburghWorld extends Omit<PresetWorld, 'pool'> {
  /** Normal pool water surface, m (stage offset 0). */
  pool: number;
}

/** Places used by the checks. */
export const PLACES = {
  /** Downtown, a block east of Market Square — on the Point, which floods first. */
  downtown: { lon: -80.0018, lat: 40.4413 },
  /** North Shore by PNC Park — on the Allegheny's flood plain. */
  northShore: { lon: -80.0057, lat: 40.4474 },
} as const;

export function pittsburghWorld(meta: PresetMeta, elevationBytes: ArrayBuffer, roads: CompactRoads): PittsburghWorld {
  const world = presetWorld(meta, elevationBytes, roads);
  if (world.pool === null) throw new Error('pittsburgh preset has no stage control');
  return { ...world, pool: world.pool };
}
