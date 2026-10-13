/**
 * `deluge dam` — a dam breach's outflow without a map: the published relations' peaks as a low / central / high band,
 * the hydrograph the app would send to the map, and the assumptions; `--history` scores the relations on documented
 * failures. Pure arithmetic (src/dams): no GPU, no network — the NID index is the app's own baked file.
 */
import { BREACH_METHOD_IDS, BREACH_METHODS, BREACH_MODES, damBreach, damScenario, DAM_BREACH_CAVEATS, type BreachMethod, type BreachMode, type BreachResult } from '../dams/breachModel';
import { ARRIVAL_EXPONENT, CENTRAL_RELATION, RELATIONS, relationById } from '../dams/breachRelations';
import { HISTORICAL_FAILURES, scoreRelations } from '../dams/historicalFailures';
import { damById, NID_ID_RE, type NidIndex } from '../dams/nidIndex';
import { EXIT, flag, num, str, type ParsedOptions } from './args';
import { toJson, type Log } from './io';
import { UsageError } from './scenario';

/** What the dam command needs from its surroundings (main.ts gives the disk; tests give stand-ins). */
export interface DamEnv {
  log: Log;
  loadNidIndex(): Promise<NidIndex>;
  write(file: string, data: string): void;
  stdout(text: string): void;
}

