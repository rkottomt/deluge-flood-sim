/**
 * "Will this wall hold?" — pure helpers behind the wall tool's live check, its cursor colour and the
 * overtopping notices. In the solver the bed is ground + barrier, so a wall holds back water only while its
 * TOP (ground + height) stays above the water surface around it.
 */
import type { StageControl } from '../contracts';
import type { ProtectionSummary } from './bridge';
import { fmtNum } from './format';
import { stageFt } from './scales';

/** Freeboard added on top of the expected water surface when suggesting a height, m. */
export const WALL_FREEBOARD = 0.5;
/** Wall height range of the tool, m (AppState.wallHeight contract: 0.5 … 10). */
export const WALL_MIN = 0.5;
export const WALL_MAX = 10;
/** Depth on top of a wall cell that counts as overtopping, m. */
export const OVERTOP_DEPTH = 0.1;
/** Wall cells that must be overtopped (or below the river) before the card and the notices call a wall too low. */
export const WALL_ALARM_CELLS = 3;
/** Barrier height below which a cell is not considered part of a wall, m. */
const WALL_CELL_MIN = 0.2;
/** A wall cell lower than a neighbouring wall cell by more than this is on the wall's sloping rim, not its crest, m. */
const CREST_TOLERANCE = 0.05;

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
  /** Cells that carry a wall (its crest cells when scanned with nx). */
  cells: number;
  /** Wall cells with water standing on top (overtopped right now). */
  overtopped: number;
  /** Wall cells whose top is below `level`. */
  belowLevel: number;
  /**
   * Height (with freeboard) that would lift 90 % of the wall cells below `level` clear of it, m. A percentile
   * rather than the maximum, so one cell dipping into the river channel doesn't demand a 10 m wall.
   */
  neededHeight: number;
  /** Cheap fingerprint of the barrier field (changes when walls are drawn or erased). */
  signature: number;
}

const NEED_BIN_M = 0.25;
const NEED_BINS = 48;

/**
 * One pass over the barrier field (row-major nx*ny). ~1 ms for a million cells.
 *
 * With `nx`, only a wall's crest cells are judged (barrier at least as high as its four neighbours'): a wall stroke
 * tapers to the ground over its outer cell, and that sloping rim stands in the water beside even a wall that holds.
 */
export function scanWalls(ground: Float32Array, barrier: Float32Array, depth: Float32Array | null, level: number | null, nx?: number): WallScan {
  let cells = 0;
  let overtopped = 0;
  let belowLevel = 0;
  let sig = 0;
  const bins = new Uint32Array(NEED_BINS);
  const n = Math.min(ground.length, barrier.length);
  const useDepth = depth && depth.length >= n ? depth : null;
  const w = nx && nx > 0 && n % nx === 0 ? nx : 0;
  for (let k = 0; k < n; k++) {
    const b = barrier[k];
    if (!(b > WALL_CELL_MIN)) continue;
    sig = (sig + b * ((k % 997) + 1)) % 1e9;
    if (w) {
      const i = k % w;
      const top = b + CREST_TOLERANCE;
      if ((i > 0 && barrier[k - 1] > top) || (i < w - 1 && barrier[k + 1] > top) || (k >= w && barrier[k - w] > top) || (k + w < n && barrier[k + w] > top)) {
        continue;
      }
    }
    cells++;
    if (useDepth && useDepth[k] > OVERTOP_DEPTH) overtopped++;
    if (level !== null) {
      const g = ground[k];
      if (g + b < level) {
        belowLevel++;
        const need = level + WALL_FREEBOARD - g;
        bins[Math.min(NEED_BINS - 1, Math.max(0, Math.ceil(need / NEED_BIN_M) - 1))]++;
      }
    }
  }
  let neededHeight = 0;
  if (belowLevel) {
    const target = Math.ceil(belowLevel * 0.9);
    let acc = 0;
    for (let b = 0; b < NEED_BINS; b++) {
      acc += bins[b];
      if (acc >= target) {
        neededHeight = (b + 1) * NEED_BIN_M;
        break;
      }
    }
  }
  return { cells, overtopped, belowLevel, neededHeight, signature: cells * 1e6 + sig };
}

/** "225.4 m (46 ft)" for the stage level a check refers to. */
export function describeSurface(ctrl: StageControl | null | undefined, offset: number): string {
  const s = stageSurface(ctrl, offset);
  if (s === null || !ctrl) return '';
  return `${s.toFixed(1)} m · ${stageFt(ctrl, offset).toFixed(0)} ft`;
}

/**
 * The drawn walls against the water, from the latest scan (tools.ts publishes it on the UI bridge). The options
 * card and the overtopping notices both describe THIS, so they can't disagree; the cursor check is only a preview
 * of a wall not yet built.
 */
