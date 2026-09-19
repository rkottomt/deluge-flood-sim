#!/usr/bin/env node
/**
 * Deluge GRAPHICS-GLITCH SUITE — "is anything on screen wrong?", as a pass/fail gate.
 *
 *   npm run test:visual                  # full run (~5 min): 15 deterministic scenes
 *   npm run test:visual -- --quick       # fast subset (~1.5 min): 5 scenes
 *   node scripts/visual.mjs --update     # re-record the committed baselines after an intended change
 *   node scripts/visual.mjs --url=https://example.com/deluge/   # check a hosted copy
 *
 * From a fresh clone with no extra setup it builds the production bundle, serves it, and drives it in headless
 * Chromium on the real GPU at the demo viewport (1470x956 @ DPR 2).
 *
 * DETERMINISM. Every scene is frozen before it is captured, and each of the four wall-clock inputs is removed:
 *   · the sim is PAUSED and the render quality PINNED (no adaptive ladder chasing frame time);
 *   · the sim clock is walked to the scene's exact simulated second, not merely past it — `runFor` alone stops at
 *     the first frame that reaches the target, and one frame is ~25 simulated seconds, so the same scene used to
 *     be photographed anywhere in a 25 s window (see setupScene for the measurement and the substep ladder);
 *   · the renderer's animation clock is pinned to ANIM_CLOCK, instead of being left wherever the load's wall-clock
 *     duration stopped it (see pinAnimClock);
 *   · the camera is assigned a fixed pose (no fly-to), and the auto-dismissing toasts are hidden (see runScene).
 * What is left is GPU noise: repeat captures of a frozen scene measure 0 differing pixels at baseline resolution,
 * worst single-pixel Δ 0.017 on an M4 — which is what makes both checks below meaningful.
 *
 * TWO INDEPENDENT KINDS OF CHECK
 *   (a) GOLDEN IMAGES — each scene is compared against a committed baseline in tests/visual/baselines/ with a
 *       perceptual (YIQ-weighted) diff. The tolerance is the fraction of pixels allowed to differ; it absorbs GPU
 *       non-determinism and the live HUD readouts. Baselines are stored downscaled (÷8) so they stay small in git.
 *       To update after an intentional rendering change: review artifacts/visual/diff/*.png, then `--update`.
 *   (b) DETECTORS THAT NEED NO BASELINE — these are the real regression net, because a stale baseline approves a
 *       glitch that a detector still catches:
 *         · black / blank frame                    · NaN-magenta pixels outside the Break-it scene
 *         · water standing unsupported above terrain (hydrostatic check straight off the solver's own arrays)
 *         · shoreline stair-stepping               · z-fighting flicker (N frames, static camera, frozen sim)
 *         · missing imagery (uniform grey)         · UI panels overlapping / running off the canvas edges
 *         · legend-vs-pixels colour agreement in each hazard mode
 *
 * Thresholds were measured on the demo machine and carry margin; all are overridable by env var (see THRESHOLDS).
 * Results go to artifacts/visual/visual-results.json plus a printed table; a regression exits non-zero.
 *
 * Flags: --quick --update --url=<url> --port=<n> --json=<path> --scene=a,b --tolerance=<0..1> --headed
 *        --keep-dist --advisory --calibrate
 */
import { chromium } from 'playwright';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'artifacts', 'visual');
const BASELINE_DIR = path.join(ROOT, 'tests', 'visual', 'baselines');

// ── arguments ───────────────────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
    return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
  }),
);
const QUICK = argv.quick === 'true';
const UPDATE = argv.update === 'true';
const CALIBRATE = argv.calibrate === 'true';
const ADVISORY = CALIBRATE || argv.advisory === 'true' || process.env.DELUGE_VISUAL_ADVISORY === '1';
const KEEP_DIST = argv['keep-dist'] === 'true' || process.env.DELUGE_TEST_KEEP_DIST === '1';
const PORT = Number(argv.port ?? 5702);
const EXTERNAL_URL = String(argv.url ?? process.env.DELUGE_TEST_URL ?? '');
const JSON_OUT = String(argv.json ?? path.join(OUT_DIR, 'visual-results.json'));
const VIEWPORT = { width: 1470, height: 956, dpr: 2 };
const numEnvRaw = (key, fallback) => {
  const v = process.env[key];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
};
/** Baselines are stored at 1/8 of device resolution: 367x239, a few hundred KB each, plenty to see a real change. */
const BASELINE_SHRINK = 8;
/**
 * The renderer's animation clock (s) that every scene is photographed at (see pinAnimClock). Any fixed value
 * would do; this one sits inside the range the scenes used to settle at by themselves (3.9–8.3 s).
 */
const ANIM_CLOCK = 6;
/** Hard ceiling on one scene, so a busy machine fails the run instead of hanging it. */
const SCENE_TIMEOUT_MS = Number(argv['scene-timeout'] ?? numEnvRaw('DELUGE_VISUAL_SCENE_TIMEOUT_MS', 600000));

const numEnv = (key, fallback) => {
  const v = process.env[key];
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback;
};

// ── thresholds ──────────────────────────────────────────────────────────────────────────────────
// Measured on the demo machine (MacBook Air M4, macOS 15) on 2026-09-17 with `node scripts/visual.mjs --calibrate`.
// Each is "the worst value any scene actually produces" with margin, so a miss means something changed on screen.
const THRESHOLDS = {
  /** Golden-image diff: fraction of baseline pixels that may differ perceptually. */
  goldenDiffFrac: numEnv('DELUGE_VISUAL_TOLERANCE', 0.02),
  /** Mean luminance of the frame (0..1). Below this the frame is black / the GPU produced nothing. Darkest
   *  scene measured 0.226 (the close-up shoreline, which is mostly water in shadow). */
  minMeanLuma: numEnv('DELUGE_VISUAL_MIN_LUMA', 0.06),
  /** Standard deviation of luminance. Below this the frame is a flat colour — blank, not a scene. Flattest
   *  scene measured 0.129. */
  minLumaStd: numEnv('DELUGE_VISUAL_MIN_LUMA_STD', 0.06),
  /** Fraction of hot-magenta pixels allowed outside the Break-it scene (the blown-up-cell sentinel colour). */
  maxMagentaFrac: numEnv('DELUGE_VISUAL_MAX_MAGENTA', 0.0015),
  /** …and the minimum the Break-it scene must show, so "no glitch colour" is also a failure there. */
  minBreakitMagentaFrac: numEnv('DELUGE_VISUAL_MIN_BREAKIT_MAGENTA', 0.004),
  /** Fraction of near-grey pixels above which the aerial imagery is presumed missing. Greyest scene with imagery
   *  measured 0.361 (the bridge close-up, which is mostly asphalt and concrete). */
  maxGreyFrac: numEnv('DELUGE_VISUAL_MAX_GREY', 0.55),
  /**
   * Shoreline blockiness: the fraction of water-edge gradients pointing within 10° of an axis. A shoreline with no
   * grid alignment at all would sit near 0.22 (20° of every 90°); a pure staircase is 1.0. Real Deluge shorelines
   * measured 0.40-0.63 today — the flood edge does follow a 1024² DEM, and the close-up is the worst case. This is
   * a REGRESSION detector, not an absolute quality bar: it catches an edge that has collapsed onto the grid.
   */
  maxShorelineAxisFrac: numEnv('DELUGE_VISUAL_MAX_STAIRSTEP', 0.75),
  /** Flicker: fraction of pixels that change between repeat captures of a frozen scene. */
  maxFlickerFrac: numEnv('DELUGE_VISUAL_MAX_FLICKER', 0.02),
  /** Legend agreement: fraction of hazard-coloured water pixels whose nearest palette is the mode's own. */
  minLegendAgreement: numEnv('DELUGE_VISUAL_MIN_LEGEND_AGREE', 0.9),
  /** Hydrostatic check: fraction of wet cells holding water that nothing supports. Worst scene measured 0.00089. */
  maxUnsupportedWaterFrac: numEnv('DELUGE_VISUAL_MAX_UNSUPPORTED', 0.004),
};

