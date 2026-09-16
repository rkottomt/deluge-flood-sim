/// <reference types="node" />
/**
 * Bake real-world presets into public/presets/<id>/{meta.json, elevation.f32, imagery.jpg, roads.json}.
 *
 *   npx tsx scripts/bake-presets.ts            # all presets
 *   npx tsx scripts/bake-presets.ts johnstown  # one preset
 *
 * Steps per preset: USGS 3DEP DEM (1024²) → no-data/seam repair → river centerlines from waypoints →
 * pool level measured from the DEM → channel burn with smooth banks → sources placed on the channel spine at
 * the domain edges → initial fill seeds along the centerlines (verified: no water outside the channel) →
 * shelters snapped to high road nodes (verified above the maximum stage) → Esri imagery 2048² JPEG →
 * TIGERweb roads → compact roads.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { CameraPose, ScenarioPreset, Shelter, StageControl, StormCell, WaterSource } from '../src/contracts';
import { fetchDEM } from '../src/data/dem';
import { geoToGrid, squareDomain } from '../src/data/geo';
import { burnRivers, edgeRuns, edgeStageDisc, findRiverEnds, flatThreshold, localRelief, type BurnResult, type RiverSpec } from '../src/data/hydro';
import { fetchImageryBytes, IMAGERY_ATTRIBUTION } from '../src/data/imagery';
import { computeInitialWater } from '../src/data/initialWater';
import { type PresetMeta, PRESETS, validatePresetMeta } from '../src/data/presets';
import { buildRoadNetwork, encodeRoads, fetchTigerRoads, type RawRoad, ROADS_ATTRIBUTION_TIGER, roadStats } from '../src/data/roads';
import { makeGeoToGrid } from '../src/data/geo';

const FT = 0.3048;
const CFS = 0.0283168; // m³/s per ft³/s
type LonLat = [number, number];

interface RiverDef {
  name: string;
  /** Waypoints upstream → downstream, [lon, lat]. */
  path: LonLat[];
  depth: number;
  bankCells?: number;
  snapRadius?: number;
  maxHalfWidth?: number;
  /** Source created where the UPSTREAM end meets the domain edge. */
  upstream?: { type: 'inflow'; discharge: number; label: string } | { type: 'stage'; label: string };
  /** Source created where the DOWNSTREAM end meets the domain edge. */
  downstream?: { type: 'stage'; label: string };
}

interface PresetDef {
  id: string;
  center: { lat: number; lon: number };
  sizeMeters: number;
  n: number;
  rivers: RiverDef[];
  /** Flat navigation pool: measured from the DEM near this initial guess (m). */
  pool?: { guess: number };
  stage?: Omit<StageControl, 'normalLevel'> & { normalLevel?: number };
  shelters: Array<{ name: string; at: LonLat; /** search radius for a high road node, m */ search?: number }>;
  storms: Array<{ id: string; at: LonLat; radiusMeters: number; intensity: number }>;
  rainRate: number;
  camera: { at: LonLat; distance: number; yaw: number; pitch: number };
  description: (ctx: { normalLevel: number | null; gaugeDatum: number | null }) => string;
}

