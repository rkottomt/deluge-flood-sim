/**
 * What the View panel's "Reference (4096²)" control SAYS (src/ui/referenceText.ts).
 *
 * The overlay's one risk is implying a comparison it is not making, so these assert the refusal path hardest: every
 * reason a live simulation can drift out of the reference's scenario produces a specific sentence that names what to
 * change, and the readout only ever appears when the comparison is real.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReferenceMismatch, ReferenceOverlayInfo } from '../../src/contracts';
import {
  referenceLegend,
  referenceMinutes,
  referenceReadout,
  referenceRefusal,
  referenceTip,
  referenceTitle,
} from '../../src/ui/referenceText';

/** The shipped Pittsburgh reference, as the app publishes it. */
const info = (patch: Partial<ReferenceOverlayInfo> = {}): ReferenceOverlayInfo => ({
  referenceGrid: 4096,
  liveGrid: 1024,
  seconds: 1800,
  simTime: 1800,
  label: 'the 1936 crest (46 ft)',
  stageFt: 46,
  scenarioRain: 0,
  readout: {
    threshold: 0.15,
    floodedIou: 0.9804998286134571,
    floodedPct: -0.915086547968023,
    extentIou: 0.988735445568883,
    extentPct: -0.49956741757868733,
    waterHeldPct: 0.10900575407612367,
    rmse: 0.2878681356757613,
    medianAbs: 0.06046628952026367,
    p99Abs: 1.2758731842041016,
  },
  applies: true,
  mismatch: null,
  ready: true,
  ...patch,
});

test('the readout is the measurement, rounded but not rewritten', () => {
  const s = referenceReadout(info());
  assert.equal(referenceTitle(info()), '1024² live vs 4096² reference');
  // Numbers and units are joined with the app's no-break space (src/ui/format.ts), never a plain one.
  const N = '\u00a0';
  assert.match(s, new RegExp(`extent IoU 98\\.0${N}%`));
  assert.match(s, new RegExp(`flooded area −0\\.9${N}%`));
  assert.match(s, new RegExp(`max-depth RMSE 0\\.29${N}m`));
  assert.match(s, new RegExp(`water held \\+0\\.1${N}%`));
  // A minus sign, not a hyphen, and an explicit + on a positive difference: the sign is the whole point.
  assert.ok(!s.includes('-0.9'), 'uses a real minus sign');
  // The legend states what the line IS, including the threshold and the moment it is a picture of.
  const legend = referenceLegend(info());
  assert.match(legend, /4096² run's flood reached 0\.15\u00a0m/);
  assert.match(legend, /after 30:00 of the 1936 crest \(46 ft\)/);
  assert.equal(referenceRefusal(info()), null, 'nothing to explain while it applies');
  assert.match(referenceTip(info()), /4096² reference run's flood edge over the live 1024²/);
});

test('every refusal names what is wrong and what would fix it', () => {
  const expected: Array<[ReferenceMismatch, RegExp]> = [
    ['preset', /another scene/],
    ['grid', /another scene/],
    ['naive', /naive solver/],
    ['edits', /Walls or terrain edits.*Reset all/s],
    ['rain', /Rain is falling; the 1936 crest \(46 ft\) ran with none\./],
    ['storms', /storm cell/],
    ['stage', /Raise the river to 46 ft/],
    ['rising', /still rising/],
    ['late-crest', /raised late.*Reset the water/s],
    ['friction', /Manning's n/],
    ['boundary', /edges are closed/],
    ['early', /Not yet: the reference is the flood after 30:00, and this run is at 11:40\./],
    ['past', /This run is at 36:40, past the reference's 30:00/],
  ];
  for (const [mismatch, re] of expected) {
    const simTime = mismatch === 'past' ? 2200 : 700;
    const text = referenceRefusal(info({ applies: false, mismatch, simTime }));
    assert.ok(text, `${mismatch} must explain itself`);
    assert.match(text, re, `${mismatch}: "${text}"`);
    assert.ok(text.length < 160, `${mismatch}: too long for a switch caption (${text.length} chars)`);
    assert.ok(/[.!]$/.test(text), `${mismatch}: reads as a sentence`);
  }
  // A case with no gauge (a scenario the reference ran at normal pool) must not invent a stage to ask for.
  const rainy = info({ applies: false, mismatch: 'stage', stageFt: null, label: '100 mm/hr rain, river at normal pool' });
  assert.match(referenceRefusal(rainy)!, /not at the reference's stage \(100 mm\/hr rain, river at normal pool\)/);
  const rainy2 = info({ applies: false, mismatch: 'rain', scenarioRain: 100, label: '100 mm/hr rain, river at normal pool' });
  assert.match(referenceRefusal(rainy2)!, /100 mm\/hr/);
  // An unknown reason from a newer build still refuses rather than showing a comparison.
  const unknown = referenceRefusal(info({ applies: false, mismatch: 'something-else' as ReferenceMismatch }));
  assert.match(unknown!, /does not apply/);
  assert.match(referenceTip(info({ applies: false, mismatch: 'rain' })), /Not available in this state/);
});

test('the sim clock is stated in minutes:seconds, the way the reference is labelled', () => {
  assert.equal(referenceMinutes(1800), '30:00');
  assert.equal(referenceMinutes(0), '0:00');
  assert.equal(referenceMinutes(65.4), '1:05');
  assert.equal(referenceMinutes(-5), '0:00');
  assert.equal(referenceMinutes(3725), '62:05');
});
