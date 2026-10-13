/**
 * The Site check panel section: due diligence on candidate parcels. The user drops a pin or outlines a parcel with the
 * Site tool (tools.ts), describes the planned building, and gets
 *   • a card for the flood on screen: depth at grade and above the planned floor, speed, AIDR class, arrival and lead
 *     time, time under water, damage and loss, and egress — when the last road route to a shelter closes;
 *   • a sweep: the same site run automatically against a ladder of event levels (NWS flood categories, FEMA / NOAA
 *     frequency levels, historic crests — src/loss/ladders.ts — or multiples of the scenario's rain and inflows),
 *     headless at full speed, cancellable, with the user's scenario put back afterwards; then EAL, a loss-exceedance
 *     chart, an indicative finished-floor elevation, mitigation options with BCR, and a verdict in plain words;
 *   • a printable / downloadable "Site assessment" report.
 * All arithmetic is in src/loss (site.ts, egress.ts, eal.ts); this file reads the flood, drives the runs and lays out
 * the answers.
 *
 * PRIVACY. Sites live in memory (sites.ts). "Share link" writes them into the address bar on request; nothing is
 * stored or uploaded. Names are cleaned (cleanPlaceLabel) and only ever written as text.
 */
import type { FloodSolver, HazardFields, StageControl, TerrainData, WaterSource } from '../contracts';
import { computeInitialWater } from '../data/initialWater';
import { makeGeoToGrid } from '../data/geo';
import { atlas14MayCover, loadAtlas14Grid, lookupAtlas14, type Atlas14Point } from '../data/atlas14';
import { cleanPlaceLabel } from '../data/placeName';
import {
  assessSiteRun,
  band,
  buildAccessIndex,
  DEBRIS_FLOW_PRESETS,
  decodeSites,
  defaultFirstFloorHeight,
  encodeSites,
  FloodTimeline,
  formatReturnPeriod,
  freeboardFor,
  ladderFor,
  ladderKinds,
  LADDER_SOURCES,
  type LadderKind,
  mitigationOptions,
  OCCUPANCY_PROFILES,
  pickDesign,
  RAIN_DESIGN_DURATION_S,
  RAIN_LADDER_CAVEATS,
  RAIN_SWEEP_MINUTES,
  rainLadder,
  recommendFfe,
  regionForBounds,
  SCALE_LADDER,
  SITE_LIMITS,
  SITE_OCCUPANCIES,
  siteFact,
  siteVerdict,
  SnapshotHazardAccumulator,
  summarizeSweep,
  tallySentence,
  TYPICAL_FOOTPRINT_M2,
  type FfeRecommendation,
  type SiteMitigation,
  type SiteOccupancy,
  type SiteRun,
  type SiteSpec,
  type SweepLevelInfo,
  type SweepRow,
  type SweepSummary,
} from '../loss';
import { createRouter } from '../routing';
import { bridgeFor } from './bridge';
import { button } from './controls';
import { h, setText, toggleClass, type UIContext } from './dom';
import { downloadsBlocked, downloadText, safeFilename } from './download';
import { fmtNum, formatClock, formatMoney } from './format';
import { printReport, reportHtmlDocument } from './impactReport';
import { createSiteOverlay } from './siteOverlay';
import {
  buildSiteReport,
  exceedanceChart,
  ffeRows,
  kvList,
  MITIGATION_HEAD,
  mitigationTableRows,
  simpleTable,
  SITE_METHOD_NOTES,
  SITE_REPORT_CSS,
  siteRunRows,
  siteSpecRows,
  SWEEP_HEAD_COMPACT,
  sweepRowsCompact,
  type SiteReportInput,
} from './siteReport';
import { sitesFor } from './sites';
import { storyHooksFor } from './storyHooks';
import { DEMO_SITES_PARAM } from './useCaseDefs';
import { selectTool } from './toolDefs';
import { headlessBusy, runHeadless, saveScenario } from './headless';
import { CLIMATE_TODAY, climateForcing, sweepComparable } from '../climate';
import { climateCompareBlock, compareClimate, type ClimateSweepPair } from './siteClimate';
import type { SiteCheckSettings } from '../project/format';
import { createSiteExtras, PEOPLE_METHOD_NOTES } from './evacPeople';
import { INFRA_METHOD_NOTES } from './infraPanel';
import { SURGE_LADDER_CAVEATS, SURGE_SOURCE_KEY, SURGE_SWEEP_MINUTES } from '../surge/stations';
import { gaugeNote } from '../surge/coastal';

const FT = 0.3048;
/** Simulated minutes per sweep level, default and range. */
export const SWEEP_MINUTES_DEFAULT = 30;
const SWEEP_MINUTES_MIN = 2;
const SWEEP_MINUTES_MAX = 240;
/** runFor chunk, simulated s: with solver accumulators only for cancelling; with snapshots it is the arrival resolution. */
const CHUNK_GPU_S = 300;
const CHUNK_SNAPSHOT_S = 60;
/** URL parameter carrying the sites (src/loss/site.ts encodeSites). */
export const SITES_PARAM = 'sites';

interface LevelCfg {
  id: string;
  label: string;
  ft: number;
  scale: number;
  /** Rain ladder: uniform rain rate for the first hour, mm/h; NaN otherwise. */
  mmPerHour: number;
  sourceRp: number | null;
  userRp: number | null;
  source: string;
  note: string;
  on: boolean;
  /** Beyond the stage slider's range for this scenario. */
  outOfRange: boolean;
}

export type { LadderKind } from '../loss/ladders';

interface SweepState {
  levels: SweepLevelInfo[];
  rows: Map<string, SweepRow[]>;
  /** Spec snapshot each site was swept with (to flag later edits). */
  specs: Map<string, string>;
  durationS: number;
  source: 'gpu' | 'snapshots';
  ladder: LadderKind;
  gaugeLabel: string;
  sourceKeys: string[];
  cancelled: boolean;
  presetId: string | null;
}

export interface SiteSection {
  body: HTMLElement[];
  badge: HTMLElement;
  overlay: HTMLElement;
  activate(): void;
  /**
   * Switch to the NOAA Atlas 14 rain ladder with every level ticked, once the lookup for this scene is done. False when
   * there is no Atlas 14 estimate for the map (outside coverage, or the grid could not be loaded) or a sweep is running.
   */
  useRainLadder(): Promise<boolean>;
  /** Switch to the coastal-surge ladder of a scenario set up by src/surge (every level ticked). False when there is none. */
  useSurgeLadder(): boolean;
  /** Press "Run sweep". */
  runSweep(): Promise<void>;
  /** The sweep settings, for a saved project (src/ui/projectState.ts). */
  getSettings(): SiteCheckSettings;
  /** Restore sweep settings from a project (levels this scene's ladder lacks are ignored). */
  applySettings(s: SiteCheckSettings): Promise<void>;
}

export const specKey = (s: SiteSpec) => JSON.stringify([s.lon, s.lat, s.ring, s.occupancy, s.floors, s.value, s.footprintM2, s.firstFloorHeight, s.criticalElev]);

/** A labelled number input (clamped to [min, max]); `attr` names the data attribute carrying `name` (default data-site-field). */
export function numField(opts: { label: string; unit: string; min: number; max: number; step: number; placeholder?: string; name: string; attr?: string; onChange(v: number | null): void }) {
  const input = h('input', { type: 'number', class: 'dl-num-input', min: opts.min, max: opts.max, step: opts.step, inputmode: 'decimal', placeholder: opts.placeholder ?? null, 'aria-label': opts.label, [opts.attr ?? 'data-site-field']: opts.name });
  const read = (): number | null => {
    if (input.value.trim() === '') return null;
    const v = Number(input.value);
    return Number.isFinite(v) ? Math.min(opts.max, Math.max(opts.min, v)) : null;
  };
  input.addEventListener('change', () => opts.onChange(read()));
  const el = h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, opts.label), h('span', { class: 'dl-num-wrap' }, input, h('span', { class: 'dl-num-unit' }, opts.unit)));
  return {
    el,
    input,
    set(v: number | null, digits = 0) {
      if (document.activeElement === input) return;
      input.value = v === null || !Number.isFinite(v) ? '' : String(Math.round(v * 10 ** digits) / 10 ** digits);
    },
    placeholder(text: string) {
      input.placeholder = text;
    },
  };
}

