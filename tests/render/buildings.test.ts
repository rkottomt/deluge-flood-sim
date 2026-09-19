/**
 * The extruded city (src/render/buildings.ts): the geometry it builds, the winding convention the pipeline's
 * back-face culling depends on, the LOD cut, and the filter that decides which buildings the sun raster can
 * actually resolve.
 *
 * All CPU-side — no GPU needed. The properties here are the ones a screenshot would show but could not state:
 * that no wall hangs above the ground it stands on, that a roof is exactly base + height, that a concave
 * footprint is triangulated inside itself, and that the shader's LOD cut and the CPU's agree (they must, or
 * buildings pop at the chunk boundary).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_SINK_M,
  BUILDING_CHUNK,
  BUILDING_VERTEX_BYTES,
  MIN_ROOF_CLEARANCE_M,
  PACK,
  SHADOW_FULL_CELLS,
  SHADOW_MIN_CELLS,
  buildBuildingMesh,
  buildingSeed,
  countAtLeast,
  earClip,
  effectiveBuildingStyle,
  lodMinHeight,
  ringArea2,
  selectBuildings,
  shadowOccluderHeights,
  DEFAULT_BUILDING_STYLE,
  type BuildingDraw,
} from '../../src/render/buildings';
import { CAMERA_FOV_Y, OrbitController, type CameraEnvironment } from '../../src/render/camera';
import { frustumPlanes } from '../../src/render/lod';
import { transformPoint4 } from '../../src/render/math';
import { QUALITY_PRESETS, AUTO_LADDER } from '../../src/render/quality';
import type { BuildingSet } from '../../src/contracts';

const CELL = 8;

/** A BuildingSet from plain rings: `rings[k]` is [gx, gy, gx, gy, …] (open), with a height and a base. */
function makeSet(
  rings: number[][],
  heights: number[],
  bases: number[],
  opts: { kind?: number[]; source?: number[] } = {},
): BuildingSet {
  const count = rings.length;
  const offsets = new Uint32Array(count + 1);
  let total = 0;
  for (let k = 0; k < count; k++) {
    offsets[k] = total;
    total += rings[k].length / 2;
  }
  offsets[count] = total;
  const verts = new Float32Array(total * 2);
  let o = 0;
  for (const r of rings) for (const v of r) verts[o++] = v;
  return {
    count,
    offsets,
    verts,
    base: Float32Array.from(bases),
    height: Float32Array.from(heights),
    heightSource: Uint8Array.from(opts.source ?? rings.map(() => 0)),
    kind: Uint8Array.from(opts.kind ?? rings.map(() => 0)),
    names: rings.map(() => undefined),
    heightRaster: null,
    attribution: 'test',
  };
}

/** Flat ground at `z`, or a plane sloping in +x when `slope` is given. */
function flatGround(nx: number, ny: number, z: number, slope = 0): Float32Array {
  const g = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) g[j * nx + i] = z + slope * i;
  return g;
}

// ── Ring geometry ───────────────────────────────────────────────────────────────────────────────

test('ring winding: the shoelace sign says which way a footprint goes round', () => {
  // Unit square, clockwise in a y-down grid (the orientation the mesh builder normalises to).
  const cw = [0, 0, 0, 1, 1, 1, 1, 0];
  assert.ok(ringArea2(cw, 0, 4) < 0, 'clockwise is negative');
  const ccw = [0, 0, 1, 0, 1, 1, 0, 1];
  assert.ok(ringArea2(ccw, 0, 4) > 0);
  assert.equal(Math.abs(ringArea2(cw, 0, 4)) / 2, 1, 'twice the area of a unit square');
});

