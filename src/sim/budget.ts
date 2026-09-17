/**
 * Adaptive GPU work budget for the solver.
 *
 * Every rendered frame the solver may run many substeps; each substep is two full-grid compute passes. On a
 * fanless laptop (MacBook Air) the GPU slows down as it heats up, so a fixed substep count that is smooth at
 * minute 1 stutters at minute 10. The solver therefore MEASURES what a substep costs on the GPU right now and
 * caps substeps so its compute work per frame stays within `budgetMs` (8 ms by default). When the requested
 * sim speed needs more, the solver runs fewer substeps and reports `throttled` — simulated speed degrades,
 * the frame rate does not. budgetMs = Infinity turns the budget off (the solver then takes no measurements).
 *
 * Measurement:
 *  • Preferred: WebGPU timestamp queries around the frame's compute pass (exact GPU execution time, excluding
 *    queueing and presentation). The result is copied to a small MAP_READ buffer and read asynchronously.
 *  • Fallback (no 'timestamp-query'): wall-clock latency between "all previously queued work is done" and
 *    "our work is done" (two queue.onSubmittedWorkDone() promises, one taken just BEFORE our submit). Measuring
 *    submit → done instead would include the previous frame's render work still executing, pinning the
 *    estimate high and the solver at one substep per frame.
 * Samples feed an exponential moving average per substep; upward jumps are clamped so one hitch (GC, another
 * tab) cannot collapse the budget, while a sustained slowdown (thermal throttling) is followed within ~1 s.
 */

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Export pass cost relative to one substep (it touches ~half as many texels); runs once per rendered frame. */
const EXPORT_SUBSTEP_EQUIV = 0.5;

export interface FrameProbe {
  /** Pass this to beginComputePass (undefined in fallback mode). */
  readonly timestampWrites: GPUComputePassTimestampWrites | undefined;
  /** Call after pass.end(), before encoder.finish(). */
  resolve(encoder: GPUCommandEncoder): void;
  /** Call right after queue.submit(). */
  submitted(): void;
}

export class GpuWorkBudget {
  /** Current estimate of GPU milliseconds per substep. */
  msPerSubstep: number;
  /** GPU compute budget per frame, ms. */
  budgetMs: number;
  /** Number of samples folded into the estimate so far. */
  samples = 0;
  readonly usesTimestamps: boolean;

  private readonly device: GPUDevice;
  private readonly querySet: GPUQuerySet | null = null;
  private readonly resolveBuf: GPUBuffer | null = null;
  private readonly freeReadBufs: GPUBuffer[] = [];
  private readonly allReadBufs: GPUBuffer[] = [];
  /** Read buffers with a mapAsync in flight (destroyed only once it settles; see destroy()). */
  private readonly mapping = new Set<GPUBuffer>();
  private fallbackBusy = false;
  private destroyed = false;

  constructor(device: GPUDevice, budgetMs: number, initialMsPerSubstep: number) {
    this.device = device;
    this.budgetMs = budgetMs;
    this.msPerSubstep = initialMsPerSubstep;
    this.usesTimestamps = device.features.has('timestamp-query');
    if (this.usesTimestamps) {
      this.querySet = device.createQuerySet({ label: 'sim.budget.timestamps', type: 'timestamp', count: 2 });
      this.resolveBuf = device.createBuffer({
        label: 'sim.budget.resolve',
        size: 16,
        usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
      });
    }
  }

  /** Substeps that fit the budget (≥ 1; Infinity when the budget is off, budgetMs = Infinity). */
  cap(): number {
    if (!Number.isFinite(this.budgetMs)) return Infinity;
    return Math.max(1, Math.floor(this.budgetMs / Math.max(1e-3, this.msPerSubstep) - EXPORT_SUBSTEP_EQUIV));
  }

  /**
   * Start measuring a compute pass of `substeps` substeps (the export runs lazily in its own pass, see
   * GpuFloodSolver.stateTexture). Returns null when no measurement is possible right now (all readback buffers
   * busy) — the frame then simply runs unmeasured.
   */
  beginFrame(substeps: number): FrameProbe | null {
    if (this.destroyed || substeps <= 0) return null;
    const work = substeps;
    if (this.querySet && this.resolveBuf) {
      let buf = this.freeReadBufs.pop();
      if (!buf) {
        if (this.allReadBufs.length >= 4) return null;
        buf = this.device.createBuffer({ label: 'sim.budget.read', size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
        this.allReadBufs.push(buf);
      }
      const readBuf = buf;
      const querySet = this.querySet;
      const resolveBuf = this.resolveBuf;
      return {
        timestampWrites: { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 },
        resolve: (encoder) => {
          encoder.resolveQuerySet(querySet, 0, 2, resolveBuf, 0);
          encoder.copyBufferToBuffer(resolveBuf, 0, readBuf, 0, 16);
        },
        submitted: () => {
          this.mapping.add(readBuf);
          readBuf.mapAsync(GPUMapMode.READ).then(
            () => {
              this.mapping.delete(readBuf);
              if (this.destroyed) {
                readBuf.unmap();
                readBuf.destroy();
                return;
              }
              const t = new BigInt64Array(readBuf.getMappedRange());
              const ns = Number(t[1] - t[0]);
              readBuf.unmap();
              this.freeReadBufs.push(readBuf);
              // Quantized / unsupported timestamps can read 0: ignore those.
              if (ns > 0) this.addSample(ns / 1e6 / work);
            },
            () => {
              // Device lost.
              this.mapping.delete(readBuf);
              if (this.destroyed) readBuf.destroy();
            },
          );
        },
      };
    }
    // Fallback: one measurement at a time, so the two promises bracket exactly our work.
    if (this.fallbackBusy) return null;
    this.fallbackBusy = true;
    const queue = this.device.queue;
    let tPrevDone = -1;
    queue.onSubmittedWorkDone().then(() => (tPrevDone = now()), () => {});
    return {
      timestampWrites: undefined,
      resolve: () => {},
      submitted: () => {
        const tSubmit = now();
        queue.onSubmittedWorkDone().then(
          () => {
            this.fallbackBusy = false;
            const start = Math.max(tSubmit, tPrevDone);
            const ms = now() - start;
            if (tPrevDone >= 0 && ms > 0) this.addSample(ms / work);
          },
          () => {
            this.fallbackBusy = false;
          },
        );
      },
    };
  }

  /** Fold one per-substep sample (ms) into the estimate. */
  addSample(msPerSubstep: number): void {
    if (!(msPerSubstep > 0) || !Number.isFinite(msPerSubstep)) return;
    const prev = this.msPerSubstep;
    // First samples converge fast; later, a single spike can at most triple the contribution.
    const alpha = this.samples < 5 ? 0.5 : 0.15;
    const s = this.samples < 5 ? msPerSubstep : Math.min(msPerSubstep, prev * 3);
    this.msPerSubstep = prev + alpha * (s - prev);
    this.samples++;
  }

  /**
   * Free GPU resources. Buffers with a mapAsync in flight are destroyed when it settles: destroying a buffer
   * mid-map rejects the map promise, which is harmless in browsers but crashes Dawn-for-Node.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.querySet?.destroy();
    this.resolveBuf?.destroy();
    for (const b of this.allReadBufs) if (!this.mapping.has(b)) b.destroy();
  }
}
