/**
 * Legend bands for the hazard water modes. The renderer's src/render/legend.ts is the single source of
 * truth (it uploads the same colors to the GPU), so the UI legend always matches what's on screen.
 */
import type { WaterViewMode } from '../contracts';
import { bandsForMode, type HazardBand } from '../render/legend';

export type LegendBand = HazardBand;

export function legendBands(mode: WaterViewMode): LegendBand[] | null {
  return bandsForMode(mode);
}

export function legendTitle(mode: WaterViewMode): string {
  switch (mode) {
    case 'velocity':
      return 'Flow speed';
    case 'maxDepth':
      return 'Deepest water since reset — the flood extent';
    case 'depth':
      return 'Current water depth';
    default:
      return '';
  }
}
