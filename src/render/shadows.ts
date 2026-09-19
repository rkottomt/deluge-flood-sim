/**
 * The sun-shading raster: who can see the sun, and how much sky, at every cell of the DEM.
 *
 * Owns one rgba8unorm texture over the solver grid (r = sun visibility with a soft penumbra, g = sky visibility)
 * and the two compute passes that fill it (see shaders/shadow.ts for the method and why it is not a depth map
 * rendered from the sun). It is built once when a scene loads, and afterwards only over the rectangle an edit
 * touched, grown by how far a shadow can reach from it.
 *
 * Cost is paid at load, not per frame: the render passes read the result with one filtered tap. On the demo
 * machine a full 1024² build is a few tens of milliseconds of GPU time inside an already-long scene load
 * (measured by tests/render/shadows.test.ts, which fails if it passes the SHADOW_BUILD_BUDGET_MS ceiling).
 */

import { SUN_ANGULAR_RADIUS_TAN, SUN_HEIGHT_WGSL, SUN_VIS_WGSL } from './shaders/shadow';

/** A full build must stay well inside this, so loading a city never feels slower because of the lighting. */
export const SHADOW_BUILD_BUDGET_MS = 200;

/** How finely the raster is solved. Tracks the renderer's quality tier; see quality.ts. */
export interface ShadowQuality {
  /** Sun-ray march steps. */
  steps: number;
  /** Geometric growth of the step length: fewer steps need faster growth to reach as far. */
  growth: number;
  /** Sky-visibility azimuths (0 = no ambient occlusion term). */
  aoDirs: number;
  /** Steps per azimuth. */
  aoSteps: number;
  /** How far sky visibility looks, in cells. */
  aoRadius: number;
}

export const SHADOW_QUALITY: Record<'low' | 'standard' | 'cinematic', ShadowQuality> = {
  low: { steps: 32, growth: 1.11, aoDirs: 6, aoSteps: 5, aoRadius: 22 },
  standard: { steps: 48, growth: 1.075, aoDirs: 8, aoSteps: 7, aoRadius: 32 },
  cinematic: { steps: 64, growth: 1.055, aoDirs: 12, aoSteps: 9, aoRadius: 44 },
};

export interface ShadowSun {
  /** Unit vector toward the sun (world axes: +y up, +x east, −z north — the renderer's convention). */
  dir: readonly [number, number, number];
}

export interface ShadowPipelines {
  packHeight: GPUComputePipeline;
  sunVis: GPUComputePipeline;
}

/** Compile the two compute pipelines. Called from createPipelines so every shader is validated in one place. */
export async function createShadowPipelines(device: GPUDevice, checked: (code: string, label: string) => Promise<GPUShaderModule>): Promise<ShadowPipelines> {
  const [heightM, visM] = await Promise.all([checked(SUN_HEIGHT_WGSL, 'sun-height'), checked(SUN_VIS_WGSL, 'sun-vis')]);
  const [packHeight, sunVis] = await Promise.all([
    device.createComputePipelineAsync({ label: 'sun-height', layout: 'auto', compute: { module: heightM, entryPoint: 'packHeight' } }),
    device.createComputePipelineAsync({ label: 'sun-vis', layout: 'auto', compute: { module: visM, entryPoint: 'sunVis' } }),
  ]);
  return { packHeight, sunVis };
}

/** Integer rectangle in cells, half-open on the high side. */
export interface CellRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * How far a shadow can reach from an edit, in cells: the tallest thing that could have changed, divided by the
 * tangent of the solar elevation. Clamped so a sun at the horizon does not ask for the whole grid back.
 */
export function shadowReachCells(reliefMetres: number, sunY: number, sunHorizontal: number, cellSize: number, maxCells: number): number {
  const tan = Math.max(sunY, 1e-3) / Math.max(sunHorizontal, 1e-4);
  const metres = Math.max(0, reliefMetres) / Math.max(tan, 0.02);
  return Math.min(maxCells, Math.ceil(metres / Math.max(cellSize, 0.01)) + 2);
}

