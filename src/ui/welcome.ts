/**
 * "Try it" strip for first-time visitors (who get no instructions). Once the first terrain is ready it offers the
 * demo moments as one-click actions, derived from the loaded scenario:
 *
 *   1 raise the rivers to the record crest (or play the flood fast)   2 plan an evacuation   3 build a levee
 *   4 hurricane rain   5 break the solver
 *
 * Evacuate comes before the levee: building the demo levee replays the rise, so a planned route visibly re-plans as
 * streets flood. Each step shows a check once done, and the ones with an obvious inverse (rivers, levee, rain,
 * solver) toggle back. Under the buttons a status line follows the river while it rises and says how much land the
 * walls keep dry. The strip stays available while the user explores (after the first click its heading folds away
 * to keep the map clear) and goes away for good only when closed.
 */
import type { AppState, CameraPose, DemoLevee, StageControl, Store } from '../contracts';
import { afterNextFrame, h, setText, toggleClass, setAttr, type UIContext } from './dom';
import { icon, type IconName } from './icons';
import { selectTool } from './toolDefs';
import { clamp, M_PER_FT, offsetForFt, stageFt, stageRangeFt } from './scales';
import { fmtNum } from './format';
import { bridgeFor, postNotice } from './bridge';
import { suggestEvacStarts } from './evacSuggest';
import { startBreakDemo, stopBreakDemo } from './stabilityDemo';
import { formatStage, hasGauge, raiseStepText } from './stageText';
import { leveeLength, planLevee, raiseAlong } from './levee';
import { keptStatus } from './wallCheck';

/**
 * Sim speed used by the quick actions, so a flood visibly develops within seconds. Most GPUs can't reach it on a
 * 1024² grid (an M4 manages ~45–70×): it means "as fast as this GPU allows", and the HUD shows what it reaches.
 */
export const QUICK_TIME_SCALE = 300;
/** "Hurricane rain" rate, mm/hr (Hurricane Harvey's peak hourly rates). */
export const HURRICANE_RAIN = 100;
/** Land kept dry that earns a one-time "your walls keep … dry" notice, m² (~5 acres). */
const ANNOUNCE_M2 = 20_000;
/** Rise the raise step aims for on a live area's gauge-less water-level control, m. */
export const LIVE_RAISE_M = 3;

/** The most dramatic stage the slider can reach: the highest in-range historic mark, else the top of the range. */
export function dramaticStage(ctrl: StageControl): { ft: number; label: string } {
  const range = stageRangeFt(ctrl);
  // Without a gauge there is no historic crest: a moderate rise (the top of the range drowns most of a flat city).
  if (!hasGauge(ctrl)) {
    const ft = Math.min(range.max, range.min + LIVE_RAISE_M / M_PER_FT);
    return { ft, label: `+${fmtNum((ft - range.min) * M_PER_FT, 0)} m` };
  }
  const marks = (ctrl.marks ?? []).filter((m) => m.ft <= range.max + 0.01 && m.ft >= range.min).sort((a, b) => b.ft - a.ft);
  if (marks.length) return { ft: marks[0].ft, label: marks[0].label };
  return { ft: range.max, label: `${fmtNum(range.max, 0)} ft` };
}

/** "Play the flood" never flies closer than this, m: closer, a storm scenario's view drops under the storm's cloud deck
 * into its darker overcast (Ellicott City's baked framing is already 1.1 km away), and the imagery turns soft. */
export const CLOSE_UP_MIN_M = 1500;

/**
 * A closer look at the scenario's own framing for "Play the flood": flash floods start as thin threads along the
 * creeks, invisible from a wide establishing shot. Half the distance, but not below CLOSE_UP_MIN_M (a framing that is
 * already close stays where it is).
 */
