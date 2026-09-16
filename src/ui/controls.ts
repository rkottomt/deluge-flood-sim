/**
 * Reusable controls: slider (linear/log, ticks, marks), segmented control, switch, two-step confirm
 * button, and a single shared tooltip layer.
 */
import { h, setText, toggleClass, setAttr, type Child } from './dom';
import { icon, type IconName } from './icons';
import { clamp } from './scales';
import { layoutTickLabels } from './tickLayout';

// ─── Slider ─────────────────────────────────────────────────────────────────────────────────────

export interface SliderMark {
  value: number;
  label: string;
  kind: 'warn' | 'danger' | 'info';
}

export interface SliderOptions {
  label: string;
  icon?: IconName;
  /** Value → position in [0, 1]. */
  toPos: (v: number) => number;
  /** Position in [0, 1] → value (may round). */
  fromPos: (t: number) => number;
  format: (v: number) => string;
  /** Optional secondary readout (e.g. unit conversion or category). */
  sub?: (v: number) => string;
  ticks?: Array<{ value: number; label: string }>;
  marks?: SliderMark[];
  onInput: (v: number) => void;
  /** Keyboard step as a fraction of the track (default 2%, Shift ×5). */
  keyStep?: number;
  tip?: string;
  compact?: boolean;
  className?: string;
}

export interface Slider {
  el: HTMLElement;
  input: HTMLInputElement;
  set(value: number): void;
  setDisabled(disabled: boolean): void;
  setSubClass(cls: string): void;
}

const RES = 1000;



export function slider(o: SliderOptions): Slider {
  const out = h('output', { class: 'dl-slider-value' });
  const sub = o.sub ? h('span', { class: 'dl-slider-sub' }) : null;
  const input = h('input', {
    type: 'range',
    class: 'dl-range',
    min: 0,
    max: RES,
    step: 1,
    'aria-label': o.label,
  });
  let dragging = false;
  let current = NaN;

  const setFill = (t: number) => input.style.setProperty('--t', t.toFixed(4));

  input.addEventListener('input', () => {
    const t = input.valueAsNumber / RES;
    setFill(t);
    o.onInput(o.fromPos(t));
  });
  input.addEventListener('pointerdown', () => {
    dragging = true;
    const up = () => {
      dragging = false;
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      // Snap the thumb to the (possibly rounded) committed value.
      if (Number.isFinite(current)) syncThumb(current);
    };
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
  });
  // Log-scale friendly keyboard steps.
  input.addEventListener('keydown', (e) => {
    const dir =
      e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0;
    let t: number | null = null;
    if (dir) t = clamp(input.valueAsNumber / RES + dir * (o.keyStep ?? 0.02) * (e.shiftKey ? 5 : 1), 0, 1);
    else if (e.key === 'Home') t = 0;
    else if (e.key === 'End') t = 1;
    else if (e.key === 'PageUp' || e.key === 'PageDown') t = clamp(input.valueAsNumber / RES + (e.key === 'PageUp' ? 0.1 : -0.1), 0, 1);
    if (t === null) return;
    e.preventDefault();
    e.stopPropagation();
    input.value = String(Math.round(t * RES));
    setFill(t);
    o.onInput(o.fromPos(t));
  });

  function syncThumb(v: number) {
    const t = clamp(o.toPos(v), 0, 1);
    const pos = Math.round(t * RES);
    if (Math.abs(pos - input.valueAsNumber) >= 1) input.value = String(pos);
    setFill(input.valueAsNumber / RES);
  }

  const trackWrap = h('div', { class: 'dl-slider-track' });
  if (o.marks?.length) {
    const marks = h('div', { class: 'dl-slider-marks', 'aria-hidden': 'true' });
    for (const m of o.marks) {
      const t = o.toPos(m.value);
      if (t < -0.001 || t > 1.001) continue;
      marks.append(
        h(
          'div',
          { class: `dl-mark dl-mark-${m.kind}`, style: { '--t': clamp(t, 0, 1).toFixed(4) } },
          h('span', { class: 'dl-mark-line' }),
        ),
      );
    }
    trackWrap.append(marks);
  }
  trackWrap.append(input);

  let ticks: HTMLElement | null = null;
  if (o.ticks?.length) {
    const container = h('div', { class: 'dl-slider-ticks', 'aria-hidden': 'true' });
    ticks = container;
    const items = o.ticks
      .map((tk) => ({ label: tk.label, t: clamp(o.toPos(tk.value), 0, 1) }))
      .sort((a, b) => a.t - b.t)
      .map((tk) => {
        const label = h('span', { class: 'dl-tick-label' }, tk.label);
        const el = h('div', { class: 'dl-tick', style: { '--t': tk.t.toFixed(4) } }, h('span', { class: 'dl-tick-dot' }), label);
        container.append(el);
        return { el, label, t: tk.t };
      });
    // Lay labels out against their real rendered widths (only when the track width changes).
    let lastWidth = -1;
    const ro = new ResizeObserver(() => {
      const w = container.clientWidth;
      if (w === lastWidth || w === 0) return;
      lastWidth = w;
      const placed = layoutTickLabels(
        w,
        items.map((it) => ({ t: it.t, width: it.label.offsetWidth })),
      );
      let alt = false;
      placed.forEach((p, i) => {
        items[i].label.style.transform = `translateX(${p.dx.toFixed(1)}px)`;
        toggleClass(items[i].el, 'dl-tick-alt', p.row === 1);
        alt ||= p.row === 1;
      });
      toggleClass(container, 'dl-ticks-staggered', alt);
    });
    ro.observe(container);
  }

  const head = h(
    'div',
    { class: 'dl-slider-head' },
    h('span', { class: 'dl-slider-label', 'data-tip': o.tip ?? null, 'data-tip-side': 'left' }, o.icon ? icon(o.icon, 15) : null, o.label),
    h('span', { class: 'dl-slider-readout' }, sub, out),
  );

  const el = h(
    'div',
    { class: `dl-slider${o.compact ? ' dl-slider-compact' : ''}${ticks ? ' dl-has-ticks' : ''}${o.className ? ' ' + o.className : ''}` },
    head,
    trackWrap,
    ticks,
  );

  return {
    el,
    input,
    set(v: number) {
      current = v;
      setText(out, o.format(v));
      if (sub && o.sub) setText(sub, o.sub(v));
      input.setAttribute('aria-valuetext', o.format(v));
      if (!dragging) syncThumb(v);
    },
    setDisabled(d: boolean) {
      input.disabled = d;
      toggleClass(el, 'dl-disabled', d);
    },
    setSubClass(cls: string) {
      if (sub && sub.dataset.sev !== cls) sub.dataset.sev = cls;
    },
  };
}

