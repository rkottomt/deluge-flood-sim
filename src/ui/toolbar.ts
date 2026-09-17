/**
 * Left toolbar (vertical tool buttons with shortcut badges) + the contextual options card for the
 * active tool (wall height, brush size, discharge, storm intensity, usage hints).
 */
import type { AppState, ToolId } from '../contracts';
import { h, setText, toggleClass, setAttr, type UIContext } from './dom';
import { bridgeFor, type HoverInfo } from './bridge';
import { checkWall, stageSurface } from './wallCheck';
import { MAX_SOURCES, MAX_STORMS } from './tools';
import { icon, type IconName } from './icons';
import { slider, kbd } from './controls';
import { TOOLS, TOOL_BY_ID, selectTool } from './toolDefs';
import { formatBrush, formatDischarge, formatCfs, formatRain, formatMeters, formatFeet } from './format';
import {
  logToT,
  tToLog,
  niceRound,
  brushToT,
  tToBrush,
  clamp,
  DISCHARGE_MIN,
  DISCHARGE_MAX,
  DISCHARGE_TICKS,
  STORM_MIN,
  STORM_MAX,
  STORM_TICKS,
  rainCategory,
} from './scales';

const TOOL_ICONS: Record<ToolId, IconName> = {
  orbit: 'orbit',
  wall: 'wall',
  eraseWall: 'eraseWall',
  inflow: 'inflow',
  storm: 'storm',
  water: 'water',
  dig: 'dig',
  evac: 'evac',
  shelter: 'shelter',
  probe: 'probe',
};

export function toolIcon(id: ToolId): IconName {
  return TOOL_ICONS[id];
}

