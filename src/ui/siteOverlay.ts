/**
 * Map overlay for Site check: each candidate site as a labelled pin and, when it has one, its parcel outline; the
 * outline being lassoed with the site tool; and the egress route last assessed for the selected site. Projected from
 * grid coordinates through the camera every animation frame while there is something to draw (like assetMarkers.ts:
 * not occluded by terrain, fine for a locator).
 *
 * Built with createElementNS + setAttribute + textContent only (no markup parsing; tests/ui/sinks.test.ts).
 */
import type { CameraController, TerrainData } from '../contracts';
import { geoToGrid } from '../data/geo';
import { transformPoint4 } from '../render/math';
import { h } from './dom';
import type { SiteRegistry } from './sites';

const SVG = 'http://www.w3.org/2000/svg';
type MatrixCamera = CameraController & { matrices(aspect: number): { viewProj: ArrayLike<number> } };

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

export interface SiteOverlay {
  el: HTMLElement;
  /** Egress route to draw (grid polyline) and whether it is still open; null clears it. */
  setRoute(route: Float32Array | null, open: boolean): void;
  /** Walking route of the selected site's occupants (grid polyline; evacPeople.ts); null clears it. */
  setWalkRoute(route: Float32Array | null, cut?: boolean): void;
  setVisible(on: boolean): void;
  /** Re-read the registry (sites changed). */
  refresh(): void;
  destroy(): void;
}

