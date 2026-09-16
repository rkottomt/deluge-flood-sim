/**
 * Ray ↔ heightfield intersection in world space against the exact rendered surface (see heightfield.ts):
 * march along the ray at a fraction of a mesh cell, then refine the first crossing by bisection.
 */
import type { PickResult, SimSnapshot } from '../contracts';
import { HeightField } from './heightfield';
import { transformPoint4, type Vec3 } from './math';

export interface Ray {
  origin: Vec3;
  dir: Vec3; // normalized
}

/** Build a world-space ray through a CSS pixel given the inverse view-projection (reversed-Z). */
export function screenRay(cssX: number, cssY: number, cssW: number, cssH: number, invViewProj: ArrayLike<number>): Ray {
  const ndcX = (cssX / Math.max(1, cssW)) * 2 - 1;
  const ndcY = 1 - (cssY / Math.max(1, cssH)) * 2;
  // Reversed-Z: ndc z = 1 is the near plane, z = 0.5 a finite point further along the same ray.
  const a = transformPoint4(invViewProj, ndcX, ndcY, 1, 1);
  const b = transformPoint4(invViewProj, ndcX, ndcY, 0.5, 1);
  const p0: Vec3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
  const p1: Vec3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  const d: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { origin: p0, dir: [d[0] / l, d[1] / l, d[2] / l] };
}

export interface HeightfieldHit {
  gx: number;
  gy: number;
  /** Surface elevation in meters (unexaggerated). */
  elevation: number;
  /** Distance along the ray (world units). */
  t: number;
}

/** Intersect a world ray with the terrain surface. Returns null if it misses the domain. */
export function intersectHeightfield(ray: Ray, hf: HeightField, exaggeration: number): HeightfieldHit | null {
  const cs = hf.cellSize;
  const halfX = (hf.nx / 2) * cs;
  const halfZ = (hf.ny / 2) * cs;
  const yMin = hf.minElev * exaggeration - 1;
  const yMax = hf.maxElev * exaggeration + 1;
  const o = ray.origin;
  const d = ray.dir;

  // Slab test against the domain's bounding box.
  let t0 = 0;
  let t1 = Infinity;
  const lo = [-halfX, yMin, -halfZ];
  const hi = [halfX, yMax, halfZ];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < lo[a] || o[a] > hi[a]) return null;
      continue;
    }
    let ta = (lo[a] - o[a]) / d[a];
    let tb = (hi[a] - o[a]) / d[a];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta);
    t1 = Math.min(t1, tb);
    if (t0 > t1) return null;
  }

  const f = (t: number) => {
    const x = o[0] + d[0] * t;
    const z = o[2] + d[2] * t;
    const gx = x / cs + hf.nx / 2;
    const gy = z / cs + hf.ny / 2;
    return o[1] + d[1] * t - hf.heightAt(gx, gy) * exaggeration;
  };

  // March at ≤ 0.35 mesh cells horizontally (thin one-cell walls can't be skipped); vertical steps are
  // additionally limited so steep look-down rays don't take huge jumps.
  const horiz = Math.hypot(d[0], d[2]);
  const cellWorld = cs * hf.stride * 0.35;
  const step = Math.max(cellWorld / Math.max(horiz, 1e-3), 1e-3);
  let tPrev = t0;
  let fPrev = f(t0);
  if (fPrev <= 0) {
    // Origin already below the surface at entry (camera inside terrain): report the entry point.
    return hitAt(t0);
  }
  const maxSteps = 200000;
  for (let n = 0; n < maxSteps && tPrev < t1; n++) {
    const tCur = Math.min(tPrev + step, t1);
    const fCur = f(tCur);
    if (fCur <= 0) {
      let a = tPrev;
      let b = tCur;
      for (let k = 0; k < 40; k++) {
        const m = 0.5 * (a + b);
        if (f(m) > 0) a = m;
        else b = m;
      }
      return hitAt(0.5 * (a + b));
    }
    tPrev = tCur;
    fPrev = fCur;
  }
  return null;

  function hitAt(t: number): HeightfieldHit {
    const x = o[0] + d[0] * t;
    const z = o[2] + d[2] * t;
    const gx = Math.min(Math.max(x / cs + hf.nx / 2, 0), hf.nx);
    const gy = Math.min(Math.max(z / cs + hf.ny / 2, 0), hf.ny);
    return { gx, gy, elevation: hf.heightAt(gx, gy), t };
  }
}

/** Full PickResult (adds water depth from the latest snapshot, nearest cell). */
export function pickTerrain(
  ray: Ray,
  hf: HeightField,
  exaggeration: number,
  snapshot: SimSnapshot | null,
): PickResult | null {
  const hit = intersectHeightfield(ray, hf, exaggeration);
  if (!hit) return null;
  let depth = 0;
  if (snapshot && snapshot.nx === hf.nx && snapshot.ny === hf.ny) {
    const v = snapshot.depth[hf.cellIndex(hit.gx, hit.gy)];
    depth = Number.isFinite(v) ? Math.max(0, v) : 0;
  }
  return { gx: hit.gx, gy: hit.gy, elevation: hit.elevation, depth };
}

/** Horizontal-plane intersection (used for panning). Returns null when the ray is parallel/away. */
export function intersectPlaneY(ray: Ray, y: number): Vec3 | null {
  if (Math.abs(ray.dir[1]) < 1e-6) return null;
  const t = (y - ray.origin[1]) / ray.dir[1];
  if (t <= 0) return null;
  return [ray.origin[0] + ray.dir[0] * t, y, ray.origin[2] + ray.dir[2] * t];
}
