#!/usr/bin/env node
/**
 * Headless Chromium (real Metal GPU → WebGPU) screenshot + console capture.
 *
 * Usage:
 *   node scripts/shot.mjs <url> <out.png> [--wait=ms] [--width=1600] [--height=1000]
 *        [--dpr=2] [--ready="js expression returning a promise/value to await before the wait"]
 *        [--eval="js to run after ready (may be async), result is printed"]
 *
 * Examples:
 *   node scripts/shot.mjs http://localhost:5181/dev/render.html artifacts/render.png --wait=2000
 *   node scripts/shot.mjs http://localhost:5173/ artifacts/app.png \
 *        --ready="window.__deluge.ready" --eval="window.__deluge.runFor(600)" --wait=500
 *
 * Prints every console message and page error. Exit code 1 if any page error or console.error occurred.
 * NOTE: must use channel 'chromium' (new headless) — the default headless shell only gets SwiftShader.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [url, out, ...rest] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--wait=ms] [--ready=js] [--eval=js]');
  process.exit(2);
}
const opt = Object.fromEntries(
  rest.map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/s);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), 'true'];
  }),
);
const width = Number(opt.width ?? 1600);
const height = Number(opt.height ?? 1000);
const wait = Number(opt.wait ?? 1500);
const timeout = Number(opt.timeout ?? 120000);

const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
});
let bad = 0;
try {
  // --dpr emulates a Retina demo machine (the MacBook Air M4 runs 1470x956 CSS px at DPR 2). Defaults to 1 so
  // existing callers and baselines are unchanged.
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: Number(opt.dpr ?? 1) });
  page.on('response', (r) => {
    if (r.status() >= 400) console.log(`[http ${r.status()}] ${r.url()}`);
  });
  page.on('console', (m) => {
    const t = m.type();
    // Resource 404s are reported via the response handler above (with URL); don't fail on e.g. favicon.
    if (t === 'error' && !m.text().startsWith('Failed to load resource')) bad++;
    console.log(`[console.${t}] ${m.text()}`);
  });
  page.on('pageerror', (e) => {
    bad++;
    console.log(`[pageerror] ${e.message}\n${e.stack ?? ''}`);
  });
  page.setDefaultTimeout(timeout);
  await page.goto(url, { waitUntil: 'load', timeout });
  if (opt.ready) {
    await page.evaluate(`(async () => { await (${opt.ready}); })()`);
  }
  if (opt.eval) {
    const r = await page.evaluate(`(async () => (${opt.eval}))()`);
    console.log('[eval result]', JSON.stringify(r, null, 2)?.slice(0, 4000));
  }
  await page.waitForTimeout(wait);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out });
  console.log(`[shot] saved ${out}`);
} catch (e) {
  bad++;
  console.log('[shot error]', e.message);
} finally {
  await browser.close();
}
process.exit(bad ? 1 : 0);
