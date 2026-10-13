/**
 * Documented embankment-dam failures with a measured or reconstructed peak outflow, for scoring the breach relations
 * (src/dams/breachRelations.ts; tests/dams/breachRelations.test.ts; README "Dam breaches").
 *
 * SOURCE. Every number is from one table: Wahl, T.L. 1998, "Prediction of embankment dam breach parameters — a
 * literature review and needs assessment", U.S. Bureau of Reclamation Dam Safety Report DSO-98-004, Appendix Table A1
 * (108 failures compiled from MacDonald & Langridge-Monopolis 1984, Costa 1985, Froehlich 1995, Singh & Scarlatos 1988
 * and others; its footnotes name the source of each value). The case number is Wahl's.
 *
 * WHICH CASES. Every case in Table A1 that gives an observed peak outflow Q_p, the volume released V_w, the head h_w
 * and the failure mode — EXCEPT:
 *   - peaks whose method of determination is "unknown" (Wahl's column) — Bradfield, Davis, Euclides da Cunha, Frankfurt,
 *     Goose Creek, Granite Creek, Hatfield, Lake Avalon, Lake Latonka, Mammoth, Martin, Mill River, Nanaksagar, Oros,
 *     Salles Oliveira, Sandy Run, Sherburne, and Prospect ("reservoir drawdown, unknown time period");
 *   - a head given only as a bound (">") — Puddingstone, Schaeffer;
 *   - cases Wahl 1998 (p. 39–40) flags as unfit: South Fork Tributary (failed by the dam above it), North Branch
 *     Tributary (peaks reported 10× apart);
 *   - no failure mode or no volume: Otto Run, DMAD.
 * That leaves 21 failures, 7,400 m³ to 310 million m³. Where Table A1 has no dam height h_d, the breach height h_b
 * stands for it (it enters only Xu & Zhang, at the 0.199 power); where it has no storage S, V_w stands for it.
 *
 * CAVEAT. Most of these failures are in the datasets the relations were fitted to, so this is an in-sample check: it
 * says how well each relation reproduces the record it came from, not how it would do on the next failure (Wahl 2004,
 * J. Hydraul. Eng. 130(5):389, makes the same point and finds the same ranking at the top: Froehlich 1995's peak
 * relation has both the smallest mean error and the narrowest band, ±0.32 log cycles).
 */
import type { DamCase, XuZhangDamType } from './breachRelations';

export interface HistoricalFailure {
  /** Wahl 1998 Table A1 case number. */
  wahl: number;
  name: string;
  year: number;
  mode: 'piping' | 'overtopping';
  /** Construction as Wahl lists it. */
  construction: string;
  /** h_d, m (null: not in the table). */
  damHeightM: number | null;
  /** S, m³ (null: not in the table). */
  storageM3: number | null;
  /** Reservoir surface area, m² (null: not in the table). */
  areaM2: number | null;
  volumeM3: number;
  headM: number;
  breachHeightM: number;
  /** Observed peak outflow, m³/s, and how it was determined (Wahl's words). */
  peak: number;
  peakMethod: string;
}

