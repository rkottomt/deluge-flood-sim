/// <reference types="node" />
/**
 * Hydro-conditioning on synthetic hydro-flattened DEMs: the channel burn must follow the flat river surface
 * only (not a disconnected pond at the same level, not a flat terrace slightly above it, not the floodplain),
 * carve the requested depth with a smooth monotone bank, and handle sloping rivers. Also water-body detection
 * for live areas, the distance transform and isotonic regression helpers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  burnRivers,
  burnWaterBodies,
  detectWaterBodies,
  distanceTransform,
  findRiverEnds,
  monotoneNonIncreasing,
  openWaterGaps,
  riverLevelProfile,
  type WaterBody,
} from '../../src/data/hydro';
import { computeInitialWater } from '../../src/data/initialWater';

const N = 256;
const CELL = 5;
const POOL = 100;

/** Deterministic small-amplitude roughness (lidar texture), ±amp. */
function rough(i: number, j: number, amp: number): number {
  const h = Math.sin(i * 12.9898 + j * 78.233) * 43758.5453;
  return (h - Math.floor(h) - 0.5) * 2 * amp;
}

const centerY = (x: number) => 128 + 20 * Math.sin(x / 40);
const HALF_W = 10;

/**
 * Flat-pool river (west → east) on a floodplain 1.5 m above the pool. The water surface is exactly flat; the
 * 2 cells beyond the water edge ramp linearly to the floodplain (bilinear resampling of the shoreline).
 * Traps: a disconnected flat pond at exactly the pool level, and a flat terrace at pool + 0.6 m touching
 * the river.
 */
function flatRiverDEM(surface: (i: number) => number = () => POOL) {
  const z = new Float32Array(N * N);
  const river = new Uint8Array(N * N);
  const pond = new Uint8Array(N * N);
  const terrace = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const L = surface(i);
      const d = Math.abs(j + 0.5 - centerY(i + 0.5));
      const flood = L + 1.5 + 0.004 * Math.abs(j - 128) + rough(i, j, 0.08);
      if (d <= HALF_W) {
        z[k] = L;
        river[k] = 1;
      } else if (d <= HALF_W + 2) {
        const t = (d - HALF_W) / 2;
        z[k] = L + t * (flood - L);
      } else {
        z[k] = flood;
      }
      // Disconnected pond: 20×14 cells, flat at the pool level, well away from the river.
      if (i >= 30 && i < 50 && j >= 20 && j < 34) {
        z[k] = L;
        pond[k] = 1;
        river[k] = 0;
      }
      // Flat terrace (parking lot) 0.6 m above the pool, touching the river's north bank.
      if (i >= 120 && i < 150 && d > HALF_W && j < centerY(i + 0.5) && d <= HALF_W + 12) {
        z[k] = L + 0.6;
        terrace[k] = 1;
      }
    }
  }
  return { z, river, pond, terrace };
}

