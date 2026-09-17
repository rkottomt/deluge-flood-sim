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
  /** Label of the reload button (default "Try again"). */
  buttonLabel?: string;
  /** A second, quieter button next to it. */
  secondary?: { label: string; run(): void };
}

function showScreen(opts: FatalScreenOptions): HTMLElement {
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
      #${SCREEN_ID} button.secondary { margin-left: 10px; background: transparent; border-color: rgba(143, 211, 255, 0.22); color: #b7c4d8; }
      #${SCREEN_ID} button.secondary:hover { background: rgba(60, 150, 230, 0.15); color: #eaf6ff; }
    </style>
    <div class="card">
      <div class="brand">${LOGO_SVG}<span>Deluge</span></div>
      <h1></h1>
      <p class="lead"></p>
      ${opts.bodyHtml}
      <details hidden><summary>Technical details</summary><pre></pre></details>
      <button type="button"></button>
    </div>`;
  // Dynamic strings go through textContent (never innerHTML).
  root.querySelector('h1')!.textContent = opts.title;
  root.querySelector('.lead')!.textContent = opts.lead;
  if (opts.details) {
    const details = root.querySelector('details')!;
    details.hidden = false;
    details.querySelector('pre')!.textContent = opts.details;
  }
  const button = root.querySelector('button')!;
  button.textContent = opts.buttonLabel ?? 'Try again';
  button.addEventListener('click', () => window.location.reload());
  if (opts.secondary) {
    const { label, run } = opts.secondary;
    const extra = document.createElement('button');
    extra.type = 'button';
    extra.className = 'secondary';
    extra.textContent = label;
    extra.addEventListener('click', run);
    button.after(extra);
  }
  document.body.appendChild(root);
  return root;
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

/** sessionStorage key: when the page reloaded itself after losing the GPU device (JSON array of ms since epoch). */
const AUTO_RELOAD_KEY = 'deluge:gpu-lost-reload-at';
/** A device loss this soon after an automatic reload waits for the user (no reload loops). */
export const AUTO_RELOAD_GUARD_MS = 60_000;
/** At most AUTO_RELOAD_MAX automatic reloads per this window, however far apart the losses are. */
export const AUTO_RELOAD_WINDOW_MS = 10 * 60_000;
export const AUTO_RELOAD_MAX = 2;
/** Countdown before the automatic reload, so the message can be read. */
export const AUTO_RELOAD_DELAY_MS = 3000;

/**
 * What to do after a device loss:
 *  - 'reload': reload the scene that was on screen;
 *  - 'lighter': reload into the offline default scenario instead (the lost scene was a live area or a large grid);
 *  - 'manual': show the card and wait for the user.
 */
export type AutoReloadPlan = 'reload' | 'lighter' | 'manual';

/**
 * Decide (and record) the automatic recovery from a device loss, per tab:
 *  - a loss within AUTO_RELOAD_GUARD_MS of the last automatic reload waits for the user;
 *  - at most AUTO_RELOAD_MAX automatic reloads per AUTO_RELOAD_WINDOW_MS. The first reloads the same scene (sleep/wake
 *    and driver resets are one-offs). The second means that scene keeps losing the GPU a few minutes in: it switches
 *    to the offline default scenario if `lighterAvailable` (the lost scene was a live area or a large grid), and
 *    otherwise waits for the user (reloading the same scene again would only repeat it);
 *  - without usable storage it never reloads by itself (a loop could not be detected).
 */
export function claimAutoReload(
  storage: Pick<Storage, 'getItem' | 'setItem'> | null,
  now: number,
  lighterAvailable = false,
): AutoReloadPlan {
  if (!storage) return 'manual';
  try {
    const recent = readReloads(storage.getItem(AUTO_RELOAD_KEY)).filter((t) => now - t >= 0 && now - t < AUTO_RELOAD_WINDOW_MS);
    if (recent.some((t) => now - t < AUTO_RELOAD_GUARD_MS) || recent.length >= AUTO_RELOAD_MAX) return 'manual';
    const plan: AutoReloadPlan = recent.length === 0 ? 'reload' : lighterAvailable ? 'lighter' : 'manual';
    if (plan === 'manual') return plan;
    storage.setItem(AUTO_RELOAD_KEY, JSON.stringify([...recent, now]));
    return plan;
  } catch {
    return 'manual';
  }
}

/** Stored reload times: a JSON array of numbers (or a single number, as older builds wrote). */
function readReloads(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.filter((t): t is number => typeof t === 'number' && Number.isFinite(t) && t > 0);
  } catch {
    return [];
  }
}

function sessionStore(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** The offline scene a repeatedly lost live area / large grid restarts with (see claimAutoReload). */
export interface LighterScene {
  /** Human name, e.g. "Pittsburgh — Three Rivers". */
  label: string;
  /** Point the address bar at it (called before the reload). */
  select(): void;
}

/**
 * The GPU device was lost at runtime (GPU-process crash or reset: sleep/wake, a driver hiccup, the browser's GPU
 * watchdog, running out of GPU memory). Every GPU resource is gone, so the only honest state is a full-screen
 * card: the page reloads itself after a short countdown (a baked preset is back in about a second), a scene that
 * keeps losing the GPU restarts as the offline default scenario (when it was not that already), and anything more
 * waits for the user instead of looping.
 */
export function showDeviceLost(details: string, lighter: LighterScene | null = null): void {
  const storage = sessionStore();
  const plan = claimAutoReload(storage, Date.now(), !!lighter);
  if (plan === 'lighter') lighter?.select();
  const lead =
    plan === 'reload'
      ? 'The graphics driver reset, which can happen after sleep/wake, a driver hiccup or when GPU memory runs out. ' +
        'The simulation lived on the GPU, so Deluge restarts to bring it back.'
      : plan === 'lighter'
        ? 'The graphics driver reset again after restarting, so this area may need more GPU memory than is free. ' +
          `Deluge restarts with the offline ${lighter?.label ?? 'default'} scenario instead.`
        : storage
          ? 'The graphics driver reset again after restarting. Close other GPU-heavy tabs or apps, then reload. ' +
            'If it keeps happening, restart the browser.'
          : 'The graphics driver reset, which can happen after sleep/wake, a driver hiccup or when GPU memory runs out. ' +
            'The simulation lived on the GPU: reload to bring it back.';
  const root = showScreen({
    title: 'Lost connection to the GPU',
    lead,
    bodyHtml: plan === 'manual' ? '' : '<p class="countdown" aria-live="polite"></p>',
    details,
    buttonLabel: plan === 'manual' ? 'Reload' : 'Reload now',
    // Waiting for the user on a live area or large grid: offer the offline scenario as the way out.
    secondary:
      plan === 'manual' && lighter
        ? {
            label: `Open ${lighter.label} (offline)`,
            run: () => {
              lighter.select();
              window.location.reload();
            },
          }
        : undefined,
  });
  if (plan === 'manual') return;
  const countdown = root.querySelector<HTMLElement>('.countdown')!;
  const deadline = performance.now() + AUTO_RELOAD_DELAY_MS;
  const tick = () => {
    const left = Math.ceil((deadline - performance.now()) / 1000);
    if (left <= 0) {
      countdown.textContent = 'Reloading…';
      window.location.reload();
      return;
    }
    countdown.textContent = `Reloading in ${left} s…`;
    window.setTimeout(tick, 250);
  };
  tick();
}
