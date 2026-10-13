/**
 * Saved projects (src/project): the edit log compacts without changing what the walls are, a project round-trips
 * through its JSON, the strict reader refuses hostile files, links stay inside their budget and refuse gzip bombs, and
 * autosave stays off and silent unless asked.
 *
 * Run: node --import tsx --test tests/project/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { BrushOp } from '../../src/contracts';
import { applyBrushCPU, brushRect } from '../../src/sim/brush';
import { appendOp, compactOps, describeEdits, EditLog, erasesAll, expandEdits, installEditRecorder, editLogFor, replayEdits } from '../../src/project/edits';
import { PROJECT_FORMAT, PROJECT_LIMITS, PROJECT_VERSION, type ProjectEdit, type ProjectFile } from '../../src/project/format';
import { jsonDepth, parseProjectText, projectToJson, PROJECT_ERRORS, readProject } from '../../src/project/validate';
import { base64UrlToBytes, bytesToBase64Url, decodeProjectLink, encodeProjectLink, INFLATE_CAP, LINK_BUDGET, LINK_ERRORS, LINK_PREFIX, linkableProject } from '../../src/project/share';
import { AUTOSAVE_KEY, autosaveEnabled, readAutosave, setAutosaveEnabled, writeAutosave } from '../../src/project/autosave';
import { mergeSim, simForProject } from '../../src/ui/projectState';
import { createStore } from '../../src/app/store';
import { DEFAULT_SIM_PARAMS, type FloodSolver } from '../../src/contracts';
import { baseState } from '../ui/helpers';

const NX = 64;
const NY = 48;

/** Apply ops to fresh CPU mirrors, as the solver does. */
function rasterize(ops: readonly BrushOp[]): { ground: Float32Array; barrier: Float32Array } {
  const ground = new Float32Array(NX * NY).fill(100);
  const barrier = new Float32Array(NX * NY);
  for (const op of ops) {
    const r = brushRect(op, NX, NY);
    if (r) applyBrushCPU(op, r, ground, barrier, NX);
  }
  return { ground, barrier };
}

