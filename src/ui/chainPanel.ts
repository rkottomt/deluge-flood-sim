/**
 * The "Hazard chain" panel section, on presets whose flood starts upstream of the map (ScenarioPreset.hazardChain):
 * what started it (a lake that burst, a mass of rock and ice that fell) with where each number comes from — observed,
 * reconstructed, modelled or scenario — a few what-ifs that re-run the chain in the worker (the trigger volume within
 * its band, the breach's erosion rate, the avalanche's mechanism), and the ensemble's p10 / p50 / p90 of the peak
 * discharge and the arrival at the map's edge. Which inflow drives the map — the routed chain or the preset's own —
 * is a switch here too. Under the results, the Early warning block (warningPanel.ts): sensors, lead times, best site.
 *
 * The app does the work (src/app/hazardChain.ts) and publishes a ChainView on the UI bridge; this file only draws it
 * and calls ChainControl. All text goes through textContent.
 */
import type { Provenance } from '../hazard/types';
import { EROSION_RATE_AVALANCHE_DAM, EROSION_RATE_TRIGGERED } from '../hazard/defaults';
import { bridgeFor, type ChainView, type ChainWhatIf } from './bridge';
import { append, h, setText, toggleClass, type UIContext } from './dom';
import { button, segmented, slider, type Slider } from './controls';
import { fmtNum, formatDischarge } from './format';
import { formatSpan, formatWhen, parseEventClock, triggerSummary, volumeFactorFor, type EventClock, type TriggerSummary } from './chainTime';
import { logToT, tToLog } from './scales';
import { createWarningBlock } from './warningPanel';

const PROVENANCE_TIP: Record<Provenance, string> = {
  observed: 'Observed — measured or reported at the time',
  reconstructed: 'Reconstructed — estimated after the event from evidence',
  modelled: 'Modelled — computed by this app’s chain or another model',
  scenario: 'Scenario — an assumed value, not an event',
};

export function provenanceBadge(p: Provenance): HTMLElement {
  return h('span', { class: `dl-prov dl-prov-${p}`, 'data-tip': PROVENANCE_TIP[p], 'data-tip-side': 'left' }, p);
}

const EROSION_MIN = 5;
const EROSION_MAX = 300;

export interface ChainSection {
  body: HTMLElement[];
  badge: HTMLElement;
  /** Show the section (only scenes with a hazard chain have one). */
  onVisible(fn: (visible: boolean) => void): void;
}

