/**
 * SceneManager cancellation (no GPU): a live load stuck on a network that never answers can be cancelled; the scene on
 * screen is kept, the loading state clears, and the load reports itself as superseded (silently ignored by the app).
 * Run: node --import tsx --test tests/app/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EvacuationRouter, FloodRenderer } from '../../src/contracts';
import type { App } from '../../src/app/App';
import { createActions } from '../../src/app/actions';
import { createInitialState } from '../../src/app/defaults';
import { SceneManager, SupersededLoadError } from '../../src/app/scene';
import { StageLevels } from '../../src/app/stage';
import { createStore } from '../../src/app/store';

test('scene: a stalled live load can be cancelled while downloading; the old scene stays and nothing is torn down', async () => {
  const real = globalThis.fetch;
  let requests = 0;
  let aborted = 0;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      requests++;
      init?.signal?.addEventListener('abort', () => {
        aborted++;
        reject(init.signal!.reason);
      });
    })) as typeof fetch;
  try {
    const store = createStore(createInitialState());
    store.set({ loading: null, terrainName: 'Pittsburgh — Three Rivers' });
    let cleared = 0;
    const scenes = new SceneManager({
      device: {} as GPUDevice,
      store,
      renderer: {} as FloodRenderer,
      router: {} as EvacuationRouter,
      stage: new StageLevels(),
      onSceneCleared: () => cleared++,
      onSceneReady: () => assert.fail('a cancelled load must not bind a scene'),
    });
    assert.equal(scenes.cancel(), false, 'nothing to cancel');
    const request = { kind: 'live' as const, req: { center: { lat: 40.02, lon: -105.27 }, sizeMeters: 2000, resolution: 512 as const } };
    const load = scenes.load(request).then(
      () => 'loaded',
      (e: unknown) => (e instanceof SupersededLoadError ? 'superseded' : `failed: ${String(e)}`),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(store.get().loading?.cancellable, true, 'the loading overlay offers Cancel for a live download');
    assert.equal(scenes.loadingRequest, request);
    assert.ok(requests > 0, 'downloads started');
    assert.equal(scenes.cancel(), true);
    assert.equal(store.get().loading, null, 'loading state cleared at once');
    assert.equal(await load, 'superseded');
    assert.ok(aborted >= requests - 1, `downloads aborted (${aborted} of ${requests})`);
    assert.equal(scenes.loadingRequest, null);
    assert.equal(cleared, 0, 'the scene on screen was never torn down');
    assert.equal(store.get().terrainName, 'Pittsburgh — Three Rivers');
    assert.equal(scenes.cancel(), false, 'cancelling twice is a no-op');
  } finally {
    globalThis.fetch = real;
  }
});

test('actions.cancelLoad: a cancelled load hands its request to the app (which falls back when nothing is on screen)', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  try {
    const store = createStore(createInitialState());
    store.set({ loading: null });
    const scenes = new SceneManager({
      device: {} as GPUDevice,
      store,
      renderer: {} as FloodRenderer,
      router: {} as EvacuationRouter,
      stage: new StageLevels(),
      onSceneCleared: () => {},
      onSceneReady: () => assert.fail('a cancelled load must not bind a scene'),
    });
    const cancelledWith: unknown[] = [];
    const fakeApp = {
      store,
      scenes,
      requestRender: () => {},
      onLoadCancelled: (req: unknown) => {
        // Called synchronously, after the cancel: a fallback started here is in flight before the rejection lands.
        assert.equal(scenes.loadingRequest, null, 'the cancelled load no longer counts as loading');
        cancelledWith.push(req);
      },
    };
    const actions = createActions(fakeApp as unknown as App);
    actions.cancelLoad?.();
    assert.equal(cancelledWith.length, 0, 'nothing loading → nothing cancelled, no fallback');
    // A ?live= link at startup: no scene on screen yet.
    const request = { kind: 'live' as const, req: { center: { lat: 40.2598, lon: -76.887 }, sizeMeters: 6000, resolution: 1024 as const } };
    const load = scenes.load(request).then(
      () => 'loaded',
      (e: unknown) => (e instanceof SupersededLoadError ? 'superseded' : `failed: ${String(e)}`),
    );
    await new Promise((r) => setTimeout(r, 30));
    actions.cancelLoad?.();
    assert.deepEqual(cancelledWith, [request], 'the request is captured before cancel() forgets it');
    assert.equal(await load, 'superseded');
    assert.equal(scenes.scene, null);
  } finally {
    globalThis.fetch = real;
  }
});

/**
 * Device loss during a load (artifacts/soak3/t3-devlost.json, S5b "live area loss while loading"): the load kept
 * running on the destroyed device long after the card was up — it timed out 15 s later, fell back to a preset and
 * reported that scene as loaded, rewriting the address bar the loss handler had just pointed at the right place.
 * abandon() is the fix: the load is invalidated and its downloads aborted at once, and no later load may start.
 */
