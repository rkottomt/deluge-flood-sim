/**
 * CPU mirror of the post chain, single source of truth for its constants: shaders/post.ts builds the WGSL tone
 * mapper from these numbers, so the two can never drift.
 *
 * The chain, in order (fsTonemap applies exactly these steps):
 *   1. exposure
 *   2. HIGHLIGHT CROSSTALK — above the bloom threshold, colour is pulled toward its own peak channel. Without it
 *      a per-channel filmic curve clips a bright saturated colour to a primary (a blown sky goes cyan, a sun glint
 *      goes yellow); with it, bright things roll off to white the way film does. Its onset is CROSSTALK_LO, set
 *      equal to BLOOM_THRESHOLD, so at normal exposures no hazard colour reaches it (hazardInput caps them at
 *      HAZARD_MAX_PEAK < BLOOM_THRESHOLD). Under a heavy overcast the exposure rises enough to push the top band
 *      into it; that is harmless, because the solve below runs at the frame's own exposure and compensates
 *      exactly — which the tests check at every exposure the renderer can produce.
 *   3. LOG-PIVOT CONTRAST — the filmic grade, a power law about 18 % grey. This is where the picture stops looking
 *      like a flat photo composite: it is applied to scene-referred light BEFORE the tone curve, so the curve's own
 *      shoulder still does the highlight rolloff instead of the grade clipping it.
 *   4. ACES filmic (Stephen Hill fit, with input/output matrices) — the tone curve itself.
 *   5. SATURATION RESTORE — ACES desaturates midtones; this puts a touch back.
 *   6. SPLIT TONE — a whisper of a gamma/gain per channel: cool shadows, warm highlights. Deliberately small
 *      (a few /255): the ground texture is real aerial photography and a visible grade would falsify it.
 * The vignette, chromatic aberration, depth of field and dither in fsTonemap are geometry, not colour, and are
 * not mirrored here — no hazard colour depends on them (see `postProcess`).
 *
 * Hazard maps are data, not photography: a legend colour must look the same on screen. `hazardInput` solves for
 * the HDR shader colour whose tone-mapped result is a given display colour (Levenberg-Marquardt on the 3-channel map,
 * which mixes channels), with the peak kept under the bloom threshold so hazard water never glows. Because the solve
 * runs against `postProcess`, the grade above can be re-tuned freely and the legend stays exact: only the reachable
 * gamut can change, and tests/render/tonemap.test.ts is the gate on that.
 */

/** Base exposure (the renderer raises it slightly under heavy overcast). */
export const BASE_EXPOSURE = 0.7;
/** Post saturation restore (ACES desaturates midtones). */
export const POST_SATURATION = 1.1;
/** Bloom bright-pass threshold on the HDR peak channel. */
export const BLOOM_THRESHOLD = 2.2;
/** Highest HDR peak a hazard colour may use (below the bloom threshold, with margin for the specular term). */
export const HAZARD_MAX_PEAK = 2.1;
/**
 * Bloom knee (HDR units above the threshold). The bright pass is exactly zero at or below the threshold and its
 * response is C1 there: it ramps quadratically over the knee, then becomes linear. A plain step (or a smoothstep
 * starting below the threshold) makes every surface just over the line contribute its FULL colour, and that hard
 * edge is what blurs into a halo ring. See BLOOM_WGSL.
 */
export const BLOOM_KNEE = 1.0;
/**
 * How much of the bloom chain's summed octaves is added back to the frame. Low because the chain sums five
 * octaves: each one carries roughly the energy the old single blur did, so the same visible glow needs about a
 * fifth of the old mix.
 */
export const BLOOM_MIX = 0.055;
/**
 * Vignette falloff, as lens radius (0 at the centre, 1 at a corner): nothing until VIGNETTE_INNER, then a smooth
 * ramp. The old falloff was a parabola from the centre out, which tinted the middle of the frame where the hazard
 * map has to be read; this leaves the centre and the short edges alone and does its work in the corners.
 */
export const VIGNETTE_INNER = 0.55;
export const VIGNETTE_OUTER = 1.15;
/** Crosstalk: how far a colour is pulled toward its peak channel once it is well above CROSSTALK_LO. */
export const CROSSTALK = 0.5;
/** Crosstalk onset, on exposure-scaled light. Equal to BLOOM_THRESHOLD on purpose (see the module note). */
export const CROSSTALK_LO = 2.2;
/** Crosstalk saturates here. */
export const CROSSTALK_HI = 9.0;
/** Filmic grade: power-law contrast about GRADE_PIVOT, applied to scene-referred light before the tone curve. */
export const GRADE_CONTRAST = 1.09;
/** Grade pivot: 18 % grey, the level the contrast law leaves unmoved. */
export const GRADE_PIVOT = 0.18;
/** Split tone, per channel, on the tone-mapped (display-referred) colour: c -> c^gamma * gain. */
export const GRADE_GAMMA = [1.008, 1.0, 0.955] as const;
export const GRADE_GAIN = [1.012, 1.0, 0.985] as const;

