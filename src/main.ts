/**
 * Deluge entry point: WebGPU feature detection, then boot the app.
 *
 * The App module (and with it every GPU module) is imported dynamically AFTER feature detection, so a
 * browser without WebGPU never evaluates code that might touch GPU globals (e.g. GPUBufferUsage) at
 * module top level — it gets the friendly unsupported screen instead of a ReferenceError.
 */
import { installDebugHandle } from './app/debugHandle';
import { showFatalError, showWebGPUUnsupported, WebGPUUnavailableError } from './app/unsupported';

async function boot(): Promise<void> {
  // Synchronously, so automation can `await window.__deluge.ready` as soon as the page has loaded.
  const debug = installDebugHandle();

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
  debug.bind(app.debug);
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
