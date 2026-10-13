/**
 * Saved projects under pressure: the autosave never overwrites the stored copy on its own and keeps one step back; a
 * link (or a file) cannot buy minutes of brush replay; what the edit log records, the reader opens; a comparison with
 * no losses survives a save; a project puts back exactly its own SimParams, climate and chain what-if.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import type { BrushOp, FloodSolver, TerrainData } from '../../src/contracts';
import { DEFAULT_SIM_PARAMS } from '../../src/contracts';
import { CLIMATE_TODAY } from '../../src/climate/scenarios';
import { createStore } from '../../src/app/store';
import { AUTOSAVE_BACKUP_KEY, AUTOSAVE_KEY, AutosaveGate, readAutosave, readAutosaveBackup, setAutosaveEnabled, writeAutosave } from '../../src/project/autosave';
import { compareDesigns, comparisonSummary, type CompareLevel, type LevelRun } from '../../src/project/compare';
import { appendOp, EditLog, editsCost, expandEdits } from '../../src/project/edits';
import { PROJECT_FORMAT, PROJECT_LIMITS, PROJECT_VERSION, RANGES, type ProjectEdit, type ProjectFile } from '../../src/project/format';
import { bytesToBase64Url, decodeProjectLink, LINK_PREFIX } from '../../src/project/share';
import { parseProjectText, projectToJson, PROJECT_ERRORS } from '../../src/project/validate';
import { bridgeFor } from '../../src/ui/bridge';
import { applyProject, mergeSim, simForProject } from '../../src/ui/projectState';
import { baseState } from '../ui/helpers';

function project(patch: Partial<ProjectFile> = {}): ProjectFile {
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    name: '',
    savedAt: '',
    scene: { kind: 'preset', id: 'pittsburgh' },
    grid: { nx: 1024, ny: 1024, cellSize: 7.8125 },
    scenario: { stageOffset: 0, sim: { rainRate: 0 }, sources: [], storms: [], shelters: [], evacStart: null, climate: null, chain: null },
    edits: [],
    sites: [],
    siteCheck: null,
    ensemble: null,
    portfolio: null,
    camera: null,
    view: null,
    designs: [],
    comparison: null,
    ...patch,
  };
}

function withStorage<T>(fn: (map: Map<string, string>) => T): T {
  const g = globalThis as unknown as { localStorage?: Storage };
  const prev = g.localStorage;
  const map = new Map<string, string>();
  g.localStorage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) } as unknown as Storage;
  try {
    return fn(map);
  } finally {
    g.localStorage = prev;
  }
}

// ─── H1: autosave ─────────────────────────────────────────────────────────────────────────────────────────────────
test('autosave: the scene as first shown never overwrites the stored copy; a real change does, keeping it one step back', () => {
  withStorage((map) => {
    setAutosaveEnabled(true);
    writeAutosave('{"yesterday":1}');
    const gate = new AutosaveGate();
    // Startup: nothing to compare against yet, then the default scene — neither is a write.
    assert.equal(gate.shouldWrite('default'), false, 'no baseline yet: no write');
    gate.setBaseline('default');
    assert.equal(gate.shouldWrite('default'), false, 'the default scene is not a change');
    gate.setBaseline('other');
    assert.equal(gate.shouldWrite('default'), false, 'the first baseline wins');
    assert.equal(readAutosave(), '{"yesterday":1}');
    // A ?project= link put on screen for the user is not their change either.
    gate.rebase('link');
    assert.equal(gate.shouldWrite('link'), false);
    // The user draws a wall: write, and the copy from last time moves one step back (once per session).
    assert.equal(gate.shouldWrite('wall'), true);
    writeAutosave('{"today":1}', { backup: gate.takeBackup() });
    assert.equal(readAutosave(), '{"today":1}');
    assert.equal(readAutosaveBackup(), '{"yesterday":1}');
    assert.equal(gate.shouldWrite('wall'), false, 'unchanged: no write');
    assert.equal(gate.shouldWrite('two walls'), true);
    writeAutosave('{"today":2}', { backup: gate.takeBackup() });
    assert.equal(readAutosaveBackup(), '{"yesterday":1}', 'later writes keep the session’s backup');
    gate.rebase('default');
    assert.equal(gate.shouldWrite('default'), true, 'once armed, going back to the default scene is a change too');
    setAutosaveEnabled(false);
    assert.equal(map.has(AUTOSAVE_KEY) || map.has(AUTOSAVE_BACKUP_KEY), false, 'off deletes both copies');
  });
});

test('autosave: restoring (arm) writes from then on, even the baseline', () => {
  const gate = new AutosaveGate();
  gate.setBaseline('default');
  gate.arm();
  assert.equal(gate.shouldWrite('default'), true);
  assert.equal(gate.takeBackup(), true);
  assert.equal(gate.takeBackup(), false);
});

// ─── H2: replay budget ────────────────────────────────────────────────────────────────────────────────────────────
/** The attack: thousands of map-sized digs in a link of about a kilobyte. */
function heavyEdits(n: number): ProjectEdit[] {
  return Array.from({ length: n }, (_, i) => ({ op: 'terrain' as const, at: [500 + (i % 9), 512] as [number, number], r: 99999, d: -1 }));
}

