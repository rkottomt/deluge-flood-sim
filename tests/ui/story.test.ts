/**
 * Narrated stories (src/story): the strict schema validator, the live caption tokens, the `?story=` link parser and
 * how it drives the startup scene, the beat scheduler (with fake timers), and the bundled stories' references into
 * their presets' data (every station, levee and gauge a story uses must exist there).
 *
 * Run: node --import tsx --test tests/ui/story.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseStartupRequest, storyMatches } from '../../src/app/url';
import { isPresetId, listPresets } from '../../src/data/presets';
import { captionTokens, NO_VALUE, resolveCaption } from '../../src/story/captions';
import { parseStoryParam, STORIES, storiesForPreset, storyById, STORY_WARNING, USE_CASE_STORIES } from '../../src/story/registry';
import { holdMs, StoryRunner, waitCapMs, type RunnerEnv } from '../../src/story/runner';
import { DEFAULT_MAX_WAIT_MS, type Beat, type Story } from '../../src/story/types';
import { validateStory } from '../../src/story/validate';
import { shouldAutoStartTutorial } from '../../src/ui/tutorial';

const PRESETS = listPresets().map((p) => p.id);
const json = (rel: string) => JSON.parse(readFileSync(new URL(`../../public/presets/${rel}`, import.meta.url), 'utf8'));

// ─── Schema ─────────────────────────────────────────────────────────────────────────────────────────────────────

test('story: every bundled story validates, on a preset that exists', () => {
  assert.ok(STORIES.length >= 5);
  for (const s of STORIES) {
    const r = validateStory(s, { presets: PRESETS });
    assert.deepEqual(r.errors, [], s.id);
    assert.ok(isPresetId(s.preset), s.id);
  }
  assert.deepEqual(
    STORIES.map((s) => s.preset).sort(),
    ['chamoli', 'chungthang', 'houston', 'nepal', 'pittsburgh'],
  );
});

const minimal = (): Story => ({
  id: 'demo',
  preset: 'pittsburgh',
  title: 'T',
  subtitle: 'S',
  summary: 'Sum',
  beats: [
    { id: 'a', caption: 'One', source: 'Src', durationMs: 2000 },
    { id: 'b', caption: 'Two', source: 'Src', durationMs: 2000 },
  ],
});
const withBeat = (patch: Record<string, unknown>) => {
  const s = minimal();
  (s.beats as unknown[])[0] = { ...s.beats[0], ...patch };
  return s;
};
const errorsOf = (v: unknown) => validateStory(v, { presets: PRESETS }).errors.join(' | ');

test('story validator: a minimal story passes', () => {
  assert.deepEqual(validateStory(minimal(), { presets: PRESETS }), { ok: true, errors: [] });
});

test('story validator: rejects the wrong shapes, strictly', () => {
  assert.match(errorsOf(null), /must be an object/);
  assert.match(errorsOf({ ...minimal(), id: 'Bad Id' }), /story\.id/);
  assert.match(errorsOf({ ...minimal(), preset: 'atlantis' }), /unknown preset/);
  assert.match(errorsOf({ ...minimal(), extra: 1 }), /unknown key "extra"/);
  assert.match(errorsOf({ ...minimal(), beats: [minimal().beats[0]] }), /2–30 beats/);
  assert.match(errorsOf(withBeat({ untill: { kind: 'route' } })), /unknown key "untill"/);
  assert.match(errorsOf(withBeat({ id: 'b' })), /duplicate beat id/);
  assert.match(errorsOf(withBeat({ durationMs: 10 })), /durationMs/);
  assert.match(errorsOf(withBeat({ durationMs: 2500.5 })), /durationMs/);
  assert.match(errorsOf(withBeat({ caption: 'x'.repeat(400) })), /longer than 360/);
  assert.match(errorsOf(withBeat({ caption: 'evil ‮ text' })), /control or bidi/);
  assert.match(errorsOf(withBeat({ caption: 'line\nbreak' })), /control or bidi/);
  assert.match(errorsOf(withBeat({ source: '' })), /source: must be a non-empty string/);
  assert.match(errorsOf(withBeat({ maxWaitMs: 1000 })), /only makes sense with until/);
});

test('story validator: actions, waits, cameras and highlights are closed sets', () => {
  assert.match(errorsOf(withBeat({ actions: [{ kind: 'nuke' }] })), /unknown action "nuke"/);
  assert.match(errorsOf(withBeat({ actions: [{ kind: 'raiseStage' }] })), /feet/);
  assert.match(errorsOf(withBeat({ actions: [{ kind: 'play', speed: -1 }] })), /speed/);
  assert.match(errorsOf(withBeat({ actions: [{ kind: 'waterView', mode: 'xray' }] })), /mode: must be one of/);
  assert.match(errorsOf(withBeat({ actions: [{ kind: 'panel', section: 'secret' }] })), /section: must be one of/);
  assert.match(errorsOf(withBeat({ actions: [{ kind: 'useCase', id: 'other' }] })), /id: must be one of/);
  assert.match(errorsOf(withBeat({ actions: new Array(9).fill({ kind: 'pause' }) })), /at most 8/);
  assert.match(errorsOf(withBeat({ until: { kind: 'forever' } })), /unknown wait/);
  assert.match(errorsOf(withBeat({ until: { kind: 'chainTime', t: -5 } })), /\.t: must be a number/);
  assert.match(errorsOf(withBeat({ camera: { kind: 'orbit' } })), /camera\.kind/);
  assert.match(errorsOf(withBeat({ camera: { kind: 'at', lat: 95, lon: 0, distance: 100 } })), /lat/);
  assert.match(errorsOf(withBeat({ camera: { kind: 'scenario', zoom: 10 } })), /zoom/);
  assert.match(errorsOf(withBeat({ camera: { kind: 'levee', distance: 100 } })), /unknown key "distance"/);
  assert.match(errorsOf(withBeat({ highlight: [{ kind: 'ui', target: 'body' }] })), /target: must be one of/);
  assert.match(errorsOf(withBeat({ highlight: [{ kind: 'selector', css: '*' }] })), /unknown highlight/);
  assert.match(errorsOf(withBeat({ highlight: [{ kind: 'pin', lat: 1, lon: 2 }] })), /label/);
  // A valid beat with everything in it.
  const full = withBeat({
    kicker: '09:15',
    camera: { kind: 'station', station: 'Betrawati', distance: 1500, pitch: 0.7, seconds: 2, orbitDeg: 10 },
    actions: [{ kind: 'release', speed: 300 }, { kind: 'waterView', mode: 'default' }, { kind: 'panel', section: null }],
    until: { kind: 'station', station: 'Betrawati', after: 30 },
    maxWaitMs: 60000,
    highlight: [{ kind: 'stationPin', station: 'Betrawati', label: 'Bridge' }, { kind: 'ui', target: 'timeline' }],
  });
  assert.deepEqual(validateStory(full, { presets: PRESETS }).errors, []);
});

test('story validator: caption tokens must be known and well-formed', () => {
  assert.match(errorsOf(withBeat({ caption: 'At {when}' })), /unknown token \{when\}/);
  assert.match(errorsOf(withBeat({ caption: 'At {front}' })), /needs an argument/);
  assert.match(errorsOf(withBeat({ caption: 'At {now:x}' })), /takes no argument/);
  assert.equal(errorsOf(withBeat({ caption: 'At {front:Betrawati}, now {now}, gauge {stage}, {kept}, {simtime}' })), '');
});

// ─── Captions ───────────────────────────────────────────────────────────────────────────────────────────────────

test('captions: tokens resolve to text; missing values show a dash; other braces stay', () => {
  assert.deepEqual(
    captionTokens('a {now} b {front:Betrawati 2-D domain (north edge)}').map((t) => [t.name, t.arg]),
    [
      ['now', null],
      ['front', 'Betrawati 2-D domain (north edge)'],
    ],
  );
  const out = resolveCaption('Front {front:X} at {now}; kept {kept}; {braces} stay', (name, arg) => (name === 'front' ? `09:46 (${arg})` : name === 'now' ? '09:40 NPT' : null));
  assert.equal(out, `Front 09:46 (X) at 09:40 NPT; kept ${NO_VALUE}; {braces} stay`);
  // A resolver that throws is a missing value, not a broken caption.
  assert.equal(resolveCaption('{stage}', () => {
    throw new Error('x');
  }), NO_VALUE);
});

// ─── ?story= links ──────────────────────────────────────────────────────────────────────────────────────────────

test('story link: exactly the bundled ids are accepted', () => {
  for (const s of STORIES) assert.deepEqual(parseStoryParam(`?story=${s.id}`), { story: s.id, warnings: [] });
  assert.deepEqual(parseStoryParam(''), { story: null, warnings: [] });
  assert.deepEqual(parseStoryParam('?story='), { story: null, warnings: [] });
});

test('story link: anything else is dropped with a fixed sentence that never echoes the value', () => {
  const hostile = ['NEPAL-2026', 'nepal-2026 ', ' nepal-2026', 'nepal-2026<script>', '<img src=x onerror=alert(1)>', 'EVACUATE NOW call 555-0100', 'x'.repeat(5000), 'nepal‮2026', '../nepal-2026'];
  for (const v of hostile) {
    const r = parseStoryParam(`?story=${encodeURIComponent(v)}`);
    assert.equal(r.story, null, v.slice(0, 40));
    assert.deepEqual(r.warnings, [STORY_WARNING]);
  }
  assert.doesNotMatch(STORY_WARNING, /EVACUATE|555|<|onerror|script/);
});

test('story link: opens the story’s own preset, ahead of ?usecase=, ?live= and ?preset=', () => {
  assert.deepEqual(parseStartupRequest('?story=nepal-2026'), { request: { kind: 'preset', id: 'nepal' }, warnings: [] });
  assert.deepEqual(parseStartupRequest('?story=houston-harvey&preset=johnstown').request, { kind: 'preset', id: 'houston' });
  assert.deepEqual(parseStartupRequest('?story=chamoli-2021&usecase=site').request, { kind: 'preset', id: 'chamoli' });
  assert.deepEqual(parseStartupRequest('?story=sikkim-2023&live=40.44,-80.00,5').request, { kind: 'preset', id: 'chungthang' });
  const bad = parseStartupRequest('?story=%3Cb%3Ex%3C%2Fb%3E&preset=johnstown');
  assert.deepEqual(bad.request, { kind: 'preset', id: 'johnstown' });
  assert.deepEqual(bad.warnings, [STORY_WARNING]);
});

test('story link: kept in the address bar only on its own scene; it does not start the tour', () => {
  assert.equal(storyMatches('?story=nepal-2026', { kind: 'preset', id: 'nepal' }), true);
  assert.equal(storyMatches('?story=nepal-2026', { kind: 'preset', id: 'pittsburgh' }), false);
  assert.equal(storyMatches('?story=junk', { kind: 'preset', id: 'nepal' }), false);
  const base = { search: '', webdriver: false, storedDone: false };
  assert.equal(shouldAutoStartTutorial({ ...base, search: '?story=pittsburgh-1936' }), false);
});

test('story registry: lookups and the use-case mapping', () => {
  assert.equal(storyById('nope'), null);
  assert.equal(storyById(null), null);
  assert.deepEqual(storiesForPreset('nepal').map((s) => s.id), ['nepal-2026']);
  assert.deepEqual(storiesForPreset('johnstown'), []);
  for (const id of Object.values(USE_CASE_STORIES)) assert.ok(storyById(id), id);
});

// ─── The bundled stories against their presets' data ──────────────────────────────────────────────────────────

test('stories: every station, levee, gauge and evacuation a story uses exists in its preset', () => {
  for (const story of STORIES) {
    const meta = json(`${story.preset}/meta.json`);
    const sc = meta.scenario;
    const chain = sc.hazardChain ? json(`${story.preset}/${sc.hazardChain.profile}`) : null;
    const stations = new Set<string>((chain?.stations ?? []).map((s: { name: string }) => s.name));
    const inside = (lat: number, lon: number) => lon > meta.bounds.west && lon < meta.bounds.east && lat > meta.bounds.south && lat < meta.bounds.north;
    const names: string[] = [];
    for (const b of story.beats) {
      for (const t of captionTokens(b.caption)) if (t.name === 'front') names.push(t.arg!);
      if (b.camera?.kind === 'station') {
        names.push(b.camera.station);
        const st = chain?.stations.find((s: { name: string }) => s.name === (b.camera as { station: string }).station);
        assert.ok(st && inside(st.lat, st.lon), `${story.id}/${b.id}: camera station must be on the map`);
      }
      if (b.until?.kind === 'station') names.push(b.until.station);
      for (const hl of b.highlight ?? []) {
        if (hl.kind === 'station' || hl.kind === 'stationPin') names.push(hl.station);
        if (hl.kind === 'stationPin') {
          const st = chain?.stations.find((s: { name: string }) => s.name === hl.station);
          assert.ok(st && inside(st.lat, st.lon), `${story.id}/${b.id}: pinned station ${hl.station} must be on the map`);
        }
      }
      for (const a of b.actions ?? []) {
        if (a.kind === 'raiseStage') {
          assert.ok(sc.stage, `${story.id}: raiseStage needs a stage control`);
          assert.ok(sc.stage.marks.some((m: { ft: number }) => m.ft === a.feet), `${story.id}: ${a.feet} ft is a historic mark of the gauge`);
        }
        if (a.kind === 'levee') assert.ok(sc.levee && sc.stage, `${story.id}: levee needs the scenario's demo levee`);
        if (a.kind === 'release' || a.kind === 'replayUpstream') assert.ok(chain, `${story.id}: ${a.kind} needs a hazard chain`);
        if (a.kind === 'evacuate') assert.ok(sc.shelters.length > 0, `${story.id}: evacuate needs shelters`);
      }
      if (b.camera?.kind === 'levee') assert.ok(sc.levee?.camera, `${story.id}: levee camera`);
    }
    for (const n of names) assert.ok(stations.has(n), `${story.id}: station "${n}" is in ${story.preset}/chain.json`);
  }
});

test('stories: glacier stories tell the model’s timing honestly, and keep casualty figures off screen', () => {
  for (const id of ['nepal-2026', 'sikkim-2023', 'chamoli-2021']) {
    const s = storyById(id)!;
    const text = s.beats.map((b) => b.caption).join(' ');
    assert.match(text, /The model is (late|early)/, id);
    // Model times are live tokens, not typed numbers.
    assert.ok(s.beats.some((b) => /\{front:/.test(b.caption)), id);
    assert.doesNotMatch(text, /\b(dead|died|killed|deaths|missing)\b/i, id);
  }
  const nepal = storyById('nepal-2026')!.beats.map((b) => `${b.kicker ?? ''} ${b.caption}`).join(' ');
  for (const fact of ['08:37', '09:15', '9:20', 'Betrawati']) assert.ok(nepal.includes(fact), fact);
});

// ─── Scheduling ─────────────────────────────────────────────────────────────────────────────────────────────────

const flush = () => new Promise<void>((r) => setImmediate(r));

/** A RunnerEnv on a fake clock; `waits` are released by the test. */
function fakeEnv() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const log: string[] = [];
  const waits: Array<{ kind: string; release: () => void; signal: AbortSignal }> = [];
  let finished = 0;
  const pauses: boolean[] = [];
  const env: RunnerEnv = {
    enter: (i, b) => log.push(`enter ${i} ${b.id}`),
    act: async (a) => {
      log.push(`act ${a.kind}`);
      if (a.kind === 'levee') await flush();
      if (a.kind === 'evacuate') throw new Error('no roads');
    },
    waitUntil: (u, signal) =>
      new Promise<boolean>((resolve) => {
        const w = { kind: u.kind, release: () => resolve(true), signal };
        waits.push(w);
        signal.addEventListener('abort', () => resolve(false), { once: true });
      }),
    setTimer: (fn, ms) => {
      timers.set(++nextId, { at: now + ms, fn });
      return nextId;
    },
    clearTimer: (h) => void timers.delete(h as number),
    now: () => now,
    onPause: (p) => pauses.push(p),
    onFinish: () => void finished++,
    onError: (_e, a) => log.push(`error ${a.kind}`),
  };
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      await flush();
      let best: [number, { at: number; fn: () => void }] | null = null;
      for (const e of timers) if (e[1].at <= end && (!best || e[1].at < best[1].at)) best = e;
      if (!best) break;
      timers.delete(best[0]);
      now = best[1].at;
      best[1].fn();
    }
    now = end;
    await flush();
  }
  return { env, log, waits, advance, pauses, finished: () => finished, timers };
}

