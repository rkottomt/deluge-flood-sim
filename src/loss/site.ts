/**
 * Site check: due diligence on a parcel — a planned building somewhere on the map, checked against the flood that was
 * run (one scenario) or against a ladder of event levels (the sweep), with an indicative finished-floor elevation,
 * the mitigation options and what they are worth, and a plain-language verdict. Pure: no DOM, no GPU.
 *
 *   SiteSpec          what the user typed: where (a pin or an outline, in lon/lat), planned use, floors, value …
 *   assessSiteRun     one site in one flood (HazardFields): portfolio-model loss + water-surface elevation + egress
 *   summarizeSweep    the site across the ladder: first level that reaches it / enters the floor / cuts egress, EAL
 *   recommendFfe      design water surface + freeboard (ASCE 24-14 Table 2-1 by Flood Design Class)
 *   mitigationOptions elevate / perimeter wall / levee / dry floodproofing: avoided EAL, cost (walls only), BCR
 *   siteVerdict       the sentences, each one with the number it rests on (siteVerdictParts: the same, by part)
 *   siteFact          one of those facts as caption text for a narrated story (src/story/captions.ts {site:…})
 *   encodeSites / decodeSites   the ?sites= link parameter (strict parser: link text is attacker-controlled)
 *
 * Everything is INDICATIVE. The flood is a bare-earth 2-D simulation of a level held at a boundary, the return periods
 * come from the ladder's sources or the user, and the costs are the planning unit costs in eal.ts (walls only). No
 * number here replaces a FIRM/BFE lookup, a survey, or an engineer.
 */
import type { HazardFields, Shelter } from '../contracts';
import type { HeightProfile } from '../data/buildings';
import { cleanPlaceLabel } from '../data/placeName';
import type { AccessIndex } from './access';
import { curveForOccupancy, OCCUPANCY_PROFILES, storeyHeightFor, type Occupancy } from './value';
import { bcr, ealRange, mitigationCost, upv, DISCOUNT_RATE_FEMA, DISCOUNT_RATE_LOW, type LossPoint, type MitigationType } from './eal';
import { defaultUsefulLife, type UsefulLifeKind } from './bca';
import { analyzeEgress, type EgressResult, type EgressRouter, type FloodTimeline } from './egress';
import { clearanceSentence, shareOutSentence, type EgressTiming } from './egressTiming';
import { openCells } from './footprints';
import { assessAsset, sampleCells, DAMAGE_MIN_DEPTH, type AssetSpec, type CellSample } from './impact';
import { assessSite, type PortfolioResult } from './portfolio';
import type { Curve } from './curves';
import type { Region } from './region';

// ─── The site ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Planned uses offered in the form (a subset of the portfolio occupancies that a developer plans). */
export const SITE_OCCUPANCIES = ['res', 'apt', 'retail', 'office', 'warehouse', 'industrial', 'hospital', 'school', 'datacenter', 'civic', 'other'] as const satisfies readonly Occupancy[];
export type SiteOccupancy = (typeof SITE_OCCUPANCIES)[number];

export const SITE_LIMITS = {
  maxSites: 8,
  /** Most outline corners kept (a drawn lasso is simplified to fewer). */
  maxRing: 64,
  maxFloors: 100,
  maxValue: 1e11,
  maxFootprintM2: 1e6,
  maxFirstFloorM: 10,
  maxCriticalM: 30,
  nameChars: 40,
  /** Longest ?sites= value read. */
  maxParamChars: 6000,
} as const;

export interface SiteSpec {
  /** Stable within the session ('s1', 's2' …). */
  id: string;
  name: string;
  /** The pin, or the centroid of the outline. */
  lon: number;
  lat: number;
  /** Parcel outline as [lon, lat, lon, lat, …] (open ring), or null for a pin. */
  ring: number[] | null;
  occupancy: SiteOccupancy;
  floors: number;
  /** Planned structure replacement value, USD; null → estimated from floor area × unit cost. */
  value: number | null;
  /** Building footprint, m²; null → the outline's area, or a typical footprint for a pin. */
  footprintM2: number | null;
  /** Finished first floor above grade, m; null → defaultFirstFloorHeight(occupancy). */
  firstFloorHeight: number | null;
  /** Critical equipment (switchgear, servers) above grade, m; null = not given. */
  criticalElev: number | null;
  /**
   * The name the geocoder gave the place ("Check an address": the street address the user typed, cleaned). Shown on
   * screen in this tab only: while the site still carries it, links (?sites=, encodeSites) leave the name out — they
   * carry coordinates, never the address. Renaming the site makes the name the user's own again.
   */
  geocodedName?: string;
}

/**
 * Default finished-floor height above grade for a planned building: 0.3 m (1 ft), a slab-on-grade first floor — the
 * USACE EGM 01-03 slab default (curves.ts USACE_FFH_SLAB_FT) and the spec's E.1 "0.3 slab". [I] for non-residential
 * uses, where loading docks and at-grade entrances vary widely: type the real one in.
 */
export const DEFAULT_FIRST_FLOOR_M = 0.3;
export function defaultFirstFloorHeight(_occ: Occupancy): number {
  return DEFAULT_FIRST_FLOOR_M;
}

/**
 * Typical building footprint for a PIN, m² — only used when the user gives neither a footprint nor an outline, to
 * estimate a value (floor area × unit cost) and a wall length. Round planning numbers [I], shown as "typical".
 */
export const TYPICAL_FOOTPRINT_M2: Readonly<Record<SiteOccupancy, number>> = {
  res: 180,
  apt: 1200,
  retail: 1500,
  office: 2000,
  warehouse: 15000,
  industrial: 8000,
  hospital: 12000,
  school: 5000,
  datacenter: 6000,
  civic: 2500,
  other: 1500,
};

export function newSite(id: string, lon: number, lat: number, ring: number[] | null = null): SiteSpec {
  return { id, name: '', lon, lat, ring, occupancy: 'office', floors: 3, value: null, footprintM2: null, firstFloorHeight: null, criticalElev: null };
}

