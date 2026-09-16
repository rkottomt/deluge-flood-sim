/**
 * Synthetic "river valley" terrain for the renderer harness and tests: a meandering river in a broad
 * floodplain, forested hills, a steep tributary creek from the east, a small town grid with a sandbag levee
 * and a concrete floodwall. Also produces procedural aerial imagery and a road network.
 * (Development/test fixture only — the app uses real USGS data.)
 */
import type { RoadClass, RoadEdge, RoadNetwork } from '../contracts';

export interface MockTerrain {
  n: number;
  cellSize: number;
  ground: Float32Array;
  barrier: Float32Array;
  /** Per-cell hydro info: [valleyMask, creekWeight, dirX, dirY] × n². */
  flow: Float32Array;
  roads: RoadNetwork;
  /** River surface elevation at stage 0 as a function of gy (m). */
  riverLevel: (gy: number) => number;
  /** Protected (behind levee) cell rectangle in grid coords. */
  protectedRect: { x0: number; y0: number; x1: number; y1: number };
  town: { x0: number; y0: number; x1: number; y1: number };
  riverX: (gy: number) => number;
  creek: Float32Array; // polyline grid coords
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function fbm(x: number, y: number, octaves: number, seed: number): number {
  let s = 0;
  let amp = 0.5;
  let f = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    s += amp * (valueNoise(x * f, y * f, seed + o * 17) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return s / norm;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

export function buildMockTerrain(n = 1024, cellSize = 8192 / n): MockTerrain {
  const N = n * n;
  const ground = new Float32Array(N);
  const barrier = new Float32Array(N);
  const flow = new Float32Array(N * 4);
  const m = cellSize; // meters per cell
  const riverX = (gy: number) => {
    const v = gy / n;
    return n * (0.5 + 0.085 * Math.sin(v * Math.PI * 2 * 1.25 + 0.5) + 0.03 * Math.sin(v * Math.PI * 2 * 3.2 + 1.3));
  };
  const riverDX = (gy: number) => (riverX(gy + 0.5) - riverX(gy - 0.5));
  const floor = (gy: number) => 231 - (12 * gy) / n;
  const riverLevel = (gy: number) => floor(gy) - 1.0;

  // Tributary creek: from the east edge down into the river, meandering.
  const creekPts: number[] = [];
  const joinY = n * 0.4;
  const joinX = riverX(joinY);
  for (let i = 0; i <= 80; i++) {
    const t = i / 80;
    const x = n - t * (n - joinX - 40 * (n / 1024));
    const y = n * 0.27 + (joinY - n * 0.27) * t * t + Math.sin(t * 9) * 14 * (n / 1024) * (1 - t);
    creekPts.push(x, y);
  }
  const creek = new Float32Array(creekPts);

  // Town and levee layout (west bank floodplain).
  const townY0 = Math.round(n * 0.52);
  const townY1 = Math.round(n * 0.66);
  const riverAtTown = riverX((townY0 + townY1) / 2);
  const townX1 = Math.round(riverAtTown - 30 * (n / 1024));
  const townX0 = Math.round(townX1 - 95 * (n / 1024));
  const protectedRect = { x0: townX0 + 30 * (n / 1024), y0: townY0 + 6 * (n / 1024), x1: townX1 - 8 * (n / 1024), y1: townY0 + 50 * (n / 1024) };

  // Distance-to-creek lookup via coarse segment search per row band.
  const segDist = (px: number, py: number): { d: number; tx: number; ty: number; t: number } => {
    let best = 1e9;
    let btx = 0;
    let bty = 0;
    let bt = 0;
    for (let i = 0; i < creekPts.length / 2 - 1; i++) {
      const ax = creekPts[i * 2];
      const ay = creekPts[i * 2 + 1];
      const bx = creekPts[i * 2 + 2];
      const by = creekPts[i * 2 + 3];
      const vx = bx - ax;
      const vy = by - ay;
      const l2 = vx * vx + vy * vy || 1;
      const u = Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2));
      const dx = px - (ax + vx * u);
      const dy = py - (ay + vy * u);
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        const l = Math.sqrt(l2);
        btx = vx / l;
        bty = vy / l;
        bt = (i + u) / (creekPts.length / 2 - 1);
      }
    }
    return { d: Math.sqrt(best), tx: btx, ty: bty, t: bt };
  };