const beat = (id: string, durationMs: number, extra: Partial<Beat> = {}): Beat => ({ id, caption: id, source: 's', durationMs, ...extra });
const storyOf = (beats: Beat[]): Story => ({ id: 'test', preset: 'pittsburgh', title: 't', subtitle: 's', summary: 's', beats });

test('runner: holdMs and waitCapMs', () => {
  assert.equal(holdMs({ durationMs: 8000 }), 8000);
  assert.equal(holdMs({ durationMs: 8000 }, 0.05), 400);
  assert.equal(holdMs({ durationMs: 8000 }, NaN), 8000);
  assert.equal(waitCapMs({}), DEFAULT_MAX_WAIT_MS);
  assert.equal(waitCapMs({ maxWaitMs: 5000 }), 5000);
  assert.equal(waitCapMs({ maxWaitMs: 50_000 }, { maxWaitCapMs: 2000 }), 2000);
});

test('runner: beats advance after their reading time, actions run in order, then it finishes', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 1000, { actions: [{ kind: 'reset' }, { kind: 'play', speed: 300 }] }), beat('b', 2000), beat('c', 500)]), f.env);
  r.start();
  await f.advance(10);
  assert.deepEqual(f.log, ['enter 0 a', 'act reset', 'act play']);
  await f.advance(989);
  assert.equal(r.state.index, 0);
  await f.advance(2);
  assert.equal(r.state.index, 1);
  await f.advance(2000);
  assert.equal(r.state.index, 2);
  await f.advance(500);
  assert.equal(r.state.finished, true);
  assert.equal(f.finished(), 1);
  assert.deepEqual(f.log.filter((l) => l.startsWith('enter')), ['enter 0 a', 'enter 1 b', 'enter 2 c']);
});

