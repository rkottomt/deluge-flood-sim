/**
 * Turn a live area on the U.S. coast into a surge scenario: find the seaward edges of the map, put a sea-level
 * boundary on them at MHHW, and attach the NOAA return-period ladder of the nearest tide station (src/surge/stations.ts)
 * so Site check sweeps it like a river ladder and books an expected annual loss. Pure: no network, no DOM.
 *
 * SEAWARD EDGES. The sea is the water the live loader already found and pre-filled (ScenarioPreset.initialFill →
 * computeInitialWater): wet cells whose surface stands near sea level (between MSL − 1 m and MHHW + 0.6 m on the map's
 * datum), 4-connected to the map edge, in a body of at least SEA_MIN_AREA_M2. A river crossing the edge at 5 m is not
 * the sea; a lake at 0.2 m behind a barrier island that reaches the edge is treated as sea (it is tidal on most of the
 * U.S. coast). If the loader found no water (3DEP no-data over open water, filled flat), cells at or below MSL + 0.3 m
 * connected to the edge are used instead. Each run of sea cells along an edge gets one stage source covering it
 * (src/data/hydro.ts edgeStageDiscAvoiding — the same footprints the river boundaries use), at most MAX_SEA_SOURCES.
 *
 * THE STAGE CONTROL. Readings are the sea level in feet on the map's datum (NAVD88; MSL where the station has no NAVD88
 * tie), so a ladder level's "ft" is its elevation. Offset 0 is MHHW. Every other stage boundary of the live area (rivers
 * crossing the edge) is removed: they would otherwise rise with the sea slider. Inflows, rain and the pre-filled water
 * are kept.
 */
import type { ScenarioPreset, StageControl, WaterSource } from '../contracts';
import { computeInitialWater } from '../data/initialWater';
import { edgeRuns, edgeStageDiscAvoiding, growEdgeRun, type DomainEdge } from '../data/hydro';
import type { LadderLevel } from '../loss/ladders';
import type { TideGaugeSlr } from '../climate/scenarios';
import { mhhwOnDem, surgeLevels, SURGE_SOURCE_KEY, type SurgeLevel, type SurgeStation } from './stations';

export const SEA_MIN_AREA_M2 = 250_000;
export const MAX_SEA_SOURCES = 8;
const FT = 0.3048;

/** What a coastal scenario carries (ScenarioPreset.coastal). */
export interface CoastalSurgeSpec {
  stationId: string;
  stationName: string;
  /** Distance from the map centre to the station, km. */
  stationKm: number;
  /** The station stands off the loaded map (farther than its half-diagonal): possibly in another bay (gaugeNote). */
  gaugeOffMap?: boolean;
  datum: 'NAVD88' | 'MSL';
  /** MHHW on the map's datum, m. */
  mhhw: number;
  levels: SurgeLevel[];
  /** The Site check ladder (feet = elevation on the map's datum; the stage control's gauge datum is 0). */
  ladder: LadderLevel[];
  /** 90 % CI of the 1 % level, m on the map's datum. */
  ci100: [number, number];
  /** NOAA 2022 SLR at the station for the climate layer; null where not published. */
  slr: TideGaugeSlr | null;
  /** Sea runs on the map edge that got a boundary. */
  seaRuns: number;
  /** The sentences this set-up appended to the scenario's description (withoutSurgeText takes them out again). */
  descriptionAdded?: string;
}

/**
 * One line on where the gauge is, for every surge result: its distance from the map centre and, when it stands off
 * the map, that it may be in another bay or up another estuary. Nothing on the map then shows how the gauge's water
 * connects to the site's, and surge varies strongly along a coast and up estuaries — so the line says so instead of
 * adjusting the levels (no run-up or transfer is modelled).
 */
export function gaugeNote(spec: Pick<CoastalSurgeSpec, 'stationName' | 'stationId' | 'stationKm' | 'gaugeOffMap'>): string {
  const km = spec.stationKm < 10 ? spec.stationKm.toFixed(1) : String(Math.round(spec.stationKm));
  const where = `NOAA gauge ${spec.stationName} (${spec.stationId}), ${km} km from the map centre`;
  if (spec.gaugeOffMap === undefined) return where + ".";
  return spec.gaugeOffMap
    ? `${where}: off this map, so possibly in another bay or up another estuary — its still-water levels stand in for the sea here, and surge can differ a lot between the two.`
    : `${where}: on this map.`;
}

/** A scenario's description without the sentences a coastal set-up appended to it (coastalSetup). */
export function withoutSurgeText(s: Pick<ScenarioPreset, 'description' | 'coastal'>): string {
  const added = s.coastal?.descriptionAdded;
  return added && s.description.endsWith(added) ? s.description.slice(0, s.description.length - added.length) : s.description;
}

