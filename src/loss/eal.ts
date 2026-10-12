/**
 * Expected annual loss (EAL) and the benefit–cost ratio of mitigation, FEMA-BCA style (spec §C.6, §C.7).
 *
 *   EAL = Σ ½ (Lᵢ + Lᵢ₊₁)(pᵢ − pᵢ₊₁)  +  L_N · p_N        pᵢ = 1/Tᵢ, scenarios sorted frequent → rare
 *
 * The tail term assumes the loss stays at the rarest scenario's beyond it; it is optional, and the range with and
 * without it is the honest answer. The return period of a scenario is an INPUT: Deluge runs events, it does not know
 * how often they happen — that comes from a gauge frequency analysis (USGS Bulletin 17C, StreamStats) or the user.
 *
 *   BCR = PV(avoided losses) / PV(costs),   PV = Σ_{t=1..n} x / (1 + r)^t = x · UPV(r, n)
 *
 * Discount rates: 7 % (OMB Circular A-94 1992; FEMA's BCA Toolkit default again since 2025-06-04, after OMB revoked
 * the 2024 A-94 update on 2025-04-08) and 3.1 % (the revoked 2024 A-94 rate, still selectable in the Toolkit).
 */

/** OMB A-94 (1992) real discount rate — the FEMA BCA default since June 2025. */
export const DISCOUNT_RATE_FEMA = 0.07;
/** OMB A-94 (2024 update, revoked April 2025) — shown alongside for comparison. */
export const DISCOUNT_RATE_LOW = 0.031;
/** Project useful life for floodwalls and levees in FEMA BCA practice, years [M — check the BCA Reference Guide]. */
export const USEFUL_LIFE_WALL_YEARS = 50;

export interface LossPoint {
  /** Return period, years (> 0). */
  T: number;
  loss: number;
}

/** EAL by the trapezoid rule over exceedance probability, plus the optional tail L_N / T_N. */
export function eal(points: readonly LossPoint[], tail = true): number {
  const s = points.filter((p) => p.T > 0 && Number.isFinite(p.loss)).sort((a, b) => a.T - b.T);
  if (s.length === 0) return 0;
  let e = 0;
  for (let i = 0; i < s.length - 1; i++) {
    const p1 = 1 / s[i].T;
    const p2 = 1 / s[i + 1].T;
    e += 0.5 * (s[i].loss + s[i + 1].loss) * (p1 - p2);
  }
  if (tail) e += s[s.length - 1].loss / s[s.length - 1].T;
  return e;
}

/** EAL without and with the tail term: report both (spec §C.6). */
export function ealRange(points: readonly LossPoint[]): { low: number; high: number } {
  return { low: eal(points, false), high: eal(points, true) };
}

/** Uniform present value factor: PV of 1 per year for n years at rate r. */
export function upv(r: number, n: number): number {
  if (!(n > 0)) return 0;
  if (r === 0) return n;
  return (1 - Math.pow(1 + r, -n)) / r;
}

/** PV of a benefit growing g per year (climate-trend uplift): Σ (1+g)^t / (1+r)^t, t = 1 … n. */
export function upvGrowing(r: number, n: number, g: number): number {
  let s = 0;
  for (let t = 1; t <= n; t++) s += Math.pow((1 + g) / (1 + r), t);
  return s;
}

export interface BcrInput {
  /** Avoided expected annual loss (EAL before − after). */
  deltaEal: number;
  capex: number;
  /** Annual operation & maintenance. */
  om?: number;
  rate: number;
  years: number;
}

export interface BcrResult {
  pvBenefits: number;
  pvCosts: number;
  bcr: number;
  /** Net present value: benefits − costs. */
  npv: number;
}

export function bcr(i: BcrInput): BcrResult {
  const f = upv(i.rate, i.years);
  const pvBenefits = i.deltaEal * f;
  const pvCosts = i.capex + (i.om ?? 0) * f;
  return { pvBenefits, pvCosts, bcr: pvCosts > 0 ? pvBenefits / pvCosts : NaN, npv: pvBenefits - pvCosts };
}

/**
 * Single-event shortcut used by the panel when only one scenario has been run with and without the mitigation: the
 * avoided loss ΔL is booked once every T years (ΔEAL = ΔL / T) and nothing in any other event. It is a first look,
 * not a BCA — a real one integrates several return periods (eal above).
 *
 * The break-even return period is the T at which BCR = 1: the mitigation pays for itself if an event like this one
 * is at least that frequent.
 */