function maxDiff(a: Float32Array, b: Float32Array): number {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

const wall = (ax: number, ay: number, bx: number, by: number, height: number, radius = 1): BrushOp => ({ kind: 'wall', ax, ay, bx, by, radius, height });

test('consecutive wall pieces become one polyline with a height per segment', () => {
  const ops = [wall(5, 5, 5, 5, 2), wall(5, 5, 10, 6, 2), wall(10, 6, 15, 9, 2.5), wall(15, 9, 20, 9, 2.5)];
  const edits = compactOps(ops);
  assert.equal(edits.length, 1);
  const e = edits[0] as Extract<ProjectEdit, { op: 'wall' }>;
  assert.deepEqual(e.pts, [5, 5, 5, 5, 10, 6, 15, 9, 20, 9]);
  assert.deepEqual(e.h, [2, 2, 2.5, 2.5]);
  // Equal heights collapse to one number.
  const flat = compactOps([wall(1, 1, 2, 2, 3), wall(2, 2, 4, 2, 3)]);
  assert.equal((flat[0] as Extract<ProjectEdit, { op: 'wall' }>).h, 3);
  // A different radius or a gap starts a new wall.
  assert.equal(compactOps([wall(1, 1, 2, 2, 3), wall(2, 2, 4, 2, 3, 2)]).length, 2);
  assert.equal(compactOps([wall(1, 1, 2, 2, 3), wall(3, 2, 4, 2, 3)]).length, 2);
});

test('replaying the compacted log rebuilds the same barrier and ground (walls, erases, digging)', () => {
  const ops: BrushOp[] = [
    wall(4, 4, 4, 4, 2),
    wall(4, 4, 30, 10, 2),
    wall(30, 10, 50, 30, 3.2),
    { kind: 'eraseWall', ax: 20, ay: 8, bx: 22, by: 9, radius: 1.5 },
    wall(10, 40, 40, 40, 1.5, 1.4),
    { kind: 'water', gx: 10, gy: 10, radius: 3, amount: 1 },
    { kind: 'terrain', gx: 30, gy: 30, radius: 4, delta: -0.05 },
    { kind: 'terrain', gx: 30, gy: 30, radius: 4, delta: -0.05 },
    { kind: 'terrain', gx: 31, gy: 30, radius: 4, delta: 0.07 },
  ];
  const edits = compactOps(ops, { nx: NX, ny: NY });
  assert.equal(edits.filter((e) => e.op === 'terrain').length, 2, 'two digs on one spot merge');
  const a = rasterize(ops);
  const b = rasterize(expandEdits(edits));
  assert.ok(maxDiff(a.barrier, b.barrier) < 1e-5, `barrier differs by ${maxDiff(a.barrier, b.barrier)}`);
  assert.ok(maxDiff(a.ground, b.ground) < 1e-4, `ground differs by ${maxDiff(a.ground, b.ground)}`);
  // And through JSON.
  const again = expandEdits(JSON.parse(JSON.stringify(edits)) as ProjectEdit[]);
  assert.ok(maxDiff(a.barrier, rasterize(again).barrier) < 1e-5);
});

test('a full-map erase (Clear walls) drops every wall before it and keeps the digging', () => {
  const clear: BrushOp = { kind: 'eraseWall', ax: 0, ay: NY / 2, bx: NX, by: NY / 2, radius: Math.max(NX, NY) };
  assert.ok(erasesAll(clear, NX, NY));
  assert.ok(!erasesAll({ ...clear, radius: 5 }, NX, NY));
  const edits: ProjectEdit[] = [];
  appendOp(edits, wall(1, 1, 9, 9, 2), { nx: NX, ny: NY });
  appendOp(edits, { kind: 'terrain', gx: 5, gy: 5, radius: 2, delta: 0.5 }, { nx: NX, ny: NY });
  appendOp(edits, clear, { nx: NX, ny: NY });
  appendOp(edits, wall(3, 3, 7, 3, 1), { nx: NX, ny: NY });
  assert.deepEqual(edits.map((e) => e.op), ['terrain', 'wall']);
  assert.ok(maxDiff(rasterize([wall(1, 1, 9, 9, 2), { kind: 'terrain', gx: 5, gy: 5, radius: 2, delta: 0.5 }, clear, wall(3, 3, 7, 3, 1)]).barrier, rasterize(expandEdits(edits)).barrier) < 1e-6);
});

test('the recorder logs applyBrush on the scene’s solver, clears on a terrain reset, and pauses while suspended', () => {
  const store = createStore(baseState());
  const applied: BrushOp[] = [];
  let resets = 0;
  const solver = {
    nx: NX,
    ny: NY,
    applyBrush: (op: BrushOp) => void applied.push(op),
    reset: () => void resets++,
  } as unknown as FloodSolver;
  installEditRecorder(store, solver);
  const log = editLogFor(store);
  solver.applyBrush(wall(1, 1, 5, 5, 2));
  solver.applyBrush({ kind: 'water', gx: 1, gy: 1, radius: 1, amount: 1 });
  assert.equal(log.edits.length, 1, 'water is not a terrain edit');
  log.suspend();
  replayEdits(solver, [{ op: 'wall', pts: [9, 9, 12, 9], h: 1, r: 1 }]);
  solver.reset({ resetTerrain: true });
  log.resume();
  assert.equal(log.edits.length, 1, 'suspended swaps are not recorded and do not clear the log');
  assert.equal(applied.length, 3);
  solver.reset({ resetTerrain: true });
  assert.equal(log.edits.length, 0);
  assert.equal(resets, 2);
  // Installing again on the same solver does not double-wrap.
  installEditRecorder(store, solver);
  solver.applyBrush(wall(1, 1, 5, 5, 2));
  assert.equal(log.edits.length, 1);
  assert.equal(applied.length, 4);
  const l2 = new EditLog();
  for (let i = 0; i < PROJECT_LIMITS.maxEdits + 5; i++) l2.record({ kind: 'eraseWall', ax: i, ay: 0, bx: i, by: 1, radius: 0.5 });
  assert.ok(l2.overflow && l2.edits.length === PROJECT_LIMITS.maxEdits, 'the log is bounded and says so');
});

// ─── The file ───────────────────────────────────────────────────────────────────────────────────────────────────
export function sampleProject(): ProjectFile {
  const levee: ProjectEdit = { op: 'wall', pts: [], h: [], r: 1.92 };
  for (let k = 0; k <= 120; k++) (levee.pts as number[]).push(400 + k * 2.1, 500 - k * 0.9);
  levee.h = Array.from({ length: 120 }, (_, k) => 3 + (k % 7) * 0.1);
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: 'North Shore levee study',
    savedAt: '2026-10-12T12:00:00.000Z',
    scene: { kind: 'preset', id: 'pittsburgh' },
    grid: { nx: 1024, ny: 1024, cellSize: 7.8125 },
    scenario: {
      stageOffset: 6.5,
      sim: { manningN: 0.04, rainRate: 25, infiltrationRate: 0, timeScale: 300, boundary: 'open' },
      sources: [
        { id: 'ohio', type: 'stage', gx: -275.13, gy: 276, radius: 6, level: 221.5, offsetScale: 0.98, label: 'Ohio River' },
        { id: 'in1', type: 'inflow', gx: 900, gy: 20, radius: 4, discharge: 1200, stopAfter: 1800, hydrograph: [{ t: 0, q: 0 }, { t: 600, q: 1200 }] },
      ],
      storms: [{ id: 'st1', gx: 512, gy: 512, radius: 40, intensity: 80 }],
      shelters: [{ name: 'Pitt campus', gx: 700, gy: 600 }],
      evacStart: { gx: 480, gy: 470 },
      climate: { horizon: '2050', pathway: 'ssp585', scaling: 'cc' },
      chain: null,
    },
    edits: [levee, { op: 'erase', a: [410, 495], b: [412, 494], r: 1.5 }, { op: 'terrain', at: [300.5, 200.25], r: 3.84, d: -1.2 }],
    sites: [{ name: 'Point office', lon: -80.0085, lat: 40.4425, ring: null, occupancy: 'office', floors: 3, value: 25_000_000, footprintM2: null, firstFloorHeight: 0.3, criticalElev: null }],
    siteCheck: { ladder: 'stage', minutes: 30, levels: ['rp100', 'record1936'], userRp: { record1936: 500 }, designEvent: 'rp100', freeboardFt: 2 },
    ensemble: { members: 12, minutes: 30, seed: 7, ranges: { inflowPct: 20, rainPct: 25, stageM: 0.3, manningLo: 0.025, manningHi: 0.05, demSigmaM: 0.2, demCorrM: 400 } },
    portfolio: { name: 'assets.csv', csv: 'asset_id,lat,lon\nA1,40.44,-80.00\n' },
    camera: { target: { gx: 512, gy: 480, elevation: 230 }, distance: 2400, yaw: 0.4, pitch: 0.7 },
    view: { waterMode: 'maxDepth', verticalExaggeration: 1.5, showImagery: true, showRoads: true, showContours: false, timeOfDay: 'goldenHour', buildings: true },
    designs: [
      { id: 'A', name: 'Full levee', edits: [levee], cost: { type: 'floodwall', capexUsd: null, omUsdPerYear: 50_000, lengthM: null, heightM: null, usefulLifeYears: 40 } },
      { id: 'B', name: 'Short wall', edits: [{ op: 'wall', pts: [400, 500, 460, 480], h: 3, r: 1.92 }], cost: { type: 'earthen', capexUsd: 4_000_000, omUsdPerYear: null, lengthM: null, heightM: null } },
    ],
    bca: { discountRate: 0.031, analysisYear: 2026 },
    comparison: null,
  };
}

