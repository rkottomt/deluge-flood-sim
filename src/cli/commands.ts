/**
 * The CLI's commands — `presets`, `run`, `portfolio`, `site`, `dam` — written against a small environment (CliEnv) so tests
 * can drive them with a stand-in scene (tests/cli/parity.test.ts) and the real binary drives the GPU (main.ts).
 */
import type { AppState, HazardFields, SimSnapshot, TerrainData, WaterSource } from '../contracts';
import { DEFAULT_SIM_PARAMS } from '../contracts';
import type { ClimateForcing } from '../climate/apply';
import type { ClimateSelection } from '../climate/scenarios';
import { atlas14MayCover, lookupAtlas14, type Atlas14Grid, type Atlas14Point } from '../data/atlas14';
import { isPresetId, listPresets, type PresetMeta } from '../data/presets';
import { makeGeoToGrid } from '../data/geo';
import {
  analyze,
  CSV_LIMITS,
  defaultRanges,
  demSourceOf,
  ENSEMBLE_CAVEAT,
  ENSEMBLE_LIMITS,
  floodedArea,
  memberForcing,
  parsePortfolio,
  RAIN_DESIGN_DURATION_S,
  RAIN_LADDER_CAVEATS,
  RAIN_SWEEP_MINUTES,
  regionForBounds,
  sampleMembers,
  SITE_LIMITS,
  SITE_OCCUPANCIES,
  summarizeMembers,
  type AssetTally,
  type EgressRouter,
  type ForcingState,
  type MemberResult,
  type SiteOccupancy,
  type SiteRun,
  type SiteSpec,
  type SweepLevelInfo,
  type SweepRow,
} from '../loss';
import { egressClause, newSite } from '../loss/site';
import { clearanceSentence, shareOutSentence, timingForRun, type TimingOverrides } from '../loss/egressTiming';
import { DEPARTURE_CURVES, type DepartureCurveId } from '../routing/departure';
import { demPerturbation } from '../sim/demNoise';
import { createRouter } from '../routing';
import { COMMANDS, EXIT, flag, num, str, type ParsedOptions } from './args';
import { assessPortfolioRun, assessSiteForRun, collectMember, debrisFlowFor, newTallies, portfolioCsv, siteRunJson, siteSweepReport } from './assess';
import { chainEnsembleInput, type ChainSetup } from './chain';
import type { ForcingPatch, RunProgress } from './headless';
import { fmtSeconds, toJson, type Log } from './io';
import { geotiffBytes, hazardLayers } from './rasters';
import { buildLadder, feetOf, parseClimate, rainForcing, resolveForcing, scaledForcing, UsageError, type Ladder, type LadderKind, type LadderRung, type ResolvedForcing } from './scenario';
import { SURGE_LADDER_CAVEATS, SURGE_SWEEP_MINUTES } from '../surge/stations';
import { formatMoney } from '../ui/format';
import type { NidIndex } from '../dams/nidIndex';
import { damCommand } from './dam';

const FT = 0.3048;

/** What a command needs from a scene: HeadlessScene on the GPU, or a stand-in in tests. */
export interface SceneLike {
  readonly terrain: TerrainData;
  readonly presetId: string | null;
  readonly chain: ChainSetup | null;
  readonly state: AppState;
  readonly climateForcing: ClimateForcing;
  readonly initialWater: Float32Array;
  readonly frames: number;
  readonly substeps: number;
  setForcing(f: ForcingPatch): void;
  applyPatch(patch: Partial<AppState>): void;
  resetWater(): void;
  runFor(seconds: number, onProgress?: (p: RunProgress) => void): Promise<void>;
  read(): Promise<{ fields: HazardFields; snapshot: SimSnapshot | null }>;
  ground(): Float32Array;
  setBedPerturbation(delta: Float32Array | null): void;
  destroy(): void;
}

export interface CliEnv {
  log: Log;
  version: string;
  /** Preset ids available offline. */
  presetIds(): string[];
  presetMeta(id: string): PresetMeta | null;
  loadTerrain(id: string, onProgress?: (message: string, fraction: number) => void): Promise<TerrainData>;
  /** The baked NOAA Atlas 14 grid (public/atlas14/pf60m-pds.bin, the app's file, decoded by the app's decoder). */
  loadAtlas14(): Promise<Atlas14Grid>;
  /** The baked NID index (public/dams/nid-index.bin, the app's file, decoded by the app's decoder). */
  loadNidIndex(): Promise<NidIndex>;
  openScene(terrain: TerrainData, presetId: string, opts: { climate: ClimateSelection; appCadence: boolean }): Promise<SceneLike>;
  /** Adapter description, for the reports. */
  gpuName(): Promise<string>;
  readText(file: string): string;
  write(file: string, data: string | ArrayBuffer | Uint8Array): void;
  /** Result text for stdout. */
  stdout(text: string): void;
  now(): Date;
}

// ─── Shared ─────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Prepared {
  presetId: string;
  terrain: TerrainData;
  scene: SceneLike;
  resolved: ResolvedForcing;
  durationS: number;
  climate: ClimateSelection;
  loadS: number;
  appCadence: boolean;
  /** NOAA Atlas 14 at the map centre, when a ladder needed it and the map is covered. */
  rain: Atlas14Point | null;
}

/** --preset, checked against the presets on disk (also the API’s first check, src/cli/api.ts). */
export function requirePreset(env: Pick<CliEnv, 'presetIds'>, o: ParsedOptions): string {
  const id = str(o, 'preset');
  if (!id) throw new UsageError('--preset is required (see `deluge presets`)');
  if (!isPresetId(id) || !env.presetIds().includes(id)) throw new UsageError(`unknown preset "${id}" (one of ${env.presetIds().join(', ')})`);
  return id;
}

export function minutesOf(o: ParsedOptions): number {
  const m = num(o, 'minutes') ?? ENSEMBLE_LIMITS.defaultMinutes;
  if (!(m >= ENSEMBLE_LIMITS.minMinutes && m <= ENSEMBLE_LIMITS.maxMinutes)) throw new UsageError(`--minutes must be between ${ENSEMBLE_LIMITS.minMinutes} and ${ENSEMBLE_LIMITS.maxMinutes}`);
  return m;
}

