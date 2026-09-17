/**
 * Hand-drawn 24×24 stroke icons (currentColor). Kept as markup strings so they can be cloned cheaply.
 */
import { trustedMarkup } from './dom';

const WAVE = 'q1.5-1.7 3 0t3 0 3 0 3 0 3 0 3 0';

export const ICON_PATHS = {
  orbit:
    '<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/><path d="M19.6 8.6C21.1 9.5 22 10.7 22 12c0 2.9-4.5 5.2-10 5.2S2 14.9 2 12s4.5-5.2 10-5.2c1.4 0 2.8.2 4 .5"/><path d="M13.9 4.8l2.4 2.5-2.9 1.6"/><path d="M8.5 20.2c1 .8 2.2 1.3 3.5 1.3" opacity=".55"/><path d="M15.5 3.8c-1-.8-2.2-1.3-3.5-1.3" opacity=".55"/>',
  wall:
    '<rect x="2.8" y="5" width="18.4" height="14" rx="1.6"/><path d="M2.8 9.7h18.4M2.8 14.3h18.4M8.8 5v4.7M15.2 5v4.7M5.6 9.7v4.6M12 9.7v4.6M18.4 9.7v4.6M8.8 14.3V19M15.2 14.3V19"/>',
  eraseWall:
    '<path d="M8 20.5h12"/><path d="M4.1 14.2 13.3 5a2 2 0 0 1 2.8 0l3.4 3.4a2 2 0 0 1 0 2.8l-8.9 8.9a1.4 1.4 0 0 1-1 .4H7.1a1.4 1.4 0 0 1-1-.4l-2-2a1.4 1.4 0 0 1 0-1.9z"/><path d="m9 9.3 6.2 6.2"/>',
  inflow:
    `<path d="M12 2.8v8.4"/><path d="m8.4 7.8 3.6 3.6 3.6-3.6"/><path d="M3 16${WAVE}"/><path d="M3 20.2${WAVE}" opacity=".6"/>`,
  storm:
    '<path d="M7 14.6a4.1 4.1 0 0 1-.5-8.2 5.6 5.6 0 0 1 10.8 1.2 3.6 3.6 0 0 1 .2 7z"/><path d="m8.2 17.6-1.1 2.6M12.4 17.6l-1.1 2.6M16.6 17.6l-1.1 2.6"/>',
  water:
    '<path d="M12 2.9c3.6 4.3 6.2 7.7 6.2 11a6.2 6.2 0 0 1-12.4 0c0-3.3 2.6-6.7 6.2-11z"/><path d="M9 14.4a3.1 3.1 0 0 0 3 3.1" opacity=".7"/>',
  dig:
    '<path d="m13.6 10.4 6.6-6.6"/><path d="m18 2.2 3.8 3.8"/><path d="M10.2 8.2l5.6 5.6-3.9 3.9a3.2 3.2 0 0 1-4.5 0l-1.1-1.1a3.2 3.2 0 0 1 0-4.5z"/><path d="M5.2 18.8 2.6 21.4"/>',
  evac:
    '<path d="M3.3 11.3 12 4l8.7 7.3"/><path d="M5.6 9.6V20h12.8V9.6"/><path d="M10 20v-5.4h4V20"/>',
  shelter:
    '<path d="M12 2.9 19.6 6v5.6c0 4.6-3.2 8.4-7.6 9.6-4.4-1.2-7.6-5-7.6-9.6V6z"/><path d="m8.7 12.1 2.3 2.3 4.4-4.6"/>',
  probe:
    '<circle cx="12" cy="12" r="6.8"/><path d="M12 2v4.2M12 17.8V22M2 12h4.2M17.8 12H22"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.2v13.6a.9.9 0 0 0 1.4.8l10.6-6.8a.9.9 0 0 0 0-1.6L9.4 4.4A.9.9 0 0 0 8 5.2z" fill="currentColor" stroke="none"/>',
  pause:
    '<rect x="6.2" y="4.8" width="4.2" height="14.4" rx="1.1" fill="currentColor" stroke="none"/><rect x="13.6" y="4.8" width="4.2" height="14.4" rx="1.1" fill="currentColor" stroke="none"/>',
  reset: '<path d="M3.8 12a8.2 8.2 0 1 0 2.4-5.8"/><path d="M3.6 3.4v4.5h4.5"/>',
  help: '<circle cx="12" cy="12" r="9.2"/><path d="M9.2 9.3a2.9 2.9 0 0 1 5.6 1c0 2-2.8 2.4-2.8 4.3"/><circle cx="12" cy="17.6" r=".95" fill="currentColor" stroke="none"/>',
  book: '<path d="M12 6.5C10.2 5 7.6 4.4 3.5 4.6v14c4.1-.2 6.7.4 8.5 1.9 1.8-1.5 4.4-2.1 8.5-1.9v-14c-4.1-.2-6.7.4-8.5 1.9z"/><path d="M12 6.5v14"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.2"/><path d="M14.5 4v16"/><path d="M17 8h1.5M17 11h1.5" opacity=".7"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m15.8 15.8 4.8 4.8"/>',
  pin: '<path d="M12 21.2s-6.8-6.1-6.8-11.3a6.8 6.8 0 0 1 13.6 0c0 5.2-6.8 11.3-6.8 11.3z"/><circle cx="12" cy="9.9" r="2.4"/>',
  globe:
    '<circle cx="12" cy="12" r="9.2"/><path d="M2.8 12h18.4"/><path d="M12 2.8c2.5 2.6 3.8 5.7 3.8 9.2s-1.3 6.6-3.8 9.2c-2.5-2.6-3.8-5.7-3.8-9.2S9.5 5.4 12 2.8z"/>',
  frame:
    '<path d="M3.5 8.5V5.2a1.7 1.7 0 0 1 1.7-1.7h3.3M15.5 3.5h3.3a1.7 1.7 0 0 1 1.7 1.7v3.3M20.5 15.5v3.3a1.7 1.7 0 0 1-1.7 1.7h-3.3M8.5 20.5H5.2a1.7 1.7 0 0 1-1.7-1.7v-3.3"/><path d="m6.8 16.4 3.4-4.6 2.4 3 1.6-2 3 3.6"/>',
  topDown:
    '<path d="M4 15.5 12 20l8-4.5L12 11z"/><path d="M12 2.8v5.6"/><path d="m9.4 5.9 2.6 2.6 2.6-2.6"/>',
  warning:
    '<path d="M10.3 4.1 2.6 17.6a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0z"/><path d="M12 9.4v4.8"/><circle cx="12" cy="17.2" r=".95" fill="currentColor" stroke="none"/>',
  check: '<circle cx="12" cy="12" r="9.2"/><path d="m7.9 12.3 2.8 2.8 5.5-5.6"/>',
  route:
    '<circle cx="6" cy="18.2" r="2.4"/><circle cx="18" cy="5.8" r="2.4"/><path d="M8.4 18.2h6.9a3.1 3.1 0 0 0 0-6.2H8.7a3.1 3.1 0 0 1 0-6.2h6.9"/>',
  bolt: '<path d="M13.2 2.6 4.6 13.4h6.6l-1 8 8.6-10.8h-6.6z"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="1.8"/><rect x="9.5" y="9.5" width="5" height="5" rx=".6"/><path d="M9.5 2.6V6M14.5 2.6V6M9.5 18v3.4M14.5 18v3.4M2.6 9.5H6M2.6 14.5H6M18 9.5h3.4M18 14.5h3.4"/>',
  rain: '<path d="M7 13.6a4.1 4.1 0 0 1-.5-8.2 5.6 5.6 0 0 1 10.8 1.2 3.6 3.6 0 0 1 .2 7z"/><path d="M8.5 16.5v2M12 17.5v3M15.5 16.5v2"/>',
  gauge: `<path d="M5.5 3v18"/><path d="M5.5 5.5h3M5.5 9.5h2M5.5 13.5h3M5.5 17.5h2"/><path d="M10.5 13.4q1.4-1.6 2.8 0t2.8 0 2.8 0"/><path d="M10.5 17.4q1.4-1.6 2.8 0t2.8 0 2.8 0" opacity=".6"/>`,
  layers: '<path d="m12 3.2 9 4.9-9 4.9-9-4.9z"/><path d="m3 12.4 9 4.9 9-4.9"/><path d="m3 16.4 9 4.9 9-4.9" opacity=".55"/>',
  sliders:
    '<path d="M4 6.5h9M17.8 6.5H20M4 12h2.5M11 12h9M4 17.5h11M19.5 17.5H20"/><circle cx="15.4" cy="6.5" r="2.2"/><circle cx="8.8" cy="12" r="2.2"/><circle cx="17.4" cy="17.5" r="2.2"/>',
  flag: '<path d="M5.2 21V3.8"/><path d="M5.2 4.6c3.8-2 7 1.9 10.9 0 1-.5 2-.6 2.9-.3v9.4c-.9-.3-1.9-.2-2.9.3-3.9 1.9-7.1-2-10.9 0"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  trash: '<path d="M4.5 6.5h15M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7M6.5 6.5l.8 12.6a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12.6"/>',
  keyboard:
    '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 9.5h.01M9.3 9.5h.01M12.6 9.5h.01M15.9 9.5h.01M18 9.5h.01M6 12.5h.01M18 12.5h.01M9 15h6"/>',
  mouse: '<rect x="6" y="2.8" width="12" height="18.4" rx="6"/><path d="M12 6.5v3.5"/>',
  clock: '<circle cx="12" cy="12" r="9.2"/><path d="M12 7v5.2l3.4 2"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  database: '<ellipse cx="12" cy="5.8" rx="7.5" ry="2.8"/><path d="M4.5 5.8v12.4c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V5.8"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  shield: '<path d="M12 2.9 19.6 6v5.6c0 4.6-3.2 8.4-7.6 9.6-4.4-1.2-7.6-5-7.6-9.6V6z"/>',
  gpu: '<rect x="2.5" y="6.5" width="19" height="11" rx="1.8"/><circle cx="9" cy="12" r="2.6"/><path d="M14.5 10h4M14.5 14h4M5 17.5v2M8 17.5v2M11 17.5v2"/>',
  arrowRight: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
  location: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3"/><circle cx="12" cy="12" r="7.2"/>',
} as const;

