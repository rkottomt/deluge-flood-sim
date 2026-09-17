/**
 * Numbers in the router's status sentence (RouteResult.message). A UI lays out routes from the structured
 * fields (lengthMeters, etaSeconds, via, wetMeters) with its own formatting; these follow the same rules as
 * the evacuation card (src/ui/format.ts) so the sentence and the card never disagree — plain spaces here,
 * and rounding boundaries handled so 996 m reads "1.0 km", not "1000 m".
 */

/** "850 m", "3.4 km", "124 km". */
export function formatDistance(meters: number): string {
  if (!(meters >= 0) || !Number.isFinite(meters)) return '—';
  if (meters < 995) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  if (meters < 99_950) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** "45 s", "6 min", "1 h 5 min", "2 h". */
export function formatDuration(seconds: number): string {
  if (!(seconds >= 0) || !Number.isFinite(seconds)) return '—';
  if (seconds < 59.5) return `${Math.round(seconds)} s`;
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/**
 * Tidy a road name for display: trim, collapse whitespace and fix TIGER-style route numbers
 * ("I- 376" → "I-376", "US Hwy  19" → "US Hwy 19"). Returns '' for missing names.
 */
export function normalizeStreetName(name: string | undefined): string {
  if (!name) return '';
  return name
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b(I|US|SR|PA|MD|NY|OH|VA|WV|NJ)-\s+(\d)/g, '$1-$2');
}
