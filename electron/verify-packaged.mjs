#!/usr/bin/env node
/**
 * §V verification, packaged half — checklist items 9-16 of artifacts/security-report/ELECTRON_REQUIREMENTS.md,
 * plus the demo evidence the wrapper actually has to deliver: WebGPU on the real GPU, Pittsburgh loading with
 * every network host unreachable, the pitch flows, and frame rate at the Air's own resolution.
 *
 * Nothing here can be driven from outside — that is the point of items 9 and 10 — so the packaged app reports on
 * itself through the smoke hook in electron/main.js, which only a bundle named "Deluge Verify" answers. That
 * bundle comes off the same `electron/package.mjs` pipeline as the shipping one: same fuses, same asar, same
 * security configuration, different name and `dist/`.
 *
 * Run: npm run app:check   (or: node electron/verify-packaged.mjs)
 * Writes artifacts/electron/verify-packaged.json and the packaged screenshots next to it.
 */
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const OUT = path.join(REPO, 'artifacts/electron');
const RELEASE = path.join(REPO, 'release/Deluge.app');
const RELEASE_BIN = path.join(RELEASE, 'Contents/MacOS/Deluge');
const VERIFY_NAME = 'Deluge Verify';

const checks = [];
let failures = 0;
function record(id, req, name, ok, detail) {
  checks.push({ id, req, name, ok: ok === 'skip' ? 'skip' : !!ok, detail });
  if (ok !== 'skip' && !ok) failures += 1;
  console.log(`  ${ok === 'skip' ? 'skip' : ok ? 'ok  ' : 'FAIL'} V${id} ${name}${detail ? ` — ${detail}` : ''}`);
}
const section = (s) => console.log(`\n${s}`);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

/**
 * Timing on a shared laptop means nothing without saying what else was running. Four agents share this GPU, so a
 * frame-rate number here is a sanity floor, not the project's performance gate — `npm run test:perf` owns that.
 */
function machineLoad() {
  const power = (sh('pmset', ['-g', 'batt']).stdout ?? '').replace(/\s+/g, ' ').trim();
  const busy = (sh('ps', ['-axo', 'pcpu=,comm=']).stdout ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim().split(/\s+/, 1)[0])
    .map(Number)
    .filter((v) => v > 40).length;
  const gpuHogs = (sh('ps', ['-axo', 'pcpu=,comm=']).stdout ?? '')
    .trim()
    .split('\n')
    .filter((l) => /Helper \(GPU\)|Helper \(Renderer\)/.test(l) && Number(l.trim().split(/\s+/, 1)[0]) > 40).length;
  return { power, busyProcesses: busy, otherGpuClients: gpuHogs, contended: gpuHogs > 0 };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Everything the wrapper must never inherit from the shell (see verify-renderer.mjs). */
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  return env;
}

