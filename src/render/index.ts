/**
 * Deluge WebGPU renderer (DESIGN.md §5).
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
import { OrbitController, type CameraEnvironment } from './camera';
import { HeightField, meshStride } from './heightfield';
import { bandsForMode, cssToLinear } from './legend';
import { buildMarkers, buildRoadRibbons, buildWallGhost, circlePolyline, MarkerBuilder, RibbonBuilder, RibbonKind } from './overlays';
import { pickTerrain, screenRay } from './picking';
import { createPipelines, DEPTH_FORMAT, HDR_FORMAT, MSAA, type Pipelines } from './pipelines';
import { FRAME_UNIFORM_SIZE } from './shaders/common';
import { OVERLAY_UNIFORM_SIZE } from './shaders/overlay';
import { createImageryTexture, createRippleTexture, createSolidTexture } from './textures';
import { clamp, smoothstep } from './math';

export { DEPTH_BANDS, MAX_DEPTH_BANDS, VELOCITY_BANDS, bandsForMode } from './legend';
export { OrbitController } from './camera';

const WATER_MODE_INDEX = { realistic: 0, depth: 1, maxDepth: 2, velocity: 3 } as const;
/** Upper bound on rendered pixels (≈ 2560×1600) so Retina displays stay fast. */
const MAX_RENDER_PIXELS = 2560 * 1600;
const MAX_RAIN_DROPS = 14000;

export async function createRenderer(device: GPUDevice, canvas: HTMLCanvasElement, format: GPUTextureFormat): Promise<FloodRenderer> {
  const pipelines = await createPipelines(device, format);
  return new DelugeRenderer(device, canvas, format, pipelines);
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
  prepCache: Map<GPUTexture, { bed: GPUTexture; barrier: GPUTexture; cells: GPUBindGroup; verts: GPUBindGroup }>;
  roadVerts: GPUBuffer | null;
  roadIndices: GPUBuffer | null;
  roadIndexCount: number;
  roadStatus: GPUBuffer;
  roadStatusCopy: Uint8Array | null;
  contourInterval: number;
}

interface MeshBuffers {
  vx: number;
  vy: number;
  index: GPUBuffer;
  indexCount: number;
  skirt: GPUBuffer;
  skirtCount: number;
}

class DelugeRenderer implements FloodRenderer {
  readonly camera: OrbitController;

