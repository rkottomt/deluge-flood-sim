/**
 * Store → solver for the land-surface layers (FloodSolver.setLandSurface; ARCHITECTURE.md §3.11): building footprints
 * (a block where they fill a cell, a porosity where they partly cover it, roof rain to the downspouts;
 * src/data/porosity.ts), the land-cover roughness map and storm drains, switched by SimParams.buildingObstacles /
 * roughnessMap / drainage (the Advanced panel) and built from the scene's own data (TerrainData.buildings, .landCover).
 *
 * The layers are computed here, on the CPU, once per scene and switch, and pushed whole: the solver only ever sees
 * "this layer, or none". The roughness map depends on the buildings switch — with buildings resolved, developed land
 * takes the open-ground n of its streets and lawns instead of the buildings-as-roughness value — so it is rebuilt when
 * either changes. A scene without the data keeps the layer off (live areas outside the lower 48 have no land cover).
 */
import type { FloodSolver, LandSurface, LandSurfaceStatus, SimParams, Store, TerrainData } from '../contracts';
import { landSurfaceFromCover } from '../data/landcover';
import { buildingCellCounts, buildingLayers } from '../data/porosity';

export interface LandSurfaceFlags {
  buildings: boolean;
  roughness: boolean;
  drains: boolean;
}

export function landSurfaceFlags(sim: Pick<SimParams, 'buildingObstacles' | 'roughnessMap' | 'drainage'>): LandSurfaceFlags {
  return { buildings: !!sim.buildingObstacles, roughness: !!sim.roughnessMap, drains: !!sim.drainage };
}

interface SceneLike {
  terrain: TerrainData;
  solver: FloodSolver;
  initialWater: Float32Array;
}

/** The layers a scene's data gives for these switches (null = off or no data). */
export function buildLandSurface(
  terrain: TerrainData,
  initialWater: Float32Array | null,
  flags: LandSurfaceFlags,
): Required<Pick<LandSurface, 'obstacles' | 'roughness' | 'drainCapacity' | 'porosity'>> {
  const { nx, ny } = terrain;
  // Blocks (one flat roof per group of touching ones), porosity and the roof routing, on the terrain as loaded.
  const b = flags.buildings ? buildingLayers(terrain.buildings ?? null, nx, ny, { ground: terrain.elevation, initialWater }) : null;
  const obstacles = b?.obstacles ?? null;
  const porosity = b?.porosity ?? null;
  const lc = terrain.landCover ?? null;
  let roughness: Float32Array | null = null;
  let drainCapacity: Float32Array | null = null;
  if (lc && (flags.roughness || flags.drains)) {
    const layers = landSurfaceFromCover(lc, nx, ny, { buildingsResolved: !!(obstacles || porosity), initialWater });
    if (flags.roughness) roughness = layers.roughness;
    if (flags.drains && layers.drainedCells > 0) drainCapacity = layers.drainCapacity;
  }
  return { obstacles, roughness, drainCapacity, porosity };
}

/** What a scene has, whatever the switches (AppState.landSurface). */
export function landSurfaceStatus(terrain: TerrainData, initialWater: Float32Array | null): LandSurfaceStatus {
  const { nx, ny } = terrain;
  const b = buildingCellCounts(terrain.buildings ?? null, nx, ny, initialWater);
  const lc = terrain.landCover ?? null;
  const drainCells = lc ? landSurfaceFromCover(lc, nx, ny, { buildingsResolved: false, initialWater }).drainedCells : 0;
  return {
    buildings: terrain.buildings?.count ?? 0,
    obstacleCells: b.blockedCells,
    porousCells: b.porousCells,
    landCover: lc ? (lc.scheme === 'nlcd' ? `NLCD ${lc.year}` : `ESA WorldCover ${lc.year}`) : null,
    drainCells,
    designRainMmHr: lc?.designRainMmHr ?? 0,
  };
}

/** Keeps the current solver's land-surface layers in step with the store's switches. */
export class LandSurfaceSync {
  private unsubscribe: (() => void) | null = null;
  private applied: { scene: SceneLike; flags: LandSurfaceFlags } | null = null;

  constructor(
    private readonly store: Store,
    private readonly getScene: () => SceneLike | null,
    private readonly onError?: (err: unknown) => void,
  ) {}

  install(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.store.subscribe((s, prev) => {
      if (s.sim === prev.sim) return;
      const a = landSurfaceFlags(s.sim);
      const b = landSurfaceFlags(prev.sim);
      if (a.buildings !== b.buildings || a.roughness !== b.roughness || a.drains !== b.drains) this.apply();
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** A new scene: publish what it has and push its layers. */
  onSceneReady(scene: SceneLike): void {
    this.applied = null;
    this.store.set({ landSurface: landSurfaceStatus(scene.terrain, scene.initialWater) });
    this.apply();
  }

  onSceneCleared(): void {
    this.applied = null;
    this.store.set({ landSurface: null });
  }

  /** Push the layers for the current switches to the current solver (no-op when nothing changed). */
  apply(): void {
    const scene = this.getScene();
    if (!scene || typeof scene.solver.setLandSurface !== 'function') return;
    const flags = landSurfaceFlags(this.store.get().sim);
    const a = this.applied;
    if (a && a.scene === scene && a.flags.buildings === flags.buildings && a.flags.roughness === flags.roughness && a.flags.drains === flags.drains) {
      return;
    }
    try {
      scene.solver.setLandSurface(buildLandSurface(scene.terrain, scene.initialWater, flags));
      this.applied = { scene, flags };
    } catch (err) {
      this.onError?.(err);
    }
  }
}