test('a link of thousands of huge brushes is small, and refused before anything is replayed', async () => {
  const p = project({ edits: heavyEdits(5000) });
  const value = LINK_PREFIX + bytesToBase64Url(gzipSync(Buffer.from(projectToJson(p, false)), { level: 9 }));
  assert.ok(value.length < 3000, `the attack fits a link (${value.length})`);
  const t0 = performance.now();
  const r = await decodeProjectLink(value);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.error, PROJECT_ERRORS.tooHeavy);
  assert.ok(performance.now() - t0 < 2000, 'the check itself is cheap');
  // As a file it is still far past the file budget (5,000 × 1024² cells).
  const f = parseProjectText(projectToJson(p));
  assert.equal(f.ok, false);
  if (!f.ok) assert.equal(f.error, PROJECT_ERRORS.tooHeavy);
});

test('edit radii are clamped to the grid, and the cell budget counts clipped rectangles', () => {
  const r = parseProjectText(projectToJson(project({ edits: [{ op: 'terrain', at: [10, 10], r: 99999, d: -1 }, { op: 'erase', a: [0, 512], b: [1024, 512], r: 50000 }] })));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (r.ok) assert.deepEqual(r.project.edits.map((e) => e.r), [1024, 1024]);
  // No grid in the file: the largest grid the reader accepts bounds the radius.
  const ng = parseProjectText(projectToJson(project({ grid: null, edits: [{ op: 'terrain', at: [10, 10], r: 99999, d: -1 }] })));
  assert.ok(ng.ok && ng.project.edits[0].r === PROJECT_LIMITS.maxRadiusCells);
  // Brushes far off the grid touch nothing, whatever their count.
  const off = editsCost([{ op: 'terrain', at: [-50000, -50000], r: 10, d: 1 }], { nx: 1024, ny: 1024 });
  assert.equal(off.cells, 0);
  const one = editsCost([{ op: 'terrain', at: [512, 512], r: 1024, d: 1 }], { nx: 1024, ny: 1024 });
  assert.equal(one.cells, 1024 * 1024, 'clipped to the grid');
});

test('a link may carry an ordinary levee and some digging, and a design over the budget is skipped, not the file', () => {
  const levee: ProjectEdit = { op: 'wall', pts: [], h: 3, r: 2 };
  for (let k = 0; k <= 200; k++) levee.pts.push(400 + k * 2, 500 - k);
  const digs: ProjectEdit[] = Array.from({ length: 300 }, (_, i) => ({ op: 'terrain', at: [100 + i, 300], r: 12, d: -0.5 }));
  const ok = parseProjectText(projectToJson(project({ edits: [levee, ...digs] })), { fromLink: true });
  assert.ok(ok.ok, ok.ok ? '' : ok.error);
  const withDesign = parseProjectText(projectToJson(project({ designs: [{ id: 'A', name: 'Huge', edits: heavyEdits(30), cost: { type: 'floodwall', capexUsd: null, omUsdPerYear: null, lengthM: null, heightM: null } }] })), { fromLink: true });
  assert.ok(withDesign.ok);
  if (withDesign.ok) {
    assert.equal(withDesign.project.designs.length, 0);
    assert.ok(withDesign.warnings.some((w) => /more of the map/.test(w)));
  }
});

