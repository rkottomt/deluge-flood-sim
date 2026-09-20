/// <reference types="node" />
/**
 * Baked preset validation (public/presets/<id>/) and the procedural sandbox:
 *   • meta.json schema, grid/bounds consistency, file sizes (nx·ny·4 bytes of finite elevations), JPEG size
 *   • sources inside the domain and sitting on water that starts full; stage sources at the pool level
 *   • shelters on real high ground (above the maximum stage) and on the road network
 *   • initial water stays in the channels; roads.json decodes into a valid graph
 *   • the real loader (fetch → decode) works against a local HTTP server
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { RoadNetwork, ScenarioPreset, TerrainData, WaterSource } from '../../src/contracts';
import { type DomainEdge, edgeCell, edgeRuns, STAGE_DISC_MAX_PENETRATION } from '../../src/data/hydro';
import { cellSizeFor } from '../../src/data/geo';
import { detailMetersPerTexel, DETAIL_TARGET_MPT, isValidDetailRect } from '../../src/data/imagery';
import { computeInitialWater } from '../../src/data/initialWater';
import { listPresets, loadPreset } from '../../src/data/index';
import { decodeElevation, type PresetMeta, setPresetBaseUrl, validatePresetMeta } from '../../src/data/presets';
import { type CompactRoads, decodeRoads } from '../../src/data/roads';
import { generateSandbox } from '../../src/data/sandbox';

const ROOT = path.resolve(import.meta.dirname, '../../public/presets');
const FT = 0.3048;
/*
 * The US presets: 3DEP lidar elevation, NAIP imagery, TIGER roads.
 */
const BAKED_US = ['pittsburgh', 'johnstown', 'ellicott', 'asheville', 'nashville', 'houston', 'boulder', 'ftmyers'];
/*
 * Presets baked from the global data path (src/data/demGlobal.ts): Copernicus GLO-30 elevation put through the
 * DSM → bare-earth filter, OSM roads, and NO baked photo — there is no worldwide orthoimagery this repo may
 * redistribute (public/presets/SOURCES.txt). They go through every structural check below; only the
 * imagery-and-agency assertions differ, and `isGlobal` marks where.
 */
const BAKED_GLOBAL = ['nepal'];
const BAKED = [...BAKED_US, ...BAKED_GLOBAL];
const isGlobal = (id: string) => BAKED_GLOBAL.includes(id);
/*
 * public/presets is served from a public static host, so the whole directory has a size budget (MB).
 *
 * Raised 90 -> 120 when the eighth preset (ftmyers, 9.5 MB) took the directory to 97.2 MB. The reasoning, since
 * "the folder is getting big" is not one:
 *
 *   • A VISITOR NEVER PAYS THIS NUMBER. Presets load one at a time, so what a visitor downloads is bounded by the
 *     LARGEST SINGLE preset (asheville, 15.8 MB), not by the total. That is what PRESET_BUDGET_MB below guards, and
 *     it is the cap that protects the demo. The directory total is a host-and-repo cost, not a user-facing one.
 *   • THE HOST HAS ROOM. GitHub Pages (.github/workflows/pages.yml) publishes sites up to 1 GB and recommends the
 *     source repository stay under 1 GB, with a soft 100 GB/month of bandwidth
 *     (docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits, read 2026-09-19). At 120 MB
 *     the published site is 12 % of the limit and the largest single file is 6.2 MB.
 *   • THE REPO COST IS REAL AND IS THE REASON FOR A CAP AT ALL. These are JPEG and Float32 blobs: they do not
 *     delta-compress, so every preset costs about its own size again in git history forever. The worktree is 189 MB
 *     and .git is 132 MB today. 120 MB is the point where a clone is still a minute on venue wifi.
 *
 * What 120 MB buys over 97.2 MB: one more full preset (~10 MB — the Nepal/Betrawati domain is the next one queued)
 * plus room to restore ONE of the two insets that were dropped for space (Nashville's is already exported and cached
 * in artifacts/bake-cache, 3.80 MB; Fort Myers qualifies on the texel-density rule at 1.95 m/texel). It is NOT room
 * for both a second Nepal preset and the insets — the next bake after Nepal needs this argument made again.
 *
 * If it ever has to come down instead of up, the lever is the close-up insets: the failure message below names the
 * per-preset inset sizes and the largest one to drop.
 */
const PRESETS_BUDGET_MB = 120;

interface Loaded {
  meta: PresetMeta;
  elevation: Float32Array;
  roads: RoadNetwork;
  /** null on a global preset, which ships hypsometric relief instead of a photo. */
  jpg: Buffer | null;
  h0: Float32Array;
}
const cache = new Map<string, Loaded>();
function load(id: string): Loaded {
  const hit = cache.get(id);
  if (hit) return hit;
  const dir = path.join(ROOT, id);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as PresetMeta;
  const buf = fs.readFileSync(path.join(dir, meta.files.elevation));
  const elevation = decodeElevation(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, meta.nx, meta.ny);
  const roads = decodeRoads(JSON.parse(fs.readFileSync(path.join(dir, meta.files.roads!), 'utf8')) as CompactRoads);
  const jpg = meta.files.imagery ? fs.readFileSync(path.join(dir, meta.files.imagery)) : null;
  const h0 = computeInitialWater({ nx: meta.nx, ny: meta.ny, elevation }, meta.scenario);
  const l = { meta, elevation, roads, jpg, h0 };
  cache.set(id, l);
  return l;
}

/** JPEG dimensions from the first SOFn marker. */
function jpegSize(b: Buffer): { width: number; height: number } {
  assert.equal(b.readUInt16BE(0), 0xffd8, 'JPEG SOI');
  let p = 2;
  while (p < b.length) {
    const marker = b.readUInt16BE(p);
    const len = b.readUInt16BE(p + 2);
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) {
      return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
    }
    p += 2 + len;
  }
  throw new Error('no SOF marker');
}

const elevAt = (e: Float32Array, nx: number, gx: number, gy: number) => e[Math.floor(gy) * nx + Math.floor(gx)];

/**
 * A stage source is a boundary condition at a water body's edge crossing: its disc must reach the domain edge and
 * cover a full crossing, EVERY wet cell of each crossing it touches must get full footprint weight (otherwise the
 * open boundary drains the uncovered part), and — given the slider's ceiling — the covered stretch of edge must
 * extend until the bed rises above that ceiling, so overbank water at the top of the slider isn't drained beside
 * the disc. It must not reach far into the domain either.
 */
