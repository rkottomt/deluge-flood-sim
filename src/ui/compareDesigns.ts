/**
 * The "Compare designs" panel section: 2–3 mitigation designs side by side.
 *
 * A design is a named set of walls / levees / terrain edits (an edit log, src/project/edits.ts) with optional cost
 * overrides. The user captures the walls on the map as Design A, clears the map, draws Design B, captures it, and
 * presses Compare: the baseline (the bare scene) and every design run the chosen event ladder headless (headless.ts —
 * render hold, progress, Cancel, the user's scenario put back), the designs swapped in by replaying their logs, and
 * the user's own walls replayed at the end. Results (src/project/compare.ts): loss per level, EAL, ΔEAL, cost, NPV and
 * BCR at 7 % and 3.1 %, buildings protected, and who gets wetter — with a map of the change in max depth per design.
 *
 * Designs and the last comparison's numbers go into a saved project (projectState.ts hooks); the comparison exports
 * as a print / HTML report (compareReport.ts).
 */
import type { FloodSolver, HazardFields, StageControl, TerrainData, WaterSource } from '../contracts';
import { computeInitialWater } from '../data/initialWater';
import { cleanPlaceLabel } from '../data/placeName';
import { loadAtlas14Grid, lookupAtlas14, type Atlas14Point } from '../data/atlas14';
import { analyze, DEBRIS_FLOW_PRESETS, ladderFor, MITIGATION_LABELS, rainLadder, RAIN_DESIGN_DURATION_S, RAIN_SWEEP_MINUTES, regionForBounds, SCALE_LADDER, SnapshotHazardAccumulator, wallGeometry, type MitigationType } from '../loss';
import { areaDelta, compareDesigns, comparisonSummary, depthChangeThumb, resolveCost, type ComparisonResult, type CompareLevel, type DesignInput, type LevelRun } from '../project/compare';
import { cloneEdits, editLogFor, replayEdits } from '../project/edits';
import { PROJECT_LIMITS, type ComparisonSummary, type DesignSpec, type LadderKind } from '../project/format';
import { bridgeFor } from './bridge';
import { button, segmented } from './controls';
import { h, setText, toggleClass, type UIContext } from './dom';
import { downloadsBlocked, downloadText, safeFilename } from './download';
import { fmtNum } from './format';
import { headlessBusy, runHeadless, saveScenario } from './headless';
import { printReport, reportHtmlDocument } from './impactReport';
import { buildCompareReport, COMPARE_REPORT_CSS, comparisonHead, comparisonRows, depthChangeLegend, designSummaryLine, drawDepthChange, type DepthThumb } from './compareReport';
import { projectHooksFor } from './projectState';
import { numField } from './siteCheck';
import { simpleTable } from './siteReport';

const FT = 0.3048;
const DESIGN_IDS = ['A', 'B', 'C'] as const;
const MINUTES_DEFAULT = 30;
const MINUTES_MIN = 2;
const MINUTES_MAX = 240;
const CHUNK_GPU_S = 300;
const CHUNK_SNAPSHOT_S = 60;

export type CompareLadder = LadderKind | 'current';

interface Level {
  id: string;
  label: string;
  ft: number;
  scale: number;
  mmPerHour: number;
  sourceRp: number | null;
  userRp: number | null;
  on: boolean;
  outOfRange: boolean;
}

export interface CompareSection {
  body: HTMLElement[];
  badge: HTMLElement;
  /** Press Compare (automation and the e2e flow use the buttons; this is for the panel's owner). */
  run(): Promise<void>;
}

interface Outcome {
  result: ComparisonResult;
  ladder: CompareLadder;
  ladderLabel: string;
  durationS: number;
  /** Per design: depth-change thumbnails by level index. */
  thumbs: Map<string, DepthThumb[]>;
  designs: DesignSpec[];
  cellSize: number;
  terrainName: string;
  cancelled: boolean;
}

