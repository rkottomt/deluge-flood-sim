import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ADVANCED_TOOL_IDS,
  TUTORIAL_STEPS,
  nextStepId,
  shouldAutoStartTutorial,
  stepIndex,
  type TutorialStepId,
} from '../../src/ui/tutorial';
import type { AppState } from '../../src/contracts';

test('tour has eight plain-language steps that cover looking, flooding, shelters, evac, levee and speed', () => {
  assert.deepEqual(
    TUTORIAL_STEPS.map((s) => s.id),
    ['welcome', 'look', 'raise', 'shelters', 'evac', 'levee', 'speed', 'done'],
  );
  for (const s of TUTORIAL_STEPS) {
    assert.ok(s.title.length <= 36, `${s.id} title is short`);
    assert.doesNotMatch(s.body, /GPU|CFL|Courant|WGSL|Float32|mass-balance/i, `${s.id} has no solver jargon`);
    assert.doesNotMatch(s.title, /GPU|CFL|solver/i, `${s.id} title is plain`);
  }
  assert.match(TUTORIAL_STEPS.find((s) => s.id === 'shelters')!.body, /green/i);
  assert.equal(TUTORIAL_STEPS[0].skip, 'Skip');
  assert.equal(nextStepId('done'), null);
  assert.equal(nextStepId('welcome'), 'look');
  assert.equal(stepIndex('speed'), 6);
});

test('auto-start: once per tab, off for automation, on with ?tutorial=1', () => {
  const base = { search: '', webdriver: false, storedDone: false };
  assert.equal(shouldAutoStartTutorial(base), true);
  assert.equal(shouldAutoStartTutorial({ ...base, storedDone: true }), false);
  assert.equal(shouldAutoStartTutorial({ ...base, webdriver: true }), false);
  assert.equal(shouldAutoStartTutorial({ ...base, search: '?preset=pittsburgh' }), true);
  assert.equal(shouldAutoStartTutorial({ ...base, search: '?tutorial=0' }), false);
  assert.equal(shouldAutoStartTutorial({ ...base, webdriver: true, storedDone: true, search: '?tutorial=1' }), true);
  assert.equal(shouldAutoStartTutorial({ ...base, storedDone: true, search: 'tutorial=1' }), true);
});

test('raise and evac steps complete from app state a non-technical user actually sees', () => {
  const raise = TUTORIAL_STEPS.find((s) => s.id === 'raise')!;
  const evac = TUTORIAL_STEPS.find((s) => s.id === 'evac')!;
  const idle = { stageOffset: 0, evacStart: null } as Pick<AppState, 'stageOffset' | 'evacStart'>;
  assert.equal(raise.done!(idle as AppState), false);
  assert.equal(raise.done!({ ...idle, stageOffset: 4 } as AppState), true);
  assert.equal(evac.done!(idle as AppState), false);
  assert.equal(evac.done!({ ...idle, evacStart: { gx: 10, gy: 10 } } as AppState), true);
});

test('advanced tools stay off the first-run toolbar', () => {
  assert.deepEqual([...ADVANCED_TOOL_IDS], ['inflow', 'storm', 'water', 'dig']);
  const ids: TutorialStepId[] = TUTORIAL_STEPS.map((s) => s.id);
  assert.ok(ids.includes('shelters'));
});