// ── scenes ──────────────────────────────────────────────────────────────────────────────────────
// `camera`: {kind:'scenario'} uses the preset's own framing; {kind:'levee'} the demo levee's; {kind:'geo'} a real
// place (falls back to the scenario camera if the point is outside the grid); {kind:'grid'} a fraction of the grid.
// `actions` run in order before the clock is advanced. `simSeconds` is exact simulated time via runFor.
const D = Math.PI / 180;
const SCENES = [
  {
    id: 'pittsburgh-default',
    label: 'Pittsburgh, default view',
    preset: 'pittsburgh',
    quick: true,
    camera: { kind: 'scenario' },
    simSeconds: 0,
  },
  {
    id: 'pittsburgh-crest',
    label: 'Pittsburgh, 1936 crest (46 ft)',
    preset: 'pittsburgh',
    quick: true,
    camera: { kind: 'scenario' },
    actions: [{ crestFeet: 46 }],
    simSeconds: 900,
  },
  {
    id: 'pittsburgh-levee-glow',
    label: 'levee + protected-land glow',
    preset: 'pittsburgh',
    camera: { kind: 'levee' },
    actions: [{ crestFeet: 46 }, { levee: true }],
    simSeconds: 900,
    // The protection analysis runs in a worker; the scene waits for it so the glow is really on screen.
    requireProtection: true,
    /*
     * The protected-land overlay animates: this is the one frozen scene whose pixels keep moving. Measured ~2.5%
     * of the frame here, against 0.05% for the identical wall geometry without the glow (the 'drawn-wall' scene),
     * which is what isolates the glow as the cause rather than z-fighting on the wall. The allowance is raised
     * rather than the detector skipped, so a NEW source of flicker in this scene still fails.
     */
    flickerAllowance: 0.05,
  },
  {
    id: 'pittsburgh-depth',
    label: 'hazard mode: current depth',
    preset: 'pittsburgh',
    quick: true,
    camera: { kind: 'scenario' },
    mode: 'depth',
    actions: [{ crestFeet: 46 }],
    simSeconds: 900,
    hazard: true,
  },
  {
    id: 'pittsburgh-maxdepth',
    label: 'hazard mode: max depth',
    preset: 'pittsburgh',
    camera: { kind: 'scenario' },
    mode: 'maxDepth',
    actions: [{ crestFeet: 46 }],
    simSeconds: 900,
    hazard: true,
  },
  {
    id: 'pittsburgh-velocity',
    label: 'hazard mode: flow speed',
    preset: 'pittsburgh',
    camera: { kind: 'scenario' },
    mode: 'velocity',
    actions: [{ crestFeet: 46 }, { rain: 100 }],
    simSeconds: 600,
    hazard: true,
  },
  {
    id: 'breakit',
    label: 'Break-it (naive scheme blows up)',
    preset: 'pittsburgh',
    quick: true,
    camera: { kind: 'scenario' },
    actions: [{ crestFeet: 46 }, { breakIt: true }],
    simSeconds: 400,
    // The point of this scene is that the glitch colours ARE there; every other scene must have none.
    expectMagenta: true,
    // A blown-up solver produces non-finite depths on purpose, so the hydrostatic check does not apply — and the
    // glitch shader animates its speckle by design (src/render/shaders/water.ts mixes two colours by a per-cell
    // flicker), so a frozen capture of THIS scene is meant to differ from the next one. Measured ~7% of pixels.
    skipDetectors: ['unsupportedWater', 'shoreline', 'flicker'],
  },
  {
    id: 'johnstown',
    label: 'Johnstown, scenario camera',
    preset: 'johnstown',
    camera: { kind: 'scenario' },
    simSeconds: 300,
  },
  {
    id: 'ellicott',
    label: 'Ellicott City, scenario camera',
    preset: 'ellicott',
    camera: { kind: 'scenario' },
    simSeconds: 300,
  },
  {
    id: 'sandbox',
    label: 'Sandbox (synthetic terrain)',
    preset: 'sandbox',
    quick: true,
    camera: { kind: 'scenario' },
    simSeconds: 300,
    // The sandbox is generated, not photographed: it has no aerial imagery by design.
    skipDetectors: ['greyImagery'],
  },
  {
    id: 'shoreline-closeup',
    label: 'close-up shoreline at the Point',
    preset: 'pittsburgh',
    // Hazard colours give the shoreline detector an unambiguous water mask.
    mode: 'depth',
    camera: { kind: 'geo', lon: -80.0125, lat: 40.4417, distance: 700, yaw: 210 * D, pitch: 22 * D },
    actions: [{ crestFeet: 46 }],
    simSeconds: 900,
    hazard: true,
  },
  {
    id: 'drawn-wall',
    label: 'a drawn wall, close up',
    preset: 'pittsburgh',
    camera: { kind: 'wall' },
    actions: [{ crestFeet: 46 }, { wall: true }],
    simSeconds: 900,
  },
  {
    id: 'bridge',
    label: 'bridge over the Allegheny',
    preset: 'pittsburgh',
    camera: { kind: 'geo', lon: -80.0053, lat: 40.4457, distance: 900, yaw: 130 * D, pitch: 18 * D },
    actions: [{ crestFeet: 30 }],
    simSeconds: 600,
  },
  {
    id: 'top-down',
    label: 'top-down',
    preset: 'pittsburgh',
    camera: { kind: 'scenario', pitch: 89.5 * D, distance: 4200 },
    actions: [{ crestFeet: 46 }],
    simSeconds: 900,
  },
  {
    id: 'grazing-angle',
    label: 'low grazing angle (horizon)',
    preset: 'pittsburgh',
    camera: { kind: 'scenario', pitch: 4 * D, distance: 3200 },
    actions: [{ crestFeet: 46 }],
    simSeconds: 900,
    // At 4° the water plane is edge-on: a shoreline metric measured there says nothing about the mesh.
    skipDetectors: ['shoreline'],
  },
];

// ────────────────────────────────────────────────────────────────────────────────────────────────
// PNG codec (8-bit truecolour, no interlacing) — Node's zlib is the only dependency.
// ────────────────────────────────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Decode a PNG into {width, height, data} with 4 bytes per pixel. Throws on formats this suite never produces. */
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
      if (body[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') idat.push(Buffer.from(body));
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const prev = new Uint8Array(stride);
  const line = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    raw.copy(line, 0, p, p + stride);
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[i] = v & 0xff;
    }
    const o = y * width * 4;
    for (let x = 0; x < width; x++) {
      out[o + x * 4] = line[x * channels];
      out[o + x * 4 + 1] = line[x * channels + 1];
      out[o + x * 4 + 2] = line[x * channels + 2];
      out[o + x * 4 + 3] = channels === 4 ? line[x * channels + 3] : 255;
    }
    prev.set(line);
  }
  return { width, height, data: out };
}

