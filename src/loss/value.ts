/**
 * What a building is worth, and how much of it a flood of a given depth destroys.
 *
 *   occupancy  ← BuildingSet.kind (OpenStreetMap `building=*`), or a portfolio row's `occupancy`
 *   floors     ← roof height, inverted with the same metres-per-storey the footprints were built with
 *   GFA        = footprint area × floors
 *   structure  = GFA × unit cost[occupancy][country]             (replacement value, 2026 USD)
 *   contents   = structure × content factor[occupancy]           (JRC: residential 0.5, commercial 1.0, industrial 1.5)
 *   loss       = Σ over wet storeys  f(dᵢ) × [structure × (1 − u) + contents] / floors
 *
 * where dᵢ is the water depth above storey i's floor and u the undamageable share (foundations, frame). Splitting by
 * storey keeps a 30-storey tower with a metre of water in the lobby from booking half its value as lost.
 *
 * EVERY NUMBER HERE IS AN ASSUMPTION WITH A SOURCE. The unit costs are the research's recommended defaults ("Deluge
 * for Business" spec §C.1.3, marked [I] there): derived from the JRC 2017 country construction costs, escalated to
 * 2026 and cross-checked against 2025 US contractor ranges and Nepali/Indian market rates — not quotes. They are
 * screening values; a portfolio row's own `replacement_value` always wins.
 */
import { HEIGHT_PROFILE_SCALE, LEVEL_HEIGHT_HIGH, LEVEL_HEIGHT_LOW, LEVEL_HIGHRISE_FROM, ROOF_ALLOWANCE, type BuildingKind, type HeightProfile } from '../data/buildings';
import { curveFor, damageFraction, damageSigma, type Continent, type Curve, type CurveClass } from './curves';
import type { CostCountry } from './region';

/** Occupancy classes: the research spec's E.1 portfolio vocabulary plus the classes OSM footprints map to. */
export const OCCUPANCIES = [
  'res',
  'apt',
  'retail',
  'office',
  'warehouse',
  'industrial',
  'hospital',
  'school',
  'civic',
  'religious',
  'assembly',
  'parking',
  'minor',
  'datacenter',
  'substation',
  'hydropower_headworks',
  'hydropower_powerhouse',
  'bridge',
  'road',
  'other',
] as const;
export type Occupancy = (typeof OCCUPANCIES)[number];

/** Rows of the unit-cost table. */
export type CostClass = 'residential' | 'retail' | 'office' | 'industrial' | 'hospital' | 'civic';

/**
 * Replacement cost of the structure, 2026 USD per m² of gross floor area. Spec §C.1.3 "Recommended Deluge defaults"
 * [I: derived — JRC 2017 construction cost × FX 1.30 × US CPI 2010→2025 ≈ 1.48 gives US residential ≈ $2,950/m², which
 * is high against 2025 market ranges (warehouse $70–150/ft², retail $120–300/ft², office $150–440/ft², healthcare
 * $250–1,018/ft²), so the defaults sit lower; Nepal/India use local market rates (NPR 2,800–3,600/ft² standard, CPWD
 * plinth rates) because their currencies fell against the dollar and CPI escalation would double them].
 */
export const UNIT_COST_USD_M2: Readonly<Record<CostCountry, Readonly<Record<CostClass, number>>>> = {
  US: { residential: 2000, retail: 2300, office: 3000, industrial: 1250, hospital: 4300, civic: 2700 },
  IN: { residential: 300, retail: 350, office: 450, industrial: 300, hospital: 700, civic: 350 },
  NP: { residential: 270, retail: 320, office: 380, industrial: 250, hospital: 550, civic: 300 },
};

/** Contents value as a multiple of structure value (JRC 2017 max-damage tabs: RES 0.5, COM 1.0, IND 1.5). [V] */
export const CONTENT_FACTOR_RES = 0.5;
export const CONTENT_FACTOR_COM = 1.0;
export const CONTENT_FACTOR_IND = 1.5;

/**
 * Undamageable share u of the structure (foundations, frame) for masonry / concrete / steel: 0.4, as in the JRC
 * max-damage formula `CC × 0.6 × (1 − 0.4)`. Timber, mud and informal construction: 0 (spec §C.1.3). A footprint
 * with no construction information is treated as masonry — the JRC default.
 */
export const UNDAMAGEABLE_SHARE_MASONRY = 0.4;
export const UNDAMAGEABLE_SHARE_LIGHT = 0;

export const CONSTRUCTIONS = ['concrete', 'masonry', 'steel', 'timber', 'mud', 'informal'] as const;
export type Construction = (typeof CONSTRUCTIONS)[number];