test('ear clipping covers a concave footprint without leaving it', () => {
  // An L, clockwise in grid coordinates (y down): (0,0) (0,3) (2,3) (2,1) (3,1) (3,0).
  const xs = Float64Array.from([0, 0, 2, 2, 3, 3]);
  const ys = Float64Array.from([0, 3, 3, 1, 1, 0]);
  const out = new Uint32Array(64);
  const n = earClip(xs, ys, 6, out, 0);
  assert.equal(n, (6 - 2) * 3, 'n − 2 triangles');
  // The triangulation covers exactly the polygon's area, and every triangle keeps the ring's orientation, which
  // is what makes the roof face up and survive back-face culling.
  let area = 0;
  for (let t = 0; t < n; t += 3) {
    const [a, b, c] = [out[t], out[t + 1], out[t + 2]];
    const cross = (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
    assert.ok(cross <= 1e-9, `triangle ${t / 3} flipped (cross ${cross})`);
    area += -cross / 2;
  }
  assert.ok(Math.abs(area - 7) < 1e-9, `the L covers 7 square cells, got ${area}`);
});

test('ear clipping never leaves a hole, even in a ring it cannot solve', () => {
  // A bow tie is not a simple polygon; the fan fallback is wrong but must still produce n − 2 triangles.
  const xs = Float64Array.from([0, 2, 0, 2]);
  const ys = Float64Array.from([0, 2, 2, 0]);
  const out = new Uint32Array(32);
  assert.equal(earClip(xs, ys, 4, out, 0), 6);
  assert.equal(earClip(Float64Array.from([0, 1]), Float64Array.from([0, 1]), 2, out, 0), 0, 'fewer than 3 vertices is nothing');
});

test('the per-building variation seed is deterministic and spread out', () => {
  assert.equal(buildingSeed(17, 123.5, 456.25), buildingSeed(17, 123.5, 456.25));
  assert.notEqual(buildingSeed(17, 123.5, 456.25), buildingSeed(18, 123.5, 456.25));
  const buckets = new Array(8).fill(0);
  for (let k = 0; k < 4000; k++) buckets[buildingSeed(k, k * 3.25, k * 7.5) >> 5]++;
  for (const b of buckets) assert.ok(b > 4000 / 8 / 2, `seed bucket too thin: ${buckets.join(',')}`);
});

// ── The mesh ────────────────────────────────────────────────────────────────────────────────────

/** Read back vertex k as the shader sees it. */
function vertexAt(mesh: { vertices: ArrayBuffer }, k: number) {
  const f = new Float32Array(mesh.vertices, k * BUILDING_VERTEX_BYTES, 3);
  const u = new Uint32Array(mesh.vertices, k * BUILDING_VERTEX_BYTES + 12, 1);
  const h = new Float32Array(mesh.vertices, k * BUILDING_VERTEX_BYTES + 16, 1);
  const snorm = (b: number) => {
    const s = b & 0xff;
    return (s > 127 ? s - 256 : s) / 127;
  };
  return {
    gx: f[0],
    elev: f[1],
    gy: f[2],
    height: h[0],
    pack: u[0],
    nx: snorm(u[0] >>> PACK.nxShift),
    nz: snorm(u[0] >>> PACK.nzShift),
    isRoof: (u[0] & PACK.roofBit) !== 0,
    isTop: (u[0] & PACK.topBit) !== 0,
    kind: (u[0] >>> PACK.kindShift) & 0xf,
    source: (u[0] >>> PACK.heightSourceShift) & 3,
    seed: (u[0] >>> PACK.seedShift) & 0xff,
  };
}

test('a box is four walls and a roof, wound outward, planted below the ground', () => {
  const nx = 32;
  const ny = 32;
  const ground = flatGround(nx, ny, 200);
  const set = makeSet([[10, 10, 10, 14, 14, 14, 14, 10]], [30], [200], { kind: [6], source: [1] });
  const mesh = buildBuildingMesh(set, ground, nx, ny);
  assert.equal(mesh.buildingCount, 1);
  assert.equal(mesh.vertexCount, 4 * 4 + 4, '4 wall quads + 4 roof vertices');
  assert.equal(mesh.indices.length, 4 * 6 + 2 * 3);
  assert.equal(mesh.triangleCount, 10);

  const floorY = 200 - BASE_SINK_M;
  const roofY = 230;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const v = vertexAt(mesh, k);
    assert.equal(v.kind, 6);
    assert.equal(v.source, 1);
    assert.ok(Math.abs(v.height - (roofY - floorY)) < 1e-4, 'every vertex carries the building height');
    assert.ok(Math.abs(v.elev - (v.isTop ? roofY : floorY)) < 1e-4);
    if (v.isRoof) {
      assert.ok(v.isTop);
      assert.ok(Math.abs(v.nx) < 1e-6 && Math.abs(v.nz) < 1e-6, 'roof normal is not horizontal');
    }
  }

  // Wall normals point AWAY from the footprint centre (12, 12).
  for (let k = 0; k < 16; k++) {
    const v = vertexAt(mesh, k);
    const outward = (v.gx - 12) * v.nx + (v.gy - 12) * v.nz;
    assert.ok(outward > 0, `wall vertex ${k} normal points inward`);
  }
});