/** Encode {width, height, data} (RGBA) as a truecolour PNG, dropping alpha (every frame here is opaque). */
function encodePNG(img) {
  const { width, height, data } = img;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const cur = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      cur[x * 3] = data[(y * width + x) * 4];
      cur[x * 3 + 1] = data[(y * width + x) * 4 + 1];
      cur[x * 3 + 2] = data[(y * width + x) * 4 + 2];
    }
    // Paeth (filter 4): the best of the simple filters for photographic content.
    const base = y * (stride + 1);
    raw[base] = 4;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? cur[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      const pa = Math.abs(b - c);
      const pb = Math.abs(a - c);
      const pc = Math.abs(a + b - 2 * c);
      const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      raw[base + 1 + i] = (cur[i] - pred) & 0xff;
    }
    prev.set(cur);
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(12 + body.length);
    out.writeUInt32BE(body.length, 0);
    out.write(type, 4, 'latin1');
    body.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── image helpers ───────────────────────────────────────────────────────────────────────────────
/** Box-average downscale by an integer factor. */
function shrink(img, factor) {
  const w = Math.floor(img.width / factor);
  const h = Math.floor(img.height / factor);
  const out = new Uint8Array(w * h * 4);
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let j = 0; j < factor; j++) {
        const row = ((y * factor + j) * img.width + x * factor) * 4;
        for (let i = 0; i < factor; i++) {
          r += img.data[row + i * 4];
          g += img.data[row + i * 4 + 1];
          b += img.data[row + i * 4 + 2];
        }
      }
      const o = (y * w + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

const lum = (r, g, b) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

/**
 * Perceptual difference between two same-size images, pixelmatch-style: the distance is measured in YIQ, where
 * luminance dominates, so a pixel has to be visibly different to count. Returns the fraction of differing pixels
 * and a diff image (magenta over a dimmed original) for eyeballing.
 */
function perceptualDiff(a, b, sensitivity = 0.12) {
  const n = a.width * a.height;
  const diff = new Uint8Array(n * 4);
  let changed = 0;
  let worst = 0;
  const yiq = (r, g, b2) => [
    0.29889531 * r + 0.58662247 * g + 0.11448223 * b2,
    0.59597799 * r - 0.2741761 * g - 0.32180189 * b2,
    0.21147017 * r - 0.52261711 * g + 0.31114694 * b2,
  ];
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const [y1, i1, q1] = yiq(a.data[o], a.data[o + 1], a.data[o + 2]);
    const [y2, i2, q2] = yiq(b.data[o], b.data[o + 1], b.data[o + 2]);
    const dy = y1 - y2;
    const d = Math.sqrt(0.5053 * dy * dy + 0.299 * (i1 - i2) ** 2 + 0.1957 * (q1 - q2) ** 2) / 255;
    if (d > worst) worst = d;
    if (d > sensitivity) {
      changed++;
      diff[o] = 255;
      diff[o + 1] = 40;
      diff[o + 2] = 255;
    } else {
      const g = 30 + lum(a.data[o], a.data[o + 1], a.data[o + 2]) * 140;
      diff[o] = diff[o + 1] = diff[o + 2] = g;
    }
    diff[o + 3] = 255;
  }
  return { frac: changed / n, changed, worst: +worst.toFixed(3), image: { width: a.width, height: a.height, data: diff } };
}

// ── baseline-free detectors (run on the full-resolution capture) ─────────────────────────────────
/** Black / blank frame, and the "missing imagery" grey check, in one pass over the pixels. */
function frameStats(img) {
  const n = img.width * img.height;
  let sum = 0;
  let sumSq = 0;
  let magenta = 0;
  let grey = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const r = img.data[o];
    const g = img.data[o + 1];
    const b = img.data[o + 2];
    const l = lum(r, g, b);
    sum += l;
    sumSq += l * l;
    // The blown-up-cell sentinel tone-maps to a hot pink/magenta: strong red AND blue, starved green.
    if (r > 150 && b > 110 && g < 0.6 * Math.min(r, b)) magenta++;
    // Aerial imagery is colourful; a grey frame means the photo layer never arrived. Sky is excluded by
    // requiring a mid luminance (the sky gradient is blue, and blue is not grey, so it rarely counts anyway).
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn < 10 && l > 0.06 && l < 0.92) grey++;
  }
  const mean = sum / n;
  return {
    meanLuma: +mean.toFixed(4),
    lumaStd: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(4),
    magentaFrac: +(magenta / n).toFixed(5),
    greyFrac: +(grey / n).toFixed(4),
  };
}

/**
 * Water mask + shoreline blockiness + legend agreement for a hazard mode.
 *
 * The mask comes from the app itself: `refImg` is the SAME frozen scene rendered in a different hazard mode, so the
 * pixels that changed are exactly the hazard-mapped water — no absolute colour threshold to tune, and terrain, sky
 * and UI drop out for free. Within that mask, each pixel's nearest legend swatch (scraped live from the app's own
 * legend) must belong to the mode being rendered; if a mode is ever wired to the wrong ramp, agreement collapses.
 * Blockiness is the share of water-edge gradients within 10° of an axis: a shoreline that has collapsed onto the
 * simulation grid is a staircase, and staircases are axis-aligned.
 */
function analyzeHazard(img, refImg, palettes, mode, refMode) {
  const { width: w, height: h, data } = img;
  const mask = new Uint8Array(w * h);
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const d =
      Math.max(
        Math.abs(data[o] - refImg.data[o]),
        Math.abs(data[o + 1] - refImg.data[o + 1]),
        Math.abs(data[o + 2] - refImg.data[o + 2]),
      );
    if (d > 18) {
      mask[i] = 1;
      total++;
    }
  }
  const names = Object.keys(palettes);
  // sRGB distance a lit, tone-mapped swatch colour may drift and still be recognisably that band.
  const MAX_D2 = 60 * 60;
  const nearest = (r, g, b) => {
    let best = Infinity;
    let bestName = null;
    for (const name of names) {
      for (const c of palettes[name]) {
        const dd = (r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2;
        if (dd < best) {
          best = dd;
          bestName = name;
        }
      }
    }
    return best <= MAX_D2 ? bestName : null;
  };
  // Only pixels that actually look like SOME legend swatch are judged. Not every mapped pixel is one: the velocity
  // map deliberately leaves its slowest band as plain photoreal water, and depth/max-depth leave the normal river
  // alone (src/render/legend.ts). Those are excluded rather than counted as disagreement.
  let own = 0;
  let classified = 0;
  let refOwn = 0;
  let refClassified = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const o = i * 4;
    const a = nearest(data[o], data[o + 1], data[o + 2]);
    if (a) {
      classified++;
      if (a === mode) own++;
    }
    const b = nearest(refImg.data[o], refImg.data[o + 1], refImg.data[o + 2]);
    if (b) {
      refClassified++;
      if (b === refMode) refOwn++;
    }
  }
  // Sobel on the mask → gradient-direction histogram at the water edge.
  let edge = 0;
  let axis = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const k = y * w + x;
      const gx =
        mask[k - w + 1] + 2 * mask[k + 1] + mask[k + w + 1] - (mask[k - w - 1] + 2 * mask[k - 1] + mask[k + w - 1]);
      const gy =
        mask[k + w - 1] + 2 * mask[k + w] + mask[k + w + 1] - (mask[k - w - 1] + 2 * mask[k - w] + mask[k - w + 1]);
      const m = Math.hypot(gx, gy);
      if (m < 2) continue;
      edge++;
      const ang = Math.abs(((Math.atan2(gy, gx) * 180) / Math.PI) % 90);
      if (ang < 10 || ang > 80) axis++;
    }
  }
  return {
    refMode,
    waterFrac: +(total / (w * h)).toFixed(4),
    classifiedFrac: total ? +(classified / total).toFixed(4) : null,
    legendAgreement: classified > 500 ? +(own / classified).toFixed(4) : null,
    refLegendAgreement: refClassified > 500 ? +(refOwn / refClassified).toFixed(4) : null,
    shorelineEdgePixels: edge,
    shorelineAxisFrac: edge > 200 ? +(axis / edge).toFixed(4) : null,
  };
}

