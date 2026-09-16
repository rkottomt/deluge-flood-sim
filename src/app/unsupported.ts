/**
 * Full-screen fallback screens shown when the app cannot run: WebGPU missing / device creation failed,
 * or a fatal startup error. Self-contained (inline styles, no imports) because it must work even when the
 * rest of the app — including the UI stylesheet — never loads.
 */

export class WebGPUUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebGPUUnavailableError';
  }
}

const SCREEN_ID = 'deluge-fatal';

interface FatalScreenOptions {
  title: string;
  lead: string;
  /** Trusted, static HTML (never user/remote content). */
  bodyHtml: string;
  details?: string;
}

function showScreen(opts: FatalScreenOptions): void {
  document.getElementById('boot')?.remove();
  document.getElementById(SCREEN_ID)?.remove();

  const root = document.createElement('div');
  root.id = SCREEN_ID;
  root.setAttribute('role', 'alert');
  root.innerHTML = `
    <style>
      #${SCREEN_ID} { position: fixed; inset: 0; z-index: 10000; overflow: auto; display: grid; place-items: center;
        padding: 24px; box-sizing: border-box; color: #dce6f5; background:
        radial-gradient(1200px 700px at 20% 110%, rgba(34, 116, 196, 0.35), transparent 60%),
        radial-gradient(900px 600px at 90% -10%, rgba(40, 180, 200, 0.18), transparent 60%), #05070d;
        font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      #${SCREEN_ID} .card { max-width: 640px; width: 100%; padding: 32px 36px; border-radius: 18px;
        background: rgba(16, 22, 36, 0.72); border: 1px solid rgba(140, 180, 255, 0.16);
        box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5); backdrop-filter: blur(14px); }
      #${SCREEN_ID} .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: 0.02em;
        color: #8fd3ff; font-size: 14px; text-transform: uppercase; }
      #${SCREEN_ID} h1 { margin: 18px 0 8px; font-size: 26px; line-height: 1.25; color: #fff; font-weight: 650; }
      #${SCREEN_ID} p { margin: 0 0 14px; color: #b7c4d8; }
      #${SCREEN_ID} h2 { margin: 22px 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.08em; color: #8fa3bf; }
      #${SCREEN_ID} ul { margin: 0; padding-left: 20px; color: #cdd8e8; }
      #${SCREEN_ID} li { margin: 4px 0; }
      #${SCREEN_ID} code { font: 13px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #9fe1ff;
        background: rgba(120, 170, 255, 0.1); padding: 1px 6px; border-radius: 5px;
        -webkit-box-decoration-break: clone; box-decoration-break: clone; }
      #${SCREEN_ID} details { margin-top: 20px; color: #8fa3bf; font-size: 13px; }
      #${SCREEN_ID} pre { white-space: pre-wrap; word-break: break-word; margin: 8px 0 0; padding: 10px 12px;
        border-radius: 8px; background: rgba(0, 0, 0, 0.35); color: #c9d4e4; font: 12px ui-monospace, Menlo, monospace; }
      #${SCREEN_ID} button { margin-top: 22px; padding: 10px 18px; border-radius: 10px; border: 1px solid rgba(143, 211, 255, 0.4);
        background: rgba(60, 150, 230, 0.25); color: #eaf6ff; font: inherit; font-weight: 600; cursor: pointer; }
      #${SCREEN_ID} button:hover { background: rgba(60, 150, 230, 0.4); }
    </style>
    <div class="card">
      <div class="brand">${LOGO_SVG}<span>Deluge</span></div>
      <h1></h1>
      <p class="lead"></p>
      ${opts.bodyHtml}
      <details hidden><summary>Technical details</summary><pre></pre></details>
      <button type="button">Try again</button>
    </div>`;
  // Dynamic strings go through textContent (never innerHTML).
  root.querySelector('h1')!.textContent = opts.title;
  root.querySelector('.lead')!.textContent = opts.lead;
  if (opts.details) {
    const details = root.querySelector('details')!;
    details.hidden = false;
    details.querySelector('pre')!.textContent = opts.details;
  }
  root.querySelector('button')!.addEventListener('click', () => window.location.reload());
  document.body.appendChild(root);
}

const LOGO_SVG = `<svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 6C22 20 14 30 14 40a18 18 0 0 0 36 0C50 30 42 20 32 6z" fill="#3aa0ff"/><path d="M18 42c5-3 9-3 14 0s9 3 14 0" stroke="#dff4ff" stroke-width="4" fill="none" stroke-linecap="round"/></svg>`;

export function showWebGPUUnsupported(reason: string): void {
  showScreen({
    title: 'This browser can’t run Deluge (yet)',
    lead:
      'Deluge solves the shallow-water flood equations on your graphics card with WebGPU compute shaders. ' +
      'WebGPU isn’t available here, so the simulation can’t start.',
    bodyHtml: `
      <h2>Supported browsers</h2>
      <ul>
        <li><b>Chrome</b> or <b>Edge</b> 113+ on Windows, macOS or ChromeOS (Chrome 121+ on Android)</li>
        <li><b>Safari</b> 26+ on macOS, iOS and iPadOS</li>
        <li><b>Firefox</b> 141+ on Windows</li>
      </ul>
      <h2>If you’re already on one of those</h2>
      <ul>
        <li>Make sure hardware acceleration is on (Chrome: <code>Settings → System → Use graphics acceleration</code>),
          then check <code>chrome://gpu</code> lists <i>WebGPU: Hardware accelerated</i>.</li>
        <li>Linux Chrome: enable <code>chrome://flags/#enable-unsafe-webgpu</code> and <code>#enable-vulkan</code>, then relaunch.</li>
        <li>Older Safari: <code>Develop → Feature Flags → WebGPU</code>.</li>
        <li>Very old or blocklisted GPUs and some virtual machines / remote desktops don’t expose a WebGPU adapter.</li>
      </ul>`,
    details: reason,
  });
}

export function showFatalError(error: string): void {
  showScreen({
    title: 'Deluge failed to start',
    lead: 'Something went wrong while setting up the GPU renderer. Reloading usually fixes transient GPU issues.',
    bodyHtml: '',
    details: error,
  });
}
