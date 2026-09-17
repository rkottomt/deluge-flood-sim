/**
 * Wall distance field (CPU): exact bounded Euclidean distances vs brute force, the brush-fringe threshold, crest
 * elevations, incremental change detection and half-float packing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toHalf, WallField, WALL_FIELD_RADIUS } from '../../src/render/wallField';

const NX = 150;
const NY = 110;

function brute(field: WallField, barrier: Float32Array, i: number, j: number): number {
  const R = WALL_FIELD_RADIUS;
  let best = Infinity;
  for (let y = Math.max(0, j - R); y <= Math.min(NY - 1, j + R); y++) {
    for (let x = Math.max(0, i - R); x <= Math.min(NX - 1, i + R); x++) {
      if (barrier[y * NX + x] > 0 && field.isWallCell(x, y)) best = Math.min(best, Math.hypot(x - i, y - j));
    }
  }
  return best > R ? R + 1 : best;
}

test('wall field: exact bounded EDT, fringe threshold, crest, incremental updates', () => {
  const ground = new Float32Array(NX * NY);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) ground[j * NX + i] = 100 + i * 0.1;
  const barrier = new Float32Array(NX * NY);
  const f = new WallField(NX, NY, ground, barrier);
  f.scanAll();
  assert.equal(f.update(), null, 'no walls → nothing to do');
  assert.equal(f.anyWall, false);

  // Diagonal 3 m wall with a soft 0.4 m fringe (below half height → not a wall cell), plus a 1 m wall stub.
  for (let k = 20; k < 90; k++) {
    barrier[(k + 5) * NX + k] = 3;
    barrier[(k + 5) * NX + k + 1] = 0.4;
  }
  for (let j = 10; j < 14; j++) barrier[j * NX + 120] = 1;
  f.scanSome(1024); // one block only: not everything seen yet
  f.scanAll();
  const rect = f.update();
  assert.ok(rect && rect.x1 > rect.x0 && rect.y1 > rect.y0);
  assert.equal(f.anyWall, true);
  assert.equal(f.isWallCell(30, 35), true);
  assert.equal(f.isWallCell(31, 35), false, 'soft fringe is not a wall cell');
  for (let j = 0; j < NY; j += 3) {
    for (let i = 0; i < NX; i += 2) {
      const want = brute(f, barrier, i, j);
      assert.ok(Math.abs(f.dist[j * NX + i] - want) < 1e-4, `dist at ${i},${j}: ${f.dist[j * NX + i]} vs ${want}`);
    }
  }
  // Height and crest of the nearest wall.
  assert.equal(f.height[35 * NX + 33], 3);
  assert.ok(Math.abs(f.crest[35 * NX + 32] - (100 + 3.0 + 3)) < 1e-3 || Math.abs(f.crest[35 * NX + 32] - (100 + 3.1 + 3)) < 0.2);
  assert.equal(f.height[12 * NX + 118], 1);

  // Erase the stub: only its neighbourhood is recomputed, and the field there clears.
  for (let j = 10; j < 14; j++) barrier[j * NX + 120] = 0;
  f.scanRect(115, 8, 125, 16);
  const r2 = f.update();
  assert.ok(r2 && r2.x0 >= 96 - WALL_FIELD_RADIUS - 1 && r2.y1 <= 32 + WALL_FIELD_RADIUS + 1, JSON.stringify(r2));
  assert.equal(f.dist[12 * NX + 118], WALL_FIELD_RADIUS + 1);
  assert.equal(f.height[12 * NX + 118], 0);
  // Moving a wall inside one block (same total height) is still detected.
  barrier[40 * NX + 100] = 2;
  f.scanAll();
  f.update();
  barrier[40 * NX + 100] = 0;
  barrier[41 * NX + 101] = 2;
  f.scanAll();
  assert.ok(f.update());
  assert.equal(f.dist[41 * NX + 101], 0);

  const packed = f.packHalf({ x0: 100, y0: 40, x1: 103, y1: 42 }, 100);
  assert.equal(packed.length, 3 * 2 * 4);
  assert.equal(packed[(1 * 3 + 1) * 4], toHalf(0));
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
