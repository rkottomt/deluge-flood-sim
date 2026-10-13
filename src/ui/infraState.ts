/**
 * Shared infrastructure state per store: the current scene's critical facilities (lazily loaded, src/data/facilities.ts)
 * and their exposure in a given flood (cached per HazardFields object), for the Infrastructure section, its map icons
 * and Site check's dependency lines.
 */
import type { HazardFields, Store, TerrainData } from '../contracts';
import { loadPresetFacilities, type Facility } from '../data/facilities';
import { makeGeoToGrid } from '../data/geo';
import { assessFacilities, type FacilityExposure } from '../loss/infra';

export type FacilityLoad = { status: 'idle' | 'loading' | 'ok' | 'none' | 'error'; list: Facility[]; note: string };

export class InfraState {
  private terrain: TerrainData | null = null;
  private presetId: string | null = null;
  load: FacilityLoad = { status: 'idle', list: [], note: '' };
  private ready: Promise<Facility[]> = Promise.resolve([]);
  private exposures = new WeakMap<HazardFields, FacilityExposure[]>();
  /** Exposures last computed for the Infrastructure section (what its map icons show). */
  latest: { fields: HazardFields; exposures: FacilityExposure[] } | null = null;
  private listeners = new Set<() => void>();

  on(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (e) {
        console.error('[infra] listener failed', e);
      }
    }
  }

  /** Facilities for this scene (loaded once per scene). Live areas and the sandbox have none. */
  facilities(terrain: TerrainData | null, presetId: string | null): Promise<Facility[]> {
    if (terrain === this.terrain && presetId === this.presetId) return this.ready;
    this.terrain = terrain;
    this.presetId = presetId;
    this.latest = null;
    this.exposures = new WeakMap();
    if (!terrain || !presetId) {
      this.load = { status: 'none', list: [], note: presetId ? '' : 'Live areas have no facility data: the selective OpenStreetMap query (Overpass) is not an allowed endpoint here, so only the baked scenarios carry facilities.' };
      this.ready = Promise.resolve([]);
      this.emit();
      return this.ready;
    }
    this.load = { status: 'loading', list: [], note: '' };
    const mine = terrain;
    this.ready = loadPresetFacilities(presetId).then((list) => {
      if (this.terrain !== mine) return [];
      this.load = list === null ? { status: presetId === 'sandbox' ? 'none' : 'error', list: [], note: presetId === 'sandbox' ? 'The sandbox has no facility data.' : 'The facility file could not be loaded.' } : { status: 'ok', list, note: '' };
      this.emit();
      return list ?? [];
    });
    this.emit();
    return this.ready;
  }

  /** Exposure of every facility in `fields` (computed once per fields object). */
  exposuresFor(fields: HazardFields, terrain: TerrainData, list: readonly Facility[]): FacilityExposure[] {
    let ex = this.exposures.get(fields);
    if (!ex) {
      const geo = makeGeoToGrid(terrain);
      const sx = fields.nx / terrain.nx, sy = fields.ny / terrain.ny;
      ex = assessFacilities(list, fields, (lon, lat) => {
        const [gx, gy] = geo(lon, lat);
        return [gx * sx, gy * sy];
      }, (terrain.cellSize * terrain.nx) / fields.nx);
      this.exposures.set(fields, ex);
    }
    return ex;
  }

  setLatest(fields: HazardFields, exposures: FacilityExposure[]) {
    this.latest = { fields, exposures };
    this.emit();
  }
}

const states = new WeakMap<Store, InfraState>();
export function infraFor(store: Store): InfraState {
  let s = states.get(store);
  if (!s) states.set(store, (s = new InfraState()));
  return s;
}