/** Largest fraction of pixels that changes between repeat captures of a frozen scene (z-fighting / flicker). */
function flickerFrac(frames) {
  let worst = 0;
  for (let f = 1; f < frames.length; f++) {
    const a = frames[0];
    const b = frames[f];
    let changed = 0;
    const n = a.width * a.height;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (
        Math.abs(a.data[o] - b.data[o]) > 8 ||
        Math.abs(a.data[o + 1] - b.data[o + 1]) > 8 ||
        Math.abs(a.data[o + 2] - b.data[o + 2]) > 8
      ) {
        changed++;
      }
    }
    worst = Math.max(worst, changed / n);
  }
  return +worst.toFixed(5);
}

// ── in-page code ────────────────────────────────────────────────────────────────────────────────
/**
 * Put the app into an exactly reproducible state and freeze it. Runs inside the page.
 * Returns what it actually did, so the report can show (for instance) which camera fallback was used.
 */
async function setupScene(spec) {
  const d = window.__deluge;
  await d.ready;
  const solver = d.getSolver();
  const nx = solver.nx;
  const ny = solver.ny;
  const info = { nx, ny, cameraSource: spec.camera.kind, actions: [] };

  d.setPaused(true);
  d.resetWater();
  if (spec.mode) d.setWaterMode(spec.mode);
  // Pin the quality ladder. On 'auto' the adaptive controller moves render scale in response to frame timing, so
  // two captures of the SAME frozen scene differ by a resample — and a slower machine would record a different
  // baseline entirely. Pinning makes the scene a property of the app, not of the laptop.
  const renderer = d.getRenderer();
  if (renderer?.setQuality) renderer.setQuality('high');
  d.setAdaptiveBudget(false);
  info.quality = renderer?.quality ?? null;

  const groundAt = (gx, gy) => d.sampleAt(gx, gy)?.ground ?? 0;
  let wallPoints = null;
  for (const a of spec.actions ?? []) {
    if (a.crestFeet !== undefined) {
      const off = d.stageOffsetForFeet(a.crestFeet);
      if (off !== null) d.setStage(off, { instant: true });
      info.actions.push(`crest ${a.crestFeet} ft → ${off}`);
    }
    if (a.rain !== undefined) {
      d.setRain(a.rain);
      info.actions.push(`rain ${a.rain} mm/hr`);
    }
    if (a.levee) {
      const levee = d.getScenario()?.levee;
      if (levee) {
        // drawWall's `height` is the barrier's height ABOVE GROUND (src/sim/brush.ts), not an absolute elevation,
        // so each segment gets its own height to reach the scenario's crest — which is what src/ui/levee.ts does
        // for the one-click demo levee. Passing the crest directly builds a 200 m wall.
        let maxH = 0;
        for (let k = 0; k + 1 < levee.points.length; k++) {
          const p0 = levee.points[k];
          const p1 = levee.points[k + 1];
          const h = Math.max(0, levee.crest - Math.max(groundAt(p0.gx, p0.gy), groundAt(p1.gx, p1.gy)));
          if (h > maxH) maxH = h;
          d.drawWall([p0, p1], h);
        }
        info.actions.push(`demo levee (${levee.points.length} pts, crest ${levee.crest} m, tallest segment ${maxH.toFixed(1)} m)`);
      } else info.actions.push('demo levee MISSING');
    }
    if (a.wall) {
      // A short wall across the flood plain, placed from the scenario camera's target so it is always in frame.
      const cam = d.getScenario()?.camera;
      const cx = cam ? cam.target.gx : nx * 0.5;
      const cy = cam ? cam.target.gy : ny * 0.5;
      const span = Math.round(Math.min(nx, ny) * 0.06);
      wallPoints = [
        { gx: cx - span, gy: cy - span * 0.35 },
        { gx: cx, gy: cy },
        { gx: cx + span, gy: cy + span * 0.35 },
      ];
      // Height above ground, like the wall tool's own brush: a levee a presenter would actually draw.
      const height = 9;
      d.drawWall(wallPoints, height);
      info.wall = { points: wallPoints, heightM: height };
      info.actions.push(`drawn wall, ${height} m above ground`);
    }
    if (a.breakIt) {
      d.actions.setStabilityDemo(true);
      info.actions.push('stability demo ON');
    }
  }

  /*
   * Exact simulated time, independent of how fast this machine is. Advanced BEFORE the camera is moved: runFor
   * competes with rendering for the GPU, and a close-up pose makes each frame expensive enough that the same 900
   * simulated seconds took minutes instead of tens of seconds. The water state does not depend on the camera.
   *
   * runFor() alone is NOT exact — it stops at the first frame that reaches the target, and a frame under it runs
   * a whole substep-capped block (APP_CONFIG.runForTimeScale 3600, SIM_PARAMS.maxSubstepsPerFrame 120), which on a
   * 1024² preset is 120 × the CFL dt ≈ 25 simulated seconds. So `runFor(600)` lands anywhere in [600, 625) and the
   * scene that gets photographed is a different one each run. That is measured, not assumed: two fresh loads of
   * pittsburgh-velocity landed at 662.4 s and 705.8 s, and the golden diff between them tracks the gap at
   * ≈ 0.04 % of pixels per simulated second (+25.6 s → 1.06 %, +51.3 s → 2.33 %, +77.0 s → 3.38 %). At the 2 %
   * tolerance that is the whole flake: the suite was comparing frames up to a minute of river apart.
   *
   * So walk the cap down instead. Each rung measures one frame's real advance (runFor always completes the frame
   * it is on, so runFor(0) is exactly one frame), leaves that much room, and covers the rest in one call; the last
   * rung runs a single substep per frame, so the clock lands within one CFL dt (≈ 0.2 s) of the target every time.
   * The cap only ever goes DOWN, so the solver never takes a step it would not have taken on its own.
   */
  if (spec.simSeconds > 0) {
    const userCap = d.getState().sim.maxSubstepsPerFrame;
    // A cap layer can only LOWER the user's value (src/app/simSync.ts), so this is the one knob that shortens a frame.
    const setCap = (n) => d.store.set({ sim: { ...d.getState().sim, maxSubstepsPerFrame: n } });
    /** One frame's simulated advance at the current cap (runFor finishes the frame it is on, so runFor(0) is one). */
    const frameAdvance = async () => {
      for (let i = 0; i < 20; i++) {
        const t0 = d.getSimClock();
        await d.runFor(0);
        const adv = d.getSimClock() - t0;
        if (adv > 0) return adv;
      }
      return 0;
    };
    info.simLadder = [];
    try {
      // The coarse rung runs first, so the target must exceed one frame at the user's cap (~25 s at 1024²); every
      // scene here asks for ≥ 300. A shorter one would overshoot, which `simClockError` in the report would show.
      for (const cap of [userCap, 16, 4, 1]) {
        if (d.getSimClock() >= spec.simSeconds) break;
        setCap(cap);
        const step = await frameAdvance();
        const left = spec.simSeconds - d.getSimClock();
        // Leave a frame and a half of room so this rung always UNDERSHOOTS; the next, finer one closes the gap.
        // The last rung is a single substep per frame, so it may land on the target without leaving any.
        const ask = cap === 1 ? left : left - step * 1.5;
        info.simLadder.push({ cap, step: +step.toFixed(3), left: +left.toFixed(3), ask: +ask.toFixed(3) });
        if (ask > 0) await d.runFor(ask);
      }
    } finally {
      setCap(userCap);
    }
  }
  info.simClock = +d.getSimClock().toFixed(3);
  info.simClockError = +(d.getSimClock() - spec.simSeconds).toFixed(3);
  if (spec.requireProtection) {
    for (let i = 0; i < 100 && !d.getProtection(); i++) await new Promise((r) => setTimeout(r, 100));
    info.protection = d.getProtection();
  }
  // Camera: assigned, never animated, so the frame is identical on every run.
  const scenarioCam = d.getScenario()?.camera ?? null;
  const leveeCam = d.getScenario()?.levee?.camera ?? null;
  const c = spec.camera;
  let pose = null;
  if (c.kind === 'scenario') pose = scenarioCam;
  else if (c.kind === 'levee') pose = leveeCam ?? scenarioCam;
  else if (c.kind === 'wall' && wallPoints) {
    const mid = wallPoints[1];
    pose = {
      target: { gx: mid.gx, gy: mid.gy, elevation: groundAt(mid.gx, mid.gy) },
      distance: 520,
      yaw: 200 * (Math.PI / 180),
      pitch: 20 * (Math.PI / 180),
    };
  } else if (c.kind === 'geo') {
    const g = d.geoToGrid(c.lon, c.lat);
    if (g && g.gx > 0 && g.gy > 0 && g.gx < nx && g.gy < ny) {
      pose = {
        target: { gx: g.gx, gy: g.gy, elevation: groundAt(g.gx, g.gy) },
        distance: c.distance,
        yaw: c.yaw,
        pitch: c.pitch,
      };
    } else {
      info.cameraSource = 'geo→scenario fallback (point outside grid)';
      pose = scenarioCam;
    }
  } else if (c.kind === 'grid') {
    const gx = nx * c.fx;
    const gy = ny * c.fy;
    pose = { target: { gx, gy, elevation: groundAt(gx, gy) }, distance: c.distance, yaw: c.yaw, pitch: c.pitch };
  }
  if (!pose) {
    // Every preset ships a camera; if one ever does not, frame the middle of the grid rather than fail the scene.
    info.cameraSource += ' → grid centre fallback';
    pose = {
      target: { gx: nx * 0.5, gy: ny * 0.5, elevation: groundAt(nx * 0.5, ny * 0.5) },
      distance: Math.min(nx, ny) * 4,
      yaw: Math.PI,
      pitch: 30 * (Math.PI / 180),
    };
  }
  pose = {
    target: { ...pose.target },
    distance: c.distance ?? pose.distance,
    yaw: c.yaw ?? pose.yaw,
    pitch: c.pitch ?? pose.pitch,
  };
  d.setCamera(pose);
  info.pose = {
    gx: +pose.target.gx.toFixed(2),
    gy: +pose.target.gy.toFixed(2),
    elevation: +(pose.target.elevation ?? 0).toFixed(2),
    distance: +pose.distance.toFixed(1),
    yawDeg: +((pose.yaw * 180) / Math.PI).toFixed(2),
    pitchDeg: +((pose.pitch * 180) / Math.PI).toFixed(2),
  };

  return info;
}