export function closeUpPose(pose: CameraPose): CameraPose {
  return {
    target: { ...pose.target },
    distance: Math.max(pose.distance * 0.5, Math.min(pose.distance, CLOSE_UP_MIN_M)),
    yaw: pose.yaw,
    pitch: Math.min(1.2, pose.pitch + 0.08),
  };
}

/** Stage offset (m) of the dramatic crest. */
export function dramaticOffset(ctrl: StageControl): number {
  return clamp(offsetForFt(ctrl, dramaticStage(ctrl).ft), 0, ctrl.maxOffset);
}

interface Step {
  id: 'flood' | 'levee' | 'evac' | 'rain' | 'break';
  icon: IconName;
  key?: string;
  /** Current label (may depend on state, e.g. toggles). */
  label(s: AppState): string;
  tip(s: AppState): string;
  done(s: AppState): boolean;
  /** Toggle steps show their inverse action once done. */
  active?(s: AppState): boolean;
  run(): void;
}

/** Nothing in the scenario makes water: no river stage, inflow, storm or rain (e.g. a live area with no river found). */
export function hasNoForcing(s: Pick<AppState, 'scenario' | 'sources' | 'storms' | 'sim'>): boolean {
  return !s.scenario?.stage && s.sources.length === 0 && s.storms.length === 0 && !(s.sim.rainRate > 0);
}

/** Id of the storm cell "Play the flood" drops on an area that has nothing else to flood it. */
export const PLAY_STORM_ID = 'try-storm';
/** Its peak rate, mm/hr: a flash-flood thunderstorm (Ellicott City 2016 peaked near 150 mm/hr for minutes). */
export const PLAY_STORM_RATE = 120;

/** "Storm over Asheville" for "Asheville, North Carolina" (the place part of a terrain name). */
export function stormLabel(terrainName: string): string {
  const place = terrainName.split(/\s[—–-]\s|,/)[0].trim();
  return place && place.length <= 22 ? `Storm over ${place}` : 'Drop a storm';
}

/**
 * The storm "Play the flood" drops where the view is: centred on the camera target (clamped inside the map), wide
 * enough to cover about half of it, so the runoff it makes gathers in the streets and creeks on screen.
 */
export function playStorm(grid: { nx: number; ny: number }, target: { gx: number; gy: number } | null) {
  const size = Math.max(grid.nx, grid.ny);
  const margin = 0.15 * size;
  const gx = clamp(target?.gx ?? grid.nx / 2, margin, grid.nx - margin);
  const gy = clamp(target?.gy ?? grid.ny / 2, margin, grid.ny - margin);
  return { id: PLAY_STORM_ID, gx, gy, radius: Math.round(0.35 * size), intensity: PLAY_STORM_RATE };
}

