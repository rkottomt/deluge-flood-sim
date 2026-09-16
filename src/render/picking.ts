/**
 * Ray ↔ heightfield intersection in world space against the exact rendered (finest-LOD) surface, see heightfield.ts:
 * a grid walk over the mesh quads the ray crosses with analytic ray–triangle tests (no sampling, no misses).
 */
import type { PickResult, SimSnapshot } from '../contracts';
import { HeightField } from './heightfield';
import { transformPoint4, type Vec3 } from './math';

export interface Ray {
  origin: Vec3;
  dir: Vec3; // normalized
}

/**
 * World-space ray through a CSS pixel given the inverse view-projection (reversed-Z). Float32 matrices lose
 * precision far from the origin; prefer cameraRay() when the camera basis is available.
 */
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

/** Pinhole camera description in double precision (see CameraMatrices). */
export interface CameraRayBasis {
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  fovY: number;
  aspect: number;
}

/** Exact (float64) world ray from the eye through a CSS pixel. */
export function cameraRay(cam: CameraRayBasis, cssX: number, cssY: number, cssW: number, cssH: number): Ray {
  const ndcX = (cssX / Math.max(1, cssW)) * 2 - 1;
  const ndcY = 1 - (cssY / Math.max(1, cssH)) * 2;
  const ty = Math.tan(cam.fovY / 2);
  const tx = ty * cam.aspect;
  const f = cam.forward;
  const r = cam.right;
  const u = cam.up;
  const dx = f[0] + r[0] * ndcX * tx + u[0] * ndcY * ty;
  const dy = f[1] + r[1] * ndcX * tx + u[1] * ndcY * ty;
  const dz = f[2] + r[2] * ndcX * tx + u[2] * ndcY * ty;
  const l = Math.hypot(dx, dy, dz) || 1;
  return { origin: [cam.eye[0], cam.eye[1], cam.eye[2]], dir: [dx / l, dy / l, dz / l] };
}

export interface HeightfieldHit {
  gx: number;
  gy: number;
  /** Surface elevation in meters (unexaggerated). */
  elevation: number;
  /** Distance along the ray (world units). */
  t: number;
}

/**
 * Intersect a world ray with the terrain surface. Returns null if it misses the domain.
 *
 * Exact: walks the mesh quads the ray crosses in order (2D DDA over the stride grid) and intersects the two
 * triangles of each quad analytically, so thin one-cell walls and grazing tangents are never skipped.
 */
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

  // Work in "quad units": x' = gx / stride, z' = gy / stride; y stays in world units.
  const s = hf.stride;
  const qs = cs * s; // world size of a quad
  const ox = (o[0] + halfX) / qs;
  const oz = (o[2] + halfZ) / qs;
  const dx = d[0] / qs;
  const dz = d[2] / qs;
  const maxK = hf.vx - 2;
  const maxL = hf.vy - 2;

  const entryX = ox + dx * t0;
  const entryZ = oz + dz * t0;
  let k = Math.min(Math.max(Math.floor(entryX), 0), maxK);
  let l = Math.min(Math.max(Math.floor(entryZ), 0), maxL);
  const stepK = dx > 0 ? 1 : -1;
  const stepL = dz > 0 ? 1 : -1;
  const tDeltaK = Math.abs(dx) > 1e-15 ? Math.abs(1 / dx) : Infinity;
  const tDeltaL = Math.abs(dz) > 1e-15 ? Math.abs(1 / dz) : Infinity;
  let tMaxK = Math.abs(dx) > 1e-15 ? t0 + ((dx > 0 ? k + 1 : k) - entryX) / dx : Infinity;
  let tMaxL = Math.abs(dz) > 1e-15 ? t0 + ((dz > 0 ? l + 1 : l) - entryZ) / dz : Infinity;

  const ex = exaggeration;
  const P = (kk: number, ll: number): [number, number, number] => [kk * qs - halfX, hf.corner(kk, ll) * ex, ll * qs - halfZ];
  const maxIter = hf.vx + hf.vy + 4;
  for (let iter = 0; iter < maxIter; iter++) {
    const A = P(k, l);
    const B = P(k + 1, l);
    const C = P(k, l + 1);
    const D = P(k + 1, l + 1);
    // Same split as the GPU mesh: triangles (a, c, b) and (b, c, d).
    let best = Infinity;
    const t1a = rayTriangle(o, d, A, C, B);
    if (t1a >= t0 - 1e-6 && t1a < best) best = t1a;
    const t2a = rayTriangle(o, d, B, C, D);
    if (t2a >= t0 - 1e-6 && t2a < best) best = t2a;
    if (best < Infinity) return hitAt(Math.max(best, 0));

    // Advance to the next quad along the ray.
    if (tMaxK < tMaxL) {
      if (tMaxK > t1) break;
      k += stepK;
      tMaxK += tDeltaK;
    } else {
      if (tMaxL > t1) break;
      l += stepL;
      tMaxL += tDeltaL;
    }
    if (k < 0 || l < 0 || k > maxK || l > maxL) break;
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

/** Möller–Trumbore, double-sided. Returns the ray parameter or Infinity. */
function rayTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const px = d[1] * e2z - d[2] * e2y;
  const py = d[2] * e2x - d[0] * e2z;
  const pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const tx = o[0] - a[0];
  const ty = o[1] - a[1];
  const tz = o[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  const eps = 1e-9;
  if (u < -eps || u > 1 + eps) return Infinity;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < -eps || u + v > 1 + eps) return Infinity;
  const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return t >= 0 ? t : Infinity;
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
