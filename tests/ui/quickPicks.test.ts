import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QUICK_PICKS, quickPickAt, quickPickTip } from '../../src/ui/quickPicks';

test('quick-pick tips only claim what a load found: Houston before loading, with a water-level control, and without', () => {
  const houston = QUICK_PICKS.find((p) => p.name === 'Houston')!;
  const before = quickPickTip(houston, null);
  assert.match(before, /Harvey/);
  assert.match(before, /Hurricane rain/);
  assert.doesNotMatch(before, /Rain floods it here/, 'no claim about water bodies before anything loaded');
  const withControl = quickPickTip(houston, { waterLevel: true });
  assert.match(withControl, /water-level control/);
  assert.doesNotMatch(withControl, /rain floods it/i);
  const withoutControl = quickPickTip(houston, { waterLevel: false });
  assert.match(withoutControl, /no water body/i);
  assert.match(withoutControl, /Hurricane rain/);
  // Picks without a rain story keep their plain tip until loaded.
  const sac = QUICK_PICKS.find((p) => p.name === 'Sacramento')!;
  assert.equal(quickPickTip(sac, undefined), sac.tip);
  assert.match(quickPickTip(sac, { waterLevel: true }), /raise the water$/);
  assert.match(quickPickTip(houston, { waterLevel: true, sizeMeters: 8000, resolution: 1024 }), /Loaded at 8 km · 1024², it has a water-level control/);
  for (const p of QUICK_PICKS) {
    assert.equal(quickPickAt(p.lat, p.lon), p);
    for (const loaded of [null, { waterLevel: true }, { waterLevel: false }]) assert.ok(quickPickTip(p, loaded).startsWith(p.tip));
  }
  assert.equal(quickPickAt(0, 0), null);
});
