/**
 * The business use cases (src/ui/useCases.ts draws them; src/app/url.ts reads `?usecase=`):
 *
 *   address    Check any US address — a geocoder search (or `?usecase=address&at=<lat>,<lon>`) loads a 5 km live area
 *              around the point, drops a site on it and opens Site check on the NOAA Atlas 14 rain ladder.
 *   site       Check a site before you build — Pittsburgh, two demo parcels in Site check (a North Shore lot and one on
 *              the higher ground of Allegheny Center), handed over as a `?sites=` value through the same strict decoder
 *              a shared link uses (src/loss/site.ts decodeSites).
 *   glacier    Glacier risk for hydropower — Nepal 2026, the Hazard chain section and its Early warning designer.
 *   portfolio  Portfolio exposure — Houston (Harvey rain) with a bundled, fictional demo portfolio CSV
 *              (public/demo/houston-portfolio.csv) loaded into Impact & loss.
 *
 * Pure data and parsing only (no DOM), so the URL parser and the unit tests can import it.
 *
 * SECURITY. `?usecase=` is matched exactly against the ids below; anything else is dropped with a fixed sentence and
 * never echoed (FINDINGS.json SEC-01). No part of the value reaches the page. The address case takes NO text from the
 * link — no address, no name — only `at=<lat>,<lon>`, read by a strict number pattern (parseAddressAt); the place's
 * name comes from the app's own reverse geocoding, as for any live area.
 */

import type { LiveAreaRequest } from '../contracts';
import { isLikelyUS } from '../data/geo';

export const USE_CASE_IDS = ['site', 'glacier', 'portfolio', 'address'] as const;
export type UseCaseId = (typeof USE_CASE_IDS)[number];

/** URL parameter that opens a use case. */
export const USE_CASE_PARAM = 'usecase';

export interface UseCaseDef {
  id: UseCaseId;
  /** Preset the use case runs on; null for the address case (a live area where the user points). */
  preset: string | null;
  title: string;
  /** Who it is for, one line. */
  who: string;
  /** What it answers, one sentence. */
  blurb: string;
  /** The one-line how-to shown once it is open. */
  howTo: string;
}

export const USE_CASES: readonly UseCaseDef[] = [
  {
    id: 'site',
    preset: 'pittsburgh',
    title: 'Check a site before you build',
    who: 'Developers, lenders, corporate real estate',
    blurb: 'Two candidate parcels in Pittsburgh: depth at the planned floor, when the last road out closes, an indicative floor level and what protection would cost and save.',
    howTo: 'Two demo parcels are in Site check. Press Run sweep to test them against the NWS, FEMA and historic flood levels, or press S and click the map to add your own.',
  },
  {
    id: 'glacier',
    preset: 'nepal',
    title: 'Glacier risk for hydropower',
    who: 'Hydropower owners, lenders, infrastructure',
    blurb: 'Nepal, 26 August 2026: an ice-and-rock avalanche’s debris flood routed down the Bhote Koshi past the hydropower plants to Betrawati — when the front reached each, and how many minutes a sensor upstream would buy.',
    howTo: 'The valley timeline follows the wave past each plant. Under Early warning, press Add sensor and click the profile, or Suggest best site.',
  },
  {
    id: 'portfolio',
    preset: 'houston',
    title: 'Portfolio exposure',
    who: 'Insurers, lenders, asset managers',
    blurb: 'A fictional 19-asset Houston portfolio under Hurricane Harvey’s worst hour of rain: depth, loss, insured loss and downtime per asset, read from a CSV in this tab.',
    howTo: 'The demo portfolio is loaded in Impact & loss and updates as the rain falls. Load your own CSV there; it never leaves this tab.',
  },
  {
    id: 'address',
    preset: null,
    title: 'Check any US address',
    who: 'Developers, lenders, site selection',
    blurb: 'Type an address: Deluge loads 5 km of terrain, imagery and roads around it, drops a site there and sweeps it through NOAA Atlas 14 rain return periods to an expected annual loss.',
    howTo: 'The site is in Site check with the NOAA Atlas 14 rain ladder ticked (2- to 500-year, 1-hour storm). Press Run sweep for depth, egress and expected annual loss.',
  },
];

// ─── The address use case ───────────────────────────────────────────────────────────────────────────────────────────