  const creekBoxX0 = joinX - 60;
  const creekBoxY0 = n * 0.2;
  const creekBoxY1 = joinY + 40;

  for (let j = 0; j < n; j++) {
    const rx = riverX(j + 0.5);
    const dxr = riverDX(j + 0.5);
    const tl = Math.hypot(dxr, 1);
    const rdx = dxr / tl;
    const rdy = 1 / tl;
    const fl = floor(j + 0.5);
    for (let i = 0; i < n; i++) {
      const idx = j * n + i;
      const dCells = Math.abs(i + 0.5 - rx) / tl;
      const d = dCells * m; // meters from river centerline
      const u = i / n;
      const v = j / n;
      // Channel (6 m deep, 110 m wide) with sloped banks.
      const channel = -6.5 * (1 - smooth(40, 75, d));
      // Floodplain: gentle rise with low terraces + noise.
      const plain = 1.2 + 3.2 * smooth(80, 850, d) + 0.7 * fbm(u * 40, v * 40, 3, 5);
      // Valley walls and hills.
      const wallT = smooth(750, 1900, d);
      const hills = 125 * Math.pow(wallT, 1.25) + 70 * wallT * (fbm(u * 5, v * 5, 6, 11) * 0.5 + 0.5) + 18 * wallT * fbm(u * 22, v * 22, 4, 23);
      let z = fl + (d < 75 ? channel + 1.2 * smooth(40, 75, d) : plain) + hills;
      if (d >= 75) z += 0;
      // Bank blend: avoid a step between channel and plain.
      if (d < 110) z = Math.min(z, fl + plain * smooth(60, 110, d) + channel * (1 - smooth(60, 110, d)) + hills);

      let creekW = 0;
      let cdx = rdx;
      let cdy = rdy;
      if (i > creekBoxX0 && j > creekBoxY0 && j < creekBoxY1) {
        const c = segDist(i + 0.5, j + 0.5);
        const dc = c.d * m;
        if (dc < 420) {
          // Steep V valley; creek bed descends from +55 m at the east edge down to the floodplain.
          const bedZ = fl + 1.5 + 60 * Math.pow(1 - c.t, 1.4);
          const carve = z - (bedZ + 1.5 * smooth(0, 14, dc) + (dc / 420) * Math.max(0, z - bedZ) * 0.9);
          const w = 1 - smooth(200, 420, dc);
          if (carve > 0) z -= carve * w;
          const ch = 1 - smooth(6, 16, dc);
          z -= 1.6 * ch;
          creekW = ch * smooth(0.0, 0.06, 1 - c.t);
          if (creekW > 0) {
            cdx = c.tx;
            cdy = c.ty;
          }
        }
      }

      // Western upland pond basin.
      const pd = Math.hypot(u - 0.14, v - 0.2) * n * m;
      if (pd < 380) z -= 9 * (1 - smooth(120, 380, pd));

      ground[idx] = z;
      const valley = 1 - smooth(1100, 1500, d);
      const inProtected = i >= protectedRect.x0 && i <= protectedRect.x1 && j >= protectedRect.y0 && j <= protectedRect.y1;
      flow[idx * 4] = inProtected ? 0 : valley;
      flow[idx * 4 + 1] = creekW;
      flow[idx * 4 + 2] = cdx;
      flow[idx * 4 + 3] = cdy;
    }
  }

  // Flatten the town a little and lift it slightly above the lowest floodplain.
  for (let j = townY0; j <= townY1; j++) {
    for (let i = townX0; i <= townX1; i++) {
      const idx = j * n + i;
      ground[idx] = ground[idx] * 0.5 + (floor(j) + 2.8) * 0.5;
    }
  }

