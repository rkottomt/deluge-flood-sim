/// <reference types="node" />
/**
 * The shipped grid-convergence reference (src/data/referenceOverlay.ts):
 *   • the quantisation round-trips — and how much it costs, against the error the overlay exists to show
 *   • a manifest is validated before anything is drawn, INCLUDING the scenario and agreement that label it
 *   • the real public/presets/pittsburgh/reference.{json,bin} loads, decodes and matches results.json
 *   • referenceFit: when the overlay is an honest comparison, and what it says when it is not
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  decodeArrivalPlane,
  decodeDepthPlane,
  encodeArrivalPlane,
  encodeDepthPlane,
  loadReferenceOverlay,
  referenceFit,
  REFERENCE_FIT,
  validateReferenceOverlayManifest,
  type ReferenceFitInput,
  type ReferenceOverlayManifest,
  type ReferenceOverlayScenario,
} from '../../src/data/referenceOverlay';

const PRESETS = path.resolve(import.meta.dirname, '../../public/presets');
const SHIPPED = path.join(PRESETS, 'pittsburgh/reference.json');
const RESULTS = path.resolve(import.meta.dirname, '../../artifacts/reference-run/results.json');

test('depth quantisation: round-trips, reserves 0 for dry, and is finest where a flood map is read', () => {
  const scale = 15.8; // the shipped Pittsburgh crest plane
  const depths = [0, 0.001, 0.05, 0.15, 0.3, 0.5, 1, 2, 5, 10, 15.8, 99];
  const q = encodeDepthPlane(Float32Array.from(depths), scale);
  const back = decodeDepthPlane(q, scale);
  assert.equal(q[0], 0, 'dry stays dry');
  assert.equal(back[0], 0);
  for (let i = 1; i < depths.length; i++) {
    assert.ok(q[i] >= 1, `${depths[i]} m must not quantise to "dry"`);
    const expect = Math.min(depths[i], scale);
    assert.ok(Math.abs(back[i] - expect) < 0.07, `${depths[i]} m → ${back[i]} m`);
  }
  // The sqrt curve's whole point: ~1 cm steps at the hazard legend's first band, coarser where nobody reads it.
  const step = (d: number) => {
    const c = encodeDepthPlane(Float32Array.of(d), scale)[0];
    return decodeDepthPlane(Uint8Array.of(c + 1), scale)[0] - decodeDepthPlane(Uint8Array.of(c), scale)[0];
  };
  assert.ok(step(0.15) < 0.02, `step at 0.15 m is ${step(0.15)} m`);
  assert.ok(step(15) > 0.1, `step at 15 m is ${step(15)} m`);
  // Worst round-trip error over a realistic depth range, against the 0.29 m RMSE the overlay illustrates.
  let worst = 0;
  for (let d = 0; d <= scale; d += 0.001) {
    const c = encodeDepthPlane(Float32Array.of(d), scale);
    worst = Math.max(worst, Math.abs(decodeDepthPlane(c, scale)[0] - d));
  }
  assert.ok(worst < 0.07, `worst quantisation error ${worst} m`);
  assert.throws(() => encodeDepthPlane(Float32Array.of(1), 0), /scale must be positive/);
});

test('arrival quantisation: 0 means "never", and never decodes to t = 0', () => {
  const duration = 1800;
  const times = Float32Array.from([-1, 0, 1, 900, 1800, 3600, Number.NaN]);
  const q = encodeArrivalPlane(times, duration);
  const back = decodeArrivalPlane(q, duration);
  assert.equal(q[0], 0);
  assert.ok(Number.isNaN(back[0]), 'never arrived stays never');
  assert.ok(Number.isNaN(back[6]), 'NaN stays never');
  assert.equal(back[1], 0, 'arrived at t=0 decodes to 0, not NaN');
  assert.ok(Math.abs(back[3] - 900) < 8, `${back[3]} s`);
  assert.ok(Math.abs(back[4] - 1800) < 8, `${back[4]} s`);
  assert.equal(back[5], 1800, 'clamped to the run length');
  assert.throws(() => encodeArrivalPlane(times, 0), /duration must be positive/);
});

const goodManifest = (): ReferenceOverlayManifest =>
  JSON.parse(fs.readFileSync(SHIPPED, 'utf8')) as ReferenceOverlayManifest;

test('manifest validation refuses anything that would draw an unlabelled or out-of-range comparison', () => {
  const bin = fs.statSync(path.join(PRESETS, 'pittsburgh/reference.bin')).size;
  assert.deepEqual(validateReferenceOverlayManifest(goodManifest(), bin), []);
  const broken = (mutate: (m: ReferenceOverlayManifest) => void): string[] => {
    const m = goodManifest();
    mutate(m);
    return validateReferenceOverlayManifest(m, bin);
  };
  assert.match(broken((m) => (m.version = 99)).join(), /version 99/);
  assert.match(broken((m) => (m.binary = '../../etc/passwd')).join(), /binary/);
  assert.match(broken((m) => (m.nx = 0)).join(), /nx\/ny/);
  assert.match(broken((m) => (m.planes[0].inflatedLength = 7)).join(), /inflatedLength/);
  assert.match(broken((m) => (m.planes[0].length = 1e9)).join(), /overruns/);
  assert.match(broken((m) => delete (m as Partial<ReferenceOverlayManifest>).scenarios).join(), /scenarios\["crest"\] missing/);
  assert.match(broken((m) => delete (m as Partial<ReferenceOverlayManifest>).agreement).join(), /agreement\["crest"\] missing/);
  assert.match(broken((m) => (m.agreement.crest.flooded.iou = 1.4)).join(), /flooded is not an area agreement/);
  assert.match(broken((m) => (m.scenarios.crest.boundary = 'bucket' as 'open')).join(), /boundary/);
  assert.deepEqual(validateReferenceOverlayManifest(null), ['manifest is not an object']);
  assert.match(validateReferenceOverlayManifest({ version: 1, planes: [] }).join(), /planes must be a non-empty array/);
});

test('the shipped Pittsburgh reference loads, decodes, and says what results.json says', async (t) => {
  if (!fs.existsSync(SHIPPED)) return t.skip('no reference shipped');
  // Serve the two files from disk, as the browser would over HTTP.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const rel = String(url).replace(/^\/presets\//, '');
    const file = path.join(PRESETS, rel);
    if (!file.startsWith(PRESETS) || !fs.existsSync(file)) return new Response(null, { status: 404 });
    return new Response(fs.readFileSync(file));
  }) as typeof fetch;
  try {
    const ref = await loadReferenceOverlay('pittsburgh', 'crest', { baseUrl: '/presets/' });
    assert.ok(ref, 'the shipped reference must load');
    assert.equal(ref.manifest.nx * ref.manifest.ny, ref.maxDepth.length);
    assert.equal(ref.manifest.referenceGrid, 4096);
    assert.equal(ref.manifest.refine, ref.manifest.referenceGrid / ref.manifest.nx);
    // It is the flood it claims to be: a few km² of deep water, nothing absurd.
    const cell = ref.manifest.cellSize ** 2;
    let wet = 0;
    let deepest = 0;
    for (const d of ref.maxDepth) {
      if (d >= 0.15) wet++;
      if (d > deepest) deepest = d;
    }
    const wetKm2 = (wet * cell) / 1e6;
    assert.ok(deepest > 14 && deepest < 16.5, `deepest ${deepest} m`);
    assert.ok(Math.abs(wetKm2 - ref.agreement.extent.referenceKm2) < 0.25, `${wetKm2} km² vs ${ref.agreement.extent.referenceKm2} km²`);

    // Quantisation is an order of magnitude below the discretisation error the overlay illustrates.
    const plane = ref.manifest.planes.find((p) => p.case === 'crest' && p.kind === 'maxDepth')!;
    assert.ok(plane.quantMaxError < ref.agreement.maxDepth.rmse / 4, `quant ${plane.quantMaxError} m vs RMSE ${ref.agreement.maxDepth.rmse} m`);

    // The readout is the measurement: every number traceable to the run that produced it.
    if (fs.existsSync(RESULTS)) {
      const results = JSON.parse(fs.readFileSync(RESULTS, 'utf8')) as {
        comparisons: Array<{ case: string; coarse: number; fine: number; flooded: Array<{ threshold: number; iou: number; pct: number }> }>;
      };
      const c = results.comparisons.find((x) => x.case === 'crest' && x.coarse === 1024 && x.fine === 4096)!;
      const head = c.flooded.find((a) => a.threshold === 0.15)!;
      assert.equal(ref.agreement.flooded.iou, head.iou);
      assert.equal(ref.agreement.flooded.pct, head.pct);
    }

    // A case nobody shipped, and a missing preset, are "no overlay" — never an error.
    const reasons: string[] = [];
    assert.equal(await loadReferenceOverlay('pittsburgh', 'nonesuch', { baseUrl: '/presets/', onUnavailable: (r) => reasons.push(r) }), null);
    assert.equal(await loadReferenceOverlay('johnstown', 'crest', { baseUrl: '/presets/', onUnavailable: (r) => reasons.push(r) }), null);
    assert.equal(await loadReferenceOverlay('../secrets', 'crest', { baseUrl: '/presets/', onUnavailable: (r) => reasons.push(r) }), null);
    assert.match(reasons.join('|'), /no maxDepth plane/);
    assert.match(reasons.join('|'), /HTTP 404/);
    assert.match(reasons.join('|'), /invalid preset id/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ── referenceFit: the honesty gate ──────────────────────────────────────────────────────────────

const manifest = (): ReferenceOverlayManifest => goodManifest();
const scenario = (): ReferenceOverlayScenario => goodManifest().scenarios.crest;

/** Live state that matches the reference exactly — each test moves ONE thing away from it. */
const matching = (patch: Partial<ReferenceFitInput> = {}): ReferenceFitInput => ({
  presetId: 'pittsburgh',
  grid: { nx: 1024, ny: 1024, cellSize: 7.8125 },
  stageApplied: scenario().stageOffset,
  stageTarget: scenario().stageOffset,
  stageMatchedAt: 215,
  rainRate: 0,
  storms: 0,
  manningN: 0.035,
  boundary: 'open',
  stabilityMode: 'robust',
  simTime: 1800,
  terrainEdited: false,
  ...patch,
});

