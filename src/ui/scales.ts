/**
 * Slider scales and domain knowledge used by the controls (pure, unit-tested).
 *
 * Native <input type=range> elements work on a linear "position" axis. Physical quantities that span
 * orders of magnitude (discharge, rain, brush radius) are mapped logarithmically onto that axis.
 */
import type { StageControl } from '../contracts';

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Logarithmic mapping value ∈ [min, max] ↔ t ∈ [0, 1]. */
export function logToT(v: number, min: number, max: number): number {
  if (!(v > 0)) return 0;
  return clamp(Math.log(v / min) / Math.log(max / min), 0, 1);
}
export function tToLog(t: number, min: number, max: number): number {
  return min * Math.pow(max / min, clamp(t, 0, 1));
}

/** "Nice" rounding for values chosen on a log slider so readouts don't show 137.2841 m³/s. */
export function niceRound(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return v;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag; // 1 … 10
  // 2 significant digits below 5, 1.5 steps above — keeps granularity roughly constant on a log axis.
  const q = n < 2 ? 0.05 : n < 5 ? 0.1 : 0.5;
  return Math.round(n / q) * q * mag;
}

// ─── Rain ──────────────────────────────────────────────────────────────────────────────────────
/**
 * Rain slider: position 0 is exactly "no rain"; the rest of the track is logarithmic 0.5 … 300 mm/hr.
 * A small dead zone at the left makes it easy to turn rain fully off by dragging to the end.
 */
export const RAIN_MIN = 0.5;
export const RAIN_MAX = 300;
const RAIN_ZERO_ZONE = 0.035;

export function rainToT(mmhr: number): number {
  if (!(mmhr > 0)) return 0;
  return RAIN_ZERO_ZONE + (1 - RAIN_ZERO_ZONE) * logToT(Math.max(mmhr, RAIN_MIN), RAIN_MIN, RAIN_MAX);
}
export function tToRain(t: number): number {
  if (t < RAIN_ZERO_ZONE * 0.5) return 0;
  const u = clamp((t - RAIN_ZERO_ZONE) / (1 - RAIN_ZERO_ZONE), 0, 1);
  return niceRound(tToLog(u, RAIN_MIN, RAIN_MAX));
}

/**
 * Labeled reference ticks for the rain slider. The track ends at 300 mm/hr, about the world record for
 * a single hour (305 mm, Holt, Missouri, 1947), so the last tick says so.
 */
export const RAIN_TICKS: Array<{ value: number; label: string }> = [
  { value: 2.5, label: 'Light' },
  { value: 10, label: 'Heavy' },
  { value: 50, label: 'Extreme' },
  { value: 100, label: 'Harvey' },
  { value: 300, label: 'Record' },
];

export type Severity = 'calm' | 'info' | 'warn' | 'danger';

export function rainCategory(mmhr: number): { label: string; severity: Severity } {
  if (!(mmhr > 0)) return { label: 'No rain', severity: 'calm' };
  if (mmhr <= 2.5) return { label: 'Light rain', severity: 'info' };
  if (mmhr < 10) return { label: 'Moderate rain', severity: 'info' };
  if (mmhr < 50) return { label: 'Heavy rain', severity: 'warn' };
  if (mmhr < 100) return { label: 'Extreme rain', severity: 'danger' };
  if (mmhr < 250) return { label: 'Harvey-class', severity: 'danger' };
  return { label: 'Record-class', severity: 'danger' };
}

/**
 * Short secondary readout for the rain slider: category plus inches per hour ("Harvey-class · 3.9 in/hr"). It has
 * to fit next to the value in the panel's slider head, so inches get one decimal from 1 in/hr up.
 */
export function rainSubLabel(mmhr: number): string {
  const cat = rainCategory(mmhr).label;
  if (!(mmhr > 0) || !Number.isFinite(mmhr)) return cat;
  const inches = mmhr / 25.4;
  const txt = inches >= 1 ? inches.toFixed(1) : inches >= 0.1 ? inches.toFixed(2) : inches.toFixed(3);
  return `${cat} · ${txt}\u00a0in/hr`;
}

