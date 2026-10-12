/**
 * Access loss: is the road in front of each building cut at the flood's peak?
 *
 * Reuses the evacuation router's per-edge flood status (src/routing): the router samples every road along its cells,
 * bridges spans over water that was there at reset (and their approaches), and calls an edge flooded at ≥ 0.3 m — the
 * depth at which trucks and cars stop (spec §C.5: impassable for trucks at 0.3 m). Here it is fed the MAXIMUM depth
 * field instead of the current one, so the answer is "was this road impassable at some point", not "is it now".
 *
 * Each building is tied to the nearest road within ACCESS_SNAP_M of its centroid. That is a proxy for "the building's
 * access road", not a route: a building whose own street stays dry can still be cut off further away, which the
 * evacuation route card shows for one start at a time. The time the road is under water comes from the wet-duration
 * accumulator and is capped by the simulated time, so it is a lower bound.
 */
import type { HazardFields, RoadNetwork } from '../contracts';
import { createRouter, ROAD_FLOODED_DEPTH } from '../routing';
import type { FootprintIndex } from './footprints';

/** Furthest a building may be from "its" road, m. */
export const ACCESS_SNAP_M = 120;

export const ACCESS_NO_ROAD = 0;
export const ACCESS_OPEN = 1;
export const ACCESS_CUT = 2;

export interface AccessResult {
  /** Per building: ACCESS_NO_ROAD / ACCESS_OPEN / ACCESS_CUT. */
  status: Uint8Array;
  /** Per building: simulated seconds its road had water ≥ 0.15 m on some cell (0 unless cut). Lower bound. */
  roadWetSeconds: Float32Array;
  /** Per building: index of the road edge used, −1 for none. */
  edge: Int32Array;
}

type Router = ReturnType<typeof createRouter>;
const routers = new WeakMap<RoadNetwork, { router: Router; cellSize: number; nx: number; ny: number }>();

function routerFor(net: RoadNetwork, cellSize: number, nx: number, ny: number): Router {
  const hit = routers.get(net);
  if (hit && hit.cellSize === cellSize && hit.nx === nx && hit.ny === ny) return hit.router;
  const router = createRouter();
  router.setNetwork(net, cellSize, { nx, ny });
  routers.set(net, { router, cellSize, nx, ny });
  return router;
}

/** Per-edge maximum depth over the run, through the router (bridges over standing water excluded). */
export function edgePeakDepths(net: RoadNetwork, fields: HazardFields, cellSize: number): Float32Array | null {
  const { nx, ny } = fields;
  const router = routerFor(net, cellSize, nx, ny);
  const baseline = new Float32Array(nx * ny);
  for (let c = 0; c < baseline.length; c++) if (fields.firstWet[c] === 0) baseline[c] = 1;
  router.setBaselineWater(baseline, nx, ny);
  router.updateFlood(fields.maxDepth, nx, ny);
  const d = router.getEdgeDepths();
  return d && d.length === net.edges.length ? d.slice() : null;
}

export function buildingAccess(net: RoadNetwork | null, fp: FootprintIndex, fields: HazardFields, cellSize: number): AccessResult {
  const n = fp.count;
  const out: AccessResult = { status: new Uint8Array(n), roadWetSeconds: new Float32Array(n), edge: new Int32Array(n).fill(-1) };
  if (!net || net.edges.length === 0) return out;
  const depths = edgePeakDepths(net, fields, cellSize);
  if (!depths) return out;
  const { nx, ny } = fields;

  // Spatial hash of road sample points (about one per cell along every polyline).
  const B = 8;
  const bw = Math.ceil(nx / B);
  const bh = Math.ceil(ny / B);
  const head = new Int32Array(bw * bh).fill(-1);
  const px: number[] = [];
  const py: number[] = [];
  const pe: number[] = [];
  const next: number[] = [];
  const add = (x: number, y: number, e: number) => {
    const bi = Math.floor(x / B);
    const bj = Math.floor(y / B);
    if (bi < 0 || bj < 0 || bi >= bw || bj >= bh) return;
    const b = bj * bw + bi;
    px.push(x);
    py.push(y);
    pe.push(e);
    next.push(head[b]);
    head[b] = px.length - 1;
  };
  const edgeWet = new Float32Array(net.edges.length);
  net.edges.forEach((edge, e) => {
    const pts = edge.pts;
    let wet = 0;
    for (let i = 0; i + 3 < pts.length; i += 2) {
      const x0 = pts[i];
      const y0 = pts[i + 1];
      const x1 = pts[i + 2];
      const y1 = pts[i + 3];
      const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
      for (let s = 0; s <= steps; s++) {
        const x = x0 + ((x1 - x0) * s) / steps;
        const y = y0 + ((y1 - y0) * s) / steps;
        add(x, y, e);
        const ci = Math.floor(x);
        const cj = Math.floor(y);
        if (ci < 0 || cj < 0 || ci >= nx || cj >= ny) continue;
        const c = cj * nx + ci;
        if (fields.firstWet[c] > 0 && fields.maxDepth[c] >= ROAD_FLOODED_DEPTH && fields.wetSeconds[c] > wet) wet = fields.wetSeconds[c];
      }
    }
    edgeWet[e] = wet;
  });

  const r = ACCESS_SNAP_M / cellSize;
  const r2 = r * r;
  const span = Math.ceil(r / B);
  for (let k = 0; k < n; k++) {
    const x = fp.cx[k];
    const y = fp.cy[k];
    if (!Number.isFinite(x)) continue;
    const bi = Math.floor(x / B);
    const bj = Math.floor(y / B);
    let best = r2;
    let bestE = -1;
    for (let j = bj - span; j <= bj + span; j++) {
      if (j < 0 || j >= bh) continue;
      for (let i = bi - span; i <= bi + span; i++) {
        if (i < 0 || i >= bw) continue;
        for (let p = head[j * bw + i]; p !== -1; p = next[p]) {
          const d2 = (px[p] - x) ** 2 + (py[p] - y) ** 2;
          if (d2 < best) {
            best = d2;
            bestE = pe[p];
          }
        }
      }
    }
    if (bestE < 0) continue;
    out.edge[k] = bestE;
    const cut = depths[bestE] >= ROAD_FLOODED_DEPTH;
    out.status[k] = cut ? ACCESS_CUT : ACCESS_OPEN;
    if (cut) out.roadWetSeconds[k] = edgeWet[bestE];
  }
  return out;
}
