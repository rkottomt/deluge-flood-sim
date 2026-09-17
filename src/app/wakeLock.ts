/**
 * Screen Wake Lock: keep the display awake while the Deluge tab is visible.
 *
 * A running WebGPU simulation is not "user activity" to macOS, so the demo laptop dims and blanks its display
 * mid-pitch (2 min on battery, 10 min on the adapter on this Air). The Screen Wake Lock API is the browser's way
 * to say "someone is watching this": Chromium (and Brave) hold it without any user gesture as long as the document
 * is visible and the page is a secure context (https or localhost).
 *
 * The browser releases the lock by itself whenever the tab is hidden, the window is minimised or the OS takes over
 * (lid closed, battery saver). `visibilitychange` therefore has to re-request it — that is the whole point of the
 * re-request path, not an optimisation. Browsers without the API (Safari 18/26 today) get nothing and no error:
 * the presenter checklist still mentions `caffeinate -dis` as the belt-and-braces fallback.
 */

/** Just the part of WakeLockSentinel this module uses (so tests can supply a fake). */
export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** Everything the keeper touches outside itself; `domWakeLockHost()` binds it to the real page. */
export interface WakeLockHost {
  /** null when this browser has no navigator.wakeLock (or no secure context). */
  request: ((type: 'screen') => Promise<WakeLockSentinelLike>) | null;
  isVisible(): boolean;
  onVisibilityChange(listener: () => void): void;
  /** Schedule a retry (setTimeout in the browser). */
  delay(fn: () => void, ms: number): void;
}

/** Observable state, for the HUD-less checks that automation and the DEMO checklist rely on. */
export interface WakeLockStatus {
  /** The API exists in this browser. */
  supported: boolean;
  /** A sentinel is held right now (the display will not sleep). */
  held: boolean;
  /** A request is in flight. */
  requesting: boolean;
  /** How many times a sentinel has been acquired in this page (re-requests included). */
  acquired: number;
  /** How many times the browser released a sentinel out from under us. */
  releases: number;
  /** Last refusal (`NotAllowedError: ...`), or null. */
  lastError: string | null;
}

export interface ScreenWakeLock {
  readonly status: WakeLockStatus;
  /** Re-evaluate whether the lock should be held (visibility change, or any caller-side change). */
  sync(): void;
  /** Release the lock and stop re-requesting it. */
  dispose(): void;
}

/** A refused request is retried this many times (backing off) before the page gives up until the next visibility change. */
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;

/**
 * Hold a screen wake lock for as long as the page is visible. Returns a handle whose `status` can be inspected
 * (`window.__deluge.getWakeLock()` in debug builds) and whose `sync()` re-evaluates on demand.
 */
export function keepScreenAwake(host: WakeLockHost = domWakeLockHost()): ScreenWakeLock {
  const status: WakeLockStatus = {
    supported: !!host.request,
    held: false,
    requesting: false,
    acquired: 0,
    releases: 0,
    lastError: null,
  };
  let sentinel: WakeLockSentinelLike | null = null;
  let retries = 0;
  let disposed = false;

  const wanted = (): boolean => !disposed && !!host.request && host.isVisible();

  const sync = (): void => {
    const request = host.request;
    if (!request) return;
    if (!wanted()) {
      // Hidden (or disposed): drop the sentinel. Chromium releases it on its own, but saying so explicitly keeps
      // `status.held` honest and matches browsers that do not.
      const held = sentinel;
      sentinel = null;
      status.held = false;
      if (held && !held.released) void held.release().catch(() => {});
      return;
    }
    if (sentinel || status.requesting) return;
    status.requesting = true;
    request('screen').then(
      (s) => {
        status.requesting = false;
        status.acquired++;
        status.lastError = null;
        retries = 0;
        s.addEventListener('release', () => {
          if (sentinel !== s) return;
          sentinel = null;
          status.held = false;
          status.releases++;
          // The browser let go while we still want it (battery saver, an OS policy): try again, backing off.
          if (wanted()) scheduleRetry();
        });
        // Hidden again while the request was in flight: release it right back.
        if (!wanted()) {
          void s.release().catch(() => {});
          return;
        }
        sentinel = s;
        status.held = true;
      },
      (err: unknown) => {
        status.requesting = false;
        status.lastError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        if (wanted()) scheduleRetry();
      },
    );
  };

  const scheduleRetry = (): void => {
    if (retries >= MAX_RETRIES) return;
    const wait = RETRY_BASE_MS * 2 ** retries;
    retries++;
    host.delay(() => {
      if (wanted() && !sentinel) sync();
    }, wait);
  };

  host.onVisibilityChange(() => {
    // A fresh look at the page is a fresh chance: forget earlier refusals.
    if (host.isVisible()) retries = 0;
    sync();
  });
  sync();

  return {
    status,
    sync,
    dispose() {
      disposed = true;
      sync();
    },
  };
}

/** Bind a keeper to the real document; `request` is null when the browser has no Screen Wake Lock API. */
export function domWakeLockHost(): WakeLockHost {
  const api = typeof navigator !== 'undefined' ? (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock : undefined;
  return {
    request: api ? (type) => api.request(type) as unknown as Promise<WakeLockSentinelLike> : null,
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    onVisibilityChange: (listener) => {
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', listener);
    },
    delay: (fn, ms) => {
      setTimeout(fn, ms);
    },
  };
}
