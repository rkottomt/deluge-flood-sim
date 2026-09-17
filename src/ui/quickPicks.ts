/**
 * The location picker's quick picks and their tooltips (pure, unit-tested). A tip describes the place; what to try
 * there depends on what the live load finds (a water body crossing the area's edge gives it a water-level control,
 * otherwise only rain and storms flood it), so once a pick has loaded its tip says what that load offered.
 */

export interface QuickPick {
  name: string;
  lat: number;
  lon: number;
  note: string;
  /** The place (history, geography), without claims about what the loaded scene will offer. */
  tip: string;
  /** Rain is the story here (e.g. Houston and Harvey): the tip suggests Hurricane rain. */
  rainStory?: boolean;
}

export const QUICK_PICKS: QuickPick[] = [
  { name: 'New Orleans', lat: 29.9511, lon: -90.0715, note: 'Below sea level', tip: 'Much of the city sits below sea level between the Mississippi and Lake Pontchartrain' },
  { name: 'Houston', lat: 29.7604, lon: -95.3698, note: 'Harvey, 2017', tip: 'Flat bayou city — Hurricane Harvey dropped over 40 inches of rain in 2017', rainStory: true },
  { name: 'Miami', lat: 25.7617, lon: -80.1918, note: 'Low & coastal', tip: 'Low-lying coastal city on porous limestone' },
  { name: 'Boulder', lat: 40.015, lon: -105.2705, note: 'Flash floods', tip: 'Canyon mouth at the foot of the Rockies — the 2013 Front Range floods' },
  { name: 'Asheville NC', lat: 35.5951, lon: -82.5515, note: 'Helene, 2024', tip: 'Mountain river valley devastated by Hurricane Helene flooding in 2024' },
  { name: 'Sacramento', lat: 38.5816, lon: -121.4944, note: 'Two rivers', tip: 'Confluence of the Sacramento and American rivers, protected by levees' },
];

/** What a live load of a quick pick offered. */
export interface LoadedArea {
  /** The scenario has a water-level control (a water body crosses the area's edge). */
  waterLevel: boolean;
  /** The size and grid it was loaded at (detection depends on both). */
  sizeMeters?: number;
  resolution?: number;
}

/** Tooltip for a quick pick, before it has loaded (`loaded` null) or after. */
export function quickPickTip(pick: QuickPick, loaded: LoadedArea | null | undefined): string {
  if (!loaded) return pick.rainStory ? `${pick.tip}. Once it loads, try Hurricane rain` : pick.tip;
  const at =
    loaded.sizeMeters && loaded.resolution ? `Loaded at ${Math.round(loaded.sizeMeters / 100) / 10} km · ${loaded.resolution}²` : 'Loaded';
  if (loaded.waterLevel) {
    return `${pick.tip}. ${at}, it has a water-level control — raise the water${pick.rainStory ? ', or try Hurricane rain' : ''}`;
  }
  return `${pick.tip}. ${at}, no water body crosses its edge, so rain floods it — try Hurricane rain`;
}

/** The quick pick whose centre a request uses, if any. */
export function quickPickAt(lat: number, lon: number): QuickPick | null {
  return QUICK_PICKS.find((p) => p.lat === lat && p.lon === lon) ?? null;
}
