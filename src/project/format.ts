/**
 * The Deluge project file, `<name>.deluge.json` — format "deluge-project", version 1.
 *
 * A project is everything needed to put a piece of work back on screen: the scene, the user's changes to its scenario,
 * the walls / levees and terrain edits, the Site check sites and settings, the ensemble settings, the camera and the
 * water view, and — opt-in — the portfolio CSV and the latest design comparison's numbers. It is plain JSON written by
 * this tab (download) and read back by this tab (file input, or a `?project=` link for small projects). Nothing is
 * uploaded; there is no server.
 *
 * ─── Top level ─────────────────────────────────────────────────────────────────────────────────────────────────────
 *   format     "deluge-project"                 required, exact
 *   version    1                                required; a newer major version is refused (never half-read)
 *   name       string ≤ 60                      project name (cleaned like every user string)
 *   savedAt    ISO-8601 string                  informational only
 *   scene      { kind:"preset", id }            a baked scenario id (src/data isPresetId)
 *            | { kind:"live", lat, lon, sizeM, resolution, name? }   a live area (US 3DEP / GLO-30), 1–20 km, 512|1024|2048
 *   grid       { nx, ny, cellSize }             the grid the edits' coordinates refer to; checked on load
 *   scenario   see ProjectScenario               stage offset, rain, Manning n and other SimParams, sources, storms,
 *                                               shelters, evacuation start, future climate, hazard-chain what-if
 *   edits      ProjectEdit[]                    the terrain edit log, in order (below)
 *   sites      ProjectSite[] ≤ 8                Site check parcels (lon/lat, so they survive a scene change)
 *   siteCheck  SiteCheckSettings?               ladder, minutes per level, ticked levels, user return periods,
 *                                               design event, freeboard
 *   ensemble   EnsembleSettings?                members, minutes, seed, the perturbation bands
 *   portfolio  { name, csv } | null              OPT-IN: the portfolio CSV text as loaded (it may hold sensitive
 *                                               values; off unless the user ticks it, never in a link)
 *   camera     CameraPose?                      orbit target (grid coords + elevation), distance, yaw, pitch
 *   view       ProjectView?                     water view, vertical exaggeration, layers, time of day, buildings
 *   designs    DesignSpec[] ≤ 3                 mitigation designs: named edit sets with optional cost overrides and a
 *                                               useful life (null: FEMA's standard value for the type, src/loss/bca.ts)
 *   bca        BcaSettings?                     the benefit–cost inputs every design shares: discount rate, analysis
 *                                               year (absent in older files: the defaults)
 *   comparison ComparisonSummary | null          OPT-IN cached results: the last design comparison's numbers
 *
 * ─── Edits: why a log, and why polylines ───────────────────────────────────────────────────────────────────────────
 * The solver keeps walls as a barrier raster built by capsule brush ops (`max(barrier, h)` with a one-cell smoothstep
 * edge, src/sim/brush.ts) and erases by multiplying with the same edge — so a raster cannot be turned back into ops
 * exactly, and replaying the ops in order is the only faithful way back. The log is compacted as it is recorded
 * (src/project/edits.ts): consecutive wall ops that join end to end with one radius become ONE polyline with a height
 * per segment (a drawn wall, the one-click levee), a full-map erase ("Clear walls") drops every wall before it, and
 * dig / raise strokes held on one spot merge. Coordinates are grid cells (see src/contracts.ts), rounded to 0.001
 * cell; heights to 1 mm.
 *   { op:"wall",    pts:[gx,gy, gx,gy, …], h: m | m[] (one per segment), r: cells }
 *   { op:"erase",   a:[gx,gy], b:[gx,gy], r: cells }
 *   { op:"terrain", at:[gx,gy], r: cells, d: m (negative digs) }
 *
 * ─── Reading a file ────────────────────────────────────────────────────────────────────────────────────────────────
 * Strict (src/project/validate.ts): a size cap, a depth / node cap, `__proto__` / `constructor` / `prototype` keys
 * refused anywhere, every number finite and range-checked, every enum from its list, every string cleaned
 * (cleanPlaceLabel) and capped. Unknown keys are ignored (a later 1.x may add some). Objects are rebuilt field by field
 * from what passed — nothing from the file is ever spread or assigned wholesale into app state. Strings only ever
 * reach the page as text nodes (h(), setText). Names from a `?project=` LINK are not shown at all: a link is someone
 * else's text (FINDINGS SEC-01), so designs fall back to "Design A/B/C", sites to "Site N" and the project is unnamed.
 */
