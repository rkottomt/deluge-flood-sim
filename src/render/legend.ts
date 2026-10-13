/**
 * Hazard colormaps for the non-photoreal water modes. Single source of truth: the UI draws the legends from these
 * arrays, and the renderer solves (tonemap.ts) for the HDR shader colours that come out of the filmic tone mapper as
 * exactly these colours, so a swatch matches the water on screen. The palest ColorBrewer tints cannot survive the
 * tone mapper without blooming; those bands use the nearest colour it can reproduce (tests/render/tonemap.test.ts).
 *
 * Palettes are sequential, monotonic in lightness and colorblind-safe (they avoid red/green contrasts):
 *  • depth     — ColorBrewer "YlGnBu" (light yellow-green → deep navy): deeper = darker.
 *  • max depth — ColorBrewer "BuPu"-derived (pale blue-grey → dark purple) so an extent map is never confused
 *                with the live depth map.
 *  • velocity  — ColorBrewer "YlOrRd" (yellow → dark red): faster = hotter. The slowest band is drawn as plain
 *                water (it is most of any flood), so the dangerous fast cores stand out.
 *  • arrival   — viridis (dark purple → yellow-green; the brightest yellow is replaced by the nearest one the tone
 *                mapper reproduces): earliest = darkest, the places with the least warning.
 *  • hazard    — sand → umber (lightness-sequential browns) for the AIDR H1–H6 classes: darker = more dangerous.
 *                Browns because every other hue is taken: pinks trip the visual suite's NaN-magenta detector and
 *                dark crimsons, once lit and shaded, read as the max-depth and arrival purples.
 *  • probability — pale green → blue → indigo for an ensemble's exceedance share (PROBABILITY_BANDS).
 * Every swatch is ≥ 45 sRGB units from every swatch of the other modes, so the legend-vs-pixels check of
 * scripts/visual.mjs can tell the modes apart.
 *
 * Depth, max depth, arrival and hazard colour only land that was dry before the flood; the normal river / lake is
 * drawn as muted plain water (NORMAL_WATER_LEGEND). Arrival and hazard are read from the solver's hazard
 * accumulators (FloodSolver.hazardBuffer) and drawn on the max-depth water surface, like the max-depth map.
 */

export interface HazardBand {
  /** Lower bound (inclusive) in the band's unit. */
  min: number;
  /** Upper bound (exclusive); Infinity for the open-ended top band. */
  max: number;
  /** CSS color (hex, sRGB). */
  color: string;
  /** Short label for the legend. */
  label: string;
  /** Plain-language meaning. */
  note?: string;
}

export const DEPTH_BANDS: HazardBand[] = [
  { min: 0, max: 0.15, color: '#ccdfa0', label: '< 0.15 m', note: 'Ankle deep' },
  { min: 0.15, max: 0.5, color: '#7fcdbb', label: '0.15–0.5 m', note: 'Knocks people over' },
  { min: 0.5, max: 1, color: '#41b6c4', label: '0.5–1 m', note: 'Cars float' },
  { min: 1, max: 2, color: '#1d91c0', label: '1–2 m', note: 'Ground floor flooded' },
  { min: 2, max: 3, color: '#225ea8', label: '2–3 m', note: 'Over head height' },
  { min: 3, max: Infinity, color: '#0c2c84', label: '3 m +', note: 'Second storey' },
];

export const MAX_DEPTH_BANDS: HazardBand[] = [
  { min: 0, max: 0.15, color: '#d5dbdf', label: '< 0.15 m', note: 'Ankle deep' },
  { min: 0.15, max: 0.5, color: '#b4c8de', label: '0.15–0.5 m', note: 'Knocks people over' },
  { min: 0.5, max: 1, color: '#9ebcda', label: '0.5–1 m', note: 'Cars float' },
  { min: 1, max: 2, color: '#8c96c6', label: '1–2 m', note: 'Ground floor flooded' },
  { min: 2, max: 3, color: '#8856a7', label: '2–3 m', note: 'Over head height' },
  { min: 3, max: Infinity, color: '#810f7c', label: '3 m +', note: 'Second storey' },
];

export const VELOCITY_BANDS: HazardBand[] = [
  { min: 0, max: 0.5, color: '#7a7264', label: '< 0.5 m/s', note: 'Ponding (plain water)' },
  { min: 0.5, max: 1, color: '#e4c87c', label: '0.5–1 m/s', note: 'Walking pace' },
  { min: 1, max: 2, color: '#eaac5f', label: '1–2 m/s', note: 'Dangerous to wade' },
  { min: 2, max: 3, color: '#f08f4c', label: '2–3 m/s', note: 'Moves cars' },
  { min: 3, max: 5, color: '#f03b20', label: '3–5 m/s', note: 'Scours roads' },
  { min: 5, max: Infinity, color: '#bd0026', label: '5 m/s +', note: 'Destructive' },
];

/**
 * Arrival time: minutes after reset that water first stood deeper than ARRIVAL_DEPTH (0.15 m, HazardFields.firstWet).
 * Land the water never reached that deep carries no colour.
 */