// ─── L1 and the reader's ranges: what the log records, the reader opens ───────────────────────────────────────────
test('the edit log stops at the reader’s point and cell budgets, so a saved log always opens', () => {
  const grid = { nx: 1024, ny: 1024 };
  const log = new EditLog();
  log.attach({ nx: grid.nx, ny: grid.ny } as unknown as FloodSolver);
  // Single-point walls far apart: 2 points each, never merged.
  for (let i = 0; i < PROJECT_LIMITS.maxEditPoints; i++) log.record({ kind: 'wall', ax: (i * 7) % 1000, ay: (i * 13) % 1000, bx: (i * 7) % 1000, by: (i * 13) % 1000, radius: 1, height: 2 });
  assert.ok(log.overflow, 'the point budget overflowed the log');
  assert.ok(editsCost(log.edits, grid).points <= PROJECT_LIMITS.maxEditPoints);
  const r = parseProjectText(projectToJson(project({ edits: log.snapshot() })));
  assert.ok(r.ok, r.ok ? '' : r.error);
  // Cells: map-sized digs at distinct spots stop at the file budget.
  const big = new EditLog();
  big.attach({ nx: grid.nx, ny: grid.ny } as unknown as FloodSolver);
  for (let i = 0; i < 600 && !big.overflow; i++) big.record({ kind: 'terrain', gx: i, gy: 512, radius: 1024, delta: -0.01 });
  assert.ok(big.overflow, 'the cell budget overflowed the log');
  assert.ok(editsCost(big.edits, grid).cells <= PROJECT_LIMITS.maxBrushCells);
  assert.ok(parseProjectText(projectToJson(project({ edits: big.snapshot() }))).ok);
  // Clear walls recounts: the dropped walls free their budget.
  const c = new EditLog();
  c.attach({ nx: 64, ny: 64 } as unknown as FloodSolver);
  c.record({ kind: 'wall', ax: 1, ay: 1, bx: 9, by: 1, radius: 1, height: 2 });
  c.record({ kind: 'eraseWall', ax: 0, ay: 32, bx: 64, by: 32, radius: 64 });
  c.record({ kind: 'terrain', gx: 5, gy: 5, radius: 2, delta: -1 });
  assert.deepEqual(editsCost(c.edits, { nx: 64, ny: 64 }), { points: 1, cells: editsCost(c.edits, { nx: 64, ny: 64 }).cells });
  assert.equal(c.overflow, false);
});

test('walls above the reader’s range and digging held for minutes still save files that open', () => {
  const edits: ProjectEdit[] = [];
  appendOp(edits, { kind: 'wall', ax: 1, ay: 1, bx: 5, by: 1, radius: 1, height: 80 }, null);
  for (let i = 0; i < 400; i++) appendOp(edits, { kind: 'terrain', gx: 10, gy: 10, radius: 3, delta: -3 }, null);
  assert.equal((edits[0] as { h: number }).h, RANGES.wallHeight[1]);
  const digs = edits.filter((e) => e.op === 'terrain');
  assert.ok(digs.length >= 3, 'one long dig became several entries');
  assert.ok(Math.abs(digs.reduce((a, e) => a + (e as { d: number }).d, 0) + 1200) < 1e-6, 'the total depth is kept');
  const r = parseProjectText(projectToJson(project({ edits })));
  assert.ok(r.ok, r.ok ? '' : r.error);
  // Replay applies the same total.
  const total = expandEdits(edits).reduce((a, op: BrushOp) => a + (op.kind === 'terrain' ? op.delta : 0), 0);
  assert.ok(Math.abs(total + 1200) < 1e-6);
});

// ─── L2: a comparison without losses ──────────────────────────────────────────────────────────────────────────────
test('a comparison on a scene without buildings (NaN losses) saves "no value" and reads back', () => {
  const levels: CompareLevel[] = [{ id: 'rp100', label: '1 %', returnPeriod: 100, rpFrom: 'source' }];
  const run: LevelRun = { loss: NaN, lossLo: NaN, lossHi: NaN, reached: 0, buildings: new Map(), area: null };
  const c = compareDesigns(levels, [run], [{ id: 'A', name: 'A', cost: { capex: 1e6, om: 0, low: 5e5, high: 2e6, lengthM: 100, meanHeightM: 2, basis: 'segments', terrainNotCosted: false }, levels: [run] }] as never);
  const s = comparisonSummary(c, 'stage', 1800);
  assert.deepEqual(s.baseline.loss, [null]);
  assert.deepEqual(s.designs[0].loss, [null]);
  const r = parseProjectText(projectToJson(project({ comparison: s })));
  assert.ok(r.ok, r.ok ? '' : r.error);
  if (r.ok) {
    assert.deepEqual(r.warnings, [], 'the cached results are not dropped');
    assert.deepEqual(r.project.comparison?.baseline.loss, [null]);
  }
});

