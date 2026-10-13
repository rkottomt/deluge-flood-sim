/**
 * The land-surface layers (ARCHITECTURE.md §3.11) against the observed floods of docs/VALIDATION.md: every scene with
 * observations is re-run with building obstacles, the land-cover roughness map and storm drains switched on alone and
 * together, through the same runs and the same scoring as scripts/validate.ts.
 *
 *   npx tsx scripts/validation/landsurface.ts                          # every scene with observations, every variant
 *   npx tsx scripts/validation/landsurface.ts --preset=houston --variants=base,drains
 *   npx tsx scripts/validation/landsurface.ts --hold-scale=3   # sensitivity only: every run held 3× as long
 *
 * Scoring with buildings blocked: the solver keeps water out of a footprint, while FEMA's zone maps the land the
 * buildings stand on. So before scoring, a blocked cell takes the water surface of its wettest open neighbour (filled
 * inward cell by cell), i.e. "would this cell be under water if the building were not there" — the same surface a
 * high-water mark on the building's wall records. Bare-earth runs are scored exactly as scripts/validate.ts scores them.
 *
 * Output: artifacts/validation/landsurface.json and a markdown table on stdout. Nothing the app reads is written.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { create, globals } from 'webgpu';
import { createDelugeDevice } from '../../src/gpu';
import { buildLandSurface, type LandSurfaceFlags } from '../../src/app/landSurface';
import { type CompactBuildings, decodeBuildings, rasterizeBuildingHeights } from '../../src/data/buildings';
import { decodeLandCover } from '../../src/data/landcover';
import type { TerrainData } from '../../src/contracts';
import type { ObservedFile } from '../../src/validation/types';
import { PLANS, scorePreset, summarise } from '../validate';
import { loadPresetData, runScenario, type PresetData, type RunOutput } from './run';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (name: string, d: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;

const VARIANTS: Record<string, LandSurfaceFlags> = {
  base: { buildings: false, roughness: false, drains: false },
  buildings: { buildings: true, roughness: false, drains: false },
  roughness: { buildings: false, roughness: true, drains: false },
  'buildings+roughness': { buildings: true, roughness: true, drains: false },
  drains: { buildings: false, roughness: false, drains: true },
  all: { buildings: true, roughness: true, drains: true },
};
/** Scenes with observations; drains only matter where it rains (Houston). */
const SCENES: Record<string, string[]> = {
  ftmyers: ['base', 'buildings', 'roughness', 'buildings+roughness'],
  nashville: ['base', 'buildings', 'roughness', 'buildings+roughness'],
  pittsburgh: ['base', 'buildings', 'roughness', 'buildings+roughness'],
  asheville: ['base', 'buildings', 'roughness', 'buildings+roughness'],
  houston: ['base', 'buildings', 'roughness', 'drains', 'all'],
};

function terrainOf(p: PresetData): TerrainData {
  const dir = path.join(ROOT, 'public/presets', p.id);
  const m = p.meta;
  const buildings = m.files.buildings
    ? decodeBuildings(JSON.parse(fs.readFileSync(path.join(dir, m.files.buildings), 'utf8')) as CompactBuildings)
    : null;
  if (buildings) buildings.heightRaster = rasterizeBuildingHeights(buildings, m.nx, m.ny);
  let landCover = null;
  if (m.files.landcover && m.landcover) {
    const b = fs.readFileSync(path.join(dir, m.files.landcover));
    landCover = decodeLandCover(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), m.landcover);
  }
  return {
    name: m.name,
    nx: m.nx,
    ny: m.ny,
    cellSize: m.cellSize,
    elevation: p.elevation,
    bounds: m.bounds,
    imagery: null,
    roads: null,
    buildings,
    landCover,
    attribution: m.attribution,
    scenario: m.scenario,
  };
}

/**
 * Blocked cells take the water surface of their wettest open 4-neighbour (minus their own ground), filled inward until
 * every reachable blocked cell has one; cells no wet water surface reaches stay dry.
 */
