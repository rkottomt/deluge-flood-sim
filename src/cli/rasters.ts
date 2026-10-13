/**
 * Result rasters as GeoTIFF (geotiff.js writeArrayBuffer — the dependency the app already ships for reading DEMs).
 *
 * Georeferencing: the simulation grid is linear in Web Mercator (src/contracts.ts GeoBounds, src/data/geo.ts), so each
 * raster is written in EPSG:3857 (ProjectedCSTypeGeoKey 3857, PixelIsArea) with ModelTiepoint at the north-west corner
 * of the grid's outer edge and ModelPixelScale = the mercator extent / the cell count. Row 0 is the north edge, as in
 * the grid. QGIS, GDAL (`gdalinfo`), rasterio and ArcGIS read them as they are.
 *
 * Layers (what the app's water views show, from FloodSolver.readHazardFields):
 *   max_depth_m.tif     maximum depth reached, m (Float32; rivers and lakes that were full at the start included)
 *   max_speed_ms.tif    maximum speed while wet, m/s (Float32)
 *   arrival_min.tif     minutes after the start that the water first stood > 0.15 m, on land dry at the start
 *                       (Float32; nodata −9999 where it never arrived or was wet from the start)
 *   hazard_aidr.tif     AIDR 2017 hazard class 1–6 from max depth, speed and depth × speed, on land dry at the start
 *                       that the flood reached > 0.15 m (UInt8; 0 = not flooded)
 */
import { writeArrayBuffer } from 'geotiff';
import type { GeoBounds, HazardFields } from '../contracts';
import { boundsToMercator } from '../data/geo';
import { aidrClass } from '../loss/hazard';
import { REACHED_DEPTH } from '../loss/impact';

export const NODATA = -9999;

export interface RasterLayer {
  name: string;
  file: string;
  description: string;
  unit: string;
  data: Float32Array | Uint8Array;
  nodata: number | null;
}

/** Arrival (min), AIDR class and the maxima as raster layers. */
export function hazardLayers(f: HazardFields): RasterLayer[] {
  const n = f.nx * f.ny;
  const arrival = new Float32Array(n);
  const hazard = new Uint8Array(n);
  for (let c = 0; c < n; c++) {
    const t = f.firstWet[c];
    const flooded = t > 0 && f.maxDepth[c] >= REACHED_DEPTH;
    arrival[c] = t > 0 ? t / 60 : NODATA;
    hazard[c] = flooded ? aidrClass(f.maxDepth[c], f.maxSpeed[c], f.maxDV[c]) : 0;
  }
  return [
    { name: 'max_depth', file: 'max_depth_m.tif', description: 'Maximum water depth reached', unit: 'm', data: f.maxDepth, nodata: null },
    { name: 'max_speed', file: 'max_speed_ms.tif', description: 'Maximum flow speed while wet', unit: 'm/s', data: f.maxSpeed, nodata: null },
    { name: 'arrival', file: 'arrival_min.tif', description: 'Minutes until water first stood deeper than 0.15 m (land dry at the start)', unit: 'min', data: arrival, nodata: NODATA },
    { name: 'hazard', file: 'hazard_aidr.tif', description: 'AIDR 2017 flood hazard class H1–H6 (0 = not flooded)', unit: 'class', data: hazard, nodata: 0 },
  ];
}

/** A single-band GeoTIFF of an nx × ny grid (row 0 = north) covering `bounds`, in EPSG:3857. */
export function geotiffBytes(data: Float32Array | Uint8Array, nx: number, ny: number, bounds: GeoBounds, nodata: number | null, description = ''): ArrayBuffer {
  if (data.length !== nx * ny) throw new Error(`raster has ${data.length} values, expected ${nx}×${ny}`);
  const m = boundsToMercator(bounds);
  const metadata: Record<string, unknown> = {
    width: nx,
    height: ny,
    ModelPixelScale: [(m.xmax - m.xmin) / nx, (m.ymax - m.ymin) / ny, 0],
    ModelTiepoint: [0, 0, 0, m.xmin, m.ymax, 0],
    GTModelTypeGeoKey: 1, // projected
    GTRasterTypeGeoKey: 1, // PixelIsArea: the tie point is the outer corner of the first cell
    ProjectedCSTypeGeoKey: 3857,
    GTCitationGeoKey: 'WGS 84 / Pseudo-Mercator',
  };
  if (nodata !== null) metadata.GDAL_NODATA = `${nodata}\u0000`;
  if (description) metadata.ImageDescription = description;
  return writeArrayBuffer(data, metadata as Parameters<typeof writeArrayBuffer>[1]);
}
