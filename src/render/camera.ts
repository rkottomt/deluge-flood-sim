/**
 * OrbitController — damped orbit/pan/zoom camera with fly-to animation, mouse + touch input, terrain
 * clearance and reversed-Z infinite projection.
 *
 * Pose conventions (contracts.ts): yaw 0 looks north (−Z), increasing clockwise toward east (+X);
 * pitch is the angle below the horizon at which the camera looks down at the target (π/2 = top-down).
 */
import type { CameraController, CameraPose } from '../contracts';
import { clamp, mat4Invert, mat4Multiply, perspectiveReversedInfinite, v3, viewFromBasis, type Mat4, type Vec3 } from './math';
import { cameraRay, intersectPlaneY, type Ray } from './picking';

export const CAMERA_FOV_Y = (42 * Math.PI) / 180;
/** Absolute lowest pitch: street-level close-ups of a wall. */
const MIN_PITCH = 0.035;
/** Lowest pitch once the camera is far out (≥ half the domain away): anything lower only shows the nearest hill. */
const FAR_MIN_PITCH = 0.2;
/** Lowest pitch with the eye well outside the diorama (it would look at the terrain block's side wall). */
const OUTSIDE_MIN_PITCH = 0.42;
const MAX_PITCH = Math.PI / 2;

/** Scene information the controller needs (supplied by the renderer). */
export interface CameraEnvironment {
  nx: number;
  ny: number;
  cellSize: number;
  exaggeration: number;
  minElev: number;
  maxElev: number;
  /** Rendered terrain elevation (m, unexaggerated) at grid coords, or null without a scene. */
  heightAt(gx: number, gy: number): number | null;
  /** Terrain hit under a CSS pixel for the given camera matrices (zoom-to-cursor). */
  pickWorld(cssX: number, cssY: number): { gx: number; gy: number; elevation: number } | null;
}

export interface CameraMatrices {
  view: Mat4;
  proj: Mat4;
  viewProj: Mat4;
  invViewProj: Mat4;
  eye: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  near: number;
  fovY: number;
  aspect: number;
}

const clonePose = (p: CameraPose): CameraPose => ({
  target: { gx: p.target.gx, gy: p.target.gy, elevation: p.target.elevation },
  distance: p.distance,
  yaw: p.yaw,
  pitch: p.pitch,
});

const samePose = (a: CameraPose, b: CameraPose) =>
  a.target.gx === b.target.gx &&
  a.target.gy === b.target.gy &&
  a.target.elevation === b.target.elevation &&
  a.distance === b.distance &&
  a.yaw === b.yaw &&
  a.pitch === b.pitch;

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function sanitize(p: CameraPose, fallback: CameraPose): CameraPose {
  const ok = (x: number) => Number.isFinite(x);
  return {
    target: {
      gx: ok(p.target?.gx) ? p.target.gx : fallback.target.gx,
      gy: ok(p.target?.gy) ? p.target.gy : fallback.target.gy,
      elevation: ok(p.target?.elevation) ? p.target.elevation : fallback.target.elevation,
    },
    distance: ok(p.distance) && p.distance > 0 ? p.distance : fallback.distance,
    yaw: ok(p.yaw) ? p.yaw : fallback.yaw,
    pitch: clamp(ok(p.pitch) ? p.pitch : fallback.pitch, MIN_PITCH, MAX_PITCH),
  };
}

interface Flight {
  from: CameraPose;
  to: CameraPose;
  t: number;
  duration: number;
  arc: number;
}

interface DragState {
  mode: 'orbit' | 'pan';
  pointerId: number;
  lastX: number;
  lastY: number;
  /** Pan: grabbed world point and the pose/matrices at grab time. */
  grab?: Vec3;
  grabPose?: CameraPose;
}

export class OrbitController implements CameraController {
  leftDragOrbits = true;
  /** Damping rate (1/s): higher = snappier. */
  damping = 14;

