/**
 * Deluge entry point: WebGPU feature detection, then boot the app.
 *
 * The App module (and with it every GPU module) is imported dynamically AFTER feature detection, so a
 * browser without WebGPU never evaluates code that might touch GPU globals (e.g. GPUBufferUsage) at
 * module top level — it gets the friendly unsupported screen instead of a ReferenceError.
 */
import { installDebugHandle, type DebugHandle } from './app/debugHandle';
import { showFatalError, showWebGPUUnsupported, WebGPUUnavailableError } from './app/unsupported';

/**
 * Automation surfaces (window.__deluge) only exist in a dev server or an explicitly flagged build
 * (`DELUGE_DEBUG_API=1 vite build`, which is what scripts/e2e.mjs does). A build-time constant, so a released bundle
 * contains none of this code at all — see src/env.d.ts and FINDINGS.json SEC-07.
 */
const DEBUG_API = import.meta.env.DEV || __DELUGE_DEBUG_API__;

/** Does nothing when the debug API is compiled out; the boot path below stays identical either way. */
const NO_DEBUG: DebugHandle = { bind() {}, fail() {} };

async function boot(): Promise<void> {
  // Synchronously, so automation can `await window.__deluge.ready` as soon as the page has loaded.
  const debug = DEBUG_API ? installDebugHandle() : NO_DEBUG;

  const canvas = document.getElementById('deluge-canvas');
  const uiRoot = document.getElementById('ui-root');
  if (!(canvas instanceof HTMLCanvasElement) || !uiRoot) {
    debug.fail('index.html is missing #deluge-canvas or #ui-root');
    showFatalError('index.html is missing #deluge-canvas or #ui-root');
    return;
  }

  if (!('gpu' in navigator) || !navigator.gpu) {
    const secure = window.isSecureContext ? '' : ' (WebGPU also requires a secure context: https or localhost)';
    const reason = `navigator.gpu is not available in this browser${secure}.`;
    debug.fail(`WebGPU unavailable: ${reason}`);
    showWebGPUUnsupported(reason);
    return;
  }

  let App: typeof import('./app/App').App;
  try {
    ({ App } = await import('./app/App'));
  } catch (err) {
    console.error('[deluge] failed to load application modules', err);
    debug.fail(`module load failed: ${err instanceof Error ? err.message : String(err)}`);
    showFatalError(err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err));
    return;
  }

  const app = new App(canvas, uiRoot);
  // Imported dynamically so the whole debug API (and its downsampling helpers) drops out of a non-debug build.
  if (DEBUG_API) debug.bind((await import('./app/debugApi')).createDebugApi(app, app.ready));
  try {
    await app.start();
  } catch (err) {
    if (err instanceof WebGPUUnavailableError) {
      console.warn('[deluge] WebGPU unavailable:', err.message);
      app.errors.record('webgpu', `WebGPU unavailable: ${err.message}`);
      showWebGPUUnsupported(`Could not create a WebGPU device: ${err.message}`);
    } else {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      app.errors.report('startup', err instanceof Error ? err.message : String(err), err);
      showFatalError(message);
    }
  }
}

void boot();
