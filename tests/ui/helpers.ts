import type { AppState, FloodRenderer, FloodSolver, BrushOp, PickResult, TerrainData } from '../../src/contracts';
import { DEFAULT_SIM_PARAMS } from '../../src/contracts';

export function baseState(patch: Partial<AppState> = {}): AppState {
  return {
    presetId: 'sandbox',
    terrainName: 'Sandbox',
    attribution: '',
    loading: null,
    error: null,
    paused: false,
    tool: 'orbit',
    wallHeight: 2,
    brushRadius: 20,
    inflowDischarge: 250,
    stormIntensity: 60,
    sim: { ...DEFAULT_SIM_PARAMS },
    stageOffset: 0,
    stageOffsetApplied: 0,
    render: { waterMode: 'realistic', verticalExaggeration: 1.5, showImagery: true, showRoads: true, showContours: false },
    sources: [],
    storms: [],
    shelters: [],
    evacStart: null,
    scenario: null,
    grid: { nx: 512, ny: 512, cellSize: 10 },
    stats: null,
    stepInfo: null,
    fps: 60,
    route: null,
    probe: null,
    panels: { howItWorks: false, locationPicker: false, help: false },
    gpuInfo: 'test',
    reference: null,
    referenceOn: false,
    ...patch,
  };
}

/** Canvas stand-in: an EventTarget with the few HTMLCanvasElement members the controller touches. */
export class FakeCanvas extends EventTarget {
  style = { cursor: '' };
  captured = new Set<number>();
  getBoundingClientRect() {
    return { left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000, x: 0, y: 0 };
  }
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  releasePointerCapture(id: number) {
    this.captured.delete(id);
  }
  hasPointerCapture(id: number) {
    return this.captured.has(id);
  }
}

export function pointer(type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Event(type), { pointerId: 1, button: 0, clientX: x, clientY: y, shiftKey: false, isPrimary: true, ...extra });
}

/** Renderer whose pick maps CSS pixels to grid cells 2:1 (1000 px → 500 cells). */
export function fakeRenderer(): FloodRenderer {
  const camera = { pose: { target: { gx: 0, gy: 0, elevation: 0 }, distance: 1, yaw: 0, pitch: 1 }, leftDragOrbits: true, flyTo() {}, frameAll() {}, topDown() {} };
  return {
    camera,
    setScene() {},
    setOverlays() {},
    render() {},
    resize() {},
    destroy() {},
    pick(x: number, y: number): PickResult | null {
      if (x < 0 || y < 0 || x > 1000 || y > 1000) return null;
      return { gx: x / 2, gy: y / 2, elevation: 123, depth: 0.4 };
    },
  };
}

export function fakeSolver(ops: BrushOp[]): FloodSolver {
  return {
    nx: 512,
    ny: 512,
    cellSize: 10,
    applyBrush: (op: BrushOp) => ops.push(op),
  } as unknown as FloodSolver;
}

export function fakeTerrain(): TerrainData {
  return {
    name: 't',
    nx: 512,
    ny: 512,
    cellSize: 10,
    elevation: new Float32Array(0),
    bounds: { west: -80.06, east: -79.96, north: 40.48, south: 40.40 },
    imagery: null,
    roads: null,
    attribution: '',
    scenario: null,
  };
}
