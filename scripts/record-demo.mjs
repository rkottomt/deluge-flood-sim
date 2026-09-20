#!/usr/bin/env node
/**
 * record-demo.mjs — renders the Deluge demo film frame by frame, deterministically.
 *
 * WHY FRAME BY FRAME, NOT A SCREEN RECORDING
 * Every frame is produced by: advance the simulation a fixed number of SIMULATED seconds, assign the camera its
 * scripted pose, stamp the animation clock to exactly frame/60 s, render, capture. Nothing reads the wall clock, so
 * the output is 60 fps by construction: if a frame takes 800 ms to render the film is still smooth, just slower to
 * make. The same shot list on a faster machine produces the same film.
 *
 * SPEED
 *  • JPEG capture (PNG encoding at 4K costs more than the render).
 *  • The film is a list of independent shots; `--all` runs them in parallel browsers (default 3) and every worker
 *    writes into ONE numbered sequence, so the encode is a single glob.
 *  • Each shot's starting state is reached by a cheap warm-up at a quarter viewport (fast renders), then the page is
 *    resized to full and Cinematic quality is switched on for the captured frames only.
 *
 * USAGE
 *   node scripts/record-demo.mjs --list
 *   node scripts/record-demo.mjs --shot=rise-a [--scale=0.25] [--frames=120] [--port=5781]
 *   node scripts/record-demo.mjs --all [--workers=3] [--scale=1]
 *   node scripts/record-demo.mjs --encode [--out=...] [--mbps=45]
 *
 * The app must already be served (vite) on --port. Frames land in
 * /Users/rohitkottomtharayil/steelhacks/submission/video/work/frames/NNNNN.jpg in global film order.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const VIDEO_DIR = '/Users/rohitkottomtharayil/steelhacks/submission/video';
const WORK = path.join(VIDEO_DIR, 'work');
const FRAMES = path.join(WORK, 'frames');
const ENCODER = path.join(VIDEO_DIR, 'tools', 'encode-h264');

const FILM = { width: 3840, height: 2160, fps: 60, jpegQuality: 92 };

// ── landmarks ───────────────────────────────────────────────────────────────────────────────────────
// Grid coords (cells, 1024² over the preset bounds; gy grows southward). Derived from the preset bounds
// in public/presets/pittsburgh/meta.json: gx = (lon-west)/(east-west)*1024, gy = (north-lat)/(north-south)*1024.
const PT = {
  point: { gx: 323, gy: 544 }, //  Point State Park, the confluence (40.4417 N, 80.0074 W)
  marketSq: { gx: 371, gy: 572 }, //  Market Square, downtown (40.4407 N, 80.0030 W)
  ppg: { gx: 381, gy: 575 }, //  PPG Place
  strip: { gx: 470, gy: 505 }, //  Strip District, upriver of downtown
};
// The preset's own levee line along the North Shore (scenario.levee), crest 226.5 m.
const LEVEE = [
  { gx: 185.1, gy: 440 }, { gx: 185.1, gy: 482.9 }, { gx: 205, gy: 489.8 }, { gx: 225, gy: 495.2 },
  { gx: 245, gy: 497.2 }, { gx: 265, gy: 494.9 }, { gx: 285, gy: 492.5 }, { gx: 305, gy: 487.8 },
  { gx: 325, gy: 484.4 }, { gx: 345, gy: 479.1 }, { gx: 365, gy: 469.5 }, { gx: 385, gy: 460.8 },
  { gx: 405, gy: 452.6 }, { gx: 414.9, gy: 417 },
];
const LEVEE_CREST = 226.5;

// ── camera poses ────────────────────────────────────────────────────────────────────────────────────
// distance in metres from the orbit target, yaw 0 = looking north (grows toward east), pitch = radians above
// the horizon (π/2 straight down). `establish` is the preset's own framing of the Point.
const POSE = {
  establish: { target: { gx: 398, gy: 543, elevation: 224.9 }, distance: 4700, yaw: 0.44, pitch: 0.50 },
  establishB: { target: { gx: 392, gy: 548, elevation: 224.9 }, distance: 4300, yaw: 0.62, pitch: 0.47 },
  riseMid: { target: { gx: 385, gy: 556, elevation: 223 }, distance: 3450, yaw: 0.80, pitch: 0.44 },
  downtown: { target: { gx: 374, gy: 568, elevation: 222 }, distance: 2500, yaw: 0.97, pitch: 0.42 },
  downtownClose: { target: { gx: 379, gy: 576, elevation: 222 }, distance: 1850, yaw: 1.14, pitch: 0.47 },
  hazardHigh: { target: { gx: 372, gy: 562, elevation: 222 }, distance: 2900, yaw: 1.00, pitch: 1.00 },
  hazardMid: { target: { gx: 378, gy: 572, elevation: 222 }, distance: 2100, yaw: 1.12, pitch: 0.92 },
  hazardBlocks: { target: { gx: 383, gy: 580, elevation: 222 }, distance: 1450, yaw: 1.26, pitch: 0.80 },
  leveeWide: { target: { gx: 305, gy: 478, elevation: 222.9 }, distance: 3250, yaw: 0.06, pitch: 0.74 },
  levee: { target: { gx: 300, gy: 470, elevation: 222.9 }, distance: 2600, yaw: 0.16, pitch: 0.68 },
  leveeGreen: { target: { gx: 296, gy: 466, elevation: 222.9 }, distance: 2750, yaw: 0.34, pitch: 0.82 },
  evac: { target: { gx: 396, gy: 578, elevation: 222 }, distance: 2450, yaw: 1.30, pitch: 0.58 },
  evacB: { target: { gx: 404, gy: 570, elevation: 222 }, distance: 2900, yaw: 1.52, pitch: 0.66 },
  endWide: { target: { gx: 396, gy: 546, elevation: 224.9 }, distance: 4900, yaw: 1.70, pitch: 0.54 },
};

// Hazard legend — the app's own bands and plain-language notes (src/render/legend.ts, MAX_DEPTH_BANDS /
// DEPTH_BANDS). Kept verbatim so the overlay legend matches the water on screen.
const MAX_DEPTH_LEGEND = [
  { color: '#8c96c6', label: '1–2 m', note: 'Ground floor flooded' },
  { color: '#9ebcda', label: '0.5–1 m', note: 'Cars float' },
  { color: '#b4c8de', label: '0.15–0.5 m', note: 'Knocks people over' },
  { color: '#810f7c', label: '3 m +', note: 'Second storey' },
  { color: '#8856a7', label: '2–3 m', note: 'Over head height' },
];
const LEGEND_TOP_DOWN = [
  { color: '#810f7c', label: '3 m +', note: 'Second storey' },
  { color: '#8856a7', label: '2–3 m', note: 'Over head height' },
  { color: '#8c96c6', label: '1–2 m', note: 'Ground floor flooded' },
  { color: '#9ebcda', label: '0.5–1 m', note: 'Cars float' },
  { color: '#b4c8de', label: '0.15–0.5 m', note: 'Knocks people over' },
  { color: '#3c454b', label: 'river', note: 'Normal river level' },
];

// ── the shot list ───────────────────────────────────────────────────────────────────────────────────
// Pure data. `sim` is the sim-time policy: stageFt = gauge reading the river is told to reach, ramp = how it gets
// there ('gradual' = the physical rise, ≈3.7 sim-min to the 1936 crest), warmTo = sim seconds to reach before the
// first captured frame (cheap, quarter-size renders), perFrame = SIMULATED seconds advanced per film frame.
// Captions are in shot-local seconds and may use {tokens} filled in from live simulation state.
const SHOTS = [
  {
    id: 'title',
    frames: 132,
    look: { waterMode: 'realistic', timeOfDay: 'goldenHour', buildings: true, quality: 'cinematic' },
    sim: { stageFt: null, ramp: 'none', warmTo: 0, perFrame: 0.3 },
    camera: [{ t: 0, pose: POSE.establish }, { t: 1, pose: POSE.establishB, ease: 'inOut' }],
    card: {
      kind: 'title', title: 'DELUGE',
      line: 'Real-time flood simulation on real terrain',
      foot: 'Shallow-water equations solved on the GPU · Pittsburgh, 45,084 measured buildings',
      fadeIn: 0.5, fadeOut: 0.5,
    },
  },
  {
    id: 'rise-a',
    frames: 270,
    look: { waterMode: 'realistic', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 0, perFrame: 0.9 },
    camera: [{ t: 0, pose: POSE.establishB }, { t: 1, pose: POSE.riseMid, ease: 'inOut' }],
    captions: [
      { from: 0, to: 2.2, kicker: '1 · PREDICTION', text: 'What happens if the rivers rise again?', sub: 'Three Rivers, Pittsburgh — normal pool, 16 ft on the Point gauge' },
      { from: 2.2, to: 4.5, kicker: '1 · PREDICTION', text: 'The rivers climb toward the 1936 record crest', sub: 'Point gauge {stageFt} ft · flood stage is 22 ft · record 46 ft' },
    ],
  },
  {
    id: 'rise-b',
    frames: 270,
    look: { waterMode: 'realistic', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 243, perFrame: 0.9 },
    camera: [{ t: 0, pose: POSE.riseMid }, { t: 0.55, pose: POSE.downtown, ease: 'inOut' }, { t: 1, pose: POSE.downtownClose, ease: 'inOut' }],
    captions: [
      { from: 0, to: 2.3, kicker: '1 · PREDICTION', text: 'At the crest the water leaves the channel', sub: 'Point gauge {stageFt} ft · {floodedAcres} acres of dry land under water' },
      { from: 2.3, to: 4.5, kicker: '1 · PREDICTION', text: 'It spreads through downtown street by street', sub: 'Solved on the GPU, not painted on: {roadsOut} of {roadsTotal} street segments impassable' },
    ],
  },
  {
    id: 'hazard-a',
    frames: 240,
    look: { waterMode: 'maxDepth', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 900, perFrame: 0.6 },
    camera: [{ t: 0, pose: POSE.downtownClose }, { t: 1, pose: POSE.hazardHigh, ease: 'inOut' }],
    legend: { title: 'Maximum flood depth', items: LEGEND_TOP_DOWN },
    captions: [
      { from: 0, to: 2, kicker: '2 · BUSINESS RISK', text: 'Which blocks flood, and how deep?', sub: 'Same simulation, switched to the hazard map' },
      { from: 2, to: 4, kicker: '2 · BUSINESS RISK', text: 'Every colour is a depth a business can act on', sub: 'Read the legend: cars float at half a metre, ground floors go at one' },
    ],
  },
  {
    id: 'hazard-b',
    frames: 180,
    look: { waterMode: 'maxDepth', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 1044, perFrame: 0.6 },
    camera: [{ t: 0, pose: POSE.hazardHigh }, { t: 1, pose: POSE.hazardMid, ease: 'inOut' }],
    legend: { title: 'Maximum flood depth', items: LEGEND_TOP_DOWN },
    captions: [
      { from: 0, to: 3, kicker: '2 · BUSINESS RISK', text: 'Pick an address: this is your exposure', sub: '{floodedAcres} acres flooded · deepest water {maxDepthM} m · the pale ground never gets wet' },
    ],
  },
  {
    id: 'levee-a',
    frames: 240,
    look: { waterMode: 'realistic', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 35.8, ramp: 'gradual', warmTo: 210, perFrame: 0.9 },
    camera: [{ t: 0, pose: POSE.leveeWide }, { t: 1, pose: POSE.levee, ease: 'inOut' }],
    ops: [
      { kind: 'buildWall', from: 0.08, to: 0.5, points: LEVEE, height: LEVEE_CREST },
      { kind: 'stageTo', at: 0.12, ft: 46 },
    ],
    captions: [
      { from: 0, to: 1.6, kicker: '3 · PROTECTION', text: 'Now build something', sub: 'North Shore, river at {stageFt} ft and still rising' },
      { from: 1.6, to: 4, kicker: '3 · PROTECTION', text: 'A levee goes up along the North Shore', sub: 'Crest 226.5 m — drawn onto the terrain the solver is already using' },
    ],
  },
  {
    id: 'levee-b',
    frames: 180,
    look: { waterMode: 'realistic', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 426, perFrame: 0.7, preWall: true },
    camera: [{ t: 0, pose: POSE.levee }, { t: 1, pose: POSE.leveeGreen, ease: 'inOut' }],
    captions: [
      { from: 0, to: 3, kicker: '3 · PROTECTION', text: 'The land it keeps dry lights up green', sub: '{acres} acres and {roadKm} km of road saved, holding back {heldFt} ft of river' },
    ],
  },
  {
    id: 'evac-a',
    frames: 200,
    look: { waterMode: 'realistic', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 900, perFrame: 1.0 },
    ops: [{ kind: 'evacStart', at: 0, gx: PT.marketSq.gx, gy: PT.marketSq.gy }],
    camera: [{ t: 0, pose: POSE.hazardMid }, { t: 1, pose: POSE.evac, ease: 'inOut' }],
    captions: [
      { from: 0, to: 1.6, kicker: '4 · EVACUATION', text: 'Get out of downtown', sub: 'From Market Square to the nearest high ground' },
      { from: 1.6, to: 3.4, kicker: '4 · EVACUATION', text: 'The route re-plans as streets go under', sub: '{routeLine}' },
    ],
  },
  {
    id: 'evac-b',
    frames: 150,
    look: { waterMode: 'realistic', timeOfDay: 'daylight', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 1100, perFrame: 1.2 },
    ops: [{ kind: 'evacStart', at: 0, gx: PT.marketSq.gx, gy: PT.marketSq.gy }],
    camera: [{ t: 0, pose: POSE.evac }, { t: 1, pose: POSE.evacB, ease: 'inOut' }],
    captions: [
      { from: 0, to: 2.5, kicker: '4 · EVACUATION', text: '{routeVerdict}', sub: '{roadsOut} of {roadsTotal} street segments impassable · {routeAdvice}' },
    ],
  },
  {
    id: 'end',
    frames: 120,
    look: { waterMode: 'realistic', timeOfDay: 'goldenHour', buildings: true, quality: 'cinematic' },
    sim: { stageFt: 46, ramp: 'gradual', warmTo: 1280, perFrame: 0.5 },
    camera: [{ t: 0, pose: POSE.evacB }, { t: 1, pose: POSE.endWide, ease: 'inOut' }],
    card: {
      kind: 'end', title: 'DELUGE',
      line: 'Predict the flood · price the risk · build the levee · plan the way out',
      foot: 'WebGPU compute shallow-water solver · USGS 3DEP elevation · NAIP imagery · TIGER/Line roads · OpenStreetMap buildings',
      fadeIn: 0.35, fadeOut: 0.45,
    },
  },
];

// Global frame offsets: worker N writes into the one sequence at the right place.
let acc = 0;
for (const s of SHOTS) { s.start = acc; acc += s.frames; }
const TOTAL = acc;

// ── camera interpolation ────────────────────────────────────────────────────────────────────────────
const EASE = {
  linear: (x) => x,
  inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  out: (x) => 1 - Math.pow(1 - x, 3),
  in: (x) => x * x * x,
};
const lerp = (a, b, u) => a + (b - a) * u;

function poseAt(keys, t) {
  if (keys.length === 1) return keys[0].pose;
  let i = 0;
  while (i < keys.length - 2 && t > keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const u = (EASE[b.ease ?? 'inOut'])(Math.min(1, Math.max(0, (t - a.t) / span)));
  return {
    target: {
      gx: lerp(a.pose.target.gx, b.pose.target.gx, u),
      gy: lerp(a.pose.target.gy, b.pose.target.gy, u),
      elevation: lerp(a.pose.target.elevation, b.pose.target.elevation, u),
    },
    distance: lerp(a.pose.distance, b.pose.distance, u),
    yaw: lerp(a.pose.yaw, b.pose.yaw, u),
    pitch: lerp(a.pose.pitch, b.pose.pitch, u),
  };
}

// ── the page-side film runtime (captions + one deterministic frame) ──────────────────────────────────
// Injected once per page. Everything a frame needs happens in ONE evaluate call: stamp the animation clock,
// set the camera, fill the caption tokens from live state, render, so the round trips stay at one per frame.
function installRuntime() {
  const d = window.__deluge;
  const doc = document;
  // No app chrome, no boot card, ever — belt and braces on top of presentation mode.
  const css = doc.createElement('style');
  css.textContent = `
    #ui-root, #boot, noscript { display: none !important; }
    #film { position: fixed; inset: 0; z-index: 999999; pointer-events: none;
            font-family: -apple-system, system-ui, 'Helvetica Neue', Arial, sans-serif; }
    #film .cap { position: absolute; left: 5vw; bottom: 7.5vh; max-width: 64vw;
                 border-left: 0.5vh solid #46c8ff; padding: 1.4vh 2.2vw 1.6vh 1.8vw;
                 background: linear-gradient(90deg, rgba(4,9,18,0.86), rgba(4,9,18,0.62) 78%, rgba(4,9,18,0));
                 border-radius: 0.3vh; }
    #film .kicker { font-size: 1.55vh; font-weight: 800; letter-spacing: 0.26em; color: #7fd4ff;
                    text-transform: uppercase; margin-bottom: 0.9vh; }
    #film .text { font-size: 3.25vh; font-weight: 700; line-height: 1.12; color: #ffffff;
                  letter-spacing: -0.01em; text-shadow: 0 0.25vh 1.2vh rgba(0,0,0,0.8); }
    #film .sub { margin-top: 0.9vh; font-size: 1.95vh; font-weight: 500; line-height: 1.3; color: #bfe4ff;
                 text-shadow: 0 0.2vh 0.9vh rgba(0,0,0,0.85); }
    #film .legend { position: absolute; right: 4.5vw; top: 12vh; padding: 1.8vh 2vh;
                    background: rgba(4,9,18,0.8); border: 0.1vh solid rgba(120,190,255,0.25);
                    border-radius: 0.6vh; min-width: 24vh; }
    #film .legend h4 { margin: 0 0 1.2vh; font-size: 1.6vh; font-weight: 800; color: #ffffff;
                       letter-spacing: 0.12em; text-transform: uppercase; }
    #film .legend .row { display: flex; align-items: center; gap: 1.1vh; margin-bottom: 0.95vh; }
    #film .legend .sw { width: 2.6vh; height: 1.5vh; border-radius: 0.2vh; flex: none;
                        box-shadow: inset 0 0 0 0.1vh rgba(255,255,255,0.22); }
    #film .legend .lab { font-size: 1.6vh; font-weight: 700; color: #ffffff; min-width: 7.2vh; }
    #film .legend .note { font-size: 1.6vh; font-weight: 500; color: #bfe4ff; }
    #film .card { position: absolute; inset: 0; display: flex; flex-direction: column;
                  align-items: center; justify-content: center; text-align: center;
                  background: radial-gradient(60vw 60vh at 50% 55%, rgba(3,8,16,0.72), rgba(3,8,16,0.92)); }
    #film .card .title { font-size: 9vh; font-weight: 800; letter-spacing: 0.16em; color: #ffffff;
                         text-shadow: 0 0.6vh 3vh rgba(0,0,0,0.9); }
    #film .card .rule { width: 26vh; height: 0.4vh; margin: 2.4vh 0; background: #46c8ff; }
    #film .card .line { font-size: 3vh; font-weight: 600; color: #e8f5ff; max-width: 74vw; line-height: 1.25; }
    #film .card .foot { margin-top: 3.2vh; font-size: 1.75vh; font-weight: 500; color: #9fc7e8;
                        max-width: 66vw; line-height: 1.45; }
    #film .credit { position: absolute; right: 4.5vw; bottom: 3.6vh; font-size: 1.3vh; font-weight: 500;
                    color: rgba(190,220,245,0.72); text-align: right; letter-spacing: 0.04em; }
  `;
  doc.head.appendChild(css);
  const root = doc.createElement('div');
  root.id = 'film';
  root.innerHTML =
    '<div class="cap" id="f-cap"><div class="kicker" id="f-kick"></div><div class="text" id="f-text"></div>' +
    '<div class="sub" id="f-sub"></div></div>' +
    '<div class="legend" id="f-leg" style="display:none"></div>' +
    '<div class="card" id="f-card" style="display:none"><div class="title" id="f-ct"></div>' +
    '<div class="rule"></div><div class="line" id="f-cl"></div><div class="foot" id="f-cf"></div></div>' +
    '<div class="credit" id="f-cr"></div>';
  doc.body.appendChild(root);

  const el = (id) => doc.getElementById(id);
  const ft = (m) => (m + 216.3 - 211.409) / 0.3048; // stage offset (m) → Point-gauge feet
  const num = (n) => Math.round(n).toLocaleString('en-US');

  function live() {
    const st = d.getStats();
    const stage = d.getStageApplied();
    const roads = d.getRoadStatusCounts();
    const prot = d.getProtection();
    const route = d.getRoute();
    return {
      stageFt: ft(stage.applied).toFixed(1),
      floodedAcres: num((st?.floodedArea ?? 0) / 4046.856),
      maxDepthM: (st?.maxDepth ?? 0).toFixed(1),
      roadsOut: num((roads?.flooded ?? 0) + (roads?.wet ?? 0)),
      roadsTotal: num(roads?.total ?? 0),
      acres: num((prot?.areaM2 ?? 0) / 4046.856),
      roadKm: ((prot?.roadMeters ?? 0) / 1000).toFixed(1),
      heldFt: prot?.level != null ? ft(prot.level - 216.3).toFixed(1) : ft(stage.applied).toFixed(1),
      routeLine: route?.state === 'ok' ? route.message : (route?.message ?? 'Re-planning…'),
      routeVerdict:
        route?.state === 'blocked' ? 'No safe route left' :
        route?.state === 'ok' ? 'One corridor is still dry — and narrowing' : 'Re-planning the way out',
      routeAdvice:
        route?.state === 'blocked' ? (route.advice || 'Shelter in place on higher floors') :
        route?.state === 'ok' ? route.message : 'searching',
    };
  }

  window.__film = {
    setStatic(shot) {
      el('f-cr').textContent = shot.credit ?? '';
      const leg = el('f-leg');
      if (shot.legend) {
        leg.style.display = '';
        leg.innerHTML =
          '<h4>' + shot.legend.title + '</h4>' +
          shot.legend.items.map((i) =>
            '<div class="row"><div class="sw" style="background:' + i.color + '"></div>' +
            '<div class="lab">' + i.label + '</div><div class="note">' + i.note + '</div></div>').join('');
      } else leg.style.display = 'none';
      const card = el('f-card');
      if (shot.card) {
        card.style.display = '';
        el('f-ct').textContent = shot.card.title;
        el('f-cl').textContent = shot.card.line;
        el('f-cf').textContent = shot.card.foot;
      } else card.style.display = 'none';
    },
    /** One deterministic frame: animation clock, camera, captions, render. Returns the live readout. */
    async frame(f) {
      const v = live();
      const fill = (s) => (s ?? '').replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));
      const cap = el('f-cap');
      if (f.caption) {
        cap.style.display = '';
        cap.style.opacity = String(f.capOpacity ?? 1);
        el('f-kick').textContent = f.caption.kicker ?? '';
        el('f-text').textContent = fill(f.caption.text);
        el('f-sub').textContent = fill(f.caption.sub);
      } else cap.style.display = 'none';
      if (f.cardOpacity !== undefined) el('f-card').style.opacity = String(f.cardOpacity);
      if (f.legOpacity !== undefined) el('f-leg').style.opacity = String(f.legOpacity);
      d.setCamera(f.pose);
      // Two rAFs, with the animation clock re-stamped before each: the app's own rAF callback (registered
      // before ours) renders with exactly this time, so water ripples advance 1/60 s per film frame.
      for (let i = 0; i < 2; i++) {
        d.app.pacer.animTime = f.animTime;
        await new Promise((r) => requestAnimationFrame(r));
      }
      d.app.pacer.animTime = f.animTime;
      return v;
    },
    live,
    /** Advance to an exact sim clock: coarse first, then a low substep cap so the overshoot is < 1 sim s. */
    async advanceTo(target) {
      const coarse = target - 25;
      if (d.getSimClock() < coarse) await d.runFor(coarse - d.getSimClock());
      d.app.sim.setOverride('film', { maxSubstepsPerFrame: 6 });
      let guard = 0;
      while (d.getSimClock() < target - 1 && guard++ < 400) {
        await d.runFor(Math.min(6, target - d.getSimClock()));
      }
      return d.getSimClock();
    },
    setSubstepCap(n) {
      d.app.sim.setOverride('film', n ? { maxSubstepsPerFrame: n } : null);
    },
  };
}

