/**
 * Score one model run against the observations of one preset (public/validation/<preset>/observed.json).
 *
 * Like-for-like rules, applied identically everywhere (docs/VALIDATION.md "Method"):
 *  • PEAK against PEAK. The model side is the maximum depth each cell reached during the run (HazardFields.maxDepth,
 *    sampled at every state export), turned into a water-surface elevation (WSE = ground + max depth). A high-water
 *    mark records the highest water at that spot, whenever it came.
 *  • A mark sits at the EDGE of the water by construction (a seed line on a wall, debris on a fence), and the edge of
 *    a 5–8 m cell is a coin toss. So the modelled WSE at a mark is read from the nearest cell within `searchRadiusM`
 *    that the model wetted (max depth ≥ WET_M); if none is wet, the mark is "dry in the model" and reported as such, not
 *    silently dropped. Those dry marks are also scored with the model WSE taken as the GROUND there — a bound that
 *    favours the model (its true WSE is below the ground), stated as such.
 *  • EXTENT is compared over land only: cells the NFHL maps, minus FEMA open water, minus the water the scenario starts
 *    with (rivers and lakes full at t = 0), minus the stage-boundary discs. Flooded = max depth ≥ FLOOD_M.
 *  • For a stage ladder the FEMA 1 % zone is also restricted to the zones CONNECTED to the forced rivers: the 1 % zone
 *    of a creek the scenario does not force is a different flood, not a miss. Both numbers are reported.
 */
import { connectedTo, extentScores, pointScores, type ExtentScores, type PointScores } from './metrics';
import { lineCells, polygonCells, rleDecode } from './raster';
import type { EmsDamage, FemaZonesFile, GaugePeak, ObservedFile } from './types';

/** Depth that counts as "the model put water here" for matching a point, m. */
export const WET_M = 0.05;
/** Depth that counts as flooded land for extent maps, m — the app's hazard legend starts here (ARRIVAL_DEPTH). */
export const FLOOD_M = 0.15;
/** Radius searched around a high-water mark for the nearest wetted cell, m. */
export const HWM_SEARCH_M = 20;
/** Radius searched around a stream gauge, m (gauges stand on the bank of the channel they measure). */
export const GAUGE_SEARCH_M = 40;

export interface ModelFields {
  nx: number;
  ny: number;
  cellSize: number;
  /** Bare-earth ground, m NAVD88 (or the preset's datum). */
  ground: Float32Array;
  /** Maximum depth reached during the run, m. */
  maxDepth: Float32Array;
  /** The scenario's initial water (rivers and lakes full), m. */
  initialWater: Float32Array;
  /** Cells to leave out of every extent comparison (stage-boundary discs), or null. */
  exclude?: Uint8Array | null;
}

export interface PointRow {
  id: string;
  name: string;
  observed: number;
  /** Modelled peak WSE at the nearest wetted cell, or null when no cell within the radius was wetted. */
  modelled: number | null;
  /** modelled − observed, m (null when dry in the model). */
  residual: number | null;
  /** Distance to the cell the WSE was read from, m. */
  distanceM: number | null;
  /** DEM ground at the point, m — observed − ground is the depth the DEM implies. */
  ground: number;
  /** Max depth at the point's own cell, m. */
  depthAtPoint: number;
}

export interface PointResult {
  rows: PointRow[];
  /** Statistics over the points the model wetted. */
  wet: PointScores;
  /** Points the model left dry. */
  dry: number;
  /** Statistics over ALL points, a dry point scored as WSE = ground (favours the model: see the module comment). */
  all: PointScores;
}

/** Nearest wetted cell to (gx, gy) within `radiusM`: its WSE and distance, or null. */
export function nearestWetWse(f: ModelFields, gx: number, gy: number, radiusM: number): { wse: number; distanceM: number } | null {
  const R = Math.max(1, Math.ceil(radiusM / f.cellSize));
  const ci = Math.floor(gx);
  const cj = Math.floor(gy);
  let best: { wse: number; distanceM: number } | null = null;
  for (let dj = -R; dj <= R; dj++) {
    for (let di = -R; di <= R; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) continue;
      const d = Math.hypot(i + 0.5 - gx, j + 0.5 - gy) * f.cellSize;
      if (d > radiusM + f.cellSize * 0.5) continue;
      const k = j * f.nx + i;
      const h = f.maxDepth[k];
      if (!(h >= WET_M)) continue;
      if (!best || d < best.distanceM) best = { wse: f.ground[k] + h, distanceM: d };
    }
  }
  return best;
}

