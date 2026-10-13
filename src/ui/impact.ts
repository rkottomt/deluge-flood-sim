/**
 * The Impact panel section ("Deluge for Business"): what the flood on screen does to the buildings under it — and to
 * the user's own assets — in counts, dollars, hazard classes and warning time, with a before/after comparison when
 * a wall is built, and CSV / printable-report export. All the arithmetic is in src/loss (pure, unit-tested); this file
 * reads the flood, calls it, and lays the answer out.
 *
 * READING THE FLOOD. FloodSolver.readHazardFields() (a full-grid GPU readback of the per-cell maxima and arrival
 * times) is feature-detected. A solver without it gets the depth-only fallback (src/loss/fallback.ts): the panel then
 * accumulates the 2–4 Hz depth snapshots itself from the moment the section is first opened, says so, and calls
 * nothing "collapsed" because it has no speeds.
 *
 * COST. Nothing runs until the user asks: Recompute is a button, and the throttled auto-update (every AUTO_MS of wall
 * time while the flood runs) is a switch that starts off. The fallback's per-snapshot accumulation only runs once the
 * section has been opened.
 *
 * PRIVACY. A portfolio CSV is read with File.text() and parsed in this tab; nothing is uploaded or stored. Every
 * string from it is cleaned (src/loss/portfolio.ts) and written as text — this module has no markup sinks.
 */
import type { AppState, FloodSolver, TerrainData } from '../contracts';
import { computeInitialWater } from '../data/initialWater';
import { cleanPlaceLabel } from '../data/placeName';
import {
  analyze,
  CSV_LIMITS,
  DEBRIS_FLOW_PRESETS,
  MITIGATION_LABELS,
  OCCUPANCY_PROFILES,
  parsePortfolio,
  resultsCsv,
  SnapshotHazardAccumulator,
  topByLoss,
  wallGeometry,
  type Analysis,
  type BuildingImpact,
  type MitigationType,
  type PortfolioAsset,
  type PortfolioParse,
  type ResultRowInput,
} from '../loss';
import { createAssetMarkers, type AssetPin } from './assetMarkers';
import { bridgeFor } from './bridge';
import { button, segmented, toggleSwitch } from './controls';
import { h, setText, toggleClass, type UIContext } from './dom';
import { downloadsBlocked, downloadText, safeFilename } from './download';
import { fmtNum, formatAcres, formatClock, formatMoney, leadVsWarningText } from './format';
import { bcrView, compareRuns, type Comparison, type RunSignature, type RunSnapshot } from './impactCompare';
import { METHOD_NOTES } from './impactMethods';
import { buildingLabel, buildReport, printReport, reportHtmlDocument } from './impactReport';
import { buildWarningSection } from './warningReport';

/** Auto-update period while the flood runs, ms of wall time. */
export const AUTO_MS = 5000;
/** Rows in the panel's top-loss table. */
const TOP_N = 10;

interface Run {
  analysis: Analysis;
  sig: RunSignature;
  source: 'gpu' | 'snapshots';
  trackingFrom: number;
  debrisFlow: boolean;
  alertTime: number;
  wall: { lengthM: number; meanHeightM: number; cells: number };
}

export interface ImpactSection {
  /** Section body children. */
  body: HTMLElement[];
  badge: HTMLElement;
  /** Map pins layer (mounted by the panel's owner, over the canvas). */
  overlay: HTMLElement;
  /** The section was opened: start the fallback tracking if it is needed. */
  activate(): void;
  /**
   * Load a portfolio from CSV text the app itself supplies (the bundled demo, src/ui/useCases.ts), exactly as if the
   * user had picked the file; `auto` also turns on the periodic recompute so the table fills as the flood runs.
   */
  loadPortfolioText(name: string, text: string, opts?: { auto?: boolean }): void;
  /** The portfolio CSV as loaded (its text), for a project that opts in to carrying it (src/ui/projectState.ts). */
  getPortfolio(): { name: string; text: string } | null;
}

/**
 * What the UI bridge carries for the ensemble's per-asset tallies: the parsed assets, or null without any. Every way a
 * portfolio arrives (a file, the bundled demo through loadPortfolioText) goes through this, so the ensemble never
 * tallies a stale portfolio — or none — while the Impact section shows another.
 */
function portfolioAssetsForBridge(p: PortfolioParse | null): PortfolioAsset[] | null {
  return p?.assets.length ? p.assets : null;
}

function forcingSignature(s: AppState): string {
  const src = s.sources.map((w) => (w.type === 'inflow' ? `i:${w.id}:${w.discharge}` : `s:${w.id}:${w.level}`)).sort();
  const st = s.storms.map((c) => `r:${c.id}:${c.intensity}:${c.radius}`).sort();
  return [...src, ...st].join('|');
}

function numInput(opts: { label: string; unit: string; min: number; max: number; step: number; placeholder?: string; onChange(v: number | null): void }) {
  const input = h('input', {
    type: 'number',
    class: 'dl-num-input',
    min: opts.min,
    max: opts.max,
    step: opts.step,
    inputmode: 'decimal',
    placeholder: opts.placeholder ?? null,
    'aria-label': opts.label,
  });
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
    get: read,
    set(v: number | null, digits = 0) {
      input.value = v === null || !Number.isFinite(v) ? '' : String(Math.round(v * 10 ** digits) / 10 ** digits);
    },
  };
}

