/**
 * Run one preset's scenario on the real GPU (Dawn in Node, the same `src/sim` solver the app ships) and return the
 * fields the validation scores need. Used by scripts/validate.ts and tests/validation/regression.test.ts.
 *
 * The scene is set up exactly as the app's SceneManager + App do it (src/app/scene.ts, App.advanceStage):
 *  • the solver from the preset's DEM with DEFAULT_SIM_PARAMS plus the scenario's rain (Manning n 0.035, robust mode,
 *    open boundaries — what the app ships), GPU work budget off as in APP_CONFIG.solverOptions;
 *  • the initial fill (computeInitialWater), the scenario's rheology (applyScenarioRheology), its sources and storms;
 *  • a stage target reached through the app's StageRamp (3 m per sim-minute) and pushed at its 5 cm granularity, with
 *    the channel raise of src/app/crest.ts — then held;
 *  • the state exported every `tick` simulated seconds (the app exports once per rendered frame, ~1–2 sim-s at the
 *    speeds it runs): the max-depth and hazard accumulators are sampled at exports, so this matters.
 * What the app has and this does not: frame pacing (the app may drop backlog when throttled; this runs every CFL
 * substep) and the climate selector (validation runs today's climate).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSolver, type GpuFloodSolver } from '../../src/sim';
import { channelBaseSurface } from '../../src/app/crest';
import { StageRamp } from '../../src/app/stageRamp';
import { StageLevels, stageOffsetForFeet } from '../../src/app/stage';
import { computeInitialWater } from '../../src/data/initialWater';
import { decodeElevation, type PresetMeta } from '../../src/data/presets';
import { footprintRadius } from '../../src/sim/forcing';
import type { LandSurface, SimParams, SimStats } from '../../src/contracts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** One validation run of a preset. */
export interface RunDef {
  id: string;
  description: string;
  /** Simulated minutes of forcing (event runs), or of holding the stage after it has arrived (stage runs). */
  minutes: number;
  /** Stage runs: the gauge reading to raise the river to, ft above the gauge datum. */
  stageFt?: number;
  /** Stage runs: the target as a water-surface elevation, m (converted with the preset's gauge datum). */
  stageLevel?: number;
  /** Sensitivity runs only: solver parameters to override (e.g. Manning's n). The validation runs use none. */
  params?: Partial<SimParams>;
  /** Sensitivity runs only: land-surface layers (FloodSolver.setLandSurface; scripts/validation/landsurface.ts). */
  landSurface?: LandSurface;
}

export interface PresetData {
  id: string;
  meta: PresetMeta;
  elevation: Float32Array;
  initialWater: Float32Array;
}

export function loadPresetData(id: string): PresetData {
  const dir = path.join(ROOT, 'public/presets', id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as PresetMeta;
  const raw = fs.readFileSync(path.join(dir, meta.files.elevation));
  const elevation = decodeElevation(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength), meta.nx, meta.ny);
  const initialWater = computeInitialWater({ nx: meta.nx, ny: meta.ny, elevation }, meta.scenario);
  return { id, meta, elevation, initialWater };
}

export interface RunOutput {
  run: RunDef;
  simTime: number;
  substeps: number;
  wallSeconds: number;
  stats: SimStats;
  /** Stage offset applied at the end, m (stage runs), and the gauge reading it is. */
  stageOffset: number | null;
  stageFt: number | null;
  maxDepth: Float32Array;
  ground: Float32Array;
  nonFinite: number;
}

/** Cells under the stage-boundary discs (the solver relaxes them to the stage level): left out of extent scores. */
export function stageDiscMask(p: PresetData): Uint8Array {
  const { nx, ny } = p.meta;
  const out = new Uint8Array(nx * ny);
  for (const s of p.meta.scenario.sources) {
    if (s.type !== 'stage') continue;
    const R = footprintRadius(s.radius) + 1;
    for (let j = Math.max(0, Math.floor(s.gy - R)); j <= Math.min(ny - 1, Math.ceil(s.gy + R)); j++) {
      for (let i = Math.max(0, Math.floor(s.gx - R)); i <= Math.min(nx - 1, Math.ceil(s.gx + R)); i++) {
        if (Math.hypot(i + 0.5 - s.gx, j + 0.5 - s.gy) <= R) out[j * nx + i] = 1;
      }
    }
  }
  return out;
}

const STAGE_PUSH_STEP_M = 0.05;

