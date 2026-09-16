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
import type { CameraPose, GeoBounds, ScenarioPreset, Shelter, TerrainData, WaterSource } from '../contracts';
import { gridToGeo, squareDomain } from './geo';
import { smoothstep } from './hydro';
import { buildRoadNetwork, type RawRoad } from './roads';
import { makeGeoToGrid } from './geo';

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

function polylineInfo(px: number, py: number, pts: Array<[number, number]>, cum: number[]): PolyInfo {
  let best = Infinity;
  let bestS = 0;
  const total = cum[cum.length - 1];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const d = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (d < best) {
      best = d;
      bestS = (cum[k] + t * Math.sqrt(l2)) / total;
    }
  }
  return { dist: best, s: bestS };
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
  const damS = (tribCum[1] + 0.1 * (tribCum[2] - tribCum[1])) / tribLen;
  const lakeEndS = (tribCum[2] + 0.35 * (tribCum[3] - tribCum[2])) / tribLen;
  const confLevel = riverLevel(yConf);
  const RES_LEVEL = 138;
  const DAM_CREST = 141.5;
  const tribBed = (s: number) => {
    if (s <= damS) return confLevel + 0.4 + (119 - confLevel) * (s / damS);
    if (s <= lakeEndS) return 125 + 11 * ((s - damS) / (lakeEndS - damS)) ** 1.5;
    return 139.5 + 45 * (s - lakeEndS);
  };
  const damPoint: [number, number] = [
    trib[1][0] + 0.1 * (trib[2][0] - trib[1][0]),
    trib[1][1] + 0.1 * (trib[2][1] - trib[1][1]),
  ];
  const damDir = [trib[2][0] - trib[1][0], trib[2][1] - trib[1][1]];
  const damDirLen = Math.hypot(damDir[0], damDir[1]);
  damDir[0] /= damDirLen;
  damDir[1] /= damDirLen;

  const elevation = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    const yc = j + 0.5;
    const rx = riverX(yc);
    const Ls = riverLevel(yc);
    for (let i = 0; i < N; i++) {
      const xc = i + 0.5;
      const xm = xc * cs;
      const ym = yc * cs;
      const hills = fbm(xm, ym, 1600, 5, 11);
      const detail = fbm(xm, ym, 220, 3, 29);

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
      const t = polylineInfo(xc, yc, trib, tribCum);
      const dt = t.dist * cs;
      const bed = tribBed(t.s);
      const tz = bed + 1.2 + 0.004 * dt + 70 * smoothstep(120, 650, dt) + 22 * hills * smoothstep(200, 600, dt) + 0.4 * detail;
      z = Math.min(z, tz);
      // Creek channel below the dam and above the lake.
      if (t.s < damS - 0.01 || t.s > lakeEndS) {
        z = Math.min(z, bed + 1.2 - 1.6 * (1 - smoothstep(4, 14, dt)));
      }
      // Dam: a thick wall across the tributary valley with sloped faces.
      const ax = (xc - damPoint[0]) * damDir[0] + (yc - damPoint[1]) * damDir[1]; // along valley, cells
      const across = Math.abs(-(xc - damPoint[0]) * damDir[1] + (yc - damPoint[1]) * damDir[0]) * cs;
      if (Math.abs(ax) < 12 && across < 520) {
        const face = DAM_CREST - Math.max(0, Math.abs(ax) * cs - 10) * 0.9;
        z = Math.max(z, face);
      }

      // River channel with smooth banks.
      const dc = Math.abs(xc - rx);
      const chan = Ls - riverDepth * (1 - smoothstep(riverHalfW * 0.45, riverHalfW * 1.15, dc)) + 0.4;
      if (dc < riverHalfW * 1.6) z = Math.min(z, chan);

      elevation[j * N + i] = z;
    }
  }

  // ── Roads (built through the same noding pipeline as real data).
  const toGeo = (gx: number, gy: number): [number, number] => {
    const g = gridToGeo({ nx: N, ny: N, bounds }, gx, gy);
    return [g.lon, g.lat];
  };
  const elevAt = (gx: number, gy: number) => {
    const i = Math.min(N - 1, Math.max(0, Math.floor(gx)));
    const j = Math.min(N - 1, Math.max(0, Math.floor(gy)));
    return elevation[j * N + i];
  };
  const raw: RawRoad[] = [];
  const addRoad = (pts: Array<[number, number]>, cls: RawRoad['cls'], name?: string) => {
    if (pts.length >= 2) raw.push({ coords: pts.map(([x, y]) => toGeo(x, y)), cls, name });
  };
  const step = 4;
  // Highway on the west valley wall.
  {
    const pts: Array<[number, number]> = [];
    for (let y = 0; y <= N; y += step) pts.push([riverX(y) - 1250 / cs + 60 * Math.sin(y / 90), y]);
    addRoad(pts, 'highway', 'Valley Expressway');
  }
  // Main St and River Rd on the east floodplain.
  {
    const main: Array<[number, number]> = [];
    const river: Array<[number, number]> = [];
    for (let y = 0.12 * N; y <= 0.88 * N; y += step) {
      main.push([riverX(y) + 330 / cs, y]);
      river.push([riverX(y) + 95 / cs, y]);
    }
    addRoad(main, 'major', 'Main St');
    addRoad(river, 'minor', 'River Rd');
  }
  // Bridge St: highway → across the river → Main St → up the east hill (Ridge Rd).
  const yBridge = 0.56 * N;
  {
    const x0 = riverX(yBridge) - 1250 / cs + 60 * Math.sin(yBridge / 90);
    const x1 = riverX(yBridge) + 330 / cs;
    addRoad(
      [
        [x0, yBridge],
        [riverX(yBridge), yBridge],
        [x1, yBridge],
      ],
      'major',
      'Bridge St',
    );
    const ridge: Array<[number, number]> = [];
    for (let x = x1; x <= Math.min(N, x1 + 1500 / cs); x += step) ridge.push([x, yBridge - 0.25 * (x - x1) + 30 * Math.sin((x - x1) / 60)]);
    ridge[0] = [x1, yBridge];
    addRoad(ridge, 'major', 'Ridge Rd');
  }
  // Town street grid (only on land that is not river, creek, reservoir or dam).
  const inTown = (x: number, y: number) => {
    const dx = x - riverX(y);
    if (dx < 90 / cs || dx > 780 / cs) return false;
    if (y < 0.24 * N || y > 0.78 * N) return false;
    const t = polylineInfo(x, y, trib, tribCum);
    if (t.dist * cs < 30) return false;
    return elevAt(x, y) < riverLevel(y) + 26;
  };
  const spacing = 110 / cs;
  const streetNames = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th', '11th', '12th', '13th', '14th', '15th', '16th', '17th', '18th', '19th', '20th', '21st', '22nd', '23rd', '24th', '25th', '26th', '27th', '28th', '29th', '30th', '31st', '32nd'];
  let si = 0;
  for (let y = 0.24 * N; y <= 0.78 * N; y += spacing) {
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length >= 3) addRoad(run, 'local', `${streetNames[si % streetNames.length]} St`);
      run = [];
    };
    for (let x = riverX(y) + 90 / cs; x <= riverX(y) + 780 / cs; x += 2) {
      if (inTown(x, y)) run.push([x, y]);
      else flush();
    }
    flush();
    si++;
  }
  const avenueNames = ['Water', 'Mill', 'Oak', 'Maple', 'Cedar', 'Hill', 'Summit'];
  avenueNames.forEach((nm, a) => {
    const off = (140 + a * 105) / cs;
    let run: Array<[number, number]> = [];
    const flush = () => {
      if (run.length >= 3) addRoad(run, 'local', `${nm} Ave`);
      run = [];
    };
    for (let y = 0.24 * N; y <= 0.78 * N; y += 2) {
      const x = riverX(y) + off;
      if (inTown(x, y)) run.push([x, y]);
      else flush();
    }
    flush();
  });
  // Dam road across the crest.
  {
    const nxp = -damDir[1];
    const nyp = damDir[0];
    const pts: Array<[number, number]> = [];
    for (let s = -560 / cs; s <= 560 / cs; s += step) pts.push([damPoint[0] + nxp * s, damPoint[1] + nyp * s]);
    addRoad(pts, 'minor', 'Dam Rd');
  }
  const roads = buildRoadNetwork(raw, { nx: N, ny: N, cellSize: cs, toGrid: makeGeoToGrid({ nx: N, ny: N, bounds }) });

  // ── Shelters: the highest road node inside each search box.
  const nodeAtHighest = (x0: number, y0: number, x1: number, y1: number): { gx: number; gy: number } => {
    let best = { gx: (x0 + x1) / 2, gy: (y0 + y1) / 2 };
    let bestZ = -Infinity;
    for (let k = 0; k < roads.nodes.length / 2; k++) {
      const gx = roads.nodes[k * 2];
      const gy = roads.nodes[k * 2 + 1];
      if (gx < x0 || gx > x1 || gy < y0 || gy > y1) continue;
      const z = elevAt(gx, gy);
      if (z > bestZ) {
        bestZ = z;
        best = { gx, gy };
      }
    }
    return best;
  };
  const xb = riverX(yBridge) + 330 / cs;
  const shelters: Shelter[] = [
    { name: 'Ridge Rd School', ...nodeAtHighest(xb + 900 / cs, yBridge - 300 / cs, xb + 1300 / cs, yBridge - 60 / cs) },
    { name: 'Valley Hospital', ...nodeAtHighest(0, 0.55 * N, riverX(0.6 * N) - 900 / cs, 0.72 * N) },
    { name: 'Dam Rd Fire Station', ...nodeAtHighest(damPoint[0] - 110, damPoint[1] - 110, damPoint[0] + 110, damPoint[1] + 110) },
  ];

  // ── Scenario.
  const levelSouth = riverLevel(N - 6);
  const sources: WaterSource[] = [
    { id: 'river-in', type: 'inflow', gx: riverX(8) + 0, gy: 8, radius: riverHalfW * 0.8, discharge: 180, label: 'Clear River inflow' },
    { id: 'river-stage', type: 'stage', gx: riverX(N - 8), gy: N - 8, radius: riverHalfW * 0.8, level: levelSouth, label: 'Riverside gauge' },
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