export function createWelcome(ctx: UIContext): HTMLElement {
  const { store, bind } = ctx;
  const bridge = bridgeFor(store);
  let dismissed = false;
  let used = false;
  let wallDrawn = false;
  /** "Play the flood" was clicked in this scene (a fast speed carried over from elsewhere doesn't count). */
  let played = false;
  /** Flooded land when a storm was dropped on a scene with no forcing: its step is done once flooding grows past it. */
  let stormFloodBase: number | null = null;
  /** The demo levee stands in this scene (its step then offers to remove it); a build is in progress. */
  let leveeUp = false;
  let leveeBusy = false;

  const quickSpeed = (s: AppState) => ({ ...s.sim, timeScale: Math.max(s.sim.timeScale, QUICK_TIME_SCALE) });
  const demoLevee = (s: AppState): DemoLevee | null => (s.scenario?.levee && s.scenario.stage ? s.scenario.levee : null);

  const floodStep: Step = {
    id: 'flood',
    icon: 'water',
    label: (s) => {
      const ctrl = s.scenario?.stage;
      if (!ctrl) return hasNoForcing(s) || stormFloodBase !== null ? stormLabel(s.terrainName) : 'Play the flood';
      return isRaised(s, ctrl) ? 'Back to normal' : raiseStepText(ctrl, dramaticStage(ctrl)).label;
    },
    tip: (s) => {
      const ctrl = s.scenario?.stage;
      if (!ctrl) {
        return hasNoForcing(s) || stormFloodBase !== null
          ? `No river crosses the map edge here to raise: drop a ${PLAY_STORM_RATE} mm/hr thunderstorm over the view and fast-forward`
          : 'Fast-forward the scenario (up to 300×, as fast as your GPU allows) and zoom in on it';
      }
      return isRaised(s, ctrl) ? 'Lower the water to its normal level' : raiseStepText(ctrl, dramaticStage(ctrl)).tip;
    },
    done: (s) => {
      if (s.scenario?.stage) return isRaised(s, s.scenario.stage);
      if (!played || s.paused || hasNoForcing(s)) return false;
      // A storm dropped on a dry scene counts once it floods something, not merely once it is falling.
      if (stormFloodBase !== null) return (s.stats?.floodedArea ?? 0) > stormFloodBase + 2000;
      return s.sim.timeScale >= QUICK_TIME_SCALE;
    },
    active: (s) => !!s.scenario?.stage && isRaised(s, s.scenario.stage),
    run: () => {
      const s = store.get();
      const ctrl = s.scenario?.stage ?? null;
      if (!ctrl) {
        played = true;
        if (hasNoForcing(s) && s.grid) {
          const camera = bridge.scene?.getCamera?.() ?? null;
          stormFloodBase = s.stats?.floodedArea ?? 0;
          store.set({ paused: false, sim: quickSpeed(s), storms: [...s.storms, playStorm(s.grid, camera?.pose.target ?? null)] });
          postNotice(store, {
            kind: 'info',
            key: 'try-flood',
            title: `A ${PLAY_STORM_RATE} mm/hr thunderstorm over the view`,
            message:
              'No river crosses the edge of this map, so there is no river to raise. Runoff gathers in streets, hollows and creeks first; roads turn orange, then red.' +
              (s.render.waterMode === 'realistic' ? ' The depth map shows where it collects.' : ''),
            action: s.render.waterMode === 'realistic' ? { label: 'Show depth map', run: () => ctx.setRender({ waterMode: 'depth' }) } : undefined,
            durationMs: 12000,
          });
          return;
        }
        store.set({ paused: false, sim: quickSpeed(s) });
        playTheFlood(ctx);
        return;
      }
      if (isRaised(s, ctrl)) return store.set({ stageOffset: 0 });
      store.set({ paused: false, sim: quickSpeed(s), stageOffset: dramaticOffset(ctrl) });
    },
  };

  const leveeStep: Step = {
    id: 'levee',
    icon: 'wall',
    key: '2',
    label: (s) => (demoLevee(s) && leveeUp ? 'Remove levee' : 'Build a levee'),
    tip: (s) => {
      const levee = demoLevee(s);
      if (!levee) return 'Wall tool — drag across the path of the water';
      if (leveeUp) return 'Remove every wall on the map';
      return `Raise a floodwall along ${levee.name}, then replay the ${dramaticStage(s.scenario!.stage!).label} with it in place`;
    },
    done: () => wallDrawn,
    active: (s) => !!demoLevee(s) && leveeUp,
    run: () => {
      const s = store.get();
      const levee = demoLevee(s);
      if (levee && leveeUp) {
        leveeUp = false;
        ctx.actions.clearWalls();
        sync(store.get());
        return;
      }
      if (levee && bridge.scene?.buildWalls) {
        if (!leveeBusy) void buildDemoLevee(levee);
        return;
      }
      selectTool(store, 'wall');
      postNotice(store, {
        kind: 'info',
        key: 'try-levee',
        title: 'Drag on the map to build a wall',
        message:
          'Close off a low gap where water gets in and tie both ends into high ground — water runs around open ends. ' +
          'The tool card checks the height against the flood as you hover (red = too low).',
        durationMs: 9000,
      });
    },
  };

  const steps: Step[] = [
    floodStep,
    {
      id: 'evac',
      icon: 'evac',
      key: '8',
      label: () => 'Evacuate',
      tip: () => 'Plan an evacuation from a low street to the nearest dry shelter — it re-plans as roads flood',
      done: (s) => !!s.evacStart,
      run: () => void planEvacuation(ctx),
    },
    leveeStep,
    {
      id: 'rain',
      icon: 'rain',
      label: (s) => (s.sim.rainRate >= HURRICANE_RAIN ? 'Stop rain' : 'Hurricane rain'),
      tip: (s) =>
        s.sim.rainRate >= HURRICANE_RAIN ? 'Turn the rain off' : `${HURRICANE_RAIN} mm/hr over the whole map (Harvey’s peak rates), fast-forwarded`,
      done: (s) => s.sim.rainRate >= HURRICANE_RAIN,
      active: (s) => s.sim.rainRate >= HURRICANE_RAIN,
      run: () => {
        const s = store.get();
        if (s.sim.rainRate >= HURRICANE_RAIN) return ctx.setSim({ rainRate: 0 });
        store.set({ paused: false, sim: { ...quickSpeed(s), rainRate: HURRICANE_RAIN } });
        postNotice(store, {
          kind: 'info',
          key: 'try-rain',
          title: `${HURRICANE_RAIN} mm of rain an hour, everywhere`,
          message: s.render.showRoads
            ? 'Watch the streets: runoff collects in them and roads turn orange (wet), then red (flooded). The HUD counts the rain fallen.'
            : 'Runoff collects in streets and hollows long before the rivers rise. The HUD counts the rain fallen.',
          durationMs: 9000,
        });
      },
    },
    {
      id: 'break',
      icon: 'bolt',
      label: (s) => (s.sim.stabilityMode === 'naive' ? 'Restore solver' : 'Break it'),
      tip: (s) =>
        s.sim.stabilityMode === 'naive'
          ? 'Back to the robust scheme — the water resets'
          : 'Swap in a textbook explicit scheme and watch it blow up (How it works explains why)',
      done: (s) => s.sim.stabilityMode === 'naive',
      active: (s) => s.sim.stabilityMode === 'naive',
      run: () => (store.get().sim.stabilityMode === 'naive' ? stopBreakDemo(ctx) : startBreakDemo(ctx)),
    },
  ];

  /**
   * The one-click levee: fly to it, reset the water if the flood is already out (a wall raised on flooded land only
   * traps the water behind it), raise the wall along its line over ~2 s, then bring the river up to the record crest
   * again so the levee is tested live. The land it keeps dry turns green and the status line counts it.
   */
  async function buildDemoLevee(levee: DemoLevee): Promise<void> {
    const scene = bridge.scene;
    const solver = scene?.getSolver() ?? null;
    const s0 = store.get();
    const ctrl = s0.scenario?.stage ?? null;
    if (!scene?.buildWalls || !solver || !ctrl) return;
    leveeBusy = true;
    const terrainName = s0.terrainName;
    const stale = () => store.get().terrainName !== terrainName || store.get().sim.stabilityMode !== 'robust';
    try {
      const flooded = s0.stageOffsetApplied > 0.3 || (s0.stats?.floodedArea ?? 0) > 50_000;
      const crest = dramaticStage(ctrl);
      const km = leveeLength(levee, solver.cellSize) / 1000;
      postNotice(store, {
        kind: 'info',
        key: 'try-levee',
        title: `Building a ${fmtNum(km, 1)} km levee along ${levee.name}`,
        message:
          `Its top stands above the ${crest.label} (${fmtNum(crest.ft, 0)} ft). ` +
          (flooded ? 'The flood is reset and the river rises again with the levee in place' : 'Then the river rises to the record') +
          ' — land the levee keeps dry turns green.',
        durationMs: 12000,
      });
      const camera = scene.getCamera?.() ?? null;
      if (levee.camera && camera) {
        try {
          camera.flyTo(levee.camera, 1.4);
        } catch {
          /* renderer gone */
        }
      }
      // The notice and the flight show in this frame; the water resets in the next one (one long frame otherwise).
      await afterNextFrame();
      if (stale()) return;
      if (flooded || s0.stageOffset > 0.05) {
        store.set({ stageOffset: 0 });
        if (flooded) ctx.actions.resetWater();
      }
      await afterNextFrame();
      if (stale()) return;
      // The wall brush's scratch textures, allocated now rather than under the first wall piece.
      (solver as { prepareBrushes?: () => void }).prepareBrushes?.();
      await wait(1000);
      if (stale()) return;
      const radius = Math.max(1.2, 15 / solver.cellSize);
      const segments = planLevee(levee, solver.getGroundCPU(), solver.nx, solver.ny, radius);
      const built = await raiseAlong(segments, (batch) => scene.buildWalls?.(batch, radius), 2.2, stale);
      if (!built) return;
      leveeUp = true;
      const s = store.get();
      store.set({ paused: false, sim: quickSpeed(s), stageOffset: dramaticOffset(ctrl) });
    } finally {
      leveeBusy = false;
      sync(store.get());
    }
  }

  const buttons = steps.map((step) => {
    const text = h('span', { class: 'dl-try-label' });
    const b = h(
      'button',
      {
        type: 'button',
        class: `dl-try-step${step.id === 'break' ? ' dl-try-danger' : ''}`,
        'data-step': step.id,
        'data-tip-side': 'bottom',
        'data-tip-key': step.key ?? null,
        'aria-keyshortcuts': step.key ?? null,
        onclick: () => {
          used = true;
          sync(store.get());
          step.run();
        },
      },
      h('span', { class: 'dl-try-mark', 'aria-hidden': 'true' }, icon(step.icon, 15, 'dl-try-icon'), icon('check', 15, 'dl-try-check')),
      text,
    );
    return { step, b, text };
  });

  const close = h(
    'button',
    { type: 'button', class: 'dl-icon-btn dl-welcome-close', 'aria-label': 'Hide the demo steps', 'data-tip': 'Hide — the ? guide has the same tour', 'data-tip-side': 'bottom', onclick: () => dismiss() },
    icon('close', 15),
  );
  const row = h('div', { class: 'dl-try-row', role: 'group', 'aria-label': 'Demo steps' }, ...buttons.map((x) => x.b));
  // Arrow keys move between steps (Tab still walks through them).
  row.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const list = buttons.map((x) => x.b);
    const k = list.indexOf(document.activeElement as HTMLButtonElement);
    if (k < 0) return;
    e.preventDefault();
    e.stopPropagation();
    list[(k + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length].focus();
  });

  // Status line: the river on its way to a new stage (the first seconds of a raise look static from far away), and
  // the land the walls keep dry.
  const riverText = h('span', { class: 'dl-try-status-text' });
  const riverPill = h('span', { class: 'dl-try-status dl-try-status-river', role: 'status', hidden: true }, icon('water', 14), riverText);
  const keptText = h('span', { class: 'dl-try-status-text' });
  const keptPill = h('span', { class: 'dl-try-status dl-try-status-kept', role: 'status', hidden: true }, icon('shield', 14), keptText);
  const status = h('div', { class: 'dl-try-statusbar', 'aria-live': 'polite', hidden: true }, riverPill, keptPill);

  const el = h(
    'section',
    { class: 'dl-welcome dl-glass', 'aria-label': 'Try the demo' },
    h(
      'div',
      { class: 'dl-welcome-head' },
      h('span', { class: 'dl-welcome-spark' }, icon('spark', 15)),
      h('span', { class: 'dl-welcome-title' }, h('b', null, 'Try it'), ' — every drop is solved live on your GPU'),
    ),
    h('div', { class: 'dl-try-body' }, row, close),
    status,
  );

  // The heading folds away after the first click, but only once the pointer has left the strip: folding it under a
  // resting cursor would move every button up by its height right after the click.
  let pointerInside = false;
  el.addEventListener('pointerenter', () => {
    pointerInside = true;
  });
  el.addEventListener('pointerleave', () => {
    pointerInside = false;
    sync(store.get());
  });

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    sync(store.get());
  }

  function syncStatus(s: AppState) {
    const river = riverStatus(s);
    riverPill.hidden = !river;
    if (river) {
      setText(riverText, river.text);
      riverPill.dataset.dir = river.dir;
    }
    const kept = keptStatus(bridge.protection);
    keptPill.hidden = !kept;
    if (kept) {
      setText(keptText, kept.text);
      keptPill.dataset.tip = kept.tip;
    }
    status.hidden = !river && !kept;
  }

  function sync(s: AppState) {
    const show = !dismissed && !!s.terrainName && !s.loading;
    toggleClass(el, 'dl-show', show);
    if (used && !pointerInside) toggleClass(el, 'dl-compact', true);
    if (!used) toggleClass(el, 'dl-compact', false);
    el.inert = !show;
    if (!show) return;
    const firstOpen = buttons.find((x) => !x.step.done(s));
    for (const { step, b, text } of buttons) {
      const done = step.done(s);
      setText(text, step.label(s));
      b.dataset.tip = step.tip(s);
      toggleClass(b, 'dl-done', done);
      toggleClass(b, 'dl-next', firstOpen?.b === b);
      toggleClass(b, 'dl-busy', step.id === 'levee' && leveeBusy);
      if (step.active) setAttr(b, 'aria-pressed', String(step.active(s)));
    }
    syncStatus(s);
  }

  ctx.own(
    bridge.wallDrawn.on(() => {
      wallDrawn = true;
      sync(store.get());
    }),
  );
  // The first time walls keep real land dry (per wall layout), say so once: the moment a levee pays off. Only once the
  // river has arrived and two analyses agree: while the flood still spreads the estimate overshoots (193 acres for a
  // levee that settles at ~139), and a notice frozen at that number would contradict the live count under the strip.
  let announcedWalls = -1;
  let prevArea = 0;
  ctx.own(
    bridge.protectionChanged.on((p) => {
      // Walls erased (by any means): the demo levee is gone too.
      if (!p) leveeUp = false;
      const kept = keptStatus(p);
      const s = store.get();
      const settled = !riverStatus(s) && !!p && prevArea > 0 && Math.abs(p.areaM2 - prevArea) <= 0.15 * prevArea;
      prevArea = p?.areaM2 ?? 0;
      if (p && kept && settled && p.areaM2 >= ANNOUNCE_M2 && Math.abs(p.wallCells - announcedWalls) > 0.1 * Math.max(1, announcedWalls)) {
        announcedWalls = p.wallCells;
        const who = leveeUp ? 'The levee' : 'Your walls';
        // With the strip showing, its status line carries the live number: the notice doesn't repeat a snapshot of it.
        const counted = !dismissed;
        postNotice(store, {
          kind: 'success',
          key: 'walls-protect',
          title: counted ? `${who} ${leveeUp ? 'is' : 'are'} holding` : kept.text.replace(/^Walls keep/, `${who} keep${leveeUp ? 's' : ''}`),
          message: counted
            ? 'Green on the map: land that would be under water at this level without the walls. The line under the Try-it buttons counts it as the water moves.'
            : 'Green on the map: land that would be under water at this level without the walls.',
          durationMs: 8000,
        });
      }
      sync(s);
    }),
  );
  bind(
    (s) =>
      `${!!s.terrainName}|${!!s.loading}|${s.scenario === null}|${s.stageOffset}|${s.stageOffsetApplied}|${s.sim.rainRate}|${s.sim.timeScale}|${s.paused}|${s.sim.stabilityMode}|${!!s.evacStart}|${s.storms.length}|${s.sources.length}|${stormFloodBase !== null ? Math.round((s.stats?.floodedArea ?? 0) / 1000) : ''}`,
    (_k, s) => sync(s),
  );
  // A new scene starts the checklist over (the dismissal sticks).
  bind(
    (s) => s.terrainName,
    () => {
      wallDrawn = false;
      played = false;
      stormFloodBase = null;
      leveeUp = false;
      announcedWalls = -1;
    },
  );
  return el;
}

