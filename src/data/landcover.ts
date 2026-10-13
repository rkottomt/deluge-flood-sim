/**
 * Land cover → the solver's land-surface layers (FloodSolver.setLandSurface, ARCHITECTURE.md §3.11): Manning's n per
 * cell, storm-drain capacity per cell, and building obstacles from the footprints.
 *
 * DATA. Baked presets ship `landcover.u8`: one class code per pixel, row-major north row first, `width × height`
 * pixels covering exactly the preset's bounds (resampled nearest-neighbour onto the same Web-Mercator grid as the
 * DEM, at a coarser size), plus a `landcover` block in meta.json (scheme, year, size, the design rainfall used for the
 * drains). US presets use NLCD 2021 (USGS / MRLC, public domain, 30 m) at 256² (31 m pixels over the 8 km domains),
 * the others ESA WorldCover 2021 v200 (10 m, CC BY 4.0) at 512² (15.6 m). The grid cells (7.8 m) upsample by
 * nearest neighbour. scripts/bake-landcover.ts builds them. Live areas in the lower 48 fetch NLCD 2021 at load time
 * (src/data/landcoverLive.ts); elsewhere they have none, so their roughness stays uniform and they have no drains.
 *
 * ROUGHNESS. `n` is the class value with buildings NOT resolved (developed classes then carry the extra resistance of
 * the buildings — the "increased roughness" treatment — as the HEC-RAS guidance intends); `nStreet` is the value
 * when the buildings are obstacles in the solver, i.e. the open ground between them: pavement (Chow 1959: asphalt
 * 0.013–0.016, with curbs, cars and street furniture taken as 0.02) and lawns (short grass 0.025–0.035). The `n` values
 * are picked inside the ranges of the table of Manning's n by NLCD class in the HEC-RAS 2D Modeling User's Manual
 * (USACE HEC, v6; see also Kalyanapu et al. 2009, J. Spatial Hydrology 9(2)), towards the lower-middle of each
 * range because the cells are 7.8 m and the flows a metre deep or more (vegetation resistance falls with depth). Open
 * water is 0.035, the uniform value every preset river was set up with, so river conveyance is unchanged; cells wet in
 * the initial water (the burned river channels, which NLCD often classes as the forest along a narrow creek) take the
 * open-water value whatever their class.
 *
 * DRAINS. US storm sewers ("minor systems") are designed for the 2- to 10-year storm (FHWA HEC-22 "Urban Drainage
 * Design Manual", 3rd ed. 2009, design-frequency guidance; ASCE/WEF MOP 77, 1992). A drained cell removes
 *     capacity = C_class × i₂     (mm/hr of depth)
 * with i₂ the 2-year, 60-minute rainfall intensity at the preset (NOAA Atlas 14, fetched at bake time and stored in
 * meta.json) and C_class the Rational-method runoff coefficient of the class (HEC-22 and ASCE tables: downtown
 * business 0.70–0.95, neighbourhood 0.50–0.70, residential 0.30–0.50, parks 0.10–0.25) — the inflow the pipe network
 * under that land was sized to carry. It is a distributed sink, not a pipe network: no inlet locations, no pipe
 * capacity limits downstream, no surcharge when the outfall is under a flooded river. Non-US presets have no design
 * data and no drains.
 */
import type { BuildingSet } from '../contracts';

export type LandCoverScheme = 'nlcd' | 'worldcover';

export interface LandCoverClass {
  code: number;
  name: string;
  /** Manning's n with buildings unresolved (as roughness), s·m^-1/3. */
  n: number;
  /** Manning's n of the open ground when buildings are obstacles. Equal to n for undeveloped classes. */
  nStreet: number;
  /** Rational-method runoff coefficient used for the drain capacity (0 = no storm sewers). */
  drainC: number;
}

/** Open water / river channels: the uniform n the presets were set up with. */
export const N_CHANNEL = 0.035;

/**
 * NLCD 2021 legend (MRLC) → n and drain coefficient. HEC-RAS 2D manual ranges in the comments; chosen values towards
 * the lower-middle of each (see header).
 */
