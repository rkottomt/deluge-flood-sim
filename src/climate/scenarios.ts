/**
 * Future-climate scenario tables (docs/research/climate-scenarios.md): pathway × horizon → global warming, regional
 * amplification, the extreme-rain multiplier, sea-level rise at a tide gauge and glacial-lake growth.
 *
 * WHAT THIS IS. Forcing scaling, not downscaled projections: Deluge keeps today's storm, river inflow or tide and scales
 * the forcing by a published sensitivity (extreme rain +α per °C of warming, the sea higher by a published scenario,
 * a glacial lake grown along its observed trend). The solver then produces the flood. Nothing here predicts how often
 * an event will happen, and no river STAGE is ever scaled (a stage is the answer the hydraulics give, not a forcing).
 *
 * Evidence tags as in docs/research: [V] read in the primary source, [S] secondary source, [M] modelling assumption
 * made here (documented), [C] computed from the others.
 *
 * BASELINE. "Today" is the scenario as it ships: its storms, inflows and tide levels, and the return periods of the Site
 * check ladders, come from gauge and rain records of recent decades. Warming is therefore counted from AR6's recent-past
 * reference period 1995–2014 (0.85 °C above 1850–1900 [V AR6 WG1 SPM/TS]), and sea level from the 2005 zero of NOAA's
 * per-station series — the reference periods the two sources publish their projections against (the Fort Myers tide
 * statistics in src/loss/ladders.ts are on the 1983–2001 MHHW epoch, a decade earlier, so the rise is if anything
 * understated). About 0.4 °C of the warming counted here has already happened (2015–2024 averaged 1.24 °C [S Forster et
 * al. 2025]), so "Today" is slightly milder than the climate of 2026, and every future multiplier is the change since
 * that reference period, not since this year.
 */

export type ClimateHorizon = 'today' | '2050' | '2080' | '2100';
export type ClimatePathway = 'ssp245' | 'ssp585';
/** Extreme-rain scaling rate: Clausius–Clapeyron, or super-CC for short-duration bursts. */
export type RainScaling = 'cc' | 'super10' | 'super14';

export interface ClimateSelection {
  horizon: ClimateHorizon;
  pathway: ClimatePathway;
  scaling: RainScaling;
}

/** The identity selection: the scenario exactly as it ships. */
export const CLIMATE_TODAY: Readonly<ClimateSelection> = Object.freeze({ horizon: 'today', pathway: 'ssp585', scaling: 'cc' });

export const CLIMATE_HORIZONS: readonly ClimateHorizon[] = ['today', '2050', '2080', '2100'];
export const CLIMATE_PATHWAYS: readonly ClimatePathway[] = ['ssp245', 'ssp585'];
export const RAIN_SCALINGS: readonly RainScaling[] = ['cc', 'super10', 'super14'];

export const PATHWAY_LABELS: Readonly<Record<ClimatePathway, { short: string; long: string }>> = {
  ssp245: { short: 'SSP2-4.5', long: 'SSP2-4.5 — middle of the road' },
  ssp585: { short: 'SSP5-8.5', long: 'SSP5-8.5 — high emissions' },
};

export interface ClimateSource {
  key: string;
  text: string;
  url: string;
}