/**
 * Wait until the picture stops changing by itself: the render pacer freezes its animation clock ~1.2 s after the
 * last change (src/app/pacer.ts), and a frozen clock is what makes repeat captures comparable.
 */
async function settle(maxMs) {
  const d = window.__deluge;
  const t0 = performance.now();
  let last = -1;
  while (performance.now() - t0 < maxMs) {
    await new Promise((r) => setTimeout(r, 300));
    const t = d.getPerf().animTime;
    if (t === last) return { frozen: true, animTime: +t.toFixed(4), waitedMs: Math.round(performance.now() - t0) };
    last = t;
  }
  return { frozen: false, animTime: +d.getPerf().animTime.toFixed(4), waitedMs: Math.round(maxMs) };
}

/**
 * Freeze the renderer's animation clock at one fixed value for every run.
 *
 * The pacer's clock is wall-clock driven (`animTime += realDt` on full-rate frames, src/app/pacer.ts), so settle()
 * leaves it stopped at whatever the load happened to take — 3.9 s to 8.3 s across the suite's own scenes. The water
 * shader takes it as `F.time` for ripple phase, ripple advection and the Break-it speckle, so the frozen picture is
 * a function of how long the machine took to get here. Measured, that is a small effect on the golden diff (a whole
 * second of shift moved 0.006 % of pixels in pittsburgh-velocity), but it costs nothing to remove and it keeps a
 * wall clock out of a test that claims to be deterministic. Pinned AFTER settle(), while the pacer is idling at its
 * 4 Hz heartbeat: those frames do not advance the clock, so the value sticks.
 */
async function pinAnimClock(t) {
  const d = window.__deluge;
  d.app.pacer.animTime = t;
  // One idle heartbeat (250 ms) is enough to draw with the pinned value; wait for two.
  await new Promise((r) => setTimeout(r, 600));
  return { asked: t, animTime: +d.getPerf().animTime.toFixed(4) };
}

/**
 * Hydrostatic sanity, straight off the solver's own arrays: a wet cell whose water surface stands higher than every
 * neighbour's ground+barrier is holding water that nothing supports — the signature of a render/solver desync or a
 * wall that was written into the wrong field. Also counts non-finite depths, which must be zero outside Break-it.
 */
function simSanity() {
  const d = window.__deluge;
  const solver = d.getSolver();
  const snap = solver.getSnapshot();
  if (!snap) return null;
  const ground = solver.getGroundCPU();
  const barrier = solver.getBarrierCPU();
  const depth = snap.depth;
  const nx = solver.nx;
  const ny = solver.ny;
  let wet = 0;
  let unsupported = 0;
  let nonFinite = 0;
  let negative = 0;
  let maxSurfaceExcess = 0;
  const TOL = 0.25; // m — below this it is numerical wobble on a 1 m-scale DEM, not floating water
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      const h = depth[k];
      if (!Number.isFinite(h)) {
        nonFinite++;
        continue;
      }
      if (h < -1e-3) negative++;
      if (h <= 0.1) continue;
      wet++;
      const surf = ground[k] + h;
      let support = -Infinity;
      for (const n of [k - 1, k + 1, k - nx, k + nx]) {
        const s = ground[n] + Math.max(0, barrier[n]) + (Number.isFinite(depth[n]) ? Math.max(0, depth[n]) : 0);
        if (s > support) support = s;
      }
      const excess = surf - Math.max(support, ground[k] + Math.max(0, barrier[k]));
      if (excess > TOL) {
        unsupported++;
        if (excess > maxSurfaceExcess) maxSurfaceExcess = excess;
      }
    }
  }
  return {
    wetCells: wet,
    unsupportedCells: unsupported,
    unsupportedFrac: wet ? +(unsupported / wet).toFixed(5) : 0,
    maxSurfaceExcessM: +maxSurfaceExcess.toFixed(2),
    nonFiniteDepths: nonFinite,
    negativeDepths: negative,
  };
}

/** The legend's own swatch colours, per hazard mode, read out of the DOM the user sees. */
async function readLegendPalettes() {
  const d = window.__deluge;
  const parse = (css) => {
    const m = /rgba?\(([^)]+)\)/.exec(css);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return [p[0], p[1], p[2]];
  };
  const out = {};
  const before = d.getState().render.waterMode;
  for (const mode of ['depth', 'maxDepth', 'velocity']) {
    d.setWaterMode(mode);
    await new Promise((r) => setTimeout(r, 120));
    const swatches = [...document.querySelectorAll('.dl-legend-bar span')];
    out[mode] = swatches.map((el) => parse(getComputedStyle(el).backgroundColor)).filter(Boolean);
  }
  d.setWaterMode(before);
  await new Promise((r) => setTimeout(r, 120));
  return out;
}

