/**
 * Map icons for the Infrastructure section: one small badge per facility (a letter for its type, coloured by its
 * status in the last assessed flood), projected from grid coordinates through the renderer camera every frame while
 * shown — the same approach as assetMarkers.ts (not occluded by terrain; fine for a locator). Text only, built with h().
 */
import type { CameraController, TerrainData } from '../contracts';
import { FACILITY_LABELS, type FacilityKind } from '../data/facilities';
import type { FacilityStatus } from '../loss/infra';
import { transformPoint4 } from '../render/math';
import { h } from './dom';

export interface InfraPin {
  gx: number;
  gy: number;
  kind: FacilityKind;
  status: FacilityStatus | 'unknown';
  label: string;
}

/** One- or two-letter glyph per type. */
export const KIND_GLYPH: Readonly<Record<FacilityKind, string>> = {
  substation: 'S',
  power_plant: 'P',
  hospital: 'H',
  clinic: 'C',
  fire_station: 'F',
  police: 'Po',
  water_works: 'W',
  wastewater_plant: 'WW',
  telecom: 'T',
  bridge: 'B',
  fuel: 'G',
};

export const MAX_INFRA_PINS = 400;
type MatrixCamera = CameraController & { matrices(aspect: number): { viewProj: ArrayLike<number> } };

export function createInfraOverlay(deps: {
  getCamera(): CameraController | null;
  getTerrain(): TerrainData | null;
  getExaggeration(): number;
  getCanvas(): HTMLCanvasElement | null;
}): { el: HTMLElement; set(pins: InfraPin[]): void; setVisible(on: boolean): void; destroy(): void } {
  const el = h('div', { class: 'dl-infra-pins', 'aria-hidden': 'true', 'data-infra': 'pins' });
  let pins: InfraPin[] = [];
  let nodes: HTMLElement[] = [];
  let visible = true;
  let raf = 0;

  const frame = () => {
    raf = 0;
    if (!visible || !pins.length) {
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
    for (let p = 0; p < pins.length; p++) {
      const pin = pins[p];
      const node = nodes[p];
      const i = Math.min(nx - 1, Math.max(0, Math.floor(pin.gx)));
      const j = Math.min(ny - 1, Math.max(0, Math.floor(pin.gy)));
      const [cx, cy, , cw] = transformPoint4(vp, (pin.gx - nx / 2) * cellSize, (elevation[j * nx + i] + 3) * ex, (pin.gy - ny / 2) * cellSize, 1);
      if (!(cw > 0)) {
        node.style.display = 'none';
        continue;
      }
      const sx = rect.left + ((cx / cw + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - cy / cw) / 2) * rect.height;
      if (sx < rect.left - 20 || sx > rect.right + 20 || sy < rect.top - 20 || sy > rect.bottom + 20) {
        node.style.display = 'none';
        continue;
      }
      node.style.display = '';
      node.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    }
    schedule();
  };
  const schedule = () => {
    if (!raf && visible && pins.length && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(frame);
  };

  return {
    el,
    set(next) {
      // Affected facilities on top (drawn last).
      const rank = (p: InfraPin) => (p.status === 'failed' ? 2 : p.status === 'impaired' ? 1 : 0);
      pins = [...next].sort((a, b) => rank(a) - rank(b)).slice(-MAX_INFRA_PINS);
      nodes = pins.map((p) =>
        h('span', { class: `dl-infra-pin dl-infra-${p.status}`, title: `${FACILITY_LABELS[p.kind]}: ${p.label}`, 'data-kind': p.kind }, KIND_GLYPH[p.kind]),
      );
      el.replaceChildren(...nodes);
      if (!pins.length) el.hidden = true;
      schedule();
    },
    setVisible(on) {
      visible = on;
      if (!on) el.hidden = true;
      schedule();
    },
    destroy() {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      pins = [];
      el.replaceChildren();
    },
  };
}
