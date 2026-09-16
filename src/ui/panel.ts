/**
 * Right-hand collapsible control panel: Scenario, Weather & rivers, Evacuation, View, Advanced.
 */
import type { AppState, RouteResult, StageControl, WaterViewMode } from '../contracts';
import { h, setText, toggleClass, setAttr, shallowArrayEq, type UIContext } from './dom';
import { icon, type IconName } from './icons';
import { slider, segmented, toggleSwitch, button, confirmButton, kbd, type SliderMark } from './controls';
import {
  formatRain,
  formatInchesPerHour,
  formatStageFt,
  formatDischarge,
  formatDistance,
  formatDuration,
  formatBrush,
  fmtNum,
} from './format';
import {
  rainToT,
  tToRain,
  RAIN_TICKS,
  rainCategory,
  stageFt,
  offsetForFt,
  stageRangeFt,
  stageStatus,
  clamp,
  logToT,
  tToLog,
  manningDescription,
  MANNING_MIN,
  MANNING_MAX,
} from './scales';
import { legendBands, legendTitle } from './legend';
import { selectTool } from './toolDefs';
import { blockedAdvice, routeDetail } from './routeText';

export interface Panel {
  el: HTMLElement;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  toggle(): void;
  onChange(fn: () => void): void;
}

function section(
  title: string,
  iconName: IconName,
  body: HTMLElement[],
  opts: { open?: boolean; badge?: HTMLElement; id: string },
): HTMLElement {
  const bodyId = `dl-sec-${opts.id}`;
  const head = h(
    'button',
    { type: 'button', class: 'dl-sec-head', 'aria-expanded': String(opts.open ?? true), 'aria-controls': bodyId },
    h('span', { class: 'dl-sec-icon' }, icon(iconName, 17)),
    h('span', { class: 'dl-sec-title' }, title),
    opts.badge ?? null,
    h('span', { class: 'dl-sec-chev' }, icon('chevronDown', 16)),
  );
  const inner = h('div', { class: 'dl-sec-inner' }, h('div', { class: 'dl-sec-content' }, ...body));
  const wrap = h('div', { class: 'dl-sec-body', id: bodyId }, inner);
  const el = h('section', { class: `dl-sec${opts.open === false ? '' : ' dl-open'}`, 'data-section': opts.id }, head, wrap);
  head.addEventListener('click', () => {
    const open = !el.classList.contains('dl-open');
    el.classList.toggle('dl-open', open);
    head.setAttribute('aria-expanded', String(open));
  });
  return el;
}

const label = (text: string, extra?: HTMLElement | null) =>
  h('div', { class: 'dl-label-row' }, h('span', { class: 'dl-label' }, text), extra ?? null);

