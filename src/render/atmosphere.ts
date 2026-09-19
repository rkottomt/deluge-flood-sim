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

// ────────────────────────────────────────────────────────────────────────────────────────────
// Sun and sky (analytic, CPU side)
// ────────────────────────────────────────────────────────────────────────────────────────────
//
// The shader's sky is a cheap gradient (skyRadiance in shaders/common.ts). What makes it read as *air* rather than
// a ramp is that the three colours feeding it — zenith, the cool horizon away from the sun, and the warm horizon
// around it — come from the same physics the sun colour does: Rayleigh + aerosol extinction along the sun's path
// through the atmosphere. Drop the sun toward the horizon and the path lengthens (Kasten–Young air mass), blue is
// scattered out of the beam first, and the sun, the horizon under it and every hazy distance turn amber together.
// Doing it here, once per frame on the CPU, keeps the fragment shader at a handful of instructions.

export type Vec3 = [number, number, number];

/** Rayleigh optical depth at sea level for the RGB primaries: 0.008735·λ⁻⁴·⁰⁸ (λ in µm, 680/550/440 nm). */
const TAU_RAYLEIGH: Vec3 = [0.0421, 0.1001, 0.2489];
/** Aerosol (Mie) optical depth, turbidity ≈ 2.5 continental air: 0.10·(λ/0.55)⁻¹·³. */
const TAU_AEROSOL: Vec3 = [0.0759, 0.1, 0.1337];

/**
 * Relative air mass at a solar elevation (degrees), Kasten & Young 1989. 1 at the zenith, ≈ 2 at 30°, ≈ 38 at the
 * horizon — the reason a low sun is orange and a high one is white.
 */
export function airMass(elevationDeg: number): number {
  const el = Math.max(-2, Math.min(90, elevationDeg));
  const rad = (el * Math.PI) / 180;
  return 1 / (Math.sin(rad) + 0.15 * Math.pow(el + 3.885, -1.253));
}

/** Direct-beam transmittance per channel at a solar elevation, normalised so the strongest channel is 1. */
export function sunTransmittance(elevationDeg: number): Vec3 {
  const m = airMass(elevationDeg);
  const t: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) t[i] = Math.exp(-(TAU_RAYLEIGH[i] + TAU_AEROSOL[i]) * m);
  const peak = Math.max(t[0], t[1], t[2], 1e-6);
  return [t[0] / peak, t[1] / peak, t[2] / peak];
}

/** Unit vector toward the sun. Azimuth is degrees clockwise from north (the camera's convention). */
export function sunDirection(azimuthDeg: number, elevationDeg: number): Vec3 {
  const az = (azimuthDeg * Math.PI) / 180;
  const el = (elevationDeg * Math.PI) / 180;
  const c = Math.cos(el);
  return [c * Math.sin(az), Math.sin(el), -c * Math.cos(az)];
}

const mix3 = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];

/** Midday reference colours — the look the demo shipped with, kept exactly at the default sun elevation. */
const ZENITH_NOON: Vec3 = [0.15, 0.33, 0.78];
const HORIZON_NOON: Vec3 = [0.66, 0.78, 0.94];
/** Late-evening zenith: darker and a touch violet, because the beam lighting the upper air is already reddened. */
const ZENITH_DUSK: Vec3 = [0.085, 0.145, 0.42];
/** Late-evening horizon *away* from the sun: the earth's own shadow rising, blue-grey rather than orange. */
const HORIZON_DUSK: Vec3 = [0.36, 0.42, 0.58];

export interface SkyColors {
  /** Linear HDR sky radiance straight up. */
  zenith: Vec3;
  /** Linear HDR sky radiance at the horizon away from the sun. */
  horizon: Vec3;
  /** Linear HDR sky radiance at the horizon around the sun (the warm band at low elevations). */
  sunTint: Vec3;
  /** Linear HDR radiance of the sun's direct beam (already scaled by the renderer's exposure convention). */
  sun: Vec3;
}

/** Sun intensity at the default 40° elevation. Everything else is relative to it, so the default look is unchanged. */
export const SUN_INTENSITY = 3.1;
/** The elevation the shipped daylight look was tuned at. */
export const DEFAULT_SUN_ELEVATION = 40;
export const DEFAULT_SUN_AZIMUTH = 155;

/** The beam colour the shipped daylight look was tuned with; kept exactly at DEFAULT_SUN_ELEVATION and above. */
const SUN_NOON: Vec3 = [1, 0.93, 0.8];

/**
 * How far into "low sun" territory an elevation is: 0 at the default daylight elevation and above, 1 at the
 * horizon. Everything that separates golden hour from midday — the warm horizon band, the wider sun aureole, the
 * ground bounce, the reddened beam — is driven by this one number, so they can never disagree with each other.
 */
