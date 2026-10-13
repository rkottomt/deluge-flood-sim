/**
 * What the land-surface layers (ARCHITECTURE.md §3.11) do to two shipped scenarios, measured headless on the GPU:
 * Pittsburgh at the 1936 crest and Houston under Harvey's worst hour. Each layer is switched on alone and together,
 * on the same terrain, forcing and timestep rule, and the run reports flooded area, street depths, loss and mass error.
 *
 *   npx tsx scripts/landsurface-eval.ts                       # both cases, every variant
 *   npx tsx scripts/landsurface-eval.ts --cases=houston --variants=base,all --minutes=30
 *
 * The forcing is the app's: Pittsburgh's stage ramps from normal pool to 46 ft on the Point gauge at the app's rate
 * (src/app/stageRamp.ts) with the channel raise of src/app/crest.ts, then holds; Houston runs its preset as it loads
 * (173 mm/hr and Buffalo Bayou's Harvey peak). Time advances in 5-s ticks of whole CFL substeps plus one short remainder
 * substep (as scripts/reference-run.ts does), the hazard accumulators are sampled at every tick (an export), and a
 * readback refreshes the CFL estimate every 30 simulated seconds. Loss is the app's model (src/loss analyze()).
 * Output: artifacts/landsurface-eval/results.json and a markdown table on stdout.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, globals } from 'webgpu';
import { createDelugeDevice } from '../src/gpu';
import { createSolver } from '../src/sim';
import { channelBaseSurface } from '../src/app/crest';
import { StageRamp } from '../src/app/stageRamp';
import { StageLevels, stageOffsetForFeet } from '../src/app/stage';
import { buildLandSurface, type LandSurfaceFlags } from '../src/app/landSurface';
import { type CompactBuildings, decodeBuildings, rasterizeBuildingHeights } from '../src/data/buildings';
import { computeInitialWater } from '../src/data/initialWater';
import { decodeLandCover } from '../src/data/landcover';
import { decodeElevation, type PresetMeta } from '../src/data/presets';
import { type CompactRoads, decodeRoads } from '../src/data/roads';
import { analyze } from '../src/loss';
import type { TerrainData } from '../src/contracts';

Object.assign(globalThis, globals);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
/** --rain=<mm/hr>: rain-only runs at this rate (e.g. the 2-year 1-hour design storm); unset = the scenario's forcing. */
const RAIN = Number(arg('rain', '-1'));

const VARIANTS: Record<string, LandSurfaceFlags> = {
  base: { buildings: false, roughness: false, drains: false },
  buildings: { buildings: true, roughness: false, drains: false },
  roughness: { buildings: false, roughness: true, drains: false },
  'buildings+roughness': { buildings: true, roughness: true, drains: false },
  drains: { buildings: false, roughness: false, drains: true },
  all: { buildings: true, roughness: true, drains: true },
};

