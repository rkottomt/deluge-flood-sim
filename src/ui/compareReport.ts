/**
 * The design comparison as a printable / downloadable report (the impactReport.ts / siteReport.ts pattern: built
 * with h(), every value a text node, printed in place or serialised into a standalone .html file). The depth-change
 * maps travel as PNG data URLs (img-src allows data:), drawn by drawDepthChange below.
 */
import { MITIGATION_LABELS } from '../loss/eal';
import type { ComparisonResult, DesignResult } from '../project/compare';
import { DEEPER_M, WET_M } from '../project/compare';
import type { DesignSpec, ProjectEdit } from '../project/format';
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
  rows.push([`NPV at 7 %, ${c.designs[0]?.years ?? 50} yr`, '—', ...c.designs.map((d) => moneyOrDash(d.npv7))]);
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
}

export const COMPARE_REPORT_CSS = `
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
      h('p', { class: 'dl-rep-warn' }, 'Screening estimates from a bare-earth 2-D simulation: not a flood study, a design or a FEMA benefit–cost analysis. Return periods marked “your input” are the user’s. Ranges show only the cost band; the real uncertainty is wider.'),
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
        ['NPV, BCR', `Present value of ΔEAL over ${c.designs[0]?.years ?? 50} years at 7 % (OMB A-94, FEMA default) and 3.1 %, against construction plus O&M.`],
        ['Transferred risk', `Buildings reached with the design but not in the baseline, or more than ${fmtNum(DEEPER_M * 100)} cm deeper; land newly over ${fmtNum(WET_M * 100)} cm or more than ${fmtNum(DEEPER_M * 100)} cm deeper (rivers and lakes excluded). Counts are the most over the levels.`],
      ]),
    ),
  );
  if (i.attribution) sections.push(h('p', { class: 'dl-rep-note' }, i.attribution));
  return h('article', { class: 'dl-print-report' }, ...sections);
}

export { ratio as formatRatio };
