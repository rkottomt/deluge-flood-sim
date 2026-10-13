import type { LiveAreaRequest } from '../contracts';
import { isPresetId, linkPlaceLabel } from '../data';
import { APP_CONFIG } from './defaults';
import { ADDRESS_AREA_M, ADDRESS_PARAM, ADDRESS_WARNING, addressAreaRequest, BREACH_PARAM, DAM_PARAM, METHOD_PARAM, parseAddressAt, parseUseCase, SURGE_AREA_M, surgeAreaRequest, useCaseById, USE_CASE_PARAM } from '../ui/useCaseDefs';
import { parseStoryParam, storyById, STORY_PARAM } from '../story/registry';

export type SceneRequest = { kind: 'preset'; id: string } | { kind: 'live'; req: LiveAreaRequest };

/**
 * Parse the startup scene from the query string:
 *   ?preset=<id>                    (default: pittsburgh)
 *   ?live=<lat>,<lon>,<sizeKm>[&res=512|1024|2048][&name=...]
 *   ?usecase=site|glacier|portfolio (src/ui/useCaseDefs.ts) opens on the use case's own preset, ahead of ?preset= and
 *                                   ?live=; src/ui/useCases.ts then sets up the rest of it
 *   ?usecase=address&at=<lat>,<lon> a 5 km live area centred on the point (strict numbers only, nothing else from the
 *                                   link); a missing or bad at= is a fixed warning, and the rest of the URL applies
 *   ?usecase=surge&at=<lat>,<lon>   the same for coastal surge, an 8 km area (src/ui/surgeView.ts sets it up)
 *   ?usecase=dam&nid=<NID id>       no scene of its own: ?live= (written once the area below the dam has loaded) or the
 *                                   default preset; src/ui/damView.ts finds the dam and loads the area below it
 *   ?story=<id>                     (src/story/registry.ts) opens on the story's own preset, ahead of everything else;
 *                                   src/ui/storyPlayer.ts then plays it
 * An invalid ?live=, ?usecase= (or its at=) or ?story= value is reported through `warnings` (a fixed sentence) and ignored.
 */
export function parseStartupRequest(search: string): { request: SceneRequest; warnings: string[] } {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
  const st = parseStoryParam(search);
  warnings.push(...st.warnings);
  const story = storyById(st.story);
  if (story?.preset) return { request: { kind: 'preset', id: story.preset }, warnings };
  // A dam story has no scene of its own, like ?usecase=dam: the area below the dam once it has been loaded (?live=,
  // written then), else the default preset; src/ui/storyPlayer.ts breaches the dam before the first beat.
  const uc = parseUseCase(search);
  warnings.push(...uc.warnings);
  if (uc.useCase === 'address' || uc.useCase === 'surge') {
    // Only numbers from the link (parseAddressAt); no name — the loader reverse-geocodes the point itself.
    const { at, warnings: w } = parseAddressAt(search);
    warnings.push(...w);
    if (at) return { request: { kind: 'live', req: uc.useCase === 'surge' ? surgeAreaRequest(at) : addressAreaRequest(at) }, warnings };
    if (!w.length) warnings.push(ADDRESS_WARNING);
  } else if (uc.useCase && useCaseById(uc.useCase).preset) {
    return { request: { kind: 'preset', id: useCaseById(uc.useCase).preset! }, warnings };
  }
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
    if (url.searchParams.has(USE_CASE_PARAM) && !useCaseMatches(url.search, request)) {
      url.searchParams.delete(USE_CASE_PARAM);
      url.searchParams.delete(ADDRESS_PARAM);
      url.searchParams.delete(DAM_PARAM);
      url.searchParams.delete(BREACH_PARAM);
      url.searchParams.delete(METHOD_PARAM);
    }
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

/**
 * Whether the address bar's `?usecase=` names a use case whose scene is the one `request` loads: its preset, or — for
 * the address case — the live area around its `at=` point.
 */
export function useCaseMatches(search: string, request: SceneRequest): boolean {
  const uc = parseUseCase(search).useCase;
  if (!uc) return false;
  if (uc === 'address' || uc === 'surge') {
    const at = parseAddressAt(search).at;
    return !!at && request.kind === 'live' && Math.abs(request.req.center.lat - at.lat) < 1e-5 && Math.abs(request.req.center.lon - at.lon) < 1e-5 && request.req.sizeMeters === (uc === 'surge' ? SURGE_AREA_M : ADDRESS_AREA_M);
  }
  // The dam case's area is centred below the dam, not on it: any live area keeps the link (src/ui/damView.ts re-checks
  // that the dam is on it before using it).
  if (uc === 'dam') return request.kind === 'live';
  return request.kind === 'preset' && request.id === useCaseById(uc).preset;
}

/**
 * Whether the address bar's `?story=` names a story whose scene is the one `request` loads: its preset, or — for a
 * dam story — a live area (the story player checks that the dam is on it before using it, as the dam view does).
 */
export function storyMatches(search: string, request: SceneRequest): boolean {
  const story = storyById(parseStoryParam(search).story);
  if (!story) return false;
  if (story.dam) return request.kind === 'live';
  return request.kind === 'preset' && request.id === story.preset;
}
