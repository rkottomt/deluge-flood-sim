/**
 * Deluge — Electron wrapper, main process.
 *
 * One BrowserWindow showing the existing static build over a privileged `app://deluge/` scheme. No preload,
 * no IPC, no Node in the renderer, no listening TCP port. Every rule here traces back to a requirement in
 * artifacts/security-report/ELECTRON_REQUIREMENTS.md (R1…R14); the tag is on the line that implements it.
 *
 * ESM note: everything that must happen before the `ready` event (R1 enableSandbox, R4 scheme registration,
 * R12 switch check) runs in the synchronous top level below. There is deliberately no top-level `await`
 * anywhere in this module — Electron emits `ready` on the next turn of the loop after the entry module
 * evaluates, so a top-level await would let `ready` overtake these calls.
 */
import { app, BrowserWindow, Menu, powerSaveBlocker, protocol, screen, session, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CSP, EXTERNAL_LINKS, isAllowedDataUrl } from './endpoints.js';

const APP_ORIGIN = 'app://deluge';
const APP_URL = `${APP_ORIGIN}/`;

/* ------------------------------------------------------------------ R12: no debugger on a packaged build */

// Defence in depth only — the R11 fuses already refuse --inspect, and a same-user attacker is out of scope.
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags'];
if (app.isPackaged && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  console.error('[deluge] refusing to start: debugging switch on a packaged build');
  app.exit(1);
}

/* ------------------------------------------------------------------------------ R1: global hardening */

// Sandbox every renderer, including any future one. Must precede `ready`.
app.enableSandbox();

// No `ignore-certificate-errors`, `disable-web-security`, `allow-running-insecure-content`,
// `remote-debugging-*`, `enable-unsafe-webgpu`, `disable-site-isolation-trials`, `no-sandbox` or `js-flags`
// is appended anywhere in this file. WebGPU is on by default in Chromium on macOS.

/* --------------------------------------------------------- R4: privileged app:// scheme instead of file:// */

// `standard` gives a real origin so relative URLs, fetch('./presets/…'), module workers and CSP 'self' work;
// `secure` makes isSecureContext true, which WebGPU requires. bypassCSP / corsEnabled / allowServiceWorkers /
// stream are all deliberately absent.
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

/* ------------------------------------------------------------------- R6: headers sent on every response */

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), bluetooth=(), payment=()',
});

/* ------------------------------------------------------- R5: path-traversal-safe serving of the built app */

/** Every extension present in `dist/`, with an explicit type. Anything else — including .map — is 404. */
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.f32': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * Packaged: a fixed directory inside app.asar (R11 OnlyLoadAppFromAsar keeps it there).
 * Unpackaged: the repo's build output, with a dev-only override so the verification harness can point the
 * same main process at a test build. Never consulted once `app.isPackaged` is true.
 */
const ROOT = app.isPackaged
  ? path.join(import.meta.dirname, 'dist')
  : path.resolve(import.meta.dirname, '..', process.env.DELUGE_DIST || 'dist');

async function serveApp(request) {
  const notFound = () =>
    new Response('Not found', { status: 404, headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' } });

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: SECURITY_HEADERS });
  }

  let url;
  let rel;
  try {
    url = new URL(request.url);
    // Once, inside try/catch: a malformed escape throws. Query and hash are ignored by construction.
    rel = decodeURIComponent(url.pathname);
  } catch {
    return notFound();
  }
  if (url.protocol !== 'app:' || url.host !== 'deluge') return notFound();
  if (rel === '/') rel = '/index.html';

  // The URL parser already dropped literal dot segments; %2e%2e and ..%2f only appear after decoding.
  if (rel.includes('\0') || rel.includes('\\') || rel.split('/').some((s) => s === '..' || s === '.')) return notFound();

  const type = MIME[path.extname(rel).toLowerCase()];
  if (!type) return notFound(); // directories, extensionless paths and .map all land here

  const file = path.resolve(ROOT, `.${rel}`);
  const inside = path.relative(ROOT, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return notFound();

  try {
    const body = await readFile(file); // asar-aware
    return new Response(request.method === 'HEAD' ? null : body, { headers: { ...SECURITY_HEADERS, 'Content-Type': type } });
  } catch {
    return notFound(); // no directory listings, no index.html fallback for unknown paths
  }
}

/* ------------------------------------------------------------------------ R9: shell.openExternal allowlist */

