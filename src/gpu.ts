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

/** Adapter label: the distinct, non-empty parts of GPUAdapterInfo in order ("apple metal-3"), never a repeat. */
export function joinAdapterInfo(parts: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of parts) {
    const part = (raw ?? '').trim();
    const key = part.toLowerCase();
    if (!part || seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(' ') || 'unknown adapter';
}

export async function createDelugeDevice(gpu: GPU): Promise<DelugeGPU> {
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
  // The exact phrase src/app/unsupported.ts matches on to show the "no adapter" screen (NO_ADAPTER_MESSAGE).
  if (!adapter) throw new Error('No WebGPU adapter available (hardware acceleration off, a blocklisted GPU, or a VM)');
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
  // Some drivers repeat themselves across the four fields (Apple Silicon in Safari reports
  // vendor/architecture/device/description all as "apple", which rendered as "apple apple apple apple" in the HUD):
  // de-duplicate, case-insensitively, keeping the first spelling of each distinct part.
  const description = info ? joinAdapterInfo([info.vendor, info.architecture, info.device, info.description]) : 'unknown adapter';
  return {
    adapter,
    device,
    float32Filterable: requiredFeatures.includes('float32-filterable'),
    timestampQuery: requiredFeatures.includes('timestamp-query'),
    description,
  };
}
