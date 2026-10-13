/**
 * The printable impact report: one scenario's numbers, the before/after comparison when there is one, the asset
 * tables, and the assumptions, methods and citations behind them.
 *
 * Built with h() like the rest of the UI, so every value — including asset names from a user's CSV — is a text node.
 * Two ways out, neither involving a server or a new window (the desktop wrapper forbids windows):
 *  • print: the report is placed in the page, a print stylesheet (styles.css, `html.dl-printing`) hides everything
 *    else, and window.print() opens the browser's dialog (Save as PDF works there);
 *  • download: the same element serialised into a standalone .html file with its own constant stylesheet.
 */
import type { Analysis, BuildingImpact, PortfolioResult } from '../loss';
import { AIDR_DESCRIPTIONS, CONTINENT_LABELS, HR_DESCRIPTIONS, OCCUPANCY_PROFILES, type AidrClass, type HrClass } from '../loss';
import { h } from './dom';
import { fmtNum, formatClock, formatMoney, leadVsWarningText, warningIssuedText } from './format';
import type { BcrView, Comparison, RunSignature } from './impactCompare';
import { CITATIONS, METHOD_NOTES } from './impactMethods';

export interface ReportInput {
  generatedAt: Date;
  attribution: string;
  sig: RunSignature;
  /** 'gpu' = the solver's accumulators; 'snapshots' = the depth-only fallback. */
  source: 'gpu' | 'snapshots';
  /** Snapshot fallback: simulated time tracking began (0 = from reset). */
  trackingFrom: number;
  analysis: Analysis;
  debrisFlow: boolean;
  alertTime: number;
  comparison: Comparison | null;
  bcr: BcrView | null;
  mitigation: { label: string; lengthM: number; heightM: number; returnPeriod: number | null } | null;
  /** Chain presets: the Early warning section (warningReport.ts), placed before the appendix. */
  earlyWarning?: HTMLElement | null;
}

/** Rows in the report's building table. */
export const REPORT_TOP_N = 25;

const num = (v: number, d = 0) => (Number.isFinite(v) ? fmtNum(v, d) : '—');
const pct = (v: number) => (Number.isFinite(v) ? `${fmtNum(v * 100, 0)} %` : '—');
const ratio = (v: number) => (Number.isFinite(v) ? fmtNum(v, v < 10 ? 1 : 0) : '—');

function table(head: string[], rows: Array<Array<string | number>>, cls = ''): HTMLTableElement {
  return h(
    'table',
    { class: `dl-rep-table ${cls}` },
    h('thead', null, h('tr', null, ...head.map((c) => h('th', null, c)))),
    h('tbody', null, ...rows.map((r) => h('tr', null, ...r.map((c) => h('td', null, String(c)))))),
  );
}