export function createCompareSection(ctx: UIContext): CompareSection {
  const { store, actions } = ctx;
  const bridge = bridgeFor(store);
  const log = editLogFor(store);
  const getSolver = (): FloodSolver | null => bridge.scene?.getSolver() ?? null;
  const getTerrain = (): TerrainData | null => bridge.scene?.getTerrain() ?? null;

  // ─── State ──────────────────────────────────────────────────────────────────────────────────────────────────
  let designs: DesignSpec[] = [];
  let summary: ComparisonSummary | null = null;
  let outcome: Outcome | null = null;
  let terrainRef: TerrainData | null = null;
  let ladderChoice: CompareLadder | 'auto' = 'auto';
  let ladder: CompareLadder = 'current';
  let levels: Level[] = [];
  let minutes = MINUTES_DEFAULT;
  let minutesTouched = false;
  let running = false;
  let cancelRequested = false;
  let mapLevel = -1;
  let rain: { for: TerrainData | null; point: Atlas14Point | null; status: 'idle' | 'loading' | 'ok' | 'none' | 'error' } = { for: null, point: null, status: 'idle' };

  // ─── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────
  const badge = h('span', { class: 'dl-sec-badge', hidden: true });
  const intro = h(
    'p',
    { class: 'dl-impact-note' },
    'Compare up to three mitigation designs — sets of walls, levees and terrain edits — against the same ladder of floods: what each saves per year, what it costs, its benefit–cost ratio, and whose land it makes wetter. Indicative screening, not a design.',
  );
  const steps = h('p', { class: 'dl-impact-fine' }, 'Draw walls (tool 2) or press “Build a levee”, then Capture. Clear the walls, draw the next design, Capture again. Then Compare.');
  const captureBtn = button('Capture walls as Design A', () => capture(), { icon: 'plus', variant: 'primary', className: 'dl-btn-sm', tip: 'Keep the walls, levees and digging on the map as a design', side: 'top' });
  captureBtn.dataset.compare = 'capture';
  const clearBtn = button('Clear walls', () => {
    actions.clearWalls();
    setStatus('Walls cleared: draw the next design, then Capture.');
  }, { icon: 'trash', className: 'dl-btn-sm', tip: 'Remove every wall on the map to draw the next design (designs already captured are kept)', side: 'top' });
  clearBtn.dataset.compare = 'clear';
  const listEl = h('div', { class: 'dl-cmp-designs', 'data-compare': 'designs' });

  const ladderSel = h('select', { class: 'dl-num-input', 'aria-label': 'Event ladder', 'data-compare': 'ladder' });
  ladderSel.addEventListener('change', () => {
    const v = ladderSel.value;
    if (v !== 'stage' && v !== 'scale' && v !== 'rain' && v !== 'current') return;
    ladderChoice = v;
    buildLadder();
    render();
  });
  const ladderEl = h('div', { class: 'dl-impact-table dl-cmp-ladder', 'data-compare': 'levels' });
  const minutesIn = numField({
    label: 'Simulated time per level',
    unit: 'min',
    min: MINUTES_MIN,
    max: MINUTES_MAX,
    step: 1,
    name: 'minutes',
    attr: 'data-compare-field',
    onChange: (v) => {
      minutesTouched = v != null;
      minutes = v ?? defaultMinutes();
    },
  });
  minutesIn.set(minutes);
  const runBtn = button('Compare', () => void run(), { icon: 'play', variant: 'primary', className: 'dl-btn-sm', tip: 'Run the baseline and every design through the ticked levels headless; your scenario and walls are put back afterwards', side: 'top' });
  runBtn.dataset.compare = 'run';
  const cancelBtn = button('Cancel', () => (cancelRequested = true), { className: 'dl-btn-sm', tip: 'Stop after the current chunk and restore your scenario and walls', side: 'top' });
  cancelBtn.hidden = true;
  const progress = h('progress', { class: 'dl-site-progress', max: 1, value: 0, hidden: true });
  const status = h('p', { class: 'dl-impact-status', 'aria-live': 'polite', 'data-compare': 'status' });
  const resultsEl = h('div', { class: 'dl-cmp-results', 'data-compare': 'results' });
  const printBtn = button('Print comparison', () => doPrint(), { icon: 'book', className: 'dl-btn-sm', tip: 'Print-friendly comparison report (Save as PDF in the dialog)', side: 'top' });
  const htmlBtn = button('Report .html', () => exportHtml(), { className: 'dl-btn-sm', tip: 'The comparison as a standalone HTML file', side: 'top' });
  htmlBtn.dataset.compare = 'report-html';
  const exportNote = h('p', { class: 'dl-impact-fine' });

  const body = [
    intro,
    steps,
    h('div', { class: 'dl-row dl-row-wrap' }, captureBtn, clearBtn),
    listEl,
    h(
      'div',
      { class: 'dl-impact-block' },
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Event ladder')),
      h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Ladder'), ladderSel),
      ladderEl,
      minutesIn.el,
      h('div', { class: 'dl-row dl-row-wrap' }, runBtn, cancelBtn),
      progress,
      status,
    ),
    resultsEl,
    h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Export')), h('div', { class: 'dl-row dl-row-wrap' }, printBtn, htmlBtn), exportNote),
  ];

  // ─── Scene and ladder ───────────────────────────────────────────────────────────────────────────────────────
  function stageCtl(): StageControl | null {
    return store.get().scenario?.stage ?? null;
  }

  function ensureScene(t: TerrainData | null) {
    if (t === terrainRef) return;
    const first = terrainRef === null;
    terrainRef = t;
    // Designs are in grid coordinates of one scene: a new scene starts without them (a project load sets them after).
    if (!first) {
      designs = [];
      summary = null;
      outcome = null;
    }
    ladderChoice = 'auto';
    rain = { for: null, point: null, status: 'idle' };
    buildLadder();
    render();
  }

  function ensureRain() {
    const t = terrainRef;
    if (!t || rain.for === t) return;
    const lat = (t.bounds.north + t.bounds.south) / 2;
    const lon = (t.bounds.east + t.bounds.west) / 2;
    if (!(lon < -60 && lat > 15)) {
      rain = { for: t, point: null, status: 'none' };
      return;
    }
    rain = { for: t, point: null, status: 'loading' };
    loadAtlas14Grid().then(
      (g) => {
        if (terrainRef !== t) return;
        const p = lookupAtlas14(g, lat, lon);
        rain = { for: t, point: p, status: p ? 'ok' : 'none' };
        if (!running) buildLadder();
        render();
      },
      () => {
        if (terrainRef !== t) return;
        rain = { for: t, point: null, status: 'error' };
        render();
      },
    );
  }

  function ladderKinds(): CompareLadder[] {
    const st = stageCtl();
    return [...(st ? (['stage'] as const) : []), ...(rain.status === 'ok' ? (['rain'] as const) : []), 'scale', 'current'];
  }

  function defaultMinutes() {
    return ladder === 'rain' ? RAIN_SWEEP_MINUTES : MINUTES_DEFAULT;
  }

  function buildLadder() {
    const st = stageCtl();
    const kinds = ladderKinds();
    const researched = st && ladderFor(store.get().presetId);
    ladder = ladderChoice !== 'auto' && kinds.includes(ladderChoice) ? ladderChoice : researched ? 'stage' : 'current';
    if (!minutesTouched) {
      minutes = defaultMinutes();
      minutesIn.set(minutes);
    }
    const base = { ft: NaN, scale: NaN, mmPerHour: NaN, sourceRp: null, userRp: null, on: true, outOfRange: false };
    if (ladder === 'rain' && rain.point) {
      levels = rainLadder(rain.point).map((l) => ({ ...base, id: l.id, label: l.label, mmPerHour: l.mmPerHour, sourceRp: l.returnPeriod }));
    } else if (ladder === 'stage' && st) {
      const lad = ladderFor(store.get().presetId);
      const src = lad
        ? lad.map((l) => ({ id: l.id, label: l.label, ft: l.ft, rp: l.returnPeriod }))
        : [...(st.floodStageFt != null ? [{ label: 'Flood stage', ft: st.floodStageFt }] : []), ...(st.marks ?? [])].map((m, i) => ({ id: `m${i}`, label: m.label, ft: m.ft, rp: null as number | null }));
      levels = src.map((l) => {
        const off = l.ft * FT + st.gaugeDatum - st.normalLevel;
        return { ...base, id: l.id, label: l.label, ft: l.ft, sourceRp: l.rp, outOfRange: off < 0 || off > st.maxOffset };
      });
    } else if (ladder === 'scale') {
      levels = SCALE_LADDER.map((k) => ({ ...base, id: `x${k}`, label: `Scenario forcing × ${k}`, scale: k, on: k === 0.5 || k === 1 }));
    } else {
      levels = [{ ...base, id: 'current', label: 'The scenario on screen' }];
    }
    for (const l of levels) if (l.outOfRange) l.on = false;
  }

  // ─── Designs ────────────────────────────────────────────────────────────────────────────────────────────────
  function nextId(): (typeof DESIGN_IDS)[number] | null {
    return DESIGN_IDS.find((d) => !designs.some((x) => x.id === d)) ?? null;
  }

  function capture() {
    if (running) return;
    const t = getTerrain();
    if (!t) return setStatus('Load a scene first.', 'warn');
    const id = nextId();
    if (!id) return setStatus(`At most ${PROJECT_LIMITS.maxDesigns} designs: remove one first.`, 'warn');
    const edits = log.snapshot();
    if (!edits.length) return setStatus('There are no walls or terrain edits on the map to capture: draw a wall (tool 2) or build the levee first.', 'warn');
    designs = [...designs, { id, name: `Design ${id}`, edits, cost: { type: 'floodwall', capexUsd: null, omUsdPerYear: null, lengthM: null, heightM: null } }];
    setStatus(`Captured Design ${id} (${designSummaryLine({ edits }, t.cellSize)}).${designs.length < 2 ? ' Clear the walls and draw the next design.' : ''}`);
    render();
  }

  /** Put a design's edits on the map (they become the user's walls). */
  function showOnMap(d: DesignSpec) {
    const solver = getSolver();
    if (!solver || running || headlessBusy(store)) return;
    actions.resetAll();
    replayEdits(solver, d.edits);
    if (d.edits.some((e) => e.op === 'wall')) bridge.wallDrawn.emit();
    setStatus(`${d.name} is on the map (the water was reset).`);
  }

  function update(id: string, patch: Partial<DesignSpec>) {
    designs = designs.map((d) => (d.id === id ? { ...d, ...patch } : d));
  }

  function renderDesigns() {
    const t = getTerrain();
    if (!designs.length) {
      listEl.replaceChildren(h('p', { class: 'dl-impact-fine' }, 'No designs yet.'));
      return;
    }
    listEl.replaceChildren(
      ...designs.map((d) => {
        const name = h('input', { type: 'text', class: 'dl-num-input dl-site-name', maxlength: PROJECT_LIMITS.designNameChars, value: d.name, 'aria-label': `Name of design ${d.id}`, 'data-compare-design': d.id });
        name.addEventListener('change', () => {
          update(d.id, { name: cleanPlaceLabel(name.value, PROJECT_LIMITS.designNameChars) || `Design ${d.id}` });
          renderCaptureBtn();
        });
        const type = segmented<MitigationType>(
          (Object.keys(MITIGATION_LABELS) as MitigationType[]).map((k) => ({ value: k, label: MITIGATION_LABELS[k].replace(/ .*/, ''), tip: MITIGATION_LABELS[k] })),
          (v) => {
            update(d.id, { cost: { ...d.cost, type: v } });
            type.set(v);
          },
          { label: `Mitigation type of ${d.name}`, className: 'dl-seg-full', tipSide: 'top' },
        );
        type.set(d.cost.type);
        const capex = numField({ label: 'Cost (override)', unit: '$', min: 0, max: 1e13, step: 100000, name: `capex-${d.id}`, attr: 'data-compare-field', placeholder: 'unit costs', onChange: (v) => update(d.id, { cost: { ...currentCost(d.id), capexUsd: v } }) });
        capex.set(d.cost.capexUsd);
        const om = numField({ label: 'O&M per year', unit: '$', min: 0, max: 1e11, step: 1000, name: `om-${d.id}`, attr: 'data-compare-field', placeholder: '0', onChange: (v) => update(d.id, { cost: { ...currentCost(d.id), omUsdPerYear: v } }) });
        om.set(d.cost.omUsdPerYear);
        const show = button('Show on map', () => showOnMap(d), { className: 'dl-btn-sm', tip: 'Replace the walls on the map with this design (resets the water)', side: 'top' });
        const replace = button('Replace with map', () => {
          const edits = log.snapshot();
          if (!edits.length) return setStatus('There are no walls on the map to take.', 'warn');
          update(d.id, { edits });
          render();
        }, { className: 'dl-btn-sm', tip: 'Take the walls on the map as this design instead', side: 'top' });
        const remove = button('Remove', () => {
          designs = designs.filter((x) => x.id !== d.id);
          render();
        }, { className: 'dl-btn-sm', tip: 'Forget this design', side: 'top' });
        return h(
          'div',
          { class: 'dl-cmp-design', 'data-design-id': d.id },
          h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, `Design ${d.id}`), name),
          h('p', { class: 'dl-impact-fine' }, t ? designSummaryLine(d, t.cellSize) : ''),
          type.el,
          h('div', { class: 'dl-impact-inputs' }, capex.el, om.el),
          h('div', { class: 'dl-row dl-row-wrap' }, show, replace, remove),
        );
      }),
    );
  }

  function currentCost(id: string) {
    return designs.find((d) => d.id === id)!.cost;
  }

  function renderCaptureBtn() {
    const id = nextId();
    const label = captureBtn.querySelector('.dl-btn-label') ?? captureBtn.lastChild;
    const text = id ? `Capture walls as Design ${id}` : 'Three designs captured';
    if (label && label.nodeType === Node.TEXT_NODE) label.textContent = text;
    else if (label instanceof HTMLElement) setText(label, text);
    captureBtn.disabled = !id || running;
  }

  // ─── The run ────────────────────────────────────────────────────────────────────────────────────────────────
  function scaledForcing(k: number, base: { sources: WaterSource[]; storms: ReturnType<typeof store.get>['storms']; rainRate: number }) {
    return {
      sources: base.sources.map((s) => (s.type === 'inflow' ? { ...s, discharge: s.discharge * k, ...(s.hydrograph ? { hydrograph: s.hydrograph.map((p) => ({ t: p.t, q: p.q * k })) } : {}) } : s)),
      storms: base.storms.map((s) => ({ ...s, intensity: s.intensity * k })),
      rainRate: base.rainRate * k,
    };
  }

  async function run(): Promise<void> {
    if (running) return;
    const terrain = getTerrain();
    const solver = getSolver();
    const sim = bridge.sim;
    if (!terrain || !solver || !sim) return setStatus('The simulation is not running yet.', 'warn');
    ensureScene(terrain);
    if (!designs.length) return setStatus('Capture at least one design first.', 'warn');
    const todo = levels.filter((l) => l.on && !l.outOfRange);
    if (!todo.length) return setStatus('Tick at least one level.', 'warn');
    if (headlessBusy(store)) return setStatus('A sweep or an ensemble is running: wait for it, or cancel it.', 'warn');
    const st = stageCtl();
    const kind = ladder;
    const saved = saveScenario(store.get());
    const gpu = typeof solver.readHazardFields === 'function';
    const dur = Math.round(minutes * 60);
    const runDesigns = designs.map((d) => ({ ...d, edits: cloneEdits(d.edits), cost: { ...d.cost } }));
    const userEdits = log.snapshot();
    const country = regionForBounds(terrain.bounds).costCountry;
    const debrisFlow = !!store.get().presetId && DEBRIS_FLOW_PRESETS.has(store.get().presetId!);
    let water: Uint8Array | null = null;
    try {
      const w0 = computeInitialWater(terrain, store.get().scenario);
      water = new Uint8Array(w0.length);
      for (let c = 0; c < w0.length; c++) water[c] = w0[c] > 0.01 ? 1 : 0;
    } catch {
      water = null;
    }
    const acc = new SnapshotHazardAccumulator();
    const variants: Array<{ id: string; name: string; edits: DesignSpec['edits'] } | null> = [null, ...runDesigns];
    const cases = variants.flatMap((v, vi) => todo.map((L, li) => ({ v, vi, L, li })));
    const baseRuns: LevelRun[] = [];
    const baseDepth: Float32Array[] = [];
    const runs = new Map<string, LevelRun[]>(runDesigns.map((d) => [d.id, []]));
    const thumbs = new Map<string, DepthThumb[]>(runDesigns.map((d) => [d.id, []]));
    const raster = new Map<string, { lengthM: number; meanHeightM: number }>();
    let onMap = -2; // which variant's edits are on the solver (-2: the user's)

    const swapTo = (vi: number) => {
      if (onMap === vi) return;
      const edits = variants[vi]?.edits ?? [];
      log.suspend();
      try {
        actions.resetAll();
        replayEdits(solver, edits);
      } finally {
        log.resume();
      }
      const v = variants[vi];
      if (v) {
        const g = wallGeometry(solver.getBarrierCPU(), terrain.nx, terrain.ny, terrain.cellSize);
        raster.set(v.id, { lengthM: g.lengthM, meanHeightM: g.meanHeightM });
      }
      onMap = vi;
    };

    running = true;
    cancelRequested = false;
    outcome = null;
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    progress.hidden = false;
    progress.value = 0;
    render();
    // The log is suspended for the whole run, not only around the swaps: the run owns the map until it has put the
    // user's walls back (cleanup), so nothing it — or anything else — does meanwhile can rewrite the user's log. (The
    // brush tools and Clear walls wait while a batch runs: tools.ts editsBlocked.)
    log.suspend();
    const out = await runHeadless({
      store,
      actions,
      sim,
      terrain,
      getTerrain,
      cases: cases.map((c) => ({
        ...c,
        apply: () => {
          swapTo(c.vi);
          setStatus(`${c.v ? c.v.name : 'Baseline (no walls)'} · level ${c.li + 1} of ${todo.length}: ${c.L.label} — running ${fmtNum(minutes)} simulated min…`);
          if (kind === 'stage' && st) store.set({ stageOffset: c.L.ft * FT + st.gaugeDatum - st.normalLevel });
          else if (kind === 'rain') store.set({ stageOffset: 0, sources: saved.sources.filter((s) => s.type !== 'inflow'), storms: [], sim: { ...store.get().sim, rainRate: c.L.mmPerHour } });
          else if (kind === 'scale') {
            const f = scaledForcing(c.L.scale, saved);
            store.set({ sources: f.sources, storms: f.storms, sim: { ...store.get().sim, rainRate: f.rainRate } });
          }
        },
      })),
      durationS: dur,
      chunkS: gpu ? CHUNK_GPU_S : CHUNK_SNAPSHOT_S,
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
        if (!gpu) {
          const snap = solver.getSnapshot();
          if (snap) acc.feed(snap.depth, snap.nx, snap.ny, snap.simTime);
        }
        if (kind === 'rain' && t >= RAIN_DESIGN_DURATION_S - 1e-3 && store.get().sim.rainRate > 0) store.set({ sim: { ...store.get().sim, rainRate: 0 } });
      },
      onProgress: (fr) => (progress.value = fr),
      collect: async (_i, c) => {
        let fields: HazardFields | null;
        if (gpu) fields = await solver.readHazardFields!();
        else {
          const snap = solver.getSnapshot();
          if (snap) acc.feed(snap.depth, snap.nx, snap.ny, snap.simTime);
          fields = acc.fields();
        }
        if (!fields) throw new Error('no flood readback');
        const a = analyze({ fields, terrain, velocityKnown: gpu, debrisFlow, alertTime: 0, portfolio: null });
        const s = a.report?.summary;
        const buildings = new Map<number, { loss: number; depth: number }>();
        for (const b of a.report?.impacts ?? []) buildings.set(b.k, { loss: b.loss, depth: b.depth });
        const r: LevelRun = { loss: s ? s.loss : NaN, lossLo: s ? s.lossLo : NaN, lossHi: s ? s.lossHi : NaN, reached: s ? s.reached : 0, buildings, area: null };
        if (!c.v) {
          baseRuns[c.li] = r;
          baseDepth[c.li] = fields.maxDepth.slice();
        } else {
          const b = baseDepth[c.li];
          if (b) {
            r.area = areaDelta(b, fields.maxDepth, water, terrain.cellSize);
            thumbs.get(c.v.id)![c.li] = depthChangeThumb(b, fields.maxDepth, water, terrain.nx, terrain.ny);
          }
          runs.get(c.v.id)![c.li] = r;
        }
      },
      cleanup: () => {
        // The user's own walls and digging back on the map (not recorded: the log still holds them).
        log.suspend();
        try {
          actions.resetAll();
          replayEdits(solver, userEdits);
        } finally {
          log.resume();
        }
        onMap = -2;
      },
    }).finally(() => log.resume());
    running = false;
    runBtn.disabled = false;
    cancelBtn.hidden = true;
    progress.hidden = true;
    // Another scene came on screen while the last case finished (or after it): its results belong to the old one, and
    // the section has already let go of that scene's designs (ensureScene). Nothing is labelled with the new scene.
    if (getTerrain() !== terrain) {
      setStatus('Comparison stopped: the scene changed during the run, so its results were discarded.', 'warn');
      render();
      return;
    }
    const complete = (arr: LevelRun[]) => todo.every((_, i) => !!arr[i]);
    const doneDesigns = runDesigns.filter((d) => complete(runs.get(d.id)!));
    if (complete(baseRuns) && doneDesigns.length) {
      const cl: CompareLevel[] = todo.map((l) => ({ id: l.id, label: l.label, returnPeriod: l.sourceRp ?? l.userRp, rpFrom: l.sourceRp != null ? 'source' : l.userRp != null ? 'user' : null }));
      const inputs: DesignInput[] = doneDesigns.map((d) => ({ id: d.id, name: d.name, cost: resolveCost(d.cost, d.edits, terrain.cellSize, country, raster.get(d.id) ?? null), levels: runs.get(d.id)! }));
      const result = compareDesigns(cl, baseRuns, inputs);
      outcome = { result, ladder: kind, ladderLabel: ladderName(kind), durationS: dur, thumbs, designs: doneDesigns, cellSize: terrain.cellSize, terrainName: terrain.name, cancelled: out.cancelled };
      summary = comparisonSummary(result, kind, dur);
      mapLevel = cl.length - 1;
    }
    if (out.error) setStatus(`Comparison stopped: ${out.error}. Your scenario and walls were restored (the water restarts from its beginning).`, 'warn');
    else if (out.cancelled) setStatus(`Cancelled after ${out.done} of ${cases.length} runs (${fmtNum(out.seconds, 0)} s). Your scenario and walls were restored.`, 'warn');
    else setStatus(`Done: baseline + ${runDesigns.length} design${runDesigns.length === 1 ? '' : 's'} × ${todo.length} level${todo.length === 1 ? '' : 's'} in ${fmtNum(out.seconds, 0)} s. Your scenario and walls were restored; the water restarts from its beginning.`);
    render();
  }

  function ladderName(k: CompareLadder): string {
    const st = stageCtl();
    return k === 'stage' ? (st?.label ?? 'River / tide levels') : k === 'rain' ? 'NOAA Atlas 14 1-hour rain' : k === 'scale' ? 'Scenario forcing × multiplier' : 'The scenario on screen';
  }

  // ─── Rendering ──────────────────────────────────────────────────────────────────────────────────────────────
  function setStatus(text: string, tone: 'info' | 'warn' = 'info') {
    setText(status, text);
    toggleClass(status, 'dl-warn', tone === 'warn');
  }

  function renderLadder() {
    const kinds = ladderKinds();
    ladderSel.replaceChildren(...kinds.map((k) => h('option', { value: k, selected: k === ladder }, ladderName(k))));
    ladderSel.disabled = running;
    ladderEl.replaceChildren(
      h(
        'table',
        null,
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'Level'), h('th', null, 'Return period'))),
        h(
          'tbody',
          null,
          ...levels.map((l) => {
            const box = h('input', { type: 'checkbox', checked: l.on, disabled: l.outOfRange || running, 'aria-label': `Run ${l.label}`, 'data-compare-level': l.id });
            box.addEventListener('change', () => (l.on = box.checked));
            let rp: HTMLElement;
            if (l.sourceRp != null) rp = h('span', { class: 'dl-impact-meta' }, `${fmtNum(l.sourceRp)} yr · source`);
            else {
              const inp = h('input', { type: 'number', class: 'dl-num-input dl-site-rp', min: 1, max: 100000, step: 1, placeholder: 'yr?', value: l.userRp ?? '', 'aria-label': `Return period of ${l.label}, years (your input)`, 'data-compare-rp': l.id });
              inp.addEventListener('change', () => {
                const v = Number(inp.value);
                l.userRp = inp.value.trim() !== '' && Number.isFinite(v) && v >= 1 ? Math.min(100000, v) : null;
              });
              rp = inp;
            }
            const meta = Number.isFinite(l.ft) ? `${fmtNum(l.ft, 2)} ft` : Number.isFinite(l.mmPerHour) ? `${fmtNum(l.mmPerHour)} mm/h` : Number.isFinite(l.scale) ? `× ${l.scale}` : 'as set up now';
            return h('tr', { class: l.outOfRange ? 'dl-site-off' : '' }, h('td', null, box), h('td', null, h('span', { class: 'dl-impact-name' }, l.label), h('span', { class: 'dl-impact-meta' }, `${meta}${l.outOfRange ? ' · beyond this scenario’s stage range' : ''}`)), h('td', null, rp));
          }),
        ),
      ),
    );
  }

  function renderResults() {
    const o = outcome;
    if (!o) {
      resultsEl.replaceChildren(
        summary
          ? h('p', { class: 'dl-impact-fine' }, `A saved comparison (${summary.designs.length} design${summary.designs.length === 1 ? '' : 's'}, ${summary.levels.length} level${summary.levels.length === 1 ? '' : 's'}) came with the project; its maps are not kept — press Compare to re-run it.`)
          : h('span'),
      );
      return;
    }
    const c = o.result;
    const parts: HTMLElement[] = [h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Results'))];
    if (o.cancelled) parts.push(h('p', { class: 'dl-impact-fine dl-warn' }, 'Cancelled: only the designs that ran every level are compared.'));
    parts.push(h('div', { class: 'dl-impact-table dl-cmp-table', 'data-compare': 'table' }, simpleTable(comparisonHead(c), comparisonRows(c, true), '')));
    if (!c.withRp) parts.push(h('p', { class: 'dl-impact-fine dl-warn' }, 'No level has a return period: no EAL, NPV or BCR. Type return periods into the ladder and Compare again.'));
    const transfer = c.designs.filter((d) => d.newlyReached > 0 || d.wetterAreaM2 > 0);
    if (transfer.length) {
      parts.push(h('p', { class: 'dl-impact-fine dl-warn', 'data-compare': 'transfer' }, `Transferred risk: ${transfer.map((d) => `${d.name} makes ${fmtNum(d.newlyReached)} building${d.newlyReached === 1 ? '' : 's'} newly wet and ${fmtNum(d.deeperBuildings)} deeper`).join('; ')} (most over the levels). The maps below show where.`));
    }
    // Depth-change maps at one level.
    const levelSel = h('select', { class: 'dl-num-input', 'aria-label': 'Level shown on the maps' }, ...c.levels.map((l, i) => h('option', { value: String(i), selected: i === mapLevel }, l.label)));
    levelSel.addEventListener('change', () => {
      mapLevel = Number(levelSel.value);
      renderResults();
    });
    const maps = h('div', { class: 'dl-cmp-maps' });
    for (const d of o.designs) {
      const th = o.thumbs.get(d.id)?.[mapLevel];
      if (!th) continue;
      const canvas = h('canvas', { class: 'dl-cmp-canvas', 'data-compare-map': d.id, role: 'img', 'aria-label': `Change in maximum depth with ${d.name}` });
      drawDepthChange(canvas, th, d.edits);
      maps.append(h('figure', null, canvas, h('figcaption', { class: 'dl-impact-fine' }, d.name)));
    }
    parts.push(h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Where the water goes instead')), h('label', { class: 'dl-num-field' }, h('span', { class: 'dl-num-label' }, 'Level'), levelSel), maps, depthChangeLegend());
    resultsEl.replaceChildren(...parts);
  }

  function render() {
    renderCaptureBtn();
    clearBtn.disabled = running;
    renderDesigns();
    renderLadder();
    renderResults();
    runBtn.disabled = running || !designs.length;
    badge.hidden = !designs.length;
    setText(badge, `${designs.length} design${designs.length === 1 ? '' : 's'}`);
    printBtn.disabled = htmlBtn.disabled = !outcome;
    setText(exportNote, downloadsBlocked() ? 'The desktop app blocks downloads by design; use Print.' : outcome ? 'Generated in this tab; nothing is uploaded.' : 'Compare to enable export.');
  }

  // ─── Export ─────────────────────────────────────────────────────────────────────────────────────────────────
  function report(): HTMLElement | null {
    const o = outcome;
    if (!o) return null;
    const maps = new Map<string, { url: string; level: string }>();
    for (const d of o.designs) {
      const th = o.thumbs.get(d.id)?.[mapLevel];
      if (!th) continue;
      const canvas = document.createElement('canvas');
      drawDepthChange(canvas, th, d.edits);
      try {
        maps.set(d.id, { url: canvas.toDataURL('image/png'), level: o.result.levels[mapLevel]?.label ?? '' });
      } catch {
        /* a tainted or unavailable canvas: the report goes without the map */
      }
    }
    return buildCompareReport({ generatedAt: new Date(), terrainName: o.terrainName, attribution: store.get().attribution, ladderLabel: o.ladderLabel, durationS: o.durationS, result: o.result, designs: o.designs, cellSize: o.cellSize, maps });
  }

  function doPrint() {
    const el = report();
    if (el) printReport(el);
  }

  function exportHtml() {
    const el = report();
    if (!el) return;
    const name = safeFilename(`deluge-design-comparison-${store.get().presetId ?? 'area'}`);
    downloadText(reportHtmlDocument(el, `Deluge design comparison — ${outcome?.terrainName ?? store.get().terrainName}`, COMPARE_REPORT_CSS), `${name}.html`, 'text/html');
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────────────────────────────────────────
  projectHooksFor(store).designs = {
    get: () => designs.map((d) => ({ ...d, edits: cloneEdits(d.edits), cost: { ...d.cost } })),
    set(d, s) {
      ensureScene(getTerrain());
      designs = d.slice(0, PROJECT_LIMITS.maxDesigns).map((x) => ({ ...x, edits: cloneEdits(x.edits), cost: { ...x.cost } }));
      summary = s;
      outcome = null;
      render();
    },
    summary: () => summary,
  };
  ctx.bind(
    (s) => `${s.presetId}|${s.terrainName}|${!!s.loading}`,
    (_k, s) => {
      if (s.loading) return;
      ensureScene(getTerrain());
      ensureRain();
    },
  );
  render();
  return { body, badge, run };
}