// ── rendering one shot ──────────────────────────────────────────────────────────────────────────────
async function renderShot(shot, opt) {
  const scale = opt.scale;
  const W = Math.round(FILM.width * scale), H = Math.round(FILM.height * scale);
  const warmW = Math.max(480, Math.round(W / 4)), warmH = Math.max(270, Math.round(H / 4));
  const frames = Math.min(shot.frames, opt.maxFrames ?? shot.frames);
  const t0 = Date.now();
  fs.mkdirSync(FRAMES, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    channel: 'chromium',
    args: ['--enable-unsafe-webgpu', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit'],
  });
  const log = (m) => console.log(`[${shot.id}] ${m}`);
  let errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: warmW, height: warmH }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(m.text());
    });
    page.setDefaultTimeout(180000);
    await page.goto(`http://localhost:${opt.port}/?preset=pittsburgh`, { waitUntil: 'load' });
    await page.evaluate('window.__deluge.ready');
    log(`loaded in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // Presentation mode + no adaptive quality/budget wobble: the look must not depend on machine speed.
    await page.evaluate(({ look }) => {
      const d = window.__deluge;
      d.setLook({ ...look, presentation: true, quality: 'auto' }); // cinematic switched on after the warm-up
      d.setAdaptiveBudget(false);
      d.setPaused(true);
    }, { look: shot.look });
    await page.evaluate(installRuntime);

    // ── warm-up (quarter size, cheap frames) ──
    const sim = shot.sim;
    await page.evaluate(async ({ sim, levee, crest }) => {
      const d = window.__deluge;
      if (sim.stageFt != null) {
        const off = d.stageOffsetForFeet(sim.stageFt);
        if (off != null) d.setStage(off, { instant: false });
      }
      if (sim.preWall) {
        // levee-b starts from the state levee-a ends in: the wall is up before the crest arrives.
        if (sim.wallAtSim) await window.__film.advanceTo(sim.wallAtSim);
        d.drawWall(levee, crest);
      }
      if (sim.warmTo > 0) await window.__film.advanceTo(sim.warmTo);
      window.__film.setSubstepCap(sim.cap ?? 10);
    }, { sim: { ...sim, wallAtSim: shot.id === 'levee-b' ? 210 : 0 }, levee: LEVEE, crest: LEVEE_CREST });
    log(`warmed to sim ${(await page.evaluate('window.__deluge.getSimClock()')).toFixed(0)}s in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // ── full size + cinematic, only for captured frames ──
    await page.setViewportSize({ width: W, height: H });
    await page.evaluate(({ look, shot }) => {
      window.__deluge.setLook({ ...look, presentation: true });
      window.__film.setStatic(shot);
    }, { look: shot.look, shot: { legend: shot.legend, card: shot.card, credit: 'USGS 3DEP · NAIP · TIGER/Line · OpenStreetMap' } });
    await page.evaluate('window.__deluge.waitFrames(12)');

    // ── capture loop ──
    const wallStart = Date.now();
    let simTarget = await page.evaluate('window.__deluge.getSimClock()');
    const done = new Set();
    let lastProbe = null;
    for (let f = 0; f < frames; f++) {
      const t = frames > 1 ? f / (frames - 1) : 0;
      const tSec = f / FILM.fps;

      // 1. simulation: a fixed number of SIMULATED seconds per film frame (self-correcting target clock,
      //    so a frame that oversteps is paid back by the next one — never a drift that depends on speed).
      if (sim.perFrame > 0) {
        simTarget += sim.perFrame;
        const need = simTarget - (await page.evaluate('window.__deluge.getSimClock()'));
        if (need > 0.02) await page.evaluate((n) => window.__deluge.runFor(n), need);
      }

      // 2. scripted state changes
      for (const [i, op] of (shot.ops ?? []).entries()) {
        if (op.kind === 'evacStart' && t >= (op.at ?? 0) && !done.has(i)) {
          done.add(i);
          await page.evaluate((p) => window.__deluge.setEvacStart(p), { gx: op.gx, gy: op.gy });
        }
        if (op.kind === 'stageTo' && t >= op.at && !done.has(i)) {
          done.add(i);
          await page.evaluate((ftv) => {
            const off = window.__deluge.stageOffsetForFeet(ftv);
            if (off != null) window.__deluge.setStage(off);
          }, op.ft);
        }
        if (op.kind === 'buildWall') {
          // The levee grows one segment at a time across the shot; each segment is raised once.
          const u = Math.min(1, Math.max(0, (t - op.from) / (op.to - op.from)));
          const want = Math.floor(u * (op.points.length - 1));
          const key = `w${i}:${want}`;
          if (want >= 1 && !done.has(key)) {
            done.add(key);
            await page.evaluate(({ pts, h }) => window.__deluge.drawWall(pts, h),
              { pts: op.points.slice(Math.max(0, want - 1), want + 1), h: op.height });
          }
        }
      }

      // 3. caption for this moment, with short cross-fades
      let caption = null, capOpacity = 1;
      for (const c of shot.captions ?? []) {
        if (tSec >= c.from && tSec < c.to) {
          caption = c;
          const fade = 0.28;
          capOpacity = Math.min(1, Math.min((tSec - c.from) / fade, (c.to - tSec) / fade, 1));
          capOpacity = Math.max(0, capOpacity);
          break;
        }
      }
      let cardOpacity;
      if (shot.card) {
        const secs = frames / FILM.fps;
        const inT = shot.card.fadeIn ?? 0.4, outT = shot.card.fadeOut ?? 0.4;
        cardOpacity = Math.max(0, Math.min(1, Math.min(tSec / inT, (secs - tSec) / outT, 1)));
      }

      // 4. render + capture
      lastProbe = await page.evaluate((f) => window.__film.frame(f), {
        pose: poseAt(shot.camera, t),
        animTime: (shot.start + f) / FILM.fps,
        caption, capOpacity, cardOpacity,
      });
      const n = String(shot.start + f).padStart(5, '0');
      await page.screenshot({ path: path.join(FRAMES, `${n}.jpg`), type: 'jpeg', quality: FILM.jpegQuality });

      if (f === 0 || (f + 1) % 30 === 0 || f === frames - 1) {
        const ms = (Date.now() - wallStart) / (f + 1);
        log(`frame ${f + 1}/${frames} (${n}.jpg) ${ms.toFixed(0)} ms/frame · stage ${lastProbe.stageFt} ft · ${lastProbe.floodedAcres} acres` +
          (shot.id.startsWith('levee') ? ` · saved ${lastProbe.acres} acres` : '') +
          (shot.id.startsWith('evac') ? ` · ${lastProbe.routeVerdict}` : ''));
      }
    }
    const msPerFrame = (Date.now() - wallStart) / frames;
    log(`done: ${frames} frames, ${msPerFrame.toFixed(0)} ms/frame, ${((Date.now() - t0) / 1000).toFixed(1)}s total`);
    if (errors.length) log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
    return { id: shot.id, frames, msPerFrame, errors: errors.slice(0, 5), probe: lastProbe };
  } finally {
    await browser.close();
  }
}

