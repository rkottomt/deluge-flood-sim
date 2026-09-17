/**
 * Legend copy for the hazard water modes. The bands themselves come straight from src/render/legend.ts (bandsForMode),
 * the single source of truth the renderer uploads to the GPU, so the UI legend always matches what's on screen.
 */
import type { WaterViewMode } from '../contracts';

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
