/**
 * The bundled stories and the strict `?story=` link parser.
 *
 * SECURITY (same rules as `?usecase=`, FINDINGS.json SEC-01): the value is matched exactly against the ids below; any
 * other value is dropped with a fixed sentence and never echoed. No part of a link reaches the page — the captions are
 * constant text from this repository.
 */
import { CHAMOLI_STORY } from './stories/chamoli';
import { CHUNGTHANG_STORY } from './stories/chungthang';
import { HOUSTON_STORY } from './stories/houston';
import { NEPAL_STORY } from './stories/nepal';
import { PITTSBURGH_STORY } from './stories/pittsburgh';
import type { Story } from './types';
import { STORY_ID_RE, validateStory } from './validate';

/** Every bundled story, in the order the entry points list them. */
const ALL: readonly Story[] = [NEPAL_STORY, PITTSBURGH_STORY, HOUSTON_STORY, CHUNGTHANG_STORY, CHAMOLI_STORY];

/** The stories that pass validation (all of them; the unit tests fail otherwise). */
export const STORIES: readonly Story[] = ALL.filter((s) => {
  const r = validateStory(s);
  if (!r.ok && typeof console !== 'undefined') console.warn(`[story] ${s.id} dropped: ${r.errors.join('; ')}`);
  return r.ok;
});

export const STORY_PARAM = 'story';

/** Fixed warning for a `?story=` value that is not a known id (the value itself is never shown). */
export const STORY_WARNING = 'Ignoring an unknown ?story= link value';

export function storyById(id: string | null | undefined): Story | null {
  if (typeof id !== 'string') return null;
  return STORIES.find((s) => s.id === id) ?? null;
}

export function storiesForPreset(preset: string | null | undefined): Story[] {
  return preset ? STORIES.filter((s) => s.preset === preset) : [];
}

/** The story each business use case tells (src/ui/useCaseDefs.ts ids). */
export const USE_CASE_STORIES: Readonly<Record<'site' | 'glacier' | 'portfolio', string>> = {
  site: 'pittsburgh-1936',
  glacier: 'nepal-2026',
  portfolio: 'houston-harvey',
};

/**
 * Read `?story=` strictly: exactly one of the ids, case-sensitive, no surrounding junk. Missing or empty is no story
 * and no warning.
 */
export function parseStoryParam(search: string): { story: string | null; warnings: string[] } {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(search).get(STORY_PARAM);
  } catch {
    raw = null;
  }
  if (raw === null || raw === '') return { story: null, warnings: [] };
  if (raw.length <= 32 && STORY_ID_RE.test(raw) && storyById(raw)) return { story: raw, warnings: [] };
  return { story: null, warnings: [STORY_WARNING] };
}
