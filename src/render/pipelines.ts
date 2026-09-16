/** Creation of all render/compute pipelines and shared bind group layouts. */
import { PREP_CELLS_WGSL, PREP_VERTS_WGSL, PREP_WGSL } from './shaders/prep';
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

  const [prepCellsM, prepVertsM, terrainM, waterM, ribbonM, markerM, skyM, rainM, bloomM, tonemapM] = await Promise.all([
    checkedModule(device, PREP_WGSL + PREP_CELLS_WGSL, 'prep-cells'),
    checkedModule(device, PREP_WGSL + PREP_VERTS_WGSL, 'prep-verts'),
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
  const [sky, terrain, skirt, water, waterSkirt, ribbons, markersOpaque, markersBlend, rain, bloom, tonemap, prepCells, prepVerts] =
    await Promise.all([
      R({
        label: 'sky',
        layout: 'auto',
        vertex: { module: skyM, entryPoint: 'vsFull' },
        fragment: { module: skyM, entryPoint: 'fsSky', targets: hdrOpaque },
        depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'always' },
        multisample: msaa,
      }),
      R({
        label: 'terrain',
        layout: sceneLayout,
        vertex: { module: terrainM, entryPoint: 'vsTerrain' },
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
        vertex: { module: waterM, entryPoint: 'vsWater' },
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
    ]);

  return { sceneBGL, overlayBGL, prepCells, prepVerts, sky, terrain, skirt, water, waterSkirt, ribbons, markersOpaque, markersBlend, rain, bloom, tonemap };
}
