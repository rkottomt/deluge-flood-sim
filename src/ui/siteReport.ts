/**
 * Site check: the words and tables shared by the panel card and the printed "Site assessment" report, the
 * loss-exceedance mini chart, and the report itself.
 *
 * Same rules as impactReport.ts: everything is built with h() / createElementNS and text nodes, so a site name typed
 * by the user (or read from a ?sites= link) can never become markup; printing and the .html download reuse
 * printReport / reportHtmlDocument from there.
 */
import {
  AIDR_DESCRIPTIONS,
  DAMAGE_MIN_DEPTH,
  DISCOUNT_RATE_FEMA,
  DISCOUNT_RATE_LOW,
  LADDER_SOURCES,
  OCCUPANCY_PROFILES,
  REACHED_DEPTH,
  defaultFirstFloorHeight,
  designEventText,
  depthAboveFloor,
  egressClause,
  exceedanceCurve,
  fmtMinutes,
  formatReturnPeriod,
  RAIN_LADDER_CAVEATS,
  fmtMin,
  type EgressTiming,
  type FfeRecommendation,
  type SiteMitigation,
  type SiteRun,
  type SiteSpec,
  type SweepSummary,
} from '../loss';
import { ROAD_FLOODED_DEPTH as ROAD_FLOODED_DEPTH_M } from '../routing/constants';
import { h } from './dom';
import { fmtNum, formatClock, formatMoney } from './format';
import { CITATIONS } from './impactMethods';
import { climateCompareBlock, type ClimateComparison } from './siteClimate';
import { SURGE_LADDER_CAVEATS, SURGE_SOURCE_KEY } from '../surge/stations';

const FT = 0.3048;
const num = (v: number, d = 0) => (Number.isFinite(v) ? fmtNum(v, d) : '—');
const pct = (v: number) => (Number.isFinite(v) ? `${fmtNum(v * 100, 0)} %` : '—');
const mft = (m: number, d = 2) => (Number.isFinite(m) ? `${fmtNum(m, d)} m (${fmtNum(m / FT, 1)} ft)` : '—');
const ratio = (v: number) => (Number.isFinite(v) ? fmtNum(v, v < 10 ? 1 : 0) : '—');

export function kvList(rows: Array<[string, string]>, cls = 'dl-rep-kv'): HTMLElement {
  return h('dl', { class: cls }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

export function simpleTable(head: string[], rows: Array<Array<string | number>>, cls = 'dl-rep-table'): HTMLTableElement {
  return h(
    'table',
    { class: cls },
    h('thead', null, h('tr', null, ...head.map((c) => h('th', null, c)))),
    h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c) => h('td', null, String(c)))))),
  );
}

/** What the planned building is, as label/value pairs (the inputs, with where each default came from). */
export function siteSpecRows(spec: SiteSpec, run: SiteRun | null, money: (v: number) => string): Array<[string, string]> {
  const g = run?.geometry;
  const rows: Array<[string, string]> = [
    ['Location', `${spec.lat.toFixed(5)}, ${spec.lon.toFixed(5)}${spec.ring ? ` · outline of ${spec.ring.length / 2} corners` : ' · pin'}`],
    ['Planned use', `${OCCUPANCY_PROFILES[spec.occupancy].label}, ${spec.floors} floor${spec.floors === 1 ? '' : 's'}`],
  ];
  if (g) {
    rows.push(['Building footprint', `${num(g.footprintM2)} m² (${g.footprintSource === 'given' ? 'given' : g.footprintSource === 'outline' ? 'the outline, built out' : 'typical for the use — a guess'})`]);
  }
  const r = run?.result;
  rows.push([
    'Replacement value',
    r ? `${money(r.valueStructure)} structure + ${money(r.valueContents)} contents (${r.valueSource === 'given' ? 'structure given' : r.valueSource === 'unit-cost' ? 'estimated: floor area × unit cost' : 'unknown — no cost table here'})` : spec.value != null ? money(spec.value) : 'estimated when assessed',
  ]);
  const ffh = spec.firstFloorHeight ?? defaultFirstFloorHeight(spec.occupancy);
  rows.push(['First floor above grade', `${mft(ffh)}${spec.firstFloorHeight == null ? ' (default: slab on grade)' : ''}`]);
  rows.push(['Critical equipment above grade', spec.criticalElev == null ? 'not given' : mft(spec.criticalElev)]);
  if (run && Number.isFinite(run.grade)) rows.push(['Lowest ground on the site', `${num(run.grade, 2)} m above datum (bare-earth DEM)`]);
  return rows;
}