export function scenarioFlags(o: ParsedOptions) {
  return { level: str(o, 'scenario'), stageFt: num(o, 'stage-ft'), rain: num(o, 'rain'), scale: num(o, 'scale'), manning: num(o, 'manning') };
}

/**
 * NOAA Atlas 14 at the centre of a map (where the app's rain ladder reads it, siteCheck.ts mapCentre), from the same
 * baked grid; null outside coverage or when the grid cannot be read (then there is no rain ladder, as in the app).
 */
export async function rainAt(env: Pick<CliEnv, 'loadAtlas14' | 'log'>, b: { north: number; south: number; east: number; west: number }): Promise<Atlas14Point | null> {
  const lat = (b.north + b.south) / 2;
  const lon = (b.east + b.west) / 2;
  if (!atlas14MayCover(lat, lon)) return null;
  try {
    return lookupAtlas14(await env.loadAtlas14(), lat, lon);
  } catch (err) {
    env.log.warn(`NOAA Atlas 14 grid unavailable (${err instanceof Error ? err.message : String(err)}): no rain ladder.`);
    return null;
  }
}

/**
 * Validate everything that needs no GPU, then load the preset and open the scene. `check` sees the scenario and the
 * Atlas 14 point first (a site sweep builds its ladder there) and may return its own default for --minutes.
 */
async function prepare(env: CliEnv, o: ParsedOptions, check?: (presetId: string, scenario: TerrainData['scenario'], rain: Atlas14Point | null) => number | undefined): Promise<Prepared> {
  const presetId = requirePreset(env, o);
  const minutesAsked = num(o, 'minutes') !== undefined ? minutesOf(o) : undefined;
  const climate = parseClimate(str(o, 'climate'));
  const flags = scenarioFlags(o);
  // Atlas 14 only when a ladder needs it: a site check, or a level asked for by id.
  const needRain = !!check || flags.level !== undefined;
  let rain: Atlas14Point | null = null;
  let checkMinutes: number | undefined;
  // The flags against the preset's own scenario before the (slow) load: a bad level or stage fails at once.
  const meta = env.presetMeta(presetId);
  if (meta) {
    if (needRain) rain = await rainAt(env, meta.bounds);
    resolveForcing(presetId, meta.scenario, flags, { rain });
    checkMinutes = check?.(presetId, meta.scenario, rain);
  }
  const t0 = performance.now();
  env.log.info(`Loading ${presetId}…`);
  const terrain = await env.loadTerrain(presetId, (msg, f) => env.log.progress('load', f, msg));
  env.log.endProgress();
  if (!meta) {
    if (needRain) rain = await rainAt(env, terrain.bounds);
    checkMinutes = check?.(presetId, terrain.scenario, rain);
  }
  const scene = await env.openScene(terrain, presetId, { climate, appCadence: flag(o, 'app-cadence') });
  const loadS = (performance.now() - t0) / 1000;
  // Resolve against the scene's scenario: on a chain preset the routed wave has replaced the entry inflow.
  const resolved = resolveForcing(presetId, scene.state.scenario, flags, { rain });
  // The app's simulated time per level: 120 min for a rain level (the 1-hour storm and an hour of run-off).
  const rainLevel = !!resolved.level && Number.isFinite(resolved.level.mmPerHour);
  const durationS = Math.round((minutesAsked ?? checkMinutes ?? (rainLevel ? RAIN_SWEEP_MINUTES : ENSEMBLE_LIMITS.defaultMinutes)) * 60);
  if (scene.chain) env.log.info(`Hazard chain: routed ${scene.chain.file.name} in ${(scene.chain.ms / 1000).toFixed(1)} s (entry peak ${Math.round(scene.chain.result.entryPeak)} m³/s).`);
  if (!scene.climateForcing.identity) env.log.info(`Climate: ${scene.climateForcing.label} — rain × ${scene.climateForcing.rainMult.toFixed(3)}${scene.climateForcing.seaRiseM ? `, sea +${scene.climateForcing.seaRiseM.toFixed(2)} m` : ''}.`);
  return { presetId, terrain, scene, resolved, durationS, climate, loadS, appCadence: flag(o, 'app-cadence'), rain };
}

interface CaseResult {
  fields: HazardFields;
  snapshot: SimSnapshot | null;
  wallS: number;
  readS: number;
}

/** The user's scenario: lists at normal levels, then the stage slider (HeadlessScene.setForcing). */
function setScenario(scene: SceneLike, f: ForcingState): void {
  scene.setForcing({ sources: f.sources, storms: f.storms, rainRate: f.rainRate, manningN: f.manningN, stageOffset: f.stageOffset });
}

/** The store's forcing now (what the app's ensemble takes as its base, src/ui/ensemble.ts). */
function storeForcing(s: AppState): ForcingState {
  return { sources: s.sources, storms: s.storms, rainRate: s.sim.rainRate, stageOffset: s.stageOffset, manningN: s.sim.manningN };
}

/**
 * One headless run (src/ui/headless.ts, one case): `apply` sets the case's forcing in the store, the water is reset,
 * the solver runs exactly `durationS` simulated seconds, and the hazard fields are read.
 */
async function runCase(scene: SceneLike, apply: () => void, durationS: number, log: Log, label: string, rainStopS: number | null = null): Promise<CaseResult> {
  apply();
  scene.resetWater();
  const t0 = performance.now();
  const onProgress = (p: RunProgress) => {
    const el = (performance.now() - t0) / 1000;
    const fr = durationS > 0 ? p.simTime / durationS : 1;
    log.progress(label, fr, `${(p.simTime / 60).toFixed(1)} of ${(durationS / 60).toFixed(0)} sim min · ${el.toFixed(0)} s`);
  };
  if (rainStopS !== null && rainStopS < durationS) {
    // An Atlas 14 rain level: the 1-hour storm, then run-off with the rain stopped — the app's sweep stops it on the
    // same simulated second (siteCheck.ts afterChunk). The rate is put back afterwards, so the scene's forcing is the
    // case's again (an ensemble takes it as its base).
    const rate = scene.state.sim.rainRate;
    await scene.runFor(rainStopS, onProgress);
    scene.setForcing({ rainRate: 0 });
    await scene.runFor(durationS - rainStopS, onProgress);
    scene.setForcing({ rainRate: rate });
  } else await scene.runFor(durationS, onProgress);
  const tr = performance.now();
  const { fields, snapshot } = await scene.read();
  log.endProgress();
  const end = performance.now();
  return { fields, snapshot, wallS: (end - t0) / 1000, readS: (end - tr) / 1000 };
}