const PRESET_DEFS: PresetDef[] = [
  {
    id: 'pittsburgh',
    center: { lat: 40.444, lon: -79.99 },
    sizeMeters: 8000,
    n: 1024,
    pool: { guess: 216.4 },
    rivers: [
      {
        name: 'Allegheny River',
        path: [[-79.96386, 40.47954], [-79.97815, 40.45954], [-79.99567, 40.44902], [-80.0095, 40.4434]],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        upstream: { type: 'stage', label: 'Allegheny River' },
      },
      {
        name: 'Monongahela River',
        path: [[-79.95279, 40.4083], [-79.95602, 40.42515], [-79.97262, 40.43358], [-79.99567, 40.43498], [-80.01043, 40.43989]],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        upstream: { type: 'stage', label: 'Monongahela River' },
      },
      {
        name: 'Ohio River',
        path: [[-80.01411, 40.44235], [-80.0261, 40.44621], [-80.03671, 40.45674]],
        depth: 6,
        bankCells: 3,
        maxHalfWidth: 400,
        downstream: { type: 'stage', label: 'Ohio River' },
      },
    ],
    stage: {
      label: 'Ohio River at Pittsburgh (Point gauge, USGS 03085152)',
      // USGS 03085152 gage datum: 693.6 ft above NAVD88 (GNSS survey). NOAA VERTCON 3.0 at the Point gives
      // NAVD88 = NGVD29 − 0.161 m (−0.53 ft), so the Emsworth pool's 710.0 ft NGVD29 is 216.25 m NAVD88 — the
      // bake measures the flat pool surface in the DEM (≈ 216.3 m) and it reads ≈ 16 ft on this gauge.
      gaugeDatum: 693.6 * FT,
      floodStageFt: 25,
      marks: [
        { label: '2004 Ivan', ft: 31.0 },
        { label: '1972 Agnes', ft: 35.8 },
        { label: '1936 record', ft: 46.0 },
      ],
      maxOffset: 12,
    },
    shelters: [
      { name: 'Cathedral of Learning (Pitt, Oakland)', at: [-79.95319, 40.4443], search: 250 },
      { name: 'Mount Washington — Grandview Ave', at: [-80.0105, 40.4362], search: 350 },
      { name: 'Hill District high ground', at: [-79.975, 40.4455], search: 400 },
      { name: 'Fineview hilltop (North Side)', at: [-80.00394, 40.46451], search: 350 },
      { name: 'South Side Slopes', at: [-79.978, 40.423], search: 400 },
    ],
    storms: [],
    rainRate: 0,
    camera: { at: [-80.0005, 40.4418], distance: 4300, yaw: 0.62, pitch: 0.52 },
    description: ({ normalLevel, gaugeDatum }) =>
      "Downtown Pittsburgh sits on the Point, where the Allegheny and Monongahela rivers meet to form the Ohio. " +
      `Normal pool here is about ${(((normalLevel ?? 0) - (gaugeDatum ?? 0)) / FT).toFixed(1)} ft on the Point gauge; ` +
      'flood stage is 25 ft, about where the Parkway East "bathtub" goes under. On March 18, 1936 — the St. ' +
      'Patrick\'s Day flood — snowmelt and heavy rain drove the river to a record 46 ft and flooded most of the ' +
      'Golden Triangle. The remnants of Agnes crested at 35.8 ft in June 1972 and Hurricane Ivan at 31 ft in ' +
      'September 2004. ' +
      'Raise the river stage to replay those crests and watch the Strip District, the North Shore stadiums and ' +
      'downtown go under — then try a levee.',
  },
  {
    id: 'johnstown',
    center: { lat: 40.33, lon: -78.915 },
    sizeMeters: 7000,
    n: 1024,
    rivers: [
      {
        name: 'Conemaugh River',
        path: [[-78.92495, 40.32905], [-78.92479, 40.33378], [-78.92479, 40.34022], [-78.93204, 40.3436], [-78.93768, 40.34606], [-78.93888, 40.3522], [-78.93888, 40.36128]],
        depth: 2.5,
        bankCells: 2,
        snapRadius: 8,
      },
      {
        name: 'Stonycreek River',
        path: [[-78.91754, 40.29864], [-78.91633, 40.30122], [-78.9115, 40.30196], [-78.90723, 40.30337], [-78.90988, 40.30583], [-78.91472, 40.30675], [-78.91593, 40.30921], [-78.91593, 40.31382], [-78.91415, 40.31689], [-78.91472, 40.32088], [-78.91633, 40.32223], [-78.91955, 40.32334], [-78.92318, 40.32285], [-78.92455, 40.32518], [-78.92495, 40.32886]],
        depth: 2.5,
        bankCells: 2,
        snapRadius: 8,
        upstream: { type: 'inflow', discharge: Math.round(59000 * CFS), label: 'Stonycreek River — 1936 peak (59,000 ft³/s)' },
      },
      {
        name: 'Little Conemaugh River',
        path: [[-78.87396, 40.35281], [-78.87726, 40.35361], [-78.88048, 40.35158], [-78.88113, 40.34974], [-78.88435, 40.34483], [-78.89176, 40.34188], [-78.89982, 40.33378], [-78.90787, 40.3304], [-78.91593, 40.32886], [-78.92237, 40.32886], [-78.92479, 40.32905]],
        depth: 2,
        bankCells: 2,
        snapRadius: 8,
        upstream: { type: 'inflow', discharge: Math.round(28800 * CFS), label: 'Little Conemaugh River — 1936 peak (28,800 ft³/s)' },
      },
    ],
    shelters: [
      { name: 'Inclined Plane upper station (Westmont)', at: [-78.92729, 40.32573], search: 250 },
      { name: 'Westmont hilltop', at: [-78.95169, 40.31563], search: 300 },
      { name: 'Southmont hilltop', at: [-78.93864, 40.31063], search: 300 },
      { name: 'Prospect hilltop', at: [-78.91212, 40.3345], search: 350 },
    ],
    storms: [],
    rainRate: 0,
    camera: { at: [-78.921, 40.3262], distance: 3400, yaw: 0.85, pitch: 0.55 },
    description: () =>
      'Johnstown fills a narrow valley where the Little Conemaugh and Stonycreek rivers join to form the ' +
      'Conemaugh. On May 31, 1889 the South Fork Dam, about 14 miles upstream, failed after heavy rain and the ' +
      'flood wave killed 2,209 people. The St. Patrick\'s Day flood of March 1936 swamped the city again (25 ' +
      'deaths), and by 1943 the Army Corps of Engineers had rebuilt the rivers into the concrete-lined ' +
      'flood-control channels you see here, sized for a flood like 1936. In July 1977 up to a foot of rain fell ' +
      'overnight, several dams upstream failed and more than 80 people died. The inflows start at the 1936 peaks: ' +
      'about 59,000 ft³/s on the Stonycreek (USGS, Ferndale) and 28,800 ft³/s on the Little Conemaugh. ' +
      'Can the channels hold it?',
  },
  {
    id: 'ellicott',
    center: { lat: 39.27, lon: -76.805 },
    sizeMeters: 5000,
    n: 1024,
    rivers: [
      {
        name: 'Patapsco River',
        path: [[-76.78525, 39.29234], [-76.79432, 39.26787], [-76.77608, 39.25691]],
        depth: 2,
        bankCells: 2,
        snapRadius: 12,
        upstream: { type: 'inflow', discharge: Math.round(22800 * CFS), label: 'Patapsco River — July 30, 2016 peak (22,800 ft³/s at Hollofield)' },
      },
    ],
    shelters: [
      { name: 'Patapsco Female Institute (Church Rd)', at: [-76.79709, 39.27085], search: 200 },
      { name: 'Howard County Courthouse (Court Ave)', at: [-76.7984, 39.26848], search: 200 },
      { name: 'Fire Station 2 (Montgomery Rd)', at: [-76.82045, 39.25557], search: 250 },
      { name: 'Oella (east bank ridge)', at: [-76.78667, 39.27413], search: 350 },
    ],
    // Centered on the 3.7 mi² Tiber–Hudson–New Cut watershed west of Main Street (USGS FS 2021–3025, fig. 2).
    // 75 mm/hr ≈ the 2016 storm's peak two hours (5.96 in between 6:50 and 8:50 p.m.).
    storms: [{ id: 'tiber-hudson', at: [-76.8115, 39.2665], radiusMeters: 1900, intensity: 75 }],
    rainRate: 0,
    camera: { at: [-76.8015, 39.2683], distance: 1900, yaw: Math.PI / 2, pitch: 0.5 },
    description: () =>
      'Historic Ellicott City sits at the bottom of a hill where the Hudson, Tiber and New Cut branches converge ' +
      'and empty into the Patapsco River — and Main Street is the overflow channel when they flash. On July 30, ' +
      '2016, 6.6 inches of rain fell in three hours (nearly 6 in two); the branches tore down Main Street, the ' +
      'Patapsco rose over the lower town, and two people died. On May 27, 2018 almost the same rain fell again ' +
      '(6.56 inches in three hours at the gauge, heavier just to the south) and one man died — two roughly ' +
      '1-in-1,000-year storms in 22 months. A 75 mm/hr storm cell (the 2016 peak two-hour rate) sits over the ' +
      'branches while the Patapsco runs at its 2016 peak of 22,800 ft³/s. Try walls or a detention pond upstream.',
  },
];