/** One flood at the site, as label/value pairs. */
export function siteRunRows(run: SiteRun, money: (v: number) => string, alertTime: number): Array<[string, string]> {
  const r = run.result;
  if (!r) return [['Result', 'Outside this map — nothing assessed.']];
  const rows: Array<[string, string]> = [];
  if (!r.reached) {
    rows.push(['Water at the site', r.depth > 0.01 ? `${num(r.depth, 2)} m at most — below the ${REACHED_DEPTH} m that counts as reaching it` : 'dry']);
  } else {
    rows.push(['Max depth at grade', `${mft(r.depth)} (lowest point of the site)`]);
    const above = depthAboveFloor(run);
    rows.push(['…above the planned floor', above >= DAMAGE_MIN_DEPTH ? mft(above) : `none — water stays ${mft(-above)} below it`]);
    rows.push(['Water surface', Number.isFinite(run.wse) ? `${num(run.wse, 2)} m above datum` : '—']);
    rows.push(['Max speed', Number.isFinite(r.speed) ? `${num(r.speed, 1)} m/s` : 'not recorded (depth-only fallback)']);
    rows.push(['Hazard class (AIDR)', `H${r.aidr} — ${AIDR_DESCRIPTIONS[r.aidr]}`]);
    rows.push(['Water arrives', `${formatClock(r.firstWet)}${alertTime > 0 ? ` (${r.leadTime >= 0 ? `${fmtMinutes(r.leadTime)} after` : `${fmtMinutes(-r.leadTime)} BEFORE`} the warning)` : ' after the scenario starts'}`]);
    rows.push(['Under water for', `${fmtMinutes(r.wetSeconds)} of the ${fmtMinutes(run.simTime)} run (a lower bound if the run stopped first)`]);
    rows.push(['Damage', `${pct(r.damage)} of the building · ${money(r.loss)} (±1σ ${money(r.lossLo)} – ${money(r.lossHi)})`]);
    if (r.criticalWet !== null) rows.push(['Critical equipment', r.criticalWet ? 'under water' : 'stays dry']);
    if (r.state === 'partial' || r.state === 'collapse' || r.collapseShare > 0) {
      const what = r.state === 'collapse' ? 'collapse criterion met' : r.state === 'partial' ? 'partial structural damage criterion met' : 'approaching the collapse criterion';
      rows.push(['Fast water', `${what} — depth × speed ${num(r.structuralDV, 1)} m²/s over the footprint (90th percentile; 7 m²/s collapses), ${pct(r.collapseShare)} of the way to total loss`]);
    }
  }
  rows.push(['Egress to a shelter', capital(egressClause(run))]);
  if (r.accessKnown) rows.push(['Nearest road', `${r.accessRoad || 'unnamed'}: ${r.accessCut ? `impassable (≥ ${ROAD_FLOODED_DEPTH_M} m) from about ${formatClock(r.accessCutAt)}` : 'stays passable'}`]);
  return rows;
}