function baseForcing(r: ResolvedForcing): ForcingState {
  return { sources: r.sources, storms: r.storms, rainRate: r.rainRate, stageOffset: r.stageOffset, manningN: r.manningN ?? DEFAULT_SIM_PARAMS.manningN };
}

function presetJson(env: CliEnv, presetId: string, terrain: TerrainData) {
  const info = listPresets().find((p) => p.id === presetId);
  return {
    id: presetId,
    name: info?.name ?? terrain.name,
    grid: { nx: terrain.nx, ny: terrain.ny, cellSizeM: terrain.cellSize },
    bounds: terrain.bounds,
    crs: 'EPSG:3857 (grid linear in Web Mercator; bounds in WGS84 degrees of the outer edges)',
    attribution: terrain.attribution,
    buildings: terrain.buildings?.count ?? 0,
    roads: terrain.roads?.edges.length ?? 0,
  };
}

function scenarioJson(p: Prepared, f: ForcingState) {
  const sc = p.scene.state.scenario;
  const cf = p.scene.climateForcing;
  return {
    simulatedMinutes: p.durationS / 60,
    changes: p.resolved.changes,
    level: p.resolved.level
      ? {
          id: p.resolved.level.id,
          label: p.resolved.level.label,
          returnPeriod: p.resolved.level.sourceRp,
          ...(Number.isFinite(p.resolved.level.mmPerHour) ? { rainMmHr: p.resolved.level.mmPerHour, source: p.resolved.level.sourceText } : {}),
        }
      : null,
    rainStopsAtMin: p.resolved.rainStopsAtS !== null ? p.resolved.rainStopsAtS / 60 : null,
    stage: sc?.stage ? { gauge: sc.stage.label, gaugeFt: round(feetOf(sc.stage, f.stageOffset) ?? NaN, 2), offsetM: round(f.stageOffset, 3) } : null,
    rainMmHr: f.rainRate,
    manningN: f.manningN,
    sources: p.scene.state.sources.map(sourceJson),
    storms: f.storms.map((s) => ({ id: s.id, intensityMmHr: s.intensity, radiusCells: s.radius })),
    climate: {
      label: cf.label,
      selection: p.climate,
      rainMultiplier: round(cf.rainMult, 4),
      inflowMultiplier: round(cf.inflowMult, 4),
      seaRiseM: cf.seaRiseM,
      lakeVolumeFactor: cf.lake?.volumeFactor ?? null,
      note: cf.note,
    },
    hazardChain: p.scene.chain ? { profile: p.scene.chain.file.name, entryPeakM3s: Math.round(p.scene.chain.result.entryPeak), entryFrontS: round(p.scene.chain.result.entryFront, 0) } : null,
  };
}

function sourceJson(s: WaterSource) {
  return s.type === 'inflow'
    ? { id: s.id, type: s.type, dischargeM3s: round(s.discharge, 2), hydrograph: !!s.hydrograph?.length, label: s.label ?? null }
    : { id: s.id, type: s.type, levelM: round(s.level, 3), label: s.label ?? null };
}

const round = (v: number, d: number) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);

function runJson(p: Prepared, gpu: string, wallS: number, cases: number) {
  return {
    gpu,
    readbacks: p.appCadence ? 'browser cadence (300 ms wall clock)' : 'every 60 simulated s (deterministic)',
    wallSeconds: round(wallS, 2),
    loadSeconds: round(p.loadS, 2),
    cases,
    frames: p.scene.frames,
    substeps: p.scene.substeps,
    simSpeedX: round((p.durationS * cases) / Math.max(1e-6, wallS), 0),
  };
}

// ─── presets ────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function presetsCommand(env: CliEnv, o: ParsedOptions): Promise<number> {
  const rows = [];
  for (const id of env.presetIds()) {
    const info = listPresets().find((p) => p.id === id)!;
    const meta = env.presetMeta(id);
    const sc = meta?.scenario ?? null;
    const st = sc?.stage ?? null;
    // Every ladder the Site check offers here, the one it picks by itself first (its ticked levels are the defaults).
    const rain = meta ? await rainAt(env, meta.bounds) : null;
    const first = buildLadder(id, sc, { rain });
    const ladders: Ladder[] = [first, ...first.kinds.filter((k) => k !== first.kind).map((k) => buildLadder(id, sc, { rain, kind: k }))];
    rows.push({
      id,
      name: info.name,
      subtitle: info.subtitle,
      grid: meta ? { nx: meta.nx, ny: meta.ny, cellSizeM: Math.round(meta.cellSize * 100) / 100 } : null,
      bounds: meta?.bounds ?? null,
      forcing: sc
        ? {
            stage: st ? { gauge: st.label, normalFt: round(feetOf(st, 0) ?? NaN, 2), maxFt: round(feetOf(st, st.maxOffset) ?? NaN, 2), floodStageFt: st.floodStageFt ?? null } : null,
            rainMmHr: sc.rainRate ?? 0,
            inflows: sc.sources.filter((s) => s.type === 'inflow').length,
            storms: sc.storms.length,
            hazardChain: !!sc.hazardChain,
          }
        : null,
      ladder: first.kind,
      levels: ladders.flatMap((L) =>
        L.rungs.map((l) => ({
          id: l.id,
          label: l.label,
          ladder: L.kind,
          gaugeFt: Number.isFinite(l.ft) ? l.ft : null,
          scale: Number.isFinite(l.scale) ? l.scale : null,
          rainMmHr: Number.isFinite(l.mmPerHour) ? l.mmPerHour : null,
          returnPeriod: l.sourceRp === null ? null : round(l.sourceRp, 1),
          default: L === first && l.on,
          outOfRange: l.outOfRange,
        })),
      ),
    });
  }
  if (flag(o, 'json')) {
    env.stdout(toJson({ presets: rows }));
    return EXIT.ok;
  }
  const lines: string[] = [];
  for (const r of rows) {
    const f = r.forcing;
    const what = !f
      ? 'procedural'
      : [
          f.stage ? `stage ${f.stage.normalFt}–${f.stage.maxFt} ft (${f.stage.gauge})` : null,
          f.rainMmHr ? `rain ${f.rainMmHr} mm/hr` : null,
          f.inflows ? `${f.inflows} inflow${f.inflows > 1 ? 's' : ''}` : null,
          f.storms ? `${f.storms} storm cell${f.storms > 1 ? 's' : ''}` : null,
          f.hazardChain ? 'glacier hazard chain' : null,
        ]
          .filter(Boolean)
          .join(', ');
    lines.push(`${r.id.padEnd(11)} ${r.name}`);
    lines.push(`${''.padEnd(11)} ${r.subtitle}`);
    lines.push(`${''.padEnd(11)} ${r.grid ? `${r.grid.nx}×${r.grid.ny} @ ${r.grid.cellSizeM} m · ` : ''}${what}`);
    if (flag(o, 'levels')) {
      for (const l of r.levels) {
        const extra = [l.gaugeFt != null ? `${l.gaugeFt} ft` : null, l.rainMmHr != null ? `${l.rainMmHr} mm/hr for 1 h` : null, l.returnPeriod ? `${l.returnPeriod}-yr` : null].filter(Boolean).join(', ');
        lines.push(`${''.padEnd(13)}--scenario ${l.id.padEnd(11)} ${l.label}${extra ? ` (${extra})` : ''}${l.outOfRange ? ' — beyond the stage range' : l.default ? '' : ' — not swept by default'}`);
      }
    }
    lines.push('');
  }
  env.stdout(lines.join('\n'));
  return EXIT.ok;
}

