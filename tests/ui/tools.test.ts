import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/app/store';
import { createToolController, simplifyPolyline, nextLabel, MAX_STORMS } from '../../src/ui/tools';
import { selectTool, scaleBrush, TOOL_BY_ID } from '../../src/ui/toolDefs';
import type { BrushOp } from '../../src/contracts';
import { baseState, FakeCanvas, pointer, fakeRenderer, fakeSolver, fakeTerrain } from './helpers';
import { bridgeFor, type Notice } from '../../src/ui/bridge';

function setup(tool: Parameters<typeof baseState>[0] = {}) {
  const store = createStore(baseState(tool));
  const ops: BrushOp[] = [];
  const canvas = new FakeCanvas();
  const renderer = fakeRenderer();
  const solver = fakeSolver(ops);
  const terrain = fakeTerrain();
  const ctl = createToolController(canvas as unknown as HTMLCanvasElement, {
    store,
    renderer,
    getSolver: () => solver,
    getTerrain: () => terrain,
  });
  return { store, ops, canvas, renderer, ctl };
}

test('simplifyPolyline keeps corners and drops collinear points', () => {
  const pts = [0, 0, 1, 0, 2, 0, 3, 0, 3, 1, 3, 2];
  assert.deepEqual(simplifyPolyline(pts, 0.1), [0, 0, 3, 0, 3, 2]);
  assert.deepEqual(simplifyPolyline([5, 5], 0.1), [5, 5]);
  assert.equal(nextLabel(['Inflow 1', 'Inflow 3'], 'Inflow'), 'Inflow 2');
});

test('camera left-drag follows tool', () => {
  const { store, renderer, ctl } = setup();
  assert.equal(renderer.camera.leftDragOrbits, true);
  store.set({ tool: 'wall' });
  assert.equal(renderer.camera.leftDragOrbits, false);
  store.set({ tool: 'probe' });
  assert.equal(renderer.camera.leftDragOrbits, true);
  ctl.destroy();
});

test('wall drag previews then commits capsule segments on pointerup', () => {
  const { store, ops, canvas, ctl } = setup({ tool: 'wall', brushRadius: 40, wallHeight: 3 });
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  for (let x = 102; x <= 300; x += 2) canvas.dispatchEvent(pointer('pointermove', x, 100));
  for (let y = 102; y <= 300; y += 2) canvas.dispatchEvent(pointer('pointermove', 300, y));
  const prev = ctl.getTransientOverlay().wallPreview;
  assert.ok(prev && prev.pts.length >= 4, 'preview while dragging');
  assert.equal(prev!.height, 3);
  assert.equal(ops.length, 0, 'nothing committed during drag');
  canvas.dispatchEvent(pointer('pointerup', 300, 300));
  assert.equal(ctl.getTransientOverlay().wallPreview, null);
  assert.equal(ops.length, 2, 'L-shaped stroke simplifies to 2 segments');
  const w = ops[0] as Extract<BrushOp, { kind: 'wall' }>;
  assert.equal(w.kind, 'wall');
  assert.equal(w.height, 3);
  assert.equal(w.radius, Math.max(0.75, 40 / 10 / 2));
  assert.deepEqual([w.ax, w.ay], [50, 50]);
  // shift-drag continues from the last end
  canvas.dispatchEvent(pointer('pointerdown', 500, 300, { shiftKey: true }));
  canvas.dispatchEvent(pointer('pointerup', 500, 300, { shiftKey: true }));
  const ext = ops[2] as Extract<BrushOp, { kind: 'wall' }>;
  assert.deepEqual([ext.ax, ext.ay, ext.bx, ext.by], [150, 150, 250, 150]);
  // Esc cancels an in-progress wall
  canvas.dispatchEvent(pointer('pointerdown', 100, 500));
  canvas.dispatchEvent(pointer('pointermove', 200, 500));
  store.set({ tool: 'orbit' });
  assert.equal(ctl.getTransientOverlay().wallPreview, null);
  assert.equal(ops.length, 3);
  ctl.destroy();
});

