/**
 * Which country's costs and which continent's damage curves apply to a domain, from its geographic bounds.
 *
 * Deliberately coarse: a handful of bounding boxes around the domain's CENTRE, checked smallest first (Nepal and Bhutan
 * sit inside India's box). It only has to tell apart the places Deluge has presets and cost tables for — the United
 * States, Nepal and India — and otherwise name a continent for the JRC curves. A domain near a border can be assigned
 * to the wrong side; the panel always prints the region it used, so that is visible rather than silent.
 */
import type { GeoBounds } from '../contracts';
import type { Continent } from './curves';

/** Countries with a unit-cost table (value.ts). Anything else is 'other': damage and hazard only, no default $. */
export type CostCountry = 'US' | 'IN' | 'NP';

export interface Region {
  /** ISO 3166-1 alpha-2 when recognised (also for countries without a cost table), else ''. */
  iso: string;
  /** Display name. */
  name: string;
  /** Country whose unit costs apply, or null when there is no table (no default dollar values). */
  costCountry: CostCountry | null;
  continent: Continent;
  /** Currency of the cost table. All tables are in 2026 US dollars. */
  currency: 'USD';
}

interface Box {
  iso: string;
  name: string;
  continent: Continent;
  w: number;
  s: number;
  e: number;
  n: number;
}

/** Smallest first. Boxes are generous rectangles, not borders. */
const COUNTRY_BOXES: readonly Box[] = [
  { iso: 'BT', name: 'Bhutan', continent: 'asia', w: 88.7, s: 26.7, e: 92.2, n: 28.4 },
  { iso: 'NP', name: 'Nepal', continent: 'asia', w: 80.0, s: 26.3, e: 88.25, n: 30.5 },
  { iso: 'US', name: 'United States (Hawaii)', continent: 'northAmerica', w: -160.5, s: 18.8, e: -154.7, n: 22.4 },
  { iso: 'IN', name: 'India', continent: 'asia', w: 68.0, s: 6.5, e: 97.5, n: 35.6 },
  { iso: 'US', name: 'United States', continent: 'northAmerica', w: -125.0, s: 24.4, e: -66.9, n: 49.4 },
  { iso: 'US', name: 'United States (Alaska)', continent: 'northAmerica', w: -170.0, s: 51.0, e: -129.9, n: 71.5 },
];

/** Continents as very rough boxes, for a domain outside every country box above (JRC curve choice only). */
const CONTINENT_BOXES: ReadonlyArray<{ c: Continent; w: number; s: number; e: number; n: number }> = [
  { c: 'europe', w: -25, s: 34, e: 45, n: 72 },
  { c: 'africa', w: -20, s: -36, e: 52, n: 34 },
  { c: 'asia', w: 45, s: -11, e: 180, n: 78 },
  { c: 'oceania', w: 110, s: -50, e: 180, n: -11 },
  { c: 'northAmerica', w: -170, s: 13, e: -50, n: 84 },
  { c: 'centralSouthAmerica', w: -120, s: -56, e: -30, n: 13 },
];

const COST: Readonly<Record<string, CostCountry>> = { US: 'US', IN: 'IN', NP: 'NP' };

/** Display names for the JRC continents. */
export const CONTINENT_LABELS: Readonly<Record<Continent, string>> = {
  europe: 'European',
  northAmerica: 'North-American',
  centralSouthAmerica: 'Central & South American',
  asia: 'Asian',
  africa: 'African',
  oceania: 'Oceanian',
  global: 'global',
};

export function regionAt(lon: number, lat: number): Region {
  for (const b of COUNTRY_BOXES) {
    if (lon >= b.w && lon <= b.e && lat >= b.s && lat <= b.n) {
      return { iso: b.iso, name: b.name, costCountry: COST[b.iso] ?? null, continent: b.continent, currency: 'USD' };
    }
  }
  for (const b of CONTINENT_BOXES) {
    if (lon >= b.w && lon <= b.e && lat >= b.s && lat <= b.n) {
      return { iso: '', name: 'Outside the cost tables', costCountry: null, continent: b.c, currency: 'USD' };
    }
  }
  return { iso: '', name: 'Outside the cost tables', costCountry: null, continent: 'global', currency: 'USD' };
}

/** Region of a domain (by its centre). */
export function regionForBounds(b: GeoBounds): Region {
  return regionAt((b.west + b.east) / 2, (b.south + b.north) / 2);
}
