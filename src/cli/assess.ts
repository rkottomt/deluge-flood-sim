/**
 * From a run's hazard fields to the CLI's answers — pure TypeScript, no GPU. Every number comes from src/loss through
 * the same calls the app's panels make:
 *
 *   portfolio   analyze() with the CSV's assets, exactly as the Impact & loss panel (src/ui/impact.ts recompute and
 *               exportCsv): GPU fields (velocity known), the preset's debris-flow rule, no warning time; the export rows
 *               are resultRow()s with RESULT_COLUMNS — the in-app CSV's columns — plus ensemble columns at the end
 *   ensemble    one analyze() per member, folded into per-asset tallies (src/ui/ensemble.ts collect)
 *   site        assessSiteRun() with the Site check context (src/ui/siteCheck.ts runContext: access index, router,
 *               shelters, the flood timeline, the depth at the end of the run), then summarizeSweep / pickDesign /
 *               recommendFfe / mitigationOptions / siteVerdict
 *
 * tests/cli/parity.test.ts checks these against direct calls of the loss module.
 */
import type { HazardFields, Shelter, TerrainData } from '../contracts';
import { makeGeoToGrid } from '../data/geo';
import {
  addPortfolioMember,
  analyze,
  assessSiteRun,
  band,
  buildAccessIndex,
  DEBRIS_FLOW_PRESETS,
  depthAboveFloor,
  designEventText,
  exceedanceCurve,
  floodedArea,
  FloodTimeline,
  mitigationOptions,
  newTally,
  pickDesign,
  recommendFfe,
  regionForBounds,
  RESULT_COLUMNS,
  resultRow,
  siteVerdict,
  clearanceSentence,
  shareOutSentence,
  timingCaveats,
  summarizeSweep,
  tallySentence,
  toCsv,
  type Analysis,
  type AssetTally,
  type CsvValue,
  type EgressRouter,
  type MemberResult,
  type PortfolioAsset,
  type ResultRowInput,
  type EgressTiming,
  type SiteRun,
  type SiteSpec,
  type SweepLevelInfo,
  type SweepRow,
} from '../loss';
import { formatMoney } from '../ui/format';

export type AssessTerrain = Pick<TerrainData, 'nx' | 'ny' | 'cellSize' | 'bounds' | 'roads' | 'buildings'>;

/** Whether the preset's flood is debris-laden (the Impact panel's default for the dv × 1.5 rule). */
export function debrisFlowFor(presetId: string | null): boolean {
  return !!presetId && DEBRIS_FLOW_PRESETS.has(presetId);
}

// ─── Portfolio ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PortfolioAssessment {
  analysis: Analysis;
  /** Export rows of the assessed assets, in CSV order (src/ui/impact.ts exportCsv, portfolio rows). */
  rows: ResultRowInput[];
  /** Assets the loss model could not assess (off the map): not in `rows`. */
  unassessed: PortfolioAsset[];
}

export function assessPortfolioRun(fields: HazardFields, terrain: AssessTerrain, presetId: string | null, assets: readonly PortfolioAsset[], opts: { debrisFlow?: boolean; alertTime?: number } = {}): PortfolioAssessment {
  const analysis = analyze({ fields, terrain, velocityKnown: true, debrisFlow: opts.debrisFlow ?? debrisFlowFor(presetId), alertTime: opts.alertTime ?? 0, portfolio: assets });
  const rows: ResultRowInput[] = [];
  const seen = new Set<PortfolioAsset>();
  for (const r of analysis.portfolio?.results ?? []) {
    seen.add(r.m.asset);
    rows.push({ id: r.m.asset.id, name: r.m.asset.name, source: 'portfolio', occ: r.occ, match: r.m.match, matchDistanceM: r.m.distanceM, r, valueStructure: r.valueStructure, valueContents: r.valueContents, valueSource: r.valueSource, currency: r.currency });
  }
  return { analysis, rows, unassessed: assets.filter((a) => !seen.has(a)) };
}

