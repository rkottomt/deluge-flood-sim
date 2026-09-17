import type { EvacuationRouter, RoadStatusArray, RouteResult, SimSnapshot, Store } from '../contracts';
import { APP_CONFIG } from './defaults';
import { errorMessage, type ErrorReporter } from './errors';

/**
 * Bridges solver snapshots to the evacuation router: recomputes per-edge road flood status and the
 * evacuation route at most every `routeIntervalMs`, and immediately when the start point or shelters
 * change. Publishes the route to the store only when it meaningfully changed.
 */
export class EvacController {
  /** Latest per-edge status (may be the same array instance mutated by the router). */
  roadStatus: RoadStatusArray | null = null;
  /** Incremented whenever roadStatus was recomputed (so the renderer re-uploads even if the array is reused). */
  statusVersion = 0;

  private pending: SimSnapshot | null = null;
  private lastUpdate = -Infinity;

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
      if (s.route !== null) this.store.set({ route: null });
      return;
    }
    let next: RouteResult;
    try {
      next = this.router.route(s.evacStart, s.shelters);
    } catch (err) {
      this.errors.report('routing', `route failed: ${errorMessage(err)}`, err);
      return;
    }
    // Copy the polyline so a router that reuses buffers can't mutate what the store/renderer hold.
    if (!sameRoute(s.route, next)) this.store.set({ route: { ...next, polyline: next.polyline?.slice() ?? null } });
  }
}

/** False when the solver has blown up (non-finite totals or extrema), so its depth field means nothing. */
export function snapshotIsPhysical(snap: SimSnapshot): boolean {
  const { maxDepth, maxSpeed, volume } = snap.stats;
  return Number.isFinite(maxDepth) && Number.isFinite(maxSpeed) && Number.isFinite(volume) && volume >= 0;
}

/** Routes are equal for display purposes if state, geometry size, length, ETA, shelter and message match. */
function sameRoute(a: RouteResult | null, b: RouteResult): boolean {
  if (!a) return false;
  return (
    a.state === b.state &&
    a.message === b.message &&
    a.shelter?.name === b.shelter?.name &&
    Math.abs(a.lengthMeters - b.lengthMeters) < 0.5 &&
    Math.abs(a.etaSeconds - b.etaSeconds) < 0.5 &&
    samePolyline(a.polyline, b.polyline)
  );
}

function samePolyline(a: Float32Array | null, b: Float32Array | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}
