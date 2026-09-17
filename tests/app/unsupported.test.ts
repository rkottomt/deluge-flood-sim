/**
 * The screens shown when the app cannot run: the unsupported-browser guidance and the device-lost card.
 *
 * Both are pure-text decisions, and getting the text wrong is the bug: the soak (artifacts/soak3/t3-devlost.json)
 * caught the card telling a presenter the driver had "reset again after restarting" when the page had in fact run
 * happily for over a minute in between, which sends them hunting for a problem that isn't there mid-pitch.
 * Run: node --import tsx --test tests/app/unsupported.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  AUTO_RELOAD_MAX,
  AUTO_RELOAD_SETTLED_MS,
  AUTO_RELOAD_WINDOW_MS,
  browserHint,
  claimAutoReload,
  deviceLostLead,
  NO_ADAPTER_MESSAGE,
  sinceLastAutoReload,
} from '../../src/app/unsupported';

/** A sessionStorage stand-in (the real one is per tab; these tests need one per case). */
function fakeStorage(initial: string | null = null): Pick<Storage, 'getItem' | 'setItem'> & { value: string | null } {
  return {
    value: initial,
    getItem(key: string) {
      return key === 'deluge:gpu-lost-reload-at' ? this.value : null;
    },
    setItem(key: string, v: string) {
      if (key === 'deluge:gpu-lost-reload-at') this.value = v;
    },
  };
}

// ─── the device-lost card's lead paragraph ─────────────────────────────────────────────────────

test('deviceLostLead: the first loss is a one-off — it never claims anything happened "again"', () => {
  const lead = deviceLostLead({ plan: 'reload', hasStorage: true, sinceAutoReloadMs: null, lighterLabel: 'Pittsburgh' });
  assert.match(lead, /driver reset/);
  assert.match(lead, /restarts/, 'says what it is about to do');
  assert.doesNotMatch(lead, /again/, 'nothing has happened twice yet');
});

test('deviceLostLead: a second loss after minutes of healthy running does NOT claim it reset right after restarting', () => {
  // The soak case: 70 s of normal running, 4266 frames, then a second loss. The old text said "reset again after
  // restarting", which reads as "it died immediately" and is simply false.
  const lead = deviceLostLead({
    plan: 'manual',
    hasStorage: true,
    sinceAutoReloadMs: 4 * 60_000,
    lighterLabel: 'Pittsburgh',
  });
  assert.doesNotMatch(lead, /again after restarting/, 'the false claim the soak caught');
  assert.match(lead, /ran for 4 minutes/, 'it says how long the scene actually survived');
  assert.match(lead, /Reload this scene|start with/i, 'and offers both ways out');
});

test('deviceLostLead: a second loss soon after the restart says so, because then it IS the pattern', () => {
  const lead = deviceLostLead({
    plan: 'manual',
    hasStorage: true,
    sinceAutoReloadMs: 20_000,
    lighterLabel: 'Pittsburgh',
  });
  assert.match(lead, /20 seconds after Deluge restarted/);
  assert.match(lead, /GPU-heavy/, 'advises clearing the GPU first');
  assert.ok(20_000 < AUTO_RELOAD_SETTLED_MS, 'this case is inside the "not settled" window');
});

test('deviceLostLead: on the offline default scenario there is no lighter scene to offer, so it does not pretend', () => {
  const lead = deviceLostLead({ plan: 'manual', hasStorage: true, sinceAutoReloadMs: 5 * 60_000, lighterLabel: null });
  assert.doesNotMatch(lead, /start with/i, 'nothing lighter exists — this IS the lightest scenario');
  assert.match(lead, /restart the browser|GPU-heavy/, 'so the advice is about the machine instead');
});

test('deviceLostLead: without sessionStorage the page can never reload itself, so it just asks for a reload', () => {
  const lead = deviceLostLead({ plan: 'manual', hasStorage: false, sinceAutoReloadMs: null, lighterLabel: 'Pittsburgh' });
  assert.match(lead, /reload to bring it back/);
  assert.doesNotMatch(lead, /again/, 'it has no history, so it must not claim one');
});