export function createSiteOverlay(deps: {
  registry: SiteRegistry;
  getCamera(): CameraController | null;
  getTerrain(): TerrainData | null;
  getExaggeration(): number;
  getCanvas(): HTMLCanvasElement | null;
  onSelect(id: string): void;
}): SiteOverlay {
  const root = svg('svg', { class: 'dl-site-svg', width: '100%', height: '100%' });
  const el = h('div', { class: 'dl-site-layer', 'aria-hidden': 'true' });
  el.append(root);
  const gRoute = svg('g');
  const gSites = svg('g');
  const gDraft = svg('g');
  root.append(gRoute, gSites, gDraft);
  let route: Float32Array | null = null;
  let routeOpen = true;
  let walkRoute: Float32Array | null = null;
  let walkCut = false;
  let visible = true;
  let raf = 0;

  interface Shape {
    id: string;
    pts: number[];
    poly: SVGPolygonElement | null;
    pin: SVGGElement;
  }
  let shapes: Shape[] = [];
  const routeLine = svg('polyline', { class: 'dl-site-route' });
  const walkLine = svg('polyline', { class: 'dl-site-walk', 'data-site': 'walk-route' });
  const walkEnd = svg('circle', { class: 'dl-site-walk-end', r: 5 });
  gRoute.append(routeLine, walkLine, walkEnd);
  const draftLine = svg('polyline', { class: 'dl-site-draft' });
  gDraft.append(draftLine);

  const rebuild = () => {
    const t = deps.getTerrain();
    gSites.replaceChildren();
    shapes = [];
    if (!t) return;
    for (const s of deps.registry.sites) {
      const p = geoToGrid(t, s.lon, s.lat);
      const pts = [p.gx, p.gy];
      if (s.ring) for (let i = 0; i + 1 < s.ring.length; i += 2) {
        const q = geoToGrid(t, s.ring[i], s.ring[i + 1]);
        pts.push(q.gx, q.gy);
      }
      const selected = s.id === deps.registry.selectedId;
      const poly = s.ring ? svg('polygon', { class: `dl-site-parcel${selected ? ' dl-on' : ''}` }) : null;
      const pin = svg('g', { class: `dl-site-pin${selected ? ' dl-on' : ''}` });
      const dot = svg('circle', { r: selected ? 7 : 5.5 });
      const label = svg('text', { x: 10, y: 4 });
      label.textContent = s.name || s.id;
      const title = svg('title');
      title.textContent = s.name || s.id;
      pin.append(title, dot, label);
      pin.addEventListener('click', () => deps.onSelect(s.id));
      if (poly) gSites.append(poly);
      gSites.append(pin);
      shapes.push({ id: s.id, pts, poly, pin });
    }
    schedule();
  };

  const frame = () => {
    raf = 0;
    const draft = deps.registry.draft;
    if (!visible || (!shapes.length && !route && !draft && !walkRoute)) {
      el.hidden = true;
      return;
    }
    const cam = deps.getCamera() as MatrixCamera | null;
    const terrain = deps.getTerrain();
    const canvas = deps.getCanvas();
    if (!cam || typeof cam.matrices !== 'function' || !terrain || !canvas) {
      el.hidden = true;
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0)) return schedule();
    el.hidden = false;
    let vp: ArrayLike<number>;
    try {
      vp = cam.matrices(rect.width / rect.height).viewProj;
    } catch {
      return schedule();
    }
    const { nx, ny, cellSize, elevation } = terrain;
    const ex = deps.getExaggeration();
    const project = (gx: number, gy: number): [number, number] | null => {
      const i = Math.min(nx - 1, Math.max(0, Math.floor(gx)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor(gy)));
      const [cx, cy, , cw] = transformPoint4(vp, (gx - nx / 2) * cellSize, (elevation[j * nx + i] + 1.5) * ex, (gy - ny / 2) * cellSize, 1);
      if (!(cw > 0)) return null;
      return [rect.left + ((cx / cw + 1) / 2) * rect.width, rect.top + ((1 - cy / cw) / 2) * rect.height];
    };
    const line = (pts: ArrayLike<number>, step = 1): string => {
      const out: string[] = [];
      for (let k = 0; k + 1 < pts.length; k += 2 * step) {
        const p = project(pts[k], pts[k + 1]);
        if (p) out.push(`${p[0].toFixed(1)},${p[1].toFixed(1)}`);
      }
      return out.join(' ');
    };
    for (const s of shapes) {
      const p = project(s.pts[0], s.pts[1]);
      if (p) {
        s.pin.setAttribute('transform', `translate(${p[0].toFixed(1)} ${p[1].toFixed(1)})`);
        s.pin.style.display = '';
      } else s.pin.style.display = 'none';
      if (s.poly) s.poly.setAttribute('points', line(s.pts.slice(2)));
    }
    routeLine.setAttribute('points', route ? line(route, Math.max(1, Math.floor(route.length / 2 / 400))) : '');
    routeLine.setAttribute('class', `dl-site-route${routeOpen ? '' : ' dl-cut'}`);
    walkLine.setAttribute('class', `dl-site-walk${walkCut ? ' dl-cut' : ''}`);
    walkLine.setAttribute('points', walkRoute ? line(walkRoute, Math.max(1, Math.floor(walkRoute.length / 2 / 400))) : '');
    const we = walkRoute && walkRoute.length >= 2 ? project(walkRoute[walkRoute.length - 2], walkRoute[walkRoute.length - 1]) : null;
    walkEnd.setAttribute('transform', we ? `translate(${we[0].toFixed(1)} ${we[1].toFixed(1)})` : 'translate(-99 -99)');
    walkEnd.style.display = we ? '' : 'none';
    draftLine.setAttribute('points', draft ? line(draft, Math.max(1, Math.floor(draft.length / 2 / 300))) : '');
    schedule();
  };
  const schedule = () => {
    if (!raf && visible && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
  };

  const offSites = deps.registry.on(rebuild);
  const offDraft = deps.registry.onDraft(schedule);
  rebuild();

  return {
    el,
    setRoute(r, open) {
      route = r;
      routeOpen = open;
      schedule();
    },
    setWalkRoute(r, cut = false) {
      walkCut = cut;
      walkRoute = r;
      schedule();
    },
    setVisible(on) {
      visible = on;
      if (!on) el.hidden = true;
      schedule();
    },
    refresh: rebuild,
    destroy() {
      offSites();
      offDraft();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    },
  };
}
