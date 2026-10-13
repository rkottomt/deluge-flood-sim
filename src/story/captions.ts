/**
 * Live tokens in story captions. A caption may say "{front:Betrawati}" instead of typing the model's front time, so
 * the number on screen is always the one the app computed (a recalibrated chain changes it; the caption follows).
 *
 *   {now}             the event's clock on the map now ("09:41 NPT"), or the simulated time where there is no clock
 *   {simtime}         simulated time since the water was last reset ("12 min")
 *   {front:<station>} the modelled front's arrival at a hazard-chain station, on the event's clock
 *   {stage}           the river's stage on the gauge now ("46.0 ft")
 *   {kept}            what the walls keep dry right now ("139 acres and 11 km of streets")
 *
 * Tokens are resolved to plain text and shown through textContent: nothing here can become markup.
 */

export const CAPTION_TOKENS = ['now', 'simtime', 'front', 'stage', 'kept'] as const;
export type CaptionToken = (typeof CAPTION_TOKENS)[number];

/** Tokens that take an argument after a colon. */
const WITH_ARG: ReadonlySet<string> = new Set(['front']);

export interface TokenRef {
  name: string;
  arg: string | null;
  /** The token as written, braces included. */
  raw: string;
}

const TOKEN_RE = /\{([a-z]+)(?::([^{}]{1,80}))?\}/g;

/** Every `{token}` / `{token:arg}` in a caption, in order. */
export function captionTokens(text: string): TokenRef[] {
  const out: TokenRef[] = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ name: m[1], arg: m[2] ?? null, raw: m[0] });
  return out;
}

/** Why a token is not usable, or null when it is. */
export function tokenProblem(t: TokenRef): string | null {
  if (!(CAPTION_TOKENS as readonly string[]).includes(t.name)) return `unknown token ${t.raw}`;
  if (WITH_ARG.has(t.name) && !t.arg?.trim()) return `token ${t.raw} needs an argument`;
  if (!WITH_ARG.has(t.name) && t.arg !== null) return `token ${t.raw} takes no argument`;
  return null;
}

/** Placeholder for a token with no value yet (no chain result, no walls…). */
export const NO_VALUE = '—';

/**
 * Replace the tokens of `text` with what `resolve` returns (NO_VALUE for null). A `{` that does not start a token is
 * left as it is.
 */
export function resolveCaption(text: string, resolve: (name: CaptionToken, arg: string | null) => string | null): string {
  return text.replace(TOKEN_RE, (raw, name: string, arg: string | undefined) => {
    if (!(CAPTION_TOKENS as readonly string[]).includes(name)) return raw;
    let v: string | null = null;
    try {
      v = resolve(name as CaptionToken, arg ?? null);
    } catch {
      v = null;
    }
    return v === null || v === '' ? NO_VALUE : v;
  });
}