test('deviceLostLead: switching to the lighter scenario is honest about whether the scene looked too heavy', () => {
  const soon = deviceLostLead({ plan: 'lighter', hasStorage: true, sinceAutoReloadMs: 15_000, lighterLabel: 'Pittsburgh' });
  assert.match(soon, /more GPU memory than is free/, 'died straight away → the scene really is the suspect');
  assert.match(soon, /Pittsburgh/);

  const settled = deviceLostLead({ plan: 'lighter', hasStorage: true, sinceAutoReloadMs: 6 * 60_000, lighterLabel: 'Pittsburgh' });
  assert.match(settled, /ran for 6 minutes/);
  assert.doesNotMatch(settled, /again after restarting/);
  assert.match(settled, /not obviously too heavy/, 'it switches anyway, but says the evidence is thin');
});

test('deviceLostLead: every wording is a single readable paragraph with no leftover placeholders', () => {
  for (const plan of ['reload', 'lighter', 'manual'] as const) {
    for (const since of [null, 5_000, 90_000, 10 * 60_000]) {
      for (const label of ['Pittsburgh', null]) {
        const lead = deviceLostLead({ plan, hasStorage: true, sinceAutoReloadMs: since, lighterLabel: label });
        assert.ok(lead.length > 40, `${plan}/${since}/${label}: not a sentence`);
        assert.doesNotMatch(lead, /undefined|null|NaN|\$\{/, `${plan}/${since}/${label}: placeholder leaked`);
        assert.doesNotMatch(lead, /\s{2,}/, `${plan}/${since}/${label}: double space`);
        assert.match(lead, /\.$/, `${plan}/${since}/${label}: unfinished sentence`);
      }
    }
  }
});

test('deviceLostLead: a run of a minute and a half reads as minutes, a short one as seconds', () => {
  const secs = deviceLostLead({ plan: 'manual', hasStorage: true, sinceAutoReloadMs: 40_000, lighterLabel: null });
  assert.match(secs, /40 seconds/);
  const mins = deviceLostLead({ plan: 'manual', hasStorage: true, sinceAutoReloadMs: 150_000, lighterLabel: null });
  assert.match(mins, /3 minutes/, '150 s rounds to 3 minutes, never "150 seconds"');
});

// ─── how long ago this tab reloaded itself ─────────────────────────────────────────────────────

test('sinceLastAutoReload: reports the most recent automatic reload, and survives junk', () => {
  const now = 1_000_000;
  assert.equal(sinceLastAutoReload(null, now), null, 'no storage → nothing known');
  assert.equal(sinceLastAutoReload(fakeStorage(null), now), null, 'never reloaded');
  assert.equal(sinceLastAutoReload(fakeStorage(JSON.stringify([now - 70_000, now - 5_000])), now), 5_000, 'the newest one');
  assert.equal(sinceLastAutoReload(fakeStorage(String(now - 30_000)), now), 30_000, 'an older build wrote a bare number');
  assert.equal(sinceLastAutoReload(fakeStorage('not json'), now), null);
  assert.equal(sinceLastAutoReload(fakeStorage(JSON.stringify([now + 60_000])), now), null, 'a clock change is ignored');
});

test('sinceLastAutoReload: read before claimAutoReload, it describes the PREVIOUS reload, not this loss', () => {
  const storage = fakeStorage();
  const t0 = 5_000_000;
  // First loss: nothing to look back on, and the page reloads itself.
  assert.equal(sinceLastAutoReload(storage, t0), null);
  assert.equal(claimAutoReload(storage, t0, false), 'reload');
  // Second loss, three minutes later: the age is measured from that reload, which is what the card talks about.
  const t1 = t0 + 3 * 60_000;
  assert.equal(sinceLastAutoReload(storage, t1), 3 * 60_000);
  assert.equal(claimAutoReload(storage, t1, false), 'manual', 'it will not reload the same scene twice in a row');
  const lead = deviceLostLead({
    plan: 'manual',
    hasStorage: true,
    sinceAutoReloadMs: sinceLastAutoReload(storage, t1),
    lighterLabel: 'Pittsburgh',
  });
  assert.match(lead, /ran for 3 minutes/);
  assert.ok(AUTO_RELOAD_MAX >= 1 && AUTO_RELOAD_WINDOW_MS > 0);
});

// ─── unsupported-browser guidance ──────────────────────────────────────────────────────────────

const UA = {
  safari18: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  safari26: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iosSafari18: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  // Brave ships a plain Chrome user agent on purpose; only navigator.brave gives it away.
  brave: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:145.0) Gecko/20100101 Firefox/145.0',
};

