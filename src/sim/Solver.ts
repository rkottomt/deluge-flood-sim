/**
 * GpuFloodSolver — the WebGPU shallow-water solver behind Deluge.
 *
 * ── Per substep (all substeps of a frame go into ONE compute pass / command buffer) ──────────────────────
 *   Pass A  momentum      state[p] ──▶ flux          (face discharges: pressure/bed slope, advection,
 *                                                     semi-implicit friction, θ smoothing, velocity cap)
 *   Pass B  continuity    state[p] + flux ──▶ state[1−p]  (+ accounting buffer)
 *                                                    (positivity limiter, ∂h/∂t = −∇·q, rain, sources,
 *                                                     infiltration, stage levels with no momentum inside a
 *                                                     stage disc, open boundaries closed next to inflows)
 * ── On demand ──────────────────────────────────────────────────────────────────────────────────────────
 *   Brush   walls / erase / water / dig over a rectangle (CPU mirrors of ground + walls kept in sync)
 *   Raise   raiseWaterSurface: h = max(h, base + offset − bed) in place (river crests), booked as inflow
 * ── Per frame ──────────────────────────────────────────────────────────────────────────────────────────
 *   Export  state ──▶ stateTexture (h, u, v, maxDepth)   for the renderer, LAZILY: on the first read of stateTexture
 *            after a step (a renderer refreshing its water every other frame pays for every other export), or
 *            before a stats readback
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
 *   'naive' mode removes 2–4 and the margins and lets C > 1 — it blows up, which is the point of the demo.
 */
