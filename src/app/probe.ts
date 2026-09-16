import type { FloodSolver, Store } from '../contracts';

/** Minimum spacing between GPU probe samples. */
const SAMPLE_INTERVAL_MS = 200;
/** A cached sample is applied to probe updates for this long. */
const SAMPLE_TTL_MS = 1000;

interface Sample {
  i: number;
  j: number;
  depth: number;
  speed: number;
  at: number;
}

/**
 * Live flow speed (and fresh depth) under the probe cursor.
 *
 * Snapshots only carry depth, so the tool controller publishes probes with `speed: 0`. This samples the
 * solver's state texture (r = h, g = u, b = v) at the probed cell with a 1-texel GPU copy + async map at
 * ≤ 5 Hz, and patches `store.probe` whenever it points at the sampled cell. Requires the state texture to
 * have COPY_SRC usage; otherwise it stays inactive (speed remains 0).
 */
export class ProbeSampler {
  private buffer: GPUBuffer | null = null;
  private pending = false;
  private lastSample = -Infinity;
  private cache: Sample | null = null;
  /** Bumped on scene change so late readbacks from the old solver are discarded. */
  private epoch = 0;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: Store,
    private readonly device: GPUDevice,
  ) {}

  install(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.store.subscribe((s, prev) => {
      if (s.probe !== prev.probe) this.patchProbe();
    });
  }

  reset(): void {
    this.epoch++;
    this.cache = null;
  }

  tick(now: number, solver: FloodSolver): void {
    const probe = this.store.get().probe;
    if (!probe || this.pending || now - this.lastSample < SAMPLE_INTERVAL_MS) return;
    const texture = solver.stateTexture;
    if ((texture.usage & GPUTextureUsage.COPY_SRC) === 0) return;
    const i = Math.floor(probe.gx);
    const j = Math.floor(probe.gy);
    if (i < 0 || j < 0 || i >= solver.nx || j >= solver.ny) return;

    const device = this.device;
    this.buffer ??= device.createBuffer({
      label: 'probe-sample',
      size: 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    const buffer = this.buffer;
    const encoder = device.createCommandEncoder({ label: 'probe-sample' });
    encoder.copyTextureToBuffer({ texture, origin: { x: i, y: j } }, { buffer }, [1, 1, 1]);
    device.queue.submit([encoder.finish()]);

    this.pending = true;
    this.lastSample = now;
    const epoch = this.epoch;
    buffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const [h, u, v] = new Float32Array(buffer.getMappedRange().slice(0));
        buffer.unmap();
        if (epoch !== this.epoch) return;
        this.cache = { i, j, depth: h, speed: Math.hypot(u, v), at: performance.now() };
        this.patchProbe();
      })
      .catch((err: unknown) => {
        // Device loss / destroyed buffer: already reported elsewhere; just stop sampling this buffer.
        if (this.buffer === buffer) this.buffer = null;
        if (epoch === this.epoch) console.warn('[deluge] probe sample failed', err);
      })
      .finally(() => {
        this.pending = false;
      });
  }

  /** Apply the cached sample to the current probe if it refers to the same cell. */
  private patchProbe(): void {
    const probe = this.store.get().probe;
    const c = this.cache;
    if (!probe || !c || performance.now() - c.at > SAMPLE_TTL_MS) return;
    if (Math.floor(probe.gx) !== c.i || Math.floor(probe.gy) !== c.j) return;
    if (Object.is(probe.speed, c.speed) && Object.is(probe.depth, c.depth)) return;
    this.store.set({ probe: { ...probe, speed: c.speed, depth: c.depth } });
  }
}
