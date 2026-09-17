/**
 * The one-click demo levee ("Build a levee" on a scenario with ScenarioPreset.levee): plan its wall segments from the
 * ground under them, and raise them along the line a few at a time so the levee visibly goes up.
 */
import type { DemoLevee } from '../contracts';
import type { WallSegment } from './bridge';
import { WALL_MAX, WALL_MIN } from './wallCheck';

/** Longest wall piece, cells: short pieces follow the ground, so the crest stays level along the levee. */
const PIECE_CELLS = 5;

/**
 * Wall pieces along the levee polyline. Each piece is as tall as the lowest ground within its footprint needs to reach
 * the crest (rounded up to 10 cm, within the wall tool's range), so the top of the wall is at or above the crest along
 * its whole length.
 */
export function planLevee(levee: DemoLevee, ground: Float32Array, nx: number, ny: number, radiusCells: number): WallSegment[] {
  const out: WallSegment[] = [];
  const pts = levee.points;
  if (pts.length < 2 || ground.length < nx * ny) return out;
  const reach = Math.ceil(radiusCells) + 1;
  const lowest = (x: number, y: number, low: number) => {
    const i0 = Math.max(0, Math.floor(x) - reach);
    const i1 = Math.min(nx - 1, Math.floor(x) + reach);
    const j0 = Math.max(0, Math.floor(y) - reach);
    const j1 = Math.min(ny - 1, Math.floor(y) + reach);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) low = Math.min(low, ground[j * nx + i]);
    return low;
  };
  for (let k = 0; k + 1 < pts.length; k++) {
    const a = pts[k];
    const b = pts[k + 1];
    const len = Math.hypot(b.gx - a.gx, b.gy - a.gy);
    const pieces = Math.max(1, Math.ceil(len / PIECE_CELLS));
    for (let p = 0; p < pieces; p++) {
      const ax = a.gx + ((b.gx - a.gx) * p) / pieces;
      const ay = a.gy + ((b.gy - a.gy) * p) / pieces;
      const bx = a.gx + ((b.gx - a.gx) * (p + 1)) / pieces;
      const by = a.gy + ((b.gy - a.gy) * (p + 1)) / pieces;
      let low = Infinity;
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let t = 0; t <= steps; t++) low = lowest(ax + ((bx - ax) * t) / steps, ay + ((by - ay) * t) / steps, low);
      if (!Number.isFinite(low)) continue;
      const height = Math.min(WALL_MAX, Math.max(WALL_MIN, Math.ceil((levee.crest - low) * 10) / 10));
      out.push({ ax, ay, bx, by, height });
    }
  }
  return out;
}

/** Ground length of the levee, m. */
export function leveeLength(levee: DemoLevee, cellSize: number): number {
  let cells = 0;
  for (let k = 0; k + 1 < levee.points.length; k++) {
    cells += Math.hypot(levee.points[k + 1].gx - levee.points[k].gx, levee.points[k + 1].gy - levee.points[k].gy);
  }
  return cells * cellSize;
}

/**
 * Raise `segments` in order over about `seconds`, a few per animation frame. Resolves true once all are up, false if
 * `cancelled()` turned true first (e.g. the scene changed). Without requestAnimationFrame everything goes up at once.
 */
export function raiseAlong(
  segments: WallSegment[],
  build: (batch: WallSegment[]) => void,
  seconds: number,
  cancelled: () => boolean,
): Promise<boolean> {
  if (typeof requestAnimationFrame !== 'function' || seconds <= 0) {
    if (!cancelled()) build(segments);
    return Promise.resolve(!cancelled());
  }
  return new Promise((resolve) => {
    let done = 0;
    let t0 = -1;
    const frame = (t: number) => {
      if (cancelled()) return resolve(false);
      if (t0 < 0) t0 = t;
      const target = Math.min(segments.length, Math.ceil(((t - t0) / 1000 / seconds) * segments.length));
      if (target > done) {
        build(segments.slice(done, target));
        done = target;
      }
      if (done >= segments.length) return resolve(true);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