function checkStageBoundary(
  label: string,
  src: WaterSource & { type: 'stage' },
  nx: number,
  ny: number,
  h0: Float32Array,
  elevation: Float32Array,
  ceiling: number | null,
) {
  const R = src.radius - 0.5; // full-weight radius (smooth one-cell rim)
  const edges: Array<{ edge: DomainEdge; dist: number }> = [
    { edge: 'north', dist: src.gy },
    { edge: 'south', dist: ny - src.gy },
    { edge: 'west', dist: src.gx },
    { edge: 'east', dist: nx - src.gx },
  ];
  // Signed distance from the nearest edge (negative: centre outside the domain); the disc reaches R + dist cells in.
  const { edge, dist } = edges.sort((a, b) => a.dist - b.dist)[0];
  assert.ok(Math.abs(dist) < R, `${label}: stage source ${src.id} does not reach the ${edge} edge`);
  const reach = src.radius + dist;
  assert.ok(reach <= STAGE_DISC_MAX_PENETRATION + 2, `${label}: stage source ${src.id} reaches ${reach.toFixed(1)} cells into the domain`);
  const len = edge === 'north' || edge === 'south' ? nx : ny;
  const covered = (t: number) => {
    const k = edgeCell(edge, t, nx, ny);
    return Math.hypot((k % nx) + 0.5 - src.gx, Math.floor(k / nx) + 0.5 - src.gy) <= R;
  };
  const runs = edgeRuns(edge, nx, ny, (k) => h0[k] > 0.01).filter(([t0, t1]) => {
    for (let t = t0; t <= t1; t++) if (covered(t)) return true;
    return false;
  });
  const full = runs.some(([t0, t1]) => {
    for (let t = t0; t <= t1; t++) if (h0[edgeCell(edge, t, nx, ny)] > 0.5) return true;
    return false;
  });
  assert.ok(full, `${label}: stage source ${src.id} does not cover a full edge crossing`);
  for (const [t0, t1] of runs) {
    for (let t = t0; t <= t1; t++) assert.ok(covered(t), `${label}: stage source ${src.id} misses wet edge cell ${t} of crossing ${t0}..${t1}`);
  }
  // The disc must not cover land below the stage level that is dry at load (it would be filled at load).
  let drowned = 0;
  const r = Math.ceil(src.radius);
  for (let j = Math.max(0, Math.floor(src.gy - r)); j < Math.min(ny, Math.ceil(src.gy + r)); j++) {
    for (let i = Math.max(0, Math.floor(src.gx - r)); i < Math.min(nx, Math.ceil(src.gx + r)); i++) {
      const k = j * nx + i;
      if (Math.hypot(i + 0.5 - src.gx, j + 0.5 - src.gy) <= src.radius && h0[k] <= 0.01 && elevation[k] < src.level) drowned++;
    }
  }
  assert.equal(drowned, 0, `${label}: stage source ${src.id} covers ${drowned} dry cells below its level`);
  if (ceiling === null) return;
  /*
   * OPEN-WATER (sea) DISCS ARE EXEMPT FROM THE CEILING RULE, DELIBERATELY.
   *
   * A river crossing grows to the top of the slider because a river valley has walls that stop the growth. A tidal
   * domain does not: Fort Myers is flat and most of it sits below the surge ceiling, so growing to that ceiling runs
   * away along the whole edge, and a stage disc reaches inland as a lens — it would pin the surge level over dry
   * neighbourhoods far from the water and the flood would appear everywhere at once instead of advancing inland as a
   * front. seaBoundaryDiscs therefore grows only to MEAN HIGHER HIGH WATER (src/data/hydro.ts), and the cells between
   * MHHW and the surge ceiling stay on the open boundary.
   *
   * That is not free, and the cost was MEASURED rather than assumed (artifacts/global-verify/edge-probe2.js, ftmyers
   * at the 12.92 ft record surge, level 2.292 m NAVD88, after 30 sim-minutes): along the uncovered stretch of the
   * north edge the surface sits 0.2-0.4 m low in the edge row (worst single cell 0.88 m low at i=470) and within
   * 0.11 m of level 24 cells (190 m) in, with mass error 3.5e-8. So it is a thin drawdown band hugging the open
   * boundary, not a waterfall, and it is behind the scenario camera. The honest reading is that the flood really does
   * continue past the edge of the domain there.
   *
   * Every other assertion above still applies to sea discs — full crossing coverage, no dry below-level cells
   * drowned at load, penetration limit — so this exempts one rule, not the check.
   */
  if (src.id.startsWith('sea-')) return;
  // The covered stretch ends where the bed clears the slider's ceiling (or at a corner).
  let a = len;
  let b = -1;
  for (let t = 0; t < len; t++) {
    if (!covered(t)) continue;
    a = Math.min(a, t);
    b = Math.max(b, t);
  }
  for (const t of [a - 1, b + 1]) {
    if (t < 0 || t >= len) continue;
    const k = edgeCell(edge, t, nx, ny);
    // (or the widening stopped short so the disc stays off land below the level — see edgeStageDiscAvoiding)
    assert.ok(
      elevation[k] >= ceiling || (h0[k] <= 0.01 && elevation[k] < src.level) || stoppedShort(src, edge, t, nx, ny, h0, elevation),
      `${label}: stage source ${src.id} stops at edge cell ${t} (bed ${elevation[k].toFixed(1)} m) below the stage ceiling ${ceiling.toFixed(1)} m`,
    );
  }
}

/** Would covering edge cell t (widening the disc one more cell) put land below the level that is dry at load inside? */
function stoppedShort(src: WaterSource & { type: 'stage' }, edge: DomainEdge, t: number, nx: number, ny: number, h0: Float32Array, elevation: Float32Array): boolean {
  // Any dry below-level cell within the penetration depth of the edge near t means the lens could not grow there.
  const k0 = edgeCell(edge, t, nx, ny);
  const i0 = k0 % nx;
  const j0 = Math.floor(k0 / nx);
  const P = STAGE_DISC_MAX_PENETRATION + 2;
  for (let dj = -P; dj <= P; dj++) {
    for (let di = -P; di <= P; di++) {
      const i = i0 + di;
      const j = j0 + dj;
      if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
      const k = j * nx + i;
      if (h0[k] <= 0.01 && elevation[k] < src.level) return true;
    }
  }
  return false;
}

