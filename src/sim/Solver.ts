/**
 * GpuFloodSolver — the WebGPU shallow-water solver behind Deluge.
 *
 * ── Per substep (all substeps of a frame go into ONE compute pass / command buffer) ──────────────────────
 *   Pass A  momentum      state[p] ──▶ flux          (face discharges: pressure/bed slope, advection,
 *                                                     semi-implicit friction, θ smoothing, velocity cap)
 *   Pass B  continuity    state[p] + flux ──▶ state[1−p]  (+ accounting buffer)
 *                                                    (positivity limiter, ∂h/∂t = −∇·q, rain, sources,
 *                                                     infiltration, storm drains, stage levels with no momentum
 *                                                     inside a stage disc, open boundaries closed next to inflows)
 *   Land surface (setLandSurface, optional): building obstacles in the state bed (rebuilt in place by the brush pass),
 *            a per-cell Manning factor read by pass A and a drain capacity read by pass B (one rg32float texture).
 * ── On demand ──────────────────────────────────────────────────────────────────────────────────────────
 *   Brush   walls / erase / water / dig over a rectangle (CPU mirrors of ground + walls kept in sync)
 *   Raise   raiseWaterSurface: h = max(h, base + offset − bed) in place (river crests), booked as inflow
 * ── Per frame ──────────────────────────────────────────────────────────────────────────────────────────
 *   Export  state ──▶ stateTexture (h, u, v, maxDepth)   for the renderer, LAZILY: on the first read of stateTexture
 *            after a step (a renderer refreshing its water every other frame pays for every other export), or
 *            before a stats readback. Also folds the export into the hazard accumulators (max speed, max h·|u|,
 *            arrival time, wet seconds; hazardBuffer / readHazardFields), interpolating between exports.
 *   Readback (every ~300 ms, never blocking): a reduction pass (shaders/stats.ts) writes depth + per-16×16-block
 *            sums/maxima of the accounting buffer and state, the accounting buffer is ZEROED IN THE SAME ENCODER
 *            (no substep lost or counted twice), both are copied to MAP_READ buffers → mapAsync → Float64 stats.
 *   Budget   the frame's compute pass carries timestamp queries; measured GPU ms/substep caps the substeps per
 *            frame so solver work stays within options.gpuBudgetMs (8 ms by default; budget.ts) — sim speed
 *            degrades, frame rate does not. gpuBudgetMs = Infinity switches the budget (and its GPU timestamp
 *            readbacks) off, for hosts that pace the solver themselves (the Deluge app: src/app/governor.ts).
 *            While the budget cannot bind (it allows ≥ 2× maxSubstepsPerFrame) it is re-measured only every
 *            PROBE_IDLE_MS instead of every frame.
 *
 * ── Why it stays stable (the short version) ──────────────────────────────────────────────────────────────
 *   1. CFL-adaptive timestep  dt = Cr·dx / (√2·max_cells(√(g·h) + |u|)) — the 2-D Courant condition of the
 *      staggered scheme (derivation at computeDt) — from a lagged readback inflated by safety margins and by
 *      what we know is coming (stage sources, water brush, released bores, rain on dry ground).
 *   2. Semi-implicit friction: division instead of subtraction, so thin films cannot overshoot.
 *   3. Positivity-preserving donor-cell flux limiter: depth can never go negative; every change to h, Float32
 *      rounding included, is booked, so the mass balance is exact.
 *   4. Well-balanced face depth/slope: a lake at rest on rough terrain stays at rest.
 *   (+ de Almeida θ-smoothing and a velocity/Froude cap as safety nets.)
 *   'naive' mode removes 2–4 and the margins and lets C > 1 — it blows up; the solver suites compare the two
 *   to show the safeguards are what keeps the robust path stable (tests/sim/robustness.test.ts).
 */
import {
  DEFAULT_SIM_PARAMS,
  type BrushOp,
  type FloodSolver,
  type HazardFields,
  type LandSurface,
  type LandSurfacePorosity,
  type SimParams,
  type SimSnapshot,
  type SimStats,
  type SolverTerrainInput,
  type StepInfo,
  type StormCell,
  type WaterSource,
} from '../contracts';
import { applyBrushCPU, brushOpValid, brushRect, packBrushUniform, packRebedUniform } from './brush';
import { GpuWorkBudget } from './budget';
import {
  DEFAULT_SOLVER_OPTIONS,
  GRAVITY,
  MAX_SOURCES,
  MAX_STORMS,
  MMHR_TO_MS,
  POROSITY_EDGE_BAND,
  POROSITY_MIN,
  VELOCITY_DEPTH,
  WET_DEPTH,
  type SolverOptions,
} from './constants';
import { footprintRadius, inflowVariesUntil, packForcing, peakInflow, sourceFootprint, type ForcingWindow, type Footprint, type PackedForcing } from './forcing';

/** How far ahead (simulated s) the CFL estimate looks along an inflow hydrograph for the flow it is about to reach. */
const HYDROGRAPH_LOOKAHEAD_S = 120;
import { HAZARD_PER_CELL, unpackHazardFields } from './hazard';
import { RHEO_VISC_DEPTH, rheologyCoefficients } from './rheology';
import type { Rheology } from '../hazard/types';
import { brushWGSL, BRUSH_UNIFORM_BYTES } from './shaders/brush';
import { ACC_PER_CELL, FORCING_UNIFORM_BYTES, SIM_UNIFORM_BYTES } from './shaders/common';
import { continuityWGSL } from './shaders/continuity';
import { exportWGSL } from './shaders/exportState';
import { momentumWGSL } from './shaders/momentum';
import { RAISE_UNIFORM_BYTES, raiseWGSL } from './shaders/raise';
import { STAT, STATS_PER_BLOCK, statsWGSL } from './shaders/stats';

const WG = 16;
/** Re-measure the GPU budget at most this often while it cannot limit the substeps (see substepCap). */
const PROBE_IDLE_MS = 500;
/** Upper bound on the readback lag the rain CFL estimate assumes, simulated s (hollows fill and spill; see rainDepthAhead). */
const RAIN_LAG_MAX_S = 1200;
/** reset() keeps a GPU copy of the initial state up to this grid size (16 MB at 1024²); larger grids rebuild it each time. */
const RESET_CACHE_MAX_CELLS = 1 << 20;
/**
 * step(…, maxSimSeconds): a remainder shorter than this (s) is not run as its own substep. Float64 rounding of
 * n·dt + (limit − n·dt) leaves ~1e-13 s; anything that small is dropped rather than run as a microscopic step.
 */
export const MIN_TAIL_STEP_S = 1e-6;
/** Most hazard samples (intermediate exports) inside one step() frame; beyond it the samples are spread wider. */
const MAX_HAZARD_SAMPLES = 32;
const now =() => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface StagingSet {
  depth: GPUBuffer;
  blocks: GPUBuffer;
  busy: boolean;
}

/** readHazardFields' MAP_READ buffers: the hazard accumulators and the exported state (for max depth). */
interface HazardStaging {
  hazard: GPUBuffer;
  state: GPUBuffer;
  busy: boolean;
}

interface ReadbackMeta {
  gen: number;
  simTime: number;
  dtMax: number;
  seq: number;
}

/** Extra diagnostics from the latest readback (not part of the contract). */
export interface ReadbackDiagnostics {
  /** Cells whose depth was NaN/±Inf (only possible in 'naive' mode). */
  nonFiniteCells: number;
  /** Minimum depth seen (negative only possible in 'naive' mode). */
  minDepth: number;
  /** Main-thread milliseconds spent turning the mapped buffers into a snapshot. */
  processMs: number;
}

export class GpuFloodSolver implements FloodSolver {
  readonly nx: number;
  readonly ny: number;
  readonly cellSize: number;
  readonly device: GPUDevice;
  readonly bedTexture: GPUTexture;
  readonly barrierTexture: GPUTexture;
  params: SimParams;
  readonly options: SolverOptions;
  /** Internal elevation datum (min terrain elevation); the state texture stores z − z0. */
  readonly z0: number;

  private readonly N: number;
  private readonly cellArea: number;
  private readonly originalGround: Float32Array;
  private readonly ground: Float32Array;
  /** Ensemble DEM perturbation currently added to `ground` (setBedPerturbation), or null. */
  private bedPerturb: Float32Array | null = null;
  private readonly barrier: Float32Array;
  /**
   * Land-surface layers (setLandSurface): the building obstacles as given (null = off) and as applied — the given
   * heights with cells wet in the initial water left open, all zero when off; the applied ones are part of the state
   * bed (ground + barrier + obstacle) and of obstacleTex, never of bedTexture or the CPU ground/barrier mirrors.
   */
  private obstacleInput: Float32Array | null = null;
  private readonly obstacle: Float32Array;
  private obstacleCount = 0;
  private readonly obstacleTex: GPUTexture;
  /** rgba32float: (roughness factor, drain capacity m/s, downspout factor, 0) per cell — SURFACE_WGSL in shaders/common.ts. */
  private readonly surfaceTex: GPUTexture;
  private roughnessOn = false;
  private drainsOn = false;
  /**
   * Building porosity (setLandSurface): the porosities as given (null = off) and as applied — clamped, never on cells
   * with initial water or in the edge band, faces capped at the smaller φ — in porosityTex, rgba32float (φ, ψ east,
   * ψ south, roof share); see POROSITY_WGSL in shaders/common.ts.
   */
  private porosityInput: LandSurfacePorosity | null = null;
  private readonly porosityTex: GPUTexture;
  private porosityOn = false;
  private porousCells = 0;
  private readonly groundTex: GPUTexture;
  private readonly stateTex: [GPUTexture, GPUTexture];
  private readonly fluxTex: GPUTexture;
  private readonly exportTex: [GPUTexture, GPUTexture];
  private readonly accBuf: GPUBuffer;
  /** Hazard accumulators, vec4f per cell (src/sim/hazard.ts), updated in place by the export pass. */
  private readonly hazardBuf: GPUBuffer;
  /** Readback reduction outputs (shaders/stats.ts) and the dry-at-reset bitmask it reads. */
  private readonly depthBuf: GPUBuffer;
  private readonly blocksBuf: GPUBuffer;
  private readonly dryMaskBuf: GPUBuffer;
  private readonly nBlocks: number;
  private readonly simBuf: GPUBuffer;
  private readonly forcingBuf: GPUBuffer;
  private readonly brushBuf: GPUBuffer;
  private readonly simBytes = new ArrayBuffer(SIM_UNIFORM_BYTES);
  private readonly simI32 = new Int32Array(this.simBytes);
  private readonly simF32 = new Float32Array(this.simBytes);

  private readonly momentumPipe: GPUComputePipeline;
  private readonly continuityPipe: GPUComputePipeline;
  /**
   * The same passes compiled with land-surface layers on, same bind groups: momentum [plain, ROUGHNESS_MAP, POROSITY,
   * both], continuity [plain, STORM_DRAINS, POROSITY, both], export [plain, POROSITY] (index bit 1 = the first layer,
   * bit 2 = POROSITY).
   */
  private readonly momentumPipes: GPUComputePipeline[];
  private readonly continuityPipes: GPUComputePipeline[];
  private readonly exportPipes: GPUComputePipeline[];
  private readonly exportPipe: GPUComputePipeline;
  private readonly brushPipe: GPUComputePipeline;
  private readonly raisePipe: GPUComputePipeline;
  private readonly raiseLayout: GPUBindGroupLayout;
  private readonly statsPipe: GPUComputePipeline;
  private readonly brushLayout: GPUBindGroupLayout;
  private readonly bgMomentum: GPUBindGroup[];
  private readonly bgContinuity: GPUBindGroup[];
  /** [statePartity][exportParity] */
  private readonly bgExport: GPUBindGroup[][];
  /** [stateParity][exportParity] */
  private readonly bgStats: GPUBindGroup[][];
  private brushRes: { tex: GPUTexture[]; bg: GPUBindGroup[] } | null = null;
  /** raiseWaterSurface: the uploaded base array (by identity), its texture, bind groups and channel cells. */
  private raiseRes: {
    base: Float32Array;
    tex: GPUTexture;
    buf: GPUBuffer;
    bg: GPUBindGroup[];
    /** Indices of cells with a finite base, and their base (m). */
    cells: Int32Array;
    levels: Float32Array;
    /** max(base − bed) and max(base − bed − depth) over the cells, for the depth array / terrain / fill they were taken at. */
    rise: { depth: Float32Array | null; terrain: number; initial: number; overBed: number; overWater: number };
  } | null = null;
  private readonly gx: number;
  private readonly gy: number;

  /** Current state parity (stateTex[cur] holds the latest state) and export parity. */
  private cur = 0;
  private exportCur = 0;
  /**
   * The internal state has advanced past the exported stateTexture. Frames from step() do not export: the export
   * pass (~⅓ of a substep) runs when something reads stateTexture (the renderer, only on frames it refreshes its
   * water textures) or a stats readback needs it. See the stateTexture getter.
   */
  private exportDirty = false;
  /** Incremented whenever the (exported) water state changes: step, brush, raise, reset. */
  private stateVersionN = 0;
  /** Incremented whenever ground or barrier (bedTexture / barrierTexture) change. */
  private terrainVersionN = 0;

  private sources: WaterSource[] = [];
  private storms: StormCell[] = [];
  private forcing: PackedForcing;
  private forcingDirty = true;
  /** setSources since the last refreshForcing (a terrain edit also re-packs the forcing, but starts no new flow). */
  private sourcesChanged = false;
  private warnedDropped = false;
  /**
   * Latest simulated time at which an inflow's discharge still changes — its stopAfter, or the end of its hydrograph
   * (0 = every inflow is constant). While that is still ahead of the frame last packed, the forcing is re-packed every
   * frame — see gateTimedInflow.
   */
  private inflowStopAt = 0;
  /** Simulated-time window the packed forcing was built for (null = t = 0, i.e. nothing has stopped yet). */
  private forcingWindow: ForcingWindow | null = null;