test('the wall bottom is under the ground even on a slope, and the roof never gets buried', () => {
  const nx = 64;
  const ny = 64;
  // 2 m of fall per cell: a 4-cell footprint spans 8 m of relief, more than a rowhouse is tall.
  const ground = flatGround(nx, ny, 100, 2);
  const set = makeSet([[20, 20, 20, 24, 24, 24, 24, 20]], [6], [100 + 2 * 20]);
  const mesh = buildBuildingMesh(set, ground, nx, ny);
  let floorY = Infinity;
  let roofY = -Infinity;
  for (let k = 0; k < mesh.vertexCount; k++) {
    const v = vertexAt(mesh, k);
    floorY = Math.min(floorY, v.elev);
    roofY = Math.max(roofY, v.elev);
  }
  // Lowest ground touched by the perimeter (the sampler takes the min of a cell and its NW neighbours).
  const lowest = 100 + 2 * 19;
  assert.ok(floorY <= lowest - BASE_SINK_M + 1e-6, `floor ${floorY} is not below the ground ${lowest}`);
  // Uphill corner at gx 24 sits at 148 m; a 6 m roof planted on the 5th-percentile base would be at 146 and
  // vanish into the hill, so the clearance rule lifts it.
  const uphill = 100 + 2 * 24;
  assert.ok(roofY > uphill, `roof ${roofY} is buried under the uphill ground ${uphill}`);
  assert.ok(roofY <= uphill + MIN_ROOF_CLEARANCE_M + 1e-6, `roof ${roofY} inflated well past the clearance rule`);
});

test('degenerate footprints are dropped rather than drawn', () => {
  const ground = flatGround(32, 32, 10);
  // A duplicated vertex (zero-length edge, no normal), a two-vertex ring, and a good one.
  const set = makeSet(
    [
      [4, 4, 4, 4, 4, 8, 8, 8],
      [20, 20, 22, 22],
      [12, 12, 12, 16, 16, 16, 16, 12],
    ],
    [10, 10, 10],
    [10, 10, 10],
  );
  const mesh = buildBuildingMesh(set, ground, 32, 32);
  assert.equal(mesh.buildingCount, 2, 'the 2-vertex ring goes, the duplicate collapses to a triangle');
  for (let i = 0; i < mesh.indices.length; i++) assert.ok(mesh.indices[i] < mesh.vertexCount, 'index out of range');
});

test('chunks slice the index buffer into prefixes ordered tallest-first', () => {
  const nx = 256;
  const ny = 256;
  const ground = flatGround(nx, ny, 0);
  const rings: number[][] = [];
  const heights: number[] = [];
  const n = BUILDING_CHUNK * 2 + 7;
  for (let k = 0; k < n; k++) {
    const gx = 4 + (k % 50) * 4;
    const gy = 4 + Math.floor(k / 50) * 4;
    rings.push([gx, gy, gx, gy + 2, gx + 2, gy + 2, gx + 2, gy]);
    heights.push(3 + ((k * 37) % 97));
  }
  const mesh = buildBuildingMesh(makeSet(rings, heights, heights.map(() => 0)), ground, nx, ny);
  assert.equal(mesh.chunks.length, 3);
  let expectFirst = 0;
  for (const c of mesh.chunks) {
    assert.equal(c.firstIndex, expectFirst);
    assert.equal(c.prefix[0], 0);
    assert.equal(c.prefix[c.count], c.indexCount);
    for (let i = 1; i < c.count; i++) assert.ok(c.heights[i] <= c.heights[i - 1], 'chunk heights must descend');
    for (let i = 0; i < c.count; i++) assert.ok(c.prefix[i + 1] > c.prefix[i], 'every building contributes indices');
    assert.ok(c.yMax >= c.yMin && c.gx1 >= c.gx0 && c.gy1 >= c.gy0);
    expectFirst += c.indexCount;
  }
  assert.equal(expectFirst, mesh.indices.length);
});

