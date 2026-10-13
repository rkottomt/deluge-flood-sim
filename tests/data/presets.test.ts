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
import { cellSizeFor, geoToGrid } from '../../src/data/geo';
import { BARE_EARTH_DEFAULTS } from '../../src/data/demGlobal';
import { detailMetersPerTexel, DETAIL_TARGET_MPT, isValidDetailRect } from '../../src/data/imagery';
import { computeInitialWater } from '../../src/data/initialWater';
import { listPresets, loadPreset } from '../../src/data/index';
import { decodeElevation, type PresetMeta, setPresetBaseUrl, validatePresetMeta } from '../../src/data/presets';
import { type CompactRoads, decodeRoads } from '../../src/data/roads';
import { generateSandbox } from '../../src/data/sandbox';
import { domainClockOffset, runChain, toWaterSource } from '../../src/hazard/chain';
import type { BakedChainResult, ChainFile } from '../../src/hazard/types';
import { clockAt, hydrographArea } from '../../scripts/bake-chain-result';
import { FLOOR_DEPTH, flatFaces, MIN_FLOOR_WIDTH } from '../../scripts/chain-profile';

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
const BAKED_GLOBAL = ['nepal', 'chungthang', 'chamoli'];
const BAKED = [...BAKED_US, ...BAKED_GLOBAL];
const isGlobal = (id: string) => BAKED_GLOBAL.includes(id);
/** Presets with a glacier-hazard valley profile (scripts/bake-chain.ts). */
const hasChain = (id: string) => fs.existsSync(path.join(ROOT, id, 'chain.json'));
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
 *
 * Raised 120 -> 125 for the eleventh preset (chamoli, 4.44 MB), which took the directory to 120.2 MB. Same three
 * arguments, re-measured rather than repeated:
 *   • the visitor's cost is the largest single preset, still asheville at 17.0 MB; a glacier preset is ~4.5 MB because
 *     it ships no photo — 4.19 MB of Float32 elevation and ~0.25 MB of JSON. There is nothing left in it to squeeze
 *     except the grid itself: 1024² is what the solver, the renderer and every other preset run at, and dropping
 *     chamoli to 960² (3.7 MB) to stay under 120 would have bought 0.5 MB of headroom for one preset's worth of
 *     inconsistency, and the NEXT preset would need this argument anyway.
 *   • the host limit is unchanged (1 GB); 125 MB is 12.5 % of it.
 *   • the repo cost is the reason a cap exists, and 5 MB is one glacier preset: this is NOT room for another
 *     US-style preset with a photo (~10–17 MB). The next one of those needs the insets argument above, or a
 *     deliberate raise of its own.
 */
const PRESETS_BUDGET_MB = 125;

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
      // The banks are ACROSS the channel, i.e. along the edge the inflow sits at: east–west for an inflow on the north or
      // south edge (Betrawati, Chungthang), north–south for one on the east or west edge (Chamoli's Rishiganga).
      const alongX = Math.min(src.gy, ny - src.gy) <= Math.min(src.gx, nx - src.gx);
      const bank = (d: number) => {
        const i = alongX ? i0 + d : i0;
        const j = alongX ? j0 : j0 + d;
        return i >= 0 && j >= 0 && i < nx && j < ny ? elevation[j * nx + i] : Infinity;
      };
      const left = bank(-R);
      const right = bank(R);
      assert.ok(Math.min(left, right) > bed + 1, `${label}: inflow ${src.id} at ${bed.toFixed(1)} m is not in a channel (banks ${left.toFixed(1)}/${right.toFixed(1)} m)`);
      /*
       * On the channel floor, within a metre of the thalweg: findRiverEnds places an inflow at the WIDEST cell that
       * fits its footprint rather than the deepest, so the centre can sit a few decimetres above the lowest burned
       * cell beside it (here 722.1 m against 721.3 m, in a channel burned 4 m deep). A metre of slack accepts that
       * and still fails a footprint that has climbed onto a shelf or a bank.
       *
       * "Beside it" means ACROSS the channel — cells at the inflow's own distance from the edge (±1 cell), out to its
       * radius either side. It used to be every cell in the footprint's square, which on a steep channel compares the
       * centre with the bed half a footprint DOWNSTREAM: the Lachen Chu enters Chungthang at ~5 % and its 4.8-cell
       * footprint spans ~3 m of fall along the river, so a centre exactly on the thalweg failed by the gradient alone.
       * Across the channel the comparison is the one the comment above describes, for any slope.
       */
      const inward = edgeDist === src.gy ? [0, 1] : edgeDist === ny - src.gy ? [0, -1] : edgeDist === src.gx ? [1, 0] : [-1, 0];
      let floor = Infinity;
      const rr = Math.ceil(src.radius);
      for (let a = -1; a <= 1; a++) {
        for (let c = -rr; c <= rr; c++) {
          const i = Math.floor(src.gx) + inward[0] * a + inward[1] * c;
          const j = Math.floor(src.gy) + inward[1] * a + inward[0] * c;
          if (i >= 0 && j >= 0 && i < nx && j < ny) floor = Math.min(floor, elevation[j * nx + i]);
        }
      }
      assert.ok(bed <= floor + 1, `${label}: inflow ${src.id} bed ${bed.toFixed(1)} m is ${(bed - floor).toFixed(1)} m above the channel floor beside it`);
      /*
       * And the channel must fall AWAY from it into the domain. This is the check that matters for a dry start: with
       * no water to show the way, an inflow on a reverse slope would pond at the boundary instead of running down the
       * valley, and nothing else here would notice.
       */
      /*
       * "64 cells in" is a band, 48–80 cells from the edge and up to 64 cells either side of the inflow, not a 16-cell
       * box straight ahead: a river can cross the edge at an angle (the Lachen Chu enters Chungthang heading
       * south-east, and the box straight south of it is the valley wall), and what matters is that the channel falls
       * away from the inflow somewhere a river could actually go.
       */
      let downstream = Infinity;
      for (let a = 48; a <= 80; a++) {
        for (let c = -64; c <= 64; c++) {
          const i = Math.floor(src.gx) + inward[0] * a + inward[1] * c;
          const j = Math.floor(src.gy) + inward[1] * a + inward[0] * c;
          if (i >= 0 && j >= 0 && i < nx && j < ny) downstream = Math.min(downstream, elevation[j * nx + i]);
        }
      }
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
     * The ceiling is the highest ground any domain could hold: 4,500 m in the US (Mt Whitney is 4,421 m), Everest's
     * 8,849 m elsewhere — the Raini–Tapovan domain climbs to 4,776 m on the ridges above the Rishiganga.
     */
    assert.ok(lo > -100 && hi < (isGlobal(id) ? 8849 : 4500) && hi - lo > 15, `elevation range ${lo}…${hi}`);
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
    /*
     * Chungthang's floor is lower again, and that is OpenStreetMap's coverage, not a parse failure: the nine OSM tiles
     * over the domain carry 73 drivable ways — the North Sikkim Highway, the road towards Lachung and a few lanes,
     * 34 km in 51 edges — next to ~1,170 unnamed buildings and not one school or clinic (counted from the cached
     * extracts; public/presets/SOURCES.txt). The scenario text says the streets are sparse.
     *
     * Chamoli's is the lowest, for the same reason: OSM maps 33 drivable ways over the 144 km² Raini–Tapovan domain —
     * the Joshimath–Malari road (NH107B), the Khullara–Dhak road and a few lanes at Tapovan, 30 km of road that the
     * graph reduces to 19 edges between 22 junctions and ends (scripts/bake-presets.ts, the chamoli shelter note).
     */
    const floor = id === 'chamoli' ? 15 : id === 'chungthang' ? 40 : isGlobal(id) ? 300 : 500;
    assert.ok(roads.edges.length > floor, `real road network (${roads.edges.length} edges)`);
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
/*
 * THE NEPAL SHELTERS, PINNED. Every shipped shelter name is a real OSM feature at a known node, spelled as OSM
 * spells it, and the shelter the bake ships must be within that node's search radius of it.
 *
 * This exists because a name drifted: "Kalika Community Hospital" shipped at [85.18091, 28.02053], an untagged
 * vertex of OSM way 443766738 (waterway=stream) 3.5 km north of the hospital and 753 m below it, and the false
 * name reached the on-screen route text. A shelter is the one thing in this app that names a real building people
 * would go to, so the name, the node and the position are asserted together and the justification lives in
 * scripts/bake-presets.ts and public/presets/SOURCES.txt.
 *
 * The lat/lon here are the node's own coordinates, read from the OSM extracts the bake consumes; when those
 * extracts are on this machine (they are gitignored downloads) the table is re-checked against them below.
 */
