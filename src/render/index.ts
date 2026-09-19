/**
 * Deluge WebGPU renderer (ARCHITECTURE.md §6).
 *
 * Frame outline:
 *   compute  prep: solver bed/barrier/state → derived vertex + filterable surface textures
 *   pass 1   MSAA 4× HDR (rgba16float, depth32float reversed-Z):
 *            sky → terrain → skirt → opaque markers → water → water skirt → roads/route/ring → translucent markers → rain
 *   pass 2-4 bloom (bright pass + separable blur at ¼ res)
 *   pass 5   ACES tonemap + dither → canvas
 */
import type {
  FloodRenderer,
  FloodSolver,
  OverlayState,
  PickResult,
  RenderSettings,
  TerrainData,
} from '../contracts';
import { OrbitController, type CameraEnvironment, type CameraMatrices } from './camera';
import { HeightField, meshStride } from './heightfield';
import { frustumPlanes, LOD_PATCH, LodTree } from './lod';
import { bandsForMode, cssToLinear } from './legend';
import { buildMarkers, buildRoadRibbons, buildWallGhost, circlePolyline, MarkerBuilder, RibbonBuilder, RibbonKind, stormCloudElevation } from './overlays';
import { cameraRay, pickTerrain } from './picking';
import { createPipelines, DEPTH_FORMAT, HDR_FORMAT, MSAA, type Pipelines } from './pipelines';
import { FRAME_UNIFORM_SIZE } from './shaders/common';
import { OVERLAY_UNIFORM_SIZE } from './shaders/overlay';
import { createImageryTexture, createRippleTexture, createSolidTexture } from './textures';
import { clamp } from './math';
import {
  cloudDeckHalfThickness,
  hazeBoost,
  lightingPreset,
  OVERCAST_MAX,
  overcastFor,
  imageryRelightFactor,
  skyColors,
  sunDirection,
  sunLowness,
  type CloudDeck,
  type LightingSettings,
} from './atmosphere';
import { expandForShadow, SHADOW_QUALITY, shadowReachCells, SunShading, type CellRect } from './shadows';
import { AdaptiveQuality, QUALITY_PRESETS, targetSize, type QualityPreset, type RendererQuality, type SimPressure } from './quality';
import { GpuTimer } from './gpuTimer';
import { WallField, WALL_FIELD_RADIUS, type Rect } from './wallField';
import { BASE_EXPOSURE, hazardInput } from './tonemap';
import { footprintRadius, stormWeight } from '../sim/forcing';

export { DEPTH_BANDS, MAX_DEPTH_BANDS, NORMAL_WATER_LEGEND, VELOCITY_BANDS, bandsForMode } from './legend';
export { OrbitController } from './camera';
export { LIGHTING_PRESETS, type LightingPreset, type LightingSettings } from './atmosphere';
export type { RendererQuality, SimPressure } from './quality';

const WATER_MODE_INDEX = { realistic: 0, depth: 1, maxDepth: 2, velocity: 3 } as const;

/** Tallest thing a brush can add or remove, for sizing the sun-shading rebuild after an edit (metres). */
const EDIT_RELIEF_M = 40;
/** Ceiling on how far downsun that rebuild reaches, so a sun near the horizon cannot ask for the whole grid. */
const SHADOW_EDIT_MAX_CELLS = 220;

export interface RendererOptions {
  /** Default 'auto': adaptive resolution targeting ≥ 48 fps sustained, idle frames capped at 30 fps. */
  quality?: RendererQuality;
}

/** Live renderer statistics (milliseconds are smoothed). GPU timings need 'timestamp-query' (else 0). */
export interface RendererStats {
  gpuMs: number;
  prepMs: number;
  mainMs: number;
  postMs: number;
  /** CPU time spent inside render() (encoding + uploads). */
  cpuMs: number;
  /** Frames actually drawn / render() calls skipped by the idle cap since creation. */
  framesDrawn: number;
  framesSkipped: number;
  width: number;
  height: number;
  /** Rendered pixels per CSS pixel along each axis (e.g. 2 on a Retina display at full resolution). */
  renderScale: number;
  /** Current 'auto' ladder step (0 = best); -1 for fixed presets. */
  autoLevel: number;
  gpuTimingAvailable: boolean;
  /**
   * Wall-clock ms to drain the queue after the last full sun-shading build was submitted (src/render/shadows.ts):
   * the load-time cost of the terrain's cast shadows and sky occlusion. 0 until one has been measured.
   */
  shadowBuildMs: number;
  /** Cells rebuilt by the last sun-shading build (the whole grid at load, an edit's neighbourhood after that). */
  shadowCells: number;
}

/** FloodRenderer plus the (non-contract) quality knob and statistics. */
export interface DelugeRendererAPI extends FloodRenderer {
  readonly camera: OrbitController;
  readonly quality: RendererQuality;
  setQuality(quality: RendererQuality): void;
  /**
   * Externally imposed frame interval in ms (e.g. a browser's 30 fps battery-saver cap), 0 = none. 'auto' quality
   * then treats frames at that ceiling as on target instead of stepping resolution down.
   */
  setFrameIntervalFloor(ms: number): void;
  /**
   * How hard the simulation is pushing for GPU time (0 keeps up, 1 GPU-limited, 2 starved). 'auto' quality then holds
   * its level instead of claiming frame-time headroom the solver needs, and when starved steps down (not below 1 render
   * pixel per CSS pixel).
   */
  setSimPressure(pressure: SimPressure): void;
  /**
   * Land the user's walls keep dry (nx·ny, 255 = protected; see src/app/protection.ts), drawn as a soft green glow on
   * the terrain; null clears it. The mask is copied to the GPU, so the caller may reuse the array.
   */
  setProtectedMask(mask: Uint8Array | null): void;
  /**
   * Re-capture the "normally wet" mask (rivers and lakes before any flood) from the solver's current water. setScene
   * does this automatically — it is called right after solver.setInitialWater — so this is only needed if the
   * initial water is replaced later. The hazard maps colour only land outside this mask.
   */
  captureNormalWater(): void;
  /** Where the sun is and how hard the terrain shading is pushed (src/render/atmosphere.ts). */
  readonly lighting: Readonly<LightingSettings>;
  /**
   * Change the lighting. Pass a preset name ('daylight' — the default, matching the shadows already in the USGS
   * imagery; 'goldenHour' — a low evening sun for hero shots; 'morning'), individual fields, or both: the preset is
   * applied first and the fields override it. The sun-shading raster is rebuilt on the next frame (see
   * stats.shadowBuildMs for what that costs), so this is a scene-level control, not something to animate per frame.
   */
  setLighting(opts: { preset?: string } & Partial<LightingSettings>): void;
  readonly stats: Readonly<RendererStats>;
}

export async function createRenderer(
  device: GPUDevice,
  canvas: HTMLCanvasElement,
  format: GPUTextureFormat,
  options: RendererOptions = {},
): Promise<DelugeRendererAPI> {
  const pipelines = await createPipelines(device, format);
  return new DelugeRenderer(device, canvas, format, pipelines, options);
}

/** Growable GPU buffer. */
class DynBuffer {
  buffer: GPUBuffer | null = null;
  count = 0;
  constructor(
    private device: GPUDevice,
    private usage: number,
    private label: string,
  ) {}
  write(data: ArrayBufferView & { length: number }, count: number): void {
    const bytes = data.byteLength;
    this.count = count;
    if (bytes === 0) return;
    if (!this.buffer || this.buffer.size < bytes) {
      this.buffer?.destroy();
      const size = Math.max(256, Math.ceil((bytes * 1.5) / 4) * 4);
      this.buffer = this.device.createBuffer({ label: this.label, size, usage: this.usage | GPUBufferUsage.COPY_DST });
    }
    this.device.queue.writeBuffer(this.buffer, 0, data.buffer, data.byteOffset, bytes);
  }
  destroy() {
    this.buffer?.destroy();
    this.buffer = null;
    this.count = 0;
  }
}

interface SceneGPU {
  terrain: TerrainData;
  solver: FloodSolver;
  nx: number;
  ny: number;
  stride: number;
  vx: number;
  vy: number;
  hf: HeightField;
  lod: LodTree;
  wetTex: GPUTexture;
  /** The wet pyramid holds a completed build (usable as a hint by the next prep). */
  wetValid: boolean;
  /** [base (from vtxTex), down 0→1, down 1→2, …] */
  wetBGs: GPUBindGroup[];
  groundMin: number;
  groundMax: number;
  vtxTex: GPUTexture;
  surfTex: GPUTexture;
  normTex: GPUTexture;
  miscTex: GPUTexture;
  imageryTex: GPUTexture;
  hasImagery: boolean;
  terrainBG: GPUBindGroup;
  waterBG: GPUBindGroup;
  overlayBG: GPUBindGroup;
  prepParams: GPUBuffer;
  prepCache: Map<GPUTexture, { bed: GPUTexture; barrier: GPUTexture; cells: GPUBindGroup }>;
  /** Per-cell (depth, water surface) written by the cells pass for the verts pass. */
  cellTex: GPUTexture;
  /** Per-vertex bed, rebuilt only when the terrain changes (see terrainKey). */
  vtxBedTex: GPUTexture;
  vertsBG: GPUBindGroup;
  vtxBedBG: { bed: GPUTexture; barrier: GPUTexture; bg: GPUBindGroup } | null;
  /** Solver terrain version vtxBedTex was built from (-1 = never; solvers without a version rebuild every time). */
  terrainKey: number;
  roadVerts: GPUBuffer | null;
  roadIndices: GPUBuffer | null;
  roadIndexCount: number;
  roadStatus: GPUBuffer;
  roadStatusCopy: Uint8Array | null;
  contourInterval: number;
  /** Wall distance field (CPU) and its rgba16float texture (distance, height, crest). */
  wallField: WallField;
  wallTex: GPUTexture;
  /** rgba8unorm, r = 1 where the cell held water at the initial fill. */
  normalWetTex: GPUTexture;
  normalWetValid: boolean;
  /** Land kept dry by walls (r8unorm, 255 = protected); only sampled while `protectOn`. */
  protectTex: GPUTexture;
  protectOn: boolean;
  /** Sun visibility + sky visibility over the DEM (src/render/shadows.ts). */
  sun: SunShading;
  /** Terrain rectangle whose lighting an edit invalidated, or null; 'all' forces a full rebuild. */
  sunDirty: CellRect | 'all' | null;
}

