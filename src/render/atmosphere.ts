/**
 * Storm atmosphere: how overcast the sky is for the rain the viewer stands in (sky grey, sun dimming, haze colour and
 * exposure all follow it), and how much the air thickens.
 *
 * Global rain greys the whole sky. A storm cell greys it when the camera is under the cell's cloud deck, fading across
 * the deck's own thickness to a light tint from above (where the deck and rain shaft mark the cell and the flooding
 * under it is the subject). Both are capped: zooming in under a storm must never wash the view out (Ellicott City
 * below ~1 km used to turn uniformly grey), so a storm cell alone stops at STORM_OVERCAST_MAX and the haze it adds is
 * bounded by HAZE_OVERCAST_MAX.
 */
import { smoothstep } from './math';

/** Overcast of the heaviest rain, before the storm cap. Also the overall ceiling (exposure is normalised to it). */
export const OVERCAST_MAX = 0.92;
/** A storm cell on its own never greys the sky past this, even from right under its deck. */
export const STORM_OVERCAST_MAX = 0.6;
/** Share of a storm cell's overcast that remains with the camera above its deck. */
export const ABOVE_DECK_SHARE = 0.3;
/** Haze thickens with overcast up to this level and no further. */
export const HAZE_OVERCAST_MAX = 0.6;

/** Vertical extent of a storm cloud deck in world units (exaggerated y): the camera is under it below `base`. */
export interface CloudDeck {
  base: number;
  top: number;
}

/** Overcast 0..1 of rain that is heavy (mm/hr) where it falls. */
export function rainOvercast(rainMmHr: number): number {
  return smoothstep(0.5, 60, Math.max(0, rainMmHr)) * OVERCAST_MAX;
}

/**
 * Sky overcast for `globalRain` (mm/hr everywhere) plus `stormRain` (mm/hr of storm cells over the camera target), with
 * the eye at world height `eyeY` and the storms' deck (null: treat the camera as under it).
 */
export function overcastFor(globalRain: number, stormRain: number, eyeY: number, deck: CloudDeck | null): number {
  let under = 1;
  if (deck && stormRain > 0) under = 1 - smoothstep(deck.base, Math.max(deck.top, deck.base + 1e-3), eyeY);
  const storm = Math.min(STORM_OVERCAST_MAX, rainOvercast(stormRain)) * (ABOVE_DECK_SHARE + (1 - ABOVE_DECK_SHARE) * under);
  return Math.min(OVERCAST_MAX, 1 - (1 - rainOvercast(globalRain)) * (1 - storm));
}

/** Haze density multiplier for an overcast level. */
export function hazeBoost(overcast: number): number {
  return 1 + 1.2 * Math.min(Math.max(0, overcast), HAZE_OVERCAST_MAX);
}

/**
 * Half-thickness (m) of a storm's cloud-deck marker for a footprint radius of R metres (see buildMarkers in
 * overlays.ts; the marker shader fades the deck out around a camera inside it).
 */
export function cloudDeckHalfThickness(R: number): number {
  return Math.max(R * 0.18, 40);
}
