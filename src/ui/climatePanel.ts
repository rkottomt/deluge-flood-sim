/**
 * "Future climate" in Weather & rivers: Today / 2050 / 2080 / 2100 × SSP2-4.5 / SSP5-8.5 (and the extreme-rain scaling
 * rate), with every multiplier it applies, the numbers it changes on this map and where each comes from.
 *
 * The selection lives in the store (AppState.climate); the app applies it as a layer on what the solver receives
 * (src/app/climate.ts), so the rain slider, the inflow list and the stage slider above keep showing TODAY's values —
 * this block is where the modified ones are spelled out.
 */
import type { AppState, WaterSource } from '../contracts';
import {
  CLIMATE_SOURCES,
  CLIMATE_TODAY,
  climateForcing,
  inflowScaled,
  PATHWAY_LABELS,
  RAIN_SCALING,
  type ClimateForcing,
  type ClimateHorizon,
  type ClimatePathway,
  type ClimateSelection,
  type RainScaling,
} from '../climate';
import { bridgeFor } from './bridge';
import { segmented } from './controls';
import { h, setText, shallowArrayEq, type UIContext } from './dom';
import { fmtNum, formatDischarge, formatRain } from './format';

export interface ClimateItem {
  key: 'warming' | 'rain' | 'inflow' | 'sea' | 'stage' | 'lake' | 'melt' | 'note';
  label: string;
  value: string;
  /** Applied to the simulation (true) or shown for context only (false). */
  applied: boolean;
  sources: string[];
}

const pct = (k: number) => `${k >= 1 ? '+' : '−'}${fmtNum(Math.abs(k - 1) * 100, 0)} %`;
const times = (k: number) => `× ${fmtNum(k, 2)}`;
const degrees = (t: number) => `${t >= 0 ? '+' : '−'}${fmtNum(Math.abs(t), 1)} °C`;

/** The lines the block shows for a forcing on the current scenario (pure; tested). */
export function climateItems(
  f: ClimateForcing,
  s: Pick<AppState, 'sources' | 'storms'> & { sim: { rainRate: number } },
  chainStatus: string | null = null,
): ClimateItem[] {
  if (f.identity) return [];
  const out: ClimateItem[] = [];
  const w = f.warming;
  out.push({
    key: 'warming',
    label: 'Warming since 1995–2014',
    value: `${degrees(w.best)} global (${fmtNum(w.lo, 1)}–${fmtNum(w.hi, 1)}) · ≈ ${degrees(f.localWarming)} ${f.region.name}`,
    applied: false,
    sources: ['ar6Ch4', f.region.source],
  });
  const sc = RAIN_SCALING[f.selection.scaling];
  const rainParts: string[] = [`${times(f.rainMult)} (${pct(f.rainMult)}; ${fmtNum(f.rainMultRange[0], 2)}–${fmtNum(f.rainMultRange[1], 2)})`];
  if (s.sim.rainRate > 0) rainParts.push(`rain ${formatRain(s.sim.rainRate)} → ${formatRain(s.sim.rainRate * f.rainMult)}`);
  const peak = s.storms.reduce((m, st) => Math.max(m, st.intensity), 0);
  if (peak > 0) rainParts.push(`storm peak ${formatRain(peak)} → ${formatRain(peak * f.rainMult)}`);
  out.push({
    key: 'rain',
    label: `Rain & storm cells (${sc.label} × ${fmtNum(w.best, 1)} °C)`,
    value: rainParts.join(' · '),
    applied: true,
    sources: sc.sources,
  });
  const inflows = s.sources.filter((x): x is WaterSource & { type: 'inflow' } => x.type === 'inflow');
  if (f.chainInflows) {
    if (inflows.length) out.push({ key: 'inflow', label: 'Inflow', value: 'the hazard chain’s wave — not rain-fed, not rain-scaled', applied: false, sources: [] });
  } else if (inflows.length) {
    const scaled = inflows.filter((x) => inflowScaled(f, x));
    const fixed = inflows.filter((x) => !inflowScaled(f, x));
    const parts: string[] = [];
    if (scaled.length) {
      parts.push(times(f.inflowMult));
      for (const x of scaled.slice(0, 2)) parts.push(`${shortName(x)} ${formatDischarge(x.discharge)} → ${formatDischarge(x.discharge * f.inflowMult)}`);
    }
    if (fixed.length) parts.push(`not scaled: ${fixed.map(shortName).join(', ')}`);
    out.push({ key: 'inflow', label: 'Rain-fed inflows (scaled like the rain)', value: parts.join(' · '), applied: scaled.length > 0, sources: scaled.length ? sc.sources : [] });
  }
  if (f.seaGauge) {
    out.push({
      key: 'sea',
      label: `Sea level at ${f.seaGauge.name}`,
      value: `+${fmtNum(f.seaRiseM, 2)} m (${fmtNum(f.seaRiseM / 0.3048, 1)} ft) since 2000 — NOAA ${f.seaScenario}; added to the sea boundary on top of the stage slider`,
      applied: f.seaRiseM > 0,
      sources: [f.seaGauge.source],
    });
  }
  if (f.riverStageUnscaled) {
    out.push({ key: 'stage', label: 'River stage', value: 'not scaled: a stage is the hydraulics’ answer, not a forcing — set it with the slider', applied: false, sources: [] });
  }
  if (f.lake) {
    const L = f.lake;
    out.push({
      key: 'lake',
      label: `${L.lake.name} (${L.lake.sourceText} trend)`,
      value: `area ${fmtNum(L.lake.area0, 2)} → ${fmtNum(L.area, 2)} km² (${times(L.areaFactor)}) · volume ${times(L.volumeFactor)} (V–A) · chain ${chainStatus === 'ready' ? 're-run' : chainStatus ? `re-running (${chainStatus})` : 're-run'}`,
      applied: true,
      sources: [L.lake.source, 'huggel2002'],
    });
  }
  if (f.meltPerDay != null) {
    out.push({
      key: 'melt',
      label: 'Glacier melt (degree-day, clean ice)',
      value: `+${fmtNum(f.meltPerDay, 0)} mm w.e./day in the melt season — context only: a slow forcing, not part of the flood`,
      applied: false,
      sources: [],
    });
  }
  if (f.note) out.push({ key: 'note', label: 'Here', value: f.note, applied: false, sources: [] });
  return out;
}

