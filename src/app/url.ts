import type { LiveAreaRequest } from '../contracts';
import { isPresetId, linkPlaceLabel } from '../data';
import { APP_CONFIG } from './defaults';
import { parseUseCase, useCaseById, USE_CASE_PARAM } from '../ui/useCaseDefs';
import { parseStoryParam, storyById, STORY_PARAM } from '../story/registry';

export type SceneRequest = { kind: 'preset'; id: string } | { kind: 'live'; req: LiveAreaRequest };

/**
 * Parse the startup scene from the query string:
 *   ?preset=<id>                    (default: pittsburgh)
 *   ?live=<lat>,<lon>,<sizeKm>[&res=512|1024|2048][&name=...]
 *   ?usecase=site|glacier|portfolio (src/ui/useCaseDefs.ts) opens on the use case's own preset, ahead of ?preset= and
 *                                   ?live=; src/ui/useCases.ts then sets up the rest of it
 *   ?story=<id>                     (src/story/registry.ts) opens on the story's own preset, ahead of everything else;
 *                                   src/ui/storyPlayer.ts then plays it
 * An invalid ?live=, ?usecase= or ?story= value is reported through `warnings` (a fixed sentence) and ignored.
 */
export function parseStartupRequest(search: string): { request: SceneRequest; warnings: string[] } {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
  const st = parseStoryParam(search);
  warnings.push(...st.warnings);
  const story = storyById(st.story);
  if (story) return { request: { kind: 'preset', id: story.preset }, warnings };
  const uc = parseUseCase(search);
  warnings.push(...uc.warnings);
  if (uc.useCase) return { request: { kind: 'preset', id: useCaseById(uc.useCase).preset }, warnings };
  const live = params.get('live');
  if (live) {
    const parts = live.split(',').map((p) => Number(p.trim()));
    const [lat, lon, sizeKm] = parts;
    const valid =
      parts.length >= 2 &&
      Number.isFinite(lat) &&
      Number.isFinite(lon) &&
      Math.abs(lat) <= 85 &&
      Math.abs(lon) <= 180;
    if (valid) {
      const km = Number.isFinite(sizeKm) && sizeKm > 0 ? sizeKm : 5;
      const resParam = Number(params.get('res'));
      const resolution = resParam === 512 || resParam === 2048 ? resParam : APP_CONFIG.liveResolution;
      // SEC-01: a link-supplied name is sanitised here and flagged, so src/data can show it with its
      // coordinates instead of letting an attacker's sentence pose as a place the app recognised.
      const name = linkPlaceLabel(params.get('name'));
      return {
        request: {
          kind: 'live',
          req: {
            center: { lat, lon },
            sizeMeters: Math.min(20000, Math.max(1000, km * 1000)),
            resolution,
            ...(name ? { name, nameFromLink: true } : {}),
          },
        },
        warnings,
      };
    }
    // SEC-01: never echo the attacker's string back into the UI — the warning is a fixed sentence.
    warnings.push('Ignoring an invalid ?live= link value (expected lat,lon,sizeKm, e.g. 40.44,-80.00,5)');
  }
  const raw = params.get('preset')?.trim();
  const known = isPresetId(raw);
  if (raw && !known) warnings.push('Ignoring an unknown ?preset= link value');
  return { request: { kind: 'preset', id: known ? raw : APP_CONFIG.defaultPreset }, warnings };
}

/** Keep the address bar in sync with the loaded scene so a reload (or shared link) reopens it. */
export function writeSceneToUrl(request: SceneRequest): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('preset');
    url.searchParams.delete('live');
    url.searchParams.delete('res');
    url.searchParams.delete('name');
    // A use-case link stays in the address bar only while its own scene is on screen, so a reload after switching
    // scenes reopens what is shown rather than the use case.
    if (url.searchParams.has(USE_CASE_PARAM) && !useCaseMatches(url.search, request)) url.searchParams.delete(USE_CASE_PARAM);
    // Likewise a story link: kept only while the story's own preset is on screen.
    if (url.searchParams.has(STORY_PARAM) && !storyMatches(url.search, request)) url.searchParams.delete(STORY_PARAM);
    if (request.kind === 'preset') {
      url.searchParams.set('preset', request.id);
    } else {
      const { center, sizeMeters, resolution, name } = request.req;
      url.searchParams.set('live', `${center.lat.toFixed(5)},${center.lon.toFixed(5)},${+(sizeMeters / 1000).toFixed(2)}`);
      if (resolution !== APP_CONFIG.liveResolution) url.searchParams.set('res', String(resolution));
      if (name) url.searchParams.set('name', name);
    }
    // Keep `live=lat,lon,km` readable in shared links (commas are valid in a query string).
    url.search = url.search.replace(/%2C/gi, ',');
    if (url.href !== window.location.href) window.history.replaceState(null, '', url);
  } catch {
    // Non-essential (e.g. sandboxed iframes may forbid history access).
  }
}

/** Whether the address bar's `?usecase=` names a use case whose preset is the scene `request` loads. */
export function useCaseMatches(search: string, request: SceneRequest): boolean {
  const uc = parseUseCase(search).useCase;
  return !!uc && request.kind === 'preset' && request.id === useCaseById(uc).preset;
}

/** Whether the address bar's `?story=` names a story whose preset is the scene `request` loads. */
export function storyMatches(search: string, request: SceneRequest): boolean {
  const story = storyById(parseStoryParam(search).story);
  return !!story && request.kind === 'preset' && request.id === story.preset;
}
