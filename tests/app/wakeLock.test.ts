/**
 * Screen Wake Lock keeper (src/app/wakeLock.ts) — the thing that stops the demo laptop's display from sleeping
 * mid-pitch. Driven through an injected host, so these run with no DOM and no browser.
 * Run: node --import tsx --test tests/app/wakeLock.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepScreenAwake, type WakeLockHost, type WakeLockSentinelLike } from '../../src/app/wakeLock';

/** A fake sentinel that records releases and can be released by "the browser" like Chrome's battery saver does. */
class FakeSentinel implements WakeLockSentinelLike {
  released = false;
  private listeners: (() => void)[] = [];
  constructor(readonly id: number) {}
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    for (const fn of this.listeners.slice()) fn();
  }
  addEventListener(_type: 'release', listener: () => void): void {
    this.listeners.push(listener);
  }
  /** The browser took it away (tab hidden, battery saver, OS policy). */
  revoke(): void {
    void this.release();
  }
}

interface Harness {
  host: WakeLockHost;
  sentinels: FakeSentinel[];
  requests: number;
  visible: boolean;
  setVisible(v: boolean): void;
  /** Run every retry scheduled so far (the fake setTimeout), in order. */
  runTimers(): void;
  /** Make the next `n` requests reject with this error. */
  failNext(n: number, err: Error): void;
}

function harness(opts: { supported?: boolean } = {}): Harness {
  const sentinels: FakeSentinel[] = [];
  let timers: (() => void)[] = [];
  let listeners: (() => void)[] = [];
  let failures = 0;
  let failWith: Error | null = null;
  const h: Harness = {
    sentinels,
    requests: 0,
    visible: true,
    host: {
      request:
        opts.supported === false
          ? null
          : async () => {
              h.requests++;
              if (failures > 0) {
                failures--;
                throw failWith ?? new Error('refused');
              }
              const s = new FakeSentinel(sentinels.length);
              sentinels.push(s);
              return s;
            },
      isVisible: () => h.visible,
      onVisibilityChange: (fn) => listeners.push(fn),
      delay: (fn) => timers.push(fn),
    },
    setVisible(v) {
      h.visible = v;
      for (const fn of listeners.slice()) fn();
    },
    runTimers() {
      const due = timers;
      timers = [];
      for (const fn of due) fn();
    },
    failNext(n, err) {
      failures = n;
      failWith = err;
    },
  };
  return h;
}

/** The request path is async; let the microtasks settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test('wakeLock: holds the screen awake as soon as the page is visible', async () => {
  const h = harness();
  const lock = keepScreenAwake(h.host);
  assert.equal(lock.status.supported, true);
  assert.equal(lock.status.requesting, true, 'a request goes out immediately, not on the first frame');
  await settle();
  assert.equal(lock.status.held, true, 'the display is held awake');
  assert.equal(lock.status.acquired, 1);
  assert.equal(h.sentinels.length, 1);
  assert.equal(h.sentinels[0].released, false);
  assert.equal(lock.status.lastError, null);

  // sync() while already held must not pile up sentinels (the store/pacer may call it often).
  lock.sync();
  lock.sync();
  await settle();
  assert.equal(h.requests, 1, 'one sentinel at a time');
});

test('wakeLock: released when the tab is hidden and re-requested when it comes back', async () => {
  const h = harness();
  const lock = keepScreenAwake(h.host);
  await settle();
  assert.equal(lock.status.held, true);

  h.setVisible(false);
  await settle();
  assert.equal(lock.status.held, false, 'nothing held while hidden (the OS may sleep the screen)');
  assert.equal(h.sentinels[0].released, true, 'the sentinel is handed back, not just forgotten');
  assert.equal(h.requests, 1, 'no request while hidden');

  h.setVisible(true);
  await settle();
  assert.equal(lock.status.held, true, 're-requested on visibilitychange — the whole point');
  assert.equal(lock.status.acquired, 2);
  assert.equal(h.sentinels.length, 2);
});

test('wakeLock: a browser-initiated release while visible is re-requested (battery saver)', async () => {
  const h = harness();
  const lock = keepScreenAwake(h.host);
  await settle();
  const first = h.sentinels[0];

  first.revoke(); // Chrome's battery saver drops the lock without a visibility change
  await settle();
  assert.equal(lock.status.held, false);
  assert.equal(lock.status.releases, 1);
  assert.equal(h.requests, 1, 'the retry is scheduled, not fired synchronously (no hot loop)');

  h.runTimers();
  await settle();
  assert.equal(lock.status.held, true, 'taken again');
  assert.equal(h.sentinels.length, 2);
});

test('wakeLock: a refusal is recorded, retried a few times, then left alone until the page is looked at again', async () => {
  const h = harness();
  const err = new Error('The requesting page is not visible');
  err.name = 'NotAllowedError';
  h.failNext(99, err);
  const lock = keepScreenAwake(h.host);
  await settle();
  assert.equal(lock.status.held, false);
  assert.equal(lock.status.lastError, 'NotAllowedError: The requesting page is not visible');

  for (let i = 0; i < 10; i++) {
    h.runTimers();
    await settle();
  }
  assert.equal(h.requests, 4, 'the first try plus MAX_RETRIES, then it stops asking');

  // Coming back to the page is a fresh chance.
  h.failNext(0, err);
  h.setVisible(false);
  await settle();
  h.setVisible(true);
  await settle();
  assert.equal(lock.status.held, true);
  assert.equal(lock.status.lastError, null, 'a success clears the last refusal');
});

test('wakeLock: a browser without the API is silent — no throw, nothing held', async () => {
  const h = harness({ supported: false });
  const lock = keepScreenAwake(h.host);
  await settle();
  assert.equal(lock.status.supported, false);
  assert.equal(lock.status.held, false);
  assert.equal(lock.status.lastError, null, 'not supported is not an error to report');
  lock.sync();
  h.setVisible(false);
  h.setVisible(true);
  await settle();
  assert.equal(h.requests, 0);
});

test('wakeLock: dispose() hands the lock back and stops re-requesting', async () => {
  const h = harness();
  const lock = keepScreenAwake(h.host);
  await settle();
  lock.dispose();
  await settle();
  assert.equal(lock.status.held, false);
  assert.equal(h.sentinels[0].released, true);
  h.setVisible(false);
  h.setVisible(true);
  await settle();
  assert.equal(h.requests, 1, 'no further requests after dispose');
});

test('wakeLock: a lock that arrives after the tab was hidden is handed straight back', async () => {
  const h = harness();
  const lock = keepScreenAwake(h.host);
  // Hidden while the request is still in flight.
  h.visible = false;
  await settle();
  assert.equal(lock.status.held, false, 'not held: the page is no longer visible');
  assert.equal(h.sentinels[0].released, true, 'released instead of leaking');
});
