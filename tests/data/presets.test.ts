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
import type { RoadNetwork, ScenarioPreset, TerrainData } from '../../src/contracts';
import { cellSizeFor } from '../../src/data/geo';
import { computeInitialWater } from '../../src/data/initialWater';
import { listPresets, loadPreset } from '../../src/data/index';
import { decodeElevation, type PresetMeta, setPresetBaseUrl, validatePresetMeta } from '../../src/data/presets';
import { type CompactRoads, decodeRoads } from '../../src/data/roads';
import { generateSandbox } from '../../src/data/sandbox';

const ROOT = path.resolve(import.meta.dirname, '../../public/presets');
const FT = 0.3048;
const BAKED = ['pittsburgh', 'johnstown', 'ellicott'];

interface Loaded {
  meta: PresetMeta;
  elevation: Float32Array;
  roads: RoadNetwork;
  jpg: Buffer;
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
  const jpg = fs.readFileSync(path.join(dir, meta.files.imagery!));
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

function checkScenario(
  label: string,
  t: Pick<TerrainData, 'nx' | 'ny' | 'cellSize' | 'elevation'> & { roads: RoadNetwork | null },
  s: ScenarioPreset,
  h0: Float32Array,
) {
  const { nx, ny, elevation } = t;
  // Sources: on water that starts full, with most of the footprint wet.
  for (const src of s.sources) {
    const k = Math.floor(src.gy) * nx + Math.floor(src.gx);
    assert.ok(h0[k] > 0.5, `${label}: source ${src.id} center depth ${h0[k].toFixed(2)} m — not on a full river`);
    let cells = 0;
    let wet = 0;
    const r = Math.ceil(src.radius);
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (di * di + dj * dj > src.radius * src.radius) continue;
        cells++;
        if (h0[(Math.floor(src.gy) + dj) * nx + Math.floor(src.gx) + di] > 0.05) wet++;
      }
    }
    // Stage footprints must sit inside the water; an inflow may overlap a narrow channel's banks a little (the
    // injected water simply drains into the channel).
    const need = src.type === 'stage' ? 0.8 : 0.7;
    assert.ok(wet >= cells * need, `${label}: source ${src.id} footprint only ${wet}/${cells} wet`);
    if (src.type === 'stage' && s.stage) {
      assert.ok(Math.abs(src.level - s.stage.normalLevel) < 0.6, `${label}: stage source ${src.id} level ${src.level} vs normal ${s.stage.normalLevel}`);
    }
  }
  // Initial water is confined: small fraction of the domain and depths that match a burned channel.
  let wet = 0;
  let maxDepth = 0;
  for (let k = 0; k < h0.length; k++) {
    if (h0[k] > 0.01) wet++;
    maxDepth = Math.max(maxDepth, h0[k]);
  }
  assert.ok(wet > 0, `${label}: rivers start empty`);
  assert.ok(wet < nx * ny * 0.15, `${label}: initial water covers ${((100 * wet) / (nx * ny)).toFixed(1)} % of the domain`);
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
    else {
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
    assert.ok(lo > -100 && hi < 2000 && hi - lo > 20, `elevation range ${lo}…${hi}`);
    assert.ok(Math.abs(cellSizeFor(meta.bounds, meta.nx) / meta.cellSize - 1) < 2e-3, 'cellSize matches bounds');
    const size = jpegSize(jpg);
    assert.equal(size.width, 2048);
    assert.equal(size.height, 2048);
    assert.match(meta.attribution, /USGS 3DEP/);
    assert.match(meta.attribution, /Esri/);
    assert.ok(meta.scenario.description.length > 200);
    const info = listPresets().find((p) => p.id === id);
    assert.ok(info && info.name === meta.name);
  });

  test(`baked preset "${id}": sources on full rivers, shelters on high ground, confined initial water`, { skip: !present && 'not baked' }, () => {
    const { meta, elevation, roads, h0 } = load(id);
    checkScenario(id, { nx: meta.nx, ny: meta.ny, cellSize: meta.cellSize, elevation, roads }, meta.scenario, h0);
    const wet = h0.reduce((a, v) => a + (v > 0.01 ? 1 : 0), 0);
    const baked = meta.bake?.initialWetCells;
    if (typeof baked === 'number') assert.ok(Math.abs(wet - baked) <= baked * 0.01, `wet cells ${wet} vs baked ${baked}`);
    assert.ok(roads.edges.length > 500, 'real road network');
  });
}

test('pittsburgh: stage control matches the Point gauge story', { skip: !fs.existsSync(path.join(ROOT, 'pittsburgh/meta.json')) }, () => {
  const { meta } = load('pittsburgh');
  const st = meta.scenario.stage!;
  assert.ok(st, 'stage control');
  const normalFt = (st.normalLevel - st.gaugeDatum) / FT;
  assert.ok(normalFt > 13 && normalFt < 19, `normal pool reads ${normalFt.toFixed(1)} ft on the gauge`);
  assert.equal(st.floodStageFt, 25);
  const record = st.marks!.find((m) => /1936/.test(m.label))!;
  assert.equal(record.ft, 46);
  const recordOffset = record.ft * FT + st.gaugeDatum - st.normalLevel;
  assert.ok(recordOffset > 0 && recordOffset < st.maxOffset, '1936 crest reachable with the slider');
  const stageSources = meta.scenario.sources.filter((s) => s.type === 'stage');
  assert.equal(stageSources.length, 3, 'Allegheny + Monongahela inflow edges and the Ohio outflow edge');
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