test('flat-pool burn follows the river only, with the requested depth and smooth banks', () => {
  const { z, river, pond, terrace } = flatRiverDEM();
  const res = burnRivers(z, N, N, CELL, [
    {
      name: 'Test River',
      path: [
        { gx: 2, gy: centerY(2) },
        { gx: 128, gy: centerY(128) },
        { gx: 254, gy: centerY(254) },
      ],
      depth: 6,
      bankCells: 3,
      flatLevel: POOL,
    },
  ]);
  let riverCells = 0;
  let riverBurned = 0;
  let outsideBurned = 0;
  let pondBurned = 0;
  let terraceBurned = 0;
  let farBurned = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      const d = Math.abs(j + 0.5 - centerY(i + 0.5));
      if (river[k]) {
        riverCells++;
        if (res.owner[k]) riverBurned++;
      } else if (res.owner[k]) {
        outsideBurned++;
        if (d > HALF_W + 2) farBurned++;
      }
      if (pond[k] && res.owner[k]) pondBurned++;
      if (terrace[k] && res.owner[k]) terraceBurned++;
    }
  }
  assert.equal(pondBurned, 0, 'disconnected pond at the same level must not be burned');
  assert.equal(terraceBurned, 0, 'flat terrace 0.6 m above the pool must not be burned');
  assert.equal(farBurned, 0, 'no floodplain cells beyond the shoreline ramp');
  assert.ok(riverBurned >= riverCells * 0.99, `river cells burned ${riverBurned}/${riverCells}`);
  assert.ok(outsideBurned <= riverCells * 0.08, `shoreline cells burned ${outsideBurned}`);
  assert.equal(res.burnedCells, riverBurned + outsideBurned);

  // Depth at the center and monotone bank profile across a section.
  for (const i of [40, 128, 200]) {
    const cj = Math.floor(centerY(i + 0.5));
    const bedCenter = res.elevation[cj * N + i];
    assert.ok(Math.abs(bedCenter - (POOL - 6)) < 0.05, `center bed ${bedCenter} at column ${i}`);
    for (const dir of [-1, 1]) {
      // Bed rises monotonically from the center to the shore (channel cells), and the first land cell is not
      // lower than the last water cell.
      let prev = bedCenter;
      for (let s = 1; s <= HALF_W + 4; s++) {
        const k = (cj + dir * s) * N + i;
        const v = res.elevation[k];
        assert.ok(v >= prev - 0.02, `bank not monotone at column ${i}, offset ${dir * s}: ${v} < ${prev}`);
        prev = v;
        if (!res.owner[k]) break;
      }
    }
    // The first water cell next to the shore is only slightly lowered (smooth bank, not a cliff).
    for (let s = 0; s <= HALF_W + 2; s++) {
      const k = (cj - s) * N + i;
      if (!res.owner[k]) {
        const inner = res.burn[(cj - s + 1) * N + i];
        assert.ok(inner < 3.5, `bank step ${inner} m next to shore`);
        break;
      }
    }
  }
  // Land is untouched.
  for (let k = 0; k < N * N; k++) if (!res.owner[k]) assert.equal(res.elevation[k], z[k]);

  // Initial water from a couple of seeds fills exactly the channel at the pool level.
  const h = computeInitialWater(
    { nx: N, ny: N, elevation: res.elevation },
    { initialFill: [{ seeds: [{ gx: 60, gy: centerY(60) }], level: POOL }] },
  );
  let wetOutside = 0;
  let wet = 0;
  for (let k = 0; k < N * N; k++) {
    if (h[k] > 0.01) {
      wet++;
      if (!res.owner[k]) wetOutside++;
    }
    if (pond[k]) assert.equal(h[k], 0, 'pond stays dry (not connected, and bed == level)');
  }
  assert.equal(wetOutside, 0);
  assert.ok(wet >= riverBurned * 0.99);
  const cj = Math.floor(centerY(128.5));
  assert.ok(Math.abs(h[cj * N + 128] - 6) < 0.05);

  // Sources at the domain edges sit on the channel spine with a footprint inside the channel.
  const ends = findRiverEnds(res, N, N, 12);
  const west = ends.find((e) => e.end === 'upstream')!;
  const east = ends.find((e) => e.end === 'downstream')!;
  assert.ok(west && east);
  assert.equal(west.edge, 'west');
  assert.equal(east.edge, 'east');
  for (const e of [west, east]) {
    assert.ok(Math.abs(e.gy - centerY(e.gx)) <= 2.5, `source ${e.end} off the centerline: ${e.gy} vs ${centerY(e.gx)}`);
    assert.ok(e.radius >= 4 && e.radius <= 12);
    assert.ok(Math.min(e.gx, N - e.gx) >= e.radius + 0.5 - 1e-6, 'footprint inside the domain');
    assert.ok(Math.min(e.gx, N - e.gx) <= 20, 'near the edge');
  }
});