export function createChainSection(ctx: UIContext): ChainSection {
  const bridge = bridgeFor(ctx.store);
  const badge = h('span', { class: 'dl-sec-badge' });
  const root = h('div', { class: 'dl-chain', 'data-status': 'none' });
  const visibleFns: Array<(v: boolean) => void> = [];

  let sceneKey = '';
  let clock: EventClock | null = null;
  let summary: TriggerSummary | null = null;
  // The what-if being edited (applied on Run).
  let volume = 0;
  let erosion: number | null = null;
  let mode: 'transientDam' | 'directFlow' | undefined;
  let volSlider: Slider | null = null;
  let eroSlider: Slider | null = null;
  let modeSeg: ReturnType<typeof segmented<'transientDam' | 'directFlow'>> | null = null;

  // Dynamic parts.
  const notes = h('ul', { class: 'dl-chain-notes' });
  const runBtn = button('Run the chain', () => run(), { icon: 'play', variant: 'primary', tip: 'Route the what-if down the valley (a few seconds, off the main thread) and replay the map with it', className: 'dl-btn-sm dl-chain-run' });
  const resetBtn = button('Defaults', () => resetWhatIf(), { icon: 'reset', tip: 'Back to the scenario’s own trigger', className: 'dl-btn-sm' });
  const progress = h('div', { class: 'dl-progress dl-chain-progress' }, h('div', { class: 'dl-progress-fill' }));
  const statusText = h('span', { class: 'dl-chain-status', role: 'status', 'aria-live': 'polite' });
  const results = h('div', { class: 'dl-chain-results' });
  const inflowSeg = segmented<'chain' | 'scenario'>(
    [
      { value: 'chain', label: 'Routed chain', tip: 'The map’s inflow is the wave routed down the valley by the chain' },
      { value: 'scenario', label: 'Preset inflow', tip: 'The map’s inflow is the preset’s own hydrograph (its story text describes it)' },
    ],
    (v) => bridge.chainControl?.setInflow(v),
    { label: 'Inflow on the map', className: 'dl-seg-full', tipSide: 'top' },
  );
  const obsList = h('ul', { class: 'dl-chain-obs' });
  // The early-warning designer (warningPanel.ts): built once, kept across rebuilds; it follows the chain view itself.
  const warning = createWarningBlock(ctx);

  function whatIf(): ChainWhatIf {
    const overrides: ChainWhatIf['overrides'] = {};
    if (summary?.volume) {
      const f = volumeFactorFor(summary, volume);
      if (Math.abs(f - 1) > 1e-6) overrides.volumeFactor = f;
    }
    if (summary?.erodes && erosion !== null && summary.erosionRate !== null && Math.abs(erosion - summary.erosionRate) > 1e-6) overrides.erosionRate = erosion;
    return { overrides, ...(mode ? { mode } : {}) };
  }

  function run() {
    bridge.chainControl?.run(whatIf());
  }

  function resetWhatIf() {
    if (!summary) return;
    volume = summary.volume?.median ?? 0;
    erosion = summary.erosionRate;
    const v = bridge.chain;
    mode = v?.spec.trigger.kind === 'massIntoRiver' ? v.spec.trigger.mode : undefined;
    volSlider?.set(volume);
    eroSlider?.set(erosion ?? 0);
    if (mode) modeSeg?.set(mode);
    syncErosionEnabled();
    run();
  }

  function syncErosionEnabled() {
    // A direct debris flow has no dam to erode.
    eroSlider?.setDisabled(mode === 'directFlow');
  }

  /** Rebuild the controls for a new scene. */
  function build(v: ChainView) {
    volSlider?.destroy();
    eroSlider?.destroy();
    volSlider = eroSlider = null;
    modeSeg = null;
    clock = parseEventClock(v.file?.clockZero);
    summary = triggerSummary(v.spec, { clockZero: v.file?.clockZero }, { avalancheDamRate: EROSION_RATE_AVALANCHE_DAM, triggeredRate: EROSION_RATE_TRIGGERED });
    volume = summary.volume?.median ?? 0;
    erosion = summary.erosionRate;
    mode = v.spec.trigger.kind === 'massIntoRiver' ? v.spec.trigger.mode : undefined;

    const facts = h(
      'dl',
      { class: 'dl-chain-facts' },
      ...summary.facts.flatMap((f) => [h('dt', null, f.label), h('dd', null, h('span', null, f.value), provenanceBadge(f.provenance))]),
    );
    if (summary.volume) {
      const vb = summary.volume;
      facts.append(
        h('dt', null, vb.label),
        h('dd', null, h('span', null, `${fmtMm3(vb.median)} (${fmtMm3(vb.lo)}–${fmtMm3(vb.hi)})`), provenanceBadge(vb.provenance)),
      );
    }
    const alert = v.spec.alertTime;
    if (alert !== undefined && Number.isFinite(alert)) {
      facts.append(h('dt', null, 'Alert'), h('dd', null, h('span', null, `${formatWhen(clock, alert)} — first warnings`), provenanceBadge('observed')));
    }

    const controls: HTMLElement[] = [];
    if (summary.volume) {
      const vb = summary.volume;
      volSlider = slider({
        label: vb.label,
        toPos: (x) => logToT(x, vb.lo, vb.hi),
        fromPos: (t) => roundVolume(tToLog(t, vb.lo, vb.hi)),
        format: fmtMm3,
        sub: (x) => (Math.abs(x - vb.median) / vb.median < 0.02 ? `median · ${vb.note}` : x < vb.median ? 'below the median' : 'above the median'),
        onInput: (x) => (volume = x),
        tip: `What-if: ${vb.label.toLowerCase()} within its uncertainty band (${vb.note})`,
        className: 'dl-chain-slider',
      });
      volSlider.set(volume);
      controls.push(volSlider.el);
    }
    if (summary.modes) {
      modeSeg = segmented<'transientDam' | 'directFlow'>(
        [
          { value: 'transientDam', label: 'Dams the river', tip: 'The deposit blocks the valley; the river fills the lake behind it, then it breaches (the 2026 mechanism)' },
          { value: 'directFlow', label: 'Flows on', tip: 'The avalanche turns straight into a debris flood (no dam)' },
        ],
        (m) => {
          mode = m;
          modeSeg?.set(m);
          syncErosionEnabled();
        },
        { label: 'What the avalanche does', className: 'dl-seg-full', tipSide: 'top' },
      );
      modeSeg.set(mode!);
      controls.push(h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'What the avalanche does')), modeSeg.el);
    }
    if (summary.erodes && summary.erosionRate !== null) {
      eroSlider = slider({
        label: 'Breach erosion rate',
        toPos: (x) => logToT(x, EROSION_MIN, EROSION_MAX),
        fromPos: (t) => Math.round(tToLog(t, EROSION_MIN, EROSION_MAX)),
        format: (x) => `${fmtNum(x, 0)} m/h`,
        sub: (x) => (x < 20 ? 'slow — a long, low flood' : x <= 60 ? 'typical moraine dam' : 'fast — a sharp, high peak'),
        onInput: (x) => (erosion = x),
        tip: 'How fast the breach cuts down through the dam: faster gives a higher, earlier peak',
        className: 'dl-chain-slider',
      });
      eroSlider.set(erosion ?? 0);
      controls.push(eroSlider.el);
      syncErosionEnabled();
    }

    obsList.replaceChildren(
      ...(v.spec.observations ?? [])
        .filter((o) => o.tFront !== undefined || o.qPeak !== undefined)
        .map((o) =>
          h(
            'li',
            { 'data-tip': `${o.note} — ${o.source}`, 'data-tip-side': 'left' },
            h('b', null, o.station.replace(/\s*\(.*\)$/, '')),
            ' ',
            o.tFront !== undefined ? formatWhen(clock, o.tFront) : '',
            o.qPeak !== undefined ? `${o.tFront !== undefined ? ' · ' : ''}peak ${formatDischarge(o.qPeak)}` : '',
          ),
        ),
    );

    root.replaceChildren();
    append(
      root,
      [h('div', { class: 'dl-chain-title' }, summary.title),
      facts,
      notes,
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'What if…')),
      ...controls,
      h('div', { class: 'dl-row dl-chain-actions' }, runBtn, resetBtn, h('span', { class: 'dl-flex' })),
      h('div', { class: 'dl-chain-statusrow' }, progress, statusText),
      results,
      warning.el,
      h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Inflow on the map')),
      inflowSeg.el,
      obsList.childElementCount ? h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Observed'), provenanceBadge('observed')) : null,
      obsList.childElementCount ? obsList : null],
    );
  }

  /** Status, results and the badge for the current view. */
  function sync(v: ChainView) {
    root.dataset.status = v.status;
    const busy = v.status === 'loading' || v.status === 'running' || v.status === 'ensemble';
    runBtn.disabled = v.status === 'loading' || !v.file;
    toggleClass(runBtn, 'dl-busy', v.status === 'running');
    progress.hidden = !busy;
    toggleClass(progress, 'dl-indeterminate', v.status !== 'ensemble');
    const p = v.progress && v.progress.total > 0 ? v.progress.done / v.progress.total : 0;
    (progress.firstChild as HTMLElement).style.setProperty('--p', String(p));
    setText(
      statusText,
      v.status === 'loading'
        ? 'Loading the valley profile…'
        : v.status === 'running'
          ? 'Routing the flood down the valley…'
          : v.status === 'ensemble'
            ? `Uncertainty ensemble ${v.progress?.done ?? 0} / ${v.progress?.total ?? 27}…`
            : v.status === 'error'
              ? `Could not run: ${v.error ?? 'unknown error'}`
              : v.error
                ? v.error
                : `${v.origin === 'baked' ? 'Calibrated result baked into the preset' : `Ran in ${v.ms !== null ? `${(v.ms / 1000).toFixed(1)} s` : '—'}`}${v.bands ? ' · 27-member ensemble' : ''}`,
    );
    toggleClass(statusText, 'dl-warn-text', v.status === 'error');
    inflowSeg.set(v.inflow);

    notes.replaceChildren(
      ...(v.result?.sourceInfo.notes ?? []).map((n) => h('li', { class: n.startsWith('warning') ? 'dl-chain-warn' : '' }, n.replace(/^warning: /, '⚠ '))),
    );

    const r = v.result;
    if (!r) {
      results.replaceChildren();
      setText(badge, v.status === 'error' ? 'error' : '…');
      badge.dataset.sev = v.status === 'error' ? 'warn' : 'info';
      return;
    }
    const eb = v.entryBand;
    // The headline number is the run that drives the map (the timeline and the inflow agree with it); the ensemble's
    // spread is under it: p10 / p50 / p90 over the 27 members (spec §I.5).
    const band = (b: [number, number, number], fmt: (x: number) => string) =>
      h('span', { class: 'dl-chain-band' }, `ensemble p10 / p50 / p90: ${b.map((x) => (Number.isFinite(x) ? fmt(x) : 'never')).join(' / ')}`);
    const pending = h('span', { class: 'dl-chain-band' }, v.status === 'ensemble' ? 'ensemble band: computing…' : 'no ensemble band');
    const when = (t: number) => formatWhen(clock, t);
    const rows: HTMLElement[] = [
      h(
        'div',
        { class: 'dl-chain-kv' },
        h('span', { class: 'dl-chain-k' }, 'Peak at the map edge'),
        h('span', { class: 'dl-chain-v' }, formatDischarge(r.entryPeak), provenanceBadge('modelled')),
        eb ? band(eb.qPeak, formatDischarge) : pending,
      ),
      h(
        'div',
        { class: 'dl-chain-kv' },
        h('span', { class: 'dl-chain-k' }, Number.isFinite(r.entryFront) ? `Front reaches the map (${formatSpan(r.entryFront)} after)` : 'Front reaches the map'),
        h('span', { class: 'dl-chain-v' }, Number.isFinite(r.entryFront) ? when(r.entryFront) : 'never', provenanceBadge('modelled')),
        eb ? band(eb.tFront, when) : pending.cloneNode(true) as HTMLElement,
      ),
      h(
        'div',
        { class: 'dl-chain-kv' },
        h('span', { class: 'dl-chain-k' }, 'Released at the source'),
        h('span', { class: 'dl-chain-v' }, fmtMm3(r.source.volume), provenanceBadge('modelled')),
        h('span', { class: 'dl-chain-band' }, `peak ${formatDischarge(r.source.peak)}`),
      ),
    ];
    results.replaceChildren(...rows);
    setText(badge, Number.isFinite(r.entryFront) ? `edge ${when(r.entryFront)}` : 'no flood');
    badge.dataset.sev = Number.isFinite(r.entryFront) ? 'info' : 'ok';
  }

  ctx.own(
    bridge.chainChanged.on((v) => {
      const show = !!v;
      visibleFns.forEach((fn) => fn(show));
      if (!v) {
        sceneKey = '';
        root.dataset.status = 'none';
        return;
      }
      // The controls are built once the profile is in (the clock zero comes with it).
      const key = `${v.sceneKey}|${!!v.file}`;
      if (key !== sceneKey) {
        sceneKey = key;
        if (v.file) build(v);
        else root.replaceChildren(statusText);
      }
      sync(v);
    }),
  );

  return {
    body: [root],
    badge,
    onVisible(fn) {
      visibleFns.push(fn);
      fn(!!bridge.chain);
    },
  };
}

function fmtMm3(v: number): string {
  return `${fmtNum(v / 1e6, v < 1e7 ? 1 : 0)} Mm³`;
}

/** Two significant figures for the volume slider (113 Mm³, 57 Mm³, 1.4 Mm³). */
function roundVolume(v: number): number {
  if (!(v > 0)) return 0;
  const p = 10 ** (Math.floor(Math.log10(v)) - 1);
  return Math.round(v / p) * p;
}