/**
 * Lowest bed within `r` cells of (gx, gy) — the local low a shelter has to stand above when nothing in the domain
 * is wet to measure against.
 */
function lowestNear(elevation: Float32Array, nx: number, ny: number, gx: number, gy: number, r: number): number {
  let lo = Infinity;
  const i0 = Math.floor(gx);
  const j0 = Math.floor(gy);
  for (let j = Math.max(0, j0 - r); j <= Math.min(ny - 1, j0 + r); j++) {
    for (let i = Math.max(0, i0 - r); i <= Math.min(nx - 1, i0 + r); i++) lo = Math.min(lo, elevation[j * nx + i]);
  }
  return lo;
}

/**
 * `dryStart`: the preset deliberately starts with every channel empty (see the nepal test below for why). The
 * invariants that reference the initial water surface have no reference then, so they are replaced rather than
 * skipped — an inflow must still sit in a channel at the domain edge, and a shelter must still be local high ground.
 */
function checkScenario(
  label: string,
  t: Pick<TerrainData, 'nx' | 'ny' | 'cellSize' | 'elevation'> & { roads: RoadNetwork | null },
  s: ScenarioPreset,
  h0: Float32Array,
  opts: { dryStart?: boolean } = {},
) {
  const { nx, ny, elevation } = t;
  const dry = opts.dryStart === true;
  // Sources: on water that starts full, with most of the footprint wet.
  for (const src of s.sources) {
    if (src.type === 'stage') {
      checkStageBoundary(label, src, nx, ny, h0, elevation, s.stage ? src.level + s.stage.maxOffset : null);
      if (s.stage) {
        assert.ok(Math.abs(src.level - s.stage.normalLevel) < 0.6, `${label}: stage source ${src.id} level ${src.level} vs normal ${s.stage.normalLevel}`);
      }
      continue;
    }
    const k = Math.floor(src.gy) * nx + Math.floor(src.gx);
    if (dry) {
      /*
       * Nothing is wet to land on, so the geometry has to carry the check: the inflow must sit in the burned channel
       * (its bed below the banks on both sides, measured across the valley) and within a few cells of the domain
       * edge, which is what makes it a boundary condition rather than water appearing inside the model.
       */
      const edgeDist = Math.min(src.gx, nx - src.gx, src.gy, ny - src.gy);
      assert.ok(edgeDist < 16, `${label}: dry-start inflow ${src.id} is ${edgeDist.toFixed(0)} cells from the domain edge`);
      const R = Math.max(8, Math.ceil(src.radius) * 2);
      const bed = elevation[k];
      const i0 = Math.floor(src.gx);
      const j0 = Math.floor(src.gy);
      const left = i0 - R >= 0 ? elevation[j0 * nx + (i0 - R)] : Infinity;
      const right = i0 + R < nx ? elevation[j0 * nx + (i0 + R)] : Infinity;
      assert.ok(Math.min(left, right) > bed + 1, `${label}: inflow ${src.id} at ${bed.toFixed(1)} m is not in a channel (banks ${left.toFixed(1)}/${right.toFixed(1)} m)`);
      /*
       * On the channel floor, within a metre of the thalweg: findRiverEnds places an inflow at the WIDEST cell that
       * fits its footprint rather than the deepest, so the centre can sit a few decimetres above the lowest burned
       * cell beside it (here 722.1 m against 721.3 m, in a channel burned 4 m deep). A metre of slack accepts that
       * and still fails a footprint that has climbed onto a shelf or a bank.
       */
      const floor = lowestNear(elevation, nx, ny, src.gx, src.gy, Math.ceil(src.radius));
      assert.ok(bed <= floor + 1, `${label}: inflow ${src.id} bed ${bed.toFixed(1)} m is ${(bed - floor).toFixed(1)} m above the channel floor beside it`);
      /*
       * And the channel must fall AWAY from it into the domain. This is the check that matters for a dry start: with
       * no water to show the way, an inflow on a reverse slope would pond at the boundary instead of running down the
       * valley, and nothing else here would notice.
       */
      const inward = edgeDist === src.gy ? [0, 1] : edgeDist === ny - src.gy ? [0, -1] : edgeDist === src.gx ? [1, 0] : [-1, 0];
      const downstream = lowestNear(elevation, nx, ny, src.gx + inward[0] * 64, src.gy + inward[1] * 64, 16);
      assert.ok(downstream < bed - 1, `${label}: inflow ${src.id} at ${bed.toFixed(1)} m does not drain inward (bed ${downstream.toFixed(1)} m, 64 cells in)`);
      continue;
    }
    assert.ok(h0[k] > 0.5, `${label}: source ${src.id} center depth ${h0[k].toFixed(2)} m — not on a full river`);
    let cells = 0;
    let wet = 0;
    let hollow = 0;
    const r = Math.ceil(src.radius);
    const surface = elevation[k] + h0[k];
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (di * di + dj * dj > src.radius * src.radius) continue;
        const m = (Math.floor(src.gy) + dj) * nx + Math.floor(src.gx) + di;
        cells++;
        if (h0[m] > 0.05) wet++;
        // A dry cell inside the footprint must be BANK — bed at or above the channel's water surface — so the
        // water injected onto it runs down into the channel. A dry cell BELOW the surface is a hollow the
        // inflow would quietly fill and hold.
        else if (elevation[m] < surface - 0.05) hollow++;
      }
    }
    assert.equal(hollow, 0, `${label}: source ${src.id} footprint covers ${hollow} dry cells below the channel surface`);
    /*
     * An inflow may overlap a narrow channel's banks (the injected water simply drains into the channel), and the
     * bake floors every inflow footprint at 4 cells of radius so a large discharge is never a point source. Where
     * the channel is narrower than that floor — Buffalo Bayou is ~26 m wide at Houston's west edge and the
     * Swannanoa ~30 m at Asheville's east edge, against a 4-cell (31–62 m) disc — most of the disc is necessarily
     * bank, so the wet fraction says nothing. What matters there is the `hollow` check above plus the centre being
     * on a full channel, both asserted; the 70 % rule applies only where the channel can actually fill the disc.
     */
    const channelWide = h0[k] > 0.05 && wet >= 2 * src.radius * 2 * src.radius * 0.5;
    if (channelWide) assert.ok(wet >= cells * 0.7, `${label}: source ${src.id} footprint only ${wet}/${cells} wet`);
    else assert.ok(wet >= cells * 0.3, `${label}: source ${src.id} footprint only ${wet}/${cells} wet, even for a narrow channel`);
  }
  // Initial water is confined: small fraction of the domain and depths that match a burned channel.
  let wet = 0;
  let maxDepth = 0;
  for (let k = 0; k < h0.length; k++) {
    if (h0[k] > 0.01) wet++;
    maxDepth = Math.max(maxDepth, h0[k]);
  }
  if (dry) assert.equal(wet, 0, `${label}: a dry-start preset must start with no water at all`);
  else assert.ok(wet > 0, `${label}: rivers start empty`);
  /*
   * "Confined" means different things for a river and for an estuary. A river domain that starts with more than
   * 15 % of its cells wet has almost certainly leaked its fill out over the floodplain — that is the bake bug this
   * catches. An open-water domain has not: Fort Myers' Caloosahatchee is two kilometres wide and genuinely covers a
   * third of its domain at rest (346,060 of 1,048,576 cells, and the bake records the same number in
   * meta.bake.initialWetCells, which is checked against the decoded fill above). The looser cap still catches a
   * runaway fill, because a runaway on this terrain floods the tidal flat too and goes well past half.
   */
  const openWater = s.sources.some((src) => src.id.startsWith('sea-'));
  const wetCap = openWater ? 0.45 : 0.15;
  assert.ok(
    wet < nx * ny * wetCap,
    `${label}: initial water covers ${((100 * wet) / (nx * ny)).toFixed(1)} % of the domain (cap ${(100 * wetCap).toFixed(0)} %)`,
  );
  assert.ok(maxDepth < 20, `${label}: initial max depth ${maxDepth}`);
  // Every wet cell's bed is below the highest fill level (fill.level or a seed's own level).
  let maxLevel = -Infinity;
  for (const f of s.initialFill) {
    maxLevel = Math.max(maxLevel, f.level);
    for (const sd of f.seeds as Array<{ level?: number }>) if (typeof sd.level === 'number') maxLevel = Math.max(maxLevel, sd.level);
  }
  for (let k = 0; k < h0.length; k++) {
    if (h0[k] > 0.01) assert.ok(elevation[k] < maxLevel, `${label}: water on a bed above every fill level`);
  }
  if (s.stage && s.initialFill.every((f) => f.seeds.every((sd) => typeof (sd as { level?: number }).level !== 'number'))) {
    // Flat pool presets: nothing wet above the pool.
    for (let k = 0; k < h0.length; k++) if (h0[k] > 0.01) assert.ok(elevation[k] < s.stage.normalLevel + 0.01, `${label}: wet cell above the pool`);
  }

  // Shelters: dry, high, and on (or next to) the road network.
  const ceiling = s.stage ? s.stage.normalLevel + s.stage.maxOffset : null;
  for (const sh of s.shelters) {
    const z = elevAt(elevation, nx, sh.gx, sh.gy);
    assert.equal(h0[Math.floor(sh.gy) * nx + Math.floor(sh.gx)], 0, `${label}: shelter ${sh.name} starts wet`);
    if (ceiling !== null) assert.ok(z > ceiling + 2, `${label}: shelter ${sh.name} at ${z.toFixed(1)} m is not above max stage ${ceiling.toFixed(1)} m`);
    else if (dry) {
      // No water yet: high ground means high RELATIVE TO ITS OWN VALLEY, which is the useful sense anyway. 256 cells
      // is 2 km here, so the comparison is against the valley floor beside the shelter, not the far end of an 8 km
      // domain that falls 167 m end to end.
      const lo = lowestNear(elevation, nx, ny, sh.gx, sh.gy, 256);
      assert.ok(z > lo + 10, `${label}: shelter ${sh.name} at ${z.toFixed(1)} m is only ${(z - lo).toFixed(1)} m above its valley floor`);
    } else {
      // No stage control: well above the lowest water surface in the domain.
      let minWater = Infinity;
      for (let k = 0; k < h0.length; k++) if (h0[k] > 0.01) minWater = Math.min(minWater, elevation[k] + h0[k]);
      assert.ok(z > minWater + 10, `${label}: shelter ${sh.name} at ${z.toFixed(1)} m is low ground`);
    }
    if (t.roads) {
      let best = Infinity;
      for (let q = 0; q < t.roads.nodes.length; q += 2) best = Math.min(best, Math.hypot(t.roads.nodes[q] - sh.gx, t.roads.nodes[q + 1] - sh.gy));
      assert.ok(best * t.cellSize < 40, `${label}: shelter ${sh.name} is ${(best * t.cellSize).toFixed(0)} m from a road node`);
    }
  }
  for (const st of s.storms) assert.ok(st.intensity > 0 && st.radius > 0);
  if (s.camera) {
    const zc = elevAt(elevation, nx, s.camera.target.gx, s.camera.target.gy);
    assert.ok(Math.abs(zc - s.camera.target.elevation) < 40, `${label}: camera target elevation ${s.camera.target.elevation} vs ground ${zc}`);
  }
  if (t.roads) {
    const nn = t.roads.nodes.length / 2;
    for (const e of t.roads.edges) {
      assert.ok(e.a >= 0 && e.a < nn && e.b >= 0 && e.b < nn && e.length > 0);
      for (let q = 0; q < e.pts.length; q += 2) {
        assert.ok(e.pts[q] >= -0.1 && e.pts[q] <= nx + 0.1 && e.pts[q + 1] >= -0.1 && e.pts[q + 1] <= ny + 0.1, `${label}: road outside the domain`);
      }
    }
  }
}

