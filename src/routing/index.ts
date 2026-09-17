/**
 * Routing module — flood-aware evacuation routing over the road network (ARCHITECTURE.md §7).
 *
 *   const router = createRouter();
 *   router.setNetwork(terrain.roads, terrain.cellSize);
 *   router.setBaselineWater(initialWater, nx, ny);        // rivers at load are bridged, not "flooded"
 *   const status = router.updateFlood(snapshot.depth, snapshot.nx, snapshot.ny);   // 2–4 Hz
 *   const result = router.route(evacStart, shelters);    // message + structured via / wetMeters / reason / advice
 */
export { createRouter } from './router';
export type { DelugeRouter, DelugeRouteResult, RouteReason } from './router';
export {
  ROAD_FLOODED_DEPTH,
  ROAD_WET_DEPTH,
  SPEED_BY_CLASS,
  WET_SPEED_FACTOR,
  SNAP_RADIUS_M,
  STATUS_DRY,
  STATUS_WET,
  STATUS_FLOODED,
} from './constants';
