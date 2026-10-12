/**
 * A discharge time series Q(t), piecewise linear between its points and held flat before the first and after the last
 * — the same reading as the 2-D solver's `WaterSource.hydrograph` (src/sim/forcing.ts hydrographAt), so a series built
 * here means the same thing on both sides. Hydrographs built by this module start and end at Q = 0 where the flow
 * really stops.
 *
 * The routing integrates inflows over its own steps. `volume(a, b)` is exact for the piecewise-linear curve and costs
 * two binary searches, against a running integral precomputed at the points (forcing.ts's hydrographVolume walks the
 * whole table per call, fine once a frame, too slow ten thousand times per routing run).
 */
export class Series {
  readonly t: Float64Array;
  readonly q: Float64Array;
  /** ∫Q dt from t[0] to t[k], m³. */
  readonly cum: Float64Array;

  constructor(t: ArrayLike<number>, q: ArrayLike<number>) {
    const n = Math.min(t.length, q.length);
    if (n === 0) throw new Error('Series: no points');
    this.t = new Float64Array(n);
    this.q = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      if (!Number.isFinite(t[k]) || !Number.isFinite(q[k])) throw new Error(`Series: non-finite point ${k}`);
      if (k > 0 && t[k] < t[k - 1]) throw new Error('Series: times must ascend');
      this.t[k] = t[k];
      this.q[k] = Math.max(0, q[k]);
    }
    this.cum = new Float64Array(n);
    for (let k = 1; k < n; k++) this.cum[k] = this.cum[k - 1] + 0.5 * (this.q[k] + this.q[k - 1]) * (this.t[k] - this.t[k - 1]);
  }

  static fromPoints(points: ReadonlyArray<{ t: number; q: number }> | ReadonlyArray<readonly [number, number]>): Series {
    const t: number[] = [];
    const q: number[] = [];
    for (const p of points as ReadonlyArray<unknown>) {
      if (Array.isArray(p)) {
        t.push(p[0]);
        q.push(p[1]);
      } else {
        const o = p as { t: number; q: number };
        t.push(o.t);
        q.push(o.q);
      }
    }
    return new Series(t, q);
  }

  get start(): number {
    return this.t[0];
  }
  get end(): number {
    return this.t[this.t.length - 1];
  }
  /** ∫Q dt over the points' own span, m³. */
  get total(): number {
    return this.cum[this.cum.length - 1];
  }

  /** Index k of the last point with t[k] ≤ x (−1 before the first). */
  private seg(x: number): number {
    const t = this.t;
    if (x < t[0]) return -1;
    let lo = 0;
    let hi = t.length - 1;
    if (x >= t[hi]) return hi;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (t[mid] <= x) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  at(x: number): number {
    const k = this.seg(x);
    const n = this.t.length;
    if (k < 0) return this.q[0];
    if (k >= n - 1) return this.q[n - 1];
    const span = this.t[k + 1] - this.t[k];
    return span > 0 ? this.q[k] + ((this.q[k + 1] - this.q[k]) * (x - this.t[k])) / span : this.q[k + 1];
  }

  /** ∫Q dt from t[0] to x (negative before t[0], where Q is held at q[0]). */
  private integral(x: number): number {
    const k = this.seg(x);
    const n = this.t.length;
    if (k < 0) return this.q[0] * (x - this.t[0]);
    if (k >= n - 1) return this.cum[n - 1] + this.q[n - 1] * (x - this.t[n - 1]);
    const dt = x - this.t[k];
    return this.cum[k] + 0.5 * (this.q[k] + this.at(x)) * dt;
  }

  /** ∫Q dt over [a, b], m³ — exact for the piecewise-linear curve with its flat tails. */
  volume(a: number, b: number): number {
    if (!(b > a)) return 0;
    return this.integral(b) - this.integral(a);
  }

  /** Largest Q and its (first) time. */
  peak(): { q: number; t: number } {
    let k = 0;
    for (let i = 1; i < this.q.length; i++) if (this.q[i] > this.q[k]) k = i;
    return { q: this.q[k], t: this.t[k] };
  }

  /** A new series with every Q multiplied by f. */
  scaled(f: number): Series {
    return new Series(this.t, Array.from(this.q, (v) => v * f));
  }

  /** A new series shifted by dt seconds. */
  shifted(dt: number): Series {
    return new Series(Array.from(this.t, (v) => v + dt), this.q);
  }

  points(): Array<{ t: number; q: number }> {
    return Array.from(this.t, (t, k) => ({ t, q: this.q[k] }));
  }
}

/** The zero hydrograph (a trigger that did not produce a flood: the lake survived, the avalanche stopped short). */
export function zeroSeries(): Series {
  return new Series([0, 1], [0, 0]);
}

/**
 * Sum of several series on the union of their points (exact: a sum of piecewise-linear functions is piecewise linear
 * on the union of breakpoints).
 */
export function sumSeries(list: readonly Series[]): Series {
  if (list.length === 1) return list[0];
  const ts = new Set<number>();
  for (const s of list) for (const t of s.t) ts.add(t);
  const t = [...ts].sort((a, b) => a - b);
  return new Series(
    t,
    t.map((x) => list.reduce((acc, s) => acc + s.at(x), 0)),
  );
}
