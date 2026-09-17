/**
 * "Will this wall hold?" — pure helpers behind the wall tool's live check, its cursor colour and the
 * overtopping notices. In the solver the bed is ground + barrier, so a wall holds back water only while its
 * TOP (ground + height) stays above the water surface around it.
 */
import type { StageControl } from '../contracts';
import { stageFt } from './scales';

/** Freeboard added on top of the expected water surface when suggesting a height, m. */
export const WALL_FREEBOARD = 0.5;
/** Wall height range of the tool, m (AppState.wallHeight contract: 0.5 … 10). */
export const WALL_MIN = 0.5;
export const WALL_MAX = 10;
/** Depth on top of a wall cell that counts as overtopping, m. */
export const OVERTOP_DEPTH = 0.1;
/** Barrier height below which a cell is not considered part of a wall, m. */
const WALL_CELL_MIN = 0.2;

/** Water-surface elevation the river stage control currently asks for (at the gauge), m. */
export function stageSurface(ctrl: StageControl | null | undefined, offset: number): number | null {
  if (!ctrl) return null;
  return ctrl.normalLevel + Math.max(0, offset);
}

export interface WallCheckInput {
  /** Bare ground under the cursor, m. */
  ground: number;
  /** Existing wall at the cursor, m. */
  barrier: number;
  /** Current water depth at the cursor, m. */
  depth: number;
  /** Height of the wall about to be drawn, m. */
  wallHeight: number;
  /** River surface from the stage control, m (null when the scenario has none). */
  stageLevel: number | null;
  /** Stage in feet for the message, when known. */
  stageFt?: number | null;
}

export interface WallCheck {
  /** Water surface the wall has to hold back, m. */
  surface: number;
  /** Where that surface comes from. */
  source: 'river' | 'water';
  ground: number;
  /** Elevation of the new wall's top, m. */
  top: number;
  /** top − surface, m (negative = overtopped). */
  margin: number;
  /** Suggested height (surface + freeboard − ground), clamped to the tool's range. */
  suggested: number;
  /** Height needed exceeds what the tool can build. */
  tooLow: boolean;
  ok: boolean;
}

/**
 * Compare a planned wall with the water it must hold back: the river stage (stage scenarios) or the water
 * already standing here, whichever is higher. Null when there is nothing to compare with (dry, no stage).
 */
export function checkWall(i: WallCheckInput): WallCheck | null {
  if (!Number.isFinite(i.ground) || !Number.isFinite(i.wallHeight)) return null;
  const top = i.ground + Math.max(i.barrier, i.wallHeight);
  const local = i.depth > 0.05 && Number.isFinite(i.depth) ? i.ground + i.barrier + i.depth : null;
  let surface: number | null = null;
  let source: WallCheck['source'] = 'river';
  if (i.stageLevel !== null && Number.isFinite(i.stageLevel)) surface = i.stageLevel;
  if (local !== null && (surface === null || local > surface)) {
    surface = local;
    source = 'water';
  }
  if (surface === null) return null;
  const need = surface + WALL_FREEBOARD - i.ground;
  const margin = top - surface;
  return {
    surface,
    source,
    ground: i.ground,
    top,
    margin,
    suggested: Math.round(Math.min(WALL_MAX, Math.max(WALL_MIN, need)) * 10) / 10,
    tooLow: need > WALL_MAX,
    ok: margin >= 0,
  };
}

export interface WallScan {
  /** Cells that carry a wall. */
  cells: number;
  /** Wall cells with water standing on top (overtopped right now). */
  overtopped: number;
  /** Wall cells whose top is below `level`. */
  belowLevel: number;
  /** Largest height a wall cell below `level` would need to clear it with freeboard, m. */
  neededHeight: number;
  /** Cheap fingerprint of the barrier field (changes when walls are drawn or erased). */
  signature: number;
}

/** One pass over the barrier field (row-major nx*ny). ~1 ms for a million cells. */
export function scanWalls(ground: Float32Array, barrier: Float32Array, depth: Float32Array | null, level: number | null): WallScan {
  let cells = 0;
  let overtopped = 0;
  let belowLevel = 0;
  let needed = 0;
  let sig = 0;
  const n = Math.min(ground.length, barrier.length);
  const useDepth = depth && depth.length >= n ? depth : null;
  for (let k = 0; k < n; k++) {
    const b = barrier[k];
    if (!(b > WALL_CELL_MIN)) continue;
    cells++;
    sig = (sig + b * ((k % 997) + 1)) % 1e9;
    if (useDepth && useDepth[k] > OVERTOP_DEPTH) overtopped++;
    if (level !== null) {
      const g = ground[k];
      if (g + b < level) {
        belowLevel++;
        const need = level + WALL_FREEBOARD - g;
        if (need > needed) needed = need;
      }
    }
  }
  return { cells, overtopped, belowLevel, neededHeight: needed, signature: cells * 1e6 + sig };
}

/** "225.4 m (46 ft)" for the stage level a check refers to. */
export function describeSurface(ctrl: StageControl | null | undefined, offset: number): string {
  const s = stageSurface(ctrl, offset);
  if (s === null || !ctrl) return '';
  return `${s.toFixed(1)} m · ${stageFt(ctrl, offset).toFixed(0)} ft`;
}
