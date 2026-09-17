/**
 * One-click evacuation demo: pick a sensible "home" to evacuate from (pure, unit-tested).
 *
 * A good demo start is a street that is dry now but will go under in the scenario's flood, close to where the
 * scenario's camera looks (so the route is on screen), and not next to a shelter (so there is a real drive).
 * Candidates are road nodes, so the router always has a street to snap to.
 */
import type { RoadNetwork, Shelter } from '../contracts';

export interface EvacSuggestInput {
  nx: number;
  ny: number;
  /** Bare ground elevation, row-major nx*ny, m. */
  ground: Float32Array;
  /** Current water depth, row-major nx*ny, m (null if unknown). */
  depth: Float32Array | null;
  roads: RoadNetwork;
  shelters: readonly Shelter[];
  /** Where the story is (scenario camera target), grid coords. */
  focus: { gx: number; gy: number };
  /** Water surface the scenario floods to (e.g. the record river crest), m; null when unknown. */
  floodLevel: number | null;
  /** Water surface right now (e.g. the current river stage), m; null when unknown. */
  currentLevel: number | null;
  /** Maximum number of candidates. */
  max?: number;
}

/** Cells to stay clear of the domain edge. */
const EDGE = 8;

/**
 * Candidate starts, best first. Tiers: (1) dry now, below the flood level and above the current level;
 * (2) dry, low-lying next to water; (3) any dry street. Within a tier, nearest to the focus wins, and picks are
 * spread out so a failed route doesn't make the next candidate fail the same way.
 */
export function suggestEvacStarts(i: EvacSuggestInput): Array<{ gx: number; gy: number }> {
  const { nx, ny, ground, depth, roads } = i;
  const max = i.max ?? 6;
  const nodeCount = roads.nodes.length / 2;
  if (!nodeCount || ground.length < nx * ny) return [];
  const scale = Math.max(nx, ny);
  const shelterClear = 0.06 * scale;
  const spacing = 0.03 * scale;

  // Nodes that touch at least one street a house could be on (not only highways).
  const streetNode = new Uint8Array(nodeCount);
  for (const e of roads.edges) {
    if (e.cls === 'highway') continue;
    if (e.a < nodeCount) streetNode[e.a] = 1;
    if (e.b < nodeCount) streetNode[e.b] = 1;
  }

  const sample = (gx: number, gy: number, arr: Float32Array) => {
    const x = Math.min(nx - 1, Math.max(0, Math.floor(gx)));
    const y = Math.min(ny - 1, Math.max(0, Math.floor(gy)));
    return arr[y * nx + x];
  };
  // 16 probes on two rings (2 % and 4 % of the domain), offsets computed once: this runs for thousands of street
  // nodes inside the "Evacuate" click.
  const probes = new Float64Array(32);
  for (let ring = 0; ring < 2; ring++) {
    const r = (ring + 1) * 0.02 * scale;
    for (let a = 0; a < 8; a++) {
      probes[(ring * 8 + a) * 2] = r * Math.cos((a * Math.PI) / 4);
      probes[(ring * 8 + a) * 2 + 1] = r * Math.sin((a * Math.PI) / 4);
    }
  }
  const wetNear = (gx: number, gy: number, water: Float32Array): number | null => {
    // Lowest water surface within ~4 % of the domain, or null if none is wet.
    let best = Infinity;
    for (let p = 0; p < 16; p++) {
      const x = gx + probes[2 * p];
      const y = gy + probes[2 * p + 1];
      if (!(x >= 0 && y >= 0 && x < nx && y < ny)) continue;
      const c = Math.floor(y) * nx + Math.floor(x);
      const d = water[c];
      if (d > 0.3) {
        const surf = ground[c] + d;
        if (surf < best) best = surf;
      }
    }
    return best < Infinity ? best : null;
  };

  type Cand = { gx: number; gy: number; tier: number; score: number };
  const cands: Cand[] = [];
  for (let k = 0; k < nodeCount; k++) {
    if (!streetNode[k]) continue;
    const gx = roads.nodes[2 * k];
    const gy = roads.nodes[2 * k + 1];
    if (!(gx > EDGE && gy > EDGE && gx < nx - EDGE && gy < ny - EDGE)) continue;
    if (depth && sample(gx, gy, depth) > 0.05) continue;
    let nearShelter = false;
    for (const s of i.shelters) {
      if ((s.gx - gx) * (s.gx - gx) + (s.gy - gy) * (s.gy - gy) < shelterClear * shelterClear) {
        nearShelter = true;
        break;
      }
    }
    if (nearShelter) continue;
    const g = sample(gx, gy, ground);
    if (!Number.isFinite(g)) continue;
    let tier = 3;
    if (i.floodLevel !== null && g < i.floodLevel - 0.3 && (i.currentLevel === null || g > i.currentLevel + 1)) tier = 1;
    else if (depth) {
      const surf = wetNear(gx, gy, depth);
      if (surf !== null && g > surf + 0.5 && g < surf + 6) tier = 2;
    }
    // Squared distance to the focus: same order, no Math.hypot per node.
    cands.push({ gx, gy, tier, score: (gx - i.focus.gx) * (gx - i.focus.gx) + (gy - i.focus.gy) * (gy - i.focus.gy) });
  }
  cands.sort((a, b) => a.tier - b.tier || a.score - b.score);

  const out: Array<{ gx: number; gy: number }> = [];
  for (const c of cands) {
    if (out.some((o) => (o.gx - c.gx) * (o.gx - c.gx) + (o.gy - c.gy) * (o.gy - c.gy) < spacing * spacing)) continue;
    out.push({ gx: c.gx, gy: c.gy });
    if (out.length >= max) break;
  }
  return out;
}
