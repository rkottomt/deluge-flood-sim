#!/usr/bin/env node
/**
 * Record a narrated story (src/story) as an MP4 for pitches.
 *
 *   node scripts/record-story.mjs                         Nepal 2026 → artifacts/stories/nepal-2026.mp4
 *   node scripts/record-story.mjs --story=pittsburgh-1936
 *   node scripts/record-story.mjs --all                   every bundled story
 *   node scripts/record-story.mjs --url=http://localhost:4173/   record from a server you already run
 *
 * Flags: --width=1920 --height=1080 --fps=30 --crf=18 --out=artifacts/stories --keep-frames --headed
 *        --ffmpeg=<path>  (default: $FFMPEG, then `ffmpeg` on PATH)
 *
 * How: it builds the RELEASED bundle (plain `vite build`, no debug API — the recording is exactly what a visitor sees),
 * serves it with `vite preview` in this process, and opens `?story=<id>` in headless Chromium on the real GPU with every
 * external host blocked (the stories are offline; a dam story's valley is a live area, see NETWORK_IDS). It captures the page through the DevTools screencast (JPEG frames
 * with timestamps), restarts the story from its first beat once the capture runs (← on beat 1 replays it), waits for
 * the card to say the story has finished, and resamples the frames to a constant frame rate:
 * artifacts/stories/work/<id>/frame-00001.jpg … — the same JPEG-sequence layout submission/video/tools/encode-h264
 * reads. Then it encodes H.264 with ffmpeg (libx264, yuv420p, +faststart). Without ffmpeg on macOS it falls back to
 * submission/video/tools/encode-h264 (VideoToolbox); otherwise it keeps the frames and prints the command to run.
 *
 * The server and the browser are always closed on exit. artifacts/ is gitignored.
 */
import { chromium } from 'playwright';
import { build, preview } from 'vite';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, args.out ?? path.join('artifacts', 'stories'));
const WIDTH = Number(args.width ?? 1920);
const HEIGHT = Number(args.height ?? 1080);
const FPS = Number(args.fps ?? 30);
const CRF = Number(args.crf ?? 18);
/** Story ids, read from the registry's sources so this script needs no TypeScript loader. */
const SOURCES = fs
  .readdirSync(path.join(ROOT, 'src', 'story', 'stories'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => fs.readFileSync(path.join(ROOT, 'src', 'story', 'stories', f), 'utf8'));
const idOf = (src) => /\bid:\s*'([a-z0-9-]+)'/.exec(src)?.[1];
const ALL_IDS = SOURCES.map(idOf).filter(Boolean);
/**
 * Stories whose scene is a dam breach (`dam: { nid: … }` instead of a preset) load the valley below the dam as a live
 * area, so they need the internet for USGS 3DEP, imagery and roads, like the dam-breach use case: those are recorded
 * with the network allowed (--offline blocks it for them too). Every other story stays offline.
 */
const NETWORK_IDS = new Set(SOURCES.filter((src) => /\bdam:\s*\{\s*nid:/.test(src)).map(idOf).filter(Boolean));
const IDS = args.all ? ALL_IDS : [String(args.story ?? 'nepal-2026')];
for (const id of IDS) if (!ALL_IDS.includes(id)) throw new Error(`unknown story "${id}" (have: ${ALL_IDS.join(', ')})`);
/** Longest a story may take before the recording gives up, ms (every wait at its cap, plus slack). */
const STORY_TIMEOUT_MS = Number(args.timeout ?? 15 * 60_000);

let server = null;
let browser = null;
async function cleanup() {
  try {
    await browser?.close();
  } catch {
    /* gone */
  }
  browser = null;
  try {
    if (server?.close) await server.close();
    else if (server?.httpServer) await new Promise((r) => server.httpServer.close(r));
  } catch {
    /* exiting */
  }
  server = null;
}
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await cleanup();
    process.exit(130);
  });
}

const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });

