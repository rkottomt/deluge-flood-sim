/**
 * Tool metadata shared by the toolbar, keyboard shortcuts and the tool controller (no DOM).
 */
import type { AppState, Store, ToolId } from '../contracts';
import { clamp } from './scales';

export interface BrushSpec {
  /** Label for the brush-size slider in the options card. */
  label: string;
  /** Ground meters. */
  min: number;
  max: number;
  default: number;
}

export interface ToolDef {
  id: ToolId;
  /** Keyboard shortcut (digit). */
  key: string;
  /** Short label (toolbar tooltip / options title). */
  label: string;
  /** One-line description of what the tool does. */
  description: string;
  /** Usage hints (mouse/keyboard), shown in the options card. */
  hints: string[];
  /** Brush size slider bound to state.brushRadius, if the tool uses one. */
  brush?: BrushSpec;
  /** Cursor ring color (linear RGB 0..1) for tools with a ring. */
  ringColor?: [number, number, number];
  /** Toolbar group index — a separator is drawn between groups. */
  group: number;
}

export const TOOLS: ToolDef[] = [
  {
    id: 'orbit',
    key: '1',
    label: 'Navigate',
    description: 'Drag the map to look around.',
    hints: ['Drag: look around', 'Right-drag: slide', 'Scroll: zoom'],
    group: 0,
  },
  {
    id: 'wall',
    key: '2',
    label: 'Build wall',
    description: 'Drag across the map to raise a levee or sandbag wall.',
    hints: ['Drag to draw', 'Shift-drag continues the last wall', 'Esc cancels'],
    brush: { label: 'Width', min: 4, max: 80, default: 14 },
    ringColor: [1.0, 0.72, 0.28],
    group: 1,
  },
  {
    id: 'eraseWall',
    key: '3',
    label: 'Erase walls',
    description: 'Drag over walls to remove them.',
    hints: ['Drag to erase', 'Right-drag to pan'],
    brush: { label: 'Radius', min: 5, max: 300, default: 30 },
    ringColor: [1.0, 0.36, 0.38],
    group: 1,
  },
  {
    id: 'inflow',
    key: '4',
    label: 'River inflow',
    description: 'Click to add a river inflow; click an existing one to remove it.',
    hints: ['Click to place', 'Click a source to remove'],
    brush: { label: 'Footprint radius', min: 10, max: 400, default: 40 },
    ringColor: [0.25, 0.66, 1.0],
    group: 2,
  },
  {
    id: 'storm',
    key: '5',
    label: 'Storm cell',
    description: 'Click to drop a localized cloudburst; click one to remove it.',
    hints: ['Click to place', 'Click a storm to remove'],
    brush: { label: 'Storm radius', min: 150, max: 6000, default: 1200 },
    ringColor: [0.62, 0.55, 1.0],
    group: 2,
  },
  {
    id: 'water',
    key: '6',
    label: 'Pour water',
    description: 'Hold on the map to pour water in; hold Shift to pump it out.',
    hints: ['Hold to pour', 'Shift + hold to drain'],
    brush: { label: 'Radius', min: 5, max: 500, default: 45 },
    ringColor: [0.3, 0.75, 1.0],
    group: 2,
  },
  {
    id: 'dig',
    key: '7',
    label: 'Dig / raise ground',
    description: 'Hold to dig a channel; hold Shift to pile up ground.',
    hints: ['Hold to dig', 'Shift + hold to raise'],
    brush: { label: 'Radius', min: 5, max: 400, default: 30 },
    ringColor: [0.85, 0.62, 0.38],
    group: 2,
  },
  {
    id: 'evac',
    key: '8',
    label: 'Evacuate',
    description: 'Click a home. A route is drawn to the nearest dry shelter and re-plans as roads flood.',
    hints: ['Click a street or house to set the start'],
    ringColor: [0.35, 0.9, 0.95],
    group: 3,
  },
  {
    id: 'shelter',
    key: '9',
    label: 'Shelter',
    description: 'Green pins on the map are safe high ground. Click to add one; click a pin to remove it.',
    hints: ['Click to place', 'Click a green pin to remove it'],
    ringColor: [0.3, 0.88, 0.55],
    group: 3,
  },
  {
    id: 'probe',
    key: '0',
    label: 'Measure',
    description: 'Hover the map to read how high the ground is and how deep the water is.',
    hints: ['Hover to measure', 'Drag to look around'],
    group: 4,
  },
];

export const TOOL_BY_ID: Record<ToolId, ToolDef> = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<
  ToolId,
  ToolDef
>;

export function toolForKey(key: string): ToolDef | undefined {
  return TOOLS.find((t) => t.key === key);
}

/**
 * Brush radius memory per tool. brushRadius is a single field in AppState, but a sensible storm radius
 * (km) is very different from a sensible water brush (tens of meters), so switching tools swaps in the
 * last radius used with that tool.
 */
const radiusMemory = new WeakMap<Store, Partial<Record<ToolId, number>>>();

export function selectTool(store: Store, tool: ToolId): void {
  const s = store.get();
  if (s.tool === tool) return;
  let mem = radiusMemory.get(store);
  if (!mem) radiusMemory.set(store, (mem = {}));
  const prevDef = TOOL_BY_ID[s.tool];
  if (prevDef?.brush) mem[s.tool] = s.brushRadius;
  const def = TOOL_BY_ID[tool];
  const patch: Partial<AppState> = { tool };
  if (def?.brush) {
    const r = mem[tool] ?? def.brush.default;
    patch.brushRadius = clamp(r, def.brush.min, def.brush.max);
  }
  store.set(patch);
}

/** Scale the brush radius by `factor`, clamped to the active tool's range. */
export function scaleBrush(store: Store, factor: number): void {
  const s = store.get();
  const def = TOOL_BY_ID[s.tool];
  const min = def?.brush?.min ?? 2;
  const max = def?.brush?.max ?? 6000;
  const next = clamp(s.brushRadius * factor, min, max);
  const rounded = next >= 100 ? Math.round(next / 5) * 5 : next >= 10 ? Math.round(next) : Math.round(next * 10) / 10;
  store.set({ brushRadius: clamp(rounded, min, max) });
}