/** Link parameter carrying the address point: `at=<lat>,<lon>`. */
export const ADDRESS_PARAM = 'at';
/** Side of the live area loaded around an address, m (a 5 km square at the default 1024² grid: ~4.9 m cells). */
export const ADDRESS_AREA_M = 5000;
/** Fixed warning for a missing or bad `at=` (the value itself is never shown). */
export const ADDRESS_WARNING = 'Ignoring an invalid ?at= link value (expected lat,lon in the United States, e.g. 29.7604,-95.3698)';
/** Up to 6 decimals (~0.1 m), optional minus, no exponent, no spaces, no extra fields. */
const AT_RE = /^(-?\d{1,2}(?:\.\d{1,6})?),(-?\d{1,3}(?:\.\d{1,6})?)$/;

/**
 * Read `at=<lat>,<lon>` strictly: two plain decimals inside U.S. coverage (src/data/geo.ts isLikelyUS — Atlas 14 and
 * 3DEP are U.S. datasets). A missing value is no point and no warning; anything else is no point and a fixed warning.
 */
export function parseAddressAt(search: string): { at: { lat: number; lon: number } | null; warnings: string[] } {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get(ADDRESS_PARAM);
  } catch {
    raw = null;
  }
  if (raw === null || raw === '') return { at: null, warnings: [] };
  const m = raw.length <= 32 ? AT_RE.exec(raw) : null;
  if (m) {
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    if (isLikelyUS(lat, lon)) return { at: { lat, lon }, warnings: [] };
  }
  return { at: null, warnings: [ADDRESS_WARNING] };
}

/** Grid of the live area loaded around an address (the app default). */
export const ADDRESS_RESOLUTION = 1024;

/** The live area the address use case loads around a point. */
export function addressAreaRequest(at: { lat: number; lon: number }): LiveAreaRequest {
  return { center: { lat: at.lat, lon: at.lon }, sizeMeters: ADDRESS_AREA_M, resolution: ADDRESS_RESOLUTION };
}

/** `lat,lon` as the link writes it (5 decimals, ~1 m). */
export function formatAddressAt(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

export function useCaseById(id: UseCaseId): UseCaseDef {
  return USE_CASES.find((u) => u.id === id)!;
}

export function isUseCaseId(v: unknown): v is UseCaseId {
  return typeof v === 'string' && (USE_CASE_IDS as readonly string[]).includes(v);
}

/** Fixed warning for a `?usecase=` value that is not one of the ids (the value itself is never shown). */
export const USE_CASE_WARNING = 'Ignoring an unknown ?usecase= link value (expected site, glacier, portfolio or address)';

/**
 * Read `?usecase=` strictly: exactly one of the ids, case-sensitive, no surrounding junk. A missing or empty value is
 * no use case and no warning.
 */
export function parseUseCase(search: string): { useCase: UseCaseId | null; warnings: string[] } {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get(USE_CASE_PARAM);
  } catch {
    raw = null;
  }
  if (raw === null || raw === '') return { useCase: null, warnings: [] };
  if (raw.length <= 16 && isUseCaseId(raw)) return { useCase: raw, warnings: [] };
  return { useCase: null, warnings: [USE_CASE_WARNING] };
}

/**
 * The demo parcels for the site use case, in the `?sites=` format (src/loss/site.ts encodeSites):
 *   A — a surface lot on Pittsburgh's North Shore between the stadiums, outlined (ground ≈ 222.7 m, below the 1936
 *       crest of 225.4 m and near FEMA's 1 % level);
 *   B — the same planned building on the higher ground of Allegheny Center, 700 m inland (ground ≈ 234.6 m).
 * Both: a 6-storey apartment building, $45 M replacement value. Read through decodeSites like any shared link.
 */
export const DEMO_SITES_PARAM =
  'v1:40.446,-80.0124,40.44632,-80.01305,40.44632,-80.01175,40.44569,-80.01175,40.44569,-80.01305~apt~6~45000000~~~~Demo%20parcel%20A%20(North%20Shore)' +
  ';40.4525,-80.0045~apt~6~45000000~~~3000~Demo%20parcel%20B%20(Allegheny%20Center)';

/** The bundled demo portfolio, relative to the app's base URL (public/demo/). */
export const DEMO_PORTFOLIO_PATH = 'demo/houston-portfolio.csv';
/** Name it is shown under in Impact & loss. */
export const DEMO_PORTFOLIO_NAME = 'houston-portfolio.csv (fictional demo)';