function loadTerrain(id: string): { terrain: TerrainData; meta: PresetMeta; initialWater: Float32Array } {
  const dir = path.join(ROOT, 'public/presets', id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as PresetMeta;
  const ab = (f: string) => {
    const b = fs.readFileSync(path.join(dir, f));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const elevation = decodeElevation(ab(meta.files.elevation), meta.nx, meta.ny);
  const buildings = decodeBuildings(JSON.parse(fs.readFileSync(path.join(dir, meta.files.buildings!), 'utf8')) as CompactBuildings);
  buildings.heightRaster = rasterizeBuildingHeights(buildings, meta.nx, meta.ny);
  const roads = decodeRoads(JSON.parse(fs.readFileSync(path.join(dir, meta.files.roads!), 'utf8')) as CompactRoads);
  const landCover = decodeLandCover(ab(meta.files.landcover!), meta.landcover!);
  const terrain: TerrainData = {
    name: meta.name,
    nx: meta.nx,
    ny: meta.ny,
    cellSize: meta.cellSize,
    elevation,
    bounds: meta.bounds,
    imagery: null,
    roads,
    buildings,
    landCover,
    attribution: meta.attribution,
    scenario: meta.scenario,
  };
  return { terrain, meta, initialWater: computeInitialWater(terrain, meta.scenario) };
}

/** Cells under the road network (polylines sampled every ¼ cell), not wet at reset. */
function roadCells(t: TerrainData, wet0: Float32Array): Uint32Array {
  const set = new Set<number>();
  for (const e of t.roads!.edges) {
    const p = e.pts;
    for (let k = 0; k + 3 < p.length; k += 2) {
      const len = Math.hypot(p[k + 2] - p[k], p[k + 3] - p[k + 1]);
      const n = Math.max(1, Math.ceil(len * 4));
      for (let s = 0; s <= n; s++) {
        const x = p[k] + ((p[k + 2] - p[k]) * s) / n;
        const y = p[k + 1] + ((p[k + 3] - p[k + 1]) * s) / n;
        const i = Math.floor(x);
        const j = Math.floor(y);
        if (i < 0 || j < 0 || i >= t.nx || j >= t.ny) continue;
        const c = j * t.nx + i;
        if (!(wet0[c] >= 0.01)) set.add(c);
      }
    }
  }
  return Uint32Array.from(set);
}

function quantile(v: number[], q: number): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  const x = q * (s.length - 1);
  const i = Math.floor(x);
  return s[i] + (x - i) * ((s[Math.min(s.length - 1, i + 1)] ?? s[i]) - s[i]);
}

async function run(device: GPUDevice, id: 'pittsburgh' | 'houston', variant: string, minutes: number) {
  const { terrain, meta, initialWater } = loadTerrain(id);
  const flags = VARIANTS[variant];
  const { nx, ny, cellSize } = terrain;
  const N = nx * ny;
  const solver = await createSolver(device, terrain, { rainRate: RAIN >= 0 ? RAIN : meta.scenario.rainRate, boundary: 'open' }, { gpuBudgetMs: Infinity });
  solver.setInitialWater(initialWater);
  const layers = buildLandSurface(terrain, initialWater, flags);
  solver.setLandSurface(layers);
  const sources = meta.scenario.sources;
  const levels = new StageLevels();
  levels.resetFrom(sources);
  solver.setSources(levels.apply(sources, 0));
  solver.setStorms(meta.scenario.storms);
  // --rain replaces the scenario's rain and holds the rivers at normal pool (a rain-only run).
  const crest = id === 'pittsburgh' && !(RAIN >= 0);
  const ramp = new StageRamp();
  const stage = meta.scenario.stage;
  const channelBase = crest ? channelBaseSurface(initialWater, (k) => terrain.elevation[k], nx, ny, sources) : null;
  if (crest && stage) {
    ramp.setTarget(stageOffsetForFeet(stage, 46));
    if (channelBase) solver.prepareRaiseSurface(channelBase);
  }
  let pushed = 0;
  const duration = minutes * 60;
  const tick = 5;
  let simTime = 0;
  let nextRead = 0;
  let substeps = 0;
  const t0 = performance.now();
  await solver.readbackNow();
  while (simTime < duration - 1e-9) {
    const dtTick = Math.min(tick, duration - simTime);
    if (crest && ramp.advance(dtTick) && (Math.abs(ramp.applied - pushed) >= 0.05 || !ramp.moving)) {
      pushed = ramp.applied;
      solver.setSources(levels.apply(sources, pushed));
      if (channelBase) solver.raiseWaterSurface(channelBase, pushed);
    }
    const cfl = solver.computeDt();
    const k = Math.floor(dtTick / cfl);
    if (k >= 1) solver.runSubsteps(k, cfl);
    const rem = dtTick - Math.max(0, k) * cfl;
    if (rem > 1e-6) solver.runSubsteps(1, rem);
    substeps += Math.max(0, k) + (rem > 1e-6 ? 1 : 0);
    simTime += dtTick;
    void solver.stateTexture; // export: samples the hazard accumulators every tick
    if (simTime >= nextRead) {
      await solver.readbackNow();
      nextRead = simTime + 30;
    }
  }
  const snap = await solver.readbackNow();
  await solver.flush();
  const wallS = (performance.now() - t0) / 1000;
  const fields = await solver.readHazardFields();
  const blocked = layers.obstacles;
  // Flooded area: land dry at reset whose max depth passed the threshold; "open ground" leaves out every footprint cell
  // (whether or not this run blocks it), so the variants compare over the same cells.
  const raster = terrain.buildings!.heightRaster!;
  let f15 = 0;
  let f50 = 0;
  let o15 = 0;
  let o50 = 0;
  for (let c = 0; c < N; c++) {
    if (initialWater[c] >= 0.01) continue;
    const d = fields.maxDepth[c];
    const open = !(raster[c] > 0);
    if (d > 0.15) {
      f15++;
      if (open) o15++;
    }
    if (d > 0.5) {
      f50++;
      if (open) o50++;
    }
  }
  // Water on roofs (blocked cells): the runoff film, and how many blocked cells ever held 1 cm (the renderer's wet depth).
  let roofMax = 0;
  let roofWet = 0;
  if (blocked) {
    for (let c = 0; c < N; c++) {
      if (!(blocked[c] > 0)) continue;
      roofMax = Math.max(roofMax, fields.maxDepth[c]);
      if (fields.maxDepth[c] >= 0.01) roofWet++;
    }
  }
  const roads = roadCells(terrain, initialWater);
  const roadDepth: number[] = [];
  const roadSpeed: number[] = [];
  let road30 = 0;
  for (const c of roads) {
    if (blocked && blocked[c] > 0) continue;
    const d = fields.maxDepth[c];
    if (d > 0.15) {
      roadDepth.push(d);
      roadSpeed.push(fields.maxSpeed[c]);
    }
    if (d > 0.3) road30++;
  }
  const a = analyze({ fields, terrain, velocityKnown: true, debrisFlow: false });
  const s = a.report!.summary;
  // The same fields read the way an obstacle run reads them (the cells against the walls of every footprint that holds a
  // cell centre), to separate what the sampling rule changes from what the physics changes.
  const ring = new Uint8Array(N);
  for (let c = 0; c < N; c++) if (raster[c] > 0 && !(initialWater[c] >= 0.01)) ring[c] = 1;
  const sRing = blocked ? s : analyze({ fields: { ...fields, blocked: ring, ground: terrain.elevation }, terrain, velocityKnown: true, debrisFlow: false }).report!.summary;
  const km2 = (n: number) => (n * cellSize * cellSize) / 1e6;
  const out = {
    case: id,
    rainMmHr: RAIN >= 0 ? RAIN : meta.scenario.rainRate,
    crest,
    variant,
    minutes,
    blockedCells: blocked ? blocked.reduce((n, v) => n + (v > 0 ? 1 : 0), 0) : 0,
    flooded15km2: km2(f15),
    flooded50km2: km2(f50),
    openFlooded15km2: km2(o15),
    openFlooded50km2: km2(o50),
    roadCellsFlooded: roadDepth.length,
    roadKmOver30cm: (road30 * cellSize) / 1000,
    roadDepthMean: roadDepth.reduce((x, y) => x + y, 0) / Math.max(1, roadDepth.length),
    roadDepthP90: quantile(roadDepth, 0.9),
    roadSpeedP90: quantile(roadSpeed, 0.9),
    maxDepth: snap.stats.maxDepth,
    roofMaxDepth: roofMax,
    roofCellsOver1cm: roofWet,
    volumeOut: snap.stats.volumeOut,
    massError: snap.stats.massError,
    loss: s.loss,
    lossWallSampled: sRing.loss,
    reachedWallSampled: sRing.reached,
    lossLo: s.lossLo,
    lossHi: s.lossHi,
    reached: s.reached,
    damaged: s.damaged,
    destroyed: s.destroyed,
    substeps,
    wallS,
  };
  solver.destroy();
  return out;
}

async function main() {
  const gpu = create([]);
  const { device, description } = await createDelugeDevice(gpu);
  const cases = arg('cases', 'pittsburgh,houston').split(',') as Array<'pittsburgh' | 'houston'>;
  const variants = arg('variants', Object.keys(VARIANTS).join(',')).split(',');
  const results = [];
  for (const c of cases) {
    const minutes = Number(arg('minutes', c === 'pittsburgh' ? '45' : '30'));
    for (const v of variants) {
      if (!VARIANTS[v]) throw new Error(`unknown variant ${v}`);
      const r = await run(device, c, v, minutes);
      console.log(
        `${c.padEnd(10)} ${v.padEnd(20)} flooded ${r.flooded15km2.toFixed(3)} km² (open ${r.openFlooded15km2.toFixed(3)}) ` +
          `>0.5 m ${r.flooded50km2.toFixed(3)}  roads>0.3m ${r.roadKmOver30cm.toFixed(1)} km  road depth mean ${r.roadDepthMean.toFixed(2)} p90 ${r.roadDepthP90.toFixed(2)} m  ` +
          `loss $${(r.loss / 1e9).toFixed(3)} B (wall-sampled $${(r.lossWallSampled / 1e9).toFixed(3)} B)  reached ${r.reached} (${r.reachedWallSampled}) damaged ${r.damaged} destroyed ${r.destroyed}  roof max ${(r.roofMaxDepth * 1000).toFixed(0)} mm (${r.roofCellsOver1cm} cells ≥ 1 cm)  massErr ${r.massError.toExponential(1)}  ${r.substeps} substeps ${r.wallS.toFixed(0)} s`,
      );
      results.push(r);
    }
  }
  const outDir = path.join(ROOT, 'artifacts/landsurface-eval');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, RAIN >= 0 ? `results-rain${RAIN}.json` : 'results.json'), JSON.stringify({ gpu: description, at: new Date().toISOString(), results }, null, 1));
  await device.queue.onSubmittedWorkDone();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