function openExternalSafe(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return;
  }
  const base = `${u.origin}${u.pathname}`.replace(/\/$/, '');
  if (u.protocol === 'https:' && !u.username && !u.password && EXTERNAL_LINKS.includes(base)) {
    void shell.openExternal(u.href);
    return;
  }
  console.warn('[deluge] blocked external open:', u.protocol, u.host);
}

/* ----------------------------------------------------------- R7: navigation, new windows, webviews, R8 BT */

const isAppUrl = (u) => typeof u === 'string' && u.startsWith(`${APP_ORIGIN}/`);

app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });
  // `will-navigate` and `will-redirect` pass the URL as the second argument; `will-frame-navigate` carries
  // it on the event object alone. Reading both covers every major.
  const blockNav = (event, url) => {
    const target = url ?? event?.url;
    if (!isAppUrl(target)) {
      console.warn('[deluge] blocked navigation:', target);
      event.preventDefault();
    }
  };
  contents.on('will-navigate', blockNav);
  contents.on('will-frame-navigate', blockNav);
  contents.on('will-redirect', blockNav);
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
});

/* ------------------------------------------------------------------------------------- R10: TLS posture */

// Registered for logging only: no preventDefault, no callback(true), so Chromium's rejection stands.
app.on('certificate-error', (_event, _wc, url, error) => {
  console.error('[deluge] certificate rejected:', error, new URL(url).origin);
});
// Never auto-select a client certificate.
app.on('select-client-certificate', (event, _wc, _url, _list, callback) => {
  event.preventDefault();
  callback();
});
// The `login` event is deliberately unhandled: HTTP/proxy auth prompts are cancelled by default.

// GPU-process crashes are logged; Chromium restarts the GPU process itself.
app.on('child-process-gone', (_event, details) => console.error('[deluge] child process gone:', JSON.stringify(details)));

/* ------------------------------------------------------ R13: single instance, no deep links, no argv URLs */

// No app.setAsDefaultProtocolClient, no `open-url` handler, no auto-updater. The window always opens APP_URL.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => {
  // argv is ignored on purpose (SEC-01: a crafted ?name=/?live= must never reach the venue screen).
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

/* ------------------------------------------------------------------------------------ menu (R12: no DevTools) */

function buildMenu(getWindow) {
  const reloadScene = {
    label: 'Reload scene',
    accelerator: 'CmdOrCtrl+R',
    click: () => getWindow()?.loadURL(APP_URL),
  };
  const fullScreen = {
    label: 'Toggle Full Screen',
    accelerator: process.platform === 'darwin' ? 'Control+Command+F' : 'F11',
    click: () => {
      const win = getWindow();
      if (win) win.setFullScreen(!win.isFullScreen());
    },
  };
  const template = [
    ...(process.platform === 'darwin'
      ? [{ label: 'Deluge', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }]
      : []),
    // Kept so Cmd+C/V/A work in the location picker's search field. These are OS edit roles, not the
    // async clipboard API — navigator.clipboard stays denied by the R8 permission handlers.
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [reloadScene, { type: 'separator' }, fullScreen] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'close' }] },
  ];
  // No 'toggleDevTools' role and no default menu anywhere: the packaged build has no DevTools entry.
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* --------------------------------------------------------------------- verification-only smoke report (§V) */

/**
 * The name `@electron/packager` gives the verification build (`npm run app:verify`). That build runs the same
 * pipeline as the release one — same asar, same fuses, same security configuration — and differs only in this
 * name and in which `dist/` it carries.
 *
 * It exists because a packaged, fused Deluge cannot be driven from outside: Playwright's `_electron.launch`
 * starts Electron with `--inspect=0` / `--remote-debugging-pipe`, and the R11 fuses plus the R12 guard refuse
 * both, by design. So the packaged app reports on itself instead: with DELUGE_SMOKE_OUT set it writes a
 * screenshot, the GPU it got, every console message and (optionally) the result of one on-disk script, then
 * quits. It opens no port, grants the renderer nothing and changes no security setting.
 *
 * The shipped `Deluge.app` is not named this, so for it the hook does not exist at runtime: every DELUGE_SMOKE_*
 * variable is ignored unless the app is unpackaged or *is* the verification build.
 */
const VERIFY_APP_NAME = 'Deluge Verify';