/** Shoelace area of a grid ring, m². */
export function ringAreaM2(gridRing: ArrayLike<number>, cellSize: number): number {
  let a = 0;
  const n = gridRing.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (gridRing[2 * j] + gridRing[2 * i]) * (gridRing[2 * j + 1] - gridRing[2 * i + 1]);
  return (Math.abs(a) / 2) * cellSize * cellSize;
}

/** Perimeter of a closed grid ring, m. */
export function ringPerimeterM(gridRing: ArrayLike<number>, cellSize: number): number {
  let p = 0;
  const n = gridRing.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) p += Math.hypot(gridRing[2 * i] - gridRing[2 * j], gridRing[2 * i + 1] - gridRing[2 * j + 1]);
  return p * cellSize;
}

/** Wall set back from a pin's typical footprint on every side, m (room for a path inside the wall). */
export const PIN_WALL_SETBACK_M = 5;

export interface SiteGeometry {
  gx: number;
  gy: number;
  gridRing: number[] | null;
  footprintM2: number;
  footprintSource: 'given' | 'outline' | 'typical';
  /** Length of a wall around the site, m: the outline's perimeter, or a square around the footprint + setback. */
  perimeterM: number;
}

export function siteGeometry(spec: SiteSpec, toGrid: (lon: number, lat: number) => [number, number], cellSize: number): SiteGeometry {
  const [gx, gy] = toGrid(spec.lon, spec.lat);
  let gridRing: number[] | null = null;
  if (spec.ring && spec.ring.length >= 6) {
    gridRing = [];
    for (let i = 0; i + 1 < spec.ring.length; i += 2) gridRing.push(...toGrid(spec.ring[i], spec.ring[i + 1]));
  }
  const outline = gridRing ? ringAreaM2(gridRing, cellSize) : 0;
  let footprintM2: number;
  let footprintSource: SiteGeometry['footprintSource'];
  if (spec.footprintM2 != null && spec.footprintM2 > 0) {
    footprintM2 = spec.footprintM2;
    footprintSource = 'given';
  } else if (outline > 0) {
    footprintM2 = outline;
    footprintSource = 'outline';
  } else {
    footprintM2 = TYPICAL_FOOTPRINT_M2[spec.occupancy];
    footprintSource = 'typical';
  }
  const perimeterM = gridRing ? ringPerimeterM(gridRing, cellSize) : 4 * (Math.sqrt(footprintM2) + 2 * PIN_WALL_SETBACK_M);
  return { gx, gy, gridRing, footprintM2, footprintSource, perimeterM };
}

// ─── One site in one flood ──────────────────────────────────────────────────────────────────────────────────────────

export interface SiteRun {
  siteId: string;
  /** Outside the map (nothing assessed). */
  outside: boolean;
  result: PortfolioResult | null;
  geometry: SiteGeometry;
  /** Lowest bare-earth ground over the site's cells, m above the vertical datum (NAVD88 for USGS presets). */
  grade: number;
  /** Highest water surface over the site's cells (ground + max depth, wet cells only), m; NaN when dry. */
  wse: number;
  /** Planned first-floor height used, m above grade. */
  firstFloorHeight: number;
  egress: EgressResult | null;
  /** Inputs to recompute the loss with another floor height (mitigation options). */
  sample: CellSample;
  assetSpec: AssetSpec | null;
  curve: Curve | null;
  debrisFlow: boolean;
  alertTime: number;
  simTime: number;
}

export interface SiteRunContext {
  region: Region;
  grid: { nx: number; ny: number; cellSize: number };
  toGrid: (lon: number, lat: number) => [number, number];
  /** Bare-earth ground, nx·ny. */
  ground: Float32Array;
  heightProfile?: HeightProfile;
  debrisFlow?: boolean;
  alertTime?: number;
  access?: AccessIndex | null;
  /** Router carrying this grid's road network; null = egress not assessed. */
  router?: EgressRouter | null;
  shelters?: readonly Shelter[];
  hasRoads?: boolean;
  timeline?: FloodTimeline;
  /** Depth at the end of the run (latest snapshot), to tell "still cut off" from "reopened". */
  endDepth?: Float32Array | null;
}

export function assessSiteRun(spec: SiteSpec, fields: HazardFields, ctx: SiteRunContext): SiteRun {
  const geom = siteGeometry(spec, ctx.toGrid, ctx.grid.cellSize);
  const ffh = spec.firstFloorHeight ?? defaultFirstFloorHeight(spec.occupancy);
  const floors = Math.max(1, Math.min(SITE_LIMITS.maxFloors, Math.round(spec.floors) || 1));
  const result = assessSite(
    {
      id: spec.id,
      name: spec.name,
      gx: geom.gx,
      gy: geom.gy,
      gridRing: geom.gridRing,
      occupancy: spec.occupancy,
      floors,
      gfaM2: geom.footprintM2 * floors,
      replacementValue: spec.value,
      firstFloorHeight: ffh,
      criticalElev: spec.criticalElev,
    },
    fields,
    { region: ctx.region, set: null, fp: null, heightProfile: ctx.heightProfile, debrisFlow: ctx.debrisFlow, alertTime: ctx.alertTime, access: ctx.access ?? null, grid: ctx.grid, toGrid: ctx.toGrid },
  );
  const empty: CellSample = { sampled: 0, reachedCells: 0, maxDepth: 0, maxSpeed: 0, maxDV: 0, structSpeed: 0, structDV: 0, firstWet: -1, wetSeconds: 0 };
  const run: SiteRun = {
    siteId: spec.id,
    outside: !result,
    result,
    geometry: geom,
    grade: NaN,
    wse: NaN,
    firstFloorHeight: ffh,
    egress: null,
    sample: empty,
    assetSpec: null,
    curve: null,
    debrisFlow: !!ctx.debrisFlow,
    alertTime: ctx.alertTime ?? 0,
    simTime: fields.simTime,
  };
  if (!result) return run;
  const cells = result.m.cells;
  run.sample = sampleCells(fields, cells);
  let grade = Infinity;
  let wse = -Infinity;
  for (const c of cells) {
    const g = ctx.ground[c];
    if (g < grade) grade = g;
  }
  // The water surface is read where water can stand: around the walls when buildings are obstacles (as sampleCells does).
  const wet = (fields.blocked && openCells(cells, 0, cells.length, fields.blocked, fields.nx, fields.ny)) || cells;
  for (const c of wet) {
    if (fields.firstWet[c] !== 0 && fields.maxDepth[c] > 0.01) wse = Math.max(wse, ctx.ground[c] + fields.maxDepth[c]);
  }
  run.grade = Number.isFinite(grade) ? grade : NaN;
  run.wse = Number.isFinite(wse) ? wse : NaN;
  run.assetSpec = {
    occ: result.occ,
    floors: result.floors,
    storeyHeight: storeyHeightFor(result.floors, ctx.heightProfile ?? 'us'),
    structure: result.valueStructure,
    contents: result.valueContents,
    construction: null,
    firstFloorHeight: ffh,
    criticalElev: spec.criticalElev,
  };
  run.curve = curveForOccupancy(result.occ, ctx.region.continent);
  if (ctx.router && ctx.shelters) {
    run.egress = analyzeEgress(ctx.router, fields, { gx: geom.gx, gy: geom.gy }, ctx.shelters, { timeline: ctx.timeline, endDepth: ctx.endDepth, hasRoads: ctx.hasRoads });
  }
  return run;
}