export async function runScenario(
  device: GPUDevice,
  p: PresetData,
  run: RunDef,
  opts: { tick?: number; sample?: number; log?: (s: string) => void } = {},
): Promise<RunOutput> {
  const tick = opts.tick ?? 2;
  const sampleEvery = opts.sample ?? 10;
  const { meta } = p;
  const sc = meta.scenario;
  const params: Partial<SimParams> = { rainRate: sc.rainRate, boundary: 'open', ...run.params };
  const solver: GpuFloodSolver = await createSolver(
    device,
    { nx: meta.nx, ny: meta.ny, cellSize: meta.cellSize, elevation: p.elevation },
    params,
    { gpuBudgetMs: Infinity },
  );
  try {
    solver.setInitialWater(p.initialWater);
    if (run.landSurface) solver.setLandSurface(run.landSurface);
    // src/app/scene.ts applyScenarioRheology (not imported: scene.ts pulls in the browser-only loaders).
    const chain = sc.hazardChain;
    if (chain?.rheology) solver.setRheology(chain.rheology, chain.solver);
    else solver.setRheology({ kind: 'water' });
    const sources = sc.sources.map((s) => ({ ...s }));
    const levels = new StageLevels();
    levels.resetFrom(sources);
    solver.setSources(levels.apply(sources, 0));
    solver.setStorms(sc.storms.map((s) => ({ ...s })));

    let target = 0;
    if (run.stageFt !== undefined || run.stageLevel !== undefined) {
      if (!sc.stage) throw new Error(`${p.id}: run ${run.id} sets a stage but the scenario has no stage control`);
      target = run.stageLevel !== undefined ? run.stageLevel - sc.stage.normalLevel : stageOffsetForFeet(sc.stage, run.stageFt as number);
    }
    const ramp = new StageRamp();
    ramp.setTarget(target);
    const ground = solver.getGroundCPU();
    const channelBase = target !== 0 ? channelBaseSurface(p.initialWater, (k) => ground[k], meta.nx, meta.ny, sources) : null;
    if (channelBase) solver.prepareRaiseSurface(channelBase);
    let pushed = 0;

    const t0 = performance.now();
    let simTime = 0;
    let substeps = 0;
    let nextSample = 0;
    let arrivedAt: number | null = target === 0 ? 0 : null;
    let lastLog = t0;
    await solver.readbackNow();
    nextSample = sampleEvery;
    const limit = 6 * 3600;
    for (;;) {
      const end = arrivedAt === null ? limit : arrivedAt + run.minutes * 60;
      if (simTime >= end - 1e-9) break;
      const dtTick = Math.min(tick, end - simTime);
      if (target !== 0 && ramp.advance(dtTick)) {
        if (Math.abs(ramp.applied - pushed) >= STAGE_PUSH_STEP_M || !ramp.moving) {
          pushed = ramp.applied;
          solver.setSources(levels.apply(sources, pushed));
          if (channelBase) solver.raiseWaterSurface(channelBase, pushed);
        }
      }
      if (arrivedAt === null && !ramp.moving && Math.abs(pushed - target) < 1e-6) arrivedAt = simTime;
      // Whole substeps at the solver's own CFL timestep plus one short remainder, as scripts/reference-run.ts does.
      const cfl = solver.computeDt();
      const k = Math.floor(dtTick / cfl);
      if (k >= 1) {
        solver.runSubsteps(k, cfl);
        substeps += k;
        const rem = dtTick - k * cfl;
        if (rem > 1e-6) {
          solver.runSubsteps(1, rem);
          substeps++;
        }
      } else {
        solver.runSubsteps(1, dtTick);
        substeps++;
      }
      simTime += dtTick;
      // Export the state (the app does this once per rendered frame): the max-depth accumulator is sampled here.
      void solver.stateTexture;
      if (simTime >= nextSample - 1e-9) {
        await solver.readbackNow();
        nextSample = simTime + sampleEvery;
        const now = performance.now();
        if (opts.log && now - lastLog > 20000) {
          lastLog = now;
          opts.log(`    ${p.id}/${run.id}: sim ${(simTime / 60).toFixed(1)} min, ${substeps} substeps, ${((now - t0) / 1000).toFixed(0)} s`);
        }
      }
    }
    const snap = await solver.readbackNow();
    const fields = await solver.readHazardFields();
    await solver.flush();
    let nonFinite = 0;
    for (let c = 0; c < fields.maxDepth.length; c++) if (!Number.isFinite(fields.maxDepth[c])) nonFinite++;
    return {
      run,
      simTime,
      substeps,
      wallSeconds: (performance.now() - t0) / 1000,
      stats: { ...snap.stats },
      stageOffset: target !== 0 ? pushed : null,
      stageFt: sc.stage && target !== 0 ? (sc.stage.normalLevel + pushed - sc.stage.gaugeDatum) / 0.3048 : null,
      maxDepth: Float32Array.from(fields.maxDepth),
      ground: Float32Array.from(solver.getGroundCPU()),
      nonFinite,
    };
  } finally {
    solver.destroy();
  }
}