const NEPAL_SHELTERS = [
  { name: 'Shree Sundaradevi Pra Vi', node: '5063441826', lat: 27.9762731, lon: 85.1769728, search: 200 },
  { name: 'Shree Sivalaya Ni Ma.V', node: '4969611375', lat: 27.9835489, lon: 85.1913123, search: 200 },
] as const;
const NEPAL_OSM_XML = [0, 1, 2, 3].map((q) => path.resolve(import.meta.dirname, `../../artifacts/nepal-build/osm-betrawati-q${q}.xml`));

/** `name`, `lat` and `lon` of an OSM node id in the cached extracts, or null when they are not on this machine. */
function osmNode(id: string): { name: string | null; lat: number; lon: number } | null {
  for (const f of NEPAL_OSM_XML) {
    if (!fs.existsSync(f)) continue;
    const xml = fs.readFileSync(f, 'utf8');
    const at = xml.indexOf(`<node id="${id}" `);
    if (at < 0) continue;
    // A node is either self-closing or a block of <tag> children: stop at whichever comes first.
    const ends = [xml.indexOf('</node>', at + 1), xml.indexOf('<node id=', at + 1)].filter((i) => i > 0);
    const chunk = xml.slice(at, ends.length ? Math.min(...ends) : at + 2000);
    return {
      name: /<tag k="name" v="([^"]*)"/.exec(chunk)?.[1] ?? null,
      lat: Number(/ lat="([-0-9.]+)"/.exec(chunk)?.[1]),
      lon: Number(/ lon="([-0-9.]+)"/.exec(chunk)?.[1]),
    };
  }
  return null;
}