// ─── Segmented control ──────────────────────────────────────────────────────────────────────────

export interface SegmentOption<T extends string | number> {
  value: T;
  label: Child;
  tip?: string;
  key?: string;
}

export function segmented<T extends string | number>(
  options: SegmentOption<T>[],
  onSelect: (v: T) => void,
  opts: { label: string; className?: string; tipSide?: string } = { label: '' },
): { el: HTMLElement; set(v: T): void; buttons: Map<T, HTMLButtonElement> } {
  const buttons = new Map<T, HTMLButtonElement>();
  const el = h('div', { class: `dl-seg ${opts.className ?? ''}`, role: 'radiogroup', 'aria-label': opts.label });
  for (const o of options) {
    const b = h(
      'button',
      {
        type: 'button',
        class: 'dl-seg-btn',
        role: 'radio',
        'aria-checked': 'false',
        'data-tip': o.tip ?? null,
        'data-tip-key': o.key ?? null,
        'data-tip-side': opts.tipSide ?? 'bottom',
        onclick: () => onSelect(o.value),
      },
      o.label,
    );
    buttons.set(o.value, b);
    el.append(b);
  }
  return {
    el,
    buttons,
    set(v: T) {
      for (const [val, b] of buttons) {
        const on = val === v;
        setAttr(b, 'aria-checked', on ? 'true' : 'false');
        toggleClass(b, 'dl-on', on);
      }
    },
  };
}

// ─── Switch ─────────────────────────────────────────────────────────────────────────────────────

export function toggleSwitch(
  label: string,
  onChange: (on: boolean) => void,
  opts: { icon?: IconName; tip?: string } = {},
): { el: HTMLElement; set(on: boolean): void } {
  let state = false;
  const btn = h(
    'button',
    {
      type: 'button',
      class: 'dl-switch',
      role: 'switch',
      'aria-checked': 'false',
      'data-tip': opts.tip ?? null,
      'data-tip-side': 'left',
      onclick: () => onChange(!state),
    },
    opts.icon ? icon(opts.icon, 16) : null,
    h('span', { class: 'dl-switch-label' }, label),
    h('span', { class: 'dl-switch-track' }, h('span', { class: 'dl-switch-thumb' })),
  );
  return {
    el: btn,
    set(on: boolean) {
      state = on;
      setAttr(btn, 'aria-checked', on ? 'true' : 'false');
      toggleClass(btn, 'dl-on', on);
    },
  };
}

// ─── Buttons ────────────────────────────────────────────────────────────────────────────────────

export function button(
  label: Child,
  onClick: (e: MouseEvent) => void,
  opts: { icon?: IconName; variant?: 'primary' | 'ghost' | 'danger' | 'subtle' | 'ok'; tip?: string; key?: string; side?: string; className?: string; ariaLabel?: string } = {},
): HTMLButtonElement {
  return h(
    'button',
    {
      type: 'button',
      class: `dl-btn dl-btn-${opts.variant ?? 'subtle'} ${opts.className ?? ''}`,
      'data-tip': opts.tip ?? null,
      'data-tip-key': opts.key ?? null,
      'data-tip-side': opts.side ?? null,
      'aria-label': opts.ariaLabel ?? null,
      onclick: onClick,
    },
    opts.icon ? icon(opts.icon, 16) : null,
    label ? h('span', null, label) : null,
  );
}

