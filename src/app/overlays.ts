import type { AppState, OverlayState, RoadStatusArray, ToolController } from '../contracts';

type Transient = ReturnType<ToolController['getTransientOverlay']>;
type WallPreview = OverlayState['wallPreview'];
type Cursor = OverlayState['cursor'];

export const NO_TRANSIENT: Transient = { wallPreview: null, cursor: null };

/**
 * Builds the renderer's OverlayState from app state + evac status + the active tool's transient overlay,
 * and reports whether anything changed since the last frame so `renderer.setOverlays` (which may upload
 * GPU buffers) is only called when needed.
 *
 * Store-owned fields are immutable (compared by identity). Tool transients may be mutated in place by
 * the tool controller, so they are compared against private copies.
 */
export class OverlayComposer {
  private last: OverlayState | null = null;
  private lastStatusVersion = -1;
  private lastWall: WallPreview = null;
  private lastCursor: Cursor = null;

  /** Force the next compose() to return a fresh overlay (scene change). */
  invalidate(): void {
    this.last = null;
  }

  /** Returns the new OverlayState if anything changed, otherwise null. */
  compose(
    state: AppState,
    roadStatus: RoadStatusArray | null,
    statusVersion: number,
    transient: Transient,
  ): OverlayState | null {
    const route = state.route;
    const next: OverlayState = {
      roadStatus,
      // 'blocked' may carry the route the flood cut (the renderer draws it red and pulsing); 'none' never has one.
      route: route && route.state !== 'none' ? route.polyline : null,
      routeState: route?.state ?? 'none',
      sources: state.sources,
      storms: state.storms,
      shelters: state.shelters,
      evacStart: state.evacStart,
      wallPreview: transient.wallPreview,
      cursor: transient.cursor,
    };
    const prev = this.last;
    const wallChanged = !sameWall(this.lastWall, next.wallPreview);
    const cursorChanged = !sameCursor(this.lastCursor, next.cursor);
    const changed =
      !prev ||
      wallChanged ||
      cursorChanged ||
      statusVersion !== this.lastStatusVersion ||
      prev.roadStatus !== next.roadStatus ||
      prev.route !== next.route ||
      prev.routeState !== next.routeState ||
      prev.sources !== next.sources ||
      prev.storms !== next.storms ||
      prev.shelters !== next.shelters ||
      prev.evacStart !== next.evacStart;
    if (!changed) return null;
    this.last = next;
    this.lastStatusVersion = statusVersion;
    if (wallChanged) this.lastWall = next.wallPreview && { ...next.wallPreview, pts: next.wallPreview.pts.slice() };
    if (cursorChanged) this.lastCursor = next.cursor && { ...next.cursor, color: [...next.cursor.color] };
    return next;
  }
}

function sameWall(copy: WallPreview, cur: WallPreview): boolean {
  if (!copy || !cur) return copy === cur;
  if (copy.height !== cur.height || copy.radius !== cur.radius || copy.pts.length !== cur.pts.length) return false;
  for (let k = 0; k < cur.pts.length; k++) if (copy.pts[k] !== cur.pts[k]) return false;
  return true;
}

function sameCursor(copy: Cursor, cur: Cursor): boolean {
  if (!copy || !cur) return copy === cur;
  return (
    copy.gx === cur.gx &&
    copy.gy === cur.gy &&
    copy.radius === cur.radius &&
    copy.color[0] === cur.color[0] &&
    copy.color[1] === cur.color[1] &&
    copy.color[2] === cur.color[2]
  );
}
