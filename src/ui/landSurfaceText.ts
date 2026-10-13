/**
 * The Advanced panel's fine print under the land-surface switches (AppState.landSurface; src/app/landSurface.ts): what
 * this scene's data can do, and what each layer is not.
 */
import type { LandSurfaceStatus } from '../contracts';

const int = (n: number) => Math.round(n).toLocaleString('en-US');

export function landSurfaceText(ls: LandSurfaceStatus | null): string {
  if (!ls) return 'Load a scene to see which land-surface data it has.';
  const parts: string[] = [];
  if (ls.obstacleCells > 0 || ls.porousCells > 0) {
    parts.push(
      `Buildings: ${int(ls.buildings)} footprints fill ${int(ls.obstacleCells)} cells and partly cover ` +
        `${int(ls.porousCells)} more. A filled cell blocks the water (the impact numbers read the depth against its ` +
        'walls); a partly covered one stays passable through its open share, as gaps between houses do. Roof rain goes ' +
        'down the downspouts: into the storm drains when they are on, onto the ground beside the building when not.',
    );
  } else {
    parts.push('Buildings: no footprints in this scene, nothing to block.');
  }
  if (ls.landCover) {
    parts.push(`Roughness: ${ls.landCover}, n 0.02–0.13 by class; rivers keep 0.035.`);
  } else {
    parts.push('Roughness and drains: no land-cover data for this area, so roughness stays uniform and there are no drains.');
  }
  if (ls.drainCells > 0) {
    parts.push(
      `Drains: ${int(ls.drainCells)} developed cells, each removing its runoff coefficient × the 2-year 1-hour rain ` +
        `(${int(ls.designRainMmHr)} mm/hr, NOAA Atlas 14). A spread-out sink, not a pipe network: no inlets, no pipe ` +
        'limits, and it keeps draining when a flooded river would back the sewers up.',
    );
  } else if (ls.landCover) {
    parts.push('Drains: no drainage design data for this area, so no drains.');
  }
  return parts.join(' ');
}
