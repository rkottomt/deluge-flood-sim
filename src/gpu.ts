/**
 * Shared WebGPU device creation. Works in the browser (navigator.gpu) and in Node tests
 * (the `webgpu` package's GPU object). Always use this so tests and app get identical limits/features.
 */
export interface DelugeGPU {
  adapter: GPUAdapter;
  device: GPUDevice;
  /** True if float32 textures can be linearly filtered (feature 'float32-filterable'). */
  float32Filterable: boolean;
  /** True if 'timestamp-query' was enabled. */
  timestampQuery: boolean;
  description: string;
}

export async function createDelugeDevice(gpu: GPU): Promise<DelugeGPU> {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter available');
  const want: GPUFeatureName[] = ['float32-filterable', 'timestamp-query'];
  const requiredFeatures = want.filter((f) => adapter.features.has(f));
  const L = adapter.limits;
  const device = await adapter.requestDevice({
    requiredFeatures,
    requiredLimits: {
      maxStorageTexturesPerShaderStage: Math.min(L.maxStorageTexturesPerShaderStage, 8),
      maxStorageBuffersPerShaderStage: Math.min(L.maxStorageBuffersPerShaderStage, 10),
      maxSampledTexturesPerShaderStage: Math.min(L.maxSampledTexturesPerShaderStage, 16),
      maxStorageBufferBindingSize: L.maxStorageBufferBindingSize,
      maxBufferSize: L.maxBufferSize,
      maxTextureDimension2D: Math.min(L.maxTextureDimension2D, 8192),
      maxComputeInvocationsPerWorkgroup: Math.min(L.maxComputeInvocationsPerWorkgroup, 256),
      maxComputeWorkgroupSizeX: Math.min(L.maxComputeWorkgroupSizeX, 256),
      maxComputeWorkgroupSizeY: Math.min(L.maxComputeWorkgroupSizeY, 256),
      maxColorAttachmentBytesPerSample: Math.min(L.maxColorAttachmentBytesPerSample, 64),
    },
  });
  const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo }).info;
  const description = info
    ? [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ')
    : 'unknown adapter';
  return {
    adapter,
    device,
    float32Filterable: requiredFeatures.includes('float32-filterable'),
    timestampQuery: requiredFeatures.includes('timestamp-query'),
    description,
  };
}
