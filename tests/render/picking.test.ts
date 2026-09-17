/**
 * CPU-side renderer logic: heightfield surface model, ray picking accuracy (including thin walls and grazing
 * views), orbit camera conventions and constraints, CDLOD selection invariants and legend tables.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HeightField, meshStride } from '../../src/render/heightfield';
import { cameraRay, intersectHeightfield, pickTerrain } from '../../src/render/picking';
import { minCameraDistance, OrbitController, type CameraEnvironment } from '../../src/render/camera';
import { transformPoint4 } from '../../src/render/math';
import { frustumPlanes, LodTree, LOD_INSTANCE_FLOATS, LOD_PATCH } from '../../src/render/lod';
import { bandsForMode, cssToLinear, DEPTH_BANDS, MAX_DEPTH_BANDS, VELOCITY_BANDS } from '../../src/render/legend';
import type { SimSnapshot } from '../../src/contracts';

const N = 256;
const CELL = 8;

function makeTerrain(n = N) {
  const ground = new Float32Array(n * n);
  const barrier = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const v = j / n;
      ground[j * n + i] = 200 + 60 * Math.sin(u * 7.1) * Math.cos(v * 5.3) + 25 * Math.sin(u * 31 + v * 17) + 90 * Math.max(0, u - 0.7);
    }
  }
  // A one-cell-wide 3 m wall along gx = 100.5, gy ∈ [60, 200].
  for (let j = 60; j < 200; j++) barrier[j * n + 100] = 3;
  return { ground, barrier };
}

function env(hf: HeightField, exaggeration: number): CameraEnvironment {
  return {
    nx: hf.nx,
    ny: hf.ny,
    cellSize: hf.cellSize,
    exaggeration,
    minElev: hf.minElev,
    maxElev: hf.maxElev,
    heightAt: (gx, gy) => hf.heightAt(gx, gy),
    pickWorld: () => null,
  };
}

test('meshStride keeps the vertex grid within budget', () => {
  assert.equal(meshStride(512, 512), 1);
  assert.equal(meshStride(1024, 1024), 1);
  assert.equal(meshStride(2048, 2048), 2);
  for (const n of [512, 1024, 2048, 4096]) {
    const s = meshStride(n, n);
    assert.ok((n / s + 1) ** 2 <= 1_100_000, `stride ${s} for ${n}`);
  }
});

test('heightAt reproduces mesh vertices and is piecewise linear', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  for (const [k, l] of [
    [0, 0],
    [10, 20],
    [100, 100],
    [N, N],
    [N, 3],
  ]) {
    assert.ok(Math.abs(hf.heightAt(k, l) - hf.corner(k, l)) < 1e-4);
  }
  // Wall vertices carry the full barrier height on top of the averaged ground.
  const g = (i: number, j: number) => ground[j * N + i];
  const expected = 0.25 * (g(100, 99) + g(101, 99) + g(100, 100) + g(101, 100)) + 3;
  assert.ok(Math.abs(hf.corner(101, 100) - expected) < 1e-3);
  // Midpoint of an edge = mean of its endpoints.
  const mid = hf.heightAt(40.5, 50);
  assert.ok(Math.abs(mid - 0.5 * (hf.corner(40, 50) + hf.corner(41, 50))) < 1e-3);
});

test('picking recovers projected surface points (top-down, oblique, grazing, walls)', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  const W = 1600;
  const H = 1000;
  for (const exag of [1, 1.5, 3]) {
    const cam = new OrbitController(env(hf, exag));
    const poses = [
      { target: { gx: 128, gy: 128, elevation: 220 }, distance: 2600, yaw: 0, pitch: Math.PI / 2 },
      { target: { gx: 100, gy: 120, elevation: 230 }, distance: 900, yaw: 0.8, pitch: 0.6 },
      { target: { gx: 90, gy: 130, elevation: 230 }, distance: 1400, yaw: -1.4, pitch: 0.12 },
      { target: { gx: 101, gy: 150, elevation: 220 }, distance: 120, yaw: 1.57, pitch: 0.35 },
    ];
    for (const pose of poses) {
      pose.target.elevation = hf.heightAt(pose.target.gx, pose.target.gy);
      cam.pose = pose;
      cam.update(0);
      const m = cam.matrices(W / H);
      let tested = 0;
      for (let s = 0; s < 3000 && tested < 60; s++) {
        // Deterministic sample points, biased toward the wall.
        // Points in a window around the target (scaled to what is on screen), a third of them on the wall.
        const R = Math.min(110, (pose.distance / CELL) * 0.6);
        const gx = s % 3 === 0 ? 100.3 + ((s * 0.37) % 1.4) : pose.target.gx + (((s * 0.6180339) % 1) * 2 - 1) * R;
        const gy = s % 3 === 0 ? pose.target.gy + (((s * 0.4142135) % 1) * 2 - 1) * R : pose.target.gy + (((s * 0.7548776) % 1) * 2 - 1) * R;
        if (gx < 0 || gy < 0 || gx > N || gy > N) continue;
        const y = hf.heightAt(gx, gy) * exag;
        const x = (gx - N / 2) * CELL;
        const z = (gy - N / 2) * CELL;
        const c = transformPoint4(m.viewProj, x, y, z, 1);
        if (c[3] <= 0) continue;
        const sx = ((c[0] / c[3]) * 0.5 + 0.5) * W;
        const sy = (0.5 - (c[1] / c[3]) * 0.5) * H;
        if (sx < 0 || sy < 0 || sx > W || sy > H) continue;
        const ray = cameraRay(m, sx, sy, W, H);
        const hit = intersectHeightfield(ray, hf, exag);
        assert.ok(hit, `no hit for ${gx},${gy}`);
        // The first intersection may legitimately be an occluder in front of the point: only require agreement
        // when the point is actually visible (hit distance ≈ distance to the point).
        const dist = Math.hypot(x - ray.origin[0], y - ray.origin[1], z - ray.origin[2]);
        if (Math.abs(hit.t - dist) > dist * 1e-5 + 0.02) continue;
        const err = Math.hypot(hit.gx - gx, hit.gy - gy);
        assert.ok(err < 0.01, `pick error ${err.toFixed(4)} cells at (${gx.toFixed(2)}, ${gy.toFixed(2)}) exag ${exag} pose ${JSON.stringify(pose)}`);
        tested++;
      }
      assert.ok(tested >= 8, `too few visible samples (${tested}) for pose ${JSON.stringify(pose)}`);
    }
  }
});

test('pickTerrain reports depth from the snapshot and misses outside the domain', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  const depth = new Float32Array(N * N);
  depth[128 * N + 64] = 1.25;
  const snap = { simTime: 0, nx: N, ny: N, depth, stats: {} } as unknown as SimSnapshot;
  const cam = new OrbitController(env(hf, 1.5));
  cam.pose = { target: { gx: 64.5, gy: 128.5, elevation: 200 }, distance: 1500, yaw: 0, pitch: Math.PI / 2 };
  cam.update(0);
  const m = cam.matrices(1.6);
  const hit = pickTerrain(cameraRay(m, 800, 500, 1600, 1000), hf, 1.5, snap);
  assert.ok(hit);
  assert.ok(Math.abs(hit.gx - 64.5) < 0.05 && Math.abs(hit.gy - 128.5) < 0.05);
  assert.equal(hit.depth, 1.25);
  // Looking at the sky misses.
  cam.pose = { target: { gx: 128, gy: 128, elevation: 200 }, distance: 1500, yaw: 0, pitch: 0.2 };
  cam.update(0);
  const m2 = cam.matrices(1.6);
  assert.equal(pickTerrain(cameraRay(m2, 800, 5, 1600, 1000), hf, 1.5, snap), null);
});

test('orbit camera: yaw/pitch conventions, clearance, flyTo, topDown, frameAll', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  const cam = new OrbitController(env(hf, 1.5));
  // yaw 0 looks north (−Z), yaw π/2 looks east (+X), pitch π/2 straight down.
  let b = OrbitController.basis(0, 0.3);
  assert.ok(b.forward[2] < 0 && Math.abs(b.forward[0]) < 1e-9);
  b = OrbitController.basis(Math.PI / 2, 0.3);
  assert.ok(b.forward[0] > 0.9);
  b = OrbitController.basis(1, Math.PI / 2);
  assert.ok(b.forward[1] < -0.999);

  // Clearance: a pose that would put the eye inside a hill is lifted above the surface.
  cam.pose = { target: { gx: 200, gy: 128, elevation: 150 }, distance: 400, yaw: Math.PI / 2, pitch: 0.036 };
  for (let i = 0; i < 5; i++) cam.update(1 / 60);
  const eye = cam.eyeFor(cam.pose);
  const ground0 = hf.heightAt(eye[0] / CELL + N / 2, eye[2] / CELL + N / 2) * 1.5;
  assert.ok(eye[1] > ground0, `eye ${eye[1]} below terrain ${ground0}`);

  // flyTo converges exactly.
  const target = { target: { gx: 60, gy: 70, elevation: 210 }, distance: 700, yaw: 2.5, pitch: 0.9 };
  cam.flyTo(target, 1);
  for (let i = 0; i < 90; i++) cam.update(1 / 60);
  assert.ok(Math.abs(cam.pose.distance - 700) < 1e-6 && Math.abs(cam.pose.pitch - 0.9) < 1e-6);
  assert.ok(Math.abs(cam.pose.target.gx - 60) < 1e-6);

  cam.topDown();
  for (let i = 0; i < 90; i++) cam.update(1 / 60);
  assert.ok(Math.abs(cam.pose.pitch - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(cam.pose.target.gx - 60) < 1e-6);

  cam.aspect = 1.6;
  cam.frameAll();
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  const fm = cam.matrices(1.6);
  // Every domain corner is on screen.
  for (const [gx, gy] of [
    [0, 0],
    [N, 0],
    [0, N],
    [N, N],
  ]) {
    const c = transformPoint4(fm.viewProj, (gx - N / 2) * CELL, hf.heightAt(gx, gy) * 1.5, (gy - N / 2) * CELL, 1);
    assert.ok(c[3] > 0);
    assert.ok(Math.abs(c[0] / c[3]) <= 1.02 && Math.abs(c[1] / c[3]) <= 1.02, `corner ${gx},${gy} off screen`);
  }

  // Non-finite input is rejected.
  cam.pose = { target: { gx: NaN, gy: 10, elevation: 0 }, distance: -5, yaw: Infinity, pitch: 7 };
  cam.update(0);
  const p = cam.pose;
  assert.ok(Number.isFinite(p.target.gx) && p.distance > 0 && Number.isFinite(p.yaw) && p.pitch <= Math.PI / 2);
});

test('orbit camera: zoom limits follow the data resolution and the framed map size', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  // No imagery: the grid alone sets the limit; 1.95 m imagery texels push it out (a texel stays ≥ ~10 px).
  assert.equal(minCameraDistance(8), 128);
  assert.equal(minCameraDistance(2), 120);
  assert.ok(Math.abs(minCameraDistance(7.8125, 8000 / 4096) - 195.3) < 0.1);
  assert.equal(minCameraDistance(8, null), 128);
  const cam = new OrbitController({ ...env(hf, 1.5), imageryMetersPerTexel: 2 });
  cam.aspect = 1.54;
  assert.equal(cam.minDistance(), 200);
  const framed = cam.framingPose().distance;
  assert.ok(Math.abs(cam.maxDistance() - 2 * framed) < 1e-6);
  cam.pose = { target: { gx: 128, gy: 128, elevation: 200 }, distance: 1000, yaw: 0.3, pitch: 0.8 };
  cam.update(0);
  // Wheel zoom stops at both limits.
  for (let i = 0; i < 60; i++) cam.zoomAt(800, 500, 0.7);
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  assert.ok(Math.abs(cam.pose.distance - 200) < 1e-3, `zoomed in to ${cam.pose.distance}`);
  for (let i = 0; i < 60; i++) cam.zoomAt(800, 500, 1.5);
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  assert.ok(Math.abs(cam.pose.distance - 2 * framed) < 1e-3 * framed, `zoomed out to ${cam.pose.distance}`);
  // Poses set from outside are clamped too.
  cam.pose = { target: { gx: 128, gy: 128, elevation: 200 }, distance: 50_000, yaw: 0.3, pitch: 0.8 };
  cam.update(0);
  assert.ok(cam.pose.distance <= 2 * framed + 1e-6);
  // A new environment (e.g. a different exaggeration) recomputes the far limit.
  cam.setEnvironment({ ...env(hf, 6), imageryMetersPerTexel: 2 });
  assert.ok(Math.abs(cam.maxDistance() - 2 * cam.framingPose().distance) < 1e-6);
});

test('orbit camera: top-down during a flight looks down on the flight target', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  const cam = new OrbitController(env(hf, 1.5));
  cam.aspect = 1.54;
  // Panned off the map and zoomed out, then F and T 350 ms apart.
  cam.pose = { target: { gx: -40, gy: 300, elevation: 200 }, distance: cam.maxDistance(), yaw: 1.2, pitch: 0.5 };
  cam.update(0);
  const framing = cam.framingPose();
  cam.frameAll();
  for (let i = 0; i < 21; i++) cam.update(1 / 60);
  cam.topDown();
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  const p = cam.pose;
  assert.ok(Math.abs(p.pitch - Math.PI / 2) < 1e-6);
  assert.ok(Math.abs(p.target.gx - framing.target.gx) < 1e-6 && Math.abs(p.target.gy - framing.target.gy) < 1e-6);
  assert.ok(Math.abs(p.distance - framing.distance) < 1e-6 * framing.distance, `distance ${p.distance} vs ${framing.distance}`);
  // Top-down from a target panned outside the map comes back onto the map's edge.
  cam.pose = { target: { gx: -50, gy: N + 30, elevation: 200 }, distance: 2000, yaw: 0, pitch: 0.7 };
  cam.update(0);
  cam.topDown();
  for (let i = 0; i < 120; i++) cam.update(1 / 60);
  assert.ok(cam.pose.target.gx === 0 && cam.pose.target.gy === N, `target ${cam.pose.target.gx},${cam.pose.target.gy}`);
  assert.ok(Math.abs(cam.pose.target.elevation - hf.heightAt(0, N)) < 1e-6);
});

test('reversed-Z projection keeps depth precision over a 10 km domain', () => {
  const { ground, barrier } = makeTerrain();
  const hf = new HeightField(N, N, CELL, ground, barrier, 1);
  const cam = new OrbitController(env(hf, 1.5));
  cam.pose = { target: { gx: 128, gy: 128, elevation: 200 }, distance: 12000, yaw: 0.4, pitch: 0.3 };
  cam.update(0);
  const m = cam.matrices(1.6);
  // Two points 5 cm apart along the view ray at ~12 km must still map to distinct float32 depths.
  const eye = m.eye;
  const dir = m.forward;
  const z = (d: number) => {
    const c = transformPoint4(m.viewProj, eye[0] + dir[0] * d, eye[1] + dir[1] * d, eye[2] + dir[2] * d, 1);
    return Math.fround(c[2] / c[3]);
  };
  assert.ok(z(12000) > z(12000.05), 'depth must decrease with distance and resolve 5 cm');
  assert.ok(z(m.near * 1.5) > 0 && z(m.near * 1.5) <= 1);
});

test('CDLOD selection covers the domain once, with ≤ 1 level between neighbours', () => {
  const n = 1024;
  const ground = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ground[j * n + i] = 200 + 80 * Math.sin(i / 90) * Math.cos(j / 70);
  const barrier = new Float32Array(n * n);
  const tree = new LodTree(n, n, 8, 1, ground, barrier);
  assert.equal(tree.levels, 6);
  const all = new Float64Array(24);
  for (let p = 0; p < 6; p++) all[p * 4 + 3] = 1; // planes that accept everything
  const pixelAngle = (2 * Math.tan((42 * Math.PI) / 360)) / 1000;
  for (const eye of [
    [0, 900, 0],
    [-3000, 400, 2500],
    [5000, 3000, -5000],
    [0, 20000, 0],
  ] as Array<[number, number, number]>) {
    const sel = tree.select(eye, all, pixelAngle, 3, 1.5, 3, 30);
    const cover = new Uint8Array(n * n);
    const levelAt = new Int8Array(n * n);
    for (let k = 0; k < sel.count; k++) {
      const o = k * LOD_INSTANCE_FLOATS;
      const gx0 = sel.instances[o];
      const gy0 = sel.instances[o + 1];
      const size = sel.instances[o + 2] * LOD_PATCH;
      for (let j = gy0; j < Math.min(n, gy0 + size); j++) {
        for (let i = gx0; i < Math.min(n, gx0 + size); i++) {
          cover[j * n + i]++;
          levelAt[j * n + i] = sel.instances[o + 3];
        }
      }
      assert.ok(sel.instances[o + 4] < sel.instances[o + 5], 'morph range ordered');
    }
    for (let c = 0; c < n * n; c++) assert.equal(cover[c], 1, `cell ${c} covered ${cover[c]}×`);
    for (let j = 0; j < n; j += 7) {
      for (let i = 0; i + 1 < n; i++) {
        assert.ok(Math.abs(levelAt[j * n + i] - levelAt[j * n + i + 1]) <= 1, 'adjacent LOD levels differ by > 1');
      }
    }
  }
  // Frustum culling removes nodes behind the camera.
  const cam = new OrbitController({
    nx: n,
    ny: n,
    cellSize: 8,
    exaggeration: 1.5,
    minElev: 120,
    maxElev: 280,
    heightAt: () => 200,
    pickWorld: () => null,
  });
  cam.pose = { target: { gx: 512, gy: 512, elevation: 200 }, distance: 1500, yaw: 0, pitch: 0.4 };
  cam.update(0);
  const m = cam.matrices(1.6);
  const culled = tree.select(m.eye, frustumPlanes(m.viewProj), pixelAngle, 3, 1.5, 3, 30);
  const full = tree.select(m.eye, all, pixelAngle, 3, 1.5, 3, 30);
  assert.ok(culled.count > 0 && culled.count < full.count);
});

test('legend bands are ordered, contiguous and valid colors', () => {
  for (const bands of [DEPTH_BANDS, MAX_DEPTH_BANDS, VELOCITY_BANDS]) {
    assert.ok(bands.length >= 4 && bands.length <= 8);
    for (let i = 0; i < bands.length; i++) {
      assert.match(bands[i].color, /^#[0-9a-f]{6}$/i);
      assert.ok(bands[i].label.length > 0);
      if (i > 0) assert.equal(bands[i].min, bands[i - 1].max);
    }
    assert.equal(bands[bands.length - 1].max, Infinity);
  }
  assert.deepEqual(DEPTH_BANDS.map((b) => b.max).slice(0, 5), [0.15, 0.5, 1, 2, 3]);
  assert.equal(bandsForMode('realistic'), null);
  assert.equal(bandsForMode('velocity'), VELOCITY_BANDS);
  const [r, g, b] = cssToLinear('#ffffff');
  assert.ok(Math.abs(r - 1) < 1e-9 && Math.abs(g - 1) < 1e-9 && Math.abs(b - 1) < 1e-9);
  assert.ok(Math.abs(cssToLinear('#808080')[0] - 0.2158605) < 1e-5);
});
