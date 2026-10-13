/**
 * The Uncertainty panel section: a flood-probability ENSEMBLE of the scenario on screen. N members (12 by default) of
 * the same scenario with its uncertain inputs perturbed — inflow, rain, river stage, Manning n and the DEM itself —
 * drawn by Latin hypercube from a seed (src/loss/ensemble.ts), each run headless for the same simulated time with the
 * Site check machinery (headless.ts: render hold, progress, cancel, the user's scenario put back afterwards).
 *
 * Per member: the GPU folds its max depth into the probability map (SimControl.ensembleMap → src/sim/ensemble.ts, no
 * full-grid readback for the map), and one readHazardFields() feeds the loss model (src/loss analyze), the flooded
 * area, and every Site check site and portfolio asset — so the results are p10 / p50 / p90 of area and loss, a
 * probability map ('probability' water view: share of members deeper than 0.15 m, or 0.5 m), and "floods in 7 of 12
 * members" per asset (shown on the Site check card too).
 *
 * WHAT IT IS NOT. The members are the same model with nudged inputs, equally weighted: the share is sensitivity to the
 * stated input bands, not a calibrated probability of the real event (ENSEMBLE_CAVEAT is shown with every result).
 */
import type { FloodSolver, TerrainData } from '../contracts';
import { computeInitialWater } from '../data/initialWater';
import { makeGeoToGrid } from '../data/geo';
import {
  addPortfolioMember,
  addToTally,
  analyze,
  assessSiteRun,
  band,
  DEBRIS_FLOW_PRESETS,
  defaultRanges,
  demSourceOf,
  ENSEMBLE_CAVEAT,
  ENSEMBLE_LIMITS,
  floodedArea,
  memberForcing,
  newTally,
  PERTURBATION_NOTES,
  RANGE_LIMITS,
  regionForBounds,
  sampleMembers,
  summarizeMembers,
  tallySentence,
  type AssetTally,
  type ChainEnsembleInput,
  type EnsembleRanges,
  type ForcingState,
  type MemberResult,
} from '../loss';
import { demPerturbation } from '../sim/demNoise';
import { bridgeFor, type EnsembleView } from './bridge';
import { button, segmented } from './controls';
import { h, setText, toggleClass, type UIContext } from './dom';
import { fmtNum, formatAcres, formatMoney } from './format';
import { headlessBusy, runHeadless } from './headless';
import { numField, specKey } from './siteCheck';
import { kvList, simpleTable } from './siteReport';
import { sitesFor } from './sites';
import type { EnsembleSettings } from '../project/format';

/** runFor chunk, simulated s: the cancel latency (the GPU accumulators need no finer cadence). */
const CHUNK_S = 300;
/** Assets listed in the results table. */
const ASSET_ROWS = 20;

export interface EnsembleSection {
  body: HTMLElement[];
  badge: HTMLElement;
  /** Members, minutes, seed and bands, for a saved project (src/ui/projectState.ts). */
  getSettings(): EnsembleSettings;
  applySettings(s: EnsembleSettings): void;
}

const sceneKeyOf = (s: { presetId: string | null; terrainName: string }) => `${s.presetId}|${s.terrainName}`;

