/**
 * CPU geometry builders for overlays. All positions are in GRID coordinates; heights are resolved on the GPU
 * against the live terrain / water surface so overlays follow edits and vertical exaggeration for free.
 */
import type { RoadClass, RoadNetwork, Shelter, StormCell, WaterSource } from '../contracts';

// ── Ribbons ─────────────────────────────────────────────────────────────────────────────────

export const RIBBON_STRIDE = 8; // floats per vertex: center(2) tangent(2) side along halfWidth packed

export const RibbonKind = { Road: 0, Route: 1, Ring: 2 } as const;
export type RibbonKind = (typeof RibbonKind)[keyof typeof RibbonKind];

export class GrowableF32 {
  data: Float32Array;
  length = 0;
  constructor(cap = 1024) {
    this.data = new Float32Array(cap);
  }
  reserve(n: number) {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const d = new Float32Array(cap);
    d.set(this.data.subarray(0, this.length));
    this.data = d;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

export class GrowableU32 {
  data: Uint32Array;
  length = 0;
  constructor(cap = 1024) {
    this.data = new Uint32Array(cap);
  }
  reserve(n: number) {
    if (this.length + n <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.length + n) cap *= 2;
    const d = new Uint32Array(cap);
    d.set(this.data.subarray(0, this.length));
    this.data = d;
  }
  view() {
    return this.data.subarray(0, this.length);
  }
}

export class RibbonBuilder {
  readonly verts = new GrowableF32(4096);
  readonly indices = new GrowableU32(4096);
  private px: number[] = [];
  private py: number[] = [];

  constructor(private cellSize: number) {}

  get vertexCount() {
    return this.verts.length / RIBBON_STRIDE;
  }

  /**
   * Append a polyline ribbon. `maxSeg` (cells) densifies long segments so the ribbon drapes over terrain.
   * Mitered joins: the tangent's length carries the miter scale (clamped for sharp turns).
   */
  addPolyline(pts: ArrayLike<number>, opts: { halfWidth: number; kind: RibbonKind; id: number; maxSeg: number; closed?: boolean; alongOffset?: number }): number {
    const n0 = Math.floor(pts.length / 2);
    if (n0 < 2) return 0;
    const px = this.px;
    const py = this.py;
    px.length = 0;
    py.length = 0;
    const push = (x: number, y: number) => {
      const k = px.length;
      if (k > 0 && Math.abs(px[k - 1] - x) < 1e-4 && Math.abs(py[k - 1] - y) < 1e-4) return;
      px.push(x);
      py.push(y);
    };
    const count = opts.closed ? n0 + 1 : n0;
    for (let i = 0; i < count; i++) {
      const a = i % n0;
      const x = pts[a * 2];
      const y = pts[a * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (px.length > 0) {
        const lx = px[px.length - 1];
        const ly = py[py.length - 1];
        const len = Math.hypot(x - lx, y - ly);
        const steps = Math.min(4096, Math.ceil(len / opts.maxSeg));
        for (let s = 1; s < steps; s++) push(lx + ((x - lx) * s) / steps, ly + ((y - ly) * s) / steps);
      }
      push(x, y);
    }
    const n = px.length;
    if (n < 2) return 0;
    const closedLoop = !!opts.closed && Math.abs(px[0] - px[n - 1]) < 1e-3 && Math.abs(py[0] - py[n - 1]) < 1e-3;

    const base = this.vertexCount;
    this.verts.reserve(n * 2 * RIBBON_STRIDE);
    this.indices.reserve((n - 1) * 6);
    const V = this.verts.data;
    let along = opts.alongOffset ?? 0;
    const packed = opts.kind + opts.id * 8;
    for (let i = 0; i < n; i++) {
      if (i > 0) along += Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]) * this.cellSize;
      // Incoming / outgoing segment directions.
      let ix = 0, iy = 0, ox = 0, oy = 0;
      const prev = i > 0 ? i - 1 : closedLoop ? n - 2 : -1;
      const next = i < n - 1 ? i + 1 : closedLoop ? 1 : -1;
      if (prev >= 0) {
        const l = Math.hypot(px[i] - px[prev], py[i] - py[prev]) || 1;
        ix = (px[i] - px[prev]) / l;
        iy = (py[i] - py[prev]) / l;
      }
      if (next >= 0) {
        const l = Math.hypot(px[next] - px[i], py[next] - py[i]) || 1;
        ox = (px[next] - px[i]) / l;
        oy = (py[next] - py[i]) / l;
      }
      if (prev < 0) {
        ix = ox;
        iy = oy;
      }
      if (next < 0) {
        ox = ix;
        oy = iy;
      }
      let tx = ix + ox;
      let ty = iy + oy;
      let tl = Math.hypot(tx, ty);
      if (tl < 1e-6) {
        tx = ox;
        ty = oy;
        tl = 1;
      }
      tx /= tl;
      ty /= tl;
      const cosHalf = Math.max(tx * ox + ty * oy, 0.35);
      const miter = 1 / cosHalf;
      for (let side = -1; side <= 1; side += 2) {
        const o = this.verts.length;
        V[o] = px[i];
        V[o + 1] = py[i];
        V[o + 2] = tx * miter;
        V[o + 3] = ty * miter;
        V[o + 4] = side;
        V[o + 5] = along;
        V[o + 6] = opts.halfWidth;
        V[o + 7] = packed;
        this.verts.length += RIBBON_STRIDE;
      }
    }
    const I = this.indices.data;
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      const o = this.indices.length;
      I[o] = a;
      I[o + 1] = a + 1;
      I[o + 2] = a + 2;
      I[o + 3] = a + 1;
      I[o + 4] = a + 3;
      I[o + 5] = a + 2;
      this.indices.length += 6;
    }
    return along;
  }
}