test('browserHint: Safari 18 on macOS 15 (this laptop) gets the Feature Flags path, not "install Chrome"', () => {
  const hint = browserHint(UA.safari18, false);
  assert.ok(hint, 'Safari 18 has a specific, working answer');
  assert.match(hint, /Safari 18\.6/, 'names the version it actually found');
  assert.match(hint, /Show features for web developers/);
  assert.match(hint, /Feature Flags/);
  assert.match(hint, /WebGPU/);
  assert.match(hint, /Safari 26/, 'and mentions the upgrade that needs no flag');
});

test('browserHint: Safari 26 ships WebGPU, so the hint is about the flag having been turned OFF', () => {
  const hint = browserHint(UA.safari26, false);
  assert.ok(hint);
  assert.match(hint, /which ships WebGPU/);
  assert.match(hint, /Feature Flags/, 'the only way it can be missing is someone switched it off');
});

test('browserHint: iOS Safari is sent to the Settings app, not to a Develop menu it does not have', () => {
  const hint = browserHint(UA.iosSafari18, false);
  assert.ok(hint);
  assert.match(hint, /Settings app/);
  assert.doesNotMatch(hint, /Develop/, 'there is no Develop menu on iOS');
  assert.match(hint, /iOS \/ iPadOS 26/);
});

test('browserHint: Brave is recognised through navigator.brave, never through its Chrome user agent', () => {
  const hint = browserHint(UA.brave, true);
  assert.ok(hint);
  assert.match(hint, /Brave/);
  assert.match(hint, /brave:\/\/settings\/system/);
  assert.match(hint, /brave:\/\/gpu/);
  assert.equal(browserHint(UA.brave, false), null, 'the same UA without navigator.brave is plain Chrome — no hint');
});

test('browserHint: Firefox is told where it does and does not ship WebGPU', () => {
  const hint = browserHint(UA.firefox, false);
  assert.ok(hint);
  assert.match(hint, /Firefox 145/);
  assert.match(hint, /141\+/, 'Windows');
  assert.match(hint, /147\+/, 'Apple silicon');
});

test('browserHint: a supported Chrome gets no hint (the generic lists already cover it)', () => {
  assert.equal(browserHint(UA.chrome, false), null);
  assert.equal(browserHint('', false), null, 'no user agent at all must not throw');
});

test('NO_ADAPTER_MESSAGE still matches what src/gpu.ts throws (the two files are deliberately not linked)', () => {
  // unsupported.ts must stay loadable without importing any GPU module (main.ts shows it before WebGPU is touched),
  // so the phrase is duplicated. This test is the link: if gpu.ts rewords its throw, the adapter-is-null screen
  // would silently fall back to telling a Chrome user to install Chrome.
  const gpuSource = readFileSync(new URL('../../src/gpu.ts', import.meta.url), 'utf8');
  assert.ok(gpuSource.includes(NO_ADAPTER_MESSAGE), `src/gpu.ts no longer throws “${NO_ADAPTER_MESSAGE}”`);
});
