/**
 * Wall distance field (CPU): exact bounded Euclidean distances vs brute force, the brush-fringe threshold, crest
 * elevations, incremental change detection (walls and ground) and half-float packing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHalf, WallField, WALL_FIELD_RADIUS, type FieldPatch } from '../../src/render/wallField';

const NX = 150;
const NY = 110;
const R = WALL_FIELD_RADIUS;

function brute(field: WallField, barrier: Float32Array, i: number, j: number): number {
  let best = Infinity;
  for (let y = Math.max(0, j - R); y <= Math.min(NY - 1, j + R); y++) {
    for (let x = Math.max(0, i - R); x <= Math.min(NX - 1, i + R); x++) {
      if (barrier[y * NX + x] > 0 && field.isWallCell(x, y)) best = Math.min(best, Math.hypot(x - i, y - j));
    }
  }
  return best > R ? R + 1 : best;
}

const at = (p: FieldPatch, i: number, j: number) => {
  const w = p.rect.x1 - p.rect.x0;
  assert.ok(i >= p.rect.x0 && i < p.rect.x1 && j >= p.rect.y0 && j < p.rect.y1, `(${i}, ${j}) outside ${JSON.stringify(p.rect)}`);
  const k = (j - p.rect.y0) * w + (i - p.rect.x0);
  return { dist: p.dist[k], height: p.height[k], crest: p.crest[k] };
};

test('wall field: exact bounded EDT, fringe threshold, crest, incremental updates', () => {
  const ground = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) ground[j * NX + i] = 100 + i * 0.1;
  const barrier = new Float32Array(NX * NY);
  const f = new WallField(NX, NY, ground, barrier);
  f.scanAll();
  assert.equal(f.update(), null, 'no walls → nothing to do');
  assert.equal(f.anyWall, false);
  assert.equal(f.consumeEdits(), false);

  // Diagonal 3 m wall with a soft 0.4 m fringe (below half height → not a wall cell), plus a 1 m wall stub.
  for (let k = 20; k < 90; k++) {
    barrier[(k + 5) * NX + k] = 3;
    barrier[(k + 5) * NX + k + 1] = 0.4;
  }
  for (let j = 10; j < 14; j++) barrier[j * NX + 120] = 1;
  f.scanAll();
  assert.equal(f.consumeEdits(), true);
  const p = f.update();
  assert.ok(p);
  assert.equal(f.anyWall, true);
  assert.equal(f.isWallCell(30, 35), true);
  assert.equal(f.isWallCell(31, 35), false, 'soft fringe is not a wall cell');
  let checked = 0;
  for (let j = Math.max(0, p.rect.y0); j < p.rect.y1; j += 3) {
    for (let i = p.rect.x0; i < p.rect.x1; i += 2) {
      const want = brute(f, barrier, i, j);
      const got = at(p, i, j).dist;
      assert.ok(Math.abs(got - want) < 1e-4, `dist at ${i},${j}: ${got} vs ${want}`);
      checked++;
    }
  }
  assert.ok(checked > 500);
  // Height and crest (ground + barrier) of the nearest wall cell.
  assert.equal(at(p, 33, 35).height, 3);
  const c = at(p, 32, 35);
  assert.ok(Math.abs(c.crest - (100 + 3.0 + 3)) < 1e-3 || Math.abs(c.crest - (100 + 3.1 + 3)) < 1e-3, `crest ${c.crest}`);
  assert.equal(at(p, 118, 12).height, 1);

  // Nothing changed → nothing to recompute.
  f.scanAll();
  assert.equal(f.update(), null);

  // Erase the stub: only its neighbourhood (its 32-cell block ± radius) is recomputed, and the field there clears.
  for (let j = 10; j < 14; j++) barrier[j * NX + 120] = 0;
  f.scanRect(115, 8, 125, 16);
  const p2 = f.update();
  assert.ok(p2 && p2.rect.x0 >= 96 - R - 1 && p2.rect.y1 <= 32 + R + 1, JSON.stringify(p2?.rect));
  assert.equal(at(p2, 118, 12).dist, R + 1);
  assert.equal(at(p2, 118, 12).height, 0);

  // Moving a wall inside one block (same total height) is still detected.
  barrier[40 * NX + 100] = 2;
  f.scanAll();
  f.update();
  barrier[40 * NX + 100] = 0;
  barrier[41 * NX + 101] = 2;
  f.scanAll();
  const p3 = f.update();
  assert.ok(p3);
  assert.equal(at(p3, 101, 41).dist, 0);

  const packed = f.packHalf(p3, 100);
  const w3 = p3.rect.x1 - p3.rect.x0;
  const k = ((41 - p3.rect.y0) * w3 + (101 - p3.rect.x0)) * 4;
  assert.equal(packed[k], toHalf(1), 'proximity 1 on the wall cell');
  assert.equal(packed[k + 1], toHalf(2));
  assert.equal(packed[0], 0, 'texels with no wall in range stay zero');

  // Ground edits (digging) are reported under a cursor scan but do not dirty the field.
  f.consumeEdits();
  ground[60 * NX + 60] -= 0.05;
  f.scanSome(1 << 20);
  assert.equal(f.consumeEdits(), false, 'the cyclic scan only watches walls');
  f.scanRect(55, 55, 65, 65);
  assert.equal(f.consumeEdits(), true);
  assert.equal(f.update(), null);
});

test('toHalf encodes representative values', () => {
  const dec = (h: number) => {
    const s = h & 0x8000 ? -1 : 1;
    const e = (h >> 10) & 0x1f;
    const m = h & 0x3ff;
    if (e === 0) return s * 2 ** -14 * (m / 1024);
    if (e === 31) return m ? NaN : s * Infinity;
    return s * 2 ** (e - 15) * (1 + m / 1024);
  };
  for (const v of [0, 1, -1, 0.5, 3.25, 9, 250.75, -37.5, 1e-3, 60000]) {
    assert.ok(Math.abs(dec(toHalf(v)) - v) <= Math.max(1e-4, Math.abs(v) * 1e-3), `${v} → ${dec(toHalf(v))}`);
  }
  assert.equal(dec(toHalf(1e6)), Infinity);
});
