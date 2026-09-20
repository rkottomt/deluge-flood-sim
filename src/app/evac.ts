import type { EvacuationRouter, RoadStatusArray, RouteClosure, RouteResult, SimSnapshot, Store } from '../contracts';
import { APP_CONFIG } from './defaults';
import { errorMessage, type ErrorReporter } from './errors';

/**
 * Bridges solver snapshots to the evacuation router: recomputes per-edge road flood status and the
 * evacuation route at most every `routeIntervalMs`, and immediately when the start point or shelters
 * change. Publishes the route to the store only when it meaningfully changed.
 *
 * It also owns the one part of the evacuation story the router cannot see. The router is handed a single flood
 * field at a time, so it can say "there is no way out now" but never "the way out closed at this moment". This
 * controller watches the route across simulated time and, when a start that had a route loses its last one,
 * publishes the closure with it (RouteResult.closure): when that happened on the simulation clock, how long the
 * start had a way out, and what that last route was. Where the water arrives everywhere at once and no detour
 * exists — a flat coast — that moment is the whole warning-time story.
 */
export class EvacController {
  /** Latest per-edge status (may be the same array instance mutated by the router). */
  roadStatus: RoadStatusArray | null = null;
  /** Incremented whenever roadStatus was recomputed (so the renderer re-uploads even if the array is reused). */
  statusVersion = 0;

  private pending: SimSnapshot | null = null;
  private lastUpdate = -Infinity;

  // ── Last-safe-route tracking, per evacuation start ──
  /** Simulation clock of the last snapshot routed against, s. */
  private simTime = 0;
  /** The start and shelter list the tracking below belongs to (by identity: the store replaces them wholesale). */
  private trackedStart: { gx: number; gy: number } | null = null;
  private trackedShelters: unknown = null;
  /** The last route that reached a shelter, and the sim time it (or the one that replaced a closure) was planned. */
  private lastOk: { lengthMeters: number; etaSeconds: number; shelterName: string } | null = null;
  private openedAt = 0;
  /** Set when the last route closed; cleared as soon as a route exists again. */
  private closure: RouteClosure | null = null;

  constructor(
    private readonly router: EvacuationRouter,
    private readonly store: Store,
    private readonly errors: ErrorReporter,
  ) {}

  /** Forget flood state (scene change). */
  reset(): void {
    this.roadStatus = null;
    this.statusVersion++;
    this.pending = null;
    this.lastUpdate = -Infinity;
    this.simTime = 0;
    this.forget(null, null);
  }

  /**
   * A new snapshot arrived; it is processed now or on a later tick (rate limit). Readbacks from the stability demo's
   * naive solver, and any diverged readback (NaN / infinite depths), are ignored, so the road status and route keep
   * describing the last physical flood. Otherwise the blow-up's oscillating and NaN depths read as dry roads and the
   * route card announces "Re-planned — safe route" straight through the flood while the map shows magenta noise.
   * Restoring the robust solver resets the water, and the next readback updates everything again.
   */
  onSnapshot(snap: SimSnapshot, now: number): void {
    if (this.store.get().sim.stabilityMode === 'naive' || !snapshotIsPhysical(snap)) {
      this.pending = null;
      return;
    }
    this.pending = snap;
    this.tick(now);
  }

  tick(now: number): void {
    if (!this.pending || now - this.lastUpdate < APP_CONFIG.routeIntervalMs) return;
    const snap = this.pending;
    this.pending = null;
    this.lastUpdate = now;
    if (Number.isFinite(snap.simTime)) this.simTime = snap.simTime;
    // The water was reset (the clock went back): how long this start has had a route restarts with it.
    if (this.simTime < this.openedAt) this.openedAt = this.simTime;
    try {
      this.roadStatus = this.router.updateFlood(snap.depth, snap.nx, snap.ny);
      this.statusVersion++;
    } catch (err) {
      this.errors.report('routing', `updateFlood failed: ${errorMessage(err)}`, err);
      return;
    }
    this.recomputeRoute();
  }