export function scorePoints(
  f: ModelFields,
  points: ReadonlyArray<{ id: string; name: string; gx: number; gy: number; elevation: number }>,
  radiusM: number,
): PointResult {
  const rows: PointRow[] = [];
  for (const p of points) {
    const i = Math.min(f.nx - 1, Math.max(0, Math.floor(p.gx)));
    const j = Math.min(f.ny - 1, Math.max(0, Math.floor(p.gy)));
    const k = j * f.nx + i;
    const w = nearestWetWse(f, p.gx, p.gy, radiusM);
    rows.push({
      id: p.id,
      name: p.name,
      observed: p.elevation,
      modelled: w ? w.wse : null,
      residual: w ? w.wse - p.elevation : null,
      distanceM: w ? w.distanceM : null,
      ground: f.ground[k],
      depthAtPoint: f.maxDepth[k],
    });
  }
  const wetRes = rows.filter((r) => r.residual !== null).map((r) => r.residual as number);
  const allRes = rows.map((r) => (r.residual !== null ? r.residual : r.ground + r.depthAtPoint - r.observed));
  return { rows, wet: pointScores(wetRes), dry: rows.length - wetRes.length, all: pointScores(allRes) };
}

export function scoreHwms(f: ModelFields, obs: ObservedFile): PointResult | null {
  if (!obs.hwm || obs.hwm.sites.length === 0) return null;
  return scorePoints(
    f,
    obs.hwm.sites.map((s) => ({ id: s.site, name: s.description || s.waterbody, gx: s.gx, gy: s.gy, elevation: s.elevation })),
    HWM_SEARCH_M,
  );
}

export function scoreGauges(f: ModelFields, gauges: readonly GaugePeak[] | undefined): PointResult | null {
  if (!gauges || gauges.length === 0) return null;
  return scorePoints(f, gauges.map((g) => ({ id: g.id, name: g.name, gx: g.gx, gy: g.gy, elevation: g.elevation })), GAUGE_SEARCH_M);
}

/** Per-cell outcome for the extent maps. */
export const EXTENT_CELL = { outside: 0, correctDry: 1, hit: 2, miss: 3, falseAlarm: 4, permanentWater: 5, otherFlood: 6 } as const;

export interface FemaResult {
  /** Every 1 % zone in the domain. */
  all: ExtentScores;
  /** Only the 1 % zones connected to the forced rivers (and the land outside every 1 % zone). */
  connected: ExtentScores;
  /** Share of the 0.2 % zone (shaded X) the model floods — a reading of how far past the 1 % line it goes. */
  floodedIn02: number | null;
  /** EXTENT_CELL per cell, for the map (connected variant). */
  cells: Uint8Array;
}

export function scoreFema(f: ModelFields, zones: FemaZonesFile, floodM = FLOOD_M): FemaResult {
  const N = f.nx * f.ny;
  if (zones.nx !== f.nx || zones.ny !== f.ny) throw new Error('scoreFema: zone raster does not match the grid');
  const cls = rleDecode(zones.rle, N);
  const permanent = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (f.initialWater[k] > 0 || cls[k] === 4) permanent[k] = 1;
  const mask = new Uint8Array(N);
  for (let k = 0; k < N; k++) mask[k] = cls[k] !== 0 && !permanent[k] && !(f.exclude && f.exclude[k]) ? 1 : 0;
  const model = new Uint8Array(N);
  for (let k = 0; k < N; k++) model[k] = f.maxDepth[k] >= floodM ? 1 : 0;
  const sfha = new Uint8Array(N);
  for (let k = 0; k < N; k++) sfha[k] = cls[k] === 1 ? 1 : 0;
  const all = extentScores(model, sfha, mask);

  // The forced water: the initial fill (the rivers the scenario holds) — for a stage ladder that is what rises.
  const seed = new Uint8Array(N);
  for (let k = 0; k < N; k++) seed[k] = f.initialWater[k] > 0 ? 1 : 0;
  const linked = connectedTo(sfha, seed, f.nx, f.ny);
  const mask2 = new Uint8Array(N);
  for (let k = 0; k < N; k++) mask2[k] = mask[k] && !(sfha[k] && !linked[k]) ? 1 : 0;
  const connected = extentScores(model, linked, mask2);

  let in02 = 0;
  let n02 = 0;
  for (let k = 0; k < N; k++) {
    if (cls[k] !== 2 || !mask[k]) continue;
    n02++;
    if (model[k]) in02++;
  }

  const cells = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    if (permanent[k]) cells[k] = EXTENT_CELL.permanentWater;
    else if (!mask[k]) cells[k] = EXTENT_CELL.outside;
    else if (!mask2[k]) cells[k] = EXTENT_CELL.otherFlood;
    else if (model[k] && linked[k]) cells[k] = EXTENT_CELL.hit;
    else if (linked[k]) cells[k] = EXTENT_CELL.miss;
    else if (model[k]) cells[k] = EXTENT_CELL.falseAlarm;
    else cells[k] = EXTENT_CELL.correctDry;
  }
  return { all, connected, floodedIn02: n02 ? in02 / n02 : null, cells };
}

