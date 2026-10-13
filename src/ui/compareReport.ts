/**
 * The design comparison as a printable / downloadable report (the impactReport.ts / siteReport.ts pattern: built
 * with h(), every value a text node, printed in place or serialised into a standalone .html file). The depth-change
 * maps travel as PNG data URLs (img-src allows data:), drawn by drawDepthChange below.
 */
import { MITIGATION_LABELS } from '../loss/eal';
import {
  BCA_DEFAULT_RATE,
  BCA_NOT_INCLUDED,
  BCA_UNCERTAINTY_LABELS,
  BCA_VERDICT_TEXT,
  bcrRangeText,
  bcrText,
  damageFrequencyRows,
  DISCOUNT_RATE_SOURCE,
  USEFUL_LIFE,
  USEFUL_LIFE_SOURCE,
  usefulLifeOutsideLimits,
  type BcaUncertainty,
} from '../loss/bca';
import type { ComparisonResult, DesignResult } from '../project/compare';
import type { BcaFact } from '../story/captions';
import { DEEPER_M, WET_M } from '../project/compare';
import type { BcaSettings, DesignSpec, ProjectEdit } from '../project/format';
import { describeEdits } from '../project/edits';
import { h } from './dom';
import { fmtNum, formatAcres, formatMoney } from './format';
import { kvList, simpleTable } from './siteReport';

export interface DepthThumb {
  w: number;
  h: number;
  stride: number;
  data: Float32Array;
}

/** Colour of a depth change, m: red = deeper with the design, blue = shallower / dry. */
function changeColour(d: number): [number, number, number, number] {
  if (!(Math.abs(d) > DEEPER_M)) return d !== 0 ? [200, 200, 200, 90] : [0, 0, 0, 0];
  const k = Math.min(1, (Math.abs(d) - DEEPER_M) / 1.9);
  return d > 0 ? [Math.round(250 - 60 * k), Math.round(160 - 140 * k), Math.round(120 - 100 * k), 235] : [Math.round(120 - 100 * k), Math.round(170 - 60 * k), Math.round(250 - 30 * k), 235];
}

/** Draw a depth-change thumbnail (and the design's walls) into a canvas. */
export function drawDepthChange(canvas: HTMLCanvasElement, thumb: DepthThumb, edits: readonly ProjectEdit[]): void {
  canvas.width = thumb.w;
  canvas.height = thumb.h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const img = ctx.createImageData(thumb.w, thumb.h);
  for (let k = 0; k < thumb.data.length; k++) {
    const [r, g, b, a] = changeColour(thumb.data[k]);
    img.data[4 * k] = r;
    img.data[4 * k + 1] = g;
    img.data[4 * k + 2] = b;
    img.data[4 * k + 3] = a;
  }
  ctx.fillStyle = '#f4f4f1';
  ctx.fillRect(0, 0, thumb.w, thumb.h);
  // putImageData ignores compositing; draw through a second canvas so the background shows under transparent cells.
  const tmp = document.createElement('canvas');
  tmp.width = thumb.w;
  tmp.height = thumb.h;
  tmp.getContext('2d')?.putImageData(img, 0, 0);
  ctx.drawImage(tmp, 0, 0);
  ctx.strokeStyle = '#111';
  ctx.lineWidth = Math.max(1, 2 / Math.max(1, thumb.stride / 2));
  ctx.lineCap = 'round';
  for (const e of edits) {
    if (e.op !== 'wall' || e.pts.length < 4) continue;
    ctx.beginPath();
    ctx.moveTo(e.pts[0] / thumb.stride, e.pts[1] / thumb.stride);
    for (let i = 2; i + 1 < e.pts.length; i += 2) ctx.lineTo(e.pts[i] / thumb.stride, e.pts[i + 1] / thumb.stride);
    ctx.stroke();
  }
}

export function depthChangeLegend(): HTMLElement {
  const sw = (bg: string) => h('i', { class: 'dl-cmp-swatch', style: { background: bg } });
  return h(
    'p',
    { class: 'dl-impact-fine dl-cmp-legend' },
    sw('rgb(230,110,70)'),
    ` deeper with the design (> ${fmtNum(DEEPER_M * 100)} cm more, or newly over ${fmtNum(WET_M * 100)} cm) · `,
    sw('rgb(80,150,240)'),
    ' shallower or kept dry · ',
    sw('#111'),
    ' the design’s walls. Change in maximum depth at the level shown, against the baseline run of the same level.',
  );
}

