/**
 * A/B cost of the land-surface layers (ARCHITECTURE.md §3.11), interleaved so that drift and other GPU users hit both
 * sides alike: two solvers on the same grid — plain, and with a layer on — alternate batches of substeps, and the
 * median ratio of their batch times is reported.
 *
 *   node --import tsx tests/sim/benchLand.ts            # 1024², valley (mostly dry) and every-cell-wet
 *   node --import tsx tests/sim/benchLand.ts 512 9      # size, number of interleaved rounds
 */
import { getGpu } from '../helpers/gpu';
import { createSolver, type GpuFloodSolver } from '../../src/sim';
import type { LandSurface } from '../../src/contracts';

const n = Number(process.argv[2] ?? 1024);
const rounds = Number(process.argv[3] ?? 11);

function valley(wetAll: boolean) {
  const elevation = new Float32Array(n * n);
  const depth = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = i / n;
      const y = j / n;
      const river = 0.5 + 0.12 * Math.sin(y * 6.0);
      const d = Math.abs(x - river);
      const z = 200 - 25 * y + 120 * d * d * 4 + 6 * Math.sin(x * 40) * Math.cos(y * 33) + 2 * Math.sin((x + y) * 170);
      elevation[j * n + i] = z;
      depth[j * n + i] = wetAll ? 0.5 : d < 0.08 ? Math.max(0, 200 - 25 * y + 3 - z) : 0;
    }
  }
  return { elevation, depth };
}

function layers(depth: Float32Array): Record<string, LandSurface> {
  const N = n * n;
  const roughness = new Float32Array(N);
  const drainCapacity = new Float32Array(N);
  const obstacles = new Float32Array(N);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      const patch = ((i >> 3) * 7 + (j >> 3) * 13) % 10;
      roughness[c] = 0.02 + 0.013 * patch;
      drainCapacity[c] = patch < 7 ? 30 : 0;
      if (i % 6 < 3 && j % 6 < 3 && depth[c] === 0) obstacles[c] = 10;
    }
  }
  // Porosity: a half-covered ring of cells round every block (the pattern src/data/porosity.ts gives a city), roofs
  // shedding into their own open half.
  const cell = new Float32Array(N).fill(1);
  const faceE = new Float32Array(N).fill(1);
  const faceS = new Float32Array(N).fill(1);
  const roof = new Float32Array(N);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      if (obstacles[c] > 0 || depth[c] > 0 || i < 3 || j < 3 || i >= n - 3 || j >= n - 3) continue;
      if (i % 6 < 4 && j % 6 < 4) {
        cell[c] = 0.5;
        roof[c] = 0.5;
      }
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = j * n + i;
      if (i < n - 1) faceE[c] = Math.min(cell[c], cell[c + 1]);
      if (j < n - 1) faceS[c] = Math.min(cell[c], cell[c + n]);
    }
  }
  const porosity = { cell, faceE, faceS, roof, spout: roof.slice() };
  return {
    roughness: { roughness },
    drains: { drainCapacity },
    obstacles: { obstacles },
    'buildings (blocks + porosity)': { obstacles, porosity },
    all: { roughness, drainCapacity, obstacles, porosity },
  };
}

async function main() {
  const { device, description } = await getGpu();
  console.log(`GPU: ${description}; ${n}², ${rounds} interleaved rounds`);
  for (const wetAll of [false, true]) {
    const v = valley(wetAll);
    const make = async (l: LandSurface | null): Promise<GpuFloodSolver> => {
      const s = await createSolver(device, { nx: n, ny: n, cellSize: 8192 / n, elevation: v.elevation }, { rainRate: 50, boundary: 'open' }, { gpuBudgetMs: Infinity });
      s.setInitialWater(v.depth);
      s.setSources([{ id: 'in', type: 'inflow', gx: n / 2, gy: 4, radius: 6, discharge: 400 }]);
      if (l) s.setLandSurface(l);
      return s;
    };
    const plain = await make(null);
    const dt = plain.computeDt();
    const time = async (s: GpuFloodSolver, k: number) => {
      const t0 = performance.now();
      s.runSubsteps(k, dt);
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    };
    for (const [name, l] of Object.entries(layers(v.depth))) {
      const other = await make(l);
      await time(plain, 50);
      await time(other, 50);
      const ratios: number[] = [];
      const base: number[] = [];
      const batch = 200;
      for (let r = 0; r < rounds; r++) {
        const a = await time(plain, batch);
        const b = await time(other, batch);
        ratios.push(b / a);
        base.push(a / batch);
      }
      ratios.sort((x, y) => x - y);
      base.sort((x, y) => x - y);
      const med = ratios[ratios.length >> 1];
      console.log(
        `  ${wetAll ? 'every cell wet' : 'valley        '}  ${name.padEnd(10)}  ${((med - 1) * 100).toFixed(1).padStart(5)} % per substep ` +
          `(ratio p25–p75 ${ratios[Math.floor(ratios.length / 4)].toFixed(3)}–${ratios[Math.floor((3 * ratios.length) / 4)].toFixed(3)}; plain ${base[base.length >> 1].toFixed(2)} ms/substep)`,
      );
      other.destroy();
    }
    plain.destroy();
  }
  process.exit(0);
}

void main();
