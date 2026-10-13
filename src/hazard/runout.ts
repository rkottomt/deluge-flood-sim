/**
 * The avalanche's own runout before it becomes a flood (research spec §C.1/§C.3 branch 2, §G.9 third pass): a
 * Voellmy–Salm sliding block (Voellmy 1955; Salm 1993 — the friction law of RAMMS, Christen et al. 2010 [M]) from the
 * detachment down the avalanche path and on along the routed valley, until the flood the router would make is at
 * least as fast as the mass. Only then does the routing take over, with the direct-flow hydrograph injected there.
 *
 * WHY. The first calibration started every avalanche-born flood at the head of the profile as a water hydrograph.
 * But a rock–ice avalanche that has just fallen a kilometre or more is moving at 50–60 m/s when it reaches the
 * valley floor, and in a steep gorge it keeps that speed far longer than the water it melts would reach it: the
 * Chamoli 2021 seismic record times the mass at the Ronti Gad–Rishiganga confluence about 3 minutes after the release,
 * "~55 m/s from the source" (Tiwari et al. 2022, Sci. Rep. 12:3733 [V]), and ~8 Mm³ of it was left there (Shugar et
 * al. 2021 [V]). The water-routing front, starting at 0 m/s, cannot be there that early.
 *
 * Motion (per unit mass, along the slope; θ the local bed angle, h the flow height):
 *   v·dv/ds = g·(sinθ − μ·cosθ) − g·v²/(ξ·h)
 * integrated exactly over each reach of constant θ and h: v²(s + Δs) = a/b + (v² − a/b)·e^{−b·Δs},
 * a = 2g(sinθ − μ cosθ), b = 2g/(ξh). The Coulomb term μ stops the block where the bed is flatter than ~μ; the
 * turbulent term ξ bounds its speed on steep reaches at √(ξ·h·(sinθ − μ cosθ)).
 *
 * Flow height h [H]: the depth at which the valley section (the ChainFile's, at the node; the first section on the
 * avalanche path, whose own geometry is not in the file) passes the direct-flow PEAK discharge Qp at the block's
 * speed, A(h) = Qp / v — the moving front carries the debris flow's peak, consistent with the surge source
 * (mass.ts surgeHydrograph). No other flow height is published for any of these events.
 *
 * Handover: at the first profile node where the block is no faster than the normal-flow velocity of Qp under the
 * routing's own resistance law (Qp / A(h_n)). From there the router's flood front is the faster process. Stations
 * above the handover read the mass passing (its time, and Qp as the peak); the routed flood starts at the handover.
 *
 * Parameters are the friction pair (μ, ξ) of a published back-analysis — never fitted here — and the spec says which.
 */
import type { ChainFile, MassMovement, ResistanceLaw } from './types';
import { G } from './defaults';
import { normalDepth, prepareNetwork, resistanceTable, sectionArea } from './routing';

export interface VoellmyParams {
  /** Coulomb friction coefficient μ, –. */
  mu: number;
  /** Turbulent friction ξ, m/s². */
  xi: number;
}

export interface SlideRunout {
  /** Seconds from the detachment to the end of the avalanche path (the profile's start), and the speed there, m/s. */
  tPath: number;
  vPath: number;
  /** Chainage (m) and time (s after the detachment) of the handover to the routed flood, and the block's speed there. */
  sHand: number;
  tHand: number;
  vHand: number;
  /** The block's track along the profile up to the handover: chainage, time, speed. */
  track: Array<{ s: number; t: number; v: number }>;
  /** The block stopped (v → 0) before the router's flood speed caught up — the handover is then where it stopped. */
  stopped: boolean;
}

/** Path sub-step, m (the path is one uniform slope; the step only resolves the speed-dependent flow height). */
const PATH_STEP = 50;
/** Lower bound on the speed used for the flow height (A = Qp / v), m/s, and on the flow height, m. */
const V_FLOOR = 1;
const H_FLOOR = 0.5;