test('sloping river: monotone profile, burn follows the slope without flooding the banks', () => {
  const slope = 0.02; // m per cell = 4 m/km
  const surface = (i: number) => POOL + 5 - slope * i;
  const { z, river, pond } = flatRiverDEM(surface);
  const path = [];
  for (let x = 2; x <= 254; x += 36) path.push({ gx: x, gy: centerY(x) });
  const res = burnRivers(z, N, N, CELL, [{ name: 'Sloped', path, depth: 2.5, bankCells: 2 }]);
  const r = res.rivers[0];
  for (let q = 1; q < r.levels.length; q++) assert.ok(r.levels[q] <= r.levels[q - 1] + 1e-9, 'levels non-increasing downstream');
  assert.ok(Math.abs(r.maxLevel - surface(2)) < 0.3, `upstream level ${r.maxLevel}`);
  assert.ok(Math.abs(r.minLevel - surface(254)) < 0.3, `downstream level ${r.minLevel}`);
  let riverCells = 0;
  let riverBurned = 0;
  let pondBurned = 0;
  let far = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const k = j * N + i;
      if (river[k]) {
        riverCells++;
        if (res.owner[k]) riverBurned++;
      }
      if (pond[k] && res.owner[k]) pondBurned++;
      if (res.owner[k] && Math.abs(j + 0.5 - centerY(i + 0.5)) > HALF_W + 2) far++;
    }
  }
  assert.equal(pondBurned, 0);
  assert.equal(far, 0);
  assert.ok(riverBurned >= riverCells * 0.97, `burned ${riverBurned}/${riverCells}`);

  // Sloped initial fill: one fill, seeds along the centerline carrying their own level.
  const seeds: Array<{ gx: number; gy: number; level: number }> = [];
  for (let q = 0; q < r.centerline.length / 2; q += 8) {
    const gx = r.centerline[q * 2];
    const gy = r.centerline[q * 2 + 1];
    seeds.push({ gx, gy, level: res.waterLevel[Math.floor(gy) * N + Math.floor(gx)] });
  }
  const h = computeInitialWater({ nx: N, ny: N, elevation: res.elevation }, { initialFill: [{ seeds, level: Math.min(...seeds.map((s) => s.level)) }] });
  let wet = 0;
  let wetOutside = 0;
  let maxDepth = 0;
  for (let k = 0; k < N * N; k++) {
    if (h[k] > 0.01) {
      wet++;
      if (!res.owner[k]) wetOutside++;
      maxDepth = Math.max(maxDepth, h[k]);
    }
  }
  assert.equal(wetOutside, 0, 'upstream levels must not spill onto downstream banks');
  assert.ok(wet >= riverBurned * 0.95, `wet ${wet} vs burned ${riverBurned}`);
  assert.ok(maxDepth < 2.5 + 0.6, `max depth ${maxDepth}`);
});

test('riverLevelProfile rejects bridge decks and stays monotone', () => {
  const z: number[] = [];
  const flat: boolean[] = [];
  for (let k = 0; k < 300; k++) {
    let v = 110 - 0.01 * k;
    let f = true;
    if (k >= 140 && k < 146) {
      v += 12; // bridge deck crossing the river
      f = false;
    }
    z.push(v + (k % 7 === 0 ? 0.05 : 0));
    flat.push(f);
  }
  const L = riverLevelProfile(z, flat);
  for (let k = 1; k < L.length; k++) assert.ok(L[k] <= L[k - 1] + 1e-9);
  for (let k = 130; k < 160; k++) assert.ok(Math.abs(L[k] - (110 - 0.01 * k)) < 0.25, `profile at bridge ${k}: ${L[k]}`);
  assert.deepEqual(Array.from(monotoneNonIncreasing([3, 1, 2, 0])), [3, 1.5, 1.5, 0]);
});

test('distance transform matches brute force', () => {
  const nx = 37;
  const ny = 23;
  const sites = new Set<number>();
  let s = 11;
  for (let q = 0; q < 25; q++) {
    s = (s * 48271) % 2147483647;
    sites.add(s % (nx * ny));
  }
  const dt = distanceTransform(nx, ny, (k) => sites.has(k));
  for (let k = 0; k < nx * ny; k++) {
    let best = Infinity;
    for (const t of sites) best = Math.min(best, Math.hypot((k % nx) - (t % nx), Math.floor(k / nx) - Math.floor(t / nx)));
    assert.ok(Math.abs(dt[k] - best) < 1e-4, `cell ${k}: ${dt[k]} vs ${best}`);
  }
});

