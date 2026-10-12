/**
 * Depth–damage curves: the fraction (0–1) of a building's damageable value lost at a given water depth.
 *
 * SOURCE: Huizinga, J., de Moel, H. & Szewczyk, W. (2017). *Global flood depth-damage functions: Methodology and the
 * database with guidelines.* JRC Technical Report EUR 28552 EN, doi:10.2760/16510. The values below were extracted
 * programmatically from the "Damage functions" tab of the official spreadsheet
 * (copy_of_global_flood_depth-damage_functions__30102017.xlsx, publications.jrc.ec.europa.eu/repository/handle/JRC105688)
 * and rounded to 4 dp. `tests/loss/curves.test.ts` pins every one of them.
 *
 * Depth is water depth at the building in metres. A curve is linear between the tabulated depths, 0 for a dry building
 * (the North-American residential curve is non-zero at 0 m because it derives from HAZUS, whose depths are measured
 * from the first floor — JRC keeps that offset; a dry building still loses nothing), and 1 beyond 6 m.
 *
 * Where a continent has no curve for a class the lookup falls back to GLOBAL, then EUROPE, as the JRC guidelines do.
 */

/** Tabulated depths, m. */
export const JRC_DEPTHS: readonly number[] = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6];

export type Continent = 'europe' | 'northAmerica' | 'centralSouthAmerica' | 'asia' | 'africa' | 'oceania' | 'global';
export type CurveClass = 'residential' | 'commercial' | 'industrial' | 'transport' | 'roads' | 'agriculture';

type CurveTable = Readonly<Partial<Record<Continent, readonly number[]>>>;

/** JRC 2017 damage fractions at JRC_DEPTHS, by class and continent (verbatim, 4 dp). */
export const JRC_CURVES: Readonly<Record<CurveClass, CurveTable>> = {
  residential: {
    europe: [0, 0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 0.95, 1],
    northAmerica: [0.2018, 0.4433, 0.5828, 0.6825, 0.784, 0.8543, 0.9237, 0.9585, 1],
    centralSouthAmerica: [0, 0.4909, 0.7113, 0.842, 0.9494, 0.9836, 1, 1, 1],
    asia: [0, 0.3266, 0.4941, 0.6166, 0.7207, 0.8695, 0.9315, 0.9836, 1],
    africa: [0, 0.2199, 0.3782, 0.5306, 0.6356, 0.8169, 0.9034, 0.9572, 1],
    oceania: [0, 0.4754, 0.6404, 0.7146, 0.7877, 0.9288, 0.9674, 0.9828, 1],
    // No GLOBAL residential curve in the JRC sheet: the fallback goes to EUROPE.
  },
  commercial: {
    europe: [0, 0.15, 0.3, 0.45, 0.55, 0.75, 0.9, 1, 1],
    northAmerica: [0.0184, 0.2393, 0.3742, 0.4663, 0.5521, 0.6871, 0.8221, 0.908, 1],
    centralSouthAmerica: [0, 0.6115, 0.8395, 0.9236, 0.992, 1, 1, 1, 1],
    asia: [0, 0.3768, 0.5377, 0.6593, 0.7628, 0.8833, 0.9419, 0.9808, 1],
    oceania: [0, 0.239, 0.4812, 0.6738, 0.8646, 1, 1, 1, 1],
    global: [0, 0.3233, 0.5065, 0.6346, 0.7443, 0.8641, 0.9328, 0.9777, 1],
  },
  industrial: {
    europe: [0, 0.15, 0.27, 0.4, 0.52, 0.7, 0.85, 1, 1],
    northAmerica: [0.0257, 0.3229, 0.5114, 0.6371, 0.74, 0.86, 0.9371, 0.98, 1],
    centralSouthAmerica: [0, 0.667, 0.8887, 0.9467, 1, 1, 1, 1, 1],
    asia: [0, 0.2832, 0.4816, 0.6292, 0.7172, 0.8567, 0.9086, 0.9553, 1],
    africa: [0, 0.0627, 0.2472, 0.4033, 0.4945, 0.6847, 0.9186, 1, 1],
    global: [0, 0.2971, 0.4798, 0.6033, 0.6943, 0.8203, 0.9229, 0.9871, 1],
  },
  transport: {
    europe: [0, 0.3167, 0.5417, 0.7017, 0.8317, 1, 1, 1, 1],
    centralSouthAmerica: [0, 0.0877, 0.1754, 0.5965, 0.8421, 1, 1, 1, 1],
    asia: [0, 0.3575, 0.5719, 0.7333, 0.8472, 1, 1, 1, 1],
    global: [0, 0.254, 0.4297, 0.6772, 0.8403, 1, 1, 1, 1],
  },
  roads: {
    europe: [0, 0.25, 0.42, 0.55, 0.65, 0.8, 0.9, 1, 1],
    asia: [0, 0.2144, 0.3728, 0.6039, 0.7097, 0.8084, 0.8872, 0.9688, 1],
    global: [0, 0.2322, 0.3964, 0.577, 0.6798, 0.8042, 0.8936, 0.9844, 1],
  },
  agriculture: {
    europe: [0, 0.3, 0.55, 0.65, 0.75, 0.85, 0.95, 1, 1],
    northAmerica: [0.0186, 0.2678, 0.4737, 0.5506, 0.6022, 0.7601, 0.8741, 0.9541, 1],
    asia: [0, 0.135, 0.37, 0.524, 0.558, 0.66, 0.834, 0.988, 1],
    africa: [0, 0.2429, 0.4718, 0.7414, 0.9167, 1, 1, 1, 1],
    global: [0, 0.2364, 0.4664, 0.6165, 0.7067, 0.8175, 0.9145, 0.9855, 1],
  },
};