/** Depth at node i where the section's area reaches `area` (bisection on the monotone A(h)). */
function depthForArea(file: ChainFile, i: number, area: number): number {
  let lo = 0;
  let hi = 1;
  while (sectionArea(file, i, hi) < area && hi < 2000) hi *= 2;
  for (let k = 0; k < 50; k++) {
    const m = 0.5 * (lo + hi);
    if (sectionArea(file, i, m) < area) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
}

/** One reach of constant slope angle θ and flow height h: the speed after Δs from v, and the time taken. */
function reach(v: number, theta: number, h: number, ds: number, p: VoellmyParams): { v: number; dt: number; stopped: boolean } {
  const a = 2 * G * (Math.sin(theta) - p.mu * Math.cos(theta));
  const b = (2 * G) / (p.xi * Math.max(h, H_FLOOR));
  const vInf2 = a / b;
  const v2 = vInf2 + (v * v - vInf2) * Math.exp(-b * ds);
  if (v2 <= 0) {
    // Decelerating to rest inside the reach (a < 0): distance to stop from v² = (a/b)(1 − e^{bx}) … solved exactly.
    const x = Math.log(1 - (v * v) / vInf2) / b; // vInf2 < 0 here, so the argument is > 1
    return { v: 0, dt: v > 0 ? (2 * Math.min(x, ds)) / v : 0, stopped: true };
  }
  const vb = Math.sqrt(v2);
  return { v: vb, dt: (2 * ds) / Math.max(v + vb, 1e-9), stopped: false };
}

/**
 * Run the block from rest at the detachment: down the avalanche path (mass.fallHeight over mass.pathLength, one uniform
 * slope), then along the profile from chainage `s0` until the handover. `qp` is the direct-flow peak (m³/s); `law` the
 * routing's resistance law (undefined: the ChainFile's Manning n); `sMax` the last chainage the handover may lie at
 * (the domain entry: the 2-D inflow must be routed water).
 */
export function slideRunout(mass: MassMovement, file: ChainFile, p: VoellmyParams, qp: number, s0: number, sMax: number, law?: ResistanceLaw): SlideRunout {
  const net = prepareNetwork(file);
  const tab = resistanceTable(net, law);
  let i0 = 0;
  while (i0 < net.n - 1 && net.s[i0] < s0) i0++;
  const hAt = (i: number, v: number) => Math.max(H_FLOOR, depthForArea(file, i, qp / Math.max(v, V_FLOOR)));
  // 1. The path.
  let v = 0;
  let t = 0;
  const thP = Math.atan2(Math.max(0, mass.fallHeight), Math.max(1, mass.pathLength));
  const along = Math.hypot(mass.fallHeight, mass.pathLength);
  for (let x = 0; x < along - 1e-9; ) {
    const ds = Math.min(PATH_STEP, along - x);
    const r = reach(v, thP, hAt(i0, v), ds, p);
    t += r.dt;
    v = r.v;
    x += ds;
    if (r.stopped) break;
  }
  const tPath = t;
  const vPath = v;
  // 2. The profile, node to node, until the routed flood is the faster.
  const track: SlideRunout['track'] = [{ s: net.s[i0], t, v }];
  const uFlood = (i: number) => {
    const hn = normalDepth(net, i, qp, undefined, tab);
    return qp / Math.max(1e-6, sectionArea(file, i, hn));
  };
  let i = i0;
  let stopped = vPath <= 0;
  while (!stopped && i < net.n - 1 && net.s[i + 1] <= sMax && v > uFlood(i)) {
    const ds = net.s[i + 1] - net.s[i];
    const theta = Math.atan(Math.max(0, (net.zb[i] - net.zb[i + 1]) / ds));
    const r = reach(v, theta, hAt(i, v), ds / Math.cos(theta), p);
    t += r.dt;
    v = r.v;
    stopped = r.stopped;
    i++;
    track.push({ s: net.s[i], t, v });
  }
  return { tPath, vPath, sHand: net.s[i], tHand: t, vHand: v, track, stopped };
}

/** Time the block passed chainage s (linear in the track), or NaN beyond it. */
export function slideTimeAt(r: SlideRunout, s: number): number {
  const tr = r.track;
  if (s <= tr[0].s) return tr[0].t;
  for (let k = 1; k < tr.length; k++) {
    if (tr[k].s >= s) return tr[k - 1].t + ((tr[k].t - tr[k - 1].t) * (s - tr[k - 1].s)) / Math.max(1e-9, tr[k].s - tr[k - 1].s);
  }
  return NaN;
}