export interface BfeRow {
  elevation: number;
  modelled: number;
  residual: number;
  /** Line cells the model wetted. */
  wetCells: number;
  /** Mean grid position of the line (for maps). */
  gx: number;
  gy: number;
}

/**
 * The 1 % PROFILE: Deluge's water surface at each FEMA Base Flood Elevation line that crosses a forced river, against
 * the line's elevation. A stage ladder sets one level at one gauge; FEMA's 1 % surface slopes along the river, so this
 * says how well the modelled surface follows the official profile away from the gauge. A line counts when it crosses
 * the scenario's initial river water; its modelled WSE is the median over the line's wetted cells.
 */
export function scoreBfeProfile(f: ModelFields, lines: ReadonlyArray<{ elev: number; pts: number[] }>): { rows: BfeRow[]; scores: PointScores } {
  const rows: BfeRow[] = [];
  for (const l of lines) {
    const cells = lineCells(f.nx, f.ny, l.pts);
    if (!cells.some((k) => f.initialWater[k] > 0)) continue;
    const wse: number[] = [];
    let sx = 0;
    let sy = 0;
    for (const k of cells) {
      sx += k % f.nx;
      sy += Math.floor(k / f.nx);
      if (f.maxDepth[k] >= WET_M) wse.push(f.ground[k] + f.maxDepth[k]);
    }
    if (wse.length === 0) continue;
    wse.sort((a, b) => a - b);
    const m = wse.length % 2 ? wse[wse.length >> 1] : (wse[wse.length / 2 - 1] + wse[wse.length / 2]) / 2;
    rows.push({ elevation: l.elev, modelled: m, residual: m - l.elev, wetCells: wse.length, gx: sx / cells.length + 0.5, gy: sy / cells.length + 0.5 });
  }
  return { rows, scores: pointScores(rows.map((r) => r.residual)) };
}

export interface EmsResult {
  /** Graded buildings inside the analysed area, by grade: how many, and how many the model floods (≥ FLOOD_M within one cell). */
  buildings: Record<string, { n: number; flooded: number }>;
  /** Share of Destroyed + Damaged buildings the model floods (within one cell). */
  buildingHitRate: number | null;
  /**
   * The same within EMS_NEAR_M: how many of the misses are near-misses at the flood's edge. The DEM under the Himalayan
   * presets is 30 m Copernicus GLO-30, so an edge 20–30 m off is inside its resolution.
   */
  buildingHitRateNear: number | null;
  /** Road cells: affected (Destroyed/Damaged) against "No visible damage", model flooded or not. */
  roads: ExtentScores;
  /** Cells in the analysed area. */
  analysedCells: number;
}

/** Distance within which a damaged building counts as a near-miss of the modelled flood, m (one GLO-30 DEM cell). */
export const EMS_NEAR_M = 30;

function floodedNear(f: ModelFields, gx: number, gy: number, floodM: number, r = 1): boolean {
  const ci = Math.floor(gx);
  const cj = Math.floor(gy);
  for (let dj = -r; dj <= r; dj++) {
    for (let di = -r; di <= r; di++) {
      const i = ci + di;
      const j = cj + dj;
      if (i < 0 || j < 0 || i >= f.nx || j >= f.ny) continue;
      if (r > 1 && Math.hypot(di, dj) > r) continue;
      if (f.maxDepth[j * f.nx + i] >= floodM) return true;
    }
  }
  return false;
}

/**
 * Copernicus EMS damage grades against the modelled flood. Damage is not inundation — a debris flood can destroy a
 * building it only grazes, and water can stand on a road without leaving visible damage — so this is a consistency
 * check (does the modelled flood reach what was destroyed, and stay off what was not?), not an extent map.
 */