export const HISTORICAL_FAILURES: readonly HistoricalFailure[] = [
  { wahl: 1, name: 'Apishapa, Colorado', year: 1923, mode: 'piping', construction: 'Homogeneous earthfill, fine sand', damHeightM: 34.14, storageM3: 22.5e6, areaM2: 2.59e6, volumeM3: 22.2e6, headM: 28.0, breachHeightM: 31.1, peak: 6850, peakMethod: '15-min reservoir drawdown' },
  { wahl: 2, name: 'Baldwin Hills, California', year: 1963, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: 71, storageM3: 1.1e6, areaM2: 76_900, volumeM3: 910_000, headM: 12.2, breachHeightM: 21.3, peak: 1130, peakMethod: '15-min reservoir drawdown' },
  { wahl: 7, name: 'Buffalo Creek, West Virginia', year: 1972, mode: 'piping', construction: 'Homogeneous fill, coal waste (seepage failure)', damHeightM: 14.02, storageM3: 484_000, areaM2: 52_600, volumeM3: 484_000, headM: 14.02, breachHeightM: 14, peak: 1420, peakMethod: 'slope-area measurement' },
  { wahl: 9, name: 'Butler, Arizona', year: 1982, mode: 'overtopping', construction: 'Homogeneous earthfill', damHeightM: null, storageM3: null, areaM2: null, volumeM3: 2.38e6, headM: 7.16, breachHeightM: 7.16, peak: 810, peakMethod: 'slope-area 600 m downstream' },
  { wahl: 11, name: 'Castlewood, Colorado', year: 1933, mode: 'overtopping', construction: 'Earth/rockfill with masonry wall', damHeightM: 21.34, storageM3: 4.23e6, areaM2: 809_000, volumeM3: 6.17e6, headM: 21.6, breachHeightM: 21.3, peak: 3570, peakMethod: '15-min reservoir drawdown' },
  { wahl: 26, name: 'Fred Burr, Montana', year: 1948, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: 10.4, storageM3: 752_000, areaM2: null, volumeM3: 750_000, headM: 10.2, breachHeightM: 10.4, peak: 654, peakMethod: 'slope-area "short distance downstream"' },
  { wahl: 27, name: 'French Landing, Michigan', year: 1925, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: null, storageM3: null, areaM2: null, volumeM3: 3.87e6, headM: 8.53, breachHeightM: 14.2, peak: 929, peakMethod: '1-hr reservoir drawdown' },
  { wahl: 35, name: 'Hatchtown, Utah', year: 1914, mode: 'piping', construction: 'Zoned earthfill', damHeightM: 19.2, storageM3: 14.8e6, areaM2: null, volumeM3: 14.8e6, headM: 16.8, breachHeightM: 18.3, peak: 3080, peakMethod: '1-hr reservoir drawdown' },
  { wahl: 38, name: 'Hell Hole, California', year: 1964, mode: 'piping', construction: 'Rockfill', damHeightM: 67.06, storageM3: 30.6e6, areaM2: null, volumeM3: 30.6e6, headM: 35.1, breachHeightM: 56.4, peak: 7360, peakMethod: '1-hr reservoir drawdown' },
  { wahl: 43, name: 'Ireland No. 5, Colorado', year: 1984, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: null, storageM3: null, areaM2: null, volumeM3: 160_000, headM: 3.81, breachHeightM: 5.18, peak: 110, peakMethod: 'slope-area "short distance downstream"' },
  { wahl: 46, name: 'Johnstown (South Fork), Pennsylvania', year: 1889, mode: 'overtopping', construction: 'Zoned earth and rockfill', damHeightM: 38.1, storageM3: 18.9e6, areaM2: 1.65e6, volumeM3: 18.9e6, headM: 24.6, breachHeightM: 24.4, peak: 8500, peakMethod: '30-min reservoir drawdown' },
  { wahl: 48, name: 'Kelly Barnes, Georgia', year: 1977, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: 11.58, storageM3: 505_000, areaM2: 170_000, volumeM3: 777_000, headM: 11.3, breachHeightM: 12.8, peak: 680, peakMethod: 'slope-area 250 m downstream' },
  { wahl: 59, name: 'Laurel Run, Pennsylvania', year: 1977, mode: 'overtopping', construction: 'Earthfill', damHeightM: 12.8, storageM3: 385_000, areaM2: null, volumeM3: 555_000, headM: 14.1, breachHeightM: 13.7, peak: 1050, peakMethod: 'slope-area 1.6 km downstream' },
  { wahl: 60, name: 'Lawn Lake, Colorado', year: 1982, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: 7.9, storageM3: null, areaM2: null, volumeM3: 798_000, headM: 6.71, breachHeightM: 7.62, peak: 510, peakMethod: 'dam-break model' },
  { wahl: 61, name: 'Lily Lake, Colorado', year: 1951, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: null, storageM3: null, areaM2: null, volumeM3: 92_500, headM: 3.35, breachHeightM: 3.66, peak: 71, peakMethod: 'slope-area at unknown location' },
  { wahl: 62, name: 'Little Deer Creek, Utah', year: 1963, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: 26.21, storageM3: 1.73e6, areaM2: null, volumeM3: 1.36e6, headM: 22.9, breachHeightM: 27.1, peak: 1330, peakMethod: 'slope-area at unknown location' },
  { wahl: 64, name: 'Lower Latham, Colorado', year: 1973, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: null, storageM3: 7.08e6, areaM2: null, volumeM3: 7.08e6, headM: 5.79, breachHeightM: 7.01, peak: 340, peakMethod: 'slope-area at unknown location' },
  { wahl: 66, name: 'Lower Two Medicine, Montana', year: 1964, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: 11.28, storageM3: 19.6e6, areaM2: null, volumeM3: 29.6e6, headM: 11.3, breachHeightM: 11.3, peak: 1800, peakMethod: 'slope-area 4 km downstream' },
  { wahl: 87, name: 'Quail Creek, Utah', year: 1989, mode: 'piping', construction: 'Homogeneous earthfill', damHeightM: null, storageM3: null, areaM2: null, volumeM3: 30.8e6, headM: 16.7, breachHeightM: 21.3, peak: 3110, peakMethod: '15-min reservoir drawdown' },
  { wahl: 101, name: 'Swift, Montana', year: 1964, mode: 'overtopping', construction: 'Rockfill with concrete facing', damHeightM: 57.61, storageM3: 37e6, areaM2: null, volumeM3: 37e6, headM: 47.85, breachHeightM: 57.6, peak: 24_947, peakMethod: 'slope-area 27 km downstream' },
  { wahl: 102, name: 'Teton, Idaho', year: 1976, mode: 'piping', construction: 'Zoned earthfill', damHeightM: 92.96, storageM3: 356e6, areaM2: null, volumeM3: 310e6, headM: 77.4, breachHeightM: 86.9, peak: 65_120, peakMethod: 'slope-area 4 km downstream' },
];