test('live-area water-body detection finds a lake and a river, not flat fields', () => {
  const n = 256;
  const cell = 10;
  const z = new Float32Array(n * n);
  const lake = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      // Rolling hills with lidar roughness.
      z[k] = 250 + 8 * Math.sin(i / 23) + 6 * Math.cos(j / 31) + rough(i, j, 0.15);
      const dl = Math.hypot(i - 70, j - 70);
      if (dl < 22) {
        z[k] = 240; // hydro-flattened lake, 4 ha+
        lake[k] = 1;
      } else if (dl < 26) z[k] = Math.min(z[k], 240 + (dl - 22) * 2.5);
      // A river crossing the domain at 230 m (flat), banks rising.
      const dr = Math.abs(j - 190);
      if (dr <= 6) z[k] = 230;
      else if (dr <= 12) z[k] = Math.min(z[k], 230 + (dr - 6) * 1.2);
      // A flat, perfectly level field on a hilltop (not a local minimum).
      if (i > 180 && i < 230 && j > 40 && j < 90) z[k] = 262;
    }
  }
  const bodies = detectWaterBodies(z, n, n, cell);
  const lakeBody = bodies.find((b) => Math.abs(b.level - 240) < 0.05);
  const riverBody = bodies.find((b) => Math.abs(b.level - 230) < 0.05);
  assert.ok(lakeBody, 'lake detected');
  assert.ok(riverBody, 'river detected');
  assert.ok(!bodies.some((b) => Math.abs(b.level - 262) < 0.5), 'hilltop field rejected (rim not higher)');
  const k0 = Math.floor(lakeBody!.seed.gy) * n + Math.floor(lakeBody!.seed.gx);
  assert.equal(lake[k0], 1, 'seed inside the lake');
  const burned = burnWaterBodies(z, n, n, bodies, 3, 2);
  assert.ok(Math.abs(burned.elevation[70 * n + 70] - 237) < 1e-3, 'lake center lowered by 3 m');
  const h = computeInitialWater({ nx: n, ny: n, elevation: burned.elevation }, { initialFill: burned.fills });
  assert.ok(Math.abs(h[70 * n + 70] - 3) < 1e-3);
  assert.equal(h[60 * n + 200], 0, 'hilltop dry');
});

test('live areas: a canal behind a leaky sub-grid floodwall does not drown the low neighborhood next to it', () => {
  const n = 192;
  const cell = 8;
  const z = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      let v = 6 + 0.02 * i + rough(i, j, 0.1); // high ground west
      if (i >= 80 && i < 100) v = 0.5; // canal, hydro-flattened at 0.5 m, crossing the domain north → south
      else if (i === 79 || i === 100) v = 2.5; // levees / floodwalls
      // Neighborhood east of the canal, below the canal surface, with bare-earth urban roughness (curbs, yards).
      if (i > 100) v = 0.1 + rough(i, j, 0.2);
      if (i === 100 && j >= 90 && j < 93) v = 0.3; // a 3-cell gap in the wall the DEM resolution smears
      z[k] = v;
    }
  }
  const bodies = detectWaterBodies(z, n, n, cell);
  const canal = bodies.find((b) => Math.abs(b.level - 0.5) < 0.01);
  assert.ok(canal, 'canal detected');
  assert.ok(canal!.touchesEdge);
  const burned = burnWaterBodies(z, n, n, bodies, 3, 2);
  assert.ok(burned.sealedCells >= 3, `gap sealed (${burned.sealedCells})`);
  const h = computeInitialWater({ nx: n, ny: n, elevation: burned.elevation }, { initialFill: burned.fills });
  assert.ok(h[100 * n + 90] > 2.9, 'canal full');
  let east = 0;
  for (let j = 0; j < n; j++) for (let i = 102; i < n; i++) if (h[j * n + i] > 0) east++;
  assert.equal(east, 0, 'neighborhood behind the wall stays dry');
});