import type { CameraPose, HydrographPoint, LiveAreaRequest, Shelter, StormCell, WaterSource, WaterViewMode } from '../contracts';
import type { ClimateSelection } from '../climate/scenarios';
import type { MitigationType } from '../loss/eal';
import type { SiteOccupancy } from '../loss/site';

export const PROJECT_FORMAT = 'deluge-project';
export const PROJECT_VERSION = 1;
export const PROJECT_EXTENSION = '.deluge.json';
export const PROJECT_MIME = 'application/json';

/** Every bound the reader enforces. */
export const PROJECT_LIMITS = {
  /** Characters of a project file (the portfolio CSV, inline, is most of a big one). */
  maxFileChars: 3_000_000,
  /** JSON nesting depth and total values (objects, arrays and primitives). */
  maxDepth: 12,
  maxNodes: 400_000,
  nameChars: 60,
  designNameChars: 40,
  maxDesigns: 3,
  /** Edit log entries per edit set (the user's, and each design's). */
  maxEdits: 20_000,
  /** Points of one wall polyline, and in all walls of one edit set. */
  maxWallPoints: 4096,
  maxEditPoints: 60_000,
  /**
   * Grid cells the brush ops of one edit set touch, summed op by op over each op's rectangle clipped to the grid
   * (src/sim/brush.ts brushRect — the CPU mirror visits every one of them on replay, ~27 ns a cell at 1024²). It bounds
   * how long opening a project can take: 5,000 map-sized digs fit in a 1.4 kB link and would otherwise freeze the tab
   * for minutes, on load and again in every design comparison. A file may carry a long working session (~15 s of
   * replay at worst); a link — someone else's text, applied on load — stays under a second. The edit log stops
   * recording past the file budget (src/project/edits.ts), so what the app saves, it can open.
   */
  maxBrushCells: 500_000_000,
  maxLinkBrushCells: 20_000_000,
  /** Largest edit radius, cells, when the file has no grid (the largest grid side the reader accepts). */
  maxRadiusCells: 8192,
  maxSources: 64,
  maxStorms: 64,
  maxShelters: 64,
  maxHydrograph: 512,
  /** Portfolio CSV text kept in a project (src/loss/csv.ts reads up to 5 M; a project carries less). */
  maxPortfolioChars: 2_000_000,
  /** Comparison: levels per ladder. */
  maxLevels: 16,
  labelChars: 80,
} as const;

/** Physical ranges for numbers (generous: they keep NaN, Infinity and 1e308 out, not unusual values). */
export const RANGES = {
  /** Grid coordinates (cells): boundary sources sit off the grid (Pittsburgh's Ohio stage at gx −275). */
  grid: [-1e5, 1e5] as const,
  radiusCells: [0, 1e5] as const,
  wallHeight: [0, 50] as const,
  terrainDelta: [-500, 500] as const,
  stageOffset: [-50, 100] as const,
  discharge: [0, 1e6] as const,
  level: [-500, 9000] as const,
  rain: [0, 2000] as const,
  manning: [0.005, 0.3] as const,
  seconds: [0, 1e7] as const,
  elevation: [-500, 9000] as const,
  distance: [1, 1e6] as const,
  money: [0, 1e13] as const,
};

export type ProjectScene = { kind: 'preset'; id: string } | { kind: 'live'; lat: number; lon: number; sizeM: number; resolution: LiveAreaRequest['resolution']; name?: string };

export type ProjectEdit =
  | { op: 'wall'; pts: number[]; h: number | number[]; r: number }
  | { op: 'erase'; a: [number, number]; b: [number, number]; r: number }
  | { op: 'terrain'; at: [number, number]; r: number; d: number };

export interface ProjectScenario {
  stageOffset: number;
  /**
   * SimParams the user may change, by name. Known numeric keys of the app's SimParams are kept (manningN, rainRate,
   * infiltrationRate, timeScale, and any numeric parameter a later solver adds); 'boundary' as its enum. Only keys
   * the running app's SimParams has, with the same type, are applied.
   */
  sim: Record<string, number | string | boolean>;
  sources: WaterSource[];
  storms: StormCell[];
  shelters: Shelter[];
  evacStart: { gx: number; gy: number } | null;
  climate: ClimateSelection | null;
  /** Hazard-chain presets only: the what-if knobs (src/hazard/chain.ts ChainOverrides) and what drives the map. */
  chain: ProjectChain | null;
}

