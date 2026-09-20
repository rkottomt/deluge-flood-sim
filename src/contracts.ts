/**
 * Deluge — shared contracts between modules.
 *
 * THIS FILE IS THE INTEGRATION CONTRACT. Every module (sim, render, data, routing, ui, app)
 * codes against these types. Do not change a signature here without updating every consumer.
 * Optional members marked "extension" are implemented by the shipped modules and feature-detected by callers.
 *
 * ─── Grid & coordinate conventions (READ THIS) ────────────────────────────────────────────
 *  • The domain is a regular grid of nx × ny square cells, cellSize meters on a side.
 *  • nx and ny are BOTH multiples of 16 (workgroup + readback alignment). Typical: 1024×1024.
 *  • Cell (i, j): i = column index, west → east (0 … nx-1)
 *                 j = row index,    NORTH → SOUTH (0 … ny-1)   ← image order, same as DEM rasters
 *  • Flat arrays are row-major: index = j * nx + i.
 *  • GPU textures: texel (x = i, y = j) holds cell (i, j). Texture row 0 is the north edge.
 *  • "Grid coordinates" (gx, gy) are continuous floats in CELL units: the center of cell (i, j)
 *    is (i + 0.5, j + 0.5); the domain spans [0, nx] × [0, ny].
 *  • World space (render, meters, right-handed, Y up):
 *        X = (gx - nx/2) * cellSize        (east positive)
 *        Z = (gy - ny/2) * cellSize        (south positive)
 *        Y = elevation_m * verticalExaggeration
 *  • Velocity components: u = +X / +i direction (east), v = +Z / +j direction (south). m/s.
 *  • Elevations are meters above the vertical datum (NAVD88 for USGS data).
 */

// ────────────────────────────────────────────────────────────────────────────────────────────
// Geography / terrain data
// ────────────────────────────────────────────────────────────────────────────────────────────

/** Geographic bounds in WGS84 degrees of the grid's OUTER EDGES. Grid is linear in Web Mercator. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export type RoadClass = 'highway' | 'major' | 'minor' | 'local';

/** Road graph in GRID coordinates (cell units, see conventions). Undirected. */
export interface RoadNetwork {
  /** Node positions, interleaved [gx0, gy0, gx1, gy1, ...]. Node k = (nodes[2k], nodes[2k+1]). */
  nodes: Float32Array;
  edges: RoadEdge[];
}

export interface RoadEdge {
  a: number; // node index
  b: number; // node index
  /** Ground length in meters. */
  length: number;
  cls: RoadClass;
  name?: string;
  /** Full polyline in grid coords [gx, gy, gx, gy, ...], starting at node a and ending at node b. */
  pts: Float32Array;
}

/** A named place of refuge for evacuation routing (e.g. a school on high ground). */
export interface Shelter {
  name: string;
  gx: number;
  gy: number;
}

/** A grid-aligned rectangle in cell coordinates (gx east, gy south from the north edge). */
export interface GridRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A finer aerial photo covering `rect` of the grid (src/data/imagery.ts, src/render/textures.ts). */
export interface ImageryDetail {
  image: ImageBitmap;
  rect: GridRect;
}

