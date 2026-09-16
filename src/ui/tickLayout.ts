/**
 * Slider tick-label layout (pure, no DOM — unit-tested in Node).
 */

/**
 * Collision-aware placement of slider tick labels.
 * Each label is centered under its tick if it fits; otherwise it is anchored to start at its tick, or the
 * previous label is re-anchored to end at its tick; only if that still collides does it drop to a second
 * row. Returns the label's left edge offset from the tick (px) and its row.
 */
export function layoutTickLabels(trackWidth: number, labels: Array<{ t: number; width: number }>): Array<{ dx: number; row: 0 | 1 }> {
  const GAP = 6;
  const EDGE = 8; // the tick strip is inset 8px (thumb radius); labels may use that margin
  const out: Array<{ dx: number; row: 0 | 1; l: number; r: number; c: number; w: number }> = [];
  const lastOnRow: Array<number> = [-1, -1];
  const span = (c: number, w: number, mode: 'c' | 's' | 'e') => {
    let l = mode === 'c' ? c - w / 2 : mode === 's' ? c - 3 : c - w + 3;
    l = Math.max(-EDGE, Math.min(trackWidth + EDGE - w, l));
    return { l, r: l + w };
  };
  labels.forEach((lab, i) => {
    const c = lab.t * trackWidth;
    const w = lab.width;
    const fits = (row: number, l: number) => lastOnRow[row] < 0 || l >= out[lastOnRow[row]].r + GAP;
    for (const row of [0, 1] as const) {
      for (const mode of ['c', 's'] as const) {
        const sp = span(c, w, mode);
        if (fits(row, sp.l)) {
          out.push({ dx: sp.l - c, row, l: sp.l, r: sp.r, c, w });
          lastOnRow[row] = i;
          return;
        }
      }
      // Re-anchor the previous label on this row to end at its tick, if that keeps it clear of its own predecessor.
      const p = lastOnRow[row];
      if (p >= 0) {
        const prev = out[p];
        const moved = span(prev.c, prev.w, 'e');
        const before = out.slice(0, p).filter((x) => x.row === row).pop();
        const cur = span(c, w, 's');
        if ((!before || moved.l >= before.r + GAP) && cur.l >= moved.r + GAP) {
          Object.assign(prev, { dx: moved.l - prev.c, l: moved.l, r: moved.r });
          out.push({ dx: cur.l - c, row, l: cur.l, r: cur.r, c, w });
          lastOnRow[row] = i;
          return;
        }
      }
    }
    const sp = span(c, w, 'c');
    out.push({ dx: sp.l - c, row: 1, l: sp.l, r: sp.r, c, w });
    lastOnRow[1] = i;
  });
  return out.map(({ dx, row }) => ({ dx, row }));
}
