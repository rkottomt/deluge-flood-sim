/**
 * Minimal DOM toolkit: hyperscript element creation + a selector-based binder that applies store
 * changes surgically (a DOM write happens only when the selected value actually changed).
 */
import type { AppActions, AppState, Store } from '../contracts';

export type Child = Node | string | number | null | undefined | false | Child[];

type Props = Record<string, unknown>;

/**
 * h('button', { class: 'x', onclick: fn, 'aria-label': 'Play', disabled: true }, child, …)
 *  • on<event> function props become listeners
 *  • boolean true → empty attribute, false/null/undefined → omitted
 *  • `style` may be a string or an object of CSS properties (custom properties allowed)
 *
 * There is deliberately no `html` prop. Everything that is not an element goes through textContent or a text node, so
 * no value from a URL, a response, a preset or the store can become markup. Constant markup (icons, the equation
 * typography) goes through `trustedMarkup` below, which says so in its name. FINDINGS.json SEC-08.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2), v as EventListener);
      } else if (k === 'class') {
        el.className = String(v);
      } else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v as Record<string, string>)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else (el.style as unknown as Record<string, string>)[sk] = sv;
        }
      } else if (k === 'text') {
        el.textContent = String(v);
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(parent, c);
    else if (c instanceof Node) parent.appendChild(c);
    else parent.appendChild(document.createTextNode(String(c)));
  }
}

/**
 * Parse CONSTANT markup into a single element. Never pass data from URLs, responses, presets or the store: this is an
 * innerHTML sink and the only one left in the toolkit. tests/ui/sinks.test.ts fails when a new sink appears anywhere
 * in src/, so a future call site has to be looked at in review.
 */
export function trustedMarkup<T extends Element = Element>(markup: string): T {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  return t.content.firstElementChild as T;
}

export function setText(el: Node, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function toggleClass(el: Element, cls: string, on: boolean): void {
  if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on);
}

export function setAttr(el: Element, name: string, value: string | null): void {
  if (value === null) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
  } else if (el.getAttribute(name) !== value) {
    el.setAttribute(name, value);
  }
}

// ─── Binder ─────────────────────────────────────────────────────────────────────────────────────

const UNSET = Symbol('unset');

interface Binding {
  select: (s: AppState) => unknown;
  apply: (v: unknown, s: AppState) => void;
  eq: (a: unknown, b: unknown) => boolean;
  last: unknown;
}

export class Binder {
  private list: Binding[] = [];

  /** Run `apply` now (on the next run) and whenever `select(state)` changes (by `eq`, default Object.is). */
  bind<T>(select: (s: AppState) => T, apply: (v: T, s: AppState) => void, eq: (a: T, b: T) => boolean = Object.is): void {
    this.list.push({
      select,
      apply: apply as (v: unknown, s: AppState) => void,
      eq: eq as (a: unknown, b: unknown) => boolean,
      last: UNSET,
    });
  }

  run(state: AppState): void {
    for (const b of this.list) {
      const v = b.select(state);
      if (b.last !== UNSET && b.eq(v, b.last)) continue;
      b.last = v;
      try {
        b.apply(v, state);
      } catch (err) {
        console.error('[ui] binding failed', err);
      }
    }
  }
}

/** Everything a UI component needs. */
export interface UIContext {
  store: Store;
  actions: AppActions;
  bind: Binder['bind'];
  /** Patch nested `sim` params. */
  setSim(patch: Partial<AppState['sim']>): void;
  /** Patch nested `render` settings. */
  setRender(patch: Partial<AppState['render']>): void;
  /** Open/close one of the modal panels. */
  setPanel(name: keyof AppState['panels'], open: boolean): void;
  /** Register cleanup to run when the UI is unmounted (listeners outside the store, e.g. on the UI bridge). */
  own(dispose: () => void): void;
}

/** Arrays compared element-wise by identity. */
export const shallowArrayEq = <T>(a: readonly T[], b: readonly T[]) =>
  a === b || (a.length === b.length && a.every((x, i) => Object.is(x, b[i])));

/** Guard for window-level shortcuts: true when the user is typing in a text field. */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    const type = t.type;
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color'].includes(type);
  }
  return false;
}

/**
 * Resolves once the next animation frame has been rendered (rAF, then a macrotask after it). Multi-step click handlers
 * await it between heavy steps so their work lands in separate frames instead of one long one. Without
 * requestAnimationFrame (tests) it resolves on the next macrotask.
 */
export function afterNextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0);
      return;
    }
    requestAnimationFrame(() => setTimeout(resolve, 0));
  });
}