/** Loss of a site run had the first floor been `ffh` m above grade (same water, same values). NaN without values. */
export function lossAtFloor(run: SiteRun, ffh: number): number {
  if (!run.result || !run.assetSpec || !run.curve) return 0;
  return assessAsset(run.sample, { ...run.assetSpec, firstFloorHeight: ffh }, { curve: run.curve, debrisFlow: run.debrisFlow, alertTime: run.alertTime }, null).loss;
}

/** Water above the planned first floor, m (negative = below it). NaN when the site is dry or outside. */
export function depthAboveFloor(run: SiteRun): number {
  return run.result && run.result.reached ? run.result.depthAboveFloor : NaN;
}

// ─── The sweep ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** One rung of the sweep as it was run. */
export interface SweepLevelInfo {
  id: string;
  label: string;
  /** Gauge reading, ft (stage ladders); NaN for forcing-multiplier ladders. */
  ft: number;
  /** Forcing multiplier (scale ladders); NaN for stage ladders. */
  scale: number;
  /** Uniform rain rate, mm/h (rain ladders: NOAA Atlas 14 1-hour intensity); absent otherwise. */
  rainMmH?: number;
  returnPeriod: number | null;
  /** 'source' = from the ladder's citation; 'user' = typed by the user; null = none. */
  rpFrom: 'source' | 'user' | null;
  /** Simulated duration of the run, s. */
  durationS: number;
}

export interface SweepRow {
  level: SweepLevelInfo;
  run: SiteRun;
}

export interface SweepSummary {
  /** Rows ordered by level (mildest first). */
  rows: SweepRow[];
  /** First level whose water reaches the site (≥ 15 cm), or null. */
  firstReached: SweepRow | null;
  /** First level with water at least DAMAGE_MIN_DEPTH above the planned floor, or null. */
  firstInside: SweepRow | null;
  /** First level whose run cuts every route to a shelter, or null. */
  firstCutOff: SweepRow | null;
  /** Loss points (levels with a return period). */
  points: LossPoint[];
  /** EAL without and with the tail term (null with no return periods). */
  eal: { low: number; high: number } | null;
  /** Some return periods are the user's. */
  userReturnPeriods: boolean;
}

const levelOrder = (r: SweepRow) => (Number.isFinite(r.level.ft) ? r.level.ft : r.level.rainMmH != null && Number.isFinite(r.level.rainMmH) ? r.level.rainMmH : r.level.scale);

/**
 * Is this return period the 1 %-annual-chance level? Judged by its annual exceedance probability 1 / T, which must lie
 * between the 100-yr partial-duration ARI's (Langbein: 1 − e^(−1/100) = 0.995 %, T = 100.5 yr — ladders.ts
 * annualReturnPeriod, the Atlas 14 rain ladder's 100-yr level) and 1 % itself (T = 100, a stage-frequency source),
 * both included, with a part-per-million allowance for rounding (100.5 as displayed counts). A 99-yr (1.01 %) or
 * 101-yr (0.990 %) level is a different event and does not count.
 */
const ONE_PERCENT_AEP_LOW = 1 - Math.exp(-1 / 100);
export function isOnePercent(T: number | null | undefined): boolean {
  if (T == null || !Number.isFinite(T) || !(T > 0)) return false;
  const aep = 1 / T;
  return aep >= ONE_PERCENT_AEP_LOW * (1 - 1e-6) && aep <= 0.01 * (1 + 1e-6);
}

/**
 * A return period for display: whole years as they are; anything else to one decimal below 1,000 years — a rain
 * ladder's Langbein-converted ARI reads "100.5", not a rounded-up "101".
 */
export function formatReturnPeriod(T: number): string {
  if (!Number.isFinite(T)) return '—';
  if (Math.abs(T - Math.round(T)) < 0.05 || T >= 1000) return Math.round(T).toLocaleString('en-US');
  return T.toFixed(1);
}

export function summarizeSweep(rows: readonly SweepRow[]): SweepSummary {
  const sorted = [...rows].sort((a, b) => levelOrder(a) - levelOrder(b));
  const reached = (r: SweepRow) => !!r.run.result?.reached;
  const inside = (r: SweepRow) => depthAboveFloor(r.run) >= DAMAGE_MIN_DEPTH;
  const cut = (r: SweepRow) => !!r.run.egress?.known && r.run.egress.openAtStart && !r.run.egress.openAtPeak;
  const points: LossPoint[] = [];
  for (const r of sorted) {
    const T = r.level.returnPeriod;
    const L = r.run.result?.loss;
    if (T != null && T > 0 && L != null && Number.isFinite(L)) points.push({ T, loss: L });
  }
  return {
    rows: sorted,
    firstReached: sorted.find(reached) ?? null,
    firstInside: sorted.find(inside) ?? null,
    firstCutOff: sorted.find(cut) ?? null,
    points,
    eal: points.length ? ealRange(points) : null,
    userReturnPeriods: sorted.some((r) => r.level.rpFrom === 'user' && r.level.returnPeriod != null),
  };
}