export function createToolbar(ctx: UIContext): { toolbar: HTMLElement; options: HTMLElement } {
  const { store, bind } = ctx;

  // ── Toolbar ──
  const toolbar = h('nav', { class: 'dl-toolbar dl-glass', 'aria-label': 'Tools', role: 'toolbar', 'aria-orientation': 'vertical' });
  const buttons = new Map<ToolId, HTMLButtonElement>();
  let group = -1;
  for (const def of TOOLS) {
    if (group !== -1 && def.group !== group) toolbar.append(h('div', { class: 'dl-tool-sep', 'aria-hidden': 'true' }));
    group = def.group;
    const b = h(
      'button',
      {
        type: 'button',
        class: 'dl-tool',
        'aria-label': `${def.label} (${def.key})`,
        'aria-pressed': 'false',
        'data-tip': def.label,
        'data-tip-key': def.key,
        'data-tip-side': 'right',
        'data-tool': def.id,
        onclick: () => selectTool(store, def.id),
      },
      icon(TOOL_ICONS[def.id], 21),
      h('span', { class: 'dl-tool-key', 'aria-hidden': 'true' }, def.key),
    );
    buttons.set(def.id, b);
    toolbar.append(b);
  }
  bind(
    (s) => s.tool,
    (tool) => {
      for (const [id, b] of buttons) {
        const on = id === tool;
        toggleClass(b, 'dl-on', on);
        setAttr(b, 'aria-pressed', String(on));
      }
    },
  );

  // ── Options card ──
  const title = h('span', { class: 'dl-opt-title-text' });
  const titleIcon = h('span', { class: 'dl-opt-icon' });
  const titleKey = kbd('1');
  const desc = h('p', { class: 'dl-opt-desc' });
  const hints = h('div', { class: 'dl-opt-hints' });
  const controls = h('div', { class: 'dl-opt-controls' });

  const wallHeight = slider({
    label: 'Height',
    toPos: (v) => (v - 0.5) / 9.5,
    fromPos: (t) => Math.round((0.5 + t * 9.5) * 10) / 10,
    format: (v) => formatMeters(v, 1),
    sub: (v) => formatFeet(v, 0),
    ticks: [
      { value: 1, label: 'Sandbags' },
      { value: 4, label: 'Levee' },
      { value: 9, label: 'Floodwall' },
    ],
    onInput: (v) => store.set({ wallHeight: v }),
    tip: 'Height of new walls above the ground',
  });
  bind((s) => s.wallHeight, (v) => wallHeight.set(v));

  // Live "will it hold?" check under the cursor: the wall's top vs the river stage / the water already here.
  const checkIcon = h('span', { class: 'dl-wall-check-icon' });
  const checkText = h('span', { class: 'dl-wall-check-text' });
  const checkFix = h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-xs dl-wall-fix', hidden: true });
  const wallCheck = h('div', { class: 'dl-wall-check', 'aria-live': 'polite' }, checkIcon, checkText, checkFix);
  const wallTip = h('p', { class: 'dl-opt-note' }, 'Tie both ends into high ground — water runs around open ends.');
  let suggested = 0;
  checkFix.addEventListener('click', () => suggested > 0 && store.set({ wallHeight: suggested }));
  let checkIconKind = '';
  const setCheckIcon = (kind: string) => {
    if (kind === checkIconKind) return;
    checkIconKind = kind;
    checkIcon.replaceChildren(icon(kind === 'ok' ? 'check' : kind === 'low' ? 'warning' : 'gauge', 14));
  };
  const renderWallCheck = (hov: HoverInfo | null, s: AppState) => {
    const level = stageSurface(s.scenario?.stage, s.stageOffset);
    const res = hov
      ? checkWall({ ground: hov.ground, barrier: hov.barrier, depth: hov.depth, wallHeight: s.wallHeight, stageLevel: level })
      : null;
    checkFix.hidden = true;
    if (!res) {
      wallCheck.dataset.state = 'idle';
      setCheckIcon('idle');
      setText(
        checkText,
        level !== null ? `River set to ${level.toFixed(1)} m — hover the map to check this height` : 'Hover water or a riverbank to check this height',
      );
      return;
    }
    const what = res.source === 'river' ? 'the river' : 'the water here';
    const m = Math.abs(res.margin);
    wallCheck.dataset.state = res.ok ? 'ok' : 'low';
    setCheckIcon(res.ok ? 'ok' : 'low');
    if (res.ok) {
      setText(checkText, `Holds: top ${res.top.toFixed(1)} m is ${m.toFixed(1)} m above ${what} (${res.surface.toFixed(1)} m)`);
    } else if (res.tooLow) {
      setText(checkText, `Overtopped: ground ${res.ground.toFixed(1)} m is too far below ${what} (${res.surface.toFixed(1)} m) for any wall — build on higher ground`);
    } else {
      setText(checkText, `Overtopped: top ${res.top.toFixed(1)} m is ${m.toFixed(1)} m below ${what} (${res.surface.toFixed(1)} m)`);
      suggested = res.suggested;
      setText(checkFix, `Use ${formatMeters(res.suggested, 1)}`);
      checkFix.hidden = false;
    }
  };
  const bridge = bridgeFor(store);
  ctx.own(bridge.hoverChanged.on((hov) => store.get().tool === 'wall' && renderWallCheck(hov, store.get())));
  bind(
    (s) => `${s.tool}|${s.wallHeight}|${s.stageOffset}|${s.scenario === null}`,
    (_k, s) => s.tool === 'wall' && renderWallCheck(bridge.hover, s),
  );

  // Placement limits for click tools.
  const limitLine = h('div', { class: 'dl-opt-limit' });
  bind(
    (s) => `${s.tool}|${s.sources.length}|${s.storms.length}`,
    (_k, s) => {
      const isStorm = s.tool === 'storm';
      const n = isStorm ? s.storms.length : s.sources.length;
      const max = isStorm ? MAX_STORMS : MAX_SOURCES;
      const full = n >= max;
      toggleClass(limitLine, 'dl-full', full);
      setText(
        limitLine,
        full
          ? `${n}/${max} ${isStorm ? 'storm cells' : 'sources'} — limit reached, click one to remove it`
          : `${n}/${max} ${isStorm ? 'storm cells' : 'water sources'}${isStorm ? '' : ' (river boundaries included)'}`,
      );
    },
  );

  // Brush slider range depends on the tool; re-created when the tool changes (cheap, rare).
  let brush: ReturnType<typeof slider> | null = null;
  const brushSlot = h('div', { class: 'dl-brush-slot' });

  const discharge = slider({
    label: 'Discharge',
    toPos: (v) => logToT(v, DISCHARGE_MIN, DISCHARGE_MAX),
    fromPos: (t) => niceRound(tToLog(t, DISCHARGE_MIN, DISCHARGE_MAX)),
    format: formatDischarge,
    sub: formatCfs,
    ticks: DISCHARGE_TICKS,
    onInput: (v) => store.set({ inflowDischarge: clamp(v, DISCHARGE_MIN, DISCHARGE_MAX) }),
    tip: 'Flow rate of new inflow sources (log scale)',
  });
  bind((s) => s.inflowDischarge, (v) => discharge.set(v));

  const storm = slider({
    label: 'Intensity',
    toPos: (v) => logToT(v, STORM_MIN, STORM_MAX),
    fromPos: (t) => niceRound(tToLog(t, STORM_MIN, STORM_MAX)),
    format: formatRain,
    sub: (v) => rainCategory(v).label.replace(' rain', ''),
    ticks: STORM_TICKS,
    onInput: (v) => store.set({ stormIntensity: clamp(v, STORM_MIN, STORM_MAX) }),
    tip: 'Peak rain rate at the storm center (log scale)',
  });
  bind((s) => s.stormIntensity, (v) => storm.set(v));

  const options = h(
    'section',
    { class: 'dl-options dl-glass', 'aria-live': 'polite', 'aria-label': 'Tool options' },
    h('div', { class: 'dl-opt-title' }, titleIcon, title, titleKey),
    desc,
    controls,
    hints,
  );

  bind(
    (s) => s.tool,
    (tool) => {
      const def = TOOL_BY_ID[tool];
      if (!def) return;
      titleIcon.replaceChildren(icon(TOOL_ICONS[tool], 16));
      setText(title, def.label);
      setText(titleKey, def.key);
      setText(desc, def.description);
      hints.replaceChildren(...def.hints.map((t) => h('span', { class: 'dl-hint' }, t)));
      options.dataset.tool = tool;

      controls.replaceChildren();
      toggleClass(options, 'dl-compact', tool === 'orbit');
      if (tool === 'wall') controls.append(wallHeight.el, wallCheck);
      if (tool === 'inflow') controls.append(discharge.el);
      if (tool === 'storm') controls.append(storm.el);
      brush?.destroy();
      if (def.brush) {
        const spec = def.brush;
        brush = slider({
          label: spec.label,
          toPos: (v) => brushToT(v, spec.min, spec.max),
          fromPos: (t) => tToBrush(t, spec.min, spec.max),
          format: formatBrush,
          sub: (v) => {
            const g = store.get().grid;
            if (!g) return '';
            const cells = tool === 'wall' ? Math.max(1.5, v / g.cellSize) : v / g.cellSize;
            return `${cells >= 10 ? Math.round(cells) : cells.toFixed(1)} cells`;
          },
          onInput: (v) => store.set({ brushRadius: v }),
          tip: tool === 'wall' ? 'Wall thickness on the ground  ·  [ and ] to resize' : 'Brush radius on the ground  ·  [ and ] to resize',
        });
        brushSlot.replaceChildren(brush.el);
        brush.set(store.get().brushRadius);
        controls.append(brushSlot);
      } else {
        brush = null;
      }
      if (tool === 'wall') controls.append(wallTip);
      if (tool === 'inflow' || tool === 'storm') controls.append(limitLine);
      toggleClass(controls, 'dl-empty', controls.childElementCount === 0);
    },
  );
  bind(
    (s) => s.brushRadius,
    (v) => brush?.set(v),
  );
  bind(
    (s) => s.grid,
    () => brush?.set(store.get().brushRadius),
  );

  return { toolbar, options };
}