const round = (v: number, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const q = (v: number) => `${Math.round(v >= 1000 ? round(v, -1) : v).toLocaleString('en-US')} m³/s`;
const mins = (s: number) => (s < 90 * 60 ? `${Math.round(s / 60)} min` : `${round(s / 3600, 1)} h`);

/** The historical score table, as text (README "Dam breaches" carries the same table). */
export function historyTable(): string {
  const scores = scoreRelations(RELATIONS).sort((a, b) => a.rmsLog - b.rmsLog);
  const lines = [
    `Breach relations scored on ${HISTORICAL_FAILURES.length} documented embankment-dam failures with a measured or reconstructed peak`,
    '(Wahl 1998, USBR DSO-98-004, Table A1). Errors are log10(predicted / observed); in-sample for most relations.',
    '',
    `${'relation'.padEnd(42)} ${'n'.padStart(3)} ${'bias'.padStart(7)} ${'RMS'.padStart(6)} ${'within x2'.padStart(10)} ${'Teton'.padStart(7)}`,
    ...scores.map((s) => {
      const r = relationById(s.id as (typeof RELATIONS)[number]['id']);
      const mark = s.id === CENTRAL_RELATION ? ' *' : '';
      return `${(r.label + mark).padEnd(42)} ${String(s.n).padStart(3)} ${((s.meanLog >= 0 ? '+' : '') + s.meanLog.toFixed(2)).padStart(7)} ${s.rmsLog.toFixed(2).padStart(6)} ${`${Math.round(100 * s.withinFactor2)} %`.padStart(10)} ${(s.teton === null ? '—' : `${s.teton.toFixed(2)}×`).padStart(7)}`;
    }),
    '',
    '* the central case: the smallest RMS error.',
  ];
  return `${lines.join('\n')}\n`;
}

function resultJson(r: BreachResult) {
  return {
    method: r.method,
    peakM3s: round(r.peak, 1),
    tPeakS: round(r.tPeak),
    breachVolumeM3: round(r.breachVolume),
    deliveredVolumeM3: round(r.deliveredVolume),
    froehlich2008: { avgWidthM: round(r.avgWidthM, 1), bottomWidthM: round(r.bottomWidthM, 1), sideSlope: r.sideSlope, formationTimeS: round(r.formationTimeS) },
    band: {
      low: { relation: r.band.low.id, peakM3s: round(r.band.low.peak, 1) },
      central: { relation: r.band.central.id, peakM3s: round(r.band.central.peak, 1) },
      high: { relation: r.band.high.id, peakM3s: round(r.band.high.peak, 1) },
    },
    relations: r.relations.map((x) => ({ id: x.id, label: x.label, cite: x.cite, kind: x.kind, peakM3s: round(x.peak, 1) })),
    hydrograph: r.hydrograph.map((p) => [round(p.t, 1), round(p.q, 2)]),
  };
}

export async function damCommand(env: DamEnv, o: ParsedOptions): Promise<number> {
  if (flag(o, 'history')) {
    env.stdout(historyTable());
    return EXIT.ok;
  }
  const breach = str(o, 'breach') ?? 'sunny';
  if (breach !== 'sunny' && breach !== 'flood') throw new UsageError('--breach is sunny or flood');
  const method = str(o, 'method') ?? 'central';
  if (!(BREACH_METHOD_IDS as readonly string[]).includes(method)) throw new UsageError(`--method is one of ${BREACH_METHOD_IDS.join(', ')}`);
  const nid = str(o, 'nid');
  const V = num(o, 'volume-m3');
  let title: string;
  let result: BreachResult;
  let assumptions: string[];
  let extra: Record<string, unknown> = {};
  if (nid !== undefined) {
    if (V !== undefined) throw new UsageError('give --nid or --volume-m3, not both');
    const id = nid.toUpperCase();
    if (!NID_ID_RE.test(id)) throw new UsageError(`--nid ${JSON.stringify(nid.slice(0, 12))} is not an NID id (two letters and 3–6 letters or digits, e.g. MI00549)`);
    const dam = damById(await env.loadNidIndex(), id);
    if (!dam) throw new UsageError(`${id} is not in the dam index (it holds dams of at least 1,000 acre-ft, or 6 m high over 50 acre-ft)`);
    const s = damScenario(dam, breach as BreachMode, method as BreachMethod);
    result = s.result;
    assumptions = s.assumptions;
    title = `${dam.name} (NID ${dam.id}, ${dam.state}) — ${dam.damType}, ${round(dam.heightM, 1)} m, ${Math.round(dam.storageAcFt).toLocaleString('en-US')} acre-ft, ${dam.hazard} hazard: ${BREACH_MODES[s.mode].label.toLowerCase()}`;
    extra = { dam: { nid: dam.id, name: dam.name, state: dam.state, type: dam.damType, heightM: dam.heightM, storageAcFt: dam.storageAcFt, hazard: dam.hazard }, mode: s.mode, volumeM3: round(s.volumeM3), headM: round(s.headM, 2) };
  } else if (V !== undefined) {
    const hw = num(o, 'head-m');
    if (!(V > 0) || !Number.isFinite(V)) throw new UsageError('--volume-m3 must be a positive number of cubic metres');
    if (hw === undefined || !(hw > 0)) throw new UsageError('--volume-m3 needs --head-m, the depth of water above the breach bottom (m)');
    const hb = num(o, 'height-m') ?? hw;
    if (!(hb > 0)) throw new UsageError('--height-m must be positive');
    const over = flag(o, 'overtopping');
    result = damBreach({ volumeM3: V, headM: hw, breachHeightM: hb, overtopping: over, method: method as BreachMethod });
    assumptions = ['A dam described on the command line: homogeneous earthfill, easily eroded, medium erodibility, reservoir shape exponent 2.5, no width cap, no base flow.'];
    title = `${(V / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })} million m³ behind ${hw} m of head (breach height ${hb} m), ${over ? 'overtopping' : 'piping'}`;
    extra = { volumeM3: V, headM: hw, breachHeightM: hb, overtopping: over };
  } else throw new UsageError('give --nid <id>, or --volume-m3 and --head-m (or --history)');

  const out = str(o, 'out');
  if (out) {
    env.write(out, `t_s,q_m3s\n${result.hydrograph.map((p) => `${round(p.t, 1)},${round(p.q, 2)}`).join('\n')}\n`);
    env.log.info(`wrote ${out} (${result.hydrograph.length} points)`);
  }
  if (flag(o, 'json')) {
    env.stdout(toJson({ ...extra, ...resultJson(result), assumptions, caveats: [...DAM_BREACH_CAVEATS], arrivalScaling: `travel time ∝ peak^-${ARRIVAL_EXPONENT}` }));
    return EXIT.ok;
  }
  const b = result.band;
  const lines = [
    title,
    '',
    `Peak outflow, ${result.relations.length} published relations: ${q(b.low.peak)} (${relationById(b.low.id).label}) – ${q(b.high.peak)} (${relationById(b.high.id).label})`,
    `  central ${q(b.central.peak)} (${relationById(b.central.id).label}; best on ${HISTORICAL_FAILURES.length} past failures — deluge dam --history)`,
    '',
    ...[...result.relations].sort((a, c) => a.peak - c.peak).map((x) => `  ${x.label.padEnd(40)} ${q(x.peak).padStart(14)}   ${x.cite}`),
    '',
    `Hydrograph (${BREACH_METHODS[result.method]}): peak ${q(result.peak)} at ${mins(result.tPeak)}, ${(result.breachVolume / 1e6).toFixed(1)} million m³ through the breach` +
      (result.input.baseFlow > 0 ? `, ${q(result.input.baseFlow)} river flood under it` : ''),
    `Froehlich 2008 breach: ${Math.round(result.avgWidthM)} m average width, formed over ${mins(result.formationTimeS)}`,
    `Downstream, travel time goes roughly as peak^-${ARRIVAL_EXPONENT}: the high case arrives ~${Math.round(100 * (1 - Math.pow(b.central.peak / b.high.peak, ARRIVAL_EXPONENT)))} % sooner than the central one` +
      (b.low.id === b.central.id ? ' (the central case is the lowest here)' : `, the low case ~${Math.round(100 * (Math.pow(b.central.peak / b.low.peak, ARRIVAL_EXPONENT) - 1))} % later`) +
      ' — indicative; run each case on the map in the app.',
    ...(assumptions.length ? ['', 'Assumed for this dam:', ...assumptions.map((a) => `  - ${a}`)] : []),
    '',
    'Leaves out:',
    ...DAM_BREACH_CAVEATS.map((c) => `  - ${c}`),
  ];
  env.stdout(`${lines.join('\n')}\n`);
  return EXIT.ok;
}
