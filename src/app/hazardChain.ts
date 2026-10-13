/**
 * The glacier hazard chain behind a chain preset's flood (ScenarioPreset.hazardChain, src/hazard/): on a scene that has
 * one, fetch its valley profile (chain.json), run the chain off the main thread (src/hazard/workerClient.ts), drive
 * the map's inflow with the routed hydrograph at the domain edge (toWaterSource: the routed volume exactly, then a
 * ramp down to baseflow; 2-D t = 0 a few minutes before the front reaches the edge), then run the §I.5 ensemble for
 * the p10–p90 bands. The result is published on
 * the UI bridge (ChainView) for the chain panel, the valley timeline and the event clock, which re-run it through
 * ChainControl.
 *
 * WHAT DRIVES THE MAP. 'chain' (default): the preset's inflow at the domain entry is replaced by the routed one, in the
 * store's sources AND its scenario copy (so Restore scenario keeps it); terrain.scenario keeps the preset's own, which
 * 'scenario' puts back. Swapping the inflow resets the water: the hydrograph's times are 2-D solver times since reset.
 * While the first run computes, the entry inflow is held back (the rivers start dry, so the map waits for the wave).
 *
 * BAKED RESULTS. A chain preset ships the calibrated run it was baked with (HazardChainSpec.result →
 * chain-result.json, a BakedChainResult): the ensemble member whose entry peak is the median, and the clock offset its
 * baked inflow starts at. The live run starts from that member's parameters (`run.member`, layered UNDER the panel's
 * what-if, which is a delta from the scenario's defaults), so the default view reproduces the baked inflow instead of
 * the trigger's raw defaults — Chungthang's edge peak was 17,213 m³/s live against 9,578 baked before this. A missing
 * or unreadable chain-result.json only costs that: the chain then runs from the trigger's own defaults.
 *
 * The solver's rheology (HazardChainSpec.rheology / solver.uMax) is not applied here.
 */
import type { ScenarioPreset, Store, WaterSource } from '../contracts';
import type { BakedChainResult, ChainFile, HazardChainSpec } from '../hazard/types';
import type { ChainOverrides, ChainRunResult } from '../hazard/chain';
import { createHazardWorker, type HazardChainBackend } from '../hazard/workerClient';
import { bridgeFor, postNotice, type ChainInflowMode, type ChainView, type ChainWhatIf } from '../ui/bridge';
import { presetFileUrl } from '../data';
import { fetchJSON } from '../data/net';
import { errorMessage, type ErrorReporter } from './errors';
import type { Scene } from './scene';

export interface HazardChainDeps {
  store: Store;
  errors: ErrorReporter;
  /** Reset the water (the routed hydrograph starts at the solver's t = 0). */
  resetWater(): void;
  /** Backend factory (tests pass an inline one). */
  createBackend?: () => HazardChainBackend;
  /** chain.json loader (tests pass a stub). */
  loadFile?: (url: string) => Promise<unknown>;
}

/** Is `v` plausibly a ChainFile (the chain engine indexes these arrays by node; a bad file must fail here, loudly)? */
export function isChainFile(v: unknown): v is ChainFile {
  const f = v as Partial<ChainFile> | null;
  if (!f || typeof f !== 'object' || f.version !== 1 || !Array.isArray(f.s) || f.s.length < 2) return false;
  const n = f.s.length;
  return (
    Array.isArray(f.zBed) &&
    f.zBed.length === n &&
    Array.isArray(f.n) &&
    f.n.length === n &&
    Array.isArray(f.sections) &&
    f.sections.length === n &&
    Array.isArray(f.stations) &&
    Array.isArray(f.structures) &&
    !!f.domainEntry &&
    Number.isFinite(f.domainEntry.s) &&
    Number.isFinite(f.domainEntry.gx) &&
    Number.isFinite(f.domainEntry.gy)
  );
}

/**
 * The preset's sources with the inflow at the chain's domain entry replaced by `routed` (appended when there is none
 * there). An inflow "at the entry" is one whose footprint centre lies within the entry's radius plus its own.
 */
export function replaceEntryInflow(sources: readonly WaterSource[], entry: ChainFile['domainEntry'], routed: WaterSource | null): WaterSource[] {
  const near = (w: WaterSource) => w.type === 'inflow' && Math.hypot(w.gx - entry.gx, w.gy - entry.gy) <= entry.radius + w.radius + 1;
  const out: WaterSource[] = [];
  let placed = false;
  for (const w of sources) {
    if (!near(w)) {
      out.push(w);
      continue;
    }
    if (routed && !placed) out.push(routed);
    placed = true;
  }
  if (routed && !placed) out.push(routed);
  return out;
}