export const ARRIVAL_BANDS: HazardBand[] = [
  { min: 0, max: 5, color: '#440154', label: '< 5 min', note: 'No time to leave' },
  { min: 5, max: 15, color: '#414487', label: '5–15 min', note: 'Minutes of warning' },
  { min: 15, max: 30, color: '#21918c', label: '15–30 min' },
  { min: 30, max: 60, color: '#35b779', label: '30–60 min' },
  { min: 60, max: 120, color: '#90d743', label: '1–2 h' },
  { min: 120, max: Infinity, color: '#d0d84a', label: '2 h +', note: 'Time to evacuate' },
];

/**
 * Australian Institute for Disaster Resilience (AIDR 2017, Handbook 7 guideline 7-3) flood hazard thresholds, from the
 * maxima since reset of depth d (m), speed v (m/s) and d·v (m²/s, HazardFields.maxDV): a cell is the first class
 * whose three limits it is within, H6 when none. Single source of truth for the legend, the CPU classifier and the
 * WGSL of the prep pass (src/render/shaders/prep.ts).
 */
export const AIDR_HAZARD_LIMITS: ReadonlyArray<{ dv: number; d: number; v: number }> = [
  { dv: 0.3, d: 0.3, v: 2 },
  { dv: 0.6, d: 0.5, v: 2 },
  { dv: 0.6, d: 1.2, v: 2 },
  { dv: 1.0, d: 2, v: 2 },
  { dv: 4, d: 4, v: 4 },
];

/** AIDR hazard class 1…6 of a cell (see AIDR_HAZARD_LIMITS); the value the hazard map's bands are keyed on. */
export function aidrHazardClass(d: number, v: number, dv: number): number {
  for (let k = 0; k < AIDR_HAZARD_LIMITS.length; k++) {
    const L = AIDR_HAZARD_LIMITS[k];
    if (dv <= L.dv && d <= L.d && v <= L.v) return k + 1;
  }
  return AIDR_HAZARD_LIMITS.length + 1;
}

/** Hazard classes H1–H6 (AIDR 2017). Band k covers the class value k (min/max are the half-way points). */
export const HAZARD_BANDS: HazardBand[] = [
  { min: 0, max: 1.5, color: '#c6b2a6', label: 'H1', note: 'Generally safe' },
  { min: 1.5, max: 2.5, color: '#b6977a', label: 'H2', note: 'Unsafe for small vehicles' },
  { min: 2.5, max: 3.5, color: '#9a6d47', label: 'H3', note: 'Unsafe for vehicles, children, the elderly' },
  { min: 3.5, max: 4.5, color: '#77482a', label: 'H4', note: 'Unsafe for vehicles and people' },
  { min: 4.5, max: 5.5, color: '#4f2c15', label: 'H5', note: 'Buildings vulnerable to damage' },
  { min: 5.5, max: Infinity, color: '#24130a', label: 'H6', note: 'Buildings vulnerable to failure' },
];

/**
 * Ensemble flood probability (the 'probability' view): the share of an ensemble's members, in %, whose max depth
 * exceeded the view's threshold (0.15 m by default, 0.5 m on request; src/loss/ensemble.ts). Pale green → indigo:
 * the only lightness-sequential run left once every other mode's swatches, the NaN-magenta detector and the tone
 * mapper's reachable gamut are ruled out (each swatch ≥ 52 sRGB units from every other mode's). Darker = more of the
 * members flooded there.
 */
export const PROBABILITY_BANDS: HazardBand[] = [
  { min: 0, max: 10, color: '#9ce488', label: '< 10 %', note: 'Rarely — only the wettest members' },
  { min: 10, max: 30, color: '#5cb84a', label: '10–30 %' },
  { min: 30, max: 50, color: '#5478c8', label: '30–50 %' },
  { min: 50, max: 70, color: '#3c5ce8', label: '50–70 %' },
  { min: 70, max: 90, color: '#2028d0', label: '70–90 %' },
  { min: 90, max: Infinity, color: '#1c06a4', label: '> 90 %', note: 'Floods in nearly every member' },
];

/**
 * Legend entry for the normal river / lake in the depth and max-depth maps: water that was there before the flood
 * is not coloured by depth (its depth is not a hazard), only shown as muted plain water.
 */
export const NORMAL_WATER_LEGEND = { color: '#3c454b', label: 'Normal river', note: 'Water there before the flood' } as const;

/** Whether a mode's map leaves the normal river uncoloured (and the legend should show NORMAL_WATER_LEGEND). */
export function showsNormalWater(mode: string): boolean {
  return mode === 'depth' || mode === 'maxDepth' || mode === 'arrival' || mode === 'hazard' || mode === 'probability';
}

/** Bands used by a given water view mode (null for 'realistic'). */
export function bandsForMode(mode: string): HazardBand[] | null {
  switch (mode) {
    case 'depth':
      return DEPTH_BANDS;
    case 'maxDepth':
      return MAX_DEPTH_BANDS;
    case 'velocity':
      return VELOCITY_BANDS;
    case 'arrival':
      return ARRIVAL_BANDS;
    case 'hazard':
      return HAZARD_BANDS;
    case 'probability':
      return PROBABILITY_BANDS;
    default:
      return null;
  }
}

/** '#rrggbb' → linear-light RGB in [0,1] (what the HDR shaders expect). */
export function cssToLinear(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return [1, 0, 1];
  const toLin = (s: string) => {
    const c = parseInt(s, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return [toLin(m[1]), toLin(m[2]), toLin(m[3])];
}