export interface CoastalSetup {
  scenario: ScenarioPreset;
  spec: CoastalSurgeSpec;
  /** Sea cells found (for the panel). */
  seaCells: number;
  /** Which mask found them. */
  method: 'water' | 'dem';
}

/** The ladder rows for Site check (LadderLevel: ft on the stage control's datum, i.e. elevation). */
export function surgeLadder(levels: readonly SurgeLevel[], station: SurgeStation): LadderLevel[] {
  return levels.map((l) => ({
    id: l.id,
    label: `${l.label} — ${station.name}`,
    ft: Math.round((l.elevation / FT) * 100) / 100,
    group: 'frequency' as const,
    returnPeriod: l.returnPeriod,
    source: SURGE_SOURCE_KEY,
    note: `${l.aboveMhhw.toFixed(2)} m above MHHW at NOAA ${station.id}`,
  }));
}

/** The station's SLR as the climate layer's gauge record. */
export function stationSlr(s: SurgeStation): TideGaugeSlr | null {
  if (!s.slr) return null;
  const r = (k: keyof NonNullable<SurgeStation['slr']>) => ({ 2050: s.slr![k][0], 2080: s.slr![k][1], 2100: s.slr![k][2] });
  return {
    id: `coops-${s.id}`,
    name: `${s.name} (NOAA ${s.id})`,
    baseYear: 2005,
    rise: { low: r('low'), intLow: r('intLow'), int: r('int'), intHigh: r('intHigh'), high: r('high') },
    source: 'noaaSlr2022',
    tag: 'V',
  };
}

/**
 * The sea mask: wet cells at the start whose water surface is near sea level, connected to the edge, in bodies of at
 * least SEA_MIN_AREA_M2; or, when the start has no such water, low ground connected to the edge.
 */
export function seaMask(
  elevation: Float32Array,
  nx: number,
  ny: number,
  cellSize: number,
  initialDepth: Float32Array | null,
  datum: { mhhw: number; msl: number },
): { mask: Uint8Array; cells: number; method: 'water' | 'dem' } {
  const lo = datum.msl - 1;
  const hi = datum.mhhw + 0.6;
  const wetSea = (k: number) => !!initialDepth && initialDepth[k] > 0.05 && elevation[k] + initialDepth[k] >= lo && elevation[k] + initialDepth[k] <= hi;
  let r = connectedToEdge(nx, ny, cellSize, wetSea);
  if (r.cells > 0) return { ...r, method: 'water' };
  const lowGround = (k: number) => elevation[k] <= datum.msl + 0.3;
  r = connectedToEdge(nx, ny, cellSize, lowGround);
  return { ...r, method: 'dem' };
}

function connectedToEdge(nx: number, ny: number, cellSize: number, inSea: (k: number) => boolean): { mask: Uint8Array; cells: number } {
  const n = nx * ny;
  const comp = new Int32Array(n).fill(-1);
  const mask = new Uint8Array(n);
  const queue = new Int32Array(n);
  const minCells = Math.ceil(SEA_MIN_AREA_M2 / (cellSize * cellSize));
  let total = 0;
  let id = 0;
  const seeds: number[] = [];
  for (let i = 0; i < nx; i++) seeds.push(i, (ny - 1) * nx + i);
  for (let j = 0; j < ny; j++) seeds.push(j * nx, j * nx + nx - 1);
  for (const s of seeds) {
    if (comp[s] >= 0 || !inSea(s)) continue;
    let head = 0;
    let tail = 0;
    const visit = (m: number) => {
      if (comp[m] >= 0 || !inSea(m)) return;
      comp[m] = id;
      queue[tail++] = m;
    };
    queue[tail++] = s;
    comp[s] = id;
    while (head < tail) {
      const k = queue[head++];
      const i = k % nx;
      const j = (k - i) / nx;
      if (i > 0) visit(k - 1);
      if (i < nx - 1) visit(k + 1);
      if (j > 0) visit(k - nx);
      if (j < ny - 1) visit(k + nx);
    }
    if (tail >= minCells) {
      for (let q = 0; q < tail; q++) mask[queue[q]] = 1;
      total += tail;
    }
    id++;
  }
  return { mask, cells: total };
}

