/**
 * CPU mirror of the post chain (exposure → ACES filmic → saturation restore → sRGB), single source of truth for its
 * constants: shaders/post.ts builds the WGSL tone mapper from these numbers.
 *
 * Hazard maps are data, not photography: a legend colour must look the same on screen. `hazardInput` solves for
 * the HDR shader colour whose tone-mapped result is a given display colour (Levenberg–Marquardt on the 3-channel map,
 * which mixes channels), with the peak kept under the bloom threshold so hazard water never glows. Colours the filmic
 * curve cannot reach under that peak come out as close as possible; the legend palettes (legend.ts) only use colours
 * it can reach, which tests/render/tonemap.test.ts checks.
 */

/** Base exposure (the renderer raises it slightly under heavy overcast). */
export const BASE_EXPOSURE = 0.7;
/** Post saturation restore (ACES desaturates midtones). */
export const POST_SATURATION = 1.1;
/** Bloom bright-pass threshold on the HDR peak channel. */
export const BLOOM_THRESHOLD = 2.2;
/** Highest HDR peak a hazard colour may use (below the bloom threshold, with margin for the specular term). */
export const HAZARD_MAX_PEAK = 2.1;

// ACES filmic, Stephen Hill fit: column-major 3×3 matrices (as in WGSL mat3x3f(col0, col1, col2)).
export const ACES_IN = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777] as const;
export const ACES_OUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602] as const;

export type RGB = [number, number, number];

const mul = (m: readonly number[], v: RGB): RGB => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];
const rrtOdt = (v: number) => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Linear HDR → linear display colour (before the sRGB OETF), exactly as fsTonemap (no bloom, no vignette). */
export function postProcess(hdr: RGB, exposure = BASE_EXPOSURE): RGB {
  const a = mul(ACES_IN, [Math.max(0, hdr[0]) * exposure, Math.max(0, hdr[1]) * exposure, Math.max(0, hdr[2]) * exposure]);
  const t = mul(ACES_OUT, [rrtOdt(a[0]), rrtOdt(a[1]), rrtOdt(a[2])]);
  const c: RGB = [clamp01(t[0]), clamp01(t[1]), clamp01(t[2])];
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [clamp01(l + (c[0] - l) * POST_SATURATION), clamp01(l + (c[1] - l) * POST_SATURATION), clamp01(l + (c[2] - l) * POST_SATURATION)];
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
  const starts: RGB[] = [
    [inverseGrey(target[0], exposure), inverseGrey(target[1], exposure), inverseGrey(target[2], exposure)],
    [target[0] * 1.8, target[1] * 1.8, target[2] * 1.8],
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
