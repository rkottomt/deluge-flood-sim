/**
 * Deterministic synthetic terrains for solver tests.
 */

/** Small, fast, seeded PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Rough random terrain: a few random low-frequency sinusoids (hills/valleys) plus value noise at two scales.
 * `amplitude` is the approximate peak-to-trough relief in meters. Returns Float32Array (row-major).
 */
export function roughTerrain(nx: number, ny: number, seed: number, amplitude = 20, base = 250): Float32Array {
  const rand = rng(seed);
  const z = new Float32Array(nx * ny);
  const waves = Array.from({ length: 6 }, () => ({
    kx: (rand() * 2 - 1) * 4 * Math.PI,
    ky: (rand() * 2 - 1) * 4 * Math.PI,
    ph: rand() * Math.PI * 2,
    a: 0.5 + rand(),
  }));
  // Coarse value-noise lattice (8-cell spacing) + white noise.
  const L = 8;
  const gw = Math.ceil(nx / L) + 2;
  const gh = Math.ceil(ny / L) + 2;
  const lattice = Float32Array.from({ length: gw * gh }, () => rand() * 2 - 1);
  let aSum = 0;
  for (const w of waves) aSum += w.a;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = i / nx;
      const y = j / ny;
      let s = 0;
      for (const w of waves) s += w.a * Math.sin(w.kx * x + w.ky * y + w.ph);
      s /= aSum; // −1..1
      const fx = i / L;
      const fy = j / L;
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fy);
      const tx = fx - i0;
      const ty = fy - j0;
      const sx = tx * tx * (3 - 2 * tx);
      const sy = ty * ty * (3 - 2 * ty);
      const l = (ii: number, jj: number) => lattice[jj * gw + ii];
      const vn =
        (l(i0, j0) * (1 - sx) + l(i0 + 1, j0) * sx) * (1 - sy) + (l(i0, j0 + 1) * (1 - sx) + l(i0 + 1, j0 + 1) * sx) * sy;
      const white = rand() * 2 - 1;
      z[j * nx + i] = base + amplitude * (0.5 * s + 0.35 * vn + 0.15 * white);
    }
  }
  return z;
}

/** Plane tilted downward toward +x (east): z = base + slope·dx·(nx − 1 − i). */
export function tiltedPlane(nx: number, ny: number, dx: number, slope: number, base = 100): Float32Array {
  const z = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) z[j * nx + i] = base + slope * dx * (nx - 1 - i);
  return z;
}

/** Initial depth for a lake at rest at `level` over `bed` (computed in float32 like the data module would). */
export function lakeAtRest(bed: Float32Array, level: number): Float32Array {
  const h = new Float32Array(bed.length);
  for (let i = 0; i < bed.length; i++) h[i] = Math.max(0, level - bed[i]);
  return h;
}
