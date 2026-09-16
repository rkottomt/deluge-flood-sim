/**
 * Routing module — flood-aware evacuation routing over the road network (DESIGN.md §6).
 *
 *   const router = createRouter();
 *   router.setNetwork(terrain.roads, terrain.cellSize);
 *   router.setBaselineWater(initialWater, nx, ny);        // rivers at load are bridged, not "flooded"
 *   const status = router.updateFlood(snapshot.depth, snapshot.nx, snapshot.ny);   // 2–4 Hz
 *   const result = router.route(evacStart, shelters);
 */
export { createRouter } from './router';
export type { DelugeRouter } from './router';
export {
  FLOODED_DEPTH,
  WET_DEPTH,
  SPEED_BY_CLASS,
  WET_SPEED_FACTOR,
  SNAP_RADIUS_M,
  STATUS_DRY,
  STATUS_WET,
  STATUS_FLOODED,
} from './constants';
export { formatDistance, formatDuration } from './format';
