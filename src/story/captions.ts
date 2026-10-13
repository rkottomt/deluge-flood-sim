/**
 * Live tokens in story captions. A caption may say "{front:Betrawati}" instead of typing the model's front time, so
 * the number on screen is always the one the app computed (a recalibrated chain changes it; the caption follows).
 *
 *   {now}             the event's clock on the map now ("09:41 NPT"), or the simulated time where there is no clock
 *   {simtime}         simulated time since the water was last reset ("12 min")
 *   {front:<station>} the modelled front's arrival at a hazard-chain station, on the event's clock
 *   {stage}           the river's stage on the gauge now ("46.0 ft")
 *   {kept}            what the walls keep dry right now ("139 acres and 11 km of streets")
 *   {site:<p>.<fact>} Site check after its sweep, for parcel a, b or c (the sites in their list order): its name, the
 *                     verdict's sentences (reach, floor, egress, eal), the worst level's depth, the egress at the
 *                     level that cuts it, and indicative floor levels (ffe: designed to the worst level that reaches
 *                     it; ffe100: to the 1 % level)
 *   {bca:<fact>}      Compare designs after a run, for its first design: avoided EAL, cost, BCR with its range,
 *                     break-even cost, verdict, net benefit, discount rate, useful life, levels
 *   {dam:<fact>}      the dam breach on the map: the NID's numbers, the breach band and the hydrograph sent in
 *   {arrival:<km>}    the last downstream readout at 0.5, 1, 2, 3, 5, 8 or 12 km below the dam, with its spread
 *
 * Tokens are resolved to plain text and shown through textContent: nothing here can become markup.
 */

export const CAPTION_TOKENS = ['now', 'simtime', 'front', 'stage', 'kept', 'site', 'bca', 'dam', 'arrival'] as const;
export type CaptionToken = (typeof CAPTION_TOKENS)[number];

/** Tokens that take an argument after a colon. */
const WITH_ARG: ReadonlySet<string> = new Set(['front', 'site', 'bca', 'dam', 'arrival']);

/** What a Site check fact may name, per parcel. */
export const SITE_FACTS = ['name', 'reach', 'floor', 'egress', 'eal', 'worst', 'cutoff', 'ffe', 'ffe100'] as const;
export type SiteFact = (typeof SITE_FACTS)[number];
export const SITE_PARCELS = ['a', 'b', 'c'] as const;
/** What a benefit–cost fact may name (the comparison's first design). */
export const BCA_FACTS = ['design', 'deltaeal', 'cost', 'bcr', 'range', 'breakeven', 'verdict', 'net', 'rate', 'life', 'levels'] as const;
export type BcaFact = (typeof BCA_FACTS)[number];
/** What a dam fact may name. */
export const DAM_FACTS = ['name', 'nid', 'height', 'storage', 'hazard', 'mode', 'peak', 'tpeak', 'band', 'central', 'low', 'high', 'volume', 'width', 'formation', 'readat'] as const;
export type DamFact = (typeof DAM_FACTS)[number];
/** The downstream readout's distances, km (src/dams/placement.ts READOUT_DISTANCES_M; a unit test keeps them equal). */
export const ARRIVAL_KM = ['0.5', '1', '2', '3', '5', '8', '12'] as const;

/** The arguments a token accepts, when it takes one from a closed set (front takes a station name, checked elsewhere). */
const ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  site: new Set(SITE_PARCELS.flatMap((p) => SITE_FACTS.map((f) => `${p}.${f}`))),
  bca: new Set(BCA_FACTS),
  dam: new Set(DAM_FACTS),
  arrival: new Set(ARRIVAL_KM),
};

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
  const allowed = ARGS[t.name];
  if (allowed && t.arg !== null && !allowed.has(t.arg)) return `token ${t.raw} names nothing it knows`;
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