/** Exceedance curve for a chart: (annual exceedance probability, loss), most frequent first. */
export function exceedanceCurve(points: readonly LossPoint[]): Array<{ p: number; T: number; loss: number }> {
  return [...points].filter((x) => x.T > 0).sort((a, b) => a.T - b.T).map((x) => ({ p: 1 / x.T, T: x.T, loss: x.loss }));
}

// ─── Finished-floor elevation ───────────────────────────────────────────────────────────────────────────────────────

const FT = 0.3048;

/**
 * Freeboard by ASCE 24-14 Flood Design Class, Zone A (FEMA, "Highlights of ASCE 24-14", Table 2-1): Class 2 (most
 * residential, commercial and industrial buildings) and Class 3 (schools, nursing homes) "BFE +1 ft or DFE, whichever
 * is higher"; Class 4 (hospitals with surgery or emergency treatment, fire / police / ambulance, emergency shelters)
 * "BFE +2 ft or DFE, or 500-year flood elevation, whichever is higher". The NFIP minimum (44 CFR 60.3(c)) is the base
 * flood level with no freeboard. A data centre is not Class 4 by definition but is usually treated as critical [I].
 */
export function freeboardFor(occ: Occupancy): { m: number; ft: number; basis: string } {
  if (occ === 'hospital') return { m: 2 * FT, ft: 2, basis: 'ASCE 24-14 Flood Design Class 4 (hospitals): BFE + 2 ft, or the 500-yr elevation if higher' };
  if (occ === 'school') return { m: 1 * FT, ft: 1, basis: 'ASCE 24-14 Flood Design Class 3 (schools): BFE + 1 ft' };
  return { m: 1 * FT, ft: 1, basis: 'ASCE 24-14 Flood Design Class 2 (most residential, commercial, industrial): BFE + 1 ft' };
}

/**
 * Why the design level is the one it is: '100-yr' — it is the 1 % (100-yr) level; 'selected' — the user chose another
 * level; 'highest' — no 1 % level was run, so the highest level run stands in.
 */
export type DesignBasis = '100-yr' | 'selected' | 'highest';

export interface FfeRecommendation {
  designLabel: string;
  designBasis: DesignBasis;
  /**
   * The 1 % (100-yr) level when it was run but is not the design level (the user chose another): its label and its
   * water surface at the site, m above datum (NaN when it does not reach the site). Null otherwise.
   */
  onePercent: { label: string; wse: number } | null;
  /** Design water surface at the site, m above datum; NaN when the design event does not reach the site. */
  designWse: number;
  grade: number;
  freeboardM: number;
  freeboardBasis: string;
  /** Recommended finished-floor elevation, m above datum (grade + planned floor height when the site stays dry). */
  ffe: number;
  /** …as height above the lowest grade, m. */
  ffeAboveGrade: number;
  plannedFloorM: number;
  /** How much higher than planned, m (≤ 0: the planned floor already clears it). */
  raiseBy: number;
}

export function recommendFfe(design: SweepRow, basis: DesignBasis, occ: Occupancy, freeboardM?: number, onePercent?: SweepRow | null): FfeRecommendation | null {
  const run = design.run;
  if (!run.result || !Number.isFinite(run.grade)) return null;
  const fb = freeboardFor(occ);
  const freeboard = freeboardM ?? fb.m;
  const wet = run.result.reached && Number.isFinite(run.wse);
  const ffe = wet ? run.wse + freeboard : run.grade + run.firstFloorHeight;
  const above = ffe - run.grade;
  return {
    designLabel: design.level.label,
    designBasis: basis,
    onePercent:
      onePercent && onePercent !== design
        ? { label: onePercent.level.label, wse: onePercent.run.result?.reached && Number.isFinite(onePercent.run.wse) ? onePercent.run.wse : NaN }
        : null,
    designWse: wet ? run.wse : NaN,
    grade: run.grade,
    freeboardM: freeboard,
    freeboardBasis: freeboardM != null && Math.abs(freeboardM - fb.m) > 1e-6 ? `${fmt(freeboardM / FT, 1)} ft chosen by the user` : fb.basis,
    ffe,
    ffeAboveGrade: above,
    plannedFloorM: run.firstFloorHeight,
    raiseBy: above - run.firstFloorHeight,
  };
}

/**
 * What the design event is and why, for the recommendation's "Design event" line — and, when the user designs to
 * another level, what the 1 % level that was also run gives at the site.
 */
export function designEventText(rec: FfeRecommendation): string {
  const op = rec.onePercent;
  const opText = op ? `${op.label}: ${Number.isFinite(op.wse) ? `water surface ${fmt(op.wse, 2)} m above datum` : 'does not reach the site'}` : '';
  if (rec.designBasis === '100-yr') return `${rec.designLabel} — the 1 %-annual-chance level`;
  if (rec.designBasis === 'selected') return `${rec.designLabel} — your selection; ${op ? `the 1 % level was also run (${opText})` : 'no 1 % level was run'}`;
  return `${rec.designLabel} — the highest level run, as no published 1 % level was run${op ? `; the level you gave a 100-yr return period was also run (${opText})` : ''}`;
}

/**
 * The design row: the user's selection, else the ladder's published 1 % (100-yr) level when it was run, else the
 * highest level. `onePercent` is the 1 % level that was run (a published one first, else one with a typed-in 100-yr
 * return period), whichever row is the design — so the text can say it was run when the user designs to another one.
 */
export function pickDesign(rows: readonly SweepRow[], selectedId: string | null): { row: SweepRow; basis: DesignBasis; onePercent: SweepRow | null } | null {
  if (!rows.length) return null;
  const rp100 = rows.find((r) => isOnePercent(r.level.returnPeriod) && r.level.rpFrom === 'source');
  const onePercent = rp100 ?? rows.find((r) => isOnePercent(r.level.returnPeriod)) ?? null;
  const sel = selectedId ? rows.find((r) => r.level.id === selectedId) : undefined;
  if (sel) return { row: sel, basis: isOnePercent(sel.level.returnPeriod) ? '100-yr' : 'selected', onePercent };
  if (rp100) return { row: rp100, basis: '100-yr', onePercent };
  const top = [...rows].sort((a, b) => levelOrder(b) - levelOrder(a))[0];
  return { row: top, basis: 'highest', onePercent };
}

