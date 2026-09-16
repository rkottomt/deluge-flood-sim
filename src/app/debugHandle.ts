import type { DelugeDebug } from './debugApi';

/**
 * `window.__deluge` must exist as soon as the entry module runs (automation awaits `__deluge.ready` right
 * after the page's load event), but the real implementation only exists once the App module has been
 * imported dynamically. This installs a tiny forwarding facade synchronously:
 *   • `ready` resolves/rejects with the real API's ready (or with a startup failure),
 *   • `errors` is the real list once bound (early errors are carried over),
 *   • every other property forwards to the implementation; calling a method before binding throws a
 *     descriptive error instead of "undefined is not a function".
 */
export interface DebugHandle {
  bind(impl: DelugeDebug): void;
  /** Startup failed (e.g. WebGPU unavailable): reject `ready` and record the reason. */
  fail(reason: string): void;
}

export function installDebugHandle(): DebugHandle {
  let impl: DelugeDebug | null = null;
  const earlyErrors: string[] = [];
  let resolveReady!: () => void;
  let rejectReady!: (err: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {}); // a failed start must not surface as an unhandled rejection

  const facade = new Proxy({} as DelugeDebug, {
    get(_target, key) {
      if (key === 'ready') return ready;
      if (key === 'errors') return impl ? impl.errors : earlyErrors;
      if (impl) {
        const value = (impl as unknown as Record<PropertyKey, unknown>)[key];
        return typeof value === 'function' ? value.bind(impl) : value;
      }
      if (typeof key === 'symbol' || key === 'then' || key === 'toJSON') return undefined;
      return () => {
        throw new Error(`__deluge.${String(key)}: Deluge is still starting — await window.__deluge.ready first`);
      };
    },
    has(_target, key) {
      return key === 'ready' || key === 'errors' || (!!impl && key in impl);
    },
  });
  window.__deluge = facade;

  return {
    bind(real) {
      impl = real;
      if (earlyErrors.length) real.errors.unshift(...earlyErrors);
      real.ready.then(resolveReady, rejectReady);
    },
    fail(reason) {
      if (impl) impl.errors.push(reason);
      else earlyErrors.push(reason);
      rejectReady(new Error(reason));
    },
  };
}
