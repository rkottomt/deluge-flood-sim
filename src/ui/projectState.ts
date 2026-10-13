/**
 * The app state ⇄ a project file (src/project/format.ts): capture what is on screen into a ProjectFile, and put a
 * (validated) ProjectFile back — loading its scene first when it is another one.
 *
 * The panel sections that own part of a project (Site check's settings, the ensemble's, the Impact section's
 * portfolio, the design comparison) register hooks here, keyed by the Store like the UI bridge, so this module needs
 * nothing from their insides and they need nothing from it.
 */
import type { AppActions, AppState, LiveAreaRequest, SimParams, Store, TerrainData, WaterSource } from '../contracts';
import { DEFAULT_SIM_PARAMS } from '../contracts';
import { gridToGeo } from '../data/geo';
import { cleanPlaceLabel } from '../data/placeName';
import { isPresetId } from '../data/presets';
import { newSite, type SiteSpec } from '../loss/site';
import { cloneEdits, editLogFor, replayEdits } from '../project/edits';
import {
  PROJECT_FORMAT,
  PROJECT_LIMITS,
  PROJECT_VERSION,
  type ComparisonSummary,
  type DesignSpec,
  type EnsembleSettings,
  type ProjectFile,
  type ProjectScene,
  type ProjectSite,
  type SiteCheckSettings,
} from '../project/format';
import { bridgeFor } from './bridge';
import { headlessBusy } from './headless';
import { sitesFor } from './sites';

export interface ProjectHooks {
  siteCheck: { getSettings(): SiteCheckSettings; applySettings(s: SiteCheckSettings): Promise<void> } | null;
  ensemble: { getSettings(): EnsembleSettings; applySettings(s: EnsembleSettings): void } | null;
  portfolio: { get(): { name: string; text: string } | null; load(name: string, text: string): void } | null;
  designs: { get(): DesignSpec[]; set(d: DesignSpec[], summary: ComparisonSummary | null): void; summary(): ComparisonSummary | null } | null;
}

const hooks = new WeakMap<Store, ProjectHooks>();

export function projectHooksFor(store: Store): ProjectHooks {
  let h = hooks.get(store);
  if (!h) hooks.set(store, (h = { siteCheck: null, ensemble: null, portfolio: null, designs: null }));
  return h;
}

/** SimParams a project carries: the user-facing ones, plus any numeric / boolean parameter a later solver adds. */
const SIM_SKIP = new Set(['stabilityMode', 'cfl', 'maxSubstepsPerFrame']);

export function simForProject(sim: SimParams): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(sim)) {
    if (SIM_SKIP.has(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    else if (typeof v === 'boolean') out[k] = v;
    else if (k === 'boundary' && (v === 'open' || v === 'wall')) out[k] = v;
  }
  return out;
}

/** Merge a project's SimParams into the app's: only keys the running app has, with the same type. */
export function mergeSim(current: SimParams, saved: Record<string, number | string | boolean>): SimParams {
  const next = { ...current } as unknown as Record<string, unknown>;
  const defaults = DEFAULT_SIM_PARAMS as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(saved)) {
    if (SIM_SKIP.has(k) || !Object.prototype.hasOwnProperty.call(defaults, k)) continue;
    if (typeof defaults[k] !== typeof v) continue;
    next[k] = v;
  }
  return next as unknown as SimParams;
}

function cleanSource(s: WaterSource): WaterSource {
  if (s.type === 'inflow') {
    return {
      id: s.id,
      type: 'inflow',
      gx: s.gx,
      gy: s.gy,
      radius: s.radius,
      discharge: s.discharge,
      ...(s.stopAfter != null ? { stopAfter: s.stopAfter } : {}),
      ...(s.hydrograph ? { hydrograph: s.hydrograph.slice(0, PROJECT_LIMITS.maxHydrograph).map((p) => ({ t: p.t, q: p.q })) } : {}),
      ...(s.label ? { label: cleanPlaceLabel(s.label, PROJECT_LIMITS.labelChars) } : {}),
    };
  }
  return { id: s.id, type: 'stage', gx: s.gx, gy: s.gy, radius: s.radius, level: s.level, ...(s.offsetScale != null ? { offsetScale: s.offsetScale } : {}), ...(s.label ? { label: cleanPlaceLabel(s.label, PROJECT_LIMITS.labelChars) } : {}) };
}