test('a project round-trips through its JSON unchanged', () => {
  const p = sampleProject();
  const r = parseProjectText(projectToJson(p));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(JSON.parse(projectToJson(r.project)), JSON.parse(projectToJson(p)));
});

const corrupt = (mutate: (o: Record<string, any>) => void): string => {
  const o = JSON.parse(projectToJson(sampleProject()));
  mutate(o);
  return JSON.stringify(o);
};

test('hostile files are refused with fixed sentences', () => {
  const cases: Array<[string, string, string]> = [
    ['__proto__ at the top', '{"format":"deluge-project","version":1,"__proto__":{"polluted":1}}', PROJECT_ERRORS.forbiddenKey],
    ['__proto__ nested', corrupt((o) => (o.scenario.sim = JSON.parse('{"__proto__":{"polluted":1}}'))).replace('"sim":{}', '"sim":{"__proto__":{"polluted":1}}'), PROJECT_ERRORS.forbiddenKey],
    ['constructor key', corrupt((o) => (o.view.constructor = { prototype: { polluted: 1 } })), PROJECT_ERRORS.forbiddenKey],
    ['deep nesting', `{"format":"deluge-project","version":1,"x":${'['.repeat(5000)}${']'.repeat(5000)}}`, PROJECT_ERRORS.tooDeep],
    ['too large', 'x'.repeat(PROJECT_LIMITS.maxFileChars + 1), PROJECT_ERRORS.tooLarge],
    ['not JSON', '<img src=x onerror=alert(1)>', PROJECT_ERRORS.notJson],
    ['not a project', '{"format":"something-else","version":1}', PROJECT_ERRORS.notProject],
    ['newer version', corrupt((o) => (o.version = 2)), PROJECT_ERRORS.newer],
    ['unknown preset', corrupt((o) => (o.scene.id = 'OFFICIAL NOTICE evacuate now')), PROJECT_ERRORS.invalid],
    ['Infinity stage', corrupt((o) => (o.scenario.stageOffset = 1)).replace('"stageOffset":1', '"stageOffset":1e400'), PROJECT_ERRORS.invalid],
    ['wall height out of range', corrupt((o) => (o.edits[0].h = 1e9)), PROJECT_ERRORS.invalid],
    ['wall heights / segments mismatch', corrupt((o) => o.edits[0].h.pop()), PROJECT_ERRORS.invalid],
    ['odd wall point list', corrupt((o) => o.edits[0].pts.push(5)), PROJECT_ERRORS.invalid],
    ['unknown edit op', corrupt((o) => (o.edits[1].op = 'innerHTML')), PROJECT_ERRORS.invalid],
    ['too many edits', corrupt((o) => (o.edits = Array.from({ length: PROJECT_LIMITS.maxEdits + 1 }, () => ({ op: 'terrain', at: [1, 1], r: 1, d: 0.1 })))), PROJECT_ERRORS.invalid],
    ['number as string', corrupt((o) => (o.scenario.stageOffset = '6.5')), PROJECT_ERRORS.invalid],
    ['live area too big', corrupt((o) => (o.scene = { kind: 'live', lat: 40, lon: -80, sizeM: 1e9, resolution: 1024 })), PROJECT_ERRORS.invalid],
    ['live resolution not in the list', corrupt((o) => (o.scene = { kind: 'live', lat: 40, lon: -80, sizeM: 5000, resolution: 4096 })), PROJECT_ERRORS.invalid],
    ['source id with markup', corrupt((o) => (o.scenario.sources[0].id = '<script>')), PROJECT_ERRORS.invalid],
  ];
  for (const [what, text, err] of cases) {
    const r = parseProjectText(text);
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.equal(r.error, err, what);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined, 'Object.prototype untouched');
  assert.equal(jsonDepth('{"a":"[[[[[[["}'), 1, 'brackets inside strings do not count');
  // An object whose prototype is not plain is refused by the value reader.
  assert.equal(readProject(Object.create({ format: PROJECT_FORMAT })).ok, false);
});