// ─── run ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function runCommand(env: CliEnv, o: ParsedOptions): Promise<number> {
  const p = await prepare(env, o);
  try {
    const outDir = str(o, 'out') ?? `results/${p.presetId}`;
    const f = baseForcing(p.resolved);
    const gpu = await env.gpuName();
    env.log.info(`Running ${p.presetId} for ${p.durationS / 60} simulated min on ${gpu}…`);
    const c = await runCase(p.scene, () => setScenario(p.scene, f), p.durationS, env.log, 'simulate', p.resolved.rainStopsAtS);
    const { fields, snapshot } = c;
    const t = p.terrain;
    const analysis = analyze({ fields, terrain: t, velocityKnown: true, debrisFlow: debrisFlowFor(p.presetId) });
    const layers = hazardLayers(fields);
    const rasters: Array<Record<string, unknown>> = [];
    if (!flag(o, 'no-rasters')) {
      for (const L of layers) {
        const file = `${outDir}/${L.file}`;
        env.write(file, geotiffBytes(L.data, t.nx, t.ny, t.bounds, L.nodata, `Deluge ${p.presetId}: ${L.description} (${L.unit})`));
        rasters.push({ file: L.file, layer: L.name, unit: L.unit, nodata: L.nodata, dataType: L.data instanceof Uint8Array ? 'UInt8' : 'Float32', description: L.description });
      }
    }
    const hazard = layers.find((l) => l.name === 'hazard')!.data as Uint8Array;
    const cellArea = t.cellSize * t.cellSize;
    const byClass = [0, 0, 0, 0, 0, 0];
    for (let c2 = 0; c2 < hazard.length; c2++) if (hazard[c2]) byClass[hazard[c2] - 1] += cellArea;
    let maxDepthLand = 0;
    let earliest = Infinity;
    for (let c2 = 0; c2 < fields.maxDepth.length; c2++) {
      if (fields.firstWet[c2] > 0) {
        maxDepthLand = Math.max(maxDepthLand, fields.maxDepth[c2]);
        earliest = Math.min(earliest, fields.firstWet[c2]);
      }
    }
    const s = analysis.report?.summary ?? null;
    const st = snapshot?.stats ?? null;
    const summary = {
      tool: 'deluge',
      version: env.version,
      command: 'run',
      generatedAt: env.now().toISOString(),
      preset: presetJson(env, p.presetId, t),
      scenario: scenarioJson(p, f),
      run: runJson(p, gpu, c.wallS, 1),
      flood: {
        simulatedSeconds: round(fields.simTime, 3),
        floodedAreaM2Over15cm: Math.round(floodedArea(fields.maxDepth, fields.firstWet, t.cellSize, 0.15)),
        floodedAreaM2Over50cm: Math.round(floodedArea(fields.maxDepth, fields.firstWet, t.cellSize, 0.5)),
        maxDepthOnDryLandM: round(maxDepthLand, 3),
        firstArrivalMin: Number.isFinite(earliest) ? round(earliest / 60, 2) : null,
        hazardAreaM2ByAidrClass: Object.fromEntries(byClass.map((a, i) => [`H${i + 1}`, Math.round(a)])),
        endOfRun: st
          ? { volumeM3: Math.round(st.volume), wetAreaM2: Math.round(st.wetArea), maxDepthM: round(st.maxDepth, 3), maxSpeedMs: round(st.maxSpeed, 3), volumeInM3: Math.round(st.volumeIn), volumeOutM3: Math.round(st.volumeOut), massError: st.massError }
          : null,
      },
      impact: s
        ? {
            buildings: s.buildings,
            assessed: s.assessed,
            reached: s.reached,
            damaged: s.damaged,
            destroyed: s.destroyed,
            accessCut: s.accessCut,
            loss: Math.round(s.loss),
            lossLow1Sigma: Math.round(s.lossLo),
            lossHigh1Sigma: Math.round(s.lossHi),
            currency: analysis.region.currency,
            curves: 'JRC global depth–damage (Huizinga et al. 2017), storey by storey; values footprint × storeys × unit cost',
          }
        : null,
      rasters,
      outDir,
      caveat: 'Screening estimate for one simulated event on bare-earth terrain: not a flood study, an insurance valuation or a catastrophe model.',
    };
    env.write(`${outDir}/summary.json`, toJson(summary));
    env.stdout(
      [
        `${p.presetId}: ${p.durationS / 60} simulated min in ${fmtSeconds(c.wallS)} (${summary.run.simSpeedX}× real time)`,
        `flooded > 15 cm: ${(summary.flood.floodedAreaM2Over15cm / 1e6).toFixed(2)} km² · > 50 cm: ${(summary.flood.floodedAreaM2Over50cm / 1e6).toFixed(2)} km²`,
        s ? `buildings reached ${s.reached} of ${s.buildings} · loss ${formatMoney(s.loss)} (±1σ ${formatMoney(s.lossLo)}–${formatMoney(s.lossHi)})`.replace(/ /g, ' ') : 'no building footprints in this preset',
        `wrote ${rasters.length ? `${rasters.map((r) => r.file).join(', ')}, ` : ''}summary.json → ${outDir}`,
        '',
      ].join('\n'),
    );
    return EXIT.ok;
  } finally {
    p.scene.destroy();
  }
}