// ── parallel driver ─────────────────────────────────────────────────────────────────────────────────
async function renderAll(opt) {
  // Longest-processing-time first, so 3 workers finish within one shot of each other.
  const order = [...SHOTS].sort((a, b) => b.frames - a.frames);
  const queue = order.map((s) => s.id);
  const started = Date.now();
  const results = [];
  const self = new URL(import.meta.url).pathname;
  async function worker(w) {
    for (;;) {
      const id = queue.shift();
      if (!id) return;
      await new Promise((resolve, reject) => {
        const args = [self, `--shot=${id}`, `--port=${opt.port}`, `--scale=${opt.scale}`];
        const p = spawn(process.execPath, args, { stdio: 'inherit' });
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${id} exited ${code}`))));
      }).then(() => results.push(id), (e) => { console.error(`[worker ${w}] ${e.message}`); results.push(`FAILED:${id}`); });
    }
  }
  await Promise.all(Array.from({ length: opt.workers }, (_, w) => worker(w)));
  const mins = (Date.now() - started) / 60000;
  console.log(`\n[film] ${results.filter((r) => !r.startsWith('FAILED')).length}/${SHOTS.length} shots in ${mins.toFixed(1)} min`);
  const failed = results.filter((r) => r.startsWith('FAILED'));
  if (failed.length) console.log(`[film] re-run: ${failed.map((f) => `--shot=${f.slice(7)}`).join(' ')}`);
  return failed.length === 0;
}

function encode(opt) {
  const runs = [
    ['deluge-demo-4k.mp4', FILM.width, FILM.height, opt.mbps ?? 45],
    ['deluge-demo-1080p.mp4', 1920, 1080, 12],
  ];
  for (const [name, w, h, mbps] of runs) {
    const out = path.join(VIDEO_DIR, name);
    const r = spawn(ENCODER, [`--frames=${FRAMES}`, `--out=${out}`, `--fps=${FILM.fps}`,
      `--width=${w}`, `--height=${h}`, `--mbps=${mbps}`], { stdio: 'inherit' });
    r.on('exit', (c) => c && console.error(`encode ${name} failed (${c})`));
  }
}

// ── cli ─────────────────────────────────────────────────────────────────────────────────────────────
const argv = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/s);
  return m ? [m[1], m[2] ?? 'true'] : [a, 'true'];
}));
const opt = {
  port: Number(argv.port ?? 5781),
  scale: Number(argv.scale ?? 1),
  workers: Math.min(4, Number(argv.workers ?? 3)),
  maxFrames: argv.frames ? Number(argv.frames) : undefined,
  mbps: argv.mbps ? Number(argv.mbps) : undefined,
};

if (argv.list) {
  console.log(`film: ${TOTAL} frames = ${(TOTAL / FILM.fps).toFixed(2)} s at ${FILM.fps} fps, ${FILM.width}x${FILM.height}`);
  for (const s of SHOTS) {
    console.log(`  ${s.id.padEnd(9)} ${String(s.frames).padStart(4)} f  ${(s.frames / FILM.fps).toFixed(2).padStart(5)} s  ` +
      `frames ${String(s.start).padStart(5, '0')}-${String(s.start + s.frames - 1).padStart(5, '0')}  ` +
      `sim: ${s.sim.stageFt ?? 'normal pool'}${s.sim.stageFt ? ' ft' : ''}, warm to ${s.sim.warmTo}s, ${s.sim.perFrame} sim-s/frame  ` +
      `${s.look.waterMode}`);
  }
} else if (argv.encode) {
  encode(opt);
} else if (argv.shot) {
  const shot = SHOTS.find((s) => s.id === argv.shot);
  if (!shot) { console.error(`no shot "${argv.shot}"; have: ${SHOTS.map((s) => s.id).join(', ')}`); process.exit(2); }
  const r = await renderShot(shot, opt);
  console.log(JSON.stringify({ ...r, probe: r.probe }, null, 1));
  process.exit(r.errors.length ? 1 : 0);
} else if (argv.all) {
  const ok = await renderAll(opt);
  process.exit(ok ? 0 : 1);
} else {
  console.log('usage: --list | --shot=<id> [--scale=] [--frames=] | --all [--workers=3] | --encode');
}
