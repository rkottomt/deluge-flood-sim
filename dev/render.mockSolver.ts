/**
 * DEV HARNESS FIXTURE (dev/render.html only; never part of the app bundle — the app runs the real solver in src/sim).
 *
 * MockFloodSolver — a FloodSolver stand-in for renderer development and screenshots. It does NOT solve the
 * shallow-water equations: the water state is an animated analytic field computed by a compute shader
 * (a river whose stage rises and falls over the floodplain, a fast steep creek, swirling flow), written
 * into ping-pong textures exactly like the real solver so the renderer's per-texture caching is exercised.
 */
import type {
  BrushOp,
  FloodSolver,
  SimParams,
  SimSnapshot,
  SimStats,
  StepInfo,
  StormCell,
  TerrainData,
  WaterSource,
} from '../src/contracts';
import { DEFAULT_SIM_PARAMS } from '../src/contracts';
import { buildMockImagery, buildMockTerrain, type MockTerrain } from './render.mockTerrain';

const MOCK_WGSL = /* wgsl */ `
struct M {
  n: i32,
  resetMax: i32,
  cellSize: f32,
  time: f32,
  stage: f32,
  levelTop: f32,
  levelDrop: f32,
  creekFlow: f32,
}
@group(0) @binding(0) var<uniform> U: M;
@group(0) @binding(1) var bedTex: texture_2d<f32>;
@group(0) @binding(2) var flowTex: texture_2d<f32>;
@group(0) @binding(3) var prevTex: texture_2d<f32>;
@group(0) @binding(4) var outTex: texture_storage_2d<rgba32float, write>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let c = vec2i(gid.xy);
  if (c.x >= U.n || c.y >= U.n) { return; }
  let bed = textureLoad(bedTex, c, 0).r;
  let f = textureLoad(flowTex, c, 0);
  let p = vec2f(c) + 0.5;
  let v = p.y / f32(U.n);
  let level = U.levelTop - U.levelDrop * v + U.stage;
  var h = max(0.0, level - bed) * smoothstep(0.3, 0.7, f.r);
  var speed = 0.0;
  var dir = f.ba;
  if (h > 0.0) {
    // Channel flow is fast and deep; floodplain sheet flow is slow.
    speed = 0.25 + 2.1 * sqrt(clamp(h / 7.0, 0.0, 1.0));
  }
  let creekH = f.g * U.creekFlow * (0.55 + 0.25 * sin(U.time * 1.7 + p.y * 0.21));
  if (creekH > h) {
    h = creekH;
    speed = 4.2 + 1.2 * sin(U.time * 0.9 + p.y * 0.07 + p.x * 0.03);
  }
  // Swirl: rotate the flow direction by a slowly varying angle.
  let ang = 0.45 * sin(p.x * 0.045 + U.time * 0.35) * cos(p.y * 0.038 - U.time * 0.27);
  let cs = cos(ang);
  let sn = sin(ang);
  dir = vec2f(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs);
  var maxD = textureLoad(prevTex, c, 0).a;
  if (U.resetMax == 1) { maxD = 0.0; }
  maxD = max(maxD, h);
  if (h < 1e-3) { speed = 0.0; }
  textureStore(outTex, c, vec4f(h, dir * speed, maxD));
}
`;

export interface MockSolverOptions {
  n?: number;
  /** River stage above normal (m). If undefined the stage animates. */
  stage?: number;
}

export class MockFloodSolver implements FloodSolver {
  readonly nx: number;
  readonly ny: number;
  readonly cellSize: number;
  readonly bedTexture: GPUTexture;
  readonly barrierTexture: GPUTexture;
  params: SimParams = { ...DEFAULT_SIM_PARAMS };
  /** Fixed stage (m above normal) or null to animate. */
  stage: number | null;
  /** Animation clock (s). */
  time = 0;
  creekFlow = 1;

  private stateTex: GPUTexture[];
  private cur = 0;
  private pipeline: GPUComputePipeline;
  private uniform: GPUBuffer;
  private flowTex: GPUTexture;
  private bindGroups: GPUBindGroup[] = [];
  private resetMax = true;
  private snapshot: SimSnapshot | null = null;
  private snapshotAt = -1;
  private bedCPU: Float32Array;