export type IconName = keyof typeof ICON_PATHS;

export function iconMarkup(name: IconName, size = 20, extraClass = ''): string {
  return `<svg class="dl-icon ${extraClass}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICON_PATHS[name]}</svg>`;
}

export function icon(name: IconName, size = 20, extraClass = ''): SVGSVGElement {
  return trustedMarkup<SVGSVGElement>(iconMarkup(name, size, extraClass));
}

let logoSeq = 0;
/** The Deluge wave mark: rounded square with a water gradient and two crisp wave crests. */
export function logoMark(size = 28): SVGSVGElement {
  const id = `dl-logo-grad-${logoSeq++}`;
  return trustedMarkup<SVGSVGElement>(`
    <svg class="dl-logo" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#5fd4ff"/>
          <stop offset=".55" stop-color="#2f8cff"/>
          <stop offset="1" stop-color="#1b4fd6"/>
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="9" fill="url(#${id})"/>
      <path d="M5 14.5c2.2 0 3.3-2.6 5.5-2.6s3.3 2.6 5.5 2.6 3.3-2.6 5.5-2.6 3.3 2.6 5.5 2.6" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M5 20.5c2.2 0 3.3-2.6 5.5-2.6s3.3 2.6 5.5 2.6 3.3-2.6 5.5-2.6 3.3 2.6 5.5 2.6" fill="none" stroke="#fff" stroke-opacity=".62" stroke-width="2.4" stroke-linecap="round"/>
      <path d="M9 7.5h14" stroke="#fff" stroke-opacity=".35" stroke-width="2" stroke-linecap="round"/>
    </svg>`);
}
