#!/usr/bin/env node
/**
 * Build `release/Deluge.app` — the demo-laptop bundle.
 *
 * Runs after `vite build`, and does four things in the order that asar integrity requires:
 *
 *   1. Stage exactly what ships: `main.js`, `endpoints.js`, the built `dist/`, and a minimal package.json.
 *      Nothing else from the repo — no sources, no node_modules, no artifacts.
 *   2. `@electron/packager` builds the `.app` with `asar: true` and embeds the asar integrity digest into the
 *      Electron Framework (ELECTRON_REQUIREMENTS.md R11), re-signing that framework ad hoc as it goes.
 *   3. `@electron/fuses` flips the R11 fuse wire in the main binary, then re-signs the whole bundle ad hoc
 *      (`resetAdHocDarwinSignature`) — Apple Silicon refuses to launch a binary whose signature no longer
 *      matches. This must come after packaging: the fuse flip edits the executable, not the asar, so the
 *      integrity digest stays valid.
 *   4. Read the fuse wire back and verify the signature, so a broken build fails here and not at the venue.
 *
 * Flags (all optional):
 *   --name=<Name>   bundle name              (default "Deluge")
 *   --dist=<dir>    built web app to embed   (default "dist")
 *   --out=<dir>     output directory         (default "release")
 *
 * `npm run app:verify` uses them to build "Deluge Verify.app": the identical pipeline with a different name,
 * which is the only name `electron/main.js` lets the §V smoke hook answer to.
 */
import { packager } from '@electron/packager';
import { flipFuses, FuseV1Options, FuseVersion, getCurrentFuseWire } from '@electron/fuses';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');

const flag = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const APP_NAME = flag('name', 'Deluge');
const DIST = path.resolve(REPO, flag('dist', 'dist'));
const OUT = path.resolve(REPO, flag('out', 'release'));
const STAGE = path.join(OUT, `.stage-${APP_NAME.replace(/\s+/g, '-')}`);
const APP_PATH = path.join(OUT, `${APP_NAME}.app`);

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
const step = (msg) => console.log(`\n▸ ${msg}`);

/* ------------------------------------------------------------------------------------------- 1. stage */

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`No build at ${DIST}. Run \`vite build\` first (npm run app:build does both).`);
  process.exit(1);
}

const pkg = JSON.parse(await readFile(path.join(REPO, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(await readFile(path.join(REPO, 'node_modules/electron/package.json'), 'utf8')).version;

step(`staging ${APP_NAME} (electron ${electronVersion}, dist ${path.relative(REPO, DIST)})`);
await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });
await cp(path.join(REPO, 'electron/main.js'), path.join(STAGE, 'main.js'));
await cp(path.join(REPO, 'electron/endpoints.js'), path.join(STAGE, 'endpoints.js'));
await cp(DIST, path.join(STAGE, 'dist'), { recursive: true });
await writeFile(
  path.join(STAGE, 'package.json'),
  // `type: module` because main.js is ESM; no dependencies, so nothing from node_modules is ever bundled.
  `${JSON.stringify({ name: APP_NAME.toLowerCase().replace(/\s+/g, '-'), productName: APP_NAME, version: pkg.version, main: 'main.js', type: 'module', private: true }, null, 2)}\n`,
);

/* ----------------------------------------------------------------------------------------- 2. package */

step('packaging');
const [built] = await packager({
  dir: STAGE,
  out: OUT,
  name: APP_NAME,
  platform: 'darwin',
  arch: process.arch === 'arm64' ? 'arm64' : 'x64',
  electronVersion,
  asar: true, // R11: one app.asar, with the integrity digest embedded (asarIntegrityDigest defaults to true)
  overwrite: true,
  prune: false, // the staged tree is already exactly what ships
  derefSymlinks: true,
  appVersion: pkg.version,
  buildVersion: pkg.version,
  appBundleId: 'io.github.rkottomt.deluge',
  appCategoryType: 'public.app-category.education',
  darwinDarkModeSupport: true,
  ...(existsSync(path.join(REPO, 'electron/icon.icns')) ? { icon: path.join(REPO, 'electron/icon.icns') } : {}),
  // No `osxSign`: there is no Developer ID for this demo, so the bundle keeps the ad-hoc signature that step 3
  // applies. No `protocols`: R13 forbids registering a URL scheme handler.
  extendInfo: { NSHighResolutionCapable: true, NSSupportsAutomaticGraphicsSwitching: true },
});

// packager writes <out>/<Name>-darwin-<arch>/<Name>.app; lift it to <out>/<Name>.app.
await rm(APP_PATH, { recursive: true, force: true });
await cp(path.join(built, `${APP_NAME}.app`), APP_PATH, { recursive: true, verbatimSymlinks: true });
await rm(built, { recursive: true, force: true });
await rm(STAGE, { recursive: true, force: true });

/* -------------------------------------------------------------------------------------- 3. flip fuses */

step('flipping fuses');
const FUSES = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: true, // re-sign the bundle: editing the binary invalidated the ad-hoc signature
  strictlyRequireAllFuses: true, // a fuse added by a future Electron major fails the build instead of defaulting
  [FuseV1Options.RunAsNode]: false, // ELECTRON_RUN_AS_NODE must not turn the binary into a Node interpreter
  [FuseV1Options.EnableCookieEncryption]: true, // harmless; the app sets no cookies
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false, // NODE_OPTIONS=--require must not inject into main
  [FuseV1Options.EnableNodeCliInspectArguments]: false, // --inspect must not open a debugger on main
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, // a tampered app.asar refuses to start
  [FuseV1Options.OnlyLoadAppFromAsar]: true, // no planted unpacked app/ folder next to the asar
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false, // unused
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false, // file:// is unused (R4)
  [FuseV1Options.WasmTrapHandlers]: true, // Electron's default; unrelated to the R11 table
};
const binary = path.join(APP_PATH, 'Contents', 'MacOS', APP_NAME);
await flipFuses(binary, FUSES);

/* ------------------------------------------------------------------------------------------ 4. verify */

step('verifying');
const wire = await getCurrentFuseWire(binary);
const ENABLED = '1';
const expected = Object.entries(FUSES).filter(([k]) => /^\d+$/.test(k));
let bad = 0;
for (const [index, want] of expected) {
  const got = String.fromCharCode(Number(wire[index]));
  const ok = (got === ENABLED) === want;
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${FuseV1Options[index]} = ${got === ENABLED}${ok ? '' : ` (expected ${want})`}`);
}

const sig = run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', APP_PATH]);
console.log(`  ${sig.status === 0 ? 'ok  ' : 'FAIL'} code signature valid`);
if (sig.status !== 0) console.log(sig.stderr);

const integrity = run('/usr/libexec/PlistBuddy', ['-c', 'Print :ElectronAsarIntegrity', path.join(APP_PATH, 'Contents', 'Info.plist')]);
console.log(`  ${integrity.status === 0 ? 'ok  ' : 'FAIL'} ElectronAsarIntegrity in Info.plist`);

if (bad || sig.status !== 0 || integrity.status !== 0) {
  console.error('\nBuild produced an app that would not be safe to demo.');
  process.exit(1);
}

const size = run('du', ['-sh', APP_PATH]).stdout.trim().split(/\s+/)[0];
console.log(`\n${path.relative(REPO, APP_PATH)} — ${size}, ad-hoc signed, fuses set.\n`);