// ─── The business brief ("What Deluge answers for your business") ───────────────────────────────────────────────────

export interface BriefItem {
  question: string;
  /** Where in the app. */
  where: string;
  /** What the app computes for it. */
  numbers: string[];
  /** The honest limit of those numbers. */
  caveat: string;
}

/** One page: the questions a business brings, the numbers the app computes for each, and what those numbers are not. */
export const BRIEF: readonly BriefItem[] = [
  {
    question: 'Is this parcel a good place to build?',
    where: 'Site check',
    numbers: [
      'Depth at grade and above the planned floor, flow speed, and the AIDR hazard class (H1–H6)',
      'When the water arrives and how long it stays',
      'Damage and loss for the planned building, with the damage-curve range',
      'A sweep over NWS flood categories, FEMA / NOAA 1 %-type levels and historic crests: expected annual loss and a loss-exceedance chart',
      'Anywhere in the US: a sweep over NOAA Atlas 14 rain return periods (2- to 500-year, 1-hour storm) at the address, with its expected annual loss from surface-water flooding',
      'An indicative finished-floor elevation (design water level + ASCE 24-14 freeboard) and a verdict in plain sentences',
    ],
    caveat:
      'River and tide return periods are filled in only where a published source gives one (Pittsburgh, Nashville, Fort Myers); elsewhere they are yours to enter and labelled so. The NOAA Atlas 14 rain ladder is rain only — no river or storm surge on the map — and stationary (today’s climate).',
  },
  {
    question: 'How do people get out?',
    where: 'Site check · Evacuation',
    numbers: [
      'When the last road route from the site to a dry shelter closes, against when the water arrives',
      'A live evacuation route that re-plans as streets flood, or turns red when every way out is cut',
    ],
    caveat:
      'Roads are Census centre-lines, and a road counts as cut at 0.3 m of water, where cars and trucks stop. Traffic, debris on bridges and people who leave late are not modelled.',
  },
  {
    question: 'What would protection cost, and what would it save?',
    where: 'Impact & loss · Site check',
    numbers: [
      'Avoided loss from a wall or levee you draw, and the buildings it makes wetter elsewhere',
      'Cost of a wall, levee, elevation or dry floodproofing from planning-level unit rates',
      'Benefit–cost ratio at 7 % (the FEMA default) and 3.1 %',
    ],
    caveat:
      'One simulated event gives a one-event BCR. It becomes an annualised, FEMA-style figure only with return periods for a ladder of levels; the costs are planning rates, not quotes.',
  },
  {
    question: 'What is our portfolio exposed to?',
    where: 'Impact & loss → Load CSV',
    numbers: [
      'Per asset: depth, speed, hazard class, first arrival, critical equipment wet, access road cut',
      'Loss with its damage-curve range, business interruption, and insured loss after deductible and limit',
      'Portfolio totals and the first asset the water reaches',
    ],
    caveat:
      'Assets are matched to OpenStreetMap footprints within 30 m (or your own WKT outline). Values left blank are estimated from footprint area × storeys × a national unit cost.',
  },
  {
    question: 'How much warning would a glacier flood give?',
    where: 'Hazard chain · Early warning',
    numbers: [
      'Model arrival time of the flood front at each town, bridge and hydropower plant down the valley',
      'The lead time each place gets from a sensor you place, after its detection and alert delay',
      'The best single sensor site, and the early-front (p10) members of the routing ensemble',
    ],
    caveat:
      'Front times come from routing an uncertain source volume down a 1-D valley profile: model times, not a forecast. A lead time says nothing about whether the alert is acted on.',
  },
];

/** What every number in the app is not. */
export const BRIEF_LIMITS: readonly string[] = [
  'Bare-earth terrain: buildings, bridge decks, culverts and storm drains are not in the elevation model, and river channels are burned to a nominal depth.',
  'One scenario at a time. A probability comes only from the levels you run and the return periods attached to them; an ensemble mode that puts a spread on every number is being built.',
  'Damage uses the JRC global depth–damage curves (Huizinga et al. 2017). The range shown is the spread of those curves only; the real uncertainty is wider.',
  'Screening, not a flood study, an engineering design, an insurance valuation or a catastrophe model. Nothing you load or type leaves this browser tab.',
];