export function scoreEms(f: ModelFields, ems: EmsDamage, floodM = FLOOD_M): EmsResult {
  const N = f.nx * f.ny;
  const analysed = rleDecode(ems.analysedRle, N);
  let analysedCells = 0;
  for (let k = 0; k < N; k++) analysedCells += analysed[k];
  const at = (gx: number, gy: number) => {
    const i = Math.floor(gx);
    const j = Math.floor(gy);
    return i >= 0 && j >= 0 && i < f.nx && j < f.ny ? analysed[j * f.nx + i] === 1 : false;
  };
  const buildings: Record<string, { n: number; flooded: number }> = {};
  let aff = 0;
  let affHit = 0;
  let affNear = 0;
  const rNear = Math.max(1, Math.round(EMS_NEAR_M / f.cellSize));
  for (const b of ems.buildings) {
    if (!at(b.gx, b.gy)) continue;
    const g = (buildings[b.grade] ??= { n: 0, flooded: 0 });
    g.n++;
    const hit = floodedNear(f, b.gx, b.gy, floodM);
    if (hit) g.flooded++;
    if (b.grade === 'Destroyed' || b.grade === 'Damaged') {
      aff++;
      if (hit) affHit++;
      if (hit || floodedNear(f, b.gx, b.gy, floodM, rNear)) affNear++;
    }
  }
  const obs = new Uint8Array(N);
  const msk = new Uint8Array(N);
  for (const r of ems.roads) {
    const affected = r.grade === 'Destroyed' || r.grade === 'Damaged';
    const clean = r.grade === 'No visible damage';
    if (!affected && !clean) continue;
    for (const k of lineCells(f.nx, f.ny, r.pts)) {
      if (!analysed[k]) continue;
      msk[k] = 1;
      if (affected) obs[k] = 1;
    }
  }
  const model = new Uint8Array(N);
  for (let k = 0; k < N; k++) model[k] = f.maxDepth[k] >= floodM ? 1 : 0;
  return { buildings, buildingHitRate: aff ? affHit / aff : null, buildingHitRateNear: aff ? affNear / aff : null, roads: extentScores(model, obs, msk), analysedCells };
}

/** Footprints in grid coordinates, as BuildingSet stores them (src/contracts.ts): ring k is verts[2·offsets[k] …]. */
export interface Footprints {
  count: number;
  offsets: ArrayLike<number>;
  verts: ArrayLike<number>;
}

export interface DamageResult {
  /**
   * Over building footprints: observed = the footprint stands on a parcel the survey recorded damaged; modelled = the
   * model floods the footprint (≥ FLOOD_M on any of its cells). Footprints touching the water the scene starts with
   * or a stage disc are left out.
   */
  buildings: ExtentScores;
  /**
   * The same over the footprints WITHIN THE RIVER'S REACH only — those with a cell below the observed crest level and
   * connected to the river through ground below it (crestReach). A damaged building standing above the crest was
   * damaged by something the scene does not force (a creek, rain, a backed-up drain). Null without a crest level.
   */
  inReach: ExtentScores | null;
  /** Land cells of damaged parcels (not river at t = 0, not a stage disc), and how many the model floods. */
  parcelCells: number;
  parcelCellsFlooded: number;
  /** Context, not skill: damaged footprints touching FEMA's 1 % zone (null without a zone raster). */
  damagedInSfha: number | null;
  /** Per-footprint outcome for the map: EXTENT_CELL.hit / miss / falseAlarm / correctDry, or outside (left out). */
  outcome: Uint8Array;
  /** Vertex centroid of each footprint, grid coordinates (for the map). */
  centroids: Float32Array;
}

/**
 * A parcel damage survey against the modelled flood, building by building. The survey lists damaged parcels only, so
 * the population that makes it two-sided is every building footprint in the domain: a footprint the model floods on
 * a parcel nobody recorded is a false alarm, a footprint on a recorded parcel the model leaves dry a miss.
 *
 * A footprint is "on a damaged parcel" when at least half of its cells — or, for a footprint smaller than one cell
 * centre, the cell under its centroid — lie in the parcel mask. Damage is not inundation: a windshield survey records
 * what looked damaged from the street (a basement flooded from the drains, a wall hit by a tributary the scene does
 * not force), and a structure can stand in water without visible damage. It is a consistency check, like EMS grades.
 */
