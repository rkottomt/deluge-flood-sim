/**
 * The reference flood edge: a drawable form of the grid-convergence study's finest run.
 *
 * `src/data/referenceOverlay.ts` ships and decodes the reference's MAX-DEPTH field on the preset's own grid. What the
 * renderer wants is not that field but its WET EDGE — the boundary of "max depth ≥ the hazard threshold" — drawn as a
 * crisp line over the live water, because a line next to the live shoreline is a comparison anyone can read in a
 * second, while a second translucent tint over the first only produces a third colour nobody can attribute.
 *
 * WHY A SIGNED DISTANCE FIELD, NOT A MASK. A binary mask sampled per pixel gives a line whose width swims with the
 * camera: bilinear interpolation of 0/1 has a gradient that varies by a factor of two between cell centres and
 * diagonals, and at a pixel-per-cell zoom the contour breaks into dashes. So the CPU turns the mask into a signed
 * distance in CELLS (negative inside the reference flood, positive outside), clamped to ±`REFERENCE_RANGE_CELLS` and
 * quantised to u8. Its gradient is 1 cell per cell everywhere, so the shader draws a line of constant width, sets that
 * width in PIXELS (from the camera's own pixel footprint), and anti-aliases it — the same line at every zoom, with no
 * geometry, no marching squares and no CPU work per frame.
 *
 * GEOMETRY. One byte per cell of the preset grid, row-major, r8unorm. The distance is exact (a two-pass Euclidean
 * distance transform, Felzenszwalb & Huttenlocher 2012), not a chamfer approximation, so the line is smooth where the
 * flood edge runs diagonally across cells. Cells outside the grid count as neither wet nor dry, so a river leaving the
 * domain produces no spurious line along the map edge.
 */

/** Distance range the field encodes, in cells. ±8 cells is far more than any line width and keeps the step fine. */
export const REFERENCE_RANGE_CELLS = 8;

/** Code 128 is distance 0 (the edge itself); one code is 2·range/255 cells ≈ 0.063 cells. */
const CODE_ZERO = 128;

/** Encode a signed distance in cells to the u8 code the shader decodes. */
export function encodeReferenceDistance(cells: number): number {
  const t = Math.max(-1, Math.min(1, cells / REFERENCE_RANGE_CELLS));
  return Math.max(0, Math.min(255, Math.round(CODE_ZERO + t * (255 - CODE_ZERO))));
}

/** Inverse of {@link encodeReferenceDistance} — the value the shader's `refDistance` returns, in cells. */
export function decodeReferenceDistance(code: number): number {
  return ((code - CODE_ZERO) / (255 - CODE_ZERO)) * REFERENCE_RANGE_CELLS;
}

/**
 * Squared Euclidean distance transform of one row of `f` (Felzenszwalb & Huttenlocher's lower envelope of parabolas),
 * in place. `f[i]` is the cost at i (0 at a seed, +∞ elsewhere); afterwards `f[i]` is min over j of f[j] + (i−j)².
 * `v` and `z` are scratch of length n and n+1.
 */
function dt1d(f: Float64Array, n: number, v: Int32Array, z: Float64Array, out: Float64Array): void {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const d = q - v[k];
    out[q] = d * d + f[v[k]];
  }
}

/** Squared Euclidean distance (in cells²) from every cell to the nearest cell where `seed` is 1. */
function edtSquared(seed: Uint8Array, nx: number, ny: number): Float64Array {
  const INF = 1e20;
  const g = new Float64Array(nx * ny);
  for (let k = 0; k < g.length; k++) g[k] = seed[k] ? 0 : INF;
  const col = new Float64Array(ny);
  const colOut = new Float64Array(ny);
  const row = new Float64Array(nx);
  const rowOut = new Float64Array(nx);
  const v = new Int32Array(Math.max(nx, ny));
  const z = new Float64Array(Math.max(nx, ny) + 1);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) col[j] = g[j * nx + i];
    dt1d(col, ny, v, z, colOut);
    for (let j = 0; j < ny; j++) g[j * nx + i] = colOut[j];
  }
  for (let j = 0; j < ny; j++) {
    const base = j * nx;
    for (let i = 0; i < nx; i++) row[i] = g[base + i];
    dt1d(row, nx, v, z, rowOut);
    for (let i = 0; i < nx; i++) g[base + i] = rowOut[i];
  }
  return g;
}