/** Every source the tables below cite (keys are used by the UI's fine print and the report). */
export const CLIMATE_SOURCES: Readonly<Record<string, ClimateSource>> = {
  ar6Spm: {
    key: 'ar6Spm',
    text: 'IPCC AR6 WG1 Summary for Policymakers (2021): Table SPM.1 warming by period and SSP; A.1.2 2011–2020 at 1.09 °C globally, 1.59 °C over land; B.2.4 "extreme daily precipitation events are projected to intensify by about 7 % for each 1 °C of global warming"; Fig. SPM.6 (10-yr 1-day rain +10.5 % at 1.5 °C, +14 % at 2 °C, +30 % at 4 °C).',
    url: 'https://www.ipcc.ch/report/ar6/wg1/chapter/summary-for-policymakers/',
  },
  ar6Ch4: {
    key: 'ar6Ch4',
    text: 'IPCC AR6 WG1 Technical Summary, Box TS.1 Table 1 (same values as SPM.1); 1995–2014 is 0.85 °C above 1850–1900, the shift used here to count warming from the recent past.',
    url: 'https://www.ipcc.ch/report/ar6/wg1/downloads/report/IPCC_AR6_WGI_TS.pdf',
  },
  ar6Ch11: {
    key: 'ar6Ch11',
    text: 'IPCC AR6 WG1 Chapter 11 (Seneviratne et al. 2021), §11.4: heavy precipitation scales at ~7 %/°C (Clausius–Clapeyron) for daily extremes; sub-daily extremes can exceed it.',
    url: 'https://www.ipcc.ch/report/ar6/wg1/chapter/chapter-11/',
  },
  fowler2021: {
    key: 'fowler2021',
    text: 'Fowler et al. 2021, Anthropogenic intensification of short-duration rainfall extremes, Nature Reviews Earth & Environment 2:107–122: short-duration extremes intensify at ~7 %/K, with super-CC rates in some regions; AR6 Ch. 11 puts observed sub-daily apparent scaling "between the C-C and two-times the C-C rate".',
    url: 'https://doi.org/10.1038/s43017-020-00128-6',
  },
  lenderink2008: {
    key: 'lenderink2008',
    text: 'Lenderink & van Meijgaard 2008, Increase in hourly precipitation extremes beyond expectations from temperature changes, Nature Geoscience 1:511–514 (≈ 14 %/°C above ~12 °C dew point, De Bilt).',
    url: 'https://doi.org/10.1038/ngeo262',
  },
  forster2025: {
    key: 'forster2025',
    text: 'Forster et al. 2025, Indicators of Global Climate Change 2024, ESSD 17:2641: observed warming 2015–2024 ≈ 1.24 °C above 1850–1900.',
    url: 'https://doi.org/10.5194/essd-17-2641-2025',
  },
  icimod2019: {
    key: 'icimod2019',
    text: 'Wester et al. (eds) 2019, The Hindu Kush Himalaya Assessment (ICIMOD), ch. 3: 1.5 °C of global warming means 1.8 ± 0.4 °C in the HKH (2.2 °C in the NW Himalaya and Karakoram).',
    url: 'https://doi.org/10.1007/978-3-319-92288-1',
  },
  noaaSlr2022: {
    key: 'noaaSlr2022',
    text: 'Sweet et al. 2022, Global and Regional Sea Level Rise Scenarios for the United States (NOAA Tech. Rep. NOS 01); station medians from the NOAA CO-OPS slr_projections API (Fort Myers 8725520, zeroed at 2005): Intermediate-Low 0.28 / 0.49 / 0.62 m and Intermediate 0.32 / 0.70 / 1.10 m in 2050 / 2080 / 2100.',
    url: 'https://api.tidesandcurrents.noaa.gov/dpapi/prod/webapi/product/slr_projections.json?station=8725520&units=metric&report_year=2022&affil=US',
  },
  lhonak: {
    key: 'lhonak',
    text: 'South Lhonak Lake area: 17.54 ha (1977) + 81.1 ha to 2008 (Raj et al. 2013, Current Science, via Wikipedia); 167.4 ha on 28 Sep 2023 (NRSC imagery, via SANDRP) → ≈ 0.046 km²/yr over 2008–2023. Growth per °C and the 2× cap are this app’s assumptions.',
    url: 'https://sandrp.in/2023/10/04/glacial-lake-flood-destroys-teesta-3-dam-in-sikkim-brings-wide-spread-destruction/',
  },
  huggel2002: {
    key: 'huggel2002',
    text: 'Huggel et al. 2002 / Cook & Quincey 2015 / Sakai 2012 volume–area relations (src/hazard/volume.ts volumeFromArea).',
    url: 'https://doi.org/10.1139/t01-099',
  },
};