export function scoreDamage(
  f: ModelFields,
  maskRle: readonly number[],
  footprints: Footprints,
  opts: { sfhaCls?: Uint8Array | null; crestLevel?: number | null; floodM?: number } = {},
): DamageResult {
  const floodM = opts.floodM ?? FLOOD_M;
  const sfhaCls = opts.sfhaCls ?? null;
  const N = f.nx * f.ny;
  const mask = rleDecode(maskRle, N);
  const reach = opts.crestLevel != null ? crestReach(f, opts.crestLevel) : null;
  const n = footprints.count;
  const model = new Uint8Array(n);
  const obs = new Uint8Array(n);
  const use = new Uint8Array(n);
  const useReach = new Uint8Array(n);
  const centroids = new Float32Array(2 * n);
  let damagedInSfha = 0;
  for (let b = 0; b < n; b++) {
    const a0 = footprints.offsets[b];
    const a1 = footprints.offsets[b + 1];
    if (a1 - a0 < 3) continue;
    const ring: number[] = [];
    let cx = 0;
    let cy = 0;
    for (let v = a0; v < a1; v++) {
      ring.push(footprints.verts[2 * v], footprints.verts[2 * v + 1]);
      cx += footprints.verts[2 * v];
      cy += footprints.verts[2 * v + 1];
    }
    cx /= a1 - a0;
    cy /= a1 - a0;
    centroids[2 * b] = cx;
    centroids[2 * b + 1] = cy;
    const ci = Math.floor(cx);
    const cj = Math.floor(cy);
    const centre = ci >= 0 && cj >= 0 && ci < f.nx && cj < f.ny ? cj * f.nx + ci : -1;
    let cells = polygonCells(f.nx, f.ny, [ring]);
    if (cells.length === 0) {
      if (centre < 0) continue;
      cells = [centre];
    }
    if (cells.some((k) => f.initialWater[k] > 0 || (f.exclude && f.exclude[k]))) continue;
    use[b] = 1;
    let inMask = 0;
    let wet = false;
    let sfha = false;
    for (const k of cells) {
      if (mask[k]) inMask++;
      if (f.maxDepth[k] >= floodM) wet = true;
      if (sfhaCls && sfhaCls[k] === 1) sfha = true;
      if (reach && reach[k]) useReach[b] = 1;
    }
    obs[b] = inMask * 2 >= cells.length || (centre >= 0 && mask[centre] === 1) ? 1 : 0;
    model[b] = wet ? 1 : 0;
    if (obs[b] && sfha) damagedInSfha++;
  }
  let parcelCells = 0;
  let parcelCellsFlooded = 0;
  for (let k = 0; k < N; k++) {
    if (!mask[k] || f.initialWater[k] > 0 || (f.exclude && f.exclude[k])) continue;
    parcelCells++;
    if (f.maxDepth[k] >= floodM) parcelCellsFlooded++;
  }
  const outcome = new Uint8Array(n);
  for (let b = 0; b < n; b++) {
    if (!use[b]) outcome[b] = EXTENT_CELL.outside;
    else if (model[b] && obs[b]) outcome[b] = EXTENT_CELL.hit;
    else if (obs[b]) outcome[b] = EXTENT_CELL.miss;
    else if (model[b]) outcome[b] = EXTENT_CELL.falseAlarm;
    else outcome[b] = EXTENT_CELL.correctDry;
  }
  return {
    buildings: extentScores(model, obs, use),
    inReach: reach ? extentScores(model, obs, useReach) : null,
    parcelCells,
    parcelCellsFlooded,
    damagedInSfha: sfhaCls ? damagedInSfha : null,
    outcome,
    centroids,
  };
}

/**
 * Land a river at `level` (m, the datum of `ground`) could reach: cells whose ground is below the level and that are
 * 4-connected to the water the scene starts with through such cells. A flat surface at the gauge's crest — for sorting
 * observations into "the river's flood" and "something else", never for scoring the model's own water.
 */
export function crestReach(f: Pick<ModelFields, 'nx' | 'ny' | 'ground' | 'initialWater'>, level: number): Uint8Array {
  const N = f.nx * f.ny;
  const below = new Uint8Array(N);
  const seed = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    below[k] = f.ground[k] < level ? 1 : 0;
    seed[k] = f.initialWater[k] > 0 ? 1 : 0;
  }
  const reach = connectedTo(below, seed, f.nx, f.ny);
  for (let k = 0; k < N; k++) if (seed[k]) reach[k] = 0;
  return reach;
}