const capital = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The sweep as table rows. */
export function sweepRows(sum: SweepSummary, money: (v: number) => string): Array<Array<string>> {
  return sum.rows.map((row) => {
    const r = row.run.result;
    const e = row.run.egress;
    const above = depthAboveFloor(row.run);
    return [
      row.level.label + (Number.isFinite(row.level.ft) ? ` · ${fmtNum(row.level.ft, 1)} ft` : row.level.rainMmH != null && Number.isFinite(row.level.rainMmH) ? ` · ${fmtNum(row.level.rainMmH, 0)} mm/h` : ''),
      row.level.returnPeriod ? `${formatReturnPeriod(row.level.returnPeriod)} yr${row.level.rpFrom === 'user' ? ' (your input)' : ''}` : '—',
      r?.reached ? num(r.depth, 2) : 'dry',
      Number.isFinite(above) && above >= DAMAGE_MIN_DEPTH ? num(above, 2) : '—',
      r?.reached && r.firstWet > 0 ? formatClock(r.firstWet) : '—',
      !e || !e.known ? 'n/a' : !e.openAtStart ? 'no route' : e.openAtPeak ? 'open' : `cut ${formatClock(e.lastRouteClosesAt)}`,
      r ? money(r.loss) : '—',
    ];
  });
}

export const SWEEP_HEAD = ['Level', 'Return period', 'Depth m', 'Above floor m', 'Water arrives', 'Route out', 'Loss'];

const SVG = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  if (text !== undefined) el.textContent = text;
  return el;
}

/**
 * Loss-exceedance mini chart: loss against return period (log axis), one series, one point per level that has a
 * return period. Each point carries a <title> tooltip; the table above it is the accessible view of the same data.
 */
