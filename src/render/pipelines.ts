/** Creation of all render/compute pipelines and shared bind group layouts. */
import { NORMAL_WATER_WGSL, PREP_CELLS_WGSL, PREP_VERTS_WGSL, PREP_VTXBED_WGSL, PREP_WGSL, WET_BASE_WGSL, WET_DOWN_WGSL } from './shaders/prep';
import { TERRAIN_WGSL } from './shaders/terrain';
import { WATER_WGSL } from './shaders/water';
import { MARKER_WGSL, RIBBON_WGSL } from './shaders/overlay';
import { BLOOM_WGSL, RAIN_WGSL, SKY_WGSL, TONEMAP_WGSL } from './shaders/post';

export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
export const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
export const MSAA = 4;

export interface Pipelines {
  sceneBGL: GPUBindGroupLayout;
  overlayBGL: GPUBindGroupLayout;
  prepCells: GPUComputePipeline;
  prepVerts: GPUComputePipeline;
  prepVtxBed: GPUComputePipeline;
  wetBase: GPUComputePipeline;
  wetDown: GPUComputePipeline;
  normalWater: GPUComputePipeline;
  sky: GPURenderPipeline;
  terrain: GPURenderPipeline;
  skirt: GPURenderPipeline;
  water: GPURenderPipeline;
  waterSkirt: GPURenderPipeline;
  ribbons: GPURenderPipeline;
  markersOpaque: GPURenderPipeline;
  markersBlend: GPURenderPipeline;
  rain: GPURenderPipeline;
  bloom: GPURenderPipeline;
  tonemap: GPURenderPipeline;
}

const PREMULT: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

async function checkedModule(device: GPUDevice, code: string, label: string): Promise<GPUShaderModule> {
  const module = device.createShaderModule({ code, label });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) {
    const lines = code.split('\n');
    const detail = errors
      .map((m) => `${label}:${m.lineNum}:${m.linePos} ${m.message}\n    ${lines[m.lineNum - 1] ?? ''}`)
      .join('\n');
    throw new Error(`WGSL compile error in ${label}:\n${detail}`);
  }
  return module;
}