// ── Winding vs. the pipeline ────────────────────────────────────────────────────────────────────

test("an outward-facing face is front-facing under frontFace 'cw' — which is why the pipeline uses it", () => {
  const nx = 64;
  const ny = 64;
  const env: CameraEnvironment = {
    nx,
    ny,
    cellSize: CELL,
    exaggeration: 1.5,
    minElev: 0,
    maxElev: 50,
    heightAt: () => 0,
    pickWorld: () => null,
  };
  const cam = new OrbitController(env);
  const mesh = buildBuildingMesh(makeSet([[30, 30, 30, 34, 34, 34, 34, 30]], [25], [0]), flatGround(nx, ny, 0), nx, ny);
  const exag = 1.5;
  const world = (k: number) => {
    const v = vertexAt(mesh, k);
    return [(v.gx - nx / 2) * CELL, v.elev * exag, (v.gy - ny / 2) * CELL] as [number, number, number];
  };

  // Look at the box from several directions. WebGPU decides facing from the signed area in FRAMEBUFFER space,
  // where y points down, and calls a negative area front when frontFace is 'cw'. Every triangle whose outward
  // normal is turned toward the camera must land on that side of the test, or back-face culling removes exactly
  // the faces that should be visible.
  let front = 0;
  let back = 0;
  for (const yaw of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2, 0.7]) {
    for (const pitch of [0.15, 0.6, 1.2]) {
      cam.pose = { target: { gx: 32, gy: 32, elevation: 12 }, distance: 400, yaw, pitch };
      const m = cam.matrices(1.5);
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const p = [world(mesh.indices[t]), world(mesh.indices[t + 1]), world(mesh.indices[t + 2])];
        // Geometric normal from the emitted vertex order (right-hand rule).
        const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
        const w = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const mid = [(p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][1] + p[1][1] + p[2][1]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3];
        const toEye = [m.eye[0] - mid[0], m.eye[1] - mid[1], m.eye[2] - mid[2]];
        const facing = n[0] * toEye[0] + n[1] * toEye[1] + n[2] * toEye[2];
        const c = p.map((q) => {
          const v = transformPoint4(m.viewProj, q[0], q[1], q[2]);
          // Framebuffer coordinates: x right, y DOWN (hence the negated y).
          return [v[0] / v[3], -v[1] / v[3]];
        });
        const area = (c[1][0] - c[0][0]) * (c[2][1] - c[0][1]) - (c[1][1] - c[0][1]) * (c[2][0] - c[0][0]);
        if (Math.abs(area) < 1e-9 || Math.abs(facing) < 1e-6) continue;
        if (facing > 0) {
          assert.ok(area < 0, `a face turned toward the camera was not 'cw' front (yaw ${yaw}, pitch ${pitch})`);
          front++;
        } else {
          assert.ok(area > 0, `a face turned away from the camera was not culled (yaw ${yaw}, pitch ${pitch})`);
          back++;
        }
      }
    }
  }
  assert.ok(front > 40 && back > 40, `not enough faces exercised (front ${front}, back ${back})`);
});

// ── LOD ─────────────────────────────────────────────────────────────────────────────────────────