  constructor(
    readonly device: GPUDevice,
    readonly mock: MockTerrain,
    opts: MockSolverOptions = {},
  ) {
    const n = mock.n;
    this.nx = n;
    this.ny = n;
    this.cellSize = mock.cellSize;
    this.stage = opts.stage ?? null;
    this.bedCPU = new Float32Array(n * n);
    for (let i = 0; i < n * n; i++) this.bedCPU[i] = mock.ground[i] + mock.barrier[i];
    const mk = (label: string, format: GPUTextureFormat, usage: number) =>
      device.createTexture({ label, size: [n, n], format, usage: usage | GPUTextureUsage.TEXTURE_BINDING });
    this.bedTexture = mk('mock-bed', 'r32float', GPUTextureUsage.COPY_DST);
    this.barrierTexture = mk('mock-barrier', 'r32float', GPUTextureUsage.COPY_DST);
    this.flowTex = mk('mock-flow', 'rgba32float', GPUTextureUsage.COPY_DST);
    device.queue.writeTexture({ texture: this.bedTexture }, this.bedCPU, { bytesPerRow: 4 * n }, [n, n]);
    device.queue.writeTexture({ texture: this.barrierTexture }, mock.barrier as Float32Array<ArrayBuffer>, { bytesPerRow: 4 * n }, [n, n]);
    device.queue.writeTexture({ texture: this.flowTex }, mock.flow as Float32Array<ArrayBuffer>, { bytesPerRow: 16 * n }, [n, n]);
    this.stateTex = [0, 1].map((i) => mk(`mock-state${i}`, 'rgba32float', GPUTextureUsage.STORAGE_BINDING));
    const module = device.createShaderModule({ code: MOCK_WGSL, label: 'mock-solver' });
    this.pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    for (let i = 0; i < 2; i++) {
      this.bindGroups.push(
        device.createBindGroup({
          layout: this.pipeline.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: this.uniform } },
            { binding: 1, resource: this.bedTexture.createView() },
            { binding: 2, resource: this.flowTex.createView() },
            { binding: 3, resource: this.stateTex[i].createView() },
            { binding: 4, resource: this.stateTex[1 - i].createView() },
          ],
        }),
      );
    }
    this.step(0);
  }

  get stateTexture(): GPUTexture {
    return this.stateTex[this.cur];
  }

  currentStage(): number {
    return this.stage ?? 3.4 - 3.4 * Math.cos((this.time * Math.PI * 2) / 40);
  }

  setSources(_sources: WaterSource[]): void {}
  setStorms(_storms: StormCell[]): void {}

  applyBrush(op: BrushOp): void {
    const n = this.nx;
    const g = this.mock.ground;
    const b = this.mock.barrier;
    let y0 = n;
    let y1 = -1;
    const smooth = (e0: number, e1: number, x: number) => {
      const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
      return t * t * (3 - 2 * t);
    };
    const visit = (ax: number, ay: number, bx: number, by: number, r: number, fn: (idx: number, d: number) => void) => {
      const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 2));
      const i1 = Math.min(n - 1, Math.ceil(Math.max(ax, bx) + r + 2));
      const j0 = Math.max(0, Math.floor(Math.min(ay, by) - r - 2));
      const j1 = Math.min(n - 1, Math.ceil(Math.max(ay, by) + r + 2));
      y0 = Math.min(y0, j0);
      y1 = Math.max(y1, j1);
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const px = i + 0.5;
          const py = j + 0.5;
          const vx = bx - ax;
          const vy = by - ay;
          const l2 = vx * vx + vy * vy || 1;
          const t = Math.min(1, Math.max(0, ((px - ax) * vx + (py - ay) * vy) / l2));
          fn(j * n + i, Math.hypot(px - ax - vx * t, py - ay - vy * t));
        }
      }
    };
    if (op.kind === 'wall') {
      visit(op.ax, op.ay, op.bx, op.by, op.radius, (idx, d) => {
        const w = 1 - smooth(op.radius, op.radius + 1, d);
        if (w > 0) b[idx] = Math.max(b[idx], op.height * w);
      });
    } else if (op.kind === 'eraseWall') {
      visit(op.ax, op.ay, op.bx, op.by, op.radius, (idx, d) => {
        if (d <= op.radius + 0.5) b[idx] = 0;
      });
    } else if (op.kind === 'terrain') {
      visit(op.gx, op.gy, op.gx, op.gy, op.radius, (idx, d) => {
        g[idx] += op.delta * (1 - smooth(0, op.radius, d));
      });
    } else {
      return;
    }
    if (y1 < y0) return;
    for (let j = y0; j <= y1; j++) {
      for (let i = 0; i < n; i++) this.bedCPU[j * n + i] = g[j * n + i] + b[j * n + i];
    }
    const rows = y1 - y0 + 1;
    this.device.queue.writeTexture({ texture: this.bedTexture, origin: [0, y0] }, this.bedCPU, { offset: y0 * n * 4, bytesPerRow: 4 * n }, [n, rows]);
    this.device.queue.writeTexture({ texture: this.barrierTexture, origin: [0, y0] }, b as Float32Array<ArrayBuffer>, { offset: y0 * n * 4, bytesPerRow: 4 * n }, [n, rows]);
    this.snapshotAt = -1;
  }

  step(realSeconds: number): StepInfo {
    this.time += realSeconds;
    const u = new ArrayBuffer(32);
    const i32 = new Int32Array(u);
    const f32 = new Float32Array(u);
    i32[0] = this.nx;
    i32[1] = this.resetMax ? 1 : 0;
    f32[2] = this.cellSize;
    f32[3] = this.time;
    f32[4] = this.currentStage();
    f32[5] = this.mock.riverLevel(0);
    f32[6] = this.mock.riverLevel(0) - this.mock.riverLevel(this.nx);
    f32[7] = this.creekFlow;
    this.device.queue.writeBuffer(this.uniform, 0, u);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroups[this.cur]);
    pass.dispatchWorkgroups(Math.ceil(this.nx / 16), Math.ceil(this.ny / 16));
    pass.end();
    this.device.queue.submit([enc.finish()]);
    this.cur = 1 - this.cur;
    this.resetMax = false;
    return { simSecondsAdvanced: realSeconds, substeps: 1, dt: realSeconds, throttled: false };
  }

  reset(): void {
    this.resetMax = true;
    this.time = 0;
  }

  setInitialWater(_depth: Float32Array): void {}

  /** CPU copy of the analytic depth (refreshed at most twice a second). */
  getSnapshot(): SimSnapshot | null {
    if (this.snapshot && this.time - this.snapshotAt < 0.5 && this.snapshotAt >= 0) return this.snapshot;
    const n = this.nx;
    const depth = this.snapshot?.depth ?? new Float32Array(n * n);
    const stage = this.currentStage();
    const top = this.mock.riverLevel(0);
    const drop = top - this.mock.riverLevel(n);
    const F = this.mock.flow;
    let maxDepth = 0;
    let volume = 0;
    let wet = 0;
    for (let j = 0; j < n; j++) {
      const level = top - (drop * (j + 0.5)) / n + stage;
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        const t = Math.min(1, Math.max(0, (F[idx * 4] - 0.3) / 0.4));
        let h = Math.max(0, level - this.bedCPU[idx]) * t * t * (3 - 2 * t);
        h = Math.max(h, F[idx * 4 + 1] * this.creekFlow * 0.55);
        depth[idx] = h;
        if (h > maxDepth) maxDepth = h;
        volume += h;
        if (h > 0.01) wet++;
      }
    }
    const area = this.cellSize * this.cellSize;
    const stats: SimStats = {
      simTime: this.time,
      maxDepth,
      maxSpeed: 5.4,
      volume: volume * area,
      wetArea: wet * area,
      floodedArea: 0,
      volumeIn: 0,
      volumeOut: 0,
      massError: 0,
      courant: 0.7,
    };
    this.snapshot = { simTime: this.time, nx: n, ny: n, depth, stats };
    this.snapshotAt = this.time;
    return this.snapshot;
  }

  getGroundCPU(): Float32Array {
    return this.mock.ground;
  }

  getBarrierCPU(): Float32Array {
    return this.mock.barrier;
  }

  destroy(): void {
    this.bedTexture.destroy();
    this.barrierTexture.destroy();
    this.flowTex.destroy();
    this.stateTex.forEach((t) => t.destroy());
    this.uniform.destroy();
  }
}

/** Build a complete mock scene: terrain data (with procedural imagery) + mock solver. */
export async function createMockScene(
  device: GPUDevice,
  opts: MockSolverOptions & { imagery?: boolean; roads?: boolean } = {},
): Promise<{ terrain: TerrainData; solver: MockFloodSolver; mock: MockTerrain }> {
  const n = opts.n ?? 1024;
  const mock = buildMockTerrain(n);
  const imagery = opts.imagery === false ? null : await buildMockImagery(mock);
  const elevation = new Float32Array(n * n);
  elevation.set(mock.ground);
  const terrain: TerrainData = {
    name: 'Synthetic valley (render harness)',
    nx: n,
    ny: n,
    cellSize: mock.cellSize,
    elevation,
    bounds: { west: -80.1, south: 40.4, east: -80.0, north: 40.48 },
    imagery,
    roads: opts.roads === false ? null : mock.roads,
    attribution: 'Procedural test terrain',
    scenario: null,
  };
  const solver = new MockFloodSolver(device, mock, opts);
  return { terrain, solver, mock };
}