export function sunLowness(elevationDeg: number): number {
  return smoothstep(DEFAULT_SUN_ELEVATION, 0, Math.max(-4, Math.min(90, elevationDeg)));
}

/**
 * Sky and sun colours for a solar elevation (degrees). At DEFAULT_SUN_ELEVATION this returns the shipped daylight
 * palette exactly; below it the horizon warms around the sun, the zenith deepens and the beam reddens, all driven
 * by the same air mass.
 */
export function skyColors(elevationDeg: number): SkyColors {
  const el = Math.max(-4, Math.min(90, elevationDeg));
  const low = sunLowness(el);
  /** Below the horizon the beam is gone; the sky keeps a little glow. */
  const above = smoothstep(-4, 1.5, el);

  const T = mix3(SUN_NOON, sunTransmittance(el), low);
  // A low sun lights the air it passes through sideways, so the warm band is BRIGHTER than the cool sky, not dimmer.
  const warm = scale3([T[0], T[1] * 0.78 + 0.1, T[2] * 0.5 + 0.06], 1.05 + 1.15 * low);

  const zenith = mix3(ZENITH_NOON, ZENITH_DUSK, low);
  const horizon = mix3(HORIZON_NOON, HORIZON_DUSK, low);
  const sunTint = mix3(horizon, warm, low * 0.92);
  // The beam dims as it reddens, but nothing like the full extinction: a low sun striking a slope face-on is one
  // of the brightest things in a landscape, and it is that — bright warm light against deep cool shadow — that
  // makes golden hour look like golden hour rather than like dusk.
  const beam = SUN_INTENSITY * (0.55 + 0.45 * above) * (1 - 0.12 * low);
  return {
    zenith: scale3(zenith, 0.35 + 0.65 * above),
    horizon: scale3(horizon, 0.3 + 0.7 * above),
    sunTint: scale3(sunTint, 0.25 + 0.75 * above),
    sun: scale3(T, beam * above),
  };
}

/** How the scene is lit: where the sun is, and how hard the terrain shading is pushed. */
export interface LightingSettings {
  /** Degrees clockwise from north. */
  azimuthDeg: number;
  /** Degrees above the horizon. */
  elevationDeg: number;
  /** Cast-shadow strength on photo-textured ground, 0…1 (the imagery already holds some of its own shading). */
  shadowStrength: number;
  /** Sky-visibility (ambient occlusion) strength, 0…1. */
  aoStrength: number;
  /** How far the hillshade departs from flat ground on photo-textured terrain, 0…1. */
  reliefStrength: number;
}

/**
 * Named looks. 'daylight' is the shipped one: a late-morning sun from the south-south-east, consistent with the
 * shadows already baked into mid-morning USGS imagery, so the cast shadows reinforce the photo's instead of
 * fighting it. 'goldenHour' is the hero-screenshot look — an evening sun low in the west-south-west, which throws
 * the long hill shadows across the valley that make the relief readable at a glance.
 */
export const LIGHTING_PRESETS = {
  daylight: { azimuthDeg: DEFAULT_SUN_AZIMUTH, elevationDeg: DEFAULT_SUN_ELEVATION, shadowStrength: 0.8, aoStrength: 0.5, reliefStrength: 0.62 },
  goldenHour: { azimuthDeg: 205, elevationDeg: 11, shadowStrength: 0.8, aoStrength: 0.5, reliefStrength: 0.75 },
  morning: { azimuthDeg: 104, elevationDeg: 21, shadowStrength: 0.9, aoStrength: 0.55, reliefStrength: 0.68 },
} satisfies Record<string, LightingSettings>;

export type LightingPreset = keyof typeof LIGHTING_PRESETS;

/**
 * Aerial imagery is a photograph taken under a particular sun, and its brightness already encodes how much light
 * flat ground received that morning. Relighting it therefore has to be *relative*: the renderer reproduces the
 * reference illumination on flat ground whatever the sun does, and spends the change on what actually reads —
 * hue, the depth of the relief, and where the shadows fall. Without this, dropping the sun to 12° would simply
 * divide the whole photograph by three and call the result evening.
 *
 * The exponent leaves a little of the real dimming in (about 15 % at golden hour) so a low sun still feels like
 * one; at DEFAULT_SUN_ELEVATION the factor is exactly 1 and the shipped look is untouched.
 */
export function imageryRelightFactor(elevationDeg: number): number {
  const flat = Math.max(Math.sin((Math.max(-5, Math.min(90, elevationDeg)) * Math.PI) / 180), 0.2);
  const reference = Math.sin((DEFAULT_SUN_ELEVATION * Math.PI) / 180);
  return Math.pow(reference / flat, 0.85);
}

/** A lighting preset by name, or the daylight default for anything unknown. */
export function lightingPreset(name: string | undefined): LightingSettings {
  return { ...(LIGHTING_PRESETS[name as LightingPreset] ?? LIGHTING_PRESETS.daylight) };
}