/**
 * One-standard-deviation spread of the damage fraction at JRC_DEPTHS, where it was extracted from the JRC sheet.
 *  • Asia residential: 0.25, 0.22, 0.21, 0.21, 0.17, 0.12, 0.05, 0 at 0.5 … 6 m (verbatim; 0 at 0 m).
 *  • North-America residential: the sheet gives 0.14–0.17 across depths; 0.15 is used throughout (approximate).
 */
export const JRC_SIGMA: Readonly<Partial<Record<CurveClass, CurveTable>>> = {
  residential: {
    asia: [0, 0.25, 0.22, 0.21, 0.21, 0.17, 0.12, 0.05, 0],
    northAmerica: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15],
  },
};

/**
 * σ used where the JRC sheet's own value was not extracted for this project (every class and continent except the two
 * above). ASSUMPTION, not a JRC number: 0.2 is of the same order as the extracted residential spreads (0.14–0.25).
 * The UI calls the resulting band a ±1σ curve range and names this placeholder in the methods appendix.
 */
export const DEFAULT_CURVE_SIGMA = 0.2;

/** Fallback order when a continent has no curve for a class (JRC guidelines). */
const FALLBACK: readonly Continent[] = ['global', 'europe'];

export interface Curve {
  cls: CurveClass;
  /** Continent whose values are used (after fallback). */
  continent: Continent;
  /** True when `continent` is not the one asked for. */
  fallback: boolean;
  values: readonly number[];
  /** σ at JRC_DEPTHS, or null where DEFAULT_CURVE_SIGMA applies. */
  sigma: readonly number[] | null;
}

export function curveFor(cls: CurveClass, continent: Continent): Curve {
  const table = JRC_CURVES[cls];
  let used: Continent = continent;
  let values = table[continent];
  if (!values) {
    for (const c of FALLBACK) {
      if (table[c]) {
        used = c;
        values = table[c];
        break;
      }
    }
  }
  if (!values) throw new Error(`no JRC curve for ${cls}`);
  return { cls, continent: used, fallback: used !== continent, values, sigma: JRC_SIGMA[cls]?.[used] ?? null };
}