test('optional sections that fail are dropped with a warning; strings are cleaned, never dropped into markup', () => {
  const t = corrupt((o) => {
    o.name = 'Study ‮YCNEGREME‬ <img src=x onerror=1>\u0000';
    o.siteCheck.minutes = 99999;
    o.view.waterMode = 'javascript:alert(1)';
    o.designs[1].cost.type = 'gold';
    o.sites.push({ ...o.sites[0], occupancy: 'castle' });
    o.scenario.sim.stabilityMode = 'naive';
    o.scenario.sim.cfl = 5;
    o.scenario.sim.drainRate = 12;
    o.scenario.sim.weird = { a: 1 };
    o.extra = 'ignored';
  });
  const r = parseProjectText(t);
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  const p = r.project;
  assert.ok(!/[‮‬\u0000]/.test(p.name), 'bidi and control characters stripped');
  assert.match(p.name, /<img src=x onerror=1>/, 'kept as text: it is only ever written as a text node');
  assert.equal(p.siteCheck, null);
  assert.equal(p.view, null);
  assert.equal(p.designs.length, 1, 'the bad design is skipped');
  assert.equal(p.sites.length, 1);
  assert.equal(p.scenario.sim.stabilityMode, undefined, 'the unstable reference scheme can never be loaded');
  assert.equal(p.scenario.sim.cfl, undefined);
  assert.equal(p.scenario.sim.drainRate, 12, 'a later solver’s numeric parameter is carried');
  assert.equal(p.scenario.sim.weird, undefined);
  assert.ok(r.warnings.length >= 4, r.warnings.join(' | '));
  for (const w of r.warnings) assert.ok(!/YCNEGREME|img|castle|gold/.test(w), 'warnings never echo the file');
});

