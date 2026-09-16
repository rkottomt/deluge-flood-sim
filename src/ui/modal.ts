/**
 * Modal shell: blurred backdrop, dialog card with header/body/footer, focus management (focus the dialog
 * on open, trap Tab, restore focus on close). Open state is driven by the store (state.panels.*).
 */
import { h, type Child } from './dom';
import { icon, type IconName } from './icons';

export interface ModalOptions {
  id: string;
  title: string;
  subtitle?: Child;
  icon?: IconName;
  className?: string;
  body: Child[];
  footer?: HTMLElement;
  headerExtra?: HTMLElement;
  onRequestClose(): void;
}

export interface Modal {
  el: HTMLElement;
  dialog: HTMLElement;
  body: HTMLElement;
  isOpen(): boolean;
  setOpen(open: boolean): void;
  /** Called after the open transition starts (layout is valid). */
  onOpen(fn: () => void): void;
}

let seq = 0;

export function createModal(o: ModalOptions): Modal {
  const titleId = `dl-modal-title-${o.id}-${seq++}`;
  const body = h('div', { class: 'dl-modal-body' }, ...o.body);
  const dialog = h(
    'div',
    { class: `dl-modal ${o.className ?? ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' },
    h(
      'header',
      { class: 'dl-modal-head' },
      o.icon ? h('span', { class: 'dl-modal-icon' }, icon(o.icon, 20)) : null,
      h('div', { class: 'dl-modal-titles' }, h('h2', { class: 'dl-modal-title', id: titleId }, o.title), o.subtitle ? h('div', { class: 'dl-modal-sub' }, o.subtitle) : null),
      o.headerExtra ?? null,
      h('button', { type: 'button', class: 'dl-icon-btn dl-modal-close', 'aria-label': 'Close', 'data-tip': 'Close', 'data-tip-key': 'Esc', 'data-tip-side': 'bottom', onclick: () => o.onRequestClose() }, icon('close', 18)),
    ),
    body,
    o.footer ?? null,
  );
  const backdrop = h('div', { class: 'dl-modal-backdrop', onclick: () => o.onRequestClose() });
  const el = h('div', { class: 'dl-modal-layer', 'data-modal': o.id }, backdrop, dialog);
  el.inert = true;

  let open = false;
  let restoreFocus: HTMLElement | null = null;
  const openFns: Array<() => void> = [];

  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const focusables = Array.from(
      dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'),
    ).filter((x) => x.offsetParent !== null);
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  return {
    el,
    dialog,
    body,
    isOpen: () => open,
    setOpen(v: boolean) {
      if (v === open) return;
      open = v;
      el.inert = !v;
      el.classList.toggle('dl-open', v);
      if (v) {
        restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dialog.focus({ preventScroll: true });
        openFns.forEach((fn) => fn());
      } else if (restoreFocus && restoreFocus.isConnected && !restoreFocus.closest('.dl-modal-layer')) {
        restoreFocus.focus({ preventScroll: true });
        restoreFocus = null;
      }
    },
    onOpen(fn) {
      openFns.push(fn);
    },
  };
}