  private ctx: GPUCanvasContext;
  private frameBuf: GPUBuffer;
  private frameData = new Float32Array(FRAME_UNIFORM_SIZE / 4);
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
  ) {
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
    const surfTex = tex('surf', nx, ny, 'rgba16float');
    const normTex = tex('norm', nx, ny, 'rgba16float');
    const miscTex = tex('misc', nx, ny, 'rgba16float');

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
      roadVerts,
      roadIndices,
      roadIndexCount,
      roadStatus,
      roadStatusCopy: null,
      contourInterval: niceStep(relief / 24),
    };
    this.markerKey = '';
    this.ribbonKey = '';
    this.camera.setEnvironment(this.cameraEnv());
  }

  private disposeScene(): void {
    const s = this.scene;
    if (!s) return;
    s.vtxTex.destroy();
    s.surfTex.destroy();
    s.normTex.destroy();
    s.miscTex.destroy();
    if (s.hasImagery) s.imageryTex.destroy();
    s.roadVerts?.destroy();
    s.roadIndices?.destroy();
    s.roadStatus.destroy();
    s.prepParams.destroy();
    s.prepCache.clear();
    this.scene = null;
  }

  /** Shared triangle index buffers for the (vx × vy) vertex grid and its edge skirt. */
  private ensureMesh(vx: number, vy: number): void {
    if (this.mesh && this.mesh.vx === vx && this.mesh.vy === vy) return;
    this.mesh?.index.destroy();
    this.mesh?.skirt.destroy();
    const quads = (vx - 1) * (vy - 1);
    const index = this.device.createBuffer({ label: 'grid-idx', size: quads * 6 * 4, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    const I = new Uint32Array(index.getMappedRange());
    let o = 0;
    for (let l = 0; l < vy - 1; l++) {
      const row = l * vx;
      const next = row + vx;
      for (let k = 0; k < vx - 1; k++) {
        const a = row + k;
        const b = a + 1;
        const c = next + k;
        const d = c + 1;
        // Split along the b–c diagonal (HeightField.heightAt mirrors this).
        I[o++] = a;
        I[o++] = c;
        I[o++] = b;
        I[o++] = b;
        I[o++] = c;
        I[o++] = d;
      }
    }
    index.unmap();

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
    this.mesh = { vx, vy, index, indexCount: quads * 6, skirt, skirtCount };
  }

  // ── Overlays ─────────────────────────────────────────────────────────────────────────────

  setOverlays(overlays: OverlayState): void {
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

  private ensureTargets(): void {
    const canvas = this.canvas;
    const dpr = Math.min(2, (typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1);
    const cssW = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const cssH = Math.max(1, canvas.clientHeight || canvas.height || 1);
    let w = Math.max(1, Math.round(cssW * dpr));
    let h = Math.max(1, Math.round(cssH * dpr));
    if (w * h > MAX_RENDER_PIXELS) {
      const s = Math.sqrt(MAX_RENDER_PIXELS / (w * h));
      w = Math.max(1, Math.floor(w * s));
      h = Math.max(1, Math.floor(h * s));
    }
    const maxDim = this.device.limits.maxTextureDimension2D;
    w = Math.min(w, maxDim);
    h = Math.min(h, maxDim);
    if (w === this.width && h === this.height && this.msaaColor) {
      this.needsResize = false;
      return;
    }
    this.width = w;
    this.height = h;
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
      ],
    });
    const verts = d.createBindGroup({
      label: 'prep-verts',
      layout: this.P.prepVerts.getBindGroupLayout(0),
      entries: [...common, { binding: 4, resource: s.vtxTex.createView() }],
    });
    const entry = { bed, barrier, cells, verts };
    s.prepCache.set(state, entry);
    return entry;
  }

  render(settings: RenderSettings): void {
    if (this.destroyed) return;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const dt = this.lastFrameMs ? (now - this.lastFrameMs) / 1000 : 1 / 60;
    this.lastFrameMs = now;
    this.frameCounter++;

    this.ensureTargets();
    const exag = clamp(Number.isFinite(settings.verticalExaggeration) ? settings.verticalExaggeration : 1.5, 0.1, 20);
    if (exag !== this.exaggeration) {
      this.exaggeration = exag;
      this.camera.setEnvironment(this.cameraEnv());
    }
    this.camera.update(dt);

    const s = this.scene;
    if (s && this.frameCounter % 45 === 0) s.hf.refreshRange();

    this.writeFrameUniforms(settings);
    if (s) this.syncOverlays();

    const d = this.device;
    const enc = d.createCommandEncoder({ label: 'frame' });

    if (s) {
      const mode = WATER_MODE_INDEX[settings.waterMode] ?? 0;
      const prep = new ArrayBuffer(48);
      const pi = new Int32Array(prep);
      const pf = new Float32Array(prep);
      pi[0] = s.nx;
      pi[1] = s.ny;
      pi[2] = s.vx;
      pi[3] = s.vy;
      pi[4] = s.stride;
      pi[5] = mode === 2 ? 1 : 0;
      pf[6] = 0.01;
      pf[7] = s.terrain.cellSize;
      pf[8] = 0.05;
      d.queue.writeBuffer(s.prepParams, 0, prep);
      const bgs = this.prepBindGroups(s);
      const cp = enc.beginComputePass({ label: 'prep' });
      cp.setPipeline(this.P.prepCells);
      cp.setBindGroup(0, bgs.cells);
      cp.dispatchWorkgroups(Math.ceil(s.nx / 16), Math.ceil(s.ny / 16));
      cp.setPipeline(this.P.prepVerts);
      cp.setBindGroup(0, bgs.verts);
      cp.dispatchWorkgroups(Math.ceil(s.vx / 16), Math.ceil(s.vy / 16));
      cp.end();
    }

    const pass = enc.beginRenderPass({
      label: 'main',
      colorAttachments: [
        { view: this.msaaColor!.createView(), resolveTarget: this.hdr!.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] },
      ],
      depthStencilAttachment: { view: this.msaaDepth!.createView(), depthClearValue: 0, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    pass.setPipeline(this.P.sky);
    pass.setBindGroup(0, this.skyBG);
    pass.draw(3);

    if (s && this.mesh) {
      const m = this.mesh;
      pass.setBindGroup(0, s.terrainBG);
      pass.setIndexBuffer(m.index, 'uint32');
      pass.setPipeline(this.P.terrain);
      pass.drawIndexed(m.indexCount);
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

      pass.setBindGroup(0, s.waterBG);
      pass.setIndexBuffer(m.index, 'uint32');
      pass.setPipeline(this.P.water);
      pass.drawIndexed(m.indexCount);
      pass.setIndexBuffer(m.skirt, 'uint32');
      pass.setPipeline(this.P.waterSkirt);
      pass.drawIndexed(m.skirtCount);

      pass.setBindGroup(0, s.overlayBG);
      pass.setPipeline(this.P.ribbons);
      if (settings.showRoads && s.roadVerts && s.roadIndices && s.roadIndexCount > 0) {
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

    const drops = rainDropCount(settings.rainRate);
    if (drops > 0) {
      pass.setPipeline(this.P.rain);
      pass.setBindGroup(0, this.rainBG);
      pass.draw(4, drops);
    }
    pass.end();

    // Bloom: bright-pass ¼-res downsample, then horizontal + vertical blur.
    const bloomPass = (target: GPUTexture, bg: GPUBindGroup) => {
      const p = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      p.setPipeline(this.P.bloom);
      p.setBindGroup(0, bg);
      p.draw(3);
      p.end();
    };
    bloomPass(this.bloomA!, this.bloomBGs[0]);
    bloomPass(this.bloomB!, this.bloomBGs[1]);
    bloomPass(this.bloomA!, this.bloomBGs[2]);

    const overcast = smoothstep(1, 60, settings.rainRate);
    const srgbOut = this.format.endsWith('-srgb') ? 0 : 1;
    d.queue.writeBuffer(this.postBuf, 0, new Float32Array([0.62 * (1 + overcast * 0.35), srgbOut, 0.35, settings.time]));
    const tp = enc.beginRenderPass({
      label: 'tonemap',
      colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    });
    tp.setPipeline(this.P.tonemap);
    tp.setBindGroup(0, this.tonemapBG!);
    tp.draw(3);
    tp.end();

    d.queue.submit([enc.finish()]);
  }

  private writeFrameUniforms(settings: RenderSettings): void {
    const f = this.frameData;
    const s = this.scene;
    const cssW = Math.max(1, this.canvas.clientWidth || this.width);
    const cssH = Math.max(1, this.canvas.clientHeight || this.height);
    const m = this.camera.matrices(cssW / cssH);
    f.set(m.viewProj, 0);
    f.set(m.invViewProj, 16);
    f[32] = m.eye[0];
    f[33] = m.eye[1];
    f[34] = m.eye[2];
    f[35] = Number.isFinite(settings.time) ? settings.time % 100000 : 0;

    const rain = Math.max(0, settings.rainRate || 0);
    const stormBoost = (this.overlays?.storms.length ?? 0) > 0 ? 0.25 : 0;
    const overcast = Math.min(0.92, smoothstep(0.5, 60, rain) * 0.92 + stormBoost * (1 - smoothstep(0.5, 60, rain)));
    // Sun from the south-west, 36° high (consistent with typical aerial-imagery shadows).
    const az = (218 * Math.PI) / 180;
    const el = (36 * Math.PI) / 180;
    f[36] = Math.cos(el) * Math.sin(az);
    f[37] = Math.sin(el);
    f[38] = -Math.cos(el) * Math.cos(az);
    f[39] = this.exaggeration;
    const sunI = 3.1;
    f[40] = 1.0 * sunI;
    f[41] = 0.93 * sunI;
    f[42] = 0.8 * sunI;
    f[43] = s?.terrain.cellSize ?? 8;
    f[44] = 0.13;
    f[45] = 0.3;
    f[46] = 0.68;
    f[47] = rain;
    f[48] = 0.58;
    f[49] = 0.7;
    f[50] = 0.86;
    const domain = s ? Math.max(s.nx, s.ny) * s.terrain.cellSize : 8000;
    f[51] = (1 / (domain * 2.6)) * (1 + overcast * 2.5);
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
    f[74] = 0;
    f[75] = 0;
    for (let i = 0; i < 8; i++) {
      const b = bands[Math.min(i, Math.max(0, bands.length - 1))];
      const c = b ? cssToLinear(b.color) : [0, 0, 0];
      f[76 + i * 4] = c[0];
      f[77 + i * 4] = c[1];
      f[78 + i * 4] = c[2];
      f[79 + i * 4] = b && Number.isFinite(b.max) ? b.max : 1e9;
    }
    this.device.queue.writeBuffer(this.frameBuf, 0, f);

    // Overlay uniforms.
    const o = this.overlays;
    const ov = new Float32Array(OVERLAY_UNIFORM_SIZE / 4);
    const cc = o?.cursor?.color ?? [1, 1, 1];
    ov.set([cc[0], cc[1], cc[2], 0.95], 0);
    const blocked = o?.routeState === 'blocked';
    ov.set(blocked ? [1.6, 0.1, 0.06, 1] : [0.12, 0.9, 1.4, 0], 4);
    ov[8] = Math.max(25, this.camera.pose.distance * 0.03);
    ov[9] = o?.routeState === 'ok' ? 1 : blocked ? 2 : 0;
    ov[10] = settings.showImagery ? 0.55 : 0.8;
    ov[11] = s?.roadStatusCopy ? 1 : 0;
    this.device.queue.writeBuffer(this.overlayBuf, 0, ov);
  }

  // ── Picking ──────────────────────────────────────────────────────────────────────────────

  pick(cssX: number, cssY: number): PickResult | null {
    const s = this.scene;
    if (!s || this.destroyed) return null;
    const cssW = Math.max(1, this.canvas.clientWidth || this.width);
    const cssH = Math.max(1, this.canvas.clientHeight || this.height);
    const m = this.camera.matrices(cssW / cssH);
    const ray = screenRay(cssX, cssY, cssW, cssH, m.invViewProj);
    return pickTerrain(ray, s.hf, this.exaggeration, s.solver.getSnapshot());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.camera.detach();
    this.resizeObserver?.disconnect();
    this.disposeScene();
    this.mesh?.index.destroy();
    this.mesh?.skirt.destroy();
    this.mesh = null;
    for (const t of [this.msaaColor, this.msaaDepth, this.hdr, this.bloomA, this.bloomB, this.rippleTex, this.dummyImagery]) t?.destroy();
    for (const b of [this.frameBuf, this.overlayBuf, this.postBuf, ...this.bloomBufs]) b.destroy();
    for (const b of [this.dynRibbons, this.dynRibbonIdx, this.markerOpaqueV, this.markerOpaqueI, this.markerBlendV, this.markerBlendI]) b.destroy();
  }
}

function niceStep(raw: number): number {
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-3))));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function rainDropCount(rate: number): number {
  if (!(rate > 0.2)) return 0;
  return Math.round(MAX_RAIN_DROPS * clamp(Math.log1p(rate) / Math.log1p(120), 0.04, 1));
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