// ─── Global warming ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Warming {
  /** Best estimate, °C. */
  best: number;
  /** Very likely range (5–95 %), °C. */
  lo: number;
  hi: number;
}

/**
 * Global surface temperature change relative to 1850–1900, AR6 WG1 Table SPM.1 [V]: best estimate and very likely
 * range for 2041–2060 (mid-term) and 2081–2100 (long-term).
 */
export const AR6_WARMING_PREINDUSTRIAL: Readonly<Record<ClimatePathway, { mid: Warming; long: Warming }>> = {
  ssp245: { mid: { best: 2.0, lo: 1.6, hi: 2.5 }, long: { best: 2.7, lo: 2.1, hi: 3.5 } },
  ssp585: { mid: { best: 2.4, lo: 1.9, hi: 3.0 }, long: { best: 4.4, lo: 3.3, hi: 5.7 } },
};

/** 1995–2014 above 1850–1900, °C (AR6 WG1 SPM / TS: "subtract 0.85 °C" to move to the 1995–2014 baseline) [V]. */
export const RECENT_PAST_ABOVE_PREINDUSTRIAL = 0.85;

const shift = (w: Warming): Warming => ({
  best: Math.round((w.best - RECENT_PAST_ABOVE_PREINDUSTRIAL) * 100) / 100,
  lo: Math.round((w.lo - RECENT_PAST_ABOVE_PREINDUSTRIAL) * 100) / 100,
  hi: Math.round((w.hi - RECENT_PAST_ABOVE_PREINDUSTRIAL) * 100) / 100,
});

/**
 * The same relative to 1995–2014 — Deluge's "Today" (see BASELINE above): Table SPM.1 − 0.85 °C [C]
 * (SSP2-4.5 1.15 / 1.85 °C, SSP5-8.5 1.55 / 3.55 °C for 2041–2060 / 2081–2100).
 */
export const AR6_WARMING_RECENT: Readonly<Record<ClimatePathway, { mid: Warming; long: Warming }>> = {
  ssp245: { mid: shift(AR6_WARMING_PREINDUSTRIAL.ssp245.mid), long: shift(AR6_WARMING_PREINDUSTRIAL.ssp245.long) },
  ssp585: { mid: shift(AR6_WARMING_PREINDUSTRIAL.ssp585.mid), long: shift(AR6_WARMING_PREINDUSTRIAL.ssp585.long) },
};

/** Centre years of the AR6 periods the horizons are read from. */
const MID_CENTRE = 2050;
const LONG_CENTRE = 2090;

/**
 * Global warming since 1995–2014 at a horizon, °C. 2050 = AR6's 2041–2060 mean; 2100 = the 2081–2100 mean (AR6 has no
 * single-year 2100 figure; the year 2100 itself runs warmer under SSP5-8.5); 2080 is interpolated linearly between the
 * 2050 and 2090 centres [C]. Today = 0.
 */
export function globalWarming(pathway: ClimatePathway, horizon: ClimateHorizon): Warming {
  if (horizon === 'today') return { best: 0, lo: 0, hi: 0 };
  const t = AR6_WARMING_RECENT[pathway];
  if (horizon === '2050') return { ...t.mid };
  if (horizon === '2100') return { ...t.long };
  const f = (2080 - MID_CENTRE) / (LONG_CENTRE - MID_CENTRE);
  const lerp = (a: number, b: number) => Math.round((a + f * (b - a)) * 100) / 100;
  return { best: lerp(t.mid.best, t.long.best), lo: lerp(t.mid.lo, t.long.lo), hi: lerp(t.mid.hi, t.long.hi) };
}

/** Calendar year a horizon stands for (lake growth, sea level). */
export function horizonYear(horizon: ClimateHorizon, today = 2026): number {
  return horizon === 'today' ? today : Number(horizon);
}