test('the distance cut is the on-screen-pixels rule, and it is the same one the shader applies', () => {
  // The demo's own viewport: 956 CSS px tall at the renderer's 42° vertical field.
  const pixelScale = (2 * Math.tan(CAMERA_FOV_Y / 2)) / 956;
  // A 6.75 m rowhouse (Pittsburgh's median) at 5 km, 1.5× exaggeration, 3 px minimum: under a pixel, gone.
  const minH = lodMinHeight(5000, pixelScale, 3, 1.5);
  assert.ok(minH > 6.75, `median rowhouse should be cut at 5 km (cut ${minH.toFixed(1)} m)`);
  assert.ok(lodMinHeight(400, pixelScale, 3, 1.5) < 6.75, 'and kept at 400 m');
  // A 256 m tower is never cut anywhere inside an 8 km domain.
  assert.ok(lodMinHeight(8000, pixelScale, 8, 1.5) < 256, 'the U.S. Steel Tower must survive the cheapest tier');
  // Exactly the shader's expression: minPx · dist · pixelScale / exaggeration.
  assert.ok(Math.abs(lodMinHeight(1234, pixelScale, 2.6, 1.5) - (2.6 * 1234 * pixelScale) / 1.5) < 1e-12);
  assert.equal(lodMinHeight(0, pixelScale, 3, 1.5), lodMinHeight(1, pixelScale, 3, 1.5), 'clamped at 1 m');
});

test('countAtLeast finds the prefix of a descending height list', () => {
  const h = Float32Array.from([100, 50, 50, 20, 8, 3]);
  assert.equal(countAtLeast(h, 200), 0);
  assert.equal(countAtLeast(h, 100), 1);
  assert.equal(countAtLeast(h, 50), 3);
  assert.equal(countAtLeast(h, 21), 3);
  assert.equal(countAtLeast(h, 0), 6);
  assert.equal(countAtLeast(new Float32Array(0), 1), 0);
});

/** A city laid out in Morton order, the way src/data/buildings.ts ships one. */
function morton(x: number, y: number): number {
  let m = 0;
  for (let b = 0; b < 8; b++) m |= (((x >> b) & 1) << (2 * b)) | (((y >> b) & 1) << (2 * b + 1));
  return m;
}

function cityMesh(side: number, span: number, towerEvery: number) {
  const cells: Array<{ cx: number; cy: number }> = [];
  for (let cy = 0; cy < side; cy++) for (let cx = 0; cx < side; cx++) cells.push({ cx, cy });
  // Morton order is what makes a contiguous slice of buildings a contiguous patch of city — and therefore what
  // makes a chunk worth frustum-culling as a unit.
  cells.sort((a, b) => morton(a.cx, a.cy) - morton(b.cx, b.cy));
  const rings: number[][] = [];
  const heights: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const gx = 4 + cells[k].cx * span;
    const gy = 4 + cells[k].cy * span;
    rings.push([gx, gy, gx, gy + 3, gx + 3, gy + 3, gx + 3, gy]);
    heights.push(k % towerEvery === 0 ? 120 : 7);
  }
  return { rings, heights };
}

