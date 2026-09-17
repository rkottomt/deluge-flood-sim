/**
 * Network reachability for live areas (the location picker). Pure / DOM-free so it can be unit-tested.
 */

/** Hosts the live loader needs; reaching any of them means the network is up. */
const PROBE_URLS = [
  'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer?f=json',
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/0/0/0.png',
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer?f=json',
];

/**
 * True when at least one of the data hosts answers within `timeoutMs`. `navigator.onLine` alone is not trusted
 * (captive portals and broken venue wifi report online); an opaque no-cors response is enough to prove reachability.
 */
export async function probeConnectivity(timeoutMs = 3000): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await Promise.any(PROBE_URLS.map((u) => fetch(u, { method: 'HEAD', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal })));
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}

/** Failure messages that point at the network rather than at the place (fetch TypeErrors, aborts, timeouts). */
export function looksLikeNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network error|load failed|internet|offline|err_|timed? ?out|abort|unreachable|could not reach|can.t reach/i.test(message);
}
