import type { AppActions, PresetInfo } from '../contracts';
import { listPresets } from '../data';
import type { App } from './App';
import { APP_CONFIG } from './defaults';
import { errorMessage } from './errors';
import { cloneScenarioLists } from './stage';

/** AppActions: the imperative operations the UI (and the debug API) can invoke. */
export function createActions(app: App): AppActions {
  const { store } = app;

  // Declared standalone (not via `this`) so actions still work when destructured by callers.
  const resetWater = (): void => {
    app.withSolver('reset', (solver) => {
      solver.reset();
      app.driver.onSolverReset();
    });
  };

  return {
    async loadPreset(id) {
      await app.loadScene({ kind: 'preset', id });
    },

    async loadLiveArea(req) {
      const outcome = await app.loadScene({ kind: 'live', req });
      if (outcome === 'ok') {
        const panels = store.get().panels;
        if (panels.locationPicker) store.set({ panels: { ...panels, locationPicker: false } });
      }
    },

    listPresets(): PresetInfo[] {
      try {
        return listPresets();
      } catch (err) {
        app.errors.report('data', `listPresets failed: ${errorMessage(err)}`, err);
        return [];
      }
    },

    resetWater,

    resetAll() {
      app.withSolver('reset', (solver) => {
        solver.reset({ resetTerrain: true });
        app.driver.onSolverReset();
      });
    },

    clearWalls() {
      // One capsule covering the whole domain erases every barrier (GPU + CPU mirror) in a single op.
      app.withSolver('clearWalls', (solver) => {
        const { nx, ny } = solver;
        solver.applyBrush({ kind: 'eraseWall', ax: 0, ay: ny / 2, bx: nx, by: ny / 2, radius: Math.max(nx, ny) });
      });
    },

    restoreScenario() {
      const s = store.get();
      const lists = cloneScenarioLists(s.scenario);
      app.stage.resetFrom(lists.sources);
      store.set({
        sources: lists.sources,
        storms: lists.storms,
        shelters: lists.shelters,
        stageOffset: 0,
        sim: { ...s.sim, rainRate: s.scenario?.rainRate ?? 0 },
      });
    },

    cameraFrameAll() {
      app.renderer?.camera.frameAll();
    },

    cameraTopDown() {
      app.renderer?.camera.topDown();
    },

    setStabilityDemo(on) {
      const sim = store.get().sim;
      if (on) {
        if (sim.stabilityMode !== 'naive') app.preDemoCfl = sim.cfl;
        app.stabilityDemo = true;
        store.set({ sim: { ...sim, stabilityMode: 'naive', cfl: APP_CONFIG.stabilityDemoCfl } });
        // Clear any previous blow-up notice so the next explosion is announced again.
        app.driver.rearmBlowupNotice();
        return;
      }
      app.stabilityDemo = false;
      const cfl = app.preDemoCfl > 0 && app.preDemoCfl <= 1 ? app.preDemoCfl : APP_CONFIG.robustCfl;
      store.set({ sim: { ...sim, stabilityMode: 'robust', cfl } });
      // NaN/inf state from the naive scheme must be wiped; reset() rewrites every state texture.
      resetWater();
    },
  };
}