for (const id of BAKED) {
  const present = fs.existsSync(path.join(ROOT, id, 'meta.json'));
  test(`baked preset "${id}": files, schema and grid`, { skip: !present && 'not baked' }, () => {
    const { meta, elevation, jpg } = load(id);
    assert.deepEqual(validatePresetMeta(meta), []);
    assert.equal(meta.id, id);
    assert.equal(meta.nx % 16, 0);
    assert.equal(meta.ny % 16, 0);
    const bytes = fs.statSync(path.join(ROOT, id, meta.files.elevation)).size;
    assert.equal(bytes, meta.nx * meta.ny * 4, 'nx·ny == file size / 4');
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of elevation) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    /*
     * Boulder reaches 2,478 m on Green Mountain; Houston's burned bayou bed goes just below sea level. The relief
     * floor is only here to catch a DEM that came back flat or constant — it is not a claim that every domain is
     * hilly. Fort Myers is a tidal flat and spans 17.3 m, from the burned estuary bed (-4.3 m) to the highest ground
     * in east Fort Myers (13.0 m); a real bake that failed would be near zero, not 17.
     */
    assert.ok(lo > -100 && hi < 4500 && hi - lo > 15, `elevation range ${lo}…${hi}`);
    assert.ok(Math.abs(cellSizeFor(meta.bounds, meta.nx) / meta.cellSize - 1) < 2e-3, 'cellSize matches bounds');
    if (isGlobal(id)) {
      /*
       * A global preset has no baked photo on purpose: Sentinel-2 L2A would be redistributable but is not composed
       * here, and the cloudless mosaics that would be easy (EOX s2cloudless 2018+) are CC BY-NC-SA. Rather than
       * leave that unstated, meta.files.imagery is null, the attribution says which shading the app is showing,
       * and the elevation credits Copernicus and admits the bare-earth filtering.
       */
      assert.equal(meta.files.imagery, null, 'no baked photo');
      assert.equal(jpg, null);
      assert.match(meta.attribution, /Copernicus DEM GLO-30/);
      assert.match(meta.attribution, /bare-earth filtered/);
      assert.match(meta.attribution, /no aerial imagery/);
      assert.match(meta.attribution, /OpenStreetMap contributors \(ODbL\)/);
      assert.doesNotMatch(meta.attribution, /USGS 3DEP|USDA NAIP/, 'no US agency credited on a global domain');
      // The surface-model caveat is not allowed to live only in a doc: it has to be on screen with the scenario.
      assert.match(meta.scenario.description, /surface model/);
    } else {
      const size = jpegSize(jpg!);
      // 4096² (the Esri export limit): ≤ 2 m per texel on every preset, sharp at close camera distances.
      assert.equal(size.width, 4096);
      assert.equal(size.height, 4096);
      assert.ok((meta.nx * meta.cellSize) / size.width <= 2, 'imagery ≤ 2 m per texel');
      assert.match(meta.attribution, /USGS 3DEP/);
      // Committed imagery must be redistributable: USDA NAIP (public domain), not Esri exports.
      assert.match(meta.attribution, /USDA NAIP/);
    }
    assert.doesNotMatch(meta.attribution, /Esri/);
    assert.ok(meta.scenario.description.length > 200);
    const info = listPresets().find((p) => p.id === id);
    assert.ok(info && info.name === meta.name);
  });

  test(`baked preset "${id}": sources on full rivers, shelters on high ground, confined initial water`, { skip: !present && 'not baked' }, () => {
    const { meta, elevation, roads, h0 } = load(id);
    const dryStart = meta.scenario.initialFill.length === 0;
    checkScenario(id, { nx: meta.nx, ny: meta.ny, cellSize: meta.cellSize, elevation, roads }, meta.scenario, h0, { dryStart });
    const wet = h0.reduce((a, v) => a + (v > 0.01 ? 1 : 0), 0);
    const baked = meta.bake?.initialWetCells;
    if (typeof baked === 'number') assert.ok(Math.abs(wet - baked) <= baked * 0.01, `wet cells ${wet} vs baked ${baked}`);
    /*
     * A floor on "the road parse really ran", not a target. 8 km of the Trishuli valley holds 202 km of road in 464
     * edges — the Pasang Lhamu Highway and village lanes, drawn as long polylines — against >500 edges in any of the
     * US city domains, so the rural floor is lower on purpose.
     */
    assert.ok(roads.edges.length > (isGlobal(id) ? 300 : 500), `real road network (${roads.edges.length} edges)`);
  });
}