test('selection thins the far city and drops what is behind the camera', () => {
  const nx = 512;
  const ny = 512;
  const ground = flatGround(nx, ny, 0);
  const { rings, heights } = cityMesh(60, 8, 30);
  const mesh = buildBuildingMesh(makeSet(rings, heights, heights.map(() => 0)), ground, nx, ny);
  assert.equal(mesh.buildingCount, 3600);
  assert.ok(mesh.chunks.length >= 9, `expected several chunks, got ${mesh.chunks.length}`);
  const env: CameraEnvironment = { nx, ny, cellSize: CELL, exaggeration: 1.5, minElev: 0, maxElev: 120, heightAt: () => 0, pickWorld: () => null };
  const cam = new OrbitController(env);
  const pixelScale = (2 * Math.tan(CAMERA_FOV_Y / 2)) / 956;
  const out: BuildingDraw[] = [];

  cam.pose = { target: { gx: 120, gy: 120, elevation: 0 }, distance: 500, yaw: 0.4, pitch: 0.5 };
  const near = cam.matrices(1.5);
  const a = selectBuildings(mesh.chunks, near.eye, frustumPlanes(near.viewProj), nx, ny, CELL, 1.5, pixelScale, 3, out);
  assert.ok(a.buildings > 0, 'the near view must draw something');
  assert.ok(a.buildings < mesh.buildingCount, `frustum culling did nothing (${a.buildings})`);

  cam.pose = { target: { gx: 256, gy: 256, elevation: 0 }, distance: 9000, yaw: 0.4, pitch: 0.5 };
  const far = cam.matrices(1.5);
  const b = selectBuildings(mesh.chunks, far.eye, frustumPlanes(far.viewProj), nx, ny, CELL, 1.5, pixelScale, 3, out);
  // Only the 120 m ones are still worth three pixels from nine kilometres away.
  assert.ok(b.buildings <= mesh.buildingCount / 20, `too many rowhouses kept at 9 km (${b.buildings})`);
  assert.ok(b.buildings > 0, 'the towers must survive');
  // Every emitted run is a real prefix of some chunk and never runs past the buffer.
  let indices = 0;
  for (const d of b.draws) {
    assert.ok(d.firstIndex >= 0 && d.firstIndex + d.indexCount <= mesh.indices.length);
    indices += d.indexCount;
  }
  assert.equal(indices, b.indices);
  // Runs that came out adjacent are merged, so a full city is a handful of draws rather than one per chunk.
  assert.ok(b.draws.length <= mesh.chunks.length);
});

test('a camera pointed away from the city issues no draws at all', () => {
  const nx = 512;
  const ny = 512;
  const ground = flatGround(nx, ny, 0);
  // Everything in the north-west corner.
  const { rings, heights } = cityMesh(16, 6, 30);
  const mesh = buildBuildingMesh(makeSet(rings, heights, heights.map(() => 0)), ground, nx, ny);
  const env: CameraEnvironment = { nx, ny, cellSize: CELL, exaggeration: 1.5, minElev: 0, maxElev: 120, heightAt: () => 0, pickWorld: () => null };
  const cam = new OrbitController(env);
  // Target the south-east corner, looking further south-east: the city is behind the near plane.
  cam.pose = { target: { gx: 500, gy: 500, elevation: 0 }, distance: 200, yaw: (135 * Math.PI) / 180, pitch: 0.1 };
  const m = cam.matrices(1.5);
  const out: BuildingDraw[] = [];
  const sel = selectBuildings(mesh.chunks, m.eye, frustumPlanes(m.viewProj), nx, ny, CELL, 1.5, 8e-4, 3, out);
  assert.equal(sel.buildings, 0, 'nothing in front of the camera, nothing drawn');
  assert.equal(sel.draws.length, 0);
});

// ── Quality tiers ───────────────────────────────────────────────────────────────────────────────

test('every quality tier carries a building LOD, and the ladder only ever gets cheaper', () => {
  for (const [name, p] of Object.entries(QUALITY_PRESETS)) {
    assert.ok(p.buildingMinPx > 0, `${name} has no building cut`);
    assert.ok(p.buildingDetail >= 0 && p.buildingDetail <= 1, `${name} detail out of range`);
    assert.ok(p.buildingReflections >= 0 && p.buildingReflections <= 1, `${name} reflections out of range`);
  }
  assert.ok(QUALITY_PRESETS.cinematic.buildingMinPx < QUALITY_PRESETS.high.buildingMinPx, 'cinematic draws more city than high');
  assert.equal(QUALITY_PRESETS.cinematic.buildingReflections, 1, 'glass reflections are the cinematic tier only');
  assert.equal(QUALITY_PRESETS.high.buildingReflections, 0);
  for (let i = 1; i < AUTO_LADDER.length; i++) {
    assert.ok(AUTO_LADDER[i].buildingMinPx >= AUTO_LADDER[i - 1].buildingMinPx, `ladder step ${i} draws more buildings than the step above it`);
    assert.ok(AUTO_LADDER[i].buildingDetail <= AUTO_LADDER[i - 1].buildingDetail, `ladder step ${i} adds facade detail on the way down`);
  }
  // No auto step is as expensive as cinematic: the controller can never climb into the hero tier by itself.
  for (const step of AUTO_LADDER) assert.ok(step.buildingMinPx > QUALITY_PRESETS.cinematic.buildingMinPx);
});