const ratio = (v: number | null) => (v != null && Number.isFinite(v) ? fmtNum(v, Math.abs(v) < 10 ? 2 : 1) : '—');
const moneyOrDash = (v: number | null) => (v != null && Number.isFinite(v) ? formatMoney(v) : '—');

export function designSummaryLine(d: Pick<DesignSpec, 'edits'>, cellSize: number): string {
  const s = describeEdits(d.edits);
  const parts = [`${s.walls} wall${s.walls === 1 ? '' : 's'}${s.walls ? ` (${fmtNum((s.wallCells * cellSize) / 1000, 2)} km)` : ''}`];
  if (s.erases) parts.push(`${s.erases} erase${s.erases === 1 ? '' : 's'}`);
  if (s.terrain) parts.push(`${s.terrain} terrain edit${s.terrain === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

const COST_BASIS: Record<DesignResult['cost']['basis'], string> = {
  override: 'your figure',
  dims: 'your length × height',
  segments: 'drawn walls, segment by segment',
  raster: 'barrier raster estimate (the design erases walls)',
  none: 'no walls',
};

/** Rows of the comparison table: metric, baseline, then one column per design. */
export function comparisonRows(c: ComparisonResult, compact = false): string[][] {
  const rows: string[][] = [];
  c.levels.forEach((l, i) => {
    rows.push([`Loss · ${l.label}${l.returnPeriod ? ` (${fmtNum(l.returnPeriod)} yr)` : ''}`, formatMoney(c.baseline.loss[i]), ...c.designs.map((d) => formatMoney(d.loss[i]))]);
  });
  rows.push(['Expected annual loss (EAL)', moneyOrDash(c.baseline.eal), ...c.designs.map((d) => moneyOrDash(d.eal))]);
  rows.push(['ΔEAL vs baseline (avoided per year)', '—', ...c.designs.map((d) => moneyOrDash(d.deltaEal))]);
  rows.push(['Cost (construction)', '—', ...c.designs.map((d) => `${formatMoney(d.cost.capex)}${d.cost.basis === 'override' || compact ? '' : ` (${formatMoney(d.cost.low)}–${formatMoney(d.cost.high)})`}`)]);
  rows.push(['Wall length · mean height', '—', ...c.designs.map((d) => (d.cost.lengthM > 0 ? `${fmtNum(d.cost.lengthM)} m · ${fmtNum(d.cost.meanHeightM, 1)} m` : '—'))]);
  rows.push(['NPV at 7 % over the useful life', '—', ...c.designs.map((d) => moneyOrDash(d.npv7))]);
  rows.push(['NPV at 3.1 %', '—', ...c.designs.map((d) => moneyOrDash(d.npv3))]);
  rows.push(['BCR at 7 %', '—', ...c.designs.map((d) => ratio(d.bcr7))]);
  rows.push(['BCR at 3.1 %', '—', ...c.designs.map((d) => ratio(d.bcr3))]);
  rows.push(['Buildings protected (most over the levels)', '—', ...c.designs.map((d) => fmtNum(d.protectedBuildings))]);
  rows.push(['Buildings newly reached (transferred risk)', '—', ...c.designs.map((d) => fmtNum(d.newlyReached))]);
  rows.push([`Buildings deeper by > ${fmtNum(DEEPER_M * 100)} cm`, '—', ...c.designs.map((d) => fmtNum(d.deeperBuildings))]);
  rows.push(['Land newly flooded or deeper', '—', ...c.designs.map((d) => formatAcres(d.wetterAreaM2))]);
  rows.push(['Land kept dry', '—', ...c.designs.map((d) => formatAcres(d.protectedAreaM2))]);
  return rows;
}

export function comparisonHead(c: ComparisonResult): string[] {
  return ['', 'Baseline', ...c.designs.map((d) => d.name)];
}

// ─── Benefit–cost ──────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (r: number) => {
  const p = Math.round(r * 1e5) / 1e3; // percent, to 0.001
  return `${fmtNum(p, Number.isInteger(p) ? 0 : Number.isInteger(p * 10) ? 1 : 2)} %`;
};
const moneyRange = (lo: number, hi: number) => (formatMoney(lo) === formatMoney(hi) ? formatMoney(lo) : `${formatMoney(lo)} – ${formatMoney(hi)}`);

/** "50 yr (FEMA standard)" or "40 yr (your input; FEMA's limits for a flood wall are 35–50)". */
export function usefulLifeText(d: DesignResult): string {
  const kind = d.cost.type;
  const u = USEFUL_LIFE[kind];
  if (d.cost.yearsFrom !== 'user') return `${fmtNum(d.years)} yr (FEMA standard)`;
  return `${fmtNum(d.years)} yr (your input${usefulLifeOutsideLimits(kind, d.years) ? `; outside FEMA’s ${fmtNum(u.range[0])}–${fmtNum(u.range[1])} yr` : ''})`;
}

export function bcaHead(c: ComparisonResult): string[] {
  return ['', ...c.designs.map((d) => d.name)];
}

/** The benefit–cost table: one column per design; every BCR with its range, never alone. */
export function bcaRows(c: ComparisonResult): string[][] {
  const col = (f: (d: DesignResult) => string) => c.designs.map((d) => (d.bca ? f(d) : '—'));
  const rows: string[][] = [
    ['Avoided EAL (ΔEAL) · range', ...col((d) => `${formatMoney(d.bca!.central.deltaEal)} (${moneyRange(d.bca!.range.deltaEal[0], d.bca!.range.deltaEal[1])})`)],
    ['Useful life', ...c.designs.map(usefulLifeText)],
    [`PV of benefits at ${pct(c.rate)}`, ...col((d) => formatMoney(d.bca!.central.pvBenefits))],
    ['PV of costs (construction + O&M)', ...col((d) => formatMoney(d.bca!.central.pvCosts))],
    ['BCR (central)', ...col((d) => bcrText(d.bca!.central.bcr))],
    ['BCR range', ...col((d) => bcrRangeText(d.bca!.range.bcr[0], d.bca!.range.bcr[1]))],
    ['BCR · damage curves −1σ / +1σ', ...col((d) => (d.bca!.curve ? `${bcrText(d.bca!.curve.lo.bcr)} / ${bcrText(d.bca!.curve.hi.bcr)}` : 'no curve range'))],
    ['BCR · construction cost low / high', ...col((d) => (d.bca!.cost ? `${bcrText(d.bca!.cost.lo.bcr)} / ${bcrText(d.bca!.cost.hi.bcr)}` : 'your figure (no band)'))],
  ];
  if (c.ensemble) rows.push([`BCR · ensemble p10 / p50 / p90 (${fmtNum(c.ensemble.members)} members)`, ...col((d) => (d.bca!.ensemble ? `${bcrText(d.bca!.ensemble.p10.bcr)} / ${bcrText(d.bca!.ensemble.p50.bcr)} / ${bcrText(d.bca!.ensemble.p90.bcr)}` : '—'))]);
  rows.push(
    ['Net benefit (PV) · range', ...col((d) => `${formatMoney(d.bca!.central.netBenefit)} (${moneyRange(d.bca!.range.netBenefit[0], d.bca!.range.netBenefit[1])})`)],
    ['Break-even construction cost (BCR = 1)', ...col((d) => (d.bca!.central.breakEvenCapex > 0 ? `${formatMoney(d.bca!.central.breakEvenCapex)} (${moneyRange(Math.max(0, d.bca!.range.breakEvenCapex[0]), Math.max(0, d.bca!.range.breakEvenCapex[1]))})` : 'none: the benefit does not cover O&M'))],
    ['Verdict', ...col((d) => BCA_VERDICT_TEXT[d.bca!.verdict])],
  );
  return rows;
}

/**
 * One fact about the comparison's first design as caption text for a narrated story (src/story/captions.ts {bca:…}),
 * worded as the benefit–cost block words it. Null when there is nothing to say (no design, no return period).
 */
export function bcaFact(c: ComparisonResult, f: BcaFact): string | null {
  const d = c.designs[0];
  if (!d) return null;
  if (f === 'design') return d.name;
  if (f === 'rate') return pct(c.rate);
  if (f === 'life') return usefulLifeText(d);
  if (f === 'levels') return c.levels.map((l) => (l.returnPeriod != null ? `${l.label} (${fmtNum(l.returnPeriod)} yr${l.rpFrom === 'user' ? ', your input' : ''})` : l.label)).join(' and ');
  if (f === 'cost') return d.cost.basis === 'override' ? `${formatMoney(d.cost.capex)} (your figure)` : `${formatMoney(d.cost.capex)} (unit-cost estimate, ${moneyRange(d.cost.low, d.cost.high)})`;
  const b = d.bca;
  if (!b) return null;
  switch (f) {
    case 'deltaeal':
      return `${formatMoney(b.central.deltaEal)} a year (${moneyRange(b.range.deltaEal[0], b.range.deltaEal[1])})`;
    case 'bcr':
      return bcrText(b.central.bcr);
    case 'range':
      return bcrRangeText(b.range.bcr[0], b.range.bcr[1]);
    case 'breakeven':
      return b.central.breakEvenCapex > 0 ? formatMoney(b.central.breakEvenCapex) : 'none: the benefit does not cover its upkeep';
    case 'verdict':
      return BCA_VERDICT_TEXT[b.verdict];
    case 'net':
      return `${formatMoney(b.central.netBenefit)} (${moneyRange(b.range.netBenefit[0], b.range.netBenefit[1])})`;
  }
  return null;
}

/** Which uncertainties the ranges include (over every design), and what they never include. */
export function bcaUncertaintyNote(c: ComparisonResult): string {
  const inc = new Set<BcaUncertainty>();
  for (const d of c.designs) for (const u of d.bca?.included ?? []) inc.add(u);
  const included = (['curve', 'cost', 'ensemble', 'tail'] as const).filter((u) => inc.has(u)).map((u) => BCA_UNCERTAINTY_LABELS[u]);
  const ens = c.ensemble
    ? ` The ensemble (${fmtNum(c.ensemble.members)} members) ran on the scenario on screen, not on each design and level: its loss p10 / p50 and p90 / p50 (×${fmtNum(c.ensemble.p10, 2)}, ×${fmtNum(c.ensemble.p90, 2)}) are applied to the avoided EAL as ratios.`
    : ' No flood-probability ensemble has run on this scene, so hazard-input uncertainty is not in the range (Uncertainty → Run ensemble, then the range widens).';
  return `At ${pct(c.rate)} real over each design’s useful life. The range includes: ${included.length ? included.join('; ') : 'nothing — every input has a single value here'}.${ens} Never included: ${BCA_NOT_INCLUDED.join('; ')}.`;
}

/** The FEMA BCA Toolkit inputs, per design: what an engineer would transcribe. */
export function femaBcaSection(c: ComparisonResult, i: { ladderLabel: string; bca: BcaSettings }): HTMLElement {
  const general = kvList([
    ['Analysis year (dollar year)', `${i.bca.analysisYear}`],
    ['Discount rate', `${pct(c.rate)}${Math.abs(c.rate - BCA_DEFAULT_RATE) < 1e-9 ? ' — the Toolkit’s default' : ' — not the Toolkit’s default (7 %); FEMA requires 7 % for HMA projects not awarded by 8 April 2025'} (${DISCOUNT_RATE_SOURCE})`],
    ['Hazard', `Flood — ${i.ladderLabel}`],
    ['Toolkit module', 'Damage-Frequency Assessment: expected damages before and after mitigation per recurrence interval'],
    ['Damages counted', 'Building structure and contents from the Impact model (JRC depth–damage curves, per-country unit costs); no displacement, loss of function, emergency or social benefits, which the Toolkit adds separately'],
    ['Useful-life source', USEFUL_LIFE_SOURCE],
  ]);
  const perDesign = c.designs.map((d) => {
    const rows = damageFrequencyRows(c.levels, c.baseline.loss, d.loss);
    return h(
      'div',
      { class: 'dl-cmp-fema-design' },
      h('h3', null, d.name),
      kvList([
        ['Project useful life', usefulLifeText(d)],
        ['Project cost (construction)', `${formatMoney(d.cost.capex)}${d.cost.basis === 'override' ? ' (your figure)' : ` (unit-cost estimate, ${formatMoney(d.cost.low)}–${formatMoney(d.cost.high)})`}`],
        ['Annual maintenance', d.cost.om > 0 ? formatMoney(d.cost.om) : '$0 (none entered)'],
        ['Mitigation type', `${MITIGATION_LABELS[d.cost.type]} — FEMA table row: ${USEFUL_LIFE[d.cost.type].row}`],
      ]),
      rows.length
        ? simpleTable(['Recurrence interval', 'Event', 'Damages before mitigation', 'Damages after mitigation', 'Return period from'], rows.map((r) => [`${fmtNum(r.T)} yr`, r.label, formatMoney(r.before), formatMoney(r.after), r.rpFrom === 'source' ? 'published' : r.rpFrom === 'user' ? 'your input' : '—']))
        : h('p', { class: 'dl-rep-note' }, 'No level has a return period and a loss: nothing to transcribe.'),
      h('p', { class: 'dl-rep-note' }, `For checking the Toolkit's answer: Deluge's own ΔEAL ${d.bca ? formatMoney(d.bca.central.deltaEal) : '—'}/yr and BCR ${d.bca ? `${bcrText(d.bca.central.bcr)} (range ${bcrRangeText(d.bca.range.bcr[0], d.bca.range.bcr[1])})` : '—'}. The Toolkit integrates damages its own way (its treatment of events beyond the rarest one differs), so expect close, not equal, numbers.`),
    );
  });
  return h(
    'section',
    { class: 'dl-rep-wide', 'data-compare-report': 'fema-bca' },
    h('h2', null, 'Appendix — FEMA BCA Toolkit inputs'),
    h(
      'p',
      { class: 'dl-rep-warn' },
      'This is not a FEMA-accepted benefit–cost analysis. It lists screening numbers from a bare-earth 2-D model for an engineer to check and transcribe into FEMA’s BCA Toolkit; a BCA for a Hazard Mitigation Assistance, BRIC or FMA application must be prepared in the Toolkit with documented damages and is reviewed by the state and FEMA.',
    ),
    general,
    ...perDesign,
  );
}

export interface CompareReportInput {
  generatedAt: Date;
  terrainName: string;
  attribution: string;
  ladderLabel: string;
  durationS: number;
  result: ComparisonResult;
  designs: DesignSpec[];
  cellSize: number;
  /** PNG data URLs of the depth-change maps, by design id, with the level they show. */
  maps: Map<string, { url: string; level: string }>;
  /** The benefit–cost inputs every design shares (the discount rate is in result.rate). */
  bca: BcaSettings;
}

export const COMPARE_REPORT_CSS = `
.dl-cmp-fema-design{break-inside:avoid;margin-top:10px}.dl-cmp-fema-design h3{margin:8px 0 4px;font-size:13px}
.dl-cmp-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 3px;vertical-align:middle}
.dl-cmp-maps{display:flex;flex-wrap:wrap;gap:12px}.dl-cmp-maps figure{margin:0;flex:1 1 220px}
.dl-cmp-maps img{width:100%;max-width:360px;image-rendering:pixelated;border:1px solid #ccc}
`;

export function buildCompareReport(i: CompareReportInput): HTMLElement {
  const c = i.result;
  const sections: HTMLElement[] = [];
  sections.push(
    h(
      'header',
      { class: 'dl-rep-head' },
      h('div', { class: 'dl-rep-kicker' }, 'Deluge — mitigation design comparison'),
      h('h1', null, i.terrainName || 'Scenario'),
      h('p', { class: 'dl-rep-meta' }, `${c.designs.length} design${c.designs.length === 1 ? '' : 's'} against ${c.levels.length} level${c.levels.length === 1 ? '' : 's'} (${i.ladderLabel}), ${fmtNum(i.durationS / 60)} simulated min each · generated ${i.generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`),
      h('p', { class: 'dl-rep-warn' }, 'Screening estimates from a bare-earth 2-D simulation: not a flood study, a design or a FEMA benefit–cost analysis. Return periods marked “your input” are the user’s. Every BCR is shown with its range, and the benefit–cost section says which uncertainties that range includes; the real uncertainty is wider still.'),
    ),
  );
  sections.push(
    h(
      'section',
      null,
      h('h2', null, 'Designs'),
      simpleTable(
        ['Design', 'Edits', 'Mitigation type', 'Cost basis'],
        i.designs.map((d) => {
          const r = c.designs.find((x) => x.id === d.id);
          return [d.name, designSummaryLine(d, i.cellSize), MITIGATION_LABELS[d.cost.type], r ? `${COST_BASIS[r.cost.basis]}${r.cost.terrainNotCosted ? '; terrain edits not costed' : ''}${r.cost.om ? `; O&M ${formatMoney(r.cost.om)}/yr` : ''}` : '—'];
        }),
      ),
    ),
  );
  sections.push(
    h(
      'section',
      null,
      h('h2', null, 'Event ladder'),
      simpleTable(
        ['Level', 'Return period'],
        c.levels.map((l) => [l.label, l.returnPeriod ? `${fmtNum(l.returnPeriod)} yr · ${l.rpFrom === 'source' ? 'published' : 'your input'}` : 'none (no EAL contribution)']),
      ),
      c.withRp ? null : h('p', { class: 'dl-rep-note' }, 'No level has a return period, so there is no EAL, NPV or BCR: give the levels return periods.'),
    ),
  );
  sections.push(h('section', { class: 'dl-rep-wide' }, h('h2', null, 'Results'), simpleTable(comparisonHead(c), comparisonRows(c))));
  if (c.designs.some((d) => d.bca)) {
    sections.push(h('section', { class: 'dl-rep-wide' }, h('h2', null, 'Benefit–cost'), simpleTable(bcaHead(c), bcaRows(c)), h('p', { class: 'dl-rep-note' }, bcaUncertaintyNote(c))));
  }
  sections.push(
    h(
      'section',
      { class: 'dl-rep-wide' },
      h('h2', null, 'Who gets wetter — per level'),
      simpleTable(
        ['Design', 'Level', 'Avoided loss', 'Protected', 'Newly reached', 'Deeper', 'Loss up (buildings, $)', 'Land newly flooded / deeper', 'Land kept dry'],
        c.designs.flatMap((d) =>
          d.perLevel.map((p, k) => [d.name, c.levels[k].label, formatMoney(p.avoided), fmtNum(p.protectedCount), fmtNum(p.newlyReached), fmtNum(p.deeper), `${fmtNum(p.worse)} · ${formatMoney(p.worseLoss)}`, `${formatAcres(p.newlyFloodedM2)} / ${formatAcres(p.deeperM2)}`, formatAcres(p.protectedM2)]),
        ),
      ),
    ),
  );
  if (i.maps.size) {
    sections.push(
      h(
        'section',
        null,
        h('h2', null, 'Change in maximum depth'),
        h(
          'div',
          { class: 'dl-cmp-maps' },
          ...i.designs
            .filter((d) => i.maps.has(d.id))
            .map((d) => {
              const m = i.maps.get(d.id)!;
              return h('figure', null, h('img', { src: m.url, alt: `Change in maximum depth with ${d.name} at ${m.level}` }), h('figcaption', { class: 'dl-rep-note' }, `${d.name} — ${m.level}`));
            }),
        ),
        depthChangeLegend(),
      ),
    );
  }
  sections.push(
    h(
      'section',
      null,
      h('h2', null, 'Method'),
      kvList([
        ['Runs', 'The baseline (no walls) and each design run the same levels headless for the same simulated time; the walls are swapped in by replaying their edit logs on the bare scene.'],
        ['Loss', 'Building damage and dollar loss from the Impact model (JRC depth–damage curves, per-country unit costs) on the run’s per-cell maxima.'],
        ['EAL', 'Trapezoid rule over annual exceedance probability with the tail term (loss held at the rarest level beyond it); levels without a return period do not enter it.'],
        ['Cost', 'Unit cost per metre × height^1.3 by type (src/loss/eal.ts; US floodwall ≈ $6,000/m at 1 m), summed segment by segment along the drawn walls, ±50 %; or your figure. Terrain edits are not costed.'],
        ['NPV, BCR', 'Present value of ΔEAL over each design’s useful life (FEMA BCA Reference Guide Appendix D standard values unless you typed one) at 7 % (OMB A-94 1992, the FEMA BCA Toolkit default since June 2025) and 3.1 % (the revoked 2023 A-94 rate), against construction plus O&M. The benefit–cost section repeats it at your discount rate with the range over the damage curves, the cost band, the EAL tail and, when it has run, the ensemble.'],
        ['Transferred risk', `Buildings reached with the design but not in the baseline, or more than ${fmtNum(DEEPER_M * 100)} cm deeper; land newly over ${fmtNum(WET_M * 100)} cm or more than ${fmtNum(DEEPER_M * 100)} cm deeper (rivers and lakes excluded). Counts are the most over the levels.`],
      ]),
    ),
  );
  sections.push(femaBcaSection(c, { ladderLabel: i.ladderLabel, bca: i.bca }));
  if (i.attribution) sections.push(h('p', { class: 'dl-rep-note' }, i.attribution));
  return h('article', { class: 'dl-print-report' }, ...sections);
}

export { ratio as formatRatio };