export interface TerrainData {
  /** Short human name e.g. "Pittsburgh — Three Rivers". */
  name: string;
  nx: number;
  ny: number;
  /** Ground meters per cell (cells are square on the ground). */
  cellSize: number;
  /** nx*ny elevations in meters, row-major, j=0 is the north row. No NaNs (no-data already filled). */
  elevation: Float32Array;
  bounds: GeoBounds;
  /** Aerial imagery covering exactly `bounds`, north-up. Any pixel size. Null if unavailable. */
  imagery: ImageBitmap | null;
  /**
   * Optional second, finer photo over part of the domain (the "detail inset": downtown, where close-ups happen).
   * The renderer blends it over `imagery` inside `rect`. Null when the area has no inset.
   */
  imageryDetail?: ImageryDetail | null;
  roads: RoadNetwork | null;
  /** Attribution line(s) for the data shown on screen. */
  attribution: string;
  /** Optional scenario that comes with a preset. */
  scenario: ScenarioPreset | null;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Scenarios
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface ScenarioPreset {
  /** One-paragraph story shown to the user (e.g. the 1936 St. Patrick's Day flood). */
  description: string;
  /** Sources placed when the scenario starts. */
  sources: WaterSource[];
  storms: StormCell[];
  shelters: Shelter[];
  /** Initial global rain in mm/hr. */
  rainRate: number;
  /**
   * River-stage control, if this scenario has one. Stage sources (type 'stage') have
   * `level = baseLevel + stageOffset` where stageOffset is driven by the UI slider (meters).
   */
  stage: StageControl | null;
  /**
   * Water bodies to pre-fill at load: every cell connected to a seed with bed elevation below
   * `level` gets h = level - bed. Used so rivers/lakes start full.
   * A seed may carry its own surface `level` (sloping rivers): seeds of one fill then compete and the
   * nearest seed sets each connected cell's level (see computeInitialWater in src/data).
   */
  initialFill: { seeds: Array<{ gx: number; gy: number; level?: number }>; level: number }[];
  /** Suggested camera framing. */
  camera?: CameraPose;
  /**
   * Extension: where the scenario's evacuation story starts — a home the demo puts the evacuation pin on, chosen so
   * the route to a shelter re-plans as the flood rises rather than merely existing or merely failing (see
   * artifacts/evac-story). The user can move the pin anywhere; this is only the opening position.
   */
  evacStart?: { gx: number; gy: number; label?: string };
  /**
   * Extension: a levee the "Build a levee" demo raises in one click. It is tied into high ground at both ends and every
   * segment reaches `crest`, so it holds the scenario's most dramatic flood (see src/ui/levee.ts).
   */
  levee?: DemoLevee;
}

/** A demo levee (ScenarioPreset.levee). */
export interface DemoLevee {
  /** What it protects, e.g. "the North Shore". */
  name: string;
  /** Crest elevation, m: each wall segment is built tall enough to reach it. */
  crest: number;
  /** Polyline in grid coords, from high ground to high ground. */
  points: Array<{ gx: number; gy: number }>;
  /** Camera framing the levee and the land behind it. */
  camera?: CameraPose;
}

export interface StageControl {
  /** Label, e.g. "Ohio River at Pittsburgh (Point gauge)". */
  label: string;
  /** Gauge datum elevation in meters: displayed stage (ft) = (waterSurfaceElev - gaugeDatum) / 0.3048. */
  gaugeDatum: number;
  /** Normal water surface elevation in meters (stageOffset = 0). */
  normalLevel: number;
  /** Official flood stage in feet above gauge datum (for the UI marker), if known. */
  floodStageFt?: number;
  /** Named historic crests to mark on the slider, in feet above gauge datum. */
  marks?: Array<{ label: string; ft: number }>;
  /** Slider range in meters of offset above normalLevel. */
  maxOffset: number;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Simulation
// ────────────────────────────────────────────────────────────────────────────────────────────

export type WaterSource =
  | {
      id: string;
      type: 'inflow';
      gx: number;
      gy: number;
      /** Radius in cells of the footprint over which the discharge is spread. */
      radius: number;
      /** Volumetric discharge, m³/s. */
      discharge: number;
      label?: string;
    }
  | {
      id: string;
      type: 'stage';
      gx: number;
      gy: number;
      radius: number;
      /** Target water-surface ELEVATION in meters (not depth). Cells in the footprint are relaxed to it. */
      level: number;
      /**
       * How much of the river-stage slider offset this source follows (default 1): level = base + offsetScale·offset.
       * Where rivers meet, upstream boundaries use a little more than 1 and the downstream boundary a little less,
       * so the water-surface slope that drives the rivers downstream grows with the flood, as it does in a real
       * crest (with every boundary at one level nothing drives the rivers, and floodplain drainage pulled them
       * backwards).
       */
      offsetScale?: number;
      label?: string;
    };

/** Localized storm: rain rate falls off smoothly (e.g. gaussian/smoothstep) to 0 at `radius`. */
export interface StormCell {
  id: string;
  gx: number;
  gy: number;
  /** Radius in cells. */
  radius: number;
  /** Peak rain rate at the center, mm/hr. */
  intensity: number;
}

export interface SimParams {
  /** Manning's roughness n (s·m^-1/3). Default 0.035. */
  manningN: number;
  /** Global uniform rain rate, mm/hr (added on top of storm cells). */
  rainRate: number;
  /** Infiltration / drainage loss, mm/hr, applied only where h > 0. */
  infiltrationRate: number;
  /** Courant number used to choose dt. Default 0.7 (solver may clamp). */
  cfl: number;
  /** Domain edge condition. 'open' = water leaves freely; 'wall' = reflective. */
  boundary: 'open' | 'wall';
  /** Simulated seconds per real second requested by the user (1 … 3600). */
  timeScale: number;
  /**
   * Hard cap on solver substeps per rendered frame (keeps the UI interactive). A fractional cap is met on average
   * (e.g. 4.5 → alternately 4 and 5; extension used by the app's work budget).
   */
  maxSubstepsPerFrame: number;
  /**
   * 'robust' (default): semi-implicit friction, positivity-preserving flux limiter, velocity/Froude cap,
   *   CFL-adaptive dt.
   * 'naive': explicit friction, no flux limiter, no velocity cap, and dt computed with the user's cfl
   *   even if > 1. Exists ONLY for the in-app "why is this hard?" stability demo — it should visibly
   *   blow up (checkerboarding / spikes) within seconds. The solver must survive NaNs produced in this
   *   mode (reset() fully recovers).
   */
  stabilityMode: 'robust' | 'naive';
}

export const DEFAULT_SIM_PARAMS: SimParams = {
  manningN: 0.035,
  rainRate: 0,
  infiltrationRate: 0,
  cfl: 0.7,
  boundary: 'open',
  timeScale: 60,
  maxSubstepsPerFrame: 120,
  stabilityMode: 'robust',
};

/** GPU edit operations. All positions/radii are in grid coordinates (cells). */
export type BrushOp =
  /** Raise a barrier (levee / sandbag wall) along capsule segment a→b: barrier = max(barrier, height). */
  | { kind: 'wall'; ax: number; ay: number; bx: number; by: number; radius: number; height: number }
  /** Remove barriers within the capsule a→b (barrier = 0). */
  | { kind: 'eraseWall'; ax: number; ay: number; bx: number; by: number; radius: number }
  /** Add (amount > 0) or remove (amount < 0) water depth in meters, smooth falloff, never below 0. */
  | { kind: 'water'; gx: number; gy: number; radius: number; amount: number }
  /** Raise (delta > 0) or dig (delta < 0) the ground itself in meters, smooth falloff. */
  | { kind: 'terrain'; gx: number; gy: number; radius: number; delta: number };

export interface StepInfo {
  /** Simulated seconds actually advanced this frame. */
  simSecondsAdvanced: number;
  substeps: number;
  /** dt used per substep, seconds. */
  dt: number;
  /** True if the requested timeScale could not be met because of maxSubstepsPerFrame. */
  throttled: boolean;
}

export interface SimStats {
  /** Simulated time since last reset, seconds. */
  simTime: number;
  maxDepth: number; // m
  maxSpeed: number; // m/s
  /** Total stored water volume, m³. */
  volume: number;
  /** Area with h > 0.01 m, m². */
  wetArea: number;
  /** Area with h > 0.3 m that was dry (h < 0.01) at reset — i.e. newly flooded land, m². */
  floodedArea: number;
  /**
   * Cumulative volume added by rain + inflow + stage sources + brush, m³. It also carries the solver's signed Float32
   * rounding correction (≲ 1e-6 of the stored volume), so it can be slightly non-monotonic, and slightly non-zero in a
   * walled domain without forcing (volumeOut stays exactly 0 there).
   */
  volumeIn: number;
  /** Cumulative volume removed by open boundaries + infiltration + stage sources + brush, m³. */
  volumeOut: number;
  /**
   * Relative mass-balance error: |volume - (initialVolume + volumeIn - volumeOut)| / max(1, initialVolume, peak volume
   * since reset). (Normalized by the most water ever held, not by the ever-growing inflow volume: stage boundaries
   * can exchange many times the domain's storage.) Demonstrates conservation. Should stay ≲ 1e-3.
   */
  massError: number;
  /** Largest Courant number observed in the last stats window. */
  courant: number;
}

/** Latest completed asynchronous GPU readback. */
export interface SimSnapshot {
  simTime: number;
  nx: number;
  ny: number;
  /** nx*ny water depths in meters (row-major). Owned by the solver; do not mutate. */
  depth: Float32Array;
  stats: SimStats;
}

/**
 * The GPU shallow-water solver. Implementations live in src/sim/.
 * All GPU resources are created on the device passed to the factory.
 */
export interface FloodSolver {
  readonly nx: number;
  readonly ny: number;
  readonly cellSize: number;
  readonly device: GPUDevice;