function installSmokeReport(win, consoleLog) {
  const outDir = process.env.DELUGE_SMOKE_OUT;
  if (!outDir) return;
  if (app.isPackaged && app.getName() !== VERIFY_APP_NAME) {
    console.warn('[deluge] DELUGE_SMOKE_OUT ignored: not a verification build');
    return;
  }
  const waitMs = Number(process.env.DELUGE_SMOKE_WAIT_MS || 25000);
  setTimeout(async () => {
    const report = { app: app.getName(), packaged: app.isPackaged, waitedMs: waitMs, url: win.webContents.getURL(), console: consoleLog, gpu: null, script: null, error: null };
    try {
      const gpu = await app.getGPUInfo('complete');
      // The full blob is megabytes of driver detail; §V-2 only needs the adapter identity.
      report.gpu = { vendor: gpu?.gpuDevice?.[0]?.vendorId ?? null, device: gpu?.gpuDevice?.[0]?.deviceId ?? null, description: gpu?.machineModelName ?? null, raw: gpu?.auxAttributes ?? null };
      // What the checklist wants to read off a *packaged* app: items 13 (no DevTools), 15 (no deep link) and the
      // webPreferences that items 1-2 depend on, straight from the running main process.
      const prefs = win.webContents.getLastWebPreferences?.() ?? {};
      report.security = {
        devTools: prefs.devTools ?? null,
        sandbox: prefs.sandbox ?? null,
        contextIsolation: prefs.contextIsolation ?? null,
        nodeIntegration: prefs.nodeIntegration ?? null,
        webSecurity: prefs.webSecurity ?? null,
        preload: prefs.preload ?? null,
        // `getLastWebPreferences()` does not echo `devTools` or `backgroundThrottling`; read them where they live.
        backgroundThrottling: win.webContents.backgroundThrottling,
        devToolsOpened: win.webContents.isDevToolsOpened(),
        devToolsRequested: !app.isPackaged, // what webPreferences.devTools was set to for this window
        menu: Menu.getApplicationMenu()?.items.map((i) => ({ label: i.label, items: i.submenu?.items.map((x) => x.role ?? x.label) ?? [] })) ?? null,
        isDefaultProtocolClient: app.isDefaultProtocolClient('deluge'),
        displaySleepBlocked: blockerId !== null && powerSaveBlocker.isStarted(blockerId),
        contentSize: win.getContentSize(),
        scaleFactor: screen.getPrimaryDisplay().scaleFactor,
      };
      const scriptPath = process.env.DELUGE_SMOKE_SCRIPT;
      if (scriptPath) {
        // A fixed file on disk, never renderer input and never interpolated (R12). Verification builds only.
        const source = await readFile(scriptPath, 'utf8');
        report.script = await win.webContents.executeJavaScript(source, true);
      }
      const image = await win.webContents.capturePage();
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, 'smoke.png'), image.toPNG());
      await writeFile(path.join(outDir, 'smoke.json'), JSON.stringify(report, null, 2));
      console.log('[deluge] smoke report written to', outDir);
    } catch (err) {
      report.error = String(err?.stack || err);
      try {
        const { writeFile, mkdir } = await import('node:fs/promises');
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, 'smoke.json'), JSON.stringify(report, null, 2));
      } catch {}
      console.error('[deluge] smoke report failed', err);
    }
    app.exit(0);
  }, waitMs);
}

/* ------------------------------------------------------------------------------------------ window + session */

let blockerId = null;