export function createSiteSection(ctx: UIContext): SiteSection {
  const { store, actions } = ctx;
  const bridge = bridgeFor(store);
  const registry = sitesFor(store);
  const getSolver = (): FloodSolver | null => bridge.scene?.getSolver() ?? null;
  const getTerrain = (): TerrainData | null => bridge.scene?.getTerrain() ?? null;
  const hasGpuFields = (s: FloodSolver | null) => !!s && typeof s.readHazardFields === 'function';

  // ─── State ──────────────────────────────────────────────────────────────────────────────────────────────────
  let terrainRef: TerrainData | null = null;
  let router: ReturnType<typeof createRouter> | null = null;
  let current: { fields: HazardFields; source: 'gpu' | 'snapshots'; endDepth: Float32Array | null; runs: Map<string, SiteRun>; alertTime: number } | null = null;
  let sweep: SweepState | null = null;
  let levels: LevelCfg[] = [];
  /** The ladder on screen, and the user's choice of one ('auto' until they pick). */
  let ladderKind: LadderKind = 'scale';
  let ladderChoice: LadderKind | 'auto' = 'auto';
  /** NOAA Atlas 14 at the map centre (src/data/atlas14.ts), per scene. */
  let rain: { for: TerrainData | null; status: 'idle' | 'loading' | 'ok' | 'none' | 'error'; point: Atlas14Point | null; ready: Promise<boolean> } = { for: null, status: 'idle', point: null, ready: Promise.resolve(false) };
  let durationMin = SWEEP_MINUTES_DEFAULT;
  /** The user typed a duration: switching ladders no longer resets it to the ladder's default. */
  let durationTouched = false;
  let sweeping = false;
  let cancelRequested = false;
  let busy = false;
  let designId: string | null = null;
  let freeboardFt: number | null = null;
  let active = false;
  const liveAcc = new SnapshotHazardAccumulator();
  let tracking = false;

  // ─── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────
  const badge = h('span', { class: 'dl-sec-badge', hidden: true });
  const intro = h(
    'p',
    { class: 'dl-impact-note' },
    'Is this parcel a good place to build, and how do people get out? Drop a site, describe the planned building, then check it against the flood on screen or sweep it through a ladder of flood levels. Indicative screening — not engineering advice.',
  );
  const placeBtn = button('Place a site', () => selectTool(store, 'site'), { icon: 'site', variant: 'primary', className: 'dl-btn-sm', tip: 'Site tool (S): click the map for a pin, or drag around a parcel', side: 'top' });
  const addressBtn = button('Check an address', () => bridge.openAddressCheck?.(), { icon: 'search', className: 'dl-btn-sm', tip: 'Type any US address: load 5 km around it, drop a site there and sweep NOAA Atlas 14 rain return periods', side: 'top' });
  addressBtn.dataset.site = 'check-address';
  const shareBtn = button('Share link', () => shareLink(), { className: 'dl-btn-sm', tip: 'Put the sites in the address bar (?sites=) so a copied link reopens them. Nothing is uploaded.', side: 'top' });
  shareBtn.dataset.site = 'share-link';
  const listEl = h('div', { class: 'dl-site-list' });
  const formEl = h('div', { class: 'dl-site-form' });
  const status = h('p', { class: 'dl-impact-status', 'aria-live': 'polite' });
  const assessBtn = button('Assess this run', () => void assessCurrent(), { icon: 'reset', className: 'dl-btn-sm', tip: 'Read the flood on screen and assess every site against it', side: 'top' });
  const evacBtn = button('Follow on map', () => followOnMap(), { icon: 'route', className: 'dl-btn-sm', tip: 'Set the Evacuate start to the selected site: the live route card re-plans as roads flood', side: 'top' });
  const cardEl = h('div', { class: 'dl-site-card' });

  const sweepIntro = h('p', { class: 'dl-impact-fine' });
  const ladderEl = h('div', { class: 'dl-impact-table dl-site-ladder' });
  const ladderSel = h('select', { class: 'dl-num-input', 'aria-label': 'Event ladder', 'data-site': 'ladder' });
  ladderSel.addEventListener('change', () => {
    const v = ladderSel.value;
    if (v !== 'stage' && v !== 'scale' && v !== 'rain') return;
    ladderChoice = v;
    buildLadder();
    render();
  });
  const ladderPick = h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Event ladder'), ladderSel);
  const rainNote = h('p', { class: 'dl-impact-fine', 'data-site': 'rain-status' });
  const durIn = numField({
    label: 'Simulated time per level',
    unit: 'min',
    min: SWEEP_MINUTES_MIN,
    max: SWEEP_MINUTES_MAX,
    step: 1,
    name: 'duration',
    onChange: (v) => {
      durationTouched = v != null;
      durationMin = v ?? defaultDuration();
    },
  });
  durIn.set(durationMin);
  const runBtn = button('Run sweep', () => void runSweep(), { icon: 'play', variant: 'primary', className: 'dl-btn-sm', tip: 'Run every ticked level headless at full speed; your scenario is put back afterwards', side: 'top' });
  runBtn.dataset.site = 'run-sweep';
  const cancelBtn = button('Cancel', () => (cancelRequested = true), { className: 'dl-btn-sm', tip: 'Stop after the current chunk and restore your scenario', side: 'top' });
  cancelBtn.hidden = true;
  // Future climate (siteClimate.ts): the ladder run under today's forcing, then under the selected climate.
  let climatePair: ClimateSweepPair | null = null;
  const climateBtn = button('Today vs future', () => void runClimateCompare(), { icon: 'play', className: 'dl-btn-sm', tip: 'Run the ticked levels twice — today’s forcing, then the climate chosen under Weather & rivers → Future climate — and compare loss and EAL', side: 'top' });
  climateBtn.dataset.site = 'run-climate-sweep';
  const progress = h('progress', { class: 'dl-site-progress', max: 1, value: 0, hidden: true });
  const sweepStatus = h('p', { class: 'dl-impact-status', 'aria-live': 'polite', 'data-site': 'sweep-status' });
  const sweepOut = h('div', { class: 'dl-site-sweep-out' });

  const printBtn = button('Print site assessment', () => doPrint(), { icon: 'book', className: 'dl-btn-sm', tip: 'Print-friendly site assessment (Save as PDF in the dialog)', side: 'top' });
  const htmlBtn = button('Report .html', () => exportHtml(), { className: 'dl-btn-sm', tip: 'The site assessment as a standalone HTML file', side: 'top' });
  htmlBtn.dataset.site = 'report-html';
  const exportNote = h('p', { class: 'dl-impact-fine' });

  const methods = h(
    'details',
    { class: 'dl-impact-methods' },
    h('summary', null, 'How Site check works'),
    ...SITE_METHOD_NOTES.map((n) => h('div', { class: 'dl-impact-method' }, h('b', null, n.title), h('p', null, n.text))),
  );

  const body = [
    intro,
    h('div', { class: 'dl-row dl-row-wrap' }, placeBtn, addressBtn, shareBtn),
    listEl,
    formEl,
    h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'This run')), h('div', { class: 'dl-row dl-row-wrap' }, assessBtn, evacBtn), status, cardEl),
    h(
      'div',
      { class: 'dl-impact-block' },
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Scenario sweep')),
      sweepIntro,
      ladderPick,
      rainNote,
      ladderEl,
      durIn.el,
      h('div', { class: 'dl-row dl-row-wrap' }, runBtn, climateBtn, cancelBtn),
      progress,
      sweepStatus,
      sweepOut,
    ),
    h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Export')), h('div', { class: 'dl-row dl-row-wrap' }, printBtn, htmlBtn), exportNote),
    methods,
  ];

  const overlay = createSiteOverlay({
    registry,
    getCamera: () => bridge.scene?.getCamera?.() ?? null,
    getTerrain,
    getExaggeration: () => store.get().render.verticalExaggeration,
    getCanvas: () => (typeof document !== 'undefined' ? (document.getElementById('deluge-canvas') as HTMLCanvasElement | null) : null),
    onSelect: (id) => registry.select(id),
  });
  ctx.own(() => overlay.destroy());
  // Evacuation on foot and infrastructure dependencies for the selected site (evacPeople.ts).
  const extras = createSiteExtras({
    store,
    getTerrain,
    getGround: () => getSolver()?.getGroundCPU() ?? getTerrain()?.elevation ?? null,
    getRouter: () => router,
    setWalkRoute: (r, cut) => overlay.setWalkRoute(r, cut),
    rerender: () => {
      renderCard();
      renderSweep();
    },
  });

  // ─── Scene ──────────────────────────────────────────────────────────────────────────────────────────────────
  function ensureScene(t: TerrainData | null) {
    if (t === terrainRef) return;
    terrainRef = t;
    current = null;
    sweep = null;
    designId = null;
    tracking = false;
    liveAcc.reset();
    extras.reset();
    router = null;
    if (t?.roads && t.roads.edges.length) {
      router = createRouter();
      router.setNetwork(t.roads, t.cellSize, { nx: t.nx, ny: t.ny });
    }
    ladderChoice = 'auto';
    rain = { for: null, status: 'idle', point: null, ready: Promise.resolve(false) };
    // The Atlas 14 grid is fetched only once Site check is in use (activate / the address case), not on every scene.
    if (active) ensureRain();
    buildLadder();
    overlay.refresh();
    render();
  }

  function stageCtl(): StageControl | null {
    return store.get().scenario?.stage ?? null;
  }

  /** The map centre, where the rain ladder's Atlas 14 values are read (rain is uniform over the map). */
  function mapCentre(t: TerrainData): { lat: number; lon: number } {
    return { lat: (t.bounds.north + t.bounds.south) / 2, lon: (t.bounds.east + t.bounds.west) / 2 };
  }

  /**
   * Look NOAA Atlas 14 up for this scene (the grid is downloaded once per page, from this app's own origin). Only
   * scenes in the Americas fetch it at all: Atlas 14 covers the U.S. alone, and the Himalayan presets need nothing.
   */
  function ensureRain() {
    const t = terrainRef;
    // A failed download is tried again on the next use (activate, the address case) — loadAtlas14Grid forgets a
    // failure — instead of leaving the scene without a rain ladder until it changes.
    if (!t || (rain.for === t && rain.status !== 'error')) return;
    const c = mapCentre(t);
    if (!atlas14MayCover(c.lat, c.lon)) {
      rain = { for: t, status: 'none', point: null, ready: Promise.resolve(false) };
      return;
    }
    const mine = { for: t as TerrainData | null, status: 'loading' as typeof rain.status, point: null as Atlas14Point | null, ready: Promise.resolve(false) };
    mine.ready = loadAtlas14Grid().then(
      (g) => {
        if (terrainRef !== t) return false;
        const p = lookupAtlas14(g, c.lat, c.lon);
        rain = { ...mine, status: p ? 'ok' : 'none', point: p };
        // The grid arrives after the panel has been on screen: keep what the user ticked and typed.
        if (!sweeping) buildLadder(true);
        render();
        return !!p;
      },
      (e) => {
        if (terrainRef !== t) return false;
        console.warn('[site] NOAA Atlas 14 grid unavailable:', e);
        rain = { ...mine, status: 'error', point: null };
        render();
        return false;
      },
    );
    rain = mine;
  }

  /** Which ladders this scene can run, and which one 'auto' means. */
  function ladderOptions(): { kinds: LadderKind[]; auto: LadderKind } {
    const s = store.get();
    // The same choice as the CLI's (src/loss/ladders.ts ladderKinds).
    return ladderKinds(s.presetId, s.scenario, rain.status === 'ok' && !!rain.point);
  }

  function defaultDuration(): number {
    if (ladderKind === 'stage' && store.get().scenario?.coastal) return SURGE_SWEEP_MINUTES;
    return ladderKind === 'rain' ? RAIN_SWEEP_MINUTES : SWEEP_MINUTES_DEFAULT;
  }

  /** Build the ladder on screen; `keep`: levels that are still there keep their tick and typed return period (by id). */
  function buildLadder(keep = false) {
    const prev = keep ? new Map(levels.map((l) => [l.id, l])) : null;
    const st = stageCtl();
    const ladder = ladderFor(store.get().presetId, store.get().scenario);
    const opts = ladderOptions();
    ladderKind = ladderChoice !== 'auto' && opts.kinds.includes(ladderChoice) ? ladderChoice : opts.auto;
    if (!durationTouched) {
      durationMin = defaultDuration();
      durIn.set(durationMin);
    }
    if (ladderKind === 'rain' && rain.point) {
      levels = rainLadder(rain.point).map((l) => ({
        id: l.id,
        label: l.label,
        ft: NaN,
        scale: NaN,
        mmPerHour: l.mmPerHour,
        sourceRp: l.returnPeriod,
        userRp: null,
        source: l.source,
        note: `${l.ari}-yr average recurrence`,
        on: true,
        outOfRange: false,
      }));
    } else if (ladderKind === 'stage' && st && ladder) {
      levels = ladder.map((l) => {
        const off = l.ft * FT + st.gaugeDatum - st.normalLevel;
        return { id: l.id, label: l.label, ft: l.ft, scale: NaN, sourceRp: l.returnPeriod, userRp: null, mmPerHour: NaN, source: l.source, note: l.note ?? '', on: true, outOfRange: off < 0 || off > st.maxOffset };
      });
    } else if (ladderKind === 'stage' && st) {
      // A stage scenario without a researched ladder: the slider's own marks.
      levels = [
        ...(st.floodStageFt != null ? [{ label: 'Flood stage', ft: st.floodStageFt }] : []),
        ...(st.marks ?? []).map((m) => ({ label: m.label, ft: m.ft })),
      ].map((m, i) => ({ id: `m${i}`, label: m.label, ft: m.ft, scale: NaN, mmPerHour: NaN, sourceRp: null, userRp: null, source: '', note: '', on: true, outOfRange: false }));
    } else {
      levels = SCALE_LADDER.map((k) => ({ id: `x${k}`, label: `Scenario forcing × ${k}`, ft: NaN, scale: k, mmPerHour: NaN, sourceRp: null, userRp: null, source: '', note: '', on: k === 0.5 || k === 1, outOfRange: false }));
    }
    for (const l of levels) {
      const p = prev?.get(l.id);
      if (p) {
        l.on = p.on;
        if (l.sourceRp == null) l.userRp = p.userRp;
      }
      if (l.outOfRange) l.on = false;
    }
  }

  // ─── Reading the flood ──────────────────────────────────────────────────────────────────────────────────────
  function startTracking() {
    if (tracking) return;
    const solver = getSolver();
    const terrain = getTerrain();
    if (!solver || !terrain || hasGpuFields(solver)) return;
    tracking = true;
    try {
      liveAcc.setBaseline(computeInitialWater(terrain, store.get().scenario));
    } catch {
      liveAcc.setBaseline(null);
    }
    feed(liveAcc);
  }

  function feed(acc: SnapshotHazardAccumulator) {
    const snap = getSolver()?.getSnapshot();
    if (snap) acc.feed(snap.depth, snap.nx, snap.ny, snap.simTime);
  }

  async function readFields(acc: SnapshotHazardAccumulator): Promise<{ fields: HazardFields; source: 'gpu' | 'snapshots' } | null> {
    const solver = getSolver();
    if (!solver) return null;
    if (hasGpuFields(solver)) return { fields: await solver.readHazardFields!(), source: 'gpu' };
    feed(acc);
    const f = acc.fields();
    return f ? { fields: f, source: 'snapshots' } : null;
  }

  function runContext(fields: HazardFields, endDepth: Float32Array | null, timeline: FloodTimeline | undefined) {
    const t = getTerrain()!;
    const solver = getSolver();
    const s = store.get();
    return {
      region: regionForBounds(t.bounds),
      grid: { nx: t.nx, ny: t.ny, cellSize: t.cellSize },
      toGrid: makeGeoToGrid(t),
      ground: solver?.getGroundCPU() ?? t.elevation,
      heightProfile: regionForBounds(t.bounds).iso === 'NP' ? ('nepal' as const) : ('us' as const),
      debrisFlow: !!s.presetId && DEBRIS_FLOW_PRESETS.has(s.presetId),
      alertTime: 0,
      access: buildAccessIndex(t.roads ?? null, fields, t.cellSize),
      router,
      shelters: s.shelters,
      hasRoads: !!router,
      timeline,
      endDepth,
    };
  }

  function assessAll(fields: HazardFields, endDepth: Float32Array | null, specs: readonly SiteSpec[]): Map<string, SiteRun> {
    const out = new Map<string, SiteRun>();
    if (!specs.length) return out;
    const tl = new FloodTimeline(fields);
    const c = runContext(fields, endDepth, tl);
    for (const s of specs) out.set(s.id, assessSiteRun(s, fields, c));
    return out;
  }

  async function assessCurrent(): Promise<void> {
    if (busy || sweeping) return;
    const terrain = getTerrain();
    if (!terrain || !getSolver()) return setStatus('Load a scene first.');
    ensureScene(terrain);
    if (!registry.sites.length) return setStatus('Place a site first (Site tool, S).');
    busy = true;
    assessBtn.disabled = true;
    setStatus('Reading the flood…');
    try {
      startTracking();
      const r = await readFields(liveAcc);
      if (!r) return setStatus('Waiting for the first depth snapshot — try again in a moment.', 'warn');
      if (getTerrain() !== terrain) return;
      const t0 = performance.now();
      const endDepth = getSolver()?.getSnapshot()?.depth.slice() ?? null;
      current = { fields: r.fields, source: r.source, endDepth, runs: assessAll(r.fields, endDepth, registry.sites), alertTime: 0 };
      setStatus(`Flood at ${formatClock(r.fields.simTime)} · ${registry.sites.length} site${registry.sites.length === 1 ? '' : 's'} in ${fmtNum(performance.now() - t0, 0)} ms${r.source === 'snapshots' ? ' · depth snapshots only (no speeds)' : ''}.`);
      render();
    } catch (err) {
      setStatus(`Couldn’t assess the sites: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    } finally {
      busy = false;
      assessBtn.disabled = false;
    }
  }

  /** A site was edited: re-assess against the flood already read (cheap; no GPU readback). */
  function reassessCurrent() {
    if (!current || getTerrain() !== terrainRef) return;
    current.runs = assessAll(current.fields, current.endDepth, registry.sites);
  }

  // ─── The sweep ──────────────────────────────────────────────────────────────────────────────────────────────
  function scaledForcing(k: number, base: { sources: WaterSource[]; storms: ReturnType<typeof store.get>['storms']; rainRate: number }) {
    return {
      sources: base.sources.map((s) =>
        s.type === 'inflow' ? { ...s, discharge: s.discharge * k, ...(s.hydrograph ? { hydrograph: s.hydrograph.map((p) => ({ t: p.t, q: p.q * k })) } : {}) } : s,
      ),
      storms: base.storms.map((s) => ({ ...s, intensity: s.intensity * k })),
      rainRate: base.rainRate * k,
    };
  }

  async function runSweep(): Promise<void> {
    if (sweeping || busy) return;
    const terrain = getTerrain();
    const solver = getSolver();
    const sim = bridge.sim;
    if (!terrain || !solver || !sim) return setSweepStatus('The simulation is not running yet.', 'warn');
    ensureScene(terrain);
    const specs = registry.sites.slice();
    const todo = levels.filter((l) => l.on && !l.outOfRange);
    if (!specs.length) return setSweepStatus('Place a site first (Site tool, S).', 'warn');
    if (!todo.length) return setSweepStatus('Tick at least one level.', 'warn');
    if (headlessBusy(store)) return setSweepStatus('An ensemble is running (Uncertainty): wait for it, or cancel it.', 'warn');
    const st = stageCtl();
    const kind = ladderKind;
    const s0 = store.get();
    const saved = saveScenario(s0);
    const gpu = hasGpuFields(solver);
    const chunk = gpu ? CHUNK_GPU_S : CHUNK_SNAPSHOT_S;
    const dur = Math.round(durationMin * 60);
    const acc = new SnapshotHazardAccumulator();
    const state: SweepState = {
      levels: [],
      rows: new Map(specs.map((s) => [s.id, []])),
      specs: new Map(specs.map((s) => [s.id, specKey(s)])),
      durationS: dur,
      source: gpu ? 'gpu' : 'snapshots',
      ladder: kind,
      gaugeLabel: kind === 'stage' ? (st?.label ?? '') : '',
      sourceKeys: [...new Set(todo.map((l) => l.source).filter(Boolean))],
      cancelled: false,
      presetId: s0.presetId,
    };
    sweeping = true;
    climatePair = null;
    climateBtn.disabled = true;
    cancelRequested = false;
    runBtn.disabled = true;
    assessBtn.disabled = true;
    cancelBtn.hidden = false;
    progress.hidden = false;
    progress.value = 0;
    const out = await runHeadless({
      store,
      actions,
      sim,
      terrain,
      getTerrain,
      cases: todo.map((L, li) => ({
        L,
        apply: () => {
          setSweepStatus(`Level ${li + 1} of ${todo.length}: ${L.label}${kind === 'rain' ? ` (${fmtNum(L.mmPerHour)} mm/h for ${fmtNum(Math.min(durationMin, RAIN_DESIGN_DURATION_S / 60))} min)` : ''} — running ${fmtNum(durationMin)} simulated min…`);
          if (kind === 'stage' && st) {
            store.set({ stageOffset: L.ft * FT + st.gaugeDatum - st.normalLevel });
          } else if (kind === 'rain') {
            // Rain only: rivers held at their normal level, inflows and storm cells off, the level's 1-hour intensity
            // over the whole map (stopped after RAIN_DESIGN_DURATION_S in afterChunk).
            store.set({ stageOffset: 0, sources: saved.sources.filter((src) => src.type !== 'inflow'), storms: [], sim: { ...store.get().sim, rainRate: L.mmPerHour } });
          } else {
            const f = scaledForcing(L.scale, saved);
            store.set({ sources: f.sources, storms: f.storms, sim: { ...store.get().sim, rainRate: f.rainRate } });
          }
        },
      })),
      durationS: dur,
      chunkS: chunk,
      cancelled: () => cancelRequested,
      afterReset: () => {
        acc.reset();
        try {
          acc.setBaseline(computeInitialWater(terrain, store.get().scenario));
        } catch {
          acc.setBaseline(null);
        }
      },
      afterChunk: (_i, t) => {
        if (!gpu) feed(acc);
        // The design storm lasts an hour; the rest of the run is run-off. Chunks are whole minutes, so the rain stops
        // on the hour exactly.
        if (kind === 'rain' && t >= RAIN_DESIGN_DURATION_S - 1e-3 && store.get().sim.rainRate > 0) store.set({ sim: { ...store.get().sim, rainRate: 0 } });
      },
      onProgress: (fr) => (progress.value = fr),
      collect: async (_li, { L }) => {
        const r = await readFields(acc);
        if (!r) throw new Error('no flood readback');
        const endDepth = solver.getSnapshot()?.depth.slice() ?? null;
        const info: SweepLevelInfo = {
          id: L.id,
          label: L.label,
          ft: L.ft,
          scale: L.scale,
          ...(kind === 'rain' ? { rainMmH: L.mmPerHour } : {}),
          returnPeriod: L.sourceRp ?? L.userRp,
          rpFrom: L.sourceRp != null ? 'source' : L.userRp != null ? 'user' : null,
          durationS: r.fields.simTime,
        };
        state.levels.push(info);
        const runs = assessAll(r.fields, endDepth, specs);
        for (const s of specs) {
          const run = runs.get(s.id);
          if (run) state.rows.get(s.id)!.push({ level: info, run });
        }
        sweep = { ...state };
        renderSweep();
      },
    });
    const failed = out.error;
    state.cancelled = out.cancelled;
    sweeping = false;
    runBtn.disabled = false;
    assessBtn.disabled = false;
    cancelBtn.hidden = true;
    progress.hidden = true;
    syncClimateBtn();
    if (state.levels.length) sweep = state;
    const secs = out.seconds;
    if (failed) setSweepStatus(`Sweep stopped: ${failed}. Your scenario was restored (the water restarts from its beginning).`, 'warn');
    else if (state.cancelled) setSweepStatus(`Cancelled after ${state.levels.length} of ${todo.length} levels (${fmtNum(secs, 0)} s). Your scenario was restored; the water restarts from its beginning.`, 'warn');
    else setSweepStatus(`Done: ${todo.length} level${todo.length === 1 ? '' : 's'} in ${fmtNum(secs, 0)} s. Your scenario was restored; the water restarts from its beginning.`);
    current = null;
    render();
  }

  // ─── Today vs a future climate (siteClimate.ts) ─────────────────────────────────────────────────────────────
  let comparing = false;
  const rpOf = (id: string): number | null => {
    const l = levels.find((x) => x.id === id);
    return l ? (l.sourceRp ?? l.userRp) : null;
  };

  function syncClimateBtn() {
    const s = store.get();
    const c = sweepComparable(climateForcing(s.climate, s.presetId, s.scenario), ladderKind);
    climateBtn.disabled = sweeping || comparing || !c.ok;
    climateBtn.dataset.tip = c.ok ? `Run the ticked levels under today’s forcing, then under ${climateForcing(s.climate, s.presetId, s.scenario).label}, and compare loss and EAL` : c.why;
  }

  /** The ladder twice: the climate layer off (today), then the user's selection; the user's selection is put back. */
  async function runClimateCompare(): Promise<void> {
    if (sweeping || busy || comparing) return;
    const s0 = store.get();
    const sel = s0.climate ?? { ...CLIMATE_TODAY };
    const f = climateForcing(sel, s0.presetId, s0.scenario);
    const ok = sweepComparable(f, ladderKind);
    if (!ok.ok) return setSweepStatus(ok.why, 'warn');
    const want = levels.filter((l) => l.on && !l.outOfRange).length;
    const complete = (st: SweepState | null) => !!st && !st.cancelled && st.levels.length === want;
    comparing = true;
    try {
      store.set({ climate: { ...sel, horizon: 'today' } });
      await runSweep();
      const today = sweep;
      if (!complete(today)) return;
      store.set({ climate: sel });
      await runSweep();
      const future = sweep;
      if (!complete(future)) return;
      const changes: string[] = [];
      if (f.rainMult !== 1) changes.push(`rain & storm cells × ${fmtNum(f.rainMult, 2)}`);
      if (f.inflowMult !== 1 && !f.chainInflows) changes.push(`rain-fed inflows × ${fmtNum(f.inflowMult, 2)}`);
      if (f.seaRiseM > 0) changes.push(`sea +${fmtNum(f.seaRiseM, 2)} m (NOAA ${f.seaScenario})`);
      climatePair = { label: f.label, changes, today: today!.rows, future: future!.rows };
      sweep = today;
      setSweepStatus(`Done: ${want} level${want === 1 ? '' : 's'} today and under ${f.label}. Your scenario and climate were restored.`);
    } finally {
      store.set({ climate: sel });
      comparing = false;
      syncClimateBtn();
      renderSweep();
    }
  }

  // ─── Derived results ────────────────────────────────────────────────────────────────────────────────────────
  function summaryFor(id: string): SweepSummary | null {
    const rows = sweep?.rows.get(id);
    return rows && rows.length ? summarizeSweep(rows) : null;
  }

  function derived(spec: SiteSpec): { sum: SweepSummary | null; rec: FfeRecommendation | null; options: SiteMitigation[]; verdict: string[] } {
    const sum = summaryFor(spec.id);
    const money = (v: number) => formatMoney(v);
    if (!sum) return { sum: null, rec: null, options: [], verdict: [] };
    const design = pickDesign(sum.rows, designId);
    const rec = design ? recommendFfe(design.row, design.basis, spec.occupancy, freeboardFt != null ? freeboardFt * FT : undefined, design.onePercent) : null;
    const t = getTerrain();
    const country = t ? regionForBounds(t.bounds).costCountry : null;
    const run0 = sum.rows[0]?.run;
    const options = rec && run0 ? mitigationOptions(sum, { occ: spec.occupancy, rec, country, perimeterM: run0.geometry.perimeterM }) : [];
    return { sum, rec, options, verdict: siteVerdict(spec.name || 'The site', sum, money, (run) => extras.timing(spec, run, current?.alertTime ?? 0)) };
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────────────────────────────────────
  function setStatus(text: string, tone: 'info' | 'warn' = 'info') {
    setText(status, text);
    toggleClass(status, 'dl-warn', tone === 'warn');
  }
  function setSweepStatus(text: string, tone: 'info' | 'warn' = 'info') {
    setText(sweepStatus, text);
    toggleClass(sweepStatus, 'dl-warn', tone === 'warn');
  }

  function render() {
    renderList();
    renderForm();
    renderCard();
    renderLadder();
    renderSweep();
    const n = registry.sites.length;
    badge.hidden = n === 0;
    setText(badge, `${n} site${n === 1 ? '' : 's'}`);
    shareBtn.disabled = n === 0;
    evacBtn.disabled = !registry.selected;
    const has = !!current || !!sweep;
    printBtn.disabled = htmlBtn.disabled = !has || n === 0;
    setText(exportNote, downloadsBlocked() ? 'The desktop app blocks downloads by design; use Print.' : has ? 'Generated in this tab; nothing is uploaded.' : 'Assess this run or run a sweep to enable export.');
  }

  function renderList() {
    const sites = registry.sites;
    if (!sites.length) {
      listEl.replaceChildren(h('p', { class: 'dl-impact-fine' }, `No sites yet. Up to ${SITE_LIMITS.maxSites}; they stay in this tab.`));
      return;
    }
    listEl.replaceChildren(
      ...sites.map((s) => {
        const on = s.id === registry.selectedId;
        const run = current?.runs.get(s.id);
        const tag = run?.outside ? 'outside this map' : run?.result?.reached ? `${fmtNum(run.result.depth, 2)} m` : run ? 'dry' : '';
        return h(
          'div',
          { class: `dl-site-item${on ? ' dl-on' : ''}`, 'data-site-id': s.id },
          h('button', { type: 'button', class: 'dl-site-pick', 'aria-pressed': String(on), onclick: () => registry.select(s.id) }, h('span', { class: 'dl-impact-name' }, s.name || s.id), h('span', { class: 'dl-impact-meta' }, `${OCCUPANCY_PROFILES[s.occupancy].label} · ${s.floors} fl${s.ring ? ' · outline' : ' · pin'}${tag ? ` · ${tag}` : ''}`)),
          h('button', { type: 'button', class: 'dl-icon-btn dl-site-remove', 'aria-label': `Remove ${s.name || s.id}`, title: 'Remove', onclick: () => registry.remove(s.id) }, '×'),
        );
      }),
    );
  }

  /** The form is rebuilt only for another site or use (rebuilding on every edit would steal focus mid-form). */
  let formKey = '';
  function renderForm() {
    const s = registry.selected;
    const key = s ? `${s.id}|${s.occupancy}|${!!s.ring}` : '';
    if (key === formKey) return;
    formKey = key;
    if (!s) {
      formEl.replaceChildren();
      return;
    }
    const upd = (patch: Partial<SiteSpec>) => registry.update(s.id, patch);
    const name = h('input', { type: 'text', class: 'dl-num-input dl-site-name', maxlength: SITE_LIMITS.nameChars, value: s.name, 'aria-label': 'Site name', 'data-site-field': 'name' });
    name.addEventListener('change', () => upd({ name: cleanPlaceLabel(name.value, SITE_LIMITS.nameChars) }));
    const use = h(
      'select',
      { class: 'dl-num-input dl-site-use', 'aria-label': 'Planned use', 'data-site-field': 'use' },
      ...SITE_OCCUPANCIES.map((o) => h('option', { value: o, selected: o === s.occupancy }, OCCUPANCY_PROFILES[o].label)),
    );
    use.addEventListener('change', () => {
      if ((SITE_OCCUPANCIES as readonly string[]).includes(use.value)) upd({ occupancy: use.value as SiteOccupancy });
    });
    const floors = numField({ label: 'Floors', unit: '', min: 1, max: SITE_LIMITS.maxFloors, step: 1, name: 'floors', onChange: (v) => upd({ floors: Math.round(v ?? 1) }) });
    floors.set(s.floors);
    const value = numField({ label: 'Planned value', unit: '$', min: 0, max: SITE_LIMITS.maxValue, step: 100000, name: 'value', placeholder: 'estimated', onChange: (v) => upd({ value: v }) });
    value.set(s.value);
    const fp = numField({ label: 'Footprint', unit: 'm²', min: 1, max: SITE_LIMITS.maxFootprintM2, step: 10, name: 'footprint', placeholder: s.ring ? 'outline' : `typ. ${fmtNum(TYPICAL_FOOTPRINT_M2[s.occupancy])}`, onChange: (v) => upd({ footprintM2: v }) });
    fp.set(s.footprintM2);
    const ffh = numField({ label: 'First floor above grade', unit: 'm', min: 0, max: SITE_LIMITS.maxFirstFloorM, step: 0.05, name: 'ffh', placeholder: String(defaultFirstFloorHeight(s.occupancy)), onChange: (v) => upd({ firstFloorHeight: v }) });
    ffh.set(s.firstFloorHeight, 2);
    const crit = numField({ label: 'Critical equipment above grade', unit: 'm', min: 0, max: SITE_LIMITS.maxCriticalM, step: 0.1, name: 'crit', placeholder: 'optional', onChange: (v) => upd({ criticalElev: v }) });
    crit.set(s.criticalElev, 2);
    formEl.replaceChildren(
      h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Name'), name),
      h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Planned use'), use),
      h('div', { class: 'dl-impact-inputs' }, floors.el, value.el, fp.el),
      h('div', { class: 'dl-impact-inputs' }, ffh.el, crit.el),
      h('p', { class: 'dl-impact-fine' }, 'Blank fields use defaults: value = floor area × the unit cost for the use; first floor 0.3 m (slab on grade).'),
    );
  }

  function renderCard() {
    const s = registry.selected;
    const run = s ? current?.runs.get(s.id) : undefined;
    const ens = s ? ensembleLine(s) : null;
    if (!s || !run) {
      cardEl.replaceChildren(current ? h('p', { class: 'dl-impact-fine' }, 'Select a site.') : h('p', { class: 'dl-impact-fine' }, 'Press “Assess this run” to check the sites against the flood on screen.'), ...(ens ? [ens] : []));
      overlay.setRoute(null, true);
      overlay.setWalkRoute(null);
      return;
    }
    const money = (v: number) => formatMoney(v);
    cardEl.replaceChildren(
      ...(ens ? [ens] : []),
      kvList(siteRunRows(run, money, current!.alertTime), 'dl-site-kv'),
      extras.card(s, run, current!.fields, current!.alertTime),
      h('details', { class: 'dl-impact-methods' }, h('summary', null, 'Planned building, as assessed'), kvList(siteSpecRows(s, run, money), 'dl-site-kv')),
    );
    const e = run.egress;
    overlay.setRoute(e?.routeAtPeak ?? e?.routeBefore ?? null, !!e?.openAtPeak);
  }

  /** "Ensemble: floods (≥ 15 cm) in 7 of 12 members · depth p10/p50/p90 …" for a site, from the latest ensemble. */
  function ensembleLine(s: SiteSpec): HTMLElement | null {
    const e = bridge.ensemble;
    const st = store.get();
    if (!e || e.sceneKey !== `${st.presetId}|${st.terrainName}`) return null;
    const t = e.sites.get(s.id);
    if (!t || !t.members) return null;
    const depths = t.depths.filter((d) => Number.isFinite(d));
    const [p10, p50, p90] = depths.length ? band(depths) : [NaN, NaN, NaN];
    const stale = e.siteKeys.get(s.id) !== specKey(s);
    return h(
      'p',
      { class: `dl-site-ens${stale ? ' dl-warn' : ''}`, 'data-site': 'ensemble' },
      h('b', null, 'Ensemble: '),
      `${tallySentence(t)}`,
      depths.length ? ` · max depth p10 ${fmtNum(p10, 2)} / p50 ${fmtNum(p50, 2)} / p90 ${fmtNum(p90, 2)} m` : '',
      stale ? ' · the site was edited after the ensemble ran' : '',
    );
  }

  function renderLadder() {
    const st = stageCtl();
    const ladder = ladderFor(store.get().presetId, store.get().scenario);
    const t = getTerrain();
    const c = t ? mapCentre(t) : null;
    setText(
      sweepIntro,
      ladderKind === 'rain'
        ? `NOAA Atlas 14 rain at the map centre${c ? ` (${c.lat.toFixed(3)}, ${c.lon.toFixed(3)})` : ''}: each ticked level resets the water and rains that return period’s 1-hour intensity uniformly over the whole map for one hour, then lets it run off for the rest of the simulated time. Rain only — rivers stay at their normal level, inflows and storm cells are off. Return periods are NOAA’s, converted to annual chance.`
        : ladderKind === 'stage' && st && store.get().scenario?.coastal
          ? `${st.label}: each ticked level resets the water, raises the sea on the seaward edges of the map to NOAA’s still-water level for that annual chance and runs the chosen simulated time headless. Return periods are NOAA’s (1 / annual exceedance probability). ${gaugeNote(store.get().scenario!.coastal!)}`
        : ladderKind === 'stage' && st
          ? `${st.label}: each ticked level resets the water, raises the river to that gauge reading and runs the chosen simulated time headless${ladder ? '' : ' (this scenario has no researched ladder: the slider’s marks)'}. Return periods marked “source” are published; type one for any other level you know — it is labelled as your input.`
          : 'The ladder scales the scenario’s rain, storm cells and inflows. No return period is known for any multiplier — type one per level, or the sweep gives levels without an EAL.',
    );
    // The ladder picker: only when there is a choice.
    const opts = ladderOptions();
    const names: Record<LadderKind, string> = {
      stage: st ? `${st.label}${ladder ? '' : ' (slider marks)'}` : 'River / tide levels',
      rain: 'Rain: NOAA Atlas 14, 1-hour',
      scale: 'Scenario forcing × multiplier',
    };
    ladderSel.replaceChildren(...opts.kinds.map((k) => h('option', { value: k, selected: k === ladderKind }, names[k])));
    ladderSel.disabled = sweeping || comparing;
    ladderPick.hidden = opts.kinds.length < 2;
    const usLike = !!c && atlas14MayCover(c.lat, c.lon);
    setText(
      rainNote,
      rain.status === 'loading'
        ? 'Looking up NOAA Atlas 14 rain return periods for this map…'
        : rain.status === 'error'
          ? 'NOAA Atlas 14 rain return periods could not be loaded; the other ladders still work.'
          : rain.status === 'none' && usLike
            ? 'No NOAA Atlas 14 estimate covers this map (western Washington and Oregon are still on NOAA Atlas 2), so there is no rain ladder here.'
            : ladderKind === 'rain'
              ? `Uniform 1-hour storm; simulated time per level ${durationMin < RAIN_DESIGN_DURATION_S / 60 ? '(shorter than the storm: the rain is cut off) ' : ''}includes the run-off afterwards.`
              : '',
    );
    rainNote.hidden = !rainNote.textContent;
    if (!levels.length) {
      ladderEl.replaceChildren();
      return;
    }
    ladderEl.replaceChildren(
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Level'), h('th', null, 'Return period'))),
        h(
          'tbody',
          null,
          ...levels.map((l) => {
            const box = h('input', { type: 'checkbox', checked: l.on, disabled: l.outOfRange || sweeping, 'aria-label': `Run ${l.label}`, 'data-level': l.id });
            box.addEventListener('change', () => (l.on = box.checked));
            let rp: HTMLElement;
            if (l.sourceRp != null) {
              rp = h('span', { class: 'dl-impact-meta', title: LADDER_SOURCES[l.source]?.text ?? '' }, `${formatReturnPeriod(l.sourceRp)} yr · source`);
            } else {
              const inp = h('input', { type: 'number', class: 'dl-num-input dl-site-rp', min: 1, max: 100000, step: 1, placeholder: 'yr?', value: l.userRp ?? '', 'aria-label': `Return period of ${l.label}, years (your input)` });
              inp.addEventListener('change', () => {
                const v = Number(inp.value);
                l.userRp = inp.value.trim() !== '' && Number.isFinite(v) && v >= 1 ? Math.min(100000, v) : null;
                if (sweep) {
                  for (const lv of sweep.levels) if (lv.id === l.id && lv.rpFrom !== 'source') {
                    lv.returnPeriod = l.userRp;
                    lv.rpFrom = l.userRp != null ? 'user' : null;
                  }
                  renderSweep();
                }
              });
              rp = inp;
            }
            return h(
              'tr',
              { class: l.outOfRange ? 'dl-site-off' : '' },
              h('td', null, box),
              h('td', null, h('span', { class: 'dl-impact-name' }, l.label), h('span', { class: 'dl-impact-meta' }, `${Number.isFinite(l.ft) ? `${fmtNum(l.ft, 2)} ft` : Number.isFinite(l.mmPerHour) ? `${fmtNum(l.mmPerHour)} mm/h` : `× ${l.scale}`}${l.note ? ` · ${l.note}` : ''}${l.outOfRange ? ' · beyond this scenario’s stage range' : ''}`)),
              h('td', null, rp),
            );
          }),
        ),
      ),
    );
  }

  function renderSweep() {
    const s = registry.selected;
    if (!sweep || !s) {
      sweepOut.replaceChildren();
      return;
    }
    const d = derived(s);
    if (!d.sum) {
      sweepOut.replaceChildren(h('p', { class: 'dl-impact-fine' }, 'This site was added after the sweep — run it again to include it.'));
      return;
    }
    const money = (v: number) => formatMoney(v);
    const stale = sweep.specs.get(s.id) !== specKey(s);
    const parts: Array<HTMLElement | null> = [];
    if (stale) parts.push(h('p', { class: 'dl-impact-fine dl-warn' }, 'The site was edited after the sweep: these numbers are for the building as it was then. Run the sweep again.'));
    parts.push(h('div', { class: 'dl-site-verdict', 'data-site': 'verdict' }, ...d.verdict.map((v) => h('p', null, v))));
    if (sweep.ladder === 'stage' && sweep.sourceKeys.includes(SURGE_SOURCE_KEY)) {
      const coastal = store.get().scenario?.coastal ?? null;
      parts.push(h('details', { class: 'dl-impact-methods', 'data-site': 'surge-caveats' }, h('summary', null, 'What the surge ladder leaves out'), h('ul', { class: 'dl-impact-issues' }, ...(coastal ? [h('li', { 'data-site': 'surge-gauge' }, gaugeNote(coastal))] : []), ...SURGE_LADDER_CAVEATS.map((c) => h('li', null, c)))));
    }
    if (sweep.ladder === 'rain') {
      parts.push(h('details', { class: 'dl-impact-methods', 'data-site': 'rain-caveats' }, h('summary', null, 'What the rain ladder leaves out'), h('ul', { class: 'dl-impact-issues' }, ...RAIN_LADDER_CAVEATS.map((c) => h('li', null, c)))));
    }
    const cc = climatePair ? compareClimate(climatePair, s.id, rpOf) : null;
    if (cc) parts.push(climateCompareBlock(cc, money));
    parts.push(h('div', { class: 'dl-impact-table dl-site-table' }, simpleTable(SWEEP_HEAD_COMPACT, sweepRowsCompact(d.sum, money), '')));
    const chart = exceedanceChart(d.sum, money);
    if (chart) parts.push(h('figure', { class: 'dl-site-figure' }, chart, h('figcaption', { class: 'dl-impact-fine' }, 'Loss at the site against return period (log). Hover a point for its numbers; the table above has them all.')));
    // Recommendations
    const designSel = h('select', { class: 'dl-num-input', 'aria-label': 'Design event' }, h('option', { value: '' }, 'Auto: 1 % level if run, else the highest'), ...d.sum.rows.map((r) => h('option', { value: r.level.id, selected: r.level.id === designId }, r.level.label)));
    designSel.addEventListener('change', () => {
      designId = designSel.value || null;
      renderSweep();
    });
    const fbAuto = freeboardFor(s.occupancy);
    const fbSel = h('select', { class: 'dl-num-input', 'aria-label': 'Freeboard' }, h('option', { value: '' }, `Auto: ${fbAuto.ft} ft (ASCE 24-14)`), ...[1, 2, 3].map((f) => h('option', { value: String(f), selected: freeboardFt === f }, `${f} ft`)));
    fbSel.addEventListener('change', () => {
      freeboardFt = fbSel.value ? Number(fbSel.value) : null;
      renderSweep();
    });
    parts.push(
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Recommendations — indicative, not engineering advice')),
      h('div', { class: 'dl-impact-inputs' }, h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Design event'), designSel), h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Freeboard'), fbSel)),
    );
    if (d.rec) {
      parts.push(kvList(ffeRows(d.rec), 'dl-site-kv'));
    }
    if (d.rec && !Number.isFinite(d.rec.designWse)) {
      parts.push(h('p', { class: 'dl-impact-fine' }, `The design event does not reach the site, so this model asks for no higher floor and no protection. To size them for a rarer event, choose it as the design event above.`));
    } else if (d.rec) {
      parts.push(h('div', { class: 'dl-impact-table dl-site-options' }, simpleTable(MITIGATION_HEAD, mitigationTableRows(d.options, money), '')));
      const cav = [...new Set(d.options.flatMap((o) => o.caveats))];
      parts.push(h('ul', { class: 'dl-impact-issues' }, ...cav.map((c) => h('li', null, c))));
      if (!d.sum.eal) parts.push(h('p', { class: 'dl-impact-fine dl-warn' }, 'No EAL, so no BCR: give the levels return periods.'));
    }
    sweepOut.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  }

  // ─── Map, link, export ──────────────────────────────────────────────────────────────────────────────────────
  function followOnMap() {
    const s = registry.selected;
    const t = getTerrain();
    if (!s || !t) return;
    const [gx, gy] = makeGeoToGrid(t)(s.lon, s.lat);
    if (!(gx >= 0 && gy >= 0 && gx < t.nx && gy < t.ny)) return setStatus('That site is outside this map.', 'warn');
    store.set({ evacStart: { gx, gy } });
  }

  function shareLink() {
    try {
      const url = new URL(window.location.href);
      const v = encodeSites(registry.sites);
      if (v) url.searchParams.set(SITES_PARAM, v);
      else url.searchParams.delete(SITES_PARAM);
      window.history.replaceState(null, '', url);
      void navigator.clipboard?.writeText(url.href).then(
        () => setStatus('Link with the sites copied and put in the address bar. Anyone you send it to sees the sites and their planned values.'),
        () => setStatus('Sites put in the address bar (?sites=). Anyone you send the link to sees them and their planned values.'),
      );
    } catch {
      setStatus('Couldn’t write the address bar here.', 'warn');
    }
  }

  function reportInput(): SiteReportInput | null {
    const t = getTerrain();
    if (!t || (!current && !sweep)) return null;
    const region = regionForBounds(t.bounds);
    return {
      generatedAt: new Date(),
      attribution: store.get().attribution,
      terrainName: store.get().terrainName,
      regionName: region.name,
      currency: region.currency,
      alertTime: current?.alertTime ?? 0,
      current: current ? { simTime: current.fields.simTime, source: current.source } : null,
      sweep: sweep ? { durationS: sweep.durationS, source: sweep.source, ladder: sweep.ladder, gaugeLabel: sweep.gaugeLabel, sourceKeys: sweep.sourceKeys, levels: sweep.levels.length, cancelled: sweep.cancelled } : null,
      methods: [...PEOPLE_METHOD_NOTES, ...INFRA_METHOD_NOTES],
      sites: registry.sites.map((spec) => {
        const d = derived(spec);
        const run = current?.runs.get(spec.id) ?? null;
        return { spec, current: run, extra: extras.report(spec, run, current?.fields ?? null, current?.alertTime ?? 0), timing: (r: SiteRun) => extras.timing(spec, r, current?.alertTime ?? 0), sweep: d.sum, rec: d.rec, options: d.options, verdict: d.verdict, climate: climatePair ? compareClimate(climatePair, spec.id, rpOf) : null };
      }),
    };
  }

  function doPrint() {
    const i = reportInput();
    if (i) printReport(buildSiteReport(i));
  }

  function exportHtml() {
    const i = reportInput();
    if (!i) return;
    const name = safeFilename(`deluge-site-assessment-${store.get().presetId ?? 'area'}`);
    downloadText(reportHtmlDocument(buildSiteReport(i), `Deluge site assessment — ${store.get().terrainName}`, SITE_REPORT_CSS), `${name}.html`, 'text/html');
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────────────────────────────────────────
  ctx.own(bridge.ensembleChanged.on(() => renderCard()));
  ctx.own(
    registry.on(() => {
      reassessCurrent();
      render();
    }),
  );
  ctx.bind(
    (s) => `${s.presetId}|${s.terrainName}`,
    () => ensureScene(getTerrain()),
  );
  ctx.bind((s) => `${s.presetId}|${s.climate?.horizon}|${s.climate?.pathway}|${s.climate?.scaling}|${!!s.scenario?.stage}|${s.scenario?.coastal?.stationId ?? ''}`, () => syncClimateBtn());
  // A live area turned into a coastal-surge scenario (src/surge) brings its own ladder: rebuild on the new scenario.
  ctx.bind(
    (s) => s.scenario?.coastal?.stationId ?? '',
    () => {
      if (sweeping) return;
      ladderChoice = 'auto';
      buildLadder();
      render();
    },
  );
  ctx.bind(
    (s) => s.stats,
    () => {
      if (tracking && active && !sweeping && !hasGpuFields(getSolver())) feed(liveAcc);
    },
  );

  // Sites from a shared link (read once; a bad value is dropped with a fixed sentence, never echoed).
  try {
    const raw = new URLSearchParams(window.location.search).get(SITES_PARAM);
    if (raw) {
      const { sites, warnings } = decodeSites(raw);
      if (sites.length) registry.replace(sites);
      for (const w of warnings) bridge.notify({ kind: 'info', key: 'sites-link', title: 'Site link', message: w });
    }
  } catch {
    /* no location (tests) */
  }

  // ─── Narrated stories (storyHooks.ts) ───────────────────────────────────────────────────────────────────────
  let storySweep: Promise<void> | null = null;
  interface SiteSnapshot {
    terrain: TerrainData | null;
    sites: ReturnType<typeof registry.saveState>;
    sweep: SweepState | null;
    levels: LevelCfg[];
    ladderChoice: LadderKind | 'auto';
    durationMin: number;
    durationTouched: boolean;
    designId: string | null;
    freeboardFt: number | null;
  }
  storyHooksFor(store).site = {
    snapshot(): SiteSnapshot {
      return { terrain: terrainRef, sites: registry.saveState(), sweep, levels: levels.map((l) => ({ ...l })), ladderChoice, durationMin, durationTouched, designId, freeboardFt };
    },
    restore(snap: unknown) {
      const s = snap as SiteSnapshot;
      if (sweeping) return;
      registry.restoreState(s.sites);
      // The sweep and ladder belong to the scene they were made on; on another scene the section starts fresh anyway.
      if (s.terrain === getTerrain() && s.terrain === terrainRef) {
        sweep = s.sweep;
        levels = s.levels;
        ladderChoice = s.ladderChoice;
        durationMin = s.durationMin;
        durationTouched = s.durationTouched;
        durIn.set(durationMin);
        designId = s.designId;
        freeboardFt = s.freeboardFt;
      }
      render();
    },
    useDemoParcels() {
      const t = getTerrain();
      if (!t || sweeping) return false;
      ensureScene(t);
      const { sites } = decodeSites(DEMO_SITES_PARAM);
      if (!sites.length) return false;
      registry.replace(sites);
      render();
      return true;
    },
    async sweep() {
      if (sweeping || busy) return false;
      ensureScene(getTerrain());
      ladderChoice = 'auto';
      durationTouched = false;
      designId = null;
      freeboardFt = null;
      buildLadder();
      render();
      const p = runSweep();
      storySweep = p;
      try {
        await p;
      } finally {
        if (storySweep === p) storySweep = null;
      }
      const done = !!sweep && !sweep.cancelled && sweep.levels.length > 0;
      // The story reads the verdict next: bring it into view in the panel.
      if (done) requestAnimationFrame(() => sweepOut.querySelector('[data-site="verdict"]')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
      return done;
    },
    busy: () => sweeping,
    async cancel() {
      if (!sweeping) return;
      cancelRequested = true;
      await storySweep?.catch(() => {});
    },
    fact(index, f) {
      const spec = registry.sites[index];
      if (!spec || !sweep) return null;
      return siteFact(spec.name, summaryFor(spec.id), spec.occupancy, f, (v) => formatMoney(v));
    },
  };

  render();
  return {
    body,
    badge,
    overlay: overlay.el,
    activate() {
      active = true;
      ensureScene(getTerrain());
      ensureRain();
      render();
      startTracking();
    },
    async useRainLadder() {
      ensureScene(getTerrain());
      ensureRain();
      const ok = await rain.ready;
      if (!ok || sweeping) return false;
      ladderChoice = 'rain';
      for (const l of levels) l.on = true;
      buildLadder();
      render();
      return ladderKind === 'rain';
    },
    useSurgeLadder() {
      ensureScene(getTerrain());
      if (sweeping || !store.get().scenario?.coastal) return false;
      ladderChoice = 'stage';
      buildLadder();
      for (const l of levels) l.on = !l.outOfRange;
      render();
      return ladderKind === 'stage';
    },
    runSweep: () => runSweep(),
    getSettings(): SiteCheckSettings {
      const userRp: Record<string, number> = {};
      for (const l of levels) if (l.userRp != null) userRp[l.id] = l.userRp;
      const fb = freeboardFt === 1 || freeboardFt === 2 || freeboardFt === 3 ? freeboardFt : null;
      return { ladder: ladderChoice, minutes: durationMin, levels: levels.filter((l) => l.on).map((l) => l.id), userRp, designEvent: designId, freeboardFt: fb };
    },
    async applySettings(set: SiteCheckSettings) {
      if (sweeping) return;
      ensureScene(getTerrain());
      if (set.ladder === 'rain') {
        ensureRain();
        await rain.ready;
      }
      ladderChoice = set.ladder;
      durationTouched = true;
      durationMin = set.minutes;
      durIn.set(durationMin);
      buildLadder();
      for (const l of levels) {
        if (set.levels) l.on = set.levels.includes(l.id) && !l.outOfRange;
        if (l.sourceRp == null && Object.prototype.hasOwnProperty.call(set.userRp, l.id)) l.userRp = set.userRp[l.id];
      }
      designId = set.designEvent;
      freeboardFt = set.freeboardFt;
      render();
    },
  };
}