/**
 * No UI may hang off the canvas edges.
 *
 * "Off the edge" means unreachable, not merely outside the viewport rectangle: the control panel is a scrolling
 * column, so its lower sections are legitimately below the fold and the user scrolls to them. An element is only an
 * offender when nothing between it and #ui-root clips or scrolls — i.e. it is positioned off-screen for good.
 */
function uiBoxes() {
  const root = document.getElementById('ui-root');
  if (!root) return { checked: 0, offenders: [{ what: '#ui-root', why: 'missing' }] };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const offenders = [];
  let checked = 0;
  const describe = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`;
  const insideScroller = (el) => {
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const st = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(st.overflowY + ' ' + st.overflowX)) return true;
    }
    return false;
  };
  for (const el of root.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    // A container that merely spans the viewport is not an offender, and anything a scroll container owns is reachable.
    if (el.children.length > 0 && r.width > vw * 0.9 && r.height > vh * 0.9) continue;
    if (insideScroller(el)) continue;
    checked++;
    const out = [];
    if (r.left < -1) out.push(`left ${Math.round(r.left)}`);
    if (r.top < -1) out.push(`top ${Math.round(r.top)}`);
    if (r.right > vw + 1) out.push(`right ${Math.round(r.right)} > ${vw}`);
    if (r.bottom > vh + 1) out.push(`bottom ${Math.round(r.bottom)} > ${vh}`);
    if (out.length) offenders.push({ what: describe(el), why: out.join(', ') });
  }
  return { checked, offenders: offenders.slice(0, 12) };
}

// ── build + serve ───────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Both stacks: `vite preview` binds only [::1] on macOS, and an IPv4-only probe would never see it. */
async function portOpen(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const s = net.connect({ port, host });
      const done = (v) => (s.destroy(), resolve(v));
      s.on('connect', () => done(true));
      s.on('error', () => done(false));
      setTimeout(() => done(false), 1000);
    });
  return (await Promise.all([probe('127.0.0.1'), probe('::1')])).some(Boolean);
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

async function buildAndServe(distDir, port, logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const log = fs.createWriteStream(logFile);
  process.stdout.write(`[visual] building production bundle → ${path.relative(ROOT, distDir)} … `);
  // The released bundle has no window.__deluge (SEC-07); this suite freezes the scenes through it, so it builds
  // the same production output with the automation surface compiled in, exactly as scripts/e2e.mjs does.
  const build = spawn('npx', ['vite', 'build', '--outDir', distDir], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DELUGE_DEBUG_API: '1' },
  });
  build.stdout.pipe(log, { end: false });
  build.stderr.pipe(log, { end: false });
  const [code] = await once(build, 'exit');
  if (code !== 0) throw new Error(`vite build failed (exit ${code}); see ${logFile}`);
  console.log('ok');
  if (await portOpen(port)) throw new Error(`port ${port} is already in use — pass --port=<free port>`);
  const server = spawn('npx', ['vite', 'preview', '--outDir', distDir, '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  for (let i = 0; i < 150; i++) {
    if (await portOpen(port)) return { server, url: `http://localhost:${port}/` };
    if (server.exitCode !== null) throw new Error(`vite preview exited (${server.exitCode}); see ${logFile}`);
    await sleep(100);
  }
  killTree(server);
  throw new Error(`vite preview never came up on ${port}; see ${logFile}`);
}

async function machineState() {
  const run = async (cmd, args) => {
    try {
      return (await execFileAsync(cmd, args, { timeout: 8000 })).stdout.trim();
    } catch {
      return '';
    }
  };
  const batt = await run('pmset', ['-g', 'batt']);
  const active = await run('pmset', ['-g']);
  return {
    host: os.hostname(),
    platform: `${os.platform()} ${os.release()}`,
    pmsetBatt: batt,
    onBattery: /Battery Power/i.test(batt),
    lowPowerMode: /lowpowermode\s+1/.test(active),
  };
}

// ── one scene ───────────────────────────────────────────────────────────────────────────────────
async function runScene(browser, baseUrl, scene, palettes) {
  const page = await browser.newPage({
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    deviceScaleFactor: VIEWPORT.dpr,
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) pageErrors.push(`console: ${m.text()}`);
  });
  const url = `${baseUrl}?preset=${scene.preset}`;
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.evaluate(async () => {
    await window.__deluge.ready;
  });
  // Let the opening fly-in finish before the camera is pinned, so nothing is still gliding.
  await page.waitForTimeout(2500);

  /*
   * The two transient toasts (the error toast and the notice toast) are the one piece of chrome a frozen scene
   * cannot freeze: they auto-dismiss on a wall-clock timer and the wall scenes re-post theirs ("The levee is
   * holding") as the protection analysis re-runs, so whether one is on screen at the shutter depends on how long
   * the machine took to get here. That is worth ~3% of the frame — enough on its own to fail the golden check on a
   * slow run and pass it on a fast one, with no rendering change behind it. Hide them for the capture. They are
   * covered where they belong: tests/ui/levee.test.ts for the wording, e2e flow 13 for "no false overtopping
   * alarm". The bottom Break-it banner (.dl-naive-banner) is deliberately NOT hidden — it is part of that scene.
   */
  await page.addStyleTag({ content: '.dl-notices .dl-toast { visibility: hidden !important; }' });

  const spec = {
    mode: scene.mode ?? null,
    actions: scene.actions ?? [],
    camera: scene.camera,
    simSeconds: scene.simSeconds ?? 0,
    requireProtection: !!scene.requireProtection,
  };
  const info = await page.evaluate(setupScene, spec);
  const settled = await page.evaluate(settle, 8000);
  const anim = await page.evaluate(pinAnimClock, ANIM_CLOCK);
  const sim = await page.evaluate(simSanity);
  const ui = await page.evaluate(uiBoxes);

  // Three captures of a frozen scene: the first is the golden/detector frame, the rest measure flicker.
  const shots = [];
  for (let i = 0; i < (QUICK ? 2 : 3); i++) {
    shots.push(decodePNG(await page.screenshot({ type: 'png' })));
    if (i === 0) await page.waitForTimeout(700);
  }

  // A hazard scene is captured a second time in another mode; the difference is the water mask (see analyzeHazard).
  let refShot = null;
  const refMode = scene.hazard ? (scene.mode === 'depth' ? 'maxDepth' : 'depth') : null;
  if (refMode) {
    await page.evaluate((m) => window.__deluge.setWaterMode(m), refMode);
    await page.evaluate(settle, 5000);
    // Changing the mode pokes the pacer, so the clock ran again: pin it back before the reference shot.
    await page.evaluate(pinAnimClock, ANIM_CLOCK);
    refShot = decodePNG(await page.screenshot({ type: 'png' }));
    await page.evaluate((m) => window.__deluge.setWaterMode(m), scene.mode);
  }
  await page.close();

  const img = shots[0];
  const stats = frameStats(img);
  const hazard = refShot && palettes ? analyzeHazard(img, refShot, palettes, scene.mode, refMode) : null;
  return {
    id: scene.id,
    label: scene.label,
    preset: scene.preset,
    mode: scene.mode ?? 'realistic',
    url,
    capture: { width: img.width, height: img.height },
    info,
    settled,
    anim,
    sim,
    ui: { checked: ui.checked, offenders: ui.offenders },
    stats,
    hazard,
    flickerFrac: flickerFrac(shots),
    pageErrors,
    image: img,
    // Kept only until the runner has written the flicker heatmap for a failing scene (then deleted with `image`).
    repeats: shots.slice(1),
  };
}