/** Columns appended after RESULT_COLUMNS when an ensemble ran. */
export const ENSEMBLE_COLUMNS = [
  'ens_members', 'ens_assessed', 'ens_reached_members', 'ens_over_50cm_members', 'ens_depth_p10_m', 'ens_depth_p50_m', 'ens_depth_p90_m',
  'ens_loss_p10', 'ens_loss_p50', 'ens_loss_p90', 'ens_summary',
] as const;

const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : NaN);
const r0 = (v: number) => (Number.isFinite(v) ? Math.round(v) : NaN);

function ensembleCells(t: AssetTally | undefined): CsvValue[] {
  if (!t) return ENSEMBLE_COLUMNS.map(() => '');
  const n = t.members - t.outside;
  const depths = t.depths.filter((x) => Number.isFinite(x));
  const losses = t.losses.filter((x) => Number.isFinite(x));
  const d = depths.length ? band(depths) : [NaN, NaN, NaN];
  const l = losses.length ? band(losses) : [NaN, NaN, NaN];
  return [t.members, n, t.reached, t.over50, r2(d[0]), r2(d[1]), r2(d[2]), r0(l[0]), r0(l[1]), r0(l[2]), tallySentence(t)];
}

/**
 * The portfolio CSV: the in-app export's columns and rows for every assessed asset (identical cells), then a row for
 * each asset off the map (id, name, source, match = outside, the rest empty), and with an ensemble its columns.
 */
export function portfolioCsv(a: Pick<PortfolioAssessment, 'rows' | 'unassessed'>, ensemble: { assets: readonly PortfolioAsset[]; tallies: readonly AssetTally[] } | null = null): string {
  const header: string[] = [...RESULT_COLUMNS, ...(ensemble ? ENSEMBLE_COLUMNS : [])];
  const tallyOf = new Map<string, AssetTally>();
  if (ensemble) ensemble.assets.forEach((asset, k) => tallyOf.set(asset.id, ensemble.tallies[k]));
  const rows: CsvValue[][] = a.rows.map((r) => [...resultRow(r), ...(ensemble ? ensembleCells(tallyOf.get(r.id)) : [])]);
  for (const asset of a.unassessed) {
    const cells: CsvValue[] = RESULT_COLUMNS.map(() => '');
    cells[0] = asset.id;
    cells[1] = asset.name;
    cells[2] = 'portfolio';
    cells[4] = 'outside';
    rows.push([...cells, ...(ensemble ? ensembleCells(tallyOf.get(asset.id)) : [])]);
  }
  return toCsv(header, rows);
}

// ─── Ensemble members ───────────────────────────────────────────────────────────────────────────────────────────────

/** Per-asset tallies for an ensemble over `assets` (CSV order). */
export function newTallies(assets: readonly PortfolioAsset[]): AssetTally[] {
  return assets.map((a) => newTally(a.id, a.name || a.id));
}

/** One member's results (src/ui/ensemble.ts collect): its summary row, and its portfolio results folded into `tallies`. */
export function collectMember(
  fields: HazardFields,
  terrain: AssessTerrain,
  presetId: string | null,
  member: Omit<MemberResult, 'simTime' | 'floodedM2' | 'flooded50M2' | 'reached' | 'loss' | 'lossLo' | 'lossHi' | 'lossMs'>,
  assets: readonly PortfolioAsset[] | null,
  tallies: readonly AssetTally[] | null,
): MemberResult {
  const t0 = performance.now();
  const a = analyze({ fields, terrain, velocityKnown: true, debrisFlow: debrisFlowFor(presetId), portfolio: assets });
  const sum = a.report?.summary ?? null;
  if (assets && tallies) addPortfolioMember(tallies, assets, a.portfolio?.results ?? []);
  return {
    ...member,
    simTime: fields.simTime,
    floodedM2: floodedArea(fields.maxDepth, fields.firstWet, terrain.cellSize, 0.15),
    flooded50M2: floodedArea(fields.maxDepth, fields.firstWet, terrain.cellSize, 0.5),
    reached: sum ? sum.reached : NaN,
    loss: sum ? sum.loss : NaN,
    lossLo: sum ? sum.lossLo : NaN,
    lossHi: sum ? sum.lossHi : NaN,
    lossMs: performance.now() - t0,
  };
}