// ────────────────────────────────────────────────────────────────────────────────────────────────

const HERE = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const OUT = path.resolve(HERE, '../public/presets');
/** Raw downloads are cached here (gitignored) so re-bakes are fast and reproducible; pass --refresh to refetch. */
const CACHE = path.resolve(HERE, '../artifacts/bake-cache');
const REFRESH = process.argv.includes('--refresh');

/** Return cached bytes for `name` under a preset + request key, or fetch and store them. */
async function cachedBytes(id: string, key: string, name: string, fetcher: () => Promise<Uint8Array>): Promise<Uint8Array> {
  const dir = path.join(CACHE, id);
  const file = path.join(dir, name);
  const keyFile = `${file}.key`;
  if (!REFRESH && fs.existsSync(file) && fs.existsSync(keyFile) && fs.readFileSync(keyFile, 'utf8') === key) {
    log(id, `  (cached ${name})`);
    return new Uint8Array(fs.readFileSync(file));
  }
  const bytes = await fetcher();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(keyFile, key);
  return bytes;
}
const r2 = (v: number) => Math.round(v * 100) / 100;
const r1 = (v: number) => Math.round(v * 10) / 10;

function log(id: string, ...args: unknown[]) {
  console.log(`[${id}]`, ...args);
}

function medianOf(values: number[]): number {
  const s = values.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

async function bake(def: PresetDef) {
  const t0 = performance.now();
  const info = PRESETS.find((p) => p.id === def.id)!;
  const { bounds, merc } = squareDomain(def.center, def.sizeMeters);
  const N = def.n;
  const cellSize = def.sizeMeters / N;
  const grid = { nx: N, ny: N, bounds };
  const toGrid = (ll: LonLat) => geoToGrid(grid, ll[0], ll[1]);

  // ── DEM
  const requestKey = JSON.stringify({ center: def.center, sizeMeters: def.sizeMeters, n: N });
  let demInfo = { source: 'usgs3dep' as 'usgs3dep' | 'terrarium', filled: 0 };
  const demBytes = await cachedBytes(def.id, requestKey, 'dem.f32', async () => {
    const d = await fetchDEM(merc, N, N, cellSize);
    demInfo = { source: d.source, filled: d.filled };
    fs.mkdirSync(path.join(CACHE, def.id), { recursive: true });
    fs.writeFileSync(path.join(CACHE, def.id, 'dem.json'), JSON.stringify(demInfo));
    return new Uint8Array(d.elevation.buffer, d.elevation.byteOffset, d.elevation.byteLength);
  });
  const demInfoFile = path.join(CACHE, def.id, 'dem.json');
  if (fs.existsSync(demInfoFile)) demInfo = JSON.parse(fs.readFileSync(demInfoFile, 'utf8'));
  const dem = { elevation: new Float32Array(demBytes.slice().buffer), ...demInfo };
  log(def.id, `DEM ${dem.source}, repaired ${dem.filled} cells`);
  const raw = dem.elevation;

  // ── Hydro-conditioning
  const specsFor = (poolLevel?: number): RiverSpec[] =>
    def.rivers.map((r) => ({
      name: r.name,
      path: r.path.map(toGrid),
      depth: r.depth,
      bankCells: r.bankCells,
      snapRadius: r.snapRadius,
      maxHalfWidth: r.maxHalfWidth,
      flatLevel: poolLevel,
    }));
  let normalLevel: number | null = null;
  let burn: BurnResult;
  if (def.pool) {
    // Pass 1 with the guess, then measure the actual hydro-flattened surface (median of flat channel cells).
    const first = burnRivers(raw, N, N, cellSize, specsFor(def.pool.guess));
    const relief = localRelief(raw, N, N);
    const ft = flatThreshold(cellSize);
    const zs: number[] = [];
    for (let k = 0; k < raw.length; k += 3) if (first.owner[k] && relief[k] <= 0.01) zs.push(raw[k]);
    normalLevel = r2(medianOf(zs));
    log(def.id, `pool surface measured in DEM: ${normalLevel} m NAVD88 (${zs.length} samples, flat tol ${ft.toFixed(3)})`);
    burn = burnRivers(raw, N, N, cellSize, specsFor(normalLevel));
  } else {
    burn = burnRivers(raw, N, N, cellSize, specsFor());
  }
  const elevation = burn.elevation;
  for (const r of burn.rivers) {
    log(def.id, `  ${r.name}: ${r.cells} channel cells, surface ${r.maxLevel.toFixed(2)} → ${r.minLevel.toFixed(2)} m, burn ${r.depth} m`);
  }
  log(def.id, `burned cells: ${burn.burnedCells} (${((100 * burn.burnedCells) / (N * N)).toFixed(2)} % of domain)`);

  // ── Initial fill
  // Seeds sit on the channel SPINE (the cell of the same river farthest from the shore within a few cells of the
  // traced centerline) and take that cell's own water level. Where a trace hugs a bank, a seed on the bank would
  // otherwise carry the bank's (higher) capped level into the channel and start an over-deep pool.
  const spineCell = (gx: number, gy: number, river: number, reach = 6): number => {
    const ci = Math.floor(gx);
    const cj = Math.floor(gy);
    let best = -1;
    let bestScore = -Infinity;
    for (let dj = -reach; dj <= reach; dj++) {
      for (let di = -reach; di <= reach; di++) {
        const i = ci + di;
        const j = cj + dj;
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const k = j * N + i;
        if (burn.owner[k] !== river + 1) continue;
        const score = burn.dist[k] - 0.05 * Math.hypot(di, dj);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
    }
    return best;
  };
  const initialFill: ScenarioPreset['initialFill'] = [];
  if (normalLevel !== null) {
    const seeds: Array<{ gx: number; gy: number }> = [];
    burn.rivers.forEach((r, ri) => {
      const npts = r.centerline.length / 2;
      for (let q = 0; q < npts; q += 80) {
        const k = spineCell(r.centerline[q * 2], r.centerline[q * 2 + 1], ri);
        if (k >= 0) seeds.push({ gx: (k % N) + 0.5, gy: ((k / N) | 0) + 0.5 });
      }
    });
    initialFill.push({ seeds, level: normalLevel });
  } else {
    // Sloping rivers: ONE fill for the whole connected system, seeds along each centerline with their own
    // level — every 10 path cells, and more densely where the surface drops quickly (> 0.2 m between seeds).
    const seeds: Array<{ gx: number; gy: number; level: number }> = [];
    burn.rivers.forEach((r, ri) => {
      const npts = r.centerline.length / 2;
      let lastQ = -Infinity;
      let lastLevel = Infinity;
      let lastK = -1;
      for (let q = 0; q < npts; q++) {
        const k = spineCell(r.centerline[q * 2], r.centerline[q * 2 + 1], ri);
        if (k < 0 || k === lastK) continue;
        const lvl = burn.waterLevel[k];
        if (q - lastQ >= 10 || Math.abs(lvl - lastLevel) > 0.2 || q === npts - 1) {
          seeds.push({ gx: (k % N) + 0.5, gy: ((k / N) | 0) + 0.5, level: r2(lvl) });
          lastQ = q;
          lastLevel = lvl;
          lastK = k;
        }
      }
    });
    initialFill.push({ seeds, level: Math.min(...seeds.map((s) => s.level)) });
  }
  const h0 = computeInitialWater({ nx: N, ny: N, elevation }, { initialFill });
  let wet = 0;
  let leak = 0;
  let maxDepth = 0;
  for (let k = 0; k < h0.length; k++) {
    if (h0[k] > 0.01) {
      wet++;
      if (!burn.owner[k]) leak++;
      maxDepth = Math.max(maxDepth, h0[k]);
    }
  }
  log(def.id, `initial fill: ${wet} wet cells, ${leak} outside the channel mask, max depth ${maxDepth.toFixed(2)} m`);
  if (leak > wet * 0.01) throw new Error(`${def.id}: initial fill leaks outside the channel (${leak} cells)`);

  // ── Sources at the domain edges
  // Inflows sit on the channel spine just inside the edge. Stage sources are boundary conditions: their disc covers
  // the river's whole wet crossing of the edge (see edgeStageDisc), so the open boundary cannot drain the part of
  // the crossing a small disc would miss.
  const ends = findRiverEnds(burn, N, N, 12);
  const sources: WaterSource[] = [];
  def.rivers.forEach((r, ri) => {
    for (const which of ['upstream', 'downstream'] as const) {
      const cfg = r[which];
      if (!cfg) continue;
      const end = ends.find((e) => e.river === ri && e.end === which);
      if (!end) throw new Error(`${def.id}: ${r.name} ${which} end does not reach the domain edge`);
      const id = `${r.name.toLowerCase().replace(/[^a-z]+/g, '-').replace(/-river$/, '')}-${cfg.type}`;
      if (cfg.type === 'inflow') {
        const p = inflowPlacement(burn, ri, which, end, N);
        sources.push({ id, type: 'inflow', gx: r2(p.gx), gy: r2(p.gy), radius: r1(p.radius), discharge: cfg.discharge, label: cfg.label });
        log(def.id, `  source ${id} at (${p.gx.toFixed(1)}, ${p.gy.toFixed(1)}) r=${p.radius} edge=${end.edge}`);
      } else {
        const along = end.edge === 'north' || end.edge === 'south' ? end.gx : end.gy;
        const runs = edgeRuns(end.edge, N, N, (k) => h0[k] > 0.01);
        const run = runs.sort((a, b) => distToRun(a, along) - distToRun(b, along))[0];
        if (!run || distToRun(run, along) > 24) throw new Error(`${def.id}: ${r.name} has no wet crossing of the ${end.edge} edge`);
        const disc = edgeStageDisc(end.edge, run[0], run[1], N, N);
        sources.push({ id, type: 'stage', ...disc, level: normalLevel ?? r2(end.level), label: cfg.label });
        log(def.id, `  source ${id} covers ${end.edge} edge cells ${run[0]}..${run[1]}: disc (${disc.gx}, ${disc.gy}) r=${disc.radius}`);
      }
    }
  });

  // ── Roads
  const rawRoads = JSON.parse(
    new TextDecoder().decode(
      await cachedBytes(def.id, requestKey, 'roads-raw.json', async () => new TextEncoder().encode(JSON.stringify(await fetchTigerRoads(bounds)))),
    ),
  ) as RawRoad[];
  const roads = buildRoadNetwork(rawRoads, { nx: N, ny: N, cellSize, toGrid: makeGeoToGrid(grid) });
  log(def.id, 'roads', roadStats(roads));

  // ── Shelters on high road nodes
  const stageCeiling = normalLevel !== null && def.stage ? normalLevel + def.stage.maxOffset : null;
  const elevAt = (gx: number, gy: number) => elevation[Math.min(N - 1, Math.floor(gy)) * N + Math.min(N - 1, Math.floor(gx))];
  const nearestWaterLevel = (gx: number, gy: number) => {
    let best = Infinity;
    let lvl = NaN;
    for (let k = 0; k < N * N; k += 7) {
      if (!burn.owner[k]) continue;
      const d = Math.hypot((k % N) + 0.5 - gx, ((k / N) | 0) + 0.5 - gy);
      if (d < best) {
        best = d;
        lvl = burn.waterLevel[k];
      }
    }
    return lvl;
  };
  const shelters: Shelter[] = def.shelters.map((s) => {
    const p = toGrid(s.at);
    const ceiling = stageCeiling ?? nearestWaterLevel(p.gx, p.gy) + 20;
    const searchCells = (s.search ?? 250) / cellSize;
    let best: { gx: number; gy: number; score: number } | null = null;
    for (let k = 0; k < roads.nodes.length / 2; k++) {
      const gx = roads.nodes[k * 2];
      const gy = roads.nodes[k * 2 + 1];
      const d = Math.hypot(gx - p.gx, gy - p.gy);
      if (d > searchCells) continue;
      const z = elevAt(gx, gy);
      if (z < ceiling + 3) continue;
      // Prefer close to the landmark, then higher.
      const score = -d * cellSize + 0.5 * (z - ceiling);
      if (!best || score > best.score) best = { gx, gy, score };
    }
    const at = best ?? { gx: p.gx, gy: p.gy };
    const z = elevAt(at.gx, at.gy);
    log(def.id, `  shelter "${s.name}": ${z.toFixed(1)} m (${(z - ceiling).toFixed(1)} m above ceiling ${ceiling.toFixed(1)})${best ? '' : ' [no road node — landmark point]'}`);
    if (z < ceiling + 3) throw new Error(`${def.id}: shelter "${s.name}" is not on high enough ground`);
    return { name: s.name, gx: r2(at.gx), gy: r2(at.gy) };
  });

  // ── Storms, camera, stage
  const storms: StormCell[] = def.storms.map((s) => {
    const p = toGrid(s.at);
    return { id: s.id, gx: r1(p.gx), gy: r1(p.gy), radius: r1(s.radiusMeters / cellSize), intensity: s.intensity };
  });
  const cp = toGrid(def.camera.at);
  const zs: number[] = [];
  for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) zs.push(elevAt(cp.gx + di, cp.gy + dj));
  const camera: CameraPose = {
    target: { gx: r1(cp.gx), gy: r1(cp.gy), elevation: r1(medianOf(zs)) },
    distance: def.camera.distance,
    yaw: Math.round(def.camera.yaw * 1000) / 1000,
    pitch: def.camera.pitch,
  };
  const stage: StageControl | null =
    def.stage && normalLevel !== null
      ? {
          label: def.stage.label,
          gaugeDatum: Math.round(def.stage.gaugeDatum * 1000) / 1000,
          normalLevel,
          floodStageFt: def.stage.floodStageFt,
          marks: def.stage.marks,
          maxOffset: def.stage.maxOffset,
        }
      : null;
  if (stage) {
    log(def.id, `stage: normal ${((stage.normalLevel - stage.gaugeDatum) / FT).toFixed(1)} ft, max ${((stage.normalLevel + stage.maxOffset - stage.gaugeDatum) / FT).toFixed(1)} ft`);
  }

  const scenario: ScenarioPreset = {
    description: def.description({ normalLevel, gaugeDatum: stage?.gaugeDatum ?? null }),
    sources,
    storms,
    shelters,
    rainRate: def.rainRate,
    stage,
    initialFill,
    camera,
  };

  // ── Imagery
  const jpg = await cachedBytes(def.id, requestKey, 'imagery.jpg', () => fetchImageryBytes(merc, 2048));

  // ── Write
  const dir = path.join(OUT, def.id);
  fs.mkdirSync(dir, { recursive: true });
  const meta: PresetMeta = {
    version: 1,
    id: def.id,
    name: info.name,
    subtitle: info.subtitle,
    nx: N,
    ny: N,
    cellSize,
    bounds,
    attribution: `Elevation: USGS 3DEP · ${IMAGERY_ATTRIBUTION} · ${ROADS_ATTRIBUTION_TIGER}`,
    scenario,
    files: { elevation: 'elevation.f32', imagery: 'imagery.jpg', roads: 'roads.json' },
    bake: {
      bakedAt: new Date().toISOString(),
      demSource: dem.source,
      demRepairedCells: dem.filled,
      center: def.center,
      sizeMeters: def.sizeMeters,
      burnedCells: burn.burnedCells,
      rivers: burn.rivers.map((r) => ({ name: r.name, cells: r.cells, depth: r.depth, surfaceMax: r2(r.maxLevel), surfaceMin: r2(r.minLevel) })),
      initialWetCells: wet,
      roads: roadStats(roads),
    },
  };
  const problems = validatePresetMeta(meta);
  if (problems.length) throw new Error(`${def.id}: invalid meta: ${problems.join('; ')}`);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  fs.writeFileSync(path.join(dir, 'elevation.f32'), Buffer.from(elevation.buffer, elevation.byteOffset, elevation.byteLength));
  fs.writeFileSync(path.join(dir, 'imagery.jpg'), jpg);
  fs.writeFileSync(path.join(dir, 'roads.json'), JSON.stringify(encodeRoads(roads)));
  const sizes = ['meta.json', 'elevation.f32', 'imagery.jpg', 'roads.json'].map((f) => `${f} ${(fs.statSync(path.join(dir, f)).size / 1e6).toFixed(2)} MB`);
  log(def.id, `wrote ${sizes.join(', ')} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

/** Cells between a position along an edge and a run [t0, t1] of edge cells (0 inside the run). */
function distToRun(run: [number, number], t: number): number {
  return t < run[0] ? run[0] - t : t > run[1] + 1 ? t - run[1] - 1 : 0;
}

/**
 * Inflow footprints need room: at least 4 cells of radius, fully inside the domain. Walk inward along the
 * centerline from the edge end until the footprint fits.
 */
function inflowPlacement(burn: BurnResult, river: number, which: 'upstream' | 'downstream', end: { gx: number; gy: number; radius: number }, N: number) {
  const radius = Math.max(4, end.radius);
  const cl = burn.rivers[river].centerline;
  const npts = cl.length / 2;
  const fits = (gx: number, gy: number) => Math.min(gx, gy, N - gx, N - gy) >= radius + 1;
  if (fits(end.gx, end.gy)) return { gx: end.gx, gy: end.gy, radius };
  for (let s = 0; s < npts; s++) {
    const q = which === 'upstream' ? s : npts - 1 - s;
    const gx = cl[q * 2];
    const gy = cl[q * 2 + 1];
    if (fits(gx, gy)) return { gx, gy, radius };
  }
  return { gx: end.gx, gy: end.gy, radius: end.radius };
}

async function main() {
  const only = process.argv.slice(2);
  const defs = only.length ? PRESET_DEFS.filter((d) => only.includes(d.id)) : PRESET_DEFS;
  if (!defs.length) throw new Error(`unknown preset(s): ${only.join(', ')}; known: ${PRESET_DEFS.map((d) => d.id).join(', ')}`);
  for (const d of defs) await bake(d);
  let total = 0;
  for (const id of fs.readdirSync(OUT)) {
    const dir = path.join(OUT, id);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, f)).size;
  }
  console.log(`public/presets total: ${(total / 1e6).toFixed(1)} MB`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
