/// <reference types="node" />
/**
 * Live-area scenario synthesis (offline parts): stage sources where detected water crosses the domain edge at
 * the local surface level, shelters on dry high intersections away from water, and the 3DEP zero-clamp signature.
 * The network path itself is exercised in the browser harness (dev/data.html?live=lat,lon,size).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RoadEdge, RoadNetwork } from '../../src/contracts';
import { zeroClampFraction } from '../../src/data/dem';
import { burnWaterBodies, detectWaterBodies } from '../../src/data/hydro';
import { computeInitialWater } from '../../src/data/initialWater';
import { buildLiveScenario } from '../../src/data/live';

const N = 256;
const CELL = 10;

/**
 * A valley with a river flowing west → east (surface 100 m, gently sloping), a town grid of streets on both
 * banks, and hills rising north and south to 140 m.
 */
function valley() {
  const z = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const d = Math.abs(j - 128);
      const surface = 100.4 - 0.4 * (i / N);
      z[j * N + i] = d <= 12 ? surface : surface + Math.min(40, 0.8 * (d - 12) + 0.004 * (d - 12) ** 2);
    }
  }
  // Street grid every 16 cells; a street node is a grid intersection.
  const nodes: number[] = [];
  const index = new Map<string, number>();
  const node = (gx: number, gy: number) => {
    const key = `${gx},${gy}`;
    let id = index.get(key);
    if (id === undefined) {
      id = nodes.length / 2;
      nodes.push(gx, gy);
      index.set(key, id);
    }
    return id;
  };
  const edges: RoadEdge[] = [];
  const edge = (ax: number, ay: number, bx: number, by: number, name: string) => {
    edges.push({ a: node(ax, ay), b: node(bx, by), length: Math.hypot(bx - ax, by - ay) * CELL, cls: 'local', name, pts: Float32Array.from([ax, ay, bx, by]) });
  };
  for (let y = 8; y < N; y += 16) {
    if (Math.abs(y - 128) <= 14) continue;
    for (let x = 8; x + 16 < N; x += 16) edge(x, y, x + 16, y, `${y} St`);
  }
  for (let x = 8; x < N; x += 16) {
    for (let y = 8; y + 16 < N; y += 16) {
      if (Math.abs(y - 128) <= 14 || Math.abs(y + 16 - 128) <= 14) continue;
      edge(x, y, x, y + 16, `${x} Ave`);
    }
  }
  const roads: RoadNetwork = { nodes: Float32Array.from(nodes), edges };
  return { z, roads };
}

test('live scenario: stage sources on the river at both edges, shelters high, dry and named', () => {
  const { z, roads } = valley();
  const bodies = detectWaterBodies(z, N, N, CELL);
  assert.ok(bodies.length >= 1 && bodies[0].touchesEdge, 'river detected, crossing the domain');
  const burned = burnWaterBodies(z, N, N, bodies, 3, 2);
  const s = buildLiveScenario(burned.elevation, N, N, CELL, bodies, burned.fills, roads, 'Test Valley', 'usgs3dep');
  const h0 = computeInitialWater({ nx: N, ny: N, elevation: burned.elevation }, s);

  const stages = s.sources.filter((src) => src.type === 'stage');
  assert.ok(stages.length >= 2, `stage sources at both edges (${stages.length})`);
  assert.ok(stages.some((src) => src.gx < 20) && stages.some((src) => src.gx > N - 20));
  for (const src of stages) {
    assert.ok(src.type === 'stage');
    assert.ok(Math.abs(src.gy - 128) <= 6, `stage source on the river (gy ${src.gy})`);
    assert.ok(src.gx - src.radius >= 0 && src.gx + src.radius <= N, 'footprint inside the domain');
    assert.ok(h0[Math.floor(src.gy) * N + Math.floor(src.gx)] > 2, 'river starts full at the source');
    const expected = 100.4 - 0.4 * (src.gx / N);
    assert.ok(Math.abs(src.level - expected) < 0.1, `local level ${src.level} vs ${expected.toFixed(2)}`);
  }
  assert.ok(s.stage && s.stage.maxOffset > 0);

  assert.ok(s.shelters.length >= 2);
  const ceiling = s.stage!.normalLevel + s.stage!.maxOffset;
  for (const sh of s.shelters) {
    const zz = burned.elevation[Math.floor(sh.gy) * N + Math.floor(sh.gx)];
    assert.ok(zz > ceiling + 2.9, `shelter ${sh.name} at ${zz.toFixed(1)} m above ${ceiling.toFixed(1)} m`);
    assert.equal(h0[Math.floor(sh.gy) * N + Math.floor(sh.gx)], 0);
    assert.match(sh.name, /^Shelter — \d+ (St|Ave) \(\d+ m\)$/);
  }
  // Shelters are spread out (≥ 200 m apart).
  for (let a = 0; a < s.shelters.length; a++) {
    for (let b = a + 1; b < s.shelters.length; b++) {
      assert.ok(Math.hypot(s.shelters[a].gx - s.shelters[b].gx, s.shelters[a].gy - s.shelters[b].gy) * CELL >= 200);
    }
  }
  assert.match(s.description, /Test Valley/);
  assert.ok(s.camera && s.camera.distance > 0);
});

test('zero-clamp signature: many cells at ~0 m and no negatives', () => {
  const clamped = new Float32Array(10000);
  for (let k = 0; k < clamped.length; k++) clamped[k] = k % 3 === 0 ? 0.004 : 1 + (k % 7);
  assert.ok(zeroClampFraction(clamped) > 0.3);
  const real = Float32Array.from(clamped, (v, k) => (k % 3 === 0 ? -1.7 : v));
  real[5] = 0.001;
  assert.equal(zeroClampFraction(real), 0, 'genuine negative elevations → not clamped');
  const mountains = Float32Array.from({ length: 10000 }, (_, k) => 1500 + (k % 100));
  assert.equal(zeroClampFraction(mountains), 0);
});
