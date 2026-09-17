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