import {
  DEFAULT_SIM_PARAMS,
  type BrushOp,
  type FloodSolver,
  type SimParams,
  type SimSnapshot,
  type SimStats,
  type SolverTerrainInput,
  type StepInfo,
  type StormCell,
  type WaterSource,
} from '../contracts';
import { applyBrushCPU, brushOpValid, brushRect, packBrushUniform } from './brush';
import { GpuWorkBudget } from './budget';
import {
  DEFAULT_SOLVER_OPTIONS,
  GRAVITY,
  MAX_SOURCES,
  MAX_STORMS,
  MMHR_TO_MS,
  VELOCITY_DEPTH,
  WET_DEPTH,
  type SolverOptions,
} from './constants';
import { footprintRadius, inflowFactor, packForcing, sourceFootprint, type ForcingWindow, type Footprint, type PackedForcing } from './forcing';
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
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface StagingSet {
  depth: GPUBuffer;
  blocks: GPUBuffer;
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
  private readonly barrier: Float32Array;
  private readonly groundTex: GPUTexture;
  private readonly stateTex: [GPUTexture, GPUTexture];
  private readonly fluxTex: GPUTexture;
  private readonly exportTex: [GPUTexture, GPUTexture];
  private readonly accBuf: GPUBuffer;
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
  /** [exportParity] */
  private readonly bgStats: GPUBindGroup[];
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
   * Latest WaterSource.stopAfter among the inflow sources, simulated seconds (0 = none of them is timed). While the
   * stop is still ahead of the frame last packed, the forcing is re-packed every frame — see gateTimedInflow.
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
      exportP: GPUComputePipeline;
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

    const B = GPUBufferUsage;
    this.accBuf = device.createBuffer({
      label: 'sim.accounting',
      size: this.N * ACC_PER_CELL * 4,
      usage: B.STORAGE | B.COPY_SRC | B.COPY_DST,
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
    this.exportPipe = pipes.exportP;
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
          ],
        }),
      ),
    );

    this.bgStats = [0, 1].map((e) =>
      device.createBindGroup({
        label: `sim.stats${e}`,
        layout: this.statsPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: ub(this.simBuf) },
          { binding: 1, resource: this.exportTex[e].createView() },
          { binding: 2, resource: ub(this.accBuf) },
          { binding: 3, resource: ub(this.dryMaskBuf) },
          { binding: 4, resource: ub(this.depthBuf) },
          { binding: 5, resource: ub(this.blocksBuf) },
        ],
      }),
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

    const make = async (label: string, code: string, entries: GPUBindGroupLayoutEntry[]) => {
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
      const pipeline = await device.createComputePipelineAsync({
        label,
        layout: device.createPipelineLayout({ label, bindGroupLayouts: [layout] }),
        compute: { module, entryPoint: 'main' },
      });
      return { pipeline, layout };
    };
    device.pushErrorScope('validation');
    let built: Awaited<ReturnType<typeof make>>[];
    try {
      built = await Promise.all([
      make('sim.momentum', momentumWGSL, [uniform(0, SIM_UNIFORM_BYTES), sampled(1), storageTex(2, 'rg32float')]),
      make('sim.continuity', continuityWGSL, [
        uniform(0, SIM_UNIFORM_BYTES),
        uniform(1, FORCING_UNIFORM_BYTES),
        sampled(2),
        sampled(3),
        storageTex(4, 'rgba32float'),
        storageBuf(5),
      ]),
      make('sim.export', exportWGSL, [uniform(0, SIM_UNIFORM_BYTES), sampled(1), sampled(2), storageTex(3, 'rgba32float')]),
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
      ]),
      make('sim.raise', raiseWGSL, [uniform(0, RAISE_UNIFORM_BYTES), sampled(1), sampled(2), storageTex(3, 'rgba32float'), storageBuf(4)]),
      make('sim.stats', statsWGSL, [
        uniform(0, SIM_UNIFORM_BYTES),
        sampled(1),
        storageBuf(2, 'read-only-storage'),
        storageBuf(3, 'read-only-storage'),
        storageBuf(4),
        storageBuf(5),
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
        exportP: exportP.pipeline,
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
    for (const s of this.sources) {
      if (s.type === 'inflow' && s.stopAfter !== undefined && Number.isFinite(s.stopAfter) && s.stopAfter > stopAt) stopAt = s.stopAfter;
    }
    this.inflowStopAt = stopAt;
    // A zero-length window at the current time: a source added mid-run is gated by where the clock already is, and
    // the next frame replaces this with its own window.
    this.forcingWindow = { from: this.simTime, to: this.simTime };
    this.forcingDirty = true;
    this.sourcesChanged = true;
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
        const d = res.levels[k] - (this.ground[c] + this.barrier[c]);
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
      this.uBoost = Math.max(this.uBoost, Math.min(this.options.uMax, 2 * Math.sqrt(GRAVITY * dhMax)));
      this.uBoostTime = this.simTime;
    }
    // No readback here: one taken before any step would pair the raised water with the previous window's (larger)
    // dt and report a Courant number no substep ever ran at. The boosts above cover the CFL until the next one.
    device.queue.submit([enc.finish()]);
  }

  /**
   * Advance realSeconds × timeScale of simulated time. Every substep uses the CFL timestep; requested time that
   * does not fill a whole substep is carried to the next frame (so at timeScale 1, ~one substep per 0.4 s of
   * sim instead of one per frame — up to ~25× less GPU work — and naive mode really runs at the user's Courant
   * number at any time scale). If the substep cap (maxSubstepsPerFrame ∩ GPU budget) cannot keep up, the backlog
   * beyond one substep is dropped and `throttled` is reported: sim speed degrades, frame rate does not.
   */
  step(realSeconds: number): StepInfo {
    const info: StepInfo = { simSecondsAdvanced: 0, substeps: 0, dt: 0, throttled: false };
    if (this.destroyed) return info;
    const scale = Number.isFinite(this.params.timeScale) ? Math.max(0, this.params.timeScale) : 0;
    const requested = (Number.isFinite(realSeconds) ? Math.max(0, realSeconds) : 0) * scale;
    const dt = this.computeDt();
    info.dt = dt;
    if (!(requested > 0)) return info;

    this.pendingSimTime += requested;
    // 1e-9 relative slack so exact multiples (e.g. timeScale = dt·fps) don't lose a substep to rounding.
    let n = Math.floor(this.pendingSimTime / dt + 1e-9);
    const cap = this.substepCap();
    if (n > cap) {
      n = cap;
      info.throttled = true;
    }
    if (n <= 0) {
      // Nothing to run yet (the carried time is less than one substep), or the GPU queue is backed up.
      if (info.throttled) this.pendingSimTime = Math.min(this.pendingSimTime, dt);
      return info;
    }
    this.encodeFrame(n, dt, true);
    this.pendingSimTime = Math.max(0, this.pendingSimTime - n * dt);
    if (info.throttled) this.pendingSimTime = Math.min(this.pendingSimTime, dt);
    info.substeps = n;
    info.simSecondsAdvanced = n * dt;
    return info;
  }

  reset(opts?: { resetTerrain?: boolean }): void {
    if (this.destroyed) return;
    if (opts?.resetTerrain) {
      this.ground.set(this.originalGround);
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
        data[4 * c + 3] = Math.fround(this.ground[c] + this.barrier[c]) - this.z0;
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

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const t of [...this.stateTex, ...this.exportTex, this.fluxTex, this.groundTex, this.barrierTexture, this.bedTexture]) {
      t.destroy();
    }
    for (const t of this.brushRes?.tex ?? []) t.destroy();
    this.raiseRes?.tex.destroy();
    this.raiseRes?.buf.destroy();
    this.resetTex?.destroy();
    for (const b of [this.accBuf, this.simBuf, this.forcingBuf, this.brushBuf, this.depthBuf, this.blocksBuf, this.dryMaskBuf]) {
      b.destroy();
    }
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
   * released by sources, rain running off dry ground) and clamps Cr to robustCflMax. Naive mode uses the raw depth, no speed term, and trusts the user's Cr (the demo
   * sets 1.8).
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
    this.writeSimUniform(dt);
    const enc = device.createCommandEncoder({ label: 'sim.frame' });
    // Frames driven by step() are timed on the GPU to keep the substep budget current (see shouldProbe).
    const probe = fromStep && this.shouldProbe() ? this.budget.beginFrame(n) : null;
    if (probe) this.lastProbeMs = now();
    const pass = enc.beginComputePass({ label: 'sim.substeps', timestampWrites: probe?.timestampWrites });
    for (let k = 0; k < n; k++) {
      pass.setPipeline(this.momentumPipe);
      pass.setBindGroup(0, this.bgMomentum[this.cur]);
      pass.dispatchWorkgroups(this.gx, this.gy);
      pass.setPipeline(this.continuityPipe);
      pass.setBindGroup(0, this.bgContinuity[this.cur]);
      pass.dispatchWorkgroups(this.gx, this.gy);
      this.cur = 1 - this.cur;
    }
    pass.end();
    probe?.resolve(enc);
    // The export follows lazily (stateTexture getter, or the readback below when one is due).
    this.exportDirty = true;
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
    const pass = enc.beginComputePass({ label: 'sim.export' });
    pass.setPipeline(this.exportPipe);
    pass.setBindGroup(0, this.bgExport[this.cur][this.exportCur]);
    pass.dispatchWorkgroups(this.gx, this.gy);
    pass.end();
    this.exportCur = 1 - this.exportCur;
    // resetMax only applies to the first export after a reset; the uniform already carried it.
    this.resetMaxPending = false;
    this.exportDirty = false;
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

  private writeSimUniform(dt: number): void {
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
    fv[8] = o.uMax;
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
    const { cellSize, ground, barrier } = this;
    const depth = this.snapshot?.depth ?? this.initialDepth;
    let u = 0;
    for (const s of this.sources.slice(0, MAX_SOURCES)) {
      const R = footprintRadius(s.radius);
      if (s.type === 'inflow') {
        // A timed inflow that has already stopped is not about to produce anything (inflowFactor at the clock's
        // current instant is 0), so it must not hold the timestep down for the rest of the run.
        const Q = (Number.isFinite(s.discharge) ? Math.max(0, s.discharge) : 0) * inflowFactor(s.stopAfter, this.simTime, this.simTime);
        if (Q > 0) u = Math.max(u, 2 * Math.cbrt((GRAVITY * Q) / (2 * Math.PI * (R + 0.5) * cellSize)));
        continue;
      }
      if (!Number.isFinite(s.level)) continue;
      const cells = this.footprintOf(s).cells;
      let dh = 0;
      for (let k = 0; k < cells.length; k++) {
        const c = cells[k];
        dh = Math.max(dh, s.level - (ground[c] + barrier[c] + depth[c]));
      }
      if (dh > 0) u = Math.max(u, 2 * Math.sqrt(GRAVITY * dh));
    }
    return Math.min(u, this.options.uMax);
  }

  /**
   * Point the packed forcing at the window this frame is about to cover, so a timed inflow (WaterSource.stopAfter)
   * delivers exactly Q·stopAfter and then nothing.
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
  }

  private packForcingNow(): PackedForcing {
    const { ground, barrier } = this;
    return packForcing(
      this.sources,
      this.storms,
      this.nx,
      this.ny,
      this.cellSize,
      this.z0,
      (c) => ground[c] + barrier[c],
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
    const { nx, ground, barrier, z0, initialDepth } = this;
    const data = new Float32Array(rect.w * rect.h * 4);
    for (let j = 0; j < rect.h; j++) {
      for (let i = 0; i < rect.w; i++) {
        const c = (rect.y0 + j) * nx + rect.x0 + i;
        const o = 4 * (j * rect.w + i);
        data[o] = initialDepth[c];
        data[o + 3] = Math.fround(ground[c] + barrier[c]) - z0;
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
    // The reduction reads the exported state: it must include every substep booked in the accounting buffer
    // (zeroed below), or volume and in/out volumes would come from different moments.
    if (this.exportDirty) this.encodeExport(enc);
    const pass = enc.beginComputePass({ label: 'sim.stats' });
    pass.setPipeline(this.statsPipe);
    // exportCur was flipped after the last export: the latest exported texture is exportTex[exportCur].
    pass.setBindGroup(0, this.bgStats[this.exportCur]);
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
