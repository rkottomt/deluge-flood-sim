/**
 * The three business use cases (src/ui/useCases.ts draws them; src/app/url.ts reads `?usecase=`):
 *
 *   site       Check a site before you build — Pittsburgh, two demo parcels in Site check (a North Shore lot and one on
 *              the higher ground of Allegheny Center), handed over as a `?sites=` value through the same strict decoder
 *              a shared link uses (src/loss/site.ts decodeSites).
 *   glacier    Glacier risk for hydropower — Nepal 2026, the Hazard chain section and its Early warning designer.
 *   portfolio  Portfolio exposure — Houston (Harvey rain) with a bundled, fictional demo portfolio CSV
 *              (public/demo/houston-portfolio.csv) loaded into Impact & loss.
 *
 * Pure data and parsing only (no DOM), so the URL parser and the unit tests can import it.
 *
 * SECURITY. `?usecase=` is matched exactly against the three ids below; anything else is dropped with a fixed sentence
 * and never echoed (FINDINGS.json SEC-01). No part of the value reaches the page.
 */

export const USE_CASE_IDS = ['site', 'glacier', 'portfolio'] as const;
export type UseCaseId = (typeof USE_CASE_IDS)[number];

/** URL parameter that opens a use case. */
export const USE_CASE_PARAM = 'usecase';

export interface UseCaseDef {
  id: UseCaseId;
  /** Preset the use case runs on. */
  preset: string;
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
];

export function useCaseById(id: UseCaseId): UseCaseDef {
  return USE_CASES.find((u) => u.id === id)!;
}

export function isUseCaseId(v: unknown): v is UseCaseId {
  return typeof v === 'string' && (USE_CASE_IDS as readonly string[]).includes(v);
}

/** Fixed warning for a `?usecase=` value that is not one of the ids (the value itself is never shown). */
export const USE_CASE_WARNING = 'Ignoring an unknown ?usecase= link value (expected site, glacier or portfolio)';

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
      'An indicative finished-floor elevation (design water level + ASCE 24-14 freeboard) and a verdict in plain sentences',
    ],
    caveat:
      'Return periods are filled in only where a published source gives one (Pittsburgh, Nashville, Fort Myers); elsewhere they are yours to enter and labelled so. Without them there is no expected annual loss.',
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