  // Sandbag levee (2 m) around the protected block + concrete floodwall (3.5 m) along the river side.
  const capsule = (ax: number, ay: number, bx: number, by: number, r: number, h: number) => {
    const x0 = Math.floor(Math.min(ax, bx) - r - 2);
    const x1 = Math.ceil(Math.max(ax, bx) + r + 2);
    const y0 = Math.floor(Math.min(ay, by) - r - 2);
    const y1 = Math.ceil(Math.max(ay, by) + r + 2);
    for (let j = Math.max(0, y0); j <= Math.min(n - 1, y1); j++) {
      for (let i = Math.max(0, x0); i <= Math.min(n - 1, x1); i++) {
        const px = i + 0.5;
        const py = j + 0.5;
        const vx = bx - ax;
        const vy = by - ay;
        const l2 = vx * vx + vy * vy || 1;
        const t = Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2));
        const d = Math.hypot(px - ax - vx * t, py - ay - vy * t);
        const w = 1 - smooth(r, r + 1, d);
        if (w > 0) barrier[j * n + i] = Math.max(barrier[j * n + i], h * w);
      }
    }
  };
  const P = protectedRect;
  capsule(P.x0, P.y0, P.x1, P.y0, 0.8, 2.0);
  capsule(P.x0, P.y0, P.x0, P.y1, 0.8, 2.0);
  capsule(P.x0, P.y1, P.x1, P.y1, 0.8, 2.0);
  capsule(P.x1, P.y0, P.x1, P.y1, 0.9, 3.5);

  // ── Roads ───────────────────────────────────────────────────────────────────────────────
  const nodes: number[] = [];
  const edges: RoadEdge[] = [];
  const addNode = (x: number, y: number) => {
    nodes.push(x, y);
    return nodes.length / 2 - 1;
  };
  const addRoad = (pts: number[], cls: RoadClass, name: string) => {
    if (pts.length < 4) return;
    const a = addNode(pts[0], pts[1]);
    const b = addNode(pts[pts.length - 2], pts[pts.length - 1]);
    let len = 0;
    for (let k = 2; k < pts.length; k += 2) len += Math.hypot(pts[k] - pts[k - 2], pts[k + 1] - pts[k - 1]) * m;
    edges.push({ a, b, length: len, cls, name, pts: new Float32Array(pts) });
  };
  const s = n / 1024;
  // Town grid.
  const blk = Math.round(12 * s);
  for (let y = townY0; y <= townY1; y += blk) addRoad([townX0, y, townX1, y], y === townY0 + blk * 3 ? 'major' : 'local', `Street ${y}`);
  for (let x = townX0; x <= townX1; x += blk) addRoad([x, townY0, x, townY1], 'local', `Avenue ${x}`);
  // Highway along the west valley side, following the river at a distance.
  const hw: number[] = [];
  for (let y = 0; y <= n; y += 8 * s) hw.push(riverX(y) - 150 * s, y);
  addRoad(hw, 'highway', 'Valley Highway');
  // Bridge road across the river through the town's main street.
  const by = townY0 + blk * 3;
  const bridge: number[] = [];
  for (let x = townX1; x <= riverX(by) + 260 * s; x += 6 * s) bridge.push(x, by + Math.max(0, x - riverX(by) - 60 * s) * -0.25);
  addRoad(bridge, 'major', 'River Bridge Rd');
  // East bank road.
  const eb: number[] = [];
  for (let y = n * 0.1; y <= n * 0.95; y += 8 * s) eb.push(riverX(y) + 95 * s, y);
  addRoad(eb, 'minor', 'East Bank Rd');
  // Creek road climbing the tributary valley.
  const cr: number[] = [];
  for (let k = creekPts.length - 2; k >= 0; k -= 2) cr.push(creekPts[k] - 22 * s, creekPts[k + 1] + 18 * s);
  addRoad(cr, 'minor', 'Creek Rd');

  return {
    n,
    cellSize: m,
    ground,
    barrier,
    flow,
    roads: { nodes: new Float32Array(nodes), edges },
    riverLevel,
    protectedRect,
    town: { x0: townX0, y0: townY0, x1: townX1, y1: townY1 },
    riverX,
    creek,
  };
}