interface MeshBuffers {
  vx: number;
  vy: number;
  skirt: GPUBuffer;
  skirtCount: number;
}

class DelugeRenderer implements DelugeRendererAPI {
  readonly camera: OrbitController;
  readonly stats: RendererStats = {
    gpuMs: 0,
    prepMs: 0,
    mainMs: 0,
    postMs: 0,
    cpuMs: 0,
    framesDrawn: 0,
    framesSkipped: 0,
    width: 0,
    height: 0,
    renderScale: 1,
    autoLevel: -1,
    gpuTimingAvailable: false,
    shadowBuildMs: 0,
    shadowCells: 0,
  };

  private qualityMode: RendererQuality = 'auto';
  private adaptive = new AdaptiveQuality();
  private timer: GpuTimer;
  /** Previous rendered frame's inputs, for the idle cap and prep skipping. */
  private lastDrawAt = 0;
  private lastSignature = '';
  private overlayVersion = 0;
  /**
   * Developer toggles for profiling (e.g. 'terrain', 'water', 'roads', 'markers', 'sky', 'bloom', 'prep', and for
   * the lighting work: 'shadows' — skip the sun-shading raster and its lookup — and 'detail' — skip the sub-DEM
   * detail normals). The last two exist so the cost of each addition can be measured against the same frame.
   */
  readonly debugSkip = new Set<string>();
  private prevRenderCallDrew = false;
  /** Solver state key (see stateKey) the derived textures were last built from. */
  private lastPrepKey = -1;
  private lastPrepUseMax = -1;
  private lastPrepUseMaxBuilt = -1;
  private framesSincePrep = 1e9;
  private ctx: GPUCanvasContext;
  private frameBuf: GPUBuffer;
  private frameData = new Float32Array(FRAME_UNIFORM_SIZE / 4);
  /** Protected-land glow strength (animated toward 1 while a mask is set), and the last frame's duration in s. */
  private protectFade = 0;
  private frameDt = 1 / 60;
  private overlayBuf: GPUBuffer;
  private postBuf: GPUBuffer;
  private bloomBufs: GPUBuffer[];
  private linClamp: GPUSampler;
  private aniso: GPUSampler;
  private repeat: GPUSampler;
  private rippleTex: GPUTexture;
  private dummyImagery: GPUTexture;
  private skyBG: GPUBindGroup;
  private rainBG: GPUBindGroup;

  private scene: SceneGPU | null = null;
  private mesh: MeshBuffers | null = null;
  /** Index buffer of one LOD_PATCH × LOD_PATCH node patch (shared by terrain and water). */
  private patchIndex: GPUBuffer;
  private patchIndexCount = LOD_PATCH * LOD_PATCH * 6;
  private nodeBuf: DynBuffer;
  private nodeCount = 0;
  /** Last LOD selection (diagnostics). */
  lodStats: { nodes: number; perLevel: number[] } = { nodes: 0, perLevel: [] };

  // Render targets
  private width = 0;
  private height = 0;
  private msaaColor: GPUTexture | null = null;
  private msaaDepth: GPUTexture | null = null;
  private hdr: GPUTexture | null = null;
  private bloomA: GPUTexture | null = null;
  private bloomB: GPUTexture | null = null;
  private bloomBGs: GPUBindGroup[] = [];
  private tonemapBG: GPUBindGroup | null = null;

  // Overlays
  private overlays: OverlayState | null = null;
  private dynRibbons: DynBuffer;
  private dynRibbonIdx: DynBuffer;
  private routeIndexStart = 0;
  private routeIndexCount = 0;
  private ringIndexCount = 0;
  private markerOpaqueV: DynBuffer;
  private markerOpaqueI: DynBuffer;
  private markerBlendV: DynBuffer;
  private markerBlendI: DynBuffer;
  private markerKey = '';
  private ribbonKey = '';

  private exaggeration = 1.5;
  /** Grid rectangles of recently committed wall previews, re-scanned every frame for a short while. */
  private hotRects: Array<Rect & { ttl: number }> = [];
  private lastPreviewRect: Rect | null = null;
  /** A terrain / wall edit was detected: rebuild the derived textures this frame. */
  private forcePrep = false;
  private editEpoch = 0;
  /** Sky overcast (0..0.92) of the current frame (also drives exposure). */
  private overcast = 0;
  private lightingSettings: LightingSettings = lightingPreset('daylight');
  private lightingKey = 'daylight';
  /** Sun-shading quality the current raster was built at (a change rebuilds it). */
  private sunShadowsBuiltAt: 'low' | 'standard' | 'cinematic' | null = null;
  private hazardCache = new Map<string, number[]>();
  private lastFrameMs = 0;
  private frameCounter = 0;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private needsResize = true;