  private cur: CameraPose;
  private goal: CameraPose;
  private lastCur: CameraPose;
  private flight: Flight | null = null;
  private drag: DragState | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; angle: number; midX: number; midY: number } | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private listeners: Array<[EventTarget, string, EventListener, AddEventListenerOptions?]> = [];
  private viewportCss = { w: 1, h: 1 };
  /** Viewport aspect (width / height), kept current by the renderer; used by frameAll. */
  aspect = 1.6;

  constructor(public env: CameraEnvironment) {
    const d = env.nx * env.cellSize;
    this.cur = {
      target: { gx: env.nx / 2, gy: env.ny / 2, elevation: env.minElev },
      distance: d * 1.2,
      yaw: 0.3,
      pitch: 0.6,
    };
    this.goal = clonePose(this.cur);
    this.lastCur = clonePose(this.cur);
  }

  // ── CameraController ────────────────────────────────────────────────────────────────────

  get pose(): CameraPose {
    return this.cur;
  }

  set pose(p: CameraPose) {
    const s = sanitize(p, this.cur);
    this.cur = s;
    this.goal = clonePose(s);
    this.lastCur = clonePose(s);
    this.flight = null;
  }

  flyTo(pose: CameraPose, seconds = 1.4): void {
    this.adoptExternalEdits();
    const to = sanitize(pose, this.cur);
    if (!(seconds > 0.02)) {
      this.pose = to;
      return;
    }
    const cs = this.env.cellSize;
    const travel = Math.hypot((to.target.gx - this.cur.target.gx) * cs, (to.target.gy - this.cur.target.gy) * cs);
    const arc = clamp((travel / Math.max(this.cur.distance, to.distance)) * 0.35, 0, 1.2);
    this.flight = { from: clonePose(this.cur), to, t: 0, duration: seconds, arc };
    this.drag = null;
  }

  frameAll(): void {
    this.flyTo(this.framingPose(), 1.3);
  }

  /** Pleasant 3/4 view whose distance is solved so the whole domain box (with relief) fits on screen. */
  framingPose(yaw = 0.32, pitch = 0.66, margin = 0.94): CameraPose {
    const e = this.env;
    const size = Math.max(e.nx, e.ny) * e.cellSize;
    const hx = (e.nx / 2) * e.cellSize;
    const hz = (e.ny / 2) * e.cellSize;
    const y0 = e.minElev * e.exaggeration;
    const y1 = e.maxElev * e.exaggeration;
    const corners: Vec3[] = [];
    for (const x of [-hx, hx]) for (const y of [y0, y1]) for (const z of [-hz, hz]) corners.push([x, y, z]);
    const pose: CameraPose = { target: { gx: e.nx / 2, gy: e.ny / 2, elevation: (e.minElev + e.maxElev) / 2 }, distance: size, yaw, pitch };
    const fits = (dist: number) => {
      pose.distance = dist;
      const { forward, right, up } = OrbitController.basis(yaw, pitch);
      const eye = v3.sub(this.worldTarget(pose), v3.scale(forward, dist));
      const ty = Math.tan(CAMERA_FOV_Y / 2);
      const tx = ty * Math.max(0.2, this.aspect);
      for (const c of corners) {
        const rel = v3.sub(c, eye);
        const zf = v3.dot(rel, forward);
        if (zf <= 1) return false;
        if (Math.abs(v3.dot(rel, right) / (zf * tx)) > margin || Math.abs(v3.dot(rel, up) / (zf * ty)) > margin) return false;
      }
      return true;
    };
    let lo = size * 0.2;
    let hi = size * 8;
    for (let i = 0; i < 40; i++) {
      const mid = Math.sqrt(lo * hi);
      if (fits(mid)) hi = mid;
      else lo = mid;
    }
    pose.distance = hi;
    return pose;
  }

  topDown(): void {
    this.adoptExternalEdits();
    const g = clonePose(this.goal);
    this.flyTo({ ...g, pitch: MAX_PITCH }, 0.9);
  }

  // ── Scene / matrices ───────────────────────────────────────────────────────────────────

  setEnvironment(env: CameraEnvironment): void {
    this.env = env;
  }

  worldTarget(p: CameraPose = this.cur): Vec3 {
    const e = this.env;
    return [(p.target.gx - e.nx / 2) * e.cellSize, p.target.elevation * e.exaggeration, (p.target.gy - e.ny / 2) * e.cellSize];
  }

  static basis(yaw: number, pitch: number): { forward: Vec3; right: Vec3; up: Vec3; back: Vec3 } {
    const cp = Math.cos(pitch);
    const forward: Vec3 = [cp * Math.sin(yaw), -Math.sin(pitch), -cp * Math.cos(yaw)];
    const right: Vec3 = [Math.cos(yaw), 0, Math.sin(yaw)];
    const back: Vec3 = [-forward[0], -forward[1], -forward[2]];
    const up = v3.norm(v3.cross(back, right));
    return { forward, right, up, back };
  }

  eyeFor(p: CameraPose): Vec3 {
    const { forward } = OrbitController.basis(p.yaw, p.pitch);
    return v3.sub(this.worldTarget(p), v3.scale(forward, p.distance));
  }

  matrices(aspect: number, p: CameraPose = this.cur): CameraMatrices {
    const { forward, right, up, back } = OrbitController.basis(p.yaw, p.pitch);
    const eye = v3.sub(this.worldTarget(p), v3.scale(forward, p.distance));
    const e = this.env;
    // Near plane from clearance above the terrain: reversed-Z float depth tolerates a tiny near plane.
    const gx = eye[0] / e.cellSize + e.nx / 2;
    const gy = eye[2] / e.cellSize + e.ny / 2;
    const ground = e.heightAt(gx, gy);
    const clearance = ground === null ? p.distance : eye[1] - ground * e.exaggeration;
    const near = clamp(Math.min(Math.max(clearance, 1) * 0.3, p.distance * 0.05), 0.2, 50);
    const view = viewFromBasis(eye, right, up, back);
    const proj = perspectiveReversedInfinite(CAMERA_FOV_Y, aspect, near);
    const viewProj = mat4Multiply(proj, view);
    const invViewProj = mat4Invert(viewProj);
    return { view, proj, viewProj, invViewProj, eye, forward, right, up, near, fovY: CAMERA_FOV_Y, aspect };
  }

  /** Advance damping / flight. Call once per frame before computing matrices. */
  update(dt: number): void {
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.25);
    this.adoptExternalEdits();
    if (this.flight) {
      const f = this.flight;
      f.t += dt;
      const u = clamp(f.t / f.duration, 0, 1);
      const k = easeInOutCubic(u);
      const a = f.from;
      const b = f.to;
      const p: CameraPose = {
        target: {
          gx: a.target.gx + (b.target.gx - a.target.gx) * k,
          gy: a.target.gy + (b.target.gy - a.target.gy) * k,
          elevation: a.target.elevation + (b.target.elevation - a.target.elevation) * k,
        },
        distance: Math.exp(Math.log(a.distance) + (Math.log(b.distance) - Math.log(a.distance)) * k) * (1 + f.arc * Math.sin(Math.PI * k)),
        yaw: a.yaw + wrapAngle(b.yaw - a.yaw) * k,
        pitch: a.pitch + (b.pitch - a.pitch) * k,
      };
      this.cur = p;
      this.goal = clonePose(p);
      if (u >= 1) {
        this.cur = clonePose(b);
        this.goal = clonePose(b);
        this.flight = null;
      }
    } else {
      const a = 1 - Math.exp(-this.damping * dt);
      const c = this.cur;
      const g = this.goal;
      c.target.gx += (g.target.gx - c.target.gx) * a;
      c.target.gy += (g.target.gy - c.target.gy) * a;
      c.target.elevation += (g.target.elevation - c.target.elevation) * a;
      c.distance = Math.exp(Math.log(c.distance) + (Math.log(g.distance) - Math.log(c.distance)) * a);
      c.yaw += wrapAngle(g.yaw - c.yaw) * a;
      c.pitch += (g.pitch - c.pitch) * a;
      // Snap when converged so poses are stable (and screenshots deterministic).
      if (
        Math.abs(g.distance - c.distance) < 1e-4 * g.distance &&
        Math.abs(wrapAngle(g.yaw - c.yaw)) < 1e-5 &&
        Math.abs(g.pitch - c.pitch) < 1e-5 &&
        Math.abs(g.target.gx - c.target.gx) < 1e-4 &&
        Math.abs(g.target.gy - c.target.gy) < 1e-4 &&
        Math.abs(g.target.elevation - c.target.elevation) < 1e-3
      ) {
        this.cur = clonePose(g);
      }
    }
    this.enforceClearance(this.cur);
    this.enforceClearance(this.goal);
    this.lastCur = clonePose(this.cur);
  }

  /**
   * Lowest pitch allowed for a pose. Grazing views are for close-ups: from far away they show only the nearest
   * hillside (the flood hides behind it), and with the eye outside the terrain footprint the frame fills with the
   * diorama's side wall. So the floor rises with distance (relative to the domain) and with how far the eye's
   * ground position lies outside the footprint. It is smooth in distance, target and yaw, so orbiting never pops.
   */
  minPitchFor(p: CameraPose): number {
    const e = this.env;
    const size = Math.max(e.nx, e.ny) * e.cellSize;
    const byDistance = MIN_PITCH + (FAR_MIN_PITCH - MIN_PITCH) * smooth(0.06 * size, 0.5 * size, p.distance);
    // The eye's horizontal offset shrinks as the pitch rises, so the smallest pitch that satisfies the outside
    // floor is found by bisection (the floor only rises as the eye moves out, so there is one crossing).
    const need = (pitch: number) => {
      const cp = Math.cos(pitch);
      const ex = (p.target.gx - e.nx / 2) * e.cellSize - Math.sin(p.yaw) * cp * p.distance;
      const ez = (p.target.gy - e.ny / 2) * e.cellSize + Math.cos(p.yaw) * cp * p.distance;
      const ox = Math.max(0, Math.abs(ex) - (e.nx / 2) * e.cellSize);
      const oz = Math.max(0, Math.abs(ez) - (e.ny / 2) * e.cellSize);
      const outside = Math.hypot(ox, oz);
      return Math.max(byDistance, MIN_PITCH + (OUTSIDE_MIN_PITCH - MIN_PITCH) * smooth(0, 0.15 * size, outside));
    };
    let lo = byDistance;
    let hi = MAX_PITCH;
    if (need(lo) <= lo) return lo;
    for (let i = 0; i < 24; i++) {
      const mid = 0.5 * (lo + hi);
      if (need(mid) <= mid) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  /** Keep the eye above the terrain surface (and above the pitch floor) by raising the pitch if needed. */
  private enforceClearance(p: CameraPose): void {
    const e = this.env;
    const x = p.target;
    x.gx = clamp(x.gx, -0.25 * e.nx, 1.25 * e.nx);
    x.gy = clamp(x.gy, -0.25 * e.ny, 1.25 * e.ny);
    const size = Math.max(e.nx, e.ny) * e.cellSize;
    p.distance = clamp(p.distance, Math.max(e.cellSize * 1.5, 12), size * 5);
    p.pitch = clamp(p.pitch, this.minPitchFor(p), MAX_PITCH);
    for (let iter = 0; iter < 3; iter++) {
      const eye = this.eyeFor(p);
      const h = e.heightAt(eye[0] / e.cellSize + e.nx / 2, eye[2] / e.cellSize + e.ny / 2);
      if (h === null) return;
      const minY = h * e.exaggeration + Math.max(3, p.distance * 0.03);
      if (eye[1] >= minY) return;
      const ty = x.elevation * e.exaggeration;
      const s = clamp((minY - ty) / p.distance, -1, 1);
      const need = Math.asin(s);
      if (need <= p.pitch + 1e-6) {
        // Target itself is buried or the geometry doesn't converge: lift the target instead.
        x.elevation += (minY - eye[1]) / e.exaggeration;
        return;
      }
      p.pitch = clamp(need + 0.002, MIN_PITCH, MAX_PITCH);
    }
  }

  private adoptExternalEdits(): void {
    if (!samePose(this.cur, this.lastCur)) {
      const s = sanitize(this.cur, this.lastCur);
      this.cur = s;
      this.goal = clonePose(s);
      this.lastCur = clonePose(s);
      this.flight = null;
    }
  }

  // ── Input ──────────────────────────────────────────────────────────────────────────────

  attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this.canvas = canvas;
    canvas.style.touchAction = 'none';
    const on = (t: EventTarget, type: string, fn: (ev: any) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.listeners.push([t, type, fn as EventListener, opts]);
    };
    on(canvas, 'pointerdown', (e: PointerEvent) => this.onPointerDown(e));
    on(canvas, 'pointermove', (e: PointerEvent) => this.onPointerMove(e));
    on(canvas, 'pointerup', (e: PointerEvent) => this.onPointerUp(e));
    on(canvas, 'pointercancel', (e: PointerEvent) => this.onPointerUp(e));
    on(canvas, 'lostpointercapture', (e: PointerEvent) => this.onPointerUp(e));
    on(canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    on(canvas, 'contextmenu', (e: Event) => e.preventDefault());
  }

  detach(): void {
    for (const [t, type, fn, opts] of this.listeners) t.removeEventListener(type, fn, opts);
    this.listeners = [];
    this.canvas = null;
    this.drag = null;
    this.touches.clear();
    this.pinch = null;
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = this.canvas!.getBoundingClientRect();
    this.viewportCss = { w: Math.max(1, r.width), h: Math.max(1, r.height) };
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private rayFor(pose: CameraPose, x: number, y: number): Ray {
    const m = this.matrices(this.viewportCss.w / this.viewportCss.h, pose);
    return cameraRay(m, x, y, this.viewportCss.w, this.viewportCss.h);
  }

  private beginInteraction(): void {
    this.adoptExternalEdits();
    if (this.flight) {
      this.flight = null;
      this.goal = clonePose(this.cur);
    }
  }

  private onPointerDown(e: PointerEvent): void {
    if (!this.canvas) return;
    const p = this.local(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 2) {
        this.drag = null;
        this.beginInteraction();
        this.pinch = this.pinchState();
        this.capture(e);
      } else if (this.touches.size === 1 && this.leftDragOrbits) {
        this.beginInteraction();
        this.drag = { mode: 'orbit', pointerId: e.pointerId, lastX: p.x, lastY: p.y };
        this.capture(e);
      }
      return;
    }
    let mode: 'orbit' | 'pan' | null = null;
    if (e.button === 0 && this.leftDragOrbits) mode = e.shiftKey || e.ctrlKey || e.metaKey ? 'pan' : 'orbit';
    else if (e.button === 1 || e.button === 2) mode = 'pan';
    if (!mode) return;
    if (e.button === 1) e.preventDefault();
    this.beginInteraction();
    this.drag = { mode, pointerId: e.pointerId, lastX: p.x, lastY: p.y };
    if (mode === 'pan') this.startPan(this.drag, p.x, p.y);
    this.capture(e);
  }

  private capture(e: PointerEvent): void {
    try {
      this.canvas?.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort (synthetic events) */
    }
  }

  private startPan(d: DragState, x: number, y: number): void {
    const pose = clonePose(this.goal);
    const ray = this.rayFor(pose, x, y);
    const ty = this.worldTarget(pose)[1];
    d.grab = intersectPlaneY(ray, ty) ?? undefined;
    d.grabPose = pose;
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.canvas) return;
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, this.local(e));
      if (this.touches.size >= 2 && this.pinch) {
        this.applyPinch();
        return;
      }
    }
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = this.local(e);
    const dx = p.x - d.lastX;
    const dy = p.y - d.lastY;
    d.lastX = p.x;
    d.lastY = p.y;
    if (d.mode === 'orbit') {
      const k = (2.6 * Math.PI) / Math.max(400, this.viewportCss.w);
      this.goal.yaw += dx * k;
      this.goal.pitch = clamp(this.goal.pitch + dy * k * 0.8, MIN_PITCH, MAX_PITCH);
    } else if (d.grab && d.grabPose) {
      const ray = this.rayFor(d.grabPose, p.x, p.y);
      const ty = this.worldTarget(d.grabPose)[1];
      let hit = intersectPlaneY(ray, ty);
      const size = Math.max(this.env.nx, this.env.ny) * this.env.cellSize;
      if (!hit || v3.len(v3.sub(hit, ray.origin)) > size * 3) {
        // Near the horizon: clamp to a far point along the ray's horizontal direction.
        const hd = v3.norm([ray.dir[0], 0, ray.dir[2]]);
        hit = v3.add([ray.origin[0], ty, ray.origin[2]], v3.scale(hd, size * 3));
      }
      const delta = v3.sub(d.grab, hit);
      const cs = this.env.cellSize;
      this.goal.target.gx = d.grabPose.target.gx + delta[0] / cs;
      this.goal.target.gy = d.grabPose.target.gy + delta[2] / cs;
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === 'touch') {
      this.touches.delete(e.pointerId);
      if (this.touches.size < 2) this.pinch = null;
      if (this.touches.size === 0) this.settleTargetElevation();
    }
    if (this.drag && this.drag.pointerId === e.pointerId) {
      if (this.drag.mode === 'pan') this.settleTargetElevation();
      this.drag = null;
    }
  }

  /** After panning, glide the orbit pivot onto the terrain under it. */
  private settleTargetElevation(): void {
    const h = this.env.heightAt(this.goal.target.gx, this.goal.target.gy);
    if (h === null) return;
    // Keep the eye where it is while re-centering the pivot vertically: adjust distance along the ray.
    this.goal.target.elevation = h;
  }

  private pinchState() {
    const pts = [...this.touches.values()].slice(0, 2);
    const dx = pts[1].x - pts[0].x;
    const dy = pts[1].y - pts[0].y;
    return {
      dist: Math.max(1, Math.hypot(dx, dy)),
      angle: Math.atan2(dy, dx),
      midX: (pts[0].x + pts[1].x) / 2,
      midY: (pts[0].y + pts[1].y) / 2,
    };
  }

  private applyPinch(): void {
    const prev = this.pinch!;
    const now = this.pinchState();
    // Pan by midpoint movement on the pivot plane.
    const pose = clonePose(this.goal);
    const ty = this.worldTarget(pose)[1];
    const a = intersectPlaneY(this.rayFor(pose, prev.midX, prev.midY), ty);
    const b = intersectPlaneY(this.rayFor(pose, now.midX, now.midY), ty);
    if (a && b) {
      this.goal.target.gx += (a[0] - b[0]) / this.env.cellSize;
      this.goal.target.gy += (a[2] - b[2]) / this.env.cellSize;
    }
    this.zoomAt(now.midX, now.midY, prev.dist / now.dist);
    this.goal.yaw -= wrapAngle(now.angle - prev.angle);
    this.pinch = now;
  }

  private onWheel(e: WheelEvent): void {
    if (!this.canvas) return;
    e.preventDefault();
    this.beginInteraction();
    const p = this.local(e);
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= this.viewportCss.h;
    // Trackpad pinch arrives as ctrl+wheel with small deltas; make it a bit more sensitive.
    const k = e.ctrlKey ? 0.01 : 0.0015;
    this.zoomAt(p.x, p.y, Math.exp(clamp(dy, -400, 400) * k));
  }

  /** Scale the camera about the terrain point under (x, y): that point stays under the cursor. */
  zoomAt(x: number, y: number, factor: number): void {
    const e = this.env;
    const size = Math.max(e.nx, e.ny) * e.cellSize;
    const g = this.goal;
    const minD = Math.max(e.cellSize * 1.5, 12);
    const newD = clamp(g.distance * factor, minD, size * 5);
    const s = newD / g.distance;
    if (Math.abs(s - 1) < 1e-6) return;
    const hit = e.pickWorld(x, y);
    if (hit) {
      g.target.gx = hit.gx + (g.target.gx - hit.gx) * s;
      g.target.gy = hit.gy + (g.target.gy - hit.gy) * s;
      g.target.elevation = hit.elevation + (g.target.elevation - hit.elevation) * s;
    }
    g.distance = newD;
  }
}