export function fillBlocked(maxDepth: Float32Array, ground: Float32Array, blocked: Float32Array, nx: number, ny: number): Float32Array {
  const out = Float32Array.from(maxDepth);
  const wse = new Float64Array(out.length).fill(NaN);
  for (let c = 0; c < out.length; c++) if (!(blocked[c] > 0) && out[c] > 0) wse[c] = ground[c] + out[c];
  let frontier: number[] = [];
  for (let c = 0; c < out.length; c++) if (blocked[c] > 0) frontier.push(c);
  for (let pass = 0; pass < 64 && frontier.length; pass++) {
    const next: number[] = [];
    const set: Array<[number, number]> = [];
    for (const c of frontier) {
      const i = c % nx;
      const j = (c - i) / nx;
      let best = NaN;
      for (const n of [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1]) {
        if (n >= 0 && wse[n] === wse[n] && !(wse[n] <= best)) best = wse[n];
      }
      if (best === best) set.push([c, best]);
      else next.push(c);
    }
    if (!set.length) break;
    for (const [c, w] of set) {
      wse[c] = w;
      out[c] = Math.max(0, w - ground[c]);
    }
    frontier = next;
  }
  return out;
}

async function main() {
  Object.assign(globalThis, globals);
  const gpu = create([]);
  const { device, description } = await createDelugeDevice(gpu);
  const only = arg('preset', Object.keys(SCENES).join(',')).split(',');
  const onlyVariants = arg('variants', '');
  // Sensitivity only (not the validation protocol): every run's minutes × this, to see what the fixed hold costs a layer.
  const holdScale = Number(arg('hold-scale', '1'));
  const rows: Array<{ preset: string; variant: string; metrics: Record<string, number | null>; headline: string; massError: number; blockedCells: number }> = [];
  for (const id of only) {
    const plan = PLANS[id];
    const obs = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/validation', id, 'observed.json'), 'utf8')) as ObservedFile;
    const p = loadPresetData(id);
    const terrain = terrainOf(p);
    for (const v of SCENES[id].filter((x) => !onlyVariants || onlyVariants.split(',').includes(x))) {
      const layers = buildLandSurface(terrain, p.initialWater, VARIANTS[v]);
      const outputs = new Map<string, RunOutput>();
      let massError = 0;
      for (const run of plan.runs(obs)) {
        const o = await runScenario(device, p, { ...run, minutes: run.minutes * holdScale, landSurface: layers });
        massError = Math.max(massError, o.stats.massError);
        const maxDepth = layers.obstacles ? fillBlocked(o.maxDepth, o.ground, layers.obstacles, p.meta.nx, p.meta.ny) : o.maxDepth;
        outputs.set(run.id, { ...o, maxDepth });
      }
      const { result } = scorePreset(p, obs, plan, outputs);
      const s = summarise(result);
      const blockedCells = layers.obstacles ? layers.obstacles.reduce((n, x, c) => n + (x > 0 && !(p.initialWater[c] >= 0.01) ? 1 : 0), 0) : 0;
      rows.push({ preset: id, variant: v, metrics: s.metrics, headline: s.headline?.value ?? '', massError, blockedCells });
      const m = s.metrics;
      const f = (k: string, d = 2) => (m[k] === null || m[k] === undefined ? '—' : (m[k] as number).toFixed(d));
      const parts = [
        m['hwm.bias'] !== undefined ? `HWM bias ${f('hwm.bias')} RMSE ${f('hwm.rmse')} dry ${f('hwm.dry', 0)}` : '',
        m['fema.connected.csi'] !== undefined ? `FEMA CSI ${f('fema.connected.csi', 3)} hit ${f('fema.connected.hitRate', 3)} FAR ${f('fema.connected.falseAlarmRatio', 3)} (all-zone hit ${f('fema.all.hitRate', 3)} FAR ${f('fema.all.falseAlarmRatio', 3)})` : '',
        m['bfe.bias'] !== undefined ? `BFE bias ${f('bfe.bias')} RMSE ${f('bfe.rmse')}` : '',
        m['gauges.bias'] !== undefined ? `gauges ${Object.keys(m).filter((k) => /^gauge\..*residual$/.test(k)).map((k) => f(k)).join(' / ')}` : '',
      ].filter(Boolean);
      console.log(`${id.padEnd(11)} ${v.padEnd(20)} ${parts.join(' · ')}  (mass error ${massError.toExponential(1)})`);
    }
  }
  const out = path.join(ROOT, 'artifacts/validation');
  fs.mkdirSync(out, { recursive: true });
  const file = holdScale === 1 ? 'landsurface.json' : `landsurface-hold${holdScale}.json`;
  fs.writeFileSync(path.join(out, file), JSON.stringify({ gpu: description, at: new Date().toISOString(), holdScale, rows }, null, 1));
  console.log(`\n→ artifacts/validation/${file}`);
  await device.queue.onSubmittedWorkDone();
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