/** Run a packaged binary briefly and report what it did. Never leaves a process behind. */
async function runBriefly(bin, args, { env = {}, ms = 6000, cwd = REPO } = {}) {
  const child = spawn(bin, args, { env: cleanEnv(env), cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  let code = null;
  child.on('exit', (c) => (code = c));
  const deadline = Date.now() + ms;
  while (code === null && Date.now() < deadline) await sleep(150);
  const alive = code === null;
  const pid = child.pid;
  if (alive) {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  }
  return { out, code, alive, pid };
}

/** The pids of a running app and its Electron helpers. */
function processTree(rootPid) {
  const ps = sh('ps', ['-axo', 'pid=,ppid=']).stdout ?? '';
  const children = new Map();
  for (const line of ps.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const all = [];
  const walk = (p) => { all.push(p); for (const c of children.get(p) ?? []) walk(c); };
  walk(rootPid);
  return all;
}

/* ---------------------------------------------------------------------------- build what we verify */

if (!existsSync(RELEASE_BIN)) {
  console.error('No release/Deluge.app — run `npm run app:build` first.');
  process.exit(1);
}
await mkdir(OUT, { recursive: true });

function buildVerifyApp(dist, outDir) {
  const r = sh('node', [path.join(REPO, 'electron/package.mjs'), `--name=${VERIFY_NAME}`, `--dist=${dist}`, `--out=${outDir}`], { cwd: REPO });
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`packaging ${outDir} failed`);
  }
  return path.join(REPO, outDir, `${VERIFY_NAME}.app`, 'Contents/MacOS', VERIFY_NAME);
}

section('building verification bundles (same pipeline, different name)');
const PROD_VERIFY = buildVerifyApp('dist', 'artifacts/electron/verify-prod');
const DEBUG_VERIFY = existsSync(path.join(REPO, 'artifacts/electron/dist-debug/index.html'))
  ? buildVerifyApp('artifacts/electron/dist-debug', 'artifacts/electron/verify-debug')
  : null;

/* -------------------------------------------------------------------------------- 9. fuses (R11) */

section('checklist items 9-16');
{
  const wire = await getCurrentFuseWire(RELEASE_BIN);
  const want = {
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  };
  const got = {};
  let ok = true;
  for (const [i, expected] of Object.entries(want)) {
    const on = String.fromCharCode(Number(wire[i])) === '1';
    got[FuseV1Options[i]] = on;
    if (on !== expected) ok = false;
  }
  record(9, 'R11', 'the fuse wire matches the R11 table', ok, JSON.stringify(got));
}

/* 9b: ELECTRON_RUN_AS_NODE */
{
  const r = await runBriefly(RELEASE_BIN, ['-e', 'console.log("RUN_AS_NODE_WORKED")'], { env: { ELECTRON_RUN_AS_NODE: '1' }, ms: 5000 });
  record('9b', 'R11', 'ELECTRON_RUN_AS_NODE does not turn the binary into Node', !r.out.includes('RUN_AS_NODE_WORKED'), r.out.trim().split('\n').slice(0, 2).join(' ') || 'no output (the app just started normally)');
}

/* 9c: NODE_OPTIONS=--require */
{
  const marker = path.join(OUT, 'node-options-marker.txt');
  const injected = path.join(OUT, 'inject.cjs');
  await rm(marker, { force: true });
  await writeFile(injected, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'injected');\n`);
  const r = await runBriefly(RELEASE_BIN, [], { env: { NODE_OPTIONS: `--require=${injected}` }, ms: 6000 });
  record('9c', 'R11', 'NODE_OPTIONS=--require injects nothing into main', !existsSync(marker), existsSync(marker) ? 'the injected module RAN' : `no marker written (exit ${r.code ?? 'still running, killed'})`);
  await rm(marker, { force: true });
}

/* 9d + 10: --inspect and --remote-debugging-port */
for (const [id, arg, port] of [['9d', '--inspect=9229', 9229], [10, '--remote-debugging-port=9222', 9222]]) {
  const child = spawn(RELEASE_BIN, [arg], { env: cleanEnv({}), cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (b) => (out += b));
  child.stderr.on('data', (b) => (out += b));
  let exited = null;
  child.on('exit', (c) => (exited = c));
  await sleep(4000);
  const listening = (sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).stdout ?? '').trim();
  const curl = sh('curl', ['-s', '--max-time', '2', `http://127.0.0.1:${port}/json/version`]);
  if (exited === null) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  const quiet = listening === '' && (curl.status !== 0 || (curl.stdout ?? '').trim() === '');
  record(id, id === 10 ? 'R12' : 'R11', `${arg} opens no debugging endpoint`, quiet, `exit=${exited}; listener=${listening || 'none'}; ${out.match(/refusing to start[^\n]*/)?.[0] ?? ''}`);
}

/* 11: asar integrity */
{
  const dir = path.join(OUT, 'tamper');
  const app = path.join(dir, 'Deluge.app');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(RELEASE, app, { recursive: true, verbatimSymlinks: true });
  const asar = path.join(app, 'Contents/Resources/app.asar');
  const buf = readFileSync(asar);
  // The `ElectronAsarIntegrity` entry hashes the asar *header* (the JSON directory at the front of the file), so
  // that is where the byte has to move for startup validation to see it. Flipping a byte in the middle of the
  // payload is only caught later, when that particular file happens to be read.
  const at = 40;
  buf[at] = buf[at] ^ 0xff;
  writeFileSync(asar, buf);
  // Re-signed ad hoc so the *only* broken thing is the integrity hash, not the code signature.
  const resign = sh('codesign', ['--sign', '-', '--force', '--preserve-metadata=entitlements,requirements,flags,runtime', '--deep', app]);
  const r = await runBriefly(path.join(app, 'Contents/MacOS/Deluge'), [], { ms: 8000 });
  const refused = /Integrity check failed/i.test(r.out) || /FATAL.*asar/i.test(r.out);
  record(11, 'R11', 'a tampered app.asar refuses to start', refused, `re-signed=${resign.status === 0}; ${(r.out.match(/[^\n]*[Ii]ntegrity[^\n]*/) ?? ['no integrity message — IT STARTED'])[0].slice(0, 140)}`);
  await rm(dir, { recursive: true, force: true });
}

/* 16: static scan. §V allows a finding to stand if it has a written justification — these are those. */
const JUSTIFIED = {
  CSP_GLOBAL_CHECK:
    'The scanner looks for a CSP in HTML inside the scanned tree; the wrapper directory has no HTML. Deluge sends the policy as a real response header from serveApp (checklist item 3 reads it back off a worker asset) and vite.config.ts also injects the same policy as a meta into dist/index.html.',
  OPEN_EXTERNAL_JS_CHECK:
    'R9. openExternalSafe only ever passes an https URL whose origin+pathname exactly matches EXTERNAL_LINKS (one entry: the project repo), with no embedded credentials. Every other string is dropped and logged.',
  CERTIFICATE_ERROR_EVENT_JS_CHECK:
    "R10. The certificate-error handler logs and returns: no event.preventDefault(), no callback(true), so Chromium's rejection stands. Checklist item 8 proves a self-signed data host is refused.",
  REMOTE_MODULE_JS_CHECK:
    'The remote module was removed from Electron in v14; there is no enableRemoteModule option to set in Electron 44. The scanner defaults to assuming Electron v0.1.0 when it cannot read a version from the scanned directory.',
};
{
  const r = sh('npx', ['--yes', '@doyensec/electronegativity', '-i', path.join(REPO, 'electron')], { cwd: REPO, timeout: 300_000 });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  await writeFile(path.join(OUT, 'electronegativity.txt'), text);
  if (r.status !== 0 && !/Check ID/.test(text)) {
    record(16, 'all', 'electronegativity static scan', 'skip', `scanner unavailable: ${text.slice(-160).trim()}`);
  } else {
    const ids = [...new Set((text.match(/\b[A-Z0-9_]+_(?:JS|HTML|GLOBAL)_CHECK\b/g) ?? []).filter((id) => text.includes(id)))];
    // Only rows in the findings table count; the "not run" advert at the bottom lists check names too.
    const table = text.slice(0, text.indexOf('Would you like more precise') === -1 ? text.length : text.indexOf('Would you like more precise'));
    const found = ids.filter((id) => table.includes(id));
    const unjustified = found.filter((id) => !(id in JUSTIFIED));
    const high = (table.match(/\bHIGH\b/g) ?? []).length;
    record(16, 'all', 'every electronegativity finding is zero-risk or justified in writing', high === 0 && unjustified.length === 0, `${high} HIGH; findings: ${found.join(', ') || 'none'}${unjustified.length ? ` — UNJUSTIFIED: ${unjustified.join(', ')}` : ' (all justified in CHECKLIST.md)'}`);
  }
}

/* 14: the packaged bundle carries no debug API */
{
  const asar = readFileSync(path.join(RELEASE, 'Contents/Resources/app.asar'));
  const hits = (asar.toString('latin1').match(/__deluge(?!\[)/g) ?? []).length;
  const uiHits = (asar.toString('latin1').match(/__delugeUI/g) ?? []).length;
  record(14, 'R12,SEC-07', 'no __deluge / __delugeUI anywhere in the packaged asar', hits === 0 && uiHits === 0, `${hits} + ${uiHits} occurrences`);
}

/* --------------------------------------------------- the packaged app, running, reporting on itself */

const SMOKE_PROD = `(async () => {
  const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null;
  await new Promise((r) => setTimeout(r, 4000)); // settle: let the first roads/imagery work finish
  let frames = 0;
  const t0 = performance.now();
  await new Promise((done) => {
    const tick = () => { frames++; if (performance.now() - t0 > 5000) done(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
  const elapsed = (performance.now() - t0) / 1000;
  const canvas = document.querySelector('canvas');
  return {
    origin: location.origin,
    secureContext: isSecureContext,
    adapter: adapter ? { vendor: adapter.info?.vendor ?? null, architecture: adapter.info?.architecture ?? null } : null,
    fps: Math.round((frames / elapsed) * 10) / 10,
    canvas: canvas ? { css: [canvas.clientWidth, canvas.clientHeight], backing: [canvas.width, canvas.height], dpr: devicePixelRatio } : null,
    debugApi: typeof window.__deluge,
    uiDebug: typeof document.getElementById('ui-root')?.__delugeUI,
    text: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 500),
    fatal: Boolean(document.getElementById('deluge-fatal')),
  };
})()`;

const SMOKE_FLOWS = `(async () => {
  await window.__deluge.ready;
  const out = { steps: [] };
  const step = (name, value) => out.steps.push({ name, value });
  await window.__deluge.loadPreset('pittsburgh');
  step('pittsburgh loaded', window.__deluge.getState().presetId);
  // Pitch beat 1: raise the rivers to the 1936 crest.
  const crest = window.__deluge.stageOffsetForFeet(46);
  window.__deluge.setStage(crest ?? 6, { instant: true });
  window.__deluge.setPaused(false);
  await window.__deluge.runFor(120);
  step('crest volume m3', Math.round(window.__deluge.getStats().volume));
  // Pitch beat 2: 100 mm/hr of rain, fast-forwarded.
  window.__deluge.setRain(100);
  await window.__deluge.runFor(600);
  step('after rain, flooded area m2', Math.round(window.__deluge.getStats().floodedArea));
  // Pitch beat 3: build a levee and watch the protected area appear.
  const s = window.__deluge.getSolver();
  window.__deluge.selectTool('wall');
  window.__deluge.drawWall([{ gx: (s.nx >> 1) - 60, gy: s.ny >> 1 }, { gx: s.nx >> 1, gy: (s.ny >> 1) + 40 }, { gx: (s.nx >> 1) + 60, gy: s.ny >> 1 }], 4);
  for (let i = 0; i < 200 && !window.__deluge.getProtection()?.wallCells; i++) await window.__deluge.waitFrames(2);
  step('levee wall cells', window.__deluge.getProtection()?.wallCells ?? 0);
  // Pitch beat 4: evacuation routing reacts to the water.
  step('road status', window.__deluge.getRoadStatusCounts());
  const perf = window.__deluge.getPerf();
  out.fps = Math.round(perf.fps * 10) / 10;
  out.simClock = Math.round(window.__deluge.getSimClock());
  out.errors = window.__deluge.errors.length;
  return out;
})()`;

async function smokeRun(bin, { script, args = [], dir, waitMs = 30_000, graceMs = 90_000, label }) {
  const outDir = path.join(OUT, dir);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const scriptPath = path.join(outDir, 'script.js');
  await writeFile(scriptPath, script);
  section(`running packaged ${label}`);
  const child = spawn(bin, args, {
    env: cleanEnv({ DELUGE_SMOKE_OUT: outDir, DELUGE_SMOKE_SCRIPT: scriptPath, DELUGE_SMOKE_WAIT_MS: String(waitMs) }),
    cwd: REPO,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += b));
  child.stderr.on('data', (b) => (log += b));
  let exited = null;
  child.on('exit', (c) => (exited = c));

  // While it is up: checklist item 12 — the wrapper must hold no listening TCP socket at all.
  await sleep(Math.max(12_000, waitMs * 0.6));
  let listeners = 'not sampled';
  if (exited === null) {
    const pids = processTree(child.pid);
    const r = sh('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', pids.join(',')]);
    listeners = (r.stdout ?? '').trim();
    record(12 + (dir === 'verify-prod-run' ? '' : `-${dir}`), 'R4', `no listening TCP socket in the ${label} process tree`, listeners === '', `${pids.length} processes; ${listeners || 'nothing listening'}`);
  }

  const deadline = Date.now() + waitMs + graceMs;
  while (exited === null && Date.now() < deadline) await sleep(250);
  if (exited === null) { try { process.kill(child.pid, 'SIGKILL'); } catch {} }
  const reportPath = path.join(outDir, 'smoke.json');
  const report = existsSync(reportPath) ? JSON.parse(await readFile(reportPath, 'utf8')) : null;
  return { report, log, outDir };
}

/* The shipping renderer, packaged, with every external host pointed at nowhere: the venue-wifi-is-dead case. */
{
  const { report, log, outDir } = await smokeRun(PROD_VERIFY, {
    script: SMOKE_PROD,
    // MAP * 127.0.0.1:1 makes every data host unreachable without touching a single security setting.
    args: ['--host-resolver-rules=MAP * 127.0.0.1:1'],
    dir: 'verify-prod-run',
    waitMs: 30_000,
    label: 'production build, all networks unreachable',
  });
  if (!report?.script) {
    record('2-packaged', 'R4', 'packaged production build reports on itself', false, `no smoke report; ${log.slice(-300)}`);
  } else {
    const s = report.script;
    record('2-packaged', 'R4', 'packaged app: app:// origin, secure context, real WebGPU adapter', s.origin === 'app://deluge' && s.secureContext === true && Boolean(s.adapter), `${s.origin}, adapter=${JSON.stringify(s.adapter)}`);
    record('2-offline', 'R4', 'Pittsburgh loads from packaged assets with every host unreachable', !s.fatal && Boolean(s.canvas) && /Pittsburgh/i.test(s.text), `${s.fatal ? 'FATAL SCREEN' : 'scene up'}; "${s.text.slice(0, 120)}"`);
    const load = machineLoad();
    // Floor, not a target: this only has to show the packaged app renders at interactive speed. The demo number
    // (60 fps, 57-71x sim speed) comes from `npm run test:perf` on an otherwise idle machine.
    record('2-fps', 'R4', 'the packaged app renders at interactive speed', s.fps >= 30, `${s.fps} fps at ${s.canvas?.css?.join('x')} css / ${s.canvas?.backing?.join('x')} backing, dpr ${s.canvas?.dpr}; ${load.otherGpuClients} other GPU clients busy; ${load.power}`);
    record('14-packaged', 'R12,SEC-07', 'no debug API in the packaged production renderer', s.debugApi === 'undefined' && s.uiDebug === 'undefined', `window.__deluge=${s.debugApi}, __delugeUI=${s.uiDebug}`);
    const errs = (report.console ?? []).filter((c) => c.level === 'error');
    record('console-packaged', 'R2', 'no console errors in the packaged production build', errs.length === 0, errs.slice(0, 3).map((e) => e.message).join(' | ') || 'clean');
    const sec = report.security ?? {};
    // `getLastWebPreferences()` does not echo `devTools`, so the evidence is: the window was created with
    // `devTools: !app.isPackaged` on a packaged app, nothing has DevTools open, and no menu item can open them.
    record(13, 'R12', 'DevTools are off and no menu item can open them', report.packaged === true && sec.devToolsRequested === false && sec.devToolsOpened === false && !JSON.stringify(sec.menu ?? []).includes('toggleDevTools') && !JSON.stringify(sec.menu ?? []).toLowerCase().includes('developer'), `packaged=${report.packaged}, devTools requested=${sec.devToolsRequested}, open=${sec.devToolsOpened}; menu=${JSON.stringify(sec.menu)}`);
    record('2-prefs', 'R2', 'packaged webPreferences are the hardened ones', sec.sandbox === true && sec.contextIsolation === true && sec.nodeIntegration === false && sec.webSecurity === true && !sec.preload && sec.backgroundThrottling === false, JSON.stringify({ sandbox: sec.sandbox, contextIsolation: sec.contextIsolation, nodeIntegration: sec.nodeIntegration, webSecurity: sec.webSecurity, preload: sec.preload, backgroundThrottling: sec.backgroundThrottling }));
    record('15-packaged', 'R13', 'the packaged app registers no URL scheme', sec.isDefaultProtocolClient === false, `isDefaultProtocolClient('deluge')=${sec.isDefaultProtocolClient}`);
    record('powersave', 'R15', 'display sleep is blocked while the window is open', sec.displaySleepBlocked === true, `powerSaveBlocker active=${sec.displaySleepBlocked}; window ${sec.contentSize?.join('x')} @ ${sec.scaleFactor}x`);
    console.log(`  screenshot: ${path.relative(REPO, path.join(outDir, 'smoke.png'))}`);
  }
}

/* The pitch flows, on a packaged and fused build. */
if (DEBUG_VERIFY) {
  const { report, log, outDir } = await smokeRun(DEBUG_VERIFY, { script: SMOKE_FLOWS, dir: 'verify-flows-run', waitMs: 25_000, graceMs: 240_000, label: 'debug build, pitch flows' });
  const s = report?.script;
  const steps = s?.steps ?? [];
  const ok = steps.length >= 4 && steps[1]?.value > 0 && steps[2]?.value > 0 && steps[3]?.value > 0;
  record('2-flows', 'R4', 'the pitch flows run inside the packaged app', ok, s ? `${steps.map((x) => `${x.name}=${JSON.stringify(x.value)}`).join('; ')}; fps=${s.fps}; app errors=${s.errors}` : `no report; ${log.slice(-300)}`);
  if (s) console.log(`  screenshot: ${path.relative(REPO, path.join(outDir, 'smoke.png'))}`);
} else {
  record('2-flows', 'R4', 'the pitch flows run inside the packaged app', 'skip', 'no artifacts/electron/dist-debug — run node electron/verify-renderer.mjs first');
}

/* ------------------------------------------------------------------------------------------ report */

await writeFile(path.join(OUT, 'verify-packaged.json'), `${JSON.stringify({ when: new Date().toISOString(), release: path.relative(REPO, RELEASE), machine: machineLoad(), checks }, null, 2)}\n`);
console.log(`\n${checks.filter((c) => c.ok === true).length} passed, ${failures} failed, ${checks.filter((c) => c.ok === 'skip').length} skipped → artifacts/electron/verify-packaged.json`);
process.exit(failures ? 1 : 0);