function kv(rows: Array<[string, string]>): HTMLElement {
  return h('dl', { class: 'dl-rep-kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

export function buildingLabel(b: BuildingImpact): string {
  return b.name || `${OCCUPANCY_PROFILES[b.occ].label} #${b.k}`;
}

export function buildReport(i: ReportInput): HTMLElement {
  const a = i.analysis;
  const s = a.report?.summary ?? null;
  const cur = a.region.currency;
  const money = (v: number) => formatMoney(v, cur);
  const sections: HTMLElement[] = [];

  sections.push(
    h('header', { class: 'dl-rep-head' },
      h('div', { class: 'dl-rep-kicker' }, 'Deluge — flood impact screening for sites and assets'),
      h('h1', null, i.sig.terrainName || 'Scenario'),
      h('p', { class: 'dl-rep-meta' },
        `Simulated time ${formatClock(i.sig.simTime)} · generated ${i.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · ` +
          `${a.region.name} costs, JRC ${CONTINENT_LABELS[a.region.continent]} curves`),
      h('p', { class: 'dl-rep-warn' },
        'A screening estimate for one simulated scenario on bare-earth terrain — not a flood study, an insurance valuation or a catastrophe model. ' +
          'Ranges show only the damage-curve spread; the real uncertainty is wider. Methods and assumptions are in the appendix.'),
    ),
  );

  const scen: Array<[string, string]> = [
    ['Hazard data', i.source === 'gpu' ? 'Solver accumulators: max depth, speed, depth × speed, arrival, duration' : `Depth snapshots only (no speeds) from ${formatClock(i.trackingFrom)}`],
    ['River stage offset', `${num(i.sig.stageOffset, 2)} m`],
    ['Rain', `${num(i.sig.rainRate, 0)} mm/h`],
    ['Debris-laden flow rule', i.debrisFlow ? 'on (glacial-lake outburst heuristic)' : 'off'],
    ['Warning issued at', warningIssuedText(i.alertTime)],
  ];
  sections.push(h('section', null, h('h2', null, 'Scenario'), kv(scen)));

  if (s) {
    const rows: Array<[string, string]> = [
      ['Buildings assessed', num(s.assessed)],
      [`Reached by water (≥ 15 cm)`, num(s.reached)],
      ['Damaged (ground storey ≥ 20 %)', num(s.damaged)],
      ['Partial structural damage (fast water)', s.velocityKnown ? num(s.partial) : 'not assessed — no speeds'],
      ['Destroyed (collapse criterion)', s.velocityKnown ? num(s.destroyed) : 'not assessed — no speeds'],
      ['Estimated loss, structure + contents', `${money(s.loss)}  (±1σ curve range ${money(s.lossLo)} – ${money(s.lossHi)})`],
      ['  of which structure / contents', `${money(s.lossStructure)} / ${money(s.lossContents)}`],
      ['Replacement value of all assessed buildings', money(s.exposedValue)],
      ['Access road impassable at the peak', `${num(s.accessCut)} reached buildings`],
      [
        'Earliest arrival at a building',
        s.earliest ? `${formatClock(s.earliest.firstWet)} — ${leadVsWarningText(s.earliest.leadTime, i.alertTime)}` : '—',
      ],
      ['Storey counts from estimated heights', `${num(s.heightEstimated)} of the reached buildings`],
      ['Occupancy guessed from footprint size', `${num(s.occupancyGuessed)} of the reached buildings`],
    ];
    sections.push(h('section', null, h('h2', null, 'Buildings on the map'), kv(rows)));
    const aidrRows = ([1, 2, 3, 4, 5, 6] as AidrClass[]).map((c) => [`H${c}`, num(s.aidr[c]), AIDR_DESCRIPTIONS[c]]);
    const hrRows = (['low', 'moderate', 'significant', 'extreme'] as HrClass[]).map((c) => [c, num(s.hr[c]), HR_DESCRIPTIONS[c]]);
    sections.push(
      h('section', null,
        h('h2', null, 'Hazard classes of reached buildings'),
        s.velocityKnown ? null : h('p', { class: 'dl-rep-note' }, 'Speeds were not recorded: classes are on depth alone and can only understate the hazard.'),
        table(['AIDR', 'Buildings', 'Meaning'], aidrRows),
        table(['FD2321', 'Buildings', 'Meaning'], hrRows),
        h('p', { class: 'dl-rep-note' }, 'People at risk are not estimated: no population data is used.'),
      ),
    );
  }

  if (i.comparison && i.mitigation) {
    const c = i.comparison;
    const m = i.mitigation;
    const rows: Array<[string, string]> = [
      ['Baseline', `${c.baseline.terrainName} at ${formatClock(c.baseline.simTime)}`],
      ['Avoided loss in this event', `${money(c.avoided)}  (${money(c.avoidedLo)} – ${money(c.avoidedHi)})`],
      ['Buildings no longer reached', num(c.noLongerReached)],
      ['Buildings newly reached (water pushed elsewhere)', `${num(c.newlyReached)}, ${money(c.newlyReachedLoss)}`],
      ['Buildings with a larger loss than the baseline', `${num(c.worse)}, +${money(c.worseLoss)}`],
      ['Mitigation', `${m.label}, ${num(m.lengthM)} m long, ${num(m.heightM, 1)} m high`],
    ];
    if (i.bcr) {
      const b = i.bcr;
      rows.push(['Planning cost', `${money(b.cost.mid)}  (${money(b.cost.low)} – ${money(b.cost.high)}), ${money(b.cost.perMetre)}/m`]);
      rows.push(['Return period of this event (input)', m.returnPeriod ? `${num(m.returnPeriod)} years` : 'not given']);
      rows.push([`BCR at 7 %, ${b.years} yr`, `${ratio(b.bcr7)}  (${ratio(b.bcr7Range[0])} – ${ratio(b.bcr7Range[1])})`]);
      rows.push([`BCR at 3.1 %, ${b.years} yr`, `${ratio(b.bcr3)}  (${ratio(b.bcr3Range[0])} – ${ratio(b.bcr3Range[1])})`]);
      rows.push(['Break-even return period at 7 %', Number.isFinite(b.breakEvenT) ? `an event like this at least every ${num(b.breakEvenT)} years` : '—']);
    }
    sections.push(
      h('section', null,
        h('h2', null, 'Mitigation: before and after'),
        kv(rows),
        ...c.warnings.map((w) => h('p', { class: 'dl-rep-warn' }, w)),
        h('p', { class: 'dl-rep-note' },
          'Single-event approximation: avoided loss / return period is booked every year and nothing in other events. For a FEMA BCA, ' +
            'run several return periods with and without the mitigation and integrate the expected annual loss. BCA Toolkit inputs: ' +
            'project useful life, discount rate (7 %), damages before and after per return period, project cost.'),
      ),
    );
  }

  if (a.report && a.report.impacts.length) {
    const top = [...a.report.impacts].sort((x, y) => (Number.isFinite(y.loss) ? y.loss : -1) - (Number.isFinite(x.loss) ? x.loss : -1) || y.depth - x.depth).slice(0, REPORT_TOP_N);
    sections.push(
      h('section', null,
        h('h2', null, `Largest losses — ${top.length} buildings`),
        table(
          ['Building', 'Use', 'Storeys', 'Depth m', 'Speed m/s', 'AIDR', 'Water arrives', 'Road out', 'Damage', 'Loss', 'Downtime d*'],
          top.map((b) => [
            buildingLabel(b),
            OCCUPANCY_PROFILES[b.occ].label + (b.valueConfidence === 'heuristic' ? ' (guess)' : ''),
            `${b.floors}${b.heightEstimated ? '?' : ''}`,
            num(b.depth, 2),
            Number.isFinite(b.speed) ? num(b.speed, 1) : '—',
            `H${b.aidr}`,
            b.firstWet > 0 ? formatClock(b.firstWet) : '—',
            b.accessCut ? formatClock(b.accessCutAt) : b.accessKnown ? 'open' : '—',
            pct(b.damage),
            money(b.loss),
            num(b.downtimeDays),
          ]),
          'dl-rep-wide',
        ),
        h('p', { class: 'dl-rep-note' }, '* Downtime is a heuristic (clean-up by depth + damage × rebuild days, or road reopening). "?" = storeys from an estimated height.'),
      ),
    );
  }

  if (a.portfolio) {
    const p = a.portfolio;
    const ps = p.summary;
    sections.push(
      h('section', null,
        h('h2', null, `Sites and assets — ${ps.assets}`),
        kv([
          ['Outside the map', num(ps.outside)],
          ['Reached by water', num(ps.reached)],
          ['Loss (USD assets)', `${money(ps.loss)}  (${money(ps.lossLo)} – ${money(ps.lossHi)})`],
          ['Business interruption (where revenue given)', money(ps.bi)],
          ['Insured loss (where deductible / limit given)', money(ps.insured)],
          ['Assets without a value (loss unknown)', num(ps.unvalued)],
          ['Assets in another currency (not totalled)', num(ps.otherCurrency)],
        ]),
        table(
          ['Site / asset', 'Match', 'Depth m', 'AIDR', 'Water arrives', 'Access road out', 'Damage', 'Loss', 'BI', 'Critical kit wet'],
          [...p.results]
            .sort((x, y) => (Number.isFinite(y.loss) ? y.loss : -1) - (Number.isFinite(x.loss) ? x.loss : -1))
            .map((r: PortfolioResult) => [
              r.m.asset.name ? `${r.m.asset.id} — ${r.m.asset.name}` : r.m.asset.id,
              r.m.match + (r.m.match === 'nearest' ? ` (${num(r.m.distanceM)} m)` : ''),
              num(r.depth, 2),
              `H${r.aidr}`,
              r.firstWet > 0 ? formatClock(r.firstWet) : '—',
              !r.accessKnown ? 'no road within 120 m' : r.accessCut ? `from ${formatClock(r.accessCutAt)}${r.accessRoad ? ` (${r.accessRoad})` : ''}` : 'stays open',
              pct(r.damage),
              formatMoney(r.loss, r.currency),
              formatMoney(r.biLoss, r.currency),
              r.criticalWet === null ? '—' : r.criticalWet ? 'yes' : 'no',
            ]),
          'dl-rep-wide',
        ),
      ),
    );
  }

  if (i.earlyWarning) sections.push(i.earlyWarning);

  sections.push(
    h('section', { class: 'dl-rep-appendix' },
      h('h2', null, 'Appendix — methods and assumptions'),
      ...METHOD_NOTES.map((n) => h('div', { class: 'dl-rep-method' }, h('h3', null, n.title), h('p', null, n.text))),
      h('h2', null, 'Sources'),
      h('ol', { class: 'dl-rep-cites' }, ...CITATIONS.map((c) => h('li', null, c.text, c.url ? h('span', { class: 'dl-rep-url' }, ` ${c.url}`) : null))),
      i.attribution ? h('p', { class: 'dl-rep-note' }, `Map data: ${i.attribution}`) : null,
    ),
  );

  return h('article', { class: 'dl-print-report' }, ...sections);
}

/** Constant stylesheet for the downloaded report (the in-page print uses styles.css). */
export const REPORT_CSS = `
body{margin:0;background:#fff;color:#111;font:13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif}
.dl-print-report{max-width:960px;margin:24px auto;padding:0 24px}
.dl-rep-kicker{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:#555}
h1{font-size:24px;margin:4px 0 6px}h2{font-size:16px;margin:22px 0 8px;border-bottom:1px solid #ccc;padding-bottom:4px}
h3{font-size:13px;margin:12px 0 2px}.dl-rep-meta{color:#444;margin:0 0 8px}
.dl-rep-warn{background:#fff6e0;border-left:3px solid #e0a000;padding:6px 10px;margin:8px 0}
.dl-rep-note{color:#555;font-size:12px;margin:6px 0}
.dl-rep-kv{display:grid;grid-template-columns:minmax(220px,40%) 1fr;gap:3px 16px;margin:0}
.dl-rep-kv dt{color:#444}.dl-rep-kv dd{margin:0;font-variant-numeric:tabular-nums}
.dl-rep-table{border-collapse:collapse;width:100%;margin:8px 0;font-size:12px}
.dl-rep-table th,.dl-rep-table td{border-bottom:1px solid #ddd;padding:3px 6px;text-align:left;vertical-align:top}
.dl-rep-table td{font-variant-numeric:tabular-nums}
.dl-rep-cites{font-size:12px;padding-left:20px}.dl-rep-url{color:#555;word-break:break-all}
@media print{.dl-print-report{margin:0;max-width:none}section{break-inside:avoid-page}.dl-rep-wide{break-inside:auto}}
`;

/** A complete, standalone HTML document for the report (all values already text nodes; serialisation escapes them). */
export function reportHtmlDocument(report: HTMLElement, title: string, extraCss = ''): string {
  const doc = document.implementation.createHTMLDocument(title);
  const meta = doc.createElement('meta');
  meta.setAttribute('charset', 'utf-8');
  doc.head.prepend(meta);
  const style = doc.createElement('style');
  style.textContent = REPORT_CSS + extraCss;
  doc.head.append(style);
  doc.body.append(doc.importNode(report, true));
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

/** Print the report from this page: show only it while the dialog is up. */
export function printReport(report: HTMLElement): void {
  document.querySelectorAll('body > .dl-print-report').forEach((el) => el.remove());
  document.body.append(report);
  const root = document.documentElement;
  root.classList.add('dl-printing');
  let done = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    root.classList.remove('dl-printing');
    report.remove();
    window.removeEventListener('afterprint', cleanup);
  };
  window.addEventListener('afterprint', cleanup);
  try {
    window.print();
  } finally {
    // Browsers whose print() returns before the dialog closes still fire afterprint; this is the fallback.
    setTimeout(cleanup, 60_000);
  }
}
