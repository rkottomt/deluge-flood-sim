/**
 * Left toolbar (vertical tool buttons with shortcut badges) + the contextual options card for the
 * active tool (wall height, brush size, discharge, storm intensity, usage hints).
 */
import type { ToolId } from '../contracts';
import { h, setText, toggleClass, setAttr, type UIContext } from './dom';
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
      if (tool === 'wall') controls.append(wallHeight.el);
      if (tool === 'inflow') controls.append(discharge.el);
      if (tool === 'storm') controls.append(storm.el);
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
