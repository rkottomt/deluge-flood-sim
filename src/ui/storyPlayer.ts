/**
 * Narrated story mode: plays a story (src/story) over the live simulation — a cinematic caption card with the beat's
 * facts and source, play / pause / previous / next / exit, a progress bar, labelled map pins and highlights — while the
 * runner (src/story/runner.ts) moves the camera and drives the simulation through the same paths the Try-it strip and
 * the use cases use.
 *
 * Entry points: "Watch the story" in the Scenario section (presets that have one), the stories row in Use cases, and
 * a `?story=<id>` link (src/story/registry.ts parses it strictly; src/app/url.ts loads its preset).
 *
 * Keys while a story plays: Space or K pause, → or L next, ← or J previous, Esc exit. They are taken before the app's
 * own shortcuts, so Space pauses the story (and with it the simulation), not just the simulation.
 *
 * Reduced motion (prefers-reduced-motion): camera moves are cuts, no slow orbit, no animated progress.
 *
 * Leaving a story puts the user's own scenario back when the scene is still the one it started on: the stage, rain,
 * time scale, evacuation start, water view, tool and play state as they were on play(), and the walls and digging —
 * a story clears walls and raises its demo levee, so the map's edits are stashed from the edit log on play() and, when
 * they differ at the end, the ground is reset and the user's edits replayed (recorded as theirs again; the water
 * restarts). The business stories also swap Site check's sites and Compare designs' designs for their own, and run a
 * sweep or a comparison: those panels' state is snapshotted too (storyHooks.ts) and put back, and a sweep or comparison
 * still running when the story ends is cancelled first, the user's state restored once it has stopped. A dam story's
 * scene is the live area its breach loads (damView.ts), so it has no earlier scene to go back to.
 * Another scene on screen keeps its own defaults. The one exception is the end card's *Explore on your
 * own*: that is an invitation to carry on from what the story set up (its levee, its raised river), so it keeps the
 * story's state; Esc, the close button and leaving mid-story restore.
 *
 * Offline: stories are bundled constant data; nothing is fetched beyond what the scene itself loads. Every string on
 * screen goes through textContent (h()/setText).
 */
import './story.css';
import type { AppState, CameraPose, TerrainData, WaterViewMode } from '../contracts';
import { editLogFor, replayEdits } from '../project/edits';
import type { ProjectEdit } from '../project/format';
import { makeGeoToGrid } from '../data/geo';
import type { ChainStation } from '../hazard/types';
import { resolveCaption, captionTokens, SITE_PARCELS, type BcaFact, type CaptionToken, type DamFact, type SiteFact } from '../story/captions';
import { isBusinessStory, parseStoryParam, sceneStory, STORIES, storyById, STORY_PARAM } from '../story/registry';
import { StoryRunner, holdMs, type RunnerEnv, type RunnerOptions, type RunnerState } from '../story/runner';
import type { Beat, CameraSpec, Highlight, SimAction, Story, UiTarget, UntilSpec } from '../story/types';
import { transformPoint4 } from '../render/math';
import { bridgeFor, postNotice } from './bridge';
import { storyHooksFor } from './storyHooks';
import { formatEventTime, formatSpan, formatWhen, parseEventClock } from './chainTime';
import { h, isTypingTarget, setText, toggleClass, type UIContext } from './dom';
import { fmtNum } from './format';
import { icon } from './icons';
import type { Panel } from './panel';
import { clamp, offsetForFt, stageFt } from './scales';
import { headlessBusy } from './headless';
import { formatStage } from './stageText';
import { selectTool } from './toolDefs';
import { planEvacuation } from './welcome';

/** Fixed selectors the `ui` highlight may point at (never a selector from data). */
const UI_SELECTORS: Record<UiTarget, string> = {
  timeline: '.dl-chainline',
  route: '.dl-route-chip',
  impact: '[data-section="impact"]',
  site: '[data-section="site"]',
  designs: '[data-section="designs"]',
  hud: '.dl-hud',
  tryit: '.dl-welcome',
};
const HL_CLASS = 'dl-nar-hl';
/** Caption refresh (live tokens, highlights re-applied after a re-render, progress), ms. */
const TICK_MS = 250;
/** Longest the player waits for a glacier scene's chain result before it starts anyway, ms. */
const CHAIN_WAIT_MS = 30_000;

/** What the user had on screen when a story started. */
interface UserSnapshot {
  terrain: TerrainData | null;
  stageOffset: number;
  rainRate: number;
  timeScale: number;
  evacStart: AppState['evacStart'];
  waterMode: WaterViewMode;
  tool: AppState['tool'];
  paused: boolean;
  edits: ProjectEdit[];
  /** Site check's sites and sweep, and Compare designs' designs and results (storyHooks.ts), as they were. */
  site: unknown;
  compare: unknown;
}

export interface StoryPlayOptions extends RunnerOptions {
  /** Start at this beat (0-based). */
  startAt?: number;
}