/** The trigger with a what-if's mode applied (only massIntoRiver has one). */
export function specFor(spec: HazardChainSpec, whatIf: ChainWhatIf): HazardChainSpec {
  if (whatIf.mode && spec.trigger.kind === 'massIntoRiver' && spec.trigger.mode !== whatIf.mode) {
    return { ...spec, trigger: { ...spec.trigger, mode: whatIf.mode } };
  }
  return spec;
}

/**
 * A full ChainRunResult baked into the preset, when there is one. chain-result.json (BakedChainResult) holds summaries
 * — fronts, peaks, bands — not the time series the timeline and the inflow need, so every chain preset still runs its
 * baked member in the worker (loadBaked) and this returns null. Returning a result here would skip that run.
 */
function bakedResult(_scenario: ScenarioPreset, _file: ChainFile): ChainRunResult | null {
  return null;
}

export class HazardChainController {
  private backend: HazardChainBackend | null = null;
  /** Bumped by every scene change: answers for an older scene are dropped. */
  private sceneToken = 0;
  /** Bumped by every run: answers for an older what-if are dropped. */
  private runToken = 0;
  /** A worker job is in flight (a new run restarts the worker rather than queue behind a 6 s ensemble). */
  private busy = false;
  private scenario: ScenarioPreset | null = null;
  private inflow: ChainInflowMode = 'chain';
  /** The baked run's member parameters (the base every what-if is layered on) and its inflow's clock offset. */
  private baseOverrides: ChainOverrides = {};
  private bakedOffset: number | null = null;
  /**
   * Future-climate lake growth (src/climate, set by the app): multiplies the source volume of every run ON TOP of the
   * baked member and the panel's what-if, so the chain panel keeps working in today's volumes. 1 = today.
   */
  private climateVolumeFactor = 1;
  private climateLabel: string | null = null;

  constructor(private readonly deps: HazardChainDeps) {}

  private get bridge() {
    return bridgeFor(this.deps.store);
  }

  private get view(): ChainView | null {
    return this.bridge.chain;
  }

  private publish(patch: Partial<ChainView>): void {
    const v = this.view;
    if (v) this.bridge.setChain({ ...v, ...patch });
  }

  /** The scene is going away. */
  onSceneCleared(): void {
    this.sceneToken++;
    this.runToken++;
    this.scenario = null;
    this.bridge.chainControl = null;
    this.bridge.setChain(null);
  }

  /** A scene is on screen: start its chain if it has one. */
  onSceneReady(scene: Scene): void {
    const token = ++this.sceneToken;
    this.runToken++;
    const sc = scene.terrain.scenario;
    const spec = sc?.hazardChain;
    if (!sc || !spec || scene.request.kind !== 'preset') {
      this.scenario = null;
      this.bridge.chainControl = null;
      this.bridge.setChain(null);
      return;
    }
    this.scenario = sc;
    this.inflow = 'chain';
    this.baseOverrides = {};
    this.bakedOffset = null;
    const presetId = scene.request.id;
    this.bridge.setChain({
      sceneKey: `${presetId}#${token}`,
      spec,
      file: null,
      status: 'loading',
      progress: null,
      error: null,
      result: null,
      bands: null,
      entryBand: null,
      members: null,
      offset: 0,
      whatIf: { overrides: {} },
      inflow: this.inflow,
      origin: 'worker',
      ms: null,
      climate: this.climateLabel ? { label: this.climateLabel, volumeFactor: this.climateVolumeFactor } : null,
    });
    this.bridge.chainControl = {
      run: (whatIf) => void this.run(whatIf),
      setInflow: (mode) => this.setInflow(mode),
    };
    void this.start(token, presetId, sc, spec);
  }

  private async start(token: number, presetId: string, sc: ScenarioPreset, spec: HazardChainSpec): Promise<void> {
    const url = presetFileUrl(presetId, spec.profile);
    try {
      if (!url) throw new Error(`the preset names no usable valley profile (“${spec.profile}”)`);
      const raw = await (this.deps.loadFile ?? ((u: string) => fetchJSON(u, { retries: 1 })))(url);
      if (token !== this.sceneToken) return;
      if (!isChainFile(raw)) throw new Error(`${spec.profile} is not a valley profile this version can read`);
      this.publish({ file: raw });
      await this.loadBaked(token, presetId, spec);
      if (token !== this.sceneToken) return;
      const baked = bakedResult(sc, raw);
      if (baked) {
        await this.apply(token, this.runToken, baked, { overrides: {} }, 'baked', null);
        return;
      }
      // Hold the entry inflow back while the wave is routed down the valley: the map waits for it.
      const s = this.deps.store.get();
      this.deps.store.set({ sources: replaceEntryInflow(s.sources, raw.domainEntry, null) });
      await this.run({ overrides: {} });
    } catch (err) {
      if (token !== this.sceneToken) return;
      this.fail(token, err);
    }
  }