export interface WallStatus {
  /** Wall cells on the map. */
  cells: number;
  /** Wall cells with water on top; 0 until the water around a new wall has settled. */
  overtopped: number;
  /** Wall cells whose top is below the river stage (0 without a stage control). */
  belowLevel: number;
  /** Wall height (with freeboard) that would lift most of the too-low wall clear of the river, m (0 = none needed). */
  neededHeight: number;
  /** False right after a wall was drawn or the water was reset (water standing on it is not overtopping yet). */
  settled: boolean;
  /** River stage in ft when the scenario has a stage control. */
  stageFt: number | null;
}

export interface WallVerdict {
  state: 'ok' | 'low' | 'wait';
  text: string;
  /** Suggested wall height for a one-click fix, m (null = none). */
  fix: number | null;
}

/** Share of the wall, %, as the notices phrase it (at least 1 %). */
export function wallShare(part: number, cells: number): number {
  return cells > 0 ? Math.max(1, Math.round((part / cells) * 100)) : 0;
}

/** Height to suggest after a too-low verdict, rounded up to 0.5 m and clamped to the tool's range (null when not higher). */
export function suggestedWallHeight(status: Pick<WallStatus, 'belowLevel' | 'neededHeight'>, wallHeight: number): number | null {
  if (!(status.belowLevel > 0) || !(status.neededHeight > 0)) return null;
  const need = Math.min(WALL_MAX, Math.ceil(status.neededHeight * 2) / 2);
  return need > wallHeight ? need : null;
}

/** Verdict on the walls already built (null when there are none). Overtopping (what is happening) wins over the stage. */
export function wallVerdict(status: WallStatus | null, wallHeight: number): WallVerdict | null {
  if (!status || status.cells <= 0) return null;
  const fix = suggestedWallHeight(status, wallHeight);
  if (status.settled && status.overtopped >= WALL_ALARM_CELLS) {
    return { state: 'low', text: `Your wall is overtopped: about ${wallShare(status.overtopped, status.cells)}% of it is under water`, fix };
  }
  if (status.belowLevel >= WALL_ALARM_CELLS) {
    const at = status.stageFt !== null ? ` at ${Math.round(status.stageFt)} ft` : '';
    return { state: 'low', text: `Your wall is too low: ${wallShare(status.belowLevel, status.cells)}% of it is below the river${at}`, fix };
  }
  if (!status.settled) return { state: 'wait', text: 'Your wall is up — watching the water around it…', fix: null };
  return { state: 'ok', text: 'Your wall is holding: no water over the top', fix: null };
}

/** Hypothetical wording for the cursor check: a wall of the chosen height, not yet built, at the cursor. */
export function wallPreviewText(check: WallCheck | null, wallHeight: number, stageLevel: number | null): string {
  const h = `${wallHeight.toFixed(1)} m`;
  if (!check) {
    return stageLevel !== null ? `River at ${stageLevel.toFixed(1)} m — hover the map to test a ${h} wall` : `Hover water or a riverbank to test a ${h} wall`;
  }
  const what = check.source === 'river' ? 'the river' : 'the water here';
  const m = Math.abs(check.margin).toFixed(1);
  const surface = `${check.surface.toFixed(1)} m`;
  if (check.ok) return `A ${h} wall here would stand ${m} m above ${what} (${surface})`;
  if (check.tooLow) return `Here even a ${WALL_MAX} m wall would be under ${what} (${surface}) — build on higher ground`;
  return `A ${h} wall here would be ${m} m under ${what} (${surface})`;
}

/** Land kept dry by walls below this area is not worth a status line (a wall across a ditch), m². */
export const KEPT_MIN_M2 = 4000;

/** "Walls keep 141 acres dry · 11 km of streets" (null when they keep less than KEPT_MIN_M2 dry). */
export function keptStatus(p: ProtectionSummary | null): { text: string; tip: string } | null {
  if (!p || !(p.areaM2 >= KEPT_MIN_M2)) return null;
  const acres = p.areaM2 / 4046.8564224;
  const km2 = p.areaM2 / 1e6;
  const roadKm = p.roadMeters / 1000;
  const streets = roadKm >= 0.1 ? ` · ${fmtNum(roadKm, roadKm >= 10 ? 0 : 1)} km of streets` : '';
  return {
    text: `Walls keep ${fmtNum(acres, acres >= 100 ? 0 : 1)} acres dry${streets}`,
    tip:
      `${fmtNum(km2, 2)} km² of land (green on the map) would stand at least 0.3 m under water without your walls` +
      (p.level !== null ? `, with the water they hold back at ${fmtNum(p.level, 1)} m` : '') +
      '. A still-water estimate at the current level; it drops as water gets around or over a wall.',
  };
}