// ─── portfolio ──────────────────────────────────────────────────────────────────────────────────────────────────────

export async function portfolioCommand(env: CliEnv, o: ParsedOptions): Promise<number> {
  const csvPath = str(o, 'csv');
  const out = str(o, 'out');
  if (!csvPath) throw new UsageError('--csv <assets.csv> is required');
  if (!out) throw new UsageError('--out <results.csv> is required (`-` for stdout)');
  const membersAsked = num(o, 'members');
  if (membersAsked !== undefined && !(membersAsked >= ENSEMBLE_LIMITS.minMembers && membersAsked <= ENSEMBLE_LIMITS.maxMembers && Number.isInteger(membersAsked))) {
    throw new UsageError(`--members must be a whole number from ${ENSEMBLE_LIMITS.minMembers} to ${ENSEMBLE_LIMITS.maxMembers}`);
  }
  const seed = num(o, 'seed') ?? 1;
  if (!(Number.isInteger(seed) && seed >= 1 && seed <= 999999)) throw new UsageError('--seed must be a whole number from 1 to 999999');
  let text: string;
  try {
    text = env.readText(csvPath);
  } catch (err) {
    throw new UsageError(`cannot read ${csvPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (text.length > CSV_LIMITS.maxChars) throw new UsageError(`${csvPath} is larger than ${CSV_LIMITS.maxChars / 1e6} M characters`);
  const parsed = parsePortfolio(text);
  if (parsed.fatal) throw new UsageError(`${csvPath}: ${parsed.fatal}`);
  for (const e of parsed.errors) env.log.warn(`${csvPath} row ${e.row}: ${e.message} (row skipped)`);
  for (const w of parsed.warnings) env.log.warn(`${csvPath}${w.row ? ` row ${w.row}` : ''}: ${w.message}`);
  if (parsed.moreIssues) env.log.warn(`${csvPath}: ${parsed.moreIssues} more issues not listed`);
  if (parsed.ignoredColumns.length) env.log.info(`Columns not used: ${parsed.ignoredColumns.join(', ')}`);
  if (!parsed.assets.length) throw new UsageError(`${csvPath}: no usable assets`);
  const assets = parsed.assets;

  const p = await prepare(env, o);
  try {
    const gpu = await env.gpuName();
    const f = baseForcing(p.resolved);
    const t0 = performance.now();
    env.log.info(`${assets.length} assets · ${p.presetId} · ${p.durationS / 60} simulated min${membersAsked ? ` · + ${membersAsked}-member ensemble` : ''} on ${gpu}`);
    const c = await runCase(p.scene, () => setScenario(p.scene, f), p.durationS, env.log, 'scenario', p.resolved.rainStopsAtS);
    const a = assessPortfolioRun(c.fields, p.terrain, p.presetId, assets);
    if (a.unassessed.length) env.log.warn(`${a.unassessed.length} asset${a.unassessed.length > 1 ? 's are' : ' is'} outside the ${p.presetId} map and not assessed: ${a.unassessed.slice(0, 8).map((x) => x.id).join(', ')}${a.unassessed.length > 8 ? ' …' : ''}`);

    let ensemble: { assets: typeof assets; tallies: AssetTally[]; rows: MemberResult[]; ranges: ReturnType<typeof defaultRanges>; seed: number } | null = null;
    if (membersAsked) ensemble = await runEnsemble(env, p, membersAsked, seed, assets, !flag(o, 'no-dem-noise'));
    env.write(out, portfolioCsv(a, ensemble));

    const sum = a.analysis.portfolio?.summary ?? null;
    const wallS = (performance.now() - t0) / 1000;
    const summaryPath = str(o, 'summary');
    if (summaryPath) {
      const es = ensemble ? summarizeMembers(ensemble.rows) : null;
      env.write(
        summaryPath,
        toJson({
          tool: 'deluge',
          version: env.version,
          command: 'portfolio',
          generatedAt: env.now().toISOString(),
          preset: presetJson(env, p.presetId, p.terrain),
          scenario: scenarioJson(p, f),
          run: runJson(p, gpu, wallS, 1 + (ensemble?.rows.length ?? 0)),
          portfolio: {
            file: csvPath,
            assets: assets.length,
            skippedRows: parsed.errors.length,
            summary: sum,
            columns: 'RESULT_COLUMNS of the in-app export (src/loss/portfolio.ts), then ens_* when --members is given',
          },
          ensemble: ensemble && es
            ? {
                members: ensemble.rows.length,
                seed: ensemble.seed,
                ranges: ensemble.ranges,
                floodedM2: es.floodedM2,
                flooded50M2: es.flooded50M2,
                buildingsReached: es.reached,
                loss: es.loss,
                lossWithCurveUncertainty: es.lossWide,
                memberParams: ensemble.rows.map((r) => ({ index: r.index, inflowFactor: r.params.inflowFactor, rainFactor: r.params.rainFactor, stageDelta: r.params.stageDelta, manningN: r.params.manningN, chain: r.params.chain, loss: r.loss, floodedM2: r.floodedM2 })),
                caveat: ENSEMBLE_CAVEAT,
              }
            : null,
        }),
      );
    }
    const money = (v: number) => formatMoney(v).replace(/ /g, ' ');
    const line = sum
      ? `${sum.assets - sum.outside} of ${assets.length} assets assessed · ${sum.reached} reached · loss ${money(sum.loss)} (±1σ ${money(sum.lossLo)}–${money(sum.lossHi)})${Number.isFinite(sum.insured) ? ` · insured ${money(sum.insured)}` : ''} · ${fmtSeconds(wallS)}`
      : `no assets assessed · ${fmtSeconds(wallS)}`;
    // With --out - the CSV is stdout: the totals go to stderr.
    if (out === '-') env.log.info(line);
    else env.stdout(`${line}\nwrote ${out}${summaryPath ? ` and ${summaryPath}` : ''}\n`);
    return EXIT.ok;
  } finally {
    p.scene.destroy();
  }
}

/** The Uncertainty panel's ensemble (src/ui/ensemble.ts run) over the portfolio's assets. */
async function runEnsemble(env: CliEnv, p: Prepared, n: number, seed: number, assets: ReturnType<typeof parsePortfolio>['assets'], dem: boolean) {
  const { scene, terrain } = p;
  const ranges = defaultRanges(demSourceOf(terrain.attribution));
  if (!dem) ranges.demSigmaM = 0;
  let chain = null;
  if (scene.chain && scene.state.scenario?.hazardChain) {
    env.log.info('Running the hazard chain’s own ensemble (its members perturb the routed inflow)…');
    chain = chainEnsembleInput(scene.state.scenario, scene.chain);
  }
  const params = sampleMembers(n, ranges, seed, chain);
  const stage = scene.state.scenario?.stage ?? null;
  const demOn = ranges.demSigmaM > 0;
  const ground0 = demOn ? scene.ground().slice() : null;
  const tallies = newTallies(assets);
  const rows: MemberResult[] = [];
  const t0 = performance.now();
  // The user's scenario as the store holds it now (the base run set it): every member is one patch on it.
  const base = storeForcing(scene.state);
  try {
    for (const m of params) {
      const f = memberForcing(base, m, { stageMax: stage ? stage.maxOffset : null, chainSourceId: chain ? scene.chain!.sourceId : null });
      const apply = () => {
        // Two patches, as in src/ui/ensemble.ts: the member's sources carry the BASE stage levels, so they go in with
        // the base offset (recorded correctly), and the offset change then moves the stage levels.
        scene.applyPatch({ sources: f.sources, storms: f.storms, stageOffset: base.stageOffset, sim: { ...scene.state.sim, rainRate: f.rainRate, manningN: f.manningN } });
        scene.applyPatch({ stageOffset: f.stageOffset });
        if (demOn) scene.setBedPerturbation(demPerturbation({ nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize, sigma: ranges.demSigmaM, corrLenM: ranges.demCorrM, seed: m.seed, initialDepth: scene.initialWater, elevation: ground0 }));
      };
      const tr = performance.now();
      const c = await runCase(scene, apply, p.durationS, env.log, `member ${m.index + 1}/${n}`, p.resolved.rainStopsAtS);
      rows.push(collectMember(c.fields, terrain, p.presetId, { index: m.index, params: m, runMs: performance.now() - tr, readMs: c.readS * 1000 }, assets, tallies));
    }
  } finally {
    if (demOn) scene.setBedPerturbation(null);
  }
  const s = (performance.now() - t0) / 1000;
  env.log.info(`Ensemble: ${n} members in ${fmtSeconds(s)} (${(n / Math.max(1e-6, s / 60)).toFixed(1)} members/min).`);
  return { assets, tallies, rows, ranges, seed };
}

// ─── site ───────────────────────────────────────────────────────────────────────────────────────────────────────────

function parseLatLon(text: string, what: string): [number, number] {
  const m = text.split(',').map((x) => Number(x.trim()));
  if (m.length !== 2 || !m.every(Number.isFinite) || Math.abs(m[0]) > 90 || Math.abs(m[1]) > 180) throw new UsageError(`${what} must be "lat,lon" in degrees, got "${text}"`);
  return [m[0], m[1]];
}

/** The site from the flags, checked against SITE_LIMITS (site.ts) like the panel's form. */
export function siteFromOptions(o: ParsedOptions): SiteSpec {
  const at = str(o, 'at');
  if (!at) throw new UsageError('--at <lat,lon> is required');
  const [lat, lon] = parseLatLon(at, '--at');
  let ring: number[] | null = null;
  const ringText = str(o, 'ring');
  if (ringText) {
    const pts = ringText.split(';').filter((s) => s.trim()).map((s) => parseLatLon(s, '--ring corner'));
    if (pts.length < 3 || pts.length > SITE_LIMITS.maxRing) throw new UsageError(`--ring needs 3–${SITE_LIMITS.maxRing} corners`);
    ring = pts.flatMap(([la, lo]) => [lo, la]);
  }
  const spec = newSite('s1', lon, lat, ring);
  spec.name = (str(o, 'name') ?? '').slice(0, SITE_LIMITS.nameChars);
  const use = str(o, 'use') ?? 'office';
  if (!(SITE_OCCUPANCIES as readonly string[]).includes(use)) throw new UsageError(`--use must be one of ${SITE_OCCUPANCIES.join(', ')}`);
  spec.occupancy = use as SiteOccupancy;
  const within = (name: string, lo: number, hi: number, integer = false): number | null => {
    const v = num(o, name);
    if (v === undefined) return null;
    if (!(v >= lo && v <= hi) || (integer && !Number.isInteger(v))) throw new UsageError(`--${name} must be ${integer ? 'a whole number ' : ''}between ${lo} and ${hi}`);
    return v;
  };
  spec.floors = within('floors', 1, SITE_LIMITS.maxFloors, true) ?? 3;
  spec.value = within('value', 0, SITE_LIMITS.maxValue);
  spec.footprintM2 = within('footprint', 1, SITE_LIMITS.maxFootprintM2);
  spec.firstFloorHeight = within('ffh', 0, SITE_LIMITS.maxFirstFloorM);
  spec.criticalElev = within('critical', 0, SITE_LIMITS.maxCriticalM);
  return spec;
}

/** Leaving by road: the site's occupants, alert, departure curve, persons per car and exit lanes (null = the default). */
export function timingFromOptions(o: ParsedOptions): TimingOverrides {
  const within = (name: string, lo: number, hi: number, integer = false): number | null => {
    const v = num(o, name);
    if (v === undefined) return null;
    if (!(v >= lo && v <= hi) || (integer && !Number.isInteger(v))) throw new UsageError(`--${name} must be ${integer ? 'a whole number ' : ''}between ${lo} and ${hi}`);
    return v;
  };
  const dep = str(o, 'departure');
  if (dep !== undefined && !Object.hasOwn(DEPARTURE_CURVES, dep)) throw new UsageError(`--departure must be one of ${Object.keys(DEPARTURE_CURVES).join(', ')}`);
  return {
    occupants: within('occupants', 1, 100000, true),
    alertMin: within('alert-min', -1440, 1440),
    departure: dep as DepartureCurveId | undefined,
    personsPerCar: within('persons-per-car', 1, 10),
    exitLanes: within('exit-lanes', 1, 12, true),
  };
}

/** --rp x0.5=10,x1=100 */
export function parseRp(text: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!text) return out;
  for (const part of text.split(',')) {
    const [id, v] = part.split('=').map((s) => s.trim());
    const years = Number(v);
    if (!id || !(years >= 1 && years <= 100000)) throw new UsageError(`--rp: "${part}" is not id=years (1–100000)`);
    out.set(id, years);
  }
  return out;
}

/** The levels a sweep runs (the app's ticked defaults, all, or the named ones). */
export function sweepLevels(ladder: readonly LadderRung[], levels: string | undefined): LadderRung[] {
  if (!levels) return ladder.filter((l) => l.on && !l.outOfRange);
  if (levels === 'all') return ladder.filter((l) => !l.outOfRange);
  const ids = levels.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.map((id) => {
    const l = ladder.find((x) => x.id === id);
    if (!l) throw new UsageError(`--levels: no level "${id}" (one of ${ladder.map((x) => x.id).join(', ')})`);
    if (l.outOfRange) throw new UsageError(`--levels: ${id} is beyond this scenario's stage range`);
    return l;
  });
}