test('a project from a link carries no names, portfolio or cached results', () => {
  const p = sampleProject();
  const r = parseProjectText(projectToJson(p), { fromLink: true });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.project.name, '');
  assert.equal(r.project.portfolio, null);
  assert.deepEqual(r.project.designs.map((d) => d.name), ['Design A', 'Design B']);
  assert.deepEqual(r.project.sites.map((s) => s.name), ['Site 1']);
  assert.deepEqual(r.project.scenario.shelters.map((s) => s.name), ['Shelter 1']);
  assert.ok(r.project.scenario.sources.every((s) => !s.label));
  // A live area's name from a link must look like a place (linkPlaceLabel), else it is dropped.
  const live = parseProjectText(corrupt((o) => (o.scene = { kind: 'live', lat: 40.44, lon: -80, sizeM: 5000, resolution: 1024, name: 'EVACUATE NOW: call 555-0100' })), { fromLink: true });
  assert.ok(live.ok && live.project.scene.kind === 'live' && !live.project.scene.name);
});

test('benefit–cost inputs: kept in a file and a link; out-of-range or ill-typed values are refused, never clamped in', async () => {
  const p = sampleProject();
  const file = parseProjectText(projectToJson(p));
  assert.ok(file.ok);
  if (!file.ok) return;
  assert.deepEqual(file.project.bca, { discountRate: 0.031, analysisYear: 2026 });
  assert.equal(file.project.designs[0].cost.usefulLifeYears, 40);
  assert.equal(file.project.designs[1].cost.usefulLifeYears, undefined, 'absent stays absent (FEMA’s standard value applies)');
  // A link carries them (numbers, not someone else's text).
  const enc = await encodeProjectLink(p);
  const link = await decodeProjectLink(enc.value);
  assert.ok(link.ok, link.ok ? '' : link.error);
  if (!link.ok) return;
  assert.deepEqual(link.project.bca, { discountRate: 0.031, analysisYear: 2026 });
  assert.equal(link.project.designs[0].cost.usefulLifeYears, 40);
  // An older file without them still opens, without them.
  const old = parseProjectText(corrupt((o) => {
    delete o.bca;
    delete o.designs[0].cost.usefulLifeYears;
  }));
  assert.ok(old.ok && old.project.bca === undefined && old.project.designs[0].cost.usefulLifeYears === undefined && old.warnings.length === 0);
  // Bad settings: the section is dropped with a fixed warning, the rest of the file stands.
  for (const bad of [{ discountRate: 0.5, analysisYear: 2026 }, { discountRate: -0.01, analysisYear: 2026 }, { discountRate: '0.07', analysisYear: 2026 }, { discountRate: 0.07, analysisYear: 2026.5 }, { discountRate: 0.07, analysisYear: 3000 }, { discountRate: 0.07 }, [0.07, 2026], 'seven']) {
    const r = parseProjectText(corrupt((o) => (o.bca = bad)));
    assert.ok(r.ok, JSON.stringify(bad));
    if (!r.ok) continue;
    assert.equal(r.project.bca, undefined, JSON.stringify(bad));
    assert.deepEqual(r.warnings, ['The benefit–cost settings in the project could not be read and were left as they are.']);
  }
  const inf = parseProjectText(corrupt((o) => (o.bca = { discountRate: 1, analysisYear: 2026 })).replace('"discountRate": 1', '"discountRate": 1e400'));
  assert.ok(inf.ok && inf.project.bca === undefined);
  // A bad useful life fails its design (as any bad cost does): skipped with a warning, the other design kept.
  for (const bad of [0, 30.5, 201, 1e9, '50', -50, true]) {
    const r = parseProjectText(corrupt((o) => (o.designs[0].cost.usefulLifeYears = bad)));
    assert.ok(r.ok);
    if (!r.ok) continue;
    assert.deepEqual(r.project.designs.map((d) => d.id), ['B'], String(bad));
  }
  // Hostile keys inside the section are refused like anywhere else.
  const proto = parseProjectText(projectToJson(p).replace('"bca": {', '"bca": { "__proto__": { "polluted": 1 },'));
  assert.equal(proto.ok, false);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('SimParams merge: only keys the app has, with their own type', () => {
  const saved = simForProject({ ...DEFAULT_SIM_PARAMS, manningN: 0.05, stabilityMode: 'naive' });
  assert.equal(saved.stabilityMode, undefined);
  const merged = mergeSim(DEFAULT_SIM_PARAMS, { ...saved, rainRate: 30, futureParam: 3, boundary: 'wall', timeScale: 'fast' as unknown as number });
  assert.equal(merged.manningN, 0.05);
  assert.equal(merged.rainRate, 30);
  assert.equal(merged.boundary, 'wall');
  assert.equal(merged.timeScale, DEFAULT_SIM_PARAMS.timeScale);
  assert.equal((merged as unknown as Record<string, unknown>).futureParam, undefined);
  assert.equal(merged.stabilityMode, 'robust');
});

// ─── Links ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('a link for a levee, a site and two designs fits the budget and decodes to the same project (minus names)', async () => {
  const p = sampleProject();
  const enc = await encodeProjectLink(p);
  assert.ok(enc.value, `too long: ${enc.length}`);
  assert.ok(enc.length <= LINK_BUDGET);
  assert.ok(enc.value!.startsWith(LINK_PREFIX));
  const r = await decodeProjectLink(enc.value);
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  const expect = parseProjectText(projectToJson(linkableProject(p)), { fromLink: true });
  assert.ok(expect.ok);
  if (expect.ok) assert.deepEqual(r.project, expect.project);
  assert.deepEqual(describeEdits(r.project.edits), describeEdits(p.edits));
});

