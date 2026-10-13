/**
 * The words that go with the numbers: how the Impact panel and its printed report compute what they show, what they
 * assume, and where each assumption comes from. Plain data (no DOM) so the panel, the report and a test can share it.
 * Keep it in step with src/loss — every constant named here lives there with the same source.
 */
import {
  CONTENT_FACTOR_COM,
  CONTENT_FACTOR_IND,
  CONTENT_FACTOR_RES,
  DAMAGED_MIN_FRACTION,
  DAMAGE_MIN_DEPTH,
  DEFAULT_CURVE_SIGMA,
  DISCOUNT_RATE_FEMA,
  DISCOUNT_RATE_LOW,
  MATCH_RADIUS_M,
  ACCESS_SNAP_M,
  REACHED_DEPTH,
  UNDAMAGEABLE_SHARE_MASONRY,
  UNIT_COST_USD_M2,
  USEFUL_LIFE_WALL_YEARS,
} from '../loss';

export interface MethodNote {
  title: string;
  text: string;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10} %`;
const usd = (x: number) => `$${x.toLocaleString('en-US')}`;

/** What the numbers are, in the order a reader needs them. */
export const METHOD_NOTES: readonly MethodNote[] = [
  {
    title: 'What this is',
    text:
      'A screening estimate for ONE simulated scenario: the flood the simulator has run so far, on bare-earth terrain at the ' +
      'cell size shown. It is not a regulatory flood study, not a catastrophe model with an event catalogue, and not an ' +
      'insurance valuation. Treat every figure as an order of magnitude with the stated range.',
  },
  {
    title: 'Hazard at each building',
    text:
      'For every footprint the solver’s per-cell accumulators are sampled over the cells it covers: maximum depth, ' +
      'maximum speed, maximum depth × speed, first arrival and time under water — the worst cell, since water on ' +
      'one side of a building is in its ground floor. Cells that were already wet when the scenario started (rivers, ' +
      `lakes) are left out. A building is "reached" at ${REACHED_DEPTH} m. By default the terrain is bare earth: water flows through ` +
      'buildings in the model, so depths are street depths at the footprint and speeds are open-ground speeds where real ' +
      'flow would go around the walls. With "Buildings block flow" on (Advanced) the water goes round them instead, and ' +
      'each building is read in the open cells against its walls, counting only the water above its own lowest ground. ' +
      'A building wet along one edge only (a riverside wall, a footprint a levee cuts ' +
      'through) is flagged "edge only" with the share of its footprint that was reached.',
  },
  {
    title: 'Damage',
    text:
      'Depth–damage curves from the JRC global database (Huizinga et al. 2017), by continent and by residential / ' +
      'commercial / industrial class, applied storey by storey: each storey is damaged by the water above its own floor, ' +
      'so a tower with a metre of water loses its lobby, not half its value. Storeys come from the roof height (the ' +
      'same metres-per-storey the 3D buildings use); a height marked "estimated" makes the storey count a guess too. ' +
      `Nothing is booked below ${DAMAGE_MIN_DEPTH} m above the floor: the North-American curves start at 20 % at 0 m ` +
      '(they inherit the HAZUS first-floor datum), which would charge a house a fifth of its value for a film of water. ' +
      `"Damaged" means the ground storey lost at least ${pct(DAMAGED_MIN_FRACTION)} — a reporting line, not physics.`,
  },
  {
    title: 'Fast water',
    text:
      'Clausen & Clark (1990), as widely cited: with speed ≥ 2 m/s, depth × speed ≥ 3 m²/s is partial ' +
      'structural damage (damage at least 50 %) and ≥ 7 m²/s is collapse (total loss). Timber, mud and informal ' +
      'buildings use half the thresholds; a debris-laden flow (a glacial-lake outburst) multiplies depth × speed by 1.5 ' +
      'and calls 3 m²/s collapse for anything but reinforced concrete — a labelled heuristic. Two more heuristics make ' +
      'the rule robust to one noisy cell of a bare-earth grid: it reads the 90th percentile of the per-cell maxima over ' +
      'the footprint, not the worst cell, and collapse is a ramp, not a step — the damage goes from the depth curve to ' +
      'total loss across 5–9 m²/s (the cited 7 m²/s at its centre, where a building counts as destroyed). Without ' +
      'recorded speeds nothing is called collapsed.',
  },
  {
    title: 'Value',
    text:
      'Replacement value = footprint area × storeys × a unit cost per m² for the occupancy and country ' +
      `(United States: homes ${usd(UNIT_COST_USD_M2.US.residential)}, retail ${usd(UNIT_COST_USD_M2.US.retail)}, offices ` +
      `${usd(UNIT_COST_USD_M2.US.office)}, industrial ${usd(UNIT_COST_USD_M2.US.industrial)}; Nepal ` +
      `${usd(UNIT_COST_USD_M2.NP.residential)}–${usd(UNIT_COST_USD_M2.NP.hospital)}; 2026 USD). These are derived screening ` +
      'defaults — JRC 2017 construction costs escalated and checked against 2025 market ranges — not quotes. ' +
      `Contents are ${CONTENT_FACTOR_RES}× (homes), ${CONTENT_FACTOR_COM}× (commercial) and ${CONTENT_FACTOR_IND}× ` +
      `(industrial) the structure, as in JRC. ${pct(UNDAMAGEABLE_SHARE_MASONRY)} of a masonry or concrete structure ` +
      '(foundations, frame) is treated as undamageable. Occupancy comes from the OpenStreetMap building tag; untagged ' +
      'footprints are classed by size. A portfolio row’s own replacement value always wins.',
  },
  {
    title: 'Uncertainty',
    text:
      'The range shown is the damage curve ±1 standard deviation applied to every wet storey. JRC publishes these ' +
      'spreads; the Asian and North-American residential ones are used, and elsewhere a placeholder of ' +
      `${DEFAULT_CURVE_SIGMA} (same order as those). It does not include the uncertainty in value (JRC gives a 90 % ` +
      'interval of about −30 % to +50 % on its maximum-damage values), in the terrain, in the forcing, or the ' +
      'missing storm drains and culverts — the real uncertainty is wider than the band.',
  },
  {
    title: 'Downtime and access',
    text:
      'Downtime is a transparent heuristic in the spirit of Hazus (whose restoration tables were not available): clean-up ' +
      'days by depth (7 / 21 / 45 / 90) plus damage × rebuild days for the occupancy, or the days until the access ' +
      `road reopens if longer. A building's access road is the nearest road within ${ACCESS_SNAP_M} m; it counts as cut ` +
      'when it reached 0.3 m (the evacuation router’s impassable depth), with bridges over standing water excluded. ' +
      'Business interruption in dollars needs a daily revenue and margin, so it is only computed for portfolio assets.',
  },
  {
    title: 'Mitigation and BCR',
    text:
      'Before/after compares two runs of the same scenario: set a baseline without the wall, build it, replay, recompute. ' +
      'Avoided loss is the difference; buildings that get wetter with the wall (water pushed elsewhere) are counted, not ' +
      'netted away silently. The benefit–cost ratio needs how often an event like this happens: with a return period ' +
      `T, avoided loss / T is booked every year for ${USEFUL_LIFE_WALL_YEARS} years at ${pct(DISCOUNT_RATE_FEMA)} (FEMA BCA ` +
      `default since June 2025) and ${pct(DISCOUNT_RATE_LOW)}, and nothing in other events — a single-event first ` +
      'look. A FEMA-grade BCA integrates several return periods (expected annual loss). Wall cost per metre grows with ' +
      'height^1.3 from planning-level unit costs, shown with a ±50 % band.',
  },
  {
    title: 'Your sites and portfolio file',
    text:
      'A CSV you load is read and matched in this browser tab; nothing is uploaded or stored, and it is gone when you ' +
      `reload. An asset inside a footprint takes that building; otherwise the nearest footprint within ${MATCH_RADIUS_M} m; ` +
      'otherwise it is assessed at its own grid cell. A WKT polygon is used as given. People at risk are not estimated: ' +
      'there is no population data behind this panel.',
  },
];

