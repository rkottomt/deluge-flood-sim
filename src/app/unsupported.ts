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
  /** Plain-text advice for the browser the page is actually open in, shown above the generic lists. */
  hint?: string | null;
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
      #${SCREEN_ID} p.hint { padding: 12px 14px; border-radius: 10px; color: #eaf6ff;
        background: rgba(60, 150, 230, 0.16); border: 1px solid rgba(143, 211, 255, 0.28); }
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
      <p class="hint" hidden></p>
      ${opts.bodyHtml}
      <details hidden><summary>Technical details</summary><pre></pre></details>
      <button type="button"></button>
    </div>`;
  // Dynamic strings go through textContent (never innerHTML).
  root.querySelector('h1')!.textContent = opts.title;
  root.querySelector('.lead')!.textContent = opts.lead;
  if (opts.hint) {
    const hint = root.querySelector<HTMLElement>('.hint')!;
    hint.hidden = false;
    hint.textContent = opts.hint;
  }
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

/**
 * The exact phrase src/gpu.ts throws when `requestAdapter()` resolves to null. That case is NOT "this browser has no
 * WebGPU" — the API is there and the page is a secure context, but the browser refuses to expose a GPU (hardware
 * acceleration off, a blocklisted driver, a VM / remote desktop, or a headless run with no GPU). The advice is
 * completely different, so the screen says so instead of telling a Chrome user to install Chrome.
 * (Kept as a string rather than an import: this module must stay loadable without any GPU module — see main.ts.)
 */
export const NO_ADAPTER_MESSAGE = 'No WebGPU adapter available';

/**
 * Advice for the browser the page is actually open in, when there is something specific to say (null otherwise).
 * Brave reports a Chrome user agent, so it is identified by `navigator.brave` instead.
 */
export function browserHint(ua: string, isBrave: boolean): string | null {
  const safari = /Version\/(\d+)(?:\.(\d+))?[^)]*Safari\//.exec(ua);
  if (safari && !/(Chrome|Chromium|CriOS|FxiOS|EdgiOS|Edg)\//.test(ua)) {
    const major = Number(safari[1]);
    if (major >= 26) {
      return (
        `You’re on Safari ${safari[1]}, which ships WebGPU. If this screen is showing anyway, the flag may have been ` +
        'turned off: Safari → Settings → Advanced → “Show features for web developers”, then Develop → Feature Flags… → WebGPU.'
      );
    }
    const version = safari[2] ? `${safari[1]}.${safari[2]}` : safari[1];
    if (/iPhone|iPad|iPod/.test(ua)) {
      return (
        `You’re on Safari ${version}, where WebGPU is built in but switched off. Turn it on in the Settings app: ` +
        'Apps → Safari → Advanced → Feature Flags → WebGPU, then reload. Or update to iOS / iPadOS 26, where it is on by default.'
      );
    }
    return (
      `You’re on Safari ${version} (macOS 15 ships 18.x), where WebGPU is built in but switched off. Turn it on: ` +
      'Safari → Settings → Advanced → “Show features for web developers”, then Develop → Feature Flags… → WebGPU, ' +
      'and reload this page. Or update to Safari 26 (System Settings → General → Software Update), where it is on by default.'
    );
  }
  if (isBrave) {
    return (
      'You’re on Brave, which supports WebGPU with no flags. Check brave://settings/system → “Use graphics ' +
      'acceleration when available” is on, relaunch Brave, then check brave://gpu lists WebGPU as hardware accelerated.'
    );
  }
  const firefox = /Firefox\/(\d+)/.exec(ua);
  if (firefox) {
    return (
      `You’re on Firefox ${firefox[1]}. Firefox ships WebGPU on Windows (141+) and on Apple-silicon Macs (147+); ` +
      'elsewhere it is still behind dom.webgpu.enabled in about:config, so use Chrome, Edge, Brave or Safari 26.'
    );
  }
  return null;
}

export function showWebGPUUnsupported(reason: string): void {
  const noAdapter = reason.includes(NO_ADAPTER_MESSAGE);
  const isBrave = typeof navigator !== 'undefined' && 'brave' in navigator;
  showScreen({
    title: noAdapter ? 'No graphics adapter for Deluge' : 'This browser can’t run Deluge (yet)',
    lead: noAdapter
      ? 'This browser supports WebGPU, but it would not hand out a graphics adapter — so there is no GPU to solve ' +
        'the shallow-water equations on. That is almost always a setting or a driver, not the browser.'
      : 'Deluge solves the shallow-water flood equations on your graphics card with WebGPU compute shaders. ' +
        'WebGPU isn’t available here, so the simulation can’t start.',
    // The adapter-is-null case is not about which browser you have, so the per-browser hint is only for the other one.
    hint: noAdapter ? null : browserHint(typeof navigator === 'undefined' ? '' : navigator.userAgent, isBrave),
    bodyHtml: noAdapter
      ? `
      <h2>What to try, in order</h2>
      <ul>
        <li>Turn hardware acceleration on and relaunch the browser
          (Chrome/Brave: <code>Settings → System → Use graphics acceleration when available</code>;
          the same page is <code>brave://settings/system</code>).</li>
        <li>Check <code>chrome://gpu</code> (or <code>brave://gpu</code>): <i>WebGPU</i> must say
          <i>Hardware accelerated</i>. If it says <i>Disabled</i>, the reason is printed on that page.</li>
        <li>Close other GPU-heavy apps and tabs — a GPU that is out of memory can refuse a new adapter — then reload.</li>
        <li>Update the graphics driver; very old or blocklisted GPUs are refused on purpose.</li>
        <li>Virtual machines, remote desktops and screen-sharing sessions often have no GPU to give. Run Deluge on the
          machine itself.</li>
      </ul>`
      : `
      <h2>Supported browsers</h2>
      <ul>
        <li><b>Chrome</b>, <b>Edge</b> or <b>Brave</b> 113+ on Windows, macOS or ChromeOS (Chrome 121+ on Android)</li>
        <li><b>Safari</b> 26+ on macOS, iOS and iPadOS</li>
        <li><b>Firefox</b> 141+ on Windows, 147+ on Apple-silicon Macs</li>
      </ul>
      <h2>If you’re already on one of those</h2>
      <ul>
        <li>Make sure hardware acceleration is on (Chrome/Brave: <code>Settings → System → Use graphics acceleration</code>),
          then check <code>chrome://gpu</code> lists <i>WebGPU: Hardware accelerated</i>.</li>
        <li>Safari 18 on macOS 15: <code>Settings → Advanced → Show features for web developers</code>, then
          <code>Develop → Feature Flags… → WebGPU</code>, and reload.</li>
        <li>Linux Chrome: enable <code>chrome://flags/#enable-unsafe-webgpu</code> and <code>#enable-vulkan</code>, then relaunch.</li>
        <li>WebGPU also needs a secure context: <code>https://</code> or <code>localhost</code>, never a plain
          <code>http://</code> address or a <code>file://</code> path.</li>
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
/** A second loss sooner than this after an automatic reload really is "again, right after restarting". */
export const AUTO_RELOAD_SETTLED_MS = 120_000;

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

/**
 * When this tab last reloaded itself after a device loss, in ms before `now` (null: it never did, or no storage).
 * Read BEFORE claimAutoReload, which appends to the same list.
 */
export function sinceLastAutoReload(storage: Pick<Storage, 'getItem'> | null, now: number): number | null {
  if (!storage) return null;
  try {
    const ages = readReloads(storage.getItem(AUTO_RELOAD_KEY))
      .map((t) => now - t)
      .filter((age) => age >= 0);
    return ages.length ? Math.min(...ages) : null;
  } catch {
    return null;
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

/** The offline scene offered (or chosen automatically) after a device loss on a non-default scene. */
export interface LighterScene {
  /** Human name, e.g. "Pittsburgh". */
  label: string;
  /**
   * The app may switch to it WITHOUT asking on a second loss (see claimAutoReload). Only true when the lost scene was
   * a live area or a grid larger than the presets — the cases a repeated loss really blames. For any other non-default
   * scene the card just offers it as a button, because silently changing the scenario mid-demo would be worse.
   */
  auto: boolean;
  /** Point the address bar at it (called before the reload). */
  select(): void;
}

/** "4 minutes", "40 seconds": how long a scene ran, in words, for the device-lost card. */
function humanDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${Math.max(1, s)} second${s === 1 ? '' : 's'}`;
  const m = Math.round(s / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/**
 * The lead paragraph of the device-lost card. Split out (and exported) because getting it WRONG is the bug the soak
 * found: the manual card claimed the driver "reset again after restarting" even when the page had run happily for
 * minutes in between, which sends the presenter hunting for a problem that isn't there.
 */
export function deviceLostLead(opts: {
  plan: AutoReloadPlan;
  /** sessionStorage is usable (without it the app can never reload itself, and says so). */
  hasStorage: boolean;
  /** ms since this tab last reloaded itself after a loss (null: it never did). */
  sinceAutoReloadMs: number | null;
  /** Name of the offline scenario offered as a way out ("Pittsburgh"), or null when this IS that scenario. */
  lighterLabel: string | null;
}): string {
  const { plan, hasStorage, sinceAutoReloadMs, lighterLabel } = opts;
  const driverReset =
    'The graphics driver reset, which can happen after sleep/wake, a driver hiccup or when GPU memory runs out.';
  if (plan === 'reload') {
    return `${driverReset} The simulation lived on the GPU, so Deluge restarts to bring it back.`;
  }
  if (!hasStorage) {
    return `${driverReset} The simulation lived on the GPU: reload to bring it back.`;
  }
  // Everything below is a SECOND loss in this tab. How long the scene survived the first restart is the whole story.
  const ran = sinceAutoReloadMs === null ? null : humanDuration(sinceAutoReloadMs);
  const soon = sinceAutoReloadMs !== null && sinceAutoReloadMs < AUTO_RELOAD_SETTLED_MS;
  if (plan === 'lighter') {
    const why = soon
      ? `The graphics driver reset again ${ran} after Deluge restarted, so this area probably needs more GPU memory than is free.`
      : ran
        ? `The graphics driver reset again. The scene ran for ${ran} after the last restart, so it is not obviously too heavy — but twice is twice.`
        : 'The graphics driver reset again after restarting, so this area may need more GPU memory than is free.';
    return `${why} Deluge restarts with the offline ${lighterLabel ?? 'default'} scenario instead.`;
  }
  // 'manual': Deluge will not reload itself a third time, so say what it saw and let the user choose.
  const tail = lighterLabel
    ? `Reload this scene to try again, or start with the offline ${lighterLabel} scenario, which is the lightest one.`
    : 'Close other GPU-heavy tabs or apps, then reload. If it keeps happening, restart the browser.';
  if (soon) {
    return `The graphics driver reset again, ${ran} after Deluge restarted. Close other GPU-heavy tabs or apps first. ${tail}`;
  }
  if (ran) {
    return `The graphics driver reset again. The scene ran for ${ran} after the last restart, so this looks like another one-off rather than a scene this machine can’t handle — but Deluge doesn’t restart itself twice in a row. ${tail}`;
  }
  return `${driverReset} Deluge has already restarted itself as often as it will in one go. ${tail}`;
}


/**
 * The GPU device was lost at runtime (GPU-process crash or reset: sleep/wake, a driver hiccup, the browser's GPU
 * watchdog, running out of GPU memory). Every GPU resource is gone, so the only honest state is a full-screen
 * card: the page reloads itself after a short countdown (a baked preset is back in about a second), a live area or an
 * oversized grid that keeps losing the GPU restarts as the offline default scenario, and anything more waits for the
 * user — with "Start with <default>" next to Reload whenever the lost scene was not that scenario already, and with a
 * lead that says what actually happened rather than assuming the scene is too heavy (see deviceLostLead).
 */
export function showDeviceLost(details: string, lighter: LighterScene | null = null): void {
  const storage = sessionStore();
  const now = Date.now();
  // Read the history before claiming: claimAutoReload appends to it.
  const sinceAutoReloadMs = sinceLastAutoReload(storage, now);
  const plan = claimAutoReload(storage, now, !!lighter?.auto);
  if (plan === 'lighter') lighter?.select();
  const lead = deviceLostLead({ plan, hasStorage: !!storage, sinceAutoReloadMs, lighterLabel: lighter?.label ?? null });
  const root = showScreen({
    title: 'Lost connection to the GPU',
    lead,
    bodyHtml: plan === 'manual' ? '' : '<p class="countdown" aria-live="polite"></p>',
    details,
    buttonLabel: plan === 'manual' ? (lighter ? 'Reload this scene' : 'Reload') : 'Reload now',
    // Waiting for the user on anything but the offline default scenario: offer that as the way out, so the answer is
    // never "Reload, and hope" on a scene that just failed twice.
    secondary:
      plan === 'manual' && lighter
        ? {
            label: `Start with ${lighter.label}`,
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