export const NLCD_CLASSES: readonly LandCoverClass[] = [
  { code: 11, name: 'Open water', n: N_CHANNEL, nStreet: N_CHANNEL, drainC: 0 }, // 0.025–0.05
  { code: 12, name: 'Perennial ice / snow', n: 0.03, nStreet: 0.03, drainC: 0 },
  { code: 21, name: 'Developed, open space', n: 0.04, nStreet: 0.035, drainC: 0.2 }, // 0.03–0.05; lawns, parks
  { code: 22, name: 'Developed, low intensity', n: 0.08, nStreet: 0.03, drainC: 0.45 }, // 0.06–0.12; streets + lawns
  { code: 23, name: 'Developed, medium intensity', n: 0.1, nStreet: 0.025, drainC: 0.65 }, // 0.08–0.16
  { code: 24, name: 'Developed, high intensity', n: 0.13, nStreet: 0.02, drainC: 0.85 }, // 0.12–0.20; pavement
  { code: 31, name: 'Barren land', n: 0.027, nStreet: 0.027, drainC: 0 }, // 0.023–0.030
  { code: 41, name: 'Deciduous forest', n: 0.12, nStreet: 0.12, drainC: 0 }, // 0.10–0.20
  { code: 42, name: 'Evergreen forest', n: 0.1, nStreet: 0.1, drainC: 0 }, // 0.08–0.16
  { code: 43, name: 'Mixed forest', n: 0.11, nStreet: 0.11, drainC: 0 }, // 0.08–0.20
  { code: 52, name: 'Shrub / scrub', n: 0.08, nStreet: 0.08, drainC: 0 }, // 0.07–0.16
  { code: 71, name: 'Grassland / herbaceous', n: 0.035, nStreet: 0.035, drainC: 0 }, // 0.025–0.05
  { code: 81, name: 'Pasture / hay', n: 0.035, nStreet: 0.035, drainC: 0 }, // 0.025–0.05
  { code: 82, name: 'Cultivated crops', n: 0.035, nStreet: 0.035, drainC: 0 }, // 0.020–0.05
  { code: 90, name: 'Woody wetlands', n: 0.08, nStreet: 0.08, drainC: 0 }, // 0.045–0.15
  { code: 95, name: 'Emergent herbaceous wetlands', n: 0.06, nStreet: 0.06, drainC: 0 }, // 0.05–0.085
];

/**
 * ESA WorldCover 2021 v200 legend → n (the NLCD analogue of each class) and drain coefficient. Built-up mixes every
 * density, so it takes NLCD's medium-intensity values.
 */
export const WORLDCOVER_CLASSES: readonly LandCoverClass[] = [
  { code: 10, name: 'Tree cover', n: 0.11, nStreet: 0.11, drainC: 0 },
  { code: 20, name: 'Shrubland', n: 0.08, nStreet: 0.08, drainC: 0 },
  { code: 30, name: 'Grassland', n: 0.035, nStreet: 0.035, drainC: 0 },
  { code: 40, name: 'Cropland', n: 0.035, nStreet: 0.035, drainC: 0 },
  { code: 50, name: 'Built-up', n: 0.1, nStreet: 0.025, drainC: 0.65 },
  { code: 60, name: 'Bare / sparse vegetation', n: 0.03, nStreet: 0.03, drainC: 0 },
  { code: 70, name: 'Snow and ice', n: 0.03, nStreet: 0.03, drainC: 0 },
  { code: 80, name: 'Permanent water bodies', n: N_CHANNEL, nStreet: N_CHANNEL, drainC: 0 },
  { code: 90, name: 'Herbaceous wetland', n: 0.06, nStreet: 0.06, drainC: 0 },
  { code: 95, name: 'Mangroves', n: 0.12, nStreet: 0.12, drainC: 0 },
  { code: 100, name: 'Moss and lichen', n: 0.035, nStreet: 0.035, drainC: 0 },
];

