/**
 * Measures GPU latency: time from a frame's queue submission until the GPU reports that work done
 * (`GPUQueue.onSubmittedWorkDone`). requestAnimationFrame cannot see a GPU queue that is backing up; this can.
 * At most one measurement is outstanding at a time, so a slow GPU is sampled less often instead of being
 * flooded with promises.
 */
export class GpuLatencyProbe {
  private pending = false;

  constructor(
    private readonly getQueue: () => GPUQueue | null,
    private readonly onSample: (ms: number) => void,
  ) {}

  /** Call right after the frame's GPU work has been submitted. */
  afterSubmit(): void {
    if (this.pending) return;
    const queue = this.getQueue();
    if (!queue) return;
    this.pending = true;
    const t0 = performance.now();
    queue
      .onSubmittedWorkDone()
      .then(
        () => this.onSample(performance.now() - t0),
        () => {
          /* device lost: reported by ErrorReporter */
        },
      )
      .finally(() => {
        this.pending = false;
      });
  }
}