// ACES filmic, Stephen Hill fit: column-major 3×3 matrices (as in WGSL mat3x3f(col0, col1, col2)).
export const ACES_IN = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777] as const;
export const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602] as const;

/**
 * Bloom bright-pass response to a colour's peak channel, mirroring BLOOM_WGSL's soft knee. Two properties matter
 * and are tested (tests/render/tonemap.test.ts):
 *   • it is exactly 0 at and below BLOOM_THRESHOLD — the contract that keeps hazard water from glowing, since
 *     `hazardInput` caps every hazard colour at HAZARD_MAX_PEAK < BLOOM_THRESHOLD;
 *   • it is C1 at the threshold (value AND slope zero), so there is no step for the blur to smear into a halo.
 */
export function bloomContribution(peak: number): number {
  const x = peak - BLOOM_THRESHOLD;
  if (!(x > 0)) return 0;
  return x < BLOOM_KNEE ? (x * x) / (2 * BLOOM_KNEE) : x - 0.5 * BLOOM_KNEE;
}

export type RGB = [number, number, number];

const mul = (m: readonly number[], v: RGB): RGB => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];
const rrtOdt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const smoothstep01 = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/**
 * Steps 2-3 of the chain: highlight crosstalk, then the log-pivot contrast grade. Exposure is already applied.
 * Exported so the WGSL and any analysis share one definition of "the grade".
 */
export function grade(x: RGB): RGB {
  const peak = Math.max(x[0], x[1], x[2]);
  const k = CROSSTALK * smoothstep01(CROSSTALK_LO, CROSSTALK_HI, peak);
  const c = GRADE_CONTRAST;
  const P = GRADE_PIVOT;
  const out = [0, 0, 0] as RGB;
  for (let i = 0; i < 3; i++) {
    const v = x[i] + (peak - x[i]) * k;
    out[i] = P * Math.pow(Math.max(v, 1e-6) / P, c);
  }
  return out;
}

/**
 * Linear HDR → linear display colour (before the sRGB OETF), exactly as fsTonemap's colour path.
 *
 * Bloom, vignette, chromatic aberration, depth of field and the dither are deliberately NOT mirrored: they are
 * geometry (where a pixel is / what is behind it), not a colour transform, and hazard colours are solved to be
 * below the bloom threshold, outside the vignette's and the aberration's reach in the readable centre of frame,
 * and unaffected by a blur that mixes a colour with itself.
 */
export function postProcess(hdr: RGB, exposure = BASE_EXPOSURE): RGB {
  const g = grade([Math.max(0, hdr[0]) * exposure, Math.max(0, hdr[1]) * exposure, Math.max(0, hdr[2]) * exposure]);
  const a = mul(ACES_IN, g);
  const t = mul(ACES_OUT, [rrtOdt(a[0]), rrtOdt(a[1]), rrtOdt(a[2])]);
  const c: RGB = [clamp01(t[0]), clamp01(t[1]), clamp01(t[2])];
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const s: RGB = [clamp01(l + (c[0] - l) * POST_SATURATION), clamp01(l + (c[1] - l) * POST_SATURATION), clamp01(l + (c[2] - l) * POST_SATURATION)];
  return [
    clamp01(Math.pow(s[0], GRADE_GAMMA[0]) * GRADE_GAIN[0]),
    clamp01(Math.pow(s[1], GRADE_GAMMA[1]) * GRADE_GAIN[1]),
    clamp01(Math.pow(s[2], GRADE_GAMMA[2]) * GRADE_GAIN[2]),
  ];
}

