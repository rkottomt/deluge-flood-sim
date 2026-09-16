/** Human-readable formatting for route status lines. */

/** "850 m", "3.4 km", "12 km". */
export function formatDistance(meters: number): string {
  if (!(meters >= 0) || !Number.isFinite(meters)) return '—';
  if (meters < 995) return `${Math.max(10, Math.round(meters / 10) * 10)} m`;
  if (meters < 9950) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

/** "< 1 min", "6 min", "1 h 05 min". */
export function formatDuration(seconds: number): string {
  if (!(seconds >= 0) || !Number.isFinite(seconds)) return '—';
  if (seconds < 30) return '< 1 min';
  const totalMin = Math.round(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h} h ${String(m).padStart(2, '0')} min`;
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