/** JRC material adjustment of value (spreadsheet "Adj" tab): mud walls ×0.2, informal / slum ×0.125. [V] */
export const MATERIAL_VALUE_FACTOR: Readonly<Partial<Record<Construction, number>>> = { mud: 0.2, informal: 0.125 };

/** Sheds, garages, canopies: valued at this fraction of a house per m² (spec §D.2 "minor (value × 0.2)"). */
export const MINOR_VALUE_FACTOR = 0.2;
/** Parking structures: ASSUMPTION — half the industrial unit cost, no contents ("low value: structure only", §D.2). */
export const PARKING_VALUE_FACTOR = 0.5;
/**
 * Footprints tagged only `building=yes`: occupancy from footprint area (spec §D.2 step 4, [I]): under 250 m² a home,
 * 250–5,000 m² commercial, larger and low a warehouse.
 */
export const SIZE_HEURISTIC_RES_MAX_M2 = 250;
export const SIZE_HEURISTIC_COM_MAX_M2 = 5000;

export interface OccupancyProfile {
  label: string;
  curve: CurveClass;
  /** Unit-cost row, or null when there is no default value (the asset needs a `replacement_value`). */
  cost: CostClass | null;
  /** Multiplier on the unit cost. */
  valueFactor: number;
  contentFactor: number;
  /** Days to rebuild a total loss (business-interruption heuristic, spec §C.5, Hazus-style [I]). */
  rebuildDays: number;
  /** Share of lost business recaptured later (Hazus-style, spec §C.5 [M]). */
  recapture: number;
  /** Most storeys a height may imply (tall single-storey halls, stadium bowls); null = no cap. */
  maxFloors: number | null;
}

const P = (
  label: string,
  curve: CurveClass,
  cost: CostClass | null,
  contentFactor: number,
  rebuildDays: number,
  extra: Partial<Pick<OccupancyProfile, 'valueFactor' | 'recapture' | 'maxFloors'>> = {},
): OccupancyProfile => ({ label, curve, cost, contentFactor, rebuildDays, valueFactor: 1, recapture: 0, maxFloors: null, ...extra });

/**
 * Per-occupancy assumptions. Rebuild days from spec §C.5 (RES 360, COM 270, office 300, IND/warehouse 240, hospital
 * 540, school 360, hydropower 540–720 → 630); the rest are the nearest listed class [I]. Recapture: retail 0.1,
 * office 0.6, industrial 0.4 (§C.5 [M]); 0 elsewhere. Industrial halls are capped at one storey: their roofs are tall
 * and a height-derived storey count would multiply their floor area.
 */
export const OCCUPANCY_PROFILES: Readonly<Record<Occupancy, OccupancyProfile>> = {
  res: P('Home', 'residential', 'residential', CONTENT_FACTOR_RES, 360),
  apt: P('Apartments', 'residential', 'residential', CONTENT_FACTOR_RES, 360),
  retail: P('Retail / commercial', 'commercial', 'retail', CONTENT_FACTOR_COM, 270, { recapture: 0.1 }),
  office: P('Office', 'commercial', 'office', CONTENT_FACTOR_COM, 300, { recapture: 0.6 }),
  warehouse: P('Warehouse', 'industrial', 'industrial', CONTENT_FACTOR_IND, 240, { recapture: 0.4, maxFloors: 1 }),
  industrial: P('Industrial', 'industrial', 'industrial', CONTENT_FACTOR_IND, 240, { recapture: 0.4, maxFloors: 1 }),
  hospital: P('Hospital', 'commercial', 'hospital', CONTENT_FACTOR_COM, 540),
  school: P('School', 'commercial', 'civic', CONTENT_FACTOR_COM, 360),
  civic: P('Civic', 'commercial', 'civic', CONTENT_FACTOR_COM, 360),
  religious: P('Place of worship', 'commercial', 'civic', CONTENT_FACTOR_COM, 360),
  assembly: P('Stadium / hall', 'commercial', 'civic', CONTENT_FACTOR_COM, 360, { maxFloors: 2 }),
  parking: P('Parking', 'commercial', 'industrial', 0, 180, { valueFactor: PARKING_VALUE_FACTOR }),
  minor: P('Shed / canopy', 'residential', 'residential', CONTENT_FACTOR_RES, 90, { valueFactor: MINOR_VALUE_FACTOR, maxFloors: 1 }),
  datacenter: P('Data centre', 'commercial', null, CONTENT_FACTOR_COM, 300, { recapture: 0 }),
  substation: P('Substation', 'industrial', null, CONTENT_FACTOR_IND, 240),
  hydropower_headworks: P('Hydropower headworks', 'industrial', null, CONTENT_FACTOR_IND, 630),
  hydropower_powerhouse: P('Hydropower powerhouse', 'industrial', null, CONTENT_FACTOR_IND, 630),
  bridge: P('Bridge', 'transport', null, 0, 360),
  road: P('Road', 'roads', null, 0, 360),
  other: P('Other', 'commercial', 'retail', CONTENT_FACTOR_COM, 270),
};