// ─── Regional amplification ───────────────────────────────────────────────────────────────────────────────────────

export type ClimateRegionId = 'us-northeast' | 'us-southeast' | 'us-south-plains' | 'us-southwest' | 'us' | 'hkh' | 'global-land';

export interface ClimateRegion {
  id: ClimateRegionId;
  name: string;
  /** Local (land) warming per °C of global warming. Used for the local-warming readout and glacier melt only. */
  factor: number;
  source: string;
  tag: 'V' | 'S' | 'M';
}

/**
 * Local warming per degree of global warming. NOT applied to rain: AR6's ~7 %/°C for extreme daily rain is stated per
 * degree of GLOBAL warming (SPM B.2.4), so the rain multiplier uses global ΔT; the regional factor is shown so the
 * reader knows the local temperature change is larger, and it drives glacier melt.
 *
 * US regions: the observed land/global ratio 1.59 / 1.09 = 1.46 (AR6 SPM A.1.2 [V], ratio [C]). NCA5's regional
 * numbers could not be verified for this release, so every US region uses that land average; the names only say where.
 * (AR6's "1.4–1.7×" is land vs OCEAN, not land vs global.) HKH: 1.8 °C at 1.5 °C global = 1.2× (ICIMOD 2019 [V]).
 */
const LAND = 1.46;
export const CLIMATE_REGIONS: Readonly<Record<ClimateRegionId, ClimateRegion>> = {
  'us-northeast': { id: 'us-northeast', name: 'US Northeast (land avg.)', factor: LAND, source: 'ar6Spm', tag: 'S' },
  'us-southeast': { id: 'us-southeast', name: 'US Southeast (land avg.)', factor: LAND, source: 'ar6Spm', tag: 'S' },
  'us-south-plains': { id: 'us-south-plains', name: 'US Southern Plains (land avg.)', factor: LAND, source: 'ar6Spm', tag: 'S' },
  'us-southwest': { id: 'us-southwest', name: 'US Southwest (land avg.)', factor: LAND, source: 'ar6Spm', tag: 'S' },
  us: { id: 'us', name: 'land average', factor: LAND, source: 'ar6Spm', tag: 'S' },
  hkh: { id: 'hkh', name: 'Hindu Kush Himalaya', factor: 1.2, source: 'icimod2019', tag: 'V' },
  'global-land': { id: 'global-land', name: 'global land', factor: LAND, source: 'ar6Spm', tag: 'S' },
};

// ─── Extreme rain ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RainScalingInfo {
  id: RainScaling;
  /** Fractional increase per °C. */
  alpha: number;
  label: string;
  note: string;
  sources: string[];
}

export const RAIN_SCALING: Readonly<Record<RainScaling, RainScalingInfo>> = {
  cc: { id: 'cc', alpha: 0.07, label: '7 %/°C (CC)', note: 'Clausius–Clapeyron; AR6’s figure for daily extremes', sources: ['ar6Spm', 'ar6Ch11'] },
  super10: { id: 'super10', alpha: 0.1, label: '10 %/°C', note: 'super-CC, low end of the observed hourly band', sources: ['fowler2021'] },
  super14: { id: 'super14', alpha: 0.14, label: '14 %/°C (2×CC)', note: 'super-CC, top of the observed hourly band', sources: ['lenderink2008', 'fowler2021'] },
};

/** Extreme-rain intensity multiplier (1 + α)^ΔT. */
export function rainMultiplier(deltaT: number, alpha: number): number {
  if (!(deltaT > 0) || !(alpha > 0)) return 1;
  return Math.pow(1 + alpha, deltaT);
}

// ─── Sea level ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type NoaaSlrScenario = 'low' | 'intLow' | 'int' | 'intHigh' | 'high';

export const NOAA_SCENARIO_LABELS: Readonly<Record<NoaaSlrScenario, string>> = {
  low: 'Low',
  intLow: 'Intermediate-Low',
  int: 'Intermediate',
  intHigh: 'Intermediate-High',
  high: 'High',
};

