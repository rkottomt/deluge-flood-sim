/**
 * Optional per-pass GPU timing with 'timestamp-query'. Results are read back asynchronously (never blocks),
 * smoothed, and used for the stats readout and to guard adaptive-resolution raises. No-op without the feature.
 */

export type TimedPass = 'prep' | 'main' | 'post';
const PASSES: TimedPass[] = ['prep', 'main', 'post'];

export class GpuTimer {
  readonly enabled: boolean;
  /** Smoothed milliseconds per pass. */
  readonly ms: Record<TimedPass, number> = { prep: 0, main: 0, post: 0 };
  private querySet: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private readBuf: GPUBuffer | null = null;
  private mapping = false;
  private used = new Set<TimedPass>();

  constructor(device: GPUDevice) {
    this.enabled = device.features.has('timestamp-query');
    if (!this.enabled) return;
    const count = PASSES.length * 2;
    this.querySet = device.createQuerySet({ type: 'timestamp', count });
    this.resolveBuf = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
    this.readBuf = device.createBuffer({ size: count * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  }

  /** Begin a frame: forget which passes were timed. */
  beginFrame(): void {
    this.used.clear();
  }

  /**
   * timestampWrites for a pass descriptor (undefined when disabled).
   *
   * `part` lets one timed name span SEVERAL render passes: 'start' stamps only the opening of the first pass and
   * 'end' only the close of the last, so the reported time is the whole span including everything encoded
   * between. The post chain uses it — bloom is four or five passes plus the tonemap, and timing only the last of
   * them would report a number that moves when the bloom chain changes by nothing at all.
   */
  writes(pass: TimedPass, part: 'both' | 'start' | 'end' = 'both'): GPURenderPassTimestampWrites | undefined {
    if (!this.querySet) return undefined;
    const i = PASSES.indexOf(pass);
    this.used.add(pass);
    const w: GPURenderPassTimestampWrites = { querySet: this.querySet };
    if (part !== 'end') w.beginningOfPassWriteIndex = i * 2;
    if (part !== 'start') w.endOfPassWriteIndex = i * 2 + 1;
    return w;
  }

  /** Resolve this frame's queries into the encoder (only when the read buffer is free). */
  resolve(encoder: GPUCommandEncoder): boolean {
    if (!this.querySet || !this.resolveBuf || !this.readBuf || this.mapping || this.used.size === 0) return false;
    encoder.resolveQuerySet(this.querySet, 0, PASSES.length * 2, this.resolveBuf, 0);
    encoder.copyBufferToBuffer(this.resolveBuf, 0, this.readBuf, 0, PASSES.length * 16);
    return true;
  }

  /** Call after queue.submit when resolve() returned true. */
  collect(): void {
    const buf = this.readBuf;
    if (!buf || this.mapping) return;
    this.mapping = true;
    const used = new Set(this.used);
    buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const t = new BigInt64Array(buf.getMappedRange());
        PASSES.forEach((p, i) => {
          if (!used.has(p)) {
            this.ms[p] *= 0.9;
            return;
          }
          const d = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
          if (d >= 0 && d < 1000) this.ms[p] += (d - this.ms[p]) * 0.15;
        });
        buf.unmap();
      })
      .catch(() => {})
      .finally(() => {
        this.mapping = false;
      });
  }

  get totalMs(): number {
    return this.ms.prep + this.ms.main + this.ms.post;
  }

  destroy(): void {
    this.querySet?.destroy();
    this.resolveBuf?.destroy();
    // The read buffer may be mid-map; destroying it rejects the pending map (caught above).
    this.readBuf?.destroy();
    this.querySet = this.resolveBuf = this.readBuf = null;
  }
}