test('referenceFit accepts the scenario it was computed for', () => {
  const v = referenceFit(manifest(), scenario(), matching());
  assert.equal(v.applies, true);
  assert.equal(v.mismatch, null);
  assert.equal(v.referenceSeconds, 1800);
  // The windows around the reference's own moment.
  assert.equal(referenceFit(manifest(), scenario(), matching({ simTime: 1800 - REFERENCE_FIT.earlyS })).applies, true);
  assert.equal(referenceFit(manifest(), scenario(), matching({ simTime: 1800 + REFERENCE_FIT.pastS })).applies, true);
  // Within the stage tolerance (a hair off the crest is still the crest).
  assert.equal(referenceFit(manifest(), scenario(), matching({ stageApplied: scenario().stageOffset - 0.04, stageTarget: scenario().stageOffset - 0.04 })).applies, true);
});

test('referenceFit refuses every state that would make the overlay a different comparison', () => {
  const cases: Array<[string, Partial<ReferenceFitInput>]> = [
    ['preset', { presetId: 'johnstown' }],
    ['preset', { presetId: null }],
    ['grid', { grid: { nx: 512, ny: 512, cellSize: 15.6 } }],
    ['grid', { grid: null }],
    ['naive', { stabilityMode: 'naive' }],
    ['edits', { terrainEdited: true }],
    ['rain', { rainRate: 25 }],
    ['storms', { storms: 1 }],
    ['stage', { stageApplied: 0, stageTarget: 0, stageMatchedAt: null }],
    ['stage', { stageTarget: 4 }],
    ['rising', { stageApplied: 4 }],
    ['late-crest', { stageMatchedAt: null }],
    ['late-crest', { stageMatchedAt: 215 + REFERENCE_FIT.crestLateS + 1 }],
    ['friction', { manningN: 0.05 }],
    ['boundary', { boundary: 'wall' }],
    ['early', { simTime: 900 }],
    ['early', { simTime: null }],
    ['past', { simTime: 1800 + REFERENCE_FIT.pastS + 1 }],
  ];
  for (const [expected, patch] of cases) {
    const v = referenceFit(manifest(), scenario(), matching(patch));
    assert.equal(v.applies, false, `${expected}: ${JSON.stringify(patch)} must refuse`);
    assert.equal(v.mismatch, expected, `${JSON.stringify(patch)}`);
  }
});

test('referenceFit reports the most useful reason first: the city before the scenario, the scenario before the clock', () => {
  // Everything wrong at once: the preset is what to say.
  const allWrong = matching({ presetId: 'boulder', rainRate: 50, stageApplied: 0, stageTarget: 0, simTime: 10, terrainEdited: true });
  assert.equal(referenceFit(manifest(), scenario(), allWrong).mismatch, 'preset');
  // Right city, wrong scenario and wrong moment: the scenario.
  assert.equal(referenceFit(manifest(), scenario(), matching({ rainRate: 50, simTime: 10 })).mismatch, 'rain');
  // Right scenario, only the moment is wrong.
  assert.equal(referenceFit(manifest(), scenario(), matching({ simTime: 10 })).mismatch, 'early');
});
