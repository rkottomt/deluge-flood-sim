/**
 * Per-asset flood impact from the solver's hazard accumulators (HazardFields): what reached each building, how bad it
 * was, what it cost, and how long the place is out of action.
 *
 * For each footprint the cells it covers (footprints.ts) are sampled for maximum depth, maximum speed, maximum
 * depth × speed, first arrival and wet duration — the WORST cell, since a flood that fills one side of a building
 * fills its ground floor. Cells that were already wet at reset (rivers, lakes: firstWet = 0) are left out, so a
 * riverside building whose footprint clips the channel is not booked the river's depth.
 *
 * On bare-earth terrain the solver lets water flow THROUGH buildings, so the depth on a footprint is the depth the
 * street would have there, and the speed is open-ground speed where real flow would split around the walls. Both are
 * what the loss curves and hazard classes are usually fed in screening studies, and both are stated. With buildings as
 * obstacles (FloodSolver.setLandSurface, HazardFields.blocked) no water stands in a footprint: the footprint's blocked
 * cells are replaced by the open cells around it (footprints.ts openCells), i.e. the depth and speed against its walls.
 */
import type { BuildingSet, HazardFields } from '../contracts';
import { BUILDING_KINDS, HEIGHT_SOURCES, type HeightProfile } from '../data/buildings';
import { ACCESS_CUT, ACCESS_NO_ROAD, type AccessIndex, type AccessInfo, type AccessResult } from './access';
import type { Curve } from './curves';
import { openCells, type FootprintIndex } from './footprints';
import {
  ACCESS_CLEARING_DAYS,
  aidrClass,
  downtimeDays,
  fd2321HR,
  hrClass,
  collapseShare,
  structuralState,
  type AidrClass,
  type HrClass,
} from './hazard';
import type { Region } from './region';
import {
  assetValue,
  curveForOccupancy,
  floorsFromHeight,
  OCCUPANCY_PROFILES,
  occupancyForKind,
  storeyDamage,
  storeyHeightFor,
  undamageableShare,
  type Construction,
  type Occupancy,
  type StructuralState,
  type ValueConfidence,
} from './value';

/** Water depth that counts as reaching an asset, m — the solver's ARRIVAL_DEPTH, the depth HazardFields' firstWet uses. */
export const REACHED_DEPTH = 0.15;
/**
 * Reporting threshold for "damaged": the ground storey lost at least this fraction of its damageable value. A
 * presentation choice, not physics — every building with water above its floor carries some loss in the totals.
 */
export const DAMAGED_MIN_FRACTION = 0.2;
/**
 * Below this depth above the ground floor nothing is booked as damage, m. The JRC North-American curves start at
 * 20 % (residential) at 0 m — they inherit HAZUS's first-floor datum — so without a threshold a film of water on a
 * bare-earth footprint would cost a house a fifth of its value. 15 cm (ankle-deep, the solver's arrival depth) is a
 * convention, not a measurement: water below it at the footprint is taken not to enter. [I]
 */
export const DAMAGE_MIN_DEPTH = 0.15;

export interface CellSample {
  /** Cells sampled (cells wet at reset excluded). */
  sampled: number;
  /** Sampled cells with at least REACHED_DEPTH of water at some point. */
  reachedCells: number;
  maxDepth: number;
  /** NaN when the fields carry no velocity. */
  maxSpeed: number;
  maxDV: number;
  /**
   * The footprint statistic the structural (fast-water) rule reads: the STRUCTURAL_QUANTILE of the sampled cells'
   * maximum speed and maximum depth × speed (NaN with maxSpeed). Optional so hand-built samples keep working: when
   * absent, the maxima are used.
   */
  structSpeed?: number;
  structDV?: number;
  /** Earliest arrival over the sampled cells, s since reset; −1 if never reached. */
  firstWet: number;
  wetSeconds: number;
}

/**
 * Quantile of the per-cell maxima that the structural rule reads over a footprint [I]: 0.9, linearly interpolated
 * between order statistics. The worst single cell of a bare-earth 2-D grid is the noisiest number in the footprint
 * (a jet along one edge, a cell the front crosses at a sampled moment); requiring the speed and the depth × speed to
 * act on about a tenth of the footprint keeps one cell from writing a building off, while a building in a fast
 * current — all of it under the same flow — reads nearly its maximum. A footprint of 1 cell reads that cell; a few
 * cells read close to their top value.
 */
export const STRUCTURAL_QUANTILE = 0.9;

