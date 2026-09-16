/**
 * `sandbox` — a synthetic river valley generated in code (no network, instant, deterministic).
 *
 * Layout (north up): a meandering river flows north → south along a 900 m-wide floodplain between wooded
 * hills. A tributary enters from the east; half-way up it a concrete dam holds back a reservoir. The town of
 * "Riverside" sits on the east floodplain around the confluence, with a street grid, Main St, a bridge to the
 * highway on the west valley wall, and shelters on the hills.
 *
 * The river is carved with a real channel (no hydro-conditioning needed) and the scenario uses the same
 * sloped-river initial fill (per-seed levels) as the baked presets.
 */
import type { CameraPose, GeoBounds, RoadClass, ScenarioPreset, Shelter, TerrainData, WaterSource } from '../contracts';
import { squareDomain } from './geo';
import { smoothstep } from './hydro';
import { buildRoadNetwork, nodeCrossings, type RawRoad } from './roads';

export const SANDBOX_NAME = 'Riverside — synthetic valley';

// ── Deterministic noise ────────────────────────────────────────────────────────────────────────
function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v; // [0,1]
}

/** Fractal noise in [-1, 1]. x, y in meters; `scale` = largest feature size in meters. */
function fbm(x: number, y: number, scale: number, octaves: number, seed: number): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1 / scale;
  for (let o = 0; o < octaves; o++) {
    sum += amp * (valueNoise(x * f, y * f, seed + o * 17) * 2 - 1);
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

// ── Geometry helpers ───────────────────────────────────────────────────────────────────────────
interface PolyInfo {
  dist: number; // cells
  s: number; // 0..1 along the polyline
}

/** A polyline prepared for fast repeated distance queries (flat typed arrays, precomputed segment data). */
interface PreparedPolyline {
  /** Per segment: ax, ay, dx, dy, 1/len², len, cumulative start length. */
  seg: Float64Array;
  count: number;
  total: number;
  /** Scratch: per-segment distance and parameter of the last query. */
  d: Float64Array;
  s: Float64Array;
}

function preparePolyline(pts: Array<[number, number]>): PreparedPolyline {
  const count = pts.length - 1;
  const seg = new Float64Array(count * 7);
  let cum = 0;
  for (let k = 0; k < count; k++) {
    const dx = pts[k + 1][0] - pts[k][0];
    const dy = pts[k + 1][1] - pts[k][1];
    const len = Math.hypot(dx, dy);
    seg.set([pts[k][0], pts[k][1], dx, dy, 1 / (len * len), len, cum], k * 7);
    cum += len;
  }
  return { seg, count, total: cum, d: new Float64Array(count), s: new Float64Array(count) };
}

/**
 * Distance (cells) to a polyline and the normalized arc-length parameter of the nearest point. The parameter is a
 * soft-min blend over segments (weights fall off over ~12 cells of extra distance): the plain nearest-segment
 * parameter jumps across the bisector on the inside of a bend, which would crease any terrain built from it.
 */
function polylineInfo(px: number, py: number, P: PreparedPolyline): PolyInfo {
  const { seg, count, d, s } = P;
  let best = Infinity;
  for (let k = 0; k < count; k++) {
    const o = k * 7;
    const dx = seg[o + 2];
    const dy = seg[o + 3];
    let t = ((px - seg[o]) * dx + (py - seg[o + 1]) * dy) * seg[o + 4];
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - (seg[o] + dx * t);
    const ey = py - (seg[o + 1] + dy * t);
    const dist = Math.sqrt(ex * ex + ey * ey);
    d[k] = dist;
    s[k] = (seg[o + 6] + t * seg[o + 5]) / P.total;
    if (dist < best) best = dist;
  }
  let wsum = 0;
  let acc = 0;
  for (let k = 0; k < count; k++) {
    const extra = d[k] - best;
    if (extra > 120) continue; // weight < e^-10
    const w = Math.exp(-extra / 12);
    wsum += w;
    acc += w * s[k];
  }
  return { dist: best, s: acc / wsum };
}

/**
 * A smooth field evaluated on a lattice every `step` cells and bilinearly interpolated at cell centers — the
 * low-frequency noise octaves don't need per-cell evaluation (keeps generation well under half a second).
 */
function latticeField(n: number, step: number, fn: (xc: number, yc: number) => number): (i: number, j: number) => number {
  const m = Math.ceil(n / step) + 2;
  const v = new Float32Array(m * m);
  for (let b = 0; b < m; b++) for (let a = 0; a < m; a++) v[b * m + a] = fn(a * step, b * step);
  return (i, j) => {
    const fx = (i + 0.5) / step;
    const fy = (j + 0.5) / step;
    const a = Math.floor(fx);
    const b = Math.floor(fy);
    const tx = fx - a;
    const ty = fy - b;
    const k = b * m + a;
    return (v[k] * (1 - tx) + v[k + 1] * tx) * (1 - ty) + (v[k + m] * (1 - tx) + v[k + m + 1] * tx) * ty;
  };
}

function cumulative(pts: Array<[number, number]>): number[] {
  const c = [0];
  for (let k = 1; k < pts.length; k++) c.push(c[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
  return c;
}

export interface SandboxOptions {
  /** Grid size (multiple of 16). Default 1024. */
  n?: number;
  /** Cell size, meters. Default 6. */
  cellSize?: number;
}

/**
 * Generate the synthetic valley. Everything is expressed in fractions of the domain so any `n` works; the
 * ground size is n × cellSize.
 */
export function generateSandbox(opts: SandboxOptions = {}): TerrainData {
  const N = opts.n ?? 1024;
  const cs = opts.cellSize ?? 6;
  const size = N * cs;
  const { bounds } = squareDomain({ lat: 40.2, lon: -100.3 }, size);

  // River centerline x (cells) as a function of y (cells) and its water surface level.
  const riverX = (y: number) => N * (0.4 + 0.07 * Math.sin((2 * Math.PI * y) / N * 1.15 + 0.5) + 0.025 * Math.sin((2 * Math.PI * y) / N * 2.9));
  const riverLevel = (y: number) => 112 - 9 * (y / N); // ~1.5 m/km
  const riverHalfW = 32 / cs; // 64 m wide river
  const riverDepth = 3.2;

  // Tributary: confluence → east edge. Dam part-way along.
  const yConf = 0.47 * N;
  const trib: Array<[number, number]> = [
    [riverX(yConf), yConf],
    [0.6 * N, 0.41 * N],
    [0.8 * N, 0.31 * N],
    [N + 2, 0.27 * N],
  ];
  const tribCum = cumulative(trib);
  const tribLen = tribCum[tribCum.length - 1];
  const tribPoly = preparePolyline(trib);
  const damS = (tribCum[1] + 0.1 * (tribCum[2] - tribCum[1])) / tribLen;
  const lakeEndS = (tribCum[2] + 0.35 * (tribCum[3] - tribCum[2])) / tribLen;
  const confLevel = riverLevel(yConf);
  const RES_LEVEL = 138;
  const DAM_CREST = 141.5;
  // Creek bed profile along the tributary — continuous in s (any jump would print a straight crease across the
  // hills, since every cell whose nearest creek point has that parameter inherits the step).
  const DAM_TOE = 119;
  const LAKE_END_BED = 138.5;
  const tribBed = (s: number) => {
    if (s <= damS) return confLevel + 0.4 + (DAM_TOE - confLevel - 0.4) * (s / damS);
    if (s <= lakeEndS) return DAM_TOE + (LAKE_END_BED - DAM_TOE) * ((s - damS) / (lakeEndS - damS)) ** 1.5;
    return LAKE_END_BED + 45 * (s - lakeEndS);
  };
  /** Weight of the incised creek channel: 0 in the reservoir reach, ramping in below the dam / above the lake. */
  const creekWeight = (s: number) => Math.max(smoothstep(damS - 0.01, damS - 0.05, s), smoothstep(lakeEndS, lakeEndS + 0.04, s));
  const damPoint: [number, number] = [
    trib[1][0] + 0.1 * (trib[2][0] - trib[1][0]),
    trib[1][1] + 0.1 * (trib[2][1] - trib[1][1]),
  ];
  const damDir = [trib[2][0] - trib[1][0], trib[2][1] - trib[1][1]];
  const damDirLen = Math.hypot(damDir[0], damDir[1]);
  damDir[0] /= damDirLen;
  damDir[1] /= damDirLen;

  const hillsAt = latticeField(N, Math.max(1, Math.round(24 / cs)), (x, y) => fbm(x * cs, y * cs, 1600, 5, 11));
  const detailAt = latticeField(N, Math.max(1, Math.round(12 / cs)), (x, y) => fbm(x * cs, y * cs, 220, 3, 29));
  const elevation = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const yc = j + 0.5;
    const rx = riverX(yc);
    const Ls = riverLevel(yc);
    for (let i = 0; i < N; i++) {
      const xc = i + 0.5;
      const hills = hillsAt(i, j);
      const detail = detailAt(i, j);

      // Main valley.
      const d = Math.abs(xc - rx) * cs; // meters from river centerline
      let z =
        Ls +
        2.6 +
        0.0025 * d +
        95 * smoothstep(420, 1700, d) +
        38 * hills * smoothstep(350, 1200, d) +
        0.6 * detail * smoothstep(60, 200, d);

      // Tributary valley (+ reservoir behind the dam).
      const t = polylineInfo(xc, yc, tribPoly);
      const dt = t.dist * cs;
      const bed = tribBed(t.s);
      const tz = bed + 1.2 + 0.004 * dt + 70 * smoothstep(120, 650, dt) + 22 * hills * smoothstep(200, 600, dt) + 0.4 * detail;
      z = Math.min(z, tz);
      // Creek channel (≈ 20 m wide) below the dam and above the lake — only near the creek itself.
      if (dt < 14) {
        const w = creekWeight(t.s);
        if (w > 0) z = Math.min(z, bed + 1.2 - 1.6 * w * (1 - smoothstep(4, 14, dt)));
      }
      // Dam: a thick wall across the tributary valley with sloped faces.
      const ax = (xc - damPoint[0]) * damDir[0] + (yc - damPoint[1]) * damDir[1]; // along valley, cells
      const across = Math.abs(-(xc - damPoint[0]) * damDir[1] + (yc - damPoint[1]) * damDir[0]) * cs;
      if (Math.abs(ax) < 12 && across < 520) {
        const face = DAM_CREST - Math.max(0, Math.abs(ax) * cs - 10) * 0.9;
        z = Math.max(z, face);
      }

      // River channel: bed at Ls − depth in the middle, smooth banks rising to the floodplain (Ls + 2.6 m) with
      // the water's edge (bed = Ls) at about one half-width from the centerline.
      const dc = Math.abs(xc - rx);
      if (dc < riverHalfW * 1.5) {
        z = Math.min(z, Ls - riverDepth + (riverDepth + 2.6) * smoothstep(riverHalfW * 0.3, riverHalfW * 1.5, dc));
      }

      elevation[j * N + i] = z;
    }
  }

  // ── Roads: laid out in grid coordinates, noded at every crossing / T-junction, then built into a graph by the
  //    same pipeline as real TIGER data (identity projection).
  const elevAt = (gx: number, gy: number) => {
    const i = Math.min(N - 1, Math.max(0, Math.floor(gx)));
    const j = Math.min(N - 1, Math.max(0, Math.floor(gy)));
    return elevation[j * N + i];
  };
  type Pt = [number, number];
  const lines: Array<{ pts: Pt[]; cls: RoadClass; name: string }> = [];
  const addRoad = (pts: Pt[], cls: RoadClass, name: string) => {
    if (pts.length >= 2) lines.push({ pts, cls, name });
  };
  const hwX = (y: number) => riverX(y) - 1250 / cs + 60 * Math.sin(y / 90);

  // Valley Expressway along the west valley wall.
  {
    const pts: Pt[] = [];
    for (let y = 0; y <= N; y += 4) pts.push([hwX(y), y]);
    addRoad(pts, 'highway', 'Valley Expressway');
  }

  // Town lattice on the east floodplain: numbered streets across the valley (rows), avenues parallel to the
  // river (columns, following its meander). Lattice points are computed once so rows and columns share them.
  const inTown = (x: number, y: number) => {
    const dx = x - riverX(y);
    if (dx < 90 / cs || dx > 780 / cs) return false;
    if (polylineInfo(x, y, tribPoly).dist * cs < 30) return false;
    return elevAt(x, y) < riverLevel(y) + 26;
  };
  const rowStep = 110 / cs;
  const rows: number[] = [];
  for (let y = 0.24 * N; y <= 0.78 * N + 1e-6; y += rowStep) rows.push(y);
  const bridgeRow = Math.round((0.56 * N - rows[0]) / rowStep);
  const yBridge = rows[bridgeRow];
  const cols: Array<{ off: number; name: string; cls: RoadClass; arterial?: boolean }> = [
    { off: 95, name: 'River Rd', cls: 'minor', arterial: true },
    { off: 205, name: 'Water Ave', cls: 'local' },
    { off: 330, name: 'Main St', cls: 'major', arterial: true },
    { off: 440, name: 'Mill Ave', cls: 'local' },
    { off: 550, name: 'Oak Ave', cls: 'local' },
    { off: 660, name: 'Maple Ave', cls: 'local' },
    { off: 770, name: 'Hill Ave', cls: 'local' },
  ];
  const lattice = (c: number, y: number): Pt => [riverX(y) + cols[c].off / cs, y];
  const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`;
  /** Emit maximal runs of consecutive samples whose connecting pieces are all inside the town. */
  const addRuns = (samples: Pt[], ok: (a: Pt, b: Pt) => boolean, cls: RoadClass, name: string) => {
    let run: Pt[] = [];
    for (let q = 0; q < samples.length; q++) {
      if (q > 0 && ok(samples[q - 1], samples[q])) {
        if (!run.length) run.push(samples[q - 1]);
        run.push(samples[q]);
      } else {
        addRoad(run, cls, name);
        run = [];
      }
    }
    addRoad(run, cls, name);
  };
  const pieceInTown = (a: Pt, b: Pt) => inTown(a[0], a[1]) && inTown(b[0], b[1]) && inTown((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  rows.forEach((y, r) => {
    const samples = cols.map((_, c) => lattice(c, y));
    if (r === bridgeRow) addRuns(samples, pieceInTown, 'major', 'Bridge St');
    else addRuns(samples, pieceInTown, 'local', `${ordinal(r + 1)} St`);
  });
  cols.forEach((col, c) => {
    // Arterials run the length of the valley (bridging the creek); avenues stay inside the town.
    const y0 = col.arterial ? 0.12 * N : rows[0];
    const y1 = col.arterial ? 0.88 * N : rows[rows.length - 1];
    const ys: number[] = [];
    for (let y = y0; y < rows[0]; y += 4) ys.push(y);
    rows.forEach((ry, r) => {
      ys.push(ry);
      if (r + 1 < rows.length) for (let k = 1; k < 4; k++) ys.push(ry + (k * rowStep) / 4);
    });
    for (let y = rows[rows.length - 1] + 4; y <= y1; y += 4) ys.push(y);
    const samples = ys.filter((y) => y >= y0 - 1e-6 && y <= y1 + 1e-6).map((y) => lattice(c, y));
    addRuns(samples, col.arterial ? () => true : pieceInTown, col.cls, col.name);
  });

  // Bridge St (west half): expressway → across the Clear River → River Rd.
  addRoad([[hwX(yBridge), yBridge], [riverX(yBridge), yBridge], lattice(0, yBridge)], 'major', 'Bridge St');
  // North bridge: expressway → Main St at the north end of town (a second way out when Bridge St floods).
  const yNorth = 0.16 * N;
  addRoad([[hwX(yNorth), yNorth], [riverX(yNorth), yNorth], lattice(2, yNorth)], 'major', 'Mill Bridge Rd');
  // South bridge: expressway → Main St south of town.
  const ySouth = 0.84 * N;
  addRoad([[hwX(ySouth), ySouth], [riverX(ySouth), ySouth], lattice(2, ySouth)], 'major', 'Ferry Rd');

  // Ridge Rd climbs east from the end of Bridge St into the hills.
  let bridgeEast = lattice(0, yBridge);
  for (let c = 1; c < cols.length && inTown(...lattice(c, yBridge)); c++) bridgeEast = lattice(c, yBridge);
  const ridge: Pt[] = [bridgeEast];
  for (let dx = 4; dx <= 1500 / cs && bridgeEast[0] + dx < N - 4; dx += 4) {
    ridge.push([bridgeEast[0] + dx, yBridge - 0.28 * dx + 8 * Math.sin(dx / 35)]);
  }
  addRoad(ridge, 'major', 'Ridge Rd');

  // Dam Rd: from Ridge Rd across the dam crest to a fire station on the north abutment.
  const damPerp: Pt = [-damDir[1], damDir[0]];
  const damSouth: Pt = [damPoint[0] + damPerp[0] * (560 / cs), damPoint[1] + damPerp[1] * (560 / cs)];
  let ridgeJoin = ridge[0];
  for (const p of ridge) if (Math.hypot(p[0] - damSouth[0], p[1] - damSouth[1]) < Math.hypot(ridgeJoin[0] - damSouth[0], ridgeJoin[1] - damSouth[1])) ridgeJoin = p;
  {
    const pts: Pt[] = [ridgeJoin];
    for (let s = 560 / cs; s >= -560 / cs; s -= 4) pts.push([damPoint[0] + damPerp[0] * s, damPoint[1] + damPerp[1] * s]);
    addRoad(pts, 'minor', 'Dam Rd');
  }
  // Hospital Dr: a spur climbing west off the expressway.
  const yHosp = 0.66 * N;
  const hospital: Pt[] = [];
  for (let k = 0; k <= 20; k++) hospital.push([hwX(yHosp) - k * 4, yHosp + 12 * Math.sin(k / 6)]);
  addRoad(hospital, 'minor', 'Hospital Dr');

  const noded = nodeCrossings(lines.map((l) => l.pts.flat()), 1.5);
  const raw: RawRoad[] = lines.map((l, idx) => {
    const flat = noded[idx];
    const coords: Array<[number, number]> = [];
    for (let q = 0; q < flat.length; q += 2) coords.push([flat[q], flat[q + 1]]);
    return { coords, cls: l.cls, name: l.name };
  });
  const roads = buildRoadNetwork(raw, { nx: N, ny: N, cellSize: cs, toGrid: (x, y) => [x, y] }, { minComponentMeters: 100 });

  // ── Shelters at the high ends of the spur roads (all reachable through the network).
  const endOf = (pts: Pt[]) => pts[pts.length - 1];
  const damNorth = [damPoint[0] - damPerp[0] * (560 / cs), damPoint[1] - damPerp[1] * (560 / cs)];
  const nearestNode = (p: ArrayLike<number>) => {
    let best = 0;
    let bestD = Infinity;
    for (let k = 0; k < roads.nodes.length / 2; k++) {
      const d = Math.hypot(roads.nodes[k * 2] - p[0], roads.nodes[k * 2 + 1] - p[1]);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return { gx: roads.nodes[best * 2], gy: roads.nodes[best * 2 + 1] };
  };
  const shelters: Shelter[] = [
    { name: 'Ridge Rd School', ...nearestNode(endOf(ridge)) },
    { name: 'Valley Hospital', ...nearestNode(endOf(hospital)) },
    { name: 'Lakeview Fire Station', ...nearestNode(damNorth) },
  ];
  // ── Scenario.
  const levelSouth = riverLevel(N - 6);
  const sources: WaterSource[] = [
    { id: 'river-in', type: 'inflow', gx: riverX(8) + 0, gy: 8, radius: Math.round(riverHalfW * 8) / 10, discharge: 180, label: 'Clear River inflow' },
    { id: 'river-stage', type: 'stage', gx: riverX(N - 8), gy: N - 8, radius: Math.round(riverHalfW * 8) / 10, level: levelSouth, label: 'Riverside gauge' },
  ];
  const riverSeeds: Array<{ gx: number; gy: number; level: number }> = [];
  for (let y = 4; y < N - 4; y += 12) riverSeeds.push({ gx: riverX(y + 0.5), gy: y + 0.5, level: riverLevel(y + 0.5) });
  // One fill for the whole river (per-seed levels; fill.level is the conservative minimum).
  const initialFill: ScenarioPreset['initialFill'] = [{ seeds: riverSeeds, level: Math.min(...riverSeeds.map((s) => s.level)) }];
  const lakeSeed: [number, number] = [
    trib[1][0] + 0.55 * (trib[2][0] - trib[1][0]),
    trib[1][1] + 0.55 * (trib[2][1] - trib[1][1]),
  ];
  initialFill.push({ seeds: [{ gx: lakeSeed[0], gy: lakeSeed[1] }], level: RES_LEVEL });

  const datum = levelSouth - 1.5;
  const camera: CameraPose = {
    target: { gx: riverX(0.5 * N) + 60, gy: 0.5 * N, elevation: 120 },
    distance: size * 0.95,
    yaw: -0.55,
    pitch: 0.62,
  };
  const scenario: ScenarioPreset = {
    description:
      'Riverside is a made-up river town generated entirely in code — no network needed. The Clear River ' +
      'meanders through a floodplain town; a concrete dam holds a reservoir in the side valley above it. ' +
      'Raise the river stage to push water into the street grid, drop a storm on the hills, or dig through ' +
      'the dam with the terrain tool and watch the flood wave race down the creek toward Main St.',
    sources,
    storms: [{ id: 'storm-hills', gx: lakeSeed[0], gy: lakeSeed[1] + 40, radius: 170, intensity: 35 }],
    shelters,
    rainRate: 0,
    stage: {
      label: 'Clear River at Riverside (synthetic gauge)',
      gaugeDatum: datum,
      normalLevel: levelSouth,
      floodStageFt: Math.round(((levelSouth + 2.6 - datum) / 0.3048) * 10) / 10,
      marks: [{ label: 'Design flood', ft: Math.round(((levelSouth + 5 - datum) / 0.3048) * 10) / 10 }],
      maxOffset: 8,
    },
    initialFill,
    camera,
  };

  const b: GeoBounds = bounds;
  return {
    name: SANDBOX_NAME,
    nx: N,
    ny: N,
    cellSize: cs,
    elevation,
    bounds: b,
    imagery: null,
    roads,
    attribution: 'Synthetic terrain generated in the browser',
    scenario,
  };
}