export function createEnsembleSection(ctx: UIContext): EnsembleSection {
  const { store, actions } = ctx;
  const bridge = bridgeFor(store);
  const registry = sitesFor(store);
  const getSolver = (): FloodSolver | null => bridge.scene?.getSolver() ?? null;
  const getTerrain = (): TerrainData | null => bridge.scene?.getTerrain() ?? null;

  // ─── State ──────────────────────────────────────────────────────────────────────────────────────────────────
  let members: number = ENSEMBLE_LIMITS.defaultMembers;
  let minutes: number = ENSEMBLE_LIMITS.defaultMinutes;
  let seed = 1;
  let ranges: EnsembleRanges = defaultRanges(demSourceOf(store.get().attribution));
  let rangesFor = '';
  let running = false;
  let cancelRequested = false;

  // ─── DOM ────────────────────────────────────────────────────────────────────────────────────────────────────
  const badge = h('span', { class: 'dl-sec-badge', hidden: true });
  const intro = h(
    'p',
    { class: 'dl-impact-note' },
    'How sure is the flood map? Run the scenario on screen many times with its uncertain inputs nudged within stated bands, and map in how many versions each street floods. Minutes on this GPU; your scenario is put back afterwards.',
  );
  const membersIn = numField({ label: 'Members', unit: '', min: ENSEMBLE_LIMITS.minMembers, max: ENSEMBLE_LIMITS.maxMembers, step: 1, name: 'members', attr: 'data-ens-field', onChange: (v) => (members = Math.round(v ?? ENSEMBLE_LIMITS.defaultMembers)) });
  const minutesIn = numField({ label: 'Simulated time per member', unit: 'min', min: ENSEMBLE_LIMITS.minMinutes, max: ENSEMBLE_LIMITS.maxMinutes, step: 1, name: 'minutes', attr: 'data-ens-field', onChange: (v) => (minutes = v ?? ENSEMBLE_LIMITS.defaultMinutes) });
  const seedIn = numField({ label: 'Seed', unit: '', min: 1, max: 999999, step: 1, name: 'seed', attr: 'data-ens-field', onChange: (v) => (seed = Math.round(v ?? 1)) });
  membersIn.set(members);
  minutesIn.set(minutes);
  seedIn.set(seed);

  const rangeField = (label: string, unit: string, key: keyof EnsembleRanges, lim: readonly [number, number], step: number, digits: number) => {
    const f = numField({ label, unit, min: lim[0], max: lim[1], step, name: key, attr: 'data-ens-field', onChange: (v) => (ranges = { ...ranges, [key]: v ?? 0 }) });
    return { f, sync: () => f.set(ranges[key], digits) };
  };
  const rInflow = rangeField('Inflow ±', '%', 'inflowPct', RANGE_LIMITS.inflowPct, 1, 0);
  const rRain = rangeField('Rain ±', '%', 'rainPct', RANGE_LIMITS.rainPct, 1, 0);
  const rStage = rangeField('River stage ±', 'm', 'stageM', RANGE_LIMITS.stageM, 0.05, 2);
  const rNlo = rangeField('Manning n from', '', 'manningLo', RANGE_LIMITS.manning, 0.001, 3);
  const rNhi = rangeField('to', '', 'manningHi', RANGE_LIMITS.manning, 0.001, 3);
  const rDem = rangeField('Terrain error σ', 'm', 'demSigmaM', RANGE_LIMITS.demSigmaM, 0.05, 2);
  const allRanges = [rInflow, rRain, rStage, rNlo, rNhi, rDem];
  const applies = h('p', { class: 'dl-impact-fine', 'data-ens': 'applies' });
  const notes = h(
    'details',
    { class: 'dl-impact-methods' },
    h('summary', null, 'What the perturbations represent'),
    ...PERTURBATION_NOTES.map((n) => h('div', { class: 'dl-impact-method' }, h('b', null, n.title), h('p', null, n.text))),
    h('div', { class: 'dl-impact-method' }, h('b', null, 'Sampling'), h('p', null, 'Latin hypercube: each member falls in its own 1/N slice of every input’s range, so even 12 members span every band; the same seed gives the same members. Members are equally weighted.')),
  );

  const runBtn = button('Run ensemble', () => void run(), { icon: 'play', variant: 'primary', className: 'dl-btn-sm', tip: 'Run every member headless at full speed; your scenario is put back afterwards', side: 'top' });
  runBtn.dataset.ens = 'run';
  const cancelBtn = button('Cancel', () => (cancelRequested = true), { className: 'dl-btn-sm', tip: 'Stop after the current chunk and restore your scenario', side: 'top' });
  cancelBtn.hidden = true;
  const progress = h('progress', { class: 'dl-site-progress', max: 1, value: 0, hidden: true });
  const status = h('p', { class: 'dl-impact-status', 'aria-live': 'polite', 'data-ens': 'status' });

  const showBtn = button('Show probability map', () => ctx.setRender({ waterMode: 'probability' }), { icon: 'layers', className: 'dl-btn-sm', tip: 'Water view: share of members deeper than the threshold', side: 'top' });
  showBtn.dataset.ens = 'show';
  const threshold = segmented<'0.15' | '0.5'>(
    [
      { value: '0.15', label: '> 15 cm', tip: 'Ankle-deep: stops cars, starts ground-floor damage' },
      { value: '0.5', label: '> 50 cm', tip: 'Cars float, people are knocked over' },
    ],
    (v) => ctx.setRender({ probabilityThreshold: Number(v) }),
    { label: 'Probability threshold', className: 'dl-seg-full', tipSide: 'top' },
  );
  const results = h('div', { class: 'dl-ens-results', 'data-ens': 'results' });
  const resultsBlock = h('div', { class: 'dl-impact-block', hidden: true }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Results')), h('div', { class: 'dl-row dl-row-wrap' }, showBtn), threshold.el, results);

  const body = [
    intro,
    h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Ensemble')), h('div', { class: 'dl-impact-inputs' }, membersIn.el, minutesIn.el, seedIn.el)),
    h(
      'div',
      { class: 'dl-impact-block' },
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Perturbation bands')),
      h('div', { class: 'dl-impact-inputs' }, rInflow.f.el, rRain.f.el, rStage.f.el),
      h('div', { class: 'dl-impact-inputs' }, rNlo.f.el, rNhi.f.el, rDem.f.el),
      applies,
      notes,
    ),
    h('div', { class: 'dl-impact-block' }, h('div', { class: 'dl-row dl-row-wrap' }, runBtn, cancelBtn), progress, status),
    resultsBlock,
  ];

  // ─── Scene ──────────────────────────────────────────────────────────────────────────────────────────────────
  function syncScene() {
    const s = store.get();
    const key = sceneKeyOf(s);
    if (key === rangesFor) return;
    rangesFor = key;
    // A new scene: its DEM decides the terrain σ; an ensemble of another scene no longer applies.
    ranges = { ...ranges, demSigmaM: defaultRanges(demSourceOf(s.attribution)).demSigmaM };
    if (bridge.ensemble && bridge.ensemble.sceneKey !== key) bridge.setEnsemble(null);
    for (const r of allRanges) r.sync();
    renderApplies();
  }

  function chainInput(): ChainEnsembleInput | null {
    const c = bridge.chain;
    if (!c?.result || c.inflow !== 'chain') return null;
    return {
      det: { entryPeak: c.result.entryPeak, entryFront: c.result.entryFront },
      members: c.members ?? null,
      band: c.entryBand ?? null,
    };
  }

  function renderApplies() {
    const s = store.get();
    const hasInflow = s.sources.some((w) => w.type === 'inflow');
    const hasRain = s.sim.rainRate > 0 || s.storms.length > 0;
    const hasStage = !!s.scenario?.stage;
    const chain = chainInput();
    const solver = getSolver();
    const dem = demSourceOf(s.attribution);
    const parts = [
      hasInflow ? (chain ? `inflow: the routed outburst takes the glacier chain’s own members${chain.members?.length ? ` (${chain.members.length})` : ' (its p10–p90 band)'}` : 'inflow') : null,
      hasRain ? 'rain' : null,
      hasStage ? 'river stage' : null,
      'Manning n',
      ranges.demSigmaM > 0 && solver && typeof solver.setBedPerturbation === 'function' ? `terrain (${dem === '3dep' ? 'USGS 3DEP' : dem === 'copernicus' ? 'Copernicus GLO-30' : dem === 'terrarium' ? 'Terrarium' : 'unknown DEM'})` : null,
    ].filter(Boolean);
    const inert = [!hasInflow ? 'inflow' : null, !hasRain ? 'rain' : null, !hasStage ? 'stage' : null].filter(Boolean);
    setText(applies, `Perturbed here: ${parts.join(', ')}.${inert.length ? ` This scenario has no ${inert.join(' / ')}, so ${inert.length === 1 ? 'that band does' : 'those bands do'} nothing.` : ''}`);
    rStage.f.el.hidden = !hasStage;
  }

  // ─── The run ────────────────────────────────────────────────────────────────────────────────────────────────
  function setStatus(text: string, tone: 'info' | 'warn' = 'info') {
    setText(status, text);
    toggleClass(status, 'dl-warn', tone === 'warn');
  }

  async function run(): Promise<void> {
    if (running) return;
    const terrain = getTerrain();
    const solver = getSolver();
    const sim = bridge.sim;
    const map = sim?.ensembleMap?.() ?? null;
    if (!terrain || !solver || !sim) return setStatus('The simulation is not running yet.', 'warn');
    if (!map || typeof solver.readHazardFields !== 'function') return setStatus('This solver has no GPU flood accumulators: the ensemble needs them.', 'warn');
    if (headlessBusy(store)) return setStatus('A Site check sweep is running: wait for it, or cancel it.', 'warn');
    syncScene();
    const s0 = store.get();
    const n = Math.max(ENSEMBLE_LIMITS.minMembers, Math.min(ENSEMBLE_LIMITS.maxMembers, Math.round(members)));
    const durationS = Math.round(Math.max(ENSEMBLE_LIMITS.minMinutes, Math.min(ENSEMBLE_LIMITS.maxMinutes, minutes)) * 60);
    const chain = chainInput();
    const params = sampleMembers(n, ranges, seed, chain);
    const base: ForcingState = { sources: s0.sources, storms: s0.storms, rainRate: s0.sim.rainRate, stageOffset: s0.stageOffset, manningN: s0.sim.manningN };
    const stage = s0.scenario?.stage ?? null;
    let demOn = ranges.demSigmaM > 0 && typeof solver.setBedPerturbation === 'function';
    let initialDepth: Float32Array | null = null;
    let demNote = '';
    if (demOn) {
      // The wet mask keeps the noise off the rivers and lakes the run starts with. Without it the field would move
      // the river bed itself (and banks under the river's level spill it at t = 0), so no mask → no terrain band.
      try {
        initialDepth = computeInitialWater(terrain, s0.scenario);
      } catch (err) {
        demOn = false;
        demNote = ` Terrain error not perturbed: the starting rivers could not be mapped (${err instanceof Error ? err.message : 'error'}).`;
      }
    }
    // The ground before any member perturbs it (the user's own edits included): the noise keeps banks above the water on it.
    const ground0 = demOn ? solver.getGroundCPU().slice() : null;
    const debrisFlow = !!s0.presetId && DEBRIS_FLOW_PRESETS.has(s0.presetId);
    const region = regionForBounds(terrain.bounds);
    const toGrid = makeGeoToGrid(terrain);
    const specs = registry.sites.slice();
    const portfolio = bridge.portfolio?.slice() ?? null;
    const view: EnsembleView = {
      sceneKey: sceneKeyOf(s0),
      ranges: { ...ranges },
      seed,
      planned: n,
      rows: [],
      summary: null,
      durationS,
      sites: new Map(specs.map((sp) => [sp.id, newTally(sp.id, sp.name || sp.id)])),
      assets: (portfolio ?? []).map((a) => newTally(a.id, a.name || a.id)),
      siteKeys: new Map(specs.map((sp) => [sp.id, specKey(sp)])),
      cancelled: false,
      seconds: 0,
    };

    running = true;
    cancelRequested = false;
    runBtn.disabled = true;
    cancelBtn.hidden = false;
    progress.hidden = false;
    progress.value = 0;
    map.clear();
    bridge.setEnsemble(null);
    render();
    const t0 = performance.now();
    let memberStart = t0;
    let demMs = 0;
    const out = await runHeadless({
      store,
      actions,
      sim,
      terrain,
      getTerrain,
      cases: params.map((m) => ({
        m,
        apply: () => {
          const f = memberForcing(base, m, { stageMax: stage ? stage.maxOffset : null, chainSourceId: chain ? 'chain-inflow' : null });
          // Two updates, not one: f.sources are the BASE sources (their stage levels at base.stageOffset) with the
          // member's inflow factor, and SimSync records sources that change together with the offset as already
          // including it — one combined update left every member's river boundaries at the base stage. Setting them
          // with the base offset records them correctly; the offset change then moves the stage levels.
          store.set({ sources: f.sources, storms: f.storms, stageOffset: base.stageOffset, sim: { ...store.get().sim, rainRate: f.rainRate, manningN: f.manningN } });
          store.set({ stageOffset: f.stageOffset });
          if (demOn) {
            const td = performance.now();
            solver.setBedPerturbation!(demPerturbation({ nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize, sigma: ranges.demSigmaM, corrLenM: ranges.demCorrM, seed: m.seed, initialDepth, elevation: ground0 }));
            demMs += performance.now() - td;
          }
          memberStart = performance.now();
        },
      })),
      durationS,
      chunkS: CHUNK_S,
      cancelled: () => cancelRequested,
      onProgress: (fr, i) => {
        progress.value = fr;
        const el = (performance.now() - t0) / 1000;
        const eta = fr > 0.02 ? (el / fr) * (1 - fr) : NaN;
        setStatus(`Member ${i + 1} of ${n} · ${fmtNum(fr * 100)} %${Number.isFinite(eta) ? ` · about ${fmtEta(eta)} left` : ''}`);
      },
      collect: async (i, { m }) => {
        const runMs = performance.now() - memberStart;
        const tr = performance.now();
        const fields = await solver.readHazardFields!();
        const readMs = performance.now() - tr;
        map.accumulate();
        const tl = performance.now();
        const a = analyze({ fields, terrain, velocityKnown: true, debrisFlow, portfolio });
        const sum = a.report?.summary ?? null;
        const row: MemberResult = {
          index: i,
          params: m,
          simTime: fields.simTime,
          floodedM2: floodedArea(fields.maxDepth, fields.firstWet, terrain.cellSize, 0.15),
          flooded50M2: floodedArea(fields.maxDepth, fields.firstWet, terrain.cellSize, 0.5),
          reached: sum ? sum.reached : NaN,
          loss: sum ? sum.loss : NaN,
          lossLo: sum ? sum.lossLo : NaN,
          lossHi: sum ? sum.lossHi : NaN,
          runMs,
          readMs,
          lossMs: 0,
        };
        // Sites: the Site check model without egress (no routing per member).
        const ground = solver.getGroundCPU();
        for (const sp of specs) {
          const r = assessSiteRun(sp, fields, { region, grid: { nx: terrain.nx, ny: terrain.ny, cellSize: terrain.cellSize }, toGrid, ground, heightProfile: region.iso === 'NP' ? 'nepal' : 'us', debrisFlow });
          addToTally(view.sites.get(sp.id)!, r.result ? r.result.depth : NaN, r.result ? r.result.loss : NaN);
        }
        // Portfolio assets, matched to their results by identity: assessPortfolio drops the ones off the map.
        if (portfolio) addPortfolioMember(view.assets, portfolio, a.portfolio?.results ?? []);
        row.lossMs = performance.now() - tl;
        view.rows.push(row);
        view.summary = summarizeMembers(view.rows);
        // Published member by member: the map and the Site check card fill in while it runs.
        bridge.setEnsemble({ ...view, rows: view.rows.slice() });
      },
      cleanup: () => {
        if (demOn) solver.setBedPerturbation!(null);
      },
    });
    view.cancelled = out.cancelled;
    view.seconds = out.seconds;
    running = false;
    runBtn.disabled = false;
    cancelBtn.hidden = true;
    progress.hidden = true;
    if (view.rows.length) {
      bridge.setEnsemble({ ...view, rows: view.rows.slice() });
      ctx.setRender({ waterMode: 'probability' });
    } else {
      map.clear();
      bridge.setEnsemble(null);
    }
    const rate = view.rows.length / Math.max(1e-6, out.seconds / 60);
    const timing = view.rows.length ? ` ${fmtNum(rate, 1)} members/min; readback ${fmtNum(avg(view.rows.map((r) => r.readMs)))} ms, loss ${fmtNum(avg(view.rows.map((r) => r.lossMs)))} ms per member${demOn ? `, terrain field ${fmtNum(demMs / Math.max(1, view.rows.length))} ms` : ''}.` : '';
    if (out.error) setStatus(`Stopped: ${out.error}. ${view.rows.length} of ${n} members kept. Your scenario was restored (the water restarts from its beginning).${timing}${demNote}`, 'warn');
    else if (out.cancelled) setStatus(`Cancelled after ${view.rows.length} of ${n} members (${fmtNum(out.seconds, 0)} s). Your scenario was restored; the water restarts from its beginning.${timing}${demNote}`, 'warn');
    else setStatus(`Done: ${n} members in ${fmtNum(out.seconds, 0)} s. Your scenario was restored; the water restarts from its beginning.${timing}${demNote}`);
    render();
  }

  // ─── Results ────────────────────────────────────────────────────────────────────────────────────────────────
  function render() {
    const e = bridge.ensemble;
    const ok = !!e && e.sceneKey === sceneKeyOf(store.get()) && e.rows.length > 0;
    resultsBlock.hidden = !ok;
    badge.hidden = !ok;
    if (!ok || !e) {
      results.replaceChildren();
      return;
    }
    setText(badge, `${e.rows.length} members`);
    threshold.set((store.get().render.probabilityThreshold ?? 0.15) >= 0.5 ? '0.5' : '0.15');
    const s = e.summary!;
    const money = (v: number) => formatMoney(v);
    const tri = (b: [number, number, number], f: (v: number) => string) => `${f(b[0])} · ${f(b[1])} · ${f(b[2])}`;
    const hasLoss = Number.isFinite(s.loss[1]);
    const kv: Array<[string, string]> = [
      ['Members', `${e.rows.length}${e.rows.length < e.planned ? ` of ${e.planned} (cancelled)` : ''} · ${fmtNum(e.durationS / 60)} simulated min each · seed ${e.seed}`],
      ['Flooded > 15 cm (p10 · p50 · p90)', tri(s.floodedM2, (v) => formatAcres(v))],
      ['Flooded > 50 cm (p10 · p50 · p90)', tri(s.flooded50M2, (v) => formatAcres(v))],
    ];
    if (Number.isFinite(s.reached[1])) kv.push(['Buildings reached (p10 · p50 · p90)', tri(s.reached, (v) => fmtNum(v))]);
    if (hasLoss) {
      kv.push(['Loss (p10 · p50 · p90)', tri(s.loss, money)]);
      kv.push(['With damage-curve uncertainty', `${money(s.lossWide[0])} – ${money(s.lossWide[1])}`]);
    }
    const parts: HTMLElement[] = [kvList(kv, 'dl-site-kv')];
    // Assets: sites first, then the portfolio, most likely to flood first.
    const tallies: Array<{ kind: string; t: AssetTally }> = [
      ...[...e.sites.values()].map((t) => ({ kind: 'Site', t })),
      ...e.assets.map((t) => ({ kind: 'Asset', t })),
    ].filter((x) => x.t.members > 0);
    if (tallies.length) {
      tallies.sort((a, b) => b.t.reached - a.t.reached || b.t.over50 - a.t.over50);
      const rows = tallies.slice(0, ASSET_ROWS).map(({ kind, t }) => {
        const d = t.depths.filter((x) => Number.isFinite(x));
        const p50 = d.length ? band(d)[1] : NaN;
        // Off the map: not assessed, so neither "0 of N" (that reads as dry) nor a depth.
        const n = t.members - t.outside;
        if (n === 0) return [`${kind}: ${t.name}`, 'outside the map', '—', '—'];
        return [`${kind}: ${t.name}`, `${t.reached} of ${n}`, `${t.over50} of ${n}`, Number.isFinite(p50) ? `${fmtNum(p50, 2)} m` : '—'];
      });
      parts.push(h('div', { class: 'dl-impact-table dl-ens-assets', 'data-ens': 'assets' }, simpleTable(['', '> 15 cm in', '> 50 cm in', 'Depth p50'], rows, '')));
      if (tallies.length > ASSET_ROWS) parts.push(h('p', { class: 'dl-impact-fine' }, `${tallies.length - ASSET_ROWS} more not listed.`));
      const top = tallies[0];
      parts.push(h('p', { class: 'dl-impact-fine' }, `${top.t.name} ${tallySentence(top.t)}.`));
    } else {
      parts.push(h('p', { class: 'dl-impact-fine' }, 'Drop a Site check site or load a portfolio CSV (Impact & loss) before running, for “floods in 7 of 12 members” per asset.'));
    }
    const memberRows = e.rows.map((r) => [
      String(r.index + 1),
      r.params.chain ? `peak ×${fmtNum(r.params.chain.peakFactor, 2)}, front ${r.params.chain.frontShift >= 0 ? '+' : ''}${fmtNum(r.params.chain.frontShift / 60, 1)} min` : `×${fmtNum(r.params.inflowFactor, 2)}`,
      `×${fmtNum(r.params.rainFactor, 2)}`,
      `${r.params.stageDelta >= 0 ? '+' : ''}${fmtNum(r.params.stageDelta, 2)}`,
      fmtNum(r.params.manningN, 3),
      formatAcres(r.floodedM2),
      Number.isFinite(r.loss) ? money(r.loss) : '—',
    ]);
    parts.push(
      h(
        'details',
        { class: 'dl-impact-methods' },
        h('summary', null, 'Every member'),
        h('div', { class: 'dl-impact-table' }, simpleTable(['#', 'Inflow', 'Rain', 'Stage m', 'n', 'Flooded', 'Loss'], memberRows, '')),
      ),
    );
    parts.push(h('p', { class: 'dl-impact-fine dl-ens-caveat' }, ENSEMBLE_CAVEAT));
    results.replaceChildren(...parts);
  }

  // ─── Wiring ─────────────────────────────────────────────────────────────────────────────────────────────────
  ctx.own(bridge.ensembleChanged.on(() => render()));
  ctx.own(bridge.chainChanged.on(() => renderApplies()));
  ctx.bind(
    (s) => `${sceneKeyOf(s)}|${s.sources.length}|${s.storms.length}|${s.sim.rainRate > 0}|${!!s.scenario?.stage}`,
    () => {
      syncScene();
      renderApplies();
      if (!running) render();
    },
  );
  ctx.bind(
    (s) => s.render.probabilityThreshold ?? 0.15,
    (v) => threshold.set(v >= 0.5 ? '0.5' : '0.15'),
  );
  syncScene();
  render();
  return {
    body,
    badge,
    getSettings: () => ({ members, minutes, seed, ranges: { ...ranges } }),
    applySettings(set) {
      if (running) return;
      syncScene();
      members = set.members;
      minutes = set.minutes;
      seed = set.seed;
      ranges = { ...ranges, ...set.ranges };
      membersIn.set(members);
      minutesIn.set(minutes);
      seedIn.set(seed);
      for (const r of allRanges) r.sync();
      renderApplies();
    },
  };
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function fmtEta(s: number): string {
  if (s < 90) return `${Math.max(1, Math.round(s))} s`;
  return `${Math.round(s / 60)} min`;
}