test('nepal: the routed chain hydrograph, sourced numbers, and the caveats on screen', { skip: !fs.existsSync(path.join(ROOT, 'nepal/meta.json')) }, () => {
  const { meta } = load('nepal');
  const s = meta.scenario;

  /*
   * The inflow is the hazard chain's routed hydrograph (scripts/bake-chain-result.ts): the ensemble's median member at
   * the domain entry, not the old 20 million m³ spread evenly over 30 minutes. It rises from baseflow, peaks and
   * recedes, then ramps down to the entry baseflow (chain.ts recessionRamp), which the forcing holds afterwards.
   */
  const surge = s.sources.find((x) => x.type === 'inflow')!;
  assert.equal(s.sources.length, 1, 'one forcing: the wave from upstream');
  assert.ok(surge.type === 'inflow' && surge.hydrograph && surge.hydrograph.length > 50, 'a routed hydrograph');
  if (surge.type !== 'inflow' || !surge.hydrograph) return;
  const peak = Math.max(...surge.hydrograph.map((p) => p.q));
  assert.equal(surge.discharge, Math.round(peak), 'discharge is the peak (labels and the CFL fallback read it)');
  assert.ok(surge.hydrograph[0].q < 0.05 * peak && surge.hydrograph[surge.hydrograph.length - 1].q < 0.05 * peak, 'from baseflow, back to baseflow');
  assert.equal(surge.stopAfter, undefined);
  assert.equal(s.stage, null, 'a stage slider would raise the whole reach at once — the opposite of this event');
  assert.equal(s.rainRate, 0);
  assert.equal(s.storms.length, 0);
  // The label is what the UI puts beside the number, so the provenance has to live there and not only in prose.
  assert.match(surge.label!, /modelled/);
  assert.match(surge.label!, /hazard-chain median member/);
  assert.match(surge.label!, /not a measured hydrograph/);
  assert.equal(s.hazardChain?.result, 'chain-result.json');

  // Published figures, exactly as published, and the model's beside them on the event's own clock.
  const cr = loadChainResult('nepal');
  const bet = cr.stations.find((x) => x.name === 'Betrawati')!;
  assert.match(s.description, /9:20 am/);
  assert.match(s.description, /about 20 million m³ of excess water/);
  assert.ok(s.description.includes(`the run starts at ${clockAt(cr.clockZero!, cr.domain.offset)}`), 'the 2-D clock is stated');
  assert.ok(s.description.includes(`model puts the front at Betrawati at ${clockAt(cr.clockZero!, bet.tFront!)}`), 'the model front, from chain-result.json');
  assert.ok(s.description.includes(`${Math.round(peak).toLocaleString('en-US')} m³/s`), 'the inflow peak, as shipped');
  assert.match(s.description, /the model’s error/);
  assert.match(s.description, /3\.55 m/, 'the gauge’s last reading');
  assert.match(s.description, /warning level 4\.1 m, danger level 5 m/);
  assert.match(s.description, /No gauge measured the peak/);
  // Caveats a visitor must not have to dig for. Each of the three below was in SOURCES.txt ALONE until the audit,
  // which is the same as nowhere: the on-screen sentence either says it or the app is overclaiming.
  assert.match(s.description, /surface model with canopy and buildings/);
  assert.match(s.description, /rivers start dry/);
  assert.match(s.description, /do not read street-level depths/);
  /*
   * (a) THE FILTER DOES NOT TOUCH MOST OF THIS DOMAIN. The bare-earth filter is gated to ground flatter than 20°
   * (BARE_EARTH_DEFAULTS.slopeGate = 0.364 m/m) and 77 % of the Betrawati square is steeper, so the valley walls
   * ship as the raw surface model. "filtered towards bare earth", which is what the text used to say, reads as the
   * whole terrain. The share is recomputed from the shipped elevation below, so the number on screen cannot rot.
   */
  assert.match(s.description, /flatter than 20°/);
  assert.match(s.description, /raw surface model/);
  const steepClaim = Number(/([0-9]+) % of this domain is steeper/.exec(s.description)?.[1]);
  assert.ok(Number.isFinite(steepClaim), 'the text states what share of the domain the filter skipped');
  /*
   * (b) THE ARRIVAL TIMES INSIDE THE MAP ARE THE MODEL'S, not the flood's. With water at the default 15 m/s cap the
   * reported max speed sat on the cap from 32 simulated seconds on (artifacts/nepal-verify/nepal-run.json). The app now
   * runs this preset with its hazard chain's debris-flood friction and 25 m/s cap (src/app/scene.ts
   * applyScenarioRheology), and the text must name the cap that applies. The clock is now the event's (the chain's),
   * and the text must say the model's front is late against the reports.
   */
  assert.match(s.description, /25 m\/s speed cap/);
  assert.equal(meta.scenario?.hazardChain?.solver?.uMax, 25, 'the cap the text names is the one the chain sets');
  assert.doesNotMatch(s.description, /15 m\/s/);
  assert.match(s.description, /later than reported/);
  /*
   * (c) THE IMAGERY SENTENCE MUST NOT CONTRADICT SOURCES.txt, which says Sentinel-2 L2A is open and COULD be
   * redistributed with credit — it simply was not composed. "there is no aerial photograph here that this project may
   * redistribute", the old wording, said the opposite of the file it is meant to summarise.
   */
  assert.match(s.description, /No photograph is baked in/);
  assert.match(s.description, /could be redistributed/);
  assert.doesNotMatch(s.description, /no aerial photograph/);
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
   * REAL NAMED PLACES, EACH PINNED TO ITS OWN OSM NODE (see NEPAL_SHELTERS above for why). Two of them: the third
   * entry named a hospital over a stream vertex 3.5 km away, and the hospital's real node is 919 m up on the
   * Kalikasthan ridge, which the research brief calls "a long climb, not a walk" — not a refuge for anyone on the
   * valley floor, so it is gone rather than relocated. Shree Neelkanta is out for a different reason
   * (scripts/bake-presets.ts): the road graph has no node within its search radius.
   */
  assert.equal(s.shelters.length, NEPAL_SHELTERS.length, 'two shelters, both pinned to an OSM node');
  const grid = { nx: meta.nx, ny: meta.ny, bounds: meta.bounds };
  for (const want of NEPAL_SHELTERS) {
    const got = s.shelters.find((sh) => sh.name === want.name);
    assert.ok(got, `no shelter named "${want.name}" (shipped: ${s.shelters.map((sh) => sh.name).join(', ')})`);
    const p = geoToGrid(grid, want.lon, want.lat);
    const off = Math.hypot(got.gx - p.gx, got.gy - p.gy) * meta.cellSize;
    // The bake snaps a shelter to a high road node within `search` of the named place; further than that and the
    // name is on the wrong ground.
    assert.ok(off <= want.search, `${want.name} sits ${off.toFixed(0)} m from OSM node ${want.node}, outside its ${want.search} m search`);
    // And the table itself is checked against the extracts when they are on this machine.
    const node = osmNode(want.node);
    if (node) {
      assert.equal(node.name, want.name, `OSM node ${want.node} is named "${node.name}", not "${want.name}"`);
      assert.ok(Math.abs(node.lat - want.lat) < 1e-6 && Math.abs(node.lon - want.lon) < 1e-6, `OSM node ${want.node} is at ${node.lat}, ${node.lon}`);
    }
  }
  // Nothing may re-appear under a name whose place is somewhere else: these two were both wrong, differently.
  const names = s.shelters.map((sh) => sh.name).join(' ');
  assert.doesNotMatch(names, /Neelkanta/);
  assert.doesNotMatch(names, /Kalika/);
});

for (const id of BAKED_GLOBAL) test(`${id}: the share of the domain the bare-earth filter skipped is the share the text claims`, { skip: !fs.existsSync(path.join(ROOT, id, 'meta.json')) }, () => {
  /*
   * The on-screen sentence says "77 % of this domain is steeper" than the filter's 20° gate. That number was measured
   * during the sweep (artifacts/nepal-build/out-bareearth-nepal.txt: 53 % at 20–35° plus 24 % over 35°), and an
   * artifact is not a guard — so recompute the gate's own test on the shipped elevation, the same ±2-cell slope
   * bareEarthFromSurface uses, and hold the claim to it.
   */
  const { meta, elevation } = load(id);
  const { nx, ny, cellSize } = meta;
  const g = 2;
  let steep = 0;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const xa = Math.max(0, i - g);
      const xb = Math.min(nx - 1, i + g);
      const ya = Math.max(0, j - g);
      const yb = Math.min(ny - 1, j + g);
      const dzdx = (elevation[j * nx + xb] - elevation[j * nx + xa]) / ((xb - xa) * cellSize);
      const dzdy = (elevation[yb * nx + i] - elevation[ya * nx + i]) / ((yb - ya) * cellSize);
      if (Math.hypot(dzdx, dzdy) > BARE_EARTH_DEFAULTS.slopeGate) steep++;
    }
  }
  const pct = (100 * steep) / (nx * ny);
  const claim = Number(/([0-9]+) % of this domain is steeper/.exec(meta.scenario.description)?.[1]);
  console.log(`  ${id}: ${pct.toFixed(1)} % of cells steeper than the ${BARE_EARTH_DEFAULTS.slopeGate} m/m gate; the text claims ${claim} %`);
  assert.ok(pct > 50, `only ${pct.toFixed(1)} % steep — the gate is not what leaves this domain unfiltered`);
  assert.ok(Math.abs(pct - claim) <= 2, `the text claims ${claim} %, the shipped DEM measures ${pct.toFixed(1)} %`);
});