  constructor(
    private device: GPUDevice,
    private canvas: HTMLCanvasElement,
    private format: GPUTextureFormat,
    private P: Pipelines,
    options: RendererOptions,
  ) {
    this.qualityMode = options.quality ?? 'auto';
    this.timer = new GpuTimer(device);
    this.stats.gpuTimingAvailable = this.timer.enabled;
    const ctx = canvas.getContext('webgpu');
    if (!ctx) throw new Error('Could not get a WebGPU canvas context');
    this.ctx = ctx;
    ctx.configure({ device, format, alphaMode: 'opaque' });

    this.frameBuf = device.createBuffer({ label: 'frame', size: FRAME_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.overlayBuf = device.createBuffer({ label: 'overlay', size: OVERLAY_UNIFORM_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.postBuf = device.createBuffer({ label: 'post', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bloomBufs = [0, 1, 2].map((i) => device.createBuffer({ label: `bloom${i}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    this.linClamp = device.createSampler({ minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.aniso = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 16,
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    this.repeat = device.createSampler({
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear',
      maxAnisotropy: 8,
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    });
    this.rippleTex = createRippleTexture(device);
    this.dummyImagery = createSolidTexture(device, [0.3, 0.35, 0.25, 1]);
    this.skyBG = device.createBindGroup({ layout: P.sky.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });
    this.rainBG = device.createBindGroup({ layout: P.rain.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.frameBuf } }] });

    const V = GPUBufferUsage.VERTEX;
    const I = GPUBufferUsage.INDEX;
    this.dynRibbons = new DynBuffer(device, V, 'dyn-ribbons');
    this.dynRibbonIdx = new DynBuffer(device, I, 'dyn-ribbons-idx');
    this.markerOpaqueV = new DynBuffer(device, V, 'markers-opaque');
    this.markerOpaqueI = new DynBuffer(device, I, 'markers-opaque-idx');
    this.markerBlendV = new DynBuffer(device, V, 'markers-blend');
    this.markerBlendI = new DynBuffer(device, I, 'markers-blend-idx');
    this.nodeBuf = new DynBuffer(device, V, 'lod-nodes');
    this.patchIndex = createPatchIndex(device);

    this.camera = new OrbitController(this.cameraEnv());
    this.camera.attach(canvas);

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.needsResize = true;
      });
      this.resizeObserver.observe(canvas);
    }
  }

  // ── Camera environment ───────────────────────────────────────────────────────────────────

  private cameraEnv(): CameraEnvironment {
    const s = this.scene;
    return {
      nx: s?.nx ?? 1024,
      ny: s?.ny ?? 1024,
      cellSize: s?.terrain.cellSize ?? 8,
      exaggeration: this.exaggeration,
      minElev: s?.groundMin ?? 0,
      maxElev: s?.groundMax ?? 100,
      heightAt: (gx, gy) => (this.scene ? this.scene.hf.heightAt(gx, gy) : null),
      // The imagery covers the grid exactly; its coarser axis sets the texel size.
      imageryMetersPerTexel:
        s?.hasImagery && s.imageryTex.width > 0 && s.imageryTex.height > 0
          ? Math.max((s.nx * s.terrain.cellSize) / s.imageryTex.width, (s.ny * s.terrain.cellSize) / s.imageryTex.height)
          : null,
      pickWorld: (x, y) => {
        const hit = this.pick(x, y);
        return hit ? { gx: hit.gx, gy: hit.gy, elevation: hit.elevation } : null;
      },
    };
  }

  // ── Scene ────────────────────────────────────────────────────────────────────────────────

  setScene(terrain: TerrainData, solver: FloodSolver): void {
    if (this.destroyed) return;
    this.disposeScene();
    const device = this.device;
    const nx = solver.nx;
    const ny = solver.ny;
    const stride = meshStride(nx, ny);
    const vx = Math.floor(nx / stride) + 1;
    const vy = Math.floor(ny / stride) + 1;
    const hf = new HeightField(nx, ny, solver.cellSize, solver.getGroundCPU(), solver.getBarrierCPU(), stride);
    let gMin = Infinity;
    let gMax = -Infinity;
    const ground = solver.getGroundCPU();
    for (let i = 0; i < ground.length; i++) {
      const z = ground[i];
      if (z < gMin) gMin = z;
      if (z > gMax) gMax = z;
    }
    if (!Number.isFinite(gMin)) gMin = gMax = 0;

    this.ensureMesh(vx, vy);

    const tex = (label: string, w: number, h: number, format: GPUTextureFormat) =>
      device.createTexture({ label, size: [w, h], format, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const vtxTex = tex('vtx', vx, vy, 'rgba32float');
    const lod = new LodTree(nx, ny, solver.cellSize, stride, solver.getGroundCPU(), solver.getBarrierCPU());
    // Wet pyramid over base quads, power-of-two so every LOD node maps to exactly one texel of some mip.
    const pw = nextPow2(vx - 1);
    const ph = nextPow2(vy - 1);
    const wetMips = Math.floor(Math.log2(Math.max(pw, ph))) + 1;
    const wetTex = device.createTexture({
      label: 'wet-pyramid',
      size: [pw, ph],
      format: 'r32float',
      mipLevelCount: wetMips,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const protectTex = device.createTexture({ label: 'protected-land', size: [nx, ny], format: 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const wetBGs: GPUBindGroup[] = [
      device.createBindGroup({
        label: 'wet-base',
        layout: this.P.wetBase.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: vtxTex.createView() },
          { binding: 1, resource: wetTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
        ],
      }),
    ];
    for (let lv = 1; lv < wetMips; lv++) {
      wetBGs.push(
        device.createBindGroup({
          label: `wet-down${lv}`,
          layout: this.P.wetDown.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: wetTex.createView({ baseMipLevel: lv - 1, mipLevelCount: 1 }) },
            { binding: 1, resource: wetTex.createView({ baseMipLevel: lv, mipLevelCount: 1 }) },
          ],
        }),
      );
    }
    const surfTex = tex('surf', nx, ny, 'rgba16float');
    const cellTex = tex('prep-cells', nx, ny, 'rg32float');
    const vtxBedTex = tex('vtx-bed', vx, vy, 'r32float');
    const normTex = tex('norm', nx, ny, 'rgba16float');
    const miscTex = tex('misc', nx, ny, 'rgba16float');
    // Zero texels read as "no wall within range" (proximity 0), so only edited rectangles are ever uploaded.
    const wallTex = device.createTexture({ label: 'wall-field', size: [nx, ny], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const normalWetTex = device.createTexture({
      label: 'normal-water',
      size: [nx, ny],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });

    const sun = new SunShading(device, this.P.shadow, nx, ny, solver.cellSize);

    let imageryTex = this.dummyImagery;
    let hasImagery = false;
    if (terrain.imagery && terrain.imagery.width > 0 && terrain.imagery.height > 0) {
      try {
        imageryTex = createImageryTexture(device, terrain.imagery);
        hasImagery = true;
      } catch (e) {
        console.warn('[render] imagery upload failed, using hypsometric tint', e);
      }
    }

    const sceneEntries = (tex5: GPUTexture, samp7: GPUSampler): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: this.frameBuf } },
      { binding: 1, resource: vtxTex.createView() },
      { binding: 2, resource: normTex.createView() },
      { binding: 3, resource: miscTex.createView() },
      { binding: 4, resource: surfTex.createView() },
      { binding: 5, resource: tex5.createView() },
      { binding: 6, resource: this.linClamp },
      { binding: 7, resource: samp7 },
      { binding: 8, resource: wetTex.createView() },
      { binding: 9, resource: wallTex.createView() },
      { binding: 10, resource: normalWetTex.createView() },
      { binding: 11, resource: protectTex.createView() },
      { binding: 12, resource: sun.texture.createView() },
    ];
    const terrainBG = device.createBindGroup({ label: 'terrain', layout: this.P.sceneBGL, entries: sceneEntries(imageryTex, this.aniso) });
    const waterBG = device.createBindGroup({ label: 'water', layout: this.P.sceneBGL, entries: sceneEntries(this.rippleTex, this.repeat) });

    // Roads
    let roadVerts: GPUBuffer | null = null;
    let roadIndices: GPUBuffer | null = null;
    let roadIndexCount = 0;
    const edgeCount = terrain.roads?.edges.length ?? 0;
    if (terrain.roads && edgeCount > 0) {
      const rb = buildRoadRibbons(terrain.roads, solver.cellSize, stride);
      if (rb.indices.length > 0) {
        roadVerts = device.createBuffer({ label: 'roads', size: rb.verts.length * 4, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
        new Float32Array(roadVerts.getMappedRange()).set(rb.verts.view());
        roadVerts.unmap();
        roadIndices = device.createBuffer({ label: 'roads-idx', size: rb.indices.length * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
        new Uint32Array(roadIndices.getMappedRange()).set(rb.indices.view());
        roadIndices.unmap();
        roadIndexCount = rb.indices.length;
      }
    }
    const roadStatus = device.createBuffer({
      label: 'road-status',
      size: Math.max(4, edgeCount * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const overlayBG = device.createBindGroup({
      label: 'overlay',
      layout: this.P.overlayBGL,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: vtxTex.createView() },
        { binding: 2, resource: { buffer: this.overlayBuf } },
        { binding: 3, resource: { buffer: roadStatus } },
      ],
    });

    const prepParams = device.createBuffer({ label: 'prep', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const vertsBG = device.createBindGroup({
      label: 'prep-verts',
      layout: this.P.prepVerts.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: prepParams } },
        { binding: 4, resource: vtxTex.createView() },
        { binding: 5, resource: wetTex.createView() },
        { binding: 6, resource: cellTex.createView() },
        { binding: 7, resource: vtxBedTex.createView() },
      ],
    });

    const relief = Math.max(1, gMax - gMin);
    this.scene = {
      terrain,
      solver,
      nx,
      ny,
      stride,
      vx,
      vy,
      hf,
      lod,
      wetTex,
      wetValid: false,
      wetBGs,
      groundMin: gMin,
      groundMax: gMax,
      vtxTex,
      surfTex,
      normTex,
      miscTex,
      imageryTex,
      hasImagery,
      terrainBG,
      waterBG,
      overlayBG,
      prepParams,
      prepCache: new Map(),
      cellTex,
      vtxBedTex,
      vertsBG,
      vtxBedBG: null,
      terrainKey: -1,
      roadVerts,
      roadIndices,
      roadIndexCount,
      roadStatus,
      roadStatusCopy: null,
      contourInterval: niceStep(relief / 24),
      wallField: new WallField(nx, ny, solver.getGroundCPU(), solver.getBarrierCPU()),
      wallTex,
      normalWetTex,
      normalWetValid: false,
      protectTex,
      protectOn: false,
      sun,
      sunDirty: 'all',
    };
    this.protectFade = 0;
    this.markerKey = '';
    this.ribbonKey = '';
    this.hotRects = [];
    this.lastPreviewRect = null;
    this.scene.wallField.scanAll();
    this.uploadWallField(this.scene);
    this.captureNormalWater();
    this.camera.setEnvironment(this.cameraEnv());
  }

  captureNormalWater(): void {
    const s = this.scene;
    if (!s || this.destroyed) return;
    const bg = this.device.createBindGroup({
      label: 'normal-water',
      layout: this.P.normalWater.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: s.solver.stateTexture.createView() },
        { binding: 1, resource: s.normalWetTex.createView() },
      ],
    });
    const enc = this.device.createCommandEncoder({ label: 'normal-water' });
    const cp = enc.beginComputePass({ label: 'normal-water' });
    cp.setPipeline(this.P.normalWater);
    cp.setBindGroup(0, bg);
    cp.dispatchWorkgroups(Math.ceil(s.nx / 16), Math.ceil(s.ny / 16));
    cp.end();
    this.device.queue.submit([enc.finish()]);
    s.normalWetValid = true;
  }

  /** Recompute the wall field where the barrier changed and upload the changed rectangle. */
  /** Recompute the wall field where the barrier changed and upload it; returns the rectangle, or null. */
  private uploadWallField(s: SceneGPU): Rect | null {
    const patch = s.wallField.update();
    if (!patch) return null;
    const rect = patch.rect;
    const w = rect.x1 - rect.x0;
    const h = rect.y1 - rect.y0;
    if (w <= 0 || h <= 0) return rect;
    const data = s.wallField.packHalf(patch, s.groundMin);
    this.device.queue.writeTexture({ texture: s.wallTex, origin: { x: rect.x0, y: rect.y0 } }, data, { bytesPerRow: w * 8 }, { width: w, height: h });
    return rect;
  }

  /** Union an edited rectangle into the region whose sun shading has to be recomputed. */
  private markSunDirty(s: SceneGPU, rect: CellRect | 'all' | null): void {
    if (!rect) return;
    if (rect === 'all' || s.sunDirty === 'all') {
      s.sunDirty = 'all';
      return;
    }
    // Whole cells: the rectangle ends up in an Int32Array of dispatch bounds, and a brush cursor's rect is not.
    const r = { x0: Math.floor(rect.x0), y0: Math.floor(rect.y0), x1: Math.ceil(rect.x1), y1: Math.ceil(rect.y1) };
    const d = s.sunDirty;
    if (!d) {
      s.sunDirty = r;
      return;
    }
    d.x0 = Math.min(d.x0, r.x0);
    d.y0 = Math.min(d.y0, r.y0);
    d.x1 = Math.max(d.x1, r.x1);
    d.y1 = Math.max(d.y1, r.y1);
  }

  /**
   * Terrain / wall edits. The solver's exported state texture changes identity on every export, but two edits
   * between frames flip it back (e.g. a two-segment wall drawn while paused), so edits are also detected from the
   * CPU mirrors: under the brush cursor and where a wall preview was just committed every frame, everywhere else
   * incrementally.
   */
  private watchEdits(s: SceneGPU): void {
    const wf = s.wallField;
    const o = this.overlays;
    const cur = o?.cursor;
    if (cur) {
      const r = cur.radius + 3;
      wf.scanRect(cur.gx - r, cur.gy - r, cur.gx + r, cur.gy + r);
    }
    for (const h of this.hotRects) {
      wf.scanRect(h.x0, h.y0, h.x1, h.y1);
      h.ttl--;
    }
    this.hotRects = this.hotRects.filter((h) => h.ttl > 0);
    wf.scanSome();
    const edited = wf.consumeEdits();
    const wallRect = this.uploadWallField(s);
    if (wallRect || edited) {
      this.forcePrep = true;
      this.editEpoch++;
      // The sun shading has to follow the terrain. A wall patch says exactly where the barrier moved; a ground edit
      // (the dig / raise brushes) is always under the cursor. With neither, fall back to the whole grid rather than
      // leave a stale shadow on screen.
      if (wallRect) this.markSunDirty(s, wallRect);
      if (cur) this.markSunDirty(s, { x0: cur.gx - cur.radius - 3, y0: cur.gy - cur.radius - 3, x1: cur.gx + cur.radius + 3, y1: cur.gy + cur.radius + 3 });
      if (!wallRect && !cur) this.markSunDirty(s, 'all');
    }
  }

  private disposeScene(): void {
    const s = this.scene;
    if (!s) return;
    s.vtxTex.destroy();
    s.wetTex.destroy();
    s.surfTex.destroy();
    s.normTex.destroy();
    s.miscTex.destroy();
    s.wallTex.destroy();
    s.normalWetTex.destroy();
    s.protectTex.destroy();
    if (s.hasImagery) s.imageryTex.destroy();
    s.roadVerts?.destroy();
    s.roadIndices?.destroy();
    s.roadStatus.destroy();
    s.prepParams.destroy();
    s.prepCache.clear();
    s.cellTex.destroy();
    s.vtxBedTex.destroy();
    s.sun.destroy();
    this.sunShadowsBuiltAt = null;
    this.scene = null;
  }

  /** Index buffer for the diorama edge skirt of a (vx × vy) base vertex grid. */
  private ensureMesh(vx: number, vy: number): void {
    if (this.mesh && this.mesh.vx === vx && this.mesh.vy === vy) return;
    this.mesh?.skirt.destroy();
    let o = 0;
    const maxV = Math.max(vx, vy);
    const sideLen = [vx, vx, vy, vy];
    const skirtCount = sideLen.reduce((acc, n) => acc + (n - 1) * 6, 0);
    const skirt = this.device.createBuffer({ label: 'skirt-idx', size: skirtCount * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    const S = new Uint32Array(skirt.getMappedRange());
    o = 0;
    for (let side = 0; side < 4; side++) {
      for (let k = 0; k < sideLen[side] - 1; k++) {
        const b0 = side * 2 * maxV + k * 2;
        const t0 = b0 + 1;
        const b1 = b0 + 2;
        const t1 = b0 + 3;
        S[o++] = b0;
        S[o++] = t0;
        S[o++] = b1;
        S[o++] = t0;
        S[o++] = t1;
        S[o++] = b1;
      }
    }
    skirt.unmap();
    this.mesh = { vx, vy, skirt, skirtCount };
  }

  // ── Overlays ─────────────────────────────────────────────────────────────────────────────

  setOverlays(overlays: OverlayState): void {
    if (overlays !== this.overlays) this.overlayVersion++;
    this.overlays = overlays;
  }

  private syncOverlays(): void {
    const s = this.scene;
    const o = this.overlays;
    if (!s) return;
    const scene = {
      cellSize: s.terrain.cellSize,
      stride: s.stride,
      minElev: s.groundMin,
      maxElev: s.groundMax,
      domainSize: Math.max(s.nx, s.ny) * s.terrain.cellSize,
      nx: s.nx,
      ny: s.ny,
      ground: s.solver.getGroundCPU(),
    };

    // Road status: upload only when the contents change.
    const status = o?.roadStatus ?? null;
    const edgeCount = s.terrain.roads?.edges.length ?? 0;
    if (status && edgeCount > 0) {
      const prev = s.roadStatusCopy;
      let changed = !prev || prev.length !== status.length;
      if (!changed) {
        for (let i = 0; i < status.length; i++) {
          if (status[i] !== prev![i]) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        const n = Math.min(edgeCount, status.length);
        const u = new Uint32Array(edgeCount);
        for (let i = 0; i < n; i++) u[i] = status[i];
        this.device.queue.writeBuffer(s.roadStatus, 0, u);
        s.roadStatusCopy = status.slice();
      }
    } else if (s.roadStatusCopy) {
      s.roadStatusCopy = null;
    }

    // Markers (pins, beacons, gauges, storms) + wall ghost.
    const wp = o?.wallPreview ?? null;
    // Where a wall is being drawn: when the preview goes away the wall has just been committed there.
    if (wp && wp.pts.length >= 2) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i + 1 < wp.pts.length; i += 2) {
        x0 = Math.min(x0, wp.pts[i]);
        x1 = Math.max(x1, wp.pts[i]);
        y0 = Math.min(y0, wp.pts[i + 1]);
        y1 = Math.max(y1, wp.pts[i + 1]);
      }
      const r = wp.radius + 3;
      this.lastPreviewRect = { x0: x0 - r, y0: y0 - r, x1: x1 + r, y1: y1 + r };
    } else if (this.lastPreviewRect) {
      this.hotRects.push({ ...this.lastPreviewRect, ttl: 45 });
      this.lastPreviewRect = null;
    }
    const markerKey = JSON.stringify([
      o?.sources.map((x) => [x.type, x.gx, x.gy, x.type === 'stage' ? x.level : x.discharge]),
      o?.storms.map((x) => [x.gx, x.gy, x.radius, x.intensity]),
      o?.shelters.map((x) => [x.gx, x.gy]),
      o?.evacStart ? [o.evacStart.gx, o.evacStart.gy] : null,
      wp ? [wp.pts.length, wp.pts[wp.pts.length - 2], wp.pts[wp.pts.length - 1], wp.pts[0], wp.pts[1], wp.height, wp.radius] : null,
    ]);
    if (markerKey !== this.markerKey) {
      this.markerKey = markerKey;
      const geo = buildMarkers(scene, o?.sources ?? [], o?.storms ?? [], o?.shelters ?? [], o?.evacStart ?? null);
      if (wp && wp.pts.length >= 2) buildWallGhost(scene, wp.pts, wp.height, wp.radius, geo.blended);
      this.uploadMarkers(geo.opaque, this.markerOpaqueV, this.markerOpaqueI);
      this.uploadMarkers(geo.blended, this.markerBlendV, this.markerBlendI);
    }

    // Dynamic ribbons: route + cursor ring.
    const route = o?.routeState !== 'none' ? (o?.route ?? null) : null;
    const cur = o?.cursor ?? null;
    const ribbonKey = JSON.stringify([
      route ? [route.length, route[0], route[1], route[route.length - 2], route[route.length - 1], hashArray(route)] : null,
      cur ? [cur.gx, cur.gy, cur.radius] : null,
    ]);
    if (ribbonKey !== this.ribbonKey) {
      this.ribbonKey = ribbonKey;
      const rb = new RibbonBuilder(s.terrain.cellSize);
      let ringCount = 0;
      if (cur && cur.radius > 0) {
        rb.addPolyline(circlePolyline(cur.gx, cur.gy, cur.radius, s.stride), {
          halfWidth: s.terrain.cellSize * 0.18,
          kind: RibbonKind.Ring,
          id: 0,
          maxSeg: s.stride,
          closed: true,
        });
        ringCount = rb.indices.length;
      }
      if (route && route.length >= 4) {
        rb.addPolyline(route, { halfWidth: Math.max(9, s.terrain.cellSize * 1.4), kind: RibbonKind.Route, id: 0, maxSeg: s.stride });
      }
      this.ringIndexCount = ringCount;
      this.routeIndexStart = ringCount;
      this.routeIndexCount = rb.indices.length - ringCount;
      this.dynRibbons.write(rb.verts.view(), rb.vertexCount);
      this.dynRibbonIdx.write(rb.indices.view(), rb.indices.length);
    }
  }

  private uploadMarkers(b: MarkerBuilder, v: DynBuffer, i: DynBuffer): void {
    v.write(b.verts.view(), b.vertexCount);
    i.write(b.indices.view(), b.indices.length);
  }

  // ── Frame ────────────────────────────────────────────────────────────────────────────────

  resize(): void {
    this.needsResize = true;
  }

  // ── Quality ──────────────────────────────────────────────────────────────────────────────

  get quality(): RendererQuality {
    return this.qualityMode;
  }

  setFrameIntervalFloor(ms: number): void {
    this.adaptive.floorMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
  }

  setSimPressure(pressure: SimPressure): void {
    this.adaptive.simPressure = pressure;
  }

  setProtectedMask(mask: Uint8Array | null): void {
    const s = this.scene;
    if (!s || this.destroyed) return;
    if (!mask || mask.length < s.nx * s.ny) {
      if (s.protectOn) this.editEpoch++;
      s.protectOn = false;
      return;
    }
    this.device.queue.writeTexture({ texture: s.protectTex }, mask, { bytesPerRow: s.nx }, { width: s.nx, height: s.ny });
    s.protectOn = true;
    this.editEpoch++;
  }

  get lighting(): Readonly<LightingSettings> {
    return this.lightingSettings;
  }

  setLighting(opts: { preset?: string } & Partial<LightingSettings>): void {
    const base = opts.preset !== undefined ? lightingPreset(opts.preset) : { ...this.lightingSettings };
    const pick = (v: number | undefined, fallback: number, lo: number, hi: number) =>
      clamp(Number.isFinite(v) ? (v as number) : fallback, lo, hi);
    const next: LightingSettings = {
      // Azimuth wraps; everything else is a strength or an angle above the horizon.
      azimuthDeg: ((pick(opts.azimuthDeg, base.azimuthDeg, -1e6, 1e6) % 360) + 360) % 360,
      elevationDeg: pick(opts.elevationDeg, base.elevationDeg, -5, 89),
      shadowStrength: pick(opts.shadowStrength, base.shadowStrength, 0, 1),
      aoStrength: pick(opts.aoStrength, base.aoStrength, 0, 1),
      reliefStrength: pick(opts.reliefStrength, base.reliefStrength, 0, 1),
    };
    const key = `${next.azimuthDeg}|${next.elevationDeg}|${next.shadowStrength}|${next.aoStrength}|${next.reliefStrength}`;
    if (key === this.lightingKey) return;
    this.lightingKey = key;
    this.lightingSettings = next;
    // The raster is a function of the terrain and the sun, so moving the sun invalidates all of it.
    if (this.scene) this.scene.sunDirty = 'all';
  }

  setQuality(quality: RendererQuality): void {
    if (!(quality in QUALITY_PRESETS) && quality !== 'auto') return;
    if (quality === this.qualityMode) return;
    this.qualityMode = quality;
    this.adaptive.reset();
    this.needsResize = true;
  }

  private preset(): QualityPreset {
    return this.qualityMode === 'auto' ? this.adaptive.preset : QUALITY_PRESETS[this.qualityMode];
  }

  private ensureTargets(preset: QualityPreset): void {
    const canvas = this.canvas;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    const cssW = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const cssH = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const [w, h] = targetSize(cssW, cssH, dpr, preset.maxDpr, preset.maxPixels, this.device.limits.maxTextureDimension2D);
    this.stats.renderScale = Math.sqrt((w * h) / Math.max(1, cssW * cssH));
    this.stats.autoLevel = this.qualityMode === 'auto' ? this.adaptive.level : -1;
    if (w === this.width && h === this.height && this.msaaColor) {
      this.needsResize = false;
      return;
    }
    this.width = w;
    this.height = h;
    this.stats.width = w;
    this.stats.height = h;
    canvas.width = w;
    canvas.height = h;
    this.msaaColor?.destroy();
    this.msaaDepth?.destroy();
    this.hdr?.destroy();
    this.bloomA?.destroy();
    this.bloomB?.destroy();
    const d = this.device;
    const RA = GPUTextureUsage.RENDER_ATTACHMENT;
    this.msaaColor = d.createTexture({ label: 'msaa-color', size: [w, h], format: HDR_FORMAT, sampleCount: MSAA, usage: RA });
    this.msaaDepth = d.createTexture({ label: 'msaa-depth', size: [w, h], format: DEPTH_FORMAT, sampleCount: MSAA, usage: RA });
    this.hdr = d.createTexture({ label: 'hdr', size: [w, h], format: HDR_FORMAT, usage: RA | GPUTextureUsage.TEXTURE_BINDING });
    const bw = Math.max(1, Math.floor(w / 4));
    const bh = Math.max(1, Math.floor(h / 4));
    this.bloomA = d.createTexture({ label: 'bloomA', size: [bw, bh], format: HDR_FORMAT, usage: RA | GPUTextureUsage.TEXTURE_BINDING });
    this.bloomB = d.createTexture({ label: 'bloomB', size: [bw, bh], format: HDR_FORMAT, usage: RA | GPUTextureUsage.TEXTURE_BINDING });
    const bloomBG = (src: GPUTexture, buf: GPUBuffer) =>
      d.createBindGroup({
        layout: this.P.bloom.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buf } },
          { binding: 1, resource: src.createView() },
          { binding: 2, resource: this.linClamp },
        ],
      });
    this.bloomBGs = [bloomBG(this.hdr, this.bloomBufs[0]), bloomBG(this.bloomA, this.bloomBufs[1]), bloomBG(this.bloomB, this.bloomBufs[2])];
    this.device.queue.writeBuffer(this.bloomBufs[0], 0, new Float32Array([0, 0, 2.2, 0]));
    this.device.queue.writeBuffer(this.bloomBufs[1], 0, new Float32Array([1, 0, 0, 1]));
    this.device.queue.writeBuffer(this.bloomBufs[2], 0, new Float32Array([0, 1, 0, 1]));
    this.tonemapBG = d.createBindGroup({
      layout: this.P.tonemap.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.postBuf } },
        { binding: 1, resource: this.hdr.createView() },
        { binding: 2, resource: this.bloomA.createView() },
        { binding: 3, resource: this.linClamp },
      ],
    });
    this.needsResize = false;
  }

  private prepBindGroups(s: SceneGPU) {
    const solver = s.solver;
    const state = solver.stateTexture;
    const bed = solver.bedTexture;
    const barrier = solver.barrierTexture;
    const cached = s.prepCache.get(state);
    if (cached && cached.bed === bed && cached.barrier === barrier) return cached;
    if (s.prepCache.size >= 4) s.prepCache.clear();
    const d = this.device;
    const common = [
      { binding: 0, resource: { buffer: s.prepParams } },
      { binding: 1, resource: bed.createView() },
      { binding: 2, resource: barrier.createView() },
      { binding: 3, resource: state.createView() },
    ];
    const cells = d.createBindGroup({
      label: 'prep-cells',
      layout: this.P.prepCells.getBindGroupLayout(0),
      entries: [
        ...common,
        { binding: 4, resource: s.surfTex.createView() },
        { binding: 5, resource: s.normTex.createView() },
        { binding: 6, resource: s.miscTex.createView() },
        { binding: 7, resource: s.cellTex.createView() },
      ],
    });
    const entry = { bed, barrier, cells };
    s.prepCache.set(state, entry);
    return entry;
  }

  /** Bind group of the per-vertex bed pass for the solver's current bed / barrier textures. */
  private vtxBedBindGroup(s: SceneGPU): GPUBindGroup {
    const { bedTexture: bed, barrierTexture: barrier } = s.solver;
    if (s.vtxBedBG && s.vtxBedBG.bed === bed && s.vtxBedBG.barrier === barrier) return s.vtxBedBG.bg;
    const bg = this.device.createBindGroup({
      label: 'prep-vtxbed',
      layout: this.P.prepVtxBed.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: s.prepParams } },
        { binding: 1, resource: bed.createView() },
        { binding: 2, resource: barrier.createView() },
        { binding: 4, resource: s.vtxBedTex.createView() },
      ],
    });
    s.vtxBedBG = { bed, barrier, bg };
    return bg;
  }

  /**
   * Everything that can change the image apart from the animation clock. When it is unchanged the frame is
   * "idle" and may be skipped by the idle frame-rate cap.
   */
  private frameSignature(settings: RenderSettings): string {
    const p = this.camera.pose;
    const s = this.scene;
    return [
      p.target.gx,
      p.target.gy,
      p.target.elevation,
      p.distance,
      p.yaw,
      p.pitch,
      settings.waterMode,
      settings.verticalExaggeration,
      settings.showImagery,
      settings.showRoads,
      settings.showContours,
      settings.rainRate > 0.2,
      this.overlayVersion,
      this.editEpoch,
      this.lightingKey,
      // While the protected-land glow fades in or out, every frame differs.
      this.protectFade > 0 && this.protectFade < 1 ? this.protectFade : s?.protectOn ? 1 : 0,
      s ? this.stateKey(s.solver) : 0,
      this.canvas.clientWidth,
      this.canvas.clientHeight,
      this.needsResize,
    ].join('|');
  }

  /**
   * Identifies the solver's current water state without reading stateTexture when the solver offers a version
   * counter (GpuFloodSolver exports lazily on read, so reading it every frame would export every frame).
   */
  private stateKey(solver: FloodSolver): number {
    const v = (solver as FloodSolver & { stateVersion?: number }).stateVersion;
    return typeof v === 'number' ? v : this.textureId(solver.stateTexture);
  }

  private textureIds = new WeakMap<GPUTexture, number>();
  private nextTextureId = 1;
  /** Stable small integer per texture object (identity → string key). */
  private textureId(t: GPUTexture): number {
    let id = this.textureIds.get(t);
    if (id === undefined) {
      id = this.nextTextureId++;
      this.textureIds.set(t, id);
    }
    return id;
  }

  render(settings: RenderSettings): void {
    if (this.destroyed) return;
    const cpuStart = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const now = cpuStart;
    const dt = this.lastFrameMs ? (now - this.lastFrameMs) / 1000 : 1 / 60;
    this.frameDt = Math.min(0.1, Math.max(0, dt));
    this.lastFrameMs = now;
    this.frameCounter++;

    const exag = clamp(Number.isFinite(settings.verticalExaggeration) ? settings.verticalExaggeration : 1.5, 0.1, 20);
    if (exag !== this.exaggeration) {
      this.exaggeration = exag;
      this.camera.setEnvironment(this.cameraEnv());
    }
    this.camera.update(dt);

    // Terrain / wall edits are looked for on every call (≈0.2 ms), including frames the idle cap then skips: a
    // detected edit changes the frame signature, so the next call draws it.
    if (this.scene) this.watchEdits(this.scene);

    // Idle frame cap: when nothing but the clock changed (camera still, same solver state, same overlays and
    // settings, no rain), draw at most `idleFps` — saves GPU/thermal budget on fanless laptops.
    let preset = this.preset();
    const signature = this.frameSignature(settings);
    const idle = signature === this.lastSignature;
    this.lastSignature = signature;
    if (idle && preset.idleFps < 60 && now - this.lastDrawAt < 1000 / preset.idleFps - 2) {
      this.stats.framesSkipped++;
      this.prevRenderCallDrew = false;
      return;
    }

    // Adaptive resolution (only from consecutive drawn frames, so idle-capped intervals don't count).
    if (this.prevRenderCallDrew && this.qualityMode === 'auto') {
      const interval = now - this.lastDrawAt;
      if (this.adaptive.sample(interval, now, this.timer.enabled ? this.timer.totalMs : undefined)) preset = this.preset();
    }
    this.prevRenderCallDrew = true;
    this.lastDrawAt = now;

    this.ensureTargets(preset);

    const s = this.scene;
    if (s) {
      s.lod.refreshSome();
      const [lo, hi] = s.lod.range;
      s.hf.minElev = lo;
      s.hf.maxElev = hi;
    }

    const matrices = this.writeFrameUniforms(settings);
    if (s) {
      this.syncOverlays();
      const snap = s.solver.getSnapshot();
      const maxDepth = snap && Number.isFinite(snap.stats.maxDepth) ? snap.stats.maxDepth : 30;
      // LOD error is measured against a ~1100 px-tall reference so Retina resolutions don't multiply geometry.
      const pixelAngle = (2 * Math.tan(matrices.fovY / 2)) / Math.min(1100, Math.max(1, this.height));
      const sel = s.lod.select(matrices.eye, frustumPlanes(matrices.viewProj), pixelAngle, preset.lodQuadPixels, this.exaggeration, 3, Math.min(maxDepth, 200) + 12);
      this.nodeBuf.write(sel.instances, sel.count);
      this.nodeCount = sel.count;
      this.lodStats = { nodes: sel.count, perLevel: sel.perLevel };
    }

    const d = this.device;
    const enc = d.createCommandEncoder({ label: 'frame' });
    this.timer.beginFrame();

    if (s) {
      const mode = WATER_MODE_INDEX[settings.waterMode] ?? 0;
      const useMax = mode === 2 ? 1 : 0;
      const key = this.stateKey(s.solver);
      this.framesSincePrep++;
      // Derived textures only change when the solver state (or the displayed field) changes. The real solver
      // bumps its state version after every step and brush edit; a periodic refresh covers solvers that edit bed
      // textures in place. stateTexture is only read when a rebuild is due (reading it makes the solver export).
      const changed = key !== this.lastPrepKey || useMax !== this.lastPrepUseMax;
      const due =
        this.forcePrep ||
        (changed ? this.framesSincePrep >= preset.prepInterval || useMax !== this.lastPrepUseMax : this.framesSincePrep >= 30);
      if (due && !this.debugSkip.has('prep')) {
        const editPrep = this.forcePrep || !changed;
        this.forcePrep = false;
        this.framesSincePrep = 0;
        this.lastPrepKey = key;
        this.lastPrepUseMax = useMax;
        const prep = new ArrayBuffer(48);
        const pi = new Int32Array(prep);
        const pf = new Float32Array(prep);
        pi[0] = s.nx;
        pi[1] = s.ny;
        pi[2] = s.vx;
        pi[3] = s.vy;
        pi[4] = s.stride;
        pi[5] = useMax;
        pf[6] = 0.01;
        pf[7] = s.terrain.cellSize;
        pf[8] = 0.05;
        // The previous wet pyramid is a valid hint only if it was built from the same displayed field.
        pf[9] = s.wetValid && this.lastPrepUseMaxBuilt === useMax ? 1 : 0;
        s.wetValid = true;
        this.lastPrepUseMaxBuilt = useMax;
        d.queue.writeBuffer(s.prepParams, 0, prep);
        const bgs = this.prepBindGroups(s);
        // The vertex bed only changes with the terrain: rebuilt when the solver's terrain version moves (every time
        // for solvers without one), and on detected edits.
        const tv = (s.solver as FloodSolver & { terrainVersion?: number }).terrainVersion;
        const terrainKey = typeof tv === 'number' ? tv : -2;
        const rebuildBed = terrainKey !== s.terrainKey || terrainKey === -2 || editPrep;
        s.terrainKey = terrainKey;
        const cp = enc.beginComputePass({ label: 'prep', timestampWrites: this.timer.writes('prep') });
        if (rebuildBed) {
          cp.setPipeline(this.P.prepVtxBed);
          cp.setBindGroup(0, this.vtxBedBindGroup(s));
          cp.dispatchWorkgroups(Math.ceil(s.vx / 16), Math.ceil(s.vy / 16));
        }
        cp.setPipeline(this.P.prepCells);
        cp.setBindGroup(0, bgs.cells);
        cp.dispatchWorkgroups(Math.ceil(s.nx / 16), Math.ceil(s.ny / 16));
        cp.setPipeline(this.P.prepVerts);
        cp.setBindGroup(0, s.vertsBG);
        cp.dispatchWorkgroups(Math.ceil(s.vx / 16), Math.ceil(s.vy / 16));
        cp.setPipeline(this.P.wetBase);
        cp.setBindGroup(0, s.wetBGs[0]);
        cp.dispatchWorkgroups(Math.ceil(s.wetTex.width / 16), Math.ceil(s.wetTex.height / 16));
        cp.setPipeline(this.P.wetDown);
        for (let lv = 1; lv < s.wetBGs.length; lv++) {
          cp.setBindGroup(0, s.wetBGs[lv]);
          cp.dispatchWorkgroups(Math.ceil(Math.max(1, s.wetTex.width >> lv) / 8), Math.ceil(Math.max(1, s.wetTex.height >> lv) / 8));
        }
        cp.end();
      }
    }

    // Sun shading (src/render/shadows.ts): cast shadows and sky occlusion over the DEM. Built once when a scene
    // loads and afterwards only over what an edit changed, so a frame that touches nothing encodes nothing here.
    let fullShadowBuild = false;
    if (s && !this.debugSkip.has('shadows') && this.sunShadowsBuiltAt !== preset.shadows) {
      // A different tier wants a differently-solved raster, and the old one is not a subset of the new one.
      s.sunDirty = 'all';
    }
    if (s && s.sunDirty && !this.debugSkip.has('shadows')) {
      const want = preset.shadows;
      const q = SHADOW_QUALITY[want];
      const dir = sunDirection(this.lightingSettings.azimuthDeg, this.lightingSettings.elevationDeg);
      let rects: { height: CellRect; vis: CellRect } | undefined;
      if (s.sunDirty !== 'all') {
        const rect = s.sunDirty;
        const horiz = Math.hypot(dir[0], dir[2]);
        // Nothing a brush can build or dig is more than a few tens of metres tall, and that is all that bounds how
        // far the change can throw a shadow.
        const reach = shadowReachCells(EDIT_RELIEF_M, dir[1], horiz, s.terrain.cellSize, SHADOW_EDIT_MAX_CELLS);
        rects = {
          height: { x0: Math.max(0, rect.x0), y0: Math.max(0, rect.y0), x1: Math.min(s.nx, rect.x1), y1: Math.min(s.ny, rect.y1) },
          vis: expandForShadow(rect, [dir[0] / (horiz || 1), dir[2] / (horiz || 1)], reach, q.aoRadius + 2, s.nx, s.ny),
        };
      } else {
        fullShadowBuild = true;
      }
      s.sun.build(enc, s.solver.bedTexture, s.solver.barrierTexture, { dir }, q, rects);
      this.sunShadowsBuiltAt = want;
      s.sunDirty = null;
      this.stats.shadowCells = s.sun.lastCells;
    }

    const pass = enc.beginRenderPass({
      label: 'main',
      colorAttachments: [
        { view: this.msaaColor!.createView(), resolveTarget: this.hdr!.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] },
      ],
      depthStencilAttachment: { view: this.msaaDepth!.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
      timestampWrites: this.timer.writes('main'),
    });
    if (!s && !this.debugSkip.has('sky')) {
      pass.setPipeline(this.P.sky);
      pass.setBindGroup(0, this.skyBG);
      pass.draw(3);
    }

    if (s && this.mesh) {
      const m = this.mesh;
      pass.setBindGroup(0, s.terrainBG);
      if (this.nodeCount > 0 && this.nodeBuf.buffer) {
        pass.setVertexBuffer(0, this.nodeBuf.buffer);
        pass.setIndexBuffer(this.patchIndex, 'uint16');
        pass.setPipeline(this.P.terrain);
        if (!this.debugSkip.has('terrain')) pass.drawIndexed(this.patchIndexCount, this.nodeCount);
      }
      pass.setIndexBuffer(m.skirt, 'uint32');
      pass.setPipeline(this.P.skirt);
      pass.drawIndexed(m.skirtCount);

      pass.setBindGroup(0, s.overlayBG);
      if (this.markerOpaqueI.count > 0 && this.markerOpaqueV.buffer && this.markerOpaqueI.buffer) {
        pass.setPipeline(this.P.markersOpaque);
        pass.setVertexBuffer(0, this.markerOpaqueV.buffer);
        pass.setIndexBuffer(this.markerOpaqueI.buffer, 'uint32');
        pass.drawIndexed(this.markerOpaqueI.count);
      }

      if (!this.debugSkip.has('sky')) {
        pass.setPipeline(this.P.sky);
        pass.setBindGroup(0, this.skyBG);
        pass.draw(3);
      }

      pass.setBindGroup(0, s.waterBG);
      if (this.nodeCount > 0 && this.nodeBuf.buffer) {
        pass.setVertexBuffer(0, this.nodeBuf.buffer);
        pass.setIndexBuffer(this.patchIndex, 'uint16');
        pass.setPipeline(this.P.water);
        if (!this.debugSkip.has('water')) pass.drawIndexed(this.patchIndexCount, this.nodeCount);
      }
      pass.setIndexBuffer(m.skirt, 'uint32');
      pass.setPipeline(this.P.waterSkirt);
      pass.drawIndexed(m.skirtCount);

      pass.setBindGroup(0, s.overlayBG);
      pass.setPipeline(this.P.ribbons);
      if (!this.debugSkip.has('roads') && settings.showRoads && s.roadVerts && s.roadIndices && s.roadIndexCount > 0) {
        pass.setVertexBuffer(0, s.roadVerts);
        pass.setIndexBuffer(s.roadIndices, 'uint32');
        pass.drawIndexed(s.roadIndexCount);
      }
      if (this.dynRibbonIdx.count > 0 && this.dynRibbons.buffer && this.dynRibbonIdx.buffer) {
        pass.setVertexBuffer(0, this.dynRibbons.buffer);
        pass.setIndexBuffer(this.dynRibbonIdx.buffer, 'uint32');
        if (this.routeIndexCount > 0) pass.drawIndexed(this.routeIndexCount, 1, this.routeIndexStart);
        if (this.ringIndexCount > 0) pass.drawIndexed(this.ringIndexCount, 1, 0);
      }
      if (this.markerBlendI.count > 0 && this.markerBlendV.buffer && this.markerBlendI.buffer) {
        pass.setPipeline(this.P.markersBlend);
        pass.setVertexBuffer(0, this.markerBlendV.buffer);
        pass.setIndexBuffer(this.markerBlendI.buffer, 'uint32');
        pass.drawIndexed(this.markerBlendI.count);
      }
    }

    const drops = rainDropCount(settings.rainRate, preset.rainDrops);
    if (drops > 0) {
      pass.setPipeline(this.P.rain);
      pass.setBindGroup(0, this.rainBG);
      pass.draw(4, drops);
    }
    pass.end();

    // Bloom: bright-pass ¼-res downsample, then horizontal + vertical blur.
    if (preset.bloom && !this.debugSkip.has('bloom')) {
      const bloomPass = (target: GPUTexture, bg: GPUBindGroup, timed: boolean) => {
        const p = enc.beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          timestampWrites: timed ? this.timer.writes('post') : undefined,
        });
        p.setPipeline(this.P.bloom);
        p.setBindGroup(0, bg);
        p.draw(3);
        p.end();
      };
      bloomPass(this.bloomA!, this.bloomBGs[0], false);
      bloomPass(this.bloomB!, this.bloomBGs[1], false);
      bloomPass(this.bloomA!, this.bloomBGs[2], false);
    }

    const srgbOut = this.format.endsWith('-srgb') ? 0 : 1;
    d.queue.writeBuffer(this.postBuf, 0, new Float32Array([this.exposure(), srgbOut, 0.3, preset.bloom ? 1 : 0]));
    const tp = enc.beginRenderPass({
      label: 'tonemap',
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
      timestampWrites: this.timer.writes('post'),
    });
    tp.setPipeline(this.P.tonemap);
    tp.setBindGroup(0, this.tonemapBG!);
    tp.draw(3);
    tp.end();

    const timed = this.timer.resolve(enc);
    const shadowStart = fullShadowBuild ? (typeof performance !== 'undefined' ? performance.now() : Date.now()) : 0;
    d.queue.submit([enc.finish()]);
    if (timed) this.timer.collect();
    if (fullShadowBuild) {
      // Upper bound: the whole frame's queue has to drain, not just the build. Precise per-pass numbers come from
      // tests/render/shadows.test.ts, which submits the build on its own.
      void d.queue
        .onSubmittedWorkDone()
        .then(() => {
          this.stats.shadowBuildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - shadowStart;
        })
        .catch(() => {});
    }

    const st = this.stats;
    st.framesDrawn++;
    st.prepMs = this.timer.ms.prep;
    st.mainMs = this.timer.ms.main;
    st.postMs = this.timer.ms.post;
    st.gpuMs = this.timer.totalMs;
    const cpu = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - cpuStart;
    st.cpuMs += (cpu - st.cpuMs) * 0.1;
  }

  private writeFrameUniforms(settings: RenderSettings): CameraMatrices {
    const f = this.frameData;
    const s = this.scene;
    const preset = this.preset();
    const cssW = Math.max(1, this.canvas.clientWidth || this.width);
    const cssH = Math.max(1, this.canvas.clientHeight || this.height);
    this.camera.aspect = cssW / cssH;
    const m = this.camera.matrices(cssW / cssH);
    f.set(m.viewProj, 0);
    f.set(m.invViewProj, 16);
    f[32] = m.eye[0];
    f[33] = m.eye[1];
    f[34] = m.eye[2];
    f[35] = Number.isFinite(settings.time) ? settings.time % 100000 : 0;

    const rain = Math.max(0, settings.rainRate || 0);
    const overcast = this.computeOvercast(rain, m.eye[1]);
    this.overcast = overcast;
    // Where the sun is, and what colour the air makes it and the sky (src/render/atmosphere.ts). The default is a
    // late-morning sun from the south-south-east, 40° high: consistent with the shadows baked into typical
    // (mid-morning) USGS imagery, so the cast shadows land where the photograph's own shadows already are.
    const light = this.lightingSettings;
    const dir = sunDirection(light.azimuthDeg, light.elevationDeg);
    const sky = skyColors(light.elevationDeg);
    f[36] = dir[0];
    f[37] = dir[1];
    f[38] = dir[2];
    f[39] = this.exaggeration;
    f[40] = sky.sun[0];
    f[41] = sky.sun[1];
    f[42] = sky.sun[2];
    f[43] = s?.terrain.cellSize ?? 8;
    f[44] = sky.zenith[0];
    f[45] = sky.zenith[1];
    f[46] = sky.zenith[2];
    f[47] = rain;
    f[48] = sky.horizon[0];
    f[49] = sky.horizon[1];
    f[50] = sky.horizon[2];
    const domain = s ? Math.max(s.nx, s.ny) * s.terrain.cellSize : 8000;
    f[51] = (1 / (domain * 2.6)) * hazeBoost(overcast);
    f[52] = s?.nx ?? 1;
    f[53] = s?.ny ?? 1;
    f[54] = s?.vx ?? 2;
    f[55] = s?.vy ?? 2;
    f[56] = this.width;
    f[57] = this.height;
    f[58] = s?.stride ?? 1;
    f[59] = WATER_MODE_INDEX[settings.waterMode] ?? 0;
    const gMin = s?.groundMin ?? 0;
    const gMax = s?.groundMax ?? 1;
    f[60] = gMin;
    f[61] = gMax;
    f[62] = gMin - Math.max(20, (gMax - gMin) * 0.25);
    f[63] = (2 * Math.tan(m.fovY / 2)) / cssH;
    f[64] = settings.showImagery && s?.hasImagery ? 1 : 0;
    f[65] = settings.showContours ? 1 : 0;
    f[66] = s?.contourInterval ?? 10;
    f[67] = overcast;
    f[68] = m.forward[0];
    f[69] = m.forward[1];
    f[70] = m.forward[2];
    f[71] = m.near;
    const bands = bandsForMode(settings.waterMode) ?? [];
    f[72] = Math.max(1, Math.min(8, bands.length));
    f[73] = domain;
    f[74] = clamp(this.camera.pose.distance / 250, 3, 40);
    // Rain particles live in a camera-centred box that scales with zoom so rain reads at every distance.
    f[75] = clamp(this.camera.pose.distance * 0.1, 30, 1200);
    f[76] = s?.wallField.anyWall ? 1 : 0;
    f[77] = WALL_FIELD_RADIUS + 1;
    f[78] = s?.groundMin ?? 0;
    f[79] = s?.normalWetValid ? 1 : 0;
    const hdr = this.hazardInputs(settings.waterMode, bands);
    for (let i = 0; i < 8; i++) {
      const k = Math.min(i, Math.max(0, bands.length - 1));
      const b = bands[k];
      f[80 + i * 4] = hdr[k * 3] ?? 0;
      f[81 + i * 4] = hdr[k * 3 + 1] ?? 0;
      f[82 + i * 4] = hdr[k * 3 + 2] ?? 0;
      f[83 + i * 4] = b && Number.isFinite(b.max) ? b.max : 1e9;
    }
    // Protected-land glow fades in over ~0.6 s when walls start keeping land dry, and out when they stop.
    const protectTarget = s?.protectOn ? 1 : 0;
    this.protectFade = protectTarget > this.protectFade ? Math.min(1, this.protectFade + this.frameDt / 0.6) : Math.max(0, this.protectFade - this.frameDt / 0.3);
    f[112] = s?.protectOn || this.protectFade > 0 ? this.protectFade : 0;
    f[113] = 0;
    f[114] = 0;
    f[115] = 0;
    // Sky and shading. skyWarmth is the single number the low-sun look hangs off: the warm horizon band, the wider
    // sun aureole, the lit cloud bases and the warm ground bounce all scale with it, so they can never disagree.
    const warmth = sunLowness(light.elevationDeg);
    f[116] = sky.sunTint[0];
    f[117] = sky.sunTint[1];
    f[118] = sky.sunTint[2];
    f[119] = warmth;
    f[120] = light.shadowStrength;
    f[121] = light.aoStrength;
    f[122] = light.reliefStrength;
    f[123] = s?.sun.valid && !this.debugSkip.has('shadows') ? 1 : 0;
    f[124] = preset.shadowFilterCells;
    f[125] = this.debugSkip.has('detail') ? 0 : preset.detailNormals;
    f[126] = warmth;
    f[127] = imageryRelightFactor(light.elevationDeg);
    this.device.queue.writeBuffer(this.frameBuf, 0, f);

    // Overlay uniforms.
    const o = this.overlays;
    const ov = new Float32Array(OVERLAY_UNIFORM_SIZE / 4);
    const cc = o?.cursor?.color ?? [1, 1, 1];
    ov.set([cc[0], cc[1], cc[2], 0.95], 0);
    const blocked = o?.routeState === 'blocked';
    ov.set(blocked ? [1.8, 0.1, 0.06, 1] : [0.1, 0.85, 1.5, 0], 4);
    ov[8] = Math.max(25, this.camera.pose.distance * 0.035);
    ov[9] = o?.routeState === 'ok' ? 1 : blocked ? 2 : 0;
    ov[10] = settings.showImagery ? 0.7 : 0.85;
    ov[11] = s?.roadStatusCopy ? 1 : 0;
    ov[12] = WATER_MODE_INDEX[settings.waterMode] ?? 0;
    ov[13] = o?.evacStart ? 1 : 0;
    this.device.queue.writeBuffer(this.overlayBuf, 0, ov);
    return m;
  }

  /**
   * Sky overcast from the rain the viewer is in. Global rain greys the whole sky. A storm cell over the camera target
   * does too when the camera is under its cloud base; from an aerial view above the deck the cell is a local weather
   * feature (its deck and rain shaft mark it) and only tints the sky a little, so the flooding under it stays readable.
   */
  private computeOvercast(rain: number, eyeY: number): number {
    const s = this.scene;
    const t = this.camera.pose.target;
    let stormRain = 0;
    /** Thickest deck among the cells over the target (its marker's half-thickness, m). */
    let deckHalf = 0;
    for (const st of this.overlays?.storms ?? []) {
      const w = Math.max(0, st.intensity) * stormWeight(Math.hypot(t.gx - st.gx, t.gy - st.gy), footprintRadius(st.radius));
      stormRain += w;
      if (w > 0 && s) deckHalf = Math.max(deckHalf, cloudDeckHalfThickness(Math.max(1, st.radius) * s.terrain.cellSize * 0.85));
    }
    // settings.rainRate already includes the storms (and is 0 while paused).
    stormRain = Math.min(stormRain, rain);
    let deck: CloudDeck | null = null;
    if (s && stormRain > 0) {
      const domainSize = Math.max(s.nx, s.ny) * s.terrain.cellSize;
      const cloudY = stormCloudElevation({ minElev: s.groundMin, maxElev: s.groundMax, domainSize }) * this.exaggeration;
      // Under the deck below its base, above it over its top, in between inside it (see atmosphere.ts).
      deck = { base: cloudY - deckHalf, top: cloudY + deckHalf };
    }
    return overcastFor(rain - stormRain, stormRain, eyeY, deck);
  }

  private exposure(): number {
    // A low sun sends less light down; most of that is already handled where it belongs (imageryRelightFactor,
    // which keeps photo-textured ground at its reference illumination), so this is only the last touch of
    // adaptation. The hazard bands are solved against this same number (hazardInputs below), so the legend
    // colours stay exact whatever the lighting does.
    const low = 1 + sunLowness(this.lightingSettings.elevationDeg) * 0.3;
    return BASE_EXPOSURE * (1 + (this.overcast / OVERCAST_MAX) * 0.35) * low;
  }

  /** HDR shader inputs (rgb per band) whose tone-mapped colours are the legend colours at this frame's exposure. */
  private hazardInputs(mode: string, bands: ReadonlyArray<{ color: string }>): number[] {
    if (bands.length === 0) return [];
    const exposure = Math.round(this.exposure() * 200) / 200;
    const key = `${mode}|${exposure}`;
    let out = this.hazardCache.get(key);
    if (!out) {
      out = [];
      for (const b of bands) out.push(...hazardInput(cssToLinear(b.color), exposure));
      if (this.hazardCache.size > 64) this.hazardCache.clear();
      this.hazardCache.set(key, out);
    }
    return out;
  }

  // ── Picking ──────────────────────────────────────────────────────────────────────────────

  pick(cssX: number, cssY: number): PickResult | null {
    const s = this.scene;
    if (!s || this.destroyed) return null;
    const cssW = Math.max(1, this.canvas.clientWidth || this.width);
    const cssH = Math.max(1, this.canvas.clientHeight || this.height);
    const m = this.camera.matrices(cssW / cssH);
    const ray = cameraRay(m, cssX, cssY, cssW, cssH);
    return pickTerrain(ray, s.hf, this.exaggeration, s.solver.getSnapshot());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.camera.detach();
    this.resizeObserver?.disconnect();
    this.disposeScene();
    this.mesh?.skirt.destroy();
    this.mesh = null;
    this.patchIndex.destroy();
    this.nodeBuf.destroy();
    for (const t of [this.msaaColor, this.msaaDepth, this.hdr, this.bloomA, this.bloomB, this.rippleTex, this.dummyImagery]) t?.destroy();
    for (const b of [this.frameBuf, this.overlayBuf, this.postBuf, ...this.bloomBufs]) b.destroy();
    for (const b of [this.dynRibbons, this.dynRibbonIdx, this.markerOpaqueV, this.markerOpaqueI, this.markerBlendV, this.markerBlendI]) b.destroy();
    this.timer.destroy();
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/** Triangle indices of one (LOD_PATCH+1)² vertex patch, split along the (k+1,l)–(k,l+1) diagonal like heightAt. */
function createPatchIndex(device: GPUDevice): GPUBuffer {
  const side = LOD_PATCH + 1;
  const count = LOD_PATCH * LOD_PATCH * 6;
  const buf = device.createBuffer({ label: 'lod-patch-idx', size: Math.ceil((count * 2) / 4) * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
  const I = new Uint16Array(buf.getMappedRange(), 0, count);
  let o = 0;
  for (let l = 0; l < LOD_PATCH; l++) {
    for (let k = 0; k < LOD_PATCH; k++) {
      const a = l * side + k;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      I[o++] = a;
      I[o++] = c;
      I[o++] = b;
      I[o++] = b;
      I[o++] = c;
      I[o++] = d;
    }
  }
  buf.unmap();
  return buf;
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function rainDropCount(rate: number, maxDrops: number): number {
  if (!(rate > 0.2)) return 0;
  return Math.round(maxDrops * clamp(Math.log1p(rate) / Math.log1p(120), 0.04, 1));
}

function hashArray(a: Float32Array): number {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(a.length / 64));
  for (let i = 0; i < a.length; i += step) {
    h ^= Math.round(a[i] * 1000);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
