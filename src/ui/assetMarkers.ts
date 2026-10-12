/**
 * Map pins for the Impact panel's assets (the user's portfolio and the top losses): small DOM dots projected from
 * grid coordinates through the renderer camera's matrices every frame while there are pins to show.
 *
 * The camera's `matrices()` is an implementation detail of the renderer's OrbitController (not in the contract), so
 * it is feature-detected; without it no pins are drawn and the tables still work. Pins are not occluded by terrain —
 * one behind a hill still shows — which is acceptable for a locator and cheaper than a depth test.
 */
import type { CameraController, TerrainData } from '../contracts';
import { transformPoint4 } from '../render/math';
import { h } from './dom';

export interface AssetPin {
  gx: number;
  gy: number;
  /** Tooltip / accessible name (plain text). */
  label: string;
  tone: 'portfolio' | 'top';
  onClick?: () => void;
}

/** Most pins drawn at once. */
export const MAX_PINS = 300;

type MatrixCamera = CameraController & { matrices(aspect: number): { viewProj: ArrayLike<number> } };

export function createAssetMarkers(deps: {
  getCamera(): CameraController | null;
  getTerrain(): TerrainData | null;
  getExaggeration(): number;
  getCanvas(): HTMLCanvasElement | null;
}): { el: HTMLElement; set(pins: AssetPin[]): void; setVisible(on: boolean): void; destroy(): void } {
  const el = h('div', { class: 'dl-asset-pins', 'aria-hidden': 'false' });
  let pins: AssetPin[] = [];
  let nodes: HTMLButtonElement[] = [];
  let visible = true;
  let raf = 0;

  const frame = () => {
    raf = 0;
    if (!visible || pins.length === 0) return;
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
      const X = (pin.gx - nx / 2) * cellSize;
      const Z = (pin.gy - ny / 2) * cellSize;
      const Y = (elevation[j * nx + i] + 2) * ex;
      const [cx, cy, , cw] = transformPoint4(vp, X, Y, Z, 1);
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
    set(next: AssetPin[]) {
      pins = next.slice(0, MAX_PINS);
      nodes = pins.map((pin) =>
        h('button', {
          type: 'button',
          class: `dl-asset-pin dl-pin-${pin.tone}`,
          title: pin.label,
          'aria-label': pin.label,
          onclick: () => pin.onClick?.(),
        }),
      );
      el.replaceChildren(...nodes);
      schedule();
    },
    setVisible(on: boolean) {
      visible = on;
      el.hidden = !on;
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