/** The scene on screen as a project scene (a preset id, or the live request that reloads the same grid). */
export function sceneOf(s: AppState, t: TerrainData | null): ProjectScene | null {
  if (s.presetId && isPresetId(s.presetId)) return { kind: 'preset', id: s.presetId };
  if (!t) return null;
  const c = gridToGeo(t, t.nx / 2, t.ny / 2);
  const res = t.nx === 512 || t.nx === 2048 ? t.nx : 1024;
  const sizeM = Math.min(20000, Math.max(1000, Math.round(t.nx * t.cellSize)));
  const name = cleanPlaceLabel(t.name, PROJECT_LIMITS.nameChars);
  return { kind: 'live', lat: Math.round(c.lat * 1e6) / 1e6, lon: Math.round(c.lon * 1e6) / 1e6, sizeM, resolution: res as 512 | 1024 | 2048, ...(name ? { name } : {}) };
}

export function siteToProject(s: SiteSpec): ProjectSite {
  return { name: s.name, lon: s.lon, lat: s.lat, ring: s.ring ? s.ring.slice() : null, occupancy: s.occupancy, floors: s.floors, value: s.value, footprintM2: s.footprintM2, firstFloorHeight: s.firstFloorHeight, criticalElev: s.criticalElev };
}

export function siteFromProject(p: ProjectSite, i: number): SiteSpec {
  const s = newSite(`s${i + 1}`, p.lon, p.lat, p.ring ? p.ring.slice() : null);
  return { ...s, name: p.name, occupancy: p.occupancy, floors: p.floors, value: p.value, footprintM2: p.footprintM2, firstFloorHeight: p.firstFloorHeight, criticalElev: p.criticalElev };
}

export interface CaptureOptions {
  name: string;
  includePortfolio: boolean;
  includeResults: boolean;
}

export type CaptureResult = { ok: true; project: ProjectFile; notes: string[] } | { ok: false; error: string };

/** The project on screen. */
export function captureProject(store: Store, opts: CaptureOptions, now = new Date()): CaptureResult {
  const s = store.get();
  const bridge = bridgeFor(store);
  const t = bridge.scene?.getTerrain() ?? null;
  if (!t || s.loading) return { ok: false, error: 'Load a scene first.' };
  if (headlessBusy(store)) return { ok: false, error: 'A sweep, ensemble or comparison is running: save when it has finished.' };
  const scene = sceneOf(s, t);
  if (!scene) return { ok: false, error: 'This scene cannot be saved in a project.' };
  const h = projectHooksFor(store);
  const log = editLogFor(store);
  const notes: string[] = [];
  if (log.overflow) notes.push(`The edit log is full (${PROJECT_LIMITS.maxEdits} edits): edits after that are not in the project.`);
  const pose = bridge.scene?.getCamera?.()?.pose ?? null;
  const portfolio = opts.includePortfolio ? (h.portfolio?.get() ?? null) : null;
  if (opts.includePortfolio && portfolio && portfolio.text.length > PROJECT_LIMITS.maxPortfolioChars) {
    notes.push('The portfolio CSV is too large to keep in a project file and was left out.');
  }
  const chain = bridge.chain;
  const project: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: cleanPlaceLabel(opts.name, PROJECT_LIMITS.nameChars),
    savedAt: now.toISOString(),
    scene,
    grid: { nx: t.nx, ny: t.ny, cellSize: t.cellSize },
    scenario: {
      stageOffset: s.stageOffset,
      sim: simForProject(s.sim),
      sources: s.sources.slice(0, PROJECT_LIMITS.maxSources).map(cleanSource),
      storms: s.storms.slice(0, PROJECT_LIMITS.maxStorms).map((c) => ({ id: c.id, gx: c.gx, gy: c.gy, radius: c.radius, intensity: c.intensity })),
      shelters: s.shelters.slice(0, PROJECT_LIMITS.maxShelters).map((c) => ({ name: cleanPlaceLabel(c.name, PROJECT_LIMITS.labelChars), gx: c.gx, gy: c.gy })),
      evacStart: s.evacStart ? { gx: s.evacStart.gx, gy: s.evacStart.gy } : null,
      climate: s.climate ? { horizon: s.climate.horizon, pathway: s.climate.pathway, scaling: s.climate.scaling } : null,
      chain: chain
        ? {
            inflow: chain.inflow,
            ...pickChain(chain.whatIf.overrides),
            ...(chain.whatIf.mode ? { mode: chain.whatIf.mode } : {}),
          }
        : null,
    },
    edits: cloneEdits(log.edits),
    sites: sitesFor(store).sites.map(siteToProject),
    siteCheck: h.siteCheck?.getSettings() ?? null,
    ensemble: h.ensemble?.getSettings() ?? null,
    portfolio: portfolio && portfolio.text.length <= PROJECT_LIMITS.maxPortfolioChars ? { name: cleanPlaceLabel(portfolio.name, PROJECT_LIMITS.nameChars), csv: portfolio.text } : null,
    camera: pose ? { target: { ...pose.target }, distance: pose.distance, yaw: pose.yaw, pitch: pose.pitch } : null,
    view: {
      waterMode: s.render.waterMode,
      verticalExaggeration: s.render.verticalExaggeration,
      showImagery: s.render.showImagery,
      showRoads: s.render.showRoads,
      showContours: s.render.showContours,
      ...(s.render.probabilityThreshold === 0.15 || s.render.probabilityThreshold === 0.5 ? { probabilityThreshold: s.render.probabilityThreshold } : {}),
      timeOfDay: s.look.timeOfDay,
      buildings: s.look.buildings,
    },
    designs: (h.designs?.get() ?? []).map((d) => ({ ...d, edits: cloneEdits(d.edits), cost: { ...d.cost } })),
    comparison: opts.includeResults ? (h.designs?.summary() ?? null) : null,
  };
  return { ok: true, project, notes };
}

