/**
 * Evacuation status text helpers (pure — unit-tested in Node).
 *
 * The evacuation card shows the shelter, distance and drive time as big figures; these helpers lay out the rest from
 * the router's structured result (RouteResult.via / wetMeters / advice), formatted with the card's own number rules.
 */
import type { RouteResult } from '../contracts';
import { formatDistance } from './format';

/** Shown when there is no advice to show (no route object yet, or a router without structured fields). */
const DEFAULT_BLOCKED_ADVICE = 'Every road to a shelter is flooded. Shelter in place or move to higher floors.';

/** "Via I-279 → Penn Lincoln Pkwy · 120 m through shallow water — drive slowly" ('' when there is nothing to add). */
export function routeDetail(route: Pick<RouteResult, 'via' | 'wetMeters'> | null | undefined): string {
  return [
    route?.via?.length ? `Via ${route.via.join(' → ')}` : '',
    route?.wetMeters ? `${formatDistance(route.wetMeters)} through shallow water — drive slowly` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What to do when the route is blocked (the alarm heading already says "No safe route"). */
export function blockedAdvice(route: Pick<RouteResult, 'advice'> | null | undefined): string {
  const a = route?.advice?.trim();
  return a ? a[0].toUpperCase() + a.slice(1) : DEFAULT_BLOCKED_ADVICE;
}
