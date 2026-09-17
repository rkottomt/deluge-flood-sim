import type { Store } from '../contracts';

/** Max distinct entries kept in the public errors list (a runaway validation error must not eat memory). */
const MAX_ERRORS = 200;
/** Identical messages are logged to the console at most this many times. */
const MAX_CONSOLE_REPEATS = 3;
/** Minimum spacing between error toasts. */
const TOAST_INTERVAL_MS = 1500;

/**
 * Collects every runtime error the app can observe — WebGPU uncaptured errors, device loss, uncaught
 * exceptions, unhandled promise rejections and errors thrown inside the frame loop — into one list
 * (exposed as `__deluge.errors`), logs them, and surfaces them to the user as a toast.
 */
export class ErrorReporter {
  /** Public, append-only list (the same array instance is exposed through the debug API). */
  readonly errors: string[] = [];
  private readonly counts = new Map<string, number>();
  private lastToast = 0;
  private store: Store | null = null;
  /** No more toasts (set once a full-screen failure screen owns the message). */
  private muted = false;

  /** Attach the store so errors become user-visible toasts. Earlier errors are toasted immediately. */
  attachStore(store: Store): void {
    this.store = store;
    const last = this.errors[this.errors.length - 1];
    if (last) this.toast(last);
  }

  installWindowHandlers(): void {
    window.addEventListener('error', (ev) => {
      // Resource load errors (img/script) arrive with no `error` object; ignore those without a message.
      const msg = ev.error instanceof Error ? ev.error.message : ev.message;
      if (msg) this.report('window', msg, ev.error);
    });
    window.addEventListener('unhandledrejection', (ev) => {
      const reason = ev.reason;
      const msg = reason instanceof Error ? reason.message : String(reason);
      this.report('promise', msg, reason);
    });
  }

  /**
   * Report WebGPU validation/OOM errors, and device loss. `onLost` takes over the user-facing side of a loss (the
   * app shows a full-screen card); from then on errors are still recorded and logged but no longer toasted, since
   * every GPU call fails in the aftermath and those toasts would only bury the real message.
   */
  attachDevice(device: GPUDevice, onLost?: (info: GPUDeviceLostInfo) => void): void {
    device.addEventListener('uncapturederror', (ev) => {
      const e = (ev as GPUUncapturedErrorEvent).error;
      this.report('webgpu', `${e.constructor?.name ?? 'GPUError'}: ${e.message}`);
    });
    void device.lost.then((info) => {
      // Every reason counts, including 'destroyed': the app never destroys its own device, so that one came from
      // outside (e.g. the console) and leaves the page just as dead.
      const text = `GPU device lost (${info.reason ?? 'unknown'}): ${info.message || 'no details'}`;
      if (onLost) {
        this.muted = true;
        this.report('webgpu', text);
        onLost(info);
      } else {
        this.report('webgpu', `${text}. Reload the page to continue.`);
      }
    });
  }

  /** Record an expected, already-handled failure (e.g. WebGPU unavailable) without logging an error or toasting. */
  record(source: string, message: string): void {
    const text = `[${source}] ${message}`;
    if (!this.counts.has(text) && this.errors.length < MAX_ERRORS) this.errors.push(text);
    this.counts.set(text, (this.counts.get(text) ?? 0) + 1);
  }

  /**
   * Record an error. `source` is a short tag (webgpu, window, promise, frame, load…).
   * Returns the formatted message.
   */
  report(source: string, message: string, cause?: unknown): string {
    const text = `[${source}] ${message}`;
    const n = (this.counts.get(text) ?? 0) + 1;
    this.counts.set(text, n);
    if (n === 1 && this.errors.length < MAX_ERRORS) this.errors.push(text);
    if (n <= MAX_CONSOLE_REPEATS) {
      if (cause !== undefined && cause !== null && typeof cause === 'object') console.error(`[deluge]${text}`, cause);
      else console.error(`[deluge]${text}`);
      if (n === MAX_CONSOLE_REPEATS) console.error(`[deluge] (further repeats of this error are suppressed)`);
    }
    this.toast(message);
    return text;
  }

  /** Show a message in the UI toast (rate limited). Not recorded as an error. */
  toast(message: string, force = false): void {
    const store = this.store;
    if (!store || this.muted) return;
    const now = performance.now();
    if (!force && now - this.lastToast < TOAST_INTERVAL_MS) return;
    this.lastToast = now;
    // Clear first so repeating the same message re-triggers the toast.
    store.set({ error: null });
    store.set({ error: message });
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