/** Button that asks for a second click within 3 s before running a destructive action. */
export function confirmButton(
  label: string,
  confirmLabel: string,
  onConfirm: () => void,
  opts: { icon?: IconName; variant?: 'danger' | 'subtle'; tip?: string } = {},
): HTMLButtonElement {
  let armed = false;
  let timer = 0;
  const text = h('span', null, label);
  const b = h(
    'button',
    { type: 'button', class: `dl-btn dl-btn-${opts.variant ?? 'subtle'} dl-confirm`, 'data-tip': opts.tip ?? null, 'data-tip-side': 'top' },
    opts.icon ? icon(opts.icon, 16) : null,
    text,
  );
  const disarm = () => {
    armed = false;
    b.classList.remove('dl-armed');
    text.textContent = label;
  };
  b.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      b.classList.add('dl-armed');
      text.textContent = confirmLabel;
      clearTimeout(timer);
      timer = window.setTimeout(disarm, 3000);
      return;
    }
    clearTimeout(timer);
    disarm();
    onConfirm();
  });
  b.addEventListener('blur', () => {
    if (armed) {
      clearTimeout(timer);
      disarm();
    }
  });
  return b;
}

export function kbd(key: string): HTMLElement {
  return h('kbd', { class: 'dl-kbd' }, key);
}

// ─── Tooltips ───────────────────────────────────────────────────────────────────────────────────

/**
 * One tooltip element for the whole UI. Any element with data-tip (and optional data-tip-key,
 * data-tip-side = right|left|top|bottom) gets a tooltip on hover (after a short delay) and on keyboard
 * focus. Positioning uses a single layout read per show.
 */
export function installTooltips(root: HTMLElement): () => void {
  const tip = h('div', { class: 'dl-tooltip', role: 'tooltip', 'aria-hidden': 'true' });
  const text = h('span', { class: 'dl-tooltip-text' });
  const key = h('kbd', { class: 'dl-kbd dl-kbd-sm' });
  tip.append(text, key);
  root.append(tip);
  let target: HTMLElement | null = null;
  let timer = 0;

  const show = (el: HTMLElement) => {
    const label = el.dataset.tip;
    if (!label) return;
    setText(text, label);
    const k = el.dataset.tipKey;
    key.hidden = !k;
    if (k) setText(key, k);
    const side = el.dataset.tipSide ?? 'bottom';
    tip.dataset.side = side;
    tip.classList.add('dl-show');
    const r = el.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    const gap = 10;
    let x: number;
    let y: number;
    switch (side) {
      case 'right':
        x = r.right + gap;
        y = r.top + r.height / 2 - th / 2;
        break;
      case 'left':
        x = r.left - gap - tw;
        y = r.top + r.height / 2 - th / 2;
        break;
      case 'top':
        x = r.left + r.width / 2 - tw / 2;
        y = r.top - gap - th;
        break;
      default:
        x = r.left + r.width / 2 - tw / 2;
        y = r.bottom + gap;
    }
    x = clamp(x, 8, window.innerWidth - tw - 8);
    y = clamp(y, 8, window.innerHeight - th - 8);
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  const hide = () => {
    clearTimeout(timer);
    target = null;
    tip.classList.remove('dl-show');
  };

  const findTarget = (e: Event) => (e.target instanceof Element ? (e.target.closest('[data-tip]') as HTMLElement | null) : null);

  const onOver = (e: PointerEvent) => {
    const el = findTarget(e);
    if (el === target) return;
    hide();
    if (!el || !el.dataset.tip) return;
    target = el;
    timer = window.setTimeout(() => target === el && el.isConnected && show(el), 380);
  };
  const onOut = (e: PointerEvent) => {
    if (!target) return;
    const to = e.relatedTarget instanceof Element ? e.relatedTarget.closest('[data-tip]') : null;
    if (to !== target) hide();
  };
  const onFocus = (e: FocusEvent) => {
    const el = findTarget(e);
    if (el && el.matches(':focus-visible')) {
      target = el;
      show(el);
    }
  };
  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerout', onOut);
  root.addEventListener('focusin', onFocus);
  root.addEventListener('focusout', hide);
  root.addEventListener('pointerdown', hide);
  window.addEventListener('scroll', hide, true);
  return () => {
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerout', onOut);
    root.removeEventListener('focusin', onFocus);
    root.removeEventListener('focusout', hide);
    root.removeEventListener('pointerdown', hide);
    window.removeEventListener('scroll', hide, true);
    tip.remove();
  };
}