export interface Citation {
  text: string;
  url?: string;
}

export const CITATIONS: readonly Citation[] = [
  {
    text: 'Huizinga, J., de Moel, H. & Szewczyk, W. (2017). Global flood depth-damage functions: Methodology and the database with guidelines. JRC Technical Report EUR 28552 EN, doi:10.2760/16510.',
    url: 'https://publications.jrc.ec.europa.eu/repository/handle/JRC105688',
  },
  {
    text: 'Australian Institute for Disaster Resilience (2017). Guideline 7-3: Flood Hazard (H1–H6), after Smith, Davey & Cox (2014).',
    url: 'https://egusphere.copernicus.org/preprints/2026/egusphere-2026-4699/egusphere-2026-4699-supplement.pdf',
  },
  {
    text: 'DEFRA / Environment Agency (2006). Flood Risks to People, Phase 2 (FD2321/TR2): HR = d(v + 0.5) + DF.',
    url: 'https://help.floodmodeller.com/docs/hazard-mapping',
  },
  {
    text: 'Clausen, L. & Clark, P. B. (1990), dam-break damage criteria by depth × velocity, as cited in RESCDAM and TU Delft summaries (the primary paper was not consulted).',
    url: 'https://repository.tudelft.nl/file/File_2fae8e61-de65-4d41-9166-da81ae93504f',
  },
  {
    text: 'FEMA Benefit-Cost Analysis: 7 % discount rate restored 2025-06-04 (OMB Circular A-94, 1992).',
    url: 'https://www.floods.org/?p=306755',
  },
  {
    text: 'City of Fargo (2017). Flood protection planning costs, $2,600–5,000 per linear foot of floodwall.',
    url: 'https://download.fargond.gov/0/1_3_17_cc_presentation.pdf',
  },
  {
    text: 'Embankment costs in Nepal (NPR 15,000/m earthen; 30,000–35,000/m gabion-faced). Dialogue Earth, 2018.',
    url: 'https://dialogue.earth/en/2018/08/16/embankments-enter-nepal/',
  },
  {
    text: 'Bates, P. D., Horritt, M. S. & Fewtrell, T. J. (2010), J. Hydrology; de Almeida, G., Bates, P. D., Freer, J. & Souvignet, M. (2012), Water Resources Research (the flood solver).',
  },
];