function abandonHarness(): {
  store: ReturnType<typeof createStore>;
  scenes: SceneManager;
  counts: { cleared: number; ready: number; requests: number; aborted: number };
  restore(): void;
} {
  const real = globalThis.fetch;
  const counts = { cleared: 0, ready: 0, requests: 0, aborted: 0 };
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      counts.requests++;
      init?.signal?.addEventListener('abort', () => {
        counts.aborted++;
        reject(init.signal!.reason);
      });
    })) as typeof fetch;
  const store = createStore(createInitialState());
  store.set({ loading: null, terrainName: 'Pittsburgh — Three Rivers' });
  const scenes = new SceneManager({
    device: {} as GPUDevice,
    store,
    renderer: {} as FloodRenderer,
    router: {} as EvacuationRouter,
    stage: new StageLevels(),
    onSceneCleared: () => counts.cleared++,
    onSceneReady: () => counts.ready++,
  });
  return {
    store,
    scenes,
    counts,
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

const LIVE_REQUEST = {
  kind: 'live' as const,
  req: { center: { lat: 40.2598, lon: -76.887 }, sizeMeters: 6000, resolution: 1024 as const },
};

test('scene.abandon: a device destroyed mid-load stops that load dead — no scene is bound and its downloads are aborted', async () => {
  const h = abandonHarness();
  try {
    const load = h.scenes.load(LIVE_REQUEST).then(
      () => 'loaded',
      (e: unknown) => (e instanceof SupersededLoadError ? 'superseded' : `failed: ${String(e)}`),
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(h.counts.requests > 0, 'the load is downloading');
    assert.equal(h.scenes.loadingRequest, LIVE_REQUEST);
    assert.equal(h.scenes.usable, true);

    assert.equal(h.scenes.abandon(), true, 'reports that a load was in flight');

    assert.equal(await load, 'superseded', 'the in-flight load rejects instead of building on a dead device');
    assert.equal(h.counts.ready, 0, 'it never bound a scene');
    assert.equal(h.counts.cleared, 0, 'it never tore the old scene down');
    assert.equal(h.scenes.scene, null);
    assert.equal(h.scenes.loadingRequest, null, 'nothing counts as loading any more');
    assert.ok(h.counts.aborted >= h.counts.requests - 1, `downloads aborted (${h.counts.aborted} of ${h.counts.requests})`);
    assert.equal(h.scenes.usable, false, 'the manager is unusable from here on');
  } finally {
    h.restore();
  }
});

test('scene.abandon: the loading overlay is left alone (the device-lost card owns the screen), unlike cancel()', async () => {
  const h = abandonHarness();
  try {
    const load = h.scenes.load(LIVE_REQUEST).catch(() => 'superseded');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(h.store.get().loading?.cancellable, true, 'the Cancel overlay is up');
    h.scenes.abandon();
    await load;
    assert.ok(h.store.get().loading, 'abandon() does NOT clear the overlay — the full-screen card replaces it');
    assert.equal(h.store.get().terrainName, 'Pittsburgh — Three Rivers', 'the scene on screen is not disturbed');
  } finally {
    h.restore();
  }
});

test('scene.abandon: no later load may start on the dead device, and cancel() has nothing left to do', async () => {
  const h = abandonHarness();
  try {
    assert.equal(h.scenes.abandon(), false, 'nothing in flight → false');
    const requestsBefore = h.counts.requests;
    // The S5b path: the app tried a fallback preset load after the loss. It must not reach the device at all.
    const fallback = await h.scenes.load({ kind: 'preset', id: 'pittsburgh' }).then(
      () => 'loaded',
      (e: unknown) => (e instanceof SupersededLoadError ? 'superseded' : `failed: ${String(e)}`),
    );
    assert.equal(fallback, 'superseded', 'a load started after the loss is refused');
    assert.equal(h.counts.requests, requestsBefore, 'it did not even start downloading');
    assert.equal(h.counts.ready, 0, 'and never reported a scene (which is what rewrote the address bar)');
    assert.equal(h.store.get().loading, null, 'it never put a loading overlay up either');
    assert.equal(h.scenes.cancel(), false);
    assert.equal(h.scenes.usable, false);
  } finally {
    h.restore();
  }
});

test('scene.abandon: a load already past its downloads is invalidated too (cancel() could not touch it)', async () => {
  const h = abandonHarness();
  try {
    // The sandbox preset is generated in-process (no download at all), so this load reaches the checkpoint right
    // before the GPU work — the window cancel() refuses to touch, and the one where the soak saw a load carry on.
    // The fake device here is the assertion: createSolverWithOptions() on `{}` would throw a TypeError, so a
    // SupersededLoadError proves the load stopped at the checkpoint instead of allocating on the dead device.
    const load = h.scenes.load({ kind: 'preset', id: 'sandbox' }).then(
      () => 'loaded',
      (e: unknown) => (e instanceof SupersededLoadError ? 'superseded' : `failed: ${String(e)}`),
    );
    assert.equal(h.scenes.cancel(), false, 'cancel() refuses: a preset load is never in the cancellable phase');
    assert.equal(h.scenes.abandon(), true, 'abandon() does not care how far along it is');
    assert.equal(await load, 'superseded');
    assert.equal(h.counts.ready, 0, 'no scene was bound');
    assert.equal(h.counts.cleared, 0, 'and the old scene was not torn down for a scene that never arrived');
    assert.equal(h.scenes.scene, null);
    assert.equal(h.counts.requests, 0, 'the sandbox preset needs no network, so this was purely the GPU window');
  } finally {
    h.restore();
  }
});
