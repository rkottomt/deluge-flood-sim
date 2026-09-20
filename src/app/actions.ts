import type { AppActions, PresetInfo } from '../contracts';
import { listPresets } from '../data';
import type { App } from './App';
import { errorMessage } from './errors';
import { cloneScenarioLists } from './stage';

/** AppActions: the imperative operations the UI (and the debug API) can invoke. */
export function createActions(app: App): AppActions {
  const { store } = app;

  // Declared standalone (not via `this`) so actions still work when destructured by callers.
  // Water resets restart from the scenario's initial fill; a raised river then rises to the slider's stage again
  // (stage ramp, see stageRamp.ts and crest.ts).
  const resetWater = (opts: { resetTerrain?: boolean } = {}): void => {
    try {
      if (app.scenes?.scene) app.restartStage();
      if (!app.crest.resetWater(opts)) app.requestRender();
    } catch (err) {
      app.errors.report('sim', `reset failed: ${errorMessage(err)}`, err);
    }
  };

  return {
    async loadPreset(id) {
      await app.loadScene({ kind: 'preset', id });
    },

    async loadLiveArea(req) {
      // The picker explains a failure inline (with the connectivity check); it also still recognises the report.
      const outcome = await app.loadScene({ kind: 'live', req }, { quietToast: store.get().panels.locationPicker });
      if (outcome === 'ok') {
        const panels = store.get().panels;
        if (panels.locationPicker) store.set({ panels: { ...panels, locationPicker: false } });
      }
      return outcome;
    },

    cancelLoad() {
      const scenes = app.scenes;
      const cancelled = scenes?.loadingRequest ?? null;
      if (!scenes?.cancel()) return;
      app.requestRender();
      // Nothing left on screen (e.g. a ?live= link cancelled at startup): fall back to the offline default preset.
      // Synchronously, so the cancelled load's rejection already finds the fallback in flight.
      app.onLoadCancelled(cancelled);
    },

    listPresets(): PresetInfo[] {
      try {
        return listPresets();
      } catch (err) {
        app.errors.report('data', `listPresets failed: ${errorMessage(err)}`, err);
        return [];
      }
    },

    resetWater: () => resetWater(),

    resetAll: () => resetWater({ resetTerrain: true }),

    clearWalls() {
      // One capsule covering the whole domain erases every barrier (GPU + CPU mirror) in a single op.
      app.withSolver('clearWalls', (solver) => {
        const { nx, ny } = solver;
        solver.applyBrush({ kind: 'eraseWall', ax: 0, ay: ny / 2, bx: nx, by: ny / 2, radius: Math.max(nx, ny) });
      });
      app.requestRender();
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
      app.requestRender();
    },

    cameraTopDown() {
      app.renderer?.camera.topDown();
      app.requestRender();
    },
  };
}