test('meta.json validation rejects a detail photo without a usable rectangle', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'pittsburgh/meta.json'), 'utf8')) as PresetMeta;
  const bad = (rect: unknown): string[] =>
    validatePresetMeta({ ...base, files: { ...base.files, imageryDetail: 'imagery-detail.jpg' }, imageryDetail: rect as never });
  assert.deepEqual(bad(null), ['files.imageryDetail without a valid imageryDetail rectangle']);
  assert.deepEqual(bad({ x0: 0, y0: 0, x1: base.nx + 8, y1: 10 }), ['files.imageryDetail without a valid imageryDetail rectangle']);
  assert.deepEqual(bad({ x0: 10.5, y0: 0, x1: 100, y1: 100 }), ['files.imageryDetail without a valid imageryDetail rectangle']);
  assert.deepEqual(validatePresetMeta({ ...base, files: { ...base.files, imageryDetail: null }, imageryDetail: null }), [], 'no inset is fine');
});

/*
 * The close-up imagery inset (src/data/imagery.ts): a second, finer photo over part of the grid. It is optional, so
 * this checks whatever is baked — that it is registered to whole cells inside the grid, that it actually resolves
 * meaningfully finer than the base photo (otherwise it is only bytes), and that it stays inside the deploy budget.
 */
for (const id of BAKED) {
  const dir = path.join(ROOT, id);
  const present = fs.existsSync(path.join(dir, 'meta.json'));
  test(`baked preset "${id}": detail imagery inset`, { skip: !present && 'not baked' }, () => {
    const { meta } = load(id);
    const file = meta.files.imageryDetail;
    if (!file) {
      assert.equal(meta.imageryDetail ?? null, null, 'a rectangle without a photo would blend a placeholder');
      return;
    }
    const rect = meta.imageryDetail!;
    assert.ok(isValidDetailRect(rect, meta.nx, meta.ny), `rectangle ${JSON.stringify(rect)} fits the grid`);
    assert.equal(rect.x1 - rect.x0, rect.y1 - rect.y0, 'square');
    const jpgDetail = fs.readFileSync(path.join(dir, file));
    const size = jpegSize(jpgDetail);
    assert.equal(size.width, size.height);
    const mpt = detailMetersPerTexel(rect, meta.cellSize, size.width);
    const base = (meta.nx * meta.cellSize) / jpegSize(load(id).jpg!).width;
    assert.ok(base / mpt >= 1.5, `inset resolves ${(base / mpt).toFixed(2)}x finer than the base photo`);
    // NAIP stops adding detail below ~1 m per texel (artifacts/detail-imagery), so a finer inset is wasted bytes.
    assert.ok(mpt >= DETAIL_TARGET_MPT * 0.7, `${mpt.toFixed(3)} m/texel is not wastefully fine`);
    // The inset must cover where the scenario actually looks.
    const cam = meta.scenario.camera;
    if (cam) {
      assert.ok(cam.target.gx >= rect.x0 && cam.target.gx <= rect.x1 && cam.target.gy >= rect.y0 && cam.target.gy <= rect.y1,
        'the scenario camera target is inside the inset');
    }
  });

  test(`baked preset "${id}": deploy size`, { skip: !present && 'not baked' }, () => {
    const total = fs.readdirSync(dir).reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0);
    assert.ok(total < 25e6, `${id} ships ${(total / 1e6).toFixed(1)} MB`);
  });
}