/** Linearly interpolated quantile q of `v` (sorted in place); 0 for an empty array. */
export function quantile(v: Float64Array, q: number): number {
  if (v.length === 0) return 0;
  v.sort();
  const x = Math.min(1, Math.max(0, q)) * (v.length - 1);
  const i = Math.floor(x);
  const j = Math.min(v.length - 1, i + 1);
  return v[i] + (x - i) * (v[j] - v[i]);
}

export function sampleCells(f: HazardFields, cells: ArrayLike<number>, start = 0, end = cells.length): CellSample {
  // Buildings as obstacles: water never stands in a blocked footprint, so read the open cells against its walls
  // (footprints.ts openCells). Where those lie lower than the building's own lowest ground (a gutter, a street below a
  // building pad), only the water above that ground reaches the building: each wall cell's depth is lowered by how far
  // its ground lies below the footprint's — never raised, so a wall cell uphill of a sloping footprint reads its own.
  let gRef = NaN;
  const ground = f.blocked ? f.ground : undefined;
  if (f.blocked) {
    const open = openCells(cells, start, end, f.blocked, f.nx, f.ny);
    if (open) {
      if (ground) {
        gRef = Infinity;
        for (let q = start; q < end; q++) if (f.blocked[cells[q]] && ground[cells[q]] < gRef) gRef = ground[cells[q]];
      }
      cells = open;
      start = 0;
      end = open.length;
    }
  }
  const lifted = !!ground && Number.isFinite(gRef);
  const s: CellSample = { sampled: 0, reachedCells: 0, maxDepth: 0, maxSpeed: 0, maxDV: 0, structSpeed: 0, structDV: 0, firstWet: -1, wetSeconds: 0 };
  let speedNaN = false;
  const speeds = new Float64Array(Math.max(0, end - start));
  const dvs = new Float64Array(speeds.length);
  for (let q = start; q < end; q++) {
    const c = cells[q];
    let fw = f.firstWet[c];
    if (fw === 0) continue;
    s.sampled++;
    let d = f.maxDepth[c];
    let dv = f.maxDV[c];
    let w = f.wetSeconds[c];
    const lift = lifted ? Math.max(0, gRef - ground![c]) : 0;
    if (lift > 0) {
      // Depth × speed scales with the depth that reaches the wall; water that never stands REACHED_DEPTH above the
      // building's ground has not reached it (no arrival, no wet time).
      const de = Math.max(0, d - lift);
      dv = d > 0 ? (dv * de) / d : 0;
      d = de;
      if (d < REACHED_DEPTH) {
        fw = -1;
        w = 0;
      }
    }
    if (d > s.maxDepth) s.maxDepth = d;
    if (d >= REACHED_DEPTH) s.reachedCells++;
    const v = f.maxSpeed[c];
    if (Number.isNaN(v)) speedNaN = true;
    else if (v > s.maxSpeed) s.maxSpeed = v;
    if (dv > s.maxDV) s.maxDV = dv;
    const k = s.sampled - 1;
    speeds[k] = Number.isFinite(v) ? v : 0;
    dvs[k] = Number.isFinite(dv) ? dv : 0;
    if (fw > 0 && (s.firstWet < 0 || fw < s.firstWet)) s.firstWet = fw;
    if (w > s.wetSeconds) s.wetSeconds = w;
  }
  s.structSpeed = quantile(speeds.subarray(0, s.sampled), STRUCTURAL_QUANTILE);
  s.structDV = quantile(dvs.subarray(0, s.sampled), STRUCTURAL_QUANTILE);
  if (speedNaN) {
    s.maxSpeed = NaN;
    s.maxDV = NaN;
    s.structSpeed = NaN;
    s.structDV = NaN;
  }
  return s;
}

/** What is being assessed (values may be NaN = unknown). */
export interface AssetSpec {
  occ: Occupancy;
  floors: number;
  storeyHeight: number;
  structure: number;
  contents: number;
  construction: Construction | null;
  /** Ground-floor height above the ground, m (0 for footprints: the JRC curves are on water depth). */
  firstFloorHeight: number;
  /** Height of critical equipment above grade, m (portfolio). */
  criticalElev?: number | null;
  /** Daily gross profit (daily revenue × gross margin), for business interruption (portfolio). */
  dailyGrossProfit?: number | null;
  recapture?: number | null;
  deductible?: number | null;
  limit?: number | null;
}

export interface AssessContext {
  curve: Curve;
  debrisFlow: boolean;
  /** Warning time: lead time = arrival − this, s since reset. */
  alertTime: number;
}

