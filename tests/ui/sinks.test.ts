/**
 * The HTML sinks in src/ are a closed, reviewed set (FINDINGS.json SEC-08).
 *
 * No injection is reachable today — every dynamic string goes through `textContent` or a text node. This suite is a
 * ratchet so it stays that way: a new `innerHTML =`, `insertAdjacentHTML`, `document.write` or `h(…, { html })`
 * anywhere in src/ fails here, and whoever adds it has to either use `h()`/`setText` or add an entry below with a
 * reason. That matters because the CSP (SEC-02) is a backstop, not a substitute: a meta-delivered policy does not stop
 * markup that rewrites the app's own UI, only script execution.
 *
 * Run: node --import tsx --test tests/ui/*.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Every .ts file under src/, excluding the WGSL shader sources (plain strings, no DOM). */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name !== 'shaders') sourceFiles(full, out);
    } else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SRC = fileURLToPath(new URL('../../src/', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const rel = (f: string) => f.slice(REPO.length);

/** Strip comments so a sink named in prose does not count as a sink. */
const code = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * Every place in src/ allowed to write markup, and why each one is safe. A sink is only acceptable when the string it
 * receives is a compile-time constant or built solely from other constants.
 */
const ALLOWED = new Map<string, string>([
  ['src/ui/dom.ts', 'trustedMarkup(): the one parser, named so call sites are reviewable'],
  ['src/ui/topbar.ts', 'play/pause icon swap: iconMarkup() of a literal icon name'],
  ['src/app/unsupported.ts', 'the fallback screen skeleton; its dynamic text goes through textContent'],
]);

/** `innerHTML`/`outerHTML` writes, `insertAdjacentHTML`, `document.write`, `Range.createContextualFragment`. */
const SINK = /\b(?:inner|outer)HTML\s*(?:=|\+=)|\.insertAdjacentHTML\s*\(|document\s*\.\s*write(?:ln)?\s*\(|createContextualFragment\s*\(/;

test('no HTML sink appears outside the reviewed allowlist', () => {
  const offenders: string[] = [];
  const used = new Set<string>();
  for (const f of sourceFiles(SRC)) {
    const lines = code(f).split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!SINK.test(lines[i])) continue;
      const name = rel(f);
      if (ALLOWED.has(name)) used.add(name);
      else offenders.push(`${name}:${i + 1}: ${lines[i].trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Use h()/setText for dynamic content, or trustedMarkup() for a constant — then add the file to ALLOWED with a reason.',
  );
  // Keep the allowlist honest: an entry whose sink has gone should be deleted, not left as future cover.
  const stale = [...ALLOWED.keys()].filter((f) => !used.has(f));
  assert.deepEqual(stale, [], 'these files no longer contain an HTML sink — remove them from ALLOWED');
});

test('h() has no html prop: it is not a sink', () => {
  const dom = code(join(SRC, 'ui/dom.ts'));
  // The prop loop must not special-case anything that assigns markup.
  assert.ok(!/k === 'html'/.test(dom), "h() handles an 'html' prop again");
  assert.ok(!/innerHTML/.test(dom.slice(dom.indexOf('export function h<'), dom.indexOf('export function append'))), 'h() writes no markup');
  // Everything that is not an element is appended as text.
  assert.ok(/createTextNode/.test(dom));
});

test('no call site passes an html prop to h()', () => {
  const offenders: string[] = [];
  for (const f of sourceFiles(SRC)) {
    for (const [i, line] of code(f).split('\n').entries()) {
      // `html:` inside an object literal — the old h() prop, and Leaflet's divIcon/popup option of the same name.
      if (!/(^|[{,\s])html\s*:/.test(line)) continue;
      const name = rel(f);
      // The one permitted use is Leaflet's divIcon with a literal; anything with a template or variable is not.
      const literalOnly = /html:\s*'[^'$]*'/.test(line) || /html:\s*"[^"$]*"/.test(line);
      if (!(name === 'src/ui/locationPicker.ts' && literalOnly)) offenders.push(`${name}:${i + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "h()'s html prop was removed (SEC-08); Leaflet's divIcon html must stay a literal");
});

test('trustedMarkup is only ever handed a constant', () => {
  const offenders: string[] = [];
  for (const f of sourceFiles(SRC)) {
    for (const [i, line] of code(f).split('\n').entries()) {
      const m = line.match(/trustedMarkup(?:<[^>]*>)?\(\s*(.)/);
      if (!m || /export function trustedMarkup/.test(line)) continue;
      // A string literal, a backtick template, or a named constant built from them (icons.ts, howItWorks.ts) — never
      // a value that could have come from a URL, a response, a preset or the store.
      const opener = m[1];
      if (opener !== "'" && opener !== '"' && opener !== '`' && !/trustedMarkup(?:<[^>]*>)?\(\s*(?:iconMarkup\(|markup\))/.test(line)) {
        offenders.push(`${rel(f)}:${i + 1}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'trustedMarkup() must receive constant markup only — see its doc comment');
});

test('the old fragment() helper is gone, so its name cannot hide a sink', () => {
  for (const f of sourceFiles(SRC)) {
    // `fragment:` is a WebGPU render-pipeline stage descriptor, not this helper; only a call is a sink.
    const hits = code(f).split('\n').filter((l) => /\bfragment\s*(?:<[^>]*>)?\(/.test(l));
    assert.deepEqual(hits, [], `${rel(f)} still calls fragment(); it is now trustedMarkup()`);
  }
});