test('pittsburgh: stage control matches the Point gauge story', { skip: !fs.existsSync(path.join(ROOT, 'pittsburgh/meta.json')) }, () => {
  const { meta } = load('pittsburgh');
  const st = meta.scenario.stage!;
  assert.ok(st, 'stage control');
  const normalFt = (st.normalLevel - st.gaugeDatum) / FT;
  assert.ok(normalFt > 13 && normalFt < 19, `normal pool reads ${normalFt.toFixed(1)} ft on the gauge`);
  // NWS PTTP1 categories: action 18, minor (flood stage) 22, moderate 25 (the Parkway "bathtub" closes), major 28 ft.
  assert.equal(st.floodStageFt, 22);
  assert.match(meta.scenario.description, /flood stage is 22 ft/);
  const record = st.marks!.find((m) => /1936/.test(m.label))!;
  assert.equal(record.ft, 46);
  const recordOffset = record.ft * FT + st.gaugeDatum - st.normalLevel;
  assert.ok(recordOffset > 0 && recordOffset < st.maxOffset, '1936 crest reachable with the slider');
  const stageSources = meta.scenario.sources.filter((s) => s.type === 'stage');
  assert.equal(stageSources.length, 3, 'Allegheny + Monongahela inflow edges and the Ohio outflow edge');
});

// ── The four 2024/2025 additions: each pins the published numbers its scenario claims, so a re-bake that
// drifts from the sources (or a description edited by hand) fails here rather than in front of judges.

test('asheville: Helene peaks on both rivers, sloping (no stage control)', { skip: !fs.existsSync(path.join(ROOT, 'asheville/meta.json')) }, () => {
  const { meta } = load('asheville');
  const s = meta.scenario;
  assert.equal(s.stage, null, 'a free-flowing mountain river has no navigation pool to slide');
  const fb = s.sources.find((x) => x.id === 'french-broad-inflow')!;
  const sw = s.sources.find((x) => x.id === 'swannanoa-inflow')!;
  assert.ok(fb && fb.type === 'inflow' && sw && sw.type === 'inflow', 'both rivers have inflows');
  // USGS annual peaks, 2024-09-27: 113,000 ft³/s (03451500) and 60,800 ft³/s (03451000).
  assert.equal(fb.type === 'inflow' && fb.discharge, Math.round(113_000 * 0.0283168));
  assert.equal(sw.type === 'inflow' && sw.discharge, Math.round(60_800 * 0.0283168));
  assert.match(s.description, /24\.82 ft/);
  assert.match(s.description, /113,000 ft³\/s/);
  assert.match(s.description, /27\.33 ft/);
  assert.match(s.description, /1916/);
  // The valley drains north: the French Broad's surface falls from the south edge to the north one.
  const rivers = (meta.bake?.rivers ?? []) as Array<{ name: string; surfaceMax: number; surfaceMin: number }>;
  const broad = rivers.find((r) => r.name === 'French Broad River')!;
  assert.ok(broad.surfaceMax - broad.surfaceMin > 5, `French Broad drops ${broad.surfaceMax - broad.surfaceMin} m`);
});

test('nashville: stage control matches the Cumberland gauge story', { skip: !fs.existsSync(path.join(ROOT, 'nashville/meta.json')) }, () => {
  const { meta } = load('nashville');
  const st = meta.scenario.stage!;
  assert.ok(st, 'stage control');
  // USGS 03431500 gage datum, 367.45 ft above NAVD88; NWS flood stage 40 ft.
  assert.ok(Math.abs(st.gaugeDatum - 367.45 * FT) < 0.01, `gauge datum ${st.gaugeDatum}`);
  assert.equal(st.floodStageFt, 40);
  assert.match(meta.scenario.description, /flood stage is 40 ft/);
  const normalFt = (st.normalLevel - st.gaugeDatum) / FT;
  assert.ok(normalFt > 10 && normalFt < st.floodStageFt, `pool reads ${normalFt.toFixed(1)} ft, below flood stage`);
  // Every historic mark must be reachable with the slider, and 2010 must be one of them.
  const crest2010 = st.marks!.find((m) => /2010/.test(m.label))!;
  assert.equal(crest2010.ft, 51.86);
  assert.equal(st.marks!.find((m) => /1927/.test(m.label))!.ft, 56.2);
  for (const m of st.marks!) {
    const offset = m.ft * FT + st.gaugeDatum - st.normalLevel;
    assert.ok(offset > 0 && offset <= st.maxOffset, `mark ${m.label} (${m.ft} ft) needs offset ${offset.toFixed(2)} of ${st.maxOffset}`);
  }
  // One river with a boundary at each end: two stage sources, distinct ids, sloping downstream.
  const stages = meta.scenario.sources.filter((x) => x.type === 'stage');
  assert.equal(stages.length, 2);
  assert.equal(new Set(stages.map((x) => x.id)).size, 2, 'stage source ids are unique');
  assert.ok(Math.max(...stages.map((x) => x.level)) > Math.min(...stages.map((x) => x.level)), 'a head drives the pool');
});