/**
 * Signed distance (u8, see the header) to the edge of `{ maxDepth ≥ threshold }`, negative inside the flood.
 *
 * Both sides are measured to the nearest cell of the other class and the two are combined, so the zero crossing sits
 * half a cell outside the last wet cell centre — where the shoreline actually is on a cell-centred grid. Costs two
 * exact distance transforms (~40 ms on a 1024² grid, once when the overlay is first switched on), and nothing per
 * frame. Throws only on a length mismatch: a caller with the wrong grid is a bug, not a degraded overlay.
 */
export function buildReferenceEdgeField(maxDepth: Float32Array, nx: number, ny: number, threshold: number): Uint8Array {
  if (maxDepth.length !== nx * ny) throw new Error(`reference field is ${maxDepth.length} cells, expected ${nx * ny}`);
  const wet = new Uint8Array(nx * ny);
  const dry = new Uint8Array(nx * ny);
  let wetCells = 0;
  for (let k = 0; k < maxDepth.length; k++) {
    if (maxDepth[k] >= threshold) {
      wet[k] = 1;
      wetCells++;
    } else {
      dry[k] = 1;
    }
  }
  const out = new Uint8Array(nx * ny);
  // All wet or all dry: no edge anywhere. Encode "far outside" so the shader draws nothing.
  if (wetCells === 0 || wetCells === maxDepth.length) {
    out.fill(encodeReferenceDistance(REFERENCE_RANGE_CELLS));
    return out;
  }
  const toWet = edtSquared(wet, nx, ny);
  const toDry = edtSquared(dry, nx, ny);
  for (let k = 0; k < out.length; k++) {
    // Inside: −(distance to the nearest dry cell) + ½; outside: +(distance to the nearest wet cell) − ½.
    const d = wet[k] ? -(Math.sqrt(toDry[k]) - 0.5) : Math.sqrt(toWet[k]) - 0.5;
    out[k] = encodeReferenceDistance(d);
  }
  return out;
}

/**
 * WGSL shared by the terrain and water passes: decode the field and return how much of this fragment is the reference
 * flood edge. Kept here, next to the encoder, so the two halves of the format cannot drift apart.
 *
 * `F.reference`: x = strength (0 = off, and the only branch the shader takes when the overlay is not in use),
 * y = the encoded range in cells, z = line half-width in pixels, w = unused. Requires `refTex` at @binding(13) and
 * the filtering sampler `linSamp`.
 */
export const REFERENCE_WGSL = /* wgsl */ `
/** Signed distance to the reference flood edge at grid position g, in CELLS (negative inside the flood). */
fn refDistance(g: vec2f) -> f32 {
  let code = textureSampleLevel(refTex, linSamp, g / F.grid, 0.0).r;
  return (code - 128.0 / 255.0) / (127.0 / 255.0) * F.reference.y;
}

/**
 * The reference edge at grid position g for a fragment whose pixel covers \`pxCells\` cells:
 * x = the line itself, y = a halo just outside it (0 under the line).
 *
 * The width is set in PIXELS (F.reference.z / .w) so the line reads the same from a street corner and from the
 * whole-basin view, with a floor of a third of a cell so a far view cannot make it vanish, and one pixel of feather
 * for anti-aliasing. The halo is what makes one line work over everything underneath it: dark floodwater, a bright
 * hazard band and a sunlit roof.
 */
fn refEdge(g: vec2f, pxCells: f32) -> vec2f {
  let d = abs(refDistance(g));
  let aa = max(pxCells, 1e-4);
  let half = max(F.reference.z * pxCells, 0.33);
  let outer = half + max(F.reference.w * pxCells, 0.3);
  let core = 1.0 - smoothstep(half, half + aa, d);
  let wide = 1.0 - smoothstep(outer, outer + aa, d);
  return vec2f(core, max(wide - core, 0.0));
}
`;
