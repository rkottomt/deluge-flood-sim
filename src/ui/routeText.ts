/**
 * Evacuation status text helpers (pure — unit-tested in Node).
 *
 * The router's messages are complete sentences meant to stand alone ("Via I-279 to Mount Washington —
 * 2.9 km, 3 min (…)"). The evacuation card already shows the shelter, distance and drive time as big
 * figures, so it only needs what's left: the roads taken and any warnings.
 */

/** "Via I-279 → Penn Lincoln Pkwy to Mount Washington — 2.9 km, 3 min (…)" → "Via I-279 → Penn Lincoln Pkwy · …". */
export function routeDetail(message: string | undefined, shelterName: string | undefined): string {
  let m = (message ?? '').trim();
  if (!m) return '';
  // Parenthesized warning (e.g. shallow water on the way) — keep it as a separate clause.
  let note = '';
  const paren = /\s*\(([^()]*)\)\s*$/.exec(m);
  if (paren) {
    note = paren[1].trim();
    m = m.slice(0, paren.index).trim();
  }
  // Trailing " — <distance>, <duration>".
  m = m.replace(/\s*[—–-]\s*[<\d][^—–]*?\b(?:m|km)\s*,\s*[^,]*?\b(?:s|min|h)\s*$/u, '').trim();
  // Destination (shown as the card heading).
  if (shelterName) {
    const esc = shelterName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    m = m.replace(new RegExp(`\\s*\\bto\\s+${esc}\\s*$`), '').trim();
  }
  if (/^route$/i.test(m)) m = '';
  const parts = [m, note].filter(Boolean).map((p) => p[0].toUpperCase() + p.slice(1));
  return parts.join(' · ');
}

/**
 * The router's blocked message usually starts with "No safe route — …", which the alarm heading already
 * says in capitals; keep only the advice.
 */
export function blockedAdvice(message: string | undefined): string {
  const rest = (message ?? '').replace(/^\s*no safe route\s*[—–:-]*\s*/i, '').trim();
  if (!rest) return 'Every road to a shelter is flooded. Shelter in place or move to higher floors.';
  return rest[0].toUpperCase() + rest.slice(1);
}
