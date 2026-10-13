/**
 * Site check × future climate: the same ladder run twice — today's forcing, then the forcing scaled to a future climate
 * (src/climate) — and the site's loss and EAL side by side ("EAL today $X → 2050 · SSP5-8.5 $Y").
 *
 * The return periods stay TODAY's: the future run asks "what does today's 1-in-T event do once its rain (or the sea
 * under it) has changed this much", which is the forcing-scaled answer, not a re-fitted frequency curve. Said so on
 * screen and in the report.
 */
import { formatReturnPeriod, summarizeSweep, type SweepRow } from '../loss';
import { h } from './dom';

/** A plain table (siteReport.ts has the same helper; not imported, because siteReport imports this file). */
function table(head: string[], rows: string[][], durations: string[] = []): HTMLTableElement {
  return h(
    'table',
    null,
    h('thead', null, h('tr', null, ...head.map((c) => h('th', null, c)))),
    h('tbody', null, ...rows.map((r, i) => h('tr', { 'data-sim-s': durations[i] ?? null }, ...r.map((c) => h('td', null, c))))),
  );
}

export interface ClimateSweepPair {
  /** e.g. "2050 · SSP5-8.5". */
  label: string;
  /** What the future run changed, one short line each (rain × 1.11, sea +0.36 m …). */
  changes: string[];
  today: Map<string, SweepRow[]>;
  future: Map<string, SweepRow[]>;
}

export interface ClimateComparison {
  label: string;
  changes: string[];
  todayEal: { low: number; high: number } | null;
  futureEal: { low: number; high: number } | null;
  /** Relative change of the EAL midpoint, or null when either side has none (or today's is 0). */
  change: number | null;
  rows: Array<{ id: string; label: string; returnPeriod: number | null; today: number | null; future: number | null; todayS: number; futureS: number }>;
}

/** Today vs future for one site; `rpOf` gives each level's return period as the ladder has it now (user edits count). */
export function compareClimate(pair: ClimateSweepPair, siteId: string, rpOf: (levelId: string) => number | null): ClimateComparison | null {
  const t = pair.today.get(siteId);
  const f = pair.future.get(siteId);
  if (!t?.length || !f?.length) return null;
  const withRp = (rows: SweepRow[]) =>
    rows.map((r) => {
      const T = rpOf(r.level.id);
      return { ...r, level: { ...r.level, returnPeriod: T, rpFrom: T == null ? null : r.level.rpFrom ?? 'user' } } as SweepRow;
    });
  const st = summarizeSweep(withRp(t));
  const sf = summarizeSweep(withRp(f));
  const mid = (e: { low: number; high: number } | null) => (e ? (e.low + e.high) / 2 : NaN);
  const a = mid(st.eal);
  const b = mid(sf.eal);
  const futureById = new Map(sf.rows.map((r) => [r.level.id, r]));
  return {
    label: pair.label,
    changes: pair.changes,
    todayEal: st.eal,
    futureEal: sf.eal,
    change: Number.isFinite(a) && Number.isFinite(b) && a > 0 ? b / a - 1 : null,
    rows: st.rows.map((r) => ({
      id: r.level.id,
      label: r.level.label,
      returnPeriod: r.level.returnPeriod,
      today: r.run.result?.loss ?? null,
      future: futureById.get(r.level.id)?.run.result?.loss ?? null,
      todayS: r.level.durationS,
      futureS: futureById.get(r.level.id)?.level.durationS ?? NaN,
    })),
  };
}

/** "EAL today $X–$Y a year → 2050 · SSP5-8.5 $A–$B (+60 %)", or why there is no EAL. */
export function climateEalSentence(c: ClimateComparison, money: (v: number) => string): string {
  const range = (e: { low: number; high: number }) => (Math.abs(e.high - e.low) < 0.5 ? money(e.high) : `${money(e.low)}–${money(e.high)}`);
  if (!c.todayEal || !c.futureEal) return `EAL today → ${c.label}: not computed — give the levels return periods.`;
  const ch = c.change == null ? '' : ` (${c.change >= 0 ? '+' : '−'}${Math.round(Math.abs(c.change) * 100)} %)`;
  return `EAL today ${range(c.todayEal)} a year → ${c.label} ${range(c.futureEal)}${ch}`;
}

export const CLIMATE_COMPARE_NOTE =
  'Forcing-scaled: the same ladder re-run with this climate’s rain, rain-fed inflows and sea level; return periods are today’s (no re-fitted frequency curve). Not a downscaled projection.';

/** The panel / report block for one site. */
export function climateCompareBlock(c: ClimateComparison, money: (v: number) => string, cls = 'dl-site-climate'): HTMLElement {
  const fmt = (v: number | null) => (v == null ? '—' : money(v));
  return h(
    'div',
    { class: cls, 'data-site': 'climate-compare' },
    h('div', { class: 'dl-site-climate-eal', 'data-site': 'climate-eal' }, climateEalSentence(c, money)),
    c.changes.length ? h('div', { class: 'dl-impact-fine' }, `${c.label}: ${c.changes.join(' · ')}`) : null,
    h(
      'div',
      { class: 'dl-impact-table' },
      table(
        ['Level', 'Loss today', `Loss ${c.label}`],
        c.rows.map((r) => [r.label + (r.returnPeriod ? ` · ${formatReturnPeriod(r.returnPeriod)} yr` : ''), fmt(r.today), fmt(r.future)]),
        c.rows.map((r) => `${Math.round(r.todayS)}|${Math.round(r.futureS)}`),
      ),
    ),
    lengthWarning(c) ? h('p', { class: 'dl-impact-fine dl-warn', 'data-site': 'climate-length-warning' }, lengthWarning(c)) : null,
    h('p', { class: 'dl-impact-fine' }, CLIMATE_COMPARE_NOTE),
  );
}

/**
 * Headless runs stop exactly on the asked time (src/ui/headless.ts), so the two runs of a level should be the same
 * length; past 1 % apart (a run cut short, a level added to one side later), part of the difference is run length.
 */
export const RUN_LENGTH_TOLERANCE = 0.01;

/** A warning when a level's today and future runs differ in simulated length by more than the tolerance. */
export function lengthWarning(c: ClimateComparison): string | null {
  const off = c.rows.filter((r) => Number.isFinite(r.todayS) && Number.isFinite(r.futureS) && Math.abs(r.futureS - r.todayS) > RUN_LENGTH_TOLERANCE * Math.max(r.todayS, r.futureS));
  if (!off.length) return null;
  const list = off.map((r) => `${r.label} ${Math.round(r.todayS / 6) / 10} vs ${Math.round(r.futureS / 6) / 10} min`).join('; ');
  return `The two runs of a level differ in simulated length (${list}), so part of the change is run length, not climate. Run the comparison again.`;
}