// ─── Site check ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SiteRunInputs {
  fields: HazardFields;
  terrain: AssessTerrain;
  presetId: string | null;
  /** The solver's bare-earth ground. */
  ground: Float32Array;
  /** Router over the preset's roads (null: egress not assessed). */
  router: EgressRouter | null;
  shelters: readonly Shelter[];
  /** Depth at the end of the run (the final snapshot). */
  endDepth: Float32Array | null;
}

/** assessSiteRun with the Site check panel's context (siteCheck.ts runContext + assessAll). */
export function assessSiteForRun(spec: SiteSpec, x: SiteRunInputs): SiteRun {
  const t = x.terrain;
  const region = regionForBounds(t.bounds);
  const timeline = new FloodTimeline(x.fields);
  return assessSiteRun(spec, x.fields, {
    region,
    grid: { nx: t.nx, ny: t.ny, cellSize: t.cellSize },
    toGrid: makeGeoToGrid(t),
    ground: x.ground,
    heightProfile: region.iso === 'NP' ? 'nepal' : 'us',
    debrisFlow: debrisFlowFor(x.presetId),
    alertTime: 0,
    access: buildAccessIndex(t.roads ?? null, x.fields, t.cellSize),
    router: x.router,
    shelters: x.shelters as Shelter[],
    hasRoads: !!x.router,
    timeline,
    endDepth: x.endDepth,
  });
}

const num = (v: number | null | undefined, digits = 3): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);
const mins = (s: number | null | undefined): number | null => (s == null || !Number.isFinite(s) || s < 0 ? null : Math.round((s / 60) * 10) / 10);

/** One site run as plain JSON (no typed arrays, no NaN). */
export function siteRunJson(run: SiteRun, timing?: EgressTiming | null): Record<string, unknown> {
  const r = run.result;
  const e = run.egress;
  return {
    outside: run.outside,
    simulatedMinutes: num(run.simTime / 60, 2),
    geometry: { footprintM2: num(run.geometry.footprintM2, 1), footprintSource: run.geometry.footprintSource, perimeterM: num(run.geometry.perimeterM, 1) },
    gradeM: num(run.grade),
    waterSurfaceM: num(run.wse),
    firstFloorHeightM: num(run.firstFloorHeight),
    result: r
      ? {
          reached: r.reached,
          depthM: num(r.depth),
          depthAboveFloorM: num(depthAboveFloor(run)),
          wetSharePct: num(r.wetFraction * 100, 1),
          maxSpeedMs: num(r.speed),
          maxDvM2s: num(r.dv),
          aidrClass: `H${r.aidr}`,
          fd2321: { hr: num(r.hr, 2), class: r.hrClass },
          firstWetMin: mins(r.firstWet),
          wetDurationMin: mins(r.wetSeconds),
          structuralState: r.state,
          damagePct: num(r.damage * 100, 1),
          valueStructure: num(r.valueStructure, 0),
          valueContents: num(r.valueContents, 0),
          valueSource: r.valueSource,
          loss: num(r.loss, 0),
          lossLow1Sigma: num(r.lossLo, 0),
          lossHigh1Sigma: num(r.lossHi, 0),
          downtimeDaysHeuristic: num(r.downtimeDays, 1),
          criticalEquipmentWet: r.criticalWet,
          accessRoadCut: r.accessKnown ? r.accessCut : null,
          accessRoad: r.accessRoad || null,
          currency: r.currency,
        }
      : null,
    egress: e
      ? {
          known: e.known,
          note: e.note || null,
          openAtStart: e.openAtStart,
          openAtPeak: e.openAtPeak,
          lastRouteClosesAtMin: mins(e.lastRouteClosesAt),
          peakReason: e.peakReason || null,
          cutAtEnd: e.cutAtEnd,
          cutOffAtLeastMin: mins(e.cutOffAtLeastS),
          peakShelter: e.peakShelter || null,
          shelters: e.shelters.map((s) => ({ name: s.name, openAtStart: s.openAtStart, openAtPeak: s.openAtPeak, closesAtMin: mins(s.closesAt), driveM: num(s.lengthM, 0), driveMin: mins(s.etaS) })),
          lastSafeDepartureMin: e.lastSafeDepartureAt === Infinity ? 'open' : signedMins(e.lastSafeDepartureAt),
          lastSafeShelter: e.lastSafeShelter || null,
        }
      : null,
    ...(timing !== undefined ? { egressTiming: timingJson(timing) } : {}),
  };
}