/**
 * Grow a rectangle by `ao` cells on every side and by `reach` cells in the direction shadows fall (away from the
 * sun), then clamp to the grid. Growing only downsun is what keeps a levee edit cheap: a wall changes the light on
 * the ground its shadow lands on and nowhere else.
 */
export function expandForShadow(rect: CellRect, sunXZ: readonly [number, number], reach: number, ao: number, nx: number, ny: number): CellRect {
  const dx = -sunXZ[0] * reach;
  const dy = -sunXZ[1] * reach;
  const x0 = Math.floor(Math.min(rect.x0, rect.x0 + dx) - ao);
  const x1 = Math.ceil(Math.max(rect.x1, rect.x1 + dx) + ao);
  const y0 = Math.floor(Math.min(rect.y0, rect.y0 + dy) - ao);
  const y1 = Math.ceil(Math.max(rect.y1, rect.y1 + dy) + ao);
  return {
    x0: Math.max(0, Math.min(nx, x0)),
    y0: Math.max(0, Math.min(ny, y0)),
    x1: Math.max(0, Math.min(nx, x1)),
    y1: Math.max(0, Math.min(ny, y1)),
  };
}

const HEIGHT_PARAMS_SIZE = 32;
const SUN_PARAMS_SIZE = 64;

/**
 * The raster for one scene. Create it with the solver's grid, feed it the bed / barrier textures, and call
 * `build()` whenever the sun or the terrain changes.
 */
export class SunShading {
  readonly texture: GPUTexture;
  private heightTex: GPUTexture;
  private heightParams: GPUBuffer;
  private sunParams: GPUBuffer;
  private heightBG: GPUBindGroup | null = null;
  private heightBGKey: GPUTexture | null = null;
  private heightBGKey2: GPUTexture | null = null;
  private heightBGKey3: GPUTexture | null = null;
  private visBG: GPUBindGroup;
  /** 1x1 stand-in bound when nothing is built on the grid, so the bind group layout never changes. */
  private noBuildings: GPUTexture;
  /**
   * Roof height above ground per cell (r32float over the grid), or null when the scene has no buildings or they
   * are hidden. Set it before `build()`: buildings then cast their own shadows and close the streets in, at no
   * per-frame cost, because they are simply part of the height field the raster is solved over.
   */
  buildingHeights: GPUTexture | null = null;
  /** Cells rebuilt by the last build() — the measurement the perf report quotes. */
  lastCells = 0;
  /** True once a full-grid build has been encoded: before that the shaders must ignore the texture. */
  valid = false;

  constructor(
    private device: GPUDevice,
    private P: ShadowPipelines,
    readonly nx: number,
    readonly ny: number,
    readonly cellSize: number,
  ) {
    const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING;
    // COPY_SRC so tests (and any future debug view) can read the raster back and check it against the height field.
    this.texture = device.createTexture({ label: 'sun-visibility', size: [nx, ny], format: 'rgba8unorm', usage: usage | GPUTextureUsage.COPY_SRC });
    // rg32float: the occluder height field and the bare street under it (see SUN_HEIGHT_WGSL).
    this.heightTex = device.createTexture({ label: 'sun-height', size: [nx, ny], format: 'rg32float', usage });
    this.noBuildings = device.createTexture({ label: 'sun-no-buildings', size: [1, 1], format: 'r32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: this.noBuildings }, new Float32Array([0]), { bytesPerRow: 4 }, { width: 1, height: 1 });
    this.heightParams = device.createBuffer({ label: 'sun-height-params', size: HEIGHT_PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sunParams = device.createBuffer({ label: 'sun-vis-params', size: SUN_PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.visBG = device.createBindGroup({
      label: 'sun-vis',
      layout: P.sunVis.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.sunParams } },
        { binding: 1, resource: this.heightTex.createView() },
        { binding: 2, resource: this.texture.createView() },
      ],
    });
  }

  private heightBindGroup(bed: GPUTexture, barrier: GPUTexture): GPUBindGroup {
    const bld = this.buildingHeights ?? this.noBuildings;
    if (this.heightBG && this.heightBGKey === bed && this.heightBGKey2 === barrier && this.heightBGKey3 === bld) return this.heightBG;
    this.heightBG = this.device.createBindGroup({
      label: 'sun-height',
      layout: this.P.packHeight.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.heightParams } },
        { binding: 1, resource: bed.createView() },
        { binding: 2, resource: barrier.createView() },
        { binding: 3, resource: this.heightTex.createView() },
        { binding: 4, resource: bld.createView() },
      ],
    });
    this.heightBGKey = bed;
    this.heightBGKey2 = barrier;
    this.heightBGKey3 = bld;
    return this.heightBG;
  }