/**
 * The relations' inputs for a historical failure, classified from Wahl's construction text by the same rules the NID
 * dams get (src/dams/breachModel.ts damCaseFor): homogeneous earthfill erodes easily; zoned, cored, walled and rockfill
 * dams resist; concrete facing takes Xu & Zhang out; erodibility is 'medium' (unknown, as for every NID dam).
 */
export function historicalCase(f: HistoricalFailure): DamCase {
  const c = f.construction.toLowerCase();
  const xzType: XuZhangDamType | null = /concrete facing/.test(c) ? null : /wall|core|rockfill/.test(c) ? 'core-wall' : 'homogeneous';
  const p = f.areaM2 ? Math.min(4, Math.max(1, (f.areaM2 * f.headM) / f.volumeM3)) : 2.5;
  return {
    volumeM3: f.volumeM3,
    headM: f.headM,
    breachHeightM: Math.max(f.breachHeightM, f.headM),
    damHeightM: f.damHeightM ?? f.breachHeightM,
    storageM3: f.storageM3 ?? f.volumeM3,
    overtopping: f.mode === 'overtopping',
    xzType,
    erodibility: 'medium',
    easilyErodible: /^homogeneous/.test(c),
    hypsometry: p,
  };
}

export interface RelationScore {
  id: string;
  /** Cases the relation applied to. */
  n: number;
  /** Mean of log10(predicted / observed): + over-predicts. */
  meanLog: number;
  /** Root-mean-square of log10(predicted / observed). */
  rmsLog: number;
  /** Share of cases within a factor of 2. */
  withinFactor2: number;
  /** Teton's predicted / observed. */
  teton: number | null;
}

/** Score peak functions against the historical failures (log errors, as Wahl 2004 does). */
export function scoreRelations(relations: ReadonlyArray<{ id: string; peak(c: DamCase): number | null }>, cases: readonly HistoricalFailure[] = HISTORICAL_FAILURES): RelationScore[] {
  return relations.map((r) => {
    let n = 0;
    let sum = 0;
    let sq = 0;
    let f2 = 0;
    let teton: number | null = null;
    for (const f of cases) {
      const q = r.peak(historicalCase(f));
      if (q === null || !(q > 0)) continue;
      const e = Math.log10(q / f.peak);
      n++;
      sum += e;
      sq += e * e;
      if (Math.abs(e) <= Math.log10(2)) f2++;
      if (f.wahl === 102) teton = q / f.peak;
    }
    return { id: r.id, n, meanLog: n ? sum / n : NaN, rmsLog: n ? Math.sqrt(sq / n) : NaN, withinFactor2: n ? f2 / n : NaN, teton };
  });
}