const signedMins = (s: number | null | undefined): number | null => (s == null || !Number.isFinite(s) ? null : Math.round((s / 60) * 10) / 10);

/** Leaving by road (egressTiming.ts) as plain JSON: "open" for a window that never ends, null for NaN. */
export function timingJson(t: EgressTiming | null): Record<string, unknown> | null {
  if (!t) return null;
  const open = t.windowS === Infinity;
  return {
    known: t.known,
    note: t.note || null,
    occupants: t.occupants,
    occupantsBasis: t.occupantsBasis,
    vehicles: t.vehicles,
    personsPerVehicle: t.personsPerVehicle,
    departureCurve: { id: t.curve.id, label: t.curve.label, a: t.curve.a, bMin: t.curve.bMin, maxShare: t.curve.maxShare, source: t.curve.source },
    departureP10Min: signedMins(t.band.p10),
    departureP90Min: signedMins(t.band.p90),
    bottleneck: { where: t.bottleneck.where, label: t.bottleneck.label, lanes: t.bottleneck.lanes, perLaneVph: t.bottleneck.perLaneVph, capacityVph: t.bottleneck.capacityVph },
    alertMin: signedMins(t.alertTime),
    routeWindowMin: open ? 'open' : signedMins(t.windowS),
    clearanceMin: signedMins(t.clearanceS),
    queueOnlyMin: signedMins(t.queueOnlyS),
    sharePctOutBeforeClose: open ? null : num(t.shareOut * 100, 1),
    sharePctQueuedAtClose: open ? null : num(t.shareQueued * 100, 1),
    sharePctInsideAtClose: open ? null : num(t.shareInside * 100, 1),
    clearsInWindow: t.known ? t.clearsInWindow : null,
    summary: t.known ? [shareOutSentence(t), clearanceSentence(t)] : [],
    caveats: t.known ? timingCaveats(t) : [],
  };
}

/** A sweep level as JSON (NaN → null). */
export function levelJson(l: SweepLevelInfo): Record<string, unknown> {
  return {
    id: l.id,
    label: l.label,
    gaugeFt: num(l.ft, 2),
    forcingScale: num(l.scale, 3),
    ...(l.rainMmH !== undefined ? { rainMmHr: num(l.rainMmH, 1) } : {}),
    returnPeriod: l.returnPeriod,
    returnPeriodFrom: l.rpFrom,
    simulatedMinutes: num(l.durationS / 60, 2),
  };
}

export interface SiteSweepReport {
  levels: Array<{ level: Record<string, unknown>; run: Record<string, unknown> }>;
  firstReached: string | null;
  firstInside: string | null;
  firstCutOff: string | null;
  eal: { low: number | null; high: number | null; points: Array<{ returnPeriod: number; loss: number }>; userReturnPeriods: boolean } | null;
  exceedanceCurve: Array<{ annualProbability: number; returnPeriod: number; loss: number }>;
  ffe: Record<string, unknown> | null;
  mitigation: Array<Record<string, unknown>>;
  verdict: string[];
}