export function createImpactSection(ctx: UIContext): ImpactSection {
  const { store, bind } = ctx;
  const bridge = bridgeFor(store);

  // ─── State ──────────────────────────────────────────────────────────────────────────────────────────────────
  let terrainRef: TerrainData | null = null;
  let run: Run | null = null;
  let baseline: RunSnapshot | null = null;
  let portfolio: PortfolioParse | null = null;
  let portfolioName = '';
  /** The CSV text behind `portfolio` (kept only in memory, for an opt-in project save). */
  let portfolioText: string | null = null;
  const fallback = new SnapshotHazardAccumulator();
  let tracking = false;
  let busy = false;
  let auto = false;
  let lastAutoAt = -Infinity;
  let lastAutoSim = NaN;
  let debrisFlow = false;
  let alertTime = 0;
  let mitigation: MitigationType = 'floodwall';
  let wallLength: number | null = null;
  let wallHeight: number | null = null;
  let returnPeriod: number | null = null;
  let pinsOn = true;

  const getSolver = (): FloodSolver | null => bridge.scene?.getSolver() ?? null;
  const getTerrain = (): TerrainData | null => bridge.scene?.getTerrain() ?? null;
  const hasGpuFields = (s: FloodSolver | null) => !!s && typeof s.readHazardFields === 'function';

  // ─── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────
  const badge = h('span', { class: 'dl-sec-badge', hidden: true });
  const intro = h(
    'p',
    { class: 'dl-impact-note' },
    'What the flood so far does to the buildings on the map: depth, speed and arrival at every footprint, damage from published curves, and a dollar range. A screening estimate — see "How this is computed".',
  );
  const sourceLine = h('p', { class: 'dl-impact-source' });
  const status = h('p', { class: 'dl-impact-status', 'aria-live': 'polite' });
  const recomputeBtn = button('Recompute', () => void recompute(), { icon: 'reset', variant: 'primary', tip: 'Read the flood so far and update every number below', side: 'top', className: 'dl-btn-sm' });
  const autoSwitch = toggleSwitch(`Update every ${AUTO_MS / 1000} s`, (on) => {
    auto = on;
    autoSwitch.set(on);
    if (on) void recompute();
  }, { tip: 'Recompute automatically while the flood runs (reads the whole grid back from the GPU each time)' });

  const card = (label: string) => {
    const value = h('div', { class: 'dl-impact-value' }, '—');
    const sub = h('div', { class: 'dl-impact-sub' });
    return { el: h('div', { class: 'dl-impact-card' }, h('div', { class: 'dl-impact-label' }, label), value, sub), value, sub };
  };
  const cReached = card('Reached ≥ 15 cm');
  const cDamaged = card('Damaged');
  const cDestroyed = card('Destroyed');
  const cLoss = card('Estimated loss');
  const cArrival = card('First arrival');
  const cAccess = card('Road cut at peak');
  cLoss.el.classList.add('dl-impact-wide');
  const cards = h('div', { class: 'dl-impact-cards' }, cLoss.el, cReached.el, cDamaged.el, cDestroyed.el, cArrival.el, cAccess.el);
  const hazardRow = h('div', { class: 'dl-impact-hazard', role: 'img' });
  const peopleNote = h('p', { class: 'dl-impact-fine' }, 'People at risk are not estimated — there is no population data behind this panel.');
  const flags = h('p', { class: 'dl-impact-fine' });
  const topTable = h('div', { class: 'dl-impact-table' });

  // Mitigation
  const baselineLine = h('p', { class: 'dl-impact-fine' });
  const baselineBtn = button('Set as baseline', () => setBaseline(), { icon: 'flag', tip: 'Remember this run as "before" — then build a wall, replay the flood and recompute', side: 'top', className: 'dl-btn-sm' });
  const clearBaselineBtn = button('Clear', () => {
    baseline = null;
    renderCompare();
  }, { className: 'dl-btn-sm', tip: 'Forget the baseline', side: 'top' });
  const typeSeg = segmented<MitigationType>(
    (Object.keys(MITIGATION_LABELS) as MitigationType[]).map((t) => ({ value: t, label: MITIGATION_LABELS[t].replace(/ .*/, ''), tip: MITIGATION_LABELS[t] })),
    (v) => {
      mitigation = v;
      typeSeg.set(v);
      renderCompare();
    },
    { label: 'Mitigation type', className: 'dl-seg-full', tipSide: 'top' },
  );
  typeSeg.set(mitigation);
  const lenIn = numInput({ label: 'Length', unit: 'm', min: 0, max: 1e6, step: 10, onChange: (v) => ((wallLength = v), renderCompare()) });
  const hIn = numInput({ label: 'Height', unit: 'm', min: 0, max: 20, step: 0.1, onChange: (v) => ((wallHeight = v), renderCompare()) });
  const tIn = numInput({ label: 'Event return period', unit: 'yr', min: 1, max: 100000, step: 1, placeholder: 'e.g. 100', onChange: (v) => ((returnPeriod = v), renderCompare()) });
  const compareOut = h('div', { class: 'dl-impact-compare', 'aria-live': 'polite' });
  const protectLine = h('p', { class: 'dl-impact-fine' });

  // Portfolio
  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', class: 'dl-file-input', tabindex: -1, 'aria-hidden': 'true' });
  const loadBtn = button('Load sites / portfolio CSV…', () => fileInput.click(), { icon: 'database', className: 'dl-btn-sm', tip: 'asset_id, lat, lon (or wkt) and optional values — read in this tab, never uploaded', side: 'top' });
  const clearPortfolioBtn = button('Remove', () => {
    portfolio = null;
    portfolioText = null;
    bridge.portfolio = null;
    portfolioName = '';
    fileInput.value = '';
    renderPortfolioInfo();
    if (run) void recompute();
  }, { className: 'dl-btn-sm' });
  const portfolioInfo = h('div', { class: 'dl-impact-portfolio' });
  const portfolioTable = h('div', { class: 'dl-impact-table' });
  const pinsSwitch = toggleSwitch('Show assets on the map', (on) => {
    pinsOn = on;
    pinsSwitch.set(on);
    markers.setVisible(on);
  });
  pinsSwitch.set(pinsOn);

  // Export
  const csvBtn = button('CSV', () => exportCsv(), { icon: 'arrowRight', className: 'dl-btn-sm', tip: 'Per-asset results as a CSV file', side: 'top' });
  const printBtn = button('Print report', () => doPrint(), { icon: 'book', className: 'dl-btn-sm', tip: 'A print-friendly report with methods and sources (Save as PDF in the dialog)', side: 'top' });
  const htmlBtn = button('Report .html', () => exportHtml(), { className: 'dl-btn-sm', tip: 'The same report as a standalone HTML file', side: 'top' });
  const exportNote = h('p', { class: 'dl-impact-fine' });

  // Options
  const debrisSwitch = toggleSwitch('Debris-laden flow', (on) => {
    debrisFlow = on;
    debrisSwitch.set(on);
    if (run) void recompute();
  }, { tip: 'Glacial-lake outbursts and debris flows: depth × speed counts 1.5× and 3 m²/s collapses non-concrete buildings (a heuristic)' });
  const alertIn = numInput({ label: 'Warning issued at T+', unit: 'min', min: 0, max: 100000, step: 1, onChange: (v) => {
    alertTime = (v ?? 0) * 60;
    if (run) void recompute();
  } });
  alertIn.set(0);

  const methods = h(
    'details',
    { class: 'dl-impact-methods' },
    h('summary', null, 'How this is computed'),
    ...METHOD_NOTES.map((n) => h('div', { class: 'dl-impact-method' }, h('b', null, n.title), h('p', null, n.text))),
  );

  const results = h(
    'div',
    { class: 'dl-impact-results', hidden: true },
    cards,
    hazardRow,
    flags,
    peopleNote,
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, `Largest losses`)),
    topTable,
  );

  const mitigationBlock = h(
    'div',
    { class: 'dl-impact-block' },
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Mitigation: before & after')),
    h('p', { class: 'dl-impact-fine' }, 'Run the flood without the wall, Set as baseline; build the wall, reset and replay the same flood, Recompute.'),
    h('div', { class: 'dl-row' }, baselineBtn, clearBaselineBtn),
    baselineLine,
    typeSeg.el,
    h('div', { class: 'dl-impact-inputs' }, lenIn.el, hIn.el, tIn.el),
    compareOut,
    protectLine,
  );

  const portfolioBlock = h(
    'div',
    { class: 'dl-impact-block' },
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Your sites & assets')),
    h('div', { class: 'dl-row' }, loadBtn, clearPortfolioBtn, fileInput),
    portfolioInfo,
    portfolioTable,
    pinsSwitch.el,
  );

  const exportBlock = h(
    'div',
    { class: 'dl-impact-block' },
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Export')),
    h('div', { class: 'dl-row dl-row-wrap' }, csvBtn, printBtn, htmlBtn),
    exportNote,
  );

  const optionsBlock = h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-switches' }, debrisSwitch.el), alertIn.el);

  const body = [
    intro,
    h('div', { class: 'dl-row dl-impact-controls' }, recomputeBtn),
    h('div', { class: 'dl-switches' }, autoSwitch.el),
    sourceLine,
    status,
    results,
    mitigationBlock,
    portfolioBlock,
    exportBlock,
    optionsBlock,
    methods,
  ];

  // Map pins
  const markers = createAssetMarkers({
    getCamera: () => bridge.scene?.getCamera?.() ?? null,
    getTerrain,
    getExaggeration: () => store.get().render.verticalExaggeration,
    getCanvas: () => (typeof document !== 'undefined' ? (document.getElementById('deluge-canvas') as HTMLCanvasElement | null) : null),
  });
  ctx.own(() => markers.destroy());

  const flyTo = (gx: number, gy: number) => {
    const cam = bridge.scene?.getCamera?.();
    const t = getTerrain();
    if (!cam || !t) return;
    const i = Math.min(t.nx - 1, Math.max(0, Math.floor(gx)));
    const j = Math.min(t.ny - 1, Math.max(0, Math.floor(gy)));
    cam.flyTo({ target: { gx, gy, elevation: t.elevation[j * t.nx + i] }, distance: Math.max(250, t.cellSize * 60), yaw: cam.pose.yaw, pitch: 0.8 });
  };

  // ─── Behaviour ──────────────────────────────────────────────────────────────────────────────────────────────
  function setStatus(text: string, tone: 'info' | 'warn' = 'info') {
    setText(status, text);
    toggleClass(status, 'dl-warn', tone === 'warn');
  }

  function renderSource() {
    const solver = getSolver();
    if (!getTerrain()) return setText(sourceLine, '');
    if (hasGpuFields(solver)) {
      setText(sourceLine, 'Reads the solver’s per-cell maxima: depth, speed, depth × speed, arrival time and time under water since the last reset.');
    } else {
      const from = tracking && fallback.samples > 0 ? ` from ${formatClock(fallback.startedAt)}` : '';
      setText(
        sourceLine,
        `This solver build does not record speeds or arrival times, so the panel tracks depth snapshots itself${from} (open this section before playing the flood, or reset the water, to capture all of it). No speeds: hazard classes are depth-only and nothing is called collapsed.`,
      );
    }
  }

  function startTracking() {
    if (tracking) return;
    const solver = getSolver();
    const terrain = getTerrain();
    if (!solver || !terrain || hasGpuFields(solver)) return;
    tracking = true;
    try {
      fallback.setBaseline(computeInitialWater(terrain, store.get().scenario));
    } catch {
      fallback.setBaseline(null);
    }
    feedSnapshot();
    renderSource();
  }

  function feedSnapshot() {
    const solver = getSolver();
    const snap = solver?.getSnapshot();
    if (snap) fallback.feed(snap.depth, snap.nx, snap.ny, snap.simTime);
  }

  function ensureScene(t: TerrainData | null) {
    if (t === terrainRef) return;
    terrainRef = t;
    run = null;
    baseline = null;
    tracking = false;
    fallback.reset();
    fallback.setBaseline(null);
    lastAutoSim = NaN;
    wallLength = wallHeight = null;
    lenIn.set(null);
    hIn.set(null);
    const preset = store.get().presetId;
    debrisFlow = !!preset && DEBRIS_FLOW_PRESETS.has(preset);
    debrisSwitch.set(debrisFlow);
    markers.set([]);
    render();
  }

  function signature(simTime: number, wallCells: number): RunSignature {
    const s = store.get();
    return {
      terrainName: s.terrainName,
      presetId: s.presetId,
      simTime,
      stageOffset: s.stageOffsetApplied,
      rainRate: s.sim.rainRate,
      forcing: forcingSignature(s),
      wallCells,
    };
  }

  async function recompute(): Promise<void> {
    if (busy) return;
    const terrain = getTerrain();
    const solver = getSolver();
    if (!terrain || !solver) {
      setStatus('Load a scene first.');
      return;
    }
    ensureScene(terrain);
    busy = true;
    recomputeBtn.disabled = true;
    setStatus('Reading the flood…');
    try {
      let fields;
      let source: Run['source'];
      if (hasGpuFields(solver)) {
        fields = await solver.readHazardFields!();
        source = 'gpu';
      } else {
        startTracking();
        feedSnapshot();
        fields = fallback.fields();
        source = 'snapshots';
        if (!fields) {
          setStatus('Waiting for the first depth snapshot — try again in a moment.', 'warn');
          return;
        }
      }
      if (getTerrain() !== terrain) return; // the scene changed while the GPU was busy
      const t0 = performance.now();
      const analysis = analyze({ fields, terrain, velocityKnown: source === 'gpu', debrisFlow, alertTime, portfolio: portfolio?.assets ?? null });
      const wall = wallGeometry(solver.getBarrierCPU(), terrain.nx, terrain.ny, terrain.cellSize);
      run = { analysis, sig: signature(fields.simTime, wall.cells), source, trackingFrom: source === 'gpu' ? 0 : fallback.startedAt, debrisFlow, alertTime, wall };
      if (wallLength === null && wall.cells) {
        wallLength = Math.round(wall.lengthM / 10) * 10;
        lenIn.set(wallLength);
      }
      if (wallHeight === null && wall.cells) {
        wallHeight = Math.round(wall.meanHeightM * 10) / 10;
        hIn.set(wallHeight, 1);
      }
      const ms = performance.now() - t0;
      const n = analysis.report?.summary.assessed ?? 0;
      setStatus(
        `Flood at ${formatClock(fields.simTime)} · ${fmtNum(n)} footprints${analysis.portfolio ? ` + ${analysis.portfolio.summary.assets} assets` : ''} in ${fmtNum(ms, 0)} ms.` +
          (terrain.buildings ? '' : ' This area has no building footprints; only portfolio assets are assessed.'),
      );
      render();
    } catch (err) {
      setStatus(`Couldn’t compute the impact: ${err instanceof Error ? err.message : String(err)}`, 'warn');
    } finally {
      busy = false;
      recomputeBtn.disabled = false;
    }
  }

  function setBaseline() {
    if (!run?.analysis.report) {
      setStatus('Recompute first: the baseline is the last computed run.', 'warn');
      return;
    }
    baseline = snapshotOf(run);
    renderCompare();
  }

  function snapshotOf(r: Run): RunSnapshot {
    const buildings = new Map<number, { loss: number; depth: number }>();
    for (const b of r.analysis.report?.impacts ?? []) buildings.set(b.k, { loss: b.loss, depth: b.depth });
    return { sig: r.sig, summary: r.analysis.report!.summary, buildings };
  }

  function currentComparison(): Comparison | null {
    if (!baseline || !run?.analysis.report) return null;
    if (run.sig === baseline.sig) return null;
    return compareRuns(baseline, snapshotOf(run));
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────────────────────────────────────
  function render() {
    renderSource();
    const a = run?.analysis ?? null;
    const s = a?.report?.summary ?? null;
    results.hidden = !s;
    const cur = a?.region.currency ?? 'USD';
    const money = (v: number) => formatMoney(v, cur);
    if (s && a) {
      setText(cReached.value, fmtNum(s.reached));
      setText(cReached.sub, `of ${fmtNum(s.assessed)} buildings`);
      setText(cDamaged.value, fmtNum(s.damaged));
      setText(cDamaged.sub, 'ground storey ≥ 20 % damage');
      setText(cDestroyed.value, s.velocityKnown ? fmtNum(s.destroyed) : '—');
      setText(cDestroyed.sub, s.velocityKnown ? `fast-water collapse rule${s.partial ? `; ${fmtNum(s.partial)} partial` : ''}` : 'needs speeds (not recorded)');
      if (a.region.costCountry) {
        setText(cLoss.value, money(s.loss));
        setText(cLoss.sub, `±1σ curve range ${money(s.lossLo)} – ${money(s.lossHi)} · structure ${money(s.lossStructure)}, contents ${money(s.lossContents)} · ${a.region.name} unit costs (2026 USD)`);
      } else {
        setText(cLoss.value, '—');
        setText(cLoss.sub, `No unit-cost table for this region (${a.region.name}); dollar losses need portfolio values.`);
      }
      if (s.earliest) {
        setText(cArrival.value, formatClock(s.earliest.firstWet));
        const lead = s.earliest.leadTime;
        setText(cArrival.sub, leadVsWarningText(lead, run!.alertTime));
      } else {
        setText(cArrival.value, '—');
        setText(cArrival.sub, 'no building reached yet');
      }
      setText(cAccess.value, fmtNum(s.accessCut));
      setText(cAccess.sub, 'reached buildings whose nearest road hit 0.3 m');
      renderHazard(s.aidr, s.velocityKnown);
      const f: string[] = [];
      if (s.heightEstimated) f.push(`${fmtNum(s.heightEstimated)} storey counts come from estimated heights`);
      if (s.occupancyGuessed) f.push(`${fmtNum(s.occupancyGuessed)} occupancies are guessed from footprint size`);
      if (run!.source === 'snapshots') f.push('depth sampled from snapshots: a brief peak can be missed');
      setText(flags, f.length ? `Of the reached buildings: ${f.join('; ')}.` : '');
      renderTop(a.report!.impacts);
      badge.hidden = false;
      setText(badge, a.region.costCountry ? money(s.loss) : `${fmtNum(s.reached)} wet`);
    } else {
      badge.hidden = true;
      topTable.replaceChildren();
    }
    renderPortfolioInfo();
    renderCompare();
    renderPins();
    const has = !!a;
    csvBtn.disabled = printBtn.disabled = htmlBtn.disabled = !has;
    setText(exportNote, downloadsBlocked() ? 'The desktop app blocks downloads by design; use Print report.' : has ? 'Files are generated in this tab; nothing is uploaded.' : 'Recompute to enable export.');
  }

  function renderHazard(aidr: number[], velocityKnown: boolean) {
    const total = aidr.reduce((x, y) => x + y, 0);
    const segs = [1, 2, 3, 4, 5, 6].map((c) =>
      h('span', { class: `dl-aidr dl-aidr${c}`, style: { flexGrow: String(Math.max(aidr[c], 0)) }, title: `H${c}: ${aidr[c]}` }),
    );
    const legend = h('div', { class: 'dl-impact-hlegend' }, ...[1, 2, 3, 4, 5, 6].map((c) => h('span', null, h('i', { class: `dl-aidr${c}` }), `H${c} ${fmtNum(aidr[c])}`)));
    hazardRow.replaceChildren(
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'AIDR class, reached buildings'), velocityKnown ? null : h('span', { class: 'dl-count' }, 'depth only')),
      total ? h('div', { class: 'dl-impact-hbar' }, ...segs) : h('p', { class: 'dl-impact-fine' }, 'No building reached yet.'),
      ...(total ? [legend] : []),
    );
    hazardRow.setAttribute('aria-label', `Hazard classes: ${[1, 2, 3, 4, 5, 6].map((c) => `H${c} ${aidr[c]}`).join(', ')}`);
  }

  function renderTop(impacts: readonly BuildingImpact[]) {
    const top = topByLoss(impacts.filter((b) => b.reached), TOP_N);
    if (!top.length) {
      topTable.replaceChildren(h('p', { class: 'dl-impact-fine' }, 'No building reached by 15 cm of water yet.'));
      return;
    }
    const cur = run?.analysis.region.currency ?? 'USD';
    topTable.replaceChildren(
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, 'Building'), h('th', null, 'Depth'), h('th', null, 'Loss'))),
        h(
          'tbody',
          null,
          ...top.map((b) =>
            h(
              'tr',
              { tabindex: 0, title: 'Fly to this building', onclick: () => flyTo(b.gx, b.gy), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && flyTo(b.gx, b.gy) },
              h('td', null, h('span', { class: 'dl-impact-name' }, buildingLabel(b)), h('span', { class: 'dl-impact-meta' }, `${OCCUPANCY_PROFILES[b.occ].label} · ${b.floors} st · H${b.aidr}${b.state === 'collapse' ? ' · collapse' : ''}${b.wetFraction < 0.5 ? ` · edge only (${fmtNum(b.wetFraction * 100)} %)` : ''}`)),
              h('td', null, `${fmtNum(b.depth, 1)} m`),
              h('td', null, formatMoney(b.loss, cur)),
            ),
          ),
        ),
      ),
    );
  }

  function renderPortfolioInfo() {
    clearPortfolioBtn.hidden = !portfolio;
    if (!portfolio) {
      portfolioInfo.replaceChildren(h('p', { class: 'dl-impact-fine' }, 'Optional: a CSV with asset_id, lat, lon (or a WKT polygon) and, if you have them, replacement_value, contents_value, occupancy, floors, first_floor_height_m, critical_elev_m, daily_revenue, gross_margin, deductible, limit. Read in this tab; never uploaded.'));
      portfolioTable.replaceChildren();
      return;
    }
    const p = portfolio;
    const lines: HTMLElement[] = [];
    if (p.fatal) lines.push(h('p', { class: 'dl-impact-fine dl-warn' }, `${portfolioName}: ${p.fatal}`));
    else lines.push(h('p', { class: 'dl-impact-fine' }, `${portfolioName}: ${fmtNum(p.assets.length)} assets read${p.errors.length ? `, ${p.errors.length} rows skipped` : ''}${p.ignoredColumns.length ? `; ignored columns: ${p.ignoredColumns.slice(0, 6).join(', ')}` : ''}.`));
    const issues = [...p.errors.map((e) => ({ ...e, err: true })), ...p.warnings.map((w) => ({ ...w, err: false }))].slice(0, 6);
    if (issues.length) {
      lines.push(h('ul', { class: 'dl-impact-issues' }, ...issues.map((i) => h('li', { class: i.err ? 'dl-warn' : '' }, i.row ? `Row ${i.row}: ${i.message}` : i.message))));
      const more = p.errors.length + p.warnings.length + p.moreIssues - issues.length;
      if (more > 0) lines.push(h('p', { class: 'dl-impact-fine' }, `…and ${fmtNum(more)} more.`));
    }
    const pr = run?.analysis.portfolio;
    if (pr) {
      const ps = pr.summary;
      lines.push(
        h('p', { class: 'dl-impact-fine' }, `${fmtNum(ps.reached)} of ${fmtNum(ps.assets)} reached · loss ${formatMoney(ps.loss)} (${formatMoney(ps.lossLo)} – ${formatMoney(ps.lossHi)})` +
          (ps.bi ? ` · business interruption ${formatMoney(ps.bi)}` : '') +
          (ps.outside ? ` · ${ps.outside} outside the map` : '') +
          (ps.unvalued ? ` · ${ps.unvalued} without a value` : '') +
          (ps.otherCurrency ? ` · ${ps.otherCurrency} in other currencies (not totalled)` : '') +
          (ps.earliest ? ` · first reached: ${ps.earliest.id} at ${formatClock(ps.earliest.firstWet)}` : '')),
      );
      const rows = [...pr.results].sort((x, y) => (Number.isFinite(y.loss) ? y.loss : -1) - (Number.isFinite(x.loss) ? x.loss : -1)).slice(0, 50);
      portfolioTable.replaceChildren(
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, 'Asset'), h('th', null, 'Depth'), h('th', null, 'Loss'))),
          h(
            'tbody',
            null,
            ...rows.map((r) =>
              h(
                'tr',
                { tabindex: 0, title: 'Fly to this asset', onclick: () => flyTo(r.m.gx, r.m.gy), onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && flyTo(r.m.gx, r.m.gy) },
                h(
                  'td',
                  null,
                  h('span', { class: 'dl-impact-name' }, r.m.asset.name ? `${r.m.asset.id} · ${r.m.asset.name}` : r.m.asset.id),
                  h('span', { class: 'dl-impact-meta' }, `${OCCUPANCY_PROFILES[r.occ].label} · ${r.m.match === 'nearest' ? `nearest footprint ${fmtNum(r.m.distanceM)} m` : r.m.match} · H${r.aidr}${r.firstWet > 0 ? ` · ${formatClock(r.firstWet)}` : ''}${r.criticalWet ? ' · critical kit wet' : ''}${r.accessCut ? ` · road out from ${formatClock(r.accessCutAt)}` : ''}`),
                ),
                h('td', null, `${fmtNum(r.depth, 2)} m`),
                h('td', null, formatMoney(r.loss, r.currency)),
              ),
            ),
          ),
        ),
      );
    } else {
      portfolioTable.replaceChildren(p.fatal ? h('span') : h('p', { class: 'dl-impact-fine' }, 'Recompute to assess them.'));
    }
    portfolioInfo.replaceChildren(...lines);
  }

  function renderCompare() {
    const r = run;
    clearBaselineBtn.hidden = !baseline;
    baselineBtn.disabled = !r?.analysis.report;
    setText(baselineLine, baseline ? `Baseline: ${baseline.sig.terrainName} at ${formatClock(baseline.sig.simTime)}, loss ${formatMoney(baseline.summary.loss)}, ${fmtNum(baseline.summary.reached)} buildings reached.` : 'No baseline yet.');
    const prot = bridge.protection;
    setText(protectLine, prot && prot.areaM2 > 0 ? `The walls keep ${formatAcres(prot.areaM2)} dry right now (still-water estimate, see the green land).` : '');
    const c = currentComparison();
    if (!c || !r) {
      compareOut.replaceChildren();
      return;
    }
    const cur = r.analysis.region.currency;
    const money = (v: number) => formatMoney(v, cur);
    const view = wallLength && wallHeight ? bcrView(c, { type: mitigation, lengthM: wallLength, heightM: wallHeight, country: r.analysis.region.costCountry, returnPeriod }) : null;
    const rows: HTMLElement[] = [
      h('div', { class: 'dl-impact-kv' }, h('span', null, 'Avoided loss, this event'), h('b', null, money(c.avoided)), h('small', null, `${money(c.avoidedLo)} – ${money(c.avoidedHi)}`)),
      h('div', { class: 'dl-impact-kv' }, h('span', null, 'No longer reached'), h('b', null, fmtNum(c.noLongerReached))),
      h('div', { class: 'dl-impact-kv' + (c.newlyReached ? ' dl-warn' : '') }, h('span', null, 'Newly reached (water pushed elsewhere)'), h('b', null, fmtNum(c.newlyReached)), c.newlyReached ? h('small', null, money(c.newlyReachedLoss)) : null),
    ];
    if (view) {
      rows.push(h('div', { class: 'dl-impact-kv' }, h('span', null, `${MITIGATION_LABELS[mitigation]} cost`), h('b', null, money(view.cost.mid)), h('small', null, `${money(view.cost.low)} – ${money(view.cost.high)} · ${money(view.cost.perMetre)}/m`)));
      if (returnPeriod) {
        const rr = (x: number) => (Number.isFinite(x) ? fmtNum(x, x < 10 ? 1 : 0) : '—');
        rows.push(h('div', { class: 'dl-impact-kv' }, h('span', null, `BCR at 7 %, ${view.years} yr`), h('b', null, rr(view.bcr7)), h('small', null, `${rr(view.bcr7Range[0])} – ${rr(view.bcr7Range[1])}`)));
        rows.push(h('div', { class: 'dl-impact-kv' }, h('span', null, 'BCR at 3.1 %'), h('b', null, rr(view.bcr3)), h('small', null, `${rr(view.bcr3Range[0])} – ${rr(view.bcr3Range[1])}`)));
      }
      if (Number.isFinite(view.breakEvenT)) {
        rows.push(h('p', { class: 'dl-impact-fine' }, `Pays for itself (BCR 1 at 7 %) if an event like this happens at least once every ${fmtNum(view.breakEvenT)} years.`));
      } else if (c.avoided <= 0) {
        rows.push(h('p', { class: 'dl-impact-fine dl-warn' }, 'The wall avoids no loss in this run.'));
      }
    } else {
      rows.push(h('p', { class: 'dl-impact-fine' }, 'Enter the wall’s length and height for its cost and benefit–cost ratio.'));
    }
    rows.push(...c.warnings.map((w) => h('p', { class: 'dl-impact-fine dl-warn' }, w)));
    rows.push(h('p', { class: 'dl-impact-fine' }, 'One event only: a BCR needs how often this event happens (return period), which the simulator does not know. A FEMA-grade BCA integrates several return periods.'));
    compareOut.replaceChildren(...rows);
  }

  function renderPins() {
    const pins: AssetPin[] = [];
    const a = run?.analysis;
    if (a?.portfolio) {
      for (const m of a.portfolio.matched) {
        if (m.match === 'outside') continue;
        pins.push({ gx: m.gx, gy: m.gy, label: m.asset.name ? `${m.asset.id} — ${m.asset.name}` : m.asset.id, tone: 'portfolio', onClick: () => flyTo(m.gx, m.gy) });
      }
    }
    if (a?.report) {
      for (const b of topByLoss(a.report.impacts.filter((x) => x.reached), TOP_N)) {
        pins.push({ gx: b.gx, gy: b.gy, label: `${buildingLabel(b)} — ${formatMoney(b.loss, a.region.currency)}`, tone: 'top', onClick: () => flyTo(b.gx, b.gy) });
      }
    }
    markers.set(pins);
    markers.setVisible(pinsOn && pins.length > 0);
  }

  // ─── Portfolio file ─────────────────────────────────────────────────────────────────────────────────────────
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    portfolioName = file.name.length > 60 ? `${file.name.slice(0, 57)}…` : file.name;
    if (file.size > CSV_LIMITS.maxChars * 4) {
      portfolio = { assets: [], errors: [], warnings: [], fatal: 'File too large.', moreIssues: 0, ignoredColumns: [] };
    } else {
      try {
        const text = await file.text();
        portfolio = parsePortfolio(text);
        portfolioText = portfolio.assets.length ? text : null;
      } catch (err) {
        portfolio = { assets: [], errors: [], warnings: [], fatal: `Could not read the file (${err instanceof Error ? err.name : 'error'}).`, moreIssues: 0, ignoredColumns: [] };
      }
    }
    // The ensemble (src/ui/ensemble.ts) tallies the same assets member by member.
    bridge.portfolio = portfolioAssetsForBridge(portfolio);
    renderPortfolioInfo();
    if (portfolio.assets.length && getTerrain()) void recompute();
  });

  // ─── Export ─────────────────────────────────────────────────────────────────────────────────────────────────
  function baseName(): string {
    const s = store.get();
    const t = run ? Math.round(run.sig.simTime / 60) : 0;
    return safeFilename(`deluge-impact-${s.presetId ?? 'area'}-T${t}min`);
  }

  function exportCsv() {
    const a = run?.analysis;
    if (!a) return;
    const rows: ResultRowInput[] = [];
    for (const r of a.portfolio?.results ?? []) {
      rows.push({ id: r.m.asset.id, name: r.m.asset.name, source: 'portfolio', occ: r.occ, match: r.m.match, matchDistanceM: r.m.distanceM, r, valueStructure: r.valueStructure, valueContents: r.valueContents, valueSource: r.valueSource, currency: r.currency });
    }
    for (const b of a.report?.impacts ?? []) {
      if (!b.reached && !(b.loss > 0) && !b.accessCut) continue; // a film of water: not an impact row
      rows.push({ id: `bldg-${b.k}`, name: b.name, source: 'map', occ: b.occ, match: 'footprint', matchDistanceM: 0, r: b, valueStructure: b.valueStructure, valueContents: b.valueContents, valueSource: a.region.costCountry ? 'unit-cost' : 'none', currency: a.region.currency });
    }
    downloadText(resultsCsv(rows), `${baseName()}.csv`, 'text/csv');
  }

  function report(): HTMLElement | null {
    const r = run;
    if (!r) return null;
    const c = currentComparison();
    const view = c && wallLength && wallHeight ? bcrView(c, { type: mitigation, lengthM: wallLength, heightM: wallHeight, country: r.analysis.region.costCountry, returnPeriod }) : null;
    return buildReport({
      generatedAt: new Date(),
      attribution: store.get().attribution,
      sig: r.sig,
      source: r.source,
      trackingFrom: r.trackingFrom,
      analysis: r.analysis,
      debrisFlow: r.debrisFlow,
      alertTime: r.alertTime,
      comparison: c,
      bcr: view,
      mitigation: c ? { label: MITIGATION_LABELS[mitigation], lengthM: wallLength ?? 0, heightM: wallHeight ?? 0, returnPeriod } : null,
      earlyWarning: buildWarningSection(bridge.chain, bridge.warning),
    });
  }

  function doPrint() {
    const el = report();
    if (el) printReport(el);
  }

  function exportHtml() {
    const el = report();
    if (el) downloadText(reportHtmlDocument(el, `Deluge impact report — ${store.get().terrainName}`), `${baseName()}.html`, 'text/html');
  }

  // ─── Store wiring ───────────────────────────────────────────────────────────────────────────────────────────
  bind(
    (s) => `${s.presetId}|${s.terrainName}`,
    () => ensureScene(getTerrain()),
  );
  bind(
    (s) => s.stats,
    (st, s) => {
      if (!st) return;
      const solver = getSolver();
      if (tracking && !hasGpuFields(solver)) feedSnapshot();
      if (!auto || busy || s.paused || s.loading) return;
      const now = performance.now();
      if (now - lastAutoAt < AUTO_MS || st.simTime === lastAutoSim) return;
      lastAutoAt = now;
      lastAutoSim = st.simTime;
      void recompute();
    },
  );
  ctx.own(bridge.protectionChanged.on(() => renderCompare()));

  render();
  setStatus('Press Recompute to assess the flood so far.');

  return {
    body,
    badge,
    overlay: markers.el,
    activate() {
      ensureScene(getTerrain());
      startTracking();
    },
    getPortfolio: () => (portfolio && portfolioText !== null ? { name: portfolioName, text: portfolioText } : null),
    loadPortfolioText(name, text, opts) {
      portfolioName = cleanPlaceLabel(name, 60);
      fileInput.value = '';
      portfolio = text.length > CSV_LIMITS.maxChars ? { assets: [], errors: [], warnings: [], fatal: 'File too large.', moreIssues: 0, ignoredColumns: [] } : parsePortfolio(text);
      portfolioText = portfolio.assets.length ? text : null;
      // As for a file: the ensemble (src/ui/ensemble.ts) tallies these assets member by member.
      bridge.portfolio = portfolioAssetsForBridge(portfolio);
      renderPortfolioInfo();
      if (opts?.auto && !auto) {
        auto = true;
        autoSwitch.set(true);
      }
      if (portfolio.assets.length && getTerrain()) void recompute();
    },
  };
}