export function exceedanceChart(sum: SweepSummary, money: (v: number) => string, opts: { width?: number; height?: number } = {}): SVGSVGElement | null {
  const pts = exceedanceCurve(sum.points);
  if (!pts.length) return null;
  const W = opts.width ?? 300;
  const H = opts.height ?? 150;
  const L = 52;
  const R = 10;
  const T = 12;
  const B = 28;
  const Ts = pts.map((p) => p.T);
  const lo = Math.log10(Math.max(1, Math.min(...Ts) / 1.5));
  const hi = Math.log10(Math.max(...Ts) * 1.5);
  const maxLoss = Math.max(1, ...pts.map((p) => p.loss)) * 1.1;
  const x = (T: number) => L + ((Math.log10(T) - lo) / (hi - lo || 1)) * (W - L - R);
  const y = (v: number) => T + (1 - v / maxLoss) * (H - T - B);
  const root = svg('svg', { class: 'dl-site-chart', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img' });
  root.append(svg('title', {}, `Loss against return period: ${pts.map((p) => `${fmtNum(p.T)} yr ${money(p.loss)}`).join(', ')}`));
  // Recessive axes: baseline + two horizontal guides.
  for (const f of [0, 0.5, 1]) {
    const v = maxLoss * f;
    root.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: f === 0 ? 'dl-chart-base' : 'dl-chart-grid' }));
    root.append(svg('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end', class: 'dl-chart-tick' }, f === 0 ? '0' : money(v)));
  }
  for (const T0 of [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000]) {
    if (Math.log10(T0) < lo || Math.log10(T0) > hi) continue;
    root.append(svg('text', { x: x(T0), y: H - B + 14, 'text-anchor': 'middle', class: 'dl-chart-tick' }, String(T0)));
  }
  root.append(svg('text', { x: (L + W - R) / 2, y: H - 3, 'text-anchor': 'middle', class: 'dl-chart-axis' }, 'Return period, years (log)'));
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.T).toFixed(1)} ${y(p.loss).toFixed(1)}`).join(' ');
  if (pts.length > 1) root.append(svg('path', { d, class: 'dl-chart-line' }));
  for (const p of pts) {
    const g = svg('g', { class: 'dl-chart-pt' });
    g.append(svg('title', {}, `${fmtNum(p.T)}-yr (${fmtNum(p.p * 100, p.p < 0.01 ? 1 : 0)} % a year): ${money(p.loss)}`));
    g.append(svg('circle', { cx: x(p.T), cy: y(p.loss), r: 9, class: 'dl-chart-hit' }));
    g.append(svg('circle', { cx: x(p.T), cy: y(p.loss), r: 4, class: 'dl-chart-dot' }));
    root.append(g);
  }
  return root;
}

export function ffeRows(rec: FfeRecommendation): Array<[string, string]> {
  return [
    ['Design event', designEventText(rec)],
    ['Design water surface at the site', Number.isFinite(rec.designWse) ? `${num(rec.designWse, 2)} m above datum` : 'does not reach the site'],
    ['Freeboard', `${mft(rec.freeboardM)} — ${rec.freeboardBasis}`],
    ['Indicative finished floor', Number.isFinite(rec.designWse) ? `${num(rec.ffe, 2)} m above datum = ${mft(rec.ffeAboveGrade)} above the lowest grade` : `no requirement from this model; planned ${mft(rec.plannedFloorM)}`],
    ['Against the plan', rec.raiseBy > 0.01 ? `${mft(rec.raiseBy)} higher than planned` : 'the planned floor already clears it'],
  ];
}

export function mitigationTableRows(opts: readonly SiteMitigation[], money: (v: number) => string): string[][] {
  return opts.map((o) => [
    o.label + (o.applicable ? '' : ' (not applicable)'),
    `${o.assumption} Useful life ${o.usefulLifeYears} yr.`,
    o.cost ? `${money(o.cost.mid)} (${money(o.cost.low)} – ${money(o.cost.high)})` : 'not costed',
    Number.isFinite(o.deltaEal) ? `${money(o.deltaEal)}/yr` : '—',
    o.bcr7 ? `${ratio(o.bcr7.mid)} (${ratio(o.bcr7.low)} – ${ratio(o.bcr7.high)})` : Number.isFinite(o.breakEvenCapex7) ? `pays if ≤ ${money(o.breakEvenCapex7)}` : '—',
    o.bcr3 ? ratio(o.bcr3.mid) : '—',
  ]);
}

export const MITIGATION_HEAD = ['Option', 'Assumes', 'Planning cost', 'Avoided EAL', 'BCR 7 %', 'BCR 3.1 %'];

/** Methods and limitations specific to Site check, for the panel's details and the report's appendix. */
export const SITE_METHOD_NOTES: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: 'The site',
    text:
      'A pin is assessed at its own grid cell; an outline at every cell inside it, worst cell first (as for footprints). The planned building is NOT ' +
      'matched to whatever stands there today. Value: the planned value if given, else floor area (footprint × floors) × the unit cost for the use. ' +
      'A pin without a footprint uses a typical footprint for the use — a guess, labelled as one. First-floor height defaults to 0.3 m (1 ft, slab on grade).',
  },
  {
    title: 'Egress',
    text:
      'The evacuation router (the same one as the Evacuate tool) plans a drive from the site to every shelter on the map over a flood rebuilt from the ' +
      'run’s accumulators: a cell carries its peak depth from the moment water first reached it (15 cm). Roads close at ' +
      `${ROAD_FLOODED_DEPTH_M} m; bridges over water present at the start stay open. The moment the last route closes is found by bisection over the ` +
      'arrival times, so it is exact for that rebuilt flood and an EARLY estimate for the real one (a road is closed as soon as water arrives on a stretch ' +
      'that later got deep). Whether the site is still cut off at the end of the run comes from the depth on screen at the end. A car must leave by the ' +
      'latest safe departure: each shelter’s closure (its last road cut, or the shelter itself under 0.3 m) minus the drive there. Who has left by then ' +
      'and how long the queue at the exit takes: see “Leaving by road”.',
  },
  {
    title: 'The sweep',
    text:
      'Each level resets the water, sets the river stage (or scales the scenario’s rain and inflows, or — on the NOAA Atlas 14 rain ladder — rains the level’s 1-hour intensity uniformly for one hour, then stops) and runs the solver for the chosen simulated ' +
      'duration with the walls on the map, as fast as the GPU allows. The river rises to each stage at the app’s limited rate (about 3 m per simulated ' +
      'minute), so a short run under-fills a high stage. Return periods come from the ladder’s sources where one is published, and otherwise from you.',
  },
  {
    title: 'Expected annual loss and BCR',
    text:
      'EAL by the trapezoid rule over annual exceedance probability (1/T), reported without and with the tail term (the rarest level’s loss times its ' +
      `probability) — Deluge runs events, it does not know how often they happen. BCR = PV(avoided EAL) / cost at ${Math.round(DISCOUNT_RATE_FEMA * 1000) / 10} % (FEMA BCA default) ` +
      `and ${Math.round(DISCOUNT_RATE_LOW * 1000) / 10} %, over each option’s FEMA standard useful life (BCA Reference Guide 2009, App. D: walls and levees 50 years, raising a home 30, raising another building or dry floodproofing it 25), on the mid of the EAL range. Only walls and levees have unit costs here; for the other ` +
      'options the most they could cost and still break even is shown instead.',
  },
  {
    title: 'Finished-floor elevation',
    text:
      'Design water surface at the site (the 1 % level when it was run, else the level you choose) plus freeboard by ASCE 24-14 Flood Design Class: ' +
      '+1 ft for most buildings and schools, +2 ft (or the 500-yr elevation) for hospitals and other Class 4 facilities. The NFIP minimum ' +
      '(44 CFR 60.3(c)) is the base flood level with no freeboard. ASCE 24-24 moves to return-period elevations (500-yr for most buildings); it is ' +
      'proposed for the 2027 IBC. Use the effective FIRM / BFE and your jurisdiction’s code — this model is not a FIRM.',
  },
];

export const SITE_LIMITATIONS: readonly string[] = [
  'Bare-earth terrain at the grid cell size unless the Advanced land-surface layers are on: by default no buildings, storm drains, basements or flood walls not drawn on the map, and water flows through buildings.',
  'A river stage is held at the domain edges and raised at a limited rate; real crests last hours to days, so wet durations here are lower bounds.',
  'Pittsburgh and Nashville are regulated rivers: historic crests before the flood-control reservoirs (1936 at Pittsburgh) would crest lower today.',
  'Return periods are inputs. Where none is published here, the EAL rests on yours; with one or two points it is a rough bracket, not a figure.',
  'Road egress uses road centrelines and the shelters on the map, and closures for flooding only (no debris on bridges, no police closures). Departures follow a published average curve and the cars queue at one bottleneck with assumed lane counts; other evacuating traffic is not counted, so the clearance time is a lower bound. Evacuation on foot walks the same road centrelines (no footways in the data) and ignores crowding on the street.',
  'Infrastructure dependencies are approximate: the nearest substation stands in for the real feeder, and a facility OpenStreetMap does not map is missing.',
  'Damage curves (JRC 2017) and unit costs are screening values with a ±1σ band that understates the real uncertainty.',
  'Indicative only — not engineering advice, not a flood determination, not an appraisal.',
];

export const SITE_CITATIONS: ReadonlyArray<{ text: string; url: string }> = [
  { text: 'FEMA, Highlights of ASCE 24-14 Flood Resistant Design and Construction (Table 2-1: lowest floor by Flood Design Class).', url: 'https://www.fema.gov/sites/default/files/2020-07/asce24-14_highlights_jan2015.pdf' },
  { text: '44 CFR 60.3(c)(2)–(3): NFIP lowest-floor and floodproofing minimums.', url: 'https://www.law.cornell.edu/cfr/text/44/60.3' },
  { text: 'FEMA NFIP Technical Bulletin 3 (2021), dry floodproofing: not for residential buildings in Zone A; not recommended beyond 3 ft depth or 5 ft/s; rating credit at BFE + 1 ft.', url: 'https://www.fema.gov/sites/default/files/documents/fema_technical-bulletin-3_1-2021.pdf' },
  { text: 'FEMA glossary, Freeboard: "communities are encouraged to adopt at least a one-foot freeboard".', url: 'https://www.fema.gov/about/glossary/freeboard' },
  { text: 'NIBS, Natural Hazard Mitigation Saves (2019): riverine flooding, building 5 ft above the BFE ≈ 5:1 benefit–cost.', url: 'https://www.nibs.org/mitigationsaves' },
  { text: 'Structure Magazine (May 2025), Major revisions to ASCE 24 (ASCE 24-24: 500/750/1,000-yr design elevations by class; submitted for the 2027 IBC).', url: 'https://www.structuremag.org/article/major-revisions-to-asce-24-a-standard-for-flood-resistant-design-and-construction/' },
  { text: 'FEMA press release, 25 Mar 2025: the Federal Flood Risk Management Standard rescinded (EO 14148); 44 CFR Part 9 remains.', url: 'https://www.fema.gov/press-release/20250325/fema-eases-floodplain-requirements-federally-funded-projects-reducing-burden' },
];

// ─── The report ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SiteReportSite {
  spec: SiteSpec;
  current: SiteRun | null;
  sweep: SweepSummary | null;
  rec: FfeRecommendation | null;
  options: SiteMitigation[];
  verdict: string[];
  /** Today vs a future climate (siteClimate.ts), when that comparison was run. */
  climate?: ClimateComparison | null;
  /** Extra sections after "The flood on screen" (evacuation on foot, infrastructure dependencies — evacPeople.ts). */
  extra?: HTMLElement[];
  /** Leaving by road for one run of this site (evacPeople.ts timing): the egress timeline's share-out and clearance columns. */
  timing?: (run: SiteRun) => EgressTiming | null;
}

/** Egress timeline columns from the departure curve and the queue: share out before the window ends, clearance vs window. */
export function timingCells(t: EgressTiming | null | undefined): [string, string] {
  if (!t || !t.known) return ['—', '—'];
  const share = t.windowS === Infinity ? 'route stays open' : t.windowS <= 0 ? '0 % (closes before the alert)' : `${Math.round(t.shareOut * 100)} %`;
  const win = t.windowS === Infinity ? 'open' : fmtMin(Math.max(0, t.windowS));
  return [share, `${fmtMin(t.clearanceS)} vs ${win}`];
}

export interface SiteReportInput {
  generatedAt: Date;
  attribution: string;
  terrainName: string;
  regionName: string;
  currency: string;
  alertTime: number;
  current: { simTime: number; source: 'gpu' | 'snapshots' } | null;
  sweep: { durationS: number; source: 'gpu' | 'snapshots'; ladder: 'stage' | 'scale' | 'rain'; gaugeLabel: string; sourceKeys: string[]; levels: number; cancelled: boolean } | null;
  sites: SiteReportSite[];
  /** Extra method notes for the appendix. */
  methods?: ReadonlyArray<{ title: string; text: string }>;
}

export function buildSiteReport(i: SiteReportInput): HTMLElement {
  const money = (v: number) => formatMoney(v, i.currency);
  const sections: HTMLElement[] = [];
  sections.push(
    h('header', { class: 'dl-rep-head' },
      h('div', { class: 'dl-rep-kicker' }, 'Deluge — site assessment (flood screening)'),
      h('h1', null, `${i.sites.length === 1 ? i.sites[0].spec.name || 'Site' : `${i.sites.length} candidate sites`} — ${i.terrainName}`),
      h('p', { class: 'dl-rep-meta' }, `Generated ${i.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${i.regionName} costs, 2026 USD`),
      h('p', { class: 'dl-rep-warn' },
        'Indicative screening for due diligence — not engineering advice, not a flood determination, not a FIRM. Every figure rests on a bare-earth ' +
          'simulation and on the stated assumptions; check the effective FIRM / BFE, a survey and local code before any decision.'),
    ),
  );
  const runRows: Array<[string, string]> = [];
  if (i.current) runRows.push(['This run', `${formatClock(i.current.simTime)} simulated · ${i.current.source === 'gpu' ? 'solver accumulators (depth, speed, arrival)' : 'depth snapshots only — no speeds'}`]);
  if (i.sweep) {
    runRows.push(['Sweep', `${i.sweep.levels} level${i.sweep.levels === 1 ? '' : 's'}, ${fmtMinutes(i.sweep.durationS)} simulated each, ${i.sweep.ladder === 'stage' ? i.sweep.gaugeLabel : i.sweep.ladder === 'rain' ? 'NOAA Atlas 14 1-hour rain at the map centre, rain only' : 'scenario forcing × multiplier'}${i.sweep.cancelled ? ' — CANCELLED before the end; levels not run are missing' : ''}`]);
    if (i.sweep.ladder === 'rain') RAIN_LADDER_CAVEATS.forEach((c, k) => runRows.push([k === 0 ? 'Rain ladder caveats' : '', c]));
    if (i.sweep.ladder === 'stage' && i.sweep.sourceKeys.includes(SURGE_SOURCE_KEY)) SURGE_LADDER_CAVEATS.forEach((c, k) => runRows.push([k === 0 ? 'Surge ladder caveats' : '', c]));
    runRows.push(['Sweep hazard data', i.sweep.source === 'gpu' ? 'solver accumulators' : 'depth snapshots after each minute of simulation (arrival times to the minute; no speeds)']);
  }
  if (runRows.length) sections.push(h('section', null, h('h2', null, 'Runs'), kvList(runRows)));

  for (const s of i.sites) {
    const parts: Array<HTMLElement | null> = [h('h2', null, s.spec.name || s.spec.id)];
    if (s.verdict.length) parts.push(h('div', { class: 'dl-rep-verdict' }, h('h3', null, 'Verdict'), h('ul', null, ...s.verdict.map((v) => h('li', null, v)))));
    parts.push(h('h3', null, 'Summary'), kvList(siteSpecRows(s.spec, s.current ?? s.sweep?.rows[0]?.run ?? null, money)));
    if (s.current) parts.push(h('h3', null, 'The flood on screen'), kvList(siteRunRows(s.current, money, i.alertTime)));
    if (s.extra?.length) parts.push(...s.extra);
    if (s.sweep && s.sweep.rows.length) {
      parts.push(h('h3', null, 'Sweep'), simpleTable(SWEEP_HEAD, sweepRows(s.sweep, money), 'dl-rep-table dl-rep-wide'));
      const chart = exceedanceChart(s.sweep, money, { width: 420, height: 170 });
      parts.push(h('h3', null, 'Expected annual loss'));
      parts.push(
        h('p', null, s.sweep.eal ? `${money(s.sweep.eal.low)} – ${money(s.sweep.eal.high)} a year (without / with the tail), from ${s.sweep.points.length} level${s.sweep.points.length === 1 ? '' : 's'} with a return period${s.sweep.userReturnPeriods ? ' — some entered by the user' : ''}.` : 'Not computed: no level run has a return period.'),
      );
      if (chart) parts.push(h('figure', { class: 'dl-rep-figure' }, chart, h('figcaption', null, 'Loss at the site against return period (log scale). One point per level with a return period.')));
      if (s.climate) parts.push(h('h3', null, `Future climate — today vs ${s.climate.label}`), climateCompareBlock(s.climate, money, 'dl-rep-climate'));
      parts.push(
        h('h3', null, 'Egress timeline'),
        simpleTable(
          ['Level', 'Route before the flood', 'Last route closes', 'Water reaches the site', 'End of run', ...(s.timing ? ['Occupants out before it closes', 'Clearance vs window'] : [])],
          s.sweep.rows.map((row) => {
            const e = row.run.egress;
            const r = row.run.result;
            return [
              row.level.label,
              !e || !e.known ? (e?.note || 'not assessed') : e.openAtStart ? 'open' : 'none',
              e?.known && e.openAtStart ? (e.openAtPeak ? `stays open (to ${e.peakShelter || 'a shelter'})` : formatClock(e.lastRouteClosesAt)) : '—',
              r?.reached ? formatClock(r.firstWet) : 'stays dry',
              e?.cutAtEnd == null ? '—' : e.cutAtEnd ? (e.cutOffAtLeastS >= 60 ? `still cut off (≥ ${fmtMinutes(e.cutOffAtLeastS)})` : 'still cut off') : 'a route is open again',
              ...(s.timing ? timingCells(s.timing(row.run)) : []),
            ];
          }),
          'dl-rep-table dl-rep-wide',
        ),
      );
    }
    if (s.rec) {
      parts.push(h('h3', null, 'Recommendations (indicative)'), kvList(ffeRows(s.rec)));
      if (!Number.isFinite(s.rec.designWse)) {
        parts.push(h('p', { class: 'dl-rep-note' }, 'The design event does not reach the site: this model asks for no higher floor and no protection for it. Rarer levels in the sweep may still flood it (see above).'));
      } else {
        if (s.options.length) parts.push(simpleTable(MITIGATION_HEAD, mitigationTableRows(s.options, money), 'dl-rep-table dl-rep-wide'));
        const cav = [...new Set(s.options.flatMap((o) => o.caveats))];
        if (cav.length) parts.push(h('ul', { class: 'dl-rep-note' }, ...cav.map((c) => h('li', null, c))));
      }
    }
    sections.push(h('section', { class: 'dl-rep-site' }, ...parts));
  }

  const ladderSources = i.sweep ? i.sweep.sourceKeys.map((k) => LADDER_SOURCES[k]).filter(Boolean) : [];
  sections.push(
    h('section', { class: 'dl-rep-appendix' },
      h('h2', null, 'Methods'),
      ...[...SITE_METHOD_NOTES, ...(i.methods ?? [])].map((n) => h('div', { class: 'dl-rep-method' }, h('h3', null, n.title), h('p', null, n.text))),
      h('h2', null, 'Limitations'),
      h('ul', null, ...SITE_LIMITATIONS.map((t) => h('li', null, t))),
      h('h2', null, 'Sources'),
      h('ol', { class: 'dl-rep-cites' },
        ...ladderSources.map((c) => h('li', null, c.text, h('span', { class: 'dl-rep-url' }, ` ${c.url}`))),
        ...SITE_CITATIONS.map((c) => h('li', null, c.text, h('span', { class: 'dl-rep-url' }, ` ${c.url}`))),
        ...CITATIONS.map((c) => h('li', null, c.text, c.url ? h('span', { class: 'dl-rep-url' }, ` ${c.url}`) : null)),
      ),
      i.attribution ? h('p', { class: 'dl-rep-note' }, `Map data: ${i.attribution}`) : null,
    ),
  );
  return h('article', { class: 'dl-print-report dl-site-report' }, ...sections);
}

/** Extra print/download styles for the site report (appended to REPORT_CSS). Constant. */
export const SITE_REPORT_CSS = `
.dl-rep-verdict{background:#f3f7fb;border-left:3px solid #2b6cb0;padding:6px 12px;margin:8px 0}
.dl-rep-verdict ul{margin:4px 0;padding-left:18px}.dl-rep-figure{margin:8px 0}.dl-rep-figure figcaption{font-size:11px;color:#555}
.dl-site-chart .dl-chart-line{fill:none;stroke:#2b6cb0;stroke-width:2}.dl-site-chart .dl-chart-dot{fill:#2b6cb0;stroke:#fff;stroke-width:2}
.dl-site-chart .dl-chart-hit{fill:transparent}.dl-site-chart .dl-chart-grid{stroke:#e3e3e3}.dl-site-chart .dl-chart-base{stroke:#999}
.dl-site-chart text{font-size:10px;fill:#555}.dl-rep-site{break-before:auto}
`;

/** The sweep in the panel's width: level, depth, route out, loss (the report has every column). */
export const SWEEP_HEAD_COMPACT = ['Level', 'Depth m', 'Route out', 'Loss'];
export function sweepRowsCompact(sum: SweepSummary, money: (v: number) => string): string[][] {
  return sweepRows(sum, money).map((r) => [r[0] + (r[1] !== '—' ? ` · ${r[1]}` : ''), r[2], r[5], r[6]]);
}