export function createPanel(ctx: UIContext): Panel {
  const { store, actions, bind } = ctx;

  // ════════════════════════════════ Scenario ════════════════════════════════
  const sceneName = h('div', { class: 'dl-scene-title' });
  const sceneMeta = h('div', { class: 'dl-scene-meta' });
  const story = h('p', { class: 'dl-story' });
  const storyMore = h('button', { type: 'button', class: 'dl-link dl-story-more' }, 'Read more');
  const storyWrap = h('div', { class: 'dl-story-wrap' }, story);
  storyMore.addEventListener('click', () => {
    const open = storyWrap.classList.toggle('dl-expanded');
    storyMore.textContent = open ? 'Show less' : 'Read more';
  });
  const restoreBtn = button('Restore scenario', () => actions.restoreScenario(), {
    icon: 'reset',
    tip: 'Put back the preset sources, storms, shelters, rain and river stage',
    side: 'top',
    className: 'dl-btn-sm dl-restore-btn',
  });

  bind(
    (s) => s.terrainName,
    (v) => setText(sceneName, v || 'No terrain loaded'),
  );
  bind(
    (s) => (s.grid ? `${s.grid.nx}|${s.grid.ny}|${s.grid.cellSize}` : ''),
    (key) => {
      const g = store.get().grid;
      if (!key || !g) return setText(sceneMeta, '');
      const km = (g.nx * g.cellSize) / 1000;
      setText(
        sceneMeta,
        `${g.nx} × ${g.ny} cells  ·  ${fmtNum(g.cellSize, g.cellSize < 10 ? 1 : 0)} m each  ·  ${fmtNum(km, km < 10 ? 1 : 0)} km square`,
      );
    },
  );
  bind(
    (s) => s.scenario,
    (sc) => {
      const text = sc?.description ?? '';
      setText(story, text);
      storyWrap.hidden = !text;
      storyMore.hidden = text.length < 190;
      storyWrap.classList.remove('dl-expanded');
      storyMore.textContent = 'Read more';
      restoreBtn.disabled = !sc;
    },
  );

  const presets = actions.listPresets();
  const presetList = h('div', { class: 'dl-presets', role: 'list' });
  const presetButtons = new Map<string, HTMLButtonElement>();
  let pendingPreset: string | null = null;
  for (const p of presets) {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'dl-preset',
        role: 'listitem',
        onclick: () => {
          if (store.get().loading) return;
          pendingPreset = p.id;
          syncPresets(store.get());
          actions.loadPreset(p.id).catch((err: unknown) => {
            store.set({ error: `Couldn't load ${p.name}: ${err instanceof Error ? err.message : String(err)}` });
          });
        },
      },
      h('span', { class: 'dl-preset-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'dl-preset-text' }, h('span', { class: 'dl-preset-name' }, p.name), h('span', { class: 'dl-preset-sub' }, p.subtitle)),
      h('span', { class: 'dl-spinner', 'aria-hidden': 'true' }),
    );
    presetButtons.set(p.id, b);
    presetList.append(b);
  }
  const syncPresets = (s: AppState) => {
    if (!s.loading) pendingPreset = null;
    for (const [id, b] of presetButtons) {
      toggleClass(b, 'dl-on', id === s.presetId && !pendingPreset);
      toggleClass(b, 'dl-busy', id === pendingPreset && !!s.loading);
      setAttr(b, 'aria-current', id === s.presetId ? 'true' : null);
      b.disabled = !!s.loading;
    }
  };
  bind((s) => `${s.presetId}|${!!s.loading}`, (_, s) => syncPresets(s));

  const pickBtn = h(
    'button',
    { type: 'button', class: 'dl-pick-location', onclick: () => ctx.setPanel('locationPicker', true) },
    h('span', { class: 'dl-pick-icon' }, icon('globe', 20)),
    h(
      'span',
      { class: 'dl-preset-text' },
      h('span', { class: 'dl-preset-name' }, 'Pick any US location…'),
      h('span', { class: 'dl-preset-sub' }, 'Live USGS elevation, imagery & roads'),
    ),
    h('span', { class: 'dl-pick-arrow' }, icon('chevronRight', 16)),
  );
  bind((s) => !!s.loading, (l) => (pickBtn.disabled = l));

  // Preset switcher: collapsed by default so the river & rain controls stay above the fold.
  const presetBlock = h('div', { class: 'dl-preset-block', id: 'dl-preset-block' }, presetList);
  const changeBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-change-scene',
      'aria-expanded': 'false',
      'aria-controls': 'dl-preset-block',
      'data-tip': 'Switch to another preset scenario',
      'data-tip-side': 'left',
    },
    h('span', null, 'Change'),
    icon('chevronDown', 14),
  );
  let presetsOpen = false;
  const setPresetsOpen = (open: boolean) => {
    presetsOpen = open;
    presetBlock.hidden = !open;
    changeBtn.setAttribute('aria-expanded', String(open));
    toggleClass(changeBtn, 'dl-on', open);
  };
  changeBtn.addEventListener('click', () => setPresetsOpen(!presetsOpen));
  setPresetsOpen(false);
  // With nothing loaded yet (or after a failed load) the list is the obvious next step.
  bind((s) => !s.terrainName && !s.loading, (empty) => {
    if (empty) setPresetsOpen(true);
  });

  const scenarioSec = section(
    'Scenario',
    'flag',
    [
      h('div', { class: 'dl-scene-card' }, h('div', { class: 'dl-scene-text' }, sceneName, sceneMeta), changeBtn),
      presetBlock,
      storyWrap,
      h('div', { class: 'dl-row dl-story-row' }, storyMore, h('span', { class: 'dl-flex' }), restoreBtn),
      pickBtn,
    ],
    { id: 'scenario' },
  );

  // ════════════════════════════════ Weather & rivers ════════════════════════════════
  const rainBadge = h('span', { class: 'dl-sec-badge' });
  const rain = slider({
    label: 'Rainfall',
    icon: 'rain',
    toPos: rainToT,
    fromPos: tToRain,
    format: formatRain,
    sub: (v) => rainCategory(v).label + (v > 0 ? ` · ${formatInchesPerHour(v)}` : ''),
    ticks: RAIN_TICKS,
    onInput: (v) => ctx.setSim({ rainRate: v }),
    tip: 'Uniform rain over the whole map (log scale)',
    keyStep: 0.03,
  });
  bind(
    (s) => s.sim.rainRate,
    (v) => {
      rain.set(v);
      const c = rainCategory(v);
      rain.setSubClass(c.severity);
      setText(rainBadge, v > 0 ? formatRain(v) : 'Dry');
      rainBadge.dataset.sev = c.severity;
    },
  );

  // Stage control: rebuilt only when the scenario changes.
  const stageSlot = h('div', { class: 'dl-stage-slot' });
  let stageSlider: ReturnType<typeof slider> | null = null;
  let stageReadout: HTMLElement | null = null;
  let stageChip: HTMLElement | null = null;
  let stageCtrl: StageControl | null = null;
  const jumpButtons: Array<{ b: HTMLButtonElement; ft: number }> = [];

  function buildStage(ctrl: StageControl | null) {
    stageCtrl = ctrl;
    jumpButtons.length = 0;
    stageSlot.replaceChildren();
    stageSlider?.destroy();
    stageSlider = null;
    stageSlot.hidden = !ctrl;
    if (!ctrl) return;
    const range = stageRangeFt(ctrl);
    const span = Math.max(1e-6, range.max - range.min);
    const toPos = (ft: number) => (ft - range.min) / span;
    const marks: SliderMark[] = [];
    if (ctrl.floodStageFt !== undefined) marks.push({ value: ctrl.floodStageFt, label: 'Flood stage', kind: 'warn' });
    for (const m of ctrl.marks ?? []) marks.push({ value: m.ft, label: m.label, kind: 'danger' });
    const inRange = marks.filter((m) => m.value >= range.min - 0.01 && m.value <= range.max + 0.01);

    stageSlider = slider({
      label: 'River stage',
      toPos,
      fromPos: (t) => Math.round((range.min + clamp(t, 0, 1) * span) * 10) / 10,
      format: formatStageFt,
      marks: inRange,
      ticks: inRange.map((m) => ({ value: m.value, label: `${fmtNum(m.value, m.value % 1 ? 1 : 0)}` })),
      onInput: (ft) => store.set({ stageOffset: clamp(offsetForFt(ctrl, ft), 0, ctrl.maxOffset) }),
      tip: 'Water level at the river gauge, in feet above gauge datum',
      keyStep: 0.01,
      className: 'dl-stage-slider',
    });
    stageChip = h('span', { class: 'dl-chip' });
    stageReadout = h('div', { class: 'dl-stage-gauge' }, icon('gauge', 14), h('span', null, ctrl.label));

    const jumps = h('div', { class: 'dl-jumps' });
    const addJump = (text: string, ft: number, kind: 'calm' | 'warn' | 'danger') => {
      const b = h(
        'button',
        {
          type: 'button',
          class: `dl-jump dl-jump-${kind}`,
          'data-tip': `Set the river to ${formatStageFt(ft)}`,
          'data-tip-side': 'top',
          onclick: () => store.set({ stageOffset: clamp(offsetForFt(ctrl, ft), 0, ctrl.maxOffset) }),
        },
        h('span', { class: 'dl-jump-dot' }),
        h('span', { class: 'dl-jump-label' }, text),
        h('span', { class: 'dl-jump-ft' }, `${fmtNum(ft, ft % 1 ? 1 : 0)} ft`),
      );
      jumpButtons.push({ b, ft });
      jumps.append(b);
    };
    addJump('Normal', range.min, 'calm');
    for (const m of inRange) addJump(m.label, m.value, m.kind === 'warn' ? 'warn' : 'danger');

    stageSlot.append(h('div', { class: 'dl-stage' }, stageReadout, stageSlider.el, h('div', { class: 'dl-row dl-row-status' }, stageChip), jumps));
    syncStage(store.get().stageOffset);
  }

  function syncStage(offset: number) {
    if (!stageCtrl || !stageSlider || !stageChip) return;
    const ft = stageFt(stageCtrl, offset);
    stageSlider.set(ft);
    const st = stageStatus(stageCtrl, ft);
    setText(stageChip, st.label);
    stageChip.dataset.sev = st.severity;
    for (const j of jumpButtons) toggleClass(j.b, 'dl-on', Math.abs(j.ft - ft) < 0.15);
  }
  bind((s) => s.scenario?.stage ?? null, (ctrl) => buildStage(ctrl));
  bind((s) => s.stageOffset, (v) => syncStage(v));

  // Sources & storms list.
  const sourcesCount = h('span', { class: 'dl-count' });
  const sourcesList = h('ul', { class: 'dl-sources' });
  const sourcesEmpty = h(
    'div',
    { class: 'dl-empty-hint' },
    'No inflows or storms yet. Use ',
    h('button', { type: 'button', class: 'dl-inline-tool', onclick: () => selectTool(store, 'inflow') }, icon('inflow', 13), 'Inflow ', kbd('4')),
    ' or ',
    h('button', { type: 'button', class: 'dl-inline-tool', onclick: () => selectTool(store, 'storm') }, icon('storm', 13), 'Storm ', kbd('5')),
    ' and click the map.',
  );
  bind(
    (s) => [s.sources, s.storms, s.grid, s.scenario] as const,
    ([sources, storms, grid]) => {
      // Rebuilt only when the lists themselves change (rare), never on the stats stream.
      sourcesList.replaceChildren();
      const cell = grid?.cellSize ?? 0;
      const row = (ic: IconName, kind: string, name: string, value: string, onRemove: () => void, tip: string) =>
        h(
          'li',
          { class: `dl-source dl-source-${kind}` },
          h('span', { class: 'dl-source-icon' }, icon(ic, 15)),
          h('span', { class: 'dl-source-name', title: name }, name),
          h('span', { class: 'dl-source-value' }, value),
          h(
            'button',
            { type: 'button', class: 'dl-remove', 'aria-label': `Remove ${name}`, 'data-tip': tip, 'data-tip-side': 'left', onclick: onRemove },
            icon('close', 14),
          ),
        );
      for (const src of sources) {
        if (src.type === 'inflow') {
          sourcesList.append(
            row('inflow', 'inflow', src.label ?? 'Inflow', formatDischarge(src.discharge), () => store.set({ sources: store.get().sources.filter((x) => x.id !== src.id) }), 'Remove inflow'),
          );
        } else {
          sourcesList.append(
            row(
              'gauge',
              'stage',
              src.label ?? 'River boundary',
              store.get().scenario?.stage ? 'follows stage' : 'fixed level',
              () => store.set({ sources: store.get().sources.filter((x) => x.id !== src.id) }),
              'Remove this river boundary (the river will drain)',
            ),
          );
        }
      }
      storms.forEach((st, i) => {
        const r = cell ? ` · ${formatBrush(st.radius * cell)}` : '';
        sourcesList.append(
          row('storm', 'storm', `Storm ${i + 1}`, `${formatRain(st.intensity)}${r}`, () => store.set({ storms: store.get().storms.filter((x) => x.id !== st.id) }), 'Remove storm'),
        );
      });
      const n = sources.length + storms.length;
      setText(sourcesCount, String(n));
      sourcesEmpty.hidden = n > 0;
      sourcesList.hidden = n === 0;
    },
    (a, b) => shallowArrayEq(a, b),
  );

  const weatherSec = section(
    'Weather & rivers',
    'rain',
    [rain.el, stageSlot, label('Water sources', sourcesCount), sourcesList, sourcesEmpty],
    { id: 'weather', badge: rainBadge },
  );

  // ════════════════════════════════ Evacuation ════════════════════════════════
  const evacBadge = h('span', { class: 'dl-sec-badge' });
  const evacCard = h('div', { class: 'dl-evac', 'aria-live': 'polite' });
  const setStartBtn = button('Set start', () => selectTool(store, 'evac'), { icon: 'evac', tip: 'Then click a home on the map', key: '8', side: 'top' });
  const shelterCount = h('span', { class: 'dl-btn-count' });
  const addShelterBtn = button(['Shelters', shelterCount], () => selectTool(store, 'shelter'), {
    icon: 'shelter',
    tip: 'Click the map to add a shelter on high ground; click one to remove it',
    key: '9',
    side: 'top',
  });
  const clearStartBtn = h(
    'button',
    {
      type: 'button',
      class: 'dl-btn dl-btn-subtle dl-btn-square',
      'aria-label': 'Clear the evacuation start point',
      'data-tip': 'Clear the start point',
      'data-tip-side': 'top',
      onclick: () => store.set({ evacStart: null }),
    },
    icon('close', 15),
  );

  function renderEvac(route: RouteResult | null, s: AppState) {
    const state = route?.state ?? 'none';
    evacCard.dataset.state = state;
    evacBadge.dataset.sev = state === 'ok' ? 'ok' : state === 'blocked' ? 'danger' : 'calm';
    setText(evacBadge, state === 'ok' ? 'Route OK' : state === 'blocked' ? 'Blocked' : s.evacStart ? 'Waiting' : 'Not set');
    if (state === 'ok' && route) {
      evacCard.replaceChildren(
        h('div', { class: 'dl-evac-top' }, icon('check', 18), h('span', null, 'Safe route found')),
        h('div', { class: 'dl-evac-dest' }, h('span', { class: 'dl-evac-to' }, 'to '), route.shelter?.name ?? 'nearest shelter'),
        h(
          'div',
          { class: 'dl-evac-metrics' },
          h('div', { class: 'dl-metric' }, h('span', { class: 'dl-metric-value' }, formatDistance(route.lengthMeters)), h('span', { class: 'dl-metric-label' }, 'Distance')),
          h('div', { class: 'dl-metric' }, h('span', { class: 'dl-metric-value' }, formatDuration(route.etaSeconds)), h('span', { class: 'dl-metric-label' }, 'Drive time')),
        ),
        ...((detail) => (detail ? [h('p', { class: 'dl-evac-msg' }, detail)] : []))(routeDetail(route.message, route.shelter?.name)),
      );
    } else if (state === 'blocked') {
      evacCard.replaceChildren(
        h('div', { class: 'dl-evac-alarm' }, icon('warning', 30), h('span', { class: 'dl-evac-alarm-text' }, 'NO SAFE ROUTE')),
        h('p', { class: 'dl-evac-msg' }, blockedAdvice(route?.message)),
      );
    } else if (s.evacStart) {
      evacCard.replaceChildren(
        h('div', { class: 'dl-evac-top dl-evac-wait' }, h('span', { class: 'dl-spinner dl-spin-on' }), h('span', null, 'Planning route…')),
        h('p', { class: 'dl-evac-msg' }, route?.message || (s.shelters.length ? 'Waiting for the next flood readback.' : 'Add at least one shelter to route to.')),
      );
    } else {
      evacCard.replaceChildren(
        h('div', { class: 'dl-evac-hint-icon' }, icon('route', 26)),
        h(
          'div',
          { class: 'dl-evac-hint' },
          h('strong', null, 'Plan an evacuation'),
          h('p', null, 'Choose ', h('b', null, 'Set start'), ' and click a home. Deluge drives the road network to the nearest shelter that is still dry — and re-plans live as streets go under.'),
        ),
      );
    }
  }
  bind(
    (s) => [s.route, s.evacStart, s.shelters.length] as const,
    ([route], s) => renderEvac(route, s),
    (a, b) => shallowArrayEq(a, b),
  );
  bind(
    (s) => s.evacStart,
    (v) => (clearStartBtn.disabled = !v),
  );
  bind(
    (s) => s.shelters.length,
    (n) => {
      setText(shelterCount, String(n));
      toggleClass(shelterCount, 'dl-zero', n === 0);
    },
  );

  const roadLegend = h(
    'div',
    { class: 'dl-road-legend', 'aria-label': 'Road status legend' },
    h('span', { class: 'dl-road dl-road-dry' }, h('i'), 'Dry'),
    h('span', { class: 'dl-road dl-road-wet', 'data-tip': '5–30 cm: passable, slow', 'data-tip-side': 'top' }, h('i'), 'Wet'),
    h('span', { class: 'dl-road dl-road-flooded', 'data-tip': '≥ 30 cm: cars float — impassable', 'data-tip-side': 'top' }, h('i'), 'Flooded'),
    h('span', { class: 'dl-road dl-road-route' }, h('i'), 'Route'),
  );

  const evacSec = section(
    'Evacuation',
    'route',
    [evacCard, h('div', { class: 'dl-evac-actions' }, setStartBtn, addShelterBtn, clearStartBtn), roadLegend],
    { id: 'evac', badge: evacBadge },
  );

  // ════════════════════════════════ View ════════════════════════════════
  const modeNames: Record<WaterViewMode, string> = { realistic: 'Realistic', depth: 'Depth', maxDepth: 'Max depth', velocity: 'Speed' };
  const viewBadge = h('span', { class: 'dl-sec-badge' });
  const modes = segmented<WaterViewMode>(
    [
      { value: 'realistic', label: 'Realistic', tip: 'Photoreal water' },
      { value: 'depth', label: 'Depth', tip: 'Hazard map of current depth' },
      { value: 'maxDepth', label: 'Max depth', tip: 'Deepest water reached since reset — the flood extent' },
      { value: 'velocity', label: 'Speed', tip: 'How fast the water moves' },
    ],
    (v) => ctx.setRender({ waterMode: v }),
    { label: 'Water display mode', className: 'dl-seg-full', tipSide: 'top' },
  );
  const legend = h('div', { class: 'dl-legend' });
  const renderLegend = (mode: WaterViewMode) => {
    if (mode === 'realistic') {
      legend.replaceChildren(
        h('div', { class: 'dl-legend-note' }, icon('eye', 14), h('span', null, 'Photoreal water. Switch to ', h('b', null, 'Depth'), ' or ', h('b', null, 'Speed'), ' for a hazard map.')),
      );
      return;
    }
    const bands = legendBands(mode) ?? [];
    const bar = h('div', { class: 'dl-legend-bar' }, ...bands.map((b) => h('span', { style: { background: b.color } })));
    const rows = h(
      'div',
      { class: 'dl-legend-rows' },
      ...bands.map((b) =>
        h('div', { class: 'dl-legend-row' }, h('i', { style: { background: b.color } }), h('span', { class: 'dl-legend-label' }, b.label), b.note ? h('span', { class: 'dl-legend-desc' }, b.note) : null),
      ),
    );
    const title = legendTitle(mode);
    legend.replaceChildren(h('div', { class: 'dl-legend-title' }, title), bar, rows);
  };
  bind(
    (s) => s.render.waterMode,
    (m) => {
      modes.set(m);
      renderLegend(m);
      setText(viewBadge, modeNames[m]);
    },
  );

  const exag = slider({
    label: 'Vertical exaggeration',
    icon: 'layers',
    toPos: (v) => (v - 1) / 4,
    fromPos: (t) => Math.round((1 + t * 4) * 10) / 10,
    format: (v) => `${fmtNum(v, 1)}×`,
    onInput: (v) => ctx.setRender({ verticalExaggeration: v }),
    tip: 'Stretch terrain heights to make relief easier to read',
    ticks: [
      { value: 1, label: 'True' },
      { value: 5, label: '5×' },
    ],
  });
  bind((s) => s.render.verticalExaggeration, (v) => exag.set(v));

  const tImagery = toggleSwitch('Aerial imagery', (on) => ctx.setRender({ showImagery: on }), { icon: 'globe' });
  const tRoads = toggleSwitch('Roads', (on) => ctx.setRender({ showRoads: on }), { icon: 'route' });
  const tContours = toggleSwitch('Contours', (on) => ctx.setRender({ showContours: on }), { icon: 'layers' });
  bind((s) => s.render.showImagery, (v) => tImagery.set(v));
  bind((s) => s.render.showRoads, (v) => tRoads.set(v));
  bind((s) => s.render.showContours, (v) => tContours.set(v));

  const viewSec = section(
    'View',
    'eye',
    [
      modes.el,
      legend,
      exag.el,
      h('div', { class: 'dl-switches' }, tImagery.el, tRoads.el, tContours.el),
      h(
        'div',
        { class: 'dl-row dl-row-2' },
        button('Frame all', () => actions.cameraFrameAll(), { icon: 'frame', key: 'F', tip: 'Fit the whole area in view', side: 'top' }),
        button('Top-down', () => actions.cameraTopDown(), { icon: 'topDown', key: 'T', tip: 'Look straight down', side: 'top' }),
      ),
    ],
    { id: 'view', badge: viewBadge },
  );

  // ════════════════════════════════ Advanced ════════════════════════════════
  const manning = slider({
    label: "Manning's n",
    toPos: (v) => logToT(v, MANNING_MIN, MANNING_MAX),
    fromPos: (t) => Math.round(tToLog(t, MANNING_MIN, MANNING_MAX) * 1000) / 1000,
    format: (v) => fmtNum(v, 3),
    sub: manningDescription,
    onInput: (v) => ctx.setSim({ manningN: v }),
    tip: 'Surface roughness: higher = more friction, slower water',
  });
  bind((s) => s.sim.manningN, (v) => manning.set(v));

  const infil = slider({
    label: 'Infiltration & drains',
    toPos: (v) => Math.sqrt(clamp(v, 0, 60) / 60),
    fromPos: (t) => Math.round(t * t * 60 * 2) / 2,
    format: formatRain,
    sub: (v) => (v === 0 ? 'none' : v < 5 ? 'clay / pavement' : v < 20 ? 'loam soil' : 'sand / storm drains'),
    onInput: (v) => ctx.setSim({ infiltrationRate: v }),
    tip: 'Water soaked into the ground or carried away by drains',
  });
  bind((s) => s.sim.infiltrationRate, (v) => infil.set(v));

  const boundary = segmented<'open' | 'wall'>(
    [
      { value: 'open', label: 'Open edges', tip: 'Water flows out of the map' },
      { value: 'wall', label: 'Closed box', tip: 'Edges reflect water (closed basin)' },
    ],
    (v) => ctx.setSim({ boundary: v }),
    { label: 'Domain boundary', className: 'dl-seg-full', tipSide: 'top' },
  );
  bind((s) => s.sim.boundary, (v) => boundary.set(v));

  const cfl = slider({
    label: 'Courant number (CFL)',
    toPos: (v) => (v - 0.1) / 0.9,
    fromPos: (t) => Math.round((0.1 + t * 0.9) * 100) / 100,
    format: (v) => fmtNum(v, 2),
    sub: (v) => (v > 0.9 ? 'aggressive' : v < 0.4 ? 'cautious' : 'balanced'),
    onInput: (v) => ctx.setSim({ cfl: v }),
    tip: 'Fraction of a cell a wave may cross per step. Smaller = more substeps',
  });
  const substeps = slider({
    label: 'Max substeps / frame',
    toPos: (v) => logToT(v, 4, 400),
    fromPos: (t) => Math.round(tToLog(t, 4, 400)),
    format: (v) => fmtNum(v, 0),
    onInput: (v) => ctx.setSim({ maxSubstepsPerFrame: v }),
    tip: 'Upper bound on solver work per rendered frame (keeps the UI responsive)',
  });
  bind((s) => s.sim.maxSubstepsPerFrame, (v) => substeps.set(v));

  const breakIt = toggleSwitch('Stability demo (naive solver)', (on) => actions.setStabilityDemo(on), {
    icon: 'bolt',
    tip: 'Switch to a textbook explicit scheme and watch it blow up',
  });
  breakIt.el.classList.add('dl-switch-danger');
  bind(
    (s) => [s.sim.stabilityMode, s.sim.cfl] as const,
    ([mode, c]) => {
      breakIt.set(mode === 'naive');
      cfl.set(c);
      cfl.setDisabled(mode === 'naive');
    },
    (a, b) => shallowArrayEq(a, b),
  );

  const gpu = h('div', { class: 'dl-gpu' }, icon('gpu', 14), h('span'));
  bind((s) => s.gpuInfo, (v) => setText(gpu.lastChild as HTMLElement, v || 'GPU: unknown'));

  const advancedSec = section(
    'Advanced',
    'sliders',
    [
      manning.el,
      infil.el,
      label('Map edges'),
      boundary.el,
      cfl.el,
      substeps.el,
      breakIt.el,
      h(
        'div',
        { class: 'dl-row dl-row-2' },
        confirmButton('Clear walls', 'Click to confirm', () => actions.clearWalls(), { icon: 'trash', tip: 'Remove every wall you built' }),
        confirmButton('Reset all', 'Click to confirm', () => actions.resetAll(), { icon: 'reset', variant: 'danger', tip: 'Reset water and undo all terrain edits' }),
      ),
      gpu,
    ],
    { id: 'advanced', open: false },
  );

  // ════════════════════════════════ Shell ════════════════════════════════
  const attribution = h('div', { class: 'dl-attribution' });
  bind((s) => s.attribution, (v) => {
    setText(attribution, v);
    attribution.hidden = !v;
  });

  const scroller = h('div', { class: 'dl-panel-scroll' }, scenarioSec, weatherSec, evacSec, viewSec, advancedSec, attribution);
  const closeBtn = h(
    'button',
    { type: 'button', class: 'dl-icon-btn dl-panel-close', 'aria-label': 'Hide panel', onclick: () => api.setOpen(false) },
    icon('close', 16),
  );
  const el = h('aside', { class: 'dl-panel dl-glass', 'aria-label': 'Simulation controls' }, closeBtn, scroller);

  const narrow = window.matchMedia('(max-width: 1100px)');
  let open = !narrow.matches;
  const listeners = new Set<() => void>();
  const api: Panel = {
    el,
    isOpen: () => open,
    setOpen(v: boolean) {
      open = v;
      toggleClass(el, 'dl-closed', !open);
      el.inert = !open;
      listeners.forEach((fn) => fn());
    },
    toggle() {
      api.setOpen(!open);
    },
    onChange(fn) {
      listeners.add(fn);
    },
  };
  narrow.addEventListener('change', (e) => api.setOpen(!e.matches));
  api.setOpen(open);
  return api;
}