  /**
   * Encode a (re)build into `enc`. `rects.height` is where the terrain itself changed (the cached height field is
   * refreshed there); `rects.vis` is the larger region whose lighting that change can alter — see
   * expandForShadow. Omit them for a full-grid build. The caller submits; the result is visible to every pass
   * encoded after this one, so the frame that triggers a rebuild already shows it.
   */
  build(
    enc: GPUCommandEncoder,
    bed: GPUTexture,
    barrier: GPUTexture,
    sun: ShadowSun,
    q: ShadowQuality,
    rects?: { height: CellRect; vis: CellRect },
    timestampWrites?: GPUComputePassTimestampWrites,
  ): void {
    const full: CellRect = { x0: 0, y0: 0, x1: this.nx, y1: this.ny };
    const hr = rects?.height ?? full;
    const r = rects?.vis ?? full;
    const hw = Math.max(0, hr.x1 - hr.x0);
    const hh = Math.max(0, hr.y1 - hr.y0);
    const w = Math.max(0, r.x1 - r.x0);
    const h = Math.max(0, r.y1 - r.y0);
    this.lastCells = w * h;
    if (w === 0 || h === 0) return;

    const hp = new Int32Array(HEIGHT_PARAMS_SIZE / 4);
    hp[0] = this.nx;
    hp[1] = this.ny;
    hp[2] = hr.x0;
    hp[3] = hr.y0;
    hp[4] = hw;
    hp[5] = hh;
    hp[6] = this.buildingHeights ? 1 : 0;
    this.device.queue.writeBuffer(this.heightParams, 0, hp);

    const sp = new ArrayBuffer(SUN_PARAMS_SIZE);
    const si = new Int32Array(sp);
    const sf = new Float32Array(sp);
    si[0] = this.nx;
    si[1] = this.ny;
    si[2] = r.x0;
    si[3] = r.y0;
    si[4] = w;
    si[5] = h;
    si[6] = Math.max(1, Math.round(q.steps));
    si[7] = Math.max(0, Math.round(q.aoDirs));
    // Grid axes: +x is grid x, +y is grid y = world +z. The sun's world z maps straight onto grid y.
    const hx = sun.dir[0];
    const hz = sun.dir[2];
    const hl = Math.hypot(hx, hz) || 1e-6;
    sf[8] = hx / hl;
    sf[9] = hz / hl;
    sf[10] = Math.max(0.005, sun.dir[1]) / hl;
    sf[11] = this.cellSize;
    sf[12] = Math.max(1.001, q.growth);
    sf[13] = SUN_ANGULAR_RADIUS_TAN;
    sf[14] = Math.max(1, q.aoSteps);
    sf[15] = Math.max(1, q.aoRadius);
    this.device.queue.writeBuffer(this.sunParams, 0, sp);

    const cp = enc.beginComputePass({ label: 'sun-shading', timestampWrites });
    if (hw > 0 && hh > 0) {
      cp.setPipeline(this.P.packHeight);
      cp.setBindGroup(0, this.heightBindGroup(bed, barrier));
      cp.dispatchWorkgroups(Math.ceil(hw / 8), Math.ceil(hh / 8));
    }
    cp.setPipeline(this.P.sunVis);
    cp.setBindGroup(0, this.visBG);
    cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    cp.end();
    if (!rects) this.valid = true;
  }

  destroy(): void {
    this.texture.destroy();
    this.heightTex.destroy();
    this.noBuildings.destroy();
    this.heightParams.destroy();
    this.sunParams.destroy();
    this.heightBG = null;
  }
}