test('houston: rain-driven, with the bayou at its Harvey peak', { skip: !fs.existsSync(path.join(ROOT, 'houston/meta.json')) }, () => {
  const { meta, elevation } = load('houston');
  const s = meta.scenario;
  // NHC TCR AL092017: 6.8 in in one hour over southeast Houston = 173 mm/hr.
  assert.equal(s.rainRate, 173);
  const bayou = s.sources.find((x) => x.type === 'inflow')!;
  assert.equal(bayou.type === 'inflow' && bayou.discharge, Math.round(32_600 * 0.0283168));
  assert.match(s.description, /41\.90 ft/);
  assert.match(s.description, /32,600 ft³\/s/);
  assert.match(s.description, /6\.8 inches/);
  // The premise of the scenario: the bayou runs far below the streets, so the rain (not the bayou) floods the city.
  const zAt = (gx: number, gy: number) => elevation[Math.floor(gy) * meta.nx + Math.floor(gx)];
  const bed = zAt(bayou.gx, bayou.gy);
  const streets = s.shelters.map((sh) => zAt(sh.gx, sh.gy));
  assert.ok(Math.min(...streets) - bed > 8, `shelters only ${(Math.min(...streets) - bed).toFixed(1)} m above the bayou bed`);
});

test('boulder: the 2013 flood comes out of the canyon', { skip: !fs.existsSync(path.join(ROOT, 'boulder/meta.json')) }, () => {
  const { meta } = load('boulder');
  const s = meta.scenario;
  // USGS 06730200 annual peak, 2013-09-13: 8,400 ft³/s (previous record 2,050). NWS Boulder: 9.08 in on Sept 12.
  const creek = s.sources.find((x) => x.type === 'inflow')!;
  assert.equal(creek.type === 'inflow' && creek.discharge, Math.round(8400 * 0.0283168));
  assert.equal(s.rainRate, 9.6);
  assert.match(s.description, /8,400 ft³\/s/);
  assert.match(s.description, /2,050 ft³\/s/);
  assert.match(s.description, /9\.08 inches/);
  assert.match(s.description, /17\.15 inches/);
  // The inflow enters high in the canyon at the west edge and the creek falls right across the domain.
  const rivers = (meta.bake?.rivers ?? []) as Array<{ name: string; surfaceMax: number; surfaceMin: number }>;
  const bc = rivers.find((r) => r.name === 'Boulder Creek')!;
  assert.ok(bc.surfaceMax - bc.surfaceMin > 80, `Boulder Creek drops ${bc.surfaceMax - bc.surfaceMin} m`);
  assert.ok(creek.gx < 40, `inflow at gx ${creek.gx} is not on the west (canyon) edge`);
});

/*
 * Nepal is the one preset built on a modelled hydrograph rather than a gauge record, because the gauges upstream were
 * destroyed — so this test is mostly about HONESTY, not hydraulics. Every number on screen has to be the published
 * one (DHM's 20 million m³, the Betrawati gauge's 3.55 m last reading and its 4.1/5.0 m thresholds), the inflow has to
 * be LABELLED a scenario, the surface-model and dry-start caveats have to be in the text a visitor reads, and no
 * casualty count may appear anywhere near simulation output.
 */
test('nepal: a labelled scenario hydrograph, sourced numbers, and the caveats on screen', { skip: !fs.existsSync(path.join(ROOT, 'nepal/meta.json')) }, () => {
  const { meta } = load('nepal');
  const s = meta.scenario;

  // 20 million m³ over 30 minutes = 11,111 m³/s, rounded to a hundred. Not presented as a peak anywhere.
  const surge = s.sources.find((x) => x.type === 'inflow')!;
  assert.equal(s.sources.length, 1, 'one forcing: the wave from upstream');
  assert.equal(surge.type === 'inflow' && surge.discharge, 11100);
  assert.equal(s.stage, null, 'a stage slider would raise the whole reach at once — the opposite of this event');
  assert.equal(s.rainRate, 0);
  assert.equal(s.storms.length, 0);
  // The label is what the UI puts beside the number, so the disclaimer has to live there and not only in prose.
  assert.match(surge.label!, /scenario/i);
  assert.match(surge.label!, /not a measured peak/);
  assert.match(surge.label!, /20 million m³ over 30 minutes/);

  // Published figures, exactly as published.
  assert.match(s.description, /20 million m³/);
  assert.match(s.description, /11,100 m³\/s/);
  assert.match(s.description, /3\.55 m/, 'the gauge\u2019s last reading');
  assert.match(s.description, /warning level 4\.1 m, danger level 5 m/);
  assert.match(s.description, /an average rather than a measured peak/);
  // Caveats a visitor must not have to dig for.
  assert.match(s.description, /surface model with canopy and buildings/);
  assert.match(s.description, /rivers start dry/);
  assert.match(s.description, /no aerial photograph/);
  assert.match(s.description, /do not read street-level depths/);
  // No casualty or missing-persons figure anywhere in what the app shows: this model cannot produce one.
  const shown = `${meta.name} ${meta.subtitle} ${s.description} ${s.sources.map((x) => x.label ?? '').join(' ')}`;
  assert.doesNotMatch(shown, /\b(dead|death|deaths|killed|casualt\w*|missing|bodies|swept away [0-9])/i, shown);

  // Two-tile Copernicus mosaic across 28° N — the reason this domain was chosen — and the filter's own numbers.
  const bake = meta.bake as { demSource?: string; demTiles?: string[]; bareEarth?: Record<string, number>; prefill?: string; initialWetCells?: number };
  assert.equal(bake.demSource, 'copernicus');
  assert.deepEqual(bake.demTiles, ['Copernicus_DSM_COG_10_N27_00_E085_00_DEM', 'Copernicus_DSM_COG_10_N28_00_E085_00_DEM']);
  assert.ok(meta.bounds.south < 28 && meta.bounds.north > 28, 'the domain straddles the tile seam');
  assert.ok(bake.bareEarth && bake.bareEarth.flaggedPercent > 0.5 && bake.bareEarth.flaggedPercent < 15, `filter flagged ${bake.bareEarth?.flaggedPercent} %`);
  // The dry start is a recorded decision, not an accident of the fill step.
  assert.equal(bake.prefill, 'none');
  assert.equal(bake.initialWetCells, 0);

  // The wave enters at the north edge and the valley falls away south: 167 m across the domain.
  assert.ok(surge.gy < 16, `inflow at gy ${surge.gy} is not on the north edge`);
  const rivers = (bake as { rivers?: Array<{ name: string; surfaceMax: number; surfaceMin: number }> }).rivers ?? [];
  const trishuli = rivers.find((r) => r.name === 'Trishuli')!;
  assert.ok(trishuli.surfaceMax - trishuli.surfaceMin > 150, `the Trishuli falls ${(trishuli.surfaceMax - trishuli.surfaceMin).toFixed(0)} m`);
  /*
   * Framing. The camera looks north up the Trishuli from above the Betrawati crossing, and both of these numbers are
   * load-bearing rather than decorative: a shallow pitch puts the camera behind the 900 m south ridge and shows a
   * hillside with no river in it, and a target on the crossing itself leaves the first half-minute of the demo empty
   * because the surge needs ~20 simulated minutes to travel the 5.9 km down to it. So: high enough to see into the
   * valley, and far enough up the reach that the water is in frame early, with the crossing still in shot.
   */
  assert.ok(s.camera, 'the framing is part of the story here');
  assert.ok(s.camera!.pitch >= 0.6, `pitch ${s.camera!.pitch} looks into the ridge, not into the valley`);
  assert.ok(s.camera!.distance >= 4000, `distance ${s.camera!.distance} m cannot hold both the inflow reach and the crossing`);
  const fromCrossing = Math.hypot(s.camera!.target.gx - 489, s.camera!.target.gy - 757) * meta.cellSize;
  assert.ok(fromCrossing < 1200, `camera target is ${fromCrossing.toFixed(0)} m from the Betrawati crossing`);
  assert.ok(s.camera!.target.gy < 757, 'the target sits upstream of the crossing, where the surge comes from');
  /*
   * Real named places on real high ground, each named for its own OSM node — and THREE of them, not four: the school
   * nearest the bazaar stands 31.3 m above the channel beside it against this preset's 33 m bar, so the bake refuses
   * it (scripts/bake-presets.ts). This count is asserted so that bar cannot be quietly lowered to get it back.
   */
  assert.equal(s.shelters.length, 3);
  for (const sh of s.shelters) assert.match(sh.name, /^(Shree|Kalika)/, sh.name);
  assert.doesNotMatch(s.shelters.map((sh) => sh.name).join(' '), /Neelkanta/);
});