test('the style sits on top of the tier rather than replacing it', () => {
  const tier = QUALITY_PRESETS.balanced;
  const untouched = effectiveBuildingStyle(tier, DEFAULT_BUILDING_STYLE);
  assert.equal(untouched.minPx, tier.buildingMinPx, 'a default style follows the tier exactly');
  assert.equal(untouched.detail, tier.buildingDetail);
  assert.equal(untouched.reflections, tier.buildingReflections);
  const pushed = effectiveBuildingStyle(tier, { ...DEFAULT_BUILDING_STYLE, minPx: 12, detail: 0, reflections: 1 });
  assert.equal(pushed.minPx, 12, 'the host may thin the city further');
  assert.equal(pushed.detail, 0);
  assert.equal(pushed.reflections, 1, 'and may ask for glass on a cheaper tier');
  const held = effectiveBuildingStyle(QUALITY_PRESETS.cinematic, { ...DEFAULT_BUILDING_STYLE, minPx: 0.5 });
  assert.equal(held.minPx, QUALITY_PRESETS.cinematic.buildingMinPx, 'but may not undercut the tier');
});

// ── What the sun raster can resolve ─────────────────────────────────────────────────────────────

test('only buildings the shadow raster can resolve become occluders', () => {
  const cell = 7.8125;
  const raster = Float32Array.from([0, 3, 6.75, cell * SHADOW_MIN_CELLS + 0.01, cell * 2, cell * SHADOW_FULL_CELLS, 200]);
  const out = shadowOccluderHeights(raster, cell);
  assert.ok(out);
  assert.equal(out![0], 0, 'empty cells stay empty');
  assert.equal(out![1], 0, 'a 3 m shed is far under a cell');
  assert.equal(out![2], 0, "Pittsburgh's median rowhouse does not reach the raster");
  assert.ok(out![3] > 0 && out![3] < raster[3] * 0.1, 'the threshold fades in rather than stepping');
  assert.ok(out![4] > 0 && out![4] < raster[4], 'mid-way is partial');
  assert.ok(Math.abs(out![5] - raster[5]) < 1e-4, 'past SHADOW_FULL_CELLS the height is passed through');
  assert.ok(Math.abs(out![6] - 200) < 1e-4, 'a tower is a tower');
  // Nothing tall enough anywhere: the raster stays exactly as it was before buildings existed.
  assert.equal(shadowOccluderHeights(Float32Array.from([0, 4, 6.75]), cell), null);
});

test('the meshed city carries its provenance and class through to the shader', () => {
  const ground = flatGround(32, 32, 0);
  const set = makeSet(
    [
      [4, 4, 4, 8, 8, 8, 8, 4],
      [16, 16, 16, 20, 20, 20, 20, 16],
    ],
    [40, 9],
    [0, 0],
    { kind: [6, 1], source: [0, 2] },
  );
  const mesh = buildBuildingMesh(set, ground, 32, 32);
  const seen = new Map<string, { kind: number; source: number; seed: number }>();
  for (let k = 0; k < mesh.vertexCount; k++) {
    const v = vertexAt(mesh, k);
    seen.set(v.height.toFixed(2), { kind: v.kind, source: v.source, seed: v.seed });
  }
  const office = seen.get((40 + BASE_SINK_M).toFixed(2));
  const house = seen.get((9 + BASE_SINK_M).toFixed(2));
  assert.equal(office?.kind, 6, 'the office kept its class');
  assert.equal(office?.source, 0, "…and its 'measured' provenance");
  assert.equal(house?.kind, 1);
  assert.equal(house?.source, 2, "…and the house kept its 'estimated' one");
  assert.notEqual(office?.seed, house?.seed, 'two buildings do not share a colour seed');
});