test('inflow click places, clicking near it removes', () => {
  const { store, canvas, ctl } = setup({ tool: 'inflow', inflowDischarge: 500 });
  canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  canvas.dispatchEvent(pointer('pointerup', 401, 401));
  let s = store.get().sources;
  assert.equal(s.length, 1);
  assert.equal(s[0].type, 'inflow');
  assert.equal((s[0] as { discharge: number }).discharge, 500);
  assert.equal(s[0].label, 'Inflow 1');
  // near-click (within 3% of 512 cells ≈ 15 cells = 30 px) removes
  canvas.dispatchEvent(pointer('pointerdown', 420, 410));
  canvas.dispatchEvent(pointer('pointerup', 420, 410));
  assert.equal(store.get().sources.length, 0);
  // a drag is not a click
  canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  canvas.dispatchEvent(pointer('pointermove', 480, 400));
  canvas.dispatchEvent(pointer('pointerup', 480, 400));
  assert.equal(store.get().sources.length, 0);
  // stage sources are never removed by the inflow tool
  store.set({ sources: [{ id: 'st', type: 'stage', gx: 200, gy: 200, radius: 5, level: 10 }] });
  canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  canvas.dispatchEvent(pointer('pointerup', 400, 400));
  s = store.get().sources;
  assert.equal(s.length, 2);
  ctl.destroy();
});

test('storm, shelter, evac placement and limits', () => {
  const { store, canvas, ctl } = setup({ tool: 'storm', brushRadius: 1000, stormIntensity: 80 });
  const notices: Notice[] = [];
  bridgeFor(store).onNotice((n) => notices.push(n));
  const click = (x: number, y: number) => {
    canvas.dispatchEvent(pointer('pointerdown', x, y));
    canvas.dispatchEvent(pointer('pointerup', x, y));
  };
  click(100, 100);
  assert.equal(store.get().storms[0].radius, 100);
  assert.equal(store.get().storms[0].intensity, 80);
  for (let k = 1; k < MAX_STORMS + 2; k++) click(100 + k * 90, 100 + (k % 2) * 300);
  assert.equal(store.get().storms.length, MAX_STORMS);
  // A limit is information, not a failure: a neutral notice, never the red error toast.
  assert.equal(store.get().error, null);
  assert.ok(notices.some((n) => n.kind === 'info' && n.key === 'limit-storms' && /8\/8/.test(n.title)), 'limit notice posted');
  // At the limit, hovering empty ground shows a muted ring (a click there would add nothing).
  canvas.dispatchEvent(pointer('pointerenter', 950, 950));
  canvas.dispatchEvent(pointer('pointermove', 950, 950));
  ctl.update(1 / 60);
  assert.deepEqual(ctl.getTransientOverlay().cursor?.color, [0.58, 0.62, 0.7]);
  store.set({ tool: 'shelter' });
  click(600, 600);
  click(900, 900);
  assert.deepEqual(store.get().shelters.map((s) => s.name), ['Shelter 1', 'Shelter 2']);
  click(600, 600);
  assert.equal(store.get().shelters.length, 1);
  store.set({ tool: 'evac' });
  click(700, 800);
  assert.deepEqual(store.get().evacStart, { gx: 350, gy: 400 });
  ctl.destroy();
});

test('water and dig hold apply brushes per frame; shift inverts', () => {
  const { store, ops, canvas, ctl } = setup({ tool: 'water', brushRadius: 50 });
  canvas.dispatchEvent(pointer('pointerenter', 200, 200));
  canvas.dispatchEvent(pointer('pointerdown', 200, 200));
  ctl.update(1 / 60);
  ctl.update(1 / 60);
  assert.equal(ops.length, 2);
  const w = ops[0] as Extract<BrushOp, { kind: 'water' }>;
  assert.equal(w.kind, 'water');
  assert.ok(w.amount > 0);
  assert.equal(w.radius, 5);
  canvas.dispatchEvent(pointer('pointermove', 200, 200, { shiftKey: true }));
  ctl.update(1 / 60);
  assert.ok((ops[2] as { amount: number }).amount < 0);
  canvas.dispatchEvent(pointer('pointerup', 200, 200));
  ctl.update(1 / 60);
  assert.equal(ops.length, 3, 'stops on release');
  store.set({ tool: 'dig' });
  canvas.dispatchEvent(pointer('pointerdown', 200, 200));
  ctl.update(0.5); // clamped to 0.1 s
  const d = ops[3] as Extract<BrushOp, { kind: 'terrain' }>;
  assert.equal(d.kind, 'terrain');
  assert.ok(d.delta < 0 && d.delta >= -0.31);
  canvas.dispatchEvent(pointer('pointerup', 200, 200));
  ctl.destroy();
});