async function startServer() {
  const outDir = path.join(OUT, 'dist');
  const common = { root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn', clearScreen: false };
  // The released bundle: no automation handles (SEC-07). Explicitly off even if the caller's shell sets it.
  process.env.DELUGE_DEBUG_API = '0';
  console.log('[record] building the production bundle…');
  await build({ ...common, build: { outDir, emptyOutDir: true } });
  let port = Number(args.port ?? 5740);
  while (!(await portFree(port))) port++;
  server = await preview({ ...common, build: { outDir }, preview: { port, strictPort: true, host: '127.0.0.1', open: false } });
  return `http://127.0.0.1:${port}/`;
}

const isLocal = (u) => {
  try {
    const { protocol, hostname } = new URL(u);
    if (protocol === 'data:' || protocol === 'blob:' || protocol === 'about:') return true;
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return true;
  }
};

function findFfmpeg() {
  for (const cand of [args.ffmpeg, process.env.FFMPEG, 'ffmpeg'].filter(Boolean)) {
    const r = spawnSync(cand, ['-hide_banner', '-version'], { encoding: 'utf8' });
    if (r.status === 0) return cand;
  }
  return null;
}

/** Resample timestamped frames to a constant rate: frame k shows the latest capture at or before k/fps. */
function writeConstantRate(frames, dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const t0 = frames[0].t;
  const t1 = frames[frames.length - 1].t;
  const n = Math.max(1, Math.round((t1 - t0) * FPS) + 1);
  let j = 0;
  let written = 0;
  for (let k = 0; k < n; k++) {
    const t = t0 + k / FPS;
    while (j + 1 < frames.length && frames[j + 1].t <= t) j++;
    fs.writeFileSync(path.join(dir, `frame-${String(k + 1).padStart(5, '0')}.jpg`), frames[j].data);
    written++;
  }
  return { count: written, seconds: t1 - t0 };
}

async function recordOne(baseUrl, id) {
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
  const blocked = [];
  const online = NETWORK_IDS.has(id) && !args.offline;
  if (online) console.log(`[record] ${id} breaches a dam on a live area: the network is allowed for this one`);
  await context.route((u) => !isLocal(u.href), (route) => {
    if (online) return route.continue();
    blocked.push(route.request().url());
    return route.abort('internetdisconnected');
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) console.log(`  [console.error] ${m.text().slice(0, 300)}`);
  });
  const url = new URL(baseUrl);
  url.searchParams.set('story', id);
  console.log(`[record] ${id}: ${url.href}`);
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`.dl-nar[data-story="${id}"]`, { timeout: 180_000 });
  // Let the first frames of the scene settle before the capture starts.
  await page.waitForTimeout(1500);

  const cdp = await context.newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    frames.push({ t: f.metadata.timestamp ?? Date.now() / 1000, data: Buffer.from(f.data, 'base64') });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: WIDTH, maxHeight: HEIGHT, everyNthFrame: 1 });
  // From the top: ← on the first beat replays it (its reset puts the scene back), on a later one steps back to it.
  for (let i = 0; i < 3; i++) {
    const beat = await page.evaluate(() => document.querySelector('.dl-nar')?.getAttribute('data-beat'));
    const first = await page.evaluate(() => document.querySelector('.dl-nar-seg')?.getAttribute('data-beat'));
    await page.keyboard.press('ArrowLeft');
    if (beat === first) break;
  }
  const t0 = Date.now();
  let lastBeat = '';
  while (Date.now() - t0 < STORY_TIMEOUT_MS) {
    const st = await page.evaluate(() => {
      const el = document.querySelector('.dl-nar');
      return { state: el?.getAttribute('data-state') ?? '', beat: el?.getAttribute('data-beat') ?? '', story: el?.getAttribute('data-story') ?? '' };
    });
    if (st.story !== id) throw new Error(`the story stopped (card shows "${st.story}")`);
    if (st.beat !== lastBeat && st.state !== 'finished') {
      lastBeat = st.beat;
      console.log(`  ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  beat ${st.beat}`);
    }
    if (st.state === 'finished') break;
    await page.waitForTimeout(250);
  }
  // The end card, briefly.
  await page.waitForTimeout(2500);
  await cdp.send('Page.stopScreencast').catch(() => {});
  await page.waitForTimeout(200);
  if (blocked.length) console.log(`  [offline] ${blocked.length} external requests blocked: ${[...new Set(blocked.map((u) => new URL(u).host))].join(', ')}`);
  await context.close();
  if (frames.length < 2) throw new Error('no frames captured');
  frames.sort((a, b) => a.t - b.t);

  const work = path.join(OUT, 'work', id);
  const { count, seconds } = writeConstantRate(frames, work);
  console.log(`  ${frames.length} captured frames → ${count} at ${FPS} fps (${seconds.toFixed(1)} s) in ${path.relative(ROOT, work)}`);
  const mp4 = path.join(OUT, `${id}.mp4`);
  const ffmpeg = findFfmpeg();
  if (ffmpeg) {
    const r = spawnSync(
      ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', path.join(work, 'frame-%05d.jpg'),
        '-vf', `scale=${WIDTH}:${HEIGHT}:flags=lanczos,format=yuv420p`, '-c:v', 'libx264', '-preset', 'slow', '-crf', String(CRF),
        '-movflags', '+faststart', mp4],
      { stdio: 'inherit' },
    );
    if (r.status !== 0) throw new Error(`ffmpeg exited ${r.status}`);
  } else {
    const tool = path.join(ROOT, 'submission', 'video', 'tools', 'encode-h264');
    if (process.platform === 'darwin' && fs.existsSync(tool)) {
      const r = spawnSync(tool, [`--frames=${work}`, `--out=${mp4}`, `--fps=${FPS}`, `--width=${WIDTH}`, `--height=${HEIGHT}`], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`encode-h264 exited ${r.status}`);
    } else {
      console.log(`  no ffmpeg found: frames kept in ${work}. Encode with:\n  ffmpeg -framerate ${FPS} -i "${path.join(work, 'frame-%05d.jpg')}" -c:v libx264 -pix_fmt yuv420p -crf ${CRF} "${mp4}"`);
      return null;
    }
  }
  if (!args['keep-frames']) fs.rmSync(work, { recursive: true, force: true });
  const mb = fs.statSync(mp4).size / 1e6;
  console.log(`  → ${path.relative(ROOT, mp4)} (${mb.toFixed(1)} MB, ${seconds.toFixed(0)} s)`);
  return mp4;
}

try {
  fs.mkdirSync(OUT, { recursive: true });
  const baseUrl = args.url ? String(args.url) : await startServer();
  browser = await chromium.launch({
    headless: args.headed !== 'true',
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const made = [];
  for (const id of IDS) {
    const f = await recordOne(baseUrl, id);
    if (f) made.push(f);
  }
  console.log(`[record] done: ${made.map((f) => path.relative(ROOT, f)).join(', ') || 'frames only'}`);
} catch (e) {
  console.error(`[record] failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