const ROAD_HALF_WIDTH: Record<RoadClass, number> = { highway: 11, major: 7.5, minor: 5, local: 3.5 };

/** Road ribbons, one polyline per edge (id = edge index for status lookup). */
export function buildRoadRibbons(roads: RoadNetwork, cellSize: number, stride: number): RibbonBuilder {
  const b = new RibbonBuilder(cellSize);
  // Budget the densification so enormous networks stay under ~1.2M vertices.
  let totalCells = 0;
  for (const e of roads.edges) totalCells += e.length / cellSize;
  const maxSeg = Math.max(stride * 1.0, totalCells / 600_000);
  roads.edges.forEach((e, idx) => {
    b.addPolyline(e.pts, { halfWidth: ROAD_HALF_WIDTH[e.cls] ?? 4, kind: RibbonKind.Road, id: idx, maxSeg });
  });
  return b;
}


// ── Markers ─────────────────────────────────────────────────────────────────────────────────

export const MARKER_STRIDE = 18; // local(3) normal(3) anchor(4) params(4) color(4)

export const MarkerKind = { Solid: 0, Beam: 1, StormColumn: 2, Cloud: 3, Ghost: 4, Pulse: 5, Gauge: 6 } as const;
export const AnchorMode = { Ground: 0, Absolute: 1, WaterSurface: 2 } as const;
export const ScaleMode = { Marker: 0, Meters: 1, MetersExaggerated: 2 } as const;

export interface Anchor {
  gx: number;
  gy: number;
  elev: number;
  mode: number;
}

export type RGBA = [number, number, number, number];

export interface MarkerStyle {
  scaleMode: number;
  kind: number;
  /** Minimum world size of one marker unit (m) for ScaleMode.Marker. */
  size: number;
  phase: number;
  color: RGBA;
}

interface ProfilePoint {
  r: number;
  y: number;
  anchor: Anchor;
  /** Optional explicit profile normal (radial, vertical). */
  n?: [number, number];
}

export class MarkerBuilder {
  readonly verts = new GrowableF32(4096);
  readonly indices = new GrowableU32(4096);

  get vertexCount() {
    return this.verts.length / MARKER_STRIDE;
  }

  vertex(lx: number, ly: number, lz: number, nx: number, ny: number, nz: number, a: Anchor, st: MarkerStyle): number {
    this.verts.reserve(MARKER_STRIDE);
    const o = this.verts.length;
    const V = this.verts.data;
    V[o] = lx;
    V[o + 1] = ly;
    V[o + 2] = lz;
    V[o + 3] = nx;
    V[o + 4] = ny;
    V[o + 5] = nz;
    V[o + 6] = a.gx;
    V[o + 7] = a.gy;
    V[o + 8] = a.elev;
    V[o + 9] = a.mode;
    V[o + 10] = st.scaleMode;
    V[o + 11] = st.kind;
    V[o + 12] = st.size;
    V[o + 13] = st.phase;
    V[o + 14] = st.color[0];
    V[o + 15] = st.color[1];
    V[o + 16] = st.color[2];
    V[o + 17] = st.color[3];
    this.verts.length += MARKER_STRIDE;
    return o / MARKER_STRIDE;
  }