// ─── Mitigation options ──────────────────────────────────────────────────────────────────────────────────────────────

/** FEMA TB-3: dry floodproofing is not recommended where base-flood water is deeper than 3 ft (or faster than 5 ft/s). */
export const DRY_FLOODPROOF_MAX_M = 3 * FT;
export const DRY_FLOODPROOF_MAX_SPEED = 5 * FT;

export type SiteMitigationKind = 'elevate' | 'floodwall' | 'earthen' | 'dryproof';

export interface SiteMitigation {
  kind: SiteMitigationKind;
  label: string;
  /** What is assumed, one sentence. */
  assumption: string;
  heightM: number;
  lengthM: number;
  /** Planning cost (walls only); null when no unit cost exists here. */
  cost: { mid: number; low: number; high: number; perMetre: number } | null;
  ealAfter: { low: number; high: number } | null;
  /** Avoided EAL (mid of the with/without-tail range). */
  deltaEal: number;
  /** BCR at 7 % and 3.1 % over the useful life, on the cost's mid, low and high; null without a cost or EAL. */
  bcr7: { mid: number; low: number; high: number } | null;
  bcr3: { mid: number; low: number; high: number } | null;
  /** Most it could cost and still break even at 7 % over the useful life (PV of the avoided EAL). */
  breakEvenCapex7: number;
  /** The useful life the BCR and break-even use, years: FEMA's standard value for the option, or the caller's. */
  usefulLifeYears: number;
  /** Why it may not apply (empty when nothing stands out). */
  caveats: string[];
  applicable: boolean;
}

export interface MitigationContext {
  occ: Occupancy;
  rec: FfeRecommendation;
  /** Cost table country (eal.ts mitigationCost). */
  country: 'US' | 'IN' | 'NP' | null;
  perimeterM: number;
  /** One useful life for every option, years; absent = FEMA's standard value per option (bca.ts USEFUL_LIFE). */
  years?: number;
}

const mid = (r: { low: number; high: number }) => (r.low + r.high) / 2;

function ealWith(sum: SweepSummary, lossOf: (r: SweepRow) => number): { low: number; high: number } | null {
  const pts: LossPoint[] = [];
  for (const r of sum.rows) {
    const T = r.level.returnPeriod;
    if (T != null && T > 0 && r.run.result) {
      const L = lossOf(r);
      if (Number.isFinite(L)) pts.push({ T, loss: L });
    }
  }
  return pts.length ? ealRange(pts) : null;
}

export function mitigationOptions(sum: SweepSummary, m: MitigationContext): SiteMitigation[] {
  const base = sum.eal;
  const rec = m.rec;
  const residential = m.occ === 'res' || m.occ === 'apt';
  const out: SiteMitigation[] = [];
  const finish = (o: Omit<SiteMitigation, 'deltaEal' | 'bcr7' | 'bcr3' | 'breakEvenCapex7' | 'usefulLifeYears'>, life: UsefulLifeKind): SiteMitigation => {
    const years = m.years ?? defaultUsefulLife(life);
    const delta = base && o.ealAfter ? Math.max(0, mid(base) - mid(o.ealAfter)) : NaN;
    const ratio = (rate: number) => {
      if (!o.cost || !Number.isFinite(delta)) return null;
      const f = (capex: number) => bcr({ deltaEal: delta, capex, rate, years }).bcr;
      return { mid: f(o.cost.mid), low: f(o.cost.high), high: f(o.cost.low) };
    };
    return { ...o, deltaEal: delta, bcr7: ratio(DISCOUNT_RATE_FEMA), bcr3: ratio(DISCOUNT_RATE_LOW), breakEvenCapex7: Number.isFinite(delta) ? delta * upv(DISCOUNT_RATE_FEMA, years) : NaN, usefulLifeYears: years };
  };

  // 1. Elevate the finished floor to the recommendation.
  out.push(
    finish({
      kind: 'elevate',
      label: 'Raise the finished floor',
      assumption: `First floor at ${fmt(rec.ffeAboveGrade, 2)} m above grade instead of ${fmt(rec.plannedFloorM, 2)} m; same building, same water.`,
      heightM: rec.ffeAboveGrade,
      lengthM: 0,
      cost: null,
      ealAfter: ealWith(sum, (r) => lossAtFloor(r.run, Math.max(rec.ffeAboveGrade, r.run.firstFloorHeight))),
      caveats: rec.raiseBy <= 0.01 ? ['The planned floor already clears the design level.'] : ['Cost of fill / a raised slab is not estimated here; at the design stage it is usually a fraction of the building.'],
      applicable: rec.raiseBy > 0.01,
    }, residential ? 'elevationResidential' : 'elevationNonResidential'),
  );

  // 2–3. A wall or levee around the site, tall enough for the design water + freeboard.
  const wallH = Number.isFinite(rec.designWse) ? Math.max(0.3, rec.designWse + rec.freeboardM - rec.grade) : 0;
  const top = rec.grade + wallH;
  const protectedLoss = (r: SweepRow) => (Number.isFinite(r.run.wse) && r.run.wse > top ? (r.run.result?.loss ?? 0) : 0);
  for (const kind of ['floodwall', 'earthen'] as const satisfies readonly MitigationType[]) {
    const cost = wallH > 0 ? mitigationCost(kind, m.perimeterM, wallH, m.country) : null;
    const caveats = [
      'Overtopped levels are booked at their full loss; gates, interior drainage and pumps are not costed.',
      'A wall keeps water off the building, not off the access roads.',
    ];
    if (kind === 'earthen') caveats.push(`Needs a strip about ${fmt(3 + 6 * wallH, 0)} m wide (3 m crest, 3:1 slopes) all round — rarely available on an urban parcel.`);
    out.push(
      finish({
        kind,
        label: kind === 'floodwall' ? 'Floodwall around the site' : 'Earthen levee around the site',
        assumption: `${fmt(m.perimeterM, 0)} m long, ${fmt(wallH, 1)} m high (design water + freeboard above the lowest grade).`,
        heightM: wallH,
        lengthM: m.perimeterM,
        cost: cost ? { mid: cost.mid, low: cost.low, high: cost.high, perMetre: cost.perMetre } : null,
        ealAfter: ealWith(sum, protectedLoss),
        caveats,
        applicable: wallH > 0,
      }, kind),
    );
  }

  // 4. Dry floodproofing (non-residential only).
  const designAbove = Number.isFinite(rec.designWse) ? rec.designWse - (rec.grade + rec.plannedFloorM) : NaN;
  const designSpeed = sum.rows.find((r) => r.level.label === rec.designLabel)?.run.result?.speed ?? NaN;
  const dpCaveats: string[] = [];
  if (residential) dpCaveats.push('The NFIP does not permit dry floodproofing of residential buildings in Zone A (FEMA TB-3).');
  if (designAbove > DRY_FLOODPROOF_MAX_M) dpCaveats.push(`Design water is ${fmt(designAbove, 1)} m above the floor; FEMA TB-3 does not recommend dry floodproofing beyond 3 ft (0.9 m).`);
  if (designSpeed > DRY_FLOODPROOF_MAX_SPEED) dpCaveats.push('Design flow is faster than 5 ft/s, where FEMA TB-3 does not recommend it.');
  dpCaveats.push('NFIP rating credit needs the floodproofing certified to at least 1 ft above the BFE. Cost not estimated here.');
  out.push(
    finish({
      kind: 'dryproof',
      label: 'Dry floodproofing (sealed walls, shields)',
      assumption: `Keeps water out up to ${fmt(DRY_FLOODPROOF_MAX_M, 1)} m above the floor; deeper water is booked at the full loss.`,
      heightM: DRY_FLOODPROOF_MAX_M,
      lengthM: 0,
      cost: null,
      ealAfter: ealWith(sum, (r) => (depthAboveFloor(r.run) > DRY_FLOODPROOF_MAX_M ? (r.run.result?.loss ?? 0) : 0)),
      caveats: dpCaveats,
      applicable: !residential && Number.isFinite(designAbove) && designAbove > 0,
    }, 'dryFloodproofing'),
  );
  return out;
}