/**
 * The ladder a site check builds and, with --sweep, the levels it runs and the simulated minutes per level (the app's
 * siteCheck.ts defaultDuration; undefined = the usual default). Throws a UsageError for a ladder, level, return period
 * or design level the preset does not have. Also the API’s check before it queues a job (src/cli/api.ts).
 */
export function planSite(o: ParsedOptions, presetId: string, scenario: TerrainData['scenario'], rain: Atlas14Point | null, rp: Map<string, number>): { ladder: Ladder; todo: LadderRung[]; minutes: number | undefined } {
  const ladder = buildLadder(presetId, scenario, { rain, kind: str(o, 'ladder') as LadderKind | undefined });
  if (!flag(o, 'sweep')) return { ladder, todo: [], minutes: undefined };
  const todo = sweepLevels(ladder.rungs, str(o, 'levels'));
  if (!todo.length) throw new UsageError('no levels to sweep');
  for (const id of rp.keys()) if (!ladder.rungs.some((l) => l.id === id)) throw new UsageError(`--rp: no level "${id}"`);
  const design = str(o, 'design');
  if (design && !todo.some((l) => l.id === design)) throw new UsageError(`--design ${design} is not among the levels swept`);
  // The app's simulated time per level for this ladder (siteCheck.ts defaultDuration).
  const minutes = ladder.kind === 'rain' ? RAIN_SWEEP_MINUTES : ladder.kind === 'stage' && scenario?.coastal ? SURGE_SWEEP_MINUTES : undefined;
  return { ladder, todo, minutes };
}