const loadChain = (id: string) => JSON.parse(fs.readFileSync(path.join(ROOT, id, 'chain.json'), 'utf8')) as ChainFile;
const loadChainResult = (id: string) => JSON.parse(fs.readFileSync(path.join(ROOT, id, 'chain-result.json'), 'utf8')) as BakedChainResult;

test('nepal: the hazard chain is the 2026 mechanism, timed against the NDRRMA series', { skip: !hasChain('nepal') }, () => {
  /*
   * What the chain must carry: the avalanche turned debris flood (spec §C.3 branch 2 — direct flow: s = 0 is where the
   * mass met the river, there is no valley above it to pond, and the reports have the flood within minutes; a
   * transient dam there took 10.5 h to fill), the avalanche's own 4.3 min of travel, the mud-flood rheology and 25 m/s
   * cap for the 2-D run, the 09:15 SMS as the alert, and the published arrival times — every one of them tied to a
   * station on the profile or marked as lying beyond it.
   */
  const { meta } = load('nepal');
  const hc = meta.scenario.hazardChain!;
  assert.equal(hc.trigger.kind, 'massIntoRiver');
  assert.ok(hc.trigger.kind === 'massIntoRiver' && hc.trigger.mode === 'directFlow');
  assert.ok(hc.trigger.kind === 'massIntoRiver' && hc.trigger.mass.travelSpeed === 50);
  /*
   * O'Brien–Julien "mud flood", not Voellmy μ 0.05: Voellmy's Coulomb term stops flow where the surface slope is under
   * μ·cosθ ≈ 2.9°, and the Trishuli floor in this map falls ~2 %, so the 2-D surge stalled ~2 km in [C].
   */
  assert.deepEqual(hc.rheology, { kind: 'quadratic', cv: 0.3, material: { name: 'Glenwood 1', a2: 0.0345, b2: 20.1, a1: 0.00283, b1: 23.0 } });
  assert.equal(hc.solver?.uMax, 25);
  assert.equal(hc.alertTime, (9 * 60 + 15 - (8 * 60 + 37)) * 60, 'the 09:15 SMS, 38 minutes after 08:37');
  const c = loadChain('nepal');
  assert.equal(c.clockZero, '2026-08-26T08:37:00+05:45');
  const obs = (st: string) => hc.observations!.find((o) => o.station === st && o.tFront !== undefined)!;
  assert.equal(obs('Rasuwagadhi').tFront, 3 * 60);
  assert.equal(obs('Betrawati').tFront, 43 * 60);
  assert.equal(hc.observations!.find((o) => o.station === 'Devghat')!.qPeak, 5850);
  // The hydropower plants of spec §G.1, with the capacities their sources give.
  const mw = Object.fromEntries(c.stations.filter((st) => st.kind === 'hydro').map((st) => [st.name, st.capacityMW]));
  assert.deepEqual(mw, {
    'Rasuwagadhi HEP headworks': 111,
    'Chilime HEP powerhouse': 22.1,
    'Upper Trishuli-1 HEP (under construction)': 216,
    'Upper Trishuli-3A HEP powerhouse': 60,
    'Upper Trishuli-3B HEP powerhouse': 37,
  });
  // Order down the valley: source → Rasuwagadhi → Syafrubesi → domain edge → Betrawati (inside the 2-D domain).
  const at = (name: string) => c.stations.find((st) => st.name === name)!.s;
  assert.ok(at('Rasuwagadhi') < at('Syafrubesi') && at('Syafrubesi') < c.domainEntry.s && c.domainEntry.s < at('Betrawati'));
  assert.equal(c.stations[0].kind, 'source');
  // No weir crest is invented where no weir height was published.
  assert.equal(c.structures.length, 0);
  assert.equal(c.domainEntry.gx, 536.5);
  assert.equal(c.domainEntry.gy, 8.5);
});