/** Stage sources on every run of sea cells along the map edge, at `level`, covering the run as wide as the top of the control. */
export function seaSources(elevation: Float32Array, nx: number, ny: number, mask: Uint8Array, level: number, ceiling: number, label: string): WaterSource[] {
  const cands: Array<{ gx: number; gy: number; radius: number }> = [];
  for (const edge of ['north', 'south', 'west', 'east'] as DomainEdge[]) {
    for (const [t0, t1] of edgeRuns(edge, nx, ny, (k) => mask[k] === 1)) {
      if (t1 - t0 + 1 < 4) continue;
      const grown = growEdgeRun(edge, t0, t1, nx, ny, (q) => mask[q] === 1 || (elevation[q] < ceiling && elevation[q] >= level));
      const { run: _run, ...disc } = edgeStageDiscAvoiding(edge, [t0, t1], grown, nx, ny, (q) => mask[q] !== 1 && elevation[q] < level);
      cands.push(disc);
    }
  }
  cands.sort((a, b) => b.radius - a.radius);
  const out: WaterSource[] = [];
  for (const c of cands) {
    if (out.length >= MAX_SEA_SOURCES) break;
    if (out.some((s) => Math.hypot(s.gx - c.gx, s.gy - c.gy) < 0.8 * (s.radius + c.radius))) continue;
    out.push({ id: `sea-${out.length + 1}`, type: 'stage', gx: c.gx, gy: c.gy, radius: c.radius, level: Math.round(level * 1000) / 1000, label });
  }
  return out;
}

/**
 * The coastal surge scenario for a loaded live area, or a reason it cannot be one. `stationKm` is the distance from the
 * map centre to the station (src/surge/stations.ts nearestStation).
 */
export function coastalSetup(
  terrain: { elevation: Float32Array; nx: number; ny: number; cellSize: number },
  base: ScenarioPreset,
  station: SurgeStation,
  stationKm: number,
): CoastalSetup | { error: string } {
  const { elevation, nx, ny, cellSize } = terrain;
  const z = mhhwOnDem(station);
  const msl = z.m - station.mhhwMsl;
  let initial: Float32Array | null = null;
  try {
    initial = computeInitialWater({ nx, ny, elevation }, base);
  } catch {
    initial = null;
  }
  const sea = seaMask(elevation, nx, ny, cellSize, initial, { mhhw: z.m, msl });
  if (sea.cells === 0) return { error: 'No sea reaches the edge of this map: the surge ladder needs open water at sea level on at least one side. Move the area so it includes the shoreline and some open water.' };
  const levels = surgeLevels(station);
  const ladder = surgeLadder(levels, station);
  const slr = stationSlr(station);
  const top = Math.max(...levels.map((l) => l.elevation)) + (slr ? slr.rise.int[2100] : 1) + 0.5;
  const maxOffset = Math.max(2, Math.ceil((top - z.m) * 10) / 10);
  const label = `Sea level at NOAA ${station.name} (${station.id})`;
  const sources = seaSources(elevation, nx, ny, sea.mask, z.m, z.m + maxOffset, `${label} — storm-surge boundary`);
  if (!sources.length) return { error: 'The sea touches the map edge only in slivers too narrow for a boundary. Move the area so more of the open water is on the map.' };
  const l100 = levels[levels.length - 1];
  const stage: StageControl = {
    label: `${label}, ft ${z.datum}`,
    gaugeDatum: 0,
    normalLevel: Math.round(z.m * 1000) / 1000,
    marks: [
      { label: 'MHHW', ft: Math.round((z.m / FT) * 100) / 100 },
      { label: `NOAA 1 % (100-yr)`, ft: Math.round((l100.elevation / FT) * 100) / 100 },
    ],
    maxOffset,
  };
  const spec: CoastalSurgeSpec = {
    stationId: station.id,
    stationName: station.name,
    stationKm: Math.round(stationKm * 10) / 10,
    gaugeOffMap: stationKm > (Math.SQRT2 / 2) * ((Math.max(nx, ny) * cellSize) / 1000),
    datum: z.datum,
    mhhw: z.m,
    levels,
    ladder,
    ci100: [Math.round((z.m + station.ci100[0]) * 1000) / 1000, Math.round((z.m + station.ci100[1]) * 1000) / 1000],
    slr,
    seaRuns: sources.length,
  };
  const keep = base.sources.filter((s) => s.type !== 'stage');
  const added =
    ` Coastal surge set-up: the sea boundary on ${sources.length} seaward edge run${sources.length === 1 ? '' : 's'} follows the ` +
    `sea-level control (feet ${z.datum}; 0 offset = MHHW ${z.m.toFixed(2)} m), and Site check sweeps NOAA’s extreme water levels at ${station.name} ` +
    `(${spec.stationKm} km away): the 1 %-annual-chance still-water level is ${l100.elevation.toFixed(2)} m ${z.datum} (90 % CI ${spec.ci100[0].toFixed(2)}–${spec.ci100[1].toFixed(2)}).`;
  spec.descriptionAdded = added;
  // Built on the description without a previous set-up's sentences: a re-run replaces them, never stacks them.
  const description = withoutSurgeText(base) + added;
  return {
    scenario: { ...base, description, sources: [...sources, ...keep], stage, coastal: spec },
    spec,
    seaCells: sea.cells,
    method: sea.method,
  };
}
