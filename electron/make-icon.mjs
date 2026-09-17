#!/usr/bin/env node
/**
 * Build `electron/icon.icns` from the app's own favicon, so Deluge.app is recognisable in the Dock and in
 * Cmd-Tab instead of showing the stock Electron atom.
 *
 * The favicon is an inline `data:image/svg+xml` URI in index.html — the single source of truth for the mark —
 * so this reads it straight out of the HTML, renders it at 1024px in headless Chromium, and hands the sizes to
 * macOS `iconutil`. The artwork is inset to 824/1024, which is the proportion Apple's icon grid uses for a
 * rounded-rect app icon; without it the icon looks oversized next to every other app in the Dock.
 *
 * Run once, commit the result: `node electron/make-icon.mjs`. `electron/package.mjs` uses it if it exists.
 */
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const html = await readFile(path.join(REPO, 'index.html'), 'utf8');
const href = html.match(/<link rel="icon"[^>]*href="([^"]+)"/)?.[1];
if (!href) throw new Error('no inline favicon found in index.html');

const page = await (await chromium.launch()).newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
await page.setContent(
  `<style>html,body{margin:0;background:transparent}
   #f{width:1024px;height:1024px;display:grid;place-items:center}
   img{width:824px;height:824px}</style>
   <div id="f"><img src="${href.replace(/"/g, '&quot;')}"></div>`,
);
const dir = await mkdtemp(path.join(tmpdir(), 'deluge-icon-'));
const iconset = path.join(dir, 'icon.iconset');
spawnSync('mkdir', ['-p', iconset]);
const master = path.join(dir, 'master.png');
await writeFile(master, await page.locator('#f').screenshot({ omitBackground: true }));
await page.context().browser().close();

for (const [name, size] of [
  ['icon_16x16', 16], ['icon_16x16@2x', 32], ['icon_32x32', 32], ['icon_32x32@2x', 64],
  ['icon_128x128', 128], ['icon_128x128@2x', 256], ['icon_256x256', 256], ['icon_256x256@2x', 512],
  ['icon_512x512', 512], ['icon_512x512@2x', 1024],
]) {
  const out = path.join(iconset, `${name}.png`);
  spawnSync('cp', [master, out]);
  const r = spawnSync('sips', ['-z', String(size), String(size), out], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`sips failed for ${name}: ${r.stderr}`);
}

const icns = path.join(REPO, 'electron/icon.icns');
const r = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', icns], { encoding: 'utf8' });
if (r.status !== 0) throw new Error(`iconutil failed: ${r.stderr}`);
await rm(dir, { recursive: true, force: true });
console.log(`wrote ${path.relative(REPO, icns)}`);
