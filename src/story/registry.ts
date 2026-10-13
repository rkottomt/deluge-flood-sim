/**
 * The bundled stories and the strict `?story=` link parser.
 *
 * SECURITY (same rules as `?usecase=`, FINDINGS.json SEC-01): the value is matched exactly against the ids below; any
 * other value is dropped with a fixed sentence and never echoed. No part of a link reaches the page — the captions are
 * constant text from this repository.
 */
import { CHAMOLI_STORY } from './stories/chamoli';
import { CHUNGTHANG_STORY } from './stories/chungthang';
import { DAM_STORY } from './stories/dam';
import { HOUSTON_STORY } from './stories/houston';
import { LEVEE_STORY } from './stories/levee';
import { NEPAL_STORY } from './stories/nepal';
import { PITTSBURGH_STORY } from './stories/pittsburgh';
import { SITE_STORY } from './stories/site';
import type { Story } from './types';
import { STORY_ID_RE, validateStory } from './validate';

/**
 * Every bundled story, in the order the entry points list them: the business decisions first (a developer's site, a
 * protection investment, a dam owner's county briefing), then the events retold.
 */
const ALL: readonly Story[] = [SITE_STORY, LEVEE_STORY, DAM_STORY, NEPAL_STORY, PITTSBURGH_STORY, HOUSTON_STORY, CHUNGTHANG_STORY, CHAMOLI_STORY];

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

/** A business decision (listed first) or an event retold. */
export function isBusinessStory(s: Story): boolean {
  return s.group === 'business';
}

/** Every story on a preset, in list order. */
export function storiesForPreset(preset: string | null | undefined): Story[] {
  return preset ? STORIES.filter((s) => s.preset === preset) : [];
}

/**
 * The story "Watch the story" plays on a preset: its event story when it has one (Pittsburgh 1936 rather than the
 * site decision on the same map), else the first story on it.
 */
export function sceneStory(preset: string | null | undefined): Story | null {
  const list = storiesForPreset(preset);
  return list.find((s) => !isBusinessStory(s)) ?? list[0] ?? null;
}

/** The story each business use case tells (src/ui/useCaseDefs.ts ids). */
export const USE_CASE_STORIES: Readonly<Record<'site' | 'glacier' | 'portfolio' | 'dam', string>> = {
  site: 'site-decision',
  glacier: 'nepal-2026',
  portfolio: 'houston-harvey',
  dam: 'dam-upstream',
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