/** How sure we are of the occupancy (spec §D.2 step 5). */
export type ValueConfidence = 'given' | 'tagged' | 'heuristic';

/** OSM building kind → occupancy (spec §D.2). 'other' (`building=yes`) falls to the size heuristic. */
export function occupancyForKind(kind: BuildingKind, footprintM2: number, floors: number): { occ: Occupancy; confidence: ValueConfidence } {
  switch (kind) {
    case 'house':
    case 'residential':
      return { occ: 'res', confidence: 'tagged' };
    case 'apartments':
      return { occ: 'apt', confidence: 'tagged' };
    case 'commercial':
    case 'office':
      return { occ: 'office', confidence: 'tagged' };
    case 'retail':
      return { occ: 'retail', confidence: 'tagged' };
    case 'industrial':
      return { occ: 'industrial', confidence: 'tagged' };
    case 'civic':
      return { occ: 'civic', confidence: 'tagged' };
    case 'school':
      return { occ: 'school', confidence: 'tagged' };
    case 'church':
      return { occ: 'religious', confidence: 'tagged' };
    case 'stadium':
      return { occ: 'assembly', confidence: 'tagged' };
    case 'parking':
      return { occ: 'parking', confidence: 'tagged' };
    case 'shed':
    case 'roof':
      return { occ: 'minor', confidence: 'tagged' };
    default:
      if (footprintM2 < SIZE_HEURISTIC_RES_MAX_M2) return { occ: 'res', confidence: 'heuristic' };
      if (footprintM2 <= SIZE_HEURISTIC_COM_MAX_M2 || floors > 1) return { occ: 'retail', confidence: 'heuristic' };
      return { occ: 'warehouse', confidence: 'heuristic' };
  }
}

/** Metres per storey for a height profile (the same constants src/data/buildings.ts builds heights with). */
export function storeyHeights(profile: HeightProfile = 'us'): { low: number; high: number } {
  const s = HEIGHT_PROFILE_SCALE[profile];
  return { low: LEVEL_HEIGHT_LOW * s, high: LEVEL_HEIGHT_HIGH * s };
}

/**
 * Storeys from roof height: the inverse of levelsToMeters (n × metres-per-level + roof allowance), so a height that
 * came from a `building:levels` tag gives back exactly that count. At least 1.
 */
export function floorsFromHeight(heightM: number, profile: HeightProfile = 'us'): number {
  if (!(heightM > 0)) return 1;
  const { low, high } = storeyHeights(profile);
  const roof = ROOF_ALLOWANCE * HEIGHT_PROFILE_SCALE[profile];
  let n = Math.round((heightM - roof) / low);
  if (n >= LEVEL_HIGHRISE_FROM) n = Math.max(LEVEL_HIGHRISE_FROM, Math.round((heightM - roof) / high));
  return Math.max(1, n);
}

/** Storey height to use for a building of `floors` storeys. */
export function storeyHeightFor(floors: number, profile: HeightProfile = 'us'): number {
  const { low, high } = storeyHeights(profile);
  return floors >= LEVEL_HIGHRISE_FROM ? high : low;
}

export function undamageableShare(c: Construction | null | undefined): number {
  return c === 'timber' || c === 'mud' || c === 'informal' ? UNDAMAGEABLE_SHARE_LIGHT : UNDAMAGEABLE_SHARE_MASONRY;
}

export interface AssetValue {
  /** Structure replacement value, or NaN when unknown. */
  structure: number;
  /** Contents value, or NaN when unknown. */
  contents: number;
  gfaM2: number;
  /** Where the structure value came from. */
  source: 'given' | 'unit-cost' | 'none';
}

/**
 * Value of an asset. `given` values (a portfolio's own) win; otherwise GFA × unit cost, when the country has a cost
 * table and the occupancy a cost row.
 */