  /**
   * r32float, nx×ny, TEXTURE_BINDING: effective bed elevation z = ground + barrier (meters).
   * This is what water flows over. Updated after brush edits.
   */
  readonly bedTexture: GPUTexture;
  /** r32float, nx×ny, TEXTURE_BINDING: barrier height above ground (m). >0 where walls exist. */
  readonly barrierTexture: GPUTexture;
  /**
   * rgba32float, nx×ny, TEXTURE_BINDING: r = depth h (m), g = u (m/s, east), b = v (m/s, south),
   * a = maximum depth reached since reset (m). Cell-centered. Always reflects the latest completed step.
   * NOTE: the solver may ping-pong internally; ALWAYS read this property each frame rather than caching it.
   */
  readonly stateTexture: GPUTexture;

  params: SimParams;

  setSources(sources: WaterSource[]): void;
  setStorms(storms: StormCell[]): void;

  /** Queue a GPU edit; applied before the next step. Also keeps the CPU mirror of ground/barrier in sync. */
  applyBrush(op: BrushOp): void;

  /**
   * Advance by `realSeconds * params.timeScale` simulated seconds (subject to CFL and maxSubstepsPerFrame).
   * Encodes and submits GPU work. Never blocks on GPU readback.
   */
  step(realSeconds: number): StepInfo;