export interface AssetResult {
  sampled: number;
  /**
   * Share of the sampled footprint cells that reached REACHED_DEPTH. Depth is the worst cell, so a building with
   * water only along one edge (a riverside wall, a footprint a levee cuts through) shows a small share here.
   */
  wetFraction: number;
  /** Max water depth at the asset, m. */
  depth: number;
  /** Max depth above the ground floor, m. */
  depthAboveFloor: number;
  /** Worst cell's maximum speed (m/s) and depth × speed (m²/s): what the hazard classes read. */
  speed: number;
  dv: number;
  /** The footprint statistic the structural rule reads (CellSample.structSpeed / structDV). */
  structuralSpeed: number;
  structuralDV: number;
  /** Share of total loss from fast water, 0–1 (hazard.ts collapseShare); 'collapse' state from 0.5. */
  collapseShare: number;
  firstWet: number;
  /** firstWet − alert time, s; NaN if never reached. */
  leadTime: number;
  wetSeconds: number;
  reached: boolean;
  aidr: AidrClass;
  hr: number;
  hrClass: HrClass;
  state: StructuralState;
  /** Whole-asset damage fraction (after the velocity rule). */
  damage: number;
  groundDamage: number;
  lossStructure: number;
  lossContents: number;
  loss: number;
  lossLo: number;
  lossHi: number;
  /** Downtime heuristic, days. */
  downtimeDays: number;
  /** Business-interruption loss; NaN without a daily gross profit. */
  biLoss: number;
  /** clamp(loss + BI − deductible, 0, limit); NaN without a deductible or limit. */
  insuredLoss: number;
  /** Critical equipment under water (max depth > critical elevation), null when no elevation was given. */
  criticalWet: boolean | null;
  /** The nearest road (within ACCESS_SNAP_M) reached 0.3 m: egress lost at the peak. */
  accessCut: boolean;
  /** A road was found near the asset (false: no road data, or none within ACCESS_SNAP_M). */
  accessKnown: boolean;
  /** Cut roads: when water first arrived on the stretch that closed it, s since reset (NaN otherwise). */
  accessCutAt: number;
  /** Cut roads: accessCutAt − alert time, s. */
  accessLeadTime: number;
  accessRoad: string;
}

export function assessAsset(
  s: CellSample,
  spec: AssetSpec,
  ctx: AssessContext,
  access?: AccessInfo | null,
): AssetResult {
  const depth = s.maxDepth;
  const above = depth - Math.max(0, spec.firstFloorHeight || 0);
  // The fast-water rule reads the footprint statistic, not the worst cell (STRUCTURAL_QUANTILE), and ramps (collapseShare).
  const sv = s.structSpeed ?? s.maxSpeed;
  const sdv = s.structDV ?? s.maxDV;
  const rule = { construction: spec.construction, debrisFlow: ctx.debrisFlow };
  const state = structuralState(sv, sdv, rule);
  const effState: StructuralState = depth >= REACHED_DEPTH ? state : state === 'unknown' ? 'unknown' : 'none';
  const share = depth >= REACHED_DEPTH ? collapseShare(sv, sdv, rule) : 0;
  const dmg = storeyDamage({
    depth: above >= DAMAGE_MIN_DEPTH ? above : 0,
    floors: spec.floors,
    storeyHeight: spec.storeyHeight,
    curve: ctx.curve,
    structureValue: spec.structure,
    contentsValue: spec.contents,
    undamageable: undamageableShare(spec.construction),
    state: effState,
    collapseShare: share,
  });
  const prof = OCCUPANCY_PROFILES[spec.occ];
  const accessCut = access?.status === ACCESS_CUT;
  const accessDays = accessCut ? ACCESS_CLEARING_DAYS + (access?.roadWetSeconds ?? 0) / 86400 : 0;
  // Like damage, clean-up starts once water is above DAMAGE_MIN_DEPTH over the floor (a film outside does not enter).
  const downtime = downtimeDays({ depth: above >= DAMAGE_MIN_DEPTH ? above : 0, damage: dmg.fraction, rebuildDays: prof.rebuildDays, accessDays });
  const gp = spec.dailyGrossProfit;
  const recapture = spec.recapture ?? prof.recapture;
  const biLoss = gp != null && Number.isFinite(gp) ? downtime * gp * (1 - Math.min(1, Math.max(0, recapture))) : NaN;
  const loss = dmg.structure + dmg.contents;
  let insured = NaN;
  if ((spec.deductible != null && Number.isFinite(spec.deductible)) || (spec.limit != null && Number.isFinite(spec.limit))) {
    const gross = loss + (Number.isFinite(biLoss) ? biLoss : 0);
    insured = Math.max(0, gross - (spec.deductible ?? 0));
    if (spec.limit != null && Number.isFinite(spec.limit)) insured = Math.min(insured, spec.limit);
  }
  const hr = fd2321HR(depth, s.maxSpeed);
  return {
    sampled: s.sampled,
    wetFraction: s.sampled ? s.reachedCells / s.sampled : 0,
    depth,
    depthAboveFloor: above,
    speed: s.maxSpeed,
    dv: s.maxDV,
    structuralSpeed: sv,
    structuralDV: sdv,
    collapseShare: share,
    firstWet: s.firstWet,
    leadTime: s.firstWet >= 0 ? s.firstWet - ctx.alertTime : NaN,
    wetSeconds: s.wetSeconds,
    reached: depth >= REACHED_DEPTH,
    aidr: aidrClass(depth, s.maxSpeed, s.maxDV),
    hr,
    hrClass: hrClass(hr),
    state: effState,
    damage: dmg.fraction,
    groundDamage: dmg.groundFraction,
    lossStructure: dmg.structure,
    lossContents: dmg.contents,
    loss,
    lossLo: dmg.lossLo,
    lossHi: dmg.lossHi,
    downtimeDays: downtime,
    biLoss,
    insuredLoss: insured,
    criticalWet: spec.criticalElev != null && Number.isFinite(spec.criticalElev) ? depth > spec.criticalElev : null,
    accessCut,
    accessKnown: !!access && access.status !== ACCESS_NO_ROAD,
    accessCutAt: accessCut ? access!.roadCutAt : NaN,
    accessLeadTime: accessCut ? access!.roadCutAt - ctx.alertTime : NaN,
    accessRoad: access?.roadName ?? '',
  };
}