export function breakEvenReturnPeriod(avoidedLoss: number, capex: number, om: number, rate: number, years: number): number {
  const f = upv(rate, years);
  const pvCosts = capex + om * f;
  if (!(avoidedLoss > 0) || !(pvCosts > 0)) return NaN;
  return (avoidedLoss * f) / pvCosts;
}

// ─── Mitigation unit costs (spec §C.7) ─────────────────────────────────────────────────────────────────────────────

export type MitigationType = 'earthen' | 'floodwall' | 'gabion';

export const MITIGATION_LABELS: Readonly<Record<MitigationType, string>> = {
  earthen: 'Earthen levee',
  floodwall: 'Concrete floodwall',
  gabion: 'Gabion embankment',
};

/**
 * Cost per metre of length for a 1 m high structure, 2026 USD; cost/m = base × height^HEIGHT_EXPONENT. [I]
 *  • US: earthen ≈ $2,500, floodwall ≈ $6,000 — calibrated so a 1.5 m urban wall comes to ≈ $10k/m, matching Fargo's
 *    2017 planning range of $2,600–5,000 per linear ft incl. 30 % contingency (download.fargond.gov). Gabion: no US
 *    figure, the floodwall base is used.
 *  • South Asia (Nepal, India): earthen ≈ $90, gabion ≈ $170 — from Nepali embankment tenders (NPR 15,000/m earthen,
 *    30,000–35,000/m gabion-faced, ~1.5 m high; dialogue.earth 2018). Floodwall: no figure, ×2 gabion is used [I].
 * Elsewhere: the US figures (no regional table). Shown with a ±50 % band.
 */
export const MITIGATION_BASE_USD_PER_M: Readonly<Record<'US' | 'SA', Readonly<Record<MitigationType, number>>>> = {
  US: { earthen: 2500, floodwall: 6000, gabion: 6000 },
  SA: { earthen: 90, floodwall: 340, gabion: 170 },
};
export const MITIGATION_HEIGHT_EXPONENT = 1.3;
export const MITIGATION_COST_BAND = 0.5;

export function mitigationCost(type: MitigationType, lengthM: number, heightM: number, country: 'US' | 'IN' | 'NP' | null): { mid: number; low: number; high: number; perMetre: number } {
  const table = country === 'IN' || country === 'NP' ? MITIGATION_BASE_USD_PER_M.SA : MITIGATION_BASE_USD_PER_M.US;
  const perMetre = table[type] * Math.pow(Math.max(0, heightM), MITIGATION_HEIGHT_EXPONENT);
  const mid = perMetre * Math.max(0, lengthM);
  return { mid, low: mid * (1 - MITIGATION_COST_BAND), high: mid * (1 + MITIGATION_COST_BAND), perMetre };
}

/**
 * Length and mean height of the walls on the map, estimated from the barrier raster: a wall strip of length L and
 * width W has area A = L·W and (4-neighbour) perimeter P ≈ 2(L + W), so L = (s + √(s² − 4A)) / 2 with s = P/2. Exact
 * for straight grid-aligned walls; diagonal walls read up to ~40 % long (staircase perimeter), and several separate
 * walls are summed as one. The panel shows it as an editable estimate.
 */
export function wallGeometry(barrier: Float32Array, nx: number, ny: number, cellSize: number, minHeight = 0.2): { lengthM: number; meanHeightM: number; cells: number } {
  let cells = 0;
  let edges = 0;
  let hSum = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const b = barrier[c];
      if (!(b > minHeight)) continue;
      cells++;
      hSum += b;
      if (i === 0 || !(barrier[c - 1] > minHeight)) edges++;
      if (i === nx - 1 || !(barrier[c + 1] > minHeight)) edges++;
      if (j === 0 || !(barrier[c - nx] > minHeight)) edges++;
      if (j === ny - 1 || !(barrier[c + nx] > minHeight)) edges++;
    }
  }
  if (cells === 0) return { lengthM: 0, meanHeightM: 0, cells: 0 };
  const s = edges / 2;
  const disc = Math.max(0, s * s - 4 * cells);
  const L = (s + Math.sqrt(disc)) / 2;
  return { lengthM: L * cellSize, meanHeightM: hSum / cells, cells };
}