// ── checks ──────────────────────────────────────────────────────────────────────────────────────
function checkScene(row, scene, golden) {
  const checks = [];
  const skip = new Set(scene.skipDetectors ?? []);
  const add = (name, ok, value, expected, note) =>
    checks.push({ name, status: ok === null ? 'skip' : ok ? 'pass' : 'fail', value, expected, note });

  if (!skip.has('blank')) {
    add('blackFrame', row.stats.meanLuma >= THRESHOLDS.minMeanLuma, row.stats.meanLuma, `>= ${THRESHOLDS.minMeanLuma}`);
    add('blankFrame', row.stats.lumaStd >= THRESHOLDS.minLumaStd, row.stats.lumaStd, `>= ${THRESHOLDS.minLumaStd}`);
  }
  if (scene.expectMagenta) {
    add(
      'glitchColourPresent',
      row.stats.magentaFrac >= THRESHOLDS.minBreakitMagentaFrac,
      row.stats.magentaFrac,
      `>= ${THRESHOLDS.minBreakitMagentaFrac}`,
      'Break-it must visibly blow up',
    );
  } else {
    add('nanMagenta', row.stats.magentaFrac <= THRESHOLDS.maxMagentaFrac, row.stats.magentaFrac, `<= ${THRESHOLDS.maxMagentaFrac}`);
  }
  if (!skip.has('greyImagery')) {
    add('imageryPresent', row.stats.greyFrac <= THRESHOLDS.maxGreyFrac, row.stats.greyFrac, `<= ${THRESHOLDS.maxGreyFrac}`);
  }
  if (!skip.has('flicker')) {
    const allow = scene.flickerAllowance ?? THRESHOLDS.maxFlickerFrac;
    add('flicker', row.flickerFrac <= allow, row.flickerFrac, `<= ${allow}`, scene.flickerAllowance ? 'scene has an animated overlay' : '');
  }
  add('uiInsideViewport', row.ui.offenders.length === 0, row.ui.offenders.length, '0', row.ui.offenders.map((o) => `${o.what}: ${o.why}`).join(' | '));
  add('noPageErrors', row.pageErrors.length === 0, row.pageErrors.length, '0', row.pageErrors.slice(0, 3).join(' | '));

  if (row.sim && !skip.has('unsupportedWater')) {
    add(
      'waterSupported',
      row.sim.unsupportedFrac <= THRESHOLDS.maxUnsupportedWaterFrac,
      row.sim.unsupportedFrac,
      `<= ${THRESHOLDS.maxUnsupportedWaterFrac}`,
      `max excess ${row.sim.maxSurfaceExcessM} m over ${row.sim.wetCells} wet cells`,
    );
    add('finiteDepths', row.sim.nonFiniteDepths === 0, row.sim.nonFiniteDepths, '0');
  }
  if (row.hazard) {
    if (!skip.has('shoreline') && row.hazard.shorelineAxisFrac !== null) {
      add(
        'shorelineNotStairStepped',
        row.hazard.shorelineAxisFrac <= THRESHOLDS.maxShorelineAxisFrac,
        row.hazard.shorelineAxisFrac,
        `<= ${THRESHOLDS.maxShorelineAxisFrac}`,
        `${row.hazard.shorelineEdgePixels} edge px`,
      );
    }
    if (row.hazard.legendAgreement !== null) {
      add(
        'legendMatchesPixels',
        row.hazard.legendAgreement >= THRESHOLDS.minLegendAgreement,
        row.hazard.legendAgreement,
        `>= ${THRESHOLDS.minLegendAgreement}`,
        `${(row.hazard.waterFrac * 100).toFixed(1)}% of frame is mapped water, ${((row.hazard.classifiedFrac ?? 0) * 100).toFixed(0)}% of it legend-coloured; ${row.hazard.refMode} reference agrees ${row.hazard.refLegendAgreement}`,
      );
    } else {
      add('legendMatchesPixels', false, row.hazard.waterFrac, '> 0', 'no hazard-mapped water in frame — the mode changed nothing');
    }
  }
  if (golden) {
    add('goldenImage', golden.frac <= THRESHOLDS.goldenDiffFrac, +golden.frac.toFixed(4), `<= ${THRESHOLDS.goldenDiffFrac}`, golden.note);
  } else {
    add('goldenImage', null, null, `<= ${THRESHOLDS.goldenDiffFrac}`, 'no baseline committed — run with --update');
  }
  return checks;
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
const machine = await machineState();
console.log('\n=== Deluge graphics-glitch suite ===');
console.log(`machine : ${machine.host} · ${machine.platform}`);
console.log(`power   : ${machine.pmsetBatt.split('\n').slice(-1)[0].trim() || 'unknown'}${machine.lowPowerMode ? ' · LOW POWER MODE ON' : ''}`);
console.log(`viewport: ${VIEWPORT.width}x${VIEWPORT.height} @ DPR ${VIEWPORT.dpr}`);
console.log(`mode    : ${UPDATE ? 'UPDATE BASELINES' : ADVISORY ? 'ADVISORY (never fatal)' : 'strict'}${QUICK ? ' · quick' : ''}`);

let server = null;
let baseUrl = EXTERNAL_URL;
const distDir = path.join(OUT_DIR, 'dist');
const shotDir = path.join(OUT_DIR, 'shots');
const diffDir = path.join(OUT_DIR, 'diff');
try {
  if (!baseUrl) {
    const s = await buildAndServe(distDir, PORT, path.join(OUT_DIR, 'server.log'));
    server = s.server;
    baseUrl = s.url;
  }
  if (!baseUrl.endsWith('/')) baseUrl += '/';
  console.log(`target  : ${baseUrl}\n`);

  fs.mkdirSync(shotDir, { recursive: true });
  fs.mkdirSync(diffDir, { recursive: true });
  fs.mkdirSync(BASELINE_DIR, { recursive: true });

  const wanted = argv.scene ? String(argv.scene).split(',') : SCENES.filter((s) => !QUICK || s.quick).map((s) => s.id);
  const browser = await chromium.launch({
    headless: argv.headed !== 'true',
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist'],
  });

  // The legend's own swatch colours, read once from the running app: the hazard check compares pixels against
  // what the user is actually shown, not against a copy of the palette that could drift out of date.
  let palettes = null;
  {
    const p = await browser.newPage({ viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, deviceScaleFactor: 1 });
    await p.goto(`${baseUrl}?preset=pittsburgh`, { waitUntil: 'load', timeout: 120000 });
    await p.evaluate(async () => {
      await window.__deluge.ready;
    });
    palettes = await p.evaluate(readLegendPalettes);
    await p.close();
    const counts = Object.entries(palettes).map(([k, v]) => `${k}:${v.length}`).join(' ');
    console.log(`legend  : swatches read from the app (${counts})\n`);
  }

  const rows = [];
  for (const id of wanted) {
    const scene = SCENES.find((s) => s.id === id);
    if (!scene) throw new Error(`unknown scene "${id}"; known: ${SCENES.map((s) => s.id).join(', ')}`);
    process.stdout.write(`- ${scene.label} … `);
    // Watchdog. Advancing a scene's clock is GPU work that competes with everything else on the machine, and a
    // permanent suite must fail loudly rather than hang when the machine is busy (a background reindex or another
    // agent's browser can triple a scene's wall time). SCENE_TIMEOUT_MS is generous; blowing it is a real signal.
    const row = await Promise.race([
      runScene(browser, baseUrl, scene, palettes),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`scene "${scene.id}" exceeded ${Math.round(SCENE_TIMEOUT_MS / 1000)}s`)), SCENE_TIMEOUT_MS),
      ),
    ]).catch((err) => ({ error: String(err.message || err) }));
    if (row.error) {
      console.log(`TIMEOUT — ${row.error}`);
      rows.push({
        id: scene.id,
        label: scene.label,
        preset: scene.preset,
        mode: scene.mode ?? 'realistic',
        stats: { meanLuma: null, lumaStd: null, magentaFrac: null, greyFrac: null },
        flickerFrac: null,
        hazard: null,
        golden: null,
        sim: null,
        ui: { checked: 0, offenders: [] },
        settled: { frozen: false },
        pageErrors: [],
        checks: [{ name: 'sceneCompleted', status: 'fail', value: 0, expected: '1', note: row.error }],
      });
      continue;
    }

    // Full-resolution capture for eyeballing, downscaled copy for the golden comparison.
    const small = shrink(row.image, BASELINE_SHRINK);
    fs.writeFileSync(path.join(shotDir, `${scene.id}.png`), encodePNG(small));
    const baselinePath = path.join(BASELINE_DIR, `${scene.id}.png`);
    let golden = null;
    if (UPDATE) {
      fs.writeFileSync(baselinePath, encodePNG(small));
      golden = { frac: 0, changed: 0, worst: 0, note: 'baseline recorded' };
    } else if (fs.existsSync(baselinePath)) {
      const base = decodePNG(fs.readFileSync(baselinePath));
      if (base.width !== small.width || base.height !== small.height) {
        golden = { frac: 1, changed: -1, worst: 1, note: `size changed: baseline ${base.width}x${base.height}, now ${small.width}x${small.height}` };
      } else {
        const d = perceptualDiff(base, small);
        fs.writeFileSync(path.join(diffDir, `${scene.id}.png`), encodePNG(d.image));
        golden = { frac: d.frac, changed: d.changed, worst: d.worst, note: `worst pixel Δ ${d.worst}` };
      }
    }
    row.golden = golden;
    row.checks = checkScene(row, scene, golden);
    // A flicker failure is unreadable as a number: write the changed pixels as an image so it can be looked at.
    // `flickerFrac` compares the first capture with each later one; the heatmap shows the worst of those pairs.
    if (row.checks.some((c) => c.name === 'flicker' && c.status === 'fail') && row.repeats?.length) {
      let worst = { frac: -1, image: null };
      for (const later of row.repeats) {
        const d = perceptualDiff(row.image, later, 0.03);
        if (d.frac > worst.frac) worst = d;
      }
      if (worst.image) fs.writeFileSync(path.join(diffDir, `${scene.id}-flicker.png`), encodePNG(shrink(worst.image, BASELINE_SHRINK)));
    }
    delete row.repeats;
    delete row.image;
    rows.push(row);
    const bad = row.checks.filter((c) => c.status === 'fail');
    console.log(bad.length ? `FAIL (${bad.map((c) => c.name).join(', ')})` : 'ok');
  }
  await browser.close();

  // ── report ────────────────────────────────────────────────────────────────────────────────────
  const pad = (s, n) => String(s ?? '').padEnd(n);
  const padL = (s, n) => String(s ?? '').padStart(n);
  console.log(
    '\n' + pad('scene', 30) + pad('mode', 10) + padL('luma', 7) + padL('std', 7) + padL('magenta', 9) + padL('grey', 7) + padL('flicker', 9) + padL('stair', 7) + padL('legend', 8) + padL('golden', 8) + '  verdict',
  );
  console.log('-'.repeat(121));
  for (const r of rows) {
    const bad = r.checks.filter((c) => c.status === 'fail');
    console.log(
      pad(r.label, 30) +
        pad(r.mode, 10) +
        padL(r.stats.meanLuma, 7) +
        padL(r.stats.lumaStd, 7) +
        padL(r.stats.magentaFrac, 9) +
        padL(r.stats.greyFrac, 7) +
        padL(r.flickerFrac, 9) +
        padL(r.hazard?.shorelineAxisFrac ?? '-', 7) +
        padL(r.hazard?.legendAgreement ?? '-', 8) +
        padL(r.golden ? r.golden.frac.toFixed(4) : 'none', 8) +
        '  ' +
        (bad.length ? `FAIL: ${bad.map((c) => c.name).join(', ')}` : 'pass'),
    );
  }

  const failures = rows.flatMap((r) => r.checks.filter((c) => c.status === 'fail').map((c) => ({ scene: r.id, ...c })));
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ! ${f.scene} ${f.name} = ${f.value} (expected ${f.expected})${f.note ? ` — ${f.note}` : ''}`);
  }
  const missingBaselines = rows.filter((r) => !r.golden).map((r) => r.id);
  if (missingBaselines.length && !UPDATE) {
    console.log(`\nNo baseline for: ${missingBaselines.join(', ')} — record them with: node scripts/visual.mjs --update`);
  }
  const notFrozen = rows.filter((r) => !r.settled.frozen).map((r) => r.id);
  if (notFrozen.length) console.log(`\nNote: animation clock never froze for ${notFrozen.join(', ')}; flicker there is advisory.`);

  if (CALIBRATE) {
    const agg = (f, how) => {
      const v = rows.map(f).filter((x) => Number.isFinite(x));
      return v.length ? (how === 'max' ? Math.max(...v) : Math.min(...v)) : null;
    };
    console.log('\n[calibrate] measured extremes (set thresholds with margin beyond these):');
    console.log(
      JSON.stringify(
        {
          meanLuma_min: agg((r) => r.stats.meanLuma, 'min'),
          lumaStd_min: agg((r) => r.stats.lumaStd, 'min'),
          magentaFrac_max_nonBreakit: agg((r) => (r.id === 'breakit' ? NaN : r.stats.magentaFrac), 'max'),
          magentaFrac_breakit: rows.find((r) => r.id === 'breakit')?.stats.magentaFrac ?? null,
          greyFrac_max: agg((r) => r.stats.greyFrac, 'max'),
          flickerFrac_max: agg((r) => r.flickerFrac, 'max'),
          shorelineAxisFrac_max: agg((r) => r.hazard?.shorelineAxisFrac ?? NaN, 'max'),
          legendAgreement_min: agg((r) => r.hazard?.legendAgreement ?? NaN, 'min'),
          unsupportedFrac_max: agg((r) => r.sim?.unsupportedFrac ?? NaN, 'max'),
          goldenDiffFrac_max: agg((r) => r.golden?.frac ?? NaN, 'max'),
        },
        null,
        2,
      ),
    );
  }

  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(
    JSON_OUT,
    JSON.stringify(
      {
        suite: 'visual',
        schema: 'deluge-visual/1',
        date: new Date().toISOString(),
        quick: QUICK,
        update: UPDATE,
        advisory: ADVISORY,
        machine,
        viewport: VIEWPORT,
        baselineShrink: BASELINE_SHRINK,
        thresholds: THRESHOLDS,
        baseUrl,
        palettes,
        rows,
        failures,
        verdict: failures.length ? (ADVISORY ? 'ADVISORY' : 'FAIL') : 'PASS',
      },
      null,
      2,
    ),
  );
  console.log(`\nshots: ${path.relative(ROOT, shotDir)} · diffs: ${path.relative(ROOT, diffDir)} · JSON: ${path.relative(ROOT, JSON_OUT)}`);
  if (UPDATE) console.log(`Baselines written to ${path.relative(ROOT, BASELINE_DIR)} — review the shots, then commit them.`);
  else if (!failures.length) console.log('\nPASS — no glitch detected and every scene matches its baseline.');
  process.exitCode = failures.length && !ADVISORY && !UPDATE ? 1 : 0;
} catch (e) {
  console.error(`\nFAIL: ${e.stack || e.message}`);
  process.exitCode = 1;
} finally {
  killTree(server);
  if (!KEEP_DIST && !EXTERNAL_URL && fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
}