// ─── Verdict ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function fmt(v: number, d = 0): string {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 10 ** d) / 10 ** d;
  return r.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtMinutes(s: number): string {
  if (!Number.isFinite(s)) return '—';
  const m = Math.round(Math.abs(s) / 60);
  if (m < 90) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

const levelName = (r: SweepRow) =>
  Number.isFinite(r.level.ft) ? `${r.level.label} (${fmt(r.level.ft, 1)} ft)` : r.level.rainMmH != null && Number.isFinite(r.level.rainMmH) ? `${r.level.label} (${fmt(r.level.rainMmH, 0)} mm/h)` : r.level.label;

/** Egress against arrival at the site, one clause. */
export function egressClause(run: SiteRun): string {
  const e = run.egress;
  if (!e) return 'egress not assessed';
  if (!e.known) return `egress not assessed (${e.note.replace(/\.$/, '').toLowerCase()})`;
  if (!e.openAtStart) return 'no road route to a shelter even before the flood';
  if (e.openAtPeak) return `a dry route to ${e.peakShelter || 'a shelter'} stays open`;
  const closes = e.lastRouteClosesAt;
  const fw = run.result?.reached ? run.result.firstWet : NaN;
  let s = `the last route to a shelter closes at T+${fmtMinutes(closes)}`;
  if (Number.isFinite(fw) && fw > 0 && Number.isFinite(closes)) {
    const d = fw - closes;
    s += Math.abs(d) < 60 ? ', as water reaches the site' : d > 0 ? `, ${fmtMinutes(d)} before water reaches the site` : `, ${fmtMinutes(-d)} after water reaches the site`;
  } else if (!run.result?.reached) {
    s += ' while the site itself stays dry — it becomes an island';
  }
  if (e.cutAtEnd === true) s += e.cutOffAtLeastS >= 60 ? `; still cut off at the end of the run (at least ${fmtMinutes(e.cutOffAtLeastS)})` : "; still cut off at the end of the run";
  else if (e.cutAtEnd === false) s += '; a route is open again by the end of the run';
  return s;
}

/** The verdict's sentences by what they say (siteVerdict puts them in this order). */
export interface SiteVerdictParts {
  /** Where water first reaches the site, or that it stays dry. */
  reach: string;
  /** Whether the planned floor floods, and from which level (null when the site stays dry). */
  floor: string | null;
  /** When the way out closes against when the water arrives, or that it stays open. */
  egress: string;
  /** Who gets out before the route closes, with the departure curve and the queue (null without egress timing). */
  timing: string | null;
  /** The EAL and what it rests on (one or two sentences). */
  eal: string[];
}

/**
 * The verdict, as sentences that each carry their number. No score: what reaches the site, from which level; whether
 * the planned floor stays dry; when the way out closes against when the water arrives; and the EAL with what it rests on.
 */
export function siteVerdict(siteName: string, sum: SweepSummary, money: (v: number) => string, timingOf?: (run: SiteRun) => EgressTiming | null): string[] {
  const p = siteVerdictParts(siteName, sum, money, timingOf);
  if (!p) return ['No levels have been run yet.'];
  return [p.reach, ...(p.floor ? [p.floor] : []), p.egress, ...(p.timing ? [p.timing] : []), ...p.eal];
}

/** The verdict's sentences by part; null before any level has run. */
export function siteVerdictParts(siteName: string, sum: SweepSummary, money: (v: number) => string, timingOf?: (run: SiteRun) => EgressTiming | null): SiteVerdictParts | null {
  const rows = sum.rows;
  if (!rows.length) return null;
  const name = siteName || 'The site';
  const top = rows[rows.length - 1];
  let reach: string;
  let floor: string | null = null;
  if (!sum.firstReached) {
    reach = `${name} stays dry at every level run, up to the ${levelName(top)}.`;
  } else {
    const r = sum.firstReached;
    const i = rows.indexOf(r);
    const res = r.run.result!;
    reach = `Water reaches ${name === 'The site' ? 'the site' : name} at the ${levelName(r)}: ${fmt(res.depth, 2)} m at the lowest grade.`;
    if (i > 0) reach += ` Dry at the ${levelName(rows[i - 1])} and below.`;
    if (sum.firstInside) {
      const f = sum.firstInside;
      floor = `It floods the planned floor (${fmt(f.run.firstFloorHeight, 2)} m above grade) from the ${levelName(f)}, with ${fmt(depthAboveFloor(f.run), 2)} m inside; damage ${fmt((f.run.result?.damage ?? 0) * 100, 0)} %, about ${money(f.run.result?.loss ?? NaN)}.`;
    } else {
      floor = `The planned floor (${fmt(top.run.firstFloorHeight, 2)} m above grade) stays above the water at every level run.`;
    }
  }
  let egress: string;
  if (sum.firstCutOff) {
    egress = `Dry access is lost from the ${levelName(sum.firstCutOff)}: ${egressClause(sum.firstCutOff.run)}.`;
  } else {
    const anyKnown = rows.some((r) => r.run.egress?.known);
    egress = anyKnown ? `A dry road route to a shelter stays open at every level run (up to the ${levelName(top)}).` : `Egress was not assessed: ${egressClause(top.run)}.`;
  }
  // Who actually gets out: the departure curve and the queue at the exit, at the first level that cuts the route
  // (or the highest level when none does).
  const timed = sum.firstCutOff ?? top;
  const t = timingOf?.(timed.run);
  const timing = t?.known ? `At the ${levelName(timed)}: ${shareOutSentence(t).replace(/^No /, 'no ')} ${clearanceSentence(t)}` : null;
  const eal: string[] = [];
  const lossNoRp = rows.filter((r) => r.level.returnPeriod == null && (r.run.result?.loss ?? 0) > 0);
  if (sum.eal && sum.eal.high === 0) {
    eal.push(
      (sum.points.length === 1
        ? 'Expected annual loss $0: the one level with a return period does not damage the planned building.'
        : `Expected annual loss $0: none of the ${sum.points.length} levels with a return period damages the planned building.`) +
        (lossNoRp.length ? ` The level${lossNoRp.length === 1 ? '' : 's'} that do${lossNoRp.length === 1 ? 'es' : ''} (${lossNoRp.map((r) => r.level.label).join(', ')}) ha${lossNoRp.length === 1 ? 's' : 've'} no published return period — enter one to count ${lossNoRp.length === 1 ? 'it' : 'them'}.` : ''),
    );
  } else if (sum.eal) {
    eal.push(
      `Expected annual loss ${money(sum.eal.low)} – ${money(sum.eal.high)} (without / with the tail beyond the rarest level), from ${sum.points.length} level${sum.points.length === 1 ? '' : 's'} with a return period${sum.userReturnPeriods ? ', some of them your input' : ''}.`,
    );
    if (sum.points.length === 1) eal.push('With a single return period the EAL rests on one point: the lower bound is 0 and the upper bound books that loss every year at 1/T. Add return periods for a usable figure.');
  } else {
    eal.push('No expected annual loss: none of the levels run has a return period. Enter one for each level you know (a gauge frequency analysis, FEMA FIS, NOAA Atlas 14).');
  }
  return { reach, floor, egress, timing, eal };
}

/** What a narrated story may quote about a swept site (src/story/captions.ts SITE_FACTS). */
export type SiteFactKey = 'name' | 'reach' | 'floor' | 'egress' | 'eal' | 'worst' | 'cutoff' | 'ffe' | 'ffe100';

/** An indicative floor, in one phrase: "4.32 m above the lowest grade (…), 4.02 m higher than planned". */
function ffePhrase(rec: FfeRecommendation, levelLabel: string): string {
  if (!Number.isFinite(rec.designWse)) return `the planned ${fmt(rec.plannedFloorM, 2)} m above grade — the ${levelLabel} does not reach the site`;
  const vs = rec.raiseBy > 0.01 ? `${fmt(rec.raiseBy, 2)} m higher than the planned ${fmt(rec.plannedFloorM, 2)} m` : `the planned ${fmt(rec.plannedFloorM, 2)} m already clears it`;
  return `${fmt(rec.ffeAboveGrade, 2)} m above the lowest grade — water at ${fmt(rec.designWse, 2)} m in the ${levelLabel}, plus ${fmt(rec.freeboardM, 2)} m of freeboard — ${vs}`;
}

/**
 * One fact about a swept site, as text for a story caption — the same sentences and numbers the panel shows, by part,
 * plus the worst level's depth and two indicative floors: `ffe` designed to the rarest level that reaches the site (the
 * flood of record on a historic ladder), `ffe100` to the 1 % level. Null when there is nothing to say (no sweep, no
 * 1 % level run, a site that stays dry has no `floor` sentence, no level cuts the way out).
 */
export function siteFact(siteName: string, sum: SweepSummary | null, occ: Occupancy, key: SiteFactKey, money: (v: number) => string): string | null {
  if (key === 'name') return siteName || null;
  if (!sum || !sum.rows.length) return null;
  const parts = siteVerdictParts(siteName, sum, money);
  if (!parts) return null;
  const rows = sum.rows;
  const top = rows[rows.length - 1];
  switch (key) {
    case 'reach':
      return parts.reach;
    case 'floor':
      return parts.floor;
    case 'egress':
      return parts.egress;
    case 'eal':
      return parts.eal[0] ?? null;
    case 'cutoff':
      return sum.firstCutOff ? `from the ${levelName(sum.firstCutOff)}, ${egressClause(sum.firstCutOff.run)}` : null;
    case 'worst': {
      const res = top.run.result;
      if (!res?.reached) return `dry at the ${levelName(top)}`;
      const inside = depthAboveFloor(top.run);
      return `${fmt(res.depth, 1)} m at the lowest grade${inside >= DAMAGE_MIN_DEPTH ? ` and ${fmt(inside, 1)} m above the planned floor` : ''} at the ${levelName(top)}, a loss of about ${money(res.loss)}`;
    }
    case 'ffe': {
      const wet = [...rows].reverse().find((r) => r.run.result?.reached) ?? top;
      const rec = recommendFfe(wet, 'selected', occ);
      return rec ? ffePhrase(rec, levelName(wet)) : null;
    }
    case 'ffe100': {
      const d = pickDesign(rows, null);
      if (!d || d.basis !== '100-yr') return null;
      const rec = recommendFfe(d.row, d.basis, occ);
      return rec ? ffePhrase(rec, levelName(d.row)) : null;
    }
  }
}

// ─── The ?sites= link parameter ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Format, one site per `;`:   v1:<lat,lon[,lat,lon…]>~<occupancy>~<floors>~<value>~<ffh>~<crit>~<footprint>~<name>
 * The first coordinate pair is the pin (or the centroid); more pairs are the outline. Empty field = not given. The
 * name is percent-encoded (so it cannot contain the separators) and cleaned again on the way in. Coordinates keep 6
 * decimals (≈ 0.1 m). The whole value is URL-encoded once more by URLSearchParams.
 *
 * Decoding is strict and bounded (length, site count, corner count, every number range-checked, occupancy from the
 * list): a bad site is dropped with a FIXED warning sentence — link text is never echoed into the UI.
 */
const SITE_PREFIX = 'v1:';
const num6 = (v: number) => String(Math.round(v * 1e6) / 1e6);
const numShort = (v: number | null) => (v == null || !Number.isFinite(v) ? '' : String(Math.round(v * 100) / 100));

export function encodeSites(sites: readonly SiteSpec[]): string {
  const parts = sites.slice(0, SITE_LIMITS.maxSites).map((s) => {
    const coords = [num6(s.lat), num6(s.lon)];
    if (s.ring) for (let i = 0; i + 1 < s.ring.length && i < SITE_LIMITS.maxRing * 2; i += 2) coords.push(num6(s.ring[i + 1]), num6(s.ring[i]));
    // encodeURIComponent leaves `~` alone (unreserved), and `~` is the field separator. A name that is still the
    // geocoder's (a street address) stays out of the link: the site reopens named by the app.
    const shared = s.geocodedName !== undefined && s.name === s.geocodedName ? '' : s.name;
    const name = encodeURIComponent(cleanPlaceLabel(shared, SITE_LIMITS.nameChars)).replace(/~/g, '%7E');
    return [coords.join(','), s.occupancy, String(Math.round(s.floors)), numShort(s.value === null ? null : Math.round(s.value)), numShort(s.firstFloorHeight), numShort(s.criticalElev), numShort(s.footprintM2), name].join('~');
  });
  return parts.length ? SITE_PREFIX + parts.join(';') : '';
}

const NUM_RE = /^-?\d{1,12}(\.\d{1,8})?$/;

function strictNum(s: string, lo: number, hi: number): number | null | undefined {
  if (s === '') return null;
  if (!NUM_RE.test(s)) return undefined;
  const v = Number(s);
  return Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
}

export function decodeSites(raw: string | null | undefined): { sites: SiteSpec[]; warnings: string[] } {
  const out: SiteSpec[] = [];
  const warnings: string[] = [];
  if (!raw) return { sites: out, warnings };
  if (raw.length > SITE_LIMITS.maxParamChars || !raw.startsWith(SITE_PREFIX)) {
    warnings.push('Ignoring a ?sites= link value that is not in the expected format.');
    return { sites: out, warnings };
  }
  const items = raw.slice(SITE_PREFIX.length).split(';');
  if (items.length > SITE_LIMITS.maxSites) warnings.push(`Only the first ${SITE_LIMITS.maxSites} sites of the link were read.`);
  let bad = 0;
  for (const item of items.slice(0, SITE_LIMITS.maxSites)) {
    const f = item.split('~');
    if (f.length !== 8) {
      bad++;
      continue;
    }
    const coords = f[0].split(',');
    if (coords.length < 2 || coords.length % 2 !== 0 || coords.length > 2 + SITE_LIMITS.maxRing * 2) {
      bad++;
      continue;
    }
    const xy: number[] = [];
    let ok = true;
    for (let i = 0; i < coords.length; i += 2) {
      const lat = strictNum(coords[i], -85, 85);
      const lon = strictNum(coords[i + 1], -180, 180);
      if (lat == null || lon == null) {
        ok = false;
        break;
      }
      xy.push(lon, lat);
    }
    const occ = f[1] as SiteOccupancy;
    const floors = strictNum(f[2], 1, SITE_LIMITS.maxFloors);
    const value = strictNum(f[3], 0, SITE_LIMITS.maxValue);
    const ffh = strictNum(f[4], 0, SITE_LIMITS.maxFirstFloorM);
    const crit = strictNum(f[5], 0, SITE_LIMITS.maxCriticalM);
    const fp = strictNum(f[6], 1, SITE_LIMITS.maxFootprintM2);
    if (!ok || !(SITE_OCCUPANCIES as readonly string[]).includes(occ) || floors == null || value === undefined || ffh === undefined || crit === undefined || fp === undefined) {
      bad++;
      continue;
    }
    if (f[7].length > SITE_LIMITS.nameChars * 12) {
      bad++;
      continue;
    }
    let name = '';
    try {
      name = cleanPlaceLabel(decodeURIComponent(f[7]), SITE_LIMITS.nameChars);
    } catch {
      name = '';
    }
    const ring = xy.length >= 8 ? xy.slice(2) : null;
    out.push({
      id: `s${out.length + 1}`,
      name,
      lon: xy[0],
      lat: xy[1],
      ring: ring && ring.length >= 6 ? ring : null,
      occupancy: occ,
      floors: Math.round(floors),
      value,
      firstFloorHeight: ffh,
      criticalElev: crit,
      footprintM2: fp,
    });
  }
  if (bad) warnings.push(`${bad} site${bad === 1 ? '' : 's'} in the link could not be read and ${bad === 1 ? 'was' : 'were'} skipped.`);
  return { sites: out, warnings };
}

/** Label for a planned use. */
export function siteUseLabel(occ: SiteOccupancy): string {
  return OCCUPANCY_PROFILES[occ].label;
}