export async function createPipelines(device: GPUDevice, canvasFormat: GPUTextureFormat): Promise<Pipelines> {
  const sceneBGL = device.createBindGroupLayout({
    label: 'scene',
    entries: [
      { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
      { binding: 1, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 3, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 4, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 5, visibility: VF, texture: { sampleType: 'float' } },
      { binding: 6, visibility: VF, sampler: { type: 'filtering' } },
      { binding: 7, visibility: VF, sampler: { type: 'filtering' } },
      { binding: 8, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'unfilterable-float' } },
      // Wall distance field (rgba16float) and the normally-wet mask (rgba8unorm), both filtered.
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      // Land the user's walls keep dry (r8unorm, filtered): the terrain's green "protected" glow.
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      // Close-up imagery inset (rgba8unorm-srgb, filtered) — a 1x1 placeholder when the area has none.
      { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
    ],
  });
  const overlayBGL = device.createBindGroupLayout({
    label: 'overlay',
    entries: [
      { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
      { binding: 1, visibility: VF, texture: { sampleType: 'unfilterable-float' } },
      { binding: 2, visibility: VF, buffer: { type: 'uniform' } },
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const sceneLayout = device.createPipelineLayout({ bindGroupLayouts: [sceneBGL] });
  const overlayLayout = device.createPipelineLayout({ bindGroupLayouts: [overlayBGL] });

  const [prepCellsM, prepVertsM, prepVtxBedM, wetBaseM, wetDownM, normalWaterM, terrainM, waterM, ribbonM, markerM, skyM, rainM, bloomM, tonemapM] = await Promise.all([
    checkedModule(device, PREP_WGSL + PREP_CELLS_WGSL, 'prep-cells'),
    checkedModule(device, PREP_WGSL + PREP_VERTS_WGSL, 'prep-verts'),
    checkedModule(device, PREP_WGSL + PREP_VTXBED_WGSL, 'prep-vtxbed'),
    checkedModule(device, WET_BASE_WGSL, 'wet-base'),
    checkedModule(device, WET_DOWN_WGSL, 'wet-down'),
    checkedModule(device, NORMAL_WATER_WGSL, 'normal-water'),
    checkedModule(device, TERRAIN_WGSL, 'terrain'),
    checkedModule(device, WATER_WGSL, 'water'),
    checkedModule(device, RIBBON_WGSL, 'ribbons'),
    checkedModule(device, MARKER_WGSL, 'markers'),
    checkedModule(device, SKY_WGSL, 'sky'),
    checkedModule(device, RAIN_WGSL, 'rain'),
    checkedModule(device, BLOOM_WGSL, 'bloom'),
    checkedModule(device, TONEMAP_WGSL, 'tonemap'),
  ]);

  const msaa: GPUMultisampleState = { count: MSAA };
  const depthWrite: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'greater' };
  const depthRead: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'greater' };
  const hdrOpaque: GPUColorTargetState[] = [{ format: HDR_FORMAT }];
  const hdrBlend: GPUColorTargetState[] = [{ format: HDR_FORMAT, blend: PREMULT }];
  const ribbonLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x2' },
      { shaderLocation: 1, offset: 8, format: 'float32x2' },
      { shaderLocation: 2, offset: 16, format: 'float32x4' },
    ],
  };
  /** CDLOD node instances (see lod.ts): node (origin, quad size, level) + morph range. */
  const nodeLayout: GPUVertexBufferLayout = {
    arrayStride: 32,
    stepMode: 'instance',
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x4' },
      { shaderLocation: 1, offset: 16, format: 'float32x4' },
    ],
  };
  const markerLayout: GPUVertexBufferLayout = {
    arrayStride: 72,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x4' },
      { shaderLocation: 3, offset: 40, format: 'float32x4' },
      { shaderLocation: 4, offset: 56, format: 'float32x4' },
    ],
  };

  const R = (d: GPURenderPipelineDescriptor) => device.createRenderPipelineAsync(d);
  const [sky, terrain, skirt, water, waterSkirt, ribbons, markersOpaque, markersBlend, rain, bloom, tonemap, prepCells, prepVerts, prepVtxBed, wetBase, wetDown, normalWater] =
    await Promise.all([
      R({
        label: 'sky',
        layout: 'auto',
        vertex: { module: skyM, entryPoint: 'vsFull' },
        fragment: { module: skyM, entryPoint: 'fsSky', targets: hdrOpaque },
        // Drawn after opaque geometry: only pixels still at the cleared far depth (0, reversed-Z) are shaded.
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'equal' },
        multisample: msaa,
      }),
      R({
        label: 'terrain',
        layout: sceneLayout,
        vertex: { module: terrainM, entryPoint: 'vsTerrain', buffers: [nodeLayout] },
        fragment: { module: terrainM, entryPoint: 'fsTerrain', targets: hdrOpaque },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthWrite,
        multisample: msaa,
      }),
      R({
        label: 'skirt',
        layout: sceneLayout,
        vertex: { module: terrainM, entryPoint: 'vsSkirt' },
        fragment: { module: terrainM, entryPoint: 'fsSkirt', targets: hdrOpaque },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthWrite,
        multisample: msaa,
      }),
      R({
        label: 'water',
        layout: sceneLayout,
        vertex: { module: waterM, entryPoint: 'vsWater', buffers: [nodeLayout] },
        fragment: { module: waterM, entryPoint: 'fsWater', targets: hdrBlend },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthWrite,
        multisample: msaa,
      }),
      R({
        label: 'water-skirt',
        layout: sceneLayout,
        vertex: { module: waterM, entryPoint: 'vsWaterSkirt' },
        fragment: { module: waterM, entryPoint: 'fsWater', targets: hdrBlend },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthRead,
        multisample: msaa,
      }),
      R({
        label: 'ribbons',
        layout: overlayLayout,
        vertex: { module: ribbonM, entryPoint: 'vsRibbon', buffers: [ribbonLayout] },
        fragment: { module: ribbonM, entryPoint: 'fsRibbon', targets: hdrBlend },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthRead,
        multisample: msaa,
      }),
      R({
        label: 'markers-opaque',
        layout: overlayLayout,
        vertex: { module: markerM, entryPoint: 'vsMarker', buffers: [markerLayout] },
        fragment: { module: markerM, entryPoint: 'fsMarker', targets: hdrOpaque },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthWrite,
        multisample: msaa,
      }),
      R({
        label: 'markers-blend',
        layout: overlayLayout,
        vertex: { module: markerM, entryPoint: 'vsMarker', buffers: [markerLayout] },
        fragment: { module: markerM, entryPoint: 'fsMarker', targets: hdrBlend },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: depthRead,
        multisample: msaa,
      }),
      R({
        label: 'rain',
        layout: 'auto',
        vertex: { module: rainM, entryPoint: 'vsRain' },
        fragment: { module: rainM, entryPoint: 'fsRain', targets: hdrBlend },
        primitive: { topology: 'triangle-strip' },
        depthStencil: depthRead,
        multisample: msaa,
      }),
      R({
        label: 'bloom',
        layout: 'auto',
        vertex: { module: bloomM, entryPoint: 'vsFull' },
        fragment: { module: bloomM, entryPoint: 'fsBloom', targets: [{ format: HDR_FORMAT }] },
      }),
      R({
        label: 'tonemap',
        layout: 'auto',
        vertex: { module: tonemapM, entryPoint: 'vsFull' },
        fragment: { module: tonemapM, entryPoint: 'fsTonemap', targets: [{ format: canvasFormat }] },
      }),
      device.createComputePipelineAsync({ label: 'prep-cells', layout: 'auto', compute: { module: prepCellsM, entryPoint: 'cells' } }),
      device.createComputePipelineAsync({ label: 'prep-verts', layout: 'auto', compute: { module: prepVertsM, entryPoint: 'verts' } }),
      device.createComputePipelineAsync({ label: 'prep-vtxbed', layout: 'auto', compute: { module: prepVtxBedM, entryPoint: 'vtxBed' } }),
      device.createComputePipelineAsync({ label: 'wet-base', layout: 'auto', compute: { module: wetBaseM, entryPoint: 'wetBase' } }),
      device.createComputePipelineAsync({ label: 'wet-down', layout: 'auto', compute: { module: wetDownM, entryPoint: 'wetDown' } }),
      device.createComputePipelineAsync({ label: 'normal-water', layout: 'auto', compute: { module: normalWaterM, entryPoint: 'normalWater' } }),
    ]);

  return { sceneBGL, overlayBGL, prepCells, prepVerts, prepVtxBed, wetBase, wetDown, normalWater, sky, terrain, skirt, water, waterSkirt, ribbons, markersOpaque, markersBlend, rain, bloom, tonemap };
}