test(`public/presets stays inside its ${PRESETS_BUDGET_MB} MB budget`, () => {
  /*
   * Two axes grow this directory independently — new city presets and close-up imagery insets — so when it goes
   * over, the message has to say WHICH files did it, or whoever reads the failure has to go measure by hand.
   */
  const sizeOf = (dir: string): number => {
    let total = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? sizeOf(p) : fs.statSync(p).size;
    }
    return total;
  };
  const rows = fs
    .readdirSync(ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(ROOT, e.name);
      const detail = path.join(dir, 'imagery-detail.jpg');
      const inset = fs.existsSync(detail) ? fs.statSync(detail).size : 0;
      return { id: e.name, total: sizeOf(dir), inset };
    })
    .sort((a, b) => b.total - a.total);
  const mb = (bytes: number) => (bytes / 1e6).toFixed(1);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const breakdown = rows.map((r) => `${r.id} ${mb(r.total)}${r.inset ? ` (inset ${mb(r.inset)})` : ''}`).join(', ');
  const insets = rows.reduce((n, r) => n + r.inset, 0);
  assert.ok(
    total / 1e6 < PRESETS_BUDGET_MB,
    `public/presets is ${mb(total)} MB (budget ${PRESETS_BUDGET_MB} MB) — ${breakdown}; ` +
      `close-up insets account for ${mb(insets)} MB of it, and dropping the largest would save ${mb(rows.reduce((n, r) => Math.max(n, r.inset), 0))} MB`,
  );
});

test('sandbox: valid scenario, connected roads, reachable high shelters', () => {
  const t = generateSandbox();
  const s = t.scenario!;
  const meta: PresetMeta = {
    version: 1,
    id: 'sandbox',
    name: t.name,
    subtitle: '',
    nx: t.nx,
    ny: t.ny,
    cellSize: t.cellSize,
    bounds: t.bounds,
    attribution: t.attribution,
    scenario: s,
    files: { elevation: '', imagery: null, roads: null },
  };
  assert.deepEqual(validatePresetMeta(meta), []);
  assert.ok(t.elevation.every(Number.isFinite));
  const h0 = computeInitialWater(t, s);
  checkScenario('sandbox', t, s, h0);
  // One connected road component containing every shelter.
  const net = t.roads!;
  const nn = net.nodes.length / 2;
  const parent = Int32Array.from({ length: nn }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const e of net.edges) parent[find(e.a)] = find(e.b);
  const roots = new Set(Array.from({ length: nn }, (_, k) => find(k)));
  assert.equal(roots.size, 1, `sandbox road graph has ${roots.size} components`);
  assert.ok(net.edges.length > 200);
  // Reservoir starts full behind the dam, river starts full.
  assert.ok(h0.reduce((m, v) => Math.max(m, v), 0) > 8, 'reservoir filled');
});

// ── Real loader over HTTP (fetch → validate → decode), as the browser does.
let server: http.Server | null = null;
before(async () => {
  server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent((req.url ?? '/').replace(/^\/presets\//, '').split('?')[0]));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const type = file.endsWith('.json') ? 'application/json' : file.endsWith('.jpg') ? 'image/jpeg' : 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  setPresetBaseUrl(`http://127.0.0.1:${(server!.address() as AddressInfo).port}/presets/`);
});
after(() => server?.close());

test('loadPreset fetches and decodes a baked preset with progress', { skip: !fs.existsSync(path.join(ROOT, 'johnstown/meta.json')) }, async () => {
  const progress: number[] = [];
  const t = await loadPreset('johnstown', (_m, f) => progress.push(f));
  assert.equal(t.nx * t.ny, t.elevation.length);
  assert.ok(t.roads && t.roads.edges.length > 0);
  assert.equal(t.imagery, null, 'no createImageBitmap in Node');
  assert.ok(t.scenario && t.scenario.sources.length > 0);
  assert.ok(progress.length >= 3 && progress[progress.length - 1] === 1);
  for (let q = 1; q < progress.length; q++) assert.ok(progress[q] >= progress[q - 1], 'progress is monotone');
  await assert.rejects(loadPreset('atlantis'), /Unknown preset/);
  const sb = await loadPreset('sandbox');
  assert.equal(sb.nx, 1024);
});