  /** Read the preset's baked chain run, if it names one: its member parameters and inflow clock offset. */
  private async loadBaked(token: number, presetId: string, spec: HazardChainSpec): Promise<void> {
    if (!spec.result) return;
    const url = presetFileUrl(presetId, spec.result);
    if (!url) return;
    try {
      const raw = (await (this.deps.loadFile ?? ((u: string) => fetchJSON(u, { retries: 1 })))(url)) as Partial<BakedChainResult> | null;
      if (token !== this.sceneToken || !raw || typeof raw !== 'object') return;
      const m = raw.run?.member;
      const base: ChainOverrides = {};
      if (m && Number.isFinite(m.volumeFactor) && m.volumeFactor > 0) base.volumeFactor = m.volumeFactor;
      if (m && m.erosionRate !== undefined && Number.isFinite(m.erosionRate) && m.erosionRate > 0) base.erosionRate = m.erosionRate;
      if (m && Number.isFinite(m.cv) && m.cv >= 0 && m.cv < 1) base.cv = m.cv;
      this.baseOverrides = base;
      const off = raw.domain?.offset;
      this.bakedOffset = typeof off === 'number' && Number.isFinite(off) ? off : null;
    } catch (err) {
      if (token !== this.sceneToken) return;
      this.deps.errors.warn('chain', `the baked chain run could not be read (${errorMessage(err)}); running from the trigger's defaults`, { toast: false });
    }
  }

  /** Run the chain for a what-if: deterministic run → drive the map → ensemble bands. */
  async run(whatIf: ChainWhatIf): Promise<void> {
    const view = this.view;
    const file = view?.file;
    if (!view || !file) return;
    const token = this.sceneToken;
    const runId = ++this.runToken;
    const spec = specFor(view.spec, whatIf);
    // The baked member's parameters under the user's changes (see BAKED RESULTS above), then the climate's lake growth.
    const overrides: ChainOverrides = { ...this.baseOverrides, ...whatIf.overrides };
    if (this.climateVolumeFactor !== 1) overrides.volumeFactor = (overrides.volumeFactor ?? 1) * this.climateVolumeFactor;
    // A job still in flight would make this run wait behind it: start a fresh worker instead.
    if (this.busy) this.disposeBackend();
    const backend = (this.backend ??= (this.deps.createBackend ?? createHazardWorker)());
    const current = () => token === this.sceneToken && runId === this.runToken;
    this.publish({ status: 'running', progress: null, error: null, whatIf, bands: null, entryBand: null, members: null });
    this.busy = true;
    try {
      const { ms, result } = await backend.run(spec, file, overrides);
      if (!current()) return;
      await this.apply(token, runId, result, whatIf, 'worker', ms);
      if (!current()) return;
      this.publish({ status: 'ensemble', progress: { done: 0, total: 1 } });
      const { ensemble } = await backend.ensemble(spec, file, overrides, {
        onProgress: (done, total) => {
          if (current()) this.publish({ progress: { done, total } });
        },
      });
      if (!current()) return;
      this.publish({ status: 'ready', progress: null, bands: ensemble.stationBands, entryBand: ensemble.result.ensemble ?? null, members: ensemble.members });
    } catch (err) {
      // A crashed worker refuses every later request: drop it (whoever's run this was), so the next run gets a new one.
      if (backend.broken && this.backend === backend) this.disposeBackend();
      if (!current()) return;
      // The map already runs on the routed hydrograph when only the ensemble failed: keep it, say so.
      if (this.view?.result && this.view.status === 'ensemble') {
        this.deps.errors.warn('chain', `the uncertainty ensemble failed: ${errorMessage(err)}`, { toast: false });
        this.publish({ status: 'ready', progress: null, error: `Uncertainty bands unavailable: ${errorMessage(err)}` });
        return;
      }
      this.fail(token, err);
    } finally {
      if (runId === this.runToken) this.busy = false;
    }
  }