/**
 * The NOAA 2022 scenario each pathway is mapped to. Sweet et al. 2022 (pp. 20–21 [V]): a world at 2 °C in 2081–2100
 * (SSP2-4.5's neighbourhood) has a 2100 GMSL median of ~0.5 m, "consistent with the Intermediate-Low scenario"; at 4 °C
 * the median is ~0.7 m, "between the Intermediate-Low and Intermediate scenarios, with the upper end of the likely range
 * approaching the Intermediate". SSP5-8.5 is mapped to Intermediate — the cautious end of that, as a lender or a 50-year
 * building should read it [M]; Intermediate-High and High need deeply uncertain ice-sheet processes and are left out.
 */
export const PATHWAY_SLR_SCENARIO: Readonly<Record<ClimatePathway, NoaaSlrScenario>> = {
  ssp245: 'intLow',
  ssp585: 'int',
};

export interface TideGaugeSlr {
  id: string;
  name: string;
  /** Year the gauge series is zeroed at. */
  baseYear: number;
  /** Relative sea-level rise since `baseYear`, m (median), by scenario and year. */
  rise: Readonly<Record<NoaaSlrScenario, Readonly<Record<2050 | 2080 | 2100, number>>>>;
  source: string;
  tag: 'V' | 'S' | 'M';
}

/**
 * NOAA 2022 relative SLR at tide gauges a preset stands on: the medians the CO-OPS API serves per station
 * (slr_projections, report_year 2022), read October 2026 [V]. That series is zeroed at 2005 (the report text says a 2000
 * baseline; the 5-year difference is ~2–4 cm here). Naples (8725110) agrees within 1 cm.
 */
export const TIDE_GAUGE_SLR: Readonly<Record<string, TideGaugeSlr>> = {
  'fort-myers': {
    id: 'fort-myers',
    name: 'Fort Myers (NOAA 8725520)',
    baseYear: 2005,
    rise: {
      low: { 2050: 0.24, 2080: 0.36, 2100: 0.43 },
      intLow: { 2050: 0.28, 2080: 0.49, 2100: 0.62 },
      int: { 2050: 0.32, 2080: 0.7, 2100: 1.1 },
      intHigh: { 2050: 0.38, 2080: 1.0, 2100: 1.58 },
      high: { 2050: 0.45, 2080: 1.33, 2100: 2.09 },
    },
    source: 'noaaSlr2022',
    tag: 'V',
  },
};

/** Relative sea-level rise since the gauge's base year, m, by linear interpolation between published years. */
export function seaLevelRiseAt(gauge: TideGaugeSlr, scenario: NoaaSlrScenario, year: number): number {
  const r = gauge.rise[scenario];
  const pts: Array<[number, number]> = [
    [gauge.baseYear, 0],
    [2050, r[2050]],
    [2080, r[2080]],
    [2100, r[2100]],
  ];
  if (year <= gauge.baseYear) return 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [y0, v0] = pts[i];
    const [y1, v1] = pts[i + 1];
    if (year <= y1) return v0 + ((year - y0) / (y1 - y0)) * (v1 - v0);
  }
  return r[2100];
}

/** Sea-level rise for a pathway at a horizon, m above the "Today" (2000-baseline) water levels. 0 for Today. */
export function seaLevelRise(gauge: TideGaugeSlr, pathway: ClimatePathway, horizon: ClimateHorizon): number {
  if (horizon === 'today') return 0;
  return seaLevelRiseAt(gauge, PATHWAY_SLR_SCENARIO[pathway], Number(horizon));
}