export async function siteCommand(env: CliEnv, o: ParsedOptions): Promise<number> {
  const spec = siteFromOptions(o);
  const timingOver = timingFromOptions(o);
  const timingOf = (run: SiteRun) => timingForRun(run, 0, timingOver);
  const sweep = flag(o, 'sweep');
  if (sweep && (str(o, 'scenario') !== undefined || num(o, 'stage-ft') !== undefined)) throw new UsageError('--sweep runs the ladder of levels itself: drop --scenario / --stage-ft (use --levels to pick levels)');
  const rp = parseRp(str(o, 'rp'));
  const freeboardFt = num(o, 'freeboard-ft');
  if (freeboardFt !== undefined && !(freeboardFt >= 0 && freeboardFt <= 10)) throw new UsageError('--freeboard-ft must be between 0 and 10');
  const kindAsked = str(o, 'ladder');
  if (kindAsked !== undefined && kindAsked !== 'stage' && kindAsked !== 'rain' && kindAsked !== 'scale') throw new UsageError(`--ladder must be stage, rain or scale, got "${kindAsked}"`);
  if (kindAsked !== undefined && !sweep) throw new UsageError('--ladder picks the ladder --sweep runs (for one run, pick a level with --scenario)');
  let ladder: Ladder = { kind: 'scale', kinds: ['scale'], rungs: [] };
  let todo: LadderRung[] = [];
  const p = await prepare(env, o, (presetId, scenario, rain) => {
    const plan = planSite(o, presetId, scenario, rain, rp);
    ladder = plan.ladder;
    todo = plan.todo;
    return plan.minutes;
  });
  try {
    const t = p.terrain;
    const toGrid = makeGeoToGrid(t);
    const [gx, gy] = toGrid(spec.lon, spec.lat);
    if (!(gx >= 0 && gy >= 0 && gx < t.nx && gy < t.ny)) {
      const b = t.bounds;
      throw new UsageError(`the site is outside the ${p.presetId} map (lat ${b.south.toFixed(4)}…${b.north.toFixed(4)}, lon ${b.west.toFixed(4)}…${b.east.toFixed(4)})`);
    }
    const gpu = await env.gpuName();
    let router: EgressRouter | null = null;
    if (t.roads && t.roads.edges.length) {
      const r = createRouter();
      r.setNetwork(t.roads, t.cellSize, { nx: t.nx, ny: t.ny });
      router = r;
    }
    const shelters = p.scene.state.shelters;
    const base = baseForcing(p.resolved);
    const t0 = performance.now();
    const region = regionForBounds(t.bounds);
    const report: Record<string, unknown> = {
      tool: 'deluge',
      version: env.version,
      command: 'site',
      generatedAt: env.now().toISOString(),
      preset: presetJson(env, p.presetId, t),
      site: { name: spec.name || null, lat: spec.lat, lon: spec.lon, ring: spec.ring, use: spec.occupancy, floors: spec.floors, value: spec.value, footprintM2: spec.footprintM2, firstFloorHeightM: spec.firstFloorHeight, criticalElevM: spec.criticalElev, grid: { gx: round(gx, 2), gy: round(gy, 2) } },
      scenario: scenarioJson(p, base),
    };
    if (!sweep) {
      env.log.info(`Site check: ${p.presetId} · ${p.durationS / 60} simulated min on ${gpu}`);
      const c = await runCase(p.scene, () => setScenario(p.scene, base), p.durationS, env.log, 'simulate', p.resolved.rainStopsAtS);
      const run = assessSiteForRun(spec, { fields: c.fields, terrain: t, presetId: p.presetId, ground: p.scene.ground(), router, shelters, endDepth: c.snapshot?.depth.slice() ?? null });
      const timing = timingOf(run);
      report.run = siteRunJson(run, timing);
      report.egressSummary = egressClause(run);
      if (timing?.known) report.egressTimingSummary = [shareOutSentence(timing), clearanceSentence(timing)];
      report.timing = runJson(p, gpu, (performance.now() - t0) / 1000, 1);
    } else {
      const st = p.scene.state.scenario?.stage ?? null;
      const kind = ladder.kind;
      env.log.info(`Site check sweep: ${todo.length} levels × ${p.durationS / 60} simulated min on ${gpu}`);
      const rows: SweepRow[] = [];
      // The user's scenario first; each level then changes it as the app's sweep does (siteCheck.ts runSweep): the
      // stage slider alone on a stage ladder; on a rain ladder rain only (river at normal level, inflows and storm cells
      // off) for the 1-hour storm, then run-off; the scaled lists (stage untouched) on a scale ladder.
      setScenario(p.scene, base);
      const saved = storeForcing(p.scene.state);
      for (let i = 0; i < todo.length; i++) {
        const L = todo[i];
        const apply =
          kind === 'stage' && st
            ? () => p.scene.setForcing({ stageOffset: L.ft * FT + st.gaugeDatum - st.normalLevel })
            : kind === 'rain'
              ? () => {
                  const k = rainForcing(L.mmPerHour, saved);
                  p.scene.applyPatch({ stageOffset: 0, sources: k.sources, storms: k.storms, sim: { ...p.scene.state.sim, rainRate: k.rainRate } });
                }
              : () => {
                  const k = scaledForcing(L.scale, saved);
                  p.scene.applyPatch({ sources: k.sources, storms: k.storms, sim: { ...p.scene.state.sim, rainRate: k.rainRate } });
                };
        const c = await runCase(p.scene, apply, p.durationS, env.log, `level ${i + 1}/${todo.length} ${L.id}`, kind === 'rain' ? RAIN_DESIGN_DURATION_S : null);
        const userRp = rp.get(L.id) ?? null;
        const info: SweepLevelInfo = {
          id: L.id,
          label: L.label,
          ft: L.ft,
          scale: L.scale,
          ...(kind === 'rain' ? { rainMmH: L.mmPerHour } : {}),
          returnPeriod: L.sourceRp ?? userRp,
          rpFrom: L.sourceRp != null ? 'source' : userRp != null ? 'user' : null,
          durationS: c.fields.simTime,
        };
        const run = assessSiteForRun(spec, { fields: c.fields, terrain: t, presetId: p.presetId, ground: p.scene.ground(), router, shelters, endDepth: c.snapshot?.depth.slice() ?? null });
        rows.push({ level: info, run });
        const r = run.result;
        env.log.info(`  ${L.label}: ${r ? (r.reached ? `${r.depth.toFixed(2)} m, loss ${formatMoney(r.loss).replace(/ /g, ' ')}` : 'dry') : 'outside'} (${fmtSeconds(c.wallS)})`);
      }
      const coastal = kind === 'stage' && !!p.scene.state.scenario?.coastal;
      report.ladder = {
        kind,
        gauge: kind === 'stage' ? (st?.label ?? null) : null,
        ...(kind === 'rain' && p.rain ? { atlas14At: { lat: round(p.rain.lat, 4), lon: round(p.rain.lon, 4) }, stormMinutes: RAIN_DESIGN_DURATION_S / 60 } : {}),
        sources: [...new Set(todo.map((l) => l.source).filter(Boolean))].map((k) => ({ key: k, text: ladder.rungs.find((l) => l.source === k)?.sourceText ?? '' })),
        caveats: kind === 'rain' ? [...RAIN_LADDER_CAVEATS] : coastal ? [...SURGE_LADDER_CAVEATS] : [],
      };
      report.sweep = siteSweepReport(spec, rows, { designId: str(o, 'design') ?? null, freeboardM: freeboardFt !== undefined ? freeboardFt * FT : undefined, country: region.costCountry, timing: timingOf });
      report.timing = runJson(p, gpu, (performance.now() - t0) / 1000, todo.length);
    }
    report.caveat = 'Indicative screening, not engineering advice: bare-earth terrain, no drains, one simulated event per level.';
    const out = str(o, 'out') ?? '-';
    env.write(out, toJson(report));
    if (out !== '-') {
      const sw = report.sweep as ReturnType<typeof siteSweepReport> | undefined;
      const ts = report.egressTimingSummary as string[] | undefined;
      env.stdout(`${sw ? sw.verdict.join('\n') : [String(report.egressSummary), ...(ts ?? [])].join('\n')}\nwrote ${out}\n`);
    }
    return EXIT.ok;
  } finally {
    p.scene.destroy();
  }
}

export const HANDLERS: Record<keyof typeof COMMANDS, (env: CliEnv, o: ParsedOptions) => Promise<number>> = {
  presets: presetsCommand,
  run: runCommand,
  portfolio: portfolioCommand,
  site: siteCommand,
  dam: damCommand,
};
