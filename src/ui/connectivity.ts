/**
 * Network reachability for live areas (the location picker). Pure / DOM-free so it can be unit-tested.
 */

import { DATA_HOST_PROBES, probeReachable } from '../data/net';

/**
 * True when at least one of the data hosts the live loader needs answers within `timeoutMs` (see probeReachable: an
 * opaque no-cors response proves reachability; navigator.onLine alone is not trusted).
 */
export function probeConnectivity(timeoutMs = 3000): Promise<boolean> {
  return probeReachable(DATA_HOST_PROBES, timeoutMs);
}

/** Failure messages that point at the network rather than at the place (fetch TypeErrors, aborts, timeouts). */
export function looksLikeNetworkError(message: string): boolean {
  return /failed to fetch|networkerror|network error|load failed|internet|offline|err_|timed? ?out|abort|unreachable|could not reach|can.t reach/i.test(message);
}