export const LANDCOVER_ATTRIBUTION: Record<LandCoverScheme, string> = {
  nlcd: 'Land cover: NLCD 2021 (USGS / MRLC)',
  worldcover: 'Land cover: © ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium (CC BY 4.0)',
};

export function classTable(scheme: LandCoverScheme): readonly LandCoverClass[] {
  return scheme === 'nlcd' ? NLCD_CLASSES : WORLDCOVER_CLASSES;
}

/** meta.json `landcover` block (written by scripts/bake-landcover.ts). */
export interface LandCoverMeta {
  scheme: LandCoverScheme;
  /** Product year (NLCD 2021, WorldCover 2021). */
  year: number;
  width: number;
  height: number;
  /** 2-year, 60-minute rainfall intensity used for the drain capacity, mm/hr; 0 = no drain data (no drains). */
  designRainMmHr: number;
  /** Where designRainMmHr came from, e.g. "NOAA Atlas 14 Volume 2 Version 3, PDS, 40.444 N 79.990 W". */
  designRainSource: string;
  /** Pixels per class code, for the record. */
  classCounts?: Record<string, number>;
}

/** Decoded land cover of a preset. */
export interface LandCover extends LandCoverMeta {
  /** width·height class codes, row-major, north row first. */
  classes: Uint8Array;
  attribution: string;
}

/** Structural validation of a meta.json landcover block (empty = valid). */
export function validateLandCoverMeta(m: LandCoverMeta | null | undefined): string[] {
  if (!m) return ['missing landcover block'];
  const errs: string[] = [];
  if (m.scheme !== 'nlcd' && m.scheme !== 'worldcover') errs.push(`unknown land-cover scheme ${String(m.scheme)}`);
  const okSize = (v: number) => Number.isInteger(v) && v >= 16 && v <= 4096;
  if (!okSize(m.width) || !okSize(m.height)) errs.push(`bad land-cover size ${m.width}×${m.height}`);
  if (!(Number.isFinite(m.designRainMmHr) && m.designRainMmHr >= 0 && m.designRainMmHr < 500)) errs.push('bad designRainMmHr');
  return errs;
}

/** Decode landcover.u8 bytes against its meta block; throws on a size mismatch or an unknown scheme. */
export function decodeLandCover(buf: ArrayBuffer, meta: LandCoverMeta): LandCover {
  const problems = validateLandCoverMeta(meta);
  if (problems.length) throw new Error(problems.join('; '));
  if (buf.byteLength !== meta.width * meta.height) {
    throw new Error(`landcover.u8 has ${buf.byteLength} bytes, expected ${meta.width * meta.height}`);
  }
  return { ...meta, classes: new Uint8Array(buf.slice(0)), attribution: LANDCOVER_ATTRIBUTION[meta.scheme] };
}

/** Class code under grid cell (i, j) of an nx × ny grid covering the same bounds (nearest neighbour). */
export function classAt(lc: Pick<LandCover, 'classes' | 'width' | 'height'>, nx: number, ny: number, i: number, j: number): number {
  const x = Math.min(lc.width - 1, Math.floor(((i + 0.5) * lc.width) / nx));
  const y = Math.min(lc.height - 1, Math.floor(((j + 0.5) * lc.height) / ny));
  return lc.classes[y * lc.width + x];
}

export interface LandSurfaceOptions {
  /** Buildings are obstacles: developed classes take their open-ground (street) n. */
  buildingsResolved: boolean;
  /** Initial water depth (nx·ny): cells ≥ 1 cm deep are channel / lake and take N_CHANNEL. */
  initialWater?: Float32Array | null;
}

/**
 * Per-cell Manning's n (at the default global n) and drain capacity (mm/hr) for an nx × ny grid. Classes missing from
 * the table (0 = no data) take N_CHANNEL (the old uniform value) and no drains.
 */