/** Procedural aerial imagery (browser only). */
export async function buildMockImagery(t: MockTerrain, size = 2048): Promise<ImageBitmap> {
  const n = t.n;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  const D = img.data;
  const sc = n / size;
  const bedAt = (x: number, y: number) => {
    const i = Math.min(n - 1, Math.max(0, Math.floor(x)));
    const j = Math.min(n - 1, Math.max(0, Math.floor(y)));
    return t.ground[j * n + i];
  };
  for (let py = 0; py < size; py++) {
    const gy = (py + 0.5) * sc;
    const rx = t.riverX(gy);
    const lvl = t.riverLevel(gy);
    for (let px = 0; px < size; px++) {
      const gx = (px + 0.5) * sc;
      const z = bedAt(gx, gy);
      const u = gx / n;
      const v = gy / n;
      const dx = (bedAt(gx + 1, gy) - bedAt(gx - 1, gy)) / (2 * t.cellSize);
      const dy = (bedAt(gx, gy + 1) - bedAt(gx, gy - 1)) / (2 * t.cellSize);
      const slope = Math.hypot(dx, dy);
      const dRiver = Math.abs(gx - rx) * t.cellSize;
      let r: number, g: number, b: number;
      const nForest = fbm(u * 60, v * 60, 4, 101) * 0.5 + 0.5;
      const fine = hash2(px, py, 7);
      if (z < lvl + 0.3 && dRiver < 120) {
        // River water (hydro-flattened look).
        r = 58; g = 66; b = 52;
      } else if (dRiver < 1250 && z < lvl + 8) {
        // Floodplain: patchwork fields.
        const fx = Math.floor(u * 38 + fbm(u * 6, v * 6, 2, 3) * 1.5);
        const fy = Math.floor(v * 30);
        const k = hash2(fx, fy, 31);
        const crops = [
          [120, 128, 72], [98, 118, 60], [150, 140, 96], [84, 104, 58], [132, 122, 80],
        ];
        const c = crops[Math.floor(k * crops.length)];
        const tex = 0.9 + 0.2 * fbm(u * 300, v * 300, 2, 9);
        r = c[0] * tex; g = c[1] * tex; b = c[2] * tex;
        if (dRiver < 160) {
          // Riparian trees along the banks.
          const tr = nForest > 0.45 ? 1 : 0.7;
          r = 52 * tr; g = 70 * tr; b = 40 * tr;
        }
      } else {
        // Forest with clearings on the hills.
        const clearing = fbm(u * 9, v * 9, 3, 77) > 0.5;
        if (clearing && slope < 0.18) {
          const k = 0.85 + 0.3 * fbm(u * 90, v * 90, 2, 78);
          r = 96 * k; g = 104 * k; b = 66 * k;
        } else {
          const k = 0.65 + 0.45 * nForest + 0.2 * (fine - 0.5);
          r = 44 * k; g = 62 * k; b = 36 * k;
        }
        if (slope > 0.55) {
          r = r * 0.6 + 105 * 0.4; g = g * 0.6 + 98 * 0.4; b = b * 0.6 + 86 * 0.4;
        }
      }
      // Town blocks.
      const T = t.town;
      if (gx >= T.x0 && gx <= T.x1 && gy >= T.y0 && gy <= T.y1) {
        const bx = Math.floor((gx - T.x0) / 3);
        const byy = Math.floor((gy - T.y0) / 3);
        const k = hash2(bx, byy, 55);
        const roof = k > 0.35;
        const tone = 0.75 + 0.5 * hash2(bx, byy, 56);
        if (roof) {
          r = 150 * tone; g = 138 * tone; b = 126 * tone;
          if (k > 0.8) { r = 120 * tone; g = 70 * tone; b = 58 * tone; }
        } else {
          r = 88; g = 108; b = 64;
        }
      }
      // Baked sun shading like a real photo (sun from SW).
      const shade = Math.max(0.55, Math.min(1.25, 1 + (dx * 0.8 - dy * 0.8) * 1.4));
      const grain = 0.94 + 0.12 * fine;
      const o = (py * size + px) * 4;
      D[o] = Math.min(255, r * shade * grain);
      D[o + 1] = Math.min(255, g * shade * grain);
      D[o + 2] = Math.min(255, b * shade * grain);
      D[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // Roads painted over the imagery.
  ctx.lineCap = 'round';
  for (const e of t.roads.edges) {
    ctx.strokeStyle = e.cls === 'highway' ? '#8d8a84' : e.cls === 'major' ? '#9a968e' : '#a9a49a';
    ctx.lineWidth = ((e.cls === 'highway' ? 22 : e.cls === 'major' ? 15 : 9) / t.cellSize) / sc;
    ctx.beginPath();
    for (let k = 0; k < e.pts.length; k += 2) {
      const x = e.pts[k] / sc;
      const y = e.pts[k + 1] / sc;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  return createImageBitmap(canvas);
}
