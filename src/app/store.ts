import type { AppState, Store } from '../contracts';

/**
 * Minimal synchronous store.
 *
 * `set` shallow-merges a patch and notifies subscribers synchronously when any patched key changed (by ===).
 *
 * Re-entrancy: a subscriber may itself call `set` (e.g. the stage-offset subscription rewrites `sources`).
 * The new state is applied immediately (so `get()` is always current), but its notification is deferred
 * until the current notification pass has finished. Every subscriber therefore sees a consistent sequence
 * of (state, prev) transitions — s0→s1 then s1→s2 — and nobody receives a stale `state` after a newer one.
 * A throwing subscriber is logged and does not prevent the others from running.
 */
export function createStore(initial: AppState): Store {
  let state = initial;
  /** State that every subscriber has already been told about. */
  let delivered = initial;
  let notifying = false;
  const subs = new Set<(s: AppState, prev: AppState) => void>();

  function flush(): void {
    notifying = true;
    try {
      // Loop until no subscriber produced a further change during the pass.
      while (delivered !== state) {
        const prev = delivered;
        const cur = state;
        delivered = cur;
        for (const fn of [...subs]) {
          try {
            fn(cur, prev);
          } catch (err) {
            console.error('[store] subscriber threw', err);
          }
        }
      }
    } finally {
      notifying = false;
    }
  }

  return {
    get: () => state,
    set(patch) {
      let changed = false;
      for (const k in patch) {
        if ((patch as Record<string, unknown>)[k] !== (state as unknown as Record<string, unknown>)[k]) {
          changed = true;
          break;
        }
      }
      if (!changed) return;
      state = { ...state, ...patch };
      if (!notifying) flush();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
  };
}
