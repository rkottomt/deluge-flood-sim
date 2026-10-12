/**
 * Synthetic valleys in the ChainFile (chain.json) format, for the hazard-chain tests and the calibration runs: a chain
 * of straight reaches, each with a constant bed slope and a trapezoidal section (bottom width b, side slopes m H:V),
 * tabulated exactly as a bake would tabulate a DEM transect.
 */
import type { ChainFile, ChainStation, ChainStructure } from '../../src/hazard/types';

export interface ValleyReach {
  /** Length along the river, m. */
  length: number;
  /** Bed drop over the reach, m (positive = downhill). */
  drop: number;
  /** Bottom width, m, and side slope, horizontal : vertical (0 = rectangular). */
  bottomWidth: number;
  sideSlope: number;
  /** Manning n (default 0.05). */
  n?: number;
}

export interface ValleyOptions {
  reaches: ValleyReach[];
  /** Node spacing, m (default 100). */
  dx?: number;
  /** Bed elevation at s = 0, m. */
  z0?: number;
  /** Depth range and step of the stage tables, m (default 0–40 m every 0.5 m). */
  tableDepth?: number;
  tableStep?: number;
  stations?: ChainStation[];
  structures?: ChainStructure[];
  /** Chainage of the 2-D domain entry (default: the last node). */
  entryS?: number;
  name?: string;
  clockZero?: string;
}

/** Exact trapezoid geometry at depth h. */
export function trapezoid(b: number, m: number, h: number): { area: number; width: number; perimeter: number } {
  return { area: (b + m * h) * h, width: b + 2 * m * h, perimeter: b + 2 * h * Math.sqrt(1 + m * m) };
}

export function syntheticValley(o: ValleyOptions): ChainFile {
  const dx = o.dx ?? 100;
  const tableDepth = o.tableDepth ?? 40;
  const tableStep = o.tableStep ?? 0.5;
  const s: number[] = [];
  const zBed: number[] = [];
  const n: number[] = [];
  const sections: ChainFile['sections'] = [];
  const lonlat: Array<[number, number]> = [];
  let s0 = 0;
  let z = o.z0 ?? 1000;
  const push = (si: number, zi: number, r: ValleyReach) => {
    s.push(si);
    zBed.push(zi);
    n.push(r.n ?? 0.05);
    const stage: number[] = [];
    const area: number[] = [];
    const width: number[] = [];
    const perimeter: number[] = [];
    for (let h = 0; h <= tableDepth + 1e-9; h += tableStep) {
      const g = trapezoid(r.bottomWidth, r.sideSlope, h);
      stage.push(zi + h);
      area.push(g.area);
      width.push(g.width);
      perimeter.push(g.perimeter);
    }
    sections.push({ stage, area, width, perimeter });
    lonlat.push([85 + si / 1e5, 28]);
  };
  for (let r = 0; r < o.reaches.length; r++) {
    const reach = o.reaches[r];
    const steps = Math.max(1, Math.round(reach.length / dx));
    for (let k = r === 0 ? 0 : 1; k <= steps; k++) push(s0 + (k * reach.length) / steps, z - (k * reach.drop) / steps, reach);
    s0 += reach.length;
    z -= reach.drop;
  }
  const last = s[s.length - 1];
  return {
    version: 1,
    name: o.name ?? 'synthetic valley',
    clockZero: o.clockZero,
    s,
    zBed,
    n,
    sections,
    lonlat,
    structures: o.structures ?? [],
    stations: o.stations ?? [],
    domainEntry: { s: o.entryS ?? last, gx: 10, gy: 10, radius: 4 },
    attribution: 'synthetic (tests)',
  };
}

/** A uniform prismatic channel: one reach. */
export function prismaticChannel(length: number, slope: number, bottomWidth: number, sideSlope = 0, n = 0.035, dx = 100): ChainFile {
  return syntheticValley({ reaches: [{ length, drop: length * slope, bottomWidth, sideSlope, n }], dx, z0: 100 + length * slope });
}