test('a project too large for a link says so instead of writing one', async () => {
  const p = sampleProject();
  // Incompressible: random-ish wall points.
  let x = 12345;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) * 1000;
  p.edits = Array.from({ length: 400 }, () => ({ op: 'terrain' as const, at: [Math.round(rnd() * 1000) / 1000, Math.round(rnd() * 1000) / 1000] as [number, number], r: 3, d: -Math.round(rnd()) / 1000 }));
  const enc = await encodeProjectLink(p);
  assert.equal(enc.value, null);
  assert.ok(enc.length > LINK_BUDGET);
});

test('hostile links are refused: format, length, alphabet, gzip bomb, non-UTF-8, hostile JSON', async () => {
  const b64 = (buf: Uint8Array) => LINK_PREFIX + bytesToBase64Url(buf);
  const bomb = b64(gzipSync(Buffer.alloc(INFLATE_CAP * 8), { level: 9 }));
  assert.ok(bomb.length <= LINK_BUDGET, `the bomb fits a link (${bomb.length})`);
  const cases: Array<[string, string, string]> = [
    ['no prefix', 'abc', LINK_ERRORS.format],
    ['bad alphabet', `${LINK_PREFIX}<script>alert(1)</script>`, LINK_ERRORS.format],
    ['too long', `${LINK_PREFIX}${'A'.repeat(LINK_BUDGET)}`, LINK_ERRORS.tooLong],
    ['not gzip', b64(new TextEncoder().encode('{"format":"deluge-project","version":1, "padding": 1}')), LINK_ERRORS.inflate],
    ['gzip bomb', bomb, LINK_ERRORS.inflate],
    ['not UTF-8', b64(gzipSync(Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x80]))), LINK_ERRORS.inflate],
    ['__proto__ inside', b64(gzipSync(Buffer.from('{"format":"deluge-project","version":1,"__proto__":{"polluted":1}}'))), PROJECT_ERRORS.forbiddenKey],
  ];
  for (const [what, raw, err] of cases) {
    const r = await decodeProjectLink(raw);
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.equal(r.error, err, what);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(base64UrlToBytes('a'), null, 'impossible base64 length');
});