test('erase drag emits eraseWall capsules', () => {
  const { ops, canvas, ctl } = setup({ tool: 'eraseWall', brushRadius: 30 });
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  for (let x = 110; x <= 300; x += 10) canvas.dispatchEvent(pointer('pointermove', x, 100));
  canvas.dispatchEvent(pointer('pointerup', 300, 100));
  assert.ok(ops.length > 3);
  assert.ok(ops.every((o) => o.kind === 'eraseWall' && o.radius === 3));
  ctl.destroy();
});

test('probe writes throttled readouts with lat/lon and a cursor ring', async () => {
  const { store, canvas, ctl } = setup({ tool: 'probe' });
  canvas.dispatchEvent(pointer('pointerenter', 512, 512));
  canvas.dispatchEvent(pointer('pointermove', 512, 512));
  ctl.update(1 / 60);
  const p = store.get().probe;
  assert.ok(p);
  assert.equal(p!.gx, 256);
  assert.equal(p!.elevation, 123);
  assert.equal(p!.depth, 0.4);
  assert.ok(p!.lat > 40.4 && p!.lat < 40.48 && p!.lon < -79.96 && p!.lon > -80.06);
  assert.ok(ctl.getTransientOverlay().cursor);
  canvas.dispatchEvent(new Event('pointerleave'));
  ctl.update(1 / 60);
  assert.equal(store.get().probe, null);
  ctl.destroy();
});

test('selectTool remembers brush radius per tool; scaleBrush clamps', () => {
  const store = createStore(baseState({ tool: 'water', brushRadius: 80 }));
  selectTool(store, 'storm');
  assert.equal(store.get().brushRadius, TOOL_BY_ID.storm.brush!.default);
  store.set({ brushRadius: 3000 });
  selectTool(store, 'water');
  assert.equal(store.get().brushRadius, 80);
  selectTool(store, 'storm');
  assert.equal(store.get().brushRadius, 3000);
  for (let k = 0; k < 20; k++) scaleBrush(store, 1.25);
  assert.equal(store.get().brushRadius, TOOL_BY_ID.storm.brush!.max);
});

test('hover picking is skipped while pointer and camera are still', () => {
  const { canvas, renderer, ctl } = setup({ tool: 'water' });
  let picks = 0;
  const pick = renderer.pick.bind(renderer);
  renderer.pick = (x: number, y: number) => {
    picks++;
    return pick(x, y);
  };
  canvas.dispatchEvent(pointer('pointerenter', 300, 300));
  canvas.dispatchEvent(pointer('pointermove', 310, 300));
  ctl.update(1 / 60);
  const afterMove = picks;
  assert.ok(afterMove >= 1);
  for (let k = 0; k < 5; k++) ctl.update(1 / 60); // same instant-ish: no movement, camera still
  assert.ok(picks - afterMove <= 1, `expected no re-picks while idle, got ${picks - afterMove}`);
  renderer.camera.pose = { ...renderer.camera.pose, yaw: 0.5 };
  ctl.update(1 / 60);
  assert.ok(picks > afterMove, 'camera motion re-picks');
  const n = picks;
  canvas.dispatchEvent(pointer('pointermove', 320, 305));
  ctl.update(1 / 60);
  assert.equal(picks, n + 1);
  ctl.destroy();
});

test('wall tool publishes the ground under the cursor and turns the ring red when a wall would be overtopped', () => {
  const stage = { label: 'Point', gaugeDatum: 211.4, normalLevel: 216.3, maxOffset: 12, marks: [{ label: '1936 record', ft: 46 }] };
  const scenario = { description: '', sources: [], storms: [], shelters: [], rainRate: 0, stage, initialFill: [] };
  const { store, canvas, ctl } = setup({ tool: 'wall', wallHeight: 2, scenario, stageOffset: 0 });
  canvas.dispatchEvent(pointer('pointerenter', 300, 300));
  canvas.dispatchEvent(pointer('pointermove', 300, 300));
  ctl.update(1 / 60);
  const hov = bridgeFor(store).hover;
  assert.ok(hov, 'hover published');
  assert.equal(hov!.ground, 123); // fake renderer: ground 123 m, no mirror
  // Normal pool 216.3 m vs a 125 m wall top → far too low → red ring.
  assert.deepEqual(ctl.getTransientOverlay().cursor?.color, [1.0, 0.3, 0.32]);
  // Other tools clear the hover.
  store.set({ tool: 'orbit' });
  ctl.update(1 / 60);
  assert.equal(bridgeFor(store).hover, null);
  ctl.destroy();
});