// ─── Footprints ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImpactOptions {
  region: Region;
  heightProfile?: HeightProfile;
  /** Debris-laden flow (GLOF / debris flow): the heuristic dv × 1.5 rule (hazard.ts). */
  debrisFlow?: boolean;
  /** Warning time, s since reset (default 0: the alert goes out when the scenario starts). */
  alertTime?: number;
  /** True when HazardFields carry real speeds (false for the depth-only snapshot fallback). */
  velocityKnown?: boolean;
}

export interface BuildingImpact extends AssetResult {
  /** Index into the BuildingSet. */
  k: number;
  name: string;
  occ: Occupancy;
  kind: string;
  floors: number;
  gfaM2: number;
  valueStructure: number;
  valueContents: number;
  valueConfidence: ValueConfidence;
  /** The roof height (and so the storey count) is a guess (BuildingSet.heightSource 'estimated'). */
  heightEstimated: boolean;
  gx: number;
  gy: number;
}

export interface ImpactSummary {
  simTime: number;
  buildings: number;
  /** Buildings with at least one cell not under water at reset. */
  assessed: number;
  reached: number;
  damaged: number;
  partial: number;
  destroyed: number;
  /** Total replacement value (structure + contents) of every assessed building; NaN without a cost table. */
  exposedValue: number;
  loss: number;
  lossLo: number;
  lossHi: number;
  lossStructure: number;
  lossContents: number;
  /** Reached buildings per AIDR class (index 1–6; 0 unused). */
  aidr: number[];
  hr: Record<HrClass, number>;
  /** Reached buildings whose nearest road was impassable at the peak. */
  accessCut: number;
  earliest: { k: number; firstWet: number; leadTime: number } | null;
  /** Loss by occupancy. */
  byOccupancy: Partial<Record<Occupancy, { count: number; loss: number }>>;
  velocityKnown: boolean;
  debrisFlow: boolean;
  /** Reached buildings whose storey count came from an estimated height. */
  heightEstimated: number;
  /** Reached buildings whose occupancy came from the size heuristic. */
  occupancyGuessed: number;
}

export interface ImpactReport {
  summary: ImpactSummary;
  /** Every building with any water on it (depth > 1 cm), in BuildingSet order. */
  impacts: BuildingImpact[];
}

/** Below this max depth a building is not listed (it still counts as assessed). */
const LIST_MIN_DEPTH = 0.01;

