/**
 * Strict validator for story data (src/story/types.ts). The bundled stories are checked by the unit tests and again
 * when the registry loads, so a malformed beat (a typo'd action, an unknown token, a caption with control characters)
 * is caught before a presenter meets it on stage. Unknown keys are errors, not ignored: a misspelt `untill` would
 * otherwise silently make a beat stop waiting.
 */
import { captionTokens, tokenProblem } from './captions';
import { DEFAULT_MAX_WAIT_MS, PANEL_SECTIONS, UI_TARGETS, type Story } from './types';

export const STORY_ID_RE = /^[a-z0-9-]{1,32}$/;
/** An NID id, as src/dams/nidIndex.ts NID_ID_RE (kept here so this module imports nothing from the app). */
const NID_RE = /^[A-Z]{2}[A-Z0-9]{3,6}$/;
/** A sweep or comparison level id (src/loss/ladders.ts ids: rp100, record1936…). */
const LEVEL_RE = /^[a-z0-9-]{1,32}$/;
const WATER_VIEWS = ['realistic', 'depth', 'maxDepth', 'velocity', 'arrival', 'hazard', 'default'];
const USE_CASES = ['site', 'glacier', 'portfolio'];
/** C0/C1 controls (newline allowed nowhere) and bidi overrides/isolates: never in on-screen text. */
const BAD_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export const LIMITS = {
  title: 80,
  subtitle: 120,
  summary: 240,
  caption: 360,
  source: 220,
  kicker: 60,
  label: 48,
  station: 80,
  beatsMin: 2,
  beatsMax: 30,
  actionsMax: 8,
  highlightsMax: 4,
  durationMin: 1000,
  durationMax: 60_000,
  maxWaitMax: 600_000,
} as const;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function validateStory(value: unknown, opts: { presets?: readonly string[] } = {}): ValidationResult {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);

  const keys = (o: Obj, path: string, allowed: readonly string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err(path, `unknown key "${k}"`);
  };
  const text = (o: Obj, k: string, path: string, max: number, required = true) => {
    const v = o[k];
    if (v === undefined && !required) return;
    if (typeof v !== 'string' || !v.trim()) return err(`${path}.${k}`, 'must be a non-empty string');
    if (v.length > max) err(`${path}.${k}`, `longer than ${max} characters`);
    if (BAD_CHARS.test(v)) err(`${path}.${k}`, 'contains control or bidi characters');
  };
  const num = (o: Obj, k: string, path: string, lo: number, hi: number, required = true) => {
    const v = o[k];
    if (v === undefined && !required) return;
    if (!isNum(v) || v < lo || v > hi) err(`${path}.${k}`, `must be a number in [${lo}, ${hi}]`);
  };
  const oneOf = (o: Obj, k: string, path: string, list: readonly (string | null)[]) => {
    if (!list.includes(o[k] as string | null)) err(`${path}.${k}`, `must be one of ${list.map(String).join(', ')}`);
  };

  if (!isObj(value)) return { ok: false, errors: ['story: must be an object'] };
  const s = value;
  keys(s, 'story', ['id', 'preset', 'dam', 'group', 'title', 'subtitle', 'summary', 'beats']);
  if (typeof s.id !== 'string' || !STORY_ID_RE.test(s.id)) err('story.id', 'must match [a-z0-9-]{1,32}');
  if ((s.preset === undefined) === (s.dam === undefined)) err('story', 'needs exactly one of preset and dam');
  if (s.preset !== undefined) {
    if (typeof s.preset !== 'string' || !STORY_ID_RE.test(s.preset)) err('story.preset', 'must match [a-z0-9-]{1,32}');
    else if (opts.presets && !opts.presets.includes(s.preset)) err('story.preset', `unknown preset "${s.preset}"`);
  }
  if (s.dam !== undefined) {
    if (!isObj(s.dam)) err('story.dam', 'must be an object');
    else {
      keys(s.dam, 'story.dam', ['nid', 'breach']);
      if (typeof s.dam.nid !== 'string' || !NID_RE.test(s.dam.nid)) err('story.dam.nid', 'must be an NID id such as MI00549');
      oneOf(s.dam, 'breach', 'story.dam', ['sunny', 'flood']);
    }
  }
  if (s.group !== undefined) oneOf(s, 'group', 'story', ['business', 'event']);
  text(s, 'title', 'story', LIMITS.title);
  text(s, 'subtitle', 'story', LIMITS.subtitle);
  text(s, 'summary', 'story', LIMITS.summary);

  if (!Array.isArray(s.beats) || s.beats.length < LIMITS.beatsMin || s.beats.length > LIMITS.beatsMax) {
    err('story.beats', `must be an array of ${LIMITS.beatsMin}–${LIMITS.beatsMax} beats`);
    return { ok: false, errors };
  }
  const seen = new Set<string>();
  s.beats.forEach((b: unknown, i: number) => {
    const p = `beats[${i}]`;
    if (!isObj(b)) return err(p, 'must be an object');
    keys(b, p, ['id', 'kicker', 'caption', 'source', 'durationMs', 'camera', 'actions', 'until', 'maxWaitMs', 'highlight']);
    if (typeof b.id !== 'string' || !STORY_ID_RE.test(b.id)) err(`${p}.id`, 'must match [a-z0-9-]{1,32}');
    else if (seen.has(b.id)) err(`${p}.id`, `duplicate beat id "${b.id}"`);
    else seen.add(b.id);
    text(b, 'kicker', p, LIMITS.kicker, false);
    text(b, 'caption', p, LIMITS.caption);
    text(b, 'source', p, LIMITS.source);
    if (typeof b.caption === 'string') for (const t of captionTokens(b.caption)) {
      const problem = tokenProblem(t);
      if (problem) err(`${p}.caption`, problem);
    }
    if (!Number.isInteger(b.durationMs) || (b.durationMs as number) < LIMITS.durationMin || (b.durationMs as number) > LIMITS.durationMax) {
      err(`${p}.durationMs`, `must be an integer in [${LIMITS.durationMin}, ${LIMITS.durationMax}]`);
    }
    num(b, 'maxWaitMs', p, 0, LIMITS.maxWaitMax, false);
    if (b.camera !== undefined) validateCamera(b.camera, `${p}.camera`);
    if (b.actions !== undefined) {
      if (!Array.isArray(b.actions) || b.actions.length > LIMITS.actionsMax) err(`${p}.actions`, `must be an array of at most ${LIMITS.actionsMax}`);
      else b.actions.forEach((a: unknown, k: number) => validateAction(a, `${p}.actions[${k}]`));
    }
    if (b.until !== undefined) validateUntil(b.until, `${p}.until`);
    if (b.maxWaitMs !== undefined && b.until === undefined) err(`${p}.maxWaitMs`, 'only makes sense with until');
    if (b.highlight !== undefined) {
      if (!Array.isArray(b.highlight) || b.highlight.length > LIMITS.highlightsMax) err(`${p}.highlight`, `must be an array of at most ${LIMITS.highlightsMax}`);
      else b.highlight.forEach((hl: unknown, k: number) => validateHighlight(hl, `${p}.highlight[${k}]`));
    }
  });

  function validateCamera(c: unknown, p: string) {
    if (!isObj(c)) return err(p, 'must be an object');
    const common = ['kind', 'seconds', 'orbitDeg'];
    num(c, 'seconds', p, 0, 10, false);
    num(c, 'orbitDeg', p, -90, 90, false);
    const yawPitch = () => {
      num(c, 'yaw', p, -2 * Math.PI, 2 * Math.PI, false);
      num(c, 'pitch', p, 0.05, Math.PI / 2, false);
    };
    switch (c.kind) {
      case 'scenario':
        keys(c, p, [...common, 'zoom', 'yawOffset', 'pitch']);
        num(c, 'zoom', p, 0.1, 4, false);
        num(c, 'yawOffset', p, -2 * Math.PI, 2 * Math.PI, false);
        num(c, 'pitch', p, 0.05, Math.PI / 2, false);
        return;
      case 'levee':
      case 'frame':
        return keys(c, p, common);
      case 'at':
        keys(c, p, [...common, 'lat', 'lon', 'distance', 'yaw', 'pitch']);
        num(c, 'lat', p, -90, 90);
        num(c, 'lon', p, -180, 180);
        num(c, 'distance', p, 50, 60_000);
        return yawPitch();
      case 'station':
        keys(c, p, [...common, 'station', 'distance', 'yaw', 'pitch']);
        text(c, 'station', p, LIMITS.station);
        num(c, 'distance', p, 50, 60_000);
        return yawPitch();
      default:
        err(`${p}.kind`, 'must be scenario, levee, frame, at or station');
    }
  }

  function validateAction(a: unknown, p: string) {
    if (!isObj(a)) return err(p, 'must be an object');
    switch (a.kind) {
      case 'reset':
      case 'pause':
      case 'levee':
      case 'evacuate':
      case 'replayUpstream':
      case 'demoSites':
      case 'siteSweep':
      case 'readArrivals':
        return keys(a, p, ['kind']);
      case 'compare': {
        keys(a, p, ['kind', 'levels', 'userRp']);
        const levels = a.levels;
        if (!Array.isArray(levels) || levels.length < 1 || levels.length > 8 || !levels.every((l) => typeof l === 'string' && LEVEL_RE.test(l)) || new Set(levels).size !== levels.length) {
          err(`${p}.levels`, 'must be 1–8 distinct level ids');
        }
        if (a.userRp !== undefined) {
          if (!Array.isArray(a.userRp) || a.userRp.length > 8) return err(`${p}.userRp`, 'must be an array of at most 8');
          a.userRp.forEach((r: unknown, k: number) => {
            const q = `${p}.userRp[${k}]`;
            if (!isObj(r)) return err(q, 'must be an object');
            keys(r, q, ['level', 'years']);
            if (typeof r.level !== 'string' || !Array.isArray(levels) || !levels.includes(r.level)) err(`${q}.level`, 'must be one of the levels run');
            if (!Number.isInteger(r.years) || (r.years as number) < 1 || (r.years as number) > 100_000) err(`${q}.years`, 'must be a whole number of years in [1, 100000]');
          });
        }
        return;
      }
      case 'play':
      case 'release':
        keys(a, p, ['kind', 'speed']);
        return num(a, 'speed', p, 0.1, 3600, false);
      case 'raiseStage':
        keys(a, p, ['kind', 'feet']);
        return num(a, 'feet', p, 0, 200);
      case 'waterView':
        keys(a, p, ['kind', 'mode']);
        return oneOf(a, 'mode', p, WATER_VIEWS);
      case 'rain':
        keys(a, p, ['kind', 'mmPerHour']);
        return num(a, 'mmPerHour', p, 0, 500);
      case 'useCase':
        keys(a, p, ['kind', 'id']);
        return oneOf(a, 'id', p, USE_CASES);
      case 'panel':
        keys(a, p, ['kind', 'section']);
        return oneOf(a, 'section', p, [...PANEL_SECTIONS, null]);
      default:
        err(`${p}.kind`, `unknown action "${String(a.kind)}"`);
    }
  }

  function validateUntil(u: unknown, p: string) {
    if (!isObj(u)) return err(p, 'must be an object');
    switch (u.kind) {
      case 'chainTime':
      case 'simTime':
        keys(u, p, ['kind', 't']);
        return num(u, 't', p, 0, 1e6);
      case 'station':
        keys(u, p, ['kind', 'station', 'after']);
        text(u, 'station', p, LIMITS.station);
        return num(u, 'after', p, 0, 1e5, false);
      case 'stageArrived':
      case 'protection':
      case 'route':
        return keys(u, p, ['kind']);
      default:
        err(`${p}.kind`, `unknown wait "${String(u.kind)}"`);
    }
  }

  function validateHighlight(hl: unknown, p: string) {
    if (!isObj(hl)) return err(p, 'must be an object');
    switch (hl.kind) {
      case 'station':
        keys(hl, p, ['kind', 'station']);
        return text(hl, 'station', p, LIMITS.station);
      case 'stationPin':
        keys(hl, p, ['kind', 'station', 'label']);
        text(hl, 'station', p, LIMITS.station);
        return text(hl, 'label', p, LIMITS.label, false);
      case 'pin':
        keys(hl, p, ['kind', 'lat', 'lon', 'label']);
        num(hl, 'lat', p, -90, 90);
        num(hl, 'lon', p, -180, 180);
        return text(hl, 'label', p, LIMITS.label);
      case 'ui':
        keys(hl, p, ['kind', 'target']);
        return oneOf(hl, 'target', p, UI_TARGETS);
      default:
        err(`${p}.kind`, `unknown highlight "${String(hl.kind)}"`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Narrowing helper: the value is a valid Story. */
export function isValidStory(value: unknown, opts?: { presets?: readonly string[] }): value is Story {
  return validateStory(value, opts).ok;
}

/** Longest a story can take with every wait running to its cap, ms (for the recorder's timeout). */
export function worstCaseMs(story: Story, pace = 1): number {
  return story.beats.reduce((acc, b) => acc + Math.max(b.durationMs * pace, b.until ? (b.maxWaitMs ?? DEFAULT_MAX_WAIT_MS) : 0) + 4000, 0);
}