/** HDR shader input whose display colour is as close as possible to `target` (linear), peak ≤ maxPeak. */
export function hazardInput(target: RGB, exposure = BASE_EXPOSURE, maxPeak = HAZARD_MAX_PEAK): RGB {
  // Bounded parametrisation x = maxPeak·σ(u) keeps every iterate valid; Levenberg–Marquardt on u from a couple of
  // starting points (the per-channel grey-axis inverse, and a plain scaled target).
  const toX = (u: RGB): RGB => [maxPeak / (1 + Math.exp(-u[0])), maxPeak / (1 + Math.exp(-u[1])), maxPeak / (1 + Math.exp(-u[2]))];
  const toU = (x: number) => {
    const f = Math.min(0.999, Math.max(1e-4, x / maxPeak));
    return Math.log(f / (1 - f));
  };
  const residual = (u: RGB): RGB => {
    const y = postProcess(toX(u), exposure);
    return [y[0] - target[0], y[1] - target[1], y[2] - target[2]];
  };
  const sq = (e: RGB) => e[0] * e[0] + e[1] * e[1] + e[2] * e[2];
  // Several starting points, because the residual is not convex: the ACES output matrix subtracts green and blue
  // from red, so a deep saturated navy has a basin where red is pinned at 0 and the solve stalls 12/255 short.
  // A grey-axis start plus a scaled target plus three fixed brightness levels covers every legend colour (the
  // solve is cached per mode and exposure, so the extra restarts cost nothing per frame).
  const starts: RGB[] = [
    [inverseGrey(target[0], exposure), inverseGrey(target[1], exposure), inverseGrey(target[2], exposure)],
    [target[0] * 1.8, target[1] * 1.8, target[2] * 1.8],
    [0.05, 0.05, 0.05],
    [0.5, 0.5, 0.5],
    [1.5, 1.5, 1.5],
  ];
  let bestX: RGB = toX([toU(starts[0][0]), toU(starts[0][1]), toU(starts[0][2])]);
  let bestCost = Infinity;
  for (const s0 of starts) {
    let u: RGB = [toU(s0[0]), toU(s0[1]), toU(s0[2])];
    let e = residual(u);
    let cost = sq(e);
    let lambda = 1e-3;
    for (let it = 0; it < 100 && cost > 1e-12; it++) {
      const J: number[] = []; // column-major 3×3: J[k·3 + r] = ∂e_r/∂u_k
      for (let k = 0; k < 3; k++) {
        const h = 1e-4;
        const up: RGB = [u[0], u[1], u[2]];
        up[k] += h;
        const ep = residual(up);
        J.push((ep[0] - e[0]) / h, (ep[1] - e[1]) / h, (ep[2] - e[2]) / h);
      }
      const A: number[] = new Array(9).fill(0);
      const g: RGB = [0, 0, 0];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
          let v = 0;
          for (let k = 0; k < 3; k++) v += J[r * 3 + k] * J[c * 3 + k];
          A[c * 3 + r] = v;
        }
        g[r] = J[r * 3] * e[0] + J[r * 3 + 1] * e[1] + J[r * 3 + 2] * e[2];
      }
      let improved = false;
      for (let tries = 0; tries < 16 && !improved; tries++) {
        const M = A.slice();
        for (let k = 0; k < 3; k++) M[k * 3 + k] += lambda * (A[k * 3 + k] + 1e-9);
        const step = solve3(M, g);
        if (step) {
          const un: RGB = [u[0] - step[0], u[1] - step[1], u[2] - step[2]];
          const en = residual(un);
          const cn = sq(en);
          if (cn < cost) {
            u = un;
            e = en;
            cost = cn;
            lambda = Math.max(1e-9, lambda / 3);
            improved = true;
            continue;
          }
        }
        lambda *= 4;
      }
      if (!improved) break;
    }
    if (cost < bestCost) {
      bestCost = cost;
      bestX = toX(u);
    }
  }
  return bestX;
}

/** Scalar input whose grey tone-mapped value is `y` (bisection on the monotone curve). */
function inverseGrey(y: number, exposure: number): number {
  let lo = 0;
  let hi = 64;
  for (let i = 0; i < 50; i++) {
    const mid = 0.5 * (lo + hi);
    if (postProcess([mid, mid, mid], exposure)[0] < y) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

/** Solve M·s = e for a column-major 3×3 M (Cramer); null when singular. */
function solve3(J: number[], e: RGB): RGB | null {
  const [a, d, g, b, e2, h, c, f, i] = J; // columns → rows a b c / d e f / g h i
  const det = a * (e2 * i - f * h) - b * (d * i - f * g) + c * (d * h - e2 * g);
  if (!(Math.abs(det) > 1e-18)) return null;
  const inv = 1 / det;
  return [
    (e[0] * (e2 * i - f * h) - b * (e[1] * i - f * e[2]) + c * (e[1] * h - e2 * e[2])) * inv,
    (a * (e[1] * i - f * e[2]) - e[0] * (d * i - f * g) + c * (d * e[2] - e[1] * g)) * inv,
    (a * (e2 * e[2] - e[1] * h) - b * (d * e[2] - e[1] * g) + e[0] * (d * h - e2 * g)) * inv,
  ];
}

export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export function linearToHex(c: RGB): string {
  return '#' + c.map((v) => Math.round(clamp01(linearToSrgb(v)) * 255).toString(16).padStart(2, '0')).join('');
}