export interface ProjectChain {
  volumeFactor?: number;
  erosionRate?: number;
  cv?: number;
  bulking?: number;
  baseflow?: number;
  mode?: 'transientDam' | 'directFlow';
  inflow: 'chain' | 'scenario';
}

export interface ProjectSite {
  name: string;
  lon: number;
  lat: number;
  ring: number[] | null;
  occupancy: SiteOccupancy;
  floors: number;
  value: number | null;
  footprintM2: number | null;
  firstFloorHeight: number | null;
  criticalElev: number | null;
}

export type LadderKind = 'stage' | 'scale' | 'rain';

export interface SiteCheckSettings {
  ladder: LadderKind | 'auto';
  minutes: number;
  /** Ticked level ids (null: the ladder's defaults). */
  levels: string[] | null;
  /** Return periods the user typed, by level id. */
  userRp: Record<string, number>;
  designEvent: string | null;
  freeboardFt: number | null;
}

export interface EnsembleSettings {
  members: number;
  minutes: number;
  seed: number;
  ranges: { inflowPct: number; rainPct: number; stageM: number; manningLo: number; manningHi: number; demSigmaM: number; demCorrM?: number };
}

export interface ProjectView {
  waterMode: WaterViewMode;
  verticalExaggeration: number;
  showImagery: boolean;
  showRoads: boolean;
  showContours: boolean;
  probabilityThreshold?: number;
  timeOfDay?: 'daylight' | 'goldenHour' | 'morning';
  buildings?: boolean;
}

export interface DesignCost {
  type: MitigationType;
  /** Total construction cost, USD; replaces the unit-cost estimate. */
  capexUsd: number | null;
  /** Annual operation & maintenance, USD/yr. */
  omUsdPerYear: number | null;
  /** Override the measured wall length / mean height for the unit-cost estimate. */
  lengthM: number | null;
  heightM: number | null;
  /** Project useful life, whole years (null: FEMA's standard value for the type, src/loss/bca.ts USEFUL_LIFE). */
  usefulLifeYears?: number | null;
}

/** Benefit–cost inputs every design of a comparison shares (src/loss/bca.ts BCA_LIMITS bounds them). */
export interface BcaSettings {
  /** Real discount rate, fraction (0.07 = the FEMA BCA Toolkit default). */
  discountRate: number;
  /** The year the dollars are in (the FEMA BCA Toolkit's analysis year). */
  analysisYear: number;
}

export interface DesignSpec {
  id: 'A' | 'B' | 'C';
  name: string;
  edits: ProjectEdit[];
  cost: DesignCost;
}

/** The comparison's numbers as kept in a project (cached results; the maps are not kept). */
export interface ComparisonSummary {
  generatedAt: string;
  ladder: LadderKind | 'current';
  durationS: number;
  levels: Array<{ id: string; label: string; returnPeriod: number | null; rpFrom: 'source' | 'user' | null }>;
  /** Loss per level, USD; null = no value (a scene without buildings has no loss model), shown as "—". */
  baseline: { loss: Array<number | null>; eal: number | null };
  designs: Array<{
    id: string;
    name: string;
    loss: Array<number | null>;
    eal: number | null;
    deltaEal: number | null;
    costUsd: number;
    npv7: number | null;
    npv3: number | null;
    bcr7: number | null;
    bcr3: number | null;
    protectedBuildings: number;
    newlyReached: number;
    deeperBuildings: number;
    wetterAreaM2: number;
    /** Benefit–cost at the comparison's discount rate, with its range (absent in older files: null). */
    years: number | null;
    bcr: number | null;
    bcrLow: number | null;
    bcrHigh: number | null;
    netBenefit: number | null;
    breakEvenCost: number | null;
  }>;
  /** The discount rate the bcr / netBenefit fields used (absent in older files: null). */
  discountRate: number | null;
}

export interface ProjectFile {
  format: typeof PROJECT_FORMAT;
  version: typeof PROJECT_VERSION;
  name: string;
  savedAt: string;
  scene: ProjectScene;
  grid: { nx: number; ny: number; cellSize: number } | null;
  scenario: ProjectScenario;
  edits: ProjectEdit[];
  sites: ProjectSite[];
  siteCheck: SiteCheckSettings | null;
  ensemble: EnsembleSettings | null;
  portfolio: { name: string; csv: string } | null;
  camera: CameraPose | null;
  view: ProjectView | null;
  designs: DesignSpec[];
  bca?: BcaSettings | null;
  comparison: ComparisonSummary | null;
}

export type { HydrographPoint };