test('runner: pace scales reading time', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 10_000), beat('b', 10_000)]), f.env, { pace: 0.1 });
  r.start();
  await f.advance(1001);
  assert.equal(r.state.index, 1);
});

test('runner: a beat waits for its `until` after its actions, and moves on when it holds', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 1000, { actions: [{ kind: 'levee' }], until: { kind: 'protection' } }), beat('b', 1000)]), f.env);
  r.start();
  await f.advance(5);
  assert.equal(f.waits.length, 1, 'wait starts once the (async) action is done');
  assert.equal(r.state.phase, 'waiting');
  await f.advance(5000);
  assert.equal(r.state.index, 0, 'reading time is over but the condition does not hold yet');
  f.waits[0].release();
  await f.advance(1);
  assert.equal(r.state.index, 1);
  assert.equal(r.state.timedOut, false);
});

test('runner: the wait gives up at its cap and the story carries on', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 1000, { until: { kind: 'route' }, maxWaitMs: 3000 }), beat('b', 1000)]), f.env);
  r.start();
  await f.advance(2999);
  assert.equal(r.state.index, 0);
  assert.equal(f.waits[0].signal.aborted, false);
  await f.advance(2);
  assert.equal(f.waits[0].signal.aborted, true);
  assert.equal(r.state.index, 1);
  // maxWaitCapMs (e2e, recordings) tightens every cap.
  const g = fakeEnv();
  const r2 = new StoryRunner(storyOf([beat('a', 100, { until: { kind: 'route' } }), beat('b', 100)]), g.env, { maxWaitCapMs: 500 });
  r2.start();
  await g.advance(501);
  assert.equal(r2.state.index, 1);
});