/** Piecewise-linear lookup on JRC_DEPTHS; 0 for d ≤ 0 (dry), the last value beyond the last depth. */
export function interpTable(values: readonly number[], d: number, depths: readonly number[] = JRC_DEPTHS): number {
  if (!(d > 0)) return 0;
  const n = depths.length;
  if (d >= depths[n - 1]) return values[n - 1];
  for (let i = 1; i < n; i++) {
    if (d <= depths[i]) {
      const t = (d - depths[i - 1]) / (depths[i] - depths[i - 1]);
      return values[i - 1] + t * (values[i] - values[i - 1]);
    }
  }
  return values[n - 1];
}

/** Damage fraction at depth d (m). */
export function damageFraction(curve: Curve, d: number): number {
  return interpTable(curve.values, d);
}

/** ±1σ of the damage fraction at depth d (0 for a dry building). */
export function damageSigma(curve: Curve, d: number): number {
  if (!(d > 0)) return 0;
  return curve.sigma ? interpTable(curve.sigma, d) : DEFAULT_CURVE_SIGMA;
}

// ─── US detail curves (USACE EGM 01-03) — UNVERIFIED, off by default ───────────────────────────────────────────────

/**
 * USACE Economic Guidance Memorandum 01-03 (2000) generic residential curves, depth above the FIRST FLOOR in feet.
 *
 * UNVERIFIED: these numbers were recalled from memory by the research for this feature and could NOT be checked
 * against EGM 01-03 Tables 1–2 (the FEMA/USACE PDFs were unreachable). They stay behind this flag, off by default,
 * until someone verifies them or imports FEMA's FAST / HazusFloodDDF lookup tables. Nothing in the UI turns them on.
 */
export const USACE_EGM0103_UNVERIFIED = true;
/** The flag a caller must set to use them anyway (tests do, to check the interpolation). */
export const USE_US_DETAIL_CURVES = false;

export const USACE_DEPTHS_FT: readonly number[] = [-1, 0, 1, 2, 3, 4, 5, 6, 8, 10, 12];
export const USACE_CURVES_UNVERIFIED = {
  oneStoryNoBasementStructure: [2.5, 13.4, 23.3, 32.1, 40.1, 47.1, 53.2, 58.6, 67.2, 73.2, 77.2],
  oneStoryNoBasementContents: [2.4, 8.1, 13.3, 17.9, 22.0, 25.7, 28.8, 31.5, 35.7, 38.4, 39.7],
  twoStoryNoBasementStructure: [3.0, 9.3, 15.2, 20.9, 26.3, 31.2, 35.9, 40.0, 47.3, 53.2, 58.0],
} as const;
/** Default first-floor heights for the USACE curves, ft (slab / crawlspace). */
export const USACE_FFH_SLAB_FT = 1;
export const USACE_FFH_CRAWL_FT = 3;

/**
 * Damage fraction (0–1) from an unverified USACE curve, for depth above the first floor in feet. Below −1 ft: 0.
 * Throws unless `allowUnverified` is passed, so it cannot be wired in by accident.
 */
export function usaceDamageUnverified(
  curve: keyof typeof USACE_CURVES_UNVERIFIED,
  depthAboveFirstFloorFt: number,
  allowUnverified: boolean,
): number {
  if (!allowUnverified) throw new Error('USACE EGM 01-03 values are unverified; pass allowUnverified to use them');
  const v = USACE_CURVES_UNVERIFIED[curve];
  const d = USACE_DEPTHS_FT;
  if (!(depthAboveFirstFloorFt >= d[0])) return 0;
  if (depthAboveFirstFloorFt >= d[d.length - 1]) return v[v.length - 1] / 100;
  for (let i = 1; i < d.length; i++) {
    if (depthAboveFirstFloorFt <= d[i]) {
      const t = (depthAboveFirstFloorFt - d[i - 1]) / (d[i] - d[i - 1]);
      return (v[i - 1] + t * (v[i] - v[i - 1])) / 100;
    }
  }
  return v[v.length - 1] / 100;
}
