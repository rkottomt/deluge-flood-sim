/**
 * A dam breach on a loaded live area: the breach hydrograph (src/dams/breachModel.ts) as an inflow at the dam's toe
 * (src/dams/placement.ts), added to the area's own scenario. Pure: no network, no DOM.
 *
 * WHY AN INFLOW, NOT A RESERVOIR BEHIND A WALL. The procedural sandbox (src/data/sandbox.ts) has a real reservoir and a
 * dam the user can breach with the erase tool, because it owns its terrain. A live area does not: USGS 3DEP is
 * hydro-flattened, so over the reservoir it holds the water surface, not the lake bed — a reservoir "filled" on it
 * would hold almost none of the NID storage, and the breach would be wherever a wall was guessed to be. The inflow
 * delivers the breach hydrograph's EXACT volume at its modelled rate (src/sim/forcing.ts meanInflow, as the glacier
 * chain does), whatever the DEM shows upstream; the reservoir drawdown is in the hydrograph, not on the map.
 */
import type { ScenarioPreset, WaterSource } from '../contracts';
import { BREACH_MODES, type BreachMethod, type BreachMode, type DamScenario } from './breachModel';
import { relationById, type RelationId } from './breachRelations';
import { descentPath, injectionCell, injectionRadiusM, type GridPoint, type PathPoint } from './placement';

/** What a dam-breach scenario carries (ScenarioPreset.damBreach). */
export interface DamBreachSpec {
  /** The sentences this breach put in front of the scenario's description (withoutDamText takes them out again). */
  descriptionAdded?: string;
  nidId: string;
  name: string;
  mode: BreachMode;
  method: BreachMethod;
  /** Where the NID puts the dam, and where the outflow enters, grid coords. */
  dam: GridPoint;
  inflow: GridPoint & { elevation: number; distanceM: number };
  /** Modelled breach peak (without base flow), m³/s, and its time, s after the breach starts. */
  peak: number;
  tPeak: number;
  /** Volume delivered to the map, m³ (breach + any base flow). */
  volume: number;
  /** The published relations' low / central / high peaks for this dam, m³/s (src/dams/breachRelations.ts peakBand). */
  band: { low: BandPoint; central: BandPoint; high: BandPoint };
  /** Froehlich 2008 average breach width, m, and formation time, s. */
  widthM: number;
  formationS: number;
  /** The downstream flow path from the inflow (for the arrival readout), at most a few hundred points. */
  path: PathPoint[];
  assumptions: string[];
  caveats: string[];
}

export interface BandPoint {
  id: RelationId;
  label: string;
  peak: number;
}

export const DAM_INFLOW_ID = 'dam-breach';
/** Footprint radius of the inflow, m: wide enough to spread the peak over the channel, not over the valley. */
export const DAM_INFLOW_RADIUS_M = 40;

/** Thin a path to at most `max` points (keeping the first and last). */
function thin<T>(pts: T[], max: number): T[] {
  if (pts.length <= max) return pts;
  const out: T[] = [];
  const step = (pts.length - 1) / (max - 1);
  for (let k = 0; k < max; k++) out.push(pts[Math.round(k * step)]);
  return out;
}

/**
 * The breach on this terrain: the inflow source at the dam's toe and the scenario with it. `dam` is the NID point in
 * grid coordinates; null when it is off the map.
 */
export function damBreachScenario(
  terrain: { elevation: Float32Array; nx: number; ny: number; cellSize: number },
  base: ScenarioPreset,
  dam: GridPoint,
  s: DamScenario,
): { scenario: ScenarioPreset; source: Extract<WaterSource, { type: 'inflow' }>; spec: DamBreachSpec } | null {
  const { elevation, nx, ny, cellSize } = terrain;
  const toe = injectionCell(elevation, nx, ny, cellSize, dam, injectionRadiusM(s.dam.heightM));
  if (!toe) return null;
  const r = s.result;
  const source: Extract<WaterSource, { type: 'inflow' }> = {
    id: DAM_INFLOW_ID,
    type: 'inflow',
    gx: toe.gx,
    gy: toe.gy,
    radius: Math.max(1, DAM_INFLOW_RADIUS_M / cellSize),
    discharge: r.hydrograph.reduce((m, p) => Math.max(m, p.q), 0),
    hydrograph: r.hydrograph.map((p) => ({ t: p.t, q: p.q })),
    label: `${s.dam.name} (NID ${s.dam.id}) — ${BREACH_MODES[s.mode].short.toLowerCase()} breach, modelled`,
  };
  const path = thin(descentPath(elevation, nx, ny, cellSize, toe, 0.95 * Math.hypot(nx, ny) * cellSize), 400);
  const spec: DamBreachSpec = {
    nidId: s.dam.id,
    name: s.dam.name,
    mode: s.mode,
    method: s.method,
    dam,
    inflow: toe,
    peak: r.peak,
    tPeak: r.tPeak,
    volume: r.deliveredVolume,
    band: {
      low: { id: r.band.low.id, label: relationById(r.band.low.id).label, peak: r.band.low.peak },
      central: { id: r.band.central.id, label: relationById(r.band.central.id).label, peak: r.band.central.peak },
      high: { id: r.band.high.id, label: relationById(r.band.high.id).label, peak: r.band.high.peak },
    },
    widthM: r.avgWidthM,
    formationS: r.formationTimeS,
    path,
    assumptions: s.assumptions,
    caveats: s.caveats,
  };
  const others = base.sources.filter((x) => x.id !== DAM_INFLOW_ID);
  const peakText = Math.round(r.peak).toLocaleString('en-US');
  const added =
    `${s.dam.name} (NID ${s.dam.id}, ${s.dam.heightM.toFixed(0)} m, ${Math.round(s.dam.storageAcFt).toLocaleString('en-US')} acre-ft): ${BREACH_MODES[s.mode].label.toLowerCase()}. ` +
    `The modelled breach outflow peaks at ${peakText} m³/s ${Math.round(r.tPeak / 60)} min after the breach starts ` +
    `(published relations: ${Math.round(r.band.low.peak).toLocaleString('en-US')}–${Math.round(r.band.high.peak).toLocaleString('en-US')} m³/s) and releases ${(r.breachVolume / 1e6).toFixed(1)} million m³; ` +
    `it enters the map at the toe of the dam. `;
  spec.descriptionAdded = added;
  // Built on the description without a previous breach's sentences: a re-run replaces them, never stacks them.
  return { scenario: { ...base, description: added + withoutDamText(base), sources: [source, ...others], damBreach: spec }, source, spec };
}

/** A scenario's description without the sentences a dam breach added to it (damBreachScenario). */
export function withoutDamText(s: Pick<ScenarioPreset, 'description' | 'damBreach'>): string {
  const added = s.damBreach?.descriptionAdded;
  return added && s.description.startsWith(added) ? s.description.slice(added.length) : s.description;
}
