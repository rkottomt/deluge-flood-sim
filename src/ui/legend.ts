/**
 * Legend copy for the hazard water modes. The bands themselves come straight from src/render/legend.ts (bandsForMode),
 * the single source of truth the renderer uploads to the GPU, so the UI legend always matches what's on screen.
 */
import type { WaterViewMode } from '../contracts';

export function legendTitle(mode: WaterViewMode, probabilityThreshold = 0.15): string {
  switch (mode) {
    case 'velocity':
      return 'Flow speed';
    case 'maxDepth':
      return 'Deepest water since reset — the flood extent';
    case 'depth':
      return 'Current water depth';
    case 'arrival':
      return 'When the water arrived — minutes after the start, deeper than 15 cm';
    case 'hazard':
      return 'Flood hazard since reset — depth × speed (AIDR 2017)';
    case 'probability':
      return `Share of ensemble members deeper than ${probabilityThreshold >= 0.5 ? '50' : '15'} cm — sensitivity to the input bands, not a forecast`;
    default:
      return '';
  }
}
