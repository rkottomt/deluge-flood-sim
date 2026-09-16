/**
 * CPU side of the brush edits: bounding rectangles, uniform packing and the CPU mirror of the ground /
 * barrier edits (identical math to shaders/brush.ts, so picking and routing see what the GPU sees).
 */
import type { BrushOp } from '../contracts';
import { MIN_FOOTPRINT_RADIUS } from './constants';
import { smoothstep } from './forcing';

export interface Rect {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

export const BRUSH_KIND = { wall: 0, eraseWall: 1, water: 2, terrain: 3 } as const;

export function brushRadius(op: BrushOp): number {
  const r = op.radius;
  return Math.max(Number.isFinite(r) ? r : 0, MIN_FOOTPRINT_RADIUS);
}

/** True if every numeric field of the op is finite (bad input is ignored rather than poisoning the GPU). */
export function brushOpValid(op: BrushOp): boolean {
  const vals: number[] = [op.radius];
  switch (op.kind) {
    case 'wall':
      vals.push(op.ax, op.ay, op.bx, op.by, op.height);
      break;
    case 'eraseWall':
      vals.push(op.ax, op.ay, op.bx, op.by);
      break;
    case 'water':
      vals.push(op.gx, op.gy, op.amount);
      break;
    case 'terrain':
      vals.push(op.gx, op.gy, op.delta);
      break;
    default:
      return false;
  }
  return vals.every((v) => Number.isFinite(v));
}

/** Cells possibly affected by the op, clipped to the grid; null if none. */
export function brushRect(op: BrushOp, nx: number, ny: number): Rect | null {
  const r = brushRadius(op);
  let minX: number, maxX: number, minY: number, maxY: number;
  if (op.kind === 'wall' || op.kind === 'eraseWall') {
    minX = Math.min(op.ax, op.bx);
    maxX = Math.max(op.ax, op.bx);
    minY = Math.min(op.ay, op.by);
    maxY = Math.max(op.ay, op.by);
  } else {
    minX = maxX = op.gx;
    minY = maxY = op.gy;
  }
  const pad = r + 1.5;
  const x0 = Math.max(0, Math.floor(minX - pad));
  const y0 = Math.max(0, Math.floor(minY - pad));
  const x1 = Math.min(nx, Math.ceil(maxX + pad));
  const y1 = Math.min(ny, Math.ceil(maxY + pad));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, w: x1 - x0, h: y1 - y0 };
}

export function capsuleDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const t = Math.min(1, Math.max(0, (pax * bax + pay * bay) / Math.max(bax * bax + bay * bay, 1e-8)));
  return Math.hypot(pax - bax * t, pay - bay * t);
}

export function falloff(d: number, r: number): number {
  if (d >= r) return 0;
  const t = d / r;
  const s = 1 - t * t;
  return s * s;
}

/**
 * Apply a ground/barrier edit to the CPU mirrors (water edits have no CPU mirror). Returns true if the
 * terrain (bed) may have changed.
 */
export function applyBrushCPU(
  op: BrushOp,
  rect: Rect,
  ground: Float32Array,
  barrier: Float32Array,
  nx: number,
): boolean {
  const r = brushRadius(op);
  for (let j = rect.y0; j < rect.y0 + rect.h; j++) {
    for (let i = rect.x0; i < rect.x0 + rect.w; i++) {
      const c = j * nx + i;
      const px = i + 0.5;
      const py = j + 0.5;
      switch (op.kind) {
        case 'wall': {
          const d = capsuleDist(px, py, op.ax, op.ay, op.bx, op.by);
          barrier[c] = Math.max(barrier[c], Math.max(0, op.height) * (1 - smoothstep(r, r + 1, d)));
          break;
        }
        case 'eraseWall': {
          const d = capsuleDist(px, py, op.ax, op.ay, op.bx, op.by);
          barrier[c] = barrier[c] * smoothstep(r, r + 1, d);
          break;
        }
        case 'terrain': {
          const d = Math.hypot(px - op.gx, py - op.gy);
          ground[c] = ground[c] + op.delta * falloff(d, r);
          break;
        }
        case 'water':
          return false;
      }
    }
  }
  return true;
}

/** Pack the Brush uniform (layout in shaders/brush.ts). */
export function packBrushUniform(op: BrushOp, rect: Rect, nx: number, ny: number, z0: number): ArrayBuffer {
  const buf = new ArrayBuffer(64);
  const iv = new Int32Array(buf);
  const fv = new Float32Array(buf);
  iv[0] = BRUSH_KIND[op.kind];
  iv[1] = nx;
  iv[2] = ny;
  iv[4] = rect.x0;
  iv[5] = rect.y0;
  iv[6] = rect.w;
  iv[7] = rect.h;
  if (op.kind === 'wall' || op.kind === 'eraseWall') {
    fv[8] = op.ax;
    fv[9] = op.ay;
    fv[10] = op.bx;
    fv[11] = op.by;
  } else {
    fv[8] = fv[10] = op.gx;
    fv[9] = fv[11] = op.gy;
  }
  fv[12] = brushRadius(op);
  fv[13] = op.kind === 'wall' ? Math.max(0, op.height) : op.kind === 'water' ? op.amount : op.kind === 'terrain' ? op.delta : 0;
  fv[14] = z0;
  return buf;
}