// ─── Glacial lakes ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface LakeTrend {
  id: string;
  name: string;
  /** Area at `year0`, km² (the area the preset's lake record holds). */
  area0: number;
  year0: number;
  /** Observed recent growth, km² per year (linear trend). */
  rate: number;
  /** Observation window of the trend, e.g. "1990–2019". */
  window: string;
  /** Global warming rate over the observation window, °C per year: growth per °C = rate / this. */
  windowWarmingRate: number;
  /** Largest plausible area, km² (the overdeepened basin the lake can occupy), or null if none is published. */
  maxArea: number | null;
  source: string;
  sourceText: string;
  tag: 'V' | 'S' | 'M';
}

/** Glacial lakes behind chain presets. */
export const LAKE_TRENDS: Readonly<Record<string, LakeTrend>> = {
  'south-lhonak': {
    id: 'south-lhonak',
    name: 'South Lhonak Lake',
    area0: 1.674,
    year0: 2023,
    // 1.674 km² on 28 Sep 2023 (NRSC, via SANDRP) [S]; ≈ 0.99 km² in 2008 (Raj et al. 2013: 17.54 ha in 1977 + 81.1 ha
    // to 2008) [S] → 0.046 km²/yr over 2008–2023 [C]. Global warming over that window ≈ 0.25 °C/decade (Forster 2025:
    // 0.27 °C/decade recently) [S].
    rate: 0.046,
    window: '2008–2023',
    windowWarmingRate: 0.025,
    // No basin survey is published for the lake's possible extent: growth is capped at 2× its 2023 area [M].
    maxArea: 2 * 1.674,
    source: 'lhonak',
    sourceText: 'Raj et al. 2013 / NRSC 2023',
    tag: 'M',
  },
};

/**
 * Lake area at a calendar year, km² [M]: the observed linear trend, scaled by how fast the world warms over the horizon
 * relative to the observation window — area grows in proportion to warming, ΔA = (rate / windowWarmingRate) · ΔT —
 * because lake growth follows glacier retreat, which follows temperature. Capped at the basin's published maximum where
 * there is one. `deltaT` is the global warming between `year0` and the horizon, °C.
 */
export function lakeAreaAfterWarming(lake: LakeTrend, deltaT: number): number {
  if (!(deltaT > 0)) return lake.area0;
  const perDegree = lake.rate / lake.windowWarmingRate;
  const a = lake.area0 + perDegree * deltaT;
  return lake.maxArea != null ? Math.min(lake.maxArea, a) : a;
}

/** Global warming between two calendar years under a pathway, °C (piecewise linear through the AR6 periods) [C]. */
export function warmingBetween(pathway: ClimatePathway, fromYear: number, toYear: number): number {
  const t = AR6_WARMING_RECENT[pathway];
  // 1995–2014 centre (2005) = 0; 2050 = mid; 2090 = long; extrapolate the last segment to 2100.
  const pts: Array<[number, number]> = [
    [2005, 0],
    [MID_CENTRE, t.mid.best],
    [LONG_CENTRE, t.long.best],
  ];
  const at = (y: number): number => {
    if (y <= pts[0][0]) return 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const [y0, v0] = pts[i];
      const [y1, v1] = pts[i + 1];
      if (y <= y1) return v0 + ((y - y0) / (y1 - y0)) * (v1 - v0);
    }
    const [y0, v0] = pts[pts.length - 2];
    const [y1, v1] = pts[pts.length - 1];
    return v1 + ((y - y1) / (y1 - y0)) * (v1 - v0);
  };
  return Math.max(0, at(toYear) - at(fromYear));
}

// ─── Glacier melt ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Clean-ice degree-day factor above 5,000 m, mm w.e. °C⁻¹ d⁻¹ (Parajuli et al. 2015 [V], src/hazard/defaults.ts). */
export const MELT_DDF_ICE = 7.5;

/** Extra melt per day on clean glacier ice for a local warming, mm w.e./day (degree-day, melt season). */
export function extraMeltPerDay(localDeltaT: number, ddf = MELT_DDF_ICE): number {
  return localDeltaT > 0 ? ddf * localDeltaT : 0;
}
