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
 *
 * Depth and max depth colour only land that was dry before the flood; the normal river / lake is drawn as muted
 * plain water (NORMAL_WATER_LEGEND).
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
 * Legend entry for the normal river / lake in the depth and max-depth maps: water that was there before the flood
 * is not coloured by depth (its depth is not a hazard), only shown as muted plain water.
 */
export const NORMAL_WATER_LEGEND = { color: '#3c454b', label: 'Normal river', note: 'Water there before the flood' } as const;

/** Whether a mode's map leaves the normal river uncoloured (and the legend should show NORMAL_WATER_LEGEND). */
export function showsNormalWater(mode: string): boolean {
  return mode === 'depth' || mode === 'maxDepth';
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
