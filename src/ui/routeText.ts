/**
 * Evacuation status text helpers (pure — unit-tested in Node).
 *
 * The evacuation card shows the shelter, distance and drive time as big figures; these helpers lay out the rest from
 * the router's structured result (RouteResult.via / wetMeters / advice / diagnosis / closure), formatted with the
 * card's own number rules.
 *
 * Blocked routes get the same treatment as good ones: the reason names itself and quotes the router's measurements
 * ("2.9 km of the 6.2 km drive out is under water") instead of one generic sentence, and where the app watched a
 * route close it says when that happened on the simulation clock. Where every road goes under at once and no detour
 * exists — a flat coast — that closing moment is the honest headline: it is the warning time.
 */
import type { RouteResult } from '../contracts';
import { formatClock, formatDistance, formatDuration } from './format';

/** Shown when there is no advice to show (no route object yet, or a router without structured fields). */
const DEFAULT_BLOCKED_ADVICE = 'Every road to a shelter is flooded. Shelter in place or move to higher floors.';
const SHELTER_IN_PLACE = 'Shelter in place on higher floors.';

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

/** One short clause naming why there is no route, for the always-visible chip. */
export function blockedSummary(route: Pick<RouteResult, 'advice' | 'reason' | 'diagnosis'> | null | undefined): string {
  const d = route?.diagnosis;
  switch (route?.reason) {
    case 'start-flooded':
      return d ? `Start is under ${formatDepth(d.startDepth)} of water` : 'The start is under water';
    case 'start-roads-flooded':
      return 'Every road near the start is under water';
    case 'shelters-flooded':
      return d && d.shelters > 1 ? `All ${d.shelters} shelters are under water` : 'The shelter is under water';
    case 'cut-off':
      return d && !d.cutRoute ? 'No road connects this start to a shelter' : 'Every road to a shelter is under water';
    default:
      return blockedAdvice(route);
  }
}

/** The sentences a blocked evacuation card shows, in reading order. */
export interface BlockedText {
  /** Why there is no route, with the numbers the router measured from the flood field. */
  reason: string;
  /** When the last route closed and what it was, or '' when this start never had one. */
  closure: string;
  /** What to do. */
  action: string;
}

/**
 * Lay out a blocked route: the reason with its numbers, the moment the last route closed, and the advice.
 * Falls back to the router's own `advice` sentence when a result carries no diagnosis.
 */
export function blockedText(route: Pick<RouteResult, 'advice' | 'reason' | 'diagnosis' | 'closure'> | null | undefined): BlockedText {
  const d = route?.diagnosis;
  let reason = '';
  if (d) {
    switch (route?.reason) {
      case 'start-flooded':
        reason = `The start itself is under ${formatDepth(d.startDepth)} of water — don't drive into floodwater.`;
        break;
      case 'start-roads-flooded':
        reason = d.startRoads > 1 ? `All ${d.startRoads} roads near the start are under water.` : 'The only road near the start is under water.';
        break;
      case 'shelters-flooded':
        reason = d.shelters > 1 ? `All ${d.shelters} shelters are under water themselves.` : 'The shelter is under water itself.';
        break;
      case 'cut-off':
        reason = d.cutRoute
          ? `Every road to a shelter is under water: ${formatDistance(d.cutRoute.floodedMeters)} of the ` +
            `${formatDistance(d.cutRoute.lengthMeters)} drive to ${d.cutRoute.shelterName || 'the nearest shelter'} is flooded.`
          : 'No road in this area connects the start to a shelter.';
        break;
      default:
        reason = '';
    }
  }
  if (!reason) {
    // No diagnosis, or a reason with nothing to add: the router's own sentence, minus the advice it already carries.
    const a = blockedAdvice(route);
    reason = a.replace(SHELTER_IN_PLACE, '').trim() || a;
  }
  return { reason, closure: closureText(route), action: SHELTER_IN_PLACE };
}

/**
 * "Last route closed at T+00:14:20, 4 min after it was planned — 3.8 km, 8 min to Canal Street." The clock is the
 * simulation clock in the top bar, so the moment can be read off the screen; '' when nothing closed.
 */
export function closureText(route: Pick<RouteResult, 'closure'> | null | undefined): string {
  const c = route?.closure;
  if (!c || !Number.isFinite(c.simTime)) return '';
  const held = c.openSeconds >= 1 ? `, ${formatDuration(c.openSeconds)} after it was planned` : '';
  const was = `${formatDistance(c.lengthMeters)}, ${formatDuration(c.etaSeconds)}${c.shelterName ? ` to ${c.shelterName}` : ''}`;
  return `Last route closed at ${formatClock(c.simTime)}${held} — ${was}.`;
}

/** A depth, one decimal, like the probe readout. */
function formatDepth(m: number): string {
  return `${(Number.isFinite(m) ? m : 0).toFixed(1)} m`;
}