test('live areas: a two-reach river with low gravel-bar banks is fully detected without over-deep water at the step', () => {
  const n = 256;
  const cell = 8;
  const z = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const upper = i < 128;
      const L = upper ? 91.5 : 90.8; // reaches separated by a riffle at i = 128
      const d = Math.abs(j - 128);
      let v = 100 + 0.05 * d + rough(i, j, 0.2);
      if (d <= 25) v = L - 0.0005 * (i % 128); // gently sloping flat surface
      else if (d <= 30) {
        // Banks: on the upper reach's north side a long low gravel bar only 5–15 cm above the water.
        const bar = upper && j < 128 && i > 10 && i < 118;
        v = bar ? L + 0.05 + 0.02 * (d - 26) + rough(i, j, 0.01) : L + 0.6 * (d - 25);
      }
      if (i >= 126 && i <= 130 && d <= 25) v = 91.15 + rough(i, j, 0.15); // riffle: not flat
      z[k] = v;
    }
  }
  const bodies = detectWaterBodies(z, n, n, cell);
  const up = bodies.find((b) => Math.abs(b.level - 91.5) < 0.1);
  const down = bodies.find((b) => Math.abs(b.level - 90.8) < 0.1);
  assert.ok(up, 'upper reach (low bars) detected');
  assert.ok(down, 'lower reach detected');
  const burned = burnWaterBodies(z, n, n, bodies, 3, 2);
  assert.equal(burned.fills.length, 1, 'one fill with per-seed levels');
  const h = computeInitialWater({ nx: n, ny: n, elevation: burned.elevation }, { initialFill: burned.fills });
  let maxDepth = 0;
  for (let k = 0; k < h.length; k++) maxDepth = Math.max(maxDepth, h[k]);
  assert.ok(maxDepth < 3.3, `max initial depth ${maxDepth.toFixed(2)} m (burn is 3 m)`);
  assert.ok(h[128 * n + 60] > 2.9 && h[128 * n + 200] > 2.9, 'both reaches full');
  assert.equal(h[20 * n + 60], 0, 'valley side dry');
});

/** A WaterBody from a mask and a per-cell level function (bypasses detection for exact geometry tests). */
function bodyFromMask(mask: Uint8Array, n: number, levelOf: (i: number, j: number) => number): WaterBody {
  const idx: number[] = [];
  const lv: number[] = [];
  for (let k = 0; k < mask.length; k++) {
    if (!mask[k]) continue;
    idx.push(k);
    lv.push(levelOf(k % n, (k / n) | 0));
  }
  const s = idx[idx.length >> 1];
  const seed = { gx: (s % n) + 0.5, gy: ((s / n) | 0) + 0.5 };
  return {
    level: lv[lv.length >> 1],
    minLevel: Math.min(...lv),
    maxLevel: Math.max(...lv),
    cells: idx.length,
    seed,
    seeds: [{ ...seed, level: lv[lv.length >> 1] }],
    indices: Int32Array.from(idx),
    levels: Float32Array.from(lv),
    touchesEdge: true,
  };
}

/**
 * A 400 m wide river (rows 60–139, 5 m cells) on 4 m high banks, crossed and interrupted by features that all
 * stand dry above the water in a hydro-flattened DEM:
 *   i ≈ 30–60  a diagonal ridge ≤ 1 m high from bank to bank (a bridge-removal / seam artifact) → open
 *   i = 80     a straight 1.5 m band carrying a mapped road (causeway or bridge — ambiguous)    → keep
 *   i = 100    a narrow low island in mid-river                                                  → keep
 *   i = 120    a low spit / pier from the north bank                                             → keep
 *   i = 150    a dam holding 1 m of head (101 m upstream, 100 m downstream)                      → keep
 *   i = 175    a 5 m embankment across the river                                                 → keep
 */
function crossedRiver() {
  const n = 200;
  const cell = 5;
  const z = new Float32Array(n * n);
  const water = new Uint8Array(n * n);
  const road = new Uint8Array(n * n);
  const kind = new Uint8Array(n * n); // 1 ridge, 2 causeway, 3 island, 4 spit, 5 dam, 6 embankment
  const levelOf = (i: number) => (i < 150 ? 101 : 100);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const L = levelOf(i);
      if (j < 60 || j >= 140) {
        z[k] = 104 + rough(i, j, 0.2);
        continue;
      }
      z[k] = L;
      water[k] = 1;
      const dRidge = Math.abs(i - (30 + (j - 60) * 0.375)); // oblique: from (30, 60) to (60, 140)
      if (dRidge <= 5) {
        z[k] = L + 0.1 + 0.9 * (1 - dRidge / 5.5);
        kind[k] = 1;
      } else if (Math.abs(i - 80) <= 3) {
        z[k] = L + 1.5;
        kind[k] = 2;
        if (i === 80) road[k] = 1;
      } else if (Math.abs(i - 100) <= 2 && j >= 92 && j <= 108) {
        z[k] = L + 0.8;
        kind[k] = 3;
      } else if (Math.abs(i - 120) <= 2 && j < 90) {
        z[k] = L + 1;
        kind[k] = 4;
      } else if (Math.abs(i - 150) <= 2) {
        z[k] = 102.5;
        kind[k] = 5;
      } else if (Math.abs(i - 175) <= 3) {
        z[k] = L + 5;
        kind[k] = 6;
      }
      if (kind[k]) water[k] = 0;
    }
  }
  return { n, cell, z, water, road, kind, body: () => bodyFromMask(water, n, (i) => levelOf(i)) };
}