/** The Site check card after a sweep (siteCheck.ts derived): EAL, FFE recommendation, mitigation options, verdict. */
export function siteSweepReport(
  spec: SiteSpec,
  rows: readonly SweepRow[],
  opts: { designId?: string | null; freeboardM?: number; country: 'US' | 'IN' | 'NP' | null; timing?: (run: SiteRun) => EgressTiming | null },
): SiteSweepReport {
  const sum = summarizeSweep(rows);
  const money = (v: number) => formatMoney(v).replace(/ /g, ' ');
  const design = pickDesign(sum.rows, opts.designId ?? null);
  const rec = design ? recommendFfe(design.row, design.basis, spec.occupancy, opts.freeboardM, design.onePercent) : null;
  const run0 = sum.rows[0]?.run;
  const options = rec && run0 ? mitigationOptions(sum, { occ: spec.occupancy, rec, country: opts.country, perimeterM: run0.geometry.perimeterM }) : [];
  const band3 = (b: { mid: number; low: number; high: number } | null) => (b ? { mid: num(b.mid, 2), low: num(b.low, 2), high: num(b.high, 2) } : null);
  return {
    levels: sum.rows.map((r) => ({ level: levelJson(r.level), run: siteRunJson(r.run, opts.timing ? opts.timing(r.run) : undefined) })),
    firstReached: sum.firstReached?.level.id ?? null,
    firstInside: sum.firstInside?.level.id ?? null,
    firstCutOff: sum.firstCutOff?.level.id ?? null,
    eal: sum.eal ? { low: num(sum.eal.low, 0), high: num(sum.eal.high, 0), points: sum.points.map((p) => ({ returnPeriod: p.T, loss: Math.round(p.loss) })), userReturnPeriods: sum.userReturnPeriods } : null,
    exceedanceCurve: exceedanceCurve(sum.points).map((p) => ({ annualProbability: p.p, returnPeriod: p.T, loss: Math.round(p.loss) })),
    ffe: rec
      ? {
          designEvent: rec.designLabel,
          designBasis: rec.designBasis,
          designEventText: designEventText(rec),
          onePercent: rec.onePercent ? { label: rec.onePercent.label, waterSurfaceM: num(rec.onePercent.wse) } : null,
          designWaterSurfaceM: num(rec.designWse),
          gradeM: num(rec.grade),
          freeboardM: num(rec.freeboardM),
          freeboardBasis: rec.freeboardBasis,
          ffeM: num(rec.ffe),
          ffeAboveGradeM: num(rec.ffeAboveGrade),
          plannedFloorM: num(rec.plannedFloorM),
          raiseByM: num(rec.raiseBy),
        }
      : null,
    mitigation: options.map((o) => ({
      kind: o.kind,
      label: o.label,
      applicable: o.applicable,
      assumption: o.assumption,
      heightM: num(o.heightM, 2),
      lengthM: num(o.lengthM, 0),
      cost: o.cost ? { mid: Math.round(o.cost.mid), low: Math.round(o.cost.low), high: Math.round(o.cost.high), perMetre: Math.round(o.cost.perMetre) } : null,
      ealAfter: o.ealAfter ? { low: num(o.ealAfter.low, 0), high: num(o.ealAfter.high, 0) } : null,
      avoidedEal: num(o.deltaEal, 0),
      bcr7: band3(o.bcr7),
      bcr3: band3(o.bcr3),
      breakEvenCapex7: num(o.breakEvenCapex7, 0),
      usefulLifeYears: o.usefulLifeYears,
      caveats: o.caveats,
    })),
    verdict: siteVerdict(spec.name || 'The site', sum, money, opts.timing),
  };
}