  /** Reset water to the initial condition (initial fill), keep terrain edits unless resetTerrain. */
  reset(opts?: { resetTerrain?: boolean }): void;

  /** Set the initial water depth field used by reset() (nx*ny meters). Applies immediately. */
  setInitialWater(depth: Float32Array): void;

  /** Latest snapshot (asynchronous readback, ~2–4 Hz). Null until the first readback completes. */
  getSnapshot(): SimSnapshot | null;

  /** CPU mirrors (kept in sync with GPU edits) for picking and routing. Row-major, nx*ny, meters. */
  getGroundCPU(): Float32Array;
  getBarrierCPU(): Float32Array;

  /**
   * Extension (GpuFloodSolver): raise the water surface in place, e.g. rivers rising to a new stage. For every cell with
   * a finite `base` (nx·ny water-surface elevations, m): h = max(h, base + offset − (ground + barrier)); NaN leaves the
   * cell alone. Discharge is kept, the added water is booked in volumeIn (massError stays exact), the CFL estimate
   * accounts for the new depth, and stateTexture is re-exported even while paused. `base` is uploaded once per
   * distinct array object (treat it as immutable); each call then costs a uniform write and one full-grid pass.
   */
  raiseWaterSurface?(base: Float32Array, offset?: number): void;

  destroy(): void;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Rendering
// ────────────────────────────────────────────────────────────────────────────────────────────

export type WaterViewMode =
  /** Photoreal water: absorption, fresnel sky reflection, specular, flow-advected ripples, foam. */
  | 'realistic'
  /** Hazard colormap by current depth (legend bands: 0.15, 0.5, 1, 2, 3+ m). */
  | 'depth'
  /** Hazard colormap by maximum depth reached since reset (flood extent map). */
  | 'maxDepth'
  /** Colormap by flow speed (0 … 5+ m/s). */
  | 'velocity';

export interface CameraPose {
  /** Orbit target in grid coords + elevation in meters. */
  target: { gx: number; gy: number; elevation: number };
  /** Distance from target in meters. */
  distance: number;
  /** Radians, 0 = looking north, increasing clockwise (toward east). */
  yaw: number;
  /** Radians above horizon, (0, π/2]. π/2 = straight down. */
  pitch: number;
}

export interface RenderSettings {
  waterMode: WaterViewMode;
  verticalExaggeration: number; // 1 … 5, default 1.5
  showImagery: boolean;
  showRoads: boolean;
  showContours: boolean;
  /** Global rain rate for rain particle effect intensity (mm/hr). */
  rainRate: number;
  /** Seconds, monotonically increasing, for animation. */
  time: number;
}

/** Per-edge road status for coloring: 0 = dry, 1 = wet (passable, slow), 2 = flooded (impassable). */
export type RoadStatusArray = Uint8Array;

export interface OverlayState {
  /** Road status per edge (same order as TerrainData.roads.edges). Null → all dry. */
  roadStatus: RoadStatusArray | null;
  /** Evacuation route polyline in grid coords [gx, gy, ...], or null. */
  route: Float32Array | null;
  /** Route state for coloring: 'ok' green/cyan, 'blocked' red dashed (no route found). */
  routeState: 'ok' | 'blocked' | 'none';
  sources: WaterSource[];
  storms: StormCell[];
  shelters: Shelter[];
  /** Evacuation start point (the "home"), grid coords. */
  evacStart: { gx: number; gy: number } | null;
  /** In-progress wall polyline being drawn (grid coords) + planned height, for a ghost preview. */
  wallPreview: { pts: Float32Array; height: number; radius: number } | null;
  /** Brush cursor ring on terrain. */
  cursor: { gx: number; gy: number; radius: number; color: [number, number, number] } | null;
}

export interface PickResult {
  gx: number;
  gy: number;
  /** Ground + barrier elevation at the hit (m, no exaggeration). */
  elevation: number;
  /** Water depth at the hit from the latest snapshot (0 if unknown). */
  depth: number;
}

export interface FloodRenderer {
  /**
   * Bind a terrain + solver. Call again whenever a new terrain is loaded. Also captures the "normally wet" mask
   * (rivers and lakes before the flood, used by the depth / max-depth hazard maps) from solver.stateTexture, so call
   * it right after solver.setInitialWater (as src/app/scene.ts does). If the initial water is replaced later, call
   * the extension captureNormalWater() on DelugeRendererAPI.
   */
  setScene(terrain: TerrainData, solver: FloodSolver): void;
  /** Camera state (mutable). The renderer owns an OrbitController attached to the canvas. */
  readonly camera: CameraController;
  setOverlays(overlays: OverlayState): void;
  render(settings: RenderSettings): void;
  /** Ray-cast a canvas pixel (CSS pixels relative to the canvas) onto the terrain surface. */
  pick(cssX: number, cssY: number): PickResult | null;
  resize(): void;
  destroy(): void;
}

export interface CameraController {
  pose: CameraPose;
  /**
   * When false, the controller ignores LEFT-button drags (tools use them); right/middle drag,
   * wheel and touch pinch still work. Default true.
   */
  leftDragOrbits: boolean;
  /** Smoothly animate to a pose over `seconds`. */
  flyTo(pose: CameraPose, seconds?: number): void;
  /** Frame the whole domain from a pleasant 3/4 angle. */
  frameAll(): void;
  /** Snap to top-down view keeping the current target. */
  topDown(): void;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Routing
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface RouteResult {
  state: 'ok' | 'blocked' | 'none';
  /**
   * Polyline in grid coords. 'ok': the route to the shelter. 'blocked': the route the flood cut (drawn red,
   * pulsing) when one exists, else null. 'none': null. lengthMeters/etaSeconds/shelter are 0/0/null unless 'ok'.
   */
  polyline: Float32Array | null;
  lengthMeters: number;
  /** Estimated travel time in seconds (driving, slowed on wet roads). */
  etaSeconds: number;
  shelter: Shelter | null;
  /** Human-readable status line, e.g. "Via Liberty Ave to Pitt campus — 3.4 km, 6 min". */
  message: string;
  // Optional structured parts of `message` (src/routing returns all four), so a UI can lay a route out and format
  // its numbers itself instead of parsing the sentence:
  /** null for 'ok'; otherwise why there is no route. */
  reason?: RouteReason | null;
  /** 'ok': up to two street names carrying most of the route, in travel order ([] if unnamed). [] otherwise. */
  via?: string[];
  /** 'ok': metres of the route on wet (passable, slowed) roads, 0 below 1 m. 0 otherwise. */
  wetMeters?: number;
  /**
   * What to do, readable without a "No safe route" heading. 'blocked': why, and to shelter in place ("Every shelter
   * is flooded. Shelter in place on higher floors."); 'none': the same as `message`; 'ok': ''.
   */
  advice?: string;
  /** 'blocked': the numbers behind `reason` (src/routing fills it in). null for 'ok' and for 'none'. */
  diagnosis?: RouteDiagnosis | null;
  /**
   * 'blocked': the moment this start's last way out closed, when it had one earlier in the run. Set by the app
   * (src/app/evac.ts), which watches the route over simulated time; the router only ever sees one flood field, so
   * it never sets this. null while a route exists and for a start that never had one.
   */
  closure?: RouteClosure | null;
}

/**
 * Why a 'blocked' route is blocked, in numbers rather than a sentence, so a UI can quote them and a measurement can
 * group starts without parsing prose. Everything is measured from the flood field of the last updateFlood.
 */
export interface RouteDiagnosis {
  /** Flood depth at the start point, m. */
  startDepth: number;
  /** Valid shelters considered, and how many of them are above water themselves. */
  shelters: number;
  dryShelters: number;
  /** Roads the start can snap to within the router's snap radius, and how many of those are passable. */
  startRoads: number;
  startRoadsUsable: number;
  /**
   * The route the flood cut: the drive that would exist with every flooded road passable — the polyline a 'blocked'
   * result carries, and its dry-road travel time — plus how much of it is under water now. null when this start
   * reaches no shelter even on a dry network: a gap in the road data rather than a flood.
   */
  cutRoute: { lengthMeters: number; etaSeconds: number; shelterName: string; floodedMeters: number } | null;
}

/** The simulated moment a start's last route to a shelter closed, and the route that was cut (RouteResult.closure). */
export interface RouteClosure {
  /** Simulation clock when the last route closed, s. */
  simTime: number;
  /**
   * Simulated seconds this start had a way out, ending at `simTime`: measured from the route it was first given, or
   * from the one that came back after an earlier closure — never across a stretch when it was already cut off.
   */
  openSeconds: number;
  /** The last route that existed, as it was published. */
  lengthMeters: number;
  etaSeconds: number;
  shelterName: string;
}

/** Why RouteResult has no route ('none' and 'blocked' states). */
export type RouteReason =
  /** none: the area has no road data. */
  | 'no-roads'
  /** none: no start point chosen yet. */
  | 'no-start'
  /** none: no (valid) shelters. */
  | 'no-shelters'
  /** none: no road near the start. */
  | 'start-off-network'
  /** none: no shelter near a road. */
  | 'shelters-off-network'
  /** none: the start is in a river or lake (standing water at load) — a misplaced click. */
  | 'start-in-water-body'
  /** blocked: the start itself is under floodwater. */
  | 'start-flooded'
  /** blocked: every road near the start is flooded. */
  | 'start-roads-flooded'
  /** blocked: every shelter is under water. */
  | 'shelters-flooded'
  /** blocked: flooded roads cut every path to a shelter. */
  | 'cut-off';

export interface EvacuationRouter {
  /**
   * Rebuild the graph for a new road network. `grid` declares the terrain grid the network refers to
   * (otherwise it is taken from the first updateFlood call).
   */
  setNetwork(net: RoadNetwork | null, cellSize: number, grid?: { nx: number; ny: number }): void;
  /**
   * Standing water at load (rivers, lakes: computeInitialWater's output) so roads on bridges over it are not
   * treated as flooded. null = judge every cell by depth alone. Call after setNetwork.
   */
  setBaselineWater?(depth: Float32Array | null, nx: number, ny: number): void;
  /**
   * Recompute per-edge water depth + status from a depth field (nx*ny). Cheap enough for 2–4 Hz.
   * Returns a NEW array instance exactly when some status changed (buffers are recycled: read only the latest).
   */
  updateFlood(depth: Float32Array, nx: number, ny: number): RoadStatusArray | null;
  /** Shortest safe path from `start` to the nearest reachable shelter given the last updateFlood. */
  route(start: { gx: number; gy: number } | null, shelters: Shelter[]): RouteResult;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Automation hook (used by e2e tests and demos). Installed by src/main.ts as window.__deluge.
// ────────────────────────────────────────────────────────────────────────────────────────────

export interface DelugeDebugAPI {
  /** Resolves once the first frame with terrain + water has rendered. */
  ready: Promise<void>;
  loadPreset(id: string): Promise<void>;
  listPresets(): string[];
  setPaused(paused: boolean): void;
  setRain(mmPerHour: number): void;
  setStageOffset(meters: number): void;
  setTimeScale(scale: number): void;
  setWaterMode(mode: WaterViewMode): void;
  /** Draw a wall through grid-coord points. */
  drawWall(points: Array<{ gx: number; gy: number }>, height: number): void;
  addSource(source: WaterSource): void;
  setEvacStart(p: { gx: number; gy: number } | null): void;
  setCamera(pose: Partial<CameraPose>): void;
  /** Run the sim as fast as possible until simTime advances by `simSeconds` (renders along the way). */
  runFor(simSeconds: number): Promise<void>;
  getStats(): SimStats | null;
  getRoute(): RouteResult | null;
  /** Errors captured from device.onuncapturederror, device.lost, and window errors. */
  errors: string[];
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// Module factories (each module's index.ts exports at least these)
// ────────────────────────────────────────────────────────────────────────────────────────────
//
//  src/sim/index.ts:
//    export function createSolver(device: GPUDevice, terrain: SolverTerrainInput,
//                                 params?: Partial<SimParams>, options?: Partial<SolverOptions>): Promise<FloodSolver>;
//    (options = numerical tunables, see src/sim/constants.ts, e.g. `wallAdvection` (default 0.1): the fraction of
//     convective acceleration kept on faces next to dry or blocked faces. `gpuBudgetMs`: GPU compute ms per frame
//     measured with timestamp queries; Infinity = off, for hosts that pace the solver themselves such as the app's
//     governor. The concrete GpuFloodSolver also exposes it as a settable property, and raiseWaterSurface.)
//  src/render/index.ts:
//    export function createRenderer(device: GPUDevice, canvas: HTMLCanvasElement,
//                                   format: GPUTextureFormat, options?: RendererOptions): Promise<FloodRenderer>;
//    (options.quality 'auto'|'high'|'balanced'|'low'; the concrete DelugeRendererAPI adds setQuality(), stats and
//     captureNormalWater() — re-capture the normally-wet mask after replacing the initial water.)
//  src/routing/index.ts:
//    export function createRouter(): EvacuationRouter;
//  src/data/index.ts:
//    export function listPresets(): PresetInfo[];
//    export function loadPreset(id: string, onProgress?: ProgressFn): Promise<TerrainData>;
//    export function loadLiveArea(req: LiveAreaRequest, onProgress?: ProgressFn, signal?: AbortSignal): Promise<TerrainData>;
//    export function computeInitialWater(terrain: TerrainData, scenario: ScenarioPreset | null): Float32Array;
//    export function geoToGrid(terrain: Pick<TerrainData,'nx'|'ny'|'bounds'>, lon: number, lat: number): { gx: number; gy: number };
//    export function gridToGeo(terrain: Pick<TerrainData,'nx'|'ny'|'bounds'>, gx: number, gy: number): { lon: number; lat: number };
//  src/ui/index.ts:
//    export function mountUI(root: HTMLElement, store: Store, actions: AppActions): void;
//    export function createToolController(canvas: HTMLCanvasElement, deps: ToolControllerDeps): ToolController;
//  src/gpu.ts: export function createDelugeDevice(gpu: GPU): Promise<DelugeGPU>;
//  src/app/store.ts: export function createStore(initial: AppState): Store;

export type SolverTerrainInput = Pick<TerrainData, 'nx' | 'ny' | 'cellSize' | 'elevation'>;

export type ProgressFn = (message: string, fraction: number) => void;

export interface PresetInfo {
  id: string;
  name: string;
  /** One line, e.g. "1936 St. Patrick's Day flood — raise the rivers". */
  subtitle: string;
}

export interface LiveAreaRequest {
  center: { lat: number; lon: number };
  /** Side length of the square domain on the ground, meters (1000 … 20000). */
  sizeMeters: number;
  /** Grid cells per side (multiple of 16). */
  resolution: 512 | 1024 | 2048;
  /** Optional display name (e.g. geocoder result). */
  name?: string;
  /** The name came from a shared link (?name=): used only when reverse geocoding gives nothing. */
  nameFromLink?: boolean;
}

// ────────────────────────────────────────────────────────────────────────────────────────────
// App state (src/app owns the loop; src/ui renders this state and calls AppActions)
// ────────────────────────────────────────────────────────────────────────────────────────────

export type ToolId =
  | 'orbit' // camera only
  | 'wall' // click-drag polyline → levee / sandbag wall of state.wallHeight
  | 'eraseWall' // drag to erase walls
  | 'inflow' // click to place an inflow source (state.inflowDischarge); click an existing one to remove
  | 'storm' // click to place a storm cell (state.stormIntensity, radius from brushRadius); click existing to remove
  | 'water' // hold to pour water (shift = remove)
  | 'dig' // hold to lower ground (shift = raise)
  | 'evac' // click to set the evacuation start point
  | 'shelter' // click to add a shelter; click existing to remove
  | 'probe'; // hover readout of elevation / depth / speed

export interface AppState {
  presetId: string | null;
  terrainName: string;
  attribution: string;
  /** Non-null while loading terrain. `cancellable`: the load can be stopped with AppActions.cancelLoad (live areas). */
  loading: { message: string; progress: number; cancellable?: boolean } | null;
  error: string | null;
  paused: boolean;
  tool: ToolId;
  /** Wall height for the wall tool, meters (0.5 … 10). */
  wallHeight: number;
  /** Brush radius on the ground, meters. */
  brushRadius: number;
  /** Discharge for newly placed inflow sources, m³/s. */
  inflowDischarge: number;
  /** Intensity for newly placed storm cells, mm/hr. */
  stormIntensity: number;
  sim: SimParams;
  /** River stage slider offset above StageControl.normalLevel, meters (the target the river rises or falls to). */
  stageOffset: number;
  /**
   * River stage offset currently applied in the simulation, meters. It follows stageOffset at a limited rate in
   * SIMULATED time (≈ 3 m per sim-minute, see src/app/stageRamp.ts): an instant 9 m jump would be a dam break along
   * every bank. Equal to stageOffset once the river has arrived.
   */
  stageOffsetApplied: number;
  render: {
    waterMode: WaterViewMode;
    verticalExaggeration: number;
    showImagery: boolean;
    showRoads: boolean;
    showContours: boolean;
  };
  sources: WaterSource[];
  storms: StormCell[];
  shelters: Shelter[];
  evacStart: { gx: number; gy: number } | null;
  scenario: ScenarioPreset | null;
  /** Terrain metadata for UI unit conversions (null before load). */
  grid: { nx: number; ny: number; cellSize: number } | null;
  stats: SimStats | null;
  stepInfo: StepInfo | null;
  fps: number;
  route: RouteResult | null;
  /** Probe readout under the cursor. */
  probe: { gx: number; gy: number; elevation: number; depth: number; speed: number; lat: number; lon: number } | null;
  panels: { howItWorks: boolean; locationPicker: boolean; help: boolean };
  /** GPU adapter description for the diagnostics panel. */
  gpuInfo: string;
}

export interface Store {
  get(): AppState;
  /** Shallow-merge patch; notifies subscribers synchronously if anything changed (by ===). */
  set(patch: Partial<AppState>): void;
  subscribe(fn: (state: AppState, prev: AppState) => void): () => void;
}

export interface AppActions {
  loadPreset(id: string): Promise<void>;
  /**
   * Load a live area. Resolves 'ok', 'failed' (already reported; the previous scene stays) or 'superseded' (a newer
   * load or cancelLoad overtook it). Contract-only implementations may resolve undefined.
   */
  loadLiveArea(req: LiveAreaRequest): Promise<'ok' | 'failed' | 'superseded' | void>;
  /** Stop the terrain load in progress (downloads aborted, the scene on screen kept). Optional extension. */
  cancelLoad?(): void;
  listPresets(): PresetInfo[];
  /** Reset water to the scenario's initial condition; keep walls/edits. */
  resetWater(): void;
  /** Reset water AND terrain edits (walls, digging). Keeps sources/storms. */
  resetAll(): void;
  clearWalls(): void;
  /** Restore scenario sources/storms/shelters/rain/stage from the preset. */
  restoreScenario(): void;
  cameraFrameAll(): void;
  cameraTopDown(): void;
  /** Toggle the stability demo: sets sim.stabilityMode='naive' & cfl=1.8, or restores robust + resets water. */
  setStabilityDemo(on: boolean): void;
}

export interface ToolControllerDeps {
  store: Store;
  renderer: FloodRenderer;
  getSolver(): FloodSolver | null;
  getTerrain(): TerrainData | null;
}

export interface ToolController {
  /** Transient overlay parts owned by the active tool (merged into OverlayState by the app each frame). */
  getTransientOverlay(): Pick<OverlayState, 'wallPreview' | 'cursor'>;
  /** Called every frame (for held tools like water/dig), realSeconds since last frame. */
  update(realSeconds: number): void;
  destroy(): void;
}