function pickChain(o: { volumeFactor?: number; erosionRate?: number; cv?: number; bulking?: number; baseflow?: number }) {
  const out: { volumeFactor?: number; erosionRate?: number; cv?: number; bulking?: number; baseflow?: number } = {};
  for (const k of ['volumeFactor', 'erosionRate', 'cv', 'bulking', 'baseflow'] as const) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Is `scene` the scene on screen? */
export function sceneMatches(s: AppState, t: TerrainData | null, scene: ProjectScene): boolean {
  if (scene.kind === 'preset') return s.presetId === scene.id && !!t;
  if (s.presetId || !t) return false;
  const c = gridToGeo(t, t.nx / 2, t.ny / 2);
  return Math.abs(c.lat - scene.lat) < 2e-4 && Math.abs(c.lon - scene.lon) < 2e-4 && Math.abs(t.nx * t.cellSize - scene.sizeM) < 2 && t.nx === scene.resolution;
}

export interface ApplyDeps {
  store: Store;
  actions: AppActions;
  /** The project came from a link: a live area's name is shown with its coordinates (nameFromLink). */
  fromLink?: boolean;
  /** Wait for the scene to finish loading (resolves the terrain, or null when it did not load). */
  waitForScene(): Promise<TerrainData | null>;
}

/**
 * Put a validated project on screen. Returns the notes to show (fixed sentences). Loads the project's scene first
 * when another is on screen.
 */
export async function applyProject(p: ProjectFile, deps: ApplyDeps): Promise<{ ok: boolean; notes: string[] }> {
  const { store, actions } = deps;
  const bridge = bridgeFor(store);
  const notes: string[] = [];
  if (headlessBusy(store)) return { ok: false, notes: ['A sweep, ensemble or comparison is running: open the project when it has finished.'] };
  let t = bridge.scene?.getTerrain() ?? null;
  if (!sceneMatches(store.get(), t, p.scene)) {
    if (p.scene.kind === 'preset') {
      await actions.loadPreset(p.scene.id);
    } else {
      const req: LiveAreaRequest = {
        center: { lat: p.scene.lat, lon: p.scene.lon },
        sizeMeters: p.scene.sizeM,
        resolution: p.scene.resolution,
        ...(p.scene.name ? { name: p.scene.name, ...(deps.fromLink ? { nameFromLink: true } : {}) } : {}),
      };
      const r = await actions.loadLiveArea(req);
      if (r === 'failed' || r === 'superseded') return { ok: false, notes: ['The project’s live area could not be loaded (it needs the internet); nothing was changed.'] };
    }
    t = await deps.waitForScene();
    if (!t || !sceneMatches(store.get(), t, p.scene)) return { ok: false, notes: ['The project’s scene could not be loaded; nothing was changed.'] };
  }
  const solver = bridge.scene?.getSolver() ?? null;
  if (!t || !solver) return { ok: false, notes: ['The simulation is not ready yet; try again in a moment.'] };
  const sameGrid = !p.grid || (p.grid.nx === t.nx && p.grid.ny === t.ny && Math.abs(p.grid.cellSize - t.cellSize) <= 1e-3 * t.cellSize);
  if (!sameGrid) notes.push('The project was saved on a different grid of this scene: its walls, terrain edits, designs, sources, storms, shelters and camera were not applied.');

  // Scenario: one store update, so the stage bases are re-derived from levels that already include the offset.
  const s0 = store.get();
  const sc = p.scenario;
  store.set({
    stageOffset: sc.stageOffset,
    sim: mergeSim(s0.sim, sc.sim),
    ...(sameGrid ? { sources: sc.sources.map((x) => ({ ...x })), storms: sc.storms.map((x) => ({ ...x })), shelters: sc.shelters.map((x) => ({ ...x })), evacStart: sc.evacStart } : {}),
    ...(sc.climate ? { climate: { ...sc.climate } } : {}),
  });
  if (sc.chain && bridge.chain && bridge.chainControl) {
    const { inflow, mode, ...overrides } = sc.chain;
    if (Object.keys(overrides).length || mode) bridge.chainControl.run({ overrides, ...(mode ? { mode } : {}) });
    if (inflow !== bridge.chain.inflow) bridge.chainControl.setInflow(inflow);
  }

  // Terrain: back to the scene's own ground, then the project's edits in order (recorded as the user's own).
  if (sameGrid) {
    actions.resetAll();
    if (p.edits.length) {
      replayEdits(solver, p.edits);
      if (p.edits.some((e) => e.op === 'wall')) bridge.wallDrawn.emit();
    }
  }
  actions.resetWater();

  // Sites, panel settings, portfolio, designs.
  const reg = sitesFor(store);
  reg.replace(p.sites.map(siteFromProject));
  const h = projectHooksFor(store);
  if (p.siteCheck) await h.siteCheck?.applySettings(p.siteCheck);
  if (p.ensemble) h.ensemble?.applySettings(p.ensemble);
  if (p.portfolio) {
    if (h.portfolio) h.portfolio.load(p.portfolio.name, p.portfolio.csv);
  }
  h.designs?.set(sameGrid ? p.designs : [], p.comparison);

  // View and camera.
  if (p.view) {
    const s = store.get();
    store.set({
      render: { ...s.render, waterMode: p.view.waterMode, verticalExaggeration: p.view.verticalExaggeration, showImagery: p.view.showImagery, showRoads: p.view.showRoads, showContours: p.view.showContours, ...(p.view.probabilityThreshold ? { probabilityThreshold: p.view.probabilityThreshold } : {}) },
      look: { ...s.look, ...(p.view.timeOfDay ? { timeOfDay: p.view.timeOfDay } : {}), ...(p.view.buildings !== undefined ? { buildings: p.view.buildings } : {}) },
    });
  }
  const cam = bridge.scene?.getCamera?.() ?? null;
  if (cam && p.camera && sameGrid) {
    const c = p.camera;
    const inside = c.target.gx >= -t.nx && c.target.gx <= 2 * t.nx && c.target.gy >= -t.ny && c.target.gy <= 2 * t.ny;
    if (inside) cam.flyTo({ target: { ...c.target }, distance: c.distance, yaw: c.yaw, pitch: c.pitch }, 1.2);
  }
  return { ok: true, notes };
}
