import type { BuildingSet } from '../../src/contracts';

/** A BuildingSet of axis-aligned rectangles [x0, y0, x1, y1, height] in grid coordinates (cell i spans [i, i + 1)). */
export function rectBuildings(list: Array<[number, number, number, number, number]>): BuildingSet {
  const offsets = new Uint32Array(list.length + 1);
  const verts: number[] = [];
  list.forEach(([x0, y0, x1, y1], k) => {
    verts.push(x0, y0, x1, y0, x1, y1, x0, y1);
    offsets[k + 1] = offsets[k] + 4;
  });
  return {
    count: list.length,
    offsets,
    verts: Float32Array.from(verts),
    base: new Float32Array(list.length),
    height: Float32Array.from(list.map((r) => r[4])),
    heightSource: new Uint8Array(list.length),
    kind: new Uint8Array(list.length),
    names: [],
    heightRaster: null,
    attribution: '',
  };
}