  /** Re-plan with the latest flood status (call when start point or shelters change). */
  recomputeRoute(): void {
    const s = this.store.get();
    if (!s.evacStart) {
      this.forget(null, null);
      if (s.route !== null) this.store.set({ route: null });
      return;
    }
    // A moved pin or an edited shelter list is a new plan: the last-route moment of the previous one is not this one's.
    if (s.evacStart !== this.trackedStart || s.shelters !== this.trackedShelters) this.forget(s.evacStart, s.shelters);
    let next: RouteResult;
    try {
      next = this.router.route(s.evacStart, s.shelters);
    } catch (err) {
      this.errors.report('routing', `route failed: ${errorMessage(err)}`, err);
      return;
    }
    if (next.state === 'ok') {
      // The clock on "how long there was a way out" starts at the first route for this start, and restarts whenever a
      // route comes back after one closed (a levee, or the water falling): what the card claims is the stretch of
      // simulated time that ended with the closure, not one that has a cut in the middle of it.
      if (!this.lastOk || this.closure) this.openedAt = this.simTime;
      this.lastOk = { lengthMeters: next.lengthMeters, etaSeconds: next.etaSeconds, shelterName: next.shelter?.name ?? '' };
      this.closure = null;
    } else if (next.state === 'blocked' && this.lastOk && !this.closure) {
      this.closure = {
        simTime: this.simTime,
        openSeconds: Math.max(0, this.simTime - this.openedAt),
        lengthMeters: this.lastOk.lengthMeters,
        etaSeconds: this.lastOk.etaSeconds,
        shelterName: this.lastOk.shelterName,
      };
    }
    if (next.state === 'blocked' && this.closure) next = { ...next, closure: this.closure };
    // Copy the polyline so a router that reuses buffers can't mutate what the store/renderer hold.
    if (!sameRoute(s.route, next)) this.store.set({ route: { ...next, polyline: next.polyline?.slice() ?? null } });
  }

  /** Start tracking a (possibly null) start from scratch: no route seen yet, nothing closed. */
  private forget(start: { gx: number; gy: number } | null, shelters: unknown): void {
    this.trackedStart = start;
    this.trackedShelters = shelters;
    this.lastOk = null;
    this.closure = null;
    this.openedAt = this.simTime;
  }
}

/** False when the solver has blown up (non-finite totals or extrema), so its depth field means nothing. */
export function snapshotIsPhysical(snap: SimSnapshot): boolean {
  const { maxDepth, maxSpeed, volume } = snap.stats;
  return Number.isFinite(maxDepth) && Number.isFinite(maxSpeed) && Number.isFinite(volume) && volume >= 0;
}

/**
 * Routes are equal for display purposes if state, geometry size, length, ETA, shelter and message match — plus the
 * blocked numbers the card shows: the moment the last route closed, and the cut route's length and flooded length to
 * the nearest 100 m. Without those the card would freeze on the first blocked sentence (which never changes) while
 * the water kept rising; with them unrounded it would rebuild itself — and re-announce itself to a screen reader —
 * at every readback.
 */
function sameRoute(a: RouteResult | null, b: RouteResult): boolean {
  if (!a) return false;
  return (
    a.state === b.state &&
    a.message === b.message &&
    a.shelter?.name === b.shelter?.name &&
    Math.abs(a.lengthMeters - b.lengthMeters) < 0.5 &&
    Math.abs(a.etaSeconds - b.etaSeconds) < 0.5 &&
    a.closure?.simTime === b.closure?.simTime &&
    cutKey(a) === cutKey(b) &&
    samePolyline(a.polyline, b.polyline)
  );
}

/** The cut route's length and flooded length, bucketed to 100 m ('' when the result has no cut route). */
function cutKey(r: RouteResult): string {
  const cut = r.diagnosis?.cutRoute;
  return cut ? `${Math.round(cut.lengthMeters / 100)}:${Math.round(cut.floodedMeters / 100)}` : '';
}

function samePolyline(a: Float32Array | null, b: Float32Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