export function landSurfaceFromCover(
  lc: LandCover,
  nx: number,
  ny: number,
  opts: LandSurfaceOptions,
): { roughness: Float32Array; drainCapacity: Float32Array; drainedCells: number } {
  const table = classTable(lc.scheme);
  const nOf = new Float32Array(256).fill(N_CHANNEL);
  const capOf = new Float32Array(256);
  for (const k of table) {
    nOf[k.code] = opts.buildingsResolved ? k.nStreet : k.n;
    capOf[k.code] = k.drainC * Math.max(0, lc.designRainMmHr || 0);
  }
  const roughness = new Float32Array(nx * ny);
  const drainCapacity = new Float32Array(nx * ny);
  const water = opts.initialWater && opts.initialWater.length === nx * ny ? opts.initialWater : null;
  let drained = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const code = classAt(lc, nx, ny, i, j);
      const wet = water ? water[c] >= 0.01 : false;
      roughness[c] = wet ? N_CHANNEL : nOf[code];
      const cap = wet ? 0 : capOf[code];
      drainCapacity[c] = cap;
      if (cap > 0) drained++;
    }
  }
  return { roughness, drainCapacity, drainedCells: drained };
}

/**
 * Building obstacle heights (m above the ground) per cell from the footprints: the roof height rasterised by cell centre
 * (the BuildingSet's heightRaster, or rasterizeBuildingHeights' rule), never below MIN_OBSTACLE_HEIGHT — a footprint
 * with a missing or tiny height is still a wall at street level. A footprint too small to hold a cell centre blocks
 * nothing (the water flows past it, as it does between the cells of a coarse grid).
 */
export const MIN_OBSTACLE_HEIGHT = 3;

/**
 * With `ground` (nx·ny, m), every 4-connected group of footprint cells gets ONE flat roof at the highest roof elevation
 * in the group (ground + height), and the obstacle is that roof minus each cell's ground. Without it, a block of
 * touching buildings of different heights is a set of bowls: in Houston under Harvey's hour the lower roofs between
 * taller ones filled with the runoff shed onto them, up to 0.86 m deep — rain a real roof drains through its gutters.
 * A flat roof sheds its own rain from its edges as a film instead. The flood is blocked either way (no flood here comes
 * near a 3 m roof).
 */
export function obstacleHeights(
  set: BuildingSet | null | undefined,
  nx: number,
  ny: number,
  raster?: Float32Array | null,
  ground?: Float32Array | null,
): Float32Array | null {
  const r = raster ?? set?.heightRaster ?? null;
  const N = nx * ny;
  if (!r || r.length !== N) return null;
  const out = new Float32Array(N);
  let any = false;
  for (let c = 0; c < N; c++) {
    const h = r[c];
    if (h > 0) {
      out[c] = Math.max(MIN_OBSTACLE_HEIGHT, h);
      any = true;
    }
  }
  if (!any) return null;
  if (!ground || ground.length !== N) return out;
  // Flatten each connected group of footprint cells to its highest roof.
  const seen = new Uint8Array(N);
  const stack = new Int32Array(N);
  const members: number[] = [];
  for (let s = 0; s < N; s++) {
    if (!(out[s] > 0) || seen[s]) continue;
    members.length = 0;
    let top = 0;
    stack[top++] = s;
    seen[s] = 1;
    let roof = -Infinity;
    while (top > 0) {
      const c = stack[--top];
      members.push(c);
      roof = Math.max(roof, ground[c] + out[c]);
      const i = c % nx;
      const j = (c - i) / nx;
      if (i > 0 && out[c - 1] > 0 && !seen[c - 1]) (seen[c - 1] = 1), (stack[top++] = c - 1);
      if (i < nx - 1 && out[c + 1] > 0 && !seen[c + 1]) (seen[c + 1] = 1), (stack[top++] = c + 1);
      if (j > 0 && out[c - nx] > 0 && !seen[c - nx]) (seen[c - nx] = 1), (stack[top++] = c - nx);
      if (j < ny - 1 && out[c + nx] > 0 && !seen[c + nx]) (seen[c + nx] = 1), (stack[top++] = c + nx);
    }
    for (const c of members) out[c] = roof - ground[c];
  }
  return out;
}