  private initialDepth: Float32Array;
  /**
   * reset()'s initial state (h0, 0, 0, bed − z0) kept on the GPU, so a reset is one texture copy: the one-click levee
   * resets the flood mid-demo, and rebuilding and uploading 4·N floats took ~10 ms of that frame. Rebuilt after
   * setInitialWater and terrain uploads; wall and terrain brushes patch their rectangle. Grids above
   * RESET_CACHE_MAX_CELLS rebuild it on every reset instead of holding the extra texture.
   */
  private resetTex: GPUTexture | null = null;
  private resetTexValid = false;
  /** Deepest initial water (m), computed with the reset state. */
  private resetHMax = 0;
  /** Bumped when initialDepth changes in place (setInitialWater). */
  private initialVersion = 0;
  /** Wall brushes' extent since the last terrain reset (see wallBounds). */
  private wallRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  /** Stage/inflow footprints by position and radius (the stage ramp re-packs the forcing every few centimetres). */
  private readonly footprintCache = new Map<string, Footprint>();
  private dryAtReset: Uint8Array;
  private initialVolume = 0;
  /** Largest stored volume seen since reset (normalizes SimStats.massError), m³. */
  private peakVolume = 0;
  private resetMaxPending = true;
  /**
   * Hazard accumulator clock (shaders/exportState.ts): the simulated time the latest export described, and the one the
   * Sim uniform currently carries for the next export (writeSimUniform; encodeExport adopts it). The export's interval
   * is their difference.
   */
  private hazardTime = 0;
  private hazardTimePending = 0;
  /** readHazardFields' reusable staging pair (a call finding it busy maps a temporary pair of its own). */
  private hazardStaging: HazardStaging | null = null;

  private simTime = 0;
  /** Requested simulated time not yet covered by a whole substep (carried between frames), s. */
  private pendingSimTime = 0;
  private generation = 0;
  private volumeIn = 0;
  private volumeOut = 0;
  private snapshot: SimSnapshot | null = null;
  private diagnostics: ReadbackDiagnostics = { nonFiniteCells: 0, minDepth: 0, processMs: 0 };
  private readonly staging: StagingSet[] = [];
  private readonly pendingMaps = new Set<Promise<void>>();
  private lastReadbackMs = -Infinity;
  /** stateVersionN when the latest readback was encoded (requestReadback skips when nothing changed since). */
  private readbackVersion = -1;
  /** Sim uniform blocks for the hazard samples inside a frame (encodeFrame); created on first use. */
  private hazardSampleBuf: GPUBuffer | null = null;
  /** Largest dt used since the last readback was encoded (for the Courant statistic), and the last dt. */
  private windowDtMax = 0;
  private lastDt = 0;

  /** Lagged maxima from the latest readback, used for the CFL timestep. */
  private hRead = 0;
  private uRead = 0;
  /** Largest per-cell gravity-wave speed √(g·h) + |u| of the latest readback (robust-mode CFL input). */
  private waveRead = 0;
  /** Known sudden depth (water brush) not yet visible in a readback, and the edit sequence that caused it. */
  private hBoost = 0;
  private hBoostSeq = 0;
  /**
   * Flow speed that sources just (re)configured will produce but no readback shows yet (inflow jets, water released
   * by raising a stage level), m/s, and the simulated time it was set at. Cleared by the first readback whose
   * window ran after that time (see forcingSpeedEstimate).
   */
  private uBoost = 0;
  private uBoostTime = -Infinity;
  /** The scenario's rheology (setRheology; water by default) and the speed cap in force, m/s (options.uMax by default). */
  private rheologyNow: Rheology = { kind: 'water' };
  private uMaxNow: number;
  /** Simulated time of the latest processed readback, and the simulated time between the last two (s). */
  private readSimTime = 0;
  private readSpan = 0;
  private editSeq = 0;

  /** Adaptive substep budget (measured GPU ms per substep → substeps per frame). */
  private readonly budget: GpuWorkBudget;
  private lastProbeMs = -Infinity;
  private inflight = 0;
  private inflightSince = 0;
  /** Carried fraction of a fractional maxSubstepsPerFrame (see ditheredSubstepCap). */
  private capCarry = 0;
  private destroyed = false;

