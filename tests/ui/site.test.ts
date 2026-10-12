/**
 * The Site tool and the site list: click → pin, drag around a parcel → outline, click a site → select it, limits,
 * and the lasso simplification (src/ui/tools.ts siteOutline, src/ui/sites.ts).
 * Run: node --import tsx --test tests/ui/site.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../../src/app/store';
import { geoToGrid } from '../../src/data/geo';
import { SITE_LIMITS } from '../../src/loss/site';
import { bridgeFor, type Notice } from '../../src/ui/bridge';
import { sitesFor } from '../../src/ui/sites';
import { TOOL_BY_ID, toolForKey } from '../../src/ui/toolDefs';
import { createToolController, siteOutline, SITE_MIN_OUTLINE_M2 } from '../../src/ui/tools';
import type { BrushOp } from '../../src/contracts';
import { baseState, FakeCanvas, fakeRenderer, fakeSolver, fakeTerrain, pointer } from './helpers';

function setup() {
  const store = createStore(baseState({ tool: 'site' }));
  const canvas = new FakeCanvas();
  const terrain = fakeTerrain();
  const ops: BrushOp[] = [];
  const solver = fakeSolver(ops);
  const ctl = createToolController(canvas as unknown as HTMLCanvasElement, { store, renderer: fakeRenderer(), getSolver: () => solver, getTerrain: () => terrain });
  const notices: Notice[] = [];
  bridgeFor(store).onNotice((n) => notices.push(n));
  return { store, canvas, terrain, ctl, notices, sites: sitesFor(store) };
}

const click = (c: FakeCanvas, x: number, y: number) => {
  c.dispatchEvent(pointer('pointerdown', x, y));
  c.dispatchEvent(pointer('pointerup', x, y));
};

test('the site tool is listed with its S shortcut and a ring', () => {
  assert.equal(TOOL_BY_ID.site.key, 'S');
  assert.ok(TOOL_BY_ID.site.ringColor);
  assert.equal(toolForKey('1')?.id, 'orbit'); // digits unchanged
});

test('click drops a pin at the picked ground; clicking it again selects it instead of adding', () => {
  const { canvas, terrain, ctl, sites } = setup();
  click(canvas, 200, 300);
  assert.equal(sites.sites.length, 1);
  const s = sites.sites[0];
  assert.equal(s.ring, null);
  const g = geoToGrid(terrain, s.lon, s.lat);
  assert.ok(Math.abs(g.gx - 100) < 1e-6 && Math.abs(g.gy - 150) < 1e-6);
  assert.equal(sites.selectedId, s.id);
  click(canvas, 600, 600);
  assert.equal(sites.sites.length, 2);
  assert.equal(sites.selectedId, sites.sites[1].id);
  click(canvas, 204, 302); // near the first pin
  assert.equal(sites.sites.length, 2);
  assert.equal(sites.selectedId, sites.sites[0].id);
  ctl.destroy();
});

test('a drag around a parcel becomes an outline; a scribble too small for a parcel is refused with a notice', () => {
  const { canvas, terrain, ctl, sites, notices } = setup();
  canvas.dispatchEvent(pointer('pointerdown', 100, 100));
  const path: Array<[number, number]> = [];
  for (let x = 100; x <= 200; x += 4) path.push([x, 100]);
  for (let y = 100; y <= 180; y += 4) path.push([200, y]);
  for (let x = 200; x >= 100; x -= 4) path.push([x, 180]);
  for (let y = 180; y >= 100; y -= 4) path.push([100, y]);
  for (const [x, y] of path) canvas.dispatchEvent(pointer('pointermove', x, y));
  assert.ok(sites.draft && sites.draft.length > 8, 'the lasso is drawn while dragging');
  canvas.dispatchEvent(pointer('pointerup', 100, 100));
  assert.equal(sites.draft, null);
  assert.equal(sites.sites.length, 1);
  const ring = sites.sites[0].ring!;
  assert.equal(ring.length, 8, 'a rectangle simplifies to its four corners');
  const c = geoToGrid(terrain, sites.sites[0].lon, sites.sites[0].lat);
  assert.ok(Math.abs(c.gx - 75) < 2 && Math.abs(c.gy - 70) < 2, 'the pin sits at the centroid');
  // A sliver half a cell wide simplifies to a line: not a parcel.
  canvas.dispatchEvent(pointer('pointerdown', 400, 400));
  for (const [x, y] of [[410, 400], [410, 401], [400, 401], [400, 400]]) canvas.dispatchEvent(pointer('pointermove', x, y));
  canvas.dispatchEvent(pointer('pointerup', 400, 400));
  assert.equal(sites.sites.length, 1);
  assert.ok(notices.some((n) => n.key === 'site-outline'));
  ctl.destroy();
});

test('siteOutline: simplified, capped in corners, closing duplicate dropped, minimum area', () => {
  const circle: number[] = [];
  for (let k = 0; k <= 720; k++) {
    const a = (k / 720) * 2 * Math.PI;
    circle.push(100 + 40 * Math.cos(a), 100 + 40 * Math.sin(a));
  }
  const o = siteOutline(circle, 10, 12)!;
  assert.ok(o.length / 2 <= 12 && o.length / 2 >= 3);
  assert.ok(Math.hypot(o[0] - o[o.length - 2], o[1] - o[o.length - 1]) >= 1, 'no duplicate closing corner');
  assert.equal(siteOutline([0, 0, 1, 0, 1, 1, 0, 1], 1, 12), null, `under ${SITE_MIN_OUTLINE_M2} m²`);
  assert.equal(siteOutline([0, 0, 10, 0], 10, 12), null);
});

test('site list: limit, select, remove, replace from a link', () => {
  const { store, canvas, ctl, sites, notices } = setup();
  for (let k = 0; k < SITE_LIMITS.maxSites; k++) click(canvas, 50 + k * 100, 50);
  assert.equal(sites.sites.length, SITE_LIMITS.maxSites);
  assert.ok(sites.full);
  click(canvas, 900, 900);
  assert.equal(sites.sites.length, SITE_LIMITS.maxSites);
  assert.ok(notices.some((n) => n.key === 'limit-sites'));
  sites.update(sites.sites[2].id, { occupancy: 'warehouse', floors: 1 });
  sites.select(sites.sites[2].id);
  sites.remove(sites.sites[7].id);
  click(canvas, 900, 900);
  assert.equal(sites.sites[7].occupancy, 'warehouse', 'a new site inherits the selected planned use');
  sites.remove(sites.selectedId!);
  assert.equal(sites.selectedId, sites.sites[sites.sites.length - 1].id);
  sites.replace([{ ...sites.sites[0], id: 'zz' }]);
  assert.deepEqual(sites.sites.map((s) => s.id), ['s1']);
  assert.equal(sitesFor(store), sites, 'one registry per store');
  ctl.destroy();
});