export interface StoryDebugState {
  storyId: string | null;
  index: number;
  total: number;
  beatId: string | null;
  paused: boolean;
  finished: boolean;
  phase: string;
  timedOut: boolean;
  kicker: string;
  caption: string;
  source: string;
}

export interface StoryPlayer {
  /** The caption card (mounted in the bottom notices column, above the valley timeline). */
  el: HTMLElement;
  /** Map pins layer (mounted over the canvas). */
  pinsEl: HTMLElement;
  /** "Watch the story" for the Scenario section; hidden on presets without a story. */
  watchButton: HTMLElement;
  /** A row of every story, for the Use cases modal. */
  storyRow(): HTMLElement;
  /** Load the story's preset if needed and play it. Resolves false if it could not start. */
  play(id: string, opts?: StoryPlayOptions): Promise<boolean>;
  stop(): void;
  isPlaying(): boolean;
  debugState(): StoryDebugState;
  /** The runner's controls (automation and the buttons share them). */
  next(): void;
  prev(): void;
  togglePause(): void;
}

interface PinNode {
  gx: number;
  gy: number;
  node: HTMLElement;
}

export function createStoryPlayer(
  ctx: UIContext,
  deps: { panel: Pick<Panel, 'reveal' | 'setOpen' | 'isOpen'>; applyUseCase(id: 'site' | 'glacier' | 'portfolio'): Promise<void>; root: HTMLElement },
): StoryPlayer {
  const { store } = ctx;
  const bridge = bridgeFor(store);
  const hooks = storyHooksFor(store);

  // ─── DOM ──────────────────────────────────────────────────────────────────────────────────────────────────────
  const titleEl = h('span', { class: 'dl-nar-title' });
  const subEl = h('span', { class: 'dl-nar-sub' });
  const countEl = h('span', { class: 'dl-nar-count', 'aria-live': 'off' });
  const prevBtn = h('button', { type: 'button', class: 'dl-icon-btn dl-nar-prev', 'aria-label': 'Previous beat', 'data-tip': 'Previous', 'data-tip-key': '←', 'data-tip-side': 'top', onclick: () => runner?.prev() }, icon('chevronRight', 16));
  const playBtn = h('button', { type: 'button', class: 'dl-icon-btn dl-nar-play', 'aria-label': 'Pause the story', 'data-tip-side': 'top', onclick: () => runner?.togglePause() });
  const nextBtn = h('button', { type: 'button', class: 'dl-icon-btn dl-nar-next', 'aria-label': 'Next beat', 'data-tip': 'Next', 'data-tip-key': '→', 'data-tip-side': 'top', onclick: () => runner?.next() }, icon('chevronRight', 16));
  const closeBtn = h('button', { type: 'button', class: 'dl-icon-btn dl-nar-close', 'aria-label': 'Exit the story', 'data-tip': 'Exit', 'data-tip-key': 'Esc', 'data-tip-side': 'top', onclick: () => stop() }, icon('close', 16));
  const kickerEl = h('div', { class: 'dl-nar-kicker' });
  const captionEl = h('p', { class: 'dl-nar-caption', 'aria-live': 'polite' });
  const sourceEl = h('p', { class: 'dl-nar-source' });
  const progress = h('div', { class: 'dl-nar-progress', role: 'group', 'aria-label': 'Beats' });
  const againBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-primary dl-btn-sm', onclick: () => current && void play(current.id, lastOpts) }, icon('reset', 14), h('span', null, 'Watch again'));
  const exploreBtn = h('button', { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm', onclick: () => stop(false) }, h('span', null, 'Explore on your own'));
  const endRow = h('div', { class: 'dl-nar-end', hidden: true }, againBtn, exploreBtn);

  const el = h(
    'section',
    { class: 'dl-nar dl-glass', role: 'region', 'aria-label': 'Narrated story', hidden: true },
    h('div', { class: 'dl-nar-head' }, h('span', { class: 'dl-nar-badge' }, icon('play', 12), 'Story'), titleEl, subEl, h('span', { class: 'dl-flex' }), countEl, prevBtn, playBtn, nextBtn, closeBtn),
    kickerEl,
    captionEl,
    sourceEl,
    endRow,
    progress,
  );
  el.inert = true;
  const pinsEl = h('div', { class: 'dl-nar-pins', 'aria-hidden': 'true' });

  // ─── State ────────────────────────────────────────────────────────────────────────────────────────────────────
  let current: Story | null = null;
  let runner: StoryRunner | null = null;
  let lastOpts: StoryPlayOptions = {};
  let beat: Beat | null = null;
  let segs: HTMLButtonElement[] = [];
  let tick = 0;
  let orbitTimer = 0;
  let pins: PinNode[] = [];
  let pinRaf = 0;
  /** The story paused the simulation (so resuming the story resumes it). */
  let pausedSim = false;
  let panelWasOpen = false;
  let startToken = 0;
  /** The user's state when the story started (header: restored on stop on the same scene). */
  let saved: UserSnapshot | null = null;

  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const terrain = () => bridge.scene?.getTerrain() ?? null;
  const camera = () => bridge.scene?.getCamera?.() ?? null;
  const simClock = () => bridge.sim?.simClock() ?? 0;
  const chainClock = () => {
    const c = bridge.chain;
    return c?.file ? parseEventClock(c.file.clockZero) : null;
  };
  const chainNow = () => (bridge.chain ? bridge.chain.offset + simClock() : null);
  const station = (name: string): ChainStation | null => bridge.chain?.file?.stations.find((s) => s.name === name) ?? null;
  const stationFront = (name: string): number | null => {
    const st = bridge.chain?.result?.stations.find((s) => s.name === name);
    return st && Number.isFinite(st.tFront) ? st.tFront : null;
  };

  // ─── Caption tokens ───────────────────────────────────────────────────────────────────────────────────────────
  const resolveToken = (name: CaptionToken, arg: string | null): string | null => {
    const s = store.get();
    switch (name) {
      case 'now': {
        const t = chainNow();
        const clock = chainClock();
        if (t !== null && clock) return formatEventTime(clock, t);
        return `T+${formatSpan(simClock())}`;
      }
      case 'simtime':
        return formatSpan(simClock());
      case 'front': {
        const t = arg ? stationFront(arg) : null;
        return t === null ? null : formatWhen(chainClock(), t);
      }
      case 'stage': {
        const ctrl = s.scenario?.stage;
        return ctrl ? formatStage(ctrl, stageFt(ctrl, s.stageOffsetApplied)) : null;
      }
      case 'kept': {
        const p = bridge.protection;
        if (!p) return null;
        if (!(p.areaM2 >= 1000)) return 'nothing yet';
        const acres = p.areaM2 / 4046.8564224;
        const km = p.roadMeters / 1000;
        return `${fmtNum(acres, acres >= 100 ? 0 : 1)} acres${km >= 0.1 ? ` and ${fmtNum(km, km >= 10 ? 0 : 1)} km of streets` : ''}`;
      }
      case 'site': {
        const [p, f] = (arg ?? '').split('.') as [string, SiteFact];
        const i = (SITE_PARCELS as readonly string[]).indexOf(p);
        return i >= 0 ? (hooks.site?.fact(i, f) ?? null) : null;
      }
      case 'bca':
        return hooks.compare?.fact(arg as BcaFact) ?? null;
      case 'dam':
        return hooks.dam?.fact(arg as DamFact) ?? null;
      case 'arrival':
        return arg ? (hooks.dam?.arrival(Number(arg)) ?? null) : null;
    }
    return null;
  };

  // ─── Rendering ────────────────────────────────────────────────────────────────────────────────────────────────
  function buildProgress(story: Story) {
    segs = story.beats.map((b, i) =>
      h(
        'button',
        { type: 'button', class: 'dl-nar-seg', 'aria-label': `Beat ${i + 1}: ${b.kicker ?? b.id}`, 'data-beat': b.id, onclick: () => runner?.seek(i) },
        h('span', { class: 'dl-nar-seg-fill' }),
      ),
    );
    progress.replaceChildren(...segs);
  }

  function renderState(st: RunnerState) {
    const playing = !st.paused && !st.finished;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 16));
    playBtn.setAttribute('aria-label', playing ? 'Pause the story' : 'Play the story');
    playBtn.dataset.tip = playing ? 'Pause' : 'Play';
    playBtn.dataset.tipKey = 'Space';
    playBtn.disabled = st.finished;
    nextBtn.disabled = st.finished;
    setText(countEl, st.finished ? 'The end' : `${st.index + 1} / ${st.total}`);
    el.dataset.state = st.finished ? 'finished' : st.paused ? 'paused' : st.phase;
    el.dataset.beat = beat?.id ?? '';
    endRow.hidden = !st.finished;
    toggleClass(el, 'dl-nar-finished', st.finished);
    segs.forEach((seg, i) => {
      toggleClass(seg, 'dl-done', st.finished || i < st.index);
      toggleClass(seg, 'dl-now', !st.finished && i === st.index);
      if (i !== st.index || st.finished) (seg.firstChild as HTMLElement).style.width = '';
    });
    if (st.finished) {
      setText(kickerEl, current?.subtitle ?? '');
      setText(captionEl, 'That is the story. The simulation is still live: drag to look around, or change anything in the panel.');
      setText(sourceEl, '');
      clearHighlights();
      setPins([]);
    }
  }

  function refresh() {
    if (!runner || !beat) return;
    const st = runner.state;
    if (!st.finished) {
      if (captionTokens(beat.caption).length) setText(captionEl, resolveCaption(beat.caption, resolveToken));
      applyHighlights(beat.highlight ?? [], false);
      const seg = segs[st.index];
      const total = holdMs(beat, lastOpts.pace);
      if (seg && total > 0) {
        const done = 1 - st.holdRemainingMs / total;
        (seg.firstChild as HTMLElement).style.width = `${Math.round(clamp(done, 0, 1) * 100)}%`;
      }
    }
  }

  // ─── Highlights and pins ──────────────────────────────────────────────────────────────────────────────────────
  function clearHighlights() {
    document.querySelectorAll(`.${HL_CLASS}`).forEach((n) => n.classList.remove(HL_CLASS));
  }

  function applyHighlights(list: Highlight[], rebuildPins: boolean) {
    const want = new Set<Element>();
    const pinSpecs: Array<{ lat: number; lon: number; label: string }> = [];
    for (const hl of list) {
      if (hl.kind === 'ui') {
        const n = document.querySelector(UI_SELECTORS[hl.target]);
        if (n) want.add(n);
      } else if (hl.kind === 'station') {
        const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(hl.station) : hl.station.replace(/["\\]/g, '\\$&');
        const n = document.querySelector(`.dl-cl-chipbox[data-station="${esc}"]`);
        if (n) want.add(n);
      } else if (hl.kind === 'stationPin') {
        const st = station(hl.station);
        if (st) pinSpecs.push({ lat: st.lat, lon: st.lon, label: hl.label ?? st.name });
      } else if (hl.kind === 'pin') {
        pinSpecs.push({ lat: hl.lat, lon: hl.lon, label: hl.label });
      }
    }
    document.querySelectorAll(`.${HL_CLASS}`).forEach((n) => {
      if (!want.has(n)) n.classList.remove(HL_CLASS);
    });
    want.forEach((n) => n.classList.add(HL_CLASS));
    if (rebuildPins || (pinSpecs.length && !pins.length)) setPins(pinSpecs);
  }

  function setPins(specs: Array<{ lat: number; lon: number; label: string }>) {
    const t = terrain();
    pins = [];
    if (t) {
      const toGrid = makeGeoToGrid(t);
      for (const p of specs) {
        const [gx, gy] = toGrid(p.lon, p.lat);
        if (!(gx >= 0 && gy >= 0 && gx < t.nx && gy < t.ny)) continue;
        pins.push({ gx, gy, node: h('div', { class: 'dl-nar-pin' }, h('span', { class: 'dl-nar-pin-dot' }), h('span', { class: 'dl-nar-pin-label' }, p.label)) });
      }
    }
    pinsEl.replaceChildren(...pins.map((p) => p.node));
    if (pins.length && !pinRaf) pinRaf = requestAnimationFrame(drawPins);
  }

  type MatrixCamera = { matrices(aspect: number): { viewProj: ArrayLike<number> } };
  function drawPins() {
    pinRaf = 0;
    if (!pins.length) return;
    const cam = camera() as (ReturnType<typeof camera> & Partial<MatrixCamera>) | null;
    const t = terrain();
    const canvas = document.getElementById('deluge-canvas') as HTMLCanvasElement | null;
    if (cam && typeof cam.matrices === 'function' && t && canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        try {
          const vp = cam.matrices(rect.width / rect.height).viewProj;
          const ex = store.get().render.verticalExaggeration;
          for (const p of pins) {
            const i = Math.min(t.nx - 1, Math.max(0, Math.floor(p.gx)));
            const j = Math.min(t.ny - 1, Math.max(0, Math.floor(p.gy)));
            const X = (p.gx - t.nx / 2) * t.cellSize;
            const Z = (p.gy - t.ny / 2) * t.cellSize;
            const Y = (t.elevation[j * t.nx + i] + 2) * ex;
            const [cx, cy, , cw] = transformPoint4(vp, X, Y, Z, 1);
            const sx = rect.left + ((cx / cw + 1) / 2) * rect.width;
            const sy = rect.top + ((1 - cy / cw) / 2) * rect.height;
            const off = !(cw > 0) || sx < rect.left || sx > rect.right || sy < rect.top || sy > rect.bottom;
            p.node.style.display = off ? 'none' : '';
            if (!off) p.node.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
          }
        } catch {
          /* renderer gone: try again next frame */
        }
      }
    }
    pinRaf = requestAnimationFrame(drawPins);
  }

  // ─── Camera ───────────────────────────────────────────────────────────────────────────────────────────────────
  function poseFor(spec: CameraSpec): CameraPose | null {
    const s = store.get();
    const cam = camera();
    const base = s.scenario?.camera ?? cam?.pose ?? null;
    const at = (lat: number, lon: number, distance: number, yaw?: number, pitch?: number): CameraPose | null => {
      const t = terrain();
      if (!t) return null;
      const [gx, gy] = makeGeoToGrid(t)(lon, lat);
      if (!(gx >= 0 && gy >= 0 && gx < t.nx && gy < t.ny)) return null;
      const elevation = t.elevation[Math.floor(gy) * t.nx + Math.floor(gx)];
      return { target: { gx, gy, elevation }, distance, yaw: yaw ?? base?.yaw ?? 0, pitch: pitch ?? base?.pitch ?? 0.7 };
    };
    switch (spec.kind) {
      case 'scenario':
        if (!base) return null;
        return {
          target: { ...base.target },
          distance: base.distance * (spec.zoom ?? 1),
          yaw: base.yaw + (spec.yawOffset ?? 0),
          pitch: spec.pitch ?? base.pitch,
        };
      case 'levee':
        return s.scenario?.levee?.camera ?? base;
      case 'frame':
        return null;
      case 'at':
        return at(spec.lat, spec.lon, spec.distance, spec.yaw, spec.pitch);
      case 'station': {
        const st = station(spec.station);
        return st ? at(st.lat, st.lon, spec.distance, spec.yaw, spec.pitch) : null;
      }
    }
  }

  function applyCamera(spec: CameraSpec, b: Beat) {
    clearTimeout(orbitTimer);
    const cam = camera();
    if (!cam) return;
    const reduced = reducedMotion();
    const seconds = reduced ? 0.01 : (spec.seconds ?? 1.6);
    try {
      if (spec.kind === 'frame') {
        cam.frameAll();
        return;
      }
      const pose = poseFor(spec);
      if (!pose) return;
      cam.flyTo(pose, seconds);
      if (spec.orbitDeg && !reduced) {
        const drift = Math.max(2, holdMs(b, lastOpts.pace) / 1000 - seconds);
        orbitTimer = window.setTimeout(() => {
          if (beat !== b) return;
          try {
            cam.flyTo({ ...pose, target: { ...pose.target }, yaw: pose.yaw + (spec.orbitDeg! * Math.PI) / 180 }, drift);
          } catch {
            /* renderer gone */
          }
        }, seconds * 1000 + 50);
      }
    } catch {
      /* renderer gone */
    }
  }

  // ─── Actions and waits ────────────────────────────────────────────────────────────────────────────────────────
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      const t = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
    });

  /** Poll `cond` until true (true), the signal aborts or `timeoutMs` passes (false). */
  async function poll(cond: () => boolean, signal: AbortSignal, timeoutMs = Infinity, stepMs = 150): Promise<boolean> {
    const t0 = performance.now();
    while (!signal.aborted) {
      try {
        if (cond()) return true;
      } catch {
        /* keep waiting */
      }
      if (performance.now() - t0 > timeoutMs) return false;
      await sleep(stepMs, signal);
    }
    return false;
  }

  /** A headless batch a beat started (a sweep, a comparison): stop() cancels it and restores the user's state after. */
  let jobRunning: Promise<void> | null = null;
  async function job(fn: () => Promise<boolean>, what: string): Promise<void> {
    const p = fn().then(
      (ok) => {
        if (!ok) console.warn(`[story] ${what} did not complete`);
      },
      (err) => console.warn(`[story] ${what} failed`, err),
    );
    jobRunning = p;
    try {
      await p;
    } finally {
      if (jobRunning === p) jobRunning = null;
    }
  }

  const setSpeed = (speed: number | undefined) => {
    const s = store.get();
    store.set({ paused: false, sim: speed ? { ...s.sim, timeScale: speed } : s.sim });
  };

  async function act(a: SimAction, _b: Beat, signal: AbortSignal): Promise<void> {
    const s = store.get();
    switch (a.kind) {
      case 'reset':
        ctx.actions.clearWalls();
        selectTool(store, 'orbit');
        store.set({ stageOffset: 0, evacStart: null, paused: true });
        ctx.actions.resetWater();
        return;
      case 'pause':
        store.set({ paused: true });
        return;
      case 'play':
        setSpeed(a.speed);
        return;
      case 'raiseStage': {
        const ctrl = s.scenario?.stage;
        if (!ctrl) return;
        store.set({ stageOffset: clamp(offsetForFt(ctrl, a.feet), 0, ctrl.maxOffset) });
        return;
      }
      case 'release':
        ctx.actions.resetWater();
        setSpeed(a.speed ?? 300);
        return;
      case 'levee': {
        const btn = document.querySelector<HTMLButtonElement>('.dl-try-step[data-step="levee"]');
        if (!btn || btn.hidden || !s.scenario?.levee) return;
        if (btn.getAttribute('aria-pressed') !== 'true') btn.click();
        await poll(() => btn.getAttribute('aria-pressed') === 'true', signal, 20_000);
        return;
      }
      case 'evacuate':
        await planEvacuation(ctx);
        if (!signal.aborted) selectTool(store, 'orbit');
        return;
      case 'waterView': {
        const mode: WaterViewMode = a.mode === 'default' ? (s.scenario?.defaultView ?? 'realistic') : a.mode;
        ctx.setRender({ waterMode: mode });
        return;
      }
      case 'rain':
        ctx.setSim({ rainRate: a.mmPerHour });
        return;
      case 'replayUpstream': {
        if (!(await poll(() => !!bridge.chain?.result, signal, 10_000))) return;
        const btn = document.querySelector<HTMLButtonElement>('.dl-cl-replay');
        if (btn && !btn.hidden) btn.click();
        return;
      }
      case 'useCase':
        await deps.applyUseCase(a.id);
        return;
      case 'demoSites':
        if (!hooks.site?.useDemoParcels()) console.warn('[story] the demo parcels could not be placed');
        return;
      case 'siteSweep':
        await job(() => hooks.site?.sweep() ?? Promise.resolve(false), 'the Site check sweep');
        return;
      case 'compare':
        await job(() => hooks.compare?.runWalls(a.levels, a.userRp ?? []) ?? Promise.resolve(false), 'the design comparison');
        return;
      case 'readArrivals':
        if (!(await hooks.dam?.readArrivals())) console.warn('[story] no downstream readout');
        return;
      case 'panel':
        if (a.section === null) deps.panel.setOpen(false);
        else deps.panel.reveal(a.section);
        return;
    }
  }

  function waitUntil(u: UntilSpec, signal: AbortSignal): Promise<boolean> {
    switch (u.kind) {
      case 'chainTime':
        return poll(() => (chainNow() ?? Infinity) >= u.t, signal);
      case 'station':
        return poll(() => {
          if (!bridge.chain?.result) return true; // no chain: nothing to wait for
          const tf = stationFront(u.station);
          return tf === null || (chainNow() ?? Infinity) >= tf + (u.after ?? 0);
        }, signal);
      case 'simTime':
        return poll(() => simClock() >= u.t, signal);
      case 'stageArrived':
        return poll(() => {
          const s = store.get();
          return !s.scenario?.stage || Math.abs(s.stageOffset - s.stageOffsetApplied) <= 0.01;
        }, signal);
      case 'protection':
        return poll(() => (bridge.protection?.areaM2 ?? 0) > 0, signal);
      case 'route':
        return poll(() => {
          const r = store.get().route;
          return !!r && (r.state === 'ok' || r.state === 'blocked');
        }, signal);
    }
  }

  // ─── Runner environment ───────────────────────────────────────────────────────────────────────────────────────
  const env: RunnerEnv = {
    enter(index, b) {
      beat = b;
      setText(kickerEl, b.kicker ?? '');
      setText(captionEl, resolveCaption(b.caption, resolveToken));
      setText(sourceEl, `Source: ${b.source}`);
      // Re-trigger the caption's entrance (CSS animation, off with reduced motion).
      el.classList.remove('dl-nar-enter');
      void el.offsetWidth;
      el.classList.add('dl-nar-enter');
      clearTimeout(orbitTimer);
      applyHighlights(b.highlight ?? [], true);
      if (b.camera) applyCamera(b.camera, b);
      void index;
    },
    act,
    waitUntil,
    setTimer: (fn, ms) => window.setTimeout(fn, ms),
    clearTimer: (t) => window.clearTimeout(t as number),
    now: () => performance.now(),
    onPause(paused) {
      // A sweep or comparison runs the simulation itself (headless.ts): pausing the story must not touch it.
      if (headlessBusy(store)) return;
      if (paused) {
        if (!store.get().paused) {
          pausedSim = true;
          store.set({ paused: true });
        }
      } else if (pausedSim) {
        pausedSim = false;
        store.set({ paused: false });
      }
    },
    // Also when a beat's actions finish: a sweep, a comparison or a readout has just produced the facts its caption
    // quotes, and a short beat may move on before the next tick.
    onChange: (st) => {
      renderState(st);
      refresh();
    },
    onError(err, action) {
      console.warn(`[story] action ${action.kind} failed`, err);
    },
  };

  // ─── Keyboard ─────────────────────────────────────────────────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent) => {
    if (!runner || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    // A modal on top (help, How it works…) keeps its own keys.
    const p = store.get().panels;
    if (p.help || p.howItWorks || p.locationPicker || p.useCases) return;
    let handled = true;
    switch (e.key) {
      case ' ':
      case 'Spacebar':
      case 'k':
      case 'K':
        if (!e.repeat) runner.togglePause();
        break;
      case 'ArrowRight':
      case 'l':
      case 'L':
        runner.next();
        break;
      case 'ArrowLeft':
      case 'j':
      case 'J':
        runner.prev();
        break;
      case 'Escape':
        stop();
        break;
      default:
        handled = false;
    }
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  };

  // ─── Play / stop ──────────────────────────────────────────────────────────────────────────────────────────────
  async function ensureScene(story: Story): Promise<boolean> {
    if (story.dam) {
      // The dam-breach use case's own scene: the valley below the dam (a live area, over the internet) with the breach
      // sent in. Kept when it is already on screen.
      const dam = hooks.dam;
      const ok = !!dam && (await dam.open(story.dam.nid, story.dam.breach).catch(() => false));
      if (!ok) postNotice(store, { kind: 'warn', key: 'story', title: story.title, message: 'This story breaches a dam on the valley below it, which needs the internet for the terrain (USGS 3DEP). The valley could not be loaded: try again online, or watch another story.' });
      return ok && !store.get().loading;
    }
    const preset = story.preset!;
    const s = store.get();
    if (!(s.presetId === preset && s.terrainName && !s.loading)) {
      try {
        await ctx.actions.loadPreset(preset);
      } catch {
        return false;
      }
    }
    const after = store.get();
    if (after.presetId !== preset || !after.terrainName) return false;
    // Glacier scenes: the stations, the clock and the fronts come from the chain; give it a moment to arrive.
    if (after.scenario?.hazardChain) {
      const ctl = new AbortController();
      await poll(() => !!bridge.chain?.result && !!bridge.chain.file, ctl.signal, CHAIN_WAIT_MS, 100);
    }
    return true;
  }

  function writeStoryToUrl(id: string | null) {
    try {
      const url = new URL(window.location.href);
      if (id) url.searchParams.set(STORY_PARAM, id);
      else url.searchParams.delete(STORY_PARAM);
      url.search = url.search.replace(/%2C/gi, ',');
      if (url.href !== window.location.href) window.history.replaceState(null, '', url);
    } catch {
      /* sandboxed iframe: not essential */
    }
  }

  async function play(id: string, opts: StoryPlayOptions = {}): Promise<boolean> {
    const story = storyById(id);
    if (!story) return false;
    // End whatever plays now first (its scene binding must not stop this one when the preset changes below).
    if (current) stop();
    const token = ++startToken;
    lastOpts = { ...opts };
    ctx.skipTutorial?.();
    for (const name of ['help', 'howItWorks', 'locationPicker', 'useCases'] as const) ctx.setPanel(name, false);
    if (!(await ensureScene(story))) return false;
    if (token !== startToken) return false;
    current = story;
    saved = snapshotUser();
    panelWasOpen = deps.panel.isOpen();
    deps.panel.setOpen(false);
    setText(titleEl, story.title);
    setText(subEl, story.subtitle);
    el.dataset.story = story.id;
    buildProgress(story);
    el.hidden = false;
    el.inert = false;
    deps.root.classList.add('dl-nar-mode');
    toggleClass(deps.root, 'dl-nar-reduced', reducedMotion());
    writeStoryToUrl(story.id);
    window.addEventListener('keydown', onKey, true);
    runner = new StoryRunner(story, env, opts);
    tick = window.setInterval(refresh, TICK_MS);
    runner.start(opts.startAt ?? 0);
    return true;
  }

  function snapshotUser(): UserSnapshot {
    const s = store.get();
    return {
      terrain: terrain(),
      stageOffset: s.stageOffset,
      rainRate: s.sim.rainRate,
      timeScale: s.sim.timeScale,
      evacStart: s.evacStart ? { ...s.evacStart } : null,
      waterMode: s.render.waterMode,
      tool: s.tool,
      paused: s.paused,
      edits: editLogFor(store).snapshot(),
      site: hooks.site?.snapshot() ?? null,
      compare: hooks.compare?.snapshot() ?? null,
    };
  }

  function restoreUser(u: UserSnapshot) {
    const t = terrain();
    if (!t || t !== u.terrain || store.get().loading) return;
    const s = store.get();
    store.set({
      stageOffset: u.stageOffset,
      evacStart: u.evacStart,
      paused: u.paused,
      sim: { ...s.sim, rainRate: u.rainRate, timeScale: u.timeScale },
      render: { ...s.render, waterMode: u.waterMode },
    });
    if (s.tool !== u.tool) selectTool(store, u.tool);
    // The demo parcels and the story's sweep or comparison give way to the user's own sites, designs and results.
    if (u.site !== null) hooks.site?.restore(u.site);
    if (u.compare !== null) hooks.compare?.restore(u.compare);
    // Walls and digging, through the edit log (header). Only when they changed: this restarts the water.
    const log = editLogFor(store);
    const solver = bridge.scene?.getSolver() ?? null;
    if (!solver || headlessBusy(store) || JSON.stringify(log.edits) === JSON.stringify(u.edits)) return;
    ctx.actions.resetAll();
    replayEdits(solver, u.edits);
    if (u.edits.some((e) => e.op === 'wall')) bridge.wallDrawn.emit();
  }

  function teardown(restorePanel: boolean) {
    runner?.stop();
    runner = null;
    beat = null;
    clearInterval(tick);
    clearTimeout(orbitTimer);
    tick = 0;
    window.removeEventListener('keydown', onKey, true);
    clearHighlights();
    setPins([]);
    if (pinRaf) cancelAnimationFrame(pinRaf);
    pinRaf = 0;
    if (pausedSim) {
      pausedSim = false;
      store.set({ paused: false });
    }
    if (current && restorePanel && panelWasOpen) deps.panel.setOpen(true);
  }

  /**
   * End the story; `restore` puts the user's state back (header). Not restored when the UI itself is going away, nor
   * from *Explore on your own*, which keeps the story's state on purpose.
   */
  function stop(restore = true) {
    startToken++;
    const was = !!current;
    teardown(true);
    const u = saved;
    saved = null;
    const pending = jobRunning;
    if (pending && restore) {
      // A sweep or comparison the story started is still running: stop it, and put the user's state back once it has
      // put its own scenario back (it restores what it found, which was the story's).
      void hooks.site?.cancel();
      void hooks.compare?.cancel();
      if (u) void pending.finally(() => restoreUser(u));
    } else if (u && restore) restoreUser(u);
    current = null;
    el.hidden = true;
    el.inert = true;
    delete el.dataset.story;
    delete el.dataset.state;
    deps.root.classList.remove('dl-nar-mode', 'dl-nar-reduced');
    if (was) writeStoryToUrl(null);
  }

  // A new scene from elsewhere (the preset list, a live area) ends the story. A dam story's scene is the live area
  // its breach loaded: any other terrain ends it.
  ctx.bind(
    (s) => `${s.presetId}|${s.terrainName}|${!!s.loading}`,
    () => {
      const s = store.get();
      if (!current || s.loading) return;
      if (current.dam ? !hooks.dam?.isOn(current.dam.nid) || s.presetId !== null : s.presetId !== current.preset) stop();
    },
  );
  ctx.own(() => stop(false));

  // ─── Entry points ─────────────────────────────────────────────────────────────────────────────────────────────
  const watchLabel = h('span', null, 'Watch the story');
  const watchButton = h(
    'button',
    {
      type: 'button',
      class: 'dl-btn dl-btn-primary dl-btn-sm dl-nar-watch',
      'data-tip-side': 'left',
      hidden: true,
      onclick: () => {
        const st = sceneStory(store.get().presetId);
        if (st) void play(st.id);
      },
    },
    icon('play', 14),
    watchLabel,
  );
  ctx.bind(
    (s) => `${s.presetId}|${!!s.terrainName}`,
    () => {
      const st = sceneStory(store.get().presetId);
      watchButton.hidden = !st;
      if (st) watchButton.dataset.tip = `${st.title}: a narrated walk-through, about ${Math.round(st.beats.reduce((a, b) => a + b.durationMs, 0) / 60000) || 1} min`;
    },
  );

  /** The Use cases row: the business decisions first, then the events retold, each group under its own label. */
  function storyRow(): HTMLElement {
    const chip = (st: Story) =>
      h(
        'button',
        { type: 'button', class: 'dl-btn dl-btn-subtle dl-btn-sm dl-nar-chip', 'data-story': st.id, 'data-story-group': isBusinessStory(st) ? 'business' : 'event', 'data-tip': st.summary, 'data-tip-side': 'top', onclick: () => void play(st.id) },
        h('span', { class: 'dl-nar-chip-title' }, st.title),
        h('span', { class: 'dl-nar-chip-sub' }, st.subtitle.split(' · ').slice(-1)[0]),
      );
    const business = STORIES.filter(isBusinessStory);
    const events = STORIES.filter((s) => !isBusinessStory(s));
    return h(
      'div',
      { class: 'dl-nar-row' },
      h('span', { class: 'dl-nar-row-label' }, icon('play', 13), 'Narrated stories'),
      ...(business.length ? [h('span', { class: 'dl-nar-row-group' }, 'Decisions'), ...business.map(chip)] : []),
      ...(events.length ? [h('span', { class: 'dl-nar-row-group' }, 'Events'), ...events.map(chip)] : []),
    );
  }

  // A ?story= link: play it once the first scene is on screen (src/app/url.ts already loaded its preset).
  const linked = parseStoryParam(typeof location === 'undefined' ? '' : location.search).story;
  if (linked) {
    let pending = true;
    ctx.bind(
      (s) => !!(s.terrainName && !s.loading),
      (ready) => {
        if (!pending || !ready) return;
        pending = false;
        // After the rest of the UI's first render (the Try-it strip and the timeline are built in this same mount).
        queueMicrotask(() => void play(linked));
      },
    );
  }

  return {
    el,
    pinsEl,
    watchButton,
    storyRow,
    play,
    stop,
    isPlaying: () => !!current,
    next: () => runner?.next(),
    prev: () => runner?.prev(),
    togglePause: () => runner?.togglePause(),
    debugState() {
      const st = runner?.state;
      return {
        storyId: current?.id ?? null,
        index: st?.index ?? -1,
        total: st?.total ?? 0,
        beatId: beat?.id ?? null,
        paused: st?.paused ?? false,
        finished: st?.finished ?? false,
        phase: st?.phase ?? 'done',
        timedOut: st?.timedOut ?? false,
        kicker: kickerEl.textContent ?? '',
        caption: captionEl.textContent ?? '',
        source: sourceEl.textContent ?? '',
      };
    },
  };
}