export function computeBuildingImpacts(
  fields: HazardFields,
  set: BuildingSet,
  fp: FootprintIndex,
  opts: ImpactOptions,
  access?: AccessResult | AccessIndex | null,
): ImpactReport {
  const accessIndex = access ? (('query' in access ? access : access.index) ?? null) : null;
  const region = opts.region;
  const profile = opts.heightProfile ?? 'us';
  const ctxBase = { debrisFlow: !!opts.debrisFlow, alertTime: opts.alertTime ?? 0 };
  const curves = new Map<Occupancy, Curve>();
  const curve = (o: Occupancy) => {
    let c = curves.get(o);
    if (!c) curves.set(o, (c = curveForOccupancy(o, region.continent)));
    return c;
  };
  const sum: ImpactSummary = {
    simTime: fields.simTime,
    buildings: set.count,
    assessed: 0,
    reached: 0,
    damaged: 0,
    partial: 0,
    destroyed: 0,
    exposedValue: region.costCountry ? 0 : NaN,
    loss: 0,
    lossLo: 0,
    lossHi: 0,
    lossStructure: 0,
    lossContents: 0,
    aidr: [0, 0, 0, 0, 0, 0, 0],
    hr: { low: 0, moderate: 0, significant: 0, extreme: 0 },
    accessCut: 0,
    earliest: null,
    byOccupancy: {},
    velocityKnown: opts.velocityKnown !== false,
    debrisFlow: !!opts.debrisFlow,
    heightEstimated: 0,
    occupancyGuessed: 0,
  };
  const impacts: BuildingImpact[] = [];
  const estimatedSrc = HEIGHT_SOURCES.indexOf('estimated');
  for (let k = 0; k < set.count; k++) {
    const s = sampleCells(fields, fp.cells, fp.offsets[k], fp.offsets[k + 1]);
    if (s.sampled === 0) continue;
    sum.assessed++;
    const kind = BUILDING_KINDS[set.kind[k]] ?? 'other';
    const area = fp.areaM2[k];
    const rawFloors = floorsFromHeight(set.height[k], profile);
    const { occ, confidence } = occupancyForKind(kind, area, rawFloors);
    const prof = OCCUPANCY_PROFILES[occ];
    const floors = prof.maxFloors ? Math.min(prof.maxFloors, rawFloors) : rawFloors;
    const gfa = area * floors;
    const value = assetValue({ occ, gfaM2: gfa, country: region.costCountry });
    if (region.costCountry) sum.exposedValue += (value.structure || 0) + (value.contents || 0);
    if (!(s.maxDepth > LIST_MIN_DEPTH)) continue;
    const r = assessAsset(
      s,
      {
        occ,
        floors,
        storeyHeight: storeyHeightFor(floors, profile),
        structure: value.structure,
        contents: value.contents,
        construction: null,
        firstFloorHeight: 0,
      },
      { ...ctxBase, curve: curve(occ) },
      accessIndex ? accessIndex.query(fp.cx[k], fp.cy[k]) : null,
    );
    const heightEstimated = set.heightSource[k] === estimatedSrc;
    const b: BuildingImpact = {
      ...r,
      k,
      name: set.names[k] ?? '',
      occ,
      kind,
      floors,
      gfaM2: gfa,
      valueStructure: value.structure,
      valueContents: value.contents,
      valueConfidence: confidence,
      heightEstimated,
      gx: fp.cx[k],
      gy: fp.cy[k],
    };
    impacts.push(b);
    if (Number.isFinite(r.loss)) {
      sum.loss += r.loss;
      sum.lossLo += r.lossLo;
      sum.lossHi += r.lossHi;
      sum.lossStructure += r.lossStructure;
      sum.lossContents += r.lossContents;
    }
    if (!r.reached) continue;
    sum.reached++;
    if (r.groundDamage >= DAMAGED_MIN_FRACTION) sum.damaged++;
    if (r.state === 'partial') sum.partial++;
    if (r.state === 'collapse') sum.destroyed++;
    sum.aidr[r.aidr]++;
    sum.hr[r.hrClass]++;
    if (r.accessCut) sum.accessCut++;
    if (heightEstimated) sum.heightEstimated++;
    if (confidence === 'heuristic') sum.occupancyGuessed++;
    const bo = (sum.byOccupancy[occ] ??= { count: 0, loss: 0 });
    bo.count++;
    if (Number.isFinite(r.loss)) bo.loss += r.loss;
    if (r.firstWet > 0 && (!sum.earliest || r.firstWet < sum.earliest.firstWet)) {
      sum.earliest = { k, firstWet: r.firstWet, leadTime: r.leadTime };
    }
  }
  if (!region.costCountry) {
    sum.loss = sum.lossLo = sum.lossHi = sum.lossStructure = sum.lossContents = NaN;
  }
  return { summary: sum, impacts };
}

/** The n biggest losses (by loss, then depth), stable. */
export function topByLoss<T extends { loss: number; depth: number }>(items: readonly T[], n = 10): T[] {
  return [...items]
    .sort((a, b) => (Number.isFinite(b.loss) ? b.loss : -1) - (Number.isFinite(a.loss) ? a.loss : -1) || b.depth - a.depth)
    .slice(0, n);
}
