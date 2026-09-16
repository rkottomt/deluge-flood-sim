import type { RoadClass } from '../contracts';

/** Depth (m) at or above which a road counts as wet: passable, but slowly. */
export const WET_DEPTH = 0.05;
/**
 * Depth (m) at or above which a road is flooded and impassable. Roughly where passenger cars start
 * to float; 15 cm of moving water can already knock a person over.
 */
export const FLOODED_DEPTH = 0.3;

/** Road status codes (RoadStatusArray values). */
export const STATUS_DRY = 0;
export const STATUS_WET = 1;
export const STATUS_FLOODED = 2;

/** Free-flow driving speeds by road class, m/s. */
export const SPEED_BY_CLASS: Readonly<Record<RoadClass, number>> = {
  highway: 25,
  major: 15,
  minor: 11,
  local: 8,
};

/** Speed multiplier on wet roads. */
export const WET_SPEED_FACTOR = 0.3;

/** Numeric class codes stored per edge (index into CLASS_SPEEDS). */
export const CLASS_CODE: Readonly<Record<RoadClass, number>> = { highway: 0, major: 1, minor: 2, local: 3 };
export const CLASS_SPEEDS = new Float64Array([
  SPEED_BY_CLASS.highway,
  SPEED_BY_CLASS.major,
  SPEED_BY_CLASS.minor,
  SPEED_BY_CLASS.local,
]);

/**
 * Bridges. A road stretch over standing water (water present in the baseline field) is a bridge span. Its
 * approaches are usually elevated too (TIGER roads carry no grade separation and the DEM is bare earth under
 * viaducts), so samples within APPROACH_FRACTION × span length of the span, capped at MAX_APPROACH_M, are also
 * ignored. Long river bridges thus stay open until the water reaches their landings; short creek crossings get
 * only a few metres of allowance.
 */
export const APPROACH_FRACTION = 0.5;
export const MAX_APPROACH_M = 150;

/** Maximum distance (m) from the start / a shelter to the road it is snapped onto. */
export const SNAP_RADIUS_M = 300;
/** Number of nearest eligible road edges considered when snapping a point onto the network. */
export const START_CANDIDATES = 6;
export const SHELTER_CANDIDATES = 4;

/**
 * Speed (m/s) for the short off-network leg between a point (house / shelter) and the road it snaps to.
 * Walking pace: it strongly prefers the nearest usable street but still lets the route fall back to a
 * slightly farther one when the nearest is a disconnected fragment.
 */
export const CONNECTOR_SPEED = 1.4;