// ─── Inflow discharge & storms ─────────────────────────────────────────────────────────────────
export const DISCHARGE_MIN = 10;
export const DISCHARGE_MAX = 20000;
export const DISCHARGE_TICKS: Array<{ value: number; label: string }> = [
  { value: 10, label: 'Creek' },
  { value: 300, label: 'River' },
  { value: 20000, label: 'Great flood' },
];

export const STORM_MIN = 5;
export const STORM_MAX = 300;
export const STORM_TICKS: Array<{ value: number; label: string }> = [
  { value: 10, label: 'Heavy' },
  { value: 50, label: 'Extreme' },
  { value: 150, label: 'Cloudburst' },
];

// ─── River stage ───────────────────────────────────────────────────────────────────────────────
export const M_PER_FT = 0.3048;

/** Displayed gauge stage in feet for a slider offset (meters above normal level). */
export function stageFt(ctrl: StageControl, offsetM: number): number {
  return (ctrl.normalLevel + offsetM - ctrl.gaugeDatum) / M_PER_FT;
}
/** Inverse of stageFt: offset in meters above normal level for a stage in feet. */
export function offsetForFt(ctrl: StageControl, ft: number): number {
  return ft * M_PER_FT + ctrl.gaugeDatum - ctrl.normalLevel;
}
export function stageRangeFt(ctrl: StageControl): { min: number; max: number } {
  return { min: stageFt(ctrl, 0), max: stageFt(ctrl, ctrl.maxOffset) };
}

/** Plain-language status for a stage reading. */
export function stageStatus(ctrl: StageControl, ft: number): { label: string; severity: Severity } {
  const marks = [...(ctrl.marks ?? [])].sort((a, b) => b.ft - a.ft);
  for (const m of marks) {
    if (ft >= m.ft - 0.05) return { label: `At or above ${m.label}`, severity: 'danger' };
  }
  if (ctrl.floodStageFt !== undefined) {
    if (ft >= ctrl.floodStageFt - 0.05) return { label: 'Above flood stage', severity: 'warn' };
    const below = ctrl.floodStageFt - ft;
    return { label: `${below.toFixed(1)} ft below flood stage`, severity: 'calm' };
  }
  return { label: ft > stageFt(ctrl, 0) + 0.05 ? 'Above normal pool' : 'Normal pool', severity: 'calm' };
}

// ─── Manning roughness ─────────────────────────────────────────────────────────────────────────
export const MANNING_MIN = 0.01;
export const MANNING_MAX = 0.15;
export function manningDescription(n: number): string {
  if (n < 0.016) return 'Smooth concrete / asphalt';
  if (n < 0.025) return 'Paved streets, clean channels';
  if (n < 0.045) return 'Natural river channel';
  if (n < 0.07) return 'Grass, light brush';
  if (n < 0.11) return 'Dense brush, urban blocks';
  return 'Forest, heavy obstructions';
}

// ─── Water depth hazard (for the probe) ────────────────────────────────────────────────────────
/**
 * Rough people/vehicle hazard classes from depth & speed, loosely following the UK DEFRA/EA
 * "hazard rating" HR = d·(v + 0.5) (debris factor omitted) and common vehicle-stability thresholds.
 */
export function waterHazard(depth: number, speed: number): { label: string; severity: Severity } {
  if (!(depth > 0.01)) return { label: 'Dry', severity: 'calm' };
  const hr = depth * (Math.max(0, speed) + 0.5);
  if (depth >= 0.6 || hr >= 1.25) return { label: 'Deadly — deep or fast water', severity: 'danger' };
  if (depth >= 0.3 || hr >= 0.75) return { label: 'Cars float · dangerous for all', severity: 'danger' };
  if (depth >= 0.15 || hr >= 0.3) return { label: 'Can knock people over', severity: 'warn' };
  return { label: 'Shallow · passable with care', severity: 'info' };
}

/** Log-scale brush slider helpers (meters). */
export function brushToT(m: number, min: number, max: number): number {
  return logToT(m, min, max);
}
export function tToBrush(t: number, min: number, max: number): number {
  const v = tToLog(t, min, max);
  return v >= 100 ? Math.round(v / 5) * 5 : v >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
}
