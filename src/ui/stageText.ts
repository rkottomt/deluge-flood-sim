/**
 * Wording for the river-stage control (pure, unit-tested).
 *
 * Presets carry a real gauge: a datum, a flood stage and historic crests, so the UI speaks in gauge feet
 * ("46.0 ft", "Raise to 1936 record"). Live areas only know the water surface detected at load; there is no gauge
 * and no historic crest, so the same control is described as a rise above that surface ("+10 m").
 */
import type { StageControl } from '../contracts';
import { fmtNum, formatRain, formatStageFt } from './format';
import { M_PER_FT, rainCategory, stageFt, stageRangeFt, stageStatus, type Severity } from './scales';

/** True when the control describes a real river gauge (flood stage or historic marks), not just a detected surface. */
export function hasGauge(ctrl: StageControl): boolean {
  return (ctrl.marks?.length ?? 0) > 0 || ctrl.floodStageFt !== undefined;
}

/** Rise above the normal level for a stage in feet, as shown for gauge-less controls: "+3.0 m". */
export function formatRise(ctrl: StageControl, ft: number): string {
  const m = Math.max(0, (ft - stageRangeFt(ctrl).min) * M_PER_FT);
  return `+${fmtNum(m, m >= 10 ? 0 : 1)} m`;
}

/** Slider / chip readout for a stage in feet: gauge feet, or the rise above the detected surface. */
export function formatStage(ctrl: StageControl, ft: number): string {
  return hasGauge(ctrl) ? formatStageFt(ft) : formatRise(ctrl, ft);
}

/** Secondary readout: the rise in feet for gauge-less controls ("33 ft"), nothing for gauges (already in feet). */
export function stageSub(ctrl: StageControl, ft: number): string {
  if (hasGauge(ctrl)) return '';
  return `${fmtNum(Math.max(0, ft - stageRangeFt(ctrl).min), 0)} ft`;
}

/** The Try-it strip's raise step: label and tooltip. */
export function raiseStepText(ctrl: StageControl, target: { ft: number; label: string }): { label: string; tip: string } {
  if (hasGauge(ctrl)) {
    return {
      label: `Raise to ${target.label}`,
      tip: `Raise the rivers to the ${target.label} (${fmtNum(target.ft, 1)} ft at the gauge) and fast-forward`,
    };
  }
  const m = (target.ft - stageRangeFt(ctrl).min) * M_PER_FT;
  return {
    label: `Raise water +${fmtNum(m, 0)} m`,
    tip: `Raise every river and lake ${fmtNum(m, 0)} m (${fmtNum(m / M_PER_FT, 0)} ft) above the level detected at load, and fast-forward`,
  };
}

const SEV_ORDER: Severity[] = ['calm', 'info', 'warn', 'danger'];
const maxSev = (a: Severity, b: Severity): Severity => (SEV_ORDER.indexOf(a) >= SEV_ORDER.indexOf(b) ? a : b);

/**
 * "Weather & rivers" section badge. It sits right above the stage slider, so a raised river is not "Dry": the
 * river (as it is now in the simulation) and the rain or strongest storm, whichever apply.
 */
export function weatherBadge(i: {
  rainRate: number;
  stormPeak: number;
  stage: StageControl | null;
  /** Offset currently applied in the simulation, m. */
  stageOffsetApplied: number;
}): { text: string; severity: Severity } {
  const parts: string[] = [];
  let severity: Severity = 'calm';
  const ctrl = i.stage;
  if (ctrl && i.stageOffsetApplied > 0.05) {
    const ft = stageFt(ctrl, i.stageOffsetApplied);
    parts.push(hasGauge(ctrl) ? `River ${fmtNum(ft, 0)} ft` : `Water ${formatRise(ctrl, ft)}`);
    severity = maxSev(severity, maxSev('info', stageStatus(ctrl, ft).severity));
  }
  const rain = Math.max(0, i.rainRate);
  const storm = Math.max(0, i.stormPeak);
  const v = Math.max(rain, storm);
  if (v > 0) {
    parts.push(storm > rain ? `Storm ${formatRain(storm)}` : formatRain(v));
    severity = maxSev(severity, rainCategory(v).severity);
  }
  return parts.length ? { text: parts.join(' · '), severity } : { text: 'Dry', severity: 'calm' };
}
