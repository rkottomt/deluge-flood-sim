/**
 * Data module public API (see src/contracts.ts, "Module factories").
 *
 *   listPresets()            — preset registry for the scenario picker
 *   loadPreset(id)           — baked real-world presets from /presets/<id>/ or the procedural sandbox
 *   loadLiveArea(req)        — any US location live: USGS 3DEP + Esri imagery + TIGERweb roads + auto hydro
 *   computeInitialWater()    — initial depth field from a scenario's initialFill
 *   geoToGrid / gridToGeo    — Web Mercator grid conversions
 */
import type { GeoBounds, LiveAreaRequest, PresetInfo, ProgressFn, ScenarioPreset, TerrainData } from '../contracts';
import { geoToGrid as geoToGridImpl, gridToGeo as gridToGeoImpl } from './geo';
import { computeInitialWater as computeInitialWaterImpl } from './initialWater';
import { loadLiveArea as loadLiveAreaImpl } from './live';
import { listPresets as listPresetsImpl, loadPreset as loadPresetImpl } from './presets';

export function listPresets(): PresetInfo[] {
  return listPresetsImpl();
}

export function loadPreset(id: string, onProgress?: ProgressFn): Promise<TerrainData> {
  return loadPresetImpl(id, onProgress);
}

export function loadLiveArea(req: LiveAreaRequest, onProgress?: ProgressFn): Promise<TerrainData> {
  return loadLiveAreaImpl(req, onProgress);
}

export function computeInitialWater(terrain: TerrainData, scenario: ScenarioPreset | null): Float32Array {
  return computeInitialWaterImpl(terrain, scenario);
}

export function geoToGrid(terrain: Pick<TerrainData, 'nx' | 'ny' | 'bounds'>, lon: number, lat: number): { gx: number; gy: number } {
  return geoToGridImpl(terrain, lon, lat);
}

export function gridToGeo(terrain: Pick<TerrainData, 'nx' | 'ny' | 'bounds'>, gx: number, gy: number): { lon: number; lat: number } {
  return gridToGeoImpl(terrain, gx, gy);
}

// Extra helpers other modules may find useful (not part of the contract).
export { setPresetBaseUrl, validatePresetMeta, type PresetMeta } from './presets';
export { generateSandbox } from './sandbox';
export { cellSizeFor, squareDomain, isLikelyUS } from './geo';
export { IMAGERY_ATTRIBUTION } from './imagery';
export type { GeoBounds };