// ─── M1: SimParams ────────────────────────────────────────────────────────────────────────────────────────────────
test('SimParams round-trip the optional land-surface switches, and a project without them turns them off', () => {
  const on = { ...DEFAULT_SIM_PARAMS, buildingObstacles: true, roughnessMap: true, drainage: true, drainageScale: 1.5 };
  const saved = simForProject(on);
  assert.deepEqual({ b: saved.buildingObstacles, r: saved.roughnessMap, d: saved.drainage, s: saved.drainageScale }, { b: true, r: true, d: true, s: 1.5 });
  assert.equal(saved.cfl, undefined);
  assert.equal(saved.maxSubstepsPerFrame, undefined);
  const r = parseProjectText(projectToJson(project({ scenario: { ...project().scenario, sim: saved } })));
  assert.ok(r.ok);
  if (!r.ok) return;
  const back = mergeSim(DEFAULT_SIM_PARAMS, r.project.scenario.sim);
  assert.equal(back.buildingObstacles, true);
  assert.equal(back.roughnessMap, true);
  assert.equal(back.drainage, true);
  assert.equal(back.drainageScale, 1.5);
  // A project saved without them (an older file, or a scene with them off) resets the screen's.
  const reset = mergeSim(on, { manningN: 0.04 });
  assert.equal(reset.buildingObstacles, undefined);
  assert.equal(reset.roughnessMap, undefined);
  assert.equal(reset.drainage, undefined);
  assert.equal(reset.drainageScale, undefined);
  assert.equal(reset.manningN, 0.04);
  assert.equal(reset.rainRate, on.rainRate, 'a required key the project lacks keeps the app’s value');
  assert.equal(mergeSim(on, { buildingObstacles: 1 as unknown as boolean }).buildingObstacles, undefined, 'wrong type: back to absent');
});

// ─── M2 and the scene checks of applyProject ──────────────────────────────────────────────────────────────────────
function harness(state: Parameters<typeof baseState>[0]) {
  const store = createStore(baseState({ presetId: 'pittsburgh', ...state }));
  const terrain = { nx: 1024, ny: 1024, cellSize: 7.8125, name: 'P', bounds: { west: -80.05, east: -79.95, south: 40.41, north: 40.47 } } as unknown as TerrainData;
  const solver = { nx: 1024, ny: 1024, applyBrush: () => {}, reset: () => {} } as unknown as FloodSolver;
  const bridge = bridgeFor(store);
  bridge.scene = { getTerrain: () => terrain, getSolver: () => solver };
  const calls: string[] = [];
  const actions = { resetAll: () => calls.push('resetAll'), resetWater: () => calls.push('resetWater'), loadPreset: async () => void calls.push('loadPreset'), loadLiveArea: async () => 'ok' } as never;
  return { store, bridge, terrain, actions, calls };
}

test('opening a project without a climate puts today’s climate back; a chain what-if is reset when the project has none', async () => {
  const { store, bridge, terrain, actions } = harness({ climate: { horizon: '2080', pathway: 'ssp585', scaling: 'super10' } });
  const runs: unknown[] = [];
  const inflows: string[] = [];
  bridge.chain = { whatIf: { overrides: { volumeFactor: 3 }, mode: 'directFlow' }, inflow: 'scenario' } as never;
  bridge.chainControl = { run: (w) => void runs.push(w), setInflow: (m) => void inflows.push(m) };
  const out = await applyProject(project(), { store, actions, waitForScene: async () => terrain });
  assert.ok(out.ok, out.notes.join(' '));
  assert.deepEqual(store.get().climate, { ...CLIMATE_TODAY });
  assert.deepEqual(runs, [{ overrides: {} }], 'the leftover what-if is replaced by none');
  assert.deepEqual(inflows, ['chain']);
  // The project's own what-if; nothing re-run when it is already on screen.
  runs.length = 0;
  bridge.chain = { whatIf: { overrides: { volumeFactor: 2 } }, inflow: 'chain' } as never;
  await applyProject(project({ scenario: { ...project().scenario, chain: { inflow: 'chain', volumeFactor: 2 } } }), { store, actions, waitForScene: async () => terrain });
  assert.deepEqual(runs, []);
  await applyProject(project({ scenario: { ...project().scenario, chain: { inflow: 'chain', cv: 0.3 } } }), { store, actions, waitForScene: async () => terrain });
  assert.deepEqual(runs, [{ overrides: { cv: 0.3 } }]);
});

test('a project waits for a scene still loading, and a cached comparison is not kept on another grid', async () => {
  const { store, bridge, terrain, actions } = harness({ loading: { message: 'Loading…', progress: 0.5 } });
  let waited = 0;
  let set: unknown[] = [];
  const { projectHooksFor } = await import('../../src/ui/projectState');
  projectHooksFor(store).designs = { get: () => [], set: (d, s) => void (set = [d, s]), summary: () => null };
  const summary = comparisonSummary(compareDesigns([], [], []), 'current', 60);
  const out = await applyProject(project({ grid: { nx: 512, ny: 512, cellSize: 10 }, comparison: summary }), {
    store,
    actions,
    waitForScene: async () => {
      waited++;
      store.set({ loading: null });
      return terrain;
    },
  });
  assert.equal(waited, 1, 'waited for the load in flight before matching the scene');
  assert.ok(out.ok);
  assert.deepEqual(set, [[], null], 'designs and their cached results both dropped on another grid');
  void bridge;
});