  tri(a: number, b: number, c: number) {
    this.indices.reserve(3);
    const I = this.indices.data;
    const o = this.indices.length;
    I[o] = a;
    I[o + 1] = b;
    I[o + 2] = c;
    this.indices.length += 3;
  }

  quad(a: number, b: number, c: number, d: number) {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /** Surface of revolution around the local Y axis. Normals from the profile unless given explicitly. */
  lathe(profile: ProfilePoint[], segments: number, st: MarkerStyle) {
    const rings = profile.length;
    if (rings < 2) return;
    const base = this.vertexCount;
    for (let i = 0; i < rings; i++) {
      const p = profile[i];
      let nr: number;
      let ny: number;
      if (p.n) {
        [nr, ny] = p.n;
      } else {
        const a = profile[Math.max(0, i - 1)];
        const b = profile[Math.min(rings - 1, i + 1)];
        const dr = b.r - a.r;
        const dy = b.y - a.y;
        const l = Math.hypot(dr, dy) || 1;
        nr = dy / l;
        ny = -dr / l;
      }
      for (let s = 0; s <= segments; s++) {
        const ang = (s / segments) * Math.PI * 2;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        this.vertex(c * p.r, p.y, sn * p.r, c * nr, ny, sn * nr, p.anchor, st);
      }
    }
    const w = segments + 1;
    for (let i = 0; i < rings - 1; i++) {
      for (let s = 0; s < segments; s++) {
        const a = base + i * w + s;
        this.quad(a, a + 1, a + w + 1, a + w);
      }
    }
  }

  /** Flat disc (normal up) of radius r at local height y. */
  disc(r: number, y: number, anchor: Anchor, segments: number, st: MarkerStyle, normalY = 1) {
    const center = this.vertex(0, y, 0, 0, normalY, 0, anchor, st);
    const first = this.vertexCount;
    for (let s = 0; s <= segments; s++) {
      const ang = (s / segments) * Math.PI * 2;
      this.vertex(Math.cos(ang) * r, y, Math.sin(ang) * r, 0, normalY, 0, anchor, st);
    }
    for (let s = 0; s < segments; s++) this.tri(center, first + s, first + s + 1);
  }

  sphere(cy: number, radius: number, anchor: Anchor, st: MarkerStyle, rings = 10, segments = 18) {
    const profile: ProfilePoint[] = [];
    for (let i = 0; i <= rings; i++) {
      const th = -Math.PI / 2 + (i / rings) * Math.PI;
      profile.push({ r: Math.cos(th) * radius, y: cy + Math.sin(th) * radius, anchor, n: [Math.cos(th), Math.sin(th)] });
    }
    this.lathe(profile, segments, st);
  }

  /** Axis-aligned box in local units: [x0,x1]×[y0,y1]×[z0,z1]. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, anchor: Anchor, st: MarkerStyle) {
    const faces: Array<[number[], number[][]]> = [
      [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
      [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
      [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
      [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
      [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
      [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
    ];
    for (const [n, q] of faces) {
      const i = q.map((p) => this.vertex(p[0], p[1], p[2], n[0], n[1], n[2], anchor, st));
      this.quad(i[0], i[1], i[2], i[3]);
    }
  }
}

/** Colors (linear HDR). */
const C = {
  shelter: [0.08, 0.75, 0.3, 1] as RGBA,
  shelterRing: [0.2, 1.0, 0.45, 0.9] as RGBA,
  home: [1.0, 0.55, 0.08, 1] as RGBA,
  roof: [0.72, 0.12, 0.06, 1] as RGBA,
  white: [0.92, 0.92, 0.9, 1] as RGBA,
  inflow: [0.1, 0.42, 1.0, 1] as RGBA,
  beam: [0.35, 0.8, 2.4, 1.0] as RGBA,
  gaugeBand: [0.4, 2.2, 2.8, 1] as RGBA,
  gaugeRed: [0.85, 0.08, 0.06, 1] as RGBA,
  ghost: [1.0, 0.7, 0.2, 0.6] as RGBA,
};

export interface MarkerScene {
  cellSize: number;
  stride: number;
  minElev: number;
  maxElev: number;
  domainSize: number;
}

export interface MarkerGeometry {
  opaque: MarkerBuilder;
  blended: MarkerBuilder;
}

const solid = (size: number, color: RGBA, phase = 0): MarkerStyle => ({ scaleMode: ScaleMode.Marker, kind: MarkerKind.Solid, size, phase, color });

/** Build pins, beacons, gauges and storm columns for the current overlay state. */
export function buildMarkers(
  scene: MarkerScene,
  sources: WaterSource[],
  storms: StormCell[],
  shelters: Shelter[],
  evacStart: { gx: number; gy: number } | null,
): MarkerGeometry {
  const opaque = new MarkerBuilder();
  const blended = new MarkerBuilder();
  const size = Math.max(6, scene.domainSize * 0.0045);
  const water = (gx: number, gy: number): Anchor => ({ gx, gy, elev: 0, mode: AnchorMode.WaterSurface });

  const pin = (gx: number, gy: number, color: RGBA, phase: number) => {
    const a = water(gx, gy);
    const st = solid(size, color, phase);
    opaque.lathe([
      { r: 0, y: 0, anchor: a },
      { r: 0.13, y: 0.6, anchor: a },
    ], 16, st);
    opaque.sphere(0.8, 0.24, a, st);
    // White collar ring around the head.
    opaque.lathe([
      { r: 0.245, y: 0.86, anchor: a, n: [0.2, 1] },
      { r: 0.2, y: 0.95, anchor: a, n: [0.2, 1] },
    ], 18, solid(size, C.white, phase));
    blended.disc(1.4, 0.03, a, 32, { scaleMode: ScaleMode.Marker, kind: MarkerKind.Pulse, size, phase, color: [color[0], color[1], color[2], 0.9] });
  };

  shelters.forEach((s, i) => pin(s.gx, s.gy, C.shelter, i * 0.37));

  if (evacStart) {
    const a = water(evacStart.gx, evacStart.gy);
    const st = solid(size, C.home);
    opaque.lathe([
      { r: 0, y: 0, anchor: a },
      { r: 0.09, y: 0.55, anchor: a },
    ], 14, st);
    opaque.box(-0.22, 0.22, 0.55, 0.88, -0.2, 0.2, a, st);
    // Gable roof (prism along X).
    const roof = solid(size, C.roof);
    const ry0 = 0.88;
    const ry1 = 1.14;
    const hx = 0.27;
    const hz = 0.25;
    const sl = Math.hypot(hz, ry1 - ry0);
    const nzN = [0, hz / sl, -(ry1 - ry0) / sl];
    const nzS = [0, hz / sl, (ry1 - ry0) / sl];
    const n1 = [
      opaque.vertex(-hx, ry0, -hz, nzN[0], nzN[1], nzN[2], a, roof),
      opaque.vertex(hx, ry0, -hz, nzN[0], nzN[1], nzN[2], a, roof),
      opaque.vertex(hx, ry1, 0, nzN[0], nzN[1], nzN[2], a, roof),
      opaque.vertex(-hx, ry1, 0, nzN[0], nzN[1], nzN[2], a, roof),
    ];
    opaque.quad(n1[0], n1[1], n1[2], n1[3]);
    const s1 = [
      opaque.vertex(hx, ry0, hz, nzS[0], nzS[1], nzS[2], a, roof),
      opaque.vertex(-hx, ry0, hz, nzS[0], nzS[1], nzS[2], a, roof),
      opaque.vertex(-hx, ry1, 0, nzS[0], nzS[1], nzS[2], a, roof),
      opaque.vertex(hx, ry1, 0, nzS[0], nzS[1], nzS[2], a, roof),
    ];
    opaque.quad(s1[0], s1[1], s1[2], s1[3]);
    for (const sx of [-1, 1]) {
      const g = [
        opaque.vertex(sx * 0.22, ry0, -0.2, sx, 0, 0, a, st),
        opaque.vertex(sx * 0.22, ry0, 0.2, sx, 0, 0, a, st),
        opaque.vertex(sx * 0.22, ry1 - 0.02, 0, sx, 0, 0, a, st),
      ];
      opaque.tri(g[0], g[1], g[2]);
    }
    blended.disc(1.5, 0.03, a, 32, { scaleMode: ScaleMode.Marker, kind: MarkerKind.Pulse, size, phase: 0.5, color: [1.0, 0.6, 0.1, 1.0] });
  }

  sources.forEach((src, i) => {
    const phase = i * 0.61;
    if (src.type === 'inflow') {
      const a = water(src.gx, src.gy);
      const st = solid(size, C.inflow, phase);
      opaque.lathe([
        { r: 0, y: 0.0, anchor: a, n: [0, -1] },
        { r: 0.3, y: 0.0, anchor: a, n: [0, -1] },
      ], 20, st);
      opaque.lathe([
        { r: 0.3, y: 0.0, anchor: a, n: [1, 0] },
        { r: 0.3, y: 0.1, anchor: a, n: [1, 0] },
      ], 20, st);
      opaque.disc(0.3, 0.1, a, 20, st);
      // Downward arrow (inverted cone) hovering above the base.
      opaque.lathe([
        { r: 0, y: 0.3, anchor: a },
        { r: 0.24, y: 0.72, anchor: a },
      ], 18, st);
      opaque.disc(0.24, 0.72, a, 18, st);
      blended.lathe([
        { r: 0.09, y: 0, anchor: a, n: [1, 0] },
        { r: 0.09, y: 3.5, anchor: a, n: [1, 0] },
      ], 16, { scaleMode: ScaleMode.Marker, kind: MarkerKind.Beam, size, phase, color: C.beam });
      blended.disc(1.6, 0.03, a, 32, { scaleMode: ScaleMode.Marker, kind: MarkerKind.Pulse, size, phase, color: [0.3, 0.7, 1.0, 1.0] });
    } else {
      const g: Anchor = { gx: src.gx, gy: src.gy, elev: 0, mode: AnchorMode.Ground };
      const lv: Anchor = { gx: src.gx, gy: src.gy, elev: src.level, mode: AnchorMode.Absolute };
      const pole: MarkerStyle = { scaleMode: ScaleMode.Marker, kind: MarkerKind.Gauge, size, phase, color: C.white };
      opaque.lathe([
        { r: 0.045, y: -0.1, anchor: g, n: [1, 0] },
        { r: 0.045, y: 0.9, anchor: lv, n: [1, 0] },
      ], 10, pole);
      opaque.sphere(0.95, 0.08, lv, solid(size, C.gaugeRed, phase), 6, 12);
      // Level band (emissive cyan) at the target water surface elevation.
      const band = solid(size, C.gaugeBand, phase);
      opaque.lathe([
        { r: 0.16, y: -0.04, anchor: lv, n: [1, 0] },
        { r: 0.16, y: 0.04, anchor: lv, n: [1, 0] },
      ], 20, band);
      opaque.disc(0.16, 0.04, lv, 20, band);
      opaque.disc(0.16, -0.04, lv, 20, band, -1);
      blended.disc(1.3, 0.0, lv, 32, { scaleMode: ScaleMode.Marker, kind: MarkerKind.Pulse, size, phase, color: [0.3, 1.2, 1.6, 0.8] });
    }
  });

  const relief = Math.max(scene.maxElev - scene.minElev, 1);
  storms.forEach((s, i) => {
    const R = Math.max(1, s.radius) * scene.cellSize * 0.85;
    const bottom = scene.minElev - 5;
    const cloud = scene.maxElev + relief * 0.35 + scene.domainSize * 0.05;
    const k = Math.min(1, Math.max(0.15, s.intensity / 80));
    const lo: Anchor = { gx: s.gx, gy: s.gy, elev: bottom, mode: AnchorMode.Absolute };
    const hi: Anchor = { gx: s.gx, gy: s.gy, elev: cloud, mode: AnchorMode.Absolute };
    const col: MarkerStyle = { scaleMode: ScaleMode.Meters, kind: MarkerKind.StormColumn, size: 1, phase: i * 0.3, color: [0.55, 0.62, 0.75, 0.1 + 0.2 * k] };
    blended.lathe([
      { r: R, y: 0, anchor: lo, n: [1, 0] },
      { r: R, y: 0, anchor: hi, n: [1, 0] },
    ], 48, col);
    // Cloud cap: flattened ellipsoid.
    const Rc = R * 1.3;
    const cap: MarkerStyle = { scaleMode: ScaleMode.Meters, kind: MarkerKind.Cloud, size: Rc, phase: i * 0.3, color: [0.62, 0.65, 0.72, 0.5 + 0.3 * k] };
    const profile: ProfilePoint[] = [];
    const th = Math.max(R * 0.18, 40);
    for (let j = 0; j <= 8; j++) {
      const t = -Math.PI / 2 + (j / 8) * Math.PI;
      profile.push({ r: Math.cos(t) * Rc, y: Math.sin(t) * th, anchor: hi, n: [Math.cos(t) * 0.4, Math.sin(t)] });
    }
    blended.lathe(profile, 48, cap);
  });

  return { opaque, blended };
}

/** Translucent extruded ghost along the in-progress wall polyline. */
export function buildWallGhost(
  scene: MarkerScene,
  pts: Float32Array,
  height: number,
  radius: number,
  into: MarkerBuilder,
): void {
  const n0 = Math.floor(pts.length / 2);
  if (n0 < 1) return;
  const top = Math.max(0.2, height);
  const st: MarkerStyle = { scaleMode: ScaleMode.MetersExaggerated, kind: MarkerKind.Ghost, size: top, phase: 0, color: C.ghost };
  // Densify to ≈ one mesh cell.
  const P: number[] = [];
  for (let i = 0; i < n0; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    if (i > 0) {
      const lx = P[P.length - 2];
      const ly = P[P.length - 1];
      const steps = Math.min(2048, Math.ceil(Math.hypot(x - lx, y - ly) / Math.max(0.5, scene.stride)));
      for (let s = 1; s < steps; s++) P.push(lx + ((x - lx) * s) / steps, ly + ((y - ly) * s) / steps);
    }
    P.push(x, y);
  }
  const r = Math.max(radius, 0.35);
  if (P.length === 2) {
    // Single click: a short post.
    P.push(P[0] + 0.01, P[1]);
  }
  const n = P.length / 2;
  const left: number[] = [];
  const right: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = P[b * 2] - P[a * 2];
    let ty = P[b * 2 + 1] - P[a * 2 + 1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    const nx = -ty;
    const ny = tx;
    const x = P[i * 2];
    const y = P[i * 2 + 1];
    const la: Anchor = { gx: x + nx * r, gy: y + ny * r, elev: 0, mode: AnchorMode.Ground };
    const ra: Anchor = { gx: x - nx * r, gy: y - ny * r, elev: 0, mode: AnchorMode.Ground };
    left.push(
      into.vertex(0, -0.4, 0, nx, 0, ny, la, st),
      into.vertex(0, top, 0, nx, 0, ny, la, st),
      into.vertex(0, top, 0, 0, 1, 0, la, st),
    );
    right.push(
      into.vertex(0, -0.4, 0, -nx, 0, -ny, ra, st),
      into.vertex(0, top, 0, -nx, 0, -ny, ra, st),
      into.vertex(0, top, 0, 0, 1, 0, ra, st),
    );
  }
  for (let i = 0; i < n - 1; i++) {
    const L0 = i * 3;
    const L1 = (i + 1) * 3;
    into.quad(left[L0], left[L1], left[L1 + 1], left[L0 + 1]);
    into.quad(right[L0], right[L0 + 1], right[L1 + 1], right[L1]);
    into.quad(left[L0 + 2], left[L1 + 2], right[L1 + 2], right[L0 + 2]);
  }
  // End caps.
  for (const i of [0, n - 1]) {
    const L = i * 3;
    into.quad(left[L], left[L + 1], right[L + 1], right[L]);
  }
}

/** Closed circle polyline in grid coords. */
export function circlePolyline(gx: number, gy: number, radius: number, stride: number): Float32Array {
  const segs = Math.max(48, Math.min(360, Math.ceil((radius * Math.PI * 2) / Math.max(0.5, stride))));
  const out = new Float32Array(segs * 2);
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    out[i * 2] = gx + Math.cos(a) * radius;
    out[i * 2 + 1] = gy + Math.sin(a) * radius;
  }
  return out;
}