test('live areas: a low ridge across a river is opened; causeways, islands, spits, dams and embankments are kept', () => {
  const { n, cell, z, road, kind, body } = crossedRiver();
  const bodies = [body()];
  const verdicts: Array<{ accepted: boolean; bbox: [number, number, number, number]; onRoad: boolean }> = [];
  const res = openWaterGaps(z, n, n, cell, bodies, { roads: road, onCandidate: (c) => verdicts.push(c) });
  assert.equal(res.bands, 1, `one band opened (${JSON.stringify(verdicts.filter((v) => v.accepted))})`);
  const inBody = new Uint8Array(n * n);
  bodies[0].indices.forEach((k) => (inBody[k] = 1));
  const count = (kd: number) => {
    let total = 0;
    let wet = 0;
    for (let k = 0; k < n * n; k++) {
      if (kind[k] !== kd) continue;
      total++;
      wet += inBody[k];
    }
    return { total, wet };
  };
  const ridge = count(1);
  assert.equal(ridge.wet, ridge.total, `whole ridge joins the river (${ridge.wet}/${ridge.total})`);
  assert.equal(bodies[0].cells, bodies[0].indices.length);
  for (const [kd, what] of [
    [2, 'road causeway'],
    [3, 'island'],
    [4, 'spit'],
    [5, 'dam'],
    [6, 'embankment'],
  ] as const) {
    assert.equal(count(kd).wet, 0, `${what} kept`);
  }
  assert.ok(verdicts.some((v) => v.onRoad && !v.accepted), 'the road band was a candidate, kept for its road');
  // Opened cells carry the surface level of the water around them.
  const q = bodies[0].indices.findIndex((k) => kind[k] === 1);
  assert.ok(Math.abs(bodies[0].levels[q] - 101) < 1e-6);

  // Without road information the causeway band would open too: the road is what keeps it.
  const again = [body()];
  openWaterGaps(z, n, n, cell, again);
  const inAgain = new Uint8Array(n * n);
  again[0].indices.forEach((k) => (inAgain[k] = 1));
  let causewayOpened = 0;
  for (let k = 0; k < n * n; k++) if (kind[k] === 2 && inAgain[k]) causewayOpened++;
  assert.ok(causewayOpened > 0);
});

test('live areas: after opening, the burned channel is continuous — water filled on one side reaches the other', () => {
  const { n, cell, z, road, kind, body } = crossedRiver();
  const fillFromWest = (bodies: WaterBody[]) => {
    const burned = burnWaterBodies(z, n, n, bodies, 3, 2);
    // One seed west of the ridge only.
    const h = computeInitialWater({ nx: n, ny: n, elevation: burned.elevation }, { initialFill: [{ seeds: [{ gx: 10.5, gy: 100.5, level: 101 }], level: 101 }] });
    return { h, elev: burned.elevation };
  };
  const closed = fillFromWest([body()]);
  assert.equal(closed.h[100 * n + 70], 0, 'without opening, the ridge dams the river');
  const bodies = [body()];
  openWaterGaps(z, n, n, cell, bodies, { roads: road });
  const open = fillFromWest(bodies);
  assert.ok(open.h[100 * n + 70] > 2.9, 'east of the ridge filled through the opened band');
  let maxBed = -Infinity;
  for (let k = 0; k < n * n; k++) {
    const j = (k / n) | 0;
    if (kind[k] === 1 && j >= 64 && j < 136) maxBed = Math.max(maxBed, open.elev[k]);
  }
  assert.ok(maxBed <= 101 - 2.9, `ridge carved to the river bed (highest ${maxBed.toFixed(2)} m)`);
  assert.equal(open.h[100 * n + 79], 0, 'the causeway still holds (road band kept)');
});