// ─── Autosave ───────────────────────────────────────────────────────────────────────────────────────────────────
test('autosave is off by default, deletes its copy when turned off, and survives a throwing storage', () => {
  const g = globalThis as unknown as { localStorage?: Storage };
  const prev = g.localStorage;
  const map = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: () => null,
    length: 0,
  } as Storage;
  try {
    assert.equal(autosaveEnabled(), false);
    assert.equal(writeAutosave('{}'), false, 'nothing is written while off');
    assert.equal(map.size, 0);
    assert.ok(setAutosaveEnabled(true));
    assert.ok(writeAutosave('{"a":1}'));
    assert.equal(readAutosave(), '{"a":1}');
    setAutosaveEnabled(false);
    assert.equal(map.has(AUTOSAVE_KEY), false, 'turning it off deletes the copy');
    assert.equal(map.size, 0);
    g.localStorage = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    assert.equal(autosaveEnabled(), false);
    assert.equal(setAutosaveEnabled(true), false);
    assert.equal(writeAutosave('{}'), false);
    assert.equal(readAutosave(), null);
  } finally {
    g.localStorage = prev;
  }
});

test('what the app writes, the strict reader accepts — field for field (capture → JSON → read)', async () => {
  const { captureProject } = await import('../../src/ui/projectState');
  const { bridgeFor } = await import('../../src/ui/bridge');
  const { sitesFor } = await import('../../src/ui/sites');
  const store = createStore(
    baseState({
      presetId: 'pittsburgh',
      terrainName: 'Pittsburgh — Three Rivers',
      stageOffset: 4.2,
      sources: [
        { id: 'ohio-stage', type: 'stage', gx: -275.13, gy: 276, radius: 308.08, level: 216.225, offsetScale: 0.98631, label: 'Ohio River' },
        { id: 'in-1', type: 'inflow', gx: 10, gy: 20, radius: 3, discharge: 400, hydrograph: [{ t: 0, q: 0 }, { t: 900, q: 400 }] },
      ],
      storms: [{ id: 'st-1', gx: 300, gy: 300, radius: 30, intensity: 90 }],
      shelters: [{ name: 'Cathedral of Learning (Pitt, Oakland)', gx: 903.03, gy: 497.59 }],
      evacStart: { gx: 480.5, gy: 470.25 },
      climate: { horizon: '2080', pathway: 'ssp245', scaling: 'super10' },
      render: { waterMode: 'hazard', verticalExaggeration: 2, showImagery: true, showRoads: false, showContours: true, probabilityThreshold: 0.5 },
    }),
  );
  const terrain = { nx: 1024, ny: 1024, cellSize: 7.8125, name: 'Pittsburgh — Three Rivers', bounds: { west: -80.05, east: -79.95, south: 40.41, north: 40.47 } };
  const solver = { nx: 1024, ny: 1024, applyBrush: () => {}, reset: () => {} } as unknown as FloodSolver;
  bridgeFor(store).scene = {
    getTerrain: () => terrain as never,
    getSolver: () => solver,
    getCamera: () => ({ pose: { target: { gx: 512, gy: 500, elevation: 231.5 }, distance: 2500, yaw: -0.3, pitch: 0.9 } }) as never,
  };
  installEditRecorder(store, solver);
  solver.applyBrush(wall(400, 500, 402, 499, 3.4, 1.92));
  solver.applyBrush(wall(402, 499, 405, 497, 3.6, 1.92));
  solver.applyBrush({ kind: 'terrain', gx: 100, gy: 120, radius: 3.8, delta: -0.05 });
  sitesFor(store).add(-80.0085, 40.4425);
  const c = captureProject(store, { name: 'Round trip', includePortfolio: false, includeResults: true });
  assert.ok(c.ok, c.ok ? '' : c.error);
  if (!c.ok) return;
  const r = parseProjectText(projectToJson(c.project));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (!r.ok) return;
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(JSON.parse(projectToJson(r.project)), JSON.parse(projectToJson(c.project)));
  assert.equal(r.project.edits.length, 2);
  assert.equal(r.project.sites.length, 1);
});