function createWindow(ses) {
  const { workArea } = screen.getPrimaryDisplay();
  // Sensible on the 1470x956 Air (fills it without hiding under the menu bar); nothing is remembered
  // between runs — no window-state file, no restored bounds.
  const width = Math.min(1440, Math.max(1024, workArea.width - 16));
  const height = Math.min(900, Math.max(680, workArea.height - 16));

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 960,
    minHeight: 600,
    center: true,
    show: false,
    backgroundColor: '#05070d',
    title: 'Deluge',
    webPreferences: {
      session: ses, // R14: the dedicated session that carries the R4/R8/R10 configuration
      contextIsolation: true, // R2
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false, // liveWorker / protectionWorker stay pure web workers
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      navigateOnDragDrop: false,
      spellcheck: false, // no dictionary downloads outside the R10 allowlist
      safeDialogs: true,
      devTools: !app.isPackaged, // R12
      backgroundThrottling: false, // the sim must keep full speed if the window loses focus
      // Middle-click must not be able to ask for a new window at all. setWindowOpenHandler already denies every
      // request (R7); turning the feature off removes the ask, and with it electronegativity's AUXCLICK finding.
      disableBlinkFeatures: 'Auxclick',
      // No `preload` (R3), no `enableBlinkFeatures`, no `additionalArguments`.
    },
  });

  const consoleLog = [];
  win.webContents.on('console-message', (...args) => {
    // Electron >= 36 passes one event object; older majors passed (event, level, message, line, source).
    const e = args[0];
    const entry =
      e && typeof e === 'object' && 'message' in e
        ? { level: String(e.level), message: String(e.message), source: String(e.sourceId ?? ''), line: e.lineNumber ?? 0 }
        : { level: String(args[1]), message: String(args[2]), source: String(args[4] ?? ''), line: Number(args[3] ?? 0) };
    consoleLog.push(entry);
    if (entry.level === 'error' || entry.level === 'warning') console.log(`[renderer:${entry.level}] ${entry.message}`);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[deluge] load failed', code, desc, url));

  // R2: a renderer crash (e.g. a hostile upstream body, SEC-03) recovers into the offline presets.
  let crashReloads = 0;
  let lastCrash = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[deluge] render process gone:', JSON.stringify(details));
    const now = Date.now();
    if (now - lastCrash > 60_000) crashReloads = 0;
    lastCrash = now;
    if (crashReloads >= 1) {
      console.error('[deluge] already reloaded once in the last minute; not reloading again');
      return;
    }
    crashReloads += 1;
    win.loadURL(APP_URL);
  });
  win.webContents.on('unresponsive', () => console.error('[deluge] renderer unresponsive'));

  // F11 as a second full-screen key (the menu item owns Control+Command+F on macOS).
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      win.setFullScreen(!win.isFullScreen());
    }
  });

  win.once('ready-to-show', () => win.show());

  // Keep the venue screen awake for as long as a window exists. One blocker, never stacked.
  if (blockerId === null || !powerSaveBlocker.isStarted(blockerId)) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  win.on('closed', () => {
    if (BrowserWindow.getAllWindows().some((w) => !w.isDestroyed())) return;
    if (blockerId !== null && powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId);
    blockerId = null;
  });

  buildMenu(() => (win.isDestroyed() ? null : win));
  installSmokeReport(win, consoleLog);

  // R2: exactly app://deluge/, never file:// and never http://localhost:* in a packaged build.
  win.loadURL(APP_URL);
  return win;
}

app.whenReady().then(async () => {
  // R14: a dedicated session. Every protocol, permission and network rule below applies to *this* session,
  // which is also the one the window uses; defaultSession is left alone.
  const ses = session.fromPartition('persist:deluge');

  // A previous visitor's state never carries over. The HTTP cache is kept on purpose — it only holds
  // public map data and it makes repeated live loads bearable on venue wifi.
  // Awaited: the window must not start writing storage while the wipe is still running.
  await ses.clearStorageData({ storages: ['localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }).catch((e) => console.warn('[deluge] clearStorageData', e));

  // R4/R5
  ses.protocol.handle('app', serveApp);

  // R8: deny every permission-gated API. The app uses none.
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn('[deluge] denied permission request:', permission);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('select-hid-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on('select-usb-device', (event, _details, callback) => {
    event.preventDefault();
    callback();
  });
  ses.on('select-serial-port', (event, _ports, _wc, callback) => {
    event.preventDefault();
    callback('');
  });
  ses.on('will-download', (event) => {
    console.warn('[deluge] blocked download');
    event.preventDefault();
  });
  // No setDisplayMediaRequestHandler: screen capture stays unavailable.

  // R10: an allowlist independent of CSP. It also covers workers and anything a future dependency tries.
  // Redirect targets pass through here again, so a cross-host redirect is blocked too.
  ses.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let u;
    try {
      u = new URL(details.url);
    } catch {
      return callback({ cancel: true });
    }
    if (u.protocol === 'app:' || u.protocol === 'data:') return callback({});
    if (isAllowedDataUrl(u)) return callback({});
    console.warn('[net] blocked', u.origin + u.pathname);
    callback({ cancel: true });
  });

  // Nominatim's usage policy asks for an identifying agent; an app:// page sends no usable Referer.
  ses.webRequest.onBeforeSendHeaders({ urls: ['https://nominatim.openstreetmap.org/*'] }, (details, callback) => {
    callback({
      requestHeaders: { ...details.requestHeaders, 'User-Agent': `Deluge/${app.getVersion()} (+${EXTERNAL_LINKS[0]})` },
    });
  });

  createWindow(ses);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(ses);
  });
});

app.on('window-all-closed', () => app.quit());
