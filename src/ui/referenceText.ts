/**
 * Words for the View panel's "Reference (N²)" control (src/ui/panel.ts), kept here — like stageText.ts and
 * routeText.ts — so the sentences can be tested without a DOM.
 *
 * The control has one job beyond drawing: never let the overlay imply a comparison it is not. So when the live
 * simulation has drifted out of the scenario the reference was computed for, this says so plainly AND says what would
 * bring it back, instead of quietly showing an outline that no longer means anything.
 *
 * Every number comes from AppState.reference, which the app fills from the shipped manifest — itself written from the
 * measured run (scripts/reference-run.ts). Nothing here is a hand-typed result.
 */
import type { ReferenceOverlayInfo } from '../contracts';
import { fmtNum } from './format';

/** "30:00", "6:05" — the sim clock the reference is a picture of, and the live run's own. */
export function referenceMinutes(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const pct = (v: number, digits = 1) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)}${' '}%`;

/** The control's title: "1024² live vs 4096² reference". */
export function referenceTitle(info: ReferenceOverlayInfo): string {
  return `${info.liveGrid}² live vs ${info.referenceGrid}² reference`;
}

/**
 * The measured agreement, as one line. Extent overlap first because it is the number the drawing shows: the outline
 * either hugs the live shoreline or it does not.
 */
export function referenceReadout(info: ReferenceOverlayInfo): string {
  const r = info.readout;
  return [
    `extent IoU ${(r.floodedIou * 100).toFixed(1)}${' '}%`,
    `flooded area ${pct(r.floodedPct)}`,
    `max-depth RMSE ${fmtNum(r.rmse, 2)}${' '}m`,
    `water held ${pct(r.waterHeldPct)}`,
  ].join('  ·  ');
}

/** What the line on screen means, once the overlay is on. */
export function referenceLegend(info: ReferenceOverlayInfo): string {
  return `The pale outline is where the ${info.referenceGrid}² run's flood reached ${fmtNum(info.readout.threshold, 2)} m, after ${referenceMinutes(info.seconds)} of ${info.label}.`;
}

/**
 * Why the reference cannot be drawn over what is on screen, and what to do about it. Returns null when it applies.
 * One sentence: this appears under a switch, not in a dialog.
 */
export function referenceRefusal(info: ReferenceOverlayInfo): string | null {
  if (info.applies) return null;
  const ft = info.stageFt;
  const at = referenceMinutes(info.seconds);
  const now = referenceMinutes(info.simTime);
  switch (info.mismatch) {
    case 'preset':
    case 'grid':
      return 'This reference was computed for another scene.';
    case 'naive':
      return 'The stability demo is running the naive solver, which is meant to be wrong.';
    case 'edits':
      return 'Walls or terrain edits make this a different flood. Reset all to compare again.';
    case 'rain':
      return info.scenarioRain === 0
        ? `Rain is falling; ${info.label} ran with none.`
        : `Rain does not match ${info.label} (${fmtNum(info.scenarioRain, 0)} mm/hr).`;
    case 'storms':
      return 'A storm cell is on the map; the reference run had none.';
    case 'stage':
      return ft === null
        ? `The river is not at the reference's stage (${info.label}).`
        : `Raise the river to ${fmtNum(ft, 0)} ft — the reference is ${info.label}.`;
    case 'rising':
      return 'The river is still rising to the crest.';
    case 'late-crest':
      return 'The river was raised late in this run, so the flood is at a different point in its spread. Reset the water and raise it again.';
    case 'friction':
      return "Manning's n has been changed from the reference run's.";
    case 'boundary':
      return 'The map edges are closed; the reference ran with open edges.';
    case 'early':
      return `Not yet: the reference is the flood after ${at}, and this run is at ${now}.`;
    case 'past':
      return `This run is at ${now}, past the reference's ${at} — the live flood has kept spreading since.`;
    default:
      return 'The reference does not apply to what is on screen.';
  }
}

/** Tooltip on the switch: the same claim, short. */
export function referenceTip(info: ReferenceOverlayInfo): string {
  return info.applies
    ? `Draw the ${info.referenceGrid}² reference run's flood edge over the live ${info.liveGrid}² simulation`
    : 'Not available in this state — see the note below';
}