test('runner: pause stops both clocks and tells the environment; resume carries on where it was', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 1000), beat('b', 1000, { until: { kind: 'route' }, maxWaitMs: 2000 }), beat('c', 1000)]), f.env);
  r.start();
  await f.advance(600);
  r.pause();
  assert.deepEqual(f.pauses, [true]);
  await f.advance(10_000);
  assert.equal(r.state.index, 0, 'nothing moves while paused');
  assert.equal(r.state.paused, true);
  assert.equal(Math.round(r.state.holdRemainingMs), 400);
  r.resume();
  assert.deepEqual(f.pauses, [true, false]);
  await f.advance(401);
  assert.equal(r.state.index, 1);
  // The wait cap is paused too.
  await f.advance(1500);
  r.togglePause();
  await f.advance(60_000);
  assert.equal(r.state.index, 1);
  r.togglePause();
  await f.advance(501);
  assert.equal(r.state.index, 2);
});

test('runner: next / previous / seek abandon the beat in progress', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 5000), beat('b', 5000, { until: { kind: 'route' } }), beat('c', 5000)]), f.env);
  r.start();
  await f.advance(10);
  r.next();
  await f.advance(10);
  assert.equal(r.state.index, 1);
  const w = f.waits[0];
  r.next();
  await f.advance(10);
  assert.equal(w.signal.aborted, true, 'the wait of the abandoned beat is aborted');
  assert.equal(r.state.index, 2);
  r.prev();
  await f.advance(10);
  assert.equal(r.state.index, 1);
  r.seek(0);
  await f.advance(10);
  assert.equal(r.state.index, 0);
  r.prev();
  assert.equal(r.state.index, 0, 'previous on the first beat restarts it');
  // Next on the last beat ends the story; previous from the end replays the last beat.
  r.seek(2);
  r.next();
  assert.equal(r.state.finished, true);
  r.next();
  assert.equal(r.state.finished, true);
  r.prev();
  assert.equal(r.state.finished, false);
  assert.equal(r.state.index, 2);
  // Stale timers of abandoned beats never move the story.
  await f.advance(4990);
  assert.equal(r.state.index, 2);
});

test('runner: a failing action is reported and the story carries on; stop ends it silently', async () => {
  const f = fakeEnv();
  const r = new StoryRunner(storyOf([beat('a', 100, { actions: [{ kind: 'evacuate' }, { kind: 'pause' }] }), beat('b', 100)]), f.env);
  r.start();
  await f.advance(101);
  assert.deepEqual(f.log.slice(0, 4), ['enter 0 a', 'act evacuate', 'error evacuate', 'act pause']);
  assert.equal(r.state.index, 1);
  r.stop();
  await f.advance(1000);
  assert.equal(f.finished(), 0);
  assert.equal(f.timers.size, 0, 'no timer left behind');
});
