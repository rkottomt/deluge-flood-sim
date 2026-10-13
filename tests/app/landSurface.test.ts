/**
 * Store → solver for the land-surface layers (src/app/landSurface.ts) and the panel's fine print
 * (src/ui/landSurfaceText.ts), with a mock solver (no GPU).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FloodSolver, LandSurface, TerrainData } from '../../src/contracts';
import { createInitialState } from '../../src/app/defaults';
import { buildLandSurface, LandSurfaceSync, landSurfaceStatus } from '../../src/app/landSurface';
import { createStore } from '../../src/app/store';
import type { LandCover } from '../../src/data/landcover';
import { landSurfaceText } from '../../src/ui/landSurfaceText';
import { rectBuildings } from '../helpers/footprints';

const nx = 4;
const ny = 4;

function terrain(withData: boolean): TerrainData {
  // One building filling cell 5 (i = 1, j = 1), and a "building" over the river cell 0.
  const lc: LandCover = {
    scheme: 'nlcd',
    year: 2021,
    width: 2,
    height: 2,
    designRainMmHr: 30,
    designRainSource: 'test',
    classes: Uint8Array.from([24, 41, 11, 22]),
    attribution: '',
  };
  return {
    name: 't',
    nx,
    ny,
    cellSize: 8,
    elevation: new Float32Array(nx * ny),
    bounds: { west: 0, south: 0, east: 1, north: 1 },
    imagery: null,
    roads: null,
    buildings: withData ? rectBuildings([[1, 1, 2, 2, 10], [0, 0, 1, 1, 8]]) : null,
    landCover: withData ? lc : null,
    attribution: '',
    scenario: null,
  };
}

const river = (() => {
  const w = new Float32Array(nx * ny);
  w[0] = 1;
  return w;
})();

test('buildLandSurface: each switch builds its layer from the scene data, null when off or missing', () => {
  const t = terrain(true);
  const off = buildLandSurface(t, river, { buildings: false, roughness: false, drains: false });
  assert.deepEqual(off, { obstacles: null, roughness: null, drainCapacity: null, porosity: null });
  const all = buildLandSurface(t, river, { buildings: true, roughness: true, drains: true });
  assert.equal(all.obstacles![5], 10);
  // With buildings resolved, high-intensity developed land takes its street n; the river cell keeps the channel n.
  assert.equal(all.roughness![5], Math.fround(0.02));
  assert.equal(all.roughness![0], Math.fround(0.035));
  const asRoughness = buildLandSurface(t, river, { buildings: false, roughness: true, drains: false });
  assert.equal(asRoughness.roughness![5], Math.fround(0.13), 'buildings as roughness without obstacles');
  assert.equal(all.drainCapacity![5], Math.fround(0.85 * 30));
  assert.equal(all.drainCapacity![0], 0, 'no drains in the river');
  const none = buildLandSurface(terrain(false), river, { buildings: true, roughness: true, drains: true });
  assert.deepEqual(none, { obstacles: null, roughness: null, drainCapacity: null, porosity: null }, 'no data, no layers');
});

test('LandSurfaceSync pushes the layers on scene load and on each switch, and publishes the scene status', () => {
  const store = createStore(createInitialState());
  const calls: LandSurface[] = [];
  const solver = { setLandSurface: (l: LandSurface) => calls.push(l) } as unknown as FloodSolver;
  const scene = { terrain: terrain(true), solver, initialWater: river };
  const sync = new LandSurfaceSync(store, () => scene);
  sync.install();
  sync.onSceneReady(scene);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].obstacles, null, 'off by default');
  const st = store.get().landSurface!;
  assert.equal(st.obstacleCells, 1, 'the footprint over the river is not counted');
  assert.equal(st.landCover, 'NLCD 2021');
  assert.equal(st.designRainMmHr, 30);
  store.set({ sim: { ...store.get().sim, buildingObstacles: true } });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].obstacles);
  // A change that is not a land-surface switch pushes nothing.
  store.set({ sim: { ...store.get().sim, manningN: 0.05 } });
  assert.equal(calls.length, 2);
  store.set({ sim: { ...store.get().sim, drainage: true, roughnessMap: true } });
  assert.equal(calls.length, 3);
  assert.ok(calls[2].roughness && calls[2].drainCapacity);
  sync.onSceneCleared();
  assert.equal(store.get().landSurface, null);
  sync.dispose();
});

test('landSurfaceText says what the scene has and what each layer is not', () => {
  assert.match(landSurfaceText(null), /Load a scene/);
  const full = landSurfaceText(landSurfaceStatus(terrain(true), river));
  assert.match(full, /2 footprints fill 1 cells and partly cover 0 more/);
  assert.match(full, /NLCD 2021/);
  assert.match(full, /not a pipe network/);
  const live = landSurfaceText(landSurfaceStatus(terrain(false), river));
  assert.match(live, /no footprints/);
  assert.match(live, /no land-cover data/);
});
