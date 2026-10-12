/**
 * Ensemble flood-probability accumulator on the GPU (src/loss/ensemble.ts has the arithmetic and the CPU mirror).
 *
 * After each ensemble member has run, one compute pass folds the solver's exported max depth (stateTexture.a) into a
 * storage buffer of nx·ny vec4f, row-major:
 *   x = members whose max depth exceeded 0.15 m    y = members over 0.5 m
 *   z = Σ max depth over members (mean = z / members)   w = the largest max depth any member reached (the envelope)
 * The renderer's 'probability' view reads it (prep pass, src/render/shaders/prep.ts): x or y / members is the colour,
 * w is the water surface it is drawn on. One pass over the grid per member, no readback: the
 * alternative — reading every member's 16 MB of max depth back to the CPU — costs a full-grid map per member and holds
 * N × 4 MB on the CPU for a map the GPU then has to re-upload anyway.
 *
 * Non-finite depths (a blown-up naive-mode cell) are detected from the IEEE-754 bit pattern — never by a comparison,
 * which FXC (Dawn on D3D12) folds away — and are not recorded.
 */
import { ENSEMBLE_PER_CELL, ENSEMBLE_THRESHOLDS } from '../loss/ensemble';

const f = (x: number) => (Number.isInteger(x) ? `${x}.0` : String(x));

export const ENSEMBLE_WGSL = /* wgsl */ `
struct Params {
  nx: u32,
  ny: u32,
  pad0: u32,
  pad1: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var stateTex: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> acc: array<vec4f>;

const T1 = ${f(ENSEMBLE_THRESHOLDS[0])};
const T2 = ${f(ENSEMBLE_THRESHOLDS[1])};

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= P.nx || id.y >= P.ny) { return; }
  let m = textureLoad(stateTex, vec2i(id.xy), 0).a;
  let bits = bitcast<u32>(m);
  if ((bits & 0x7f800000u) == 0x7f800000u) { return; }
  let d = max(m, 0.0);
  let c = id.y * P.nx + id.x;
  var a = acc[c];
  a.x = a.x + select(0.0, 1.0, d > T1);
  a.y = a.y + select(0.0, 1.0, d > T2);
  a.z = a.z + d;
  a.w = max(a.w, d);
  acc[c] = a;
}
`;

/** What the renderer needs to draw the probability view (DelugeRendererAPI.setEnsembleLayer). */
export interface EnsembleLayer {
  /** nx·ny vec4f, see the header. */
  buffer: GPUBuffer;
  nx: number;
  ny: number;
  /** Members accumulated so far (the denominator). */
  members: number;
}

export class EnsembleAccumulator {
  readonly buffer: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly pipeline: GPUComputePipeline;
  private members_ = 0;
  private destroyed = false;

  constructor(
    readonly device: GPUDevice,
    readonly nx: number,
    readonly ny: number,
  ) {
    const bytes = nx * ny * ENSEMBLE_PER_CELL * 4;
    this.buffer = device.createBuffer({ label: 'ensemble.acc', size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    this.params = device.createBuffer({ label: 'ensemble.params', size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.params, 0, new Uint32Array([nx, ny, 0, 0]));
    const module = device.createShaderModule({ label: 'ensemble', code: ENSEMBLE_WGSL });
    this.pipeline = device.createComputePipeline({ label: 'ensemble', layout: 'auto', compute: { module, entryPoint: 'main' } });
  }

  get members(): number {
    return this.members_;
  }

  get layer(): EnsembleLayer {
    return { buffer: this.buffer, nx: this.nx, ny: this.ny, members: this.members_ };
  }

  /** Start a new ensemble: every count and sum back to 0. */
  clear(): void {
    if (this.destroyed) return;
    const enc = this.device.createCommandEncoder({ label: 'ensemble.clear' });
    enc.clearBuffer(this.buffer);
    this.device.queue.submit([enc.finish()]);
    this.members_ = 0;
  }

  /**
   * Fold one member's max depth in. `stateTexture` is the solver's exported state (rgba32float, a = max depth since
   * reset): read FloodSolver.stateTexture right before calling, which exports the latest step if needed.
   */
  accumulate(stateTexture: GPUTexture): void {
    if (this.destroyed) return;
    if (stateTexture.width !== this.nx || stateTexture.height !== this.ny) throw new Error('ensemble: state texture does not match the grid');
    const bg = this.device.createBindGroup({
      label: 'ensemble',
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params } },
        { binding: 1, resource: stateTexture.createView() },
        { binding: 2, resource: { buffer: this.buffer } },
      ],
    });
    const enc = this.device.createCommandEncoder({ label: 'ensemble.accumulate' });
    const pass = enc.beginComputePass({ label: 'ensemble.accumulate' });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, bg);
    pass.dispatchWorkgroups(Math.ceil(this.nx / 16), Math.ceil(this.ny / 16));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.members_++;
  }

  /** Read the accumulator back (tests, exports): nx·ny·4 floats. */
  async read(): Promise<Float32Array> {
    const bytes = this.nx * this.ny * ENSEMBLE_PER_CELL * 4;
    const staging = this.device.createBuffer({ label: 'ensemble.read', size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder({ label: 'ensemble.read' });
    enc.copyBufferToBuffer(this.buffer, 0, staging, 0, bytes);
    this.device.queue.submit([enc.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(staging.getMappedRange().slice(0));
    staging.unmap();
    staging.destroy();
    return out;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.buffer.destroy();
    this.params.destroy();
  }
}
