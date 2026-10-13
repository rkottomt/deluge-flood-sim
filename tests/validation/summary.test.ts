/**
 * The committed validation data (public/validation/) and what the Scenario panel makes of it: every baked preset has
 * a summary entry, every observation names its source and licence, every committed raster matches its preset's grid,
 * and the app's Validation block either shows a score or says plainly that there is nothing to compare against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validationText } from '../../src/ui/validationBlock';
import { rleDecode } from '../../src/validation/raster';
import type { FemaZonesFile, ObservedFile, ValidationSummary } from '../../src/validation/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = path.join(ROOT, 'public/validation');
const presets = fs
  .readdirSync(path.join(ROOT, 'public/presets'), { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(ROOT, 'public/presets', d.name, 'meta.json')))
  .map((d) => d.name);
const summary = JSON.parse(fs.readFileSync(path.join(PUB, 'summary.json'), 'utf8')) as ValidationSummary;

test('every baked preset has a validation entry and an observed.json', () => {
  for (const id of presets) {
    assert.ok(summary.presets[id], `${id}: no entry in public/validation/summary.json`);
    assert.ok(fs.existsSync(path.join(PUB, id, 'observed.json')), `${id}: no observed.json`);
  }
});

test('every observation cites a source URL, a licence and a retrieval date; none-cases say why', () => {
  for (const id of presets) {
    const obs = JSON.parse(fs.readFileSync(path.join(PUB, id, 'observed.json'), 'utf8')) as ObservedFile;
    assert.equal(obs.preset, id);
    for (const s of obs.sources) {
      assert.match(s.url, /^https:\/\//, `${id}: ${s.id} url`);
      assert.ok(s.licence.length > 10, `${id}: ${s.id} licence`);
      assert.match(s.retrieved, /^\d{4}-\d{2}-\d{2}$/);
    }
    const hasData = !!(obs.hwm?.sites.length || obs.gauges?.length || obs.fema || obs.ems);
    assert.ok(hasData || (obs.none && obs.none.length > 20), `${id}: neither observations nor a reason`);
    if (obs.hwm) for (const s of obs.hwm.sites) assert.ok(s.elevation > -10 && s.elevation < 5000, `${id}: HWM ${s.site} elevation ${s.elevation}`);
  }
});

test('committed FEMA zone rasters decode to their preset’s grid', () => {
  for (const id of presets) {
    const f = path.join(PUB, id, 'fema-zones.json');
    if (!fs.existsSync(f)) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/presets', id, 'meta.json'), 'utf8')) as { nx: number; ny: number };
    const z = JSON.parse(fs.readFileSync(f, 'utf8')) as FemaZonesFile;
    assert.equal(z.nx, meta.nx);
    assert.equal(z.ny, meta.ny);
    const cls = rleDecode(z.rle, z.nx * z.ny);
    let sfha = 0;
    for (const v of cls) if (v === 1) sfha++;
    assert.equal(sfha, z.counts['1'] ?? 0);
  }
});

test('a committed parcel damage survey is a mask on the grid with the gauged crest, and nothing personal', () => {
  let found = 0;
  for (const id of presets) {
    const raw = fs.readFileSync(path.join(PUB, id, 'observed.json'), 'utf8');
    const obs = JSON.parse(raw) as ObservedFile;
    if (!obs.damage) continue;
    found++;
    const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/presets', id, 'meta.json'), 'utf8')) as { nx: number; ny: number };
    const mask = rleDecode(obs.damage.maskRle, meta.nx * meta.ny);
    const cells = mask.reduce((s, v) => s + v, 0);
    assert.ok(cells >= obs.damage.parcels, `${id}: ${cells} mask cells for ${obs.damage.parcels} parcels`);
    assert.ok(mask.every((v) => v === 0 || v === 1));
    const g = obs.damage.gauge;
    assert.ok(Math.abs(g.elevation - (g.stageFt + g.gaugeDatumFt) * 0.3048) < 0.01, `${id}: crest datum arithmetic`);
    assert.ok(obs.sources.some((s) => s.id === 'parcel-damage'), `${id}: the survey is cited`);
    // The source layer carries owner names and addresses; none of it may reach the repo.
    assert.doesNotMatch(raw, /OWNER|PROP_ADDR|STANPAR/);
  }
  assert.ok(found >= 1, 'the Nashville May 2010 survey is committed');
});

test('a second observed flood shows as a further line in the Validation block', () => {
  const t = validationText(summary.presets.nashville);
  assert.ok(t && t.more.length >= 1);
  for (const m of t.more) {
    assert.match(m.label, /2010/);
    assert.ok(m.value.length > 5 && !/NaN|undefined|null/.test(m.value), m.value);
  }
  assert.deepEqual(validationText({ preset: 'x', event: 'e', headline: { label: 'l', value: 'v', note: 'n' }, metrics: {}, runs: [] })?.more, []);
});

test('public/validation stays small (it ships with the app)', () => {
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else bytes += fs.statSync(p).size;
    }
  };
  walk(PUB);
  assert.ok(bytes < 2e6, `public/validation is ${(bytes / 1e6).toFixed(2)} MB`);
});

test('the Validation block shows the headline, or says there is nothing to compare against', () => {
  for (const id of presets) {
    const t = validationText(summary.presets[id]);
    assert.ok(t, id);
    if (summary.presets[id].headline) {
      assert.ok(t.value.length > 5 && !/NaN|undefined|null/.test(t.value), `${id}: "${t.value}"`);
    } else {
      assert.match(t.label, /Not checked/);
      assert.equal(t.value, '');
    }
  }
  assert.equal(validationText(undefined), null);
});
