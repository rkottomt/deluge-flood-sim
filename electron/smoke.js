/**
 * Deluge — the §V verification smoke hook. THIS FILE IS NOT PART OF THE SHIPPED APP.
 *
 * A packaged, fused Deluge cannot be driven from outside: Playwright's `_electron.launch` starts Electron with
 * `--inspect=0` / `--remote-debugging-pipe`, and the R11 fuses plus the R12 guard refuse both, by design. So the
 * packaged app reports on itself instead: with DELUGE_SMOKE_OUT set it writes a screenshot, the GPU it got, every
 * console message and (optionally) the result of one on-disk script, then quits. It opens no port, grants the
 * renderer nothing and changes no security setting.
 *
 * `DELUGE_SMOKE_SCRIPT` runs arbitrary JavaScript in the renderer, so this module must never reach a bundle a
 * judge (or anyone else) launches. Two independent gates enforce that:
 *
 *   1. `electron/package.mjs` stages this file **only** for a bundle named `VERIFY_APP_NAME` (`npm run
 *      app:verify`). The shipped `release/Deluge.app` asar does not contain it at all, so there is no code to
 *      call — `electron/main.js` finds the dynamic import missing and logs that it was ignored.
 *   2. Belt and braces, in case a future build ever stages it by accident: `installSmokeReport` refuses to arm
 *      on any packaged build whose product name is not `VERIFY_APP_NAME`.
 *
 * Deliberately electron-free at the top level (the harness passes what it needs), so `electron/package.mjs` can
 * import `VERIFY_APP_NAME` from here under plain Node and the two stay in step by construction.
 */

/** The only product name that may answer the smoke hook. `package.mjs` imports this to decide what to stage. */
export const VERIFY_APP_NAME = 'Deluge Verify';

/**
 * Arm the smoke report on `win`. Called by electron/main.js only when DELUGE_SMOKE_OUT is set.
 *
 * @param {object} ctx
 * @param {import('electron').App} ctx.app
 * @param {typeof import('electron').Menu} ctx.Menu
 * @param {typeof import('electron').powerSaveBlocker} ctx.powerSaveBlocker
 * @param {typeof import('electron').screen} ctx.screen
 * @param {import('electron').BrowserWindow} ctx.win
 * @param {Array<object>} ctx.consoleLog  live array of renderer console messages
 * @param {() => number | null} ctx.getBlockerId  the main process's powerSaveBlocker id, or null
 * @returns {boolean} whether the hook armed
 */
export function installSmokeReport({ app, Menu, powerSaveBlocker, screen, win, consoleLog, getBlockerId }) {
  const outDir = process.env.DELUGE_SMOKE_OUT;
  if (!outDir) return false;
  if (app.isPackaged && app.getName() !== VERIFY_APP_NAME) {
    console.warn('[deluge] DELUGE_SMOKE_OUT ignored: not a verification build');
    return false;
  }
  const waitMs = Number(process.env.DELUGE_SMOKE_WAIT_MS || 25000);
  setTimeout(async () => {
    const { readFile, writeFile, mkdir } = await import('node:fs/promises');
    const path = (await import('node:path')).default;
    const report = { app: app.getName(), packaged: app.isPackaged, waitedMs: waitMs, url: win.webContents.getURL(), console: consoleLog, gpu: null, script: null, error: null };
    try {
      const gpu = await app.getGPUInfo('complete');
      // The full blob is megabytes of driver detail; §V-2 only needs the adapter identity.
      report.gpu = { vendor: gpu?.gpuDevice?.[0]?.vendorId ?? null, device: gpu?.gpuDevice?.[0]?.deviceId ?? null, description: gpu?.machineModelName ?? null, raw: gpu?.auxAttributes ?? null };
      // What the checklist wants to read off a *packaged* app: items 13 (no DevTools), 15 (no deep link) and the
      // webPreferences that items 1-2 depend on, straight from the running main process.
      const prefs = win.webContents.getLastWebPreferences?.() ?? {};
      const blockerId = getBlockerId();
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
      await mkdir(outDir, { recursive: true });
      await writeFile(path.join(outDir, 'smoke.png'), image.toPNG());
      await writeFile(path.join(outDir, 'smoke.json'), JSON.stringify(report, null, 2));
      console.log('[deluge] smoke report written to', outDir);
    } catch (err) {
      report.error = String(err?.stack || err);
      try {
        await mkdir(outDir, { recursive: true });
        await writeFile(path.join(outDir, 'smoke.json'), JSON.stringify(report, null, 2));
      } catch {}
      console.error('[deluge] smoke report failed', err);
    }
    app.exit(0);
  }, waitMs);
  return true;
}