  /** Publish a result and, in 'chain' mode, drive the map's inflow with it. */
  private async apply(token: number, runId: number, result: ChainRunResult, whatIf: ChainWhatIf, origin: ChainView['origin'], ms: number | null): Promise<void> {
    const file = this.view?.file;
    if (!file || token !== this.sceneToken || runId !== this.runToken) return;
    const offset = this.inflow === 'chain' ? domainOffsetSync(result) : this.scenarioOffset(result);
    this.publish({ result, whatIf, origin, ms, offset, status: origin === 'baked' ? 'ready' : this.view!.status });
    await this.drive();
  }

  /**
   * The chain clock at the 2-D t = 0 when the preset's own inflow drives the map. A baked chain preset's inflow IS the
   * baked routed hydrograph, which starts at its own offset (the entry front less the preroll); a preset without a
   * baked run starts its inflow where its description puts the front, at the routed front's arrival at the entry.
   */
  private scenarioOffset(result: ChainRunResult): number {
    if (this.bakedOffset !== null) return this.bakedOffset;
    return Number.isFinite(result.entryFront) ? result.entryFront : 0;
  }

  /** Put the inflow the mode asks for on the map and reset the water. */
  private async drive(): Promise<void> {
    const view = this.view;
    const sc = this.scenario;
    const file = view?.file;
    if (!view || !sc || !file) return;
    const { store } = this.deps;
    if (this.inflow === 'scenario' || !view.result) {
      store.set({ scenario: sc, sources: sc.sources.map((w) => ({ ...w })) });
    } else {
      const { toWaterSource } = await import('../hazard/chain');
      if (this.view !== view) return;
      const routed = toWaterSource(view.result, file, {
        offset: view.offset,
        id: 'chain-inflow',
        label: `Routed flood wave from upstream (${file.name}) — modelled by the 1-D hazard chain`,
      });
      const sources = replaceEntryInflow(sc.sources, file.domainEntry, routed);
      store.set({ scenario: { ...sc, sources }, sources: sources.map((w) => ({ ...w })) });
    }
    this.deps.resetWater();
  }

  /**
   * Future-climate lake growth: the source-volume multiplier (1 = today) and the climate it stands for. A change re-runs
   * the chain with the current what-if (when one has run on this scene; the first run of a scene picks it up anyway).
   */
  setClimateVolumeFactor(factor: number, label: string | null): void {
    const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
    if (f === this.climateVolumeFactor && label === this.climateLabel) return;
    const rerun = f !== this.climateVolumeFactor;
    this.climateVolumeFactor = f;
    this.climateLabel = f === 1 ? null : label;
    this.publish({ climate: this.climateLabel ? { label: this.climateLabel, volumeFactor: f } : null });
    const view = this.view;
    if (rerun && view?.file && view.status !== 'loading') void this.run(view.whatIf);
  }

  /** Switch what drives the map (the chain result stays on screen either way). */
  setInflow(mode: ChainInflowMode): void {
    const view = this.view;
    if (!view || mode === this.inflow) return;
    this.inflow = mode;
    const offset = view.result ? (mode === 'chain' ? domainOffsetSync(view.result) : this.scenarioOffset(view.result)) : view.offset;
    this.publish({ inflow: mode, offset });
    void this.drive();
  }

  private fail(token: number, err: unknown): void {
    if (token !== this.sceneToken) return;
    const msg = errorMessage(err);
    this.deps.errors.warn('chain', `hazard chain: ${msg}`, { toast: false });
    this.publish({ status: 'error', error: msg, progress: null });
    // Without a routed wave the map falls back on the preset's own inflow.
    if (this.inflow === 'chain') {
      this.inflow = 'scenario';
      this.publish({ inflow: 'scenario' });
      const sc = this.scenario;
      if (sc) this.deps.store.set({ scenario: sc, sources: sc.sources.map((w) => ({ ...w })) });
      postNotice(this.deps.store, {
        kind: 'warn',
        key: 'chain-failed',
        title: 'The upstream chain could not run',
        message: `The map runs the preset’s own inflow instead. (${msg})`,
        durationMs: 9000,
      });
    }
  }

  private disposeBackend(): void {
    try {
      this.backend?.dispose();
    } catch {
      /* already gone */
    }
    this.backend = null;
    this.busy = false;
  }

  dispose(): void {
    this.onSceneCleared();
    this.disposeBackend();
  }
}

/**
 * domainClockOffset's default (300 s of baseflow before the front), without importing the chain engine on the main
 * thread for one subtraction. Kept equal to src/hazard/chain.ts; tests/ui/chain.test.ts checks the two agree.
 */
export function domainOffsetSync(result: Pick<ChainRunResult, 'entryFront'>, preroll = 300): number {
  return Number.isFinite(result.entryFront) ? Math.max(0, result.entryFront - preroll) : 0;
}