function shortName(src: WaterSource): string {
  const label = src.label ?? src.id;
  return label.replace(/\s*\(.*\)\s*$/, '').replace(/\s+inflow$/i, '').slice(0, 40);
}

/** One line under the rain slider while a future climate is on: the slider shows today's rain, the map gets more. */
export function createClimateNote(ctx: UIContext): HTMLElement {
  const el = h('p', { class: 'dl-climate-note', 'data-climate': 'note-line', hidden: true });
  ctx.bind(
    (s) => [s.climate, s.presetId, !!s.scenario?.hazardChain] as const,
    (_, s) => {
      const f = climateForcing(s.climate, s.presetId, s.scenario);
      el.hidden = f.identity;
      const sea = f.seaRiseM > 0 ? ` · sea +${fmtNum(f.seaRiseM, 2)} m` : '';
      setText(el, f.identity ? '' : `Future climate ${f.label}: the map gets rain ${times(f.rainMult)}${sea} — the sliders show today (details under Future climate below)`);
    },
    (a, b) => shallowArrayEq(a, b),
  );
  return el;
}

export function createClimateBlock(ctx: UIContext): HTMLElement {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  const sel = (): ClimateSelection => store.get().climate ?? { ...CLIMATE_TODAY };
  const patch = (p: Partial<ClimateSelection>) => store.set({ climate: { ...sel(), ...p } });

  const badge = h('span', { class: 'dl-chip dl-climate-badge', 'data-climate': 'badge' });
  const horizon = segmented<ClimateHorizon>(
    [
      { value: 'today', label: 'Today', tip: 'The scenario as it ships: its storms, inflows and tide levels come from the record of recent decades' },
      { value: '2050', label: '2050', tip: 'AR6 2041–2060 warming' },
      { value: '2080', label: '2080', tip: 'Between AR6’s 2041–2060 and 2081–2100 (interpolated)' },
      { value: '2100', label: '2100', tip: 'AR6 2081–2100 warming' },
    ],
    (v) => patch({ horizon: v }),
    { label: 'Climate horizon', className: 'dl-seg-full', tipSide: 'top' },
  );
  const pathway = segmented<ClimatePathway>(
    [
      { value: 'ssp245', label: 'SSP2-4.5 · middle', tip: PATHWAY_LABELS.ssp245.long },
      { value: 'ssp585', label: 'SSP5-8.5 · high', tip: PATHWAY_LABELS.ssp585.long },
    ],
    (v) => patch({ pathway: v }),
    { label: 'Emissions pathway', className: 'dl-seg-full', tipSide: 'top' },
  );
  const scaling = segmented<RainScaling>(
    (['cc', 'super10', 'super14'] as const).map((k) => ({ value: k, label: RAIN_SCALING[k].label, tip: RAIN_SCALING[k].note })),
    (v) => patch({ scaling: v }),
    { label: 'Extreme-rain scaling', className: 'dl-seg-full dl-climate-scaling', tipSide: 'top' },
  );
  for (const [k, b] of horizon.buttons) b.dataset.climateHorizon = k;
  for (const [k, b] of pathway.buttons) b.dataset.climatePathway = k;
  const futureRows = h('div', { class: 'dl-climate-future' }, pathway.el, h('div', { class: 'dl-climate-sub' }, 'Extreme-rain scaling'), scaling.el);
  const list = h('ul', { class: 'dl-climate-items', 'data-climate': 'items' });
  const fine = h('p', { class: 'dl-impact-fine dl-climate-fine' });
  const cites = h('details', { class: 'dl-impact-methods dl-climate-cites' }, h('summary', null, 'Sources'));
  cites.append(
    h(
      'ol',
      null,
      ...Object.values(CLIMATE_SOURCES).map((c) => h('li', null, c.text, ' ', h('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, 'link'))),
    ),
  );

  let chainStatus: string | null = bridge.chain?.status ?? null;

  function render(s: AppState) {
    const cur = s.climate ?? CLIMATE_TODAY;
    const f = climateForcing(cur, s.presetId, s.scenario);
    horizon.set(cur.horizon);
    pathway.set(cur.pathway);
    scaling.set(cur.scaling);
    futureRows.hidden = f.identity;
    setText(badge, f.label);
    badge.dataset.sev = f.identity ? 'ok' : 'warn';
    badge.dataset.climateRain = f.rainMult.toFixed(3);
    const items = climateItems(f, s, chainStatus);
    list.replaceChildren(
      ...items.map((it) =>
        h(
          'li',
          {
            class: `dl-climate-item${it.applied ? ' dl-applied' : ''}`,
            'data-climate': it.key,
            'data-tip': it.sources.map((k) => CLIMATE_SOURCES[k]?.text).filter(Boolean).join(' · ') || null,
            'data-tip-side': 'left',
          },
          h('span', { class: 'dl-climate-label' }, it.label, it.applied ? h('span', { class: 'dl-climate-tag' }, 'applied') : null),
          h('span', { class: 'dl-climate-value' }, it.value),
        ),
      ),
    );
    list.hidden = items.length === 0;
    setText(
      fine,
      f.identity
        ? 'Today = the scenario as it ships. Pick a horizon to scale this map’s forcing to a future climate (IPCC AR6 warming, NOAA 2022 sea level).'
        : 'Forcing-scaled, not downscaled projections: today’s event with its rain, rain-fed inflows and sea level scaled by published sensitivities; the solver makes the flood. The sliders above still show today’s values. Return periods are not shifted.',
    );
  }

  ctx.bind(
    (s) => [s.climate, s.presetId, s.sim.rainRate, s.sources, s.storms, !!s.scenario?.hazardChain] as const,
    (_, s) => render(s),
    (a, b) => shallowArrayEq(a, b),
  );
  ctx.own(
    bridge.chainChanged.on((v) => {
      const st = v?.status ?? null;
      if (st === chainStatus) return;
      chainStatus = st;
      render(store.get());
    }),
  );

  return h(
    'div',
    { class: 'dl-climate', 'data-section-part': 'climate' },
    h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, 'Future climate'), badge),
    horizon.el,
    futureRows,
    list,
    fine,
    cites,
  );
}