export function assetValue(opts: {
  occ: Occupancy;
  gfaM2: number;
  country: CostCountry | null;
  construction?: Construction | null;
  structureGiven?: number | null;
  contentsGiven?: number | null;
}): AssetValue {
  const prof = OCCUPANCY_PROFILES[opts.occ];
  let structure = NaN;
  let source: AssetValue['source'] = 'none';
  if (opts.structureGiven != null && Number.isFinite(opts.structureGiven) && opts.structureGiven >= 0) {
    structure = opts.structureGiven;
    source = 'given';
  } else if (opts.country && prof.cost && opts.gfaM2 > 0) {
    const mat = (opts.construction && MATERIAL_VALUE_FACTOR[opts.construction]) ?? 1;
    structure = opts.gfaM2 * UNIT_COST_USD_M2[opts.country][prof.cost] * prof.valueFactor * mat;
    source = 'unit-cost';
  }
  const contents =
    opts.contentsGiven != null && Number.isFinite(opts.contentsGiven) && opts.contentsGiven >= 0 ? opts.contentsGiven : structure * prof.contentFactor;
  return { structure, contents, gfaM2: opts.gfaM2, source };
}

/** Effect of fast water on the structure (hazard.ts structuralState). */
export type StructuralState = 'none' | 'partial' | 'collapse' | 'unknown';

/** Partial structural damage sets every wet storey's damage to at least this (Clausen & Clark 1990 as cited). [M] */
export const PARTIAL_DAMAGE_FLOOR = 0.5;

export interface DamageResult {
  /** Damage fraction of the ground storey (after the velocity rule). */
  groundFraction: number;
  /** Whole-asset damage: loss / (damageable structure + contents). */
  fraction: number;
  structure: number;
  contents: number;
  /** ±1σ of the curve, applied to every wet storey. */
  lossLo: number;
  lossHi: number;
  /** Storeys with water above their floor. */
  wetStoreys: number;
}

/**
 * Per-storey damage (spec §D.1). `depth` is water depth above the GROUND FLOOR level (water depth at the building
 * minus the first-floor height, which is 0 for footprints: the JRC curves are defined on water depth). Values may be
 * NaN (unknown); the loss is then NaN as well, while the damage fractions still come out.
 */
export function storeyDamage(opts: {
  depth: number;
  floors: number;
  storeyHeight: number;
  curve: Curve;
  structureValue: number;
  contentsValue: number;
  undamageable: number;
  state: StructuralState;
  /**
   * Share of total loss from fast water, 0–1 (hazard.ts collapseShare): the result is (1 − share) × the depth-curve
   * damage + share × total loss. Omitted: 1 when the state is 'collapse', else 0 (the plain step rule).
   */
  collapseShare?: number;
}): DamageResult {
  const floors = Math.max(1, Math.floor(opts.floors));
  const S = (opts.structureValue * (1 - opts.undamageable)) / floors;
  const C = opts.contentsValue / floors;
  const out: DamageResult = { groundFraction: 0, fraction: 0, structure: 0, contents: 0, lossLo: 0, lossHi: 0, wetStoreys: 0 };
  const share = Math.min(1, Math.max(0, opts.collapseShare ?? (opts.state === 'collapse' ? 1 : 0)));
  if (share > 0) {
    // The curve part of a collapsing building is at least partially damaged (the collapse criterion implies the partial one).
    const curve = storeyDamage({ ...opts, state: opts.state === 'collapse' ? 'partial' : opts.state, collapseShare: 0 });
    const total = S * floors + C * floors;
    const mix = (a: number, b: number) => (1 - share) * a + share * b;
    out.groundFraction = mix(curve.groundFraction, 1);
    out.fraction = mix(curve.fraction, 1);
    out.structure = mix(curve.structure, S * floors);
    out.contents = mix(curve.contents, C * floors);
    out.lossLo = mix(curve.lossLo, total);
    out.lossHi = mix(curve.lossHi, total);
    out.wetStoreys = share >= 1 ? floors : curve.wetStoreys;
    return out;
  }
  let fSum = 0;
  for (let i = 0; i < floors; i++) {
    const d = opts.depth - i * opts.storeyHeight;
    if (!(d > 0)) break;
    let f = damageFraction(opts.curve, d);
    const sd = damageSigma(opts.curve, d);
    let lo = Math.max(0, f - sd);
    let hi = Math.min(1, f + sd);
    if (opts.state === 'partial') {
      f = Math.max(f, PARTIAL_DAMAGE_FLOOR);
      lo = Math.max(lo, PARTIAL_DAMAGE_FLOOR);
      hi = Math.max(hi, PARTIAL_DAMAGE_FLOOR);
    }
    if (i === 0) out.groundFraction = f;
    fSum += f;
    out.structure += f * S;
    out.contents += f * C;
    out.lossLo += lo * (S + C);
    out.lossHi += hi * (S + C);
    out.wetStoreys++;
  }
  out.fraction = fSum / floors;
  return out;
}

/** Damage curve for an occupancy on a continent. */
export function curveForOccupancy(occ: Occupancy, continent: Continent): Curve {
  return curveFor(OCCUPANCY_PROFILES[occ].curve, continent);
}