/** "River rising 24.1 → 46.0 ft" while the simulated stage moves toward the slider (null when it has arrived). */
export function riverStatus(s: Pick<AppState, 'scenario' | 'stageOffset' | 'stageOffsetApplied' | 'paused'>): { text: string; dir: 'up' | 'down' } | null {
  const ctrl = s.scenario?.stage;
  if (!ctrl || Math.abs(s.stageOffset - s.stageOffsetApplied) <= 0.005) return null;
  const up = s.stageOffsetApplied < s.stageOffset;
  const now = formatStage(ctrl, stageFt(ctrl, s.stageOffsetApplied));
  const to = formatStage(ctrl, stageFt(ctrl, s.stageOffset));
  return { text: `River ${up ? 'rising' : 'falling'} ${now} → ${to}${s.paused ? ' (paused)' : ''}`, dir: up ? 'up' : 'down' };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * "Play the flood" on a scenario without a river-stage control (a storm or inflows drive it): zoom in on the
 * scenario's framing, where the flood runs, and offer the depth map — brown water over wooded imagery is hard to
 * read in the first simulated minutes. The view mode is only offered, never switched without asking.
 */
function playTheFlood(ctx: UIContext): void {
  const { store } = ctx;
  const s = store.get();
  const pose = s.scenario?.camera;
  const camera = bridgeFor(store).scene?.getCamera?.() ?? null;
  if (pose && camera) {
    try {
      camera.flyTo(closeUpPose(pose), 1.6);
    } catch {
      /* renderer gone */
    }
  }
  const rainy = s.sim.rainRate > 0 || s.storms.length > 0;
  postNotice(store, {
    kind: 'info',
    key: 'try-flood',
    title: 'Fast-forwarding the flood',
    message:
      (rainy
        ? 'Storm rain runs off the hills into the creeks and down through town — the first minutes are thin threads along the streams.'
        : 'Peak flows pour in where the rivers enter the map and spill out of the channels.') +
      (s.render.waterMode === 'realistic' ? ' The depth map shows every flooded street by how deep it is.' : ''),
    action: s.render.waterMode === 'realistic' ? { label: 'Show depth map', run: () => ctx.setRender({ waterMode: 'depth' }) } : undefined,
    durationMs: 12000,
  });
}

function isRaised(s: AppState, ctrl: StageControl): boolean {
  return s.stageOffset >= dramaticOffset(ctrl) - 0.05;
}

/**
 * Select the evacuation tool and put the start on a street that the scenario's flood will reach, trying a few
 * candidates until the router finds a route (a start the router can't connect makes a poor first impression).
 */
export async function planEvacuation(ctx: Pick<UIContext, 'store'>): Promise<void> {
  const { store } = ctx;
  selectTool(store, 'evac');
  const s = store.get();
  const scene = bridgeFor(store).scene;
  const terrain = scene?.getTerrain() ?? null;
  const solver = scene?.getSolver() ?? null;
  if (!s.shelters.length) {
    postNotice(store, {
      kind: 'info',
      key: 'try-evac',
      title: 'Add a shelter first',
      message: 'This area has no evacuation shelters yet. Press 9 and click high ground to add one, then click a home with the evacuation tool (8).',
    });
    return;
  }
  if (!terrain?.roads || !solver) {
    postNotice(store, { kind: 'info', key: 'try-evac', title: 'Click a home on the map', message: 'The route to the nearest dry shelter appears at once and re-plans as roads flood.' });
    return;
  }
  const ctrl = s.scenario?.stage ?? null;
  // Show the tool switch first; picking a start and routing it land in the next frames (one ~30 ms click otherwise).
  await afterNextFrame();
  if (store.get().tool !== 'evac' || bridgeFor(store).scene?.getSolver() !== solver) return;
  let ground: Float32Array;
  try {
    ground = solver.getGroundCPU();
  } catch {
    return;
  }
  const snap = solver.getSnapshot();
  const cands = suggestEvacStarts({
    nx: solver.nx,
    ny: solver.ny,
    ground,
    depth: snap && snap.nx === solver.nx && snap.ny === solver.ny ? snap.depth : null,
    roads: terrain.roads,
    shelters: s.shelters,
    focus: s.scenario?.camera?.target ?? { gx: solver.nx / 2, gy: solver.ny / 2 },
    floodLevel: ctrl ? ctrl.normalLevel + dramaticOffset(ctrl) : null,
    // Where the river is in the simulation now (the slider may be far ahead of it while it rises).
    currentLevel: ctrl ? ctrl.normalLevel + s.stageOffsetApplied : null,
    max: 10,
  });
  if (!cands.length) {
    postNotice(store, { kind: 'info', key: 'try-evac', title: 'Click a home on the map', message: 'The route to the nearest dry shelter appears at once and re-plans as roads flood.' });
    return;
  }
  await afterNextFrame();
  // The user may have clicked a start of their own (or left the tool) meanwhile.
  if (store.get().tool !== 'evac' || store.get().evacStart !== s.evacStart) return;
  for (const c of cands) {
    const start = { gx: c.gx, gy: c.gy };
    const before = store.get().route;
    store.set({ evacStart: start });
    const state = await routeStateFor(store, start, before, 1500);
    if (store.get().evacStart !== start) return; // the user clicked a start of their own meanwhile
    if (state === 'ok') {
      const now = store.get();
      const rising = !!ctrl && now.stageOffsetApplied < now.stageOffset - 0.05;
      const risen = !!ctrl && now.stageOffsetApplied > 0.3;
      postNotice(store, {
        kind: 'info',
        key: 'try-evac',
        title: 'Evacuation route planned',
        message: rising
          ? 'The river is still rising: watch the route re-plan around streets as they flood.'
          : risen
            ? 'It drives around the flooded streets. Build the levee or add rain next: the route re-plans as the water moves.'
            : 'Now raise the river or add rain: the route re-plans as streets flood, and turns red if every way out is cut.',
        durationMs: 8000,
      });
      return;
    }
  }
  store.set({ evacStart: { gx: cands[0].gx, gy: cands[0].gy } });
}

/**
 * Resolves with the route state the app computes for `start` (null on timeout or when the start changes). The app
 * usually re-plans synchronously inside the store update that moved the start, so a route that already differs
 * from `before` is the answer; otherwise wait for the next one.
 */
function routeStateFor(
  store: Store,
  start: AppState['evacStart'],
  before: AppState['route'],
  timeoutMs: number,
): Promise<'ok' | 'blocked' | 'none' | null> {
  const now = store.get().route;
  if (now !== before && now && now.state !== 'none') return Promise.resolve(now.state);
  return new Promise((resolve) => {
    const initial = now;
    let off = () => {};
    const timer = setTimeout(() => {
      off();
      resolve(null);
    }, timeoutMs);
    const finish = (v: 'ok' | 'blocked' | 'none' | null) => {
      clearTimeout(timer);
      off();
      resolve(v);
    };
    off = store.subscribe((st) => {
      if (st.evacStart !== start) return finish(null);
      const r = st.route;
      if (r && r !== initial && r.state !== 'none') finish(r.state);
    });
  });
}