test('chungthang: the routed chain hydrograph, the South Lhonak chain, and the caveats on screen', { skip: !fs.existsSync(path.join(ROOT, 'chungthang/meta.json')) }, () => {
  const { meta } = load('chungthang');
  const s = meta.scenario;
  assert.equal(s.sources.length, 1, 'one forcing: the flood from upstream');
  const src = s.sources[0];
  assert.ok(src.type === 'inflow' && src.hydrograph && src.hydrograph.length > 50, 'a hydrograph inflow');
  if (src.type !== 'inflow' || !src.hydrograph) return;
  /*
   * The inflow is the hazard chain's routed outburst (scripts/bake-chain-result.ts), the ensemble's median member — no
   * longer the parametric gamma placeholder on the 7,355 m³/s HEC-RAS peak. The published peaks at Chungthang are
   * themselves reconstructions (7,355–14,673 m³/s), so the text gives that range beside the model's.
   */
  const peak = Math.max(...src.hydrograph.map((p) => p.q));
  assert.equal(src.discharge, Math.round(peak), 'discharge is the peak (labels and the CFL fallback read it)');
  assert.ok(peak > 7355 * 0.5 && peak < 14673 * 1.5, `inflow peak ${peak} m³/s against the published 7,355–14,673`);
  assert.match(src.label!, /modelled/);
  assert.match(src.label!, /not a measured hydrograph/);
  assert.equal(s.hazardChain?.result, 'chain-result.json');
  const cr = loadChainResult('chungthang');
  const ch = cr.stations.find((x) => x.name === 'Chungthang')!;
  assert.match(s.description, /5,340 to 14,673 m³\/s/, 'the published range (Sattar et al. 2025 … the 2024 dam-break study), not just the number used');
  assert.ok(s.description.includes(`the run starts at ${clockAt(cr.clockZero!, cr.domain.offset)}`), 'the 2-D clock is stated');
  assert.ok(s.description.includes(`front at Chungthang at ${clockAt(cr.clockZero!, ch.tFront!)}`), 'the model front, from chain-result.json');
  assert.match(s.description, /about 00:35 reported/);
  assert.match(s.description, /surface model with canopy and buildings/);
  assert.match(s.description, /flatter than 20°/);
  assert.match(s.description, /do not read street-level depths/);
  // The app runs this preset with its chain's debris friction and speed cap (src/app/scene.ts applyScenarioRheology).
  assert.match(s.description, /25 m\/s speed cap/);
  assert.match(s.description, /carries no sediment/);
  assert.doesNotMatch(s.description, /this is clear water|15 m\/s/);
  const shown = `${meta.name} ${meta.subtitle} ${s.description} ${s.sources.map((x) => x.label ?? '').join(' ')}`;
  assert.doesNotMatch(shown, /\b(dead|death|deaths|killed|casualt\w*|missing|bodies)/i, 'no casualty figures on screen');
  assert.equal(s.stage, null);
  assert.equal(meta.bake?.prefill, 'none');
  assert.equal((meta.bake as { demSource?: string }).demSource, 'copernicus');

  const hc = s.hazardChain!;
  assert.ok(hc.trigger.kind === 'massIntoLake');
  if (hc.trigger.kind !== 'massIntoLake') return;
  assert.equal(hc.trigger.mass.volume, 14.7e6);
  assert.equal(hc.trigger.lake.area, 1.674e6);
  assert.equal(hc.trigger.breach.erosionRate, 100, 'trigger-driven breach, spec §B.3');
  // The lateral-moraine geometry the impulse wave spreads over (scripts/chain-defs.ts): outlet ~1.33 km away, 77° off
  // the slide's axis.
  assert.deepEqual(hc.trigger.wave, { distance: 1330, angleDeg: 77 });
  assert.equal(hc.solver?.uMax, 25);
  assert.equal(hc.rheology.kind, 'quadratic', 'mud flood, not the Voellmy law that stalled the 2-D front');
  const c = loadChain('chungthang');
  assert.equal(c.clockZero, '2023-10-03T22:13:20+05:30');
  // ~00:35, the "reported arrival" Sattar et al. 2025 compare their model with (00:30 is that model's own result).
  assert.equal(hc.observations!.find((o) => o.station === 'Chungthang' && o.tFront !== undefined)!.tFront, 8500);
  const at = (name: string) => c.stations.find((st) => st.name === name)!;
  assert.equal(at('South Lhonak Lake').s, 0);
  assert.equal(at('South Lhonak Lake').kind, 'lake');
  assert.equal(at('Teesta-III dam').capacityMW, 1200);
  // Published "~68 km" from the lake to Chungthang (Sattar et al. 2025); the OSM river measures it here.
  assert.ok(at('Chungthang').s > 60_000 && at('Chungthang').s < 75_000, `Chungthang at ${at('Chungthang').s} m`);
  assert.ok(at('Lachen').s < c.domainEntry.s && c.domainEntry.s < at('Chungthang').s);
  // The lake outlet on the DEM is where the published lake level is.
  assert.ok(Math.abs(c.zBed[0] - 5200) < 50, `profile starts at ${c.zBed[0]} m`);
  const dam = c.structures.find((x) => x.name === 'Teesta-III dam')!;
  const i = c.s.findIndex((v) => v >= dam.s);
  assert.ok(Math.abs(dam.crest - (c.zBed[i] + 60)) < 0.6, 'crest = bed + the published 60 m');
  assert.ok(dam.storage && dam.storage.length > 2);
});