  private constructor(
    device: GPUDevice,
    terrain: SolverTerrainInput,
    params: SimParams,
    options: SolverOptions,
    pipes: {
      momentum: GPUComputePipeline;
      continuity: GPUComputePipeline;
      momentumVariants: GPUComputePipeline[];
      continuityVariants: GPUComputePipeline[];
      exportVariants: GPUComputePipeline[];
      brush: GPUComputePipeline;
      brushLayout: GPUBindGroupLayout;
      raise: GPUComputePipeline;
      raiseLayout: GPUBindGroupLayout;
      stats: GPUComputePipeline;
    },
  ) {
    const { nx, ny, cellSize } = terrain;
    this.device = device;
    this.nx = nx;
    this.ny = ny;
    this.cellSize = cellSize;
    this.params = params;
    this.options = options;
    this.uMaxNow = options.uMax;
    this.N = nx * ny;
    this.cellArea = cellSize * cellSize;
    this.gx = Math.ceil(nx / WG);
    this.gy = Math.ceil(ny / WG);
    this.nBlocks = (nx / 16) * (ny / 16);
    // Conservative initial guess (~2 ns per cell); replaced by measurements within a few frames.
    this.budget = new GpuWorkBudget(device, options.gpuBudgetMs, Math.max(0.05, this.N * 2e-6));

    // Terrain mirrors. Non-finite elevations (contract says none) are replaced by the minimum.
    let zmin = Infinity;
    for (let i = 0; i < this.N; i++) {
      const v = terrain.elevation[i];
      if (Number.isFinite(v) && v < zmin) zmin = v;
    }
    if (!Number.isFinite(zmin)) zmin = 0;
    this.z0 = Math.fround(zmin);
    this.originalGround = new Float32Array(this.N);
    for (let i = 0; i < this.N; i++) {
      const v = terrain.elevation[i];
      this.originalGround[i] = Number.isFinite(v) ? v : zmin;
    }
    this.ground = this.originalGround.slice();
    this.barrier = new Float32Array(this.N);
    this.obstacle = new Float32Array(this.N);
    this.initialDepth = new Float32Array(this.N);
    this.dryAtReset = new Uint8Array(this.N).fill(1);

    // ── Resources ──
    const U = GPUTextureUsage;
    const tex = (label: string, format: GPUTextureFormat, usage: number) =>
      device.createTexture({ label, size: { width: nx, height: ny }, format, usage });
    const stateUsage = U.TEXTURE_BINDING | U.STORAGE_BINDING | U.COPY_DST | U.COPY_SRC;
    this.stateTex = [tex('sim.state0', 'rgba32float', stateUsage), tex('sim.state1', 'rgba32float', stateUsage)];
    this.fluxTex = tex('sim.flux', 'rg32float', U.TEXTURE_BINDING | U.STORAGE_BINDING);
    this.exportTex = [tex('sim.export0', 'rgba32float', stateUsage), tex('sim.export1', 'rgba32float', stateUsage)];
    const terrUsage = U.TEXTURE_BINDING | U.COPY_DST | U.COPY_SRC;
    this.groundTex = tex('sim.ground', 'r32float', terrUsage);
    this.barrierTexture = tex('sim.barrier', 'r32float', terrUsage);
    this.bedTexture = tex('sim.bed', 'r32float', terrUsage);
    this.obstacleTex = tex('sim.obstacle', 'r32float', U.TEXTURE_BINDING | U.COPY_DST);
    this.surfaceTex = tex('sim.surface', 'rgba32float', U.TEXTURE_BINDING | U.COPY_DST);
    this.porosityTex = tex('sim.porosity', 'rgba32float', U.TEXTURE_BINDING | U.COPY_DST);
    {
      // No land-surface layers: roughness factor 1, no drains, no downspouts; every cell and face fully open (read only
      // once a layer switches its pipeline variant on).
      const surf = new Float32Array(this.N * 4);
      const por = new Float32Array(this.N * 4);
      for (let c = 0; c < this.N; c++) {
        surf[4 * c] = 1;
        por[4 * c] = 1;
        por[4 * c + 1] = 1;
        por[4 * c + 2] = 1;
      }
      device.queue.writeTexture({ texture: this.surfaceTex }, surf, { bytesPerRow: nx * 16 }, { width: nx, height: ny });
      device.queue.writeTexture({ texture: this.porosityTex }, por, { bytesPerRow: nx * 16 }, { width: nx, height: ny });
      device.queue.writeTexture({ texture: this.obstacleTex }, this.obstacle, { bytesPerRow: nx * 4 }, { width: nx, height: ny });
    }

    const B = GPUBufferUsage;
    this.accBuf = device.createBuffer({
      label: 'sim.accounting',
      size: this.N * ACC_PER_CELL * 4,
      usage: B.STORAGE | B.COPY_SRC | B.COPY_DST,
    });
    // Written in full by the first export (reset() runs one before anything can read it).
    this.hazardBuf = device.createBuffer({
      label: 'sim.hazard',
      size: this.N * HAZARD_PER_CELL * 4,
      usage: B.STORAGE | B.COPY_SRC,
    });
    this.depthBuf = device.createBuffer({ label: 'sim.readback.depth', size: this.N * 4, usage: B.STORAGE | B.COPY_SRC });
    this.blocksBuf = device.createBuffer({
      label: 'sim.readback.blocks',
      size: this.nBlocks * STATS_PER_BLOCK * 4,
      usage: B.STORAGE | B.COPY_SRC,
    });
    this.dryMaskBuf = device.createBuffer({ label: 'sim.dryMask', size: Math.ceil(this.N / 32) * 4, usage: B.STORAGE | B.COPY_DST });
    this.simBuf = device.createBuffer({ label: 'sim.uniform', size: SIM_UNIFORM_BYTES, usage: B.UNIFORM | B.COPY_DST });
    this.forcingBuf = device.createBuffer({
      label: 'sim.forcing',
      size: FORCING_UNIFORM_BYTES,
      usage: B.UNIFORM | B.COPY_DST,
    });
    this.brushBuf = device.createBuffer({ label: 'sim.brush', size: BRUSH_UNIFORM_BYTES, usage: B.UNIFORM | B.COPY_DST });

    this.momentumPipe = pipes.momentum;
    this.continuityPipe = pipes.continuity;
    this.momentumPipes = pipes.momentumVariants;
    this.continuityPipes = pipes.continuityVariants;
    this.exportPipes = pipes.exportVariants;
    this.exportPipe = pipes.exportVariants[0];
    this.brushPipe = pipes.brush;
    this.brushLayout = pipes.brushLayout;
    this.raisePipe = pipes.raise;
    this.raiseLayout = pipes.raiseLayout;
    this.statsPipe = pipes.stats;

    // ── Bind groups for both ping-pong parities (never created per substep) ──
    const ub = (buffer: GPUBuffer) => ({ buffer });
    this.bgMomentum = [0, 1].map((p) =>
      device.createBindGroup({
        label: `sim.momentum${p}`,
        layout: this.momentumPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: ub(this.simBuf) },
          { binding: 1, resource: this.stateTex[p].createView() },
          { binding: 2, resource: this.fluxTex.createView() },
          { binding: 3, resource: this.surfaceTex.createView() },
          { binding: 4, resource: this.porosityTex.createView() },
        ],
      }),
    );
    this.bgContinuity = [0, 1].map((p) =>
      device.createBindGroup({
        label: `sim.continuity${p}`,
        layout: this.continuityPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: ub(this.simBuf) },
          { binding: 1, resource: ub(this.forcingBuf) },
          { binding: 2, resource: this.stateTex[p].createView() },
          { binding: 3, resource: this.fluxTex.createView() },
          { binding: 4, resource: this.stateTex[1 - p].createView() },
          { binding: 5, resource: ub(this.accBuf) },
          { binding: 6, resource: this.surfaceTex.createView() },
          { binding: 7, resource: this.porosityTex.createView() },
        ],
      }),
    );
    this.bgExport = [0, 1].map((p) =>
      [0, 1].map((e) =>
        device.createBindGroup({
          label: `sim.export${p}${e}`,
          layout: this.exportPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: ub(this.simBuf) },
            { binding: 1, resource: this.stateTex[p].createView() },
            { binding: 2, resource: this.exportTex[e].createView() },
            { binding: 3, resource: this.exportTex[1 - e].createView() },
            { binding: 4, resource: ub(this.hazardBuf) },
            { binding: 5, resource: this.porosityTex.createView() },
          ],
        }),
      ),
    );

    this.bgStats = [0, 1].map((p) =>
      [0, 1].map((e) =>
        device.createBindGroup({
          label: `sim.stats${p}${e}`,
          layout: this.statsPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: ub(this.simBuf) },
            { binding: 1, resource: this.exportTex[e].createView() },
            { binding: 2, resource: ub(this.accBuf) },
            { binding: 3, resource: ub(this.dryMaskBuf) },
            { binding: 4, resource: ub(this.depthBuf) },
            { binding: 5, resource: ub(this.blocksBuf) },
            { binding: 6, resource: this.stateTex[p].createView() },
          ],
        }),
      ),
    );

    this.forcing = this.packForcingNow();
    this.uploadTerrain();
    this.uploadDryMask();
    this.reset();
  }

  /** Async factory: compiles pipelines (async so the browser main thread is not blocked) and uploads terrain. */
  static async create(
    device: GPUDevice,
    terrain: SolverTerrainInput,
    params?: Partial<SimParams>,
    options?: Partial<SolverOptions>,
  ): Promise<GpuFloodSolver> {
    const { nx, ny, cellSize, elevation } = terrain;
    if (!(nx > 0 && ny > 0) || nx % 16 !== 0 || ny % 16 !== 0) {
      throw new Error(`createSolver: nx, ny must be positive multiples of 16 (got ${nx}×${ny})`);
    }
    if (!(cellSize > 0)) throw new Error(`createSolver: cellSize must be > 0 (got ${cellSize})`);
    if (!elevation || elevation.length !== nx * ny) {
      throw new Error(`createSolver: elevation length ${elevation?.length} != nx*ny (${nx * ny})`);
    }
    const lim = device.limits.maxTextureDimension2D;
    if (nx > lim || ny > lim) throw new Error(`createSolver: grid ${nx}×${ny} exceeds maxTextureDimension2D ${lim}`);
    if (nx * ny * 8 > device.limits.maxStorageBufferBindingSize) {
      throw new Error('createSolver: grid too large for the accounting storage buffer on this device');
    }
    if (nx * ny * HAZARD_PER_CELL * 4 > device.limits.maxStorageBufferBindingSize) {
      throw new Error('createSolver: grid too large for the hazard storage buffer on this device');
    }

    const C = GPUShaderStage.COMPUTE;
    const uniform = (binding: number, minBindingSize: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type: 'uniform', minBindingSize },
    });
    // rgba32float / r32float are NOT filterable: layouts must say 'unfilterable-float' explicitly
    // (an 'auto' layout would infer 'float' and Chrome would reject the bind group).
    const sampled = (binding: number): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
    });
    const storageTex = (binding: number, format: GPUTextureFormat): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      storageTexture: { access: 'write-only', format, viewDimension: '2d' },
    });
    const storageBuf = (binding: number, type: GPUBufferBindingType = 'storage'): GPUBindGroupLayoutEntry => ({
      binding,
      visibility: C,
      buffer: { type },
    });

    /**
     * Compile `code` into a pipeline per constants set in `variants` (the first is the default), all sharing one
     * explicit bind group layout so the same bind groups serve every variant.
     */
    const make = async (label: string, code: string, entries: GPUBindGroupLayoutEntry[], variants: Array<Record<string, number>> = [{}]) => {
      const module = device.createShaderModule({ label, code });
      // Readable WGSL diagnostics in the browser. (Dawn-for-node crashes in getCompilationInfo, and there a
      // compile error surfaces through the pipeline promise / error scope anyway.)
      if (typeof window !== 'undefined') {
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === 'error');
        if (errors.length) {
          throw new Error(`${label} WGSL errors:\n${errors.map((e) => `${e.lineNum}:${e.linePos} ${e.message}`).join('\n')}`);
        }
      }
      const layout = device.createBindGroupLayout({ label, entries });
      const pipelineLayout = device.createPipelineLayout({ label, bindGroupLayouts: [layout] });
      const pipelines = await Promise.all(
        variants.map((constants, k) =>
          device.createComputePipelineAsync({
            label: k === 0 ? label : `${label}+${Object.keys(constants).join('+')}`,
            layout: pipelineLayout,
            compute: { module, entryPoint: 'main', constants },
          }),
        ),
      );
      return { pipeline: pipelines[0], variants: pipelines, layout };
    };
    device.pushErrorScope('validation');
    let built: Awaited<ReturnType<typeof make>>[];
    try {
      built = await Promise.all([
      make('sim.momentum', momentumWGSL, [uniform(0, SIM_UNIFORM_BYTES), sampled(1), storageTex(2, 'rg32float'), sampled(3), sampled(4)], [{}, { ROUGHNESS_MAP: 1 }, { POROSITY: 1 }, { ROUGHNESS_MAP: 1, POROSITY: 1 }]),
      make('sim.continuity', continuityWGSL, [
        uniform(0, SIM_UNIFORM_BYTES),
        uniform(1, FORCING_UNIFORM_BYTES),
        sampled(2),
        sampled(3),
        storageTex(4, 'rgba32float'),
        storageBuf(5),
        sampled(6),
        sampled(7),
      ], [{}, { STORM_DRAINS: 1 }, { POROSITY: 1 }, { STORM_DRAINS: 1, POROSITY: 1 }]),
      make('sim.export', exportWGSL, [uniform(0, SIM_UNIFORM_BYTES), sampled(1), sampled(2), storageTex(3, 'rgba32float'), storageBuf(4), sampled(5)], [{}, { POROSITY: 1 }]),
      make('sim.brush', brushWGSL, [
        uniform(0, BRUSH_UNIFORM_BYTES),
        sampled(1),
        sampled(2),
        sampled(3),
        storageTex(4, 'rgba32float'),
        storageTex(5, 'r32float'),
        storageTex(6, 'r32float'),
        storageTex(7, 'r32float'),
        storageBuf(8),
        sampled(9),
      ]),
      make('sim.raise', raiseWGSL, [uniform(0, RAISE_UNIFORM_BYTES), sampled(1), sampled(2), storageTex(3, 'rgba32float'), storageBuf(4)]),
      make('sim.stats', statsWGSL, [
        uniform(0, SIM_UNIFORM_BYTES),
        sampled(1),
        storageBuf(2, 'read-only-storage'),
        storageBuf(3, 'read-only-storage'),
        storageBuf(4),
        storageBuf(5),
        sampled(6),
      ]),
      ]);
    } catch (e) {
      await device.popErrorScope();
      throw e;
    }
    const [momentum, continuity, exportP, brush, raise, stats] = built;
    let solver: GpuFloodSolver;
    try {
      solver = new GpuFloodSolver(
      device,
      terrain,
      { ...DEFAULT_SIM_PARAMS, ...params },
      { ...DEFAULT_SOLVER_OPTIONS, ...options },
      {
        momentum: momentum.pipeline,
        continuity: continuity.pipeline,
        momentumVariants: momentum.variants,
        continuityVariants: continuity.variants,
        exportVariants: exportP.variants,
        brush: brush.pipeline,
        brushLayout: brush.layout,
        raise: raise.pipeline,
        raiseLayout: raise.layout,
        stats: stats.pipeline,
      },
      );
    } catch (e) {
      await device.popErrorScope();
      throw e;
    }
    const err = await device.popErrorScope();
    if (err) {
      solver.destroy();
      throw new Error(`createSolver: GPU validation error: ${err.message}`);
    }
    return solver;
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Contract API
  // ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The exported (h, u, v, max depth) texture of the latest completed step. Exporting is lazy: step() only marks the
   * export stale, and the first read afterwards encodes the export pass in its own command buffer (submitted before
   * whatever the reader then submits). A renderer that refreshes its water textures every other frame therefore pays
   * for every other export; use `stateVersion` to detect changes without triggering one.
   */
  get stateTexture(): GPUTexture {
    if (this.exportDirty && !this.destroyed) {
      const enc = this.device.createCommandEncoder({ label: 'sim.export' });
      this.writeSimUniform(this.lastDt);
      this.encodeExport(enc);
      this.device.queue.submit([enc.finish()]);
    }
    return this.exportTex[this.exportCur];
  }

  /** Changes whenever stateTexture's contents would (step, brush, raise, reset). Reading it never exports. */
  get stateVersion(): number {
    return this.stateVersionN;
  }

  /** Changes whenever bedTexture / barrierTexture change (wall, erase and terrain brushes; terrain reset). */
  get terrainVersion(): number {
    return this.terrainVersionN;
  }

  setSources(sources: WaterSource[]): void {
    this.sources = sources.map((s) => ({ ...s }));
    let stopAt = 0;
    for (const s of this.sources) if (s.type === 'inflow') stopAt = Math.max(stopAt, inflowVariesUntil(s));
    this.inflowStopAt = stopAt;
    // A zero-length window at the current time: a source added mid-run is gated by where the clock already is, and
    // the next frame replaces this with its own window.
    this.forcingWindow = { from: this.simTime, to: this.simTime };
    this.forcingDirty = true;
    this.sourcesChanged = true;
  }

  /**
   * The flow's rheology and speed cap (FloodSolver.setRheology). Water with no uMax is the Manning code path bit for bit;
   * any other law replaces Manning in the momentum pass of robust mode (shaders/momentum.ts RHEOLOGY; naive mode stays
   * water). uMax (m/s, clamped to 1–100; absent or not finite = options.uMax) is the velocity cap of the momentum pass,
   * the boundary outflow and the exported speed, and bounds the CFL estimate's anticipated speeds. Takes effect from the
   * next step; reset() keeps it.
   */
  setRheology(rheology: Rheology, opts?: { uMax?: number }): void {
    this.rheologyNow = rheology && typeof rheology === 'object' ? { ...rheology } : { kind: 'water' };
    const u = opts?.uMax;
    this.uMaxNow = typeof u === 'number' && Number.isFinite(u) ? Math.min(100, Math.max(1, u)) : this.options.uMax;
    // A different cap changes what the sources are about to produce (forcingSpeedEstimate): re-estimate on the next dt.
    this.forcingDirty = true;
    this.sourcesChanged = true;
  }

  /** The rheology set by setRheology (water by default). */
  get rheology(): Rheology {
    return { ...this.rheologyNow };
  }

  /** The velocity cap in force, m/s (options.uMax unless setRheology gave one). */
  get speedCap(): number {
    return this.uMaxNow;
  }

  setStorms(storms: StormCell[]): void {
    this.storms = storms.map((s) => ({ ...s }));
    this.forcingDirty = true;
  }

  applyBrush(op: BrushOp): void {
    if (this.destroyed || !op || !brushOpValid(op)) return;
    const rect = brushRect(op, this.nx, this.ny);
    if (!rect) return;
    if (op.kind === 'water' && op.amount === 0) return;
    const terrainChanged = applyBrushCPU(op, rect, this.ground, this.barrier, this.nx);
    if (terrainChanged) {
      // The packed forcing reads the bed only under stage sources (their depth bound): a wall elsewhere (the one-click
      // levee raises ~1 000 pieces over 2 s) must not re-pack every footprint each frame.
      if (this.rectTouchesStage(rect)) this.forcingDirty = true;
      this.patchResetState(rect);
      if (op.kind === 'wall') {
        const w = this.wallRect;
        const x1 = rect.x0 + rect.w;
        const y1 = rect.y0 + rect.h;
        this.wallRect = w
          ? { x0: Math.min(w.x0, rect.x0), y0: Math.min(w.y0, rect.y0), x1: Math.max(w.x1, x1), y1: Math.max(w.y1, y1) }
          : { x0: rect.x0, y0: rect.y0, x1, y1 };
      }
      this.terrainVersionN++;
    }

    const res = this.ensureBrushResources();
    const { device } = this;
    device.queue.writeBuffer(this.brushBuf, 0, packBrushUniform(op, rect, this.nx, this.ny, this.z0));
    const enc = device.createCommandEncoder({ label: 'sim.brush' });
    const pass = enc.beginComputePass({ label: 'sim.brush' });
    pass.setPipeline(this.brushPipe);
    pass.setBindGroup(0, res.bg[this.cur]);
    pass.dispatchWorkgroups(Math.ceil(rect.w / WG), Math.ceil(rect.h / WG));
    pass.end();
    const origin = { x: rect.x0, y: rect.y0 };
    const size = { width: rect.w, height: rect.h };
    const dests = [this.stateTex[this.cur], this.groundTex, this.barrierTexture, this.bedTexture];
    for (let k = 0; k < 4; k++) {
      enc.copyTextureToTexture({ texture: res.tex[k], origin }, { texture: dests[k], origin }, size);
    }
    // Keep stateTexture in sync with the edit even while paused.
    this.writeSimUniform(0);
    this.encodeExport(enc);
    this.stateVersionN++;
    this.editSeq++;
    if (op.kind === 'water' && op.amount > 0) {
      this.hBoost = Math.max(this.hBoost, this.hRead + op.amount);
      this.hBoostSeq = this.editSeq;
    }
    const map = this.maybeEncodeReadback(enc, false);
    device.queue.submit([enc.finish()]);
    map?.();
  }

  /**
   * Allocate the brush pass's scratch textures now (they are created on the first brush otherwise, in the middle of a
   * wall being raised). Hosts call it when a wall is about to be built.
   */
  prepareBrushes(): void {
    if (!this.destroyed) this.ensureBrushResources();
  }

  /**
   * Upload `base` for raiseWaterSurface ahead of time (it is uploaded once per array object anyway), so the first raise
   * of a scene costs no more than the later ones. Hosts call it while a scene loads.
   */
  prepareRaiseSurface(base: Float32Array): void {
    if (this.destroyed || !base || base.length !== this.N) return;
    this.ensureRaiseResources(base);
  }

  /**
   * Raise the water surface in place (rivers rising to a new stage): for every cell with a finite `base`,
   * h = max(h, base + offset − (ground + barrier)). NaN leaves a cell alone. Discharge is kept; the added water is
   * booked as inflow (volumeIn and massError stay exact); stateTexture is re-exported, so it shows even while paused.
   *
   * `base` (nx·ny water-surface elevations, m) is treated as immutable: it is uploaded to the GPU once per distinct
   * array object, after which a call costs one small uniform write and one full-grid pass — cheap enough to follow a
   * slider or a rising hydrograph several times a second. Pass a new array when the base changes.
   */
  raiseWaterSurface(base: Float32Array, offset = 0): void {
    if (this.destroyed || !base || base.length !== this.N || !Number.isFinite(offset)) return;
    const res = this.ensureRaiseResources(base);
    if (res.cells.length === 0) return;
    const { device } = this;
    // CFL: the deepest water the raise can create, and the speed of the bores it releases where it lifts the surface
    // above the latest readback (the same dam-break estimate as a stage raise, see forcingSpeedEstimate).
    // Both maxima are offset + a per-cell maximum that only changes with the terrain and the water readback: kept
    // between calls (the stage ramp raises the rivers every few centimetres).
    const depth = this.snapshot?.depth ?? this.initialDepth;
    const rise = res.rise;
    if (rise.depth !== depth || rise.terrain !== this.terrainVersionN || rise.initial !== this.initialVersion) {
      let overBed = -Infinity;
      let overWater = -Infinity;
      for (let k = 0; k < res.cells.length; k++) {
        const c = res.cells[k];
        const d = res.levels[k] - (this.ground[c] + this.barrier[c] + this.obstacle[c]);
        if (d > overBed) overBed = d;
        if (d - depth[c] > overWater) overWater = d - depth[c];
      }
      Object.assign(rise, { depth, terrain: this.terrainVersionN, initial: this.initialVersion, overBed, overWater });
    }
    const hMax = Math.max(0, rise.overBed + offset);
    const dhMax = Math.max(0, rise.overWater + offset);
    if (!(hMax > 0)) return;
    const u = new ArrayBuffer(RAISE_UNIFORM_BYTES);
    new Int32Array(u, 0, 2).set([this.nx, this.ny]);
    new Float32Array(u, 8, 1)[0] = offset;
    device.queue.writeBuffer(res.buf, 0, u);
    const enc = device.createCommandEncoder({ label: 'sim.raise' });
    const pass = enc.beginComputePass({ label: 'sim.raise' });
    pass.setPipeline(this.raisePipe);
    pass.setBindGroup(0, res.bg[this.cur]);
    pass.dispatchWorkgroups(this.gx, this.gy);
    pass.end();
    this.cur = 1 - this.cur;
    this.writeSimUniform(0);
    this.encodeExport(enc);
    this.stateVersionN++;
    this.editSeq++;
    this.hBoost = Math.max(this.hBoost, hMax);
    this.hBoostSeq = this.editSeq;
    if (dhMax > 0) {
      this.uBoost = Math.max(this.uBoost, Math.min(this.uMaxNow, 2 * Math.sqrt(GRAVITY * dhMax)));
      this.uBoostTime = this.simTime;
    }
    // No readback here: one taken before any step would pair the raised water with the previous window's (larger)
    // dt and report a Courant number no substep ever ran at. The boosts above cover the CFL until the next one.
    device.queue.submit([enc.finish()]);
  }

  /**
   * Advance realSeconds × timeScale of simulated time. Every substep uses the CFL timestep; requested time that
   * does not fill a whole substep is carried to the next frame (so at timeScale 1, ~one substep per 0.4 s of
   * sim instead of one per frame — up to ~25× less GPU work — and naive mode really runs at the requested Courant
   * number at any time scale). If the substep cap (maxSubstepsPerFrame ∩ GPU budget) cannot keep up, the backlog
   * beyond one substep is dropped and `throttled` is reported: sim speed degrades, frame rate does not.
   *
   * `maxSimSeconds` (default: no limit) caps this frame's advance, carried time included, for a host that has to stop
   * at an exact simulated time (the app's runFor: Site check sweeps, ensembles). When the cap is what limits the
   * frame, the frame lands on it exactly — whole CFL substeps, then one shorter substep for the remainder (shorter than
   * the CFL step, so always stable) — and nothing is carried past it. If the substep budget leaves no room for the
   * short substep this frame, the remainder is carried and run first thing next frame. A remainder under
   * MIN_TAIL_STEP_S is dropped (the reported advance is short by that much).
   */
  step(realSeconds: number, maxSimSeconds = Infinity): StepInfo {
    const info: StepInfo = { simSecondsAdvanced: 0, substeps: 0, dt: 0, throttled: false };
    if (this.destroyed) return info;
    const scale = Number.isFinite(this.params.timeScale) ? Math.max(0, this.params.timeScale) : 0;
    const requested = (Number.isFinite(realSeconds) ? Math.max(0, realSeconds) : 0) * scale;
    const limit = maxSimSeconds >= 0 ? maxSimSeconds : 0; // NaN → 0
    const dt = this.computeDt();
    info.dt = dt;
    if (!(requested > 0) || !(limit > 0)) return info;

    this.pendingSimTime += requested;
    const capped = this.pendingSimTime >= limit;
    if (capped) this.pendingSimTime = limit;
    // 1e-9 relative slack so exact multiples (e.g. timeScale = dt·fps) don't lose a substep to rounding.
    let n = Math.floor(this.pendingSimTime / dt + 1e-9);
    // …but that slack must not take a capped frame past its cap.
    if (capped && n * dt > limit) n = Math.max(0, n - 1);
    const cap = this.substepCap();
    if (n > cap) {
      n = cap;
      info.throttled = true;
    }
    // Landing on the cap: the remainder as one short substep, when the budget has room for it.
    const tail = capped && !info.throttled ? limit - n * dt : 0;
    const runTail = tail >= MIN_TAIL_STEP_S && n + 1 <= cap;
    if (n <= 0 && !runTail) {
      // Nothing to run yet (the carried time is less than one substep), or the GPU queue is backed up.
      if (info.throttled) this.pendingSimTime = Math.min(this.pendingSimTime, dt);
      else if (capped && tail < MIN_TAIL_STEP_S) this.pendingSimTime = 0;
      return info;
    }
    if (n > 0) this.encodeFrame(n, dt, true);
    let advanced = n * dt;
    if (runTail) {
      // Its own command buffer (the Sim uniform carries one dt); the readback and budget probe only if it is alone.
      this.encodeFrame(1, tail, n === 0);
      advanced += tail;
    }
    if (info.throttled) this.pendingSimTime = Math.min(Math.max(0, this.pendingSimTime - n * dt), dt);
    else if (capped) this.pendingSimTime = runTail || tail < MIN_TAIL_STEP_S ? 0 : tail;
    else this.pendingSimTime = Math.max(0, this.pendingSimTime - n * dt);
    info.substeps = n + (runTail ? 1 : 0);
    info.simSecondsAdvanced = advanced;
    return info;
  }

  /**
   * Make sure a readback of the current state is on its way: a no-op when the latest state already has one encoded, or
   * when both staging sets are busy (call again next frame). For a host that has stopped stepping and still needs a
   * snapshot of where it stopped (runFor: a paused solver produces no readbacks of its own).
   */
  requestReadback(): void {
    if (this.destroyed || this.readbackVersion === this.stateVersionN) return;
    const enc = this.device.createCommandEncoder({ label: 'sim.readback' });
    // An export due here describes the current time (the uniform may hold a later frame's or a brush's).
    if (this.exportDirty) this.writeSimUniform(this.lastDt);
    const map = this.maybeEncodeReadback(enc, true);
    if (!map) return;
    this.device.queue.submit([enc.finish()]);
    map();
  }

  reset(opts?: { resetTerrain?: boolean }): void {
    if (this.destroyed) return;
    if (opts?.resetTerrain) {
      this.ground.set(this.originalGround);
      this.bedPerturb = null;
      this.barrier.fill(0);
      this.wallRect = null;
      this.uploadTerrain();
      this.forcingDirty = true;
    }
    const { nx, ny, N } = this;
    const cached = N <= RESET_CACHE_MAX_CELLS;
    if (!cached || !this.resetTexValid) {
      const data = new Float32Array(N * 4);
      let hMax = 0;
      for (let c = 0; c < N; c++) {
        const h = this.initialDepth[c];
        data[4 * c] = h;
        data[4 * c + 3] = this.stateBed(c) - this.z0;
        if (h > hMax) hMax = h;
      }
      this.resetHMax = hMax;
      if (cached) {
        this.resetTex ??= this.device.createTexture({
          label: 'sim.resetState',
          size: { width: nx, height: ny },
          format: 'rgba32float',
          usage: GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
        });
        this.device.queue.writeTexture({ texture: this.resetTex }, data, { bytesPerRow: nx * 16 }, { width: nx, height: ny });
        this.resetTexValid = true;
      } else {
        this.device.queue.writeTexture({ texture: this.stateTex[this.cur] }, data, { bytesPerRow: nx * 16 }, { width: nx, height: ny });
      }
    }
    const hMax = this.resetHMax;

    this.generation++;
    this.simTime = 0;
    this.pendingSimTime = 0;
    this.volumeIn = 0;
    this.volumeOut = 0;
    this.snapshot = null;
    this.windowDtMax = 0;
    this.lastDt = 0;
    this.hRead = hMax;
    this.uRead = 0;
    // Float32 arithmetic like the stats pass, so a lake at rest reads back exactly this value (dt stays constant).
    this.waveRead = Math.fround(Math.sqrt(Math.fround(Math.fround(GRAVITY) * Math.fround(hMax))));
    this.hBoost = 0;
    this.readSimTime = 0;
    this.readSpan = 0;
    this.peakVolume = this.initialVolume;
    this.resetMaxPending = true;
    // The reset's own export restarts the hazard accumulators from the initial water over a zero interval.
    this.hazardTime = 0;
    // All sources start acting on the initial water: the first window must not run on the calm reset state's dt.
    // A timed inflow runs again from the top, so the gate has to be re-packed — the buffer may hold its stopped 0.
    this.forcingWindow = null;
    this.forcingDirty = true;
    this.refreshForcing();
    this.uBoost = this.forcingSpeedEstimate();
    this.uBoostTime = 0;

    const enc = this.device.createCommandEncoder({ label: 'sim.reset' });
    if (cached && this.resetTex) enc.copyTextureToTexture({ texture: this.resetTex }, { texture: this.stateTex[this.cur] }, { width: nx, height: ny });
    enc.clearBuffer(this.accBuf);
    this.writeSimUniform(0);
    this.encodeExport(enc);
    this.stateVersionN++;
    const map = this.maybeEncodeReadback(enc, true);
    this.device.queue.submit([enc.finish()]);
    map?.();
  }

  /**
   * Ensemble members' DEM error (FloodSolver.setBedPerturbation; src/sim/demNoise.ts builds the field): ground += δ,
   * replacing any previous perturbation (that one is subtracted first, so the user's own terrain edits survive), or
   * removing it with null. The bed and the CPU ground mirror change together; the reset state is rebuilt from them on
   * the next reset(), which the caller must issue before stepping (water standing on the old bed is not moved).
   * Barriers stay a separate layer on top. δ must be 0 under the initial water — otherwise the "lake at rest" is not
   * at rest any more — which is the caller's job (demPerturbation masks it). The mass ledger is unaffected: the
   * initial volume is the initial depth, which a bed change does not touch. reset({ resetTerrain }) drops it.
   */
  setBedPerturbation(delta: Float32Array | null): void {
    if (this.destroyed) return;
    if (delta && delta.length !== this.N) throw new Error(`setBedPerturbation: expected ${this.N} values, got ${delta.length}`);
    const old = this.bedPerturb;
    if (!old && !delta) return;
    for (let c = 0; c < this.N; c++) {
      const d = delta ? delta[c] : 0;
      const g = this.ground[c] - (old ? old[c] : 0) + (Number.isFinite(d) ? d : 0);
      this.ground[c] = g;
    }
    this.bedPerturb = delta ? Float32Array.from(delta, (d) => (Number.isFinite(d) ? d : 0)) : null;
    this.uploadTerrain();
    this.forcingDirty = true;
  }

  /** The bed perturbation in force (setBedPerturbation), or null. */
  get bedPerturbation(): Float32Array | null {
    return this.bedPerturb;
  }

  setInitialWater(depth: Float32Array): void {
    if (this.destroyed) return;
    if (!depth || depth.length !== this.N) {
      throw new Error(`setInitialWater: expected ${this.N} values, got ${depth?.length}`);
    }
    let vol = 0;
    for (let c = 0; c < this.N; c++) {
      const v = depth[c];
      const h = Number.isFinite(v) && v > 0 ? v : 0;
      this.initialDepth[c] = h;
      this.dryAtReset[c] = h < WET_DEPTH ? 1 : 0;
      vol += this.initialDepth[c];
    }
    this.initialVolume = vol * this.cellArea;
    this.resetTexValid = false;
    this.initialVersion++;
    // Obstacles leave cells wet in the initial water open; the reset below rebuilds the state bed with them.
    this.applyObstacles();
    // Porosity likewise (the initial depth is a true depth, so those cells are never porous).
    if (this.porosityInput) this.applyPorosity();
    this.uploadDryMask();
    this.reset();
  }

  getSnapshot(): SimSnapshot | null {
    return this.snapshot;
  }

  getGroundCPU(): Float32Array {
    return this.ground;
  }

  getBarrierCPU(): Float32Array {
    return this.barrier;
  }

  /**
   * The hazard accumulators as the export pass keeps them: nx·ny vec4f (max speed while wet, max h·|u|, first-wet time
   * or −1, wet seconds; src/sim/hazard.ts), STORAGE | COPY_SRC. Updated by exports, so it is current as of the latest
   * one: read stateTexture first (which exports if needed), as the renderer's prep pass does. Never replaced.
   */
  get hazardBuffer(): GPUBuffer {
    return this.hazardBuf;
  }

  /**
   * Read back the hazard accumulators (contracts.ts HazardFields) as of the latest step: exports first if the state has
   * moved on, then copies the accumulators and the exported state (for max depth, stateTexture.a) to MAP_READ buffers
   * in one command buffer — ~32 B/cell, so on demand only. Independent of the snapshot readbacks: its own staging
   * buffers, and the accounting buffer is not touched. Concurrent calls each get a consistent copy (one reusable
   * staging pair; a call that finds it busy maps a temporary pair). Rejects once the solver is destroyed.
   */
  async readHazardFields(): Promise<HazardFields> {
    if (this.destroyed) throw new Error('solver destroyed');
    const { device, nx, ny, N } = this;
    const bytes = N * HAZARD_PER_CELL * 4;
    let set = this.hazardStaging;
    let temporary = false;
    if (!set || set.busy) {
      const mk = (label: string) => device.createBuffer({ label, size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      const fresh: HazardStaging = { hazard: mk('sim.staging.hazard'), state: mk('sim.staging.hazardState'), busy: false };
      if (set) temporary = true;
      else this.hazardStaging = fresh;
      set = fresh;
    }
    set.busy = true;
    const enc = device.createCommandEncoder({ label: 'sim.hazardRead' });
    if (this.exportDirty) {
      this.writeSimUniform(this.lastDt);
      this.encodeExport(enc);
    }
    const simTime = this.hazardTime;
    enc.copyBufferToBuffer(this.hazardBuf, 0, set.hazard, 0, bytes);
    // nx is a multiple of 16, so a 16 B/texel row is a multiple of 256 B: no row padding to strip.
    enc.copyTextureToBuffer({ texture: this.exportTex[this.exportCur] }, { buffer: set.state, bytesPerRow: nx * 16 }, { width: nx, height: ny });
    device.queue.submit([enc.finish()]);
    const results = await Promise.allSettled([set.hazard.mapAsync(GPUMapMode.READ), set.state.mapAsync(GPUMapMode.READ)]);
    const release = () => {
      for (const b of [set.hazard, set.state]) if (b.mapState === 'mapped') b.unmap();
      set.busy = false;
      // Destroyed only once the map has settled (destroying a buffer mid-map crashes Dawn-for-Node; see destroy()).
      if (temporary || this.destroyed) {
        set.hazard.destroy();
        set.state.destroy();
      }
    };
    if (this.destroyed || results.some((r) => r.status === 'rejected')) {
      release();
      throw new Error(this.destroyed ? 'solver destroyed' : 'readHazardFields: mapping failed (device lost?)');
    }
    try {
      const fields = unpackHazardFields(
        new Float32Array(set.hazard.getMappedRange()),
        new Float32Array(set.state.getMappedRange()),
        nx,
        ny,
        simTime,
      );
      // Building obstacles: which cells water cannot enter (impact sampling then reads around them).
      if (this.obstacleCount > 0) {
        const blocked = new Uint8Array(N);
        for (let c = 0; c < N; c++) if (this.obstacle[c] > 0) blocked[c] = 1;
        fields.blocked = blocked;
        fields.ground = this.ground.slice();
      }
      return fields;
    } finally {
      release();
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of [...this.stateTex, ...this.exportTex, this.fluxTex, this.groundTex, this.barrierTexture, this.bedTexture, this.obstacleTex, this.surfaceTex, this.porosityTex]) {
      t.destroy();
    }
    for (const t of this.brushRes?.tex ?? []) t.destroy();
    this.raiseRes?.tex.destroy();
    this.raiseRes?.buf.destroy();
    this.resetTex?.destroy();
    for (const b of [this.accBuf, this.hazardBuf, this.simBuf, this.forcingBuf, this.brushBuf, this.depthBuf, this.blocksBuf, this.dryMaskBuf]) {
      b.destroy();
    }
    this.hazardSampleBuf?.destroy();
    // A hazard readback in flight destroys its staging pair itself once its map settles.
    if (this.hazardStaging && !this.hazardStaging.busy) {
      this.hazardStaging.hazard.destroy();
      this.hazardStaging.state.destroy();
    }
    this.hazardStaging = null;
    // Staging buffers with a readback in flight are destroyed by mapReadback once the map settles (destroying a
    // buffer mid-map rejects the promise: harmless in browsers, a crash in Dawn-for-Node).
    for (const s of this.staging) {
      if (s.busy) continue;
      s.depth.destroy();
      s.blocks.destroy();
    }
    this.budget.destroy();
    this.snapshot = null;
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Extras (not in the contract): used by tests, benchmarks and the dev harness
  // ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Current simulated time (s), updated synchronously as work is submitted. */
  get time(): number {
    return this.simTime;
  }

  /** Diagnostics from the latest readback. */
  get readbackDiagnostics(): ReadbackDiagnostics {
    return this.diagnostics;
  }

  /** Measured GPU cost per substep (ms, EMA) used by the adaptive substep budget. */
  get gpuMsPerSubstep(): number {
    return this.budget.msPerSubstep;
  }

  /** True if the budget measures with GPU timestamp queries (else queue-latency fallback). */
  get gpuBudgetUsesTimestamps(): boolean {
    return this.budget.usesTimestamps;
  }

  /**
   * GPU compute budget per frame, ms (default options.gpuBudgetMs = 8). A host may raise it while fast-forwarding
   * (automation) or lower it on battery; substeps per frame = budget / measured ms-per-substep. Infinity switches the
   * budget off: no GPU timing readbacks, substeps limited by params.maxSubstepsPerFrame alone.
   */
  get gpuBudgetMs(): number {
    return this.budget.budgetMs;
  }
  set gpuBudgetMs(ms: number) {
    if (ms > 0) this.budget.budgetMs = ms; // rejects NaN and ≤ 0; accepts Infinity
  }

  /**
   * The timestep the solver would use right now (s):
   *
   *     dt = Cr · dx / ( √2 · max over cells (√(g·h) + |u|) )
   *
   * WHY √2. Our scheme updates q from the old η, then η from the NEW q (a staggered forward–backward scheme).
   * A von Neumann analysis for gravity waves gives amplification factors λ with λ² − Tλ + s = 0, where
   * s = θ + (1−θ)·cos(k·dx) is the smoothing factor and T = 1 + s − 4·C₁²·(sin²(kx·dx/2) + sin²(ky·dx/2)),
   * C₁ = √(gh)·dt/dx. The worst mode is the 2-D checkerboard (kx = ky = π/dx): stability needs
   * 8·C₁² ≤ 2(1 + s) = 4θ, i.e. C₁ ≤ √(θ/2). Defining the 2-D Courant number Cr = √2·C₁ makes the limit
   * "Cr ≤ 1" for the plain scheme and "Cr ≤ √θ" with θ-smoothing — the numbers the UI shows.
   * (A 1-D formula, dt = C·dx/√(gh) with C = 0.7, sits right ON the 2-D limit: deep rivers then develop
   * checkerboard sloshing held back only by the velocity cap. tests/sim/stability.test.ts guards this.)
   *
   * The per-cell maximum comes from the latest asynchronous readback, i.e. it is up to a few hundred ms stale.
   * Robust mode inflates it by safety margins and by what we KNOW is coming (stage sources, water brush, bores
   * released by sources, rain running off dry ground) and clamps Cr to robustCflMax. Naive mode uses the raw depth, no speed term, and trusts the requested Cr.
   */
  computeDt(): number {
    const o = this.options;
    const p = this.params;
    const robust = p.stabilityMode !== 'naive';
    const cflIn = Number.isFinite(p.cfl) ? p.cfl : DEFAULT_SIM_PARAMS.cfl;
    const cfl = robust ? Math.min(o.robustCflMax, Math.max(0.05, cflIn)) : Math.max(0.05, cflIn);
    this.refreshForcing();
    let wave: number;
    if (robust) {
      // The maxima are stale (last readback, up to a few hundred ms old): inflate them. The readback's wave speed is
      // the largest √(g·h) + |u| of any single cell: the deepest water (a river channel, a stage disc) is rarely also
      // the fastest (a jet down a street), so adding the two separate maxima overstated the fastest wave by ~50 % in
      // Pittsburgh's 1936 flood (the HUD read Courant 0.46 against a target of 0.7) and cost as much sim speed.
      // What is known to be coming but cannot be in a readback yet (stage discs, a water brush, released bores) is
      // still combined the conservative way; any face the estimate misses is caught by the momentum pass's local
      // Courant guard.
      // A speed boost (flow about to start) is assumed to reach the deepest water.
      const hKnown =
        Math.max(this.hBoost, this.forcing.stageDepthMax, this.uBoost > 0 ? this.hRead : 0, this.rainDepthAhead(), 0.01) * o.cflDepthMargin;
      const known = Math.sqrt(GRAVITY * hKnown) + this.uBoost * o.cflSpeedMargin + 0.1;
      // Rain on dry ground: sheet flow speeds up long before a readback can show it (SolverOptions.rainRunoffSpeed).
      const rainMmHr = this.rainRateNow() / MMHR_TO_MS;
      const waveRead = rainMmHr > 0 ? Math.max(this.waveRead, o.rainRunoffSpeed * Math.pow(rainMmHr / 100, 0.4)) : this.waveRead;
      const read = Math.sqrt(GRAVITY * 0.01 * o.cflDepthMargin) + waveRead * o.cflSpeedMargin + 0.1;
      wave = Math.max(known, read);
    } else {
      // Naive mode uses the textbook local-inertial timestep (Bates et al. 2010), dt = C·dx/√(g·h_max): no flow
      // speed term and no margins, so the demo's C = 1.8 really applies to the gravity waves in every river.
      wave = Math.sqrt(GRAVITY * Math.max(this.hRead, this.hBoost, this.forcing.stageDepthMax, 0.01));
    }
    const dt = (cfl * this.cellSize) / (Math.SQRT2 * wave);
    return Math.min(o.dtMax, Math.max(o.dtMin, Number.isFinite(dt) ? dt : o.dtMin));
  }

  /** Heaviest rain falling anywhere right now (global rain + the most intense storm cell), m/s. */
  private rainRateNow(): number {
    const r = this.params.rainRate;
    return (Number.isFinite(r) ? Math.max(0, r) : 0) * MMHR_TO_MS + this.forcing.stormRateMax;
  }

  /**
   * Robust-mode CFL: the deepest water rain can make before a readback shows it, m (0 without rain). Rain collects in
   * hollows ~rainPondingFactor× faster than it falls, for as long as the readback lags: the simulated time since the
   * latest readback plus one more readback window (the span between the last two, or timeScale × readbackIntervalMs
   * before there were two). At 1200× that window is ~6 sim-minutes, and rain starting on a dry live area used to run
   * its first window at dtMax. Deep rivers already read back faster waves than this adds, so they are unaffected.
   */
  private rainDepthAhead(): number {
    const rain = this.rainRateNow();
    if (!(rain > 0)) return 0;
    const p = this.params;
    const scale = Number.isFinite(p.timeScale) ? Math.max(0, p.timeScale) : 0;
    const window = this.readSpan > 0 ? this.readSpan : (scale * this.options.readbackIntervalMs) / 1000;
    const lag = Math.min(RAIN_LAG_MAX_S, Math.max(0, this.simTime - this.readSimTime) + window);
    return this.hRead + this.options.rainPondingFactor * rain * lag;
  }

  /**
   * Encode and submit exactly `n` substeps of size `dt` (default: current CFL dt), bypassing timeScale and
   * the frame budget. Returns the dt used. Work is split into command buffers of ≤ 256 substeps.
   */
  runSubsteps(n: number, dt?: number): number {
    const d = dt ?? this.computeDt();
    let left = Math.floor(n);
    while (left > 0 && !this.destroyed) {
      const k = Math.min(left, 256);
      this.encodeFrame(k, d, false);
      left -= k;
    }
    return d;
  }

  /** Force a readback now and resolve with the resulting snapshot (waits for any in-flight readbacks). */
  async readbackNow(): Promise<SimSnapshot> {
    for (;;) {
      if (this.destroyed) throw new Error('solver destroyed');
      const enc = this.device.createCommandEncoder({ label: 'sim.readbackNow' });
      const map = this.maybeEncodeReadback(enc, true);
      if (map) {
        this.device.queue.submit([enc.finish()]);
        await map();
        if (this.snapshot) return this.snapshot;
      } else {
        await Promise.all([...this.pendingMaps]);
      }
    }
  }

  /** Test helper: wait for all submitted GPU work and pending readbacks. */
  async flush(): Promise<void> {
    await this.device.queue.onSubmittedWorkDone();
    await Promise.all([...this.pendingMaps]);
  }

  /** Test helper: read the internal state (h, qx, qy, z − z0) of the latest step. */
  async debugReadState(): Promise<{ h: Float32Array; qx: Float32Array; qy: Float32Array; z: Float32Array }> {
    const raw = await this.readTexture(this.stateTex[this.cur], 4);
    const { N } = this;
    const h = new Float32Array(N);
    const qx = new Float32Array(N);
    const qy = new Float32Array(N);
    const z = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      h[c] = raw[4 * c];
      qx[c] = raw[4 * c + 1];
      qy[c] = raw[4 * c + 2];
      z[c] = raw[4 * c + 3];
    }
    return { h, qx, qy, z };
  }

  /** Test helper: read any float texture of this solver (1 or 4 channels) into a Float32Array. */
  async readTexture(texture: GPUTexture, channels: 1 | 4): Promise<Float32Array> {
    const { nx, ny, device } = this;
    const bpp = 4 * channels;
    const bytesPerRow = Math.ceil((nx * bpp) / 256) * 256;
    const size = bytesPerRow * (ny - 1) + nx * bpp;
    const buf = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture }, { buffer: buf, bytesPerRow }, { width: nx, height: ny });
    device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Float32Array(buf.getMappedRange());
    const out = new Float32Array(nx * ny * channels);
    const stride = bytesPerRow / 4;
    for (let j = 0; j < ny; j++) out.set(src.subarray(j * stride, j * stride + nx * channels), j * nx * channels);
    buf.unmap();
    buf.destroy();
    return out;
  }

  /** Test helper: the internal ground texture (the contract only exposes bed and barrier). */
  get groundTexture(): GPUTexture {
    return this.groundTex;
  }

  // ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private encodeFrame(n: number, dt: number, fromStep: boolean): void {
    const { device } = this;
    this.gateTimedInflow(n * dt);
    // An export in this command buffer (a readback below) describes the state after the n substeps.
    this.writeSimUniform(dt, this.simTime + n * dt);
    const enc = device.createCommandEncoder({ label: 'sim.frame' });
    // Frames driven by step() are timed on the GPU to keep the substep budget current (see shouldProbe).
    const probe = fromStep && this.shouldProbe() ? this.budget.beginFrame(n) : null;
    if (probe) this.lastProbeMs = now();
    // Hazard samples inside the frame (SolverOptions.hazardSampleSeconds): export after these substep counts.
    const cuts = fromStep ? this.hazardCuts(n, dt) : [];
    if (cuts.length) this.writeHazardSampleUniforms(cuts, n, dt);
    const tw = probe?.timestampWrites;
    let done = 0;
    // Land-surface layers on: their pipeline variants (same bind groups); off: the plain passes, which never read them.
    const por = this.porosityOn ? 2 : 0;
    const momentumPipe = this.momentumPipes[(this.roughnessOn ? 1 : 0) + por];
    const continuityPipe = this.continuityPipes[(this.drainsOn ? 1 : 0) + por];
    for (let s = 0; s <= cuts.length; s++) {
      const end = s < cuts.length ? cuts[s] : n;
      // The GPU timing spans every segment: the first pass writes the start, the last one the end.
      const timestampWrites = tw && (s === 0 || s === cuts.length)
        ? { querySet: tw.querySet, ...(s === 0 ? { beginningOfPassWriteIndex: tw.beginningOfPassWriteIndex } : {}), ...(s === cuts.length ? { endOfPassWriteIndex: tw.endOfPassWriteIndex } : {}) }
        : undefined;
      const pass = enc.beginComputePass({ label: 'sim.substeps', timestampWrites });
      for (let k = done; k < end; k++) {
        pass.setPipeline(momentumPipe);
        pass.setBindGroup(0, this.bgMomentum[this.cur]);
        pass.dispatchWorkgroups(this.gx, this.gy);
        pass.setPipeline(continuityPipe);
        pass.setBindGroup(0, this.bgContinuity[this.cur]);
        pass.dispatchWorkgroups(this.gx, this.gy);
        this.cur = 1 - this.cur;
      }
      pass.end();
      done = end;
      if (!cuts.length) break;
      // Block s holds sample s's export time; block cuts.length is the frame's own uniform, put back after the last.
      enc.copyBufferToBuffer(this.hazardSampleBuf!, s * SIM_UNIFORM_BYTES, this.simBuf, 0, SIM_UNIFORM_BYTES);
      if (s < cuts.length) {
        this.encodeExportPass(enc);
        this.resetMaxPending = false;
        this.hazardTime = this.simTime + end * dt;
      }
    }
    probe?.resolve(enc);
    // The export follows lazily (stateTexture getter, or the readback below when one is due) — unless a sample at the
    // frame's last substep has just made it.
    this.exportDirty = !(cuts.length && cuts[cuts.length - 1] === n);
    this.stateVersionN++;

    this.simTime += n * dt;
    this.windowDtMax = Math.max(this.windowDtMax, dt);
    this.lastDt = dt;
    const map = fromStep ? this.maybeEncodeReadback(enc, false) : null;
    if (this.inflight === 0) this.inflightSince = now();
    this.inflight++;
    device.queue.submit([enc.finish()]);
    probe?.submitted();
    map?.();
    device.queue.onSubmittedWorkDone().then(
      () => {
        this.inflight = Math.max(0, this.inflight - 1);
        if (this.inflight > 0) this.inflightSince = now();
      },
      () => {
        this.inflight = Math.max(0, this.inflight - 1);
      },
    );
  }

  /** Encode the export pass. The caller must have written the Sim uniform for this command buffer. */
  private encodeExport(enc: GPUCommandEncoder): void {
    this.encodeExportPass(enc);
    // resetMax only applies to the first export after a reset; the uniform already carried it.
    this.resetMaxPending = false;
    this.exportDirty = false;
    this.hazardTime = this.hazardTimePending;
  }

  /** The export pass alone (the caller keeps resetMaxPending / exportDirty / hazardTime). */
  private encodeExportPass(enc: GPUCommandEncoder): void {
    const pass = enc.beginComputePass({ label: 'sim.export' });
    pass.setPipeline(this.exportPipes[this.porosityOn ? 1 : 0]);
    pass.setBindGroup(0, this.bgExport[this.cur][this.exportCur]);
    pass.dispatchWorkgroups(this.gx, this.gy);
    pass.end();
    this.exportCur = 1 - this.exportCur;
  }

  /**
   * Substep counts (ascending, each in 1 … n) after which a step() frame of n substeps of dt samples the hazard
   * accumulators, so that no stretch of more than SolverOptions.hazardSampleSeconds goes unsampled, counted from the
   * latest export — whether that was a sample, a render or a readback — not from the frame start: many short frames
   * between wall-clock exports (a throttled headless run) are sampled as densely as one long one. The first cut is
   * the first substep at or past that export + the span, then one every span; a cut at n exports at the frame's end.
   * At most MAX_HAZARD_SAMPLES (spread wider beyond that). Empty when sampling is off or no sample falls due.
   */
  private hazardCuts(n: number, dt: number): number[] {
    const span = this.options.hazardSampleSeconds;
    if (!(span > 0) || n < 1 || !(dt > 0)) return [];
    let k = Math.max(1, Math.floor(span / dt + 1e-9));
    const first = Math.max(1, Math.ceil((this.hazardTime + span - this.simTime) / dt - 1e-9));
    if (first > n) return [];
    if (Math.floor((n - first) / k) + 1 > MAX_HAZARD_SAMPLES) k = Math.max(1, Math.ceil((n - first + 1) / MAX_HAZARD_SAMPLES));
    const cuts: number[] = [];
    for (let m = first; m <= n && cuts.length < MAX_HAZARD_SAMPLES; m += k) cuts.push(m);
    return cuts;
  }

  /**
   * Fill hazardSampleBuf for encodeFrame: block s (s < cuts.length) is the Sim uniform as writeSimUniform just wrote it
   * for this frame, but describing an export after cuts[s] substeps (its time, the span since the previous export, and
   * resetMax only on the first); the last block is the frame's own uniform, with its span counted from the last sample.
   */
  private writeHazardSampleUniforms(cuts: readonly number[], n: number, dt: number): void {
    const B = SIM_UNIFORM_BYTES;
    const size = B * (MAX_HAZARD_SAMPLES + 1);
    this.hazardSampleBuf ??= this.device.createBuffer({ label: 'sim.hazardSamples', size, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const blocks = new ArrayBuffer(B * (cuts.length + 1));
    const bytes = new Uint8Array(blocks);
    const src = new Uint8Array(this.simBytes);
    let prev = this.hazardTime;
    let reset = this.resetMaxPending;
    for (let s = 0; s <= cuts.length; s++) {
      bytes.set(src, s * B);
      const t = this.simTime + (s < cuts.length ? cuts[s] : n) * dt;
      new Int32Array(blocks, s * B, B / 4)[20] = reset ? 1 : 0;
      const f = new Float32Array(blocks, s * B, B / 4);
      f[26] = t;
      f[27] = Math.max(0, t - prev);
      prev = t;
      reset = false;
    }
    this.device.queue.writeBuffer(this.hazardSampleBuf, 0, blocks);
  }

  private userSubstepCap(): number {
    return Math.max(1, Math.floor(Number.isFinite(this.params.maxSubstepsPerFrame) ? this.params.maxSubstepsPerFrame : 1));
  }

  /**
   * This frame's share of a fractional maxSubstepsPerFrame (a host pacing the solver, e.g. the app's work budget,
   * may ask for 4.5): whole substeps, plus one extra on the frames where the carried fraction reaches 1, so the
   * average is exact. GPU throughput on a saturated queue has a cliff between whole numbers (at 60 fps on the M4 in
   * Pittsburgh's crest flood: 4 substeps ~15 ms latency, 5 ~30 ms, 6 ~40 ms with dropped frames).
   */
  private ditheredSubstepCap(): number {
    const m = Number.isFinite(this.params.maxSubstepsPerFrame) ? this.params.maxSubstepsPerFrame : 1;
    const whole = Math.max(1, Math.floor(m));
    const frac = m >= 1 ? m - Math.floor(m) : 0;
    if (!(frac > 0)) {
      this.capCarry = 0;
      return whole;
    }
    this.capCarry += frac;
    if (this.capCarry >= 1 - 1e-9) {
      this.capCarry -= 1;
      return whole + 1;
    }
    return whole;
  }

  /**
   * Whether this frame should carry GPU timestamp queries for the budget: never when the budget is off (Infinity);
   * every frame while the budget can limit the substeps (or has too few samples); otherwise every PROBE_IDLE_MS, so
   * the estimate still follows thermal throttling without a GPU→CPU readback on every frame.
   */
  private shouldProbe(): boolean {
    if (!Number.isFinite(this.budget.budgetMs)) return false;
    if (this.budget.samples < 5 || this.budget.cap() < 2 * this.userSubstepCap()) return true;
    return now() - this.lastProbeMs >= PROBE_IDLE_MS;
  }

  /** Substeps allowed this frame: user cap ∩ measured GPU budget; 0 if the GPU queue is backed up. */
  private substepCap(): number {
    const userCap = this.ditheredSubstepCap();
    const budget = this.budget.cap();
    if (this.inflight >= 3) {
      // Several frames of solver work still queued on the GPU: skip a frame so latency cannot build up.
      // (Self-heal if a completion callback was somehow lost.)
      if (now() - this.inflightSince < 2000) return 0;
      this.inflight = 0;
    }
    return Math.min(userCap, budget);
  }

  /**
   * Write the Sim uniform for the command buffer about to be encoded. `exportTime` is the simulated time an export
   * encoded under it describes (the end of the frame's substeps for encodeFrame, the current time everywhere else);
   * the hazard accumulators integrate over exportTime − the previous export's time (shaders/exportState.ts).
   */
  private writeSimUniform(dt: number, exportTime = this.simTime): void {
    const p = this.params;
    const o = this.options;
    const robust = p.stabilityMode !== 'naive';
    this.refreshForcing();
    const n = Math.max(0, Number.isFinite(p.manningN) ? p.manningN : DEFAULT_SIM_PARAMS.manningN);
    const iv = this.simI32;
    const fv = this.simF32;
    iv[0] = this.nx;
    iv[1] = this.ny;
    fv[2] = dt;
    fv[3] = this.cellSize;
    fv[4] = GRAVITY;
    fv[5] = n * n;
    fv[6] = robust ? o.theta : 1;
    fv[7] = o.hMin;
    fv[8] = this.uMaxNow;
    fv[9] = o.froudeMax;
    fv[10] = Math.max(0, Number.isFinite(p.rainRate) ? p.rainRate : 0) * MMHR_TO_MS;
    fv[11] = Math.max(0, Number.isFinite(p.infiltrationRate) ? p.infiltrationRate : 0) * MMHR_TO_MS;
    iv[12] = robust ? 1 : 0;
    iv[13] = p.boundary === 'wall' ? 0 : 1;
    iv[14] = this.forcing.nSources;
    iv[15] = this.forcing.nStorms;
    fv[16] = o.stageRelaxSeconds > 0 ? 1 - Math.exp(-dt / o.stageRelaxSeconds) : 1;
    fv[17] = 1 / Math.max(n, 0.01);
    fv[18] = o.boundaryMinSlope;
    iv[19] = o.advection ? 1 : 0;
    iv[20] = this.resetMaxPending ? 1 : 0;
    fv[21] = VELOCITY_DEPTH;
    // Local Courant guard threshold (momentum pass) = the robust Courant ceiling; see shaders/momentum.ts.
    fv[22] = o.robustCflMax;
    fv[23] = o.smoothingDepthRatio;
    fv[24] = o.boundaryFroudeMax;
    fv[25] = Math.min(1, Math.max(0, o.wallAdvection));
    fv[26] = exportTime;
    fv[27] = Math.max(0, exportTime - this.hazardTime);
    this.hazardTimePending = exportTime;
    // Rheology (src/sim/rheology.ts): the quadratic law's dispersive n_td follows the current Manning n.
    const rc = rheologyCoefficients(this.rheologyNow, n);
    iv[28] = rc.kind;
    fv[29] = rc.tauRho;
    fv[30] = rc.mu;
    fv[31] = rc.visc;
    fv[32] = rc.n2;
    fv[33] = rc.gXi;
    fv[34] = RHEO_VISC_DEPTH;
    fv[35] = 0;
    // Storm drains (setLandSurface): the capacity multiplier. Which land-surface layers run is a choice of pipeline
    // (encodeFrame), not a uniform: with a layer off its code is not compiled.
    const ds = p.drainageScale;
    fv[36] = typeof ds === 'number' && Number.isFinite(ds) ? Math.max(0, ds) : 1;
    fv[37] = 0;
    fv[38] = 0;
    fv[39] = 0;
    this.device.queue.writeBuffer(this.simBuf, 0, this.simBytes);
  }

  private refreshForcing(): void {
    if (!this.forcingDirty) return;
    this.forcingDirty = false;
    this.forcing = this.packForcingNow();
    this.device.queue.writeBuffer(this.forcingBuf, 0, this.forcing.data);
    if (this.sourcesChanged) {
      this.sourcesChanged = false;
      const u = this.forcingSpeedEstimate();
      if (u > this.uRead) {
        this.uBoost = Math.max(this.uBoost, u);
        this.uBoostTime = this.simTime;
      }
    }
    if (this.forcing.dropped > 0 && !this.warnedDropped) {
      this.warnedDropped = true;
      console.warn(`[sim] only ${MAX_SOURCES} sources and ${MAX_STORMS} storm cells are supported; extras ignored`);
    }
  }

  /**
   * Flow speed the current sources are about to produce, for the CFL estimate until a readback shows it (m/s, ≤ uMax).
   * The timestep otherwise comes from the latest readback, which after a reset or a source change still shows the
   * calm state: Johnstown's 1936 inflows reached 5–6 m/s within the first window and the HUD read Courant 1.3–1.4.
   *  • inflow: water spills out of the footprint across its rim, perimeter P = 2π·(R + ½)·dx, at critical flow for
   *    q = Q/P, u_c = (g·q)^{1/3}; a jet running off downhill reaches about twice that → 2·u_c.
   *  • stage: raising the level by Δh above the current water surface releases a dam break, front speed 2·√(g·Δh).
   *    Δh from the latest snapshot's depth (the initial water right after a reset).
   */
  private forcingSpeedEstimate(): number {
    const { ground, barrier, obstacle } = this;
    const depth = this.snapshot?.depth ?? this.initialDepth;
    let u = 0;
    for (const s of this.sources.slice(0, MAX_SOURCES)) {
      const R = footprintRadius(s.radius);
      if (s.type === 'inflow') {
        u = Math.max(u, this.inflowSpeed(s, R, this.simTime));
        continue;
      }
      if (!Number.isFinite(s.level)) continue;
      const cells = this.footprintOf(s).cells;
      let dh = 0;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        dh = Math.max(dh, s.level - (ground[c] + barrier[c] + obstacle[c] + depth[c]));
      }
      if (dh > 0) u = Math.max(u, 2 * Math.sqrt(GRAVITY * dh));
    }
    return Math.min(u, this.uMaxNow);
  }

  /**
   * Spill speed of one inflow (see forcingSpeedEstimate) at the largest discharge it reaches from `from` to
   * HYDROGRAPH_LOOKAHEAD_S later. A timed inflow that has already stopped is not about to produce anything, so it
   * must not hold the timestep down for the rest of the run; a rising hydrograph is judged by the flow it is about
   * to reach, not the trickle it starts from.
   */
  private inflowSpeed(s: WaterSource & { type: 'inflow' }, R: number, from: number): number {
    const Q = peakInflow(s, from, from + HYDROGRAPH_LOOKAHEAD_S);
    return Q > 0 ? 2 * Math.cbrt((GRAVITY * Q) / (2 * Math.PI * (R + 0.5) * this.cellSize)) : 0;
  }

  /**
   * Point the packed forcing at the window this frame is about to cover, so a timed inflow (WaterSource.stopAfter)
   * delivers exactly Q·stopAfter and then nothing, and a hydrograph delivers exactly ∫Q dt.
   *
   * Called from encodeFrame only — the writeSimUniform(0) that keeps stateTexture current after a brush or a reset
   * steps no time and must not move the window. Re-packing stops once the window already packed starts after the
   * stop: by then the buffer holds a zero discharge and nothing further changes it.
   */
  private gateTimedInflow(span: number): void {
    if (this.inflowStopAt <= 0) return;
    const packed = this.forcingWindow;
    if (packed && packed.from >= this.inflowStopAt) return;
    this.forcingWindow = { from: this.simTime, to: this.simTime + Math.max(0, span) };
    this.forcingDirty = true;
    // A rising hydrograph releases faster flow than any readback has seen yet: boost the CFL estimate ahead of it,
    // as a source change does. Constant and merely stopping inflows never raise this above what they started with.
    let u = 0;
    for (const s of this.sources.slice(0, MAX_SOURCES)) {
      if (s.type === 'inflow' && s.hydrograph) u = Math.max(u, this.inflowSpeed(s, footprintRadius(s.radius), this.simTime));
    }
    u = Math.min(u, this.uMaxNow);
    if (u > this.uRead && u > this.uBoost) {
      this.uBoost = u;
      this.uBoostTime = this.simTime;
    }
  }

  private packForcingNow(): PackedForcing {
    const { ground, barrier, obstacle } = this;
    return packForcing(
      this.sources,
      this.storms,
      this.nx,
      this.ny,
      this.cellSize,
      this.z0,
      (c) => ground[c] + barrier[c] + obstacle[c],
      this.footprintOf,
      this.forcingWindow ?? undefined,
    );
  }

  /** Whether a grid rectangle overlaps any stage source's footprint (the only part of the forcing that reads the bed). */
  private rectTouchesStage(rect: { x0: number; y0: number; w: number; h: number }): boolean {
    for (const s of this.sources) {
      if (s.type !== 'stage') continue;
      const R = footprintRadius(s.radius) + 1;
      if (rect.x0 <= s.gx + R && rect.x0 + rect.w >= s.gx - R && rect.y0 <= s.gy + R && rect.y0 + rect.h >= s.gy - R) return true;
    }
    return false;
  }

  /** Keep reset()'s GPU copy of the initial state current over a brushed rectangle (its bed changed). */
  private patchResetState(rect: { x0: number; y0: number; w: number; h: number }): void {
    if (!this.resetTexValid || !this.resetTex) return;
    const { nx, z0, initialDepth } = this;
    const data = new Float32Array(rect.w * rect.h * 4);
    for (let j = 0; j < rect.h; j++) {
      for (let i = 0; i < rect.w; i++) {
        const c = (rect.y0 + j) * nx + rect.x0 + i;
        const o = 4 * (j * rect.w + i);
        data[o] = initialDepth[c];
        data[o + 3] = this.stateBed(c) - z0;
      }
    }
    this.device.queue.writeTexture(
      { texture: this.resetTex, origin: { x: rect.x0, y: rect.y0 } },
      data,
      { bytesPerRow: rect.w * 16 },
      { width: rect.w, height: rect.h },
    );
  }

  /** A source's footprint cells and weights (cached: sources keep their place while the stage ramp moves their level). */
  private footprintOf = (s: WaterSource): Footprint => {
    const key = `${s.gx}|${s.gy}|${s.radius}`;
    let fp = this.footprintCache.get(key);
    if (!fp) {
      if (this.footprintCache.size >= 64) this.footprintCache.clear();
      fp = sourceFootprint(s.gx, s.gy, s.radius, this.nx, this.ny);
      this.footprintCache.set(key, fp);
    }
    return fp;
  };

  /**
   * Grid rectangle (x1, y1 exclusive) holding every cell a wall brush has raised since the last terrain reset, or null
   * when none has: whole-grid wall scans (the UI's wall checks) only need to look inside it. Erasing does not shrink it.
   */
  get wallBounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    return this.wallRect ? { ...this.wallRect } : null;
  }

  /**
   * Bed elevation of cell c as the state texture holds it (before the datum shift): ground + barrier + obstacle in
   * Float32, added in the order the brush pass adds them, so a reset and a brushed rectangle agree to the bit. Without
   * obstacles this is fround(ground + barrier), as it always was.
   */
  private stateBed(c: number): number {
    return Math.fround(Math.fround(this.ground[c] + this.barrier[c]) + this.obstacle[c]);
  }

  /**
   * Land-surface layers (FloodSolver.setLandSurface; contracts.ts LandSurface): building obstacles, the land-cover
   * roughness map, storm drains and building porosity. A key left out keeps that layer; null switches it off.
   *  • obstacles become part of the state bed at once, without a reset: a rebed pass (shaders/brush.ts kind 4) rebuilds
   *    z over the whole grid and keeps h, so water standing in a footprint is lifted onto the roof and spills off —
   *    mass is untouched. Cells wet in the initial water are never blocked (a footprint mapped over a river or a dock
   *    must not dam it); bedTexture and the CPU ground / barrier mirrors are unchanged (the renderer draws buildings).
   *  • roughness (absolute n at the default global n) and drain capacity (mm/hr) are uploaded to the surface texture;
   *    switching either on or off picks the pipeline variants that read it.
   *  • porosity (src/data/porosity.ts) is uploaded to the porosity texture, and the POROSITY variants then read the
   *    state's h as volume per unit cell area (shaders/common.ts POROSITY_WGSL). The state is kept as it is: switched
   *    on or off mid-flood, the water volume is unchanged and its depth becomes V/φ (or V) at once. Applied as given
   *    except: φ clamped to [POROSITY_MIN, 1] and 1 on blocked cells, cells with initial water and the edge band
   *    (POROSITY_EDGE_BAND); ψ clamped to [0, min(φ of its two cells)], 1 on faces touching the edge band.
   */
  setLandSurface(layers: LandSurface): void {
    if (this.destroyed || !layers) return;
    const { N } = this;
    const check = (a: Float32Array | null | undefined, name: string) => {
      if (a && a.length !== N) throw new Error(`setLandSurface: ${name} must have ${N} values, got ${a.length}`);
    };
    check(layers.obstacles, 'obstacles');
    check(layers.roughness, 'roughness');
    check(layers.drainCapacity, 'drainCapacity');
    const por = layers.porosity;
    if (por) for (const k of ['cell', 'faceE', 'faceS', 'roof', 'spout'] as const) check(por[k], `porosity.${k}`);
    if (layers.roughness !== undefined || layers.drainCapacity !== undefined || por !== undefined) {
      if (layers.roughness !== undefined) this.roughnessOn = !!layers.roughness;
      if (layers.drainCapacity !== undefined) this.drainsOn = !!layers.drainCapacity;
      this.writeSurface(layers.roughness, layers.drainCapacity, por === undefined ? undefined : (por?.spout ?? null));
    }
    if (layers.obstacles !== undefined) {
      this.obstacleInput = layers.obstacles ? layers.obstacles.slice() : null;
      if (this.applyObstacles()) this.rebed();
    }
    if (por !== undefined) {
      this.porosityInput = por
        ? { cell: por.cell.slice(), faceE: por.faceE.slice(), faceS: por.faceS.slice(), roof: por.roof.slice(), spout: por.spout.slice() }
        : null;
      this.applyPorosity();
    } else if (layers.obstacles !== undefined && this.porosityInput) {
      this.applyPorosity();
    }
  }

  /** The obstacle heights in force (0 = open), or null when no cell is blocked. Owned by the solver: do not mutate. */
  getObstacleCPU(): Float32Array | null {
    return this.obstacleCount > 0 ? this.obstacle : null;
  }

  /**
   * r32float, nx×ny: the building obstacles in force, m above the ground (0 = open; all 0 when off). The renderer's prep
   * pass reads it to show no water in a blocked footprint. Created with the solver and never replaced.
   */
  get obstacleTexture(): GPUTexture {
    return this.obstacleTex;
  }

  /** Which land-surface layers are switched on, how many cells the obstacles block and how many are porous. */
  get landSurfaceState(): { obstacles: number; roughness: boolean; drains: boolean; porous: number } {
    return { obstacles: this.obstacleCount, roughness: this.roughnessOn, drains: this.drainsOn, porous: this.porosityOn ? this.porousCells : 0 };
  }

  /**
   * Re-upload the surface texture's channels that changed (undefined = keep; null = neutral: factor 1, no drain, no
   * downspouts). A change to one channel rewrites the texture from the CPU copy kept here.
   */
  private surfaceCPU: Float32Array | null = null;
  private writeSurface(
    roughness: Float32Array | null | undefined,
    drain: Float32Array | null | undefined,
    spout: Float32Array | null | undefined,
  ): void {
    const { N, nx, ny } = this;
    let s = this.surfaceCPU;
    if (!s) {
      s = new Float32Array(4 * N);
      for (let c = 0; c < N; c++) s[4 * c] = 1;
      this.surfaceCPU = s;
    }
    const nRef = DEFAULT_SIM_PARAMS.manningN;
    if (roughness !== undefined) {
      for (let c = 0; c < N; c++) {
        const n = roughness ? roughness[c] : nRef;
        // A cell with no valid n keeps the global value (factor 1).
        s[4 * c] = Number.isFinite(n) && n > 0 ? n / nRef : 1;
      }
    }
    if (drain !== undefined) {
      for (let c = 0; c < N; c++) {
        const v = drain ? drain[c] : 0;
        s[4 * c + 1] = Number.isFinite(v) && v > 0 ? v * MMHR_TO_MS : 0;
      }
    }
    if (spout !== undefined) {
      for (let c = 0; c < N; c++) {
        const v = spout ? spout[c] : 0;
        s[4 * c + 2] = Number.isFinite(v) && v > 0 ? v : 0;
      }
    }
    this.device.queue.writeTexture({ texture: this.surfaceTex }, s, { bytesPerRow: nx * 16 }, { width: nx, height: ny });
  }

  /**
   * Recompute the applied porosities from the given ones, the obstacles and the initial water (see setLandSurface) and
   * upload them. Switches the POROSITY pipeline variants on or off.
   */
  private applyPorosity(): void {
    const { N, nx, ny, initialDepth, obstacle } = this;
    const inp = this.porosityInput;
    const out = new Float32Array(4 * N);
    let porous = 0;
    const B = POROSITY_EDGE_BAND;
    const band = (i: number, j: number) => i < B || j < B || i >= nx - B || j >= ny - B;
    const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1);
    const phi = new Float32Array(N).fill(1);
    if (inp) {
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const c = j * nx + i;
          if (obstacle[c] > 0 || initialDepth[c] > 0 || band(i, j)) continue;
          const v = inp.cell[c];
          phi[c] = Number.isFinite(v) ? Math.min(1, Math.max(POROSITY_MIN, v)) : 1;
          if (phi[c] < 1) porous++;
        }
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        out[4 * c] = phi[c];
        let pe = 1;
        let ps = 1;
        if (inp) {
          if (i < nx - 1 && !band(i, j) && !band(i + 1, j)) pe = Math.min(clamp01(inp.faceE[c]), phi[c], phi[c + 1]);
          if (j < ny - 1 && !band(i, j) && !band(i, j + 1)) ps = Math.min(clamp01(inp.faceS[c]), phi[c], phi[c + nx]);
        }
        out[4 * c + 1] = pe;
        out[4 * c + 2] = ps;
        out[4 * c + 3] = inp && initialDepth[c] <= 0 ? clamp01(inp.roof[c]) : 0;
      }
    }
    this.porosityOn = !!inp;
    this.porousCells = porous;
    this.device.queue.writeTexture({ texture: this.porosityTex }, out, { bytesPerRow: nx * 16 }, { width: nx, height: ny });
    // The exported depth of a porous cell is V/φ: refresh the export.
    this.exportDirty = true;
    this.stateVersionN++;
  }

  /**
   * Recompute the applied obstacles from the given heights and the initial water; upload them when they changed.
   * Returns true if they changed (the state bed then needs rebuilding: rebed, or the next reset's state rebuild).
   */
  private applyObstacles(): boolean {
    const { N, obstacle, obstacleInput: inp, initialDepth } = this;
    let changed = false;
    let count = 0;
    for (let c = 0; c < N; c++) {
      const v = inp ? inp[c] : 0;
      const o = Number.isFinite(v) && v > 0 && initialDepth[c] < WET_DEPTH ? Math.fround(v) : 0;
      if (o !== obstacle[c]) {
        obstacle[c] = o;
        changed = true;
      }
      if (o > 0) count++;
    }
    this.obstacleCount = count;
    if (!changed) return false;
    const { nx, ny } = this;
    this.device.queue.writeTexture({ texture: this.obstacleTex }, obstacle, { bytesPerRow: nx * 4 }, { width: nx, height: ny });
    this.resetTexValid = false;
    // The stage discs' depth bound reads the bed (packForcing).
    this.forcingDirty = true;
    return true;
  }

  /** Rebuild the state bed over the whole grid in place (brush kind 4), keeping water and discharge. */
  private rebed(): void {
    const res = this.ensureBrushResources();
    const { device, nx, ny } = this;
    device.queue.writeBuffer(this.brushBuf, 0, packRebedUniform(nx, ny, this.z0));
    const enc = device.createCommandEncoder({ label: 'sim.rebed' });
    const pass = enc.beginComputePass({ label: 'sim.rebed' });
    pass.setPipeline(this.brushPipe);
    pass.setBindGroup(0, res.bg[this.cur]);
    pass.dispatchWorkgroups(Math.ceil(nx / WG), Math.ceil(ny / WG));
    pass.end();
    const size = { width: nx, height: ny };
    enc.copyTextureToTexture({ texture: res.tex[0] }, { texture: this.stateTex[this.cur] }, size);
    this.writeSimUniform(0);
    this.encodeExport(enc);
    this.stateVersionN++;
    this.editSeq++;
    device.queue.submit([enc.finish()]);
  }

  private uploadTerrain(): void {
    const { nx, ny, device } = this;
    this.terrainVersionN++;
    this.resetTexValid = false;
    const bed = new Float32Array(this.N);
    for (let c = 0; c < this.N; c++) bed[c] = this.ground[c] + this.barrier[c];
    const layout = { bytesPerRow: nx * 4 };
    const size = { width: nx, height: ny };
    device.queue.writeTexture({ texture: this.groundTex }, this.ground, layout, size);
    device.queue.writeTexture({ texture: this.barrierTexture }, this.barrier, layout, size);
    device.queue.writeTexture({ texture: this.bedTexture }, bed, layout, size);
  }

  private ensureRaiseResources(base: Float32Array): NonNullable<GpuFloodSolver['raiseRes']> {
    if (this.raiseRes?.base === base) return this.raiseRes;
    const { device, nx, ny, N } = this;
    let res = this.raiseRes;
    if (!res) {
      const tex = device.createTexture({
        label: 'sim.raise.base',
        size: { width: nx, height: ny },
        format: 'r32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      });
      const buf = device.createBuffer({ label: 'sim.raise', size: RAISE_UNIFORM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      const bg = [0, 1].map((p) =>
        device.createBindGroup({
          label: `sim.raise${p}`,
          layout: this.raiseLayout,
          entries: [
            { binding: 0, resource: { buffer: buf } },
            { binding: 1, resource: this.stateTex[p].createView() },
            { binding: 2, resource: tex.createView() },
            { binding: 3, resource: this.stateTex[1 - p].createView() },
            { binding: 4, resource: { buffer: this.accBuf } },
          ],
        }),
      );
      res = { base, tex, buf, bg, cells: new Int32Array(0), levels: new Float32Array(0), rise: { depth: null, terrain: -1, initial: -1, overBed: 0, overWater: 0 } };
    }
    const rel = new Float32Array(N);
    let count = 0;
    for (let c = 0; c < N; c++) {
      const v = base[c];
      if (Number.isFinite(v)) {
        rel[c] = v - this.z0;
        count++;
      } else {
        rel[c] = -1e30;
      }
    }
    const cells = new Int32Array(count);
    const levels = new Float32Array(count);
    for (let c = 0, k = 0; c < N; c++) {
      const v = base[c];
      if (!Number.isFinite(v)) continue;
      cells[k] = c;
      levels[k++] = v;
    }
    device.queue.writeTexture({ texture: res.tex }, rel, { bytesPerRow: nx * 4 }, { width: nx, height: ny });
    this.raiseRes = { ...res, base, cells, levels, rise: { depth: null, terrain: -1, initial: -1, overBed: 0, overWater: 0 } };
    return this.raiseRes;
  }

  private ensureBrushResources(): { tex: GPUTexture[]; bg: GPUBindGroup[] } {
    if (this.brushRes) return this.brushRes;
    const { device, nx, ny } = this;
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC;
    const mk = (label: string, format: GPUTextureFormat) => device.createTexture({ label, size: { width: nx, height: ny }, format, usage });
    const tex = [
      mk('sim.brush.state', 'rgba32float'),
      mk('sim.brush.ground', 'r32float'),
      mk('sim.brush.barrier', 'r32float'),
      mk('sim.brush.bed', 'r32float'),
    ];
    const bg = [0, 1].map((p) =>
      device.createBindGroup({
        label: `sim.brush${p}`,
        layout: this.brushLayout,
        entries: [
          { binding: 0, resource: { buffer: this.brushBuf } },
          { binding: 1, resource: this.stateTex[p].createView() },
          { binding: 2, resource: this.groundTex.createView() },
          { binding: 3, resource: this.barrierTexture.createView() },
          { binding: 4, resource: tex[0].createView() },
          { binding: 5, resource: tex[1].createView() },
          { binding: 6, resource: tex[2].createView() },
          { binding: 7, resource: tex[3].createView() },
          { binding: 8, resource: { buffer: this.accBuf } },
          { binding: 9, resource: this.obstacleTex.createView() },
        ],
      }),
    );
    this.brushRes = { tex, bg };
    return this.brushRes;
  }

  /**
   * If a readback is due (or forced) and a staging set is free, encode — all in `enc`, after the frame's export
   * pass: the reduction pass (depth + per-block stats incl. the accounting sums), ZERO the accounting buffer,
   * copy both results to the staging buffers. Because the zeroing is in the same command buffer as the reduction,
   * no substep's in/out volume is ever lost or counted twice. Returns a function to call right AFTER
   * queue.submit (mapAsync must follow the submit).
   */
  private maybeEncodeReadback(enc: GPUCommandEncoder, force: boolean): (() => Promise<void>) | null {
    const t = now();
    if (!force && t - this.lastReadbackMs < this.options.readbackIntervalMs) return null;
    let set = this.staging.find((s) => !s.busy);
    if (!set && this.staging.length < 2) {
      const B = GPUBufferUsage;
      set = {
        depth: this.device.createBuffer({ label: 'sim.staging.depth', size: this.N * 4, usage: B.MAP_READ | B.COPY_DST }),
        blocks: this.device.createBuffer({
          label: 'sim.staging.blocks',
          size: this.nBlocks * STATS_PER_BLOCK * 4,
          usage: B.MAP_READ | B.COPY_DST,
        }),
        busy: false,
      };
      this.staging.push(set);
    }
    if (!set) return null;
    const staging = set;
    staging.busy = true;
    this.lastReadbackMs = t;
    this.readbackVersion = this.stateVersionN;
    // The reduction reads the exported state: it must include every substep booked in the accounting buffer
    // (zeroed below), or volume and in/out volumes would come from different moments.
    if (this.exportDirty) this.encodeExport(enc);
    const pass = enc.beginComputePass({ label: 'sim.stats' });
    pass.setPipeline(this.statsPipe);
    // exportCur was flipped after the last export: the latest exported texture is exportTex[exportCur].
    pass.setBindGroup(0, this.bgStats[this.cur][this.exportCur]);
    pass.dispatchWorkgroups(Math.ceil(this.nx / 16 / WG), Math.ceil(this.ny / 16 / WG));
    pass.end();
    enc.clearBuffer(this.accBuf);
    enc.copyBufferToBuffer(this.depthBuf, 0, staging.depth, 0, this.N * 4);
    enc.copyBufferToBuffer(this.blocksBuf, 0, staging.blocks, 0, this.nBlocks * STATS_PER_BLOCK * 4);
    const meta: ReadbackMeta = {
      gen: this.generation,
      simTime: this.simTime,
      dtMax: this.windowDtMax > 0 ? this.windowDtMax : this.lastDt,
      seq: this.editSeq,
    };
    this.windowDtMax = 0;
    return () => {
      const p = this.mapReadback(staging, meta);
      this.pendingMaps.add(p);
      void p.finally(() => this.pendingMaps.delete(p));
      return p;
    };
  }

  private async mapReadback(set: StagingSet, meta: ReadbackMeta): Promise<void> {
    const maps = [set.depth.mapAsync(GPUMapMode.READ), set.blocks.mapAsync(GPUMapMode.READ)];
    const results = await Promise.allSettled(maps);
    if (this.destroyed) {
      for (const b of [set.depth, set.blocks]) {
        if (b.mapState === 'mapped') b.unmap();
        b.destroy();
      }
      return;
    }
    if (results.some((r) => r.status === 'rejected')) {
      // Device lost while mapping.
      for (const b of [set.depth, set.blocks]) if (b.mapState === 'mapped') b.unmap();
      set.busy = false;
      return;
    }
    try {
      if (meta.gen === this.generation) {
        this.processReadback(set.depth.getMappedRange(), new Float32Array(set.blocks.getMappedRange()), meta);
      }
    } finally {
      set.depth.unmap();
      set.blocks.unmap();
      set.busy = false;
    }
  }

  /** Turn a mapped readback into SimStats + SimSnapshot: one memcpy + a Float64 loop over N/256 blocks. */
  private processReadback(depthRange: ArrayBuffer, b: Float32Array, meta: ReadbackMeta): void {
    const t0 = now();
    // The mapped range is detached on unmap: the snapshot owns a copy.
    const depth = new Float32Array(depthRange.slice(0, this.N * 4));
    let accIn = 0;
    let accOut = 0;
    let vol = 0;
    let maxH = 0;
    let minH = 0;
    let maxSp2Wet = 0;
    let maxSp2 = 0;
    let maxWave = 0;
    let wet = 0;
    let flooded = 0;
    let nonFinite = 0;
    for (let o = 0; o < b.length; o += STATS_PER_BLOCK) {
      accIn += b[o + STAT.accIn] + b[o + STAT.accInLo];
      accOut += b[o + STAT.accOut] + b[o + STAT.accOutLo];
      vol += b[o + STAT.volume] + b[o + STAT.volumeLo];
      if (b[o + STAT.maxDepth] > maxH) maxH = b[o + STAT.maxDepth];
      if (b[o + STAT.minDepth] < minH) minH = b[o + STAT.minDepth];
      if (b[o + STAT.maxSpeed2Wet] > maxSp2Wet) maxSp2Wet = b[o + STAT.maxSpeed2Wet];
      if (b[o + STAT.maxSpeed2] > maxSp2) maxSp2 = b[o + STAT.maxSpeed2];
      if (b[o + STAT.maxWave] > maxWave) maxWave = b[o + STAT.maxWave];
      wet += b[o + STAT.wetCells];
      flooded += b[o + STAT.floodedCells];
      nonFinite += b[o + STAT.nonFiniteCells];
    }
    const area = this.cellArea;
    this.volumeIn += accIn * area;
    this.volumeOut += accOut * area;
    const volume = vol * area;
    const expected = this.initialVolume + this.volumeIn - this.volumeOut;
    if (Number.isFinite(volume)) this.peakVolume = Math.max(this.peakVolume, volume);
    const blownUp = nonFinite > 0;
    const stats: SimStats = {
      simTime: meta.simTime,
      maxDepth: blownUp ? Infinity : maxH,
      maxSpeed: blownUp ? Infinity : Math.sqrt(maxSp2Wet),
      volume,
      wetArea: wet * area,
      floodedArea: flooded * area,
      volumeIn: this.volumeIn,
      volumeOut: this.volumeOut,
      // Normalized by the most water the scene has held, not by initial + inflow volume: inflow keeps growing
      // (Pittsburgh's stage discs exchange ~10,000 m³/s with the open edge while the rivers stand still), which
      // made the percentage shrink the longer the sim ran whatever the solver did. The peak never shrinks, so a
      // scene draining toward empty cannot inflate the ratio either.
      massError: Math.abs(volume - expected) / Math.max(1, this.initialVolume, this.peakVolume),
      // 2-D Courant number (see computeDt): stable below 1 (below √θ ≈ 0.89 with smoothing).
      courant: blownUp ? Infinity : (Math.SQRT2 * maxWave * meta.dtMax) / this.cellSize,
    };
    this.snapshot = { simTime: meta.simTime, nx: this.nx, ny: this.ny, depth, stats };

    // CFL inputs. Keep a brush-induced depth boost until a readback taken after that edit arrives.
    this.hRead = maxH;
    this.uRead = Math.sqrt(maxSp2);
    this.waveRead = Number.isFinite(maxWave) ? maxWave : Infinity;
    if (meta.seq >= this.hBoostSeq) this.hBoost = 0;
    if (meta.simTime > this.uBoostTime) this.uBoost = 0;
    if (meta.simTime > this.readSimTime) this.readSpan = meta.simTime - this.readSimTime;
    this.readSimTime = meta.simTime;
    this.diagnostics = { nonFiniteCells: nonFinite, minDepth: minH, processMs: now() - t0 };
  }

  /** Upload the dry-at-reset bitmask read by the stats pass (bit c = 1 ⇔ cell c had h < WET_DEPTH). */
  private uploadDryMask(): void {
    const words = new Uint32Array(Math.ceil(this.N / 32));
    for (let c = 0; c < this.N; c++) if (this.dryAtReset[c]) words[c >>> 5] |= 1 << (c & 31);
    this.device.queue.writeBuffer(this.dryMaskBuf, 0, words);
  }
}
