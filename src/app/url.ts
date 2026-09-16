import type { LiveAreaRequest } from '../contracts';
import { APP_CONFIG } from './defaults';

export type SceneRequest = { kind: 'preset'; id: string } | { kind: 'live'; req: LiveAreaRequest };

/**
 * Parse the startup scene from the query string:
 *   ?preset=<id>                    (default: pittsburgh)
 *   ?live=<lat>,<lon>,<sizeKm>[&res=512|1024|2048][&name=...]
 * An invalid ?live= value is reported through `warnings` and ignored.
 */
export function parseStartupRequest(search: string): { request: SceneRequest; warnings: string[] } {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];
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
      return {
        request: {
          kind: 'live',
          req: {
            center: { lat, lon },
            sizeMeters: Math.min(20000, Math.max(1000, km * 1000)),
            resolution,
            name: params.get('name') ?? undefined,
          },
        },
        warnings,
      };
    }
    warnings.push(`Ignoring invalid ?live=${live} (expected lat,lon,sizeKm e.g. 40.44,-80.00,5)`);
  }
  const id = params.get('preset')?.trim();
  return { request: { kind: 'preset', id: id || APP_CONFIG.defaultPreset }, warnings };
}

/** Keep the address bar in sync with the loaded scene so a reload (or shared link) reopens it. */
export function writeSceneToUrl(request: SceneRequest): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('preset');
    url.searchParams.delete('live');
    url.searchParams.delete('res');
    url.searchParams.delete('name');
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