test('chamoli: the routed debris flow, the Ronti Gad chain, a rheology that moves, and the caveats on screen', { skip: !fs.existsSync(path.join(ROOT, 'chamoli/meta.json')) }, () => {
  const { meta, elevation } = load('chamoli');
  const s = meta.scenario;
  // 12 km at 1024² (11.7 m cells): both plants and the reach below Tapovan in one map (scripts/bake-presets.ts).
  assert.equal(meta.nx, 1024);
  assert.ok(Math.abs(meta.cellSize - 12000 / 1024) < 0.01, `cell ${meta.cellSize}`);
  assert.equal(s.sources.length, 1, 'one forcing: the debris flow down the Rishiganga');
  const src = s.sources[0];
  assert.ok(src.type === 'inflow' && src.hydrograph && src.hydrograph.length > 50, 'a routed hydrograph inflow');
  if (src.type !== 'inflow' || !src.hydrograph) return;
  /*
   * The inflow is the hazard chain's routed debris flow (scripts/bake-chain-result.ts, the ensemble's median member),
   * like the other glacier presets'. Against the published reconstruction (Shugar et al. 2021, a MEAN discharge of
   * 8,200–14,200 m³/s at the Rishiganga plant and 2,900–4,900 below Tapovan) the model's peaks must land in the right
   * neighbourhood — at Raini inside the band, below Tapovan within half again of it — or the chain is not this event.
   */
  const peak = Math.max(...src.hydrograph.map((p) => p.q));
  assert.equal(src.discharge, Math.round(peak), 'discharge is the peak (labels and the CFL fallback read it)');
  assert.match(src.label!, /modelled/);
  assert.match(src.label!, /not a measured hydrograph/);
  assert.equal(s.hazardChain?.result, 'chain-result.json');
  const cr = loadChainResult('chamoli');
  const st = (name: string) => cr.stations.find((x) => x.name === name)!;
  const raini = st('Rishiganga HEP, Raini (position approximate)');
  assert.ok(raini.qPeak >= 8200 && raini.qPeak <= 14200, `model peak at Raini ${raini.qPeak} m³/s`);
  const below = st('Tapovan');
  assert.ok(below.qPeak >= 2900 && below.qPeak <= 4900 * 1.5, `model peak below Tapovan ${below.qPeak} m³/s`);
  const tap = st('Tapovan-Vishnugad HEP barrage (under construction)');
  assert.ok(Number.isFinite(tap.tFront) && tap.tFront! > 0, 'the modelled front reaches the barrage');
  assert.match(s.description, /8,200 to 14,200 m³\/s/, 'the published band, not just the number used');
  assert.ok(s.description.includes(`the run starts at ${clockAt(cr.clockZero!, cr.domain.offset)}`), 'the 2-D clock is stated');
  assert.ok(s.description.includes(`the Tapovan barrage at ${clockAt(cr.clockZero!, tap.tFront!)}`), 'the model front, from chain-result.json');
  assert.ok(s.description.includes(`${Math.round(peak).toLocaleString('en-US')} m³/s`), 'the inflow peak, as shipped');
  assert.match(s.description, /about 10:36–10:37 in the seismic records/);
  assert.match(s.description, /the model’s error/);
  assert.match(s.description, /floor has been cut along the river/, 'the terrain edit is on screen, not only in SOURCES.txt');
  assert.match(s.description, /surface model with canopy and buildings/);
  assert.match(s.description, /25 m\/s speed cap/);
  assert.match(s.description, /neither picks up nor drops sediment/);
  assert.match(s.description, /do not read street-level depths/);
  const shown = `${meta.name} ${meta.subtitle} ${s.description} ${s.sources.map((x) => x.label ?? '').join(' ')}`;
  assert.doesNotMatch(shown, /\b(dead|death|deaths|killed|casualt\w*|missing|bodies)/i, 'no casualty figures on screen');
  assert.equal(s.stage, null);
  assert.equal(meta.bake?.prefill, 'none');

  // The evacuation pin is the barrage site, at river level, on the road graph — the warning-time story.
  assert.ok(s.evacStart, 'an evacuation start');
  const ez = elevAt(elevation, meta.nx, s.evacStart!.gx, s.evacStart!.gy);
  assert.ok(ez < 1800, `the barrage-site start stands at ${ez.toFixed(0)} m — it should be down at the river`);
  // Every shelter stands > 80 m above the barrage site.
  for (const sh of s.shelters) assert.ok(elevAt(elevation, meta.nx, sh.gx, sh.gy) > ez + 80, `${sh.name}`);

  /*
   * The gorge floor (RiverDef.carve): along the Rishiganga, the shipped bed never rises downstream by more than a pit's
   * rim. Measured along the chain's own centreline (minimum within ±3 cells), the largest rise above the running
   * minimum must stay below the 18–41 m false sills the raw DSM has here — the sills that made even clear water pond.
   */
  const c = loadChain('chamoli');
  let run = Infinity;
  let worst = 0;
  for (let i = 0; i < c.s.length; i++) {
    const g = geoToGrid({ nx: meta.nx, ny: meta.ny, bounds: meta.bounds }, c.lonlat[i][0], c.lonlat[i][1]);
    if (g.gx < 4 || g.gy < 4 || g.gx > meta.nx - 4 || g.gy > meta.ny - 4 || c.s[i] > 15500) continue;
    let m = Infinity;
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) m = Math.min(m, elevAt(elevation, meta.nx, g.gx + di, g.gy + dj));
    worst = Math.max(worst, m - run);
    run = Math.min(run, m);
  }
  assert.ok(worst < 12, `the Rishiganga bed rises ${worst.toFixed(1)} m downstream somewhere in the gorge`);

  const hc = s.hazardChain!;
  assert.ok(hc.trigger.kind === 'massIntoRiver' && hc.trigger.mode === 'directFlow');
  if (hc.trigger.kind !== 'massIntoRiver') return;
  assert.equal(hc.trigger.mass.volume, 26.9e6);
  assert.equal(hc.trigger.mass.iceFraction, 0.2);
  // The debris-flow rheology of spec §I.6 #3, with the FLUID O'Brien–Julien material (the stiff one stalls, see the def).
  assert.ok(hc.rheology.kind === 'quadratic' && hc.rheology.cv === 0.45 && hc.rheology.material.name === 'Glenwood 1');
  assert.equal(hc.solver?.uMax, 25);
  assert.equal(c.clockZero, '2021-02-07T10:21:00+05:30');
  const at = (name: string) => c.stations.find((st) => st.name === name)!;
  assert.equal(at('Rishiganga HEP, Raini (position approximate)').capacityMW, 13.2);
  assert.equal(at('Tapovan-Vishnugad HEP barrage (under construction)').capacityMW, 520);
  // Shugar et al.: the Rishiganga plant ~15 km from the source, Joshimath 16 km below Raini.
  const rainiS = at('Rishiganga HEP, Raini (position approximate)').s;
  assert.ok(rainiS > 13_000 && rainiS < 17_000, `Raini at ${rainiS} m`);
  const jm = at('Joshimath (Vishnuprayag confluence)').s - rainiS;
  assert.ok(jm > 14_000 && jm < 18_000, `Raini → Joshimath ${jm} m`);
  assert.ok(c.domainEntry.s < rainiS, 'the chain enters the map above the Rishiganga plant');
  // Tapovan: ~15 min (Cook et al. 2021, via The Landslide Blog) and 16 min, first wave (Tiwari et al. 2022's seismic timeline).
  const tapObs = hc.observations!.filter((o) => o.tFront !== undefined && o.station.startsWith('Tapovan-Vishnugad')).map((o) => o.tFront);
  assert.deepEqual([...tapObs].sort(), [900, 960]);
  // No barrage crest invented where no height was published.
  assert.equal(c.structures.length, 0);
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

/*
 * GLACIER HAZARD CHAIN — public/presets/<id>/chain.json (src/hazard/types.ts ChainFile, written by
 * scripts/bake-chain.ts) and the HazardChainSpec in meta.json. The engine that routes a flood down this profile is
 * written against the contract alone, so every structural promise the contract makes is asserted here: chainage
 * ascending, one value per node in every per-node array, stage tables ascending from the bed, a bed that never rises
 * downstream (the bake's isotonic fit is exact), stations and structures on the profile, and a domain entry that is
 * the preset's own inflow, inside its grid, on the river.
 */
test('a hazard chain spec and its chain.json come together', () => {
  for (const id of BAKED) {
    if (!fs.existsSync(path.join(ROOT, id, 'meta.json'))) continue;
    const spec = load(id).meta.scenario.hazardChain;
    assert.equal(!!spec, hasChain(id), `${id}: scenario.hazardChain ${spec ? 'without' : 'missing beside'} chain.json`);
  }
  // The two glacier presets the chain was built for.
  assert.ok(hasChain('nepal') && hasChain('chungthang') && hasChain('chamoli'));
});
for (const id of BAKED.filter(hasChain)) {
  test(`baked preset "${id}": chain.json is a consistent valley profile`, () => {
    const { meta } = load(id);
    const file = path.join(ROOT, id, 'chain.json');
    const bytes = fs.statSync(file).size;
    assert.ok(bytes < 1e6, `chain.json is ${(bytes / 1e6).toFixed(2)} MB — keep it under 1 MB`);
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as ChainFile;
    assert.equal(c.version, 1);
    assert.ok(c.name.length > 3);
    if (c.clockZero !== undefined) assert.ok(Number.isFinite(Date.parse(c.clockZero)), `clockZero ${c.clockZero}`);
    assert.match(c.attribution, /Copernicus DEM GLO-30/);
    assert.match(c.attribution, /OpenStreetMap contributors/);

    const n = c.s.length;
    assert.ok(n >= 50, `${n} nodes`);
    for (const [k, arr] of [['zBed', c.zBed], ['n', c.n], ['sections', c.sections], ['lonlat', c.lonlat]] as const) {
      assert.equal(arr.length, n, `${k} has ${arr.length} entries for ${n} nodes`);
    }
    assert.equal(c.s[0], 0, 'chainage starts at the source');
    for (let i = 1; i < n; i++) {
      assert.ok(c.s[i] > c.s[i - 1], `s not ascending at node ${i}`);
      assert.ok(c.s[i] - c.s[i - 1] <= 250, `a ${c.s[i] - c.s[i - 1]} m gap at node ${i}`);
      // Monotone bed: exact, tolerance 0 (scripts/bake-chain.ts fits it isotonically and rounds to 1 cm).
      assert.ok(c.zBed[i] <= c.zBed[i - 1], `bed rises ${(c.zBed[i] - c.zBed[i - 1]).toFixed(2)} m at node ${i} (s ${c.s[i]})`);
    }
    assert.ok(c.zBed[0] - c.zBed[n - 1] > 100, 'a mountain valley falls more than 100 m over the profile');
    /*
     * SMOOTH, not a staircase (scripts/chain-profile.ts monotoneSmooth). The first bake's plain isotonic fit left 158 of
     * Nepal's 638 faces exactly flat with drops of up to 45 m between them — pools and waterfalls to the router. Now no
     * face is flat, and no 100 m node drops more than 25 m (Nepal's steepest smoothed reach: ~20 m).
     */
    assert.equal(flatFaces(c.zBed), 0, 'flat faces in the bed: the staircase is back');
    let steepest = 0;
    for (let i = 1; i < n; i++) steepest = Math.max(steepest, (c.zBed[i - 1] - c.zBed[i]) / ((c.s[i] - c.s[i - 1]) / 100));
    /*
     * Chamoli's profile starts in the Ronti Gad, a glacier torrent, not a valley river: over the 700 m above its
     * Rishiganga confluence (9.4–10.1 km) the smoothed bed falls 27–29 m per 100 m node after node, a sustained ~16°
     * gradient rather than one step (the profile drops 4,066 → 2,247 m over its first 11.5 km, 16 % on average). The
     * step test there is 32 m; everywhere else it stays at 25.
     */
    const stepLimit = id === 'chamoli' ? 32 : 25;
    assert.ok(steepest < stepLimit, `a ${steepest.toFixed(1)} m drop per 100 m: a step, not a smoothed bed`);
    /*
     * A FLOOR, not a slot: every section is at least MIN_FLOOR_WIDTH (one DEM cell, 25 m) wide one metre above its bed
     * (scripts/chain-profile.ts withFloor) — the first bake had gorge sections 3 m wide at 5 m of stage.
     */
    for (let i = 0; i < n; i++) {
      const sec = c.sections[i];
      const k = sec.stage.findIndex((z) => z >= c.zBed[i] + FLOOR_DEPTH - 0.005);
      assert.ok(k > 0 && sec.width[k] >= MIN_FLOOR_WIDTH - 0.05, `section ${i} (s ${c.s[i]}) is ${sec.width[k]} m wide at ${FLOOR_DEPTH} m`);
    }
    for (let i = 0; i < n; i++) {
      assert.ok(c.n[i] > 0.01 && c.n[i] < 0.2, `Manning n ${c.n[i]}`);
      const [lon, lat] = c.lonlat[i];
      assert.ok(Math.abs(lon) <= 180 && Math.abs(lat) <= 90, `lonlat ${lon},${lat}`);
      const sec = c.sections[i];
      const m = sec.stage.length;
      assert.ok(m >= 5, 'a stage table needs levels');
      for (const k of ['area', 'width', 'perimeter'] as const) assert.equal(sec[k].length, m, `section ${i} ${k} length`);
      assert.ok(Math.abs(sec.stage[0] - c.zBed[i]) < 0.011, `section ${i} starts at ${sec.stage[0]}, bed ${c.zBed[i]}`);
      assert.equal(sec.area[0], 0);
      for (let k = 1; k < m; k++) {
        assert.ok(sec.stage[k] > sec.stage[k - 1], `section ${i} stage not ascending`);
        assert.ok(sec.area[k] >= sec.area[k - 1] && sec.width[k] >= sec.width[k - 1] && sec.perimeter[k] >= sec.perimeter[k - 1], `section ${i} shrinks at level ${k}`);
      }
      assert.ok(sec.area[m - 1] > 0 && sec.width[m - 1] > 0, `section ${i} never wets`);
    }

    const end = c.s[n - 1];
    const names = new Set<string>();
    for (let k = 0; k < c.stations.length; k++) {
      const st = c.stations[k];
      assert.ok(st.s >= 0 && st.s <= end, `station ${st.name} at ${st.s} is off the profile (0–${end})`);
      if (k) assert.ok(st.s >= c.stations[k - 1].s, 'stations sorted by chainage');
      assert.ok(!names.has(st.name), `duplicate station ${st.name}`);
      names.add(st.name);
      if (st.kind === 'hydro') assert.ok(st.capacityMW! > 0, `hydropower station ${st.name} without its capacity`);
      assert.ok(Math.abs(st.lat) <= 90 && Math.abs(st.lon) <= 180);
    }
    for (const sc of c.structures) {
      assert.ok(sc.s >= 0 && sc.s <= end, `structure ${sc.name} off the profile`);
      const i = c.s.findIndex((v) => v >= sc.s);
      assert.ok(sc.crest > c.zBed[i], `structure ${sc.name} crest ${sc.crest} below the bed ${c.zBed[i]}`);
      assert.ok(sc.width > 0);
      if (sc.storage) for (let k = 1; k < sc.storage.length; k++) assert.ok(sc.storage[k][0] > sc.storage[k - 1][0] && sc.storage[k][1] >= sc.storage[k - 1][1]);
    }

    // Domain entry: on the profile, inside the 2-D grid, and the preset's own inflow (same disc, to the hundredth).
    const e = c.domainEntry;
    assert.ok(e.s > 0 && e.s <= end, `domainEntry.s ${e.s}`);
    assert.ok(e.gx >= 0 && e.gy >= 0 && e.gx <= meta.nx && e.gy <= meta.ny, `domainEntry (${e.gx}, ${e.gy}) outside the ${meta.nx}×${meta.ny} grid`);
    assert.ok(e.radius > 0);
    const inflow = meta.scenario.sources.find((x) => x.type === 'inflow' && Math.abs(x.gx - e.gx) < 0.01 && Math.abs(x.gy - e.gy) < 0.01);
    assert.ok(inflow, 'domainEntry is not at any inflow source of the preset');
    const edge = c.stations.filter((st) => st.kind === 'domainEdge');
    assert.equal(edge.length, 1, 'one domainEdge station');
    assert.equal(edge[0].s, e.s);
    const i = c.s.findIndex((v) => v >= e.s);
    const p = geoToGrid({ nx: meta.nx, ny: meta.ny, bounds: meta.bounds }, c.lonlat[i][0], c.lonlat[i][1]);
    const off = Math.hypot(p.gx - e.gx, p.gy - e.gy) * meta.cellSize;
    assert.ok(off < 300, `the profile passes ${off.toFixed(0)} m from the domain entry`);

    // The spec in meta.json points at this file, and its observations name stations of the profile — or say why not.
    const hc = meta.scenario.hazardChain;
    assert.ok(hc, 'a preset with chain.json carries scenario.hazardChain');
    assert.equal(hc.profile, 'chain.json');
    if (hc.alertTime !== undefined) assert.ok(hc.alertTime >= 0);
    if (hc.solver?.uMax !== undefined) assert.ok(hc.solver.uMax >= 15 && hc.solver.uMax <= 30);
    for (const o of hc.observations ?? []) {
      assert.ok(o.source.length > 5, `observation at ${o.station} has no source`);
      assert.ok(names.has(o.station) || /beyond the profile/.test(o.note), `observation station "${o.station}" is not on the profile and the note does not say so`);
      if (o.tFront !== undefined) assert.ok(o.tFront >= 0);
    }
  });
}

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

/*
 * THE PRESETS USE THE CHAIN. A preset with chain.json floods from its hazard chain: its inflow is the routed entry
 * hydrograph of the ensemble's median member (scripts/bake-chain-result.ts), and chain-result.json carries that run's
 * numbers for the UI (src/hazard/types.ts BakedChainResult). Re-run here from the shipped chain.json and spec: the
 * inflow must be exactly what the chain routes into the domain, and the file must say what the chain says.
 */
for (const id of BAKED.filter(hasChain)) {
  test(`baked preset "${id}": the inflow is the chain's routed hydrograph, and chain-result.json is that run`, () => {
    const { meta } = load(id);
    const hc = meta.scenario.hazardChain!;
    const c = loadChain(id);
    const cr = loadChainResult(id);
    assert.equal(cr.version, 1);
    assert.equal(cr.preset, id);
    assert.equal(cr.provenance, 'modelled');
    assert.equal(cr.profile, hc.profile);
    assert.equal(cr.clockZero, c.clockZero);
    assert.deepEqual(cr.stations.map((s) => s.name), c.stations.map((s) => s.name), 'one entry per profile station, in order');
    const m = cr.run.member!;
    assert.ok(m && m.volumeFactor > 0, 'which ensemble member the inflow is');

    const run = runChain(hc, c, { volumeFactor: m.volumeFactor, ...(m.erosionRate !== undefined ? { erosionRate: m.erosionRate } : {}), cv: m.cv });
    const src = meta.scenario.sources.find((x) => x.id === cr.domain.sourceId)!;
    assert.ok(src.type === 'inflow' && src.hydrograph, 'the chain inflow');
    if (src.type !== 'inflow' || !src.hydrograph) return;
    // Same clock: the 2-D t = 0 is the chain time five minutes before the front reaches the domain.
    assert.ok(Math.abs(domainClockOffset(run) - cr.domain.offset) <= 1, `offset ${domainClockOffset(run)} vs ${cr.domain.offset}`);
    // Same water: the shipped hydrograph (times to 0.1 s, discharges to 0.01 m³/s) carries the routed volume after the
    // offset — what the chain hands the 2-D solver — to 0.1 %.
    const ws = toWaterSource(run, c);
    const want = hydrographArea(ws.hydrograph!);
    const got = hydrographArea(src.hydrograph);
    assert.ok(Math.abs(got - want) / want < 1e-3, `inflow ${(got / 1e6).toFixed(3)} Mm³ vs the chain's ${(want / 1e6).toFixed(3)} Mm³`);
    assert.ok(Math.abs(cr.domain.inflowVolume - got) / got < 1e-3, 'chain-result.json states the inflow volume');
    // The shipped curve ends on the entry baseflow (the forcing holds its last point for ever): no unbounded volume.
    const qLast = src.hydrograph[src.hydrograph.length - 1].q;
    assert.ok(qLast <= run.entryBase + 0.01, `${id}: the inflow ends at ${qLast} m³/s, the entry baseflow is ${run.entryBase.toFixed(2)}`);
    // And it is the routed flood, not a trickle: the entry peak, at the chain's peak.
    // (3 %: the shipped curve is 30 s bin means, the routed peak an instantaneous face value — and a debris-flow surge
    // whose peak rides its front, as Chamoli's does, is sharper than one 30 s bin.)
    assert.ok(Math.abs(src.discharge - run.entryPeak) / run.entryPeak < 0.03, `inflow peak ${src.discharge} vs routed ${run.entryPeak.toFixed(0)}`);
    // The stations' numbers are this run's.
    for (const st of run.stations) {
      const b = cr.stations.find((x) => x.name === st.name)!;
      if (Number.isFinite(st.tFront)) assert.ok(Math.abs(b.tFront! - st.tFront) <= 1, `${st.name} front ${b.tFront} vs ${st.tFront}`);
      else assert.equal(b.tFront, null);
      assert.ok(Math.abs(b.qPeak - st.qPeak) <= Math.max(1, 1e-3 * st.qPeak), `${st.name} peak ${b.qPeak} vs ${st.qPeak}`);
      assert.ok(b.band, `${st.name} has its ensemble band`);
      const [lo, mid, hi] = b.band!.qPeak;
      assert.ok(lo <= mid && mid <= hi, `${st.name} band not ordered`);
    }
    // Lead times are front − alert where an alert time is known.
    if (hc.alertTime !== undefined) for (const st of cr.stations) if (st.tFront !== null) assert.equal(st.leadTime, st.tFront - hc.alertTime);
  });
}
